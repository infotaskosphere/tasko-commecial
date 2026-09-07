"""Compatibility bootstrap for commercial deployments.

Normalize admin role values and restore the canonical admin permission template,
while preserving the six commercial module entitlement flags when an admin is
attached to a licensed company. Internal/system admins keep the old full-access
behaviour.
"""

from backend.models import DEFAULT_ROLE_PERMISSIONS, User

_original_user_init = User.__init__
_MODULE_FLAGS = (
    "can_access_taskosphere",
    "can_access_finix",
    "can_access_compliance",
    "can_access_records",
    "can_access_proposals",
    "can_access_people_matrix",
)


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

        canonical = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}))
        # A commercial admin is identified by company_id and has the six
        # module flags deliberately restricted by the license generator.
        # Preserve those flags instead of allowing the canonical admin
        # template to turn every module back on during model construction.
        is_commercial_admin = bool(data.get("company_id")) and any(
            flag in stored for flag in _MODULE_FLAGS
        )
        if is_commercial_admin:
            for flag in _MODULE_FLAGS:
                if flag in stored:
                    canonical[flag] = bool(stored[flag])

        data["permissions"] = canonical

    _original_user_init(self, **data)


if getattr(User.__init__, "__name__", "") != "_normalized_user_init":
    User.__init__ = _normalized_user_init
