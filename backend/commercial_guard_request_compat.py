"""Compatibility fix for the commercial entitlement guard.

The original commercial guard annotated its Request parameter from FastAPI.
On the deployed FastAPI/Pydantic combination that parameter was being treated
as a required query parameter, so otherwise valid authenticated GET requests
returned 422 before reaching the endpoint.  Keep the same licensing checks but
use Starlette's Request type explicitly and replace the problematic wrapper
before the application imports its route modules.
"""

from fastapi import Depends, HTTPException
from starlette.requests import Request

from backend import dependencies as _dependencies
from backend import commercial_module_guard as _guard
from backend.models import User


# The module guard has already captured the admin-permission-aware original
# authentication dependency. Reuse it so SaaS sessions and legacy JWTs behave
# exactly as before.
_original_get_current_user = _guard._original_get_current_user


async def get_current_user_with_commercial_guard_compat(
    request: Request,
    credentials=Depends(_dependencies.security),
) -> User:
    user = await _original_get_current_user(credentials)

    if await _guard._is_commercial_account(user):
        module = _guard.module_for_path(request.url.path)
        if module and not _guard.has_module_access(user, module):
            raise HTTPException(
                status_code=403,
                detail=f"This company license does not include the {module} module.",
            )

        feature = _guard.feature_for_path(request.url.path)
        if feature:
            feature_module, feature_flag = feature
            if (
                not _guard.has_module_access(user, feature_module)
                or not _guard._permission_flag(user, feature_flag)
            ):
                raise HTTPException(
                    status_code=403,
                    detail=f"This company license does not include the {feature_flag} feature.",
                )

    return user


def install() -> None:
    _dependencies.get_current_user = get_current_user_with_commercial_guard_compat
