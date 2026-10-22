"""Inventory: the cost formulas on their own, then the whole flow through the API."""
import datetime as dt

import pytest

from backend.inventory_valuation import carrying, goes_negative, run_item, value_items

pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

from backend.tests.e2e_env import headers, run, seed_company, swapped_database  # noqa: E402


def mv(i, day, direction, qty, rate=None, kind=None, at=None):
    return {"id": f"m{i}", "item_id": "x", "date": day, "direction": direction, "quantity": qty, "rate": rate,
            "kind": kind or ("purchase" if direction == "in" else "sale"), "created_at": at or f"2026-05-01T00:00:{i:02d}"}


BASE = [mv(1, "2026-04-01", "in", 10, 100), mv(2, "2026-04-10", "in", 10, 120)]


# ── pure cost formulas ──
def test_weighted_average_recomputes_after_each_receipt_and_issues_at_the_average():
    r = run_item(BASE + [mv(3, "2026-04-15", "out", 5)], "WEIGHTED_AVG")
    assert r["quantity"] == 15 and r["unit_cost"] == 110 and r["value"] == 1650
    assert r["rows"][2]["unit_cost"] == 110 and r["rows"][2]["amount"] == 550


def test_fifo_issues_the_oldest_receipts_first():
    r = run_item(BASE + [mv(3, "2026-04-15", "out", 5)], "FIFO")
    assert r["quantity"] == 15 and r["value"] == 1700 and r["unit_cost"] == 113.33
    r = run_item(BASE + [mv(3, "2026-04-15", "out", 15)], "FIFO")        # 10 @100 then 5 @120
    assert r["rows"][2]["amount"] == 1600 and r["value"] == 600 and r["quantity"] == 5


def test_valuation_as_of_ignores_later_movements_and_cancelled_ones():
    cancelled = {**mv(4, "2026-04-12", "in", 100, 1), "status": "cancelled"}
    r = run_item(BASE + [cancelled, mv(5, "2026-05-01", "in", 10, 200)], "WEIGHTED_AVG", "2026-04-30")
    assert r["quantity"] == 20 and r["value"] == 2200


def test_same_day_movements_follow_the_order_they_were_recorded():
    rows = [mv(2, "2026-04-01", "out", 5, at="2026-05-01T10:00:02"), mv(1, "2026-04-01", "in", 10, 100, at="2026-05-01T10:00:01")]
    assert run_item(rows, "FIFO")["quantity"] == 5 and goes_negative(rows) is None
    assert goes_negative([mv(1, "2026-04-01", "out", 1)]) == "2026-04-01"       # issued before anything came in


def test_stock_going_negative_is_reported_with_its_date():
    r = run_item([mv(1, "2026-04-01", "in", 5, 10), mv(2, "2026-04-03", "out", 8)], "WEIGHTED_AVG")
    assert r["negative_on"] == "2026-04-03" and r["quantity"] == -3


def test_stock_is_valued_at_the_lower_of_cost_and_nrv_and_the_write_down_reverses():
    assert carrying(1700, 15, 100) == {"cost": 1700, "nrv": 1500, "carrying": 1500, "write_down": 200}
    assert carrying(1700, 15, 200) == {"cost": 1700, "nrv": 3000, "carrying": 1700, "write_down": 0.0}      # never above cost
    assert carrying(1700, 15, None)["carrying"] == 1700 and carrying(0, 0, 50)["carrying"] == 0
    v = value_items([{"id": "x", "name": "Widget", "nrv_per_unit": 100}], [{**m, "item_id": "x"} for m in BASE], "FIFO", "2026-04-30")
    assert v["total_cost"] == 2200 and v["total_carrying"] == 2000 and v["total_write_down"] == 200


# ── through the API ──
CO = "inv"


@pytest.fixture(scope="module")
def env():
    with swapped_database("acct_inv") as e:
        seed_company(e[1], CO, "Stock Co")
        yield e


@pytest.fixture(scope="module")
def client(env):
    return TestClient(env[0], raise_server_exceptions=False)


def H(env, who="admin"):
    return headers(env[2], f"{CO}-{who}")


def api(client, env, method, path, who="admin", **kw):
    return getattr(client, method)(f"/api/accounting-books/inventory{path}", headers=H(env, who), **kw)


@pytest.fixture(scope="module")
def acct(client, env):
    return {a["code"]: a["id"] for a in client.get(f"/api/chart-of-accounts?company_id={CO}", headers=H(env)).json()}


def lines_of(env, entry_id):
    return run(env[1].journal_lines.find({"entry_id": entry_id}).to_list(20))


def move(client, env, item, day, kind, qty, **kw):
    return api(client, env, "post", "/movements", json={"company_id": CO, "item_id": item, "date": day, "kind": kind, "quantity": qty, **kw})


def test_items_are_unique_and_opening_stock_becomes_a_movement(client, env):
    r = api(client, env, "post", "/items", json={"company_id": CO, "name": "Widget", "sku": "W-1", "unit": "Nos", "opening_quantity": 10,
                                                 "opening_rate": 100, "opening_date": "2026-04-01", "reorder_level": 5})
    assert r.status_code == 200, r.text
    env_item = r.json()["id"]
    assert api(client, env, "post", "/items", json={"company_id": CO, "name": "widget"}).status_code == 409
    assert api(client, env, "post", "/items", json={"company_id": CO, "name": "Other", "sku": "W-1"}).status_code == 409
    items = api(client, env, "get", f"/items?company_id={CO}&as_of=2026-04-30").json()
    row = [i for i in items["items"] if i["id"] == env_item][0]
    assert row["quantity"] == 10 and row["value"] == 1000 and row["unit_cost"] == 100 and items["total_value"] == 1000
    pytest.item_id = env_item


def test_a_purchase_receipt_carries_freight_in_and_deducts_trade_discount(client, env):
    r = move(client, env, pytest.item_id, "2026-04-10", "purchase", 10, rate=120, other_costs=100, discount=50, ref_no="BILL-9")
    assert r.status_code == 200, r.text
    assert r.json()["rate"] == 125                                     # (1200 + 100 - 50) / 10
    assert move(client, env, pytest.item_id, "2026-04-11", "purchase", 5).status_code == 400            # a receipt needs its rate
    led = api(client, env, "get", f"/items/{pytest.item_id}/ledger?company_id={CO}").json()
    assert led["quantity"] == 20 and led["value"] == 2250 and led["unit_cost"] == 112.5 and len(led["rows"]) == 2


def test_issuing_more_than_is_on_hand_is_refused_and_so_is_a_future_date(client, env):
    r = move(client, env, pytest.item_id, "2026-04-15", "sale", 25)
    assert r.status_code == 400 and "below zero" in r.json()["detail"]
    future = (dt.date.today() + dt.timedelta(days=3)).isoformat()
    assert move(client, env, pytest.item_id, future, "sale", 1).status_code == 400
    assert move(client, env, pytest.item_id, "2026-04-15", "sale", 5).status_code == 200


def test_the_valuation_report_compares_stock_with_the_inventory_account(client, env):
    v = api(client, env, "get", f"/valuation?company_id={CO}&as_of=2026-04-30").json()
    line = v["lines"][0]
    assert line["quantity"] == 15 and line["cost"] == 1687.5 and v["total_carrying"] == 1687.5
    assert v["book_balance"] == 0 and v["adjustment_needed"] == 1687.5 and v["framework"] == "AS" and "AS 2" in v["note"]


def test_posting_closing_stock_moves_only_the_difference_and_is_repeatable(client, env, acct):
    r = api(client, env, "post", "/valuations", json={"company_id": CO, "as_of": "2026-04-30"})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["valuation"]["delta"] == 1687.5 and j["voucher_no"].startswith("JV/26-27/")
    by = {l["account_id"]: l for l in lines_of(env, j["valuation"]["entry_id"])}
    assert by[acct["1400"]]["debit"] == 1687.5 and by[acct["5020"]]["credit"] == 1687.5
    again = api(client, env, "post", "/valuations", json={"company_id": CO, "as_of": "2026-04-30"}).json()
    assert again["valuation"]["delta"] == 0 and again["valuation"]["entry_id"] is None and again["message"]
    pytest.first_valuation = j["valuation"]["id"]


def test_a_later_valuation_posts_just_the_change_and_nrv_writes_stock_down_then_back_up(client, env, acct):
    assert move(client, env, pytest.item_id, "2026-05-20", "sale", 5).status_code == 200            # 10 left @112.50
    assert api(client, env, "put", f"/items/{pytest.item_id}", json={"company_id": CO, "nrv_per_unit": 90}).status_code == 200
    v = api(client, env, "post", "/valuations", json={"company_id": CO, "as_of": "2026-05-31"}).json()["valuation"]
    assert v["total_cost"] == 1125 and v["total_write_down"] == 225 and v["total_carrying"] == 900 and v["delta"] == -787.5
    by = {l["account_id"]: l for l in lines_of(env, v["entry_id"])}
    assert by[acct["5020"]]["debit"] == 787.5 and by[acct["1400"]]["credit"] == 787.5
    api(client, env, "put", f"/items/{pytest.item_id}", json={"company_id": CO, "clear_nrv": True})
    v2 = api(client, env, "post", "/valuations", json={"company_id": CO, "as_of": "2026-06-30"}).json()["valuation"]
    assert v2["total_write_down"] == 0 and v2["delta"] == 225                                    # reversed back to cost
    pytest.last_valuation = v2["id"]


def test_valuations_must_be_cancelled_latest_first_and_block_changes_behind_them(client, env):
    assert api(client, env, "post", "/valuations", json={"company_id": CO, "as_of": "2026-05-31"}).status_code == 409   # a later one exists
    assert api(client, env, "post", f"/valuations/{pytest.first_valuation}/cancel?company_id={CO}").status_code == 409
    led = api(client, env, "get", f"/items/{pytest.item_id}/ledger?company_id={CO}").json()
    mid = [r for r in led["rows"] if r["date"] == "2026-05-20"][0]["id"]
    assert api(client, env, "post", f"/movements/{mid}/cancel?company_id={CO}").status_code == 409
    assert api(client, env, "post", f"/valuations/{pytest.last_valuation}/cancel?company_id={CO}").json()["cancelled"] is True
    bal = api(client, env, "get", f"/valuation?company_id={CO}&as_of=2026-06-30").json()
    assert bal["book_balance"] == 900 and bal["adjustment_needed"] == 225                        # the 225 write-back is undone


def test_sales_invoices_issue_stock_once_for_linked_products(client, env):
    it = api(client, env, "post", "/items", json={"company_id": CO, "name": "Gadget", "product_id": "prod-1", "opening_quantity": 20,
                                                  "opening_rate": 50, "opening_date": "2026-04-01"}).json()
    run(env[1].invoices.insert_many([
        {"id": "i1", "company_id": CO, "invoice_no": "INV-1", "invoice_date": "2026-06-02", "status": "sent", "client_name": "Acme",
         "items": [{"product_id": "prod-1", "quantity": 4, "description": "Gadget"}, {"product_id": "other", "quantity": 9}]},
        {"id": "i2", "company_id": CO, "invoice_no": "INV-2", "invoice_date": "2026-06-03", "status": "draft", "items": [{"product_id": "prod-1", "quantity": 3}]},
        {"id": "i3", "company_id": CO, "invoice_no": "INV-3", "invoice_date": "2026-06-04", "status": "sent", "items": [{"product_id": "prod-1", "quantity": 100}]},
    ]))
    r = api(client, env, "post", f"/sync-sales?company_id={CO}").json()
    assert r["created"] == 1 and len(r["problems"]) == 1 and "INV-3" in r["problems"][0]          # drafts skipped, oversell refused
    assert api(client, env, "post", f"/sync-sales?company_id={CO}").json()["created"] == 0          # nothing is issued twice
    led = api(client, env, "get", f"/items/{it['id']}/ledger?company_id={CO}").json()
    assert led["quantity"] == 16 and led["rows"][-1]["ref_no"] == "INV-1"


def test_movements_in_a_locked_period_are_refused(client, env):
    run(env[1].accounting_locks.insert_one({"company_id": CO, "is_active": True, "locked_until_date": "2026-03-31"}))
    r = move(client, env, pytest.item_id, "2026-03-15", "purchase", 1, rate=1)
    assert r.status_code == 400 and "locked" in r.json()["detail"]
    run(env[1].accounting_locks.delete_many({"company_id": CO}))


def test_summary_lists_low_stock_and_viewers_cannot_change_anything(client, env):
    api(client, env, "put", f"/items/{pytest.item_id}", json={"company_id": CO, "reorder_level": 50})
    s = api(client, env, "get", f"/summary?company_id={CO}").json()
    assert any(x["name"] == "Widget" for x in s["below_reorder"]) and s["item_count"] == 2
    assert api(client, env, "post", "/items", who="viewer", json={"company_id": CO, "name": "Nope"}).status_code == 403
    assert api(client, env, "get", f"/valuation?company_id={CO}", who="viewer").status_code == 403
    assert api(client, env, "post", "/valuations", who="viewer", json={"company_id": CO, "as_of": "2026-06-30"}).status_code == 403
    assert api(client, env, "delete", f"/items/{pytest.item_id}?company_id={CO}").status_code == 409     # has movements
