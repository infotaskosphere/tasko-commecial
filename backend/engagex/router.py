"""EngageX API (mounted at /api/engagex).

Path prefixes are mapped to EngageX page permissions in
``commercial_module_guard.FEATURE_PREFIXES``:

* /engagex/overview, /engagex/history  -> EngageX Dashboard
* /engagex/whatsapp/...                 -> WhatsApp Hub
* /engagex/mail/...                     -> MailMaster

Every handler additionally checks the page flag (defense in depth) and pins
all EngageX records to the authenticated company via ``scoped``.
"""
from __future__ import annotations

import base64
import binascii
import csv
import io
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from pymongo import DESCENDING, UpdateOne

from backend.dependencies import get_current_user
from backend.models import User
from backend.platform_owner import is_platform_owner

from . import worker
from .common import (
    CAMPAIGN_ACTIVE,
    CAMPAIGN_FINAL,
    CAMPAIGNS,
    CONTACTS,
    LISTS,
    MEDIA,
    PAGE_DASHBOARD,
    PAGE_MAIL,
    PAGE_WHATSAPP,
    PLATFORM_SENDER_ID,
    RECIPIENTS,
    SENDERS,
    SUPPRESSIONS,
    TEMPLATES,
    capture_tenant_context,
    clean_text,
    company_profile,
    encrypt_secret,
    is_admin,
    iso,
    mask_email,
    merge_tags_in,
    new_id,
    new_token,
    normalize_email,
    normalize_phone,
    public_base_url,
    raw_db,
    require_admin_user,
    require_page,
    scoped,
    serialize,
    tenant_db,
    utcnow,
    workspace_company_id,
)

router = APIRouter(prefix="/engagex", tags=["engagex"])

MAX_RECIPIENTS = 10_000
MAX_MEDIA_BYTES = 5 * 1024 * 1024
MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
MAX_EMAIL_ATTACHMENTS = 5
MAX_EMAIL_ATTACHMENTS_TOTAL = 10 * 1024 * 1024
PUBLIC_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}
CHANNELS = {"whatsapp": PAGE_WHATSAPP, "email": PAGE_MAIL}


# ═════════════════════════════════════════════════════════════════════════════
# Models
# ═════════════════════════════════════════════════════════════════════════════
class RecipientIn(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    company: Optional[str] = None
    client_id: Optional[str] = None
    variables: dict[str, Any] = Field(default_factory=dict)


class MediaIn(BaseModel):
    filename: str
    mime_type: str
    base64: str


class WhatsAppCampaignIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    session_id: str
    message: str = Field("", max_length=4096)
    media: Optional[MediaIn] = None
    recipients: list[RecipientIn] = Field(default_factory=list)
    min_delay_sec: float = Field(6, ge=2, le=300)
    max_delay_sec: float = Field(12, ge=2, le=600)
    pause_every: int = Field(25, ge=0, le=1000)
    pause_sec: float = Field(60, ge=0, le=3600)
    scheduled_at: Optional[datetime] = None


class BannerIn(BaseModel):
    url: str = Field(..., max_length=1000)
    link: str = Field("", max_length=1000)
    alt: str = Field("", max_length=200)
    media_id: Optional[str] = None


class AttachmentRef(BaseModel):
    id: str
    filename: str = ""
    size: int = 0
    mime_type: str = ""


class UploadIn(BaseModel):
    filename: str = Field(..., min_length=1, max_length=200)
    mime_type: str = Field("application/octet-stream", max_length=120)
    base64: str
    purpose: Literal["banner", "image", "attachment"] = "attachment"


class MailAudienceIn(BaseModel):
    list_ids: list[str] = Field(default_factory=list)
    recipients: list[RecipientIn] = Field(default_factory=list)


class MailCampaignIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=160)
    sender_id: str = PLATFORM_SENDER_ID
    subject: str = Field("", max_length=300)
    preview_text: str = Field("", max_length=300)
    html: str = Field("", max_length=500_000)
    audience: MailAudienceIn = Field(default_factory=MailAudienceIn)
    per_minute: int = Field(30, ge=1, le=600)
    track_opens: bool = True
    footer_address: str = Field("", max_length=300)
    template_id: Optional[str] = None
    banner: Optional[BannerIn] = None
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=MAX_EMAIL_ATTACHMENTS)


class LaunchIn(BaseModel):
    action: Literal["send", "schedule"] = "send"
    scheduled_at: Optional[datetime] = None


class SenderIn(BaseModel):
    label: str = Field(..., min_length=1, max_length=120)
    from_name: str = Field(..., min_length=1, max_length=120)
    from_email: str
    reply_to: Optional[str] = None
    smtp_host: str = Field(..., min_length=3, max_length=255)
    smtp_port: int = Field(587, ge=1, le=65535)
    security: Literal["starttls", "ssl", "none"] = "starttls"
    username: Optional[str] = None
    password: Optional[str] = None  # omitted on update keeps the stored password
    verify: bool = True

    @field_validator("from_email")
    @classmethod
    def _valid_from(cls, value: str) -> str:
        email = normalize_email(value)
        if not email:
            raise ValueError("Enter a valid From email address.")
        return email


class TestSendIn(BaseModel):
    to: str
    sender_id: str = PLATFORM_SENDER_ID
    subject: str = Field("Test email from MailMaster", max_length=300)
    html: str = Field("<p>This is a test email from MailMaster.</p>", max_length=500_000)
    preview_text: str = ""
    banner: Optional[BannerIn] = None
    attachments: list[AttachmentRef] = Field(default_factory=list, max_length=MAX_EMAIL_ATTACHMENTS)


class ListIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    description: str = Field("", max_length=500)


class ContactsIn(BaseModel):
    contacts: list[RecipientIn] = Field(default_factory=list)


class TemplateIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    subject: str = Field("", max_length=300)
    preview_text: str = Field("", max_length=300)
    html: str = Field("", max_length=500_000)
    message: str = Field("", max_length=4096)


class SuppressionIn(BaseModel):
    addresses: list[str] = Field(default_factory=list)
    reason: str = Field("Added manually", max_length=200)


# ═════════════════════════════════════════════════════════════════════════════
# Helpers
# ═════════════════════════════════════════════════════════════════════════════
def _page_for_channel(channel: str) -> str:
    return CHANNELS[channel]


def _address_key(channel: str) -> str:
    return "phone" if channel == "whatsapp" else "email"


def _normalize_address(channel: str, value: Any) -> Optional[str]:
    return normalize_phone(value) if channel == "whatsapp" else normalize_email(value)


async def _suppressed(company_id: str, channel: str, addresses: list[str]) -> set[str]:
    if not addresses:
        return set()
    rows = await raw_db()[SUPPRESSIONS].find(
        scoped(company_id, {"channel": channel, "address": {"$in": addresses}}), {"_id": 0, "address": 1}
    ).to_list(len(addresses))
    return {row["address"] for row in rows}


def _iso_or_none(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


async def _build_recipients(company_id: str, channel: str, rows: list[RecipientIn]) -> tuple[list[dict], dict]:
    """Normalise, de-duplicate and suppression-check a recipient list."""
    key = _address_key(channel)
    seen: dict[str, dict] = {}
    invalid = 0
    for row in rows:
        address = _normalize_address(channel, getattr(row, key))
        if not address:
            invalid += 1
            continue
        if address in seen:
            continue
        seen[address] = {
            key: address,
            "name": clean_text(row.name, 160),
            "company": clean_text(row.company, 200),
            "client_id": clean_text(row.client_id, 80) or None,
            "variables": {str(k)[:40]: clean_text(v, 500) for k, v in (row.variables or {}).items()},
        }
    if len(seen) > MAX_RECIPIENTS:
        raise HTTPException(status_code=400, detail=f"A campaign can have at most {MAX_RECIPIENTS:,} recipients.")
    blocked = await _suppressed(company_id, channel, list(seen))
    out = []
    for seq, (address, row) in enumerate(seen.items()):
        out.append({**row, "seq": seq, "suppressed": address in blocked})
    summary = {"valid": len(seen), "invalid": invalid, "duplicates": max(0, len(rows) - invalid - len(seen)), "suppressed": len(blocked)}
    return out, summary


async def _insert_recipients(campaign: dict, rows: list[dict]) -> None:
    now = iso()
    docs = []
    for row in rows:
        suppressed = row.pop("suppressed", False)
        docs.append({
            **row,
            "id": new_id("exr"),
            "token": new_token(),
            "company_id": campaign["company_id"],
            "campaign_id": campaign["id"],
            "channel": campaign["channel"],
            "status": "skipped" if suppressed else "pending",
            "error": "Opted out (suppression list)" if suppressed else None,
            "attempts": 0,
            "created_at": now,
            "updated_at": now,
        })
    for start in range(0, len(docs), 1000):
        await raw_db()[RECIPIENTS].insert_many(docs[start:start + 1000], ordered=False)


async def _campaign_or_404(company_id: str, campaign_id: str, channel: str) -> dict:
    doc = await raw_db()[CAMPAIGNS].find_one(scoped(company_id, {"id": campaign_id, "channel": channel}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Campaign not found.")
    return doc


def _public_campaign(doc: dict) -> dict:
    out = serialize(doc, drop=("tenant", "lease_owner", "lease_until", "public_base_url")) or {}
    content = dict(out.get("content") or {})
    if content.get("html") and len(content["html"]) > 200_000:
        content["html"] = content["html"][:200_000]
    out["content"] = content
    return out


def _base_campaign(user: User, request: Request, channel: str, name: str, company: dict) -> dict:
    tenant = capture_tenant_context(user)
    now = iso()
    return {
        "id": new_id("exc"),
        "company_id": tenant["company_id"],
        "channel": channel,
        "name": clean_text(name, 160),
        "status": "draft",
        "created_by": str(user.id),
        "created_by_name": getattr(user, "full_name", None) or getattr(user, "email", ""),
        "created_at": now,
        "updated_at": now,
        "scheduled_at": None,
        "started_at": None,
        "completed_at": None,
        "last_error": None,
        "sender_company": company.get("name") or "",
        "public_base_url": public_base_url(request),
        "tenant": tenant,
        "stats": {"total": 0, "pending": 0, "sent": 0, "failed": 0, "skipped": 0, "opened": 0, "unsubscribed": 0},
    }


def _launch_status(action: str, scheduled_at: Optional[datetime]) -> tuple[str, Optional[str]]:
    if action == "schedule":
        when = _iso_or_none(scheduled_at)
        if not when:
            raise HTTPException(status_code=400, detail="Choose a date and time to schedule the campaign.")
        if when <= iso(utcnow() + timedelta(seconds=30)):
            raise HTTPException(status_code=400, detail="The scheduled time must be in the future.")
        return "scheduled", when
    return "queued", None


# ═════════════════════════════════════════════════════════════════════════════
# Dashboard: overview + unified history
# ═════════════════════════════════════════════════════════════════════════════
async def _company_user_ids(company_id: str) -> list[str]:
    rows = await raw_db().users.find({"company_id": company_id}, {"_id": 0, "id": 1}).to_list(5000)
    return [str(r["id"]) for r in rows if r.get("id")]


async def _wa_scope(user: User, company_id: str) -> dict:
    if is_platform_owner(user):
        return {"company_id": company_id}
    from backend.whatsapp_integration import _message_history_scope_query

    return await _message_history_scope_query(user)


async def _email_log_scope(user: User, company_id: str) -> dict:
    """Platform email-service logs that belong to this company."""
    clauses: list[dict] = [{"related_user_id": {"$in": await _company_user_ids(company_id)}}]
    customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
    if customer_id and not is_platform_owner(user):
        clauses.append({"related_licensee_id": customer_id})
    # MailMaster sends are reported from engagex_recipients instead.
    return {"$and": [{"$or": clauses}, {"email_type": {"$ne": "engagex_campaign"}}]}


def _date_range(date_from: Optional[str], date_to: Optional[str]) -> dict:
    """ISO-string range on stored timestamps; ``date_to`` is inclusive."""
    cond: dict[str, str] = {}
    try:
        if date_from:
            cond["$gte"] = datetime.strptime(date_from[:10], "%Y-%m-%d").strftime("%Y-%m-%d")
        if date_to:
            end = datetime.strptime(date_to[:10], "%Y-%m-%d") + timedelta(days=1)
            cond["$lt"] = end.strftime("%Y-%m-%d")
    except ValueError:
        raise HTTPException(status_code=400, detail="Dates must use the YYYY-MM-DD format.")
    return cond


def _wa_status(value: Any) -> str:
    status = str(value or "").lower()
    if status in {"sent", "delivered", "read"}:
        return "sent"
    if status in {"failed", "error"}:
        return "failed"
    return status or "sent"


async def _history_rows(user: User, company_id: str, *, channel: Optional[str], status: Optional[str], q: Optional[str],
                        campaign_id: Optional[str], date_from: Optional[str], date_to: Optional[str], limit: int) -> tuple[list[dict], int]:
    rows: list[dict] = []
    total = 0
    dates = _date_range(date_from, date_to)
    regex = {"$regex": re.escape(q.strip()), "$options": "i"} if q and q.strip() else None

    if channel in (None, "whatsapp"):
        query: dict[str, Any] = {"$and": [await _wa_scope(user, company_id)]}
        if dates:
            query["$and"].append({"sent_at": dates})
        if status == "sent":
            query["$and"].append({"status": {"$in": ["sent", "delivered", "read"]}})
        elif status == "failed":
            query["$and"].append({"status": {"$in": ["failed", "error"]}})
        elif status:
            query["$and"].append({"status": status})
        if campaign_id:
            query["$and"].append({"batch_id": campaign_id})
        if regex:
            query["$and"].append({"$or": [{"to": regex}, {"message": regex}, {"batch_name": regex}]})
        coll = raw_db()["whatsapp_messages"]
        total += await coll.count_documents(query)
        async for doc in coll.find(query).sort("sent_at", DESCENDING).limit(limit):
            rows.append({
                "id": str(doc.get("_id")),
                "channel": "whatsapp",
                "source": "engagex" if doc.get("message_type") == "engagex_campaign" else (doc.get("message_type") or "app"),
                "campaign_id": doc.get("batch_id"),
                "campaign_name": doc.get("batch_name"),
                "recipient": doc.get("to"),
                "recipient_name": None,
                "summary": str(doc.get("message") or "")[:280],
                "status": _wa_status(doc.get("status")),
                "error": doc.get("error"),
                "at": doc.get("sent_at"),
                "opened_at": None,
                "sent_by": doc.get("sent_by"),
            })

    if channel in (None, "email"):
        query = scoped(company_id, {"channel": "email", "status": {"$in": ["sent", "failed"]}})
        if status in ("sent", "failed"):
            query["status"] = status
        elif status == "opened":
            query["opened_at"] = {"$ne": None}
        elif status:
            query["status"] = status
        if campaign_id:
            query["campaign_id"] = campaign_id
        if dates:
            query["updated_at"] = dates
        if regex:
            query["$or"] = [{"email": regex}, {"name": regex}, {"rendered_subject": regex}]
        coll = raw_db()[RECIPIENTS]
        total += await coll.count_documents(query)
        names: dict[str, str] = {}
        async for doc in coll.find(query, {"_id": 0}).sort("updated_at", DESCENDING).limit(limit):
            cid = doc.get("campaign_id")
            if cid and cid not in names:
                c = await raw_db()[CAMPAIGNS].find_one({"id": cid}, {"_id": 0, "name": 1})
                names[cid] = (c or {}).get("name") or ""
            rows.append({
                "id": doc["id"],
                "channel": "email",
                "source": "engagex",
                "campaign_id": cid,
                "campaign_name": names.get(cid),
                "recipient": doc.get("email"),
                "recipient_name": doc.get("name"),
                "summary": doc.get("rendered_subject") or "",
                "status": doc.get("status"),
                "error": doc.get("error"),
                "at": doc.get("sent_at") or doc.get("updated_at"),
                "opened_at": doc.get("opened_at"),
                "sent_by": None,
            })

        if not campaign_id and status != "opened":
            log_query: dict[str, Any] = {"$and": [await _email_log_scope(user, company_id)]}
            if dates:
                log_query["$and"].append({"created_at": dates})
            if status == "sent":
                log_query["$and"].append({"status": "SENT"})
            elif status == "failed":
                log_query["$and"].append({"status": {"$in": ["FAILED", "RETRYING"]}})
            elif status:
                log_query["$and"].append({"status": status.upper()})
            if regex:
                log_query["$and"].append({"$or": [{"recipient": regex}, {"subject": regex}]})
            coll = raw_db()["email_delivery_logs"]
            total += await coll.count_documents(log_query)
            async for doc in coll.find(log_query, {"_id": 0}).sort("created_at", DESCENDING).limit(limit):
                rows.append({
                    "id": doc.get("id"),
                    "channel": "email",
                    "source": doc.get("email_type") or "platform",
                    "campaign_id": None,
                    "campaign_name": None,
                    "recipient": doc.get("recipient"),
                    "recipient_name": None,
                    "summary": doc.get("subject") or "",
                    "status": "sent" if doc.get("status") == "SENT" else ("failed" if doc.get("status") in ("FAILED", "RETRYING") else str(doc.get("status") or "").lower()),
                    "error": doc.get("error_message"),
                    "at": doc.get("sent_at") or doc.get("created_at"),
                    "opened_at": None,
                    "sent_by": doc.get("related_user_id"),
                })

    rows.sort(key=lambda r: str(r.get("at") or ""), reverse=True)
    return rows, total


@router.get("/overview")
async def overview(days: int = Query(30, ge=1, le=365), current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_DASHBOARD)
    company_id = workspace_company_id(current_user)
    since_dt = utcnow() - timedelta(days=days - 1)
    since = since_dt.strftime("%Y-%m-%d")

    trend = {(since_dt + timedelta(days=i)).strftime("%Y-%m-%d"): {"whatsapp": 0, "email": 0, "failed": 0} for i in range(days)}
    kpis = {"whatsapp_sent": 0, "whatsapp_failed": 0, "email_sent": 0, "email_failed": 0, "email_opened": 0}

    wa_match = {"$and": [await _wa_scope(current_user, company_id), {"sent_at": {"$gte": since}}]}
    async for row in raw_db()["whatsapp_messages"].aggregate([
        {"$match": wa_match},
        {"$group": {"_id": {"d": {"$substrBytes": ["$sent_at", 0, 10]}, "s": "$status"}, "n": {"$sum": 1}}},
    ]):
        day, state = row["_id"]["d"], _wa_status(row["_id"]["s"])
        if state == "sent":
            kpis["whatsapp_sent"] += row["n"]
            if day in trend:
                trend[day]["whatsapp"] += row["n"]
        elif state == "failed":
            kpis["whatsapp_failed"] += row["n"]
            if day in trend:
                trend[day]["failed"] += row["n"]

    async for row in raw_db()[RECIPIENTS].aggregate([
        {"$match": scoped(company_id, {"channel": "email", "status": {"$in": ["sent", "failed"]}, "updated_at": {"$gte": since}})},
        {"$group": {"_id": {"d": {"$substrBytes": ["$updated_at", 0, 10]}, "s": "$status"}, "n": {"$sum": 1},
                    "o": {"$sum": {"$cond": [{"$ifNull": ["$opened_at", False]}, 1, 0]}}}},
    ]):
        day, state = row["_id"]["d"], row["_id"]["s"]
        kpis["email_opened"] += row["o"]
        key = "email_sent" if state == "sent" else "email_failed"
        kpis[key] += row["n"]
        if day in trend:
            trend[day]["email" if state == "sent" else "failed"] += row["n"]

    log_match = {"$and": [await _email_log_scope(current_user, company_id), {"created_at": {"$gte": since}}]}
    async for row in raw_db()["email_delivery_logs"].aggregate([
        {"$match": log_match},
        {"$group": {"_id": {"d": {"$substrBytes": ["$created_at", 0, 10]}, "s": "$status"}, "n": {"$sum": 1}}},
    ]):
        day, state = row["_id"]["d"], row["_id"]["s"]
        if state == "SENT":
            kpis["email_sent"] += row["n"]
            if day in trend:
                trend[day]["email"] += row["n"]
        elif state in ("FAILED", "RETRYING"):
            kpis["email_failed"] += row["n"]
            if day in trend:
                trend[day]["failed"] += row["n"]

    by_status: dict[str, int] = {}
    async for row in raw_db()[CAMPAIGNS].aggregate([
        {"$match": scoped(company_id)}, {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]):
        by_status[row["_id"] or "draft"] = row["n"]
    recent = await raw_db()[CAMPAIGNS].find(scoped(company_id, {"archived": {"$ne": True}}), {"_id": 0, "content": 0, "tenant": 0}) \
        .sort("created_at", DESCENDING).limit(8).to_list(8)
    unsubscribed = await raw_db()[SUPPRESSIONS].count_documents(scoped(company_id))
    email_total = kpis["email_sent"] + kpis["email_failed"]
    wa_total = kpis["whatsapp_sent"] + kpis["whatsapp_failed"]
    engagex_email_sent = await raw_db()[RECIPIENTS].count_documents(scoped(company_id, {"channel": "email", "status": "sent", "updated_at": {"$gte": since}}))
    return {
        "days": days,
        "kpis": {
            **kpis,
            "whatsapp_delivery_rate": round(kpis["whatsapp_sent"] * 100 / wa_total, 1) if wa_total else None,
            "email_delivery_rate": round(kpis["email_sent"] * 100 / email_total, 1) if email_total else None,
            "email_open_rate": round(kpis["email_opened"] * 100 / engagex_email_sent, 1) if engagex_email_sent else None,
            "campaigns_total": sum(by_status.values()),
            "campaigns_active": sum(by_status.get(s, 0) for s in ("queued", "scheduled", "running")),
            "campaigns_by_status": by_status,
            "opted_out": unsubscribed,
        },
        "trend": [{"date": day, **values} for day, values in trend.items()],
        "recent_campaigns": [_public_campaign(c) for c in recent],
    }


@router.get("/history")
async def history(
    channel: Optional[Literal["whatsapp", "email"]] = None,
    status: Optional[str] = Query(None, max_length=20),
    q: Optional[str] = Query(None, max_length=120),
    campaign_id: Optional[str] = Query(None, max_length=80),
    date_from: Optional[str] = Query(None, max_length=10),
    date_to: Optional[str] = Query(None, max_length=10),
    page: int = Query(1, ge=1, le=200),
    page_size: int = Query(25, ge=5, le=100),
    current_user: User = Depends(get_current_user),
):
    require_page(current_user, PAGE_DASHBOARD)
    company_id = workspace_company_id(current_user)
    rows, total = await _history_rows(current_user, company_id, channel=channel, status=status, q=q, campaign_id=campaign_id,
                                      date_from=date_from, date_to=date_to, limit=page * page_size)
    start = (page - 1) * page_size
    return {"items": rows[start:start + page_size], "total": total, "page": page, "page_size": page_size}


@router.get("/history/export")
async def history_export(
    channel: Optional[Literal["whatsapp", "email"]] = None,
    status: Optional[str] = Query(None, max_length=20),
    q: Optional[str] = Query(None, max_length=120),
    campaign_id: Optional[str] = Query(None, max_length=80),
    date_from: Optional[str] = Query(None, max_length=10),
    date_to: Optional[str] = Query(None, max_length=10),
    current_user: User = Depends(get_current_user),
):
    require_page(current_user, PAGE_DASHBOARD)
    company_id = workspace_company_id(current_user)
    rows, _ = await _history_rows(current_user, company_id, channel=channel, status=status, q=q, campaign_id=campaign_id,
                                  date_from=date_from, date_to=date_to, limit=10_000)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["Date", "Channel", "Source", "Campaign", "Recipient", "Name", "Subject / Message", "Status", "Opened", "Error"])
    for r in rows[:10_000]:
        writer.writerow([r.get("at") or "", r["channel"], r.get("source") or "", r.get("campaign_name") or "", r.get("recipient") or "",
                         r.get("recipient_name") or "", (r.get("summary") or "").replace("\n", " "), r.get("status") or "",
                         r.get("opened_at") or "", r.get("error") or ""])
    filename = f"engagex-history-{utcnow().strftime('%Y%m%d-%H%M')}.csv"
    return StreamingResponse(iter([buffer.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


# ═════════════════════════════════════════════════════════════════════════════
# Audience (clients and their contact persons)
# ═════════════════════════════════════════════════════════════════════════════
async def _audience(channel: str, q: Optional[str], client_type: Optional[str], status: Optional[str],
                    service: Optional[str], include_contacts: bool) -> dict:
    query: dict[str, Any] = {}
    if client_type:
        query["client_type"] = client_type
    if status:
        query["status"] = status
    if service:
        query["services"] = service
    if q and q.strip():
        regex = {"$regex": re.escape(q.strip()), "$options": "i"}
        query["$or"] = [{"company_name": regex}, {"email": regex}, {"phone": regex},
                        {"contact_persons.name": regex}, {"contact_persons.email": regex}, {"contact_persons.phone": regex}]
    projection = {"_id": 0, "id": 1, "company_name": 1, "client_type": 1, "status": 1, "services": 1, "email": 1, "phone": 1,
                  "contact_persons": 1, "city": 1, "state": 1}
    clients = await tenant_db().clients.find(query, projection).sort("company_name", 1).limit(5000).to_list(5000)
    key = _address_key(channel)
    items: list[dict] = []
    for client in clients:
        address = _normalize_address(channel, client.get(key))
        base = {"client_id": client.get("id"), "company": client.get("company_name") or "", "client_type": client.get("client_type"),
                "status": client.get("status"), "city": client.get("city")}
        if address:
            items.append({**base, "id": f"{client.get('id')}:main", "name": client.get("company_name") or "", "contact_role": "Primary", key: address})
        if include_contacts:
            for index, person in enumerate(client.get("contact_persons") or []):
                person_address = _normalize_address(channel, (person or {}).get(key))
                if person_address and person_address != address:
                    items.append({**base, "id": f"{client.get('id')}:cp{index}", "name": person.get("name") or base["company"],
                                  "contact_role": person.get("designation") or "Contact person", key: person_address})
    types = sorted({c.get("client_type") for c in clients if c.get("client_type")})
    services = sorted({s for c in clients for s in (c.get("services") or []) if isinstance(s, str)})
    return {"items": items, "total": len(items), "clients_matched": len(clients), "facets": {"client_types": types, "services": services[:200]}}


@router.get("/whatsapp/audience")
async def whatsapp_audience(q: Optional[str] = None, client_type: Optional[str] = None, status: Optional[str] = None,
                            service: Optional[str] = None, include_contacts: bool = True, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_WHATSAPP)
    workspace_company_id(current_user)
    return await _audience("whatsapp", q, client_type, status, service, include_contacts)


@router.get("/mail/audience")
async def mail_audience(q: Optional[str] = None, client_type: Optional[str] = None, status: Optional[str] = None,
                        service: Optional[str] = None, include_contacts: bool = True, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    workspace_company_id(current_user)
    return await _audience("email", q, client_type, status, service, include_contacts)


# ═════════════════════════════════════════════════════════════════════════════
# Campaign lifecycle (shared by both channels)
# ═════════════════════════════════════════════════════════════════════════════
def _register_campaign_routes(channel: str, prefix: str) -> None:
    page = _page_for_channel(channel)

    @router.get(f"{prefix}/campaigns", name=f"{channel}_campaign_list")
    async def list_campaigns(status: Optional[str] = None, q: Optional[str] = None, page_no: int = Query(1, ge=1, alias="page"),
                             page_size: int = Query(20, ge=5, le=100), current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        query = scoped(company_id, {"channel": channel, "archived": {"$ne": True}})
        if status:
            query["status"] = {"$in": status.split(",")}
        if q:
            query["name"] = {"$regex": re.escape(q), "$options": "i"}
        coll = raw_db()[CAMPAIGNS]
        total = await coll.count_documents(query)
        docs = await coll.find(query, {"_id": 0, "content.html": 0}).sort("created_at", DESCENDING) \
            .skip((page_no - 1) * page_size).limit(page_size).to_list(page_size)
        return {"items": [_public_campaign(d) for d in docs], "total": total, "page": page_no, "page_size": page_size}

    @router.get(f"{prefix}/campaigns/{{campaign_id}}", name=f"{channel}_campaign_detail")
    async def campaign_detail(campaign_id: str, status: Optional[str] = None, q: Optional[str] = None,
                              page_no: int = Query(1, ge=1, alias="page"), page_size: int = Query(50, ge=10, le=200),
                              current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        doc = await _campaign_or_404(company_id, campaign_id, channel)
        if doc.get("status") not in ("draft",):
            doc["stats"] = await worker.recompute_stats(campaign_id)
        query = scoped(company_id, {"campaign_id": campaign_id})
        if status == "opened":
            query["opened_at"] = {"$ne": None}
        elif status:
            query["status"] = status
        if q:
            key = _address_key(channel)
            query["$or"] = [{key: {"$regex": re.escape(q), "$options": "i"}}, {"name": {"$regex": re.escape(q), "$options": "i"}}]
        coll = raw_db()[RECIPIENTS]
        total = await coll.count_documents(query)
        recipients = await coll.find(query, {"_id": 0, "token": 0, "variables": 0}).sort("seq", 1) \
            .skip((page_no - 1) * page_size).limit(page_size).to_list(page_size)
        return {"campaign": _public_campaign(doc), "recipients": {"items": recipients, "total": total, "page": page_no, "page_size": page_size}}

    @router.post(f"{prefix}/campaigns/{{campaign_id}}/pause", name=f"{channel}_campaign_pause")
    async def pause(campaign_id: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        res = await raw_db()[CAMPAIGNS].update_one(
            scoped(company_id, {"id": campaign_id, "channel": channel, "status": {"$in": ["queued", "scheduled", "running"]}}),
            {"$set": {"status": "paused", "paused_at": iso(), "updated_at": iso(), "last_error": None}},
        )
        if not res.matched_count:
            raise HTTPException(status_code=409, detail="Only queued, scheduled or running campaigns can be paused.")
        return {"status": "paused"}

    @router.post(f"{prefix}/campaigns/{{campaign_id}}/resume", name=f"{channel}_campaign_resume")
    async def resume(campaign_id: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        res = await raw_db()[CAMPAIGNS].update_one(
            scoped(company_id, {"id": campaign_id, "channel": channel, "status": "paused"}),
            {"$set": {"status": "queued", "updated_at": iso(), "last_error": None, "lease_owner": None, "lease_until": None}},
        )
        if not res.matched_count:
            raise HTTPException(status_code=409, detail="Only paused campaigns can be resumed.")
        worker.kick()
        return {"status": "queued"}

    @router.post(f"{prefix}/campaigns/{{campaign_id}}/cancel", name=f"{channel}_campaign_cancel")
    async def cancel(campaign_id: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        res = await raw_db()[CAMPAIGNS].update_one(
            scoped(company_id, {"id": campaign_id, "channel": channel, "status": {"$in": list(CAMPAIGN_ACTIVE)}}),
            {"$set": {"status": "cancelled", "completed_at": iso(), "updated_at": iso()}},
        )
        if not res.matched_count:
            raise HTTPException(status_code=409, detail="This campaign is not active.")
        await raw_db()[RECIPIENTS].update_many(
            scoped(company_id, {"campaign_id": campaign_id, "status": "pending"}),
            {"$set": {"status": "skipped", "error": "Campaign cancelled", "updated_at": iso()}},
        )
        await worker.recompute_stats(campaign_id)
        return {"status": "cancelled"}

    @router.post(f"{prefix}/campaigns/{{campaign_id}}/retry-failed", name=f"{channel}_campaign_retry")
    async def retry_failed(campaign_id: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        doc = await _campaign_or_404(company_id, campaign_id, channel)
        if doc.get("status") in ("running", "queued", "scheduled", "draft"):
            raise HTTPException(status_code=409, detail="Retry is available once the campaign is paused or finished.")
        res = await raw_db()[RECIPIENTS].update_many(
            scoped(company_id, {"campaign_id": campaign_id, "status": "failed"}),
            {"$set": {"status": "pending", "error": None, "updated_at": iso()}},
        )
        if not res.modified_count:
            raise HTTPException(status_code=409, detail="There are no failed recipients to retry.")
        await raw_db()[CAMPAIGNS].update_one(scoped(company_id, {"id": campaign_id}), {"$set": {
            "status": "queued", "completed_at": None, "last_error": None, "updated_at": iso(), "lease_owner": None, "lease_until": None,
        }})
        await worker.recompute_stats(campaign_id)
        worker.kick()
        return {"status": "queued", "retrying": res.modified_count}

    @router.delete(f"{prefix}/campaigns/{{campaign_id}}", name=f"{channel}_campaign_delete")
    async def delete_campaign(campaign_id: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        doc = await _campaign_or_404(company_id, campaign_id, channel)
        if doc.get("status") not in ("draft", *CAMPAIGN_FINAL):
            raise HTTPException(status_code=409, detail="Pause or cancel the campaign before deleting it.")
        if doc.get("status") != "draft":
            # Keep delivery records for audit; hide the campaign only.
            await raw_db()[CAMPAIGNS].update_one(scoped(company_id, {"id": campaign_id}), {"$set": {"archived": True, "updated_at": iso()}})
            return {"archived": True}
        await raw_db()[RECIPIENTS].delete_many(scoped(company_id, {"campaign_id": campaign_id}))
        await raw_db()[CAMPAIGNS].delete_one(scoped(company_id, {"id": campaign_id}))
        return {"deleted": True}


_register_campaign_routes("whatsapp", "/whatsapp")
_register_campaign_routes("email", "/mail")


# ═════════════════════════════════════════════════════════════════════════════
# WhatsApp Hub
# ═════════════════════════════════════════════════════════════════════════════
@router.get("/whatsapp/sessions")
async def whatsapp_sessions(current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_WHATSAPP)
    workspace_company_id(current_user)
    from backend.whatsapp_integration import _get_cached_sessions, _whatsapp_session_scope_query

    try:
        bridge = await _get_cached_sessions()
        bridge_error = None
    except HTTPException as exc:
        bridge, bridge_error = [], str(exc.detail)
    except Exception as exc:
        bridge, bridge_error = [], str(exc)
    owned = await tenant_db()["whatsapp_sessions"].find(await _whatsapp_session_scope_query(current_user)).to_list(100)
    labels = {d.get("session_id"): d for d in owned}
    owner = is_platform_owner(current_user)
    items = []
    for s in bridge:
        sid = s.get("sessionId")
        record = labels.get(sid)
        if not owner and not record:
            continue
        items.append({
            "session_id": sid,
            "label": (record or {}).get("label") or s.get("displayName") or s.get("phoneNumber") or sid,
            "phone": s.get("phoneNumber"),
            "status": s.get("status"),
            "connected": s.get("status") == "connected",
        })
    return {"sessions": items, "bridge_error": bridge_error}


@router.post("/whatsapp/campaigns")
async def create_whatsapp_campaign(body: WhatsAppCampaignIn, request: Request, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_WHATSAPP)
    company_id = workspace_company_id(current_user)
    from backend.whatsapp_integration import _has_wa_access, resolve_sendable_session

    if not await _has_wa_access(current_user):
        raise HTTPException(status_code=403, detail="WhatsApp sending access has not been granted to your account.")
    session_id = await resolve_sendable_session(current_user, body.session_id)
    if not session_id:
        raise HTTPException(status_code=400, detail="Connect a WhatsApp number before sending a campaign.")
    if not body.message.strip() and not body.media:
        raise HTTPException(status_code=400, detail="Write a message or attach a file.")
    if body.max_delay_sec < body.min_delay_sec:
        raise HTTPException(status_code=400, detail="Maximum delay must be greater than or equal to the minimum delay.")
    rows, summary = await _build_recipients(company_id, "whatsapp", body.recipients)
    if not any(not r["suppressed"] for r in rows):
        raise HTTPException(status_code=400, detail="Add at least one valid WhatsApp number that has not opted out.")

    media_id = None
    if body.media:
        try:
            raw = base64.b64decode(body.media.base64.split(",")[-1], validate=True)
        except (binascii.Error, ValueError):
            raise HTTPException(status_code=400, detail="The attachment could not be read.")
        if len(raw) > MAX_MEDIA_BYTES:
            raise HTTPException(status_code=400, detail="Attachments must be 5 MB or smaller.")
        media_id = new_id("exm")
        await raw_db()[MEDIA].insert_one({
            "id": media_id, "company_id": company_id, "filename": clean_text(body.media.filename, 180) or "attachment",
            "mime_type": clean_text(body.media.mime_type, 100) or "application/octet-stream",
            "base64": base64.b64encode(raw).decode(), "size": len(raw), "created_at": iso(),
        })

    status, scheduled_at = _launch_status("schedule" if body.scheduled_at else "send", body.scheduled_at)
    company = await company_profile(company_id)
    campaign = _base_campaign(current_user, request, "whatsapp", body.name, company)
    campaign.update({
        "status": status,
        "scheduled_at": scheduled_at,
        "settings": {
            "session_id": session_id,
            "min_delay_sec": body.min_delay_sec,
            "max_delay_sec": body.max_delay_sec,
            "pause_every": body.pause_every,
            "pause_sec": body.pause_sec,
        },
        "content": {
            "message": body.message,
            "media_id": media_id,
            "media_name": body.media.filename if body.media else None,
            "merge_tags": merge_tags_in(body.message),
        },
        "audience_summary": summary,
    })
    await raw_db()[CAMPAIGNS].insert_one(dict(campaign))
    await _insert_recipients(campaign, rows)
    campaign["stats"] = await worker.recompute_stats(campaign["id"])
    worker.kick()
    return {"campaign": _public_campaign(campaign), "summary": summary}


# ═════════════════════════════════════════════════════════════════════════════
# MailMaster: senders
# ═════════════════════════════════════════════════════════════════════════════
def _public_sender(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "kind": "smtp",
        "label": doc.get("label"),
        "from_name": doc.get("from_name"),
        "from_email": doc.get("from_email"),
        "reply_to": doc.get("reply_to"),
        "smtp_host": doc.get("smtp_host"),
        "smtp_port": doc.get("smtp_port"),
        "security": doc.get("security"),
        "username": mask_email(doc.get("username") or "") if "@" in str(doc.get("username") or "") else doc.get("username"),
        "has_password": bool(doc.get("password_enc")),
        "is_default": bool(doc.get("is_default")),
        "verified_at": doc.get("verified_at"),
        "last_error": doc.get("last_error"),
        "created_at": doc.get("created_at"),
    }


@router.get("/mail/senders")
async def list_senders(current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    from .mailer import platform_sender

    platform = await platform_sender(company_id)
    from backend.email_service.service import email_service

    cfg = await email_service.get_raw_config()
    custom = await raw_db()[SENDERS].find(scoped(company_id, {"deleted": {"$ne": True}}), {"_id": 0}).sort("created_at", 1).to_list(100)
    has_default = any(d.get("is_default") for d in custom)
    return {
        "senders": [{
            "id": PLATFORM_SENDER_ID,
            "kind": "platform",
            "label": "Platform email service",
            "from_name": platform.from_name,
            "from_email": platform.from_email,
            "reply_to": platform.reply_to,
            "is_default": not has_default,
            "enabled": bool(cfg.get("is_enabled", True)) and bool(platform.from_email),
            "provider": cfg.get("provider_type"),
        }] + [_public_sender(d) for d in custom],
        "can_manage": is_admin(current_user),
    }


async def _sender_doc(company_id: str, sender_id: str) -> dict:
    doc = await raw_db()[SENDERS].find_one(scoped(company_id, {"id": sender_id, "deleted": {"$ne": True}}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Sender account not found.")
    return doc


@router.post("/mail/senders")
async def create_sender(body: SenderIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    require_admin_user(current_user)
    company_id = workspace_company_id(current_user)
    from .mailer import verify_smtp

    if not body.password:
        raise HTTPException(status_code=400, detail="Enter the mailbox password or app password.")
    username = (body.username or body.from_email).strip()
    cfg = {"host": body.smtp_host.strip(), "port": body.smtp_port, "security": body.security, "username": username, "password": body.password}
    if body.verify:
        await verify_smtp(cfg)
    doc = {
        "id": new_id("exs"),
        "company_id": company_id,
        "label": clean_text(body.label, 120),
        "from_name": clean_text(body.from_name, 120),
        "from_email": body.from_email,
        "reply_to": normalize_email(body.reply_to),
        "smtp_host": cfg["host"],
        "smtp_port": body.smtp_port,
        "security": body.security,
        "username": username,
        "password_enc": encrypt_secret(body.password),
        "is_default": False,
        "verified_at": iso() if body.verify else None,
        "created_by": str(current_user.id),
        "created_at": iso(),
        "updated_at": iso(),
    }
    await raw_db()[SENDERS].insert_one(dict(doc))
    return _public_sender(doc)


@router.put("/mail/senders/{sender_id}")
async def update_sender(sender_id: str, body: SenderIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    require_admin_user(current_user)
    company_id = workspace_company_id(current_user)
    from .common import decrypt_secret
    from .mailer import verify_smtp

    existing = await _sender_doc(company_id, sender_id)
    password = body.password or decrypt_secret(existing.get("password_enc") or "")
    username = (body.username or body.from_email).strip()
    cfg = {"host": body.smtp_host.strip(), "port": body.smtp_port, "security": body.security, "username": username, "password": password}
    if body.verify:
        await verify_smtp(cfg)
    updates = {
        "label": clean_text(body.label, 120), "from_name": clean_text(body.from_name, 120), "from_email": body.from_email,
        "reply_to": normalize_email(body.reply_to), "smtp_host": cfg["host"], "smtp_port": body.smtp_port, "security": body.security,
        "username": username, "updated_at": iso(), "last_error": None,
    }
    if body.password:
        updates["password_enc"] = encrypt_secret(body.password)
    if body.verify:
        updates["verified_at"] = iso()
    await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender_id}), {"$set": updates})
    return _public_sender({**existing, **updates})


@router.delete("/mail/senders/{sender_id}")
async def delete_sender(sender_id: str, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    require_admin_user(current_user)
    company_id = workspace_company_id(current_user)
    await _sender_doc(company_id, sender_id)
    in_use = await raw_db()[CAMPAIGNS].count_documents(scoped(company_id, {"settings.sender_id": sender_id, "status": {"$in": ["queued", "scheduled", "running", "paused"]}}))
    if in_use:
        raise HTTPException(status_code=409, detail="This sender is used by an active campaign. Cancel or finish it first.")
    await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender_id}), {"$set": {"deleted": True, "is_default": False, "password_enc": None, "updated_at": iso()}})
    return {"deleted": True}


@router.post("/mail/senders/{sender_id}/default")
async def set_default_sender(sender_id: str, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    require_admin_user(current_user)
    company_id = workspace_company_id(current_user)
    if sender_id != PLATFORM_SENDER_ID:
        await _sender_doc(company_id, sender_id)
    await raw_db()[SENDERS].update_many(scoped(company_id), {"$set": {"is_default": False}})
    if sender_id != PLATFORM_SENDER_ID:
        await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender_id}), {"$set": {"is_default": True}})
    return {"default": sender_id}


@router.post("/mail/test-send")
async def test_send(body: TestSendIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    from .common import merge_variables, render_merge
    from .mailer import SmtpSession, build_email_html, html_to_text, resolve_sender, send_one

    to = normalize_email(body.to)
    if not to:
        raise HTTPException(status_code=400, detail="Enter a valid email address for the test.")
    sender = await resolve_sender(company_id, body.sender_id)
    variables = merge_variables({"name": getattr(current_user, "full_name", "") or "", "email": to}, sender.from_name)
    content = render_merge(body.html, variables, escape_html=True)
    html_body = build_email_html(body_html=content, preview_text=render_merge(body.preview_text, variables),
                                 footer_company=sender.from_name, footer_address="", unsubscribe_url="", open_pixel_url="",
                                 banner=body.banner.model_dump() if body.banner else None)
    from .mailer import load_attachments

    attachments_payload = [a.model_dump() for a in body.attachments]
    await _check_attachments(company_id, attachments_payload)
    attachments = await load_attachments(company_id, attachments_payload)
    session = SmtpSession(sender.smtp) if sender.kind == "smtp" else None
    try:
        await send_one(sender=sender, session=session, to_email=to, subject="[TEST] " + render_merge(body.subject, variables),
                       html_body=html_body, text_body=html_to_text(content), related_user_id=str(current_user.id),
                       related_licensee_id=str(getattr(current_user, "commercial_customer_id", "") or "") or None,
                       attachments=attachments)
    except HTTPException:
        raise
    except Exception as exc:
        if sender.kind == "smtp":
            await raw_db()[SENDERS].update_one(scoped(company_id, {"id": sender.id}), {"$set": {"last_error": str(exc)[:300]}})
        raise HTTPException(status_code=400, detail=f"Test email failed: {exc}")
    finally:
        if session is not None:
            await session.close()
    return {"sent": True, "to": to}


async def _check_attachments(company_id: str, items: Optional[list]) -> None:
    """Attachments must belong to this company and stay within email size limits."""
    ids = [str(a.get("id")) for a in (items or []) if isinstance(a, dict) and a.get("id")]
    if not ids:
        return
    docs = await raw_db()[MEDIA].find(scoped(company_id, {"id": {"$in": ids}, "purpose": "attachment"}), {"_id": 0, "id": 1, "size": 1}).to_list(len(ids))
    if len(docs) != len(set(ids)):
        raise HTTPException(status_code=400, detail="An email attachment is no longer available. Remove it and attach it again.")
    if sum(int(d.get("size") or 0) for d in docs) > MAX_EMAIL_ATTACHMENTS_TOTAL:
        raise HTTPException(status_code=400, detail="Attachments may total at most 10 MB per email.")


@router.post("/mail/uploads")
async def upload_mail_file(body: UploadIn, request: Request, current_user: User = Depends(get_current_user)):
    """Store a banner/inline image (served publicly for email clients) or an attachment (private)."""
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    try:
        raw = base64.b64decode(body.base64.split(",")[-1], validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="The file could not be read.")
    if not raw:
        raise HTTPException(status_code=400, detail="The file is empty.")
    mime = (body.mime_type or "application/octet-stream").split(";")[0].strip().lower()
    filename = re.sub(r"[^\w.\- ()]+", "_", body.filename).strip() or "file"
    public = body.purpose in ("banner", "image")
    if public:
        if mime not in PUBLIC_IMAGE_TYPES:
            raise HTTPException(status_code=400, detail="Use a PNG, JPG, GIF or WebP image.")
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="Images must be 3 MB or smaller.")
    elif len(raw) > MAX_ATTACHMENT_BYTES:
        raise HTTPException(status_code=400, detail="Attachments must be 8 MB or smaller.")
    doc = {
        "id": new_id("exm"), "company_id": company_id, "purpose": body.purpose, "filename": filename[:180],
        "mime_type": mime, "base64": base64.b64encode(raw).decode(), "size": len(raw),
        "public_token": new_token() if public else None, "created_by": str(current_user.id), "created_at": iso(),
    }
    await raw_db()[MEDIA].insert_one(dict(doc))
    url = None
    if public:
        from urllib.parse import quote

        url = f"{public_base_url(request)}/api/engagex-public/a/{doc['public_token']}/{quote(doc['filename'])}"
    return {"id": doc["id"], "filename": doc["filename"], "mime_type": mime, "size": len(raw), "url": url, "purpose": body.purpose}


# ═════════════════════════════════════════════════════════════════════════════
# MailMaster: lists & contacts
# ═════════════════════════════════════════════════════════════════════════════
async def _list_or_404(company_id: str, list_id: str) -> dict:
    doc = await raw_db()[LISTS].find_one(scoped(company_id, {"id": list_id}), {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Audience list not found.")
    return doc


async def _list_counts(company_id: str, list_ids: list[str]) -> dict[str, dict]:
    counts: dict[str, dict] = {lid: {"subscribed": 0, "unsubscribed": 0} for lid in list_ids}
    async for row in raw_db()[CONTACTS].aggregate([
        {"$match": scoped(company_id, {"list_id": {"$in": list_ids}})},
        {"$group": {"_id": {"l": "$list_id", "s": "$status"}, "n": {"$sum": 1}}},
    ]):
        counts.setdefault(row["_id"]["l"], {})[row["_id"]["s"] or "subscribed"] = row["n"]
    return counts


@router.get("/mail/lists")
async def list_lists(current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    docs = await raw_db()[LISTS].find(scoped(company_id), {"_id": 0}).sort("created_at", DESCENDING).to_list(500)
    counts = await _list_counts(company_id, [d["id"] for d in docs])
    return {"items": [{**d, "counts": counts.get(d["id"], {})} for d in docs]}


@router.post("/mail/lists")
async def create_list(body: ListIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    doc = {"id": new_id("exl"), "company_id": company_id, "name": clean_text(body.name, 120), "description": clean_text(body.description, 500),
           "created_by": str(current_user.id), "created_at": iso(), "updated_at": iso()}
    await raw_db()[LISTS].insert_one(dict(doc))
    return {**doc, "counts": {"subscribed": 0, "unsubscribed": 0}}


@router.put("/mail/lists/{list_id}")
async def update_list(list_id: str, body: ListIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    await _list_or_404(company_id, list_id)
    await raw_db()[LISTS].update_one(scoped(company_id, {"id": list_id}), {"$set": {
        "name": clean_text(body.name, 120), "description": clean_text(body.description, 500), "updated_at": iso()}})
    return {"updated": True}


@router.delete("/mail/lists/{list_id}")
async def delete_list(list_id: str, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    await _list_or_404(company_id, list_id)
    await raw_db()[CONTACTS].delete_many(scoped(company_id, {"list_id": list_id}))
    await raw_db()[LISTS].delete_one(scoped(company_id, {"id": list_id}))
    return {"deleted": True}


@router.get("/mail/lists/{list_id}/contacts")
async def list_contacts(list_id: str, q: Optional[str] = None, status: Optional[str] = None,
                        page_no: int = Query(1, ge=1, alias="page"), page_size: int = Query(50, ge=10, le=200),
                        current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    await _list_or_404(company_id, list_id)
    query = scoped(company_id, {"list_id": list_id})
    if status:
        query["status"] = status
    if q:
        regex = {"$regex": re.escape(q), "$options": "i"}
        query["$or"] = [{"email": regex}, {"name": regex}, {"company": regex}]
    total = await raw_db()[CONTACTS].count_documents(query)
    items = await raw_db()[CONTACTS].find(query, {"_id": 0}).sort("created_at", DESCENDING) \
        .skip((page_no - 1) * page_size).limit(page_size).to_list(page_size)
    return {"items": items, "total": total, "page": page_no, "page_size": page_size}


@router.post("/mail/lists/{list_id}/contacts")
async def add_contacts(list_id: str, body: ContactsIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    await _list_or_404(company_id, list_id)
    if len(body.contacts) > 50_000:
        raise HTTPException(status_code=400, detail="Import at most 50,000 contacts at a time.")
    now = iso()
    ops, invalid, seen = [], 0, set()
    blocked = await _suppressed(company_id, "email", [e for e in (normalize_email(c.email) for c in body.contacts) if e])
    for contact in body.contacts:
        email = normalize_email(contact.email)
        if not email:
            invalid += 1
            continue
        if email in seen:
            continue
        seen.add(email)
        ops.append(UpdateOne(
            {"company_id": company_id, "list_id": list_id, "email": email},
            {"$set": {"name": clean_text(contact.name, 160), "company": clean_text(contact.company, 200), "phone": normalize_phone(contact.phone),
                      "client_id": clean_text(contact.client_id, 80) or None,
                      "fields": {str(k)[:40]: clean_text(v, 500) for k, v in (contact.variables or {}).items()}, "updated_at": now},
             "$setOnInsert": {"id": new_id("exct"), "company_id": company_id, "list_id": list_id, "email": email,
                              "status": "unsubscribed" if email in blocked else "subscribed", "created_at": now}},
            upsert=True,
        ))
    added = updated = 0
    for start in range(0, len(ops), 1000):
        result = await raw_db()[CONTACTS].bulk_write(ops[start:start + 1000], ordered=False)
        added += result.upserted_count
        updated += result.modified_count
    await raw_db()[LISTS].update_one(scoped(company_id, {"id": list_id}), {"$set": {"updated_at": now}})
    return {"added": added, "updated": updated, "invalid": invalid, "duplicates": max(0, len(body.contacts) - invalid - len(seen))}


@router.delete("/mail/lists/{list_id}/contacts/{contact_id}")
async def remove_contact(list_id: str, contact_id: str, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    res = await raw_db()[CONTACTS].delete_one(scoped(company_id, {"list_id": list_id, "id": contact_id}))
    if not res.deleted_count:
        raise HTTPException(status_code=404, detail="Contact not found.")
    return {"deleted": True}


# ═════════════════════════════════════════════════════════════════════════════
# MailMaster: campaigns
# ═════════════════════════════════════════════════════════════════════════════
def _mail_fields(body: MailCampaignIn) -> dict:
    return {
        "name": clean_text(body.name, 160),
        "settings": {
            "sender_id": body.sender_id or PLATFORM_SENDER_ID,
            "per_minute": body.per_minute,
            "track_opens": body.track_opens,
            "footer_address": clean_text(body.footer_address, 300),
        },
        "content": {
            "subject": body.subject,
            "preview_text": body.preview_text,
            "html": body.html,
            "template_id": body.template_id,
            "merge_tags": merge_tags_in(body.subject, body.preview_text, body.html),
            "banner": body.banner.model_dump() if body.banner and body.banner.url.strip() else None,
            "attachments": [a.model_dump() for a in body.attachments],
        },
        "audience": {
            "list_ids": list(dict.fromkeys(body.audience.list_ids))[:50],
            "recipients": [r.model_dump() for r in body.audience.recipients[:MAX_RECIPIENTS]],
        },
    }


async def _expand_mail_audience(company_id: str, audience: dict) -> tuple[list[dict], dict]:
    rows: list[RecipientIn] = [RecipientIn(**r) for r in audience.get("recipients") or []]
    list_ids = audience.get("list_ids") or []
    if list_ids:
        valid = {d["id"] for d in await raw_db()[LISTS].find(scoped(company_id, {"id": {"$in": list_ids}}), {"_id": 0, "id": 1}).to_list(100)}
        missing = set(list_ids) - valid
        if missing:
            raise HTTPException(status_code=400, detail="One of the selected audience lists no longer exists.")
        async for c in raw_db()[CONTACTS].find(scoped(company_id, {"list_id": {"$in": list_ids}, "status": "subscribed"}), {"_id": 0}):
            rows.append(RecipientIn(name=c.get("name"), email=c.get("email"), phone=c.get("phone"), company=c.get("company"),
                                    client_id=c.get("client_id"), variables=c.get("fields") or {}))
    return await _build_recipients(company_id, "email", rows)


def _validate_mail_ready(campaign: dict) -> None:
    content = campaign.get("content") or {}
    if not str(content.get("subject") or "").strip():
        raise HTTPException(status_code=400, detail="Add a subject line before sending.")
    if not str(content.get("html") or "").strip():
        raise HTTPException(status_code=400, detail="Add email content before sending.")


async def _launch_mail(campaign: dict, action: str, scheduled_at: Optional[datetime]) -> dict:
    _validate_mail_ready(campaign)
    from .mailer import resolve_sender

    sender = await resolve_sender(campaign["company_id"], campaign["settings"].get("sender_id"))
    if sender.kind == "platform" and not sender.from_email:
        raise HTTPException(status_code=400, detail="The platform email service has no From address. Configure it in the Commercial Console or add your own sender.")
    await _check_attachments(campaign["company_id"], (campaign.get("content") or {}).get("attachments"))
    status, when = _launch_status(action, scheduled_at)
    rows, summary = await _expand_mail_audience(campaign["company_id"], campaign.get("audience") or {})
    if not any(not r["suppressed"] for r in rows):
        raise HTTPException(status_code=400, detail="The audience has no valid, subscribed email addresses.")
    await raw_db()[RECIPIENTS].delete_many(scoped(campaign["company_id"], {"campaign_id": campaign["id"]}))
    await _insert_recipients(campaign, rows)
    await raw_db()[CAMPAIGNS].update_one(scoped(campaign["company_id"], {"id": campaign["id"]}), {"$set": {
        "status": status, "scheduled_at": when, "audience_summary": summary, "sender_label": sender.label,
        "sender_from": f"{sender.from_name} <{sender.from_email}>", "updated_at": iso(), "last_error": None,
    }})
    stats = await worker.recompute_stats(campaign["id"])
    worker.kick()
    return {"status": status, "scheduled_at": when, "summary": summary, "stats": stats}


@router.post("/mail/campaigns")
async def create_mail_campaign(body: MailCampaignIn, request: Request, action: Literal["draft", "send", "schedule"] = "draft",
                               scheduled_at: Optional[datetime] = None, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    company = await company_profile(company_id)
    campaign = _base_campaign(current_user, request, "email", body.name, company)
    campaign.update(_mail_fields(body))
    await raw_db()[CAMPAIGNS].insert_one(dict(campaign))
    result = None
    if action != "draft":
        try:
            result = await _launch_mail(campaign, action, scheduled_at)
        except HTTPException as exc:
            # Keep the work as a draft and report why it could not be sent.
            await raw_db()[CAMPAIGNS].update_one(scoped(company_id, {"id": campaign["id"]}), {"$set": {"last_error": str(exc.detail)}})
            raise HTTPException(status_code=exc.status_code, detail={"message": exc.detail, "campaign_id": campaign["id"]})
    doc = await _campaign_or_404(company_id, campaign["id"], "email")
    return {"campaign": _public_campaign(doc), "launch": result}


@router.put("/mail/campaigns/{campaign_id}")
async def update_mail_campaign(campaign_id: str, body: MailCampaignIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    doc = await _campaign_or_404(company_id, campaign_id, "email")
    if doc.get("status") != "draft":
        raise HTTPException(status_code=409, detail="Only draft campaigns can be edited. Duplicate it to make changes.")
    await raw_db()[CAMPAIGNS].update_one(scoped(company_id, {"id": campaign_id}), {"$set": {**_mail_fields(body), "updated_at": iso()}})
    return {"campaign": _public_campaign(await _campaign_or_404(company_id, campaign_id, "email"))}


@router.post("/mail/campaigns/{campaign_id}/launch")
async def launch_mail_campaign(campaign_id: str, body: LaunchIn, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    doc = await _campaign_or_404(company_id, campaign_id, "email")
    if doc.get("status") != "draft":
        raise HTTPException(status_code=409, detail="This campaign has already been sent or scheduled.")
    return await _launch_mail(doc, body.action, body.scheduled_at)


@router.post("/mail/campaigns/{campaign_id}/duplicate")
async def duplicate_mail_campaign(campaign_id: str, request: Request, current_user: User = Depends(get_current_user)):
    require_page(current_user, PAGE_MAIL)
    company_id = workspace_company_id(current_user)
    doc = await _campaign_or_404(company_id, campaign_id, "email")
    company = await company_profile(company_id)
    copy = _base_campaign(current_user, request, "email", f"{doc.get('name') or 'Campaign'} (copy)"[:160], company)
    copy.update({"settings": doc.get("settings") or {}, "content": doc.get("content") or {}, "audience": doc.get("audience") or {}})
    await raw_db()[CAMPAIGNS].insert_one(dict(copy))
    return {"campaign": _public_campaign(copy)}


# ═════════════════════════════════════════════════════════════════════════════
# Templates (both channels) and suppression lists
# ═════════════════════════════════════════════════════════════════════════════
def _register_template_routes(channel: str, prefix: str) -> None:
    page = _page_for_channel(channel)

    @router.get(f"{prefix}/templates", name=f"{channel}_template_list")
    async def list_templates(current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        docs = await raw_db()[TEMPLATES].find(scoped(company_id, {"channel": channel}), {"_id": 0}).sort("updated_at", DESCENDING).to_list(500)
        return {"items": docs}

    @router.post(f"{prefix}/templates", name=f"{channel}_template_create")
    async def create_template(body: TemplateIn, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        doc = {"id": new_id("ext"), "company_id": company_id, "channel": channel, **body.model_dump(),
               "created_by": str(current_user.id), "created_at": iso(), "updated_at": iso()}
        doc["name"] = clean_text(doc["name"], 120)
        await raw_db()[TEMPLATES].insert_one(dict(doc))
        return serialize(doc)

    @router.put(f"{prefix}/templates/{{template_id}}", name=f"{channel}_template_update")
    async def update_template(template_id: str, body: TemplateIn, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        res = await raw_db()[TEMPLATES].update_one(scoped(company_id, {"id": template_id, "channel": channel}),
                                                   {"$set": {**body.model_dump(), "name": clean_text(body.name, 120), "updated_at": iso()}})
        if not res.matched_count:
            raise HTTPException(status_code=404, detail="Template not found.")
        return {"updated": True}

    @router.delete(f"{prefix}/templates/{{template_id}}", name=f"{channel}_template_delete")
    async def delete_template(template_id: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        res = await raw_db()[TEMPLATES].delete_one(scoped(company_id, {"id": template_id, "channel": channel}))
        if not res.deleted_count:
            raise HTTPException(status_code=404, detail="Template not found.")
        return {"deleted": True}

    @router.get(f"{prefix}/suppressions", name=f"{channel}_suppression_list")
    async def list_suppressions(q: Optional[str] = None, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        query = scoped(company_id, {"channel": channel})
        if q:
            query["address"] = {"$regex": re.escape(q), "$options": "i"}
        docs = await raw_db()[SUPPRESSIONS].find(query, {"_id": 0}).sort("created_at", DESCENDING).limit(1000).to_list(1000)
        return {"items": docs, "total": await raw_db()[SUPPRESSIONS].count_documents(query)}

    @router.post(f"{prefix}/suppressions", name=f"{channel}_suppression_add")
    async def add_suppressions(body: SuppressionIn, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        added = 0
        for value in body.addresses[:10_000]:
            address = _normalize_address(channel, value)
            if not address:
                continue
            res = await raw_db()[SUPPRESSIONS].update_one(
                {"company_id": company_id, "channel": channel, "address": address},
                {"$setOnInsert": {"company_id": company_id, "channel": channel, "address": address,
                                  "reason": clean_text(body.reason, 200), "source": "manual", "created_at": iso()}},
                upsert=True,
            )
            added += 1 if res.upserted_id else 0
            if channel == "email":
                await raw_db()[CONTACTS].update_many(scoped(company_id, {"email": address}), {"$set": {"status": "unsubscribed"}})
        return {"added": added}

    @router.delete(f"{prefix}/suppressions/{{address}}", name=f"{channel}_suppression_remove")
    async def remove_suppression(address: str, current_user: User = Depends(get_current_user)):
        require_page(current_user, page)
        company_id = workspace_company_id(current_user)
        normalized = _normalize_address(channel, address) or address
        res = await raw_db()[SUPPRESSIONS].delete_one(scoped(company_id, {"channel": channel, "address": normalized}))
        if not res.deleted_count:
            raise HTTPException(status_code=404, detail="Address is not on the opt-out list.")
        return {"deleted": True}


_register_template_routes("whatsapp", "/whatsapp")
_register_template_routes("email", "/mail")
