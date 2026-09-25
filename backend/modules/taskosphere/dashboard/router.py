"""Taskosphere dashboard migration boundary."""
from backend.server_modules.dashboard_ops import register_dashboard_ops

def register(namespace):
    return register_dashboard_ops(namespace)

__all__ = ["register"]
