"""Compatibility repair for Commercial Master Data user visibility.

Roles/People Matrix and Commercial Master Data are intended to consume the
same users collection. The old Master Data endpoint filtered only by the
current legal company's ``company_id``. Commercial licenses, however, own the
user seats at customer level and legacy users may carry either
``commercial_customer_id`` or an older legal-company id.

This wrapper keeps the existing endpoint path and response shape while using
the canonical license-wide query helper already present in
commercial_master_data.py. It also preserves the existing company/license
context and never returns password fields.
"""

from backend import commercial_master_data as _master
from backend.dependencies import db, get_current_user
from backend.platform_owner import is_platform_owner

_INSTALLED = False


def install():
    global _INSTALLED
    if _INSTALLED:
        return

    async def list_company_users_compat(current_user=__import__("fastapi").Depends(get_current_user)):
        license_doc, company = await _master._company_context(current_user)

        if is_platform_owner(current_user):
            return await _master.list_company_users(current_user)

        query = await _master._license_user_query(license_doc, company)

        # Preserve one more historical identity: users created before the
        # commercial customer field was introduced may still carry exactly the
        # company_id that was present on the authenticated account. Include it
        # in the same customer-scoped OR rather than dropping those users.
        legacy_company_id = str(getattr(current_user, "company_id", "") or "").strip()
        if legacy_company_id:
            query.setdefault("$or", []).append({"company_id": legacy_company_id})

        users = await db.users.find(
            query,
            {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0},
        ).sort("full_name", 1).to_list(2000)
        return {
            "company": company,
            "license": {
                "id": license_doc.get("id"),
                "license_key": license_doc.get("license_key"),
                "max_users": int(license_doc.get("max_users", 1)),
                "modules": list(license_doc.get("modules") or []),
                "selected_features": license_doc.get("selected_features") or {},
            },
            "users": [_master._clean_user(u) for u in users],
        }

    for route in getattr(_master.router, "routes", []):
        if getattr(route, "path", "") == "/commercial-master-data/users":
            route.endpoint = list_company_users_compat
            if getattr(route, "dependant", None) is not None:
                route.dependant.call = list_company_users_compat
            break

    _INSTALLED = True
