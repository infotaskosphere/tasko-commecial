"""Strict action-level authorization for Finix edit/delete operations.

The Permission Matrix action rows are the source of truth for non-admin users.
Legacy page visibility or broad manage flags alone must not implicitly grant
edit/delete. Existing route-level module/license checks remain in place and
continue to enforce licensed feature and tenant boundaries.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from backend.accounting_ai.finix_access import permissions_dict, role_key


def has_finix_action_permission(user: Any, page_flag: str, action: str) -> bool:
    """Return whether a user may perform one action on a Finix page.

    Admins have full access inside the tenant/company boundary already enforced
    by the endpoint's existing authentication and company-scope dependencies.
    Non-admins must have the page enabled AND the exact action in
    governance_matrix["finix.<page_flag>"]. Missing rows fail closed.
    """
    normalized_action = str(action or "").strip().lower()
    if normalized_action not in {"edit", "delete"}:
        return False

    # The software owner is not a licensee and retains platform-owner control.
    # Licensee admins, however, remain capped by the Platform Owner's licensed
    # module/page selection even though they have full actions inside that page.
    try:
        from backend.platform_owner import is_platform_owner
        if is_platform_owner(user):
            return True
    except Exception:
        pass

    permissions = permissions_dict(user)
    is_admin = role_key(user) == "admin"
    if not is_admin and permissions.get("can_access_finix") is not True:
        return False

    # Reuse canonical page/licensing governance. Import locally to avoid
    # creating a module import cycle during route registration. This is also
    # required for licensee admins so admin status cannot bypass the license cap.
    try:
        from backend.governance_core import has_page_access, _admin_bypass
        if not _admin_bypass(user) and not has_page_access(user, "finix", page_flag):
            return False
    except Exception:
        # Internal admins do not carry commercial page flags; only their
        # established internal admin status or platform-owner identity bypasses.
        if is_admin and not getattr(user, "company_id", None):
            return True
        return False

    if is_admin:
        return True

    matrix = permissions.get("governance_matrix")
    if not isinstance(matrix, dict):
        return False

    actions = matrix.get(f"finix.{page_flag}")
    if not isinstance(actions, (list, tuple, set)):
        return False

    normalized = {str(value or "").strip().lower() for value in actions}
    return normalized_action in normalized


def require_finix_action(user: Any, page_flag: str, action: str) -> None:
    """Raise HTTP 403 unless the requested Finix edit/delete is authorized."""
    if not has_finix_action_permission(user, page_flag, action):
        label = "edit" if action == "edit" else "delete"
        raise HTTPException(
            status_code=403,
            detail=(
                f"Finix {label} permission is required for this page. "
                "Ask your admin to grant this action in Permission Matrix."
            ),
        )
