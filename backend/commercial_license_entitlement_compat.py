"""License-authoritative entitlement hydration for commercial customer admins.

A commercial customer has one license and may own multiple legal companies.
Older accounts sometimes stored the legal company's id where the newer model
expects the commercial customer id. This shim resolves the active license
through the customer's explicit commercial_customer_id first and falls back to
an authenticated user's license_id. It then grants an admin access to every
page/feature inside the modules actually purchased by that license, without
opening any unlicensed module.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import Depends

from backend import dependencies as _dependencies
from backend.models import DEFAULT_ROLE_PERMISSIONS, MODULE_HIERARCHY, User
from backend.platform_owner import is_platform_owner

_original_get_current_user = _dependencies.get_current_user
_INSTALLED = "_commercial_license_entitlement_compat_installed"


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


def _module_flag(module_id: str) -> str | None:
    definition = MODULE_HIERARCHY.get(module_id)
    return str(definition.get("flag")) if definition and definition.get("flag") else None


def _apply_license_admin_permissions(modules: list[str], current: Any) -> dict[str, Any]:
    permissions = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
    if hasattr(current, "model_dump"):
        current = current.model_dump()
    if isinstance(current, dict):
        permissions.update(current)

    selected = {str(item).strip().lower() for item in modules if str(item).strip()}
    known_modules = [key for key in MODULE_HIERARCHY.keys() if key != "admin"]
    for module_id in known_modules:
        allowed = module_id in selected
        flag = _module_flag(module_id)
        if flag:
            permissions[flag] = allowed
        definition = MODULE_HIERARCHY.get(module_id) or {}
        for page in definition.get("pages", []) or []:
            page_flag = page.get("flag")
            if page_flag:
                permissions[page_flag] = allowed

    return permissions


async def _resolve_customer_id(user: User) -> str | None:
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
        return str((license_doc or {}).get("customer_id") or "").strip() or None
    return None


async def _active_license(customer_id: str) -> dict[str, Any] | None:
    db = _raw_db()
    docs = await db.commercial_licenses.find(
        {"customer_id": customer_id, "status": {"$in": ["active", "trial"]}},
        {"_id": 0},
    ).sort("issued_at", -1).limit(10).to_list(10)
    now = datetime.now(timezone.utc)
    for doc in docs:
        expires = _aware(doc.get("expires_at"))
        if not expires or expires > now:
            return doc
    return None


async def get_current_user_with_license_entitlements(
    credentials=Depends(_dependencies.security),
):
    user = await _original_get_current_user(credentials)
    if is_platform_owner(user) or str(getattr(user, "role", "")).lower() != "admin":
        return user

    try:
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
        data["permissions"] = _apply_license_admin_permissions(modules, data.get("permissions"))
        return User.model_validate(data)
    except Exception:
        # Never turn authentication into a 500 because a legacy entitlement
        # record is malformed. The downstream commercial guard will fail closed.
        return user


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") == "get_current_user_with_license_entitlements":
        return
    _dependencies.get_current_user = get_current_user_with_license_entitlements


install()
