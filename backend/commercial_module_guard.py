"""Tenant-level commercial entitlement guard.

A commercial licensee contact is a normal application administrator inside its
own licensed customer tenant. The administrator bypasses per-user governance,
but never bypasses the commercial license boundary itself.
"""
from typing import Optional, Tuple

from fastapi import Depends, HTTPException, Request

from backend import dependencies as _dependencies
from backend.models import User
from backend.platform_owner import is_platform_owner
from backend.commercial_licensee_admin import resolve_license_modules, get_all_admin_permissions

# Capture the authentication dependency that exists immediately before this
# compatibility layer is installed. commercial_admin_permission_compat is
# intentionally included here, so commercial admins are hydrated once from
# their live license and the request wrapper can then add the tenant boundary.
_BASE_GET_CURRENT_USER = _dependencies.get_current_user

MODULE_PREFIXES = {
    "taskosphere": ("/tasks", "/todos", "/todo", "/attendance", "/reminders", "/action-center", "/visits", "/ai-reader", "/client-portal-manager"),
    "finix": ("/finix-dashboard", "/invoicing", "/purchase", "/bank-accounts", "/chart-of-accounts", "/journal-entries", "/accounting-reports", "/zero-touch-entry", "/gst-portal-sync", "/accounting-integrity", "/day-book", "/cash-bank-book", "/cash-flow", "/outstanding-report", "/bank-reconciliation", "/depreciation", "/tds-tcs", "/financial-ratios", "/comparative-report", "/yearly-report", "/opening-balances", "/accounting-audit-trail", "/bulk-import", "/due-dates", "/import-invoices"),
    "compliance": ("/compliance-dashboard", "/compliance", "/gst-reconciliation", "/trademark-sphere", "/mis-report", "/salary-slips", "/roc-sphere"),
    "records": ("/records-dashboard", "/client-approvals", "/dsc", "/documents", "/clients", "/passwords"),
    "proposals": ("/client-proposals-dashboard", "/leads", "/quotations", "/client-discussion"),
    "people_matrix": ("/people-matrix", "/users", "/staff-activity", "/reports", "/leave", "/payroll", "/hr", "/recruitment", "/performance"),
}

FEATURE_PREFIXES = {
    "taskosphere": {"can_view_dashboard": ("/dashboard",), "can_view_tasks": ("/tasks",), "can_view_todo_dashboard": ("/todos", "/todo"), "can_view_attendance": ("/attendance",), "can_view_reminders": ("/reminders",), "can_view_action_center": ("/action-center",), "can_view_client_visits": ("/visits",), "can_view_ai_document_reader": ("/ai-reader",), "can_view_client_portal": ("/client-portal-manager",), "can_reset_client_passwords": ("/client-portal-manager/password", "/client-portal-manager/reset")},
    "finix": {"can_view_accounting_reports": ("/finix-dashboard", "/accounting-reports"), "can_view_sale": ("/invoicing", "/sales", "/invoices"), "can_view_purchase": ("/purchase", "/purchase-invoices"), "can_view_bank": ("/bank-accounts", "/cash-bank-book", "/cash-flow"), "can_view_chart_of_accounts": ("/chart-of-accounts",), "can_manage_chart_of_accounts": ("/chart-of-accounts/manage",), "can_view_journal_entries": ("/journal-entries", "/day-book"), "can_post_journal_entries": ("/journal-entries/post", "/zero-touch-entry"), "can_match_bank": ("/bank-reconciliation",)},
    "compliance": {"can_view_compliance": ("/compliance-dashboard", "/compliance"), "can_manage_compliance": ("/compliance/manage",), "can_view_gst_reconciliation": ("/gst-reconciliation",), "can_view_trademark_sphere": ("/trademark-sphere",), "can_view_mis_report": ("/mis-report",), "can_manage_mis_report": ("/mis-report/manage",), "can_view_salary_slips": ("/salary-slips",), "can_manage_salary_slips": ("/salary-slips/manage",), "can_view_roc_sphere": ("/roc-sphere",), "can_manage_roc_sphere": ("/roc-sphere/manage",)},
    "records": {"can_view_all_dsc": ("/dsc",), "can_view_documents": ("/documents",), "can_view_passwords": ("/passwords",), "can_edit_passwords": ("/passwords/manage",), "can_view_clients": ("/client-approvals",), "can_edit_clients": ("/clients/manage",), "can_approve_clients": ("/clients/approve", "/client-approvals/approve"), "can_approve_whatsapp_wishes": ("/automation/whatsapp",), "can_approve_email_wishes": ("/automation/email",)},
    "proposals": {"can_view_all_leads": ("/leads",), "can_create_quotations": ("/quotations",), "can_view_client_discussion": ("/client-discussion",), "can_manage_client_discussion": ("/client-discussion/manage",)},
    "people_matrix": {"can_view_user_page": ("/users/manage",), "can_view_leave": ("/leave",), "can_manage_leave": ("/leave/manage",), "can_view_payroll": ("/payroll",), "can_manage_payroll": ("/payroll/manage",), "can_view_hr": ("/hr",), "can_manage_hr": ("/hr/manage",), "can_view_recruitment": ("/recruitment",), "can_manage_recruitment": ("/recruitment/manage",), "can_view_performance": ("/performance",), "can_manage_performance": ("/performance/manage",)},
}


def _matches(path: str, prefixes: Tuple[str, ...]) -> bool:
    return any(path == prefix or path.startswith(prefix + "/") for prefix in prefixes)


def module_for_path(path: str, method: str = "GET") -> Optional[str]:
    normalized = path.split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    if method == "GET":
        if normalized == "/users" or (normalized.startswith("/users/") and not any(sub in normalized for sub in ("/salary-report", "/offboard"))):
            return None
        if normalized in ("/clients", "/clients/search"):
            return None
    for module, prefixes in MODULE_PREFIXES.items():
        if _matches(normalized, prefixes):
            return module
    return None


def feature_for_path(path: str, method: str = "GET") -> Optional[Tuple[str, str]]:
    normalized = path.split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    if method == "GET":
        if normalized == "/users" or (normalized.startswith("/users/") and not any(sub in normalized for sub in ("/salary-report", "/offboard"))):
            return None
        if normalized in ("/clients", "/clients/search"):
            return None
    for module, features in FEATURE_PREFIXES.items():
        for flag, prefixes in features.items():
            if _matches(normalized, prefixes):
                return module, flag
    return None


async def _commercial_license(user: User) -> Optional[dict]:
    db = getattr(_dependencies, "_raw_db", _dependencies.db)
    customer_id = str(getattr(user, "commercial_customer_id", "") or "").strip()
    license_id = str(getattr(user, "license_id", "") or "").strip()
    company_id = str(getattr(user, "company_id", "") or "").strip()
    clauses = []
    if customer_id:
        clauses.append({"customer_id": customer_id})
    if license_id:
        clauses.append({"id": license_id})
    if company_id:
        company = await db.companies.find_one({"id": company_id}, {"_id": 0, "commercial_customer_id": 1, "license_id": 1, "source": 1})
        if company:
            if company.get("commercial_customer_id"):
                clauses.append({"customer_id": str(company["commercial_customer_id"])})
            if company.get("license_id"):
                clauses.append({"id": str(company["license_id"])})
    if not clauses:
        return None
    docs = await db.commercial_licenses.find({"$or": clauses, "status": {"$in": ["active", "trial"]}}, {"_id": 0}).sort("issued_at", -1).limit(10).to_list(10)
    from backend.licensing_api import _expiry_reason
    for doc in docs:
        if not _expiry_reason(doc):
            return doc
    return None


def _hydrate_admin(user: User, license_doc: dict) -> User:
    if str(getattr(user, "role", "")).lower() != "admin":
        return user
    data = user.model_dump()
    data["commercial_customer_id"] = data.get("commercial_customer_id") or license_doc.get("customer_id")
    data["license_id"] = license_doc.get("id")
    data["license_key"] = license_doc.get("license_key")
    data["licensed_modules"] = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
    data["selected_features"] = license_doc.get("selected_features") or {}
    data["permissions"] = get_all_admin_permissions(license_doc)
    return User.model_validate(data)


def _licensed_module(module: str, license_doc: dict) -> bool:
    return module in resolve_license_modules(license_doc)


def _permission_flag(user: User, flag: str, license_doc: dict) -> bool:
    permissions = getattr(user, "permissions", None)
    if hasattr(permissions, "model_dump"):
        permissions = permissions.model_dump()
    if not isinstance(permissions, dict):
        return False
    return bool(permissions.get(flag, False))


async def get_current_user_with_commercial_guard(request: Request, credentials=Depends(_dependencies.security)) -> User:
    user = await _BASE_GET_CURRENT_USER(credentials)
    if is_platform_owner(user):
        return user

    commercial = await _commercial_license(user)
    if not commercial:
        return user

    user = _hydrate_admin(user, commercial)

    module = module_for_path(request.url.path, request.method)
    if module and not _licensed_module(module, commercial):
        raise HTTPException(status_code=403, detail=f"This company license does not include the {module} module.")

    feature = feature_for_path(request.url.path, request.method)
    if feature:
        feature_module, feature_flag = feature
        if not _licensed_module(feature_module, commercial):
            raise HTTPException(status_code=403, detail=f"This company license does not include the {feature_module} module.")
        if not _permission_flag(user, feature_flag, commercial):
            raise HTTPException(status_code=403, detail=f"This company license does not include the {feature_flag} feature.")

    return user


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_commercial_guard":
        _dependencies.get_current_user = get_current_user_with_commercial_guard
