"""Commercial licensee onboarding and platform-owner approval workflow."""
import re
import os
import uuid
import secrets
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, EmailStr, Field, field_validator

from backend.dependencies import db, get_current_user
from backend.platform_owner import is_platform_owner

logger = logging.getLogger("commercial_onboarding")
router = APIRouter(prefix="/onboarding", tags=["commercial-onboarding-approval"])

MODULE_KEYS = {
    "taskosphere": "taskosphere", "tasks": "taskosphere", "task_management": "taskosphere",
    "finix": "finix", "accounting": "finix", "invoicing": "finix",
    "compliance": "compliance", "complygenie": "compliance", "roc": "compliance",
    "trademark": "compliance", "gst": "compliance", "gst_tax": "compliance", "income_tax": "compliance",
    "aiweave": "aiweave", "records": "records", "crm": "proposals", "crm_leads": "proposals",
    "leads": "proposals", "leadsense": "proposals", "proposals": "proposals",
    "payroll": "people_matrix", "hr": "people_matrix", "people_matrix": "people_matrix",
}
ALLOWED_STATUSES = {"pending", "under_review", "approved", "rejected"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_platform_admin(user: Any) -> None:
    role = str(getattr(user, "role", "") or "").strip().lower()
    if not user or not (is_platform_owner(user) or role in {"platform_owner", "superadmin", "saas_admin"}):
        raise HTTPException(status_code=403, detail="Platform-owner access is required")


def _clean(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return None
    result = dict(doc)
    result.pop("_id", None)
    return result


class OnboardingSubmission(BaseModel):
    source: str = Field(default="google_form", max_length=40)
    legal_name: str = Field(min_length=2, max_length=200)
    trade_name: Optional[str] = Field(default=None, max_length=200)
    constitution: str = Field(min_length=2, max_length=80)
    pan: str = Field(min_length=10, max_length=10)
    gstin: Optional[str] = Field(default=None, max_length=15)
    registration_no: Optional[str] = Field(default=None, max_length=40)
    address: str = Field(min_length=5, max_length=1000)
    city: str = Field(min_length=2, max_length=100)
    state: str = Field(min_length=2, max_length=100)
    pin: str = Field(min_length=4, max_length=10)
    website: Optional[str] = Field(default=None, max_length=300)
    contact_name: str = Field(min_length=2, max_length=150)
    designation: str = Field(min_length=2, max_length=100)
    email: EmailStr
    mobile: str = Field(min_length=7, max_length=25)
    alternate_contact: Optional[str] = Field(default=None, max_length=100)
    business_type: str = Field(min_length=2, max_length=100)
    business_description: str = Field(min_length=3, max_length=3000)
    client_count: Optional[str] = Field(default=None, max_length=60)
    modules: List[str] = Field(min_length=1, max_length=30)
    license_type: str = Field(min_length=2, max_length=60)
    user_count: int = Field(ge=1, le=100000)
    entity_count: Optional[str] = Field(default=None, max_length=60)
    commercial_notes: Optional[str] = Field(default=None, max_length=3000)
    deployment: str = Field(min_length=2, max_length=100)
    migration: Optional[str] = Field(default="To be discussed", max_length=60)
    migration_details: Optional[str] = Field(default=None, max_length=3000)
    isolation: Optional[str] = Field(default="Yes – Dedicated / Isolated", max_length=100)
    branding: Optional[str] = Field(default="No", max_length=60)
    white_label_name: Optional[str] = Field(default=None, max_length=200)
    custom_domain: Optional[str] = Field(default=None, max_length=300)
    integrations: List[str] = Field(default_factory=list, max_length=30)
    go_live_date: Optional[str] = Field(default=None, max_length=30)
    implementation_notes: Optional[str] = Field(default=None, max_length=3000)
    notes: Optional[str] = Field(default=None, max_length=3000)
    declaration: bool

    @field_validator("pan")
    @classmethod
    def validate_pan(cls, value: str) -> str:
        value = value.strip().upper()
        if not re.fullmatch(r"[A-Z]{5}[0-9]{4}[A-Z]", value):
            raise ValueError("Enter a valid PAN format")
        return value

    @field_validator("gstin")
    @classmethod
    def validate_gstin(cls, value: Optional[str]) -> Optional[str]:
        if not value:
            return None
        value = value.strip().upper()
        if not re.fullmatch(r"[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]", value):
            raise ValueError("Enter a valid GSTIN format")
        return value

    @field_validator("modules")
    @classmethod
    def validate_modules(cls, values: List[str]) -> List[str]:
        clean = []
        for raw in values or []:
            value = str(raw or "").strip().lower().replace("-", "_")
            value = MODULE_KEYS.get(value, MODULE_KEYS.get(value.replace(" ", "_"), ""))
            if value and value not in clean:
                clean.append(value)
        if not clean:
            raise ValueError("Select one or more supported commercial modules")
        return clean

    @field_validator("declaration")
    @classmethod
    def declaration_required(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("Declaration must be confirmed")
        return value


class ReviewDecision(BaseModel):
    action: str = Field(pattern="^(approve|reject|under_review)$")
    review_notes: Optional[str] = Field(default=None, max_length=3000)
    license_type: str = Field(default="custom-modules", max_length=60)
    max_users: Optional[int] = Field(default=None, ge=1, le=100000)
    approved_modules: Optional[List[str]] = Field(default=None, min_length=1, max_length=30)
    validity_months: int = Field(default=12, ge=1, le=120)
    amount_charged: Optional[float] = Field(default=None, ge=0)
    currency: str = Field(default="INR", min_length=3, max_length=5)
    invoice_company_id: Optional[str] = Field(default=None, max_length=100)
    selected_features: Optional[Dict[str, List[str]]] = None


def _validate_webhook_secret(supplied_secret: Optional[str]) -> None:
    expected = os.getenv("COMMERCIAL_ONBOARDING_WEBHOOK_SECRET", "").strip()
    if not expected:
        logger.error("COMMERCIAL_ONBOARDING_WEBHOOK_SECRET is not configured")
        raise HTTPException(status_code=503, detail="Google Form integration is not configured")
    if not supplied_secret or not secrets.compare_digest(supplied_secret, expected):
        raise HTTPException(status_code=403, detail="Invalid onboarding integration secret")


async def _persist_application(body: OnboardingSubmission) -> dict:
    """Shared persistence path for app-native and Google Form submissions."""
    if not body.declaration:
        raise HTTPException(status_code=422, detail="Declaration is required")

    email = str(body.email).strip().lower()
    duplicate_q = {
        "status": {"$in": ["pending", "under_review", "approved"]},
        "$or": [{"email_normalized": email}, {"pan": body.pan}],
    }
    if body.gstin:
        duplicate_q["$or"].append({"gstin": body.gstin})
    previous = _clean(await db.commercial_onboarding_applications.find_one(duplicate_q))
    if previous:
        raise HTTPException(status_code=409, detail={
            "message": "An application already exists for this email, PAN or GSTIN.",
            "application_id": previous.get("application_id"),
        })

    now = _now()
    application_id = "ONX-" + datetime.now(timezone.utc).strftime("%Y%m%d") + "-" + secrets.token_hex(4).upper()
    doc = body.model_dump()
    doc.pop("declaration", None)
    doc.update({
        "application_id": application_id, "email": email, "email_normalized": email,
        "mobile_normalized": re.sub(r"\D", "", body.mobile),
        "status": "pending", "created_at": now, "updated_at": now,
        "reviewed_at": None, "reviewed_by": None, "review_notes": None,
        "provisioning": {"status": "not_started"}, "tenant_id": None, "license_id": None,
    })
    await db.commercial_onboarding_applications.insert_one(doc)
    logger.info("New commercial onboarding application %s from %s", application_id, body.source)
    return {
        "success": True, "application_id": application_id, "status": "pending",
        "message": "Application received. License activation is subject to platform-owner approval.",
    }


@router.post("/google-form-submissions", status_code=201)
async def create_google_form_submission(
    body: OnboardingSubmission,
    request: Request,
):
    """Protected endpoint for the installable Google Forms Apps Script trigger."""
    _validate_webhook_secret(request.headers.get("X-Onenexa-Onboarding-Secret"))
    body.source = "google_form"
    return await _persist_application(body)


@router.post("/submissions", status_code=201)
async def create_submission(body: OnboardingSubmission):
    """Public intake. It creates a pending application only and never provisions."""
    body.source = "onenexa_public_web_form" if body.source == "web_form" else body.source
    return await _store_submission(body)


@router.get("/submissions")
async def list_submissions(
    status_filter: Optional[str] = Query(default=None, alias="status"),
    search: Optional[str] = Query(default=None, max_length=200),
    user=Depends(get_current_user),
):
    _require_platform_admin(user)
    query: Dict[str, Any] = {}
    if status_filter:
        if status_filter not in ALLOWED_STATUSES:
            raise HTTPException(status_code=422, detail="Invalid status filter")
        query["status"] = status_filter
    if search and search.strip():
        term = re.escape(search.strip())
        search_terms = [
            {"application_id": {"$regex": term, "$options": "i"}},
            {"legal_name": {"$regex": term, "$options": "i"}},
            {"trade_name": {"$regex": term, "$options": "i"}},
            {"email": {"$regex": term, "$options": "i"}},
            {"pan": {"$regex": term, "$options": "i"}},
        ]
        if status_filter:
            query = {"$and": [query, {"$or": search_terms}]}
        else:
            query["$or"] = search_terms
    docs = await db.commercial_onboarding_applications.find(query).sort("created_at", -1).to_list(1000)
    return {"items": [_clean(d) for d in docs], "total": len(docs)}


@router.get("/submissions/{application_id}")
async def get_submission(application_id: str, user=Depends(get_current_user)):
    _require_platform_admin(user)
    doc = _clean(await db.commercial_onboarding_applications.find_one({"application_id": application_id}))
    if not doc:
        raise HTTPException(status_code=404, detail="Application not found")
    return doc


@router.post("/submissions/{application_id}/review")
async def review_submission(application_id: str, body: ReviewDecision, user=Depends(get_current_user)):
    """Admin-only review. Explicit approval provisions an inactive tenant + license."""
    _require_platform_admin(user)
    current = await db.commercial_onboarding_applications.find_one({"application_id": application_id})
    if not current:
        raise HTTPException(status_code=404, detail="Application not found")
    status_now = current.get("status", "pending")
    if status_now == "approved":
        raise HTTPException(status_code=409, detail="Application is already approved")
    if status_now == "rejected":
        raise HTTPException(status_code=409, detail="Application is already rejected")
    if (current.get("provisioning") or {}).get("status") in {"in_progress", "failed"}:
        raise HTTPException(
            status_code=409,
            detail="Provisioning has already started or failed. Inspect the tenant/license records before retrying to avoid duplicates.",
        )

    now = _now()
    if body.action == "under_review":
        result = await db.commercial_onboarding_applications.update_one(
            {"application_id": application_id, "status": {"$in": ["pending", "under_review"]}},
            {"$set": {"status": "under_review", "updated_at": now, "reviewed_by": getattr(user, "id", None), "review_notes": body.review_notes}},
        )
        if getattr(result, "modified_count", 1) == 0:
            raise HTTPException(status_code=409, detail="Application was changed by another reviewer")
        return {"success": True, "application_id": application_id, "status": "under_review"}

    if body.action == "reject":
        result = await db.commercial_onboarding_applications.update_one(
            {
                "application_id": application_id,
                "status": {"$in": ["pending", "under_review"]},
                "provisioning.status": {"$nin": ["in_progress", "failed", "completed"]},
            },
            {"$set": {"status": "rejected", "updated_at": now, "reviewed_at": now, "reviewed_by": getattr(user, "id", None), "review_notes": body.review_notes, "provisioning": {"status": "not_required"}}},
        )
        if getattr(result, "modified_count", 1) == 0:
            raise HTTPException(status_code=409, detail="Application was changed by another reviewer or provisioning has already started")
        await db.commercial_onboarding_audit.insert_one({
            "id": str(uuid.uuid4()), "action": "commercial_onboarding_rejected",
            "status": "SUCCESS", "actor_user_id": getattr(user, "id", None),
            "application_id": application_id, "created_at": _now(),
            "details": "Commercial onboarding application rejected by platform owner.",
        })
        return {"success": True, "application_id": application_id, "status": "rejected"}

    modules = body.approved_modules or current.get("modules") or []
    normalised_modules = []
    for raw in modules:
        value = str(raw or "").strip().lower().replace("-", "_").replace(" ", "_")
        value = MODULE_KEYS.get(value, "")
        if value and value not in normalised_modules:
            normalised_modules.append(value)
    modules = normalised_modules
    if not modules:
        raise HTTPException(status_code=422, detail="Choose one or more supported commercial modules")
    max_users = body.max_users or current.get("user_count")
    if not max_users:
        raise HTTPException(status_code=422, detail="A valid user limit is required")

    invoice_company_id = str(body.invoice_company_id or "").strip()
    if not invoice_company_id:
        raise HTTPException(status_code=422, detail="Select the invoice issuer company before approving")

    claim = await db.commercial_onboarding_applications.update_one(
        {"application_id": application_id, "status": {"$in": ["pending", "under_review"]}},
        {"$set": {
            "status": "under_review", "updated_at": now,
            "reviewed_by": str(getattr(user, "id", "")), "review_notes": body.review_notes,
            "approved_modules": modules, "approved_license_type": body.license_type,
            "approved_max_users": max_users, "provisioning": {"status": "in_progress"},
        }},
    )
    if getattr(claim, "modified_count", 1) == 0:
        raise HTTPException(status_code=409, detail="Application changed by another reviewer")

    try:
        # The commercial generator provisions the existing commercial customer,
        # isolated tenant database, license, admin placeholder and invoice.
        from backend.commercial_onboarding_extensions import generate_custom_license
        selected_features = body.selected_features or {}
        catalog_rows = await db.commercial_license_module_catalog.find(
            {"active": {"$ne": False}, "id": {"$in": modules}},
            {"_id": 0, "id": 1, "features": 1},
        ).to_list(100)
        catalog_by_id = {str(item.get("id")): item for item in catalog_rows}
        for module_id in modules:
            if module_id in selected_features:
                continue
            features = catalog_by_id.get(module_id, {}).get("features") or []
            selected_features[module_id] = [
                str(feature.get("id") or feature.get("flag") or "").strip()
                for feature in features
                if feature.get("id") or feature.get("flag")
            ]
        payload = {
            "company_name": current.get("trade_name") or current["legal_name"],
            "admin_name": current.get("contact_name") or current.get("legal_name"),
            "contact_name": current.get("contact_name"),
            "email": current.get("email"),
            "phone": current.get("mobile"),
            "gstin": current.get("gstin") or "",
            "address": current.get("address") or "",
            "gst_address": current.get("address") or "",
            "city": current.get("city") or "",
            "state": current.get("state") or "",
            "pincode": current.get("pin") or "",
            "validity_months": body.validity_months,
            "amount_charged": body.amount_charged,
            "currency": body.currency,
            "invoice_company_id": invoice_company_id,
            "max_users": max_users,
            "max_installations": 1,
            "selected_modules": modules,
            "selected_features": selected_features,
            "notes": body.review_notes or current.get("notes") or "",
        }
        result = await generate_custom_license(payload, user)
        license_doc = result.get("license") or {}
        customer = result.get("customer") or license_doc.get("customer") or {}
        invoice = result.get("invoice") or license_doc.get("invoice") or {}
        done_at = _now()
        await db.commercial_onboarding_applications.update_one(
            {"application_id": application_id},
            {"$set": {
                "status": "approved", "updated_at": done_at, "reviewed_at": done_at,
                "reviewed_by": str(getattr(user, "id", "")), "review_notes": body.review_notes,
                "provisioning": {"status": "completed", "completed_at": done_at},
                "customer_id": customer.get("id") or license_doc.get("customer_id"),
                "license_id": license_doc.get("id"), "license_key": license_doc.get("license_key"),
                "invoice_id": invoice.get("id") or license_doc.get("invoice_id"),
                "approved_modules": modules,
            }},
        )
        await db.commercial_onboarding_audit.insert_one({
            "id": str(uuid.uuid4()), "action": "commercial_onboarding_approved",
            "application_id": application_id, "actor_id": str(getattr(user, "id", "")),
            "customer_id": customer.get("id") or license_doc.get("customer_id"),
            "license_id": license_doc.get("id"), "created_at": done_at, "notes": body.review_notes,
        })
        return {
            "success": True, "application_id": application_id, "status": "approved",
            "customer_id": customer.get("id") or license_doc.get("customer_id"),
            "license_id": license_doc.get("id"), "license_key": license_doc.get("license_key"),
            "invoice_id": invoice.get("id") or license_doc.get("invoice_id"),
            "message": "Approved through the commercial console's customer, isolated database, license and invoice workflow.",
        }
    except HTTPException as exc:
        await db.commercial_onboarding_applications.update_one(
            {"application_id": application_id},
            {"$set": {"provisioning": {"status": "failed", "error": str(exc.detail)[:1000]}, "updated_at": _now()}},
        )
        raise
    except Exception as exc:
        logger.exception("Commercial onboarding approval failed for %s", application_id)
        await db.commercial_onboarding_applications.update_one(
            {"application_id": application_id},
            {"$set": {"provisioning": {"status": "failed", "error": str(exc)[:1000]}, "updated_at": _now()}},
        )
        raise HTTPException(status_code=500, detail="Approval provisioning failed; inspect commercial customer/license records before retrying.") from exc
