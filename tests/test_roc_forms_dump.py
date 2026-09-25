from backend.roc_forms_dump import (
    _classify,
    _extract_financial,
    _extract_share_transfer,
    _form_number,
)


def test_form_number_accepts_generic_mca_forms():
    assert _form_number("Form_123.pdf", "FORM NO. MGT-123") == ("MGT-123", "MGT", 123)
    assert _form_number("old_form.pdf", "FORM NO. 10") == ("FORM-10", "FORM", 10)


def test_classifier_separates_director_change_transfer_and_loans():
    assert _classify("DIR-12", "Particulars of appointment and cessation of directors") == "director_change"
    assert _classify("SH-4", "Securities Transfer Form Transferor Transferee") == "share_transfer"
    assert _classify("DPT-3", "Amount of outstanding loan and deposits") == "loan_deposit"


def test_share_transfer_parser_requires_transfer_parties_and_quantity():
    text = """
    Name of the Transferor
    ALPHA PRIVATE LIMITED
    Name of the Transferee
    BETA PRIVATE LIMITED
    Number of securities transferred 1250
    Consideration received 250000
    Certificate No. 17
    Date of execution 15/06/2025
    """
    transfer = _extract_share_transfer(text)
    assert transfer["transferor_name"] == "ALPHA PRIVATE LIMITED"
    assert transfer["transferee_name"] == "BETA PRIVATE LIMITED"
    assert transfer["number_of_shares"] == 1250
    assert transfer["consideration"] == 250000


def test_financial_parser_extracts_net_worth_and_turnover():
    text = "Net worth of the company 12500000\nTurnover 85000000\nProfit before tax 1200000"
    financial = _extract_financial(text)
    assert financial["net_worth"] == 12500000
    assert financial["turnover"] == 85000000
    assert financial["profit_before_tax"] == 1200000
