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


ENGAGEX_PAGE_FLAGS = {
    "can_view_engagex_dashboard",
    "can_view_engagex_whatsapp",
    "can_view_engagex_mailmaster",
}

# Existing licenses that contain every commercial module are legacy "full suite"
# licenses created before EngageX existed. They should not lose access simply
# because a new module was introduced after the license was issued. This is a
# runtime compatibility rule; it does not mutate the stored license document.
FULL_SUITE_MODULES = {
    "taskosphere",
    "finix",
    "aiweave",
    "compliance",
    "records",
    "proposals",
    "people_matrix",
}


def _is_admin_role(user: Any) -> bool:
    role = getattr(user, "role", "")
    value = getattr(role, "value", None)
    name = getattr(role, "name", None)
    candidates = [value, name, role]
    for candidate in candidates:
        normalized = str(candidate or "").strip().lower()
        if normalized == "admin" or normalized.endswith(".admin"):
            return True
    return False


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
        license_doc = await db.commercial_licenses.find_one({"id": license_id}, {"_id": 0, "customer_id": 1})
        customer_id = str((license_doc or {}).get("customer_id") or "").strip()
        if customer_id:
            return customer_id
    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not company_id:
        return None
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "commercial_customer_id": 1, "license_id": 1})
    if not company:
        return None
    customer_id = str(company.get("commercial_customer_id") or "").strip()
    if customer_id:
        return customer_id
    license_id = str(company.get("license_id") or "").strip()
    if license_id:
        license_doc = await db.commercial_licenses.find_one({"id": license_id}, {"_id": 0, "customer_id": 1})
        return str((license_doc or {}).get("customer_id") or "").strip() or None
    return None


async def _active_license(customer_id: str, license_id: str | None = None, company_license_id: str | None = None) -> dict[str, Any] | None:
    db = _raw_db()
    now = datetime.now(timezone.utc)

    async def _valid(doc):
        if not doc or doc.get("status") not in {"active", "trial"}:
            return None
        expires = _aware(doc.get("expires_at"))
        if expires and expires <= now:
            return None
        return doc

    for candidate_id in (company_license_id, license_id):
        if candidate_id:
            valid = await _valid(await db.commercial_licenses.find_one({"id": candidate_id}, {"_id": 0}))
            if valid:
                return valid
    if not customer_id:
        return None
    docs = await db.commercial_licenses.find({"customer_id": customer_id, "status": {"$in": ["active", "trial"]}}, {"_id": 0}).sort("issued_at", -1).limit(20).to_list(20)
    for doc in docs:
        valid = await _valid(doc)
        if valid:
            return valid
    return None


def _apply_engagex_entitlement(data: dict[str, Any], license_doc: dict[str, Any]) -> None:
    """Bridge EngageX into the live auth object without weakening other modules.

    New licenses explicitly containing EngageX use their own selected page
    flags. Legacy full-suite licenses (all seven existing commercial modules)
    are treated as having the newly introduced EngageX module as a compatibility
    entitlement, so an existing all-access customer does not lose the benefit
    of a module added after the license was issued.
    """
    raw_modules = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
    normalized_modules = {str(item).strip().lower().replace("-", "_") for item in raw_modules}

    engagex_explicit = "engagex" in normalized_modules
    legacy_full_suite = FULL_SUITE_MODULES.issubset(normalized_modules)
    if not engagex_explicit and not legacy_full_suite:
        return

    if "engagex" not in normalized_modules:
        raw_modules.append("engagex")
        normalized_modules.add("engagex")
        data["licensed_modules"] = raw_modules

    selected = license_doc.get("selected_features") or {}
    selected_flags = set(selected.get("engagex") or []) if isinstance(selected, dict) else set()
    has_explicit_selection = "engagex" in selected

    # A newly issued EngageX license can select individual pages. A legacy full
    # suite has no EngageX entry because the module did not exist at issuance,
    # therefore all three EngageX pages are enabled by compatibility.
    if has_explicit_selection:
        allowed_pages = ENGAGEX_PAGE_FLAGS & selected_flags
    else:
        allowed_pages = set(ENGAGEX_PAGE_FLAGS)

    permissions = dict(data.get("permissions") or {})
    permissions["can_access_engagex"] = bool(allowed_pages)
    for flag in ENGAGEX_PAGE_FLAGS:
        permissions[flag] = flag in allowed_pages
    data["permissions"] = permissions

    # Also expose the compatibility selection to frontend code that uses the
    # normalized selected_features object to decide whether a page is visible.
    effective_selected = dict(data.get("selected_features") or {})
    if "engagex" not in effective_selected and allowed_pages:
        effective_selected["engagex"] = sorted(allowed_pages)
        data["selected_features"] = effective_selected


async def _hydrate(user: Any):
    if is_platform_owner(user):
        return user

    customer_id = await _resolve_customer_id(user)
    license_id = str(getattr(user, "license_id", "") or "").strip() or None
    company_license_id = None
    company_id = str(getattr(user, "company_id", "") or "").strip()

    if company_id:
        company = await _raw_db().companies.find_one({"id": company_id}, {"_id": 0, "commercial_customer_id": 1, "license_id": 1})
        company_license_id = str((company or {}).get("license_id") or "").strip() or None
        if not customer_id:
            customer_id = str((company or {}).get("commercial_customer_id") or "").strip() or None

    if not customer_id and not license_id and not company_license_id:
        return user

    license_doc = await _active_license(customer_id or "", license_id, company_license_id)
    if not license_doc:
        return user

    from backend.commercial_licensee_admin import resolve_license_modules
    from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

    modules = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
    data = user.model_dump()
    data["commercial_customer_id"] = customer_id or str(license_doc.get("customer_id") or "").strip() or None
    data["license_id"] = license_doc.get("id")
    data["license_key"] = license_doc.get("license_key")
    data["licensed_modules"] = modules
    data["selected_features"] = license_doc.get("selected_features") or {}

    if _is_admin_role(user):
        data["permissions"] = get_all_admin_permissions(license_doc)
        _apply_engagex_entitlement(data, license_doc)
    else:
        current_perms = dict(data.get("permissions") or {})
        licensed_mods = resolve_license_modules(license_doc)
        raw_module_names = {str(item).strip().lower().replace("-", "_") for item in modules}
        engagex_allowed = "engagex" in raw_module_names or FULL_SUITE_MODULES.issubset(raw_module_names)
        for mod_key, mod_def in MODULE_HIERARCHY.items():
            if mod_key != "admin" and mod_key not in licensed_mods:
                mod_flag = mod_def.get("flag")
                if mod_flag:
                    current_perms[mod_flag] = False
                for p in mod_def.get("pages", []):
                    p_flag = p.get("flag")
                    if p_flag:
                        current_perms[p_flag] = False
        data["permissions"] = current_perms
        if engagex_allowed:
            _apply_engagex_entitlement(data, license_doc)

    return type(user).model_validate(data)


_commercial_entitlement_base_get_current_user = None
_commercial_entitlement_hydrate = _hydrate


def install() -> None:
    current = _dependencies.get_current_user
    if getattr(_dependencies, "_commercial_entitlement_patch_installed", False):
        return

    base = types.FunctionType(current.__code__, current.__globals__, current.__name__, current.__defaults__, current.__closure__)
    base.__kwdefaults__ = current.__kwdefaults__
    target_globals = current.__globals__
    target_globals["_commercial_entitlement_base_get_current_user"] = base
    target_globals["_commercial_entitlement_hydrate"] = _hydrate
    target_globals["_commercial_entitlement_patch_installed"] = True

    async def _patched_get_current_user(credentials):
        user = await _commercial_entitlement_base_get_current_user(credentials)
        try:
            return await _commercial_entitlement_hydrate(user)
        except Exception:
            return user

    current.__code__ = _patched_get_current_user.__code__
    current.__kwdefaults__ = _patched_get_current_user.__kwdefaults__


install()
