"""Inventory (AS 2 / Ind AS 2): stock items, stock movements, valuation and the closing-stock entry.

The books here use the periodic method, the way the rest of the platform does: purchases are expensed to Purchases (5000)
as bills are booked, and at each period end the closing stock is brought onto the balance sheet. ``POST /valuations``
values the stock (weighted average or FIFO, then lower of cost and net realisable value), compares it with what the
Inventory account (1400) already holds, and posts only the difference against Cost of Goods Sold / Stock Adjustment
(5020). Posting twice for the same date therefore posts nothing the second time.

Quantities move through ``stock_movements`` (receipts, issues, returns, adjustments). Sales invoices can be pulled in as
issues for items linked to a product. Purchase bills carry no item lines, so receipts are entered here.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timezone
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.accounting_books import (
    _audit, _balance, _company, _default_id, _money, _need_post, _need_view, _parse_date, _post, get_settings,
)
from backend.dependencies import db, get_current_user
from backend.inventory_valuation import IN_KINDS, goes_negative, r2, run_item, value_items
from backend.models import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/accounting-books/inventory", tags=["Accounting Books - Inventory"])

KIND_LABELS = {
    "opening": "Opening stock", "purchase": "Purchase receipt", "sales_return": "Sales return", "adjustment_in": "Stock gain (count adjustment)",
    "sale": "Sale issue", "purchase_return": "Purchase return", "adjustment_out": "Stock loss (damage, shortage, count adjustment)",
}
NOTES = {
    "AS": "Valued at the lower of cost and net realisable value (AS 2).",
    "IND_AS": "Measured at the lower of cost and net realisable value (Ind AS 2); a write-down is reversed when NRV recovers, up to cost.",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _open_for(company_id: str, day: str, what: str) -> None:
    from backend.accounting_lock import assert_period_open
    await assert_period_open(company_id, day, what)        # raises 400 when the date is in a closed period


async def _items(company_id: str, active_only: bool = False) -> List[dict]:
    q: dict = {"company_id": company_id}
    if active_only:
        q["is_active"] = {"$ne": False}
    return await db.stock_items.find(q, {"_id": 0}).sort("name", 1).to_list(20000)


async def _movements(company_id: str, item_id: Optional[str] = None) -> List[dict]:
    q: dict = {"company_id": company_id}
    if item_id:
        q["item_id"] = item_id
    return await db.stock_movements.find(q, {"_id": 0}).to_list(500000)


async def _item(company_id: str, item_id: str) -> dict:
    it = await db.stock_items.find_one({"company_id": company_id, "id": item_id}, {"_id": 0})
    if not it:
        raise HTTPException(404, "Stock item not found.")
    return it


# ═══ Items ══════════════════════════════════════════════════════════════════════════════════════
class ItemCreate(BaseModel):
    company_id: str
    name: str = Field(..., min_length=1, max_length=200)
    sku: str = ""
    unit: str = "Nos"
    hsn_sac: str = ""
    group: str = ""
    product_id: Optional[str] = None                   # link to the invoicing product so sales invoices issue this stock
    reorder_level: float = Field(0, ge=0)
    nrv_per_unit: Optional[float] = Field(None, ge=0)  # estimated selling price less costs to sell, per unit
    opening_quantity: float = Field(0, ge=0)
    opening_rate: float = Field(0, ge=0)
    opening_date: Optional[str] = None


class ItemUpdate(BaseModel):
    company_id: str
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    sku: Optional[str] = None
    unit: Optional[str] = None
    hsn_sac: Optional[str] = None
    group: Optional[str] = None
    product_id: Optional[str] = None
    reorder_level: Optional[float] = Field(None, ge=0)
    nrv_per_unit: Optional[float] = Field(None, ge=0)
    clear_nrv: bool = False
    is_active: Optional[bool] = None


@router.post("/items")
async def create_item(body: ItemCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    name = body.name.strip()
    if await db.stock_items.find_one({"company_id": cid, "name_lc": name.lower()}, {"_id": 0, "id": 1}):
        raise HTTPException(409, f"A stock item named {name} already exists.")
    if body.sku.strip() and await db.stock_items.find_one({"company_id": cid, "sku": body.sku.strip()}, {"_id": 0, "id": 1}):
        raise HTTPException(409, f"Code {body.sku.strip()} is already used by another item.")
    if body.product_id and await db.stock_items.find_one({"company_id": cid, "product_id": body.product_id}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "That product is already linked to another stock item.")
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "name": name, "name_lc": name.lower(), "sku": body.sku.strip(), "unit": body.unit.strip() or "Nos",
           "hsn_sac": body.hsn_sac.strip(), "group": body.group.strip(), "product_id": body.product_id or None, "reorder_level": body.reorder_level,
           "nrv_per_unit": body.nrv_per_unit, "is_active": True, "created_by": str(current_user.id), "created_at": _now()}
    opening = None
    if body.opening_quantity > 0:
        day = _parse_date(body.opening_date, "Opening date").isoformat() if body.opening_date else date.today().isoformat()
        await _open_for(cid, day, "record opening stock")
        opening = {"id": str(uuid.uuid4()), "company_id": cid, "item_id": doc["id"], "date": day, "direction": "in", "kind": "opening",
                   "quantity": body.opening_quantity, "rate": _money(body.opening_rate), "other_costs": 0.0, "ref_no": "", "note": "Opening stock",
                   "party": "", "source": "manual", "source_id": None, "status": "active", "created_by": str(current_user.id), "created_at": _now()}
    await db.stock_items.insert_one(dict(doc))
    if opening:
        await db.stock_movements.insert_one(dict(opening))
    await _audit(cid, current_user, "STOCK_ITEM_CREATED", "stock_items", doc["id"], {"name": name})
    return {k: v for k, v in doc.items() if k != "name_lc"}


@router.put("/items/{item_id}")
async def update_item(item_id: str, body: ItemUpdate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    await _item(cid, item_id)
    changes = {k: v for k, v in body.model_dump(exclude={"company_id", "clear_nrv"}).items() if v is not None}
    if "name" in changes:
        changes["name"] = changes["name"].strip()
        changes["name_lc"] = changes["name"].lower()
        clash = await db.stock_items.find_one({"company_id": cid, "name_lc": changes["name_lc"], "id": {"$ne": item_id}}, {"_id": 0, "id": 1})
        if clash:
            raise HTTPException(409, f"A stock item named {changes['name']} already exists.")
    if body.clear_nrv:
        changes["nrv_per_unit"] = None
    if changes.get("product_id"):
        clash = await db.stock_items.find_one({"company_id": cid, "product_id": changes["product_id"], "id": {"$ne": item_id}}, {"_id": 0, "id": 1})
        if clash:
            raise HTTPException(409, "That product is already linked to another stock item.")
    if changes:
        await db.stock_items.update_one({"company_id": cid, "id": item_id}, {"$set": changes})
    await _audit(cid, current_user, "STOCK_ITEM_UPDATED", "stock_items", item_id, {k: v for k, v in changes.items() if k != "name_lc"})
    out = await _item(cid, item_id)
    out.pop("name_lc", None)
    return out


@router.delete("/items/{item_id}")
async def delete_item(item_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    await _item(cid, item_id)
    if await db.stock_movements.count_documents({"company_id": cid, "item_id": item_id}):
        raise HTTPException(409, "This item has stock movements, so it cannot be deleted. Mark it inactive instead.")
    await db.stock_items.delete_one({"company_id": cid, "id": item_id})
    await _audit(cid, current_user, "STOCK_ITEM_DELETED", "stock_items", item_id, {})
    return {"deleted": True}


@router.get("/items")
async def list_items(company_id: str = Query(""), as_of: Optional[str] = Query(None), search: str = Query(""),
                     include_inactive: bool = Query(False), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    day = _parse_date(as_of).isoformat() if as_of else date.today().isoformat()
    settings = await get_settings(cid)
    items = await _items(cid, active_only=not include_inactive)
    if search.strip():
        s = search.strip().lower()
        items = [i for i in items if s in i["name"].lower() or s in str(i.get("sku") or "").lower()]
    moves = await _movements(cid)
    by_item: Dict[str, List[dict]] = {}
    for m in moves:
        by_item.setdefault(m["item_id"], []).append(m)
    out = []
    for it in items:
        res = run_item(by_item.get(it["id"], []), settings["inventory_method"], day)
        issues = [m["date"] for m in by_item.get(it["id"], []) if m.get("direction") == "out" and m.get("status") != "cancelled" and m["date"] <= day]
        last_issue = max(issues) if issues else None
        row = {k: v for k, v in it.items() if k != "name_lc"}
        row.update({"quantity": res["quantity"], "unit_cost": res["unit_cost"], "value": res["value"], "last_issue": last_issue,
                    "below_reorder": bool(it.get("reorder_level") and res["quantity"] <= float(it["reorder_level"])),
                    "movement_count": len(by_item.get(it["id"], []))})
        out.append(row)
    return {"as_of": day, "method": settings["inventory_method"], "items": out, "total_value": r2(sum(r["value"] for r in out))}


@router.get("/items/{item_id}/ledger")
async def item_ledger(item_id: str, company_id: str = Query(""), as_of: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    it = await _item(cid, item_id)
    settings = await get_settings(cid)
    day = _parse_date(as_of).isoformat() if as_of else None
    res = run_item(await _movements(cid, item_id), settings["inventory_method"], day)
    return {"item": {k: v for k, v in it.items() if k != "name_lc"}, "method": settings["inventory_method"], "quantity": res["quantity"],
            "unit_cost": res["unit_cost"], "value": res["value"], "rows": res["rows"], "negative_on": res["negative_on"]}


# ═══ Movements ══════════════════════════════════════════════════════════════════════════════════
class MovementCreate(BaseModel):
    company_id: str
    item_id: str
    date: str
    kind: Literal["opening", "purchase", "sales_return", "adjustment_in", "sale", "purchase_return", "adjustment_out"]
    quantity: float = Field(..., gt=0)
    rate: Optional[float] = Field(None, ge=0)      # unit cost for receipts; issues are costed by the valuation method
    other_costs: float = Field(0, ge=0)             # freight, non-recoverable duty and other costs of bringing the goods in
    discount: float = Field(0, ge=0)                # trade discount, deducted from cost
    party: str = ""
    ref_no: str = ""
    note: str = ""


def _direction(kind: str) -> str:
    return "in" if kind in IN_KINDS else "out"


@router.get("/kinds")
async def movement_kinds(current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return [{"kind": k, "label": v, "direction": _direction(k), "needs_rate": k in ("opening", "purchase")} for k, v in KIND_LABELS.items()]


@router.post("/movements")
async def create_movement(body: MovementCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    day = _parse_date(body.date, "Date").isoformat()
    if day > date.today().isoformat():
        raise HTTPException(400, "A stock movement cannot be dated in the future.")
    await _open_for(cid, day, "record a stock movement")
    it = await _item(cid, body.item_id)
    if it.get("is_active") is False:
        raise HTTPException(400, f"{it['name']} is marked inactive.")
    direction = _direction(body.kind)
    rate = None
    if direction == "in":
        if body.kind in ("opening", "purchase") and body.rate is None:
            raise HTTPException(400, "Enter the rate for this receipt.")
        if body.rate is not None:
            total = body.quantity * body.rate + body.other_costs - body.discount
            if total < 0:
                raise HTTPException(400, "The discount is more than the value of the goods.")
            rate = round(total / body.quantity, 6)
    settings = await get_settings(cid)
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "item_id": body.item_id, "date": day, "direction": direction, "kind": body.kind,
           "quantity": body.quantity, "rate": rate, "other_costs": body.other_costs, "discount": body.discount, "party": body.party.strip(),
           "ref_no": body.ref_no.strip(), "note": body.note.strip(), "source": "manual", "source_id": None, "status": "active",
           "created_by": str(current_user.id), "created_at": _now()}
    existing = await _movements(cid, body.item_id)
    neg = goes_negative(existing + [doc], settings["inventory_method"])
    if neg:
        raise HTTPException(400, f"Not enough {it['name']} in stock: this would take it below zero on {neg}.")
    await db.stock_movements.insert_one(dict(doc))
    await _audit(cid, current_user, "STOCK_MOVEMENT", "stock_movements", doc["id"], {"item": it["name"], "kind": body.kind, "quantity": body.quantity})
    return doc


@router.get("/movements")
async def list_movements(company_id: str = Query(""), item_id: Optional[str] = Query(None), kind: Optional[str] = Query(None),
                         date_from: Optional[str] = Query(None), date_to: Optional[str] = Query(None),
                         page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=200), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    q: dict = {"company_id": cid}
    if item_id:
        q["item_id"] = item_id
    if kind:
        q["kind"] = kind
    if date_from or date_to:
        q["date"] = {}
        if date_from:
            q["date"]["$gte"] = _parse_date(date_from, "From date").isoformat()
        if date_to:
            q["date"]["$lte"] = _parse_date(date_to, "To date").isoformat()
    total = await db.stock_movements.count_documents(q)
    rows = await db.stock_movements.find(q, {"_id": 0}).sort([("date", -1), ("created_at", -1)]).skip((page - 1) * page_size).limit(page_size).to_list(page_size)
    names = {i["id"]: i["name"] for i in await _items(cid)}
    for r in rows:
        r["item_name"] = names.get(r["item_id"], "")
        r["kind_label"] = KIND_LABELS.get(r["kind"], r["kind"])
    return {"movements": rows, "total": total, "page": page, "total_pages": max(1, -(-total // page_size))}


@router.post("/movements/{movement_id}/cancel")
async def cancel_movement(movement_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    m = await db.stock_movements.find_one({"company_id": cid, "id": movement_id}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Movement not found.")
    if m.get("status") == "cancelled":
        return {"cancelled": True, "already": True}
    await _open_for(cid, m["date"], "cancel a stock movement")
    posted = await db.stock_valuations.count_documents({"company_id": cid, "status": "posted", "as_of": {"$gte": m["date"]}})
    if posted:
        raise HTTPException(409, "A closing-stock valuation has already been posted on or after this date. Cancel that valuation first, then cancel this movement.")
    settings = await get_settings(cid)
    rest = [x for x in await _movements(cid, m["item_id"]) if x["id"] != movement_id]
    neg = goes_negative(rest, settings["inventory_method"])
    if neg:
        raise HTTPException(400, f"Cancelling this would leave the item short of stock on {neg}. Cancel the later issues first.")
    await db.stock_movements.update_one({"company_id": cid, "id": movement_id}, {"$set": {"status": "cancelled", "cancelled_by": str(current_user.id), "cancelled_at": _now()}})
    await _audit(cid, current_user, "STOCK_MOVEMENT_CANCELLED", "stock_movements", movement_id, {})
    return {"cancelled": True}


@router.post("/sync-sales")
async def sync_sales(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """Issue stock for sales invoice lines whose product is linked to a stock item. Safe to run repeatedly."""
    _need_post(current_user)
    cid = _company(company_id)
    linked = {i["product_id"]: i for i in await _items(cid, active_only=True) if i.get("product_id")}
    if not linked:
        return {"created": 0, "skipped": 0, "message": "No stock item is linked to a product yet."}
    settings = await get_settings(cid)
    invoices = await db.invoices.find({"company_id": cid, "status": {"$nin": ["draft", "cancelled"]}}, {"_id": 0, "id": 1, "invoice_no": 1, "invoice_date": 1, "items": 1, "client_name": 1}).to_list(100000)
    done = {m["source_id"] for m in await db.stock_movements.find({"company_id": cid, "source": "sale_invoice"}, {"_id": 0, "source_id": 1}).to_list(500000)}
    created, skipped, problems = 0, 0, []
    for inv in sorted(invoices, key=lambda x: str(x.get("invoice_date") or "")):
        for idx, line in enumerate(inv.get("items") or []):
            it = linked.get(line.get("product_id"))
            qty = float(line.get("quantity") or 0)
            if not it or qty <= 0:
                continue
            sid = f"{inv['id']}:{idx}"
            if sid in done:
                skipped += 1
                continue
            day = str(inv.get("invoice_date") or "")[:10]
            try:
                _parse_date(day)
                await _open_for(cid, day, "issue stock for an invoice")
            except HTTPException as exc:
                problems.append(f"{inv.get('invoice_no')}: {exc.detail}")
                continue
            doc = {"id": str(uuid.uuid4()), "company_id": cid, "item_id": it["id"], "date": day, "direction": "out", "kind": "sale", "quantity": qty,
                   "rate": None, "other_costs": 0.0, "discount": 0.0, "party": inv.get("client_name") or "", "ref_no": inv.get("invoice_no") or "",
                   "note": "Issued on sales invoice", "source": "sale_invoice", "source_id": sid, "status": "active",
                   "created_by": str(current_user.id), "created_at": _now()}
            neg = goes_negative(await _movements(cid, it["id"]) + [doc], settings["inventory_method"])
            if neg:
                problems.append(f"{inv.get('invoice_no')}: not enough {it['name']} in stock on {neg}.")
                continue
            await db.stock_movements.insert_one(dict(doc))
            created += 1
    return {"created": created, "skipped": skipped, "problems": problems[:50]}


# ═══ Valuation ══════════════════════════════════════════════════════════════════════════════════
async def _valuation(cid: str, as_of: str) -> dict:
    settings = await get_settings(cid)
    items = await _items(cid)
    val = value_items(items, await _movements(cid), settings["inventory_method"], as_of)
    inv_id = await _default_id(cid, "1400")
    book = _money(await _balance(cid, inv_id, as_of))
    val.update({"framework": settings["framework"], "note": NOTES[settings["framework"]], "book_balance": book,
                "adjustment_needed": _money(val["total_carrying"] - book), "inventory_account_id": inv_id})
    return val


@router.get("/valuation")
async def valuation_report(company_id: str = Query(""), as_of: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    day = _parse_date(as_of, "As-of date").isoformat() if as_of else date.today().isoformat()
    return await _valuation(cid, day)


class ValuationPost(BaseModel):
    company_id: str
    as_of: str
    narration: str = ""


@router.post("/valuations")
async def post_valuation(body: ValuationPost, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    day = _parse_date(body.as_of, "As-of date")
    if day.isoformat() > date.today().isoformat():
        raise HTTPException(400, "Closing stock cannot be valued as at a future date.")
    later = await db.stock_valuations.find_one({"company_id": cid, "status": "posted", "as_of": {"$gt": day.isoformat()}}, {"_id": 0, "as_of": 1})
    if later:
        raise HTTPException(409, f"Closing stock is already posted as at {later['as_of']}. Cancel that valuation before posting an earlier one.")
    val = await _valuation(cid, day.isoformat())
    if any(l.get("negative_on") for l in val["lines"]):
        names = ", ".join(l["name"] for l in val["lines"] if l.get("negative_on"))
        raise HTTPException(400, f"These items show negative stock, so their value cannot be relied on: {names}. Correct the movements first.")
    delta = _money(val["adjustment_needed"])
    val_id = str(uuid.uuid4())
    entry = None
    if abs(delta) >= 0.01:
        cogs_id = await _default_id(cid, "5020")
        inv_id = val["inventory_account_id"]
        text = body.narration.strip() or f"Closing stock as at {day.isoformat()} ({val['method'].replace('_', ' ').title()}, lower of cost and NRV)"
        lines = ([{"account_id": inv_id, "debit": delta, "credit": 0.0, "memo": text}, {"account_id": cogs_id, "debit": 0.0, "credit": delta, "memo": text}]
                 if delta > 0 else
                 [{"account_id": cogs_id, "debit": -delta, "credit": 0.0, "memo": text}, {"account_id": inv_id, "debit": 0.0, "credit": -delta, "memo": text}])
        entry = await _post(cid, day.isoformat(), text, lines, "stock_valuation", val_id, current_user)
    doc = {"id": val_id, "company_id": cid, "as_of": day.isoformat(), "method": val["method"], "framework": val["framework"], "total_cost": val["total_cost"],
           "total_write_down": val["total_write_down"], "total_carrying": val["total_carrying"], "previous_balance": val["book_balance"], "delta": delta,
           "entry_id": (entry or {}).get("id"), "status": "posted", "lines": val["lines"], "created_by": str(current_user.id), "created_at": _now()}
    await db.stock_valuations.insert_one(dict(doc))
    await _audit(cid, current_user, "STOCK_VALUATION_POSTED", "stock_valuations", val_id, {"as_of": doc["as_of"], "carrying": doc["total_carrying"], "delta": delta})
    return {"posted": True, "valuation": doc, "voucher_no": (entry or {}).get("voucher_no"),
            "message": None if entry else "The Inventory account already stands at this value, so nothing needed posting."}


@router.get("/valuations")
async def list_valuations(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    rows = await db.stock_valuations.find({"company_id": cid}, {"_id": 0, "lines": 0}).sort("as_of", -1).to_list(500)
    return rows


@router.post("/valuations/{valuation_id}/cancel")
async def cancel_valuation(valuation_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    v = await db.stock_valuations.find_one({"company_id": cid, "id": valuation_id}, {"_id": 0})
    if not v:
        raise HTTPException(404, "Valuation not found.")
    if v.get("status") == "cancelled":
        return {"cancelled": True, "already": True}
    later = await db.stock_valuations.find_one({"company_id": cid, "status": "posted", "as_of": {"$gt": v["as_of"]}}, {"_id": 0, "as_of": 1})
    if later:
        raise HTTPException(409, f"A later valuation (as at {later['as_of']}) depends on this one. Cancel that first.")
    if v.get("entry_id"):
        from backend.accounting_lock import reverse_journal_entry
        try:
            await reverse_journal_entry(v["entry_id"], f"Closing stock valuation as at {v['as_of']} cancelled", str(current_user.id))
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    await db.stock_valuations.update_one({"company_id": cid, "id": valuation_id}, {"$set": {"status": "cancelled", "cancelled_by": str(current_user.id), "cancelled_at": _now()}})
    await _audit(cid, current_user, "STOCK_VALUATION_CANCELLED", "stock_valuations", valuation_id, {})
    return {"cancelled": True}


@router.get("/summary")
async def inventory_summary(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    data = await list_items(company_id=cid, as_of=None, search="", include_inactive=False, current_user=current_user)
    today = date.today()
    slow = []
    for r in data["items"]:
        if r["quantity"] > 0:
            ref = r.get("last_issue")
            if ref is None or (today - date.fromisoformat(ref)).days > 180:
                slow.append({"item_id": r["id"], "name": r["name"], "quantity": r["quantity"], "value": r["value"], "last_issue": ref})
    return {"as_of": data["as_of"], "method": data["method"], "item_count": len(data["items"]), "total_value": data["total_value"],
            "below_reorder": [{"item_id": r["id"], "name": r["name"], "quantity": r["quantity"], "reorder_level": r["reorder_level"]} for r in data["items"] if r["below_reorder"]],
            "slow_moving": sorted(slow, key=lambda x: -x["value"])[:20]}
