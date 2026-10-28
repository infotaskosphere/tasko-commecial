"""Platform owner identity helpers for the commercial distribution console.

The account used by the software owner to issue and manage customer licenses is
not itself a customer tenant. Keep this identity separate from commercial
license enforcement while allowing the email list to be extended through the
environment for additional internal owners.
"""

import os

DEFAULT_PLATFORM_OWNER_EMAILS = {
    "info.taskosphere@gmail.com",
    "infotaskosphere@gmail.com",
    "admin@taskosphere.com",
    "csmanthandesai@gmail.com",
}


def platform_owner_emails() -> set[str]:
    configured = os.getenv("PLATFORM_OWNER_EMAILS", "") or os.getenv("PLATFORM_OWNER_EMAIL", "")
    values = {item.strip().lower() for item in configured.split(",") if item.strip()}
    return values.union(DEFAULT_PLATFORM_OWNER_EMAILS)


def _install_owner_auth_compat() -> None:
    try:
        from backend import platform_owner_session_compat
        platform_owner_session_compat.install()
    except Exception:
        pass
    try:
        from backend import auth_company_recovery
        auth_company_recovery.install()
    except Exception:
        pass
    try:
        from backend import admin_control_plane_compat
        admin_control_plane_compat.install()
    except Exception:
        pass


def is_platform_owner(user) -> bool:
    if not user:
        return False
    _install_owner_auth_compat()
    if isinstance(user, dict):
        email = str(user.get("email") or "").strip().lower()
        user_id = str(user.get("id") or user.get("_id") or "").strip()
        role = str(user.get("role") or "").strip().lower()
        is_owner_flag = bool(user.get("is_platform_owner") or user.get("isPlatformOwner"))
        identity_type = str(user.get("identity_type") or "").strip().lower()
        licensee_uid = str(user.get("licensee_uid") or "").strip()
        commercial_customer_id = str(user.get("commercial_customer_id") or "").strip()
        license_id = str(user.get("license_id") or "").strip()
        platform_owner_uid = str(user.get("platform_owner_uid") or "").strip().upper()
        identity_org_uid = str(user.get("identity_org_uid") or "").strip().upper()
        user_uid = str(user.get("user_uid") or "").strip().upper()
        company_id = str(user.get("company_id") or user.get("company", {}).get("id") or "").strip().lower()
    else:
        email = str(getattr(user, "email", "") or "").strip().lower()
        user_id = str(getattr(user, "id", "") or "").strip()
        role = str(getattr(user, "role", "") or "").strip().lower()
        is_owner_flag = bool(getattr(user, "is_platform_owner", False) or getattr(user, "isPlatformOwner", False))
        identity_type = str(getattr(user, "identity_type", "") or "").strip().lower()
        licensee_uid = str(getattr(user, "licensee_uid", "") or "").strip()
        commercial_customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
        license_id = str(getattr(user, "license_id", "") or "").strip()
        platform_owner_uid = str(getattr(user, "platform_owner_uid", "") or "").strip().upper()
        identity_org_uid = str(getattr(user, "identity_org_uid", "") or "").strip().upper()
        user_uid = str(getattr(user, "user_uid", "") or "").strip().upper()
        company_id = str(getattr(user, "company_id", "") or "").strip().lower()

    # A record that belongs to a licensee (customer) is NEVER the Platform
    # Owner, whatever email, role string or UID it carries. This check must run
    # first: otherwise a licensee admin who changes their own email to a
    # reserved owner address is promoted to Platform Owner.
    if identity_type.startswith("licensee") or identity_type == "commercial" or licensee_uid or commercial_customer_id or license_id:
        return False
    if is_owner_flag or role in {"platform_owner", "superadmin", "saas_admin"} or identity_type.startswith("platform_owner"):
        return True
    if platform_owner_uid.startswith("PO-") or identity_org_uid.startswith("PO-") or user_uid.startswith("PO-"):
        return True
    if email and email in platform_owner_emails():
        return True
    return bool(
        (email and email in platform_owner_emails())
        or (user_id and user_id in {"saas-bootstrap-admin", "usr-admin-01"})
        or company_id == "platform-owner-48fe785fdd75127f"
        or company_id.startswith("platform-owner-")
    )


_OWNER_PRINCIPAL_ROLES = {"platform_owner", "superadmin", "saas_admin"}
_OWNER_BOOTSTRAP_IDS = {"saas-bootstrap-admin", "usr-admin-01"}


def _plain_role(user) -> str:
    role = user.get("role") if isinstance(user, dict) else getattr(user, "role", "")
    for candidate in (getattr(role, "value", None), getattr(role, "name", None), role):
        normalized = str(candidate or "").strip().lower()
        if normalized:
            return normalized.rsplit(".", 1)[-1]
    return ""


def is_platform_owner_admin(user) -> bool:
    if not is_platform_owner(user):
        return False
    get = user.get if isinstance(user, dict) else (lambda key, default=None: getattr(user, key, default))
    role = _plain_role(user)
    if role == "admin" or role in _OWNER_PRINCIPAL_ROLES:
        return True
    email = str(get("email") or "").strip().lower()
    if email and email in platform_owner_emails():
        return True
    user_id = str(get("id") or get("_id") or "").strip()
    return user_id in _OWNER_BOOTSTRAP_IDS
