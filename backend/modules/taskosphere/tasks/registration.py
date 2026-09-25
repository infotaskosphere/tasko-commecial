"""Controlled Taskosphere Tasks registration policy.

The policy is declarative and defaults to legacy ownership. It becomes
eligible for activation only after the complete architecture verification.
"""
from __future__ import annotations

from backend.modules.runtime_switch import is_migrated
from backend.modules.taskosphere.tasks.runtime import TASK_ROUTER_RUNTIME


MODULE_NAME = "taskosphere.tasks"


def registration_mode() -> str:
    return "migrated" if is_migrated(MODULE_NAME) else "legacy"


def migrated_router():
    if not is_migrated(MODULE_NAME):
        return None
    return TASK_ROUTER_RUNTIME.router
