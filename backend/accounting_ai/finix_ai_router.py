"""Finix AI Accounting workflow.

Natural language is used only to understand and propose an accounting action.
The existing party-ledger, chart-of-accounts and guarded journal-posting
boundary remain the source of truth for the actual books.
"""
from __future__ import annotations
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional
from fastapi import APIRouter, Depends, HTTPException
from backend.dependencies import db, get_current_user
from backend.modules.finix_ai.ai.models_finix_ai import FinixAIRequest, FinixAIPostRequest
from backend.models import User
from backend.accounting_core import get_default_account_id
from backend.party_ledgers import get_or_create_party_account
from backend.accounting_ai.finix_intelligence import FinixIntelligence
from backend.accounting_ai.finix_access import can_post_finix, can_view_finix, is_admin_role, permissions_dict

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Accounting"])


def _permissions(user: User) -> dict:
    return permissions_dict(user)


def _can_view(user: User) -> bool:
    return can_view_finix(user)


def _can_post(user: User) -> bool:
    return can_post_finix(user)


def _date(value: Optional[str]) -> str:
    try:
        return date.fromisoformat(str(value)[:10]).isoformat() if value else date.today().isoformat()
    except (TypeError, ValueError):
        return date.today().isoformat()


async def _account(company_id: str, code: str, name: str, debit: float = 0, credit: float = 0) -> dict:
    account_id = await get_default_account_id(company_id, code)
    if not account_id:
        raise HTTPException(500, f"Finix could not initialize accounting account {code} ({name}).")
    return {"account_id": account_id, "account_name": name, "debit": round(float(debit or 0), 2), "credit": round(float(credit or 0), 2)}


async def _party(company_id: str, name: str, party_type: str, debit: float = 0, credit: float = 0, created_by: str = "system") -> dict:
    party = await get_or_create_party_account(company_id, party_type, name, created_by=created_by)
    if not party:
        raise HTTPException(400, "Finix needs a valid customer/vendor name before preparing the voucher.")
    return {"account_id": party["account_id"], "account_name": party["account_name"], "debit": round(float(debit or 0), 2), "credit": round(float(credit or 0), 2)}


def _expense(text: str):
    value = str(text or "").lower()
    for words, account in (
        (("rent", "lease"), ("5200", "Rent Expense")),
        (("salary", "salaries", "payroll", "wages"), ("5100", "Salaries & Wages")),
        (("software", "saas", "cloud subscription"), ("5250", "Software & Cloud Expenses")),
        (("bank charge", "bank fee"), ("5400", "Bank Charges")),
        (("shipping", "freight", "courier"), ("5500", "Shipping & Freight")),
        (("travel", "conveyance", "taxi", "cab"), ("5600", "Travel & Conveyance")),
        (("office expense", "office supplies", "stationery"), ("5300", "Office & Admin Expenses")),
    ):
        if any(word in value for word in words):
            return account
    return None


def _tds_rate(text: str) -> Optional[float]:
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*%", str(text or ""))
    for value in matches:
        rate = float(value)
        if 0 < rate <= 100 and ("tds" in str(text or "").lower() or "tax deducted" in str(text or "").lower()):
            return rate
    return None


_AI_EVENTS = {"SALE", "PURCHASE", "PAYMENT", "RECEIPT", "BANK_CHARGE", "GST_PAYMENT", "TDS_PAYMENT", "FIXED_ASSET"}
_AI_PROMPT = """You are an Indian accountant. Read ONE business transaction written by a user and return JSON only:
{"event": one of SALE, PURCHASE, PAYMENT, RECEIPT, BANK_CHARGE, GST_PAYMENT, TDS_PAYMENT, FIXED_ASSET, UNKNOWN,
 "party_name": customer/vendor/payee name exactly as written or "",
 "gross_amount": total amount including GST as a number,
 "taxable_amount": amount before GST as a number,
 "gst_amount": GST amount as a number (0 if none),
 "gst_rate": GST % if stated else null,
 "tds_rate": TDS % if stated else null,
 "expense_head": for PAYMENT one of rent, salary, software, bank charges, freight, travel, office, other}
Rules: SALE = we invoiced/billed a customer. PURCHASE = a supplier billed us. PAYMENT = we paid money out for an expense.
RECEIPT = a customer paid us. Use only numbers present in the text (or computed from a stated GST rate);
if GST is "included", split it out; never invent a party or amount; use UNKNOWN when unsure.
Transaction: """


def _numbers_in(text: str) -> set:
    found = set()
    for raw in re.findall(r"\d[\d,]*(?:\.\d+)?", str(text or "")):
        try:
            found.add(round(float(raw.replace(",", "")), 2))
        except ValueError:
            pass
    lakh = re.findall(r"(\d+(?:\.\d+)?)\s*(lakh|lac|crore|cr)\b", str(text or "").lower())
    for n, unit in lakh:
        found.add(round(float(n) * (100000 if unit in ("lakh", "lac") else 10000000), 2))
    return found


async def _ai_interpret(text: str) -> Optional[dict]:
    """Gemini reads the sentence when the keyword rules could not. Its amounts must be the user's own
    figures (or follow from a stated GST rate); otherwise the result is not used."""
    try:
        from backend.services.gemini_client import gemini_text_json
        data = await gemini_text_json(_AI_PROMPT + text.strip()[:1500])
    except Exception:
        return None
    event = str(data.get("event") or "").upper()
    if event not in _AI_EVENTS:
        return None
    try:
        gross = round(float(data.get("gross_amount") or 0), 2)
        taxable = round(float(data.get("taxable_amount") or gross), 2)
        gst = round(float(data.get("gst_amount") or 0), 2)
    except (TypeError, ValueError):
        return None
    nums = _numbers_in(text)
    if gross <= 0 or not (gross in nums or taxable in nums) or abs(round(taxable + gst, 2) - gross) > 1.0:
        return None
    rate = data.get("gst_rate")
    if gst > 0 and taxable > 0:
        derived = round(gst / taxable * 100, 2)
        if rate is not None and abs(float(rate) - derived) > 0.6:
            return None
    party = str(data.get("party_name") or "").strip()
    if party and party.lower() not in text.lower():
        party = ""          # never accept a name the user did not write
    return {"success": True, "event": event, "amount": gross, "gross_amount": gross, "taxable_amount": taxable,
            "gst_amount": gst, "party_name": party, "tds_rate": data.get("tds_rate"),
            "expense_head": str(data.get("expense_head") or "").lower(), "interpreted_by": "gemini",
            "needs_clarification": [] if (party or event in ("BANK_CHARGE", "GST_PAYMENT", "TDS_PAYMENT", "PAYMENT"))
            else ["Who is the customer / supplier?"]}


async def _build_proposal(text: str, company_id: str, accounting_date: str, current_user: User) -> dict:
    interpretation = FinixIntelligence.interpret(text, default_company_id=company_id)
    if not interpretation.get("success") or str(interpretation.get("event") or "").upper() not in _AI_EVENTS:
        ai = await _ai_interpret(text)
        if ai and (ai["party_name"] or ai["event"] not in ("SALE", "PURCHASE", "RECEIPT", "FIXED_ASSET")):
            interpretation = {**interpretation, **ai}
    result = dict(interpretation)
    result.update({"company_id": company_id, "accounting_date": accounting_date, "interpretation": interpretation})
    if not interpretation.get("success"):
        result.update({"status": "REVIEW_REQUIRED", "agent_stage": "REVIEW_REQUIRED"})
        return result

    event = str(interpretation.get("event") or "").upper()
    amount = float(interpretation.get("amount") or 0)
    party_name = str(interpretation.get("party_name") or "").strip()
    lines = []
    tds_result = None

    if event == "SALE":
        taxable = float(interpretation.get("taxable_amount") or amount)
        gst_amt = float(interpretation.get("gst_amount") or 0)
        gross = float(interpretation.get("gross_amount") or amount)
        lines = [await _party(company_id, party_name, "customer", debit=gross, created_by=current_user.id), await _account(company_id, "4000", "Sales / Fee Income", credit=taxable)]
        if gst_amt > 0:
            lines.append(await _account(company_id, "2100", "GST Output Payable", credit=gst_amt))
    elif event == "PURCHASE":
        taxable = float(interpretation.get("taxable_amount") or amount)
        gst_amt = float(interpretation.get("gst_amount") or 0)
        gross = float(interpretation.get("gross_amount") or amount)
        lines = [await _account(company_id, "5000", "Purchases", debit=taxable)]
        if gst_amt > 0:
            lines.append(await _account(company_id, "1200", "GST Input Credit", debit=gst_amt))
        lines.append(await _party(company_id, party_name, "vendor", credit=gross, created_by=current_user.id))
    elif event == "PAYMENT":
        expense = _expense(text) or (_expense(f"{interpretation.get('expense_head')} expense") if interpretation.get("expense_head") else None)
        if not expense:
            result.update({"status": "REVIEW_REQUIRED", "agent_stage": "REVIEW_REQUIRED"})
            result["needs_clarification"] = list(result.get("needs_clarification") or []) + ["Which expense/account should this payment be charged to?"]
            return result
        code, name = expense
        rate = _tds_rate(text)
        if rate is None and interpretation.get("tds_rate"):
            try:
                rate = float(interpretation["tds_rate"]) if 0 < float(interpretation["tds_rate"]) <= 30 else None
            except (TypeError, ValueError):
                rate = None
        if rate:
            deduction = round(amount * rate / 100, 2)
            lines = [await _account(company_id, code, name, debit=amount), await _account(company_id, "2200", "TDS Payable", credit=deduction), await _account(company_id, "1010", "Bank Accounts", credit=amount - deduction)]
            tds_result = {"applicable": True, "rate": rate, "effective_rate": rate, "deduction_amount": deduction, "statutory_reference": "TDS payable"}
        else:
            lines = [await _account(company_id, code, name, debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "RECEIPT":
        lines = [await _account(company_id, "1010", "Bank Accounts", debit=amount), await _party(company_id, party_name, "customer", credit=amount, created_by=current_user.id)]
    elif event == "BANK_CHARGE":
        lines = [await _account(company_id, "5400", "Bank Charges", debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "GST_PAYMENT":
        lines = [await _account(company_id, "2100", "GST Output Payable", debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "TDS_PAYMENT":
        lines = [await _account(company_id, "2200", "TDS Payable", debit=amount), await _account(company_id, "1010", "Bank Accounts", credit=amount)]
    elif event == "FIXED_ASSET":
        lines = [await _account(company_id, "1300", "Fixed Assets", debit=amount), await _party(company_id, party_name, "vendor", credit=amount, created_by=current_user.id)]
    else:
        result.update({"status": "REVIEW_REQUIRED", "agent_stage": "REVIEW_REQUIRED"})
        return result

    debit = round(sum(float(x.get("debit") or 0) for x in lines), 2)
    credit = round(sum(float(x.get("credit") or 0) for x in lines), 2)
    if debit <= 0 or abs(debit - credit) > 0.01:
        raise HTTPException(500, "Finix generated an unbalanced accounting proposal and stopped safely.")

    now = datetime.now(timezone.utc).isoformat()
    proposal_id = str(uuid.uuid4())
    proposal = {"id": proposal_id, "company_id": company_id, "accounting_date": accounting_date, "narration": text.strip(), "event": event, "amount": float(interpretation.get("gross_amount") or amount), "party_name": party_name, "interpretation": interpretation, "lines": lines, "status": "PROPOSED", "created_by": current_user.id, "created_at": now, "updated_at": now, "source": "finix_ai_agent"}
    await db.finix_ai_proposals.insert_one(proposal)
    result.update({"success": True, "proposal_id": proposal_id, "status": "PROPOSED", "agent_stage": "PROPOSAL_READY", "lines": lines, "narration": text.strip(), "total_debit": debit, "total_credit": credit})
    result["on_approve"] = {
        "SALE": "Approve creates a DRAFT sales invoice (it appears in Sales and GSTR-1); check and send it from Sales.",
        "RECEIPT": "Approve records this receipt against the customer's open invoice.",
        "PURCHASE": "Supplier bills are booked from the bill itself: use Purchase → Upload bill so the bill number and GSTIN reach your input credit.",
        "FIXED_ASSET": "Assets are bought on a supplier bill: use Purchase → Upload bill and choose 'Capital asset'.",
    }.get(event, "Approve posts this journal entry.")
    if tds_result:
        result["tds_result"] = tds_result
    return result


@router.post("/interpret")
async def finix_ai_interpret(payload: FinixAIRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return await _build_proposal(payload.text.strip(), company_id, _date(payload.accounting_date), current_user)


@router.post("/propose")
async def finix_ai_propose(payload: FinixAIRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return await _build_proposal(payload.text.strip(), company_id, _date(payload.accounting_date), current_user)


# ── Approving a proposal ──────────────────────────────────────────────────────
# Sales, receipts and supplier bills are DOCUMENTS, not bare journal entries: a
# journal alone never reaches GSTR-1, the purchase register / input credit, the
# client and vendor pages or the invoice's outstanding. So:
#   SALE      -> a DRAFT sales invoice (edit / send it from Sales)
#   RECEIPT   -> a receipt recorded against that client's open invoice
#   PURCHASE / FIXED_ASSET -> booked from the supplier's bill in Purchase (bill no. + GSTIN needed for ITC)
#   expenses, bank charges, GST / TDS payments -> journal entry, as before.
def _http_detail(code: str, message: str, **extra) -> dict:
    return {"code": code, "message": message, **extra}


async def _create_draft_sale(proposal: dict, current_user: User) -> dict:
    from backend import invoicing as inv
    interp = proposal.get("interpretation") or {}
    cid = proposal["company_id"]
    party = str(proposal.get("party_name") or "").strip()
    if not party:
        raise HTTPException(409, detail=_http_detail("need_party", "Tell Finix which customer this sale is for."))
    taxable = round(float(interp.get("taxable_amount") or proposal.get("amount") or 0), 2)
    gst = round(float(interp.get("gst_amount") or 0), 2)
    rate = round(gst / taxable * 100, 2) if taxable > 0 and gst > 0 else 0.0
    client = await db.clients.find_one({"company_name": {"$regex": f"^{re.escape(party)}$", "$options": "i"}}, {"_id": 0})
    comp = await db.companies.find_one({"id": cid}, {"_id": 0, "gstin": 1})
    client_gstin = str((client or {}).get("client_gstin") or "").strip().upper()
    own_gstin = str((comp or {}).get("gstin") or "").strip().upper()
    inter = bool(client_gstin[:2].isdigit() and own_gstin[:2].isdigit() and client_gstin[:2] != own_gstin[:2])
    half = round(gst / 2, 2)
    item = inv.InvoiceItem(
        description=str(proposal.get("narration") or "Services")[:200], quantity=1, unit_price=taxable,
        taxable_value=taxable, gst_rate=rate, cgst_rate=0 if inter else rate / 2, sgst_rate=0 if inter else rate / 2,
        igst_rate=rate if inter else 0, cgst_amount=0 if inter else half, sgst_amount=0 if inter else round(gst - half, 2),
        igst_amount=gst if inter else 0, total_amount=round(taxable + gst, 2))
    day = proposal.get("accounting_date") or date.today().isoformat()
    data = inv.InvoiceCreate(
        company_id=cid, client_id=(client or {}).get("id"), client_name=(client or {}).get("company_name") or party,
        client_gstin=client_gstin, client_email=(client or {}).get("email") or "", client_phone=(client or {}).get("phone") or "",
        client_address=(client or {}).get("address") or "", client_state=(client or {}).get("state") or "",
        is_interstate=inter, invoice_date=day,
        due_date=(date.fromisoformat(day) + timedelta(days=30)).isoformat(),
        items=[item], gst_rate=rate, status="draft",
        notes=f"Drafted by Finix AI from: {str(proposal.get('narration') or '')[:300]}")
    created = await inv.create_invoice(data, current_user)
    doc = created if isinstance(created, dict) else created.model_dump()
    return {"type": "sales_invoice", "id": doc.get("id"), "invoice_no": doc.get("invoice_no"),
            "client_name": doc.get("client_name"), "grand_total": doc.get("grand_total"), "status": doc.get("status")}


async def _record_receipt(proposal: dict, current_user: User) -> dict:
    from backend import invoicing as inv
    cid = proposal["company_id"]
    party = str(proposal.get("party_name") or "").strip()
    amount = round(float(proposal.get("amount") or 0), 2)
    if not party:
        raise HTTPException(409, detail=_http_detail("need_party", "Tell Finix which customer paid."))
    open_invs = await db.invoices.find(
        {"company_id": cid, "client_name": {"$regex": f"^{re.escape(party)}$", "$options": "i"},
         "invoice_type": "tax_invoice", "status": {"$nin": ["paid", "cancelled"]}},
        {"_id": 0, "id": 1, "invoice_no": 1, "amount_due": 1, "grand_total": 1, "invoice_date": 1},
    ).sort("invoice_date", 1).to_list(200)
    def due(i):
        return float(i.get("amount_due") if i.get("amount_due") is not None else i.get("grand_total") or 0)
    exact = [i for i in open_invs if abs(due(i) - amount) <= 1.0]
    fits = [i for i in open_invs if due(i) + 1.0 >= amount]
    target = exact[0] if len(exact) == 1 else (fits[0] if len(open_invs) == 1 and fits else None)
    if not target:
        raise HTTPException(409, detail=_http_detail(
            "pick_invoice",
            ("No open invoice of " + party + " matches this receipt." if not open_invs else
             f"{party} has {len(open_invs)} open invoices; record this receipt against the right one in Sales."),
            open_invoices=[{"invoice_no": i.get("invoice_no"), "amount_due": due(i), "invoice_date": i.get("invoice_date")}
                           for i in open_invs[:20]]))
    pay = await inv.record_payment(inv.PaymentCreate(
        invoice_id=target["id"], amount=amount, payment_date=proposal.get("accounting_date") or date.today().isoformat(),
        payment_mode="neft", notes="Recorded by Finix AI"), current_user)
    return {"type": "receipt", "id": pay.get("id"), "invoice_no": target.get("invoice_no"), "amount": amount}


async def approve_proposal(proposal: dict, current_user: User, source_tag: str = "finix_ai") -> dict:
    status = str(proposal.get("status") or "")
    if status == "POSTED":
        return {"success": True, "status": "POSTED", "journal_entry": proposal.get("journal_entry"),
                "document": proposal.get("document")}
    if status != "PROPOSED":
        raise HTTPException(409, detail=_http_detail(
            "not_postable", f"This proposal is {status.lower().replace('_', ' ') or 'not ready'} and cannot be posted. Describe the transaction again."))
    event = str(proposal.get("event") or "").upper()
    entry, document = None, None
    if event in ("PURCHASE", "FIXED_ASSET"):
        raise HTTPException(409, detail=_http_detail(
            "use_purchase",
            "Book a supplier's bill from the bill itself (Purchase → Upload bill, or add it by hand) so its bill number "
            "and GSTIN reach the purchase register and your input tax credit. Nothing was posted."))
    if event == "SALE":
        document = await _create_draft_sale(proposal, current_user)
    elif event == "RECEIPT":
        document = await _record_receipt(proposal, current_user)
    else:
        try:
            from backend import accounting_core as ac
            entry = await ac.post_journal_entry(proposal["company_id"], proposal["accounting_date"], proposal["narration"],
                                                proposal["lines"], "ai_zero_touch", proposal["id"], current_user.id)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(500, f"Finix posting was blocked: {type(exc).__name__}: {exc}")
    now = datetime.now(timezone.utc).isoformat()
    await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {
        "status": "POSTED", "journal_entry": entry, "document": document, "posted_by": current_user.id,
        "posted_at": now, "updated_at": now,
        "audit": {"proposal_created_by": proposal.get("created_by"), "approved_by": current_user.id, "approved_at": now,
                  "accounting_date": proposal.get("accounting_date"),
                  "journal_entry_id": entry.get("id") if isinstance(entry, dict) else None,
                  "document": document, "source": source_tag}}})
    message = ("Draft sales invoice created: open it in Sales to check and send." if event == "SALE"
               else "Receipt recorded against the invoice." if event == "RECEIPT"
               else "Transaction posted through the governed accounting ledger.")
    return {"success": True, "status": "POSTED", "journal_entry": entry, "document": document, "message": message}


@router.post("/post")
async def finix_ai_post(payload: FinixAIPostRequest, current_user: User = Depends(get_current_user)):
    if not _can_post(current_user):
        raise HTTPException(403, "Posting requires journal-posting permission.")
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    if proposal.get("created_by") != current_user.id and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Only the proposal owner or an admin can post this proposal.")
    return await approve_proposal(proposal, current_user, "finix_ai")


@router.get("/proposal/{proposal_id}")
async def finix_ai_get_proposal(proposal_id: str, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    proposal = await db.finix_ai_proposals.find_one({"id": proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    return proposal


@router.get("/recent")
async def finix_ai_recent(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = (company_id or getattr(current_user, "company_id", "") or "").strip()
    return await db.finix_ai_proposals.find({"company_id": cid}, {"_id": 0}).sort("created_at", -1).to_list(50)


async def create_finix_ai_indexes():
    await db.finix_ai_proposals.create_index([("company_id", 1), ("created_at", -1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("status", 1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("source_id", 1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("status", 1), ("id", 1)])
