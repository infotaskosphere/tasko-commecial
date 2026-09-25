"""Taskosphere client migration boundary."""
from backend.server_modules.client_management import register_client_management

def register(namespace):
    return register_client_management(namespace)

__all__ = ["register"]
