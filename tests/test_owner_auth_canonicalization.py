"""Regression tests for canonical tenant context in compatibility authentication."""
from types import SimpleNamespace

import pytest

from backend import commercial_auth_bootstrap_compat as compat
from backend.tenant_runtime import (
    authenticated_company_id,
    in_platform_owner_context,
    platform_owner_company_ids,
    platform_owner_company_aliases,
    reset_authenticated_company,
    reset_platform_owner,
    reset_platform_owner_company_aliases,
    reset_platform_owner_company_ids,
    set_authenticated_company,
    set_platform_owner,
    set_platform_owner_company_aliases,
    set_platform_owner_company_ids,
)


@pytest.mark.asyncio
async def test_saas_owner_session_runs_canonical_company_scope_resolver(monkeypatch):
    owner = SimpleNamespace(
        id="owner-user",
        email="csmanthandesai@gmail.com",
        role="admin",
        company_id="stale-owner-company",
    )
    calls = []

    async def get_saas_user(token):
        assert token == "opaque-session-token"
        return owner

    async def canonicalize(user):
        calls.append(user)
        # Represents the real resolver's verified owner-company allow-list.
        object.__setattr__(user, "company_id", "74e30915-e7a8-47ec-a596-53361094bc19")
        set_platform_owner_company_ids(["74e30915-e7a8-47ec-a596-53361094bc19"])
        set_platform_owner_company_aliases({
            "stale-owner-company": "74e30915-e7a8-47ec-a596-53361094bc19"
        })
        return user

    monkeypatch.setattr(compat._dependencies, "_get_saas_session_user", get_saas_user)
    monkeypatch.setattr(compat._dependencies, "_canonicalize_platform_owner_company", canonicalize)

    company_token = set_authenticated_company("previous-company")
    owner_token = set_platform_owner(False)
    ids_token = set_platform_owner_company_ids([])
    aliases_token = set_platform_owner_company_aliases({})
    try:
        result = await compat._raw_get_current_user(
            SimpleNamespace(credentials="opaque-session-token")
        )

        assert len(calls) == 1
        assert result.company_id == "74e30915-e7a8-47ec-a596-53361094bc19"
        assert authenticated_company_id() == result.company_id
        assert in_platform_owner_context() is True
        assert platform_owner_company_ids() == frozenset({result.company_id})
        assert platform_owner_company_aliases() == {
            "stale-owner-company": result.company_id
        }
    finally:
        reset_platform_owner_company_aliases(aliases_token)
        reset_platform_owner_company_ids(ids_token)
        reset_platform_owner(owner_token)
        reset_authenticated_company(company_token)


@pytest.mark.asyncio
async def test_saas_licensee_session_clears_owner_scope(monkeypatch):
    licensee = SimpleNamespace(
        id="licensee-user",
        email="licensee@example.test",
        role="admin",
        company_id="licensee-company",
        commercial_customer_id="customer-1",
        license_id="license-1",
    )
    calls = []

    async def get_saas_user(token):
        assert token == "opaque-licensee-token"
        return licensee

    async def canonicalize(user):
        calls.append(user)
        set_platform_owner_company_ids([])
        set_platform_owner_company_aliases({})
        return user

    monkeypatch.setattr(compat._dependencies, "_get_saas_session_user", get_saas_user)
    monkeypatch.setattr(compat._dependencies, "_canonicalize_platform_owner_company", canonicalize)

    company_token = set_authenticated_company("previous-owner-company")
    owner_token = set_platform_owner(True)
    ids_token = set_platform_owner_company_ids(["previous-owner-company"])
    aliases_token = set_platform_owner_company_aliases({
        "legacy-owner-id": "previous-owner-company"
    })
    try:
        result = await compat._raw_get_current_user(
            SimpleNamespace(credentials="opaque-licensee-token")
        )

        assert len(calls) == 1
        assert result.company_id == "licensee-company"
        assert authenticated_company_id() == "licensee-company"
        assert in_platform_owner_context() is False
        assert platform_owner_company_ids() == frozenset()
        assert platform_owner_company_aliases() == {}
    finally:
        reset_platform_owner_company_aliases(aliases_token)
        reset_platform_owner_company_ids(ids_token)
        reset_platform_owner(owner_token)
        reset_authenticated_company(company_token)


@pytest.mark.asyncio
async def test_stale_configured_owner_id_aliases_only_to_verified_name_match(monkeypatch):
    from backend import dependencies

    canonical_id = "canonical-owner-company"
    stale_config_id = "platform-owner-old-hash"
    company = {
        "id": canonical_id,
        "name": "Prodigist Ventures Private Limited",
        "status": "active",
        "is_platform_owner_workspace": True,
        "created_by": "owner-user",
    }

    class FakeCollection:
        def __init__(self, rows=None):
            self.rows = list(rows or [])

        async def find_one(self, query=None, projection=None):
            query = query or {}
            for row in self.rows:
                if query.get("id") and row.get("id") != query["id"]:
                    continue
                if query.get("is_platform_owner_workspace") is True and row.get("is_platform_owner_workspace") is not True:
                    continue
                if query.get("status") == "active" and row.get("status") != "active":
                    continue
                return dict(row)
            return None

        async def update_one(self, query, update):
            for row in self.rows:
                if query.get("id") and row.get("id") != query["id"]:
                    continue
                row.update(update.get("$set") or {})
                row.update(update.get("$setOnInsert") or {})
                return None
            return None

        async def update_many(self, query, update):
            return None

    fake_db = SimpleNamespace(
        companies=FakeCollection([dict(company)]),
        commercial_licenses=FakeCollection(),
        users=FakeCollection(),
    )

    async def owner_companies(_user):
        return [dict(company)]

    monkeypatch.setattr(dependencies, "_raw_db", fake_db)
    monkeypatch.setattr(dependencies, "_owner_operational_companies", owner_companies)
    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_ID", stale_config_id)
    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_NAME", company["name"])
    monkeypatch.setenv("PLATFORM_OWNER_LEGACY_COMPANY_IDS", "")

    user = SimpleNamespace(
        id="owner-user",
        email="csmanthandesai@gmail.com",
        role="admin",
        company_id=canonical_id,
        model_dump=lambda: {
            "id": "owner-user",
            "email": "csmanthandesai@gmail.com",
            "role": "admin",
            "company_id": canonical_id,
        },
    )
    company_token = set_authenticated_company("previous-company")
    owner_token = set_platform_owner(True)
    ids_token = set_platform_owner_company_ids([])
    aliases_token = set_platform_owner_company_aliases({})
    try:
        resolved = await dependencies._canonicalize_platform_owner_company(user)
        assert resolved.company_id == canonical_id
        assert platform_owner_company_ids() == frozenset({canonical_id})
        assert platform_owner_company_aliases() == {stale_config_id: canonical_id}
    finally:
        reset_platform_owner_company_aliases(aliases_token)
        reset_platform_owner_company_ids(ids_token)
        reset_platform_owner(owner_token)
        reset_authenticated_company(company_token)
