"""Voucher types and numbering, the way Tally does it.

Every journal entry is a voucher of one type (Payment, Receipt, Contra, Journal, Sales, Purchase, Debit Note,
Credit Note) and carries a number that runs 1, 2, 3 ... per company, per financial year (April to March) and per
type, e.g. ``PAY/26-27/0007``.

Two rules keep the numbers trustworthy:
* A document keeps its number. Sales and purchase entries are deleted and re-posted whenever the document is edited,
  so the number is remembered against (source, source_id) and handed back to the replacement entry. Without this an
  edited invoice would burn a new number every time and leave gaps.
* Numbers are handed out by an atomic counter, so two entries posted at the same moment cannot share a number.
"""
from __future__ import annotations

import logging
from datetime import date

from pymongo import ReturnDocument
from typing import Dict, Iterable, List, Optional, Tuple

logger = logging.getLogger(__name__)

# kind -> (display name, number prefix)
VOUCHER_TYPES: Dict[str, Tuple[str, str]] = {
    "payment": ("Payment", "PAY"),
    "receipt": ("Receipt", "REC"),
    "contra": ("Contra", "CON"),
    "journal": ("Journal", "JV"),
    "sales": ("Sales", "SAL"),
    "purchase": ("Purchase", "PUR"),
    "debit_note": ("Debit Note", "DN"),
    "credit_note": ("Credit Note", "CN"),
}

# Sources whose type is fixed by what they are, whatever accounts they touch.
_SOURCE_KIND = {
    "sale": "sales",
    "purchase": "purchase",
    "payment": "receipt",            # money received against a sales invoice
    "purchase_payment": "payment",   # money paid against a purchase bill
    "voucher_payment": "payment",
    "voucher_receipt": "receipt",
    "voucher_contra": "contra",
    "voucher_journal": "journal",
    "voucher_debit_note": "debit_note",
    "voucher_credit_note": "credit_note",
    "credit_note": "credit_note",
    "debit_note": "debit_note",
    "reversal": "journal",
    "adjustment": "journal",
}


def fy_start_year(d: date) -> int:
    return d.year if d.month >= 4 else d.year - 1


def fy_label(d: date) -> str:
    y = fy_start_year(d)
    return f"{y}-{str(y + 1)[-2:]}"


def fy_short(d: date) -> str:
    y = fy_start_year(d)
    return f"{str(y)[-2:]}-{str(y + 1)[-2:]}"


def voucher_kind(source: str, legs: Iterable[Tuple[float, float, bool]]) -> str:
    """The voucher type of an entry. ``legs`` are (debit, credit, is_cash_or_bank) for each line.

    Documents decide their own type. Anything else follows Tally's definition: it is a Contra when it only moves
    money between cash and bank accounts, a Receipt when cash or bank is debited, a Payment when cash or bank is
    credited, and a Journal when neither is touched.
    """
    src = str(source or "").strip().lower()
    if src in _SOURCE_KIND:
        return _SOURCE_KIND[src]
    legs = list(legs)
    cash_dr = sum(d for d, _c, cb in legs if cb)
    cash_cr = sum(c for _d, c, cb in legs if cb)
    if not legs or (cash_dr == 0 and cash_cr == 0):
        return "journal"
    if all(cb for _d, _c, cb in legs):
        return "contra"
    return "receipt" if cash_dr >= cash_cr else "payment"


def format_number(kind: str, d: date, seq: int) -> str:
    return f"{VOUCHER_TYPES[kind][1]}/{fy_short(d)}/{seq:04d}"


async def next_number(db, company_id: str, kind: str, d: date) -> str:
    """Atomically take the next number for (company, financial year, type)."""
    doc = await db.voucher_counters.find_one_and_update(
        {"company_id": company_id, "fy": fy_label(d), "kind": kind}, {"$inc": {"seq": 1}},
        upsert=True, return_document=ReturnDocument.AFTER)
    seq = int((doc or {}).get("seq") or 1)
    return format_number(kind, d, seq)


async def stamp_voucher(db, company_id: str, source: str, source_id: Optional[str], entry_date: date,
                        legs: List[Tuple[float, float, bool]]) -> Tuple[str, str]:
    """(voucher_type, voucher_no) for an entry about to be posted. Reuses the number a document already owns."""
    kind = voucher_kind(source, legs)
    if source_id:
        owned = await db.voucher_numbers.find_one({"company_id": company_id, "source": source, "source_id": source_id}, {"_id": 0})
        if owned and owned.get("voucher_no"):
            return owned.get("voucher_type") or kind, owned["voucher_no"]
    number = await next_number(db, company_id, kind, entry_date)
    if source_id:
        try:
            await db.voucher_numbers.insert_one({"company_id": company_id, "source": source, "source_id": source_id,
                                                 "voucher_type": kind, "voucher_no": number})
        except Exception:
            # lost a race with another post of the same document: use the number it stored
            owned = await db.voucher_numbers.find_one({"company_id": company_id, "source": source, "source_id": source_id}, {"_id": 0})
            if owned and owned.get("voucher_no"):
                return owned.get("voucher_type") or kind, owned["voucher_no"]
    return kind, number
