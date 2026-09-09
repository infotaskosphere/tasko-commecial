"""Single-use commercial license guard.

Rules enforced here (both at issuance and at redemption time):

1. A license number can be redeemed exactly once. Once it has been used to
   onboard a company (first administrator created), the same license number can
   never be applied again -- neither by the same company nor by a different
   company -- regardless of the license/company status (active, inactive,
   suspended, revoked or expired).
2. The only way to free a license number is to delete the license from the
   Commercial Console license list. Deleting the license record removes the
   claim stamp with it, so the number becomes issuable/usable again.
3. Issuing a second license for a customer/company that already has one in the
   Commercial Console is blocked with an explicit duplicate-license message,
   whatever the status of the existing license.

Install order: this module must be imported AFTER
``backend.commercial_onboarding_admin_compat`` and
``backend.commercial_onboarding_create_user_compat`` so it wraps the final
public onboarding handlers, and after ``backend.commercial_license_user_limit``
so it wraps the final license creation function.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from fastapi import HTTPException, status
from fastapi.dependencies.utils import get_dependant
from fastapi.routing import APIRoute

from backend import dependencies as _dependencies
from backend import licensing_api as _licensing_api
from backend.licensing_api import _now
from backend.commercial_onboarding import _norm, router

# ---------------------------------------------------------------------------
# Messages (kept user-facing and self-explanatory)
# ---------------------------------------------------------------------------

_ALREADY_USED_SAME_COMPANY = (
    "Duplicate license: this license number has already been activated for "
    "{company} on {when}. A commercial license can be used only once. To use a "
    "license number again, delete that license from the Commercial Console "
    "license list and issue a fresh license."
)

_ALREADY_USED_OTHER_COMPANY = (
    "Duplicate license: this license number is already registered to {company} "
    "(activated on {when}). It cannot be applied to another company. Please "
    "enter the license number issued to your company, or ask Taskosphere to "
    "issue a new license."
)

_DUPLICATE_ISSUE = (
    "Duplicate license: {company} already holds commercial license {key} "
    "(status: {status}). Only one license can exist per customer. Update or "
    "renew that license, or delete it from the Commercial Console license list "
    "before issuing a new one."
)


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def _key(value: Any) -> str:
    return str(value or "").strip().upper()


def _when(value: Any) -> str:
    text = str(value or "").strip()
    return text[:10] if text else "an earlier date"


# ---------------------------------------------------------------------------
# Claim detection
# ---------------------------------------------------------------------------


async def _license_by_key(license_key: str) -> Optional[Dict[str, Any]]:
    normalized = _key(license_key)
    if not normalized:
        return None
    db = _raw_db()
    return await db.commercial_licenses.find_one({"license_key": normalized}, {"_id": 0})


async def _claim_state(license_doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Return claim info when this license has already been consumed.

    A license counts as consumed when it carries an explicit claim stamp, or --
    for licenses issued before this guard existed -- when an administrator or a
    company record is already bound to it. Status is deliberately ignored: a
    revoked, suspended, inactive or expired license stays consumed.
    """
    if not license_doc:
        return None

    claim = license_doc.get("claim")
    if isinstance(claim, dict) and claim.get("claimed_at"):
        return claim

    db = _raw_db()
    license_id = str(license_doc.get("id") or "")
    license_key = _key(license_doc.get("license_key"))
    clauses = []
    if license_id:
        clauses.append({"license_id": license_id})
    if license_key:
        clauses.append({"license_key": license_key})
    if not clauses:
        return None

    admin = await db.users.find_one(
        {"$and": [{"$or": clauses}, {"role": "admin"}]},
        {"_id": 0, "email": 1, "company_id": 1, "company_name": 1, "created_at": 1},
    )
    if admin:
        return {
            "claimed_at": admin.get("created_at"),
            "company_id": admin.get("company_id"),
            "company_name": admin.get("company_name"),
            "email": admin.get("email"),
            "source": "existing-administrator",
        }

    company = await db.companies.find_one(
        {"$or": clauses}, {"_id": 0, "id": 1, "name": 1, "created_at": 1}
    )
    if company:
        # A company shell created by license generation is not a redemption on
        # its own; only treat it as consumed when it already has users.
        has_users = await db.users.find_one({"company_id": company.get("id")}, {"_id": 1})
        if has_users:
            return {
                "claimed_at": company.get("created_at"),
                "company_id": company.get("id"),
                "company_name": company.get("name"),
                "source": "existing-company",
            }
    return None


async def _assert_license_unused(payload: Dict[str, Any]) -> Dict[str, Any]:
    license_key = _key(payload.get("license_key"))
    company_name = str(payload.get("company_name") or "").strip()
    if not license_key or not company_name:
        raise HTTPException(
            status_code=400, detail="Company name and license number are required."
        )

    license_doc = await _license_by_key(license_key)
    if not license_doc:
        raise HTTPException(
            status_code=404,
            detail=(
                "This license number is not recognised. Check the number supplied "
                "by Taskosphere, or contact support."
            ),
        )

    claim = await _claim_state(license_doc)
    if claim:
        claimed_company = str(claim.get("company_name") or "another company")
        when = _when(claim.get("claimed_at"))
        if _norm(claimed_company) == _norm(company_name):
            detail = _ALREADY_USED_SAME_COMPANY.format(company=claimed_company, when=when)
        else:
            detail = _ALREADY_USED_OTHER_COMPANY.format(company=claimed_company, when=when)
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail)
    return license_doc


async def _stamp_claim(license_doc: Dict[str, Any], result: Dict[str, Any]) -> None:
    """Mark the license as consumed so it can never be applied again."""
    license_id = str(license_doc.get("id") or "")
    if not license_id:
        return
    company = (result or {}).get("company") or {}
    user = (result or {}).get("user") or {}
    await _raw_db().commercial_licenses.update_one(
        {"id": license_id},
        {
            "$set": {
                "claim": {
                    "claimed_at": _now().isoformat(),
                    "company_id": company.get("id"),
                    "company_name": company.get("name") or user.get("company_name"),
                    "email": user.get("email"),
                    "user_id": user.get("id"),
                    "source": "commercial-onboarding",
                },
                "claim_status": "consumed",
            }
        },
    )


# ---------------------------------------------------------------------------
# Route wrappers: license redemption
# ---------------------------------------------------------------------------


def _wrap_single_payload_route(path_suffix: str, *, stamp: bool) -> None:
    full_path = f"/commercial-onboarding/{path_suffix.lstrip('/')}"
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        if route.path != full_path or "POST" not in (route.methods or set()):
            continue

        previous: Callable = route.endpoint

        async def guarded(payload: Dict[str, Any], _previous=previous, _stamp=stamp):
            license_doc = await _assert_license_unused(payload)
            result = await _previous(payload)
            if _stamp:
                try:
                    await _stamp_claim(license_doc, result if isinstance(result, dict) else {})
                except Exception:  # never fail a successful onboarding on stamping
                    pass
            return result

        route.endpoint = guarded
        route.dependant = get_dependant(path=route.path_format, call=guarded)
        return


# ---------------------------------------------------------------------------
# Issuance guard: one live license record per customer/company name
# ---------------------------------------------------------------------------

_ORIGINAL_CREATE_LICENSE_RECORD = _licensing_api.create_license_record


async def _guarded_create_license_record(input_data: Dict[str, Any], created_by: str):
    db = _raw_db()
    company_name = str(input_data.get("company_name") or "").strip()
    customer_id = str(input_data.get("customer_id") or "").strip()

    existing = None
    if customer_id:
        existing = await db.commercial_licenses.find_one(
            {"customer_id": customer_id}, {"_id": 0, "license_key": 1, "status": 1}
        )
    if not existing and company_name:
        customers = await db.commercial_license_customers.find(
            {}, {"_id": 0, "id": 1, "company_name": 1}
        ).to_list(5000)
        normalized = _norm(company_name)
        match = next(
            (item for item in customers if _norm(item.get("company_name")) == normalized), None
        )
        if match:
            existing = await db.commercial_licenses.find_one(
                {"customer_id": match.get("id")}, {"_id": 0, "license_key": 1, "status": 1}
            )

    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=_DUPLICATE_ISSUE.format(
                company=company_name or "This customer",
                key=existing.get("license_key") or "on record",
                status=str(existing.get("status") or "unknown"),
            ),
        )

    return await _ORIGINAL_CREATE_LICENSE_RECORD(input_data, created_by)


def install() -> None:
    # Redemption: the first administrator consumes the license; every later
    # attempt with the same number is rejected.
    _wrap_single_payload_route("create-admin", stamp=True)
    # Read-only checks and later self-registrations must also refuse a license
    # number that was already consumed by a different company.
    _wrap_single_payload_route("lookup", stamp=False)

    # Issuance: no second license for a customer that already has one.
    _licensing_api.create_license_record = _guarded_create_license_record
    try:
        import backend.commercial_onboarding as _onboarding

        if hasattr(_onboarding, "create_license_record"):
            _onboarding.create_license_record = _guarded_create_license_record
    except Exception:
        pass
    try:
        import backend.commercial_onboarding_extensions as _onboarding_ext

        if hasattr(_onboarding_ext, "create_license_record"):
            _onboarding_ext.create_license_record = _guarded_create_license_record
    except Exception:
        pass


install()
