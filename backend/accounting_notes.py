"""Accounting policies (AS 1 / Ind AS 1) and the notes to accounts.

Policies are written from the company's settings (framework, inventory method) so they say what the books actually do;
an administrator can replace the text of any one. The notes pull every figure from the books and the registers kept for
each standard, and say plainly which note still needs an input rather than showing a blank or a zero that looks final.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend import accounting_core as ac
from backend.accounting_books import _company, _fy_bounds, _money, _need_admin, _need_view, get_settings
from backend.accounting_standards import (
    earnings_per_share, party_disclosure, provision_disclosure, receivable_provision,
)
from backend.accounting_standards_obligations import lease_disclosure
from backend.dependencies import db, get_current_user
from backend.models import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/accounting-books/notes", tags=["Accounting Books - Notes"])

FRAMEWORK_TEXT = {
    "AS": "the Accounting Standards notified under section 133 of the Companies Act, 2013 (Companies (Accounting Standards) Rules, 2021) and the relevant provisions of that Act",
    "IND_AS": "the Indian Accounting Standards (Ind AS) notified under section 133 of the Companies Act, 2013 (Companies (Indian Accounting Standards) Rules, 2015) and the relevant provisions of that Act",
}


def default_policies(settings: dict) -> List[dict]:
    fw = settings["framework"]
    method = "weighted average cost" if settings["inventory_method"] == "WEIGHTED_AVG" else "first-in, first-out (FIFO)"
    as_ = fw == "AS"
    return [
        {"key": "basis", "title": "Basis of preparation", "standard": "AS 1 / Ind AS 1",
         "text": f"The financial statements are prepared on the accrual basis under the historical cost convention, in accordance with {FRAMEWORK_TEXT[fw]}. The company is presumed to be a going concern."},
        {"key": "estimates", "title": "Use of estimates", "standard": "AS 1 / Ind AS 1 / AS 5 / Ind AS 8",
         "text": "Preparing the financial statements needs estimates and assumptions that affect reported amounts. Useful lives, provisions, the net realisable value of stock and the recoverability of receivables are the main ones. A change in an estimate is recognised in the period of the change and the periods after it."},
        {"key": "revenue", "title": "Revenue recognition", "standard": "AS 9 / Ind AS 115",
         "text": ("Revenue from sale of goods is recognised when the significant risks and rewards of ownership pass to the buyer, and revenue from services as they are performed. Revenue is shown net of GST." if as_
                  else "Revenue is recognised when control of the goods or services passes to the customer, at the amount the company expects to be entitled to. Revenue is shown net of GST.")},
        {"key": "ppe", "title": "Property, plant and equipment and depreciation", "standard": "AS 10 / Ind AS 16",
         "text": "Property, plant and equipment is stated at cost less accumulated depreciation. Depreciation is provided over each asset's useful life by the straight-line or written-down value method chosen for it, in line with Schedule II of the Companies Act, 2013. Items below the capitalisation threshold are charged to revenue."},
        {"key": "intangibles", "title": "Intangible assets", "standard": "AS 26 / Ind AS 38",
         "text": "Intangible assets such as software are recognised at cost and amortised over their useful lives."},
        {"key": "inventories", "title": "Inventories", "standard": "AS 2 / Ind AS 2",
         "text": f"Inventories are valued at the lower of cost and net realisable value. Cost is worked out on the {method} basis and includes the purchase price, duties that are not recoverable, freight inward and other costs of bringing the goods to their present location, less trade discounts."},
        {"key": "foreign_currency", "title": "Foreign currency transactions", "standard": "AS 11 / Ind AS 21",
         "text": "Foreign currency transactions are recorded at the rate on the date of the transaction. Monetary items are restated at the closing rate and the exchange difference is taken to the statement of profit and loss."},
        {"key": "employee_benefits", "title": "Employee benefits", "standard": "AS 15 / Ind AS 19",
         "text": "Short-term benefits are charged to the statement of profit and loss as the service is rendered. The liability for gratuity and for leave that can be encashed is provided at the balance sheet date, on the basis of an actuarial valuation or, where none is available, by the statutory formula."},
        {"key": "borrowing_costs", "title": "Borrowing costs", "standard": "AS 16 / Ind AS 23",
         "text": "Borrowing costs directly attributable to acquiring or building a qualifying asset are capitalised until the asset is ready for its intended use. Other borrowing costs are expensed as incurred."},
        {"key": "leases", "title": "Leases", "standard": "AS 19 / Ind AS 116",
         "text": ("Lease rentals on operating leases are charged to the statement of profit and loss on a straight-line basis over the lease term. Assets acquired under finance leases are capitalised with a matching liability." if as_
                  else "At the start of a lease the company recognises a right-of-use asset and a lease liability at the present value of the lease payments, except for short-term and low-value leases, which are expensed straight-line. The asset is depreciated over the lease term and the liability carries interest at the incremental borrowing rate.")},
        {"key": "taxes", "title": "Taxes on income", "standard": "AS 22 / Ind AS 12",
         "text": f"Current tax is provided on taxable income at the rate applicable ({settings['tax_rate_pct']:g}% plus surcharge and cess where it applies). Deferred tax is recognised on timing differences between book and tax profit, using the rates enacted at the balance sheet date, and a deferred tax asset is recognised only where there is reasonable certainty of its recovery."},
        {"key": "provisions", "title": "Provisions, contingent liabilities and contingent assets", "standard": "AS 29 / Ind AS 37",
         "text": "A provision is recognised when there is a present obligation from a past event, an outflow is probable and the amount can be estimated reliably. A possible obligation, or a probable one that cannot be measured, is disclosed as a contingent liability. Contingent assets are not recognised."},
        {"key": "receivables", "title": "Trade receivables and impairment", "standard": "AS 29 / Ind AS 109",
         "text": ("A provision is made for receivables whose recovery is doubtful, estimated from their ageing and the company's experience." if as_
                  else "Loss allowances on trade receivables are measured at the lifetime expected credit loss using a provision matrix based on ageing, adjusted for forward-looking information.")},
        {"key": "eps", "title": "Earnings per share", "standard": "AS 20 / Ind AS 33",
         "text": "Basic EPS is the profit after tax attributable to equity shareholders divided by the weighted average number of equity shares in the year. Diluted EPS also counts potential equity shares that would reduce earnings per share. Bonus issues and splits are applied to earlier periods."},
        {"key": "cash_flow", "title": "Cash flow statement", "standard": "AS 3 / Ind AS 7",
         "text": "The cash flow statement is prepared by the indirect method, adjusting profit for non-cash items and for changes in working capital."},
    ]


async def _policies(cid: str) -> List[dict]:
    settings = await get_settings(cid)
    custom = {r["key"]: r["text"] for r in await db.accounting_policies.find({"company_id": cid}, {"_id": 0}).to_list(200)}
    return [{**p, "text": custom.get(p["key"], p["text"]), "is_custom": p["key"] in custom} for p in default_policies(settings)]


@router.get("/policies")
async def policies(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    return {"framework": (await get_settings(cid))["framework"], "policies": await _policies(cid)}


class PolicyText(BaseModel):
    company_id: str
    text: str = Field(..., min_length=10, max_length=4000)


@router.put("/policies/{key}")
async def policy_update(key: str, body: PolicyText, current_user: User = Depends(get_current_user)):
    _need_admin(current_user)
    cid = _company(body.company_id)
    if key not in {p["key"] for p in default_policies(await get_settings(cid))}:
        raise HTTPException(404, "Unknown policy.")
    await db.accounting_policies.update_one({"company_id": cid, "key": key}, {"$set": {"text": body.text.strip()}}, upsert=True)
    return {"updated": True}


@router.delete("/policies/{key}")
async def policy_reset(key: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    _need_admin(current_user)
    await db.accounting_policies.delete_one({"company_id": _company(company_id), "key": key})
    return {"reset": True}


# ═══ Notes to accounts ══════════════════════════════════════════════════════════════════════════
def _table(columns: List[str], rows: List[list]) -> dict:
    return {"kind": "table", "columns": columns, "rows": rows}


def _fmt(v) -> str:
    return f"{float(v or 0):,.2f}"


async def _safely(sections: List[dict], title: str, standard: str, build) -> None:
    """Add a note; if its inputs are missing, say so instead of failing the whole report."""
    try:
        body = await build()
    except HTTPException as exc:
        sections.append({"title": title, "standard": standard, "status": "needs_input", "kind": "text", "text": str(exc.detail)})
        return
    except Exception:                                        # a broken note must not take the others down
        logger.exception("note %s failed", title)
        sections.append({"title": title, "standard": standard, "status": "needs_input", "kind": "text", "text": "This note could not be prepared. Check the data entered for it."})
        return
    sections.append({"title": title, "standard": standard, "status": body.pop("status", "complete"), **body})


@router.get("")
async def notes_to_accounts(company_id: str = Query(""), fy: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    _need_view(current_user)
    cid = _company(company_id)
    today = date.today()
    start = today.year if today.month >= 4 else today.year - 1
    lo, hi = _fy_bounds(fy) if fy else (date(start, 4, 1), date(start + 1, 3, 31))
    settings = await get_settings(cid)
    fw = settings["framework"]
    st = await ac._load_statements(cid, lo.isoformat(), hi.isoformat(), tax_rate=settings["tax_rate_pct"] / 100.0)
    s3 = st["schedule_iii"]
    bs_el, bs_a, pnl = s3["balance_sheet"]["equity_and_liabilities"], s3["balance_sheet"]["assets"], s3["pnl"]
    sections: List[dict] = []

    async def pol():
        return {"kind": "policies", "policies": await _policies(cid)}

    async def share_capital():
        events = await db.share_capital_register.find({"company_id": cid, "type": {"$ne": "potential"}}, {"_id": 0}).to_list(5000)
        book = bs_el["shareholders_funds"]["share_capital"]
        if not events:
            return {"status": "needs_input", "kind": "table", "columns": ["Particulars", "Amount (Rs)"], "rows": [["Share capital per books", _fmt(book)]],
                    "text": "Record the share capital movements (opening shares, issues, bonus, split) to complete this note."}
        eps_data = await earnings_per_share(company_id=cid, fy=fy, preference_dividend=0.0, average_market_price=None, current_user=current_user)
        return _table(["Particulars", "Shares / Amount"], [["Equity shares outstanding at year end", f"{eps_data['closing_shares']:,.0f}"], ["Face value per share (Rs)", _fmt(eps_data["face_value"])],
                                                          ["Share capital per register (Rs)", _fmt(eps_data["share_capital_per_register"])], ["Share capital per books (Rs)", _fmt(book)],
                                                          ["Register agrees with books", "Yes" if eps_data["capital_matches"] else "No - reconcile before approval"]])

    async def reserves():
        return _table(["Particulars", "Amount (Rs)"], [["Reserves and surplus (including profit carried forward)", _fmt(bs_el["shareholders_funds"]["reserves_and_surplus"])],
                                                       ["Profit after tax for the year", _fmt(pnl["profit_after_tax"])]])

    async def borrowings():
        return _table(["Particulars", "Amount (Rs)"], [["Long-term borrowings, including lease liabilities", _fmt(bs_el["non_current_liabilities"]["long_term_borrowings"])],
                                                       ["Trade payables", _fmt(bs_el["current_liabilities"]["trade_payables"])],
                                                       ["Other current liabilities", _fmt(bs_el["current_liabilities"]["other_current_liabilities"])],
                                                       ["Short-term provisions", _fmt(bs_el["current_liabilities"]["short_term_provisions"])]])

    async def ppe():
        nca = bs_a["non_current_assets"]
        return _table(["Particulars", "Amount (Rs)"], [["Gross block", _fmt(nca["gross_block"])], ["Less: accumulated depreciation", _fmt(nca["accumulated_depreciation"])],
                                                       ["Net block (including right-of-use assets and work in progress)", _fmt(nca["property_plant_equipment"])],
                                                       ["Intangible assets", _fmt(nca["intangible_assets"])], ["Depreciation and amortisation for the year", _fmt(pnl["expenses"]["depreciation"])]])

    async def inventories():
        val = await db.stock_valuations.find_one({"company_id": cid, "status": "posted", "as_of": {"$lte": hi.isoformat()}}, {"_id": 0, "lines": 0}, sort=[("as_of", -1)])
        carrying = bs_a["current_assets"]["inventories"]
        if not val:
            return {"status": "needs_input" if await db.stock_items.count_documents({"company_id": cid}) else "not_applicable", "kind": "text",
                    "text": ("Inventories on the balance sheet: " + _fmt(carrying) + ". Post the closing stock valuation to complete this note.") if await db.stock_items.count_documents({"company_id": cid})
                    else "The company holds no inventories recorded in the stock register."}
        return _table(["Particulars", "Amount (Rs)"], [["Valuation date", val["as_of"]], ["Cost formula", val["method"].replace("_", " ").title()], ["Cost", _fmt(val["total_cost"])],
                                                       ["Write-down to net realisable value", _fmt(val["total_write_down"])], ["Carrying amount", _fmt(val["total_carrying"])],
                                                       ["Inventories on the balance sheet", _fmt(carrying)]])

    async def receivables():
        data = await receivable_provision(company_id=cid, as_of=hi.isoformat(), current_user=current_user)
        rows = [[r["bucket"], _fmt(r["outstanding"]), f"{r['rate_pct']:g}%", _fmt(r["provision"])] for r in data["rows"]]
        rows.append(["Total", _fmt(data["total_outstanding"]), "", _fmt(data["provision_required"])])
        rows.append(["Provision held in the books", "", "", _fmt(data["current_provision"])])
        return {**_table(["Age (days past due)", "Outstanding (Rs)", "Rate", "Provision (Rs)"], rows), "text": data["basis"],
                "status": "complete" if abs(data["change_needed"]) < 1 else "needs_input",
                **({"hint": f"The provision in the books differs from the matrix by Rs {_fmt(data['change_needed'])}. Post it from the Receivables tab."} if abs(data["change_needed"]) >= 1 else {})}

    async def employee():
        v = await db.employee_benefit_provisions.find_one({"company_id": cid, "as_of": {"$lte": hi.isoformat()}}, {"_id": 0}, sort=[("as_of", -1)])
        if not v:
            return {"status": "needs_input", "kind": "text", "text": "No gratuity or leave encashment provision has been posted. Add the employees and post the provision."}
        return _table(["Particulars", "Amount (Rs)"], [["Provision for gratuity", _fmt(v["gratuity"])], ["Provision for leave encashment", _fmt(v["leave"])],
                                                       ["Basis", v["method"]], ["As at", v["as_of"]]])

    async def borrowing():
        rows = await db.borrowing_costs.find({"company_id": cid, "status": "active", "end_date": {"$gte": lo.isoformat(), "$lte": hi.isoformat()}}, {"_id": 0}).to_list(2000)
        total = sum(r["capitalisable"] for r in rows)
        return {"status": "complete" if rows else "not_applicable", "kind": "table", "columns": ["Asset", "Interest capitalised (Rs)"],
                "rows": [[r["asset_description"], _fmt(r["capitalisable"])] for r in rows] + [["Total", _fmt(total)]], "text": "" if rows else "No borrowing costs were capitalised in the year."}

    async def leases():
        d = await lease_disclosure(company_id=cid, as_of=hi.isoformat(), current_user=current_user)
        if not d["lease_count"]:
            return {"status": "not_applicable", "kind": "text", "text": "No leases are recorded."}
        c = d["charge_for_year"]
        return _table(["Particulars", "Amount (Rs)"], [["Right-of-use assets (net)", _fmt(d["right_of_use_net"])], ["Lease liability", _fmt(d["lease_liability"])],
                                                       ["  of which due within a year", _fmt(d["liability_current"])], ["Future payments within 1 year", _fmt(d["maturity"]["within_1_year"])],
                                                       ["Future payments in 1 to 5 years", _fmt(d["maturity"]["1_to_5_years"])], ["Future payments after 5 years", _fmt(d["maturity"]["over_5_years"])],
                                                       ["Interest on lease liabilities", _fmt(c["interest_on_lease_liabilities"])], ["Depreciation of right-of-use assets", _fmt(c["depreciation_of_right_of_use_assets"])],
                                                       ["Rent on short-term and operating leases", _fmt(c["operating_and_short_term_rent"])]])

    async def fx():
        runs = await db.fx_revaluations.find({"company_id": cid, "status": "active", "as_of": {"$gte": lo.isoformat(), "$lte": hi.isoformat()}}, {"_id": 0, "rows": 0}).to_list(500)
        open_items = await db.fx_items.count_documents({"company_id": cid, "status": "open"})
        if not runs and not open_items:
            return {"status": "not_applicable", "kind": "text", "text": "The company has no foreign-currency monetary items."}
        net = sum(r["net_gain_loss"] for r in runs)
        return _table(["Particulars", "Amount (Rs)"], [["Open foreign-currency monetary items", str(open_items)], ["Revaluations posted in the year", str(len(runs))],
                                                       ["Net unrealised exchange gain / (loss) on the latest revaluation", _fmt(runs[0]["net_gain_loss"] if runs else 0)], ["Sum across revaluations", _fmt(net)]])

    async def provisions():
        d = await provision_disclosure(company_id=cid, fy=fy, current_user=current_user)
        rows = [[p["category"].replace("_", " ").title(), _fmt(p["opening"]), _fmt(p["additions"]), _fmt(p["utilised"]), _fmt(p["reversed"]), _fmt(p["closing"])] for p in d["provisions"]]
        cl = [[c["description"], c["category"].replace("_", " ").title(), _fmt(c["estimate"]) if c["estimate"] is not None else "Not estimable"] for c in d["contingent_liabilities"]]
        if not rows and not cl:
            return {"status": "needs_input", "kind": "text", "text": "No provisions or contingent liabilities are recorded. Confirm that there are none, or add them in the Provisions tab."}
        out = {"kind": "table", "columns": ["Class", "Opening", "Additions", "Utilised", "Reversed", "Closing"], "rows": rows}
        if cl:
            out["second_table"] = {"title": "Contingent liabilities", "columns": ["Matter", "Class", "Estimate (Rs)"], "rows": cl}
        return out

    async def related():
        d = await party_disclosure(company_id=cid, fy=fy, current_user=current_user)
        rows = []
        for g in d["groups"]:
            for p in g["parties"]:
                for t in p["transactions"]:
                    rows.append([g["label"], p["party"], t["label"], _fmt(t["amount"]), _fmt(p["outstanding"])])
        if not rows:
            return {"status": "needs_input", "kind": "text", "text": "No related party transactions are recorded. Confirm that there were none, or add them in the Related parties tab."}
        return _table(["Relationship", "Party", "Nature", "Amount (Rs)", "Balance outstanding (Rs)"], rows)

    async def eps_note():
        e = await earnings_per_share(company_id=cid, fy=fy, preference_dividend=0.0, average_market_price=None, current_user=current_user)
        return _table(["Particulars", "Amount"], [["Profit after tax (Rs)", _fmt(e["profit_after_tax"])], ["Weighted average equity shares", f"{e['weighted_average_shares']:,.2f}"],
                                                  ["Basic EPS (Rs)", _fmt(e["basic_eps"])], ["Diluted EPS (Rs)", _fmt(e["diluted_eps"])], ["Face value per share (Rs)", _fmt(e["face_value"])]])

    async def tax():
        it, dt = st["income_tax"], st["deferred_tax"]
        return _table(["Particulars", "Amount (Rs)"], [["Profit before tax", _fmt(pnl["profit_before_tax"])], ["Current tax booked", _fmt(it["current_tax_booked"])], ["Total tax payable on computation", _fmt(it["total_tax_payable"])],
                                                       ["Timing difference (book vs tax written-down value)", _fmt(dt["timing_difference"])], ["Deferred tax required", _fmt(dt["required_net_liability"])],
                                                       ["Deferred tax booked", _fmt(dt["booked_net_liability"])]])

    async def events():
        return {"status": "needs_input", "kind": "text", "text": "Management to state any significant events after the reporting date up to the date the accounts are approved, or confirm there were none (AS 4 / Ind AS 10)."}

    await _safely(sections, "Significant accounting policies", "AS 1 / Ind AS 1", pol)
    await _safely(sections, "Share capital", "Schedule III", share_capital)
    await _safely(sections, "Reserves and surplus", "Schedule III", reserves)
    await _safely(sections, "Borrowings, payables and provisions", "Schedule III", borrowings)
    await _safely(sections, "Property, plant and equipment and intangible assets", "AS 10, AS 26 / Ind AS 16, Ind AS 38", ppe)
    await _safely(sections, "Inventories", "AS 2 / Ind AS 2", inventories)
    await _safely(sections, "Trade receivables", "AS 29 / Ind AS 109", receivables)
    await _safely(sections, "Employee benefits", "AS 15 / Ind AS 19", employee)
    await _safely(sections, "Borrowing costs", "AS 16 / Ind AS 23", borrowing)
    await _safely(sections, "Leases", "AS 19 / Ind AS 116", leases)
    await _safely(sections, "Foreign currency", "AS 11 / Ind AS 21", fx)
    await _safely(sections, "Provisions and contingent liabilities", "AS 29 / Ind AS 37", provisions)
    await _safely(sections, "Related party disclosures", "AS 18 / Ind AS 24", related)
    await _safely(sections, "Earnings per share", "AS 20 / Ind AS 33", eps_note)
    await _safely(sections, "Taxes on income", "AS 22 / Ind AS 12", tax)
    await _safely(sections, "Events after the reporting period", "AS 4 / Ind AS 10", events)
    for i, s in enumerate(sections, 1):
        s["no"] = i
    pending = [s["title"] for s in sections if s["status"] == "needs_input"]
    return {"framework": fw, "financial_year": f"{lo.year}-{str(lo.year + 1)[-2:]}", "from": lo.isoformat(), "to": hi.isoformat(), "sections": sections,
            "needs_input": pending, "ready": not pending,
            "summary": {"revenue": _money(pnl["revenue_from_operations"]), "profit_before_tax": _money(pnl["profit_before_tax"]), "profit_after_tax": _money(pnl["profit_after_tax"]),
                        "balance_sheet_balanced": s3["balance_sheet"]["balanced"]}}
