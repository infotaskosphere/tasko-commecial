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

import re

from contextvars import ContextVar
from typing import Any

from bson import ObjectId
from fastapi import Depends, HTTPException, status

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import (
    TenantAwareCollection, in_platform_owner_context,
    set_authenticated_tenant_database,
)

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
    if requested is not None:
        # A scalar/equality value explicitly selecting another customer is
        # cross-licensee access. Mongo operator dictionaries ($nin/$in/$ne,
        # etc.) are ordinary filters and must NOT be treated as a customer-id
        # selection; the mandatory scope_filter below still constrains the
        # result to the authenticated customer.
        if isinstance(requested, dict):
            requested_eq = requested.get("$eq")
            if requested_eq is not None and str(requested_eq) != customer_id:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-licensee access is not permitted")
        elif str(requested) != customer_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-licensee access is not permitted")
    if name == "companies":
        # Company IDs and customer IDs sometimes collide in legacy records.
        # A row explicitly marked as the Platform Owner workspace must never
        # be returned to a licensee, even if it carries stale customer markers.
        scope_filter = {
            "$and": [
                {
                    "$or": [
                        {"commercial_customer_id": customer_id},
                        {"id": customer_id},
                    ]
                },
                {"is_platform_owner_workspace": {"$ne": True}},
            ]
        }
        if result:
            return {"$and": [result, scope_filter]}
        return scope_filter
    if name == "users":
        scope_filter = {
            "$or": [
                {"commercial_customer_id": customer_id},
                {"company_id": customer_id},
            ]
        }
        if result:
            return {"$and": [result, scope_filter]}
        return scope_filter
    result["commercial_customer_id"] = customer_id
    return result


def _customer_insert(name: str, document: Any) -> Any:
    customer_id = authenticated_customer_id()
    if not customer_id or _is_owner_context() or not _customer_scoped_collection(name) or not isinstance(document, dict):
        return document
    result = dict(document)
    if name == "companies" and result.get("is_platform_owner_workspace") is True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A licensee cannot create or claim a Platform Owner workspace",
        )
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
    if name == "companies" and set_values.get("is_platform_owner_workspace") is True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A licensee cannot claim a Platform Owner workspace",
        )
    if name == "companies" and "is_platform_owner_workspace" in dict(result.get("$unset") or {}):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="A licensee cannot change Platform Owner workspace ownership",
        )
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
    """Resolve a licensee only from explicit license/customer ownership.

    A company_id is not a customer ID. In particular, never derive the
    commercial customer from a company marked as a Platform Owner workspace:
    historical license issuance could leave licensee markers on the owner row.
    If identity evidence is conflicting or absent, fail closed.
    """
    if is_platform_owner(user):
        return None

    user_customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
    user_license_id = str(getattr(user, "license_id", "") or "").strip()
    company_id = str(getattr(user, "company_id", "") or "").strip()
    email = str(getattr(user, "email", "") or "").strip().lower()
    user_id = str(getattr(user, "id", "") or "").strip()
    raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)

    license_doc = None
    license_customer_id = ""
    if user_license_id and user_license_id not in {"platform-owner-license", "platform-owner"}:
        license_doc = await raw_db.commercial_licenses.find_one(
            {"id": user_license_id},
            {"_id": 0, "id": 1, "customer_id": 1, "status": 1},
        )
        license_customer_id = str((license_doc or {}).get("customer_id") or "").strip()

    if user_customer_id and license_customer_id and user_customer_id != license_customer_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with the licensed customer",
        )

    company = None
    if company_id:
        company = await raw_db.companies.find_one(
            {"id": company_id},
            {
                "_id": 0, "id": 1, "commercial_customer_id": 1,
                "license_id": 1, "source": 1, "created_by": 1,
                "is_platform_owner_workspace": 1,
            },
        )
        if not company:
            try:
                company = await raw_db.companies.find_one(
                    {"_id": ObjectId(company_id)},
                    {
                        "_id": 0, "id": 1, "commercial_customer_id": 1,
                        "license_id": 1, "source": 1, "created_by": 1,
                        "is_platform_owner_workspace": 1,
                    },
                )
            except Exception:
                company = None

    # Owner workspace identity overrides stale customer/license fields on that
    # workspace row. The real licensee company must be resolved independently.
    owner_workspace_link = bool((company or {}).get("is_platform_owner_workspace") is True)
    company_customer_id = (
        ""
        if owner_workspace_link
        else str((company or {}).get("commercial_customer_id") or "").strip()
    )
    company_license_id = (
        ""
        if owner_workspace_link
        else str((company or {}).get("license_id") or "").strip()
    )

    customer_id = user_customer_id or license_customer_id
    if customer_id and company_customer_id and customer_id != company_customer_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with the licensed company",
        )
    if not customer_id:
        customer_id = company_customer_id

    if customer_id and company_license_id and user_license_id and company_license_id != user_license_id:
        # A customer may have an updated license after renewal. Resolve the
        # current license by customer below rather than reusing a conflicting
        # company link.
        company_license_id = ""

    if not user_license_id and company_license_id:
        user_license_id = company_license_id

    # Recover the customer from the authenticated email only when it matches
    # exactly one customer identity. Never infer it from company_id alone.
    if not customer_id and email:
        email_pattern = {"$regex": "^" + re.escape(email) + "$", "$options": "i"}
        candidates = await raw_db.commercial_license_customers.find(
            {
                "$or": [
                    {"email_normalized": email},
                    {"email": email_pattern},
                    {"admin_email_normalized": email},
                    {"admin_email": email_pattern},
                    {"licensee_email": email_pattern},
                    {"contact_email": email_pattern},
                ]
            },
            {"_id": 0, "id": 1},
        ).limit(3).to_list(3)
        candidate_ids = {
            str(row.get("id") or "").strip()
            for row in candidates
            if str(row.get("id") or "").strip()
        }
        if len(candidate_ids) == 1:
            customer_id = next(iter(candidate_ids))
        elif len(candidate_ids) > 1:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Authenticated email is linked to multiple commercial customers",
            )

    # Older user records may lack license_id and customers may store the login
    # email on the license rather than on the customer document.
    if not customer_id and email:
        email_pattern = {"$regex": "^" + re.escape(email) + "$", "$options": "i"}
        license_candidates = await raw_db.commercial_licenses.find(
            {
                "$or": [
                    {"customer_email": email_pattern},
                    {"licensee_email": email_pattern},
                    {"admin_email": email_pattern},
                ]
            },
            {"_id": 0, "id": 1, "customer_id": 1, "issued_at": 1},
        ).sort("issued_at", -1).limit(20).to_list(20)
        candidate_ids = {
            str(row.get("customer_id") or "").strip()
            for row in license_candidates
            if str(row.get("customer_id") or "").strip()
        }
        if len(candidate_ids) == 1:
            customer_id = next(iter(candidate_ids))
        elif len(candidate_ids) > 1:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Authenticated email is linked to multiple commercial customers",
            )

    # Last legacy recovery: a company explicitly created as a commercial
    # licensee master, and only after verifying that its customer exists.
    source = str((company or {}).get("source") or "").strip().lower()
    if not customer_id and company and not owner_workspace_link and source == "commercial-license":
        legacy_company_id = str(company.get("id") or company_id).strip()
        linked_customer = await raw_db.commercial_license_customers.find_one(
            {"id": legacy_company_id}, {"_id": 0, "id": 1}
        )
        linked_license = await raw_db.commercial_licenses.find_one(
            {"customer_id": legacy_company_id}, {"_id": 0, "id": 1}
        )
        if linked_customer or linked_license:
            customer_id = legacy_company_id

    # Preserve self-created, unlicensed legacy workspaces, but never let an
    # owner workspace or a record with commercial ownership markers become a
    # customer's identity merely because its ID happens to be company_id.
    if (
        not customer_id
        and company
        and not owner_workspace_link
        and not str(company.get("commercial_customer_id") or "").strip()
        and not str(company.get("license_id") or "").strip()
        and source not in {"commercial-license", "commercial", "license", "commercial-customer"}
        and str(company.get("created_by") or "").strip() == user_id
    ):
        customer_id = company_id

    if not customer_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not linked to a commercial customer",
        )

    # If the supplied license is stale/missing, do not change customer scope.
    # The request can still resolve that customer's current license separately.
    return customer_id


async def _apply_live_license_permissions(user: Any, customer_id: str | None):
    """Apply the active commercial license as a hard ceiling without
    overwriting the licensee admin's Permission Matrix grants.

    Commercial license = maximum entitlement.
    Licensee admin Permission Matrix = actual Manager/Staff entitlement.
    """
    if not customer_id or is_platform_owner(user):
        return user
    try:
        raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)
        license_docs = await raw_db.commercial_licenses.find(
            {"customer_id": customer_id, "status": {"$in": ["active", "trial"]}},
            {"_id": 0},
        ).sort("issued_at", -1).limit(20).to_list(20)
        if not license_docs:
            return user

        from backend.licensing_api import _expiry_reason
        active = next((doc for doc in license_docs if not _expiry_reason(doc)), None)
        if not active:
            return user

        raw_role = getattr(user, "role", "staff")
        role = str(getattr(raw_role, "value", raw_role) or "staff").strip().lower()
        if role.replace("-", "_").replace(" ", "_") in {"licensee_admin", "tenant_admin"} or role.endswith(".admin"):
            role = "admin"

        # Read the raw stored Permission Matrix first. User model
        # normalization adds role defaults for legacy compatibility, but those
        # defaults must never masquerade as an explicit commercial grant.
        stored_doc = await raw_db.users.find_one(
            {"id": str(getattr(user, "id", ""))},
            {"_id": 0, "permissions": 1},
        )
        current = (stored_doc or {}).get("permissions")
        if hasattr(current, "model_dump"):
            current = current.model_dump()
        if not isinstance(current, dict):
            current = getattr(user, "permissions", None)
            if hasattr(current, "model_dump"):
                current = current.model_dump()
        if not isinstance(current, dict):
            current = {}

        from backend.commercial_licensee_admin import (
            get_all_admin_permissions,
            get_tenant_user_permissions,
            normalize_license_selected_features,
        )

        if role == "admin":
            # The licensee administrator receives only the modules/pages
            # selected by the Platform Owner, including AIWeave when selected.
            # Staff/Manager grants remain separately governed below.
            license_permissions = get_all_admin_permissions(active)
        else:
            # IMPORTANT: do NOT rebuild Manager/Staff permissions from
            # selected_features. That was the bug: it replaced the actual
            # Permission Matrix grants on every authenticated request.
            # Preserve the user's stored grants, then cap them against the
            # licensee admin's effective licensed permissions.
            license_permissions = get_tenant_user_permissions(
                None,
                active,
                role,
                current,
            )

        data = user.model_dump()
        data["permissions"] = license_permissions
        data["licensed_modules"] = list(
            active.get("modules") or active.get("licensed_modules") or []
        )
        data["selected_features"] = normalize_license_selected_features(active)
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

    # Resolve database routing from the central customer registry, never from
    # a client-supplied company_id, license_id, header, or JWT database claim.
    raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)
    customer_record = await raw_db.commercial_license_customers.find_one(
        {"id": str(customer_id)},
        {"_id": 0, "tenant_database_name": 1, "tenant_database_status": 1},
    )
    from backend.tenant_database_manager import tenant_database_for_customer
    database_name = tenant_database_for_customer(customer_id, customer_record)
    set_authenticated_tenant_database(database_name)
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
