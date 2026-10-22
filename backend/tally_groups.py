"""Tally's account groups, derived from the classification every account already carries.

Tally files every ledger under a group, and groups nest: Sundry Debtors sits under Current Assets, Reserves & Surplus
under Capital Account, and so on. The chart of accounts here is flat, so the group is worked out from the account's
classification (statement, Schedule III head, cost type) rather than stored a second time. That keeps the two views
from ever disagreeing: change an account's classification and its group follows.

``GROUPS`` is name -> (parent or None, side) where side is "asset", "liability", "income" or "expense".
"""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from backend.account_classification import (
    H_CAPITAL, H_CASH, H_DTA, H_DTL, H_EMPLOYEE, H_FINANCE, H_INTANGIBLE, H_INVENTORIES, H_LOANS_ADV, H_LT_BORROW,
    H_OTHER_CA, H_OTHER_CL, H_OTHER_EXP, H_OTHER_INC, H_PAYABLES, H_PPE, H_PURCHASES, H_RECEIVABLES, H_RESERVES,
    H_REVENUE, H_ST_PROV, classify_account,
)

GROUPS: Dict[str, Tuple[Optional[str], str]] = {
    # Liabilities
    "Capital Account": (None, "liability"),
    "Reserves & Surplus": ("Capital Account", "liability"),
    "Loans (Liability)": (None, "liability"),
    "Deferred Tax Liability": ("Loans (Liability)", "liability"),
    "Current Liabilities": (None, "liability"),
    "Duties & Taxes": ("Current Liabilities", "liability"),
    "Provisions": ("Current Liabilities", "liability"),
    "Sundry Creditors": ("Current Liabilities", "liability"),
    "Branch / Divisions": (None, "liability"),
    "Suspense A/c": (None, "asset"),
    # Assets
    "Fixed Assets": (None, "asset"),
    "Intangible Assets": ("Fixed Assets", "asset"),
    "Investments": (None, "asset"),
    "Current Assets": (None, "asset"),
    "Stock-in-hand": ("Current Assets", "asset"),
    "Sundry Debtors": ("Current Assets", "asset"),
    "Cash-in-hand": ("Current Assets", "asset"),
    "Bank Accounts": ("Current Assets", "asset"),
    "Loans & Advances (Asset)": ("Current Assets", "asset"),
    "Deferred Tax Asset": ("Current Assets", "asset"),
    "Misc. Expenses (Asset)": (None, "asset"),
    # Profit and loss
    "Sales Accounts": (None, "income"),
    "Direct Incomes": (None, "income"),
    "Indirect Incomes": (None, "income"),
    "Purchase Accounts": (None, "expense"),
    "Direct Expenses": (None, "expense"),
    "Indirect Expenses": (None, "expense"),
}

PRIMARY_ORDER = [
    "Capital Account", "Loans (Liability)", "Current Liabilities", "Branch / Divisions", "Suspense A/c",
    "Fixed Assets", "Investments", "Current Assets", "Misc. Expenses (Asset)",
    "Sales Accounts", "Direct Incomes", "Indirect Incomes", "Purchase Accounts", "Direct Expenses", "Indirect Expenses",
]


def group_of(account: dict) -> str:
    """The Tally group of one chart-of-accounts row."""
    code = str(account.get("code") or "")
    typ = str(account.get("type") or "").lower()
    cls = account.get("schedule3_head") and account or {**account, **classify_account(account)}
    head = cls.get("schedule3_head")
    cost = cls.get("cost_type")

    if code == "9998":
        return "Suspense A/c"
    if typ == "asset":
        if head in (H_PPE,):
            return "Fixed Assets"
        if head == H_INTANGIBLE:
            return "Intangible Assets"
        if head == H_INVENTORIES:
            return "Stock-in-hand"
        if head == H_RECEIVABLES:
            return "Sundry Debtors"
        if head == H_CASH:
            return "Cash-in-hand" if code == "1000" or "cash" in str(account.get("name") or "").lower() else "Bank Accounts"
        if head == H_LOANS_ADV:
            return "Loans & Advances (Asset)"
        if head == H_DTA:
            return "Deferred Tax Asset"
        return "Current Assets"
    if typ == "liability":
        if head == H_LT_BORROW:
            return "Loans (Liability)"
        if head == H_DTL:
            return "Deferred Tax Liability"
        if head == H_PAYABLES:
            return "Sundry Creditors"
        if head == H_ST_PROV:
            return "Provisions"
        if code in ("2100", "2200") or any(w in str(account.get("name") or "").lower() for w in ("gst", "tds", "tcs", "duties", "tax payable")):
            return "Duties & Taxes"
        return "Current Liabilities"
    if typ == "equity":
        return "Reserves & Surplus" if head == H_RESERVES else "Capital Account"
    if typ == "income":
        if head == H_REVENUE:
            return "Sales Accounts"
        return "Direct Incomes" if cost == "direct" else "Indirect Incomes"
    if typ == "expense":
        if head == H_PURCHASES and (code == "5000" or "purchase" in str(account.get("name") or "").lower()):
            return "Purchase Accounts"
        return "Direct Expenses" if cost == "direct" else "Indirect Expenses"
    return "Current Assets" if typ == "asset" else "Current Liabilities"


def ancestors(group: str) -> List[str]:
    """[group, parent, grandparent, ...] up to the primary group."""
    out = [group]
    while GROUPS.get(out[-1], (None, ""))[0]:
        out.append(GROUPS[out[-1]][0])
    return out


def side_of(group: str) -> str:
    return GROUPS.get(group, (None, "asset"))[1]
