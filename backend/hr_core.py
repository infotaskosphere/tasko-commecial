"""
HR Core — Phase 1 of the People Matrix → HRMS upgrade.

Adds the foundation every later HR module (Leave, Payroll, PF/ESIC/TDS,
Recruitment, Performance...) will build on:

    • Department Management   (new "departments" collection)
    • Designation Management  (new "designations" collection)
    • Employee Master         (a richer read/write layer over the EXISTING
                                "users" collection — no duplicate employee
                                data. See backend/models.py for the new
                                optional fields added to User/UserCreate/
                                UserUpdate.)

Design choices, and why:

- Reuses the existing centralized governance layer (backend/governance_core)
  and the existing "can_view_hr" / "can_manage_hr" permission flags already
  present in UserPermissions / MODULE_HIERARCHY["people_matrix"] — no new
  permission flags, no new permission-checking logic.
- Departments/Designations are intentionally new, small, standalone
  collections (there was no structured equivalent before — `User.departments`
  is a free-text tag list and is left completely untouched for backward
  compatibility).
- Employee Master does NOT create a parallel "employees" collection. It reads
  and writes the existing `users` collection, projecting out `password` the
  same way GET /api/users already does, and only ever updates the new
  HR-specific fields — never auth fields (email/password/role) — so this can
  never affect login, permissions, or anything already working.
- Routes are mounted under /people-matrix/... (not /hr/...) to avoid any
  path collision with the existing generic /hr stub in
  backend/governed_modules.py, which is left completely alone.
"""

import uuid
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from backend.dependencies import db, get_current_user, create_audit_log
from backend.governance_core import require_page, require_action
from backend.models import User, UserUpdate

logger = logging.getLogger(__name__)

VIEW_FLAG = "can_view_hr"
MANAGE_FLAG = "can_manage_hr"
MODULE_KEY = "people_matrix"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _strip(doc: Optional[dict]) -> Optional[dict]:
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


# =============================================================================
# DEPARTMENTS
# =============================================================================

class DepartmentIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str
    code: Optional[str] = None
    description: Optional[str] = None
    head_user_id: Optional[str] = None  # a User.id — the department head


class DepartmentUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: Optional[str] = None
    code: Optional[str] = None
    description: Optional[str] = None
    head_user_id: Optional[str] = None
    is_active: Optional[bool] = None


department_router = APIRouter(prefix="/people-matrix/departments", tags=["HR — Departments"])


@department_router.get("")
async def list_departments(current_user: User = Depends(require_page(MODULE_KEY, VIEW_FLAG))):
    items = await db.departments.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    return items


@department_router.get("/{department_id}")
async def get_department(department_id: str, current_user: User = Depends(require_page(MODULE_KEY, VIEW_FLAG))):
    item = await db.departments.find_one({"id": department_id}, {"_id": 0})
    if not item:
        raise HTTPException(status_code=404, detail="Department not found")
    return item


@department_router.post("")
async def create_department(
    payload: DepartmentIn,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "create")),
):
    existing = await db.departments.find_one({"name": payload.name})
    if existing:
        raise HTTPException(status_code=400, detail="A department with this name already exists")
    now = _now()
    doc = {
        "id": str(uuid.uuid4()),
        "name": payload.name,
        "code": payload.code,
        "description": payload.description,
        "head_user_id": payload.head_user_id,
        "is_active": True,
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    await db.departments.insert_one(doc)
    await create_audit_log(current_user, "CREATE", "hr_department", record_id=doc["id"], new_data=doc)
    return _strip(doc)


@department_router.put("/{department_id}")
async def update_department(
    department_id: str,
    payload: DepartmentUpdate,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "edit")),
):
    existing = await db.departments.find_one({"id": department_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Department not found")
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    updates["updated_at"] = _now()
    await db.departments.update_one({"id": department_id}, {"$set": updates})
    await create_audit_log(current_user, "UPDATE", "hr_department", record_id=department_id, old_data=existing, new_data=updates)
    return {**existing, **updates}


@department_router.delete("/{department_id}")
async def delete_department(
    department_id: str,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "delete")),
):
    existing = await db.departments.find_one({"id": department_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Department not found")
    in_use = await db.users.count_documents({"department_id": department_id})
    if in_use:
        raise HTTPException(
            status_code=400,
            detail=f"{in_use} employee(s) are assigned to this department. Reassign them first.",
        )
    await db.departments.delete_one({"id": department_id})
    await create_audit_log(current_user, "DELETE", "hr_department", record_id=department_id, old_data=existing)
    return {"message": "Deleted"}


# =============================================================================
# DESIGNATIONS
# =============================================================================

class DesignationIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    department_id: Optional[str] = None  # optional — a designation can span departments
    grade: Optional[str] = None
    description: Optional[str] = None


class DesignationUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: Optional[str] = None
    department_id: Optional[str] = None
    grade: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


designation_router = APIRouter(prefix="/people-matrix/designations", tags=["HR — Designations"])


@designation_router.get("")
async def list_designations(current_user: User = Depends(require_page(MODULE_KEY, VIEW_FLAG))):
    items = await db.designations.find({}, {"_id": 0}).sort("title", 1).to_list(1000)
    return items


@designation_router.post("")
async def create_designation(
    payload: DesignationIn,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "create")),
):
    now = _now()
    doc = {
        "id": str(uuid.uuid4()),
        "title": payload.title,
        "department_id": payload.department_id,
        "grade": payload.grade,
        "description": payload.description,
        "is_active": True,
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    await db.designations.insert_one(doc)
    await create_audit_log(current_user, "CREATE", "hr_designation", record_id=doc["id"], new_data=doc)
    return _strip(doc)


@designation_router.put("/{designation_id}")
async def update_designation(
    designation_id: str,
    payload: DesignationUpdate,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "edit")),
):
    existing = await db.designations.find_one({"id": designation_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Designation not found")
    updates = {k: v for k, v in payload.model_dump(exclude_unset=True).items() if v is not None}
    updates["updated_at"] = _now()
    await db.designations.update_one({"id": designation_id}, {"$set": updates})
    await create_audit_log(current_user, "UPDATE", "hr_designation", record_id=designation_id, old_data=existing, new_data=updates)
    return {**existing, **updates}


@designation_router.delete("/{designation_id}")
async def delete_designation(
    designation_id: str,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "delete")),
):
    existing = await db.designations.find_one({"id": designation_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Designation not found")
    await db.designations.delete_one({"id": designation_id})
    await create_audit_log(current_user, "DELETE", "hr_designation", record_id=designation_id, old_data=existing)
    return {"message": "Deleted"}


# =============================================================================
# EMPLOYEE MASTER
# Reuses the existing `users` collection — this is a view/edit layer over it,
# not a new employee store. `password`, `role`, `email` are handled by the
# existing Users/Auth endpoints and are never touched here.
# =============================================================================

# Fields Employee Master is allowed to edit. Deliberately excludes
# auth/identity fields (email, password, role, is_active, status) so this
# module can never be used to change login/permissions — that stays the
# job of the existing Users page / auth endpoints.
_EDITABLE_FIELDS = {
    "full_name", "phone", "departments", "joining_date", "training_period_end",
    "payroll_date", "monthly_salary", "employee_code", "designation",
    "department_id", "reporting_manager_id", "employment_type",
    "confirmation_date", "grade", "cost_centre", "pan_number",
    "aadhaar_number", "uan_number", "pf_number", "esic_number",
    "bank_account_number", "bank_name", "ifsc_code",
}

employee_router = APIRouter(prefix="/people-matrix/employees", tags=["HR — Employee Master"])


@employee_router.get("")
async def list_employees(
    department_id: Optional[str] = None,
    current_user: User = Depends(require_page(MODULE_KEY, VIEW_FLAG)),
):
    query: Dict[str, Any] = {}
    if department_id:
        query["department_id"] = department_id
    employees = await db.users.find(query, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0}).sort("full_name", 1).to_list(2000)
    return employees


@employee_router.get("/{employee_id}")
async def get_employee(employee_id: str, current_user: User = Depends(require_page(MODULE_KEY, VIEW_FLAG))):
    employee = await db.users.find_one({"id": employee_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    if not employee:
        raise HTTPException(status_code=404, detail="Employee not found")
    return employee


@employee_router.put("/{employee_id}")
async def update_employee(
    employee_id: str,
    payload: UserUpdate,
    current_user: User = Depends(require_action(MODULE_KEY, MANAGE_FLAG, "edit")),
):
    existing = await db.users.find_one({"id": employee_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Employee not found")

    updates = {
        k: v for k, v in payload.model_dump(exclude_unset=True).items()
        if k in _EDITABLE_FIELDS
    }
    if not updates:
        return existing

    if updates.get("department_id"):
        dept = await db.departments.find_one({"id": updates["department_id"]})
        if not dept:
            raise HTTPException(status_code=400, detail="department_id does not match any existing Department")

    updates["updated_at"] = _now()
    await db.users.update_one({"id": employee_id}, {"$set": updates})
    await create_audit_log(current_user, "UPDATE", "hr_employee", record_id=employee_id, old_data=existing, new_data=updates)
    return {**existing, **updates}


ALL_HR_CORE_ROUTERS: List[APIRouter] = [department_router, designation_router, employee_router]
