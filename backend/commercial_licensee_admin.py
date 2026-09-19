"""Commercial Licensee Admin Management.

The email recorded on a commercial license is the default administrator for
that license. It receives normal admin rights inside the licensed tenant, but
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

LICENSE_MODULE_ALIASES = {
    "tasks": "taskosphere",
    "taskosphere": "taskosphere",
    "invoicing": "finix",
    "accounting": "finix",
    "finix": "finix",
    "hrms": "people_matrix",
    "people_matrix": "people_matrix",
    "people-matrix": "people_matrix",
    "compliance": "compliance",
    "records": "records",
    "proposals": "proposals",
    "client_proposals": "proposals",
    "client-proposals": "proposals",
}

# These legacy permissions are still consumed by older pages/components. They
# must be reset together with the centralized page flags, otherwise an admin
# permission such as can_manage_invoices can accidentally keep an unselected
# commercial page visible. The commercial license is the cap; role=admin must
# never restore one of these flags after the cap is applied.
COMMERCIAL_LEGACY_PAGE_FLAGS = {
    "can_manage_invoices",
    "can_create_quotations",
    "can_view_clients",
    "can_view_all_clients",
    "can_edit_clients",
    "can_approve_clients",
    "can_view_all_leads",
    "can_view_passwords",
    "can_edit_passwords",
    "can_approve_whatsapp_wishes",
    "can_approve_email_wishes",
}


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def resolve_license_modules(license_doc: Dict[str, Any]) -> set[str]:
    resolved: set[str] = set()
    for raw in license_doc.get("modules") or license_doc.get("licensed_modules") or []:
        key = str(raw).strip().lower()
        mapped = LICENSE_MODULE_ALIASES.get(key)
        if mapped:
            resolved.add(mapped)
    return resolved


def get_all_admin_permissions(license_doc: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return admin rights capped by the commercial license's explicit page selections.

    A purchased module is only the parent entitlement. It does not grant every
    page. If selected_features is absent, no operational page is granted; the
    platform owner must explicitly select the pages that belong to the license.

    The reset of legacy aliases below is intentional. Several existing UI/API
    paths predate MODULE_HIERARCHY and still inspect flags such as
    can_manage_invoices. Leaving the admin defaults intact would silently
    re-open pages that were not selected in the commercial license.
    """
    if license_doc is None:
        admin_perms = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
        admin_perms["can_access_whatsapp_hub"] = True
        return admin_perms

    permissions = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
    licensed_modules = resolve_license_modules(license_doc)
    selected_features = license_doc.get("selected_features")
    if not isinstance(selected_features, dict):
        selected_features = {}

    # Start from the internal admin template, then hard-cap every commercial
    # operational page. This preserves tenant-admin control-plane privileges
    # while making the six licensed modules fail closed by default.
    for flag in COMMERCIAL_LEGACY_PAGE_FLAGS:
        permissions[flag] = False
    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        module_flag = module_def.get("flag")
        if module_flag:
            permissions[module_flag] = False
        for page in module_def.get("pages", []) or []:
            flag = page.get("flag")
            if flag:
                permissions[flag] = False

    for module_id, module_def in MODULE_HIERARCHY.items():
        if module_id == "admin":
            continue
        module_allowed = module_id in licensed_modules
        module_flag = module_def.get("flag")
        if module_flag:
            permissions[module_flag] = module_allowed

        raw_selected = selected_features.get(module_id)
        if raw_selected is None:
            for raw_key, value in selected_features.items():
                normalized = str(raw_key).strip().lower().replace("-", "_")
                if LICENSE_MODULE_ALIASES.get(normalized) == module_id:
                    raw_selected = value
                    break

        selected = {str(flag).strip() for flag in raw_selected} if isinstance(raw_selected, list) else set()
        # Dashboard/report entry pages are derived entitlements. Existing licenses
        # may have persisted page selections without the derived dashboard flag.
        # Keep runtime permissions aligned with normalize_dashboard_feature_selection.
        dashboard_flags = {
            "taskosphere": "can_view_dashboard",
            "finix": "can_view_accounting_reports",
            "compliance": "can_view_compliance",
            "records": "can_view_documents",
            "proposals": "can_view_all_leads",
            "people_matrix": "can_view_user_page",
        }
        dashboard_flag = dashboard_flags.get(module_id)
        if module_allowed and dashboard_flag and selected and dashboard_flag not in selected:
            selected.add(dashboard_flag)
        # A licensed module with no explicit page list (missing OR empty) grants every
        # page of that module -- and only that module. Unlicensed modules stay closed.
        no_explicit_pages = raw_selected is None or (isinstance(raw_selected, list) and len(raw_selected) == 0)
        # Backward compatibility for an existing license edited to add a module
        # without a selected_features entry. Explicit feature selections remain
        # authoritative and restrictive.
        if no_explicit_pages and module_allowed:
            selected = {str(page.get("flag")).strip() for page in module_def.get("pages", []) or [] if page.get("flag")}
        for page in module_def.get("pages", []) or []:
            flag = page.get("flag")
            if flag:
                permissions[flag] = bool(module_allowed and flag in selected)

        # Compatibility mappings for legacy screens. These are derived from
        # the same selected page flags; they are not independent entitlements.
        if module_id == "finix":
            permissions["can_manage_invoices"] = bool(module_allowed and "can_view_sale" in selected)
        elif module_id == "records":
            permissions["can_view_clients"] = bool(module_allowed and "can_view_all_clients" in selected)
            permissions["can_edit_clients"] = bool(module_allowed and "can_edit_clients" in selected)
            permissions["can_approve_clients"] = bool(module_allowed and "can_approve_clients" in selected)
            permissions["can_view_passwords"] = bool(module_allowed and "can_view_passwords" in selected)
            permissions["can_edit_passwords"] = bool(module_allowed and "can_edit_passwords" in selected)
            permissions["can_approve_whatsapp_wishes"] = bool(module_allowed and "can_approve_whatsapp_wishes" in selected)
            permissions["can_approve_email_wishes"] = bool(module_allowed and "can_approve_email_wishes" in selected)
        elif module_id == "proposals":
            permissions["can_view_all_leads"] = bool(module_allowed and "can_view_all_leads" in selected)
            permissions["can_create_quotations"] = bool(module_allowed and "can_create_quotations" in selected)

    return permissions


async def ensure_licensee_admin(
    customer: Dict[str, Any],
    license_doc: Dict[str, Any],
    company: Dict[str, Any],
    password: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
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
