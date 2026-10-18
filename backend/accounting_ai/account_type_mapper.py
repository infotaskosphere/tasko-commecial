"""
Account Type Mapper — Maps various financial concepts and transaction categories to the appropriate
Asset, Liability, Equity, Income, or Expense account structures.
"""

from typing import Dict, Any, Tuple

ACCOUNT_TYPE_MAP: Dict[str, Tuple[str, str]] = {
    # Account Code: (Account Type, Account Sub-type)
    "1000": ("asset", "current_asset"),       # Cash in Hand
    "1010": ("asset", "current_asset"),       # Bank Accounts
    "1100": ("asset", "current_asset"),       # Accounts Receivable
    "1200": ("asset", "current_asset"),       # GST Input Credit
    "1300": ("asset", "fixed_asset"),          # Fixed Assets
    "2000": ("liability", "current_liability"),# Accounts Payable
    "2100": ("liability", "current_liability"),# GST Output Payable
    "2200": ("liability", "current_liability"),# TDS Payable
    "3000": ("equity", "equity"),             # Owner's Capital / Equity
    "3100": ("equity", "equity"),             # Retained Earnings
    "4000": ("income", "operating_income"),   # Sales / Fee Income
    "4100": ("income", "other_income"),       # Other Income
    "5000": ("expense", "cost_of_service"),    # Purchases
    "5100": ("expense", "operating_expense"),  # Salaries & Wages
    "5200": ("expense", "operating_expense"),  # Rent Expense
    "5250": ("expense", "operating_expense"),  # Software & Cloud Expenses
    "5300": ("expense", "operating_expense"),  # Office & Admin Expenses
    "5400": ("expense", "operating_expense"),  # Bank Charges
    "5500": ("expense", "operating_expense"),  # Shipping & Freight
    "5600": ("expense", "operating_expense"),  # Travel & Conveyance
    "5700": ("expense", "operating_expense"),  # Foreign Exchange Loss / Gain
    "5900": ("expense", "operating_expense"),  # Round Off
    "1250": ("asset", "current_asset"),                   # TDS Receivable / Advance Tax
    "1310": ("asset", "accumulated_depreciation"),        # Accumulated Depreciation
    "1350": ("asset", "intangible_asset"),                # Intangible Assets (Software)
    "1400": ("asset", "inventory"),                       # Inventory / Stock-in-Trade
    "1500": ("asset", "prepaid"),                         # Prepaid Expenses
    "1600": ("asset", "deferred_tax_asset"),              # Deferred Tax Asset
    "2300": ("liability", "current_liability"),           # Accrued Expenses
    "2400": ("liability", "provision"),                   # Provisions
    "2500": ("liability", "deferred_tax_liability"),      # Deferred Tax Liability
    "2600": ("liability", "current_liability"),           # Provision for Income Tax
    "2700": ("liability", "long_term_liability"),         # Long-term Loans & Borrowings
    "5010": ("expense", "direct_expense"),                # Direct Expenses
    "5020": ("expense", "cost_of_service"),               # Cost of Goods Sold
    "5450": ("expense", "finance_cost"),                  # Interest & Finance Charges
    "5800": ("expense", "depreciation"),                  # Depreciation Expense
    "5950": ("expense", "tax_expense"),                   # Income Tax Expense
    "5960": ("expense", "tax_expense"),                   # Deferred Tax Expense / (Credit)
}

def get_account_classification(code: str) -> Tuple[str, str]:
    """Returns (account_type, account_sub_type) for the given ledger code.
    Defaults to expense / operating_expense if not in the default schema.
    """
    clean_code = str(code).strip()
    return ACCOUNT_TYPE_MAP.get(clean_code, ("expense", "operating_expense"))
