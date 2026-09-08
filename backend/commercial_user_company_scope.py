"""Final user-data isolation boundary for the commercial SaaS.

The users collection is shared physically, but user data is NOT shared
logically. Every authenticated customer user may read/write users only for
that user's own legal company. A commercial customer's license may cover
multiple legal companies and its max_users seat limit remains customer-wide,
but the people directory is company-specific.

The Platform Owner is not a customer tenant. Its normal Users surface is
restricted to Platform Owner accounts only, so customer users cannot leak into
the owner's operational directory.

Authentication itself is necessarily pre-tenant: login must locate the user
before a company context exists. This module therefore permits only narrowly
whitelisted internal authentication/bootstrap functions to query users before
context is established. It does not make arbitrary unauthenticated database
access available to request handlers.
"""
from __future__ import annotations

import inspect
from typing import Any

from fastapi import HTTPException, status

from backend.platform_owner import platform_owner_emails
from backend.tenant_runtime import TenantAwareCollection, authenticated_company_id, in_platform_owner_context

_INSTALLED = "_commercial_user_company_scope_installed"
_PRE_AUTH_CALLERS = frozenset({
    "login",
    "_sync_saas_bootstrap_password",
    "register",
})


def _is_owner_context() -> bool:
    return bool(in_platform_owner_context())


def _owner_emails() -> set[str]:
    return {str(email).strip().lower() for email in platform_owner_emails() if str(email).strip()}


def _is_trusted_pre_auth_context() -> bool:
    """Allow only known internal auth/bootstrap code before a tenant exists."""
    for frame_info in inspect.stack(context=0):
        if frame_info.function in _PRE_AUTH_CALLERS:
            module_name = str(frame_info.frame.f_globals.get("__name__") or "")
            if module_name == "backend.server":
                return True
    return False


def _owner_user_query(query: Any) -> dict[str, Any]:
    """Restrict the Platform Owner's Users surface to owner identities only."""
    base = dict(query or {})
    requested_email = base.get("email")
    owner_emails = _owner_emails()
    if requested_email is not None:
        normalized = str(requested_email).strip().lower()
        if normalized not in owner_emails:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner user access is restricted to Platform Owner accounts.",
            )
    owner_filter = {"email": {"$in": sorted(owner_emails)}}
    return {"$and": [base, owner_filter]} if base else owner_filter


def _user_company_id() -> str:
    company_id = str(authenticated_company_id() or "").strip()
    if not company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with a company.",
        )
    return company_id


def _scope_user_query(query: Any) -> dict[str, Any]:
    if _is_owner_context():
        return _owner_user_query(query)
    if _is_trusted_pre_auth_context():
        # Login/bootstrap must locate the credential record before the current
        # user and company are known. The caller is a narrowly whitelisted
        # backend authentication function, not a public route with direct DB
        # access. Never reuse this path for normal authenticated reads.
        return dict(query or {})

    company_id = _user_company_id()
    base = dict(query or {})
    requested = base.get("company_id")
    if requested is not None and str(requested) != company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cross-company user access is not permitted.",
        )
    return {"$and": [base, {"company_id": company_id}]} if base else {"company_id": company_id}


def _scope_user_insert(document: Any) -> dict[str, Any]:
    if _is_owner_context():
        if not isinstance(document, dict):
            raise HTTPException(status_code=400, detail="Invalid user record.")
        result = dict(document)
        email = str(result.get("email") or "").strip().lower()
        if email not in _owner_emails():
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner accounts cannot create customer operational users through the Users surface.",
            )
        result["email"] = email
        return result
    if _is_trusted_pre_auth_context():
        # Public self-registration is a deliberately separate onboarding flow.
        # Its handler sets role/status and, where applicable, commercial linkage
        # explicitly. Do not silently add a company here because none exists
        # until the license/company has been resolved by that handler.
        if not isinstance(document, dict):
            raise HTTPException(status_code=400, detail="Invalid user record.")
        return dict(document)

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
    if _is_owner_context():
        if not isinstance(update, dict):
            return update
        result = dict(update)
        set_values = dict(result.get("$set") or {})
        if "email" in set_values:
            email = str(set_values["email"] or "").strip().lower()
            if email not in _owner_emails():
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Platform Owner email cannot be changed to a customer account.",
                )
            set_values["email"] = email
        if "company_id" in set_values:
            set_values.pop("company_id", None)
        if "company_id" in dict(result.get("$unset") or {}):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner company ownership cannot be removed through the Users surface.",
            )
        if set_values:
            result["$set"] = set_values
        elif "$set" in result:
            result.pop("$set", None)
        return result

    if _is_trusted_pre_auth_context():
        return update

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
        if _is_owner_context():
            pipeline.insert(0, {"$match": {"email": {"$in": sorted(_owner_emails())}}})
        elif _is_trusted_pre_auth_context():
            pass
        else:
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
