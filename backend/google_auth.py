"""
google_auth.py — Google Drive OAuth flow + File listing + Share links
─────────────────────────────────────────────────────────────────────────────
"""

from fastapi import APIRouter, Request, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from pydantic import BaseModel
from typing import Optional
import os

from backend.dependencies import db, get_current_user, require_admin
from backend.models import User

router = APIRouter()

CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
FRONTEND_URL = os.getenv("FRONTEND_URL", "https://final-taskosphere-frontend.onrender.com")
BACKEND_URL = os.getenv("BACKEND_URL", "https://final-taskosphere-backend.onrender.com")
REDIRECT_URI = os.getenv("GOOGLE_REDIRECT_URI") or f"{BACKEND_URL}/auth/google/callback"

SCOPES = [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive.metadata.readonly",
]

SETTINGS_COLLECTION = "app_settings"
DRIVE_DOC_ID = "google_drive"

# ── helpers ───────────────────────────────────────────────────────────────────
def _build_flow() -> Flow:
    return Flow.from_client_config(
        {
            "web": {
                "client_id": CLIENT_ID,
                "client_secret": CLIENT_SECRET,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        },
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
    )

async def _get_drive_credentials() -> Optional[Credentials]:
    doc = await db[SETTINGS_COLLECTION].find_one({"_id": DRIVE_DOC_ID})
    refresh_token = (
        (doc.get("refresh_token") if doc else None)
        or os.getenv("GOOGLE_REFRESH_TOKEN")
    )
    if not refresh_token or not CLIENT_ID or not CLIENT_SECRET:
        return None
    return Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=CLIENT_ID,
        client_secret=CLIENT_SECRET,
        scopes=SCOPES,
    )

def _build_drive_service(creds: Credentials):
    return build("drive", "v3", credentials=creds, cache_discovery=False)

# ── 1. Initiate OAuth ─────────────────────────────────────────────────────────
@router.get("/auth/google")
def auth_google():
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(500, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set")
    flow = _build_flow()
    auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")
    return RedirectResponse(auth_url)

# ── 2. OAuth Callback ─────────────────────────────────────────────────────────
@router.get("/auth/google/callback")
async def callback(request: Request):
    code = request.query_params.get("code")
    error = request.query_params.get("error")
    if error:
        return RedirectResponse(f"{FRONTEND_URL}/settings/general?drive=denied")
    if not code:
        return RedirectResponse(f"{FRONTEND_URL}/settings/general?drive=error&reason=no_code")

    try:
        flow = _build_flow()
        flow.fetch_token(code=code)
        creds = flow.credentials

        if not creds.refresh_token:
            return RedirectResponse(f"{FRONTEND_URL}/settings/general?drive=error&reason=no_refresh_token")

        await db[SETTINGS_COLLECTION].update_one(
            {"_id": DRIVE_DOC_ID},
            {
                "$set": {
                    "refresh_token": creds.refresh_token,
                    "access_token": creds.token,
                    "connected": True,
                }
            },
            upsert=True,
        )

        os.environ["GOOGLE_REFRESH_TOKEN"] = creds.refresh_token

        return RedirectResponse(f"{FRONTEND_URL}/settings/general?drive=connected")

    except Exception as exc:
        return RedirectResponse(f"{FRONTEND_URL}/settings/general?drive=error&reason={str(exc)[:80]}")

# ── 3. Status ────────────────────────────────────────────────────────────────
@router.get("/auth/google/status")
async def drive_connection_status(current_user: User = Depends(get_current_user)):
    doc = await db[SETTINGS_COLLECTION].find_one({"_id": DRIVE_DOC_ID})
    connected = bool(doc and doc.get("refresh_token") and doc.get("connected"))
    if os.getenv("GOOGLE_REFRESH_TOKEN"):
        connected = True
    return {"connected": connected}

# ── 4. Disconnect ─────────────────────────────────────────────────────────────
@router.post("/auth/google/disconnect")
async def disconnect_drive(current_user: User = Depends(require_admin())):
    await db[SETTINGS_COLLECTION].update_one(
        {"_id": DRIVE_DOC_ID},
        {"$set": {"refresh_token": None, "access_token": None, "connected": False}},
        upsert=True,
    )
    os.environ.pop("GOOGLE_REFRESH_TOKEN", None)
    return {"ok": True, "message": "Google Drive disconnected"}

# ── 5. Reconnect ──────────────────────────────────────────────────────────────
@router.get("/auth/google/reconnect")
async def reconnect_drive(current_user: User = Depends(require_admin())):
    if not CLIENT_ID or not CLIENT_SECRET:
        raise HTTPException(500, "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set")
    await db[SETTINGS_COLLECTION].update_one(
        {"_id": DRIVE_DOC_ID},
        {"$set": {"refresh_token": None, "access_token": None, "connected": False}},
        upsert=True,
    )
    os.environ.pop("GOOGLE_REFRESH_TOKEN", None)
    flow = _build_flow()
    auth_url, _ = flow.authorization_url(prompt="consent", access_type="offline")
    return RedirectResponse(auth_url)

# ── 6. List files ─────────────────────────────────────────────────────────────
@router.get("/auth/google/files")
async def list_drive_files(
    current_user: User = Depends(require_admin()),
    page_size: int = Query(50, ge=1, le=100),
    q: Optional[str] = Query(None),
    page_token: Optional[str] = Query(None),
):
    creds = await _get_drive_credentials()
    if not creds:
        raise HTTPException(401, "Google Drive not connected")
    try:
        service = _build_drive_service(creds)
        drive_query = "trashed = false"
        if q:
            drive_query += f" and name contains '{q.replace(chr(39), '')}'"
        kwargs = dict(
            pageSize=page_size,
            fields="nextPageToken, files(id, name, mimeType, size, modifiedTime, webViewLink, webContentLink, iconLink)",
            orderBy="modifiedTime desc",
            q=drive_query,
        )
        if page_token:
            kwargs["pageToken"] = page_token
        result = service.files().list(**kwargs).execute()
        files = result.get("files", [])
        return {"files": files, "nextPageToken": result.get("nextPageToken"), "count": len(files)}
    except Exception as exc:
        raise HTTPException(502, f"Drive API error: {str(exc)[:200]}")

# ── 7. Share file ─────────────────────────────────────────────────────────────
class ShareRequest(BaseModel):
    file_id: str

@router.post("/auth/google/share")
async def create_share_link(body: ShareRequest, current_user: User = Depends(require_admin())):
    creds = await _get_drive_credentials()
    if not creds:
        raise HTTPException(401, "Google Drive not connected")
    try:
        service = _build_drive_service(creds)
        service.permissions().create(
            fileId=body.file_id,
            body={"type": "anyone", "role": "reader"},
        ).execute()
        file_meta = service.files().get(fileId=body.file_id, fields="webViewLink,webContentLink").execute()
        share_url = file_meta.get("webViewLink") or f"https://drive.google.com/file/d/{body.file_id}/view"
        return {"ok": True, "share_url": share_url}
    except Exception as exc:
        raise HTTPException(502, f"Share error: {str(exc)[:200]}")
