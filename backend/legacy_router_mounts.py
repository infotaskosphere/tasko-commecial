"""Legacy router compatibility mounts kept outside backend.server.

This module contains the unchanged compatibility mount behavior extracted from
backend.server so the server remains a thin composition layer.
"""


def register_legacy_router_mounts(app, api_routers, root_routers):
    # ─────────────────────────────────────────────────────────────────────────────
    # LEGACY ROUTER COMPATIBILITY MOUNTS
    # Phase 2 extracted the application runtime from server.py, but a number of
    # pre-existing feature routers were only imported here and were no longer
    # attached to the live FastAPI app. Their frontend modules therefore returned
    # 404 even though the endpoint implementations still existed.
    #
    # Keep these mounts explicit and production-safe. The original prefixes and
    # router business logic are preserved exactly. include_in_schema=False avoids
    # duplicating already-present OpenAPI entries where a subsystem has also been
    # reached through the legacy api_router.
    # ─────────────────────────────────────────────────────────────────────────────

    # Routers that historically lived under the /api parent router.
    for _legacy_router in api_routers:
        app.include_router(
            _legacy_router,
            prefix="/api",
            include_in_schema=False,
        )

    # Routers that already carry their own /api/... prefix.
    for _legacy_root_router in root_routers:
        app.include_router(
            _legacy_root_router,
            include_in_schema=False,
        )
