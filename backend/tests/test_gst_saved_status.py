"""Live GST Portal Sync: saved GSTINs show their stored status; the outside service is contacted only on add/update."""
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
    raw = client["gst_saved"]
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



G1 = "29AABCU9603R1ZJ"   # checksum-valid
G2 = "27AAACT2882H1Z7"
BAD = "29AABCU9603R1ZK"  # wrong check digit


@pytest.fixture(scope="module")
def client(env):
    _run(_seed(env[1], "gs", ["finix"]))
    _run(env[1].companies.update_one({"id": "gs"}, {"$set": {"gstin": G2}}))
    _run(env[1].users.update_one({"id": "gs-staff"}, {"$set": {"permissions": {"can_view_accounting_reports": True, "can_manage_chart_of_accounts": False}}}))
    return TestClient(env[0], raise_server_exceptions=False)


@pytest.fixture
def outside(monkeypatch):
    """Stand-in for the outside GST service that records every call."""
    from backend import gst_portal_sync as gps
    calls = []
    state = {"status": "Active", "confirmed": True}

    async def fake(gstin, force_refresh=False):
        calls.append((gstin, force_refresh))
        return {"gstin": gstin, "valid": True, "legal_name": f"Legal {gstin[:4]}", "trade_name": "Trade", "status": state["status"],
                "status_confirmed": state["confirmed"], "taxpayer_type": "Regular", "source": "SheetGST Free Tier API" if state["confirmed"] else "Free Algorithmic & Local Register Engine",
                "verified_at": "2026-10-18T02:00:00+00:00"}

    monkeypatch.setattr(gps, "lookup_gstin_details", fake)
    return calls, state


def _h(env, uid="gs-admin"):
    return {"Authorization": "Bearer " + env[2].create_access_token({"sub": uid})}


def _list(client, env, uid="gs-admin"):
    r = client.get("/api/gst-portal/gstins", headers=_h(env, uid))
    assert r.status_code == 200, r.text
    return {e["gstin"]: e for e in r.json()["gstins"]}


def test_opening_the_page_never_contacts_the_outside_service(client, env, outside):
    calls, _ = outside
    rows = _list(client, env)
    assert calls == []
    # the number on the company profile is listed, but has not been checked
    assert rows[G2]["status"] == "Not checked yet" and rows[G2]["origin"] == "company_profile" and rows[G2]["saved"] is False


def test_adding_a_gstin_checks_once_and_keeps_the_status(client, env, outside):
    calls, _ = outside
    r = client.post("/api/gst-portal/gstins", json={"gstin": G1}, headers=_h(env))
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "Active" and r.json()["status_confirmed"] is True and r.json()["legal_name"].startswith("Legal")
    assert calls == [(G1, False)]
    rows = _list(client, env)
    assert calls == [(G1, False)]  # listing again did not call out
    assert rows[G1]["saved"] and rows[G1]["status"] == "Active" and rows[G1]["verified_at"]
    assert rows[G1]["state_name"] == "Karnataka"


def test_updating_rechecks_with_a_fresh_lookup_and_stores_the_new_status(client, env, outside):
    calls, state = outside
    state["status"] = "Cancelled"
    r = client.post(f"/api/gst-portal/gstins/{G1}/refresh", headers=_h(env))
    assert r.status_code == 200 and r.json()["status"] == "Cancelled"
    assert calls[-1] == (G1, True)
    assert _list(client, env)[G1]["status"] == "Cancelled"
    # a number that only sat on the company profile becomes saved once it is updated
    client.post(f"/api/gst-portal/gstins/{G2}/refresh", headers=_h(env))
    row = _list(client, env)[G2]
    assert row["saved"] and row["origin"] == "registered"


def test_a_status_nobody_confirmed_is_not_shown_as_active(client, env, outside):
    _, state = outside
    state["confirmed"], state["status"] = False, "Active"
    r = client.post(f"/api/gst-portal/gstins/{G1}/refresh", headers=_h(env))
    assert r.json()["status"] == "Format valid" and r.json()["status_confirmed"] is False


def test_an_invalid_number_is_refused_before_any_lookup(client, env, outside):
    calls, _ = outside
    before = len(calls)
    for bad in (BAD, "NOTAGSTIN12345Z"):
        r = client.post("/api/gst-portal/gstins", json={"gstin": bad}, headers=_h(env))
        assert r.status_code == 400 and "not a valid GSTIN" in r.text
    assert len(calls) == before


def test_update_all_and_remove(client, env, outside):
    calls, state = outside
    state["confirmed"], state["status"] = True, "Active"
    r = client.post("/api/gst-portal/gstins/refresh-all", headers=_h(env))
    assert r.status_code == 200 and {e["gstin"] for e in r.json()["updated"]} == {G1, G2} and r.json()["failed"] == []
    assert client.delete(f"/api/gst-portal/gstins/{G1}", headers=_h(env)).status_code == 200
    assert client.delete(f"/api/gst-portal/gstins/{G1}", headers=_h(env)).status_code == 404
    assert G1 not in _list(client, env)


def test_viewers_can_see_status_but_not_change_it(client, env, outside):
    calls, _ = outside
    before = len(calls)
    assert client.get("/api/gst-portal/gstins", headers=_h(env, "gs-staff")).status_code in (200, 403)
    for method, path, kw in (("post", "/api/gst-portal/gstins", {"json": {"gstin": G1}}), ("post", f"/api/gst-portal/gstins/{G2}/refresh", {}), ("delete", f"/api/gst-portal/gstins/{G2}", {})):
        assert getattr(client, method)(path, headers=_h(env, "gs-staff"), **kw).status_code == 403, path
    assert len(calls) == before


def test_one_company_never_sees_anothers_gstins(client, env, outside):
    _run(_seed(env[1], "gt", ["finix"]))
    assert G2 in _list(client, env)
    assert set(_list(client, env, "gt-admin")) == set()


def test_sync_now_stores_the_taxpayer_status_it_saw(client, env, monkeypatch):
    from backend import gst_portal_sync as gps

    async def fake_portal(gstin, period, company_id=""):
        return {"outward_cash_liability": 0.0, "outward_total_liability": 0.0, "available_itc": 0.0, "mode": "free_gst_api",
                "taxpayer": {"gstin": gstin, "legal_name": "Seen In Sync", "status": "Active", "status_confirmed": True, "source": "SheetGST Free Tier API", "verified_at": "2026-10-18T03:00:00+00:00"}}

    monkeypatch.setattr(gps, "_fetch_portal_balances", fake_portal)
    r = client.post(f"/api/gst-portal/sync-now?gstin={G2}", headers=_h(env))
    assert r.status_code == 200, r.text
    row = _list(client, env)[G2]
    assert row["legal_name"] == "Seen In Sync" and row["last_synced_at"]
