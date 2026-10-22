"""Core books: the day-to-day accounting a Tally user expects.

* Settings           - which standards the company follows (ICAI AS or Ind AS) and its accounting choices.
* Vouchers           - Payment, Receipt, Contra and Journal vouchers with Tally's rules, numbered per type per year.
* Period-end         - prepaid and outstanding expenses, accrued income, income received in advance, and the provision
                       for doubtful debts, each with an automatic reversal on the first day of the next period.
* Year-end           - a checklist of what is still open, then close (locks the year) and reopen.
* Groups             - Tally's group hierarchy and a group-wise trial balance.

Everything posts through ``accounting_core.post_journal_entry``, so period locks, tenant scoping, account validation
and the hash-chained audit trail apply exactly as they do to invoices and bank entries.
"""
from __future__ import annotations

import logging
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend import accounting_core as ac
from backend.account_classification import H_CASH, classify_account
from backend.dependencies import db, get_current_user
from backend.models import User
from backend.tally_groups import GROUPS, PRIMARY_ORDER, ancestors, group_of, side_of
from backend.voucher_numbering import VOUCHER_TYPES, fy_label, fy_short, format_number, stamp_voucher

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/accounting-books", tags=["Accounting Books"])

FRAMEWORKS = ("AS", "IND_AS")
DEFAULT_SETTINGS = {
    "framework": "AS",                  # "AS" = ICAI Accounting Standards, "IND_AS" = Indian Accounting Standards
    "inventory_method": "WEIGHTED_AVG",  # or "FIFO"
    "tax_rate_pct": 25.0,
    "capitalisation_threshold": 5000.0,
}


# ── permissions ─────────────────────────────────────────────────────────────────────────────────
def _perms(user: User) -> dict:
    p = user.permissions
    if isinstance(p, dict):
        return p
    return p.model_dump() if p else {}


def _can_view(user: User) -> bool:
    perms = _perms(user)
    return user.role == "admin" or bool(perms.get("can_view_accounting_reports") or perms.get("can_view_extended_accounts_reports")
                                        or perms.get("can_view_journal_entries"))


def _can_post(user: User) -> bool:
    return user.role == "admin" or bool(_perms(user).get("can_post_journal_entries"))


def _need_view(user: User) -> None:
    if not _can_view(user):
        raise HTTPException(403, "Access denied.")


def _need_post(user: User) -> None:
    if not _can_post(user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")


def _need_admin(user: User) -> None:
    if user.role != "admin":
        raise HTTPException(403, "Only an administrator can do this.")


# ── helpers ─────────────────────────────────────────────────────────────────────────────────────
def _company(company_id: str) -> str:
    cid = str(company_id or "").strip()
    if not cid:
        raise HTTPException(400, "Choose a company first.")
    return cid


def _parse_date(value: str, label: str = "Date") -> date:
    try:
        return date.fromisoformat(str(value or "").strip()[:10])
    except ValueError:
        raise HTTPException(400, f"{label} must be a valid date in YYYY-MM-DD format.")


def _fy_bounds(fy: str) -> tuple:
    try:
        start = int(str(fy).split("-")[0])
        return date(start, 4, 1), date(start + 1, 3, 31)
    except Exception:
        raise HTTPException(400, "Financial year must look like 2026-27.")


def _money(v) -> float:
    return round(float(v or 0), 2)


async def get_settings(company_id: str) -> dict:
    doc = await db.accounting_settings.find_one({"company_id": company_id}, {"_id": 0}) or {}
    return {**DEFAULT_SETTINGS, **{k: v for k, v in doc.items() if k in DEFAULT_SETTINGS}}


async def _accounts_by_id(company_id: str, ids: List[str]) -> Dict[str, dict]:
    rows = await db.chart_of_accounts.find({"company_id": company_id, "id": {"$in": list(set(ids))}}, {"_id": 0}).to_list(len(set(ids)) or 1)
    return {r["id"]: r for r in rows}


def _is_cash_bank(acct: dict) -> bool:
    return acct.get("type") == "asset" and classify_account(acct).get("schedule3_head") == H_CASH


async def _post(company_id: str, day: str, narration: str, lines: List[dict], source: str, source_id: str, user: User) -> dict:
    await ac.ensure_default_chart_of_accounts(company_id, "system")
    try:
        entry = await ac.post_journal_entry(company_id, day, narration, lines, source, source_id, str(user.id))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return entry


async def _default_id(company_id: str, code: str) -> str:
    aid = await ac.get_default_account_id(company_id, code)
    if not aid:
        raise HTTPException(400, f"This company's chart of accounts has no account {code}. Open Chart of Accounts once and retry.")
    return aid


async def _audit(company_id: str, user: User, action: str, entity: str, entity_id: str, payload: dict) -> None:
    try:
        from backend.accounting_extended import _audit as audit
        await audit(company_id, str(user.id), action, entity, entity_id, payload)
    except Exception:
        logger.warning("audit write failed for %s %s", action, entity_id, exc_info=True)


# ═══ Settings ═══════════════════════════════════════════════════════════════════════════════════
class SettingsUpdate(BaseModel):
    company_id: str
    framework: Optional[Literal["AS", "IND_AS"]] = None
    inventory_method: Optional[Literal["WEIGHTED_AVG", "FIFO"]] = None
    tax_rate_pct: Optional[float] = Field(None, ge=0, le=60)
    capitalisation_threshold: Optional[float] = Field(None, ge=0)


@router.get("/settings")
async def read_settings(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return {"company_id": _company(company_id), **(await get_settings(company_id))}


@router.put("/settings")
async def update_settings(body: SettingsUpdate, current_user: User = Depends(get_current_user)):
    _need_admin(current_user)
    cid = _company(body.company_id)
    changes = {k: v for k, v in body.model_dump(exclude={"company_id"}).items() if v is not None}
    if not changes:
        return {"company_id": cid, **(await get_settings(cid))}
    before = await get_settings(cid)
    await db.accounting_settings.update_one(
        {"company_id": cid}, {"$set": {**changes, "updated_by": str(current_user.id), "updated_at": datetime.now(timezone.utc).isoformat()},
                              "$setOnInsert": {"company_id": cid}}, upsert=True)
    after = await get_settings(cid)
    await _audit(cid, current_user, "SETTINGS_CHANGED", "accounting_settings", cid, {"before": before, "after": after})
    return {"company_id": cid, **after}


# ═══ Vouchers ═══════════════════════════════════════════════════════════════════════════════════
class ParticularLine(BaseModel):
    account_id: str
    amount: float = Field(gt=0)
    memo: str = ""


class JournalVoucherLine(BaseModel):
    account_id: str
    debit: float = Field(0, ge=0)
    credit: float = Field(0, ge=0)
    memo: str = ""


class VoucherCreate(BaseModel):
    company_id: str
    voucher_type: Literal["payment", "receipt", "contra", "journal"]
    date: str
    narration: str = ""
    reference_no: str = ""
    cash_bank_account_id: Optional[str] = None     # payment: paid from, receipt: received into, contra: transferred from
    to_account_id: Optional[str] = None            # contra: transferred to
    amount: Optional[float] = Field(None, gt=0)    # contra
    particulars: List[ParticularLine] = []         # payment: expenses/parties debited, receipt: parties/incomes credited
    lines: List[JournalVoucherLine] = []           # journal


@router.get("/vouchers/types")
async def voucher_types(current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return [{"kind": k, "name": v[0], "prefix": v[1], "manual": k in ("payment", "receipt", "contra", "journal")}
            for k, v in VOUCHER_TYPES.items()]


@router.post("/vouchers")
async def create_voucher(body: VoucherCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    day = _parse_date(body.date).isoformat()
    kind = body.voucher_type
    narration = (body.narration or "").strip() or f"{VOUCHER_TYPES[kind][0]} voucher"

    wanted: List[str] = []
    if body.cash_bank_account_id:
        wanted.append(body.cash_bank_account_id)
    if body.to_account_id:
        wanted.append(body.to_account_id)
    wanted += [p.account_id for p in body.particulars] + [l.account_id for l in body.lines]
    accts = await _accounts_by_id(cid, wanted)
    for aid in wanted:
        if aid not in accts:
            raise HTTPException(400, "One of the accounts does not belong to this company.")

    lines: List[dict] = []
    if kind in ("payment", "receipt"):
        if not body.cash_bank_account_id:
            raise HTTPException(400, "Choose the cash or bank account.")
        cash = accts[body.cash_bank_account_id]
        if not _is_cash_bank(cash):
            raise HTTPException(400, f"{cash.get('name')} is not a cash or bank account.")
        if not body.particulars:
            raise HTTPException(400, "Add at least one account in Particulars.")
        for p in body.particulars:
            if _is_cash_bank(accts[p.account_id]):
                raise HTTPException(400, "Moving money between cash and bank accounts is a Contra voucher, not a " + kind + ".")
        total = _money(sum(p.amount for p in body.particulars))
        pay = kind == "payment"
        for p in body.particulars:
            lines.append({"account_id": p.account_id, "debit": _money(p.amount) if pay else 0.0, "credit": 0.0 if pay else _money(p.amount), "memo": p.memo})
        lines.append({"account_id": cash["id"], "debit": 0.0 if pay else total, "credit": total if pay else 0.0, "memo": narration})
    elif kind == "contra":
        if not (body.cash_bank_account_id and body.to_account_id and body.amount):
            raise HTTPException(400, "A contra needs a from account, a to account and an amount.")
        if body.cash_bank_account_id == body.to_account_id:
            raise HTTPException(400, "A contra needs two different accounts.")
        for aid in (body.cash_bank_account_id, body.to_account_id):
            if not _is_cash_bank(accts[aid]):
                raise HTTPException(400, f"{accts[aid].get('name')} is not a cash or bank account. A contra moves money between cash and bank accounts only.")
        amt = _money(body.amount)
        lines = [{"account_id": body.to_account_id, "debit": amt, "credit": 0.0, "memo": narration},
                 {"account_id": body.cash_bank_account_id, "debit": 0.0, "credit": amt, "memo": narration}]
    else:  # journal
        if len(body.lines) < 2:
            raise HTTPException(400, "A journal needs at least two lines.")
        for l in body.lines:
            if _is_cash_bank(accts[l.account_id]):
                raise HTTPException(400, "A journal cannot touch cash or bank accounts. Use a Payment, Receipt or Contra voucher.")
            if (l.debit > 0) == (l.credit > 0):
                raise HTTPException(400, "Each journal line needs either a debit or a credit amount, not both or neither.")
        lines = [{"account_id": l.account_id, "debit": _money(l.debit), "credit": _money(l.credit), "memo": l.memo} for l in body.lines]

    voucher_id = str(uuid.uuid4())
    entry = await _post(cid, day, narration, lines, f"voucher_{kind}", voucher_id, current_user)
    if body.reference_no.strip():
        await db.journal_entries.update_one({"id": entry["id"]}, {"$set": {"reference_no": body.reference_no.strip()}})
        entry["reference_no"] = body.reference_no.strip()
    await _audit(cid, current_user, "VOUCHER_CREATED", "journal_entry", entry["id"],
                 {"voucher_type": kind, "voucher_no": entry.get("voucher_no"), "amount": entry.get("total_debit")})
    return {k: v for k, v in entry.items() if k != "lines"} | {"lines": [
        {k: v for k, v in l.items() if k in ("account_id", "account_name", "debit", "credit", "memo")} for l in entry.get("lines", [])]}


@router.get("/vouchers")
async def list_vouchers(
    company_id: str = Query(""), voucher_type: Optional[str] = Query(None), date_from: Optional[str] = Query(None),
    date_to: Optional[str] = Query(None), search: Optional[str] = Query(None),
    page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=500),
    current_user: User = Depends(get_current_user),
):
    _need_view(current_user)
    cid = _company(company_id)
    q: dict = {"company_id": cid, "voucher_no": {"$nin": [None, ""]}}
    if voucher_type:
        if voucher_type not in VOUCHER_TYPES:
            raise HTTPException(400, "Unknown voucher type.")
        q["voucher_type"] = voucher_type
    if date_from or date_to:
        q["entry_date"] = {}
        if date_from:
            q["entry_date"]["$gte"] = date_from
        if date_to:
            q["entry_date"]["$lte"] = date_to
    if search:
        import re
        rx = {"$regex": re.escape(search.strip()), "$options": "i"}
        q["$or"] = [{"voucher_no": rx}, {"narration": rx}, {"reference_no": rx}]
    total = await db.journal_entries.count_documents(q)
    rows = await db.journal_entries.find(q, {"_id": 0}).sort([("entry_date", -1), ("voucher_no", -1)]).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    return {"vouchers": rows, "total": total, "page": page, "page_size": page_size, "total_pages": max(1, -(-total // page_size))}


@router.post("/vouchers/{entry_id}/cancel")
async def cancel_voucher(entry_id: str, reason: str = Query("", max_length=300), current_user: User = Depends(get_current_user)):
    """Cancels a voucher by posting its mirror image. The original stays in the books and keeps its number, so the
    sequence has no gaps and the audit trail shows exactly what happened."""
    _need_post(current_user)
    entry = await db.journal_entries.find_one({"id": entry_id}, {"_id": 0})
    if not entry:
        raise HTTPException(404, "Voucher not found.")
    if not str(entry.get("source") or "").startswith("voucher_"):
        raise HTTPException(400, "Only vouchers entered here can be cancelled here. Correct invoices and payments at their own page.")
    from backend.accounting_lock import reverse_journal_entry
    try:
        rev = await reverse_journal_entry(entry_id, reason.strip() or "Voucher cancelled", str(current_user.id))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await _audit(entry.get("company_id", ""), current_user, "VOUCHER_CANCELLED", "journal_entry", entry_id,
                 {"voucher_no": entry.get("voucher_no"), "reason": reason})
    return {"cancelled": entry_id, "voucher_no": entry.get("voucher_no"), "reversal": rev}


@router.post("/vouchers/backfill")
async def backfill_voucher_numbers(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """Numbers entries posted before voucher numbering existed, oldest first, so each type's sequence follows the
    calendar. Entries that already have a number are left alone. Safe to run more than once."""
    _need_admin(current_user)
    cid = _company(company_id)
    rows = await db.journal_entries.find({"company_id": cid, "$or": [{"voucher_no": {"$exists": False}}, {"voucher_no": None}, {"voucher_no": ""}]},
                                         {"_id": 0}).sort([("entry_date", 1), ("created_at", 1)]).to_list(200000)
    if not rows:
        return {"numbered": 0}
    accts = {a["id"]: a for a in await db.chart_of_accounts.find({"company_id": cid}, {"_id": 0}).to_list(20000)}
    lines_by_entry: Dict[str, list] = defaultdict(list)
    for l in await db.journal_lines.find({"company_id": cid, "entry_id": {"$in": [r["id"] for r in rows]}}, {"_id": 0}).to_list(1000000):
        lines_by_entry[l["entry_id"]].append(l)
    numbered = 0
    for e in rows:
        try:
            d = date.fromisoformat(str(e.get("entry_date"))[:10])
        except ValueError:
            continue
        legs = []
        for l in lines_by_entry.get(e["id"], []):
            a = accts.get(l.get("account_id")) or {}
            legs.append((float(l.get("debit") or 0), float(l.get("credit") or 0), bool(a) and _is_cash_bank(a)))
        kind, number = await stamp_voucher(db, cid, str(e.get("source") or "manual"), e.get("source_id"), d, legs)
        await db.journal_entries.update_one({"id": e["id"]}, {"$set": {"voucher_type": kind, "voucher_no": number}})
        numbered += 1
    return {"numbered": numbered}


# ═══ Period-end adjustments ═════════════════════════════════════════════════════════════════════
ADJUSTMENT_KINDS = {
    "prepaid_expense": "Expense paid in advance (prepaid)",
    "outstanding_expense": "Expense incurred but not yet paid (outstanding)",
    "accrued_income": "Income earned but not yet received (accrued)",
    "income_received_in_advance": "Income received in advance",
    "provision_doubtful_debts": "Provision for doubtful debts",
}


class AdjustmentCreate(BaseModel):
    company_id: str
    kind: Literal["prepaid_expense", "outstanding_expense", "accrued_income", "income_received_in_advance", "provision_doubtful_debts"]
    as_of: str
    amount: Optional[float] = Field(None, gt=0)           # all kinds except the provision
    target_balance: Optional[float] = Field(None, ge=0)   # provision: what the provision account should stand at
    account_id: Optional[str] = None                      # the expense or income ledger being adjusted
    narration: str = ""
    auto_reverse: Optional[bool] = None                   # default: true for accruals and prepayments
    allow_duplicate: bool = False


async def _balance(company_id: str, account_id: str, upto: str) -> float:
    """Debit minus credit up to a date."""
    rows = await db.journal_lines.find({"company_id": company_id, "account_id": account_id, "entry_date": {"$lte": upto}}, {"_id": 0, "debit": 1, "credit": 1}).to_list(500000)
    return _money(sum(float(r.get("debit") or 0) - float(r.get("credit") or 0) for r in rows))


@router.get("/period-end/kinds")
async def adjustment_kinds(current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return [{"kind": k, "label": v, "needs_account": k != "provision_doubtful_debts",
             "account_type": {"prepaid_expense": "expense", "outstanding_expense": "expense", "accrued_income": "income",
                              "income_received_in_advance": "income"}.get(k),
             "reverses_automatically": k != "provision_doubtful_debts"} for k, v in ADJUSTMENT_KINDS.items()]


@router.post("/period-end/adjustments")
async def create_adjustment(body: AdjustmentCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    as_of = _parse_date(body.as_of, "As-of date")
    narr = body.narration.strip()
    adj_id = str(uuid.uuid4())
    reverse = body.auto_reverse if body.auto_reverse is not None else body.kind != "provision_doubtful_debts"
    if body.kind == "provision_doubtful_debts" and reverse:
        raise HTTPException(400, "A provision stays on the books until you change it. Post a new target balance to adjust it.")

    if body.kind == "provision_doubtful_debts":
        if body.target_balance is None:
            raise HTTPException(400, "Enter the balance the provision should stand at.")
        prov_id, exp_id = await _default_id(cid, "1150"), await _default_id(cid, "5970")
        current = -(await _balance(cid, prov_id, as_of.isoformat()))          # a provision has a credit balance
        delta = _money(float(body.target_balance) - current)
        if abs(delta) < 0.01:
            return {"posted": False, "message": f"The provision already stands at {current:,.2f}.", "current_balance": current}
        text = narr or ("Provision for doubtful debts increased" if delta > 0 else "Provision for doubtful debts no longer required")
        lines = ([{"account_id": exp_id, "debit": delta, "credit": 0.0, "memo": text}, {"account_id": prov_id, "debit": 0.0, "credit": delta, "memo": text}]
                 if delta > 0 else
                 [{"account_id": prov_id, "debit": -delta, "credit": 0.0, "memo": text}, {"account_id": exp_id, "debit": 0.0, "credit": -delta, "memo": text}])
        entry = await _post(cid, as_of.isoformat(), text, lines, "period_end", adj_id, current_user)
        doc = {"id": adj_id, "company_id": cid, "kind": body.kind, "as_of": as_of.isoformat(), "amount": abs(delta), "target_balance": _money(body.target_balance),
               "previous_balance": current, "account_id": None, "entry_id": entry["id"], "reversal_entry_id": None, "auto_reverse": False,
               "status": "active", "narration": text, "created_by": str(current_user.id), "created_at": datetime.now(timezone.utc).isoformat()}
        await db.period_end_adjustments.insert_one(dict(doc))
        await _audit(cid, current_user, "PERIOD_END_ADJUSTMENT", "period_end_adjustments", adj_id, {"kind": body.kind, "delta": delta})
        return {"posted": True, "adjustment": doc, "voucher_no": entry.get("voucher_no")}

    if not body.amount or not body.account_id:
        raise HTTPException(400, "Enter the amount and choose the ledger it relates to.")
    acct = (await _accounts_by_id(cid, [body.account_id])).get(body.account_id)
    if not acct:
        raise HTTPException(400, "That account does not belong to this company.")
    needs = "expense" if body.kind in ("prepaid_expense", "outstanding_expense") else "income"
    if acct.get("type") != needs:
        raise HTTPException(400, f"Choose an {needs} account. {acct.get('name')} is {acct.get('type')}.")
    amount = _money(body.amount)
    if not body.allow_duplicate:
        dup = await db.period_end_adjustments.find_one({"company_id": cid, "kind": body.kind, "as_of": as_of.isoformat(), "account_id": body.account_id,
                                                        "amount": amount, "status": "active"}, {"_id": 0, "id": 1})
        if dup:
            raise HTTPException(409, "An identical adjustment is already recorded for this date. Tick 'record again' if this is a second one.")

    bs_code = {"prepaid_expense": "1500", "outstanding_expense": "2300", "accrued_income": "1550", "income_received_in_advance": "2350"}[body.kind]
    bs_id = await _default_id(cid, bs_code)
    label = ADJUSTMENT_KINDS[body.kind]
    text = narr or f"{label}: {acct.get('name')}"
    if body.kind == "prepaid_expense":        # carry part of the expense forward
        lines = [{"account_id": bs_id, "debit": amount, "credit": 0.0, "memo": text}, {"account_id": acct["id"], "debit": 0.0, "credit": amount, "memo": text}]
    elif body.kind == "outstanding_expense":  # recognise an expense not yet billed or paid
        lines = [{"account_id": acct["id"], "debit": amount, "credit": 0.0, "memo": text}, {"account_id": bs_id, "debit": 0.0, "credit": amount, "memo": text}]
    elif body.kind == "accrued_income":       # recognise income earned but not yet billed
        lines = [{"account_id": bs_id, "debit": amount, "credit": 0.0, "memo": text}, {"account_id": acct["id"], "debit": 0.0, "credit": amount, "memo": text}]
    else:                                     # defer income received for a later period
        lines = [{"account_id": acct["id"], "debit": amount, "credit": 0.0, "memo": text}, {"account_id": bs_id, "debit": 0.0, "credit": amount, "memo": text}]

    entry = await _post(cid, as_of.isoformat(), text, lines, "period_end", adj_id, current_user)
    reversal_entry, warning = None, None
    if reverse:
        mirror = [{**l, "debit": l["credit"], "credit": l["debit"], "memo": f"Reversal: {l['memo']}"} for l in lines]
        try:
            reversal_entry = await ac.post_journal_entry(cid, (as_of + timedelta(days=1)).isoformat(), f"Reversal of: {text}", mirror, "period_end_reversal", adj_id, str(current_user.id))
        except ValueError as exc:
            warning = f"The adjustment is posted, but its reversal on {(as_of + timedelta(days=1)).isoformat()} could not be: {exc}. Post it by hand once that period is open."
    doc = {"id": adj_id, "company_id": cid, "kind": body.kind, "as_of": as_of.isoformat(), "amount": amount, "account_id": acct["id"],
           "account_name": acct.get("name"), "entry_id": entry["id"], "reversal_entry_id": (reversal_entry or {}).get("id"), "auto_reverse": reverse,
           "reversal_pending": bool(reverse and not reversal_entry), "status": "active", "narration": text,
           "created_by": str(current_user.id), "created_at": datetime.now(timezone.utc).isoformat()}
    await db.period_end_adjustments.insert_one(dict(doc))
    await _audit(cid, current_user, "PERIOD_END_ADJUSTMENT", "period_end_adjustments", adj_id, {"kind": body.kind, "amount": amount, "account": acct.get("name")})
    return {"posted": True, "adjustment": doc, "voucher_no": entry.get("voucher_no"), "warning": warning}


@router.get("/period-end/adjustments")
async def list_adjustments(company_id: str = Query(""), fy: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    q: dict = {"company_id": cid}
    if fy:
        lo, hi = _fy_bounds(fy)
        q["as_of"] = {"$gte": lo.isoformat(), "$lte": hi.isoformat()}
    return await db.period_end_adjustments.find(q, {"_id": 0}).sort("as_of", -1).to_list(2000)


@router.post("/period-end/adjustments/{adj_id}/cancel")
async def cancel_adjustment(adj_id: str, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    adj = await db.period_end_adjustments.find_one({"id": adj_id}, {"_id": 0})
    if not adj:
        raise HTTPException(404, "Adjustment not found.")
    if adj.get("status") == "cancelled":
        return {"cancelled": True, "already": True}
    from backend.accounting_lock import reverse_journal_entry
    reversed_ids = []
    # undo the automatic reversal first (if it was posted), then the adjustment itself
    for key in ("reversal_entry_id", "entry_id"):
        if adj.get(key):
            try:
                reversed_ids.append((await reverse_journal_entry(adj[key], f"Adjustment cancelled: {adj.get('narration', '')}", str(current_user.id))).get("id"))
            except ValueError as exc:
                raise HTTPException(400, str(exc))
    await db.period_end_adjustments.update_one({"id": adj_id}, {"$set": {"status": "cancelled", "cancelled_by": str(current_user.id),
                                                                         "cancelled_at": datetime.now(timezone.utc).isoformat()}})
    await _audit(adj["company_id"], current_user, "PERIOD_END_ADJUSTMENT_CANCELLED", "period_end_adjustments", adj_id, {})
    return {"cancelled": True, "reversal_entries": reversed_ids}


# ═══ Groups ═════════════════════════════════════════════════════════════════════════════════════
def _tree(rows: Dict[str, dict]) -> List[dict]:
    """Nest group totals under their parents, in Tally's order."""
    nodes: Dict[str, dict] = {}
    for name in GROUPS:
        nodes[name] = {"group": name, "side": side_of(name), "debit": 0.0, "credit": 0.0, "closing": 0.0, "accounts": [], "children": []}
    for name, r in rows.items():
        n = nodes[name]
        n["accounts"] = r["accounts"]
        n["net"] = r["debit"] - r["credit"]
    # roll each group's own balance up through its ancestors
    for name, r in rows.items():
        for anc in ancestors(name)[1:]:
            nodes[anc]["net"] = nodes[anc].get("net", 0.0) + (r["debit"] - r["credit"])
    for name, parent in ((n, GROUPS[n][0]) for n in GROUPS):
        if parent:
            nodes[parent]["children"].append(nodes[name])
    for n in nodes.values():
        # Like Tally, a group shows the balance of everything in it (debtors less their provision), not the two sides.
        net = _money(n.pop("net", 0.0))
        n["closing"] = net
        n["debit"], n["credit"] = (net, 0.0) if net > 0 else (0.0, -net)
    for n in nodes.values():       # only after every group is finalised, drop the empty ones
        n["children"] = [c for c in n["children"] if c["debit"] or c["credit"] or c["children"]]
    return [nodes[g] for g in PRIMARY_ORDER if nodes[g]["debit"] or nodes[g]["credit"]]


@router.get("/groups")
async def group_hierarchy(current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return [{"group": g, "parent": p, "side": s} for g, (p, s) in GROUPS.items()]


_BF_ID = "pl-brought-forward"


@router.get("/groups/trial-balance")
async def group_trial_balance(
    company_id: str = Query(""), date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    """Tally's trial balance: closing balance by group, with the ledgers inside each group.

    Balance-sheet ledgers carry their balance from the start of the books; income and expense ledgers cover the
    financial year containing ``date_to`` (or the dates given), because each year's profit starts again at nil.
    """
    _need_view(current_user)
    cid = _company(company_id)
    upper = _parse_date(date_to).isoformat() if date_to else date.today().isoformat()
    from backend.statements import fy_start_of
    lower = _parse_date(date_from).isoformat() if date_from else fy_start_of(date.fromisoformat(upper)).isoformat()
    await ac.ensure_default_chart_of_accounts(cid, "system")
    accounts = {a["id"]: a for a in await db.chart_of_accounts.find({"company_id": cid}, {"_id": 0}).to_list(20000)}
    lines = await db.journal_lines.find({"company_id": cid, "entry_date": {"$lte": upper}}, {"_id": 0}).to_list(1000000)
    net: Dict[str, float] = defaultdict(float)
    carried = 0.0           # profit or loss of earlier years: it lives on in reserves
    for l in lines:
        a = accounts.get(l.get("account_id"))
        if not a:
            continue
        amount = float(l.get("debit") or 0) - float(l.get("credit") or 0)
        if a.get("type") in ("income", "expense") and str(l.get("entry_date")) < lower:
            carried += amount
            continue
        net[a["id"]] += amount
    if abs(carried) >= 0.005:
        net[_BF_ID] = carried
        accounts[_BF_ID] = {"id": _BF_ID, "code": "", "name": "Profit & Loss A/c (brought forward)", "type": "equity",
                            "schedule3_head": "Reserves and surplus", "cost_type": None}
    rows: Dict[str, dict] = {}
    for aid, bal in net.items():
        if abs(bal) < 0.005:
            continue
        a = accounts[aid]
        g = group_of(a)
        r = rows.setdefault(g, {"debit": 0.0, "credit": 0.0, "accounts": []})
        dr, cr = (bal, 0.0) if bal > 0 else (0.0, -bal)
        r["debit"] += dr
        r["credit"] += cr
        r["accounts"].append({"account_id": aid, "code": a.get("code"), "name": a.get("name"), "debit": _money(dr), "credit": _money(cr)})
    for r in rows.values():
        r["accounts"].sort(key=lambda x: str(x["code"]))
    tree = _tree(rows)
    total_dr = _money(sum(r["debit"] for r in rows.values()))
    total_cr = _money(sum(r["credit"] for r in rows.values()))
    return {"company_id": cid, "date_from": lower, "date_to": upper, "groups": tree,
            "total_debit": total_dr, "total_credit": total_cr, "balanced": abs(total_dr - total_cr) < 0.02}


# ═══ Year-end ═══════════════════════════════════════════════════════════════════════════════════
async def _year_checklist(company_id: str, fy: str) -> List[dict]:
    lo, hi = _fy_bounds(fy)
    lo_s, hi_s = lo.isoformat(), hi.isoformat()
    items: List[dict] = []

    def add(code, severity, title, detail, count=None):
        items.append({"code": code, "severity": severity, "title": title, "detail": detail, **({"count": count} if count is not None else {})})

    lines = await db.journal_lines.find({"company_id": company_id, "entry_date": {"$gte": lo_s, "$lte": hi_s}}, {"_id": 0, "debit": 1, "credit": 1}).to_list(1000000)
    dr, cr = sum(float(l.get("debit") or 0) for l in lines), sum(float(l.get("credit") or 0) for l in lines)
    if abs(dr - cr) > 0.02:
        add("unbalanced", "blocker", "Debits and credits differ", f"Debits {dr:,.2f} and credits {cr:,.2f} differ by {abs(dr - cr):,.2f}. Run Verify & Fix in Accounting Reports.")

    sus = await db.chart_of_accounts.find_one({"company_id": company_id, "code": "9998"}, {"_id": 0, "id": 1})
    if sus:
        bal = await _balance(company_id, sus["id"], hi_s)
        if abs(bal) > 0.5:
            add("suspense", "blocker", "Suspense account is not cleared", f"{bal:,.2f} is still parked in Suspense. Move it to the right ledger before closing.")

    fails = await db.accounting_posting_failures.count_documents({"company_id": company_id, "entry_date": {"$gte": lo_s, "$lte": hi_s}})
    if fails:
        add("posting_failures", "blocker", "Documents that failed to post", f"{fails} document(s) are not in the ledger. Resolve them in Accounting Integrity.", fails)

    unmatched = 0
    for a in await db.bank_accounts.find({"company_id": company_id}, {"_id": 0, "id": 1}).to_list(500):
        unmatched += await db.bank_transactions.count_documents({"bank_account_id": a["id"], "matched_type": None, "date": {"$gte": lo_s, "$lte": hi_s}})
    if unmatched:
        add("bank_unmatched", "warning", "Unmatched bank transactions", f"{unmatched} bank line(s) are not matched to an invoice, bill or expense.", unmatched)

    drafts = (await db.invoices.count_documents({"company_id": company_id, "status": "draft", "invoice_date": {"$gte": lo_s, "$lte": hi_s}})
              + await db.purchase_invoices.count_documents({"company_id": company_id, "status": "draft", "invoice_date": {"$gte": lo_s, "$lte": hi_s}}))
    if drafts:
        add("drafts", "warning", "Draft invoices and bills", f"{drafts} draft document(s) dated in this year are not in the books.", drafts)

    assets = await db.fixed_assets.count_documents({"company_id": company_id, "status": {"$nin": ["cancelled", "disposed"]}, "purchase_date": {"$lte": hi_s}})
    if assets:
        run = await db.depreciation_runs.count_documents({"company_id": company_id, "period_end": {"$gte": hi_s}})
        if not run:
            add("depreciation", "warning", "Depreciation not run to year-end", f"{assets} asset(s) are on the register but depreciation has not been run up to {hi_s}.", assets)

    try:
        st = await ac._load_statements(company_id, lo_s, hi_s, tax_rate=(await get_settings(company_id))["tax_rate_pct"] / 100.0)
        if st["income_tax"]["tax_to_book"] > 0.5:
            add("tax_provision", "warning", "Income tax not provided for", f"Estimated tax of {st['income_tax']['tax_to_book']:,.2f} has not been booked. Book it from MIS & Compliance.")
        if abs(st["deferred_tax"]["adjustment_to_book"]) > 0.5:
            add("deferred_tax", "warning", "Deferred tax not up to date", f"Deferred tax needs an adjustment of {st['deferred_tax']['adjustment_to_book']:,.2f}.")
        if not st["schedule_iii"]["balance_sheet"]["balanced"]:
            add("balance_sheet", "blocker", "Balance sheet does not balance", f"Out by {st['schedule_iii']['balance_sheet']['difference']:,.2f}.")
    except Exception:
        logger.warning("year-end statements check failed", exc_info=True)
        add("statements", "warning", "Could not check the statements", "The balance sheet and tax checks could not run. Open MIS & Compliance to see why.")

    if not await db.period_end_adjustments.count_documents({"company_id": company_id, "as_of": {"$gte": lo_s, "$lte": hi_s}, "status": "active"}):
        add("adjustments", "info", "No period-end adjustments recorded", "Check for prepaid and outstanding expenses, accrued income, income received in advance and a provision for doubtful debts.")

    try:  # inventory, once it is in use
        if await db.stock_items.count_documents({"company_id": company_id}):
            if not await db.stock_valuations.count_documents({"company_id": company_id, "as_of": hi_s, "status": "posted"}):
                add("stock_valuation", "warning", "Closing stock not valued", f"Post the stock valuation as at {hi_s} so cost of goods sold and inventory are right.")
    except Exception:
        pass
    return items


@router.get("/year-end/checklist")
async def year_end_checklist(company_id: str = Query(""), fy: str = Query(...), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    items = await _year_checklist(cid, fy)
    closing = await db.fy_closings.find_one({"company_id": cid, "fy": fy, "status": "closed"}, {"_id": 0, "balances": 0})
    return {"company_id": cid, "fy": fy, "items": items, "blockers": sum(1 for i in items if i["severity"] == "blocker"),
            "warnings": sum(1 for i in items if i["severity"] == "warning"), "closed": bool(closing), "closing": closing}


class YearEndClose(BaseModel):
    company_id: str
    fy: str
    force: bool = False       # close even though warnings remain (blockers always stop it)


@router.post("/year-end/close")
async def year_end_close(body: YearEndClose, current_user: User = Depends(get_current_user)):
    """Closes a financial year: records its result and closing balances and locks the books through 31 March.

    Nothing is moved between accounts. Like Tally, the year's profit simply flows into reserves in the next year's
    opening balances (balance-sheet ledgers carry forward, income and expense ledgers start again at nil)."""
    _need_admin(current_user)
    cid = _company(body.company_id)
    lo, hi = _fy_bounds(body.fy)
    if hi >= date.today() and not body.force:
        raise HTTPException(409, {"code": "year_not_over", "message": f"{body.fy} has not ended yet. Close it after {hi.isoformat()}, or tick 'close anyway'."})
    if await db.fy_closings.find_one({"company_id": cid, "fy": body.fy, "status": "closed"}, {"_id": 0, "id": 1}):
        raise HTTPException(409, {"code": "already_closed", "message": f"{body.fy} is already closed."})
    prev = await db.fy_closings.find_one({"company_id": cid, "fy": f"{lo.year - 1}-{str(lo.year)[-2:]}", "status": "closed"}, {"_id": 0, "id": 1})
    earlier_open = await db.journal_entries.count_documents({"company_id": cid, "entry_date": {"$lt": lo.isoformat()}})
    if earlier_open and not prev:
        lock = await db.accounting_locks.find_one({"company_id": cid, "is_active": True}, {"_id": 0})
        if not lock or str(lock.get("locked_until_date") or "") < (lo - timedelta(days=1)).isoformat():
            raise HTTPException(409, {"code": "previous_year_open", "message": f"Close the previous year before {body.fy}."})

    items = await _year_checklist(cid, body.fy)
    blockers = [i for i in items if i["severity"] == "blocker"]
    warnings = [i for i in items if i["severity"] == "warning"]
    if blockers or (warnings and not body.force):
        raise HTTPException(409, {"code": "checklist", "message": "Resolve these before closing the year." if blockers else "There are open warnings. Resolve them, or close anyway.",
                                  "items": items})

    st = await ac._load_statements(cid, lo.isoformat(), hi.isoformat(), tax_rate=(await get_settings(cid))["tax_rate_pct"] / 100.0)
    accts = {a["id"]: a for a in await db.chart_of_accounts.find({"company_id": cid}, {"_id": 0}).to_list(20000)}
    net: Dict[str, float] = defaultdict(float)
    for l in await db.journal_lines.find({"company_id": cid, "entry_date": {"$lte": hi.isoformat()}}, {"_id": 0}).to_list(1000000):
        a = accts.get(l.get("account_id"))
        if a and a.get("type") in ("asset", "liability", "equity"):
            net[a["id"]] += float(l.get("debit") or 0) - float(l.get("credit") or 0)
    balances = [{"account_id": i, "code": accts[i].get("code"), "name": accts[i].get("name"), "closing": _money(v)} for i, v in net.items() if abs(v) >= 0.005]
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "fy": body.fy, "from": lo.isoformat(), "to": hi.isoformat(), "status": "closed",
           "net_profit_before_tax": st["schedule_iii"]["pnl"]["profit_before_tax"], "net_profit_after_tax": st["schedule_iii"]["pnl"]["profit_after_tax"],
           "revenue": st["schedule_iii"]["pnl"]["revenue_from_operations"], "total_assets": st["schedule_iii"]["balance_sheet"]["assets"]["total_assets"],
           "framework": (await get_settings(cid))["framework"], "balances": balances, "forced": bool(body.force and warnings),
           "open_items": [{"code": i["code"], "title": i["title"]} for i in items], "closed_by": str(current_user.id), "closed_at": now}
    await db.fy_closings.insert_one(dict(doc))
    await db.accounting_locks.update_one(
        {"company_id": cid, "is_active": True},
        {"$set": {"locked_until_date": hi.isoformat(), "reason": f"Financial year {body.fy} closed", "updated_by": str(current_user.id), "updated_at": now},
         "$setOnInsert": {"id": str(uuid.uuid4()), "company_id": cid, "is_active": True, "created_at": now}}, upsert=True)
    await _audit(cid, current_user, "FY_CLOSED", "fy_closings", doc["id"], {"fy": body.fy, "net_profit_after_tax": doc["net_profit_after_tax"]})
    doc.pop("_id", None)
    return {**{k: v for k, v in doc.items() if k != "balances"}, "balance_count": len(balances), "locked_through": hi.isoformat()}


class YearEndReopen(BaseModel):
    company_id: str
    fy: str
    reason: str = Field(min_length=5, max_length=300)


@router.post("/year-end/reopen")
async def year_end_reopen(body: YearEndReopen, current_user: User = Depends(get_current_user)):
    """Reopens the most recent closed year (an earlier one cannot be reopened while a later year is closed)."""
    _need_admin(current_user)
    cid = _company(body.company_id)
    lo, hi = _fy_bounds(body.fy)
    closing = await db.fy_closings.find_one({"company_id": cid, "fy": body.fy, "status": "closed"}, {"_id": 0, "id": 1})
    if not closing:
        raise HTTPException(404, f"{body.fy} is not closed.")
    later = await db.fy_closings.find_one({"company_id": cid, "status": "closed", "to": {"$gt": hi.isoformat()}}, {"_id": 0, "fy": 1})
    if later:
        raise HTTPException(409, f"Reopen {later['fy']} first. Years are reopened latest first.")
    now = datetime.now(timezone.utc).isoformat()
    await db.fy_closings.update_one({"id": closing["id"]}, {"$set": {"status": "reopened", "reopened_by": str(current_user.id), "reopened_at": now, "reopen_reason": body.reason}})
    earlier = await db.fy_closings.find({"company_id": cid, "status": "closed"}, {"_id": 0, "to": 1}).sort("to", -1).to_list(1)
    if earlier:
        await db.accounting_locks.update_one({"company_id": cid, "is_active": True}, {"$set": {"locked_until_date": earlier[0]["to"], "reason": "Previous year closed", "updated_at": now}})
    else:
        await db.accounting_locks.update_one({"company_id": cid, "is_active": True}, {"$set": {"is_active": False, "updated_at": now}})
    await _audit(cid, current_user, "FY_REOPENED", "fy_closings", closing["id"], {"fy": body.fy, "reason": body.reason})
    return {"reopened": body.fy, "locked_through": earlier[0]["to"] if earlier else None}


@router.get("/year-end/closings")
async def list_closings(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    return await db.fy_closings.find({"company_id": cid}, {"_id": 0, "balances": 0}).sort("to", -1).to_list(100)
