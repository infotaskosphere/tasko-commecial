"""Shared startup compatibility hooks for direct Uvicorn deployments."""

# Import before backend.server imports route modules so legacy admin identity
# fields and roles are normalized before dependency resolution is assembled.
import backend.admin_identity_compat  # noqa: F401


def bootstrap_server(module_name: str) -> None:
    """Install session compatibility on the already-composed FastAPI module."""
    import sys
    from backend import platform_owner_session_compat

    platform_owner_session_compat.install()
    platform_owner_session_compat.install_server_session_patch(sys.modules[module_name])
