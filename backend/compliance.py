import io
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, List, Any, Dict
from zoneinfo import ZoneInfo

import pandas as pd
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Query
from pydantic import BaseModel, Field, ConfigDict

from backend.dependencies import db, get_current_user, check_module_permission
from backend.models import User
from backend.invoicing import (
    _compute_invoice_totals,
    _company_has_gst,
    _next_invoice_no,
    sync_invoice_journal_entry,
    recalculate_invoice_accounting,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/compliance", tags=["compliance"])

IST = ZoneInfo("Asia/Kolkata")

# ─────────────────────────────────────────────────────────────────────────────
# DEPARTMENT → CATEGORY SCOPE MAP
# Maps each user department to the compliance categories they can see/manage.
# Admin always bypasses this and sees all categories.
# ─────────────────────────────────────────────────────────────────────────────
DEPT_CATEGORY_MAP: dict = {
    "gst":          ["GST"],
    "it":           ["ITR"],
    "income_tax":   ["ITR"],
    "tds":          ["TDS"],
    "roc":          ["ROC"],
    "acc":          ["AUDIT", "PF_ESIC", "PT"],
    "accounts":     ["AUDIT", "PF_ESIC", "PT"],
    "msme":         ["OTHER"],
    "msme_smadhan": ["OTHER"],
    "fema":         ["OTHER"],
    "tm":           ["OTHER"],
    "trademark":    ["OTHER"],
    "dsc":          ["OTHER"],
    "other":        ["OTHER"],
}

def get_allowed_categories(user: User) -> Optional[List[str]]:
    """
    Returns the list of compliance categories the user may access,
    or None meaning 'all' (admin).
    """
    if user.role == "admin":
        return None  # no restriction
    depts = [d.lower() for d in (user.departments or [])]
    if not depts:
        return []  # no departments → no access
    cats: set = set()
    for dept in depts:
        cats.update(DEPT_CATEGORY_MAP.get(dept, []))
    return list(cats) if cats else []

IST = ZoneInfo("Asia/Kolkata")

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────
CATEGORIES  = ["ROC", "GST", "ITR", "TDS", "AUDIT", "PF_ESIC", "PT", "OTHER"]
STATUSES    = ["not_started", "in_progress", "completed", "filed", "na"]
FREQUENCIES = ["monthly", "quarterly", "half_yearly", "annual", "one_time"]

CATEGORY_LABELS = {
    "ROC":     "ROC / MCA",
    "GST":     "GST",
    "ITR":     "Income Tax",
    "TDS":     "TDS / TCS",
    "AUDIT":   "Audit",
    "PF_ESIC": "PF / ESIC",
    "PT":      "Prof. Tax",
    "OTHER":   "Other",
}

COMMON_COMPLIANCE = [
    # ROC
    {"name": "AOC-4 Filing",         "category": "ROC", "frequency": "annual"},
    {"name": "MGT-7 / MGT-7A Filing","category": "ROC", "frequency": "annual"},
    {"name": "DIR-3 KYC",            "category": "ROC", "frequency": "annual"},
    {"name": "INC-20A",              "category": "ROC", "frequency": "one_time"},
    # GST
    {"name": "GSTR-1 Monthly",       "category": "GST", "frequency": "monthly"},
    {"name": "GSTR-3B Monthly",      "category": "GST", "frequency": "monthly"},
    {"name": "GSTR-1 Quarterly",     "category": "GST", "frequency": "quarterly"},
    {"name": "GSTR-9 Annual",        "category": "GST", "frequency": "annual"},
    {"name": "GSTR-9C Annual",       "category": "GST", "frequency": "annual"},
    # ITR
    {"name": "ITR Filing",           "category": "ITR", "frequency": "annual"},
    {"name": "Tax Audit (3CD)",      "category": "ITR", "frequency": "annual"},
    {"name": "Advance Tax",          "category": "ITR", "frequency": "quarterly"},
    # TDS
    {"name": "TDS Return 24Q",       "category": "TDS", "frequency": "quarterly"},
    {"name": "TDS Return 26Q",       "category": "TDS", "frequency": "quarterly"},
    {"name": "TDS Certificate 16A",  "category": "TDS", "frequency": "quarterly"},
    # PF/ESIC
    {"name": "PF Monthly Return",    "category": "PF_ESIC", "frequency": "monthly"},
    {"name": "ESIC Monthly Return",  "category": "PF_ESIC", "frequency": "monthly"},
    {"name": "PF Annual Return",     "category": "PF_ESIC", "frequency": "annual"},
]


# ─────────────────────────────────────────────────────────────────────────────
# PYDANTIC MODELS
# ─────────────────────────────────────────────────────────────────────────────

class ComplianceMasterCreate(BaseModel):
    name:          str
    category:      str                        = "OTHER"
    frequency:     str                        = "annual"
    fy_year:       Optional[str]              = None    # "2025-26"
    period_label:  Optional[str]              = None    # "April 2025", "Q1 FY25-26"
    due_date:      Optional[str]              = None    # "YYYY-MM-DD"
    description:   Optional[str]             = None
    applicable_entity_types: List[str]        = Field(default_factory=list)
    govt_fees:     bool                       = False   # NEW: marks compliance as having a Government Fee


class ComplianceMasterUpdate(BaseModel):
    name:          Optional[str]             = None
    category:      Optional[str]             = None
    frequency:     Optional[str]             = None
    fy_year:       Optional[str]             = None
    period_label:  Optional[str]             = None
    due_date:      Optional[str]             = None
    description:   Optional[str]            = None
    applicable_entity_types: Optional[List[str]] = None
    govt_fees:     Optional[bool]           = None   # NEW
    is_closed:     Optional[bool]           = None   # Mark compliance as closed (hides from dashboard)


class AssignmentCreate(BaseModel):
    client_id:   str
    status:      str           = "not_started"
    assigned_to: Optional[str] = None
    notes:       Optional[str] = None


class BulkAssignRequest(BaseModel):
    client_ids:     List[str]
    default_status: str           = "not_started"
    assigned_to:    Optional[str] = None


class AssignmentUpdate(BaseModel):
    status:        str
    notes:         Optional[str] = None
    assigned_to:   Optional[str] = None
    applicability: Optional[bool] = None   # True = applicable, False = not applicable


class BulkStatusUpdate(BaseModel):
    assignment_ids: List[str]
    status:         str
    notes:          Optional[str] = None
    assigned_to:    Optional[str] = None

class CommentCreate(BaseModel):
    text:          str
    client_id:     Optional[str] = None   # None = comment on whole compliance
    assignment_id: Optional[str] = None


class MonthlyStatusUpdate(BaseModel):
    month:       str   # "YYYY-MM"
    status:      str
    notes:       Optional[str] = None
    assigned_to: Optional[str] = None




# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _enrich(item: dict) -> dict:
    """Attach live assignment stats to a compliance master doc."""
    cid = item["id"]
    pipeline = [
        {"$match": {"compliance_id": cid}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]
    rows = await db.compliance_assignments.aggregate(pipeline).to_list(10)
    counts: Dict[str, int] = {r["_id"]: r["n"] for r in rows}
    total  = sum(counts.values())
    done   = counts.get("completed", 0) + counts.get("filed", 0)
    item["_stats"] = {
        "total":       total,
        "not_started": counts.get("not_started", 0),
        "in_progress": counts.get("in_progress", 0),
        "completed":   counts.get("completed", 0),
        "filed":       counts.get("filed", 0),
        "na":          counts.get("na", 0),
        "done":        done,
        "pct":         round(done / total * 100, 1) if total else 0.0,
    }
    return item


async def _resolve_client_name(client_id: str) -> str:
    doc = await db.clients.find_one({"id": client_id}, {"_id": 0, "company_name": 1})
    return (doc or {}).get("company_name", "Unknown")


# ─────────────────────────────────────────────────────────────────────────────
# COMPLIANCE MASTERS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/common-templates")
async def get_common_templates(current_user: User = Depends(check_module_permission("compliance", "view"))):
    """Return pre-built compliance template list for quick creation."""
    return COMMON_COMPLIANCE


@router.get("/")
async def list_compliance_masters(
    category: Optional[str] = Query(None),
    fy_year:  Optional[str] = Query(None),
    current_user: User      = Depends(check_module_permission("compliance", "view")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_view_compliance", False):
        raise HTTPException(403, "You do not have permission to access the Compliance Tracker")

    # ── Build query ─────────────────────────────────────────────────────────
    query: dict = {}

    # Department scope — restrict to user's allowed categories unless admin
    allowed_cats = get_allowed_categories(current_user)
    if allowed_cats is not None:          # None = admin (no restriction)
        if not allowed_cats:
            return []                     # no departments → empty result
        if category and category != "all":
            # Honour the category filter only if it's within allowed scope
            if category not in allowed_cats:
                return []
            query["category"] = category
        else:
            query["category"] = {"$in": allowed_cats}
    else:
        if category and category != "all":
            query["category"] = category

    if fy_year and fy_year != "all":
        query["fy_year"] = fy_year

    items = await db.compliance_masters.find(query, {"_id": 0}).sort("created_at", -1).to_list(1000)
    if not items:
        return []

    # PERF: batch enrichment in a single aggregation instead of N round-trips
    cids = [it["id"] for it in items]
    pipeline = [
        {"$match": {"compliance_id": {"$in": cids}}},
        {"$group": {
            "_id": {"cid": "$compliance_id", "status": "$status"},
            "n": {"$sum": 1},
        }},
    ]
    stats_map: Dict[str, Dict[str, int]] = {cid: {} for cid in cids}
    async for row in db.compliance_assignments.aggregate(pipeline):
        cid = row["_id"]["cid"]
        st  = row["_id"]["status"]
        stats_map.setdefault(cid, {})[st] = row["n"]

    for it in items:
        counts = stats_map.get(it["id"], {})
        total  = sum(counts.values())
        done   = counts.get("completed", 0) + counts.get("filed", 0)
        it["_stats"] = {
            "total":       total,
            "not_started": counts.get("not_started", 0),
            "in_progress": counts.get("in_progress", 0),
            "completed":   counts.get("completed", 0),
            "filed":       counts.get("filed", 0),
            "na":          counts.get("na", 0),
            "done":        done,
            "pct":         round(done / total * 100, 1) if total else 0.0,
        }
    return items


@router.post("/")
async def create_compliance_master(
    data: ComplianceMasterCreate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_manage_compliance", False):
        raise HTTPException(403, "You do not have permission to create compliance items")

    if data.category not in CATEGORIES:
        raise HTTPException(400, f"Invalid category. Choose from: {CATEGORIES}")
    if data.frequency not in FREQUENCIES:
        raise HTTPException(400, f"Invalid frequency. Choose from: {FREQUENCIES}")

    # Non-admins can only create in their department's categories
    allowed_cats = get_allowed_categories(current_user)
    if allowed_cats is not None and data.category not in allowed_cats:
        raise HTTPException(403, f"Your department is not authorised to manage '{data.category}' compliance items")

    doc = {
        "id":                      str(uuid.uuid4()),
        "name":                    data.name.strip(),
        "category":                data.category,
        "frequency":               data.frequency,
        "fy_year":                 data.fy_year,
        "period_label":            data.period_label,
        "due_date":                data.due_date,
        "description":             data.description,
        "applicable_entity_types": data.applicable_entity_types,
        "govt_fees":               bool(data.govt_fees),
        "created_by":              current_user.id,
        "created_by_name":         getattr(current_user, "full_name", ""),
        "created_at":              _now(),
        "updated_at":              _now(),
    }
    await db.compliance_masters.insert_one({**doc, "_id": doc["id"]})
    return await _enrich(doc)



# ─────────────────────────────────────────────────────────────────────────────
# DASHBOARD SUMMARY
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/dashboard/summary")
async def compliance_dashboard(current_user: User = Depends(check_module_permission("compliance", "view"))):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_view_compliance", False):
        raise HTTPException(403, "You do not have permission to view the Compliance Dashboard")

    # ── Dept scope for non-admins ────────────────────────────────────────────
    allowed_cats = get_allowed_categories(current_user)
    scope_filter: dict = {}
    if allowed_cats is not None:
        if not allowed_cats:
            return {
                "total_compliance_types": 0, "total_assignments": 0,
                "completed_or_filed": 0, "pending": 0, "overall_pct": 0.0,
                "overdue": 0, "due_this_month": 0, "by_category": {},
            }
        scope_filter = {"category": {"$in": allowed_cats}}

    total_types = await db.compliance_masters.count_documents(scope_filter)

    # For assignments, first gather scoped compliance IDs
    if allowed_cats is not None:
        scoped_ids = [
            m["id"] async for m in db.compliance_masters.find(scope_filter, {"_id": 0, "id": 1})
        ]
        asgn_filter = {"compliance_id": {"$in": scoped_ids}} if scoped_ids else {"compliance_id": "NONE"}
    else:
        asgn_filter = {}

    total_asgn = await db.compliance_assignments.count_documents(asgn_filter)
    done       = await db.compliance_assignments.count_documents({**asgn_filter, "status": {"$in": ["completed", "filed"]}})
    pending    = await db.compliance_assignments.count_documents({**asgn_filter, "status": {"$in": ["not_started", "in_progress"]}})

    cat_pipeline = [{"$match": scope_filter}, {"$group": {"_id": "$category", "count": {"$sum": 1}}}]
    by_cat = await db.compliance_masters.aggregate(cat_pipeline).to_list(20)

    # Exclude closed compliance items from overdue / due-this-month dashboard counters
    not_closed_filter = {"is_closed": {"$ne": True}}
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    overdue = await db.compliance_masters.count_documents({
        **scope_filter, **not_closed_filter, "due_date": {"$lt": now_str, "$ne": None},
    })

    import calendar as cal
    now = datetime.now(IST)
    month_end   = f"{now.year}-{now.month:02d}-{cal.monthrange(now.year, now.month)[1]:02d}"
    month_start = f"{now.year}-{now.month:02d}-01"
    due_this_month = await db.compliance_masters.count_documents({
        **scope_filter, **not_closed_filter, "due_date": {"$gte": month_start, "$lte": month_end},
    })

    return {
        "total_compliance_types": total_types,
        "total_assignments":      total_asgn,
        "completed_or_filed":     done,
        "pending":                pending,
        "overall_pct":            round(done / total_asgn * 100, 1) if total_asgn else 0.0,
        "overdue":                overdue,
        "due_this_month":         due_this_month,
        "by_category":            {r["_id"]: r["count"] for r in by_cat},
        "allowed_categories":     allowed_cats,   # frontend uses this to hide tabs
    }


# ─────────────────────────────────────────────────────────────────────────────
# CALENDAR → TRACKER SYNC
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/sync-from-calendar")
async def sync_from_calendar(
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """
    Sync due_dates collection → compliance_masters.
    Creates a compliance master for any due_date that doesn't already have one.
    Called automatically after creating/updating a due date.
    """
    due_dates = await db.due_dates.find({}, {"_id": 0}).to_list(5000)
    created = 0
    updated = 0

    CATEGORY_MAP = {
        "GST": "GST", "ROC": "ROC", "MCA": "ROC", "ITR": "ITR",
        "TDS": "TDS", "AUDIT": "AUDIT", "PF": "PF_ESIC", "ESIC": "PF_ESIC",
        "PT": "PT", "INCOME TAX": "ITR",
    }

    for dd in due_dates:
        title     = dd.get("title", "").strip()
        due_date  = dd.get("due_date")
        if isinstance(due_date, datetime):
            due_date = due_date.strftime("%Y-%m-%d")
        elif isinstance(due_date, str) and "T" in due_date:
            due_date = due_date[:10]

        category = dd.get("category", "OTHER").upper()
        category = CATEGORY_MAP.get(category, "OTHER")

        # Check if a compliance master already linked to this due_date entry
        existing = await db.compliance_masters.find_one(
            {"calendar_due_date_id": dd["id"]}, {"_id": 0}
        )

        if existing:
            # Update due_date if changed
            if existing.get("due_date") != due_date:
                await db.compliance_masters.update_one(
                    {"id": existing["id"]},
                    {"$set": {"due_date": due_date, "updated_at": _now()}}
                )
                updated += 1
        else:
            # Create new compliance master
            doc = {
                "id":                      str(uuid.uuid4()),
                "name":                    title,
                "category":                category if category in CATEGORIES else "OTHER",
                "frequency":               "one_time",
                "fy_year":                 None,
                "period_label":            None,
                "due_date":                due_date,
                "description":             dd.get("description", ""),
                "applicable_entity_types": [],
                "calendar_due_date_id":    dd["id"],
                "created_by":              current_user.id,
                "created_by_name":         getattr(current_user, "full_name", ""),
                "created_at":              _now(),
                "updated_at":              _now(),
            }
            await db.compliance_masters.insert_one({**doc, "_id": doc["id"]})
            created += 1

    return {"synced": True, "created": created, "updated": updated}


@router.patch("/{compliance_id}")
async def update_compliance_master(
    compliance_id: str,
    data: ComplianceMasterUpdate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_manage_compliance", False):
        raise HTTPException(403, "You do not have permission to edit compliance items")

    existing = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0, "category": 1})
    if not existing:
        raise HTTPException(404, "Compliance not found")

    # Non-admins can only edit items in their department's categories
    allowed_cats = get_allowed_categories(current_user)
    if allowed_cats is not None and existing.get("category") not in allowed_cats:
        raise HTTPException(403, "You are not authorised to edit this compliance item")

    upd = {k: v for k, v in data.model_dump().items() if v is not None}
    if not upd:
        raise HTTPException(400, "Nothing to update")
    upd["updated_at"] = _now()
    await db.compliance_masters.update_one({"id": compliance_id}, {"$set": upd})
    doc = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0})
    return await _enrich(doc)


@router.delete("/{compliance_id}")
async def delete_compliance_master(
    compliance_id: str,
    current_user: User = Depends(check_module_permission("compliance", "delete")),
):
    # ── Permission gate — admin only ────────────────────────────────────────
    if current_user.role != "admin":
        raise HTTPException(403, "Only admins can delete compliance items")

    await db.compliance_masters.delete_one({"id": compliance_id})
    deleted_asgn = await db.compliance_assignments.delete_many({"compliance_id": compliance_id})
    return {"deleted": True, "assignments_removed": deleted_asgn.deleted_count}




@router.patch("/{compliance_id}/close")
async def close_compliance_master(
    compliance_id: str,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """
    Toggle a compliance as closed/re-opened.
    Closed items are hidden from the dashboard overdue/upcoming counters
    but remain fully visible in the Compliance Tracker page.
    """
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_manage_compliance", False):
        raise HTTPException(403, "You do not have permission to close compliance items")

    existing = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Compliance not found")

    new_closed = not existing.get("is_closed", False)
    await db.compliance_masters.update_one(
        {"id": compliance_id},
        {"$set": {"is_closed": new_closed, "closed_at": _now() if new_closed else None, "updated_at": _now()}},
    )

    # ── Also sync the linked due_dates calendar entry so the dashboard
    #    "Upcoming Deadlines" widget immediately stops showing this item.
    #    When re-opened we restore status → "pending" so it reappears.
    linked_cal_id = existing.get("calendar_due_date_id")
    if linked_cal_id:
        new_due_date_status = "closed" if new_closed else "pending"
        await db.due_dates.update_one(
            {"id": linked_cal_id},
            {"$set": {"status": new_due_date_status}},
        )
    else:
        # No explicit link — try matching by name so manually-created items
        # (FORM 11, PAS 6, TDS Return Q4 etc.) are also hidden.
        compliance_name = existing.get("name", "")
        if compliance_name:
            new_due_date_status = "closed" if new_closed else "pending"
            await db.due_dates.update_many(
                {"title": compliance_name, "status": {"$in": ["pending", "closed"]}},
                {"$set": {"status": new_due_date_status}},
            )

    doc = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0})
    return await _enrich(doc)

# ─────────────────────────────────────────────────────────────────────────────
# ASSIGNMENTS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{compliance_id}/assignments")
async def list_assignments(
    compliance_id: str,
    status:  Optional[str] = Query(None),
    search:  Optional[str] = Query(None),
    page:    int           = Query(1, ge=1),
    limit:   int           = Query(200, le=1000),
    current_user: User     = Depends(check_module_permission("compliance", "view")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_view_compliance", False):
        raise HTTPException(403, "You do not have permission to view compliance assignments")

    # Verify the compliance master is within the user's allowed categories
    if current_user.role != "admin":
        cm_doc = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0, "category": 1})
        if cm_doc:
            allowed_cats = get_allowed_categories(current_user)
            if allowed_cats is not None and cm_doc.get("category") not in allowed_cats:
                raise HTTPException(403, "You are not authorised to view this compliance item")
    query: dict = {"compliance_id": compliance_id}
    if status and status != "all":
        query["status"] = status
    if search:
        query["client_name"] = {"$regex": search.strip(), "$options": "i"}

    total = await db.compliance_assignments.count_documents(query)
    skip  = (page - 1) * limit
    items = await db.compliance_assignments.find(query, {"_id": 0}).sort("client_name", 1).skip(skip).limit(limit).to_list(limit)

    # Resolve assigned_to names
    user_ids = list({a["assigned_to"] for a in items if a.get("assigned_to")})
    user_map: dict = {}
    if user_ids:
        users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}).to_list(500)
        user_map = {u["id"]: u["full_name"] for u in users}
    for a in items:
        a["assigned_to_name"] = user_map.get(a.get("assigned_to", ""), "")

    # Self-heal any legacy/stale records with a missing or blank client_name —
    # re-resolve from the clients collection (by client_id) and persist the
    # fix so it doesn't need repairing again on the next read.
    stale = [a for a in items if not (a.get("client_name") or "").strip() and a.get("client_id")]
    if stale:
        stale_client_ids = list({a["client_id"] for a in stale})
        stale_clients = await db.clients.find(
            {"id": {"$in": stale_client_ids}}, {"_id": 0, "id": 1, "company_name": 1}
        ).to_list(len(stale_client_ids))
        stale_name_map = {c["id"]: c.get("company_name") for c in stale_clients if c.get("company_name")}
        for a in stale:
            fixed_name = stale_name_map.get(a["client_id"])
            if fixed_name:
                a["client_name"] = fixed_name
                await db.compliance_assignments.update_one(
                    {"id": a["id"]}, {"$set": {"client_name": fixed_name, "updated_at": _now()}}
                )

    return {"total": total, "page": page, "limit": limit, "items": items}


@router.post("/{compliance_id}/assignments")
async def create_single_assignment(
    compliance_id: str,
    data: AssignmentCreate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    cm = await db.compliance_masters.find_one({"id": compliance_id})
    if not cm:
        raise HTTPException(404, "Compliance not found")

    existing = await db.compliance_assignments.find_one(
        {"compliance_id": compliance_id, "client_id": data.client_id}
    )
    if existing:
        raise HTTPException(400, "Client already assigned to this compliance")

    client_name = await _resolve_client_name(data.client_id)
    doc = {
        "id":            str(uuid.uuid4()),
        "compliance_id": compliance_id,
        "client_id":     data.client_id,
        "client_name":   client_name,
        "status":        data.status,
        "assigned_to":   data.assigned_to,
        "notes":         data.notes,
        "created_at":    _now(),
        "updated_at":    _now(),
        "completed_at":  _now() if data.status in ("completed", "filed") else None,
        "filed_at":      _now() if data.status == "filed" else None,
    }
    await db.compliance_assignments.insert_one({**doc, "_id": doc["id"]})
    return doc


@router.post("/{compliance_id}/assignments/bulk-assign")
async def bulk_assign_clients(
    compliance_id: str,
    data: BulkAssignRequest,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_manage_compliance", False):
        raise HTTPException(403, "You do not have permission to bulk-assign clients")

    cm = await db.compliance_masters.find_one({"id": compliance_id})
    if not cm:
        raise HTTPException(404, "Compliance not found")

    # Dept scope check
    if current_user.role != "admin":
        allowed_cats = get_allowed_categories(current_user)
        if allowed_cats is not None and (cm.get("category") or "") not in allowed_cats:
            raise HTTPException(403, "You are not authorised to manage this compliance item")

    compliance_category = (cm.get("category") or "").upper()

    # Category → service keyword mapping for matching client.assignments[].services
    CATEGORY_SERVICE_KEYWORDS = {
        "ROC":     ["roc", "mca", "company"],
        "GST":     ["gst"],
        "ITR":     ["itr", "income tax", "it"],
        "TDS":     ["tds", "tcs"],
        "AUDIT":   ["audit"],
        "PF_ESIC": ["pf", "esic", "provident"],
        "PT":      ["pt", "professional tax"],
    }
    keywords = CATEGORY_SERVICE_KEYWORDS.get(compliance_category, [])

    def _pick_assigned(client_doc: dict) -> Optional[str]:
        """
        Priority:
        1. Client's per-service assignment matching this compliance category
        2. Client's default assigned_to
        3. Caller-supplied data.assigned_to (modal dropdown)
        """
        # 1. Service-specific assignment
        for asgn in (client_doc.get("assignments") or []):
            svc_list = [s.lower() for s in (asgn.get("services") or [])]
            if any(kw in " ".join(svc_list) for kw in keywords):
                uid = asgn.get("user_id")
                if uid:
                    return uid
        # 2. Client default
        if client_doc.get("assigned_to"):
            return client_doc["assigned_to"]
        # 3. Modal-level fallback
        return data.assigned_to or None

    # Already-assigned client IDs
    existing_ids: set = set()
    async for a in db.compliance_assignments.find(
        {"compliance_id": compliance_id}, {"_id": 0, "client_id": 1}
    ):
        existing_ids.add(a["client_id"])

    # Fetch client info in bulk — include assigned_to and assignments fields
    clients = await db.clients.find(
        {"id": {"$in": data.client_ids}},
        {"_id": 0, "id": 1, "company_name": 1, "assigned_to": 1, "assignments": 1},
    ).to_list(5000)
    client_map = {c["id"]: c for c in clients}

    docs = []
    skipped = 0
    for cid in data.client_ids:
        if cid in existing_ids:
            skipped += 1
            continue
        client_doc  = client_map.get(cid, {})
        assigned_id = _pick_assigned(client_doc)
        doc = {
            "id":            str(uuid.uuid4()),
            "compliance_id": compliance_id,
            "client_id":     cid,
            "client_name":   client_doc.get("company_name", "Unknown"),
            "status":        data.default_status,
            "assigned_to":   assigned_id,
            "notes":         None,
            "created_at":    _now(),
            "updated_at":    _now(),
            "completed_at":  _now() if data.default_status in ("completed", "filed") else None,
            "filed_at":      _now() if data.default_status == "filed" else None,
        }
        docs.append({**doc, "_id": doc["id"]})

    if docs:
        await db.compliance_assignments.insert_many(docs)

    return {"added": len(docs), "skipped": skipped, "total_requested": len(data.client_ids)}


@router.patch("/{compliance_id}/assignments/bulk-update")
async def bulk_update_status(
    compliance_id: str,
    data: BulkStatusUpdate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_manage_compliance", False):
        raise HTTPException(403, "You do not have permission to update compliance assignments")

    # Dept scope check
    if current_user.role != "admin":
        cm_doc = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0, "category": 1})
        if cm_doc:
            allowed_cats = get_allowed_categories(current_user)
            if allowed_cats is not None and cm_doc.get("category") not in allowed_cats:
                raise HTTPException(403, "You are not authorised to update this compliance item")

    if data.status not in STATUSES:
        raise HTTPException(400, f"Invalid status. Use: {STATUSES}")

    upd: dict = {
        "status":     data.status,
        "updated_at": _now(),
        "updated_by": current_user.id,
    }
    if data.notes      is not None: upd["notes"]       = data.notes
    if data.assigned_to is not None: upd["assigned_to"] = data.assigned_to
    if data.status == "completed":   upd["completed_at"] = _now()
    if data.status == "filed":       upd["filed_at"]     = _now()

    result = await db.compliance_assignments.update_many(
        {"id": {"$in": data.assignment_ids}, "compliance_id": compliance_id},
        {"$set": upd},
    )
    return {"updated": result.modified_count}


@router.patch("/{compliance_id}/assignments/{assignment_id}")
async def update_single_assignment(
    compliance_id:  str,
    assignment_id:  str,
    data: AssignmentUpdate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_view_compliance", False):
        raise HTTPException(403, "You do not have permission to update compliance assignments")

    # Dept scope check
    if current_user.role != "admin":
        cm_doc = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0, "category": 1})
        if cm_doc:
            allowed_cats = get_allowed_categories(current_user)
            if allowed_cats is not None and cm_doc.get("category") not in allowed_cats:
                raise HTTPException(403, "You are not authorised to update this compliance item")

    if data.status not in STATUSES:
        raise HTTPException(400, f"Invalid status. Use: {STATUSES}")

    upd: dict = {
        "status":     data.status,
        "updated_at": _now(),
        "updated_by": current_user.id,
    }
    if data.notes         is not None: upd["notes"]         = data.notes
    if data.assigned_to   is not None: upd["assigned_to"]   = data.assigned_to
    if data.applicability is not None: upd["applicability"] = bool(data.applicability)
    if data.status == "completed":   upd["completed_at"] = _now()
    if data.status == "filed":       upd["filed_at"]     = _now()

    res = await db.compliance_assignments.update_one(
        {"id": assignment_id, "compliance_id": compliance_id},
        {"$set": upd},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "Assignment not found")

    doc = await db.compliance_assignments.find_one({"id": assignment_id}, {"_id": 0})
    return doc


@router.delete("/{compliance_id}/assignments/{assignment_id}")
async def delete_assignment(
    compliance_id: str,
    assignment_id: str,
    current_user: User = Depends(check_module_permission("compliance", "delete")),
):
    await db.compliance_assignments.delete_one(
        {"id": assignment_id, "compliance_id": compliance_id}
    )
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────────
# EXCEL / CSV IMPORT
# ─────────────────────────────────────────────────────────────────────────────

def _read_file(contents: bytes, filename: str) -> pd.DataFrame:
    try:
        if filename.lower().endswith(".csv"):
            return pd.read_csv(io.BytesIO(contents))
        return pd.read_excel(io.BytesIO(contents))
    except Exception as exc:
        raise HTTPException(400, f"Could not parse file: {exc}")


@router.post("/{compliance_id}/preview-excel")
async def preview_excel(
    compliance_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """Return columns + first 10 rows so the frontend can map columns before import."""
    contents = await file.read()
    df = _read_file(contents, file.filename or "upload.xlsx")
    df.columns = [str(c).strip() for c in df.columns]
    df = df.where(pd.notnull(df), None)          # NaN → None
    preview = df.head(10).to_dict(orient="records")
    return {
        "columns":    list(df.columns),
        "rows":       preview,
        "total_rows": len(df),
    }


@router.post("/{compliance_id}/import-excel")
async def import_from_excel(
    compliance_id: str,
    file:          UploadFile   = File(...),
    client_col:    str          = Form(default="Client Name"),
    status_col:    str          = Form(default=""),
    notes_col:     str          = Form(default=""),
    assigned_col:  str          = Form(default=""),
    assigned_to_col: str        = Form(default=""),   # alias from frontend
    default_assigned_to: str    = Form(default=""),   # fallback user id
    current_user:  User         = Depends(check_module_permission("compliance", "create")),
):
    """
    Import client assignments from Excel / CSV.

    Expected columns (at minimum):
      • client_col   → client company name (matched against db.clients.company_name)
      • status_col   → optional: not_started | in_progress | completed | filed | na
      • notes_col    → optional: notes text
      • assigned_col → optional: assigned user full name
    """
    cm = await db.compliance_masters.find_one({"id": compliance_id})
    if not cm:
        raise HTTPException(404, "Compliance not found")

    contents = await file.read()
    df = _read_file(contents, file.filename or "upload.xlsx")
    df.columns = [str(c).strip() for c in df.columns]

    # Auto-detect client column if not found
    if client_col not in df.columns:
        candidates = [c for c in df.columns if "client" in c.lower() or "company" in c.lower() or "name" in c.lower()]
        if candidates:
            client_col = candidates[0]
        else:
            raise HTTPException(400, f"Column '{client_col}' not found. Available: {list(df.columns)}")

    # Resolve assigned_col: frontend may send as assigned_to_col
    if not assigned_col and assigned_to_col:
        assigned_col = assigned_to_col

    # Resolve default_assigned_to: verify it's a real user id
    fallback_assigned: Optional[str] = None
    if default_assigned_to:
        ua = await db.users.find_one({"id": default_assigned_to}, {"_id": 0, "id": 1})
        if ua:
            fallback_assigned = ua["id"]

    # Build lookup maps
    all_clients = await db.clients.find(
        {}, {"_id": 0, "id": 1, "company_name": 1}
    ).to_list(50000)
    client_name_map = {c["company_name"].strip().lower(): c for c in all_clients if c.get("company_name")}

    all_users = await db.users.find({}, {"_id": 0, "id": 1, "full_name": 1}).to_list(500)
    user_name_map = {u["full_name"].strip().lower(): u["id"] for u in all_users if u.get("full_name")}

    # Existing assignments for this compliance (by client name, lower)
    existing_map: dict = {}
    async for a in db.compliance_assignments.find(
        {"compliance_id": compliance_id}, {"_id": 0, "id": 1, "client_name": 1}
    ):
        existing_map[a["client_name"].strip().lower()] = a["id"]

    to_insert = []
    to_update = []
    not_found_clients = []

    for _, row in df.iterrows():
        raw_name = str(row.get(client_col, "") or "").strip()
        if not raw_name or raw_name.lower() == "nan":
            continue

        name_key    = raw_name.lower()
        client_doc  = client_name_map.get(name_key)
        client_id   = client_doc["id"] if client_doc else ""
        client_name = client_doc["company_name"] if client_doc else raw_name
        if not client_doc:
            not_found_clients.append(raw_name)

        # Status
        status_val = "not_started"
        if status_col and status_col in df.columns:
            raw_s = str(row.get(status_col, "") or "").strip().lower().replace(" ", "_")
            if raw_s in STATUSES:
                status_val = raw_s

        # Notes
        notes_val = None
        if notes_col and notes_col in df.columns:
            nv = str(row.get(notes_col, "") or "").strip()
            if nv and nv.lower() != "nan":
                notes_val = nv

        # Assigned to
        assigned_id = None
        if assigned_col and assigned_col in df.columns:
            av = str(row.get(assigned_col, "") or "").strip().lower()
            assigned_id = user_name_map.get(av)
        # Fall back to default if no per-row value
        if not assigned_id and fallback_assigned:
            assigned_id = fallback_assigned

        if name_key in existing_map:
            to_update.append((existing_map[name_key], {
                "status":     status_val,
                "notes":      notes_val,
                "updated_at": _now(),
                **({"assigned_to": assigned_id} if assigned_id else {}),
                **({"completed_at": _now()} if status_val in ("completed", "filed") else {}),
                **({"filed_at":     _now()} if status_val == "filed" else {}),
            }))
        else:
            doc = {
                "id":            str(uuid.uuid4()),
                "compliance_id": compliance_id,
                "client_id":     client_id,
                "client_name":   client_name,
                "status":        status_val,
                "assigned_to":   assigned_id,
                "notes":         notes_val,
                "created_at":    _now(),
                "updated_at":    _now(),
                "completed_at":  _now() if status_val in ("completed", "filed") else None,
                "filed_at":      _now() if status_val == "filed" else None,
            }
            to_insert.append({**doc, "_id": doc["id"]})
            existing_map[name_key] = doc["id"]

    if to_insert:
        await db.compliance_assignments.insert_many(to_insert)
    for aid, upd in to_update:
        await db.compliance_assignments.update_one({"id": aid}, {"$set": upd})

    return {
        "added":               len(to_insert),
        "updated":             len(to_update),
        "total_rows_in_file":  len(df),
        "clients_not_in_db":   not_found_clients[:20],  # show max 20
    }


# ─────────────────────────────────────────────────────────────────────────────
# INDEXES  (call once at startup, idempotent)
# ─────────────────────────────────────────────────────────────────────────────

async def create_compliance_indexes():
    try:
        await db.compliance_masters.create_index("id",       unique=True, background=True)
        await db.compliance_masters.create_index("category", background=True)
        await db.compliance_masters.create_index("fy_year",  background=True)
        await db.compliance_assignments.create_index("id",            unique=True, background=True)
        await db.compliance_assignments.create_index("compliance_id", background=True)
        await db.compliance_assignments.create_index("client_id",     background=True)
        await db.compliance_assignments.create_index("status",        background=True)
        await db.compliance_assignments.create_index(
            [("compliance_id", 1), ("client_id", 1)], unique=True, background=True
        )
        logger.info("Compliance indexes ensured")
    except Exception as exc:
        logger.warning("Compliance index creation: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# COMMENTS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{compliance_id}/comments")
async def list_comments(
    compliance_id: str,
    client_id:     Optional[str] = Query(None),
    current_user: User = Depends(check_module_permission("compliance", "view")),
):
    """Get all comments for a compliance, optionally filtered by client."""
    query: dict = {"compliance_id": compliance_id}
    if client_id:
        query["client_id"] = client_id

    comments = await db.compliance_comments.find(query, {"_id": 0}).sort("created_at", -1).to_list(500)

    # Enrich with author name
    user_ids = list({c["author_id"] for c in comments if c.get("author_id")})
    user_map: dict = {}
    if user_ids:
        users = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}).to_list(200)
        user_map = {u["id"]: u["full_name"] for u in users}
    for c in comments:
        c["author_name"] = user_map.get(c.get("author_id", ""), "Unknown")

    return comments


@router.post("/{compliance_id}/comments")
async def add_comment(
    compliance_id: str,
    data: CommentCreate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """Add a comment to a compliance (optionally scoped to a client assignment)."""
    # Resolve client name if client_id provided
    client_name = None
    if data.client_id:
        doc = await db.clients.find_one({"id": data.client_id}, {"_id": 0, "company_name": 1})
        client_name = (doc or {}).get("company_name")

    comment = {
        "id":            str(uuid.uuid4()),
        "compliance_id": compliance_id,
        "client_id":     data.client_id,
        "client_name":   client_name,
        "assignment_id": data.assignment_id,
        "text":          data.text.strip(),
        "author_id":     current_user.id,
        "author_name":   getattr(current_user, "full_name", ""),
        "created_at":    _now(),
        "updated_at":    _now(),
    }
    await db.compliance_comments.insert_one({**comment, "_id": comment["id"]})
    return comment


@router.delete("/{compliance_id}/comments/{comment_id}")
async def delete_comment(
    compliance_id: str,
    comment_id:    str,
    current_user: User = Depends(check_module_permission("compliance", "delete")),
):
    """Delete a comment (author or admin only)."""
    doc = await db.compliance_comments.find_one({"id": comment_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Comment not found")
    if doc.get("author_id") != current_user.id and current_user.role != "admin":
        raise HTTPException(403, "Not allowed")
    await db.compliance_comments.delete_one({"id": comment_id})
    return {"deleted": True}


# ─────────────────────────────────────────────────────────────────────────────
# MONTHLY TRACKING
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{compliance_id}/monthly-summary")
async def monthly_summary(
    compliance_id: str,
    fy_year:       Optional[str] = Query(None),
    current_user: User = Depends(check_module_permission("compliance", "view")),
):
    """Return per-month breakdown of assignment statuses for a compliance type."""
    import calendar as cal
    query: dict = {"compliance_id": compliance_id}
    records = await db.compliance_assignments.find(query, {"_id": 0}).to_list(5000)

    # Build monthly breakdown from monthly_statuses embedded field
    # Each assignment may have: monthly_statuses = {"2025-04": "completed", ...}
    all_months: dict = {}
    for rec in records:
        ms = rec.get("monthly_statuses") or {}
        for month, status in ms.items():
            if month not in all_months:
                all_months[month] = {"month": month, "not_started": 0, "in_progress": 0,
                                     "completed": 0, "filed": 0, "na": 0, "total": 0}
            all_months[month][status] = all_months[month].get(status, 0) + 1
            all_months[month]["total"] += 1

    months_sorted = sorted(all_months.values(), key=lambda x: x["month"])
    return {"months": months_sorted, "total_clients": len(records)}


@router.patch("/{compliance_id}/assignments/{assignment_id}/monthly")
async def update_monthly_status(
    compliance_id:  str,
    assignment_id:  str,
    data: MonthlyStatusUpdate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """Set/update the status for a specific month on an assignment."""
    # ── Permission gate ─────────────────────────────────────────────────────
    perms = current_user.permissions if isinstance(current_user.permissions, dict) else \
            (current_user.permissions.model_dump() if hasattr(current_user.permissions, "model_dump") else {})
    if current_user.role != "admin" and not perms.get("can_view_compliance", False):
        raise HTTPException(403, "You do not have permission to update compliance assignments")

    # Dept scope check
    if current_user.role != "admin":
        cm_doc = await db.compliance_masters.find_one({"id": compliance_id}, {"_id": 0, "category": 1})
        if cm_doc:
            allowed_cats = get_allowed_categories(current_user)
            if allowed_cats is not None and cm_doc.get("category") not in allowed_cats:
                raise HTTPException(403, "You are not authorised to update this compliance item")

    if data.status not in STATUSES:
        raise HTTPException(400, f"Invalid status. Use: {STATUSES}")

    upd: dict = {
        f"monthly_statuses.{data.month}": data.status,
        "updated_at": _now(),
        "updated_by": current_user.id,
    }
    if data.notes:
        upd[f"monthly_notes.{data.month}"] = data.notes
    if data.assigned_to:
        upd[f"monthly_assigned.{data.month}"] = data.assigned_to

    res = await db.compliance_assignments.update_one(
        {"id": assignment_id, "compliance_id": compliance_id},
        {"$set": upd},
    )
    if res.matched_count == 0:
        raise HTTPException(404, "Assignment not found")

    doc = await db.compliance_assignments.find_one({"id": assignment_id}, {"_id": 0})
    return doc


# ─────────────────────────────────────────────────────────────────────────────
# GOVERNMENT FEES — per-client view
# ─────────────────────────────────────────────────────────────────────────────

class GovtFeeUpdate(BaseModel):
    # All fields optional so callers can PATCH a subset without wiping the others.
    govt_fees_amount:  Optional[float] = None
    govt_fees_notes:   Optional[str]   = None
    govt_fees_srn:     Optional[str]   = None
    reimbursed:        Optional[bool]  = None   # True = received from client
    reimbursed_amount: Optional[float] = None   # editable; defaults to govt_fees_amount
    bill_in_next_cycle: Optional[bool] = None   # defer billing until the next invoice cycle


@router.get("/by-client/{client_id}")
async def list_compliance_for_client(
    client_id:  str,
    govt_fees:  bool = Query(True, description="Only compliance entries marked as Govt Fees"),
    current_user: User = Depends(check_module_permission("compliance", "view")),
):
    """
    Returns every compliance master assigned to a client, joined with its
    assignment (so we can read/write the govt-fee amount per client).
    Used by the 'Govt Fees' tab on the Client detail popup.
    """
    asgns = await db.compliance_assignments.find(
        {"client_id": client_id}, {"_id": 0}
    ).to_list(2000)
    if not asgns:
        return {"items": []}

    cm_ids = list({a["compliance_id"] for a in asgns if a.get("compliance_id")})
    cm_query: dict = {"id": {"$in": cm_ids}}
    if govt_fees:
        cm_query["govt_fees"] = True
    masters = await db.compliance_masters.find(cm_query, {"_id": 0}).to_list(2000)
    master_map = {m["id"]: m for m in masters}

    # Older records may have been auto-added to a draft invoice before the
    # billed markers existed. Hydrate those markers from invoice line items
    # so they cannot be auto-added to a second invoice.
    invoice_fee_map = {}
    existing_invoices = await db.invoices.find(
        {"client_id": client_id, "items.product_id": {"$regex": "^compliance_govt_fee:"}},
        {"_id": 0, "id": 1, "invoice_no": 1, "invoice_date": 1, "items": 1},
    ).to_list(5000)
    for inv in existing_invoices:
        for invoice_item in inv.get("items") or []:
            marker = invoice_item.get("product_id") or ""
            if marker.startswith("compliance_govt_fee:"):
                invoice_fee_map[marker.split(":", 1)[1]] = {
                    "invoice_id": inv.get("id"),
                    "invoice_no": inv.get("invoice_no"),
                    "invoice_date": inv.get("invoice_date"),
                    "amount": float(invoice_item.get("unit_price") or 0),
                }

    items = []
    for a in asgns:
        m = master_map.get(a.get("compliance_id"))
        if not m:
            continue  # filtered out (not a govt-fees compliance)
        items.append({
            "assignment_id":    a["id"],
            "compliance_id":    m["id"],
            "name":             m.get("name"),
            "category":         m.get("category"),
            "frequency":        m.get("frequency"),
            "fy_year":          m.get("fy_year"),
            "period_label":     m.get("period_label"),
            "due_date":         m.get("due_date"),
            "status":           a.get("status"),
            "govt_fees_amount": a.get("govt_fees_amount", 0) or 0,
            "govt_fees_notes":  a.get("govt_fees_notes", "") or "",
            "govt_fees_srn":    a.get("govt_fees_srn", "") or "",
            "reimbursed":       a.get("reimbursed", False) or False,
            "reimbursed_amount": a.get("reimbursed_amount"),   # None = use govt_fees_amount
            "bill_in_next_cycle": bool(a.get("bill_in_next_cycle", False)),
            "govt_fee_deferred_at": a.get("govt_fee_deferred_at"),
            "govt_fee_invoice_id": a.get("govt_fee_invoice_id") or invoice_fee_map.get(a["id"], {}).get("invoice_id"),
            "govt_fee_invoice_no": a.get("govt_fee_invoice_no") or invoice_fee_map.get(a["id"], {}).get("invoice_no"),
            "govt_fee_billed_at": a.get("govt_fee_billed_at") or invoice_fee_map.get(a["id"], {}).get("invoice_date"),
            "govt_fee_billed_amount": a.get("govt_fee_billed_amount") or invoice_fee_map.get(a["id"], {}).get("amount"),
        })
    items.sort(key=lambda x: (x.get("fy_year") or "", x.get("name") or ""))
    return {"items": items}


async def _sync_govt_fee_to_invoice(
    assignment: dict,
    compliance_name: str,
    current_user: User,
) -> None:
    """
    Push a compliance's Govt Fee + SRN into the client's invoicing as a
    "ROC Filing Fees" line item — automatically, the moment both fields are
    saved together on the Compliance tracker.

    Target invoice:
      - The client's most recent DRAFT invoice, if one exists.
      - Otherwise a new draft invoice is created for them.

    Idempotency: the line item created for a given compliance assignment is
    tagged internally (via InvoiceItem.product_id, which is never shown on
    the printed invoice) with f"compliance_govt_fee:{assignment_id}". If the
    same assignment's fee/SRN is edited later, that exact line item is
    updated in place rather than duplicated — even across multiple draft
    invoices, in case the client's active draft changed in the meantime.
    """
    client_id = assignment.get("client_id")
    if not client_id:
        return

    amount = float(assignment.get("govt_fees_amount") or 0)
    srn    = (assignment.get("govt_fees_srn") or "").strip()
    if amount <= 0 or not srn:
        return

    client = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not client:
        return

    marker = f"compliance_govt_fee:{assignment['id']}"
    description = "ROC Filing Fees"
    item_details = f"{compliance_name or 'Compliance Filing'} · SRN: {srn}"

    def _make_item(existing_item: Optional[dict] = None) -> dict:
        base = dict(existing_item) if existing_item else {
            "product_id": marker, "hsn_sac": None, "quantity": 1.0, "unit": "service",
            "discount_pct": 0.0, "gst_rate": 0.0, "cgst_rate": 0.0, "sgst_rate": 0.0,
            "igst_rate": 0.0,
        }
        base.update({
            "product_id":  marker,
            "description": description,
            "item_details": item_details,
            "unit_price":  amount,
        })
        return base

    # 1. Look for an existing line item already tagged for this assignment,
    #    on ANY of the client's invoices (in case the draft it lived on was
    #    since finalised/changed) — update it in place if found.
    tagged_invoice = await db.invoices.find_one(
        {"client_id": client_id, "items.product_id": marker}, {"_id": 0}
    )
    if tagged_invoice:
        items = tagged_invoice.get("items") or []
        new_items = []
        found = False
        for it in items:
            if it.get("product_id") == marker:
                new_items.append(_make_item(it))
                found = True
            else:
                new_items.append(it)
        if not found:
            new_items.append(_make_item())
        target_invoice, target_is_new = tagged_invoice, False
        target_invoice["items"] = new_items
    else:
        # 2. No existing line for this assignment yet — find the client's
        #    most recent draft invoice to append to.
        draft = await db.invoices.find_one(
            {"client_id": client_id, "status": "draft"},
            {"_id": 0}, sort=[("created_at", -1)],
        )
        if draft:
            target_invoice, target_is_new = draft, False
            target_invoice["items"] = (draft.get("items") or []) + [_make_item()]
        else:
            # 3. No draft exists — create a fresh one for this client.
            companies = await db.companies.find({}, {"_id": 0, "id": 1}).sort("created_at", 1).to_list(1)
            company_id = companies[0]["id"] if companies else ""
            now = _now()
            address_parts = [client.get("address"), client.get("city"), client.get("state")]
            target_invoice = {
                "id": str(uuid.uuid4()),
                "invoice_type": "tax_invoice",
                "company_id": company_id,
                "client_id": client_id,
                "lead_id": None, "quotation_id": None,
                "client_name": client.get("company_name") or "",
                "client_address": ", ".join([p for p in address_parts if p]),
                "client_email": client.get("email") or "",
                "client_phone": client.get("phone") or "",
                "client_gstin": client.get("gstin") or "",
                "client_state": client.get("state") or "",
                "invoice_date": now[:10],
                "due_date": now[:10],
                "supply_state": "", "is_interstate": False,
                "items": [_make_item()],
                "gst_rate": 18.0, "discount_amount": 0.0, "shipping_charges": 0.0,
                "other_charges": 0.0, "advance_received": 0.0,
                "payment_terms": "Due on receipt", "notes": "", "terms_conditions": "",
                "reference_no": "", "is_recurring": False, "recurrence_pattern": "monthly",
                "recurrence_end": None, "next_invoice_date": None,
                "status": "draft",
                "invoice_template": "prestige", "invoice_theme": "classic_blue",
                "invoice_custom_color": "#0D3B66",
                "amount_paid": 0.0, "amount_due": 0.0, "pdf_drive_link": "",
                "created_by": current_user.id, "created_at": now, "updated_at": now,
            }
            target_invoice["invoice_no"] = await _next_invoice_no(
                prefix="INV", company_id=company_id, separator="/",
                include_fy=True, fy_format="short", include_month=False,
                number_padding=3, invoice_type="tax_invoice",
            )
            target_is_new = True

    has_gst = await _company_has_gst(target_invoice.get("company_id") or "")
    target_invoice = _compute_invoice_totals(target_invoice, has_gst)
    target_invoice["updated_at"] = _now()

    if target_is_new:
        await db.invoices.insert_one({**target_invoice, "_id": target_invoice["id"]})
    else:
        await db.invoices.update_one({"id": target_invoice["id"]}, {"$set": target_invoice})

    try:
        await sync_invoice_journal_entry(target_invoice["id"])
        await recalculate_invoice_accounting(target_invoice["id"])
    except Exception:
        logger.exception("Invoice accounting sync failed after govt-fee auto-sync (invoice %s)", target_invoice["id"])


@router.patch("/{compliance_id}/assignments/{assignment_id}/govt-fee")
async def update_assignment_govt_fee(
    compliance_id: str,
    assignment_id: str,
    data: GovtFeeUpdate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """Persist a partial update to the government-fee row for a single client/compliance.

    Only fields explicitly supplied in the request body are written, so toggling
    Reimbursed (or editing the reimbursed amount) no longer wipes the saved
    amount / SRN, and vice-versa.
    """
    payload = data.dict(exclude_unset=True)

    existing = await db.compliance_assignments.find_one(
        {"id": assignment_id, "compliance_id": compliance_id}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(404, "Assignment not found")

    set_doc: dict = {"updated_at": _now(), "updated_by": current_user.id}

    if "govt_fees_amount" in payload:
        set_doc["govt_fees_amount"] = float(payload["govt_fees_amount"] or 0)
    if "govt_fees_notes" in payload:
        set_doc["govt_fees_notes"] = payload["govt_fees_notes"]
    if "govt_fees_srn" in payload:
        set_doc["govt_fees_srn"] = (payload["govt_fees_srn"] or "").strip()
    if "reimbursed" in payload:
        set_doc["reimbursed"] = bool(payload["reimbursed"])
    if "reimbursed_amount" in payload:
        set_doc["reimbursed_amount"] = (
            float(payload["reimbursed_amount"])
            if payload["reimbursed_amount"] is not None else None
        )
    unset_doc: dict = {}
    if "bill_in_next_cycle" in payload:
        defer = bool(payload["bill_in_next_cycle"])
        set_doc["bill_in_next_cycle"] = defer
        if defer:
            set_doc["govt_fee_deferred_at"] = _now()
        else:
            unset_doc["govt_fee_deferred_at"] = ""

    # Resolve effective amount + srn (post-update) for the auto-filed rule.
    eff_amount = set_doc.get("govt_fees_amount", existing.get("govt_fees_amount") or 0) or 0
    eff_srn    = (set_doc.get("govt_fees_srn",  existing.get("govt_fees_srn")    or "") or "").strip()
    if eff_amount > 0 and eff_srn:
        now = _now()
        set_doc.update({
            "status":       "filed",
            "filed_at":     now,
            "completed_at": now,
            "payment_date": now[:10],
        })

    # ── Build fee_history entries ────────────────────────────────────────────
    user_name = getattr(current_user, "full_name", None) or getattr(current_user, "email", "")
    ts_now = _now()
    existing_history = existing.get("fee_history") or []
    entries_to_push: list = []

    # If this is the very first save and there is already data on the record
    # (saved before history tracking existed), synthesise a seed entry so the
    # log always shows at least the original value.
    if not existing_history:
        seed_amount = existing.get("govt_fees_amount") or 0
        seed_srn    = (existing.get("govt_fees_srn") or "").strip()
        if seed_amount or seed_srn:
            seed: dict = {
                "ts":         existing.get("updated_at") or ts_now,
                "updated_by": existing.get("updated_by") or current_user.id,
                "user_name":  "(prior save)",
            }
            if seed_amount:
                seed["amount"]      = float(seed_amount)
                seed["prev_amount"] = 0.0
            if seed_srn:
                seed["srn"]      = seed_srn
                seed["prev_srn"] = ""
            entries_to_push.append(seed)

    # Current change entry — record every change to amount or SRN
    prev_amount = existing.get("govt_fees_amount") or 0
    prev_srn    = (existing.get("govt_fees_srn") or "").strip()
    new_amount  = set_doc.get("govt_fees_amount")
    new_srn_val = set_doc.get("govt_fees_srn")

    amount_changed = (new_amount is not None) and (float(new_amount) != float(prev_amount))
    srn_changed    = (new_srn_val is not None) and (new_srn_val.strip() != prev_srn)

    if amount_changed or srn_changed:
        change_entry: dict = {
            "ts":         ts_now,
            "updated_by": current_user.id,
            "user_name":  user_name,
        }
        if amount_changed:
            change_entry["amount"]      = float(new_amount)
            change_entry["prev_amount"] = float(prev_amount)
        if srn_changed:
            change_entry["srn"]      = new_srn_val.strip()
            change_entry["prev_srn"] = prev_srn
        entries_to_push.append(change_entry)

    update_op: dict = {"$set": set_doc}
    if unset_doc:
        update_op["$unset"] = unset_doc
    if entries_to_push:
        update_op["$push"] = {"fee_history": {"$each": entries_to_push, "$slice": -100}}

    await db.compliance_assignments.update_one(
        {"id": assignment_id, "compliance_id": compliance_id},
        update_op,
    )
    doc = await db.compliance_assignments.find_one({"id": assignment_id}, {"_id": 0})

    # Invoice population is intentionally performed when a new invoice is
    # opened. Creating a draft invoice here made the same fee appear in later
    # bills and made "next billing cycle" impossible to honor.

    return doc


# ─────────────────────────────────────────────────────────────────────────────
# STANDALONE GOVT FEES — ad-hoc government fees NOT tied to a compliance master
# Useful for one-off filings that aren't part of a client's annual compliance
# (e.g. company-specific name change, increase in authorised capital, etc.)
# ─────────────────────────────────────────────────────────────────────────────

class StandaloneGovtFeeIn(BaseModel):
    client_id:         str
    title:             str
    category:          Optional[str]   = "OTHER"
    period_label:      Optional[str]   = None
    fy_year:           Optional[str]   = None
    due_date:          Optional[str]   = None
    payment_date:      Optional[str]   = None
    amount:            float           = 0.0
    srn:               Optional[str]   = None
    notes:             Optional[str]   = None
    status:            Optional[str]   = "pending"   # pending | paid
    reimbursed:        Optional[bool]  = False
    reimbursed_amount: Optional[float] = None   # defaults to amount when not set
    bill_in_next_cycle: Optional[bool] = False


class StandaloneGovtFeeBatchItem(BaseModel):
    title: str
    category: Optional[str] = "OTHER"
    period_label: Optional[str] = None
    fy_year: Optional[str] = None
    due_date: Optional[str] = None
    payment_date: Optional[str] = None
    amount: float = 0.0
    srn: Optional[str] = None
    notes: Optional[str] = None
    status: Optional[str] = "pending"
    reimbursed: Optional[bool] = False
    reimbursed_amount: Optional[float] = None
    bill_in_next_cycle: Optional[bool] = False


class StandaloneGovtFeeBatchIn(BaseModel):
    client_id: str
    payments: list[StandaloneGovtFeeBatchItem]


class StandaloneGovtFeeUpdate(BaseModel):
    title:             Optional[str]   = None
    category:          Optional[str]   = None
    period_label:      Optional[str]   = None
    fy_year:           Optional[str]   = None
    due_date:          Optional[str]   = None
    payment_date:      Optional[str]   = None
    amount:            Optional[float] = None
    srn:               Optional[str]   = None
    notes:             Optional[str]   = None
    status:            Optional[str]   = None
    reimbursed:        Optional[bool]  = None
    reimbursed_amount: Optional[float] = None
    bill_in_next_cycle: Optional[bool] = None


@router.get("/standalone-govt-fees")
async def list_standalone_govt_fees(
    client_id: Optional[str] = Query(None),
    current_user: User = Depends(check_module_permission("compliance", "view")),
):
    """List ad-hoc govt fees. Optionally filter by client_id."""
    q: dict = {}
    if client_id:
        q["client_id"] = client_id
    rows = await db.standalone_govt_fees.find(q, {"_id": 0}) \
        .sort("created_at", -1).to_list(5000)

    # Hydrate client name for table display on compliance-side view
    cids = list({r["client_id"] for r in rows if r.get("client_id")})
    if cids:
        clients = await db.clients.find(
            {"id": {"$in": cids}},
            {"_id": 0, "id": 1, "company_name": 1, "name": 1},
        ).to_list(5000)
        cmap = {
            c["id"]: (c.get("company_name") or c.get("name"))
            for c in clients
        }
        for r in rows:
            r["client_name"] = cmap.get(r.get("client_id"))
    return {"items": rows}


@router.post("/standalone-govt-fees")
async def create_standalone_govt_fee(
    data: StandaloneGovtFeeIn,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    if not (data.title or "").strip():
        raise HTTPException(400, "Title is required")
    if not (data.client_id or "").strip():
        raise HTTPException(400, "client_id is required")
    doc = {
        "id":           str(uuid.uuid4()),
        "client_id":    data.client_id,
        "title":        data.title.strip(),
        "category":     (data.category or "OTHER").upper(),
        "period_label": data.period_label,
        "fy_year":      data.fy_year,
        "due_date":     data.due_date,
        "payment_date": data.payment_date,
        "amount":       float(data.amount or 0),
        "srn":          (data.srn or "").strip() or None,
        "notes":        data.notes,
        "status":       data.status or "pending",
        "is_standalone": True,
        "reimbursed":        bool(data.reimbursed) if data.reimbursed is not None else False,
        "reimbursed_amount": float(data.reimbursed_amount) if data.reimbursed_amount is not None else None,
        "bill_in_next_cycle": bool(data.bill_in_next_cycle),
        "created_at":   _now(),
        "updated_at":   _now(),
        "created_by":   current_user.id,
    }
    await db.standalone_govt_fees.insert_one(dict(doc))
    doc.pop("_id", None)
    return doc


@router.post("/standalone-govt-fees/batch")
async def create_standalone_govt_fees_batch(
    data: StandaloneGovtFeeBatchIn,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    """Create multiple ad-hoc government fee payments for one client in one save."""
    if not (data.client_id or "").strip():
        raise HTTPException(400, "client_id is required")
    if not data.payments:
        raise HTTPException(400, "At least one payment is required")

    now = _now()
    docs = []
    for item in data.payments:
        if not (item.title or "").strip():
            raise HTTPException(400, "Title is required for every government fee")
        docs.append({
            "id": str(uuid.uuid4()),
            "client_id": data.client_id,
            "title": item.title.strip(),
            "category": (item.category or "OTHER").upper(),
            "period_label": item.period_label,
            "fy_year": item.fy_year,
            "due_date": item.due_date,
            "payment_date": item.payment_date,
            "amount": float(item.amount or 0),
            "srn": (item.srn or "").strip() or None,
            "notes": item.notes,
            "status": item.status or "pending",
            "is_standalone": True,
            "reimbursed": bool(item.reimbursed) if item.reimbursed is not None else False,
            "reimbursed_amount": float(item.reimbursed_amount) if item.reimbursed_amount is not None else None,
            "bill_in_next_cycle": bool(item.bill_in_next_cycle),
            "created_at": now,
            "updated_at": now,
            "created_by": current_user.id,
        })

    await db.standalone_govt_fees.insert_many([dict(doc) for doc in docs])
    return {"items": docs}


@router.patch("/standalone-govt-fees/{fee_id}")
async def update_standalone_govt_fee(
    fee_id: str,
    data: StandaloneGovtFeeUpdate,
    current_user: User = Depends(check_module_permission("compliance", "create")),
):
    update = {k: v for k, v in data.model_dump(exclude_none=True).items()}
    unset_doc = {}
    if "amount" in update:
        update["amount"] = float(update["amount"] or 0)
    if "title" in update:
        update["title"] = (update["title"] or "").strip()
    if "srn" in update:
        update["srn"] = (update["srn"] or "").strip() or None
    if "category" in update and update["category"]:
        update["category"] = update["category"].upper()
    if "bill_in_next_cycle" in update:
        update["bill_in_next_cycle"] = bool(update["bill_in_next_cycle"])
        if update["bill_in_next_cycle"]:
            update["govt_fee_deferred_at"] = _now()
        else:
            unset_doc["govt_fee_deferred_at"] = ""
    update["updated_at"] = _now()
    update["updated_by"] = current_user.id
    update_op = {"$set": update}
    if unset_doc:
        update_op["$unset"] = unset_doc
    res = await db.standalone_govt_fees.update_one({"id": fee_id}, update_op)
    if res.matched_count == 0:
        raise HTTPException(404, "Standalone govt fee not found")
    doc = await db.standalone_govt_fees.find_one({"id": fee_id}, {"_id": 0})
    return doc


@router.delete("/standalone-govt-fees/{fee_id}")
async def delete_standalone_govt_fee(
    fee_id: str,
    current_user: User = Depends(check_module_permission("compliance", "delete")),
):
    res = await db.standalone_govt_fees.delete_one({"id": fee_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Standalone govt fee not found")
    return {"ok": True}
