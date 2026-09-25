"""Taskosphere DSC migration boundary."""
from backend.server_modules.dsc_routes import register_dsc_routes

def register(namespace):
    return register_dsc_routes(namespace)

__all__ = ["register"]
