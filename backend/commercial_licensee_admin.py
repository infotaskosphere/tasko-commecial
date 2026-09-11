"""Commercial Licensee Admin Management.

The email recorded on a commercial license is the default administrator for
that license.  It receives normal admin rights inside the licensed tenant, but
those rights are hard-capped by the modules/features actually present on the
active license.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from passlib.context import CryptContext

from backend import dependencies as _dependencies
from backend.models import DEFAULT_ROLE_PERMISSIONS, MODULE_HIERARCHY, User

logger = logging.getLogger("commercial_licensee_admin")
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def _license_modules(license_doc: Dict[str, Any]) -> list[str]:
    return [str(item).strip().lower() for item in (license_doc.get("modules") or license_doc.get("licensed_modules") or []) if str(item).strip()]


def _license_permissions(license_doc: Dict[str, Any]) -> Dict[str, Any]:
    """Admin permissions are full inside the licensed feature set only."""
    permissions = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
    modules = set(_license_modules(license_doc))
    selected_features = license_doc.get("selected_features") or {}

    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        allowed = module_id in modules
        module_flag = module_def.get("flag")
        if module_flag:
            permissions[module_flag] = allowed
        selected = set(selected_features.get(module_id) or [])
        # A legacy module-only license means every page in that module.
        feature_restriction_exists = module_id in selected_features
        for page in module_def.get("pages", []) or []:
            flag = page.get("flag")
            if not flag:
                continue
            permissions[flag] = bool(
                allowed and (not feature_restriction_exists or flag in selected)
            )

    return permissions


def get_all_admin_permissions(license_doc: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return admin rights, optionally capped by a commercial license."""
    if license_doc is None:
        admin_perms = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
        admin_perms["can_access_whatsapp_hub"] = True
        return admin_perms
    return _license_permissions(license_doc)


async def ensure_licensee_admin(
    customer: Dict[str, Any],
    license_doc: Dict[str, Any],
    company: Dict[str, Any],
    password: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Create/update the license contact as the default tenant administrator."""
    raw_db = _raw_db()
    email = str(customer.get("email") or "").strip().lower()
    if not email:
        return None

    company_id = str(company.get("id") or customer.get("id") or "").strip()
    company_name = str(company.get("name") or customer.get("company_name") or "Licensed Company").strip()
    customer_id = str(customer.get("id") or license_doc.get("customer_id") or "").strip()
    license_id = str(license_doc.get("id") or "").strip()
    license_key = str(license_doc.get("license_key") or "").strip()
    licensed_modules = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
    selected_features = license_doc.get("selected_features") or {}
    admin_permissions = get_all_admin_permissions(license_doc)
    now_iso = datetime.now(timezone.utc).isoformat()

    existing_user = await raw_db.users.find_one({"email": email})
    update_fields = {
        "role": "admin",
        "company_id": company_id,
        "company_name": company_name,
        "commercial_customer_id": customer_id,
        "license_id": license_id,
        "license_key": license_key,
        "licensed_modules": licensed_modules,
        "selected_features": selected_features,
        "permissions": admin_permissions,
        "status": "active",
        "is_active": True,
    }

    if existing_user:
        if password and len(password) >= 6:
            update_fields["password"] = pwd_context.hash(password)
        await raw_db.users.update_one({"_id": existing_user.get("_id")}, {"$set": update_fields})
        updated = await raw_db.users.find_one({"_id": existing_user.get("_id")}, {"_id": 0, "password": 0})
        logger.info("Updated licensee admin %s for customer %s/license %s", email, customer_id, license_id)
        return updated

    default_password = password or customer.get("password") or "Admin@123"
    user_doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "full_name": customer.get("contact_name") or f"{company_name} Admin",
        "role": "admin",
        "password": pwd_context.hash(default_password),
        "permissions": admin_permissions,
        "departments": [],
        "phone": customer.get("phone"),
        "is_active": True,
        "status": "active",
        "approved_by": "commercial-license",
        "approved_at": now_iso,
        "created_at": now_iso,
        "company_id": company_id,
        "company_name": company_name,
        "commercial_customer_id": customer_id,
        "license_id": license_id,
        "license_key": license_key,
        "licensed_modules": licensed_modules,
        "selected_features": selected_features,
    }
    try:
        await raw_db.users.insert_one(user_doc)
        logger.info("Created licensee admin %s for customer %s/license %s", email, customer_id, license_id)
        return {k: v for k, v in user_doc.items() if k not in {"password", "_id"}}
    except Exception as exc:
        logger.warning("Failed to insert licensee admin %s: %s", email, exc)
        return None


async def sync_all_licensee_admins() -> int:
    """Repair/synchronize every commercial license contact to its active license."""
    raw_db = _raw_db()
    count = 0
    try:
        customers = await raw_db.commercial_license_customers.find({}, {"_id": 0}).to_list(500)
        for customer in customers:
            customer_id = str(customer.get("id") or "").strip()
            email = str(customer.get("email") or "").strip()
            if not customer_id or not email:
                continue
            license_doc = await raw_db.commercial_licenses.find_one(
                {"customer_id": customer_id, "status": "active"},
                {"_id": 0},
                sort=[("issued_at", -1)],
            )
            if not license_doc:
                continue
            expires_at = license_doc.get("expires_at")
            if expires_at:
                try:
                    expiry = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
                    if expiry.tzinfo is None:
                        expiry = expiry.replace(tzinfo=timezone.utc)
                    if expiry <= datetime.now(timezone.utc):
                        continue
                except Exception:
                    continue

            company = await raw_db.companies.find_one(
                {"$or": [{"commercial_customer_id": customer_id}, {"id": customer_id}]},
                {"_id": 0},
            )
            if not company:
                company = {"id": customer_id, "name": customer.get("company_name") or "Licensed Company", "commercial_customer_id": customer_id, "source": "commercial-license"}

            if await ensure_licensee_admin(customer, license_doc, company):
                count += 1
    except Exception as exc:
        logger.warning("sync_all_licensee_admins encountered an issue: %s", exc)
    return count
