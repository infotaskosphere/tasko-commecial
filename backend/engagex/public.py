"""Public (unauthenticated) MailMaster endpoints: unsubscribe and open tracking.

Each recipient row has an unguessable per-message token; nothing else is
accepted, and responses never reveal which company or campaign a token
belongs to beyond the sending company's display name.
"""
from __future__ import annotations

import base64
import html
import logging

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, Response

from .common import CAMPAIGNS, CONTACTS, MEDIA, RECIPIENTS, SUPPRESSIONS, iso, raw_db

logger = logging.getLogger("engagex.public")
router = APIRouter(prefix="/engagex-public", tags=["engagex-public"])

_PIXEL = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")
_NO_STORE = {"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0", "Pragma": "no-cache"}


def _page(title: str, body: str) -> HTMLResponse:
    return HTMLResponse(
        f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>{html.escape(title)}</title>
<style>body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#f1f5f9;font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a}}
main{{max-width:440px;margin:24px;padding:32px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(15,23,42,.08);text-align:center}}
h1{{font-size:22px;margin:0 0 8px}}p{{color:#475569;margin:0 0 20px}}button{{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 22px;background:#0f172a;color:#fff;cursor:pointer}}</style>
</head><body><main>{body}</main></body></html>""",
        headers=_NO_STORE,
    )


async def _recipient(token: str):
    if not token or len(token) > 64:
        return None
    return await raw_db()[RECIPIENTS].find_one({"token": token, "channel": "email"}, {"_id": 0})


async def _sender_name(recipient: dict) -> str:
    campaign = await raw_db()[CAMPAIGNS].find_one({"id": recipient.get("campaign_id")}, {"_id": 0, "sender_company": 1})
    return (campaign or {}).get("sender_company") or "the sender"


async def _unsubscribe(recipient: dict, source: str) -> None:
    company_id, email = recipient["company_id"], recipient.get("email")
    now = iso()
    await raw_db()[SUPPRESSIONS].update_one(
        {"company_id": company_id, "channel": "email", "address": email},
        {"$setOnInsert": {"company_id": company_id, "channel": "email", "address": email, "reason": "Unsubscribed via email link",
                          "source": source, "campaign_id": recipient.get("campaign_id"), "created_at": now}},
        upsert=True,
    )
    await raw_db()[CONTACTS].update_many({"company_id": company_id, "email": email}, {"$set": {"status": "unsubscribed", "updated_at": now}})
    await raw_db()[RECIPIENTS].update_one({"token": recipient["token"]}, {"$set": {"unsubscribed_at": now}})
    # Anything still queued for this address in this company is skipped.
    await raw_db()[RECIPIENTS].update_many(
        {"company_id": company_id, "channel": "email", "email": email, "status": "pending"},
        {"$set": {"status": "skipped", "error": "Unsubscribed", "updated_at": now}},
    )


@router.get("/u/{token}", response_class=HTMLResponse)
async def unsubscribe_page(token: str):
    recipient = await _recipient(token)
    if not recipient:
        return _page("Link expired", "<h1>This link is no longer valid</h1><p>You can reply to the email to ask the sender to remove you.</p>")
    sender = html.escape(await _sender_name(recipient))
    if recipient.get("unsubscribed_at"):
        return _page("Unsubscribed", f"<h1>You're unsubscribed</h1><p>You will no longer receive marketing emails from {sender}.</p>")
    return _page(
        "Unsubscribe",
        f"""<h1>Unsubscribe?</h1><p>Stop receiving marketing emails from {sender} at <b>{html.escape(recipient.get('email') or '')}</b>.</p>
<form method="post"><button type="submit">Unsubscribe</button></form>""",
    )


@router.post("/u/{token}", response_class=HTMLResponse)
async def unsubscribe_confirm(token: str, request: Request):
    """Handles both the confirm button and RFC 8058 one-click POSTs."""
    recipient = await _recipient(token)
    if not recipient:
        return _page("Link expired", "<h1>This link is no longer valid</h1>")
    await _unsubscribe(recipient, "one-click" if "List-Unsubscribe=One-Click" in (await request.body()).decode(errors="ignore") else "link")
    sender = html.escape(await _sender_name(recipient))
    return _page("Unsubscribed", f"<h1>You're unsubscribed</h1><p>You will no longer receive marketing emails from {sender}.</p>")


@router.get("/o/{token}.gif")
async def open_pixel(token: str):
    try:
        await raw_db()[RECIPIENTS].update_one(
            {"token": token, "channel": "email", "opened_at": None},
            {"$set": {"opened_at": iso()}},
        )
    except Exception:  # tracking must never break image rendering
        logger.debug("EngageX open tracking failed", exc_info=True)
    return Response(content=_PIXEL, media_type="image/gif", headers=_NO_STORE)


_PUBLIC_IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp"}


@router.get("/a/{token}/{filename}")
async def public_asset(token: str, filename: str):
    """Serve MailMaster banner/inline images to email clients.

    Only raster image types uploaded as public email assets are served (never
    HTML/SVG), so the endpoint cannot be used to host active content.
    """
    doc = None
    if token and len(token) <= 64:
        doc = await raw_db()[MEDIA].find_one(
            {"public_token": token, "purpose": {"$in": ["banner", "image"]}},
            {"_id": 0, "base64": 1, "mime_type": 1},
        )
    if not doc or doc.get("mime_type") not in _PUBLIC_IMAGE_TYPES:
        return Response(status_code=404, headers=_NO_STORE)
    return Response(
        content=base64.b64decode(doc["base64"]),
        media_type=doc["mime_type"],
        headers={"Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff"},
    )
