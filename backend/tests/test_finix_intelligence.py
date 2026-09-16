import pytest

from backend.accounting_ai.finix_intelligence import FinixIntelligence


def test_purchase_from_lakh_amount():
    result = FinixIntelligence.interpret("Bought office furniture from ABC Traders for 1.25 lakh")
    assert result["event"] == "PURCHASE"
    assert result["amount"] == 125000.00
    assert result["party_name"].startswith("ABC Traders")
    assert not result["success"] or result["needs_clarification"] == []


def test_customer_receipt_is_detected():
    result = FinixIntelligence.interpret("Received 50,000 from customer Sunrise Foods")
    assert result["event"] == "RECEIPT"
    assert result["amount"] == 50000.00
    assert result["party_name"]


def test_unknown_transaction_requests_clarification():
    result = FinixIntelligence.interpret("Please account for this transaction")
    assert result["event"] == "JOURNAL"
    assert result["needs_clarification"]
    assert result["confidence"] < 0.75


def test_confidence_bands():
    assert FinixIntelligence.confidence_band(0.95) == "AUTO"
    assert FinixIntelligence.confidence_band(0.80) == "SUGGEST"
    assert FinixIntelligence.confidence_band(0.60) == "REVIEW"
