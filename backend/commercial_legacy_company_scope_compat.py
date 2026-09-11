"""Compatibility for legacy license-generated company records.

Some customer companies were created before ``commercial_customer_id`` became
mandatory. They remain safe to use when explicitly linked to the current
customer's active license. This layer exposes those records to the customer
Company/User masters without exposing another licensee's companies.
"""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from fastapi import Depends, HTTPException, status

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import TenantAwareCollection, in_platform_owner_context
from backend.commercial_tenant_scope import authenticated_customer_id

_current_license_id: ContextVar[str | None] = ContextVar("taskosphere_commercial_license_id", default=None)
_INSTALLED = "_commercial_legacy_company_scope_installed"


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def current_license_id() -> str | None:
    return _current_license_id.get()


async def _resolve_license_id(user: Any, customer_id: str | None) -> str | None:
    direct = str(getattr(user, "license_id", "") or "").strip()
    if direct:
        return direct
    if not customer_id:
        return None
    raw_db = _raw_db()
    doc = await raw_db.commercial_licenses.find_one(
        {"customer_id": customer_id, "status": "active"},
        {"_id": 0, "id": 1},
        sort=[("issued_at", -1)],
    )
    return str((doc or {}).get("id") or "").strip() or None


_original_get_current_user = _dependencies.get_current_user


async def get_current_user_with_legacy_license_context(
    credentials=Depends(_dependencies.security),
):
    user = await _original_get_current_user(credentials)
    customer_id = authenticated_customer_id()
    if is_platform_owner(user) or not customer_id:
        _current_license_id.set(None)
        return user
    _current_license_id.set(await _resolve_license_id(user, customer_id))
    return user


def _company_scope_query(query: Any) -> dict[str, Any]:
    customer_id = authenticated_customer_id()
    license_id = current_license_id()
    if not customer_id or in_platform_owner_context():
        return dict(query or {})

    base = dict(query or {})
    requested = base.get("commercial_customer_id")
    if requested is not None and str(requested) != customer_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-licensee access is not permitted")

    ownership = {
        "$or": [
            {"commercial_customer_id": customer_id},
            {"id": customer_id},
            *([{"license_id": license_id}] if license_id else []),
        ]
    }
    return {"$and": [base, ownership]} if base else ownership


def install() -> None:
    if getattr(TenantAwareCollection, _INSTALLED, False):
        return

    original_find = TenantAwareCollection.find
    original_find_one = TenantAwareCollection.find_one
    original_count = TenantAwareCollection.count_documents
    original_distinct = TenantAwareCollection.distinct
    original_aggregate = TenantAwareCollection.aggregate

    def find(self, query=None, *args, **kwargs):
        if self._name != "companies":
            return original_find(self, query, *args, **kwargs)
        if not authenticated_customer_id() or in_platform_owner_context():
            return original_find(self, query, *args, **kwargs)
        return self._collection.find(_company_scope_query(query), *args, **kwargs)

    async def find_one(self, query=None, *args, **kwargs):
        if self._name != "companies":
            return await original_find_one(self, query, *args, **kwargs)
        if not authenticated_customer_id() or in_platform_owner_context():
            return await original_find_one(self, query, *args, **kwargs)
        return await self._collection.find_one(_company_scope_query(query), *args, **kwargs)

    async def count_documents(self, query=None, *args, **kwargs):
        if self._name != "companies":
            return await original_count(self, query, *args, **kwargs)
        if not authenticated_customer_id() or in_platform_owner_context():
            return await original_count(self, query, *args, **kwargs)
        return await self._collection.count_documents(_company_scope_query(query), *args, **kwargs)

    async def distinct(self, key, query=None, *args, **kwargs):
        if self._name != "companies":
            return await original_distinct(self, key, query, *args, **kwargs)
        if not authenticated_customer_id() or in_platform_owner_context():
            return await original_distinct(self, key, query, *args, **kwargs)
        return await self._collection.distinct(key, _company_scope_query(query), *args, **kwargs)

    def aggregate(self, pipeline, *args, **kwargs):
        if self._name != "companies":
            return original_aggregate(self, pipeline, *args, **kwargs)
        if not authenticated_customer_id() or in_platform_owner_context():
            return original_aggregate(self, pipeline, *args, **kwargs)
        pipeline = list(pipeline or [])
        pipeline.insert(0, {"$match": _company_scope_query({})})
        return self._collection.aggregate(pipeline, *args, **kwargs)

    TenantAwareCollection.find = find
    TenantAwareCollection.find_one = find_one
    TenantAwareCollection.count_documents = count_documents
    TenantAwareCollection.distinct = distinct
    TenantAwareCollection.aggregate = aggregate
    setattr(TenantAwareCollection, _INSTALLED, True)

    _dependencies.get_current_user = get_current_user_with_legacy_license_context


install()
