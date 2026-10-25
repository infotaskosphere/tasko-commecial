"""Compatibility bridge for tenant-admin control-plane permissions.

The commercial license controls operational modules/pages. It must not remove
permissions that belong to the tenant's own Admin control plane. This bridge
keeps that rule isolated so the existing commercial licensing logic remains
unchanged for non-admin users.
"""

from backend.models import DEFAULT_ROLE_PERMISSIONS

CONTROL_PLANE_FLAGS = {
    "can_access_admin",
    "can_view_user_page",
    "can_manage_users",
    "can_manage_permissions",
    "can_manage_settings",
    "can_view_master_data",
    "can_manage_master_data",
    "can_view_roles",
    "can_manage_roles",
    "can_view_backup_restore",
    "can_view_security_sessions",
    "can_view_staff_activity",
    "can_view_reports",
    "can_download_reports",
    "can_view_audit_logs",
    "can_view_selected_users_reports",
    "can_view_staff_rankings",
}

_installed = False


def _restore_control_plane_permissions(permission_map):
    result = dict(permission_map or {})
    defaults = dict(DEFAULT_ROLE_PERMISSIONS.get("admin", {}) or {})
    for flag in CONTROL_PLANE_FLAGS:
        result[flag] = bool(defaults.get(flag, True))
    return result


def install():
    global _installed
    if _installed:
        return

    from backend import commercial_licensee_admin
    from backend import commercial_module_guard

    original = commercial_licensee_admin.get_all_admin_permissions
    if getattr(original, "_onenexa_control_plane", False):
        _installed = True
        return

    def get_all_admin_permissions_with_control_plane(license_doc=None):
        return _restore_control_plane_permissions(original(license_doc))

    get_all_admin_permissions_with_control_plane._onenexa_control_plane = True
    get_all_admin_permissions_with_control_plane._original = original

    commercial_licensee_admin.get_all_admin_permissions = get_all_admin_permissions_with_control_plane
    commercial_module_guard.get_all_admin_permissions = get_all_admin_permissions_with_control_plane
    _installed = True
