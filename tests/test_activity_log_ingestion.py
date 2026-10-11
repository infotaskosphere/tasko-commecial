"""Regression coverage for tenant-safe browser activity ingestion."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend import activity_log_ingestion as ingestion
from backend.tenant_runtime import reset_platform_owner, set_platform_owner


class _CaptureCollection:
    def __init__(self):
        self.documents = []

    async def insert_one(self, document):
        self.documents.append(dict(document))


class _UnexpectedTenantWrite:
    async def insert_one(self, document):
        raise AssertionError("Platform Owner telemetry must not use the licensee collection")


@pytest.mark.asyncio
async def test_authenticated_owner_context_routes_telemetry_to_owner_collection(monkeypatch):
    owner_collection = _CaptureCollection()
    monkeypatch.setattr(
        ingestion,
        "_raw_db",
        SimpleNamespace(platform_activity_logs=owner_collection),
    )
    monkeypatch.setattr(
        ingestion,
        "db",
        SimpleNamespace(activity_logs=_UnexpectedTenantWrite()),
    )

    # Simulates a legacy Pydantic user projection that lost hierarchical
    # owner fields. The request-local auth context remains authoritative.
    user = SimpleNamespace(
        id="platform-owner-user-1",
        email="internal-owner@example.test",
        role="admin",
        company_id="owner-workspace-custom-id",
    )
    assert not ingestion.is_platform_owner(user)

    owner_token = set_platform_owner(True)
    try:
        result = await ingestion.log_browser_activity(
            {
                "app_name": "Taskosphere Web",
                "url": "https://example.test/clients?private=must-not-be-stored#section",
                "duration_seconds": 30,
            },
            current_user=user,
        )
    finally:
        reset_platform_owner(owner_token)

    assert result == {"success": True, "stored": True}
    assert len(owner_collection.documents) == 1
    entry = owner_collection.documents[0]
    assert entry["identity_type"] == "platform_owner"
    assert "company_id" not in entry
    assert entry["url"] == "https://example.test/clients"


@pytest.mark.asyncio
async def test_licensee_activity_remains_company_scoped(monkeypatch):
    tenant_collection = _CaptureCollection()
    monkeypatch.setattr(
        ingestion,
        "_raw_db",
        SimpleNamespace(platform_activity_logs=_UnexpectedTenantWrite()),
    )
    monkeypatch.setattr(
        ingestion,
        "db",
        SimpleNamespace(activity_logs=tenant_collection),
    )

    user = SimpleNamespace(
        id="licensee-admin-1",
        email="licensee@example.test",
        role="admin",
        company_id="licensee-company-1",
        commercial_customer_id="customer-1",
        license_id="license-1",
    )
    owner_token = set_platform_owner(False)
    try:
        result = await ingestion.log_browser_activity(
            {"url": "https://example.test/dashboard", "duration_seconds": 15},
            current_user=user,
        )
    finally:
        reset_platform_owner(owner_token)

    assert result == {"success": True, "stored": True}
    assert len(tenant_collection.documents) == 1
    entry = tenant_collection.documents[0]
    assert entry["identity_type"] == "licensee"
    assert entry["company_id"] == "licensee-company-1"


def test_activity_route_uses_canonical_request_auth_dependency():
    """Activity logging must use the same final auth chain as other request routes."""
    route = next(
        route for route in ingestion.router.routes
        if getattr(route, "path", None) == "/activity/log"
        and "POST" in getattr(route, "methods", set())
    )
    dependency_calls = {dependency.call for dependency in route.dependant.dependencies}
    assert ingestion._activity_current_user in dependency_calls


@pytest.mark.asyncio
async def test_activity_auth_resolves_bearer_before_final_dependency(monkeypatch):
    request = SimpleNamespace(
        url=SimpleNamespace(path="/api/activity/log"),
        headers={"authorization": "Bearer non-secret-test-token"},
    )
    credentials = SimpleNamespace(credentials="non-secret-test-token")
    user = SimpleNamespace(
        id="licensee-admin-1",
        email="licensee@example.test",
        role="admin",
        company_id="licensee-company-1",
    )
    seen = {}

    async def security(actual_request):
        seen["security_request"] = actual_request
        return credentials

    async def final_dependency(actual_request, actual_credentials):
        seen["request"] = actual_request
        seen["credentials"] = actual_credentials
        return user

    monkeypatch.setattr(ingestion._dependencies, "security", security)
    monkeypatch.setattr(ingestion._dependencies, "get_current_user", final_dependency)
    result = await ingestion._activity_current_user(request)

    assert result is user
    assert seen["security_request"] is request
    assert seen["request"] is request
    assert seen["credentials"] is credentials


def test_runtime_registers_only_the_tenant_safe_activity_writer():
    """Prevent an earlier legacy route from shadowing the owner-safe ingestion handler."""
    from backend.server import app

    try:
        from fastapi.routing import iter_route_contexts
        routes = list(iter_route_contexts(app.routes))
    except ImportError:
        # Older FastAPI versions eagerly flatten included routers.
        routes = list(app.routes)

    matches = [
        route for route in routes
        if getattr(route, "path", None) == "/api/activity/log"
        and "POST" in (getattr(route, "methods", set()) or set())
    ]

    assert len(matches) == 1, [
        (
            getattr(route, "path", None),
            getattr(route, "endpoint", None),
        )
        for route in matches
    ]
    assert matches[0].endpoint is ingestion.log_browser_activity
