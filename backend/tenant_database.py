"""Database-per-licensee routing for the commercial SaaS backend.

The control database remains the source of truth for identity, licensing, tenant
registry, and other pre-login records. Business collections are routed to a
deterministic database when TENANT_DB_MODE=per_tenant. Shared mode is the
default so deploying this module alone does not change live database routing.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, Optional

logger = logging.getLogger(__name__)

PREFIX = os.getenv("TENANT_DB_PREFIX", "tso_")
REGISTRY = "tenant_databases"

# These collections must remain available before a tenant is resolved during
# login, licensing, session validation, system configuration, or global control.
CONTROL_COLLECTIONS = {
    "users",
    "companies",
    REGISTRY,
    "licenses",
    "sessions",
    "session_manager",
    "password_reset_tokens",
    "email_verification_tokens",
    "identity_email_links",
    "identity_migrations",
    "identity_sequences",
    "subscriptions",
    "tenants",
    "feature_flags",
    "plugins",
    "rate_limits",
    "security_events",
    "system_logs",
    "system_metrics",
    "system_settings",
    "system_recovery_settings",
    "referrers",
    "auditors",
    "commercial_customers",
    "commercial_domains",
    "commercial_license_customers",
    "commercial_license_module_catalog",
    "commercial_license_packages",
    "commercial_licenses",
    "commercial_plans",
    "commercial_website_config",
    "audit_platform",
    "licensee_role_templates_index",
}

_client: Any = None
_control: Any = None
_forced_tenant: ContextVar[Optional[str]] = ContextVar("tso_forced_tenant", default=None)
_status_cache: Dict[str, tuple[float, str]] = {}
_STATUS_TTL = 60.0


def configure(client: Any, control_db: Any) -> None:
    """Configure once from backend.dependencies after the Mongo client exists."""
    global _client, _control
    _client, _control = client, control_db


def per_tenant_enabled() -> bool:
    return os.getenv("TENANT_DB_MODE", "shared").strip().lower() == "per_tenant"


def strict() -> bool:
    return os.getenv("TENANT_DB_STRICT", "false").strip().lower() == "true"


def tenant_db_name(company_id: str) -> str:
    """Return a deterministic Mongo database name within Atlas's name limit."""
    raw_id = str(company_id or "").strip()
    if not raw_id:
        raise ValueError("company_id is required to derive a tenant database name")
    safe = re.sub(r"[^a-z0-9]", "", raw_id.lower())[:20] or "tenant"
    digest = hashlib.sha1(raw_id.encode("utf-8")).hexdigest()[:8]
    prefix = re.sub(r"[^A-Za-z0-9_]", "", PREFIX)[:8] or "tso_"
    # Default name length is 4 + 20 + 1 + 8 = 33 chars; cap configurable
    # prefixes too, rather than letting an environment value exceed Atlas limits.
    return f"{prefix}{safe}_{digest}"[:38]


def database_for(company_id: str) -> Any:
    if _client is None:
        raise RuntimeError("tenant_database.configure() was not called")
    return _client[tenant_db_name(company_id)]


def forced_tenant() -> Optional[str]:
    return _forced_tenant.get()


@contextmanager
def use_tenant(company_id: str):
    """Pin a tenant for schedulers, provisioning, and background jobs."""
    cid = str(company_id or "").strip()
    if not cid:
        raise ValueError("company_id is required when pinning a tenant")
    token = _forced_tenant.set(cid)
    try:
        yield
    finally:
        _forced_tenant.reset(token)


async def assert_active(company_id: str) -> None:
    """Fail closed if a licensee has no active tenant DB. Registry cache is 60s."""
    from fastapi import HTTPException

    cid = str(company_id or "").strip()
    if not cid:
        raise HTTPException(status_code=403, detail="Tenant database is not active for this licensee")
    if not per_tenant_enabled():
        return

    now_mono = time.monotonic()
    hit = _status_cache.get(cid)
    if hit and now_mono - hit[0] < _STATUS_TTL:
        status = hit[1]
    else:
        if _control is None:
            raise RuntimeError("tenant_database.configure() was not called")
        row = await _control[REGISTRY].find_one(
            {"company_id": cid}, {"_id": 0, "status": 1}
        )
        status = (row or {}).get("status", "missing")
        _status_cache[cid] = (now_mono, status)

    if status != "active":
        raise HTTPException(
            status_code=403,
            detail="Tenant database is not active for this licensee",
        )


async def provision(company_id: str, license_id: str = "") -> dict:
    """Idempotently register a tenant, build indexes, and seed safe defaults.

    Registry state stays non-active until indexes and seeds complete. This keeps
    a partially provisioned database from accepting tenant API requests.
    """
    cid = str(company_id or "").strip()
    if not cid:
        raise ValueError("company_id is required to provision a tenant database")
    if _control is None or _client is None:
        raise RuntimeError("tenant_database.configure() was not called")

    name = tenant_db_name(cid)
    registry = _control[REGISTRY]
    await registry.update_one(
        {"company_id": cid},
        {
            "$setOnInsert": {
                "company_id": cid,
                "db_name": name,
                "license_id": str(license_id or ""),
                "created_at": datetime.now(timezone.utc).isoformat(),
            },
            "$set": {
                "db_name": name,
                "license_id": str(license_id or ""),
                "status": "provisioning",
                "updated_at": datetime.now(timezone.utc).isoformat(),
            },
        },
        upsert=True,
    )
    _status_cache.pop(cid, None)

    database = database_for(cid)
    try:
        # Phase 4 refactors this entry point to accept a database directly. Keep
        # the import local so this module never creates a dependencies cycle.
        from backend.server_modules.startup_indexes import ensure_indexes

        await ensure_indexes(database)
        await seed_defaults(database, cid)
        await registry.update_one(
            {"company_id": cid},
            {
                "$set": {
                    "status": "active",
                    "activated_at": datetime.now(timezone.utc).isoformat(),
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
    except Exception as exc:
        await registry.update_one(
            {"company_id": cid},
            {
                "$set": {
                    "status": "provisioning_failed",
                    "last_error": str(exc)[:1000],
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
        _status_cache.pop(cid, None)
        raise

    _status_cache.pop(cid, None)
    logger.info("Provisioned tenant database %s for company %s", name, cid)
    return {"db_name": name}


async def seed_defaults(database: Any, company_id: str) -> None:
    """Seed tenant-safe defaults using the existing application's source data.

    The chart-of-accounts helper defines the authoritative accounting defaults.
    Workflow templates come from WorkflowTemplates.DEFAULT_TEMPLATES. Existing
    company-agnostic department/holiday rows in the shared database are copied
    into the tenant with an explicit company_id; no other licensee's rows are
    copied.
    """
    cid = str(company_id)
    with use_tenant(cid):
        from backend.accounting_core import ensure_default_chart_of_accounts

        await ensure_default_chart_of_accounts(cid, "system")

    # Workflow templates are business data; each seeded document must be tenant
    # attributed, even though the old shared startup bootstrap omitted the field.
    from backend.workflow.workflow_templates import WorkflowTemplates

    templates = getattr(WorkflowTemplates, "DEFAULT_TEMPLATES", [])
    target_templates = database["workflow_templates"]
    for template in templates:
        doc = {**template, "company_id": cid}
        await target_templates.update_one(
            {"id": str(doc["id"])},
            {"$setOnInsert": doc},
            upsert=True,
        )

    # Only migrate truly global seed rows. Records already assigned to a company
    # are deliberately not copied across tenants.
    global_filter = {
        "$or": [
            {"company_id": {"$exists": False}},
            {"company_id": None},
            {"company_id": ""},
        ]
    }
    for collection_name in ("departments", "holidays"):
        source = _control[collection_name]
        target = database[collection_name]
        cursor = source.find(global_filter, {"_id": 0})
        async for source_doc in cursor:
            doc = dict(source_doc)
            doc["company_id"] = cid
            if collection_name == "holidays" and doc.get("date") not in (None, ""):
                lookup = {"date": doc["date"]}
            elif doc.get("id") not in (None, ""):
                lookup = {"id": str(doc["id"])}
            elif doc.get("name") not in (None, ""):
                lookup = {"name": str(doc["name"])}
            else:
                logger.warning(
                    "Skipping global %s seed without date/id/name for company %s",
                    collection_name,
                    cid,
                )
                continue
            await target.update_one(lookup, {"$setOnInsert": doc}, upsert=True)


async def archive(company_id: str) -> None:
    cid = str(company_id or "").strip()
    if not cid:
        raise ValueError("company_id is required to archive a tenant database")
    if _control is None:
        raise RuntimeError("tenant_database.configure() was not called")
    await _control[REGISTRY].update_one(
        {"company_id": cid},
        {
            "$set": {
                "status": "archived",
                "archived_at": datetime.now(timezone.utc).isoformat(),
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
    )
    _status_cache.pop(cid, None)


async def for_each_tenant(fn: Callable[[str], Awaitable[None]]) -> None:
    """Run a scheduler task once per active tenant with the tenant pinned."""
    if _control is None:
        raise RuntimeError("tenant_database.configure() was not called")
    async for row in _control[REGISTRY].find(
        {"status": "active"}, {"_id": 0, "company_id": 1}
    ):
        cid = str(row.get("company_id") or "").strip()
        if not cid:
            continue
        try:
            with use_tenant(cid):
                await fn(cid)
        except Exception:
            logger.exception("Tenant background task failed for company %s", cid)
