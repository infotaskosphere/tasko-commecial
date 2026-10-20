"""Data-integrity helpers shared by import/backup workflows.

The helpers in this module deliberately validate source values without silently
recalculating or overwriting them.  Import/restore callers can use these
functions before committing records to the database.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation
from typing import Any, Mapping


INVOICE_IMPORT_FIELDS = (
    "invoice_no",
    "type",
    "client",
    "date",
    "due_date",
    "taxable",
    "gst",
    "total",
    "paid",
    "balance",
    "status",
)


def decimal_value(value: Any) -> Decimal | None:
    """Convert an amount for validation only; never mutate the source value."""
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value).replace(",", "").strip())
    except (InvalidOperation, ValueError):
        return None


def validate_invoice_source(row: Mapping[str, Any], row_number: int) -> list[str]:
    """Return validation errors without changing any source fields.

    Amount relationships are checked, but source values are never replaced by
    calculated values. This prevents an importer from silently correcting a
    historical invoice during migration.
    """
    errors: list[str] = []

    if not str(row.get("invoice_no", "")).strip():
        errors.append(f"Row {row_number}: invoice number is empty")
    if not str(row.get("client", "")).strip():
        errors.append(f"Row {row_number}: client is empty")

    total = decimal_value(row.get("total"))
    paid = decimal_value(row.get("paid"))
    balance = decimal_value(row.get("balance"))
    if total is None:
        errors.append(f"Row {row_number}: total is not a valid amount")
    if paid is None:
        errors.append(f"Row {row_number}: paid is not a valid amount")
    if balance is None:
        errors.append(f"Row {row_number}: balance is not a valid amount")

    if total is not None and paid is not None and balance is not None:
        expected = total - paid
        if expected != balance:
            errors.append(
                f"Row {row_number}: balance mismatch; source={balance}, expected={expected}"
            )

    return errors


def source_snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    """Return a stable source snapshot for audit/round-trip comparison."""
    return {field: row.get(field) for field in INVOICE_IMPORT_FIELDS}
