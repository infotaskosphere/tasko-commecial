"""Commercial customer isolation for shared Company/User masters.

The operational tenant remains ``company_id`` for transactional collections.
Company and User masters are different: a licensee may own multiple legal
companies and therefore must be able to see only the companies/users belonging
to that commercial customer, never another licensee or the Platform Owner.

The authenticated license is also authoritative for the effective module/page
permissions of every licensee user. This makes post-generation license changes
take effect on the next authenticated request without weakening user-level
permission restrictions.
"""
from __future__ import annotations

from contextvars import ContextVar
from typing import Any

from bson import ObjectId
from fastapi import Depends, HTTPException, status

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import TenantAwareCollection, in_platform_owner_context

_current_customer_id: ContextVar[str | None] = ContextVar("taskosphere_commercial_customer_id", default=None)


def set_authenticated_customer(customer_id: Any):
    value = str(customer_id).strip() if customer_id is not None else ""
    return _current_customer_id.set(value or None)


def reset_authenticated_customer(token) -> None:
    _current_customer_id.reset(token)


def authenticated_customer_id() -> str | None:
    return _current_customer_id.get()


def _is_owner_context() -> bool:
    return bool(in_platform_owner_context())


def _customer_scoped_collection(name: str) -> bool:
    return name in {"companies", "users"}


def _customer_query(name: str, query: Any) -> dict[str, Any]:
    customer_id = authenticated_customer_id()
    if not customer_id or _is_owner_context() or not _customer_scoped_collection(name):
        return dict(query or {})
    result = dict(query or {})
    requested = result.get("commercial_customer_id")
    if requested is not None and str(requested) != customer_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-licensee access is not permitted")
    result["commercial_customer_id"] = customer_id
    return result


def _customer_insert(name: str, document: Any) -> Any:
    customer_id = authenticated_customer_id()
    if not customer_id or _is_owner_context() or not _customer_scoped_collection(name) or not isinstance(document, dict):
        return document
    result = dict(document)
    requested = result.get("commercial_customer_id")
    if requested is not None and str(requested) != customer_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="A licensee cannot create records for another licensee")
    result["commercial_customer_id"] = customer_id
    return result


def _customer_update(name: str, update: Any) -> Any:
    customer_id = authenticated_customer_id()
    if not customer_id or _is_owner_context() or not _customer_scoped_collection(name) or not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if "commercial_customer_id" in set_values and str(set_values["commercial_customer_id"]) != customer_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Commercial customer ownership cannot be changed")
    set_values.pop("commercial_customer_id", None)
    if set_values:
        result["$set"] = set_values
    elif "$set" in result:
        result.pop("$set", None)
    unset_values = dict(result.get("$unset") or {})
    if "commercial_customer_id" in unset_values:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Commercial customer ownership cannot be removed")
    return result


def _customer_replacement(name: str, replacement: Any) -> Any:
    return _customer_insert(name, replacement)


async def _resolve_customer_id(user: Any) -> str | None:
    """Resolve the commercial customer from authenticated identity first.

    Older commercial records are not completely uniform: some company records
    use the public ``id`` field while others can be addressed by MongoDB
    ``_id``.  The previous resolver only checked ``id`` and could therefore
    fall back to ``company_id``.  That fallback caused the authenticated
    customer context to differ from the customer's actual license id, which in
    turn filtered the users collection to zero rows and surfaced as a
    "user data not fetched" condition.

    Resolution is deliberately fail-closed: a non-owner request receives a
    customer context only when it can be tied to the authenticated user or its
    company.  We never accept a customer id supplied by the frontend.
    """
    if is_platform_owner(user):
        return None

    user_customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
    company_id = str(getattr(user, "company_id", "") or "").strip()
    raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)

    company = None
    if company_id:
        company = await raw_db.companies.find_one(
            {"id": company_id},
            {"commercial_customer_id": 1, "source": 1, "id": 1},
        )
        if not company:
            try:
                company = await raw_db.companies.find_one(
                    {"_id": ObjectId(company_id)},
                    {"commercial_customer_id": 1, "source": 1, "id": 1},
                )
            except Exception:
                company = None

    company_customer_id = str((company or {}).get("commercial_customer_id") or "").strip()

    # Prefer the authenticated user identity, but require it to agree with the
    # company when both values are present. This prevents a stale/malformed
    # user document from silently switching tenant context.
    if user_customer_id and company_customer_id and user_customer_id != company_customer_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with the licensed company",
        )

    customer_id = user_customer_id or company_customer_id

    # Legacy commercial company records may not have commercial_customer_id.
    # In that case the company id was historically used as the customer key,
    # but only after the company itself has been positively resolved.
    if not customer_id and company and (company.get("source") == "commercial-license"):
        customer_id = company_id

    # If neither identity source is usable, fail closed instead of creating an
    # unscoped customer view. This is safer than treating company_id as a
    # customer id for arbitrary legacy/non-commercial records.
    if not customer_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not linked to a commercial customer",
        )

    return customer_id


async def _apply_live_license_permissions(user: Any, customer_id: str | None):
    """Cap the user's effective permissions by the active commercial license."""
    if not customer_id or is_platform_owner(user):
        return user
    try:
        raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)
        license_docs = await raw_db.commercial_licenses.find(
            {"customer_id": customer_id, "status": "active"}, {"_id": 0}
        ).sort("issued_at", -1).limit(10).to_list(10)
        if not license_docs:
            return user

        from backend.licensing_api import _expiry_reason
        active = next((doc for doc in license_docs if not _expiry_reason(doc)), None)
        if not active:
            return user

        from backend.commercial_onboarding_extensions import _apply_feature_entitlements
        role = str(getattr(user, "role", "staff") or "staff")
        modules = list(active.get("modules") or active.get("licensed_modules") or [])
        selected_features = active.get("selected_features") or {}
        license_permissions = _apply_feature_entitlements(role, modules, selected_features)

        current = getattr(user, "permissions", None)
        if hasattr(current, "model_dump"):
            current = current.model_dump()
        if not isinstance(current, dict):
            current = {}
        effective = {**current, **license_permissions}
        data = user.model_dump()
        data["permissions"] = effective
        data["licensed_modules"] = modules
        data["selected_features"] = selected_features
        data["license_id"] = active.get("id")
        data["license_key"] = active.get("license_key")
        data["commercial_customer_id"] = customer_id
        return type(user).model_validate(data)
    except HTTPException:
        raise
    except Exception:
        return user


_original_get_current_user = _dependencies.get_current_user


async def get_current_user_with_customer_scope(
    credentials=Depends(_dependencies.security),
):
    user = await _original_get_current_user(credentials)
    customer_id = await _resolve_customer_id(user)
    set_authenticated_customer(customer_id)
    return await _apply_live_license_permissions(user, customer_id)


def _install_collection_overrides() -> None:
    if getattr(TenantAwareCollection, "_commercial_customer_scope_installed", False):
        return
    original_registry_enabled = TenantAwareCollection._company_registry_enabled
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

    def registry_enabled(self):
        if self._name == "companies" and authenticated_customer_id() and not _is_owner_context():
            return False
        return original_registry_enabled(self)

    def find(self, query=None, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return original_find(self, query, *args, **kwargs)

    async def find_one(self, query=None, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return await original_find_one(self, query, *args, **kwargs)

    async def count_documents(self, query=None, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return await original_count(self, query, *args, **kwargs)

    async def distinct(self, key, query=None, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return await original_distinct(self, key, query, *args, **kwargs)

    async def insert_one(self, document, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            document = _customer_insert(self._name, document)
        return await original_insert_one(self, document, *args, **kwargs)

    async def insert_many(self, documents, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            documents = [_customer_insert(self._name, document) for document in documents]
        return await original_insert_many(self, documents, *args, **kwargs)

    async def update_one(self, query, update, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
            update = _customer_update(self._name, update)
        return await original_update_one(self, query, update, *args, **kwargs)

    async def update_many(self, query, update, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
            update = _customer_update(self._name, update)
        return await original_update_many(self, query, update, *args, **kwargs)

    async def replace_one(self, query, replacement, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
            replacement = _customer_replacement(self._name, replacement)
        return await original_replace_one(self, query, replacement, *args, **kwargs)

    async def find_one_and_update(self, query, update, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
            update = _customer_update(self._name, update)
        return await original_find_one_and_update(self, query, update, *args, **kwargs)

    async def find_one_and_replace(self, query, replacement, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
            replacement = _customer_replacement(self._name, replacement)
        return await original_find_one_and_replace(self, query, replacement, *args, **kwargs)

    async def find_one_and_delete(self, query, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return await original_find_one_and_delete(self, query, *args, **kwargs)

    async def delete_one(self, query, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return await original_delete_one(self, query, *args, **kwargs)

    async def delete_many(self, query, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            query = _customer_query(self._name, query)
        return await original_delete_many(self, query, *args, **kwargs)

    def aggregate(self, pipeline, *args, **kwargs):
        if _customer_scoped_collection(self._name):
            customer_id = authenticated_customer_id()
            if customer_id and not _is_owner_context():
                pipeline = list(pipeline or [])
                pipeline.insert(0, {"$match": {"commercial_customer_id": customer_id}})
        return original_aggregate(self, pipeline, *args, **kwargs)

    TenantAwareCollection._company_registry_enabled = registry_enabled
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
    TenantAwareCollection._commercial_customer_scope_installed = True


def install() -> None:
    _install_collection_overrides()
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_customer_scope":
        _dependencies.get_current_user = get_current_user_with_customer_scope


install()
