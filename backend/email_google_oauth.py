"""Direct Gmail OAuth integration for the existing Email Accounts feature.

The existing email integration is IMAP/App-Password based. Gmail now gets a
first-class OAuth path so the user can click "Connect with Google", choose a
Google account, approve read-only Gmail access, and return to Taskosphere.

OAuth credentials are stored using the same Fernet encryption helper already
used by email_integration.py. The existing scan/test code is adapted through
its existing _scan_mailbox_sync/_test_imap_sync function signatures, so the
rest of the email extraction pipeline remains unchanged.
"""

import base64
import email
import logging
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode, urlparse

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from backend.dependencies import db, check_module_permission
from backend import email_integration as _email

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/email/oauth/google", tags=["email-google-oauth"])

GOOGLE_GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
GOOGLE_OAUTH_STATE_COLLECTION = "email_oauth_states"
GOOGLE_OAUTH_HOST = "__google_gmail_oauth__"
OAUTH_PASSWORD_PREFIX = "oauth_refresh_token:"
STATE_TTL_SECONDS = 10 * 60


def _google_client_config() -> Dict[str, Any]:
    client_id = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    client_secret = (os.getenv("GOOGLE_CLIENT_SECRET") or "").strip()
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=503,
            detail="Google Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the backend.",
        )
    return {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }


def _redirect_uri(request: Request) -> str:
    configured = (os.getenv("GOOGLE_EMAIL_REDIRECT_URI") or "").strip()
    if configured:
        return configured.rstrip("/")

    proto = (request.headers.get("x-forwarded-proto") or "https").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    if not host:
        raise HTTPException(status_code=503, detail="Unable to determine the Gmail OAuth callback URL.")
    return f"{proto}://{host}/api/email/oauth/google/callback"


def _frontend_origin(request: Request) -> str:
    configured = (os.getenv("FRONTEND_URL") or "").strip().rstrip("/")
    if configured:
        return configured
    return (request.headers.get("origin") or "").strip().rstrip("/")


def _safe_return_url(raw: Optional[str], request: Request) -> str:
    origin = _frontend_origin(request)
    if not origin:
        return "/settings/email"

    candidate = (raw or "").strip()
    if not candidate:
        return f"{origin}/settings/email"

    try:
        parsed = urlparse(candidate)
        allowed = urlparse(origin)
        candidate_origin = f"{parsed.scheme}://{parsed.netloc}".rstrip("/")
        allowed_origin = f"{allowed.scheme}://{allowed.netloc}".rstrip("/")
        if candidate_origin == allowed_origin and parsed.scheme in {"http", "https"}:
            return candidate
    except Exception:
        pass
    return f"{origin}/settings/email"


def _flow(redirect_uri: str, state: Optional[str] = None) -> Flow:
    flow = Flow.from_client_config(
        _google_client_config(),
        scopes=[GOOGLE_GMAIL_SCOPE],
        state=state,
    )
    flow.redirect_uri = redirect_uri
    return flow


async def _save_state(
    *,
    state: str,
    current_user: Any,
    redirect_uri: str,
    return_url: str,
    linked_page: str,
    auto_sync: bool,
    label: Optional[str],
) -> None:
    now = datetime.now(timezone.utc)
    collection = db[GOOGLE_OAUTH_STATE_COLLECTION]
    await collection.create_index("expires_at", expireAfterSeconds=0)
    await collection.insert_one(
        {
            "state": state,
            "user_id": str(current_user.id),
            "company_id": str(getattr(current_user, "company_id", "") or ""),
            "commercial_customer_id": getattr(current_user, "commercial_customer_id", None),
            "redirect_uri": redirect_uri,
            "return_url": return_url,
            "linked_page": linked_page or "all",
            "auto_sync": bool(auto_sync),
            "label": label or "",
            "created_at": now,
            "expires_at": now + timedelta(seconds=STATE_TTL_SECONDS),
        }
    )


@router.get("/start")
async def start_google_gmail_oauth(
    request: Request,
    linked_page: str = Query("all"),
    auto_sync: bool = Query(False),
    label: Optional[str] = Query(None),
    return_url: Optional[str] = Query(None),
    current_user=Depends(check_module_permission("email_accounts", "create")),
):
    """Create a normal Google OAuth authorization request."""
    redirect_uri = _redirect_uri(request)
    return_url = _safe_return_url(return_url, request)
    state = secrets.token_urlsafe(32)

    flow = _flow(redirect_uri, state=state)
    authorization_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent select_account",
        state=state,
    )

    await _save_state(
        state=state,
        current_user=current_user,
        redirect_uri=redirect_uri,
        return_url=return_url,
        linked_page=linked_page,
        auto_sync=auto_sync,
        label=label,
    )
    return {"auth_url": authorization_url}


async def _redirect_result(return_url: str, result: str, reason: Optional[str] = None):
    separator = "&" if "?" in return_url else "?"
    params = {"gmail_oauth": result}
    if reason:
        params["reason"] = reason[:160]
    return RedirectResponse(f"{return_url}{separator}{urlencode(params)}", status_code=302)


@router.get("/callback")
async def google_gmail_oauth_callback(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
):
    """Validate state, exchange Google's code, and persist the Gmail account."""
    return_url = "/settings/email"
    try:
        if not state:
            raise HTTPException(status_code=400, detail="Missing Google OAuth state.")

        state_doc = await db[GOOGLE_OAUTH_STATE_COLLECTION].find_one_and_delete({"state": state})
        if not state_doc:
            raise HTTPException(status_code=400, detail="Google connection expired or is invalid. Start the connection again.")
        return_url = state_doc.get("return_url") or return_url

        if error:
            return await _redirect_result(return_url, "cancelled", error)
        if not code:
            return await _redirect_result(return_url, "error", "missing_code")

        flow = _flow(state_doc["redirect_uri"], state=state)
        flow.fetch_token(code=code)
        credentials = flow.credentials
        refresh_token = credentials.refresh_token
        if not refresh_token:
            raise HTTPException(
                status_code=400,
                detail="Google did not return a refresh token. Please approve offline Gmail access and reconnect.",
            )

        service = build("gmail", "v1", credentials=credentials, cache_discovery=False)
        profile = service.users().getProfile(userId="me").execute()
        email_address = str(profile.get("emailAddress") or "").strip().lower()
        if not email_address or "@" not in email_address:
            raise HTTPException(status_code=400, detail="Google did not return a valid Gmail address.")

        user_id = str(state_doc["user_id"])
        existing = await db[_email.COL_CONNECTIONS].find_one(
            {"user_id": user_id, "email_address": email_address},
            {"_id": 0},
        )

        user_doc = await db.users.find_one(
            {"id": user_id},
            {"_id": 0, "commercial_customer_id": 1, "company_id": 1},
        )
        customer_id = state_doc.get("commercial_customer_id") or (user_doc or {}).get("commercial_customer_id")
        company_id = state_doc.get("company_id") or (user_doc or {}).get("company_id")

        # Reuse the existing encrypted password field so every existing scan,
        # test and sync path can pass the credential through _decrypt() without
        # changing the rest of the email integration.
        oauth_secret = _email._encrypt(OAUTH_PASSWORD_PREFIX + refresh_token)
        now_iso = datetime.now(timezone.utc).isoformat()
        connection_doc = {
            "user_id": user_id,
            "company_id": company_id or None,
            "commercial_customer_id": customer_id,
            "email_address": email_address,
            "auth_type": "google_oauth",
            "oauth_provider": "google",
            "oauth_scopes": list(credentials.scopes or [GOOGLE_GMAIL_SCOPE]),
            "app_password_enc": oauth_secret,
            "imap_host": GOOGLE_OAUTH_HOST,
            "imap_port": 443,
            "label": state_doc.get("label") or (existing or {}).get("label") or f"Gmail ({email_address})",
            "provider": "gmail",
            "is_active": True,
            "connected_at": (existing or {}).get("connected_at") or now_iso,
            "linked_page": state_doc.get("linked_page") or (existing or {}).get("linked_page") or "all",
            "auto_sync": bool(state_doc.get("auto_sync")),
            "keywords": list((existing or {}).get("keywords") or []),
            "keyword_match_mode": (existing or {}).get("keyword_match_mode") or "or",
            "keyword_case_sensitive": bool((existing or {}).get("keyword_case_sensitive")),
            "keyword_auto_save": bool((existing or {}).get("keyword_auto_save", True)),
            "sync_error": None,
            "updated_at": now_iso,
        }
        await db[_email.COL_CONNECTIONS].update_one(
            {"user_id": user_id, "email_address": email_address},
            {"$set": connection_doc},
            upsert=True,
        )
        return await _redirect_result(return_url, "connected")
    except HTTPException as exc:
        logger.warning("Gmail OAuth callback rejected: %s", exc.detail)
        return await _redirect_result(return_url, "error", str(exc.detail))
    except Exception:
        logger.exception("Gmail OAuth callback failed")
        return await _redirect_result(return_url, "error", "oauth_callback_failed")


def _credentials_from_marker(marker: str) -> Credentials:
    if not marker.startswith(OAUTH_PASSWORD_PREFIX):
        raise RuntimeError("Google Gmail authorization is missing. Reconnect this account.")
    refresh_token = marker[len(OAUTH_PASSWORD_PREFIX):]
    if not refresh_token:
        raise RuntimeError("Google Gmail authorization is missing. Reconnect this account.")
    credentials = Credentials(
        token=None,
        refresh_token=refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=(os.getenv("GOOGLE_CLIENT_ID") or "").strip(),
        client_secret=(os.getenv("GOOGLE_CLIENT_SECRET") or "").strip(),
        scopes=[GOOGLE_GMAIL_SCOPE],
    )
    if credentials.expired and credentials.refresh_token:
        credentials.refresh(GoogleRequest())
    return credentials


def _gmail_service_from_password(password: str):
    # email_integration already decrypts app_password_enc before calling this
    # function, so password is the plaintext marker only inside server memory.
    return build("gmail", "v1", credentials=_credentials_from_marker(password), cache_discovery=False)


def _decode_gmail_raw(raw_message: Dict[str, Any]) -> email.message.Message:
    raw_b64 = raw_message.get("raw") or ""
    raw_bytes = base64.urlsafe_b64decode(raw_b64 + "=" * (-len(raw_b64) % 4))
    return email.message_from_bytes(raw_bytes)


def _gmail_header(message: email.message.Message, name: str) -> str:
    return _email._decode_header_str(message.get(name, ""))


def _gmail_received_at(message: email.message.Message, raw_message: Dict[str, Any]) -> str:
    internal_ms = raw_message.get("internalDate")
    if internal_ms:
        try:
            return datetime.fromtimestamp(int(internal_ms) / 1000, tz=timezone.utc).isoformat()
        except Exception:
            pass
    try:
        return _email._parse_email_received_at(message.get("Date", "")).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def _gmail_record(raw_message: Dict[str, Any]) -> Dict[str, Any]:
    message = _decode_gmail_raw(raw_message)
    from_raw = _email._decode_header_str(message.get("From", ""))
    return {
        "subject": _email._clean_text(_gmail_header(message, "Subject"), 200),
        "from_addr": from_raw,
        "sender_email": _email._extract_sender_email(from_raw),
        "msg_date": message.get("Date", ""),
        "body": _email._get_plain_body(message, max_chars=4000),
        "message_id": (message.get("Message-ID") or "").strip(),
        "uid": str(raw_message.get("id") or ""),
        "received_at": _gmail_received_at(message, raw_message),
        "matched_keywords": [],
    }


def _gmail_query(since_date: Optional[str], keywords: Optional[List[str]], mode: str) -> str:
    parts = ["in:inbox"]
    if since_date:
        try:
            dt = datetime.fromisoformat(str(since_date)[:10])
            parts.append(f"after:{dt.strftime('%Y/%m/%d')}")
        except Exception:
            parts.append("newer_than:30d")
    else:
        parts.append("newer_than:30d")

    clean = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    if clean:
        if (mode or "or").lower() == "and":
            parts.extend(f"subject:{k}" for k in clean)
        else:
            parts.append("{" + " ".join(f"subject:{k}" for k in clean) + "}")
    return " ".join(parts)


def _scan_gmail_sync(
    host: str,
    port: int,
    email_addr: str,
    password: str,
    max_msgs: int = 50,
    sender_whitelist: Optional[List[str]] = None,
    since_date: Optional[str] = None,
    keywords: Optional[List[str]] = None,
    keyword_match_mode: str = "or",
    keyword_case_sensitive: bool = False,
) -> List[Dict[str, Any]]:
    service = _gmail_service_from_password(password)
    query = _gmail_query(since_date, keywords, keyword_match_mode)
    refs = service.users().messages().list(
        userId="me",
        q=query,
        maxResults=min(max(max_msgs or 50, 1), 500),
        includeSpamTrash=False,
    ).execute().get("messages") or []

    clean_keywords = [str(k).strip() for k in (keywords or []) if str(k).strip()]
    output: List[Dict[str, Any]] = []
    for ref in refs[:max_msgs or 50]:
        try:
            raw = service.users().messages().get(userId="me", id=ref["id"], format="raw").execute()
            record = _gmail_record(raw)
            subject = record["subject"] or ""
            if clean_keywords:
                haystack = subject if keyword_case_sensitive else subject.lower()
                matched = [
                    kw for kw in clean_keywords
                    if (kw if keyword_case_sensitive else kw.lower()) in haystack
                ]
                if (keyword_match_mode or "or").lower() == "and" and len(matched) != len(clean_keywords):
                    continue
                if (keyword_match_mode or "or").lower() == "or" and not matched:
                    continue
                record["matched_keywords"] = matched
            if sender_whitelist and not _email._sender_matches_whitelist(record["sender_email"], sender_whitelist):
                continue
            output.append(record)
        except Exception as exc:
            logger.warning("Skipping Gmail message %s: %s", ref.get("id"), exc)
    return output


def _test_gmail_sync(host: str, port: int, email_addr: str, password: str):
    try:
        service = _gmail_service_from_password(password)
        profile = service.users().getProfile(userId="me").execute()
        actual = str(profile.get("emailAddress") or "").strip().lower()
        if actual != email_addr.lower():
            return "Google returned a different Gmail account than the connected address. Reconnect this account."
        return None
    except HttpError as exc:
        status_code = getattr(getattr(exc, "resp", None), "status", None)
        if status_code in (401, 403):
            return "Google authorization has expired or been revoked. Reconnect this Gmail account."
        return f"Gmail API test failed: {exc}"
    except Exception as exc:
        return f"Gmail API test failed: {exc}"


# Preserve the existing email pipeline. Its routes already call these two
# functions in a worker thread, so Gmail API traffic does not block FastAPI's
# event loop and no duplicate extract/save pipeline is introduced.
_ORIGINAL_SCAN = _email._scan_mailbox_sync
_ORIGINAL_TEST = _email._test_imap_sync


def _scan_dispatch(host, port, email_addr, password, *args, **kwargs):
    if host == GOOGLE_OAUTH_HOST:
        return _scan_gmail_sync(host, port, email_addr, password, *args, **kwargs)
    return _ORIGINAL_SCAN(host, port, email_addr, password, *args, **kwargs)


def _test_dispatch(host, port, email_addr, password):
    if host == GOOGLE_OAUTH_HOST:
        return _test_gmail_sync(host, port, email_addr, password)
    return _ORIGINAL_TEST(host, port, email_addr, password)


_email._scan_mailbox_sync = _scan_dispatch
_email._test_imap_sync = _test_dispatch


def _conn_doc_to_out(doc: Dict[str, Any]):
    out = _ORIGINAL_CONN_DOC_TO_OUT(doc)
    if doc.get("auth_type") == "google_oauth":
        out["imap_host"] = "Google Gmail API"
        out["imap_port"] = 443
        out["auth_type"] = "google_oauth"
        out["oauth_provider"] = "google"
    return out


_ORIGINAL_CONN_DOC_TO_OUT = _email._conn_doc_to_out
_email._conn_doc_to_out = _conn_doc_to_out

# Mount the OAuth endpoints onto the already-registered /email router. This
# avoids a second router registration path and keeps the frontend URL stable.
_email.router.include_router(router)
