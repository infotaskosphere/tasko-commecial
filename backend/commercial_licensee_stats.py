"""Read-only operational statistics for the Platform Owner's license registry.

This endpoint deliberately lives in the commercial control plane. It resolves a
single commercial customer/license and then reads only tenant-scoped aggregate
facts. It never returns customer document contents, task/client details, or
individual operational records.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.dependencies import db, get_current_user
from backend.commercial_master_data import _platform_company_context
from backend.platform_owner import is_platform_owner

router = APIRouter(prefix="/commercial-licensee-stats", tags=["commercial-licensee-stats"])

# Keep this list explicit. The first existing collection wins so deployments
# using a legacy collection name continue to report without double counting.
_COLLECTION_CANDIDATES = {
    "tasks": ("tasks", "task_records", "task_items"),
    "clients": ("clients", "client_master", "client_records"),
    "invoices": ("invoices",),
    "documents": ("documents", "document_records"),
    "compliance": ("compliance_tasks", "compliance_records", "compliances"),
    "attendance": ("attendance", "attendance_records"),
    "activity": ("computer_activity",),
}


def _clean_number(value: Any) -> float:
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


async def _existing_collection(candidates: Iterable[str]) -> Optional[str]:
    try:
        names = set(await db.list_collection_names())
    except Exception:
        return None
    return next((name for name in candidates if name in names), None)


def _scope_query(values: Dict[str, str]) -> Dict[str, Any]:
    clauses = []
    for field in ("company_id", "commercial_customer_id", "license_id", "tenant_id", "companyId", "commercialCustomerId", "licenseId"):
        value = values.get(field)
        if value:
            clauses.append({field: value})
    return {"$or": clauses} if clauses else {"_id": None}


def _and_scope(scope: Dict[str, Any], *extra: Dict[str, Any]) -> Dict[str, Any]:
    return {"$and": [scope, *extra]}


def _date_value(doc: Dict[str, Any], *fields: str) -> Optional[datetime]:
    for field in fields:
        value = doc.get(field)
        if not value:
            continue
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except (TypeError, ValueError):
            continue
    return None


def _status_clause(statuses: Iterable[str]) -> Dict[str, Any]:
    values = list(statuses)
    return {"$or": [{"status": {"$in": values}}, {"task_status": {"$in": values}}, {"state": {"$in": values}}]}


async def _count(collection: Optional[str], query: Dict[str, Any]) -> int:
    if not collection:
        return 0
    try:
        return int(await getattr(db, collection).count_documents(query))
    except Exception:
        return 0


async def _find(collection: Optional[str], query: Dict[str, Any], limit: int = 5000):
    if not collection:
        return []
    try:
        return await getattr(db, collection).find(query, {"_id": 0}).to_list(limit)
    except Exception:
        return []


@router.get("/snapshot")
async def get_licensee_snapshot(
    license_id: str = Query(..., min_length=1),
    current_user=Depends(get_current_user),
):
    """Return live aggregate health/usage figures for one licensed customer."""
    if not is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="Platform Owner access is required.")

    license_doc, company = await _platform_company_context(current_user, license_id)
    customer_id = str(company.get("commercial_customer_id") or license_doc.get("customer_id") or "").strip()
    company_id = str(company.get("id") or "").strip()
    active_license_id = str(license_doc.get("id") or license_id).strip()
    scope_values = {
        "company_id": company_id,
        "commercial_customer_id": customer_id,
        "license_id": active_license_id,
    }
    scope = _scope_query(scope_values)

    users = await _find(
        "users",
        {"$and": [{"status": {"$ne": "deleted"}}, {"$or": [
            {"company_id": company_id},
            {"commercial_customer_id": customer_id},
            {"license_id": active_license_id},
        ]}]},
        5000,
    )
    now = datetime.now(timezone.utc)
    online_cutoff = now - timedelta(minutes=5)
    online_users = 0
    for user in users:
        if user.get("is_online") is True or user.get("online") is True:
            online_users += 1
            continue
        seen = _date_value(user, "last_seen_at", "last_seen", "last_activity_at", "last_active_at")
        if seen and seen >= online_cutoff:
            online_users += 1

    task_collection = await _existing_collection(_COLLECTION_CANDIDATES["tasks"])
    client_collection = await _existing_collection(_COLLECTION_CANDIDATES["clients"])
    invoice_collection = await _existing_collection(_COLLECTION_CANDIDATES["invoices"])
    document_collection = await _existing_collection(_COLLECTION_CANDIDATES["documents"])
    compliance_collection = await _existing_collection(_COLLECTION_CANDIDATES["compliance"])
    attendance_collection = await _existing_collection(_COLLECTION_CANDIDATES["attendance"])
    activity_collection = await _existing_collection(_COLLECTION_CANDIDATES["activity"])

    task_docs = await _find(task_collection, scope, 10000)
    task_total = len(task_docs)
    completed = sum(1 for d in task_docs if str(d.get("status") or d.get("task_status") or d.get("state") or "").lower() in {"completed", "complete", "done", "closed"})
    open_tasks = max(0, task_total - completed)
    overdue = 0
    for task in task_docs:
        status = str(task.get("status") or task.get("task_status") or task.get("state") or "").lower()
        due = _date_value(task, "due_date", "dueDate", "deadline")
        if due and due < now and status not in {"completed", "complete", "done", "closed", "cancelled", "canceled"}:
            overdue += 1

    invoice_docs = await _find(invoice_collection, scope, 10000)
    invoice_total = len(invoice_docs)
    outstanding_amount = 0.0
    paid_amount = 0.0
    for invoice in invoice_docs:
        amount = _clean_number(invoice.get("total_amount", invoice.get("grand_total", invoice.get("amount"))))
        status = str(invoice.get("status") or "").lower()
        if status in {"paid", "settled", "completed"}:
            paid_amount += amount
        elif status not in {"cancelled", "canceled", "void", "draft"}:
            outstanding_amount += amount

    attendance_today = 0
    if attendance_collection:
        today = now.date().isoformat()
        attendance_today = await _count(attendance_collection, _and_scope(scope, {"$or": [{"date": today}, {"attendance_date": today}, {"day": today}]}))

    activity_today = 0
    if activity_collection:
        today = now.date().isoformat()
        activity_today = await _count(activity_collection, _and_scope(scope, {"date": today}))
        if not activity_today:
            activity_today = sum(1 for d in await _find(activity_collection, scope, 5000) if str(d.get("date") or "").startswith(today))

    max_users = max(1, int(license_doc.get("max_users") or 1))
    expires_at = license_doc.get("expires_at")
    expires_dt = _date_value({"value": expires_at}, "value")
    days_remaining = None if not expires_dt else max(0, (expires_dt.date() - now.date()).days)

    return {
        "generated_at": now.isoformat(),
        "customer": {
            "id": customer_id,
            "company_name": company.get("name") or company.get("company_name"),
            "email": company.get("email"),
        },
        "license": {
            "id": active_license_id,
            "key": license_doc.get("license_key"),
            "status": license_doc.get("status"),
            "max_users": max_users,
            "days_remaining": days_remaining,
            "modules": [m for m in (license_doc.get("modules") or []) if m != "admin"],
        },
        "users": {
            "total": len(users),
            "active": sum(1 for u in users if u.get("is_active") is not False and u.get("status") not in {"inactive", "deleted"}),
            "online": online_users,
            "managers": sum(1 for u in users if u.get("role") == "manager"),
            "staff": sum(1 for u in users if u.get("role") == "staff"),
            "admins": sum(1 for u in users if u.get("role") == "admin"),
            "seat_utilization_percent": round(min(100, len(users) * 100 / max_users), 1),
        },
        "tasks": {"total": task_total, "open": open_tasks, "completed": completed, "overdue": overdue},
        "clients": {"total": await _count(client_collection, scope)},
        "invoices": {"total": invoice_total, "paid_amount": round(paid_amount, 2), "outstanding_amount": round(outstanding_amount, 2)},
        "documents": {"total": await _count(document_collection, scope)},
        "compliance": {"total": await _count(compliance_collection, scope)},
        "attendance": {"records_today": attendance_today},
        "activity": {"reports_today": activity_today},
        "data_sources": {
            "tasks": task_collection,
            "clients": client_collection,
            "invoices": invoice_collection,
            "documents": document_collection,
            "compliance": compliance_collection,
            "attendance": attendance_collection,
            "activity": activity_collection,
        },
    }


from backend.permission_governance import router as _permission_governance_router
if not any(getattr(r, "path", "") == "/commercial-licensee-stats/snapshot" for r in getattr(_permission_governance_router, "routes", [])):
    _permission_governance_router.include_router(router)
