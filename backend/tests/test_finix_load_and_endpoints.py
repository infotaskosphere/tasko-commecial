"""Finix: connected endpoints, blank-company handling, report cache and the monthly trend query."""
import asyncio
import datetime as dt
import logging

import pytest

mongomock_motor = pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

FUTURE = (dt.datetime.utcnow() + dt.timedelta(days=200)).isoformat()


@pytest.fixture(scope="module")
def env():
    """The real app wired to an in-memory database, restored afterwards."""
    import sys

    import backend.server as server
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    logging.disable(logging.CRITICAL)
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["finix_load"]
    wrapped = TenantAwareDatabase(raw, mongo_client=client)

    original = dep.db
    original_raw = dep._raw_db
    swapped = []
    for name, mod in list(sys.modules.items()):
        if (name == "backend" or name.startswith("backend.")) and mod is not None:
            if getattr(mod, "db", None) is original:
                swapped.append(mod)
                mod.db = wrapped
    dep._raw_db = raw
    dep.db = wrapped

    yield server.app, raw, dep

    # Modules first imported while the tests ran (lazy imports) captured the
    # in-memory database as their own; hand every such reference back too, or
    # later test modules would keep talking to this database.
    for name, mod in list(sys.modules.items()):
        if (name == "backend" or name.startswith("backend.")) and mod is not None:
            if getattr(mod, "db", None) is wrapped:
                mod.db = original
    for mod in swapped:
        mod.db = original
    dep.db = original
    dep._raw_db = original_raw
    logging.disable(logging.NOTSET)


def _run(coro):
    import asyncio

    return asyncio.new_event_loop().run_until_complete(coro)


async def _seed(raw, cust, modules, selected=None):
    lic = {
        "id": f"lic-{cust}", "customer_id": cust, "status": "active", "modules": modules,
        "licensed_modules": modules, "expires_at": FUTURE,
        "issued_at": dt.datetime.utcnow().isoformat(), "max_users": 50,
    }
    if selected is not None:
        lic["selected_features"] = selected
    await raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True)
    await raw.companies.replace_one(
        {"id": cust},
        {"id": cust, "name": cust, "commercial_customer_id": cust, "license_id": lic["id"]},
        upsert=True,
    )
    base = {
        "company_id": cust, "license_id": lic["id"], "commercial_customer_id": cust,
        "is_active": True, "hashed_password": "x", "created_at": dt.datetime.utcnow().isoformat(),
    }
    await raw.users.replace_one(
        {"id": f"{cust}-admin"},
        {**base, "id": f"{cust}-admin", "email": f"admin@{cust}.test", "full_name": "Admin",
         "role": "admin", "identity_type": "licensee_admin", "permissions": {}},
        upsert=True,
    )
    await raw.users.replace_one(
        {"id": f"{cust}-staff"},
        {**base, "id": f"{cust}-staff", "email": f"staff@{cust}.test", "full_name": "Staff",
         "role": "staff", "permissions": {}},
        upsert=True,
    )


async def _seed(raw, cust, modules, selected=None):
    lic = {
        "id": f"lic-{cust}", "customer_id": cust, "status": "active", "modules": modules,
        "licensed_modules": modules, "expires_at": FUTURE,
        "issued_at": dt.datetime.utcnow().isoformat(), "max_users": 50,
    }
    if selected is not None:
        lic["selected_features"] = selected
    await raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True)
    await raw.companies.replace_one(
        {"id": cust},
        {"id": cust, "name": cust, "commercial_customer_id": cust, "license_id": lic["id"]},
        upsert=True,
    )
    base = {
        "company_id": cust, "license_id": lic["id"], "commercial_customer_id": cust,
        "is_active": True, "hashed_password": "x", "created_at": dt.datetime.utcnow().isoformat(),
    }
    await raw.users.replace_one(
        {"id": f"{cust}-admin"},
        {**base, "id": f"{cust}-admin", "email": f"admin@{cust}.test", "full_name": "Admin",
         "role": "admin", "identity_type": "licensee_admin", "permissions": {}},
        upsert=True,
    )
    await raw.users.replace_one(
        {"id": f"{cust}-staff"},
        {**base, "id": f"{cust}-staff", "email": f"staff@{cust}.test", "full_name": "Staff",
         "role": "staff", "permissions": {}},
        upsert=True,
    )



@pytest.fixture(scope="module")
def client(env):
    _run(_seed(env[1], "fx", ["finix"]))
    _run(_seed_books(env[1], "fx"))
    return TestClient(env[0], raise_server_exceptions=False)


def _auth(env, user_id):
    return {"Authorization": "Bearer " + env[2].create_access_token({"sub": user_id})}


async def _seed_books(raw, cid):
    accounts = [
        ("a-sales", "4000", "Sales", "income"), ("a-other", "4100", "Other income", "income"),
        ("a-rent", "5000", "Rent", "expense"), ("a-bank", "1010", "Bank", "asset"),
    ]
    for aid, code, name, typ in accounts:
        await raw.chart_of_accounts.replace_one({"id": aid}, {"id": aid, "company_id": cid, "code": code, "name": name, "type": typ}, upsert=True)
    lines = [
        ("a-sales", "2026-04-10", 0, 1000), ("a-sales", "2026-04-20", 0, 500), ("a-sales", "2026-05-02", 100, 0),
        ("a-other", "2026-05-15", 0, 250), ("a-rent", "2026-04-05", 300, 0), ("a-rent", "2026-06-05", 120, 0),
        ("a-bank", "2026-04-10", 1000, 0),
    ]
    await raw.journal_lines.delete_many({"company_id": cid})
    for i, (aid, d, debit, credit) in enumerate(lines):
        await raw.journal_lines.insert_one({"id": f"l{i}", "entry_id": f"e{i}", "company_id": cid, "account_id": aid, "entry_date": d, "debit": debit, "credit": credit})


# --------------------------------------------------------------------------- #
# Endpoints that existed in code but were never connected (404 in production)
# --------------------------------------------------------------------------- #

def test_every_finix_agent_route_is_connected():
    """The live router is a facade; a route added only to the implementation module is a 404 in production."""
    from backend.accounting_ai import finix_agent_complete as impl
    from backend.accounting_ai import finix_agent_mount as mount

    def routes(router):
        return {(m, r.path) for r in router.routes for m in r.methods if m != "HEAD"}

    assert routes(impl.router) <= routes(mount.router), sorted(routes(impl.router) - routes(mount.router))


def test_learning_and_diagnostic_endpoints_answer(client, env):
    h = _auth(env, "fx-admin")
    for path in ("/api/finix/ai/learning/accuracy?days=90", "/api/finix/ai/learning/vendors", "/api/finix/ai/ledger-diagnostics"):
        r = client.get(path, headers=h)
        assert r.status_code == 200, (path, r.status_code, r.text[:200])
    assert "vendors" in client.get("/api/finix/ai/learning/vendors", headers=h).json()
    r = client.post("/api/finix/ai/learning/reset-vendor", json={"vendor_key": "nobody"}, headers=h)
    assert r.status_code == 404 and "no learned data" in r.text  # reached the handler
    assert client.post("/api/finix/ai/resync", headers=h).status_code == 200


# --------------------------------------------------------------------------- #
# GST portal sync with no company chosen
# --------------------------------------------------------------------------- #

def test_gst_portal_resolves_a_blank_company_to_the_users_own():
    from fastapi import HTTPException
    from backend.gst_portal_sync import _cid

    class U:  # noqa: D401
        company_id = "co-9"

    assert _cid(U(), "") == "co-9"
    assert _cid(U(), "  ") == "co-9"
    assert _cid(U(), "co-2") == "co-2"
    U.company_id = ""
    with pytest.raises(HTTPException) as e:
        _cid(U(), "")
    assert e.value.status_code == 400


def test_gst_registration_and_listing_work_without_a_company_in_the_request(client, env):
    h = _auth(env, "fx-admin")
    gstin = "24AALCP5501B1ZW"
    assert client.post("/api/gst-portal/register", json={"company_id": "", "gstin": gstin, "active": True}, headers=h).status_code == 200
    rows = client.get("/api/gst-portal/registrations", headers=h).json()
    assert [r["gstin"] for r in rows] == [gstin] and rows[0]["company_id"] == "fx"


# --------------------------------------------------------------------------- #
# Monthly trend: one query that must agree with the per-month Profit & Loss reports
# --------------------------------------------------------------------------- #

def test_monthly_trend_matches_the_monthly_profit_and_loss(client, env):
    h = _auth(env, "fx-admin")
    r = client.get("/api/reports/monthly-trend", params={"company_id": "fx", "date_from": "2026-04-01", "date_to": "2026-06-30"}, headers=h)
    assert r.status_code == 200, r.text
    months = {m["month"]: m for m in r.json()["months"]}
    assert set(months) == {"2026-04", "2026-05", "2026-06"}
    for month, (start, end) in {"2026-04": ("2026-04-01", "2026-04-30"), "2026-05": ("2026-05-01", "2026-05-31"), "2026-06": ("2026-06-01", "2026-06-30")}.items():
        pl = client.get("/api/reports/profit-loss", params={"company_id": "fx", "date_from": start, "date_to": end}, headers=h).json()
        assert months[month]["total_income"] == pl["total_income"], month
        assert months[month]["total_expense"] == pl["total_expense"], month
        assert months[month]["net_profit"] == pl["net_profit"], month
    assert months["2026-04"]["total_income"] == 1500 and months["2026-04"]["total_expense"] == 300
    assert months["2026-05"]["total_income"] == 150  # 250 other income less 100 sales return


def test_monthly_trend_needs_a_company_and_report_access(client, env):
    h = _auth(env, "fx-admin")
    assert client.get("/api/reports/monthly-trend", params={"company_id": " ", "date_from": "a", "date_to": "b"}, headers=h).status_code in (400, 403)
    assert client.get("/api/reports/monthly-trend", params={"company_id": "fx", "date_from": "2026-04-01", "date_to": "2026-06-30"}).status_code in (401, 403)


def test_profit_and_loss_totals_per_account(client, env):
    pl = client.get("/api/reports/profit-loss", params={"company_id": "fx", "date_from": "2026-04-01", "date_to": "2026-06-30"}, headers=_auth(env, "fx-admin")).json()
    income = {r["code"]: r["amount"] for r in pl["income"]}
    expense = {r["code"]: r["amount"] for r in pl["expenses"]}
    assert income == {"4000": 1400, "4100": 250} and expense == {"5000": 420}
    assert pl["net_profit"] == 1230


# --------------------------------------------------------------------------- #
# Report cache
# --------------------------------------------------------------------------- #

@pytest.fixture
def rc(monkeypatch):
    from backend import report_cache
    report_cache.clear()
    monkeypatch.setattr(report_cache, "_scope", lambda: ("co", False, False))
    monkeypatch.setenv("REPORT_CACHE_TTL_SECONDS", "60")
    yield report_cache
    report_cache.clear()


def _count(counter, value="v"):
    async def compute():
        counter.append(1)
        await asyncio.sleep(0)
        return {"value": value, "n": len(counter)}
    return compute


def test_cache_reuses_an_answer_until_the_books_change(rc):
    async def go():
        calls = []
        a = await rc.cached("r", ("x",), _count(calls))
        b = await rc.cached("r", ("x",), _count(calls))
        assert a == b and len(calls) == 1
        rc.bump("invoices")  # a write to a finance collection
        c = await rc.cached("r", ("x",), _count(calls))
        assert len(calls) == 2 and c["n"] == 2
        rc.bump("tasks")  # unrelated collections do not matter
        await rc.cached("r", ("x",), _count(calls))
        assert len(calls) == 2
    _run(go())


def test_cache_keys_separate_companies_and_parameters(rc, monkeypatch):
    async def go():
        calls = []
        await rc.cached("r", ("a",), _count(calls))
        await rc.cached("r", ("b",), _count(calls))
        monkeypatch.setattr(rc, "_scope", lambda: ("other-co", False, False))
        await rc.cached("r", ("a",), _count(calls))
        assert len(calls) == 3
    _run(go())


def test_callers_cannot_change_a_cached_answer(rc):
    async def go():
        first = await rc.cached("r", (), _count([]))
        first["value"] = "tampered"
        assert (await rc.cached("r", (), _count([])))["value"] == "v"
    _run(go())


def test_identical_requests_in_flight_share_one_computation(rc):
    async def go():
        calls = []

        async def slow():
            calls.append(1)
            await asyncio.sleep(0.05)
            return {"ok": True}

        results = await asyncio.gather(*(rc.cached("r", (), slow) for _ in range(6)))
        assert len(calls) == 1 and all(r == {"ok": True} for r in results)
    _run(go())


def test_failures_are_not_cached_and_reach_every_waiter(rc):
    async def go():
        async def boom():
            await asyncio.sleep(0.01)
            raise ValueError("bad")

        outcomes = await asyncio.gather(*(rc.cached("r", (), boom) for _ in range(3)), return_exceptions=True)
        assert all(isinstance(o, ValueError) for o in outcomes)
        calls = []
        assert (await rc.cached("r", (), _count(calls)))["value"] == "v" and len(calls) == 1
    _run(go())


def test_cache_expires_and_can_be_bypassed_or_disabled(rc, monkeypatch):
    async def go():
        calls = []
        await rc.cached("r", (), _count(calls))
        await rc.cached("r", (), _count(calls), fresh=True)
        assert len(calls) == 2
        key = next(iter(rc._entries))
        ts, rev, val = rc._entries[key]
        rc._entries[key] = (ts - 120, rev, val)  # older than the 60s limit
        await rc.cached("r", (), _count(calls))
        assert len(calls) == 3
        monkeypatch.setenv("REPORT_CACHE_TTL_SECONDS", "0")
        await rc.cached("r", (), _count(calls))
        await rc.cached("r", (), _count(calls))
        assert len(calls) == 5
    _run(go())


def test_a_real_write_through_the_database_layer_invalidates_reports(client, env, rc):
    """End to end: P&L is served from cache, then a journal line is written and the report moves."""
    h = _auth(env, "fx-admin")
    params = {"company_id": "fx", "date_from": "2026-04-01", "date_to": "2026-06-30"}
    first = client.get("/api/reports/profit-loss", params=params, headers=h).json()
    assert client.get("/api/reports/profit-loss", params=params, headers=h).json() == first
    _run(env[2].db.journal_lines.insert_one({"id": "lx", "entry_id": "ex", "company_id": "fx", "account_id": "a-sales", "entry_date": "2026-06-10", "debit": 0, "credit": 77}))
    second = client.get("/api/reports/profit-loss", params=params, headers=h).json()
    assert second["total_income"] == first["total_income"] + 77
    _run(env[2].db.journal_lines.delete_one({"id": "lx"}))
    assert client.get("/api/reports/profit-loss", params=params, headers=h).json() == first


def test_validation_is_scheduled_at_most_once_per_interval(monkeypatch):
    from backend import accounting_core as ac
    started = []

    async def fake(company_id):
        started.append(company_id)

    monkeypatch.setattr(ac, "_validate_best_effort", fake)
    ac._validation_last_started.clear()

    async def go():
        for _ in range(5):
            ac._schedule_validation("book-1")
        ac._schedule_validation("book-2")
        await asyncio.sleep(0.01)
    _run(go())
    assert sorted(started) == ["book-1", "book-2"]


def test_validation_engine_endpoint_accepts_fresh(client, env):
    h = _auth(env, "fx-admin")
    r0 = client.get("/api/reports/validation-engine", params={"company_id": "fx"}, headers=h)
    assert r0.status_code == 200, r0.text
    assert client.get("/api/reports/validation-engine", params={"company_id": "fx", "fresh": "true"}, headers=h).status_code == 200
