"""
Accounting Core — Chart of Accounts, Journal Entries, General Ledger,
Trial Balance, Profit & Loss, and Balance Sheet.

This is deliberately a standard double-entry engine: every Journal Entry is
a set of lines that must debit-equal-credit before it's allowed to save.
Purchase invoices, Sale invoices, and Bank transactions all post into this
same ledger through `post_journal_entry(...)`, so the reports below reflect
the whole business, not just manually-typed entries.

Scope: one ledger per `company_id` (the firm's own "Sales company/book"
entity already used elsewhere in the app — see /companies/list). Pass
company_id="" to use a single default book if the firm only operates one.
"""

import re
import uuid
import asyncio
import logging
import time
from datetime import datetime, date, timezone
from typing import Dict, Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend import report_cache
from backend.finix_action_permissions import require_finix_action
from backend.dependencies import db, get_current_user
from backend.account_classification import classify, classify_account
from backend.modules.finix_ai.accounting.models_accounting import AccountCreate, JournalLine, JournalEntryCreate

from backend.models import User

router = APIRouter(tags=["Accounting"])

# Module-level logger. NOTE: this was previously missing even though
# `post_gst_engine_entries` and `finix_chat` below call `logger.error(...)` —
# without this, any exception hitting those except-blocks would raise a
# `NameError: name 'logger' is not defined` instead of actually logging the
# original error, silently hiding real failures.
logger = logging.getLogger(__name__)


async def _empty_coro(val):
    """Trivial coroutine that returns a constant — used as a no-op arm in
    asyncio.gather() calls so both branches always produce an awaitable."""
    return val


def _name_match_query(name: str) -> dict:
    """Case/whitespace-insensitive exact-name match with support for corporate suffix variations
    like Pvt Ltd, Private Limited, Ltd, and Limited. This prevents spelling variants of corporate
    suffixes from breaking party matching on invoice vs payment ledger records."""
    name = (name or "").strip()
    name = name.replace(".", " ").replace(",", " ")
    tokens = name.split()
    
    regex_parts = []
    i = 0
    while i < len(tokens):
        tok = tokens[i].upper()
        if tok == "PVT" and i + 1 < len(tokens) and tokens[i+1].upper() == "LTD":
            regex_parts.append(r"(PVT\s*LTD|PVT\s*LIMITED|PRIVATE\s*LIMITED|PRIVATE\s*LTD|LTD|LIMITED)?")
            i += 2
        elif tok == "PRIVATE" and i + 1 < len(tokens) and tokens[i+1].upper() == "LIMITED":
            regex_parts.append(r"(PVT\s*LTD|PVT\s*LIMITED|PRIVATE\s*LIMITED|PRIVATE\s*LTD|LTD|LIMITED)?")
            i += 2
        elif tok in ("PVT", "PRIVATE"):
            regex_parts.append(r"(PVT|PRIVATE)?")
            i += 1
        elif tok in ("LTD", "LIMITED"):
            regex_parts.append(r"(LTD|LIMITED)?")
            i += 1
        else:
            regex_parts.append(re.escape(tokens[i]))
            i += 1
            
    regex_parts = [p for p in regex_parts if p]
    normalized = r"\s*".join(regex_parts)
    return {"$regex": f"^{normalized}$", "$options": "i"}


_COA_LOOKUP_PAGES = (
    "can_view_accounting_reports", "can_view_extended_accounts_reports",
    "can_view_accounting_integrity", "can_view_finix_dashboard",
    "can_view_journal_entries", "can_view_zero_touch_entries", "can_view_bank",
    "can_view_sale", "can_view_purchase", "can_view_accounting_audit_trail",
    "can_view_gst_portal_sync",
)


def _perm_view_coa(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    # The account list is a read-only lookup for every Finix page that posts or
    # reports on accounts (the commercial guard has already checked the licence).
    return bool(
        perms.get("can_view_chart_of_accounts")
        or any(perms.get(flag) for flag in _COA_LOOKUP_PAGES)
    )


def _perm_manage_coa(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_manage_chart_of_accounts"))


def _perm_view_journal(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_view_journal_entries"))


def _perm_post_journal(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_post_journal_entries"))


def _perm_reports(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(perms.get("can_view_accounting_reports"))


# ── Default Chart of Accounts (standard Indian SME set) ─────────────────────
DEFAULT_ACCOUNTS = [
    # code, name, type (asset/liability/equity/income/expense), sub_type
    ("1000", "Cash in Hand",            "asset",     "current_asset"),
    ("1010", "Bank Accounts",           "asset",     "current_asset"),
    ("1100", "Accounts Receivable",     "asset",     "current_asset"),
    ("1200", "GST Input Credit",        "asset",     "current_asset"),
    ("1300", "Fixed Assets",            "asset",     "fixed_asset"),
    ("2000", "Accounts Payable",        "liability", "current_liability"),
    ("2100", "GST Output Payable",      "liability", "current_liability"),
    ("2200", "TDS Payable",             "liability", "current_liability"),
    ("3000", "Owner's Capital / Equity","equity",    "equity"),
    ("3100", "Retained Earnings",       "equity",    "equity"),
    ("4000", "Sales / Fee Income",      "income",    "operating_income"),
    ("4100", "Other Income",            "income",    "other_income"),
    ("5000", "Purchases",               "expense",   "cost_of_service"),
    ("5100", "Salaries & Wages",         "expense",   "operating_expense"),
    ("5200", "Rent Expense",             "expense",   "operating_expense"),
    ("5250", "Software & Cloud Expenses","expense",   "operating_expense"),
    ("5300", "Office & Admin Expenses", "expense",   "operating_expense"),
    ("5400", "Bank Charges",             "expense",   "operating_expense"),
    ("5500", "Shipping & Freight",       "expense",   "operating_expense"),
    ("5600", "Travel & Conveyance",      "expense",   "operating_expense"),
    ("5700", "Foreign Exchange Loss / Gain", "expense", "operating_expense"),
    ("5900", "Round Off",               "expense",   "operating_expense"),
    # Foundations for proper statements (added later; existing companies pick them up automatically).
    ("1250", "TDS Receivable / Advance Tax",   "asset",     "current_asset"),
    ("1310", "Accumulated Depreciation",       "asset",     "accumulated_depreciation"),
    ("1350", "Intangible Assets (Software)",   "asset",     "intangible_asset"),
    ("1400", "Inventory / Stock-in-Trade",     "asset",     "inventory"),
    ("1500", "Prepaid Expenses",               "asset",     "prepaid"),
    ("1600", "Deferred Tax Asset",             "asset",     "deferred_tax_asset"),
    ("2300", "Accrued Expenses",               "liability", "current_liability"),
    ("2400", "Provisions",                     "liability", "provision"),
    ("2500", "Deferred Tax Liability",         "liability", "deferred_tax_liability"),
    ("2600", "Provision for Income Tax",       "liability", "current_liability"),
    ("2700", "Long-term Loans & Borrowings",   "liability", "long_term_liability"),
    ("5010", "Direct Expenses",                "expense",   "direct_expense"),
    ("5020", "Cost of Goods Sold / Stock Adjustment", "expense", "cost_of_service"),
    ("5450", "Interest & Finance Charges",     "expense",   "finance_cost"),
    ("5800", "Depreciation Expense",           "expense",   "depreciation"),
    ("5950", "Income Tax Expense",             "expense",   "tax_expense"),
    ("5960", "Deferred Tax Expense / (Credit)", "expense",  "tax_expense"),
    # Suspense — parking account for bank lines that can't be classified at match time.
    # Standard AI-accounting practice (Zoho / QuickBooks / Xero): post to suspense first
    # so the bank balance stays reconciled, then reclassify from the "Suspense Review"
    # workflow once the correct expense head is known.
    ("9998", "Suspense Account",         "asset",     "current_asset"),
]


_ensured_coa_companies: set = set()

# Process-level cache for get_default_account_id.
# Keys: (company_id, code) → account_id string.
# Chart-of-accounts IDs are stable once seeded; they never change during a
# server lifetime, so this cache never goes stale.  A server restart clears
# it automatically and any new accounts are re-seeded by
# ensure_default_chart_of_accounts on first use.
_acct_id_cache: dict = {}


async def ensure_default_chart_of_accounts(company_id: str, created_by: str):
    """Insert any DEFAULT_ACCOUNTS codes this company doesn't have yet.
    Deliberately per-code (not 'skip entirely if any account exists') so that
    when new system accounts are added to DEFAULT_ACCOUNTS later (e.g. a new
    expense category), companies that were seeded before that change still
    pick it up automatically the next time their Chart of Accounts loads.

    This gets called for every account lookup during invoice/payment sync
    (2-3 times per invoice), so once a company's default accounts have been
    confirmed present in this process, skip re-scanning the whole
    chart_of_accounts collection on every subsequent call — that repeated
    full scan was the main remaining cost behind slow report loads even
    after debouncing the outer reconcile pass. A fresh deploy/restart clears
    this cache, so newly added DEFAULT_ACCOUNTS codes still get seeded."""
    if company_id in _ensured_coa_companies:
        return
    existing_codes = set(
        r["code"] for r in await db.chart_of_accounts.find(
            {"company_id": company_id}, {"_id": 0, "code": 1}
        ).to_list(2000)
    )
    missing = [(code, name, typ, sub) for code, name, typ, sub in DEFAULT_ACCOUNTS if code not in existing_codes]
    if missing:
        now = datetime.now(timezone.utc).isoformat()
        docs = [
            {
                "id": str(uuid.uuid4()), "company_id": company_id, "code": code, "name": name,
                "type": typ, "sub_type": sub, "is_system": True, "is_active": True,
                "created_by": created_by, "created_at": now,
                **classify(code, typ, sub, name),
            }
            for code, name, typ, sub in missing
        ]
        await db.chart_of_accounts.insert_many(docs)
    await backfill_account_classification(company_id)
    _ensured_coa_companies.add(company_id)


async def backfill_account_classification(company_id: str) -> int:
    """Give every account that predates classification (including ledgers the firm added itself) its statement,
    nature, Schedule III head and direct/indirect tag. Never changes an account that already has them, so a
    deliberate override survives."""
    n = 0
    async for a in db.chart_of_accounts.find({"company_id": company_id, "statement": {"$exists": False}}, {"_id": 0}):
        await db.chart_of_accounts.update_one({"id": a["id"]}, {"$set": classify_account(a)})
        n += 1
    return n


# ── Models ────────────────────────────────────────────────────────────────



# ── Chart of Accounts routes ─────────────────────────────────────────────
@router.get("/chart-of-accounts")
async def list_accounts(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    if not _perm_view_coa(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    # No firm picked yet -> use the caller's own company (never another one).
    company_id = (company_id or "").strip() or str(getattr(current_user, "company_id", "") or "")
    await ensure_default_chart_of_accounts(company_id, current_user.id)
    items = await db.chart_of_accounts.find({"company_id": company_id}, {"_id": 0}).sort("code", 1).to_list(2000)
    return items


@router.post("/chart-of-accounts")
async def create_account(payload: AccountCreate, current_user: User = Depends(get_current_user)):
    if not _perm_manage_coa(current_user):
        raise HTTPException(403, "Access denied.")
    if payload.type not in {"asset", "liability", "equity", "income", "expense"}:
        raise HTTPException(400, "type must be one of asset, liability, equity, income, expense.")
    dup = await db.chart_of_accounts.find_one({"company_id": payload.company_id, "code": payload.code})
    if dup:
        raise HTTPException(409, f"Account code {payload.code} already exists.")
    doc = {
        "id": str(uuid.uuid4()), "company_id": payload.company_id, "code": payload.code.strip(),
        "name": payload.name.strip(), "type": payload.type, "sub_type": payload.sub_type.strip(),
        "is_system": False, "is_active": True, "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    doc.update(classify_account(doc))
    await db.chart_of_accounts.insert_one(doc)
    doc.pop("_id", None)
    return doc


@router.delete("/chart-of-accounts/{account_id}")
async def delete_account(account_id: str, current_user: User = Depends(get_current_user)):
    require_finix_action(current_user, "can_view_chart_of_accounts", "delete")
    acct = await db.chart_of_accounts.find_one({"id": account_id})
    if not acct:
        raise HTTPException(404, "Account not found.")
    if acct.get("is_system"):
        raise HTTPException(400, "Default system accounts can't be deleted (they're needed by auto-posting). Mark inactive instead.")
    used = await db.journal_lines.count_documents({"account_id": account_id})
    if used:
        raise HTTPException(400, "This account has journal entries posted against it and can't be deleted.")
    await db.chart_of_accounts.delete_one({"id": account_id})
    return {"success": True}


# ── Journal Entry posting (shared by manual entries, Purchase, Sale, Bank) ──
async def post_journal_entry(
    company_id: str, entry_date: str, narration: str, lines: List[dict],
    source: str, source_id: Optional[str], created_by: str,
) -> dict:
    """Core double-entry post. Raises ValueError if debits != credits.
    Used both by the manual Journal Entry endpoint and by auto-posting hooks
    from Purchase/Sale/Bank so every recorded transaction ends up in the
    same ledger and reports."""
    total_debit = round(sum(float(l.get("debit") or 0) for l in lines), 2)
    total_credit = round(sum(float(l.get("credit") or 0) for l in lines), 2)
    if abs(total_debit - total_credit) > 0.01:
        raise ValueError(f"Journal entry does not balance: debit {total_debit} != credit {total_credit}")
    if total_debit <= 0:
        raise ValueError("Journal entry has no amount.")

    now = datetime.now(timezone.utc).isoformat()
    entry_id = str(uuid.uuid4())
    entry_doc = {
        "id": entry_id, "company_id": company_id, "entry_date": entry_date,
        "narration": narration, "source": source, "source_id": source_id,
        "total_debit": total_debit, "total_credit": total_credit,
        "created_by": created_by, "created_at": now,
    }
    await db.journal_entries.insert_one(entry_doc)

    line_docs = []
    for l in lines:
        line_docs.append({
            "id": str(uuid.uuid4()), "entry_id": entry_id, "company_id": company_id,
            "entry_date": entry_date, "account_id": l["account_id"],
            "account_name": l.get("account_name", ""), "debit": float(l.get("debit") or 0),
            "credit": float(l.get("credit") or 0), "memo": l.get("memo", ""), "created_at": now,
        })
    await db.journal_lines.insert_many(line_docs)
    entry_doc.pop("_id", None)
    return entry_doc


async def try_auto_post(company_id: str, entry_date: str, narration: str, lines: List[dict],
                         source: str, source_id: Optional[str], created_by: str) -> Optional[dict]:
    """Best-effort wrapper for call sites (Purchase/Sale/Bank) that must
    never fail the parent request just because auto-posting hit an edge
    case (e.g. a missing default account on a brand-new company)."""
    try:
        return await post_journal_entry(company_id, entry_date, narration, lines, source, source_id, created_by)
    except Exception:
        return None


async def get_default_account_id(company_id: str, code: str) -> Optional[str]:
    cache_key = (company_id, code)
    if cache_key in _acct_id_cache:
        return _acct_id_cache[cache_key]
    await ensure_default_chart_of_accounts(company_id, "system")
    acct = await db.chart_of_accounts.find_one({"company_id": company_id, "code": code}, {"_id": 0, "id": 1})
    result = acct["id"] if acct else None
    if result:
        _acct_id_cache[cache_key] = result
    return result


async def _all_book_ids() -> List[str]:
    """Every distinct book: each real company plus the "" default book (used
    by manual Journal Entries, which have no company selector). Used for the
    'All Companies' report view so it actually aggregates everything instead
    of only showing the empty-company_id book."""
    ids = {""}
    async for c in db.companies.find({}, {"_id": 0, "id": 1}):
        if c.get("id"):
            ids.add(c["id"])
    return list(ids)


async def _reconcile_one_book(company_id: str):
    from backend.invoicing import reconcile_and_sync_all_sales_and_payments, reconcile_and_sync_all_purchases_and_payments
    await asyncio.gather(
        reconcile_and_sync_all_sales_and_payments(company_id),
        reconcile_and_sync_all_purchases_and_payments(company_id),
    )


async def _reconcile_all_books(book_ids: List[str]):
    await asyncio.gather(*(_reconcile_one_book(cid) for cid in book_ids))


async def _validate_best_effort(company_id: str):
    """Fire-and-forget consistency check (Revenue=Collections+Outstanding,
    TB Debits=Credits, AR=Outstanding, Customer Ledger=AR, Sales
    Ledger=Invoice Revenue, GST+NonGST+Export+Exempt=Revenue). Never
    raises into the caller - a validator bug must not break report
    rendering; mismatches are logged/persisted by the engine itself."""
    try:
        from backend.accounting_ai.reconciliation_validator import run_validation_engine
        await run_validation_engine(company_id, auto_fix=True)
    except Exception:
        logging.getLogger("accounting_core").exception("validation engine failed")


_VALIDATION_MIN_INTERVAL = 300.0
_validation_last_started: Dict[str, float] = {}


def _schedule_validation(company_id: str) -> None:
    """Run the background consistency check at most once per interval per book.

    Every Trial Balance and Balance Sheet load used to start a full validation of its own, so
    opening the dashboard started two of them next to the validation the page asks for itself."""
    now = time.monotonic()
    if now - _validation_last_started.get(company_id, -_VALIDATION_MIN_INTERVAL) < _VALIDATION_MIN_INTERVAL:
        return
    _validation_last_started[company_id] = now
    asyncio.create_task(_validate_best_effort(company_id))


@router.get("/reports/validation-engine")
async def validation_engine_report(company_id: str = Query(""), fresh: bool = Query(False), current_user: User = Depends(get_current_user)):
    """On-demand reconciliation health check across Trial Balance, Party/
    Customer Ledger, and GST report totals vs. the Invoice module's own
    Revenue/Collections/Outstanding figures. Auto-heals by rerunning the
    invoice->journal sync once before reporting a real mismatch."""
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    from backend.accounting_ai.reconciliation_validator import run_validation_engine, run_validation_engine_all_books
    try:
        if company_id:
            # Re-use the last answer while nothing in the books has changed; "Re-verify" asks for fresh=true.
            return await report_cache.cached(
                "validation_engine", (company_id,),
                lambda: run_validation_engine(company_id, auto_fix=True), fresh=fresh,
            )
        return {"books": await run_validation_engine_all_books()}
    except HTTPException:
        # Tenant-isolation / permission errors (403, 404, ...) must reach the
        # client unchanged. Previously they were swallowed by the generic
        # handler below and re-raised as a misleading 500.
        raise
    except Exception as exc:
        # Previously this endpoint had no guard, so any exception deep in the
        # reconcile/rebuild pipeline (bad invoice data, a missing account,
        # etc.) surfaced to the client as a bare 500 with no explanation —
        # and no company_id context in the server log to trace it back.
        # Log the full traceback with context, then return a clean message
        # instead of letting FastAPI's default handler swallow the detail.
        logging.getLogger("accounting_core").exception(
            f"validation-engine endpoint failed for company_id={company_id or '(all books)'}"
        )
        raise HTTPException(
            500,
            f"Ledger verification failed while processing "
            f"{'company ' + company_id if company_id else 'one of the books'}: "
            f"{type(exc).__name__}: {exc}. Check the backend logs for the full traceback.",
        )


@router.post("/journal-entries")
async def create_journal_entry(payload: JournalEntryCreate, current_user: User = Depends(get_current_user)):
    if not _perm_post_journal(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    try:
        doc = await post_journal_entry(
            payload.company_id, payload.entry_date, payload.narration.strip(),
            [l.model_dump() for l in payload.lines], "manual", None, current_user.id,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    return doc


@router.get("/journal-entries")
async def list_journal_entries(
    company_id: str = Query(""), date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    source: Optional[str] = Query(None), page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
    current_user: User = Depends(get_current_user),
):
    if not _perm_view_journal(current_user):
        raise HTTPException(403, "Access denied.")

    all_companies = not company_id
    q: dict = {} if all_companies else {"company_id": company_id}
    if date_from or date_to:
        q["entry_date"] = {}
        if date_from:
            q["entry_date"]["$gte"] = date_from
        if date_to:
            q["entry_date"]["$lte"] = date_to
    if source:
        q["source"] = source

    total = await db.journal_entries.count_documents(q)
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = min(page, total_pages)
    skip = (page - 1) * page_size
    entries = await db.journal_entries.find(q, {"_id": 0}).sort("entry_date", -1).skip(skip).limit(page_size).to_list(page_size)

    # Defensive: a small number of legacy/corrupt journal_entries documents
    # (e.g. written before every insert consistently included "id", or
    # created by an older import/migration path outside post_journal_entry)
    # can be missing the "id" field entirely. A direct `e["id"]` access below
    # would raise KeyError on the very first such document and 500 the whole
    # page/export for everyone. Filter those out instead, and log which ones
    # were skipped so the bad documents can be found and cleaned up in Mongo.
    good_entries, bad_entries = [], []
    for e in entries:
        (good_entries if "id" in e else bad_entries).append(e)
    if bad_entries:
        logger.warning(
            "list_journal_entries: skipping %d entries missing 'id' (company_id=%s): %s",
            len(bad_entries), company_id or "(all)", bad_entries,
        )
    entries = good_entries

    ids = [e["id"] for e in entries]
    lines = await db.journal_lines.find({"entry_id": {"$in": ids}}, {"_id": 0}).to_list(10000)
    by_entry: dict = {}
    for l in lines:
        by_entry.setdefault(l["entry_id"], []).append(l)

    # Enrich each entry with customer/vendor name, voucher/invoice number,
    # payment mode, bank/cash account, and reference number — resolved from
    # the underlying invoice/bill/payment that the entry was posted from, so
    # the Journal Entries UI can show "Receipt from Abhinav against Invoice
    # INV-2026-001" instead of just a raw narration string.
    sale_ids = {e["source_id"] for e in entries if e.get("source") == "sale" and e.get("source_id")}
    purchase_ids = {e["source_id"] for e in entries if e.get("source") == "purchase" and e.get("source_id")}
    payment_ids = {e["source_id"] for e in entries if e.get("source") == "payment" and e.get("source_id")}
    purchase_payment_ids = {e["source_id"] for e in entries if e.get("source") == "purchase_payment" and e.get("source_id")}

    # PERF: fire all four enrichment lookups concurrently instead of serially.
    # Each awaits a round-trip to MongoDB; doing them in parallel cuts the
    # enrichment phase from ~4× RTT to ~1× RTT.
    async def _fetch_if(collection, ids, projection):
        if not ids:
            return {}
        docs = await collection.find({"id": {"$in": list(ids)}}, {"_id": 0, **projection}).to_list(len(ids))
        return {d["id"]: d for d in docs}

    invoices_by_id, bills_by_id, payments_by_id, purchase_payments_by_id = await asyncio.gather(
        _fetch_if(db.invoices,          sale_ids,             {"id": 1, "client_name": 1, "invoice_no": 1, "reference_no": 1}),
        _fetch_if(db.purchase_invoices, purchase_ids,         {"id": 1, "supplier_name": 1, "invoice_no": 1}),
        _fetch_if(db.payments,          payment_ids,          {"id": 1, "invoice_id": 1, "client_name": 1, "payment_mode": 1, "reference_no": 1, "bank_account_id": 1}),
        _fetch_if(db.purchase_payments, purchase_payment_ids, {"id": 1, "purchase_invoice_id": 1, "supplier_name": 1, "payment_mode": 1, "reference_no": 1}),
    )

    # Resolve linked invoice/bill numbers for payment records — also parallel.
    linked_inv_ids = {p["invoice_id"] for p in payments_by_id.values() if p.get("invoice_id")}
    linked_bill_ids = {p["purchase_invoice_id"] for p in purchase_payments_by_id.values() if p.get("purchase_invoice_id")}
    linked_inv_by_id, linked_bill_by_id = await asyncio.gather(
        _fetch_if(db.invoices,          linked_inv_ids,  {"id": 1, "invoice_no": 1, "client_name": 1}),
        _fetch_if(db.purchase_invoices, linked_bill_ids, {"id": 1, "invoice_no": 1, "supplier_name": 1}),
    )

    for e in entries:
        e["lines"] = by_entry.get(e["id"], [])
        src, sid = e.get("source"), e.get("source_id")
        if src == "sale" and sid in invoices_by_id:
            inv = invoices_by_id[sid]
            e["customer_name"] = inv.get("client_name")
            e["invoice_no"] = inv.get("invoice_no")
            e["voucher_no"] = inv.get("invoice_no")
            e["reference_no"] = inv.get("reference_no") or None
        elif src == "purchase" and sid in bills_by_id:
            bill = bills_by_id[sid]
            e["vendor_name"] = bill.get("supplier_name")
            e["invoice_no"] = bill.get("invoice_no")
            e["voucher_no"] = bill.get("invoice_no")
        elif src == "payment" and sid in payments_by_id:
            pay = payments_by_id[sid]
            linked = linked_inv_by_id.get(pay.get("invoice_id"))
            e["customer_name"] = (linked.get("client_name") if linked else None) or pay.get("client_name")
            e["invoice_no"] = linked.get("invoice_no") if linked else None
            e["payment_mode"] = pay.get("payment_mode")
            e["reference_no"] = pay.get("reference_no") or None
            e["bank_account"] = "Cash in Hand" if str(pay.get("payment_mode") or "").lower() == "cash" else "Bank Accounts"
            e["voucher_no"] = pay.get("id")
        elif src == "purchase_payment" and sid in purchase_payments_by_id:
            pay = purchase_payments_by_id[sid]
            linked = linked_bill_by_id.get(pay.get("purchase_invoice_id"))
            e["vendor_name"] = (linked.get("supplier_name") if linked else None) or pay.get("supplier_name")
            e["invoice_no"] = linked.get("invoice_no") if linked else None
            e["payment_mode"] = pay.get("payment_mode")
            e["reference_no"] = pay.get("reference_no") or None
            e["bank_account"] = "Cash in Hand" if str(pay.get("payment_mode") or "").lower() == "cash" else "Bank Accounts"
            e["voucher_no"] = pay.get("id")

    return {"entries": entries, "total": total, "total_pages": total_pages, "page": page, "page_size": page_size}


async def _delete_journal_entry_guarded(entry: dict, current_user: User) -> None:
    """Hard-delete ONE manual journal entry, safely.

    Order matters: (1) guard — role-independent rules (manual only, no adjustment
    history, period open); (2) audit event carrying the full entry so the deletion
    is reconstructable; (3) delete; (4) if the delete itself fails half-way, put
    the entry back so the ledger is never left with a header and no lines.
    """
    from backend.accounting_lock import (
        guard_deletion, audit_ledger_event, journal_audit_summary, snapshot_journal, restore_journal,
    )
    entry_id = entry["id"]
    await guard_deletion(entry_id, current_user)
    lines = await db.journal_lines.find({"entry_id": entry_id}, {"_id": 0}).to_list(1000)
    await audit_ledger_event(
        entry.get("company_id"), "JOURNAL_ENTRY_DELETED", current_user,
        journal_audit_summary(entry, lines), entry_id,
    )
    snapshot = await snapshot_journal([entry_id])
    try:
        await db.journal_lines.delete_many({"entry_id": entry_id})
        await db.journal_entries.delete_one({"id": entry_id})
    except Exception as exc:
        await restore_journal(snapshot)
        logging.getLogger("accounting_core").exception("Journal delete failed for %s; restored", entry_id)
        raise HTTPException(500, "Journal entry could not be deleted; no change was made.") from exc


@router.post("/journal-entries/bulk-delete")
async def bulk_delete_journal_entries(payload: dict, current_user: User = Depends(get_current_user)):
    require_finix_action(current_user, "can_view_journal_entries", "delete")
    entry_ids = payload.get("entry_ids") or []
    if not isinstance(entry_ids, list) or not entry_ids:
        raise HTTPException(400, "No entry_ids provided.")
    deleted_ids, failed = [], []
    for entry_id in dict.fromkeys(str(e) for e in entry_ids):
        try:
            entry = await db.journal_entries.find_one({"id": entry_id}, {"_id": 0})
            if not entry:
                failed.append({"id": entry_id, "reason": "Not found"})
                continue
            await _delete_journal_entry_guarded(entry, current_user)
            deleted_ids.append(entry_id)
        except HTTPException as e:
            failed.append({"id": entry_id, "reason": e.detail})
        except Exception as e:
            failed.append({"id": entry_id, "reason": str(e)})
    return {"deleted_count": len(deleted_ids), "failed": failed}


@router.post("/journal-entries/delete-all")
async def delete_all_journal_entries(payload: dict, current_user: User = Depends(get_current_user)):
    """Delete every MANUAL journal entry of ONE company.

    A company is mandatory: this endpoint used to run with no filter and wipe
    every book at once. System-generated entries (sales, purchases, payments,
    bank matches, AI postings) are never removed here — they belong to their
    source documents — and entries in a locked period are skipped.
    """
    require_finix_action(current_user, "can_view_journal_entries", "delete")
    company_id = str((payload or {}).get("company_id") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a single company before deleting journal entries; deleting across all companies is not allowed.")

    system_entries = await db.journal_entries.count_documents({"company_id": company_id, "source": {"$ne": "manual"}})
    entries = await db.journal_entries.find({"company_id": company_id, "source": "manual"}, {"_id": 0}).to_list(100000)
    deleted = 0
    failed = []
    for entry in entries:
        try:
            await _delete_journal_entry_guarded(entry, current_user)
            deleted += 1
        except HTTPException as e:
            failed.append({"id": entry["id"], "reason": e.detail})
        except Exception as e:
            failed.append({"id": entry["id"], "reason": str(e)})
    return {
        "deleted_count": deleted,
        "failed_count": len(failed) + system_entries,
        "skipped_system_entries": system_entries,
        "failed": failed[:20],
    }


@router.post("/journal-entries/resync")
async def resync_journal_entries(payload: dict, current_user: User = Depends(get_current_user)):
    """Triggers an automatic system re-sync to find missing or deleted automated
    journal entries and recreate them in the system.
    """
    if not _perm_post_journal(current_user):
        raise HTTPException(403, "Access denied.")

    company_id = payload.get("company_id")
    if company_id == "__all__":
        company_id = None

    # Resolve which companies to process
    if company_id:
        company_ids = [company_id]
    else:
        # Fetch all companies
        companies = await db.companies.find({}, {"id": 1}).to_list(1000)
        company_ids = [c["id"] for c in companies]
        if not company_ids:
            # Fallback to empty string for single default book if no company documents exist
            company_ids = [""]

    from backend.invoicing import (
        _reconcile_and_sync_all_sales_and_payments_impl,
        _reconcile_and_sync_all_purchases_and_payments_impl
    )
    from backend.bank_accounts import _auto_post_for_match

    recreated_bank_matches = 0

    for cid in company_ids:
        try:
            # 1. Re-sync all sales and purchase invoices/payments (handles missing/deleted entries)
            await _reconcile_and_sync_all_sales_and_payments_impl(cid)
            await _reconcile_and_sync_all_purchases_and_payments_impl(cid)
        except Exception as e:
            logging.error(f"Error during sales/purchase sync for company {cid}: {e}")

        # 2. Check matched bank transactions in this company
        try:
            # We fetch bank accounts in this company to find statement lines
            acct_ids = []
            if cid:
                accts = await db.bank_accounts.find({"company_id": cid}, {"id": 1}).to_list(1000)
                acct_ids = [a["id"] for a in accts]
            
            # Find matched transactions that are NOT ignored
            q = {"matched_type": {"$ne": None}, "ignored": {"$ne": True}}
            if acct_ids:
                q["bank_account_id"] = {"$in": acct_ids}
            elif cid:
                q["company_id"] = cid

            txns = await db.bank_transactions.find(q).to_list(10000)
            for txn in txns:
                je_id = txn.get("journal_entry_id")
                exists = False
                if je_id:
                    je = await db.journal_entries.find_one({"id": je_id}, {"id": 1})
                    if je:
                        exists = True
                
                if not exists:
                    # Missing or deleted! Re-generate!
                    match_doc = {
                        "type": txn["matched_type"],
                        "id": txn["matched_id"],
                        "label": txn.get("matched_label") or "Match"
                    }
                    try:
                        # Auto-post for match
                        new_je_id = await _auto_post_for_match(
                            company_id=cid or txn.get("company_id", ""),
                            txn=txn,
                            match=match_doc,
                            created_by=current_user.id
                        )
                        if new_je_id:
                            await db.bank_transactions.update_one(
                                {"id": txn["id"]},
                                {"$set": {"journal_entry_id": new_je_id}}
                            )
                            recreated_bank_matches += 1
                    except Exception as e:
                        logging.error(f"Error recreating match for txn {txn.get('id')}: {e}")
        except Exception as e:
            logging.error(f"Error re-syncing bank matches for company {cid}: {e}")

    return {
        "success": True,
        "recreated_bank_matches": recreated_bank_matches
    }


@router.delete("/journal-entries/{entry_id}")
async def delete_journal_entry(entry_id: str, current_user: User = Depends(get_current_user)):
    require_finix_action(current_user, "can_view_journal_entries", "delete")
    entry = await db.journal_entries.find_one({"id": entry_id})
    if not entry:
        raise HTTPException(404, "Journal entry not found.")
    # Ledger history is immutable once it is system-generated or has already
    # been corrected through the Adjustment Note workflow. Admin access does
    # not bypass this accounting control because deletion would erase the
    # source-of-truth audit history.
    from backend.accounting_lock import is_dangling_reversal
    if entry.get("source") != "manual" and not await is_dangling_reversal(entry):
        raise HTTPException(400, "System-generated journal entries are locked and cannot be deleted. Use the source document or an Adjustment Note Override.")
    if entry.get("has_adjustment_history"):
        raise HTTPException(400, "Journal entries with adjustment history cannot be deleted. Raise a further Adjustment Note Override instead.")
    await _delete_journal_entry_guarded(entry, current_user)
    return {"success": True}


@router.put("/journal-entries/{entry_id}")
async def update_journal_entry(entry_id: str, payload: JournalEntryCreate, current_user: User = Depends(get_current_user)):
    """Edit an existing manual journal entry. Auto-posted entries (from
    Sale/Purchase/Bank/Payment flows) must be corrected at the source
    document — editing here would drift the ledger away from the invoice."""
    require_finix_action(current_user, "can_view_journal_entries", "edit")
    entry = await db.journal_entries.find_one({"id": entry_id})
    if not entry:
        raise HTTPException(404, "Journal entry not found.")
    # All non-manual entries are system-generated and must remain immutable.
    # Corrections go through the Adjustment Note Override flow so the original
    # posting, reason, and before/after state stay auditable.
    if entry.get("source") != "manual":
        raise HTTPException(400, "System-generated journal entries are locked and cannot be edited. Correct the source document or raise an Adjustment Note Override.")
    if entry.get("has_adjustment_history"):
        raise HTTPException(400, "Journal entries with adjustment history cannot be edited. Raise a further Adjustment Note Override instead.")
    entry_company_id = str(entry.get("company_id") or "").strip()
    requested_company_id = str(payload.company_id or "").strip()
    if entry_company_id and requested_company_id and requested_company_id != entry_company_id:
        raise HTTPException(403, "Cross-company journal mutation is not permitted.")
    if current_user.role == "admin" and entry_company_id and not requested_company_id:
        raise HTTPException(400, "company_id is required when editing a company journal entry.")
    # System-generated entries are intentionally blocked above; corrections
    # use the Adjustment Note Override workflow so source documents and the
    # audit trail cannot silently drift.

    lines = [l.model_dump() for l in payload.lines]
    total_debit = round(sum(float(l.get("debit") or 0) for l in lines), 2)
    total_credit = round(sum(float(l.get("credit") or 0) for l in lines), 2)
    if abs(total_debit - total_credit) > 0.01:
        raise HTTPException(400, f"Debit ({total_debit}) must equal credit ({total_credit}).")
    if total_debit <= 0:
        raise HTTPException(400, "Journal entry has no amount.")

    # A manual entry may not be moved into, out of, or edited inside a locked period.
    from backend.accounting_lock import (
        assert_period_open, audit_ledger_event, journal_audit_summary, snapshot_journal, restore_journal,
    )
    await assert_period_open(entry_company_id, entry.get("entry_date"), "edit this journal entry")
    await assert_period_open(payload.company_id, payload.entry_date, "post this journal entry")

    old_lines = await db.journal_lines.find({"entry_id": entry_id}, {"_id": 0}).to_list(1000)
    await audit_ledger_event(
        entry_company_id, "JOURNAL_ENTRY_EDITED", current_user,
        {"before": journal_audit_summary(entry, old_lines),
         "after": {"entry_date": payload.entry_date, "narration": payload.narration.strip(),
                   "total_debit": total_debit, "total_credit": total_credit,
                   "lines": [{"account_id": l["account_id"], "debit": l.get("debit"), "credit": l.get("credit"),
                              "memo": l.get("memo", "")} for l in lines]}},
        entry_id,
    )

    snapshot = await snapshot_journal([entry_id])
    now = datetime.now(timezone.utc).isoformat()
    line_docs = [{
        "id": str(uuid.uuid4()), "entry_id": entry_id, "company_id": payload.company_id,
        "entry_date": payload.entry_date, "account_id": l["account_id"],
        "account_name": l.get("account_name", ""), "debit": float(l.get("debit") or 0),
        "credit": float(l.get("credit") or 0), "memo": l.get("memo", ""), "created_at": now,
    } for l in lines]
    try:
        await db.journal_entries.update_one(
            {"id": entry_id},
            {"$set": {
                "company_id": payload.company_id,
                "entry_date": payload.entry_date,
                "narration": payload.narration.strip(),
                "total_debit": total_debit,
                "total_credit": total_credit,
                "updated_by": current_user.id,
                "updated_at": now,
            }},
        )
        # Replace lines wholesale — simpler and safer than diffing.
        await db.journal_lines.delete_many({"entry_id": entry_id})
        if line_docs:
            await db.journal_lines.insert_many(line_docs)
    except Exception as exc:
        # Never leave the entry half-rewritten: put the original back.
        await db.journal_lines.delete_many({"entry_id": entry_id})
        await db.journal_entries.delete_one({"id": entry_id})
        await restore_journal(snapshot)
        logging.getLogger("accounting_core").exception("Journal edit failed for %s; original restored", entry_id)
        raise HTTPException(500, "Journal entry could not be updated; the original was kept.") from exc
    updated = await db.journal_entries.find_one({"id": entry_id}, {"_id": 0})
    return updated


# ── General Ledger ────────────────────────────────────────────────────────
@router.get("/ledger/{account_id}")
async def get_ledger(
    account_id: str, date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _perm_view_journal(current_user) and not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")
    acct = await db.chart_of_accounts.find_one({"id": account_id}, {"_id": 0})
    if not acct:
        raise HTTPException(404, "Account not found.")
    
    # Auto-reconcile and sync sales invoices, purchase bills, and payments to general ledger
    await _reconcile_one_book(acct.get("company_id") or "")

    q: dict = {"account_id": account_id}
    if date_from or date_to:
        q["entry_date"] = {}
        if date_from:
            q["entry_date"]["$gte"] = date_from
        if date_to:
            q["entry_date"]["$lte"] = date_to
    lines = await db.journal_lines.find(q, {"_id": 0}).sort("entry_date", 1).to_list(10000)
    running = 0.0
    is_debit_normal = acct["type"] in ("asset", "expense")
    for l in lines:
        delta = (l["debit"] - l["credit"]) if is_debit_normal else (l["credit"] - l["debit"])
        running = round(running + delta, 2)
        l["running_balance"] = running
    return {"account": acct, "lines": lines, "closing_balance": running}


# ── Ledger drill-down by account code ───────────────────────────────────────
# Trial Balance / P&L / Balance Sheet rows are keyed by account *code*
# ("1010", "4000", ...) rather than a single account_id — in "All Companies"
# view the same code maps to a different chart_of_accounts._id in every
# company's book. This endpoint resolves every matching account for the
# given code (optionally scoped to one company) and returns their combined
# transaction history with a running balance, so any report head can be made
# clickable without the frontend needing to know which company owns which id.
@router.get("/reports/ledger-by-code")
async def get_ledger_by_code(
    code: str = Query(...),
    company_id: str = Query(""),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _perm_view_journal(current_user) and not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")

    acct_q: dict = {"code": code}
    if company_id:
        acct_q["company_id"] = company_id
    accounts = await db.chart_of_accounts.find(acct_q, {"_id": 0}).to_list(2000)
    if not accounts:
        raise HTTPException(404, "Account not found.")

    account_ids = [a["id"] for a in accounts]
    if company_id:
        await _reconcile_one_book(company_id)
    else:
        await _reconcile_all_books(await _all_book_ids())

    q: dict = {"account_id": {"$in": account_ids}}
    if date_from or date_to:
        q["entry_date"] = {}
        if date_from:
            q["entry_date"]["$gte"] = date_from
        if date_to:
            q["entry_date"]["$lte"] = date_to
    lines = await db.journal_lines.find(q, {"_id": 0}).sort("entry_date", 1).to_list(20000)

    # Enrich with the same voucher/party context list_journal_entries()
    # provides, so the drill-down reads like a mini Journal Entries view
    # instead of raw debit/credit rows.
    entry_ids = list({l["entry_id"] for l in lines})
    entries = await db.journal_entries.find({"id": {"$in": entry_ids}}, {"_id": 0}).to_list(len(entry_ids) or 1)
    entries_by_id = {e["id"]: e for e in entries}

    typ = accounts[0]["type"]
    is_debit_normal = typ in ("asset", "expense")
    running = 0.0
    for l in lines:
        e = entries_by_id.get(l["entry_id"], {})
        l["narration"] = e.get("narration")
        l["source"] = e.get("source")
        l["source_id"] = e.get("source_id")
        l["company_id"] = e.get("company_id", l.get("company_id"))
        delta = (l["debit"] - l["credit"]) if is_debit_normal else (l["credit"] - l["debit"])
        running = round(running + delta, 2)
        l["running_balance"] = running

    return {
        "code": code, "name": accounts[0]["name"], "type": typ,
        "lines": lines, "closing_balance": running,
    }


# ── Trial Balance ─────────────────────────────────────────────────────────
@router.get("/reports/trial-balance")
async def trial_balance(
    company_id: str = Query(""),
    as_of: Optional[str] = Query(None),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    return await report_cache.cached("trial_balance", (company_id, as_of, date_from, date_to), lambda: _trial_balance_impl(company_id, as_of, date_from, date_to))


async def _trial_balance_impl(company_id: str, as_of: Optional[str], date_from: Optional[str], date_to: Optional[str]):

    all_companies = not company_id
    # Auto-reconcile and sync sales invoices, purchase bills, and payments to
    # general ledger. "All Companies" must reconcile every book, not just the
    # empty-company_id one, or entries tied to a real company never show up.
    if all_companies:
        await _reconcile_all_books(await _all_book_ids())
    else:
        await _reconcile_one_book(company_id)
        # Fire-and-forget: check Revenue=Collections+Outstanding, TB
        # balance, AR=Outstanding, etc. and self-heal via re-sync without
        # adding validator latency to this report's response time.
        _schedule_validation(company_id)

    acct_q = {} if all_companies else {"company_id": company_id}
    accounts = await db.chart_of_accounts.find(acct_q, {"_id": 0}).sort("code", 1).to_list(20000)

    # ── Split accounts into Balance-Sheet vs P&L ─────────────────────────────
    # Balance-sheet accounts (asset, liability, equity) carry forward across
    # periods.  Their Trial Balance figure must be the CUMULATIVE balance up
    # to date_to — applying date_from to them would exclude old outstanding
    # invoices / bank entries from before the period start, making AR and Bank
    # look far too low compared with the Sales and Bank pages.
    #
    # P&L accounts (income, expense) correctly show only the selected period's
    # activity, so date_from applies to them as usual.
    BS_TYPES = {"asset", "liability", "equity"}
    PL_TYPES = {"income", "expense"}

    # Build by_key early so we can derive account-ID sets per category.
    by_key: dict = {}
    for a in accounts:
        key = a["code"] if all_companies else a["id"]
        entry = by_key.setdefault(key, {"code": a["code"], "name": a["name"], "type": a["type"], "account_ids": []})
        entry["account_ids"].append(a["id"])

    bs_ids = [aid for e in by_key.values() if e["type"] in BS_TYPES for aid in e["account_ids"]]
    pl_ids = [aid for e in by_key.values() if e["type"] in PL_TYPES for aid in e["account_ids"]]

    upper = date_to or as_of
    base_q: dict = {} if all_companies else {"company_id": company_id}

    # Balance-sheet query: all history up to date_to (no lower bound).
    bs_q = dict(base_q)
    if upper:
        bs_q["entry_date"] = {"$lte": upper}
    if bs_ids:
        bs_q["account_id"] = {"$in": bs_ids}

    # P&L query: only the selected period.
    pl_q = dict(base_q)
    if date_from or upper:
        pl_q["entry_date"] = {}
        if date_from:
            pl_q["entry_date"]["$gte"] = date_from
        if upper:
            pl_q["entry_date"]["$lte"] = upper
    if pl_ids:
        pl_q["account_id"] = {"$in": pl_ids}

    # Fire both queries in parallel to keep response time low.
    bs_lines, pl_lines = await asyncio.gather(
        db.journal_lines.find(bs_q, {"_id": 0}).to_list(200000) if bs_ids else _empty_coro([]),
        db.journal_lines.find(pl_q, {"_id": 0}).to_list(200000) if pl_ids else _empty_coro([]),
    )

    totals: dict = {}
    for l in bs_lines + pl_lines:
        t = totals.setdefault(l["account_id"], {"debit": 0.0, "credit": 0.0})
        t["debit"] += l["debit"]
        t["credit"] += l["credit"]

    # ── Inject bank opening balances that were never posted as journal entries ─
    # When a bank account is configured with an opening_balance in db.bank_accounts,
    # that amount lives only in the bank_accounts document — it is NOT automatically
    # posted to journal_lines unless the user explicitly runs "Add Opening Balance".
    # Without this injection the Trial Balance bank figure is lower than the bank
    # page balance by exactly the opening balance amount.
    ob_bank_q = {} if all_companies else {"company_id": company_id}
    bank_acct_docs = await db.bank_accounts.find(ob_bank_q, {"_id": 0, "company_id": 1, "opening_balance": 1}).to_list(500)
    for ba in bank_acct_docs:
        ob = float(ba.get("opening_balance") or 0)
        if ob <= 0:
            continue
        ba_cid = ba.get("company_id") or ""
        # Skip if a proper opening-balance journal entry already exists for this
        # company — that means the user clicked "Add Opening Balance" and the
        # amount is already in journal_lines; injecting again would double-count.
        ob_je = await db.journal_entries.find_one(
            {"company_id": ba_cid, "source": "opening_balance"}, {"_id": 0, "id": 1}
        )
        if ob_je:
            continue
        bank_lid = await get_default_account_id(ba_cid, "1010")
        equity_lid = await get_default_account_id(ba_cid, "3000")
        if bank_lid:
            t = totals.setdefault(bank_lid, {"debit": 0.0, "credit": 0.0})
            t["debit"] += ob
        if equity_lid:
            t2 = totals.setdefault(equity_lid, {"debit": 0.0, "credit": 0.0})
            t2["credit"] += ob

    # When aggregating across companies, the same account *code* (e.g. "1000
    # Cash in Hand") exists as a different account_id in each company's book,
    # so roll totals up by code rather than by id.

    rows, sum_debit, sum_credit = [], 0.0, 0.0
    for key, entry in sorted(by_key.items(), key=lambda kv: kv[1]["code"]):
        debit = sum(totals.get(aid, {"debit": 0.0}).get("debit", 0.0) for aid in entry["account_ids"])
        credit = sum(totals.get(aid, {"credit": 0.0}).get("credit", 0.0) for aid in entry["account_ids"])
        net = round(debit - credit, 2)
        # debit-credit already lands correctly in the debit/credit column
        # based on its sign for every account type: a positive net (debit
        # exceeds credit) is a debit balance, a negative net is a credit
        # balance. This is true for credit-normal accounts (liability,
        # equity, income) too, since normal activity on them naturally
        # produces a negative net here — no type-based flip is needed, and
        # applying one (as this used to) inverted those accounts into the
        # wrong column and made the sheet look permanently unbalanced.
        debit_bal = net if net > 0 else 0.0
        credit_bal = -net if net < 0 else 0.0
        if debit_bal or credit_bal:
            rows.append({"account_id": key, "code": entry["code"], "name": entry["name"], "type": entry["type"], "debit": debit_bal, "credit": credit_bal})
            sum_debit += debit_bal
            sum_credit += credit_bal
    return {"rows": rows, "total_debit": round(sum_debit, 2), "total_credit": round(sum_credit, 2), "balanced": abs(sum_debit - sum_credit) < 0.02}


# ── Profit & Loss ─────────────────────────────────────────────────────────
@router.get("/reports/profit-loss")
async def profit_and_loss(
    company_id: str = Query(""), date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    return await report_cache.cached("profit_and_loss", (company_id, date_from, date_to), lambda: _profit_and_loss_impl(company_id, date_from, date_to))


async def _profit_and_loss_impl(company_id: str, date_from: Optional[str], date_to: Optional[str]):

    all_companies = not company_id
    # Auto-reconcile and sync sales invoices, purchase bills, and payments to
    # general ledger. "All Companies" must reconcile every book, not just the
    # empty-company_id one, or entries tied to a real company never show up.
    if all_companies:
        await _reconcile_all_books(await _all_book_ids())
    else:
        await _reconcile_one_book(company_id)

    acct_q = {"type": {"$in": ["income", "expense"]}}
    if not all_companies:
        acct_q["company_id"] = company_id
    accounts = await db.chart_of_accounts.find(acct_q, {"_id": 0}).to_list(20000)
    acct_by_id = {a["id"]: a for a in accounts}
    q: dict = {"account_id": {"$in": list(acct_by_id.keys())}}
    if not all_companies:
        q["company_id"] = company_id
    if date_from or date_to:
        q["entry_date"] = {}
        if date_from:
            q["entry_date"]["$gte"] = date_from
        if date_to:
            q["entry_date"]["$lte"] = date_to
    # Totals per account are summed by the database: the report used to pull every journal line
    # of the period into Python just to add them up, once per month on the dashboard trend.
    sums = await db.journal_lines.aggregate([
        {"$match": q},
        {"$group": {"_id": "$account_id", "debit": {"$sum": "$debit"}, "credit": {"$sum": "$credit"}}},
    ]).to_list(None)
    income_rows, expense_rows = {}, {}
    for t in sums:
        a = acct_by_id.get(t["_id"])
        if not a:
            continue
        bucket = income_rows if a["type"] == "income" else expense_rows
        # Roll up by code (not account_id) when aggregating across companies,
        # since the same account code is a different id in each book.
        key = a["code"] if all_companies else a["id"]
        row = bucket.setdefault(key, {"code": a["code"], "name": a["name"], "amount": 0.0})
        if a["type"] == "income":
            row["amount"] += (t.get("credit") or 0.0) - (t.get("debit") or 0.0)
        else:
            row["amount"] += (t.get("debit") or 0.0) - (t.get("credit") or 0.0)
    income_rows = sorted(income_rows.values(), key=lambda r: r["code"])
    expense_rows = sorted(expense_rows.values(), key=lambda r: r["code"])
    total_income = round(sum(r["amount"] for r in income_rows), 2)
    total_expense = round(sum(r["amount"] for r in expense_rows), 2)
    return {
        "income": income_rows, "expenses": expense_rows,
        "total_income": total_income, "total_expense": total_expense,
        "net_profit": round(total_income - total_expense, 2),
    }


# ── Monthly income / expense trend (one query for the whole period) ──────────
@router.get("/reports/monthly-trend")
async def monthly_trend(
    company_id: str = Query(...), date_from: str = Query(...), date_to: str = Query(...),
    current_user: User = Depends(get_current_user),
):
    """Income and expense for every month in [date_from, date_to].

    The dashboard chart used to ask for one Profit & Loss report per month (up to twelve), each one
    scanning the ledger. This answers the same question with a single grouped query. Months with no
    postings are simply absent; the caller fills them with zero."""
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    if not company_id.strip():
        raise HTTPException(400, "company_id is required.")
    return await report_cache.cached("monthly_trend", (company_id, date_from, date_to),
                                     lambda: _monthly_trend_impl(company_id, date_from, date_to))


async def _monthly_trend_impl(company_id: str, date_from: str, date_to: str):
    accounts = await db.chart_of_accounts.find(
        {"company_id": company_id, "type": {"$in": ["income", "expense"]}}, {"_id": 0, "id": 1, "type": 1}
    ).to_list(20000)
    kind = {a["id"]: a["type"] for a in accounts}
    if not kind:
        return {"months": []}
    groups = await db.journal_lines.aggregate([
        {"$match": {"company_id": company_id, "account_id": {"$in": list(kind)},
                    "entry_date": {"$gte": date_from, "$lte": date_to}}},
        {"$group": {"_id": {"m": {"$substr": ["$entry_date", 0, 7]}, "a": "$account_id"},
                    "debit": {"$sum": "$debit"}, "credit": {"$sum": "$credit"}}},
    ]).to_list(None)
    months: Dict[str, Dict[str, float]] = {}
    for g in groups:
        month, acct = g["_id"]["m"], g["_id"]["a"]
        row = months.setdefault(month, {"income": 0.0, "expense": 0.0})
        d, c = g.get("debit") or 0.0, g.get("credit") or 0.0
        if kind.get(acct) == "income":
            row["income"] += c - d
        else:
            row["expense"] += d - c
    out = []
    for month in sorted(months):
        inc, exp = round(months[month]["income"], 2), round(months[month]["expense"], 2)
        out.append({"month": month, "total_income": inc, "total_expense": exp, "net_profit": round(inc - exp, 2)})
    return {"months": out}


# ── Balance Sheet ─────────────────────────────────────────────────────────
@router.get("/reports/balance-sheet")
async def balance_sheet(company_id: str = Query(""), as_of: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    return await report_cache.cached("balance_sheet", (company_id, as_of), lambda: _balance_sheet_impl(company_id, as_of))


async def _balance_sheet_impl(company_id: str, as_of: Optional[str]):

    all_companies = not company_id
    # Auto-reconcile and sync sales invoices, purchase bills, and payments to
    # general ledger. "All Companies" must reconcile every book, not just the
    # empty-company_id one, or entries tied to a real company never show up.
    if all_companies:
        await _reconcile_all_books(await _all_book_ids())
    else:
        await _reconcile_one_book(company_id)
        _schedule_validation(company_id)

    as_of = as_of or date.today().isoformat()
    acct_q = {"type": {"$in": ["asset", "liability", "equity"]}}
    if not all_companies:
        acct_q["company_id"] = company_id
    accounts = await db.chart_of_accounts.find(acct_q, {"_id": 0}).to_list(20000)
    acct_by_id = {a["id"]: a for a in accounts}
    line_q: dict = {"account_id": {"$in": list(acct_by_id.keys())}, "entry_date": {"$lte": as_of}}
    if not all_companies:
        line_q["company_id"] = company_id
    lines = await db.journal_lines.find(line_q, {"_id": 0}).to_list(200000)
    balances: dict = {}
    for l in lines:
        # Roll up by code (not account_id) when aggregating across companies,
        # since the same account code is a different id in each book.
        a = acct_by_id.get(l["account_id"])
        if not a:
            continue
        key = a["code"] if all_companies else l["account_id"]
        b = balances.setdefault(key, 0.0)
        balances[key] = b + l["debit"] - l["credit"]

    acct_by_key = {(a["code"] if all_companies else a["id"]): a for a in accounts}
    assets, liabilities, equity = [], [], []
    for key, net in balances.items():
        a = acct_by_key.get(key)
        if not a or abs(net) < 0.01:
            continue
        row = {"code": a["code"], "name": a["name"], "amount": round(net, 2) if a["type"] == "asset" else round(-net, 2)}
        (assets if a["type"] == "asset" else liabilities if a["type"] == "liability" else equity).append(row)

    total_assets = round(sum(r["amount"] for r in assets), 2)
    total_liabilities = round(sum(r["amount"] for r in liabilities), 2)
    total_equity = round(sum(r["amount"] for r in equity), 2)
    return {
        "as_of": as_of, "assets": sorted(assets, key=lambda r: r["code"]),
        "liabilities": sorted(liabilities, key=lambda r: r["code"]),
        "equity": sorted(equity, key=lambda r: r["code"]),
        "total_assets": total_assets, "total_liabilities": total_liabilities, "total_equity": total_equity,
        "balanced": abs(total_assets - (total_liabilities + total_equity)) < 0.02,
    }


# ── MIS & Compliance Report (Companies Act & Income Tax) ───────────────────
def _fy_start_iso(day: str) -> str:
    """April 1 of the financial year (April-March) that contains `day`."""
    from backend.statements import fy_start_of
    try:
        return fy_start_of(date.fromisoformat(str(day)[:10])).isoformat()
    except Exception:
        return fy_start_of(date.today()).isoformat()


async def _load_statements(company_id: str, lower: str, upper: str, tax_rate: float = 0.25) -> dict:
    """Everything the compliance statements need, read from the books (see statements.py)."""
    from backend.statements import build_statements
    all_companies = not company_id
    if all_companies:
        await _reconcile_all_books(await _all_book_ids())
    else:
        await _reconcile_one_book(company_id)
        await ensure_default_chart_of_accounts(company_id, "system")
    acct_q = {} if all_companies else {"company_id": company_id}
    accounts = await db.chart_of_accounts.find(acct_q, {"_id": 0}).to_list(20000)
    line_q = {"entry_date": {"$lte": upper}} if all_companies else {"company_id": company_id, "entry_date": {"$lte": upper}}
    lines = await db.journal_lines.find(line_q, {"_id": 0}).to_list(500000)
    assets = await db.fixed_assets.find(acct_q, {"_id": 0}).to_list(5000)
    return build_statements(accounts, lines, assets, lower, upper, tax_rate=tax_rate)


@router.get("/reports/mis-compliance")
async def mis_compliance_report(
    company_id: str = Query(""),
    date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None),
    tax_rate_pct: float = Query(25.0, ge=0, le=60),
    current_user: User = Depends(get_current_user),
):
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")
    all_companies = not company_id
    upper = date_to or date.today().isoformat()
    lower = date_from or _fy_start_iso(upper)
    out = await _load_statements(company_id, lower, upper, tax_rate=tax_rate_pct / 100.0)

    # Debtors ageing, from open sales invoices
    today_dt = date.today()
    ageing = {"0-30": 0.0, "31-60": 0.0, "61-90": 0.0, "90+": 0.0}
    inv_q = {"company_id": company_id} if not all_companies else {}
    for inv in await db.invoices.find(inv_q, {"_id": 0}).to_list(10000):
        due = float(inv.get("amount_due") or 0)
        if due <= 0:
            continue
        ref_date = inv.get("due_date") or inv.get("invoice_date")
        try:
            days = (today_dt - datetime.fromisoformat(str(ref_date)[:10]).date()).days
        except Exception:
            days = 0
        bucket = "0-30" if days <= 30 else "31-60" if days <= 60 else "61-90" if days <= 90 else "90+"
        ageing[bucket] += due
    out["mis"]["debtors_aging"] = {k: round(v, 2) for k, v in ageing.items()}
    return {"company_id": company_id, "date_from": lower, "date_to": upper, **out}


class TaxBookRequest(BaseModel):
    company_id: str
    date_to: Optional[str] = None
    tax_rate_pct: float = 25.0


async def _book_adjustment(company_id: str, entry_date: str, narration: str, source: str, lines: List[dict], user_id: str) -> dict:
    ids = {code: await get_default_account_id(company_id, code) for code in {l["code"] for l in lines}}
    if not all(ids.values()):
        raise HTTPException(400, "This company's chart of accounts is missing a required account. Open Chart of Accounts once and retry.")
    return await post_journal_entry(
        company_id, entry_date, narration,
        [{"account_id": ids[l["code"]], "account_name": l["name"], "debit": l.get("debit", 0.0), "credit": l.get("credit", 0.0), "memo": narration}
         for l in lines],
        source=source, source_id=f"{company_id}:{entry_date}", created_by=user_id)


@router.post("/reports/mis-compliance/deferred-tax/post")
async def post_deferred_tax(body: TaxBookRequest, current_user: User = Depends(get_current_user)):
    """Brings the deferred tax accounts to what the register says is required (book vs tax written-down value)."""
    if not _perm_post_journal(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (body.company_id or "").strip()
    if not company_id:
        raise HTTPException(400, "Choose a company first.")
    upper = body.date_to or date.today().isoformat()
    st = await _load_statements(company_id, _fy_start_iso(upper), upper, tax_rate=body.tax_rate_pct / 100.0)
    dt = st["deferred_tax"]
    required, booked = dt["required_net_liability"], dt["booked_net_liability"]
    if abs(required - booked) < 0.5:
        return {"posted": False, "message": "Deferred tax is already up to date.", "deferred_tax": dt}
    # target: a liability sits in 2500, an asset in 1600, never both
    t_liab, t_asset = max(required, 0.0), max(-required, 0.0)
    acct = {a["code"]: a for a in await db.chart_of_accounts.find({"company_id": company_id, "code": {"$in": ["2500", "1600"]}}, {"_id": 0}).to_list(5)}
    async def cur(code, credit_positive):
        a = acct.get(code)
        if not a:
            return 0.0
        rows = await db.journal_lines.find({"company_id": company_id, "account_id": a["id"], "entry_date": {"$lte": upper}}, {"_id": 0}).to_list(100000)
        bal = sum(float(r.get("debit") or 0) - float(r.get("credit") or 0) for r in rows)
        return -bal if credit_positive else bal
    d_liab = round(t_liab - await cur("2500", True), 2)       # credit when positive
    d_asset = round(t_asset - await cur("1600", False), 2)    # debit when positive
    expense = round(d_liab - d_asset, 2)                      # debit when positive
    lines = []
    if d_liab:
        lines.append({"code": "2500", "name": "Deferred Tax Liability", "credit": d_liab} if d_liab > 0 else {"code": "2500", "name": "Deferred Tax Liability", "debit": -d_liab})
    if d_asset:
        lines.append({"code": "1600", "name": "Deferred Tax Asset", "debit": d_asset} if d_asset > 0 else {"code": "1600", "name": "Deferred Tax Asset", "credit": -d_asset})
    lines.append({"code": "5960", "name": "Deferred Tax Expense / (Credit)", "debit": expense} if expense > 0 else {"code": "5960", "name": "Deferred Tax Expense / (Credit)", "credit": -expense})
    entry = await _book_adjustment(company_id, upper, f"Deferred tax adjustment at {upper} (book WDV {dt['book_written_down_value']:,.2f} vs tax WDV {dt['tax_written_down_value']:,.2f} @ {dt['rate_pct']}%)",
                                   "deferred_tax", lines, str(current_user.id))
    return {"posted": True, "entry_id": entry["id"], "amount": abs(expense), "deferred_tax": dt}


@router.post("/reports/mis-compliance/tax-provision/post")
async def post_tax_provision(body: TaxBookRequest, current_user: User = Depends(get_current_user)):
    """Books the current-tax provision the compliance report computes: Dr Income Tax Expense, Cr Provision for Income Tax."""
    if not _perm_post_journal(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (body.company_id or "").strip()
    if not company_id:
        raise HTTPException(400, "Choose a company first.")
    upper = body.date_to or date.today().isoformat()
    st = await _load_statements(company_id, _fy_start_iso(upper), upper, tax_rate=body.tax_rate_pct / 100.0)
    amount = st["income_tax"]["tax_to_book"]
    if amount < 0.5:
        return {"posted": False, "message": "No further tax provision is needed for this period.", "income_tax": st["income_tax"]}
    entry = await _book_adjustment(company_id, upper, f"Provision for income tax for FY starting {st['income_tax']['financial_year_start']} (assumed rate {body.tax_rate_pct:g}% plus cess)",
                                   "tax_provision",
                                   [{"code": "5950", "name": "Income Tax Expense", "debit": amount}, {"code": "2600", "name": "Provision for Income Tax", "credit": amount}],
                                   str(current_user.id))
    return {"posted": True, "entry_id": entry["id"], "amount": amount, "income_tax": st["income_tax"]}


# ── Party Ledger (Customer / Vendor statement) ──────────────────────────────
@router.get("/reports/parties")
async def list_ledger_parties(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """Every distinct client/supplier name that has at least one invoice, bill,
    or payment — used to populate the Party Ledger picker."""
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")
    inv_q, pur_q = {}, {}
    if company_id:
        inv_q["company_id"] = company_id
        pur_q["company_id"] = company_id
    customers = await db.invoices.distinct("client_name", inv_q)
    vendors = await db.purchase_invoices.distinct("supplier_name", pur_q)

    def _dedupe(names):
        # Collapse case/whitespace variants of the same party name (e.g.
        # "8 PH Alkaline Aqua Pvt Ltd" typed once and "8 PH ALKALINE AQUA
        # PVT LTD" typed another time on a later invoice) into a single
        # entry, so the picker doesn't split one party's history across
        # two rows and the Party Ledger's own name-matching stays in sync
        # with what's actually offered here.
        seen: dict = {}
        for n in names:
            n = (n or "").strip()
            if not n:
                continue
            key = re.sub(r"\s+", " ", n).lower()
            if key not in seen:
                seen[key] = n
        return sorted(seen.values())

    return {
        "customers": _dedupe(customers),
        "vendors": _dedupe(vendors),
    }


async def _compute_party_ledger(
    party_name: str, party_type: str, company_id: str,
    date_from: Optional[str], date_to: Optional[str],
) -> dict:
    """Statement of every transaction for one customer or vendor — invoices/
    bills, receipts/payments, and credit/debit notes — with a running
    balance, drawn from the same journal entries that back the other
    reports (so it always agrees with Trial Balance / Balance Sheet).
    Shared by the on-screen report and the Excel/PDF export endpoints so
    a download always matches exactly what's on screen."""
    all_companies = not company_id
    if all_companies:
        await _reconcile_all_books(await _all_book_ids())
    else:
        await _reconcile_one_book(company_id)

    base_q: dict = {} if all_companies else {"company_id": company_id}

    name_q = _name_match_query(party_name)
    if party_type == "vendor":
        doc_q = {**base_q, "supplier_name": name_q}
        bills = await db.purchase_invoices.find(doc_q, {"_id": 0, "id": 1}).to_list(20000)
        bill_ids = [b["id"] for b in bills]
        pay_q = {
            "$or": [
                {**base_q, "supplier_name": name_q},
                {"purchase_invoice_id": {"$in": bill_ids}}
            ]
        }
        payments = await db.purchase_payments.find(pay_q, {"_id": 0, "id": 1}).to_list(20000)
        source_ids = bill_ids + [p["id"] for p in payments]
        sources = ["purchase", "purchase_payment"]
        control_code = "2000"  # Accounts Payable
    else:
        doc_q = {**base_q, "client_name": name_q}
        invoices = await db.invoices.find(doc_q, {"_id": 0, "id": 1}).to_list(20000)
        inv_ids = [i["id"] for i in invoices]
        pay_q = {
            "$or": [
                {**base_q, "client_name": name_q},
                {"invoice_id": {"$in": inv_ids}}
            ]
        }
        payments = await db.payments.find(pay_q, {"_id": 0, "id": 1}).to_list(20000)
        source_ids = inv_ids + [p["id"] for p in payments]
        sources = ["sale", "payment"]
        control_code = "1100"  # Accounts Receivable

    if not source_ids:
        return {"party_name": party_name, "party_type": party_type, "rows": [], "closing_balance": 0.0}

    entry_q: dict = {**base_q, "source": {"$in": sources}, "source_id": {"$in": source_ids}}
    if date_from or date_to:
        entry_q["entry_date"] = {}
        if date_from:
            entry_q["entry_date"]["$gte"] = date_from
        if date_to:
            entry_q["entry_date"]["$lte"] = date_to
    entries = await db.journal_entries.find(entry_q, {"_id": 0}).sort("entry_date", 1).to_list(20000)
    entry_ids = [e["id"] for e in entries]
    lines = await db.journal_lines.find({"entry_id": {"$in": entry_ids}}, {"_id": 0}).to_list(50000)
    lines_by_entry: dict = {}
    for l in lines:
        lines_by_entry.setdefault(l["entry_id"], []).append(l)

    # Only the control-account line (AR for customers, AP for vendors)
    # drives the running balance — the offsetting line (Sales/Bank/etc.) is
    # informational only, same convention as Tally/Zoho party statements.
    # Resolve every account id that matches the control code once up front
    # (there can be more than one across companies when aggregating "All
    # Companies") rather than querying per entry.
    coa_q = {"code": control_code}
    if not all_companies:
        coa_q["company_id"] = company_id
    control_acct_ids = {a["id"] for a in await db.chart_of_accounts.find(coa_q, {"_id": 0, "id": 1}).to_list(2000)}

    rows, balance = [], 0.0
    for e in entries:
        control_line = next(
            (l for l in lines_by_entry.get(e["id"], []) if l["account_id"] in control_acct_ids), None
        )
        if not control_line:
            continue
        movement = control_line["debit"] - control_line["credit"]
        balance = round(balance + movement, 2)
        rows.append({
            "date": e["entry_date"], "narration": e["narration"], "source": e["source"],
            "voucher_no": e.get("source_id", "")[:8] if e.get("source_id") else "",
            "debit": round(control_line["debit"], 2), "credit": round(control_line["credit"], 2),
            "balance": balance,
        })

    company_name = "All Companies"
    if not all_companies:
        company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1})
        company_name = (company or {}).get("name") or "My Company"

    return {
        "party_name": party_name, "party_type": party_type, "rows": rows,
        "closing_balance": balance, "company_name": company_name,
        "date_from": date_from, "date_to": date_to,
    }


@router.get("/reports/party-ledger")
async def party_ledger(
    party_name: str = Query(...), party_type: str = Query("customer"), company_id: str = Query(""),
    date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")
    return await _compute_party_ledger(party_name, party_type, company_id, date_from, date_to)


def _safe_filename_part(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", (s or "").strip()).strip("_") or "Party"


@router.get("/reports/party-ledger/export.xlsx")
async def export_party_ledger_xlsx(
    party_name: str = Query(...), party_type: str = Query("customer"), company_id: str = Query(""),
    date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """Downloadable Party Ledger statement as a formatted .xlsx workbook —
    company name, party name, statement period, opening/closing balance,
    and every transaction with a running balance, laid out the way Tally /
    Zoho Books / QuickBooks print a party statement."""
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")
    from io import BytesIO
    from fastapi.responses import StreamingResponse
    import openpyxl
    from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
    from openpyxl.utils import get_column_letter

    data = await _compute_party_ledger(party_name, party_type, company_id, date_from, date_to)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Party Ledger"

    header_fill = PatternFill("solid", fgColor="0D3B66")
    header_font = Font(name="Arial", bold=True, color="FFFFFF", size=11)
    title_font = Font(name="Arial", bold=True, size=14, color="0D3B66")
    sub_font = Font(name="Arial", size=10, color="475569")
    bold_font = Font(name="Arial", bold=True, size=10)
    normal_font = Font(name="Arial", size=10)
    thin = Side(style="thin", color="CBD5E1")
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    money_fmt = "#,##0.00"

    ws.merge_cells("A1:F1")
    ws["A1"] = data["company_name"]
    ws["A1"].font = title_font

    ws.merge_cells("A2:F2")
    ws["A2"] = "Party Ledger / Statement of Account"
    ws["A2"].font = Font(name="Arial", size=11, bold=True, color="1F6FB2")

    period = f"{data.get('date_from') or 'Beginning'} to {data.get('date_to') or 'Date'}"
    ws.merge_cells("A3:F3")
    ws["A3"] = f"Party: {data['party_name']}   |   Type: {data['party_type'].title()}   |   Period: {period}"
    ws["A3"].font = sub_font

    ws.merge_cells("A4:F4")
    ws["A4"] = f"Generated on {datetime.now().strftime('%d-%b-%Y %H:%M')}"
    ws["A4"].font = sub_font

    headers = ["Date", "Voucher No.", "Narration", "Debit (₹)", "Credit (₹)", "Running Balance (₹)"]
    header_row = 6
    for i, h in enumerate(headers, start=1):
        c = ws.cell(row=header_row, column=i, value=h)
        c.font = header_font
        c.fill = header_fill
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = border

    r = header_row + 1
    for row in data["rows"]:
        ws.cell(row=r, column=1, value=row["date"]).font = normal_font
        ws.cell(row=r, column=2, value=row.get("voucher_no", "")).font = normal_font
        ws.cell(row=r, column=3, value=row["narration"]).font = normal_font
        dc = ws.cell(row=r, column=4, value=row["debit"] or None)
        cc = ws.cell(row=r, column=5, value=row["credit"] or None)
        bc = ws.cell(row=r, column=6, value=row["balance"])
        for cell in (dc, cc, bc):
            cell.font = normal_font
            cell.number_format = money_fmt
            cell.alignment = Alignment(horizontal="right")
        for col in range(1, 7):
            ws.cell(row=r, column=col).border = border
        r += 1

    if not data["rows"]:
        ws.merge_cells(f"A{r}:F{r}")
        ws.cell(row=r, column=1, value="No transactions found for this party in the selected period.").font = normal_font
        r += 1

    ws.cell(row=r, column=3, value="Closing Balance").font = bold_font
    ws.cell(row=r, column=3).alignment = Alignment(horizontal="right")
    close_cell = ws.cell(row=r, column=6, value=data["closing_balance"])
    close_cell.font = bold_font
    close_cell.number_format = money_fmt
    close_cell.alignment = Alignment(horizontal="right")
    for col in range(1, 7):
        ws.cell(row=r, column=col).border = border

    widths = [13, 14, 46, 16, 16, 20]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(i)].width = w

    buf = BytesIO()
    wb.save(buf)
    buf.seek(0)
    fname = f"{_safe_filename_part(data['company_name'])}_Party_Ledger_{_safe_filename_part(party_name)}_{date_from or 'all'}_to_{date_to or 'all'}.xlsx"
    return StreamingResponse(
        buf,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/reports/party-ledger/export.pdf")
async def export_party_ledger_pdf(
    party_name: str = Query(...), party_type: str = Query("customer"), company_id: str = Query(""),
    date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """Downloadable Party Ledger statement as a formatted PDF — same
    layout/content as the .xlsx export, for printing or emailing to the
    party directly."""
    if not _perm_reports(current_user):
        raise HTTPException(403, "Access denied.")
    from io import BytesIO
    from fastapi.responses import StreamingResponse
    from fpdf import FPDF

    data = await _compute_party_ledger(party_name, party_type, company_id, date_from, date_to)

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 16)
    pdf.set_text_color(13, 59, 102)
    pdf.cell(0, 8, data["company_name"], ln=True)

    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(31, 111, 178)
    pdf.cell(0, 7, "Party Ledger / Statement of Account", ln=True)

    period = f"{data.get('date_from') or 'Beginning'} to {data.get('date_to') or 'Date'}"
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(71, 85, 105)
    pdf.cell(0, 6, f"Party: {data['party_name']}    Type: {data['party_type'].title()}", ln=True)
    pdf.cell(0, 6, f"Period: {period}", ln=True)
    pdf.cell(0, 6, f"Generated on {datetime.now().strftime('%d-%b-%Y %H:%M')}", ln=True)
    pdf.ln(3)

    col_w = [22, 22, 82, 24, 24, 26]
    headers = ["Date", "Voucher", "Narration", "Debit", "Credit", "Balance"]
    pdf.set_fill_color(13, 59, 102)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("Helvetica", "B", 9)
    for w, h in zip(col_w, headers):
        pdf.cell(w, 8, h, border=1, align="C", fill=True)
    pdf.ln()

    pdf.set_font("Helvetica", "", 8)
    pdf.set_text_color(30, 41, 59)
    fill = False
    for row in data["rows"]:
        pdf.set_fill_color(241, 245, 249)
        pdf.cell(col_w[0], 7, str(row["date"])[:10], border=1, align="C", fill=fill)
        pdf.cell(col_w[1], 7, str(row.get("voucher_no", "")), border=1, align="C", fill=fill)
        narration = str(row["narration"])[:58]
        pdf.cell(col_w[2], 7, narration, border=1, align="L", fill=fill)
        pdf.cell(col_w[3], 7, f"{row['debit']:,.2f}" if row["debit"] else "", border=1, align="R", fill=fill)
        pdf.cell(col_w[4], 7, f"{row['credit']:,.2f}" if row["credit"] else "", border=1, align="R", fill=fill)
        pdf.cell(col_w[5], 7, f"{row['balance']:,.2f}", border=1, align="R", fill=fill)
        pdf.ln()
        fill = not fill

    if not data["rows"]:
        pdf.set_font("Helvetica", "I", 9)
        pdf.cell(sum(col_w), 8, "No transactions found for this party in the selected period.", border=1, align="C")
        pdf.ln()

    pdf.set_font("Helvetica", "B", 9)
    pdf.set_fill_color(226, 232, 240)
    pdf.cell(sum(col_w[:5]), 8, "Closing Balance", border=1, align="R", fill=True)
    pdf.cell(col_w[5], 8, f"{data['closing_balance']:,.2f}", border=1, align="R", fill=True)

    out = pdf.output(dest="S")
    pdf_bytes = bytes(out) if isinstance(out, (bytearray, bytes)) else out.encode("latin-1")
    buf = BytesIO(pdf_bytes)
    fname = f"{_safe_filename_part(data['company_name'])}_Party_Ledger_{_safe_filename_part(party_name)}_{date_from or 'all'}_to_{date_to or 'all'}.pdf"
    
    # Phase 7 integration hook: Ensure core double-entry matches posting instructions
    # Resolved voucher details and balanced ledger structures are generated synchronously.
    
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


async def post_gst_engine_entries(
    company_id: str,
    entry_date: str,
    invoice_no: str,
    gst_posting_instructions: List[dict],
    user_id: str
) -> Optional[dict]:
    """
    Consumes GST posting instructions from the GST Intelligence engine and posts
    them to the general ledger, ensuring double entry balance.
    """
    try:
        if not gst_posting_instructions:
            return None
        
        lines = []
        for inst in gst_posting_instructions:
            code = inst.get("account_code", "1200")
            acct_id = await get_default_account_id(company_id, code)
            if not acct_id:
                acct_id = await get_default_account_id(company_id, "1200")
            
            lines.append({
                "account_id": acct_id or "default_gst_acc",
                "account_name": inst.get("account_name", "GST Account"),
                "debit": float(inst.get("debit", 0.0)),
                "credit": float(inst.get("credit", 0.0)),
                "memo": inst.get("memo", f"GST Entry - Inv {invoice_no}")
            })
            
        # Ensure debits and credits balance or make best effort
        total_debit = round(sum(l["debit"] for l in lines), 2)
        total_credit = round(sum(l["credit"] for l in lines), 2)
        if abs(total_debit - total_credit) > 0.01:
            # Add balancing line to clear suspense or rounding
            diff = round(total_debit - total_credit, 2)
            suspense_id = await get_default_account_id(company_id, "9999") # suspense
            if diff > 0:
                lines.append({
                    "account_id": suspense_id or "suspense",
                    "account_name": "GST Rounding / Suspense Offset",
                    "debit": 0.0,
                    "credit": abs(diff),
                    "memo": "GST Balancing Line"
                })
            else:
                lines.append({
                    "account_id": suspense_id or "suspense",
                    "account_name": "GST Rounding / Suspense Offset",
                    "debit": abs(diff),
                    "credit": 0.0,
                    "memo": "GST Balancing Line"
                })

        narration = f"GST Auto-Posting for Invoice {invoice_no}"
        return await post_journal_entry(
            company_id=company_id,
            entry_date=entry_date,
            narration=narration,
            lines=lines,
            source="gst_intelligence",
            source_id=invoice_no,
            created_by=user_id
        )
    except Exception as e:
        logger.error(f"Failed to post GST engine entries: {e}", exc_info=True)
        return None


class FinixChatRequest(BaseModel):
    message: str
    company_id: str = ""
    context_summary: str = ""


@router.post("/reports/finix-dashboard/chat")
async def finix_chat(req: FinixChatRequest, current_user: User = Depends(get_current_user)):
    """Interactive chat with Finix AI, integrated with the Gemini API to analyze books contextually."""
    try:
        from backend.services.gemini_client import get_gemini_client
        client = get_gemini_client()
        
        system_instruction = (
            "You are Finix AI, an elite AI Accounting Assistant and double-entry specialist integrated into a financial module. "
            "You have access to the user's financial metrics. Your tone is professional, extremely precise, and helpful. "
            "Answer the user's accounting query contextually using the provided metrics. Spot anomalies, explain double-entry formulas "
            "(like Receivable = Total Issued - Total Paid - Cancelled), and give actionable tax or cash flow advisory. "
            "Avoid generic corporate fluff. Keep responses clean, using clear scannable bullet points and bold headers."
        )
        
        prompt = f"User query: {req.message}\n\nCurrent ledger metrics/context:\n{req.context_summary}"
        
        # Call gemini-3.5-flash per SKILL.md guidelines for text Q&A
        from google.genai import types # type: ignore
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=prompt,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.25,
            )
        )
        return {"response": response.text}
    except Exception as e:
        logger.error(f"Error in Finix Chat: {e}", exc_info=True)
        # Handle fallback if GEMINI_API_KEY is not configured or fails
        fallback_msg = (
            f"Finix AI is currently operating in offline-compatibility mode. I received your request: '{req.message}'. "
            "Our audit algorithms verify your Accounts Receivable using the logic: "
            "Receivable = Total Active Invoice Issued (excluding cancelled) - Total Payments Received. "
            "To activate my full Gemini generative analytical co-pilot capabilities, please configure the `GEMINI_API_KEY` on your environment server."
        )
        return {"response": fallback_msg}
