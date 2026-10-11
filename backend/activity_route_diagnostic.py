"""Startup diagnostic for duplicate or unexpected activity-ingestion route wiring.

Logs only static route/function metadata. It never logs request headers, tokens,
payloads, or customer data. Kept separate from server.py to preserve the thin
composition layer.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("activity_route_diagnostic")


def _call_label(call: Any) -> str:
    if call is None:
        return "<none>"
    module = str(getattr(call, "__module__", "") or type(call).__module__)
    name = str(
        getattr(call, "__qualname__", "")
        or getattr(call, "__name__", "")
        or type(call).__qualname__
    )
    return f"{module}.{name}"


def _dependency_chain(dependant: Any, depth: int = 0, seen: set[int] | None = None) -> list[str]:
    calls: list[str] = []
    if dependant is None:
        return calls
    visited = seen if seen is not None else set()
    identity = id(dependant)
    if identity in visited:
        calls.append(f"{'  ' * depth}<dependency-cycle-suppressed>")
        return calls
    visited.add(identity)
    for item in getattr(dependant, "dependencies", []) or []:
        calls.append(f"{'  ' * depth}{_call_label(getattr(item, 'call', None))}")
        calls.extend(_dependency_chain(item, depth + 1, visited))
    return calls


def _walk_routes(routes: Any, seen: set[int] | None = None):
    """Walk FastAPI's nested IncludedRouter trees as well as direct routes."""
    visited = seen if seen is not None else set()
    for route in routes or []:
        identity = id(route)
        if identity in visited:
            continue
        visited.add(identity)
        yield route
        children = getattr(route, "routes", None)
        if children:
            yield from _walk_routes(children, visited)


def log_activity_route_registry(app: Any) -> None:
    """Log every effective registration of POST /api/activity/log at startup."""
    matches = []
    candidates = []
    for route in _walk_routes(getattr(app, "routes", []) or []):
        path = str(getattr(route, "path", "") or "")
        methods = set(getattr(route, "methods", set()) or set())
        if "POST" in methods and (path.endswith("/activity/log") or "activity" in path.lower() and "log" in path.lower()):
            candidates.append({
                "path": path,
                "route_type": type(route).__qualname__,
                "endpoint": _call_label(getattr(route, "endpoint", None)),
            })
        if path != "/api/activity/log" or "POST" not in methods:
            continue
        dependant = getattr(route, "dependant", None)
        matches.append({
            "path": path,
            "route_type": type(route).__qualname__,
            "endpoint": _call_label(getattr(route, "endpoint", None)),
            "dependencies": _dependency_chain(dependant),
        })

    logger.warning(
        "[ACTIVITY-ROUTE-DIAG] method=POST path=/api/activity/log "
        "registration_count=%d registrations=%s nearby_post_routes=%s",
        len(matches),
        matches,
        candidates,
    )
