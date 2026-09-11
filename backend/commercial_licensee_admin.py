"""Commercial Licensee Admin Management.

Concept:
Once a license is issued by the platform owner to the licensee, the email
added in the licensee account along with company id is by default ADMIN for his
company and his license. He does not need permission checks; he has all rights
by default like a normal admin of the application, limited to his license and
its connected users.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from passlib.context import CryptContext

from backend import dependencies as _dependencies
from backend.models import DEFAULT_ROLE_PERMISSIONS, User

logger = logging.getLogger("commercial_licensee_admin")

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def get_all_admin_permissions() -> Dict[str, Any]:
    """Return an unrestricted permission dictionary where every administrative
    and operational permission is set to True."""
    admin_perms = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
    admin_perms["can_access_whatsapp_hub"] = True
    return admin_perms


async def ensure_licensee_admin(
    customer: Dict[str, Any],
    license_doc: Dict[str, Any],
    company: Dict[str, Any],
    password: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Ensures that the email specified in the licensee customer account is created
    or updated as an active Administrator for that company and license, endowed with
    all rights by default.
    """
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

    admin_permissions = get_all_admin_permissions()
    now_iso = datetime.now(timezone.utc).isoformat()

    existing_user = await raw_db.users.find_one({"email": email})

    if existing_user:
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
        if password and len(password) >= 6:
            update_fields["password"] = pwd_context.hash(password)

        await raw_db.users.update_one({"email": email}, {"$set": update_fields})
        updated = await raw_db.users.find_one({"email": email}, {"_id": 0, "password": 0})
        logger.info("Updated existing user %s as licensee admin for company %s", email, company_id)
        return updated

    # User does not exist yet: create user account as admin
    default_password = password or customer.get("password") or "Admin@123"
    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
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
        logger.info("Created new licensee admin %s for company %s", email, company_id)
        return {k: v for k, v in user_doc.items() if k not in {"password", "_id"}}
    except Exception as exc:
        logger.warning("Failed to insert licensee admin %s: %s", email, exc)
        return None


async def sync_all_licensee_admins() -> int:
    """Scan all commercial customers and licenses to guarantee that every licensee
    contact email is initialized and kept as an active admin for their company."""
    raw_db = _raw_db()
    count = 0
    try:
        customers = await raw_db.commercial_license_customers.find({}, {"_id": 0}).to_list(500)
        for cust in customers:
            cust_id = cust.get("id")
            if not cust_id or not cust.get("email"):
                continue
            # Find active license
            license_doc = await raw_db.commercial_licenses.find_one(
                {"customer_id": cust_id, "status": "active"},
                {"_id": 0},
                sort=[("issued_at", -1)],
            )
            if not license_doc:
                license_doc = await raw_db.commercial_licenses.find_one(
                    {"customer_id": cust_id},
                    {"_id": 0},
                    sort=[("issued_at", -1)],
                )
            if not license_doc:
                continue

            company = await raw_db.companies.find_one(
                {"$or": [{"commercial_customer_id": cust_id}, {"id": cust_id}]},
                {"_id": 0},
            )
            if not company:
                company = {
                    "id": cust_id,
                    "name": cust.get("company_name") or "Licensed Company",
                    "commercial_customer_id": cust_id,
                    "source": "commercial-license",
                }

            res = await ensure_licensee_admin(cust, license_doc, company)
            if res:
                count += 1
    except Exception as exc:
        logger.warning("sync_all_licensee_admins encountered an issue: %s", exc)
    return count
