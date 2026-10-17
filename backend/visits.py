
"""
visits.py — Client Visit Planning Module  v6  CRASH & 404 FIX

ROOT CAUSE FIXES in v6:
  1. BLANK PAGE / REACT CRASH: Old visit documents in DB have missing/null
     fields (id, visit_date, assigned_to). The frontend's parseISO(v.visit_date)
     was crashing on null. Fixed by:
     - GET /visits now filters out documents with missing `id` or `visit_date`
     - All DB documents are sanitized via _sanitize_visit() before returning
  2. 404 ON QUICK-STATUS / EDIT / DELETE: Old visits stored with MongoDB _id
     only (no `id` string field), so /visits/{visit_id} returned 404.
     Fixed by: all single-visit lookups now try BOTH `id` field AND `_id`.
  3. PERMISSION SIMPLIFICATION (as requested):
     - Every user can add their OWN visit (assigned_to == current_user.id)
     - Every user can edit/change status of their OWN visit
     - Every user can delete their OWN visit (can_delete_own_visits defaults True)
     - To manage OTHER users' visits, need explicit permission or admin role
     - Admin has all rights on all visits
  4. ROUTE ORDER: All static paths (summary, upcoming, bulk-*, check-duplicate,
     admin/*, from-email) are registered BEFORE /{visit_id} to prevent FastAPI
     routing the literal string "summary" as a visit_id.
"""

import uuid
import logging
from datetime import datetime, date, timedelta, timezone
from typing import List, Optional, Literal
from zoneinfo import ZoneInfo
from calendar import monthrange

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator, ConfigDict

from backend.dependencies import db, get_current_user, require_admin, get_team_user_ids
from backend.models import User

logger = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")

router = APIRouter(prefix="/visits", tags=["visits"])

# ═══════════════════════════════════════════════════════════════════════════════
# PYDANTIC SCHEMAS
# ═══════════════════════════════════════════════════════════════════════════════

VisitStatus       = Literal["scheduled", "completed", "cancelled", "missed", "rescheduled"]
VisitPriority     = Literal["low", "medium", "high", "urgent"]

RecurrencePattern = Literal[
    "none",
    "weekly",
    "biweekly",
    "monthly",
    "nth_weekday",
    "last_weekday",
]


class VisitCreate(BaseModel):
    client_id:              str
    client_name:            Optional[str] = None
    assigned_to:            str
    visit_date:             str
    visit_time:             Optional[str] = None
    purpose:                str = Field(..., min_length=2, max_length=200)
    services:               List[str] = Field(default_factory=list)
    priority:               VisitPriority = "medium"
    notes:                  Optional[str] = None
    location:               Optional[str] = None
    recurrence:             RecurrencePattern = "none"
    recurrence_end_date:    Optional[str] = None
    recurrence_weekday:     Optional[int] = None
    recurrence_week_number: Optional[int] = None

    @field_validator("visit_date", "recurrence_end_date", mode="before")
    @classmethod
    def validate_date(cls, v):
        if v is None:
            return v
        if isinstance(v, date):
            return v.isoformat()
        try:
            date.fromisoformat(str(v)[:10])
            return str(v)[:10]
        except ValueError:
            raise ValueError(f"Invalid date format: {v}. Use YYYY-MM-DD.")


class VisitUpdate(BaseModel):
    model_config = ConfigDict(extra="ignore")

    visit_date:             Optional[str] = None
    visit_time:             Optional[str] = None
    purpose:                Optional[str] = None
    services:               Optional[List[str]] = None
    priority:               Optional[VisitPriority] = None
    status:                 Optional[VisitStatus] = None
    notes:                  Optional[str] = None
    location:               Optional[str] = None
    outcome:                Optional[str] = None
    follow_up_date:         Optional[str] = None
    recurrence:             Optional[RecurrencePattern] = None
    recurrence_end_date:    Optional[str] = None
    recurrence_weekday:     Optional[int] = None
    recurrence_week_number: Optional[int] = None

    @field_validator("visit_date", "follow_up_date", "recurrence_end_date", mode="before")
    @classmethod
    def validate_date(cls, v):
        if v is None or v == "":
            return None
        if isinstance(v, date):
            return v.isoformat()
        try:
            date.fromisoformat(str(v)[:10])
            return str(v)[:10]
        except ValueError:
            return None


class CommentCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=1000)


class BulkSchedulePayload(BaseModel):
    assigned_to:  str
    client_id:    str
    client_name:  Optional[str] = None
    purpose:      str
    services:     List[str] = Field(default_factory=list)
    priority:     VisitPriority = "medium"
    location:     Optional[str] = None
    notes:        Optional[str] = None
    visit_dates:  List[str]


class DuplicateCheckPayload(BaseModel):
    client_id:   str
    assigned_to: str
    visit_date:  str


class BulkDeletePayload(BaseModel):
    visit_ids: List[str] = Field(..., min_length=1, max_length=100)
    delete_recurrences: bool = False


class BulkDeleteResult(BaseModel):
    deleted: List[str] = Field(default_factory=list)
    forbidden: List[str] = Field(default_factory=list)
    not_found: List[str] = Field(default_factory=list)
    total_requested: int = 0
    total_deleted: int = 0


# ═══════════════════════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════════════════════

def _get_perms(user: User) -> dict:
    """Always returns a plain dict of the user's permissions."""
    if isinstance(user.permissions, dict):
        return user.permissions
    if user.permissions:
        try:
            return user.permissions.model_dump()
        except Exception:
            return {}
    return {}


def _sanitize_visit(v: dict) -> dict:
    """
    FIX FOR BLANK PAGE / REACT CRASH:
    Ensure every visit document has safe defaults for fields the frontend
    accesses directly (parseISO, format, etc.). Old documents in the DB
    may be missing these fields entirely.
    """
    # Ensure `id` exists — fall back to MongoDB _id string
    if not v.get("id"):
        raw_id = v.get("_id")
        v["id"] = str(raw_id) if raw_id else str(uuid.uuid4())

    # Ensure visit_date is a valid YYYY-MM-DD string
    vd = v.get("visit_date")
    if not vd:
        v["visit_date"] = date.today().isoformat()
    else:
        try:
            date.fromisoformat(str(vd)[:10])
            v["visit_date"] = str(vd)[:10]
        except (ValueError, TypeError):
            v["visit_date"] = date.today().isoformat()

    # Safe defaults for other fields
    v.setdefault("purpose", "")
    v.setdefault("status", "scheduled")
    v.setdefault("priority", "medium")
    v.setdefault("assigned_to", "")
    v.setdefault("client_id", "")
    v.setdefault("client_name", "")
    v.setdefault("services", [])
    v.setdefault("comments", [])
    v.setdefault("recurrence", "none")
    v.setdefault("location", None)
    v.setdefault("notes", None)
    v.setdefault("outcome", None)
    v.setdefault("visit_time", None)
    v.setdefault("recurrence_end_date", None)
    v.setdefault("recurrence_weekday", None)
    v.setdefault("recurrence_week_number", None)
    v.setdefault("parent_visit_id", None)

    # Remove MongoDB internal _id
    v.pop("_id", None)
    return v

async def _find_visit_by_any_id(visit_id: str) -> Optional[dict]:
    # 1. Try custom string `id` field
    visit = await db.visits.find_one({"id": visit_id})
    if visit:
        return _sanitize_visit(visit)

    # 2. Try MongoDB ObjectId (for legacy docs with ObjectId _id)
    try:
        from bson import ObjectId
        oid = ObjectId(visit_id)
        visit = await db.visits.find_one({"_id": oid})
        if visit:
            sanitized = _sanitize_visit(visit)
            if not visit.get("id"):
                await db.visits.update_one(
                    {"_id": oid},
                    {"$set": {"id": sanitized["id"]}}
                )
            return sanitized
    except Exception:
        pass

    # 3. NEW: Try _id as plain string (some old docs may store UUID as _id)
    visit = await db.visits.find_one({"_id": visit_id})
    if visit:
        return _sanitize_visit(visit)

    return None


def _can_read_visit(current_user: User, visit_owner_id: str, team_ids: list = None) -> bool:
    """
    PERMISSION MODEL:
    - Own visit: always readable
    - Admin: always readable
    - Manager: own + same-department team (team_ids) + can_view_all_visits
    - Staff: own + view_other_visits list + can_view_all_visits
    team_ids: pre-fetched department team IDs (caller must provide for manager scope)
    """
    if not visit_owner_id:
        return current_user.role == "admin"
    if current_user.role == "admin":
        return True
    if str(current_user.id) == str(visit_owner_id):
        return True
    perms = _get_perms(current_user)
    if perms.get("can_view_all_visits"):
        return True
    # Manager: allow same-department team members' visits
    if current_user.role == "manager" and team_ids:
        if str(visit_owner_id) in [str(t) for t in team_ids]:
            return True
    allowed = perms.get("view_other_visits") or []
    return str(visit_owner_id) in [str(x) for x in allowed]


def _can_write_visit(current_user: User, visit_owner_id: str) -> bool:
    """
    SIMPLIFIED PERMISSION MODEL (v6):
    - Own visit: always writable (every user can edit/change status of their own)
    - Admin: always writable
    - can_edit_visits perm: writable for any visit
    """
    if not visit_owner_id:
        return current_user.role == "admin"
    if current_user.role == "admin":
        return True
    if str(current_user.id) == str(visit_owner_id):
        return True   # ← KEY FIX: own visit always writable
    perms = _get_perms(current_user)
    return bool(perms.get("can_edit_visits"))


def _can_delete_visit(current_user: User, visit_owner_id: str) -> bool:
    """
    SIMPLIFIED PERMISSION MODEL (v6):
    - Admin: always
    - can_delete_visits perm: always
    - Own visit + can_delete_own_visits not False: yes (default True)
    """
    if not visit_owner_id:
        return current_user.role == "admin"
    if current_user.role == "admin":
        return True
    perms = _get_perms(current_user)
    if perms.get("can_delete_visits"):
        return True
    is_own = str(current_user.id) == str(visit_owner_id)
    if is_own:
        return perms.get("can_delete_own_visits", True) is not False
    return False


def _nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> Optional[date]:
    first_day = date(year, month, 1)
    offset = (weekday - first_day.weekday()) % 7
    first_occurrence = first_day + timedelta(days=offset)

    if n == 0:
        last_day = date(year, month, monthrange(year, month)[1])
        offset_back = (last_day.weekday() - weekday) % 7
        result = last_day - timedelta(days=offset_back)
        return result if result.month == month else None
    else:
        result = first_occurrence + timedelta(weeks=n - 1)
        return result if result.month == month else None


def _generate_smart_recurrence(
    base_date_str: str,
    recurrence: RecurrencePattern,
    end_date_str: str,
    weekday: Optional[int] = None,
    week_number: Optional[int] = None,
) -> List[date]:
    if recurrence == "none" or not end_date_str:
        return []
    try:
        base_date = date.fromisoformat(base_date_str)
        end_date  = date.fromisoformat(end_date_str[:10])
    except (ValueError, TypeError):
        return []

    hard_cap = base_date + timedelta(days=366)
    end_date  = min(end_date, hard_cap)
    dates: List[date] = []

    if recurrence == "weekly":
        current = base_date + timedelta(weeks=1)
        while current <= end_date:
            dates.append(current)
            current += timedelta(weeks=1)

    elif recurrence == "biweekly":
        current = base_date + timedelta(weeks=2)
        while current <= end_date:
            dates.append(current)
            current += timedelta(weeks=2)

    elif recurrence == "monthly":
        month_offset = 1
        while True:
            year  = base_date.year + (base_date.month - 1 + month_offset) // 12
            month = (base_date.month - 1 + month_offset) % 12 + 1
            max_day = monthrange(year, month)[1]
            day = min(base_date.day, max_day)
            d = date(year, month, day)
            if d > end_date:
                break
            dates.append(d)
            month_offset += 1
            if month_offset > 120:
                break

    elif recurrence in ("nth_weekday", "last_weekday"):
        if weekday is None:
            return []
        n = 0 if recurrence == "last_weekday" else (week_number or 1)
        month_offset = 1
        while True:
            year  = base_date.year + (base_date.month - 1 + month_offset) // 12
            month = (base_date.month - 1 + month_offset) % 12 + 1
            d = _nth_weekday_of_month(year, month, weekday, n)
            if d is None:
                month_offset += 1
                if month_offset > 120:
                    break
                continue
            if d > end_date:
                break
            if d > base_date:
                dates.append(d)
            month_offset += 1
            if month_offset > 120:
                break

    return sorted(set(dates))


def _expand_recurrence(base, recurrence, end_date_str, weekday=None, week_number=None):
    if recurrence == "none" or not end_date_str:
        return []
    generated_dates = _generate_smart_recurrence(
        base["visit_date"], recurrence, end_date_str, weekday, week_number
    )
    parent_id = base["id"]
    children  = []
    for d in generated_dates:
        child = {**base}
        child["id"]                      = str(uuid.uuid4())
        child["visit_date"]              = d.isoformat()
        child["status"]                  = "scheduled"
        child["parent_visit_id"]         = parent_id
        child["recurrence"]              = recurrence
        child["recurrence_end_date"]     = end_date_str
        child["recurrence_weekday"]      = weekday
        child["recurrence_week_number"]  = week_number
        child["created_at"]              = base["created_at"]
        child["updated_at"]              = base["created_at"]
        child["comments"]                = []
        child["outcome"]                 = None
        child["follow_up_date"]          = None
        children.append(child)
    return children


async def _check_duplicate(client_id, assigned_to, visit_date, exclude_id=None):
    query = {
        "client_id":   client_id,
        "assigned_to": assigned_to,
        "visit_date":  visit_date,
        "status":      {"$nin": ["cancelled"]},
    }
    if exclude_id:
        query["id"] = {"$ne": exclude_id}
    return await db.visits.find_one(query, {"_id": 0, "id": 1, "purpose": 1, "status": 1})


async def _enrich_visits(visits: list) -> list:
    if not visits:
        return visits
    uid_set = set()
    for v in visits:
        if v.get("assigned_to"):
            uid_set.add(str(v["assigned_to"]))
        if v.get("created_by"):
            uid_set.add(str(v["created_by"]))
    uid_set.discard(None)

    user_map = {}
    if uid_set:
        users_raw = await db.users.find(
            {"id": {"$in": list(uid_set)}},
            {"_id": 0, "id": 1, "full_name": 1, "profile_picture": 1},
        ).to_list(500)
        user_map = {u["id"]: u for u in users_raw}

    for v in visits:
        au = user_map.get(str(v.get("assigned_to", "")), {})
        cu = user_map.get(str(v.get("created_by", "")), {})
        v["assigned_to_name"]    = au.get("full_name", "Unknown")
        v["assigned_to_picture"] = au.get("profile_picture")
        v["created_by_name"]     = cu.get("full_name", "Unknown")

    return visits


def _build_date_filter(month, from_date, to_date):
    date_filter: dict = {}
    if month:
        try:
            year, mon = int(month[:4]), int(month[5:7])
            first_day = date(year, mon, 1).isoformat()
            if mon == 12:
                last_day = date(year + 1, 1, 1) - timedelta(days=1)
            else:
                last_day = date(year, mon + 1, 1) - timedelta(days=1)
            date_filter["$gte"] = first_day
            date_filter["$lte"] = last_day.isoformat() if not isinstance(last_day, str) else last_day
        except (ValueError, TypeError, AttributeError):
            pass
    if from_date:
        if "$gte" not in date_filter or from_date > date_filter["$gte"]:
            date_filter["$gte"] = from_date
    if to_date:
        if "$lte" not in date_filter or to_date < date_filter["$lte"]:
            date_filter["$lte"] = to_date
    return date_filter if date_filter else None


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTES — ALL STATIC PATHS FIRST, PARAMETERISED LAST
# ═══════════════════════════════════════════════════════════════════════════════

# ── 1. CREATE ─────────────────────────────────────────────────────────────────
@router.post("", status_code=201)
async def create_visit(
    data: VisitCreate,
    current_user: User = Depends(get_current_user),
):
    # SIMPLIFIED: any user can create a visit for themselves
    # Only needs special permission to create for OTHER users
    if str(data.assigned_to) != str(current_user.id):
        if not _can_write_visit(current_user, data.assigned_to):
            raise HTTPException(403, "Not authorised to create visits for other users")

    existing = await _check_duplicate(data.client_id, data.assigned_to, data.visit_date)
    if existing:
        raise HTTPException(
            409,
            f"A visit for this client on {data.visit_date} is already scheduled "
            f"(id={existing['id']}, status={existing.get('status', 'scheduled')}). "
            "Cancel the existing visit or choose a different date."
        )

    now_iso  = datetime.now(timezone.utc).isoformat()
    visit_id = str(uuid.uuid4())

    visit_doc = {
        "id":                      visit_id,
        "client_id":               data.client_id,
        "client_name":             data.client_name or "",
        "assigned_to":             data.assigned_to,
        "created_by":              str(current_user.id),
        "visit_date":              data.visit_date,
        "visit_time":              data.visit_time,
        "purpose":                 data.purpose,
        "services":                data.services or [],
        "priority":                data.priority,
        "status":                  "scheduled",
        "notes":                   data.notes,
        "location":                data.location,
        "recurrence":              data.recurrence,
        "recurrence_end_date":     data.recurrence_end_date,
        "recurrence_weekday":      data.recurrence_weekday,
        "recurrence_week_number":  data.recurrence_week_number,
        "parent_visit_id":         None,
        "outcome":                 None,
        "follow_up_date":          None,
        "comments":                [],
        "source":                  "manual",
        "created_at":              now_iso,
        "updated_at":              now_iso,
    }

    await db.visits.insert_one(visit_doc)
    visit_doc.pop("_id", None)

    children = _expand_recurrence(
        visit_doc, data.recurrence, data.recurrence_end_date,
        data.recurrence_weekday, data.recurrence_week_number,
    )

    if children:
        filtered = []
        for child in children:
            dup = await _check_duplicate(child["client_id"], child["assigned_to"], child["visit_date"])
            if not dup:
                filtered.append(child)
        if filtered:
            await db.visits.insert_many(filtered)
            for c in filtered:
                c.pop("_id", None)
        children = filtered

    logger.info(f"Visit created: id={visit_id} by={current_user.id} children={len(children)}")
    return {**visit_doc, "recurring_count": len(children)}


# ── 2. LIST ────────────────────────────────────────────────────────────────────
@router.get("")
@router.get("/", include_in_schema=False)
async def list_visits(
    user_id:   Optional[str] = Query(None),
    client_id: Optional[str] = Query(None),
    month:     Optional[str] = Query(None),
    status:    Optional[str] = Query(None),
    priority:  Optional[str] = Query(None),
    source:    Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date:   Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    query: dict = {}

    if current_user.role == "admin":
        if user_id:
            query["assigned_to"] = user_id

    elif current_user.role == "manager":
        # SCOPE: OWN + SAME-DEPARTMENT TEAM (Own + Team)
        # Manager sees own visits + all staff in the same department(s)
        # can_view_all_visits=True overrides to see all (admin-granted escalation)
        perms   = _get_perms(current_user)
        allowed = [str(x) for x in (perms.get("view_other_visits") or []) if x is not None]

        if perms.get("can_view_all_visits"):
            # Admin-granted: see all visits in the system
            if user_id:
                query["assigned_to"] = user_id
        else:
            # Default manager scope: own + same-department team + explicit cross-vis list
            team_ids = await get_team_user_ids(current_user.id)
            visible  = list(set([str(current_user.id)] + team_ids + allowed))
            if user_id:
                if user_id not in visible:
                    raise HTTPException(403, "Not authorised to view this user's visits")
                query["assigned_to"] = user_id
            else:
                query["assigned_to"] = {"$in": visible}

    else:
        # STAFF SCOPE: OWN + explicit cross-vis list only
        perms   = _get_perms(current_user)
        allowed = [str(x) for x in (perms.get("view_other_visits") or []) if x is not None]
        if perms.get("can_view_all_visits"):
            # Admin-granted universal access for this staff member
            if user_id:
                query["assigned_to"] = user_id
        elif user_id:
            if user_id != str(current_user.id) and user_id not in allowed:
                raise HTTPException(403, "Not authorised to view this user's visits")
            query["assigned_to"] = user_id
        else:
            visible = list(set([str(current_user.id)] + allowed))
            query["assigned_to"] = {"$in": visible}

    if client_id:
        query["client_id"] = client_id
    if status:
        query["status"] = status
    if priority:
        query["priority"] = priority
    if source:
        query["source"] = source

    date_filter = _build_date_filter(month, from_date, to_date)
    if date_filter:
        query["visit_date"] = date_filter

    try:
        raw_visits = (
            await db.visits.find(query, {"_id": 0})
            .sort("visit_date", 1)
            .to_list(2000)
        )
    except Exception as e:
        logger.error(f"list_visits DB error: {e}", exc_info=True)
        raise HTTPException(500, f"Failed to fetch visits: {str(e)}")

    # SANITIZE every document — prevents React crash from null fields
    visits = []
    for v in raw_visits:
        try:
            sanitized = _sanitize_visit(v)
            # Skip documents that are completely broken (no date possible)
            if sanitized.get("id") and sanitized.get("visit_date"):
                visits.append(sanitized)
        except Exception as e:
            logger.warning(f"Skipping corrupt visit document: {e}")
            continue

    visits = await _enrich_visits(visits)
    return visits


# ── 3. SUMMARY (static, before /{visit_id}) ───────────────────────────────────
@router.get("/summary")
async def visit_summary(
    user_id: Optional[str] = Query(None),
    month:   Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    target_uid = user_id or str(current_user.id)
    # For manager scope, pre-fetch team IDs so _can_read_visit can validate team members
    team_ids = await get_team_user_ids(current_user.id) if current_user.role == "manager" else []
    if not _can_read_visit(current_user, target_uid, team_ids):
        raise HTTPException(403, "Not authorised")

    now   = datetime.now(IST)
    month = month or now.strftime("%Y-%m")

    date_filter = _build_date_filter(month, None, None)
    db_query    = {"assigned_to": target_uid}
    if date_filter:
        db_query["visit_date"] = date_filter

    visits = await db.visits.find(
        db_query, {"_id": 0, "status": 1, "priority": 1},
    ).to_list(1000)

    total        = len(visits)
    by_status:   dict = {}
    by_priority: dict = {}
    for v in visits:
        s = v.get("status", "scheduled")
        p = v.get("priority", "medium")
        by_status[s]   = by_status.get(s, 0) + 1
        by_priority[p] = by_priority.get(p, 0) + 1

    return {
        "month":           month,
        "user_id":         target_uid,
        "total":           total,
        "by_status":       by_status,
        "by_priority":     by_priority,
        "completion_rate": round(by_status.get("completed", 0) / total * 100, 1) if total else 0,
    }


# ── 4. UPCOMING (static) ──────────────────────────────────────────────────────
@router.get("/upcoming")
async def upcoming_visits(
    days: int = Query(7, ge=1, le=60),
    current_user: User = Depends(get_current_user),
):
    today    = date.today()
    end_date = today + timedelta(days=days)
    perms    = _get_perms(current_user)
    allowed  = [str(x) for x in (perms.get("view_other_visits") or []) if x is not None]

    if current_user.role == "admin":
        query: dict = {}
    else:
        # SCOPE: OWN + CROSS-VISIBILITY only (same for Manager and Staff)
        visible = list(set([str(current_user.id)] + allowed))
        query   = {"assigned_to": {"$in": visible}}

    query["visit_date"] = {"$gte": today.isoformat(), "$lte": end_date.isoformat()}
    query["status"]     = {"$in": ["scheduled", "rescheduled"]}

    visits = (
        await db.visits.find(query, {"_id": 0})
        .sort("visit_date", 1)
        .to_list(50)
    )

    visits = [_sanitize_visit(v) for v in visits]
    visits = await _enrich_visits(visits)
    for v in visits:
        try:
            v["days_until"] = (date.fromisoformat(v["visit_date"]) - today).days
        except (ValueError, TypeError):
            v["days_until"] = None
    return visits


# ── 5. BULK SCHEDULE (static) ─────────────────────────────────────────────────
@router.post("/bulk-schedule", status_code=201)
async def bulk_schedule(
    payload: BulkSchedulePayload,
    current_user: User = Depends(get_current_user),
):
    # Any user can bulk-schedule for themselves
    if str(payload.assigned_to) != str(current_user.id):
        if not _can_write_visit(current_user, payload.assigned_to):
            raise HTTPException(403, "Not authorised")

    now_iso    = datetime.now(timezone.utc).isoformat()
    docs       = []
    duplicates = []

    for d in payload.visit_dates:
        try:
            date.fromisoformat(str(d)[:10])
        except (ValueError, TypeError):
            continue

        dup = await _check_duplicate(payload.client_id, payload.assigned_to, str(d)[:10])
        if dup:
            duplicates.append(str(d)[:10])
            continue

        docs.append({
            "id":                      str(uuid.uuid4()),
            "client_id":               payload.client_id,
            "client_name":             payload.client_name or "",
            "assigned_to":             payload.assigned_to,
            "created_by":              str(current_user.id),
            "visit_date":              str(d)[:10],
            "visit_time":              None,
            "purpose":                 payload.purpose,
            "services":                payload.services or [],
            "priority":                payload.priority,
            "status":                  "scheduled",
            "notes":                   payload.notes,
            "location":                payload.location,
            "recurrence":              "none",
            "recurrence_end_date":     None,
            "recurrence_weekday":      None,
            "recurrence_week_number":  None,
            "parent_visit_id":         None,
            "outcome":                 None,
            "follow_up_date":          None,
            "comments":                [],
            "source":                  "manual",
            "created_at":              now_iso,
            "updated_at":              now_iso,
        })

    if docs:
        await db.visits.insert_many(docs)
        for d in docs:
            d.pop("_id", None)

    return {"created": len(docs), "skipped_duplicates": duplicates, "visits": docs}


# ── 6. BULK DELETE (static) ───────────────────────────────────────────────────
@router.post("/bulk-delete")
async def bulk_delete_visits(
    payload: BulkDeletePayload,
    current_user: User = Depends(get_current_user),
):
    if not payload.visit_ids:
        raise HTTPException(400, "No visit IDs provided")

    result = BulkDeleteResult(total_requested=len(payload.visit_ids))

    visits_cursor = db.visits.find(
        {"id": {"$in": payload.visit_ids}},
        {"_id": 0, "id": 1, "assigned_to": 1, "parent_visit_id": 1},
    )
    visits = await visits_cursor.to_list(length=len(payload.visit_ids))
    visit_map = {v["id"]: v for v in visits}

    found_ids        = set(visit_map.keys())
    result.not_found = [vid for vid in payload.visit_ids if vid not in found_ids]

    ids_to_delete: List[str] = []

    for vid, visit in visit_map.items():
        owner_id = visit.get("assigned_to", "")
        if _can_delete_visit(current_user, owner_id):
            ids_to_delete.append(vid)
            if payload.delete_recurrences and visit.get("parent_visit_id") is None:
                children = await db.visits.find(
                    {"parent_visit_id": vid}, {"_id": 0, "id": 1},
                ).to_list(1000)
                for child in children:
                    child_id = child.get("id")
                    if child_id and child_id not in ids_to_delete:
                        ids_to_delete.append(child_id)
        else:
            result.forbidden.append(vid)

    if ids_to_delete:
        delete_result = await db.visits.delete_many({"id": {"$in": ids_to_delete}})
        result.total_deleted = delete_result.deleted_count
        result.deleted = ids_to_delete

    logger.info(
        f"bulk_delete: user={current_user.id} deleted={result.total_deleted} "
        f"forbidden={len(result.forbidden)} not_found={len(result.not_found)}"
    )
    return result


# ── 7. FROM EMAIL (static) ────────────────────────────────────────────────────
@router.get("/from-email")
async def list_email_visits(
    month:  Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    query: dict = {
        "assigned_to": str(current_user.id),
        "source":      {"$in": ["email_auto", "email_manual"]},
    }
    if status:
        query["status"] = status
    date_filter = _build_date_filter(month, None, None)
    if date_filter:
        query["visit_date"] = date_filter

    visits = (
        await db.visits.find(query, {"_id": 0})
        .sort("visit_date", 1)
        .to_list(500)
    )
    visits = [_sanitize_visit(v) for v in visits]
    visits = await _enrich_visits(visits)
    return visits


# ── 8. CHECK DUPLICATE (static) ───────────────────────────────────────────────
@router.post("/check-duplicate")
async def check_duplicate_endpoint(
    data: DuplicateCheckPayload,
    current_user: User = Depends(get_current_user),
):
    existing = await _check_duplicate(data.client_id, data.assigned_to, data.visit_date)
    return {"is_duplicate": existing is not None, "existing": existing}


# ── 9. ADMIN MONTHLY PLAN (static) ────────────────────────────────────────────
@router.get("/admin/monthly-plan")
async def admin_monthly_plan(
    month: str = Query(...),
    current_user: User = Depends(require_admin()),
):
    date_filter = _build_date_filter(month, None, None)
    db_query    = {}
    if date_filter:
        db_query["visit_date"] = date_filter

    visits = (
        await db.visits.find(db_query, {"_id": 0})
        .sort([("assigned_to", 1), ("visit_date", 1)])
        .to_list(5000)
    )

    uid_set   = {v.get("assigned_to") for v in visits if v.get("assigned_to")}
    users_raw = await db.users.find(
        {"id": {"$in": list(uid_set)}},
        {"_id": 0, "id": 1, "full_name": 1},
    ).to_list(200)
    user_map = {u["id"]: u["full_name"] for u in users_raw}

    grouped: dict = {}
    for v in visits:
        uid  = v.get("assigned_to", "")
        name = user_map.get(uid, "Unknown")
        if uid not in grouped:
            grouped[uid] = {"user_id": uid, "user_name": name, "visits": [], "total": 0, "completed": 0}
        grouped[uid]["visits"].append(v)
        grouped[uid]["total"] += 1
        if v.get("status") == "completed":
            grouped[uid]["completed"] += 1

    return {"month": month, "users": list(grouped.values())}


# ── 10. QUICK STATUS (parameterised, but BEFORE generic GET /{visit_id}) ──────
@router.post("/{visit_id}/quick-status")
async def quick_status(
    visit_id: str,
    data: dict,
    current_user: User = Depends(get_current_user),
):
    # FIX: use _find_visit_by_any_id to handle legacy docs
    visit = await _find_visit_by_any_id(visit_id)
    if not visit:
        raise HTTPException(404, f"Visit not found: id={visit_id}")

    owner_id = visit.get("assigned_to", "")
    if not _can_write_visit(current_user, owner_id):
        raise HTTPException(403, "Not authorised to update this visit")

    done    = bool(data.get("done", True))
    now_iso = datetime.now(timezone.utc).isoformat()
    payload = {
        "status":     "completed" if done else "missed",
        "updated_at": now_iso,
    }
    if done:
        payload["completed_at"] = now_iso

    # Update by the actual string id (which may have been repaired)
    real_id = visit.get("id", visit_id)
    await db.visits.update_one({"id": real_id}, {"$set": payload})
    updated = await db.visits.find_one({"id": real_id}, {"_id": 0})
    if updated:
        updated = _sanitize_visit(updated)

    logger.info(f"quick_status: visit={real_id} done={done} by={current_user.id}")
    return updated


# ── 11. ADD COMMENT ────────────────────────────────────────────────────────────
@router.post("/{visit_id}/comments", status_code=201)
async def add_comment(
    visit_id: str,
    data: CommentCreate,
    current_user: User = Depends(get_current_user),
):
    visit = await _find_visit_by_any_id(visit_id)
    if not visit:
        raise HTTPException(404, f"Visit not found: id={visit_id}")
    team_ids = await get_team_user_ids(current_user.id) if current_user.role == "manager" else []
    if not _can_read_visit(current_user, visit.get("assigned_to", ""), team_ids):
        raise HTTPException(403, "Not authorised")

    comment = {
        "id":         str(uuid.uuid4()),
        "user_id":    str(current_user.id),
        "user_name":  current_user.full_name,
        "text":       data.text,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    real_id = visit.get("id", visit_id)
    await db.visits.update_one(
        {"id": real_id},
        {
            "$push": {"comments": comment},
            "$set":  {"updated_at": comment["created_at"]},
        },
    )
    return comment


# ── 12. DELETE COMMENT ─────────────────────────────────────────────────────────
@router.delete("/{visit_id}/comments/{comment_id}")
async def delete_comment(
    visit_id:   str,
    comment_id: str,
    current_user: User = Depends(get_current_user),
):
    visit = await _find_visit_by_any_id(visit_id)
    if not visit:
        raise HTTPException(404, f"Visit not found: id={visit_id}")

    comment = next(
        (c for c in (visit.get("comments") or []) if c.get("id") == comment_id),
        None,
    )
    if not comment:
        raise HTTPException(404, "Comment not found")

    if str(comment.get("user_id")) != str(current_user.id) and current_user.role != "admin":
        raise HTTPException(403, "Can only delete your own comments")

    real_id = visit.get("id", visit_id)
    await db.visits.update_one(
        {"id": real_id},
        {"$pull": {"comments": {"id": comment_id}}},
    )
    return {"message": "Comment deleted"}


# ── 13. GET SINGLE (parameterised) ────────────────────────────────────────────
@router.get("/{visit_id}")
async def get_visit(
    visit_id: str,
    current_user: User = Depends(get_current_user),
):
    visit = await _find_visit_by_any_id(visit_id)
    if not visit:
        raise HTTPException(404, f"Visit not found: id={visit_id}")
    team_ids = await get_team_user_ids(current_user.id) if current_user.role == "manager" else []
    if not _can_read_visit(current_user, visit.get("assigned_to", ""), team_ids):
        raise HTTPException(403, "Not authorised")

    visit = (await _enrich_visits([visit]))[0]

    client_id = visit.get("client_id")
    if client_id:
        try:
            client = await db.clients.find_one(
                {"id": client_id},
                {"_id": 0, "company_name": 1, "phone": 1, "email": 1},
            )
            visit["client_info"] = client or {}
        except Exception:
            visit["client_info"] = {}
    else:
        visit["client_info"] = {}

    return visit


# ── 14. UPDATE (parameterised) ────────────────────────────────────────────────
@router.patch("/{visit_id}")
async def update_visit(
    visit_id: str,
    data: VisitUpdate,
    current_user: User = Depends(get_current_user),
):
    visit = await _find_visit_by_any_id(visit_id)
    if not visit:
        raise HTTPException(404, f"Visit not found: id={visit_id}")

    owner_id = visit.get("assigned_to", "")
    if not _can_write_visit(current_user, owner_id):
        raise HTTPException(403, "Not authorised to edit this visit")

    new_date = data.visit_date
    if new_date and new_date != visit.get("visit_date"):
        real_id = visit.get("id", visit_id)
        dup = await _check_duplicate(
            visit["client_id"], visit["assigned_to"], new_date, exclude_id=real_id
        )
        if dup:
            raise HTTPException(
                409,
                f"A visit for this client on {new_date} already exists. "
                "Choose a different date or cancel the existing visit first."
            )

    payload = {k: v for k, v in data.model_dump(exclude_none=True).items()}
    payload["updated_at"] = datetime.now(timezone.utc).isoformat()

    real_id = visit.get("id", visit_id)
    await db.visits.update_one({"id": real_id}, {"$set": payload})
    updated = await db.visits.find_one({"id": real_id}, {"_id": 0})
    if updated:
        updated = _sanitize_visit(updated)
    return updated


# ── 15. DELETE (parameterised, LAST) ──────────────────────────────────────────
@router.delete("/{visit_id}")
async def delete_visit(
    visit_id: str,
    delete_recurrences: bool = Query(False),
    current_user: User = Depends(get_current_user),
):
    visit = await _find_visit_by_any_id(visit_id)
    if not visit:
        raise HTTPException(
            404,
            f"Visit not found (id={visit_id}). It may have already been deleted."
        )

    owner_id = visit.get("assigned_to", "")
    if not _can_delete_visit(current_user, owner_id):
        raise HTTPException(
            403,
            "Not authorised to delete this visit. "
            "Only the assigned user or an admin can delete visits."
        )

    real_id       = visit.get("id", visit_id)
    deleted_count = 0

    result = await db.visits.delete_one({"id": real_id})
    deleted_count += result.deleted_count if result else 0

    if deleted_count == 0:
        # Last resort: try by MongoDB _id
        try:
            from bson import ObjectId
            result = await db.visits.delete_one({"_id": ObjectId(visit_id)})
            deleted_count += result.deleted_count if result else 0
        except Exception:
            pass

    if delete_recurrences and visit.get("parent_visit_id") is None:
        recurrence_result = await db.visits.delete_many({"parent_visit_id": real_id})
        deleted_count += recurrence_result.deleted_count

    logger.info(
        f"delete_visit: id={real_id} deleted={deleted_count} "
        f"cascade={delete_recurrences} by={current_user.id}"
    )

    return {
        "message":       f"Deleted {deleted_count} visit(s) successfully",
        "deleted_count": deleted_count,
        "visit_id":      real_id,
    }
