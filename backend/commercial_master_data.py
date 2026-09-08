"""Commercial tenant Master Data — company-scoped user administration.

User administration is intentionally kept outside People Matrix licensing. A
commercial customer may buy Taskosphere, Finix, Compliance, Records or any
other module individually, but the licensed company's administrator must
always be able to maintain the company's user directory from Admin → Master
Data. People Matrix consumes the same users collection and HR fields when
it is licensed; it does not own the user accounts.
"""
import uuid
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.dependencies import db, get_current_user, create_audit_log
from backend.models import User
from backend.commercial_onboarding import _active_company_license, pwd_context
from backend.commercial_onboarding_extensions import _apply_feature_entitlements
from backend.platform_owner import is_platform_owner

router = APIRouter(prefix="/commercial-master-data", tags=["commercial-master-data"])

USER_FIELDS = {
    "full_name", "email", "role", "departments", "phone", "birthday",
    "telegram_id", "punch_in_time", "grace_time", "punch_out_time",
    "profile_picture", "joining_date", "training_period_end", "payroll_date",
    "monthly_salary", "employee_code", "designation", "department_id",
    "reporting_manager_id", "employment_type", "confirmation_date", "grade",
    "cost_centre", "pan_number", "aadhaar_number", "uan_number", "pf_number",
    "esic_number", "bank_account_number", "bank_name", "ifsc_code",
}


def _now() -> str:
    return datetime.utcnow().isoformat() + "+00:00"


async def _company_context(current_user: User):
    # The platform owner is the software seller, not a commercial customer
    # tenant. Keep this endpoint harmless for that account so a stale frontend
    # bundle cannot turn an owner visit into a misleading 403.
    if is_platform_owner(current_user):
        return None, None
    if getattr(current_user, "role", None) != "admin" or not getattr(current_user, "company_id", None):
        raise HTTPException(status_code=403, detail="Company Master user administration is available only to a licensed company administrator.")
    license_doc = await _active_company_license(current_user)
    company_id = str(current_user.company_id)
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if not company:
        raise HTTPException(status_code=404, detail="Licensed company profile not found.")
    return license_doc, company


async def _platform_company_context(current_user: User, company_id: str):
    """Resolve a legal company for platform-owner administration only."""
    if not is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="Platform-level customer user administration is restricted to the software platform owner.")
    company_id = str(company_id or "").strip()
    if not company_id:
        raise HTTPException(status_code=400, detail="A customer company is required.")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if not company:
        raise HTTPException(status_code=404, detail="Customer company not found.")

    # The license belongs to the commercial customer, not to the legal entity.
    # Keep a legacy fallback for older company records that used company_id as
    # the license customer_id.
    customer_id = str(company.get("commercial_customer_id") or company_id)
    license_doc = await db.commercial_licenses.find_one(
        {"customer_id": customer_id, "status": "active"},
        {"_id": 0},
        sort=[("issued_at", -1)],
    )
    if not license_doc:
        raise HTTPException(status_code=403, detail="No active commercial license is linked to this company.")
    return license_doc, company


def _clean_user(doc: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(doc or {})
    out.pop("_id", None)
    for key in ("password", "password_hash", "password_salt"):
        out.pop(key, None)
    return out


def _date_value(value):
    if value in (None, ""):
        return None
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _license_permissions(role: str, license_doc: Dict[str, Any]) -> Dict[str, Any]:
    return _apply_feature_entitlements(
        role,
        list(license_doc.get("modules") or []),
        license_doc.get("selected_features") or {},
    )


@router.get("/users")
async def list_company_users(current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        return {
            "company": None,
            "license": None,
            "users": [],
            "platform_owner": True,
        }
    users = await db.users.find(
        {"company_id": str(company["id"])},
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
        "users": [_clean_user(u) for u in users],
    }


@router.get("/platform-users")
async def list_platform_company_users(
    company_id: str = Query(...),
    current_user: User = Depends(get_current_user),
):
    license_doc, company = await _platform_company_context(current_user, company_id)
    users = await db.users.find(
        {"company_id": str(company["id"]), "status": {"$ne": "deleted"}},
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
        "users": [_clean_user(u) for u in users],
        "platform_owner": True,
    }


@router.post("/platform-users", status_code=201)
async def create_platform_company_user(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    company_id = str(payload.get("company_id") or "").strip()
    license_doc, company = await _platform_company_context(current_user, company_id)
    email = str(payload.get("email") or "").strip().lower()
    full_name = str(payload.get("full_name") or "").strip()
    password = str(payload.get("password") or "")
    if not full_name or not email:
        raise HTTPException(status_code=400, detail="Full name and email are required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    max_users = max(1, int(license_doc.get("max_users", 1)))
    user_count = await db.users.count_documents({"company_id": company_id, "status": {"$ne": "deleted"}})
    if user_count >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")

    role = str(payload.get("role") or "staff").strip().lower()
    if role not in {"staff", "manager", "admin"}:
        role = "staff"
    now = _now()
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": role,
        "password": pwd_context.hash(password),
        "permissions": _license_permissions(role, license_doc),
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True,
        "status": "active",
        "approved_by": current_user.id,
        "approved_at": now,
        "created_at": now,
        "company_id": company_id,
        "company_name": company.get("name") or company.get("company_name"),
        "commercial_customer_id": company.get("commercial_customer_id"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }
    hr_fields = {
        "designation", "employee_code", "department_id", "birthday", "joining_date",
        "training_period_end", "payroll_date", "confirmation_date", "employment_type",
        "grade", "cost_centre", "pan_number", "aadhaar_number", "uan_number",
        "pf_number", "esic_number", "bank_account_number", "bank_name", "ifsc_code",
        "monthly_salary", "telegram_id", "punch_in_time", "grace_time", "punch_out_time",
        "profile_picture", "reporting_manager_id",
    }
    for field in hr_fields:
        if field not in payload:
            continue
        value = payload.get(field)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        doc[field] = _date_value(value) if field in {"birthday", "joining_date", "training_period_end", "payroll_date", "confirmation_date"} else (value if value != "" else None)

    await db.users.insert_one(doc)
    safe = _clean_user(doc)
    await create_audit_log(current_user, "CREATE_PLATFORM_COMPANY_USER", "company_master_users", user_id, new_data=safe)
    return safe


@router.put("/platform-users/{user_id}")
async def update_platform_company_user(
    user_id: str,
    payload: Dict[str, Any],
    company_id: str = Query(...),
    current_user: User = Depends(get_current_user),
):
    license_doc, company = await _platform_company_context(current_user, company_id)
    existing = await db.users.find_one({"id": user_id, "company_id": str(company["id"])}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")

    updates: Dict[str, Any] = {}
    for field in USER_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field in {"joining_date", "training_period_end", "payroll_date", "confirmation_date"}:
            value = _date_value(value)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        updates[field] = value if value != "" else None

    if "password" in payload and str(payload.get("password") or "").strip():
        password = str(payload["password"]).strip()
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        updates["password"] = pwd_context.hash(password)

    role = str(updates.get("role") or existing.get("role") or "staff").lower()
    if role not in {"staff", "manager", "admin"}:
        role = "staff"
    updates["role"] = role
    updates["permissions"] = _license_permissions(role, license_doc)
    updates["licensed_modules"] = list(license_doc.get("modules") or [])
    updates["selected_features"] = license_doc.get("selected_features") or {}

    if updates:
        await db.users.update_one({"id": user_id, "company_id": str(company["id"])}, {"$set": updates})
    safe_updates = {k: v for k, v in updates.items() if k != "password"}
    await create_audit_log(current_user, "UPDATE_PLATFORM_COMPANY_USER", "company_master_users", user_id, old_data=_clean_user(existing), new_data=safe_updates)
    updated = await db.users.find_one({"id": user_id, "company_id": str(company["id"])}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    return _clean_user(updated or {})


async def _platform_change_user_status(user_id: str, company_id: str, status: str, current_user: User):
    license_doc, company = await _platform_company_context(current_user, company_id)
    existing = await db.users.find_one({"id": user_id, "company_id": str(company["id"])}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")
    if status == "active":
        max_users = max(1, int(license_doc.get("max_users", 1)))
        active_count = await db.users.count_documents({"company_id": str(company["id"]), "status": "active"})
        if active_count >= max_users and existing.get("status") != "active":
            raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
        update = {"status": "active", "is_active": True, "approved_by": current_user.id, "approved_at": _now()}
        action = "ACTIVATE_PLATFORM_COMPANY_USER"
    else:
        update = {"status": "inactive", "is_active": False}
        action = "DEACTIVATE_PLATFORM_COMPANY_USER"
    await db.users.update_one({"id": user_id, "company_id": str(company["id"])}, {"$set": update})
    await create_audit_log(current_user, action, "company_master_users", user_id, old_data=_clean_user(existing), new_data=update)
    return {"message": f"User {status} successfully", "user_id": user_id, "status": status}


@router.post("/platform-users/{user_id}/activate")
async def activate_platform_company_user(user_id: str, company_id: str = Query(...), current_user: User = Depends(get_current_user)):
    return await _platform_change_user_status(user_id, company_id, "active", current_user)


@router.post("/platform-users/{user_id}/deactivate")
async def deactivate_platform_company_user(user_id: str, company_id: str = Query(...), current_user: User = Depends(get_current_user)):
    return await _platform_change_user_status(user_id, company_id, "inactive", current_user)


@router.post("/users", status_code=201)
async def create_company_user(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant and cannot create customer users here.")
    email = str(payload.get("email") or "").strip().lower()
    full_name = str(payload.get("full_name") or "").strip()
    password = str(payload.get("password") or "")
    if not full_name or not email:
        raise HTTPException(status_code=400, detail="Full name and email are required.")
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
    if await db.users.find_one({"email": email}, {"_id": 1}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    company_id = str(company["id"])
    max_users = max(1, int(license_doc.get("max_users", 1)))
    user_count = await db.users.count_documents({"company_id": company_id, "status": {"$ne": "deleted"}})
    if user_count >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")

    role = str(payload.get("role") or "staff").strip().lower()
    if role not in {"staff", "manager"}:
        role = "staff"

    now = _now()
    user_id = str(uuid.uuid4())
    doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": role,
        "password": pwd_context.hash(password),
        "permissions": _license_permissions(role, license_doc),
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None,
        "punch_in_time": str(payload.get("punch_in_time") or "10:30"),
        "grace_time": str(payload.get("grace_time") or "00:10"),
        "punch_out_time": str(payload.get("punch_out_time") or "19:00"),
        "profile_picture": payload.get("profile_picture"),
        "is_active": False,
        "status": "pending_approval",
        "approved_by": None,
        "approved_at": None,
        "created_at": now,
        "company_id": company_id,
        "company_name": company.get("name") or current_user.company_name,
        "commercial_customer_id": company.get("commercial_customer_id"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
    }
    hr_fields = {
        "joining_date", "training_period_end", "payroll_date", "confirmation_date",
        "employee_code", "designation", "department_id", "reporting_manager_id",
        "employment_type", "grade", "cost_centre", "pan_number", "aadhaar_number",
        "uan_number", "pf_number", "esic_number", "bank_account_number",
        "bank_name", "ifsc_code", "monthly_salary",
    }
    for field in hr_fields:
        if field not in payload:
            continue
        value = payload.get(field)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        doc[field] = _date_value(value) if field in {"joining_date", "training_period_end", "payroll_date", "confirmation_date"} else (value if value != "" else None)

    await db.users.insert_one(doc)
    safe = _clean_user(doc)
    await create_audit_log(current_user, "CREATE_COMPANY_USER", "company_master_users", user_id, new_data=safe)
    return safe


@router.put("/users/{user_id}")
async def update_company_user(user_id: str, payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant and cannot edit customer users here.")
    company_id = str(company["id"])
    existing = await db.users.find_one({"id": user_id, "company_id": company_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")

    updates: Dict[str, Any] = {}
    for field in USER_FIELDS:
        if field not in payload:
            continue
        value = payload[field]
        if field in {"joining_date", "training_period_end", "payroll_date", "confirmation_date"}:
            value = _date_value(value)
        if field == "monthly_salary" and value not in (None, ""):
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="Monthly salary must be a valid number.")
        updates[field] = value if value != "" else None

    if "password" in payload and str(payload.get("password") or "").strip():
        password = str(payload["password"]).strip()
        if len(password) < 8:
            raise HTTPException(status_code=400, detail="Password must be at least 8 characters.")
        updates["password"] = pwd_context.hash(password)

    role = str(updates.get("role") or existing.get("role") or "staff").lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    updates["role"] = role
    updates["permissions"] = _license_permissions(role, license_doc)
    updates["licensed_modules"] = list(license_doc.get("modules") or [])
    updates["selected_features"] = license_doc.get("selected_features") or {}

    if updates:
        await db.users.update_one({"id": user_id, "company_id": company_id}, {"$set": updates})
    safe_updates = {k: v for k, v in updates.items() if k != "password"}
    await create_audit_log(current_user, "UPDATE_COMPANY_USER", "company_master_users", user_id, old_data=_clean_user(existing), new_data=safe_updates)
    updated = await db.users.find_one({"id": user_id, "company_id": company_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    return _clean_user(updated or {})


async def _change_user_status(user_id: str, status: str, current_user: User):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="The platform owner is not a customer tenant.")
    company_id = str(company["id"])
    existing = await db.users.find_one({"id": user_id, "company_id": company_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Company user not found.")
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="The company administrator cannot change their own status here.")
    if status == "active":
        max_users = max(1, int(license_doc.get("max_users", 1)))
        active_count = await db.users.count_documents({"company_id": company_id, "status": "active"})
        if active_count >= max_users:
            raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
        update = {"status": "active", "is_active": True, "approved_by": current_user.id, "approved_at": _now()}
        action = "APPROVE_COMPANY_USER"
    elif status == "rejected":
        update = {"status": "rejected", "is_active": False}
        action = "REJECT_COMPANY_USER"
    else:
        update = {"status": "inactive", "is_active": False}
        action = "DEACTIVATE_COMPANY_USER"
    await db.users.update_one({"id": user_id, "company_id": company_id}, {"$set": update})
    await create_audit_log(current_user, action, "company_master_users", user_id, old_data=_clean_user(existing), new_data=update)
    return {"message": f"User {status} successfully", "user_id": user_id, "status": status}


@router.post("/users/{user_id}/approve")
async def approve_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    return await _change_user_status(user_id, "active", current_user)


@router.post("/users/{user_id}/reject")
async def reject_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    return await _change_user_status(user_id, "rejected", current_user)


@router.post("/users/{user_id}/deactivate")
async def deactivate_company_user(user_id: str, current_user: User = Depends(get_current_user)):
    return await _change_user_status(user_id, "inactive", current_user)


from backend.permission_governance import router as _permission_governance_router
_permission_governance_router.include_router(router)