"""The arithmetic behind the accounting-standards features. Pure functions, no database.

* EPS (AS 20 / Ind AS 33)            - weighted average shares, bonus/split restated back, dilution by the treasury-stock
                                       method and the "most dilutive first" order.
* Leases (AS 19 / Ind AS 116)        - present value of payments, the interest schedule, right-of-use depreciation and
                                       the straight-line expense an operating lease needs.
* Employee benefits (AS 15 / Ind AS 19) - gratuity under the Payment of Gratuity Act formula, and leave encashment.
* Foreign currency (AS 11 / Ind AS 21)  - unrealised gain or loss on monetary items at the closing rate.
* Provisions (AS 29 / Ind AS 37)        - recognise, disclose or ignore by probability; present value under Ind AS.
* Borrowing costs (AS 16 / Ind AS 23)   - interest eligible for capitalisation.
* Receivables                           - ageing and a provision matrix.
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional


def r2(v: float) -> float:
    return round(float(v or 0) + 0.0, 2)


def d_(v) -> date:
    return v if isinstance(v, date) else date.fromisoformat(str(v)[:10])


def add_months(d: date, months: int) -> date:
    m = d.month - 1 + months
    y, m = d.year + m // 12, m % 12 + 1
    return date(y, m, min(d.day, calendar.monthrange(y, m)[1]))


# ═══ EPS ════════════════════════════════════════════════════════════════════════════════════════
def share_timeline(events: Iterable[dict], upto: date) -> List[dict]:
    """Raw shares outstanding after each event, and the bonus/split factor each event applies to everything before it.

    Events: ``opening``/``issue`` add ``shares``; ``buyback`` removes ``shares``; ``bonus`` adds ``ratio`` new shares per
    share held (0.5 = 1 for 2); ``split`` multiplies the holding by ``ratio`` (10 = one share becomes ten).
    """
    out, outstanding = [], 0.0
    for e in sorted((x for x in events if x.get("type") != "potential" and d_(x["date"]) <= upto), key=lambda x: (str(x["date"]), str(x.get("created_at") or ""))):
        t, factor = e["type"], 1.0
        if t in ("opening", "issue"):
            outstanding += float(e.get("shares") or 0)
        elif t == "buyback":
            outstanding -= float(e.get("shares") or 0)
        elif t == "bonus":
            factor = 1 + float(e.get("ratio") or 0)
            outstanding *= factor
        elif t == "split":
            factor = float(e.get("ratio") or 1)
            outstanding *= factor
        out.append({"date": d_(e["date"]), "type": t, "outstanding": outstanding, "factor": factor})
    return out


def weighted_average_shares(events: Iterable[dict], start: date, end: date) -> Dict[str, float]:
    """Time-weighted shares for the period. Bonus and split factors are applied to every share outstanding before them,
    as if they had always been in place (AS 20 para 10-11 / Ind AS 33 para 26)."""
    tl = share_timeline(events, end)
    days = (end - start).days + 1
    if days <= 0:
        return {"weighted": 0.0, "closing": 0.0, "days": 0}

    def adjusted(count: float, at: date) -> float:
        mult = 1.0
        for e in tl:
            if e["date"] > at and e["factor"] != 1.0 and e["type"] in ("bonus", "split"):
                mult *= e["factor"]
        return count * mult

    # segments: the count in force on `start`, then each event inside the period
    count_at_start = 0.0
    for e in tl:
        if e["date"] <= start:
            count_at_start = e["outstanding"]
    points = [(start, count_at_start)] + [(e["date"], e["outstanding"]) for e in tl if start < e["date"] <= end]
    total = 0.0
    for i, (day, count) in enumerate(points):
        nxt = points[i + 1][0] if i + 1 < len(points) else end + timedelta(days=1)
        total += adjusted(count, day) * (nxt - day).days
    closing = tl[-1]["outstanding"] if tl else 0.0
    return {"weighted": total / days, "closing": closing, "days": days}


def eps(profit_for_equity: float, weighted_shares: float, potentials: Iterable[dict] = (), avg_price: Optional[float] = None) -> dict:
    """Basic and diluted EPS.

    ``potentials``: {"instrument": "convertible"|"option", "shares", "exercise_price", "earnings_addback"} where
    ``earnings_addback`` is the post-tax interest saved if a convertible converts. Options use the treasury-stock method
    at ``avg_price``. Instruments are added most dilutive first and only while they still reduce EPS; a loss makes
    everything anti-dilutive, so diluted equals basic.
    """
    basic = profit_for_equity / weighted_shares if weighted_shares > 0 else 0.0
    rows = []
    for p in potentials:
        n = float(p.get("shares") or 0)
        if p.get("instrument") == "option":
            ex = float(p.get("exercise_price") or 0)
            if not avg_price or avg_price <= ex:
                rows.append({**p, "incremental_shares": 0.0, "addback": 0.0, "included": False, "reason": "Exercise price is not below the average market price, so it is anti-dilutive."})
                continue
            inc = n * (1 - ex / avg_price)
            rows.append({**p, "incremental_shares": inc, "addback": 0.0})
        else:
            rows.append({**p, "incremental_shares": n, "addback": float(p.get("earnings_addback") or 0)})
    cand = [r for r in rows if "included" not in r and r["incremental_shares"] > 0]
    cand.sort(key=lambda r: r["addback"] / r["incremental_shares"])
    num, den = profit_for_equity, weighted_shares
    current = basic
    for r in cand:
        if profit_for_equity <= 0:
            r.update(included=False, reason="A loss per share cannot be diluted.")
            continue
        n2, d2 = num + r["addback"], den + r["incremental_shares"]
        if n2 / d2 < current:
            num, den, current = n2, d2, n2 / d2
            r["included"] = True
        else:
            r.update(included=False, reason="It would increase EPS, so it is anti-dilutive.")
    return {"basic": round(basic, 2), "diluted": round(current, 2), "diluted_numerator": r2(num), "diluted_shares": round(den, 2),
            "instruments": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in r.items()} for r in rows]}


# ═══ Leases ═════════════════════════════════════════════════════════════════════════════════════
PERIODS_PER_YEAR = {"monthly": 12, "quarterly": 4, "half_yearly": 2, "yearly": 1}


def lease_schedule(payment: float, periods: int, frequency: str, annual_rate_pct: float, start: date, in_advance: bool = False,
                   escalation_pct: float = 0.0) -> dict:
    """The liability schedule for a lease. Escalation raises the payment once a year (compounding)."""
    ppy = PERIODS_PER_YEAR[frequency]
    step = 12 // ppy
    i = annual_rate_pct / 100.0 / ppy
    pays = [payment * ((1 + escalation_pct / 100.0) ** (k // ppy)) for k in range(periods)]
    pv = sum(p / ((1 + i) ** (k if in_advance else k + 1)) for k, p in enumerate(pays))
    opening, rows = pv, []
    for k, pay in enumerate(pays):
        begin = add_months(start, k * step)
        end = add_months(start, (k + 1) * step) - timedelta(days=1)
        base = opening - pay if in_advance else opening
        interest = base * i
        closing = base + interest if in_advance else opening + interest - pay
        if k == periods - 1 and abs(closing) < 0.05:
            closing = 0.0
        rows.append({"period": k + 1, "start": begin.isoformat(), "end": end.isoformat(), "opening": r2(opening), "interest": r2(interest),
                     "payment": r2(pay), "principal": r2(pay - interest), "closing": r2(closing)})
        opening = closing
    total_pay = sum(pays)
    sl = total_pay / periods if periods else 0.0
    return {"present_value": r2(pv), "total_payments": r2(total_pay), "rows": rows, "straight_line_per_period": r2(sl),
            "depreciation_per_period": r2(pv / periods) if periods else 0.0}


# ═══ Employee benefits ══════════════════════════════════════════════════════════════════════════
GRATUITY_CAP = 2_000_000.0


def service_years(joining: date, as_of: date) -> int:
    """Completed years of service, with a part year of more than six months counted as a full year (Payment of Gratuity Act)."""
    if as_of < joining:
        return 0
    years = as_of.year - joining.year - ((as_of.month, as_of.day) < (joining.month, joining.day))
    anniv = date(joining.year + years, joining.month, min(joining.day, calendar.monthrange(joining.year + years, joining.month)[1]))
    extra_days = (as_of - anniv).days
    return years + (1 if extra_days > 182 else 0)


def gratuity(monthly_basic: float, joining: date, as_of: date, min_service_years: int = 5, cap: float = GRATUITY_CAP) -> dict:
    """15/26 x last drawn pay x years of service, once the employee has completed the qualifying service."""
    yrs = service_years(joining, as_of)
    completed = as_of.year - joining.year - ((as_of.month, as_of.day) < (joining.month, joining.day))
    eligible = completed >= min_service_years
    amount = min(15.0 / 26.0 * monthly_basic * yrs, cap) if eligible else 0.0
    return {"service_years": yrs, "eligible": eligible, "amount": r2(amount)}


def leave_encashment(monthly_basic: float, leave_days: float) -> float:
    return r2(leave_days * monthly_basic / 26.0)


# ═══ Foreign currency ═══════════════════════════════════════════════════════════════════════════
ASSET_KINDS = ("receivable", "bank", "loan_given")
LIABILITY_KINDS = ("payable", "loan_taken")


def fx_difference(kind: str, fc_amount: float, booked_rate: float, closing_rate: float) -> float:
    """Gain (+) or loss (-) in rupees from restating a monetary item at the closing rate."""
    move = float(fc_amount) * (float(closing_rate) - float(booked_rate))
    return r2(move if kind in ASSET_KINDS else -move)


# ═══ Provisions and contingencies ═══════════════════════════════════════════════════════════════
def treatment(probability: str, estimable: bool, is_asset: bool = False) -> str:
    """What to do with an obligation: ``recognise``, ``disclose`` or ``ignore`` (AS 29 / Ind AS 37).

    A provision needs a probable outflow and a reliable estimate. A possible outflow, or a probable one that cannot be
    measured, is a contingent liability: disclosed, not booked. A remote one is neither. A contingent asset is never
    booked; it is disclosed only when the inflow is probable.
    """
    if is_asset:
        return "disclose" if probability == "probable" else "ignore"
    if probability == "probable":
        return "recognise" if estimable else "disclose"
    if probability == "possible":
        return "disclose"
    return "ignore"


def present_value(amount: float, rate_pct: float, years: float) -> float:
    return r2(amount / ((1 + rate_pct / 100.0) ** years)) if rate_pct and years else r2(amount)


# ═══ Borrowing costs ════════════════════════════════════════════════════════════════════════════
def borrowing_cost(principal: float, rate_pct: float, start: date, end: date, temp_income: float = 0.0) -> dict:
    days = (end - start).days + 1
    interest = principal * rate_pct / 100.0 * days / 365.0
    return {"days": days, "interest": r2(interest), "temporary_income": r2(temp_income), "capitalisable": r2(max(interest - temp_income, 0.0))}


# ═══ Receivables ════════════════════════════════════════════════════════════════════════════════
BUCKETS = [("Not yet due", None, 0), ("1-30 days", 1, 30), ("31-90 days", 31, 90), ("91-180 days", 91, 180), ("181-365 days", 181, 365), ("Over 365 days", 366, None)]
MATRIX_IND_AS = [0.5, 1.0, 3.0, 10.0, 35.0, 75.0]     # expected credit loss, % of the balance in each bucket
MATRIX_AS = [0.0, 0.0, 0.0, 0.0, 25.0, 50.0]          # provision only once recovery is in real doubt


def bucket_index(days_overdue: int) -> int:
    if days_overdue <= 0:
        return 0
    for i, (_n, lo, hi) in enumerate(BUCKETS):
        if lo and days_overdue >= lo and (hi is None or days_overdue <= hi):
            return i
    return len(BUCKETS) - 1


def ageing(invoices: Iterable[dict], as_of: date, rates: List[float], forward_looking_pct: float = 0.0) -> dict:
    """Group outstanding invoices by days past due and apply the matrix. ``invoices``: due_date, amount."""
    sums = [0.0] * len(BUCKETS)
    for inv in invoices:
        amt = float(inv.get("amount") or 0)
        if amt <= 0:
            continue
        due = d_(inv["due_date"])
        sums[bucket_index((as_of - due).days)] += amt
    uplift = 1 + forward_looking_pct / 100.0
    rows, total, prov = [], 0.0, 0.0
    for (name, _lo, _hi), amt, rate in zip(BUCKETS, sums, rates):
        eff = min(rate * uplift, 100.0)
        p = amt * eff / 100.0
        rows.append({"bucket": name, "outstanding": r2(amt), "rate_pct": round(eff, 2), "provision": r2(p)})
        total += amt
        prov += p
    return {"rows": rows, "total_outstanding": r2(total), "provision_required": r2(prov)}
