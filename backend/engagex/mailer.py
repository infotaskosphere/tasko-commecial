"""MailMaster delivery: platform email service (default) or a company's own SMTP account.

* ``platform`` sender: the Commercial Console's central email service, sending
  with the company's name as the From name and the company's email as Reply-To.
* custom sender: any mailbox the company adds (Gmail/Workspace app password,
  Outlook/Microsoft 365, Zoho, SES/SendGrid/Brevo SMTP relays, cPanel mail...).
  Messages carry RFC 8058 one-click ``List-Unsubscribe`` headers.
"""
from __future__ import annotations

import asyncio
import base64
import email.utils
import html as _html
import logging
import re
import smtplib
import ssl
from dataclasses import dataclass, field
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email import encoders
from email.mime.text import MIMEText
from typing import Any, Optional

from fastapi import HTTPException

from .common import (
    PLATFORM_SENDER_ID,
    PLATFORM_SENDER_PREFS,
    SENDERS,
    company_profile,
    decrypt_secret,
    normalize_email,
    raw_db,
)

logger = logging.getLogger("engagex.mailer")

SMTP_TIMEOUT = 30


@dataclass
class ResolvedSender:
    id: str
    label: str
    from_name: str
    from_email: str
    reply_to: Optional[str]
    kind: str  # "platform" | "smtp" | "google" | "microsoft"
    smtp: dict = field(default_factory=dict)
    oauth: dict = field(default_factory=dict)
    daily_limit: Optional[int] = None  # optional lower per-sender daily cap

    def limits(self):
        """Known daily/pace limits for this mailbox (None: no known cap)."""
        from .deliverability import mailbox_limits

        if self.kind == "platform":
            return None
        return mailbox_limits(self.kind, self.from_email, (self.smtp or {}).get("host") or "", self.daily_limit)


# ── HTML helpers ─────────────────────────────────────────────────────────────
_TAG_RE = re.compile(r"<[^>]+>")


def html_to_text(markup: str) -> str:
    text = re.sub(r"(?is)<(script|style|head).*?</\1>", " ", str(markup or ""))
    text = re.sub(r"(?i)<br\s*/?>", "\n", text)
    text = re.sub(r"(?i)</(p|div|h[1-6]|li|tr|table|section)>", "\n", text)
    text = re.sub(r'(?is)<a [^>]*href="([^"]+)"[^>]*>(.*?)</a>', r"\2 (\1)", text)
    text = _html.unescape(_TAG_RE.sub("", text))
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()


def banner_html(banner: Optional[dict]) -> str:
    """Full-width hero image (hosted URL), optionally linked."""
    url = str((banner or {}).get("url") or "").strip()
    if not url.lower().startswith(("https://", "http://")):
        return ""
    alt = _html.escape(str((banner or {}).get("alt") or ""))
    img = (f'<img src="{_html.escape(url)}" alt="{alt}" width="640" '
           'style="display:block;width:100%;max-width:640px;height:auto;border:0;outline:none;text-decoration:none" />')
    link = str((banner or {}).get("link") or "").strip()
    if link.lower().startswith(("https://", "http://", "mailto:", "tel:")):
        img = f'<a href="{_html.escape(link)}" target="_blank">{img}</a>'
    return img


def build_email_html(*, body_html: str, preview_text: str, footer_company: str, footer_address: str,
                     unsubscribe_url: str, open_pixel_url: str, banner: Optional[dict] = None) -> str:
    """Wrap campaign content in a responsive, client-safe shell with a footer."""
    preheader = (
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">{_html.escape(preview_text)}</div>'
        if preview_text else ""
    )
    pixel = f'<img src="{_html.escape(open_pixel_url)}" width="1" height="1" alt="" style="display:block;border:0" />' if open_pixel_url else ""
    unsubscribe = (
        f'<a href="{_html.escape(unsubscribe_url)}" style="color:#64748b;text-decoration:underline">Unsubscribe</a>'
        if unsubscribe_url else ""
    )
    address = f"<br />{_html.escape(footer_address)}" if footer_address else ""
    hero = banner_html(banner)
    content = body_html or ""
    if re.search(r"(?i)<body[^>]*>", content):
        # A full HTML document: inject preheader/footer inside its body.
        footer = (
            f'<div style="padding:24px 16px;text-align:center;font:12px/1.6 Arial,sans-serif;color:#64748b">'
            f'Sent by {_html.escape(footer_company)}{address}<br />{unsubscribe}</div>{pixel}'
        )
        content = re.sub(r"(?i)(<body[^>]*>)", r"\1" + (preheader + hero).replace("\\", "\\\\"), content, count=1)
        return re.sub(r"(?i)</body>", footer.replace("\\", "\\\\") + "</body>", content, count=1)
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"></head>
<body style="margin:0;padding:0;background:#f1f5f9">{preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border-radius:12px;overflow:hidden">
{f'<tr><td style="padding:0;line-height:0">{hero}</td></tr>' if hero else ''}<tr><td style="padding:32px 32px 24px;font:15px/1.65 Arial,Helvetica,sans-serif;color:#0f172a">{content}</td></tr>
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px"><tr>
<td style="padding:20px 16px;text-align:center;font:12px/1.6 Arial,Helvetica,sans-serif;color:#64748b">
Sent by {_html.escape(footer_company)}{address}<br />You received this email because you are in contact with {_html.escape(footer_company)}.<br />{unsubscribe}
</td></tr></table>{pixel}
</td></tr></table></body></html>"""


# ── Sender resolution ────────────────────────────────────────────────────────
async def platform_sender_prefs(company_id: str) -> dict:
    """This company's settings for the shared platform sender: optional
    from_name / reply_to / label overrides and whether it was removed."""
    doc = await raw_db()[PLATFORM_SENDER_PREFS].find_one({"company_id": company_id}, {"_id": 0}) or {}
    return doc


async def platform_sender(company_id: str) -> ResolvedSender:
    from backend.email_service.service import email_service

    cfg = await email_service.get_raw_config()
    profile = await company_profile(company_id)
    prefs = await platform_sender_prefs(company_id)
    return ResolvedSender(
        id=PLATFORM_SENDER_ID,
        label=prefs.get("label") or "Platform email service",
        from_name=prefs.get("from_name") or profile["name"] or cfg.get("from_name") or "OneNexa",
        from_email=str(cfg.get("from_email") or ""),
        reply_to=prefs.get("reply_to") or profile["email"] or None,
        kind="platform",
    )


async def resolve_sender(company_id: str, sender_id: Optional[str]) -> ResolvedSender:
    if not sender_id or sender_id == PLATFORM_SENDER_ID:
        if (await platform_sender_prefs(company_id)).get("removed"):
            raise HTTPException(
                status_code=400,
                detail="The platform email service is removed for your company. Choose another sender, or restore it under Senders.",
            )
        return await platform_sender(company_id)
    doc = await raw_db()[SENDERS].find_one({"id": sender_id, "company_id": company_id, "deleted": {"$ne": True}})
    if not doc:
        raise HTTPException(status_code=404, detail="Email sender account not found.")
    if doc.get("kind") in ("google", "microsoft"):
        return ResolvedSender(
            id=doc["id"],
            label=doc.get("label") or doc.get("from_email"),
            from_name=doc.get("from_name") or "",
            from_email=doc.get("from_email") or "",
            reply_to=normalize_email(doc.get("reply_to")) or None,
            kind=doc["kind"],
            oauth={"refresh_token": decrypt_secret(doc.get("refresh_token_enc") or ""), "company_id": company_id},
            daily_limit=doc.get("daily_limit"),
        )
    return ResolvedSender(
        id=doc["id"],
        label=doc.get("label") or doc.get("from_email"),
        from_name=doc.get("from_name") or "",
        from_email=doc.get("from_email") or doc.get("username") or "",
        reply_to=normalize_email(doc.get("reply_to")) or None,
        kind="smtp",
        daily_limit=doc.get("daily_limit"),
        smtp={
            "host": doc.get("smtp_host"),
            "port": int(doc.get("smtp_port") or 587),
            "security": doc.get("security") or "starttls",
            "username": doc.get("username") or doc.get("from_email"),
            "password": decrypt_secret(doc.get("password_enc") or ""),
        },
    )


# ── SMTP session (connection reused across one campaign run) ─────────────────
class SmtpSession:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self._server: Optional[smtplib.SMTP] = None

    def _connect(self) -> smtplib.SMTP:
        host, port = str(self.cfg.get("host") or "").strip(), int(self.cfg.get("port") or 587)
        if not host:
            raise ValueError("SMTP host is not configured for this sender.")
        security = str(self.cfg.get("security") or "starttls").lower()
        context = ssl.create_default_context()
        if security == "ssl":
            server: smtplib.SMTP = smtplib.SMTP_SSL(host, port, context=context, timeout=SMTP_TIMEOUT)
        else:
            server = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT)
            server.ehlo()
            if security == "starttls":
                server.starttls(context=context)
                server.ehlo()
        if self.cfg.get("username") and self.cfg.get("password"):
            server.login(self.cfg["username"], self.cfg["password"])
        return server

    def _send_sync(self, from_email: str, to_email: str, message: str) -> None:
        for attempt in (1, 2):
            try:
                if self._server is None:
                    self._server = self._connect()
                self._server.sendmail(from_email, [to_email], message)
                return
            except (smtplib.SMTPServerDisconnected, smtplib.SMTPConnectError, ConnectionError, OSError):
                self.close_sync()
                if attempt == 2:
                    raise

    async def send(self, from_email: str, to_email: str, message: str) -> None:
        await asyncio.to_thread(self._send_sync, from_email, to_email, message)

    def close_sync(self) -> None:
        if self._server is not None:
            try:
                self._server.quit()
            except Exception:
                pass
            self._server = None

    async def close(self) -> None:
        await asyncio.to_thread(self.close_sync)


def open_session(sender: ResolvedSender):
    """Delivery session for a sender: SMTP connection, Gmail API, or None (platform)."""
    if sender.kind == "smtp":
        return SmtpSession(sender.smtp)
    if sender.kind == "google":
        from .google_sender import GmailSession

        return GmailSession(sender.oauth.get("refresh_token") or "")
    if sender.kind == "microsoft":
        from backend.mail_connect import GraphSession
        from .connected_senders import store_rotated_refresh_token

        company_id, sender_id = sender.oauth.get("company_id") or "", sender.id

        async def _rotate(token: str) -> None:
            await store_rotated_refresh_token(company_id, sender_id, token)

        return GraphSession(sender.oauth.get("refresh_token") or "", on_rotate=_rotate)
    return None


def build_mime(*, sender: ResolvedSender, to_email: str, subject: str, html_body: str, text_body: str,
               unsubscribe_url: str = "", campaign_id: str = "", attachments: Optional[list] = None) -> str:
    msg = MIMEMultipart("mixed" if attachments else "alternative")
    msg["Subject"] = subject
    msg["From"] = email.utils.formataddr((sender.from_name, sender.from_email)) if sender.from_name else sender.from_email
    msg["To"] = to_email
    msg["Date"] = email.utils.formatdate(localtime=True)
    msg["Message-ID"] = email.utils.make_msgid(domain=(sender.from_email.split("@")[-1] or None))
    if sender.reply_to:
        msg["Reply-To"] = sender.reply_to
    if unsubscribe_url:
        msg["List-Unsubscribe"] = f"<{unsubscribe_url}>"
        msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    if campaign_id:
        msg["X-EngageX-Campaign"] = campaign_id
    body = MIMEMultipart("alternative") if attachments else msg
    body.attach(MIMEText(text_body or "", "plain", "utf-8"))
    body.attach(MIMEText(html_body or "", "html", "utf-8"))
    if attachments:
        msg.attach(body)
        for att in attachments:
            maintype, _, subtype = str(att.get("type") or "application/octet-stream").partition("/")
            part = MIMEBase(maintype or "application", subtype or "octet-stream")
            part.set_payload(base64.b64decode(att["content"]))
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=att.get("name") or "attachment")
            msg.attach(part)
    return msg.as_string()


async def send_one(*, sender: ResolvedSender, session: Optional[SmtpSession], to_email: str, subject: str,
                   html_body: str, text_body: str, unsubscribe_url: str = "", campaign_id: str = "",
                   related_user_id: Optional[str] = None, related_licensee_id: Optional[str] = None,
                   attachments: Optional[list] = None) -> None:
    """Send one message; raises on failure with a human-readable reason."""
    if sender.kind == "platform":
        from backend.email_service.service import email_service

        ok = await email_service.send_email(
            to_email=to_email,
            subject=subject,
            body_plain=text_body,
            body_html=html_body,
            email_type="engagex_campaign",
            related_user_id=related_user_id,
            related_licensee_id=related_licensee_id,
            from_name=sender.from_name,
            reply_to=sender.reply_to,
            attachments=attachments or None,
            queue_if_fail=False,  # EngageX owns retries; never double-send
        )
        if not ok:
            cfg = await email_service.get_raw_config()
            if not cfg.get("is_enabled", True):
                raise RuntimeError("The platform email service is disabled in the Commercial Console.")
            raise RuntimeError(str(cfg.get("last_email_error") or "The platform email service rejected the message."))
        return
    if session is None:
        raise RuntimeError("SMTP session is not open.")
    message = build_mime(sender=sender, to_email=to_email, subject=subject, html_body=html_body,
                         text_body=text_body, unsubscribe_url=unsubscribe_url, campaign_id=campaign_id,
                         attachments=attachments)
    await session.send(sender.from_email, to_email, message)


async def verify_smtp(cfg: dict) -> None:
    """Open, authenticate and close an SMTP connection (raises on failure)."""
    session = SmtpSession(cfg)

    def _check():
        server = session._connect()
        try:
            server.noop()
        finally:
            try:
                server.quit()
            except Exception:
                pass

    try:
        await asyncio.to_thread(_check)
    except smtplib.SMTPAuthenticationError as exc:
        raise HTTPException(status_code=400, detail="SMTP login failed. Check the username and password (Gmail/Outlook need an app password).") from exc
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not connect to the SMTP server: {exc}") from exc


async def load_attachments(company_id: str, items: Optional[list]) -> list:
    """Resolve campaign attachment refs to provider payloads [{name, content, type}]."""
    from .common import MEDIA

    ids = [str(a.get("id")) for a in (items or []) if isinstance(a, dict) and a.get("id")]
    if not ids:
        return []
    docs = await raw_db()[MEDIA].find({"id": {"$in": ids}, "company_id": company_id, "purpose": "attachment"}, {"_id": 0}).to_list(len(ids))
    by_id = {d["id"]: d for d in docs}
    missing = [i for i in ids if i not in by_id]
    if missing:
        raise HTTPException(status_code=400, detail="An email attachment is no longer available. Remove it and attach it again.")
    return [{"name": by_id[i]["filename"], "content": by_id[i]["base64"], "type": by_id[i]["mime_type"]} for i in ids]
