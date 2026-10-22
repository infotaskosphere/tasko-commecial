"""How every ledger account is classified — one place, used by seeding, reports and purchase posting.

Each chart-of-accounts row carries:

  statement   where it appears:  "balance_sheet" | "trading" | "profit_and_loss"
  nature      "capital"  = long-term / ownership items (fixed assets, equity, long-term loans, capital receipts)
              "revenue"  = day-to-day items (sales, expenses, current assets and liabilities)
              Spending on a capital item never reaches the profit and loss account directly; it is carried on the
              balance sheet and written off through depreciation. Spending on a revenue item is charged to profit.
  head        the Companies Act Schedule III heading the balance resolves to
  cost_type   "direct" (trading account: purchases, direct costs) | "indirect" | None
  is_contra   True for accounts that reduce another (accumulated depreciation)

Known system codes are listed explicitly. Anything else (a ledger the firm added itself) is derived from its type,
sub-type and name, so a custom "Interest on Term Loan" or "Office Furniture" still lands in the right place.
"""
from __future__ import annotations

import re
from typing import Dict, Optional

BS, TR, PL = "balance_sheet", "trading", "profit_and_loss"
CAPITAL, REVENUE = "capital", "revenue"

# Schedule III headings used below
H_PPE = "Property, plant and equipment"
H_INTANGIBLE = "Intangible assets"
H_INVENTORIES = "Inventories"
H_RECEIVABLES = "Trade receivables"
H_CASH = "Cash and cash equivalents"
H_LOANS_ADV = "Short-term loans and advances"
H_OTHER_CA = "Other current assets"
H_DTA = "Deferred tax assets (net)"
H_PAYABLES = "Trade payables"
H_OTHER_CL = "Other current liabilities"
H_ST_PROV = "Short-term provisions"
H_LT_BORROW = "Long-term borrowings"
H_DTL = "Deferred tax liabilities (net)"
H_CAPITAL = "Share capital / owner's capital"
H_RESERVES = "Reserves and surplus"
H_REVENUE = "Revenue from operations"
H_OTHER_INC = "Other income"
H_PURCHASES = "Purchases of stock-in-trade / cost of services"
H_EMPLOYEE = "Employee benefit expense"
H_FINANCE = "Finance costs"
H_DEPN = "Depreciation and amortisation expense"
H_TAX = "Tax expense"
H_OTHER_EXP = "Other expenses"

# code: (statement, nature, head, cost_type, is_contra)
_KNOWN: Dict[str, tuple] = {
    "1000": (BS, REVENUE, H_CASH, None, False),
    "1010": (BS, REVENUE, H_CASH, None, False),
    "1100": (BS, REVENUE, H_RECEIVABLES, None, False),
    "1150": (BS, REVENUE, H_RECEIVABLES, None, True),
    "1200": (BS, REVENUE, H_LOANS_ADV, None, False),
    "1250": (BS, REVENUE, H_LOANS_ADV, None, False),
    "1300": (BS, CAPITAL, H_PPE, None, False),
    "1310": (BS, CAPITAL, H_PPE, None, True),
    "1350": (BS, CAPITAL, H_INTANGIBLE, None, False),
    "1400": (BS, REVENUE, H_INVENTORIES, None, False),
    "1500": (BS, REVENUE, H_OTHER_CA, None, False),
    "1550": (BS, REVENUE, H_OTHER_CA, None, False),
    "1600": (BS, CAPITAL, H_DTA, None, False),
    "2000": (BS, REVENUE, H_PAYABLES, None, False),
    "2100": (BS, REVENUE, H_OTHER_CL, None, False),
    "2200": (BS, REVENUE, H_OTHER_CL, None, False),
    "2300": (BS, REVENUE, H_OTHER_CL, None, False),
    "2350": (BS, REVENUE, H_OTHER_CL, None, False),
    "2400": (BS, REVENUE, H_ST_PROV, None, False),
    "2500": (BS, CAPITAL, H_DTL, None, False),
    "2600": (BS, REVENUE, H_ST_PROV, None, False),
    "2700": (BS, CAPITAL, H_LT_BORROW, None, False),
    "3000": (BS, CAPITAL, H_CAPITAL, None, False),
    "3100": (BS, CAPITAL, H_RESERVES, None, False),
    "4000": (TR, REVENUE, H_REVENUE, "direct", False),
    "4100": (PL, REVENUE, H_OTHER_INC, "indirect", False),
    "5000": (TR, REVENUE, H_PURCHASES, "direct", False),
    "5010": (TR, REVENUE, H_PURCHASES, "direct", False),
    "5020": (TR, REVENUE, H_PURCHASES, "direct", False),
    "5100": (PL, REVENUE, H_EMPLOYEE, "indirect", False),
    "5200": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5250": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5300": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5400": (PL, REVENUE, H_FINANCE, "indirect", False),
    "5450": (PL, REVENUE, H_FINANCE, "indirect", False),
    "5500": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5600": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5700": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5800": (PL, REVENUE, H_DEPN, "indirect", False),
    "5900": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5950": (PL, REVENUE, H_TAX, "indirect", False),
    "5970": (PL, REVENUE, H_OTHER_EXP, "indirect", False),
    "5960": (PL, REVENUE, H_TAX, "indirect", False),
    "9998": (BS, REVENUE, H_OTHER_CA, None, False),
}

def _has(text: str, *words: str) -> bool:
    return any(re.search(rf"\b{w}", text) for w in words)


def classify(code: str, typ: str, sub_type: str = "", name: str = "") -> Dict[str, object]:
    """Classification for one account. Known system codes are exact; anything else is derived."""
    code = str(code or "").strip()
    typ = str(typ or "").strip().lower()
    sub = str(sub_type or "").strip().lower()
    text = f"{str(name or '').lower()} {sub}"
    known = _KNOWN.get(code)
    if known:
        st, nat, head, cost, contra = known
        return {"statement": st, "nature": nat, "schedule3_head": head, "cost_type": cost, "is_contra": contra}

    contra = False
    cost: Optional[str] = None
    if typ == "asset":
        st = BS
        contra = _has(text, "accumulated depreciation", "accumulated amortisation", "accumulated amortization") or sub == "accumulated_depreciation"
        if sub in ("fixed_asset", "accumulated_depreciation") or _has(text, "furniture", "machinery", "vehicle", "equipment", "building", "computer", "plant", "land"):
            nat, head = CAPITAL, H_PPE
        elif sub == "intangible_asset" or _has(text, "software", "goodwill", "licen[cs]e", "patent", "trademark"):
            nat, head = CAPITAL, H_INTANGIBLE
        elif sub == "deferred_tax_asset" or _has(text, "deferred tax"):
            nat, head = CAPITAL, H_DTA
        elif sub == "inventory" or _has(text, "inventory", "stock", "closing stock"):
            nat, head = REVENUE, H_INVENTORIES
        elif _has(text, "cash", "bank"):
            nat, head = REVENUE, H_CASH
        elif _has(text, "receivable", "debtor"):
            nat, head = REVENUE, H_RECEIVABLES
        elif _has(text, "advance", "deposit", "gst", "tds", "tax", "loan"):
            nat, head = REVENUE, H_LOANS_ADV
        else:
            nat, head = REVENUE, H_OTHER_CA
    elif typ == "liability":
        st = BS
        if sub == "deferred_tax_liability" or _has(text, "deferred tax"):
            nat, head = CAPITAL, H_DTL
        elif sub in ("long_term_liability", "long_term") or _has(text, "term loan", "debenture", "long.term", "borrowing"):
            nat, head = CAPITAL, H_LT_BORROW
        elif sub == "provision" or _has(text, "provision"):
            nat, head = REVENUE, H_ST_PROV
        elif _has(text, "payable", "creditor") and not _has(text, "gst", "tds", "tax", "salary", "expense"):
            nat, head = REVENUE, H_PAYABLES
        else:
            nat, head = REVENUE, H_OTHER_CL
    elif typ == "equity":
        st, nat = BS, CAPITAL
        head = H_RESERVES if _has(text, "reserve", "surplus", "retained", "profit") else H_CAPITAL
    elif typ == "income":
        if sub == "other_income" or _has(text, "interest income", "other income", "discount received", "gain"):
            st, nat, head, cost = PL, REVENUE, H_OTHER_INC, "indirect"
        else:
            st, nat, head, cost = TR, REVENUE, H_REVENUE, "direct"
    else:  # expense
        nat = REVENUE
        if sub in ("cost_of_service", "direct_expense") or _has(text, "purchase", "cost of goods", "direct expense", "freight inward", "carriage inward", "wages direct"):
            st, head, cost = TR, H_PURCHASES, "direct"
        elif sub == "depreciation" or _has(text, "depreciation", "amortisation", "amortization"):
            st, head, cost = PL, H_DEPN, "indirect"
        elif sub == "finance_cost" or _has(text, "interest", "finance", "bank charge", "loan processing"):
            st, head, cost = PL, H_FINANCE, "indirect"
        elif sub == "tax_expense" or _has(text, "income tax", "deferred tax", "tax expense"):
            st, head, cost = PL, H_TAX, "indirect"
        elif _has(text, "salar", "wage", "bonus", "staff", "pf contribution", "esi", "gratuity"):
            st, head, cost = PL, H_EMPLOYEE, "indirect"
        else:
            st, head, cost = PL, H_OTHER_EXP, "indirect"
    return {"statement": st, "nature": nat, "schedule3_head": head, "cost_type": cost, "is_contra": contra}


def classify_account(acct: dict) -> Dict[str, object]:
    return classify(acct.get("code"), acct.get("type"), acct.get("sub_type"), acct.get("name"))


# ── Capital or revenue? (purchase side) ─────────────────────────────────────────────────────────────
# Spending on something that will serve the business for more than a year and is not consumed in the ordinary
# course is capital expenditure. The check below only SUGGESTS; the person reviewing the bill decides.
_CAPITAL_ITEMS = [
    (r"\b(laptop|desktop|computer|server|workstation|macbook|imac|monitor|printer|scanner|router|ups\b|cctv|projector)", "Computers and IT equipment", "computers", 0.40),
    (r"\b(furniture|chair|table|desk|cabinet|almirah|sofa|workstation furniture|partition)", "Furniture and fittings", "furniture", 0.10),
    (r"\b(air\s*condition|a\.?c\.?\b|refrigerator|water\s*purifier|generator|inverter|fan\b|equipment|machine|machinery|plant\b|tool kit|drill|lathe)", "Plant and machinery", "plant_machinery", 0.15),
    (r"\b(car\b|motor\s*car|scooter|motorcycle|bike|vehicle|truck|tempo)", "Vehicles", "vehicles", 0.15),
    (r"\b(building|office\s*premises|renovation|interiors|civil work|land\b|property\b)", "Buildings and civil work", "buildings", 0.10),
    (r"\b(perpetual\s+licen[cs]e|software\s+licen[cs]e|erp\s+implementation|website development|app development)", "Computer software", "software", 0.40),
    (r"\b(trademark|patent|goodwill|copyright|know.how)", "Other intangibles", "intangibles", 0.25),
]
_REVENUE_ITEMS = r"\b(repair|maintenance|amc\b|subscription|rent\b|renewal|stationery|consumable|recharge|courier|postage|refreshment|fuel|petrol|diesel|insurance|audit fee|professional fee|legal fee|training|advertis|commission|cleaning|electricity|internet|telephone|mobile bill|cloud|hosting|saas)"


def suggest_capital(description: str, amount: float, threshold: float = 5000.0, vendor: str = "") -> dict:
    """{'capital': bool, 'confidence': 'high'|'medium'|'low', 'category', 'block', 'it_rate', 'reason'}."""
    text = f"{description or ''} {vendor or ''}".lower()
    amt = float(amount or 0)
    if re.search(_REVENUE_ITEMS, text):
        return {"capital": False, "confidence": "high", "category": "", "block": "", "it_rate": 0.0,
                "reason": "Looks like a running cost (repairs, rent, subscriptions and similar), so it is charged to profit."}
    for pat, cat, block, rate in _CAPITAL_ITEMS:
        if re.search(pat, text):
            if amt < threshold:
                return {"capital": False, "confidence": "medium", "category": cat, "block": block, "it_rate": rate,
                        "reason": f"{cat}, but under the Rs {threshold:,.0f} capitalisation limit, so it can be expensed."}
            return {"capital": True, "confidence": "high", "category": cat, "block": block, "it_rate": rate,
                    "reason": f"{cat} costing Rs {amt:,.0f} will last more than a year, so it is capital expenditure and is written off through depreciation."}
    return {"capital": False, "confidence": "low", "category": "", "block": "", "it_rate": 0.0,
            "reason": "No sign this is a long-lived asset. Change it if the bill is for something that will be used for years."}


# Income Tax Act block rates (WDV method) for the register's categories; used for tax depreciation and deferred tax.
IT_BLOCK_RATES = {"computers": 0.40, "furniture": 0.10, "plant_machinery": 0.15, "vehicles": 0.15,
                  "buildings": 0.10, "software": 0.40, "intangibles": 0.25, "other": 0.15}
