"""Taskosphere task service migration facade.

Production implementation remains authoritative until migration regression is complete.
"""
from backend.server_modules.task_routes import router

__all__ = ["router"]
