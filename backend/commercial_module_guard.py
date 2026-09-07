"""Tenant-level module entitlement guard for commercial licenses.

The existing permission system remains authoritative for page/action access.
This layer only adds the hard commercial-license cap so an unlicensed module
cannot be reached through a direct API request either.
"""

from typing import Optional

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


def module_for_path(path: str) -> Optional[str]:
    normalized = path.split("?", 1)[0]
    if normalized.startswith("/api"):
        normalized = normalized[4:] or "/"
    for module, prefixes in MODULE_PREFIXES.items():
        if any(normalized == prefix or normalized.startswith(prefix + "/") for prefix in prefixes):
            return module
    return None


_original_get_current_user = _dependencies.get_current_user


async def get_current_user_with_commercial_guard(
    request: Request,
    credentials=Depends(_dependencies.security),
) -> User:
    user = await _original_get_current_user(credentials)
    # Internal/system admins have no tenant license and retain the existing
    # unrestricted behaviour. Commercial admins and all company staff are
    # capped by the licensed module set.
    if getattr(user, "company_id", None):
        module = module_for_path(request.url.path)
        if module and not has_module_access(user, module):
            raise HTTPException(status_code=403, detail=f"This company license does not include the {module} module.")
    return user


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_commercial_guard":
        _dependencies.get_current_user = get_current_user_with_commercial_guard
