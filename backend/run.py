"""Production launcher for the Python/FastAPI commercial backend.

This is the migration bridge that keeps backend/server.py focused on application
routes while registering the commercial licensing API and its MongoDB indexes
before Uvicorn starts accepting traffic.
"""

import asyncio
import os

import uvicorn

from backend.server import app
from backend.licensing_api import create_licensing_indexes, router as licensing_router


# Licensing is now a normal FastAPI router; there is no second Node server.
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
