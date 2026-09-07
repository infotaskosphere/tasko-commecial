import re
import uuid
from calendar import monthrange
from datetime import datetime
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext

from backend.dependencies import create_access_token, db, get_current_user, require_admin
from backend.models import DEFAULT_ROLE_PERMISSIONS, User
from backend.licensing_api import create_license_record, _find_license, _public_license, _expiry_reason, _now

router = APIRouter(prefix="/commercial-onboarding", tags=["commercial-onboarding"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _norm(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def _add_months(value: datetime, months: int) -> datetime:
    months = max(0, int(months or 0))
    if months == 0:
        return value
    total = value.year * 12 + (value.month - 1) + months
    year, month0 = divmod(total, 12)
    month = month0 + 1
    day = min(value.day, monthrange(year, month)[1])
    return value.replace(year=year, month=month, day=day)


def _customer_public(customer: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": customer.get("id"),
        "company_name": customer.get("company_name"),
        "contact_name": customer.get("contact_name"),
        "email": customer.get("email"),
        "phone": customer.get("phone"),
        "gstin": customer.get("gstin"),
        "address": customer.get("address"),
        "gst_address": customer.get("gst_address"),
        "city": customer.get("city"),
        "state": customer.get("state"),
        "pincode": customer.get("pincode"),
        "created_at": customer.get("created_at"),
    }


async def _ensure_company_master(customer: Dict[str, Any], license_doc: Dict[str, Any]) -> Dict[str, Any]:
    company_id = str(customer.get("id"))
    existing = await db.companies.find_one({"id": company_id}, {"_id": 0})
    doc = {
        "id": company_id,
        "name": customer.get("company_name"),
        "company_name": customer.get("company_name"),
        "email": customer.get("email"),
        "phone": customer.get("phone"),
        "gstin": customer.get("gstin"),
        "address": customer.get("address"),
        "gst_address": customer.get("gst_address"),
        "city": customer.get("city"),
        "state": customer.get("state"),
        "pincode": customer.get("pincode"),
        "status": "active",
        "source": "commercial-license",
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "updated_at": _now().isoformat(),
    }
    if existing:
        await db.companies.update_one({"id": company_id}, {"$set": doc})
        return {**existing, **doc}
    doc["created_at"] = _now().isoformat()
    await db.companies.insert_one(doc)
    return doc


async def _find_customer_for_license(license_key: str, company_name: str):
    license_doc = await _find_license(license_key)
    if not license_doc:
        raise HTTPException(status_code=404, detail="License number was not found.")
    reason = _expiry_reason(license_doc)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    if not customer or _norm(customer.get("company_name")) != _norm(company_name):
        raise HTTPException(status_code=403, detail="Company name does not match the licensed company.")
    return customer, license_doc


@router.post("/generate-license", status_code=201)
async def generate_license(payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    company_name = str(payload.get("company_name") or "").strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    months = max(0, int(payload.get("validity_months") or 0))
    if months <= 0:
        raise HTTPException(status_code=400, detail="License duration in months is required.")

    license_doc = await create_license_record({**payload, "validity_days": max(1, months * 30)}, str(current_user.id))
    issued_at = datetime.fromisoformat(license_doc["issued_at"].replace("Z", "+00:00"))
    expires_at = _add_months(issued_at, months)
    license_doc["validity_months"] = months
    license_doc["expires_at"] = expires_at.isoformat()
    license_doc["amount_charged"] = float(payload.get("amount_charged") or 0)

    await db.commercial_licenses.update_one(
        {"id": license_doc["id"]},
        {"$set": {
            "validity_months": months,
            "amount_charged": license_doc["amount_charged"],
            "expires_at": license_doc["expires_at"],
            "sales_currency": str(payload.get("currency") or "INR"),
            "notes": str(payload.get("notes") or "").strip(),
        }},
    )

    customer = await db.commercial_license_customers.find_one({"id": license_doc["customer_id"]}, {"_id": 0})
    customer_updates = {
        "gstin": str(payload.get("gstin") or "").strip(),
        "address": str(payload.get("address") or "").strip(),
        "gst_address": str(payload.get("gst_address") or "").strip(),
        "city": str(payload.get("city") or "").strip(),
        "state": str(payload.get("state") or "").strip(),
        "pincode": str(payload.get("pincode") or "").strip(),
        "amount_charged": license_doc["amount_charged"],
        "validity_months": months,
        "last_license_id": license_doc["id"],
    }
    await db.commercial_license_customers.update_one({"id": license_doc["customer_id"]}, {"$set": customer_updates})
    customer = {**(customer or {}), **customer_updates}
    company = await _ensure_company_master(customer, license_doc)
    return {"license": {**license_doc, "customer": _customer_public(customer)}, "customer": _customer_public(customer), "company": company}


@router.post("/lookup")
async def lookup_licensed_company(payload: Dict[str, Any]):
    customer, license_doc = await _find_customer_for_license(payload.get("license_key"), payload.get("company_name"))
    company = await _ensure_company_master(customer, license_doc)
    return {"valid": True, "customer": _customer_public(customer), "license": _public_license(license_doc), "company": company}


@router.post("/create-admin")
async def create_customer_admin(payload: Dict[str, Any]):
    customer, license_doc = await _find_customer_for_license(payload.get("license_key"), payload.get("company_name"))
    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    company = await _ensure_company_master(customer, license_doc)
    now = _now().isoformat()
    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
        "email": email,
        "full_name": full_name,
        "role": "admin",
        "password": pwd_context.hash(password),
        "permissions": dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {})),
        "departments": [],
        "phone": customer.get("phone"),
        "is_active": True,
        "status": "active",
        "approved_by": "commercial-license",
        "approved_at": now,
        "created_at": now,
        "company_id": company.get("id"),
        "company_name": customer.get("company_name"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
    }
    await db.users.insert_one(user_doc)
    safe_user = {k: v for k, v in user_doc.items() if k != "password"}
    return {"access_token": create_access_token({"sub": user_id}), "token_type": "bearer", "user": safe_user, "company": company, "license": _public_license(license_doc)}


@router.post("/create-staff")
async def create_staff(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only the company administrator can create staff accounts.")
    company_name = str(payload.get("company_name") or "").strip()
    if _norm(company_name) != _norm(getattr(current_user, "company_name", "")):
        raise HTTPException(status_code=403, detail="Company name does not match your licensed company.")
    license_id = getattr(current_user, "license_id", None)
    license_doc = await db.commercial_licenses.find_one({"id": license_id}, {"_id": 0}) if license_id else None
    if not license_doc:
        raise HTTPException(status_code=403, detail="No commercial license is linked to this administrator.")
    reason = _expiry_reason(license_doc)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    if not customer or _norm(customer.get("company_name")) != _norm(company_name):
        raise HTTPException(status_code=403, detail="Company name does not match the licensed company.")

    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    full_name = str(payload.get("full_name") or "").strip()
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    active_users = await db.users.count_documents({"license_id": license_doc.get("id"), "is_active": True})
    if active_users >= int(license_doc.get("max_users", 1)):
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({license_doc.get('max_users', 1)} users).")

    role = str(payload.get("role") or "staff").lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    now = _now().isoformat()
    user_doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "full_name": full_name,
        "role": role,
        "password": pwd_context.hash(password),
        "permissions": dict(DEFAULT_ROLE_PERMISSIONS.get(role, DEFAULT_ROLE_PERMISSIONS["staff"])),
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None,
        "is_active": True,
        "status": "active",
        "approved_by": current_user.id,
        "approved_at": now,
        "created_at": now,
        "company_id": customer.get("id"),
        "company_name": customer.get("company_name"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
    }
    await db.users.insert_one(user_doc)
    return {k: v for k, v in user_doc.items() if k != "password"}


@router.get("/my-company")
async def get_my_company(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin" or not getattr(current_user, "license_id", None):
        raise HTTPException(status_code=403, detail="Commercial company administration is unavailable for this account.")
    license_doc = await db.commercial_licenses.find_one({"id": current_user.license_id}, {"_id": 0})
    if not license_doc:
        raise HTTPException(status_code=404, detail="Commercial license not found.")
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    return {"customer": _customer_public(customer or {}), "license": license_doc}
