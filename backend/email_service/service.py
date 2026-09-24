import asyncio
from datetime import datetime, timezone, timedelta
import logging
import os
import uuid
from typing import Any, Dict, List, Optional

from backend.dependencies import db
from backend.email_service.models import EmailDeliveryLog, EmailProviderConfig, MaskedEmailConfig
from backend.email_service.providers import BaseEmailProvider, BrevoProvider, SMTPProvider, SendGridProvider
from backend.email_service.templates import SYSTEM_TEMPLATES, render_template

logger = logging.getLogger("email_service")


class CentralEmailService:
    """Taskosphere Platform-Wide Centralized Email Service."""

    def __init__(self):
        self._provider_cache: Optional[BaseEmailProvider] = None
        self._cached_config: Optional[Dict[str, Any]] = None
        self._last_loaded_at: float = 0.0

    async def get_raw_config(self) -> Dict[str, Any]:
        """Loads email configuration from DB, falling back to environment variables."""
        doc = await db.email_system_settings.find_one({"type": "central_email_config"}, {"_id": 0})
        if not doc:
            # Fallback to legacy email_sender_settings or env
            legacy_sender = await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
            from_email = (
                (legacy_sender or {}).get("email")
                or os.getenv("EMAIL_FROM_ADDRESS")
                or os.getenv("SENDER_EMAIL")
                or "notifications@taskosphere.com"
            )
            from_name = (
                (legacy_sender or {}).get("name")
                or os.getenv("EMAIL_FROM_NAME")
                or os.getenv("SENDER_NAME")
                or "TaskoSphere"
            )

            # Determine provider type from env
            provider_type = (os.getenv("EMAIL_PROVIDER") or "").strip().lower()
            if not provider_type:
                if os.getenv("SENDGRID_API_KEY"):
                    provider_type = "sendgrid"
                elif os.getenv("SMTP_HOST") or os.getenv("SMTP_SERVER"):
                    provider_type = "smtp"
                elif os.getenv("BREVO_API_KEY"):
                    provider_type = "brevo"
                else:
                    provider_type = "smtp"

            doc = {
                "type": "central_email_config",
                "provider_type": provider_type,
                "is_enabled": True,
                "from_name": from_name,
                "from_email": from_email,
                "reply_to": os.getenv("EMAIL_REPLY_TO") or os.getenv("SUPPORT_EMAIL") or from_email,
                "smtp_host": os.getenv("SMTP_HOST") or os.getenv("SMTP_SERVER") or "smtp.gmail.com",
                "smtp_port": int(os.getenv("SMTP_PORT") or 587),
                "smtp_username": os.getenv("SMTP_USERNAME") or os.getenv("SMTP_USER") or "",
                "smtp_password": os.getenv("SMTP_PASSWORD") or "",
                "smtp_use_tls": os.getenv("SMTP_USE_TLS", "true").lower() in ("true", "1", "yes"),
                "smtp_use_ssl": os.getenv("SMTP_USE_SSL", "false").lower() in ("true", "1", "yes"),
                "sendgrid_api_key": os.getenv("SENDGRID_API_KEY") or "",
                "sendgrid_sender_verified": False,
                "brevo_api_key": os.getenv("BREVO_API_KEY") or "",
                "last_connected_at": None,
                "last_test_success_at": None,
                "last_test_failure_at": None,
                "last_test_error": None,
                "last_email_sent_at": None,
                "last_email_failed_at": None,
                "last_email_error": None,
            }
        return doc

    async def get_masked_config(self) -> Dict[str, Any]:
        """Returns safe configuration for the Commercial Console UI with secrets masked."""
        cfg = await self.get_raw_config()

        def _mask_secret(val: Optional[str]) -> Optional[str]:
            if not val:
                return ""
            s = str(val).strip()
            if len(s) <= 4:
                return "••••"
            return s[:2] + "••••••••" + s[-2:]

        return {
            "provider_type": cfg.get("provider_type", "smtp"),
            "is_enabled": cfg.get("is_enabled", True),
            "from_name": cfg.get("from_name", "TaskoSphere"),
            "from_email": cfg.get("from_email", ""),
            "reply_to": cfg.get("reply_to", ""),
            "smtp_host": cfg.get("smtp_host", ""),
            "smtp_port": cfg.get("smtp_port", 587),
            "smtp_username": cfg.get("smtp_username", ""),
            "smtp_password_masked": _mask_secret(cfg.get("smtp_password")),
            "smtp_has_password": bool(cfg.get("smtp_password")),
            "smtp_use_tls": cfg.get("smtp_use_tls", True),
            "smtp_use_ssl": cfg.get("smtp_use_ssl", False),
            "sendgrid_api_key_masked": _mask_secret(cfg.get("sendgrid_api_key")),
            "sendgrid_has_key": bool(cfg.get("sendgrid_api_key")),
            "sendgrid_sender_verified": cfg.get("sendgrid_sender_verified", False),
            "brevo_api_key_masked": _mask_secret(cfg.get("brevo_api_key")),
            "brevo_has_key": bool(cfg.get("brevo_api_key")),
            "last_connected_at": cfg.get("last_connected_at"),
            "last_test_success_at": cfg.get("last_test_success_at"),
            "last_test_failure_at": cfg.get("last_test_failure_at"),
            "last_test_error": cfg.get("last_test_error"),
            "last_email_sent_at": cfg.get("last_email_sent_at"),
            "last_email_failed_at": cfg.get("last_email_failed_at"),
            "last_email_error": cfg.get("last_email_error"),
        }

    async def save_config(self, new_data: Dict[str, Any], updated_by: str = "admin") -> Dict[str, Any]:
        """Saves config preserving existing unedited masked secrets."""
        current = await self.get_raw_config()
        fields_to_update = {}

        # Safe scalar copy
        for key in ["provider_type", "is_enabled", "from_name", "from_email", "reply_to", "smtp_host", "smtp_port", "smtp_use_tls", "smtp_use_ssl"]:
            if key in new_data:
                fields_to_update[key] = new_data[key]

        # Password handling: if new string provided and not masked pattern, update
        new_pw = str(new_data.get("smtp_password") or "").strip()
        if new_pw and "••••" not in new_pw:
            fields_to_update["smtp_password"] = new_pw

        # SendGrid API key handling
        new_sg = str(new_data.get("sendgrid_api_key") or "").strip()
        if new_sg and "••••" not in new_sg:
            fields_to_update["sendgrid_api_key"] = new_sg

        # Brevo API key handling
        new_br = str(new_data.get("brevo_api_key") or "").strip()
        if new_br and "••••" not in new_br:
            fields_to_update["brevo_api_key"] = new_br

        fields_to_update["updated_at"] = datetime.now(timezone.utc).isoformat()
        fields_to_update["updated_by"] = updated_by

        merged = {**current, **fields_to_update}
        await db.email_system_settings.update_one(
            {"type": "central_email_config"},
            {"$set": merged},
            upsert=True,
        )

        # Invalidate cache
        self._provider_cache = None
        self._cached_config = None
        return await self.get_masked_config()

    async def get_provider(self) -> BaseEmailProvider:
        """Resolves the currently active email provider."""
        cfg = await self.get_raw_config()
        ptype = cfg.get("provider_type", "smtp").lower()

        if ptype == "sendgrid":
            return SendGridProvider(
                api_key=cfg.get("sendgrid_api_key") or os.getenv("SENDGRID_API_KEY", ""),
                default_from_name=cfg.get("from_name", "TaskoSphere"),
                default_from_email=cfg.get("from_email", ""),
                reply_to=cfg.get("reply_to"),
            )
        elif ptype == "brevo":
            return BrevoProvider(
                api_key=cfg.get("brevo_api_key") or os.getenv("BREVO_API_KEY", ""),
                default_from_name=cfg.get("from_name", "TaskoSphere"),
                default_from_email=cfg.get("from_email", ""),
                reply_to=cfg.get("reply_to"),
            )
        else:
            return SMTPProvider(
                host=cfg.get("smtp_host") or os.getenv("SMTP_HOST") or "smtp.gmail.com",
                port=int(cfg.get("smtp_port") or os.getenv("SMTP_PORT") or 587),
                username=cfg.get("smtp_username") or os.getenv("SMTP_USERNAME") or "",
                password=cfg.get("smtp_password") or os.getenv("SMTP_PASSWORD") or "",
                use_tls=cfg.get("smtp_use_tls", True),
                use_ssl=cfg.get("smtp_use_ssl", False),
                default_from_name=cfg.get("from_name", "TaskoSphere"),
                default_from_email=cfg.get("from_email", ""),
                reply_to=cfg.get("reply_to"),
            )

    async def render_template(
        self,
        template_code: str,
        context: Dict[str, Any],
        licensee_branding: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, str]:
        """Renders an email template from DB custom templates or system defaults."""
        tmpl = None
        try:
            tmpl = await db.email_templates.find_one({"template_code": template_code, "is_active": True}, {"_id": 0})
        except Exception as ex:
            logger.debug(f"Could not query DB for template {template_code}: {ex}")
        if not tmpl:
            tmpl = SYSTEM_TEMPLATES.get(template_code, {})
        return render_template(tmpl, context, licensee_branding)

    async def test_connection(self, recipient_email: str) -> Dict[str, Any]:
        """Tests the current provider connection and sends a test email."""
        cfg = await self.get_raw_config()
        provider = await self.get_provider()
        now_iso = datetime.now(timezone.utc).isoformat()

        try:
            # 1. Verify credentials / socket
            verify_res = await provider.verify_connection()
            if verify_res.get("status") == "error":
                err = verify_res.get("message", "Connection failed")
                await db.email_system_settings.update_one(
                    {"type": "central_email_config"},
                    {"$set": {"last_test_failure_at": now_iso, "last_test_error": err}},
                    upsert=True,
                )
                return {"status": "error", "message": err, "details": verify_res}

            # 2. Send actual test email
            test_subject = f"✅ TaskoSphere Email Test — {provider.name.upper()}"
            test_plain = (
                f"Hello,\n\n"
                f"This is a test message from your TaskoSphere Central Email System.\n"
                f"Active Provider: {provider.name.upper()}\n"
                f"Sender: {cfg.get('from_name')} <{cfg.get('from_email')}>\n"
                f"Timestamp: {now_iso}\n\n"
                f"If you received this message, outgoing email delivery is fully operational."
            )
            test_html = f"""<div style="font-family: sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; max-width: 550px;">
              <h2 style="color: #0D3B66; margin-top: 0;">TaskoSphere Mail Test Successful</h2>
              <p>Your central email pipeline is active and healthy.</p>
              <ul>
                <li><strong>Provider:</strong> {provider.name.upper()}</li>
                <li><strong>From:</strong> {cfg.get('from_name')} &lt;{cfg.get('from_email')}&gt;</li>
                <li><strong>Recipient:</strong> {recipient_email}</li>
                <li><strong>Time:</strong> {now_iso}</li>
              </ul>
              <p style="color: #64748b; font-size: 13px;">Sent from Taskosphere Commercial Control Console.</p>
            </div>"""

            await provider.send(
                to_email=recipient_email,
                subject=test_subject,
                body_plain=test_plain,
                body_html=test_html,
            )

            await db.email_system_settings.update_one(
                {"type": "central_email_config"},
                {
                    "$set": {
                        "last_connected_at": now_iso,
                        "last_test_success_at": now_iso,
                        "last_test_error": None,
                    }
                },
                upsert=True,
            )

            # Record in delivery logs
            await self._record_log(
                recipient=recipient_email,
                subject=test_subject,
                template_code="TEST_EMAIL",
                email_type="test",
                provider=provider.name,
                status="SENT",
                error_message=None,
            )

            return {
                "status": "success",
                "message": f"Test email sent successfully to {recipient_email} via {provider.name.upper()}",
                "provider": provider.name,
                "timestamp": now_iso,
            }
        except Exception as ex:
            err_msg = str(ex)
            logger.error("Email test failed: %s", err_msg)
            await db.email_system_settings.update_one(
                {"type": "central_email_config"},
                {"$set": {"last_test_failure_at": now_iso, "last_test_error": err_msg}},
                upsert=True,
            )
            await self._record_log(
                recipient=recipient_email,
                subject="TaskoSphere Test Email (Failed)",
                template_code="TEST_EMAIL",
                email_type="test",
                provider=provider.name,
                status="FAILED",
                error_message=err_msg,
            )
            return {"status": "error", "message": f"Test dispatch failed: {err_msg}"}

    async def _record_log(
        self,
        recipient: str,
        subject: str,
        template_code: Optional[str] = None,
        email_type: str = "transactional",
        provider: str = "smtp",
        status: str = "SENT",
        error_message: Optional[str] = None,
        related_user_id: Optional[str] = None,
        related_licensee_id: Optional[str] = None,
        log_id: Optional[str] = None,
    ) -> str:
        now_iso = datetime.now(timezone.utc).isoformat()
        final_id = log_id or f"elog-{uuid.uuid4().hex}"
        doc = {
            "id": final_id,
            "recipient": recipient,
            "subject": subject,
            "template_code": template_code,
            "email_type": email_type,
            "provider": provider,
            "status": status,
            "retry_count": 0,
            "max_retries": 3,
            "error_message": error_message,
            "related_user_id": related_user_id,
            "related_licensee_id": related_licensee_id,
            "created_at": now_iso,
            "sent_at": now_iso if status == "SENT" else None,
        }
        await db.email_delivery_logs.insert_one(doc)
        return final_id

    async def send_email(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str] = None,
        template_code: Optional[str] = None,
        email_type: str = "transactional",
        related_user_id: Optional[str] = None,
        related_licensee_id: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
        from_name: Optional[str] = None,
        from_email: Optional[str] = None,
        reply_to: Optional[str] = None,
        queue_if_fail: bool = True,
    ) -> bool:
        """Sends an email directly through the active provider and records delivery log."""
        cfg = await self.get_raw_config()
        if not cfg.get("is_enabled", True):
            logger.info("Central Email Service is disabled. Skipping dispatch to %s", to_email)
            await self._record_log(
                recipient=to_email,
                subject=subject,
                template_code=template_code,
                email_type=email_type,
                provider="none",
                status="FAILED",
                error_message="Email service is disabled in Commercial Console settings",
                related_user_id=related_user_id,
                related_licensee_id=related_licensee_id,
            )
            return False

        provider = await self.get_provider()
        log_id = f"elog-{uuid.uuid4().hex}"
        now_iso = datetime.now(timezone.utc).isoformat()

        # Insert log in QUEUED/SENDING
        await db.email_delivery_logs.insert_one({
            "id": log_id,
            "recipient": to_email,
            "subject": subject,
            "template_code": template_code,
            "email_type": email_type,
            "provider": provider.name,
            "status": "SENDING",
            "retry_count": 0,
            "max_retries": 3,
            "error_message": None,
            "related_user_id": related_user_id,
            "related_licensee_id": related_licensee_id,
            "created_at": now_iso,
            "sent_at": None,
        })

        try:
            success = await provider.send(
                to_email=to_email,
                subject=subject,
                body_plain=body_plain,
                body_html=body_html,
                from_name=from_name or cfg.get("from_name"),
                from_email=from_email or cfg.get("from_email"),
                reply_to=reply_to or cfg.get("reply_to"),
                attachments=attachments,
            )
            sent_time = datetime.now(timezone.utc).isoformat()
            await db.email_delivery_logs.update_one(
                {"id": log_id},
                {"$set": {"status": "SENT", "sent_at": sent_time, "error_message": None}},
            )
            await db.email_system_settings.update_one(
                {"type": "central_email_config"},
                {"$set": {"last_email_sent_at": sent_time}},
                upsert=True,
            )
            return True
        except Exception as ex:
            err = str(ex)
            logger.error("Failed to send email to %s: %s", to_email, err)
            fail_time = datetime.now(timezone.utc).isoformat()
            new_status = "RETRYING" if queue_if_fail else "FAILED"
            await db.email_delivery_logs.update_one(
                {"id": log_id},
                {"$set": {"status": new_status, "error_message": err}},
            )
            await db.email_system_settings.update_one(
                {"type": "central_email_config"},
                {"$set": {"last_email_failed_at": fail_time, "last_email_error": err}},
                upsert=True,
            )
            return False

    async def enqueue_email(
        self,
        to_email: str,
        subject: str,
        body_plain: str,
        body_html: Optional[str] = None,
        template_code: Optional[str] = None,
        email_type: str = "transactional",
        related_user_id: Optional[str] = None,
        related_licensee_id: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> str:
        """Enqueues email for immediate background dispatch without blocking caller."""
        asyncio.create_task(
            self.send_email(
                to_email=to_email,
                subject=subject,
                body_plain=body_plain,
                body_html=body_html,
                template_code=template_code,
                email_type=email_type,
                related_user_id=related_user_id,
                related_licensee_id=related_licensee_id,
                attachments=attachments,
            )
        )
        return "enqueued"

    async def send_template_email(
        self,
        to_email: str,
        template_code: str,
        context: Dict[str, Any],
        licensee_id: Optional[str] = None,
        related_user_id: Optional[str] = None,
        attachments: Optional[List[Dict[str, Any]]] = None,
        background: bool = True,
    ) -> bool:
        """Renders template (with DB overrides & licensee branding) and dispatches."""
        # 1. Fetch template from DB or fallback to default
        tmpl_doc = await db.email_templates.find_one({"code": template_code}, {"_id": 0})
        if not tmpl_doc:
            tmpl_doc = SYSTEM_TEMPLATES.get(template_code)

        if not tmpl_doc:
            logger.warning("Unknown email template code: %s", template_code)
            return False

        if not tmpl_doc.get("is_active", True):
            logger.info("Template %s is inactive. Skipping dispatch to %s", template_code, to_email)
            return False

        # 2. Licensee branding overrides if applicable
        branding = None
        if licensee_id:
            cust = await db.commercial_license_customers.find_one({"id": licensee_id}, {"_id": 0})
            if not cust:
                cust = await db.commercial_customers.find_one({"id": licensee_id}, {"_id": 0})
            if cust:
                branding = {
                    "company_name": cust.get("company_name"),
                    "support_email": cust.get("support_email") or cust.get("email"),
                }

        rendered = render_template(tmpl_doc, context, branding)

        if background:
            await self.enqueue_email(
                to_email=to_email,
                subject=rendered["subject"],
                body_plain=rendered["text_body"],
                body_html=rendered["html_body"],
                template_code=template_code,
                email_type="template",
                related_user_id=related_user_id,
                related_licensee_id=licensee_id,
                attachments=attachments,
            )
            return True
        else:
            return await self.send_email(
                to_email=to_email,
                subject=rendered["subject"],
                body_plain=rendered["text_body"],
                body_html=rendered["html_body"],
                template_code=template_code,
                email_type="template",
                related_user_id=related_user_id,
                related_licensee_id=licensee_id,
                attachments=attachments,
            )

    async def get_all_templates(self) -> List[Dict[str, Any]]:
        """Returns all 15 system templates with any DB overrides applied."""
        db_templates = await db.email_templates.find({}, {"_id": 0}).to_list(100)
        db_map = {t["code"]: t for t in db_templates}

        results = []
        for code, default_def in SYSTEM_TEMPLATES.items():
            if code in db_map:
                item = {**default_def, **db_map[code]}
            else:
                item = dict(default_def)
            results.append(item)
        return results

    async def update_template(self, code: str, updates: Dict[str, Any], user_id: str = "admin") -> Dict[str, Any]:
        """Saves custom edits to an email template."""
        if code not in SYSTEM_TEMPLATES:
            raise ValueError(f"Invalid template code {code}")

        allowed = ["subject", "html_body", "text_body", "is_active", "name", "purpose"]
        clean_updates = {k: updates[k] for k in allowed if k in updates}
        clean_updates["code"] = code
        clean_updates["updated_at"] = datetime.now(timezone.utc).isoformat()
        clean_updates["updated_by"] = user_id

        await db.email_templates.update_one(
            {"code": code},
            {"$set": clean_updates},
            upsert=True,
        )

        all_tmpls = await self.get_all_templates()
        return next((t for t in all_tmpls if t["code"] == code), clean_updates)

    async def reset_template_to_default(self, code: str) -> Dict[str, Any]:
        """Resets a template back to factory defaults."""
        if code not in SYSTEM_TEMPLATES:
            raise ValueError(f"Invalid template code {code}")
        await db.email_templates.delete_one({"code": code})
        return SYSTEM_TEMPLATES[code]

    async def get_delivery_logs(
        self,
        status: Optional[str] = None,
        recipient: Optional[str] = None,
        limit: int = 50,
        skip: int = 0,
    ) -> Dict[str, Any]:
        """Queries delivery logs with pagination and filters."""
        query: Dict[str, Any] = {}
        if status and status.upper() != "ALL":
            query["status"] = status.upper()
        if recipient and recipient.strip():
            query["recipient"] = {"$regex": recipient.strip(), "$options": "i"}

        total = await db.email_delivery_logs.count_documents(query)
        items = (
            await db.email_delivery_logs.find(query, {"_id": 0})
            .sort("created_at", -1)
            .skip(skip)
            .limit(limit)
            .to_list(limit)
        )
        return {"total": total, "items": items, "limit": limit, "skip": skip}

    async def retry_failed_email(self, log_id: str) -> Dict[str, Any]:
        """Retries a failed or retrying delivery log entry."""
        log_doc = await db.email_delivery_logs.find_one({"id": log_id})
        if not log_doc:
            raise ValueError("Delivery log not found")

        recipient = log_doc["recipient"]
        subject = log_doc["subject"]
        body_plain = f"(Retried delivery for {subject})"
        body_html = None

        # If template is stored, re-render if possible
        if log_doc.get("template_code"):
            rendered = await self.send_template_email(
                to_email=recipient,
                template_code=log_doc["template_code"],
                context={"user_name": "User", "email": recipient},
                background=False,
            )
            if rendered:
                await db.email_delivery_logs.update_one(
                    {"id": log_id},
                    {
                        "$set": {
                            "status": "SENT",
                            "sent_at": datetime.now(timezone.utc).isoformat(),
                            "retry_count": log_doc.get("retry_count", 0) + 1,
                            "error_message": None,
                        }
                    },
                )
                return {"status": "success", "message": f"Retried and sent to {recipient}"}
            else:
                return {"status": "error", "message": "Retry dispatch attempt failed"}

        success = await self.send_email(
            to_email=recipient,
            subject=subject,
            body_plain=body_plain,
            body_html=body_html,
            template_code=log_doc.get("template_code"),
            queue_if_fail=False,
        )
        return {"status": "success" if success else "error"}

    async def get_email_stats(self) -> Dict[str, Any]:
        """Calculates 24-hour and overall email statistics for Commercial Console."""
        now = datetime.now(timezone.utc)
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

        sent_today = await db.email_delivery_logs.count_documents({
            "status": "SENT",
            "created_at": {"$gte": start_of_day},
        })
        failed_today = await db.email_delivery_logs.count_documents({
            "status": "FAILED",
            "created_at": {"$gte": start_of_day},
        })
        pending_queue = await db.email_delivery_logs.count_documents({
            "status": {"$in": ["QUEUED", "SENDING", "RETRYING"]},
        })

        verified_users = await db.users.count_documents({"email_verified": True})
        total_users = await db.users.count_documents({})
        unverified_users = total_users - verified_users

        cfg = await self.get_raw_config()

        return {
            "sent_today": sent_today,
            "failed_today": failed_today,
            "pending_queue": pending_queue,
            "verified_users": verified_users,
            "unverified_users": max(0, unverified_users),
            "provider_type": cfg.get("provider_type", "smtp"),
            "provider_enabled": cfg.get("is_enabled", True),
            "last_successful_email": cfg.get("last_email_sent_at"),
            "last_failure": cfg.get("last_email_failed_at"),
            "last_test_success_at": cfg.get("last_test_success_at"),
        }


email_service = CentralEmailService()
