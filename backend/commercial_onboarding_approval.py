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
from backend.platform.tenant_manager import TenantManager
from backend.platform.feature_manager import FeatureManager
from backend.platform.organization_manager import OrganizationManager

logger = logging.getLogger("commercial_onboarding")
router = APIRouter(prefix="/commercial-onboarding", tags=["commercial-onboarding"])

MODULE_KEYS = {
    "task_management": "task_management", "taskosphere": "task_management",
    "compliance": "roc", "roc": "roc", "trademark": "trademark",
    "finix": "accounting", "accounting": "accounting", "gst": "gst",
    "income_tax": "income_tax", "payroll": "payroll", "hr": "hr",
    "crm": "crm", "inventory": "inventory",
    "document_management": "document_management", "workflow": "workflow",
    "analytics": "analytics",
}
ALLOWED_STATUSES = {"pending", "under_review", "approved", "rejected"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _require_platform_admin(user: Any) -> None:
    # Platform-owner capabilities are not accepted from applicant-supplied flags.
    if str(getattr(user, "role", "")).lower() != "admin":
        raise HTTPException(status_code=403, detail="Platform-owner admin access required")


def _clean(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return None
    result = dict(doc)
    result.pop("_id", None)
    return result


class OnboardingSubmission(BaseModel):
    source: str = Field(default="web_form", max_length=40)
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
        clean = list(dict.fromkeys(v.strip().lower().replace(" ", "_") for v in values if v and v.strip()))
        if not clean or any(v not in MODULE_KEYS for v in clean):
            raise ValueError("Select only supported modules")
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
    license_type: Optional[str] = Field(default=None, max_length=60)
    max_users: Optional[int] = Field(default=None, ge=1, le=100000)
    modules: Optional[List[str]] = Field(default=None, min_length=1, max_length=30)
    schema_type: str = Field(default="isolated", pattern="^(isolated|shared)$")
    license_days: int = Field(default=365, ge=1, le=3650)


def _validate_webhook_secret(supplied_secret: Optional[str]) -> None:
    expected = os.getenv("COMMERCIAL_ONBOARDING_WEBHOOK_SECRET", "").strip()
    if not expected:
        logger.error("COMMERCIAL_ONBOARDING_WEBHOOK_SECRET is not configured")
        raise HTTPException(status_code=503, detail="Google Form integration is not configured")
    if not supplied_secret or not secrets.compare_digest(supplied_secret, expected):
        raise HTTPException(status_code=403, detail="Invalid onboarding integration secret")


async def _store_submission(body: OnboardingSubmission) -> dict:
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
    previous = _clean(await db.commercial_onboarding.find_one(duplicate_q))
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
    await db.commercial_onboarding.insert_one(doc)
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
    return await _store_submission(body)


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
    docs = await db.commercial_onboarding.find(query).sort("created_at", -1).to_list(1000)
    return {"items": [_clean(d) for d in docs], "total": len(docs)}


@router.get("/submissions/{application_id}")
async def get_submission(application_id: str, user=Depends(get_current_user)):
    _require_platform_admin(user)
    doc = _clean(await db.commercial_onboarding.find_one({"application_id": application_id}))
    if not doc:
        raise HTTPException(status_code=404, detail="Application not found")
    return doc


@router.post("/submissions/{application_id}/review")
async def review_submission(application_id: str, body: ReviewDecision, user=Depends(get_current_user)):
    """Admin-only review. Explicit approval provisions an inactive tenant + license."""
    _require_platform_admin(user)
    current = await db.commercial_onboarding.find_one({"application_id": application_id})
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
        result = await db.commercial_onboarding.update_one(
            {"application_id": application_id, "status": {"$in": ["pending", "under_review"]}},
            {"$set": {"status": "under_review", "updated_at": now, "reviewed_by": getattr(user, "id", None), "review_notes": body.review_notes}},
        )
        if getattr(result, "modified_count", 1) == 0:
            raise HTTPException(status_code=409, detail="Application was changed by another reviewer")
        return {"success": True, "application_id": application_id, "status": "under_review"}

    if body.action == "reject":
        result = await db.commercial_onboarding.update_one(
            {
                "application_id": application_id,
                "status": {"$in": ["pending", "under_review"]},
                "provisioning.status": {"$nin": ["in_progress", "failed", "completed"]},
            },
            {"$set": {"status": "rejected", "updated_at": now, "reviewed_at": now, "reviewed_by": getattr(user, "id", None), "review_notes": body.review_notes, "provisioning": {"status": "not_required"}}},
        )
        if getattr(result, "modified_count", 1) == 0:
            raise HTTPException(status_code=409, detail="Application was changed by another reviewer or provisioning has already started")
        await db.audit_platform.insert_one({
            "id": str(uuid.uuid4()), "action": "commercial_onboarding_rejected",
            "status": "SUCCESS", "actor_user_id": getattr(user, "id", None),
            "application_id": application_id, "created_at": _now(),
            "details": "Commercial onboarding application rejected by platform owner.",
        })
        return {"success": True, "application_id": application_id, "status": "rejected"}

    modules = body.modules or current.get("modules") or []
    modules = list(dict.fromkeys(v.strip().lower().replace(" ", "_") for v in modules if v and v.strip()))
    if not modules or any(v not in MODULE_KEYS for v in modules):
        raise HTTPException(status_code=422, detail="Choose one or more supported modules")
    max_users = body.max_users or current.get("user_count")
    if not max_users:
        raise HTTPException(status_code=422, detail="A valid user limit is required")

    # Conditional state transition prevents concurrent approval of the same application.
    claim = await db.commercial_onboarding.update_one(
        {"application_id": application_id, "status": {"$in": ["pending", "under_review"]}},
        {"$set": {
            "status": "under_review", "updated_at": now,
            "reviewed_by": getattr(user, "id", None), "review_notes": body.review_notes,
            "approved_modules": modules, "approved_license_type": body.license_type or current.get("license_type") or "standard",
            "approved_max_users": max_users, "provisioning": {"status": "in_progress"},
        }},
    )
    if getattr(claim, "modified_count", 1) == 0:
        raise HTTPException(status_code=409, detail="Application was changed by another reviewer")

    tenant_id = "tenant_" + uuid.uuid4().hex
    organization_id = "org_" + uuid.uuid4().hex
    license_id = "lic_" + uuid.uuid4().hex
    license_key = secrets.token_urlsafe(32)
    features = {key: False for key in FeatureManager.DEFAULT_FEATURES.keys()}
    for module in modules:
        features[MODULE_KEYS[module]] = True

    try:
        tenant = await TenantManager.create_tenant(
            tenant_id, current.get("trade_name") or current["legal_name"], body.schema_type,
            {"onboarding_application_id": application_id, "legal_name": current["legal_name"], "contact_email": current["email"], "approved_modules": modules},
        )
        await db.tenants.update_one({"id": tenant_id}, {"$set": {
            "status": "pending_activation", "onboarding_application_id": application_id, "updated_at": _now(),
        }})
        await OrganizationManager.create_organization(
            organization_id, current.get("trade_name") or current["legal_name"], tenant_id, "business",
        )
        await db.organizations.update_one({"id": organization_id}, {"$set": {
            "status": "pending_activation", "onboarding_application_id": application_id,
        }})
        expires_at = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() + body.license_days * 86400, tz=timezone.utc).isoformat()
        license_doc = {
            "id": license_id, "tenant_id": tenant_id, "organization_id": organization_id,
            "onboarding_application_id": application_id, "license_key": license_key,
            "license_type": body.license_type or current.get("license_type") or "standard",
            "max_users": max_users, "modules": modules, "status": "pending_activation",
            "assigned_at": _now(), "expires_at": expires_at, "updated_at": _now(),
        }
        await db.licenses.insert_one(license_doc)
        await db.feature_flags.update_one({"tenant_id": tenant_id}, {"$set": {
            "tenant_id": tenant_id, "features": features, "created_at": _now(), "updated_at": _now(),
            "onboarding_application_id": application_id,
        }}, upsert=True)
        await db.commercial_onboarding.update_one({"application_id": application_id}, {"$set": {
            "tenant_id": tenant_id, "organization_id": organization_id, "license_id": license_id,
            "provisioning": {
                "status": "completed", "completed_at": _now(),
                "tenant_id": tenant_id, "organization_id": organization_id, "license_id": license_id,
            },
            "status": "approved",
            "updated_at": _now(),
        }})
        await db.audit_platform.insert_one({
            "id": str(uuid.uuid4()), "action": "commercial_onboarding_approved",
            "status": "SUCCESS", "actor_user_id": getattr(user, "id", None),
            "application_id": application_id, "tenant_id": tenant_id, "license_id": license_id,
            "details": "Approved application; tenant and license remain pending activation.",
            "created_at": _now(),
        })
    except Exception as exc:
        logger.exception("Provisioning failed for application %s", application_id)
        await db.commercial_onboarding.update_one({"application_id": application_id}, {"$set": {
            "provisioning": {"status": "failed", "error": str(exc)[:1000]}, "updated_at": _now(),
        }})
        # Provisioning may have partially created records. Keep the application in
        # under_review and block approval retries until an operator reconciles them.
        raise HTTPException(status_code=500, detail="Provisioning failed or was partial. The application remains under review; reconcile tenant/license records before retrying.")

    return {
        "success": True, "application_id": application_id, "status": "approved",
        "provisioning_status": "completed", "tenant_id": tenant_id,
        "organization_id": organization_id, "license_id": license_id,
        "license_key": license_key, "license_status": "pending_activation",
        "message": "Approved. A tenant and license were provisioned in pending-activation status; no user account was created.",
    }
