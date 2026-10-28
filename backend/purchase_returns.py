"""Purchase Returns (goods/services returned to a supplier).

Accounting rule agreed for Finix:
  * A purchase return never edits or deletes the purchase bill's own journal
    entry. It posts its OWN reversing entry:
        Dr Accounts Payable (2000)            return total
        Cr <bill's expense head> (e.g. 5000)  taxable value returned
        Cr GST Input Credit (1200)            GST returned
    exactly like a Sale Return (credit note) reverses a sale.
  * Deleting a purchase return deletes that return's entry (deletes remove,
    returns reverse).
  * A bill's outstanding = grand total - payments - returns.
  * A bill with returns against it cannot be deleted or cancelled until the
    returns are deleted (mirror of invoices with credit notes).
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.finix_action_permissions import require_finix_action
from backend.models import User

router = APIRouter(tags=["Purchase Returns"])

SOURCE = "purchase_return"


class PurchaseReturnCreate(BaseModel):
    return_date: Optional[str] = None          # YYYY-MM-DD, defaults to today
    taxable_amount: float = Field(ge=0)        # value of goods/services returned, before GST
    gst_amount: float = Field(default=0.0, ge=0)
    cgst_amount: float = Field(default=0.0, ge=0)
    sgst_amount: float = Field(default=0.0, ge=0)
    igst_amount: float = Field(default=0.0, ge=0)
    supplier_note_no: str = ""                 # supplier's credit note / our debit note number
    reason: str = ""


def _r2(value) -> float:
    return round(float(value or 0), 2)


async def returns_for_bill(invoice_id: str) -> list[dict]:
    return await db.purchase_returns.find({"purchase_invoice_id": invoice_id}, {"_id": 0}).to_list(500)


async def returned_total(invoice_id: str) -> float:
    return _r2(sum(float(r.get("grand_total") or 0) for r in await returns_for_bill(invoice_id)))


async def recalculate_purchase_outstanding(invoice_id: str) -> Optional[dict]:
    """Outstanding = Grand Total - Payments - Returns (cancelled bills untouched)."""
    inv = await db.purchase_invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not inv or inv.get("status") == "cancelled":
        return inv
    payments = await db.purchase_payments.find({"purchase_invoice_id": invoice_id}, {"_id": 0, "amount": 1}).to_list(2000)
    paid = _r2(sum(float(p.get("amount") or 0) for p in payments))
    returned = await returned_total(invoice_id)
    due = _r2(max(_r2(inv.get("grand_total")) - paid - returned, 0))
    status = "paid" if due <= 0 else ("partially_paid" if paid > 0 else "outstanding")
    update = {"amount_paid": paid, "amount_returned": returned, "amount_due": due, "status": status,
              "updated_at": datetime.now(timezone.utc).isoformat()}
    await db.purchase_invoices.update_one({"id": invoice_id}, {"$set": update})
    return {**inv, **update}


async def sync_purchase_return_journal_entry(return_id: str) -> str:
    from backend.accounting_core import get_default_account_id
    from backend.invoicing import _apply_source_journal

    ret = await db.purchase_returns.find_one({"id": return_id}, {"_id": 0})
    if not ret:
        return await _apply_source_journal(SOURCE, return_id, None)
    company_id = ret.get("company_id") or ""
    total, gst = _r2(ret.get("grand_total")), _r2(ret.get("gst_amount"))
    taxable = _r2(total - gst)
    payable_id = await get_default_account_id(company_id, "2000")
    gst_input_id = await get_default_account_id(company_id, "1200")
    expense_code = ret.get("expense_ledger_code") or "5000"
    expense_name = ret.get("expense_ledger_name") or "Purchases"
    expense_id = await get_default_account_id(company_id, expense_code)
    if not expense_id:
        expense_id, expense_name = await get_default_account_id(company_id, "5000"), "Purchases"
    if not payable_id or not expense_id or (gst > 0 and not gst_input_id):
        return await _apply_source_journal(
            SOURCE, return_id, None, company_id=company_id,
            failure="The company's chart of accounts is missing 2000 / 1200 / 5000, so the purchase return could not be posted.")
    bill_no, supplier = ret.get("bill_no") or "", ret.get("supplier_name") or "Supplier"
    lines = [
        {"account_id": payable_id, "account_name": "Accounts Payable", "debit": total, "credit": 0.0,
         "memo": f"Purchase return against {bill_no} to {supplier}"},
        {"account_id": expense_id, "account_name": expense_name, "debit": 0.0, "credit": taxable,
         "memo": f"Purchase return {ret.get('return_no')} against {bill_no}"},
    ]
    if gst > 0:
        lines.append({"account_id": gst_input_id, "account_name": "GST Input Credit", "debit": 0.0, "credit": gst,
                      "memo": f"GST input reversed on purchase return {ret.get('return_no')}"})
    return await _apply_source_journal(SOURCE, return_id, {
        "company_id": company_id, "entry_date": ret.get("return_date") or date.today().isoformat(),
        "narration": f"Purchase Return {ret.get('return_no')} against Bill {bill_no} from {supplier}"
                     + (f" (supplier note {ret['supplier_note_no']})" if ret.get("supplier_note_no") else ""),
        "lines": lines, "created_by": ret.get("created_by", "system"),
    })


async def _next_return_no(company_id: str) -> str:
    today = date.today()
    fy_start = today.year if today.month >= 4 else today.year - 1
    prefix = f"PR/{fy_start % 100:02d}-{(fy_start + 1) % 100:02d}/"
    existing = await db.purchase_returns.find(
        {"company_id": company_id, "return_no": {"$regex": f"^{re.escape(prefix)}"}}, {"_id": 0, "return_no": 1}
    ).to_list(100000)
    seq = 0
    for doc in existing:
        try:
            seq = max(seq, int(str(doc.get("return_no", "")).rsplit("/", 1)[-1]))
        except ValueError:
            continue
    return f"{prefix}{seq + 1:03d}"


def _check_purchase_perm(user: User, action: str) -> None:
    from backend.invoicing import _perm_purchase
    require_finix_action(user, "can_view_purchase", action)
    if not _perm_purchase(user):
        raise HTTPException(403, "Access denied")


@router.post("/purchase-invoices/{invoice_id}/returns")
async def create_purchase_return(invoice_id: str, data: PurchaseReturnCreate,
                                 current_user: User = Depends(get_current_user)):
    from backend.invoicing import _assert_purchase_access
    from backend.accounting_lock import assert_period_open, audit_ledger_event

    _check_purchase_perm(current_user, "edit")
    bill = await db.purchase_invoices.find_one({"id": invoice_id}, {"_id": 0})
    if not bill:
        raise HTTPException(404, "Purchase bill not found")
    _assert_purchase_access(bill, current_user)
    if bill.get("status") == "cancelled":
        raise HTTPException(400, "Cannot record a purchase return against a cancelled bill")

    gst = _r2(data.gst_amount or (data.cgst_amount + data.sgst_amount + data.igst_amount))
    taxable = _r2(data.taxable_amount)
    total = _r2(taxable + gst)
    if total <= 0:
        raise HTTPException(400, "Return amount must be greater than zero.")
    previous = await returns_for_bill(invoice_id)
    returned = _r2(sum(float(r.get("grand_total") or 0) for r in previous))
    returned_gst = _r2(sum(float(r.get("gst_amount") or 0) for r in previous))
    bill_total, bill_gst = _r2(bill.get("grand_total")), _r2(bill.get("total_gst"))
    if total > _r2(bill_total - returned) + 0.005:
        raise HTTPException(400, f"Return exceeds what is left on this bill ({max(bill_total - returned, 0):,.2f} can still be returned).")
    if gst > _r2(bill_gst - returned_gst) + 0.005:
        raise HTTPException(400, f"GST returned exceeds the bill's remaining GST ({max(bill_gst - returned_gst, 0):,.2f}).")

    return_date = (data.return_date or "").strip()[:10] or date.today().isoformat()
    try:
        date.fromisoformat(return_date)
    except ValueError:
        raise HTTPException(400, "Return date must be a valid date in YYYY-MM-DD format.")
    if return_date < str(bill.get("invoice_date") or "")[:10]:
        raise HTTPException(400, "A return cannot be dated before the bill it returns.")
    company_id = str(bill.get("company_id") or "")
    await assert_period_open(company_id, return_date, "record this purchase return")

    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()), "return_no": await _next_return_no(company_id),
        "purchase_invoice_id": invoice_id, "bill_no": bill.get("invoice_no") or "",
        "supplier_name": bill.get("supplier_name") or "", "company_id": company_id,
        "return_date": return_date, "taxable_amount": taxable, "gst_amount": gst,
        "cgst_amount": _r2(data.cgst_amount), "sgst_amount": _r2(data.sgst_amount), "igst_amount": _r2(data.igst_amount),
        "grand_total": total, "supplier_note_no": data.supplier_note_no.strip(), "reason": data.reason.strip(),
        "expense_ledger_code": bill.get("expense_ledger_code") or "5000",
        "expense_ledger_name": bill.get("expense_ledger_name") or "Purchases",
        "created_by": current_user.id, "created_at": now,
    }
    await db.purchase_returns.insert_one(dict(doc))
    posting = await sync_purchase_return_journal_entry(doc["id"])
    if posting == "failed":
        await db.purchase_returns.delete_one({"id": doc["id"]})
        raise HTTPException(409, "The purchase return could not be posted to the ledger (see Accounting Integrity). Nothing was saved.")
    await audit_ledger_event(company_id, "PURCHASE_RETURN_CREATED", current_user, {
        "return_no": doc["return_no"], "bill_no": doc["bill_no"], "grand_total": total, "gst_amount": gst,
    }, document_id=doc["id"])
    updated = await recalculate_purchase_outstanding(invoice_id)
    return {"purchase_return": doc, "bill": {k: (updated or {}).get(k) for k in ("id", "status", "amount_paid", "amount_returned", "amount_due")}}


@router.get("/purchase-invoices/{invoice_id}/returns")
async def list_purchase_returns(invoice_id: str, current_user: User = Depends(get_current_user)):
    from backend.invoicing import _assert_purchase_access, _perm_purchase
    if not _perm_purchase(current_user):
        raise HTTPException(403, "Access denied")
    bill = await db.purchase_invoices.find_one({"id": invoice_id}, {"_id": 0, "company_id": 1, "created_by": 1})
    if not bill:
        raise HTTPException(404, "Purchase bill not found")
    _assert_purchase_access(bill, current_user)
    items = await returns_for_bill(invoice_id)
    return sorted(items, key=lambda r: (r.get("return_date") or "", r.get("created_at") or ""))


@router.delete("/purchase-returns/{return_id}")
async def delete_purchase_return(return_id: str, current_user: User = Depends(get_current_user)):
    from backend.invoicing import _assert_purchase_access, _assert_ledger_changeable
    from backend.accounting_lock import audit_ledger_event

    _check_purchase_perm(current_user, "delete")
    ret = await db.purchase_returns.find_one({"id": return_id}, {"_id": 0})
    if not ret:
        raise HTTPException(404, "Purchase return not found")
    bill = await db.purchase_invoices.find_one({"id": ret.get("purchase_invoice_id")}, {"_id": 0, "company_id": 1, "created_by": 1})
    if bill:
        _assert_purchase_access(bill, current_user)
    company_id = str(ret.get("company_id") or "")
    await _assert_ledger_changeable(company_id, [ret.get("return_date")], [(SOURCE, return_id)], "delete this purchase return")
    await audit_ledger_event(company_id, "PURCHASE_RETURN_DELETED", current_user, {
        "return_no": ret.get("return_no"), "bill_no": ret.get("bill_no"), "grand_total": ret.get("grand_total"),
    }, document_id=return_id)
    await db.purchase_returns.delete_one({"id": return_id})
    await sync_purchase_return_journal_entry(return_id)   # return is gone -> its entry is removed
    if ret.get("purchase_invoice_id"):
        await recalculate_purchase_outstanding(ret["purchase_invoice_id"])
    return {"success": True}
