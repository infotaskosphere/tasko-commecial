"""Compatibility for legacy company records in license-wide user limits."""
from __future__ import annotations

from typing import Any

from backend import commercial_license_user_limit as _limits

_INSTALLED = "_commercial_legacy_user_limit_compat_installed"


async def _customer_company_ids_legacy(customer_id: str) -> list[str]:
    raw_db = _limits._raw_db()
    license_doc = await _limits._active_license(customer_id)
    license_id = str(license_doc.get("id") or "").strip()
    clauses = [{"commercial_customer_id": customer_id}]
    if license_id:
        clauses.append({"license_id": license_id})
    rows = await raw_db.companies.find(
        {"$or": clauses}, {"_id": 0, "id": 1}
    ).to_list(5000)
    return [str(row.get("id")) for row in rows if row.get("id")]


async def _validate_user_company_legacy(customer_id: str, document: dict[str, Any]) -> None:
    company_id = str(document.get("company_id") or "").strip()
    if not company_id:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A licensed customer user must belong to a legal company.",
        )

    raw_db = _limits._raw_db()
    license_doc = await _limits._active_license(customer_id)
    license_id = str(license_doc.get("id") or "").strip()
    clauses = [{"commercial_customer_id": customer_id}]
    if license_id:
        clauses.append({"license_id": license_id})

    company = await raw_db.companies.find_one(
        {"id": company_id, "$or": clauses},
        {"_id": 0, "id": 1, "commercial_customer_id": 1, "license_id": 1},
    )
    if not company:
        from fastapi import HTTPException, status
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="User company does not belong to this licensed customer.",
        )

    # Once ownership is proven from the active license, normalize the legacy
    # record so subsequent requests use the canonical customer relationship.
    if str(company.get("commercial_customer_id") or "") != customer_id:
        await raw_db.companies.update_one(
            {"id": company_id, "$or": clauses},
            {"$set": {
                "commercial_customer_id": customer_id,
                "license_id": license_id or company.get("license_id"),
                "source": company.get("source") or "commercial-license",
            }},
        )


def install() -> None:
    if getattr(_limits, _INSTALLED, False):
        return
    _limits._customer_company_ids = _customer_company_ids_legacy
    _limits._validate_user_company = _validate_user_company_legacy
    setattr(_limits, _INSTALLED, True)


install()
