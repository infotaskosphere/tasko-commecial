"""Vercel entry point for the Taskosphere FastAPI backend.

The application itself remains in backend/server.py. This adapter only exposes
that existing FastAPI application to Vercel's Python runtime.
"""

# Install the Platform Owner session compatibility before importing the app.
# This keeps owner authentication independent of customer subscription checks
# while preserving the owner's own company workspace.
from backend import platform_owner_session_compat as _owner_session_compat

_owner_session_compat.install()

from backend.server import app

_owner_session_compat.install_server_session_patch(__import__("backend.server", fromlist=["*"]))

__all__ = ["app"]
