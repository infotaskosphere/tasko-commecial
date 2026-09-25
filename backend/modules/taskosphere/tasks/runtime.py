"""Taskosphere Tasks controlled runtime adapter."""
from dataclasses import dataclass
from typing import Callable

from backend.modules.taskosphere.tasks.router import register


@dataclass(frozen=True)
class TaskRouterRuntime:
    register: Callable
    legacy_source: str = "backend.server_modules.task_routes"


TASK_ROUTER_RUNTIME = TaskRouterRuntime(register=register)
