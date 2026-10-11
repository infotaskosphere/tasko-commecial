"""Startup diagnostic for duplicate or unexpected activity-ingestion route wiring.

Logs only route/function metadata. It never logs request headers, tokens, payloads,
or customer data. Kept separate from server.py to preserve the thin composition layer.
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


def _dependency_chain(dependant: Any, depth: int = 0) -> list[str]:
    calls: list[str] = []
    for item in getattr(dependant, "dependencies", []) or []:
        calls.append(f"{'  ' * depth}{_call_label(getattr(item, 'call', None))}")
        calls.extend(_dependency_chain(item, depth + 1))
    return calls


def log_activity_route_registry(app: Any) -> None:
    """Log every effective registration of POST /api/activity/log at startup."""
    matches = []
    for route in getattr(app, "routes", []) or []:
        path = str(getattr(route, "path", "") or "")
        methods = set(getattr(route, "methods", set()) or set())
        if path != "/api/activity/log" or "POST" not in methods:
            continue
        dependant = getattr(route, "dependant", None)
        matches.append({
            "route_type": type(route).__qualname__,
            "endpoint": _call_label(getattr(route, "endpoint", None)),
            "dependencies": _dependency_chain(dependant) if dependant else [],
        })

    logger.warning(
        "[ACTIVITY-ROUTE-DIAG] method=POST path=/api/activity/log "
        "registration_count=%d registrations=%s",
        len(matches),
        matches,
    )
