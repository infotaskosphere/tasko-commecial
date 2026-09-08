"""License-wide customer limits and one-license-per-customer enforcement.

A commercial license represents one customer account. That customer may own
multiple legal companies, but the configured ``max_users`` limit is shared by
all of those companies. Platform Owner users and the internal commercial
control-plane identity are never counted because they do not carry the
commercial customer id.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, status

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import TenantAwareCollection
from backend.commercial_tenant_scope import authenticated_customer_id


_USER_COLLECTION = "users"
_INSTALLED = "_commercial_license_user_limit_installed"


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


async def _active_license(customer_id: str) -> dict[str, Any]:
    raw_db = _raw_db()
    docs = await raw_db.commercial_licenses.find(
        {"customer_id": customer_id, "status": "active"}, {"_id": 0}
    ).sort("issued_at", -1).limit(10).to_list(10)
    if not docs:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No active commercial license is assigned to this customer.",
        )

    from backend.licensing_api import _expiry_reason

    license_doc = next((doc for doc in docs if not _expiry_reason(doc)), None)
    if not license_doc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="The commercial license is inactive or expired.",
        )
    return license_doc


async def _customer_company_ids(customer_id: str) -> list[str]:
    raw_db = _raw_db()
    rows = await raw_db.companies.find(
        {"commercial_customer_id": customer_id}, {"_id": 0, "id": 1}
    ).to_list(5000)
    return [str(row.get("id")) for row in rows if row.get("id")]


async def _customer_user_count(customer_id: str) -> int:
    raw_db = _raw_db()
    company_ids = await _customer_company_ids(customer_id)
    clauses: list[dict[str, Any]] = [{"commercial_customer_id": customer_id}]
    if company_ids:
        clauses.append({"company_id": {"$in": company_ids}})
    return int(await raw_db.users.count_documents({"$or": clauses}))


async def _validate_user_company(customer_id: str, document: dict[str, Any]) -> None:
    company_id = str(document.get("company_id") or "").strip()
    if not company_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A licensed customer user must belong to a legal company.",
        )
    raw_db = _raw_db()
    company = await raw_db.companies.find_one(
        {"id": company_id, "commercial_customer_id": customer_id}, {"_id": 0, "id": 1}
    )
    if not company:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User company does not belong to this licensed customer.",
        )


async def _enforce_user_insert(customer_id: str, documents: list[dict[str, Any]]) -> None:
    if not documents:
        return
    license_doc = await _active_license(customer_id)
    max_users = max(1, int(license_doc.get("max_users") or 1))
    current_count = await _customer_user_count(customer_id)
    requested_count = len(documents)
    if current_count + requested_count > max_users:
        remaining = max(0, max_users - current_count)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                f"User limit reached for this license. Allowed: {max_users}; "
                f"currently used: {current_count}; remaining: {remaining}."
            ),
        )
    for document in documents:
        await _validate_user_company(customer_id, document)


async def _guard_license_creation(input_data: dict[str, Any]) -> None:
    """A commercial customer can have exactly one issued license."""
    customer_id = str(input_data.get("customer_id") or "").strip()
    if not customer_id:
        return
    raw_db = _raw_db()
    existing = await raw_db.commercial_licenses.find_one(
        {"customer_id": customer_id}, {"_id": 0, "id": 1, "license_key": 1, "status": 1}
    )
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This customer already has a commercial license. "
                "Update/renew the existing license instead of issuing another one."
            ),
        )


async def _guarded_create_license_record(input_data: dict[str, Any], created_by: str):
    await _guard_license_creation(input_data)
    return await _ORIGINAL_CREATE_LICENSE_RECORD(input_data, created_by)


async def _guarded_insert_one(original, collection, document, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name != _USER_COLLECTION or not customer_id:
        return await original(collection, document, *args, **kwargs)
    await _enforce_user_insert(customer_id, [dict(document or {})])
    return await original(collection, document, *args, **kwargs)


async def _guarded_insert_many(original, collection, documents, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name != _USER_COLLECTION or not customer_id:
        return await original(collection, documents, *args, **kwargs)
    normalized = [dict(document or {}) for document in documents]
    await _enforce_user_insert(customer_id, normalized)
    return await original(collection, documents, *args, **kwargs)


async def _guarded_update_one(original, collection, query, update, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name == _USER_COLLECTION and customer_id and isinstance(update, dict):
        company_id = (update.get("$set") or {}).get("company_id")
        if company_id is not None:
            await _validate_user_company(customer_id, {"company_id": company_id})
    return await original(collection, query, update, *args, **kwargs)


async def _guarded_update_many(original, collection, query, update, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name == _USER_COLLECTION and customer_id and isinstance(update, dict):
        company_id = (update.get("$set") or {}).get("company_id")
        if company_id is not None:
            await _validate_user_company(customer_id, {"company_id": company_id})
    return await original(collection, query, update, *args, **kwargs)


async def _guarded_replace_one(original, collection, query, replacement, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name == _USER_COLLECTION and customer_id:
        await _validate_user_company(customer_id, dict(replacement or {}))
    return await original(collection, query, replacement, *args, **kwargs)


async def _guarded_find_one_and_update(original, collection, query, update, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name == _USER_COLLECTION and customer_id and isinstance(update, dict):
        company_id = (update.get("$set") or {}).get("company_id")
        if company_id is not None:
            await _validate_user_company(customer_id, {"company_id": company_id})
    return await original(collection, query, update, *args, **kwargs)


async def _guarded_find_one_and_replace(original, collection, query, replacement, *args, **kwargs):
    customer_id = authenticated_customer_id()
    if collection._name == _USER_COLLECTION and customer_id:
        await _validate_user_company(customer_id, dict(replacement or {}))
    return await original(collection, query, replacement, *args, **kwargs)


def install() -> None:
    global _ORIGINAL_CREATE_LICENSE_RECORD
    if getattr(TenantAwareCollection, _INSTALLED, False):
        return

    original_insert_one = TenantAwareCollection.insert_one
    original_insert_many = TenantAwareCollection.insert_many
    original_update_one = TenantAwareCollection.update_one
    original_update_many = TenantAwareCollection.update_many
    original_replace_one = TenantAwareCollection.replace_one
    original_find_one_and_update = TenantAwareCollection.find_one_and_update
    original_find_one_and_replace = TenantAwareCollection.find_one_and_replace

    async def insert_one(self, document, *args, **kwargs):
        return await _guarded_insert_one(original_insert_one, self, document, *args, **kwargs)

    async def insert_many(self, documents, *args, **kwargs):
        return await _guarded_insert_many(original_insert_many, self, documents, *args, **kwargs)

    async def update_one(self, query, update, *args, **kwargs):
        return await _guarded_update_one(original_update_one, self, query, update, *args, **kwargs)

    async def update_many(self, query, update, *args, **kwargs):
        return await _guarded_update_many(original_update_many, self, query, update, *args, **kwargs)

    async def replace_one(self, query, replacement, *args, **kwargs):
        return await _guarded_replace_one(original_replace_one, self, query, replacement, *args, **kwargs)

    async def find_one_and_update(self, query, update, *args, **kwargs):
        return await _guarded_find_one_and_update(original_find_one_and_update, self, query, update, *args, **kwargs)

    async def find_one_and_replace(self, query, replacement, *args, **kwargs):
        return await _guarded_find_one_and_replace(original_find_one_and_replace, self, query, replacement, *args, **kwargs)

    TenantAwareCollection.insert_one = insert_one
    TenantAwareCollection.insert_many = insert_many
    TenantAwareCollection.update_one = update_one
    TenantAwareCollection.update_many = update_many
    TenantAwareCollection.replace_one = replace_one
    TenantAwareCollection.find_one_and_update = find_one_and_update
    TenantAwareCollection.find_one_and_replace = find_one_and_replace
    setattr(TenantAwareCollection, _INSTALLED, True)

    # Replace both globals used by the legacy licensing router and the
    # commercial onboarding extension. The route functions resolve their
    # global at request time, so this preserves the existing API shape.
    try:
        from backend import licensing_api
        _ORIGINAL_CREATE_LICENSE_RECORD = licensing_api.create_license_record
        licensing_api.create_license_record = _guarded_create_license_record
        try:
            from backend import commercial_onboarding_extensions
            commercial_onboarding_extensions.create_license_record = _guarded_create_license_record
        except Exception:
            pass
    except Exception:
        _ORIGINAL_CREATE_LICENSE_RECORD = None


_ORIGINAL_CREATE_LICENSE_RECORD = None
install()
