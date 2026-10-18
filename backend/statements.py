"""Financial statements built only from what is actually in the books.

Everything here is derived from journal balances, the chart-of-accounts classification and the fixed-asset
register. Nothing is a flat percentage of something else. Where an assumption is unavoidable (the tax rate) it is
returned alongside the figure and labelled as an assumption.

`build_statements` is a pure function: pass the accounts, journal lines and register in, get the statements out.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional

from backend.account_classification import (
    BS, IT_BLOCK_RATES, PL, TR, classify_account,
    H_CAPITAL, H_CASH, H_DEPN, H_DTA, H_DTL, H_EMPLOYEE, H_FINANCE, H_INTANGIBLE, H_INVENTORIES, H_LOANS_ADV,
    H_LT_BORROW, H_OTHER_CA, H_OTHER_CL, H_OTHER_EXP, H_OTHER_INC, H_PAYABLES, H_PPE, H_PURCHASES, H_RECEIVABLES,
    H_RESERVES, H_REVENUE, H_ST_PROV, H_TAX,
)

r2 = lambda v: round(float(v or 0.0) + 0.0, 2)  # noqa: E731


def fy_start_of(d: date) -> date:
    return date(d.year if d.month >= 4 else d.year - 1, 4, 1)


def _d(v) -> Optional[date]:
    try:
        return date.fromisoformat(str(v)[:10])
    except Exception:
        return None


# ── Income Tax Act depreciation (WDV, block rates) ──────────────────────────────────────────────────
def it_depreciation(assets: Iterable[dict], fy_start: date) -> dict:
    """Tax depreciation for the financial year starting `fy_start`, from the register.

    Each asset is carried at its written-down value from the year it was bought, at its block rate. An asset put to
    use for fewer than 180 days in its first year earns half the rate. Disposed and cancelled assets are left out.
    Block rates: computers and software 40%, plant and machinery and vehicles 15%, furniture and buildings 10%,
    other intangibles 25%. (Adding assets one by one gives the same result as the block method until something is sold.)"""
    rows, dep_total, open_total, close_total = [], 0.0, 0.0, 0.0
    for a in assets:
        if str(a.get("status") or "active") in ("cancelled", "disposed"):
            continue
        pd = _d(a.get("purchase_date"))
        cost = float(a.get("cost") or 0)
        if not pd or cost <= 0:
            continue
        first = fy_start_of(pd)
        if first > fy_start:
            continue
        rate = IT_BLOCK_RATES.get(str(a.get("category") or "other"), IT_BLOCK_RATES["other"])
        wdv, y, dep_year, opening = cost, first, 0.0, 0.0
        while y <= fy_start:
            fy_end = date(y.year + 1, 3, 31)
            factor = 0.5 if (y == first and (fy_end - pd).days + 1 < 180) else 1.0
            dep = wdv * rate * factor
            if y == fy_start:
                opening, dep_year = wdv, dep
            wdv -= dep
            y = date(y.year + 1, 4, 1)
        rows.append({"id": a.get("id"), "name": a.get("name"), "category": a.get("category") or "other", "rate_pct": rate * 100,
                     "opening_wdv": r2(opening), "depreciation": r2(dep_year), "closing_wdv": r2(wdv)})
        dep_total += dep_year
        open_total += opening
        close_total += wdv
    return {"depreciation": r2(dep_total), "opening_wdv": r2(open_total), "closing_wdv": r2(close_total), "rows": rows}


def build_statements(accounts: List[dict], lines: List[dict], assets: List[dict], lower: str, upper: str,
                     tax_rate: float = 0.25, cess: float = 0.04) -> dict:
    lo, up = _d(lower), _d(upper)
    by_id = {a["id"]: a for a in accounts}

    def head_of(a: dict) -> str:
        if a.get("is_party_ledger"):          # customer / vendor ledgers resolve by who they are, whatever their name
            if a.get("party_type") == "customer":
                return H_RECEIVABLES
            if a.get("party_type") == "vendor":
                return H_PAYABLES
        return a.get("schedule3_head") or classify_account(a)["schedule3_head"]

    def cls(a: dict) -> dict:
        c = classify_account(a)
        return {"statement": a.get("statement") or c["statement"], "cost_type": a.get("cost_type", c["cost_type"]),
                "is_contra": bool(a.get("is_contra", c["is_contra"])), "head": head_of(a)}

    info = {aid: cls(a) for aid, a in by_id.items()}

    bal_up, bal_open = defaultdict(float), defaultdict(float)     # debit - credit
    for l in lines:
        aid = l.get("account_id")
        if aid not in by_id:
            continue
        net = float(l.get("debit") or 0) - float(l.get("credit") or 0)
        ed = _d(l.get("entry_date"))
        if ed is None or ed > up:
            continue
        bal_up[aid] += net
        if ed < lo:
            bal_open[aid] += net
    period = {aid: bal_up[aid] - bal_open[aid] for aid in by_id}

    def natural(aid: str, bal: float) -> float:
        return bal if by_id[aid]["type"] == "asset" else -bal

    def heads_at(balances: Dict[str, float]) -> Dict[str, float]:
        out: Dict[str, float] = defaultdict(float)
        for aid, a in by_id.items():
            if info[aid]["statement"] == BS and a["type"] in ("asset", "liability", "equity"):
                out[info[aid]["head"]] += natural(aid, balances.get(aid, 0.0))
        return out

    h_up, h_open = heads_at(bal_up), heads_at(bal_open)

    def gross(head: str, balances: Dict[str, float]) -> float:           # excludes contra accounts
        return sum(natural(aid, balances.get(aid, 0.0)) for aid, a in by_id.items()
                   if a["type"] == "asset" and info[aid]["head"] == head and not info[aid]["is_contra"] and info[aid]["statement"] == BS)

    cumulative_profit = -sum(bal_up[aid] for aid, a in by_id.items() if info[aid]["statement"] in (TR, PL))
    reserves = h_up[H_RESERVES] + cumulative_profit

    ppe_gross = gross(H_PPE, bal_up)
    ppe_net = h_up[H_PPE]
    accumulated_dep = r2(ppe_gross - ppe_net)

    # ── Balance sheet at `upper` ──
    equity_liab = {
        "shareholders_funds": {"share_capital": r2(h_up[H_CAPITAL]), "reserves_and_surplus": r2(reserves),
                               "total": r2(h_up[H_CAPITAL] + reserves)},
        "non_current_liabilities": {"long_term_borrowings": r2(h_up[H_LT_BORROW]), "deferred_tax_liabilities": r2(h_up[H_DTL]),
                                    "total": r2(h_up[H_LT_BORROW] + h_up[H_DTL])},
        "current_liabilities": {"trade_payables": r2(h_up[H_PAYABLES]), "other_current_liabilities": r2(h_up[H_OTHER_CL]),
                                "short_term_provisions": r2(h_up[H_ST_PROV]),
                                "total": r2(h_up[H_PAYABLES] + h_up[H_OTHER_CL] + h_up[H_ST_PROV])},
    }
    total_el = r2(equity_liab["shareholders_funds"]["total"] + equity_liab["non_current_liabilities"]["total"]
                  + equity_liab["current_liabilities"]["total"])
    equity_liab["total_equity_and_liabilities"] = total_el

    nca_total = r2(ppe_net + h_up[H_INTANGIBLE] + h_up[H_DTA])
    ca_total = r2(h_up[H_INVENTORIES] + h_up[H_RECEIVABLES] + h_up[H_CASH] + h_up[H_LOANS_ADV] + h_up[H_OTHER_CA])
    total_assets = r2(nca_total + ca_total)
    assets_side = {
        "non_current_assets": {"property_plant_equipment": r2(ppe_net), "gross_block": r2(ppe_gross), "accumulated_depreciation": accumulated_dep,
                               "intangible_assets": r2(h_up[H_INTANGIBLE]), "deferred_tax_assets": r2(h_up[H_DTA]), "total": nca_total},
        "current_assets": {"inventories": r2(h_up[H_INVENTORIES]), "trade_receivables": r2(h_up[H_RECEIVABLES]),
                           "cash_and_cash_equivalents": r2(h_up[H_CASH]),
                           "short_term_loans_advances": r2(h_up[H_LOANS_ADV] + h_up[H_OTHER_CA]), "total": ca_total},
        "total_assets": total_assets,
    }

    # ── Profit and loss for the period ──
    def p_sum(pred) -> float:
        return sum(period[aid] for aid in by_id if pred(aid))

    income = lambda aid: by_id[aid]["type"] == "income"                  # noqa: E731
    expense = lambda aid: by_id[aid]["type"] == "expense"                # noqa: E731
    revenue_ops = -p_sum(lambda a: income(a) and info[a]["head"] == H_REVENUE)
    other_income = -p_sum(lambda a: income(a) and info[a]["head"] != H_REVENUE)
    exp_by = lambda head: p_sum(lambda a: expense(a) and info[a]["head"] == head)   # noqa: E731
    cost_of_purchases, employee = exp_by(H_PURCHASES), exp_by(H_EMPLOYEE)
    finance, depn, tax_booked = exp_by(H_FINANCE), exp_by(H_DEPN), exp_by(H_TAX)
    other_exp = p_sum(lambda a: expense(a) and info[a]["head"] not in (H_PURCHASES, H_EMPLOYEE, H_FINANCE, H_DEPN, H_TAX))
    total_expenses = cost_of_purchases + employee + finance + depn + other_exp
    total_revenue = revenue_ops + other_income
    pbt = total_revenue - total_expenses
    pat = pbt - tax_booked

    # ── Trading account (direct items) then profit and loss account (indirect items) ──
    direct_exp = p_sum(lambda a: expense(a) and info[a]["cost_type"] == "direct")
    gross_profit = revenue_ops - direct_exp
    indirect_exp = total_expenses - direct_exp
    trading = {
        "sales": r2(revenue_ops), "direct_costs": r2(direct_exp), "gross_profit": r2(gross_profit),
        "gross_margin_pct": r2(gross_profit / revenue_ops * 100) if revenue_ops else 0.0,
        "other_income": r2(other_income), "indirect_expenses": r2(indirect_exp),
        "net_profit_before_tax": r2(gross_profit + other_income - indirect_exp),
        "closing_stock_on_balance_sheet": r2(h_up[H_INVENTORIES]),
        "ties_to_pnl": abs((gross_profit + other_income - indirect_exp) - pbt) < 0.02,
    }

    # ── Income tax computation ──
    fy_start = fy_start_of(up)
    tax_dep = it_depreciation(assets, fy_start)
    code_bal = lambda code, bal: sum(natural(aid, bal.get(aid, 0.0)) for aid, a in by_id.items() if a["code"] == code)   # noqa: E731
    gst_net = max(code_bal("2100", bal_up) - code_bal("1200", bal_up), 0.0)
    exposure_43b = r2(gst_net + max(code_bal("2200", bal_up), 0.0))
    taxable = pbt + depn - tax_dep["depreciation"]
    base_tax = max(taxable, 0.0) * tax_rate
    cess_amt = base_tax * cess
    total_tax = base_tax + cess_amt
    current_tax_booked = sum(period[aid] for aid, a in by_id.items() if a["code"] == "5950")
    income_tax = {
        "book_net_profit": r2(pbt), "depreciation_add_back": r2(depn), "depreciation_it_deduction": tax_dep["depreciation"],
        "disallowance_43b": 0.0, "section_43b_exposure": exposure_43b,
        "taxable_pgbp_income": r2(taxable), "tax_rate_pct": tax_rate * 100, "tax_rate_is_assumption": True,
        "base_tax": r2(base_tax), "cess_pct": cess * 100, "cess_amount": r2(cess_amt), "total_tax_payable": r2(total_tax),
        "current_tax_booked": r2(current_tax_booked), "tax_to_book": r2(max(total_tax - current_tax_booked, 0.0)),
        "financial_year_start": fy_start.isoformat(), "tax_depreciation_rows": tax_dep["rows"],
    }

    # ── Deferred tax: book written-down value vs tax written-down value ──
    live = [a for a in assets if str(a.get("status") or "active") not in ("cancelled", "disposed")]
    book_wdv = sum(float(a.get("book_value", a.get("cost")) or 0) for a in live if _d(a.get("purchase_date")) and fy_start_of(_d(a.get("purchase_date"))) <= fy_start)
    timing = book_wdv - tax_dep["closing_wdv"]
    dt_rate = tax_rate * (1 + cess)
    required = timing * dt_rate                         # + liability (book value above tax value), - asset
    booked = code_bal("2500", bal_up) - code_bal("1600", bal_up)
    deferred_tax = {
        "book_written_down_value": r2(book_wdv), "tax_written_down_value": tax_dep["closing_wdv"], "timing_difference": r2(timing),
        "rate_pct": r2(dt_rate * 100), "required_net_liability": r2(required), "booked_net_liability": r2(booked),
        "adjustment_to_book": r2(required - booked), "kind": "liability" if required >= 0 else "asset",
    }

    # ── Cash flow (indirect), from the change in every balance-sheet head over the period ──
    d_ = lambda head: h_up[head] - h_open[head]                                 # noqa: E731
    d_gross = lambda head: gross(head, bal_up) - gross(head, bal_open)           # noqa: E731
    profit_period = pat
    operating = (profit_period + depn + (d_(H_DTL) - d_(H_DTA))
                 - (d_(H_RECEIVABLES) + d_(H_INVENTORIES) + d_(H_LOANS_ADV) + d_(H_OTHER_CA))
                 + (d_(H_PAYABLES) + d_(H_OTHER_CL) + d_(H_ST_PROV)))
    investing = -(d_gross(H_PPE) + d_gross(H_INTANGIBLE))
    financing = d_(H_CAPITAL) + d_(H_LT_BORROW) + d_(H_RESERVES)
    cash_change = d_(H_CASH)
    net = operating + investing + financing
    cash_flow = {"operating": r2(operating), "investing": r2(investing), "financing": r2(financing), "net": r2(net),
                 "opening_cash": r2(h_open[H_CASH]), "closing_cash": r2(h_up[H_CASH]),
                 "reconciles": abs(net - cash_change) < 0.02, "difference": r2(net - cash_change)}

    cur_liab = equity_liab["current_liabilities"]["total"]
    ratios = {
        "current_ratio": r2(ca_total / max(cur_liab, 1.0)),
        "quick_ratio": r2((h_up[H_CASH] + h_up[H_RECEIVABLES]) / max(cur_liab, 1.0)),
        "operating_margin_pct": r2(pbt / max(revenue_ops, 1.0) * 100),
        "net_margin_pct": r2(pat / max(revenue_ops, 1.0) * 100),
        "collection_period_days": round(h_up[H_RECEIVABLES] / max(revenue_ops, 1.0) * 365),
    }

    return {
        "schedule_iii": {
            "balance_sheet": {"equity_and_liabilities": equity_liab, "assets": assets_side,
                              "balanced": abs(total_assets - total_el) < 0.02, "difference": r2(total_assets - total_el)},
            "pnl": {
                "revenue_from_operations": r2(revenue_ops), "other_income": r2(other_income), "total_revenue": r2(total_revenue),
                "expenses": {"cost_of_purchases": r2(cost_of_purchases), "employee_benefits": r2(employee), "finance_costs": r2(finance),
                             "depreciation": r2(depn), "other_operating_expenses": r2(other_exp), "total": r2(total_expenses)},
                "profit_before_tax": r2(pbt), "tax_expense": r2(tax_booked), "profit_after_tax": r2(pat),
                "tax_still_to_book": income_tax["tax_to_book"],
            },
        },
        "trading_account": trading,
        "income_tax": income_tax,
        "deferred_tax": deferred_tax,
        "mis": {"ebitda": r2(pbt + depn + finance), "ratios": ratios, "cash_flow": cash_flow},
        "basis": {"from": lower, "to": upper, "financial_year_start": fy_start.isoformat(),
                  "notes": ["Every figure comes from posted journal entries, the chart-of-accounts classification and the fixed-asset register.",
                            f"The tax rate ({tax_rate * 100:g}% plus {cess * 100:g}% cess) is an assumption; change it to the rate that applies to the entity.",
                            "Tax depreciation uses Income Tax block rates on the register's written-down values for the financial year containing the end date.",
                            "Section 43B dues are shown as exposure only; add back what is still unpaid on the return due date."]},
    }
