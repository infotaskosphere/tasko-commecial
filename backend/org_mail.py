"""Organisation mailbox: connect email once in Settings, every module uses it.

An organisation connects its mailbox in Settings → Email (Google, Microsoft or
any other mailbox with an app password). The connected accounts are the same
records EngageX MailMaster calls "Senders", so the list is shared. The one
marked default is the organisation mailbox; the first one connected becomes
the default automatically.

Mailboxes are either *organisation* mailboxes (admins connect them; every
user may send from them; one is the default) or *personal* mailboxes (any
user connects their own under "My mailboxes"; only that user can send from
them; never used by background jobs or EngageX campaigns).

Every module that emails clients sends through :func:`send_org_email`:
invoices, quotations, bulk client email, compliance client email, task
reminders and client-portal codes. A caller may pass ``sender_id`` to send
from another of the organisation's connected mailboxes ("Send from").

With no mailbox connected yet, mail goes out through the platform email
service under the organisation's name, with replies going to the
organisation's email. Security email (staff password reset, login alerts,
licence and staff invites) always stays on the platform service.
"""
from __future__ import annotations

import base64
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend.dependencies import get_current_user
from backend.engagex.common import (
    PLATFORM_SENDER_ID,
    SENDERS,
    clean_text,
    company_profile,
    iso,
    is_admin,
    normalize_email,
    raw_db,
    require_admin_user,
    scoped,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/organisation-email", tags=["Organisation email"])

SETTINGS_RETURN_PATH = "/settings/general?tab=integrations"
USED_BY = [
    "Invoices", "Quotations", "Client emails (bulk)", "Compliance client emails",
    "Task reminders", "Client portal codes", "EngageX MailMaster",
]
NOT_CONNECTED_HINT = "Connect your organisation's email in Settings → Organisation Email."


# ── Sending ────────────────────────────────────────────────────────────────────

def attachment(name: str, content: bytes, mime_type: str = "application/octet-stream") -> dict:
    """Attachment in the shape the mail senders expect."""
    return {"name": name, "type": mime_type, "content": base64.b64encode(content).decode()}


async def default_sender_id(company_id: str) -> Optional[str]:
    doc = await raw_db()[SENDERS].find_one(
        {"company_id": company_id, "deleted": {"$ne": True}, "is_default": True, "owner_user_id": None}, {"_id": 0, "id": 1}
    )
    return doc["id"] if doc else None


async def has_connected_mailbox(company_id: str) -> bool:
    return bool(await default_sender_id(company_id))


async def resolve_org_sender(company_id: str, sender_id: Optional[str] = None, acting_user_id: Optional[str] = None):
    """The mailbox to send from: the requested one, else the organisation default, else the platform."""
    from backend.engagex.mailer import platform_sender, resolve_sender

    chosen = sender_id or await default_sender_id(company_id)
    if chosen and chosen != PLATFORM_SENDER_ID:
        return await resolve_sender(company_id, chosen, acting_user_id=acting_user_id)
    # Platform fallback: always under the organisation's own name / Reply-To.
    return await platform_sender(company_id)


async def send_org_email(
    *,
    company_id: str,
    to_email: str,
    subject: str,
    html_body: str,
    text_body: Optional[str] = None,
    attachments: Optional[list] = None,
    sender_id: Optional[str] = None,
    reply_to: Optional[str] = None,
    fallback_reply_to: Optional[str] = None,
    from_name: Optional[str] = None,
    email_type: str = "organisation",
    acting_user_id: Optional[str] = None,
) -> dict:
    """Send one email from the organisation's mailbox. Raises HTTPException on failure."""
    from backend.engagex.mailer import html_to_text, open_session, send_one

    company_id = str(company_id or "").strip()
    if not company_id:
        raise HTTPException(status_code=400, detail="This email has no organisation to send from.")
    recipient = normalize_email(to_email)
    if not recipient:
        raise HTTPException(status_code=400, detail=f"Not a valid email address: {to_email!r}")
    sender = await resolve_org_sender(company_id, sender_id, acting_user_id)
    if reply_to:
        sender.reply_to = normalize_email(reply_to) or sender.reply_to
    elif fallback_reply_to and sender.kind == "platform":
        # Platform fallback: replies go to the organisation, never to the platform.
        sender.reply_to = normalize_email(fallback_reply_to) or sender.reply_to
    if from_name:
        sender.from_name = clean_text(from_name, 120) or sender.from_name
    session = open_session(sender)
    try:
        await send_one(
            sender=sender,
            session=session,
            to_email=recipient,
            subject=subject,
            html_body=html_body or "",
            text_body=text_body if text_body is not None else html_to_text(html_body or ""),
            attachments=attachments or None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        reason = str(exc) or exc.__class__.__name__
        if sender.kind != "platform":
            await raw_db()[SENDERS].update_one(
                {"company_id": company_id, "id": sender.id}, {"$set": {"last_error": reason[:300], "updated_at": iso()}}
            )
            detail = f"Could not send from {sender.from_email}: {reason}. Check the mailbox in Settings → Organisation Email."
        else:
            detail = f"The email could not be sent: {reason}. {NOT_CONNECTED_HINT}"
        logger.warning("Organisation email (%s) for company %s failed via %s: %s", email_type, company_id, sender.kind, reason)
        raise HTTPException(status_code=502, detail=detail) from exc
    finally:
        close = getattr(session, "close", None)
        if close:
            try:
                await close()
            except Exception:
                pass
    if sender.kind != "platform":
        await raw_db()[SENDERS].update_one(
            {"company_id": company_id, "id": sender.id}, {"$set": {"last_error": None, "last_sent_at": iso()}}
        )
    return {"sent": True, "sender_id": sender.id, "from_email": sender.from_email, "kind": sender.kind}


# ── Settings → Integrations → Email ───────────────────────────────────────────

def _company(user) -> str:
    from backend.engagex.common import workspace_company_id

    return workspace_company_id(user)


def _public(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "kind": doc.get("kind") or "smtp",
        "label": doc.get("label") or doc.get("from_email"),
        "from_name": doc.get("from_name"),
        "from_email": doc.get("from_email"),
        "reply_to": doc.get("reply_to"),
        "is_default": bool(doc.get("is_default")) and not doc.get("owner_user_id"),
        "personal": bool(doc.get("owner_user_id")),
        "last_error": doc.get("last_error"),
        "last_sent_at": doc.get("last_sent_at"),
        "connected_at": doc.get("verified_at") or doc.get("created_at"),
    }


@router.get("/status")
async def org_email_status(current_user=Depends(get_current_user)):
    """The organisation's connected mailboxes (any staff member may read this, e.g. for "Send from")."""
    from backend.engagex.mailer import platform_sender

    company_id = _company(current_user)
    me = str(current_user.id)
    docs = await raw_db()[SENDERS].find(
        scoped(company_id, {"deleted": {"$ne": True}, "$or": [{"owner_user_id": None}, {"owner_user_id": me}]}),
        {"_id": 0},
    ).sort("created_at", 1).to_list(100)
    organisation = [_public(d) for d in docs if not d.get("owner_user_id")]
    personal = [_public(d) for d in docs if d.get("owner_user_id")]
    mailboxes = organisation + personal
    default = next((m for m in organisation if m["is_default"]), None)
    platform = await platform_sender(company_id)
    profile = await company_profile(company_id)
    return {
        "connected": bool(default),
        "default_sender_id": default["id"] if default else PLATFORM_SENDER_ID,
        "default_from_email": default["from_email"] if default else platform.from_email,
        "mailboxes": mailboxes,  # organisation first, then the caller's personal mailboxes
        "organisation_mailboxes": organisation,
        "my_mailboxes": personal,
        "fallback": {
            "id": PLATFORM_SENDER_ID,
            "label": "Platform email service",
            "from_email": platform.from_email,
            "from_name": platform.from_name,
            "reply_to": platform.reply_to or profile.get("email"),
        },
        "used_by": USED_BY,
        "can_manage": is_admin(current_user),
    }


class _StartIn(BaseModel):
    return_path: str = Field(SETTINGS_RETURN_PATH, max_length=300)
    login_hint: Optional[str] = Field(None, max_length=254)
    personal: bool = False  # True → "My mailboxes" (any user); False → organisation (admins)


def _owner_for(body, current_user) -> Optional[str]:
    """Personal mailboxes: any user, for themselves. Organisation mailboxes: admins."""
    if getattr(body, "personal", False):
        return str(current_user.id)
    require_admin_user(current_user)
    return None


@router.post("/google/start")
async def org_email_google_start(body: _StartIn, request: Request, current_user=Depends(get_current_user)):
    owner = _owner_for(body, current_user)
    from backend.engagex.google_sender import start

    return {"auth_url": await start(request, current_user, _company(current_user), body.return_path,
                                    login_hint=normalize_email(body.login_hint) or None, owner_user_id=owner)}


@router.post("/microsoft/start")
async def org_email_microsoft_start(body: _StartIn, request: Request, current_user=Depends(get_current_user)):
    owner = _owner_for(body, current_user)
    from backend import mail_connect

    if not mail_connect.microsoft_configured():
        raise HTTPException(status_code=503, detail="Microsoft sign-in is not configured on this server yet. Use “Other email” with an app password.")
    return_url = mail_connect.frontend_return_url(request, body.return_path, SETTINGS_RETURN_PATH)
    url = await mail_connect.microsoft_start(request, prefix="exm.", company_id=_company(current_user),
                                             user_id=str(current_user.id), return_url=return_url,
                                             login_hint=normalize_email(body.login_hint) or None,
                                             owner_user_id=owner)
    return {"auth_url": url}


@router.get("/detect")
async def org_email_detect(email: str, current_user=Depends(get_current_user)):
    from backend import mail_connect

    address = normalize_email(email)
    if not address:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    info = await mail_connect.detect(address)
    info["microsoft_available"] = mail_connect.microsoft_configured()
    return info


class _ConnectIn(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=1, max_length=512)
    from_name: Optional[str] = Field(None, max_length=120)
    smtp_host: Optional[str] = Field(None, max_length=255)
    smtp_port: Optional[int] = Field(None, ge=1, le=65535)
    security: Optional[str] = Field(None, pattern="^(starttls|ssl|none)$")
    personal: bool = False


@router.post("/connect")
async def org_email_connect(body: _ConnectIn, current_user=Depends(get_current_user)):
    """Any other mailbox: address + app password; the server settings are found automatically."""
    owner = _owner_for(body, current_user)
    from backend import mail_connect
    from backend.engagex.connected_senders import save_smtp_sender

    address = normalize_email(body.email)
    if not address:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    manual = None
    if body.smtp_host and body.smtp_host.strip():
        manual = {"host": body.smtp_host.strip(), "port": body.smtp_port or 587, "security": body.security or "starttls"}
    cfg = await mail_connect.auto_smtp(address, body.password, manual=manual)
    doc = await save_smtp_sender(company_id=_company(current_user), user_id=str(current_user.id), email=address,
                                 password=cfg.get("password") or body.password, cfg=cfg,
                                 from_name=clean_text(body.from_name or "", 120) or None, label=None,
                                 owner_user_id=owner)
    return _public(doc)


@router.post("/{sender_id}/default")
async def org_email_set_default(sender_id: str, current_user=Depends(get_current_user)):
    require_admin_user(current_user)
    company_id = _company(current_user)
    if sender_id != PLATFORM_SENDER_ID:
        if not await raw_db()[SENDERS].find_one(
            scoped(company_id, {"id": sender_id, "deleted": {"$ne": True}, "owner_user_id": None}), {"_id": 1}
        ):
            raise HTTPException(status_code=404, detail="Mailbox not found.")
    await raw_db()[SENDERS].update_many(scoped(company_id), {"$set": {"is_default": False}})
    if sender_id != PLATFORM_SENDER_ID:
        await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender_id}), {"$set": {"is_default": True}})
    return {"default_sender_id": sender_id}


async def _manageable(company_id: str, sender_id: str, current_user) -> Optional[dict]:
    """Organisation mailboxes: admins. Personal mailboxes: only their owner."""
    doc = await raw_db()[SENDERS].find_one(scoped(company_id, {"id": sender_id, "deleted": {"$ne": True}}), {"_id": 0})
    if not doc:
        return None
    owner = doc.get("owner_user_id")
    if owner:
        if str(owner) != str(current_user.id):
            return None  # someone else's personal mailbox: not visible
        return doc
    require_admin_user(current_user)
    return doc


class _ProfileIn(BaseModel):
    from_name: Optional[str] = Field(None, max_length=120)
    reply_to: Optional[str] = Field(None, max_length=254)


@router.patch("/{sender_id}")
async def org_email_update(sender_id: str, body: _ProfileIn, current_user=Depends(get_current_user)):
    company_id = _company(current_user)
    doc = await _manageable(company_id, sender_id, current_user)
    if not doc:
        raise HTTPException(status_code=404, detail="Mailbox not found.")
    if body.reply_to and not normalize_email(body.reply_to):
        raise HTTPException(status_code=400, detail="Enter a valid Reply-To address.")
    updates: dict[str, Any] = {"updated_at": iso()}
    if body.from_name is not None:
        updates["from_name"] = clean_text(body.from_name, 120) or doc.get("from_name")
    if body.reply_to is not None:
        updates["reply_to"] = normalize_email(body.reply_to) or None
    await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender_id}), {"$set": updates})
    return _public({**doc, **updates})


@router.delete("/{sender_id}")
async def org_email_remove(sender_id: str, current_user=Depends(get_current_user)):
    company_id = _company(current_user)
    doc = await _manageable(company_id, sender_id, current_user)
    if not doc:
        raise HTTPException(status_code=404, detail="Mailbox not found.")
    await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender_id}), {"$set": {
        "deleted": True, "is_default": False, "password_enc": None, "refresh_token_enc": None, "updated_at": iso()}})
    if doc.get("is_default") and not doc.get("owner_user_id"):
        # Promote the next organisation mailbox, so "universal" email keeps working.
        nxt = await raw_db()[SENDERS].find_one(scoped(company_id, {"deleted": {"$ne": True}, "owner_user_id": None}), {"_id": 0, "id": 1}, sort=[("created_at", 1)])
        if nxt:
            await raw_db()[SENDERS].update_one(scoped(company_id, {"id": nxt["id"]}), {"$set": {"is_default": True}})
    return {"removed": True}
