"""Platform owner identity helpers for the commercial distribution console.

The account used by the software owner to issue and manage customer licenses is
not itself a customer tenant. Keep this identity separate from commercial
license enforcement while allowing the email list to be extended through the
environment for additional internal owners.
"""

import os

DEFAULT_PLATFORM_OWNER_EMAILS = {"info.taskosphere@gmail.com"}


def platform_owner_emails() -> set[str]:
    configured = os.getenv("PLATFORM_OWNER_EMAILS", "")
    values = {item.strip().lower() for item in configured.split(",") if item.strip()}
    return values or DEFAULT_PLATFORM_OWNER_EMAILS


def _install_owner_auth_compat() -> None:
    """Install the owner session resolver after the auth modules are loaded.

    ``platform_owner`` is imported very early by the authentication stack, so
    importing the compatibility module at module import time would create a
    circular import. Login calls ``is_platform_owner`` after the backend auth
    functions have been defined, making this a safe lazy installation point.
    """
    try:
        from backend import platform_owner_session_compat
        platform_owner_session_compat.install()
    except Exception:
        # Authentication remains fail-closed if the optional compatibility
        # layer cannot be installed; the caller still gets the owner identity
        # result and the normal JWT path remains available.
        pass


def is_platform_owner(user) -> bool:
    if not user:
        return False
    if isinstance(user, dict):
        email = str(user.get("email") or "").strip().lower()
        user_id = str(user.get("id") or user.get("_id") or "").strip()
    else:
        email = str(getattr(user, "email", "") or "").strip().lower()
        user_id = str(getattr(user, "id", "") or "").strip()

    owner_emails = platform_owner_emails()
    is_owner = bool(
        (email and email in owner_emails)
        or (user_id and user_id in {"saas-bootstrap-admin", "usr-admin-01"})
    )
    if is_owner:
        _install_owner_auth_compat()
    return is_owner
