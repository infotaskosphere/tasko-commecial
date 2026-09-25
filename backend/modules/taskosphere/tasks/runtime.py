"""Taskosphere Tasks controlled runtime adapter.

This adapter is intentionally passive. It exposes the migrated router and
its legacy source through one object so the composition root can switch
ownership only after route equivalence is verified.
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from backend.modules.taskosphere.tasks.router import router as migrated_router


@dataclass(frozen=True)
class TaskRouterRuntime:
    router: APIRouter = migrated_router
    legacy_source: str = "backend.server_modules.task_routes"


TASK_ROUTER_RUNTIME = TaskRouterRuntime()
