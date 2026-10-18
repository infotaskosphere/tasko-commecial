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

    if role_key(user) == "admin":
        return True

    permissions = permissions_dict(user)
    if permissions.get("can_access_finix") is not True:
        return False

    # Reuse canonical page/licensing governance. Import locally to avoid
    # creating a module import cycle during route registration.
    try:
        from backend.governance_core import has_page_access
        if not has_page_access(user, "finix", page_flag):
            return False
    except Exception:
        return False

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
