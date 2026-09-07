"""
Governance Core — the centralized permission architecture used by every
module. Commercial licenses add a tenant-level entitlement cap above the
existing MODULE → PAGE → ACTION → VISIBILITY hierarchy.

Internal/system admins retain the historical full-access bypass. A licensed
company admin retains full access inside the modules purchased for that
company, but cannot enter an unlicensed module.
"""

from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException

from backend.dependencies import get_current_user, get_user_permissions
from backend.models import MODULE_HIERARCHY, User

_MODULE_FLAGS = {
    key: definition["flag"]
    for key, definition in MODULE_HIERARCHY.items()
    if key != "admin"
}


def _is_commercial_admin(user: User) -> bool:
    """Commercial admins have a company_id and persisted module entitlements."""
    if getattr(user, "role", None) != "admin":
        return False
    perms = get_user_permissions(user)
    return bool(getattr(user, "company_id", None)) and any(
        flag in perms for flag in _MODULE_FLAGS.values()
    )


def _admin_bypass(user: User) -> bool:
    """True only for the unrestricted internal/system admin."""
    return getattr(user, "role", None) == "admin" and not _is_commercial_admin(user)


# =============================================================================
# 1. MODULE ACCESS
# =============================================================================

def has_module_access(user: User, module_key: str) -> bool:
    if _admin_bypass(user):
        return True
    if module_key == "admin":
        return getattr(user, "role", None) == "admin"

    module_def = MODULE_HIERARCHY.get(module_key)
    if not module_def:
        return False

    perms = get_user_permissions(user)
    return bool(perms.get(module_def["flag"], False))


# =============================================================================
# 2. PAGE ACCESS
# =============================================================================

def has_page_access(user: User, module_key: str, page_flag: str) -> bool:
    if _admin_bypass(user):
        return True
    if not has_module_access(user, module_key):
        return False

    # Commercial admins have full page access inside an entitled module.
    if getattr(user, "role", None) == "admin":
        return True

    perms = get_user_permissions(user)
    return bool(perms.get(page_flag, False))


# =============================================================================
# 3. ACTION ACCESS
# =============================================================================

_VIEW_ONLY_ACTIONS = {"view", "export"}
_MANAGE_ACTIONS = {"create", "edit", "delete", "approve", "print", "share"}
ALL_ACTIONS = ["view", "create", "edit", "delete", "export", "approve", "print", "share"]


def has_action_access(user: User, module_key: str, page_flag: str, action: str) -> bool:
    if _admin_bypass(user):
        return True
    if not has_page_access(user, module_key, page_flag):
        return False

    # Commercial admin is unrestricted inside the purchased module.
    if getattr(user, "role", None) == "admin":
        return True

    perms = get_user_permissions(user)
    matrix_key = f"{module_key}.{page_flag}"
    matrix: Dict[str, List[str]] = perms.get("governance_matrix", {}) or {}

    if matrix_key in matrix:
        return action in matrix[matrix_key]

    manage_flag = page_flag.replace("can_view_", "can_manage_", 1) if page_flag.startswith("can_view_") else None
    if action in _VIEW_ONLY_ACTIONS:
        return bool(perms.get(page_flag, False))
    if action in _MANAGE_ACTIONS:
        if manage_flag and manage_flag in perms:
            return bool(perms.get(manage_flag, False))
        return bool(perms.get(page_flag, False))
    return False


# =============================================================================
# 4. VISIBILITY ACCESS
# =============================================================================

VISIBILITY_SCOPES = ("own", "selected_users", "selected_departments", "selected_roles", "organization")

_LEGACY_VISIBILITY_FIELDS = {
    "tasks": "view_other_tasks",
    "attendance": "view_other_attendance",
    "reports": "view_other_reports",
    "todos": "view_other_todos",
    "activity": "view_other_activity",
    "visits": "view_other_visits",
    "clients": "assigned_clients",
    "passwords": "view_password_departments",
}


def get_visibility_scope(user: User, resource_type: str) -> Dict[str, Any]:
    if _admin_bypass(user) or getattr(user, "role", None) == "admin":
        return {"scope": "organization", "selected": []}

    perms = get_user_permissions(user)
    legacy_field = _LEGACY_VISIBILITY_FIELDS.get(resource_type)
    if legacy_field is not None:
        selected = perms.get(legacy_field, []) or []
        scope = "selected_users" if selected else "own"
        return {"scope": scope, "selected": selected}

    vis = (perms.get("visibility_matrix", {}) or {}).get(resource_type)
    if not vis:
        return {"scope": "own", "selected": []}
    return {"scope": vis.get("scope", "own"), "selected": vis.get("selected", [])}


def has_visibility_access(
    user: User,
    resource_type: str,
    owner_id: Optional[str] = None,
    department: Optional[str] = None,
    role: Optional[str] = None,
) -> bool:
    if _admin_bypass(user) or getattr(user, "role", None) == "admin":
        return True

    scope_info = get_visibility_scope(user, resource_type)
    scope = scope_info["scope"]
    if scope == "organization":
        return True
    if scope == "own":
        return owner_id == user.id
    if scope == "selected_users":
        return owner_id in scope_info["selected"] or owner_id == user.id
    if scope == "selected_departments":
        return department in scope_info["selected"]
    if scope == "selected_roles":
        return role in scope_info["selected"]
    return owner_id == user.id


# =============================================================================
# FASTAPI DEPENDENCY GUARDS
# =============================================================================

def require_module(module_key: str):
    async def _guard(current_user: User = Depends(get_current_user)):
        if not has_module_access(current_user, module_key):
            raise HTTPException(status_code=403, detail=f"No access to module '{module_key}'.")
        return current_user
    return _guard


def require_page(module_key: str, page_flag: str):
    async def _guard(current_user: User = Depends(get_current_user)):
        if not has_page_access(current_user, module_key, page_flag):
            raise HTTPException(status_code=403, detail="No access to this page.")
        return current_user
    return _guard


def require_action(module_key: str, page_flag: str, action: str):
    async def _guard(current_user: User = Depends(get_current_user)):
        if not has_action_access(current_user, module_key, page_flag, action):
            raise HTTPException(status_code=403, detail=f"Missing '{action}' permission for this page.")
        return current_user
    return _guard
