"""Shared deterministic accounting controls for Finix.

This module contains validation primitives that must remain independent of the
AI/LLM layer. AI may propose an accounting treatment, but it is never allowed
to manufacture a transaction type or silently fall back to a different type.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Iterable


SUPPORTED_DOCUMENT_TYPES = frozenset(
    {
        "PURCHASE", "SALE", "EXPENSE", "PAYMENT", "RECEIPT", "CONTRA", "JOURNAL",
        "PURCHASE_RETURN", "SALE_RETURN", "DEBIT_NOTE", "CREDIT_NOTE",
        "ADVANCE_PAYMENT", "ADVANCE_RECEIPT", "RCM_PURCHASE", "FIXED_ASSET",
        "PREPAID_EXPENSE", "ACCRUAL", "PROVISION", "PAYROLL", "DEPRECIATION",
        "LOAN_RECEIPT", "LOAN_REPAYMENT", "INTEREST", "GST_PAYMENT", "TDS_PAYMENT",
        "STOCK_JOURNAL", "INVENTORY_ADJUSTMENT", "BANK_CHARGE", "BANK_TRANSFER",
    }
)


class AccountingControlError(ValueError):
    """Raised when deterministic accounting controls reject a posting."""


def normalize_document_type(value: Any) -> str:
    """Canonicalize a document type without guessing.

    Empty, null, or unsupported values become ``UNCLASSIFIED``. In particular,
    an unknown AI result must never silently become PURCHASE.
    """
    if value is None:
        return "UNCLASSIFIED"
    normalized = str(value).strip().upper().replace("-", "_").replace(" ", "_")
    return normalized if normalized in SUPPORTED_DOCUMENT_TYPES else "UNCLASSIFIED"


def require_document_type(value: Any) -> str:
    """Return a supported transaction type or fail closed for review."""
    document_type = normalize_document_type(value)
    if document_type == "UNCLASSIFIED":
        raise AccountingControlError(
            "Transaction type could not be determined with sufficient evidence; posting requires human review."
        )
    return document_type


def parse_accounting_date(value: Any) -> date:
    """Parse an ISO accounting date strictly as YYYY-MM-DD."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip()
    if not text:
        raise AccountingControlError("Accounting date is required; posting date cannot be guessed.")
    try:
        return date.fromisoformat(text[:10])
    except ValueError as exc:
        raise AccountingControlError(f"Invalid accounting date '{text}'. Expected YYYY-MM-DD.") from exc


def money(value: Any) -> Decimal:
    """Convert a numeric value to accounting precision (paise)."""
    try:
        amount = Decimal(str(value if value is not None else "0"))
    except (InvalidOperation, ValueError, TypeError) as exc:
        raise AccountingControlError(f"Invalid monetary value: {value!r}") from exc
    if not amount.is_finite():
        raise AccountingControlError("Monetary values must be finite numbers.")
    return amount.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def validate_balanced_lines(
    lines: Iterable[dict[str, Any]], tolerance: Decimal = Decimal("0.01")
) -> tuple[Decimal, Decimal]:
    """Validate journal line shape and return debit/credit totals."""
    line_list = list(lines)
    if not line_list:
        raise AccountingControlError("Journal entry must contain at least one line.")

    total_debit = Decimal("0.00")
    total_credit = Decimal("0.00")
    for index, line in enumerate(line_list, start=1):
        if not line.get("account_id"):
            raise AccountingControlError(f"Journal line {index} is missing account_id.")
        debit = money(line.get("debit", 0))
        credit = money(line.get("credit", 0))
        if debit < 0 or credit < 0:
            raise AccountingControlError(f"Journal line {index} contains a negative amount.")
        if debit > 0 and credit > 0:
            raise AccountingControlError(f"Journal line {index} cannot contain both debit and credit.")
        if debit == 0 and credit == 0:
            raise AccountingControlError(f"Journal line {index} has no debit or credit amount.")
        total_debit += debit
        total_credit += credit

    if total_debit <= 0 or total_credit <= 0:
        raise AccountingControlError("Journal entry must contain both debit and credit amounts.")
    if abs(total_debit - total_credit) > tolerance:
        raise AccountingControlError(
            f"Journal entry does not balance: debit {total_debit} != credit {total_credit}."
        )
    return total_debit, total_credit


def ensure_source_key(source: Any, source_id: Any) -> tuple[str, str | None]:
    """Normalize source metadata used for idempotent posting."""
    normalized_source = str(source or "manual").strip().lower()
    if not normalized_source:
        raise AccountingControlError("Posting source is required.")
    normalized_source_id = str(source_id).strip() if source_id is not None else None
    return normalized_source, normalized_source_id or None
