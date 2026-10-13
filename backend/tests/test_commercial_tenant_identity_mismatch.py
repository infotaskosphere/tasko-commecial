"""Regression tests for fail-closed commercial tenant identity resolution."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import commercial_tenant_scope as tenant_scope


class _FakeCompanies:
    async def find_one(self, query, projection=None):
        if query == {"id": "company-b"}:
            return {
                "id": "company-b",
                "commercial_customer_id": "customer-b",
                "source": "commercial-license",
            }
        return None


class _FakeDB:
    companies = _FakeCompanies()


@pytest.mark.asyncio
async def test_admin_customer_company_mismatch_fails_closed(monkeypatch):
    """An admin identity for customer A must never be silently switched to B."""
    monkeypatch.setattr(tenant_scope._dependencies, "_raw_db", _FakeDB(), raising=False)
    user = SimpleNamespace(
        role="admin",
        commercial_customer_id="customer-a",
        company_id="company-b",
        email="admin@example.invalid",
    )

    with pytest.raises(HTTPException) as exc:
        await tenant_scope._resolve_customer_id(user)

    assert exc.value.status_code == 403
    assert "not associated with the licensed company" in exc.value.detail
