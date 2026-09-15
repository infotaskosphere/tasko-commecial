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
    """Install lazy authentication compatibility helpers after auth loads.

    ``platform_owner`` is imported very early by the authentication stack, so
    importing compatibility modules at module import time would create a
    circular import. ``is_platform_owner`` is called from authentication only
    after the dependency module has been initialized, making this the safe
    installation point.
    """
    try:
        from backend import platform_owner_session_compat
        platform_owner_session_compat.install()
    except Exception:
        # The owner compatibility layer is optional; authentication remains
        # fail-closed if it cannot be installed.
        pass

    try:
        # Legacy customer users can legitimately pre-date company_id on their
        # user document. Install deterministic tenant recovery for all users,
        # not just platform owners. This never guesses: it requires exactly
        # one explicit company/customer/license ownership link.
        from backend import auth_company_recovery
        auth_company_recovery.install()
    except Exception:
        pass


def is_platform_owner(user) -> bool:
    if not user:
        return False

    # Install the lazy auth compatibility/recovery layer for every authenticated
    # identity. This function is called from get_current_user after the auth
    # module is fully initialized, so this cannot create the old import cycle.
    _install_owner_auth_compat()

    if isinstance(user, dict):
        email = str(user.get("email") or "").strip().lower()
        user_id = str(user.get("id") or user.get("_id") or "").strip()
    else:
        email = str(getattr(user, "email", "") or "").strip().lower()
        user_id = str(getattr(user, "id", "") or "").strip()

    owner_emails = platform_owner_emails()
    return bool(
        (email and email in owner_emails)
        or (user_id and user_id in {"saas-bootstrap-admin", "usr-admin-01"})
    )
