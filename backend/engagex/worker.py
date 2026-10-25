"""EngageX delivery worker.

Runs on the application's main asyncio loop (Motor is loop-bound) and delivers
queued/scheduled WhatsApp and MailMaster campaigns server-side, so a campaign
keeps going when the browser tab is closed and resumes after a restart.

Safety properties
-----------------
* Campaigns are claimed atomically with a renewable lease; an expired lease
  (crash/redeploy) makes the campaign claimable again.
* Sends are serialised per *lane* (one WhatsApp number, or one email sender
  per company) so two campaigns never double a number's send rate.
* A recipient is moved to ``sending`` before the provider call. Rows found in
  ``sending`` after a crash are marked failed ("interrupted") instead of being
  re-sent: a possible miss is preferable to a duplicate marketing message.
* Pause/cancel is honoured between messages; repeated consecutive failures or
  a disconnected WhatsApp number auto-pause the campaign with a reason.
"""
from __future__ import annotations

import asyncio
import logging
import os
import random
import socket
from datetime import timedelta
from typing import Any, Optional

from pymongo import ASCENDING, DESCENDING, ReturnDocument

from .common import (
    CAMPAIGNS,
    CONTACTS,
    LISTS,
    MEDIA,
    RECIPIENTS,
    SENDERS,
    SUPPRESSIONS,
    TEMPLATES,
    iso,
    merge_variables,
    raw_db,
    render_merge,
    tenant_context,
    tenant_db,
    utcnow,
)

logger = logging.getLogger("engagex.worker")

POLL_SECONDS = 5
LEASE_SECONDS = 60
MAX_CONSECUTIVE_FAILURES = 5
WORKER_ID = f"{socket.gethostname()}:{os.getpid()}"

_state: dict[str, Any] = {"task": None, "lanes": {}, "stopping": False, "lock": None}


def _tick_lock() -> asyncio.Lock:
    if _state["lock"] is None:
        _state["lock"] = asyncio.Lock()
    return _state["lock"]


# ── Indexes ──────────────────────────────────────────────────────────────────
async def ensure_indexes() -> None:
    db = raw_db()
    specs = [
        (CAMPAIGNS, [("id", ASCENDING)], {"unique": True}),
        (CAMPAIGNS, [("company_id", ASCENDING), ("channel", ASCENDING), ("created_at", DESCENDING)], {}),
        (CAMPAIGNS, [("status", ASCENDING), ("scheduled_at", ASCENDING)], {}),
        (RECIPIENTS, [("id", ASCENDING)], {"unique": True}),
        (RECIPIENTS, [("campaign_id", ASCENDING), ("status", ASCENDING), ("seq", ASCENDING)], {}),
        (RECIPIENTS, [("company_id", ASCENDING), ("channel", ASCENDING), ("updated_at", DESCENDING)], {}),
        (RECIPIENTS, [("token", ASCENDING)], {"unique": True, "sparse": True}),
        (SENDERS, [("company_id", ASCENDING), ("id", ASCENDING)], {}),
        (LISTS, [("company_id", ASCENDING), ("id", ASCENDING)], {}),
        (CONTACTS, [("company_id", ASCENDING), ("list_id", ASCENDING), ("email", ASCENDING)], {"unique": True}),
        (TEMPLATES, [("company_id", ASCENDING), ("channel", ASCENDING)], {}),
        (SUPPRESSIONS, [("company_id", ASCENDING), ("channel", ASCENDING), ("address", ASCENDING)], {"unique": True}),
        (MEDIA, [("id", ASCENDING)], {"unique": True}),
    ]
    for name, keys, options in specs:
        try:
            await db[name].create_index(keys, **options)
        except Exception as exc:  # index conflicts must never stop startup
            logger.warning("EngageX index %s %s skipped: %s", name, keys, exc)


# ── Stats ────────────────────────────────────────────────────────────────────
async def recompute_stats(campaign_id: str) -> dict:
    db = raw_db()
    pipeline = [
        {"$match": {"campaign_id": campaign_id}},
        {"$group": {
            "_id": "$status",
            "n": {"$sum": 1},
            "opened": {"$sum": {"$cond": [{"$ifNull": ["$opened_at", False]}, 1, 0]}},
            "unsubscribed": {"$sum": {"$cond": [{"$ifNull": ["$unsubscribed_at", False]}, 1, 0]}},
        }},
    ]
    stats = {"total": 0, "pending": 0, "sending": 0, "sent": 0, "failed": 0, "skipped": 0, "opened": 0, "unsubscribed": 0}
    async for row in db[RECIPIENTS].aggregate(pipeline):
        status = row["_id"] or "pending"
        stats[status] = stats.get(status, 0) + row["n"]
        stats["total"] += row["n"]
        stats["opened"] += row.get("opened", 0)
        stats["unsubscribed"] += row.get("unsubscribed", 0)
    await db[CAMPAIGNS].update_one({"id": campaign_id}, {"$set": {"stats": stats, "updated_at": iso()}})
    return stats


# ── Claiming ─────────────────────────────────────────────────────────────────
def _due_query(now_iso: str) -> dict:
    return {"$or": [
        {"status": "queued"},
        {"status": "scheduled", "scheduled_at": {"$lte": now_iso}},
        {"status": "running", "lease_until": {"$lt": now_iso}},
    ]}


def lane_key(campaign: dict) -> str:
    if campaign.get("channel") == "whatsapp":
        return f"wa:{campaign.get('settings', {}).get('session_id') or 'default'}"
    return f"mail:{campaign.get('company_id')}:{campaign.get('settings', {}).get('sender_id') or 'platform'}"


async def _claim(campaign_id: str) -> Optional[dict]:
    now = utcnow()
    return await raw_db()[CAMPAIGNS].find_one_and_update(
        {"id": campaign_id, **_due_query(iso(now))},
        {"$set": {
            "status": "running",
            "lease_owner": WORKER_ID,
            "lease_until": iso(now + timedelta(seconds=LEASE_SECONDS)),
            "last_error": None,
            "updated_at": iso(now),
        }},
        return_document=ReturnDocument.AFTER,
    )


async def _renew(campaign_id: str) -> None:
    await raw_db()[CAMPAIGNS].update_one(
        {"id": campaign_id, "lease_owner": WORKER_ID},
        {"$set": {"lease_until": iso(utcnow() + timedelta(seconds=LEASE_SECONDS))}},
    )


async def _sleep_with_lease(campaign_id: str, seconds: float) -> None:
    remaining = max(0.0, float(seconds))
    while remaining > 0 and not _state["stopping"]:
        step = min(remaining, 20.0)
        await asyncio.sleep(step)
        remaining -= step
        await _renew(campaign_id)


async def _set_campaign(campaign_id: str, **fields: Any) -> None:
    fields["updated_at"] = iso()
    await raw_db()[CAMPAIGNS].update_one({"id": campaign_id}, {"$set": fields})


async def _campaign_status(campaign_id: str) -> str:
    doc = await raw_db()[CAMPAIGNS].find_one({"id": campaign_id}, {"_id": 0, "status": 1})
    return (doc or {}).get("status") or "cancelled"


# ── Per-channel delivery ─────────────────────────────────────────────────────
class _WhatsAppChannel:
    def __init__(self, campaign: dict):
        self.campaign = campaign
        self.settings = campaign.get("settings") or {}
        self.content = campaign.get("content") or {}
        self.media: Optional[dict] = None

    async def open(self) -> Optional[str]:
        from backend.whatsapp_integration import _get_cached_sessions

        session_id = self.settings.get("session_id")
        try:
            sessions = await _get_cached_sessions()
        except Exception as exc:
            return f"WhatsApp bridge is unreachable: {exc}"
        connected = {s.get("sessionId") for s in sessions if s.get("status") == "connected"}
        if session_id not in connected:
            return "The selected WhatsApp number is not connected. Reconnect it and resume the campaign."
        media_id = self.content.get("media_id")
        if media_id:
            self.media = await raw_db()[MEDIA].find_one({"id": media_id, "company_id": self.campaign["company_id"]}, {"_id": 0})
            if not self.media:
                return "The campaign attachment is missing."
        return None

    async def send(self, recipient: dict) -> None:
        from backend.whatsapp_integration import _bridge_post, _bridge_post_large

        variables = merge_variables(recipient, self.campaign.get("sender_company") or "")
        text = render_merge(self.content.get("message") or "", variables)
        session_id = self.settings.get("session_id")
        if self.media:
            await _bridge_post_large("/send-media-base64", {
                "to": recipient["phone"],
                "sessionId": session_id,
                "caption": text,
                "base64": self.media["base64"],
                "mimeType": self.media["mime_type"],
                "filename": self.media["filename"],
            })
            logged = f"[{self.media['filename']}] {text}"
        else:
            await _bridge_post("/send", {"to": recipient["phone"], "message": text, "sessionId": session_id})
            logged = text
        recipient["_rendered"] = logged

    async def record(self, recipient: dict, status: str, error: Optional[str]) -> None:
        """Mirror into whatsapp_messages so the existing WhatsApp History shows it."""
        try:
            await tenant_db()["whatsapp_messages"].insert_one({
                "sent_by": self.campaign.get("created_by"),
                "company_id": self.campaign["company_id"],
                "to": recipient["phone"],
                "message": recipient.get("_rendered") or self.content.get("message"),
                "message_type": "engagex_campaign",
                "context_id": recipient.get("client_id"),
                "session_id": self.settings.get("session_id"),
                "status": status,
                "error": error,
                "batch_id": self.campaign["id"],
                "batch_name": self.campaign.get("name"),
                "engagex_campaign_id": self.campaign["id"],
                "sent_at": iso(),
            })
        except Exception as exc:
            logger.warning("EngageX could not mirror WhatsApp history for %s: %s", self.campaign["id"], exc)

    def delay(self, sent_in_run: int) -> float:
        lo = max(2.0, float(self.settings.get("min_delay_sec") or 6))
        hi = max(lo, float(self.settings.get("max_delay_sec") or 12))
        pause_every = int(self.settings.get("pause_every") or 0)
        if pause_every and sent_in_run and sent_in_run % pause_every == 0:
            return float(self.settings.get("pause_sec") or 60)
        return random.uniform(lo, hi)

    async def close(self) -> None:
        return None


class _MailChannel:
    def __init__(self, campaign: dict):
        self.campaign = campaign
        self.settings = campaign.get("settings") or {}
        self.content = campaign.get("content") or {}
        self.sender = None
        self.session = None

    async def open(self) -> Optional[str]:
        from .mailer import SmtpSession, resolve_sender

        try:
            self.sender = await resolve_sender(self.campaign["company_id"], self.settings.get("sender_id"))
        except Exception as exc:
            return f"Email sender is unavailable: {getattr(exc, 'detail', exc)}"
        if self.sender.kind == "smtp":
            self.session = SmtpSession(self.sender.smtp)
        elif not self.sender.from_email:
            return "The platform email service has no From address configured in the Commercial Console."
        return None

    async def send(self, recipient: dict) -> None:
        from .mailer import build_email_html, html_to_text, send_one

        base = (self.campaign.get("public_base_url") or "").rstrip("/")
        token = recipient.get("token") or ""
        unsubscribe_url = f"{base}/api/engagex-public/u/{token}" if base and token else ""
        pixel_url = f"{base}/api/engagex-public/o/{token}.gif" if base and token and self.settings.get("track_opens", True) else ""
        variables = merge_variables(recipient, self.campaign.get("sender_company") or "")
        variables["unsubscribe_url"] = unsubscribe_url
        subject = render_merge(self.content.get("subject") or "", variables)
        body = render_merge(self.content.get("html") or "", variables, escape_html=True)
        preview = render_merge(self.content.get("preview_text") or "", variables)
        html_body = build_email_html(
            body_html=body,
            preview_text=preview,
            footer_company=self.sender.from_name or self.campaign.get("sender_company") or "",
            footer_address=self.settings.get("footer_address") or "",
            unsubscribe_url=unsubscribe_url,
            open_pixel_url=pixel_url,
        )
        text_body = html_to_text(body)
        if unsubscribe_url:
            text_body += f"\n\n--\nUnsubscribe: {unsubscribe_url}"
        await send_one(
            sender=self.sender,
            session=self.session,
            to_email=recipient["email"],
            subject=subject,
            html_body=html_body,
            text_body=text_body,
            unsubscribe_url=unsubscribe_url,
            campaign_id=self.campaign["id"],
            related_user_id=self.campaign.get("created_by"),
            related_licensee_id=self.campaign.get("tenant", {}).get("customer_id"),
        )
        recipient["_subject"] = subject

    async def record(self, recipient: dict, status: str, error: Optional[str]) -> None:
        return None

    def delay(self, sent_in_run: int) -> float:
        per_minute = max(1, min(600, int(self.settings.get("per_minute") or 30)))
        return 60.0 / per_minute

    async def close(self) -> None:
        if self.session is not None:
            await self.session.close()


# ── Campaign runner ──────────────────────────────────────────────────────────
async def _run_campaign(campaign: dict) -> None:
    db = raw_db()
    campaign_id = campaign["id"]
    if not campaign.get("started_at"):
        await _set_campaign(campaign_id, started_at=iso())
    # Rows left in "sending" by a crashed run: never resend (duplicate risk).
    await db[RECIPIENTS].update_many(
        {"campaign_id": campaign_id, "status": "sending"},
        {"$set": {"status": "failed", "error": "Interrupted during delivery; not resent to avoid a duplicate.", "updated_at": iso()}},
    )
    channel = _WhatsAppChannel(campaign) if campaign.get("channel") == "whatsapp" else _MailChannel(campaign)
    with tenant_context(campaign.get("tenant") or {"company_id": campaign["company_id"]}):
        problem = await channel.open()
        if problem:
            await _set_campaign(campaign_id, status="paused", last_error=problem, lease_owner=None, lease_until=None)
            logger.warning("EngageX campaign %s paused: %s", campaign_id, problem)
            return
        sent_in_run = 0
        consecutive_failures = 0
        try:
            while not _state["stopping"]:
                status = await _campaign_status(campaign_id)
                if status != "running":
                    break
                recipient = await db[RECIPIENTS].find_one_and_update(
                    {"campaign_id": campaign_id, "status": "pending"},
                    {"$set": {"status": "sending", "updated_at": iso()}, "$inc": {"attempts": 1}},
                    sort=[("seq", ASCENDING)],
                    return_document=ReturnDocument.AFTER,
                )
                if recipient is None:
                    stats = await recompute_stats(campaign_id)
                    final = "failed" if stats["total"] and stats["sent"] == 0 and stats["failed"] > 0 else "completed"
                    await _set_campaign(campaign_id, status=final, completed_at=iso(), lease_owner=None, lease_until=None)
                    logger.info("EngageX campaign %s %s: %s", campaign_id, final, stats)
                    return
                error = None
                try:
                    await channel.send(recipient)
                except Exception as exc:
                    error = str(getattr(exc, "detail", None) or exc)[:500] or type(exc).__name__
                now = iso()
                if error:
                    consecutive_failures += 1
                    await db[RECIPIENTS].update_one({"id": recipient["id"]}, {"$set": {"status": "failed", "error": error, "updated_at": now}})
                else:
                    consecutive_failures = 0
                    sent_in_run += 1
                    await db[RECIPIENTS].update_one({"id": recipient["id"]}, {"$set": {
                        "status": "sent", "error": None, "sent_at": now, "updated_at": now,
                        "rendered_subject": recipient.get("_subject"),
                    }})
                await db[CAMPAIGNS].update_one({"id": campaign_id}, {
                    "$inc": {"stats.sent": 0 if error else 1, "stats.failed": 1 if error else 0, "stats.pending": -1},
                    "$set": {"updated_at": now, "last_error": error} if error else {"updated_at": now},
                })
                await channel.record(recipient, "failed" if error else "sent", error)
                if consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
                    await recompute_stats(campaign_id)
                    await _set_campaign(
                        campaign_id, status="paused", lease_owner=None, lease_until=None,
                        last_error=f"Paused after {consecutive_failures} consecutive failures. Last error: {error}",
                    )
                    return
                await _sleep_with_lease(campaign_id, channel.delay(sent_in_run))
        finally:
            await channel.close()
    # Left the loop because of pause/cancel/shutdown: release the lease.
    await recompute_stats(campaign_id)
    await raw_db()[CAMPAIGNS].update_one(
        {"id": campaign_id, "lease_owner": WORKER_ID},
        {"$set": {"lease_owner": None, "lease_until": None}},
    )


async def _lane_task(key: str, campaign: dict) -> None:
    try:
        await _run_campaign(campaign)
    except Exception:
        logger.exception("EngageX campaign %s crashed", campaign.get("id"))
        try:
            await _set_campaign(campaign["id"], status="paused", lease_owner=None, lease_until=None,
                                last_error="Delivery stopped unexpectedly. Resume to continue.")
        except Exception:
            pass
    finally:
        _state["lanes"].pop(key, None)


async def tick() -> None:
    """One scheduling pass: start due campaigns on free lanes."""
    async with _tick_lock():
        await _tick()


async def _tick() -> None:
    candidates = await raw_db()[CAMPAIGNS].find(
        _due_query(iso()),
        {"_id": 0, "id": 1, "channel": 1, "company_id": 1, "settings": 1},
    ).sort("created_at", ASCENDING).limit(50).to_list(50)
    for candidate in candidates:
        key = lane_key(candidate)
        if key in _state["lanes"]:
            continue
        campaign = await _claim(candidate["id"])
        if not campaign:
            continue
        _state["lanes"][key] = asyncio.create_task(_lane_task(key, campaign))


async def _loop() -> None:
    await ensure_indexes()
    logger.info("EngageX delivery worker started (%s).", WORKER_ID)
    while not _state["stopping"]:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("EngageX scheduling pass failed")
        await asyncio.sleep(POLL_SECONDS)


def kick() -> None:
    """Start pending work promptly (called after a campaign is queued)."""
    task = _state.get("task")
    if task is not None and not task.done():
        asyncio.get_running_loop().create_task(tick())


def install(app) -> None:
    if os.getenv("ENGAGEX_WORKER_DISABLED", "").strip().lower() in {"1", "true", "yes"}:
        logger.info("EngageX delivery worker disabled by ENGAGEX_WORKER_DISABLED.")
        return

    async def _start() -> None:
        if _state.get("task") is None or _state["task"].done():
            _state["stopping"] = False
            _state["task"] = asyncio.get_running_loop().create_task(_loop())

    async def _stop() -> None:
        _state["stopping"] = True
        task = _state.get("task")
        if task is not None:
            task.cancel()
        for lane in list(_state["lanes"].values()):
            lane.cancel()

    # Same registration style as backend/server_modules/lifecycle.py.
    app.on_event("startup")(_start)
    app.on_event("shutdown")(_stop)
