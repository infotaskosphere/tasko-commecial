"""Final authentication compatibility boundary for commercial accounts.

Keeps the Starlette Request fix, preserves license entitlement checks, and
keeps the Commercial Control Plane Platform Owner-only. It deliberately does
not reimplement or bypass the commercial module guard.
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

# Capture the function currently installed by commercial_module_guard. Never
# read a private `_original_get_current_user` attribute from that module: the
# previous deployment failed at import time because that attribute did not
# exist after the guard was replaced.
_BASE_GET_CURRENT_USER = _guard.get_current_user_with_commercial_guard
_ORIGINAL_TENANT_COLLECTION_UPDATE_ONE = TenantAwareCollection.update_one

_SINGLE_DEVICE_LOGIN_MESSAGE = (
    "You are already logged in on another device. "
    "Please log out from that device and then log in again."
)


async def _single_device_session_update_one(self, query, update, *args, **kwargs):
    if self._name == "sessions" and isinstance(update, dict):
        values = update.get("$set") or {}
        if values.get("status") == "replaced" and values.get("revoked_reason") == "new_login":
            try:
                existing = await self._collection.find_one(query)
            except Exception:
                logger.exception("Unable to inspect an existing SaaS session during login.")
                raise HTTPException(status_code=503, detail="Unable to verify your current login session. Please try again.")
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
                if expires_at is not None:
                    raw_db = _raw_db()
                    user_id = existing.get("user_id")
                    user_document = await raw_db.users.find_one({"_id": user_id})
                    if not user_document and user_id is not None:
                        user_document = await raw_db.users.find_one({"id": str(user_id)})
                    email = str((user_document or {}).get("email") or "").strip().lower()
                    if email not in platform_owner_emails():
                        raise HTTPException(status_code=403, detail=_SINGLE_DEVICE_LOGIN_MESSAGE)
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
    legacy_license_id = str(document.get("license_id") or "").strip()
    legacy_customer_id = str(document.get("commercial_customer_id") or "").strip()
    raw_company_id = str(document.get("company_id") or "").strip()
    user = _normalise_user_document(document)
    if is_platform_owner(user):
        set_platform_owner(True)
        if raw_company_id:
            set_authenticated_company(raw_company_id)
        return user

    company_id = raw_company_id
    if not company_id and legacy_license_id:
        candidates = await raw_db.companies.find({"license_id": legacy_license_id, "status": {"$ne": "inactive"}}, {"_id": 0, "id": 1}).to_list(20)
        if len(candidates) == 1:
            company_id = str(candidates[0].get("id") or "").strip()
    if not company_id and legacy_customer_id:
        candidates = await raw_db.companies.find({"commercial_customer_id": legacy_customer_id, "status": {"$ne": "inactive"}}, {"_id": 0, "id": 1}).to_list(20)
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


async def get_current_user_with_commercial_guard_compat(request: Request, credentials=Depends(_dependencies.security)) -> User:
    try:
        user = await _BASE_GET_CURRENT_USER(credentials)
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

    # Module and feature entitlement checks remain in _BASE_GET_CURRENT_USER.
    # Do not add an admin bypass here; that would defeat license caps.
    return user


def install() -> None:
    _dependencies.get_current_user = get_current_user_with_commercial_guard_compat
