"""
Governance Core — the centralized permission architecture used by every
module. Commercial licenses add a tenant-level entitlement cap above the
existing MODULE → PAGE → ACTION → VISIBILITY hierarchy.

Internal/system admins retain the historical full-access bypass. Commercial
customer admins are subject to the same module/page entitlement boundary as
other commercial users.
"""

from typing import Any, Dict, List, Optional

from fastapi import Depends, HTTPException

from backend.dependencies import get_current_user, get_user_permissions
from backend.models import User
from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

_MODULE_FLAGS = {
    key: definition["flag"]
    for key, definition in MODULE_HIERARCHY.items()
    if key != "admin"
}


def _is_commercial_admin(user: User) -> bool:
    return str(getattr(user, "role", "")).lower() == "admin" and bool(getattr(user, "company_id", None))


def _admin_bypass(user: User) -> bool:
    """Only internal/platform admins bypass per-page governance."""
    return str(getattr(user, "role", "")).lower() == "admin" and not _is_commercial_admin(user)

_LICENSE_MODULE_ALIASES = {
    "tasks": "taskosphere", "taskosphere": "taskosphere",
    "invoicing": "finix", "accounting": "finix", "finix": "finix",
    "hrms": "people_matrix", "people_matrix": "people_matrix", "people-matrix": "people_matrix",
    "compliance": "compliance", "records": "records",
    "proposals": "proposals", "client_proposals": "proposals", "client-proposals": "proposals",
    "aiweave": "aiweave", "ai-weave": "aiweave",
}


def _commercial_license_allows(user: User, module_key: str) -> bool:
    if not (
        getattr(user, "company_id", None)
        or getattr(user, "license_id", None)
        or getattr(user, "commercial_customer_id", None)
        or getattr(user, "licensed_modules", None)
    ):
        return True
    if module_key == "admin":
        return getattr(user, "role", None) == "admin"
    raw = getattr(user, "licensed_modules", None) or []
    if not raw:
        return False
    resolved = {
        _LICENSE_MODULE_ALIASES.get(
            str(value).strip().lower().replace("-", "_"),
            str(value).strip().lower().replace("-", "_"),
        )
        for value in raw
    }
    return module_key in resolved


# =============================================================================
# 1. MODULE ACCESS
# =============================================================================

def has_module_access(user: User, module_key: str) -> bool:
    # Platform Owner is outside commercial license/module enforcement.
    if _admin_bypass(user):
        return True
    if module_key == "aiweave":
        perms = get_user_permissions(user)
        return bool(
            perms.get("can_access_aiweave", False)
            and perms.get("can_view_aiweave", False)
        )
    if _admin_bypass(user):
        return True
    if module_key == "admin":
        return getattr(user, "role", None) == "admin"

    if not _commercial_license_allows(user, module_key):
        return False

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
    if module_key == "aiweave":
        if page_flag != "can_view_aiweave":
            return False
        return has_module_access(user, module_key)
    if _admin_bypass(user):
        return True
    if not has_module_access(user, module_key):
        return False
    if not page_flag:
        return False

    # Commercial customer administrators receive every page inside a module
    # that is present on their active commercial license. This mirrors the
    # licensee-admin contract used by the commercial entitlement layer and is
    # important for governed routers whose require_page() dependency captured
    # the base authentication dependency before the runtime entitlement shim
    # was installed. Unlicensed modules still fail at has_module_access().
    if _is_commercial_admin(user):
        return True

    perms = get_user_permissions(user)

    # Backward compatibility: Client Discussion was introduced after the
    # original Lead Management entitlement. The frontend already exposes the
    # discussion page to users who have can_view_all_leads, so the backend page
    # guard must honor the same legacy view entitlement. This grants VIEW only;
    # create/edit/delete remain governed by can_manage_client_discussion.
    if (
        module_key == "proposals"
        and page_flag == "can_view_client_discussion"
        and perms.get("can_view_all_leads") is True
    ):
        return True

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
    # Data visibility remains organization-wide for admins; this is separate
    # from the commercial page entitlement check above.
    if getattr(user, "role", None) == "admin":
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
    if getattr(user, "role", None) == "admin":
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