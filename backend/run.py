"""Production launcher for the Python/FastAPI commercial backend.

This launcher keeps backend/server.py focused on the main application while
ensuring the commercial licensing API is registered before Uvicorn starts.
The registration is idempotent so the launcher remains safe if the licensing
router is also registered by the main application module.
"""

import asyncio
import os

import uvicorn

# Compatibility bootstrap MUST run before backend.server imports any routers.
# It normalizes legacy admin role casing and stale admin permission documents
# without granting any additional access to manager/staff users.
import backend.admin_identity_compat  # noqa: F401,E402

from backend.server import app
from backend.licensing_api import create_licensing_indexes, router as licensing_router


# Licensing is a normal FastAPI router; there is no second Node server.
# Avoid duplicate registration if server.py also registers it.
if not any(route.path == "/api/licensing/state" for route in app.routes):
    app.include_router(licensing_router, prefix="/api")


async def _prepare_licensing() -> None:
    try:
        await create_licensing_indexes()
    except Exception as exc:
        # Keep backend startup resilient if Mongo is temporarily unavailable.
        # The normal server startup/database retry path remains authoritative.
        import logging
        logging.getLogger(__name__).warning(
            "Commercial licensing index bootstrap skipped: %s", exc
        )


if __name__ == "__main__":
    asyncio.run(_prepare_licensing())
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=int(os.getenv("PORT", "10000")),
    )
