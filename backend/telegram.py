"""
telegram.py — v2.0
─────────────────────────────────────────────────────────────────────────────
NEW in v2.0:
  • /inv   → Full GST invoice creation via bot (all fields, multi-item loop)
  • /invlist → List your 10 most recent invoices with status
  • /invpdf <invoice_no>  → Get PDF of any invoice by number
  • /invemail <invoice_no> → Email invoice PDF to client
  • PDF is generated using the same _build_invoice_pdf engine as the web app
  • Email uses the same _send_email helper — no new infra needed

Existing flows preserved exactly:
  • /ts  → Create Task
  • /ld  → Create Lead  (admin / can_view_all_leads)
  • /qo  → Create Quotation + PDF
  • /mt  → My Tasks
  • /cl  → Cancel current action
  • /help → Help menu
  • Natural language → create/search tasks, leads, clients, invoices, quotations
  • Natural language reports → tasks, users, attendance, leads and date ranges
"""

import uuid
import os
import asyncio
import httpx
import json
import re

from datetime import datetime, timezone, date, timedelta
from fastapi import APIRouter, Request
from backend.dependencies import db
from backend.notifications import create_notification
from backend.lead_ai import process_lead_message

# ── Invoice helpers (shared with web app — no duplication) ────────────────────
from backend.invoicing import (
    _build_invoice_pdf,
    _compute_invoice_totals,
    _next_invoice_no,
    _send_email,
)

router = APIRouter(prefix="/telegram", tags=["Telegram"])

TELEGRAM_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
if not TELEGRAM_TOKEN:
    print("[WARNING] TELEGRAM_BOT_TOKEN not configured. Telegram bot integration will be disabled.")
    TELEGRAM_TOKEN = "dummy_token"

TELEGRAM_API    = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
BACKEND_URL     = os.getenv("BACKEND_URL", "http://localhost:8000")
DEFAULT_COMPANY_ID = os.getenv("DEFAULT_COMPANY_ID", "")


# ═══════════════════════════════════════════════════════════
# CONSTANTS
# ═══════════════════════════════════════════════════════════

DEPARTMENTS = [
    {"value": "gst",          "label": "GST"},
    {"value": "income_tax",   "label": "IT"},
    {"value": "accounts",     "label": "ACC"},
    {"value": "tds",          "label": "TDS"},
    {"value": "roc",          "label": "ROC"},
    {"value": "other",        "label": "OTHER"},
    {"value": "dsc",          "label": "DSC"},
    {"value": "fema",         "label": "FEMA"},
    {"value": "msme_smadhan", "label": "MSME"},
    {"value": "trademark",    "label": "TM"},
]

# ── Invoice-specific constants ────────────────────────────
INV_TYPES_TG = [
    {"value": "tax_invoice",  "label": "Tax Invoice"},
    {"value": "proforma",     "label": "Proforma"},
    {"value": "estimate",     "label": "Estimate"},
    {"value": "credit_note",  "label": "Credit Note"},
]

PAY_TERMS_TG = [
    "Due on receipt",
    "Due in 7 days",
    "Due in 15 days",
    "Due in 30 days",
    "Due in 45 days",
    "Due in 60 days",
    "Advance payment",
]

UNITS_TG     = ["service", "nos", "kg", "ltr", "hr", "day", "pcs", "month", "lot"]
GST_RATES_TG = [0, 5, 12, 18, 28]


# ═══════════════════════════════════════════════════════════
# UTILITIES
# ═══════════════════════════════════════════════════════════

async def send_message(chat_id: int, text: str, keyboard=None):
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "Markdown"}
    if keyboard:
        payload["reply_markup"] = keyboard
    async with httpx.AsyncClient() as client:
        await client.post(f"{TELEGRAM_API}/sendMessage", json=payload)


async def send_document(chat_id: int, file_bytes: bytes, filename: str = "invoice.pdf"):
    async with httpx.AsyncClient() as client:
        await client.post(
            f"{TELEGRAM_API}/sendDocument",
            data={"chat_id": chat_id},
            files={"document": (filename, file_bytes, "application/pdf")},
        )


def inline_keyboard(buttons, include_cancel: bool = True):
    """Build a Telegram inline keyboard from a list of {text, callback} dicts."""
    rows = [[{"text": b["text"], "callback_data": b["callback"]}] for b in buttons]
    if include_cancel:
        rows.append([{"text": "❌ Cancel", "callback_data": "cancel_convo"}])
    return {"inline_keyboard": rows}


def _safe_float(val, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _fmt_inr(amount) -> str:
    """Format a number as ₹ with commas."""
    try:
        return f"₹{float(amount):,.2f}"
    except Exception:
        return f"₹{amount}"


def _today() -> str:
    return date.today().isoformat()


def _today_plus(days: int) -> str:
    return (date.today() + timedelta(days=days)).isoformat()


# ═══════════════════════════════════════════════════════════════════════════════
# HUMAN-LANGUAGE TELEGRAM RESPONSES
#
# Telegram is a conversation channel, not a database/log viewer.  Keep factual
# values exact, but phrase activity messages naturally and only show fields that
# actually exist.  These helpers are deliberately deterministic: they improve
# tone without allowing an LLM to invent business data.
# ═══════════════════════════════════════════════════════════════════════════════

def _tg_name(value, fallback="there"):
    value = _tg_clean(value)
    if not value:
        return fallback
    return str(value).strip()


def _tg_join(values):
    if not values:
        return None
    if isinstance(values, str):
        values = [values]
    cleaned = [str(v).strip() for v in values if _tg_clean(v)]
    return ", ".join(cleaned) if cleaned else None


def _tg_human_task_created(task, assignee=None):
    title = _tg_name(task.get("title"), "your task")
    lines = [f"📋 *Done — I created the task.*", "", f"📝 *{title}*"]
    if assignee:
        lines.append(f"👤 I've assigned it to *{_tg_name(assignee.get('full_name'), assignee.get('email', 'the team'))}*.")
    if _tg_clean(task.get("due_date")):
        lines.append(f"📅 Due: *{task['due_date']}*")
    if _tg_clean(task.get("priority")):
        lines.append(f"⚡ Priority: *{task['priority']}*")
    return "\n".join(lines)


def _tg_human_lead_created(lead):
    company = _tg_name(lead.get("company_name") or lead.get("contact_name"), "the lead")
    lines = [f"👤 *Got it — I added {company} as a new lead.*"]
    services = _tg_join(lead.get("services"))
    if services:
        lines.append(f"📂 Looking for: *{services}*")
    if _tg_clean(lead.get("contact_name")):
        lines.append(f"👤 Contact: {_tg_name(lead.get('contact_name'))}")
    if _tg_clean(lead.get("phone")):
        lines.append(f"📞 Phone: {lead['phone']}")
    if _tg_clean(lead.get("email")):
        lines.append(f"✉️ Email: {lead['email']}")
    return "\n".join(lines)


def _tg_human_client_created(client):
    company = _tg_name(client.get("company_name"), "the client")
    lines = [f"🏢 *Done — {company} is now added as a client.*"]
    if _tg_clean(client.get("phone")):
        lines.append(f"📞 Phone: {client['phone']}")
    if _tg_clean(client.get("email")):
        lines.append(f"✉️ Email: {client['email']}")
    if _tg_clean(client.get("gstin")):
        lines.append(f"🏷 GSTIN: {client['gstin']}")
    return "\n".join(lines)


def _tg_human_invoice_pdf(inv):
    invoice_no = _tg_name(inv.get("invoice_no"), "the invoice")
    client = _tg_name(inv.get("client_name"), "the client")
    total = _fmt_inr(inv.get("grand_total", 0))
    return (
        f"🧾 *Here you go — {invoice_no}*\n\n"
        f"👤 Client: *{client}*\n"
        f"💰 Total: *{total}*\n"
        f"📄 I've attached the invoice PDF above."
    )


def _tg_human_invoice_created(inv, pdf_sent=True):
    invoice_no = _tg_name(inv.get("invoice_no"), "the invoice")
    client = _tg_name(inv.get("client_name"), "the client")
    total = _fmt_inr(inv.get("grand_total", 0))
    lines = [
        "🧾 *Done — the invoice is ready.*",
        "",
        f"📄 Invoice: `{invoice_no}`",
        f"👤 Client: *{client}*",
        f"💰 Total: *{total}*",
    ]
    if _tg_clean(inv.get("due_date")):
        lines.append(f"📅 Due: *{inv['due_date']}*")
    if pdf_sent:
        lines.append("\n📎 I've sent the PDF here as well.")
    lines.append(f"\nIf you want to email it, say *“email {invoice_no} to the client”*.")
    return "\n".join(lines)


def _tg_human_no_results(kind, qualifier=None):
    kind = str(kind).strip().lower()
    qualifier = f" for *{qualifier}*" if _tg_clean(qualifier) else ""
    wording = {
        "tasks": "I couldn't find any tasks",
        "leads": "I couldn't find any leads",
        "clients": "I couldn't find any clients",
        "invoices": "I couldn't find any invoices",
        "quotations": "I couldn't find any quotations",
        "attendance": "I couldn't find any attendance records",
    }.get(kind, f"I couldn't find any matching {kind}")
    return f"🔎 {wording}{qualifier}."


def _tg_human_error(action="request"):
    return f"⚠️ I couldn't complete that {action} right now. Please try again."


# ── Build a human-readable invoice summary for the confirm step ───────────────
def _build_invoice_summary(data: dict) -> str:
    inv_type_label = next(
        (t["label"] for t in INV_TYPES_TG if t["value"] == data.get("invoice_type", "tax_invoice")),
        "Tax Invoice"
    )

    # Items block
    items_lines = []
    for i, it in enumerate(data.get("items", []), 1):
        total_amt = _safe_float(it.get("total_amount") or it.get("unit_price", 0) * it.get("quantity", 1))
        disc_str  = f" | Disc {it.get('discount_pct', 0)}%" if it.get("discount_pct") else ""
        hsn_str   = f" | HSN: {it['hsn_sac']}" if it.get("hsn_sac") else ""
        items_lines.append(
            f"  {i}. {it.get('description','—')}\n"
            f"     {it.get('quantity',1)} {it.get('unit','service')} × {_fmt_inr(it.get('unit_price',0))}"
            f"{disc_str} | GST {it.get('gst_rate',18)}%{hsn_str}\n"
            f"     *Total: {_fmt_inr(total_amt)}*"
        )

    # Totals
    is_inter   = data.get("is_interstate", False)
    disc_extra = _safe_float(data.get("discount_amount"))
    shipping   = _safe_float(data.get("shipping_charges"))
    other      = _safe_float(data.get("other_charges"))

    taxable   = _safe_float(data.get("total_taxable"))
    total_gst = _safe_float(data.get("total_gst"))
    grand     = _safe_float(data.get("grand_total"))

    gst_line = (
        f"  IGST: {_fmt_inr(data.get('total_igst',0))}"
        if is_inter else
        f"  CGST: {_fmt_inr(data.get('total_cgst',0))} | SGST: {_fmt_inr(data.get('total_sgst',0))}"
    )

    extra_lines = []
    if disc_extra:  extra_lines.append(f"  Extra Disc: −{_fmt_inr(disc_extra)}")
    if shipping:    extra_lines.append(f"  Shipping: +{_fmt_inr(shipping)}")
    if other:       extra_lines.append(f"  Other Charges: +{_fmt_inr(other)}")

    supply_tag = "Interstate (IGST)" if is_inter else "Intrastate (CGST+SGST)"

    summary = (
        f"📄 *Invoice Preview*\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"🏢 *Company:* {data.get('company_name','—')}\n"
        f"📋 *Type:* {inv_type_label}\n"
        f"🏷 *Supply:* {supply_tag}\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"👤 *Client:* {data.get('client_name','—')}\n"
    )
    if data.get("client_email"):   summary += f"📧 {data['client_email']}\n"
    if data.get("client_phone"):   summary += f"📞 {data['client_phone']}\n"
    if data.get("client_gstin"):   summary += f"🏷 GSTIN: `{data['client_gstin']}`\n"
    if data.get("client_address"): summary += f"📍 {data['client_address'][:60]}\n"
    if data.get("client_state"):   summary += f"📌 State: {data['client_state']}\n"

    summary += (
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📦 *Line Items:*\n"
        + "\n".join(items_lines) + "\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"  Taxable: {_fmt_inr(taxable)}\n"
        + gst_line + "\n"
        + ("  Total GST: " + _fmt_inr(total_gst) + "\n")
        + "\n".join(extra_lines) + ("\n" if extra_lines else "")
        + f"  💎 *Grand Total: {_fmt_inr(grand)}*\n"
        f"━━━━━━━━━━━━━━━━━━━━\n"
        f"📅 Date: {data.get('invoice_date', _today())}\n"
        f"📆 Due:  {data.get('due_date', _today_plus(30))}\n"
    )
    if data.get("reference_no"):    summary += f"🔑 Ref: {data['reference_no']}\n"
    if data.get("payment_terms"):   summary += f"💳 Terms: {data['payment_terms']}\n"
    if data.get("notes"):           summary += f"📝 Notes: {data['notes']}\n"
    return summary


# ═══════════════════════════════════════════════════════════════════════════════
# NATURAL-LANGUAGE COMMAND / REPORT ENGINE
# ═══════════════════════════════════════════════════════════════════════════════
# This is additive. Existing /commands, callback flows and Lead AI remain intact.
# Plain-language messages are routed here first when there is no active wizard.
# Missing information is deliberately stored as None/blank; it is never invented.

TG_AI_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
TG_AI_MODEL = os.getenv("TELEGRAM_AI_MODEL", "gemini-3.6-flash")


def _tg_clean(value):
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
        if not value or value.lower() in {"none", "null", "n/a", "na", "unknown", "not provided", "not available"}:
            return None
    return value


def _tg_parse_date(value):
    value = _tg_clean(value)
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except Exception:
        try:
            return datetime.strptime(str(value), "%Y-%m-%d")
        except Exception:
            return None


def _tg_date_filter(date_from=None, date_to=None, field="created_at"):
    q = {}
    start = _tg_parse_date(date_from)
    end = _tg_parse_date(date_to)
    if start:
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        q["$gte"] = start
    if end:
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        # Date-only end dates include the complete day.
        if str(date_to).strip().endswith("00:00:00") or len(str(date_to).strip()) == 10:
            end = end + timedelta(days=1) - timedelta(microseconds=1)
        q["$lte"] = end
    return {field: q} if q else {}


def _tg_display_dt(value):
    if value is None:
        return "—"
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%d-%m-%Y %H:%M")
    return str(value)[:32]


def _tg_permissions(user, module):
    if not user:
        return False
    if user.get("role") == "admin":
        return True
    perms = user.get("permissions") or {}
    aliases = {
        "tasks": ["can_view_all_tasks", "view_other_tasks"],
        "leads": ["can_view_all_leads"],
        "attendance": ["can_view_attendance"],
        "clients": ["can_view_all_clients", "can_edit_clients"],
        "invoices": ["can_view_all_invoices"],
        "quotations": ["can_view_all_quotations", "can_view_quotations"],
    }
    return any(bool(perms.get(k)) for k in aliases.get(module, []))


async def _tg_find_user(name=None, user_id=None):
    if user_id:
        return await db.users.find_one({"id": str(user_id)}, {"_id": 0, "password": 0})
    name = _tg_clean(name)
    if not name:
        return None
    regex = {"$regex": re.escape(str(name)), "$options": "i"}
    return await db.users.find_one(
        {"$or": [{"full_name": regex}, {"name": regex}, {"email": regex}]},
        {"_id": 0, "password": 0},
    )


# ═══════════════════════════════════════════════════════════════════════════════
# SELF-LEARNING TELEGRAM MEMORY
#
# This is retrieval-based learning, not model retraining. Every successful
# natural-language interaction is stored as an example. Future messages are
# parsed with a small set of the user's own previous examples, so Taskosphere
# gradually learns personal wording such as:
#   "my pending work" -> get_tasks
#   "show Rahul's pending" -> get_tasks(user_name=Rahul)
#   "new enquiries last week" -> get_leads(date range)
#   "send Abori House bill" -> get_invoice(output_format=pdf)
#
# We never use learned memory to invent missing business data. It only helps
# map language to an action/field structure.
# ═══════════════════════════════════════════════════════════════════════════════

TG_MEMORY_COLLECTION = "telegram_ai_memory"
TG_VOCAB_COLLECTION = "telegram_ai_vocabulary"
TG_MEMORY_MAX_EXAMPLES = 8
TG_VOCAB_MAX_EXAMPLES = 12
TG_MEMORY_RETENTION_DAYS = 365
_TG_LEARNING_INDEXES_READY = False


def _tg_memory_safe_text(text: str) -> str:
    """Remove obvious secrets before a Telegram message is stored as memory."""
    value = str(text or "")
    patterns = [
        r"(?i)(bot\d+:[A-Za-z0-9_-]{20,})",
        r"(?i)(api[_ -]?key\s*[:=]\s*)\S+",
        r"(?i)(password\s*[:=]\s*)\S+",
        r"(?i)(secret\s*[:=]\s*)\S+",
        r"(?i)(token\s*[:=]\s*)\S+",
    ]
    for pattern in patterns:
        value = re.sub(pattern, r"\1[REDACTED]" if "\\s" in pattern else "[REDACTED]", value)
    return value[:3000]


async def _tg_get_learning_examples(user_id=None, chat_id=None, limit=TG_MEMORY_MAX_EXAMPLES):
    """Return recent successful examples for this user, plus a few global ones."""
    try:
        query = {"active": True}
        if user_id:
            query["user_id"] = str(user_id)
        elif chat_id:
            query["chat_id"] = str(chat_id)
        rows = await db[TG_MEMORY_COLLECTION].find(
            query,
            {"_id": 0, "message": 1, "intent": 1, "action": 1, "confidence": 1},
        ).sort("created_at", -1).limit(int(limit)).to_list(int(limit))
        return rows
    except Exception as exc:
        print(f"[Telegram Learning] memory read skipped: {exc}")
        return []


async def _tg_store_learning_example(
    *, user_id=None, chat_id=None, message=None, intent=None, outcome="parsed"
):
    """Persist a language->intent example for future retrieval."""
    try:
        action = str((intent or {}).get("action") or "none").strip().lower()
        confidence = float((intent or {}).get("confidence") or 0)
        if not message or action in {"none", "help"} or confidence < 0.70:
            return
        clean_message = _tg_memory_safe_text(message)
        if len(clean_message.strip()) < 3:
            return
        now = datetime.now(timezone.utc)
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": str(user_id) if user_id else None,
            "chat_id": str(chat_id) if chat_id else None,
            "message": clean_message,
            "intent": intent,
            "action": action,
            "confidence": confidence,
            "outcome": outcome,
            "active": True,
            "created_at": now,
            "updated_at": now,
        }
        # Avoid storing the exact same phrase repeatedly.
        existing = await db[TG_MEMORY_COLLECTION].find_one(
            {"user_id": doc["user_id"], "message": clean_message, "action": action},
            {"_id": 1},
        )
        if existing:
            await db[TG_MEMORY_COLLECTION].update_one(
                {"_id": existing["_id"]},
                {"$set": {"intent": intent, "confidence": confidence, "outcome": outcome, "updated_at": now}},
            )
        else:
            await db[TG_MEMORY_COLLECTION].insert_one(doc)
    except Exception as exc:
        # Learning must NEVER break the actual Telegram command.
        print(f"[Telegram Learning] memory write skipped: {exc}")


async def _tg_learn_from_feedback(chat_id: int, user_id=None, message: str = ""):
    """Find the most recent example so corrections can be fed back to the parser."""
    try:
        previous = await db[TG_MEMORY_COLLECTION].find_one(
            {"chat_id": str(chat_id), "active": True},
            {"_id": 0, "message": 1, "intent": 1, "action": 1},
            sort=[("created_at", -1)],
        )
        if not previous:
            return None
        return previous
    except Exception as exc:
        print(f"[Telegram Learning] feedback lookup skipped: {exc}")
        return None


async def _tg_ensure_learning_indexes():
    """Safe startup helper; duplicate/index errors are deliberately non-fatal."""
    try:
        await db[TG_MEMORY_COLLECTION].create_index([("user_id", 1), ("created_at", -1)])
        await db[TG_MEMORY_COLLECTION].create_index([("chat_id", 1), ("created_at", -1)])
        await db[TG_MEMORY_COLLECTION].create_index([("message", 1), ("action", 1)])
        await db[TG_VOCAB_COLLECTION].create_index([("terms", 1), ("action", 1)])
        await db[TG_VOCAB_COLLECTION].create_index([("user_id", 1), ("updated_at", -1)])
    except Exception as exc:
        print(f"[Telegram Learning] index creation skipped: {exc}")


def _tg_learning_tokens(text: str):
    """Return useful words while excluding common business-data tokens."""
    words = re.findall(r"[A-Za-z0-9][A-Za-z0-9_-]{1,40}", str(text or "").lower())
    stop = {
        "the", "a", "an", "to", "for", "of", "from", "on", "in", "at", "is", "are",
        "please", "can", "you", "me", "my", "your", "this", "that", "and", "or", "with",
        "send", "share", "show", "give", "get", "need", "want", "make", "create", "prepare",
    }
    return [w for w in dict.fromkeys(words) if w not in stop and len(w) >= 2][:25]


async def _tg_get_learning_vocabulary(text: str, user_id=None, limit=TG_VOCAB_MAX_EXAMPLES):
    try:
        tokens = _tg_learning_tokens(text)
        query = {"active": True}
        if tokens:
            query["terms"] = {"$in": tokens}
        if user_id:
            query = {"$and": [query, {"$or": [{"user_id": str(user_id)}, {"user_id": None}]}]}
        return await db[TG_VOCAB_COLLECTION].find(
            query,
            {"_id": 0, "term": 1, "action": 1, "uses": 1, "confidence": 1},
        ).sort([("uses", -1), ("updated_at", -1)]).limit(int(limit)).to_list(int(limit))
    except Exception as exc:
        print(f"[Telegram Learning] vocabulary read skipped: {exc}")
        return []


async def _tg_store_learning_vocabulary(*, user_id=None, chat_id=None, message=None, intent=None):
    """Learn new intent words, never customer/financial data."""
    try:
        intent = intent or {}
        action = str(intent.get("action") or "none").strip().lower()
        confidence = float(intent.get("confidence") or 0)
        if not message or action in {"none", "help"} or confidence < 0.70:
            return
        raw_terms = intent.get("learned_terms") or []
        if isinstance(raw_terms, str):
            raw_terms = [raw_terms]
        for raw in raw_terms[:5]:
            term = re.sub(r"[^a-z0-9 _-]", "", str(raw or "").lower()).strip()[:80]
            if not term:
                continue
            now = datetime.now(timezone.utc)
            existing = await db[TG_VOCAB_COLLECTION].find_one(
                {"term": term, "action": action, "$or": [{"user_id": str(user_id) if user_id else None}, {"user_id": None}]},
                {"_id": 1},
            )
            if existing:
                await db[TG_VOCAB_COLLECTION].update_one(
                    {"_id": existing["_id"]},
                    {"$set": {"confidence": confidence, "updated_at": now, "active": True}, "$inc": {"uses": 1}},
                )
            else:
                await db[TG_VOCAB_COLLECTION].insert_one({
                    "id": str(uuid.uuid4()), "user_id": str(user_id) if user_id else None,
                    "chat_id": str(chat_id) if chat_id else None, "term": term,
                    "terms": term.split(), "action": action, "confidence": confidence,
                    "uses": 1, "active": True, "created_at": now, "updated_at": now,
                })
    except Exception as exc:
        print(f"[Telegram Learning] vocabulary write skipped: {exc}")


def _tg_fallback_intent(text: str):
    """Deterministic fallback for common requests when the AI parser is unavailable."""
    raw = str(text or "").strip()
    low = raw.lower().replace("’", "'")
    if not raw:
        return None

    create_invoice_words = r"\b(prepare|create|make|raise|generate)\b.*\b(invoice|bill)\b|\b(create|make|prepare|raise)\s+(?:a\s+)?bill\b"
    if re.search(create_invoice_words, low):
        client = None
        m = re.search(r"\b(?:for|of)\s+(.+?)(?=\s+(?:for|total|amount|services?|service|from)\b|$)", raw, re.I)
        if m:
            client = m.group(1).strip(" .,'\"")
        return {"action": "create_invoice", "confidence": 0.82, "output_format": "text",
                "invoice": {"invoice_no": None, "client_name": client}}

    retrieval = re.search(r"\b(share|send|give|show|get|find|download|need)\b", low) or re.search(r"\b(invoice|bill)\b", low)
    invoice_words = re.search(r"\b(invoice|bill|tax\s+invoice|invoice\s+pdf)\b", low)
    if retrieval and invoice_words and not re.search(r"\b(prepare|create|make|raise|generate)\b", low):
        client = None
        patterns = [
            r"\b(?:invoice|bill)(?:\s+pdf)?\s+(?:of|for|from)\s+(.+)$",
            r"\b(?:invoice|bill)(?:\s+pdf)?\s+(?:for|of)\s+(.+)$",
            r"\b(?:share|send|give|show|get|find|download)\s+(?:me\s+)?(.+?)\s+(?:invoice|bill)(?:\s+pdf)?\s*$",
            r"\b(?:i\s+need|need)\s+(.+?)['’]s\s+(?:invoice|bill)(?:\s+pdf)?\s*$",
        ]
        for pattern in patterns:
            m = re.search(pattern, raw, re.I)
            if m:
                client = m.group(1).strip(" .,'\"")
                break
        if client:
            client = re.sub(r"^(?:the|my)\s+", "", client, flags=re.I).strip()
        return {"action": "get_invoice", "confidence": 0.90 if client else 0.76,
                "output_format": "pdf" if re.search(r"\b(share|send|give|show|get|find|download|need|pdf)\b", low) else "text",
                "invoice": {"invoice_no": None, "client_name": client}}

    return None


def _tg_normalize_conversational_text(text: str) -> str:
    """
    Light normalization only.  It helps the parser recognize conversational
    wording without rewriting names, amounts, invoice numbers, or dates.
    """
    value = str(text or "").strip()
    if not value:
        return value

    # Common conversational shorthand. Keep the original meaning intact.
    value = re.sub(r"(?i)^pls\\b", "please", value)
    value = re.sub(r"(?i)^plz\\b", "please", value)
    value = re.sub(r"(?i)\\bbill\\b", "invoice", value)
    value = re.sub(r"(?i)\\bbilling\\b", "invoice", value)

    return value


async def _tg_ai_command(text: str, user_id=None, chat_id=None):
    if not TG_AI_KEY or not httpx:
        return None
    original_text = str(text or "").strip()
    parser_text = _tg_normalize_conversational_text(original_text)
    today = date.today().isoformat()
    learning_examples = await _tg_get_learning_examples(
        user_id=user_id, chat_id=chat_id, limit=TG_MEMORY_MAX_EXAMPLES
    )
    learning_vocabulary = await _tg_get_learning_vocabulary(
        parser_text, user_id=user_id, limit=TG_VOCAB_MAX_EXAMPLES
    )
    vocabulary_text = "\n".join(
        f"- Learned word/phrase: {v.get('term')} -> {v.get('action')}"
        for v in learning_vocabulary
    ) or "(No matching learned vocabulary yet.)"
    examples_text = "\n".join(
        f"- User previously said: {ex.get('message')}\n  Learned intent: {json.dumps(ex.get('intent') or {}, ensure_ascii=False)}"
        for ex in learning_examples
    ) or "(No previous examples yet. Learn from this message.)"
    feedback_hint = ""
    if re.search(r"(?i)\b(no|wrong|incorrect|i meant|not that|that's not|instead)\b", text):
        previous = await _tg_learn_from_feedback(chat_id, user_id=user_id, message=text)
        if previous:
            feedback_hint = (
                "\nThe user may be correcting a previous request. Previous request was: "
                + str(previous.get("message") or "")
                + "\nPrevious intent was: "
                + json.dumps(previous.get("intent") or {}, ensure_ascii=False)
            )
    prompt = f"""
You are Taskosphere's Telegram assistant and natural-language action parser for a CA/CS ERP.
Today is {today}.

The user is speaking naturally, like they would speak to a colleague. Do NOT require slash
commands, database terminology, field names, or a rigid sentence structure.

Your job has TWO separate responsibilities:
1. Understand what the user wants, even when the wording is informal, abbreviated, misspelled,
   conversational, or incomplete.
2. Return ONLY valid JSON describing the intended action.

Never invent missing business data. Missing fields MUST be null, empty string, or [].
Resolve relative dates into ISO dates when possible.

IMPORTANT LANGUAGE RULES:
- "bill", "invoice", "tax bill", "billing" and "invoice PDF" can refer to invoices.
- "share", "send", "give me", "show me", "get me", "I need" can all express retrieval.
- "share invoice pdf of Abori House", "send Abori House bill", "I need Abori House's invoice",
  and "can you send the latest invoice for Abori House" should all map to get_invoice with
  output_format="pdf" when the user is asking for the PDF.
- "prepare invoice", "make invoice", "raise invoice", "create bill", "make a bill" can map
  to create_invoice.
- "lead", "enquiry", "enquiry from", "prospect", "new customer enquiry" can refer to a lead.
- "task", "work", "job", "to-do", "please handle", "give this to Priya" can refer to tasks.
- "client", "customer", "company" can refer to a client when the context is client management.
- "quotation", "quote", "estimate" can refer to quotations, subject to the existing action rules.
- Understand possessive and natural forms such as "Rahul's pending work", "Abori House bill",
  "invoice for Radhakrishna Gems", and "task for Priya".
- Preserve exact names, amounts, invoice numbers, dates, service names and company names from
  the current message. Do not replace them with data from learned examples.
- If the user asks to perform a financial or record-changing action and essential information is
  missing, identify the action and leave the missing field null so the application can ask for it.

LEARNED LANGUAGE EXAMPLES:
{examples_text}

LEARNED VOCABULARY:
{vocabulary_text}
{feedback_hint}

Use learned examples only to understand wording and intent. Do NOT copy business data from an example into the current request.
The current message always has priority. If a field is not stated in the current message, return it as null/empty.

Allowed actions:
create_task, create_lead, create_client, create_invoice, create_quotation,
get_tasks, get_leads, get_attendance, get_clients, get_invoices, get_quotations,
get_task, get_lead, get_client, get_invoice, get_quotation, help, none.

For reports and retrieval, understand phrases such as:
- pending/overdue/completed/all tasks
- pending tasks of a named user / tasks assigned to a named user / someone's pending work
- my tasks / tasks assigned by me
- attendance / attendance of a named user / attendance between two dates
- new leads / enquiries / leads between two dates / leads of a company/contact
- clients / customers / clients added between dates / a particular client
- pending invoices / invoices of a client / bill of a client
- invoice PDF of a client / share invoice PDF / send bill / latest invoice for a client
- quotations / quote of a client / quotation PDF / share quote
- "show", "send", "share", "get", "give me", "I need", "please find" as retrieval wording

For creation, extract every explicitly stated field but leave unspecified fields blank.
For task assignment, assignee_name is the person the task is assigned to; if absent leave null.
For a PDF request, set output_format to "pdf".
For "latest" or "most recent", use the existing date/order behaviour rather than inventing an invoice number.

Also return "learned_terms": [] with up to 5 NEW intent words/short phrases from the current message that helped identify the action. Never include customer names, person names, amounts, dates, invoice numbers, phone numbers, emails, GSTIN/PAN/CIN, or addresses.

NATURAL-LANGUAGE EXAMPLES:
- "share invoice pdf of abori house" -> get_invoice, output_format="pdf", invoice.client_name="Abori House"
- "send Abori House bill" -> get_invoice, output_format="pdf", invoice.client_name="Abori House"
- "can you send me the latest invoice for Abori House" -> get_invoice, output_format="pdf", invoice.client_name="Abori House"
- "prepare invoice for Radhakrishna Gems for ROC services total amount 15000 from MS Advisory"
  -> create_invoice; capture client, service, amount and billing company only if those fields exist in the schema
- "give Priya the ROC task for Radhakrishna Gems tomorrow" -> create_task with assignee_name="Priya"
- "Radhakrishna Gems is interested in trademark registration" -> create_lead with company/requirement

Return this shape:
{{
  "action": "none",
  "confidence": 0.0,
  "output_format": "text",
  "status": null,
  "date_from": null,
  "date_to": null,
  "user_name": null,
  "assignee_name": null,
  "search": null,
  "task": {{"title": null,"description": null,"due_date": null,"priority": null,"category": null,"client_name": null}},
  "lead": {{"contact_name": null,"company_name": null,"phone": null,"email": null,"services": [],"trademark_name": null,"quotation_amount": null,"next_follow_up": null,"notes": null}},
  "client": {{"company_name": null,"client_type": null,"email": null,"phone": null,"gstin": null,"pan": null,"cin": null,"llpin": null,"address": null,"city": null,"state": null,"services": [],"notes": null}},
  "invoice": {{"invoice_no": null,"client_name": null}},
  "quotation": {{"quotation_no": null,"client_name": null}},
  "learned_terms": [],
  "limit": 30
}}

USER MESSAGE:
{parser_text}
""".strip()
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{TG_AI_MODEL}:generateContent?key={TG_AI_KEY}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
        raw = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        raw = raw.strip()
        if raw.startswith("```"):
            raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.I)
            raw = re.sub(r"\s*```$", "", raw)
        try:
            return json.loads(raw)
        except Exception:
            match = re.search(r"\{.*\}", raw, flags=re.S)
            return json.loads(match.group(0)) if match else None
    except Exception as exc:
        print(f"[Telegram NL AI] parser unavailable: {exc}")
        return None


def _tg_scope_query(user, module):
    if user and user.get("role") == "admin":
        return {}
    if _tg_permissions(user, module):
        return {}
    uid = user.get("id") if user else None
    if not uid:
        return {"__never__": "telegram_unlinked"}
    if module == "tasks":
        return {"$or": [{"assigned_to": uid}, {"sub_assignees": uid}, {"created_by": uid}]}
    if module == "leads":
        return {"$or": [{"assigned_to": uid}, {"created_by": uid}]}
    if module == "clients":
        return {"$or": [{"assigned_to": uid}, {"created_by": uid}]}
    if module == "invoices":
        return {"created_by": uid}
    if module == "quotations":
        return {"created_by": uid}
    if module == "attendance":
        return {"user_id": uid}
    return {}


def _tg_merge_query(*parts):
    parts = [p for p in parts if p]
    if not parts:
        return {}
    if len(parts) == 1:
        return parts[0]
    return {"$and": parts}


async def _tg_natural_language_handler(chat_id: int, text: str, message: dict) -> bool:
    """Handle plain-language create/report requests. Returns True if consumed."""
    global _TG_LEARNING_INDEXES_READY
    if not _TG_LEARNING_INDEXES_READY:
        await _tg_ensure_learning_indexes()
        _TG_LEARNING_INDEXES_READY = True

    convo = await db.telegram_conversations.find_one({"telegram_id": chat_id})
    # Never interrupt an existing multi-step wizard.
    if convo:
        return False

    user = await db.users.find_one({"telegram_id": chat_id}, {"_id": 0, "password": 0})
    intent = await _tg_ai_command(
        text,
        user_id=user.get("id") if user else None,
        chat_id=chat_id,
    )
    if not intent:
        # Never fall through to the generic Welcome message just because the AI
        # provider is unavailable or returns malformed JSON. Handle the most
        # common natural-language invoice requests locally.
        intent = _tg_fallback_intent(text)
    else:
        # If the AI returned a valid JSON object but could not classify the
        # message, give the deterministic fallback a chance before Welcome.
        ai_action = str(intent.get("action") or "none").lower().strip()
        if ai_action == "none":
            fallback_intent = _tg_fallback_intent(text)
            if fallback_intent:
                intent = fallback_intent
    if not intent:
        return False
    # Store the language pattern only after the parser produced a confident intent.
    is_feedback = bool(re.search(r"(?i)\b(no|wrong|incorrect|i meant|not that|that's not|instead)\b", text))
    await _tg_store_learning_example(
        user_id=user.get("id") if user else None,
        chat_id=chat_id,
        message=text,
        intent=intent,
        outcome="correction" if is_feedback else "parsed",
    )
    await _tg_store_learning_vocabulary(
        user_id=user.get("id") if user else None,
        chat_id=chat_id,
        message=text,
        intent=intent,
    )
    action = str(intent.get("action") or "none").lower().strip()
    if action in {"none", "help"}:
        if action == "help":
            await send_message(
                chat_id,
                "🤖 *Just tell me what you need in normal language.*\n\n"
                "For example:\n"
                "• “Share invoice PDF of Abori House”\n"
                "• “Prepare invoice for Radhakrishna Gems for ROC services, 15000”\n"
                "• “Give Priya the ROC task for ABC tomorrow”\n"
                "• “Show Rahul's pending work”\n"
                "• “Add ABC Pvt Ltd as a client”\n"
                "• “Show new leads from 1 August to 20 August”"
            )
            return True
        return False

    if not user:
        await send_message(chat_id, "🔗 I can help with that, but this Telegram account isn't linked to a Taskosphere user yet.")
        return True

    # ───────────────────────────────────────────────────────────────────────
    # CREATE TASK
    # ───────────────────────────────────────────────────────────────────────
    if action == "create_task":
        task = intent.get("task") or {}
        title = _tg_clean(task.get("title"))
        if not title:
            await send_message(chat_id, "❌ Please provide a task title.")
            return True
        assignee = await _tg_find_user(intent.get("assignee_name"))
        if intent.get("assignee_name") and not assignee:
            await send_message(chat_id, f"👤 I couldn't find a Taskosphere user named *{intent.get('assignee_name')}*. Could you check the name?")
            return True
        now = datetime.now(timezone.utc)
        client = None
        if _tg_clean(task.get("client_name")):
            client = await db.clients.find_one({"company_name": {"$regex": re.escape(task["client_name"]), "$options": "i"}}, {"_id": 0})
        new_task = {
            "id": str(uuid.uuid4()),
            "title": title,
            "description": _tg_clean(task.get("description")),
            "assigned_to": assignee.get("id") if assignee else None,
            "sub_assignees": [],
            "priority": _tg_clean(task.get("priority")),
            "status": "pending",
            "category": _tg_clean(task.get("category")),
            "client_id": client.get("id") if client else None,
            "is_recurring": False,
            "recurrence_pattern": None,
            "recurrence_interval": None,
            "created_by": user["id"],
            "created_at": now,
            "updated_at": now,
            "due_date": _tg_clean(task.get("due_date")),
            "type": "task",
        }
        await db.tasks.insert_one(new_task)
        if assignee:
            await create_notification(user_id=assignee["id"], title="New Task Assigned", message=f"Task '{title}' assigned via Telegram", type="assignment")
        await send_message(
            chat_id,
            _tg_human_task_created(
                task,
                assignee=assignee,
            ),
        )
        return True

    # ───────────────────────────────────────────────────────────────────────
    # CREATE LEAD
    # ───────────────────────────────────────────────────────────────────────
    if action == "create_lead":
        if not _tg_permissions(user, "leads") and user.get("role") != "admin":
            await send_message(chat_id, "🚫 You do not have permission to add leads.")
            return True
        lead = intent.get("lead") or {}
        now = datetime.now(timezone.utc)
        services = lead.get("services") or []
        if isinstance(services, str):
            services = [x.strip() for x in re.split(r"[,;]+", services) if x.strip()]
        company_name = _tg_clean(lead.get("company_name"))
        contact_name = _tg_clean(lead.get("contact_name"))
        phone = _tg_clean(lead.get("phone"))
        duplicate = await db.leads.find_one({"phone": phone}, {"_id": 0}) if phone else None
        if not duplicate and company_name:
            duplicate = await db.leads.find_one({"company_name": {"$regex": re.escape(company_name), "$options": "i"}, "status": {"$ne": "closed"}}, {"_id": 0})
        if duplicate:
            await send_message(chat_id, f"ℹ️ I found an existing lead for *{company_name or contact_name or phone}*, so I didn’t create a duplicate.")
            return True
        doc = {
            "id": str(uuid.uuid4()), "company_name": company_name, "contact_name": contact_name,
            "email": _tg_clean(lead.get("email")), "phone": phone, "services": services,
            "quotation_amount": lead.get("quotation_amount"), "status": "new", "source": "telegram",
            "next_follow_up": _tg_clean(lead.get("next_follow_up")), "notes": _tg_clean(lead.get("notes")),
            "assigned_to": None, "created_by": user["id"], "created_at": now, "updated_at": now,
            "trademark_name": _tg_clean(lead.get("trademark_name")),
            "company_name_requested": None, "telegram_chat_id": str(chat_id),
            "telegram_sender_id": str(message.get("from", {}).get("id", "")),
            "telegram_original_message": text, "ai_captured": True,
            "ai_confidence": float(intent.get("confidence") or 0),
        }
        await db.leads.insert_one(doc)
        await send_message(
            chat_id,
            _tg_human_lead_created({
                "contact_name": contact_name,
                "company_name": company_name,
                "services": services,
                "phone": phone,
                "email": lead.get("email"),
            }),
        )
        return True

    # ───────────────────────────────────────────────────────────────────────
    # CREATE CLIENT
    # ───────────────────────────────────────────────────────────────────────
    if action == "create_client":
        if user.get("role") not in ("admin", "manager") and not (user.get("permissions") or {}).get("can_edit_clients"):
            await send_message(chat_id, "🚫 You do not have permission to add clients.")
            return True
        c = intent.get("client") or {}
        company_name = _tg_clean(c.get("company_name"))
        if not company_name:
            await send_message(chat_id, "❌ Please provide the client/company name.")
            return True
        existing = await db.clients.find_one({"company_name": {"$regex": f"^{re.escape(company_name)}$", "$options": "i"}}, {"_id": 0})
        if existing:
            await send_message(chat_id, f"ℹ️ *{existing.get('company_name', company_name)}* is already in your client list, so I didn’t create a duplicate.")
            return True
        doc = {
            "id": str(uuid.uuid4()), "company_name": company_name,
            "client_type": _tg_clean(c.get("client_type")) or "",
            "contact_persons": [], "email": _tg_clean(c.get("email")) or "",
            "phone": _tg_clean(c.get("phone")) or "", "birthday": None,
            "services": c.get("services") or [], "dsc_details": [],
            "assigned_to": None, "notes": _tg_clean(c.get("notes")),
            "gstin": _tg_clean(c.get("gstin")) or "", "pan": _tg_clean(c.get("pan")) or "",
            "cin": _tg_clean(c.get("cin")) or "", "llpin": _tg_clean(c.get("llpin")) or "",
            "address": _tg_clean(c.get("address")) or "", "city": _tg_clean(c.get("city")) or "",
            "state": _tg_clean(c.get("state")) or "", "created_by": user["id"],
            "created_at": datetime.now(timezone.utc), "status": "active",
        }
        await db.clients.insert_one(doc)
        await send_message(chat_id, _tg_human_client_created(doc))
        return True

    # ───────────────────────────────────────────────────────────────────────
    # REPORT / SEARCH QUERIES
    # ───────────────────────────────────────────────────────────────────────
    date_from = intent.get("date_from")
    date_to = intent.get("date_to")
    search = _tg_clean(intent.get("search"))
    user_name = _tg_clean(intent.get("user_name"))
    target_user = await _tg_find_user(user_name) if user_name else None
    if user_name and not target_user:
        await send_message(chat_id, f"👤 I couldn't find a Taskosphere user named *{user_name}*. Could you check the name?")
        return True

    if action in {"get_tasks", "get_task"}:
        if target_user and not _tg_permissions(user, "tasks") and user.get("id") != target_user.get("id"):
            await send_message(chat_id, "🚫 You do not have permission to view another user's tasks.")
            return True
        base = _tg_scope_query(user, "tasks")
        if target_user:
            base = {"$or": [{"assigned_to": target_user["id"]}, {"sub_assignees": target_user["id"]}, {"created_by": target_user["id"]}]}
        filters = []
        status = _tg_clean(intent.get("status"))
        if status:
            filters.append({"status": {"$regex": f"^{re.escape(status)}$", "$options": "i"}})
        if search:
            filters.append({"$or": [{"title": {"$regex": re.escape(search), "$options": "i"}}, {"description": {"$regex": re.escape(search), "$options": "i"}}]})
        dq = _tg_date_filter(date_from, date_to, "due_date")
        if dq: filters.append(dq)
        q = _tg_merge_query(base, *filters)
        tasks = await db.tasks.find(q, {"_id": 0}).sort("due_date", 1).limit(min(int(intent.get("limit") or 30), 100)).to_list(min(int(intent.get("limit") or 30), 100))
        if not tasks:
            await send_message(chat_id, _tg_human_no_results("tasks", search))
            return True
        ids = {x.get("assigned_to") for x in tasks if x.get("assigned_to")} | {x.get("created_by") for x in tasks if x.get("created_by")}
        users = await db.users.find({"id": {"$in": list(ids)}}, {"_id": 0, "password": 0}).to_list(100)
        um = {x["id"]: x.get("full_name", x.get("email", "")) for x in users}
        lines = [f"📋 *Tasks ({len(tasks)})*"]
        for t in tasks:
            lines.append(f"\n• *{t.get('title') or '—'}*\n  👤 {um.get(t.get('assigned_to'), '—')}\n  📅 {t.get('due_date') or '—'}\n  🔹 {t.get('status') or '—'} | ⚡ {t.get('priority') or '—'}")
        await send_message(chat_id, "\n".join(lines))
        return True

    if action == "get_leads":
        if target_user and not _tg_permissions(user, "leads") and user.get("id") != target_user.get("id"):
            await send_message(chat_id, "🚫 You do not have permission to view another user's leads.")
            return True
        base = _tg_scope_query(user, "leads")
        filters = []
        if target_user: filters.append({"assigned_to": target_user["id"]})
        if search:
            rx = {"$regex": re.escape(search), "$options": "i"}
            filters.append({"$or": [{"company_name": rx}, {"contact_name": rx}, {"phone": rx}, {"email": rx}]})
        if _tg_clean(intent.get("status")): filters.append({"status": {"$regex": f"^{re.escape(intent['status'])}$", "$options": "i"}})
        dq = _tg_date_filter(date_from, date_to, "created_at")
        if dq: filters.append(dq)
        leads = await db.leads.find(_tg_merge_query(base, *filters), {"_id": 0}).sort("created_at", -1).limit(min(int(intent.get("limit") or 30), 100)).to_list(min(int(intent.get("limit") or 30), 100))
        if not leads:
            await send_message(chat_id, _tg_human_no_results("leads", search))
            return True
        lines = [f"📈 *Leads ({len(leads)})*"]
        for x in leads:
            lines.append(f"\n• *{x.get('company_name') or '—'}*\n  👤 {x.get('contact_name') or '—'}\n  📞 {x.get('phone') or '—'}\n  📂 {', '.join(x.get('services') or []) or '—'}\n  📅 {_tg_display_dt(x.get('created_at'))} | {x.get('status') or '—'}")
        await send_message(chat_id, "\n".join(lines))
        return True

    if action == "get_attendance":
        if target_user and not _tg_permissions(user, "attendance") and user.get("id") != target_user.get("id"):
            await send_message(chat_id, "🚫 You do not have permission to view another user's attendance.")
            return True
        base = _tg_scope_query(user, "attendance")
        if target_user: base = {"user_id": target_user["id"]}
        dq = _tg_date_filter(date_from, date_to, "date")
        # attendance.date is YYYY-MM-DD string, so use string bounds for reliability.
        q = base
        if date_from or date_to:
            dfilter = {}
            if date_from: dfilter["$gte"] = str(date_from)[:10]
            if date_to: dfilter["$lte"] = str(date_to)[:10]
            q = _tg_merge_query(base, {"date": dfilter})
        rows = await db.attendance.find(q, {"_id": 0}).sort("date", -1).limit(1000).to_list(1000)
        if not rows:
            await send_message(chat_id, _tg_human_no_results("attendance"))
            return True
        ids = {r.get("user_id") for r in rows if r.get("user_id")}
        users = await db.users.find({"id": {"$in": list(ids)}}, {"_id": 0, "password": 0}).to_list(1000)
        um = {u["id"]: u.get("full_name", "") for u in users}
        lines = [f"🕘 *Attendance ({len(rows)})*"]
        for r in rows:
            duration = r.get("duration_minutes")
            dur = f"{int(duration)//60}h {int(duration)%60}m" if isinstance(duration, (int, float)) else "—"
            lines.append(f"\n• *{r.get('date') or '—'}* — {um.get(r.get('user_id'), '—')}\n  IN: {_tg_display_dt(r.get('punch_in'))}\n  OUT: {_tg_display_dt(r.get('punch_out'))}\n  Total: {dur}")
        await send_message(chat_id, "\n".join(lines))
        return True

    if action in {"get_clients", "get_client"}:
        base = _tg_scope_query(user, "clients")
        filters = []
        if search:
            rx = {"$regex": re.escape(search), "$options": "i"}
            filters.append({"$or": [{"company_name": rx}, {"phone": rx}, {"email": rx}, {"gstin": rx}]})
        dq = _tg_date_filter(date_from, date_to, "created_at")
        if dq: filters.append(dq)
        clients = await db.clients.find(_tg_merge_query(base, *filters), {"_id": 0}).sort("company_name", 1).limit(min(int(intent.get("limit") or 30), 100)).to_list(min(int(intent.get("limit") or 30), 100))
        if not clients:
            await send_message(chat_id, _tg_human_no_results("clients", search))
            return True
        lines = [f"🏢 *Clients ({len(clients)})*"]
        for c in clients:
            lines.append(f"\n• *{c.get('company_name') or '—'}*\n  📞 {c.get('phone') or '—'}\n  ✉️ {c.get('email') or '—'}\n  🏷 {c.get('gstin') or '—'}")
        await send_message(chat_id, "\n".join(lines))
        return True

    if action in {"get_invoices", "get_invoice"}:
        base = _tg_scope_query(user, "invoices")
        inv = intent.get("invoice") or {}
        filters = []
        if _tg_clean(inv.get("invoice_no")): filters.append({"invoice_no": {"$regex": re.escape(inv["invoice_no"]), "$options": "i"}})
        if _tg_clean(inv.get("client_name")): filters.append({"client_name": {"$regex": re.escape(inv["client_name"]), "$options": "i"}})
        if search: filters.append({"$or": [{"invoice_no": {"$regex": re.escape(search), "$options": "i"}}, {"client_name": {"$regex": re.escape(search), "$options": "i"}}]})
        if _tg_clean(intent.get("status")): filters.append({"status": {"$regex": f"^{re.escape(intent['status'])}$", "$options": "i"}})
        dq = _tg_date_filter(date_from, date_to, "invoice_date")
        if dq: filters.append(dq)
        invoices = await db.invoices.find(_tg_merge_query(base, *filters), {"_id": 0}).sort("invoice_date", -1).limit(min(int(intent.get("limit") or 20), 50)).to_list(min(int(intent.get("limit") or 20), 50))
        if not invoices:
            await send_message(chat_id, _tg_human_no_results("invoices", inv.get("client_name") or search))
            return True
        if intent.get("output_format") == "pdf" and len(invoices) == 1:
            return bool(await _send_invoice_pdf_by_id(chat_id, invoices[0].get("id")))
        lines = [f"🧾 *Invoices ({len(invoices)})*"]
        for x in invoices:
            lines.append(f"\n• *{x.get('invoice_no') or '—'}* — {x.get('client_name') or '—'}\n  💎 {_fmt_inr(x.get('grand_total', 0))}\n  📅 {x.get('invoice_date') or '—'} | {x.get('status') or '—'}")
        await send_message(chat_id, "\n".join(lines))
        return True

    if action in {"get_quotations", "get_quotation"}:
        base = _tg_scope_query(user, "quotations")
        qdata = intent.get("quotation") or {}
        filters = []
        if _tg_clean(qdata.get("quotation_no")): filters.append({"quotation_no": {"$regex": re.escape(qdata["quotation_no"]), "$options": "i"}})
        if _tg_clean(qdata.get("client_name")): filters.append({"client_name": {"$regex": re.escape(qdata["client_name"]), "$options": "i"}})
        if search: filters.append({"$or": [{"quotation_no": {"$regex": re.escape(search), "$options": "i"}}, {"client_name": {"$regex": re.escape(search), "$options": "i"}}]})
        if _tg_clean(intent.get("status")): filters.append({"status": {"$regex": f"^{re.escape(intent['status'])}$", "$options": "i"}})
        dq = _tg_date_filter(date_from, date_to, "created_at")
        if dq: filters.append(dq)
        quotations = await db.quotations.find(_tg_merge_query(base, *filters), {"_id": 0}).sort("created_at", -1).limit(min(int(intent.get("limit") or 20), 50)).to_list(min(int(intent.get("limit") or 20), 50))
        if not quotations:
            await send_message(chat_id, _tg_human_no_results("quotations", qdata.get("client_name") or search))
            return True
        lines = [f"📄 *Quotations ({len(quotations)})*"]
        for x in quotations:
            lines.append(f"\n• *{x.get('quotation_no') or x.get('number') or x.get('id','—')}* — {x.get('client_name') or '—'}\n  💎 {_fmt_inr(x.get('total_amount') or x.get('amount') or 0)}\n  📅 {_tg_display_dt(x.get('created_at'))} | {x.get('status') or '—'}")
        await send_message(chat_id, "\n".join(lines))
        return True

    return False


# ═══════════════════════════════════════════════════════════
# WEBHOOK
# ═══════════════════════════════════════════════════════════

@router.post("/webhook")
async def telegram_webhook(request: Request):  # noqa: C901  (complex but intentional)
    try:
        # ── Security ─────────────────────────────────────────────
        # Fail closed: with TELEGRAM_WEBHOOK_SECRET unset, a request without the
        # header used to match (None == None) and was processed.
        import secrets as _secrets
        expected_secret = str(os.getenv("TELEGRAM_WEBHOOK_SECRET") or "").strip()
        secret_token = str(request.headers.get("X-Telegram-Bot-Api-Secret-Token") or "").strip()
        if not expected_secret or not secret_token or not _secrets.compare_digest(secret_token, expected_secret):
            return {"status": "unauthorized"}

        payload = await request.json()

        # ═══════════════════════════════════════════════════════════
        # CALLBACK QUERY HANDLER
        # ═══════════════════════════════════════════════════════════
        if "callback_query" in payload:
            callback = payload["callback_query"]
            chat_id  = callback["message"]["chat"]["id"]
            clicked  = callback["data"]

            async with httpx.AsyncClient() as client:
                await client.post(
                    f"{TELEGRAM_API}/answerCallbackQuery",
                    json={"callback_query_id": callback["id"]}
                )

            # ── Generic cancel ────────────────────────────────────
            if clicked == "cancel_convo":
                await db.telegram_conversations.delete_many({"telegram_id": chat_id})
                await send_message(chat_id, "👍 No problem — I cancelled that for you.")
                return {"status": "cancelled"}

            # ── Delete task shortcut ──────────────────────────────
            if clicked.startswith("delete_"):
                task_id = clicked.replace("delete_", "")
                await db.tasks.delete_one({"id": task_id})
                await send_message(chat_id, "🗑 Done — I removed that task.")
                return {"status": "task_deleted"}

            # Load conversation
            convo = await db.telegram_conversations.find_one({"telegram_id": chat_id})
            if not convo:
                return {"status": "no_convo"}

            data       = convo.get("data", {})
            convo_type = convo.get("type", "task")

            # ═══════════════════════════════════════════════════════
            # ── INVOICE CALLBACKS ──────────────────────────────────
            # ═══════════════════════════════════════════════════════
            if convo_type == "invoice":

                # Company selected
                if clicked.startswith("invc_company_"):
                    company_id   = clicked.replace("invc_company_", "")
                    company_doc  = await db.companies.find_one({"id": company_id}, {"_id": 0}) or {}
                    data["company_id"]   = company_id
                    data["company_name"] = company_doc.get("name", company_id)
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_type", "data": data}}
                    )
                    await send_message(
                        chat_id, "📋 Select Invoice Type:",
                        inline_keyboard([
                            {"text": t["label"], "callback": f"invc_type_{t['value']}"}
                            for t in INV_TYPES_TG
                        ])
                    )
                    return {"status": "inv_company_selected"}

                # Invoice type selected
                if clicked.startswith("invc_type_"):
                    data["invoice_type"] = clicked.replace("invc_type_", "")
                    # Offer existing clients
                    clients = await db.clients.find({}, {"_id": 0}).to_list(30)
                    buttons = [
                        {"text": c["company_name"][:30], "callback": f"invc_client_{c['id']}"}
                        for c in clients
                    ]
                    buttons.append({"text": "✏️ Enter manually", "callback": "invc_client_manual"})
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_client_select", "data": data}}
                    )
                    await send_message(
                        chat_id, "🏢 Select existing client or enter manually:",
                        inline_keyboard(buttons)
                    )
                    return {"status": "inv_type_selected"}

                # Existing client selected
                if clicked.startswith("invc_client_") and clicked != "invc_client_manual":
                    client_id  = clicked.replace("invc_client_", "")
                    client_doc = await db.clients.find_one({"id": client_id}, {"_id": 0}) or {}
                    data["client_id"]      = client_id
                    data["client_name"]    = client_doc.get("company_name", "")
                    data["client_email"]   = client_doc.get("email", "")
                    data["client_phone"]   = client_doc.get("phone", "")
                    data["client_gstin"]   = client_doc.get("client_gstin", "") or client_doc.get("gstin", "")
                    addr_parts             = [client_doc.get("address",""), client_doc.get("city",""), client_doc.get("state","")]
                    data["client_address"] = ", ".join(p for p in addr_parts if p)
                    data["client_state"]   = client_doc.get("state", "")
                    # skip manual entry — go straight to supply state
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_supply_state", "data": data}}
                    )
                    await send_message(
                        chat_id,
                        f"✅ Client auto-filled: *{data['client_name']}*\n\n"
                        f"🏛 Enter *your supply state* (e.g. Gujarat) — used to determine IGST vs CGST/SGST.\n"
                        f"Type SKIP if unsure (defaults to intrastate)."
                    )
                    return {"status": "inv_client_autofilled"}

                # Manual client entry
                if clicked == "invc_client_manual":
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_client_name", "data": data}}
                    )
                    await send_message(chat_id, "👤 Enter *Client / Company Name*:")
                    return {"status": "inv_client_manual"}

                # Payment terms
                if clicked.startswith("invc_terms_"):
                    idx = int(clicked.replace("invc_terms_", ""))
                    data["payment_terms"] = PAY_TERMS_TG[idx]
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_item_desc", "data": data}}
                    )
                    await send_message(
                        chat_id,
                        f"✅ Terms: *{data['payment_terms']}*\n\n"
                        f"📦 Now let's add *Line Items*.\n\n"
                        f"Enter *Item Description* (e.g. GST Filing, Software License):"
                    )
                    return {"status": "inv_terms_selected"}

                # Item unit
                if clicked.startswith("invc_unit_"):
                    data.setdefault("current_item", {})["unit"] = clicked.replace("invc_unit_", "")
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_item_price", "data": data}}
                    )
                    await send_message(chat_id, f"💰 Enter *Unit Price* (₹):")
                    return {"status": "inv_unit_selected"}

                # Item GST rate
                if clicked.startswith("invc_gst_"):
                    rate = float(clicked.replace("invc_gst_", ""))
                    ci   = data.get("current_item", {})
                    ci["gst_rate"] = rate
                    # Compute this item's amounts
                    is_inter = data.get("is_interstate", False)
                    disc  = ci.get("unit_price", 0) * ci.get("quantity", 1) * ci.get("discount_pct", 0) / 100
                    tax   = round(ci.get("unit_price", 0) * ci.get("quantity", 1) - disc, 2)
                    if is_inter:
                        igst = round(tax * rate / 100, 2)
                        ci.update(taxable_value=tax, cgst_rate=0, sgst_rate=0, igst_rate=rate,
                                  cgst_amount=0, sgst_amount=0, igst_amount=igst,
                                  total_amount=round(tax + igst, 2))
                    else:
                        half = rate / 2
                        cg   = round(tax * half / 100, 2)
                        ci.update(taxable_value=tax, cgst_rate=half, sgst_rate=half, igst_rate=0,
                                  cgst_amount=cg, sgst_amount=cg, igst_amount=0,
                                  total_amount=round(tax + cg * 2, 2))
                    data.setdefault("items", []).append(ci)
                    data["current_item"] = {}
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_more_items", "data": data}}
                    )
                    await send_message(
                        chat_id,
                        f"✅ Item added — *{ci.get('description','Item')}* → {_fmt_inr(ci.get('total_amount',0))}\n\n"
                        f"Total items so far: {len(data['items'])}",
                        inline_keyboard([
                            {"text": "➕ Add Another Item",  "callback": "invc_more_yes"},
                            {"text": "✅ Done — Next Step",   "callback": "invc_more_no"},
                        ], include_cancel=True)
                    )
                    return {"status": "inv_item_added"}

                # More items?
                if clicked == "invc_more_yes":
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_item_desc", "data": data}}
                    )
                    await send_message(chat_id, f"📦 Enter *Item Description* for item #{len(data.get('items',[])) + 1}:")
                    return {"status": "inv_more_items_yes"}

                if clicked == "invc_more_no":
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "inv_extra_disc", "data": data}}
                    )
                    await send_message(
                        chat_id,
                        f"💸 Enter *additional discount amount* (₹) to deduct from total, or SKIP:"
                    )
                    return {"status": "inv_more_items_no"}

                # Confirm invoice creation
                if clicked == "confirm_invoice":
                    return await _handle_confirm_invoice(chat_id, data)

                # Resend PDF callback from invlist
                if clicked.startswith("inv_getpdf_"):
                    inv_id = clicked.replace("inv_getpdf_", "")
                    return await _send_invoice_pdf_by_id(chat_id, inv_id)

                # Email invoice callback from invlist
                if clicked.startswith("inv_email_"):
                    inv_id = clicked.replace("inv_email_", "")
                    return await _send_invoice_email_by_id(chat_id, inv_id)

            # ═══════════════════════════════════════════════════════
            # ── LEAD CALLBACKS (unchanged) ─────────────────────────
            # ═══════════════════════════════════════════════════════
            if convo_type == "lead":
                if clicked.startswith("service_"):
                    data["service"] = clicked.replace("service_", "")
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "quotation_amount", "data": data}}
                    )
                    await send_message(chat_id, "💰 Enter Quotation Amount (or SKIP):")
                    return {"status": "service_selected"}

                if clicked.startswith("source_"):
                    data["source"] = clicked.replace("source_", "")
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "next_follow_up", "data": data}}
                    )
                    await send_message(chat_id, "📅 Enter Next Follow-up Date (YYYY-MM-DD) or SKIP:")
                    return {"status": "source_selected"}

                if clicked.startswith("lead_assign_"):
                    assignee_id   = clicked.replace("lead_assign_", "")
                    data["assigned_to"] = None if assignee_id == "unassigned" else assignee_id
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "next_follow_up", "data": data}}
                    )
                    await send_message(chat_id, "📅 Enter Next Follow-up Date (YYYY-MM-DD) or SKIP:")
                    return {"status": "lead_assignee_selected"}

            # ═══════════════════════════════════════════════════════
            # ── QUOTATION CALLBACKS (unchanged) ────────────────────
            # ═══════════════════════════════════════════════════════
            if convo_type == "quotation":
                if clicked.startswith("qservice_"):
                    data["service"] = clicked.replace("qservice_", "").upper()
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "scope_of_work", "data": data}}
                    )
                    await send_message(chat_id, "📋 Enter Scope of Work (comma separated):")
                    return {"status": "service_selected"}

            # ═══════════════════════════════════════════════════════
            # ── TASK CALLBACKS (unchanged) ─────────────────────────
            # ═══════════════════════════════════════════════════════
            if clicked.startswith("dept_"):
                data["category"] = clicked.replace("dept_", "")
                clients = await db.clients.find({}, {"_id": 0}).to_list(50)
                buttons = [{"text": c["company_name"], "callback": f"client_{c['id']}"} for c in clients]
                buttons.append({"text": "No Client", "callback": "client_none"})
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "client", "data": data}}
                )
                await send_message(chat_id, "🏢 Select Client:", inline_keyboard(buttons))
                return {"status": "department_selected"}

            if clicked.startswith("client_"):
                client = clicked.replace("client_", "")
                data["client_id"] = None if client == "none" else client
                users   = await db.users.find({}, {"_id": 0}).to_list(50)
                buttons = [{"text": u["full_name"], "callback": f"assign_{u['id']}"} for u in users]
                buttons.append({"text": "Unassigned", "callback": "assign_unassigned"})
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "assignee", "data": data}}
                )
                await send_message(chat_id, "👤 Select Assignee:", inline_keyboard(buttons))
                return {"status": "client_selected"}

            if clicked.startswith("assign_"):
                assignee = clicked.replace("assign_", "")
                data["assigned_to"]   = None if assignee == "unassigned" else assignee
                data["sub_assignees"] = []
                users   = await db.users.find({}, {"_id": 0}).to_list(50)
                buttons = [
                    {"text": u["full_name"], "callback": f"sub_{u['id']}"}
                    for u in users if u["id"] != data["assigned_to"]
                ]
                buttons.append({"text": "Done ✅", "callback": "sub_done"})
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "sub_assignees", "data": data}}
                )
                await send_message(chat_id, "Select Sub-Assignees:", inline_keyboard(buttons))
                return {"status": "assignee_selected"}

            if clicked.startswith("sub_"):
                uid = clicked.replace("sub_", "")
                if uid == "done":
                    await db.telegram_conversations.update_one(
                        {"telegram_id": chat_id},
                        {"$set": {"step": "priority", "data": data}}
                    )
                    await send_message(chat_id, "⚡ Select Priority:", inline_keyboard([
                        {"text": "Low",      "callback": "priority_low"},
                        {"text": "Medium",   "callback": "priority_medium"},
                        {"text": "High",     "callback": "priority_high"},
                        {"text": "Critical", "callback": "priority_critical"},
                    ]))
                    return {"status": "sub_done"}
                if uid not in data.get("sub_assignees", []):
                    data.setdefault("sub_assignees", []).append(uid)
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id}, {"$set": {"data": data}}
                )
                return {"status": "sub_added"}

            if clicked.startswith("priority_"):
                data["priority"] = clicked.replace("priority_", "")
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "confirm", "data": data}}
                )
                await send_message(chat_id, "✅ Ready to create task?",
                    inline_keyboard([{"text": "✅ Confirm Task", "callback": "confirm_task"}]))
                return {"status": "priority_selected"}

            if clicked.startswith("status_"):
                data["status"] = clicked.replace("status_", "")
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "recurring", "data": data}}
                )
                await send_message(chat_id, "🔁 Is this recurring?", inline_keyboard([
                    {"text": "Yes", "callback": "rec_yes"},
                    {"text": "No",  "callback": "rec_no"},
                ]))
                return {"status": "status_selected"}

            if clicked == "rec_yes":
                data["is_recurring"] = True
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "pattern", "data": data}}
                )
                await send_message(chat_id, "Repeat Pattern:", inline_keyboard([
                    {"text": "Daily",   "callback": "pattern_daily"},
                    {"text": "Weekly",  "callback": "pattern_weekly"},
                    {"text": "Monthly", "callback": "pattern_monthly"},
                    {"text": "Yearly",  "callback": "pattern_yearly"},
                ]))
                return {"status": "recurring_yes"}

            if clicked == "rec_no":
                data["is_recurring"] = False
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "due_date", "data": data}}
                )
                await send_message(chat_id, "📅 Enter Due Date (YYYY-MM-DD):")
                return {"status": "recurring_no"}

            if clicked.startswith("pattern_"):
                data["recurrence_pattern"] = clicked.replace("pattern_", "")
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "interval", "data": data}}
                )
                await send_message(chat_id, "Enter recurrence interval (number):")
                return {"status": "pattern_selected"}

            # ── Confirm lead ──────────────────────────────────────
            if clicked == "confirm_lead":
                try:
                    user = await db.users.find_one({"telegram_id": chat_id})
                    now  = datetime.now(timezone.utc)
                    follow_up = None
                    if data.get("next_follow_up"):
                        try:
                            follow_up = datetime.fromisoformat(data["next_follow_up"])
                        except Exception:
                            follow_up = None
                    new_lead = {
                        "company_name":     data.get("company_name"),
                        "contact_name":     data.get("contact_person"),
                        "email":            data.get("email"),
                        "phone":            data.get("phone"),
                        "services":         [data["service"]] if data.get("service") else [],
                        "quotation_amount": float(data.get("quotation_amount") or 0) if data.get("quotation_amount") else None,
                        "status":           "new",
                        "source":           data.get("source"),
                        "next_follow_up":   follow_up,
                        "notes":            data.get("notes"),
                        "assigned_to":      data.get("assigned_to") or None,
                        "created_by":       user["id"] if user else "telegram_bot",
                        "created_at":       now,
                        "updated_at":       now,
                    }
                    await db.leads.insert_one(new_lead)
                    if new_lead.get("assigned_to"):
                        await create_notification(
                            user_id=new_lead["assigned_to"],
                            title="New Lead Assigned",
                            message=f"Lead '{new_lead['company_name']}' assigned to you",
                            type="lead"
                        )
                    await db.telegram_conversations.delete_one({"telegram_id": chat_id})
                    await send_message(chat_id, f"✅ Lead *{new_lead['company_name']}* created!")
                    return {"status": "lead_created"}
                except Exception as e:
                    await send_message(chat_id, f"❌ Error: {e}")
                    return {"status": "error"}

            # ── Confirm task ──────────────────────────────────────
            if clicked == "confirm_task":
                try:
                    now  = datetime.now(timezone.utc)
                    user = await db.users.find_one({"telegram_id": chat_id})
                    if not user:
                        await send_message(chat_id, "User not found.")
                        return {"status": "user_not_found"}
                    new_task = {
                        "id":                  str(uuid.uuid4()),
                        "title":               data.get("title"),
                        "description":         data.get("description"),
                        "assigned_to":         data.get("assigned_to") or None,
                        "sub_assignees":       data.get("sub_assignees", []),
                        "priority":            data.get("priority", "medium"),
                        "status":              data.get("status", "pending"),
                        "category":            data.get("category"),
                        "client_id":           data.get("client_id"),
                        "is_recurring":        data.get("is_recurring", False),
                        "recurrence_pattern":  data.get("recurrence_pattern"),
                        "recurrence_interval": data.get("recurrence_interval", 1),
                        "created_by":          user["id"],
                        "created_at":          now,
                        "updated_at":          now,
                        "due_date":            data.get("due_date"),
                        "type":                "task",
                    }
                    await db.tasks.insert_one(new_task)
                    await db.telegram_conversations.delete_many({"telegram_id": chat_id})
                    if new_task.get("assigned_to"):
                        await create_notification(
                            user_id=new_task["assigned_to"],
                            title="New Task Assigned",
                            message=f"Task '{new_task['title']}' assigned via Telegram",
                            type="assignment"
                        )
                    await send_message(chat_id, "✅ Task Created Successfully!")
                    return {"status": "task_created"}
                except Exception as e:
                    await send_message(chat_id, f"❌ Error creating task: {e}")
                    return {"status": "error"}

            # ── Confirm quotation ─────────────────────────────────
            if clicked == "confirm_quotation":
                try:
                    if not DEFAULT_COMPANY_ID:
                        await send_message(chat_id, "❌ DEFAULT_COMPANY_ID not configured.")
                        return {"status": "config_error"}
                    quotation_payload = {
                        "company_id":    DEFAULT_COMPANY_ID,
                        "client_name":   data.get("client_name"),
                        "client_phone":  data.get("client_phone"),
                        "client_email":  data.get("client_email"),
                        "service":       data.get("service"),
                        "scope_of_work": data.get("scope_of_work", []),
                        "items": [{
                            "description": data.get("service"),
                            "quantity":    1,
                            "unit_price":  float(data.get("amount") or 0),
                            "amount":      float(data.get("amount") or 0),
                        }],
                        "gst_rate":      float(data.get("gst_rate") or 18),
                        "payment_terms": data.get("payment_terms"),
                        "timeline":      data.get("timeline"),
                    }
                    async with httpx.AsyncClient() as client:
                        r = await client.post(f"{BACKEND_URL}/quotations", json=quotation_payload, timeout=30.0)
                        r.raise_for_status()
                        q_data = r.json()
                        q_id   = q_data.get("id") or q_data.get("_id")
                    async with httpx.AsyncClient() as client:
                        pdf_r = await client.get(f"{BACKEND_URL}/quotations/{q_id}/pdf", timeout=30.0)
                        pdf_r.raise_for_status()
                        pdf_bytes = pdf_r.content
                    await send_document(chat_id, pdf_bytes, f"Quotation_{q_id[:8]}.pdf")
                    await db.telegram_conversations.delete_one({"telegram_id": chat_id})
                    await send_message(chat_id, f"✅ Quotation created!\nID: `{q_id}`\n📄 PDF sent above.")
                    return {"status": "quotation_created"}
                except Exception as e:
                    await send_message(chat_id, f"❌ Error: {e}")
                    return {"status": "error"}

            return {"status": "unknown_callback"}

        # ═══════════════════════════════════════════════════════════
        # TEXT MESSAGE HANDLER
        # ═══════════════════════════════════════════════════════════
        if "message" not in payload:
            return {"status": "ignored"}

        message = payload["message"]
        chat_id = message["chat"]["id"]
        text    = message.get("text", "").strip()

        # ── Help ──────────────────────────────────────────────────
        if text.lower() in ["/help", "/h"]:
            await send_message(chat_id,
                "🤖 *Available Commands*\n\n"
                "📄 *Invoicing*\n"
                "• `/inv`  → Create new GST invoice\n"
                "• `/invlist` → List recent invoices\n"
                "• `/invpdf INV-0001` → Get PDF of invoice\n"
                "• `/invemail INV-0001` → Email invoice to client\n\n"
                "📋 *Tasks & CRM*\n"
                "• `/ld`   → New Lead\n"
                "• `/ts`   → New Task\n"
                "• `/qo`   → New Quotation (PDF)\n"
                "• `/mt`   → My Tasks\n"
                "• `/cl`   → Cancel current action\n"
                "• `/help` → This menu"
            )
            return {"status": "help"}

        # ── Lead ──────────────────────────────────────────────────
        if text.lower() in ["/ld", "/lead"]:
            user = await db.users.find_one({"telegram_id": chat_id})
            if not (user and (user.get("role") == "admin" or user.get("permissions", {}).get("can_view_all_leads"))):
                await send_message(chat_id, "🚫 You do not have permission to add leads.")
                return {"status": "unauthorized"}
            await db.telegram_conversations.update_one(
                {"telegram_id": chat_id},
                {"$set": {"step": "company_name", "type": "lead", "data": {}}},
                upsert=True
            )
            await send_message(chat_id, "🏢 Enter Company Name:")
            return {"status": "lead_started"}

        # ── Task ──────────────────────────────────────────────────
        if text.lower() in ["/ts", "/task", "/start"]:
            await db.telegram_conversations.update_one(
                {"telegram_id": chat_id},
                {"$set": {"step": "title", "type": "task", "data": {}}},
                upsert=True
            )
            await send_message(chat_id, "📝 Enter Task Title:")
            return {"status": "task_started"}

        # ── Quotation ─────────────────────────────────────────────
        if text.lower() in ["/qo", "/quotation"]:
            await db.telegram_conversations.update_one(
                {"telegram_id": chat_id},
                {"$set": {"step": "client_name", "type": "quotation", "data": {}}},
                upsert=True
            )
            await send_message(chat_id, "👤 Enter Client Name:")
            return {"status": "quotation_started"}

        # ── Cancel ────────────────────────────────────────────────
        if text.lower() in ["/cl", "/cancel"]:
            await db.telegram_conversations.delete_many({"telegram_id": chat_id})
            await send_message(chat_id, "👍 No problem — I cancelled that for you.")
            return {"status": "cancelled"}

        # ── My Tasks ──────────────────────────────────────────────
        if text.lower() in ["/mt", "/mytasks"]:
            user = await db.users.find_one({"telegram_id": chat_id})
            if not user:
                await send_message(chat_id, "❌ Your Telegram is not linked to a user account.")
                return {"status": "no_user"}
            tasks = await db.tasks.find(
                {"$or": [
                    {"created_by": user["id"]},
                    {"assigned_to": user["id"]},
                    {"sub_assignees": user["id"]}
                ]}, {"_id": 0}
            ).to_list(20)
            if not tasks:
                await send_message(chat_id, "No tasks found.")
                return {"status": "no_tasks"}
            for task in tasks:
                await send_message(
                    chat_id,
                    f"📋 *{task['title']}*\n📅 Due: {task.get('due_date','—')}",
                    inline_keyboard([{"text": "🗑 Delete", "callback": f"delete_{task['id']}"}])
                )
            return {"status": "tasks_listed"}

        # ════════════════════════════════════════════════════════
        # ── INVOICE COMMANDS ────────────────────────────────────
        # ════════════════════════════════════════════════════════

        # /inv — start invoice creation
        if text.lower() in ["/inv", "/invoice"]:
            companies = await db.companies.find({}, {"_id": 0}).to_list(20)
            if not companies:
                await send_message(
                    chat_id,
                    "❌ No company profiles found. Create one in the web app first."
                )
                return {"status": "no_companies"}
            await db.telegram_conversations.update_one(
                {"telegram_id": chat_id},
                {"$set": {"step": "inv_company", "type": "invoice", "data": {"items": [], "current_item": {}}}},
                upsert=True
            )
            await send_message(
                chat_id,
                "🧾 *Create Invoice* — I'll guide you through every field.\n\n"
                "🏢 *Step 1:* Select your Company Profile:",
                inline_keyboard([
                    {"text": c["name"][:40], "callback": f"invc_company_{c['id']}"}
                    for c in companies
                ])
            )
            return {"status": "inv_started"}

        # /invlist — list recent invoices
        if text.lower() in ["/invlist", "/invoicelist"]:
            return await _cmd_invlist(chat_id)

        # /invpdf [invoice_no] — get PDF
        if text.lower().startswith("/invpdf"):
            parts   = text.split(maxsplit=1)
            inv_no  = parts[1].strip() if len(parts) > 1 else ""
            if inv_no:
                inv = await db.invoices.find_one(
                    {"invoice_no": {"$regex": re.escape(inv_no), "$options": "i"}}, {"_id": 0}
                )
                if inv:
                    return await _send_invoice_pdf_by_id(chat_id, inv["id"])
                else:
                    await send_message(chat_id, f"❌ No invoice found matching `{inv_no}`.")
                    return {"status": "not_found"}
            else:
                return await _cmd_invlist(chat_id, action="pdf")

        # /invemail [invoice_no] — email invoice
        if text.lower().startswith("/invemail"):
            parts  = text.split(maxsplit=1)
            inv_no = parts[1].strip() if len(parts) > 1 else ""
            if inv_no:
                inv = await db.invoices.find_one(
                    {"invoice_no": {"$regex": re.escape(inv_no), "$options": "i"}}, {"_id": 0}
                )
                if inv:
                    return await _send_invoice_email_by_id(chat_id, inv["id"])
                else:
                    await send_message(chat_id, f"❌ No invoice found matching `{inv_no}`.")
                    return {"status": "not_found"}
            else:
                return await _cmd_invlist(chat_id, action="email")

        # ═══════════════════════════════════════════════════════════
        # NATURAL-LANGUAGE COMMANDS / REPORTS (ADDITIVE)
        # This runs before Lead AI so requests such as “share pending tasks”
        # are treated as commands rather than being misclassified as leads.
        # Existing active wizards return False and continue unchanged.
        # ═══════════════════════════════════════════════════════════
        if await _tg_natural_language_handler(chat_id, text, message):
            return {"status": "natural_language_handled"}

        # ═══════════════════════════════════════════════════════════
        # AI NATURAL-LANGUAGE LEAD CAPTURE (ADDITIVE)
        # Existing Telegram Q&A/commands/conversation flows remain unchanged.
        # Only messages that are not an active conversation/known command
        # reach this detector.
        # ═══════════════════════════════════════════════════════════
        try:
            sender_id = str(message.get("from", {}).get("id", ""))
            sender_name = (
                message.get("from", {}).get("first_name", "")
                + (
                    " " + message.get("from", {}).get("last_name", "")
                    if message.get("from", {}).get("last_name")
                    else ""
                )
            ).strip() or None

            # Keep compatibility with older lead_ai.py deployments that still
            # expose process_lead_message(message) without channel metadata.
            try:
                lead_result = await process_lead_message(
                    text,
                    source="telegram",
                    source_chat_id=str(chat_id),
                    source_sender_id=sender_id,
                    source_sender_name=sender_name,
                )
            except TypeError as compatibility_error:
                if "unexpected keyword" not in str(compatibility_error).lower():
                    raise
                print(
                    "[Telegram Lead AI] Retrying with legacy "
                    "process_lead_message(message) signature."
                )
                lead_result = await process_lead_message(text)

            print(
                "[Telegram Lead AI] Detection result:",
                {
                    "is_lead": bool(lead_result and lead_result.get("is_lead")),
                    "confidence": lead_result.get("confidence") if lead_result else None,
                    "source": lead_result.get("source") if lead_result else None,
                },
            )

            if lead_result and lead_result.get("is_lead"):
                user = await db.users.find_one({"telegram_id": chat_id})

                if not (
                    user
                    and (
                        user.get("role") == "admin"
                        or user.get("permissions", {}).get("can_view_all_leads")
                    )
                ):
                    await send_message(chat_id, "🚫 You do not have permission to add leads.")
                    return {"status": "lead_unauthorized"}

                lead = lead_result.get("lead", lead_result)
                lead_id = str(uuid.uuid4())
                now = datetime.now(timezone.utc)

                contact_name = lead.get("contact_name") or lead.get("lead_from")
                company_name = lead.get("company_name")
                phone = lead.get("phone") or lead.get("mobile")
                email = lead.get("email")

                services = lead.get("services") or lead.get("requirements") or []
                if isinstance(services, str):
                    services = [s.strip() for s in services.split(",") if s.strip()]

                duplicate = None
                if phone:
                    duplicate = await db.leads.find_one({"phone": phone}, {"_id": 0})
                if not duplicate and contact_name:
                    duplicate_query = {
                        "contact_name": contact_name,
                        "status": {"$ne": "closed"},
                    }
                    if company_name:
                        duplicate_query["company_name"] = company_name
                    duplicate = await db.leads.find_one(duplicate_query, {"_id": 0})

                if duplicate:
                    await send_message(
                        chat_id,
                        f"ℹ️ Lead already exists for *{contact_name or company_name or 'this contact'}*."
                    )
                    return {"status": "lead_duplicate", "lead_id": duplicate.get("id")}

                new_lead = {
                    "id": lead_id,
                    "company_name": company_name,
                    "contact_name": contact_name,
                    "email": email,
                    "phone": phone,
                    "services": services,
                    "quotation_amount": lead.get("quotation_amount"),
                    "status": "new",
                    "source": "telegram",
                    "next_follow_up": lead.get("next_follow_up"),
                    "notes": lead.get("notes"),
                    "assigned_to": None,
                    "created_by": user["id"] if user else "telegram_bot",
                    "created_at": now,
                    "updated_at": now,
                    "trademark_name": lead.get("trademark_name"),
                    "company_name_requested": lead.get("company_name_requested"),
                    "whatsapp_group_jid": None,
                    "whatsapp_group_name": None,
                    "whatsapp_message_id": None,
                    "whatsapp_sender_phone": None,
                    "whatsapp_sender_name": None,
                    "whatsapp_original_message": None,
                    "telegram_chat_id": str(chat_id),
                    "telegram_sender_id": str(message.get("from", {}).get("id", "")),
                    "telegram_sender_name": (
                        message.get("from", {}).get("first_name", "")
                        + (
                            " " + message.get("from", {}).get("last_name", "")
                            if message.get("from", {}).get("last_name")
                            else ""
                        )
                    ).strip() or None,
                    "telegram_original_message": text,
                    "ai_captured": True,
                    "ai_confidence": lead_result.get("confidence"),
                }

                await db.leads.insert_one(new_lead)

                await send_message(
                    chat_id,
                    _tg_human_lead_created({
                        "contact_name": contact_name,
                        "company_name": company_name,
                        "services": services,
                        "phone": phone,
                        "email": email,
                    }),
                )
                return {"status": "lead_created", "lead_id": lead_id}

        except Exception as lead_ai_error:
            # Do not silently fall through to the Welcome message when lead AI
            # fails. Existing Telegram commands/conversations remain unaffected.
            import traceback
            traceback.print_exc()
            print(f"[Telegram Lead AI] Error: {lead_ai_error}")
            await send_message(
                chat_id,
                "⚠️ I received your message, but the lead reader could not "
                "process it right now.\n\n"
                "Please check the Lead AI configuration/API settings in the "
                "backend logs."
            )
            return {
                "status": "lead_ai_error",
                "detail": str(lead_ai_error),
            }

        # ── Load existing conversation ────────────────────────────
        convo = await db.telegram_conversations.find_one({"telegram_id": chat_id})
        if not convo:
            await send_message(
                chat_id,
                "👋 *Hi! I’m your Taskosphere assistant.*\n\n"
                "📄 *Invoicing:* `/inv` · `/invlist` · `/invpdf` · `/invemail`\n"
                "📋 *CRM / Tasks:* `/ld` · `/ts` · `/qo` · `/mt`\n"
                "❌ Cancel: `/cl`  |  Help: `/help`"
            )
            return {"status": "welcome"}

        step       = convo.get("step")
        data       = convo.get("data", {})
        convo_type = convo.get("type", "task")

        # ════════════════════════════════════════════════════════
        # ── INVOICE FLOW STEPS ──────────────────────────────────
        # ════════════════════════════════════════════════════════
        if convo_type == "invoice":
            # Client name (manual entry)
            if step == "inv_client_name":
                data["client_name"] = text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_client_email", "data": data}}
                )
                await send_message(chat_id, "📧 Enter *Client Email* (or SKIP):")
                return {"status": "inv_client_name_saved"}

            if step == "inv_client_email":
                data["client_email"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_client_phone", "data": data}}
                )
                await send_message(chat_id, "📞 Enter *Client Phone* (or SKIP):")
                return {"status": "inv_client_email_saved"}

            if step == "inv_client_phone":
                data["client_phone"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_client_gstin", "data": data}}
                )
                await send_message(chat_id, "🏷 Enter *Client GSTIN* (15 chars) or SKIP:")
                return {"status": "inv_client_phone_saved"}

            if step == "inv_client_gstin":
                data["client_gstin"] = "" if text.lower() == "skip" else text.upper()
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_client_address", "data": data}}
                )
                await send_message(chat_id, "📍 Enter *Billing Address* (or SKIP):")
                return {"status": "inv_client_gstin_saved"}

            if step == "inv_client_address":
                data["client_address"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_client_state", "data": data}}
                )
                await send_message(chat_id, "📌 Enter *Client State* (e.g. Gujarat) or SKIP:")
                return {"status": "inv_client_address_saved"}

            if step == "inv_client_state":
                data["client_state"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_supply_state", "data": data}}
                )
                await send_message(
                    chat_id,
                    "🏛 Enter *your supply state* (e.g. Gujarat) or SKIP.\n"
                    "_Used to determine IGST (interstate) vs CGST+SGST (intrastate)._"
                )
                return {"status": "inv_client_state_saved"}

            if step == "inv_supply_state":
                supply_state = "" if text.lower() == "skip" else text
                data["supply_state"]  = supply_state
                # Auto-detect interstate
                cs = (data.get("client_state") or "").strip().lower()
                ss = supply_state.strip().lower()
                data["is_interstate"] = bool(cs and ss and cs != ss)
                inter_msg = (
                    "🌐 *Interstate supply detected* — IGST will apply."
                    if data["is_interstate"]
                    else "🏠 *Intrastate supply* — CGST + SGST will apply."
                )
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_date", "data": data}}
                )
                await send_message(
                    chat_id,
                    f"{inter_msg}\n\n"
                    f"📅 Enter *Invoice Date* (YYYY-MM-DD) or SKIP (defaults to today {_today()}):"
                )
                return {"status": "inv_supply_state_saved"}

            if step == "inv_date":
                if text.lower() == "skip" or not text.strip():
                    data["invoice_date"] = _today()
                else:
                    try:
                        datetime.strptime(text.strip(), "%Y-%m-%d")
                        data["invoice_date"] = text.strip()
                    except ValueError:
                        await send_message(chat_id, "❌ Invalid date. Use YYYY-MM-DD or SKIP.")
                        return {"status": "invalid_date"}
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_due_date", "data": data}}
                )
                await send_message(
                    chat_id,
                    f"📆 Enter *Due Date* (YYYY-MM-DD) or SKIP (defaults to +30 days: {_today_plus(30)}):"
                )
                return {"status": "inv_date_saved"}

            if step == "inv_due_date":
                if text.lower() == "skip" or not text.strip():
                    data["due_date"] = _today_plus(30)
                else:
                    try:
                        datetime.strptime(text.strip(), "%Y-%m-%d")
                        data["due_date"] = text.strip()
                    except ValueError:
                        await send_message(chat_id, "❌ Invalid date. Use YYYY-MM-DD or SKIP.")
                        return {"status": "invalid_date"}
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_reference", "data": data}}
                )
                await send_message(chat_id, "🔑 Enter *Reference / PO Number* or SKIP:")
                return {"status": "inv_due_date_saved"}

            if step == "inv_reference":
                data["reference_no"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_payment_terms", "data": data}}
                )
                await send_message(
                    chat_id,
                    "💳 Select *Payment Terms*:",
                    inline_keyboard([
                        {"text": t, "callback": f"invc_terms_{i}"}
                        for i, t in enumerate(PAY_TERMS_TG)
                    ])
                )
                return {"status": "inv_reference_saved"}

            # ── Item entry loop ───────────────────────────────────
            if step == "inv_item_desc":
                data.setdefault("current_item", {})["description"] = text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_item_hsn", "data": data}}
                )
                await send_message(chat_id, "🏷 Enter *HSN / SAC code* (or SKIP):")
                return {"status": "inv_item_desc_saved"}

            if step == "inv_item_hsn":
                data.setdefault("current_item", {})["hsn_sac"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_item_qty", "data": data}}
                )
                await send_message(chat_id, "🔢 Enter *Quantity* (e.g. 1, 2.5):")
                return {"status": "inv_item_hsn_saved"}

            if step == "inv_item_qty":
                try:
                    qty = float(text)
                    if qty <= 0: raise ValueError
                except ValueError:
                    await send_message(chat_id, "❌ Enter a valid positive number.")
                    return {"status": "invalid_qty"}
                data.setdefault("current_item", {})["quantity"] = qty
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_item_unit", "data": data}}
                )
                await send_message(
                    chat_id, "📦 Select *Unit*:",
                    inline_keyboard([
                        {"text": u, "callback": f"invc_unit_{u}"} for u in UNITS_TG
                    ])
                )
                return {"status": "inv_item_qty_saved"}

            if step == "inv_item_price":
                try:
                    price = float(text)
                    if price < 0: raise ValueError
                except ValueError:
                    await send_message(chat_id, "❌ Enter a valid price (e.g. 5000).")
                    return {"status": "invalid_price"}
                data.setdefault("current_item", {})["unit_price"] = price
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_item_disc", "data": data}}
                )
                await send_message(chat_id, "💸 Enter *Discount %* (0–100) or SKIP (0%):")
                return {"status": "inv_item_price_saved"}

            if step == "inv_item_disc":
                disc = 0.0
                if text.lower() != "skip":
                    try:
                        disc = float(text)
                        if not (0 <= disc <= 100): raise ValueError
                    except ValueError:
                        await send_message(chat_id, "❌ Enter a number between 0 and 100, or SKIP.")
                        return {"status": "invalid_disc"}
                data.setdefault("current_item", {})["discount_pct"] = disc
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_item_gst", "data": data}}
                )
                await send_message(
                    chat_id, "📊 Select *GST Rate*:",
                    inline_keyboard([
                        {"text": f"{r}%", "callback": f"invc_gst_{r}"} for r in GST_RATES_TG
                    ])
                )
                return {"status": "inv_item_disc_saved"}

            # ── After items: additional charges ──────────────────
            if step == "inv_extra_disc":
                data["discount_amount"] = 0.0
                if text.lower() != "skip":
                    try:
                        data["discount_amount"] = float(text)
                    except ValueError:
                        await send_message(chat_id, "❌ Enter a valid amount or SKIP.")
                        return {"status": "invalid_amount"}
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_shipping", "data": data}}
                )
                await send_message(chat_id, "🚚 Enter *Shipping Charges* (₹) or SKIP:")
                return {"status": "inv_extra_disc_saved"}

            if step == "inv_shipping":
                data["shipping_charges"] = 0.0
                if text.lower() != "skip":
                    try:
                        data["shipping_charges"] = float(text)
                    except ValueError:
                        await send_message(chat_id, "❌ Enter a valid amount or SKIP.")
                        return {"status": "invalid_amount"}
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_other_charges", "data": data}}
                )
                await send_message(chat_id, "🏷 Enter *Other Charges* (₹) or SKIP:")
                return {"status": "inv_shipping_saved"}

            if step == "inv_other_charges":
                data["other_charges"] = 0.0
                if text.lower() != "skip":
                    try:
                        data["other_charges"] = float(text)
                    except ValueError:
                        await send_message(chat_id, "❌ Enter a valid amount or SKIP.")
                        return {"status": "invalid_amount"}
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_notes", "data": data}}
                )
                await send_message(chat_id, "📝 Enter *Notes* to print on invoice (or SKIP):")
                return {"status": "inv_other_charges_saved"}

            if step == "inv_notes":
                data["notes"] = "" if text.lower() == "skip" else text
                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_terms_conditions", "data": data}}
                )
                await send_message(chat_id, "📜 Enter *Terms & Conditions* (or SKIP):")
                return {"status": "inv_notes_saved"}

            if step == "inv_terms_conditions":
                data["terms_conditions"] = "" if text.lower() == "skip" else text
                # Recompute totals with all items
                inv_for_totals = {
                    "items":            data.get("items", []),
                    "is_interstate":    data.get("is_interstate", False),
                    "discount_amount":  data.get("discount_amount", 0),
                    "shipping_charges": data.get("shipping_charges", 0),
                    "other_charges":    data.get("other_charges", 0),
                }
                try:
                    computed = _compute_invoice_totals(inv_for_totals)
                    data.update({
                        "items":          computed["items"],
                        "subtotal":       computed["subtotal"],
                        "total_discount": computed["total_discount"],
                        "total_taxable":  computed["total_taxable"],
                        "total_cgst":     computed["total_cgst"],
                        "total_sgst":     computed["total_sgst"],
                        "total_igst":     computed["total_igst"],
                        "total_gst":      computed["total_gst"],
                        "grand_total":    computed["grand_total"],
                    })
                except Exception as e:
                    await send_message(chat_id, f"❌ Calculation error: {e}")
                    return {"status": "calc_error"}

                await db.telegram_conversations.update_one(
                    {"telegram_id": chat_id},
                    {"$set": {"step": "inv_confirm", "data": data}}
                )
                summary = _build_invoice_summary(data)
                await send_message(
                    chat_id, summary,
                    inline_keyboard([
                        {"text": "✅ Confirm & Create Invoice",  "callback": "confirm_invoice"},
                        {"text": "❌ Cancel",                     "callback": "cancel_convo"},
                    ], include_cancel=False)
                )
                return {"status": "inv_confirm_shown"}

            return {"status": "inv_unknown_step"}

        # ═══════════════════════════════════════════════════════════
        # ── LEAD FLOW (unchanged) ──────────────────────────────────
        # ═══════════════════════════════════════════════════════════
        if convo_type == "lead":
            if step == "company_name":
                data["company_name"] = text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "contact_person", "data": data}})
                await send_message(chat_id, "👤 Enter Contact Person (or SKIP):")
                return {"status": "company_name_saved"}
            if step == "contact_person":
                data["contact_person"] = None if text.lower() == "skip" else text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "phone", "data": data}})
                await send_message(chat_id, "📞 Enter Phone (or SKIP):")
                return {"status": "contact_person_saved"}
            if step == "phone":
                data["phone"] = None if text.lower() == "skip" else text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "email", "data": data}})
                await send_message(chat_id, "✉️ Enter Email (or SKIP):")
                return {"status": "phone_saved"}
            if step == "email":
                data["email"] = None if text.lower() == "skip" else text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "service", "data": data}})
                await send_message(chat_id, "📂 Select Service:", inline_keyboard([
                    {"text": s, "callback": f"service_{s.lower()}"} for s in ["GST", "IT", "ACC", "TDS", "ROC", "DSC", "FEMA", "MSME", "TM", "OTHER"]
                ]))
                return {"status": "email_saved"}
            if step == "quotation_amount":
                data["quotation_amount"] = None if text.lower() == "skip" else _safe_float(text) or None
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "source", "data": data}})
                await send_message(chat_id, "🌐 Select Source:", inline_keyboard([
                    {"text": s, "callback": f"source_{s.lower().replace(' ', '_')}"} for s in ["Direct", "Website", "Referral", "Social Media", "Event"]
                ]))
                return {"status": "quotation_amount_saved"}
            if step == "next_follow_up":
                if text.lower() != "skip":
                    try:
                        dt = datetime.fromisoformat(text) if "T" in text else datetime.fromisoformat(text + "T00:00:00")
                        data["next_follow_up"] = dt.isoformat()
                    except Exception:
                        await send_message(chat_id, "Invalid date. Use YYYY-MM-DD or SKIP.")
                        return {"status": "invalid_date"}
                else:
                    data["next_follow_up"] = None
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "notes", "data": data}})
                await send_message(chat_id, "📝 Enter Notes (or SKIP):")
                return {"status": "next_follow_up_saved"}
            if step == "notes":
                data["notes"] = None if text.lower() == "skip" else text
                summary = (
                    f"✅ *Confirm Lead*\n\n"
                    f"🏢 {data.get('company_name')}\n"
                    f"👤 {data.get('contact_person') or '—'}\n"
                    f"📞 {data.get('phone') or '—'}\n"
                    f"✉️ {data.get('email') or '—'}\n"
                    f"📂 {data.get('service') or '—'}\n"
                    f"💰 {data.get('quotation_amount') or '—'}\n"
                    f"🌐 {data.get('source') or '—'}\n"
                    f"📅 Follow-up: {data.get('next_follow_up') or '—'}\n"
                    f"📝 {data.get('notes') or '—'}"
                )
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "confirm", "data": data}})
                await send_message(chat_id, summary, inline_keyboard([{"text": "✅ Confirm Lead", "callback": "confirm_lead"}]))
                return {"status": "notes_saved"}

        # ═══════════════════════════════════════════════════════════
        # ── TASK FLOW (unchanged) ──────────────────────────────────
        # ═══════════════════════════════════════════════════════════
        if convo_type == "task":
            if step == "title":
                data["title"] = text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "description", "data": data}})
                await send_message(chat_id, "📝 Enter Description (or SKIP):")
                return {"status": "title_saved"}
            if step == "description":
                data["description"] = None if text.lower() == "skip" else text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "department", "data": data}})
                await send_message(chat_id, "📂 Select Department:", inline_keyboard([
                    {"text": d["label"], "callback": f"dept_{d['value']}"} for d in DEPARTMENTS
                ]))
                return {"status": "description_saved"}
            if step == "due_date":
                try:
                    due = datetime.fromisoformat(text) if "T" in text else datetime.fromisoformat(text + "T00:00:00")
                    data["due_date"] = due.isoformat()
                except Exception:
                    await send_message(chat_id, "Invalid format. Use YYYY-MM-DD")
                    return {"status": "invalid_date"}
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "priority", "data": data}})
                await send_message(chat_id, "⚡ Select Priority:", inline_keyboard([
                    {"text": "Low",      "callback": "priority_low"},
                    {"text": "Medium",   "callback": "priority_medium"},
                    {"text": "High",     "callback": "priority_high"},
                    {"text": "Critical", "callback": "priority_critical"},
                ]))
                return {"status": "due_date_saved"}

        # ═══════════════════════════════════════════════════════════
        # ── QUOTATION FLOW (unchanged) ─────────────────────────────
        # ═══════════════════════════════════════════════════════════
        if convo_type == "quotation":
            if step == "client_name":
                data["client_name"] = text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "client_phone", "data": data}})
                await send_message(chat_id, "📞 Enter Client Phone (or SKIP):")
                return {"status": "client_name_saved"}
            if step == "client_phone":
                data["client_phone"] = None if text.lower() == "skip" else text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "client_email", "data": data}})
                await send_message(chat_id, "✉️ Enter Client Email (or SKIP):")
                return {"status": "client_phone_saved"}
            if step == "client_email":
                data["client_email"] = None if text.lower() == "skip" else text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "service", "data": data}})
                await send_message(chat_id, "📂 Select Service:", inline_keyboard([
                    {"text": s, "callback": f"qservice_{s.lower()}"} for s in ["GST", "IT", "ACC", "TDS", "ROC", "DSC", "FEMA", "MSME", "TM", "OTHER"]
                ]))
                return {"status": "client_email_saved"}
            if step == "scope_of_work":
                data["scope_of_work"] = [s.strip() for s in text.split(",") if s.strip()]
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "amount", "data": data}})
                await send_message(chat_id, "💰 Enter Total Amount (₹):")
                return {"status": "scope_saved"}
            if step == "amount":
                try:
                    data["amount"] = float(text)
                except ValueError:
                    await send_message(chat_id, "Please enter a valid number.")
                    return {"status": "invalid_amount"}
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "gst_rate", "data": data}})
                await send_message(chat_id, "📊 Enter GST Rate % (or SKIP for 18):")
                return {"status": "amount_saved"}
            if step == "gst_rate":
                data["gst_rate"] = float(text) if text.lower() != "skip" else 18.0
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "payment_terms", "data": data}})
                await send_message(chat_id, "💵 Enter Payment Terms:")
                return {"status": "gst_saved"}
            if step == "payment_terms":
                data["payment_terms"] = text
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "timeline", "data": data}})
                await send_message(chat_id, "⏱️ Enter Timeline:")
                return {"status": "payment_terms_saved"}
            if step == "timeline":
                data["timeline"] = text
                summary = (
                    f"✅ *Confirm Quotation*\n\n"
                    f"👤 {data.get('client_name')}\n"
                    f"📞 {data.get('client_phone') or '—'}\n"
                    f"✉️ {data.get('client_email') or '—'}\n"
                    f"📂 {data.get('service')}\n"
                    f"📋 {', '.join(data.get('scope_of_work', []))}\n"
                    f"💰 ₹{data.get('amount')}\n"
                    f"📊 GST {data.get('gst_rate')}%\n"
                    f"💵 {data.get('payment_terms')}\n"
                    f"⏱️ {data.get('timeline')}"
                )
                await db.telegram_conversations.update_one({"telegram_id": chat_id}, {"$set": {"step": "confirm", "data": data}})
                await send_message(chat_id, summary, inline_keyboard([{"text": "✅ Confirm & Generate PDF", "callback": "confirm_quotation"}]))
                return {"status": "timeline_saved"}

        return {"status": "unknown_step"}

    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            if "chat_id" in locals():
                await send_message(chat_id, "❌ An unexpected error occurred. Please try again.")
        except Exception:
            pass
        return {"status": "error", "detail": str(e)}


# ═══════════════════════════════════════════════════════════
# INVOICE HELPER COROUTINES
# (called from both callback and text handlers)
# ═══════════════════════════════════════════════════════════

async def _handle_confirm_invoice(chat_id: int, data: dict) -> dict:
    """Create invoice in DB, generate PDF, send it via Telegram."""
    try:
        now       = datetime.now(timezone.utc).isoformat()
        user      = await db.users.find_one({"telegram_id": chat_id})
        created_by = user["id"] if user else "telegram_bot"

        company_id = data.get("company_id") or DEFAULT_COMPANY_ID
        if not company_id:
            await send_message(chat_id, "❌ No company ID available. Set DEFAULT_COMPANY_ID or select a company.")
            return {"status": "no_company"}

        # Generate invoice number
        inv_type   = data.get("invoice_type", "tax_invoice")
        prefix_map = {"proforma": "PRO", "estimate": "EST", "credit_note": "CN", "debit_note": "DN"}
        prefix     = prefix_map.get(inv_type, "INV")
        inv_no     = await _next_invoice_no(prefix, company_id)

        grand_total = _safe_float(data.get("grand_total"))

        invoice_doc = {
            "id":                 str(uuid.uuid4()),
            "invoice_no":         inv_no,
            "invoice_type":       inv_type,
            "company_id":         company_id,
            "client_id":          data.get("client_id"),
            "client_name":        data.get("client_name", ""),
            "client_email":       data.get("client_email", ""),
            "client_phone":       data.get("client_phone", ""),
            "client_gstin":       data.get("client_gstin", ""),
            "client_address":     data.get("client_address", ""),
            "client_state":       data.get("client_state", ""),
            "supply_state":       data.get("supply_state", ""),
            "is_interstate":      data.get("is_interstate", False),
            "invoice_date":       data.get("invoice_date", _today()),
            "due_date":           data.get("due_date", _today_plus(30)),
            "reference_no":       data.get("reference_no", ""),
            "payment_terms":      data.get("payment_terms", "Due on receipt"),
            "notes":              data.get("notes", ""),
            "terms_conditions":   data.get("terms_conditions", ""),
            "items":              data.get("items", []),
            "subtotal":           _safe_float(data.get("subtotal")),
            "total_discount":     _safe_float(data.get("total_discount")),
            "total_taxable":      _safe_float(data.get("total_taxable")),
            "total_cgst":         _safe_float(data.get("total_cgst")),
            "total_sgst":         _safe_float(data.get("total_sgst")),
            "total_igst":         _safe_float(data.get("total_igst")),
            "total_gst":          _safe_float(data.get("total_gst")),
            "grand_total":        grand_total,
            "discount_amount":    _safe_float(data.get("discount_amount")),
            "shipping_charges":   _safe_float(data.get("shipping_charges")),
            "other_charges":      _safe_float(data.get("other_charges")),
            "amount_paid":        0.0,
            "amount_due":         grand_total,
            "status":             "draft",
            "is_recurring":       False,
            "recurrence_pattern": "monthly",
            "recurrence_end":     None,
            "next_invoice_date":  None,
            "invoice_template":   "prestige",
            "invoice_theme":      "classic_blue",
            "invoice_custom_color": "#0D3B66",
            "pdf_drive_link":     "",
            "created_by":         created_by,
            "created_at":         now,
            "updated_at":         now,
        }

        await db.invoices.insert_one(invoice_doc)
        invoice_doc.pop("_id", None)

        # Notify the user in the web app
        if user:
            await create_notification(
                user_id=user["id"],
                title="Invoice Created via Telegram",
                message=f"Invoice {inv_no} for {data.get('client_name','')} ({_fmt_inr(grand_total)}) created via bot.",
                type="invoice"
            )

        # Generate PDF using the same engine as the web app
        company = await db.companies.find_one({"id": company_id}, {"_id": 0}) or {}
        try:
            pdf_buf   = _build_invoice_pdf(invoice_doc, company)
            pdf_bytes = pdf_buf.getvalue()
        except Exception as pdf_err:
            await send_message(
                chat_id,
                f"✅ Invoice *{inv_no}* created!\n"
                f"💎 Total: {_fmt_inr(grand_total)}\n\n"
                "⚠️ The invoice was created, but I couldn't prepare the PDF just now. "
                "You can open it from the web app and try again."
            )
            await db.telegram_conversations.delete_one({"telegram_id": chat_id})
            return {"status": "inv_created_no_pdf"}

        safe_no = inv_no.replace("/", "_").replace("\\", "_")
        await send_document(chat_id, pdf_bytes, f"Invoice_{safe_no}.pdf")
        await db.telegram_conversations.delete_one({"telegram_id": chat_id})
        await send_message(
            chat_id,
            _tg_human_invoice_created(invoice_doc, pdf_sent=True),
        )
        return {"status": "invoice_created"}

    except Exception as e:
        import traceback
        traceback.print_exc()
        await send_message(chat_id, f"❌ Error creating invoice: {e}")
        return {"status": "error"}


async def _cmd_invlist(chat_id: int, action: str = "view") -> dict:
    """Show a list of the 10 most recent invoices with PDF / Email buttons."""
    user = await db.users.find_one({"telegram_id": chat_id})
    q: dict = {} if (user and user.get("role") == "admin") else ({"created_by": user["id"]} if user else {})

    invoices = await (
        db.invoices.find(q, {"_id": 0})
        .sort("created_at", -1)
        .limit(10)
        .to_list(10)
    )

    if not invoices:
        await send_message(chat_id, "📋 No invoices found.")
        return {"status": "no_invoices"}

    STATUS_EMOJI = {
        "draft": "✏️", "sent": "📤", "paid": "✅",
        "partially_paid": "⏳", "overdue": "⚠️",
        "cancelled": "❌", "credit_note": "🔄",
    }
    lines = ["📋 *Recent Invoices:*\n"]
    buttons = []
    for inv in invoices:
        emoji = STATUS_EMOJI.get(inv.get("status", "draft"), "📄")
        lines.append(
            f"{emoji} `{inv.get('invoice_no','—')}` — {inv.get('client_name','—')}\n"
            f"   {_fmt_inr(inv.get('grand_total',0))} | {inv.get('invoice_date','—')} | {inv.get('status','—')}"
        )
        if action == "pdf":
            buttons.append({"text": f"📄 {inv.get('invoice_no','—')}", "callback": f"inv_getpdf_{inv['id']}"})
        elif action == "email":
            buttons.append({"text": f"📧 {inv.get('invoice_no','—')}", "callback": f"inv_email_{inv['id']}"})

    await send_message(chat_id, "\n".join(lines))

    if buttons:
        label = "Select invoice to get PDF:" if action == "pdf" else "Select invoice to email:"
        await send_message(chat_id, label, inline_keyboard(buttons, include_cancel=False))

    return {"status": "invlist_shown"}


async def _send_invoice_pdf_by_id(chat_id: int, inv_id: str) -> dict:
    """Fetch invoice + company, generate PDF, send to chat."""
    inv = await db.invoices.find_one({"id": inv_id}, {"_id": 0})
    if not inv:
        await send_message(chat_id, "🔎 I couldn't find that invoice. Please check the client name or invoice number.")
        return {"status": "not_found"}

    company = await db.companies.find_one({"id": inv.get("company_id")}, {"_id": 0}) or {}
    try:
        pdf_buf   = _build_invoice_pdf(inv, company)
        pdf_bytes = pdf_buf.getvalue()
    except Exception as e:
        await send_message(chat_id, f"❌ PDF generation failed: {e}")
        return {"status": "pdf_error"}

    safe_no = (inv.get("invoice_no") or inv_id).replace("/", "_").replace("\\", "_")
    await send_document(chat_id, pdf_bytes, f"Invoice_{safe_no}.pdf")
    await send_message(
        chat_id,
        _tg_human_invoice_pdf(inv)
        + (
            f"\n📩 If you'd like, I can email it to the client too."
        ),
    )
    return {"status": "pdf_sent"}


async def _send_invoice_email_by_id(chat_id: int, inv_id: str) -> dict:
    """Generate PDF and email it to the client's email address."""
    inv = await db.invoices.find_one({"id": inv_id}, {"_id": 0})
    if not inv:
        await send_message(chat_id, "🔎 I couldn't find that invoice. Please check the client name or invoice number.")
        return {"status": "not_found"}

    client_email = (inv.get("client_email") or "").strip()
    if not client_email:
        await send_message(
            chat_id,
            f"❌ Invoice *{inv.get('invoice_no','')}* has no client email address.\n"
            f"Update it in the web app and try again."
        )
        return {"status": "no_email"}

    company = await db.companies.find_one({"id": inv.get("company_id")}, {"_id": 0}) or {}
    try:
        pdf_buf   = _build_invoice_pdf(inv, company)
        pdf_bytes = pdf_buf.getvalue()
    except Exception as e:
        await send_message(chat_id, f"❌ PDF generation failed: {e}")
        return {"status": "pdf_error"}

    inv_no      = inv.get("invoice_no", inv_id)
    comp_name   = company.get("name", "Your Company")
    client_name = inv.get("client_name", "Customer")
    grand_total = _fmt_inr(inv.get("grand_total", 0))
    due_date    = inv.get("due_date", "")

    subject   = f"Invoice {inv_no} from {comp_name}"
    html_body = (
        f"<h2>Invoice {inv_no}</h2>"
        f"<p>Dear {client_name},</p>"
        f"<p>Please find attached invoice <strong>{inv_no}</strong> "
        f"for <strong>{grand_total}</strong>.</p>"
        f"<p>Due Date: <strong>{due_date}</strong></p>"
        f"<p>Payment Terms: {inv.get('payment_terms','Due on receipt')}</p>"
        f"{'<p>Notes: ' + inv['notes'] + '</p>' if inv.get('notes') else ''}"
        f"<br><p>Regards,<br>{comp_name}</p>"
    )
    company_email = company.get("email", "")
    safe_no       = inv_no.replace("/", "_").replace("\\", "_")

    try:
        # _send_email is synchronous — run in thread to avoid blocking the event loop
        await asyncio.to_thread(
            _send_email,
            client_email,
            subject,
            html_body,
            pdf_bytes,
            f"Invoice_{safe_no}.pdf",
            company_email,
        )
    except Exception as e:
        await send_message(
        chat_id,
        "⚠️ I couldn't send the invoice email right now. "
        "Please check the email settings and try again."
    )
        return {"status": "email_error"}

    # Update invoice status to "sent" if still draft
    if inv.get("status") == "draft":
        await db.invoices.update_one(
            {"id": inv_id},
            {"$set": {"status": "sent", "updated_at": datetime.now(timezone.utc).isoformat()}}
        )

    await send_message(
        chat_id,
        f"✅ Invoice *{inv_no}* emailed to `{client_email}`!\n"
        f"Status updated to *Sent*."
    )
    return {"status": "email_sent"}
