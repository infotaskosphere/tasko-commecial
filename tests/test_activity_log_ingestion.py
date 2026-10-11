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
