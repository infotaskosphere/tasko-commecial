"""Provision and validate per-licensee MongoDB databases.

The commercial license/customer registry remains in the control-plane database.
Tenant business collections are routed to a database derived from the immutable
commercial customer ID. Never accept a database name from a request or token.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException

TENANT_DB_PREFIX = "taskosphere_tenant_"
TENANT_DB_STATUS_READY = "ready"
TENANT_DB_STATUS_MIGRATION_REQUIRED = "migration_required"

CORE_TENANT_INDEX_COLLECTIONS = (
    "tasks", "todos", "clients", "invoices", "payments", "quotations", "leads",
    "attendance", "notifications", "visits", "due_dates", "reminders", "documents",
    "bank_accounts", "bank_transactions", "journal_entries", "journal_lines",
    "chart_of_accounts", "products", "audit_logs", "staff_activity", "compliances",
    "roc_companies",
)


def tenant_database_name(customer_id: Any) -> str:
    """Return a stable, non-PII database name for a customer ID."""
    value = str(customer_id or "").strip()
    if not value:
        raise ValueError("customer_id is required to derive a tenant database")
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]
    return f"{TENANT_DB_PREFIX}{digest}"


def validate_tenant_database_name(customer_id: Any, database_name: Any) -> bool:
    """Only accept the deterministic database name for the authenticated tenant."""
    try:
        expected = tenant_database_name(customer_id)
    except (TypeError, ValueError):
        return False
    value = str(database_name or "").strip()
    return bool(value and re.fullmatch(r"taskosphere_tenant_[a-f0-9]{32}", value) and value == expected)


async def provision_tenant_database(mongo_client: Any, customer_id: Any) -> dict[str, str]:
    """Create a database marker idempotently; do not copy legacy data implicitly."""
    if mongo_client is None or not hasattr(mongo_client, "__getitem__"):
        raise RuntimeError("MongoDB client is unavailable; cannot provision tenant database")
    customer = str(customer_id or "").strip()
    if not customer:
        raise ValueError("customer_id is required")
    name = tenant_database_name(customer)
    database = mongo_client[name]
    marker = database["__tenant_metadata__"]
    await marker.update_one(
        {"customer_id": customer},
        {
            "$set": {
                "customer_id": customer,
                "database_name": name,
                "status": TENANT_DB_STATUS_READY,
                "schema_version": 1,
            },
            "$setOnInsert": {"provisioned_at": datetime.now(timezone.utc).isoformat()},
        },
        upsert=True,
    )
    for collection_name in CORE_TENANT_INDEX_COLLECTIONS:
        collection = database[collection_name]
        create_index = getattr(collection, "create_index", None)
        if create_index:
            await create_index("company_id", background=True)
    return {"customer_id": customer, "database_name": name, "status": TENANT_DB_STATUS_READY}


def tenant_database_for_customer(customer_id: Any, customer_record: dict[str, Any] | None) -> str | None:
    """Return a tenant DB only when the central registry marks it ready."""
    if not isinstance(customer_record, dict):
        return None
    name = customer_record.get("tenant_database_name")
    status = str(customer_record.get("tenant_database_status") or "").lower()
    if status != TENANT_DB_STATUS_READY:
        return None
    if not validate_tenant_database_name(customer_id, name):
        raise HTTPException(status_code=503, detail="Tenant database mapping is invalid; access has been blocked")
    return str(name)
