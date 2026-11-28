"""Bank lines are posted automatically only to ONE invoice that matches on amount AND party/number.

Real case: five Rs 7,300 invoices to five different Good Solar / GC Sun LLPs on the same day.
"""
from backend.bank_accounts import _pick_document

INVOICES = [
    {"id": n, "client_name": name, "invoice_no": no, "amount_due": 7300.0}
    for n, name, no in [
        ("a", "GOOD URJAVIKAS LLP", "INV/26-27/084"), ("b", "GOOD SUNPOWER LLP", "INV/26-27/083"),
        ("c", "GOOD SOLARGRID LLP", "INV/26-27/082"), ("d", "GOOD SOLAR INFRA LLP", "INV/26-27/081"),
        ("e", "GC SUN INFRA LLP", "INV/26-27/080"),
    ]
] + [{"id": "big", "client_name": "AAS TECH PRIVATE LIMITED", "invoice_no": "INV/26-27/086", "amount_due": 184813.0}]


def pick(amount, desc):
    doc, why = _pick_document(amount, desc, INVOICES, lambda c: c["amount_due"],
                              lambda c: c["client_name"], lambda c: c["invoice_no"])
    return (doc or {}).get("id"), why


def test_names_the_party_and_amount_matches_posts_to_that_invoice_only():
    assert pick(7300, "NEFT/AXIS/GOOD SOLAR INFRA LLP/PAYMENT") == ("d", "auto")
    assert pick(7300, "IMPS-GC SUN INFRA LLP-UTR998") == ("e", "auto")
    assert pick(7300, "RTGS INV2627083 GOOD SUNPOWER") == ("b", "auto")


def test_amount_only_is_a_suggestion_never_a_posting():
    doc, why = pick(7300, "NEFT/UTR 1234567")
    assert why == "amount_only"


def test_short_or_part_payment_is_a_suggestion():
    assert pick(183000, "NEFT AAS TECH PVT LTD") == ("big", "short_payment")       # within 1%
    assert pick(100000, "NEFT AAS TECH PVT LTD") == ("big", "part_payment")        # clearly part
    assert pick(183000, "NEFT 8888") == ("big", "amount_only")


def test_generic_words_do_not_count_as_naming_the_party():
    # "GOOD" alone is shared by four clients; "LLP" is generic: not enough to post.
    assert pick(7300, "NEFT GOOD LLP")[1] == "amount_only"


def test_nothing_close_returns_nothing():
    assert pick(51, "ATM") == (None, None)
