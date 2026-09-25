"""Shared commercial dashboard entitlement normalization."""
from typing import Dict, List

from backend.modules.people_matrix.permissions.catalog import MODULE_HIERARCHY

DASHBOARD_FLAG_BY_MODULE = {
    "taskosphere": "can_view_dashboard",
    "finix": "can_view_accounting_reports",
    "compliance": "can_view_compliance",
    "records": "can_view_documents",
    "proposals": "can_view_all_leads",
    "people_matrix": "can_view_user_page",
}


def normalize_dashboard_feature_selection(selected_features: Dict[str, List[str]]) -> Dict[str, List[str]]:
    """Dashboard is selected only when every other page in its module is selected."""
    normalized = {
        str(module_id): list(dict.fromkeys(str(flag).strip() for flag in (flags or [])))
        for module_id, flags in (selected_features or {}).items()
    }
    for module_id, dashboard_flag in DASHBOARD_FLAG_BY_MODULE.items():
        flags = normalized.get(module_id, [])
        all_flags = [str(page.get("flag")) for page in MODULE_HIERARCHY.get(module_id, {}).get("pages", []) if page.get("flag")]
        if dashboard_flag not in all_flags:
            continue
        required = [flag for flag in all_flags if flag != dashboard_flag]
        if required and all(flag in flags for flag in required):
            if dashboard_flag not in flags:
                flags.append(dashboard_flag)
        else:
            flags = [flag for flag in flags if flag != dashboard_flag]
        # Keep the module dashboard/report entry point available whenever the
        # module itself has selected features. Other page selections remain
        # restrictive and are still enforced individually.
        if flags and dashboard_flag not in flags:
            flags.append(dashboard_flag)
        normalized[module_id] = flags
    return normalized
