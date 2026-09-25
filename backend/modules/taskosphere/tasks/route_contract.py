"""Taskosphere Tasks route equivalence contract.

Captures the legacy router's route signatures without modifying it. This is
used before the runtime ownership switch.
"""
from __future__ import annotations

from backend.server_modules.task_routes import router as legacy_router
from backend.modules.taskosphere.tasks.router import router as migrated_router


def route_signatures(router):
    return {
        (
            getattr(route, "path", ""),
            tuple(sorted(getattr(route, "methods", ()) or ())),
        )
        for route in router.routes
        if getattr(route, "path", "")
    }


def assert_route_equivalence() -> None:
    legacy = route_signatures(legacy_router)
    migrated = route_signatures(migrated_router)
    if legacy != migrated:
        missing = sorted(legacy - migrated)
        extra = sorted(migrated - legacy)
        raise AssertionError(f"Taskosphere Tasks route mismatch: missing={missing}, extra={extra}")
