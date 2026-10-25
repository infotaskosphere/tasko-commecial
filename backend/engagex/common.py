"""Shared EngageX helpers: tenancy, permissions, normalisation and merge tags.

Storage model
-------------
EngageX control records (campaigns, recipients, sender accounts, lists,
contacts, templates, suppressions) live in the *central* database so that the
background delivery worker can discover every tenant's queued campaigns. Every
read and write therefore goes through :func:`scoped`, which pins the
``company_id`` server-side; a client-supplied company id is never trusted.

Per-message WhatsApp history is still written to the tenant-routed
``whatsapp_messages`` collection (so it also appears in the existing WhatsApp
History screens); the worker restores the campaign's captured tenant context
before doing so, see :func:`tenant_context`.
"""
from __future__ import annotations

import base64
import hashlib
import html
import os
import re
import secrets
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

from fastapi import HTTPException, Request

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner

# ── Collections (central database) ───────────────────────────────────────────
CAMPAIGNS = "engagex_campaigns"
RECIPIENTS = "engagex_recipients"
SENDERS = "engagex_email_senders"
LISTS = "engagex_lists"
CONTACTS = "engagex_contacts"
TEMPLATES = "engagex_templates"
SUPPRESSIONS = "engagex_suppressions"
MEDIA = "engagex_media"

PLATFORM_SENDER_ID = "platform"

PAGE_DASHBOARD = "can_view_engagex_dashboard"
PAGE_WHATSAPP = "can_view_engagex_whatsapp"
PAGE_MAIL = "can_view_engagex_mailmaster"

CAMPAIGN_ACTIVE = ("queued", "scheduled", "running", "paused")
CAMPAIGN_FINAL = ("completed", "cancelled", "failed")

_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$")
_MERGE_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|\s*([^}]*?))?\s*\}\}")


def raw_db():
    """Central (unscoped) Motor database. Callers MUST filter by company_id."""
    database = getattr(_dependencies, "_raw_db", None)
    # Motor databases forbid truth-value testing; compare with None explicitly.
    return database if database is not None else _dependencies.db


def tenant_db():
    """Request/tenant-routed database facade (used for tenant collections)."""
    return _dependencies.db


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: Optional[datetime] = None) -> str:
    return (value or utcnow()).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:20]}"


def new_token() -> str:
    return secrets.token_urlsafe(18)


# ── Tenancy ──────────────────────────────────────────────────────────────────
def workspace_company_id(user: Any) -> str:
    """The operational company the request acts for (resolved by auth)."""
    from backend.tenant_runtime import authenticated_company_id

    company_id = str(authenticated_company_id() or getattr(user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="Your account is not linked to a company workspace.")
    return company_id


def scoped(company_id: str, query: Optional[Mapping[str, Any]] = None) -> dict:
    """Pin a query to one company. A conflicting company_id is a hard error."""
    base = dict(query or {})
    requested = base.get("company_id")
    if requested is not None and requested != company_id:
        raise HTTPException(status_code=403, detail="Cross-company access is not permitted.")
    base["company_id"] = company_id
    return base


def capture_tenant_context(user: Any) -> dict:
    """Snapshot the auth-resolved tenant routing so the worker can restore it."""
    from backend.tenant_runtime import authenticated_tenant_database_name, platform_owner_company_ids

    try:
        from backend.commercial_tenant_scope import authenticated_customer_id

        customer_id = authenticated_customer_id()
    except Exception:
        customer_id = None
    company_id = workspace_company_id(user)
    owner = bool(is_platform_owner(user))
    return {
        "company_id": company_id,
        "customer_id": str(customer_id or getattr(user, "commercial_customer_id", "") or "") or None,
        "tenant_database": authenticated_tenant_database_name(),
        "platform_owner": owner,
        "owner_company_ids": sorted(platform_owner_company_ids()) if owner else [],
    }


@contextmanager
def tenant_context(ctx: Mapping[str, Any]):
    """Re-establish a captured tenant context outside a request (worker)."""
    from backend.tenant_runtime import (
        reset_authenticated_company,
        reset_authenticated_tenant_database,
        reset_platform_owner,
        reset_platform_owner_company_ids,
        set_authenticated_company,
        set_authenticated_tenant_database,
        set_platform_owner,
        set_platform_owner_company_ids,
    )

    tokens = []
    customer_reset = None
    try:
        try:
            from backend.commercial_tenant_scope import reset_authenticated_customer, set_authenticated_customer

            if ctx.get("customer_id"):
                token = set_authenticated_customer(ctx["customer_id"])
                customer_reset = (reset_authenticated_customer, token)
        except Exception:
            customer_reset = None
        tokens.append((reset_authenticated_company, set_authenticated_company(ctx["company_id"])))
        tokens.append((reset_authenticated_tenant_database, set_authenticated_tenant_database(ctx.get("tenant_database"))))
        owner = bool(ctx.get("platform_owner"))
        tokens.append((reset_platform_owner, set_platform_owner(owner)))
        tokens.append((
            reset_platform_owner_company_ids,
            set_platform_owner_company_ids(ctx.get("owner_company_ids") or ([ctx["company_id"]] if owner else [])),
        ))
        yield
    finally:
        for reset, token in reversed(tokens):
            try:
                reset(token)
            except Exception:
                pass
        if customer_reset:
            try:
                customer_reset[0](customer_reset[1])
            except Exception:
                pass


# ── Permissions ──────────────────────────────────────────────────────────────
def _role(user: Any) -> str:
    role = getattr(user, "role", "")
    return str(getattr(role, "value", role) or "").strip().lower()


def is_admin(user: Any) -> bool:
    return is_platform_owner(user) or _role(user) == "admin"


def has_page(user: Any, flag: str) -> bool:
    """Defense in depth; the commercial module guard already caps tenants."""
    if is_platform_owner(user):
        return True
    permissions = getattr(user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()
    permissions = permissions or {}
    return bool(permissions.get(flag)) or bool(permissions.get("can_access_engagex") and _role(user) == "admin")


def require_page(user: Any, *flags: str) -> None:
    if not any(has_page(user, flag) for flag in flags):
        raise HTTPException(status_code=403, detail="You do not have access to this EngageX page.")


def require_admin_user(user: Any) -> None:
    if not is_admin(user):
        raise HTTPException(status_code=403, detail="Only an administrator can manage email sender accounts.")


# ── Normalisation ────────────────────────────────────────────────────────────
def normalize_phone(raw: Any, default_country: str = "91") -> Optional[str]:
    digits = re.sub(r"\D", "", str(raw or ""))
    if digits.startswith("00"):
        digits = digits[2:]
    if len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if len(digits) == 10 and default_country:
        digits = f"{default_country}{digits}"
    if len(digits) < 10 or len(digits) > 15:
        return None
    return digits


def normalize_email(raw: Any) -> Optional[str]:
    value = str(raw or "").strip().strip("<>").lower()
    return value if value and len(value) <= 254 and _EMAIL_RE.match(value) else None


def first_name(name: Any) -> str:
    parts = str(name or "").strip().split()
    return parts[0] if parts else ""


def clean_text(value: Any, limit: int = 500) -> str:
    return str(value or "").strip()[:limit]


# ── Merge tags ───────────────────────────────────────────────────────────────
def merge_variables(recipient: Mapping[str, Any], sender_company: str = "") -> dict:
    variables = {str(k): v for k, v in dict(recipient.get("variables") or {}).items()}
    name = recipient.get("name") or variables.get("name") or ""
    variables.setdefault("name", name)
    variables.setdefault("first_name", first_name(name))
    variables.setdefault("email", recipient.get("email") or "")
    variables.setdefault("phone", recipient.get("phone") or "")
    variables.setdefault("company", recipient.get("company") or variables.get("client_name") or "")
    variables.setdefault("client_name", recipient.get("company") or "")
    variables.setdefault("sender_company", sender_company)
    variables.setdefault("date", utcnow().astimezone().strftime("%d %b %Y"))
    return variables


def render_merge(template: str, variables: Mapping[str, Any], *, escape_html: bool = False) -> str:
    """Replace ``{{tag}}`` / ``{{tag|fallback}}``; unknown tags use the fallback."""

    def _sub(match: re.Match) -> str:
        key, fallback = match.group(1), match.group(2)
        value = variables.get(key)
        text = str(value) if value not in (None, "") else (fallback or "").strip()
        return html.escape(text) if escape_html else text

    return _MERGE_RE.sub(_sub, str(template or ""))


def merge_tags_in(*texts: str) -> list[str]:
    found: list[str] = []
    for text in texts:
        for match in _MERGE_RE.finditer(str(text or "")):
            if match.group(1) not in found:
                found.append(match.group(1))
    return found


# ── Secrets (SMTP passwords) ─────────────────────────────────────────────────
def _fernet():
    from cryptography.fernet import Fernet

    key = os.getenv("ENGAGEX_ENCRYPT_KEY") or os.getenv("EMAIL_ENCRYPT_KEY") or ""
    if len(key) == 44:
        try:
            return Fernet(key.encode())
        except Exception:
            pass
    # Stable fallback: derived from the deployment's JWT secret so stored
    # credentials survive restarts (a random runtime key would not).
    secret = os.getenv("JWT_SECRET") or ""
    if not secret:
        raise HTTPException(status_code=503, detail="Credential encryption is not configured on the server.")
    digest = hashlib.sha256(("engagex-smtp:" + secret).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(plain: str) -> str:
    return _fernet().encrypt(str(plain or "").encode()).decode()


def decrypt_secret(cipher: str) -> str:
    if not cipher:
        return ""
    try:
        return _fernet().decrypt(str(cipher).encode()).decode()
    except Exception as exc:  # pragma: no cover - key rotation / corruption
        raise HTTPException(status_code=400, detail="Stored sender password cannot be decrypted; please re-enter it.") from exc


def mask_email(value: str) -> str:
    local, _, domain = str(value or "").partition("@")
    if not domain:
        return value
    return f"{local[:2]}{'*' * max(1, len(local) - 2)}@{domain}"


# ── Public URLs (unsubscribe / open tracking) ────────────────────────────────
def public_base_url(request: Optional[Request]) -> str:
    configured = (
        os.getenv("ENGAGEX_PUBLIC_BASE_URL")
        or os.getenv("PUBLIC_BACKEND_URL")
        or os.getenv("BACKEND_PUBLIC_URL")
        or os.getenv("RENDER_EXTERNAL_URL")
        or ""
    ).strip().rstrip("/")
    if configured:
        return configured
    if request is None:
        return ""
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "https").split(",")[0].strip()
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc).split(",")[0].strip()
    return f"{proto}://{host}".rstrip("/")


async def company_profile(company_id: str) -> dict:
    """Display name + contact email of the sending company."""
    doc = await raw_db().companies.find_one(
        {"id": company_id},
        {"_id": 0, "name": 1, "company_name": 1, "legal_name": 1, "email": 1, "contact_email": 1},
    ) or {}
    name = doc.get("name") or doc.get("company_name") or doc.get("legal_name") or ""
    email = normalize_email(doc.get("email") or doc.get("contact_email"))
    return {"name": str(name).strip(), "email": email}


def serialize(doc: Optional[Mapping[str, Any]], drop: Iterable[str] = ()) -> Optional[dict]:
    if doc is None:
        return None
    out = {k: v for k, v in dict(doc).items() if k != "_id" and k not in set(drop)}
    for key, value in list(out.items()):
        if isinstance(value, datetime):
            out[key] = value.isoformat()
    return out
