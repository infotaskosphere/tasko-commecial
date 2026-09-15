"""Read-only operational statistics for the Platform Owner's license registry.

The operational collections in Taskosphere are not all tenant-tagged in the
same way. Users carry the commercial customer/company relationship, while
legacy tasks, clients, documents, attendance and activity records are primarily
linked through user ids. This module therefore resolves the licensee's canonical
user scope first and uses the correct relationship for each collection.

No customer record contents are returned; only aggregate counts/amounts are
exposed to the Platform Owner.
"""

from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.dependencies import db, get_current_user
from backend.commercial_master_data import _platform_company_context
from backend.platform_owner import is_platform_owner

router = APIRouter(prefix="/commercial-licensee-stats", tags=["commercial-licensee-stats"])


def _clean_number(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


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


async def _collection_exists(name: str) -> bool:
    try:
        return name in set(await db.list_collection_names())
    except Exception:
        # The core collections are known to exist in production. Returning
        # False here lets the response mark only that metric as unavailable.
        return False


async def _count(name: str, query: Dict[str, Any]) -> Optional[int]:
    if not await _collection_exists(name):
        return None
    try:
        return int(await getattr(db, name).count_documents(query))
    except Exception:
        return None


async def _find(name: str, query: Dict[str, Any], projection: Optional[Dict[str, int]] = None, limit: int = 10000) -> Optional[List[Dict[str, Any]]]:
    if not await _collection_exists(name):
        return None
    try:
        return await getattr(db, name).find(query, projection or {"_id": 0}).to_list(limit)
    except Exception:
        return None


def _relation_scope(user_ids: List[str], *fields: str) -> Dict[str, Any]:
    if not user_ids:
        return {"_id": None}
    return {"$or": [{field: {"$in": user_ids}} for field in fields]}


def _in_scope(field: str, values: List[str]) -> Dict[str, Any]:
    return {field: {"$in": values}} if values else {"_id": None}


def _combine(*queries: Dict[str, Any]) -> Dict[str, Any]:
    valid = [q for q in queries if q]
    if not valid:
        return {"_id": None}
    return {"$and": valid} if len(valid) > 1 else valid[0]


def _id_strings(docs: Iterable[Dict[str, Any]]) -> List[str]:
    values = set()
    for doc in docs:
        for key in ("id", "_id"):
            value = doc.get(key)
            if value is not None:
                values.add(str(value))
    return list(values)


@router.get("/snapshot")
async def get_licensee_snapshot(
    license_id: str = Query(..., min_length=1),
    current_user=Depends(get_current_user),
):
    """Return live aggregate health/usage figures for one licensed customer."""
    if not is_platform_owner(current_user):
        raise HTTPException(status_code=403, detail="Platform Owner access is required.")

    license_doc, company = await _platform_company_context(current_user, license_id)
    customer_id = str(
        license_doc.get("customer_id")
        or company.get("commercial_customer_id")
        or ""
    ).strip()
    company_id = str(company.get("id") or "").strip()
    active_license_id = str(license_doc.get("id") or license_id).strip()

    # A customer can have more than one company record. Include all of them
    # so the Platform Owner never gets an artificially low count.
    company_ids: List[str] = []
    if customer_id:
        try:
            company_ids = [str(x) for x in await db.companies.distinct("id", {"commercial_customer_id": customer_id}) if x]
        except Exception:
            company_ids = []
    if company_id and company_id not in company_ids:
        company_ids.append(company_id)

    user_scope_parts = []
    if customer_id:
        user_scope_parts.append({"commercial_customer_id": customer_id})
    if company_ids:
        user_scope_parts.append({"company_id": {"$in": company_ids}})
    if active_license_id:
        user_scope_parts.append({"license_id": active_license_id})
    user_scope = {"$or": user_scope_parts} if user_scope_parts else {"_id": None}
    users = await _find("users", _combine(user_scope, {"status": {"$ne": "deleted"}}), limit=10000)
    if users is None:
        raise HTTPException(status_code=503, detail="Unable to read the licensee user directory.")

    user_ids = _id_strings(users)
    now = datetime.now(timezone.utc)
    online_cutoff = now - timedelta(minutes=5)

    # Presence is derived from explicit online fields first. If those fields
    # are not populated by a deployment, the real activity stream is used as a
    # fallback, so an active user is not incorrectly shown as offline.
    latest_activity = {}
    activity_docs = await _find(
        "staff_activity",
        _in_scope("user_id", user_ids),
        {"_id": 0, "user_id": 1, "timestamp": 1},
        20000,
    )
    if activity_docs is not None:
        for row in activity_docs:
            uid = str(row.get("user_id") or "")
            timestamp = _date_value(row, "timestamp")
            if uid and timestamp and (uid not in latest_activity or timestamp > latest_activity[uid]):
                latest_activity[uid] = timestamp

    online_users = 0
    for user in users:
        if user.get("is_online") is True or user.get("online") is True:
            online_users += 1
            continue
        seen = _date_value(user, "last_seen_at", "last_seen", "last_activity_at", "last_active_at", "last_login_at", "last_login")
        if seen and seen >= online_cutoff:
            online_users += 1
            continue
        uid = str(user.get("id") or user.get("_id") or "")
        if uid and latest_activity.get(uid) and latest_activity[uid] >= online_cutoff:
            online_users += 1

    # Operational data is linked through the licensee's users for the legacy
    # collections used by the application. This is the important correction
    # over the previous implementation, which expected company_id/license_id
    # on collections that do not actually persist those fields.
    task_query = _relation_scope(user_ids, "assigned_to", "created_by", "sub_assignees")
    client_query = _relation_scope(user_ids, "assigned_to", "created_by", "assignments.user_id")
    document_query = _relation_scope(user_ids, "assigned_to", "created_by")
    compliance_query = _relation_scope(user_ids, "created_by")
    attendance_query = _in_scope("user_id", user_ids)
    activity_query = _in_scope("user_id", user_ids)

    task_total = await _count("tasks", task_query)
    completed_tasks = await _count("tasks", _combine(task_query, {"status": {"$in": ["completed", "complete", "done", "closed"]}}))
    cancelled_tasks = await _count("tasks", _combine(task_query, {"status": {"$in": ["cancelled", "canceled"]}}))
    overdue_tasks = await _count("tasks", _combine(
        task_query,
        {"due_date": {"$lt": now}},
        {"status": {"$nin": ["completed", "complete", "done", "closed", "cancelled", "canceled"]}},
    ))
    open_tasks = None if task_total is None or completed_tasks is None or cancelled_tasks is None else max(0, task_total - completed_tasks - cancelled_tasks)

    client_total = await _count("clients", client_query)
    client_docs = await _find("clients", client_query, {"_id": 0, "id": 1}, 20000)
    client_ids = _id_strings(client_docs or [])

    invoice_query_parts = []
    if company_ids:
        invoice_query_parts.append(_in_scope("company_id", company_ids))
    if user_ids:
        invoice_query_parts.append(_relation_scope(user_ids, "created_by", "created_by_user_id", "user_id"))
    if client_ids:
        invoice_query_parts.append(_in_scope("client_id", client_ids))
    invoice_query = {"$or": invoice_query_parts} if invoice_query_parts else {"_id": None}
    invoice_docs = await _find("invoices", invoice_query, {"_id": 0}, 20000)
    invoice_total = None if invoice_docs is None else len(invoice_docs)
    paid_amount = None
    outstanding_amount = None
    if invoice_docs is not None:
        paid_amount = 0.0
        outstanding_amount = 0.0
        for invoice in invoice_docs:
            amount = _clean_number(
                invoice.get("total_amount", invoice.get("grand_total", invoice.get("total_payable", invoice.get("total", invoice.get("amount")))))
            )
            status = str(invoice.get("status") or invoice.get("payment_status") or "").lower()
            if status in {"paid", "settled", "completed"}:
                paid_amount += amount
            elif status not in {"cancelled", "canceled", "void", "draft", "credit_note"}:
                outstanding_amount += amount

    document_total = await _count("documents", document_query)
    compliance_total = await _count("due_dates", compliance_query)
    attendance_today = await _count(
        "attendance",
        _combine(attendance_query, {"date": now.date().isoformat()}),
    )
    activity_today = await _count(
        "staff_activity",
        _combine(activity_query, {"timestamp": {"$gte": now.replace(hour=0, minute=0, second=0, microsecond=0)}}),
    )

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
            "modules": [m for m in (license_doc.get("modules") or []) if str(m).lower() != "admin"],
        },
        "users": {
            "total": len(users),
            "active": sum(1 for u in users if u.get("is_active") is not False and u.get("status") not in {"inactive", "deleted"}),
            "online": online_users,
            "managers": sum(1 for u in users if str(u.get("role") or "").lower() == "manager"),
            "staff": sum(1 for u in users if str(u.get("role") or "").lower() == "staff"),
            "admins": sum(1 for u in users if str(u.get("role") or "").lower() == "admin"),
            "seat_utilization_percent": round(min(100, len(users) * 100 / max_users), 1),
        },
        "tasks": {
            "total": task_total,
            "open": open_tasks,
            "completed": completed_tasks,
            "overdue": overdue_tasks,
        },
        "clients": {"total": client_total},
        "invoices": {
            "total": invoice_total,
            "paid_amount": None if paid_amount is None else round(paid_amount, 2),
            "outstanding_amount": None if outstanding_amount is None else round(outstanding_amount, 2),
        },
        "documents": {"total": document_total},
        "compliance": {"total": compliance_total},
        "attendance": {"records_today": attendance_today},
        "activity": {"reports_today": activity_today},
        "data_sources": {
            "users": "users.commercial_customer_id/company_id/license_id",
            "tasks": "tasks.assigned_to/created_by/sub_assignees",
            "clients": "clients.assigned_to/created_by/assignments.user_id",
            "invoices": "invoices.company_id/client_id/user linkage",
            "documents": "documents.assigned_to/created_by",
            "compliance": "due_dates.created_by",
            "attendance": "attendance.user_id + date",
            "activity": "staff_activity.user_id + timestamp",
        },
        "availability": {
            "tasks": task_total is not None,
            "clients": client_total is not None,
            "invoices": invoice_total is not None,
            "documents": document_total is not None,
            "compliance": compliance_total is not None,
            "attendance": attendance_today is not None,
            "activity": activity_today is not None,
        },
    }


from backend.permission_governance import router as _permission_governance_router
if not any(getattr(r, "path", "") == "/commercial-licensee-stats/snapshot" for r in getattr(_permission_governance_router, "routes", [])):
    _permission_governance_router.include_router(router)
