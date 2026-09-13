"""
Governed Modules — the 9 remaining pages named in the Governance & Permission
Matrix spec that did not exist anywhere in this codebase yet.
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.dependencies import db, get_current_user, create_audit_log
from backend.governance_core import require_page, require_action, get_visibility_scope
from backend.models import User, DEFAULT_ROLE_PERMISSIONS
from backend.licensing_api import router as licensing_router
from backend.permission_governance import router as permission_governance_router
from backend.website_config import router as website_config_router
from backend.commercial_onboarding import router as commercial_onboarding_router
from backend.backup_restore import router as backup_restore_router
from backend.commercial_master_data import router as commercial_master_data_router

# Install the commercial license cap into the existing authentication
# normalization path before any governed routes are evaluated. This makes
# /auth/me deterministic after both login and hard refresh.
import backend.commercial_entitlement_runtime  # noqa: F401,E402

# Keep the commercial-admin permission template aligned with the governance
# rule that an admin has full access to every page inside a licensed module.
# Older admin documents may not contain these newer People Matrix flags;
# dependencies._normalize_permissions merges this template into the stored
# permissions on every authenticated request.
DEFAULT_ROLE_PERMISSIONS.setdefault("admin", {}).update({
    "can_view_leave": True,
    "can_manage_leave": True,
    "can_view_payroll": True,
    "can_manage_payroll": True,
    "can_view_hr": True,
    "can_manage_hr": True,
    "can_view_recruitment": True,
    "can_manage_recruitment": True,
    "can_view_performance": True,
    "can_manage_performance": True,
})

# server.py already includes permission_governance_router in /api. Nest the
# commercial control-plane routers here so their final paths are stable:
# /api/licensing/*, /api/website-config/* and /api/commercial-onboarding/*.
if not any(getattr(r, "path", "") == "/licensing" for r in getattr(permission_governance_router, "routes", [])):
    permission_governance_router.include_router(licensing_router)
if not any(getattr(r, "path", "") == "/website-config" for r in getattr(permission_governance_router, "routes", [])):
    permission_governance_router.include_router(website_config_router)
if not any(getattr(r, "path", "") == "/commercial-onboarding" for r in getattr(permission_governance_router, "routes", [])):
    permission_governance_router.include_router(commercial_onboarding_router)


auth_sync_router = APIRouter(tags=["Authentication"])


@auth_sync_router.post("/auth/sync-permissions")
async def sync_permissions(current_user: User = Depends(get_current_user)):
    permissions = getattr(current_user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()
    elif not isinstance(permissions, dict):
        permissions = {}
    return {"permissions": permissions}


class StubRecordIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    details: Optional[str] = None
    status: Optional[str] = "open"
    extra: Dict[str, Any] = Field(default_factory=dict)


class StubRecordUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: Optional[str] = None
    details: Optional[str] = None
    status: Optional[str] = None
    extra: Optional[Dict[str, Any]] = None


def _build_router(*, prefix: str, tag: str, module_key: str, view_flag: str, manage_flag: str, collection: str, resource_type: str, audit_module: str) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[tag])

    @router.get("")
    async def list_records(current_user: User = Depends(require_page(module_key, view_flag))):
        scope = get_visibility_scope(current_user, resource_type)
        query: Dict[str, Any] = {}
        if scope["scope"] == "own": query = {"created_by": current_user.id}
        elif scope["scope"] == "selected_users": query = {"created_by": {"$in": [*scope["selected"], current_user.id]}}
        elif scope["scope"] == "selected_departments": query = {"department": {"$in": scope["selected"]}}
        return await db[collection].find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)

    @router.get("/{record_id}")
    async def get_record(record_id: str, current_user: User = Depends(require_page(module_key, view_flag))):
        item = await db[collection].find_one({"id": record_id}, {"_id": 0})
        if not item: raise HTTPException(status_code=404, detail="Not found")
        return item

    @router.post("")
    async def create_record(payload: StubRecordIn, current_user: User = Depends(require_action(module_key, manage_flag, "create"))):
        now = datetime.now(timezone.utc).isoformat()
        doc = {"id": str(uuid.uuid4()), "title": payload.title, "details": payload.details, "status": payload.status or "open", "extra": payload.extra or {}, "created_by": current_user.id, "created_by_name": current_user.full_name or current_user.email, "department": (current_user.departments or [None])[0] if getattr(current_user, "departments", None) else None, "created_at": now, "updated_at": now}
        await db[collection].insert_one(doc)
        await create_audit_log(current_user, "CREATE", audit_module, record_id=doc["id"], new_data=doc)
        doc.pop("_id", None)
        return doc

    @router.put("/{record_id}")
    async def update_record(record_id: str, payload: StubRecordUpdate, current_user: User = Depends(require_action(module_key, manage_flag, "edit"))):
        existing = await db[collection].find_one({"id": record_id}, {"_id": 0})
        if not existing: raise HTTPException(status_code=404, detail="Not found")
        updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db[collection].update_one({"id": record_id}, {"$set": updates})
        await create_audit_log(current_user, "UPDATE", audit_module, record_id=record_id, old_data=existing, new_data=updates)
        return {**existing, **updates}

    @router.delete("/{record_id}")
    async def delete_record(record_id: str, current_user: User = Depends(require_action(module_key, manage_flag, "delete"))):
        existing = await db[collection].find_one({"id": record_id}, {"_id": 0})
        if not existing: raise HTTPException(status_code=404, detail="Not found")
        await db[collection].delete_one({"id": record_id})
        await create_audit_log(current_user, "DELETE", audit_module, record_id=record_id, old_data=existing)
        return {"message": "Deleted"}

    return router


leave_router = _build_router(prefix="/leave", tag="Leave", module_key="people_matrix", view_flag="can_view_leave", manage_flag="can_manage_leave", collection="leave_requests", resource_type="leave", audit_module="leave")
payroll_router = _build_router(prefix="/payroll", tag="Payroll", module_key="people_matrix", view_flag="can_view_payroll", manage_flag="can_manage_payroll", collection="payroll_records", resource_type="payroll", audit_module="payroll")
hr_router = _build_router(prefix="/hr", tag="HR", module_key="people_matrix", view_flag="can_view_hr", manage_flag="can_manage_hr", collection="hr_records", resource_type="hr", audit_module="hr")
performance_router = _build_router(prefix="/performance", tag="Performance", module_key="people_matrix", view_flag="can_view_performance", manage_flag="can_manage_performance", collection="performance_records", resource_type="performance", audit_module="performance")
client_discussion_router = _build_router(prefix="/client-discussion", tag="Client Discussion", module_key="proposals", view_flag="can_view_client_discussion", manage_flag="can_manage_client_discussion", collection="client_discussions", resource_type="client_discussion", audit_module="client_discussion")
master_data_router = _build_router(prefix="/master-data", tag="Master Data", module_key="admin", view_flag="can_view_master_data", manage_flag="can_manage_master_data", collection="master_data", resource_type="master_data", audit_module="master_data")
roles_router = _build_router(prefix="/roles", tag="Roles", module_key="admin", view_flag="can_view_roles", manage_flag="can_manage_roles", collection="custom_roles", resource_type="roles", audit_module="roles")

# Commercial Master Data must resolve the tenant from the commercial license,
# not assume that every historical user still has a matching `companies.id`.
# A previous deployment left valid licenses/users in MongoDB while the company
# master row was missing; the role page could still read `users`, but
# /commercial-master-data/users failed before it ever queried that collection.
# Recreate the company master deterministically from the license/customer pair
# before the route runs. This is a compatibility repair, not a privilege
# escalation: the caller still has to be the licensed company administrator.
import backend.commercial_master_data as _commercial_master_data_module  # noqa: E402
from backend.commercial_onboarding import _active_company_license, _ensure_company_master  # noqa: E402
from backend.platform_owner import is_platform_owner  # noqa: E402

_original_commercial_company_context = _commercial_master_data_module._company_context


async def _resilient_commercial_company_context(current_user: User):
    if is_platform_owner(current_user):
        return await _original_commercial_company_context(current_user)

    if getattr(current_user, "role", None) != "admin" or not getattr(current_user, "company_id", None):
        return await _original_commercial_company_context(current_user)

    license_doc = await _active_company_license(current_user)
    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    company = await db.companies.find_one({"id": company_id}, {"_id": 0})
    if company:
        return license_doc, company

    customer_id = str(license_doc.get("customer_id") or company_id).strip()
    customer = await db.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
    if not customer:
        # Some historical company rows used the license id instead of the
        # customer id. Resolve that legacy link before declaring the tenant
        # missing.
        license_id = str(license_doc.get("id") or "").strip()
        if license_id:
            company = await db.companies.find_one({"license_id": license_id}, {"_id": 0})
            if company:
                return license_doc, company
        raise HTTPException(status_code=404, detail="Licensed company profile not found.")

    # `_ensure_company_master` is the canonical company-master constructor and
    # also repairs historical rows that are missing their `id` field.
    company = await _ensure_company_master(customer, license_doc)
    return license_doc, company


_commercial_master_data_module._company_context = _resilient_commercial_company_context

# commercial_master_data_router is included here exactly once. It must not be
# nested into permission_governance_router as well, otherwise FastAPI can
# expose duplicate route registrations and make the /users endpoint behavior
# dependent on router-registration order.
ALL_GOVERNED_ROUTERS: List[APIRouter] = [leave_router, payroll_router, hr_router, performance_router, client_discussion_router, master_data_router, roles_router, auth_sync_router, backup_restore_router, commercial_master_data_router]