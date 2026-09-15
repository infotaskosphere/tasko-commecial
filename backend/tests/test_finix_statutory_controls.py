from datetime import date

from backend.accounting_ai.gst_engine import GSTEngine
from backend.accounting_ai.tds_engine import TDSEngine


def test_gst_requires_jurisdiction_evidence():
    result = GSTEngine.determine_gst_split("", "", 1800)
    assert result["status"] == "REVIEW_REQUIRED"


def test_gst_inter_state_split_is_deterministic():
    result = GSTEngine.determine_gst_split("24AAAAA1111A1Z1", "27AAAAA1111A1Z1", 1800)
    assert result["status"] == "INTER_STATE"
    assert result["igst"] == 1800.0
    assert result["cgst"] == 0.0
    assert result["sgst"] == 0.0


def test_gst_intra_state_split_reconciles():
    result = GSTEngine.determine_gst_split("24AAAAA1111A1Z1", "24AAAAA1111A1Z1", 1800)
    assert result["status"] == "INTRA_STATE"
    assert result["cgst"] == 900.0
    assert result["sgst"] == 900.0


def test_tds_old_act_reference_before_transition():
    result = TDSEngine.evaluate_tds(
        account_code="5000",
        taxable_value=100000,
        transaction_date=date(2026, 3, 31),
        section="194C",
        pan_available=True,
    )
    assert result["applicable"] is True
    assert result["statutory_reference"] == "194C"
    assert result["deduction_amount"] == 1000.0


def test_tds_new_act_reference_after_transition():
    result = TDSEngine.evaluate_tds(
        account_code="5000",
        taxable_value=100000,
        transaction_date=date(2026, 4, 1),
        section="194C",
        pan_available=True,
    )
    assert result["applicable"] is True
    assert result["statutory_reference"].startswith("393(1)")
    assert result["deduction_amount"] == 1000.0


def test_tds_missing_pan_requires_review():
    result = TDSEngine.evaluate_tds(
        account_code="5000",
        taxable_value=100000,
        transaction_date=date(2026, 4, 1),
        section="194C",
        pan_available=False,
    )
    assert result["requires_review"] is True
    assert result["applicable"] is False
