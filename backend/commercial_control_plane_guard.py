"""Server-side control-plane boundary for licensed customer accounts.

The browser hides Commercial Console navigation, but route/API access must also
be denied if a customer manually enters the URL or calls the endpoint directly.
Platform Owner accounts continue to use the existing commercial APIs normally.
"""

from fastapi import Depends, HTTPException, Request

from backend import dependencies as _dependencies

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
    company_id = str(getattr(user, "company_id", "") or "").strip()
    if company_id and _is_control_plane_path(request.url.path):
        # The Platform Owner is deliberately the only exception. Do not infer
        # platform ownership from role=admin; licensed customer admins also
        # have role=admin and must remain tenant-scoped.
        from backend.platform_owner import is_platform_owner
        if not is_platform_owner(user):
            raise HTTPException(status_code=403, detail="Commercial Console access is restricted to the Platform Owner.")
    return user


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_control_plane_guard":
        _dependencies.get_current_user = get_current_user_with_control_plane_guard
