"""Central tenant-isolation helpers for the commercial SaaS backend."""

from __future__ import annotations

import inspect
import logging
import os
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Mapping

from fastapi import HTTPException, status

from backend.platform_owner import is_platform_owner

logger = logging.getLogger(__name__)

COMPANY_FIELD = "company_id"
COMPANY_ID_FIELD = "id"

TENANT_COLLECTIONS = {
    # Identity / user master data
    "users",
    "backup_jobs",
    # Audit trail. Previously unscoped: a licensee admin calling /audit-logs
    # received every tenant's (and the Platform Owner's) audit rows, including
    # old_data/new_data permission payloads. Rows are now stamped with and
    # filtered by company_id like every other tenant collection.
    "audit_logs",
    # Additional tenant business / operational collections discovered by static audit
    "activity_logs", "api_usage", "automation_settings", "bank_learned_mappings",
    "billing_history", "client", "client_email_templates", "client_portal_reset_tokens",
    "computer_activity", "copilot_actions", "copilot_sessions", "customer_usage",
    "dashboard_cache", "desktop_activity", "desktop_agents", "desktop_browser",
    "desktop_dsc", "desktop_health", "desktop_logs", "desktop_productivity",
    "desktop_updates", "desktop_usb", "embeddings", "gst_audit_logs", "journals",
    "performance_metrics", "plugin_events", "portal_folder_template", "portal_messages",
    "portal_settings", "products", "rule_improvements", "telegram_conversations",
    "unprepared_incomes", "vector_embeddings", "vendor_intelligence", "website_configs",
    "workflow_templates",
    # Tasks & Todos & Visits
    "tasks", "todos", "reminders", "visits", "due_dates",
    # Clients, Drive, & Discussions
    "clients", "client_activities", "client_drive_visibility", "client_discussions",
    "client_portal_users", "client_portal_activity",
    # Invoicing, Banking, & Accounting
    "invoices", "payments", "purchase_invoices", "purchase_payments", "purchases",
    "bank_accounts", "bank_transactions", "bank_rules", "bank_reconciliation",
    "bank_reconciliation_matches", "bank_reconciliation_audit", "bank_statistics",
    "bank_transaction_history", "bank_learning", "bank_statement_templates", "cashflow_history",
    "chart_of_accounts", "accounting_audit_trail", "bulk_import_jobs", "finix_ai_proposals", "finix_ai_documents", "finix_ai_learning", "journal_entries", "journal_lines",
    "accounting_audit", "accounting_audit_locks", "accounting_audit_sequences",
    "accounting_locks", "accounting_posting_failures", "accounting_rules", "accounting_sequences",
    "adjustment_note_overrides", "ledger_learning", "posting_history", "posting_audit", "journal_templates", "voucher_history",
    "party_ledgers", "opening_balances", "fixed_assets", "depreciation_runs",
    "tds_tcs_entries", "einvoice_history", "ewaybill_history", "standalone_govt_fees", "financial_validations", "reconciliation_events",
    # Leads & Quotations
    "leads", "quotations",
    # Records & Vaults
    "dsc_register", "passwords", "password_access_logs", "documents",
    # Compliance & Filings
    "compliances", "compliance_records", "compliance_masters", "compliance_assignments",
    "compliance_comments", "trademark_sphere", "trademark_sphere_reminders",
    "trademark_qc_reports", "trademark_qc_branding", "roc_companies", "roc_documents",
    "gst_reconciliation_history", "gst_reconciliation_sessions", "gst_returns",
    "gst_compliances", "gst_compliance", "gst_audit", "gst_portal_snapshots", "gst_portal_registrations",
    "gst_trade_names", "gst_vendor_profiles", "gst_portal_audit_risk", "gst_learning", "gst_processing_history", "gst_validation", "itc_register",
    "vendor_profiles", "vendor_rule_overrides", "vendor_learning_history",
    # HR, Attendance & Payroll
    "attendance", "identix_attendance", "salary_slips", "salary_employees", "departments", "designations",
    "salary_manual_companies", "interview_candidates", "leaves", "holidays", "staff_activity",
    # MIS & Analytics
    "mis_manual", "mis_transactions", "mis_uploads", "analytics_data", "kpi_history",
    # AI & Workflow
    "knowledge_base", "learning_events", "manual_corrections", "recommendation_history",
    "learning_audit", "template_usage_history", "ai_validation_results", "ai_confidence_history", "ai_anomaly_history",
    "ai_document_memory", "ai_document_workspace", "ai_workspace_knowledge", "document_classifications",
    "ocr_processing_history", "ocr_quality_reports",
    "workflow_definitions", "workflow_instances", "workflow_history", "aiweave_conversations", "aiweave_executions", "aiweave_provider_accounts", "aiweave_provider_models", "aiweave_routing_rules",
    "approval_requests", "approval_history", "automation_rules", "business_events",
    "pending_client_messages", "service_expiries", "password_sheet_links", "reminder_dup_ignores",
    "notification_history", "workflow_audit", "notifications",
    "whatsapp_hub_contacts", "whatsapp_hub_groups", "whatsapp_hub_messages",
    "zte_processed_documents", "zte_category_rules", "template_library"
}

COMPANY_REGISTRY_COLLECTION = "companies"

_current_company: ContextVar[str | None] = ContextVar("taskosphere_company_id", default=None)
_current_platform_owner: ContextVar[bool] = ContextVar("taskosphere_platform_owner", default=False)
# A Platform Owner may operate multiple companies created/owned in Master Data.
# This allow-list is filled from server-derived, owner-scoped company records
# during authentication; it never comes from a request parameter.
_current_platform_owner_company_ids: ContextVar[frozenset[str]] = ContextVar(
    "taskosphere_platform_owner_company_ids", default=frozenset()
)
# Verified aliases map a stale Platform Owner legacy ID to its canonical
# company. They are constructed from authenticated DB state, never request data.
_current_platform_owner_company_aliases: ContextVar[dict[str, str]] = ContextVar(
    "taskosphere_platform_owner_company_aliases", default={}
)
_system_context: ContextVar[bool] = ContextVar("taskosphere_system_context", default=False)


def set_authenticated_company(company_id: Any):
    value = str(company_id).strip() if company_id is not None else ""
    if not value:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")
    return _current_company.set(value)


def reset_authenticated_company(token) -> None:
    _current_company.reset(token)


def authenticated_company_id() -> str | None:
    return _current_company.get()


def set_platform_owner(value: bool = True):
    return _current_platform_owner.set(bool(value))


def reset_platform_owner(token) -> None:
    _current_platform_owner.reset(token)


def set_platform_owner_company_ids(company_ids: Any):
    """Set server-resolved operational companies available to this owner request."""
    values = frozenset(
        str(value).strip()
        for value in (company_ids or [])
        if value is not None and str(value).strip()
    )
    return _current_platform_owner_company_ids.set(values)


def reset_platform_owner_company_ids(token) -> None:
    _current_platform_owner_company_ids.reset(token)


def platform_owner_company_ids() -> frozenset[str]:
    return _current_platform_owner_company_ids.get()


def set_platform_owner_company_aliases(aliases: Any):
    """Set verified aliases for stale IDs from this authenticated owner identity."""
    allowed = platform_owner_company_ids()
    resolved = {}
    if isinstance(aliases, Mapping):
        for alias, canonical in aliases.items():
            old_id = str(alias or "").strip()
            new_id = str(canonical or "").strip()
            if old_id and new_id and old_id != new_id and new_id in allowed:
                resolved[old_id] = new_id
    return _current_platform_owner_company_aliases.set(resolved)


def reset_platform_owner_company_aliases(token) -> None:
    _current_platform_owner_company_aliases.reset(token)


def platform_owner_company_aliases() -> dict[str, str]:
    """Aliases from authenticated context plus deployment-configured stale IDs.

    The environment mapping is explicitly controlled by deployment operators
    and only applies while a request/task is running in Platform Owner context.
    It is used for known historical company IDs that have been verified absent
    from both the company registry and commercial-license registry.
    """
    aliases = dict(_current_platform_owner_company_aliases.get())
    canonical = str(os.getenv("PLATFORM_OWNER_WORKSPACE_ID") or "").strip()
    configured_legacy_ids = {
        value.strip()
        for value in str(os.getenv("PLATFORM_OWNER_LEGACY_COMPANY_IDS") or "").split(",")
        if value.strip()
    }
    if in_platform_owner_context() and canonical:
        allowed = platform_owner_company_ids()
        # If the per-request allow-list is populated, the canonical destination
        # must be on it. An empty list is tolerated only for this exact,
        # deployment-configured alias and never broadens access to other IDs.
        if not allowed or canonical in allowed:
            for old_id in configured_legacy_ids:
                if old_id != canonical:
                    aliases.setdefault(old_id, canonical)
    return aliases


def _owner_default_company_id() -> str | None:
    """Select an owner-scoped default without trusting the request parameter."""
    current = str(authenticated_company_id() or "").strip()
    allowed = platform_owner_company_ids()
    if current and allowed and current in allowed:
        return current
    canonical = str(os.getenv("PLATFORM_OWNER_WORKSPACE_ID") or "").strip()
    if in_platform_owner_context() and canonical and (not allowed or canonical in allowed):
        return canonical
    if current and not allowed:
        return current
    return current or None


def _normalize_owner_company_filter(value: Any) -> Any:
    aliases = platform_owner_company_aliases()
    if isinstance(value, dict):
        if set(value) == {"$eq"}:
            raw = value["$eq"]
            return {"$eq": aliases.get(str(raw).strip(), raw)}
        if set(value) == {"$in"} and isinstance(value["$in"], (list, tuple, set)):
            return {"$in": [aliases.get(str(item).strip(), item) for item in value["$in"]]}
        return value
    if value is None:
        return value
    return aliases.get(str(value).strip(), value)


def _owner_company_value_allowed(value: Any) -> bool:
    """Validate an owner-selected company against its server-side allow-list."""
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return False
    candidate = str(value).strip()
    if not candidate:
        return False
    allowed = platform_owner_company_ids()
    aliases = platform_owner_company_aliases()
    if candidate in aliases:
        target = aliases[candidate]
        if allowed:
            return target in allowed
        return bool(
            in_platform_owner_context()
            and target == str(os.getenv("PLATFORM_OWNER_WORKSPACE_ID") or "").strip()
        )
    # Backward-compatible strict fallback when authentication could not
    # resolve the owner's company registry; never widen to arbitrary IDs.
    if not allowed:
        return candidate == str(authenticated_company_id() or "").strip()
    return candidate in allowed


def _owner_company_filter_allowed(value: Any) -> bool:
    if isinstance(value, dict):
        if set(value) == {"$eq"}:
            return _owner_company_value_allowed(value["$eq"])
        if set(value) == {"$in"} and isinstance(value["$in"], (list, tuple, set)):
            candidates = list(value["$in"])
            return bool(candidates) and all(_owner_company_value_allowed(item) for item in candidates)
        return False
    return _owner_company_value_allowed(value)


def in_platform_owner_context() -> bool:
    return _current_platform_owner.get()


def in_system_context() -> bool:
    return _system_context.get()


@contextmanager
def system_context():
    """Explicitly mark trusted internal jobs as system-scoped.

    This is intentionally opt-in. It is not exposed to request handlers and
    must only be used by trusted server-side maintenance/scheduler code.
    """
    token = _system_context.set(True)
    try:
        yield
    finally:
        _system_context.reset(token)


def get_company_id(current_user: Any) -> str:
    company_id = getattr(current_user, COMPANY_FIELD, None)
    if company_id is None or not str(company_id).strip():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Authenticated user is not associated with a company")
    return str(company_id).strip()


def company_filter(current_user: Any, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    query = {COMPANY_FIELD: get_company_id(current_user)}
    if extra:
        query.update(dict(extra))
    return query


def enforce_company_value(current_user: Any, value: Any) -> str:
    # Platform owners are intentionally allowed to operate across customer
    # companies. Normal tenant users remain strictly company-scoped.
    if in_platform_owner_context():
        if value is not None and str(value).strip():
            return str(value).strip()
        company_id = getattr(current_user, COMPANY_FIELD, None)
        if company_id is not None and str(company_id).strip():
            return str(company_id).strip()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Company context is required for this operation")
    authenticated = get_company_id(current_user)
    if value is not None and str(value).strip() != authenticated:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    return authenticated


def force_company_id(current_user: Any, record: dict[str, Any]) -> dict[str, Any]:
    result = dict(record)
    result[COMPANY_FIELD] = enforce_company_value(current_user, result.get(COMPANY_FIELD))
    return result


def assert_record_company(current_user: Any, record: Mapping[str, Any] | None) -> None:
    if record is None:
        return
    if in_platform_owner_context():
        return
    authenticated = get_company_id(current_user)
    if record.get(COMPANY_FIELD) is None or str(record.get(COMPANY_FIELD)) != authenticated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Record not found")


# Modules that only WRAP TenantAwareCollection methods. Their frames sit on the
# call stack of every tenant query, so they must never count as "the caller is
# the commercial control plane". Before this list existed,
# backend.commercial_tenant_scope.find (a wrapper whose module name starts with
# "backend.commercial_") made every Platform Owner query look like a control-
# plane call, so the owner's operational reads (tasks, invoices, clients, ...)
# were returned unscoped across ALL licensees.
ISOLATION_PLUMBING_MODULES = frozenset({
    "backend.tenant_runtime",
    "backend.commercial_tenant_scope",
    "backend.commercial_user_company_scope",
    "backend.commercial_guard_request_compat",
    "backend.commercial_legacy_company_scope_compat",
    "backend.commercial_license_user_limit",
    "backend.commercial_company_registry_visibility",
    "backend.user_projection_compat",
})


def _is_commercial_control_context() -> bool:
    """Return True for commercial control-plane, licensing, and system setup operations."""
    if in_system_context():
        return True
    for frame_info in inspect.stack(context=0):
        module_name = str(frame_info.frame.f_globals.get("__name__") or "")
        if module_name in ISOLATION_PLUMBING_MODULES:
            continue
        if (
            module_name.startswith("backend.commercial_")
            or module_name.startswith("backend.licensing_")
            or module_name.startswith("backend.platform_owner")
            or module_name == "backend.backup_restore"
        ):
            return True
    return False


def _blank_company_filter(value: Any) -> bool:
    """True for an absent/blank company filter such as ``company_id=""``.

    Pages call endpoints like ``/chart-of-accounts?company_id=`` before a firm is
    picked. A blank filter means "my own company", never "another company", so it
    is replaced by the authenticated company instead of raising 403.
    """
    return value is None or (isinstance(value, str) and not value.strip())


def _scope_query(query: Any) -> dict[str, Any]:
    company_id = authenticated_company_id()
    base = dict(query or {}) if isinstance(query, dict) else {}
    if in_platform_owner_context():
        if _is_commercial_control_context():
            return base
        if COMPANY_FIELD in base and _blank_company_filter(base.get(COMPANY_FIELD)):
            base.pop(COMPANY_FIELD, None)
        # Operational modules (Sales, Purchases, Banking, Accounting, Clients,
        # etc.) must always stay in the Platform Owner's own workspace.
        # Never let a caller-supplied company_id switch the owner into a
        # licensee's tenant. Cross-tenant management belongs only to the
        # explicitly trusted commercial control-plane paths above.
        requested = base.get(COMPANY_FIELD)
        if requested is not None and not _owner_company_filter_allowed(requested):
            logger.warning(
                "Platform Owner tenant scope denied requested=%r authenticated_company_id=%r owner_company_ids=%s",
                requested, company_id, sorted(platform_owner_company_ids()),
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner operational data is restricted to its own companies",
            )
        if requested is not None:
            base[COMPANY_FIELD] = _normalize_owner_company_filter(requested)
        if requested is None:
            owner_default = _owner_default_company_id()
            if owner_default and _owner_company_value_allowed(owner_default):
                base[COMPANY_FIELD] = owner_default
            elif platform_owner_company_ids():
                # Do not silently widen an owner request if its current identity
                # is stale and no explicit, allowed company was supplied.
                base[COMPANY_FIELD] = "__no_platform_owner_company_scope__"
            elif owner_default:
                base[COMPANY_FIELD] = owner_default
        return base
    if not company_id:
        return base
    if COMPANY_FIELD in base and _blank_company_filter(base.get(COMPANY_FIELD)):
        base.pop(COMPANY_FIELD, None)
    requested = base.get(COMPANY_FIELD)
    if requested is not None and str(requested) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    base[COMPANY_FIELD] = company_id
    return base


def _scope_company_registry_query(query: Any) -> dict[str, Any]:
    if in_platform_owner_context():
        base = dict(query or {}) if isinstance(query, dict) else {}
        if _is_commercial_control_context():
            return base
        allowed = platform_owner_company_ids()
        if not allowed and authenticated_company_id():
            allowed = frozenset({str(authenticated_company_id())})
        requested = base.get(COMPANY_ID_FIELD)
        if requested is not None and not _owner_company_filter_allowed(requested):
            logger.warning(
                "Platform Owner registry scope denied requested=%r owner_company_ids=%s",
                requested, sorted(allowed),
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner operational data is restricted to its own companies",
            )
        if requested is not None:
            base[COMPANY_ID_FIELD] = _normalize_owner_company_filter(requested)
        if requested is None:
            base[COMPANY_ID_FIELD] = {"$in": sorted(allowed)} if allowed else "__no_platform_owner_company_scope__"
        return base
    company_id = authenticated_company_id()
    if not company_id:
        return query if isinstance(query, dict) else {}
    base = dict(query or {})
    requested = base.get(COMPANY_ID_FIELD)
    if requested is not None:
        if isinstance(requested, dict) or str(requested) != company_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    base[COMPANY_ID_FIELD] = company_id
    return base


def _scope_company_registry_insert(document: Any) -> Any:
    if in_platform_owner_context() or not authenticated_company_id() or not isinstance(document, dict):
        return document
    result = dict(document)
    requested = result.get(COMPANY_ID_FIELD)
    company_id = authenticated_company_id()
    if requested is not None and str(requested) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company company creation is not permitted")
    result[COMPANY_ID_FIELD] = company_id
    return result


def _scope_company_registry_update(update: Any) -> Any:
    if in_platform_owner_context() or not authenticated_company_id():
        return update
    if not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if COMPANY_ID_FIELD in set_values and str(set_values[COMPANY_ID_FIELD]) != authenticated_company_id():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Company ID cannot be changed")
    set_values.pop(COMPANY_ID_FIELD, None)
    if set_values:
        result["$set"] = set_values
    elif "$set" in result:
        result.pop("$set", None)
    return result


def _scope_update(update: Any, query: Any = None) -> Any:
    company_id = authenticated_company_id()
    if not isinstance(update, dict):
        return update
    result = dict(update)
    set_values = dict(result.get("$set") or {})
    if in_platform_owner_context():
        has_company_update = COMPANY_FIELD in set_values or COMPANY_FIELD in result
        if _is_commercial_control_context() and has_company_update:
            return update
        requested_update_company = set_values.get(COMPANY_FIELD, result.get(COMPANY_FIELD))
        if requested_update_company is not None and not _owner_company_value_allowed(requested_update_company):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner operational data is restricted to its own companies",
            )
        query_company = query.get(COMPANY_FIELD) if isinstance(query, dict) else None
        if query_company is not None and not _owner_company_filter_allowed(query_company):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner operational data is restricted to its own companies",
            )
        if (
            requested_update_company is not None
            and isinstance(query_company, str)
            and str(requested_update_company).strip() != query_company
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="An operational record cannot be moved between companies by changing company_id",
            )
        # The query is already company-scoped. Do not overwrite its selected
        # owner company with the login's default company during an update.
        if not has_company_update and query_company is None and company_id:
            if _owner_company_value_allowed(company_id):
                set_values[COMPANY_FIELD] = company_id
                result["$set"] = set_values
            elif platform_owner_company_ids():
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Platform Owner has no valid operational company context",
                )
        return result
    if not company_id:
        return update
    if isinstance(update, list):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Tenant update pipelines are not permitted")
    unset_values = dict(result.get("$unset") or {})
    if COMPANY_FIELD in unset_values:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="company_id cannot be removed")
    if COMPANY_FIELD in set_values and str(set_values[COMPANY_FIELD]) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    set_values[COMPANY_FIELD] = company_id
    result["$set"] = set_values
    return result


def _scope_replacement(replacement: Any, query: Any = None) -> Any:
    company_id = authenticated_company_id()
    if not isinstance(replacement, dict):
        return replacement
    result = dict(replacement)
    if in_platform_owner_context():
        if _is_commercial_control_context():
            if result.get(COMPANY_FIELD):
                return result
        elif COMPANY_FIELD in result and _blank_company_filter(result.get(COMPANY_FIELD)):
            result.pop(COMPANY_FIELD, None)
        requested = result.get(COMPANY_FIELD)
        query_company = query.get(COMPANY_FIELD) if isinstance(query, dict) else None
        if requested is not None and not _owner_company_value_allowed(requested):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner operational data is restricted to its own companies",
            )
        if query_company is not None and not _owner_company_filter_allowed(query_company):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Platform Owner operational data is restricted to its own companies",
            )
        if (
            requested is not None
            and isinstance(query_company, str)
            and str(requested).strip() != query_company
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="An operational record cannot be moved between companies by changing company_id",
            )
        selected = requested or query_company or _owner_default_company_id()
        if selected is not None:
            if not _owner_company_filter_allowed(selected):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Platform Owner has no valid operational company context",
                )
            result[COMPANY_FIELD] = selected
        return result
    if not company_id:
        return result
    if COMPANY_FIELD in result and _blank_company_filter(result.get(COMPANY_FIELD)):
        result.pop(COMPANY_FIELD, None)
    if result.get(COMPANY_FIELD) is not None and str(result[COMPANY_FIELD]) != company_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Cross-company access is not permitted")
    result[COMPANY_FIELD] = company_id
    return result


class TenantAwareCollection:
    def __init__(self, collection: Any, name: str):
        self._collection = collection
        self._name = name

    def _enabled(self) -> bool:
        return self._name in TENANT_COLLECTIONS and authenticated_company_id() is not None and not in_system_context()

    def _company_registry_enabled(self) -> bool:
        return self._name == COMPANY_REGISTRY_COLLECTION and authenticated_company_id() is not None and not in_system_context()

    def find(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return self._collection.find(query, *args, **kwargs)

    async def find_one(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.find_one(query, *args, **kwargs)

    async def count_documents(self, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.count_documents(query, *args, **kwargs)

    async def distinct(self, key, query=None, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.distinct(key, query, *args, **kwargs)

    async def insert_one(self, document, *args, **kwargs):
        if self._enabled(): document = _scope_replacement(document)
        elif self._company_registry_enabled(): document = _scope_company_registry_insert(document)
        return await self._collection.insert_one(document, *args, **kwargs)

    async def insert_many(self, documents, *args, **kwargs):
        if self._enabled(): documents = [_scope_replacement(document) for document in documents]
        elif self._company_registry_enabled(): documents = [_scope_company_registry_insert(document) for document in documents]
        return await self._collection.insert_many(documents, *args, **kwargs)

    async def update_one(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled:
            query = _scope_query(query)
            update = _scope_update(update, query)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.update_one(query, update, *args, **kwargs)

    async def update_many(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled:
            query = _scope_query(query)
            update = _scope_update(update, query)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.update_many(query, update, *args, **kwargs)

    async def replace_one(self, query, replacement, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled:
            query = _scope_query(query)
            replacement = _scope_replacement(replacement, query)
        elif registry:
            query = _scope_company_registry_query(query)
            replacement = _scope_company_registry_insert(replacement)
        return await self._collection.replace_one(query, replacement, *args, **kwargs)

    async def find_one_and_update(self, query, update, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled:
            query = _scope_query(query)
            update = _scope_update(update, query)
        elif registry: query, update = _scope_company_registry_query(query), _scope_company_registry_update(update)
        return await self._collection.find_one_and_update(query, update, *args, **kwargs)

    async def find_one_and_replace(self, query, replacement, *args, **kwargs):
        enabled = self._enabled(); registry = self._company_registry_enabled()
        if enabled:
            query = _scope_query(query)
            replacement = _scope_replacement(replacement, query)
        elif registry:
            query = _scope_company_registry_query(query)
            replacement = _scope_company_registry_insert(replacement)
        return await self._collection.find_one_and_replace(query, replacement, *args, **kwargs)

    async def find_one_and_delete(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.find_one_and_delete(query, *args, **kwargs)

    async def delete_one(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.delete_one(query, *args, **kwargs)

    async def delete_many(self, query, *args, **kwargs):
        if self._enabled(): query = _scope_query(query)
        elif self._company_registry_enabled(): query = _scope_company_registry_query(query)
        return await self._collection.delete_many(query, *args, **kwargs)

    def aggregate(self, pipeline, *args, **kwargs):
        if self._enabled():
            pipeline = list(pipeline or [])
            if in_platform_owner_context():
                if _is_commercial_control_context():
                    return self._collection.aggregate(pipeline, *args, **kwargs)
                allowed = platform_owner_company_ids()
                if allowed:
                    pipeline.insert(0, {"$match": {COMPANY_FIELD: {"$in": sorted(allowed)}}})
                else:
                    owner_default = _owner_default_company_id()
                    if owner_default:
                        pipeline.insert(0, {"$match": {COMPANY_FIELD: owner_default}})
                return self._collection.aggregate(pipeline, *args, **kwargs)
            pipeline.insert(0, {"$match": {COMPANY_FIELD: authenticated_company_id()}})
        elif self._company_registry_enabled():
            pipeline = list(pipeline or [])
            if not in_platform_owner_context():
                pipeline.insert(0, {"$match": {COMPANY_ID_FIELD: authenticated_company_id()}})
        return self._collection.aggregate(pipeline, *args, **kwargs)

    async def bulk_write(self, requests, *args, **kwargs):
        if not self._enabled(): return await self._collection.bulk_write(requests, *args, **kwargs)
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Bulk writes are not permitted on tenant collections")

    def __getattr__(self, name):
        return getattr(self._collection, name)


class TenantAwareDatabase:
    def __init__(self, database: Any): self._database = database
    def __getitem__(self, name): return TenantAwareCollection(self._database[name], name)
    def __getattr__(self, name): return self[name]
