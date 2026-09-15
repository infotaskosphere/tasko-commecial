"""Unified policy layer for Finix accounting decisions.

This module provides deterministic routing for common Tally-style accounting
substance: inventory, fixed assets, advances, prepaids, accruals, provisions,
returns, notes and banking. It intentionally returns REVIEW_REQUIRED whenever
available evidence is insufficient.
"""

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict

PAISE = Decimal("0.01")

TRANSACTION_POLICIES = {
    "PURCHASE": {"substance": "expense_or_inventory", "requires_party": True},
    "SALE": {"substance": "revenue", "requires_party": True},
    "EXPENSE": {"substance": "expense", "requires_party": True},
    "FIXED_ASSET": {"substance": "fixed_asset", "requires_party": True},
    "PREPAID_EXPENSE": {"substance": "prepaid", "requires_party": True},
    "ACCRUAL": {"substance": "accrual", "requires_party": False},
    "PROVISION": {"substance": "provision", "requires_party": False},
    "ADVANCE_PAYMENT": {"substance": "advance_supplier", "requires_party": True},
    "ADVANCE_RECEIPT": {"substance": "advance_customer", "requires_party": True},
    "PURCHASE_RETURN": {"substance": "purchase_return", "requires_party": True},
    "SALE_RETURN": {"substance": "sale_return", "requires_party": True},
    "DEBIT_NOTE": {"substance": "debit_note", "requires_party": True},
    "CREDIT_NOTE": {"substance": "credit_note", "requires_party": True},
    "PAYMENT": {"substance": "payment", "requires_party": True},
    "RECEIPT": {"substance": "receipt", "requires_party": True},
    "CONTRA": {"substance": "contra", "requires_party": False},
    "BANK_CHARGE": {"substance": "bank_charge", "requires_party": False},
    "BANK_TRANSFER": {"substance": "bank_transfer", "requires_party": False},
    "STOCK_JOURNAL": {"substance": "stock_movement", "requires_party": False},
    "INVENTORY_ADJUSTMENT": {"substance": "inventory_adjustment", "requires_party": False},
    "DEPRECIATION": {"substance": "depreciation", "requires_party": False},
    "LOAN_RECEIPT": {"substance": "loan_receipt", "requires_party": True},
    "LOAN_REPAYMENT": {"substance": "loan_repayment", "requires_party": True},
    "INTEREST": {"substance": "interest", "requires_party": True},
    "GST_PAYMENT": {"substance": "gst_payment", "requires_party": False},
    "TDS_PAYMENT": {"substance": "tds_payment", "requires_party": False},
}


def _amount(value: Any) -> Decimal:
    return Decimal(str(value or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)


def classify_transaction(document_type: str, data: Dict[str, Any]) -> Dict[str, Any]:
    event = str(document_type or "").strip().upper().replace("-", "_").replace(" ", "_")
    policy = TRANSACTION_POLICIES.get(event)
    if not policy:
        return {"status": "REVIEW_REQUIRED", "reason": "Transaction type is not supported by the accounting policy engine."}
    if policy["requires_party"] and not str(data.get("vendor_or_customer_name") or "").strip():
        return {"status": "REVIEW_REQUIRED", "reason": "Party identity is required for this transaction type."}
    amount = _amount(data.get("total_invoice_value", data.get("amount", 0)))
    if amount <= 0:
        return {"status": "REVIEW_REQUIRED", "reason": "A positive accounting amount is required."}
    if event in {"FIXED_ASSET", "PREPAID_EXPENSE", "ADVANCE_PAYMENT", "ADVANCE_RECEIPT", "ACCRUAL", "PROVISION"}:
        if not data.get("accounting_substance_confirmed"):
            return {"status": "REVIEW_REQUIRED", "reason": f"{policy['substance']} treatment requires explicit accounting-substance confirmation."}
    return {"status": "READY", "event": event, "substance": policy["substance"], "amount": float(amount)}
