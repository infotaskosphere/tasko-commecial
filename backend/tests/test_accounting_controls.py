from datetime import date
from decimal import Decimal
import pytest

from backend.accounting_ai.accounting_controls import (
    AccountingControlError,
    normalize_document_type,
    require_document_type,
    parse_accounting_date,
    validate_balanced_lines,
)


def test_unknown_document_type_never_defaults_to_purchase():
    assert normalize_document_type(None) == "UNCLASSIFIED"
    assert normalize_document_type("something_unknown") == "UNCLASSIFIED"
    with pytest.raises(AccountingControlError):
        require_document_type("something_unknown")


def test_supported_document_type_is_normalized():
    assert require_document_type("purchase-return") == "PURCHASE_RETURN"
    assert require_document_type("sale") == "SALE"


def test_accounting_date_is_strictly_parsed():
    assert parse_accounting_date("2026-09-15") == date(2026, 9, 15)
    with pytest.raises(AccountingControlError):
        parse_accounting_date("")


def test_balanced_lines_reject_invalid_shapes():
    with pytest.raises(AccountingControlError):
        validate_balanced_lines([])
    with pytest.raises(AccountingControlError):
        validate_balanced_lines([{"account_id": "a", "debit": -1, "credit": 0}])
    with pytest.raises(AccountingControlError):
        validate_balanced_lines([{"account_id": "a", "debit": 10, "credit": 10}])


def test_balanced_lines_require_exact_paise_balance_by_default():
    with pytest.raises(AccountingControlError):
        validate_balanced_lines([
            {"account_id": "a", "debit": "100.005", "credit": 0},
            {"account_id": "b", "debit": 0, "credit": "100.00"},
        ])


def test_balanced_lines_return_exact_paise_totals():
    debit, credit = validate_balanced_lines([
        {"account_id": "a", "debit": "100.005", "credit": 0},
        {"account_id": "b", "debit": 0, "credit": "100.01"},
    ])
    assert debit == Decimal("100.01")
    assert credit == Decimal("100.01")


def test_explicit_tolerance_must_be_opted_in():
    debit, credit = validate_balanced_lines([
        {"account_id": "a", "debit": "100.01", "credit": 0},
        {"account_id": "b", "debit": 0, "credit": "100.00"},
    ], tolerance=Decimal("0.01"))
    assert debit == Decimal("100.01")
    assert credit == Decimal("100.00")
