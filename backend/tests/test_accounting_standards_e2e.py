"""End to end: the accounting-standards features through the API, under both AS and Ind AS."""
import pytest

pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

from backend.tests.e2e_env import headers, run, seed_company, swapped_database  # noqa: E402

CO = "std"
S = "/api/accounting-books/standards"


@pytest.fixture(scope="module")
def env():
    with swapped_database("acct_std") as e:
        seed_company(e[1], CO, "Standards Co")
        yield e


@pytest.fixture(scope="module")
def client(env):
    return TestClient(env[0], raise_server_exceptions=False)


def H(env, who="admin"):
    return headers(env[2], f"{CO}-{who}")


def call(client, env, method, path, who="admin", **kw):
    return getattr(client, method)(path, headers=H(env, who), **kw)


@pytest.fixture(scope="module")
def acct(client, env):
    return {a["code"]: a["id"] for a in call(client, env, "get", f"/api/chart-of-accounts?company_id={CO}").json()}


def framework(client, env, fw):
    r = call(client, env, "put", "/api/accounting-books/settings", json={"company_id": CO, "framework": fw})
    assert r.status_code == 200, r.text


def lines(env, entry_id):
    """Debit and credit totals per account for one entry (an account can appear on several lines)."""
    out = {}
    for l in run(env[1].journal_lines.find({"entry_id": entry_id}).to_list(50)):
        t = out.setdefault(l["account_id"], {"debit": 0.0, "credit": 0.0})
        t["debit"] = round(t["debit"] + l["debit"], 2)
        t["credit"] = round(t["credit"] + l["credit"], 2)
    return out


def balance(env, account_id, upto="2099-12-31"):
    rows = run(env[1].journal_lines.find({"account_id": account_id, "entry_date": {"$lte": upto}}).to_list(5000))
    return round(sum(r["debit"] - r["credit"] for r in rows), 2)


def test_every_standards_endpoint_denies_a_user_without_access(client, env):
    for method, path, body in [("post", f"{S}/fx/items", {"company_id": CO, "kind": "receivable", "currency": "USD", "fc_amount": 1, "booked_rate": 80, "date": "2026-06-01"}),
                               ("post", f"{S}/provisions", {"company_id": CO, "description": "x claim", "probability": "probable", "amount": 1, "as_of": "2026-06-01"}),
                               ("post", f"{S}/leases", {"company_id": CO, "lessor": "Ab", "asset": "Cd", "start_date": "2026-04-01", "periods": 24, "payment": 1}),
                               ("put", f"{S}/receivables/matrix", {"company_id": CO, "rates": [0, 0, 0, 0, 0, 0]}),
                               ("get", f"{S}/eps?company_id={CO}", None), ("get", f"/api/accounting-books/notes?company_id={CO}", None)]:
        r = call(client, env, method, path, who="viewer", **({"json": body} if body else {}))
        assert r.status_code == 403, (path, r.status_code)


def test_the_catalog_names_the_standard_for_the_framework_in_force(client, env):
    framework(client, env, "AS")
    c = call(client, env, "get", f"{S}/catalog?company_id={CO}").json()
    assert c["framework"] == "AS" and c["standards"]["fx"].startswith("AS 11") and c["standards"]["provisions"].startswith("AS 29")
    framework(client, env, "IND_AS")
    assert call(client, env, "get", f"{S}/catalog?company_id={CO}").json()["standards"]["leases"].startswith("Ind AS 116")
    framework(client, env, "AS")


# ── AS 11 / Ind AS 21 ──
def test_foreign_currency_items_are_restated_at_the_closing_rate_and_reverse_next_day(client, env, acct):
    for body in ({"kind": "receivable", "party": "Acme Inc", "currency": "usd", "fc_amount": 1000, "booked_rate": 80, "date": "2026-06-01"},
                 {"kind": "payable", "party": "Globex", "currency": "USD", "fc_amount": 400, "booked_rate": 80, "date": "2026-06-10"}):
        assert call(client, env, "post", f"{S}/fx/items", json={"company_id": CO, **body}).status_code == 200
    base = {"company_id": CO, "as_of": "2026-09-30"}
    assert call(client, env, "post", f"{S}/fx/revalue", json={**base, "rates": {}}).status_code == 400            # a rate is needed
    dry = call(client, env, "post", f"{S}/fx/revalue", json={**base, "rates": {"USD": 83}, "dry_run": True}).json()
    assert dry["posted"] is False and dry["assets_difference"] == 3000 and dry["liabilities_difference"] == -1200 and dry["net_gain_loss"] == 1800
    r = call(client, env, "post", f"{S}/fx/revalue", json={**base, "rates": {"USD": 83}})
    assert r.status_code == 200 and r.json()["posted"], r.text
    run_doc = run(env[1].fx_revaluations.find_one({"id": r.json()["id"]}))
    first = lines(env, run_doc["entry_id"])
    assert first[acct["1560"]]["debit"] == 3000 and first[acct["2360"]]["credit"] == 1200 and first[acct["5700"]]["debit"] == 1200 and first[acct["5700"]]["credit"] == 3000
    rev = lines(env, run_doc["reversal_entry_id"])
    assert rev[acct["1560"]]["credit"] == 3000 and rev[acct["2360"]]["debit"] == 1200
    assert balance(env, acct["5700"], "2026-09-30") == -1800 and balance(env, acct["5700"], "2026-10-01") == 0          # gain at the date, gone next day
    assert call(client, env, "post", f"{S}/fx/revalue", json={**base, "rates": {"USD": 84}}).status_code == 409
    assert call(client, env, "post", f"{S}/fx/revaluations/{r.json()['id']}/cancel?company_id={CO}").json()["cancelled"] is True
    assert balance(env, acct["1560"]) == 0 and balance(env, acct["2360"]) == 0


# ── AS 29 / Ind AS 37 ──
def test_provisions_are_recognised_disclosed_or_ignored_by_probability(client, env, acct):
    base = {"company_id": CO, "category": "litigation", "as_of": "2026-07-01"}
    p = call(client, env, "post", f"{S}/provisions", json={**base, "description": "Customer damages claim", "probability": "probable", "amount": 50000}).json()
    assert p["treatment"] == "recognise" and p["recognised"] == 50000 and p["voucher_no"].startswith("JV/26-27/")
    assert balance(env, acct["2400"]) == -50000 and balance(env, acct["5980"]) == 50000
    c = call(client, env, "post", f"{S}/provisions", json={**base, "description": "Tax dispute pending appeal", "probability": "possible", "amount": 200000, "category": "tax_dispute"}).json()
    assert c["treatment"] == "disclose" and c["recognised"] == 0 and balance(env, acct["2400"]) == -50000                    # nothing booked
    r = call(client, env, "post", f"{S}/provisions", json={**base, "description": "Remote claim", "probability": "remote", "amount": 9}).json()
    assert r["treatment"] == "ignore"
    pytest.prov, pytest.contingent = p["id"], c["id"]


def test_reassessing_posts_only_the_change_and_a_settlement_uses_up_the_provision(client, env, acct):
    up = call(client, env, "put", f"{S}/provisions/{pytest.contingent}/reassess", json={"company_id": CO, "as_of": "2026-08-01", "probability": "probable", "amount": 120000}).json()
    assert up["treatment"] == "recognise" and up["recognised"] == 120000 and balance(env, acct["2400"]) == -170000
    down = call(client, env, "put", f"{S}/provisions/{pytest.contingent}/reassess", json={"company_id": CO, "as_of": "2026-08-15", "amount": 100000}).json()
    assert down["recognised"] == 100000 and balance(env, acct["2400"]) == -150000                                                # 20,000 written back
    s = call(client, env, "post", f"{S}/provisions/{pytest.prov}/settle", json={"company_id": CO, "date": "2026-09-01", "amount": 20000, "account_id": acct["1010"]})
    assert s.status_code == 200 and s.json()["remaining"] == 30000 and s.json()["voucher_no"].startswith("PAY/")             # cash left the bank
    assert call(client, env, "post", f"{S}/provisions/{pytest.prov}/settle", json={"company_id": CO, "date": "2026-09-02", "amount": 99999, "account_id": acct["1010"]}).status_code == 400
    # a later reassessment must not re-add what was already paid out
    again = call(client, env, "put", f"{S}/provisions/{pytest.prov}/reassess", json={"company_id": CO, "as_of": "2026-09-10", "amount": 50000}).json()
    assert again["recognised"] == 30000 and balance(env, acct["2400"]) == -130000
    gone = call(client, env, "put", f"{S}/provisions/{pytest.contingent}/reassess", json={"company_id": CO, "as_of": "2026-09-20", "probability": "possible"}).json()
    assert gone["treatment"] == "disclose" and gone["recognised"] == 0 and balance(env, acct["2400"]) == -30000


def test_the_provision_note_shows_movements_and_contingent_liabilities(client, env):
    d = call(client, env, "get", f"{S}/provisions/disclosure?company_id={CO}&fy=2026-27").json()
    by = {p["category"]: p for p in d["provisions"]}
    lit, tax = by["litigation"], by["tax_dispute"]
    assert (lit["additions"], lit["utilised"], lit["reversed"], lit["closing"]) == (50000, 20000, 0, 30000)
    assert (tax["additions"], tax["utilised"], tax["reversed"], tax["closing"]) == (120000, 0, 120000, 0)      # recognised, trimmed, then released
    assert [c["description"] for c in d["contingent_liabilities"]] == ["Tax dispute pending appeal"] and d["standard"].startswith("AS 29")


def test_under_ind_as_a_long_dated_provision_is_discounted(client, env, acct):
    framework(client, env, "IND_AS")
    p = call(client, env, "post", f"{S}/provisions", json={"company_id": CO, "description": "Site restoration obligation", "category": "onerous_contract", "probability": "probable",
                                                              "amount": 100000, "discount_rate_pct": 10, "expected_years": 2, "as_of": "2026-09-25"}).json()
    assert p["recognised"] == 82644.63 and p["standard"].startswith("Ind AS 37")
    framework(client, env, "AS")


# ── AS 18 / Ind AS 24 ──
def test_related_parties_and_their_disclosure(client, env):
    d = call(client, env, "post", f"{S}/related-parties", json={"company_id": CO, "name": "Mr A. Sharma", "relationship": "kmp", "pan": "abcde1234f"})
    assert d.status_code == 200 and d.json()["pan"] == "ABCDE1234F"
    assert call(client, env, "post", f"{S}/related-parties", json={"company_id": CO, "name": "mr a. sharma", "relationship": "kmp"}).status_code == 409
    sub = call(client, env, "post", f"{S}/related-parties", json={"company_id": CO, "name": "Sharma Exports Pvt Ltd", "relationship": "subsidiary"}).json()
    kmp = d.json()["id"]
    for body in ({"party_id": kmp, "date": "2026-05-31", "nature": "remuneration", "amount": 600000}, {"party_id": kmp, "date": "2026-08-31", "nature": "loan_taken", "amount": 100000, "outstanding": -100000},
                 {"party_id": sub["id"], "date": "2026-07-15", "nature": "sale", "amount": 250000, "outstanding": 80000}, {"party_id": sub["id"], "date": "2026-09-15", "nature": "sale", "amount": 50000, "outstanding": 30000}):
        assert call(client, env, "post", f"{S}/related-parties/transactions", json={"company_id": CO, **body}).status_code == 200
    out = call(client, env, "get", f"{S}/related-parties/disclosure?company_id={CO}&fy=2026-27").json()
    assert [g["label"] for g in out["groups"]] == ["Subsidiary", "Key management personnel"] and out["kmp_remuneration"] == 600000
    subs = out["groups"][0]["parties"][0]
    assert subs["transactions"][0]["amount"] == 300000 and subs["outstanding"] == 30000                                      # totals add, the latest balance stands
    assert call(client, env, "delete", f"{S}/related-parties/{kmp}?company_id={CO}").status_code == 409


# ── AS 20 / Ind AS 33 ──
def test_eps_needs_the_share_register_then_follows_profit_and_shares(client, env):
    assert call(client, env, "get", f"{S}/eps?company_id={CO}&fy=2026-27").status_code == 400
    for body in ({"date": "2026-04-01", "type": "opening", "shares": 100000, "face_value": 10}, {"date": "2026-10-01", "type": "issue", "shares": 20000},
                 {"date": "2026-06-01", "type": "potential", "instrument": "option", "shares": 10000, "exercise_price": 50, "note": "ESOP 2026"}):
        assert call(client, env, "post", f"{S}/share-capital/events", json={"company_id": CO, **body}).status_code == 200
    assert call(client, env, "post", f"{S}/share-capital/events", json={"company_id": CO, "date": "2026-10-01", "type": "bonus"}).status_code == 400
    r = call(client, env, "get", f"{S}/eps?company_id={CO}&fy=2026-27&average_market_price=100&preference_dividend=1000").json()
    assert r["weighted_average_shares"] == round(100000 + 20000 * 182 / 365, 2) and r["closing_shares"] == 120000
    assert r["earnings_for_equity"] == round(r["profit_after_tax"] - 1000, 2)
    assert r["basic_eps"] == round(r["earnings_for_equity"] / r["weighted_average_shares"], 2)
    assert r["share_capital_per_register"] == 1200000 and r["capital_matches"] is False                      # books hold no share capital yet
    if r["earnings_for_equity"] > 0:
        assert r["diluted_eps"] < r["basic_eps"] and r["instruments"][0]["included"] is True


# ── receivables ──
def test_receivable_provision_by_ageing_follows_the_framework_and_posts_the_difference(client, env, acct):
    run(env[1].invoices.insert_many([
        {"id": "r1", "company_id": CO, "invoice_no": "R-1", "invoice_date": "2026-01-01", "due_date": "2026-02-01", "status": "sent", "amount_due": 100000},
        {"id": "r2", "company_id": CO, "invoice_no": "R-2", "invoice_date": "2025-04-01", "due_date": "2025-05-01", "status": "overdue", "amount_due": 40000},
        {"id": "r3", "company_id": CO, "invoice_no": "R-3", "invoice_date": "2026-10-01", "due_date": "2026-10-31", "status": "sent", "amount_due": 500000},
        {"id": "r4", "company_id": CO, "invoice_no": "R-4", "invoice_date": "2026-01-01", "due_date": "2026-01-15", "status": "paid", "amount_due": 0},
        {"id": "r5", "company_id": CO, "invoice_no": "R-5", "invoice_date": "2026-01-01", "due_date": "2026-01-15", "status": "draft", "amount_due": 9999}]))
    p = call(client, env, "get", f"{S}/receivables/provision?company_id={CO}&as_of=2026-10-18").json()
    assert p["framework"] == "AS" and p["total_outstanding"] == 640000 and p["invoice_count"] == 3
    assert p["provision_required"] == 100000 * 0.25 + 40000 * 0.5 and p["change_needed"] == p["provision_required"]        # 100000 is 258 days over, 40000 is 535
    assert call(client, env, "put", f"{S}/receivables/matrix", json={"company_id": CO, "rates": [1, 1, 1, 1, 1, 1]}, who="viewer").status_code == 403
    framework(client, env, "IND_AS")
    ecl = call(client, env, "get", f"{S}/receivables/provision?company_id={CO}&as_of=2026-10-18").json()
    assert ecl["provision_required"] == round(500000 * .005 + 100000 * .35 + 40000 * .75, 2) and "expected credit loss" in ecl["basis"].lower()
    posted = call(client, env, "post", f"{S}/receivables/provision/post", json={"company_id": CO, "as_of": "2026-10-18"}).json()
    assert posted["posted"] is True and balance(env, acct["1150"]) == -ecl["provision_required"]
    again = call(client, env, "get", f"{S}/receivables/provision?company_id={CO}&as_of=2026-10-18").json()
    assert again["change_needed"] == 0
    custom = call(client, env, "put", f"{S}/receivables/matrix", json={"company_id": CO, "rates": [0, 0, 0, 0, 10, 100], "forward_looking_pct": 0})
    assert custom.status_code == 200 and custom.json()["is_default"] is False
    assert call(client, env, "get", f"{S}/receivables/provision?company_id={CO}&as_of=2026-10-18").json()["provision_required"] == 10000 + 40000
    framework(client, env, "AS")


# ── AS 15 / Ind AS 19 ──
def test_gratuity_and_leave_provisions_are_trued_up_to_the_formula_or_an_actuary(client, env, acct):
    for body in ({"name": "Ravi", "joining_date": "2018-04-01", "monthly_basic": 50000, "leave_days": 13}, {"name": "Meera", "joining_date": "2023-06-01", "monthly_basic": 30000, "leave_days": 6},
                 {"name": "Left Co", "joining_date": "2015-01-01", "monthly_basic": 90000, "exit_date": "2026-03-31"}):
        assert call(client, env, "post", f"{S}/employee-benefits/employees", json={"company_id": CO, **body}).status_code == 200
    v = call(client, env, "get", f"{S}/employee-benefits/valuation?company_id={CO}&as_of=2026-09-30").json()
    assert len(v["employees"]) == 2                                                                  # the one who left is not counted
    assert v["gratuity_formula"] == 230769.23 and v["leave_encashment"] == 31923.08                  # Meera has under five years, so no gratuity
    post = call(client, env, "post", f"{S}/employee-benefits/post", json={"company_id": CO, "as_of": "2026-09-30"}).json()
    assert post["posted"] and post["method"] == "statutory formula"
    assert balance(env, acct["2410"]) == -230769.23 and balance(env, acct["2420"]) == -31923.08 and balance(env, acct["5105"]) == 262692.31
    assert call(client, env, "post", f"{S}/employee-benefits/post", json={"company_id": CO, "as_of": "2026-09-30"}).json()["posted"] is False
    act = call(client, env, "post", f"{S}/employee-benefits/post", json={"company_id": CO, "as_of": "2026-10-01", "actuarial_gratuity": 200000}).json()
    assert act["posted"] and act["method"] == "actuarial" and act["gratuity_change"] == -30769.23 and balance(env, acct["2410"]) == -200000


# ── AS 19 / Ind AS 116 ──
def test_under_ind_as_a_lease_becomes_a_right_of_use_asset_and_a_liability(client, env, acct):
    framework(client, env, "IND_AS")
    r = call(client, env, "post", f"{S}/leases", json={"company_id": CO, "lessor": "Mehta Estates", "asset": "Pune office", "start_date": "2026-04-01", "periods": 24,
                                                         "frequency": "monthly", "payment": 10000, "discount_rate_pct": 12})
    assert r.status_code == 200 and r.json()["treatment"] == "rou" and r.json()["present_value"] == 212433.87, r.text
    lid = r.json()["id"]
    assert call(client, env, "post", f"{S}/leases", json={"company_id": CO, "lessor": "Mehta Estates", "asset": "Kiosk", "start_date": "2026-04-01", "periods": 6, "payment": 1000}).json()["treatment"] == "exempt"
    assert call(client, env, "post", f"{S}/leases", json={"company_id": CO, "lessor": "Mehta Estates", "asset": "Office", "start_date": "2026-04-01", "periods": 24, "payment": 1000}).status_code == 400   # no rate
    assert call(client, env, "post", f"{S}/leases/{lid}/post-periods", json={"company_id": CO, "through_date": "2026-06-30"}).status_code == 400            # recognise first
    rec = call(client, env, "post", f"{S}/leases/{lid}/recognise?company_id={CO}").json()
    assert rec["recognised"] and balance(env, acct["1370"]) == 212433.87 and balance(env, acct["2650"]) == -212433.87
    assert call(client, env, "post", f"{S}/leases/{lid}/recognise?company_id={CO}").status_code == 409
    p = call(client, env, "post", f"{S}/leases/{lid}/post-periods", json={"company_id": CO, "through_date": "2026-06-30"}).json()
    assert p["posted_periods"] == [1, 2, 3] and p["problem"] is None
    detail = call(client, env, "get", f"{S}/leases/{lid}?company_id={CO}").json()
    third = detail["schedule"][2]
    assert third["posted"] and not detail["schedule"][3]["posted"]
    assert balance(env, acct["2650"], "2026-06-30") == -third["closing"]                                   # the liability follows the schedule
    assert balance(env, acct["1370"], "2026-06-30") == round(212433.87 - 3 * detail["depreciation_per_period"], 2)
    assert call(client, env, "post", f"{S}/leases/{lid}/post-periods", json={"company_id": CO, "through_date": "2026-06-30"}).json()["posted_periods"] == []
    assert call(client, env, "delete", f"{S}/leases/{lid}?company_id={CO}").status_code == 409
    d = call(client, env, "get", f"{S}/leases/disclosure?company_id={CO}&as_of=2026-09-30").json()
    assert d["lease_liability"] > 0 and d["maturity"]["within_1_year"] > 0 and d["standard"].startswith("Ind AS 116")
    framework(client, env, "AS")


def test_under_as_an_operating_lease_is_levelled_straight_line_and_a_finance_lease_is_capitalised(client, env, acct):
    r = call(client, env, "post", f"{S}/leases", json={"company_id": CO, "lessor": "Rao & Sons", "asset": "Warehouse", "start_date": "2026-04-01", "periods": 24, "payment": 1000, "escalation_pct": 10}).json()
    assert r["treatment"] == "operating" and r["total_payments"] == 25200
    assert call(client, env, "post", f"{S}/leases/{r['id']}/recognise?company_id={CO}").status_code == 400
    p = call(client, env, "post", f"{S}/leases/{r['id']}/post-periods", json={"company_id": CO, "through_date": "2026-05-31"}).json()
    assert p["posted_periods"] == [1, 2]
    lns = [l for l in run(env[1].journal_lines.find({"memo": {"$regex": "Warehouse: period 1"}}).to_list(10))]
    assert sorted((l["debit"], l["credit"]) for l in lns) == [(0.0, 50.0), (50.0, 0.0)]                      # 1,050 expense against 1,000 paid
    fin = call(client, env, "post", f"{S}/leases", json={"company_id": CO, "lessor": "Tata Capital", "asset": "Forklift", "start_date": "2026-04-01", "periods": 12, "payment": 5000,
                                                           "discount_rate_pct": 12, "finance_lease": True}).json()
    assert fin["treatment"] == "finance"


# ── AS 16 / Ind AS 23 ──
def test_borrowing_costs_move_into_the_asset_only_for_a_qualifying_asset(client, env, acct):
    body = {"company_id": CO, "asset_description": "Factory building", "principal": 1000000, "rate_pct": 10, "start_date": "2026-04-01", "end_date": "2026-06-12", "temporary_income": 1500}
    prev = call(client, env, "post", f"{S}/borrowing-costs/preview", json=body).json()
    assert prev["days"] == 73 and prev["interest"] == 20000 and prev["capitalisable"] == 18500
    assert call(client, env, "post", f"{S}/borrowing-costs", json=body).status_code == 400                         # not confirmed as qualifying
    ok = call(client, env, "post", f"{S}/borrowing-costs", json={**body, "qualifying_asset": True})
    assert ok.status_code == 200, ok.text
    by = lines(env, ok.json()["entry_id"])
    assert by[acct["1390"]]["debit"] == 18500 and by[acct["5450"]]["credit"] == 18500
    lst = call(client, env, "get", f"{S}/borrowing-costs?company_id={CO}&fy=2026-27").json()
    assert lst["total_capitalised"] == 18500
    assert call(client, env, "post", f"{S}/borrowing-costs/{ok.json()['id']}/cancel?company_id={CO}").json()["cancelled"] is True
    assert balance(env, acct["1390"]) == 0
    assert call(client, env, "get", f"{S}/borrowing-costs?company_id={CO}").json()["total_capitalised"] == 0


# ── policies and notes ──
def test_policies_describe_what_the_books_do_and_can_be_overridden_by_an_admin(client, env):
    as_ = {p["key"]: p for p in call(client, env, "get", f"/api/accounting-books/notes/policies?company_id={CO}").json()["policies"]}
    assert "Accounting Standards notified" in as_["basis"]["text"] and "weighted average" in as_["inventories"]["text"] and "straight-line basis" in as_["leases"]["text"]
    framework(client, env, "IND_AS")
    ind = {p["key"]: p for p in call(client, env, "get", f"/api/accounting-books/notes/policies?company_id={CO}").json()["policies"]}
    assert "Indian Accounting Standards" in ind["basis"]["text"] and "right-of-use asset" in ind["leases"]["text"] and "expected credit loss" in ind["receivables"]["text"]
    framework(client, env, "AS")
    url = "/api/accounting-books/notes/policies/revenue"
    assert call(client, env, "put", url, who="viewer", json={"company_id": CO, "text": "We recognise revenue on delivery of services."}).status_code == 403
    assert call(client, env, "put", url, json={"company_id": CO, "text": "We recognise revenue on delivery of services."}).status_code == 200
    mine = {p["key"]: p for p in call(client, env, "get", f"/api/accounting-books/notes/policies?company_id={CO}").json()["policies"]}["revenue"]
    assert mine["is_custom"] and mine["text"].startswith("We recognise")
    assert call(client, env, "delete", f"{url}?company_id={CO}").status_code == 200
    assert call(client, env, "put", "/api/accounting-books/notes/policies/nonsense", json={"company_id": CO, "text": "A long enough sentence."}).status_code == 404


def test_notes_to_accounts_pull_from_every_register_and_say_what_is_still_missing(client, env):
    r = call(client, env, "get", f"/api/accounting-books/notes?company_id={CO}&fy=2026-27")
    assert r.status_code == 200, r.text
    n = r.json()
    titles = [s["title"] for s in n["sections"]]
    assert n["financial_year"] == "2026-27" and len(titles) == 16 and [s["no"] for s in n["sections"]] == list(range(1, 17))
    by = {s["title"]: s for s in n["sections"]}
    assert by["Significant accounting policies"]["kind"] == "policies" and len(by["Significant accounting policies"]["policies"]) >= 12
    prov = by["Provisions and contingent liabilities"]
    assert prov["status"] == "complete" and prov["second_table"]["rows"][0][0] == "Tax dispute pending appeal"
    assert by["Related party disclosures"]["status"] == "complete" and by["Earnings per share"]["status"] == "complete"
    assert by["Employee benefits"]["status"] == "complete" and by["Leases"]["status"] == "complete"
    assert by["Inventories"]["status"] == "not_applicable"                                                       # no stock items in this company
    assert by["Events after the reporting period"]["status"] == "needs_input" and "Events after the reporting period" in n["needs_input"] and n["ready"] is False
    assert n["summary"]["balance_sheet_balanced"] is True
