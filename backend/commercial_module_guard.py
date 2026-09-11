"""Tenant-level commercial entitlement guard.

The existing permission system remains authoritative for page/action access.
This layer adds the commercial-license hard cap at the API boundary so an
unlicensed module or individually unlicensed feature cannot be reached by a
direct request.
"""

from typing import Optional, Tuple

from fastapi import Depends, HTTPException, Request

from backend import dependencies as _dependencies
from backend.governance_core import has_module_access
from backend.models import User

MODULE_PREFIXES = {
    "taskosphere": (
        "/tasks", "/todos", "/todo", "/attendance", "/reminders", "/action-center",
        "/visits", "/ai-reader", "/client-portal-manager",
    ),
    "finix": (
        "/finix-dashboard", "/invoicing", "/purchase", "/bank-accounts", "/chart-of-accounts",
        "/journal-entries", "/accounting-reports", "/zero-touch-entry", "/gst-portal-sync",
        "/accounting-integrity", "/day-book", "/cash-bank-book", "/cash-flow", "/outstanding-report",
        "/bank-reconciliation", "/depreciation", "/tds-tcs", "/financial-ratios", "/comparative-report",
        "/yearly-report", "/opening-balances", "/accounting-audit-trail", "/bulk-import", "/due-dates",
        "/import-invoices",
    ),
    "compliance": (
        "/compliance-dashboard", "/compliance", "/gst-reconciliation", "/trademark-sphere",
        "/mis-report", "/salary-slips", "/roc-sphere",
    ),
    "records": (
        "/records-dashboard", "/client-approvals", "/dsc", "/documents", "/clients", "/passwords",
    ),
    "proposals": (
        "/client-proposals-dashboard", "/leads", "/quotations", "/client-discussion",
    ),
    "people_matrix": (
        "/people-matrix", "/users", "/staff-activity", "/reports", "/leave", "/payroll", "/hr",
        "/recruitment", "/performance",
    ),
}

# API/page prefixes mapped to the existing MODULE_HIERARCHY page flags. This
# deliberately uses the existing permission flags instead of inventing a
# second feature-permission model.
FEATURE_PREFIXES = {
    "taskosphere": {
        "can_view_dashboard": ("/dashboard",),
        "can_view_tasks": ("/tasks",),
        "can_view_todo_dashboard": ("/todos", "/todo"),
        "can_view_attendance": ("/attendance",),
        "can_view_reminders": ("/reminders",),
        "can_view_action_center": ("/action-center",),
        "can_view_client_visits": ("/visits",),
        "can_view_ai_document_reader": ("/ai-reader",),
        "can_view_client_portal": ("/client-portal-manager",),
        "can_reset_client_passwords": ("/client-portal-manager/password", "/client-portal-manager/reset"),
    },
    "finix": {
        "can_view_accounting_reports": ("/finix-dashboard", "/accounting-reports"),
        "can_view_sale": ("/invoicing", "/sales", "/invoices"),
        "can_view_purchase": ("/purchase", "/purchase-invoices"),
        "can_view_bank": ("/bank-accounts", "/cash-bank-book", "/cash-flow"),
        "can_view_chart_of_accounts": ("/chart-of-accounts",),
        "can_manage_chart_of_accounts": ("/chart-of-accounts/manage",),
        "can_view_journal_entries": ("/journal-entries", "/day-book"),
        "can_post_journal_entries": ("/journal-entries/post", "/zero-touch-entry"),
        "can_match_bank": ("/bank-reconciliation",),
    },
    "compliance": {
        "can_view_compliance": ("/compliance-dashboard", "/compliance"),
        "can_manage_compliance": ("/compliance/manage",),
        "can_view_gst_reconciliation": ("/gst-reconciliation",),
        "can_view_trademark_sphere": ("/trademark-sphere",),
        "can_view_mis_report": ("/mis-report",),
        "can_manage_mis_report": ("/mis-report/manage",),
        "can_view_salary_slips": ("/salary-slips",),
        "can_manage_salary_slips": ("/salary-slips/manage",),
        "can_view_roc_sphere": ("/roc-sphere",),
        "can_manage_roc_sphere": ("/roc-sphere/manage",),
    },
    "records": {
        "can_view_all_dsc": ("/dsc",),
        "can_view_documents": ("/documents",),
        "can_view_passwords": ("/passwords",),
        "can_edit_passwords": ("/passwords/manage",),
        "can_view_all_clients": ("/clients", "/client-approvals"),
        "can_edit_clients": ("/clients/manage",),
        "can_approve_clients": ("/clients/approve", "/client-approvals/approve"),
        "can_approve_whatsapp_wishes": ("/automation/whatsapp",),
        "can_approve_email_wishes": ("/automation/email",),
    },
    "proposals": {
        "can_view_all_leads": ("/leads",),
        "can_create_quotations": ("/quotations",),
        "can_view_client_discussion": ("/client-discussion",),
        "can_manage_client_discussion": ("/client-discussion/manage",),
    },
    "people_matrix": {
        "can_view_user_page": ("/users",),
        "can_view_leave": ("/leave",),
        "can_manage_leave": ("/leave/manage",),
        "can_view_payroll": ("/payroll",),
        "can_manage_payroll": ("/payroll/manage",),
        "can_view_hr": ("/hr",),
        "can_manage_hr": ("/hr/manage",),
        "can_view_recruitment": ("/recruitment",),
        "can_manage_recruitment": ("/recruitment/manage",),
        "can_view_performance": ("/performance",),
        "can_manage_performance": ("/performance/manage",),
    },
}


def _matches(path: str, prefixes: Tuple[str, ...]) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes)


def module_for_path(path: str) -> Optional[str]:
    normalized = path.split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    for module, prefixes in MODULE_PREFIXES.items():
        if _matches(normalized, prefixes):
            return module
    return None


def feature_for_path(path: str) -> Optional[Tuple[str, str]]:
    normalized = path.split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    for module, features in FEATURE_PREFIXES.items():
        for flag, prefixes in features.items():
            if _matches(normalized, prefixes):
                return module, flag
    return None


_original_get_current_user = _dependencies.get_current_user


async def _is_commercial_account(user: User) -> bool:
    role_key = str(getattr(user, "role_key", "") or "").lower()
    if role_key.startswith("commercial_"):
        return True
    company_id = str(getattr(user, "company_id", "") or "")
    if not company_id:
        return False
    company = await _dependencies.db.companies.find_one({"id": company_id}, {"_id": 0, "source": 1})
    return bool(company and company.get("source") == "commercial-license")


def _permission_flag(user: User, flag: str) -> bool:
    permissions = getattr(user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()
    if str(getattr(user, "role", "")).lower() == "admin":
        if isinstance(permissions, dict) and permissions.get(flag) is False:
            return False
        return True
    if not isinstance(permissions, dict):
        return False
    return bool(permissions.get(flag, False))


async def get_current_user_with_commercial_guard(
    request: Request,
    credentials=Depends(_dependencies.security),
) -> User:
    user = await _original_get_current_user(credentials)
    if await _is_commercial_account(user):
        module = module_for_path(request.url.path)
        if module and not has_module_access(user, module):
            raise HTTPException(status_code=403, detail=f"This company license does not include the {module} module.")
        feature = feature_for_path(request.url.path)
        if feature:
            feature_module, feature_flag = feature
            if not has_module_access(user, feature_module) or not _permission_flag(user, feature_flag):
                raise HTTPException(status_code=403, detail=f"This company license does not include the {feature_flag} feature.")
    return user


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_commercial_guard":
        _dependencies.get_current_user = get_current_user_with_commercial_guard
