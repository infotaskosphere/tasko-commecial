"""Startup diagnostic for activity-ingestion routing across FastAPI versions.

Logs static route/function metadata only; no request headers, tokens, payloads,
or customer data are inspected or logged.
"""
from __future__ import annotations

import logging
from typing import Any, Iterator

from fastapi import FastAPI

logger = logging.getLogger("activity_route_diagnostic")

try:
    # Available in newer FastAPI releases that defer router inclusion.
    from fastapi.routing import iter_route_contexts as _iter_route_contexts
except ImportError:  # older FastAPI used by the Python 3.11 test environment
    _iter_route_contexts = None


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


def _fallback_route_contexts(routes: Any, prefix: str = "", seen: set[int] | None = None) -> Iterator[dict[str, Any]]:
    """Best-effort walk for older FastAPI APIRouter internals."""
    visited = seen if seen is not None else set()
    for route in routes or []:
        if id(route) in visited:
            continue
        visited.add(id(route))
        path = str(getattr(route, "path", "") or "")
        effective_path = f"{prefix}{path}" if path else ""
        if path and getattr(route, "methods", None):
            yield {
                "path": effective_path,
                "methods": getattr(route, "methods", set()) or set(),
                "endpoint": getattr(route, "endpoint", None),
                "dependant": getattr(route, "dependant", None),
                "dependencies": getattr(route, "dependencies", []) or [],
                "route_type": type(route).__qualname__,
            }
        children = getattr(route, "routes", None)
        if children:
            yield from _fallback_route_contexts(children, effective_path.rsplit("/", 1)[0] if path else prefix, visited)


def log_activity_route_registry(app: FastAPI) -> None:
    """Log effective prefixed routes; use FastAPI's context walker where supported."""
    matches: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    wildcard_posts: list[dict[str, Any]] = []

    try:
        if _iter_route_contexts is not None:
            route_rows = (
                {
                    "path": getattr(route, "path", "") or "",
                    "methods": getattr(route, "methods", set()) or set(),
                    "endpoint": getattr(route, "endpoint", None),
                    "dependant": getattr(route, "dependant", None),
                    "dependencies": getattr(route, "dependencies", []) or [],
                    "route_type": type(getattr(route, "original_route", route)).__qualname__,
                }
                for route in _iter_route_contexts(getattr(app, "routes", []) or [])
            )
        else:
            # Never fail application import on a diagnostic utility. This
            # fallback is intentionally best-effort on old FastAPI versions.
            route_rows = _fallback_route_contexts(getattr(app, "routes", []) or [])
        for route in route_rows:
            path = str(route.get("path") or "")
            methods = set(route.get("methods") or set())
            endpoint = _call_label(route.get("endpoint"))
            if "POST" not in methods:
                continue

            if any(token in path for token in ("{path:path}", "{full_path:path}", "{rest:path}")):
                wildcard_posts.append({"path": path, "endpoint": endpoint})
            if path.endswith("/activity/log") or ("activity" in path.lower() and "log" in path.lower()):
                candidates.append({"path": path, "endpoint": endpoint})
            if path != "/api/activity/log":
                continue
            matches.append({
                "path": path,
                "route_type": route.get("route_type", "<unknown>"),
                "endpoint": endpoint,
                "dependencies": _dependency_chain(route.get("dependant")),
                "include_dependency_names": [
                    _call_label(getattr(dep, "dependency", None))
                    for dep in (route.get("dependencies") or [])
                ],
            })
    except Exception:
        logger.exception("[ACTIVITY-ROUTE-DIAG] Route inventory failed safely")

    logger.warning(
        "[ACTIVITY-ROUTE-DIAG] method=POST path=/api/activity/log "
        "fastapi_context_walker=%s registration_count=%d registrations=%s "
        "related_post_routes=%s wildcard_post_routes=%s",
        bool(_iter_route_contexts),
        len(matches),
        matches,
        candidates,
        wildcard_posts,
    )
