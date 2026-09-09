"""
Roles Admin — the engine behind "Admin › Roles".

What this adds on top of the old generic Roles CRUD stub
(backend/governed_modules.py → roles_router, which only stored
title/details rows):

1. Role definitions with real permissions
   - The three built-in roles (admin / manager / staff) come from
     DEFAULT_ROLE_PERMISSIONS in backend/models.py. An admin can now EDIT
     their default permission template from the UI; the edit is stored as an
     override document in the `role_definitions` collection so the code
     defaults stay intact and untouched files keep working.
   - Custom roles (e.g. "Senior Manager", "Audit Reviewer") can be created.
     Every custom role declares a `base_role` (admin/manager/staff) which is
     what actually gets written to `user.role`, so every existing
     role == "admin"/"manager"/"staff" check in the codebase keeps working
     unchanged. The custom role key is stored separately on `user.role_key`.

2. Users + role assignment in one place
   - List every user with their role, change a user's role, optionally
     re-applying that role's default permissions, and create a brand new
     employee directly from the Roles page.

3. Permission governance per role
   - The editable surface is exactly MODULE_HIERARCHY (module master flags +
     their page flags) plus the Accounts-module governed flags, so what an
     admin toggles here is the same vocabulary the rest of the app enforces.
   - Module hierarchy is enforced on save: a page flag can never be True
     while its parent module flag is False.

Mounted in backend/server.py as `api_router.include_router(roles_admin_router)`.
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from passlib.context import CryptContext
from pydantic import BaseModel, ConfigDict, Field

from backend.dependencies import db, get_current_user, create_audit_log
from backend.models import User, DEFAULT_ROLE_PERMISSIONS, MODULE_HIERARCHY

router = APIRouter(prefix="/role-admin", tags=["Roles Admin"])

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

BUILTIN_ROLES: Dict[str, Dict[str, str]] = {
    "admin": {
        "label": "Admin",
        "description": "Full control of the organisation — every module, every page, every action.",
    },
    "manager": {
        "label": "Manager",
        "description": "Team leadership — own + team visibility, task/client management and reporting.",
    },
    "staff": {
        "label": "Staff",
        "description": "Individual contributor — own work only.",
    },
}

ROLE_DEFS = "role_definitions"

# The permission flags an admin may govern from this page: every module
# master flag and every page flag declared in MODULE_HIERARCHY.
_MODULE_TO_PAGES: Dict[str, List[str]] = {
    m["flag"]: [p["flag"] for p in m["pages"]] for m in MODULE_HIERARCHY.values()
}
GOVERNABLE_FLAGS: List[str] = [
    f for module_flag, pages in _MODULE_TO_PAGES.items() for f in [module_flag, *pages]
]


def _require_admin(user: User):
    if getattr(user, "role", None) != "admin":
        raise HTTPException(status_code=403, detail="Only an admin can manage roles.")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _enforce_hierarchy(perms: Dict[str, bool]) -> Dict[str, bool]:
    """A page flag can never stay on while its parent module flag is off."""
    out = dict(perms)
    for module_flag, page_flags in _MODULE_TO_PAGES.items():
        if not bool(out.get(module_flag, False)):
            for pf in page_flags:
                out[pf] = False
    return out


def _clean_permissions(raw: Optional[Dict[str, Any]]) -> Dict[str, bool]:
    """Keep only known, boolean, governable flags — never trust the client."""
    raw = raw or {}
    return _enforce_hierarchy({f: bool(raw.get(f, False)) for f in GOVERNABLE_FLAGS})


def _base_template(base_role: str) -> Dict[str, bool]:
    tpl = DEFAULT_ROLE_PERMISSIONS.get(base_role, {})
    return _clean_permissions({f: tpl.get(f, False) for f in GOVERNABLE_FLAGS})


async def _role_docs() -> Dict[str, dict]:
    docs = await db[ROLE_DEFS].find({}, {"_id": 0}).to_list(500)
    return {d["key"]: d for d in docs}


async def _user_counts() -> Dict[str, int]:
    counts: Dict[str, int] = {}
    users = await db.users.find({}, {"_id": 0, "role": 1, "role_key": 1}).to_list(5000)
    for u in users:
        key = u.get("role_key") or u.get("role") or "staff"
        counts[key] = counts.get(key, 0) + 1
    return counts


def _compose(key: str, doc: Optional[dict], builtin: bool, base_role: str) -> dict:
    meta = BUILTIN_ROLES.get(key, {})
    permissions = _base_template(base_role)
    if doc and doc.get("permissions"):
        permissions.update(_clean_permissions({**permissions, **doc["permissions"]}))
        permissions = _enforce_hierarchy(permissions)
    return {
        "key": key,
        "label": (doc or {}).get("label") or meta.get("label") or key.replace("_", " ").title(),
        "description": (doc or {}).get("description") or meta.get("description") or "",
        "base_role": base_role,
        "is_builtin": builtin,
        "is_customized": bool(doc and doc.get("permissions")),
        "permissions": permissions,
        "updated_at": (doc or {}).get("updated_at"),
    }


async def _all_roles() -> List[dict]:
    docs = await _role_docs()
    counts = await _user_counts()
    roles: List[dict] = []
    for key in BUILTIN_ROLES:
        roles.append(_compose(key, docs.get(key), True, key))
    for key, doc in docs.items():
        if key in BUILTIN_ROLES:
            continue
        roles.append(_compose(key, doc, False, doc.get("base_role", "staff")))
    for r in roles:
        r["user_count"] = counts.get(r["key"], 0)
    return roles


# ── Catalog ────────────────────────────────────────────────────────────────
@router.get("/permission-surface")
async def permission_surface(current_user: User = Depends(get_current_user)):
    """The Module → Page tree an admin can govern for a role."""
    return [
        {
            "module": key,
            "flag": m["flag"],
            "label": m["label"],
            "description": m.get("description", ""),
            "pages": [
                {"flag": p["flag"], "label": p["label"], "actions": p.get("actions", ["view"])}
                for p in m["pages"]
            ],
        }
        for key, m in MODULE_HIERARCHY.items()
    ]


@router.get("/roles")
async def list_roles(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    return await _all_roles()


class RoleIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    key: Optional[str] = None
    label: str
    description: Optional[str] = ""
    base_role: str = "staff"
    permissions: Dict[str, Any] = Field(default_factory=dict)
    clone_from: Optional[str] = None


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    label: Optional[str] = None
    description: Optional[str] = None
    permissions: Optional[Dict[str, Any]] = None


def _slug(text: str) -> str:
    out = "".join(c.lower() if c.isalnum() else "_" for c in (text or "").strip())
    while "__" in out:
        out = out.replace("__", "_")
    return out.strip("_") or f"role_{uuid.uuid4().hex[:6]}"


@router.post("/roles")
async def create_role(payload: RoleIn, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if payload.base_role not in BUILTIN_ROLES:
        raise HTTPException(status_code=400, detail="base_role must be admin, manager or staff.")
    key = _slug(payload.key or payload.label)
    if key in BUILTIN_ROLES:
        raise HTTPException(status_code=400, detail="That role name is reserved.")
    if await db[ROLE_DEFS].find_one({"key": key}):
        raise HTTPException(status_code=400, detail="A role with that name already exists.")

    if payload.clone_from:
        source = next((r for r in await _all_roles() if r["key"] == payload.clone_from), None)
        if not source:
            raise HTTPException(status_code=404, detail="Role to clone from was not found.")
        permissions = dict(source["permissions"])
        permissions.update({k: bool(v) for k, v in (payload.permissions or {}).items() if k in GOVERNABLE_FLAGS})
        permissions = _enforce_hierarchy(permissions)
    else:
        permissions = _clean_permissions(payload.permissions)

    doc = {
        "key": key,
        "label": payload.label.strip(),
        "description": (payload.description or "").strip(),
        "base_role": payload.base_role,
        "permissions": permissions,
        "created_by": current_user.id,
        "created_at": _now(),
        "updated_at": _now(),
    }
    await db[ROLE_DEFS].insert_one(dict(doc))
    await create_audit_log(current_user, "CREATE", "roles", record_id=key, new_data=doc)
    doc.pop("_id", None)
    return _compose(key, doc, False, payload.base_role)


@router.put("/roles/{key}")
async def update_role(key: str, payload: RoleUpdate, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    existing = await db[ROLE_DEFS].find_one({"key": key}, {"_id": 0})
    is_builtin = key in BUILTIN_ROLES
    if not existing and not is_builtin:
        raise HTTPException(status_code=404, detail="Role not found.")
    if key == "admin" and payload.permissions is not None:
        raise HTTPException(
            status_code=400,
            detail="The Admin role always keeps full access and cannot be restricted.",
        )

    base_role = (existing or {}).get("base_role", key if is_builtin else "staff")
    updates: Dict[str, Any] = {"updated_at": _now(), "base_role": base_role, "key": key}
    if payload.label is not None:
        updates["label"] = payload.label.strip()
    if payload.description is not None:
        updates["description"] = payload.description.strip()
    if payload.permissions is not None:
        merged = _base_template(base_role)
        merged.update({k: bool(v) for k, v in payload.permissions.items() if k in GOVERNABLE_FLAGS})
        updates["permissions"] = _enforce_hierarchy(merged)

    await db[ROLE_DEFS].update_one({"key": key}, {"$set": updates}, upsert=True)
    await create_audit_log(current_user, "UPDATE", "roles", record_id=key, old_data=existing, new_data=updates)
    doc = await db[ROLE_DEFS].find_one({"key": key}, {"_id": 0})
    role = _compose(key, doc, is_builtin, base_role)
    role["user_count"] = (await _user_counts()).get(key, 0)
    return role


@router.delete("/roles/{key}")
async def delete_role(key: str, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if key in BUILTIN_ROLES:
        raise HTTPException(status_code=400, detail="Built-in roles cannot be deleted.")
    in_use = await db.users.count_documents({"role_key": key})
    if in_use:
        raise HTTPException(
            status_code=400,
            detail=f"{in_use} user(s) still use this role. Move them to another role first.",
        )
    existing = await db[ROLE_DEFS].find_one({"key": key}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Role not found.")
    await db[ROLE_DEFS].delete_one({"key": key})
    await create_audit_log(current_user, "DELETE", "roles", record_id=key, old_data=existing)
    return {"message": "Role deleted"}


@router.post("/roles/{key}/reset")
async def reset_role(key: str, current_user: User = Depends(get_current_user)):
    """Drop the override and go back to the code defaults for a built-in role."""
    _require_admin(current_user)
    if key not in BUILTIN_ROLES:
        raise HTTPException(status_code=400, detail="Only built-in roles can be reset.")
    await db[ROLE_DEFS].delete_one({"key": key})
    await create_audit_log(current_user, "UPDATE", "roles", record_id=key, new_data={"reset": True})
    role = _compose(key, None, True, key)
    role["user_count"] = (await _user_counts()).get(key, 0)
    return role


@router.post("/roles/{key}/apply-to-users")
async def apply_role_to_users(key: str, current_user: User = Depends(get_current_user)):
    """Push this role's default permissions onto every user holding it."""
    _require_admin(current_user)
    role = next((r for r in await _all_roles() if r["key"] == key), None)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found.")
    query = {"role_key": key} if key not in BUILTIN_ROLES else {
        "$or": [{"role_key": key}, {"role_key": {"$exists": False}, "role": key}, {"role_key": None, "role": key}]
    }
    users = await db.users.find(query, {"_id": 0, "id": 1}).to_list(5000)
    sets = {f"permissions.{f}": v for f, v in role["permissions"].items()}
    for u in users:
        await db.users.update_one({"id": u["id"]}, {"$set": sets})
    await create_audit_log(current_user, "UPDATE", "roles", record_id=key, new_data={"applied_to": len(users)})
    return {"message": f"Applied to {len(users)} user(s).", "count": len(users)}


# ── Users ──────────────────────────────────────────────────────────────────
@router.get("/users")
async def list_users(current_user: User = Depends(get_current_user)):
    _require_admin(current_user)

    # Scope users by company / tenant
    raw_lic_comps = await db.companies.find(
        {"$or": [
            {"source": {"$in": ["commercial-license", "commercial", "license"]}},
            {"commercial_customer_id": {"$nin": [None, "", "platform-owner"]}},
            {"license_id": {"$nin": [None, "", "platform-owner-license"]}},
        ]},
        {"_id": 0, "id": 1},
    ).to_list(5000)
    licensee_comp_ids = {str(c["id"]) for c in raw_lic_comps if c.get("id")}

    user_customer_id = getattr(current_user, "commercial_customer_id", None)
    user_license_id = getattr(current_user, "license_id", None)
    user_comp_id = getattr(current_user, "company_id", None)

    is_licensee_user = bool(
        (user_customer_id and str(user_customer_id).strip() != "platform-owner") or
        (user_license_id and str(user_license_id).strip() != "platform-owner-license") or
        (user_comp_id and str(user_comp_id) in licensee_comp_ids)
    )

    if is_licensee_user:
        clauses = []
        if user_customer_id and str(user_customer_id).strip() != "platform-owner":
            clauses.append({"commercial_customer_id": str(user_customer_id)})
        if user_license_id and str(user_license_id).strip() != "platform-owner-license":
            clauses.append({"license_id": str(user_license_id)})
        if user_comp_id:
            clauses.append({"company_id": str(user_comp_id)})
        user_query = {"$or": clauses} if clauses else {}
    else:
        user_query = {
            "commercial_customer_id": {"$in": [None, "", "platform-owner"]},
            "license_id": {"$in": [None, "", "platform-owner-license"]},
        }
        if licensee_comp_ids:
            user_query["company_id"] = {"$nin": list(licensee_comp_ids)}

    users = await db.users.find(user_query, {"_id": 0, "password": 0}).to_list(5000)
    roles = {r["key"]: r for r in await _all_roles()}
    out = []
    for u in users:
        key = u.get("role_key") or u.get("role") or "staff"
        out.append({
            "id": u.get("id"),
            "full_name": u.get("full_name") or u.get("email"),
            "email": u.get("email"),
            "role": u.get("role", "staff"),
            "role_key": key,
            "role_label": roles.get(key, {}).get("label", key),
            "departments": u.get("departments", []),
            "status": u.get("status", "active"),
            "is_active": bool(u.get("is_active", True)),
            "profile_picture": u.get("profile_picture"),
            "created_at": u.get("created_at"),
        })
    out.sort(key=lambda x: (x["role"] != "admin", (x["full_name"] or "").lower()))
    return out


class AssignRoleIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    role_key: str
    apply_defaults: bool = True


@router.put("/users/{user_id}/role")
async def assign_role(user_id: str, payload: AssignRoleIn, current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found.")
    role = next((r for r in await _all_roles() if r["key"] == payload.role_key), None)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found.")
    if user_id == current_user.id and role["base_role"] != "admin":
        raise HTTPException(
            status_code=400,
            detail="You cannot remove your own admin access — ask another admin to do it.",
        )

    updates: Dict[str, Any] = {"role": role["base_role"], "role_key": role["key"]}
    if payload.apply_defaults:
        updates.update({f"permissions.{f}": v for f, v in role["permissions"].items()})
    await db.users.update_one({"id": user_id}, {"$set": updates})
    await create_audit_log(
        current_user, "UPDATE", "users", record_id=user_id,
        old_data={"role": user.get("role"), "role_key": user.get("role_key")},
        new_data={"role": role["base_role"], "role_key": role["key"]},
    )
    return {"message": f"{user.get('full_name') or user.get('email')} is now {role['label']}."}


class EmployeeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    full_name: str
    email: str
    password: str
    role_key: str = "staff"
    departments: List[str] = Field(default_factory=list)
    phone: Optional[str] = None
    is_active: bool = True


@router.post("/users")
async def create_employee(payload: EmployeeIn, current_user: User = Depends(get_current_user)):
    """Add a new employee straight from the Roles page, already carrying the
    chosen role's default permissions."""
    _require_admin(current_user)
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="A valid email is required.")
    if len(payload.password or "") < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")
    if await db.users.find_one({"email": email}):
        raise HTTPException(status_code=400, detail="That email is already registered.")
    role = next((r for r in await _all_roles() if r["key"] == payload.role_key), None)
    if not role:
        raise HTTPException(status_code=404, detail="Role not found.")

    base_template = dict(DEFAULT_ROLE_PERMISSIONS.get(role["base_role"], {}))
    base_template.update(role["permissions"])

    doc = {
        "id": str(uuid.uuid4()),
        "email": email,
        "full_name": payload.full_name.strip(),
        "role": role["base_role"],
        "role_key": role["key"],
        "password": pwd_context.hash(payload.password),
        "departments": payload.departments or [],
        "phone": payload.phone,
        "permissions": base_template,
        "is_active": bool(payload.is_active),
        "status": "active" if payload.is_active else "pending_approval",
        "approved_by": current_user.id,
        "approved_at": _now(),
        "created_at": _now(),
        "punch_in_time": "10:30",
        "grace_time": "00:10",
        "punch_out_time": "19:00",
    }
    await db.users.insert_one(dict(doc))
    await create_audit_log(current_user, "CREATE", "users", record_id=doc["id"], new_data={
        "email": email, "role": role["base_role"], "role_key": role["key"]})
    return {
        "id": doc["id"],
        "full_name": doc["full_name"],
        "email": email,
        "role": doc["role"],
        "role_key": doc["role_key"],
        "role_label": role["label"],
        "departments": doc["departments"],
        "status": doc["status"],
        "is_active": doc["is_active"],
    }
