"""License-authoritative entitlement hydration for commercial customer admins.

This compatibility layer patches the existing authentication function *in place*
so every FastAPI dependency that already captured ``get_current_user`` sees the
same commercial-license hydration after login and hard refresh. No second auth
path is introduced.

Module selection and page selection are independent: a purchased module only
sets the module switch; individual page permissions come exclusively from the
license ``selected_features`` map.
"""
from __future__ import annotations

import types
from datetime import datetime, timezone
from typing import Any

from backend import dependencies as _dependencies
from backend.commercial_licensee_admin import get_all_admin_permissions
from backend.platform_owner import is_platform_owner


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def _aware(value: Any):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return None


async def _resolve_customer_id(user: Any) -> str | None:
    direct = str(getattr(user, "commercial_customer_id", "") or "").strip()
    if direct:
        return direct

    license_id = str(getattr(user, "license_id", "") or "").strip()
    db = _raw_db()
    if license_id:
        license_doc = await db.commercial_licenses.find_one(
            {"id": license_id}, {"_id": 0, "customer_id": 1}
        )
        customer_id = str((license_doc or {}).get("customer_id") or "").strip()
        if customer_id:
            return customer_id

    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not company_id:
        return None
    company = await db.companies.find_one(
        {"id": company_id},
        {"_id": 0, "commercial_customer_id": 1, "license_id": 1},
    )
    if not company:
        return None
    customer_id = str(company.get("commercial_customer_id") or "").strip()
    if customer_id:
        return customer_id
    license_id = str(company.get("license_id") or "").strip()
    if license_id:
        license_doc = await db.commercial_licenses.find_one(
            {"id": license_id}, {"_id": 0, "customer_id": 1}
        )
        customer_id = str((license_doc or {}).get("customer_id") or "").strip()
        return customer_id or None
    return None


async def _active_license(customer_id: str) -> dict[str, Any] | None:
    db = _raw_db()
    docs = await db.commercial_licenses.find(
        {"customer_id": customer_id, "status": {"$in": ["active", "trial"]}},
        {"_id": 0},
    ).sort("issued_at", -1).limit(20).to_list(20)
    now = datetime.now(timezone.utc)
    for doc in docs:
        expires = _aware(doc.get("expires_at"))
        if not expires or expires > now:
            return doc
    return None


async def _hydrate(user: Any):
    if is_platform_owner(user) or str(getattr(user, "role", "")).lower() != "admin":
        return user
    customer_id = await _resolve_customer_id(user)
    if not customer_id:
        return user
    license_doc = await _active_license(customer_id)
    if not license_doc:
        return user

    modules = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
    data = user.model_dump()
    data["commercial_customer_id"] = customer_id
    data["license_id"] = license_doc.get("id")
    data["license_key"] = license_doc.get("license_key")
    data["licensed_modules"] = modules
    data["selected_features"] = license_doc.get("selected_features") or {}
    data["permissions"] = get_all_admin_permissions(license_doc)
    return type(user).model_validate(data)


def install() -> None:
    current = _dependencies.get_current_user
    if getattr(_dependencies, "_commercial_entitlement_patch_installed", False):
        return

    # Clone the original function object so replacing its code does not make
    # the wrapper recursively call itself. Existing Depends(get_current_user)
    # references keep pointing to the same function object, now with the
    # commercial hydration logic in its code.
    base = types.FunctionType(
        current.__code__,
        current.__globals__,
        current.__name__,
        current.__defaults__,
        current.__closure__,
    )
    base.__kwdefaults__ = current.__kwdefaults__

    # The code object below is transplanted onto the existing dependency
    # function, so its global namespace is the namespace of that destination
    # function. Publish the helpers directly into that namespace rather than
    # relying on attribute lookup through the imported module object.
    target_globals = current.__globals__
    target_globals["_commercial_entitlement_base_get_current_user"] = base
    target_globals["_commercial_entitlement_hydrate"] = _hydrate
    target_globals["_commercial_entitlement_patch_installed"] = True

    async def _patched_get_current_user(credentials):
        user = await _commercial_entitlement_base_get_current_user(credentials)
        try:
            return await _commercial_entitlement_hydrate(user)
        except Exception:
            # Authentication must never become a 500 because a malformed or
            # legacy license record could not be hydrated. The commercial route
            # guard will still fail closed when entitlement data is unavailable.
            return user

    # Execute wrapper code in backend.dependencies globals so all references
    # resolve from the same module namespace as the original auth function.
    current.__code__ = _patched_get_current_user.__code__
    current.__kwdefaults__ = _patched_get_current_user.__kwdefaults__


install()
