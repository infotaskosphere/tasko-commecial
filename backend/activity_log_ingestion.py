"""Tenant-safe ingestion endpoint for the browser activity tracker.

Activity telemetry is shared infrastructure, while reads of staff activity remain
behind the commercial module/page permission guard. Platform Owner telemetry is
stored separately from licensee operational data.
"""
import logging
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Body, Depends, HTTPException, Request

import backend.dependencies as _dependencies
from backend.dependencies import db, _raw_db, _resolve_licensed_company_id
from backend.models import User
from backend.platform_owner import is_platform_owner
from backend.tenant_runtime import (
    authenticated_company_id,
    in_platform_owner_context,
    platform_owner_company_ids,
)

logger = logging.getLogger(__name__)
router = APIRouter()


async def _call_auth_dependency(request: Request, credentials):
    """Call the live auth dependency with the parameters it actually declares.

    Several compatibility layers transplant code into ``get_current_user``; the
    final public dependency is request-aware ``(request, credentials)``, while
    older inner layers take ``(credentials)``. Passing arguments by the declared
    positional count keeps the bearer token in ``credentials`` whichever shape
    is installed.
    """
    auth = _dependencies.get_current_user
    if auth.__code__.co_argcount >= 2:
        return await auth(request, credentials)
    return await auth(credentials)


async def _activity_current_user(request: Request):
    """Use the same final Request-aware authentication chain as other routes.

    HTTPBearer is resolved explicitly because this endpoint needs the Request for
    diagnostics; the auth dependency is then called by parameter name.
    """
    authorization = str(request.headers.get("authorization") or "").strip()
    scheme, _, supplied_token = authorization.partition(" ")
    logger.debug(
        "Activity auth dependency entered: path=%s authorization_present=%s bearer_scheme=%s bearer_token_present=%s",
        request.url.path,
        bool(authorization),
        scheme.lower() == "bearer",
        bool(supplied_token.strip()) if scheme.lower() == "bearer" else False,
    )
    try:
        credentials = await _dependencies.security(request)
        user = await _call_auth_dependency(request, credentials)
    except HTTPException as exc:
        logger.warning(
            "Activity logger authentication rejected: status=%s detail=%s "
            "path=%s owner_context=%s authenticated_company_id=%s owner_company_ids=%s",
            exc.status_code,
            str(exc.detail)[:180],
            request.url.path,
            in_platform_owner_context(),
            authenticated_company_id(),
            sorted(platform_owner_company_ids()),
        )
        raise

    owner_identity = is_platform_owner(user)
    owner_context = in_platform_owner_context()
    logger.info(
        "Activity auth resolved: user_id=%s role=%s owner_identity=%s owner_context=%s "
        "authenticated_company_id=%s owner_company_ids=%s",
        str(getattr(user, "id", "") or ""),
        str(getattr(user, "role", "") or ""),
        owner_identity,
        owner_context,
        authenticated_company_id(),
        sorted(platform_owner_company_ids()),
    )
    if owner_identity != owner_context:
        logger.warning(
            "Activity logger identity/context mismatch: user_id=%s role=%s "
            "owner_identity=%s owner_context=%s authenticated_company_id=%s owner_company_ids=%s",
            str(getattr(user, "id", "") or ""),
            str(getattr(user, "role", "") or ""),
            owner_identity,
            owner_context,
            authenticated_company_id(),
            sorted(platform_owner_company_ids()),
        )
    return user


@router.post("/activity/log")
async def log_browser_activity(
    payload: dict = Body(...),
    current_user: User = Depends(_activity_current_user),
):
    actor_id = str(getattr(current_user, "id", "") or "").strip()
    if not actor_id:
        raise HTTPException(status_code=401, detail="Authenticated user identity is missing")

    raw_url = str(payload.get("url") or "").strip()
    safe_url = ""
    if raw_url:
        try:
            parts = urlsplit(raw_url)
            safe_url = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
        except Exception:
            safe_url = ""

    try:
        duration_seconds = int(payload.get("duration_seconds") or 0)
    except (TypeError, ValueError):
        duration_seconds = 0
    duration_seconds = max(0, min(duration_seconds, 300))

    entry = {
        "id": str(uuid.uuid4()),
        "user_id": actor_id,
        "user_email": str(getattr(current_user, "email", "") or ""),
        "app_name": str(payload.get("app_name") or "Taskosphere Web")[:120],
        "window_title": str(payload.get("window_title") or "")[:200],
        "url": safe_url[:2048],
        "category": str(payload.get("category") or "productivity")[:80],
        "duration_seconds": duration_seconds,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    owner_identity = is_platform_owner(current_user)
    owner_context = in_platform_owner_context()
    if owner_identity or owner_context:
        if owner_context and not owner_identity:
            logger.debug(
                "Using authenticated Platform Owner request context for activity telemetry "
                "after user projection (user_id=%s)",
                actor_id,
            )
        entry["identity_type"] = "platform_owner"
        try:
            await _raw_db.platform_activity_logs.insert_one(entry)
        except HTTPException as exc:
            logger.warning(
                "Platform Owner activity telemetry write rejected: user_id=%s status=%s detail=%s",
                actor_id, exc.status_code, str(exc.detail)[:180],
            )
            raise
        return {"success": True, "stored": True}

    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        try:
            resolved_company_id = await _resolve_licensed_company_id(current_user)
            company_id = str(resolved_company_id or "").strip()
        except Exception:
            logger.exception(
                "Activity ingestion could not resolve company for user_id=%s",
                actor_id,
            )
            company_id = ""

    if not company_id:
        logger.warning(
            "Activity ingestion denied: authenticated non-owner has no uniquely linked company "
            "(user_id=%s, license_id=%s, customer_id=%s)",
            actor_id,
            getattr(current_user, "license_id", None),
            getattr(current_user, "commercial_customer_id", None),
        )
        raise HTTPException(
            status_code=403,
            detail="Authenticated licensee user is not associated with a uniquely linked company",
        )

    entry["company_id"] = company_id
    entry["identity_type"] = "licensee"
    try:
        await db.activity_logs.insert_one(entry)
    except HTTPException as exc:
        logger.warning(
            "Licensee activity telemetry write rejected: user_id=%s company_id=%s status=%s detail=%s",
            actor_id, company_id, exc.status_code, str(exc.detail)[:180],
        )
        raise
    return {"success": True, "stored": True}
