"""Central tenant-isolation helpers for the commercial SaaS backend."""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Mapping

from fastapi import HTTPException, status

from backend.platform_owner import is_platform_owner

COMPANY_FIELD = "company_id"
COMPANY_ID_FIELD = "id"

TENANT_COLLECTIONS = {
    "tasks", "todos", "clients", "invoices", "payments",
    "purchase_invoices", "purchase_payments", "purchases",
    "bank_accounts", "bank_transactions", "chart_of_accounts",
    "journal_entries", "journal_lines",
    "knowledge_base", "learning_events", "manual_corrections",
    "recommendation_history", "learning_audit",
    "workflow_definitions", "workflow_instances", "workflow_history",
    "approval_requests", "approval_history", "automation_rules",
    "business_events", "notification_history", "analytics_data",
    "kpi_history", "workflow_audit",
}

COMPANY_REGISTRY_COLLECTION = "companies"

_current_company: ContextVar[str | None] = ContextVar("taskosphere_company_id", default=None)
_current_platform_owner: ContextVar[bool] = ContextVar("taskosphere_platform_owner", default=False)
_system_context: ContextVar[bool] = ContextVar("taskosphere_system_context", default=False)


def set_authenticated_company(company_id: Any):
    value = str(company_id).strip() if company_id is not None else ""
    if not value:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")
    return _current_company.set(value)


def reset_authenticated_company(token) -> None:
    _current_company.reset(token)


def authenticated_company_id() -> str | None:
    return _current_company.get()


def set_platform_owner(value: bool = True):
    return _current_platform_owner.set(bool(value))


def reset_platform_owner(token) -> None:
    _current_platform_owner.reset(token)


def in_platform_owner_context() -> bool:
    return _current_platform_owner.get()


def in_system_context() -> bool:
    return _system_context.get()


@contextmanager
def system_context():
    """Explicitly mark trusted internal jobs as system-scoped.

    This is intentionally opt-in. It is not exposed to request handlers and
    must only be used by trusted server-side maintenance/scheduler code.
    """
    token = _system_context.set(True)
    try:
        yield
    finally:
        _system_context.reset(token)


def get_company_id(current_user: Any) -> str:
    company_id = getattr(current_user, COMPANY_FIELD, None)
    if company_id is None or not str(company_id).strip():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Authenticated user is not associated with a company")
    return str(company_id).strip()


def company_filter(current_user: Any, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    query = {COMPANY_FIELD: get_company_id(current_user)}
    if extra:
        query.update(dict(extra))
    return query


def enforce_company_value(current_user: Any, value: Any) -> str:
    authenticated = get_company_id(current_user)
    if value is not None and str(value).strip() != authenticated:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    return authenticated


def force_company_id(current_user: Any, record: dict[str, Any]) -> dict[str, Any]:
    result = dict(record)
    result[COMPANY_FIELD] = enforce_company_value(current_user, result.get(COMPANY_FIELD))
    return result


def assert_record_company(current_user: Any, record: Mapping[str, Any] | None) -> None:
    if record is None:
        return
    authenticated = get_company_id(current_user)
    if record.get(COMPANY_FIELD) is None or str(record.get(COMPANY_FIELD)) != authenticated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")


def _scope_query(query: Any) -> dict[str, Any]:
    company_id = authenticated_company_id()
    if not company_id:
        return query if isinstance(query, dict) else {}
    base = dict(query or {})
    requested = base.get(COMPANY_FIELD)
    if requested is not None and str(requested) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    base[COMPANY_FIELD] = company_id
    return base


def _scope_company_registry_query(query: Any) -> dict[str, Any]:
    if in_platform_owner_context():
        return query if isinstance(query, dict) else {}
    company_id = authenticated_company_id()
    if not company_id:
        return query if isinstance(query, dict) else {}
    base = dict(query or {})
    requested = base.get(COMPANY_ID_FIELD)
    if requested is not None:
        if isinstance(requested, dict) or str(requested) != company_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    base[COMPANY_ID_FIELD] = company_id
    return base


def _scope_company_registry_insert(document: Any) -> Any:
    if in_platform_owner_context() or not authenticated_company_id() or not isinstance(document, dict):
        return document
    result = dict(document)
    requested = result.get(COMPANY_ID_FIELD)
    company_id = authenticated_company_id()
    if requested is not None and str(requested) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company company creation is not permitted")
    result[COMPANY_ID_FIELD] = company_id
    return result


def _scope_company_registry_update(update: Any) -> Any:
    if in_platform_owner_context() or not authenticated_company_id():
        return update
    if not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if COMPANY_ID_FIELD in set_values and str(set_values[COMPANY_ID_FIELD]) != authenticated_company_id():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Company ID cannot be changed")
    set_values.pop(COMPANY_ID_FIELD, None)
    if set_values:
        result["$set"] = set_values
    elif "$set" in result:
        result.pop("$set", None)
    return result


def _scope_update(update: Any) -> Any:
    company_id = authenticated_company_id()
    if not company_id:
        return update
    if isinstance(update, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tenant update pipelines are not permitted")
    if not isinstance(update, dict):
        return update
    result = dict(update)
    unset_values = dict(result.get("$unset") or {})
    if COMPANY_FIELD in unset_values:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="company_id cannot be removed")
    set_values = dict(result.get("$set") or {})
    if COMPANY_FIELD in set_values and str(set_values[COMPANY_FIELD]) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    set_values[COMPANY_FIELD] = company_id
    result["$set"] = set_values
    return result


def _scope_replacement(replacement: Any) -> Any:
    company_id = authenticated_company_id()
    if not company_id or not isinstance(replacement, dict):
        return replacement
    result = dict(replacement)
    if result.get(COMPANY_FIELD) is not None and str(result[COMPANY_FIELD]) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    result[COMPANY_FIELD] = company_id
    return result


class TenantAwareCollection:
    def __init__(self, collection: Any, name: str):
        self._collection = collection
        self._name = name

    def _enabled(self) -> bool:
        return self._name in TENANT_COLLECTIONS and authenticated_company_id() is not None and not in_system_context()

    def _company_registry_enabled(self) -> bool:
        return self._name == COMPANY_REGISTRY_COLLECTION and authenticated_company_id() is not None and not in_system_context()

    def find(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return self._collection.find(query, *args, **kwargs)

    async def find_one(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.find_one(query, *args, **kwargs)

    async def count_documents(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.count_documents(query, *args, **kwargs)

    async def distinct(self, key, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.distinct(key, query, *args, **kwargs)

    async def insert_one(self, document, *args, **kwargs):
        if self._enabled(): document = _scope_replacement(document)
        elif self._company_registry_enabled(): document = _scope_company_registry_insert(document)
        return await self._collection.insert_one(document, *args, **kwargs)

    async def insert_many(self, documents, *args, **kwargs):
        if self._enabled(): documents = [_scope_replacement(document) for document in documents]
        elif self._company_registry_enabled(): documents = [_scope_company_registry_insert(document) for document in documents]
        return await self._collection.insert_many(documents, *args, **kwargs)

    async def update_one(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, update = _scope_query(query), _scope_update(update)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.update_one(query, update, *args, **kwargs)

    async def update_many(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, update = _scope_query(query), _scope_update(update)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.update_many(query, update, *args, **kwargs)

    async def replace_one(self, query, replacement, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, replacement = _scope_query(query), _scope_replacement(replacement)
        elif registry:
            query = _scope_company_registry_query(query)
            replacement = _scope_company_registry_insert(replacement)
        return await self._collection.replace_one(query, replacement, *args, **kwargs)

    async def find_one_and_update(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, update = _scope_query(query), _scope_update(update)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.find_one_and_update(query, update, *args, **kwargs)

    async def find_one_and_replace(self, query, replacement, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled: query, replacement = _scope_query(query), _scope_replacement(replacement)
        elif registry:
            query = _scope_company_registry_query(query)
            replacement = _scope_company_registry_insert(replacement)
        return await self._collection.find_one_and_replace(query, replacement, *args, **kwargs)

    async def find_one_and_delete(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.find_one_and_delete(query, *args, **kwargs)

    async def delete_one(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.delete_one(query, *args, **kwargs)

    async def delete_many(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.delete_many(query, *args, **kwargs)

    def aggregate(self, pipeline, *args, **kwargs):
        if self._enabled():
            pipeline = list(pipeline or [])
            pipeline.insert(0, {"$match": {COMPANY_FIELD: authenticated_company_id()}})
        elif self._company_registry_enabled():
            pipeline = list(pipeline or [])
            if not in_platform_owner_context():
                pipeline.insert(0, {"$match": {COMPANY_ID_FIELD: authenticated_company_id()}})
        return self._collection.aggregate(pipeline, *args, **kwargs)

    async def bulk_write(self, requests, *args, **kwargs):
        if not self._enabled(): return await self._collection.bulk_write(requests, *args, **kwargs)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bulk writes are not permitted on tenant collections")

    def __getattr__(self, name):
        return getattr(self._collection, name)


class TenantAwareDatabase:
    def __init__(self, database: Any): self._database = database
    def __getitem__(self, name): return TenantAwareCollection(self._database[name], name)
    def __getattr__(self, name): return self[name]
