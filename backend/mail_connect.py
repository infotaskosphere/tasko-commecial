"""Connect a mailbox the way mail apps do: by account, not by server settings.

Three ways in, shared by MailMaster senders and the Commercial Console
platform email service:

* **Google** (Gmail / Google Workspace): OAuth, see ``engagex.google_sender``.
* **Microsoft** (Outlook.com, Hotmail, Live, Microsoft 365): OAuth here; mail
  is sent through Microsoft Graph ``/me/sendMail`` with the ``Mail.Send``
  permission, so no password is ever stored.
* **Any other address** (Zoho, Yahoo, iCloud, GoDaddy, Titan, Hostinger,
  cPanel/domain mail...): the person types only their email and password.
  :func:`detect` works out the provider from the domain and its MX records and
  :func:`auto_smtp` tries that provider's SMTP servers until one accepts the
  login, so nobody has to know a host name, port or security mode.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import secrets
import smtplib
import ssl
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import HTTPException, Request

logger = logging.getLogger("mail_connect")

# ── Provider catalogue ───────────────────────────────────────────────────────
# Each candidate is (host, port, security). Order matters: most likely first.
SMTP_CANDIDATES: dict[str, list[tuple[str, int, str]]] = {
    "google": [("smtp.gmail.com", 587, "starttls"), ("smtp.gmail.com", 465, "ssl")],
    "microsoft": [("smtp.office365.com", 587, "starttls"), ("smtp-mail.outlook.com", 587, "starttls")],
    "zoho": [("smtp.zoho.in", 465, "ssl"), ("smtp.zoho.com", 465, "ssl"), ("smtppro.zoho.in", 465, "ssl"), ("smtppro.zoho.com", 465, "ssl")],
    "yahoo": [("smtp.mail.yahoo.com", 465, "ssl"), ("smtp.mail.yahoo.com", 587, "starttls")],
    "icloud": [("smtp.mail.me.com", 587, "starttls")],
    "aol": [("smtp.aol.com", 465, "ssl")],
    "rediff": [("smtp.rediffmail.com", 465, "ssl"), ("smtp.rediffmailpro.com", 465, "ssl")],
    "godaddy": [("smtpout.secureserver.net", 465, "ssl"), ("smtpout.secureserver.net", 587, "starttls")],
    "titan": [("smtp.titan.email", 465, "ssl"), ("smtp.titan.email", 587, "starttls")],
    "hostinger": [("smtp.hostinger.com", 465, "ssl"), ("smtp.hostinger.com", 587, "starttls")],
    "yandex": [("smtp.yandex.com", 465, "ssl")],
    "fastmail": [("smtp.fastmail.com", 465, "ssl")],
    "protonmail": [("smtp.protonmail.ch", 587, "starttls")],
}

PROVIDER_LABELS = {
    "google": "Gmail / Google Workspace",
    "microsoft": "Outlook / Microsoft 365",
    "zoho": "Zoho Mail",
    "yahoo": "Yahoo Mail",
    "icloud": "iCloud Mail",
    "aol": "AOL Mail",
    "rediff": "Rediffmail",
    "godaddy": "GoDaddy email",
    "titan": "Titan email",
    "hostinger": "Hostinger email",
    "yandex": "Yandex Mail",
    "fastmail": "Fastmail",
    "protonmail": "Proton Mail (Bridge)",
    "other": "Your email provider",
}

# Providers that refuse the normal account password over SMTP.
APP_PASSWORD_HELP = {
    "google": "Google blocks normal passwords here. Use “Continue with Google” instead.",
    "microsoft": "Use “Continue with Microsoft” instead, so no password is needed.",
    "yahoo": "Yahoo needs an app password: Yahoo Account → Security → Generate app password.",
    "icloud": "iCloud needs an app-specific password: appleid.apple.com → Sign-In and Security → App-Specific Passwords.",
    "aol": "AOL needs an app password: AOL Account → Security → Generate app password.",
    "zoho": "If you use two-factor sign-in, create an app password in Zoho Accounts → Security → App Passwords.",
    "protonmail": "Proton Mail only sends through Proton Mail Bridge; use the Bridge password.",
}

_DOMAINS = {
    "google": {"gmail.com", "googlemail.com"},
    "microsoft": {"outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.in", "hotmail.co.uk", "live.in", "hotmail.in", "live.co.uk", "outlook.co.uk"},
    "zoho": {"zoho.com", "zohomail.com", "zoho.in", "zohomail.in", "zoho.eu"},
    "yahoo": {"yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "rocketmail.com", "yahoo.co.uk"},
    "icloud": {"icloud.com", "me.com", "mac.com"},
    "aol": {"aol.com"},
    "rediff": {"rediffmail.com"},
    "yandex": {"yandex.com", "yandex.ru"},
    "fastmail": {"fastmail.com", "fastmail.fm"},
    "protonmail": {"proton.me", "protonmail.com", "pm.me"},
}

# MX host fragments → provider (for company domains hosted somewhere well known).
_MX_HINTS = [
    ("google.com", "google"), ("googlemail.com", "google"),
    ("protection.outlook.com", "microsoft"), ("outlook.com", "microsoft"),
    ("zoho", "zoho"),
    ("secureserver.net", "godaddy"),
    ("titan.email", "titan"),
    ("hostinger", "hostinger"),
    ("yahoodns.net", "yahoo"),
    ("icloud.com", "icloud"),
    ("yandex", "yandex"),
    ("messagingengine.com", "fastmail"),
    ("protonmail.ch", "protonmail"),
]

OAUTH_PROVIDERS = {"google", "microsoft"}


def _domain(email: str) -> str:
    return str(email or "").rsplit("@", 1)[-1].strip().lower()


async def _mx_hosts(domain: str) -> list[str]:
    try:
        import dns.asyncresolver

        resolver = dns.asyncresolver.Resolver()
        resolver.lifetime = 4.0
        answer = await resolver.resolve(domain, "MX")
        records = sorted(answer, key=lambda r: r.preference)
        return [str(r.exchange).rstrip(".").lower() for r in records]
    except Exception:
        return []


async def detect(email: str) -> dict[str, Any]:
    """Work out who hosts this mailbox and how to connect it."""
    domain = _domain(email)
    if not domain or "." not in domain:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    provider = next((p for p, names in _DOMAINS.items() if domain in names), None)
    mx: list[str] = []
    if not provider:
        mx = await _mx_hosts(domain)
        for host in mx:
            provider = next((p for fragment, p in _MX_HINTS if fragment in host), None)
            if provider:
                break
    provider = provider or "other"
    candidates = list(SMTP_CANDIDATES.get(provider, []))
    if provider == "zoho":
        # Zoho runs separate data centres; try the one the domain points at first.
        india = domain.endswith(".in") or any("zoho.in" in h for h in mx)
        candidates.sort(key=lambda c: (".in" in c[0]) != india)
    if provider == "other":
        guesses = [f"mail.{domain}", f"smtp.{domain}"] + [h for h in mx[:1]]
        for host in guesses:
            candidates += [(host, 465, "ssl"), (host, 587, "starttls")]
    return {
        "email": email.strip().lower(),
        "domain": domain,
        "provider": provider,
        "provider_label": PROVIDER_LABELS.get(provider, PROVIDER_LABELS["other"]),
        "oauth": provider if provider in OAUTH_PROVIDERS else None,
        "password_help": APP_PASSWORD_HELP.get(provider),
        "candidates": [{"host": h, "port": p, "security": s} for h, p, s in candidates],
    }


# ── SMTP auto-connect ────────────────────────────────────────────────────────
class _AuthFailed(Exception):
    pass


def _try_login(host: str, port: int, security: str, username: str, password: str, timeout: float) -> None:
    context = ssl.create_default_context()
    if security == "ssl":
        server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, context=context, timeout=timeout)
    else:
        server = smtplib.SMTP(host, port, timeout=timeout)
        server.ehlo()
        if security == "starttls":
            server.starttls(context=context)
            server.ehlo()
    try:
        try:
            server.login(username, password)
        except smtplib.SMTPAuthenticationError as exc:
            raise _AuthFailed(str(exc)) from exc
    finally:
        try:
            server.quit()
        except Exception:
            pass


async def auto_smtp(email: str, password: str, *, username: Optional[str] = None,
                    manual: Optional[dict] = None, timeout: float = 12.0,
                    max_attempts: int = 8) -> dict[str, Any]:
    """Find working SMTP settings for this mailbox; returns the SMTP config.

    ``manual`` ({host, port, security}) skips detection, for the rare server
    that cannot be guessed.
    """
    email = str(email or "").strip().lower()
    password = str(password or "").strip()
    if not password:
        raise HTTPException(status_code=400, detail="Enter the mailbox password.")
    info = await detect(email)
    if manual and manual.get("host"):
        candidates = [{"host": str(manual["host"]).strip(), "port": int(manual.get("port") or 587),
                       "security": str(manual.get("security") or "starttls")}]
    else:
        candidates = info["candidates"]
    if not candidates:
        raise HTTPException(status_code=400, detail="Could not work out the mail server for this address. Open “Advanced” and enter it.")
    login = (username or email).strip()
    deadline = time.monotonic() + 75
    auth_errors: list[str] = []
    for cand in candidates[:max_attempts]:
        if time.monotonic() > deadline:
            break
        try:
            await asyncio.to_thread(_try_login, cand["host"], cand["port"], cand["security"], login, password, timeout)
            return {**cand, "username": login, "provider": info["provider"], "provider_label": info["provider_label"]}
        except _AuthFailed as exc:
            # The right server answered and refused the password; other
            # servers for the same provider will say the same.
            auth_errors.append(str(exc))
            break
        except Exception as exc:  # unreachable / TLS mismatch: try the next one
            logger.info("SMTP candidate %s:%s failed for %s: %s", cand["host"], cand["port"], info["domain"], exc)
            continue
    if auth_errors:
        hint = info.get("password_help") or "Check the password. If the account uses two-step sign-in, create an app password for it."
        raise HTTPException(status_code=400, detail=f"The email server rejected this password. {hint}")
    raise HTTPException(status_code=400, detail=(
        f"Could not reach the mail server for {info['domain']}. "
        "Open “Advanced” and enter the outgoing (SMTP) server from your email provider."))


# ── Microsoft OAuth + Graph ──────────────────────────────────────────────────
MS_SCOPES = ["offline_access", "openid", "email", "https://graph.microsoft.com/User.Read", "https://graph.microsoft.com/Mail.Send"]
MS_GRAPH_ME = "https://graph.microsoft.com/v1.0/me"
MS_GRAPH_SEND = "https://graph.microsoft.com/v1.0/me/sendMail"
MS_STATES = "mail_connect_oauth_states"
STATE_TTL = timedelta(minutes=15)


class MicrosoftAccessRevoked(RuntimeError):
    """The refresh token no longer works; the mailbox must be reconnected."""


def _ms_tenant() -> str:
    return (os.getenv("MICROSOFT_TENANT_ID") or "common").strip() or "common"


def microsoft_configured() -> bool:
    return bool((os.getenv("MICROSOFT_CLIENT_ID") or "").strip() and (os.getenv("MICROSOFT_CLIENT_SECRET") or "").strip())


def _ms_client() -> tuple[str, str]:
    if not microsoft_configured():
        raise HTTPException(status_code=503, detail=(
            "Microsoft sign-in is not set up on the server yet (MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET). "
            "Until then, use “Other email” with your Outlook password."))
    return os.environ["MICROSOFT_CLIENT_ID"].strip(), os.environ["MICROSOFT_CLIENT_SECRET"].strip()


def _ms_token_url() -> str:
    return f"https://login.microsoftonline.com/{_ms_tenant()}/oauth2/v2.0/token"


def _this_host(request: Request) -> str:
    return (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()


def microsoft_redirect_uri(request: Request) -> str:
    configured = (os.getenv("MICROSOFT_EMAIL_REDIRECT_URI") or "").strip()
    if configured:
        return configured.rstrip("/")
    host = _this_host(request)
    if not host:
        raise HTTPException(status_code=503, detail="Unable to determine the Microsoft sign-in callback URL.")
    proto = (request.headers.get("x-forwarded-proto") or "https").split(",")[0].strip()
    return f"{proto}://{host}/api/email/oauth/microsoft/callback"


def frontend_return_url(request: Request, return_path: Optional[str], default: str) -> str:
    """Absolute URL back into the app; only same-app paths are accepted."""
    origin = (os.getenv("FRONTEND_URL") or request.headers.get("origin") or "").strip().rstrip("/")
    path = str(return_path or default).strip()
    parsed = urlparse(path)
    if parsed.scheme or parsed.netloc or not path.startswith("/"):
        path = default
    return f"{origin}{path}" if origin else path


def _raw_db():
    from backend.dependencies import _raw_db as raw

    return raw


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def microsoft_start(request: Request, *, prefix: str, company_id: str, user_id: str, return_url: str,
                          login_hint: Optional[str] = None) -> str:
    client_id, _ = _ms_client()
    redirect_uri = microsoft_redirect_uri(request)
    state = prefix + secrets.token_urlsafe(32)
    await _raw_db()[MS_STATES].insert_one({
        "state": state, "company_id": company_id, "user_id": user_id, "redirect_uri": redirect_uri,
        "return_url": return_url, "created_at": _now().isoformat(), "expires_at": (_now() + STATE_TTL).isoformat(),
    })
    params = {
        "client_id": client_id, "response_type": "code", "redirect_uri": redirect_uri, "response_mode": "query",
        "scope": " ".join(MS_SCOPES), "state": state, "prompt": "select_account",
    }
    if login_hint:
        params["login_hint"] = login_hint
    return f"https://login.microsoftonline.com/{_ms_tenant()}/oauth2/v2.0/authorize?{urlencode(params)}"


async def microsoft_finish(*, state: str, code: Optional[str], error: Optional[str], error_description: Optional[str] = None) -> dict[str, Any]:
    """Exchange the code. Returns {state_doc, email, refresh_token} or {state_doc, error}."""
    doc = await _raw_db()[MS_STATES].find_one_and_delete({"state": state})
    if not doc:
        return {"state_doc": None, "error": "The Microsoft sign-in expired. Please try again."}
    if str(doc.get("expires_at") or "") < _now().isoformat():
        return {"state_doc": doc, "error": "The Microsoft sign-in expired. Please try again."}
    if error:
        cancelled = error in {"access_denied", "consent_required"}
        message = "Microsoft sign-in was cancelled." if cancelled else (error_description or "Microsoft sign-in failed.")
        if "AADSTS65001" in str(error_description or "") or "admin" in str(error_description or "").lower():
            message = "Your organisation's Microsoft admin must approve this app before it can send mail."
        return {"state_doc": doc, "error": message[:200], "cancelled": cancelled}
    if not code:
        return {"state_doc": doc, "error": "Microsoft did not return an authorisation code."}
    client_id, client_secret = _ms_client()
    async with httpx.AsyncClient(timeout=25) as client:
        res = await client.post(_ms_token_url(), data={
            "client_id": client_id, "client_secret": client_secret, "grant_type": "authorization_code",
            "code": code, "redirect_uri": doc["redirect_uri"], "scope": " ".join(MS_SCOPES),
        })
        if res.status_code != 200:
            logger.warning("Microsoft token exchange failed: %s %s", res.status_code, res.text[:300])
            return {"state_doc": doc, "error": "Microsoft sign-in failed. Please try again."}
        tokens = res.json()
        granted = str(tokens.get("scope") or "")
        if "Mail.Send" not in granted:
            return {"state_doc": doc, "error": "Please allow “Send mail as you” so emails can be sent."}
        if not tokens.get("refresh_token"):
            return {"state_doc": doc, "error": "Microsoft did not grant offline access. Please try again."}
        me = await client.get(MS_GRAPH_ME, headers={"Authorization": f"Bearer {tokens['access_token']}"},
                              params={"$select": "mail,userPrincipalName,displayName"})
    if me.status_code != 200:
        return {"state_doc": doc, "error": "Could not read the Microsoft account's email address."}
    profile = me.json()
    email = str(profile.get("mail") or profile.get("userPrincipalName") or "").strip().lower()
    if "@" not in email:
        return {"state_doc": doc, "error": "This Microsoft account has no mailbox."}
    return {"state_doc": doc, "email": email, "display_name": profile.get("displayName") or "",
            "refresh_token": tokens["refresh_token"], "scopes": granted.split()}


class GraphSession:
    """Sends raw MIME through Microsoft Graph for one connected mailbox."""

    def __init__(self, refresh_token: str, on_rotate: Optional[Callable[[str], Awaitable[None]]] = None,
                 transport: Optional[httpx.AsyncBaseTransport] = None):
        self.refresh_token = refresh_token
        self.on_rotate = on_rotate
        self._token: Optional[str] = None
        self._expires = 0.0
        self._client = httpx.AsyncClient(timeout=60, transport=transport)

    async def _access_token(self, force: bool = False) -> str:
        if self._token and not force and time.monotonic() < self._expires - 60:
            return self._token
        client_id, client_secret = _ms_client()
        res = await self._client.post(_ms_token_url(), data={
            "client_id": client_id, "client_secret": client_secret, "grant_type": "refresh_token",
            "refresh_token": self.refresh_token, "scope": " ".join(MS_SCOPES),
        })
        if res.status_code in (400, 401) and "invalid_grant" in res.text:
            raise MicrosoftAccessRevoked("Microsoft access was revoked or expired. Reconnect this Outlook account.")
        if res.status_code != 200:
            raise RuntimeError(f"Microsoft token refresh failed ({res.status_code}).")
        data = res.json()
        self._token = data["access_token"]
        self._expires = time.monotonic() + float(data.get("expires_in") or 3600)
        rotated = data.get("refresh_token")
        if rotated and rotated != self.refresh_token:
            self.refresh_token = rotated
            if self.on_rotate:
                try:
                    await self.on_rotate(rotated)
                except Exception:  # pragma: no cover - persistence best effort
                    logger.exception("Could not store the rotated Microsoft refresh token")
        return self._token

    async def send(self, from_email: str, to_email: str, message: str) -> None:
        body = base64.b64encode(message.encode("utf-8"))
        for attempt in (1, 2):
            token = await self._access_token(force=attempt == 2)
            res = await self._client.post(MS_GRAPH_SEND, content=body, headers={
                "Authorization": f"Bearer {token}", "Content-Type": "text/plain"})
            if res.status_code in (200, 202):
                return
            if res.status_code == 401 and attempt == 1:
                continue
            try:
                detail = res.json().get("error", {}).get("message") or res.text
            except Exception:
                detail = res.text
            if res.status_code == 403:
                raise MicrosoftAccessRevoked("This Microsoft account did not grant permission to send mail. Reconnect it and allow sending.")
            raise RuntimeError(f"Outlook rejected the message: {str(detail)[:300]}")

    async def close(self) -> None:
        await self._client.aclose()


def build_simple_mime(*, from_name: str, from_email: str, to_email: str, subject: str, body_plain: str,
                      body_html: Optional[str], reply_to: Optional[str], attachments: Optional[list]) -> str:
    """MIME for the platform email service when it sends through a connected account."""
    import email.utils
    from email import encoders
    from email.mime.base import MIMEBase
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText

    files = [a for a in (attachments or []) if a and a.get("content")]
    msg = MIMEMultipart("mixed" if files else "alternative")
    msg["Subject"] = subject
    msg["From"] = email.utils.formataddr((from_name, from_email)) if from_name else from_email
    msg["To"] = to_email
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=(from_email.split("@")[-1] or None))
    if reply_to:
        msg["Reply-To"] = reply_to
    body = MIMEMultipart("alternative") if files else msg
    body.attach(MIMEText(body_plain or "", "plain", "utf-8"))
    if body_html:
        body.attach(MIMEText(body_html, "html", "utf-8"))
    if files:
        msg.attach(body)
        for att in files:
            maintype, _, subtype = str(att.get("type") or "application/octet-stream").partition("/")
            part = MIMEBase(maintype or "application", subtype or "octet-stream")
            part.set_payload(base64.b64decode(att["content"]))
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=att.get("name") or "attachment")
            msg.attach(part)
    return msg.as_string()
