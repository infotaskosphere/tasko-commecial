"""Accounting standards, part 2: employee benefits, leases and borrowing costs.

* Employee benefits (AS 15 / Ind AS 19)   gratuity by the Payment of Gratuity Act formula and leave encashment, trued up to
                                          a target balance. An actuary's figure can replace the formula.
* Leases (AS 19 / Ind AS 116)             Ind AS: a right-of-use asset and a lease liability for every lease except short-term
                                          and low-value ones. AS: operating leases are expensed straight-line; a finance lease
                                          is capitalised the same way as under Ind AS. Rent already booked as an expense is
                                          reclassified each period, so nothing is double counted.
* Borrowing costs (AS 16 / Ind AS 23)    interest on a loan for a qualifying asset moves from finance cost into the asset.
"""
from __future__ import annotations

import logging
import uuid
from datetime import date, datetime, timedelta, timezone
from typing import List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.accounting_books import (
    _accounts_by_id, _audit, _balance, _company, _default_id, _fy_bounds, _money, _need_post, _need_view, _parse_date, _post, get_settings,
)
from backend.dependencies import db, get_current_user
from backend.models import User
from backend.standards_calc import PERIODS_PER_YEAR, borrowing_cost, d_, gratuity, lease_schedule, leave_encashment

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/accounting-books/standards", tags=["Accounting Books - Standards"])

STANDARDS = {
    "employee_benefits": {"AS": "AS 15 - Employee Benefits", "IND_AS": "Ind AS 19 - Employee Benefits"},
    "leases": {"AS": "AS 19 - Leases", "IND_AS": "Ind AS 116 - Leases"},
    "borrowing_costs": {"AS": "AS 16 - Borrowing Costs", "IND_AS": "Ind AS 23 - Borrowing Costs"},
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fy_or_current(fy: Optional[str]) -> tuple:
    if fy:
        return _fy_bounds(fy)
    t = date.today()
    s = t.year if t.month >= 4 else t.year - 1
    return date(s, 4, 1), date(s + 1, 3, 31)


def _pair(lines: List[dict], expense_id: str, balance_id: str, delta: float, text: str) -> None:
    """Raise (delta > 0) or release (delta < 0) a credit-balance provision against an expense."""
    if delta > 0:
        lines.extend([{"account_id": expense_id, "debit": delta, "credit": 0.0, "memo": text}, {"account_id": balance_id, "debit": 0.0, "credit": delta, "memo": text}])
    elif delta < 0:
        lines.extend([{"account_id": balance_id, "debit": -delta, "credit": 0.0, "memo": text}, {"account_id": expense_id, "debit": 0.0, "credit": -delta, "memo": text}])


# ═══ Employee benefits (AS 15 / Ind AS 19) ══════════════════════════════════════════════════════
class EmployeeCreate(BaseModel):
    company_id: str
    name: str = Field(..., min_length=1)
    joining_date: str
    monthly_basic: float = Field(..., gt=0)            # basic pay plus dearness allowance, the last drawn monthly figure
    leave_days: float = Field(0, ge=0)                 # accumulated leave that can be encashed
    exit_date: Optional[str] = None


class EmployeeUpdate(BaseModel):
    company_id: str
    monthly_basic: Optional[float] = Field(None, gt=0)
    leave_days: Optional[float] = Field(None, ge=0)
    exit_date: Optional[str] = None


@router.post("/employee-benefits/employees")
async def employee_create(body: EmployeeCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    doc = {"id": str(uuid.uuid4()), "company_id": cid, "name": body.name.strip(), "joining_date": _parse_date(body.joining_date, "Joining date").isoformat(),
           "monthly_basic": _money(body.monthly_basic), "leave_days": body.leave_days,
           "exit_date": _parse_date(body.exit_date, "Exit date").isoformat() if body.exit_date else None, "created_by": str(current_user.id), "created_at": _now()}
    await db.employee_benefit_roster.insert_one(dict(doc))
    return doc


@router.get("/employee-benefits/employees")
async def employee_list(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return await db.employee_benefit_roster.find({"company_id": _company(company_id)}, {"_id": 0}).sort("name", 1).to_list(20000)


@router.put("/employee-benefits/employees/{emp_id}")
async def employee_update(emp_id: str, body: EmployeeUpdate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    changes = {k: v for k, v in body.model_dump(exclude={"company_id"}).items() if v is not None}
    if "exit_date" in changes:
        changes["exit_date"] = _parse_date(changes["exit_date"], "Exit date").isoformat()
    res = await db.employee_benefit_roster.update_one({"company_id": cid, "id": emp_id}, {"$set": changes})
    if not res.matched_count:
        raise HTTPException(404, "Employee not found.")
    return await db.employee_benefit_roster.find_one({"company_id": cid, "id": emp_id}, {"_id": 0})


@router.delete("/employee-benefits/employees/{emp_id}")
async def employee_delete(emp_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    res = await db.employee_benefit_roster.delete_one({"company_id": _company(company_id), "id": emp_id})
    if not res.deleted_count:
        raise HTTPException(404, "Employee not found.")
    return {"deleted": True}


async def _benefit_valuation(cid: str, day: date) -> dict:
    roster = await db.employee_benefit_roster.find({"company_id": cid}, {"_id": 0}).to_list(50000)
    rows, g_total, l_total = [], 0.0, 0.0
    for e in roster:
        if e.get("exit_date") and e["exit_date"] <= day.isoformat():
            continue
        if e["joining_date"] > day.isoformat():
            continue
        g = gratuity(e["monthly_basic"], d_(e["joining_date"]), day)
        lv = leave_encashment(e["monthly_basic"], e.get("leave_days") or 0)
        rows.append({"employee_id": e["id"], "name": e["name"], "joining_date": e["joining_date"], "monthly_basic": e["monthly_basic"], "service_years": g["service_years"],
                     "gratuity_eligible": g["eligible"], "gratuity": g["amount"], "leave_days": e.get("leave_days") or 0, "leave_encashment": lv})
        g_total += g["amount"]
        l_total += lv
    g_id, l_id = await _default_id(cid, "2410"), await _default_id(cid, "2420")
    g_book, l_book = -(await _balance(cid, g_id, day.isoformat())), -(await _balance(cid, l_id, day.isoformat()))
    return {"as_of": day.isoformat(), "employees": rows, "gratuity_formula": round(g_total, 2), "leave_encashment": round(l_total, 2),
            "gratuity_in_books": _money(g_book), "leave_in_books": _money(l_book), "gratuity_account_id": g_id, "leave_account_id": l_id}


@router.get("/employee-benefits/valuation")
async def benefit_valuation(company_id: str = Query(""), as_of: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    day = _parse_date(as_of, "As-of date") if as_of else date.today()
    fw = (await get_settings(cid))["framework"]
    v = await _benefit_valuation(cid, day)
    return {**v, "standard": STANDARDS["employee_benefits"][fw],
            "note": "Gratuity is worked out by the statutory formula (15/26 x last drawn pay x completed years, ceiling 20 lakh) as a proxy. "
                    "AS 15 and Ind AS 19 expect the defined benefit obligation to be measured by an actuary using the projected unit credit method; enter that figure when you post."}


class BenefitPost(BaseModel):
    company_id: str
    as_of: str
    actuarial_gratuity: Optional[float] = Field(None, ge=0)     # replaces the formula figure when an actuary has valued the plan
    actuarial_leave: Optional[float] = Field(None, ge=0)
    narration: str = ""


@router.post("/employee-benefits/post")
async def benefit_post(body: BenefitPost, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    day = _parse_date(body.as_of, "As-of date")
    v = await _benefit_valuation(cid, day)
    g_target = _money(body.actuarial_gratuity if body.actuarial_gratuity is not None else v["gratuity_formula"])
    l_target = _money(body.actuarial_leave if body.actuarial_leave is not None else v["leave_encashment"])
    dg, dl = _money(g_target - v["gratuity_in_books"]), _money(l_target - v["leave_in_books"])
    if abs(dg) < 0.01 and abs(dl) < 0.01:
        return {"posted": False, "message": "The provisions already stand at these amounts.", "gratuity": g_target, "leave": l_target}
    exp_id = await _default_id(cid, "5105")
    text = body.narration.strip() or f"Provision for gratuity and leave encashment as at {day.isoformat()}"
    lines: List[dict] = []
    _pair(lines, exp_id, v["gratuity_account_id"], dg, text)
    _pair(lines, exp_id, v["leave_account_id"], dl, text)
    post_id = str(uuid.uuid4())
    entry = await _post(cid, day.isoformat(), text, lines, "employee_benefit", post_id, current_user)
    doc = {"id": post_id, "company_id": cid, "as_of": day.isoformat(), "gratuity": g_target, "leave": l_target, "gratuity_change": dg, "leave_change": dl,
           "method": "actuarial" if body.actuarial_gratuity is not None else "statutory formula", "employees": len(v["employees"]), "entry_id": entry["id"],
           "created_by": str(current_user.id), "created_at": _now()}
    await db.employee_benefit_provisions.insert_one(dict(doc))
    await _audit(cid, current_user, "EMPLOYEE_BENEFIT_PROVISION", "employee_benefit_provisions", post_id, {"gratuity": g_target, "leave": l_target})
    return {"posted": True, **doc, "voucher_no": entry.get("voucher_no")}


@router.get("/employee-benefits/postings")
async def benefit_postings(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    return await db.employee_benefit_provisions.find({"company_id": _company(company_id)}, {"_id": 0}).sort("as_of", -1).to_list(500)


# ═══ Leases (AS 19 / Ind AS 116) ════════════════════════════════════════════════════════════════
class LeaseCreate(BaseModel):
    company_id: str
    lessor: str = Field(..., min_length=2)
    asset: str = Field(..., min_length=2)
    start_date: str
    periods: int = Field(..., ge=1, le=600)
    frequency: Literal["monthly", "quarterly", "half_yearly", "yearly"] = "monthly"
    payment: float = Field(..., gt=0)
    in_advance: bool = False
    escalation_pct: float = Field(0, ge=0, le=50)       # yearly rise in rent
    discount_rate_pct: float = Field(0, ge=0, le=60)    # the lessee's incremental borrowing rate (or the rate implicit in the lease)
    low_value: bool = False                             # Ind AS 116 exemption for low-value assets
    finance_lease: bool = False                         # AS 19: substantially all risks and rewards pass to the lessee
    rent_account_id: Optional[str] = None               # where the rent payments were booked; defaults to Rent Expense


def _treatment(framework: str, months: int, low_value: bool, finance_lease: bool) -> str:
    if framework == "IND_AS":
        return "exempt" if (months <= 12 or low_value) else "rou"
    return "finance" if finance_lease else "operating"


def _schedule(lease: dict) -> dict:
    rate = lease["discount_rate_pct"] if lease["treatment"] in ("rou", "finance") else 0.0
    return lease_schedule(lease["payment"], lease["periods"], lease["frequency"], rate, d_(lease["start_date"]), lease.get("in_advance", False), lease.get("escalation_pct", 0.0))


@router.post("/leases")
async def lease_create(body: LeaseCreate, current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(body.company_id)
    fw = (await get_settings(cid))["framework"]
    months = body.periods * (12 // PERIODS_PER_YEAR[body.frequency])
    treat = _treatment(fw, months, body.low_value, body.finance_lease)
    if treat in ("rou", "finance") and body.discount_rate_pct <= 0:
        raise HTTPException(400, "Enter the discount rate: the lessee's incremental borrowing rate, or the rate implicit in the lease.")
    if body.rent_account_id and not (await _accounts_by_id(cid, [body.rent_account_id])).get(body.rent_account_id):
        raise HTTPException(400, "That rent account does not belong to this company.")
    doc = {"id": str(uuid.uuid4()), "company_id": cid, **body.model_dump(exclude={"company_id"}), "start_date": _parse_date(body.start_date, "Start date").isoformat(),
           "term_months": months, "treatment": treat, "framework_at_creation": fw, "recognised": False, "recognise_entry_id": None, "posted_periods": [],
           "status": "active", "created_by": str(current_user.id), "created_at": _now()}
    await db.leases.insert_one(dict(doc))
    sched = _schedule(doc)
    await _audit(cid, current_user, "LEASE_REGISTERED", "leases", doc["id"], {"treatment": treat})
    return {**doc, "standard": STANDARDS["leases"][fw], "present_value": sched["present_value"], "total_payments": sched["total_payments"]}


@router.get("/leases")
async def lease_list(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    out = []
    for l in await db.leases.find({"company_id": _company(company_id)}, {"_id": 0}).sort("start_date", -1).to_list(2000):
        s = _schedule(l)
        out.append({**l, "present_value": s["present_value"], "total_payments": s["total_payments"], "periods_posted": len(l.get("posted_periods", []))})
    return out


@router.get("/leases/disclosure")
async def lease_disclosure(company_id: str = Query(""), as_of: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    """The lease note: balances, the maturity of future payments, and the charge for the year."""
    _need_view(current_user)
    cid = _company(company_id)
    day = _parse_date(as_of, "As-of date") if as_of else date.today()
    fw = (await get_settings(cid))["framework"]
    lo, _hi = _fy_or_current(None)
    y1, y5 = day + timedelta(days=365), day + timedelta(days=365 * 5)
    buckets = {"within_1_year": 0.0, "1_to_5_years": 0.0, "over_5_years": 0.0}
    current_portion = interest_fy = dep_fy = sl_fy = 0.0
    leases = await db.leases.find({"company_id": cid, "status": "active"}, {"_id": 0}).to_list(2000)
    for l in leases:
        s = _schedule(l)
        for r in s["rows"]:
            due = d_(r["start"]) if l.get("in_advance") else d_(r["end"])
            if due <= day:
                continue
            key = "within_1_year" if due <= y1 else "1_to_5_years" if due <= y5 else "over_5_years"
            buckets[key] += r["payment"]
            if due <= y1 and l["treatment"] in ("rou", "finance"):
                current_portion += r["principal"]
        for r in s["rows"]:
            if lo.isoformat() <= r["end"] <= day.isoformat():
                if l["treatment"] in ("rou", "finance"):
                    interest_fy += r["interest"]
                    dep_fy += s["depreciation_per_period"]
                else:
                    sl_fy += s["straight_line_per_period"]
    rou_id, liab_id = await _default_id(cid, "1370"), await _default_id(cid, "2650")
    liab = -(await _balance(cid, liab_id, day.isoformat()))
    return {"standard": STANDARDS["leases"][fw], "as_of": day.isoformat(), "framework": fw, "lease_count": len(leases),
            "right_of_use_net": _money(await _balance(cid, rou_id, day.isoformat())), "lease_liability": _money(liab),
            "liability_current": _money(min(current_portion, liab) if liab > 0 else 0), "liability_non_current": _money(max(liab - current_portion, 0)),
            "maturity": {k: _money(v) for k, v in buckets.items()}, "total_future_payments": _money(sum(buckets.values())),
            "charge_for_year": {"interest_on_lease_liabilities": _money(interest_fy), "depreciation_of_right_of_use_assets": _money(dep_fy),
                                "operating_and_short_term_rent": _money(sl_fy)},
            "note": ("Future lease payments are shown undiscounted. Short-term and low-value leases are expensed straight-line." if fw == "IND_AS"
                     else "Future minimum payments on non-cancellable operating leases are shown for each period, as AS 19 requires.")}


@router.get("/leases/{lease_id}")
async def lease_detail(lease_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    l = await db.leases.find_one({"company_id": _company(company_id), "id": lease_id}, {"_id": 0})
    if not l:
        raise HTTPException(404, "Lease not found.")
    s = _schedule(l)
    posted = {p["period"] for p in l.get("posted_periods", [])}
    return {**l, "schedule": [{**r, "posted": r["period"] in posted} for r in s["rows"]], "present_value": s["present_value"], "total_payments": s["total_payments"],
            "straight_line_per_period": s["straight_line_per_period"], "depreciation_per_period": s["depreciation_per_period"]}


@router.post("/leases/{lease_id}/recognise")
async def lease_recognise(lease_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """At commencement: Dr Right-of-use asset, Cr Lease liability, both at the present value of the payments."""
    _need_post(current_user)
    cid = _company(company_id)
    l = await db.leases.find_one({"company_id": cid, "id": lease_id}, {"_id": 0})
    if not l:
        raise HTTPException(404, "Lease not found.")
    if l["treatment"] not in ("rou", "finance"):
        raise HTTPException(400, "This lease is expensed straight-line, so there is no asset or liability to recognise.")
    if l.get("recognised"):
        raise HTTPException(409, "This lease is already recognised.")
    pv = _schedule(l)["present_value"]
    rou_id, liab_id = await _default_id(cid, "1370"), await _default_id(cid, "2650")
    text = f"Lease recognised: {l['asset']} from {l['lessor']}"
    entry = await _post(cid, l["start_date"], text, [{"account_id": rou_id, "debit": pv, "credit": 0.0, "memo": text}, {"account_id": liab_id, "debit": 0.0, "credit": pv, "memo": text}],
                        "lease_recognition", lease_id, current_user)
    await db.leases.update_one({"company_id": cid, "id": lease_id}, {"$set": {"recognised": True, "recognise_entry_id": entry["id"], "recognised_amount": pv}})
    await _audit(cid, current_user, "LEASE_RECOGNISED", "leases", lease_id, {"present_value": pv})
    return {"recognised": True, "amount": pv, "voucher_no": entry.get("voucher_no")}


class LeasePeriods(BaseModel):
    company_id: str
    through_date: str


@router.post("/leases/{lease_id}/post-periods")
async def lease_post_periods(lease_id: str, body: LeasePeriods, current_user: User = Depends(get_current_user)):
    """Post every period that has ended by ``through_date`` and is not yet posted, oldest first."""
    _need_post(current_user)
    cid = _company(body.company_id)
    through = _parse_date(body.through_date, "Through date").isoformat()
    l = await db.leases.find_one({"company_id": cid, "id": lease_id}, {"_id": 0})
    if not l:
        raise HTTPException(404, "Lease not found.")
    capital = l["treatment"] in ("rou", "finance")
    if capital and not l.get("recognised"):
        raise HTTPException(400, "Recognise the lease first, so there is a liability to run down.")
    s = _schedule(l)
    posted = {p["period"] for p in l.get("posted_periods", [])}
    rent_id = l.get("rent_account_id") or await _default_id(cid, "5200")
    int_id, dep_id = await _default_id(cid, "5450"), await _default_id(cid, "5800")
    rou_id, liab_id = await _default_id(cid, "1370"), await _default_id(cid, "2650")
    accrued_id, prepaid_id = await _default_id(cid, "2300"), await _default_id(cid, "1500")
    done, cum = [], 0.0
    for r in s["rows"]:                       # running difference between straight-line and paid, for operating leases
        if r["period"] in posted:
            cum += s["straight_line_per_period"] - r["payment"]
    problem = None
    for r in s["rows"]:
        if r["period"] in posted:
            continue
        if r["end"] > through:
            break
        text = f"Lease {l['asset']}: period {r['period']} ({r['start']} to {r['end']})"
        lines: List[dict] = []
        if capital:
            principal = _money(r["payment"] - r["interest"])
            lines.append({"account_id": int_id, "debit": r["interest"], "credit": 0.0, "memo": text})
            if principal >= 0:
                lines.append({"account_id": liab_id, "debit": principal, "credit": 0.0, "memo": text})
            else:
                lines.append({"account_id": liab_id, "debit": 0.0, "credit": -principal, "memo": text})
            lines.append({"account_id": rent_id, "debit": 0.0, "credit": r["payment"], "memo": text})
            lines.extend([{"account_id": dep_id, "debit": s["depreciation_per_period"], "credit": 0.0, "memo": text},
                          {"account_id": rou_id, "debit": 0.0, "credit": s["depreciation_per_period"], "memo": text}])
        else:
            diff = _money(s["straight_line_per_period"] - r["payment"])
            cum += diff
            if abs(diff) >= 0.01:
                bs = accrued_id if cum >= -0.005 else prepaid_id
                lines = ([{"account_id": rent_id, "debit": diff, "credit": 0.0, "memo": text}, {"account_id": bs, "debit": 0.0, "credit": diff, "memo": text}] if diff > 0 else
                         [{"account_id": bs, "debit": -diff, "credit": 0.0, "memo": text}, {"account_id": rent_id, "debit": 0.0, "credit": -diff, "memo": text}])
        entry = None
        if lines:
            try:
                entry = await _post(cid, r["end"], text, lines, "lease_period", f"{lease_id}:{r['period']}", current_user)
            except HTTPException as exc:
                problem = f"Stopped at period {r['period']}: {exc.detail}"
                break
        await db.leases.update_one({"company_id": cid, "id": lease_id}, {"$push": {"posted_periods": {"period": r["period"], "date": r["end"], "entry_id": (entry or {}).get("id")}}})
        done.append(r["period"])
    await _audit(cid, current_user, "LEASE_PERIODS_POSTED", "leases", lease_id, {"periods": done})
    return {"posted_periods": done, "problem": problem, "message": None if done or problem else "Nothing to post: every period up to that date is already posted."}


@router.delete("/leases/{lease_id}")
async def lease_delete(lease_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    l = await db.leases.find_one({"company_id": cid, "id": lease_id}, {"_id": 0})
    if not l:
        raise HTTPException(404, "Lease not found.")
    if l.get("recognised") or l.get("posted_periods"):
        raise HTTPException(409, "Entries have been posted for this lease, so it cannot be deleted.")
    await db.leases.delete_one({"company_id": cid, "id": lease_id})
    return {"deleted": True}


# ═══ Borrowing costs (AS 16 / Ind AS 23) ════════════════════════════════════════════════════════
class BorrowingInput(BaseModel):
    company_id: str
    asset_description: str = Field(..., min_length=2)
    loan_description: str = ""
    principal: float = Field(..., gt=0)
    rate_pct: float = Field(..., gt=0, le=60)
    start_date: str
    end_date: str
    temporary_income: float = Field(0, ge=0)          # interest earned by parking unspent loan money; it reduces what can be capitalised
    interest_override: Optional[float] = Field(None, ge=0)     # the interest actually charged, if it differs from principal x rate x days
    asset_account_id: Optional[str] = None            # defaults to Capital Work-in-Progress
    qualifying_asset: bool = False                    # confirms the asset takes a substantial period (over 12 months) to get ready
    note: str = ""


def _borrow(body: BorrowingInput) -> dict:
    start, end = _parse_date(body.start_date, "Start date"), _parse_date(body.end_date, "End date")
    if end < start:
        raise HTTPException(400, "The end date is before the start date.")
    b = borrowing_cost(body.principal, body.rate_pct, start, end, body.temporary_income)
    if body.interest_override is not None:
        b["interest"] = _money(body.interest_override)
        b["capitalisable"] = _money(max(body.interest_override - body.temporary_income, 0))
    return b


@router.post("/borrowing-costs/preview")
async def borrowing_preview(body: BorrowingInput, current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    _company(body.company_id)
    return _borrow(body)


@router.post("/borrowing-costs")
async def borrowing_post(body: BorrowingInput, current_user: User = Depends(get_current_user)):
    """Move interest into the asset: Dr the asset (Capital Work-in-Progress), Cr Interest & Finance Charges."""
    _need_post(current_user)
    cid = _company(body.company_id)
    if not body.qualifying_asset:
        raise HTTPException(400, "Borrowing costs are capitalised only for a qualifying asset: one that takes a substantial period to get ready for use. Confirm that it does, or leave the interest as an expense.")
    b = _borrow(body)
    if b["capitalisable"] <= 0:
        raise HTTPException(400, "There is no interest left to capitalise after deducting the temporary investment income.")
    asset_id = body.asset_account_id or await _default_id(cid, "1390")
    acct = (await _accounts_by_id(cid, [asset_id])).get(asset_id)
    if not acct or acct.get("type") != "asset":
        raise HTTPException(400, "Choose an asset account to capitalise into.")
    int_id = await _default_id(cid, "5450")
    fw = (await get_settings(cid))["framework"]
    text = f"Borrowing costs capitalised on {body.asset_description.strip()} ({STANDARDS['borrowing_costs'][fw].split(' - ')[0]})"
    rec_id = str(uuid.uuid4())
    amt = b["capitalisable"]
    entry = await _post(cid, _parse_date(body.end_date).isoformat(), text, [{"account_id": asset_id, "debit": amt, "credit": 0.0, "memo": text},
                                                                           {"account_id": int_id, "debit": 0.0, "credit": amt, "memo": text}], "borrowing_cost", rec_id, current_user)
    doc = {"id": rec_id, "company_id": cid, "asset_description": body.asset_description.strip(), "loan_description": body.loan_description.strip(), "principal": body.principal,
           "rate_pct": body.rate_pct, "start_date": body.start_date, "end_date": body.end_date, **b, "asset_account_id": asset_id, "asset_account_name": acct.get("name"),
           "entry_id": entry["id"], "status": "active", "note": body.note.strip(), "created_by": str(current_user.id), "created_at": _now()}
    await db.borrowing_costs.insert_one(dict(doc))
    await _audit(cid, current_user, "BORROWING_COST_CAPITALISED", "borrowing_costs", rec_id, {"amount": amt})
    return {**doc, "voucher_no": entry.get("voucher_no"), "standard": STANDARDS["borrowing_costs"][fw]}


@router.get("/borrowing-costs")
async def borrowing_list(company_id: str = Query(""), fy: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    q: dict = {"company_id": _company(company_id)}
    if fy:
        lo, hi = _fy_bounds(fy)
        q["end_date"] = {"$gte": lo.isoformat(), "$lte": hi.isoformat()}
    rows = await db.borrowing_costs.find(q, {"_id": 0}).sort("end_date", -1).to_list(2000)
    return {"records": rows, "total_capitalised": _money(sum(r["capitalisable"] for r in rows if r["status"] == "active"))}


@router.post("/borrowing-costs/{rec_id}/cancel")
async def borrowing_cancel(rec_id: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_post(current_user)
    cid = _company(company_id)
    rec = await db.borrowing_costs.find_one({"company_id": cid, "id": rec_id}, {"_id": 0})
    if not rec:
        raise HTTPException(404, "Record not found.")
    if rec["status"] == "cancelled":
        return {"cancelled": True, "already": True}
    from backend.accounting_lock import reverse_journal_entry
    try:
        await reverse_journal_entry(rec["entry_id"], "Borrowing cost capitalisation cancelled", str(current_user.id))
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    await db.borrowing_costs.update_one({"company_id": cid, "id": rec_id}, {"$set": {"status": "cancelled", "cancelled_at": _now()}})
    return {"cancelled": True}
