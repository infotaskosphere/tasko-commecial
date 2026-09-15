"""Fail-closed recovery of the operational company for legacy users.

Older commercial user records can legitimately pre-date ``company_id`` being
stamped on the user document.  Authentication must recover the company only
from deterministic ownership links; it must never guess a tenant.

This module is installed lazily after ``backend.dependencies`` has finished
loading so it cannot participate in the authentication import cycle.
"""

from __future__ import annotations

from typing import Optional


def install() -> None:
    """Install the hardened company resolver exactly once."""
    from backend import dependencies as deps

    current = getattr(deps, "_resolve_licensed_company_id", None)
    if current is None or getattr(current, "__name__", "") == "_resolve_licensed_company_id_hardened":
        return

    original = current

    async def _resolve_licensed_company_id_hardened(user) -> Optional[str]:
        """Resolve one and only one operational company from explicit links."""
        raw_db = globals().get("_raw_db") or getattr(deps, "_raw_db", deps.db)

        customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
        license_id = str(getattr(user, "license_id", "") or "").strip()
        license_key = str(getattr(user, "license_key", "") or "").strip()
        email = str(getattr(user, "email", "") or "").strip().lower()

        # First retain the existing deterministic resolver for backward
        # compatibility.  It already requires exactly one company match.
        try:
            resolved = await original(user)
            if resolved:
                company = await raw_db.companies.find_one(
                    {"id": str(resolved), "status": {"$ne": "deleted"}},
                    {"id": 1, "_id": 0},
                )
                if company and company.get("id"):
                    return str(company["id"])
                try:
                    company = await raw_db.companies.find_one(
                        {"_id": resolved, "status": {"$ne": "deleted"}},
                        {"id": 1, "_id": 0},
                    )
                    if company:
                        return str(company.get("id") or company.get("_id"))
                except Exception:
                    pass
        except Exception:
            # Continue to the explicit-link recovery paths below.
            pass

        clauses = []
        if customer_id and customer_id not in {"platform-owner", "platform-owner-license"}:
            clauses.append({"commercial_customer_id": customer_id})
        if license_id and license_id not in {"platform-owner", "platform-owner-license"}:
            clauses.append({"license_id": license_id})
        if license_key:
            clauses.append({"license_key": license_key})

        # The commercial customer record is an explicit ownership link.  Use
        # its id to locate the corresponding operational company when the
        # legacy user has only email + license/customer metadata.
        if email:
            customer = await raw_db.commercial_license_customers.find_one(
                {"email": email}, {"id": 1, "_id": 0}
            )
            if customer and customer.get("id"):
                clauses.append({"commercial_customer_id": str(customer["id"])})

        if not clauses:
            return None

        # Query a maximum of two records: one is required; two means the link
        # is ambiguous and must fail closed rather than selecting a tenant.
        rows = await raw_db.companies.find(
            {"$or": clauses, "status": {"$ne": "deleted"}},
            {"id": 1, "_id": 1, "status": 1},
        ).limit(2).to_list(2)
        if len(rows) != 1:
            return None

        company = rows[0]
        company_id = str(company.get("id") or company.get("_id") or "").strip()
        if not company_id:
            return None

        # Persist the recovered tenant link so subsequent requests take the
        # normal fast path. This is a self-healing migration, not a guess.
        user_id = str(getattr(user, "id", "") or "").strip()
        if user_id:
            try:
                await raw_db.users.update_one(
                    {"id": user_id},
                    {"$set": {"company_id": company_id}},
                )
            except Exception:
                # Recovery remains valid for this request even if persistence
                # is temporarily unavailable.
                pass

        return company_id

    _resolve_licensed_company_id_hardened.__name__ = "_resolve_licensed_company_id_hardened"
    deps._resolve_licensed_company_id = _resolve_licensed_company_id_hardened
