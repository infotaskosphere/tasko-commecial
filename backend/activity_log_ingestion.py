"""Tenant-safe ingestion endpoint for the browser activity tracker.

Activity telemetry is shared infrastructure, while reads of staff activity remain
behind the commercial module/page permission guard. Platform Owner telemetry is
stored separately from licensee operational data.
"""
import logging
import uuid
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Body, Depends, HTTPException

from backend.dependencies import db, get_current_user, _raw_db, _resolve_licensed_company_id
from backend.models import User
from backend.platform_owner import is_platform_owner

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/activity/log")
async def log_browser_activity(
    payload: dict = Body(...),
    current_user: User = Depends(get_current_user),
):
    actor_id = str(getattr(current_user, "id", "") or "").strip()
    if not actor_id:
        raise HTTPException(status_code=401, detail="Authenticated user identity is missing")

    raw_url = str(payload.get("url") or "").strip()
    safe_url = ""
    if raw_url:
        try:
            parts = urlsplit(raw_url)
            # Query strings and fragments can contain session or customer data.
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

    if is_platform_owner(current_user):
        # Platform Owner has no default customer company by design. Never
        # invent or borrow a licensee company_id to satisfy tenant guards.
        entry["identity_type"] = "platform_owner"
        await _raw_db.platform_activity_logs.insert_one(entry)
        return {"success": True, "stored": True}

    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        # Some legacy SaaS-session identities have a license/customer link but
        # lack company_id on the session user. Resolve only a unique company
        # linked explicitly to that identity; never infer from another tenant.
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
    await db.activity_logs.insert_one(entry)
    return {"success": True, "stored": True}
