"""Final user-data isolation boundary for the commercial SaaS.

The users collection is shared physically, but user data is NOT shared
logically. Every authenticated user may read/write users only for their own
company. A commercial customer's license may cover multiple legal companies
and its max_users seat limit remains customer-wide, but the people directory
is company-specific.

Platform Owner is also treated as a tenant for the Users surface: the owner
can see only users belonging to the owner's own company. Customer users can
never appear in the Platform Owner's normal Users page.

This is deliberately installed after the older customer-level compatibility
layers so legacy records remain discoverable while the final security rule is
unambiguous: users are always scoped by company_id at request time.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import TenantAwareCollection, authenticated_company_id, in_platform_owner_context
from backend.commercial_tenant_scope import authenticated_customer_id

_INSTALLED = "_commercial_user_company_scope_installed"


def _user_company_id() -> str:
    company_id = str(authenticated_company_id() or "").strip()
    if not company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with a company.",
        )
    return company_id


def _scope_user_query(query: Any) -> dict[str, Any]:
    company_id = _user_company_id()
    base = dict(query or {})
    requested = base.get("company_id")
    if requested is not None and str(requested) != company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cross-company user access is not permitted.",
        )
    # Never allow a caller-supplied OR/AND expression to escape the company
    # boundary. Wrap the complete original query under an explicit company
    # predicate instead of trusting the caller's filter structure.
    return {"$and": [base, {"company_id": company_id}]} if base else {"company_id": company_id}


def _scope_user_insert(document: Any) -> dict[str, Any]:
    company_id = _user_company_id()
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Invalid user record.")
    result = dict(document)
    requested = result.get("company_id")
    if requested is not None and str(requested) != company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A user can only be created for the authenticated company.",
        )
    result["company_id"] = company_id
    return result


def _scope_user_update(update: Any) -> dict[str, Any]:
    company_id = _user_company_id()
    if not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if "company_id" in set_values and str(set_values["company_id"]) != company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A user's company cannot be changed through this account.",
        )
    set_values["company_id"] = company_id
    result["$set"] = set_values
    unset_values = dict(result.get("$unset") or {})
    if "company_id" in unset_values:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A user's company cannot be removed.",
        )
    return result


def _scope_user_replacement(replacement: Any) -> dict[str, Any]:
    return _scope_user_insert(replacement)


def _install() -> None:
    if getattr(TenantAwareCollection, _INSTALLED, False):
        return

    original_find = TenantAwareCollection.find
    original_find_one = TenantAwareCollection.find_one
    original_count = TenantAwareCollection.count_documents
    original_distinct = TenantAwareCollection.distinct
    original_insert_one = TenantAwareCollection.insert_one
    original_insert_many = TenantAwareCollection.insert_many
    original_update_one = TenantAwareCollection.update_one
    original_update_many = TenantAwareCollection.update_many
    original_replace_one = TenantAwareCollection.replace_one
    original_find_one_and_update = TenantAwareCollection.find_one_and_update
    original_find_one_and_replace = TenantAwareCollection.find_one_and_replace
    original_find_one_and_delete = TenantAwareCollection.find_one_and_delete
    original_delete_one = TenantAwareCollection.delete_one
    original_delete_many = TenantAwareCollection.delete_many
    original_aggregate = TenantAwareCollection.aggregate

    def find(self, query=None, *args, **kwargs):
        if self._name != "users":
            return original_find(self, query, *args, **kwargs)
        return self._collection.find(_scope_user_query(query), *args, **kwargs)

    async def find_one(self, query=None, *args, **kwargs):
        if self._name != "users":
            return await original_find_one(self, query, *args, **kwargs)
        return await self._collection.find_one(_scope_user_query(query), *args, **kwargs)

    async def count_documents(self, query=None, *args, **kwargs):
        if self._name != "users":
            return await original_count(self, query, *args, **kwargs)
        return await self._collection.count_documents(_scope_user_query(query), *args, **kwargs)

    async def distinct(self, key, query=None, *args, **kwargs):
        if self._name != "users":
            return await original_distinct(self, key, query, *args, **kwargs)
        return await self._collection.distinct(key, _scope_user_query(query), *args, **kwargs)

    async def insert_one(self, document, *args, **kwargs):
        if self._name != "users":
            return await original_insert_one(self, document, *args, **kwargs)
        return await original_insert_one(self, _scope_user_insert(document), *args, **kwargs)

    async def insert_many(self, documents, *args, **kwargs):
        if self._name != "users":
            return await original_insert_many(self, documents, *args, **kwargs)
        return await original_insert_many(self, [_scope_user_insert(d) for d in documents], *args, **kwargs)

    async def update_one(self, query, update, *args, **kwargs):
        if self._name != "users":
            return await original_update_one(self, query, update, *args, **kwargs)
        return await original_update_one(self, _scope_user_query(query), _scope_user_update(update), *args, **kwargs)

    async def update_many(self, query, update, *args, **kwargs):
        if self._name != "users":
            return await original_update_many(self, query, update, *args, **kwargs)
        return await original_update_many(self, _scope_user_query(query), _scope_user_update(update), *args, **kwargs)

    async def replace_one(self, query, replacement, *args, **kwargs):
        if self._name != "users":
            return await original_replace_one(self, query, replacement, *args, **kwargs)
        return await original_replace_one(self, _scope_user_query(query), _scope_user_replacement(replacement), *args, **kwargs)

    async def find_one_and_update(self, query, update, *args, **kwargs):
        if self._name != "users":
            return await original_find_one_and_update(self, query, update, *args, **kwargs)
        return await original_find_one_and_update(self, _scope_user_query(query), _scope_user_update(update), *args, **kwargs)

    async def find_one_and_replace(self, query, replacement, *args, **kwargs):
        if self._name != "users":
            return await original_find_one_and_replace(self, query, replacement, *args, **kwargs)
        return await original_find_one_and_replace(self, _scope_user_query(query), _scope_user_replacement(replacement), *args, **kwargs)

    async def find_one_and_delete(self, query, *args, **kwargs):
        if self._name != "users":
            return await original_find_one_and_delete(self, query, *args, **kwargs)
        return await self._collection.find_one_and_delete(_scope_user_query(query), *args, **kwargs)

    async def delete_one(self, query, *args, **kwargs):
        if self._name != "users":
            return await original_delete_one(self, query, *args, **kwargs)
        return await original_delete_one(self, _scope_user_query(query), *args, **kwargs)

    async def delete_many(self, query, *args, **kwargs):
        if self._name != "users":
            return await original_delete_many(self, query, *args, **kwargs)
        return await original_delete_many(self, _scope_user_query(query), *args, **kwargs)

    def aggregate(self, pipeline, *args, **kwargs):
        if self._name != "users":
            return original_aggregate(self, pipeline, *args, **kwargs)
        pipeline = list(pipeline or [])
        pipeline.insert(0, {"$match": {"company_id": _user_company_id()}})
        return self._collection.aggregate(pipeline, *args, **kwargs)

    TenantAwareCollection.find = find
    TenantAwareCollection.find_one = find_one
    TenantAwareCollection.count_documents = count_documents
    TenantAwareCollection.distinct = distinct
    TenantAwareCollection.insert_one = insert_one
    TenantAwareCollection.insert_many = insert_many
    TenantAwareCollection.update_one = update_one
    TenantAwareCollection.update_many = update_many
    TenantAwareCollection.replace_one = replace_one
    TenantAwareCollection.find_one_and_update = find_one_and_update
    TenantAwareCollection.find_one_and_replace = find_one_and_replace
    TenantAwareCollection.find_one_and_delete = find_one_and_delete
    TenantAwareCollection.delete_one = delete_one
    TenantAwareCollection.delete_many = delete_many
    TenantAwareCollection.aggregate = aggregate
    setattr(TenantAwareCollection, _INSTALLED, True)


_install()
