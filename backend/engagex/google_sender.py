"""MailMaster "Continue with Google": connect a Gmail / Google Workspace mailbox
with OAuth and send campaigns through the Gmail API (no passwords stored).

Flow
----
1. ``start`` (authenticated) builds the Google consent URL. It reuses the
   redirect URI already registered for the Email module
   (``/api/email/oauth/google/callback``) so no new Google Cloud redirect is
   needed; EngageX states carry the ``exg.`` prefix and that callback hands
   them to :func:`handle_callback`.
2. ``handle_callback`` (public, Google redirect) exchanges the code, reads the
   account's email address and stores an encrypted refresh token as a sender.
3. :class:`GmailSession` refreshes access tokens and sends raw MIME messages
   with ``users.messages.send`` (media upload, up to 35 MB per message).

Scopes: ``openid``, ``userinfo.email`` and ``gmail.send`` (send-only; EngageX
can never read the mailbox).
"""
from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
from datetime import timedelta
from typing import Any, Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import RedirectResponse

from .common import SENDERS, company_profile, decrypt_secret, encrypt_secret, iso, new_id, normalize_email, raw_db, utcnow

logger = logging.getLogger("engagex.google")

STATE_PREFIX = "exg."
STATES = "engagex_oauth_states"
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email", GMAIL_SEND_SCOPE]
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"
GMAIL_SEND_URL = "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media"
STATE_TTL = timedelta(minutes=15)


class GoogleAccessRevoked(RuntimeError):
    """The refresh token no longer works; the mailbox must be reconnected."""


def _client() -> tuple[str, str]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).")
    return client_id, client_secret


def _flow(redirect_uri: str, state: str):
    from google_auth_oauthlib.flow import Flow

    client_id, client_secret = _client()
    config = {"web": {"client_id": client_id, "client_secret": client_secret,
                      "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": TOKEN_URL}}
    flow = Flow.from_client_config(config, scopes=SCOPES, state=state)
    flow.redirect_uri = redirect_uri
    return flow


def _frontend_return_url(request: Request, return_path: Optional[str]) -> str:
    """Absolute URL back into the app; only same-app paths are accepted."""
    origin = (os.getenv("FRONTEND_URL") or request.headers.get("origin") or "").strip().rstrip("/")
    path = str(return_path or "/engagex/mailmaster").strip()
    parsed = urlparse(path)
    if parsed.scheme or parsed.netloc or not path.startswith("/"):
        path = "/engagex/mailmaster"
    return f"{origin}{path}" if origin else path


async def start(request: Request, user: Any, company_id: str, return_path: Optional[str]) -> str:
    from backend.email_google_oauth import _redirect_uri

    redirect_uri = _redirect_uri(request)
    state = STATE_PREFIX + secrets.token_urlsafe(32)
    flow = _flow(redirect_uri, state)
    auth_url, _ = flow.authorization_url(access_type="offline", include_granted_scopes="false",
                                         prompt="consent select_account", state=state)
    await raw_db()[STATES].insert_one({
        "state": state,
        "company_id": company_id,
        "user_id": str(getattr(user, "id", "")),
        "redirect_uri": redirect_uri,
        "code_verifier": getattr(flow, "code_verifier", None),
        "return_url": _frontend_return_url(request, return_path),
        "created_at": iso(),
        "expires_at": iso(utcnow() + STATE_TTL),
    })
    return auth_url


def _result(return_url: str, outcome: str, **extra: str) -> RedirectResponse:
    params = {"google": outcome, **{k: str(v)[:160] for k, v in extra.items() if v}}
    sep = "&" if "?" in return_url else "?"
    return RedirectResponse(f"{return_url}{sep}{urlencode(params)}", status_code=302)


async def _fetch_email(access_token: str) -> Optional[str]:
    async with httpx.AsyncClient(timeout=20) as client:
        res = await client.get(USERINFO_URL, headers={"Authorization": f"Bearer {access_token}"})
    if res.status_code != 200:
        return None
    data = res.json()
    return normalize_email(data.get("email")) if data.get("email_verified", True) else None


async def handle_callback(request: Request, *, code: Optional[str], state: str, error: Optional[str]) -> RedirectResponse:
    doc = await raw_db()[STATES].find_one_and_delete({"state": state})
    fallback = _frontend_return_url(request, "/engagex/mailmaster")
    if not doc:
        return _result(fallback, "error", reason="The Google sign-in expired. Please try again.")
    return_url = doc.get("return_url") or fallback
    if str(doc.get("expires_at") or "") < iso():
        return _result(return_url, "error", reason="The Google sign-in expired. Please try again.")
    if error:
        return _result(return_url, "cancelled", reason="Google sign-in was cancelled.")
    if not code:
        return _result(return_url, "error", reason="Google did not return an authorisation code.")
    try:
        flow = _flow(doc["redirect_uri"], state)
        if doc.get("code_verifier"):
            flow.code_verifier = doc["code_verifier"]
        await asyncio.to_thread(flow.fetch_token, code=code)
        creds = flow.credentials
        granted = set(creds.scopes or [])
        if granted and GMAIL_SEND_SCOPE not in granted:
            return _result(return_url, "error", reason="Please allow “Send email on your behalf” so MailMaster can send campaigns.")
        if not creds.refresh_token:
            return _result(return_url, "error", reason="Google did not grant offline access. Please try again.")
        email = await _fetch_email(creds.token)
        if not email:
            return _result(return_url, "error", reason="Could not read the Google account's email address.")
        company_id = doc["company_id"]
        profile = await company_profile(company_id)
        now = iso()
        await raw_db()[SENDERS].update_one(
            {"company_id": company_id, "kind": "google", "from_email": email},
            {
                "$set": {
                    "kind": "google",
                    "label": f"Gmail · {email}",
                    "from_email": email,
                    "username": email,
                    "refresh_token_enc": encrypt_secret(creds.refresh_token),
                    "scopes": sorted(granted) or SCOPES,
                    "verified_at": now,
                    "last_error": None,
                    "deleted": False,
                    "updated_at": now,
                },
                "$setOnInsert": {
                    "id": new_id("exs"),
                    "company_id": company_id,
                    "from_name": profile.get("name") or email,
                    "reply_to": None,
                    "is_default": False,
                    "created_by": doc.get("user_id"),
                    "created_at": now,
                },
            },
            upsert=True,
        )
        return _result(return_url, "connected", email=email)
    except Exception:
        logger.exception("EngageX Google sign-in failed")
        return _result(return_url, "error", reason="Google sign-in failed. Please try again.")


class GmailSession:
    """Sends raw MIME through the Gmail API for one connected mailbox."""

    def __init__(self, refresh_token: str, transport: Optional[httpx.AsyncBaseTransport] = None):
        self.refresh_token = refresh_token
        self._token: Optional[str] = None
        self._expires = 0.0
        self._client = httpx.AsyncClient(timeout=60, transport=transport)

    async def _access_token(self, force: bool = False) -> str:
        if self._token and not force and time.monotonic() < self._expires - 60:
            return self._token
        client_id, client_secret = _client()
        res = await self._client.post(TOKEN_URL, data={
            "client_id": client_id, "client_secret": client_secret,
            "refresh_token": self.refresh_token, "grant_type": "refresh_token",
        })
        if res.status_code == 400 and "invalid_grant" in res.text:
            raise GoogleAccessRevoked("Google access was revoked or expired. Reconnect this Gmail account in MailMaster → Senders.")
        if res.status_code != 200:
            raise RuntimeError(f"Google token refresh failed ({res.status_code}).")
        data = res.json()
        self._token = data["access_token"]
        self._expires = time.monotonic() + float(data.get("expires_in") or 3600)
        return self._token

    async def send(self, from_email: str, to_email: str, message: str) -> None:
        body = message.encode("utf-8")
        for attempt in (1, 2):
            token = await self._access_token(force=attempt == 2)
            res = await self._client.post(GMAIL_SEND_URL, content=body, headers={
                "Authorization": f"Bearer {token}", "Content-Type": "message/rfc822"})
            if res.status_code in (200, 201):
                return
            if res.status_code == 401 and attempt == 1:
                continue
            try:
                detail = res.json().get("error", {}).get("message") or res.text
            except Exception:
                detail = res.text
            if res.status_code == 403 and "insufficient" in str(detail).lower():
                raise GoogleAccessRevoked("This Gmail account did not grant permission to send email. Reconnect it and allow sending.")
            raise RuntimeError(f"Gmail rejected the message: {str(detail)[:300]}")

    async def close(self) -> None:
        await self._client.aclose()

