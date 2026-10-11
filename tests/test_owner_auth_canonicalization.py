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
