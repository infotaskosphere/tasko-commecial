"""Taskosphere attendance router migration adapter."""
from backend.server_modules.attendance_routes import register_attendance_routes

def register(namespace):
    return register_attendance_routes(namespace)

__all__ = ["register"]
