"""Shared startup compatibility hooks for direct Uvicorn deployments."""

# Import before backend.server imports route modules so legacy admin identity
# fields and roles are normalized before dependency resolution is assembled.
import backend.admin_identity_compat  # noqa: F401


def bootstrap_server(module_name: str) -> None:
    """Install session/license compatibility on the already-composed FastAPI module."""
    import sys
    from backend import platform_owner_session_compat

    platform_owner_session_compat.install()
    platform_owner_session_compat.install_server_session_patch(sys.modules[module_name])

    # Commercial entitlement hydration must be installed after the server and
    # dependency modules exist. This keeps the auth patch out of import-time
    # circular dependencies while ensuring every authenticated request sees
    # the current license/module/page ceiling, including EngageX.
    from backend import commercial_license_entitlement_compat
    commercial_license_entitlement_compat.install()
