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
