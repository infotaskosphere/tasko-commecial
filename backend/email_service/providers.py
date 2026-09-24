import asyncio
import base64
import email.utils
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
import logging
import smtplib
import ssl
from typing import Any, Dict, List, Optional
import httpx

logger = logging.getLogger("email_service.providers")


class BaseEmailProvider:
    """Abstract interface for all Taskosphere email providers."""

    name: str = "base"

    async def send(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str] = None,
        from_name: Optional[str] = None,
        from_email: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> bool:
        raise NotImplementedError

    async def verify_connection(self) -> Dict[str, Any]:
        raise NotImplementedError


class SMTPProvider(BaseEmailProvider):
    """Standard SMTP / TLS / SSL Provider."""

    name: str = "smtp"

    def __init__(
        self,
        host: str,
        port: int = 587,
        username: Optional[str] = None,
        password: Optional[str] = None,
        use_tls: bool = True,
        use_ssl: bool = False,
        default_from_name: str = "TaskoSphere",
        default_from_email: str = "",
        reply_to: Optional[str] = None,
    ):
        self.host = (host or "").strip()
        self.port = int(port or 587)
        self.username = (username or "").strip()
        self.password = (password or "").strip()
        self.use_tls = use_tls
        self.use_ssl = use_ssl
        self.default_from_name = default_from_name or "TaskoSphere"
        self.default_from_email = default_from_email or self.username
        self.default_reply_to = reply_to

    def _sync_send(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str],
        from_name: Optional[str],
        from_email: Optional[str],
        reply_to: Optional[str],
        attachments: Optional[List[Dict[str, Any]]],
    ) -> bool:
        if not self.host:
            raise ValueError("SMTP host is not configured.")

        f_email = from_email or self.default_from_email or self.username
        f_name = from_name or self.default_from_name
        r_to = reply_to or self.default_reply_to

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = f"{f_name} <{f_email}>" if f_name else f_email
        msg["To"] = to_email
        msg["Date"] = email.utils.formatdate(localtime=True)
        if r_to:
            msg["Reply-To"] = r_to

        # Attach plain text
        part1 = MIMEText(body_plain or "", "plain", "utf-8")
        msg.attach(part1)

        # Attach HTML if provided
        if body_html:
            part2 = MIMEText(body_html, "html", "utf-8")
            msg.attach(part2)

        # Attachments if provided
        if attachments:
            for att in attachments:
                if not att or not att.get("content"):
                    continue
                filename = att.get("name") or "attachment"
                content_b64 = att["content"]
                try:
                    payload = base64.b64decode(content_b64)
                    part = MIMEBase("application", "octet-stream")
                    part.set_payload(payload)
                    encoders.encode_base64(part)
                    part.add_header(
                        "Content-Disposition",
                        f"attachment; filename=\"{filename}\"",
                    )
                    msg.attach(part)
                except Exception as ex:
                    logger.warning("Could not attach file %s: %s", filename, ex)

        # Connect and send
        if self.use_ssl:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(self.host, self.port, context=context, timeout=25) as server:
                if self.username and self.password:
                    server.login(self.username, self.password)
                server.sendmail(f_email, [to_email], msg.as_string())
        else:
            with smtplib.SMTP(self.host, self.port, timeout=25) as server:
                server.ehlo()
                if self.use_tls:
                    context = ssl.create_default_context()
                    server.starttls(context=context)
                    server.ehlo()
                if self.username and self.password:
                    server.login(self.username, self.password)
                server.sendmail(f_email, [to_email], msg.as_string())

        return True

    async def send(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str] = None,
        from_name: Optional[str] = None,
        from_email: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> bool:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            self._sync_send,
            to_email,
            subject,
            body_plain,
            body_html,
            from_name,
            from_email,
            reply_to,
            attachments,
        )

    def _sync_verify(self) -> Dict[str, Any]:
        if not self.host:
            return {"status": "error", "message": "SMTP host missing"}
        try:
            if self.use_ssl:
                context = ssl.create_default_context()
                with smtplib.SMTP_SSL(self.host, self.port, context=context, timeout=10) as s:
                    if self.username and self.password:
                        s.login(self.username, self.password)
            else:
                with smtplib.SMTP(self.host, self.port, timeout=10) as s:
                    s.ehlo()
                    if self.use_tls:
                        context = ssl.create_default_context()
                        s.starttls(context=context)
                        s.ehlo()
                    if self.username and self.password:
                        s.login(self.username, self.password)
            return {"status": "success", "message": "SMTP Connection established successfully"}
        except Exception as e:
            return {"status": "error", "message": f"SMTP Check failed: {str(e)}"}

    async def verify_connection(self) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._sync_verify)


class SendGridProvider(BaseEmailProvider):
    """Twilio SendGrid v3 Web API Provider."""

    name: str = "sendgrid"

    def __init__(
        self,
        api_key: str,
        default_from_name: str = "TaskoSphere",
        default_from_email: str = "",
        reply_to: Optional[str] = None,
    ):
        self.api_key = (api_key or "").strip()
        self.default_from_name = default_from_name or "TaskoSphere"
        self.default_from_email = default_from_email or ""
        self.default_reply_to = reply_to

    async def send(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str] = None,
        from_name: Optional[str] = None,
        from_email: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> bool:
        if not self.api_key:
            raise ValueError("SendGrid API Key is not configured.")

        f_email = from_email or self.default_from_email
        f_name = from_name or self.default_from_name
        r_to = reply_to or self.default_reply_to

        if not f_email:
            raise ValueError("SendGrid requires a verified sender from_email.")

        content_list = []
        if body_plain:
            content_list.append({"type": "text/plain", "value": body_plain})
        if body_html:
            content_list.append({"type": "text/html", "value": body_html})
        if not content_list:
            content_list.append({"type": "text/plain", "value": "(No body content)"})

        payload: Dict[str, Any] = {
            "personalizations": [{"to": [{"email": to_email}]}],
            "from": {"email": f_email, "name": f_name},
            "subject": subject,
            "content": content_list,
        }

        if r_to:
            payload["reply_to"] = {"email": r_to}

        if attachments:
            sg_attachments = []
            for a in attachments:
                if a and a.get("content"):
                    sg_attachments.append({
                        "content": a["content"],
                        "filename": a.get("name") or "attachment",
                        "type": a.get("type", "application/octet-stream"),
                        "disposition": "attachment",
                    })
            if sg_attachments:
                payload["attachments"] = sg_attachments

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(
                "https://api.sendgrid.com/v3/mail/send",
                headers=headers,
                json=payload,
            )

        if resp.status_code in (200, 202):
            return True

        if resp.status_code == 401:
            raise ValueError(f"SendGrid 401 Unauthorized — Invalid API key: {resp.text}")

        raise RuntimeError(f"SendGrid error {resp.status_code}: {resp.text}")

    async def verify_connection(self) -> Dict[str, Any]:
        if not self.api_key:
            return {"status": "error", "message": "SendGrid API key missing"}
        try:
            headers = {"Authorization": f"Bearer {self.api_key}"}
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get("https://api.sendgrid.com/v3/scopes", headers=headers)
            if resp.status_code == 200:
                return {"status": "success", "message": "SendGrid API Key validated successfully"}
            return {"status": "error", "message": f"SendGrid verification failed ({resp.status_code}): {resp.text}"}
        except Exception as e:
            return {"status": "error", "message": f"SendGrid network check error: {str(e)}"}


class BrevoProvider(BaseEmailProvider):
    """Brevo (formerly Sendinblue) v3 Web API Provider."""

    name: str = "brevo"

    def __init__(
        self,
        api_key: str,
        default_from_name: str = "TaskoSphere",
        default_from_email: str = "",
        reply_to: Optional[str] = None,
    ):
        self.api_key = (api_key or "").strip()
        self.default_from_name = default_from_name or "TaskoSphere"
        self.default_from_email = default_from_email or ""
        self.default_reply_to = reply_to

    async def send(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str] = None,
        from_name: Optional[str] = None,
        from_email: Optional[str] = None,
        reply_to: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> bool:
        if not self.api_key:
            raise ValueError("Brevo API Key is not configured.")

        f_email = from_email or self.default_from_email
        f_name = from_name or self.default_from_name
        r_to = reply_to or self.default_reply_to

        payload: Dict[str, Any] = {
            "sender": {"name": f_name, "email": f_email},
            "to": [{"email": to_email}],
            "subject": subject,
            "textContent": body_plain,
        }
        if body_html:
            payload["htmlContent"] = body_html
        if r_to:
            payload["replyTo"] = {"email": r_to}
        if attachments:
            clean = [
                {"name": a.get("name") or "attachment", "content": a.get("content")}
                for a in attachments
                if a and a.get("content")
            ]
            if clean:
                payload["attachment"] = clean

        headers = {
            "api-key": self.api_key,
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=25.0) as client:
            resp = await client.post(
                "https://api.brevo.com/v3/smtp/email",
                headers=headers,
                json=payload,
            )

        if resp.status_code in (200, 201):
            return True
        if resp.status_code == 401:
            raise ValueError(f"Brevo 401 Unauthorized — Invalid API key: {resp.text}")
        raise RuntimeError(f"Brevo API error {resp.status_code}: {resp.text}")

    async def verify_connection(self) -> Dict[str, Any]:
        if not self.api_key:
            return {"status": "error", "message": "Brevo API key missing"}
        try:
            headers = {"api-key": self.api_key}
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get("https://api.brevo.com/v3/account", headers=headers)
            if resp.status_code == 200:
                data = resp.json()
                return {
                    "status": "success",
                    "message": f"Brevo connected: {data.get('email', 'OK')}",
                    "account": data.get("companyName") or data.get("email"),
                }
            return {"status": "error", "message": f"Brevo check failed ({resp.status_code}): {resp.text}"}
        except Exception as e:
            return {"status": "error", "message": f"Brevo check error: {str(e)}"}
