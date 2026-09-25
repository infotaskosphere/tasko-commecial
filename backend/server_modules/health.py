from __future__ import annotations
from fastapi import FastAPI
from fastapi.responses import JSONResponse

def _health_route_paths():
    """Best-effort scan of every currently-registered /api/* path, walking
    into sub-routers. Never raises — /health must always answer even if
    route introspection fails for some reason."""
    seen_ids = set()

    def walk(routes):
        for r in routes:
            path = getattr(r, "path", None)
            if path and id(r) not in seen_ids:
                seen_ids.add(id(r))
                if path.startswith("/api"):
                    yield path
            sub = getattr(r, "routes", None)
            if sub:
                yield from walk(sub)

    try:
        return sorted(set(walk(app.routes)))
    except Exception as e:
        return [f"__route_scan_failed__: {e}"]



@app.api_route("/health", methods=["GET", "HEAD"])
async def health():
    all_paths = _health_route_paths()
    return JSONResponse({
        "status": "ok",
        "cors": "configured correctly",
        "build_marker": BUILD_MARKER,
        "client_groups_routes_present": any(
            p.startswith("/api/client-groups") for p in all_paths
        ),
        "total_api_routes": len(all_paths),
    })



@app.get("/")
async def root():
    return {"message": "Server is running"}


# ====================== SECURITY & DB ======================
rankings_cache = {}
# Store cache times as timezone-aware UTC datetimes for consistent comparison
rankings_cache_time: Dict[str, datetime] = {}


# ===================== HELPER FUNCTIONS =====================
