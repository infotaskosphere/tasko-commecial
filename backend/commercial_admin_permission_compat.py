"""Synchronize commercial administrator permissions with the active license."""

from datetime import datetime, timezone
from fastapi import Depends

from backend import dependencies as _dependencies
from backend.models import User
from backend.platform_owner import is_platform_owner

_original_get_current_user = _dependencies.get_current_user


def _aware(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return None


async def _hydrate(user: User) -> User:
    if is_platform_owner(user):
        return user

    company_id = str(getattr(user, "company_id", "") or "").strip()
    customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
    license_id = str(getattr(user, "license_id", "") or "").strip()

    try:
        db = getattr(_dependencies, "_raw_db", _dependencies.db)
        if not customer_id and getattr(user, "email", None):
            cust = await db.commercial_customers.find_one({"email": str(user.email).lower().strip()}, {"_id": 0})
            if cust:
                customer_id = str(cust.get("id") or "")

        company = None
        if company_id:
            company = await db.companies.find_one({"id": company_id}, {"_id": 0})
        customer_id = customer_id or str((company or {}).get("commercial_customer_id") or "").strip()
        license_id = license_id or str((company or {}).get("license_id") or "").strip()

        query = []
        if customer_id:
            query.append({"customer_id": customer_id})
        if license_id:
            query.append({"id": license_id})
        if not query:
            return user

        licenses = await db.commercial_licenses.find({"$or": query, "status": {"$in": ["active", "trial"]}}, {"_id": 0}).to_list(100)
        now = datetime.now(timezone.utc)
        active = [doc for doc in licenses if not doc.get("expires_at") or (_aware(doc.get("expires_at")) and _aware(doc.get("expires_at")) > now)]
        if not active:
            return user
        active.sort(key=lambda x: str(x.get("issued_at") or ""), reverse=True)
        license_doc = active[0]

        from backend.commercial_licensee_admin import get_all_admin_permissions, MODULE_HIERARCHY
        licensed_modules = set(license_doc.get("modules") or license_doc.get("licensed_modules") or [])

        data = user.model_dump()
        data["commercial_customer_id"] = customer_id or license_doc.get("customer_id")
        data["licensed_modules"] = list(licensed_modules)
        data["selected_features"] = license_doc.get("selected_features") or {}
        data["license_id"] = license_doc.get("id")
        data["license_key"] = license_doc.get("license_key")

        if str(getattr(user, "role", "")).lower() == "admin":
            data["permissions"] = get_all_admin_permissions(license_doc)
        else:
            perms = dict(data.get("permissions") or {})
            for mod_key, flags in MODULE_HIERARCHY.items():
                if mod_key not in licensed_modules:
                    for f in flags:
                        perms[f] = False
            data["permissions"] = perms

        return User.model_validate(data)
    except Exception:
        return user


async def get_current_user_with_commercial_admin_permissions(credentials=Depends(_dependencies.security)):
    user = await _original_get_current_user(credentials)
    return await _hydrate(user)


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_commercial_admin_permissions":
        _dependencies.get_current_user = get_current_user_with_commercial_admin_permissions
