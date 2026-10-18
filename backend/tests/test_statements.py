"""Classification, the capital-or-revenue suggestion, and statements built from real balances (expected values worked out by hand)."""
import pytest

from backend.account_classification import classify, suggest_capital
from backend.statements import build_statements, fy_start_of, it_depreciation


def test_known_and_custom_accounts_are_classified():
    assert classify("1300", "asset", "fixed_asset", "Fixed Assets") == {"statement": "balance_sheet", "nature": "capital",
        "schedule3_head": "Property, plant and equipment", "cost_type": None, "is_contra": False}
    assert classify("1310", "asset", "accumulated_depreciation", "Accumulated Depreciation")["is_contra"] is True
    assert classify("4000", "income", "operating_income", "Sales")["statement"] == "trading"
    assert classify("5000", "expense", "cost_of_service", "Purchases")["cost_type"] == "direct"
    assert classify("5800", "expense", "depreciation", "Depreciation Expense")["schedule3_head"] == "Depreciation and amortisation expense"
    # a ledger the firm added itself still lands in the right place
    assert classify("1320", "asset", "", "Office Furniture")["nature"] == "capital"
    assert classify("5455", "expense", "", "Interest on Term Loan")["schedule3_head"] == "Finance costs"
    assert classify("1321", "asset", "", "Accumulated Depreciation - Vehicles")["is_contra"] is True
    assert classify("2750", "liability", "", "Term Loan from HDFC")["nature"] == "capital"
    assert classify("5105", "expense", "", "Staff Welfare")["schedule3_head"] == "Employee benefit expense"
    # capital spending is a balance-sheet item; everything that reaches profit is revenue in nature
    assert classify("5200", "expense", "operating_expense", "Rent")["nature"] == "revenue"


@pytest.mark.parametrize("text,amount,capital", [
    ("Dell Latitude laptop 14 inch", 62000, True),
    ("Office chairs x 6", 24000, True),
    ("Laptop charger", 1800, False),                      # under the capitalisation limit
    ("Annual maintenance contract for the server", 30000, False),
    ("Monthly cloud hosting subscription", 12000, False),
    ("Repair of air conditioner", 8000, False),
    ("Professional fees for audit", 50000, False),
    ("Perpetual licence for accounting software", 90000, True),
    ("Stationery and printer paper", 2500, False),
])
def test_capital_or_revenue_suggestion(text, amount, capital):
    s = suggest_capital(text, amount)
    assert s["capital"] is capital, s
    assert s["reason"]


def test_financial_year_and_tax_depreciation_rules():
    from datetime import date
    assert fy_start_of(date(2027, 2, 1)) == date(2026, 4, 1) and fy_start_of(date(2026, 4, 1)) == date(2026, 4, 1)
    full = it_depreciation([{"id": "a", "category": "computers", "cost": 100000, "purchase_date": "2026-04-10"}], date(2026, 4, 1))
    assert full["depreciation"] == 40000.0 and full["closing_wdv"] == 60000.0
    half = it_depreciation([{"id": "a", "category": "computers", "cost": 100000, "purchase_date": "2027-01-10"}], date(2026, 4, 1))
    assert half["depreciation"] == 20000.0                # used for fewer than 180 days: half rate
    second = it_depreciation([{"id": "a", "category": "computers", "cost": 100000, "purchase_date": "2026-04-10"}], date(2027, 4, 1))
    assert second["opening_wdv"] == 60000.0 and second["depreciation"] == 24000.0
    assert it_depreciation([{"id": "a", "category": "furniture", "cost": 50000, "purchase_date": "2027-06-01"}], date(2026, 4, 1))["depreciation"] == 0
    assert it_depreciation([{"id": "a", "category": "furniture", "cost": 50000, "purchase_date": "2026-05-01", "status": "cancelled"}], date(2026, 4, 1))["depreciation"] == 0


def _book():
    from backend.accounting_core import DEFAULT_ACCOUNTS
    accounts = [{"id": c, "company_id": "x", "code": c, "name": n, "type": t, "sub_type": s} for c, n, t, s in DEFAULT_ACCOUNTS]
    lines = []

    def je(day, *legs):
        for code, dr, cr in legs:
            lines.append({"account_id": code, "debit": dr, "credit": cr, "entry_date": day})
    je("2026-04-01", ("1010", 500000, 0), ("3000", 0, 500000))                       # capital brought in
    je("2026-04-10", ("1300", 100000, 0), ("1200", 18000, 0), ("1010", 0, 118000))   # laptop bought with GST
    je("2026-04-15", ("1010", 300000, 0), ("4000", 0, 300000))                       # sales
    je("2026-05-01", ("5000", 120000, 0), ("1010", 0, 120000))                       # purchases
    je("2026-05-02", ("5200", 20000, 0), ("1010", 0, 20000))                         # rent
    je("2026-05-03", ("5450", 1000, 0), ("1010", 0, 1000))                           # interest
    je("2026-06-30", ("5800", 2500, 0), ("1310", 0, 2500))                           # depreciation
    assets = [{"id": "a1", "category": "computers", "cost": 100000, "purchase_date": "2026-04-10", "book_value": 97500, "status": "active"}]
    return accounts, lines, assets


def test_statements_come_from_the_books():
    accounts, lines, assets = _book()
    st = build_statements(accounts, lines, assets, "2026-04-01", "2027-03-31")
    bs, pnl = st["schedule_iii"]["balance_sheet"], st["schedule_iii"]["pnl"]

    assert bs["balanced"] and bs["difference"] == 0
    # fixed assets are shown at cost less what has actually been written off, not at a guessed 10%
    ppe = bs["assets"]["non_current_assets"]
    assert (ppe["gross_block"], ppe["accumulated_depreciation"], ppe["property_plant_equipment"]) == (100000.0, 2500.0, 97500.0)
    assert pnl["expenses"]["depreciation"] == 2500.0 and pnl["expenses"]["finance_costs"] == 1000.0   # real, not 10% / 5%
    assert pnl["expenses"]["cost_of_purchases"] == 120000.0 and pnl["expenses"]["other_operating_expenses"] == 20000.0
    assert pnl["profit_before_tax"] == 156500.0 and pnl["tax_expense"] == 0.0 and pnl["profit_after_tax"] == 156500.0
    assert bs["equity_and_liabilities"]["shareholders_funds"]["reserves_and_surplus"] == 156500.0
    assert bs["assets"]["current_assets"]["cash_and_cash_equivalents"] == 500000 - 118000 + 300000 - 120000 - 20000 - 1000

    tr = st["trading_account"]
    assert tr["sales"] == 300000.0 and tr["direct_costs"] == 120000.0 and tr["gross_profit"] == 180000.0
    assert tr["gross_margin_pct"] == 60.0 and tr["indirect_expenses"] == 23500.0 and tr["net_profit_before_tax"] == 156500.0 and tr["ties_to_pnl"]

    cf = st["mis"]["cash_flow"]
    assert cf["investing"] == -100000.0 and cf["financing"] == 500000.0
    assert cf["operating"] == 156500.0 + 2500.0 - 18000.0          # profit + depreciation - GST input receivable
    assert cf["reconciles"] and cf["closing_cash"] == cf["net"] and cf["opening_cash"] == 0.0


def test_income_tax_and_deferred_tax_follow_the_register():
    accounts, lines, assets = _book()
    st = build_statements(accounts, lines, assets, "2026-04-01", "2027-03-31")
    it = st["income_tax"]
    assert it["depreciation_it_deduction"] == 40000.0              # computers, 40% of 100,000
    assert it["taxable_pgbp_income"] == 156500.0 + 2500.0 - 40000.0 == 119000.0
    assert (it["base_tax"], it["cess_amount"], it["total_tax_payable"]) == (29750.0, 1190.0, 30940.0)
    assert it["tax_rate_is_assumption"] and it["current_tax_booked"] == 0.0 and it["tax_to_book"] == 30940.0
    assert it["disallowance_43b"] == 0.0                           # exposure is reported, never silently added back

    dt = st["deferred_tax"]
    assert (dt["book_written_down_value"], dt["tax_written_down_value"], dt["timing_difference"]) == (97500.0, 60000.0, 37500.0)
    assert dt["required_net_liability"] == round(37500 * 0.25 * 1.04, 2) == 9750.0 and dt["kind"] == "liability"
    assert dt["booked_net_liability"] == 0.0 and dt["adjustment_to_book"] == 9750.0


def test_booked_tax_and_deferred_tax_are_picked_up():
    accounts, lines, assets = _book()
    lines += [{"account_id": "5950", "debit": 30940, "credit": 0, "entry_date": "2027-03-31"}, {"account_id": "2600", "debit": 0, "credit": 30940, "entry_date": "2027-03-31"},
              {"account_id": "5960", "debit": 9750, "credit": 0, "entry_date": "2027-03-31"}, {"account_id": "2500", "debit": 0, "credit": 9750, "entry_date": "2027-03-31"}]
    st = build_statements(accounts, lines, assets, "2026-04-01", "2027-03-31")
    pnl, bs = st["schedule_iii"]["pnl"], st["schedule_iii"]["balance_sheet"]
    assert pnl["tax_expense"] == 30940.0 + 9750.0 and pnl["profit_after_tax"] == 156500.0 - 40690.0
    assert st["income_tax"]["tax_to_book"] == 0.0 and st["deferred_tax"]["adjustment_to_book"] == 0.0
    assert bs["equity_and_liabilities"]["non_current_liabilities"]["deferred_tax_liabilities"] == 9750.0
    assert bs["equity_and_liabilities"]["current_liabilities"]["short_term_provisions"] == 30940.0
    assert bs["balanced"] and st["mis"]["cash_flow"]["reconciles"]


def test_opening_balances_are_not_counted_as_this_periods_activity():
    accounts, lines, assets = _book()
    st = build_statements(accounts, lines, assets, "2026-06-01", "2027-03-31")      # April and May happened before the period
    assert st["schedule_iii"]["pnl"]["revenue_from_operations"] == 0.0 and st["schedule_iii"]["pnl"]["expenses"]["depreciation"] == 2500.0
    assert st["schedule_iii"]["balance_sheet"]["balanced"] and st["mis"]["cash_flow"]["reconciles"]
    assert st["mis"]["cash_flow"]["opening_cash"] == 500000 - 118000 + 300000 - 120000 - 20000 - 1000
    assert st["mis"]["cash_flow"]["investing"] == 0.0 and st["mis"]["cash_flow"]["financing"] == 0.0


def test_party_ledgers_resolve_by_who_they_are():
    accounts, lines, assets = _book()
    accounts += [{"id": "c1", "company_id": "x", "code": "C001", "name": "Acme Traders", "type": "asset", "sub_type": "", "is_party_ledger": True, "party_type": "customer"},
                 {"id": "v1", "company_id": "x", "code": "V001", "name": "Beta Supplies", "type": "liability", "sub_type": "", "is_party_ledger": True, "party_type": "vendor"}]
    lines += [{"account_id": "c1", "debit": 5000, "credit": 0, "entry_date": "2026-07-01"}, {"account_id": "4000", "debit": 0, "credit": 5000, "entry_date": "2026-07-01"},
              {"account_id": "5000", "debit": 3000, "credit": 0, "entry_date": "2026-07-02"}, {"account_id": "v1", "debit": 0, "credit": 3000, "entry_date": "2026-07-02"}]
    bs = build_statements(accounts, lines, assets, "2026-04-01", "2027-03-31")["schedule_iii"]["balance_sheet"]
    assert bs["assets"]["current_assets"]["trade_receivables"] == 5000.0
    assert bs["equity_and_liabilities"]["current_liabilities"]["trade_payables"] == 3000.0 and bs["balanced"]
