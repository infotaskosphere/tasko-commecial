"""Enumerate the routes an app or router actually serves.

Starlette 1.x stores included routers as lazy ``_IncludedRouter`` entries in
``app.routes`` instead of copying every route in, so ``route.path`` no longer
exists on every entry. This walks both layouts (old and new Starlette) and
yields each concrete route once, with its full path.
"""
from __future__ import annotations

from typing import Any, Iterator


def iter_routes(app_or_router: Any) -> Iterator[Any]:
    seen: set[tuple[int, str]] = set()

    def walk(routes: Any) -> Iterator[Any]:
        for route in list(routes or []):
            if type(route).__name__ == "_IncludedRouter":
                nested = list(route.effective_candidates()) + list(route.effective_low_priority_routes())
                yield from walk(nested)
                continue
            if getattr(route, "path", None) is None:
                continue
            key = id(getattr(route, "_effective_route", route))
            marker = (key, route.path)
            if marker in seen:
                continue
            seen.add(marker)
            yield route

    yield from walk(getattr(app_or_router, "routes", []))


def route_paths(app_or_router: Any) -> set[str]:
    return {str(route.path) for route in iter_routes(app_or_router)}
