"""
google_auth.py — Google Drive routes under /auth/google/* (no /api prefix).
─────────────────────────────────────────────────────────────────────────────
Google Drive is connected PER ORGANISATION (backend/company_drive.py):
an administrator clicks "Connect Google Drive", which calls
POST /api/integrations/google-drive/connect and sends the browser to Google.
Google returns to GET /auth/google/callback (the redirect URI registered in
Google Cloud), which only accepts a one-time state created by that call.

The old unauthenticated GET /auth/google start URL is disabled: anyone could
open it and connect their own Google account as the platform's Drive.

Every other route here acts on the CALLER's organisation's Drive only.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Optional
import asyncio
import os

from backend.dependencies import get_current_user, require_admin
from backend.models import User

router = APIRouter()

FRONTEND_URL = os.getenv("FRONTEND_URL", "https://final-taskosphere-frontend.onrender.com")
BACKEND_URL = os.getenv("BACKEND_URL", "https://final-taskosphere-backend.onrender.com")
REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI") or f"{BACKEND_URL}/auth/google/callback"

_MOVED = (
    "Google Drive is now connected per organisation. "
    "Open Settings → Google Drive and click Connect Google Drive."
)


# ── 1. Old start URL (disabled) ───────────────────────────────────────────────
@router.get("/auth/google")
def auth_google():
    return JSONResponse({"detail": _MOVED}, status_code=410)


# ── 2. OAuth callback (registered redirect URI) ──────────────────────────────
@router.get("/auth/google/callback")
async def callback(request: Request):
    from backend.company_drive import STATE_PREFIX, handle_oauth_callback, _with_result, DEFAULT_RETURN_PATH

    state = str(request.query_params.get("state") or "")
    if state.startswith(STATE_PREFIX):
        return await handle_oauth_callback(request)
    frontend = (os.getenv("FRONTEND_URL") or FRONTEND_URL).rstrip("/")
    return _with_result(f"{frontend}{DEFAULT_RETURN_PATH}", "error",
                        "This connection link is not valid. Click Connect Google Drive again.")


# ── 3. Status ────────────────────────────────────────────────────────────────
@router.get("/auth/google/status")
async def drive_connection_status(current_user: User = Depends(get_current_user)):
    from backend.company_drive import drive_status
    from backend.google_drive_service import _drive_scope, _platform_drive_configured

    status = await drive_status(current_user)
    if not status["connected"]:
        mode, _, _ = await asyncio.to_thread(_drive_scope)
        if mode == "platform" and await asyncio.to_thread(_platform_drive_configured):
            # Platform Owner workspace still using the original server-level Drive.
            status.update({"connected": True, "source": "platform"})
    return status


# ── 4. Disconnect ─────────────────────────────────────────────────────────────
@router.post("/auth/google/disconnect")
async def disconnect_drive(current_user: User = Depends(require_admin())):
    from backend.company_drive import drive_disconnect

    return await drive_disconnect(current_user)


# ── 5. Reconnect (replaced by the connect flow) ──────────────────────────────
@router.get("/auth/google/reconnect")
async def reconnect_drive(current_user: User = Depends(require_admin())):
    return JSONResponse({"detail": _MOVED}, status_code=410)


# ── 6. List files (caller's organisation Drive) ───────────────────────────────
async def _browser_service(current_user, connection_id: Optional[str]):
    """Organisation Drives (administrators) or the caller's own personal Drive."""
    if connection_id:
        from backend.company_drive import _company_id, service_for_connection, _connection_for_user

        company_id = _company_id(current_user)
        conn = await _connection_for_user(company_id, connection_id, current_user, manage=False)
        if not conn.get("owner_user_id"):
            from backend.company_drive import _require_manager

            _require_manager(current_user)
        return await service_for_connection(company_id, connection_id, current_user)
    from backend.company_drive import _require_manager
    from backend.google_drive_service import _get_drive_service

    _require_manager(current_user)
    return _get_drive_service()


@router.get("/auth/google/files")
async def list_drive_files(
    current_user: User = Depends(get_current_user),
    page_size: int = Query(50, ge=1, le=100),
    q: Optional[str] = Query(None),
    page_token: Optional[str] = Query(None),
    connection_id: Optional[str] = Query(None),
):
    service = await _browser_service(current_user, connection_id)
    try:
        drive_query = "trashed = false"
        if q:
            drive_query += f" and name contains '{q.replace(chr(39), '').replace(chr(92), '')}'"
        kwargs = dict(
            pageSize=page_size,
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, iconLink)",
            orderBy="modifiedTime desc",
            q=drive_query,
        )
        if page_token:
            kwargs["pageToken"] = page_token
        result = await asyncio.to_thread(lambda: service.files().list(**kwargs).execute())
        files = result.get("files", [])
        return {"files": files, "nextPageToken": result.get("nextPageToken"), "count": len(files)}
    except Exception:
        raise HTTPException(502, "Google Drive could not list files right now. Please try again.")


# ── 7. Share file ─────────────────────────────────────────────────────────────
class ShareRequest(BaseModel):
    file_id: str
    connection_id: Optional[str] = None


@router.post("/auth/google/share")
async def create_share_link(body: ShareRequest, current_user: User = Depends(get_current_user)):
    if body.connection_id:
        service = await _browser_service(current_user, body.connection_id)
    else:
        from backend.company_drive import _require_manager
        from backend.google_drive_service import get_drive_service_for_file

        _require_manager(current_user)
        service = get_drive_service_for_file(body.file_id)

    def _share():
        service.permissions().create(
            fileId=body.file_id,
            body={"type": "anyone", "role": "reader"},
        ).execute()
        return service.files().get(fileId=body.file_id, fields="webViewLink,webContentLink").execute()

    try:
        file_meta = await asyncio.to_thread(_share)
    except Exception:
        raise HTTPException(502, "That file could not be shared. It may not be in your organisation's Drive.")
    share_url = file_meta.get("webViewLink") or f"https://drive.google.com/file/d/{body.file_id}/view"
    return {"ok": True, "share_url": share_url}
