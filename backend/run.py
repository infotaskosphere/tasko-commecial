"""Production launcher for the Python/FastAPI commercial backend.

This launcher keeps backend/server.py focused on the main application while
ensuring the commercial licensing API is registered before Uvicorn starts.
The registration is idempotent so the launcher remains safe if the licensing
router is also registered by the main application module.
"""

import asyncio
import os

import uvicorn


import backend.server as server_module
from backend.licensing_api import create_licensing_indexes, router as licensing_router

app = server_module.app

# Register the composed startup lifecycle exactly once. The legacy code keeps
# the startup orchestration in backend.server_modules.application_runtime, but
# it was not attached to FastAPI in the production launcher. Without this,
# index/bootstrap/scheduler initialization silently never runs on fresh workers.
# Starlette 1.x removed add_event_handler/on_startup; FastAPI still supports
# on_event (deprecated) on both old and new versions, so register through it.
if not getattr(app.state, "_taskosphere_startup_registered", False):
    app.on_event("startup")(server_module.startup_event)
    app.state._taskosphere_startup_registered = True

# Performance layer is deliberately installed after the application has loaded
# all routes, but before Uvicorn starts accepting traffic. It does not alter
# tenant/license/permission decisions; it only coalesces identical authenticated
# dashboard GETs for a couple of seconds.
from backend.performance_runtime import install_performance_cache
install_performance_cache(app)

# (Platform Owner sessions: see backend/platform_owner_sessions.py, called
# directly by dependencies._get_saas_session_user and the login route.)

# Licensing is a normal FastAPI router; there is no second Node server.
# Avoid duplicate registration if server.py also registers it.
if not any(getattr(route, "path", None) == "/api/licensing/state" for route in app.routes):
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
