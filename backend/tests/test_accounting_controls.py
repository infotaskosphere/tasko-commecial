from datetime import date
from decimal import Decimal
import pytest
from backend.accounting_ai.accounting_controls import AccountingControlError, normalize_document_type, require_document_type, parse_accounting_date, validate_balanced_lines
from backend.accounting_ai.gst_engine import GSTEngine
from backend.accounting_ai.tds_engine import TDSEngine
from backend.accounting_ai.accounting_policy import classify_transaction
from backend.accounting_ai.ledger_learning import LedgerLearningEngine


def test_unknown_document_type_fails_closed():
    assert normalize_document_type(None)=="UNCLASSIFIED"
    assert normalize_document_type("something_unknown")=="UNCLASSIFIED"
    with pytest.raises(AccountingControlError): require_document_type("something_unknown")

def test_supported_document_type_is_normalized():
    assert require_document_type("purchase-return")=="PURCHASE_RETURN"
    assert require_document_type("sale")=="SALE"

def test_accounting_date_is_strict():
    assert parse_accounting_date("2026-09-15")==date(2026,9,15)
    with pytest.raises(AccountingControlError): parse_accounting_date("")
    with pytest.raises(AccountingControlError): parse_accounting_date("2026-09-15T10:00:00")

def test_balanced_lines_are_exact_to_paise():
    with pytest.raises(AccountingControlError): validate_balanced_lines([])
    with pytest.raises(AccountingControlError): validate_balanced_lines([{"account_id":"a","debit":-1,"credit":0}])
    with pytest.raises(AccountingControlError): validate_balanced_lines([{"account_id":"a","debit":10,"credit":10}])
    debit,credit=validate_balanced_lines([{"account_id":"a","debit":"100.005","credit":0},{"account_id":"b","debit":0,"credit":"100.01"}])
    assert debit==Decimal("100.01") and credit==Decimal("100.01")

def test_gst_missing_jurisdiction_requires_review():
    result=GSTEngine.determine_gst_split("","",100)
    assert result["status"]=="REVIEW_REQUIRED"

def test_gst_intrastate_and_interstate_split():
    assert GSTEngine.determine_gst_split("24AAAAA1111A1Z1","24BBBBB2222B1Z2",180)["cgst"]==90
    assert GSTEngine.determine_gst_split("24AAAAA1111A1Z1","27BBBBB2222B1Z2",180)["igst"]==180

def test_gst_reconciliation_is_exact():
    assert GSTEngine.validate_gst_calculations(1000,90,90,0,180)[0]
    assert not GSTEngine.validate_gst_calculations(1000,90,89.99,0,180)[0]

def test_tds_requires_date_and_policy():
    result=TDSEngine.evaluate_tds("5250",60000,0,transaction_date=None)
    assert result["requires_review"]
    result=TDSEngine.evaluate_tds("5250",60000,0,transaction_date="2026-09-15",section="194J")
    assert result["applicable"] and result["deduction_amount"]>0

def test_accounting_substance_requires_confirmation():
    result=classify_transaction("FIXED_ASSET",{"vendor_or_customer_name":"Vendor","total_invoice_value":100000})
    assert result["status"]=="REVIEW_REQUIRED"

def test_ledger_learning_does_not_auto_recommend_one_off_history():
    assert LedgerLearningEngine.MIN_RECOMMENDATION_FREQUENCY==3
