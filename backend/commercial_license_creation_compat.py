"""Compatibility guard for commercial license issuance.

The custom Commercial Console form creates a new customer id automatically,
so a generic customer-id-only guard cannot detect a second issuance for the
same customer. The commercial onboarding customer is identified by its
registered customer/company name at issuance time; block a second license for
that customer before the canonical generator runs.
"""
from __future__ import annotations

from typing import Any, Dict

from fastapi import Depends, HTTPException, status
from fastapi.dependencies.utils import get_dependant
from fastapi.routing import APIRoute

from backend.dependencies import require_admin
from backend.commercial_onboarding import _norm, router


async def _generate_license_with_one_customer_guard(payload: Dict[str, Any], current_user=Depends(require_admin())):
    company_name = str(payload.get("company_name") or "").strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")

    from backend import dependencies as _dependencies
    db = getattr(_dependencies, "_raw_db", _dependencies.db)
    candidates = await db.commercial_license_customers.find(
        {}, {"_id": 0, "id": 1, "company_name": 1}
    ).to_list(5000)
    normalized = _norm(company_name)
    customer = next((item for item in candidates if _norm(item.get("company_name")) == normalized), None)
    if customer:
        existing = await db.commercial_licenses.find_one(
            {"customer_id": customer.get("id")},
            {"_id": 0, "id": 1, "license_key": 1, "status": 1},
        )
        if existing:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "This customer already has a commercial license. "
                    "Update or renew the existing license instead of issuing another one."
                ),
            )

    # Import at call time so the canonical onboarding endpoint and its existing
    # commercial invoice flow remain unchanged.
    from backend.commercial_onboarding import generate_license
    return await generate_license(payload, current_user)


def install() -> None:
    full_path = "/commercial-onboarding/generate-license"
    for route in router.routes:
        if isinstance(route, APIRoute) and route.path == full_path and "POST" in (route.methods or set()):
            route.endpoint = _generate_license_with_one_customer_guard
            route.dependant = get_dependant(path=route.path_format, call=_generate_license_with_one_customer_guard)
            return


install()
