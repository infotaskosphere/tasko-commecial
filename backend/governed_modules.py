"""
Governed Modules — the 9 remaining pages named in the Governance & Permission
Matrix spec that did not exist anywhere in this codebase yet:

    People Matrix : Leave, Payroll, HR, Performance
    Records       : Templates, Uploads
    Client Proposals : Client Discussion
    Admin         : Master Data, Roles

(Recruitment used to be a stub here too, but it has been merged with the
former "Employee Interviews" page into one full-featured module — see
backend/recruitment.py — since a real candidate pipeline already existed
and a second, disconnected generic-CRUD "Recruitment" page next to it was
confusing and redundant.)

Each is deliberately a thin, working CRUD skeleton (list / create / update /
delete + audit log), not a fully-designed feature — the point of this file
is that every one of them is wired end-to-end into the centralized
Module → Page → Action → Visibility governance layer (backend/governance_core.py)
from day one, using the exact same helper functions every other module uses.
When a real feature gets built for e.g. Payroll, its endpoints replace the
stub ones here but keep the same `require_page` / `require_action` guards —
no permission-architecture changes needed (this is the "future modules need
only configuration" requirement).

All ten share one collection shape and one router factory (`_build_router`)
so there is exactly one place that implements list/create/update/delete
permission-checking — nothing here duplicates permission logic per module.
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.dependencies import db, get_current_user, create_audit_log
from backend.governance_core import (
    require_page,
    require_action,
    get_visibility_scope,
)
from backend.models import User
from backend.licensing_api import router as licensing_router


# AuthContext restores an existing session and explicitly synchronizes
# permissions through this endpoint. The route was moved out of server.py
# during the permission-governance split but the frontend contract remained.
auth_sync_router = APIRouter(tags=["Authentication"])


@auth_sync_router.post("/auth/sync-permissions")
async def sync_permissions(current_user: User = Depends(get_current_user)):
    """Return the authenticated user's current, normalized permissions.

    get_current_user already normalizes role defaults and stored permission
    overrides, so this endpoint intentionally returns that authoritative
    permission set without changing the database.
    """
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


def _build_router(
    *,
    prefix: str,
    tag: str,
    module_key: str,
    view_flag: str,
    manage_flag: str,
    collection: str,
    resource_type: str,
    audit_module: str,
) -> APIRouter:
    router = APIRouter(prefix=prefix, tags=[tag])

    @router.get("")
    async def list_records(current_user: User = Depends(require_page(module_key, view_flag))):
        scope = get_visibility_scope(current_user, resource_type)
        query: Dict[str, Any] = {}
        if scope["scope"] == "own":
            query = {"created_by": current_user.id}
        elif scope["scope"] == "selected_users":
            query = {"created_by": {"$in": [*scope["selected"], current_user.id]}}
        elif scope["scope"] == "selected_departments":
            query = {"department": {"$in": scope["selected"]}}
        # "organization" (incl. admin) → no filter
        items = await db[collection].find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
        return items

    @router.get("/{record_id}")
    async def get_record(record_id: str, current_user: User = Depends(require_page(module_key, view_flag))):
        item = await db[collection].find_one({"id": record_id}, {"_id": 0})
        if not item:
            raise HTTPException(status_code=404, detail="Not found")
        return item

    @router.post("")
    async def create_record(
        payload: StubRecordIn,
        current_user: User = Depends(require_action(module_key, manage_flag, "create")),
    ):
        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "id": str(uuid.uuid4()),
            "title": payload.title,
            "details": payload.details,
            "status": payload.status or "open",
            "extra": payload.extra or {},
            "created_by": current_user.id,
            "created_by_name": current_user.full_name or current_user.email,
            "department": (current_user.departments or [None])[0] if getattr(current_user, "departments", None) else None,
            "created_at": now,
            "updated_at": now,
        }
        await db[collection].insert_one(doc)
        await create_audit_log(current_user, "CREATE", audit_module, record_id=doc["id"], new_data=doc)
        doc.pop("_id", None)
        return doc

    @router.put("/{record_id}")
    async def update_record(
        record_id: str,
        payload: StubRecordUpdate,
        current_user: User = Depends(require_action(module_key, manage_flag, "edit")),
    ):
        existing = await db[collection].find_one({"id": record_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
        updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        await db[collection].update_one({"id": record_id}, {"$set": updates})
        await create_audit_log(current_user, "UPDATE", audit_module, record_id=record_id, old_data=existing, new_data=updates)
        merged = {**existing, **updates}
        return merged

    @router.delete("/{record_id}")
    async def delete_record(
        record_id: str,
        current_user: User = Depends(require_action(module_key, manage_flag, "delete")),
    ):
        existing = await db[collection].find_one({"id": record_id}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="Not found")
        await db[collection].delete_one({"id": record_id})
        await create_audit_log(current_user, "DELETE", audit_module, record_id=record_id, old_data=existing)
        return {"message": "Deleted"}

    return router


# ── People Matrix ────────────────────────────────────────────────────────
leave_router = _build_router(
    prefix="/leave", tag="Leave", module_key="people_matrix",
    view_flag="can_view_leave", manage_flag="can_manage_leave",
    collection="leave_requests", resource_type="leave", audit_module="leave",
)
payroll_router = _build_router(
    prefix="/payroll", tag="Payroll", module_key="people_matrix",
    view_flag="can_view_payroll", manage_flag="can_manage_payroll",
    collection="payroll_records", resource_type="payroll", audit_module="payroll",
)
hr_router = _build_router(
    prefix="/hr", tag="HR", module_key="people_matrix",
    view_flag="can_view_hr", manage_flag="can_manage_hr",
    collection="hr_records", resource_type="hr", audit_module="hr",
)
performance_router = _build_router(
    prefix="/performance", tag="Performance", module_key="people_matrix",
    view_flag="can_view_performance", manage_flag="can_manage_performance",
    collection="performance_records", resource_type="performance", audit_module="performance",
)

# ── Records ──────────────────────────────────────────────────────────────
# (Templates / Uploads registers were removed — unused in the product.)

# ── Client Proposals ─────────────────────────────────────────────────────
client_discussion_router = _build_router(
    prefix="/client-discussion", tag="Client Discussion", module_key="proposals",
    view_flag="can_view_client_discussion", manage_flag="can_manage_client_discussion",
    collection="client_discussions", resource_type="client_discussion", audit_module="client_discussion",
)

# ── Admin ─────────────────────────────────────────────────────────────────
master_data_router = _build_router(
    prefix="/master-data", tag="Master Data", module_key="admin",
    view_flag="can_view_master_data", manage_flag="can_manage_master_data",
    collection="master_data", resource_type="master_data", audit_module="master_data",
)
roles_router = _build_router(
    prefix="/roles", tag="Roles", module_key="admin",
    view_flag="can_view_roles", manage_flag="can_manage_roles",
    collection="custom_roles", resource_type="roles", audit_module="roles",
)

ALL_GOVERNED_ROUTERS: List[APIRouter] = [
    leave_router, payroll_router, hr_router, performance_router,
    client_discussion_router,
    master_data_router, roles_router,
    auth_sync_router,
    # Commercial licensing is mounted by server.py through this centralized
    # router list, guaranteeing /api/licensing/* is present regardless of
    # which production launcher imports the FastAPI app.
    licensing_router,
]
