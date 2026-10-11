"""Startup diagnostic for activity-ingestion routing on modern FastAPI.

Logs static route/function metadata only; no request headers, tokens, payloads,
or customer data are inspected or logged.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi.routing import iter_route_contexts

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


def log_activity_route_registry(app: Any) -> None:
    """Log effective prefixed routes, including FastAPI 0.137+ IncludedRouter entries."""
    matches = []
    candidates = []
    wildcard_posts = []
    try:
        contexts = list(iter_route_contexts(getattr(app, "routes", []) or []))
    except Exception:
        logger.exception("[ACTIVITY-ROUTE-DIAG] Could not expand FastAPI route contexts")
        contexts = []

    for route in contexts:
        path = str(getattr(route, "path", "") or "")
        methods = set(getattr(route, "methods", set()) or set())
        endpoint = _call_label(getattr(route, "endpoint", None))
        if "POST" not in methods:
            continue

        if any(token in path for token in ("{path:path}", "{full_path:path}", "{rest:path}")):
            wildcard_posts.append({"path": path, "endpoint": endpoint})

        if path.endswith("/activity/log") or ("activity" in path.lower() and "log" in path.lower()):
            candidates.append({"path": path, "endpoint": endpoint})

        if path != "/api/activity/log":
            continue
        dependant = getattr(route, "dependant", None)
        matches.append({
            "path": path,
            "endpoint": endpoint,
            "dependencies": _dependency_chain(dependant),
            "include_dependency_names": [
                _call_label(getattr(dep, "dependency", None))
                for dep in (getattr(route, "dependencies", None) or [])
            ],
        })

    logger.warning(
        "[ACTIVITY-ROUTE-DIAG] method=POST path=/api/activity/log "
        "registration_count=%d registrations=%s related_post_routes=%s wildcard_post_routes=%s",
        len(matches),
        matches,
        candidates,
        wildcard_posts,
    )
