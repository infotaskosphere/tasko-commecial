"""Compatibility bootstrap for commercial deployments.

Older tenant records can contain role values with different casing or a
partially-populated permissions object.  The authorization system treats
``admin`` as a hard bypass, so normalize the role before the rest of the
backend constructs User models.  For admins, the canonical admin template is
also authoritative so stale/false stored flags cannot accidentally turn an
admin into a restricted user.

This module is intentionally tiny and only patches the Pydantic User
constructor. It does not grant anything to manager/staff users.
"""

from backend.models import DEFAULT_ROLE_PERMISSIONS, User

_original_user_init = User.__init__


def _normalized_user_init(self, **data):
    role = data.get("role", "staff")
    role_value = getattr(role, "value", role)
    if isinstance(role_value, str):
        role_value = role_value.strip().lower()
    data["role"] = role_value

    if role_value == "admin":
        stored = data.get("permissions")
        if hasattr(stored, "model_dump"):
            stored = stored.model_dump()
        elif not isinstance(stored, dict):
            stored = {}
        # Canonical admin permissions win over stale database values.
        data["permissions"] = {
            **stored,
            **DEFAULT_ROLE_PERMISSIONS.get("admin", {}),
        }

    _original_user_init(self, **data)


if getattr(User.__init__, "__name__", "") != "_normalized_user_init":
    User.__init__ = _normalized_user_init
