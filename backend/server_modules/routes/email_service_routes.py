"""Phase 2 extracted subsystem: email_service_routes.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/email_service_routes.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.models import User
from fastapi import Depends
from fastapi import HTTPException
from typing import Optional
import base64
import httpx
import os
from backend.server import api_router, logger  # created in backend/server.py before route modules load

async def _brevo_send(
    to_email: str,
    subject: str,
    body_plain: str,
    body_html: str = None,
    attachments: list = None,
):
    """Core Email sender — routes through Taskosphere Centralized EmailService.
    Preserves fallback to direct Brevo HTTP API for seamless backward compatibility.
    """
    try:
        from backend.email_service.service import email_service
        sent = await email_service.send_email(
            to_email=to_email,
            subject=subject,
            body_plain=body_plain,
            body_html=body_html,
            attachments=attachments,
            email_type="transactional",
        )
        if sent:
            return
    except Exception as ex:
        logger.warning(f"Central email service attempt failed: {ex}. Falling back to direct Brevo dispatch.")

    api_key = (os.getenv("BREVO_API_KEY") or "").strip()
    # Try DB active sender first, fall back to env vars
    try:
        _sender_doc = await db.email_sender_settings.find_one(
            {"type": "active_sender"}, {"_id": 0}
        )
        if _sender_doc and _sender_doc.get("email"):
            sender_email = _sender_doc["email"].strip()
            sender_name = (_sender_doc.get("name") or "TaskoSphere").strip()
        else:
            sender_email = (os.getenv("SENDER_EMAIL") or "").strip()
            sender_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    except Exception:
        sender_email = (os.getenv("SENDER_EMAIL") or "").strip()
        sender_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()

    if not api_key or not sender_email:
        raise Exception(
            "Brevo API env vars not configured. "
            "Set BREVO_API_KEY and SENDER_EMAIL in Render environment variables."
        )

    payload = {
        "sender": {"name": sender_name, "email": sender_email},
        "to": [{"email": to_email}],
        "subject": subject,
        "textContent": body_plain,
    }
    if body_html:
        payload["htmlContent"] = body_html
    if attachments:
        clean = [
            {"name": a.get("name") or "attachment", "content": a.get("content")}
            for a in attachments
            if a and a.get("content")
        ]
        if clean:
            payload["attachment"] = clean

    async with httpx.AsyncClient(timeout=30.0) as http_client:
        response = await http_client.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={
                "api-key": api_key,
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if response.status_code == 401:
        raise Exception(
            f"Brevo 401 Unauthorized — API key is invalid or expired. "
            f"Go to app.brevo.com → SMTP & API → API Keys, regenerate the key, "
            f"and update BREVO_API_KEY in your Render environment variables. "
            f"Brevo response: {response.text}"
        )
    if response.status_code not in (200, 201):
        raise Exception(f"Brevo API error {response.status_code}: {response.text}")
    return True


async def send_birthday_email(recipient_email: str, client_name: str):
    """Send birthday wish email to client via Brevo API (async)."""
    subject = f"Happy Birthday, {client_name}!"
    body_plain = (
        f"Dear {client_name},\n\n"
        f"On behalf of our entire team, we wish you a very Happy Birthday!\n\n"
        f"We appreciate your continued trust and partnership. "
        f"May this year bring you prosperity, success, and happiness.\n\n"
        f"Best regards,\nTaskosphere Team"
    )
    html_content = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
    <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <h1 style="color: #4F46E5; text-align: center;"> Happy Birthday! </h1>
    <p style="font-size: 16px; line-height: 1.6; color: #333;">Dear {client_name},</p>
    <p style="font-size: 16px; line-height: 1.6; color: #333;">
     On behalf of our entire team, we wish you a very Happy Birthday!
    </p>
    <p style="font-size: 16px; line-height: 1.6; color: #333;">
     We appreciate your continued trust and partnership. May this year bring you prosperity, success, and happiness.
    </p>
    <div style="background-color: #4F46E5; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center;">
    <p style="margin: 0; font-size: 18px; font-weight: bold;">Wishing you all the best!</p>
    </div>
    <p style="font-size: 14px; color: #666; text-align: center; margin-top: 30px;">
     Best regards,<br><strong>Taskosphere Team</strong>
    </p>
    </div>
    </body>
    </html>
    """
    try:
        await _brevo_send(recipient_email, subject, body_plain, html_content)
        logger.info(f"Birthday email sent to {recipient_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to send birthday email: {str(e)}")
        return False


async def send_automation_wish_email(
    recipient_email: str,
    subject: str,
    body_plain: str,
    attachment_url: Optional[str] = None,
) -> bool:
    """
    Generic sender for automation-engine emails (birthday + festival wishes),
    using the admin's own subject/template from Automation Settings rather
    than a hardcoded one — send_birthday_email above is kept only as the
    legacy/manual "Send Birthday Wish" button's sender.

    attachment_url, if given, is fetched and attached to the email (e.g. a
    birthday banner, a festival greeting card) via Brevo's attachment API.
    A failed fetch never blocks the email — it just sends without the
    attachment, same fallback philosophy as the WhatsApp image sender.
    """
    html_content = (
        "<html><body style=\"font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;\">"
        "<div style=\"max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; "
        "border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);\">"
        f"<p style=\"font-size: 16px; line-height: 1.6; color: #333; white-space: pre-wrap;\">{body_plain}</p>"
        "</div></body></html>"
    )

    attachments = None
    if attachment_url:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                resp = await c.get(attachment_url)
                resp.raise_for_status()
            filename = attachment_url.rsplit("/", 1)[-1].split("?")[0] or "attachment.jpg"
            b64_content = base64.b64encode(resp.content).decode("ascii")
            attachments = [{"name": filename, "content": b64_content}]
        except Exception as exc:
            logger.warning(f"Automation email attachment fetch failed ({attachment_url}): {exc} — sending without it.")

    try:
        await _brevo_send(recipient_email, subject, body_plain, html_content, attachments=attachments)
        return True
    except Exception as e:
        logger.error(f"Failed to send automation wish email: {str(e)}")
        return False


# ─── ACTIVE SENDER HELPER ─────────────────────────────────────────────────────
async def _get_active_sender():
    """
    Returns (email, name) for the active sender.
    Priority: DB setting → env vars fallback.
    """
    try:
        doc = await db.email_sender_settings.find_one(
            {"type": "active_sender"}, {"_id": 0}
        )
        if doc and doc.get("email"):
            return doc["email"].strip(), (doc.get("name") or "TaskoSphere").strip()
    except Exception:
        pass
    return (os.getenv("SENDER_EMAIL") or "").strip(), (
        os.getenv("SENDER_NAME") or "TaskoSphere"
    ).strip()


# ─── SENDER MANAGEMENT ENDPOINTS ──────────────────────────────────────────────
@api_router.get("/email/senders/active")
async def get_active_sender(current_user: User = Depends(get_current_user)):
    """Get the currently active sender email and name."""
    email, name = await _get_active_sender()
    # Also return env fallback info
    env_email = (os.getenv("SENDER_EMAIL") or "").strip()
    env_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    doc = await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
    return {
        "active_email": email,
        "active_name": name,
        "source": "db" if (doc and doc.get("email")) else "env",
        "env_email": env_email,
        "env_name": env_name,
        "db_senders": doc.get("all_senders", []) if doc else [],
    }


@api_router.get("/email/senders/list")
async def list_saved_senders(current_user: User = Depends(get_current_user)):
    """List all saved verified sender options."""
    doc = await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
    senders = doc.get("all_senders", []) if doc else []
    env_email = (os.getenv("SENDER_EMAIL") or "").strip()
    env_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    # Always include env sender if present and not already in list
    if env_email and not any(s["email"] == env_email for s in senders):
        senders = [{"email": env_email, "name": env_name, "source": "env"}] + senders
    return {"senders": senders}


@api_router.post("/email/senders/set-active")
async def set_active_sender(body: dict, current_user: User = Depends(get_current_user)):
    """Switch which sender email is used for all outgoing emails."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    email = (body.get("email") or "").strip()
    name = (body.get("name") or "TaskoSphere").strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="Valid email required")
    # Load existing doc to preserve all_senders list
    doc = (
        await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
        or {}
    )
    all_senders = doc.get("all_senders", [])
    # Add to list if not already there
    if not any(s["email"] == email for s in all_senders):
        all_senders.append(
            {
                "email": email,
                "name": name,
                "source": "brevo",
                "added_at": __import__("datetime").datetime.utcnow().isoformat(),
            }
        )
    await db.email_sender_settings.update_one(
        {"type": "active_sender"},
        {
            "$set": {
                "type": "active_sender",
                "email": email,
                "name": name,
                "all_senders": all_senders,
                "updated_at": __import__("datetime").datetime.utcnow().isoformat(),
                "updated_by": str(current_user.id),
            }
        },
        upsert=True,
    )
    return {"status": "ok", "active_email": email, "active_name": name}


@api_router.post("/email/senders/add")
async def add_sender_option(body: dict, current_user: User = Depends(get_current_user)):
    """Add a new verified sender to the saved list (without switching active)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    email = (body.get("email") or "").strip()
    name = (body.get("name") or email).strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="Valid email required")
    doc = (
        await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
        or {}
    )
    all_senders = doc.get("all_senders", [])
    if any(s["email"] == email for s in all_senders):
        return {"status": "already_exists", "senders": all_senders}
    all_senders.append(
        {
            "email": email,
            "name": name,
            "source": "brevo",
            "added_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
    )
    await db.email_sender_settings.update_one(
        {"type": "active_sender"},
        {"$set": {"all_senders": all_senders}},
        upsert=True,
    )
    return {"status": "added", "senders": all_senders}


@api_router.delete("/email/senders/{sender_email}")
async def remove_sender_option(
    sender_email: str, current_user: User = Depends(get_current_user)
):
    """Remove a sender from the saved list."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    doc = (
        await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
        or {}
    )
    all_senders = [s for s in doc.get("all_senders", []) if s["email"] != sender_email]
    # If active sender was removed, reset to env
    updates = {"all_senders": all_senders}
    if doc.get("email") == sender_email:
        updates["email"] = (os.getenv("SENDER_EMAIL") or "").strip()
        updates["name"] = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    await db.email_sender_settings.update_one(
        {"type": "active_sender"}, {"$set": updates}, upsert=True
    )
    return {"status": "removed", "senders": all_senders}


# ─── TEST EMAIL ENDPOINT ──────────────────────────────────────────────────────
@api_router.post("/email/test")
async def test_email_service(current_user: User = Depends(get_current_user)):
    """Send a test email to the logged-in admin to verify Brevo SMTP is working."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    missing = [
        k
        for k, v in {
            "BREVO_API_KEY": os.getenv("BREVO_API_KEY"),
            "SENDER_EMAIL": os.getenv("SENDER_EMAIL"),
        }.items()
        if not v
    ]

    if missing:
        raise HTTPException(
            status_code=500, detail=f"Missing env vars: {', '.join(missing)}"
        )

    try:
        await _brevo_send(
            to_email=current_user.email,
            subject="✅ TaskoSphere — Mail Service Test",
            body_plain=(
                f"Hello {current_user.full_name},\n\n"
                f"This is a test email from TaskoSphere.\n"
                f"If you received this, your mail service is working correctly.\n\n"
                f"SMTP Host : {os.getenv('BREVO_SMTP_HOST', 'smtp-relay.brevo.com')}\n"
                f"Sender    : {os.getenv('SENDER_EMAIL')}\n\n"
                f"Regards,\nTaskoSphere"
            ),
        )
        return {
            "status": "success",
            "message": f"Test email sent to {current_user.email}",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Mail error: {str(e)}")


# Task Analytics
# Task Analytics

async def send_email(to_email: str, subject: str, body: str):
    """Send plain text email via Brevo API (async)."""
    try:
        await _brevo_send(to_email, subject, body)
        return True
    except Exception as e:
        raise Exception(f"Brevo API error: {str(e)}")


# ===========================================================
