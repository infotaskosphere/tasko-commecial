"""Taskosphere task router migration adapter.

The legacy extracted subsystem is namespace-bound rather than exposing a
standalone APIRouter. Preserve that contract until physical extraction.
"""
from backend.server_modules.task_routes import register_task_routes

def register(namespace):
    return register_task_routes(namespace)

__all__ = ["register"]
