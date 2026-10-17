"""Ledger-based Finix metrics.

Every number the Finix dashboard shows for health, GST/TDS, cash-flow and
anomalies is derived here from the **general ledger** (journal_entries /
journal_lines / chart_of_accounts) — the same source the Trial Balance and
Balance Sheet use — and cross-checked against the source documents.

Rules this module follows:
  * Party sub-ledgers (``is_party_ledger`` accounts whose ``parent_code`` is
    1100 / 2000) roll up into their control account, so receivables and
    payables are never understated by AI-posted party entries.
  * Cancelled invoices, proforma invoices and estimates never count; credit
    notes reduce, debit notes increase.
  * Nothing is invented: when there is no data the value is ``None`` / the
    section says so, and filing/challan *status* is never claimed (this system
    does not file returns) — only due dates are computed.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, Optional

from backend.dependencies import db

NON_REVENUE_TYPES = ("proforma", "estimate")


# ── small helpers ────────────────────────────────────────────────────────────
def safe_float(value: Any, default: float = 0.0) -> float:
    if value is None or value == "":
        return default
    try:
        if hasattr(value, "to_decimal"):
            return float(value.to_decimal())
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return default


def date_key(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or "")[:10]


def financial_year_start(today: Optional[date] = None) -> date:
    """Indian FY starts 1 April: Jan–Mar belong to the FY that began the previous April."""
    today = today or date.today()
    return date(today.year if today.month >= 4 else today.year - 1, 4, 1)


def month_bounds(today: Optional[date] = None) -> tuple[date, date]:
    today = today or date.today()
    start = today.replace(day=1)
    nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
    return start, nxt - timedelta(days=1)


def _next_month_day(d: date, day: int) -> date:
    first_next = (d.replace(day=28) + timedelta(days=4)).replace(day=1)
    return first_next.replace(day=day)


def gst_due_dates(period_month: date) -> dict:
    """GSTR-1 (11th) and GSTR-3B (20th) of the month after the return period."""
    return {
        "period": period_month.strftime("%B %Y"),
        "gstr1_due": _next_month_day(period_month, 11).isoformat(),
        "gstr3b_due": _next_month_day(period_month, 20).isoformat(),
    }


def tds_challan_due(period_month: date) -> str:
    """TDS deducted in a month is due on the 7th of the next month (30 April for March)."""
    if period_month.month == 3:
        return date(period_month.year, 4, 30).isoformat()
    return _next_month_day(period_month, 7).isoformat()


# ── ledger loading ───────────────────────────────────────────────────────────
class Ledger:
    """In-memory view of one company's general ledger."""

    def __init__(self, accounts: list, entries: dict, lines: list):
        self.accounts = {a["id"]: a for a in accounts if a.get("id")}
        self.entry_date = entries          # entry_id -> YYYY-MM-DD
        self.lines = lines
        self.orphan_line_count = 0

    def group_code(self, account_id: str) -> str:
        a = self.accounts.get(account_id) or {}
        if a.get("is_party_ledger") and a.get("parent_code"):
            return str(a["parent_code"])
        return str(a.get("code") or "")

    def balance(self, code: str, nature: str, start: Optional[str] = None, end: Optional[str] = None,
                include_children: bool = True) -> float:
        """Net balance of an account code (party sub-ledgers rolled up).

        nature "dr": debit - credit (assets/expenses)   "cr": credit - debit (liabilities/income)
        """
        dr = cr = 0.0
        for l in self.lines:
            aid = l.get("account_id")
            gc = self.group_code(aid) if include_children else str((self.accounts.get(aid) or {}).get("code") or "")
            if gc != code:
                continue
            d = self.entry_date.get(l.get("entry_id"), "")
            if start and d < start:
                continue
            if end and d > end:
                continue
            dr += safe_float(l.get("debit"))
            cr += safe_float(l.get("credit"))
        return round(dr - cr if nature == "dr" else cr - dr, 2)

    def by_type(self, acct_type: str, start: Optional[str] = None, end: Optional[str] = None) -> float:
        """Income (credit-debit) or expense (debit-credit) for a period."""
        total = 0.0
        for l in self.lines:
            a = self.accounts.get(l.get("account_id")) or {}
            if a.get("type") != acct_type:
                continue
            d = self.entry_date.get(l.get("entry_id"), "")
            if start and d < start:
                continue
            if end and d > end:
                continue
            if acct_type == "income":
                total += safe_float(l.get("credit")) - safe_float(l.get("debit"))
            else:
                total += safe_float(l.get("debit")) - safe_float(l.get("credit"))
        return round(total, 2)

    def totals(self) -> tuple[float, float]:
        return (round(sum(safe_float(l.get("debit")) for l in self.lines), 2),
                round(sum(safe_float(l.get("credit")) for l in self.lines), 2))

    def monthly_expense(self, months: int, today: date) -> list:
        """Expense per complete calendar month for the last ``months`` months."""
        out = []
        cursor = today.replace(day=1)
        for _ in range(months):
            end = cursor - timedelta(days=1)
            start = end.replace(day=1)
            out.append(self.by_type("expense", start.isoformat(), end.isoformat()))
            cursor = start
        return out


async def load_ledger(company_id: str) -> Ledger:
    accounts = await db.chart_of_accounts.find({"company_id": company_id}, {"_id": 0}).to_list(20000)
    entries = {e["id"]: date_key(e.get("entry_date")) for e in
               await db.journal_entries.find({"company_id": company_id}, {"_id": 0, "id": 1, "entry_date": 1}).to_list(500000)}
    raw = await db.journal_lines.find({"company_id": company_id}, {"_id": 0}).to_list(1000000)
    lines = [l for l in raw if l.get("entry_id") in entries]
    ledger = Ledger(accounts, entries, lines)
    ledger.orphan_line_count = len(raw) - len(lines)
    return ledger


async def find_orphan_notes(company_id: str) -> list:
    notes = await db.invoices.find(
        {"company_id": company_id, "invoice_type": {"$in": ["credit_note", "debit_note"]}},
        {"_id": 0, "id": 1, "invoice_no": 1, "invoice_type": 1, "original_invoice_id": 1, "grand_total": 1,
         "invoice_date": 1, "client_name": 1, "status": 1}).to_list(20000)
    parents = {n.get("original_invoice_id") for n in notes if n.get("original_invoice_id")}
    existing = set()
    if parents:
        existing = {d["id"] for d in await db.invoices.find({"id": {"$in": list(parents)}}, {"_id": 0, "id": 1}).to_list(20000)}
    return [n for n in notes if n.get("status") != "cancelled"
            and (not n.get("original_invoice_id") or n["original_invoice_id"] not in existing)]


def _counts_as_revenue_doc(doc: dict) -> bool:
    if doc.get("status") == "cancelled":
        return False
    return (doc.get("invoice_type") or "tax_invoice") not in NON_REVENUE_TYPES


async def bank_cash_from_books(ledger: Ledger) -> float:
    return round(ledger.balance("1000", "dr") + ledger.balance("1010", "dr"), 2)


# ── integrity ────────────────────────────────────────────────────────────────
async def integrity_issues(company_id: str, ledger: Ledger) -> list:
    issues = []
    orphans = await find_orphan_notes(company_id)
    if orphans:
        names = ", ".join(str(n.get("invoice_no") or n["id"][:8]) for n in orphans[:5])
        issues.append({"code": "ORPHAN_NOTE", "severity": "high", "blocker": True, "count": len(orphans),
                       "message": f"{len(orphans)} credit/debit note(s) refer to an invoice that no longer exists ({names}). "
                                  "They still affect sales and receivables — delete them."})
    dr, cr = ledger.totals()
    if abs(dr - cr) >= 0.05:
        issues.append({"code": "TRIAL_BALANCE_OUT", "severity": "high", "blocker": True,
                       "message": f"Trial balance is out by {abs(dr - cr):,.2f} (debits {dr:,.2f} vs credits {cr:,.2f})."})
    ar = ledger.balance("1100", "dr")
    ap = ledger.balance("2000", "cr")
    if ar < -0.5:
        issues.append({"code": "NEGATIVE_RECEIVABLES", "severity": "high", "blocker": True,
                       "message": f"Accounts Receivable is negative ({ar:,.2f}). Receipts or credit notes exceed the invoices "
                                  "on the books — usually a deleted invoice whose credit note or payment remains."})
    if ap < -0.5:
        issues.append({"code": "NEGATIVE_PAYABLES", "severity": "high", "blocker": True,
                       "message": f"Accounts Payable is negative ({ap:,.2f}). Payments exceed the bills on the books."})
    if ledger.orphan_line_count:
        issues.append({"code": "ORPHAN_JOURNAL_LINES", "severity": "high", "blocker": True, "count": ledger.orphan_line_count,
                       "message": f"{ledger.orphan_line_count} journal line(s) have no parent journal entry."})
    failures = await db.accounting_posting_failures.count_documents(
        {"company_id": company_id, "status": {"$in": ["POSTING_FAILED", "PENDING_APPROVAL"]}})
    if failures:
        issues.append({"code": "POSTING_FAILURES", "severity": "medium", "blocker": False, "count": failures,
                       "message": f"{failures} document(s) could not be posted to the ledger and need attention."})
    for code, label in (("1000", "Cash in Hand"), ("1010", "Bank Accounts")):
        bal = ledger.balance(code, "dr")
        if bal < -0.5:
            issues.append({"code": "NEGATIVE_CASH_BANK", "severity": "medium", "blocker": False,
                           "message": f"{label} ledger is negative ({bal:,.2f})."})
    return issues


# ── health score ─────────────────────────────────────────────────────────────
def _grade(score: float) -> str:
    return "A+" if score >= 90 else ("A" if score >= 80 else ("B" if score >= 65 else "C"))


async def health_score(company_id: str, today: Optional[date] = None) -> dict:
    today = today or date.today()
    ledger = await load_ledger(company_id)
    if not ledger.lines:
        return {"company_id": company_id, "score": None, "grade": None, "status": "NO_DATA",
                "message": "No journal entries exist for this company yet, so no health score can be calculated.",
                "issues": [], "breakdown": {}}

    issues = await integrity_issues(company_id, ledger)
    dr, cr = ledger.totals()
    diff = abs(dr - cr)
    tb_balanced = diff < 0.05
    tb_score = 25 if tb_balanced else max(0, 25 - int(diff))

    cash = await bank_cash_from_books(ledger)
    ar = ledger.balance("1100", "dr")
    ap = ledger.balance("2000", "cr")
    gst_out = ledger.balance("2100", "cr")
    gst_in = ledger.balance("1200", "dr")
    tds_pay = ledger.balance("2200", "cr")
    current_assets = max(cash, 0.0) + max(ar, 0.0) + max(gst_in, 0.0)
    current_liabilities = max(ap, 0.0) + max(gst_out, 0.0) + max(tds_pay, 0.0)
    working_capital = round(current_assets - current_liabilities, 2)
    current_ratio = round(current_assets / current_liabilities, 2) if current_liabilities > 0 else None
    if current_ratio is None:
        liquidity_score, liq_status = (20, "No current liabilities") if current_assets > 0 else (10, "No liquid assets or liabilities")
    else:
        liquidity_score = 20 if current_ratio >= 1.3 else (15 if current_ratio >= 1.0 else 8)
        liq_status = "Strong" if current_ratio >= 1.2 else ("Moderate" if current_ratio >= 1.0 else "Weak")

    fy_start = financial_year_start(today).isoformat()
    income = ledger.by_type("income", fy_start)
    expense = ledger.by_type("expense", fy_start)
    net_profit = round(income - expense, 2)
    profit_margin = round(net_profit / income * 100, 1) if income > 0 else None
    if income == 0 and expense == 0:
        profit_score, profit_status = 10, "No activity this financial year"
    elif net_profit > 0 and profit_margin is not None and profit_margin >= 15:
        profit_score, profit_status = 20, "Healthy"
    elif net_profit > 0:
        profit_score, profit_status = 15, "Profitable, thin margin"
    else:
        profit_score, profit_status = 5, "Loss-making"

    # Debtors quality: only real, open tax invoices count.
    invoices = await db.invoices.find(
        {"company_id": company_id, "amount_due": {"$gt": 0}},
        {"_id": 0, "amount_due": 1, "due_date": 1, "invoice_date": 1, "status": 1, "invoice_type": 1}).to_list(50000)
    open_total = overdue60 = 0.0
    for inv in invoices:
        if not _counts_as_revenue_doc(inv) or (inv.get("invoice_type") or "tax_invoice") != "tax_invoice":
            continue
        amt = safe_float(inv.get("amount_due"))
        open_total += amt
        due = date_key(inv.get("due_date") or inv.get("invoice_date"))
        try:
            if due and (today - datetime.strptime(due, "%Y-%m-%d").date()).days > 60:
                overdue60 += amt
        except ValueError:
            pass
    overdue_ratio = overdue60 / open_total if open_total > 0 else 0.0
    debtors_score = 15 if overdue_ratio < 0.1 else (10 if overdue_ratio < 0.25 else 5)

    # Statutory ledgers: GST/TDS balances must have their natural sign.
    stat_problems = []
    if gst_out < -0.5: stat_problems.append("GST Output Payable is in debit")
    if gst_in < -0.5: stat_problems.append("GST Input Credit is in credit")
    if tds_pay < -0.5: stat_problems.append("TDS Payable is in debit")
    statutory_score = 10 - 5 * min(len(stat_problems), 2)
    statutory_status = "Statutory ledgers consistent" if not stat_problems else "; ".join(stat_problems)

    ledger_score = max(0, 10 - 4 * len([i for i in issues if i["code"] != "TRIAL_BALANCE_OUT"]))
    total = tb_score + liquidity_score + profit_score + debtors_score + statutory_score + ledger_score
    blockers = [i for i in issues if i.get("blocker")]
    capped = bool(blockers) and total > 79
    if capped:
        total = 79
    total = int(min(100, total))

    return {
        "company_id": company_id, "score": total, "grade": _grade(total), "status": "OK",
        "capped": capped,
        "cap_reason": "Score capped at grade B while data-integrity blockers exist." if capped else None,
        "issues": issues,
        "trial_balance_balanced": tb_balanced, "trial_balance_diff": round(diff, 2),
        "working_capital": working_capital, "current_ratio": current_ratio,
        "net_profit": net_profit, "profit_margin": profit_margin, "financial_year_start": fy_start,
        "total_receivables": round(ar, 2), "overdue_60_plus": round(overdue60, 2),
        "total_payables": round(ap, 2), "cash_and_bank": cash,
        "source": "general ledger",
        "breakdown": {
            "trial_balance": {"score": tb_score, "max": 25, "status": "Passed" if tb_balanced else "Out of balance"},
            "liquidity": {"score": liquidity_score, "max": 20, "ratio": current_ratio, "status": liq_status},
            "profitability": {"score": profit_score, "max": 20, "margin": profit_margin, "status": profit_status},
            "debtors_quality": {"score": debtors_score, "max": 15, "overdue_pct": round(overdue_ratio * 100, 1),
                                "status": "Low risk" if overdue_ratio < 0.15 else "Review needed"},
            "statutory_compliance": {"score": statutory_score, "max": 10, "status": statutory_status},
            "ledger_cleanliness": {"score": ledger_score, "max": 10,
                                   "status": "Clean" if not issues else f"{len(issues)} issue(s) found"},
        },
    }


# ── statutory summary ────────────────────────────────────────────────────────
def _signed_docs(docs: list, *, purchase: bool, start: str, end: str) -> dict:
    taxable = cgst = sgst = igst = gst = 0.0
    for d in docs:
        if d.get("status") == "cancelled":
            continue
        inv_type = d.get("invoice_type") or ("purchase" if purchase else "tax_invoice")
        if inv_type in NON_REVENUE_TYPES:
            continue
        when = date_key(d.get("invoice_date"))
        if not when or when < start or when > end:
            continue
        sign = -1.0 if inv_type == "credit_note" else 1.0
        t = d.get("total_taxable") if d.get("total_taxable") not in (None, "") else (
            d.get("taxable_value") if d.get("taxable_value") not in (None, "") else d.get("subtotal"))
        taxable += sign * safe_float(t)
        c, s_, i_ = safe_float(d.get("total_cgst")), safe_float(d.get("total_sgst")), safe_float(d.get("total_igst"))
        cgst += sign * c; sgst += sign * s_; igst += sign * i_
        g = d.get("total_gst") if d.get("total_gst") not in (None, "") else (c + s_ + i_)
        gst += sign * safe_float(g)
    return {"taxable": round(taxable, 2), "cgst": round(cgst, 2), "sgst": round(sgst, 2),
            "igst": round(igst, 2), "gst": round(gst, 2)}


async def statutory_summary(company_id: str, today: Optional[date] = None) -> dict:
    today = today or date.today()
    ledger = await load_ledger(company_id)
    m_start, m_end = month_bounds(today)
    fy_start = financial_year_start(today)
    periods = {
        "current_month": (m_start.isoformat(), m_end.isoformat()),
        "financial_year_to_date": (fy_start.isoformat(), today.isoformat()),
    }
    invoices = await db.invoices.find({"company_id": company_id}, {"_id": 0}).to_list(100000)
    purchases = await db.purchase_invoices.find({"company_id": company_id}, {"_id": 0}).to_list(100000)

    def build(start: str, end: str) -> dict:
        out_gl = ledger.balance("2100", "cr", start, end)
        in_gl = ledger.balance("1200", "dr", start, end)
        out_doc = _signed_docs(invoices, purchase=False, start=start, end=end)
        in_doc = _signed_docs(purchases, purchase=True, start=start, end=end)
        net = round(out_gl - in_gl, 2)
        return {
            "outward_taxable": ledger.by_type("income", start, end),
            "outward_cgst": out_doc["cgst"], "outward_sgst": out_doc["sgst"], "outward_igst": out_doc["igst"],
            "total_output_liability": out_gl,
            "inward_taxable": in_doc["taxable"],
            "inward_cgst": in_doc["cgst"], "inward_sgst": in_doc["sgst"], "inward_igst": in_doc["igst"],
            "total_input_itc": in_gl,
            "net_payable": max(0.0, net),
            "itc_carried_forward": max(0.0, -net),
            "document_check": {
                "output_gst_gl_vs_documents": round(out_gl - out_doc["gst"], 2),
                "input_gst_gl_vs_documents": round(in_gl - in_doc["gst"], 2),
                "note": "A non-zero difference means the ledger and the invoices/bills disagree — investigate before filing.",
            },
            "has_activity": any(abs(v) > 0.004 for v in (out_gl, in_gl, out_doc["taxable"], in_doc["taxable"])),
        }

    gst = {name: build(*rng) for name, rng in periods.items()}
    cm = dict(gst["current_month"])
    cm.update({
        "period": gst_due_dates(m_start),
        "return_filing_status": "Not tracked — this system does not file GST returns.",
        "month": gst["current_month"],
        "financial_year_to_date": gst["financial_year_to_date"],
    })

    def tds_for(start: str, end: str) -> dict:
        credits = debits = 0.0
        for l in ledger.lines:
            a = ledger.accounts.get(l.get("account_id")) or {}
            if str(a.get("code")) != "2200":
                continue
            d = ledger.entry_date.get(l.get("entry_id"), "")
            if start <= d <= end:
                credits += safe_float(l.get("credit")); debits += safe_float(l.get("debit"))
        return {"deducted": round(credits, 2), "deposited_or_reversed": round(debits, 2)}

    tds_month = tds_for(*periods["current_month"])
    tds_fy = tds_for(*periods["financial_year_to_date"])
    sections: dict = defaultdict(float)
    for p in purchases:
        if p.get("status") == "cancelled" or not safe_float(p.get("tds_amount")):
            continue
        when = date_key(p.get("invoice_date"))
        if periods["financial_year_to_date"][0] <= when <= periods["financial_year_to_date"][1]:
            sections[str(p.get("tds_section") or "unspecified")] += safe_float(p.get("tds_amount"))
    sec_total = round(sum(sections.values()), 2)
    section_keys = {
        "194C": "194C_contractor", "194J": "194J_professional", "194I": "194I_rent", "194H": "194H_commission",
    }
    sections_out = {k: 0.0 for k in section_keys.values()}
    for sec, amt in sections.items():
        if sec in section_keys:
            sections_out[section_keys[sec]] = round(amt, 2)
    recorded_named = round(sum(sections_out.values()), 2)
    sections_out["other"] = round(max(0.0, sec_total - recorded_named), 2)

    tds = {
        "total_deducted": tds_fy["deducted"],
        "deducted_this_month": tds_month["deducted"],
        "tds_payable_balance": ledger.balance("2200", "cr"),
        "deposited_or_reversed_fy": tds_fy["deposited_or_reversed"],
        "sections": sections_out,
        "sections_source": "tds_section recorded on purchase bills",
        "unclassified_in_ledger": round(max(0.0, tds_fy["deducted"] - sec_total), 2),
        "challan_due_date": tds_challan_due(m_start),
        "status": "Not tracked — compare TDS Payable balance with challans actually deposited.",
    }
    return {"company_id": company_id, "source": "general ledger", "as_of": today.isoformat(),
            "financial_year_start": fy_start.isoformat(), "gst": cm, "tds": tds}


# ── cash-flow ────────────────────────────────────────────────────────────────
async def cashflow_forecast(company_id: str, today: Optional[date] = None) -> dict:
    today = today or date.today()
    ledger = await load_ledger(company_id)
    cash = await bank_cash_from_books(ledger)
    bank_docs = await db.bank_accounts.find({"company_id": company_id}, {"_id": 0, "current_balance": 1, "balance": 1}).to_list(200)
    bank_statement_cash = round(sum(safe_float(b.get("current_balance") if b.get("current_balance") not in (None, "") else b.get("balance"))
                                    for b in bank_docs), 2)

    invoices = await db.invoices.find({"company_id": company_id, "amount_due": {"$gt": 0}},
                                      {"_id": 0, "amount_due": 1, "due_date": 1, "invoice_date": 1, "status": 1, "invoice_type": 1}).to_list(50000)
    purchases = await db.purchase_invoices.find({"company_id": company_id, "amount_due": {"$gt": 0}},
                                                {"_id": 0, "amount_due": 1, "due_date": 1, "invoice_date": 1, "status": 1}).to_list(50000)

    horizons = [(30, 0.85), (60, 0.75), (90, 0.65)]
    d_marks = [(today + timedelta(days=h)).isoformat() for h, _ in horizons]

    def bucket(docs: list, factors: Optional[list]) -> list:
        totals = [0.0, 0.0, 0.0]
        for d in docs:
            if d.get("status") == "cancelled" or (d.get("invoice_type") or "tax_invoice") != "tax_invoice" and factors:
                continue
            due = date_key(d.get("due_date") or d.get("invoice_date"))
            amt = safe_float(d.get("amount_due"))
            idx = 0 if due <= d_marks[0] else (1 if due <= d_marks[1] else (2 if due <= d_marks[2] else None))
            if idx is None:
                continue
            totals[idx] += amt * (factors[idx] if factors else 1.0)
        return totals

    inflow_b = bucket(invoices, [f for _, f in horizons])
    outflow_b = bucket(purchases, None)
    inflow = [inflow_b[0], inflow_b[0] + inflow_b[1], inflow_b[0] + inflow_b[1] + inflow_b[2]]
    outflow = [outflow_b[0], outflow_b[0] + outflow_b[1], outflow_b[0] + outflow_b[1] + outflow_b[2]]
    proj = [round(cash + inflow[i] - outflow[i], 2) for i in range(3)]

    monthly = [m for m in ledger.monthly_expense(3, today)]
    months_with_data = [m for m in monthly if m > 0]
    avg_burn = round(sum(months_with_data) / len(months_with_data), 2) if months_with_data else None
    runway = round(cash / avg_burn, 1) if avg_burn and cash > 0 else (0.0 if avg_burn and cash <= 0 else None)
    if runway is None:
        status = "Not enough expense history"
    else:
        status = "Comfortable" if runway >= 6 else ("Manageable" if runway >= 3 else "Tight")

    return {
        "company_id": company_id, "source": "general ledger",
        "current_cash": cash, "bank_statement_cash": bank_statement_cash,
        "cash_difference_vs_bank_accounts": round(cash - bank_statement_cash, 2),
        "average_monthly_expense": avg_burn, "runway_months": runway, "runway_status": status,
        "forecast_30d": proj[0], "forecast_60d": proj[1], "forecast_90d": proj[2],
        "assumptions": {
            "collection_rates": {"within_30d": 0.85, "31_60d": 0.75, "61_90d": 0.65},
            "payables": "Paid in full on their due date.",
            "runway_basis": "Average expense of the last 3 complete months from the ledger (months with no expense are ignored).",
            "note": "Estimates, not guarantees. Receivables due after 90 days are excluded.",
        },
        "chart": [
            {"period": "Today", "cash": cash, "inflow": 0, "outflow": 0},
            {"period": "+30 Days", "cash": proj[0], "inflow": round(inflow[0], 2), "outflow": round(outflow[0], 2)},
            {"period": "+60 Days", "cash": proj[1], "inflow": round(inflow[1], 2), "outflow": round(outflow[1], 2)},
            {"period": "+90 Days", "cash": proj[2], "inflow": round(inflow[2], 2), "outflow": round(outflow[2], 2)},
        ],
    }


# ── anomalies ────────────────────────────────────────────────────────────────
async def anomalies(company_id: str, today: Optional[date] = None) -> dict:
    today = today or date.today()
    ledger = await load_ledger(company_id)
    items: list = []

    for issue in await integrity_issues(company_id, ledger):
        if issue["code"] == "ORPHAN_NOTE":
            for n in (await find_orphan_notes(company_id))[:20]:
                items.append({
                    "type": "ORPHAN_NOTE", "severity": "high",
                    "title": f"Orphan {str(n.get('invoice_type', 'note')).replace('_', ' ')} {n.get('invoice_no') or ''}".strip(),
                    "description": f"{n.get('client_name') or 'Customer'} — {safe_float(n.get('grand_total')):,.2f} dated {n.get('invoice_date')} "
                                   "refers to an invoice that no longer exists but still affects sales and receivables.",
                    "action": "Delete this note (Sales → Credit/Debit Notes) so the books agree with the invoices.",
                    "reference_id": n.get("id"),
                })
        else:
            items.append({"type": issue["code"], "severity": issue["severity"],
                          "title": issue["code"].replace("_", " ").title(), "description": issue["message"],
                          "action": "Open Accounting Integrity to review and fix."})

    # Large cash payments (s.40A(3)) — from the cash ledger, per entry
    cash_ids = {aid for aid, a in ledger.accounts.items() if str(a.get("code")) == "1000"}
    for l in ledger.lines:
        if l.get("account_id") in cash_ids and safe_float(l.get("credit")) > 10000:
            items.append({
                "type": "CASH_LIMIT_40A3", "severity": "high",
                "title": "Cash payment above ₹10,000 (s.40A(3))",
                "description": f"A cash payment of ₹{safe_float(l.get('credit')):,.2f} on {ledger.entry_date.get(l.get('entry_id'))} may be disallowed as an expense.",
                "action": "Review the voucher; pay by bank transfer in future.",
            })
            if len([i for i in items if i["type"] == "CASH_LIMIT_40A3"]) >= 10:
                break

    invs = await db.invoices.find({"company_id": company_id}, {"_id": 0}).to_list(100000)
    for inv in invs:
        if not _counts_as_revenue_doc(inv) or (inv.get("invoice_type") or "tax_invoice") != "tax_invoice":
            continue
        total = safe_float(inv.get("grand_total"))
        if total > 250000 and not str(inv.get("client_gstin") or "").strip():
            items.append({"type": "MISSING_GSTIN_HIGH_VALUE", "severity": "medium",
                          "title": f"High-value invoice without GSTIN ({inv.get('invoice_no')})",
                          "description": f"Invoice to {inv.get('client_name') or 'Customer'} for ₹{total:,.2f} has no customer GSTIN.",
                          "action": "Add the customer GSTIN before GSTR-1 filing."})
        due = date_key(inv.get("due_date"))
        if safe_float(inv.get("amount_due")) > 0 and due and due < (today - timedelta(days=90)).isoformat():
            items.append({"type": "STALE_RECEIVABLE", "severity": "warning",
                          "title": f"Receivable overdue 90+ days ({inv.get('invoice_no')})",
                          "description": f"{inv.get('client_name') or 'Customer'} owes ₹{safe_float(inv.get('amount_due')):,.2f}, due {due}.",
                          "action": "Follow up for payment."})

    return {"company_id": company_id, "count": len(items), "clean": not items, "items": items[:60], "source": "general ledger"}


# ── diagnostics: which ledger entries cause a wrong figure ───────────────────
async def ledger_diagnostics(company_id: str) -> dict:
    """Explain WHERE negative receivables / phantom sales come from.

    Every journal entry that reduces receivables, or whose source document is
    missing / should not be posted, is listed with the reason and the document
    behind it, so the user can fix the real cause instead of guessing.
    """
    ledger = await load_ledger(company_id)
    entries = await db.journal_entries.find({"company_id": company_id}, {"_id": 0}).to_list(500000)
    by_entry: dict = defaultdict(list)
    for l in ledger.lines:
        by_entry[l.get("entry_id")].append(l)

    invoices = {d["id"]: d for d in await db.invoices.find({"company_id": company_id}, {"_id": 0}).to_list(200000)}
    payments = {d["id"]: d for d in await db.payments.find({"company_id": company_id}, {"_id": 0}).to_list(200000)}
    purchases = {d["id"]: d for d in await db.purchase_invoices.find({"company_id": company_id}, {"_id": 0}).to_list(200000)}
    pur_pay = {d["id"]: d for d in await db.purchase_payments.find({"company_id": company_id}, {"_id": 0}).to_list(200000)}

    findings = []
    for e in entries:
        lines = by_entry.get(e["id"], [])
        ar_effect = round(sum(safe_float(l.get("debit")) - safe_float(l.get("credit"))
                              for l in lines if ledger.group_code(l.get("account_id")) == "1100"), 2)
        source, sid = e.get("source"), e.get("source_id")
        reason = code = None
        doc = None
        if source == "sale":
            doc = invoices.get(sid)
            if doc is None:
                code, reason = "SOURCE_MISSING", "The invoice behind this entry no longer exists."
            elif doc.get("status") == "cancelled" or (doc.get("invoice_type") or "tax_invoice") in NON_REVENUE_TYPES:
                code, reason = "SHOULD_NOT_BE_POSTED", "This document is cancelled/proforma/estimate and should not be in the books."
            elif doc.get("invoice_type") in ("credit_note", "debit_note") or doc.get("status") == "credit_note":
                parent = invoices.get(doc.get("original_invoice_id")) if doc.get("original_invoice_id") else None
                code = "CREDIT_NOTE_ENTRY"
                if doc.get("invoice_type") not in ("credit_note", "debit_note"):
                    reason = "An invoice was switched to status 'Credit Note' without being linked to an original invoice, so it posts negative sales."
                elif parent is None:
                    reason = "A credit/debit note whose original invoice is missing."
                else:
                    reason = (f"A credit note against {parent.get('invoice_no')} (status {parent.get('status')}); "
                              "it reduces receivables by its full value.")
                if ar_effect >= 0:
                    code = reason = None
        elif source == "payment":
            doc = payments.get(sid)
            if doc is None:
                code, reason = "SOURCE_MISSING", "The payment behind this entry no longer exists."
            elif doc.get("invoice_id") and doc["invoice_id"] not in invoices:
                code, reason = "PAYMENT_WITHOUT_INVOICE", "This payment refers to an invoice that no longer exists."
        elif source == "purchase" and sid not in purchases:
            code, reason = "SOURCE_MISSING", "The purchase bill behind this entry no longer exists."
        elif source == "purchase_payment" and sid not in pur_pay:
            code, reason = "SOURCE_MISSING", "The purchase payment behind this entry no longer exists."
        elif source in ("manual", "ai_zero_touch") and ar_effect < -0.5:
            code, reason = "MANUAL_ENTRY_REDUCES_RECEIVABLES", "A manual/AI journal entry credits receivables with no invoice behind it."
        if not code:
            continue
        findings.append({
            "entry_id": e["id"], "entry_date": date_key(e.get("entry_date")), "source": source, "source_id": sid,
            "narration": e.get("narration"), "total": round(safe_float(e.get("total_debit")), 2), "receivables_effect": ar_effect,
            "code": code, "reason": reason,
            "document": ({"id": doc["id"], "invoice_no": doc.get("invoice_no"), "invoice_type": doc.get("invoice_type"),
                          "status": doc.get("status"), "client_name": doc.get("client_name"),
                          "grand_total": doc.get("grand_total")} if doc and source in ("sale",) else None),
        })
    findings.sort(key=lambda f: abs(f["receivables_effect"]), reverse=True)
    return {"company_id": company_id, "count": len(findings), "receivables_balance": ledger.balance("1100", "dr"),
            "findings": findings[:50]}
