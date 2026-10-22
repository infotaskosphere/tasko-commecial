"""Accounting standards, part 1: foreign currency, provisions, related parties, EPS and receivable provisioning.

Each feature names the ICAI standard and its Ind AS counterpart, reads the company's framework (``AS`` or ``IND_AS``)
and posts through ``accounting_core.post_journal_entry``, so period locks, voucher numbers and the audit trail apply.

* FX (AS 11 / Ind AS 21)               monetary items restated at the closing rate; the unrealised difference goes to the
                                       P&L and reverses on the next day, so the actual settlement books the real gain.
* Provisions (AS 29 / Ind AS 37)       recognise when probable and measurable, disclose when possible, ignore when remote.
* Related parties (AS 18 / Ind AS 24)  a register, the transactions with each party, and the disclosure table.
* EPS (AS 20 / Ind AS 33)              basic and diluted earnings per share for a financial year.
* Receivables                          ageing and a provision matrix: expected credit loss under Ind AS, a stricter
                                       specific-provision default under AS. Posts through the period-end provision.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend import accounting_core as ac
from backend.accounting_books import (
    AdjustmentCreate, _accounts_by_id, _audit, _balance, _company, _default_id, _fy_bounds, _money, _need_admin, _need_post,
    _need_view, _parse_date, _post, create_adjustment, get_settings,
)
from backend.dependencies import db, get_current_user
from backend.accounting_standards_obligations import STANDARDS as OBLIGATION_STANDARDS
from backend.models import User
from backend.standards_calc import (
    MATRIX_AS, MATRIX_IND_AS, ageing, eps, fx_difference, present_value, treatment, weighted_average_shares,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/accounting-books/standards", tags=["Accounting Books - Standards"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fy_or_current(fy: Optional[str]) -> tuple:
    if fy:
        return _fy_bounds(fy)
    today = date.today()
    start = today.year if today.month >= 4 else today.year - 1
    return date(start, 4, 1), date(start + 1, 3, 31)


def _fy_name(lo: date) -> str:
    return f"{lo.year}-{str(lo.year + 1)[-2:]}"


STANDARDS = {
    "fx": {"AS": "AS 11 - Effects of Changes in Foreign Exchange Rates", "IND_AS": "Ind AS 21 - Effects of Changes in Foreign Exchange Rates"},
    "provisions": {"AS": "AS 29 - Provisions, Contingent Liabilities and Contingent Assets", "IND_AS": "Ind AS 37 - Provisions, Contingent Liabilities and Contingent Assets"},
    "related_parties": {"AS": "AS 18 - Related Party Disclosures", "IND_AS": "Ind AS 24 - Related Party Disclosures"},
    "eps": {"AS": "AS 20 - Earnings Per Share", "IND_AS": "Ind AS 33 - Earnings per Share"},
    "receivables": {"AS": "AS 29 / general prudence - specific provision for doubtful debts", "IND_AS": "Ind AS 109 - expected credit loss (simplified approach)"},
}


@router.get("/catalog")
async def catalog(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """Which standard each feature applies under the company's current framework."""
    _need_view(current_user)
    fw = (await get_settings(_company(company_id)))["framework"]
    return {"framework": fw, "standards": {k: v[fw] for k, v in {**STANDARDS, **OBLIGATION_STANDARDS}.items()}}


# ═══ Foreign currency (AS 11 / Ind AS 21) ═══════════════════════════════════════════════════════
FX_KINDS = ("receivable", "payable", "bank", "loan_given", "loan_taken")


class FxItemCreate(BaseModel):
    company_id: str
    kind: Literal["receivable", "payable", "bank", "loan_given", "loan_taken"]
    party: str = ""
    currency: str = Field(..., min_length=3, max_length=3)
    fc_amount: float = Field(..., gt=0)
    booked_rate: float = Field(..., gt=0)          # rupees per unit of foreign currency when it was booked
    date: str
    note: str = ""


class FxItemUpdate(BaseModel):
    company_id: str
    fc_amount: Optional[float] = Field(None, gt=0)
    booked_rate: Optional[float] = Field(None, gt=0)
    status: Optional[Literal["open", "settled"]] = None
    note: Optional[str] = None


@router.post("/fx/items")
async def fx_item_create(body: FxItemCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "kind": body.kind, "party": body.party.strip(), "currency": body.currency.upper(),
           "fc_amount": body.fc_amount, "booked_rate": body.booked_rate, "date": _parse_date(body.date).isoformat(), "note": body.note.strip(),
           "status": "open", "created_by": str(current_user.id), "created_at": _now()}
    await db.fx_items.insert_one(dict(doc))
    await _audit(cid, current_user, "FX_ITEM_CREATED", "fx_items", doc["id"], {"currency": doc["currency"], "fc_amount": doc["fc_amount"]})
    return doc


@router.get("/fx/items")
async def fx_item_list(company_id: str = Query(""), status: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    q: dict = {"company_id": _company(company_id)}
    if status:
        q["status"] = status
    return await db.fx_items.find(q, {"_id": 0}).sort("date", -1).to_list(5000)


@router.put("/fx/items/{item_id}")
async def fx_item_update(item_id: str, body: FxItemUpdate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    if not await db.fx_items.find_one({"company_id": cid, "id": item_id}, {"_id": 0, "id": 1}):
        raise HTTPException(404, "Item not found.")
    changes = {k: v for k, v in body.model_dump(exclude={"company_id"}).items() if v is not None}
    if changes:
        await db.fx_items.update_one({"company_id": cid, "id": item_id}, {"$set": changes})
    return await db.fx_items.find_one({"company_id": cid, "id": item_id}, {"_id": 0})


@router.delete("/fx/items/{item_id}")
async def fx_item_delete(item_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    res = await db.fx_items.delete_one({"company_id": _company(company_id), "id": item_id})
    if not res.deleted_count:
        raise HTTPException(404, "Item not found.")
    return {"deleted": True}


class FxRevalue(BaseModel):
    company_id: str
    as_of: str
    rates: Dict[str, float]                 # closing rate per currency, e.g. {"USD": 83.4}
    dry_run: bool = False
    auto_reverse: bool = True
    narration: str = ""


@router.post("/fx/revalue")
async def fx_revalue(body: FxRevalue, current_user: User = Depends(get_current_user)):
    """Restate open foreign-currency items at the closing rate. ``dry_run`` shows the effect without posting."""
    _need_post(current_user)
    cid = _company(body.company_id)
    as_of = _parse_date(body.as_of, "As-of date")
    rates = {k.upper(): float(v) for k, v in body.rates.items() if v}
    items = await db.fx_items.find({"company_id": cid, "status": "open", "date": {"$lte": as_of.isoformat()}}, {"_id": 0}).to_list(10000)
    missing = sorted({i["currency"] for i in items if i["currency"] not in rates})
    if missing:
        raise HTTPException(400, f"Enter the closing rate for {', '.join(missing)}.")
    rows, asset_total, liab_total = [], 0.0, 0.0
    for it in items:
        diff = fx_difference(it["kind"], it["fc_amount"], it["booked_rate"], rates[it["currency"]])
        rows.append({"item_id": it["id"], "party": it["party"], "kind": it["kind"], "currency": it["currency"], "fc_amount": it["fc_amount"],
                     "booked_rate": it["booked_rate"], "closing_rate": rates[it["currency"]], "booked_inr": _money(it["fc_amount"] * it["booked_rate"]),
                     "closing_inr": _money(it["fc_amount"] * rates[it["currency"]]), "difference": diff})
        if it["kind"] in ("receivable", "bank", "loan_given"):
            asset_total += diff
        else:
            liab_total += diff
    asset_total, liab_total = _money(asset_total), _money(liab_total)
    summary = {"as_of": as_of.isoformat(), "rows": rows, "assets_difference": asset_total, "liabilities_difference": liab_total,
               "net_gain_loss": _money(asset_total + liab_total), "rates": rates}
    if body.dry_run or not rows:
        return {"posted": False, **summary, "message": None if rows else "There are no open foreign-currency items on or before that date."}
    if await db.fx_revaluations.find_one({"company_id": cid, "as_of": as_of.isoformat(), "status": "active"}, {"_id": 0, "id": 1}):
        raise HTTPException(409, "These items were already revalued for that date. Cancel that revaluation first if the rates were wrong.")
    if abs(asset_total) < 0.01 and abs(liab_total) < 0.01:
        return {"posted": False, **summary, "message": "The closing rates leave every item where it was booked, so nothing needs posting."}

    fx_id, ra_id, rl_id = await _default_id(cid, "5700"), await _default_id(cid, "1560"), await _default_id(cid, "2360")
    fw = (await get_settings(cid))["framework"]
    text = body.narration.strip() or f"Foreign currency monetary items restated at closing rates ({STANDARDS['fx'][fw].split(' - ')[0]})"
    lines: List[dict] = []

    def leg(bs_id: str, amount: float) -> None:           # gain: balance-sheet side up, P&L credit; loss: the mirror
        if amount > 0:
            lines.extend([{"account_id": bs_id, "debit": amount, "credit": 0.0, "memo": text}, {"account_id": fx_id, "debit": 0.0, "credit": amount, "memo": text}])
        elif amount < 0:
            lines.extend([{"account_id": fx_id, "debit": -amount, "credit": 0.0, "memo": text}, {"account_id": bs_id, "debit": 0.0, "credit": -amount, "memo": text}])
    leg(ra_id, asset_total)
    leg(rl_id, liab_total)
    run_id = str(uuid.uuid4())
    entry = await _post(cid, as_of.isoformat(), text, lines, "fx_revaluation", run_id, current_user)
    reversal, warning = None, None
    if body.auto_reverse:
        mirror = [{**l, "debit": l["credit"], "credit": l["debit"], "memo": f"Reversal: {l['memo']}"} for l in lines]
        try:
            reversal = await ac.post_journal_entry(cid, (as_of + timedelta(days=1)).isoformat(), f"Reversal of: {text}", mirror, "fx_revaluation_reversal", run_id, str(current_user.id))
        except ValueError as exc:
            warning = f"The revaluation is posted, but its reversal on {(as_of + timedelta(days=1)).isoformat()} could not be: {exc}"
    doc = {"id": run_id, "company_id": cid, **summary, "entry_id": entry["id"], "reversal_entry_id": (reversal or {}).get("id"), "auto_reverse": body.auto_reverse,
           "status": "active", "framework": fw, "created_by": str(current_user.id), "created_at": _now()}
    await db.fx_revaluations.insert_one(dict(doc))
    await _audit(cid, current_user, "FX_REVALUATION", "fx_revaluations", run_id, {"as_of": doc["as_of"], "net": doc["net_gain_loss"]})
    return {"posted": True, **summary, "id": run_id, "voucher_no": entry.get("voucher_no"), "warning": warning}


@router.get("/fx/revaluations")
async def fx_revaluations(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return await db.fx_revaluations.find({"company_id": _company(company_id)}, {"_id": 0, "rows": 0}).sort("as_of", -1).to_list(500)


@router.post("/fx/revaluations/{run_id}/cancel")
async def fx_revaluation_cancel(run_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    run = await db.fx_revaluations.find_one({"company_id": cid, "id": run_id}, {"_id": 0})
    if not run:
        raise HTTPException(404, "Revaluation not found.")
    if run["status"] == "cancelled":
        return {"cancelled": True, "already": True}
    from backend.accounting_lock import reverse_journal_entry
    for key in ("reversal_entry_id", "entry_id"):
        if run.get(key):
            try:
                await reverse_journal_entry(run[key], f"Revaluation as at {run['as_of']} cancelled", str(current_user.id))
            except ValueError as exc:
                raise HTTPException(400, str(exc))
    await db.fx_revaluations.update_one({"company_id": cid, "id": run_id}, {"$set": {"status": "cancelled", "cancelled_at": _now()}})
    await _audit(cid, current_user, "FX_REVALUATION_CANCELLED", "fx_revaluations", run_id, {})
    return {"cancelled": True}


# ═══ Provisions and contingencies (AS 29 / Ind AS 37) ═══════════════════════════════════════════
CATEGORIES = ("litigation", "warranty", "onerous_contract", "restructuring", "tax_dispute", "guarantee", "other")


class ProvisionCreate(BaseModel):
    company_id: str
    description: str = Field(..., min_length=3)
    category: Literal["litigation", "warranty", "onerous_contract", "restructuring", "tax_dispute", "guarantee", "other"] = "other"
    probability: Literal["probable", "possible", "remote"]
    estimable: bool = True
    amount: float = Field(..., ge=0)
    is_contingent_asset: bool = False
    discount_rate_pct: float = Field(0, ge=0, le=60)
    expected_years: float = Field(0, ge=0, le=50)
    as_of: str
    basis: str = ""


class ProvisionReassess(BaseModel):
    company_id: str
    as_of: str
    probability: Optional[Literal["probable", "possible", "remote"]] = None
    estimable: Optional[bool] = None
    amount: Optional[float] = Field(None, ge=0)


class ProvisionSettle(BaseModel):
    company_id: str
    date: str
    amount: float = Field(..., gt=0)
    account_id: str                  # what was paid or owed: a bank or cash account, or a payable
    narration: str = ""


def _target(doc: dict, framework: str) -> float:
    """The amount the books should carry for this obligation right now."""
    if doc["treatment"] != "recognise":
        return 0.0
    if framework == "IND_AS" and doc.get("discount_rate_pct") and doc.get("expected_years"):
        return present_value(doc["amount"], doc["discount_rate_pct"], doc["expected_years"])
    return _money(doc["amount"])


async def _move_provision(cid: str, doc: dict, delta: float, day: str, kind: str, text: str, user: User) -> Optional[dict]:
    """Post a change in a recognised provision: an addition (Dr expense, Cr provision) or a write-back (the reverse)."""
    if abs(delta) < 0.01:
        return None
    exp_id, prov_id = await _default_id(cid, "5980"), await _default_id(cid, "2400")
    lines = ([{"account_id": exp_id, "debit": delta, "credit": 0.0, "memo": text}, {"account_id": prov_id, "debit": 0.0, "credit": delta, "memo": text}]
             if delta > 0 else
             [{"account_id": prov_id, "debit": -delta, "credit": 0.0, "memo": text}, {"account_id": exp_id, "debit": 0.0, "credit": -delta, "memo": text}])
    entry = await _post(cid, day, text, lines, "provision", str(uuid.uuid4()), user)
    await db.provision_register.update_one({"company_id": cid, "id": doc["id"]}, {"$push": {"movements": {"date": day, "type": kind, "amount": abs(delta), "entry_id": entry["id"]}}})
    return entry


@router.post("/provisions")
async def provision_create(body: ProvisionCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    day = _parse_date(body.as_of, "As-of date").isoformat()
    fw = (await get_settings(cid))["framework"]
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "description": body.description.strip(), "category": body.category, "probability": body.probability,
           "estimable": body.estimable, "amount": _money(body.amount), "is_contingent_asset": body.is_contingent_asset, "discount_rate_pct": body.discount_rate_pct,
           "expected_years": body.expected_years, "as_of": day, "basis": body.basis.strip(), "movements": [], "created_by": str(current_user.id), "created_at": _now()}
    doc["treatment"] = treatment(body.probability, body.estimable, body.is_contingent_asset)
    doc["recognised"] = 0.0
    await db.provision_register.insert_one(dict(doc))
    entry = None
    if doc["treatment"] == "recognise":
        target = _target(doc, fw)
        entry = await _move_provision(cid, doc, target, day, "addition", f"Provision: {doc['description']}", current_user)
        await db.provision_register.update_one({"company_id": cid, "id": doc["id"]}, {"$set": {"recognised": target}})
    await _audit(cid, current_user, "PROVISION_REGISTERED", "provision_register", doc["id"], {"treatment": doc["treatment"], "amount": doc["amount"]})
    out = await db.provision_register.find_one({"company_id": cid, "id": doc["id"]}, {"_id": 0})
    return {**out, "voucher_no": (entry or {}).get("voucher_no"), "standard": STANDARDS["provisions"][fw]}


@router.get("/provisions")
async def provision_list(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return await db.provision_register.find({"company_id": _company(company_id)}, {"_id": 0}).sort("as_of", -1).to_list(2000)


@router.put("/provisions/{prov_id}/reassess")
async def provision_reassess(prov_id: str, body: ProvisionReassess, current_user: User = Depends(get_current_user)):
    """Re-judge an obligation (it became probable, the estimate moved, the claim fell away) and post only the change."""
    _need_post(current_user)
    cid = _company(body.company_id)
    day = _parse_date(body.as_of, "As-of date").isoformat()
    doc = await db.provision_register.find_one({"company_id": cid, "id": prov_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found.")
    fw = (await get_settings(cid))["framework"]
    for k in ("probability", "estimable", "amount"):
        v = getattr(body, k)
        if v is not None:
            doc[k] = _money(v) if k == "amount" else v
    doc["treatment"] = treatment(doc["probability"], doc["estimable"], doc.get("is_contingent_asset", False))
    used = sum(m["amount"] for m in doc.get("movements", []) if m["type"] == "utilised")      # what has already been paid out of it
    target = _money(max(_target(doc, fw) - used, 0.0))
    delta = _money(target - float(doc.get("recognised") or 0))
    text = f"Provision reassessed: {doc['description']}"
    entry = await _move_provision(cid, doc, delta, day, "addition" if delta > 0 else "reversed", text, current_user)
    await db.provision_register.update_one({"company_id": cid, "id": prov_id}, {"$set": {
        "probability": doc["probability"], "estimable": doc["estimable"], "amount": doc["amount"], "treatment": doc["treatment"], "recognised": target}})
    await _audit(cid, current_user, "PROVISION_REASSESSED", "provision_register", prov_id, {"treatment": doc["treatment"], "delta": delta})
    return {**(await db.provision_register.find_one({"company_id": cid, "id": prov_id}, {"_id": 0})), "voucher_no": (entry or {}).get("voucher_no")}


@router.post("/provisions/{prov_id}/settle")
async def provision_settle(prov_id: str, body: ProvisionSettle, current_user: User = Depends(get_current_user)):
    """Pay or settle part of a recognised provision: Dr Provision, Cr the account that paid or now owes it."""
    _need_post(current_user)
    cid = _company(body.company_id)
    doc = await db.provision_register.find_one({"company_id": cid, "id": prov_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Not found.")
    left = float(doc.get("recognised") or 0)
    if body.amount > left + 0.005:
        raise HTTPException(400, f"Only {left:,.2f} is provided for. Book anything above that as an expense when it is incurred.")
    acct = (await _accounts_by_id(cid, [body.account_id])).get(body.account_id)
    if not acct or acct.get("type") not in ("asset", "liability"):
        raise HTTPException(400, "Choose the bank, cash or payable account that settles it.")
    prov_id_acct = await _default_id(cid, "2400")
    day = _parse_date(body.date).isoformat()
    text = body.narration.strip() or f"Settled against provision: {doc['description']}"
    amt = _money(body.amount)
    entry = await _post(cid, day, text, [{"account_id": prov_id_acct, "debit": amt, "credit": 0.0, "memo": text},
                                        {"account_id": acct["id"], "debit": 0.0, "credit": amt, "memo": text}], "provision_settlement", str(uuid.uuid4()), current_user)
    await db.provision_register.update_one({"company_id": cid, "id": prov_id}, {"$set": {"recognised": _money(left - amt)},
                                           "$push": {"movements": {"date": day, "type": "utilised", "amount": amt, "entry_id": entry["id"]}}})
    return {"settled": True, "voucher_no": entry.get("voucher_no"), "remaining": _money(left - amt)}


@router.get("/provisions/disclosure")
async def provision_disclosure(company_id: str = Query(""), fy: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    """The AS 29 / Ind AS 37 note: movement in each class of provision, and the contingent liabilities and assets."""
    _need_view(current_user)
    cid = _company(company_id)
    lo, hi = _fy_or_current(fy)
    fw = (await get_settings(cid))["framework"]
    docs = await db.provision_register.find({"company_id": cid}, {"_id": 0}).to_list(5000)
    classes: Dict[str, dict] = {}
    contingent_liabilities, contingent_assets = [], []
    for d in docs:
        if d["treatment"] == "disclose":
            (contingent_assets if d.get("is_contingent_asset") else contingent_liabilities).append(
                {"description": d["description"], "category": d["category"], "estimate": d["amount"] if d["estimable"] else None, "probability": d["probability"], "basis": d["basis"]})
        c = classes.setdefault(d["category"], {"category": d["category"], "opening": 0.0, "additions": 0.0, "utilised": 0.0, "reversed": 0.0, "closing": 0.0})
        for m in d.get("movements", []):
            sign = 1 if m["type"] == "addition" else -1
            if m["date"] < lo.isoformat():
                c["opening"] += sign * m["amount"]
            elif m["date"] <= hi.isoformat():
                c[{"addition": "additions", "utilised": "utilised", "reversed": "reversed"}[m["type"]]] += m["amount"]
    for c in classes.values():
        c["closing"] = c["opening"] + c["additions"] - c["utilised"] - c["reversed"]
        for k in ("opening", "additions", "utilised", "reversed", "closing"):
            c[k] = _money(c[k])
    return {"standard": STANDARDS["provisions"][fw], "financial_year": _fy_name(lo), "provisions": sorted(classes.values(), key=lambda x: x["category"]),
            "contingent_liabilities": contingent_liabilities, "contingent_assets": contingent_assets,
            "total_provisions": _money(sum(c["closing"] for c in classes.values()))}


# ═══ Related parties (AS 18 / Ind AS 24) ════════════════════════════════════════════════════════
RELATIONSHIPS = {
    "holding_company": "Holding company", "subsidiary": "Subsidiary", "fellow_subsidiary": "Fellow subsidiary", "associate": "Associate",
    "joint_venture": "Joint venture", "kmp": "Key management personnel", "kmp_relative": "Relative of key management personnel",
    "kmp_enterprise": "Enterprise controlled or influenced by key management personnel", "other": "Other related party",
}
NATURES = {
    "sale": "Sale of goods or services", "purchase": "Purchase of goods or services", "loan_given": "Loans given", "loan_taken": "Loans taken",
    "interest_paid": "Interest paid", "interest_received": "Interest received", "rent_paid": "Rent paid", "rent_received": "Rent received",
    "remuneration": "Remuneration", "reimbursement": "Reimbursement of expenses", "guarantee": "Guarantees given or received", "dividend": "Dividend", "other": "Other",
}


class PartyCreate(BaseModel):
    company_id: str
    name: str = Field(..., min_length=2)
    relationship: Literal["holding_company", "subsidiary", "fellow_subsidiary", "associate", "joint_venture", "kmp", "kmp_relative", "kmp_enterprise", "other"]
    pan: str = ""
    note: str = ""


class PartyTxn(BaseModel):
    company_id: str
    party_id: str
    date: str
    nature: Literal["sale", "purchase", "loan_given", "loan_taken", "interest_paid", "interest_received", "rent_paid", "rent_received",
                    "remuneration", "reimbursement", "guarantee", "dividend", "other"]
    amount: float = Field(..., gt=0)
    outstanding: float = 0.0          # balance still receivable (+) or payable (-) from this party after the transaction
    note: str = ""


@router.post("/related-parties")
async def party_create(body: PartyCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    name = body.name.strip()
    if await db.related_parties.find_one({"company_id": cid, "name_lc": name.lower()}, {"_id": 0, "id": 1}):
        raise HTTPException(409, f"{name} is already in the register.")
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "name": name, "name_lc": name.lower(), "relationship": body.relationship, "pan": body.pan.strip().upper(),
           "note": body.note.strip(), "created_by": str(current_user.id), "created_at": _now()}
    await db.related_parties.insert_one(dict(doc))
    doc.pop("name_lc")
    return doc


@router.get("/related-parties")
async def party_list(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return await db.related_parties.find({"company_id": _company(company_id)}, {"_id": 0, "name_lc": 0}).sort("name", 1).to_list(2000)


@router.delete("/related-parties/{party_id}")
async def party_delete(party_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    if await db.related_party_transactions.count_documents({"company_id": cid, "party_id": party_id}):
        raise HTTPException(409, "Transactions are recorded against this party, so it cannot be removed.")
    res = await db.related_parties.delete_one({"company_id": cid, "id": party_id})
    if not res.deleted_count:
        raise HTTPException(404, "Party not found.")
    return {"deleted": True}


@router.post("/related-parties/transactions")
async def party_txn_create(body: PartyTxn, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    party = await db.related_parties.find_one({"company_id": cid, "id": body.party_id}, {"_id": 0})
    if not party:
        raise HTTPException(404, "Choose a party from the register first.")
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "party_id": body.party_id, "party_name": party["name"], "relationship": party["relationship"],
           "date": _parse_date(body.date).isoformat(), "nature": body.nature, "amount": _money(body.amount), "outstanding": _money(body.outstanding),
           "note": body.note.strip(), "created_by": str(current_user.id), "created_at": _now()}
    await db.related_party_transactions.insert_one(dict(doc))
    return doc


@router.get("/related-parties/transactions")
async def party_txn_list(company_id: str = Query(""), fy: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    lo, hi = _fy_or_current(fy)
    q = {"company_id": _company(company_id), "date": {"$gte": lo.isoformat(), "$lte": hi.isoformat()}}
    return await db.related_party_transactions.find(q, {"_id": 0}).sort("date", -1).to_list(10000)


@router.delete("/related-parties/transactions/{txn_id}")
async def party_txn_delete(txn_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    res = await db.related_party_transactions.delete_one({"company_id": _company(company_id), "id": txn_id})
    if not res.deleted_count:
        raise HTTPException(404, "Transaction not found.")
    return {"deleted": True}


@router.get("/related-parties/disclosure")
async def party_disclosure(company_id: str = Query(""), fy: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    lo, hi = _fy_or_current(fy)
    fw = (await get_settings(cid))["framework"]
    txns = await db.related_party_transactions.find({"company_id": cid, "date": {"$gte": lo.isoformat(), "$lte": hi.isoformat()}}, {"_id": 0}).to_list(50000)
    parties = {p["id"]: p for p in await db.related_parties.find({"company_id": cid}, {"_id": 0}).to_list(5000)}
    groups: Dict[str, Dict[str, dict]] = {}
    for t in sorted(txns, key=lambda x: (x["date"], x["created_at"])):
        g = groups.setdefault(t["relationship"], {}).setdefault(t["party_id"], {"party": t["party_name"], "transactions": {}, "outstanding": 0.0})
        g["transactions"][t["nature"]] = _money(g["transactions"].get(t["nature"], 0) + t["amount"])
        g["outstanding"] = t["outstanding"]              # the latest balance stands
    out = []
    for rel in RELATIONSHIPS:
        if rel in groups:
            out.append({"relationship": rel, "label": RELATIONSHIPS[rel], "parties": [
                {"party": p["party"], "transactions": [{"nature": n, "label": NATURES[n], "amount": a} for n, a in sorted(p["transactions"].items())],
                 "outstanding": _money(p["outstanding"])} for p in groups[rel].values()]})
    kmp_total = _money(sum(t["amount"] for t in txns if t["relationship"] == "kmp" and t["nature"] == "remuneration"))
    notes = ["Disclose the name of each related party and the nature of the relationship where control exists, even if there were no transactions."]
    if fw == "IND_AS":
        notes.append("Ind AS 24 also asks for key management personnel compensation by category: short-term benefits, post-employment, other long-term, termination and share-based payments.")
    return {"standard": STANDARDS["related_parties"][fw], "financial_year": _fy_name(lo), "groups": out, "registered_parties": len(parties),
            "kmp_remuneration": kmp_total, "notes": notes}


# ═══ EPS (AS 20 / Ind AS 33) ════════════════════════════════════════════════════════════════════
class ShareEvent(BaseModel):
    company_id: str
    date: str
    type: Literal["opening", "issue", "buyback", "bonus", "split", "potential"]
    shares: float = Field(0, ge=0)
    ratio: float = Field(0, ge=0)                    # bonus: new shares per share held (0.5 = 1 for 2); split: the multiple (10)
    face_value: float = Field(10, gt=0)
    instrument: Optional[Literal["option", "convertible"]] = None
    exercise_price: float = Field(0, ge=0)
    earnings_addback: float = Field(0, ge=0)         # post-tax interest saved if a convertible converts
    note: str = ""


@router.post("/share-capital/events")
async def share_event_create(body: ShareEvent, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    if body.type in ("opening", "issue", "buyback", "potential") and body.shares <= 0:
        raise HTTPException(400, "Enter the number of shares.")
    if body.type in ("bonus", "split") and body.ratio <= 0:
        raise HTTPException(400, "Enter the bonus ratio or the split multiple.")
    if body.type == "potential" and not body.instrument:
        raise HTTPException(400, "Say whether the potential shares come from options or a convertible.")
    doc = {"id": str(uuid.uuid4()), "company_id": cid, **body.model_dump(exclude={"company_id"}), "date": _parse_date(body.date).isoformat(),
           "created_by": str(current_user.id), "created_at": _now()}
    await db.share_capital_register.insert_one(dict(doc))
    return doc


@router.get("/share-capital/events")
async def share_event_list(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return await db.share_capital_register.find({"company_id": _company(company_id)}, {"_id": 0}).sort("date", 1).to_list(5000)


@router.delete("/share-capital/events/{event_id}")
async def share_event_delete(event_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    res = await db.share_capital_register.delete_one({"company_id": _company(company_id), "id": event_id})
    if not res.deleted_count:
        raise HTTPException(404, "Entry not found.")
    return {"deleted": True}


@router.get("/eps")
async def earnings_per_share(company_id: str = Query(""), fy: Optional[str] = Query(None), preference_dividend: float = Query(0, ge=0),
                             average_market_price: Optional[float] = Query(None, gt=0), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    lo, hi = _fy_or_current(fy)
    fw = (await get_settings(cid))["framework"]
    events = await db.share_capital_register.find({"company_id": cid}, {"_id": 0}).to_list(5000)
    real = [e for e in events if e["type"] != "potential"]
    if not real:
        raise HTTPException(400, "Record the equity share capital (opening shares, issues, bonus, split) before working out EPS.")
    st = await ac._load_statements(cid, lo.isoformat(), hi.isoformat())
    pat = float(st["schedule_iii"]["pnl"]["profit_after_tax"])
    numerator = pat - preference_dividend
    w = weighted_average_shares(real, lo, hi)
    potentials = [{"instrument": e["instrument"], "shares": e["shares"], "exercise_price": e.get("exercise_price", 0), "earnings_addback": e.get("earnings_addback", 0),
                   "description": e.get("note") or e["instrument"]} for e in events if e["type"] == "potential" and e["date"] <= hi.isoformat()]
    res = eps(numerator, w["weighted"], potentials, average_market_price)
    face = next((float(e["face_value"]) for e in real if e.get("face_value")), 10.0)
    book_capital = float(st["schedule_iii"]["balance_sheet"]["equity_and_liabilities"]["shareholders_funds"]["share_capital"])
    return {"standard": STANDARDS["eps"][fw], "financial_year": _fy_name(lo), "profit_after_tax": _money(pat), "preference_dividend": _money(preference_dividend),
            "earnings_for_equity": _money(numerator), "weighted_average_shares": round(w["weighted"], 2), "closing_shares": w["closing"], "days": w["days"],
            "face_value": face, "basic_eps": res["basic"], "diluted_eps": res["diluted"], "diluted_earnings": res["diluted_numerator"],
            "diluted_shares": res["diluted_shares"], "instruments": res["instruments"], "share_capital_per_register": _money(w["closing"] * face),
            "share_capital_in_books": _money(book_capital), "capital_matches": abs(w["closing"] * face - book_capital) < 1.0,
            "notes": ["Basic EPS = (profit after tax - preference dividend) / weighted average equity shares.",
                      "Bonus issues and splits are applied to every earlier share, as the standard requires." ]}


# ═══ Receivable provisioning ════════════════════════════════════════════════════════════════════
class MatrixUpdate(BaseModel):
    company_id: str
    rates: List[float] = Field(..., min_length=6, max_length=6)       # % for: not due, 1-30, 31-90, 91-180, 181-365, over 365 days
    forward_looking_pct: float = Field(0, ge=0, le=100)


async def _matrix(cid: str, fw: str) -> dict:
    doc = await db.accounting_settings.find_one({"company_id": cid}, {"_id": 0}) or {}
    saved = doc.get("ecl_matrix")
    default = MATRIX_IND_AS if fw == "IND_AS" else MATRIX_AS
    return {"rates": (saved or {}).get("rates") or default, "forward_looking_pct": (saved or {}).get("forward_looking_pct", 0.0), "is_default": not saved, "defaults": default}


@router.put("/receivables/matrix")
async def receivable_matrix_update(body: MatrixUpdate, current_user: User = Depends(get_current_user)):
    _need_admin(current_user)
    cid = _company(body.company_id)
    if any(r < 0 or r > 100 for r in body.rates):
        raise HTTPException(400, "Each rate must be between 0 and 100 per cent.")
    await db.accounting_settings.update_one({"company_id": cid}, {"$set": {"ecl_matrix": {"rates": body.rates, "forward_looking_pct": body.forward_looking_pct}}}, upsert=True)
    return await _matrix(cid, (await get_settings(cid))["framework"])


async def _outstanding_invoices(cid: str) -> List[dict]:
    out = []
    rows = await db.invoices.find({"company_id": cid, "status": {"$nin": ["draft", "cancelled", "paid"]}}, {"_id": 0}).to_list(100000)
    for r in rows:
        amt = r.get("amount_due")
        if amt is None:
            amt = float(r.get("grand_total") or r.get("total_amount") or r.get("total") or 0) - float(r.get("amount_paid") or 0)
        due = str(r.get("due_date") or r.get("invoice_date") or "")[:10]
        if amt and amt > 0 and due:
            out.append({"invoice_no": r.get("invoice_no"), "client": r.get("client_name"), "due_date": due, "amount": float(amt)})
    return out


@router.get("/receivables/provision")
async def receivable_provision(company_id: str = Query(""), as_of: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    day = _parse_date(as_of, "As-of date") if as_of else date.today()
    fw = (await get_settings(cid))["framework"]
    m = await _matrix(cid, fw)
    invs = await _outstanding_invoices(cid)
    res = ageing(invs, day, m["rates"], m["forward_looking_pct"])
    prov_id = await _default_id(cid, "1150")
    current = -(await _balance(cid, prov_id, day.isoformat()))
    return {"standard": STANDARDS["receivables"][fw], "as_of": day.isoformat(), "framework": fw, **res, "matrix": m, "invoice_count": len(invs),
            "current_provision": _money(current), "change_needed": _money(res["provision_required"] - current),
            "basis": ("Expected credit loss on a provision matrix, adjusted for forward-looking information (Ind AS 109 simplified approach)." if fw == "IND_AS"
                      else "Provision for balances whose recovery is in doubt, estimated by ageing (AS: a specific-provision approach).")}


class ProvisionPost(BaseModel):
    company_id: str
    as_of: str
    narration: str = ""


@router.post("/receivables/provision/post")
async def receivable_provision_post(body: ProvisionPost, current_user: User = Depends(get_current_user)):
    """Set the provision for doubtful debts to the computed figure, through the same period-end entry the Period-end tab uses."""
    _need_post(current_user)
    data = await receivable_provision(company_id=body.company_id, as_of=body.as_of, current_user=current_user)
    return {**(await create_adjustment(AdjustmentCreate(company_id=body.company_id, kind="provision_doubtful_debts", as_of=body.as_of,
                                                          target_balance=data["provision_required"], narration=body.narration or f"Provision per ageing ({data['framework'].replace('_', ' ')})"), current_user)),
            "provision_required": data["provision_required"]}
