import copy
import re
import uuid
from calendar import monthrange
from datetime import datetime
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext

from backend.dependencies import create_access_token, db, get_current_user, require_admin
from backend.models import DEFAULT_ROLE_PERMISSIONS, MODULE_HIERARCHY, User
from backend.licensing_api import create_license_record, _find_license, _public_license, _expiry_reason, _now

router = APIRouter(prefix="/commercial-onboarding", tags=["commercial-onboarding"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

MODULE_CATALOG = [
    {"id": "taskosphere", "code": "TASKOSPHERE", "name": "Taskosphere", "description": "Tasks, To-Do, Attendance, Reminders, Action Center, Client Visits and AI tools.", "monthly_price": 0.0, "active": True},
    {"id": "finix", "code": "FINIX", "name": "Finix", "description": "Sales, Purchase, Bank, Chart of Accounts, Journal Entries and Accounting Reports.", "monthly_price": 0.0, "active": True},
    {"id": "compliance", "code": "COMPLIANCE", "name": "Compliance", "description": "Compliance Tracker, GST Reconciliation, Trademark Sphere, MIS, Salary Slips and ROC Sphere.", "monthly_price": 0.0, "active": True},
    {"id": "records", "code": "RECORDS", "name": "Records", "description": "DSC Register, Document Register, Clients and Password Vault.", "monthly_price": 0.0, "active": True},
    {"id": "proposals", "code": "PROPOSALS", "name": "Client Proposals", "description": "Lead Management, Quotations and Client Discussion.", "monthly_price": 0.0, "active": True},
    {"id": "people_matrix", "code": "PEOPLE_MATRIX", "name": "People Matrix", "description": "Users, Leave, Payroll, HR, Recruitment and Performance.", "monthly_price": 0.0, "active": True},
]
MODULE_IDS = {item["id"] for item in MODULE_CATALOG}
MODULE_FLAG_BY_ID = {key: value["flag"] for key, value in MODULE_HIERARCHY.items() if key in MODULE_IDS}


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
        "licensed_modules": list(customer.get("licensed_modules") or []),
        "created_at": customer.get("created_at"),
    }


async def _ensure_module_catalog() -> List[Dict[str, Any]]:
    for item in MODULE_CATALOG:
        await db.commercial_license_module_catalog.update_one(
            {"id": item["id"]},
            {"$setOnInsert": dict(item)},
            upsert=True,
        )
    return await db.commercial_license_module_catalog.find({}, {"_id": 0}).sort("name", 1).to_list(20)


async def _module_catalog_map() -> Dict[str, Dict[str, Any]]:
    catalog = await _ensure_module_catalog()
    return {item["id"]: item for item in catalog if item.get("active", True)}


def _apply_license_entitlements(role: str, selected_modules: List[str]) -> Dict[str, Any]:
    """Overlay license module caps on the existing role permission template."""
    permissions = copy.deepcopy(DEFAULT_ROLE_PERMISSIONS.get(role, DEFAULT_ROLE_PERMISSIONS["staff"]))
    selected = set(selected_modules)
    for module_id, module_flag in MODULE_FLAG_BY_ID.items():
        allowed = module_id in selected
        permissions[module_flag] = allowed
        module_def = MODULE_HIERARCHY.get(module_id, {})
        for page in module_def.get("pages", []):
            permissions[page["flag"]] = bool(allowed and (permissions.get(page["flag"], False)))
    return permissions


async def _ensure_company_master(customer: Dict[str, Any], license_doc: Dict[str, Any]) -> Dict[str, Any]:
    """Return the legal-entity Company Master linked to a commercial customer.

    A commercial customer is the billing/license account and may own multiple
    legal companies. The operational tenant is always the company record's
    unique `id`; `commercial_customer_id` is the grouping key.

    Existing installations that previously used the customer ID as the company
    ID are preserved and backfilled with the new relationship instead of being
    destructively migrated.
    """
    customer_id = str(customer.get("id"))
    existing = await db.companies.find_one({"commercial_customer_id": customer_id}, {"_id": 0})
    if not existing:
        # Backward-compatible lookup for the old one-customer/one-company model.
        existing = await db.companies.find_one({"id": customer_id}, {"_id": 0})

    now = _now().isoformat()
    company_id = str(existing.get("id")) if existing else str(uuid.uuid4())
    doc = {
        "id": company_id,
        "commercial_customer_id": customer_id,
        "commercial_customer_name": customer.get("company_name"),
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
        "licensed_modules": list(customer.get("licensed_modules") or license_doc.get("modules") or []),
        "status": "active",
        "source": "commercial-license",
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "updated_at": now,
    }
    if existing:
        await db.companies.update_one({"id": company_id}, {"$set": doc})
        return {**existing, **doc}
    doc["created_at"] = now
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


async def _find_active_license_for_company_name(company_name: str):
    normalized = _norm(company_name)
    if not normalized:
        raise HTTPException(status_code=400, detail="Company name is required.")

    candidates = await db.commercial_license_customers.find(
        {"company_name": {"$regex": re.escape(str(company_name).strip()), "$options": "i"}},
        {"_id": 0},
    ).limit(20).to_list(20)
    customer = next((item for item in candidates if _norm(item.get("company_name")) == normalized), None)
    if not customer:
        raise HTTPException(status_code=404, detail="Company name was not found in the licensed companies database.")

    licenses = await db.commercial_licenses.find(
        {"customer_id": customer.get("id"), "status": "active"},
        {"_id": 0},
    ).sort("issued_at", -1).limit(10).to_list(10)
    for license_doc in licenses:
        reason = _expiry_reason(license_doc)
        if not reason:
            return customer, license_doc
    raise HTTPException(status_code=403, detail="This company does not have an active commercial license.")


@router.get("/module-catalog")
async def get_module_catalog(current_user: User = Depends(require_admin())):
    return {"modules": await _ensure_module_catalog()}


@router.put("/module-catalog/{module_id}")
async def update_module_catalog(module_id: str, payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    if module_id not in MODULE_IDS:
        raise HTTPException(status_code=404, detail="Module not found.")
    try:
        price = float(payload.get("monthly_price", 0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Monthly module price must be a number.")
    if price < 0:
        raise HTTPException(status_code=400, detail="Monthly module price cannot be negative.")
    await _ensure_module_catalog()
    await db.commercial_license_module_catalog.update_one(
        {"id": module_id},
        {"$set": {"monthly_price": round(price, 2), "active": bool(payload.get("active", True)), "updated_at": _now().isoformat()}},
    )
    item = await db.commercial_license_module_catalog.find_one({"id": module_id}, {"_id": 0})
    return item


@router.post("/generate-license", status_code=201)
async def generate_license(payload: Dict[str, Any], current_user: User = Depends(require_admin())):
    company_name = str(payload.get("company_name") or "").strip()
    if not company_name:
        raise HTTPException(status_code=400, detail="Company name is required.")
    months = max(0, int(payload.get("validity_months") or 0))
    if months <= 0:
        raise HTTPException(status_code=400, detail="License duration in months is required.")

    catalog = await _module_catalog_map()
    selected_modules = []
    for raw in payload.get("selected_modules") or payload.get("modules") or []:
        module_id = str(raw).strip().lower()
        if module_id and module_id not in selected_modules:
            selected_modules.append(module_id)
    if not selected_modules:
        raise HTTPException(status_code=400, detail="Select at least one module for the license.")
    unavailable = [module_id for module_id in selected_modules if module_id not in catalog]
    if unavailable:
        raise HTTPException(status_code=400, detail=f"Selected module is unavailable: {', '.join(unavailable)}.")

    module_prices = {module_id: round(float(catalog[module_id].get("monthly_price", 0)), 2) for module_id in selected_modules}
    monthly_module_total = round(sum(module_prices.values()), 2)
    calculated_amount = round(monthly_module_total * months, 2)
    amount_raw = payload.get("amount_charged")
    amount_charged = calculated_amount if amount_raw in (None, "") else float(amount_raw)
    if amount_charged < 0:
        raise HTTPException(status_code=400, detail="Amount charged cannot be negative.")

    license_doc = await create_license_record(
        {
            **payload,
            "package_id": "essential",
            "validity_days": max(1, months * 30),
            "max_users": max(1, int(payload.get("max_users") or 1)),
            "max_installations": max(1, int(payload.get("max_installations") or 1)),
        },
        str(current_user.id),
    )
    issued_at = datetime.fromisoformat(license_doc["issued_at"].replace("Z", "+00:00"))
    expires_at = _add_months(issued_at, months)
    license_doc.update({
        "package_id": "custom-modules",
        "package_code": "TSO-CUSTOM",
        "package_name": "Custom Module License",
        "modules": selected_modules,
        "module_prices": module_prices,
        "monthly_module_price": monthly_module_total,
        "calculated_amount": calculated_amount,
        "validity_months": months,
        "expires_at": expires_at.isoformat(),
        "amount_charged": round(amount_charged, 2),
        "sales_currency": str(payload.get("currency") or "INR"),
        "notes": str(payload.get("notes") or "").strip(),
    })

    await db.commercial_licenses.update_one(
        {"id": license_doc["id"]},
        {"$set": {
            "package_id": license_doc["package_id"],
            "package_code": license_doc["package_code"],
            "package_name": license_doc["package_name"],
            "modules": selected_modules,
            "module_prices": module_prices,
            "monthly_module_price": monthly_module_total,
            "calculated_amount": calculated_amount,
            "validity_months": months,
            "amount_charged": round(amount_charged, 2),
            "expires_at": license_doc["expires_at"],
            "sales_currency": license_doc["sales_currency"],
            "notes": license_doc["notes"],
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
        "licensed_modules": selected_modules,
        "module_prices": module_prices,
        "amount_charged": round(amount_charged, 2),
        "calculated_amount": calculated_amount,
        "monthly_module_price": monthly_module_total,
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
    company = await _ensure_company_master(customer, license_doc)
    existing_admin = await db.users.find_one({"company_id": company.get("id"), "role": "admin"}, {"_id": 1})
    if existing_admin:
        raise HTTPException(status_code=409, detail="The company administrator has already been created. Please sign in with the existing administrator account.")

    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    now = _now().isoformat()
    user_id = str(uuid.uuid4())
    permissions = _apply_license_entitlements("admin", list(license_doc.get("modules") or []))
    user_doc = {
        "id": user_id, "email": email, "full_name": full_name, "role": "admin",
        "password": pwd_context.hash(password), "permissions": permissions, "departments": [],
        "phone": customer.get("phone"), "is_active": True, "status": "active",
        "approved_by": "commercial-license", "approved_at": now, "created_at": now,
        "company_id": company.get("id"), "company_name": company.get("name"),
        "commercial_customer_id": customer.get("id"),
        "license_id": license_doc.get("id"), "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
    }
    await db.users.insert_one(user_doc)
    safe_user = {k: v for k, v in user_doc.items() if k != "password"}
    return {"access_token": create_access_token({"sub": user_id}), "token_type": "bearer", "user": safe_user, "company": company, "license": _public_license(license_doc)}


@router.post("/verify-company")
async def verify_company_for_registration(payload: Dict[str, Any]):
    customer, license_doc = await _find_active_license_for_company_name(payload.get("company_name"))
    company = await _ensure_company_master(customer, license_doc)
    active_users = await db.users.count_documents({"company_id": company.get("id"), "is_active": True})
    max_users = int(license_doc.get("max_users", 1))
    return {
        "valid": True,
        "company": _customer_public(customer),
        "license": {
            "id": license_doc.get("id"), "status": license_doc.get("status"),
            "expires_at": license_doc.get("expires_at"), "max_users": max_users,
            "active_users": active_users, "remaining_users": max(0, max_users - active_users),
            "modules": list(license_doc.get("modules") or []),
        },
    }


@router.post("/create-user")
async def create_public_licensed_user(payload: Dict[str, Any]):
    customer, license_doc = await _find_active_license_for_company_name(payload.get("company_name"))
    company = await _ensure_company_master(customer, license_doc)

    full_name = str(payload.get("full_name") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    active_users = await db.users.count_documents({"company_id": company.get("id"), "is_active": True})
    max_users = int(license_doc.get("max_users", 1))
    if active_users >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")

    requested_role = str(payload.get("role") or "not_known").strip().lower()
    role = requested_role if requested_role in {"admin", "manager", "staff"} else "staff"
    role_label = {"admin": "Admin", "manager": "Manager", "staff": "Staff", "not_known": "Not Know"}.get(requested_role, "Not Know")

    now = _now().isoformat()
    user_id = str(uuid.uuid4())
    permissions = _apply_license_entitlements(role, list(license_doc.get("modules") or []))
    user_doc = {
        "id": user_id, "email": email, "full_name": full_name, "role": role,
        "requested_role": requested_role, "role_label": role_label,
        "password": pwd_context.hash(password), "permissions": permissions, "departments": [],
        "phone": str(payload.get("phone") or "").strip() or None, "is_active": True, "status": "active",
        "approved_by": "commercial-self-registration", "approved_at": now, "created_at": now,
        "company_id": company.get("id"), "company_name": company.get("name"),
        "commercial_customer_id": customer.get("id"), "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"), "licensed_modules": list(license_doc.get("modules") or []),
    }
    await db.users.insert_one(user_doc)
    safe_user = {k: v for k, v in user_doc.items() if k != "password"}
    return {"access_token": create_access_token({"sub": user_id}), "token_type": "bearer", "user": safe_user, "company": company}


async def _active_company_license(current_user: User) -> Dict[str, Any]:
    company_id = str(getattr(current_user, "company_id", "") or "")
    if not company_id:
        raise HTTPException(status_code=403, detail="This account is not linked to a licensed company.")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    customer_id = str((company or {}).get("commercial_customer_id") or getattr(current_user, "commercial_customer_id", "") or company_id)
    licenses = await db.commercial_licenses.find(
        {"customer_id": customer_id, "status": "active"}, {"_id": 0}
    ).sort("issued_at", -1).limit(1).to_list(1)
    license_doc = licenses[0] if licenses else None
    if not license_doc:
        raise HTTPException(status_code=403, detail="No active commercial license is linked to this company.")
    reason = _expiry_reason(license_doc)
    if reason:
        raise HTTPException(status_code=403, detail=reason)
    return license_doc


@router.post("/create-staff")
async def create_staff(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Only the company administrator can create staff accounts.")
    company_id = str(getattr(current_user, "company_id", "") or "")
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if not company:
        raise HTTPException(status_code=403, detail="Your account is not linked to a valid company.")
    company_name = str(payload.get("company_name") or "").strip()
    if company_name and _norm(company_name) != _norm(company.get("name")):
        raise HTTPException(status_code=403, detail="Company name does not match your company.")

    license_doc = await _active_company_license(current_user)
    customer_id = str(license_doc.get("customer_id") or company.get("commercial_customer_id") or "")
    if company.get("commercial_customer_id") and str(company.get("commercial_customer_id")) != customer_id:
        raise HTTPException(status_code=403, detail="Company is not linked to this commercial license.")

    email = str(payload.get("email") or "").strip().lower()
    password = str(payload.get("password") or "")
    full_name = str(payload.get("full_name") or "").strip()
    if not full_name or not email or len(password) < 8:
        raise HTTPException(status_code=400, detail="Full name, email and a password of at least 8 characters are required.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=409, detail="An account already exists for this email address.")

    active_users = await db.users.count_documents({"company_id": company_id, "is_active": True})
    max_users = int(license_doc.get("max_users", 1))
    if active_users >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")

    role = str(payload.get("role") or "staff").lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    now = _now().isoformat()
    permissions = _apply_license_entitlements(role, list(license_doc.get("modules") or []))
    user_doc = {
        "id": str(uuid.uuid4()), "email": email, "full_name": full_name, "role": role,
        "password": pwd_context.hash(password), "permissions": permissions,
        "departments": list(payload.get("departments") or []),
        "phone": str(payload.get("phone") or "").strip() or None, "is_active": True, "status": "active",
        "approved_by": current_user.id, "approved_at": now, "created_at": now,
        "company_id": company_id, "company_name": company.get("name"),
        "commercial_customer_id": customer_id, "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"), "licensed_modules": list(license_doc.get("modules") or []),
    }
    await db.users.insert_one(user_doc)
    return {k: v for k, v in user_doc.items() if k != "password"}


@router.get("/my-company")
async def get_my_company(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin" or not getattr(current_user, "company_id", None):
        raise HTTPException(status_code=403, detail="Commercial company administration is unavailable for this account.")
    license_doc = await _active_company_license(current_user)
    company = await db.companies.find_one({"id": current_user.company_id}, {"_id": 0})
    customer = await db.commercial_license_customers.find_one({"id": license_doc.get("customer_id")}, {"_id": 0})
    return {"customer": _customer_public(customer or {}), "company": company, "license": license_doc}
