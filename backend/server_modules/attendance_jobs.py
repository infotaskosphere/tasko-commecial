from __future__ import annotations
import os
import asyncio
import logging
import uuid
from datetime import datetime, date, time, timedelta, timezone
from typing import Optional
import pytz
from zoneinfo import ZoneInfo
from fastapi import HTTPException
from backend.dependencies import db
from backend.tenant_runtime import system_context
logger=logging.getLogger(__name__)
IST=pytz.timezone("Asia/Kolkata")
india_tz=ZoneInfo("Asia/Kolkata")
_event_loop=None

def configure_event_loop(loop):
    global _event_loop
    _event_loop=loop

async def create_task_assigned_popup(assigned_to_user_id: str, task_title: str) -> None:
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        await db.reminders.insert_one({
            "user_id": str(assigned_to_user_id),
            "title": "New Task Assigned",
            "description": f"You have been assigned a new task: \"{task_title}\".",
            "remind_at": now_iso,
            "event_id": f"task-assigned-{uuid.uuid4()}",
            "source": "task",
            "priority": "high",
            "reminder_type": "task_assigned",
            "related_task_id": None,
            "is_dismissed": False,
            "is_fired": False,
            "created_at": now_iso,
            "updated_at": now_iso,
        })
    except Exception as e:
        logger.error(
            f"[Popup] Failed to create task-assigned popup for {assigned_to_user_id}: {e}"
        )
from backend.email_integration import router as email_router
from backend.trademark_sphere import router as trademark_sphere_router
from backend.trademark_portals_router import router as trademark_portals_router

# Gemini AI instance (already configured in email_integration module)
try:
    from backend.email_integration import _gemini as _gemini_ai
except ImportError:
    _gemini_ai = None
from backend.passwords import router as passwords_router
from backend.auth_password_reset import router as auth_password_reset_router
from backend.client_portal import router as client_portal_router
from backend.activity_monitor import router as activity_monitor_router
from backend.desktop_agent import router as desktop_agent_router, create_desktop_indexes
from backend.whatsapp_integration import router as whatsapp_router
from backend.whatsapp_scheduler import (
    wa_dsc_expiry_job,
    wa_compliance_job,
)
from backend.whatsapp_integration import wa_scheduled_bulk_job, wa_bridge_keepalive_job
from backend.automation_engine import (
    birthday_automation_job,
    festival_greeting_job,
    service_expiry_alert_job,
    follow_up_reminder_job,
)

from zoneinfo import ZoneInfo
from pathlib import Path
from io import StringIO, BytesIO
from typing import List, Optional, Dict, Any
from dateutil import parser
from contextlib import asynccontextmanager

# Single logger definition
logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# FastAPI
from fastapi import (
    FastAPI,
    APIRouter,
    Depends,
    HTTPException,
    status,
    BackgroundTasks,
    UploadFile,
    File,
    Form,
    Query,
    Request,
    Body,
)
from fastapi.security import HTTPBearer
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.gzip import GZipMiddleware
from passlib.context import CryptContext

# Validation
from pydantic import (
    BaseModel,
    EmailStr,
    Field,
    ConfigDict,
    field_validator,
    ValidationError,
)
from bson import ObjectId
from dotenv import load_dotenv

# --- BACKEND MODULE IMPORTS ---
import backend.models as models
from backend.models import (
    Token,
    User,
    UserCreate,
    UserLogin,
    UserPermissions,
    Todo,
    TodoCreate,
    Task,
    TaskCreate,
    BulkTaskCreate,
    Client,
    ClientCreate,
    MasterClientForm,
    Attendance,
    StaffActivityLog,
    StaffActivityCreate,
    PerformanceMetric,
    DueDate,
    DueDateCreate,
    DSC,
    DSCCreate,
    DSCListResponse,
    DSCMovementRequest,
    MovementUpdateRequest,
    Document,
    DocumentCreate,
    DocumentMovementRequest,
    DashboardStats,
    AuditLog,
    HolidayResponse,
    HolidayCreate,
    DEFAULT_ROLE_PERMISSIONS,
    Reminder,
    ReminderCreate,
    OffboardRequest,
)
from backend.tenant_runtime import system_context
from backend.dependencies import (
    db,
    client,
    get_current_user,
    create_access_token,
    check_permission,
    check_module_permission,
    assert_module_permission,
    assert_record_visibility,
    check_record_visibility,
    require_admin,
    require_manager_or_admin,
    verify_record_access,
    verify_client_access,
    can_view_client,
    get_team_user_ids,
    get_cross_visibility_union,
    get_user_permissions,   # moved to dependencies — single source of truth
    personal_birthday_candidates,
)

# External Services
from fpdf import FPDF
from apscheduler.schedulers.background import BackgroundScheduler

# ====================== CONFIG ======================
# Single IST definition
IST = pytz.timezone("Asia/Kolkata")
india_tz = ZoneInfo("Asia/Kolkata")

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# ── MCA Portal API config ─────────────────────────────────────────────────────
MCA_API_KEY = os.getenv("MCA_API_KEY", "")
MCA_API_BASE_URL = os.getenv("MCA_API_BASE_URL", "https://api.mca.gov.in/MCA21/api/v1")

# ── Main event loop reference (set at startup, used by APScheduler sync jobs) ─
app_event_loop = None

# ── Attendance proof upload directory ─────────────────────────────────────────
PROOF_UPLOAD_DIR = ROOT_DIR / "uploads" / "attendance_proof"
PROOF_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ====================== SECURITY CONFIG ===========================
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# ====================== SCHEDULER ======================
scheduler = BackgroundScheduler(timezone=pytz.timezone("Asia/Kolkata"))

# IN-MEMORY CACHE for daily reminder (avoids DB query on every request)
_last_reminder_date_cache: Optional[str] = None

# ====================== APP ======================
app = FastAPI(title="Taskosphere Backend", redirect_slashes=False)

# ====================== CORS CONFIG ======================
# Supports:
# - Taskosphere production domains
# - Vercel production and preview deployments
# - Render deployments
# - localhost development
# - Additional domains through CORS_ALLOWED_ORIGINS
#
# IMPORTANT:
# Do NOT use allow_origins=["*"] because credentials are enabled.

CORS_ALLOWED_ORIGINS = [
    # Taskosphere production
    "https://taskosphere.com",
    "https://www.taskosphere.com",

    # Vercel production frontend
    "https://tasko-commercial-frontend.vercel.app",

    # Render frontend / legacy frontend
    "https://final-taskosphere-frontend.onrender.com",

    # Local development
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
]


# --------------------------------------------------------
# Additional origins can be supplied through environment
# variable without modifying this file.
#
# Example:
# CORS_ALLOWED_ORIGINS=https://example.com,https://www.example.com
# --------------------------------------------------------

_extra_cors_origins = os.getenv("CORS_ALLOWED_ORIGINS", "")

if _extra_cors_origins:
    for origin in _extra_cors_origins.split(","):
        origin = origin.strip().rstrip("/")

        if origin and origin not in CORS_ALLOWED_ORIGINS:
            CORS_ALLOWED_ORIGINS.append(origin)


# --------------------------------------------------------
# Deployment / preview URL support
#
# Vercel:
# https://anything.vercel.app
#
# Render:
# https://anything.onrender.com
#
# Local:
# http://localhost:3000
# http://127.0.0.1:5173
# --------------------------------------------------------

CORS_ORIGIN_REGEX = (
    r"^https://[a-zA-Z0-9-]+\.vercel\.app$"
    r"|^https://[a-zA-Z0-9-]+\.onrender\.com$"
    r"|^http://localhost(?::[0-9]+)?$"
    r"|^http://127\.0\.0\.1(?::[0-9]+)?$"
)


# --------------------------------------------------------
# FastAPI CORS middleware
# --------------------------------------------------------

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ALLOWED_ORIGINS,
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)


# --------------------------------------------------------
# GZIP compression
# --------------------------------------------------------

app.add_middleware(
    GZipMiddleware,
    minimum_size=1000,
)


# =============================================================
# ABSENT MARKING CORE LOGIC
# Runs via APScheduler at 19:00 IST every working day.
# Also exposed as POST /api/attendance/mark-absent-bulk for
# manual admin triggering.
#
# Rules:
#   - Skip confirmed holidays
#   - Skip weekends (Saturday=5, Sunday=6)
#   - For every active user with no present/leave/absent record
#     insert a new absent record with auto_marked=True
#   - If a record exists but has an unexpected status update to absent
# =============================================================




async def _mark_absent_for_date(target_date_str: str, target_user_id: Optional[str] = None, actor_user_id: Optional[str] = None) -> dict:
    """Core absent-marking logic. Returns a summary dict."""
    # Skip confirmed holidays
    # FIX: {"_id": 0} projection — ObjectId causes issues if doc is returned
    holiday = await db.holidays.find_one(
        {"date": target_date_str, "status": "confirmed"}, {"_id": 0}
    )
    if holiday:
        return {
            "skipped": True,
            "reason": f"Holiday: {holiday.get('name')}",
            "marked": 0,
            "date": target_date_str,
        }

    # Skip weekends
    target_date_obj = date.fromisoformat(target_date_str)
    if target_date_obj.weekday() >= 5:
        return {
            "skipped": True,
            "reason": "Weekend",
            "marked": 0,
            "date": target_date_str,
        }

    # Targeted admin action: when target_user_id is supplied, ONLY that user
    # is touched. This path intentionally overrides an existing present/leave
    # record because the Admin explicitly selected "Mark Absent".
    if target_user_id:
        target_user = await db.users.find_one(
            {"id": target_user_id}, {"_id": 0, "id": 1, "full_name": 1, "is_active": 1, "status": 1}
        )
        if not target_user:
            raise HTTPException(status_code=404, detail="Selected employee not found")
        if target_user.get("is_active") is False or target_user.get("status") == "inactive":
            raise HTTPException(status_code=400, detail="Selected employee is inactive")

        existing = await db.attendance.find_one(
            {"user_id": target_user_id, "date": target_date_str}, {"_id": 0}
        )
        if existing and existing.get("status") == "absent":
            return {
                "skipped": True,
                "reason": f"{target_user.get('full_name') or 'Employee'} is already marked absent",
                "marked": 0,
                "date": target_date_str,
                "user_id": target_user_id,
                "user_name": target_user.get("full_name"),
                "already_recorded": 1,
            }

        now_iso = datetime.now(timezone.utc).isoformat()
        update_fields = {
            "status": "absent",
            "punch_in": None,
            "punch_out": None,
            "duration_minutes": 0,
            "is_late": False,
            "punched_out_early": False,
            "leave_reason": None,
            "leave_type": None,
            "is_half_day": False,
            "auto_marked": False,
            "auto_marked_at": None,
            "edited_by": actor_user_id,
            "edited_at": now_iso,
            "admin_note": "Admin marked absent",
        }
        await db.attendance.update_one(
            {"user_id": target_user_id, "date": target_date_str},
            {"$set": update_fields},
            upsert=True,
        )
        return {
            "skipped": False,
            "date": target_date_str,
            "marked": 1,
            "total_active_users": 1,
            "already_recorded": 0,
            "user_id": target_user_id,
            "user_name": target_user.get("full_name"),
            "previous_status": existing.get("status") if existing else None,
        }

    # Scheduled/bulk path — preserve the original rule of not overwriting
    # existing present/leave/absent records.
    active_users = await db.users.find(
        {"is_active": True, "status": "active"}, {"_id": 0, "id": 1, "full_name": 1}
    ).to_list(1000)

    marked_count = 0
    already_recorded = 0
    marked_user_name = None

    for u in active_users:
        uid = u["id"]
        marked_user_name = u.get("full_name") or marked_user_name
        existing = await db.attendance.find_one(
            {"user_id": uid, "date": target_date_str}, {"_id": 0}
        )

        if existing:
            if existing.get("status") in ("present", "leave", "absent"):
                already_recorded += 1
                continue
            # Record exists but status is unexpected → update to absent
            await db.attendance.update_one(
                {"user_id": uid, "date": target_date_str},
                {
                    "$set": {
                        "status": "absent",
                        "auto_marked": not bool(target_user_id),
                        "auto_marked_at": datetime.now(timezone.utc).isoformat(),
                    }
                },
            )
            marked_count += 1
        else:
            # No record at all → insert absent
            await db.attendance.insert_one(
                {
                    "user_id": uid,
                    "date": target_date_str,
                    "status": "absent",
                    "punch_in": None,
                    "punch_out": None,
                    "duration_minutes": 0,
                    "is_late": False,
                    "punched_out_early": False,
                    "leave_reason": None,
                    "auto_marked": not bool(target_user_id),
                    "auto_marked_at": datetime.now(timezone.utc).isoformat(),
                }
            )
            marked_count += 1

    logger.info(
        f"Absent marking for {target_date_str}: marked={marked_count}, skipped={already_recorded}, target={target_user_id or 'ALL'}"
    )
    return {
        "skipped": False,
        "date": target_date_str,
        "marked": marked_count,
        "total_active_users": len(active_users),
        "already_recorded": already_recorded,
        "user_id": target_user_id,
        "user_name": marked_user_name if target_user_id else None,
    }




def mark_absent_users_task():
    """
    Sync wrapper called by APScheduler at 19:00 IST every working day.
    Uses run_coroutine_threadsafe so Motor futures stay on the main event loop.
    """
    try:
        loop = _event_loop
        if loop is None or loop.is_closed():
            logger.warning(
                "mark_absent_users_task: main event loop not ready, skipping."
            )
            return
        today_str = datetime.now(IST).date().isoformat()
        with system_context():
            future = asyncio.run_coroutine_threadsafe(
                _mark_absent_for_date(today_str), loop
            )
        result = future.result(timeout=120)
        logger.info(f"Scheduled absent job result: {result}")
    except Exception as e:
        logger.error(f"mark_absent_users_task failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# AUTO PUNCH-OUT JOB — runs at 23:00 IST daily
# For every user who punched in today but never punched out,
# back-fills punch_out = 19:00 IST (7:00 PM) of that same day.
# ─────────────────────────────────────────────────────────────────────────────


async def _force_punch_out_at_7pm(today_str: str) -> dict:
    """
    Back-fill punch_out for all users who punched in today but have no
    punch_out recorded by 11:00 PM IST.
    Each user's punch_out is set to THEIR OWN punch_out_time from their
    user profile (defaults to 19:00 IST if not configured).
    """
    IST_tz = ZoneInfo("Asia/Kolkata")
    today_date = datetime.fromisoformat(today_str).date()

    # Find records: punched in, no punch_out, status present
    records = await db.attendance.find(
        {
            "date": today_str,
            "punch_in": {"$ne": None},
            "punch_out": None,
            "status": "present",
        },
        {"_id": 0, "user_id": 1, "punch_in": 1},
    ).to_list(1000)

    if not records:
        logger.info(f"force_punch_out_11pm: no open records for {today_str}")
        return {"patched": 0, "date": today_str}

    # Bulk-fetch all relevant user docs to get per-user punch_out_time
    user_ids = [r["user_id"] for r in records]
    user_docs = await db.users.find(
        {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "punch_out_time": 1}
    ).to_list(len(user_ids))
    user_map = {u["id"]: u for u in user_docs}

    patched = 0
    for rec in records:
        user_doc = user_map.get(rec["user_id"], {})

        # Resolve this user's configured shift-end time (default 19:00)
        pot_str = user_doc.get("punch_out_time") or "19:00"
        try:
            pot = datetime.strptime(pot_str, "%H:%M")
        except ValueError:
            pot = datetime.strptime("19:00", "%H:%M")

        # Build aware UTC datetime for that user's shift end today
        shift_end_ist = datetime(
            today_date.year,
            today_date.month,
            today_date.day,
            pot.hour,
            pot.minute,
            0,
            tzinfo=IST_tz,
        )
        shift_end_utc = shift_end_ist.astimezone(timezone.utc)

        # Normalise punch_in to aware UTC
        punch_in_dt = rec.get("punch_in")
        if isinstance(punch_in_dt, str):
            try:
                punch_in_dt = datetime.fromisoformat(punch_in_dt)
            except Exception:
                punch_in_dt = shift_end_utc
        if punch_in_dt and punch_in_dt.tzinfo is None:
            punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)

        duration_minutes = max(
            0,
            int(
                (shift_end_utc - punch_in_dt.astimezone(timezone.utc)).total_seconds()
                / 60
            ),
        )

        await db.attendance.update_one(
            {"user_id": rec["user_id"], "date": today_str},
            {
                "$set": {
                    "punch_out": shift_end_utc,
                    "duration_minutes": duration_minutes,
                    "punched_out_early": False,
                    "overtime_minutes": 0,
                    "auto_punch_out": True,
                    "auto_punch_reason": "force_11pm_scheduler",
                }
            },
        )
        patched += 1

    logger.info(f"force_punch_out_11pm: patched {patched} record(s) for {today_str}")
    return {"patched": patched, "date": today_str}




def force_punch_out_11pm_task():
    """
    Sync wrapper called by APScheduler at 23:00 IST every day.
    Uses run_coroutine_threadsafe so Motor futures stay on the main event loop.
    """
    try:
        loop = _event_loop
        if loop is None or loop.is_closed():
            logger.warning(
                "force_punch_out_11pm_task: main event loop not ready, skipping."
            )
            return
        today_str = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
        with system_context():
            future = asyncio.run_coroutine_threadsafe(
                _force_punch_out_at_7pm(today_str), loop
            )
        result = future.result(timeout=120)
        logger.info(f"force_punch_out_11pm job result: {result}")
    except Exception as e:
        logger.error(f"force_punch_out_11pm_task failed: {e}")

