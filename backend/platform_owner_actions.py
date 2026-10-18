"""Edit/delete rule for the Platform Owner (software owner) console.

The console manages the owner's licensees, their licenses and installed
software, packages and console settings. The rule mirrors Finix:

* The Platform Owner's administrator may edit and delete everything here.
* The Platform Owner's managers/staff may edit or delete only what the owner
  administrator granted in Permission Matrix under the
  "Platform Owner Console" module (``governance_matrix["platform_console.<page>"]``).
* Nobody outside the Platform Owner organization (including licensee admins)
  can mutate console records.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from backend.finix_action_permissions import matrix_grants

PLATFORM_CONSOLE_MODULE_ID = "platform_console"

# Rendered in Permission Matrix for the Platform Owner organization only. It
# is intentionally NOT part of MODULE_HIERARCHY: it is not a licensable module
# and must never appear in a licensee's license or permission ceiling.
PLATFORM_CONSOLE_MODULE = {
    "flag": "can_access_platform_console",
    "label": "Platform Owner Console",
    "description": (
        "Licensees, their licenses and installed software, licensee users, "
        "packages and console settings. Owner administrators always have full "
        "access; owner staff need the actions granted here."
    ),
    "pages": [
        {"flag": "can_view_platform_licensees", "label": "Licensees", "actions": ["view", "edit", "delete"]},
        {"flag": "can_view_platform_licenses", "label": "Licenses & Installations", "actions": ["view", "edit", "delete"]},
        {"flag": "can_view_platform_licensee_users", "label": "Licensee Users", "actions": ["view", "edit", "delete"]},
        {"flag": "can_view_platform_packages", "label": "Packages & Pricing", "actions": ["view", "edit", "delete"]},
        {"flag": "can_view_platform_settings", "label": "Console Settings", "actions": ["view", "edit", "delete"]},
    ],
}

PLATFORM_CONSOLE_PAGES = frozenset(page["flag"] for page in PLATFORM_CONSOLE_MODULE["pages"])
_MUTATING_ACTIONS = frozenset({"edit", "delete"})


def platform_console_tree_entry() -> dict:
    return {"module": PLATFORM_CONSOLE_MODULE_ID, **PLATFORM_CONSOLE_MODULE}


def has_platform_owner_action(user: Any, page_flag: str, action: str) -> bool:
    from backend.platform_owner import is_platform_owner, is_platform_owner_admin

    normalized = str(action or "").strip().lower()
    if not user or page_flag not in PLATFORM_CONSOLE_PAGES or normalized not in _MUTATING_ACTIONS:
        return False
    if not is_platform_owner(user):
        return False
    if is_platform_owner_admin(user):
        return True
    return matrix_grants(user, f"{PLATFORM_CONSOLE_MODULE_ID}.{page_flag}", normalized)


def require_platform_owner_action(user: Any, page_flag: str, action: str) -> None:
    if has_platform_owner_action(user, page_flag, action):
        return
    from backend.platform_owner import is_platform_owner

    label = "delete" if str(action).strip().lower() == "delete" else "edit"
    if not is_platform_owner(user):
        detail = "This action is restricted to the Platform Owner."
    else:
        detail = (
            f"Only the Platform Owner admin can {label} here. Ask your admin to grant "
            f"'{label}' for this page under Platform Owner Console in Permission Matrix."
        )
    raise HTTPException(status_code=403, detail=detail)
