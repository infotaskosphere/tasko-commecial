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
from typing import Any, Dict, Optional

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
    # The platform owner is the software seller and operational administrator.
    # Provide an operational company and license context for creating tasks and staff.
    if is_platform_owner(current_user):
        company_id = str(getattr(current_user, "company_id", "") or "").strip()
        company = None
        if company_id:
            company = await db.companies.find_one({"id": company_id}, {"_id": 0})
        if not company:
            company = await db.companies.find_one({"source": {"$nin": ["commercial-license", "license"]}}, {"_id": 0})
        license_doc = {
            "id": "platform-owner-license",
            "license_key": "PLATFORM-OWNER",
            "customer_id": "platform-owner",
            "company_id": str(company.get("id") or "comp-platform-owner") if company else "comp-platform-owner",
            "status": "active",
            "max_users": 9999,
            "modules": ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE", "RECORDS", "PROPOSALS"],
            "selected_features": {},
        }
        if not company:
            company = {"id": "comp-platform-owner", "name": "Platform Owner Company"}
        return license_doc, company
    if getattr(current_user, "role", None) != "admin" or not getattr(current_user, "company_id", None):
        raise HTTPException(status_code=403, detail="Company Master user administration is available only to a licensed company administrator.")
    license_doc = await _active_company_license(current_user)
    company_id = str(current_user.company_id)
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if not company:
        raise HTTPException(status_code=404, detail="Licensed company profile not found.")
    return license_doc, company


async def _platform_company_context(current_user: User, identifier: str):
    """Resolve a legal company and active license for platform-owner administration only."""
    if not is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="Platform-level customer user administration is restricted to the software platform owner.")
    identifier = str(identifier or "").strip()
    if not identifier:
        raise HTTPException(status_code=400, detail="A customer or company identifier is required.")

    company = await db.companies.find_one(
        {"$or": [
            {"id": identifier},
            {"commercial_customer_id": identifier},
            {"license_id": identifier},
        ]},
        {"_id": 0},
    )

    customer_doc = None
    if not company:
        customer_doc = await db.commercial_license_customers.find_one(
            {"$or": [{"id": identifier}, {"email": identifier}]},
            {"_id": 0},
        )
        if customer_doc:
            company = await db.companies.find_one(
                {"commercial_customer_id": str(customer_doc["id"])},
                {"_id": 0},
            )

    if not company:
        lic = await db.commercial_licenses.find_one(
            {"$or": [{"id": identifier}, {"license_key": identifier}]},
            {"_id": 0},
        )
        if lic:
            target_cust_id = str(lic.get("customer_id") or "")
            company = await db.companies.find_one(
                {"$or": [{"commercial_customer_id": target_cust_id}, {"license_id": str(lic.get("id") or "")}]},
                {"_id": 0},
            )
            if not customer_doc and target_cust_id:
                customer_doc = await db.commercial_license_customers.find_one({"id": target_cust_id}, {"_id": 0})

    if not company and not customer_doc:
        raise HTTPException(status_code=404, detail="Customer company not found.")

    if not company and customer_doc:
        comp_id = f"comp-{customer_doc['id']}"
        company = {
            "id": comp_id,
            "commercial_customer_id": str(customer_doc["id"]),
            "name": customer_doc.get("company_name") or "Licensee Company",
            "company_name": customer_doc.get("company_name") or "Licensee Company",
            "email": customer_doc.get("email"),
            "source": "commercial-license",
            "status": "active",
        }
        await db.companies.insert_one(dict(company))

    customer_id = str(company.get("commercial_customer_id") or (customer_doc.get("id") if customer_doc else "") or company.get("id"))
    license_doc = await db.commercial_licenses.find_one(
        {"$or": [{"customer_id": customer_id}, {"id": str(company.get("license_id") or "")}], "status": "active"},
        {"_id": 0},
        sort=[("issued_at", -1)],
    )
    if not license_doc:
        license_doc = await db.commercial_licenses.find_one(
            {"$or": [{"customer_id": customer_id}, {"id": str(company.get("license_id") or "")}]},
            {"_id": 0},
            sort=[("issued_at", -1)],
        )
    if not license_doc:
        license_doc = {
            "id": f"license-{customer_id}",
            "license_key": "COMMERCIAL-STANDARD",
            "customer_id": customer_id,
            "company_id": str(company["id"]),
            "status": "active",
            "max_users": 10,
            "modules": ["TASKS", "INVOICING", "ACCOUNTING", "HRMS", "COMPLIANCE", "RECORDS", "PROPOSALS"],
            "selected_features": {},
        }
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


async def _license_user_query(license_doc: Dict[str, Any], company: Dict[str, Any]) -> Dict[str, Any]:
    customer_id = str(
        license_doc.get("customer_id")
        or company.get("commercial_customer_id")
        or ""
    ).strip()
    if not customer_id:
        raise HTTPException(status_code=403, detail="The commercial license is not linked to a customer.")
    company_ids = await db.companies.distinct("id", {"commercial_customer_id": customer_id})
    current_company_id = str(company.get("id") or "").strip()
    if current_company_id and current_company_id not in company_ids:
        company_ids.append(current_company_id)
    query: Dict[str, Any] = {"$or": [{"commercial_customer_id": customer_id}]}
    if company_ids:
        query["$or"].append({"company_id": {"$in": company_ids}})
    return query


@router.get("/users")
async def list_company_users(current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
    if is_platform_owner(current_user):
        # Keep this read path deliberately simple. The platform owner needs a
        # stable master-data directory; customer isolation is handled by the
        # platform-company endpoints below. Avoid complex cross-company Mongo
        # predicates here because older Mongo deployments may contain mixed
        # legacy field types.
        users = await db.users.find(
            {"role": {"$ne": "superadmin"}, "is_internal_commercial_admin": {"$ne": True}},
            {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0},
        ).sort("full_name", 1).to_list(2000)
        return {
            "company": company,
            "license": license_doc,
            "users": [_clean_user(u) for u in users],
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
    company_id: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None),
    license_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_id = company_id or customer_id or license_id
    if not target_id:
        raise HTTPException(status_code=400, detail="company_id or customer_id is required.")
    license_doc, company = await _platform_company_context(current_user, target_id)
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")
    lic_id = str(license_doc.get("id") or "")
    user_query: Dict[str, Any] = {
        "$and": [
            {"status": {"$ne": "deleted"}},
            {"$or": [
                {"company_id": comp_id},
                *([{"commercial_customer_id": cust_id}] if cust_id else []),
                *([{"license_id": lic_id}] if lic_id else []),
            ]}
        ]
    }
    users = await db.users.find(
        user_query,
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
    target_id = str(payload.get("company_id") or payload.get("customer_id") or payload.get("license_id") or "").strip()
    license_doc, company = await _platform_company_context(current_user, target_id)
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
    cust_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "")
    comp_id = str(company.get("id") or "")
    user_count_query: Dict[str, Any] = {
        "status": {"$ne": "deleted"},
        "$or": [
            {"company_id": comp_id},
            *([{"commercial_customer_id": cust_id}] if cust_id else []),
        ]
    }
    user_count = await db.users.count_documents(user_count_query)
    if user_count >= max_users:
        raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
    role = str(payload.get("role") or "staff").strip().lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    now = _now()
    user = {
        "id": str(uuid.uuid4()),
        "full_name": full_name,
        "email": email,
        "phone": payload.get("phone"),
        "role": role,
        "company_id": comp_id,
        "company_name": company.get("name") or company.get("company_name"),
        "commercial_customer_id": cust_id or comp_id,
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": license_doc.get("selected_features") or {},
        "password": pwd_context.hash(password),
        "status": "active",
        "is_active": True,
        "approved_by": current_user.id,
        "approved_at": now,
        "created_at": now,
    }
    user.update({k: payload.get(k) for k in USER_FIELDS if k in payload})
    await db.users.insert_one(user)
    await create_audit_log(current_user, "CREATE_PLATFORM_COMPANY_USER", "company_master_users", user["id"], new_data=_clean_user(user))
    return _clean_user(user)


@router.post("/users", status_code=201)
async def create_company_user(payload: Dict[str, Any], current_user: User = Depends(get_current_user)):
    license_doc, company = await _company_context(current_user)
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
    if not is_platform_owner(current_user):
        max_users = max(1, int(license_doc.get("max_users", 1)))
        user_count_query = await _license_user_query(license_doc, company)
        user_count_query["status"] = "active"
        user_count = await db.users.count_documents(user_count_query)
        if user_count >= max_users:
            raise HTTPException(status_code=400, detail=f"User limit reached for this license ({max_users} users).")
    role = str(payload.get("role") or "staff").strip().lower()
    if role not in {"staff", "manager"}:
        role = "staff"
    now = _now()
    user = {
        "id": str(uuid.uuid4()),
        "full_name": full_name,
        "email": email,
        "phone": payload.get("phone"),
        "role": role,
        "company_id": company_id,
        "company_name": company.get("name") or company.get("company_name"),
        "commercial_customer_id": company.get("commercial_customer_id") or license_doc.get("customer_id"),
        "license_id": license_doc.get("id"),
        "license_key": license_doc.get("license_key"),
        "licensed_modules": list(license_doc.get("modules") or []),
        "selected_features": _license_permissions(role, license_doc),
        "password": pwd_context.hash(password),
        "status": "active",
        "is_active": True,
        "approved_by": current_user.id,
        "approved_at": now,
        "created_at": now,
    }
    user.update({k: payload.get(k) for k in USER_FIELDS if k in payload})
    await db.users.insert_one(user)
    await create_audit_log(current_user, "CREATE_COMPANY_MASTER_USER", "company_master_users", user["id"], new_data=_clean_user(user))
    return _clean_user(user)
