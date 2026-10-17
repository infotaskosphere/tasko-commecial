"""Internal WhatsApp bridge webhook authentication guard."""
from __future__ import annotations

import os
import secrets

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

# Every endpoint the WhatsApp bridge calls back on. These carry no user login,
# so the shared bridge secret is the only thing that stops anyone on the
# internet from injecting messages or flipping session status.
_PROTECTED_PREFIXES = (
    "/api/whatsapp/hub/webhook/",
    "/api/whatsapp/webhook/",
)


async def verify(request: Request) -> None:
    expected = str(os.getenv("WA_BRIDGE_SECRET") or "").strip()
    supplied = str(request.headers.get("X-WA-Bridge-Secret") or "").strip()
    production = str(os.getenv("ENV_MODE") or "").strip().lower() == "production"

    if production and not expected:
        raise HTTPException(
            status_code=503,
            detail="WhatsApp bridge security is not configured.",
        )

    if not expected and not production:
        # Local development without a bridge secret configured.
        return

    if not expected or not supplied or not secrets.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=401,
            detail="Invalid WhatsApp bridge authentication.",
        )


def install(app) -> None:
    @app.middleware("http")
    async def bridge_webhook_guard(request: Request, call_next):
        path = str(request.url.path or "")
        if path.startswith(_PROTECTED_PREFIXES):
            try:
                await verify(request)
            except HTTPException as exc:
                return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)
        return await call_next(request)
