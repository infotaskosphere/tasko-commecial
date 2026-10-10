"""Regression tests for the licensing / permission audit fixes (2026-10-10).

Covers:
  * the public license-key setup (/create-admin) can never bind a Platform Owner email
  * the request guard fails closed for commercial accounts without a valid license
  * Permission Matrix actions (view/create/edit/delete) are enforced per request
  * the Permission Matrix save is capped to the license at page AND action level
  * the license cap in /auth/me is a ceiling, not an overwrite
  * audit logs are tenant scoped (no licensee <-> owner / licensee <-> licensee leak)
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend import commercial_module_guard as guard
from backend.models import User


def _req(path: str, method: str = "GET") -> Request:
    return Request({"type": "http", "method": method, "path": "/api" + path, "headers": []})


LICENSE = {
    "id": "lic-1",
    "customer_id": "cust-1",
    "status": "active",
    "page_catalog_version": 2,
    "modules": ["taskosphere", "finix"],
    "selected_features": {
        "taskosphere": ["can_view_dashboard", "can_view_tasks"],
        "finix": ["can_view_sale"],
    },
}


def _staff(matrix=None) -> User:
    perms = {
        "can_access_taskosphere": True,
        "can_view_dashboard": True,
        "can_view_tasks": True,
        "can_access_finix": True,
        "can_view_sale": True,
    }
    if matrix is not None:
        perms["governance_matrix"] = matrix
    return User(
        id="staff-1",
        email="staff@example.com",
        role="staff",
        company_id="company-a",
        commercial_customer_id="cust-1",
        license_id="lic-1",
        permissions=perms,
    )


def _admin() -> User:
    return User(
        id="admin-1",
        email="admin@example.com",
        role="admin",
        company_id="company-a",
        commercial_customer_id="cust-1",
        license_id="lic-1",
    )


async def _run_guard(monkeypatch, user, license_doc, path, method="GET"):
    async def fake_base(_credentials):
        return user

    async def fake_license(_user, *_args, **_kwargs):
        return license_doc

    async def fake_sync(_user, _license):
        return _user

    monkeypatch.setattr(guard, "_BASE_GET_CURRENT_USER", fake_base)
    monkeypatch.setattr(guard, "_commercial_license", fake_license)
    monkeypatch.setattr("backend.commercial_licensee_admin.sync_user_to_licensee_admin", fake_sync)
    return await guard.get_current_user_with_commercial_guard(
        _req(path, method), credentials=type("Creds", (), {"credentials": "t"})()
    )


# --------------------------------------------------------------------------
# Action enforcement
# --------------------------------------------------------------------------

def test_required_action_mapping():
    assert guard._required_action("GET", "/api/tasks") == "view"
    assert guard._required_action("POST", "/tasks") == "create"
    assert guard._required_action("PUT", "/tasks/1") == "edit"
    assert guard._required_action("PATCH", "/tasks/1") == "edit"
    assert guard._required_action("DELETE", "/tasks/1") == "delete"
    assert guard._required_action("POST", "/tasks/search") == "view"
    assert guard._required_action("GET", "/invoicing/export") == "export"
    assert guard._required_action("POST", "/quotations/5/approve") == "approve"


async def test_view_only_matrix_blocks_writes_but_allows_reads(monkeypatch):
    matrix = {"taskosphere.can_view_tasks": ["view"]}
    await _run_guard(monkeypatch, _staff(matrix), LICENSE, "/tasks", "GET")
    await _run_guard(monkeypatch, _staff(matrix), LICENSE, "/tasks/search", "POST")
    for method, path in (("POST", "/tasks"), ("PUT", "/tasks/1"), ("DELETE", "/tasks/1")):
        with pytest.raises(HTTPException) as exc:
            await _run_guard(monkeypatch, _staff(matrix), LICENSE, path, method)
        assert exc.value.status_code == 403


async def test_edit_granted_but_create_and_delete_still_denied(monkeypatch):
    matrix = {"taskosphere.can_view_tasks": ["view", "update"]}  # "update" == edit
    await _run_guard(monkeypatch, _staff(matrix), LICENSE, "/tasks/1", "PUT")
    for method, path in (("POST", "/tasks"), ("DELETE", "/tasks/1")):
        with pytest.raises(HTTPException):
            await _run_guard(monkeypatch, _staff(matrix), LICENSE, path, method)


async def test_page_without_matrix_row_keeps_page_level_behaviour(monkeypatch):
    await _run_guard(monkeypatch, _staff({}), LICENSE, "/tasks", "POST")


async def test_licensee_admin_keeps_full_actions_inside_licensed_pages(monkeypatch):
    for method in ("GET", "POST", "PUT", "DELETE"):
        await _run_guard(monkeypatch, _admin(), LICENSE, "/tasks", method)


async def test_licensee_admin_cannot_reach_unselected_page(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        await _run_guard(monkeypatch, _admin(), LICENSE, "/purchase", "GET")
    assert exc.value.status_code == 403


# --------------------------------------------------------------------------
# Fail closed
# --------------------------------------------------------------------------

async def test_commercial_account_without_valid_license_is_denied(monkeypatch):
    with pytest.raises(HTTPException) as exc:
        await _run_guard(monkeypatch, _admin(), None, "/tasks", "GET")
    assert exc.value.status_code == 403
    # auth endpoints stay reachable so the client can show the message / sign out
    user = await _run_guard(monkeypatch, _admin(), None, "/auth/me", "GET")
    assert user.email == "admin@example.com"


async def test_internal_account_without_license_markers_is_unchanged(monkeypatch):
    internal = User(id="int-1", email="int@example.com", role="admin", company_id="company-int")
    user = await _run_guard(monkeypatch, internal, None, "/tasks", "GET")
    assert user.id == "int-1"


# --------------------------------------------------------------------------
# Permission Matrix save ceiling
# --------------------------------------------------------------------------

ACTOR = SimpleNamespace(
    id="admin-1", role="admin", company_id="company-a",
    license_id="lic-1", commercial_customer_id="cust-1", identity_type="licensee_admin",
)


async def test_save_is_capped_to_license_pages_and_actions(monkeypatch):
    from backend import permission_governance as pg

    async def fake_resolve(_actor):
        return LICENSE

    monkeypatch.setattr(pg, "_resolve_actor_license", fake_resolve)
    payload = {
        "can_access_taskosphere": True,
        "can_view_tasks": True,
        "can_view_bank": True,            # finix page NOT selected
        "can_access_compliance": True,    # module NOT licensed
        "can_view_compliance": True,
        "can_edit_clients": True,         # legacy flag, records NOT licensed
        "governance_matrix": {
            "taskosphere.can_view_tasks": ["view", "create", "edit", "delete", "fly"],
            "finix.can_view_bank": ["view"],
            "bogus.page": ["view"],
        },
    }
    out = await pg._cap_permissions_to_license(payload, ACTOR)
    assert out["can_view_tasks"] is True
    assert out["can_view_bank"] is False
    assert out["can_access_compliance"] is False
    assert out["can_view_compliance"] is False
    assert out["can_edit_clients"] is False
    assert out["governance_matrix"]["taskosphere.can_view_tasks"] == ["view", "create", "edit", "delete"]
    assert "finix.can_view_bank" not in out["governance_matrix"]
    assert "bogus.page" not in out["governance_matrix"]


async def test_save_refused_when_license_cannot_be_resolved(monkeypatch):
    from backend import permission_governance as pg

    async def fake_resolve(_actor):
        return None

    monkeypatch.setattr(pg, "_resolve_actor_license", fake_resolve)
    with pytest.raises(HTTPException) as exc:
        await pg._cap_permissions_to_license({"can_view_tasks": True}, ACTOR)
    assert exc.value.status_code == 403


async def test_manager_cannot_grant_actions_they_do_not_hold(monkeypatch):
    from backend import permission_governance as pg

    async def fake_resolve(_actor):
        return LICENSE

    monkeypatch.setattr(pg, "_resolve_actor_license", fake_resolve)
    out = await pg._cap_permissions_to_license(
        {"can_view_tasks": True,
         "governance_matrix": {"taskosphere.can_view_tasks": ["view", "edit", "delete"]}},
        ACTOR,
        {"governance_matrix": {"taskosphere.can_view_tasks": ["view", "edit"]}},
    )
    assert out["governance_matrix"]["taskosphere.can_view_tasks"] == ["view", "edit"]


# --------------------------------------------------------------------------
# /auth/me license cap is a ceiling, not an overwrite
# --------------------------------------------------------------------------

def _doc(role, perms):
    return {
        "id": "u1", "email": "u@example.com", "full_name": "U", "role": role,
        "company_id": "company-a", "permissions": perms,
        "licensed_modules": ["taskosphere", "finix"],
        "selected_features": LICENSE["selected_features"],
    }


def test_license_cap_does_not_grant_pages_the_user_was_never_given():
    from backend.commercial_entitlement_runtime import apply_license_cap

    out = apply_license_cap(_doc("staff", {"can_access_taskosphere": True, "can_view_tasks": True}))
    perms = out["permissions"]
    assert perms["can_view_tasks"] is True      # granted AND licensed
    assert perms["can_view_sale"] is False      # licensed but never granted to this user
    assert perms["can_view_purchase"] is False  # not licensed


def test_license_cap_covers_catalog_pages_the_old_list_missed():
    from backend.commercial_entitlement_runtime import apply_license_cap

    out = apply_license_cap(_doc("admin", {}))
    perms = out["permissions"]
    assert perms["can_view_sale"] is True
    assert perms["can_view_finix_dashboard"] is False       # in catalog, not selected
    assert perms["can_view_records_dashboard"] is False     # module not licensed


# --------------------------------------------------------------------------
# governance_core: commercial admin is capped by selected pages
# --------------------------------------------------------------------------

def _gov_admin():
    return SimpleNamespace(
        id="a1", role="admin", company_id="company-a",
        licensed_modules=["finix", "people_matrix"],
        selected_features={"finix": ["can_view_sale"], "people_matrix": ["can_view_hr"]},
        permissions={"can_access_finix": True, "can_access_people_matrix": True},
    )


def test_governance_core_admin_is_capped_by_selected_pages():
    from backend.governance_core import has_page_access

    admin = _gov_admin()
    assert has_page_access(admin, "finix", "can_view_sale") is True
    assert has_page_access(admin, "finix", "can_view_purchase") is False
    # manage flags follow their can_view_* page
    assert has_page_access(admin, "people_matrix", "can_manage_hr") is True
    assert has_page_access(admin, "people_matrix", "can_manage_payroll") is False


# --------------------------------------------------------------------------
# Tenant isolation of audit logs
# --------------------------------------------------------------------------

class _FakeCollection:
    def __init__(self):
        self.last_query = None
        self.inserted = None

    def find(self, query=None, *a, **k):
        self.last_query = query
        return self

    async def insert_one(self, doc, *a, **k):
        self.inserted = doc


def test_audit_logs_are_a_tenant_collection():
    from backend.tenant_runtime import TENANT_COLLECTIONS

    assert "audit_logs" in TENANT_COLLECTIONS


def test_licensee_only_sees_and_writes_its_own_audit_rows():
    from backend.tenant_runtime import (
        TenantAwareCollection, reset_authenticated_company, set_authenticated_company,
    )

    raw = _FakeCollection()
    wrapped = TenantAwareCollection(raw, "audit_logs")
    token = set_authenticated_company("company-a")
    try:
        wrapped.find({})
        assert raw.last_query == {"company_id": "company-a"}
        with pytest.raises(HTTPException) as exc:
            wrapped.find({"company_id": "company-b"})
        assert exc.value.status_code == 403
        asyncio.run(wrapped.insert_one({"action": "UPDATE_PERMISSIONS"}))
        assert raw.inserted["company_id"] == "company-a"
    finally:
        reset_authenticated_company(token)


def test_platform_owner_operational_context_cannot_read_a_licensee_audit_trail():
    from backend.tenant_runtime import (
        TenantAwareCollection, reset_authenticated_company, reset_platform_owner,
        set_authenticated_company, set_platform_owner,
    )

    raw = _FakeCollection()
    wrapped = TenantAwareCollection(raw, "audit_logs")
    t1 = set_authenticated_company("owner-company")
    t2 = set_platform_owner(True)
    try:
        wrapped.find({})
        assert raw.last_query == {"company_id": "owner-company"}
        with pytest.raises(HTTPException) as exc:
            wrapped.find({"company_id": "licensee-company"})
        assert exc.value.status_code == 403
    finally:
        reset_platform_owner(t2)
        reset_authenticated_company(t1)


def test_platform_owner_operational_reads_stay_in_the_owner_company():
    """Regression: the isolation wrapper's own frame used to make every owner
    query look like a control-plane call, returning ALL licensees' data."""
    from backend.tenant_runtime import (
        TenantAwareCollection, reset_authenticated_company, reset_platform_owner,
        set_authenticated_company, set_platform_owner,
    )

    for collection in ("tasks", "invoices", "clients", "audit_logs"):
        raw = _FakeCollection()
        wrapped = TenantAwareCollection(raw, collection)
        t1 = set_authenticated_company("owner-company")
        t2 = set_platform_owner(True)
        try:
            wrapped.find({})
            assert raw.last_query == {"company_id": "owner-company"}, collection
        finally:
            reset_platform_owner(t2)
            reset_authenticated_company(t1)


def test_real_control_plane_callers_still_cross_tenants_for_the_owner():
    from backend.tenant_runtime import (
        TenantAwareCollection, reset_authenticated_company, reset_platform_owner,
        set_authenticated_company, set_platform_owner,
    )

    raw = _FakeCollection()
    wrapped = TenantAwareCollection(raw, "tasks")
    namespace = {"__name__": "backend.commercial_console_probe", "wrapped": wrapped}
    exec("def run():\n    return wrapped.find({})", namespace)
    t1 = set_authenticated_company("owner-company")
    t2 = set_platform_owner(True)
    try:
        namespace["run"]()
        assert raw.last_query == {}  # commercial console is intentionally cross-tenant
    finally:
        reset_platform_owner(t2)
        reset_authenticated_company(t1)


# --------------------------------------------------------------------------
# Public license-key setup can never bind a Platform Owner address
# --------------------------------------------------------------------------

def test_create_admin_route_is_the_patched_handler():
    from fastapi.routing import APIRoute

    from backend.commercial_onboarding import router

    routes = [
        r for r in router.routes
        if isinstance(r, APIRoute)
        and r.path == "/commercial-onboarding/create-admin"
        and "POST" in (r.methods or set())
    ]
    assert routes, "create-admin route not found"
    assert {r.endpoint.__name__ for r in routes} == {"create_customer_admin_fixed"}


@pytest.mark.parametrize("email", [
    "info.taskosphere@gmail.com", "INFOTASKOSPHERE@gmail.com",
    "admin@taskosphere.com", "csmanthandesai@gmail.com",
])
async def test_create_admin_rejects_platform_owner_emails(monkeypatch, email):
    from backend import commercial_onboarding_admin_compat as ac

    class _NoUsers:
        async def find_one(self, *_a, **_k):
            return None

    async def fake_find(_key, _company):
        return {"id": "cust-1", "email": "owner@acme.test"}, dict(LICENSE, license_key="KEY")

    async def fake_company(_customer, _license):
        return {"id": "company-a", "name": "Acme"}

    monkeypatch.setattr(ac, "_find_customer_for_license", fake_find)
    monkeypatch.setattr(ac, "_ensure_company_master", fake_company)
    monkeypatch.setattr(ac, "_raw_db", lambda: SimpleNamespace(users=_NoUsers()))

    with pytest.raises(HTTPException) as exc:
        await ac.create_customer_admin_fixed({
            "license_key": "key", "company_name": "Acme",
            "full_name": "Eve", "email": email, "password": "longenough1",
        })
    assert exc.value.status_code == 409


def test_blank_company_filter_means_own_company_for_owner_and_tenant():
    from backend import tenant_runtime as tr

    token_owner = tr.set_platform_owner(True)
    tr.set_authenticated_company("owner-co")
    assert tr._scope_query({"company_id": ""}) == {"company_id": "owner-co"}
    assert tr._scope_replacement({"company_id": "", "code": "1"})["company_id"] == "owner-co"
    with pytest.raises(HTTPException):
        tr._scope_query({"company_id": "lic-co"})
    tr.set_platform_owner(False)
    tr.set_authenticated_company("lic-co")
    assert tr._scope_query({"company_id": " "}) == {"company_id": "lic-co"}
    with pytest.raises(HTTPException):
        tr._scope_query({"company_id": "owner-co"})
