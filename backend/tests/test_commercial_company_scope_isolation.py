"""Regression tests for company-master tenant isolation and owner recovery."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend import commercial_tenant_scope as tenant_scope
from backend import quotations
from backend import commercial_legacy_company_scope_compat as legacy_scope


class _Cursor:
    def __init__(self, documents=None):
        self.documents = list(documents or [])

    def sort(self, *args, **kwargs):
        return self

    def limit(self, *args, **kwargs):
        return self

    async def to_list(self, length=None):
        return self.documents[:length] if length is not None else self.documents


class _Collection:
    def __init__(self, one=None, many=None):
        self.one = one
        self.many = list(many or [])

    async def find_one(self, query=None, projection=None, **kwargs):
        if self.one and query == {"id": self.one.get("id")}:
            return dict(self.one)
        if self.one and query and "$and" in query:
            query_text = repr(query)
            if (
                self.one.get("commercial_customer_id") in query_text
                or self.one.get("license_id") in query_text
            ):
                return dict(self.one)
        return None

    def find(self, query=None, projection=None, **kwargs):
        return _Cursor(self.many)


class _CompanyCollection:
    def __init__(self, owner=None, counterpart=None):
        self.owner = owner
        self.counterpart = counterpart

    async def find_one(self, query=None, projection=None, **kwargs):
        query = query or {}
        if self.owner and query == {"id": self.owner.get("id")}:
            return dict(self.owner)
        if self.counterpart and "$and" in query:
            query_text = repr(query)
            same_customer = (
                self.counterpart.get("id") in query_text
                or self.counterpart.get("commercial_customer_id") in query_text
            )
            same_license = bool(
                self.counterpart.get("license_id")
                and self.counterpart.get("license_id") in query_text
            )
            if same_customer or same_license:
                return dict(self.counterpart)
        return None

    def find(self, query=None, projection=None, **kwargs):
        return _Cursor()


class _FakeRawDB:
    def __init__(self, owner_company=None, tenant_company=None, users=None):
        self.companies = _CompanyCollection(owner=owner_company, counterpart=tenant_company)
        self.users = _Collection(many=users or [])
        self.commercial_licenses = _Collection()
        self.commercial_license_customers = _Collection()


def test_shared_company_queries_never_return_owner_workspaces_to_licensees():
    token = tenant_scope.set_authenticated_customer("tenant-customer")
    try:
        customer_query = tenant_scope._customer_query("companies", {})
        legacy_query = legacy_scope._company_scope_query({})
        for query in (customer_query, legacy_query):
            assert "'is_platform_owner_workspace': {'$ne': True}" in repr(query)
            assert "owner-company" not in repr(query)
    finally:
        tenant_scope.reset_authenticated_customer(token)


def test_licensee_cannot_create_a_company_as_platform_owner_workspace():
    token = tenant_scope.set_authenticated_customer("tenant-customer")
    try:
        with pytest.raises(HTTPException) as exc:
            tenant_scope._customer_insert(
                "companies",
                {"id": "forged-owner-company", "is_platform_owner_workspace": True},
            )
        assert exc.value.status_code == 403
    finally:
        tenant_scope.reset_authenticated_customer(token)


@pytest.mark.asyncio
async def test_licensee_admin_company_id_is_repaired_from_owner_workspace(monkeypatch):
    owner = {
        "id": "owner-company",
        "name": "Prodigist Ventures Private Limited",
        "is_platform_owner_workspace": True,
        "commercial_customer_id": "tenant-customer",
        "license_id": "tenant-license",
        "created_by": "owner-user",
    }
    tenant = {
        "id": "tenant-customer",
        "name": "Manthan Desai And Associates",
        "source": "commercial-license",
        "commercial_customer_id": "tenant-customer",
        "license_id": "tenant-license",
    }
    raw = _FakeRawDB(owner_company=owner, tenant_company=tenant)
    user = SimpleNamespace(
        id="tenant-admin",
        role="admin",
        company_id="owner-company",
        commercial_customer_id="tenant-customer",
        license_id="tenant-license",
    )

    company_id, company = await tenant_scope._resolve_tenant_company_id(
        user, "tenant-customer", raw
    )
    assert company_id == "tenant-customer"
    assert company.get("name") == "Manthan Desai And Associates"
    assert company.get("is_platform_owner_workspace") is not True


@pytest.mark.asyncio
async def test_owner_workspace_markers_never_resolve_a_licensee(monkeypatch):
    owner = {
        "id": "owner-company",
        "name": "Prodigist Ventures Private Limited",
        "is_platform_owner_workspace": True,
        "commercial_customer_id": "tenant-customer",
        "license_id": "tenant-license",
        "created_by": "owner-user",
    }

    class _ResolverDB:
        companies = _Collection(one=owner)
        commercial_license_customers = _Collection()
        commercial_licenses = _Collection()

    monkeypatch.setattr(tenant_scope._dependencies, "_raw_db", _ResolverDB(), raising=False)
    monkeypatch.setattr(tenant_scope, "is_platform_owner", lambda user: False)

    user = SimpleNamespace(
        id="licensee-user",
        role="admin",
        email="licensee@example.invalid",
        company_id="owner-company",
        commercial_customer_id=None,
        license_id=None,
    )
    with pytest.raises(HTTPException) as exc:
        await tenant_scope._resolve_customer_id(user)
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_licensee_company_scope_excludes_owner_workspace(monkeypatch):
    raw = _FakeRawDB()
    monkeypatch.setattr(quotations, "_tenant_raw_db", lambda: raw)

    user = SimpleNamespace(
        id="tenant-admin",
        role="admin",
        company_id="owner-company",
        commercial_customer_id="tenant-customer",
        license_id="tenant-license",
    )
    query = await quotations._tenant_company_scope(user)

    assert "owner-company" not in repr(query)
    assert "tenant-customer" in repr(query)
    assert "tenant-license" in repr(query)
    assert "'is_platform_owner_workspace': {'$ne': True}" in repr(query)


@pytest.mark.asyncio
async def test_owner_workspace_with_stale_license_markers_requires_separate_counterpart(monkeypatch):
    owner = {
        "id": "owner-company",
        "name": "Prodigist Ventures Private Limited",
        "is_platform_owner_workspace": True,
        "commercial_customer_id": "tenant-customer",
        "license_id": "tenant-license",
        "created_by": "owner-user",
    }
    counterpart = {
        "id": "tenant-customer",
        "name": "Manthan Desai And Associates",
        "source": "commercial-license",
        "commercial_customer_id": "tenant-customer",
        "license_id": "tenant-license",
    }

    raw = _FakeRawDB(owner_company=owner, tenant_company=counterpart)
    monkeypatch.setattr(quotations, "_tenant_raw_db", lambda: raw)
    monkeypatch.setenv("PLATFORM_OWNER_WORKSPACE_ID", "owner-company")
    user = SimpleNamespace(id="owner-user", company_id="owner-company")

    verified = await quotations._verified_owner_workspace_ids(user, [owner])
    assert verified == {"owner-company"}

    raw.companies.counterpart = None
    unverified = await quotations._verified_owner_workspace_ids(user, [owner])
    assert unverified == set()
