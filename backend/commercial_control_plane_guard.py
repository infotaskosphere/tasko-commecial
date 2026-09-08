"""Server-side control-plane boundary for the commercial distribution console.

Commercial Console and its control-plane APIs are Platform Owner features, not
customer-admin features. The browser hides the navigation for non-owners, but
this server-side guard is the authoritative authorization boundary for direct
URL/API access as well.
"""

from fastapi import Depends, HTTPException, Request

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner

CONTROL_PLANE_PREFIXES = (
    "/master-console",
    "/licensing/state",
    "/licensing/licenses",
    "/licensing/packages",
    "/commercial-onboarding/generate-license",
    "/commercial-onboarding/module-catalog",
    "/commercial-onboarding/licenses",
)

_original_get_current_user = _dependencies.get_current_user


def _is_control_plane_path(path: str) -> bool:
    normalized = str(path or "").split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    return any(normalized == prefix or normalized.startswith(prefix + "/") for prefix in CONTROL_PLANE_PREFIXES)


async def get_current_user_with_control_plane_guard(
    request: Request,
    credentials=Depends(_dependencies.security),
):
    user = await _original_get_current_user(request, credentials)
    if _is_control_plane_path(request.url.path) and not is_platform_owner(user):
        # Never infer control-plane access from role=admin. Customer admins and
        # other internal users must remain outside the commercial distribution
        # console. Platform Owner identity is the sole authorization boundary.
        raise HTTPException(status_code=403, detail="Commercial Console access is restricted to the Platform Owner.")
    return user


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_control_plane_guard":
        _dependencies.get_current_user = get_current_user_with_control_plane_guard
