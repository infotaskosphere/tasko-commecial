"""Per-organisation Google Drive connection ("Connect Google Drive" in Settings).

Every licensee connects its OWN Google account. On first connect a "OneNexa"
folder is created in that Drive with Invoices / Payments / Credit Notes /
Backups / Clients subfolders; invoicing and the client portal then save to
and read from those folders (see google_drive_service._drive_scope).

Flow (two clicks for the admin):
  1. POST /api/integrations/google-drive/connect  -> {"auth_url": ...}
     The browser goes to Google, the admin picks an account and clicks Allow.
  2. Google redirects to the registered GET /auth/google/callback with a
     one-time ``state`` (prefix ``drv.``) saved here with the company and user
     that started the flow. Only then is the token stored, encrypted, for
     that company.

The Drive scope is ``drive.file``: the app can only see files and folders it
created, never the rest of the customer's Drive.
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse

from backend.dependencies import get_current_user
from backend.google_drive_service import (
    COMPANY_DRIVE_COLLECTION,
    COMPANY_DRIVE_SCOPES,
    build_company_drive_service,
    encrypt_drive_token,
    invalidate_company_drive,
)
from backend.platform_owner import is_platform_owner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/integrations/google-drive", tags=["Google Drive (per organisation)"])

STATE_COLLECTION = "company_drive_oauth_states"
STATE_PREFIX = "drv."
STATE_TTL = timedelta(minutes=10)
DEFAULT_RETURN_PATH = "/settings/general"
ROOT_FOLDER_NAME = "OneNexa"
SUBFOLDERS = {
    "invoices": "Invoices",
    "payments": "Payments",
    "credit_notes": "Credit Notes",
    "backups": "Backups",
    "clients": "Clients",
}
FOLDER_MIME = "application/vnd.google-apps.folder"


def _raw():
    from backend.dependencies import _raw_db

    return _raw_db


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            return None
    return None


def _company_id(user) -> str:
    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="Your account is not attached to an organisation.")
    return company_id


def _can_manage(user) -> bool:
    role = getattr(user, "role", "")
    return is_platform_owner(user) or str(getattr(role, "value", role)).lower() == "admin"


def _require_manager(user) -> None:
    if not _can_manage(user):
        raise HTTPException(status_code=403, detail="Only an administrator can connect or disconnect Google Drive.")


def _google_client() -> tuple[str, str]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured on this server yet.")
    return client_id, client_secret


def _redirect_uri() -> str:
    from backend.google_auth import REDIRECT_URI

    return REDIRECT_URI


def _flow(state: Optional[str] = None):
    from google_auth_oauthlib.flow import Flow

    client_id, client_secret = _google_client()
    return Flow.from_client_config(
        {
            "web": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=COMPANY_DRIVE_SCOPES,
        redirect_uri=_redirect_uri(),
        state=state,
    )


def _allowed_origins() -> set[str]:
    origins = set()
    try:
        from backend.server_modules.routes.application_runtime import CORS_ALLOWED_ORIGINS

        origins.update(str(o).rstrip("/") for o in CORS_ALLOWED_ORIGINS)
    except Exception:
        pass
    frontend = (os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    if frontend:
        origins.add(frontend)
    return origins


def _safe_return_url(candidate: Optional[str]) -> str:
    """Absolute URL back into one of our own frontends; never an arbitrary site."""
    frontend = (os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    fallback = f"{frontend}{DEFAULT_RETURN_PATH}" if frontend else DEFAULT_RETURN_PATH
    if not candidate:
        return fallback
    parsed = urlparse(str(candidate))
    if not parsed.scheme or not parsed.netloc:
        path = str(candidate)
        if path.startswith("/") and not path.startswith("//"):
            return f"{frontend}{path}" if frontend else path
        return fallback
    origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
    if origin not in _allowed_origins():
        return fallback
    path = parsed.path or DEFAULT_RETURN_PATH
    return f"{origin}{path}" + (f"?{parsed.query}" if parsed.query else "")


def _with_result(url: str, result: str, reason: Optional[str] = None) -> RedirectResponse:
    from urllib.parse import parse_qsl, urlunparse

    parsed = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(parsed.query, keep_blank_values=True) if k not in {"drive", "reason"}]
    query.append(("drive", result))
    if reason:
        query.append(("reason", reason[:120]))
    return RedirectResponse(urlunparse(parsed._replace(query=urlencode(query))), status_code=302)


def _public(connection: Optional[dict], user) -> Dict[str, Any]:
    connection = connection or {}
    connected = connection.get("status") == "connected"
    root = (connection.get("folders") or {}).get("root")
    return {
        "connected": connected,
        "source": "organisation" if connected else "none",
        "google_email": connection.get("google_email") if connected else None,
        "google_name": connection.get("google_name") if connected else None,
        "connected_at": connection.get("connected_at") if connected else None,
        "folder_url": f"https://drive.google.com/drive/folders/{root}" if connected and root else None,
        "can_manage": _can_manage(user),
        "configured": bool((os.getenv("GOOGLE_CLIENT_ID") or "").strip() and (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()),
    }


async def get_connection(company_id: str) -> Optional[dict]:
    return await _raw()[COMPANY_DRIVE_COLLECTION].find_one({"company_id": company_id}, {"_id": 0})


# ── Drive folder setup (sync; run in a worker thread) ──────────────────────────

def _folder_ok(service, folder_id: Optional[str]) -> bool:
    if not folder_id:
        return False
    try:
        meta = service.files().get(fileId=folder_id, fields="id,trashed,mimeType").execute()
        return meta.get("mimeType") == FOLDER_MIME and not meta.get("trashed")
    except Exception:
        return False


def _create_folder(service, name: str, parent: Optional[str] = None) -> str:
    body: Dict[str, Any] = {"name": name, "mimeType": FOLDER_MIME}
    if parent:
        body["parents"] = [parent]
    return service.files().create(body=body, fields="id").execute()["id"]


def ensure_company_folders(service, existing: Optional[dict] = None, company_name: Optional[str] = None) -> dict:
    """Create (or reuse) the OneNexa folder tree in the organisation's Drive."""
    folders = dict(existing or {})
    if not _folder_ok(service, folders.get("root")):
        root_name = f"{ROOT_FOLDER_NAME} – {company_name}" if company_name else ROOT_FOLDER_NAME
        folders = {"root": _create_folder(service, root_name)}
    for key, label in SUBFOLDERS.items():
        if not _folder_ok(service, folders.get(key)):
            folders[key] = _create_folder(service, label, folders["root"])
    return folders


def _account_profile(service) -> dict:
    about = service.about().get(fields="user(emailAddress,displayName)").execute()
    user = about.get("user") or {}
    return {"email": str(user.get("emailAddress") or "").strip().lower(), "name": user.get("displayName")}


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.get("/status")
async def drive_status(current_user=Depends(get_current_user)):
    connection = await get_connection(_company_id(current_user))
    return _public(connection, current_user)


@router.post("/connect")
async def drive_connect(
    request: Request,
    payload: Optional[Dict[str, Any]] = Body(default=None),
    current_user=Depends(get_current_user),
):
    """Start "Connect Google Drive": returns the Google sign-in URL."""
    _require_manager(current_user)
    company_id = _company_id(current_user)
    state = STATE_PREFIX + secrets.token_urlsafe(32)
    return_url = _safe_return_url((payload or {}).get("return_url"))
    flow = _flow(state=state)
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        prompt="consent select_account",
        include_granted_scopes="false",
        state=state,
    )
    now = _now()
    await _raw()[STATE_COLLECTION].insert_one({
        "state": state,
        "company_id": company_id,
        "user_id": str(getattr(current_user, "id", "") or ""),
        "return_url": return_url,
        "code_verifier": getattr(flow, "code_verifier", None),
        "created_at": now,
        "expires_at": now + STATE_TTL,
    })
    return {"auth_url": auth_url}


@router.post("/disconnect")
async def drive_disconnect(current_user=Depends(get_current_user)):
    _require_manager(current_user)
    company_id = _company_id(current_user)
    connection = await get_connection(company_id)
    if connection and connection.get("refresh_token_enc"):
        try:
            from backend.google_drive_service import decrypt_drive_token

            token = decrypt_drive_token(connection["refresh_token_enc"])
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post("https://oauth2.googleapis.com/revoke", data={"token": token})
        except Exception:
            logger.warning("Google token revoke failed for company %s (token removed locally anyway)", company_id)
    await _raw()[COMPANY_DRIVE_COLLECTION].update_one(
        {"company_id": company_id},
        {"$set": {"status": "disconnected", "disconnected_at": _now().isoformat(),
                  "disconnected_by": str(getattr(current_user, "id", "") or "")},
         "$unset": {"refresh_token_enc": ""}},
    )
    invalidate_company_drive(company_id)
    return {"ok": True, "message": "Google Drive disconnected."}


async def handle_oauth_callback(request: Request) -> RedirectResponse:
    """Second half of the flow, called from GET /auth/google/callback."""
    params = request.query_params
    state = str(params.get("state") or "")
    frontend = (os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    return_url = f"{frontend}{DEFAULT_RETURN_PATH}" if frontend else DEFAULT_RETURN_PATH

    state_doc = await _raw()[STATE_COLLECTION].find_one_and_delete({"state": state}) if state else None
    expires_at = _aware((state_doc or {}).get("expires_at"))
    if not state_doc or not expires_at or expires_at <= _now():
        return _with_result(return_url, "error", "This connection link expired. Click Connect Google Drive again.")
    return_url = state_doc.get("return_url") or return_url
    if params.get("error"):
        return _with_result(return_url, "denied")
    code = params.get("code")
    if not code:
        return _with_result(return_url, "error", "Google did not return an authorisation code.")

    company_id = str(state_doc["company_id"])
    from backend.tenant_runtime import reset_authenticated_company, set_authenticated_company

    company_token = set_authenticated_company(company_id)
    try:
        flow = _flow(state=state)
        if state_doc.get("code_verifier"):
            flow.code_verifier = state_doc["code_verifier"]
        await asyncio.to_thread(flow.fetch_token, code=code)
        refresh_token = flow.credentials.refresh_token
        if not refresh_token:
            return _with_result(return_url, "error", "no_refresh_token")

        service = build_company_drive_service(refresh_token)
        profile = await asyncio.to_thread(_account_profile, service)
        existing = await get_connection(company_id) or {}
        same_account = existing.get("google_email") and existing.get("google_email") == profile["email"]
        company = await _raw().companies.find_one({"id": company_id}, {"_id": 0, "name": 1, "company_name": 1}) or {}
        folders = await asyncio.to_thread(
            ensure_company_folders,
            service,
            existing.get("folders") if same_account else None,
            company.get("name") or company.get("company_name"),
        )
        now_iso = _now().isoformat()
        await _raw()[COMPANY_DRIVE_COLLECTION].update_one(
            {"company_id": company_id},
            {"$set": {
                "company_id": company_id,
                "status": "connected",
                "provider": "google",
                "google_email": profile["email"],
                "google_name": profile.get("name"),
                "refresh_token_enc": encrypt_drive_token(refresh_token),
                "scopes": list(COMPANY_DRIVE_SCOPES),
                "folders": folders,
                "connected_by": state_doc.get("user_id"),
                "connected_at": now_iso,
                "updated_at": now_iso,
            }},
            upsert=True,
        )
        invalidate_company_drive(company_id)
        logger.info("Google Drive connected for company %s (%s)", company_id, profile["email"])
        return _with_result(return_url, "connected")
    except HTTPException as exc:
        return _with_result(return_url, "error", str(exc.detail))
    except Exception:
        logger.exception("Google Drive connection failed for company %s", company_id)
        return _with_result(return_url, "error", "Google Drive could not be connected. Please try again.")
    finally:
        reset_authenticated_company(company_token)


async def create_company_drive_indexes() -> None:
    raw = _raw()
    try:
        await raw[COMPANY_DRIVE_COLLECTION].create_index("company_id", unique=True)
        await raw[STATE_COLLECTION].create_index("state", unique=True)
        await raw[STATE_COLLECTION].create_index("expires_at", expireAfterSeconds=0)
    except Exception as exc:
        logger.warning("Company Drive index creation skipped: %s", exc)
