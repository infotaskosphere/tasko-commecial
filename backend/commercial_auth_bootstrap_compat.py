"""Raw-database authentication boundary for commercial accounts.

The users collection is tenant-scoped after authentication. Authentication
itself must resolve the user before a tenant/company context exists, otherwise
the user-scope wrapper rejects /auth/me with HTTP 403. This shim keeps the
initial identity lookup on the raw database and leaves all later tenant and
license entitlement guards unchanged.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException
from jwt import InvalidTokenError

from backend import dependencies as _dependencies
from backend.models import User
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import set_authenticated_company, set_platform_owner


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def _normalise_user(document: dict, user_id: str) -> User:
    data = dict(document or {})
    data.pop("_id", None)
    if not data.get("id"):
        data["id"] = str(user_id)
    for key, value in list(data.items()):
        if value == "":
            data[key] = None
    return User(**_dependencies._normalize_permissions(data))


async def _raw_get_current_user(credentials=Depends(_dependencies.security)) -> User:
    unauthorized = HTTPException(
        status_code=401,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    # HTTPBearer(auto_error=False) deliberately returns None when the
    # Authorization header is absent. After logout, components may still have
    # in-flight/background requests. Treat missing or empty bearer credentials
    # as an ordinary 401 here; dereferencing credentials.credentials would turn
    # that expected unauthenticated request into an unhandled 500.
    token = getattr(credentials, "credentials", None)
    if not isinstance(token, str) or not token.strip():
        raise unauthorized
    token = token.strip()

    # Preserve the existing opaque SaaS session path, but do not skip the
    # canonical company-scope resolver. This compatibility module replaces
    # dependencies.get_current_user before the normal route dependencies are
    # captured. The original dependency canonicalizes Platform Owner companies
    # and builds the request-local owner allow-list; returning here without it
    # leaves owner_company_ids empty and every Finix/accounting request with a
    # stale selected company_id is (correctly) denied by tenant_runtime.
    saas_user = await _dependencies._get_saas_session_user(token)
    if saas_user is not None:
        saas_user = await _dependencies._canonicalize_platform_owner_company(saas_user)
        owner_context = is_platform_owner(saas_user)
        company_id = str(getattr(saas_user, "company_id", "") or "").strip()
        if not company_id:
            raise HTTPException(
                status_code=403,
                detail=(
                    "Platform Owner has no valid operational company context"
                    if owner_context
                    else "Authenticated user is not associated with a company"
                ),
            )
        set_authenticated_company(company_id)
        set_platform_owner(owner_context)
        return saas_user

    try:
        payload = _dependencies.jwt.decode(
            token,
            _dependencies.JWT_SECRET,
            algorithms=[_dependencies.ALGORITHM],
        )
        user_id = payload.get("sub")
        if user_id is None:
            raise unauthorized
    except InvalidTokenError:
        raise unauthorized

    raw_db = _raw_db()
    user_query = {"id": user_id}
    if _dependencies.ObjectId.is_valid(str(user_id)):
        user_query = {
            "$or": [
                {"id": str(user_id)},
                {"_id": _dependencies.ObjectId(str(user_id))},
            ]
        }

    # IMPORTANT: do not use dependencies.db here. It is a TenantAwareDatabase
    # whose users collection requires authenticated_company_id, which does not
    # exist yet during authentication.
    document = await raw_db.users.find_one(user_query)
    if document is None:
        raise HTTPException(status_code=401, detail="User not found")

    user = _normalise_user(document, str(user_id))
    if is_platform_owner(user):
        # JWT auth takes the same canonicalization path as opaque SaaS sessions.
        # Without this call, owner JWT requests can still reach tenant_runtime
        # with an empty owner allow-list.
        user = await _dependencies._canonicalize_platform_owner_company(user)
        company_id = str(getattr(user, "company_id", "") or "").strip()
        if not company_id:
            raise HTTPException(
                status_code=403,
                detail="Platform Owner has no valid operational company context",
            )
        set_authenticated_company(company_id)
        set_platform_owner(True)
        return user

    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not company_id:
        company_id = await _dependencies._resolve_licensed_company_id(user) or ""

    if not company_id:
        raise HTTPException(
            status_code=403,
            detail="Authenticated user is not associated with a company",
        )

    data = user.model_dump()
    data["company_id"] = company_id
    user = User.model_validate(data)
    # Match dependencies.get_current_user: non-owner authentication must clear
    # any inherited Platform Owner company/alias scope before the request starts.
    user = await _dependencies._canonicalize_platform_owner_company(user)
    set_authenticated_company(str(getattr(user, "company_id", "") or company_id))
    set_platform_owner(False)
    return user


# Install before commercial_tenant_scope captures get_current_user. All later
# commercial guards therefore build on this raw-authentication boundary.
_dependencies.get_current_user = _raw_get_current_user
