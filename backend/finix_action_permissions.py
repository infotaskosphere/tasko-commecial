"""Single authorization rule for every Finix edit/delete operation.

Rule
----
* An administrator may edit and delete:
    - the Platform Owner's administrator (the software owner), everywhere;
    - a licensee administrator, inside the Finix pages the Platform Owner
      licensed to that licensee;
    - an internal (non-commercial) administrator.
* Everybody else - licensee managers/staff AND the Platform Owner's own
  managers/staff - may edit or delete only when an administrator granted
  that exact action for that page in Permission Matrix
  (``governance_matrix["finix.<page_flag>"]``). Page visibility, legacy
  ``can_manage_*`` flags or belonging to the owner organization never imply
  edit/delete. Missing or malformed rows fail closed.

Route-level authentication, tenant/company scoping and module licensing stay
where they are; this module only decides the edit/delete action itself.
"""
from __future__ import annotations

from typing import Any, Iterable

from fastapi import HTTPException

from backend.accounting_ai.finix_access import permissions_dict, role_key

FINIX_MUTATING_ACTIONS = frozenset({"edit", "delete"})
_FINIX_LICENSE_ALIASES = {"finix", "invoicing", "accounting"}


def _get(user: Any, key: str, default: Any = None) -> Any:
    if isinstance(user, dict):
        return user.get(key, default)
    return getattr(user, key, default)


def _is_commercial_identity(user: Any) -> bool:
    return bool(
        _get(user, "company_id")
        or _get(user, "license_id")
        or _get(user, "commercial_customer_id")
        or _get(user, "licensed_modules")
    )


def matrix_grants(user: Any, matrix_key: str, action: str) -> bool:
    """Whether Permission Matrix explicitly grants ``action`` on ``matrix_key``."""
    matrix = permissions_dict(user).get("governance_matrix")
    if not isinstance(matrix, dict):
        return False
    actions = matrix.get(matrix_key)
    if not isinstance(actions, (list, tuple, set)):
        return False
    wanted = str(action or "").strip().lower()
    return wanted in {str(value or "").strip().lower() for value in actions}


def _license_allows_finix_page(user: Any, page_flag: str) -> bool:
    """The Platform Owner's license is the ceiling for licensee users."""
    if not _is_commercial_identity(user):
        return True
    raw_modules: Iterable[Any] = _get(user, "licensed_modules") or []
    modules = {str(m).strip().lower().replace("-", "_") for m in raw_modules if m}
    if modules and not (modules & _FINIX_LICENSE_ALIASES):
        return False
    selected = _get(user, "selected_features")
    if isinstance(selected, dict):
        for key in ("finix", "accounting", "invoicing"):
            chosen = selected.get(key)
            if isinstance(chosen, (list, tuple, set)):
                return page_flag in {str(flag) for flag in chosen}
    # No license page selection on the identity: fall back to the user's own
    # (license-capped) page flag, which fails closed when absent.
    return permissions_dict(user).get(page_flag) is True


def finix_admin_kind(user: Any) -> str:
    """Classify the caller: ``owner_admin`` | ``admin`` | ``member``."""
    from backend.platform_owner import is_platform_owner, is_platform_owner_admin

    if is_platform_owner(user):
        return "owner_admin" if is_platform_owner_admin(user) else "member"
    return "admin" if role_key(user) == "admin" else "member"


def has_finix_action_permission(user: Any, page_flag: str, action: str) -> bool:
    """Return whether ``user`` may perform ``action`` (edit/delete) on a Finix page."""
    normalized_action = str(action or "").strip().lower()
    if not user or not page_flag or normalized_action not in FINIX_MUTATING_ACTIONS:
        return False

    kind = finix_admin_kind(user)
    if kind == "owner_admin":
        return True

    from backend.platform_owner import is_platform_owner

    owner_member = is_platform_owner(user)
    if kind == "admin":
        # Licensee admins have full actions, but only inside licensed pages.
        return _license_allows_finix_page(user, page_flag)

    # Members (licensee staff/managers and Platform Owner staff/managers).
    permissions = permissions_dict(user)
    if permissions.get("can_access_finix") is not True:
        return False
    if permissions.get(page_flag) is not True:
        return False
    if not owner_member and not _license_allows_finix_page(user, page_flag):
        return False
    return matrix_grants(user, f"finix.{page_flag}", normalized_action)


def require_finix_action(user: Any, page_flag: str, action: str) -> None:
    """Raise HTTP 403 unless the requested Finix edit/delete is authorized."""
    if not has_finix_action_permission(user, page_flag, action):
        label = "delete" if str(action).strip().lower() == "delete" else "edit"
        raise HTTPException(
            status_code=403,
            detail=(
                f"Only an admin can {label} here. Ask your admin to grant "
                f"'{label}' for this page in Permission Matrix."
            ),
        )
