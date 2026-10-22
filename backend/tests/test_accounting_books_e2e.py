"""End to end: settings, vouchers and their numbering, period-end adjustments, group trial balance, year-end."""
import pytest

pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

from backend.tests.e2e_env import headers, run, seed_company, swapped_database  # noqa: E402

CO = "bk"


@pytest.fixture(scope="module")
def env():
    with swapped_database("acct_books") as e:
        seed_company(e[1], CO, "Books Co")
        yield e


@pytest.fixture(scope="module")
def client(env):
    return TestClient(env[0], raise_server_exceptions=False)


def H(env, who="admin"):
    return headers(env[2], f"{CO}-{who}")


@pytest.fixture(scope="module")
def acct(client, env):
    r = client.get(f"/api/chart-of-accounts?company_id={CO}", headers=H(env))
    assert r.status_code == 200, r.text
    return {a["code"]: a["id"] for a in r.json()}


def voucher(client, env, acct, **kw):
    body = {"company_id": CO, "date": "2026-08-10", "narration": "", **kw}
    return client.post("/api/accounting-books/vouchers", json=body, headers=H(env))


def lines_of(env, entry_id):
    return run(env[1].journal_lines.find({"entry_id": entry_id}).to_list(20))


# ── settings ──
def test_settings_default_to_icai_as_and_can_be_switched_by_an_admin_only(client, env):
    r = client.get(f"/api/accounting-books/settings?company_id={CO}", headers=H(env))
    assert r.status_code == 200 and r.json()["framework"] == "AS" and r.json()["inventory_method"] == "WEIGHTED_AVG"
    up = client.put("/api/accounting-books/settings", json={"company_id": CO, "framework": "IND_AS", "tax_rate_pct": 25.17}, headers=H(env))
    assert up.status_code == 200 and up.json()["framework"] == "IND_AS" and up.json()["tax_rate_pct"] == 25.17
    assert client.put("/api/accounting-books/settings", json={"company_id": CO, "framework": "GAAP"}, headers=H(env)).status_code == 422
    assert client.put("/api/accounting-books/settings", json={"company_id": CO, "framework": "AS"}, headers=H(env, "viewer")).status_code == 403
    assert client.get(f"/api/accounting-books/settings?company_id={CO}", headers=H(env)).json()["framework"] == "IND_AS"
    client.put("/api/accounting-books/settings", json={"company_id": CO, "framework": "AS", "tax_rate_pct": 25}, headers=H(env))


# ── vouchers ──
def test_payment_and_receipt_vouchers_post_the_right_sides_and_are_numbered_per_type(client, env, acct):
    p1 = voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], narration="August rent",
                 particulars=[{"account_id": acct["5200"], "amount": 10000}], reference_no="CHQ 4411")
    assert p1.status_code == 200, p1.text
    j = p1.json()
    assert j["voucher_type"] == "payment" and j["voucher_no"] == "PAY/26-27/0001" and j["reference_no"] == "CHQ 4411"
    by = {l["account_id"]: l for l in lines_of(env, j["id"])}
    assert by[acct["5200"]]["debit"] == 10000 and by[acct["1010"]]["credit"] == 10000
    p2 = voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1000"],
                 particulars=[{"account_id": acct["5300"], "amount": 400}, {"account_id": acct["5600"], "amount": 600}])
    assert p2.json()["voucher_no"] == "PAY/26-27/0002" and p2.json()["total_debit"] == 1000
    r1 = voucher(client, env, acct, voucher_type="receipt", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["4100"], "amount": 2500}])
    assert r1.json()["voucher_no"] == "REC/26-27/0001"                       # its own sequence
    by = {l["account_id"]: l for l in lines_of(env, r1.json()["id"])}
    assert by[acct["1010"]]["debit"] == 2500 and by[acct["4100"]]["credit"] == 2500


def test_contra_moves_money_between_cash_and_bank_only(client, env, acct):
    c = voucher(client, env, acct, voucher_type="contra", cash_bank_account_id=acct["1000"], to_account_id=acct["1010"], amount=5000)
    assert c.status_code == 200 and c.json()["voucher_no"] == "CON/26-27/0001" and c.json()["voucher_type"] == "contra"
    by = {l["account_id"]: l for l in lines_of(env, c.json()["id"])}
    assert by[acct["1010"]]["debit"] == 5000 and by[acct["1000"]]["credit"] == 5000
    for bad in ({"cash_bank_account_id": acct["1000"], "to_account_id": acct["5200"], "amount": 10},
                {"cash_bank_account_id": acct["1000"], "to_account_id": acct["1000"], "amount": 10},
                {"cash_bank_account_id": acct["1000"], "to_account_id": acct["1010"]}):
        assert voucher(client, env, acct, voucher_type="contra", **bad).status_code == 400


def test_tallys_rules_are_enforced(client, env, acct):
    # payment from a non-cash/bank ledger, to a cash/bank ledger, unknown account
    assert voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["5200"], particulars=[{"account_id": acct["5300"], "amount": 5}]).status_code == 400
    assert voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["1000"], "amount": 5}]).status_code == 400
    assert voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], particulars=[{"account_id": "nope", "amount": 5}]).status_code == 400
    assert voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], particulars=[]).status_code == 400
    assert voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["5300"], "amount": -5}]).status_code == 422
    # a journal may not touch cash or bank, and each line is a debit or a credit
    assert voucher(client, env, acct, voucher_type="journal", lines=[{"account_id": acct["1010"], "debit": 5}, {"account_id": acct["4100"], "credit": 5}]).status_code == 400
    assert voucher(client, env, acct, voucher_type="journal", lines=[{"account_id": acct["5300"], "debit": 5, "credit": 5}, {"account_id": acct["4100"], "credit": 5}]).status_code == 400
    assert voucher(client, env, acct, voucher_type="journal", lines=[{"account_id": acct["5300"], "debit": 5}]).status_code == 400
    # unbalanced journal is refused by the posting boundary
    assert voucher(client, env, acct, voucher_type="journal", lines=[{"account_id": acct["5300"], "debit": 5}, {"account_id": acct["4100"], "credit": 4}]).status_code == 400
    assert voucher(client, env, acct, voucher_type="journal", date="not-a-date", lines=[]).status_code == 400
    assert voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["5300"], "amount": 5}]).status_code == 200
    # people without posting rights cannot enter vouchers or read them
    body = {"company_id": CO, "voucher_type": "journal", "date": "2026-08-10", "lines": []}
    assert client.post("/api/accounting-books/vouchers", json=body, headers=H(env, "viewer")).status_code == 403
    assert client.get(f"/api/accounting-books/vouchers?company_id={CO}", headers=H(env, "viewer")).status_code == 403


def test_journal_voucher_and_listing_filters(client, env, acct):
    j = voucher(client, env, acct, voucher_type="journal", narration="Reclass software", lines=[
        {"account_id": acct["5250"], "debit": 700}, {"account_id": acct["5300"], "credit": 700}])
    assert j.status_code == 200 and j.json()["voucher_no"] == "JV/26-27/0001"
    allv = client.get(f"/api/accounting-books/vouchers?company_id={CO}", headers=H(env)).json()
    assert allv["total"] >= 6 and all(v["voucher_no"] for v in allv["vouchers"])
    only = client.get(f"/api/accounting-books/vouchers?company_id={CO}&voucher_type=receipt", headers=H(env)).json()
    assert [v["voucher_type"] for v in only["vouchers"]] == ["receipt"]
    found = client.get(f"/api/accounting-books/vouchers?company_id={CO}&search=CHQ%204411", headers=H(env)).json()
    assert found["total"] == 1 and found["vouchers"][0]["voucher_no"] == "PAY/26-27/0001"
    assert client.get(f"/api/accounting-books/vouchers?company_id={CO}&voucher_type=bogus", headers=H(env)).status_code == 400


def test_cancelling_a_voucher_keeps_its_number_and_nets_to_zero(client, env, acct):
    v = voucher(client, env, acct, voucher_type="payment", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["5300"], "amount": 321}])
    vid, vno = v.json()["id"], v.json()["voucher_no"]
    c = client.post(f"/api/accounting-books/vouchers/{vid}/cancel?reason=entered%20twice", headers=H(env))
    assert c.status_code == 200 and c.json()["voucher_no"] == vno
    orig = run(env[1].journal_entries.find_one({"id": vid}))
    assert orig["voucher_no"] == vno and orig["reversed"] is True
    rev = run(env[1].journal_lines.find({"entry_id": c.json()["reversal"]["id"]}).to_list(10))
    assert sorted((l["debit"], l["credit"]) for l in rev) == [(0.0, 321.0), (321.0, 0.0)]
    # an invoice's entry cannot be cancelled from here
    inv = run(env[1].journal_entries.find_one({"source": "payment"}))
    assert inv is None or client.post(f"/api/accounting-books/vouchers/{inv['id']}/cancel", headers=H(env)).status_code == 400
    assert client.post("/api/accounting-books/vouchers/missing/cancel", headers=H(env)).status_code == 404


def test_a_documents_number_survives_it_being_reposted(env, acct):
    from backend import accounting_core as ac
    lines = [{"account_id": acct["5000"], "debit": 100.0, "credit": 0.0}, {"account_id": acct["2000"], "debit": 0.0, "credit": 100.0}]
    first = run(ac.post_journal_entry(CO, "2026-08-12", "Bill 1", lines, "purchase", "bill-1", "t"))
    assert first["voucher_type"] == "purchase" and first["voucher_no"] == "PUR/26-27/0001"
    other = run(ac.post_journal_entry(CO, "2026-08-13", "Bill 2", lines, "purchase", "bill-2", "t"))
    assert other["voucher_no"] == "PUR/26-27/0002"
    # edited document: its entry is deleted and posted again, as the sync does
    run(env[1].journal_lines.delete_many({"entry_id": first["id"]}))
    run(env[1].journal_entries.delete_one({"id": first["id"]}))
    again = run(ac.post_journal_entry(CO, "2026-08-12", "Bill 1 (edited)", lines, "purchase", "bill-1", "t"))
    assert again["voucher_no"] == "PUR/26-27/0001"
    nxt = run(ac.post_journal_entry(CO, "2026-08-14", "Bill 3", lines, "purchase", "bill-3", "t"))
    assert nxt["voucher_no"] == "PUR/26-27/0003"                              # no number was burnt by the repost


def test_numbers_restart_each_financial_year(client, env, acct):
    v = voucher(client, env, acct, voucher_type="payment", date="2027-02-10", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["5300"], "amount": 10}])
    assert v.json()["voucher_no"].startswith("PAY/26-27/")
    v2 = voucher(client, env, acct, voucher_type="payment", date="2027-04-02", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["5300"], "amount": 10}])
    assert v2.json()["voucher_no"] == "PAY/27-28/0001"


def test_backfill_numbers_old_entries_oldest_first_and_only_once(client, env, acct):
    raw = env[1]
    for i, (day, dr, cr) in enumerate((("2026-06-02", acct["1010"], acct["4100"]), ("2026-06-01", acct["1010"], acct["4100"]))):
        eid = f"legacy-{i}"
        run(raw.journal_entries.insert_one({"id": eid, "company_id": CO, "entry_date": day, "narration": "old", "source": "manual", "source_id": None,
                                            "total_debit": 50.0, "total_credit": 50.0, "created_at": f"{day}T00:00:00+00:00"}))
        run(raw.journal_lines.insert_many([
            {"id": f"{eid}-a", "entry_id": eid, "company_id": CO, "entry_date": day, "account_id": dr, "debit": 50.0, "credit": 0.0},
            {"id": f"{eid}-b", "entry_id": eid, "company_id": CO, "entry_date": day, "account_id": cr, "debit": 0.0, "credit": 50.0}]))
    r = client.post(f"/api/accounting-books/vouchers/backfill?company_id={CO}", headers=H(env))
    assert r.status_code == 200 and r.json()["numbered"] >= 2
    older, newer = run(raw.journal_entries.find_one({"id": "legacy-1"})), run(raw.journal_entries.find_one({"id": "legacy-0"}))
    assert older["voucher_type"] == "receipt" and newer["voucher_type"] == "receipt"
    assert int(older["voucher_no"].split("/")[-1]) < int(newer["voucher_no"].split("/")[-1])      # the earlier date got the lower number
    assert client.post(f"/api/accounting-books/vouchers/backfill?company_id={CO}", headers=H(env)).json()["numbered"] == 0
    assert client.post(f"/api/accounting-books/vouchers/backfill?company_id={CO}", headers=H(env, "viewer")).status_code == 403


# ── period-end adjustments ──
def adj(client, env, **kw):
    return client.post("/api/accounting-books/period-end/adjustments", json={"company_id": CO, "as_of": "2026-09-30", **kw}, headers=H(env))


def test_prepaid_expense_is_deferred_and_reverses_on_the_next_day(client, env, acct):
    r = adj(client, env, kind="prepaid_expense", amount=12000, account_id=acct["5200"], narration="Rent paid to Dec")
    assert r.status_code == 200 and r.json()["posted"] is True, r.text
    a = r.json()["adjustment"]
    by = {l["account_id"]: l for l in lines_of(env, a["entry_id"])}
    assert by[acct["1500"]]["debit"] == 12000 and by[acct["5200"]]["credit"] == 12000
    rev = run(env[1].journal_entries.find_one({"id": a["reversal_entry_id"]}))
    assert rev["entry_date"] == "2026-10-01" and rev["source"] == "period_end_reversal"
    by = {l["account_id"]: l for l in lines_of(env, rev["id"])}
    assert by[acct["1500"]]["credit"] == 12000 and by[acct["5200"]]["debit"] == 12000
    assert adj(client, env, kind="prepaid_expense", amount=12000, account_id=acct["5200"]).status_code == 409       # same adjustment twice
    assert adj(client, env, kind="prepaid_expense", amount=12000, account_id=acct["5200"], allow_duplicate=True).status_code == 200


def test_outstanding_expense_accrued_income_and_advance_income(client, env, acct):
    o = adj(client, env, kind="outstanding_expense", amount=3000, account_id=acct["5100"]).json()["adjustment"]
    by = {l["account_id"]: l for l in lines_of(env, o["entry_id"])}
    assert by[acct["5100"]]["debit"] == 3000 and by[acct["2300"]]["credit"] == 3000
    a = adj(client, env, kind="accrued_income", amount=4500, account_id=acct["4000"]).json()["adjustment"]
    by = {l["account_id"]: l for l in lines_of(env, a["entry_id"])}
    assert by[acct["1550"]]["debit"] == 4500 and by[acct["4000"]]["credit"] == 4500
    i = adj(client, env, kind="income_received_in_advance", amount=2000, account_id=acct["4000"]).json()["adjustment"]
    by = {l["account_id"]: l for l in lines_of(env, i["entry_id"])}
    assert by[acct["4000"]]["debit"] == 2000 and by[acct["2350"]]["credit"] == 2000
    # the wrong kind of ledger is refused
    assert adj(client, env, kind="prepaid_expense", amount=1, account_id=acct["4000"]).status_code == 400
    assert adj(client, env, kind="accrued_income", amount=1, account_id=acct["5200"]).status_code == 400
    assert adj(client, env, kind="prepaid_expense", account_id=acct["5200"]).status_code == 400
    assert adj(client, env, kind="prepaid_expense", amount=1, account_id="nope").status_code == 400


def test_provision_for_doubtful_debts_is_topped_up_and_written_back(client, env, acct):
    r = adj(client, env, kind="provision_doubtful_debts", target_balance=5000)
    assert r.status_code == 200 and r.json()["adjustment"]["amount"] == 5000 and r.json()["adjustment"]["auto_reverse"] is False
    by = {l["account_id"]: l for l in lines_of(env, r.json()["adjustment"]["entry_id"])}
    assert by[acct["5970"]]["debit"] == 5000 and by[acct["1150"]]["credit"] == 5000
    same = adj(client, env, kind="provision_doubtful_debts", target_balance=5000)
    assert same.json()["posted"] is False
    down = adj(client, env, kind="provision_doubtful_debts", target_balance=3000, as_of="2026-10-05")
    assert down.json()["adjustment"]["amount"] == 2000
    by = {l["account_id"]: l for l in lines_of(env, down.json()["adjustment"]["entry_id"])}
    assert by[acct["1150"]]["debit"] == 2000 and by[acct["5970"]]["credit"] == 2000
    assert adj(client, env, kind="provision_doubtful_debts", target_balance=100, auto_reverse=True).status_code == 400
    assert adj(client, env, kind="provision_doubtful_debts").status_code == 400


def test_cancelling_an_adjustment_undoes_it_and_its_reversal(client, env, acct):
    r = adj(client, env, kind="outstanding_expense", amount=777, account_id=acct["5300"], as_of="2026-09-29").json()["adjustment"]
    c = client.post(f"/api/accounting-books/period-end/adjustments/{r['id']}/cancel", headers=H(env))
    assert c.status_code == 200 and len(c.json()["reversal_entries"]) == 2
    assert client.post(f"/api/accounting-books/period-end/adjustments/{r['id']}/cancel", headers=H(env)).json()["already"] is True
    listing = client.get(f"/api/accounting-books/period-end/adjustments?company_id={CO}&fy=2026-27", headers=H(env)).json()
    assert {x["id"]: x["status"] for x in listing}[r["id"]] == "cancelled"
    assert client.get("/api/accounting-books/period-end/kinds", headers=H(env)).json()[0]["kind"] == "prepaid_expense"


# ── groups ──
def test_group_trial_balance_nests_groups_and_balances(client, env, acct):
    r = client.get(f"/api/accounting-books/groups/trial-balance?company_id={CO}&date_to=2026-10-31", headers=H(env))
    assert r.status_code == 200, r.text
    tb = r.json()
    assert tb["balanced"] and tb["total_debit"] == tb["total_credit"] and tb["total_debit"] > 0
    prim = {g["group"]: g for g in tb["groups"]}
    assert "Current Assets" in prim and "Indirect Expenses" in prim and "Indirect Incomes" in prim and "Purchase Accounts" in prim
    kids = {c["group"]: c for c in prim["Current Assets"]["children"]}
    assert "Bank Accounts" in kids and kids["Bank Accounts"]["accounts"][0]["code"] == "1010"
    assert "Sundry Debtors" in kids and kids["Sundry Debtors"]["credit"] == 3000                      # the provision nets against debtors
    assert kids["Sundry Debtors"]["closing"] == -3000
    assert abs(prim["Current Assets"]["closing"] - sum(c["closing"] for c in prim["Current Assets"]["children"])) < 0.01      # a group is the sum of what is in it
    assert abs(sum(g["closing"] for g in tb["groups"])) < 0.02                                                              # and the whole thing nets to nil
    # a fiscal-year report starts income and expense afresh
    later = client.get(f"/api/accounting-books/groups/trial-balance?company_id={CO}&date_to=2027-04-30", headers=H(env)).json()
    assert later["date_from"] == "2027-04-01" and later["balanced"]
    cap = {g["group"]: g for g in later["groups"]}["Capital Account"]
    bf = [a for c in cap["children"] for a in c["accounts"] if "brought forward" in a["name"]]
    assert bf and bf[0]["debit"] + bf[0]["credit"] > 0                                  # last year's result carried into reserves
    assert len(client.get("/api/accounting-books/groups", headers=H(env)).json()) > 20


# ── year-end ──
def test_year_end_stops_on_blockers_then_closes_locks_and_reopens(client, env, acct):
    fy = "2025-26"
    # a suspense balance in the year is a blocker
    v = voucher(client, env, acct, voucher_type="journal", date="2025-12-15", narration="parked", lines=[
        {"account_id": acct["9998"], "debit": 900}, {"account_id": acct["4100"], "credit": 900}])
    assert v.status_code == 200, v.text
    assert voucher(client, env, acct, voucher_type="receipt", date="2025-11-05", cash_bank_account_id=acct["1010"], particulars=[{"account_id": acct["3000"], "amount": 50000}]).status_code == 200
    check = client.get(f"/api/accounting-books/year-end/checklist?company_id={CO}&fy={fy}", headers=H(env)).json()
    assert check["blockers"] == 1 and any(i["code"] == "suspense" for i in check["items"]) and check["closed"] is False
    stop = client.post("/api/accounting-books/year-end/close", json={"company_id": CO, "fy": fy, "force": True}, headers=H(env))
    assert stop.status_code == 409 and stop.json()["detail"]["code"] == "checklist"
    # clear the suspense account
    fix = voucher(client, env, acct, voucher_type="journal", date="2025-12-20", narration="cleared", lines=[
        {"account_id": acct["9998"], "credit": 900}, {"account_id": acct["5300"], "debit": 900}])
    assert fix.status_code == 200
    # an unposted draft bill dated in the year is a warning: closing needs an explicit go-ahead
    run(env[1].purchase_invoices.insert_one({"id": "draft-1", "company_id": CO, "status": "draft", "invoice_date": "2026-01-10", "invoice_no": "D-1"}))
    after_fix = client.get(f"/api/accounting-books/year-end/checklist?company_id={CO}&fy={fy}", headers=H(env)).json()
    assert after_fix["blockers"] == 0 and any(i["code"] == "drafts" and i["count"] == 1 for i in after_fix["items"])
    warn = client.post("/api/accounting-books/year-end/close", json={"company_id": CO, "fy": fy}, headers=H(env))
    assert warn.status_code == 409 and warn.json()["detail"]["code"] == "checklist"
    assert client.post("/api/accounting-books/year-end/close", json={"company_id": CO, "fy": fy, "force": True}, headers=H(env, "viewer")).status_code == 403
    ok = client.post("/api/accounting-books/year-end/close", json={"company_id": CO, "fy": fy, "force": True}, headers=H(env))
    assert ok.status_code == 200, ok.text
    assert ok.json()["locked_through"] == "2026-03-31" and ok.json()["fy"] == fy and ok.json()["balance_count"] > 0 and ok.json()["forced"] is True
    assert client.post("/api/accounting-books/year-end/close", json={"company_id": CO, "fy": fy, "force": True}, headers=H(env)).status_code == 409
    # the year is now locked: nothing can be posted into it
    late = voucher(client, env, acct, voucher_type="journal", date="2026-03-30", lines=[{"account_id": acct["5300"], "debit": 1}, {"account_id": acct["4100"], "credit": 1}])
    assert late.status_code == 400 and "locked" in late.text.lower()
    assert voucher(client, env, acct, voucher_type="journal", date="2026-04-02", lines=[{"account_id": acct["5300"], "debit": 1}, {"account_id": acct["4100"], "credit": 1}]).status_code == 200
    closings = client.get(f"/api/accounting-books/year-end/closings?company_id={CO}", headers=H(env)).json()
    assert closings[0]["fy"] == fy and closings[0]["status"] == "closed" and "balances" not in closings[0]
    # reopen: needs a reason, an administrator, and removes the lock
    assert client.post("/api/accounting-books/year-end/reopen", json={"company_id": CO, "fy": fy, "reason": "x"}, headers=H(env)).status_code == 422
    assert client.post("/api/accounting-books/year-end/reopen", json={"company_id": CO, "fy": fy, "reason": "Auditor adjustment"}, headers=H(env, "viewer")).status_code == 403
    re = client.post("/api/accounting-books/year-end/reopen", json={"company_id": CO, "fy": fy, "reason": "Auditor adjustment"}, headers=H(env))
    assert re.status_code == 200 and re.json()["locked_through"] is None
    assert voucher(client, env, acct, voucher_type="journal", date="2026-03-30", lines=[{"account_id": acct["5300"], "debit": 1}, {"account_id": acct["4100"], "credit": 1}]).status_code == 200
    assert client.post("/api/accounting-books/year-end/reopen", json={"company_id": CO, "fy": fy, "reason": "again please"}, headers=H(env)).status_code == 404


def test_the_current_year_cannot_be_closed_before_it_ends_unless_forced(client, env):
    r = client.post("/api/accounting-books/year-end/close", json={"company_id": CO, "fy": "2026-27"}, headers=H(env))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "year_not_over"
