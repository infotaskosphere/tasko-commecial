"""SSE authentication compatibility for the commercial SaaS session token.

The Unified Inbox EventSource cannot send an Authorization header, so the
frontend supplies the access token as ``?token=...``.  Commercial logins use
an opaque SaaS session token, while the original SSE handler only attempted
JWT decoding.  This shim validates both token types and preserves the existing
SSE event stream without changing the WhatsApp message/inbox behavior.
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import HTTPException, Request
from fastapi.dependencies.utils import get_dependant
from fastapi.responses import StreamingResponse
from jose import JWTError, jwt

from backend import whatsapp_hub
from backend.dependencies import (
    ALGORITHM,
    JWT_SECRET,
    _get_saas_session_user,
)


async def _resolve_user(request: Request, token: Optional[str]):
    auth_header = request.headers.get("Authorization", "")
    raw_token = auth_header[7:] if auth_header.startswith("Bearer ") else token
    if not raw_token:
        raise HTTPException(401, "Authentication required")

    # Commercial SaaS sessions are opaque tokens stored hashed in sessions.
    user = await _get_saas_session_user(raw_token)
    if user is not None:
        return user

    # Keep compatibility with legacy JWT access tokens.
    try:
        payload = jwt.decode(raw_token, JWT_SECRET, algorithms=[ALGORITHM])
        user_id = payload.get("sub")
    except JWTError:
        user_id = None

    if not user_id:
        raise HTTPException(401, "Invalid token")

    db = whatsapp_hub._db()
    user_doc = await db["users"].find_one({"id": str(user_id)})
    if not user_doc:
        raise HTTPException(401, "User not found")

    user_doc.pop("_id", None)
    from backend.dependencies import _normalize_permissions
    from backend.models import User
    user_doc = _normalize_permissions(user_doc)
    try:
        return User(**user_doc)
    except Exception:
        raise HTTPException(401, "Invalid user session")


async def hub_events_compat(request: Request, token: Optional[str] = None):
    current_user = await _resolve_user(request, token)
    if not await whatsapp_hub._has_hub_access(current_user):
        raise HTTPException(403, "No WhatsApp Hub access")

    queue: asyncio.Queue = asyncio.Queue()
    whatsapp_hub._sse_queues.append(queue)

    async def generator():
        try:
            yield "event: connected\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    # SSE comment keeps the Render/browser connection alive.
                    yield ": keepalive\n\n"
                    continue

                event_name = payload.get("event", "message")
                data = payload.get("data", {})
                yield f"event: {event_name}\ndata: {json.dumps(data, default=str)}\n\n"
        finally:
            try:
                whatsapp_hub._sse_queues.remove(queue)
            except ValueError:
                pass

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


def install() -> None:
    """Replace only the existing SSE route endpoint before server includes it."""
    for route in whatsapp_hub.router.routes:
        if getattr(route, "path", "") == "/whatsapp/hub/events":
            route.endpoint = hub_events_compat
            route.dependant = get_dependant(path=route.path, call=hub_events_compat)
            break
