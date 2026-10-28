"""End-to-end checks of the Platform Owner -> Licensee -> user entitlement chain.

These run the real FastAPI app (every router, every guard) against an in-memory
database, with licensee tenants that each own ONE module, so they prove what a
customer can and cannot reach - not just what the guard tables say.

Covered:
  * a tenant that did not buy a module cannot call that module's APIs;
  * a tenant that bought only some pages of a module gets only those pages;
  * the licensee admin's Permission Matrix limits its users, cannot exceed the
    licence, and cannot be used to escalate or to reach another tenant;
  * routes that used to be unauthenticated or platform-wide now are not.
"""
import datetime as dt
import logging

import pytest

mongomock_motor = pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

FUTURE = (dt.datetime.utcnow() + dt.timedelta(days=200)).isoformat()
ALL_MODULES = ["taskosphere", "finix", "compliance", "records", "proposals", "people_matrix", "aiweave"]


@pytest.fixture(scope="module")
def env():
    """The real app wired to an in-memory database, restored afterwards."""
    import sys

    import backend.server as server
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    logging.disable(logging.CRITICAL)
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["entitlement_e2e"]
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


@pytest.fixture(scope="module")
def tenants(env):
    app, raw, dep = env
    for module in ALL_MODULES:
        _run(_seed(raw, f"only_{module}", [module]))
    _run(_seed(raw, "everything", ALL_MODULES))
    _run(_seed(raw, "sales_only", ["finix"], {"finix": ["can_view_sale", "can_view_purchase"]}))
    _run(_seed(raw, "other_co", ["taskosphere"]))
    return True


@pytest.fixture(scope="module")
def client(env, tenants):
    app, _raw, _dep = env
    return TestClient(app, raise_server_exceptions=False)


def _auth(env, user_id):
    return {"Authorization": "Bearer " + env[2].create_access_token({"sub": user_id})}


# --------------------------------------------------------------------------- #
# 1. A tenant cannot call modules it did not buy
# --------------------------------------------------------------------------- #

# Routes that each belong to exactly one billable module.
MODULE_ROUTES = {
    "taskosphere": ["/api/tasks"],
    "finix": [
        "/api/invoices", "/api/purchase-invoices", "/api/bank-accounts",
        "/api/zte/documents", "/api/gst-portal/registrations", "/api/purchase-payments",
        "/api/unprepared-incomes", "/api/party-ledgers", "/api/audit-trail",
        "/api/control-accounts/verify", "/api/bank-transactions/x/audit-trail",
        "/api/learning/stats",
    ],
    "compliance": [
        "/api/trademark-qc/stats", "/api/trademark-qc/list", "/api/stats", "/api/deadlines",
        "/api/trademark-users", "/api/mis/clients",
    ],
    "records": ["/api/passwords", "/api/dsc", "/api/documents"],
    "proposals": ["/api/leads", "/api/quotations"],
}


@pytest.mark.parametrize("owner_module", sorted(MODULE_ROUTES))
@pytest.mark.parametrize("role", ["admin", "staff"])
def test_module_routes_are_closed_to_tenants_that_did_not_buy_them(client, env, owner_module, role):
    leaks = []
    for other in ALL_MODULES:
        if other == owner_module:
            continue
        headers = _auth(env, f"only_{other}-{role}")
        for path in MODULE_ROUTES[owner_module]:
            status = client.get(path, headers=headers).status_code
            if status != 403:
                leaks.append((other, path, status))
    assert not leaks, f"{role} of a tenant without {owner_module} reached its APIs: {leaks}"


@pytest.mark.parametrize("owner_module", sorted(MODULE_ROUTES))
def test_module_routes_open_for_the_tenant_that_bought_them(client, env, owner_module):
    """Each module works on its own: a tenant with ONLY this module can use it."""
    headers = _auth(env, f"only_{owner_module}-admin")
    blocked = []
    for path in MODULE_ROUTES[owner_module]:
        r = client.get(path, headers=headers)
        if r.status_code == 403:
            blocked.append((path, r.text[:100]))
    assert not blocked, f"{owner_module}-only tenant is wrongly blocked from its own APIs: {blocked}"


def test_tenant_with_no_modules_reaches_no_billable_api(client, env):
    _run(_seed(env[1], "nothing", []))
    headers = _auth(env, "nothing-admin")
    leaks = []
    for paths in MODULE_ROUTES.values():
        for path in paths:
            status = client.get(path, headers=headers).status_code
            if status != 403:
                leaks.append((path, status))
    assert not leaks, leaks


# --------------------------------------------------------------------------- #
# 2. Page-level sale: bought pages work, other pages of the same module do not
# --------------------------------------------------------------------------- #

def test_only_the_purchased_pages_of_a_module_work(client, env):
    admin = _auth(env, "sales_only-admin")
    staff = _auth(env, "sales_only-staff")
    for headers in (admin, staff):
        assert client.get("/api/invoices", headers=headers).status_code == 200
        assert client.get("/api/purchase-invoices", headers=headers).status_code == 200
        assert client.get("/api/purchase-payments", headers=headers).status_code == 200
        assert client.get("/api/unprepared-incomes", headers=headers).status_code == 200
        # pages that were NOT sold
        assert client.get("/api/bank-accounts", headers=headers).status_code == 403
        assert client.get("/api/bank-transactions/x/audit-trail", headers=headers).status_code == 403
        assert client.get("/api/zte/documents", headers=headers).status_code == 403
        assert client.get("/api/gst-portal/registrations", headers=headers).status_code == 403
        assert client.get("/api/audit-trail", headers=headers).status_code == 403


# --------------------------------------------------------------------------- #
# 3. The licensee admin's Permission Matrix over its own users
# --------------------------------------------------------------------------- #

def _full_permissions(client, env, admin_id, user_id):
    r = client.get(f"/api/users/{user_id}/permissions", headers=_auth(env, admin_id))
    assert r.status_code == 200, r.text
    return r.json()


def test_admin_can_switch_a_page_off_for_a_user(client, env):
    perms = _full_permissions(client, env, "sales_only-admin", "sales_only-staff")
    perms.update({"can_view_sale": False, "can_view_purchase": True})
    assert client.put("/api/users/sales_only-staff/permissions", json=perms,
                      headers=_auth(env, "sales_only-admin")).status_code == 200
    staff = _auth(env, "sales_only-staff")
    assert client.get("/api/invoices", headers=staff).status_code == 403
    assert client.get("/api/purchase-invoices", headers=staff).status_code == 200
    # restore
    perms.update({"can_view_sale": True, "can_view_purchase": True})
    client.put("/api/users/sales_only-staff/permissions", json=perms, headers=_auth(env, "sales_only-admin"))


def test_admin_cannot_grant_pages_the_licence_does_not_include(client, env):
    perms = _full_permissions(client, env, "sales_only-admin", "sales_only-staff")
    perms.update({
        "can_view_bank": True, "can_access_taskosphere": True, "can_view_tasks": True,
        "can_access_compliance": True, "can_view_trademark_sphere": True,
    })
    assert client.put("/api/users/sales_only-staff/permissions", json=perms,
                      headers=_auth(env, "sales_only-admin")).status_code == 200
    staff = _auth(env, "sales_only-staff")
    assert client.get("/api/bank-accounts", headers=staff).status_code == 403
    assert client.get("/api/tasks", headers=staff).status_code == 403
    assert client.get("/api/trademark-qc/stats", headers=staff).status_code == 403


def test_matrix_actions_limit_what_a_user_can_do_on_a_page(client, env):
    admin = _auth(env, "sales_only-admin")
    perms = _full_permissions(client, env, "sales_only-admin", "sales_only-staff")
    staff = _auth(env, "sales_only-staff")

    perms["governance_matrix"] = {"finix.can_view_sale": ["view"]}
    client.put("/api/users/sales_only-staff/permissions", json=perms, headers=admin)
    assert client.get("/api/invoices", headers=staff).status_code == 200
    assert client.post("/api/invoices", json={}, headers=staff).status_code == 403
    assert client.delete("/api/invoices/x", headers=staff).status_code == 403

    perms["governance_matrix"] = {"finix.can_view_sale": ["view", "create"]}
    client.put("/api/users/sales_only-staff/permissions", json=perms, headers=admin)
    assert client.post("/api/invoices", json={}, headers=staff).status_code != 403  # reaches validation
    assert client.delete("/api/invoices/x", headers=staff).status_code == 403
    perms["governance_matrix"] = {}
    client.put("/api/users/sales_only-staff/permissions", json=perms, headers=admin)


def test_staff_cannot_escalate_themselves(client, env):
    staff = _auth(env, "sales_only-staff")
    grant = {"can_view_bank": True, "can_manage_users": True, "can_view_user_page": True}
    assert client.put("/api/users/sales_only-staff/permissions", json=grant, headers=staff).status_code == 403
    assert client.put("/api/users/sales_only-staff", json={"role": "admin"}, headers=staff).status_code == 403
    assert client.post("/api/role-admin/roles", json={"key": "x", "label": "x", "permissions": {}},
                       headers=staff).status_code == 403
    assert client.put("/api/commercial-master-data/users/sales_only-staff", json={"role": "admin"},
                      headers=staff).status_code == 403


def test_licensee_admin_cannot_become_platform_owner_or_touch_the_console(client, env):
    admin = _auth(env, "sales_only-admin")
    client.put("/api/users/sales_only-staff", headers=admin,
               json={"is_platform_owner": True, "identity_type": "platform_owner", "platform_owner_uid": "PO-1"})
    staff = _auth(env, "sales_only-staff")
    assert client.get("/api/commercial-console/analytics", headers=staff).status_code == 403
    assert client.get("/api/commercial-console/analytics", headers=admin).status_code == 403
    assert client.put("/api/commercial-master-data/licenses/lic-other_co", headers=admin,
                      json={"status": "revoked"}).status_code == 403
    assert _run(env[1].commercial_licenses.find_one({"id": "lic-other_co"}))["status"] == "active"


def test_a_licensee_admin_cannot_reach_another_tenants_users(client, env):
    admin = _auth(env, "sales_only-admin")
    assert client.get("/api/users/other_co-staff/permissions", headers=admin).status_code == 404
    assert client.put("/api/users/other_co-staff/permissions", json={"can_view_tasks": False},
                      headers=admin).status_code == 404
    assert client.put("/api/users/other_co-staff", json={"full_name": "x"}, headers=admin).status_code == 404
    assert client.delete("/api/users/other_co-staff", headers=admin).status_code == 404
    assert client.put("/api/commercial-master-data/users/other_co-staff", json={"full_name": "x"},
                      headers=admin).status_code == 404


# --------------------------------------------------------------------------- #
# 4. Routes that used to be unauthenticated or platform-wide
# --------------------------------------------------------------------------- #

UNAUTHENTICATED_BEFORE = [
    ("GET", "/api/passwords/admin/stats", None),
    ("GET", "/api/passwords/admin/access-logs", None),
    ("POST", "/api/passwords/sheet-links", {"label": "x", "url": "https://example.com"}),
    ("PUT", "/api/passwords/sheet-links/x", {"label": "x"}),
    ("DELETE", "/api/passwords/sheet-links/x", None),
    ("GET", "/api/visits/admin/monthly-plan?month=2026-10", None),
    ("PUT", "/api/email-templates/welcome", {"settings": {}}),
    ("GET", "/api/ai/workflow/analytics?company_id=other_co", None),
    ("GET", "/api/ai/workflow/dashboard?company_id=other_co", None),
    ("GET", "/api/ai/workflow/kpis?company_id=other_co", None),
    ("POST", "/api/ai/copilot/query", {"query": "list all clients"}),
    ("POST", "/api/activity/report", {"user_id": "sales_only-staff", "date": "2026-10-17"}),
    ("POST", "/api/sync/123", None),
    ("GET", "/api/search?query=abc", None),
    ("PUT", "/api/website-config", {"site_name": "defaced"}),
    ("GET", "/api/website-config/admin", None),
    ("POST", "/api/website-config/reset", None),
]


@pytest.mark.parametrize("method,path,body", UNAUTHENTICATED_BEFORE)
def test_formerly_open_routes_now_require_login(client, method, path, body):
    r = client.request(method, path, json=body) if body is not None else client.request(method, path)
    assert r.status_code in (401, 403), f"{method} {path} answered {r.status_code} without credentials"


def test_no_route_uses_an_admin_dependency_factory_without_calling_it(env):
    """`Depends(require_admin)` (no parentheses) runs NO check at all."""
    import inspect

    app, _raw, dep = env
    factories = {dep.require_admin, dep.require_manager_or_admin}
    bad = []

    def visit(dependant, route):
        for sub in dependant.dependencies:
            if sub.call in factories:
                bad.append(route)
            visit(sub, route)

    def walk(routes):
        for r in routes:
            if hasattr(r, "dependant"):
                visit(r.dependant, f"{sorted(r.methods or [])} {r.path}")
            inner = getattr(r, "original_router", None)
            if inner is not None:
                walk(inner.routes)

    walk(app.routes)
    assert not bad, f"Routes with an uncalled dependency factory (no auth): {sorted(set(bad))}"


def test_licensee_admin_cannot_edit_the_platform_website(client, env):
    admin = _auth(env, "only_finix-admin")
    assert client.put("/api/website-config", json={"site_name": "defaced"}, headers=admin).status_code == 403
    assert client.post("/api/website-config/reset", headers=admin).status_code == 403
    assert client.get("/api/website-config/admin", headers=admin).status_code == 403
    assert client.get("/api/website-config/public").status_code == 200  # public site stays public


def test_platform_owner_check_accepts_the_owner_and_rejects_everyone_else():
    from types import SimpleNamespace

    from fastapi import HTTPException

    from backend.website_config import require_platform_owner

    checker = require_platform_owner()
    owner = SimpleNamespace(id="o", email="info.taskosphere@gmail.com", role="admin",
                            identity_type="platform_owner")
    licensee_admin = SimpleNamespace(id="a", email="admin@customer.test", role="admin",
                                     identity_type="licensee_admin", license_id="lic-1",
                                     commercial_customer_id="c1")
    assert _run(checker(current_user=owner)) is owner
    with pytest.raises(HTTPException) as exc:
        _run(checker(current_user=licensee_admin))
    assert exc.value.status_code == 403


def test_ai_workflow_routes_are_limited_to_the_callers_company(client, env):
    admin = _auth(env, "everything-admin")
    assert client.get("/api/ai/workflow/kpis?company_id=other_co", headers=admin).status_code == 403
    assert client.get("/api/ai/workflow/kpis", headers=admin).status_code == 200
    assert client.get("/api/ai/workflow/kpis?company_id=everything", headers=admin).status_code == 200


def test_security_events_are_limited_to_the_callers_company(client, env):
    raw = env[1]
    _run(raw.security_events.delete_many({}))
    _run(raw.security_events.insert_many([
        {"id": "e1", "company_id": "everything", "severity": "warning", "details": "mine",
         "created_at": "2026-10-01"},
        {"id": "e2", "company_id": "other_co", "severity": "critical", "details": "theirs",
         "created_at": "2026-10-02"},
    ]))
    mine = client.get("/api/security/events", headers=_auth(env, "everything-admin")).json()
    assert [e["id"] for e in mine] == ["e1"]
    scan = client.get("/api/security/scan", headers=_auth(env, "everything-admin")).json()
    assert scan["critical_events_detected"] == 0 and scan["warning_events_detected"] == 1


def test_activity_report_can_only_be_pushed_for_yourself(client, env):
    staff = _auth(env, "only_finix-staff")
    other = {"user_id": "only_taskosphere-staff", "date": "2026-10-17", "activeSeconds": 5}
    assert client.post("/api/activity/report", json=other, headers=staff).status_code == 403
    own = {"user_id": "only_finix-staff", "date": "2026-10-17", "activeSeconds": 5}
    assert client.post("/api/activity/report", json=own, headers=staff).status_code == 200


def test_whatsapp_bridge_callbacks_need_the_shared_secret(client, monkeypatch):
    monkeypatch.setenv("WA_BRIDGE_SECRET", "bridge-secret-for-tests")
    for path in ("/api/whatsapp/hub/webhook/message", "/api/whatsapp/webhook/connected"):
        assert client.post(path, json={}).status_code == 401
        assert client.post(path, json={}, headers={"X-WA-Bridge-Secret": "wrong"}).status_code == 401
        ok = client.post(path, json={}, headers={"X-WA-Bridge-Secret": "bridge-secret-for-tests"})
        assert ok.status_code == 200, (path, ok.status_code, ok.text)


# --------------------------------------------------------------------------- #
# 5. Every sellable page can actually be delegated to a user
# --------------------------------------------------------------------------- #

def test_every_sellable_page_flag_exists_on_the_user_permissions_model():
    """A page flag the model lacks is silently dropped from every non-admin user.

    The licensee admin could tick the page for a user and it would never take
    effect (this happened for Zero-touch Entry, GST Portal Sync, Accounting
    Integrity, Extended Reports and Automation Approvals).
    """
    from backend.modules.people_matrix.models_users import UserPermissions
    from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

    fields = set(UserPermissions.model_fields)
    missing = [
        (module_id, flag)
        for module_id, module in MODULE_HIERARCHY.items()
        for flag in [module.get("flag"), *[p.get("flag") for p in module.get("pages", [])]]
        if flag and flag not in fields
    ]
    assert not missing, f"Sellable flags the permissions model would drop: {missing}"


def test_staff_of_a_fully_licensed_tenant_can_use_every_module_they_were_given(client, env):
    headers = _auth(env, "everything-staff")
    blocked = []
    for paths in MODULE_ROUTES.values():
        for path in paths:
            r = client.get(path, headers=headers)
            if r.status_code == 403:
                blocked.append((path, r.json().get("detail")))
    assert not blocked, blocked


# --------------------------------------------------------------------------- #
# 6. Database isolation between licensees
# --------------------------------------------------------------------------- #

def _wa_env(monkeypatch, sessions):
    """Stand in for the WhatsApp bridge; return the list of sends it received."""
    import backend.whatsapp_integration as wa

    sent = []

    async def fake_sessions():
        return sessions

    async def fake_post(path, payload=None, *args, **kwargs):
        sent.append((path, payload))
        return {"success": True, "messageId": "m1"}

    monkeypatch.setattr(wa, "_get_cached_sessions", fake_sessions)
    monkeypatch.setattr(wa, "_bridge_post", fake_post)
    return sent


def test_whatsapp_numbers_belong_to_one_company(client, env, monkeypatch):
    raw = env[1]
    _run(raw.whatsapp_sessions.delete_many({}))
    _run(raw.whatsapp_sessions.insert_many([
        {"session_id": "wa_mine", "company_id": "everything", "label": "mine", "added_by": "everything-admin"},
        {"session_id": "wa_theirs", "company_id": "other_co", "label": "THEIR-LINE", "added_by": "other_co-admin"},
    ]))
    sent = _wa_env(monkeypatch, [
        {"sessionId": "wa_mine", "status": "connected", "phoneNumber": "+1"},
        {"sessionId": "wa_theirs", "status": "connected", "phoneNumber": "+2", "displayName": "THEIR-LINE"},
    ])
    admin = _auth(env, "everything-admin")

    listed = client.get("/api/whatsapp/sessions", headers=admin).json()["sessions"]
    assert [s["sessionId"] for s in listed] == ["wa_mine"]

    # Cannot send from another company's number - directly, in bulk, scheduled or via the hub.
    body = {"to": "919999999999", "message": "hi", "session_id": "wa_theirs"}
    assert client.post("/api/whatsapp/send", json=body, headers=admin).status_code == 403
    assert client.post("/api/whatsapp/send/bulk", headers=admin,
                       json={"recipients": ["919999999999"], "message": "hi", "session_id": "wa_theirs"}).status_code == 403
    assert client.post("/api/whatsapp/hub/reply", headers=admin,
                       json={"jid": "919@s.whatsapp.net", "message": "hi", "session_id": "wa_theirs"}).status_code == 403
    assert sent == []

    # Own number works, and with no number chosen the company's own one is used - never the bridge default.
    assert client.post("/api/whatsapp/send", json={**body, "session_id": "wa_mine"}, headers=admin).status_code == 200
    assert client.post("/api/whatsapp/hub/reply", headers=admin,
                       json={"jid": "919@s.whatsapp.net", "message": "hi"}).status_code == 200
    assert {p["sessionId"] for _path, p in sent} == {"wa_mine"}

    # A company with no number of its own cannot borrow someone else's.
    other = _auth(env, "only_finix-admin")
    assert client.post("/api/whatsapp/hub/reply", headers=other,
                       json={"jid": "919@s.whatsapp.net", "message": "hi"}).status_code in (403, 503)


def test_whatsapp_bridge_callbacks_are_stored_under_the_owning_company(client, env, monkeypatch):
    monkeypatch.setenv("WA_BRIDGE_SECRET", "bridge-secret-for-tests")
    raw = env[1]
    _run(raw.whatsapp_sessions.delete_many({}))
    _run(raw.whatsapp_hub_contacts.delete_many({}))
    _run(raw.whatsapp_hub_messages.delete_many({}))
    _run(raw.whatsapp_sessions.insert_one(
        {"session_id": "wa_b", "company_id": "other_co", "label": "b", "added_by": "other_co-admin"}))
    r = client.post("/api/whatsapp/hub/webhook/message", headers={"X-WA-Bridge-Secret": "bridge-secret-for-tests"},
                    json={"jid": "919@s.whatsapp.net", "session_id": "wa_b", "message_id": "m1", "body": "hello"})
    assert r.status_code == 200, r.text
    contact = _run(raw.whatsapp_hub_contacts.find_one({"jid": "919@s.whatsapp.net"}))
    message = _run(raw.whatsapp_hub_messages.find_one({"message_id": "m1"}))
    assert contact["company_id"] == "other_co"
    assert message["company_id"] == "other_co"
    # The other company's inbox cannot see it.
    assert client.get("/api/whatsapp/hub/inbox", headers=_auth(env, "everything-admin")).json()["contacts"] == []


def test_device_command_queue_is_limited_to_the_callers_devices(client, env):
    raw = env[1]
    _run(raw.identix_devices.delete_many({}))
    _run(raw.identix_cmd_queue.delete_many({}))
    _run(raw.identix_devices.insert_many([
        {"id": "d1", "company_id": "everything", "serial_number": "SN-MINE", "name": "mine"},
        {"id": "d2", "company_id": "other_co", "serial_number": "SN-THEIRS", "name": "theirs"},
    ]))
    _run(raw.identix_cmd_queue.insert_many([
        {"cmd_id": "c1", "device_serial": "SN-MINE", "status": "pending", "created_at": "2026-10-01"},
        {"cmd_id": "c2", "device_serial": "SN-THEIRS", "status": "pending", "created_at": "2026-10-01"},
    ]))
    admin = _auth(env, "everything-admin")
    listed = client.get("/api/identix/cmd-queue", headers=admin).json()
    assert [c["cmd_id"] for c in listed["commands"]] == ["c1"]
    assert client.get("/api/identix/cmd-queue?device_serial=SN-THEIRS", headers=admin).json()["total"] == 0
    assert client.delete("/api/identix/cmd-queue", headers=admin).status_code == 200
    assert _run(raw.identix_cmd_queue.count_documents({"cmd_id": "c2"})) == 1  # untouched
    assert _run(raw.identix_cmd_queue.count_documents({"cmd_id": "c1"})) == 0


def test_company_data_never_appears_in_another_companys_reads(client, env):
    """Black-box: put marker data for company B in every collection, read as A."""
    import json
    import re
    import signal
    from pathlib import Path

    from backend.tenant_runtime import TENANT_COLLECTIONS
    from backend.tests.test_collection_classification_audit import _referenced_collections

    app, raw, _dep = env
    skip = {"users", "companies", "commercial_licenses", "commercial_license_customers"}
    names = sorted((_referenced_collections(Path(__file__).resolve().parents[1]) | set(TENANT_COLLECTIONS)) - skip)

    async def seed():
        for name in names:
            for co in ("everything", "other_co"):
                try:
                    await raw[name].insert_one({
                        "id": f"iso-{co}-{name}", "company_id": co, "user_id": f"{co}-admin",
                        "created_by": f"{co}-admin", "assigned_to": f"{co}-admin", "status": "active",
                        "name": f"ISO_{co}_{name}", "title": f"ISO_{co}_{name}", "date": "2026-10-01",
                    })
                except Exception:
                    pass

    _run(seed())
    skip_prefix = ("/api/app-backup", "/api/whatsapp", "/api/email", "/api/desktop", "/api/client-portal")
    paths = [
        re.sub(r"\{[^}]+\}", "x", p) for p, ops in app.openapi()["paths"].items()
        if "get" in ops and "{" not in p and not p.startswith(skip_prefix) and "download" not in p
    ]

    class _Timeout(BaseException):
        pass

    def _on_alarm(*_a):
        raise _Timeout()

    old = signal.signal(signal.SIGALRM, _on_alarm)
    headers = _auth(env, "everything-admin")
    leaks, own = [], 0
    try:
        for path in paths:
            signal.alarm(5)
            try:
                text = client.get(path, headers=headers).text
            except _Timeout:
                continue
            finally:
                signal.alarm(0)
            if "ISO_other_co_" in text:
                leaks.append((path, sorted(set(re.findall(r"ISO_other_co_[a-z_0-9]+", text)))))
            own += "ISO_everything_" in text
    finally:
        signal.signal(signal.SIGALRM, old)
    assert not leaks, f"Another company's data was returned: {leaks}"
    assert own >= 20, "the detector found too little of the caller's own data to be meaningful"


def test_company_unique_indexes_do_not_collide_between_companies():
    import asyncio

    from backend.server_modules.startup_indexes import make_unique_per_company

    async def go():
        coll = mongomock_motor.AsyncMongoMockClient()["idx"].holidays
        await coll.create_index("date", unique=True)  # the old platform-wide index
        await make_unique_per_company(coll, "date")
        await coll.insert_one({"company_id": "a", "date": "2026-10-20"})
        await coll.insert_one({"company_id": "b", "date": "2026-10-20"})  # was a DuplicateKeyError
        with pytest.raises(Exception):
            await coll.insert_one({"company_id": "a", "date": "2026-10-20"})

    asyncio.new_event_loop().run_until_complete(go())


# --------------------------------------------------------------------------- #
# Licence lifecycle and seats
# --------------------------------------------------------------------------- #

def _licence(env, cust, **fields):
    _run(env[1].commercial_licenses.update_one({"id": f"lic-{cust}"}, {"$set": fields}))


@pytest.fixture()
def lifecycle_tenant(env):
    """A fresh two-module tenant for each test, so edits never bleed over."""
    _run(_seed(env[1], "life", ["finix", "taskosphere"]))
    _licence(env, "life", status="active", expires_at=FUTURE, max_users=50,
             modules=["finix", "taskosphere"], licensed_modules=["finix", "taskosphere"])
    return {role: _auth(env, f"life-{role}") for role in ("admin", "staff")}


def _reach(client, headers):
    return client.get("/api/invoices", headers=headers).status_code, client.get("/api/tasks", headers=headers).status_code


@pytest.mark.parametrize("state", ["suspended", "revoked", "cancelled", "expired", "inactive"])
def test_a_licence_that_is_not_active_locks_every_user_out_immediately(client, env, lifecycle_tenant, state):
    _licence(env, "life", status=state)
    for role, headers in lifecycle_tenant.items():
        assert _reach(client, headers) == (403, 403), f"{role} still works on a {state} licence"


def test_an_expired_or_malformed_expiry_date_locks_the_tenant(client, env, lifecycle_tenant):
    past = (dt.datetime.utcnow() - dt.timedelta(days=1)).isoformat()
    for value in (past, "not-a-date"):
        _licence(env, "life", expires_at=value)
        for headers in lifecycle_tenant.values():
            assert _reach(client, headers) == (403, 403), value


def test_trial_licences_work_and_renewal_restores_access_without_a_new_login(client, env, lifecycle_tenant):
    _licence(env, "life", status="trial")
    assert all(_reach(client, h) == (200, 200) for h in lifecycle_tenant.values())
    _licence(env, "life", status="suspended")
    assert all(_reach(client, h) == (403, 403) for h in lifecycle_tenant.values())
    _licence(env, "life", status="active")  # the SAME tokens come back to life
    assert all(_reach(client, h) == (200, 200) for h in lifecycle_tenant.values())


def test_removing_a_module_or_a_page_takes_effect_on_the_next_request(client, env, lifecycle_tenant):
    headers = lifecycle_tenant["staff"]
    assert _reach(client, headers) == (200, 200)
    _licence(env, "life", modules=["taskosphere"], licensed_modules=["taskosphere"])  # finix withdrawn
    assert _reach(client, headers) == (403, 200)
    _licence(env, "life", modules=["finix", "taskosphere"], licensed_modules=["finix", "taskosphere"])  # upgrade
    assert _reach(client, headers) == (200, 200)
    _licence(env, "life", selected_features={"finix": ["can_view_purchase"]})  # only one finix page left
    assert client.get("/api/invoices", headers=headers).status_code == 403
    assert client.get("/api/purchase-invoices", headers=headers).status_code == 200
    _licence(env, "life", selected_features=None)


def test_a_deleted_or_deactivated_user_s_token_stops_working(client, env, lifecycle_tenant):
    _run(_seed(env[1], "life", ["finix", "taskosphere"]))
    headers = lifecycle_tenant["staff"]
    assert client.get("/api/tasks", headers=headers).status_code == 200
    _run(env[1].users.update_one({"id": "life-staff"}, {"$set": {"is_active": False}}))
    assert client.get("/api/tasks", headers=headers).status_code in (401, 403)
    _run(env[1].users.update_one({"id": "life-staff"}, {"$set": {"is_active": True}}))
    _run(env[1].users.delete_one({"id": "life-staff"}))
    assert client.get("/api/tasks", headers=headers).status_code in (401, 403, 404)


def _staff_body(n, **extra):
    return {"full_name": f"S{n}", "email": f"s{n}@life.test", "password": "Passw0rd!x1", **extra}


def test_the_seat_limit_is_enforced_on_every_way_of_adding_a_user(client, env, lifecycle_tenant):
    pytest.importorskip("bcrypt")
    admin = lifecycle_tenant["admin"]
    used = _run(env[1].users.count_documents({"commercial_customer_id": "life"}))
    _licence(env, "life", max_users=used + 1)  # exactly one free seat
    first = client.post("/api/commercial-onboarding/create-staff", json=_staff_body(1), headers=admin)
    assert first.status_code == 200, first.text
    for path, body in (
        ("/api/commercial-onboarding/create-staff", _staff_body(2)),
        ("/api/role-admin/users", {"full_name": "R", "email": "r@life.test", "password": "Passw0rd!x1", "role_key": "staff"}),
    ):
        r = client.post(path, json=body, headers=admin)
        assert r.status_code == 403 and "limit" in r.text.lower(), (path, r.status_code, r.text[:120])
    # a seat is freed when a user is deleted
    new_id = first.json()["id"]
    assert client.delete(f"/api/users/{new_id}", headers=admin).status_code == 200
    again = client.post("/api/role-admin/users",
                        json={"full_name": "R", "email": "r@life.test", "password": "Passw0rd!x1", "role_key": "staff"},
                        headers=admin)
    assert again.status_code == 200, again.text
    # ... and the employee landed inside the tenant, not outside it
    created = _run(env[1].users.find_one({"email": "r@life.test"}))
    assert created["company_id"] == "life" and created["commercial_customer_id"] == "life"


def test_staff_cannot_create_users_and_a_requested_admin_role_is_downgraded(client, env, lifecycle_tenant):
    pytest.importorskip("bcrypt")
    r = client.post("/api/commercial-onboarding/create-staff", json=_staff_body(7), headers=lifecycle_tenant["staff"])
    assert r.status_code == 403
    r = client.post("/api/commercial-onboarding/create-staff", json=_staff_body(8, role="admin"), headers=lifecycle_tenant["admin"])
    assert r.status_code == 200 and r.json()["role"] == "staff"


def test_a_suspended_licence_cannot_add_users(client, env, lifecycle_tenant):
    pytest.importorskip("bcrypt")
    _licence(env, "life", status="suspended")
    r = client.post("/api/commercial-onboarding/create-staff", json=_staff_body(9), headers=lifecycle_tenant["admin"])
    assert r.status_code == 403


# --------------------------------------------------------------------------- #
# Every sellable page must work on its own - for staff, not only for admins
# --------------------------------------------------------------------------- #

def test_every_page_works_for_staff_when_it_is_the_only_page_sold(client, env):
    """Sell ONE page at a time. Wherever the admin gets in, the staff user must
    too (legacy per-route checks used to veto pages like Purchase on their own)."""
    from backend import commercial_module_guard as guard
    from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

    vetoed, checked, n = [], 0, 0
    for module_id, module in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        for page in module["pages"]:
            prefixes = guard.FEATURE_PREFIXES.get(module_id, {}).get(page["flag"]) or ()
            if not prefixes:
                continue
            n += 1
            cust = f"solo{n}"
            _run(_seed(env[1], cust, [module_id], {module_id: [page["flag"]]}))
            for prefix in prefixes:
                admin = client.get("/api" + prefix, headers=_auth(env, f"{cust}-admin")).status_code
                staff = client.get("/api" + prefix, headers=_auth(env, f"{cust}-staff")).status_code
                checked += 1
                if admin != 403 and staff == 403:
                    vetoed.append((module_id, page["flag"], prefix, admin, staff))
    assert checked > 80
    assert not vetoed, f"pages that work for admin but not for staff when sold alone: {vetoed}"


def test_a_purchase_only_licence_opens_purchase_and_nothing_else(client, env):
    _run(_seed(env[1], "buyonly", ["finix"], {"finix": ["can_view_purchase"]}))
    for role in ("admin", "staff"):
        headers = _auth(env, f"buyonly-{role}")
        assert client.get("/api/purchase-invoices", headers=headers).status_code == 200
        assert client.get("/api/purchase-payments", headers=headers).status_code == 200
        for closed in ("/api/invoices", "/api/bank-accounts", "/api/zte/documents", "/api/reports/day-book"):
            assert client.get(closed, headers=headers).status_code == 403, (role, closed)


# --------------------------------------------------------------------------- #
# Frontend/backend parity fixes
# --------------------------------------------------------------------------- #

def test_the_most_specific_prefix_decides_which_page_owns_a_route():
    from backend import commercial_module_guard as guard

    assert guard.feature_for_path("/api/compliance/salary-slips") == ("compliance", "can_view_salary_slips")
    assert guard.feature_for_path("/api/compliance/salary-slips/employees") == ("compliance", "can_view_salary_slips")
    assert guard.feature_for_path("/api/compliance/types") == ("compliance", "can_view_compliance")
    assert guard.feature_for_path("/api/v2/exports/ledger") == ("finix", "finix_ledger_data")


def test_salary_slips_page_works_without_the_compliance_page(client, env):
    _run(_seed(env[1], "slips", ["compliance"], {"compliance": ["can_view_salary_slips"]}))
    _run(_seed(env[1], "cpl", ["compliance"], {"compliance": ["can_view_compliance"]}))
    for role in ("admin", "staff"):
        assert client.get("/api/compliance/salary-slips", headers=_auth(env, f"slips-{role}")).status_code != 403
        # the Compliance page does not buy the Salary Slips page
        assert client.get("/api/compliance/salary-slips", headers=_auth(env, f"cpl-{role}")).status_code == 403


def test_a_dashboard_page_gets_its_own_summary_but_not_the_raw_lists(client, env):
    _run(_seed(env[1], "dashc", ["compliance"], {"compliance": ["can_view_compliance_dashboard"]}))
    _run(_seed(env[1], "dashf", ["finix"], {"finix": ["can_view_finix_dashboard"]}))
    for role in ("admin", "staff"):
        c = _auth(env, f"dashc-{role}")
        assert client.get("/api/compliance/dashboard/summary", headers=c).status_code == 200
        assert client.get("/api/compliance/salary-slips/dashboard-summary", headers=c).status_code == 200
        assert client.get("/api/gst-reconciliation/dashboard-summary", headers=c).status_code == 200
        assert client.get("/api/compliance/salary-slips", headers=c).status_code == 403
        f = _auth(env, f"dashf-{role}")
        assert client.get("/api/invoices/orphan-notes", headers=f).status_code == 200
        assert client.get("/api/invoices", headers=f).status_code == 403


def test_chart_of_accounts_is_a_read_only_lookup_for_finix_pages(client, env):
    for role in ("admin", "staff"):
        buy = _auth(env, f"buyonly-{role}")  # Purchase page only
        assert client.get("/api/chart-of-accounts", headers=buy).status_code == 200
        assert client.post("/api/chart-of-accounts", json={}, headers=buy).status_code == 403
        assert client.get("/api/chart-of-accounts", headers=_auth(env, f"only_taskosphere-{role}")).status_code == 403
        # bank accounts hold balances: the Bank page is still required
        assert client.get("/api/bank-accounts", headers=buy).status_code == 403


def test_finix_payments_and_products_need_finix(client, env):
    for role in ("admin", "staff"):
        for path in ("/api/payments", "/api/products"):
            assert client.get(path, headers=_auth(env, f"only_taskosphere-{role}")).status_code == 403, path
            assert client.get(path, headers=_auth(env, f"only_compliance-{role}")).status_code == 403, path
        assert client.get("/api/payments", headers=_auth(env, f"sales_only-{role}")).status_code != 403
        # products are the Invoicing page's catalogue: Purchase alone does not open them
        assert client.get("/api/products", headers=_auth(env, f"buyonly-{role}")).status_code == 403


def test_trademark_root_routes_need_the_trademark_page(client, env):
    _run(_seed(env[1], "tmk", ["compliance"], {"compliance": ["can_view_trademark_sphere"]}))
    for role in ("admin", "staff"):
        for path in ("/api/check", "/api/search", "/api/watchlist"):
            assert client.get(path, headers=_auth(env, f"only_finix-{role}")).status_code == 403, path
            assert client.get(path, headers=_auth(env, f"only_taskosphere-{role}")).status_code == 403, path
            assert client.get(path, headers=_auth(env, f"tmk-{role}")).status_code != 403, path


def test_reminders_and_staff_activity_reads_need_their_module(client, env):
    for role in ("admin", "staff"):
        assert client.get("/api/email/reminders", headers=_auth(env, f"only_finix-{role}")).status_code == 403
        assert client.get("/api/email/reminders", headers=_auth(env, f"only_taskosphere-{role}")).status_code != 403
    # staff activity (decided 28 Oct 2026): admins read everyone's; staff see
    # their OWN activity by default (the licence grants the page flag), and an
    # admin can still revoke it per user in the Permission Matrix.
    assert client.get("/api/desktop/activity", headers=_auth(env, "only_taskosphere-admin")).status_code != 403
    assert client.get("/api/desktop/activity", headers=_auth(env, "only_taskosphere-staff")).status_code != 403


def test_a_manager_cannot_change_permissions_of_a_user_in_another_company(client, env, monkeypatch):
    import backend.permission_governance as pg

    _run(env[1].users.replace_one(
        {"id": "only_taskosphere-mgr"},
        {"id": "only_taskosphere-mgr", "email": "mgr@only_taskosphere.test", "full_name": "Mgr", "role": "manager",
         "company_id": "only_taskosphere", "license_id": "lic-only_taskosphere",
         "commercial_customer_id": "only_taskosphere", "is_active": True, "hashed_password": "x",
         "permissions": {"can_manage_users": True, "can_view_user_page": True}},
        upsert=True,
    ))

    async def fake_team(_manager_id):
        return ["other_co-staff"]  # a user that belongs to a different company

    monkeypatch.setattr(pg, "get_team_user_ids", fake_team)
    r = client.put("/api/users/other_co-staff/permissions", json={"can_view_tasks": True},
                   headers=_auth(env, "only_taskosphere-mgr"))
    assert r.status_code in (403, 404), r.text
    stored = _run(env[1].users.find_one({"id": "other_co-staff"}))
    assert not (stored.get("permissions") or {}).get("can_view_tasks")
