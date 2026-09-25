"""Runtime route-audit helpers for the architecture migration.

The audit is observational: it never mutates FastAPI routes or application
state. Duplicate route signatures are returned for controlled remediation.
"""
from __future__ import annotations

from collections import defaultdict
from typing import Any


def route_signature(route: Any) -> tuple[str, tuple[str, ...]]:
    path = getattr(route, "path", "")
    methods = tuple(sorted(getattr(route, "methods", ()) or ()))
    return path, methods


def find_duplicate_routes(app: Any) -> dict[tuple[str, tuple[str, ...]], list[Any]]:
    grouped: dict[tuple[str, tuple[str, ...]], list[Any]] = defaultdict(list)
    for route in getattr(app, "routes", ()):
        signature = route_signature(route)
        if signature[0]:
            grouped[signature].append(route)
    return {signature: routes for signature, routes in grouped.items() if len(routes) > 1}
