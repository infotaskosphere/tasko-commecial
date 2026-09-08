"""Platform-owner editor for commercial customer/license registry records."""
from typing import Any, Dict, List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from backend.dependencies import db, get_current_user
from backend.models import User, MODULE_HIERARCHY
from backend.platform_owner import is_platform_owner
from backend.commercial_onboarding import MODULE_IDS

router = APIRouter(prefix="/commercial-master-data", tags=["commercial-customer-directory"])


def _require_platform_owner(current_user: User) -> None:
    if not is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="Commercial customer administration is restricted to the platform owner.")


def _public(value: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(value or {})
    result.pop("_id", None)
    return result


def _feature_flags(module_id: str) -> List[str]:
    module = MODULE_HIERARCHY.get(module_id, {})
    return [str(page.get("flag")) for page in module.get("pages", []) if page.get("flag")]


@router.put("/customers/{customer_id}")
async def update_commercial_customer(
    customer_id: str,
    payload: Dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    _require_platform_owner(current_user)
    customer = await db.commercial_license_customers.find_one({"id": str(customer_id)}, {"_id": 0})
    if not customer:
        raise HTTPException(status_code=404, detail="Commercial customer was not found.")

    company_name = str(payload.get("company_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    if not email:
        raise HTTPException(status_code=400, detail="Email is required.")

    update = {
        "company_name": company_name,
        "contact_name": str(payload.get("contact_name") or "").strip(),
        "email": email,
        "phone": str(payload.get("phone") or "").strip(),
        "gstin": str(payload.get("gstin") or "").strip().upper(),
        "address": str(payload.get("address") or "").strip(),
        "gst_address": str(payload.get("gst_address") or "").strip(),
        "city": str(payload.get("city") or "").strip(),
        "state": str(payload.get("state") or "").strip(),
        "pincode": str(payload.get("pincode") or "").strip(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.commercial_license_customers.update_one({"id": str(customer_id)}, {"$set": update})

    # Keep any hidden license-created operational company synchronized without
    # exposing that company in the platform owner's Company Master list.
    await db.companies.update_many(
        {"commercial_customer_id": str(customer_id), "source": "commercial-license"},
        {"$set": {
            "name": company_name, "company_name": company_name, "email": email,
            "phone": update["phone"], "gstin": update["gstin"], "address": update["address"],
            "gst_address": update["gst_address"], "city": update["city"], "state": update["state"],
            "pincode": update["pincode"], "updated_at": update["updated_at"],
        }},
    )
    updated = await db.commercial_license_customers.find_one({"id": str(customer_id)}, {"_id": 0})
    return _public(updated or {})


@router.put("/licenses/{license_id}")
async def update_commercial_license(
    license_id: str,
    payload: Dict[str, Any],
    current_user: User = Depends(get_current_user),
):
    _require_platform_owner(current_user)
    license_doc = await db.commercial_licenses.find_one({"id": str(license_id)}, {"_id": 0})
    if not license_doc:
        raise HTTPException(status_code=404, detail="License was not found.")

    customer_id = str(license_doc.get("customer_id") or "")
    customer = await db.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
    if not customer:
        raise HTTPException(status_code=404, detail="Commercial customer was not found.")

    raw_modules = payload.get("modules", license_doc.get("modules") or [])
    modules = []
    for raw in raw_modules if isinstance(raw_modules, list) else []:
        module_id = str(raw).strip().lower()
        if module_id in MODULE_IDS and module_id not in modules:
            modules.append(module_id)
    if not modules:
        raise HTTPException(status_code=400, detail="Select at least one licensed module.")

    raw_features = payload.get("selected_features", license_doc.get("selected_features") or {})
    selected_features: Dict[str, List[str]] = {}
    if not isinstance(raw_features, dict):
        raise HTTPException(status_code=400, detail="Feature access must be an object.")
    for module_id in modules:
        allowed = set(_feature_flags(module_id))
        raw = raw_features.get(module_id)
        if raw is None:
            selected = sorted(allowed)
        elif isinstance(raw, list):
            selected = []
            for flag in raw:
                flag = str(flag).strip()
                if flag in allowed and flag not in selected:
                    selected.append(flag)
        else:
            raise HTTPException(status_code=400, detail=f"Features for {module_id} must be a list.")
        if not selected:
            raise HTTPException(status_code=400, detail=f"Select at least one feature in {module_id}.")
        selected_features[module_id] = selected

    updates = {
        "modules": modules,
        "selected_features": selected_features,
        "licensed_modules": modules,
        "last_event_at": datetime.now(timezone.utc).isoformat(),
    }
    if "max_users" in payload:
        updates["max_users"] = max(1, int(payload.get("max_users") or 1))
    if "max_installations" in payload:
        updates["max_installations"] = max(1, int(payload.get("max_installations") or 1))
    await db.commercial_licenses.update_one({"id": str(license_id)}, {"$set": updates})
    await db.commercial_license_customers.update_one(
        {"id": customer_id},
        {"$set": {"licensed_modules": modules, "selected_features": selected_features, "updated_at": updates["last_event_at"]}},
    )
    await db.companies.update_many(
        {"commercial_customer_id": customer_id, "source": "commercial-license"},
        {"$set": {"licensed_modules": modules, "selected_features": selected_features, "license_id": str(license_id)}},
    )
    updated = await db.commercial_licenses.find_one({"id": str(license_id)}, {"_id": 0})
    return _public(updated or {})


from backend.permission_governance import router as _permission_governance_router
_permission_governance_router.include_router(router)
