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


AREA_LABELS = {
    "billing": "Invoices, payments & credit notes",
    "clients": "Client portal & client folders",
    "backups": "Backups",
}


def _connection_public(conn: dict) -> Dict[str, Any]:
    root = (conn.get("folders") or {}).get("root")
    return {
        "id": conn.get("id"),
        "label": conn.get("label") or conn.get("google_email"),
        "google_email": conn.get("google_email"),
        "google_name": conn.get("google_name"),
        "personal": bool(conn.get("owner_user_id")),
        "is_default": bool(conn.get("is_default")) and not conn.get("owner_user_id"),
        "connected_at": conn.get("connected_at"),
        "folder_url": f"https://drive.google.com/drive/folders/{root}" if root else "https://drive.google.com/drive/my-drive",
    }


def _public(connection: Optional[dict], user, *, connections: Optional[list] = None, routes: Optional[dict] = None) -> Dict[str, Any]:
    """Status payload. The top-level fields describe the default organisation Drive."""
    connection = connection or {}
    connected = connection.get("status") == "connected"
    root = (connection.get("folders") or {}).get("root")
    org = [c for c in (connections or []) if not c.get("owner_user_id")]
    mine = [c for c in (connections or []) if c.get("owner_user_id")]
    return {
        "connected": connected,
        "source": "organisation" if connected else "none",
        "google_email": connection.get("google_email") if connected else None,
        "google_name": connection.get("google_name") if connected else None,
        "connected_at": connection.get("connected_at") if connected else None,
        "folder_url": f"https://drive.google.com/drive/folders/{root}" if connected and root else None,
        "default_connection_id": connection.get("id") if connected else None,
        "organisation_drives": [_connection_public(c) for c in org],
        "my_drives": [_connection_public(c) for c in mine],
        "routes": {area: (routes or {}).get(area) for area in AREA_LABELS},
        "areas": AREA_LABELS,
        "can_manage": _can_manage(user),
        "configured": bool((os.getenv("GOOGLE_CLIENT_ID") or "").strip() and (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()),
    }


ROUTES_COLLECTION = "company_drive_routes"


async def list_connections(company_id: str, user_id: Optional[str] = None) -> list[dict]:
    """Connected organisation Drives, plus ``user_id``'s personal Drives."""
    visible = [{"owner_user_id": None}]
    if user_id:
        visible.append({"owner_user_id": user_id})
    return await _raw()[COMPANY_DRIVE_COLLECTION].find(
        {"company_id": company_id, "status": "connected", "$or": visible}, {"_id": 0}
    ).sort("connected_at", 1).to_list(50)


async def get_connection(company_id: str) -> Optional[dict]:
    """The organisation's default Drive connection."""
    org = [c for c in await list_connections(company_id) if not c.get("owner_user_id")]
    return next((c for c in org if c.get("is_default")), None) or (org[0] if org else None)


async def _ensure_org_default(company_id: str) -> None:
    raw = _raw()[COMPANY_DRIVE_COLLECTION]
    live = {"company_id": company_id, "status": "connected", "owner_user_id": None}
    if await raw.find_one({**live, "is_default": True}, {"_id": 1}):
        return
    first = await raw.find_one(live, {"_id": 0, "id": 1}, sort=[("connected_at", 1)])
    if first:
        await raw.update_one({"company_id": company_id, "id": first["id"]}, {"$set": {"is_default": True}})


async def _connection_for_user(company_id: str, connection_id: str, user, *, manage: bool) -> dict:
    """Organisation Drives: anyone may use them; admins manage them. Personal Drives: only their owner."""
    conn = await _raw()[COMPANY_DRIVE_COLLECTION].find_one(
        {"company_id": company_id, "id": connection_id, "status": "connected"}, {"_id": 0})
    if not conn:
        raise HTTPException(status_code=404, detail="Drive connection not found.")
    owner = conn.get("owner_user_id")
    if owner:
        if str(owner) != str(getattr(user, "id", "")):
            raise HTTPException(status_code=404, detail="Drive connection not found.")
    elif manage:
        _require_manager(user)
    return conn


async def service_for_connection(company_id: str, connection_id: str, user):
    """A Drive client for one specific connection (used by the Drive file browser)."""
    from backend.google_drive_service import _company_service

    conn = await _connection_for_user(company_id, connection_id, user, manage=False)
    return _company_service(company_id, conn)


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
    company_id = _company_id(current_user)
    connections = await list_connections(company_id, str(getattr(current_user, "id", "") or ""))
    routes = await _raw()[ROUTES_COLLECTION].find_one({"company_id": company_id}, {"_id": 0}) or {}
    return _public(await get_connection(company_id), current_user, connections=connections, routes=routes)


@router.post("/connect")
async def drive_connect(
    request: Request,
    payload: Optional[Dict[str, Any]] = Body(default=None),
    current_user=Depends(get_current_user),
):
    """Start "Connect Google Drive": returns the Google sign-in URL.

    ``{"personal": true}`` connects the caller's own Drive (any user); otherwise
    an organisation Drive (administrators only).
    """
    personal = bool((payload or {}).get("personal"))
    if not personal:
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
        "owner_user_id": str(current_user.id) if personal else None,
        "label": str((payload or {}).get("label") or "").strip()[:80] or None,
        "return_url": return_url,
        "code_verifier": getattr(flow, "code_verifier", None),
        "created_at": now,
        "expires_at": now + STATE_TTL,
    })
    return {"auth_url": auth_url}


@router.post("/disconnect")
async def drive_disconnect(
    payload: Optional[Dict[str, Any]] = Body(default=None),
    current_user=Depends(get_current_user),
):
    """Disconnect one Drive (``connection_id``; default: the organisation default)."""
    company_id = _company_id(current_user)
    connection_id = str((payload or {}).get("connection_id") or "")
    if connection_id:
        connection = await _connection_for_user(company_id, connection_id, current_user, manage=True)
    else:
        _require_manager(current_user)
        connection = await get_connection(company_id)
    if not connection:
        return {"ok": True, "message": "Google Drive is not connected."}
    if connection and connection.get("refresh_token_enc"):
        try:
            from backend.google_drive_service import decrypt_drive_token

            token = decrypt_drive_token(connection["refresh_token_enc"])
            async with httpx.AsyncClient(timeout=10) as client:
                await client.post("https://oauth2.googleapis.com/revoke", data={"token": token})
        except Exception:
            logger.warning("Google token revoke failed for company %s (token removed locally anyway)", company_id)
    await _raw()[COMPANY_DRIVE_COLLECTION].update_one(
        {"company_id": company_id, "id": connection["id"]},
        {"$set": {"status": "disconnected", "is_default": False, "disconnected_at": _now().isoformat(),
                  "disconnected_by": str(getattr(current_user, "id", "") or "")},
         "$unset": {"refresh_token_enc": ""}},
    )
    # Areas that saved to this Drive fall back to the default; promote a new default.
    routes = await _raw()[ROUTES_COLLECTION].find_one({"company_id": company_id}, {"_id": 0}) or {}
    stale = {area: "" for area in AREA_LABELS if routes.get(area) == connection["id"]}
    if stale:
        await _raw()[ROUTES_COLLECTION].update_one({"company_id": company_id}, {"$unset": stale})
    await _ensure_org_default(company_id)
    invalidate_company_drive(company_id)
    return {"ok": True, "message": "Google Drive disconnected."}


@router.post("/{connection_id}/default")
async def drive_make_default(connection_id: str, current_user=Depends(get_current_user)):
    _require_manager(current_user)
    company_id = _company_id(current_user)
    conn = await _connection_for_user(company_id, connection_id, current_user, manage=True)
    if conn.get("owner_user_id"):
        raise HTTPException(status_code=400, detail="A personal Drive can't be the organisation default.")
    await _raw()[COMPANY_DRIVE_COLLECTION].update_many({"company_id": company_id}, {"$set": {"is_default": False}})
    await _raw()[COMPANY_DRIVE_COLLECTION].update_one({"company_id": company_id, "id": connection_id}, {"$set": {"is_default": True}})
    invalidate_company_drive(company_id)
    return {"default_connection_id": connection_id}


@router.put("/routes")
async def drive_set_routes(payload: Dict[str, Any] = Body(...), current_user=Depends(get_current_user)):
    """"Save to": which organisation Drive each area uses (null → the default)."""
    _require_manager(current_user)
    company_id = _company_id(current_user)
    org_ids = {c["id"] for c in await list_connections(company_id) if not c.get("owner_user_id")}
    updates, unset = {}, {}
    for area in AREA_LABELS:
        if area not in payload:
            continue
        value = payload.get(area)
        if value in (None, ""):
            unset[area] = ""
        elif value in org_ids:
            updates[area] = value
        else:
            raise HTTPException(status_code=400, detail="Choose one of your organisation's connected Drives (personal Drives can't be used here).")
    change: Dict[str, Any] = {"$set": {"company_id": company_id, **updates}}
    if unset:
        change["$unset"] = unset
    await _raw()[ROUTES_COLLECTION].update_one({"company_id": company_id}, change, upsert=True)
    invalidate_company_drive(company_id)
    routes = await _raw()[ROUTES_COLLECTION].find_one({"company_id": company_id}, {"_id": 0}) or {}
    return {"routes": {area: routes.get(area) for area in AREA_LABELS}}


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
        owner_user_id = state_doc.get("owner_user_id") or None
        # Re-connecting the same Google account refreshes that connection
        # (and keeps its folders); a different account adds a new Drive.
        existing = await _raw()[COMPANY_DRIVE_COLLECTION].find_one(
            {"company_id": company_id, "google_email": profile["email"], "owner_user_id": owner_user_id},
            {"_id": 0},
        ) or {}
        if owner_user_id:
            folders = existing.get("folders") or {}  # personal Drives: no company folders
        else:
            company = await _raw().companies.find_one({"id": company_id}, {"_id": 0, "name": 1, "company_name": 1}) or {}
            folders = await asyncio.to_thread(
                ensure_company_folders,
                service,
                existing.get("folders"),
                company.get("name") or company.get("company_name"),
            )
        now_iso = _now().isoformat()
        connection_id = existing.get("id") or f"drv_{secrets.token_hex(8)}"
        await _raw()[COMPANY_DRIVE_COLLECTION].update_one(
            {"company_id": company_id, "id": connection_id},
            {"$set": {
                "id": connection_id,
                "company_id": company_id,
                "owner_user_id": owner_user_id,
                "label": state_doc.get("label") or existing.get("label") or profile["email"],
                "status": "connected",
                "provider": "google",
                "google_email": profile["email"],
                "google_name": profile.get("name"),
                "refresh_token_enc": encrypt_drive_token(refresh_token),
                "scopes": list(COMPANY_DRIVE_SCOPES),
                "folders": folders,
                "connected_by": state_doc.get("user_id"),
                "connected_at": existing.get("connected_at") or now_iso,
                "updated_at": now_iso,
            }, "$setOnInsert": {"is_default": False}},
            upsert=True,
        )
        if not owner_user_id:
            await _ensure_org_default(company_id)
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


async def migrate_single_drive_connections() -> int:
    """One Drive per company → many: give older connections an id and make them the default."""
    raw = _raw()[COMPANY_DRIVE_COLLECTION]
    migrated = 0
    async for doc in raw.find({"id": {"$exists": False}}, {"_id": 1, "company_id": 1, "status": 1}):
        await raw.update_one({"_id": doc["_id"]}, {"$set": {
            "id": f"drv_{secrets.token_hex(8)}",
            "owner_user_id": None,
            "is_default": doc.get("status") == "connected",
        }})
        migrated += 1
    return migrated


async def create_company_drive_indexes() -> None:
    raw = _raw()
    try:
        # Several Drives per company now: the old one-per-company rule goes.
        info = await raw[COMPANY_DRIVE_COLLECTION].index_information()
        for name, spec in (info or {}).items():
            if [k for k, _ in spec.get("key", [])] == ["company_id"] and spec.get("unique"):
                await raw[COMPANY_DRIVE_COLLECTION].drop_index(name)
        await migrate_single_drive_connections()
        await raw[COMPANY_DRIVE_COLLECTION].create_index([("company_id", 1), ("id", 1)], unique=True)
        await raw[COMPANY_DRIVE_COLLECTION].create_index([("company_id", 1), ("status", 1), ("owner_user_id", 1)])
        await raw[ROUTES_COLLECTION].create_index("company_id", unique=True)
        await raw[STATE_COLLECTION].create_index("state", unique=True)
        await raw[STATE_COLLECTION].create_index("expires_at", expireAfterSeconds=0)
    except Exception as exc:
        logger.warning("Company Drive index creation skipped: %s", exc)
