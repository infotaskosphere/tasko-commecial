"""Final authentication compatibility boundary for commercial accounts.

Keeps the Starlette Request fix, preserves license entitlement checks, and
keeps the Commercial Control Plane Platform Owner-only. Also recovers legacy
JWT users whose old records do not contain company_id when their explicit
license/customer linkage resolves to exactly one legal company.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import Depends, HTTPException
from starlette.requests import Request

from backend import dependencies as _dependencies
from backend import commercial_module_guard as _guard
from backend import commercial_control_plane_guard as _control_plane
from backend.models import User
from backend.platform_owner import is_platform_owner, platform_owner_emails
from backend.tenant_runtime import TenantAwareCollection, set_authenticated_company, set_platform_owner

logger = logging.getLogger("commercial_guard_request_compat")
_original_get_current_user = _guard._original_get_current_user


_SINGLE_DEVICE_LOGIN_MESSAGE = (
    "You are already logged in on another device. "
    "Please log out from that device and then log in again."
)
_ORIGINAL_TENANT_COLLECTION_UPDATE_ONE = TenantAwareCollection.update_one


async def _single_device_session_update_one(self, query, update, *args, **kwargs):
    """Prevent commercial SaaS logins from replacing an existing device session.

    `_create_saas_session()` historically marked the old session as `replaced`
    before inserting the new one. Intercept only that exact replacement write,
    before it reaches Mongo, so a second device is rejected and the first device
    remains active. Platform Owner is exempt and is allowed to keep multiple
    active SaaS sessions.
    """
    if self._name == "sessions" and isinstance(update, dict):
        values = update.get("$set") or {}
        if values.get("status") == "replaced" and values.get("revoked_reason") == "new_login":
            try:
                existing = await self._collection.find_one(query)
            except Exception:
                logger.exception("Unable to inspect an existing SaaS session during login.")
                raise HTTPException(
                    status_code=503,
                    detail="Unable to verify your current login session. Please try again.",
                )

            if existing and existing.get("status") == "active":
                expires_at = existing.get("expires_at")
                if expires_at:
                    if isinstance(expires_at, str):
                        try:
                            expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                        except Exception:
                            expires_at = None
                    if expires_at and expires_at.tzinfo is None:
                        expires_at = expires_at.replace(tzinfo=timezone.utc)
                    if expires_at and expires_at <= datetime.now(timezone.utc):
                        expires_at = None

                # An unexpired active session belongs to a currently signed-in
                # device. Resolve its user directly from raw Mongo and exempt
                # only the configured Platform Owner identity.
                if expires_at is not None:
                    raw_db = _raw_db()
                    user_id = existing.get("user_id")
                    user_document = await raw_db.users.find_one({"_id": user_id})
                    if not user_document and user_id is not None:
                        user_document = await raw_db.users.find_one({"id": str(user_id)})
                    email = str((user_document or {}).get("email") or "").strip().lower()
                    if email not in platform_owner_emails():
                        raise HTTPException(status_code=403, detail=_SINGLE_DEVICE_LOGIN_MESSAGE)
                    # Platform Owner: deliberately do not mark the previous
                    # session replaced; the following insert creates another
                    # active session, preserving multi-device access.
                    class _NoOpResult:
                        modified_count = 0
                    return _NoOpResult()

    return await _ORIGINAL_TENANT_COLLECTION_UPDATE_ONE(self, query, update, *args, **kwargs)


TenantAwareCollection.update_one = _single_device_session_update_one


def _raw_db():
    return getattr(_dependencies, "_raw_db", _dependencies.db)


def _normalise_user_document(document: dict) -> User:
    data = dict(document or {})
    data.pop("_id", None)
    for key, value in list(data.items()):
        if value == "":
            data[key] = None
    return User(**_dependencies._normalize_permissions(data))


async def _recover_jwt_user(credentials) -> User:
    token = credentials.credentials
    unauthorized = HTTPException(status_code=401, detail="Could not validate credentials", headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = _dependencies.jwt.decode(token, _dependencies.JWT_SECRET, algorithms=[_dependencies.ALGORITHM])
        user_id = payload.get("sub")
        if user_id is None:
            raise unauthorized
    except _dependencies.JWTError:
        raise unauthorized

    raw_db = _raw_db()
    document = await raw_db.users.find_one({"id": user_id})
    if document is None:
        raise HTTPException(status_code=401, detail="User not found")

    # Keep the legacy commercial linkage from the raw Mongo document. The
    # User Pydantic model intentionally ignores unknown fields, so reading
    # license_id/commercial_customer_id after constructing User would erase
    # the very linkage needed to recover company_id.
    legacy_license_id = str(document.get("license_id") or "").strip()
    legacy_customer_id = str(document.get("commercial_customer_id") or "").strip()
    raw_company_id = str(document.get("company_id") or "").strip()

    user = _normalise_user_document(document)

    if is_platform_owner(user):
        set_platform_owner(True)
        company_id = raw_company_id
        if company_id:
            set_authenticated_company(company_id)
        return user

    company_id = raw_company_id
    if not company_id and legacy_license_id:
        candidates = await raw_db.companies.find(
            {"license_id": legacy_license_id, "status": {"$ne": "inactive"}},
            {"_id": 0, "id": 1},
        ).to_list(20)
        if len(candidates) == 1:
            company_id = str(candidates[0].get("id") or "").strip()

    if not company_id and legacy_customer_id:
        candidates = await raw_db.companies.find(
            {"commercial_customer_id": legacy_customer_id, "status": {"$ne": "inactive"}},
            {"_id": 0, "id": 1},
        ).to_list(20)
        if len(candidates) == 1:
            company_id = str(candidates[0].get("id") or "").strip()

    if not company_id:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")

    data = user.model_dump()
    data["company_id"] = company_id
    user = User.model_validate(data)
    set_authenticated_company(company_id)
    set_platform_owner(False)
    return user


async def get_current_user_with_commercial_guard_compat(
    request: Request,
    credentials=Depends(_dependencies.security),
) -> User:
    try:
        user = await _original_get_current_user(credentials)
    except HTTPException as error:
        if error.status_code != 403 or error.detail != "Authenticated user is not associated with a company":
            raise
        user = await _recover_jwt_user(credentials)

    if is_platform_owner(user):
        set_platform_owner(True)
        company_id = str(getattr(user, "company_id", "") or "").strip()
        if company_id:
            set_authenticated_company(company_id)
        return user

    if _control_plane._is_control_plane_path(request.url.path):
        raise HTTPException(status_code=403, detail="Commercial Console access is restricted to the Platform Owner.")

    if await _guard._is_commercial_account(user):
        module = _guard.module_for_path(request.url.path)
        if module and not _guard.has_module_access(user, module):
            raise HTTPException(status_code=403, detail=f"This company license does not include the {module} module.")
        feature = _guard.feature_for_path(request.url.path)
        if feature:
            feature_module, feature_flag = feature
            if not _guard.has_module_access(user, feature_module) or not _guard._permission_flag(user, feature_flag):
                raise HTTPException(status_code=403, detail=f"This company license does not include the {feature_flag} feature.")

    return user


def install() -> None:
    _dependencies.get_current_user = get_current_user_with_commercial_guard_compat
