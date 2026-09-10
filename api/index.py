"""Vercel entry point for the Taskosphere FastAPI backend.

The application itself remains in backend/server.py. This adapter only exposes
that existing FastAPI application to Vercel's Python runtime.
"""

from backend.server import app

__all__ = ["app"]
