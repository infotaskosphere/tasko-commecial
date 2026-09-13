"""Compatibility bridge for the Sales/Invoicing feature gate.

The commercial governance UI stores the licensed Sales feature as
``can_view_sale``. The older invoicing router, however, protects every
invoicing endpoint with ``can_manage_invoices``. Without this bridge an admin
can be shown Sales/Invoicing as licensed while every invoice read/stats/create
request still returns HTTP 403.

This bridge does not grant invoicing to an unlicensed customer. It only maps
the selected Sales feature to the legacy API gate for an administrator whose
role already has ``can_manage_invoices`` in the default permission template.
Managers/staff keep their role-level restriction.
"""

from backend import dependencies as _dependencies


_INSTALLED = False


def install():
    global _INSTALLED
    if _INSTALLED:
        return

    original = _dependencies._normalize_permissions

    def normalize_with_invoicing_compat(data):
        normalized = original(data)
        if not isinstance(normalized, dict):
            return normalized

        permissions = dict(normalized.get("permissions") or {})
        role = str(normalized.get("role") or "").strip().lower()
        modules = normalized.get("licensed_modules") or normalized.get("modules") or []
        modules = {str(v).strip().lower().replace("-", "_") for v in modules if v}

        selected_features = normalized.get("selected_features")
        if not isinstance(selected_features, dict):
            selected_features = (normalized.get("company") or {}).get("selected_features")
        if not isinstance(selected_features, dict):
            selected_features = {}

        finix_selected = "finix" in modules
        selected_finix = selected_features.get("finix")
        if selected_finix is None:
            selected_finix = selected_features.get("accounting")
        sales_feature_selected = isinstance(selected_finix, list) and "can_view_sale" in selected_finix

        # Only the admin role receives the default invoice-management grant.
        # This is deliberately NOT a blanket grant to all users with Sales
        # licensed; manager/staff permissions remain governed by their role.
        if role == "admin" and finix_selected and sales_feature_selected:
            permissions["can_manage_invoices"] = True
        elif not finix_selected or (isinstance(selected_finix, list) and not sales_feature_selected):
            permissions["can_manage_invoices"] = False

        normalized["permissions"] = permissions
        return normalized

    _dependencies._normalize_permissions = normalize_with_invoicing_compat
    _INSTALLED = True
