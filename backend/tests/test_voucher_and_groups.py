"""Pure rules: voucher types, numbering format, financial-year labels and Tally groups."""
from datetime import date

from backend.tally_groups import GROUPS, ancestors, group_of, side_of
from backend.voucher_numbering import fy_label, fy_short, format_number, voucher_kind


def test_financial_year_runs_april_to_march():
    assert fy_label(date(2026, 4, 1)) == "2026-27" and fy_label(date(2027, 3, 31)) == "2026-27"
    assert fy_label(date(2027, 4, 1)) == "2027-28" and fy_label(date(2027, 1, 15)) == "2026-27"
    assert fy_short(date(2026, 10, 18)) == "26-27"


def test_number_format():
    assert format_number("payment", date(2026, 5, 2), 7) == "PAY/26-27/0007"
    assert format_number("journal", date(2027, 2, 1), 12345) == "JV/26-27/12345"


def test_documents_decide_their_own_type():
    assert voucher_kind("sale", [(100, 0, False), (0, 100, False)]) == "sales"
    assert voucher_kind("purchase", [(100, 0, False), (0, 100, False)]) == "purchase"
    assert voucher_kind("payment", [(100, 0, True), (0, 100, False)]) == "receipt"          # receipt against a sales invoice
    assert voucher_kind("purchase_payment", [(0, 100, True), (100, 0, False)]) == "payment"
    assert voucher_kind("voucher_contra", [(100, 0, True), (0, 100, True)]) == "contra"
    assert voucher_kind("reversal", [(100, 0, True), (0, 100, False)]) == "journal"


def test_other_entries_follow_tallys_cash_and_bank_rule():
    assert voucher_kind("bank", [(500, 0, True), (0, 500, False)]) == "receipt"             # bank debited
    assert voucher_kind("bank", [(0, 500, True), (500, 0, False)]) == "payment"             # bank credited
    assert voucher_kind("manual", [(500, 0, True), (0, 500, True)]) == "contra"             # cash and bank only
    assert voucher_kind("manual", [(500, 0, False), (0, 500, False)]) == "journal"          # neither touched
    assert voucher_kind("manual", []) == "journal"


def _a(code, typ, sub="", name="", head=None, cost=None):
    return {"code": code, "type": typ, "sub_type": sub, "name": name}


def test_groups_follow_the_classification():
    assert group_of(_a("1000", "asset", name="Cash in Hand")) == "Cash-in-hand"
    assert group_of(_a("1010", "asset", name="Bank Accounts")) == "Bank Accounts"
    assert group_of(_a("1100", "asset", name="Accounts Receivable")) == "Sundry Debtors"
    assert group_of(_a("1150", "asset", name="Provision for Doubtful Debts")) == "Sundry Debtors"   # nets against debtors
    assert group_of(_a("1300", "asset", name="Fixed Assets")) == "Fixed Assets"
    assert group_of(_a("1310", "asset", name="Accumulated Depreciation")) == "Fixed Assets"
    assert group_of(_a("1350", "asset", name="Intangible Assets (Software)")) == "Intangible Assets"
    assert group_of(_a("1400", "asset", name="Inventory / Stock-in-Trade")) == "Stock-in-hand"
    assert group_of(_a("1200", "asset", name="GST Input Credit")) == "Loans & Advances (Asset)"
    assert group_of(_a("9998", "asset", name="Suspense Account")) == "Suspense A/c"
    assert group_of(_a("2000", "liability", name="Accounts Payable")) == "Sundry Creditors"
    assert group_of(_a("2100", "liability", name="GST Output Payable")) == "Duties & Taxes"
    assert group_of(_a("2200", "liability", name="TDS Payable")) == "Duties & Taxes"
    assert group_of(_a("2400", "liability", name="Provisions")) == "Provisions"
    assert group_of(_a("2700", "liability", name="Long-term Loans & Borrowings")) == "Loans (Liability)"
    assert group_of(_a("2500", "liability", name="Deferred Tax Liability")) == "Deferred Tax Liability"
    assert group_of(_a("3000", "equity", name="Owner's Capital / Equity")) == "Capital Account"
    assert group_of(_a("3100", "equity", name="Retained Earnings")) == "Reserves & Surplus"
    assert group_of(_a("4000", "income", name="Sales / Fee Income")) == "Sales Accounts"
    assert group_of(_a("4100", "income", name="Other Income")) == "Indirect Incomes"
    assert group_of(_a("5000", "expense", name="Purchases")) == "Purchase Accounts"
    assert group_of(_a("5010", "expense", name="Direct Expenses")) == "Direct Expenses"
    assert group_of(_a("5200", "expense", name="Rent Expense")) == "Indirect Expenses"
    assert group_of(_a("5800", "expense", name="Depreciation Expense")) == "Indirect Expenses"


def test_every_group_has_a_valid_parent_and_the_tree_has_no_cycles():
    for name, (parent, side) in GROUPS.items():
        assert parent is None or parent in GROUPS, name
        assert side in ("asset", "liability", "income", "expense")
        assert len(set(ancestors(name))) == len(ancestors(name))
    assert ancestors("Sundry Debtors") == ["Sundry Debtors", "Current Assets"]
    assert ancestors("Reserves & Surplus") == ["Reserves & Surplus", "Capital Account"]
    assert side_of("Sundry Creditors") == "liability"
