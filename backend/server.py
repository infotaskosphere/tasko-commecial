import os
import re
import csv
import uuid
import json
import base64
import hashlib
import hmac
import secrets
import logging
import pytz
import traceback
import asyncio
import calendar
import requests
import httpx
import shutil
import pandas as pd
from datetime import datetime, date, timezone, timedelta, time as dtime
from collections import Counter

# --- FIXED ROUTER IMPORTS ---
# Added 'backend.' to invoicing to match the others
from backend.quickcompany_trademark_router import router as qc_trademark_router
from backend.whatsapp_hub import router as whatsapp_hub_router
from backend.compliance import router as compliance_router, create_compliance_indexes
from backend.roc_sphere import router as roc_sphere_router  # ROC Sphere: Companies Act document automation
from backend.salary_slip_router import router as salary_slip_router, create_salary_slip_indexes
from backend.ai_document_reader import router as ai_document_reader_router
from backend.gst_reconciliation import router as gst_reconciliation_router
from backend.mis_report import router as mis_report_router
from backend.gst_reconciliation import create_gst_reconciliation_indexes
from backend.zero_touch_entry import router as zero_touch_entry_router, create_zte_indexes
from backend.learning.learning_router import router as learning_router
from backend.gst_portal_sync import router as gst_portal_sync_router, create_gst_portal_sync_indexes
from backend.accounting_lock import router as accounting_lock_router, create_accounting_integrity_indexes
from backend.reminders_router import router as reminders_router
from backend.quotations import router as quotation_router
from backend.purchases import router as purchases_router
from backend.attendance_identix import identix_router
from backend.google_auth import router as google_auth_router
from backend.website_tracking import router as website_tracking_router
from backend.invoicing import router as invoicing_router
from backend.accounting_core import router as accounting_router
from backend.party_ledgers import router as party_ledgers_router
from backend.accounting_extended import router as accounting_ext_router
from backend.accounting_extended import create_accounting_extended_indexes
from backend.bank_accounts import router as bank_accounts_router
from backend.permission_governance import router as permission_governance_router
from backend.roles_admin import router as roles_admin_router
from backend.governed_modules import ALL_GOVERNED_ROUTERS
from backend.security.rate_limiter import RateLimiter
from backend.security.audit_security import AuditSecurity
from backend.security.session_manager import SessionManager
from backend.security.security_monitor import SecurityMonitor
from backend.visits import router as visits_router
from backend.leads import router as leads_router
from backend.client_activity import router as client_activity_router
from backend.automation_engine import router as automation_router, expiry_router as service_expiry_router
from backend.recruitment import (
    router as recruitment_router,
    list_candidates as recruitment_list_candidates,
)
from backend.telegram import router as telegram_router
from backend.notifications import router as notification_router, create_notification, notify_admins_leave


# ─────────────────────────────────────────────────────────────────────────────
# Task-assigned popup helper
# Inserts a manual reminder with remind_at = now so the assignee gets an
# immediate on-screen popup the next time the frontend polls
# GET /api/reminders/due-popups.
#
# NOTE: This previously lived in backend/reminders_router.py, which became an
# accidental duplicate of this file and caused a circular-import crash on
# boot. It now lives here and reminders_router.py is a thin shim.
# ─────────────────────────────────────────────────────────────────────────────
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

# === CRITICAL: CORS MUST BE THE VERY FIRST MIDDLEWARE ===
# Registered BEFORE startup_event and all other middleware.
# When the Render free-tier backend is sleeping (cold start), it returns no
# headers at all — the browser shows "No Access-Control-Allow-Origin". This is
# NOT a CORS misconfiguration; it is a cold-start timing issue. Keeping CORS
# registered first ensures that once the server wakes, the headers are correct.
#
# allow_origin_regex also covers any Render preview-deploy URL
# (*.onrender.com) so staging branches don't need separate config updates.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "https://taskosphere.com",
        "https://www.taskosphere.com",
        "https://final-taskosphere-frontend.onrender.com",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:3000",
    ],
    allow_origin_regex=r"https://.*\.onrender\.com",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
    max_age=3600,
)
app.add_middleware(GZipMiddleware, minimum_size=1000)


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
        import backend.server as _self

        loop = _self.app_event_loop
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
        import backend.server as _self

        loop = _self.app_event_loop
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


@app.on_event("startup")
async def startup_event():
    import backend.server as _self

    _self.app_event_loop = asyncio.get_event_loop()
    try:
        await db.tasks.create_index("assigned_to")
        # ── Activity Timeline & Automation Engine indexes ──────────────────
        await db.client_activities.create_index([("client_id", 1), ("created_at", -1)])
        await db.pending_client_messages.create_index([("status", 1), ("created_at", -1)])
        await db.service_expiries.create_index("client_id")
        await db.service_expiries.create_index("expiry_date")
        await create_compliance_indexes()
        await create_salary_slip_indexes()
        await create_gst_reconciliation_indexes()
        try:
            await db.mis_transactions.create_index([("client_id", 1), ("period", 1), ("doc_type", 1)])
            await db.mis_uploads.create_index([("client_id", 1), ("period", 1)])
            await db.mis_manual.create_index([("client_id", 1), ("period", 1)], unique=True)
        except Exception as _mis_idx_err:
            logger.warning(f"MIS index creation skipped: {_mis_idx_err}")
        await create_zte_indexes()
        
        # --- PHASE 10 SELF-LEARNING INDEXES ---
        try:
            await db.knowledge_base.create_index([("company_id", 1), ("category", 1), ("key", 1)], unique=True)
            await db.learning_events.create_index([("company_id", 1), ("created_at", -1)])
            await db.manual_corrections.create_index([("company_id", 1), ("created_at", -1)])
            await db.recommendation_history.create_index([("company_id", 1), ("status", 1)])
            await db.embeddings.create_index([("target_id", 1), ("target_type", 1)])
            await db.learning_versions.create_index([("entity_id", 1), ("entity_type", 1)])
            await db.learning_queue.create_index([("status", 1), ("created_at", 1)])
            await db.learning_audit.create_index([("company_id", 1), ("timestamp", -1)])
            logger.info("Phase 10 Self-Learning MongoDB indexes built.")
        except Exception as e_idx10:
            logger.warning(f"Phase 10 index creation warning: {e_idx10}")

        # --- PHASE 11 ENTERPRISE AUTOMATION INDEXES ---
        try:
            await db.workflow_definitions.create_index([("company_id", 1), ("category", 1)])
            await db.workflow_definitions.create_index("id", unique=True, background=True)
            await db.workflow_instances.create_index([("company_id", 1), ("status", 1)])
            await db.workflow_instances.create_index("id", unique=True, background=True)
            await db.workflow_history.create_index([("company_id", 1), ("instance_id", 1)])
            await db.workflow_templates.create_index("id", unique=True, background=True)
            await db.approval_requests.create_index([("company_id", 1), ("status", 1)])
            await db.approval_requests.create_index("id", unique=True, background=True)
            await db.approval_history.create_index([("company_id", 1), ("approval_id", 1)])
            await db.automation_rules.create_index([("company_id", 1), ("is_active", 1)])
            await db.business_events.create_index([("company_id", 1), ("event_type", 1)])
            await db.notification_history.create_index([("company_id", 1), ("user_id", 1)])
            await db.dashboard_cache.create_index("id", unique=True, background=True)
            await db.analytics_data.create_index("company_id")
            await db.kpi_history.create_index("company_id")
            await db.workflow_audit.create_index([("company_id", 1), ("action", 1)])
            logger.info("Phase 11 Enterprise Automation MongoDB indexes built.")
        except Exception as e_idx11:
            logger.warning(f"Phase 11 index creation warning: {e_idx11}")

        # AI Memory Foundation indexes
        await db.ai_document_memory.create_index("fingerprint")
        await db.ai_document_memory.create_index("vendor_gstin")
        await db.ai_document_memory.create_index("invoice_number")
        await db.ai_document_memory.create_index("vendor_name")
        await db.ai_document_memory.create_index("created_at")
        await create_gst_portal_sync_indexes()
        await create_accounting_integrity_indexes()
        await create_accounting_extended_indexes()
        await db.tasks.create_index("created_by")
        await db.tasks.create_index("due_date")
        await db.users.create_index("email")
        await db.staff_activity.create_index("user_id")
        await db.staff_activity.create_index("timestamp")
        await db.staff_activity.create_index([("user_id", 1), ("timestamp", -1)])
        await db.due_dates.create_index("department")
        await create_desktop_indexes()
        await db.tasks.create_index([("assigned_to", 1), ("status", 1)])
        await db.tasks.create_index("created_at")
        await db.referrers.create_index("name")
        await db.clients.create_index("assigned_to")
        # Performance: faster paginated list + merge search
        await db.clients.create_index("company_name")
        await db.clients.create_index("created_by")
        await db.clients.create_index([("assignments.user_id", 1)])
        await db.clients.create_index("status")
        await db.clients.create_index([("company_name", 1), ("status", 1)])
        await db.dsc_register.create_index("expiry_date")
        await db.todos.create_index([("user_id", 1), ("created_at", -1)])
        await db.attendance.create_index([("user_id", 1), ("date", -1)])
        await db.notifications.create_index("user_id")
        await db.visits.create_index([("assigned_to", 1), ("visit_date", -1)])
        await db.visits.create_index("visit_date")
        await db.visits.create_index("client_id")
        await db.visits.create_index("status")
        await db.notifications.create_index([("user_id", 1), ("is_read", 1)])
        await db.notifications.create_index("created_at")
        await db.quotations.create_index([("created_by", 1), ("created_at", -1)])
        await db.quotations.create_index("status")
        await db.quotations.create_index("service")
        await db.companies.create_index("created_by")
        await db.companies.create_index("name")
        # Bank / Accounting / Permission Governance (added for AI accounting features)
        await db.bank_accounts.create_index("company_id")
        await db.bank_transactions.create_index([("bank_account_id", 1), ("date", -1)])
        await db.bank_transactions.create_index("matched_type")
        await db.bank_reconciliation_audit.create_index([("bank_transaction_id", 1), ("timestamp", -1)])
        await db.chart_of_accounts.create_index([("company_id", 1), ("code", 1)], unique=True)
        await db.journal_entries.create_index([("company_id", 1), ("entry_date", -1)])
        await db.journal_lines.create_index("entry_id")
        await db.journal_lines.create_index("account_id")
        await db.access_requests.create_index([("user_id", 1), ("status", 1)])
        await db.access_requests.create_index("status")
        await db.staff_activity.create_index("type")
        await db.staff_activity.create_index("domain")
        await db.staff_activity.create_index([("user_id", 1), ("timestamp", -1)])
        await db.staff_activity.create_index([("user_id", 1), ("type", 1)])
        await db.trademark_sphere.create_index("application_number", unique=True)

        # ── FIXED: EMAIL CONNECTIONS INDEX ──────────────────────────────────
        try:
            # Drop old rule (Unique User + Provider)
            await db.email_connections.drop_index("user_id_1_provider_1")
        except Exception:
            pass

        # Create new rule (Unique User + Email Address)
        await db.email_connections.create_index(
            [("user_id", 1), ("email_address", 1)], unique=True, background=True
        )

        # Unique indexes — use background=True so they don't block startup if they already exist
        await db.attendance.create_index(
            [("user_id", 1), ("date", 1)], unique=True, background=True
        )
        await db.clients.create_index(
            [("created_by", 1), ("company_name", 1)], unique=True, background=True
        )
        await db.holidays.create_index("date", unique=True, background=True)

        # ── WhatsApp Hub indexes ─────────────────────────────────────────────
        # message_id + session_id: used by duplicate check on every bulk-sync insert
        # Without this index, bulk-sync with 1000+ messages does a full collection scan
        # per message → extremely slow, times out, and appears to store nothing.
        await db.whatsapp_hub_messages.create_index(
            [("message_id", 1), ("session_id", 1)], background=True, sparse=True
        )
        await db.whatsapp_hub_messages.create_index(
            [("jid", 1), ("timestamp", -1)], background=True
        )
        await db.whatsapp_hub_messages.create_index("timestamp", background=True)
        await db.whatsapp_hub_contacts.create_index("jid", unique=True, background=True)
        await db.whatsapp_hub_contacts.create_index(
            [("last_message_at", -1)], background=True
        )
        await db.whatsapp_hub_contacts.create_index("session_id", background=True)
        await db.whatsapp_hub_groups.create_index("jid", unique=True, background=True)

        # ── ACCOUNTING / INVOICING — the most-queried collections ────────────
        # These are called on every report load, reconcile, and invoice CRUD.
        # Without indexes every call does a full collection scan; with large
        # data sets (10k+ invoices) that causes 5-10 s latency per page.
        await db.invoices.create_index([("company_id", 1), ("status", 1)], background=True)
        await db.invoices.create_index([("company_id", 1), ("invoice_date", -1)], background=True)
        await db.invoices.create_index([("company_id", 1), ("invoice_type", 1)], background=True)
        await db.invoices.create_index("id", unique=True, background=True)
        await db.invoices.create_index("paid_bank_txn_id", background=True, sparse=True)

        await db.payments.create_index([("company_id", 1), ("invoice_id", 1)], background=True)
        await db.payments.create_index("invoice_id", background=True)
        await db.payments.create_index("id", unique=True, background=True)

        await db.purchase_invoices.create_index([("company_id", 1), ("status", 1)], background=True)
        await db.purchase_invoices.create_index([("company_id", 1), ("invoice_date", -1)], background=True)
        await db.purchase_invoices.create_index("id", unique=True, background=True)
        await db.purchase_invoices.create_index("paid_bank_txn_id", background=True, sparse=True)

        await db.purchase_payments.create_index([("company_id", 1), ("purchase_invoice_id", 1)], background=True)
        await db.purchase_payments.create_index("purchase_invoice_id", background=True)
        await db.purchase_payments.create_index("id", unique=True, background=True)

        # Journal entries: source+source_id compound is hit on every sync
        await db.journal_entries.create_index([("company_id", 1), ("source", 1), ("source_id", 1)], background=True)
        await db.journal_entries.create_index([("source", 1), ("source_id", 1)], background=True)
        await db.journal_entries.create_index("id", unique=True, background=True)

        # Journal lines: compound index covering Trial Balance aggregation
        await db.journal_lines.create_index([("company_id", 1), ("entry_date", -1), ("account_id", 1)], background=True)
        await db.journal_lines.create_index([("entry_id", 1), ("account_id", 1)], background=True)

        # Audit logs: queried by module+record_id and user+timestamp
        await db.audit_logs.create_index([("module", 1), ("record_id", 1), ("timestamp", -1)], background=True)
        await db.audit_logs.create_index([("user_id", 1), ("timestamp", -1)], background=True)

        # DSC register: expiry-based lookups
        await db.dsc_register.create_index([("assigned_to", 1), ("expiry_date", 1)], background=True)

    except Exception as e:
        # Log index creation errors but do NOT crash the server
        logger.warning(f"Index creation warning (non-fatal): {e}")

    try:
        visits = await db.visits.find({"id": {"$exists": False}}).to_list(10000)
        repaired = 0
        for v in visits:
            raw_id = v.get("_id")
            new_id = str(raw_id)
            await db.visits.update_one({"_id": raw_id}, {"$set": {"id": new_id}})
            repaired += 1
        logger.info(f"✅ Visit ID repair: {repaired} documents patched")
    except Exception as e:
        logger.error(f"⚠️ Visit ID repair failed (non-fatal): {e}")

    # Scheduled jobs=====================================================================
    try:
        scheduler.add_job(fetch_indian_holidays_task, "cron", day=1, hour=0, minute=5)
        # Also run immediately on startup so holidays are available from day 1
        scheduler.add_job(
            fetch_indian_holidays_task,
            "date",
            run_date=datetime.now(pytz.timezone("Asia/Kolkata")),
        )
        # Absent marking job — fires every working day at 19:00 IST
        scheduler.add_job(
            mark_absent_users_task,
            "cron",
            hour=19,
            minute=0,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="mark_absent_daily",
            replace_existing=True,
        )
        # Auto punch-out job — fires at 23:00 IST; records punch_out = 7 PM for
        # any user who punched in today but never manually punched out.
        scheduler.add_job(
            force_punch_out_11pm_task,
            "cron",
            hour=23,
            minute=0,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="force_punch_out_11pm",
            replace_existing=True,
        )

        # ── Automation Engine jobs ────────────────────────────────────────
        # Supersedes the old WA-only wa_birthday_job: handles WhatsApp +
        # Email birthdays, the admin approval gate, and timeline logging.
        scheduler.add_job(
            birthday_automation_job,
            "cron",
            hour=9,
            minute=0,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="birthday_automation",
            replace_existing=True,
        )
        scheduler.add_job(
            festival_greeting_job,
            "cron",
            hour=9,
            minute=5,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="festival_greetings",
            replace_existing=True,
        )
        scheduler.add_job(
            service_expiry_alert_job,
            "cron",
            hour=9,
            minute=45,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="service_expiry_alerts",
            replace_existing=True,
        )
        scheduler.add_job(
            follow_up_reminder_job,
            "cron",
            hour=10,
            minute=15,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="follow_up_reminders",
            replace_existing=True,
        )

        # ── WhatsApp notification jobs ────────────────────────────────────
        scheduler.add_job(
            wa_dsc_expiry_job,
            "cron",
            hour=9,
            minute=30,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="wa_dsc_expiry_alerts",
            replace_existing=True,
        )
        scheduler.add_job(
            wa_compliance_job,
            "cron",
            hour=10,
            minute=0,
            timezone=pytz.timezone("Asia/Kolkata"),
            id="wa_compliance_reminders",
            replace_existing=True,
        )
        # Scheduled bulk send runner — checks every minute for due jobs
        scheduler.add_job(
            wa_scheduled_bulk_job,
            "interval",
            minutes=1,
            id="wa_scheduled_bulk",
            replace_existing=True,
        )
        # Keep wa-bridge warm so Render's free instance never spins down —
        # fixes the 429/CORS/502 cascade caused by cold-start request bursts.
        scheduler.add_job(
            wa_bridge_keepalive_job,
            "interval",
            minutes=5,
            id="wa_bridge_keepalive",
            replace_existing=True,
        )

        scheduler.start()
        logger.info("APScheduler started successfully.")
    except Exception as e:
        logger.error(f"APScheduler startup failed: {e}")

    # ── AUTO-SYNC HOLIDAYS ON EVERY BOOT ─────────────────────────────────────
    # Runs async in the background — never blocks startup.
    # Fetches Indian public holidays (current + next year) from date.nager.at
    # and saves them all as 'confirmed'. Any existing 'pending' ones are upgraded.
    async def _boot_holiday_sync():
        try:
            import httpx as _httpx

            now_ist = datetime.now(pytz.timezone("Asia/Kolkata"))
            total_added = 0
            for year in [now_ist.year, now_ist.year + 1]:
                try:
                    async with _httpx.AsyncClient(timeout=10) as http:
                        resp = await http.get(
                            f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN"
                        )
                    if resp.status_code != 200:
                        continue
                    for h in resp.json():
                        date_str = h["date"]
                        name = h.get("localName") or h.get("name", "Holiday")
                        existing = await db.holidays.find_one(
                            {"date": date_str}, {"_id": 0}
                        )
                        if not existing:
                            await db.holidays.insert_one(
                                {
                                    "date": date_str,
                                    "name": name,
                                    "status": "confirmed",
                                    "type": "public",
                                    "created_at": now_ist.isoformat(),
                                }
                            )
                            total_added += 1
                        elif existing.get("status") not in ("confirmed", "rejected"):
                            await db.holidays.update_one(
                                {"date": date_str}, {"$set": {"status": "confirmed"}}
                            )
                except Exception as year_err:
                    logger.warning(f"Holiday sync for {year} failed: {year_err}")
            logger.info(f"Boot holiday sync complete: {total_added} new holidays added")
        except Exception as e:
            logger.warning(f"Boot holiday sync failed (non-fatal): {e}")

    asyncio.create_task(_boot_holiday_sync())

    # ── KEEP-ALIVE SELF-PING (prevents Render basic plan spin-down) ───────────
    # Pings our own /health endpoint every 10 minutes so Render never marks
    # the service as idle and spins it down. This is critical for the Identix
    # machine — it expects the server to be awake 24/7 to receive punches.
    async def _keep_alive_ping():
        await asyncio.sleep(60)  # wait 1 min after boot before starting
        import os as _os

        _self_url = _os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
        if not _self_url:
            # fallback: derive from RENDER_SERVICE_NAME or use localhost
            svc = _os.environ.get("RENDER_SERVICE_NAME", "")
            _self_url = (
                f"https://{svc}.onrender.com" if svc else "http://localhost:8000"
            )
        ping_url = f"{_self_url}/health"
        logger.info(f"Keep-alive ping started → {ping_url} every 10 min")
        while True:
            try:
                import httpx as _httpx

                async with _httpx.AsyncClient(timeout=10) as _http:
                    r = await _http.get(ping_url)
                logger.debug(f"Keep-alive ping OK ({r.status_code})")
            except Exception as _pe:
                logger.warning(f"Keep-alive ping failed (non-fatal): {_pe}")
            await asyncio.sleep(600)  # 10 minutes

    asyncio.create_task(_keep_alive_ping())

    # 🔥 AUTO MIGRATION: Add consent_given for old users
    try:
        result = await db.users.update_many(
            {},  # all users
            {"$set": {"consent_given": True}},
        )
        logger.info(f"Consent cleanup: Updated {result.modified_count} users")
    except Exception as e:
        logger.error(f"Consent cleanup failed: {e}")

    # ── PHASE 10 SELF-LEARNING SCHEDULER START ──
    try:
        from backend.learning.learning_scheduler import LearningScheduler
        LearningScheduler.start()
        logger.info("Phase 10 Self-Learning Scheduler started successfully on boot.")
    except Exception as e_sched:
        logger.error(f"Failed to start Phase 10 Self-Learning Scheduler on boot: {e_sched}")

    # ── PHASE 11 WORKFLOW SCHEDULER & BOOTSTRAP START ──
    try:
        from backend.workflow.workflow_templates import WorkflowTemplates
        from backend.workflow.workflow_scheduler import WorkflowScheduler
        
        # Bootstrap templates asynchronously
        async def bootstrap_workflow_templates():
            try:
                await WorkflowTemplates.bootstrap_templates()
                logger.info("Phase 11 default workflow templates bootstrapped successfully on boot.")
            except Exception as e_tmpl:
                logger.error(f"Failed to bootstrap default workflow templates: {e_tmpl}")

        asyncio.create_task(bootstrap_workflow_templates())

        # Start the escalation & automation scheduler background loop
        WorkflowScheduler.start()
        logger.info("Phase 11 Workflow Scheduler started successfully on boot.")
    except Exception as e_wf_sched:
        logger.error(f"Failed to start Phase 11 Workflow Scheduler on boot: {e_wf_sched}")

    # ── PHASE 12 PLATFORM BOOTSTRAP START ──
    try:
        from backend.platform.platform_engine import PlatformEngine
        
        async def bootstrap_saas_platform_async():
            try:
                await PlatformEngine.bootstrap_saas_platform()
                logger.info("Phase 12 SaaS Platform bootstrapped successfully on boot.")
            except Exception as e_saas:
                logger.error(f"Failed to bootstrap SaaS Platform: {e_saas}")

        asyncio.create_task(bootstrap_saas_platform_async())
    except Exception as e_saas_import:
        logger.error(f"Failed to import SaaS Platform Engine: {e_saas_import}")



# ====================== HEALTH ======================
# BUILD_MARKER — bump this string on every deploy-verification change.
# If a request to /health ever shows a DIFFERENT marker than the one you
# just committed, the browser/CDN/Render is NOT serving this exact commit —
# stop looking for a code bug and go fix the deploy instead.
BUILD_MARKER = "client-groups-deploy-check-2026-08-23"


def _health_route_paths():
    """Best-effort scan of every currently-registered /api/* path, walking
    into sub-routers. Never raises — /health must always answer even if
    route introspection fails for some reason."""
    seen_ids = set()

    def walk(routes):
        for r in routes:
            path = getattr(r, "path", None)
            if path and id(r) not in seen_ids:
                seen_ids.add(id(r))
                if path.startswith("/api"):
                    yield path
            sub = getattr(r, "routes", None)
            if sub:
                yield from walk(sub)

    try:
        return sorted(set(walk(app.routes)))
    except Exception as e:
        return [f"__route_scan_failed__: {e}"]


@app.api_route("/health", methods=["GET", "HEAD"])
async def health():
    all_paths = _health_route_paths()
    return JSONResponse({
        "status": "ok",
        "cors": "configured correctly",
        "build_marker": BUILD_MARKER,
        "client_groups_routes_present": any(
            p.startswith("/api/client-groups") for p in all_paths
        ),
        "total_api_routes": len(all_paths),
    })


@app.get("/")
async def root():
    return {"message": "Server is running"}


# ====================== SECURITY & DB ======================
rankings_cache = {}
# Store cache times as timezone-aware UTC datetimes for consistent comparison
rankings_cache_time: Dict[str, datetime] = {}


# ===================== HELPER FUNCTIONS =====================
def safe_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(IST)
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=pytz.UTC).astimezone(IST)
        return dt
    except Exception:
        return None


def sanitize_user_data(users, current_user=None):
    is_single = False
    if not isinstance(users, list):
        users = [users]
        is_single = True
    sanitized = []
    for user in users:
        if isinstance(user, dict):
            safe_user = {k: v for k, v in user.items() if k not in ["password", "_id"]}
            sanitized.append(safe_user)
        else:
            user_dict = user.model_dump() if hasattr(user, "model_dump") else vars(user)
            safe_user = {
                k: v for k, v in user_dict.items() if k not in ["password", "_id"]
            }
            sanitized.append(safe_user)
    return sanitized[0] if is_single else sanitized


def convert_objectids(data):
    """Recursively convert MongoDB ObjectId / date / datetime fields to JSON-safe types.

    PyMongo's BSON encoder accepts datetime.datetime but NOT datetime.date, so we
    convert bare date objects to ISO strings here to prevent InvalidDocument errors
    when inserting audit-log entries whose old_data came straight out of MongoDB
    (where birthday / date_of_incorporation may have been stored as date objects).
    """
    if isinstance(data, list):
        return [convert_objectids(item) for item in data]
    if isinstance(data, dict):
        new_dict = {}
        for key, value in data.items():
            if isinstance(value, ObjectId):
                new_dict[key] = str(value)
            elif isinstance(value, datetime):
                # Keep as datetime — pymongo handles datetime natively
                new_dict[key] = value
            elif isinstance(value, date):
                # Convert bare date → ISO string; pymongo cannot encode datetime.date
                new_dict[key] = value.isoformat()
            elif isinstance(value, (dict, list)):
                new_dict[key] = convert_objectids(value)
            else:
                new_dict[key] = value
        return new_dict
    if isinstance(data, ObjectId):
        return str(data)
    if isinstance(data, date) and not isinstance(data, datetime):
        return data.isoformat()
    return data


def is_own_record(current_user: User, record: dict) -> bool:
    uid = current_user.id
    return (
        record.get("user_id") == uid
        or record.get("assigned_to") == uid
        or record.get("created_by") == uid
        or uid in record.get("sub_assignees", [])
    )


async def create_audit_log(
    current_user: User,
    action: str,
    module: str,
    record_id: str,
    old_data: dict = None,
    new_data: dict = None,
):
    log_entry = AuditLog(
        user_id=current_user.id,
        user_name=current_user.full_name,
        action=action,
        module=module,
        record_id=record_id,
        old_data=convert_objectids(old_data) if old_data else None,
        new_data=convert_objectids(new_data) if new_data else None,
        timestamp=datetime.now(timezone.utc),
    )
    await db.audit_logs.insert_one(log_entry.model_dump())


def _expected_hours_pure(
    start_date_str: str,
    end_date_str: str,
    shift_start: str,
    shift_end: str,
    holidays: set,
):
    """Same calculation as calculate_expected_hours(), but takes an
    already-fetched holidays set instead of querying the DB. Lets callers
    that need this for many users (e.g. a staff report) fetch holidays
    ONCE and reuse it, instead of re-querying db.holidays on every
    iteration of a loop."""
    try:
        start = date.fromisoformat(start_date_str)
        end = date.fromisoformat(end_date_str)
    except Exception:
        return 0
    if start > end:
        return 0
    try:
        t1 = datetime.strptime(shift_start, "%H:%M")
        t2 = datetime.strptime(shift_end, "%H:%M")
        hrs_per_day = (t2 - t1).total_seconds() / 3600
    except Exception:
        hrs_per_day = 8.5
    total_hours = 0
    current_date = start
    while current_date <= end:
        if current_date.weekday() < 5 and current_date.isoformat() not in holidays:
            total_hours += hrs_per_day
        current_date += timedelta(days=1)
    return round(total_hours, 2)


async def calculate_expected_hours(
    start_date_str: str,
    end_date_str: str,
    shift_start: str = "10:30",
    shift_end: str = "19:00",
):
    holidays_cursor = db.holidays.find({"status": "confirmed"})
    holidays = {h["date"] for h in await holidays_cursor.to_list(length=None)}
    return _expected_hours_pure(start_date_str, end_date_str, shift_start, shift_end, holidays)


def fetch_indian_holidays_task():
    """
    Scheduled job (sync wrapper for BackgroundScheduler) to fetch holidays.
    Uses run_coroutine_threadsafe so Motor futures stay on the main event loop.
    """

    async def _async_fetch():
        try:
            now = datetime.now(IST)
            for year in [now.year, now.year + 1]:
                url = f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN"
                response = requests.get(url, timeout=10)
                if response.status_code != 200:
                    continue
                external_holidays = response.json()
                count = 0
                for h in external_holidays:
                    date_str = h["date"]
                    existing = await db.holidays.find_one(
                        {"date": date_str}, {"_id": 0}
                    )
                    if not existing:
                        new_holiday = {
                            "date": date_str,
                            "name": h.get("localName") or h.get("name", "Holiday"),
                            "status": "confirmed",
                            "type": "public",
                            "created_at": datetime.now(IST).isoformat(),
                        }
                        await db.holidays.insert_one(new_holiday)
                        count += 1
                    elif existing.get("status") not in ("confirmed", "rejected"):
                        await db.holidays.update_one(
                            {"date": date_str}, {"$set": {"status": "confirmed"}}
                        )
                logger.info(f"Auto-synced holidays for {year}: {count} new")
        except Exception as e:
            logger.error(f"Holiday Autofetch Failed: {str(e)}")

    try:
        import backend.server as _self

        loop = _self.app_event_loop
        if loop is None or loop.is_closed():
            logger.warning(
                "fetch_indian_holidays_task: main event loop not ready, skipping."
            )
            return
        future = asyncio.run_coroutine_threadsafe(_async_fetch(), loop)
        future.result(timeout=120)
    except Exception as e:
        logger.error(f"fetch_indian_holidays_task failed: {e}")


# ROUTER
api_router = APIRouter(prefix="/api")


# HELPERS - Email Service Functions
async def _brevo_send(
    to_email: str,
    subject: str,
    body_plain: str,
    body_html: str = None,
    attachments: list = None,
):
    """Core Brevo HTTP API sender — async, non-blocking.
    Sender email/name: DB active_sender setting → env vars fallback.
    `attachments` is an optional list of {"name": str, "content": base64str}.
    """
    api_key = (os.getenv("BREVO_API_KEY") or "").strip()
    # Try DB active sender first, fall back to env vars
    try:
        _sender_doc = await db.email_sender_settings.find_one(
            {"type": "active_sender"}, {"_id": 0}
        )
        if _sender_doc and _sender_doc.get("email"):
            sender_email = _sender_doc["email"].strip()
            sender_name = (_sender_doc.get("name") or "TaskoSphere").strip()
        else:
            sender_email = (os.getenv("SENDER_EMAIL") or "").strip()
            sender_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    except Exception:
        sender_email = (os.getenv("SENDER_EMAIL") or "").strip()
        sender_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()

    if not api_key or not sender_email:
        raise Exception(
            "Brevo API env vars not configured. "
            "Set BREVO_API_KEY and SENDER_EMAIL in Render environment variables."
        )

    payload = {
        "sender": {"name": sender_name, "email": sender_email},
        "to": [{"email": to_email}],
        "subject": subject,
        "textContent": body_plain,
    }
    if body_html:
        payload["htmlContent"] = body_html
    if attachments:
        clean = [
            {"name": a.get("name") or "attachment", "content": a.get("content")}
            for a in attachments
            if a and a.get("content")
        ]
        if clean:
            payload["attachment"] = clean

    async with httpx.AsyncClient(timeout=30.0) as http_client:
        response = await http_client.post(
            "https://api.brevo.com/v3/smtp/email",
            headers={
                "api-key": api_key,
                "Content-Type": "application/json",
            },
            json=payload,
        )

    if response.status_code == 401:
        raise Exception(
            f"Brevo 401 Unauthorized — API key is invalid or expired. "
            f"Go to app.brevo.com → SMTP & API → API Keys, regenerate the key, "
            f"and update BREVO_API_KEY in your Render environment variables. "
            f"Brevo response: {response.text}"
        )
    if response.status_code not in (200, 201):
        raise Exception(f"Brevo API error {response.status_code}: {response.text}")
    return True


async def send_birthday_email(recipient_email: str, client_name: str):
    """Send birthday wish email to client via Brevo API (async)."""
    subject = f"Happy Birthday, {client_name}!"
    body_plain = (
        f"Dear {client_name},\n\n"
        f"On behalf of our entire team, we wish you a very Happy Birthday!\n\n"
        f"We appreciate your continued trust and partnership. "
        f"May this year bring you prosperity, success, and happiness.\n\n"
        f"Best regards,\nTaskosphere Team"
    )
    html_content = f"""
    <html>
    <body style="font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;">
    <div style="max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
    <h1 style="color: #4F46E5; text-align: center;"> Happy Birthday! </h1>
    <p style="font-size: 16px; line-height: 1.6; color: #333;">Dear {client_name},</p>
    <p style="font-size: 16px; line-height: 1.6; color: #333;">
     On behalf of our entire team, we wish you a very Happy Birthday!
    </p>
    <p style="font-size: 16px; line-height: 1.6; color: #333;">
     We appreciate your continued trust and partnership. May this year bring you prosperity, success, and happiness.
    </p>
    <div style="background-color: #4F46E5; color: white; padding: 15px; border-radius: 5px; margin: 20px 0; text-align: center;">
    <p style="margin: 0; font-size: 18px; font-weight: bold;">Wishing you all the best!</p>
    </div>
    <p style="font-size: 14px; color: #666; text-align: center; margin-top: 30px;">
     Best regards,<br><strong>Taskosphere Team</strong>
    </p>
    </div>
    </body>
    </html>
    """
    try:
        await _brevo_send(recipient_email, subject, body_plain, html_content)
        logger.info(f"Birthday email sent to {recipient_email}")
        return True
    except Exception as e:
        logger.error(f"Failed to send birthday email: {str(e)}")
        return False


async def send_automation_wish_email(
    recipient_email: str,
    subject: str,
    body_plain: str,
    attachment_url: Optional[str] = None,
) -> bool:
    """
    Generic sender for automation-engine emails (birthday + festival wishes),
    using the admin's own subject/template from Automation Settings rather
    than a hardcoded one — send_birthday_email above is kept only as the
    legacy/manual "Send Birthday Wish" button's sender.

    attachment_url, if given, is fetched and attached to the email (e.g. a
    birthday banner, a festival greeting card) via Brevo's attachment API.
    A failed fetch never blocks the email — it just sends without the
    attachment, same fallback philosophy as the WhatsApp image sender.
    """
    html_content = (
        "<html><body style=\"font-family: Arial, sans-serif; padding: 20px; background-color: #f5f5f5;\">"
        "<div style=\"max-width: 600px; margin: 0 auto; background-color: white; padding: 30px; "
        "border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);\">"
        f"<p style=\"font-size: 16px; line-height: 1.6; color: #333; white-space: pre-wrap;\">{body_plain}</p>"
        "</div></body></html>"
    )

    attachments = None
    if attachment_url:
        try:
            async with httpx.AsyncClient(timeout=20) as c:
                resp = await c.get(attachment_url)
                resp.raise_for_status()
            filename = attachment_url.rsplit("/", 1)[-1].split("?")[0] or "attachment.jpg"
            b64_content = base64.b64encode(resp.content).decode("ascii")
            attachments = [{"name": filename, "content": b64_content}]
        except Exception as exc:
            logger.warning(f"Automation email attachment fetch failed ({attachment_url}): {exc} — sending without it.")

    try:
        await _brevo_send(recipient_email, subject, body_plain, html_content, attachments=attachments)
        return True
    except Exception as e:
        logger.error(f"Failed to send automation wish email: {str(e)}")
        return False


# ─── ACTIVE SENDER HELPER ─────────────────────────────────────────────────────
async def _get_active_sender():
    """
    Returns (email, name) for the active sender.
    Priority: DB setting → env vars fallback.
    """
    try:
        doc = await db.email_sender_settings.find_one(
            {"type": "active_sender"}, {"_id": 0}
        )
        if doc and doc.get("email"):
            return doc["email"].strip(), (doc.get("name") or "TaskoSphere").strip()
    except Exception:
        pass
    return (os.getenv("SENDER_EMAIL") or "").strip(), (
        os.getenv("SENDER_NAME") or "TaskoSphere"
    ).strip()


# ─── SENDER MANAGEMENT ENDPOINTS ──────────────────────────────────────────────
@api_router.get("/email/senders/active")
async def get_active_sender(current_user: User = Depends(get_current_user)):
    """Get the currently active sender email and name."""
    email, name = await _get_active_sender()
    # Also return env fallback info
    env_email = (os.getenv("SENDER_EMAIL") or "").strip()
    env_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    doc = await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
    return {
        "active_email": email,
        "active_name": name,
        "source": "db" if (doc and doc.get("email")) else "env",
        "env_email": env_email,
        "env_name": env_name,
        "db_senders": doc.get("all_senders", []) if doc else [],
    }


@api_router.get("/email/senders/list")
async def list_saved_senders(current_user: User = Depends(get_current_user)):
    """List all saved verified sender options."""
    doc = await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
    senders = doc.get("all_senders", []) if doc else []
    env_email = (os.getenv("SENDER_EMAIL") or "").strip()
    env_name = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    # Always include env sender if present and not already in list
    if env_email and not any(s["email"] == env_email for s in senders):
        senders = [{"email": env_email, "name": env_name, "source": "env"}] + senders
    return {"senders": senders}


@api_router.post("/email/senders/set-active")
async def set_active_sender(body: dict, current_user: User = Depends(get_current_user)):
    """Switch which sender email is used for all outgoing emails."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    email = (body.get("email") or "").strip()
    name = (body.get("name") or "TaskoSphere").strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="Valid email required")
    # Load existing doc to preserve all_senders list
    doc = (
        await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
        or {}
    )
    all_senders = doc.get("all_senders", [])
    # Add to list if not already there
    if not any(s["email"] == email for s in all_senders):
        all_senders.append(
            {
                "email": email,
                "name": name,
                "source": "brevo",
                "added_at": __import__("datetime").datetime.utcnow().isoformat(),
            }
        )
    await db.email_sender_settings.update_one(
        {"type": "active_sender"},
        {
            "$set": {
                "type": "active_sender",
                "email": email,
                "name": name,
                "all_senders": all_senders,
                "updated_at": __import__("datetime").datetime.utcnow().isoformat(),
                "updated_by": str(current_user.id),
            }
        },
        upsert=True,
    )
    return {"status": "ok", "active_email": email, "active_name": name}


@api_router.post("/email/senders/add")
async def add_sender_option(body: dict, current_user: User = Depends(get_current_user)):
    """Add a new verified sender to the saved list (without switching active)."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    email = (body.get("email") or "").strip()
    name = (body.get("name") or email).strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=422, detail="Valid email required")
    doc = (
        await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
        or {}
    )
    all_senders = doc.get("all_senders", [])
    if any(s["email"] == email for s in all_senders):
        return {"status": "already_exists", "senders": all_senders}
    all_senders.append(
        {
            "email": email,
            "name": name,
            "source": "brevo",
            "added_at": __import__("datetime").datetime.utcnow().isoformat(),
        }
    )
    await db.email_sender_settings.update_one(
        {"type": "active_sender"},
        {"$set": {"all_senders": all_senders}},
        upsert=True,
    )
    return {"status": "added", "senders": all_senders}


@api_router.delete("/email/senders/{sender_email}")
async def remove_sender_option(
    sender_email: str, current_user: User = Depends(get_current_user)
):
    """Remove a sender from the saved list."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    doc = (
        await db.email_sender_settings.find_one({"type": "active_sender"}, {"_id": 0})
        or {}
    )
    all_senders = [s for s in doc.get("all_senders", []) if s["email"] != sender_email]
    # If active sender was removed, reset to env
    updates = {"all_senders": all_senders}
    if doc.get("email") == sender_email:
        updates["email"] = (os.getenv("SENDER_EMAIL") or "").strip()
        updates["name"] = (os.getenv("SENDER_NAME") or "TaskoSphere").strip()
    await db.email_sender_settings.update_one(
        {"type": "active_sender"}, {"$set": updates}, upsert=True
    )
    return {"status": "removed", "senders": all_senders}


# ─── TEST EMAIL ENDPOINT ──────────────────────────────────────────────────────
@api_router.post("/email/test")
async def test_email_service(current_user: User = Depends(get_current_user)):
    """Send a test email to the logged-in admin to verify Brevo SMTP is working."""
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")

    missing = [
        k
        for k, v in {
            "BREVO_API_KEY": os.getenv("BREVO_API_KEY"),
            "SENDER_EMAIL": os.getenv("SENDER_EMAIL"),
        }.items()
        if not v
    ]

    if missing:
        raise HTTPException(
            status_code=500, detail=f"Missing env vars: {', '.join(missing)}"
        )

    try:
        await _brevo_send(
            to_email=current_user.email,
            subject="✅ TaskoSphere — Mail Service Test",
            body_plain=(
                f"Hello {current_user.full_name},\n\n"
                f"This is a test email from TaskoSphere.\n"
                f"If you received this, your mail service is working correctly.\n\n"
                f"SMTP Host : {os.getenv('BREVO_SMTP_HOST', 'smtp-relay.brevo.com')}\n"
                f"Sender    : {os.getenv('SENDER_EMAIL')}\n\n"
                f"Regards,\nTaskoSphere"
            ),
        )
        return {
            "status": "success",
            "message": f"Test email sent to {current_user.email}",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Mail error: {str(e)}")


# Task Analytics
@api_router.get("/tasks/analytics")
async def get_task_analytics(
    month: str, current_user: User = Depends(check_module_permission("tasks", "view"))
):
    """Get task analytics for a specific month (YYYY-MM)"""
    query = {}
    if current_user.role != "admin":
        query["$or"] = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
    tasks = await db.tasks.find(query, {"_id": 0}).to_list(1000)
    total = 0
    completed = 0
    pending = 0
    for task in tasks:
        created = task.get("created_at")
        if isinstance(created, str):
            if created.startswith(month):
                total += 1
                if task.get("status") == "completed":
                    completed += 1
                elif task.get("status") == "pending":
                    pending += 1
        elif isinstance(created, datetime):
            if created.strftime("%Y-%m") == month:
                total += 1
                if task.get("status") == "completed":
                    completed += 1
                elif task.get("status") == "pending":
                    pending += 1
    return {
        "month": month,
        "total_tasks": total,
        "completed_tasks": completed,
        "pending_tasks": pending,
    }


# ── AI: Detect Duplicate Tasks ─────────────────────────────────────────────────
@api_router.post("/tasks/detect-duplicates")
async def detect_duplicate_tasks(current_user: User = Depends(get_current_user)):
    """
    Use Gemini AI (gemini-2.0-flash) to find duplicate tasks.

    """
    import json as _json, re as _re

    # ── 1. Verify Gemini is configured ────────────────────────────────────
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if not gemini_key:
        raise HTTPException(
            status_code=503, detail="GEMINI_API_KEY is not set on the server."
        )

    try:
        import google.generativeai as _genai

        _genai.configure(api_key=gemini_key)
        _model = _genai.GenerativeModel("gemini-2.0-flash")
    except ImportError:
        raise HTTPException(
            status_code=503, detail="google-generativeai package not installed."
        )

    # ── 2. Scope query same as GET /tasks ──────────────────────────────────
    query: dict = {"type": {"$ne": "todo"}}
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        or_clauses = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
        if allowed_users:
            or_clauses.append({"assigned_to": {"$in": allowed_users}})
        query["$or"] = or_clauses

    # Cap at 50 tasks to stay within free-tier token limits
    tasks = await db.tasks.find(query, {"_id": 0}).to_list(50)

    if not tasks:
        return {"groups": [], "total_tasks_scanned": 0}

    # ── 3. Build minimal payload ───────────────────────────────────────────
    task_summaries = [
        {
            "id": str(t.get("id", "")),
            "title": (t.get("title") or "")[:100],
            "desc": (t.get("description") or "")[:80],
            "cat": t.get("category") or "",
            "cid": t.get("client_id") or "",
        }
        for t in tasks
    ]

    prompt = (
        "Find duplicate or very similar tasks. "
        "Return ONLY a JSON array, no markdown, no explanation. "
        'Format: [{"reason":"brief reason","confidence":"high|medium","task_ids":["id1","id2"]}] '
        "Only groups with 2+ tasks. If none found return []. "
        f"Tasks: {_json.dumps(task_summaries, ensure_ascii=False)}"
    )

    # ── 4. Call Gemini ─────────────────────────────────────────────────────
    try:
        resp = await _model.generate_content_async(prompt)
        raw = _re.sub(r"```[a-zA-Z]*", "", resp.text.strip()).replace("```", "").strip()
        groups = _json.loads(raw)
        if not isinstance(groups, list):
            groups = []
    except Exception as e:
        err_str = str(e)
        if "429" in err_str or "quota" in err_str.lower() or "rate" in err_str.lower():
            raise HTTPException(
                status_code=429,
                detail=(
                    "Gemini API quota exceeded. "
                    "Upgrade at https://ai.google.dev/pricing or wait and retry."
                ),
            )
        logger.warning(f"Gemini duplicate detection failed: {e}")
        raise HTTPException(status_code=500, detail=f"AI error: {err_str[:200]}")

    return {"groups": groups, "total_tasks_scanned": len(tasks)}


# ── AI: Detect Duplicate Tasks via Groq (Llama) ────────────────────────────────
@api_router.post("/tasks/detect-duplicates-grok")
async def detect_duplicate_tasks_grok(
    payload: dict, current_user: User = Depends(get_current_user)
):
    """
    Use Groq API (llama-3.3-70b-versatile) to find duplicate tasks.
    Expects optional body: { "tasks": [...], "exclude_completed": true }
    Falls back to fetching tasks from DB if no tasks provided in payload.
    """
    import json as _json, re as _re

    # ── 1. Verify Groq is configured ──────────────────────────────────────
    groq_key = os.environ.get("GROQ_API_KEY", "")
    if not groq_key:
        raise HTTPException(
            status_code=503,
            detail="GROQ_API_KEY is not set on the server. Add your Groq API key to enable Grok duplicate detection.",
        )

    # ── 2. Get tasks — from payload or DB ────────────────────────────────
    incoming_tasks = payload.get("tasks") if payload else None
    exclude_completed = payload.get("exclude_completed", True) if payload else True

    if incoming_tasks and isinstance(incoming_tasks, list):
        tasks = incoming_tasks
    else:
        query: dict = {"type": {"$ne": "todo"}}
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_tasks", []) or []
            if current_user.role == "manager":
                team_ids = await get_team_user_ids(current_user.id)
                allowed_users = list(set(allowed_users + team_ids))
            or_clauses = [
                {"assigned_to": current_user.id},
                {"sub_assignees": current_user.id},
                {"created_by": current_user.id},
            ]
            if allowed_users:
                or_clauses.append({"assigned_to": {"$in": allowed_users}})
            query["$or"] = or_clauses
        tasks = await db.tasks.find(query, {"_id": 0}).to_list(50)

    if exclude_completed:
        tasks = [t for t in tasks if t.get("status") != "completed"]

    if not tasks:
        return {"groups": [], "total_tasks_scanned": 0}

    # ── 3. Build minimal task summaries ──────────────────────────────────
    task_summaries = [
        {
            "id": str(t.get("id", "")),
            "title": (t.get("title") or "")[:100],
            "desc": (t.get("description") or "")[:80],
            "cat": t.get("category") or "",
            "cid": str(t.get("client_id") or ""),
        }
        for t in tasks
    ]

    prompt = (
        "Find duplicate or very similar tasks. "
        "Return ONLY a JSON array, no markdown, no explanation. "
        'Format: [{"reason":"brief reason","confidence":"high|medium","task_ids":["id1","id2"]}] '
        "Only groups with 2+ tasks. If none found return []. "
        f"Tasks: {_json.dumps(task_summaries, ensure_ascii=False)}"
    )

    # ── 4. Call Groq API (OpenAI-compatible endpoint) ─────────────────────
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {groq_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": [
                        {
                            "role": "system",
                            "content": "You are a task deduplication assistant. Always respond with valid JSON only — no markdown, no code fences, no explanation.",
                        },
                        {"role": "user", "content": prompt},
                    ],
                    "temperature": 0.1,
                    "max_tokens": 1024,
                },
            )

        if response.status_code == 429:
            raise HTTPException(
                status_code=429,
                detail="Groq API rate limit exceeded. Please wait a moment and try again.",
            )
        if response.status_code == 401:
            raise HTTPException(
                status_code=503,
                detail="Invalid GROQ_API_KEY. Please check your Groq API key on Render.",
            )
        if not response.is_success:
            raise HTTPException(
                status_code=502,
                detail=f"Groq API error: {response.status_code} — {response.text[:200]}",
            )

        data = response.json()
        raw_text = data["choices"][0]["message"]["content"].strip()
        # Strip markdown code fences if model wraps response in them
        raw_text = _re.sub(r"```[a-zA-Z]*", "", raw_text).replace("```", "").strip()
        groups = _json.loads(raw_text)
        if not isinstance(groups, list):
            groups = []

    except HTTPException:
        raise
    except _json.JSONDecodeError as e:
        logger.warning(f"Groq returned non-JSON response: {e}")
        raise HTTPException(
            status_code=500, detail="Groq returned an unparseable response. Try again."
        )
    except httpx.TimeoutException:
        raise HTTPException(
            status_code=504, detail="Groq API timed out. Please try again."
        )
    except Exception as e:
        err_str = str(e)
        logger.warning(f"Groq duplicate detection failed: {e}")
        raise HTTPException(status_code=500, detail=f"Groq error: {err_str[:200]}")

    return {"groups": groups, "total_tasks_scanned": len(tasks)}


# Helper functions
def verify_password(plain_password, hashed_password):
    return pwd_context.verify(plain_password, hashed_password)


def get_password_hash(password):
    return pwd_context.hash(password)


def _verify_saas_password(plain_password: str, user: dict) -> bool:
    """Verify the scrypt password record used by the commercial SaaS account."""
    salt_hex = user.get("password_salt")
    expected_hex = user.get("password_hash")
    if not salt_hex or not expected_hex:
        return False

    try:
        derived = hashlib.scrypt(
            str(plain_password).encode("utf-8"),
            salt=str(salt_hex).encode("utf-8"),
            n=16384,
            r=8,
            p=1,
            dklen=64,
        ).hex()
        return hmac.compare_digest(derived, str(expected_hex))
    except (TypeError, ValueError):
        return False


def _make_saas_password_record(password: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16).hex()
    password_hash = hashlib.scrypt(
        str(password).encode("utf-8"),
        salt=salt.encode("utf-8"),
        n=16384,
        r=8,
        p=1,
        dklen=64,
    ).hex()
    return password_hash, salt


def _saas_object_id(value):
    """Return an ObjectId where possible, otherwise the original value."""
    if isinstance(value, ObjectId):
        return value
    try:
        return ObjectId(str(value))
    except Exception:
        return value


async def _sync_saas_bootstrap_password() -> None:
    """Synchronize the configured bootstrap password for an existing SaaS admin."""
    bootstrap_email = str(
        os.getenv("SAAS_BOOTSTRAP_ADMIN_EMAIL", "")
    ).strip().lower()
    bootstrap_password = str(
        os.getenv("SAAS_BOOTSTRAP_ADMIN_PASSWORD", "")
    )

    if not bootstrap_email or not bootstrap_password:
        return

    existing = await db.users.find_one({"email": bootstrap_email})
    if not existing:
        return

    # Only accounts explicitly managed as bootstrap admins may be changed by
    # the bootstrap environment variables. Never overwrite a normal user.
    if existing.get("role") != "admin" and existing.get("bootstrap_managed") is not True:
        return

    password_hash, password_salt = _make_saas_password_record(bootstrap_password)
    update = {
        "$set": {
            "password_hash": password_hash,
            "password_salt": password_salt,
            "role": "admin",
            "status": "active",
            "bootstrap_managed": True,
            "updated_at": datetime.now(timezone.utc),
        }
    }
    await db.users.update_one({"_id": existing.get("_id")}, update)


async def _create_saas_session(user: dict) -> tuple[str, str, User]:
    """Create the opaque session consumed by dependencies.get_current_user()."""
    company_id = user.get("company_id")
    if company_id is None:
        raise HTTPException(status_code=403, detail="Authenticated user is not associated with a company")

    company_query_id = _saas_object_id(company_id)
    company = await db.companies.find_one(
        {"_id": company_query_id, "status": "active"}
    )
    if not company and company_query_id != company_id:
        company = await db.companies.find_one(
            {"_id": company_id, "status": "active"}
        )
    if not company:
        raise HTTPException(status_code=403, detail="Commercial company is inactive or unavailable")

    subscription = await db.subscriptions.find_one({"company_id": company_id})
    if not subscription:
        subscription = await db.subscriptions.find_one(
            {"company_id": company_query_id}
        )
    if not subscription:
        raise HTTPException(status_code=403, detail="Commercial subscription is unavailable")

    subscription_status = subscription.get("status")
    if subscription_status not in ("trial", "active"):
        raise HTTPException(status_code=403, detail="Commercial subscription is not active")

    expires_at = subscription.get("expires_at")
    if expires_at:
        if isinstance(expires_at, str):
            try:
                expires_at = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            except Exception:
                expires_at = None
        if expires_at:
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=timezone.utc)
            if expires_at <= datetime.now(timezone.utc):
                raise HTTPException(status_code=403, detail="Commercial subscription has expired")

    session_token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
    now = datetime.now(timezone.utc)
    ttl_days = max(1, int(os.getenv("SAAS_SESSION_TTL_DAYS", "30") or 30))

    await db.sessions.insert_one({
        "user_id": user.get("_id") or user.get("id"),
        "company_id": company_id,
        "token_hash": token_hash,
        "expires_at": now + timedelta(days=ttl_days),
        "created_at": now,
        "last_seen_at": now,
    })

    user_data = {
        key: value
        for key, value in user.items()
        if key not in {"_id", "password", "password_hash", "password_salt", "bootstrap_managed"}
    }
    user_data["id"] = str(user.get("_id") or user.get("id"))
    user_data["company_id"] = str(company_id)
    user_data["company_name"] = company.get("name")
    user_data["status"] = "active"
    user_data["is_active"] = True
    user_data.setdefault("created_at", now)

    # The bootstrap SaaS account stores permissions as a plain dictionary.
    # Merge them with the existing admin defaults so all existing permission
    # checks continue to behave exactly as they do for legacy users.
    role_defaults = DEFAULT_ROLE_PERMISSIONS.get(
        str(user_data.get("role") or "admin"), {}
    )
    stored_permissions = user_data.get("permissions") or {}
    if hasattr(stored_permissions, "model_dump"):
        stored_permissions = stored_permissions.model_dump()
    user_data["permissions"] = {**role_defaults, **stored_permissions}

    return session_token, str(user_data["id"]), User(**user_data)


async def send_email(to_email: str, subject: str, body: str):
    """Send plain text email via Brevo API (async)."""
    try:
        await _brevo_send(to_email, subject, body)
        return True
    except Exception as e:
        raise Exception(f"Brevo API error: {str(e)}")


# ===========================================================
# Website activity
# ===========================================================


@api_router.get("/activity/websites")
async def get_website_activity(current_user: User = Depends(get_current_user)):
    try:
        pipeline = [
            {"$match": {"user_id": current_user.id, "type": "website"}},
            {
                "$group": {
                    "_id": "$user_id",
                    "websites": {
                        "$push": {
                            "url": "$url",
                            "domain": "$domain",
                            "title": "$title",
                            "duration": "$duration",
                            "timestamp": "$timestamp",
                        }
                    },
                }
            },
            {"$project": {"_id": 0, "user_id": "$_id", "websites": 1}},
        ]

        data = await db.staff_activity.aggregate(pipeline).to_list(100)

        return data

    except Exception as e:
        logger.error(f"Fetch website activity error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch website activity")


@api_router.post("/activity/track-website")
async def track_website(data: dict, current_user: User = Depends(get_current_user)):
    try:
        url = data.get("url")
        domain = data.get("domain")

        if not url or not domain:
            raise HTTPException(status_code=400, detail="Invalid website data")

        activity = {
            "id": str(uuid.uuid4()),
            "user_id": current_user.id,
            "type": "website",
            "url": url,
            "domain": domain,
            "title": data.get("title", ""),
            "timestamp": datetime.now(timezone.utc),
            "duration": int(data.get("duration", 0)),
        }

        await db.staff_activity.insert_one(activity)

        return {"status": "tracked"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Website tracking error: {str(e)}")
        raise HTTPException(status_code=500, detail="Tracking failed")


# ===========================================================
# AUTH ROUTES
# ============================================================
@api_router.get("/system/time")
async def get_system_time():
    now = datetime.now(IST)
    return {
        "server_time": now.isoformat(),
        "display_time": now.strftime("%I:%M:%S %p"),
        "date": now.strftime("%Y-%m-%d"),
    }


# =========================
# REFERRERS ROUTES
# =========================


@api_router.get("/referrers")
async def get_referrers(current_user: User = Depends(get_current_user)):
    referrers = await db.referrers.find({}, {"_id": 0}).to_list(500)
    return referrers


@api_router.post("/referrers")
async def create_referrer(data: dict, current_user: User = Depends(get_current_user)):
    name = (data.get("name") or "").strip()

    if not name:
        raise HTTPException(status_code=400, detail="Referrer name required")

    existing = await db.referrers.find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0}
    )

    if existing:
        return existing

    referrer = {
        "id": str(uuid.uuid4()),
        "name": name,
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    await db.referrers.insert_one(referrer)
    # FIX: insert_one mutates `referrer` in-place by adding `_id: ObjectId(...)`.
    # Returning the dict without popping _id causes FastAPI's jsonable_encoder
    # to fail with: ValueError: [TypeError("'ObjectId' object is not iterable"),
    # TypeError('vars() argument must have __dict__ attribute')]
    referrer.pop("_id", None)
    return referrer


# =========================
# REFERRERS EDIT / DELETE
# =========================


@api_router.put("/referrers")
async def update_referrer(data: dict, current_user: User = Depends(get_current_user)):
    old_name = (data.get("old_name") or "").strip()
    new_name = (data.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(
            status_code=400, detail="old_name and new_name are required"
        )
    conflict = await db.referrers.find_one(
        {"name": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}}, {"_id": 0}
    )
    if conflict and conflict.get("name", "").lower() != old_name.lower():
        raise HTTPException(
            status_code=400, detail=f'"{new_name}" already exists in the referrer list'
        )
    result = await db.referrers.update_one(
        {"name": {"$regex": f"^{re.escape(old_name)}$", "$options": "i"}},
        {"$set": {"name": new_name}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail=f'Referrer "{old_name}" not found')
    await db.clients.update_many(
        {"referred_by": old_name}, {"$set": {"referred_by": new_name}}
    )
    return {"ok": True, "name": new_name}


@api_router.delete("/referrers")
async def delete_referrer(name: str, current_user: User = Depends(get_current_user)):
    if not name:
        raise HTTPException(status_code=400, detail="name query param required")
    result = await db.referrers.delete_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f'Referrer "{name}" not found')
    return {"ok": True}


# =========================
# AUDITORS ROUTES
# =========================


@api_router.get("/auditors")
async def get_auditors(current_user: User = Depends(get_current_user)):
    auditors = await db.auditors.find({}, {"_id": 0}).to_list(500)
    return auditors


@api_router.post("/auditors")
async def create_auditor(data: dict, current_user: User = Depends(get_current_user)):
    name = (data.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Auditor name required")
    existing = await db.auditors.find_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}, {"_id": 0}
    )
    if existing:
        return existing
    auditor = {
        "id": str(uuid.uuid4()),
        "name": name,
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.auditors.insert_one(auditor)
    auditor.pop("_id", None)
    return auditor


@api_router.put("/auditors")
async def update_auditor(data: dict, current_user: User = Depends(get_current_user)):
    old_name = (data.get("old_name") or "").strip()
    new_name = (data.get("new_name") or "").strip()
    if not old_name or not new_name:
        raise HTTPException(
            status_code=400, detail="old_name and new_name are required"
        )
    conflict = await db.auditors.find_one(
        {"name": {"$regex": f"^{re.escape(new_name)}$", "$options": "i"}}, {"_id": 0}
    )
    if conflict and conflict.get("name", "").lower() != old_name.lower():
        raise HTTPException(
            status_code=400, detail=f'"{new_name}" already exists in the auditor list'
        )
    result = await db.auditors.update_one(
        {"name": {"$regex": f"^{re.escape(old_name)}$", "$options": "i"}},
        {"$set": {"name": new_name}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail=f'Auditor "{old_name}" not found')
    await db.clients.update_many({"auditor": old_name}, {"$set": {"auditor": new_name}})
    return {"ok": True, "name": new_name}


@api_router.delete("/auditors")
async def delete_auditor(name: str, current_user: User = Depends(get_current_user)):
    if not name:
        raise HTTPException(status_code=400, detail="name query param required")
    result = await db.auditors.delete_one(
        {"name": {"$regex": f"^{re.escape(name)}$", "$options": "i"}}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f'Auditor "{name}" not found')
    return {"ok": True}


# ==========================================================
# TODO DASHBOARD
# ==========================================================
@api_router.post("/todos", response_model=Todo)
async def create_todo(
    todo_data: TodoCreate, current_user: User = Depends(get_current_user)
):
    now = datetime.now(timezone.utc)
    todo = Todo(user_id=current_user.id, **todo_data.model_dump())
    doc = todo.model_dump()

    # Safe conversion with fallback
    doc["created_at"] = (doc.get("created_at") or now).isoformat()
    doc["updated_at"] = (doc.get("updated_at") or now).isoformat()

    if doc.get("due_date"):
        if isinstance(doc["due_date"], (datetime, date)):
            doc["due_date"] = doc["due_date"].isoformat()

    result = await db.todos.insert_one(doc)
    doc["id"] = str(result.inserted_id)
    doc.pop("_id", None)
    return doc


@api_router.get("/todos")
async def get_todos(
    user_id: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    if current_user.role == "admin":
        if user_id == "all":
            query = {}
        elif user_id:
            query = {"user_id": user_id}
        else:
            query = {"user_id": current_user.id}

    else:
        permissions = (
            current_user.permissions.model_dump()
            if hasattr(current_user.permissions, "model_dump")
            else (current_user.permissions or {})
        )
        if not isinstance(permissions, dict):
            permissions = {}
        allowed_others = permissions.get("view_other_todos", []) or []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_others = list(set(allowed_others + team_ids))
        if user_id:
            if user_id != current_user.id and user_id not in allowed_others:
                raise HTTPException(status_code=403, detail="Not allowed")
            query = {"user_id": user_id}
        else:
            visible_ids = list(set(allowed_others + [current_user.id]))
            query = {"user_id": {"$in": visible_ids}}

    todos = await db.todos.find(query).to_list(1000)
    for t in todos:
        t["id"] = str(t["_id"])
        del t["_id"]
    return todos


@api_router.get("/dashboard/todo-overview")
async def get_todo_dashboard(current_user: User = Depends(get_current_user)):
    is_admin = current_user.role == "admin"
    if is_admin:
        todos = await db.todos.find().to_list(2000)
        # Replaced N+1 user queries with a single batch lookup
        user_ids = list({t["user_id"] for t in todos if t.get("user_id")})
        users_raw = await db.users.find({"id": {"$in": user_ids}}, {"_id": 0}).to_list(
            1000
        )
        user_name_map = {u["id"]: u.get("full_name", "Unknown User") for u in users_raw}

        grouped_todos = {}
        all_todos_flat = []
        for todo in todos:
            user_name = user_name_map.get(todo["user_id"], "Unknown User")
            if user_name not in grouped_todos:
                grouped_todos[user_name] = []
            todo["_id"] = str(todo["_id"])
            grouped_todos[user_name].append(todo)
            all_todos_flat.append(todo)
        return {
            "role": "admin",
            "todos": all_todos_flat,
            "grouped_todos": grouped_todos,
        }
    else:
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_todos", []) or []
        if not isinstance(allowed_users, list):
            allowed_users = []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        query_ids = list(set(allowed_users + [current_user.id]))
        todos = await db.todos.find({"user_id": {"$in": query_ids}}).to_list(2000)
        for todo in todos:
            todo["_id"] = str(todo["_id"])
        return {"role": current_user.role, "todos": todos}


@api_router.post("/todos/{todo_id}/promote-to-task")
async def promote_todo(
    todo_id: str,
    task_data: dict = Body(default={}),
    current_user: User = Depends(get_current_user),
):
    try:
        todo = await db.todos.find_one({"_id": ObjectId(todo_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Todo ID")
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if current_user.role != "admin" and todo["user_id"] != current_user.id:
        raise HTTPException(
            status_code=403, detail="Not authorized to promote this todo"
        )
    now = datetime.now(IST)

    # Use edited form data from request body; fall back to todo values if not provided
    assigned_to = task_data.get("assigned_to") or todo["user_id"]
    due_date_raw = task_data.get("due_date")
    due_date = None
    if due_date_raw:
        try:
            due_date = datetime.fromisoformat(due_date_raw.replace("Z", "+00:00"))
        except Exception:
            due_date = None

    new_task = {
        "id": str(uuid.uuid4()),
        "title": task_data.get("title") or todo["title"],
        "description": task_data.get("description")
        if "description" in task_data
        else todo.get("description"),
        "assigned_to": assigned_to,
        "sub_assignees": task_data.get("sub_assignees") or [],
        "priority": task_data.get("priority") or "medium",
        "status": task_data.get("status") or "pending",
        "category": task_data.get("category") or "other",
        "client_id": task_data.get("client_id") or None,
        "due_date": due_date,
        "is_recurring": task_data.get("is_recurring", False),
        "recurrence_pattern": task_data.get("recurrence_pattern")
        if task_data.get("is_recurring")
        else None,
        "recurrence_interval": task_data.get("recurrence_interval")
        if task_data.get("is_recurring")
        else None,
        "type": "task",
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    async with await client.start_session() as session:

        async def cb(session):
            await db.tasks.insert_one(new_task, session=session)
            await db.todos.delete_one({"_id": ObjectId(todo_id)}, session=session)

        await session.with_transaction(cb)
    return {"message": "Todo promoted to task successfully"}


@api_router.delete("/todos/{todo_id}")
async def delete_todo(todo_id: str, current_user: User = Depends(get_current_user)):
    try:
        obj_id = ObjectId(todo_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Todo ID")
    todo = await db.todos.find_one({"_id": obj_id})
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if current_user.role != "admin" and todo["user_id"] != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    await db.todos.delete_one({"_id": obj_id})
    return {"message": "Todo deleted successfully"}


@api_router.patch("/todos/{todo_id}")
async def update_todo(
    todo_id: str, updates: dict, current_user: User = Depends(get_current_user)
):
    try:
        todo = await db.todos.find_one({"_id": ObjectId(todo_id)})
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid Todo ID")
    if not todo:
        raise HTTPException(status_code=404, detail="Todo not found")
    if current_user.role != "admin" and todo["user_id"] != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    now = datetime.now(IST)
    if updates.get("is_completed") is True:
        updates["completed_at"] = now
    updates["updated_at"] = now
    await db.todos.update_one({"_id": ObjectId(todo_id)}, {"$set": updates})
    return {"message": "Todo updated successfully"}


async def _enforce_auth_rate_limit(request: Request, identifier: str, limit_per_minute: int = 10):
    """
    Throttles unauthenticated auth endpoints (login, self-register, OTP) by
    client IP + the email/identifier being targeted, so a single attacker
    can't brute-force passwords or OTP codes. Raises 429 if exceeded.
    """
    client_ip = request.client.host if request and request.client else "unknown"
    key = f"auth:{client_ip}:{(identifier or '').lower()}"
    try:
        if await RateLimiter.is_rate_limited(key, limit_per_minute=limit_per_minute):
            try:
                await AuditSecurity.log_security_event(
                    event_type="rate_limit_blocked",
                    actor_id=identifier or "unknown",
                    company_id="",
                    severity="warning",
                    details=f"Rate limit exceeded from {client_ip} for '{identifier}'.",
                )
            except Exception:
                pass
            raise HTTPException(
                status_code=429,
                detail="Too many attempts. Please wait a minute and try again.",
            )
    except HTTPException:
        raise
    except Exception:
        # Fail open on infra errors (e.g. rate-limit store unavailable) —
        # we don't want a DB hiccup to lock everyone out of login.
        logger.warning("Rate limiter check failed; allowing request through.")


# REGISTER Endpoint
@api_router.post("/auth/register", response_model=Token)
async def register(
    user_data: UserCreate, current_user: User = Depends(get_current_user)
):
    # PERMISSION MATRIX (updated):
    # Admin   → can register users with any role
    # Manager → can register staff users only (if can_manage_users is True)
    # Staff   → can register staff users only (if can_manage_users is True)
    perms = get_user_permissions(current_user)
    is_admin = current_user.role == "admin"
    can_manage = perms.get("can_manage_users", False)

    if not is_admin and not can_manage:
        raise HTTPException(
            status_code=403, detail="You do not have permission to register users"
        )

    existing = await db.users.find_one({"email": user_data.email}, {"_id": 0})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_password = get_password_hash(user_data.password)

    requested_role = (
        user_data.role.value if hasattr(user_data.role, "value") else user_data.role
    )

    if requested_role in ["admin", "manager", "superadmin"]:
        if current_user.role != "admin":
            raise HTTPException(
                status_code=400,
                detail="Only staff role can be assigned during registration by non-admin users",
            )

    role_val = requested_role
    default_permissions = DEFAULT_ROLE_PERMISSIONS.get(role_val, {})
    user_id = str(uuid.uuid4())

    def _date_str(v):
        if v is None:
            return None
        return v.isoformat() if hasattr(v, "isoformat") else str(v)

    new_user = {
        "id": user_id,
        "email": user_data.email,
        "full_name": user_data.full_name,
        "role": role_val,
        "password": hashed_password,
        "departments": user_data.departments or [],
        "phone": user_data.phone,
        "birthday": _date_str(user_data.birthday),
        "telegram_id": user_data.telegram_id,
        "punch_in_time": user_data.punch_in_time or "10:30",
        "grace_time": user_data.grace_time or "00:10",
        "punch_out_time": user_data.punch_out_time or "19:00",
        "profile_picture": user_data.profile_picture,
        "is_active": False,
        "status": "pending_approval",
        "approved_by": None,
        "approved_at": None,
        "permissions": user_data.permissions
        if user_data.permissions
        else default_permissions,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # ── Employment / Payroll ─────────────────────────────────────────────
        "joining_date": _date_str(getattr(user_data, "joining_date", None)),
        "training_period_end": _date_str(
            getattr(user_data, "training_period_end", None)
        ),
        "payroll_date": _date_str(getattr(user_data, "payroll_date", None)),
        "monthly_salary": getattr(user_data, "monthly_salary", None),
    }

    await db.users.insert_one(new_user)

    # Background sync (NON-BLOCKING)
    # Safe background runner (kept for future use if needed)
    async def run_safe_background(coro, name="task"):
        try:
            await coro
        except Exception as e:
            logger.error(f"{name} failed: {e}", exc_info=True)

    # ─────────────────────────────────────────────
    # AUTH RESPONSE LOGIC (CLEANED)
    # ─────────────────────────────────────────────

    access_token = create_access_token({"sub": user_id})

    # Remove sensitive fields
    new_user.pop("password", None)
    new_user.pop("_id", None)

    # ❌ REMOVED (Identix sync — no longer exists)
    # asyncio.create_task(run_safe_background(
    #     sync_user_to_identix_devices(new_user),
    #     "identix_sync"
    # ))

    return {"access_token": access_token, "token_type": "bearer", "user": new_user}


@api_router.post("/auth/self-register", response_model=Token)
async def self_register(user_data: UserCreate, request: Request):
    """
    Public self-registration endpoint — no auth token required.
    Role is always forced to 'staff' and status is always 'pending_approval'.
    An admin must approve the account before the user can log in.
    Used by the public /register page.
    """
    await _enforce_auth_rate_limit(request, user_data.email, limit_per_minute=5)

    existing = await db.users.find_one({"email": user_data.email}, {"_id": 0})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    hashed_password = get_password_hash(user_data.password)
    default_permissions = DEFAULT_ROLE_PERMISSIONS.get("staff", {})
    user_id = str(uuid.uuid4())

    def _date_str_sr(v):
        if v is None:
            return None
        return v.isoformat() if hasattr(v, "isoformat") else str(v)

    new_user = {
        "id": user_id,
        "email": user_data.email,
        "full_name": user_data.full_name,
        "role": "staff",  # always staff for self-registration
        "password": hashed_password,
        "departments": user_data.departments or [],
        "phone": user_data.phone,
        "birthday": _date_str_sr(user_data.birthday),
        "telegram_id": user_data.telegram_id,
        "punch_in_time": user_data.punch_in_time or "10:30",
        "grace_time": user_data.grace_time or "00:10",
        "punch_out_time": user_data.punch_out_time or "19:00",
        "profile_picture": user_data.profile_picture,
        "is_active": False,
        "status": "pending_approval",  # always pending for self-registration
        "approved_by": None,
        "approved_at": None,
        "permissions": default_permissions,
        "created_at": datetime.now(timezone.utc).isoformat(),
        # ── Employment / Payroll ─────────────────────────────────────────────
        "joining_date": _date_str_sr(getattr(user_data, "joining_date", None)),
        "training_period_end": _date_str_sr(
            getattr(user_data, "training_period_end", None)
        ),
        "payroll_date": _date_str_sr(getattr(user_data, "payroll_date", None)),
    }

    await db.users.insert_one(new_user)
    access_token = create_access_token({"sub": user_id})
    new_user.pop("password", None)
    new_user.pop("_id", None)

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": new_user,
    }


@api_router.post("/auth/login", response_model=Token)
async def login(credentials: UserLogin, request: Request):
    await _enforce_auth_rate_limit(request, credentials.email, limit_per_minute=10)
    client_ip = request.client.host if request and request.client else "unknown"
    normalized_email = str(credentials.email or "").strip().lower()

    # Commercial SaaS bootstrap credentials are stored as scrypt
    # password_hash/password_salt records, not as the legacy bcrypt
    # `password` field. Synchronize an existing bootstrap-managed admin first
    # so changing SAAS_BOOTSTRAP_ADMIN_PASSWORD actually takes effect.
    try:
        await _sync_saas_bootstrap_password()
    except Exception:
        logger.exception("SaaS bootstrap password synchronization failed.")

    user = await db.users.find_one({"email": normalized_email})

    # ── Commercial SaaS account path ────────────────────────────────────────
    if user and user.get("password_hash") and user.get("password_salt"):
        if not _verify_saas_password(credentials.password, user):
            try:
                await AuditSecurity.log_security_event(
                    event_type="login_failed",
                    actor_id=normalized_email,
                    company_id=str(user.get("company_id") or ""),
                    severity="warning",
                    details=f"Failed SaaS login attempt from {client_ip}.",
                )
            except Exception:
                pass
            raise HTTPException(status_code=401, detail="Invalid email or password")

        session_token, _, user_obj = await _create_saas_session(user)

        try:
            await AuditSecurity.log_security_event(
                event_type="login_success",
                actor_id=user_obj.id,
                company_id=str(user_obj.company_id or ""),
                severity="info",
                details=f"SaaS login from {client_ip}",
            )
        except Exception:
            logger.warning("SaaS login audit log failed; continuing.")

        return {
            "access_token": session_token,
            "token_type": "bearer",
            "user": user_obj,
            "consent_given": True,
            "session_token": session_token,
        }

    # ── Existing legacy account path ────────────────────────────────────────
    if not user or not user.get("password") or not verify_password(
        credentials.password, user["password"]
    ):
        try:
            await AuditSecurity.log_security_event(
                event_type="login_failed",
                actor_id=normalized_email,
                company_id=str(user.get("company_id") or "") if user else "",
                severity="warning",
                details=f"Failed login attempt from {client_ip}.",
            )
        except Exception:
            pass
        raise HTTPException(status_code=401, detail="Invalid email or password")

    user_status = user.get("status")
    if user_status is not None and user_status != "active":
        raise HTTPException(
            status_code=403,
            detail=f"Your account is {user_status}. Awaiting admin approval.",
        )

    user["permissions"] = user.get("permissions", UserPermissions().model_dump())

    if "created_at" in user and isinstance(user["created_at"], str):
        user["created_at"] = datetime.fromisoformat(user["created_at"])

    user.pop("_id", None)
    user_obj = User(**{k: v for k, v in user.items() if k != "password"})
    access_token = create_access_token({"sub": user_obj.id})

    # Off-hours access notice (informational only — does not block login).
    now_hour = datetime.now().time()
    is_off_hours = now_hour > dtime(23, 0) or now_hour < dtime(5, 0)

    session_token = None
    try:
        session_token = await SessionManager.create_user_session(
            user_id=user_obj.id,
            client_ip=client_ip,
            user_agent=request.headers.get("user-agent", "unknown"),
        )
        await AuditSecurity.log_security_event(
            event_type="login_success",
            actor_id=user_obj.id,
            company_id=str(user_obj.company_id or ""),
            severity="info" if not is_off_hours else "warning",
            details=f"Login from {client_ip}" + (" (off-hours access)" if is_off_hours else ""),
        )
    except Exception:
        logger.warning("Session tracking / audit log failed on login; continuing.")

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user_obj,
        "consent_given": True,
        "session_token": session_token,
    }


@api_router.post("/auth/logout")
async def logout(
    request: Request,
    session_token: Optional[str] = Body(default=None, embed=True),
    current_user: User = Depends(get_current_user),
):
    """
    Revokes the session record created at login. Note: this does NOT
    invalidate the JWT itself (the token remains cryptographically valid
    until it expires — see ACCESS_TOKEN_EXPIRE_MINUTES in dependencies.py).
    This lets a super-admin portal show/revoke "active sessions" for
    auditing purposes without changing the stateless-JWT auth model.
    """
    revoked = False
    if session_token:
        try:
            revoked = await SessionManager.revoke_session(session_token)
        except Exception:
            logger.warning("Session revoke failed on logout.")
    try:
        await AuditSecurity.log_security_event(
            event_type="logout",
            actor_id=current_user.id,
            company_id="",
            severity="info",
            details="User logged out.",
        )
    except Exception:
        pass
    return {"message": "Logged out.", "session_revoked": revoked}


@api_router.get("/auth/me", response_model=User)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@api_router.get("/security/scan")
async def security_scan(current_user: User = Depends(require_admin())):
    """
    Admin-only security health check: counts recent critical/warning events
    logged by AuditSecurity (failed logins, rate-limit trips, off-hours
    access, password resets). Foundation for the super-admin security
    dashboard — extend with more event types as new checks are added.
    """
    return await SecurityMonitor.run_security_scan()


@api_router.get("/security/events")
async def security_events(
    limit: int = Query(50, ge=1, le=500),
    current_user: User = Depends(require_admin()),
):
    """Admin-only: recent security events (login failures, resets, etc.)."""
    return await AuditSecurity.get_recent_security_events(limit=limit)


# ── Forgot / Reset Password → moved to backend/auth_password_reset.py ─────────
# NOTE: POST /auth/sync-permissions moved to permission_governance.py


@api_router.post("/users/{user_id}/approve")
async def approve_user(user_id: str, current_user: User = Depends(get_current_user)):
    # Client / user approval is admin-only — permission governance cannot delegate this.
    if current_user.role != "admin":
        raise HTTPException(
            status_code=403, detail="Only administrators can approve users"
        )

    existing = await db.users.find_one({"id": user_id}, {"_id": 0})

    if not existing:
        raise HTTPException(status_code=404, detail="User not found")

    if existing.get("status") != "pending_approval":
        raise HTTPException(
            status_code=400,
            detail=f"User status is {existing.get('status')}, not pending approval",
        )

    update_data = {
        "status": "active",
        "is_active": True,
        "approved_by": current_user.id,
        "approved_at": datetime.now(timezone.utc).isoformat(),
    }

    await db.users.update_one({"id": user_id}, {"$set": update_data})

    await create_audit_log(
        current_user, "APPROVE_USER", "user", user_id, existing, update_data
    )

    return {"message": "User approved successfully"}


@api_router.post("/users/{user_id}/reject")
async def reject_user(user_id: str, current_user: User = Depends(get_current_user)):
    # User rejection is admin-only — matches approval which is also admin-only.
    if current_user.role != "admin":
        raise HTTPException(
            status_code=403, detail="Only administrators can reject users"
        )

    existing = await db.users.find_one({"id": user_id}, {"_id": 0})

    if not existing:
        raise HTTPException(status_code=404, detail="User not found")

    update_data = {"status": "rejected", "is_active": False}

    await db.users.update_one({"id": user_id}, {"$set": update_data})

    await create_audit_log(
        current_user, "REJECT_USER", "user", user_id, existing, update_data
    )

    return {"message": "User rejected"}


# ============================================================
# USER MANAGEMENT
# =============================================================
@api_router.get("/users")
async def get_users(
    user_id: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    if current_user.role == "admin":
        query = {}
        users_raw = await db.users.find(query, {"_id": 0, "password": 0}).to_list(1000)
    elif current_user.role == "manager":
        if user_id:
            target_user = await db.users.find_one(
                {"id": user_id}, {"_id": 0, "password": 0}
            )
            if not target_user:
                raise HTTPException(status_code=404, detail="User not found")
            target_depts = target_user.get("departments", [])
            manager_depts = current_user.departments
            if not any(d in manager_depts for d in target_depts):
                raise HTTPException(
                    status_code=403, detail="User not in your departments"
                )
            users_raw = [target_user]
        else:
            # Manager: self + everyone in their cross-visibility union.
            # "Team" is now purely explicit (admin-curated view_other_* lists).
            cross_ids = await get_cross_visibility_union(current_user.id)
            visible_ids = list(set(cross_ids + [current_user.id]))
            query = {"id": {"$in": visible_ids}}
            users_raw = await db.users.find(query, {"_id": 0, "password": 0}).to_list(
                1000
            )
    else:
        # Staff scope: own data always; with can_view_user_page can view the full directory.
        # Without can_view_user_page, staff still see self + their cross-visibility union.
        permissions = get_user_permissions(current_user)
        can_view_dir = permissions.get("can_view_user_page", False)

        if user_id:
            # Specific user lookup — own record always allowed
            if user_id == current_user.id:
                users_raw = await db.users.find(
                    {"id": user_id}, {"_id": 0, "password": 0}
                ).to_list(1000)
            elif can_view_dir:
                # Staff with directory access can look up any user by ID
                users_raw = await db.users.find(
                    {"id": user_id}, {"_id": 0, "password": 0}
                ).to_list(1000)
            else:
                # Allow lookup if target is in any of this staff's cross-vis lists
                cross_ids = await get_cross_visibility_union(current_user.id)
                if user_id not in cross_ids:
                    raise HTTPException(status_code=403, detail="Not allowed")
                users_raw = await db.users.find(
                    {"id": user_id}, {"_id": 0, "password": 0}
                ).to_list(1000)
        elif can_view_dir:
            # Staff with can_view_user_page: return full directory (active users only, no passwords)
            # This is needed for task assignment dropdowns, cross-visibility, etc.
            users_raw = await db.users.find(
                {"is_active": True},
                {
                    "_id": 0,
                    "password": 0,
                    "permissions": 0,
                },  # strip permissions for privacy
            ).to_list(1000)
        else:
            # No directory access — return self + cross-visibility union
            cross_ids = await get_cross_visibility_union(current_user.id)
            visible_ids = list(set(cross_ids + [current_user.id]))
            users_raw = await db.users.find(
                {"id": {"$in": visible_ids}}, {"_id": 0, "password": 0}
            ).to_list(1000)
    for u in users_raw:
        if u.get("created_at") and isinstance(u["created_at"], str):
            try:
                u["created_at"] = datetime.fromisoformat(u["created_at"])
            except Exception:
                u["created_at"] = datetime.now(timezone.utc)
        else:
            u["created_at"] = datetime.now(timezone.utc)
        # Salary is sensitive — only admins, or a user looking at their own
        # record, may see it. Strip it from every other view (manager team
        # lists, staff directory, cross-visibility lookups, etc).
        if current_user.role != "admin" and u.get("id") != current_user.id:
            u.pop("monthly_salary", None)
    return convert_objectids(users_raw)


@api_router.put("/users/{user_id}", response_model=User)
async def update_user(
    user_id: str,
    user_data: dict,
    current_user: User = Depends(check_module_permission("users", "edit")),
):
    is_own = user_id == current_user.id
    is_admin = current_user.role.lower() == "admin"
    is_manager = current_user.role.lower() == "manager"
    perms = get_user_permissions(current_user)
    has_edit_users = perms.get("can_edit_users", False)

    # Manager scope check: manager with can_edit_users can edit their team staff only
    if not is_admin and not is_own and has_edit_users and is_manager:
        team_ids = await get_team_user_ids(current_user.id)
        if user_id not in team_ids:
            raise HTTPException(status_code=403, detail="User is not in your team")
        target_user = await db.users.find_one({"id": user_id}, {"_id": 0})
        if target_user and target_user.get("role") in ("admin", "manager"):
            raise HTTPException(
                status_code=403, detail="Managers can only edit staff members"
            )
    elif not is_admin and not is_own and not has_edit_users:
        raise HTTPException(
            status_code=403, detail="You can only update your own profile."
        )

    existing = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="User not found.")

    if is_admin:
        # Admin can update all fields including role, permissions, status
        allowed_fields = [
            "full_name",
            "email",
            "role",
            "departments",
            "phone",
            "birthday",
            "punch_in_time",
            "grace_time",
            "punch_out_time",
            "is_active",
            "profile_picture",
            "telegram_id",
            "status",
            "permissions",
            "joining_date",
            "training_period_end",
            "payroll_date",
            "monthly_salary",
        ]
    elif is_manager and has_edit_users and not is_own:
        # Manager editing a team staff member — can update profile + work settings, not role/permissions
        allowed_fields = [
            "full_name",
            "email",
            "departments",
            "phone",
            "birthday",
            "punch_in_time",
            "grace_time",
            "punch_out_time",
            "is_active",
            "profile_picture",
            "telegram_id",
            "status",
            "joining_date",
            "training_period_end",
            "payroll_date",
        ]
    else:
        # Self-edit: own profile fields only
        allowed_fields = [
            "full_name",
            "phone",
            "birthday",
            "punch_in_time",
            "punch_out_time",
            "profile_picture",
            "telegram_id",
        ]

    update_payload = {}
    for key in allowed_fields:
        if key in user_data:
            val = user_data[key]
            update_payload[key] = val if val != "" else None
    if "monthly_salary" in update_payload and update_payload["monthly_salary"] is not None:
        try:
            update_payload["monthly_salary"] = float(update_payload["monthly_salary"])
        except (TypeError, ValueError):
            update_payload["monthly_salary"] = None
    new_password = user_data.get("password")
    if new_password and len(new_password.strip()) > 0:
        update_payload["password"] = get_password_hash(new_password)
    if update_payload:
        await db.users.update_one({"id": user_id}, {"$set": update_payload})
    await create_audit_log(
        current_user, "UPDATE_USER", "user", user_id, existing, update_payload
    )
    updated_user = await db.users.find_one({"id": user_id}, {"_id": 0, "password": 0})
    return updated_user


@api_router.delete("/users/{user_id}")
async def delete_user(
    user_id: str,
    current_user: User = Depends(check_module_permission("users", "delete")),
):
    # Issue #8: fully permission-based (can_manage_users flag), admin always passes via check_module_permission
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    existing = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="User not found")
    await create_audit_log(
        current_user, "DELETE_USER", "user", record_id=user_id, old_data=existing
    )
    await db.users.delete_one({"id": user_id})
    return {"message": "User deleted successfully"}


# ════════════════════════════════════════════════════════════════════════════════
# EMPLOYEE OFFBOARDING / REPLACEMENT
# ════════════════════════════════════════════════════════════════════════════════


@api_router.get("/users/{user_id}/offboard-preview")
async def offboard_preview(
    user_id: str,
    current_user: User = Depends(require_admin()),
):
    """Preview what data belongs to this user before offboarding."""
    user = await db.users.find_one({"id": user_id}, {"_id": 0, "password": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    counts = {
        "tasks_assigned": await db.tasks.count_documents({"assigned_to": user_id}),
        "tasks_created": await db.tasks.count_documents({"created_by": user_id}),
        "clients": await db.clients.count_documents({"assigned_to": user_id}),
        "dsc": await db.dsc_register.count_documents({"assigned_to": user_id}),
        "documents": await db.documents.count_documents(
            {"$or": [{"assigned_to": user_id}, {"created_by": user_id}]}
        ),
        "todos": await db.todos.count_documents({"user_id": user_id}),
        "visits": await db.visits.count_documents({"assigned_to": user_id}),
        "leads": await db.leads.count_documents({"assigned_to": user_id}),
    }

    return {
        "user": {
            "id": user.get("id"),
            "full_name": user.get("full_name"),
            "email": user.get("email"),
            "role": user.get("role"),
            "departments": user.get("departments", []),
        },
        "data_counts": counts,
        "total_items": sum(counts.values()),
    }


@api_router.post("/users/{user_id}/offboard")
async def offboard_user(
    user_id: str,
    body: OffboardRequest,
    current_user: User = Depends(require_admin()),
):
    """
    Offboard an employee: transfer all their data to a replacement user,
    keep an audit trail, then optionally delete the old account.
    """
    if user_id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot offboard yourself")
    if user_id == body.replacement_user_id:
        raise HTTPException(
            status_code=400, detail="Old and replacement user cannot be the same"
        )

    old_user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not old_user:
        raise HTTPException(status_code=404, detail="User to offboard not found")

    new_user = await db.users.find_one({"id": body.replacement_user_id}, {"_id": 0})
    if not new_user:
        raise HTTPException(status_code=404, detail="Replacement user not found")

    transfer_summary = {}

    # 1. Tasks
    if body.transfer_tasks:
        r1 = await db.tasks.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        r2 = await db.tasks.update_many(
            {"created_by": user_id}, {"$set": {"created_by": body.replacement_user_id}}
        )
        transfer_summary["tasks_assigned"] = r1.modified_count
        transfer_summary["tasks_created"] = r2.modified_count

    # 2. Clients
    if body.transfer_clients:
        r = await db.clients.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["clients_reassigned"] = r.modified_count

    # 3. DSC
    if body.transfer_dsc:
        r = await db.dsc_register.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["dsc_transferred"] = r.modified_count

    # 4. Documents
    if body.transfer_documents:
        r = await db.documents.update_many(
            {"$or": [{"assigned_to": user_id}, {"created_by": user_id}]},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["documents_transferred"] = r.modified_count

    # 5. Todos
    if body.transfer_todos:
        r = await db.todos.update_many(
            {"user_id": user_id}, {"$set": {"user_id": body.replacement_user_id}}
        )
        transfer_summary["todos_transferred"] = r.modified_count

    # 6. Visits
    if body.transfer_visits:
        r = await db.visits.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["visits_transferred"] = r.modified_count

    # 7. Leads
    if body.transfer_leads:
        r = await db.leads.update_many(
            {"assigned_to": user_id},
            {"$set": {"assigned_to": body.replacement_user_id}},
        )
        transfer_summary["leads_transferred"] = r.modified_count

    # 8. Update cross-user permission references in all other users
    for field in [
        "permissions.view_other_tasks",
        "permissions.view_other_attendance",
        "permissions.view_other_reports",
        "permissions.view_other_todos",
        "permissions.view_other_activity",
        "permissions.view_other_visits",
        "permissions.assigned_clients",
    ]:
        await db.users.update_many(
            {field: user_id},
            {"$set": {f"{field}.$[elem]": body.replacement_user_id}},
            array_filters=[{"elem": user_id}],
        )
    transfer_summary["permission_references_updated"] = True

    # 9. Optionally update the replacement user's email
    if body.update_email and body.update_email.strip():
        new_email = body.update_email.strip().lower()
        email_exists = await db.users.find_one(
            {"email": new_email, "id": {"$ne": body.replacement_user_id}},
            {"_id": 0, "id": 1},
        )
        if email_exists:
            raise HTTPException(
                status_code=400, detail=f"Email {new_email} is already in use"
            )
        await db.users.update_one(
            {"id": body.replacement_user_id}, {"$set": {"email": new_email}}
        )
        transfer_summary["email_updated"] = new_email

    # 10. Audit Log
    await create_audit_log(
        current_user,
        "OFFBOARD_USER",
        "user",
        record_id=user_id,
        old_data={
            "offboarded_user": {
                "id": old_user.get("id"),
                "full_name": old_user.get("full_name"),
                "email": old_user.get("email"),
                "role": old_user.get("role"),
                "departments": old_user.get("departments", []),
            },
            "replacement_user": {
                "id": new_user.get("id"),
                "full_name": new_user.get("full_name"),
                "email": new_user.get("email"),
            },
            "transfer_summary": transfer_summary,
            "notes": body.notes,
        },
    )

    # 11. Delete or deactivate old user
    if body.delete_old_user:
        await db.users.delete_one({"id": user_id})
        transfer_summary["old_user_deleted"] = True
    else:
        await db.users.update_one(
            {"id": user_id}, {"$set": {"is_active": False, "status": "inactive"}}
        )
        transfer_summary["old_user_deactivated"] = True

    return {
        "message": f"Successfully offboarded {old_user.get('full_name')} → {new_user.get('full_name')}",
        "transfer_summary": transfer_summary,
    }



# ====================================================================================
# ATTENDANCE ROUTES
# =====================================================================================
def get_real_client_ip(request: Request):
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def check_is_late(user: dict, punch_in_ist: datetime) -> bool:
    try:
        pit = datetime.strptime(user.get("punch_in_time", "10:30"), "%H:%M")
        if user.get("late_grace_minutes") is not None:
            grace_minutes = int(user["late_grace_minutes"])
        else:
            raw = str(user.get("grace_time", "00:10"))
            gt = datetime.strptime(raw, "%H:%M")
            grace_minutes = gt.hour * 60 + gt.minute
        deadline = punch_in_ist.replace(
            hour=pit.hour, minute=pit.minute, second=0, microsecond=0
        ) + timedelta(minutes=grace_minutes)
        return punch_in_ist > deadline
    except Exception:
        return False


def check_punched_out_early(user: dict, punch_out_ist: datetime) -> bool:
    try:
        pot = datetime.strptime(user.get("punch_out_time", "19:00"), "%H:%M")
        expected_out = punch_out_ist.replace(
            hour=pot.hour, minute=pot.minute, second=0, microsecond=0
        )
        return punch_out_ist < expected_out
    except Exception:
        return False


@api_router.post("/attendance")
async def handle_attendance(data: dict, current_user: User = Depends(get_current_user)):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    today_str = today.isoformat()
    # Note: We do NOT block punch-in on holidays.
    # Users who choose to work on holidays can still punch in/out freely.
    # The frontend suppresses the auto-popup on holidays but keeps the button visible.
    action = data.get("action")
    if action not in ["punch_in", "punch_out"]:
        raise HTTPException(status_code=400, detail="Invalid action")
    attendance = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0}
    )
    if action == "punch_in":
        if attendance and attendance.get("punch_in"):
            raise HTTPException(status_code=400, detail="Already punched in")
        user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0})
        punch_in_utc = datetime.now(timezone.utc)
        punch_in_ist = punch_in_utc.astimezone(ZoneInfo("Asia/Kolkata"))
        is_late = check_is_late(user_doc or {}, punch_in_ist)
        location_data = data.get("location")
        update_fields = {
            "status": "present",
            "punch_in": punch_in_utc,
            "is_late": is_late,
            "leave_reason": None,
            # Clear auto_absent flag if user punches in manually
            "auto_marked": False,
        }
        location_verified = True
        if location_data:
            update_fields["location"] = location_data
            # Soft-fail geofence: allow punch but flag if outside office radius
            lat = location_data.get("latitude")
            lng = location_data.get("longitude")
            if lat is not None and lng is not None:
                import math

                OFFICE_LAT = 21.18796
                OFFICE_LNG = 72.81375
                GEOFENCE_RADIUS_M = 200
                R = 6371000  # Earth radius in metres
                phi1 = math.radians(OFFICE_LAT)
                phi2 = math.radians(lat)
                dphi = math.radians(lat - OFFICE_LAT)
                dlambda = math.radians(lng - OFFICE_LNG)
                a = (
                    math.sin(dphi / 2) ** 2
                    + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
                )
                distance_m = R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                if distance_m > GEOFENCE_RADIUS_M:
                    location_verified = False
                    logger.info(
                        f"Geofence: user {current_user.id} punched in from {distance_m:.0f}m away — flagged as remote."
                    )
        update_fields["location_verified"] = location_verified
        await db.attendance.update_one(
            {"user_id": current_user.id, "date": today_str},
            {"$set": update_fields},
            upsert=True,
        )
        return {
            "message": "Punched in successfully",
            "is_late": is_late,
            "location_verified": location_verified,
        }

    # PUNCH_OUT_BLOCK
    if action == "punch_out":
        if not attendance or not attendance.get("punch_in"):
            raise HTTPException(status_code=400, detail="Not punched in yet")

        if attendance.get("punch_out"):
            raise HTTPException(
                status_code=409,
                detail="Punch Out already recorded. A second Punch Out is not allowed unless an administrator edits/resets the previous Punch Out."
            )

        punch_in_dt = attendance.get("punch_in")
        punch_out_utc = datetime.now(timezone.utc)
        punch_out_ist = punch_out_utc.astimezone(ZoneInfo("Asia/Kolkata"))

        user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0})
        punched_out_early = check_punched_out_early(user_doc or {}, punch_out_ist)

        # FIX: MongoDB may return punch_in as a naive datetime (no tzinfo).
        # Treat naive datetimes as UTC before computing the delta.
        if isinstance(punch_in_dt, datetime):
            if punch_in_dt.tzinfo is None:
                punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
        else:
            # Fallback: parse from string if stored as ISO string
            try:
                punch_in_dt = datetime.fromisoformat(str(punch_in_dt))
                if punch_in_dt.tzinfo is None:
                    punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
            except Exception:
                punch_in_dt = punch_out_utc  # safeguard: 0-minute duration

        delta = punch_out_utc - punch_in_dt.astimezone(timezone.utc)
        duration_minutes = int(delta.total_seconds() / 60)

        update_fields = {
            "punch_out": punch_out_utc,
            "punched_out_early": punched_out_early,
            "duration_minutes": max(0, duration_minutes),
        }

        if data.get("location"):
            update_fields["punch_out_location"] = data.get("location")

        # ── Overtime: minutes worked past the user's own shift-end time ──────
        _pot_str = (user_doc or {}).get("punch_out_time") or "19:00"
        try:
            _pot = datetime.strptime(_pot_str, "%H:%M")
        except ValueError:
            _pot = datetime.strptime("19:00", "%H:%M")
        shift_end_ist = punch_out_ist.replace(
            hour=_pot.hour, minute=_pot.minute, second=0, microsecond=0
        )
        if punch_out_ist > shift_end_ist:
            update_fields["overtime_minutes"] = max(
                0, int((punch_out_ist - shift_end_ist).total_seconds() / 60)
            )
        else:
            update_fields["overtime_minutes"] = 0
        # ─────────────────────────────────────────────────────────────────────

        await db.attendance.update_one(
            {"user_id": current_user.id, "date": today_str}, {"$set": update_fields}
        )

        return {
            "message": "Punched out successfully",
            "duration": duration_minutes,
            "punched_out_early": punched_out_early,
        }


@api_router.post("/attendance/mark-leave-today")
async def mark_leave_today(current_user: User = Depends(get_current_user)):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    today_str = today.isoformat()
    await db.attendance.update_one(
        {"user_id": current_user.id, "date": today_str},
        {
            "$set": {
                "status": "leave",
                "punch_in": None,
                "punch_out": None,
                "leave_reason": "Marked on leave today",
            }
        },
        upsert=True,
    )
    # Notify admins that this user marked themselves on leave today.
    try:
        await notify_admins_leave(
            applicant_name=(current_user.full_name or current_user.email),
            detail=f"full day · {today_str} · Marked on leave today",
            exclude_user_id=current_user.id,
        )
    except Exception:
        pass
    return {"message": "Marked on leave today"}


@api_router.get("/attendance/today")
async def get_today_attendance(current_user: User = Depends(get_current_user)):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    today_str = today.isoformat()
    # FIX: Added {"_id": 0} projection — without it ObjectId leaks into JSON response
    # and causes ValueError: 'ObjectId' object is not iterable (500 error)
    holiday = await db.holidays.find_one({"date": today_str}, {"_id": 0})
    attendance = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0}
    )
    # BUGFIX: previously, whenever today had a holiday record we returned an
    # early "punch_in: None" response and never even looked at the user's
    # actual attendance doc. That meant punching in on a holiday/half-day
    # (which is explicitly allowed — see /attendance below) still showed
    # "please punch in" on the Dashboard and Attendance page afterwards,
    # while the punch-in button itself correctly rejected a second punch-in
    # with "Already punched in". A real attendance record must always win.
    if attendance:
        if "status" not in attendance:
            attendance["status"] = "present" if attendance.get("punch_in") else "absent"
        if holiday:
            attendance["holiday"] = holiday
        return attendance
    if holiday:
        return {
            "status": "holiday",
            "holiday": holiday,
            "punch_in": None,
            "punch_out": None,
            "leave_reason": None,
        }
    return {
        "status": "absent",
        "punch_in": None,
        "punch_out": None,
        "leave_reason": None,
    }


@api_router.post("/attendance/apply-leave")
async def apply_leave(data: dict, current_user: User = Depends(get_current_user)):
    try:
        # Target user is NEVER trusted from the client without a role check.
        # Admin may act on one selected employee; everyone else can only act
        # on their own attendance record.
        requested_target_user_id = data.get("target_user_id") or data.get("user_id")
        if current_user.role == "admin":
            target_user_id = requested_target_user_id or current_user.id
        else:
            if requested_target_user_id and requested_target_user_id != current_user.id:
                raise HTTPException(
                    status_code=403,
                    detail="Only Admin can apply leave for another employee",
                )
            target_user_id = current_user.id

        target_user = await db.users.find_one(
            {"id": target_user_id},
            {"_id": 0, "id": 1, "full_name": 1, "email": 1, "is_active": 1, "status": 1},
        )
        if not target_user:
            raise HTTPException(status_code=404, detail="Selected employee not found")
        if target_user.get("is_active") is False or target_user.get("status") == "inactive":
            raise HTTPException(status_code=400, detail="Selected employee is inactive")

        from_date = datetime.fromisoformat(data["from_date"]).date()
        to_date = datetime.fromisoformat(data.get("to_date", data["from_date"])).date()
        reason = data.get("reason", "Leave Applied")
        leave_type = data.get(
            "leave_type", "full_day"
        )  # full_day | half_day_morning | half_day_afternoon | early_leave
        early_leave_time = data.get(
            "early_leave_time"
        )  # "HH:MM" string for early leave

        VALID_LEAVE_TYPES = (
            "full_day",
            "half_day_morning",
            "half_day_afternoon",
            "early_leave",
        )
        if leave_type not in VALID_LEAVE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid leave_type. Must be one of: {VALID_LEAVE_TYPES}",
            )

        if to_date < from_date:
            raise HTTPException(status_code=400, detail="Invalid date range")

        # For partial-day leave types, only single-day makes sense
        if leave_type in ("half_day_morning", "half_day_afternoon", "early_leave"):
            if to_date != from_date:
                raise HTTPException(
                    status_code=400,
                    detail="Half-day and early leave can only be applied for a single day",
                )

        current = from_date
        while current <= to_date:
            current_str = current.isoformat()
            existing = await db.attendance.find_one(
                {"user_id": target_user_id, "date": current_str}, {"_id": 0}
            )

            if leave_type == "full_day":
                update_fields = {
                    "status": "leave",
                    "leave_reason": reason,
                    "leave_type": "full_day",
                    "punch_in": None,
                    "punch_out": None,
                    "duration_minutes": 0,
                }

            elif leave_type == "half_day_morning":
                # Morning off — not expected to punch in before noon
                update_fields = {
                    "status": "present",
                    "leave_reason": reason,
                    "leave_type": "half_day_morning",
                    "is_half_day": True,
                    # Don't wipe punch_in/out if already recorded
                }
                if not existing or not existing.get("punch_in"):
                    update_fields["punch_in"] = None
                    update_fields["punch_out"] = None
                    update_fields["duration_minutes"] = 0

            elif leave_type == "half_day_afternoon":
                # Afternoon off — present in morning, leaves at noon
                update_fields = {
                    "status": "present",
                    "leave_reason": reason,
                    "leave_type": "half_day_afternoon",
                    "is_half_day": True,
                }
                # Set a nominal punch-out at 13:30 IST if not already punched out
                if (
                    existing
                    and existing.get("punch_in")
                    and not existing.get("punch_out")
                ):
                    punch_in_dt = existing["punch_in"]
                    if isinstance(punch_in_dt, str):
                        punch_in_dt = datetime.fromisoformat(punch_in_dt)
                    if punch_in_dt.tzinfo is None:
                        punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
                    half_day_out = datetime.now(timezone.utc).replace(
                        hour=8, minute=0, second=0, microsecond=0
                    )  # 13:30 IST = 08:00 UTC
                    delta = half_day_out - punch_in_dt
                    dur = max(0, int(delta.total_seconds() / 60))
                    update_fields["punch_out"] = half_day_out
                    update_fields["duration_minutes"] = dur
                    update_fields["punched_out_early"] = True

            elif leave_type == "early_leave":
                # Present but left early at a specified time
                update_fields = {
                    "status": "present",
                    "leave_reason": reason,
                    "leave_type": "early_leave",
                    "is_early_leave": True,
                    "early_leave_time": early_leave_time,
                }
                # If a departure time given and user is punched in without punch-out, record it
                if (
                    early_leave_time
                    and existing
                    and existing.get("punch_in")
                    and not existing.get("punch_out")
                ):
                    try:
                        punch_in_dt = existing["punch_in"]
                        if isinstance(punch_in_dt, str):
                            punch_in_dt = datetime.fromisoformat(punch_in_dt)
                        if punch_in_dt.tzinfo is None:
                            punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
                        # Parse "HH:MM" departure time as IST then convert to UTC
                        h, m = map(int, early_leave_time.split(":"))
                        today_ist = datetime.now(ZoneInfo("Asia/Kolkata")).replace(
                            hour=h, minute=m, second=0, microsecond=0
                        )
                        early_out_utc = today_ist.astimezone(timezone.utc)
                        delta = early_out_utc - punch_in_dt
                        dur = max(0, int(delta.total_seconds() / 60))
                        update_fields["punch_out"] = early_out_utc
                        update_fields["duration_minutes"] = dur
                        update_fields["punched_out_early"] = True
                    except Exception:
                        pass

            await db.attendance.update_one(
                {"user_id": target_user_id, "date": current_str},
                {"$set": update_fields},
                upsert=True,
            )

            # IMPORTANT: Do NOT create a global holidays collection entry for
            # employee-specific half-day leave.  A holiday document is global
            # for a date, so doing that would incorrectly make every employee
            # appear to have a half-day.  The attendance record above is the
            # authoritative per-user source of truth.

            await create_audit_log(
                current_user,
                action="APPLY_LEAVE_FOR_USER" if target_user_id != current_user.id else "APPLY_LEAVE",
                module="attendance",
                record_id=f"{target_user_id}_{current_str}",
                old_data=existing,
                new_data={**update_fields, "target_user_id": target_user_id},
            )

            current += timedelta(days=1)

        # Notify admins with the actual employee for whom the leave was applied.
        try:
            span = (
                from_date.isoformat()
                if from_date == to_date
                else f"{from_date.isoformat()} → {to_date.isoformat()}"
            )
            applicant_name = target_user.get("full_name") or target_user.get("email") or target_user_id
            admin_action = "Admin applied" if target_user_id != current_user.id else "Leave applied"
            await notify_admins_leave(
                applicant_name=applicant_name,
                detail=f"{admin_action}: {leave_type.replace('_', ' ')} · {span} · {reason}",
                exclude_user_id=current_user.id if target_user_id != current_user.id else None,
            )
        except Exception:
            pass

        return {
            "message": "Leave applied successfully",
            "leave_type": leave_type,
            "user_id": target_user_id,
            "user_name": target_user.get("full_name"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.get("/attendance/history", response_model=List[Attendance])
async def get_attendance_history(
    user_id: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    query = {}
    if current_user.role == "admin":
        if user_id:
            query["user_id"] = user_id
        # No user_id from admin = return ALL records (aggregate view)
    elif current_user.role == "manager":
        permissions_mgr = get_user_permissions(current_user)
        # Manager: Own + Team (same department) + explicit cross-visibility list
        team_ids = await get_team_user_ids(current_user.id)
        allowed_users = list(
            set((permissions_mgr.get("view_other_attendance", []) or []) + team_ids)
        )
        if user_id:
            if user_id == current_user.id:
                query["user_id"] = user_id
            else:
                if not permissions_mgr.get("can_view_attendance", False):
                    raise HTTPException(
                        status_code=403,
                        detail="You do not have permission to view other users' attendance",
                    )
                if user_id not in allowed_users:
                    raise HTTPException(
                        status_code=403, detail="This user is outside your team scope"
                    )
                query["user_id"] = user_id
        else:
            if permissions_mgr.get("can_view_attendance", False):
                query["user_id"] = {"$in": list(set(allowed_users + [current_user.id]))}
            else:
                query["user_id"] = current_user.id
    else:
        if user_id and user_id != current_user.id:
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_attendance", [])
            if user_id not in allowed_users:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view other users' attendance",
                )
        query["user_id"] = user_id if user_id else current_user.id
    attendance_list = (
        await db.attendance.find(query, {"_id": 0}).sort("date", -1).to_list(1000)
    )
    for attendance in attendance_list:
        attendance["punch_in"] = safe_dt(attendance.get("punch_in"))
        attendance["punch_out"] = safe_dt(attendance.get("punch_out"))
        if "status" not in attendance:
            attendance["status"] = "present" if attendance.get("punch_in") else "absent"
    return attendance_list


@api_router.get("/attendance/my-summary")
async def get_my_attendance_summary(current_user: User = Depends(get_current_user)):
    now = datetime.now(IST)
    current_month = now.strftime("%Y-%m")
    attendance_list = (
        await db.attendance.find({"user_id": current_user.id}, {"_id": 0})
        .sort("date", -1)
        .to_list(1000)
    )
    monthly_data = {}
    total_minutes_all = 0
    total_days = 0
    for attendance in attendance_list:
        month = attendance["date"][:7]
        if month not in monthly_data:
            monthly_data[month] = {"total_minutes": 0, "days_present": 0}
        duration = attendance.get("duration_minutes")
        if isinstance(duration, (int, float)):
            monthly_data[month]["total_minutes"] += duration
            total_minutes_all += duration
            monthly_data[month]["days_present"] += 1
            total_days += 1
    formatted_data = []
    for month, data in monthly_data.items():
        minutes = data["total_minutes"]
        hours = minutes // 60
        mins = minutes % 60
        formatted_data.append(
            {
                "month": month,
                "total_minutes": minutes,
                "total_hours": f"{hours}h {mins}m",
                "days_present": data["days_present"],
            }
        )
    return {
        "current_month": current_month,
        "total_days": total_days,
        "total_minutes": total_minutes_all,
        "monthly_summary": formatted_data,
    }


@api_router.get("/attendance/staff-report")
async def get_staff_attendance_report(
    month: Optional[str] = None,
    # FIX: was check_module_permission("attendance","view") → can_view_attendance.
    # Any authenticated user can hit this endpoint; data scope is enforced below.
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")
    users = await db.users.find({}, {"_id": 0, "password": 0}).to_list(length=None)
    user_map = {u["id"]: u for u in users}

    # SCOPE enforcement
    attendance_query = {"date": {"$regex": f"^{target_month}"}}
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_others = permissions.get("view_other_attendance", []) or []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_others = list(set(allowed_others + team_ids))
        visible_ids = list(set(allowed_others + [current_user.id]))
        attendance_query["user_id"] = {"$in": visible_ids}

    attendance_list = await db.attendance.find(attendance_query, {"_id": 0}).to_list(
        length=None
    )
    staff_report = {}
    for attendance in attendance_list:
        uid = attendance["user_id"]
        if uid not in staff_report:
            user_info = user_map.get(uid, {})
            staff_report[uid] = {
                "user_id": uid,
                "user_name": user_info.get("full_name", "Unknown"),
                "role": user_info.get("role", "staff"),
                "total_minutes": 0,
                "days_present": 0,
                "days_absent": 0,
                "late_days": 0,
                "early_out_days": 0,
                "records": [],
            }
        # count absent days separately
        if attendance.get("status") == "absent":
            staff_report[uid]["days_absent"] += 1
        duration = attendance.get("duration_minutes")
        if isinstance(duration, (int, float)) and attendance.get("status") == "present":
            staff_report[uid]["total_minutes"] += duration
            staff_report[uid]["days_present"] += 1
        if attendance.get("is_late"):
            staff_report[uid]["late_days"] += 1
        if attendance.get("punched_out_early"):
            staff_report[uid]["early_out_days"] += 1
        staff_report[uid]["records"].append(
            {
                "date": attendance["date"],
                "status": attendance.get("status", "absent"),
                "punch_in": attendance.get("punch_in"),
                "punch_out": attendance.get("punch_out"),
                "duration_minutes": duration,
                "is_late": attendance.get("is_late", False),
                "punched_out_early": attendance.get("punched_out_early", False),
            }
        )
    result = []
    # PERF FIX: calculate_expected_hours() used to re-query db.holidays on
    # every single iteration of this loop (one full collection scan per
    # staff member). Fetching the holiday set once, up front, and reusing it
    # turns N DB round trips into 1 — this was the main reason the Attendance
    # page got slower as headcount grew.
    holidays_cursor = db.holidays.find({"status": "confirmed"})
    holidays_set = {h["date"] for h in await holidays_cursor.to_list(length=None)}
    for uid, data in staff_report.items():
        total_minutes = data["total_minutes"]
        hours = total_minutes // 60
        minutes = total_minutes % 60
        data["total_hours"] = f"{hours}h {minutes}m"
        if data["days_present"] > 0:
            data["avg_hours_per_day"] = round(
                (total_minutes / data["days_present"]) / 60, 1
            )
        else:
            data["avg_hours_per_day"] = 0
        user_data = user_map.get(uid, {})
        year, month_val = map(int, target_month.split("-"))
        _, last_day = calendar.monthrange(year, month_val)
        expected_hours = _expected_hours_pure(
            f"{target_month}-01",
            f"{target_month}-{last_day}",
            user_data.get("punch_in_time", "10:30"),
            user_data.get("punch_out_time", "19:00"),
            holidays_set,
        )
        data["expected_hours"] = expected_hours
        result.append(data)
    result.sort(key=lambda x: x["total_minutes"], reverse=True)
    return result


@api_router.get("/attendance/export-pdf")
async def export_attendance_pdf(
    user_id: str, current_user: User = Depends(get_current_user)
):
    if user_id != current_user.id:
        permissions = get_user_permissions(current_user)
        if current_user.role != "admin" and not permissions.get("can_view_attendance"):
            raise HTTPException(
                status_code=403,
                detail="Not authorized to export other users' attendance",
            )
    records = (
        await db.attendance.find({"user_id": user_id}, {"_id": 0})
        .sort("date", 1)
        .to_list(1000)
    )
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Arial", "B", 14)
    pdf.cell(200, 10, txt="Attendance Report", ln=True, align="C")
    pdf.ln(5)
    pdf.set_font("Arial", size=10)
    for rec in records:
        status = rec.get("status", "unknown")
        late_flag = " [LATE]" if rec.get("is_late") else ""
        early_flag = " [EARLY OUT]" if rec.get("punched_out_early") else ""
        if status == "absent":
            pdf.multi_cell(
                0,
                8,
                f"Date: {rec.get('date')} | Status: ABSENT"
                f"{' [AUTO-MARKED 7PM]' if rec.get('auto_marked') else ''}",
            )
        else:
            pdf.multi_cell(
                0,
                8,
                f"Date: {rec.get('date')} | In: {rec.get('punch_in')} | "
                f"Out: {rec.get('punch_out')} | Duration: {rec.get('duration_minutes')} mins"
                f"{late_flag}{early_flag}",
            )
        pdf.ln(2)
    output = BytesIO()
    output.write(pdf.output(dest="S").encode("latin1"))
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=attendance_{user_id}.pdf"
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# EDIT ATTENDANCE RECORD — Admin / permitted users
# PATCH /api/attendance/edit-record
# ─────────────────────────────────────────────────────────────────────────────
@api_router.patch("/attendance/edit-record")
async def edit_attendance_record(
    data: dict, current_user: User = Depends(require_admin())
):
    """
    Admin-only manual attendance correction.
    Body: { date, user_id, status, note }
    The selected user is the ONLY attendance record that can be changed.
    """
    date_str = data.get("date")
    user_id = data.get("user_id")
    if not user_id or user_id == "everyone":
        raise HTTPException(status_code=400, detail="A specific employee user_id is required")
    status = data.get("status")
    note = data.get("note", "").strip()

    if not date_str or not status:
        raise HTTPException(status_code=400, detail="date and status are required")

    valid_statuses = {"present", "absent", "half_day", "leave", "late", "wfh"}
    if status not in valid_statuses:
        raise HTTPException(
            status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}"
        )

    target_user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "full_name": 1, "is_active": 1, "status": 1},
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="Selected employee not found")
    if target_user.get("is_active") is False or target_user.get("status") == "inactive":
        raise HTTPException(status_code=400, detail="Selected employee is inactive")

    existing = await db.attendance.find_one(
        {"user_id": user_id, "date": date_str}, {"_id": 0}
    )

    update_fields = {
        "status": status,
        "edited_by": current_user.id,
        "edited_at": datetime.now(timezone.utc).isoformat(),
        "admin_note": note or None,
        "auto_marked": False,
    }

    # Status-specific adjustments.  Explicitly clear mutually-exclusive
    # flags so an Admin can safely reverse Half Day → Present/Absent/Leave.
    if status == "present":
        update_fields["is_half_day"] = False
        update_fields["leave_type"] = None
        update_fields["leave_reason"] = None
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "absent":
        update_fields["punch_in"] = None
        update_fields["punch_out"] = None
        update_fields["duration_minutes"] = 0
        update_fields["is_half_day"] = False
        update_fields["leave_type"] = None
        update_fields["leave_reason"] = None
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "leave":
        update_fields["punch_in"] = None
        update_fields["punch_out"] = None
        update_fields["duration_minutes"] = 0
        update_fields["leave_reason"] = note or "Admin marked leave"
        update_fields["leave_type"] = "full_day"
        update_fields["is_half_day"] = False
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "half_day":
        update_fields["is_half_day"] = True
        update_fields["leave_type"] = None
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "late":
        update_fields["is_late"] = True
    elif status == "wfh":
        update_fields["location_type"] = "wfh"

    await db.attendance.update_one(
        {"user_id": user_id, "date": date_str}, {"$set": update_fields}, upsert=True
    )

    # IMPORTANT: Admin-marked Half Day is employee-specific.  Do NOT create
    # or remove a global holidays document here.  The attendance record above
    # is scoped by {user_id, date}, so changing Employee A cannot affect
    # Employee B on the same date.

    await create_audit_log(
        current_user,
        action="EDIT_ATTENDANCE_RECORD",
        module="attendance",
        record_id=f"{user_id}_{date_str}",
        old_data=existing,
        new_data=update_fields,
    )

    return {
        "message": f"Attendance updated to '{status}' for {date_str}",
        "date": date_str,
        "user_id": user_id,
        "status": status,
    }


@api_router.patch("/attendance/admin-reset-punch-out")
async def admin_reset_punch_out(
    data: dict, current_user: User = Depends(require_admin())
):
    """
    Admin-only correction for an accidental punch-out.

    This restores the selected employee's day to an active punched-in state:
      - keeps the original punch_in
      - clears punch_out and punch-out metadata
      - resets duration/overtime/early-out values

    Body: {"date": "YYYY-MM-DD", "user_id": "...", "note": "..."}
    The operation is strictly scoped to {user_id, date}.
    """
    date_str = data.get("date")
    user_id = data.get("user_id")
    note = (data.get("note") or "").strip()

    if not date_str or not user_id or user_id == "everyone":
        raise HTTPException(status_code=400, detail="Specific employee and date are required")

    target_user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "full_name": 1, "is_active": 1, "status": 1},
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="Selected employee not found")
    if target_user.get("is_active") is False or target_user.get("status") == "inactive":
        raise HTTPException(status_code=400, detail="Selected employee is inactive")

    existing = await db.attendance.find_one(
        {"user_id": user_id, "date": date_str}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Attendance record not found")
    if not existing.get("punch_in"):
        raise HTTPException(status_code=400, detail="Employee has no punch-in record to restore")
    if not existing.get("punch_out"):
        raise HTTPException(status_code=400, detail="Punch-out is already cleared")

    update_fields = {
        "punch_out": None,
        "punch_out_location": None,
        "punch_out_source": None,
        "punch_out_device_serial": None,
        "duration_minutes": 0,
        "punched_out_early": False,
        "overtime_minutes": 0,
        "edited_by": current_user.id,
        "edited_at": datetime.now(timezone.utc).isoformat(),
        "admin_note": note or "Admin restored accidental punch-out",
        "auto_marked": False,
    }

    await db.attendance.update_one(
        {"user_id": user_id, "date": date_str},
        {"$set": update_fields},
    )

    await create_audit_log(
        current_user,
        action="ADMIN_RESET_PUNCH_OUT",
        module="attendance",
        record_id=f"{user_id}_{date_str}",
        old_data={
            "punch_in": existing.get("punch_in"),
            "punch_out": existing.get("punch_out"),
            "duration_minutes": existing.get("duration_minutes", 0),
        },
        new_data=update_fields,
    )

    return {
        "message": f"Punch-out restored to active punch-in for {target_user.get('full_name') or user_id}",
        "date": date_str,
        "user_id": user_id,
        "punch_in": existing.get("punch_in"),
        "punch_out": None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# MANUAL ABSENT MARKING ENDPOINT (Admin only)
# POST /api/attendance/mark-absent-bulk
# Body: { "date": "YYYY-MM-DD" }  (optional — defaults to today IST)
# ─────────────────────────────────────────────────────────────────────────────
@api_router.post("/attendance/mark-absent-bulk")
async def mark_absent_bulk(
    data: dict = {}, current_user: User = Depends(require_admin())
):
    """
    Admin-only manual absent marking.

    - user_id supplied: mark ONLY that employee absent.
    - user_id omitted: preserve the explicit bulk/all-active behavior for
      backward compatibility (the frontend disables this path when a specific
      employee is selected so an accidental universal update cannot occur).
    """
    target_date_str = (data or {}).get("date") or datetime.now(IST).date().isoformat()
    target_user_id = (data or {}).get("user_id") or (data or {}).get("target_user_id")
    if target_user_id == "everyone":
        raise HTTPException(status_code=400, detail="Select one specific employee")
    try:
        datetime.strptime(target_date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid date format. Use YYYY-MM-DD."
        )
    result = await _mark_absent_for_date(target_date_str, target_user_id=target_user_id, actor_user_id=current_user.id)
    if target_user_id:
        result["marked_by"] = current_user.id
        if result.get("marked"):
            await create_audit_log(
                current_user,
                action="ADMIN_MARK_ABSENT",
                module="attendance",
                record_id=f"{target_user_id}_{target_date_str}",
                old_data={"status": result.get("previous_status")} if result.get("previous_status") else None,
                new_data={"status": "absent", "user_id": target_user_id, "date": target_date_str},
            )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ABSENT SUMMARY ENDPOINT
# GET /api/attendance/absent-summary?month=YYYY-MM
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/attendance/absent-summary")
async def get_absent_summary(
    month: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    """
    Returns per-user absent day counts for the given month.
    Admin sees all users; non-admins see themselves plus any user
    covered by their "view_other_attendance" cross-visibility permission.
    """
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")

    if current_user.role == "admin":
        query = {"date": {"$regex": f"^{target_month}"}, "status": "absent"}
    else:
        # Non-admins may see this card only for users explicitly granted to
        # them via the "view_other_attendance" cross-visibility permission,
        # in addition to their own record.
        perms = get_user_permissions(current_user)
        cross_ids = list(perms.get("view_other_attendance") or [])
        visible_ids = list(set(cross_ids + [current_user.id]))
        query = {
            "user_id": {"$in": visible_ids},
            "date": {"$regex": f"^{target_month}"},
            "status": "absent",
        }

    absent_records = await db.attendance.find(query, {"_id": 0}).to_list(5000)
    summary: dict = {}
    for rec in absent_records:
        uid = rec["user_id"]
        if uid not in summary:
            summary[uid] = {"user_id": uid, "absent_days": 0, "dates": []}
        summary[uid]["absent_days"] += 1
        summary[uid]["dates"].append(rec["date"])

    # Attach display names for every user in the summary (admin or
    # cross-visibility-permitted viewer), not just admins.
    user_ids = list(summary.keys())
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}
        ).to_list(1000)
        name_map = {u["id"]: u["full_name"] for u in users}
        for uid in summary:
            summary[uid]["user_name"] = name_map.get(uid, "Unknown")

    return {"month": target_month, "data": list(summary.values())}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/attendance/leave-summary?month=YYYY-MM
# Mirrors /attendance/absent-summary but for users on applied leave.
# Admin sees everyone; non-admins see only users covered by their
# "view_other_attendance" cross-visibility permission (plus themselves).
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/attendance/leave-summary")
async def get_leave_summary(
    month: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    """
    Returns per-user applied-leave details for the given month, including
    the reason, leave type, and dates for each leave record — so an admin
    (or a permitted cross-visibility viewer) can drill into why someone
    applied for leave.
    """
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")

    if current_user.role == "admin":
        query = {"date": {"$regex": f"^{target_month}"}, "status": "leave"}
    else:
        perms = get_user_permissions(current_user)
        cross_ids = list(perms.get("view_other_attendance") or [])
        visible_ids = list(set(cross_ids + [current_user.id]))
        query = {
            "user_id": {"$in": visible_ids},
            "date": {"$regex": f"^{target_month}"},
            "status": "leave",
        }

    leave_records = await db.attendance.find(query, {"_id": 0}).to_list(5000)
    summary: dict = {}
    for rec in leave_records:
        uid = rec["user_id"]
        if uid not in summary:
            summary[uid] = {"user_id": uid, "leave_days": 0, "records": []}
        summary[uid]["leave_days"] += 1
        summary[uid]["records"].append(
            {
                "date": rec.get("date"),
                "leave_type": rec.get("leave_type", "full_day"),
                "reason": rec.get("leave_reason"),
                "early_leave_time": rec.get("early_leave_time"),
                "punch_in": rec.get("punch_in"),
                "punch_out": rec.get("punch_out"),
            }
        )

    user_ids = list(summary.keys())
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}
        ).to_list(1000)
        name_map = {u["id"]: u["full_name"] for u in users}
        for uid in summary:
            summary[uid]["user_name"] = name_map.get(uid, "Unknown")

    return {"month": target_month, "data": list(summary.values())}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/attendance/location-summary?month=YYYY-MM
# Mirrors /attendance/absent-summary and /attendance/leave-summary but for
# GPS punch-in/punch-out locations. Unlike those two, this is visible to
# EVERY user (not just admins / cross-visibility-permitted viewers) — the
# frontend calls it unconditionally on the Attendance page. The same
# visibility rule as the other summaries still applies underneath: admins
# see every user's location days, everyone else sees their own plus any
# user covered by their "view_other_attendance" cross-visibility
# permission — for a regular user with no cross-visibility grant, that
# just means "only myself", which is exactly what "visible to all users"
# should mean for a self-service GPS log.
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/attendance/location-summary")
async def get_location_summary(
    month: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    """
    Returns per-user GPS punch-in/punch-out location records for the given
    month, for any day that captured at least one location. Powers the
    "Location History" drill-down card and the reverse-geocode pre-warm
    effect on the Attendance page.
    """
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")

    base_filter = {
        "date": {"$regex": f"^{target_month}"},
        "$or": [
            {"location": {"$exists": True, "$ne": None}},
            {"punch_out_location": {"$exists": True, "$ne": None}},
        ],
    }
    if current_user.role == "admin":
        query = base_filter
    else:
        perms = get_user_permissions(current_user)
        cross_ids = list(perms.get("view_other_attendance") or [])
        visible_ids = list(set(cross_ids + [current_user.id]))
        query = {"user_id": {"$in": visible_ids}, **base_filter}

    location_records = await db.attendance.find(query, {"_id": 0}).to_list(5000)
    summary: dict = {}
    for rec in location_records:
        uid = rec["user_id"]
        if uid not in summary:
            summary[uid] = {"user_id": uid, "location_days": 0, "records": []}
        summary[uid]["location_days"] += 1
        summary[uid]["records"].append(
            {
                "date": rec.get("date"),
                "punch_in": rec.get("punch_in"),
                "punch_out": rec.get("punch_out"),
                # DB stores the punch-in location under "location"; the
                # frontend's Location History modal reads it as
                # "punch_in_location" (to sit alongside punch_out_location).
                "punch_in_location": rec.get("location"),
                "punch_out_location": rec.get("punch_out_location"),
            }
        )

    user_ids = list(summary.keys())
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}
        ).to_list(1000)
        name_map = {u["id"]: u["full_name"] for u in users}
        for uid in summary:
            summary[uid]["user_name"] = name_map.get(uid, "Unknown")

    return {"month": target_month, "data": list(summary.values())}


# =============================================================
# NEW: POST /attendance/punch-out
# Dedicated auto punch-out endpoint.
# Called by the frontend Smart Auto Punch-Out feature when the
# user is inactive for >60 minutes after the shift grace period.
# Falls back gracefully if the user is already punched out.
# =============================================================
@api_router.post("/attendance/punch-out")
async def auto_punch_out(data: dict, current_user: User = Depends(get_current_user)):
    """
    Auto punch-out triggered by the frontend inactivity detector.
    Accepts { auto: true, reason: "inactive_after_shift" }.
    Records overtime_minutes (minutes worked past 7 PM IST).
    """
    today_str = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()

    attendance = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0}
    )
    if not attendance or not attendance.get("punch_in"):
        raise HTTPException(status_code=400, detail="Not punched in yet")
    if attendance.get("punch_out"):
        # A second punch-out is never permitted. The only way to reopen the
        # attendance record is through the admin reset/edit workflow.
        raise HTTPException(
            status_code=409,
            detail="Punch Out already recorded. A second Punch Out is not allowed unless an administrator edits/resets the previous Punch Out."
        )

    punch_in_dt = attendance.get("punch_in")
    punch_out_utc = datetime.now(timezone.utc)
    punch_out_ist = punch_out_utc.astimezone(ZoneInfo("Asia/Kolkata"))

    # Normalise punch_in to aware datetime
    if isinstance(punch_in_dt, datetime):
        if punch_in_dt.tzinfo is None:
            punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
    else:
        try:
            punch_in_dt = datetime.fromisoformat(str(punch_in_dt))
            if punch_in_dt.tzinfo is None:
                punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
        except Exception:
            punch_in_dt = punch_out_utc

    delta = punch_out_utc - punch_in_dt.astimezone(timezone.utc)
    duration_minutes = max(0, int(delta.total_seconds() / 60))

    # Fetch user doc first so we can use their personal shift-end time
    user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0})
    punched_out_early = check_punched_out_early(user_doc or {}, punch_out_ist)

    # Overtime: minutes worked past this user's own punch_out_time
    _pot_str = (user_doc or {}).get("punch_out_time") or "19:00"
    try:
        _pot = datetime.strptime(_pot_str, "%H:%M")
    except ValueError:
        _pot = datetime.strptime("19:00", "%H:%M")
    shift_end_ist = punch_out_ist.replace(
        hour=_pot.hour, minute=_pot.minute, second=0, microsecond=0
    )
    overtime_minutes = 0
    if punch_out_ist > shift_end_ist:
        overtime_minutes = max(
            0, int((punch_out_ist - shift_end_ist).total_seconds() / 60)
        )

    update_fields = {
        "punch_out": punch_out_utc,
        "punched_out_early": punched_out_early,
        "duration_minutes": duration_minutes,
        "auto_punch_out": True,
        "auto_punch_reason": data.get("reason", "inactive_after_shift"),
        "overtime_minutes": overtime_minutes,
    }

    await db.attendance.update_one(
        {"user_id": current_user.id, "date": today_str}, {"$set": update_fields}
    )

    logger.info(
        "Auto punch-out: user=%s date=%s duration=%dm overtime=%dm reason=%s",
        current_user.id,
        today_str,
        duration_minutes,
        overtime_minutes,
        data.get("reason", "inactive_after_shift"),
    )

    return {
        "message": "Auto punch-out recorded",
        "duration": duration_minutes,
        "overtime_minutes": overtime_minutes,
        "auto": True,
    }


# =============================================================
# NEW: POST /attendance/proof
# Upload photos, documents, and a note as attendance proof.
# Example: "Visited client → upload photo".
# Files are saved to uploads/attendance_proof/ on the server.
# The proof dict is embedded inside the attendance document.
# =============================================================
ALLOWED_PHOTO_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
}
ALLOWED_DOC_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
}
MAX_FILE_SIZE_MB = 10
MAX_FILES_PER_UPLOAD = 5


@api_router.post("/attendance/proof")
async def upload_attendance_proof(
    note: str = Form(default=""),
    photos: List[UploadFile] = File(default=[]),
    documents: List[UploadFile] = File(default=[]),
    current_user: User = Depends(get_current_user),
):
    """
    Attach proof to today's attendance record.
    - note:      free-text description (e.g. "Visited ABC client office")
    - photos:    up to 5 image files (JPEG, PNG, WebP, GIF, HEIC)
    - documents: up to 5 document files (PDF, DOC, DOCX, XLS, XLSX, TXT, CSV)

    Each call REPLACES the existing proof for today (idempotent upsert).
    """
    today_str = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Validate counts
    if len(photos) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_FILES_PER_UPLOAD} photos allowed"
        )
    if len(documents) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_FILES_PER_UPLOAD} documents allowed"
        )

    saved_photos: List[str] = []
    saved_docs: List[str] = []

    # ── Save photos ────────────────────────────────────────────────────────────
    for photo in photos:
        if not photo.filename:
            continue
        content_type = photo.content_type or ""
        if content_type not in ALLOWED_PHOTO_TYPES and not content_type.startswith(
            "image/"
        ):
            raise HTTPException(
                status_code=400,
                detail=f"File '{photo.filename}' is not an allowed image type",
            )
        contents = await photo.read()
        if len(contents) > MAX_FILE_SIZE_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"Photo '{photo.filename}' exceeds {MAX_FILE_SIZE_MB} MB limit",
            )
        safe_name = re.sub(r"[^\w.\-]", "_", photo.filename)
        filename = (
            f"{current_user.id}_{today_str}_photo_{uuid.uuid4().hex[:8]}_{safe_name}"
        )
        file_path = PROOF_UPLOAD_DIR / filename
        with open(file_path, "wb") as f:
            f.write(contents)
        saved_photos.append(filename)
        await photo.seek(0)  # reset for any downstream use

    # ── Save documents ─────────────────────────────────────────────────────────
    for doc in documents:
        if not doc.filename:
            continue
        content_type = doc.content_type or ""
        if content_type not in ALLOWED_DOC_TYPES and not doc.filename.lower().endswith(
            (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv")
        ):
            raise HTTPException(
                status_code=400,
                detail=f"File '{doc.filename}' is not an allowed document type",
            )
        contents = await doc.read()
        if len(contents) > MAX_FILE_SIZE_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"Document '{doc.filename}' exceeds {MAX_FILE_SIZE_MB} MB limit",
            )
        safe_name = re.sub(r"[^\w.\-]", "_", doc.filename)
        filename = (
            f"{current_user.id}_{today_str}_doc_{uuid.uuid4().hex[:8]}_{safe_name}"
        )
        file_path = PROOF_UPLOAD_DIR / filename
        with open(file_path, "wb") as f:
            f.write(contents)
        saved_docs.append(filename)
        await doc.seek(0)

    # ── Build proof dict ───────────────────────────────────────────────────────
    # Check if a previous proof exists so we can merge (not replace) file lists
    existing = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0, "proof": 1}
    )
    existing_proof = existing.get("proof", {}) if existing else {}

    # Merge: keep old files, append new ones
    merged_photos = (existing_proof.get("photos") or []) + saved_photos
    merged_docs = (existing_proof.get("documents") or []) + saved_docs

    proof_payload = {
        "note": note.strip() if note.strip() else (existing_proof.get("note") or ""),
        "photos": merged_photos,
        "documents": merged_docs,
        "uploaded_at": existing_proof.get("uploaded_at")
        or now_iso,  # first upload time
        "updated_at": now_iso,  # last update time
    }

    await db.attendance.update_one(
        {"user_id": current_user.id, "date": today_str},
        {"$set": {"proof": proof_payload}},
        upsert=True,
    )

    logger.info(
        "Proof uploaded: user=%s date=%s photos=%d docs=%d note_len=%d",
        current_user.id,
        today_str,
        len(saved_photos),
        len(saved_docs),
        len(note),
    )

    return {
        "message": "Proof saved successfully",
        "photos_saved": len(saved_photos),
        "documents_saved": len(saved_docs),
        "note_saved": bool(note.strip()),
        "total_photos": len(merged_photos),
        "total_documents": len(merged_docs),
        "date": today_str,
    }


# ====================================================================================
# SALARY / PAYROLL — attendance-based salary due calculation
# ====================================================================================
# Policy (as configured by admin):
#   • Absent day                          → deduct 1.0 day's pay
#   • Half-day (leave or marked half_day) → deduct 0.5 day's pay
#   • Late punch-in (after punch_in_time + grace, default 10:30 + 00:10 = 10:40 AM)
#         OR early punch-out (before 6:00 PM)  → deduct 0.5 day's pay
#   • Both late-in AND early-out on the same day → deduct 1.0 day's pay (capped)
#   • Per-day rate = monthly_salary / TOTAL CALENDAR DAYS in that month
#     (Sundays are already treated as the weekly holiday inside attendance,
#      so the full number of days in the month — including Sundays — is used
#      as the denominator, not just Mon-Sat working days).
#   • Sunday is a holiday by default (no deduction, not counted as absent),
#     EXCEPT when it's a "continuing holiday": if the employee was ALSO
#     absent on the Saturday immediately before AND the Monday immediately
#     after, the leave is treated as spanning straight across the weekend,
#     so Sunday is deducted as an absent day too.
#   • Confirmed/declared company holidays (any day of the week) are always
#     a paid day off — never deducted.
#   • Saturday is a normal working day, subject to the same
#     absent/half-day/late/early-out rules as Mon-Fri.
EARLY_OUT_CUTOFF_MINUTES = 18 * 60  # 6:00 PM — fixed company policy cutoff


def _hhmm_to_minutes(value: Optional[str], default: str) -> int:
    try:
        t = datetime.strptime(value or default, "%H:%M")
        return t.hour * 60 + t.minute
    except Exception:
        d = datetime.strptime(default, "%H:%M")
        return d.hour * 60 + d.minute


async def _compute_salary_report_for_user(
    user: dict, year: int, mon: int, holiday_data: dict
) -> dict:
    """Builds the salary-due breakdown for a single user for a given month.

    Priority rule (per date, only one status may affect salary):
      Holiday (full) → Leave → Half-Day → Present/Absent → Early Leave

    holiday_data: dict of {date_str: holiday_doc} for ALL confirmed holidays,
    including type='half_day' entries.  Full holidays (type != 'half_day')
    give 0.0 deduction; half-day holidays give 0.5 deduction.

    When a date is marked as Half-Day (via attendance record OR holiday type),
    Early Leave is completely ignored for that date — no early-leave deduction
    is applied.
    """
    first_day = date(year, mon, 1)
    last_day_num = calendar.monthrange(year, mon)[1]
    last_day = date(year, mon, last_day_num)

    now_ist = datetime.now(IST)
    today_ist = now_ist.date()
    if (year, mon) == (today_ist.year, today_ist.month):
        effective_last_day = min(last_day, today_ist)
    elif date(year, mon, 1) > today_ist:
        effective_last_day = first_day - timedelta(days=1)  # future month → empty
    else:
        effective_last_day = last_day

    start_str = first_day.isoformat()
    end_str = last_day.isoformat()

    # Per-day rate = monthly_salary / TOTAL CALENDAR DAYS in the month
    # (includes Sundays — they're accounted for separately as holidays below,
    #  not excluded from the denominator).
    total_working_days = max(last_day_num, 1)

    monthly_salary = float(user.get("monthly_salary") or 0)
    per_day_salary = monthly_salary / total_working_days

    late_deadline_min = _hhmm_to_minutes(
        user.get("punch_in_time"), "10:30"
    ) + (_hhmm_to_minutes(user.get("grace_time"), "00:10"))

    # Derive separate date sets from holiday_data for clarity:
    #   full_holiday_dates  — paid day off, 0.0 deduction (type != 'half_day')
    #   half_day_holiday_dates — company half-day, 0.5 deduction (type == 'half_day')
    full_holiday_dates = {
        d for d, h in holiday_data.items() if h.get("type") != "half_day"
    }
    half_day_holiday_dates = {
        d for d, h in holiday_data.items() if h.get("type") == "half_day"
    }
    # All holiday dates (used for Sunday continuation-leave check)
    all_holiday_dates = set(holiday_data.keys())

    # Fetch with a 1-day buffer on each side so a Sunday that falls on the
    # 1st or last day of the month can still look at the adjacent Sat/Mon
    # attendance record when deciding whether it's a "continuing holiday".
    fetch_start = (first_day - timedelta(days=1)).isoformat()
    fetch_end = (last_day + timedelta(days=1)).isoformat()
    att_records = await db.attendance.find(
        {"user_id": user["id"], "date": {"$gte": fetch_start, "$lte": fetch_end}},
        {"_id": 0},
    ).to_list(500)
    att_by_date = {r["date"]: r for r in att_records}

    def _is_absent_on(iso_date: str) -> bool:
        """True if the given date counts as a full absence (no half-day).
        A date that is any kind of holiday (full or half_day) is never absent."""
        if iso_date in all_holiday_dates:
            return False
        rec = att_by_date.get(iso_date)
        if not rec:
            return True
        status = rec.get("status") or "absent"
        is_half_day = bool(rec.get("is_half_day") or status == "half_day")
        if is_half_day:
            return False
        return status in ("absent", "leave")

    days = []
    working_days_elapsed = 0
    present_days = 0
    absent_days = 0
    half_days = 0
    late_days = 0
    early_out_days = 0
    holiday_days = 0
    total_deduction_days = 0.0

    d = first_day
    while d <= effective_last_day:
        iso = d.isoformat()

        # ── Priority 1: Full confirmed company holiday → paid day off (0.0) ──
        if iso in full_holiday_dates:
            days.append({
                "date": iso, "status": "holiday", "deduction": 0.0,
                "is_late": False, "early_out": False,
            })
            holiday_days += 1
            d += timedelta(days=1)
            continue

        # ── Sunday → weekly holiday by default. Only deducted as an absent
        # day when it's a "continuing holiday" — the employee was also
        # absent on the Saturday before AND the Monday after.
        if d.weekday() == 6:
            monday = d + timedelta(days=1)
            saturday_iso = (d - timedelta(days=1)).isoformat()
            monday_iso = monday.isoformat()
            monday_has_elapsed = monday <= effective_last_day
            continuing_leave = (
                monday_has_elapsed
                and _is_absent_on(saturday_iso)
                and _is_absent_on(monday_iso)
            )
            if continuing_leave:
                days.append({
                    "date": iso, "status": "absent", "deduction": 1.0,
                    "is_late": False, "early_out": False,
                })
                absent_days += 1
                total_deduction_days += 1.0
            else:
                days.append({
                    "date": iso, "status": "holiday", "deduction": 0.0,
                    "is_late": False, "early_out": False,
                })
                holiday_days += 1
            d += timedelta(days=1)
            continue

        # ── Monday–Saturday → normal working day ──
        working_days_elapsed += 1
        rec = att_by_date.get(iso)
        status = (rec or {}).get("status") or "absent"

        # ── Priority 2: Company-declared half-day (in holidays collection) ──
        # Treat as half-day; Early Leave is completely ignored.
        if iso in half_day_holiday_dates:
            days.append({
                "date": iso, "status": "half_day", "deduction": 0.5,
                "is_late": False, "early_out": False,
                "half_day_source": "holiday",
            })
            half_days += 1
            total_deduction_days += 0.5
            d += timedelta(days=1)
            continue

        # Check if attendance record marks this as a half-day
        is_half_day = bool(rec and (rec.get("is_half_day") or status == "half_day"))

        day_info = {
            "date": iso, "status": "absent", "deduction": 1.0,
            "is_late": False, "early_out": False,
        }

        # ── Priority 3: Absent / Leave (full day) ──
        if not rec or (status in ("absent",) and not is_half_day) or (
            status == "leave" and not is_half_day
        ):
            day_info["status"] = "absent"
            day_info["deduction"] = 1.0
            absent_days += 1

        # ── Priority 4: Half-Day (attendance record) ──
        # Early Leave is completely ignored when half-day is in effect.
        elif is_half_day:
            day_info["status"] = "half_day"
            day_info["deduction"] = 0.5
            half_days += 1

        # ── Priority 5: Present — check Late and Early Leave ──
        else:
            is_late = bool(rec.get("is_late"))

            # Early Leave is only evaluated when there is NO half-day on this date.
            # If the attendance record carries leave_type='early_leave' but the
            # date is already a half-day, Early Leave is suppressed entirely.
            is_early_leave_record = rec.get("leave_type") == "early_leave" or bool(
                rec.get("is_early_leave")
            )
            # is_half_day already False here; double-guard at record level.
            suppress_early_leave = is_half_day  # always False in this branch — kept for clarity

            early_out = False
            punch_out = rec.get("punch_out")
            if punch_out and not suppress_early_leave:
                try:
                    pout_dt = (
                        punch_out if isinstance(punch_out, datetime)
                        else datetime.fromisoformat(str(punch_out))
                    )
                    if pout_dt.tzinfo is None:
                        pout_dt = pout_dt.replace(tzinfo=timezone.utc)
                    pout_ist = pout_dt.astimezone(IST)
                    early_out = (pout_ist.hour * 60 + pout_ist.minute) < EARLY_OUT_CUTOFF_MINUTES
                except Exception:
                    early_out = False

            deduction = 0.0
            if is_late:
                deduction += 0.5
                late_days += 1
            if early_out:
                deduction += 0.5
                early_out_days += 1
            deduction = min(deduction, 1.0)

            day_info["is_late"] = is_late
            day_info["early_out"] = early_out
            day_info["deduction"] = deduction
            if deduction == 0:
                day_info["status"] = "present"
                present_days += 1
            else:
                day_info["status"] = "late" if is_late and not early_out else (
                    "early_out" if early_out and not is_late else "late_and_early_out"
                )

        total_deduction_days += day_info["deduction"]
        days.append(day_info)
        d += timedelta(days=1)

    deduction_amount = round(per_day_salary * total_deduction_days, 2)
    payable_salary = round(monthly_salary - deduction_amount, 2)

    return {
        "user_id": user["id"],
        "full_name": user.get("full_name"),
        "email": user.get("email"),
        "profile_picture": user.get("profile_picture"),
        "departments": user.get("departments") or [],
        "month": f"{year:04d}-{mon:02d}",
        "monthly_salary": round(monthly_salary, 2),
        "total_working_days": total_working_days,
        "working_days_elapsed": working_days_elapsed,
        "per_day_salary": round(per_day_salary, 2),
        "present_days": present_days,
        "absent_days": absent_days,
        "half_days": half_days,
        "late_days": late_days,
        "early_out_days": early_out_days,
        "holiday_days": holiday_days,
        "total_deduction_days": round(total_deduction_days, 2),
        "deduction_amount": deduction_amount,
        "payable_salary": payable_salary,
        "late_after": f"{late_deadline_min // 60:02d}:{late_deadline_min % 60:02d}",
        "early_out_before": "18:00",
        "days": days,
    }


async def _get_confirmed_holiday_dates(start_str: str, end_str: str) -> set:
    """Returns set of FULL confirmed holiday dates (excludes half_day type)."""
    holiday_docs = await db.holidays.find(
        {
            "date": {"$gte": start_str, "$lte": end_str},
            "status": "confirmed",
            "type": {"$ne": "half_day"},
        },
        {"_id": 0, "date": 1},
    ).to_list(500)
    return {h["date"] for h in holiday_docs}


async def _get_confirmed_holiday_data(start_str: str, end_str: str) -> dict:
    """Returns dict of {date: holiday_doc} for all confirmed holidays (including half_day type).
    Full holidays (type != 'half_day') → 0.0 deduction (paid day off).
    Half-day holidays (type == 'half_day') → 0.5 deduction."""
    holiday_docs = await db.holidays.find(
        {"date": {"$gte": start_str, "$lte": end_str}, "status": "confirmed"},
        {"_id": 0, "date": 1, "name": 1, "type": 1},
    ).to_list(500)
    return {h["date"]: h for h in holiday_docs}


async def _upsert_half_day_holiday(date_str: str) -> None:
    """Upsert a 'half_day' type entry into the holidays collection for display
    on the Holiday Card and Attendance Calendar.  Only writes if no full
    (non-half_day) confirmed holiday already exists for that date."""
    existing = await db.holidays.find_one({"date": date_str}, {"_id": 0, "type": 1, "status": 1})
    if existing:
        if existing.get("status") == "confirmed" and existing.get("type") != "half_day":
            # A real full holiday already owns this date — leave it untouched.
            return
        # Update existing pending/half_day entry → confirm as half_day
        await db.holidays.update_one(
            {"date": date_str},
            {
                "$set": {
                    "name": "Half Day",
                    "status": "confirmed",
                    "type": "half_day",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
    else:
        try:
            await db.holidays.insert_one(
                {
                    "date": date_str,
                    "name": "Half Day",
                    "status": "confirmed",
                    "type": "half_day",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        except Exception:
            # Race condition — another request inserted it; ignore.
            pass


async def _remove_half_day_holiday(date_str: str) -> None:
    """Remove a 'half_day' holiday entry when the half-day attendance is
    overridden or removed.  Never removes real full holidays."""
    await db.holidays.delete_one({"date": date_str, "type": "half_day"})


def _parse_month_param(month: Optional[str]) -> tuple:
    if month:
        try:
            year_s, mon_s = month.split("-")
            year, mon = int(year_s), int(mon_s)
            if not (1 <= mon <= 12):
                raise ValueError
            return year, mon
        except Exception:
            raise HTTPException(
                status_code=400, detail="month must be in YYYY-MM format"
            )
    now_ist = datetime.now(IST)
    return now_ist.year, now_ist.month


@api_router.get("/users/salary-report-all")
async def get_salary_report_all(
    month: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Admin-only: salary-due summary for every user with a monthly_salary set."""
    if current_user.role.lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    year, mon = _parse_month_param(month)
    first_day = date(year, mon, 1)
    last_day = date(year, mon, calendar.monthrange(year, mon)[1])
    # Use full holiday_data (includes type info) so _compute_salary_report_for_user
    # can distinguish full holidays from half-day holidays.
    holiday_data = await _get_confirmed_holiday_data(
        first_day.isoformat(), last_day.isoformat()
    )

    users = await db.users.find(
        {"is_active": True},
        {
            "_id": 0, "id": 1, "full_name": 1, "email": 1, "profile_picture": 1,
            "departments": 1, "monthly_salary": 1, "punch_in_time": 1,
            "grace_time": 1, "role": 1,
        },
    ).to_list(1000)

    reports = []
    for u in users:
        if u.get("monthly_salary") in (None, 0):
            continue
        report = await _compute_salary_report_for_user(u, year, mon, holiday_data)
        report.pop("days", None)  # keep the summary list lightweight
        reports.append(report)

    reports.sort(key=lambda r: (r.get("full_name") or "").lower())
    return {"month": f"{year:04d}-{mon:02d}", "reports": reports}


@api_router.get("/users/{user_id}/salary-report")
async def get_salary_report_for_user(
    user_id: str,
    month: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Detailed day-by-day salary-due breakdown for one user (admin, or self)."""
    if current_user.role.lower() != "admin" and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Not allowed")

    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    year, mon = _parse_month_param(month)
    first_day = date(year, mon, 1)
    last_day = date(year, mon, calendar.monthrange(year, mon)[1])
    # Use full holiday_data (includes type info) so priority logic is applied correctly.
    holiday_data = await _get_confirmed_holiday_data(
        first_day.isoformat(), last_day.isoformat()
    )
    return await _compute_salary_report_for_user(user, year, mon, holiday_data)


async def get_top_performers_data(period: str = "monthly", limit: int = 5, db=None):
    now = datetime.now(IST)
    if period == "weekly":
        start_date = now - timedelta(days=7)
    elif period == "monthly":
        start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start_date = datetime(2024, 1, 1, tzinfo=timezone.utc)
    pipeline = [
        {
            "$match": {
                "status": "completed",
                "assigned_to": {"$ne": None},
                "$or": [
                    {"completed_at": {"$gte": start_date.isoformat()}},
                    {"updated_at": {"$gte": start_date.isoformat()}},
                ],
            }
        },
        {"$group": {"_id": "$assigned_to", "completed_tasks": {"$sum": 1}}},
        {
            "$lookup": {
                "from": "users",
                "localField": "_id",
                "foreignField": "id",
                "as": "user_info",
            }
        },
        {"$unwind": "$user_info"},
        {
            "$project": {
                "user_id": "$_id",
                "user_name": "$user_info.full_name",
                "profile_picture": "$user_info.profile_picture",
                "completed_tasks": 1,
            }
        },
        {"$sort": {"completed_tasks": -1}},
        {"$limit": limit},
    ]
    performers = await db.tasks.aggregate(pipeline).to_list(limit)
    for idx, p in enumerate(performers):
        p["rank"] = idx + 1
    return performers


# Task routes
@api_router.post("/tasks", response_model=Task)
async def create_task(
    task_data: TaskCreate,
    # GLITCH FIX: previously gated behind check_module_permission("tasks", "create")
    # which required the universal `can_edit_tasks` flag for EVERYONE, including
    # a user creating their own task. Per spec, every user can create their own
    # task by default; only assigning a task to a DIFFERENT user needs extra
    # permission (checked below via can_assign_tasks OR cross-visibility).
    current_user: User = Depends(get_current_user),
):
    if (
        task_data.assigned_to
        and task_data.assigned_to != current_user.id
        and current_user.role != "admin"
    ):
        perms = get_user_permissions(current_user)
        # GLITCH FIX: a user who has been granted cross-visibility to another
        # user (view_other_tasks) should also be able to create/assign tasks
        # for that user, not just view them.
        cross_visible_users = perms.get("view_other_tasks", []) or []
        if (
            not perms.get("can_assign_tasks", False)
            and task_data.assigned_to not in cross_visible_users
        ):
            raise HTTPException(
                status_code=403,
                detail="You do not have permission to assign tasks to other users",
            )
    task_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    task = Task(
        **task_data.model_dump(),
        id=task_id,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    doc = task.model_dump()
    date_fields = ["created_at", "updated_at", "due_date", "recurrence_end_date"]
    for field in date_fields:
        if doc.get(field) and isinstance(doc[field], datetime):
            doc[field] = doc[field].isoformat()
    await db.tasks.insert_one(doc)
    if task.assigned_to and task.assigned_to != current_user.id:
        await create_notification(
            user_id=task.assigned_to,
            title="New Task Assigned",
            message=f"You have been assigned task '{task.title}'",
            type="assignment",
        )
        await create_task_assigned_popup(task.assigned_to, task.title)
    await create_audit_log(
        current_user=current_user,
        action="CREATE_TASK",
        module="tasks",
        record_id=task_id,
        new_data={"title": task.title},
    )
    return task


@api_router.get("/tasks/{task_id}/comments")
async def get_task_comments(
    task_id: str, current_user: User = Depends(get_current_user)
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    is_admin = getattr(current_user, "role", "").lower() == "admin"
    is_involved = is_own_record(current_user, task)
    if not is_admin and not is_involved:
        raise HTTPException(
            status_code=403, detail="Unauthorized to view these comments"
        )
    return task.get("comments", [])


@api_router.post("/tasks/bulk")
async def create_tasks_bulk(
    payload: BulkTaskCreate,
    # GLITCH FIX: see create_task above — creating your own task(s) must not
    # require the universal can_edit_tasks flag.
    current_user: User = Depends(get_current_user),
):
    created_tasks = []
    for task_data in payload.tasks:
        task_dict = task_data.model_dump()
        task_dict["id"] = str(uuid.uuid4())
        task_dict["created_by"] = current_user.id
        task_dict["created_at"] = datetime.now(IST).isoformat()
        task_dict["updated_at"] = datetime.now(IST).isoformat()
        if task_dict.get("due_date"):
            task_dict["due_date"] = task_dict["due_date"].isoformat()
        await db.tasks.insert_one(task_dict)
        if task_dict.get("assigned_to") and task_dict["assigned_to"] != current_user.id:
            await create_notification(
                user_id=task_dict["assigned_to"],
                title="New Task Assigned",
                message=f"You have been assigned task '{task_dict['title']}'",
            )
            await create_task_assigned_popup(task_dict["assigned_to"], task_dict["title"])
        created_tasks.append(task_dict)
    return {"message": "Tasks created successfully", "count": len(created_tasks)}


@api_router.post("/tasks/import")
async def import_tasks_from_csv(
    file: UploadFile = File(...),
    # GLITCH FIX: see create_task above — creating your own task(s) must not
    # require the universal can_edit_tasks flag.
    current_user: User = Depends(get_current_user),
):
    if file.content_type != "text/csv":
        raise HTTPException(400, "Invalid file type")
    content = await file.read()
    content_str = content.decode("utf-8")
    csv_reader = csv.DictReader(StringIO(content_str))
    tasks = []
    for row in csv_reader:
        task_data = TaskCreate(
            title=row.get("title", ""),
            description=row.get("description"),
            assigned_to=row.get("assigned_to"),
            sub_assignees=row.get("sub_assignees", "").split(",")
            if row.get("sub_assignees")
            else [],
            due_date=parser.parse(row["due_date"]) if row.get("due_date") else None,
            priority=row.get("priority", "medium"),
            status=row.get("status", "pending"),
            category=row.get("category", "other"),
            client_id=row.get("client_id"),
            is_recurring=bool(row.get("is_recurring", False)),
            recurrence_pattern=row.get("recurrence_pattern", "monthly"),
            recurrence_interval=int(row.get("recurrence_interval", 1)),
        )
        tasks.append(task_data)
    payload = BulkTaskCreate(tasks=tasks)
    return await create_tasks_bulk(payload, current_user)


@api_router.get("/tasks")
async def get_tasks(
    current_user: User = Depends(check_module_permission("tasks", "view")),
    page: Optional[int] = Query(None, ge=1, description="Optional: page number for paginated response"),
    page_size: Optional[int] = Query(None, ge=1, le=500, description="Optional: results per page (only used if `page` is set)"),
):
    """
    BUG FIX: this used to hard-cap at .to_list(1000) — any company with more
    than 1000 tasks silently lost the rest with no error or indication.
    Now fetches everything the (permission-scoped) query matches.

    Pagination is opt-in and backward compatible: existing callers that don't
    pass `page` get the same shape as before (a plain array, unpaginated) —
    nothing breaks. Pass `page` (and optionally `page_size`, default 100) to
    get back a paginated {tasks, total, page, page_size, total_pages} object
    instead, for future adoption by list views that don't need the whole
    dataset client-side at once.
    """
    query = {"type": {"$ne": "todo"}}
    if current_user.role == "admin":
        pass
    else:
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        or_clauses = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
        if allowed_users:
            or_clauses.append({"assigned_to": {"$in": allowed_users}})
            or_clauses.append({"created_by": {"$in": allowed_users}})
        query["$or"] = or_clauses

    total = None
    if page is not None:
        page_size = page_size or 100
        total = await db.tasks.count_documents(query)
        skip = (page - 1) * page_size
        tasks = (
            await db.tasks.find(query, {"_id": 0})
            .sort("created_at", -1)
            .skip(skip)
            .limit(page_size)
            .to_list(page_size)
        )
    else:
        tasks = await db.tasks.find(query, {"_id": 0}).to_list(length=None)

    user_ids = {
        task.get("assigned_to") for task in tasks if task.get("assigned_to")
    } | {task.get("created_by") for task in tasks if task.get("created_by")}
    users = await db.users.find(
        {"id": {"$in": list(user_ids)}}, {"_id": 0, "password": 0}
    ).to_list(length=None)
    user_map = {u["id"]: u["full_name"] for u in users}
    for task in tasks:
        task["created_at"] = safe_dt(task.get("created_at"))
        task["updated_at"] = safe_dt(task.get("updated_at"))
        task["due_date"] = safe_dt(task.get("due_date"))
        task["assigned_to_name"] = user_map.get(task.get("assigned_to"), "Unknown")
        task["created_by_name"] = user_map.get(task.get("created_by"), "Unknown")
        if not isinstance(task.get("sub_assignees"), list):
            task["sub_assignees"] = []
        if not isinstance(task.get("comments"), list):
            task["comments"] = []

    if page is not None:
        return {
            "tasks": tasks,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, -(-total // page_size)),
        }
    return tasks



@api_router.get("/tasks/{task_id}/detail")
async def get_task_detail(task_id: str, current_user: User = Depends(get_current_user)):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if current_user.role != "admin":
        if not is_own_record(current_user, task):
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_tasks", []) or []
            if current_user.role == "manager":
                team_ids = await get_team_user_ids(current_user.id)
                allowed_users = list(set(allowed_users + team_ids))
            if task.get("assigned_to") not in allowed_users:
                raise HTTPException(status_code=403, detail="Not authorized")
    # Batch all user lookups in one query instead of 3 separate find_one calls
    user_ids_to_fetch = list(
        filter(
            None,
            [
                task.get("assigned_to"),
                task.get("created_by"),
                *(task.get("sub_assignees") or []),
            ],
        )
    )
    users_batch = {}
    if user_ids_to_fetch:
        fetched = await db.users.find(
            {"id": {"$in": user_ids_to_fetch}},
            {"_id": 0, "id": 1, "full_name": 1, "profile_picture": 1, "email": 1},
        ).to_list(100)
        users_batch = {u["id"]: u for u in fetched}

    assigned_user = users_batch.get(task.get("assigned_to"))
    created_user = users_batch.get(task.get("created_by"))
    sub_assignee_names = [
        users_batch[uid]["full_name"]
        for uid in (task.get("sub_assignees") or [])
        if uid in users_batch
    ]

    client_name = None
    if task.get("client_id"):
        client_doc = await db.clients.find_one(
            {"id": task["client_id"]}, {"_id": 0, "company_name": 1}
        )
        if client_doc:
            client_name = client_doc.get("company_name")
    task["assigned_to_name"] = (
        assigned_user.get("full_name", "Unknown") if assigned_user else "Unknown"
    )
    task["assigned_to_email"] = assigned_user.get("email") if assigned_user else None
    task["assigned_to_picture"] = (
        assigned_user.get("profile_picture") if assigned_user else None
    )
    task["created_by_name"] = (
        created_user.get("full_name", "Unknown") if created_user else "Unknown"
    )
    task["sub_assignee_names"] = sub_assignee_names
    task["client_name"] = client_name
    task["created_at"] = safe_dt(task.get("created_at"))
    task["updated_at"] = safe_dt(task.get("updated_at"))
    task["due_date"] = safe_dt(task.get("due_date"))
    if task.get("completed_at"):
        task["completed_at"] = safe_dt(task.get("completed_at"))
    return task


@api_router.get("/tasks/{task_id}", response_model=Task)
async def get_task(
    task_id: str, current_user: User = Depends(check_module_permission("tasks", "view"))
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if current_user.role == "admin":
        pass
    elif is_own_record(current_user, task):
        pass
    else:
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        if task.get("assigned_to") not in allowed_users:
            raise HTTPException(status_code=403, detail="Not authorized")
    return Task(**task)


@api_router.api_route("/tasks/{task_id}", methods=["PATCH", "PUT"], response_model=Task)
async def patch_task(
    task_id: str,
    updates: dict,
    # GLITCH FIX: previously gated behind check_module_permission("tasks", "edit"),
    # which required the universal `can_edit_tasks` flag for EVERYONE before the
    # request body was even fetched — so a user editing their OWN task (which
    # the ownership check below already allows) was wrongly 403'd whenever an
    # admin had turned their personal can_edit_tasks flag off. Per spec, every
    # user can edit their own task by default; ownership + cross-visibility are
    # checked below against the actual record instead of a blanket flag.
    current_user: User = Depends(get_current_user),
):
    existing_task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not existing_task:
        raise HTTPException(status_code=404, detail="Task not found")
    is_authorized = current_user.role.lower() == "admin" or is_own_record(
        current_user, existing_task
    )
    if not is_authorized:
        # GLITCH FIX: a user with cross-visibility to another user's tasks
        # (view_other_tasks) should also be able to edit/update those tasks,
        # not just view them.
        perms = get_user_permissions(current_user)
        allowed_users = perms.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        if (
            existing_task.get("assigned_to") in allowed_users
            or existing_task.get("created_by") in allowed_users
        ):
            is_authorized = True
    if not is_authorized:
        raise HTTPException(status_code=403, detail="Unauthorized to modify this task")
    old_data = existing_task.copy()
    # Whitelist: prevent patching of immutable/sensitive fields
    IMMUTABLE_FIELDS = {"id", "created_by", "created_at", "_id"}
    for field in IMMUTABLE_FIELDS:
        updates.pop(field, None)
    updates["updated_at"] = datetime.now(IST).isoformat()
    if updates.get("status") == "completed":
        updates["completed_at"] = datetime.now(IST).isoformat()
    await db.tasks.update_one({"id": task_id}, {"$set": updates})
    updated_task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    action_type = (
        "TASK_STATUS_CHANGED"
        if "status" in updates and old_data.get("status") != updates.get("status")
        else "UPDATE_TASK"
    )
    await create_audit_log(
        current_user=current_user,
        action=action_type,
        module="task",
        record_id=task_id,
        old_data=old_data,
        new_data=updates,
    )
    return Task(**updated_task)


@api_router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, current_user: User = Depends(get_current_user)):
    existing = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Task not found")
    # Issue #7: use can_delete_tasks (not can_edit_tasks)
    # Issue #1: must also satisfy visibility (own or team)
    assert_module_permission(current_user, "tasks", "delete")
    team_ids = (
        await get_team_user_ids(current_user.id)
        if current_user.role == "manager"
        else []
    )
    assert_record_visibility(current_user, existing, team_ids)
    await db.tasks.delete_one({"id": task_id})
    await create_audit_log(
        current_user=current_user,
        action="DELETE_TASK",
        module="task",
        record_id=task_id,
        old_data=existing,
    )
    return {"message": "Task deleted successfully"}


@api_router.post("/tasks/{task_id}/comments")
async def add_task_comment(
    task_id: str, comment_data: dict, current_user: User = Depends(get_current_user)
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    is_involved = current_user.role.lower() == "admin" or is_own_record(
        current_user, task
    )
    if not is_involved:
        raise HTTPException(
            status_code=403,
            detail="Access denied: You must be involved in this task to comment.",
        )
    comment = {
        "id": str(uuid.uuid4()),
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "text": comment_data.get("text"),
        "created_at": datetime.now(IST).isoformat(),
    }
    await db.tasks.update_one({"id": task_id}, {"$push": {"comments": comment}})
    return comment


# =========================================================
# EXPORT TASK AUDIT LOG PDF
# =========================================================
@api_router.get("/tasks/{task_id}/export-log-pdf")
async def export_task_log_pdf(
    task_id: str, current_user: User = Depends(check_permission("can_view_audit_logs"))
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    logs = (
        await db.audit_logs.find({"module": "task", "record_id": task_id}, {"_id": 0})
        .sort("timestamp", 1)
        .to_list(1000)
    )
    if not logs:
        raise HTTPException(status_code=404, detail="No audit logs found")
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=10)
    pdf.add_page()
    pdf.set_font("Arial", "B", 16)
    pdf.cell(0, 10, "Task Lifecycle Report", ln=True, align="C")
    pdf.ln(5)
    pdf.set_font("Arial", "B", 12)
    pdf.cell(0, 8, "Task Information", ln=True)
    pdf.ln(3)
    pdf.set_font("Arial", size=11)
    pdf.multi_cell(0, 7, f"Title: {task.get('title', '-')}")
    pdf.multi_cell(0, 7, f"Description: {task.get('description', '-')}")
    pdf.multi_cell(
        0,
        7,
        f"Assigned To: {task.get('assigned_to_name', task.get('assigned_to', '-'))}",
    )
    pdf.multi_cell(
        0, 7, f"Created By: {task.get('created_by_name', task.get('created_by', '-'))}"
    )
    pdf.multi_cell(0, 7, f"Created At: {task.get('created_at', '-')}")
    pdf.multi_cell(0, 7, f"Current Status: {task.get('status', '-')}")
    pdf.ln(8)
    pdf.set_font("Arial", "B", 12)
    pdf.cell(0, 8, "Activity Timeline", ln=True)
    pdf.ln(4)
    pdf.set_font("Arial", size=10)
    for log in logs:
        timestamp = log.get("timestamp")
        if isinstance(timestamp, datetime):
            timestamp = timestamp.strftime("%b %d, %Y %I:%M %p")
        action = log.get("action", "UNKNOWN")
        user = log.get("user_name", "Unknown User")
        pdf.set_font("Arial", "B", 10)
        pdf.multi_cell(
            0, 6, f"{timestamp} — {action.replace('_', ' ').title()} by {user}"
        )
        pdf.set_font("Arial", size=10)
        if action == "TASK_STATUS_CHANGED":
            old_status = log.get("old_data", {}).get("status", "-")
            new_status = log.get("new_data", {}).get("status", "-")
            pdf.multi_cell(0, 6, f" Status changed: {old_status} -> {new_status}")
        elif action == "TASK_COMPLETED":
            pdf.multi_cell(0, 6, " Task marked as completed.")
        elif action == "DELETE_TASK":
            pdf.multi_cell(0, 6, " Task was deleted.")
        elif action == "CREATE_TASK":
            pdf.multi_cell(0, 6, " Task was created.")
        elif action == "UPDATE_TASK":
            pdf.multi_cell(0, 6, " Task details updated.")
        if log.get("old_data") and log.get("new_data"):
            old_data = log.get("old_data")
            new_data = log.get("new_data")
            for key in new_data:
                old_val = old_data.get(key)
                new_val = new_data.get(key)
                if old_val != new_val:
                    pdf.multi_cell(
                        0,
                        6,
                        f" {key.replace('_', ' ').title()}: {old_val} -> {new_val}",
                    )
        pdf.ln(3)
    pdf.ln(5)
    pdf.set_font("Arial", "I", 8)
    pdf.multi_cell(
        0, 5, f"Generated on {datetime.utcnow().strftime('%b %d, %Y %I:%M %p')} UTC"
    )
    output = BytesIO()
    output.write(pdf.output(dest="S").encode("latin1"))
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=task_lifecycle_{task_id}.pdf"
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# DSC ROUTES
# ═══════════════════════════════════════════════════════════════════════════════


def _to_iso(val) -> Optional[str]:
    """Safely convert datetime/date/string/None to ISO string for MongoDB storage."""
    if val is None:
        return None
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    return str(val)  # already a plain string like "2026-03-22"


# ─── DSC Certificate Reader ────────────────────────────────────────────────────
class DSCReadRequest(BaseModel):
    pin: str
    lib_path: Optional[str] = None  # optional override for PKCS#11 library path


class DSCCertificateData(BaseModel):
    holder_name: Optional[str] = None
    serial_number: Optional[str] = None
    issue_date: Optional[str] = None
    expiry_date: Optional[str] = None
    issuer: Optional[str] = None
    email: Optional[str] = None
    organization: Optional[str] = None
    raw_subject: Optional[str] = None
    read_method: str = "unknown"


def _extract_dn_field(
    name_obj, oid_dotted: str, fallback_attr: str = ""
) -> Optional[str]:
    """Extract a field from an x509 Name by OID or attribute."""
    try:
        from cryptography.x509.oid import NameOID
        import cryptography.x509 as cx509

        oid = cx509.NameOID.__dict__.get(fallback_attr) if fallback_attr else None
        # Try by dotted string OID first
        for attr in name_obj:
            if attr.oid.dotted_string == oid_dotted:
                return attr.value
        # Fallback to NameOID attribute name
        if oid:
            try:
                return name_obj.get_attributes_for_oid(oid)[0].value
            except Exception:
                pass
    except Exception:
        pass
    return None


def _parse_cert_bytes(cert_bytes: bytes) -> DSCCertificateData:
    """Parse DER or PEM certificate bytes and return structured data."""
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend

    try:
        cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
    except Exception:
        try:
            import base64

            pem = (
                b"-----BEGIN CERTIFICATE-----\n"
                + base64.b64encode(cert_bytes)
                + b"\n-----END CERTIFICATE-----"
            )
            cert = x509.load_pem_x509_certificate(pem, default_backend())
        except Exception:
            return DSCCertificateData()

    subject = cert.subject

    # Common Name (holder name)
    holder_name = _extract_dn_field(subject, "2.5.4.3", "COMMON_NAME")

    # Email — try SAN first, then subject emailAddress OID
    email = None
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
        emails = san.value.get_values_for_type(x509.RFC822Name)
        if emails:
            email = emails[0]
    except Exception:
        pass
    if not email:
        email = _extract_dn_field(subject, "1.2.840.113549.1.9.1")

    organization = _extract_dn_field(subject, "2.5.4.10", "ORGANIZATION_NAME")

    serial_hex = format(cert.serial_number, "X")

    not_before = (
        cert.not_valid_before_utc
        if hasattr(cert, "not_valid_before_utc")
        else cert.not_valid_before
    )
    not_after = (
        cert.not_valid_after_utc
        if hasattr(cert, "not_valid_after_utc")
        else cert.not_valid_after
    )

    try:
        raw_subject = cert.subject.rfc4514_string()
    except Exception:
        raw_subject = str(cert.subject)

    return DSCCertificateData(
        holder_name=holder_name,
        serial_number=serial_hex,
        issue_date=not_before.date().isoformat() if not_before else None,
        expiry_date=not_after.date().isoformat() if not_after else None,
        email=email,
        organization=organization,
        raw_subject=raw_subject,
        read_method="pkcs11",
    )


def _ensure_opensc_installed() -> bool:
    """Auto-install opensc + pcscd on Linux if not already present. Returns True if pkcs11-tool is available."""
    import shutil, subprocess, os

    if shutil.which("pkcs11-tool"):
        return True
    if os.name == "nt":
        return False
    try:
        # Install opensc (provides pkcs11-tool), pcscd (PC/SC daemon), and libpcsclite-dev
        subprocess.run(
            [
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
                "opensc",
                "pcscd",
                "libpcsclite1",
                "libpcsclite-dev",
                "libccid",
                "pcsc-tools",
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )
        # Also start pcscd if it isn't running
        try:
            subprocess.run(
                ["service", "pcscd", "start"], capture_output=True, timeout=10
            )
        except Exception:
            pass
        return shutil.which("pkcs11-tool") is not None
    except Exception:
        pass
    return False


def _ensure_pyscard_installed() -> bool:
    """Install pyscard after ensuring libpcsclite-dev is present. Returns True if importable."""
    try:
        import smartcard  # noqa

        return True
    except ImportError:
        pass
    import subprocess, sys, os

    if os.name == "nt":
        return False
    try:
        # libpcsclite-dev must be installed first
        subprocess.run(
            [
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
                "libpcsclite-dev",
                "libpcsclite1",
                "pcscd",
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "pyscard>=2.0.7"],
            check=True,
            capture_output=True,
            timeout=120,
        )
        import smartcard  # noqa

        return True
    except Exception:
        return False


def _try_opensc_cli(pin: str) -> Optional[DSCCertificateData]:
    """
    Use the opensc CLI tool (pkcs11-tool) to read the certificate from the token.
    This works even when PyKCS11 python bindings are not installed, as long as
    the opensc package is available on the server.
    """
    import shutil, subprocess, tempfile, os

    pkcs11_tool = shutil.which("pkcs11-tool")
    if not pkcs11_tool:
        return None

    # Collect candidate PKCS#11 libs for pkcs11-tool --module
    CANDIDATE_LIBS = [
        "/usr/lib/x86_64-linux-gnu/pkcs11/opensc-pkcs11.so",
        "/usr/lib/opensc-pkcs11.so",
        "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
        "/usr/lib/libeTPkcs11.so",
        "/usr/lib/libcastle.so.1",
        "/usr/lib/libcryptoki.so",
        "/usr/lib64/pkcs11/opensc-pkcs11.so",
        None,  # let pkcs11-tool use its default
    ]

    for lib in CANDIDATE_LIBS:
        try:
            cmd = [
                pkcs11_tool,
                "--read-object",
                "--type",
                "cert",
                "--slot-index",
                "0",
                "--pin",
                pin,
            ]
            if lib and os.path.exists(lib):
                cmd += ["--module", lib]

            result = subprocess.run(cmd, capture_output=True, timeout=15)
            if result.returncode == 0 and result.stdout:
                data = _parse_cert_bytes(result.stdout)
                if data and data.holder_name:
                    data.read_method = "opensc-cli"
                    return data
        except Exception:
            continue
    return None


def _try_pyscard_read(pin: str) -> Optional[DSCCertificateData]:
    """
    Fallback: use pyscard (PC/SC) to communicate directly with the smart card
    via APDU commands. Works with any CCID-compliant DSC token.
    Installs libpcsclite-dev + pyscard at runtime if not already present.
    """
    if not _ensure_pyscard_installed():
        return None
    try:
        from smartcard.System import readers
        from smartcard.util import toHexString, toBytes  # noqa
        from smartcard.Exceptions import CardConnectionException  # noqa
    except ImportError:
        return None

    try:
        reader_list = readers()
        if not reader_list:
            return None

        connection = reader_list[0].createConnection()
        connection.connect()

        # SELECT MF
        SELECT_MF = [0x00, 0xA4, 0x04, 0x00]
        connection.transmit(SELECT_MF)

        # Try standard DSC certificate EF paths (Indian DSC tokens)
        CERT_PATHS = [
            [0x00, 0xA4, 0x02, 0x04, 0x02, 0x10, 0x05],  # ePass2003
            [0x00, 0xA4, 0x02, 0x04, 0x02, 0x00, 0x01],  # eToken
            [0x00, 0xA4, 0x02, 0x04, 0x02, 0x10, 0x01],  # WatchData/ProxKey
        ]

        cert_bytes = None
        for path_apdu in CERT_PATHS:
            try:
                resp, sw1, sw2 = connection.transmit(path_apdu)
                if sw1 == 0x90:
                    # READ BINARY — read up to 4096 bytes in chunks
                    cert_data = []
                    offset = 0
                    while True:
                        read_apdu = [
                            0x00,
                            0xB0,
                            (offset >> 8) & 0xFF,
                            offset & 0xFF,
                            0xFF,
                        ]
                        data_chunk, sw1, sw2 = connection.transmit(read_apdu)
                        if sw1 == 0x90 and data_chunk:
                            cert_data.extend(data_chunk)
                            offset += len(data_chunk)
                            if len(data_chunk) < 255:
                                break
                        else:
                            break
                    if cert_data:
                        cert_bytes = bytes(cert_data)
                        break
            except Exception:
                continue

        connection.disconnect()

        if cert_bytes:
            data = _parse_cert_bytes(cert_bytes)
            if data and data.holder_name:
                data.read_method = "pyscard"
                return data
    except Exception:
        pass
    return None


def _try_pkcs11_read(
    pin: str, lib_path: Optional[str] = None
) -> Optional[DSCCertificateData]:
    """Try to read certificate using PyKCS11 (python-pkcs11 wrapper)."""
    import os

    CANDIDATE_LIBS = [
        lib_path,
        "/usr/lib/x86_64-linux-gnu/pkcs11/opensc-pkcs11.so",
        "/usr/lib/opensc-pkcs11.so",
        "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
        "/usr/lib/libeTPkcs11.so",
        "/usr/lib/libcastle.so.1",
        "/usr/lib/libcryptoki.so",
        "/usr/lib64/pkcs11/opensc-pkcs11.so",
        "C:\\Windows\\System32\\eTPKCS11.dll",
        "C:\\Windows\\System32\\akisp11.dll",
        "C:\\Windows\\System32\\opensc-pkcs11.dll",
    ]
    try:
        import PyKCS11
    except ImportError:
        return None

    for lib in CANDIDATE_LIBS:
        if not lib:
            continue
        if not os.path.exists(lib):
            continue
        try:
            pkcs11 = PyKCS11.PyKCS11Lib()
            pkcs11.load(lib)
            slots = pkcs11.getSlotList(tokenPresent=True)
            if not slots:
                continue
            session = pkcs11.openSession(
                slots[0], PyKCS11.CKF_SERIAL_SESSION | PyKCS11.CKF_RW_SESSION
            )
            session.login(pin)
            certs = session.findObjects([(PyKCS11.CKA_CLASS, PyKCS11.CKO_CERTIFICATE)])
            if not certs:
                session.logout()
                session.closeSession()
                continue
            for cert_obj in certs:
                attrs = session.getAttributeValue(
                    cert_obj, [PyKCS11.CKA_VALUE, PyKCS11.CKA_CERTIFICATE_TYPE]
                )
                cert_bytes = bytes(attrs[0])
                if cert_bytes:
                    data = _parse_cert_bytes(cert_bytes)
                    data.read_method = "pkcs11"
                    session.logout()
                    session.closeSession()
                    return data
            session.logout()
            session.closeSession()
        except Exception:
            continue
    return None


@api_router.post("/dsc/read-certificate", response_model=DSCCertificateData)
async def read_dsc_certificate(
    req: DSCReadRequest, current_user: User = Depends(get_current_user)
):
    """
    Read certificate data from a physically connected DSC USB token.

    Tries 3 methods in order:
      1. PyKCS11 python bindings (fastest, if installed)
      2. opensc CLI via pkcs11-tool (auto-installs opensc if missing on Linux)
      3. pyscard PC/SC direct APDU (broadest hardware support)

    Returns holder_name, serial_number, issue_date, expiry_date, organization.
    """
    if not req.pin or not req.pin.strip():
        raise HTTPException(
            status_code=422, detail="PIN is required to read the DSC token."
        )

    pin = req.pin.strip()

    # Method 1: PyKCS11 python bindings
    data = _try_pkcs11_read(pin, req.lib_path)
    if data and data.holder_name:
        return data

    # Method 2: opensc CLI (auto-installs on Render/Linux if missing)
    _ensure_opensc_installed()
    data = _try_opensc_cli(pin)
    if data and data.holder_name:
        return data

    # Method 3: pyscard direct PC/SC APDU
    data = _try_pyscard_read(pin)
    if data and data.holder_name:
        return data

    raise HTTPException(
        status_code=422,
        detail=(
            "Could not read the certificate from the token. "
            "Make sure: (1) the DSC USB token is physically plugged into the SERVER machine, "
            "(2) pcscd (PC/SC daemon) is running, and (3) the PIN is correct. "
            "On Render.com, the token must be plugged into your local machine and the backend "
            "must be running locally (not on the cloud) to access USB hardware."
        ),
    )


@api_router.post("/dsc", response_model=DSC)
async def create_dsc(
    dsc_data: DSCCreate,
    current_user: User = Depends(check_module_permission("dsc_register", "create")),
):
    try:
        now = datetime.now(timezone.utc)
        dsc = DSC(
            **dsc_data.model_dump(),
            created_by=current_user.id,
            created_at=now,  # explicitly set — never None
        )
        doc = dsc.model_dump()
        doc["created_at"] = _to_iso(doc["created_at"])
        doc["issue_date"] = _to_iso(doc["issue_date"])
        doc["expiry_date"] = _to_iso(doc["expiry_date"])
        await db.dsc_register.insert_one(doc)
        doc.pop("_id", None)
        return dsc
    except Exception as e:
        logger.error(f"DSC create error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save DSC: {str(e)}")


@api_router.get("/dsc")
async def get_dsc_list(
    sort_by: str = Query("holder_name"),
    order: str = Query("asc", pattern="^(asc|desc)$", ignore_case=True),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(500, ge=1, le=500),
    current_user: User = Depends(check_permission("can_view_all_dsc")),
):
    query = {}
    if search:
        safe_search = re.escape(search)
        search_regex = {"$regex": safe_search, "$options": "i"}
        query["$or"] = [
            {"holder_name": search_regex},
            {"dsc_type": search_regex},
            {"associated_with": search_regex},
            {"current_status": search_regex},
        ]
    sort_dir = 1 if order.lower() == "asc" else -1
    skip = (page - 1) * limit
    total = await db.dsc_register.count_documents(query)
    cursor = (
        db.dsc_register.find(query, {"_id": 0})
        .sort(sort_by, sort_dir)
        .skip(skip)
        .limit(limit)
    )
    dsc_list = await cursor.to_list(length=limit)
    now = datetime.now(IST)

    for dsc in dsc_list:
        # Safely parse stored ISO strings back to datetime for comparison
        for field in ("created_at", "issue_date", "expiry_date"):
            val = dsc.get(field)
            if isinstance(val, str):
                try:
                    dsc[field] = datetime.fromisoformat(val)
                except ValueError:
                    dsc[field] = None

        expiry_date = dsc.get("expiry_date")
        if expiry_date:
            # Make expiry_date timezone-aware for comparison with IST now
            if isinstance(expiry_date, datetime) and expiry_date.tzinfo is None:
                expiry_date = expiry_date.replace(tzinfo=timezone.utc)

            if expiry_date < now:
                movement_log = dsc.get("movement_log", [])
                updated = False
                if not any(
                    log.get("movement_type") == "EXPIRED" for log in movement_log
                ):
                    movement_log.append(
                        {
                            "id": str(uuid.uuid4()),
                            "movement_type": "EXPIRED",
                            "person_name": "System Auto",
                            "notes": "Auto marked as expired",
                            "timestamp": now.isoformat(),
                            "recorded_by": "System",
                        }
                    )
                    updated = True
                if dsc.get("current_status") != "EXPIRED":
                    updated = True
                if updated:
                    await db.dsc_register.update_one(
                        {"id": dsc["id"]},
                        {
                            "$set": {
                                "current_status": "EXPIRED",
                                "movement_log": movement_log,
                            }
                        },
                    )
                    dsc["current_status"] = "EXPIRED"
                    dsc["movement_log"] = movement_log

    return DSCListResponse(data=dsc_list, total=total, page=page, limit=limit)


@api_router.put("/dsc/{dsc_id}", response_model=DSC)
async def update_dsc(
    dsc_id: str,
    dsc_data: DSCCreate,
    current_user: User = Depends(check_permission("can_edit_dsc")),
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")

    update_data = dsc_data.model_dump()
    update_data["issue_date"] = _to_iso(update_data["issue_date"])
    update_data["expiry_date"] = _to_iso(update_data["expiry_date"])

    await db.dsc_register.update_one({"id": dsc_id}, {"$set": update_data})
    await create_audit_log(
        current_user,
        action="UPDATE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
        new_data=update_data,
    )

    updated = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not updated:
        raise HTTPException(status_code=404, detail="DSC not found after update")

    # Parse ISO strings back to datetime for Pydantic response model
    for field in ("created_at", "issue_date", "expiry_date"):
        val = updated.get(field)
        if isinstance(val, str):
            try:
                updated[field] = datetime.fromisoformat(val)
            except ValueError:
                updated[field] = None

    return DSC(**updated)


@api_router.delete("/dsc/{dsc_id}")
async def delete_dsc(
    dsc_id: str, current_user: User = Depends(check_permission("can_edit_dsc"))
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")
    await create_audit_log(
        current_user,
        action="DELETE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
    )
    result = await db.dsc_register.delete_one({"id": dsc_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="DSC not found")
    return {"message": "DSC deleted successfully"}


@api_router.post("/dsc/{dsc_id}/movement")
async def record_dsc_movement(
    dsc_id: str,
    movement_data: DSCMovementRequest,
    current_user: User = Depends(get_current_user),
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")

    movement = {
        "id": str(uuid.uuid4()),
        "movement_type": movement_data.movement_type,
        "person_name": movement_data.person_name,
        "timestamp": datetime.now(IST).isoformat(),
        "notes": movement_data.notes,
        "recorded_by": current_user.full_name,
    }
    movement_log = existing.get("movement_log", [])
    movement_log.append(movement)

    await db.dsc_register.update_one(
        {"id": dsc_id},
        {
            "$set": {
                "current_status": movement_data.movement_type,
                "current_location": "with_company"
                if movement_data.movement_type == "IN"
                else "taken_by_client",
                "movement_log": movement_log,
            }
        },
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
        new_data={"movement_log": movement_log},
    )
    return {
        "message": f"DSC marked as {movement_data.movement_type}",
        "movement": movement,
    }


@api_router.put("/dsc/{dsc_id}/movement/{movement_id}")
async def update_dsc_movement(
    dsc_id: str,
    movement_id: str,
    update_data: MovementUpdateRequest,
    current_user: User = Depends(get_current_user),
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")

    movement_log = existing.get("movement_log", [])
    movement_found = False

    for i, movement in enumerate(movement_log):
        if movement.get("id") == movement_id:
            movement_log[i]["movement_type"] = update_data.movement_type
            if update_data.person_name:
                movement_log[i]["person_name"] = update_data.person_name
            if update_data.notes is not None:
                movement_log[i]["notes"] = update_data.notes
            movement_log[i]["edited_by"] = current_user.full_name
            movement_log[i]["edited_at"] = datetime.now(timezone.utc).isoformat()
            movement_found = True
            break

    if not movement_found:
        raise HTTPException(status_code=404, detail="Movement entry not found")

    # Derive current_status from the last non-EXPIRED movement entry
    non_expired = [m for m in movement_log if m.get("movement_type") != "EXPIRED"]
    new_status = non_expired[-1]["movement_type"] if non_expired else "IN"

    await db.dsc_register.update_one(
        {"id": dsc_id},
        {"$set": {"current_status": new_status, "movement_log": movement_log}},
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
        new_data={"movement_log": movement_log},
    )
    return {"message": "Movement updated successfully", "movement_log": movement_log}


# DOCUMENT REGISTER ROUTES
@api_router.post("/documents", response_model=Document)
async def create_document(
    document_data: DocumentCreate,
    current_user: User = Depends(
        check_module_permission("document_register", "create")
    ),
):
    # Document.created_at is optional on the response model, but every new
    # record must receive a real timestamp before it is serialized for Mongo.
    # Calling .isoformat() on the old None default caused every POST /documents
    # request to fail with a 500 even when the user had the correct permission.
    document = Document(
        **document_data.model_dump(),
        created_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )
    doc = document.model_dump()
    doc["created_at"] = doc["created_at"].isoformat()
    if doc.get("issue_date"):
        doc["issue_date"] = doc["issue_date"].isoformat()
    if doc.get("valid_upto"):
        doc["valid_upto"] = doc["valid_upto"].isoformat()
    await db.documents.insert_one(doc)
    return document


@api_router.get("/documents", response_model=List[Document])
async def get_documents(
    current_user: User = Depends(check_permission("can_view_documents")),
):
    documents = await db.documents.find({}, {"_id": 0}).to_list(1000)
    for d in documents:
        if isinstance(d["created_at"], str):
            d["created_at"] = datetime.fromisoformat(d["created_at"])
        if d.get("issue_date") and isinstance(d["issue_date"], str):
            d["issue_date"] = datetime.fromisoformat(d["issue_date"])
        if d.get("valid_upto") and isinstance(d["valid_upto"], str):
            d["valid_upto"] = datetime.fromisoformat(d["valid_upto"])
    return documents


@api_router.put("/documents/{document_id}", response_model=Document)
async def update_document(
    document_id: str,
    document_data: DocumentCreate,
    current_user: User = Depends(check_permission("can_edit_documents")),
):
    existing = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Document not found")
    update_data = document_data.model_dump()
    if update_data.get("issue_date"):
        update_data["issue_date"] = update_data["issue_date"].isoformat()
    if update_data.get("valid_upto"):
        update_data["valid_upto"] = update_data["valid_upto"].isoformat()
    await db.documents.update_one({"id": document_id}, {"$set": update_data})
    await create_audit_log(
        current_user,
        action="UPDATE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=existing,
        new_data=update_data,
    )
    updated = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if isinstance(updated["created_at"], str):
        updated["created_at"] = datetime.fromisoformat(updated["created_at"])
    return Document(**updated)


@api_router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    current_user: User = Depends(check_permission("can_edit_documents")),
):
    existing = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Document not found")
    await create_audit_log(
        current_user,
        action="DELETE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=existing,
    )
    result = await db.documents.delete_one({"id": document_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"message": "Document deleted successfully"}


@api_router.post("/documents/{document_id}/movement")
async def record_document_movement(
    document_id: str,
    movement_data: DocumentMovementRequest,
    current_user: User = Depends(get_current_user),
):
    document = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    movement = {
        "id": str(uuid.uuid4()),
        "movement_type": movement_data.movement_type,
        "person_name": movement_data.person_name,
        "timestamp": datetime.now(IST).isoformat(),
        "notes": movement_data.notes,
        "recorded_by": current_user.full_name,
    }
    movement_log = document.get("movement_log", [])
    movement_log.append(movement)
    await db.documents.update_one(
        {"id": document_id},
        {
            "$set": {
                "current_status": movement_data.movement_type,
                "movement_log": movement_log,
            }
        },
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=document,
        new_data={"movement_log": movement_log},
    )
    return {"message": "Movement recorded successfully"}


@api_router.put("/documents/{document_id}/movement/{movement_id}")
async def update_document_movement(
    document_id: str,
    movement_id: str,
    update_data: DocumentMovementRequest,
    current_user: User = Depends(get_current_user),
):
    document = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    movement_log = document.get("movement_log", [])
    movement_found = False
    for i, movement in enumerate(movement_log):
        if movement.get("id") == movement_id:
            movement_log[i]["movement_type"] = update_data.movement_type
            movement_log[i]["person_name"] = update_data.person_name
            movement_log[i]["notes"] = update_data.notes
            movement_log[i]["edited_by"] = current_user.full_name
            movement_log[i]["edited_at"] = datetime.now(timezone.utc).isoformat()
            movement_found = True
            break
    if not movement_found:
        raise HTTPException(status_code=404, detail="Movement entry not found")
    new_status = movement_log[-1]["movement_type"] if movement_log else "IN"
    await db.documents.update_one(
        {"id": document_id},
        {"$set": {"current_status": new_status, "movement_log": movement_log}},
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=document,
        new_data={"movement_log": movement_log},
    )
    return {"message": "Movement updated successfully"}


# DUE DATE ROUTES
COMPLIANCE_RULES = [
    {
        "keywords": ["gstr-1", "gstr1", "outward supply"],
        "category": "GST",
        "department": "GST",
    },
    {
        "keywords": ["gstr-3b", "gstr3b", "summary return"],
        "category": "GST",
        "department": "GST",
    },
    {
        "keywords": ["gstr-9", "annual return gst"],
        "category": "GST",
        "department": "GST",
    },
    {"keywords": ["gstr-4", "composition"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-7", "tds return gst"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-8", "tcs statement"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-5", "non-resident"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-6", "isd return"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-10", "final return"], "category": "GST", "department": "GST"},
    {"keywords": ["gst", "goods and service"], "category": "GST", "department": "GST"},
    {
        "keywords": ["itr", "income tax return"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": ["advance tax", "advance income tax"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": ["tax audit", "form 3ca", "form 3cb"],
        "category": "Audit",
        "department": "IT",
    },
    {
        "keywords": ["form 16", "form 26as"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": ["income tax", "direct tax"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": [
            "tds",
            "tax deducted at source",
            "form 24q",
            "form 26q",
            "form 27q",
        ],
        "category": "TDS",
        "department": "TDS",
    },
    {
        "keywords": ["tcs", "tax collected at source"],
        "category": "TDS",
        "department": "TDS",
    },
    {"keywords": ["challan 281"], "category": "TDS", "department": "TDS"},
    {
        "keywords": ["mgt-7", "annual return roc", "annual return mca"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["aoc-4", "financial statement", "filing of financial"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["dir-3", "director kyc", "din kyc"],
        "category": "ROC",
        "department": "ROC",
    },
    {"keywords": ["dir-8", "disqualification"], "category": "ROC", "department": "ROC"},
    {
        "keywords": ["dir-12", "appointment", "resignation of director"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["mbp-1", "disclosure of interest"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["agm", "annual general meeting"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["dpt-3", "return of deposits"],
        "category": "ROC",
        "department": "ROC",
    },
    {"keywords": ["msme-1", "msme samadhaan"], "category": "ROC", "department": "MSME"},
    {
        "keywords": ["pas-6", "reconciliation of share"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["roc", "mca", "companies act", "registrar of companies"],
        "category": "ROC",
        "department": "ROC",
    },
    {"keywords": ["msme"], "category": "Other", "department": "MSME"},
    {
        "keywords": ["statutory audit", "internal audit", "audit report"],
        "category": "Audit",
        "department": "ACC",
    },
    {
        "keywords": ["adt-1", "appointment of auditor"],
        "category": "Audit",
        "department": "ROC",
    },
    {
        "keywords": ["trademark", "tm renewal"],
        "category": "Trademark",
        "department": "TM",
    },
    {
        "keywords": ["fema", "foreign exchange", "fdi"],
        "category": "FEMA",
        "department": "FEMA",
    },
    {"keywords": ["rera", "real estate"], "category": "RERA", "department": "OTHER"},
    {
        "keywords": ["pf", "provident fund", "epfo"],
        "category": "Other",
        "department": "ACC",
    },
    {"keywords": ["esi", "esic"], "category": "Other", "department": "ACC"},
    {
        "keywords": ["board meeting", "minute book"],
        "category": "ROC",
        "department": "ROC",
    },
]

MONTH_MAP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


def parse_date_from_text(text: str):
    text = text.strip()
    now = datetime.now()
    year = now.year

    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(january|february|march|april|may|june|july|august|september|october|november|december)"
        r"\s+(\d{4})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            return date(
                int(m.group(3)), MONTH_MAP[m.group(2).lower()], int(m.group(1))
            ).isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december)"
        r"\s+(\d{1,2}),?\s+(\d{4})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            return date(
                int(m.group(3)), MONTH_MAP[m.group(1).lower()], int(m.group(2))
            ).isoformat()
        except Exception:
            pass

    m = re.search(r"\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except Exception:
            pass

    m = re.search(r"\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(january|february|march|april|may|june|july|august|september|october|november|december)\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = MONTH_MAP[m.group(2).lower()]
            d_val = int(m.group(1))
            target = date(year, mo, d_val)
            if target < date.today():
                target = date(year + 1, mo, d_val)
            return target.isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december)"
        r"\s+(\d{1,2})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = MONTH_MAP[m.group(1).lower()]
            d_val = int(m.group(2))
            target = date(year, mo, d_val)
            if target < date.today():
                target = date(year + 1, mo, d_val)
            return target.isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+next\s+month\b", text, re.IGNORECASE
    )
    if m:
        try:
            day = int(m.group(1))
            today = date.today()
            if today.month < 12:
                target = date(today.year, today.month + 1, day)
            else:
                target = date(today.year + 1, 1, day)
            return target.isoformat()
        except Exception:
            pass

    m = re.search(r"within\s+(\d+)\s+days?", text, re.IGNORECASE)
    if m:
        try:
            return (date.today() + timedelta(days=int(m.group(1)))).isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = MONTH_MAP[m.group(2).lower()]
            d_val = int(m.group(1))
            target = date(year, mo, d_val)
            if target < date.today():
                target = date(year + 1, mo, d_val)
            return target.isoformat()
        except Exception:
            pass

    return None


def classify_compliance(line: str):
    lower = line.lower()
    for rule in COMPLIANCE_RULES:
        if any(kw in lower for kw in rule["keywords"]):
            return {"category": rule["category"], "department": rule["department"]}
    return {"category": "Other", "department": "OTHER"}


def extract_title(line: str) -> str:
    title = re.sub(r"\s+", " ", line).strip()
    title = re.sub(r"^[\-\*\•\|]+\s*", "", title)
    if len(title) > 80:
        title = title[:77].rsplit(" ", 1)[0] + "..."
    return title or "Compliance Task"


def parse_compliance_dates(raw_text: str):
    results = []
    seen = set()
    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    for i, line in enumerate(lines):
        if "|" not in line:
            continue
        cols = [c.strip() for c in line.split("|") if c.strip()]
        if len(cols) < 2:
            continue
        date_val = None
        date_col_idx = None
        for idx, col in enumerate(cols):
            d = parse_date_from_text(col)
            if d:
                date_col_idx = idx
                date_val = d
                break
        if not date_val and i + 1 < len(lines):
            date_val = parse_date_from_text(lines[i + 1])
        if not date_val:
            continue
        title_col = next(
            (c for idx, c in enumerate(cols) if idx != date_col_idx and len(c) > 3),
            None,
        )
        if not title_col:
            continue
        title = extract_title(title_col)
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        clf = classify_compliance(line)
        results.append(
            {
                "title": title,
                "due_date": date_val,
                "category": clf["category"],
                "department": clf["department"],
                "description": title_col[:300],
                "status": "pending",
            }
        )

    for i, line in enumerate(lines):
        if len(line) < 8:
            continue
        if re.match(
            r"^(form|compliance|particulars|due date|applicability|sl\.?\s*no)",
            line,
            re.IGNORECASE,
        ):
            continue
        date_val = parse_date_from_text(line)
        if not date_val and i + 1 < len(lines):
            date_val = parse_date_from_text(lines[i + 1])
        if not date_val:
            continue
        clf = classify_compliance(line)
        if clf["category"] == "Other" and clf["department"] == "OTHER" and i > 0:
            clf = classify_compliance(lines[i - 1])
        title = extract_title(line)
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        stripped = re.sub(
            r"\d{1,2}(?:st|nd|rd|th)?\s+\w+\s*\d{0,4}", "", line, flags=re.IGNORECASE
        ).strip()
        if len(stripped) < 5:
            continue
        results.append(
            {
                "title": title,
                "due_date": date_val,
                "category": clf["category"],
                "department": clf["department"],
                "description": line[:300],
                "status": "pending",
            }
        )

    form_pat = re.compile(
        r"((?:GSTR?|ITR|MGT|AOC|DIR|DPT|ADT|PAS|INC|CHG|BEN|SH|CSR|MSME)-[\w\/]+)",
        re.IGNORECASE,
    )
    for i, line in enumerate(lines):
        m = form_pat.search(line)
        if not m:
            continue
        form_name = m.group(1).upper()
        date_val = None
        for j in range(i, min(i + 3, len(lines))):
            date_val = parse_date_from_text(lines[j])
            if date_val:
                break
        if not date_val:
            continue
        title = f"{form_name} Filing"
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        clf = classify_compliance(form_name + " " + line)
        results.append(
            {
                "title": title,
                "due_date": date_val,
                "category": clf["category"],
                "department": clf["department"],
                "description": extract_title(line),
                "status": "pending",
            }
        )

    results.sort(key=lambda x: x.get("due_date", "9999-12-31"))
    return results


# Route registered BEFORE /{due_date_id} param routes to prevent shadowing
@api_router.post("/duedates/extract-from-file")
async def extract_due_dates_from_file(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    filename = (file.filename or "").lower()
    content_type = file.content_type or ""
    file_bytes = await file.read()
    raw_text = ""

    try:
        if content_type.startswith("image/") or filename.endswith(
            (".jpg", ".jpeg", ".png", ".webp", ".bmp")
        ):
            raise HTTPException(
                status_code=400,
                detail="Image upload is not supported on this server. Please upload a PDF or DOCX file instead.",
            )

        elif content_type == "application/pdf" or filename.endswith(".pdf"):
            import pdfplumber

            parts = []
            with pdfplumber.open(BytesIO(file_bytes)) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        parts.append(t)
                    for table in page.extract_tables():
                        for row in table:
                            if row:
                                parts.append("  |  ".join(str(c or "") for c in row))
            raw_text = "\n".join(parts)

        elif filename.endswith((".docx", ".doc")):
            from docx import Document as DocxDocument

            doc = DocxDocument(BytesIO(file_bytes))
            parts = [p.text for p in doc.paragraphs if p.text.strip()]
            for table in doc.tables:
                for row in table.rows:
                    parts.append("  |  ".join(cell.text for cell in row.cells))
            raw_text = "\n".join(parts)

        else:
            raise HTTPException(
                status_code=400,
                detail="Unsupported file type. Use JPG, PNG, PDF, or DOCX.",
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File extraction error: {e}")
        raise HTTPException(status_code=422, detail=f"Could not read file: {str(e)}")

    if not raw_text or len(raw_text.strip()) < 20:
        raise HTTPException(
            status_code=422,
            detail="No readable text found. Try a clearer image or PDF.",
        )

    extracted = parse_compliance_dates(raw_text)

    if not extracted:
        raise HTTPException(
            status_code=404, detail="No compliance dates detected in this document."
        )

    return {"extracted": extracted, "count": len(extracted)}


# ─── Calendar → Compliance Tracker sync helper ───────────────────────────────
_CALENDAR_CATEGORY_MAP = {
    "GST": "GST",
    "ROC": "ROC",
    "MCA": "ROC",
    "ITR": "ITR",
    "TDS": "TDS",
    "AUDIT": "AUDIT",
    "PF": "PF_ESIC",
    "ESIC": "PF_ESIC",
    "PT": "PT",
    "INCOME TAX": "ITR",
}
_COMPLIANCE_CATEGORIES = ["ROC", "GST", "ITR", "TDS", "AUDIT", "PF_ESIC", "PT", "OTHER"]


async def _sync_due_date_to_compliance(dd: dict, current_user) -> None:
    """Upsert a compliance_master record linked to the given due_date doc."""
    title = (dd.get("title") or "").strip()
    dd_id = dd.get("id")
    due_date = dd.get("due_date")
    if isinstance(due_date, datetime):
        due_date = due_date.strftime("%Y-%m-%d")
    elif isinstance(due_date, str) and "T" in due_date:
        due_date = due_date[:10]

    raw_cat = (dd.get("category") or "OTHER").upper()
    category = _CALENDAR_CATEGORY_MAP.get(raw_cat, "OTHER")
    if category not in _COMPLIANCE_CATEGORIES:
        category = "OTHER"

    existing = await db.compliance_masters.find_one(
        {"calendar_due_date_id": dd_id}, {"_id": 0}
    )
    now_str = datetime.now(timezone.utc).isoformat()

    if existing:
        await db.compliance_masters.update_one(
            {"id": existing["id"]},
            {"$set": {"due_date": due_date, "name": title, "updated_at": now_str}},
        )
    else:
        import uuid as _uuid

        doc = {
            "id": str(_uuid.uuid4()),
            "name": title,
            "category": category,
            "frequency": "one_time",
            "fy_year": None,
            "period_label": None,
            "due_date": due_date,
            "description": dd.get("description", ""),
            "applicable_entity_types": [],
            "calendar_due_date_id": dd_id,
            "created_by": str(getattr(current_user, "id", "")),
            "created_by_name": getattr(current_user, "full_name", ""),
            "created_at": now_str,
            "updated_at": now_str,
        }
        await db.compliance_masters.insert_one({**doc, "_id": doc["id"]})


@api_router.post("/duedates", response_model=DueDate)
async def create_due_date(
    due_date_data: DueDateCreate, current_user: User = Depends(get_current_user)
):
    try:
        if not due_date_data.department:
            raise HTTPException(status_code=400, detail="Department required")

        data = due_date_data.model_dump()

        # ✅ FIX 1: Safe date parsing
        raw_due_date = data.get("due_date")

        if isinstance(raw_due_date, str):
            try:
                parsed_date = datetime.fromisoformat(raw_due_date)
            except:
                parsed_date = datetime.strptime(raw_due_date, "%m/%d/%Y")
        else:
            parsed_date = raw_due_date

        # ✅ FIX 2: Build document safely
        data["due_date"] = parsed_date

        due_date = DueDate(**data, created_by=current_user.id)

        doc = due_date.model_dump()

        # ✅ FIX 3: Safe datetime conversion
        if isinstance(doc.get("created_at"), datetime):
            doc["created_at"] = doc["created_at"].isoformat()

        if isinstance(doc.get("due_date"), datetime):
            doc["due_date"] = doc["due_date"].isoformat()

        # ✅ INSERT
        await db.due_dates.insert_one(doc)

        # ✅ FIX 4: REMOVE ObjectId if added
        doc.pop("_id", None)

        # ✅ Auto-sync to Compliance Tracker
        try:
            await _sync_due_date_to_compliance(doc, current_user)
        except Exception as sync_err:
            logger.warning(f"Compliance sync after create failed: {sync_err}")

        return doc

    except Exception as e:
        logger.error(f"DueDate creation failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to save due date")


# ──────────────────────────────────────────────────────────────────────────────
# PATCH 1 of 1  —  GET /api/duedates/upcoming
# File: main.py  (replace the entire get_upcoming_due_dates function)
#
# ROOT CAUSE: the old guard `if now <= dd_date <= future_date` excluded every
# overdue item (dd_date < now).  The Dashboard welcome banner and Deadlines card
# therefore showed nothing when ALL pending items were already past due.
#
# FIX: drop the `now <=` lower bound so overdue items are included.
#       days_remaining is already negative for overdue items via
#       `(dd_date - now).days`, which is correct.
# ──────────────────────────────────────────────────────────────────────────────


@api_router.get("/duedates/upcoming")
async def get_upcoming_due_dates(
    days: int = Query(30), current_user: User = Depends(get_current_user)
):
    now = datetime.now(IST)
    future_date = now + timedelta(days=days)

    query = {"status": "pending"}
    if current_user.role != "admin":
        if current_user.departments:
            query["department"] = {"$in": current_user.departments}
        else:
            return []

    due_dates = await db.due_dates.find(query, {"_id": 0}).to_list(1000)

    # Build a set of compliance names/titles that are closed so we can
    # exclude their matching due_dates entries from the dashboard widget.
    closed_masters = await db.compliance_masters.find(
        {"is_closed": True}, {"_id": 0, "name": 1, "calendar_due_date_id": 1}
    ).to_list(1000)
    closed_names = {m["name"].strip().lower() for m in closed_masters if m.get("name")}
    closed_cal_ids = {
        m["calendar_due_date_id"]
        for m in closed_masters
        if m.get("calendar_due_date_id")
    }

    results = []

    for dd in due_dates:
        # Skip if this due_date is directly linked to a closed compliance master
        if dd.get("id") in closed_cal_ids:
            continue
        # Skip if the title matches a closed compliance master name (case-insensitive)
        if dd.get("title", "").strip().lower() in closed_names:
            continue

        dd_date = (
            datetime.fromisoformat(dd["due_date"])
            if isinstance(dd["due_date"], str)
            else dd["due_date"]
        )
        # Ensure dd_date is timezone-aware for safe comparison with IST-aware `now`
        if dd_date.tzinfo is None:
            dd_date = dd_date.replace(tzinfo=IST)

        if dd_date <= future_date:
            dd["due_date"] = dd_date
            dd["days_remaining"] = (dd_date - now).days  # negative = overdue
            results.append(dd)

    # Sort: overdue first (most-negative days_remaining), then by closest due date
    return sorted(results, key=lambda x: x["days_remaining"])


@api_router.get("/duedates", response_model=List[DueDate])
async def get_due_dates(current_user: User = Depends(get_current_user)):
    query = {}
    if current_user.role == "admin":
        pass
    elif current_user.role == "manager":
        if current_user.departments:
            query["department"] = {"$in": current_user.departments}
    else:
        permissions = get_user_permissions(current_user)
        if not permissions.get("can_view_all_duedates", False):
            if current_user.departments:
                query["department"] = {"$in": current_user.departments}
            else:
                return []
    due_dates = await db.due_dates.find(query, {"_id": 0}).to_list(1000)
    for dd in due_dates:
        if isinstance(dd.get("created_at"), str):
            dd["created_at"] = datetime.fromisoformat(dd["created_at"])
        if isinstance(dd.get("due_date"), str):
            dd["due_date"] = datetime.fromisoformat(dd["due_date"])
    return [DueDate(**dd) for dd in due_dates]


@api_router.put("/duedates/{due_date_id}", response_model=DueDate)
async def update_due_date(
    due_date_id: str,
    due_date_data: DueDateCreate,
    current_user: User = Depends(check_permission("can_edit_due_dates")),
):
    existing = await db.due_dates.find_one({"id": due_date_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Due date not found")
    update_data = due_date_data.model_dump()
    update_data["due_date"] = update_data["due_date"].isoformat()
    await db.due_dates.update_one({"id": due_date_id}, {"$set": update_data})
    await create_audit_log(
        current_user,
        action="UPDATE_DUE_DATE",
        module="duedate",
        record_id=due_date_id,
        old_data=existing,
        new_data=update_data,
    )
    updated = await db.due_dates.find_one({"id": due_date_id}, {"_id": 0})
    if isinstance(updated.get("created_at"), str):
        updated["created_at"] = datetime.fromisoformat(updated["created_at"])
    if isinstance(updated.get("due_date"), str):
        updated["due_date"] = datetime.fromisoformat(updated["due_date"])

    # Auto-sync updated due_date to Compliance Tracker
    try:
        sync_doc = dict(updated)
        if isinstance(sync_doc.get("due_date"), datetime):
            sync_doc["due_date"] = sync_doc["due_date"].isoformat()
        sync_doc["id"] = due_date_id
        await _sync_due_date_to_compliance(sync_doc, current_user)
    except Exception as sync_err:
        logger.warning(f"Compliance sync after update failed: {sync_err}")

    return DueDate(**updated)


@api_router.delete("/duedates/{due_date_id}")
async def delete_due_date(
    due_date_id: str,
    current_user: User = Depends(check_permission("can_edit_due_dates")),
):
    existing = await db.due_dates.find_one({"id": due_date_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Due date not found")
    await create_audit_log(
        current_user,
        action="DELETE_DUE_DATE",
        module="duedate",
        record_id=due_date_id,
        old_data=existing,
    )
    result = await db.due_dates.delete_one({"id": due_date_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Due date not found")
    return {"message": "Due date deleted successfully"}


# Registered before /clients/{client_id} to prevent route shadowing
@api_router.get("/clients/upcoming-birthdays")
async def get_upcoming_birthdays(
    days: int = 7, current_user: User = Depends(get_current_user)
):
    clients = await db.clients.find({}, {"_id": 0}).to_list(1000)
    today = date.today()
    upcoming = []
    for client in clients:
        # Keep the existing tenant boundary from TenantAwareDatabase and
        # additionally apply the same client-level visibility rules used by
        # the rest of the client module.
        if not can_view_client(current_user, client):
            continue
        for person in personal_birthday_candidates(client):
            raw = person["birthday"]
            try:
                bday = (
                    date.fromisoformat(raw[:10])
                    if isinstance(raw, str)
                    else raw
                )
                # Added leap year guard
                try:
                    this_year_bday = bday.replace(year=today.year)
                except ValueError:
                    this_year_bday = bday.replace(year=today.year, day=28)
                if this_year_bday < today:
                    try:
                        this_year_bday = bday.replace(year=today.year + 1)
                    except ValueError:
                        this_year_bday = bday.replace(year=today.year + 1, day=28)
                days_until = (this_year_bday - today).days
                if 0 <= days_until <= days:
                    upcoming.append({
                        "client_id": client.get("id"),
                        "company_name": client.get("company_name"),
                        "person_name": person["name"],
                        "phone": person["phone"],
                        "email": person["email"],
                        "birthday": raw,
                        "days_until_birthday": days_until,
                    })
            except (ValueError, TypeError):
                continue
    return sorted(upcoming, key=lambda x: x["days_until_birthday"])


# ─── MANUAL BIRTHDAY WISH ────────────────────────────────────────────────────
@api_router.post("/clients/{client_id}/send-birthday-wish")
async def send_birthday_wish_manual(
    client_id: str, current_user: User = Depends(get_current_user)
):
    """Manually send a birthday wish to a client. Admin/manager only."""
    if current_user.role not in ("admin", "manager"):
        raise HTTPException(status_code=403, detail="Admin or Manager only")

    client = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    sent_to, failed, no_email = [], [], []

    # Main client email — only when the client itself IS an individual.
    # A pvt_ltd/llp/partnership/etc. has a Date of Incorporation, not a
    # birthday, even though some import flows store it in this same field;
    # only a proprietorship has no legal identity separate from its owner.
    client_name = client.get("company_name") or "Valued Client"
    client_email = client.get("email")
    wa_sent_to = []
    is_individual = (client.get("client_type") or "").strip().lower() == "proprietor"

    if is_individual:
        if client_email:
            ok = await send_birthday_email(client_email, client_name)
            (sent_to if ok else failed).append(client_email)
        else:
            no_email.append(client_name)

        # WhatsApp birthday wish for main client
        client_phone = "".join(c for c in (client.get("phone") or "") if c.isdigit())
        if len(client_phone) == 10:
            client_phone = "91" + client_phone
        if client_phone:
            try:
                from backend.whatsapp_integration import send_whatsapp_notification

                wa_msg = (
                    f"🎂 *Happy Birthday, {client_name}!*\n\n"
                    f"Wishing you a wonderful birthday filled with joy and prosperity! 🎉\n\n"
                    f"Best wishes,\n_Taskosphere Team_"
                )
                await send_whatsapp_notification(
                    to=client_phone,
                    message=wa_msg,
                    message_type="birthday",
                    context_id=client_id,
                    sent_by=current_user.id,
                )
                wa_sent_to.append(client_phone)
            except Exception as wa_err:
                logger.warning(f"WhatsApp birthday failed for {client_name}: {wa_err}")

    # Contact persons
    for cp in client.get("contact_persons") or []:
        cp_email = cp.get("email")
        cp_name = cp.get("name") or client_name
        if cp_email:
            ok = await send_birthday_email(cp_email, cp_name)
            (sent_to if ok else failed).append(cp_email)
        else:
            no_email.append(cp_name)

        # WhatsApp for contact person
        cp_phone = "".join(c for c in (cp.get("phone") or "") if c.isdigit())
        if len(cp_phone) == 10:
            cp_phone = "91" + cp_phone
        if cp_phone:
            try:
                from backend.whatsapp_integration import send_whatsapp_notification

                cp_msg = (
                    f"🎂 *Happy Birthday, {cp_name}!*\n\n"
                    f"Wishing you a wonderful day! 🎉\n\n"
                    f"_Taskosphere Team_"
                )
                await send_whatsapp_notification(
                    to=cp_phone,
                    message=cp_msg,
                    message_type="birthday",
                    context_id=client_id,
                    sent_by=current_user.id,
                )
                wa_sent_to.append(cp_phone)
            except Exception:
                pass

    return {
        "status": "completed",
        "sent_to": sent_to,
        "failed": failed,
        "no_email": no_email,
        "whatsapp_sent_to": wa_sent_to,
    }


@api_router.get("/leads/meta/services")
async def get_leads_services_meta(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        perms = get_user_permissions(current_user)
        if not perms.get("can_view_all_leads", False):
            raise HTTPException(status_code=403, detail="Leads access not permitted")
    services = await db.clients.distinct("services")
    services = [s for s in services if s and isinstance(s, str)]
    return {"services": list(set(services))}


# REPORTS ROUTES
@api_router.get("/reports/efficiency")
async def get_efficiency_report(
    user_id: Optional[str] = None,
    current_user: User = Depends(check_module_permission("reports", "view")),
):
    target_user_id = user_id or current_user.id
    if target_user_id != current_user.id:
        perms = get_user_permissions(current_user)
        if current_user.role != "admin" and not perms.get("can_view_reports", False):
            raise HTTPException(
                status_code=403, detail="You do not have permission to view reports"
            )
    if target_user_id != current_user.id:
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_reports", []) or []
            # All non-admin roles (including manager) can only see own + explicitly granted users.
            # Manager does NOT get automatic team access to reports — must be granted via view_other_reports.
            if target_user_id not in allowed_users:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view other users' reports",
                )
    logs = (
        await db.activity_logs.find({"user_id": target_user_id}, {"_id": 0})
        .sort("date", -1)
        .limit(30)
        .to_list(100)
    )
    total_screen_time = sum(l.get("screen_time_minutes", 0) for l in logs)
    total_tasks_completed = sum(l.get("tasks_completed", 0) for l in logs)
    target_user_doc = await db.users.find_one(
        {"id": target_user_id}, {"_id": 0, "password": 0}
    )
    user_info = {
        "id": target_user_id,
        "full_name": target_user_doc.get("full_name", "Unknown")
        if target_user_doc
        else "Unknown",
    }
    return {
        "user_id": target_user_id,
        "user": user_info,
        "total_screen_time": total_screen_time,
        "total_tasks_completed": total_tasks_completed,
        "days_logged": len(logs),
    }


@api_router.get("/reports/export")
async def export_reports(
    format: str = "csv",
    user_id: Optional[str] = None,
    current_user: User = Depends(check_module_permission("reports", "download")),
):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_download_reports", False):
        raise HTTPException(
            status_code=403, detail="You do not have permission to download reports"
        )
    target_user_id = user_id or current_user.id
    if target_user_id != current_user.id:
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_reports", []) or []
            # All non-admin roles (including manager) can only export own + explicitly granted users.
            if target_user_id not in allowed_users:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to access other users' reports",
                )
    logs = await db.activity_logs.find({"user_id": target_user_id}, {"_id": 0}).to_list(
        100
    )
    total_screen_time = sum(l.get("screen_time_minutes", 0) for l in logs)
    total_tasks_completed = sum(l.get("tasks_completed", 0) for l in logs)
    report = {
        "user_id": target_user_id,
        "total_screen_time": total_screen_time,
        "total_tasks_completed": total_tasks_completed,
        "days_logged": len(logs),
    }
    if format == "csv":
        output = StringIO()

        def sanitize_csv_value(val):
            val_str = str(val)
            # Strip newlines to prevent CSV row injection in addition to formula injection
            val_str = val_str.replace("\r", "").replace("\n", " ")
            if val_str and val_str[0] in ["=", "+", "-", "@"]:
                return f"'{val_str}"
            return val_str

        writer = csv.writer(output)
        writer.writerow(["User ID", "Screen Time", "Tasks Completed", "Days Logged"])
        writer.writerow(
            [
                sanitize_csv_value(report["user_id"]),
                sanitize_csv_value(report["total_screen_time"]),
                sanitize_csv_value(report["total_tasks_completed"]),
                sanitize_csv_value(report["days_logged"]),
            ]
        )
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=efficiency_report_{target_user_id}.csv"
            },
        )
    elif format == "pdf":
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Arial", size=12)
        pdf.cell(200, 10, txt="Efficiency Report", ln=1, align="C")
        pdf.ln(10)
        pdf.multi_cell(0, 8, f"User ID: {report['user_id']}")
        pdf.multi_cell(0, 8, f"Screen Time: {report['total_screen_time']} minutes")
        pdf.multi_cell(0, 8, f"Tasks Completed: {report['total_tasks_completed']}")
        pdf.multi_cell(0, 8, f"Days Logged: {report['days_logged']}")
        pdf_output = BytesIO()
        pdf_output.write(pdf.output(dest="S").encode("latin1"))
        pdf_output.seek(0)
        return StreamingResponse(
            pdf_output,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=efficiency_report_{target_user_id}.pdf"
            },
        )
    else:
        raise HTTPException(status_code=400, detail="Invalid format")


# ====================== PERFORMANCE RANKINGS ======================
# --- Scoring configuration (env-overridable) ---
# Monthly work-hours target used for the Work Hours component of the score.
MONTHLY_HOURS_TARGET = float(os.environ.get("MONTHLY_HOURS_TARGET", 180))
# Extra hours beyond the target are converted into bonus points at this rate,
# capped at HOURS_BONUS_POINTS_MAX. Bonus points are strictly additive.
HOURS_BONUS_POINTS_PER_HOUR = float(os.environ.get("HOURS_BONUS_POINTS_PER_HOUR", 0.1))
HOURS_BONUS_POINTS_MAX = float(os.environ.get("HOURS_BONUS_POINTS_MAX", 5))


@api_router.get("/reports/performance-rankings", response_model=List[PerformanceMetric])
async def get_performance_rankings(
    period: str = Query("monthly", enum=["weekly", "monthly", "all_time"]),
    # FIX: was check_module_permission("reports","view") → can_view_reports.
    # Called as a secondary/widget call by Attendance page. All roles may see rankings.
    current_user: User = Depends(get_current_user),
):
    global rankings_cache, rankings_cache_time
    cache_key = f"rankings_{period}"
    if (
        cache_key in rankings_cache
        and cache_key in rankings_cache_time
        and
        # Use timezone-aware UTC datetime for cache comparison to avoid TypeError
        (datetime.now(timezone.utc) - rankings_cache_time[cache_key]).total_seconds()
        < 300
    ):
        return rankings_cache[cache_key]

    now = datetime.now(IST)
    if period == "weekly":
        start_date = now - timedelta(days=7)
    elif period == "monthly":
        start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start_date = datetime(2024, 1, 1, tzinfo=timezone.utc)

    end_date_str = now.strftime("%Y-%m-%d")
    start_date_str = start_date.strftime("%Y-%m-%d")

    # FIX: expected_working_days used to be a hard-coded 22 (monthly) / 5 (weekly).
    # That unfairly tanks attendance_percent for EVERYONE right after a new period
    # starts — e.g. viewing "monthly" on the 1st compares 0-1 days present against
    # 22 expected days, so the attendance component (25% of the score) rounds to 0
    # for the whole team. We now count only the working days that have actually
    # ELAPSED so far in the period (Mon-Fri, minus confirmed company holidays).
    holiday_docs = await db.holidays.find(
        {
            "date": {"$gte": start_date_str, "$lte": end_date_str},
            "status": "confirmed",
        },
        {"_id": 0, "date": 1},
    ).to_list(500)
    holiday_dates = {h["date"] for h in holiday_docs}
    expected_working_days = 0
    cursor_date = start_date.date()
    today_date = now.date()
    while cursor_date <= today_date:
        if cursor_date.weekday() < 5 and cursor_date.isoformat() not in holiday_dates:
            expected_working_days += 1
        cursor_date += timedelta(days=1)
    expected_working_days = max(expected_working_days, 1)

    users = await db.users.find(
        {"role": {"$ne": "admin"}}, {"id": 1, "full_name": 1, "profile_picture": 1}
    ).to_list(length=None)
    uids = [u["id"] for u in users]

    # PERF FIX: this endpoint used to run ~8 separate DB queries PER USER
    # inside the loop below (attendance, desktop-activity, 4x count_documents,
    # due-tasks, completed-todos) — for 30 staff that's 240+ sequential round
    # trips on every cache miss. It's called by both the Tasks page and the
    # Attendance page, so that N+1 pattern was the single biggest cause of lag
    # on both. Fixed by batch-fetching each collection ONCE with an `$in` on
    # all user ids, then grouping the results in Python per user below —
    # same math, 8 queries total instead of 8 x N.
    (
        all_attendance,
        all_agent_logs,
        all_due_tasks,
        all_completed_todos,
        all_tasks_assigned,
        all_completed_tasks,
        all_todos_assigned,
        all_completed_todos_count,
    ) = await asyncio.gather(
        db.attendance.find(
            {"user_id": {"$in": uids}, "date": {"$gte": start_date_str, "$lte": end_date_str}},
            {"_id": 0, "user_id": 1, "duration_minutes": 1, "is_late": 1, "status": 1},
        ).to_list(100000),
        db.desktop_activity.find(
            {"user_id": {"$in": uids}, "date": {"$gte": start_date_str, "$lte": end_date_str}},
            {"_id": 0, "user_id": 1, "activeSeconds": 1},
        ).to_list(100000),
        db.tasks.find(
            {"assigned_to": {"$in": uids}, "status": "completed", "due_date": {"$ne": None}},
            {"_id": 0, "assigned_to": 1, "due_date": 1, "completed_at": 1, "updated_at": 1},
        ).to_list(100000),
        db.todos.find(
            {"user_id": {"$in": uids}, "is_completed": True},
            {"_id": 0, "user_id": 1, "due_date": 1, "completed_at": 1},
        ).to_list(100000),
        db.tasks.find(
            {"assigned_to": {"$in": uids}}, {"_id": 0, "assigned_to": 1}
        ).to_list(100000),
        db.tasks.find(
            {"assigned_to": {"$in": uids}, "status": "completed"}, {"_id": 0, "assigned_to": 1}
        ).to_list(100000),
        db.todos.find(
            {"user_id": {"$in": uids}}, {"_id": 0, "user_id": 1}
        ).to_list(100000),
        db.todos.find(
            {"user_id": {"$in": uids}, "is_completed": True}, {"_id": 0, "user_id": 1}
        ).to_list(100000),
    )

    def _group_by(docs, key):
        out = {}
        for d in docs:
            out.setdefault(d.get(key), []).append(d)
        return out

    attendance_by_uid = _group_by(all_attendance, "user_id")
    agent_logs_by_uid = _group_by(all_agent_logs, "user_id")
    due_tasks_by_uid = _group_by(all_due_tasks, "assigned_to")
    completed_todos_by_uid = _group_by(all_completed_todos, "user_id")
    tasks_assigned_count = Counter(d.get("assigned_to") for d in all_tasks_assigned)
    completed_tasks_count = Counter(d.get("assigned_to") for d in all_completed_tasks)
    todos_assigned_count = Counter(d.get("user_id") for d in all_todos_assigned)
    completed_todos_count_map = Counter(d.get("user_id") for d in all_completed_todos_count)

    rankings = []
    for user in users:
        uid = user["id"]

        # ---------------- Attendance & punctuality ----------------
        att_records = attendance_by_uid.get(uid, [])
        # FIX: this used to count EVERY attendance document as a "present" day —
        # including the auto-marked "absent" record the system inserts each night
        # for anyone who never punched in. That silently counted absences as
        # attendance. Only present-type statuses count now; absences are tracked
        # separately below and used as an explicit discipline penalty.
        present_statuses = {"present", "half_day", "wfh", "late"}
        present_records = [r for r in att_records if r.get("status") in present_statuses]
        days_present = len(present_records)
        absent_days = len([r for r in att_records if r.get("status") == "absent"])
        total_minutes = sum(r.get("duration_minutes", 0) or 0 for r in present_records)
        total_hours = round(total_minutes / 60, 1)
        attendance_percent = round(
            min((days_present / expected_working_days) * 100, 100), 1
        )
        timely_days = len([r for r in present_records if not r.get("is_late", False)])
        timely_punchin_percent = (
            round((timely_days / days_present) * 100, 1) if days_present else 0
        )

        # ---------------- Desktop-agent hours worked on PC ----------------
        # FIX: the desktop agent already reports real active-time per day
        # (db.desktop_activity.activeSeconds) but it was never read anywhere in
        # the ranking calculation. Where the agent is installed and has reported
        # data for this period, its measured active time now drives "Duration of
        # working"; otherwise we fall back to punch-in/punch-out duration.
        agent_logs = agent_logs_by_uid.get(uid, [])
        agent_hours = round(sum(a.get("activeSeconds", 0) or 0 for a in agent_logs) / 3600, 1)
        effective_hours = agent_hours if agent_logs else total_hours

        # ---------------- Task completion percentage ----------------
        # FIX (this is what was STILL causing 0% after the first patch):
        # the numerator ("tasks completed") was gated to completed_at/updated_at
        # >= start_date. That's fine for a mid-period check, but on day 1 of a
        # new week/month essentially nobody has completed anything WITHIN that
        # brand-new window yet, so the numerator is legitimately 0 and the
        # percentage resets to 0 for the whole team every single period. This
        # metric should reflect current workload completion — the same "17/20"
        # style figure already shown on the Tasks page — not get wiped out at
        # the start of every week/month. It is now a lifetime completed/assigned
        # ratio (tasks + todos), independent of the period filter. Attendance,
        # hours and punctuality below remain correctly period-scoped, since
        # those genuinely are about "this week/month" specifically.
        tasks_assigned = tasks_assigned_count.get(uid, 0)
        completed_tasks = completed_tasks_count.get(uid, 0)
        todos_assigned = todos_assigned_count.get(uid, 0)
        completed_todos = completed_todos_count_map.get(uid, 0)
        total_assigned = tasks_assigned + todos_assigned
        total_completed = completed_tasks + completed_todos
        task_completion_percent = (
            round(min((total_completed / total_assigned) * 100, 100), 1)
            if total_assigned
            else 0
        )

        # ---------------- On-time completion ----------------
        # FIX: same period-reset problem as above, PLUS this metric used to only
        # look at db.todos (the small personal checklist) and completely ignored
        # db.tasks — the app's actual primary work unit (Task Management, 150+
        # tasks with due dates). Anyone who does real work through Tasks but
        # rarely touches the separate To-Do widget always scored 0% here, losing
        # 15 guaranteed points. This is now a lifetime on-time ratio across both
        # tasks and todos that have a due date, not reset every period.
        due_tasks = due_tasks_by_uid.get(uid, [])
        ontime_tasks = 0
        for t in due_tasks:
            due = safe_dt(t.get("due_date"))
            completed_at = safe_dt(t.get("completed_at")) or safe_dt(t.get("updated_at"))
            if due and completed_at and completed_at <= due:
                ontime_tasks += 1

        completed_todos_docs = completed_todos_by_uid.get(uid, [])
        ontime_todos = 0
        todos_with_due = 0
        for t in completed_todos_docs:
            if t.get("due_date"):
                todos_with_due += 1
                due = safe_dt(t.get("due_date"))
                completed_at = safe_dt(t.get("completed_at"))
                if due and completed_at and completed_at <= due:
                    ontime_todos += 1

        ontime_total = len(due_tasks) + todos_with_due
        ontime_completed = ontime_tasks + ontime_todos
        todo_ontime_percent = (
            round((ontime_completed / ontime_total) * 100, 1) if ontime_total else 0
        )

        # ---------------- Composite score ----------------
        # Work Hours scoring (configurable):
        #   hours < target  -> proportional points
        #   hours >= target -> ALWAYS full points (never reduced)
        #   extra hours     -> converted into bonus points (capped)
        hours_worked = float(effective_hours or 0)
        safe_hours_ratio = min((hours_worked / MONTHLY_HOURS_TARGET), 1) if hours_worked else 0
        extra_hours = max(0.0, hours_worked - MONTHLY_HOURS_TARGET)
        bonus_points = round(
            min(extra_hours * HOURS_BONUS_POINTS_PER_HOUR, HOURS_BONUS_POINTS_MAX), 2
        )
        score = (
            float(attendance_percent or 0) * 0.25
            + safe_hours_ratio * 100 * 0.20
            + float(task_completion_percent or 0) * 0.25
            + float(todo_ontime_percent or 0) * 0.15
            + float(timely_punchin_percent or 0) * 0.15
        )
        # FIX: "number of absent days" was tracked nowhere in the score even
        # though the spec calls for it. Each unexplained absence this period now
        # costs 2 pts, capped at a 10-pt maximum deduction, so it visibly affects
        # ranking without being able to wipe out an otherwise strong score.
        discipline_penalty = min(absent_days * 2, 10)
        # Bonus points are additive only — they never replace or reduce the
        # base Work Hours contribution.
        overall_score = round(min(max(score - discipline_penalty, 0) + bonus_points, 100), 1)

        if overall_score >= 95:
            badge = "Star Performer"
        elif overall_score >= 85:
            badge = "Top Performer"
        else:
            badge = "Good Performer"

        rankings.append(
            PerformanceMetric(
                user_id=str(uid),
                user_name=str(user.get("full_name", "Unknown")),
                profile_picture=user.get("profile_picture"),
                attendance_percent=float(attendance_percent or 0),
                total_hours=float(effective_hours or 0),
                task_completion_percent=float(task_completion_percent or 0),
                todo_ontime_percent=float(todo_ontime_percent or 0),
                timely_punchin_percent=float(timely_punchin_percent or 0),
                overall_score=float(overall_score or 0),
                badge=str(badge),
                auto_absent_count=int(absent_days),
                discipline_penalty=float(discipline_penalty),
                final_score=float(overall_score or 0),
                extra_hours=float(round(extra_hours, 2)),
                bonus_points=float(bonus_points),
            )
        )

    rankings.sort(key=lambda x: x.overall_score, reverse=True)
    for i, r in enumerate(rankings):
        r.rank = i + 1

    rankings_cache[cache_key] = rankings
    # Store as timezone-aware UTC datetime so comparison never throws TypeError
    rankings_cache_time[cache_key] = datetime.now(timezone.utc)
    return rankings


# ==============================================================
# INTEGRATED MASTER DATA SYSTEM & CLIENT ROUTES
# ==============================================================
@api_router.post("/master/import-master-preview")
async def import_master_data_preview(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    if current_user.role.lower() != "admin":
        raise HTTPException(
            status_code=403,
            detail="Administrative clearance required for Master Data access.",
        )
    filename = file.filename.lower()
    if not filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=400,
            detail="Deployment failed: Only Excel formats (.xlsx, .xls) supported.",
        )
    try:
        content = await file.read()
        excel = pd.ExcelFile(BytesIO(content))
        parsed_blueprint = {}
        total_vectors = 0
        for sheet_name in excel.sheet_names:
            df = pd.read_excel(excel, sheet_name=sheet_name)
            df = df.fillna("")
            records = df.to_dict(orient="records")
            parsed_blueprint[sheet_name] = records
            total_vectors += len(records)
        return {
            "status": "Ready for Audit",
            "message": f"Detected {len(excel.sheet_names)} operational layers with {total_vectors} vectors.",
            "sheets_found": excel.sheet_names,
            "data": parsed_blueprint,
        }
    except Exception as e:
        logger.error(f"Blueprint Error: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Excel parse failure: {str(e)}")


@api_router.post("/master/sync-sheets")
async def sync_master_sheets(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    if current_user.role.lower() != "admin":
        raise HTTPException(
            status_code=403, detail="Master Data clearance level 5 required."
        )
    try:
        content = await file.read()
        excel = pd.ExcelFile(BytesIO(content))
        sync_results = {"clients": 0, "compliance": 0, "staff": 0}
        now_iso = datetime.now(timezone.utc).isoformat()
        for sheet in excel.sheet_names:
            df = pd.read_excel(excel, sheet_name=sheet).fillna("")
            records = df.to_dict(orient="records")
            sheet_type = sheet.lower()
            if "client" in sheet_type:
                for rec in records:
                    await db.clients.update_one(
                        {"company_name": str(rec.get("company_name", "")).strip()},
                        {
                            "$set": {
                                **rec,
                                "id": str(uuid.uuid4())
                                if "id" not in rec
                                else rec["id"],
                                "created_by": current_user.id,
                                "updated_at": now_iso,
                            }
                        },
                        upsert=True,
                    )
                    sync_results["clients"] += 1
            elif "due" in sheet_type or "compliance" in sheet_type:
                for rec in records:
                    await db.due_dates.insert_one(
                        {
                            **rec,
                            "id": str(uuid.uuid4()),
                            "created_by": current_user.id,
                            "created_at": now_iso,
                            "status": "pending",
                        }
                    )
                    sync_results["compliance"] += 1
            elif "staff" in sheet_type or "user" in sheet_type:
                for rec in records:
                    await db.users.update_one(
                        {"email": rec.get("email")},
                        {"$set": {**rec, "id": str(uuid.uuid4()), "is_active": True}},
                        upsert=True,
                    )
                    sync_results["staff"] += 1
            await create_audit_log(
                current_user=current_user,
                action="GLOBAL_MASTER_SYNC",
                module="master_data",
                record_id="multi_sheet_payload",
                new_data=sync_results,
            )
        return {
            "message": "Global Master Sync Successfully Executed",
            "telemetry": sync_results,
        }
    except Exception as e:
        logger.error(f"Sync Failure: {str(e)}")
        raise HTTPException(
            status_code=400, detail=f"Database synchronization failed: {str(e)}"
        )


# ==============================================================
# GST CERTIFICATE PDF PARSER  (pure pdfplumber — no 3rd-party AI)
# ==============================================================


def _strip_watermark(s: str) -> str:
    """Remove single/short watermark chars from start/end of a string."""
    if not s:
        return s
    s = s.strip()
    s = re.sub(r"^[A-Za-z]\s+(?=[A-Z])", "", s)
    s = re.sub(r"\s+[A-Za-z]\s*$", "", s)
    return re.sub(r"\s{2,}", " ", s).strip()


def _clean_gst_watermark(text: str) -> str:
    """
    Remove GST certificate 'Goods and Services Tax Network' watermark fragments.
    The watermark appears as isolated 1-3 character syllables interspersed in the
    extracted text (e.g. x, Ta, es, ic, rv, Se, d, an, ds, oo, G).
    Strategy: remove tokens that are 1-3 chars, all-alpha, and all chars belong
    to the watermark character set, when surrounded by longer real-word neighbors.
    """
    if not text:
        return text
    WM_CHARS = set("goodservicstaxnewrk")
    result_lines = []
    for line in text.splitlines():
        tokens = line.split()
        cleaned = []
        for i, tok in enumerate(tokens):
            tok_alpha = re.sub(r"[^a-zA-Z]", "", tok)
            is_wm_candidate = (
                1 <= len(tok) <= 3
                and len(tok_alpha) >= 1
                and all(c.lower() in WM_CHARS for c in tok_alpha)
                and tok_alpha.isalpha()
            )
            if is_wm_candidate:
                prev_alpha_len = (
                    len(re.sub(r"[^a-zA-Z]", "", tokens[i - 1])) if i > 0 else 0
                )
                next_alpha_len = (
                    len(re.sub(r"[^a-zA-Z]", "", tokens[i + 1]))
                    if i + 1 < len(tokens)
                    else 0
                )
                if prev_alpha_len > 3 and next_alpha_len > 3:
                    continue  # surrounded by real words — discard as watermark
            cleaned.append(tok)
        result_lines.append(" ".join(cleaned))
    return "\n".join(result_lines)


def _parse_gst_reg06_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse a GST Form REG-06 PDF using pdfplumber + regex.
    Handles PDFs with diagonal 'Goods and Services Tax Network' watermark whose
    individual syllables (x, Ta, es, ic, rv, Se, d, an, ds, oo, G ...) bleed
    into the extracted text and contaminate address fields.
    Returns: gstin, legal_name, trade_name, constitution, constitution_raw,
             address, city, state, pin, full_address, registration_type,
             valid_from, partners[{name, designation}].
    """
    from io import BytesIO
    import pdfplumber

    _INDIAN_STATES = {
        "andhra pradesh",
        "arunachal pradesh",
        "assam",
        "bihar",
        "chhattisgarh",
        "goa",
        "gujarat",
        "haryana",
        "himachal pradesh",
        "jharkhand",
        "karnataka",
        "kerala",
        "madhya pradesh",
        "maharashtra",
        "manipur",
        "meghalaya",
        "mizoram",
        "nagaland",
        "odisha",
        "punjab",
        "rajasthan",
        "sikkim",
        "tamil nadu",
        "telangana",
        "tripura",
        "uttar pradesh",
        "uttarakhand",
        "west bengal",
        "andaman and nicobar islands",
        "andaman and nicobar",
        "chandigarh",
        "dadra and nagar haveli and daman and diu",
        "dadra and nagar haveli",
        "daman and diu",
        "delhi",
        "jammu and kashmir",
        "ladakh",
        "lakshadweep",
        "puducherry",
        "pondicherry",
        "uttaranchal",
        "orissa",
    }

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        raw_pages = [p.extract_text() or "" for p in pdf.pages]

    # Apply watermark cleaning to every page
    pages = [_clean_gst_watermark(p) for p in raw_pages]
    page1 = pages[0] if pages else ""
    annexure_b = next(
        (
            p
            for p in pages
            if "Annexure B" in p
            or "Details of Managing" in p
            or "Details of Proprietor" in p
        ),
        "",
    )

    def _find(pat, text, group=1, flags=re.IGNORECASE | re.MULTILINE):
        m = re.search(pat, text, flags)
        return _strip_watermark(m.group(group).strip()) if m else ""

    # ── Core fields ──────────────────────────────────────────────────────────
    gstin = _find(r"Registration Number\s*[:\-]?\s*([A-Z0-9]{15})", page1)

    legal_name = _find(
        r"(?:^\d+\.\s+)?Legal Name\s+([A-Z][A-Z0-9 &.\-,]+?)(?=\s*\n\s*\d+\.|\Z)", page1
    )
    if not legal_name:
        legal_name = _find(r"Legal Name\s*\n\s*([A-Z][A-Z0-9 &.\-,]+)", page1)

    trade_name = _find(
        r"Trade Name,?\s*if any\s+([A-Z][A-Z0-9 &.\-,]+?)(?=\s*\n\s*\d+\.|\Z)", page1
    )
    if not trade_name:
        trade_name = _find(r"Trade Name.*?\n\s*([A-Z][A-Z0-9 &.\-,]+)", page1)

    const_raw = _find(
        r"Constitution of Business\s+([A-Za-z ]+?)(?=\s*\n\s*\d+\.|\Z)", page1
    )
    if not const_raw:
        const_raw = _find(r"Constitution of Business\s*\n\s*([A-Za-z ]+)", page1)

    _cmap = {
        "proprietorship": "proprietor",
        "proprietary": "proprietor",
        "sole proprietorship": "proprietor",
        "proprietor": "proprietor",
        "private limited company": "pvt_ltd",
        "private limited": "pvt_ltd",
        "pvt ltd": "pvt_ltd",
        "pvt. ltd.": "pvt_ltd",
        "limited liability partnership": "llp",
        "llp": "llp",
        "partnership firm": "partnership",
        "partnership": "partnership",
        "huf": "huf",
        "hindu undivided family": "huf",
        "trust": "trust",
        "public limited company": "pvt_ltd",
        "public limited": "pvt_ltd",
        "society": "other",
        "cooperative": "other",
    }
    lc_const = const_raw.lower().strip()
    constitution = _cmap.get(lc_const, "")
    if not constitution:
        if "private limited" in lc_const or "pvt" in lc_const:
            constitution = "pvt_ltd"
        elif "llp" in lc_const or "limited liability" in lc_const:
            constitution = "llp"
        elif "proprietor" in lc_const or "sole " in lc_const:
            constitution = "proprietor"
        elif "partnership" in lc_const:
            constitution = "partnership"
        elif "huf" in lc_const or "hindu undivided" in lc_const:
            constitution = "huf"
        elif "trust" in lc_const:
            constitution = "trust"
        elif "public limited" in lc_const:
            constitution = "pvt_ltd"
        else:
            constitution = "other"

    # ── Address: extract the raw address block after watermark cleaning ───────
    addr_block_m = re.search(
        r"Address of Principal Place of\s*(?:Business)?\s*(.+?)(?=\n\s*\d+\.\s+|Date of Liability|6\.\s|$)",
        page1,
        re.DOTALL | re.IGNORECASE,
    )
    addr_block_raw = ""
    if addr_block_m:
        chunk = addr_block_m.group(1) or ""
        chunk = re.sub(r"(?i)^Business\s*[:\-]?\s*", "", chunk.strip())
        chunk = re.sub(r"(?i)\nBusiness\s*[:\-]?\s*", " ", chunk)
        chunk = re.sub(
            r"(?i)^Address\s+of\s+Principal\s+Place\s+of\s+Business\s*[:\-]?\s*",
            "",
            chunk.strip(),
        )
        chunk = re.sub(r"^\d+\.\s+", "", chunk.strip())
        addr_block_raw = re.sub(r"\s+", " ", chunk).strip()

    address = city = state = pin = full_address = ""

    if addr_block_raw:
        # ── Structured label-bounded extraction ────────────────────────────────
        # After watermark cleaning, the address block looks like:
        # "Building No./Flat No.: 81 Name Of Premises/Building: SHRIJI NAGAR 2
        #  Road/Street: GODADARA Locality/Sub Locality: Limbayat
        #  City/Town/Village: Surat District: Surat State: Gujarat PIN Code: 394210"
        # Some 1-2 char WM residues may still remain between labels.

        ALL_LABELS = [
            r"Floor No\.",
            r"Building No\./Flat No\.",
            r"Name Of Premises/Building",
            r"Road/Street(?:/Lane)?",
            r"Locality/Sub Loc(?:ality)?",
            r"City/Town/Village",
            r"District",
            r"State",
            r"PIN Code",
        ]

        def _lbl(start_pat, stop_pats, text):
            """Extract value between start label and first stop label."""
            stop_re = "|".join(stop_pats)
            m = re.search(
                start_pat
                + r"[:\s]+(?:[A-Za-z]{1,3}\s+)?(.+?)(?=\s+(?:"
                + stop_re
                + r")|$)",
                text,
                re.IGNORECASE | re.DOTALL,
            )
            if not m:
                return ""
            val = m.group(1).strip()
            val = re.sub(r"\s+[A-Za-z]{1,3}\s*$", "", val).strip()
            val = re.sub(r"^[A-Za-z]{1,3}\s+(?=[A-Z0-9])", "", val).strip()
            return _strip_watermark(val)

        floor = _lbl(r"Floor No\.", ALL_LABELS[2:], addr_block_raw)
        building = _lbl(r"Building No\./Flat No\.", ALL_LABELS[2:], addr_block_raw)
        premises = _lbl(r"Name Of Premises/Building", ALL_LABELS[3:], addr_block_raw)
        road = _lbl(r"Road/Street(?:/Lane)?", ALL_LABELS[4:], addr_block_raw)
        locality = _lbl(r"Locality/Sub Loc(?:ality)?", ALL_LABELS[5:], addr_block_raw)
        city_lbl = _lbl(r"City/Town/Village", ALL_LABELS[6:], addr_block_raw)
        district = _lbl(r"District", ALL_LABELS[7:], addr_block_raw)
        state_lbl = _lbl(r"State", ALL_LABELS[8:], addr_block_raw)
        pin_lbl = _find(r"PIN Code[:\s]+(\d{6})", addr_block_raw)

        if any([building, premises, road, city_lbl, state_lbl, pin_lbl]):
            addr_parts = [x for x in [floor, building, premises, road, locality] if x]
            address = ", ".join(addr_parts)
            city = city_lbl or district
            state = state_lbl
            pin = pin_lbl
            full_address = ", ".join(x for x in [address, city, state, pin] if x)
        else:
            # ── Fallback: comma-separated inline address ────────────────────
            full_address = addr_block_raw
            raw = re.sub(
                r"(?i)(signature not verified|digitally signed|date:.*|goods and services tax.*)",
                "",
                addr_block_raw,
            ).strip()
            parts = [p.strip() for p in re.split(r",\s*", raw) if p.strip()]
            parts = [
                re.sub(r"(?i)^address\s*[:\-]\s*", "", p).strip()
                for p in parts
                if p.strip()
            ]

            for i, p in enumerate(parts):
                if re.match(r"^\d{6}$", re.sub(r"\s+", "", p)):
                    pin = re.sub(r"\s+", "", p)
                    parts = parts[:i] + parts[i + 1 :]
                    break

            for i in range(len(parts) - 1, -1, -1):
                if parts[i].lower().strip() in _INDIAN_STATES:
                    state = parts[i].strip().title()
                    parts = parts[:i] + parts[i + 1 :]
                    break

            if parts:
                last = parts[-1].strip()
                prev = parts[-2].strip() if len(parts) > 1 else ""
                if last.lower() == prev.lower():
                    parts = parts[:-1]
                city = parts[-1].strip() if parts else ""
                if city:
                    parts = parts[:-1]
            address = ", ".join(p for p in parts if p)

    # ── Other fields ──────────────────────────────────────────────────────────
    reg_type = _find(r"Type of Registration\s*[\n\r]+\s*([A-Za-z ]+)", page1)
    if not reg_type:
        reg_type = _find(r"Type of Registration\s+([A-Za-z ]+)", page1)
    valid_from = _find(r"Period of Validity\s+From\s+(\d{2}/\d{2}/\d{4})", page1)

    # ── Partners / Directors (Annexure B) ─────────────────────────────────────
    partners = []
    if annexure_b:
        clean_lines = [
            ln
            for ln in annexure_b.split("\n")
            if not re.fullmatch(r"\s*[a-zA-Z]{1,2}\s*", ln)
        ]
        clean = _clean_gst_watermark("\n".join(clean_lines))
        clean = re.sub(r"(?m)^[a-zA-Z]\s+(Designation/Status)", r"\1", clean)

        entries = re.findall(
            r"\d+\s+Name\s+([A-Z][A-Z \-]+?)\s*\n\s*Designation/Status\s+([A-Za-z /]+)",
            clean,
            re.IGNORECASE,
        )
        if not entries:
            entries = re.findall(
                r"Name\s+([A-Z][A-Z \-]+?)\s*\n\s*Designation(?:/Status)?\s+([A-Za-z /]+)",
                clean,
                re.IGNORECASE,
            )
        for name, desig in entries:
            name_clean = _strip_watermark(name.strip())
            desig_clean = _strip_watermark(desig.strip())
            if name_clean:
                partners.append({"name": name_clean, "designation": desig_clean})

    return {
        "gstin": gstin,
        "legal_name": legal_name,
        "trade_name": trade_name,
        "constitution": constitution,
        "constitution_raw": const_raw,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
        "full_address": full_address,
        "registration_type": reg_type,
        "valid_from": valid_from,
        "partners": partners,
    }


@api_router.get("/clients/check-gstin")
async def check_gstin(gstin: str, current_user: User = Depends(get_current_user)):
    """
    Check if a client with the given GSTIN already exists in the database.
    Returns { exists: bool, client_id: str|null, company_name: str|null }
    """
    gstin = gstin.strip().upper()
    if not gstin:
        return {"exists": False, "client_id": None, "company_name": None}

    existing = await db.clients.find_one(
        {"gstin": gstin}, {"_id": 1, "company_name": 1}
    )
    if existing:
        return {
            "exists": True,
            "client_id": str(existing["_id"]),
            "company_name": existing.get("company_name", ""),
        }
    return {"exists": False, "client_id": None, "company_name": None}


# ==============================================================
# # UDYAM CERTIFICATE PDF PARSER
# ==============================================================
def _parse_udyam_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse a Udyam Registration Certificate PDF.
    Handles single-column and two-column (side-by-side field) layouts.
    Returns: udyam_number, enterprise_name, msme_type, major_activity,
             mobile, email, date_of_incorporation, address, city, state, pin,
             social_category, pan.
    """
    from io import BytesIO
    import pdfplumber

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        pages = [p.extract_text() or "" for p in pdf.pages]

    full_text = "\n".join(pages)

    def _find(pat, text, group=1, flags=re.IGNORECASE | re.MULTILINE | re.DOTALL):
        m = re.search(pat, text, flags)
        return m.group(group).strip() if m else ""

    # Udyam registration number
    udyam_number = _find(r"(UDYAM-[A-Z]{2}-\d{2}-\d+)", full_text)

    # Enterprise name — strip M/S prefix
    enterprise_name_raw = _find(r"NAME OF ENTERPRISE\s+([^\n]+)", full_text)
    if not enterprise_name_raw:
        enterprise_name_raw = _find(
            r"Name of Enterprise\s*[:\-]?\s*([^\n]+)", full_text
        )
    enterprise_name = re.sub(
        r"(?i)^M[/\.]?S[/\.]?\s+", "", enterprise_name_raw.strip()
    ).strip()

    # MSME type — most recent classification year entry
    type_matches = re.findall(
        r"\d{4}-\d{2,4}\s+(Micro|Small|Medium)", full_text, re.IGNORECASE
    )
    msme_type = (
        type_matches[0].title()
        if type_matches
        else _find(r"\b(Micro|Small|Medium)\b", full_text)
    )

    # Major activity
    major_activity = _find(r"MAJOR ACTIVITY\s+([^\n]+)", full_text)
    if not major_activity:
        major_activity = _find(r"Major Activity\s*[:\-]?\s*([^\n]+)", full_text)

    # Social category
    social_category = _find(
        r"SOCIAL CATEGORY OF\s*\n\s*([A-Z][A-Z ]+?)(?=\s*\n\s*ENTREPRENEUR|\s*ENTREPRENEUR)",
        full_text,
    )
    if not social_category:
        social_category = _find(r"Social Category.*?([A-Z][A-Z ]+?)(?=\n)", full_text)

    # Mobile — prefer 10-digit Indian mobile number
    mobile = _find(r"Mobile(?:\s*No\.?)?\s*[:\-]?\s*(\d{10})", full_text)

    # Email
    email = _find(
        r"Email(?:[\s:]|\s*Id)?\s*[:\-]?\s*([\w.+\-]+@[\w.\-]+\.\w+)", full_text
    )

    # PAN
    pan = _find(r"\bPAN\s+([A-Z]{5}\d{4}[A-Z])\b", full_text)
    if not pan:
        pan = _find(r"\bPAN\b[:\s]+([A-Z]{5}\d{4}[A-Z])\b", full_text)

    # Date of incorporation / registration
    doi_raw = _find(
        r"DATE OF (?:INCORPORATION|REGISTRATION)[^\n]*\n[^\n]*\n\s*(\d{2}/\d{2}/\d{4})",
        full_text,
    )
    if not doi_raw:
        doi_raw = _find(
            r"Date of Incorporation\s*[:\-]?\s*(\d{2}/\d{2}/\d{4})", full_text
        )
    date_of_incorporation = ""
    if doi_raw:
        try:
            from dateutil import parser as date_parser

            date_of_incorporation = date_parser.parse(doi_raw, dayfirst=True).strftime(
                "%Y-%m-%d"
            )
        except Exception:
            date_of_incorporation = doi_raw

    # ── Address — two-column pdfplumber layout ─────────────────────────────────
    # Fields appear as: "LABEL VALUE   LABEL VALUE" on same line (two columns merged)
    # E.g.: "Flat/Door/Block No. PLOT NO. A-8-9-10-11   Name of Premises/ Building DIAMOND ESTATE"

    def _addr_val(label_pat, text, stop_pats=None):
        if stop_pats:
            stop = "|".join(stop_pats)
            m = re.search(
                label_pat + r"\s+([^\n]+?)(?=\s{2,}(?:" + stop + r")\s|\n|$)",
                text,
                re.IGNORECASE,
            )
            if not m:
                m = re.search(
                    label_pat + r"\s+(.+?)(?=\s+(?:" + stop + r")\s|\n|$)",
                    text,
                    re.IGNORECASE | re.DOTALL,
                )
        else:
            m = re.search(label_pat + r"\s+([^\n]+)", text, re.IGNORECASE)
        return m.group(1).strip().rstrip(",") if m else ""

    flat_no = _addr_val(
        r"Flat/Door/Block No\.?",
        full_text,
        stop_pats=[r"Name of Premises", r"Building", r"Village/Town"],
    )
    premises = _addr_val(
        r"Name of Premises/?\s*Building",
        full_text,
        stop_pats=[r"Village/Town", r"Block", r"Road/Street"],
    )
    village = _addr_val(
        r"Village/Town",
        full_text,
        stop_pats=[r"Block\b", r"Road/Street", r"City\b", r"State\b"],
    )
    block_val = _addr_val(
        r"\bBlock\b",
        full_text,
        stop_pats=[r"Road/Street", r"City\b", r"State\b", r"Flat/Door"],
    )
    if len(block_val) <= 1:
        block_val = ""
    road = _addr_val(
        r"Road/Street(?:/Lane)?",
        full_text,
        stop_pats=[r"City\b", r"State\b", r"District\b"],
    )

    city_m = re.search(
        r"\bCity\s+([A-Z][A-Z0-9 ]+?)(?=\s+State\b|\s+District\b|\s*$)",
        full_text,
        re.IGNORECASE | re.MULTILINE,
    )
    city = city_m.group(1).strip().title() if city_m else ""

    state_m = re.search(
        r"\bState\s+([A-Z][A-Z ]+?)(?=\s+District\b|\s*,|\s*$)",
        full_text,
        re.IGNORECASE | re.MULTILINE,
    )
    state = state_m.group(1).strip().title() if state_m else ""

    pin_m = re.search(r"\bPin\s*[:\-,]?\s*(\d{6})", full_text, re.IGNORECASE)
    pin = pin_m.group(1) if pin_m else ""
    if not pin:
        pin_m2 = re.search(r",\s*(\d{6})\b", full_text)
        pin = pin_m2.group(1) if pin_m2 else ""

    district_m = re.search(
        r"\bDistrict\s+([A-Z][A-Z ]+?)(?=\s*,|\s+Pin|\s*$)",
        full_text,
        re.IGNORECASE | re.MULTILINE,
    )
    district = district_m.group(1).strip().title() if district_m else ""
    if not city and district:
        city = district

    addr_parts_raw = [flat_no, premises, block_val, village, road]
    seen_lower = set()
    addr_parts = []
    for p in addr_parts_raw:
        p = p.strip().rstrip(",")
        if not p or len(p) <= 1:
            continue
        if p.lower() in seen_lower:
            continue
        seen_lower.add(p.lower())
        addr_parts.append(p)
    address = ", ".join(addr_parts)

    return {
        "udyam_number": udyam_number,
        "enterprise_name": enterprise_name,
        "msme_type": msme_type,
        "major_activity": major_activity.strip().title() if major_activity else "",
        "social_category": social_category.strip() if social_category else "",
        "mobile": mobile,
        "email": email,
        "date_of_incorporation": date_of_incorporation,
        "pan": pan,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
    }


# ── ITR Computation PDF parser ────────────────────────────────────────────────
def _parse_itr_computation_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse an ITR Computation of Income PDF and extract all ITR client fields.
    Handles the standard CA software computation format (e.g. EasyOffice, Winman, Saral TaxOffice).
    Returns a dict with:
      - client fields: company_name, pan, email, phone, address, city, state, date_of_birth
      - itr_data fields: itr_type, assessment_year, acknowledgement_no, filing_date,
                         income_salary, income_house_property, income_business,
                         income_capital_gains, income_other_sources,
                         tax_payable, refund_amount, filing_status
    """
    import pdfplumber
    import re as _re

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        full_text = "\n".join((page.extract_text() or "") for page in pdf.pages)

    text = full_text
    result = {}

    def first(pattern, flags=0, group=1):
        m = _re.search(pattern, text, flags | _re.IGNORECASE)
        if m:
            try:
                return m.group(group).strip()
            except IndexError:
                return ""
        return ""

    def to_float(s):
        if not s:
            return None
        cleaned = _re.sub(r"[^0-9.\-]", "", str(s).replace(",", ""))
        try:
            return float(cleaned)
        except ValueError:
            return None

    # ── Assessee Name ──────────────────────────────────────────────────────
    name = first(r"NAME\s+OF\s+ASSESSEE\s*[:\-]?\s*([A-Z][A-Z\s]+?)(?:\n|PAN|$)")
    if not name:
        name = first(r"ASSESSEE\s*[:\-]\s*([A-Z][A-Z\s]+?)(?:\n|PAN|$)")
    if name:
        result["company_name"] = name.strip()

    # ── PAN ────────────────────────────────────────────────────────────────
    pan = first(r"\bPAN\s*[:\-]?\s*([A-Z]{5}[0-9]{4}[A-Z])\b")
    if pan:
        result["pan"] = pan.upper()

    # ── Assessment Year ────────────────────────────────────────────────────
    ay = first(r"ASSESSMENT\s+YEAR\s*[:\-]?\s*(\d{4}\s*[-–]\s*\d{2,4})")
    if ay:
        # Normalise to "2025-26" format
        ay_clean = _re.sub(r"\s", "", ay)
        m_ay = _re.match(r"(\d{4})[-–](\d{2,4})", ay_clean)
        if m_ay:
            yr = m_ay.group(1)
            suffix = m_ay.group(2)[-2:]
            result["assessment_year"] = f"{yr}-{suffix}"

    # ── Financial Year (fallback for AY) ───────────────────────────────────
    if not result.get("assessment_year"):
        fy = first(r"FINANCIAL\s+YEAR\s*[:\-]?\s*(\d{4}\s*[-–]\s*\d{2,4})")
        if fy:
            fy_clean = _re.sub(r"\s", "", fy)
            m_fy = _re.match(r"(\d{4})[-–](\d{2,4})", fy_clean)
            if m_fy:
                # AY = FY + 1
                yr = int(m_fy.group(1)) + 1
                suffix = str(yr)[-2:]
                result["assessment_year"] = f"{yr}-{suffix}"

    # ── ITR Type ───────────────────────────────────────────────────────────
    itr_type = first(r"\bRETURN\s*[:\-]?\s*(ITR[-\s]?[1-7U])\b")
    if not itr_type:
        itr_type = first(r"\b(ITR[-\s]?[1-7U])\b")
    if itr_type:
        # Normalise "ITR3" → "ITR-3"
        itr_norm = _re.sub(r"ITR\s*", "ITR-", itr_type.upper()).replace("--", "-")
        result["itr_type"] = itr_norm

    # ── Filing Date ────────────────────────────────────────────────────────
    filing_date = first(
        r"(?:FILING\s+DATE|DATE\s+OF\s+FILING)\s*[:\-]?\s*(\d{2}[/\-]\d{2}[/\-]\d{4})"
    )
    if filing_date:
        # Convert DD/MM/YYYY or DD-MM-YYYY → YYYY-MM-DD
        parts = _re.split(r"[/\-]", filing_date)
        if len(parts) == 3 and len(parts[2]) == 4:
            result["filing_date"] = (
                f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
            )

    # ── Acknowledgement Number ─────────────────────────────────────────────
    ack = first(
        r"(?:ACK(?:NOWLEDGEMENT)?\.?\s*NO(?:\.)?|NO\.\s*[:\-])\s*[:\-]?\s*(\d{12,15})"
    )
    if not ack:
        ack = first(r"\b(\d{15})\b")  # 15-digit standalone
    if ack:
        result["acknowledgement_no"] = ack

    # ── Email ──────────────────────────────────────────────────────────────
    email = first(r"\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b")
    if email:
        result["email"] = email.lower()

    # ── Phone ──────────────────────────────────────────────────────────────
    phone_m = _re.search(r"\b((?:\+91[\s\-]?)?[6-9][0-9]{9})\b", text)
    if phone_m:
        result["phone"] = _re.sub(r"\D", "", phone_m.group(1))[-10:]

    # ── Address ────────────────────────────────────────────────────────────
    addr = first(r"RESIDENTIAL\s+ADDRESS\s*[:\-]?\s*([^\n]{10,200})")
    if addr:
        # Multi-line addresses may be joined by commas
        result["address"] = addr.strip().rstrip(",")

    # Extract city / state / pin from address
    if result.get("address"):
        addr_text = result["address"]
        # PIN code
        pin_m = _re.search(r"\b(\d{6})\b", addr_text)
        if pin_m:
            result["pin"] = pin_m.group(1)
        # State (common Indian states)
        state_m = _re.search(
            r"\b(Gujarat|Maharashtra|Rajasthan|Madhya Pradesh|Uttar Pradesh|Karnataka|Tamil Nadu|"
            r"Kerala|West Bengal|Delhi|Haryana|Punjab|Andhra Pradesh|Telangana|Odisha|Bihar|"
            r"Jharkhand|Chhattisgarh|Uttarakhand|Himachal Pradesh|Assam|Goa)\b",
            addr_text,
            _re.IGNORECASE,
        )
        if state_m:
            result["state"] = state_m.group(1).title()
        # City heuristic
        city_m = _re.search(
            r"\b(Surat|Ahmedabad|Mumbai|Delhi|Pune|Bangalore|Bengaluru|Chennai|Hyderabad|"
            r"Kolkata|Jaipur|Vadodara|Rajkot|Indore|Bhopal|Nagpur|Lucknow|Patna|Chandigarh|"
            r"Coimbatore|Visakhapatnam)\b",
            addr_text,
            _re.IGNORECASE,
        )
        if city_m:
            result["city"] = city_m.group(1).title()

    # ── Date of Birth ──────────────────────────────────────────────────────
    dob = first(r"DATE\s+OF\s+BIRTH\s*[:\-]?\s*(\d{2}[/\-]\d{2}[/\-]\d{4})")
    if dob:
        parts = _re.split(r"[/\-]", dob)
        if len(parts) == 3 and len(parts[2]) == 4:
            result["date_of_birth"] = (
                f"{parts[2]}-{parts[1].zfill(2)}-{parts[0].zfill(2)}"
            )

    # ── Ward / Circle ──────────────────────────────────────────────────────
    ward = first(
        r"WARD\s*(?:NO\.?|NUMBER)?\s*[:\-]?\s*([A-Z0-9\s\(\)/,]+?)(?:\n|FINANCIAL|GENDER|$)"
    )
    if ward:
        result["ward"] = ward.strip()

    # ── Gender ─────────────────────────────────────────────────────────────
    gender = first(r"GENDER\s*[:\-]?\s*(MALE|FEMALE|OTHER)")
    if gender:
        result["gender"] = gender.lower()

    # ── Residential Status ─────────────────────────────────────────────────
    res_status = first(
        r"RESIDENTIAL\s+STATUS\s*[:\-]?\s*(RESIDENT|NON.RESIDENT|NRI|RNOR)"
    )
    if res_status:
        result["residential_status"] = res_status.upper()

    # ── Bank Details ───────────────────────────────────────────────────────
    bank_name = first(
        r"NAME\s+OF\s+BANK\s*[:\-]?\s*([A-Z][A-Z\s&.]+?)(?:\n|MICR|IFSC|ACCOUNT|$)"
    )
    if bank_name:
        result["bank_name"] = bank_name.strip()

    ifsc = first(r"IFSC\s+CODE\s*[:\-]?\s*([A-Z]{4}0[A-Z0-9]{6})")
    if ifsc:
        result["ifsc_code"] = ifsc.upper()

    account_no = first(r"ACCOUNT\s+NO\.?\s*[:\-]?\s*(\d{8,20})")
    if account_no:
        result["account_no"] = account_no

    # ── Income Heads ───────────────────────────────────────────────────────
    # Salary
    salary = first(r"TAXABLE\s+SALARY\s+(\d[\d,]+)")
    if not salary:
        salary = first(r"SALARIES\s+(\d[\d,]+)")
    if salary:
        v = to_float(salary.replace(",", ""))
        if v is not None and v > 0:
            result["income_salary"] = v

    # Business / Profession (u/s 44AD etc)
    biz = first(
        r"PROFITS\s+AND\s+GAINS\s+FROM\s+BUSINESS\s+(?:OR\s+PROFESSION\s+)?(\d[\d,]+)"
    )
    if not biz:
        biz = first(
            r"PROFIT\s+(?:DECLARED|HIGHER\s+OF\s+THE\s+ABOVE)\s+(?:U/S\s+44AD[^\d]*)(\d[\d,]+)"
        )
    if biz:
        v = to_float(biz.replace(",", ""))
        if v is not None and v > 0:
            result["income_business"] = v

    # Capital Gains
    cg = first(r"(?:TOTAL\s+)?CAPITAL\s+GAINS?\s+(\d[\d,]+)")
    if not cg:
        # Sum short-term + long-term from doc
        stcg_vals = _re.findall(
            r"SHORT\s+TERM\s+CAPITAL\s+GAIN\s+@\s*\d+%[^0-9\-]*(-?\d[\d,]*)",
            text,
            _re.IGNORECASE,
        )
        ltcg_vals = _re.findall(
            r"LONG\s+TERM\s+CAPITAL\s+GAIN\s+@\s*\d+%[^0-9\-]*(-?\d[\d,]*)",
            text,
            _re.IGNORECASE,
        )
        all_cg = stcg_vals + ltcg_vals
        if all_cg:
            total_cg = sum(to_float(v.replace(",", "")) or 0 for v in all_cg)
            if total_cg != 0:
                result["income_capital_gains"] = round(total_cg, 2)
    else:
        v = to_float(cg.replace(",", ""))
        if v is not None:
            result["income_capital_gains"] = v

    # Other Sources
    other_src = first(r"INCOME\s+FROM\s+OTHER\s+SOURCES\s+(\d[\d,]+)")
    if not other_src:
        other_src = first(r"OTHER\s+SOURCES[^\d]*(\d[\d,]+)")
    if other_src:
        v = to_float(other_src.replace(",", ""))
        if v is not None and v > 0:
            result["income_other_sources"] = v

    # ── Gross Total Income ─────────────────────────────────────────────────
    gti = first(r"GROSS\s+TOTAL\s+INCOME\s+(\d[\d,]+)")
    if gti:
        v = to_float(gti.replace(",", ""))
        if v:
            result["gross_total_income"] = v

    # ── Total Income ───────────────────────────────────────────────────────
    total_income = first(r"TOTAL\s+INCOME\s+ROUNDED\s+OFF[^\d]*(\d[\d,]+)")
    if not total_income:
        total_income = first(r"TOTAL\s+INCOME\s+(\d[\d,]+)")
    if total_income:
        v = to_float(total_income.replace(",", ""))
        if v:
            result["total_income"] = v

    # ── Tax Payable ────────────────────────────────────────────────────────
    tax_payable_raw = first(r"TAX\s+PAYABLE\s+(\d[\d,]+|NIL)")
    if tax_payable_raw and tax_payable_raw.upper() != "NIL":
        v = to_float(tax_payable_raw.replace(",", ""))
        result["tax_payable"] = v if v is not None else 0.0
    else:
        result["tax_payable"] = 0.0

    # Refund
    refund_raw = first(r"REFUND\s+(?:AMOUNT\s+)?(\d[\d,]+)")
    if refund_raw:
        v = to_float(refund_raw.replace(",", ""))
        if v and v > 0:
            result["refund_amount"] = v

    # ── Filing Status heuristic ────────────────────────────────────────────
    if result.get("acknowledgement_no") and result.get("filing_date"):
        result["filing_status"] = "filed"
    else:
        result["filing_status"] = "pending"

    # ── Section 115BAC ────────────────────────────────────────────────────
    bac_m = _re.search(
        r"(?:OPTED\s+FOR\s+TAXATION\s+U/S\s+115BAC|115BAC)[^\n]*(YES|NO)",
        text,
        _re.IGNORECASE,
    )
    if bac_m:
        result["opted_115bac"] = bac_m.group(1).upper() == "YES"

    return result


@api_router.post("/clients/parse-itr-computation-pdf")
async def parse_itr_computation_pdf(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Parse an ITR Computation of Income PDF.
    Returns extracted fields: assessee name, PAN, AY, income heads,
    tax payable, refund, bank details, address, etc.
    Used to auto-fill the ITR Client form.
    """
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content = await file.read()
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF too large — max 20 MB.")

    try:
        result = _parse_itr_computation_pdf(content)
    except Exception as e:
        logger.error(f"parse_itr_computation_pdf error: {e}", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail="Could not parse this PDF. Please ensure it is an ITR Computation of Income document.",
        )

    if not result.get("pan") and not result.get("company_name"):
        raise HTTPException(
            status_code=422,
            detail="No ITR data found. Please upload a valid ITR Computation of Income PDF.",
        )

    return result


def _map_mca_constitution(raw: str) -> str:
    """Map MCA class/constitution/category string → client_type slug."""
    r = (raw or "").lower().strip()
    if "private" in r:
        return "pvt_ltd"
    if "llp" in r or "limited liability partnership" in r:
        return "llp"
    if "public" in r:
        return "public_ltd"
    if "section 8" in r or "section8" in r or "not for profit" in r:
        return "section_8"
    if "one person" in r or "opc" in r:
        return "pvt_ltd"
    if "partnership" in r:
        return "partnership"
    if "proprietor" in r or "sole" in r:
        return "proprietor"
    if "huf" in r or "hindu undivided" in r:
        return "huf"
    if "trust" in r:
        return "trust"
    return "other"


def _clean_obfuscated_email(raw: str) -> str:
    """Decode MCA-style obfuscated emails, e.g.
    'indo[dot]jigar[at]gmail[dot]com' -> 'indo.jigar@gmail.com'."""
    v = (raw or "").strip()
    if not v:
        return ""
    v = re.sub(r"\[\s*at\s*\]", "@", v, flags=re.IGNORECASE)
    v = re.sub(r"\[\s*dot\s*\]", ".", v, flags=re.IGNORECASE)
    v = re.sub(r"\(\s*at\s*\)", "@", v, flags=re.IGNORECASE)
    v = re.sub(r"\(\s*dot\s*\)", ".", v, flags=re.IGNORECASE)
    v = re.sub(r"\s+at\s+", "@", v, flags=re.IGNORECASE)
    v = re.sub(r"\s+dot\s+", ".", v, flags=re.IGNORECASE)
    v = v.replace(" ", "")
    m = re.search(r"[\w.+\-]+@[\w.\-]+\.\w+", v)
    return m.group(0).lower() if m else ""


def _detect_entity_type_from_name(name: str) -> str:
    """Best-effort client_type guess from a company/LLP name suffix."""
    n = (name or "").lower()
    if any(
        x in n
        for x in ["private limited", "pvt ltd", "pvt. ltd", "pvt.ltd", "pvt limited"]
    ):
        return "pvt_ltd"
    if "llp" in n or "limited liability" in n:
        return "llp"
    if any(x in n for x in [" limited", " ltd"]):
        return "public_ltd"
    if "partnership" in n:
        return "partnership"
    if "huf" in n or "hindu undivided" in n:
        return "huf"
    if "trust" in n:
        return "trust"
    return ""


# ── Browser-like headers for web scraping ────────────────────────────────────
_SCRAPE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
}

from urllib.parse import quote_plus
from bs4 import BeautifulSoup

_CIN_RE = re.compile(r"^[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}$")
_LLPIN_RE = re.compile(r"^[A-Z]{2,3}-\d{4,}$")


def _slugify_company_name(name: str) -> str:
    """Convert a company name to the lowercase-hyphen slug QuickCompany.in
    uses for its /company/<slug> detail pages, e.g.
    'Maple Leaf Ventures LLP' -> 'maple-leaf-ventures-llp'."""
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (name or "").strip().lower())
    return s.strip("-")


# ── ZaubaCorp "meta description" sentence parser ─────────────────────────────
# ZaubaCorp renders a fully static, SEO-friendly paragraph on every company /
# LLP page (and in the <meta name="description"> tag) of the form:
#
#   "<NAME> (CIN: <CIN>) is a <category> company incorporated on <date>. ...
#    Directors of <NAME> are A and B. ... Its Email address is x@y.com and
#    its registered address is <ADDRESS>, <STATE>, India - <PIN> Current
#    status of <NAME> is - Active."
#
#   "<NAME> (LLPIN: <LLPIN>) is a Limited Liability Partnership firm
#    incorporated on <date>. ... Designated Partners of <NAME> are A, and B.
#    ... Its Email address is x@y.com and its registered address is
#    <ADDRESS>, <STATE>, India - <PIN> Current status of <NAME> is - Active."
#
# This text is present in the static HTML (no JS needed), which makes it a
# far more reliable extraction target than label/value grids that are
# populated client-side.
_ZB_CIN = re.compile(
    r"\(CIN:\s*([A-Z0-9]{21})\)|Corporate Identification Number\s*\(CIN\)\s*is\s*([A-Z0-9]{21})",
    re.I,
)
_ZB_LLPIN = re.compile(
    r"\(LLPIN:\s*([A-Z]{2,3}-\d{3,})\)|LLP Identification Number is\s*\(LLPIN\)\s*([A-Z]{2,3}-\d{3,})",
    re.I,
)
_ZB_INCORPORATED = re.compile(r"incorporated on\s+(\d{1,2}\s+[A-Za-z]+\s+\d{4})", re.I)
_ZB_CATEGORY = re.compile(r"is a\s+(.+?)\s+incorporated on", re.I)
_ZB_ROC = re.compile(r"Registrar of Companies,\s*([A-Za-z .]+?)\.", re.I)
_ZB_DIRECTORS = re.compile(r"Directors? of [^.]*?\bare\s+(.+?)\.", re.I)
_ZB_PARTNERS = re.compile(r"Designated Partners of [^.]*?\bare\s+(.+?)\.", re.I)
_ZB_EMAIL = re.compile(r"Email address is\s+([\w.+\-]+@[\w.\-]+\.\w+)", re.I)
_ZB_ADDRESS_PIN = re.compile(r"registered address is\s+(.+?)\s*-\s*(\d{6})", re.I)
_ZB_STATUS = re.compile(
    r"Current status of [^.]*?\bis\s*-\s*([A-Za-z][A-Za-z /]*?)\.?\s*$", re.I
)
_ZB_AUTH_CAP = re.compile(r"authorized?\s+share capital is Rs\.?\s*([\d,]+)", re.I)
_ZB_PAIDUP_CAP = re.compile(r"paid[- ]?up capital is Rs\.?\s*([\d,]+)", re.I)


def _parse_zaubacorp_summary(text: str, company_name: str = "") -> dict:
    """Parse ZaubaCorp's descriptive summary paragraph into structured fields."""
    from datetime import date as _date
    from dateutil import parser as date_parser

    text = re.sub(r"\s+", " ", text or "").strip()
    out: dict = {}

    m = _ZB_CIN.search(text)
    if m:
        out["cin"] = (m.group(1) or m.group(2) or "").upper()

    m = _ZB_LLPIN.search(text)
    if m:
        out["llpin"] = (m.group(1) or m.group(2) or "").upper()

    m = _ZB_INCORPORATED.search(text)
    if m:
        try:
            out["date_of_incorporation"] = date_parser.parse(
                m.group(1), dayfirst=True
            ).strftime("%Y-%m-%d")
        except Exception:
            out["date_of_incorporation"] = m.group(1)

    category = ""
    m = _ZB_CATEGORY.search(text)
    if m:
        category = m.group(1).strip()
    elif "limited liability partnership" in text.lower():
        category = "Limited Liability Partnership"

    client_type = _map_mca_constitution(category or company_name)
    if client_type == "other" and out.get("llpin"):
        client_type = "llp"
    out["client_type"] = client_type
    out["company_category"] = category

    m = _ZB_ROC.search(text)
    if m:
        out["roc"] = m.group(1).strip()

    directors_raw = ""
    m = _ZB_PARTNERS.search(text) or _ZB_DIRECTORS.search(text)
    if m:
        directors_raw = m.group(1)
    directors = []
    if directors_raw:
        # "A, B and C" / "A and B" / "A, and B"
        directors_raw = re.sub(r"\s+and\s+", ", ", directors_raw, flags=re.I)
        for part in directors_raw.split(","):
            nm = part.strip(" .")
            if nm and len(nm) > 1:
                directors.append(
                    {
                        "name": nm.title(),
                        "designation": "Director"
                        if "llpin" not in out
                        else "Designated Partner",
                        "din": "",
                    }
                )
    out["directors"] = directors

    m = _ZB_EMAIL.search(text)
    if m:
        out["email"] = m.group(1)

    address = city = state = pin = ""
    m = _ZB_ADDRESS_PIN.search(text)
    if m:
        address_full = m.group(1).strip()
        pin = m.group(2)
        parts = [p.strip() for p in address_full.split(",") if p.strip()]
        if parts and parts[-1].strip().lower() in ("india", "in"):
            parts.pop()
        if parts:
            state = parts.pop().strip()
        if parts:
            words = parts[-1].split()
            if words:
                city = words[-1].strip(" .,")
        address = address_full

    out["address"] = address
    out["city"] = city
    out["state"] = state
    out["gst_pin"] = pin

    m = _ZB_STATUS.search(text)
    if m:
        out["company_status"] = m.group(1).strip().rstrip(".")

    m = _ZB_AUTH_CAP.search(text)
    if m:
        out["authorized_capital"] = m.group(1)

    m = _ZB_PAIDUP_CAP.search(text)
    if m:
        out["paid_up_capital"] = m.group(1)

    out["mca_fetch_date"] = _date.today().isoformat()
    out["source"] = "zaubacorp.com"
    return out


async def _scrape_quickcompany(query: str) -> dict:
    """Scrape company details from quickcompany.in. Returns {} on failure.

    QuickCompany serves company-detail pages at the static, predictable URL
    /company/<slug-of-company-name> (e.g. /company/maple-leaf-ventures-llp).
    The company name, director names and director profile links are present
    in the server-rendered HTML; most other fields (CIN, address, financials)
    are populated client-side and are therefore best-effort only here.
    """
    from datetime import date as _date

    q = query.strip()
    is_cin = bool(_CIN_RE.match(q.upper()))
    is_llpin = bool(_LLPIN_RE.match(q.upper()))

    urls_to_try: list[str] = []
    if not is_cin and not is_llpin:
        urls_to_try.append(
            f"https://www.quickcompany.in/company/{_slugify_company_name(q)}"
        )
    # Generic search fallback (best-effort; QuickCompany's /company search is
    # primarily client-rendered so this mostly helps when it does return a
    # server-rendered list of matches)
    urls_to_try.append(f"https://www.quickcompany.in/company?q={q}")

    async with httpx.AsyncClient(
        timeout=15.0, follow_redirects=True, headers=_SCRAPE_HEADERS
    ) as client:
        for url in urls_to_try:
            try:
                resp = await client.get(url)
                if resp.status_code != 200:
                    continue
                soup = BeautifulSoup(resp.text, "html.parser")
                page_text = soup.get_text(" ", strip=True)

                company_name = ""
                h1 = soup.find("h1")
                if h1:
                    company_name = h1.get_text(strip=True)

                detail_soup = soup
                detail_url = url

                # If this looks like a search results page (no clean h1, or
                # h1 doesn't resemble the query), try to follow the first
                # /company/<slug> link to a real detail page.
                if not company_name or "search" in page_text.lower()[:200]:
                    link = soup.find("a", href=re.compile(r"^/company/[a-z0-9\-]+$"))
                    if link:
                        href = link.get("href", "")
                        try:
                            dr = await client.get(f"https://www.quickcompany.in{href}")
                            if dr.status_code == 200:
                                detail_soup = BeautifulSoup(dr.text, "html.parser")
                                detail_url = f"https://www.quickcompany.in{href}"
                                dh1 = detail_soup.find("h1")
                                if dh1:
                                    company_name = dh1.get_text(strip=True)
                                page_text = detail_soup.get_text(" ", strip=True)
                        except Exception:
                            pass

                if not company_name:
                    continue

                # CIN / LLPIN — may appear in JSON-LD / meta tags even if the
                # visible "Company Information" grid is populated client-side.
                found_cin = ""
                cin_m = re.search(
                    r"\b([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b", page_text
                )
                if cin_m:
                    found_cin = cin_m.group(1)
                found_llpin = ""
                llpin_m = re.search(r"\b([A-Z]{2,3}-\d{4,})\b", page_text)
                if llpin_m and not found_cin:
                    found_llpin = llpin_m.group(1)

                # Directors — rendered server-side as links to /directors/<din>-<slug>
                directors = []
                for a in detail_soup.find_all("a", href=re.compile(r"^/directors/\d")):
                    dname = a.get_text(strip=True)
                    if not dname:
                        continue
                    dhref = a.get("href", "")
                    din_m = re.match(r"^/directors/(\d+)", dhref)
                    directors.append(
                        {
                            "name": dname,
                            "designation": "Designated Partner"
                            if "llp" in (company_name or "").lower() or found_llpin
                            else "Director",
                            "din": din_m.group(1) if din_m else "",
                        }
                    )

                client_type = _map_mca_constitution(company_name)

                return {
                    "company_name": company_name,
                    "cin": found_cin,
                    "llpin": found_llpin or None,
                    "client_type": client_type,
                    "date_of_incorporation": "",
                    "email": "",
                    "address": "",
                    "city": "",
                    "state": "",
                    "gst_pin": "",
                    "pan": "",
                    "directors": directors,
                    "company_status": "",
                    "authorized_capital": "",
                    "paid_up_capital": "",
                    "mca_fetch_date": _date.today().isoformat(),
                    "source": "quickcompany.in",
                    "detail_url": detail_url,
                }
            except Exception as exc:
                logger.debug(f"quickcompany scrape error for {url}: {exc}")
                continue
    return {}


# ── ZaubaCorp search-result table parsing ────────────────────────────────────
# ZaubaCorp's /companysearchresults/company endpoint returns a fully static
# HTML table:
#
#   ### Companies named <term>
#   | CIN / LLPIN                                  | Name                        | Address |
#   |-----------------------------------------------|-----------------------------|---------|
#   | [<CIN>](https://www.zaubacorp.com/<slug>-<CIN>) | [<NAME>](.../<slug>-<CIN>) | ...     |
#
# We try a handful of query-param spellings (the exact one accepted by the
# backend can vary by deployment / caching layer) and, for each response,
# only trust it if the rendered heading actually reflects our search term —
# otherwise it's the generic/default listing and we move on to the next
# candidate.
_ZB_SEARCH_PARAM_CANDIDATES = ["company", "q", "value", "search", "term", "p", "name"]


def _zaubacorp_pick_row(soup: "BeautifulSoup", q: str, is_cin: bool, is_llpin: bool):
    """Return (cin_or_llpin, detail_url, name) for the best-matching row in a
    ZaubaCorp search-results table, or None if nothing usable is found."""
    q_upper = q.strip().upper()
    q_words = [w for w in re.findall(r"[A-Za-z0-9]+", q.lower()) if len(w) > 1]

    best = None
    best_score = -1
    for row in soup.find_all("tr"):
        cells = row.find_all(["td", "th"])
        if len(cells) < 2:
            continue
        id_cell, name_cell = cells[0], cells[1]
        id_text = id_cell.get_text(strip=True).upper()

        name_link = name_cell.find("a", href=True)
        if not name_link:
            continue
        name_text = name_link.get_text(strip=True)
        href = name_link.get("href", "")
        if not href.startswith("http"):
            href = f"https://www.zaubacorp.com{href}"

        if is_cin or is_llpin:
            if id_text == q_upper:
                return id_text, href, name_text
            continue

        # Name-based search: score by how many query words appear in the
        # candidate company name.
        name_lower = name_text.lower()
        score = sum(1 for w in q_words if w in name_lower)
        if score and score > best_score:
            best_score = score
            best = (id_text, href, name_text)

    if best and best_score >= max(1, len(q_words) - 1):
        return best
    return None


def _parse_zaubacorp_directors_table(soup: "BeautifulSoup") -> list:
    """Parse the 'Current Directors & Key Managerial Personnel' table on a
    ZaubaCorp company/LLP detail page.

    The table is fully server-rendered with columns:
        DIN | Director Name | Designation | Appointment Date
    (the DIN and Director Name cells contain links). We only use the
    *current* directors table (skip any 'Past Directors' table, which has an
    extra 'Cessation' column).

    Returns a list of {"name", "designation", "din", "appointment_date"} dicts.
    """
    directors: list = []

    for table in soup.find_all("table"):
        header_row = table.find("tr")
        if not header_row:
            continue
        headers = [
            c.get_text(strip=True).lower() for c in header_row.find_all(["th", "td"])
        ]
        if not headers or "din" not in headers[0]:
            continue
        if "director name" not in " ".join(headers):
            continue
        # Skip past-directors tables (they include a "Cessation" column)
        if any("cessation" in h for h in headers):
            continue

        din_idx = next((i for i, h in enumerate(headers) if "din" in h), 0)
        name_idx = next(
            (i for i, h in enumerate(headers) if "director name" in h or "name" in h), 1
        )
        desig_idx = next((i for i, h in enumerate(headers) if "designation" in h), None)
        appt_idx = next((i for i, h in enumerate(headers) if "appointment" in h), None)

        for row in table.find_all("tr")[1:]:
            cells = row.find_all(["td", "th"])
            if len(cells) <= max(din_idx, name_idx):
                continue
            din = cells[din_idx].get_text(strip=True)
            name = cells[name_idx].get_text(strip=True)
            if not name or not re.match(r"^\d{6,8}$", din):
                continue
            designation = (
                cells[desig_idx].get_text(strip=True)
                if desig_idx is not None and len(cells) > desig_idx
                else "Director"
            )
            appt_date_raw = (
                cells[appt_idx].get_text(strip=True)
                if appt_idx is not None and len(cells) > appt_idx
                else ""
            )
            appt_date = ""
            if appt_date_raw:
                try:
                    from dateutil import parser as date_parser

                    appt_date = date_parser.parse(
                        appt_date_raw, dayfirst=True
                    ).strftime("%Y-%m-%d")
                except Exception:
                    appt_date = appt_date_raw

            directors.append(
                {
                    "name": name.title(),
                    "designation": designation or "Director",
                    "din": din,
                    "appointment_date": appt_date,
                }
            )

        if directors:
            break

    return directors


async def _scrape_zaubacorp(query: str) -> dict:
    """Scrape company details from zaubacorp.com. Returns {} on failure.

    ZaubaCorp pages are fully server-rendered (no JS required), and every
    company/LLP page carries a structured summary sentence describing the
    CIN/LLPIN, incorporation date, directors/partners, email, registered
    address and current status — see _parse_zaubacorp_summary().
    """
    q = query.strip()
    q_upper = q.upper()
    is_cin = bool(_CIN_RE.match(q_upper))
    is_llpin = bool(_LLPIN_RE.match(q_upper))

    hdrs = {**_SCRAPE_HEADERS, "Referer": "https://www.zaubacorp.com/"}
    detail_url = ""
    matched_name = ""

    async with httpx.AsyncClient(
        timeout=15.0, follow_redirects=True, headers=hdrs
    ) as client:
        # ── 1. Resolve a detail-page URL via the search-results table ───────
        for param in _ZB_SEARCH_PARAM_CANDIDATES:
            search_url = f"https://www.zaubacorp.com/companysearchresults/company?{param}={quote_plus(q)}"
            try:
                resp = await client.get(search_url)
                if resp.status_code != 200:
                    continue
                soup = BeautifulSoup(resp.text, "html.parser")

                heading = soup.find(["h1", "h2", "h3"])
                heading_text = (
                    heading.get_text(" ", strip=True).lower() if heading else ""
                )
                # Skip the generic/default listing (heading doesn't mention
                # any part of our query)
                q_words = [
                    w for w in re.findall(r"[A-Za-z0-9]+", q.lower()) if len(w) > 1
                ]
                if (
                    q_words
                    and not any(w in heading_text for w in q_words)
                    and not (is_cin or is_llpin)
                ):
                    continue

                picked = _zaubacorp_pick_row(soup, q, is_cin, is_llpin)
                if picked:
                    _, detail_url, matched_name = picked
                    break
            except Exception as exc:
                logger.debug(f"zaubacorp search error ({param}) for {q!r}: {exc}")
                continue

        if not detail_url:
            return {}

        # ── 2. Fetch the detail page and parse the summary sentence ─────────
        try:
            dr = await client.get(detail_url)
            if dr.status_code != 200:
                return {}
            ds = BeautifulSoup(dr.text, "html.parser")

            company_name = matched_name
            dh1 = ds.find("h1")
            if dh1:
                h1_text = dh1.get_text(strip=True)
                if h1_text:
                    company_name = h1_text

            meta_desc = ds.find("meta", attrs={"name": "description"})
            summary_text = meta_desc.get("content", "") if meta_desc else ""
            if not summary_text or len(summary_text) < 40:
                summary_text = ds.get_text(" ", strip=True)

            parsed = _parse_zaubacorp_summary(summary_text, company_name)
            parsed["company_name"] = company_name
            parsed["detail_url"] = detail_url

            table_directors = _parse_zaubacorp_directors_table(ds)
            if table_directors:
                parsed["directors"] = table_directors

            return parsed
        except Exception as exc:
            logger.debug(f"zaubacorp detail fetch error for {detail_url}: {exc}")
            return {}


@api_router.get("/clients/fetch-mca-details")
async def fetch_mca_details(
    query: str = "", cin: str = "", current_user: User = Depends(get_current_user)
):
    """
    Fetch company details by company name OR CIN/LLPIN.
    Priority: quickcompany.in → zaubacorp.com → data.gov.in (fallback, needs MCA_API_KEY).
    """
    q = (query or cin or "").strip()
    if not q or len(q) < 3:
        raise HTTPException(
            status_code=400,
            detail="Please enter a company name or CIN (minimum 3 characters).",
        )

    q_upper = q.upper()
    is_cin = bool(_CIN_RE.match(q_upper))
    is_llpin = bool(_LLPIN_RE.match(q_upper))

    # ── 1. quickcompany.in ───────────────────────────────────────────────────
    try:
        result = await _scrape_quickcompany(q)
        if result and (result.get("company_name") or result.get("cin")):
            return result
    except Exception as exc:
        logger.warning(f"quickcompany scrape failed: {exc}")

    # ── 2. zaubacorp.com ─────────────────────────────────────────────────────
    try:
        result = await _scrape_zaubacorp(q)
        if result and (result.get("company_name") or result.get("cin")):
            return result
    except Exception as exc:
        logger.warning(f"zaubacorp scrape failed: {exc}")

    # ── 3. data.gov.in API (requires MCA_API_KEY, CIN/LLPIN only) ────────────
    if (is_cin or is_llpin) and MCA_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=20.0) as http:
                resp = await http.get(
                    "https://api.data.gov.in/resource/ec58dab7-d891-4abb-936e-d5d274a6ce9b",
                    params={
                        "api-key": MCA_API_KEY,
                        "format": "json",
                        "limit": "1",
                        "filters[CIN]": q_upper,
                    },
                )
                resp.raise_for_status()
                records = resp.json().get("records", [])
                if records:
                    from datetime import date as _date

                    r = records[0]
                    doi = ""
                    raw_doi = (
                        r.get("DATE_OF_REGISTRATION")
                        or r.get("date_of_registration")
                        or ""
                    )
                    if raw_doi:
                        try:
                            from dateutil import parser as dp

                            doi = dp.parse(str(raw_doi), dayfirst=True).strftime(
                                "%Y-%m-%d"
                            )
                        except Exception:
                            doi = str(raw_doi)
                    raw_class = r.get("COMPANY_CLASS") or r.get("company_class") or ""
                    return {
                        "company_name": r.get("COMPANY_NAME")
                        or r.get("company_name")
                        or "",
                        "cin": q_upper,
                        "llpin": None,
                        "client_type": _map_mca_constitution(raw_class),
                        "date_of_incorporation": doi,
                        "email": "",
                        "address": r.get("REGISTERED_OFFICE_ADDRESS")
                        or r.get("registered_office_address")
                        or "",
                        "city": "",
                        "state": r.get("REGISTERED_STATE")
                        or r.get("registered_state")
                        or "",
                        "gst_pin": "",
                        "pan": "",
                        "directors": [],
                        "company_status": r.get("COMPANY_STATUS")
                        or r.get("company_status")
                        or "",
                        "authorized_capital": r.get("AUTHORISED_CAPITAL_IN_INR") or "",
                        "paid_up_capital": r.get("PAIDUP_CAPITAL_IN_INR") or "",
                        "mca_fetch_date": _date.today().isoformat(),
                        "source": "data.gov.in",
                    }
        except Exception as exc:
            logger.warning(f"data.gov.in fallback failed: {exc}")

    raise HTTPException(
        status_code=404,
        detail=f"No company found for '{q}'. Try a more specific name or the exact CIN/LLPIN.",
    )


def _parse_mca_pdf(pdf_bytes: bytes) -> dict:
    """
    Parse an MCA Company Master Data PDF (printed from mca.gov.in).
    Handles the 'Company Master Data' format where:
      - Address appears on the line BEFORE the 'Registered Address' label
      - Director DIN and name may be on separate lines
    """
    from io import BytesIO
    import pdfplumber
    from dateutil import parser as date_parser

    with pdfplumber.open(BytesIO(pdf_bytes)) as pdf:
        pages = [p.extract_text() or "" for p in pdf.pages]

    full_text = "\n".join(pages)
    lines = [l.rstrip() for l in full_text.splitlines()]

    def _find(pat, text, group=1, flags=re.IGNORECASE | re.MULTILINE | re.DOTALL):
        m = re.search(pat, text, flags)
        return m.group(group).strip() if m else ""

    def _line_val(label, default=""):
        """Extract value that follows label on the same line (tab or multi-space separated)."""
        # Try wide-spaced: "Label              VALUE"
        pat = re.compile(r"^\s*" + re.escape(label) + r"\s{2,}(.+)$", re.IGNORECASE)
        for line in lines:
            m = pat.match(line)
            if m:
                val = m.group(1).strip()
                if val and val not in ("-", "nan", ""):
                    return val
        # Fallback: single-space separated
        pat2 = re.compile(r"^\s*" + re.escape(label) + r"\s+(.+)$", re.IGNORECASE)
        for line in lines:
            m = pat2.match(line)
            if m:
                val = m.group(1).strip()
                if val and val not in ("-", "nan", ""):
                    return val
        return default

    # ── CIN / LLPIN ──────────────────────────────────────────────────────────
    cin = _find(r"\bCIN\s+([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6})\b", full_text)
    llpin = _find(r"\bLLPIN\s+([A-Z]{3}-\d{4,})\b", full_text)
    if not cin and not llpin:
        cin = _find(r"\bCIN\b\s+([A-Z0-9]{21})\b", full_text)

    # ── Company / LLP Name ────────────────────────────────────────────────────
    company_name = _line_val("Company Name")
    if not company_name:
        company_name = _line_val("LLP Name")
    if not company_name:
        m = re.search(
            r"^Company Name\s*\n\s*([A-Z][A-Z0-9 &.\-]+)",
            full_text,
            re.IGNORECASE | re.MULTILINE,
        )
        if m:
            company_name = m.group(1).strip()

    # ── Company Category / Class (used to derive client_type) ─────────────────
    company_category = (
        _line_val("Company Category")
        or _line_val("Class of Company")
        or _line_val("Company SubCategory")
        or _line_val("Type of Company")
        or ""
    )
    client_type = _map_mca_constitution(company_category)
    if client_type == "other":
        client_type = _map_mca_constitution(company_category + " " + company_name)
    if client_type == "other" and llpin:
        client_type = "llp"
    if client_type == "other":
        client_type = _detect_entity_type_from_name(company_name)
    if not client_type:
        client_type = "other"

    # ── Date of Incorporation ─────────────────────────────────────────────────
    doi_raw = _line_val("Date of Incorporation")
    date_of_incorporation = ""
    if doi_raw:
        try:
            date_of_incorporation = date_parser.parse(doi_raw, dayfirst=True).strftime(
                "%Y-%m-%d"
            )
        except Exception:
            date_of_incorporation = ""

    # ── Email (MCA may obfuscate with [at] / [dot]) ───────────────────────────
    email_raw = _line_val("Email Id") or _line_val("Email")
    email = _clean_obfuscated_email(email_raw)
    if not email:
        em = re.search(r"[\w.+\-]+@[\w.\-]+\.\w+", full_text)
        email = em.group(0).lower() if em else ""

    # ── Registered Address ───────────────────────────────────────────────────
    # MCA website format: address text may wrap and the label can appear BETWEEN
    # the two address lines, e.g.
    #   1088 A, RAJMAHAL MALL DINDOLI, KHARWASA ROAD, Surat, SURAT,
    #   Registered Address
    #   Gujarat, India, 394210
    address = city = state = pin = ""
    SKIP_RE = re.compile(
        r"^(Address at which|Listed|Authorised|Auth\.?|Paid|Date of|Company Status|"
        r"Small Company|Category|Subcategory|Class of|Type of|ACTIVE|Director|Sr\.|DIN|"
        r"Index of|Jurisdiction|ROC|RD\b|Email|CIN|LLPIN|Registration Number|"
        r"Company Name|LLP Name)",
        re.IGNORECASE,
    )
    for i, line in enumerate(lines):
        if re.match(r"^\s*Registered\s+(Office\s+)?Address\s*$", line, re.IGNORECASE):
            part1 = lines[i - 1].strip() if i > 0 else ""
            part2 = lines[i + 1].strip() if i + 1 < len(lines) else ""
            if SKIP_RE.match(part1):
                part1 = ""
            if SKIP_RE.match(part2):
                part2 = ""
            address = (
                (part1.rstrip(",") + ", " + part2).strip(", ")
                if (part1 and part2)
                else (part1 or part2)
            )
            break
        m = re.match(
            r"^\s*Registered\s+(?:Office\s+)?Address\s{2,}(.+)$", line, re.IGNORECASE
        )
        if m:
            address = m.group(1).strip()
            # may continue on next line until label
            if (
                i + 1 < len(lines)
                and lines[i + 1].strip()
                and not SKIP_RE.match(lines[i + 1].strip())
            ):
                address = (address.rstrip(",") + ", " + lines[i + 1].strip()).strip(
                    ", "
                )
            break

    if not address:
        m = re.search(
            r"Registered(?:\s+Office)?\s+Address\s*\n([^\n]+)", full_text, re.IGNORECASE
        )
        if m:
            address = m.group(1).strip()

    # Collapse double commas / stray whitespace
    if address:
        address = re.sub(r"\s*,\s*,+\s*", ", ", address)
        address = re.sub(r"\s+", " ", address).strip(" ,")

    INDIAN_STATES = [
        "Andhra Pradesh",
        "Arunachal Pradesh",
        "Assam",
        "Bihar",
        "Chhattisgarh",
        "Goa",
        "Gujarat",
        "Haryana",
        "Himachal Pradesh",
        "Jharkhand",
        "Karnataka",
        "Kerala",
        "Madhya Pradesh",
        "Maharashtra",
        "Manipur",
        "Meghalaya",
        "Mizoram",
        "Nagaland",
        "Odisha",
        "Orissa",
        "Punjab",
        "Rajasthan",
        "Sikkim",
        "Tamil Nadu",
        "Telangana",
        "Tripura",
        "Uttar Pradesh",
        "Uttarakhand",
        "West Bengal",
        "Andaman and Nicobar Islands",
        "Chandigarh",
        "Dadra and Nagar Haveli and Daman and Diu",
        "Daman and Diu",
        "Delhi",
        "Jammu and Kashmir",
        "Ladakh",
        "Lakshadweep",
        "Puducherry",
        "Pondicherry",
    ]
    STATE_CODES = {
        "GJ": "Gujarat",
        "MH": "Maharashtra",
        "DL": "Delhi",
        "KA": "Karnataka",
        "TN": "Tamil Nadu",
        "UP": "Uttar Pradesh",
        "RJ": "Rajasthan",
        "WB": "West Bengal",
        "AP": "Andhra Pradesh",
        "TS": "Telangana",
        "HR": "Haryana",
        "PB": "Punjab",
        "MP": "Madhya Pradesh",
        "OR": "Odisha",
        "BR": "Bihar",
        "KL": "Kerala",
        "UK": "Uttarakhand",
        "JH": "Jharkhand",
        "HP": "Himachal Pradesh",
        "GA": "Goa",
        "AS": "Assam",
        "CG": "Chhattisgarh",
        "JK": "Jammu and Kashmir",
    }
    GENERIC_LOC = {"india", "bharat", "in"}

    if address:
        # PIN
        pin_m = re.search(r"\b(\d{6})\b", address)
        pin = pin_m.group(1) if pin_m else ""

        # State: prefer full name match, fall back to 2-letter code before PIN
        addr_lower = address.lower()
        for s in sorted(INDIAN_STATES, key=len, reverse=True):
            if re.search(
                r"(^|[,\s])" + re.escape(s.lower()) + r"($|[,\s])", addr_lower
            ):
                state = s
                break
        if not state:
            sc_m = re.search(r"\b([A-Z]{2})\s+\d{6}\b", address)
            if sc_m and sc_m.group(1) in STATE_CODES:
                state = STATE_CODES[sc_m.group(1)]

        # City: strip PIN, country, state, and trailing state-code; take last token
        addr_clean = re.sub(r",?\s*\d{6}\s*$", "", address).strip(" ,")
        addr_clean = re.sub(
            r",?\s*(India|Bharat|IN)\s*$", "", addr_clean, flags=re.IGNORECASE
        ).strip(" ,")
        if state:
            addr_clean = re.sub(
                r",?\s*" + re.escape(state) + r"\s*$",
                "",
                addr_clean,
                flags=re.IGNORECASE,
            ).strip(" ,")
        # Strip trailing 2-letter state code ONLY if it's a known code,
        # otherwise we mangle words like 'SURAT' -> 'SUR'.
        m_sc = re.search(r",\s*([A-Z]{2})\s*$", addr_clean)
        if m_sc and m_sc.group(1) in STATE_CODES:
            addr_clean = addr_clean[: m_sc.start()].strip(" ,")
        parts = [x.strip() for x in addr_clean.split(",") if x.strip()]
        # Drop trailing generic tokens
        while parts and parts[-1].lower() in GENERIC_LOC:
            parts.pop()
        # Drop trailing token if it equals the state
        while parts and state and parts[-1].lower() == state.lower():
            parts.pop()
        if parts and not city:
            # Pick last non-numeric token >= 2 chars
            for tok in reversed(parts):
                t = tok.strip().strip(".")
                if len(t) >= 2 and not re.fullmatch(r"\d+", t):
                    city = t.title()
                    break

    # ── Company Status ────────────────────────────────────────────────────────
    company_status = _line_val("Company Status(for efiling)") or _line_val(
        "Company Status"
    )

    # ── Directors ─────────────────────────────────────────────────────────────
    directors = []
    dir_start = None
    for i, line in enumerate(lines):
        if re.search(r"Director[s/]*Signatory Details", line, re.IGNORECASE):
            dir_start = i + 1
            break

    if dir_start is not None:
        dir_lines = lines[dir_start:]
        # Row may be one of:
        #   <Sr.No>? <DIN/PAN> <NAME?> <Designation> <Category?> <Date> ...
        # The director name may also wrap onto the line above and/or below.
        # Match: optional leading Sr.No, DIN/PAN, anything (incl. partial name),
        # then a designation keyword, then a date.
        row_re = re.compile(
            r"^\s*(?:\d{1,3}\s+)?"  # optional Sr.No
            r"(\d{8}|[A-Z]{5}\d{4}[A-Z])\s+"  # DIN (8 digits) or PAN
            r"(.*?)"  # middle (may include name fragment + category)
            r"\b(Director|Designated Partner|Partner|Manager|Whole[- ]?Time Director|"
            r"Managing Director|Additional Director|Nominee Director|Independent Director|"
            r"Secretary|Chief[A-Za-z ]*|Chairman)\b"
            r"[A-Za-z ]*?\s+"  # optional category words
            r"(\d{2}/\d{2}/\d{4})",  # appointment date
            re.IGNORECASE,
        )
        noise_re = re.compile(
            r"^(Sr\.|Sr|No|DIN|PAN|Name|Designation|Category|Date|Signatory|"
            r"Cessation|Appointment|of|-)$",
            re.IGNORECASE,
        )

        def _clean_name_part(s):
            s = (s or "").strip()
            # Remove a known designation/category word if it leaks in
            s = re.sub(
                r"\b(Director|Partner|Promoter|Independent|Nominee|Additional|"
                r"Managing|Whole[- ]?Time|Designated|Secretary|Manager|Chairman|"
                r"Chief[A-Za-z ]*|Professional|Shareholder)\b",
                "",
                s,
                flags=re.IGNORECASE,
            )
            s = re.sub(r"\d", "", s)  # strip digits / dates leftovers
            s = re.sub(r"[\.\-/]+", " ", s)
            s = re.sub(r"\s+", " ", s).strip()
            # Keep only letters and spaces
            s = re.sub(r"[^A-Za-z ]", "", s).strip()
            return s

        for j, line in enumerate(dir_lines):
            m = row_re.search(line)
            if not m:
                continue
            din = m.group(1).strip()
            middle = _clean_name_part(m.group(2))
            desig = m.group(3).strip().title()
            # Collect name fragments from line above / below (single-token wrap is common)
            nb = dir_lines[j - 1].strip() if j > 0 else ""
            na = dir_lines[j + 1].strip() if j + 1 < len(dir_lines) else ""
            if noise_re.match(nb) or row_re.search(nb):
                nb = ""
            if noise_re.match(na) or row_re.search(na):
                na = ""
            nb_clean = (
                _clean_name_part(nb) if nb and re.match(r"^[A-Za-z .\-]+$", nb) else ""
            )
            na_clean = (
                _clean_name_part(na) if na and re.match(r"^[A-Za-z .\-]+$", na) else ""
            )
            full_name = " ".join(x for x in [nb_clean, middle, na_clean] if x).strip()
            full_name = re.sub(r"\s+", " ", full_name).title() or "Unknown"
            # Skip duplicates by DIN
            if din and any(d.get("din") == din for d in directors):
                continue
            directors.append(
                {
                    "name": full_name,
                    "designation": desig,
                    "email": None,
                    "phone": None,
                    "birthday": None,
                    "din": din if din not in ("-", "") else None,
                }
            )
        # Fallback: DIN followed by Name on same line (no leading Sr.No)
        if not directors:
            din_re = re.compile(
                r"(\d{8})\s+([A-Z][A-Z .\-]+?)\s+(\d{2}/\d{2}/\d{4})", re.IGNORECASE
            )
            for line in dir_lines:
                m = din_re.search(line)
                if m:
                    directors.append(
                        {
                            "name": m.group(2).strip().title(),
                            "designation": "Director",
                            "email": None,
                            "phone": None,
                            "birthday": None,
                            "din": m.group(1).strip(),
                        }
                    )

    return {
        "company_name": company_name,
        "cin": cin or llpin,
        "llpin": llpin,
        "client_type": client_type,
        "company_category": company_category,
        "email": email,
        "phone": "",
        "date_of_incorporation": date_of_incorporation,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
        "company_status": company_status,
        "directors": directors,
        "pan": "",
        "raw": {},
    }


@api_router.post("/clients/parse-multi-documents")
async def parse_multi_documents(
    files: list[UploadFile] = File(...), current_user: User = Depends(get_current_user)
):
    """
    Accept 1-3 documents: GST Registration Certificate (PDF),
    Udyam/MSME Certificate (PDF), or MCA Company Master Data (PDF or Excel).
    Auto-detects document type for each file, parses, and merges into one
    client record.  Field priority: GST > Udyam > MCA.
    """
    gst_data: dict = {}
    udyam_data: dict = {}
    mca_data: dict = {}
    doc_types_found: list = []

    for file in files:
        raw_content = await file.read()
        fname = (file.filename or "").lower()
        ext = fname.rsplit(".", 1)[-1] if "." in fname else ""

        if ext == "pdf":
            try:
                import pdfplumber

                with pdfplumber.open(BytesIO(raw_content)) as pdf:
                    fp_text = (pdf.pages[0].extract_text() or "") if pdf.pages else ""
                    sp_text = (
                        (pdf.pages[1].extract_text() or "")
                        if len(pdf.pages) > 1
                        else ""
                    )
            except Exception:
                fp_text = sp_text = ""

            combined = (fp_text + "\n" + sp_text).lower()

            # ── Document type detection ─────────────────────────────────────
            # Udyam: unambiguous — UDYAM-XX-YY-NNNNN pattern
            is_udyam = bool(re.search(r"UDYAM-[A-Z]{2}-\d{2}-\d+", fp_text + sp_text))

            # GST REG-06: form title + 15-char GSTIN (2 digits + 5 alpha + 4 digits + 1 alpha + 1 digit + Z + 1 alphanum)
            is_gst = bool(
                re.search(
                    r"\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[Z][A-Z0-9]\b",
                    fp_text + sp_text,
                    re.IGNORECASE,
                )
            ) or ("form gst" in combined or "gst reg-06" in combined)

            # MCA: Company Master Data / Ministry of Corporate Affairs PDFs
            is_mca = (
                "company master data" in combined
                or "ministry of corporate affairs" in combined
                or "mca services" in combined
                or (
                    bool(re.search(r"\bCIN\s+[UL]\d{5}", fp_text, re.IGNORECASE))
                    and any(
                        k in combined
                        for k in [
                            "company name",
                            "llp name",
                            "registered address",
                            "date of incorporation",
                            "company status",
                        ]
                    )
                )
            )

            # Resolve: Udyam > GST > MCA (most-specific first)
            if is_udyam and not udyam_data:
                try:
                    udyam_data = _parse_udyam_pdf(raw_content)
                    doc_types_found.append("Udyam Certificate")
                except Exception as e:
                    logger.warning(f"Udyam parse failed: {e}")
            elif is_gst and not gst_data:
                try:
                    gst_data = _parse_gst_reg06_pdf(raw_content)
                    doc_types_found.append("GST Certificate")
                except Exception as e:
                    logger.warning(f"GST parse failed: {e}")
            elif is_mca and not mca_data:
                try:
                    mca_data = _parse_mca_pdf(raw_content)
                    doc_types_found.append("MCA Master Data")
                except Exception as e:
                    logger.warning(f"MCA PDF parse failed: {e}")

        elif ext in ("xlsx", "xls") and not mca_data:
            try:
                excel = pd.ExcelFile(BytesIO(raw_content))
                company_info: dict = {}
                directors: list = []

                for sheet_name in excel.sheet_names:
                    df = pd.read_excel(
                        excel, sheet_name=sheet_name, header=None
                    ).fillna("")
                    sheet_lower = sheet_name.lower().strip()
                    if any(
                        k in sheet_lower for k in ["master", "company", "masterdata"]
                    ):
                        for _, row in df.iterrows():
                            key = str(row.iloc[0]).strip()
                            val = str(row.iloc[1]).strip() if len(row) > 1 else ""
                            if (
                                key
                                and key not in ("", "nan")
                                and val not in ("", "nan")
                            ):
                                company_info[key] = val
                    elif any(
                        k in sheet_lower for k in ["director", "signatory", "partner"]
                    ):
                        rows_list = df.values.tolist()
                        header_row_idx = None
                        for idx2, row in enumerate(rows_list):
                            row_strs = [str(c).strip() for c in row]
                            if any(h in row_strs for h in ["Name", "DIN/PAN", "DIN"]):
                                header_row_idx = idx2
                                break
                        if header_row_idx is not None:
                            headers = [
                                str(h).strip() for h in rows_list[header_row_idx]
                            ]
                            for row in rows_list[header_row_idx + 1 :]:
                                row_dict = {
                                    headers[i2]: str(row[i2]).strip()
                                    if i2 < len(row)
                                    else ""
                                    for i2 in range(len(headers))
                                }
                                name = row_dict.get("Name", "").strip()
                                if name and name != "nan":
                                    din = row_dict.get("DIN/PAN", "") or row_dict.get(
                                        "DIN", ""
                                    )
                                    directors.append(
                                        {
                                            "name": name,
                                            "designation": row_dict.get(
                                                "Designation", "Director"
                                            )
                                            or "Director",
                                            "email": None,
                                            "phone": None,
                                            "birthday": None,
                                            "din": din
                                            if din not in ("nan", "-", "")
                                            else None,
                                        }
                                    )

                raw_addr = (
                    company_info.get("Registered Address")
                    or company_info.get("Registered Office Address")
                    or company_info.get("Address")
                    or ""
                ).strip()
                if raw_addr in ("-", "nan"):
                    raw_addr = ""

                mca_city = mca_state = ""
                if raw_addr:
                    addr_parts = [p.strip() for p in raw_addr.split(",") if p.strip()]
                    if len(addr_parts) >= 3:
                        mca_state = addr_parts[-3]
                        mca_city = addr_parts[-4] if len(addr_parts) >= 4 else ""

                raw_doi = (
                    company_info.get("Date of Incorporation")
                    or company_info.get("Incorporation Date")
                    or ""
                )
                mca_doi = ""
                if raw_doi:
                    try:
                        from dateutil import parser as date_parser

                        mca_doi = date_parser.parse(str(raw_doi)).strftime("%Y-%m-%d")
                    except Exception:
                        mca_doi = ""

                mca_company_name = (
                    company_info.get("Company Name")
                    or company_info.get("LLP Name")
                    or ""
                ).strip()

                mca_category = (
                    company_info.get("Company Category")
                    or company_info.get("Class of Company")
                    or company_info.get("Company SubCategory")
                    or company_info.get("Type of Company")
                    or ""
                ).strip()
                mca_client_type = _map_mca_constitution(mca_category)
                if mca_client_type == "other":
                    mca_client_type = _map_mca_constitution(
                        mca_category + " " + mca_company_name
                    )
                if mca_client_type == "other" and (
                    company_info.get("LLPIN") or ""
                ).strip() not in ("", "-", "nan"):
                    mca_client_type = "llp"
                if mca_client_type == "other":
                    mca_client_type = (
                        _detect_entity_type_from_name(mca_company_name) or "other"
                    )

                mca_email = _clean_obfuscated_email(
                    company_info.get("Email Id") or company_info.get("Email") or ""
                )

                mca_data = {
                    "company_name": mca_company_name,
                    "client_type": mca_client_type,
                    "company_category": mca_category,
                    "email": mca_email,
                    "phone": company_info.get("Phone")
                    or company_info.get("Mobile")
                    or "",
                    "date_of_incorporation": mca_doi,
                    "address": raw_addr,
                    "city": mca_city,
                    "state": mca_state,
                    "pan": company_info.get("PAN") or "",
                    "cin": company_info.get("CIN") or company_info.get("LLPIN") or "",
                    "directors": directors,
                    "raw": company_info,
                }
                doc_types_found.append("MCA Master Data (Excel)")
            except Exception as e:
                logger.warning(f"MCA Excel parse failed: {e}")

    if not doc_types_found:
        raise HTTPException(
            status_code=422,
            detail=(
                "No recognizable documents found. Upload a GST Registration Certificate (PDF), "
                "Udyam/MSME Certificate (PDF), or MCA Company Master Data (PDF or Excel .xlsx/.xls)."
            ),
        )

    def _first(*vals):
        return next(
            (v for v in vals if v and str(v).strip() not in ("", "nan", "-")), ""
        )

    # ── Merge: GST > Udyam > MCA ──────────────────────────────────────────────
    merged_name = _first(
        gst_data.get("legal_name"),
        gst_data.get("trade_name"),
        udyam_data.get("enterprise_name"),
        mca_data.get("company_name"),
    )
    merged_name = re.sub(r"(?i)^M[/\.]?S[/\.]?\s+", "", merged_name).strip()

    constitution = gst_data.get("constitution") or ""
    const_raw = gst_data.get("constitution_raw") or ""
    gstin = gst_data.get("gstin") or ""
    udyam_number = udyam_data.get("udyam_number") or ""
    msme_type = udyam_data.get("msme_type") or ""
    pan = _first(mca_data.get("pan"), udyam_data.get("pan"))
    cin = mca_data.get("cin") or ""

    address = _first(
        gst_data.get("address"), udyam_data.get("address"), mca_data.get("address")
    )
    city = _first(gst_data.get("city"), udyam_data.get("city"), mca_data.get("city"))
    state = _first(
        gst_data.get("state"), udyam_data.get("state"), mca_data.get("state")
    )
    pin = _first(gst_data.get("pin"), udyam_data.get("pin"))
    gst_full_address = gst_data.get("full_address") or ""

    mca_directors = mca_data.get("directors", [])
    gst_partners = [
        {
            "name": p["name"],
            "designation": p.get("designation", "Director"),
            "email": "",
            "phone": "",
            "birthday": "",
            "din": "",
        }
        for p in gst_data.get("partners", [])
    ]
    all_contacts = list(mca_directors)
    existing_names = {c["name"].lower().strip() for c in all_contacts}
    for c in gst_partners:
        if c["name"].lower().strip() not in existing_names:
            all_contacts.append(c)
            existing_names.add(c["name"].lower().strip())
    if not all_contacts:
        all_contacts = [
            {
                "name": "",
                "designation": "",
                "email": "",
                "phone": "",
                "birthday": "",
                "din": "",
            }
        ]

    email = _clean_obfuscated_email(
        _first(udyam_data.get("email"), mca_data.get("email"))
    )
    phone_raw = _first(udyam_data.get("mobile"), mca_data.get("phone"))
    phone_digits = re.sub(r"\D", "", phone_raw or "")
    if len(phone_digits) == 12 and phone_digits.startswith("91"):
        phone_digits = phone_digits[2:]
    phone = phone_digits[:10] if len(phone_digits) >= 10 else phone_digits

    date_of_incorporation = _first(
        udyam_data.get("date_of_incorporation"),
        mca_data.get("date_of_incorporation"),
    )

    # ── client_type: GST constitution > MCA category (Pvt/LLP/Public/etc) > name ──
    mca_client_type = mca_data.get("client_type") or ""
    if constitution and constitution != "other":
        client_type = constitution
    elif mca_client_type and mca_client_type != "other":
        client_type = mca_client_type
    else:
        client_type = _detect_entity_type_from_name(merged_name) or "other"
    company_category = mca_data.get("company_category") or ""

    notes_parts = []
    if cin:
        notes_parts.append(f"CIN/LLPIN: {cin}")
    if udyam_number:
        notes_parts.append(f"Udyam: {udyam_number}")
    if msme_type:
        notes_parts.append(f"MSME Type: {msme_type}")
    notes = "\n".join(notes_parts)

    return {
        "status": "ok",
        "doc_types_found": doc_types_found,
        "company_name": merged_name,
        "constitution": constitution,
        "constitution_raw": const_raw,
        "client_type": client_type,
        "company_category": company_category,
        "gstin": gstin,
        "pan": pan,
        "cin": cin,
        "udyam_number": udyam_number,
        "msme_type": msme_type,
        "address": address,
        "city": city,
        "state": state,
        "pin": pin,
        "gst_address": gst_full_address,
        "email": email,
        "phone": phone,
        "date_of_incorporation": date_of_incorporation,
        "contact_persons": all_contacts,
        "notes": notes,
        "gst_data": gst_data,
        "udyam_data": udyam_data,
    }


# ==============================================================
# MDS (MCA) EXCEL SMART PARSER
# ==============================================================
@api_router.post("/clients/parse-mds-excel")
async def parse_mds_excel_for_client_form(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    filename = file.filename.lower()
    if not filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=400, detail="Only Excel files (.xlsx / .xls) are supported."
        )
    try:
        content = await file.read()
        excel = pd.ExcelFile(BytesIO(content))
    except Exception as e:
        raise HTTPException(
            status_code=400, detail=f"Could not open Excel file: {str(e)}"
        )

    def clean_email(raw: str) -> str:
        if not raw:
            return ""
        cleaned = raw.replace("[at]", "@").replace("[dot]", ".").strip()
        return cleaned if "@" in cleaned else ""

    def clean_phone(raw: str) -> str:
        digits = re.sub(r"\D", "", str(raw or ""))
        if len(digits) == 12 and digits.startswith("91"):
            digits = digits[2:]
        return digits[:10] if len(digits) >= 10 else digits

    def detect_type(name: str) -> str:
        n = name.lower()
        if any(
            x in n for x in ["private limited", "pvt ltd", "pvt. ltd", "pvt limited"]
        ):
            return "pvt_ltd"
        if any(x in n for x in ["limited liability partnership", "llp"]):
            return "llp"
        if any(x in n for x in [" ltd", " limited"]):
            return "pvt_ltd"
        if "partnership" in n:
            return "partnership"
        if "huf" in n:
            return "huf"
        if "trust" in n:
            return "trust"
        return "proprietor"

    def parse_date(raw: str) -> str:
        if not raw or str(raw).strip() in ("", "-", "N/A"):
            return ""
        try:
            return parser.parse(str(raw).strip()).strftime("%Y-%m-%d")
        except Exception:
            return ""

    company_info: dict = {}
    directors: list = []
    extra_notes_parts: list = []

    for sheet_name in excel.sheet_names:
        df = pd.read_excel(excel, sheet_name=sheet_name, header=None).fillna("")
        sheet_lower = sheet_name.lower().strip()
        if (
            "master" in sheet_lower
            or "company" in sheet_lower
            or sheet_lower == "masterdata"
        ):
            for _, row in df.iterrows():
                key = str(row.iloc[0]).strip()
                value = str(row.iloc[1]).strip() if len(row) > 1 else ""
                if key and key not in ("", "nan") and value not in ("", "nan"):
                    if any(
                        phrase in key
                        for phrase in [
                            "Accounts and Solvency",
                            "Annual Returns",
                            "Filing Information",
                            "Interim Resolution",
                            "Sr. No",
                            "Date of filing",
                        ]
                    ):
                        continue
                    company_info[key] = value
        elif (
            "director" in sheet_lower
            or "signatory" in sheet_lower
            or "partner" in sheet_lower
        ):
            rows_list = df.values.tolist()
            header_row_idx = None
            for idx, row in enumerate(rows_list):
                row_strs = [str(c).strip() for c in row]
                if any(h in row_strs for h in ["Name", "DIN/PAN", "DIN"]):
                    header_row_idx = idx
                    break
            if header_row_idx is None:
                continue
            headers = [str(h).strip() for h in rows_list[header_row_idx]]
            for row in rows_list[header_row_idx + 1 :]:
                row_dict = {
                    headers[i]: str(row[i]).strip() if i < len(row) else ""
                    for i in range(len(headers))
                }
                name = row_dict.get("Name", "").strip()
                if not name or name in ("nan", ""):
                    continue
                din = row_dict.get("DIN/PAN", "") or row_dict.get("DIN", "")
                designation = row_dict.get("Designation", "")
                directors.append(
                    {
                        "name": name,
                        "designation": designation or "Director",
                        "email": None,
                        "phone": None,
                        "birthday": None,
                        "din": din if din not in ("nan", "-", "") else None,
                    }
                )
        else:
            rows_list = df.values.tolist()
            if len(rows_list) >= 2:
                cols = [str(c).strip() for c in rows_list[0]]
                data_rows = []
                for row in rows_list[1:]:
                    vals = [str(v).strip() for v in row]
                    if any(v not in ("", "nan", "-") for v in vals):
                        data_rows.append(dict(zip(cols, vals)))
                if data_rows:
                    extra_notes_parts.append(f"[{sheet_name}]")
                    for r in data_rows[:10]:
                        extra_notes_parts.append(
                            " | ".join(
                                f"{k}: {v}"
                                for k, v in r.items()
                                if v not in ("", "nan", "-")
                            )
                        )

    # Support both Pvt Ltd (MCA) and LLP field naming conventions
    company_name = (
        company_info.get("Company Name")
        or company_info.get("LLP Name")
        or company_info.get("company_name")
        or ""
    ).strip()

    raw_email = (
        company_info.get("Email Id")
        or company_info.get("Email")
        or company_info.get("email")
        or ""
    )
    email = clean_email(raw_email)

    raw_phone = (
        company_info.get("Phone")
        or company_info.get("Mobile")
        or company_info.get("Contact")
        or ""
    )
    phone = clean_phone(raw_phone)

    raw_doi = (
        company_info.get("Date of Incorporation")
        or company_info.get("Incorporation Date")
        or ""
    )
    birthday = parse_date(raw_doi)
    # Use Company Class/Category from master data first; fall back to name-based detection
    raw_mca_class = (
        company_info.get("Company Class")
        or company_info.get("Company Category")
        or company_info.get("Company SubCategory")
        or company_info.get("Class of Company")
        or company_info.get("Type of Company")
        or ""
    ).strip()
    if raw_mca_class and raw_mca_class not in ("-", "nan", ""):
        client_type = _map_mca_constitution(raw_mca_class)
        # If class alone maps to "other", also try combining with company name
        if client_type == "other":
            client_type = _map_mca_constitution(raw_mca_class + " " + company_name)
    else:
        client_type = detect_type(company_name)

    address = (
        company_info.get("Registered Address")
        or company_info.get("Registered Office Address")
        or company_info.get("Address")
        or ""
    ).strip()
    if address in ("-", "nan"):
        address = ""

    city = ""
    state = ""
    if address:
        address_parts = [p.strip() for p in address.split(",") if p.strip()]
        if len(address_parts) >= 3:
            state = address_parts[-3]
            city = address_parts[-4] if len(address_parts) >= 4 else ""
        elif len(address_parts) == 2:
            state = address_parts[-1]
            city = address_parts[-2]

    notes_lines = []

    cin = company_info.get("CIN", "") or company_info.get("LLPIN", "")
    if cin and cin not in ("-", "nan"):
        notes_lines.append(f"CIN/LLPIN: {cin}")

    roc = company_info.get("ROC Name", "") or company_info.get(
        "ROC (name and office)", ""
    )
    if roc and roc not in ("-", "nan"):
        notes_lines.append(f"ROC: {roc}")

    reg_no = company_info.get("Registration Number", "")
    if reg_no and reg_no not in ("-", "nan"):
        notes_lines.append(f"Reg No: {reg_no}")

    auth_cap = company_info.get("Authorised Capital (Rs)", "") or company_info.get(
        "Total Obligation of Contribution", ""
    )
    if auth_cap and auth_cap not in ("-", "nan"):
        notes_lines.append(f"Capital/Contribution: Rs{auth_cap}")

    paid_cap = company_info.get("Paid up Capital (Rs)", "")
    if paid_cap and paid_cap not in ("-", "nan"):
        notes_lines.append(f"Paid-up Capital: Rs{paid_cap}")

    if extra_notes_parts:
        notes_lines.append("\n".join(extra_notes_parts))

    notes = "\n".join(notes_lines)

    status_raw = (
        company_info.get("Company Status", "")
        or company_info.get("LLP Status", "Active")
    ).lower()
    status = "active" if "active" in status_raw else "inactive"
    return {
        "status": "ok",
        "company_name": company_name,
        "client_type": client_type,
        "email": email,
        "phone": phone,
        "birthday": birthday,
        "address": address,
        "city": city,
        "state": state,
        "services": [],
        "notes": notes,
        "status_value": status,
        "contact_persons": directors,
        "dsc_details": [],
        "assigned_to": "unassigned",
        "raw_company_info": company_info,
        "sheets_parsed": excel.sheet_names,
    }


# ==============================================================
# GENERAL CLIENT PDF PARSER  (used by Add-New-Client panel)
# ==============================================================
@api_router.post("/clients/parse-pdf")
async def parse_client_pdf(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Generic client-info extractor from any PDF document.
    Tries GST cert first, then Udyam cert, then falls back to
    heuristic regex across all text.  Returns whichever fields it
    can find (company_name, email, phone, pan, gstin, cin, llpin,
    client_type, address, city, state).
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    content = await file.read()
    if len(content) > 15 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF too large — max 15 MB.")

    result: dict = {}

    try:
        import pdfplumber, re as _re

        with pdfplumber.open(BytesIO(content)) as pdf:
            full_text = "\n".join((page.extract_text() or "") for page in pdf.pages)

        text = full_text

        # ── Helper regexes ──────────────────────────────────────
        def first(pattern, flags=0):
            m = _re.search(pattern, text, flags | _re.IGNORECASE)
            return m.group(1).strip() if m else ""

        # GSTIN  (15-char alphanum starting with 2 digits)
        gstin = first(r"\b([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b")
        if gstin:
            result["gstin"] = gstin
            # State code → state name
            STATE_CODE_MAP = {
                "01": "Jammu and Kashmir",
                "02": "Himachal Pradesh",
                "03": "Punjab",
                "04": "Chandigarh",
                "05": "Uttarakhand",
                "06": "Haryana",
                "07": "Delhi",
                "08": "Rajasthan",
                "09": "Uttar Pradesh",
                "10": "Bihar",
                "11": "Sikkim",
                "12": "Arunachal Pradesh",
                "13": "Nagaland",
                "14": "Manipur",
                "15": "Mizoram",
                "16": "Tripura",
                "17": "Meghalaya",
                "18": "Assam",
                "19": "West Bengal",
                "20": "Jharkhand",
                "21": "Odisha",
                "22": "Chhattisgarh",
                "23": "Madhya Pradesh",
                "24": "Gujarat",
                "25": "Dadra and Nagar Haveli and Daman and Diu",
                "26": "Dadra and Nagar Haveli and Daman and Diu",
                "27": "Maharashtra",
                "28": "Andhra Pradesh",
                "29": "Karnataka",
                "30": "Goa",
                "31": "Lakshadweep",
                "32": "Kerala",
                "33": "Tamil Nadu",
                "34": "Puducherry",
                "35": "Andaman and Nicobar Islands",
                "36": "Telangana",
                "37": "Andhra Pradesh",
            }
            state_code = gstin[:2]
            if state_code in STATE_CODE_MAP and not result.get("state"):
                result["state"] = STATE_CODE_MAP[state_code]

        # PAN  (10-char: AAAAA0000A)
        pan = first(r"\b([A-Z]{5}[0-9]{4}[A-Z])\b")
        if pan:
            result["pan"] = pan

        # CIN  (21-char company registration)
        cin = first(
            r"\b([UL][0-9]{5}[A-Z]{2}[0-9]{4}(?:PTC|PLC|OPC|FLC|GAP|AAP|MTC|NPL|NPC|GAT|FTC)[0-9]{6})\b"
        )
        if cin:
            result["cin"] = cin

        # LLPIN  (AAA-0000 style)
        llpin = first(r"\b([A-Z]{3}-[0-9]{4,6})\b")
        if llpin:
            result["llpin"] = llpin

        # Email
        email = first(r"\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b")
        if email:
            result["email"] = email.lower()

        # Phone (Indian mobile / landline)
        phone_m = _re.search(r"\b((?:\+91[\s\-]?)?[6-9][0-9]{9})\b", text)
        if phone_m:
            result["phone"] = _re.sub(r"\D", "", phone_m.group(1))[-10:]

        # Company name heuristics
        for pattern in [
            r"(?:Legal Name|Trade Name|Business Name|Name of Business|Company Name)[:\s]+([A-Z][A-Z0-9\s&.,'\-]{3,80})",
            r"(?:M/s\.?|To,\s*)([A-Z][A-Z0-9\s&.,'\-]{3,60}(?:PVT\.?\s*LTD\.?|LLP|LIMITED|PROPRIETOR|PARTNERSHIP|HUF|TRUST))",
        ]:
            name = first(pattern)
            if name:
                result["company_name"] = name.strip().rstrip(".,")
                break

        # Auto-detect entity type from name
        if result.get("company_name") and not result.get("client_type"):
            n = result["company_name"].lower()
            if any(x in n for x in ["private limited", "pvt ltd", "pvt. ltd"]):
                result["client_type"] = "pvt_ltd"
            elif "llp" in n or "limited liability" in n:
                result["client_type"] = "llp"
            elif any(x in n for x in [" limited", " ltd"]):
                result["client_type"] = "public_ltd"
            elif "partnership" in n:
                result["client_type"] = "partnership"
            elif "huf" in n:
                result["client_type"] = "huf"
            elif "trust" in n:
                result["client_type"] = "trust"

        # Address block (rough)
        addr_m = _re.search(
            r"(?:Address|Principal Place of Business|Registered Office)[:\s]+([^\n]{10,120})",
            text,
            _re.IGNORECASE,
        )
        if addr_m:
            result["address"] = addr_m.group(1).strip()

        # City / State from text
        if not result.get("city"):
            city_m = _re.search(
                r"\b(Mumbai|Delhi|Surat|Ahmedabad|Bangalore|Bengaluru|Chennai|Hyderabad|Kolkata|Pune|Jaipur|Lucknow|Indore|Bhopal|Nagpur|Vadodara|Rajkot|Coimbatore|Visakhapatnam|Patna|Chandigarh)\b",
                text,
                _re.IGNORECASE,
            )
            if city_m:
                result["city"] = city_m.group(1).title()

    except Exception as e:
        logger.error(f"parse_client_pdf error: {e}", exc_info=True)
        raise HTTPException(
            status_code=422,
            detail="Could not parse PDF. Please fill in the details manually.",
        )

    if not result:
        raise HTTPException(
            status_code=422, detail="No recognizable client data found in this PDF."
        )

    return result


# ==============================================================
# GENERAL CLIENT EXCEL ROW PARSER  (used by Add-New-Client panel)
# ==============================================================
@api_router.post("/clients/parse-excel-row")
async def parse_client_excel_row(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Smart client-data extractor from Excel / CSV files.
    Handles two layouts automatically:

    1. COLUMN-HEADER format  — first row = headers, second row = data
       (e.g. your own bulk-import template)

    2. VERTICAL KEY-VALUE format — col A = field name, col B = value
       (e.g. MCA MDS export: 'LLP Name' | 'AARIYA SPECTRUM LLP')
       Reads ALL sheets named MasterData / master / company etc.

    Accepts .xlsx, .xls, .csv.
    Returns a dict with whatever it can extract:
      company_name, client_type, email, phone, pan, gstin,
      cin, llpin, address, city, state.
    """
    fname = file.filename.lower()
    if not any(fname.endswith(ext) for ext in (".xlsx", ".xls", ".csv")):
        raise HTTPException(
            status_code=400, detail="Only .xlsx, .xls, or .csv files are supported."
        )

    content = await file.read()

    import re as _re

    # ── Helpers ────────────────────────────────────────────────────────────
    def detect_entity_type(name: str) -> str:
        n = (name or "").lower()
        if any(x in n for x in ["private limited", "pvt ltd", "pvt. ltd", "pvt.ltd"]):
            return "pvt_ltd"
        if "llp" in n or "limited liability" in n:
            return "llp"
        if any(x in n for x in [" limited", " ltd"]):
            return "public_ltd"
        if "partnership" in n:
            return "partnership"
        if "huf" in n:
            return "huf"
        if "trust" in n:
            return "trust"
        return "proprietor"

    def clean_email(raw: str) -> str:
        """Handles obfuscated emails like user[at]gmail[dot]com"""
        v = (raw or "").strip()
        v = (
            v.replace("[at]", "@")
            .replace("[dot]", ".")
            .replace(" at ", "@")
            .replace(" dot ", ".")
        )
        return v.lower() if "@" in v else ""

    def clean_phone(raw: str) -> str:
        digits = _re.sub(r"\D", "", str(raw or ""))
        if len(digits) == 12 and digits.startswith("91"):
            digits = digits[2:]
        return digits[-10:] if len(digits) >= 10 else digits

    def parse_address(raw: str):
        """
        Split a full address string like:
        'Shop 8, XYZ Complex, Varachha Road, Surat, Surat City, Gujarat, India, 395006'
        into address / city / state.
        """
        INDIAN_STATES_SET = {
            "andhra pradesh",
            "arunachal pradesh",
            "assam",
            "bihar",
            "chhattisgarh",
            "goa",
            "gujarat",
            "haryana",
            "himachal pradesh",
            "jharkhand",
            "karnataka",
            "kerala",
            "madhya pradesh",
            "maharashtra",
            "manipur",
            "meghalaya",
            "mizoram",
            "nagaland",
            "odisha",
            "punjab",
            "rajasthan",
            "sikkim",
            "tamil nadu",
            "telangana",
            "tripura",
            "uttar pradesh",
            "uttarakhand",
            "west bengal",
            "andaman and nicobar islands",
            "chandigarh",
            "dadra and nagar haveli",
            "daman and diu",
            "delhi",
            "jammu and kashmir",
            "ladakh",
            "lakshadweep",
            "puducherry",
        }
        # Common Indian cities for positive identification
        KNOWN_CITIES = {
            "mumbai",
            "delhi",
            "surat",
            "ahmedabad",
            "bangalore",
            "bengaluru",
            "chennai",
            "hyderabad",
            "kolkata",
            "pune",
            "jaipur",
            "lucknow",
            "indore",
            "bhopal",
            "nagpur",
            "vadodara",
            "rajkot",
            "coimbatore",
            "visakhapatnam",
            "patna",
            "chandigarh",
            "thane",
            "pimpri",
            "nashik",
            "faridabad",
            "meerut",
            "agra",
            "varanasi",
            "srinagar",
            "ludhiana",
            "amritsar",
            "allahabad",
            "prayagraj",
            "vijayawada",
            "madurai",
            "raipur",
            "kota",
            "aurangabad",
            "dhanbad",
            "jodhpur",
            "guwahati",
            "ranchi",
            "gwalior",
            "jabalpur",
            "tiruchirappalli",
            "tirupur",
            "hubli",
            "mysore",
            "mysuru",
            "bareilly",
            "aligarh",
            "moradabad",
            "noida",
            "gurugram",
            "gurgaon",
            "navi mumbai",
            "kalyan",
            "solapur",
            "jalandhar",
            "bhubaneswar",
            "cuttack",
            "thiruvananthapuram",
            "kozhikode",
            "kochi",
            "ernakulam",
            "mangaluru",
            "belagavi",
            "davangere",
            "bellary",
            "hospet",
            "shimla",
            "dehradun",
            "haridwar",
            "rishikesh",
            "udaipur",
            "ajmer",
            "bikaner",
            "alwar",
            "bhilwara",
            "sikar",
        }
        parts = [
            p.strip()
            for p in raw.split(",")
            if p.strip() and p.strip().lower() not in ("india", "nan", "")
        ]
        # Remove PIN code part
        parts = [p for p in parts if not _re.match(r"^\d{6}$", p)]
        # Remove "X City" duplicates (e.g. "Surat City" when "Surat" already present)
        deduped = []
        seen_lower = set()
        for p in parts:
            pl = p.lower()
            # Remove " city" / " district" suffix for dedup check
            base = _re.sub(r"\s+(city|district|taluka|tehsil)$", "", pl).strip()
            if base not in seen_lower:
                seen_lower.add(base)
                deduped.append(p)
        parts = deduped

        city = ""
        state = ""
        addr_parts = []
        for p in parts:
            pl = _re.sub(r"\s+(city|district|taluka|tehsil)$", "", p.lower()).strip()
            if p.lower() in INDIAN_STATES_SET:
                state = p.title()
            elif pl in KNOWN_CITIES and not city:
                city = pl.title()
            else:
                addr_parts.append(p)
        # Fallback: if no known city found, take second-to-last non-state part
        if not city and len(addr_parts) > 1:
            city = addr_parts.pop()
        address = ", ".join(addr_parts)
        return address, city, state

    def norm_key(k: str) -> str:
        return str(k or "").strip().lower()

    # ── Load workbook (all sheets) ─────────────────────────────────────────
    try:
        if fname.endswith(".csv"):
            sheets = {
                "Sheet1": pd.read_csv(BytesIO(content), dtype=str, header=None).fillna(
                    ""
                )
            }
        elif fname.endswith(".xls"):
            xl = pd.ExcelFile(BytesIO(content), engine="xlrd")
            sheets = {
                s: pd.read_excel(xl, sheet_name=s, dtype=str, header=None).fillna("")
                for s in xl.sheet_names
            }
        else:
            xl = pd.ExcelFile(BytesIO(content), engine="openpyxl")
            sheets = {
                s: pd.read_excel(xl, sheet_name=s, dtype=str, header=None).fillna("")
                for s in xl.sheet_names
            }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read file: {str(e)}")

    if not sheets:
        raise HTTPException(status_code=422, detail="File appears to be empty.")

    # ── Detect layout: vertical KV vs horizontal header ───────────────────
    # Heuristic: if col-0 of row-0 looks like a section header and col-1
    # of row-1 looks like a value (not a typical column name), it's KV.
    def is_kv_sheet(df: pd.DataFrame) -> bool:
        if df.shape[1] < 2 or df.shape[0] < 3:
            return False
        col0_vals = [
            str(v).strip()
            for v in df.iloc[:8, 0]
            if str(v).strip() and str(v).strip().lower() != "nan"
        ]
        # KV sheets have field-name-like strings in col 0 (mixed case, spaces)
        kv_like = sum(1 for v in col0_vals if " " in v or len(v) > 12)
        return kv_like >= 2

    # ── Strategy 1: Vertical KV (MCA MDS, Tally exports, etc.) ───────────
    def extract_from_kv_sheets(sheets: dict) -> dict:
        kv: dict = {}
        # Prefer MasterData sheet; fall back to all sheets
        priority = [
            s
            for s in sheets
            if "master" in s.lower() or "company" in s.lower() or "llp" in s.lower()
        ]
        ordered = priority + [s for s in sheets if s not in priority]
        for sname in ordered:
            df = sheets[sname]
            if not is_kv_sheet(df):
                continue
            for _, row in df.iterrows():
                k = norm_key(row.iloc[0])
                v = str(row.iloc[1]).strip() if df.shape[1] > 1 else ""
                if not k or k == "nan" or not v or v == "nan":
                    continue
                kv[k] = v
        return kv

    kv_data = extract_from_kv_sheets(sheets)

    result: dict = {}

    if kv_data:
        # Map KV keys → client fields
        KV_NAME_KEYS = [
            "llp name",
            "company name",
            "name of company",
            "name of llp",
            "business name",
            "trade name",
            "legal name",
            "firm name",
            "entity name",
        ]
        KV_EMAIL_KEYS = ["email id", "email", "email address", "e-mail", "e mail"]
        KV_PHONE_KEYS = [
            "phone",
            "mobile",
            "contact",
            "phone no",
            "mobile no",
            "telephone",
        ]
        KV_PAN_KEYS = ["pan", "pan no", "pan number", "permanent account number"]
        KV_GSTIN_KEYS = ["gstin", "gst number", "gst no", "gstin no"]
        KV_CIN_KEYS = ["cin", "cin no", "company identification number"]
        KV_LLPIN_KEYS = ["llpin", "llp identification number", "llp in"]
        KV_ADDR_KEYS = [
            "registered address",
            "principal place of business",
            "office address",
            "address",
        ]
        KV_CITY_KEYS = ["city", "town"]
        KV_STATE_KEYS = ["state", "state name"]

        def kv_get(keys: list[str]) -> str:
            for k in keys:
                if k in kv_data:
                    return kv_data[k]
            # partial match
            for search_k in keys:
                for actual_k, v in kv_data.items():
                    if search_k in actual_k:
                        return v
            return ""

        company_name = kv_get(KV_NAME_KEYS)
        email_raw = kv_get(KV_EMAIL_KEYS)
        phone_raw = kv_get(KV_PHONE_KEYS)
        pan = kv_get(KV_PAN_KEYS).upper()
        gstin = kv_get(KV_GSTIN_KEYS).upper()
        cin = kv_get(KV_CIN_KEYS).upper()
        llpin = kv_get(KV_LLPIN_KEYS).upper()
        addr_raw = kv_get(KV_ADDR_KEYS)
        city = kv_get(KV_CITY_KEYS)
        state = kv_get(KV_STATE_KEYS)

        email = clean_email(email_raw)
        phone = clean_phone(phone_raw)

        # If address is a full string (MCA style), split it
        if addr_raw and "," in addr_raw and not city:
            parsed_addr, parsed_city, parsed_state = parse_address(addr_raw)
            if not city:
                city = parsed_city
            if not state:
                state = parsed_state
            addr_raw = parsed_addr or addr_raw

        client_type = detect_entity_type(company_name)
        # Extra hint: if LLPIN is present, it's definitely an LLP
        if llpin and llpin != "-":
            client_type = "llp"

        if company_name:
            result["company_name"] = company_name.strip()
        if client_type:
            result["client_type"] = client_type
        if email:
            result["email"] = email
        if phone:
            result["phone"] = phone
        if pan and pan != "-":
            result["pan"] = pan
        if gstin and gstin != "-":
            result["gstin"] = gstin
        if cin and cin != "-":
            result["cin"] = cin
        if llpin and llpin != "-":
            result["llpin"] = llpin
        if addr_raw:
            result["address"] = addr_raw.strip()
        if city:
            result["city"] = city.strip()
        if state:
            result["state"] = state.strip()

    # ── Strategy 2: Horizontal header row (fallback) ───────────────────────
    if not result:
        # Try each sheet; pick first that looks like column-header format
        for sname, df_raw in sheets.items():
            if df_raw.shape[0] < 2:
                continue
            # Try using first row as header
            df = df_raw.copy()
            df.columns = [str(c).strip() for c in df.iloc[0]]
            df = df.iloc[1:].reset_index(drop=True).fillna("")
            if df.empty:
                continue

            col_map: dict[str, str] = {}
            for col in df.columns:
                norm = col.strip().lower().replace(" ", "_").replace("/", "_")
                col_map[norm] = col

            def get_col(keys: list[str]) -> str:
                for k in keys:
                    if k in col_map:
                        val = str(df.iloc[0][col_map[k]]).strip()
                        if val and val.lower() not in ("nan", "", "-"):
                            return val
                return ""

            company_name = get_col(
                [
                    "company_name",
                    "name",
                    "client_name",
                    "business_name",
                    "entity_name",
                    "llp_name",
                    "company",
                ]
            )
            if not company_name:
                continue  # not the right sheet

            client_type = get_col(
                ["client_type", "entity_type", "type"]
            ) or detect_entity_type(company_name)
            email = clean_email(
                get_col(["email", "email_id", "email_address", "e-mail"])
            )
            phone = clean_phone(
                get_col(["phone", "mobile", "phone_no", "mobile_no", "contact"])
            )
            pan = get_col(["pan", "pan_no", "pan_number"]).upper()
            gstin = get_col(["gstin", "gst", "gst_number", "gstin_no"]).upper()
            cin = get_col(["cin", "cin_no", "company_identification_number"]).upper()
            llpin = get_col(["llpin", "llp_in", "llp_registration"]).upper()
            addr_raw = get_col(
                ["address", "addr", "registered_address", "office_address"]
            )
            city = get_col(["city", "town"])
            state = get_col(["state", "state_name"])

            if addr_raw and "," in addr_raw and not city:
                addr_raw, city, state = parse_address(addr_raw)

            if llpin:
                client_type = "llp"

            if company_name:
                result["company_name"] = company_name
            if client_type:
                result["client_type"] = client_type
            if email:
                result["email"] = email
            if phone:
                result["phone"] = phone
            if pan:
                result["pan"] = pan
            if gstin:
                result["gstin"] = gstin
            if cin:
                result["cin"] = cin
            if llpin:
                result["llpin"] = llpin
            if addr_raw:
                result["address"] = addr_raw
            if city:
                result["city"] = city
            if state:
                result["state"] = state
            break  # found a usable sheet

    if not result:
        raise HTTPException(
            status_code=422,
            detail=(
                "No recognizable client data found in this file. "
                "Expected either an MCA MDS export (key-value format) or a "
                "spreadsheet with column headers: company_name, email, phone, pan, gstin, etc."
            ),
        )

    return result


@api_router.post("/clients/import")
async def import_clients_from_csv(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """
    Bulk-import clients from a CSV file.
    Expected CSV columns (all optional except company_name):
      company_name, client_type, email, phone, birthday, address,
      city, state, services, notes, assigned_to, status
    Returns: { message, clients_created, clients_skipped, errors }
    """
    if current_user.role not in ("admin", "manager"):
        perms = get_user_permissions(current_user)
        if not perms.get("can_edit_clients", False):
            raise HTTPException(status_code=403, detail="Permission denied")

    filename = (file.filename or "").lower()
    if not filename.endswith(".csv"):
        raise HTTPException(
            status_code=400, detail="Only CSV files are supported (.csv)"
        )

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")  # handle BOM
    except UnicodeDecodeError:
        text = content.decode("latin-1")

    reader = csv.DictReader(StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(
            status_code=422, detail="CSV file is empty or has no header row"
        )

    created_count = 0
    skipped_count = 0
    errors: list = []
    now_iso = datetime.now(timezone.utc).isoformat()

    for i, row in enumerate(reader, start=2):  # row 1 = header
        company_name = str(
            row.get("company_name") or row.get("Company Name") or ""
        ).strip()
        if not company_name:
            skipped_count += 1
            continue

        # Skip duplicate (same created_by + company_name)
        existing = await db.clients.find_one(
            {
                "created_by": current_user.id,
                "company_name": {
                    "$regex": f"^{re.escape(company_name)}$",
                    "$options": "i",
                },
            },
            {"_id": 0, "id": 1},
        )
        if existing:
            skipped_count += 1
            continue

        # Parse services column (comma-separated string → list)
        raw_services = str(row.get("services") or row.get("Services") or "").strip()
        services = (
            [s.strip() for s in raw_services.split(",") if s.strip()]
            if raw_services
            else []
        )

        # Normalise client_type
        raw_type = (
            str(row.get("client_type") or row.get("Client Type") or "proprietor")
            .strip()
            .lower()
        )
        valid_types = {
            "proprietor",
            "pvt_ltd",
            "llp",
            "partnership",
            "huf",
            "trust",
            "other",
        }
        client_type = raw_type if raw_type in valid_types else "proprietor"

        doc = {
            "id": str(uuid.uuid4()),
            "company_name": company_name,
            "client_type": client_type,
            "email": str(row.get("email") or row.get("Email") or "").strip() or None,
            "phone": str(row.get("phone") or row.get("Phone") or "").strip() or None,
            "birthday": str(row.get("birthday") or row.get("Birthday") or "").strip()
            or None,
            "address": str(row.get("address") or row.get("Address") or "").strip()
            or None,
            "city": str(row.get("city") or row.get("City") or "").strip() or None,
            "state": str(row.get("state") or row.get("State") or "").strip() or None,
            "services": services,
            "notes": str(row.get("notes") or row.get("Notes") or "").strip() or None,
            "assigned_to": str(
                row.get("assigned_to") or row.get("Assigned To") or ""
            ).strip()
            or None,
            "status": str(row.get("status") or row.get("Status") or "active")
            .strip()
            .lower(),
            "created_by": current_user.id,
            "created_at": now_iso,
        }

        try:
            await db.clients.insert_one(doc)
            created_count += 1
        except Exception as e:
            errors.append({"row": i, "company": company_name, "error": str(e)[:80]})
            skipped_count += 1

    return {
        "message": f"{created_count} client(s) imported successfully",
        "clients_created": created_count,
        "clients_skipped": skipped_count,
        "errors": errors[:10],  # cap error list to avoid huge response
    }


@api_router.post("/clients", response_model=Client)
async def create_client(
    payload: dict,
    current_user: User = Depends(get_current_user),
):
    """
    Create a new client.

    ANY signed-in user may add a client — no special permission is needed.
    What differs is what happens next: an admin (or a user with
    can_approve_clients) creates it as approved, everyone else creates it as
    "pending" and it only joins the master list once an approver signs it off
    from Records ▸ Client Approvals.
    """
    try:
        client_data = ClientCreate(
            **{k: v for k, v in payload.items() if k in ClientCreate.model_fields}
        )
        client = Client(**client_data.model_dump(), created_by=current_user.id)
        doc = client.model_dump()

        # ── Approval workflow ────────────────────────────────────────────
        # Any user can add a client, but unless they are an admin (or hold
        # can_approve_clients) the record is created as "pending" and only
        # becomes part of the master list once an admin approves it.
        perms_now = get_user_permissions(current_user)
        auto_approve = current_user.role == "admin" or perms_now.get(
            "can_approve_clients", False
        )
        doc["approval_status"] = "approved" if auto_approve else "pending"
        doc["approved_by"] = current_user.id if auto_approve else None
        doc["approved_at"] = (
            datetime.now(timezone.utc).isoformat() if auto_approve else None
        )

        # ── safe_iso: handles None, str, date, datetime — never crashes ──────
        def safe_iso(val):
            if val is None:
                return None
            if isinstance(val, str):
                return val[:10] if val else None  # already "2015-04-01", keep as-is
            if isinstance(val, (date, datetime)):
                return val.isoformat()
            return str(val)

        doc["created_at"] = (
            safe_iso(doc.get("created_at")) or datetime.now(timezone.utc).isoformat()
        )
        doc["birthday"] = safe_iso(doc.get("birthday"))

        # Persist extra fields from frontend that live outside Pydantic schema
        for key in (
            "address",
            "city",
            "state",
            "client_type_label",
            "contact_persons",
            "dsc_details",
            "assignments",
            "referred_by",
            "gstin",
            "pan",
            "gst_treatment",
            "place_of_supply",
            "default_payment_terms",
            "credit_limit",
            "opening_balance",
            "opening_balance_type",
            "tally_ledger_name",
            "tally_group",
            "website",
            "msme_number",
            "gst_address",
            "gst_city",
            "gst_state",
            "gst_pin",
            "cin",
            "llpin",
            "mca_fetch_date",
            "is_itr_client",
            "itr_data",
        ):
            val = payload.get(key)
            if val is not None:
                doc[key] = val

        doc.pop("_id", None)
        await db.clients.insert_one(doc)
        return client
    except ValidationError as ve:
        logger.error(
            f"create_client ValidationError for '{payload.get('company_name')}': {ve.errors()}",
            exc_info=True,
        )
        raise HTTPException(status_code=422, detail=ve.errors())
    except Exception as e:
        logger.error(
            f"create_client error for '{payload.get('company_name')}': {e}",
            exc_info=True,
        )
        raise HTTPException(status_code=400, detail=str(e))


_DEPT_SERVICE_MAP: Dict[str, List[str]] = {
    "GST": ["GST", "Compliance"],
    "IT": ["Income Tax", "Tax Planning"],
    "ACC": ["Accounting", "Payroll", "Audit"],
    "TDS": ["TDS"],
    "ROC": ["ROC", "Company Registration", "Compliance"],
    "TM": ["Trademark"],
    "MSME": ["MSME"],
    "FEMA": ["FEMA"],
    "DSC": [],
    "OTHER": [],
}


@api_router.get("/users/{user_id}/assigned-clients")
async def get_user_assigned_clients(
    user_id: str,
    current_user: User = Depends(get_current_user),
):
    """
    Return all clients assigned to a specific user, considering BOTH:
      - the legacy single `assigned_to` field, AND
      - the per-service `assignments[].user_id` list
    so that a client whose services are split across multiple users
    shows up for each of those users.

    Each returned client includes an `assigned_services` array listing
    which services this particular user is assigned to on that client
    (legacy `assigned_to` is shown as "All services").

    Access:
      - admin: any user
      - manager: self or any user in their cross-visibility union
      - staff: self only (unless they have can_view_user_page and the
        target user is in their cross-visibility union)
    """
    # ── Access control ─────────────────────────────────────────────
    if current_user.role != "admin" and user_id != current_user.id:
        permissions = get_user_permissions(current_user)
        can_view_dir = permissions.get("can_view_user_page", False)
        cross_ids = await get_cross_visibility_union(current_user.id)
        if current_user.role == "manager":
            if user_id not in cross_ids and user_id != current_user.id:
                raise HTTPException(
                    status_code=403, detail="User not in your visibility scope"
                )
        else:
            if not (can_view_dir and user_id in cross_ids):
                raise HTTPException(status_code=403, detail="Not allowed")

    # ── Query: legacy OR per-service ───────────────────────────────
    query = {
        "$or": [
            {"assigned_to": user_id},
            {"assignments.user_id": user_id},
        ]
    }
    clients_raw = await db.clients.find(query, {"_id": 0}).to_list(2000)

    results = []
    for c in clients_raw:
        # Compute which services this user is assigned to on this client
        assigned_services: List[str] = []
        for a in c.get("assignments") or []:
            if (a or {}).get("user_id") == user_id:
                svcs = a.get("services") or []
                if isinstance(svcs, list):
                    assigned_services.extend([str(s) for s in svcs if s])
        # If legacy assigned_to matches and no per-service entry exists,
        # surface that as "All services"
        legacy_match = c.get("assigned_to") == user_id
        if legacy_match and not assigned_services:
            assigned_services = ["All services"]
        # De-duplicate while preserving order
        seen = set()
        assigned_services = [
            s for s in assigned_services if not (s in seen or seen.add(s))
        ]

        # Coerce dates to iso strings for JSON
        created_at = c.get("created_at")
        if isinstance(created_at, datetime):
            created_at = created_at.isoformat()

        results.append(
            {
                "id": c.get("id"),
                "company_name": c.get("company_name"),
                "client_type": c.get("client_type"),
                "client_type_label": c.get("client_type_label"),
                "email": c.get("email"),
                "phone": c.get("phone"),
                "city": c.get("city"),
                "state": c.get("state"),
                "status": c.get("status") or "active",
                "services": c.get("services") or [],
                "assigned_services": assigned_services,
                "assigned_to": c.get("assigned_to"),
                "assignments": c.get("assignments") or [],
                "gstin": c.get("gstin"),
                "pan": c.get("pan"),
                "created_at": created_at,
            }
        )

    # Sort: active first, then by company name
    results.sort(
        key=lambda r: (
            0 if (r.get("status") or "active") == "active" else 1,
            (r.get("company_name") or "").lower(),
        )
    )
    return {"user_id": user_id, "count": len(results), "clients": results}


@api_router.get("/clients/pending")
async def list_pending_clients(current_user: User = Depends(get_current_user)):
    """Clients awaiting admin approval.

    Approvers (admin / can_approve_clients) see every pending client;
    everyone else only sees the ones they submitted themselves.
    """
    perms = get_user_permissions(current_user)
    is_approver = current_user.role == "admin" or perms.get("can_approve_clients", False)
    query = {"approval_status": "pending"}
    if not is_approver:
        query["created_by"] = current_user.id
    rows = (
        await db.clients.find(query, {"_id": 0})
        .sort("created_at", -1)
        .to_list(500)
    )
    return {"items": rows, "total": len(rows), "can_approve": is_approver}


@api_router.post("/clients/{client_id}/approve")
async def approve_client(client_id: str, current_user: User = Depends(get_current_user)):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_approve_clients", False):
        raise HTTPException(status_code=403, detail="Not authorized to approve clients")
    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")
    await db.clients.update_one(
        {"id": client_id},
        {
            "$set": {
                "approval_status": "approved",
                "approved_by": current_user.id,
                "approved_at": datetime.now(timezone.utc).isoformat(),
                "rejection_reason": None,
            }
        },
    )
    return {"success": True, "id": client_id, "approval_status": "approved"}


@api_router.post("/clients/{client_id}/reject")
async def reject_client(
    client_id: str, payload: dict = Body(default={}), current_user: User = Depends(get_current_user)
):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_approve_clients", False):
        raise HTTPException(status_code=403, detail="Not authorized to reject clients")
    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")
    await db.clients.update_one(
        {"id": client_id},
        {
            "$set": {
                "approval_status": "rejected",
                "approved_by": current_user.id,
                "approved_at": datetime.now(timezone.utc).isoformat(),
                "rejection_reason": (payload or {}).get("reason") or "",
            }
        },
    )
    return {"success": True, "id": client_id, "approval_status": "rejected"}


def _pending_visibility_clause(current_user, permissions):
    """Pending clients are only visible to their creator and to approvers."""
    if current_user.role == "admin" or permissions.get("can_approve_clients", False):
        return None
    return {
        "$or": [
            {"approval_status": {"$in": [None, "approved"]}},
            {"approval_status": {"$exists": False}},
            {"created_by": current_user.id},
        ]
    }


def _build_clients_access_query(current_user, permissions, team_ids=None):
    """Helper: build the MongoDB access-control query for a given user.

    Visibility rules (Records → Clients):
      • admin                      → every client
      • can_view_all_clients       → every client
      • everyone else              → only clients assigned to them (plus the
        ones they created and any explicitly granted in assigned_clients)
    Pending (unapproved) clients are hidden from everyone except their
    creator and users who can approve clients.
    """
    pending_clause = _pending_visibility_clause(current_user, permissions)

    if current_user.role == "admin" or permissions.get("can_view_all_clients", False):
        return {} if pending_clause is None else pending_clause

    extra_clients = permissions.get("assigned_clients", []) or []
    or_clauses = [
        {"assigned_to": current_user.id},
        {"created_by": current_user.id},
        {"assignments.user_id": current_user.id},
    ]
    if extra_clients:
        or_clauses.append({"id": {"$in": extra_clients}})
    if current_user.role == "manager" and team_ids:
        or_clauses.append({"assigned_to": {"$in": team_ids}})
        or_clauses.append({"assignments.user_id": {"$in": team_ids}})
    access = {"$or": or_clauses}
    if pending_clause is None:
        return access
    return {"$and": [access, pending_clause]}


def _normalize_client_dates(client: dict) -> dict:
    """Normalize legacy client records for stable frontend filtering and JSON serialization."""
    raw_type = str(client.get("client_type") or "").strip().lower().replace("-", "_").replace(" ", "_")
    type_aliases = {
        "llp": "llp", "limited_liability_partnership": "llp",
        "limited_liability_partnership_llp": "llp",
        "private_limited": "pvt_ltd", "private_limited_company": "pvt_ltd",
        "public_limited": "public_ltd", "public_limited_company": "public_ltd",
        "section8": "section_8", "section_8_company": "section_8",
    }
    if raw_type:
        client["client_type"] = type_aliases.get(raw_type, raw_type)
    if isinstance(client.get("created_at"), str):
        try:
            client["created_at"] = datetime.fromisoformat(client["created_at"])
        except ValueError:
            client["created_at"] = None
    if client.get("birthday") and isinstance(client["birthday"], str):
        try:
            client["birthday"] = date.fromisoformat(client["birthday"])
        except ValueError:
            client["birthday"] = None
    return client


@api_router.get("/clients", response_model=List[Client])
async def get_clients(
    current_user: User = Depends(check_module_permission("clients", "view")),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
):
    """
    Return clients with pagination so the first page renders fast.
    Default page_size=100 keeps initial payload small; callers can pass
    page_size=500 (or loop pages) when they need the full list (e.g. export).
    """
    permissions = get_user_permissions(current_user)
    team_ids = None
    if current_user.role == "manager":
        team_ids = await get_team_user_ids(current_user.id)

    query = _build_clients_access_query(current_user, permissions, team_ids)

    skip = (page - 1) * page_size
    clients = (
        await db.clients.find(query, {"_id": 0})
        .sort("company_name", 1)
        .skip(skip)
        .limit(page_size)
        .to_list(page_size)
    )

    return [_normalize_client_dates(c) for c in clients]


@api_router.get("/clients/search")
async def search_clients(
    q: str = Query("", min_length=0),
    limit: int = Query(30, ge=1, le=100),
    current_user: User = Depends(check_module_permission("clients", "view")),
):
    """
    Fast server-side search used by the Merge dialog (and anywhere else that
    needs a quick typeahead).  Returns only the fields needed for display so
    the payload stays tiny.
    """
    permissions = get_user_permissions(current_user)
    team_ids = None
    if current_user.role == "manager":
        team_ids = await get_team_user_ids(current_user.id)

    access_query = _build_clients_access_query(current_user, permissions, team_ids)

    # Build text filter (regex — fast enough for ≤10 k docs)
    search_filter: dict = {}
    if q.strip():
        regex = {"$regex": q.strip(), "$options": "i"}
        search_filter = {
            "$or": [
                {"company_name": regex},
                {"phone": regex},
                {"email": regex},
                {"gstin": regex},
            ]
        }

    # Combine access control + text filter
    if access_query and search_filter:
        combined = {"$and": [access_query, search_filter]}
    elif search_filter:
        combined = search_filter
    else:
        combined = access_query

    # Minimal projection — only what the Merge dialog renders
    projection = {
        "_id": 0,
        "id": 1,
        "company_name": 1,
        "client_type": 1,
        "phone": 1,
        "email": 1,
        "gstin": 1,
        "status": 1,
    }

    clients = (
        await db.clients.find(combined, projection)
        .sort("company_name", 1)
        .limit(limit)
        .to_list(limit)
    )
    return clients


@api_router.get("/clients/{client_id}", response_model=Client)
async def get_client(client_id: str, current_user: User = Depends(get_current_user)):
    client = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    # Issue #5: BOTH permission AND visibility must pass
    # Permission check (clients.view → can_view_all_clients)
    assert_module_permission(current_user, "clients", "view")
    # Visibility check - admin passes inside assert_module_permission
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        can_view_all = permissions.get("can_view_all_clients", False)
        is_assigned = client.get("assigned_to") == current_user.id
        is_created_by = client.get("created_by") == current_user.id
        extra_clients = permissions.get("assigned_clients", []) or []
        in_extra_list = client_id in extra_clients
        # Per-service multi-user assignments
        assignments = client.get("assignments") or []
        in_assignments = any(
            (a or {}).get("user_id") == current_user.id for a in assignments
        )
        # Manager also sees team-assigned clients (including per-service team assignments)
        team_in = False
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            team_in = client.get("assigned_to") in team_ids or any(
                (a or {}).get("user_id") in team_ids for a in assignments
            )

        if not (
            can_view_all
            or is_assigned
            or is_created_by
            or in_extra_list
            or in_assignments
            or team_in
        ):
            raise HTTPException(
                status_code=403, detail="Not authorized to view this client"
            )

    if isinstance(client["created_at"], str):
        client["created_at"] = datetime.fromisoformat(client["created_at"])
    if client.get("birthday") and isinstance(client["birthday"], str):
        client["birthday"] = date.fromisoformat(client["birthday"])
    return Client(**client)


@api_router.put("/clients/{client_id}", response_model=Client)
async def update_client(
    client_id: str,
    client_data: dict,  # <-- Changed from ClientCreate to dict
    current_user: User = Depends(check_module_permission("clients", "edit")),
):
    """
    Update an existing client record.

    Accepts a raw dict instead of ClientCreate so that:
      - Extra frontend-only fields (address, city, state, client_type_label)
        are accepted without causing Pydantic validation failures.
      - Empty strings sent by the frontend (email="", phone="") are
        safely converted to None before any validation runs.
      - The referred_by field can be any string without pattern checks.

    Only fields in ALLOWED_FIELDS are written to the database.
    """
    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")

    perms = get_user_permissions(current_user)
    if current_user.role != "admin":
        can_edit_all = perms.get("can_edit_clients", False)
        is_assigned = existing.get("assigned_to") == current_user.id
        is_created_by = existing.get("created_by") == current_user.id
        extra_clients = perms.get("assigned_clients", []) or []
        in_extra_list = client_id in extra_clients
        # Per-service multi-user assignments
        assignments = existing.get("assignments") or []
        in_assignments = any(
            (a or {}).get("user_id") == current_user.id for a in assignments
        )

        if not (
            can_edit_all
            or is_assigned
            or is_created_by
            or in_extra_list
            or in_assignments
        ):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Not authorized to edit this client. Ask an admin for the "
                    "\"Clients — edit / update any client\" permission."
                ),
            )

    # ── Whitelist: only persist known fields ────────────────────────
    ALLOWED_FIELDS = {
        "company_name",
        "client_type",
        "client_type_label",
        "email",
        "phone",
        "birthday",
        "date_of_incorporation",
        "address",
        "city",
        "state",
        "services",
        "notes",
        "assigned_to",
        "assignments",
        "status",
        "contact_persons",
        "dsc_details",
        "referred_by",
        # Tax & Billing
        "gstin",
        "pan",
        "gst_treatment",
        "place_of_supply",
        "default_payment_terms",
        "credit_limit",
        "opening_balance",
        "opening_balance_type",
        "tally_ledger_name",
        "tally_group",
        "website",
        "msme_number",
        "gst_address",
        "gst_city",
        "gst_state",
        "gst_pin",
        # MCA / ROC
        "cin",
        "llpin",
        "mca_fetch_date",
        # ITR Client
        "is_itr_client",
        "itr_data",
    }
    update_data = {k: v for k, v in client_data.items() if k in ALLOWED_FIELDS}

    # ── Convert empty strings → None for nullable fields ────────────
    NULLABLE_FIELDS = {
        "email",
        "phone",
        "referred_by",
        "notes",
        "assigned_to",
        "birthday",
        "date_of_incorporation",
        "address",
        "city",
        "state",
        "client_type_label",
        "gstin",
        "pan",
        "place_of_supply",
        "default_payment_terms",
        "credit_limit",
        "opening_balance",
        "tally_ledger_name",
        "tally_group",
        "website",
        "msme_number",
        "gst_address",
        "gst_city",
        "gst_state",
        "gst_pin",
    }
    for field in NULLABLE_FIELDS:
        if field in update_data and update_data[field] == "":
            update_data[field] = None

    # ── Validate and normalise client_type ──────────────────────────
    VALID_CLIENT_TYPES = {
        "proprietor",
        "pvt_ltd",
        "llp",
        "partnership",
        "huf",
        "trust",
        "other",
        # Accept legacy uppercase variants from old data
        "LLP",
        "PVT_LTD",
    }
    if "client_type" in update_data:
        ct = update_data["client_type"]
        if ct not in VALID_CLIENT_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid client_type '{ct}'. Must be one of: proprietor, pvt_ltd, llp, partnership, huf, trust, other",
            )
        # Normalise to lowercase for consistent storage
        lower_map = {"LLP": "llp", "PVT_LTD": "pvt_ltd"}
        update_data["client_type"] = lower_map.get(ct, ct)

    # ── Validate company_name length ────────────────────────────────
    if "company_name" in update_data:
        name = str(update_data["company_name"]).strip()
        if len(name) < 3:
            raise HTTPException(
                status_code=422,
                detail="Company name must be at least 3 characters long",
            )
        update_data["company_name"] = name

    # ── Validate phone if provided ──────────────────────────────────
    if update_data.get("phone"):
        cleaned_phone = re.sub(r"\s|-|\+", "", str(update_data["phone"]))
        if not cleaned_phone.isdigit():
            raise HTTPException(
                status_code=422, detail="Phone number must contain only digits"
            )
        if not (10 <= len(cleaned_phone) <= 15):
            raise HTTPException(
                status_code=422, detail="Phone number must be 10–15 digits"
            )

    # ── Sanitise date fields before writing so DB always stores ISO strings ──
    def safe_iso(val):
        """Convert None / str / date / datetime → ISO date string (YYYY-MM-DD) or None."""
        if val is None:
            return None
        if isinstance(val, str):
            return val[:10] if val else None
        if isinstance(val, (date, datetime)):
            return val.isoformat()[:10]
        return str(val)

    for date_field in ("birthday", "date_of_incorporation"):
        if date_field in update_data:
            update_data[date_field] = safe_iso(update_data[date_field])

    # Sanitise dates inside dsc_details sub-documents
    if "dsc_details" in update_data and isinstance(update_data["dsc_details"], list):
        for dsc in update_data["dsc_details"]:
            if isinstance(dsc, dict):
                dsc["issue_date"] = safe_iso(dsc.get("issue_date"))
                dsc["expiry_date"] = safe_iso(dsc.get("expiry_date"))

    # Sanitise dates inside contact_persons sub-documents
    if "contact_persons" in update_data and isinstance(
        update_data["contact_persons"], list
    ):
        for cp in update_data["contact_persons"]:
            if isinstance(cp, dict):
                cp["birthday"] = safe_iso(cp.get("birthday"))

    # ── Persist ─────────────────────────────────────────────────────
    await db.clients.update_one({"id": client_id}, {"$set": update_data})

    # Sanitise existing record before passing to audit log so that bare
    # date objects (datetime.date) in old DB records don't cause a
    # pymongo BSON encode error (InvalidDocument) → 500.
    sanitised_existing = convert_objectids(existing)

    await create_audit_log(
        current_user,
        action="UPDATE_CLIENT",
        module="client",
        record_id=client_id,
        old_data=sanitised_existing,
        new_data=update_data,
    )

    updated = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if updated is None:
        raise HTTPException(status_code=404, detail="Client not found after update")

    if isinstance(updated.get("created_at"), str):
        try:
            updated["created_at"] = datetime.fromisoformat(updated["created_at"])
        except ValueError:
            updated["created_at"] = datetime.now(timezone.utc)
    if updated.get("birthday") and isinstance(updated["birthday"], str):
        try:
            updated["birthday"] = date.fromisoformat(updated["birthday"])
        except ValueError:
            updated["birthday"] = None
    if updated.get("date_of_incorporation") and isinstance(
        updated["date_of_incorporation"], str
    ):
        try:
            updated["date_of_incorporation"] = date.fromisoformat(
                updated["date_of_incorporation"]
            )
        except ValueError:
            updated["date_of_incorporation"] = None

    # Strip fields not in Pydantic model before constructing Client
    client_fields = Client.model_fields.keys()
    safe_updated = {k: v for k, v in updated.items() if k in client_fields}
    try:
        return Client(**safe_updated)
    except Exception as e:
        logger.error(
            f"update_client response construction error for {client_id}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Client updated but response failed: {str(e)}"
        )


@api_router.delete("/clients/{client_id}")
async def delete_client(client_id: str, current_user: User = Depends(get_current_user)):
    """
    Delete a client by ID.
    - Nullifies any leads that reference this client (converted_client_id)
      so FK-style references don't leave dangling data.
    - Requires can_delete_data permission (admin always passes).
    """
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_delete_data", False):
        raise HTTPException(
            status_code=403, detail="You do not have permission to delete clients"
        )

    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")

    # Nullify any leads that were converted to this client
    await db.leads.update_many(
        {"converted_client_id": client_id}, {"$set": {"converted_client_id": None}}
    )

    # Also unlink tasks referencing this client
    await db.tasks.update_many({"client_id": client_id}, {"$set": {"client_id": None}})

    await create_audit_log(
        current_user,
        action="DELETE_CLIENT",
        module="client",
        record_id=client_id,
        old_data=existing,
    )

    result = await db.clients.delete_one({"id": client_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Client not found")

    return {
        "message": f"Client '{existing.get('company_name', client_id)}' deleted successfully"
    }


# ============================================
# DASHBOARD ROUTES
# ============================================


@api_router.get("/dashboard/dept-members")
async def get_dept_member_count(current_user: User = Depends(get_current_user)):
    """
    Returns count + basic info of users in the same department(s) as the current user.
    Accessible by all roles (admin, manager, staff).
    - Admin: returns count of ALL active users.
    - Manager: returns count of same-department users (staff + other managers).
    - Staff: returns count of same-department users (staff + managers).
    """
    if current_user.role == "admin":
        all_users = await db.users.find(
            {"is_active": True, "status": "active"},
            {"_id": 0, "id": 1, "full_name": 1, "departments": 1, "role": 1},
        ).to_list(1000)
        return {
            "count": len(all_users),
            "departments": [],
            "members": [
                {
                    "id": u["id"],
                    "full_name": u.get("full_name", ""),
                    "role": u.get("role", ""),
                }
                for u in all_users
            ],
        }

    user_depts = current_user.departments or []
    if not user_depts:
        return {"count": 0, "departments": [], "members": []}

    dept_users = await db.users.find(
        {
            "departments": {"$in": user_depts},
            "id": {"$ne": current_user.id},
            "is_active": True,
            "status": "active",
        },
        {"_id": 0, "id": 1, "full_name": 1, "departments": 1, "role": 1},
    ).to_list(500)

    return {
        "count": len(dept_users),
        "departments": user_depts,
        "members": [
            {
                "id": u["id"],
                "full_name": u.get("full_name", ""),
                "role": u.get("role", ""),
            }
            for u in dept_users
        ],
    }


@api_router.get("/dashboard/stats", response_model=DashboardStats)
async def get_dashboard_stats(current_user: User = Depends(get_current_user)):
    try:
        return await _get_dashboard_stats_impl(current_user)
    except Exception as exc:
        logger.exception("Dashboard stats failed; returning safe fallback: %s", exc)
        try:
            total_tasks = await db.tasks.count_documents({})
            completed_tasks = await db.tasks.count_documents({"status": "completed"})
            pending_tasks = await db.tasks.count_documents({"status": "pending"})
            total_dsc = await db.dsc_register.count_documents({})
            total_clients = await db.clients.count_documents({})
        except Exception:
            total_tasks = completed_tasks = pending_tasks = total_dsc = total_clients = 0
        return DashboardStats(
            total_tasks=int(total_tasks),
            completed_tasks=int(completed_tasks),
            pending_tasks=int(pending_tasks),
            overdue_tasks=0,
            total_dsc=int(total_dsc),
            expiring_dsc_count=0,
            expiring_dsc_list=[],
            total_clients=int(total_clients),
            upcoming_birthdays=0,
            upcoming_due_dates=0,
            team_workload=[],
            compliance_status={},
            expired_dsc_count=0,
        )

async def _get_dashboard_stats_impl(current_user: User = Depends(get_current_user)):
        now = datetime.now(IST)
        task_query = {}
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            if not permissions.get("can_view_all_tasks", False):
                allowed_users = permissions.get("view_other_tasks", []) or []
                if current_user.role == "manager":
                    team_ids = await get_team_user_ids(current_user.id)
                    allowed_users = list(set(allowed_users + team_ids))
                task_query["$or"] = [
                    {"assigned_to": current_user.id},
                    {"sub_assignees": current_user.id},
                    {"created_by": current_user.id},
                    {"assigned_to": {"$in": allowed_users}},
                ]

        # PERF FIX: these six queries are independent of one another (none depends
        # on another's result), but were previously awaited one-at-a-time in series
        # — each round trip to Mongo adds its own latency, so six serial calls take
        # roughly 6x as long as they need to. Firing them concurrently with
        # asyncio.gather cuts dashboard load time down to the slowest single query
        # instead of the sum of all of them.
        if current_user.role == "admin":
            client_query = {}
        else:
            permissions_for_clients = get_user_permissions(current_user)
            extra_clients = permissions_for_clients.get("assigned_clients", []) or []
            or_clauses = [
                {"assigned_to": current_user.id},
                {"created_by": current_user.id},
                {"assignments": {"$elemMatch": {"user_id": current_user.id}}},
            ]
            if extra_clients:
                or_clauses.append({"id": {"$in": extra_clients}})
            client_query = {"$or": or_clauses}

        due_date_query = {"status": "pending"}
        if current_user.role != "admin" and current_user.departments:
            due_date_query["department"] = {"$in": current_user.departments}

        async def _empty_list():
            return []

        # PERF: Use tight projections — fetch only the fields this handler actually
        # reads. Eliminates transmitting large blobs (notes, attachments, address
        # strings, etc.) that the dashboard never touches.
        (
            tasks,
            dsc_list,
            clients,
            closed_masters_stat,
            due_dates,
            users_for_workload,
        ) = await asyncio.gather(
            db.tasks.find(task_query, {
                "_id": 0, "id": 1, "status": 1, "due_date": 1,
                "assigned_to": 1, "sub_assignees": 1, "created_by": 1,
            }).to_list(length=None),
            db.dsc_register.find({}, {
                "_id": 0, "id": 1, "holder_name": 1,
                "certificate_number": 1, "expiry_date": 1,
            }).to_list(length=None),
            db.clients.find(client_query, {
                "_id": 0, "id": 1, "birthday": 1, "client_type": 1,
                "contact_persons": 1, "company_name": 1,
            }).to_list(length=None),
            db.compliance_masters.find(
                {"is_closed": True}, {"_id": 0, "name": 1, "calendar_due_date_id": 1}
            ).to_list(length=None),
            db.due_dates.find(due_date_query, {
                "_id": 0, "id": 1, "title": 1, "due_date": 1, "department": 1,
            }).to_list(length=None),
            db.users.find({}, {"_id": 0, "id": 1, "full_name": 1})
            .to_list(length=None)
            if current_user.role != "staff"
            else _empty_list(),
        )
        total_tasks = len(tasks)
        completed_tasks = len([t for t in tasks if t["status"] == "completed"])
        pending_tasks = len([t for t in tasks if t["status"] == "pending"])
        overdue_tasks = 0
        for task in tasks:
            if task.get("due_date") and task["status"] != "completed":
                try:
                    due_date = (
                        datetime.fromisoformat(task["due_date"])
                        if isinstance(task["due_date"], str)
                        else task["due_date"]
                    )
                    if due_date.tzinfo is None:
                        due_date = due_date.replace(tzinfo=timezone.utc)
                    if due_date < now:
                        overdue_tasks += 1
                except (ValueError, TypeError):
                    continue

        total_dsc = len(dsc_list)
        expiring_dsc_count = 0
        expired_dsc_count = 0
        expiring_dsc_list = []
        for dsc in dsc_list:
            try:
                expiry_date = (
                    datetime.fromisoformat(dsc["expiry_date"])
                    if isinstance(dsc["expiry_date"], str)
                    else dsc["expiry_date"]
                )
                days_left = (expiry_date - now).days
                if days_left < 0:
                    expired_dsc_count += 1
                if days_left <= 90:
                    expiring_dsc_count += 1
                    expiring_dsc_list.append(
                        {
                            "id": dsc["id"],
                            "holder_name": dsc["holder_name"],
                            "certificate_number": dsc.get("certificate_number", "N/A"),
                            "expiry_date": dsc["expiry_date"],
                            "days_left": days_left,
                            "status": "expired" if days_left < 0 else "expiring",
                        }
                    )
            except (ValueError, TypeError):
                continue

        total_clients = len(clients)
        today = date.today()
        upcoming_birthdays = 0

        for client in clients:
            for person in personal_birthday_candidates(client):
                raw = person["birthday"]
                try:
                    bday = (
                        date.fromisoformat(raw[:10])
                        if isinstance(raw, str)
                        else raw
                    )
                    try:
                        this_year_bday = bday.replace(year=today.year)
                    except ValueError:
                        this_year_bday = bday.replace(year=today.year, day=28)
                    if this_year_bday < today:
                        try:
                            this_year_bday = bday.replace(year=today.year + 1)
                        except ValueError:
                            this_year_bday = bday.replace(year=today.year + 1, day=28)
                    days_until = (this_year_bday - today).days
                    if 0 <= days_until <= 7:
                        upcoming_birthdays += 1
                except (ValueError, TypeError):
                    continue

        upcoming_due_dates_count = 0

        # Exclude due_dates whose compliance master is marked closed
        closed_names_stat = {
            m["name"].strip().lower() for m in closed_masters_stat if m.get("name")
        }
        closed_cal_ids_stat = {
            m["calendar_due_date_id"]
            for m in closed_masters_stat
            if m.get("calendar_due_date_id")
        }

        for dd in due_dates:
            if dd.get("id") in closed_cal_ids_stat:
                continue
            if dd.get("title", "").strip().lower() in closed_names_stat:
                continue
            try:
                dd_date = (
                    datetime.fromisoformat(dd["due_date"])
                    if isinstance(dd["due_date"], str)
                    else dd["due_date"]
                )
                days_until_due = (dd_date - now).days
                if days_until_due <= 120:
                    upcoming_due_dates_count += 1
            except (ValueError, TypeError):
                continue

        team_workload = []
        if current_user.role != "staff":
            for user in users_for_workload:
                user_tasks = [t for t in tasks if t.get("assigned_to") == user["id"]]
                team_workload.append(
                    {
                        "user_id": user["id"],
                        "user_name": user["full_name"],
                        "total_tasks": len(user_tasks),
                        "pending_tasks": len(
                            [t for t in user_tasks if t["status"] == "pending"]
                        ),
                        "completed_tasks": len(
                            [t for t in user_tasks if t["status"] == "completed"]
                        ),
                    }
                )

        compliance_score = 100
        if total_tasks > 0:
            compliance_score -= (overdue_tasks / total_tasks) * 50
        if total_dsc > 0:
            compliance_score -= (expiring_dsc_count / total_dsc) * 30

        compliance_status = {
            "score": max(0, int(compliance_score)),
            "status": "good"
            if compliance_score >= 80
            else "warning"
            if compliance_score >= 50
            else "critical",
            "overdue_tasks": overdue_tasks,
            "expiring_certificates": expiring_dsc_count,
        }

        return DashboardStats(
            total_tasks=total_tasks,
            completed_tasks=completed_tasks,
            pending_tasks=pending_tasks,
            overdue_tasks=overdue_tasks,
            total_dsc=total_dsc,
            expiring_dsc_count=expiring_dsc_count,
            expiring_dsc_list=expiring_dsc_list,
            total_clients=total_clients,
            upcoming_birthdays=upcoming_birthdays,
            upcoming_due_dates=upcoming_due_dates_count,
            team_workload=team_workload,
            compliance_status=compliance_status,
            expired_dsc_count=expired_dsc_count,
        )


# ==========================================================
# STAFF ACTIVITY ROUTES
# ==========================================================
@api_router.post("/activity/log")
async def log_staff_activity(
    activity_data: StaffActivityCreate, current_user: User = Depends(get_current_user)
):
    activity = StaffActivityLog(user_id=current_user.id, **activity_data.model_dump())
    doc = activity.model_dump()
    doc["timestamp"] = datetime.now(IST)
    await db.staff_activity.insert_one(doc)
    return {"message": "Activity logged successfully"}


@api_router.get("/activity/summary")
async def get_activity_summary(
    user_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: User = Depends(check_permission("can_view_staff_activity")),
):
    # PERMISSION MATRIX:
    # Admin   → all activity
    # Manager → own activity only + explicitly granted via view_other_activity list
    # Staff   → own activity only + explicitly granted via view_other_activity list
    # (Manager does NOT get automatic team access — must be granted by admin)
    query = {}
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_others = permissions.get("view_other_activity", []) or []
        # All non-admin roles use the same rule: own + explicit cross-vis list
        visible_ids = list(set(allowed_others + [current_user.id]))

        if user_id:
            if user_id != current_user.id and user_id not in visible_ids:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorised to view this user's activity",
                )
            query["user_id"] = user_id
        else:
            query["user_id"] = {"$in": visible_ids}
    if date_from or date_to:
        query["timestamp"] = {}
    if date_from:
        try:
            query["timestamp"]["$gte"] = datetime.fromisoformat(date_from)
        except Exception:
            pass
    if date_to:
        try:
            query["timestamp"]["$lte"] = datetime.fromisoformat(date_to)
        except Exception:
            pass
    # PERF: tight projection + 5 000-record cap.  The aggregation below only
    # reads six fields per document; fetching the full document (~20 fields
    # including raw page-title strings) wastes bandwidth and memory.
    activities = await db.staff_activity.find(query, {
        "_id": 0,
        "user_id": 1, "duration_seconds": 1, "app_name": 1,
        "category": 1, "website": 1, "idle": 1,
    }).sort("timestamp", -1).limit(5000).to_list(5000)
    user_summary = {}
    for activity in activities:
        uid = activity.get("user_id")
        if not uid:
            continue
        duration = activity.get("duration_seconds") or 0
        app_name = activity.get("app_name", "Unknown App")
        category = activity.get("category", "other")
        website = activity.get("website")
        idle = activity.get("idle", False)
        if uid not in user_summary:
            user_summary[uid] = {
                "user_id": uid,
                "total_duration": 0,
                "active_duration": 0,
                "idle_duration": 0,
                "apps": {},
                "websites": {},
                "categories": {},
            }
        user_summary[uid]["total_duration"] += duration
        if idle:
            user_summary[uid]["idle_duration"] += duration
        else:
            user_summary[uid]["active_duration"] += duration
        if app_name not in user_summary[uid]["apps"]:
            user_summary[uid]["apps"][app_name] = {"count": 0, "duration": 0}
        user_summary[uid]["apps"][app_name]["count"] += 1
        user_summary[uid]["apps"][app_name]["duration"] += duration
        if website:
            if website not in user_summary[uid]["websites"]:
                user_summary[uid]["websites"][website] = 0
            user_summary[uid]["websites"][website] += duration
        if category not in user_summary[uid]["categories"]:
            user_summary[uid]["categories"][category] = 0
        user_summary[uid]["categories"][category] += duration
    users = await db.users.find({}, {"_id": 0, "password": 0}).to_list(200)
    user_map = {
        u.get("id"): u.get("full_name", "Unknown") for u in users if u.get("id")
    }
    result = []
    for uid, data in user_summary.items():
        data["user_name"] = user_map.get(uid, "Unknown")
        data["apps_list"] = sorted(
            [{"name": k, **v} for k, v in data["apps"].items()],
            key=lambda x: x["duration"],
            reverse=True,
        )
        productive_duration = data["categories"].get("productivity", 0)
        total_duration = data["total_duration"]
        data["productivity_percent"] = (
            (productive_duration / total_duration) * 100 if total_duration > 0 else 0
        )
        result.append(data)

    intensity_map = {}
    radar_metrics = {}
    tool_chain_data = []
    for item in result:
        uid = item["user_id"]
        intensity_map[uid] = {
            "duration": item["total_duration"],
            "productivity_percent": item["productivity_percent"],
        }
        radar_metrics[uid] = {
            "productivity": item["productivity_percent"],
            "attendance": 75,
            "task_completion": 80,
        }
        tool_chain_data.append(
            {"user_id": uid, "top_apps": item.get("apps_list", [])[:3]}
        )
    for item in result:
        uid = item["user_id"]
        item["intensityMap"] = intensity_map.get(uid, {})
        item["radarMetrics"] = radar_metrics.get(uid, {})
        item["toolChainData"] = next(
            (t for t in tool_chain_data if t["user_id"] == uid), {}
        )
    return result


@api_router.get("/activity/user/{user_id}")
async def get_user_activity(
    user_id: str,
    limit: int = 100,
    current_user: User = Depends(check_permission("can_view_staff_activity")),
):
    # PERMISSION MATRIX:
    # Admin   → any user's activity
    # Manager → own activity + explicitly granted via view_other_activity (no auto team)
    # Staff   → own activity + explicitly granted via view_other_activity
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_others = permissions.get("view_other_activity", []) or []
        visible_ids = list(set(allowed_others + [current_user.id]))
        if user_id != current_user.id and user_id not in visible_ids:
            raise HTTPException(
                status_code=403,
                detail="You are not authorised to view this user's activity",
            )
    activities = (
        await db.staff_activity.find({"user_id": user_id}, {"_id": 0})
        .sort("timestamp", -1)
        .to_list(limit)
    )
    return activities


# TASK REMINDER ROUTES
# ─── Email Template Defaults ──────────────────────────────────────────────────
_DEFAULT_TASK_EMAIL_TEMPLATE = {
    "accent_color": "#4F46E5",
    "company_name": "Task-O-Sphere",
    "tagline": "Your Productivity. Our Priority.",
    "support_email": "info.taskosphere@gmail.com",
    "website": "www.taskosphere.com",
    "footer_note": "This is an automated notification from Task-O-Sphere. Please do not reply directly to this email.",
    "subject_prefix": "⏰ You Have Pending Tasks!",
    "greeting_line": "We hope you are doing well. This is an automated reminder from Task-O-Sphere to let you know that you have pending tasks that require your attention. Please review and complete them at your earliest convenience.",
    "tips": [
        "Log in to Task-O-Sphere daily to review and update your task status.",
        "Use the Priority filter to focus on High-priority tasks first.",
        "Set personal reminders inside the app so you never miss a deadline.",
        "Reach out to your team lead if you need deadline extensions or support.",
    ],
}


def build_reminder_email(
    user_name: str,
    task_list: list,
    user_map: dict = None,
    tpl: dict = None,
) -> tuple[str, str]:
    """
    Builds a rich HTML + plain-text task reminder email.
    tpl: optional dict with customisable template fields (from DB email_templates).
    user_map: dict of {user_id: full_name} for resolving 'Assigned By'.
    Returns (subject, html_body).
    """
    from datetime import datetime, timezone

    t = {**_DEFAULT_TASK_EMAIL_TEMPLATE, **(tpl or {})}
    user_map = user_map or {}
    acc = t["accent_color"]
    first = user_name.split()[0] if user_name else "there"
    now = datetime.now(timezone.utc)

    def fmt_date(raw):
        if not raw or raw == "N/A":
            return "N/A"
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            return dt.strftime("%d %b %Y")
        except Exception:
            return str(raw)[:10]

    def parse_dt(raw):
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            # Ensure always timezone-aware so comparison with now (UTC) never crashes
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None

    def priority_info(p):
        p = (p or "medium").lower()
        if p in ("critical", "high"):
            return ("🔴", "High", "#dc2626", "#fee2e2")
        if p == "medium":
            return ("🟠", "Medium", "#ea580c", "#fff7ed")
        return ("🟡", "Low", "#ca8a04", "#fefce8")

    def status_color(s):
        s = (s or "pending").lower().replace("_", " ")
        if s in ("completed", "done"):
            return ("#16a34a", "#dcfce7")
        if s in ("in progress",):
            return ("#2563eb", "#dbeafe")
        return ("#6b7280", "#f3f4f6")

    total_count = len(task_list)
    overdue_count = sum(
        1
        for t2 in task_list
        if parse_dt(t2.get("due_date")) and parse_dt(t2.get("due_date")) < now
    )
    week_secs = 7 * 86400
    due_week_count = sum(
        1
        for t2 in task_list
        if parse_dt(t2.get("due_date"))
        and 0 <= (parse_dt(t2.get("due_date")) - now).total_seconds() <= week_secs
    )

    # ── Subject ───────────────────────────────────────────────────────────────
    subject = f"{t['subject_prefix']} — {total_count} Task{'s' if total_count != 1 else ''} Pending"

    # ── Build task rows ───────────────────────────────────────────────────────
    task_rows_html = ""
    for idx, task in enumerate(task_list, start=1):
        title = task.get("title") or "Untitled"
        assigned_by = user_map.get(task.get("created_by", ""), "Admin")
        due_str = fmt_date(task.get("due_date"))
        prio_ico, prio_label, prio_fg, prio_bg = priority_info(task.get("priority"))
        status_raw = (task.get("status") or "Pending").replace("_", " ").title()
        st_fg, st_bg = status_color(task.get("status"))
        row_bg = "#ffffff" if idx % 2 == 1 else "#f8fafc"
        task_rows_html += f"""
        <tr style="background:{row_bg}">
          <td style="padding:10px 14px;color:#64748b;font-size:13px;text-align:center;border-bottom:1px solid #e2e8f0">{idx}</td>
          <td style="padding:10px 14px;color:#1e293b;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0">{title}</td>
          <td style="padding:10px 14px;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0">{assigned_by}</td>
          <td style="padding:10px 14px;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0">{due_str}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:{prio_bg};color:{prio_fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{prio_ico} {prio_label}</span>
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:{st_bg};color:{st_fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{status_raw}</span>
          </td>
        </tr>"""

    # ── Tips rows ─────────────────────────────────────────────────────────────
    tips_html = "".join(
        f'<li style="margin:6px 0;color:#475569;font-size:14px">✔&nbsp; {tip}</li>'
        for tip in t["tips"]
    )

    # ── Full HTML ─────────────────────────────────────────────────────────────
    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:30px 0">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <!-- HEADER -->
  <tr>
    <td style="background:linear-gradient(135deg,{acc} 0%,#7C3AED 100%);padding:36px 40px 28px;text-align:center">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.75);font-size:12px;letter-spacing:2px;text-transform:uppercase">{t["company_name"]}</p>
      <h1 style="margin:0 0 8px;color:#ffffff;font-size:26px;font-weight:800">⏰ You Have Pending Tasks!</h1>
      <p style="margin:0;color:rgba(255,255,255,0.85);font-size:13px;font-style:italic">{t["tagline"]}</p>
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td style="padding:32px 40px 0">
      <p style="margin:0 0 8px;color:#1e293b;font-size:16px">Dear <strong>{user_name}</strong>,</p>
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.7">{t["greeting_line"]}</p>
    </td>
  </tr>

  <!-- SUMMARY STATS -->
  <tr>
    <td style="padding:24px 40px">
      <p style="margin:0 0 14px;color:#1e293b;font-size:15px;font-weight:700">📊 Task Summary</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" style="padding:0 6px 0 0">
            <div style="background:#f0f4ff;border-radius:12px;padding:16px;text-align:center">
              <p style="margin:0;font-size:28px;font-weight:800;color:{acc}">{total_count}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Total Pending</p>
            </div>
          </td>
          <td width="33%" style="padding:0 3px">
            <div style="background:#fff1f2;border-radius:12px;padding:16px;text-align:center">
              <p style="margin:0;font-size:28px;font-weight:800;color:#dc2626">{overdue_count}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Overdue</p>
            </div>
          </td>
          <td width="33%" style="padding:0 0 0 6px">
            <div style="background:#f0fdf4;border-radius:12px;padding:16px;text-align:center">
              <p style="margin:0;font-size:28px;font-weight:800;color:#16a34a">{due_week_count}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Due This Week</p>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- TASK TABLE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0 0 14px;color:#1e293b;font-size:15px;font-weight:700">📋 Your Pending Tasks</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        <thead>
          <tr style="background:{acc}">
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:center">#</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Task Name</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Assigned By</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Due Date</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Priority</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Status</th>
          </tr>
        </thead>
        <tbody>{task_rows_html}
        </tbody>
      </table>
    </td>
  </tr>

  <!-- CTA BUTTON -->
  <tr>
    <td style="padding:0 40px 28px;text-align:center">
      <a href="https://{t["website"]}" style="display:inline-block;background:linear-gradient(135deg,{acc},#7C3AED);color:#ffffff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:30px;text-decoration:none">🚀 Take Action Now &rarr;</a>
    </td>
  </tr>

  <!-- TIPS -->
  <tr>
    <td style="padding:0 40px 28px">
      <div style="background:#f8fafc;border-left:4px solid {acc};border-radius:8px;padding:18px 20px">
        <p style="margin:0 0 10px;color:#1e293b;font-size:14px;font-weight:700">💡 Quick Tips to Stay on Track</p>
        <ul style="margin:0;padding-left:16px">{tips_html}</ul>
      </div>
    </td>
  </tr>

  <!-- DIVIDER & FOOTER NOTE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">If you have any questions or face issues accessing your tasks, please contact your system administrator or reply to this email.</p>
      <p style="margin:14px 0 0;color:#1e293b;font-size:14px">Thank you for your continued dedication.</p>
      <p style="margin:10px 0 0;color:#1e293b;font-size:14px">Warm regards,<br><strong>The {t["company_name"]} Team</strong></p>
      <p style="margin:6px 0 0;color:{acc};font-size:13px">{t["support_email"]} &nbsp;|&nbsp; {t["website"]}</p>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="margin:0;color:#94a3b8;font-size:11px">{t["footer_note"]}</p>
      <p style="margin:6px 0 0;color:#94a3b8;font-size:11px">© 2026 {t["company_name"]}. All rights reserved.</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>"""

    return subject, html


@api_router.get("/reminders/due-popups")
async def get_due_reminder_popups(current_user: User = Depends(get_current_user)):
    """
    Polled every ~30s by ReminderPopupManager.jsx on the frontend.

    Returns reminders for the current user that are due (remind_at <= now),
    not yet dismissed, and not yet fired — then marks them as fired so they
    don't pop up again on the next poll.

    Also folds in any `db.notifications` docs created with popup=True (e.g.
    the per-task / bulk "raise a popup" button on the Tasks page Actions
    column, sent via POST /notifications/send) that haven't been shown yet,
    so both systems feed the same on-screen popup + desktop Notification()
    pipeline on the frontend.

    ACCESS RULE (popup gating):
      - Admin: always allowed (default on, not revocable via governance).
      - Manager / staff: allowed ONLY IF both are true —
          1. `can_receive_popup_reminders` is granted on their permissions
             (ADMIN_GRANTED_ONLY by default; toggled via Permission
             Governance, same as can_send_reminders).
          2. Cross visibility is switched on for them, i.e. at least one
             view_other_* array is non-empty (get_cross_visibility_union
             returns at least one id).
      If either condition fails, no popups are fetched or marked fired —
      the underlying reminders stay pending so they can fire once the
      user is granted access.
    """
    if current_user.role != "admin":
        perms = get_user_permissions(current_user)
        has_popup_permission = perms.get("can_receive_popup_reminders", False)
        cross_visibility_on = bool(await get_cross_visibility_union(current_user.id))
        if not (has_popup_permission and cross_visibility_on):
            return []

    now_iso = datetime.now(timezone.utc).isoformat()
    cursor = db.reminders.find({
        "user_id": str(current_user.id),
        "remind_at": {"$lte": now_iso},
        "is_dismissed": False,
        "is_fired": False,
    }).sort("remind_at", 1).limit(20)

    due_docs = await cursor.to_list(length=20)
    if due_docs:
        ids = [doc["_id"] for doc in due_docs]
        await db.reminders.update_many(
            {"_id": {"$in": ids}},
            {"$set": {"is_fired": True, "updated_at": now_iso}},
        )

    results = [
        {
            "id": str(doc.get("_id")),
            "type": doc.get("reminder_type", "reminder"),
            "title": doc.get("title", "Reminder"),
            "message": doc.get("description", ""),
            "task_id": doc.get("related_task_id"),
        }
        for doc in due_docs
    ]

    popup_cursor = db.notifications.find({
        "user_id": str(current_user.id),
        "popup": True,
        "is_read": False,
    }).sort("created_at", 1).limit(20)
    popup_docs = await popup_cursor.to_list(length=20)
    if popup_docs:
        popup_ids = [doc["id"] for doc in popup_docs if doc.get("id")]
        if popup_ids:
            await db.notifications.update_many(
                {"id": {"$in": popup_ids}},
                {"$set": {"is_read": True}},
            )
        results.extend([
            {
                "id": doc.get("id"),
                "type": doc.get("type") or "task_popup",
                "title": doc.get("title", "Reminder"),
                "message": doc.get("message", ""),
                "task_id": doc.get("task_id"),
            }
            for doc in popup_docs
        ])

    return results


@api_router.post("/send-pending-task-reminders")

async def send_pending_task_reminders(current_user: User = Depends(get_current_user)):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_send_reminders", False):
        raise HTTPException(status_code=403, detail="Reminder permission required")
    tasks = await db.tasks.find({"status": {"$ne": "completed"}}, {"_id": 0}).to_list(
        1000
    )
    if not tasks:
        return {
            "message": "No pending tasks found",
            "emails_sent": 0,
            "emails_failed": [],
        }

    # Batch lookup: collect all unique assigned_to IDs, fetch users in one query
    assigned_ids = list({t["assigned_to"] for t in tasks if t.get("assigned_to")})
    users_list = await db.users.find({"id": {"$in": assigned_ids}}, {"_id": 0}).to_list(
        1000
    )
    user_by_id = {u["id"]: u for u in users_list}

    user_task_map = {}
    for task in tasks:
        assigned_to = task.get("assigned_to")
        if not assigned_to:
            continue
        user = user_by_id.get(assigned_to)
        if not user:
            continue
        email = user.get("email")
        if not email:
            continue
        user_task_map.setdefault(email, {"user": user, "tasks": []})["tasks"].append(
            task
        )

    # Fetch all users for "Assigned By" column + email template settings
    all_users = await db.users.find({}, {"_id": 0, "id": 1, "full_name": 1}).to_list(
        500
    )
    user_map = {u["id"]: u.get("full_name", "Admin") for u in all_users}
    tpl_doc = await db.email_templates.find_one({"type": "task_reminder"}, {"_id": 0})
    tpl = tpl_doc.get("settings") if tpl_doc else None

    success_count = 0
    failed_emails = []
    for email, data in user_task_map.items():
        try:
            user_name = data["user"].get("full_name", "")
            subject, html_body = build_reminder_email(
                user_name, data["tasks"], user_map=user_map, tpl=tpl
            )
            sent = await _brevo_send(
                email,
                subject,
                body_plain=f"Hello {user_name},\n\nYou have {len(data['tasks'])} pending tasks. Please log in to Task-O-Sphere to review them.",
                body_html=html_body,
            )
            if sent:
                success_count += 1
            else:
                failed_emails.append(email)
        except Exception as e:
            failed_emails.append(email)
            logger.error(f"Error sending reminder to {email}: {str(e)}")
    return {
        "message": "Reminder process completed",
        "total_users": len(user_task_map),
        "emails_sent": success_count,
        "emails_failed": failed_emails,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# EMAIL TEMPLATE SETTINGS  (GET / PUT)
# ═══════════════════════════════════════════════════════════════════════════════


class EmailTemplateUpdateRequest(BaseModel):
    settings: dict


@api_router.get("/email-templates/{template_type}")
async def get_email_template(
    template_type: str,
    current_user: User = Depends(get_current_user),
):
    """
    Returns the saved customisation for an email template.
    Falls back to built-in defaults when nothing has been saved yet.
    template_type: 'task_reminder' | 'compliance_reminder'
    """
    doc = await db.email_templates.find_one({"type": template_type}, {"_id": 0})
    if doc:
        return {"type": template_type, "settings": doc.get("settings", {})}
    # Return defaults so the UI can pre-populate the form
    defaults = {
        "task_reminder": _DEFAULT_TASK_EMAIL_TEMPLATE,
        "compliance_reminder": _DEFAULT_COMPLIANCE_EMAIL_TEMPLATE,
    }
    return {"type": template_type, "settings": defaults.get(template_type, {})}


@api_router.put("/email-templates/{template_type}")
async def update_email_template(
    template_type: str,
    body: EmailTemplateUpdateRequest,
    current_user: User = Depends(require_admin),
):
    """
    Save (upsert) customisation for an email template. Admin only.
    Accepts a partial settings dict — only the provided keys are updated.
    """
    allowed = ("task_reminder", "compliance_reminder")
    if template_type not in allowed:
        raise HTTPException(400, f"template_type must be one of {allowed}")

    # Merge with existing so partial updates don't wipe other keys
    existing = await db.email_templates.find_one({"type": template_type}, {"_id": 0})
    current_settings = existing.get("settings", {}) if existing else {}
    merged = {**current_settings, **body.settings}

    await db.email_templates.update_one(
        {"type": template_type},
        {
            "$set": {
                "type": template_type,
                "settings": merged,
                "updated_by": current_user.id,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        upsert=True,
    )
    return {"message": "Template updated successfully", "settings": merged}


# ═══════════════════════════════════════════════════════════════════════════════
# COMPLIANCE CLIENT EMAIL
# ═══════════════════════════════════════════════════════════════════════════════

_DEFAULT_COMPLIANCE_EMAIL_TEMPLATE = {
    "subject_prefix": "📋 Compliance Reminder",
    "greeting_line": "We hope this message finds you well. Please find below the compliance items that require your attention. Kindly ensure timely completion to avoid any penalties or legal implications.",
    "footer_note": "This is an automated compliance reminder. For queries, please contact us at the details below.",
    "cta_label": "Contact Us Now",
    "tips": [
        "Ensure all documents are submitted well before the due date.",
        "Keep digital copies of all filed returns and acknowledgments.",
        "Contact us immediately if you need an extension or face any issues.",
    ],
}


def _status_badge_compliance(s: str) -> tuple:
    s = (s or "pending").lower().replace("_", " ")
    if s in ("completed", "filed"):
        return ("#16a34a", "#dcfce7")
    if s in ("in progress",):
        return ("#2563eb", "#dbeafe")
    if s == "overdue":
        return ("#dc2626", "#fee2e2")
    return ("#6b7280", "#f3f4f6")


class ComplianceEmailRequest(BaseModel):
    company_id: str
    client_name: str
    client_email: str
    subject: Optional[str] = None
    compliance_items: List[dict]  # [{name, category, due_date, status, notes}]


@api_router.post("/compliance/send-client-email")
async def send_compliance_client_email(
    req: ComplianceEmailRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Send a branded compliance reminder email to a client.
    Uses the selected company's logo, name, phone, email, and website.
    """
    if current_user.role not in ("admin", "manager"):
        raise HTTPException(403, "Admin or Manager only")

    company = await db.companies.find_one({"id": req.company_id}, {"_id": 0})
    if not company:
        raise HTTPException(404, "Company not found")

    # Check Brevo is configured
    if not os.getenv("BREVO_API_KEY") or not os.getenv("SENDER_EMAIL"):
        raise HTTPException(
            500, "Brevo email not configured (set BREVO_API_KEY and SENDER_EMAIL)"
        )

    tpl_doc = await db.email_templates.find_one(
        {"type": "compliance_reminder"}, {"_id": 0}
    )
    tpl = {
        **_DEFAULT_COMPLIANCE_EMAIL_TEMPLATE,
        **(tpl_doc.get("settings", {}) if tpl_doc else {}),
    }

    comp_name = company.get("name", "Our Firm")
    comp_phone = company.get("phone", "")
    comp_email_c = company.get("email", os.getenv("SENDER_EMAIL", ""))
    comp_website = company.get("website", "")
    comp_address = company.get("address", "")
    comp_gstin = company.get("gstin", "")
    logo_b64 = company.get("logo_base64", "")

    # Strip data-URI prefix if present
    if logo_b64 and "base64," in logo_b64:
        logo_b64 = logo_b64.split("base64,", 1)[1]

    logo_tag = (
        f'<img src="data:image/png;base64,{logo_b64}" alt="{comp_name}" '
        f'style="max-height:54px;max-width:180px;object-fit:contain;margin-bottom:6px">'
        if logo_b64
        else f'<span style="font-size:22px;font-weight:800;color:#ffffff">{comp_name}</span>'
    )

    now = datetime.now(timezone.utc)

    def fmt_d(raw):
        if not raw:
            return "—"
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).strftime(
                "%d %b %Y"
            )
        except Exception:
            return str(raw)[:10]

    total = len(req.compliance_items)
    overdue = sum(
        1
        for c in req.compliance_items
        if c.get("status", "").lower() in ("overdue", "")
    )
    pending = sum(
        1
        for c in req.compliance_items
        if (c.get("status", "") or "pending").lower()
        not in ("completed", "filed", "na")
    )

    rows_html = ""
    for idx, item in enumerate(req.compliance_items, 1):
        st_fg, st_bg = _status_badge_compliance(item.get("status", ""))
        status_label = (item.get("status") or "Pending").replace("_", " ").title()
        row_bg = "#ffffff" if idx % 2 == 1 else "#f8fafc"
        rows_html += f"""
        <tr style="background:{row_bg}">
          <td style="padding:10px 14px;color:#64748b;font-size:13px;text-align:center;border-bottom:1px solid #e2e8f0">{idx}</td>
          <td style="padding:10px 14px;color:#1e293b;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0">{item.get("name", "—")}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:#ede9fe;color:#5b21b6;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{item.get("category", "—")}</span>
          </td>
          <td style="padding:10px 14px;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0">{fmt_d(item.get("due_date"))}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:{st_bg};color:{st_fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{status_label}</span>
          </td>
          <td style="padding:10px 14px;color:#64748b;font-size:12px;border-bottom:1px solid #e2e8f0">{item.get("notes") or "—"}</td>
        </tr>"""

    tips_html = "".join(
        f'<li style="margin:6px 0;color:#475569;font-size:14px">✔&nbsp; {tip}</li>'
        for tip in tpl["tips"]
    )

    contact_parts = [p for p in [comp_phone, comp_email_c, comp_website] if p]
    contact_line = " &nbsp;|&nbsp; ".join(contact_parts)
    addr_line = (
        f"<p style='margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:12px'>{comp_address}</p>"
        if comp_address
        else ""
    )
    gstin_line = (
        f"<p style='margin:2px 0 0;color:rgba(255,255,255,0.65);font-size:11px'>GSTIN: {comp_gstin}</p>"
        if comp_gstin
        else ""
    )

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:30px 0">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <!-- HEADER with company branding -->
  <tr>
    <td style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:30px 40px 24px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>{logo_tag}</td>
          <td style="text-align:right;vertical-align:top">
            <p style="margin:0;color:rgba(255,255,255,0.7);font-size:11px">{comp_phone}</p>
            <p style="margin:2px 0 0;color:rgba(255,255,255,0.7);font-size:11px">{comp_email_c}</p>
          </td>
        </tr>
      </table>
      <h1 style="margin:16px 0 4px;color:#ffffff;font-size:22px;font-weight:800">📋 Compliance Reminder</h1>
      {addr_line}{gstin_line}
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td style="padding:28px 40px 0">
      <p style="margin:0 0 8px;color:#1e293b;font-size:16px">Dear <strong>{req.client_name}</strong>,</p>
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.7">{tpl["greeting_line"]}</p>
    </td>
  </tr>

  <!-- SUMMARY STATS -->
  <tr>
    <td style="padding:20px 40px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" style="padding:0 6px 0 0">
            <div style="background:#eff6ff;border-radius:10px;padding:14px;text-align:center">
              <p style="margin:0;font-size:26px;font-weight:800;color:#2563eb">{total}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Total Items</p>
            </div>
          </td>
          <td width="33%" style="padding:0 3px">
            <div style="background:#fef2f2;border-radius:10px;padding:14px;text-align:center">
              <p style="margin:0;font-size:26px;font-weight:800;color:#dc2626">{overdue}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Overdue</p>
            </div>
          </td>
          <td width="33%" style="padding:0 0 0 6px">
            <div style="background:#fffbeb;border-radius:10px;padding:14px;text-align:center">
              <p style="margin:0;font-size:26px;font-weight:800;color:#d97706">{pending}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Pending</p>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- COMPLIANCE TABLE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0 0 14px;color:#1e293b;font-size:15px;font-weight:700">📄 Your Compliance Items</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        <thead>
          <tr style="background:#1e3a5f">
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:center">#</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Compliance Name</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Category</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Due Date</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Status</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Notes</th>
          </tr>
        </thead>
        <tbody>{rows_html}
        </tbody>
      </table>
    </td>
  </tr>

  <!-- TIPS -->
  <tr>
    <td style="padding:0 40px 24px">
      <div style="background:#f8fafc;border-left:4px solid #2563eb;border-radius:8px;padding:16px 20px">
        <p style="margin:0 0 10px;color:#1e293b;font-size:14px;font-weight:700">💡 Important Reminders</p>
        <ul style="margin:0;padding-left:16px">{tips_html}</ul>
      </div>
    </td>
  </tr>

  <!-- SIGNATURE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.6">For any queries or assistance, please feel free to contact us. We are here to help you stay compliant.</p>
      <p style="margin:14px 0 0;color:#1e293b;font-size:14px">Warm regards,<br><strong>{comp_name}</strong></p>
      {f'<p style="margin:6px 0 0;color:#2563eb;font-size:13px">{contact_line}</p>' if contact_line else ""}
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f8fafc;padding:14px 40px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="margin:0;color:#94a3b8;font-size:11px">{tpl["footer_note"]}</p>
      <p style="margin:4px 0 0;color:#94a3b8;font-size:11px">© {now.year} {comp_name}. All rights reserved.</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>"""

    plain = (
        f"Dear {req.client_name},\n\n"
        f"{tpl['greeting_line']}\n\n"
        f"You have {total} compliance item(s) requiring attention ({overdue} overdue).\n\n"
        + "\n".join(
            f"- {c.get('name', '?')} | Due: {fmt_d(c.get('due_date'))} | Status: {c.get('status', 'Pending')}"
            for c in req.compliance_items
        )
        + f"\n\nRegards,\n{comp_name}\n{contact_line}"
    )

    subject = req.subject or f"{tpl['subject_prefix']} — {comp_name}"

    try:
        await _brevo_send(req.client_email, subject, body_plain=plain, body_html=html)
    except Exception as e:
        logger.error(f"Compliance email failed: {e}")
        raise HTTPException(500, f"Email send failed: {str(e)}")

    logger.info(f"Compliance email sent to {req.client_email} by {current_user.email}")
    return {"message": f"Compliance email sent to {req.client_email}"}


# ═══════════════════════════════════════════════════════════════════════════════
# CLIENT EMAIL TEMPLATES  —  Full CRUD
# ═══════════════════════════════════════════════════════════════════════════════


class ClientEmailTemplate(BaseModel):
    name: str
    subject: str
    body: str
    is_html: bool = False
    category: str = "general"  # general | follow_up | compliance | greeting | custom
    attachment_name: Optional[str] = ""  # optional file attached to every send
    attachment_base64: Optional[str] = ""  # base64 (no data: prefix) of the attachment


@api_router.get("/email/client-templates")
async def list_client_email_templates(current_user: User = Depends(get_current_user)):
    docs = await db.client_email_templates.find({}, {"_id": 0}).to_list(200)
    return sorted(docs, key=lambda d: d.get("updated_at", ""), reverse=True)


@api_router.post("/email/client-templates")
async def create_client_email_template(
    body: ClientEmailTemplate,
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "subject": body.subject,
        "body": body.body,
        "is_html": body.is_html,
        "category": body.category,
        "attachment_name": (body.attachment_name or ""),
        "attachment_base64": (body.attachment_base64 or ""),
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    try:
        await db.client_email_templates.insert_one(doc)
    except Exception as e:
        logger.error(f"Create client email template failed: {e}")
        raise HTTPException(500, f"Could not save template: {str(e)}")
    # insert_one mutates `doc` to add a BSON _id which is not JSON-serializable —
    # return a clean copy without it to avoid a 500 on the response.
    doc.pop("_id", None)
    return doc


@api_router.put("/email/client-templates/{template_id}")
async def update_client_email_template(
    template_id: str,
    body: ClientEmailTemplate,
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc).isoformat()
    r = await db.client_email_templates.update_one(
        {"id": template_id},
        {
            "$set": {
                "name": body.name,
                "subject": body.subject,
                "body": body.body,
                "is_html": body.is_html,
                "category": body.category,
                "attachment_name": (body.attachment_name or ""),
                "attachment_base64": (body.attachment_base64 or ""),
                "updated_at": now,
                "updated_by": current_user.id,
            }
        },
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Template not found")
    return {"message": "Template updated"}


@api_router.delete("/email/client-templates/{template_id}")
async def delete_client_email_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
):
    r = await db.client_email_templates.delete_one({"id": template_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Template not found")
    return {"message": "Template deleted"}


# ═══════════════════════════════════════════════════════════════════════════════
# BULK CLIENT EMAIL SEND  —  Brevo API  OR  Company / Gmail SMTP
# ═══════════════════════════════════════════════════════════════════════════════


class BulkEmailRecipient(BaseModel):
    email: str
    name: str = ""
    variables: dict = {}


class BulkClientEmailRequest(BaseModel):
    recipients: List[BulkEmailRecipient]
    subject: str
    body_template: str  # plain-text or HTML with {variable} placeholders
    is_html: bool = False
    company_id: Optional[str] = None  # if set, try company SMTP first
    send_method: str = "auto"  # "auto" | "brevo" | "smtp"
    from_name: Optional[str] = None
    override_sender_email: Optional[str] = (
        None  # per-request sender override (Clients bulk modal)
    )
    override_sender_name: Optional[str] = None
    attachment_name: Optional[str] = ""  # optional single attachment for all recipients
    attachment_base64: Optional[str] = ""  # base64 (no data: prefix)


def _render_body(template: str, variables: dict) -> str:
    """Substitute {key} placeholders; unknown keys are left as-is."""
    result = template
    for k, v in variables.items():
        result = result.replace("{" + k + "}", str(v or ""))
    return result


async def _send_one_smtp(
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass,
    from_name,
    to_email,
    subject,
    body_plain,
    body_html=None,
    attachments=None,
):
    """Synchronous SMTP send wrapped for asyncio.
    `attachments` is an optional list of {"name": str, "content": base64str}.
    """
    import smtplib, ssl, base64 as _b64, mimetypes
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.base import MIMEBase
    from email import encoders

    body_part = None
    if body_html:
        body_part = MIMEMultipart("alternative")
        body_part.attach(MIMEText(body_plain, "plain", "utf-8"))
        body_part.attach(MIMEText(body_html, "html", "utf-8"))
    else:
        body_part = MIMEText(body_plain, "plain", "utf-8")

    clean_atts = [a for a in (attachments or []) if a and a.get("content")]
    if clean_atts:
        msg = MIMEMultipart("mixed")
        msg.attach(body_part)
        for a in clean_atts:
            fname = a.get("name") or "attachment"
            try:
                raw = _b64.b64decode(a["content"])
            except Exception:
                continue
            ctype, _ = mimetypes.guess_type(fname)
            maintype, subtype = (
                ctype.split("/", 1) if ctype else ("application", "octet-stream")
            )
            part = MIMEBase(maintype, subtype)
            part.set_payload(raw)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=fname)
            msg.attach(part)
    else:
        msg = body_part

    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{smtp_user}>" if from_name else smtp_user
    msg["To"] = to_email

    ctx = ssl.create_default_context()
    with smtplib.SMTP(smtp_host, int(smtp_port), timeout=20) as server:
        server.ehlo()
        server.starttls(context=ctx)
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, [to_email], msg.as_string())


@api_router.post("/email/send-bulk-clients")
async def send_bulk_client_emails(
    req: BulkClientEmailRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Send personalised emails to multiple clients.
    Routing priority:
      auto / smtp  → company SMTP (if company_id provided and SMTP configured) →
                     falls back to Brevo if SMTP missing
      brevo        → always Brevo
    """
    if not req.recipients:
        raise HTTPException(400, "No recipients provided")

    # ── Resolve company SMTP settings if requested ─────────────────────────
    company_smtp = None
    company_name = req.from_name or os.getenv("SENDER_NAME", "TaskoSphere")

    # Per-request sender override from Clients bulk modal (takes highest priority for Brevo)
    _override_email = (req.override_sender_email or "").strip()
    _override_name = (req.override_sender_name or "").strip()

    if req.company_id and req.send_method in ("auto", "smtp"):
        comp = await db.companies.find_one({"id": req.company_id}, {"_id": 0})
        if comp:
            sh = (comp.get("smtp_host") or "").strip()
            su = (comp.get("smtp_user") or "").strip()
            sp = (comp.get("smtp_password") or "").strip()
            if sh and su and sp:
                company_smtp = {
                    "host": sh,
                    "port": int(comp.get("smtp_port", 587)),
                    "user": su,
                    "password": sp,
                    "from_name": comp.get("smtp_from_name")
                    or comp.get("name")
                    or company_name,
                }
                company_name = company_smtp["from_name"]

    use_brevo = (req.send_method == "brevo") or (company_smtp is None)

    if use_brevo:
        brevo_key = os.getenv("BREVO_API_KEY")
        # Use per-request override if provided, else fall back to DB active sender, then env
        if _override_email:
            sender_email = _override_email
            company_name = _override_name or company_name
        else:
            try:
                _s_doc = await db.email_sender_settings.find_one(
                    {"type": "active_sender"}, {"_id": 0}
                )
                sender_email = (_s_doc.get("email") or "").strip() if _s_doc else ""
                if _s_doc and _s_doc.get("name"):
                    company_name = _s_doc["name"].strip()
            except Exception:
                sender_email = ""
            if not sender_email:
                sender_email = os.getenv("SENDER_EMAIL")
        if not brevo_key or not sender_email:
            raise HTTPException(
                500,
                "Brevo not configured (BREVO_API_KEY + SENDER_EMAIL required). "
                "Or select a company with SMTP settings.",
            )

    # ── Optional attachment (sent with every recipient) ─────────────────────
    _attachments = None
    if (req.attachment_base64 or "").strip():
        _attachments = [
            {
                "name": (req.attachment_name or "attachment"),
                "content": req.attachment_base64.strip(),
            }
        ]

    # ── Send loop ──────────────────────────────────────────────────────────
    sent_count = 0
    fail_count = 0
    failed_list = []
    import asyncio

    for rec in req.recipients:
        if not rec.email or "@" not in rec.email:
            fail_count += 1
            continue
        vars_ = {"name": rec.name, "email": rec.email, **rec.variables}
        subject_rendered = _render_body(req.subject, vars_)
        body_rendered = _render_body(req.body_template, vars_)
        body_html_r = body_rendered if req.is_html else None
        body_plain_r = (
            body_rendered
            if not req.is_html
            else body_rendered.replace("<br>", "\\n")
            .replace("<br/>", "\\n")
            .replace("<p>", "\\n")
            .replace("</p>", "")
        )

        try:
            if use_brevo:
                await _brevo_send(
                    rec.email,
                    subject_rendered,
                    body_plain_r,
                    body_html_r,
                    attachments=_attachments,
                )
            else:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    lambda: _send_one_smtp(
                        company_smtp["host"],
                        company_smtp["port"],
                        company_smtp["user"],
                        company_smtp["password"],
                        company_smtp["from_name"],
                        rec.email,
                        subject_rendered,
                        body_plain_r,
                        body_html_r,
                        attachments=_attachments,
                    ),
                )
            sent_count += 1
        except Exception as e:
            fail_count += 1
            failed_list.append({"email": rec.email, "error": str(e)})
            logger.error(f"Bulk email to {rec.email} failed: {e}")

        await asyncio.sleep(0.05)  # gentle throttle

    logger.info(
        f"Bulk client email by {current_user.email}: {sent_count} sent, {fail_count} failed"
    )
    return {
        "message": f"Sent {sent_count} email(s). {fail_count} failed.",
        "sent": sent_count,
        "failed": fail_count,
        "failed_list": failed_list[:20],
    }


# AUDIT LOGS ROUTE
@api_router.get("/audit-logs")
async def get_audit_logs(
    module: Optional[str] = None,
    record_id: Optional[str] = None,
    action: Optional[str] = None,
    current_user: User = Depends(check_permission("can_view_audit_logs")),
):
    """
    Task Audit Log — role-scoped data access:
    - Admin: all logs
    - Manager (Own + Team): logs where user_id is own or same-department staff
    - Staff (own only): logs where user_id is own
    """
    query = {}
    if module:
        query["module"] = module
    if record_id:
        query["record_id"] = record_id
    if action and action != "ALL":
        query["action"] = action

    # Scope audit logs by role
    if current_user.role != "admin":
        if current_user.role == "manager":
            # Manager: own logs + same-department team logs
            team_ids = await get_team_user_ids(current_user.id)
            visible_ids = list(set([current_user.id] + team_ids))
        else:
            # Staff: own logs only
            visible_ids = [current_user.id]
        query["user_id"] = {"$in": visible_ids}

    logs = (
        await db.audit_logs.find(query, {"_id": 0}).sort("timestamp", -1).to_list(2000)
    )
    logs = convert_objectids(logs)
    for log in logs:
        if isinstance(log.get("timestamp"), str):
            try:
                log["timestamp"] = datetime.fromisoformat(log["timestamp"])
            except Exception:
                pass
    return logs


# INTERNAL FUNCTION FOR AUTO REMINDER
async def send_pending_task_reminders_internal():
    tasks = await db.tasks.find({"status": {"$ne": "completed"}}, {"_id": 0}).to_list(
        1000
    )
    if not tasks:
        return
    # Batch user lookup - single query for all assigned users
    assigned_ids = list({t["assigned_to"] for t in tasks if t.get("assigned_to")})
    users_list = await db.users.find({"id": {"$in": assigned_ids}}, {"_id": 0}).to_list(
        1000
    )
    user_by_id = {u["id"]: u for u in users_list}

    user_task_map = {}
    for task in tasks:
        assigned_to = task.get("assigned_to")
        if not assigned_to:
            continue
        user = user_by_id.get(assigned_to)
        if not user or not user.get("email"):
            continue
        email = user["email"]
        user_task_map.setdefault(email, {"user": user, "tasks": []})["tasks"].append(
            task
        )

    all_users = await db.users.find({}, {"_id": 0, "id": 1, "full_name": 1}).to_list(
        500
    )
    user_map = {u["id"]: u.get("full_name", "Admin") for u in all_users}
    tpl_doc = await db.email_templates.find_one({"type": "task_reminder"}, {"_id": 0})
    tpl = tpl_doc.get("settings") if tpl_doc else None

    for email, data in user_task_map.items():
        try:
            user_name = data["user"].get("full_name", "")
            subject, html_body = build_reminder_email(
                user_name, data["tasks"], user_map=user_map, tpl=tpl
            )
            await _brevo_send(
                email,
                subject,
                body_plain=f"Hello {user_name},\n\nYou have {len(data['tasks'])} pending tasks. Please log in to Task-O-Sphere to review them.",
                body_html=html_body,
            )
        except Exception as e:
            logger.error(f"Auto reminder failed for {email}: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
# AUTO DAILY REMINDER MIDDLEWARE
# ─────────────────────────────────────────────────────────────────────────────
async def _run_daily_reminder_job(today_str: str):
    """Background job - never blocks requests."""
    global _last_reminder_date_cache
    try:
        setting = await db.system_settings.find_one(
            {"key": "last_reminder_date"}, {"_id": 0}
        )
        db_last_date = setting["value"] if setting else None
        if db_last_date != today_str:
            logger.info("Auto daily reminder triggered at 10:00 AM IST")
            await send_pending_task_reminders_internal()
            await db.system_settings.update_one(
                {"key": "last_reminder_date"},
                {"$set": {"value": today_str}},
                upsert=True,
            )
        _last_reminder_date_cache = today_str
    except Exception as e:
        logger.error(f"Auto daily reminder job failed: {e}")


@app.middleware("http")
async def auto_daily_reminder(request: Request, call_next):
    global _last_reminder_date_cache
    try:
        india_time = datetime.now(pytz.timezone("Asia/Kolkata"))
        today_str = india_time.date().isoformat()
        # Only fire after 10 AM and if the in-memory cache hasn't already
        # been set for today. The cache acts as a fast pre-check; the actual
        # DB-level atomic upsert inside _run_daily_reminder_job prevents
        # duplicate sends even if multiple workers race past here.
        if india_time.hour >= 10 and _last_reminder_date_cache != today_str:
            # Set cache immediately to prevent other concurrent requests from
            # spawning duplicate background tasks in the same process.
            _last_reminder_date_cache = today_str
            asyncio.ensure_future(_run_daily_reminder_job(today_str))  # fire-and-forget
    except Exception as e:
        logger.error(f"Auto reminder middleware error: {e}")
    response = await call_next(request)
    return response


# ==================== HOLIDAY ROUTES ====================
@api_router.get("/holidays", response_model=list[HolidayResponse])
async def get_holidays(current_user: User = Depends(get_current_user)):
    # Return all non-rejected holidays to all users — no manual confirmation step
    query = {"status": {"$ne": "rejected"}}
    holidays = await db.holidays.find(query, {"_id": 0}).sort("date", 1).to_list(500)
    return holidays


@api_router.post("/holidays/auto-sync")
async def auto_sync_holidays(current_user: User = Depends(get_current_user)):
    """
    Fetches Indian public holidays for current + next year from date.nager.at
    and saves them as 'confirmed'. Idempotent — safe to call any number of times.
    Also upgrades any existing 'pending' holidays to 'confirmed' automatically.
    """
    import httpx as _httpx

    now = datetime.now(IST)
    added = 0
    upgraded = 0
    errors = []

    for year in [now.year, now.year + 1]:
        try:
            async with _httpx.AsyncClient(timeout=10) as http:
                resp = await http.get(
                    f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN"
                )
            if resp.status_code != 200:
                errors.append(f"API {resp.status_code} for {year}")
                continue
            for h in resp.json():
                date_str = h["date"]
                name = h.get("localName") or h.get("name", "Holiday")
                existing = await db.holidays.find_one({"date": date_str}, {"_id": 0})
                if not existing:
                    await db.holidays.insert_one(
                        {
                            "date": date_str,
                            "name": name,
                            "status": "confirmed",
                            "type": "public",
                            "created_at": now.isoformat(),
                        }
                    )
                    added += 1
                elif existing.get("status") not in ("confirmed", "rejected"):
                    await db.holidays.update_one(
                        {"date": date_str}, {"$set": {"status": "confirmed"}}
                    )
                    upgraded += 1
        except Exception as e:
            errors.append(f"{year}: {e}")

    logger.info(
        f"auto-sync holidays: +{added} new, {upgraded} upgraded — by {current_user.email}"
    )
    return {"added": added, "upgraded": upgraded, "errors": errors}


@api_router.post("/holidays", response_model=HolidayResponse)
async def create_holiday(
    holiday: HolidayCreate, current_user: User = Depends(require_admin())
):
    """
    Create a holiday entry.
    HolidayCreate.date is typed as Any — the frontend sends a plain string ("2026-04-05").
    Calling .isoformat() on a str raises AttributeError → 500. Guard with isinstance check.
    """
    # ── Safe date → ISO string conversion ───────────────────────────────────
    raw_date = holiday.date
    if isinstance(raw_date, str):
        date_str = raw_date.strip()[:10]  # already "YYYY-MM-DD", just normalise
    elif hasattr(raw_date, "isoformat"):
        date_str = raw_date.isoformat()  # date / datetime object
    else:
        date_str = str(raw_date)[:10]

    # Validate it actually looks like a date
    try:
        date.fromisoformat(date_str)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid date format: '{date_str}'. Use YYYY-MM-DD.",
        )

    holiday_dict = {
        "date": date_str,
        "name": holiday.name,
        "description": getattr(holiday, "description", None),
        "status": "confirmed",
        "type": getattr(holiday, "type", None) or "manual",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }

    logger.info(
        f"Creating holiday: date={holiday_dict['date']}, name={holiday_dict.get('name')}, by={current_user.id}"
    )

    # Upsert: if a record exists (auto-fetched with pending status), confirm it.
    # If it's already confirmed, return it silently (no 400 error on duplicates).
    existing = await db.holidays.find_one({"date": holiday_dict["date"]}, {"_id": 0})
    if existing:
        if existing.get("status") == "confirmed":
            logger.info(f"Holiday already confirmed for {holiday_dict['date']}")
            return existing
        # Exists but not confirmed (pending/rejected from auto-fetch) -> confirm it
        await db.holidays.update_one(
            {"date": holiday_dict["date"]},
            {
                "$set": {
                    "name": holiday_dict.get("name", existing.get("name")),
                    "status": "confirmed",
                    "type": holiday_dict.get("type", existing.get("type", "public")),
                    "updated_by": current_user.id,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
        updated = await db.holidays.find_one({"date": holiday_dict["date"]}, {"_id": 0})
        logger.info(f"Holiday upserted to confirmed: {holiday_dict['date']}")
        return updated

    try:
        await db.holidays.insert_one(holiday_dict)
        holiday_dict.pop("_id", None)
        logger.info(f"Holiday inserted: {holiday_dict['date']}")
        return holiday_dict
    except Exception as e:
        # Handle duplicate key error from unique index (race condition)
        logger.error(f"Holiday insert failed for {holiday_dict['date']}: {e}")
        existing2 = await db.holidays.find_one(
            {"date": holiday_dict["date"]}, {"_id": 0}
        )
        if existing2:
            # A concurrent insert created it — just confirm and return it
            await db.holidays.update_one(
                {"date": holiday_dict["date"]},
                {
                    "$set": {
                        "status": "confirmed",
                        "name": holiday_dict.get("name", existing2.get("name")),
                    }
                },
            )
            final = await db.holidays.find_one(
                {"date": holiday_dict["date"]}, {"_id": 0}
            )
            return final
        raise HTTPException(status_code=500, detail=f"Failed to save holiday: {str(e)}")


@api_router.patch("/holidays/{holiday_date}/status")
async def update_holiday_status(
    holiday_date: str, data: dict, current_user: User = Depends(require_admin())
):
    new_status = data.get("status")
    if new_status not in ["confirmed", "rejected", "pending"]:
        raise HTTPException(status_code=400, detail="Invalid status")
    result = await db.holidays.update_one(
        {"date": holiday_date},
        {"$set": {"status": new_status, "updated_by": current_user.id}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"message": f"Holiday marked as {new_status}"}


@api_router.delete("/holidays/{holiday_date}")
async def delete_holiday(
    holiday_date: str, current_user: User = Depends(require_admin())
):
    result = await db.holidays.delete_one({"date": holiday_date})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Holiday not found")
    return {"message": "Holiday removed"}


# ─────────────────────────────────────────────────────────────────────────────
# PDF HOLIDAY EXTRACTOR — 100% FREE using pdfplumber + regex (no API key)
# ─────────────────────────────────────────────────────────────────────────────

# Month name → number map (reused from compliance parser above)
_HOLIDAY_MONTH_MAP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


def _parse_holiday_date(text: str, default_year: int) -> Optional[str]:
    """Try every common date format found in Indian holiday PDFs. Returns YYYY-MM-DD or None."""
    text = text.strip()

    # YYYY-MM-DD or YYYY/MM/DD
    m = re.search(r"\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass

    # DD-MM-YYYY or DD/MM/YYYY
    m = re.search(r"\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    # "15 August 2026" or "15th August 2026"
    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)"
        r"(?:\s+(\d{4}))?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            yr = int(m.group(3)) if m.group(3) else default_year
            mo = _HOLIDAY_MONTH_MAP[m.group(2).lower()]
            return date(yr, mo, int(m.group(1))).isoformat()
        except ValueError:
            pass

    # "August 15" or "August 15, 2026"
    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+"
        r"(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            yr = int(m.group(3)) if m.group(3) else default_year
            mo = _HOLIDAY_MONTH_MAP[m.group(1).lower()]
            return date(yr, mo, int(m.group(2))).isoformat()
        except ValueError:
            pass

    return None


def _extract_holidays_from_text(raw_text: str) -> list:
    """
    Parse raw PDF text and extract holiday name + date pairs.
    Handles:
      - Table rows:  "Diwali | 20 October 2026"
      - Inline rows: "20-10-2026  Diwali"
      - Mixed:       "Diwali (20 Oct)"
    """
    results = []
    seen_dates = set()

    # Detect dominant year in the document (use current year as fallback)
    year_matches = re.findall(r"\b(20\d{2})\b", raw_text)
    if year_matches:
        from collections import Counter

        default_year = int(Counter(year_matches).most_common(1)[0][0])
    else:
        default_year = datetime.now().year

    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    # --- Pass 1: pipe/tab separated table rows ---
    for line in lines:
        if "|" in line or "\t" in line:
            sep = "|" if "|" in line else "\t"
            cols = [c.strip() for c in line.split(sep) if c.strip()]
            date_val = None
            name_col = None
            for col in cols:
                d = _parse_holiday_date(col, default_year)
                if d and d not in seen_dates:
                    date_val = d
                else:
                    if col and not re.match(
                        r"^(sl\.?\s*no|s\.?\s*no|sr\.?\s*no|#|date|day|holiday|occasion|name)$",
                        col,
                        re.IGNORECASE,
                    ):
                        name_col = col
            if date_val and name_col and len(name_col) > 2:
                seen_dates.add(date_val)
                results.append({"name": name_col[:80].strip(), "date": date_val})

    # --- Pass 2: lines where date and name appear together ---
    for line in lines:
        # Skip header-like lines
        if re.match(
            r"^(sl\.?\s*no|s\.?\s*no|sr\.?\s*no|#|date|day|holiday|occasion|name|month)",
            line,
            re.IGNORECASE,
        ):
            continue
        if len(line) < 5:
            continue

        date_val = _parse_holiday_date(line, default_year)
        if not date_val or date_val in seen_dates:
            continue

        # Remove the date portion to get the name
        name = re.sub(
            r"\b\d{1,2}(?:st|nd|rd|th)?[\s\-/]*"
            r"(?:january|february|march|april|may|june|july|august|september|october|november|december|"
            r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[\s,]*\d{0,4}\b",
            "",
            line,
            flags=re.IGNORECASE,
        )
        name = re.sub(r"\b\d{1,2}[-/]\d{1,2}[-/]\d{2,4}\b", "", name)
        name = re.sub(r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b", "", name)
        name = re.sub(
            r"\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b",
            "",
            name,
            flags=re.IGNORECASE,
        )
        name = re.sub(r"[\|\-–—,;:()\[\]]+", " ", name)
        name = re.sub(r"\s+", " ", name).strip()

        if len(name) < 3:
            continue

        seen_dates.add(date_val)
        results.append({"name": name[:80], "date": date_val})

    # Sort by date
    results.sort(key=lambda x: x["date"])
    return results


@api_router.post("/holidays/extract-from-pdf")
async def extract_holidays_from_pdf(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """
    100% FREE holiday extractor.
    Uses pdfplumber (already installed) + regex to parse holiday PDFs.
    No API key, no external calls.
    """
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # Extract all text from the PDF using pdfplumber (already in requirements)
    try:
        import pdfplumber

        parts = []
        with pdfplumber.open(BytesIO(content)) as pdf:
            for page in pdf.pages:
                # Extract plain text
                text = page.extract_text()
                if text:
                    parts.append(text)
                # Also extract tables so pipe-separated logic fires
                for table in page.extract_tables():
                    for row in table:
                        if row:
                            parts.append(
                                "  |  ".join(str(c or "").strip() for c in row)
                            )
        raw_text = "\n".join(parts)
    except Exception as exc:
        logger.error(f"pdfplumber failed: {exc}")
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {str(exc)}")

    if not raw_text or len(raw_text.strip()) < 10:
        raise HTTPException(
            status_code=422,
            detail="No readable text found in PDF. Try a text-based (non-scanned) PDF.",
        )

    holidays = _extract_holidays_from_text(raw_text)

    if not holidays:
        raise HTTPException(
            status_code=404,
            detail="No holidays detected. Make sure the PDF contains dates alongside holiday names.",
        )

    logger.info(
        f"PDF holiday extraction (free): {len(holidays)} holidays found by {current_user.email}"
    )
    return {"holidays": holidays}


# ─────────────────────────────────────────────────────────────────────────────
# TRADEMARK / IP NOTICE PDF EXTRACTOR
# ─────────────────────────────────────────────────────────────────────────────

_TM_MONTH_MAP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}


def _parse_tm_date(text: str) -> Optional[str]:
    """
    Parse a date string in any common format used by India's IP Office.
    Returns YYYY-MM-DD string or None.
    """
    if not text:
        return None
    text = text.strip()

    # DD/MM/YYYY or DD-MM-YYYY
    m = re.search(r"\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except ValueError:
            pass

    # YYYY-MM-DD
    m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except ValueError:
            pass

    # "06-04-2026" style already caught above, but also "06 April 2026"
    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?[\s\-]+("
        r"january|february|march|april|may|june|july|august|september|october|november|december|"
        r"jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec"
        r")[\s,]+(\d{4})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = _TM_MONTH_MAP[m.group(2).lower()]
            return date(int(m.group(3)), mo, int(m.group(1))).isoformat()
        except ValueError:
            pass

    return None


def _extract_trademark_notice_data(raw_text: str) -> dict:
    """
    Parse raw text extracted from an IP/trademark notice PDF.

    Handles bilingual (Hindi + English) notices from tmrsearch.ipindia.gov.in.
    Returns a dict with all extracted fields; missing fields are None.
    """
    result = {
        "document_type": None,
        "application_no": None,
        "class": None,
        "application_date": None,
        "used_since": None,
        "applicant_name": None,
        "recipient_name": None,
        "hearing_date": None,
        "letter_date": None,
        "brand_name": None,
        "raw_text_snippet": raw_text[:500].strip(),
    }

    # ── Document Type ────────────────────────────────────────────────────────
    text_lower = raw_text.lower()
    if "show cause" in text_lower or "mis-r" in text_lower:
        result["document_type"] = "Show Cause Hearing Notice"
    elif "examination report" in text_lower:
        result["document_type"] = "Examination Report Notice"
    elif "opposition" in text_lower:
        result["document_type"] = "Opposition Notice"
    elif "renewal" in text_lower:
        result["document_type"] = "Renewal Notice"
    elif "registration" in text_lower and "certificate" in text_lower:
        result["document_type"] = "Registration Certificate"
    else:
        result["document_type"] = "IP Office Notice"

    # ── Application Number ───────────────────────────────────────────────────
    # Handles: "Application No: 5922988" or "Application No. 1234567" or
    # "आवेदन संख्या/Application No: 5922988"
    m = re.search(
        r"(?:application\s*no\.?|app\.?\s*no\.?|आवेदन\s*संख्या)[:\s\/]*(\d{5,10})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["application_no"] = m.group(1).strip()

    # ── Class ────────────────────────────────────────────────────────────────
    m = re.search(
        r"(?:in\s+class(?:es)?|class(?:es)?)[:\s\/]*(\d{1,2}(?:\s*[,&]\s*\d{1,2})*)",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["class"] = m.group(1).strip()

    # ── Application Date ─────────────────────────────────────────────────────
    m = re.search(
        r"(?:application\s+date|आवेदन\s+तिथि)[:\s\/]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["application_date"] = _parse_tm_date(m.group(1))

    # ── Used Since ───────────────────────────────────────────────────────────
    m = re.search(
        r"(?:used\s+since|उपयोग\s+की\s+तिथि)[:\s\/]*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["used_since"] = _parse_tm_date(m.group(1))

    # ── Applicant Name ───────────────────────────────────────────────────────
    # "Name of Applicant: MR. RAJESH DHARIWAL"
    m = re.search(
        r"(?:name\s+of\s+applicant|applicant(?:\'s)?\s+name|आवेदक\s+का\s+नाम)[:\s\/]*([A-Z][A-Za-z.\s]{3,60}?)(?:\n|$|\|)",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["applicant_name"] = re.sub(r"\s+", " ", m.group(1)).strip().rstrip(".,")

    # ── Recipient / Agent Name ───────────────────────────────────────────────
    # First block: "To,\n<NAME>\n<ADDRESS>" — take line after "To,"
    m = re.search(
        r"(?:सेवा\s+में\s*\/\s*To|To\s*,)\s*\n\s*([A-Z][A-Za-z\s.]{2,50})\n",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["recipient_name"] = re.sub(r"\s+", " ", m.group(1)).strip()

    # ── Hearing Date ─────────────────────────────────────────────────────────
    # "fixed for hearing on 06-04-2026" or "दिनांक 06-04-2026 को सुनवाई"
    # Try English first
    m = re.search(
        r"(?:hearing\s+on|fixed\s+for\s+hearing\s+on|scheduled.*?on)\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["hearing_date"] = _parse_tm_date(m.group(1))

    if not result["hearing_date"]:
        # Hindi version: "दिनांक 06-04-2026 को सुनवाई"
        m = re.search(r"दिनांक\s+(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})\s+को\s+सुनवाई", raw_text)
        if m:
            result["hearing_date"] = _parse_tm_date(m.group(1))

    if not result["hearing_date"]:
        # Bold date pattern in English block — "on **06-04-2026** as scheduled"
        m = re.search(
            r"\bon\s+(\d{2}[-\/]\d{2}[-\/]\d{4})\s+as\s+scheduled",
            raw_text,
            re.IGNORECASE,
        )
        if m:
            result["hearing_date"] = _parse_tm_date(m.group(1))

    # ── Letter Date ──────────────────────────────────────────────────────────
    # "Dated: 16-02-2026" at top of letter
    m = re.search(
        r"(?:dated?|दिनांक)[:\s]*(\d{1,2}[-\/]\d{1,2}[-\/]\d{4})",
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["letter_date"] = _parse_tm_date(m.group(1))

    # ── Brand / Mark Name ────────────────────────────────────────────────────
    # Not always present in show cause notices. Try common patterns.
    m = re.search(
        r'(?:trade\s*mark(?:s)?\s+(?:application\s+)?(?:for|of)|in\s+respect\s+of)[:\s]+"?([A-Z][A-Za-z0-9\s&\-\'\.]{1,40})"?',
        raw_text,
        re.IGNORECASE,
    )
    if m:
        result["brand_name"] = m.group(1).strip().strip("\"'")

    return result


@api_router.post("/documents/extract-trademark-notice")
async def extract_trademark_notice(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """
    Extract structured data from a trademark / IP notice PDF.

    No API key required — uses pdfplumber + regex only.
    Works with India IP Office notices (tmrsearch.ipindia.gov.in),
    bilingual Hindi/English format.

    Returns:
        document_type, application_no, class, application_date,
        used_since, applicant_name, recipient_name, hearing_date,
        letter_date, brand_name
    """
    filename = (file.filename or "").lower()
    if not filename.endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    # Extract text using pdfplumber
    try:
        import pdfplumber

        parts = []
        with pdfplumber.open(BytesIO(content)) as pdf:
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    parts.append(text)
                # Also extract tables — helps with notices that put fields in table cells
                for table in page.extract_tables():
                    for row in table:
                        if row:
                            parts.append(
                                "  |  ".join(str(c or "").strip() for c in row)
                            )
        raw_text = "\n".join(parts)
    except Exception as exc:
        logger.error(f"pdfplumber failed on trademark notice: {exc}")
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {str(exc)}")

    if not raw_text or len(raw_text.strip()) < 20:
        raise HTTPException(
            status_code=422,
            detail="No readable text found. Please upload a text-based (non-scanned) PDF.",
        )

    extracted = _extract_trademark_notice_data(raw_text)

    # Require at minimum an application number OR a hearing date
    if not extracted["application_no"] and not extracted["hearing_date"]:
        raise HTTPException(
            status_code=404,
            detail="Could not find application number or hearing date. "
            "Make sure this is a valid IP Office notice PDF.",
        )

    logger.info(
        f"Trademark notice extracted by {current_user.email}: "
        f"app={extracted['application_no']}, hearing={extracted['hearing_date']}"
    )
    return extracted


# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL EXCEPTION HANDLER
# FIX: Must return a JSONResponse WITH CORS headers so the browser does not
# show a secondary "No Access-Control-Allow-Origin" error when a 500 occurs.
# The CORSMiddleware does NOT add headers to error responses generated by
# exception handlers that run outside the middleware stack, so we add them
# manually here.
# ─────────────────────────────────────────────────────────────────────────────
@app.exception_handler(Exception)
async def universal_exception_handler(request: Request, exc: Exception):
    logger.error(f"Critical Error on {request.url.path}: {str(exc)}")
    logger.error(traceback.format_exc())
    # Echo back the request origin when it's a known safe origin.
    # Also accept any *.onrender.com preview URL so staging branches work.
    import re as _re

    origin = request.headers.get("origin", "")
    allowed_origins = [
        "https://final-taskosphere-frontend.onrender.com",
        "http://localhost:3000",
        "http://localhost:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:5174",
        "http://127.0.0.1:3000",
    ]
    is_allowed = (origin in allowed_origins) or bool(
        _re.match(r"https://.*\.onrender\.com$", origin)
    )
    cors_origin = (
        origin if is_allowed else "https://final-taskosphere-frontend.onrender.com"
    )
    headers = {
        "Access-Control-Allow-Origin": cors_origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With, Cache-Control",
    }
    return JSONResponse(
        status_code=500,
        content={
            "error": "InternalServerError",
            "message": "A server error occurred. Please try again.",
            "path": request.url.path,
        },
        headers=headers,
    )


# Api Router
api_router.include_router(invoicing_router)
api_router.include_router(accounting_router)
api_router.include_router(party_ledgers_router)   # Customer/Vendor sub-ledgers under AR/AP control accounts
api_router.include_router(accounting_ext_router)  # Accounting Extended: Day Book, Cash Flow, Depreciation, TDS/TCS, Bank Recon, etc.
app.include_router(zero_touch_entry_router)     # already has /api/zte prefix
app.include_router(learning_router)           # Phase 10 Self-Learning Router
app.include_router(gst_portal_sync_router)       # already has /api/gst-portal prefix
app.include_router(accounting_lock_router)       # already has /api/accounting-integrity prefix
api_router.include_router(bank_accounts_router)
api_router.include_router(permission_governance_router)
api_router.include_router(roles_admin_router)   # Admin › Roles: role definitions, per-role permissions, user role assignment
for _governed_router in ALL_GOVERNED_ROUTERS:
    api_router.include_router(_governed_router)
app.include_router(ai_document_reader_router)
api_router.include_router(trademark_sphere_router)
app.include_router(trademark_portals_router)  # already has /api/... prefix
app.include_router(salary_slip_router)        # already has /api/compliance/salary-slips prefix
api_router.include_router(compliance_router)
api_router.include_router(roc_sphere_router)  # already has /roc-sphere prefix -> /api/roc-sphere
api_router.include_router(gst_reconciliation_router)
api_router.include_router(mis_report_router)
api_router.include_router(identix_router, prefix="/identix")
api_router.include_router(passwords_router)
api_router.include_router(auth_password_reset_router)
api_router.include_router(visits_router)
api_router.include_router(website_tracking_router)
api_router.include_router(quotation_router)
api_router.include_router(purchases_router)
api_router.include_router(telegram_router)
api_router.include_router(leads_router)
api_router.include_router(client_activity_router)
api_router.include_router(automation_router)
api_router.include_router(service_expiry_router)
api_router.include_router(recruitment_router)
api_router.include_router(notification_router)
api_router.include_router(email_router)
api_router.include_router(activity_monitor_router)
api_router.include_router(desktop_agent_router)
api_router.include_router(client_portal_router)
api_router.include_router(reminders_router)
api_router.include_router(whatsapp_router)
app.include_router(google_auth_router)

# ═══════════════════════════════════════════════════════════════════════════════
# CLIENT MERGE — merge two or more duplicate clients into one
# ═══════════════════════════════════════════════════════════════════════════════


@api_router.post("/clients/merge")
async def merge_clients(payload: dict, current_user: User = Depends(get_current_user)):
    """
    Merge multiple duplicate clients into a primary client.
    payload: { primary_id: str, secondary_ids: [str], field_overrides: {field: value} }
    - Copies all non-null fields from secondaries into primary (primary wins on conflict unless overridden).
    - Merges services, dsc_details, assignments, contact_persons arrays.
    - Re-links tasks, leads, invoices, passwords and due-dates from the secondary
      client id(s) to the primary id, so nothing linked to a deleted duplicate
      goes orphaned.
    - Deletes secondary clients after merge.
    - Requires can_edit_clients permission.
    """
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(
            status_code=403, detail="Permission denied: cannot merge clients"
        )

    primary_id = payload.get("primary_id")
    secondary_ids = payload.get("secondary_ids", [])
    field_overrides = payload.get("field_overrides", {})

    if not primary_id or not secondary_ids:
        raise HTTPException(
            status_code=400, detail="primary_id and secondary_ids are required"
        )

    primary = await db.clients.find_one({"id": primary_id})
    if not primary:
        raise HTTPException(status_code=404, detail="Primary client not found")

    secondaries = []
    for sid in secondary_ids:
        sc = await db.clients.find_one({"id": sid})
        if sc:
            secondaries.append(sc)

    if not secondaries:
        raise HTTPException(status_code=404, detail="No secondary clients found")

    # Build merged document — primary wins unless field is blank
    merged = dict(primary)

    # Scalar fields: fill from secondaries if primary field is empty
    scalar_fields = [
        "email",
        "phone",
        "birthday",
        "address",
        "city",
        "state",
        "gstin",
        "pan",
        "gst_treatment",
        "place_of_supply",
        "referred_by",
        "notes",
        "website",
        "msme_number",
        "gst_address",
        "gst_city",
        "gst_state",
        "gst_pin",
        "cin",
        "llpin",
        "tally_ledger_name",
        "tally_group",
        "credit_limit",
        "opening_balance",
        "opening_balance_type",
        "default_payment_terms",
        "proprietor_name",
        "date_of_incorporation",
        "client_type_label",
        "mca_fetch_date",
        "assigned_to",
        "is_itr_client",
        "itr_data",
    ]
    for sc in secondaries:
        for f in scalar_fields:
            if not merged.get(f) and sc.get(f):
                merged[f] = sc[f]

    # Array merges — deduplicate
    # services
    all_services = list(merged.get("services") or [])
    for sc in secondaries:
        for s in sc.get("services") or []:
            if s and s not in all_services:
                all_services.append(s)
    merged["services"] = all_services

    # dsc_details
    existing_dsc = list(merged.get("dsc_details") or [])
    seen_dsc = {d.get("pan") or d.get("name") for d in existing_dsc}
    for sc in secondaries:
        for d in sc.get("dsc_details") or []:
            key = d.get("pan") or d.get("name")
            if key not in seen_dsc:
                existing_dsc.append(d)
                seen_dsc.add(key)
    merged["dsc_details"] = existing_dsc

    # contact_persons
    existing_contacts = list(merged.get("contact_persons") or [])
    seen_cp = {
        (c.get("name") or "").lower() for c in existing_contacts if c.get("name")
    }
    for sc in secondaries:
        for cp in sc.get("contact_persons") or []:
            key = (cp.get("name") or "").lower()
            if key and key not in seen_cp:
                existing_contacts.append(cp)
                seen_cp.add(key)
    merged["contact_persons"] = existing_contacts

    # assignments
    existing_assignments = list(merged.get("assignments") or [])
    seen_assignments = {a.get("user_id") for a in existing_assignments}
    for sc in secondaries:
        for a in sc.get("assignments") or []:
            uid = a.get("user_id")
            if uid and uid not in seen_assignments:
                existing_assignments.append(a)
                seen_assignments.add(uid)
            elif uid and uid in seen_assignments:
                # merge services into existing assignment
                for ea in existing_assignments:
                    if ea.get("user_id") == uid:
                        ea["services"] = list(
                            set((ea.get("services") or []) + (a.get("services") or []))
                        )
    merged["assignments"] = existing_assignments

    # Apply manual field overrides (user chose to take value from secondary)
    for f, v in field_overrides.items():
        if f not in ("id", "created_by", "created_at", "_id"):
            merged[f] = v

    # Notes — concatenate if both have notes
    primary_notes = (primary.get("notes") or "").strip()
    secondary_notes_parts = [
        (sc.get("notes") or "").strip()
        for sc in secondaries
        if (sc.get("notes") or "").strip()
        and (sc.get("notes") or "").strip() != primary_notes
    ]
    if secondary_notes_parts:
        merged["notes"] = (
            "\n\n---\n\n".join([primary_notes] + secondary_notes_parts)
            if primary_notes
            else "\n\n---\n\n".join(secondary_notes_parts)
        )

    merged["merged_from"] = secondary_ids
    merged["merged_at"] = datetime.now(timezone.utc).isoformat()

    # Update primary
    merged.pop("_id", None)
    await db.clients.update_one({"id": primary_id}, {"$set": merged})

    # Migrate tasks/leads/invoices/passwords/due-dates that reference secondary
    # clients to the primary — so no linked records go orphaned after the merge.
    for sid in secondary_ids:
        await db.tasks.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )
        await db.leads.update_many(
            {"converted_client_id": sid}, {"$set": {"converted_client_id": primary_id}}
        )
        await db.invoices.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )
        await db.passwords.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )
        await db.due_dates.update_many(
            {"client_id": sid}, {"$set": {"client_id": primary_id}}
        )

    # Delete secondaries
    for sid in secondary_ids:
        await db.clients.delete_one({"id": sid})

    # Return updated primary
    updated = await db.clients.find_one({"id": primary_id})
    if updated:
        updated.pop("_id", None)
    return {"success": True, "merged_client": updated, "deleted_ids": secondary_ids}


# ═══════════════════════════════════════════════════════════════════════════════
# CLIENT GROUPS — group clients under a named label
# ═══════════════════════════════════════════════════════════════════════════════


@api_router.get("/client-groups")
async def list_client_groups(current_user: User = Depends(get_current_user)):
    """Return all client groups for this org (stored in client_groups collection)."""
    groups = await db.client_groups.find({}).to_list(length=500)
    for g in groups:
        g.pop("_id", None)
    return groups


@api_router.post("/client-groups")
async def create_client_group(
    payload: dict, current_user: User = Depends(get_current_user)
):
    """Create a new client group. payload: { name, description?, color? }"""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name is required")

    existing = await db.client_groups.find_one(
        {"name": {"$regex": f"^{name}$", "$options": "i"}}
    )
    if existing:
        raise HTTPException(
            status_code=409, detail="A group with this name already exists"
        )

    group = {
        "id": str(uuid.uuid4()),
        "name": name,
        "description": payload.get("description", ""),
        "color": payload.get("color", "#0D3B66"),
        "client_ids": [],
        "created_by": current_user.id,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await db.client_groups.insert_one(group)
    group.pop("_id", None)
    return group


@api_router.put("/client-groups/{group_id}")
async def update_client_group(
    group_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    """Update group name/description/color or replace client_ids list."""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    update_fields = {}
    for f in ("name", "description", "color", "client_ids"):
        if f in payload:
            update_fields[f] = payload[f]

    if not update_fields:
        raise HTTPException(status_code=400, detail="No fields to update")

    await db.client_groups.update_one({"id": group_id}, {"$set": update_fields})
    updated = await db.client_groups.find_one({"id": group_id})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    updated.pop("_id", None)
    return updated


@api_router.delete("/client-groups/{group_id}")
async def delete_client_group(
    group_id: str, current_user: User = Depends(get_current_user)
):
    """Delete a client group (does NOT delete the clients themselves)."""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    result = await db.client_groups.delete_one({"id": group_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Group not found")
    return {"success": True}


@api_router.post("/client-groups/{group_id}/members")
async def add_clients_to_group(
    group_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    """Add client_ids to a group. payload: { client_ids: [str] }"""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    ids_to_add = payload.get("client_ids", [])
    await db.client_groups.update_one(
        {"id": group_id}, {"$addToSet": {"client_ids": {"$each": ids_to_add}}}
    )
    updated = await db.client_groups.find_one({"id": group_id})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    updated.pop("_id", None)
    return updated


@api_router.delete("/client-groups/{group_id}/members")
async def remove_clients_from_group(
    group_id: str, payload: dict, current_user: User = Depends(get_current_user)
):
    """Remove client_ids from a group. payload: { client_ids: [str] }"""
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_edit_clients", False):
        raise HTTPException(status_code=403, detail="Permission denied")

    ids_to_remove = payload.get("client_ids", [])
    await db.client_groups.update_one(
        {"id": group_id}, {"$pull": {"client_ids": {"$in": ids_to_remove}}}
    )
    updated = await db.client_groups.find_one({"id": group_id})
    if not updated:
        raise HTTPException(status_code=404, detail="Group not found")
    updated.pop("_id", None)
    return updated


# ── Client Groups direct collection route safety fix ─────────────────────────
# The Clients page calls GET /api/client-groups.
# Register the exact collection endpoint directly on the FastAPI app so it
# cannot fail because of nested router mounting/order behavior.
#
# Keep the existing api_router client-group routes unchanged.
# This direct registration only guarantees the exact collection GET endpoint.

app.add_api_route(
    "/api/client-groups",
    list_client_groups,
    methods=["GET"],
    include_in_schema=False,
)

app.add_api_route(
    "/api/client-groups/",
    list_client_groups,
    methods=["GET"],
    include_in_schema=False,
)

app.include_router(api_router)

# ── Recruitment direct API mount ─────────────────────────────────────────────
# EXPLICIT ROUTE SAFETY FIX:
# The People Matrix frontend calls GET /api/recruitment.
# Register the exact collection endpoint directly on the FastAPI app so it
# cannot disappear because of nested router mounting/order issues.
#
# Keep the normal router mount below as well so every other Recruitment
# endpoint (/stats, /{candidate_id}, etc.) remains available unchanged.
app.add_api_route(
    "/api/recruitment",
    recruitment_list_candidates,
    methods=["GET"],
    include_in_schema=False,
)
app.add_api_route(
    "/api/recruitment/",
    recruitment_list_candidates,
    methods=["GET"],
    include_in_schema=False,
)

app.include_router(
    recruitment_router,
    prefix="/api",
    include_in_schema=False,
)

# ── Phase 12 Commercial SaaS API v2 Router ────────────────────────────────────
from backend.api_v2.router_v2 import router as api_v2_router
app.include_router(api_v2_router, prefix="/api")

# ── Phase 11 AI-driven automation endpoints router ───────────────────────────
from backend.ai.ai_router import router as ai_router_router
app.include_router(ai_router_router, prefix="/api")

# ── ADMS machine root-level routes ───────────────────────────────────────────
# ZKTeco / Identix machines configured in ADMS Cloud mode push to these URLs.
# Machine firmware appends these paths to the Server Address automatically:
#   GET/POST  https://api.taskosphere.com/iclock/cdata
#   GET/POST  https://api.taskosphere.com/iclock/getrequest
#   GET/POST  https://api.taskosphere.com/iclock/devicecmd
#
# IMPORTANT: These routes must be at ROOT level — NOT under /api/identix/...
# No auth middleware. No CORS required. Always return plain text "OK".
app.include_router(
    qc_trademark_router, prefix="/api/trademark-qc", tags=["trademark-qc"]
)
from backend.attendance_identix import iclock_getrequest, iclock_cdata, iclock_devicecmd

# Support BOTH ADMS firmware URL conventions.
#
# Some Identix/ZKTeco firmware versions append the legacy ".aspx" suffix
# automatically (for example /iclock/cdata.aspx), while other firmware sends
# the modern extensionless paths (/iclock/cdata).  The device in production
# has been observed using /iclock/cdata.aspx, so both forms must hit the exact
# same handlers.  Do NOT redirect these requests: ADMS firmware may not follow
# redirects and a redirect would prevent the heartbeat from being recorded.
for _path, _handler in (
    ("/iclock/cdata", iclock_cdata),
    ("/iclock/getrequest", iclock_getrequest),
    ("/iclock/devicecmd", iclock_devicecmd),
):
    app.add_api_route(_path, _handler, methods=["GET", "POST"])
    app.add_api_route(f"{_path}.aspx", _handler, methods=["GET", "POST"])
app.include_router(whatsapp_hub_router, prefix="/api")


# ═══════════════════════════════════════════════════════════════════════════════
# ROUTE SAFETY NET — collection endpoints must answer with AND without a
# trailing slash.
#
# The app runs with redirect_slashes=False, so Starlette will NOT redirect
# "/api/notifications/" -> "/api/notifications" (or vice-versa); a one-character
# difference produced hard 404s on list endpoints such as /api/notifications,
# /api/visits and /api/leads while their sibling routes (e.g.
# /api/notifications/unread-count) kept working.
#
# This block runs once, after every router is mounted, and registers the
# missing slash-variant of each already-registered /api route so the two forms
# are always equivalent. It never overwrites an existing route.
#
# _iter_api_routes() walks recursively rather than reading target_app.routes
# as a flat list: some FastAPI/Starlette versions store a sub-router included
# via app.include_router(sub_router) as its own wrapper object (with the
# individual APIRoutes nested one level down inside it) rather than flattening
# them onto the parent immediately. A flat, non-recursive scan silently sees
# zero matching routes in that case — the safety net would report "0 aliases
# registered" and do nothing, with no error, while every bare "/api/x" route
# quietly stops answering to "/api/x/" (this exact failure mode is what
# broke /api/quotations and /api/companies — see git history for the
# incident). Walking recursively makes the aliasing correct regardless of how
# a given FastAPI/Starlette version happens to store included routers.
# ═══════════════════════════════════════════════════════════════════════════════
def _iter_api_routes(routes):
    from fastapi.routing import APIRoute

    seen = set()
    for r in routes:
        if isinstance(r, APIRoute) and id(r) not in seen:
            seen.add(id(r))
            yield r
        # Recurse into anything that itself exposes a `.routes` list — this
        # covers both a plain Starlette Router/Mount and FastAPI's internal
        # "included router" wrapper, whatever it happens to be called in the
        # installed version.
        sub_routes = getattr(r, "routes", None)
        if sub_routes:
            yield from _iter_api_routes(sub_routes)


def _register_slash_variants(target_app) -> None:
    all_routes = list(_iter_api_routes(target_app.routes))
    existing = {(r.path, m) for r in all_routes for m in r.methods}
    aliases = []
    for route in all_routes:
        if not route.path.startswith("/api"):
            continue
        if "{" in route.path:          # never alias parameterised paths
            continue
        variant = route.path[:-1] if route.path.endswith("/") else route.path + "/"
        if variant in ("", "/api"):
            continue
        if any((variant, m) in existing for m in route.methods):
            continue
        aliases.append((route, variant))

    for route, variant in aliases:
        target_app.add_api_route(
            variant,
            route.endpoint,
            methods=list(route.methods),
            response_model=route.response_model,
            status_code=route.status_code,
            dependencies=route.dependencies,
            name=route.name,
            include_in_schema=False,
        )
        for m in route.methods:
            existing.add((variant, m))

    logger.info(f"[routes] slash-variant aliases registered: {len(aliases)}")

    # Loud, specific self-check for the collection endpoints that have broken
    # this way before — if this ever logs a warning again, it means the
    # aliasing above found nothing to do for these paths and they need
    # investigating immediately, not silently.
    critical = ["/api/quotations", "/api/companies"]
    final_paths = {r.path for r in _iter_api_routes(target_app.routes)}
    for base in critical:
        missing = [p for p in (base, base + "/") if p not in final_paths]
        if missing:
            logger.warning(f"[routes] SAFETY NET GAP: {missing} not registered — "
                            f"this endpoint will 404 for some clients")


_register_slash_variants(app)


@app.get("/api/__routes", include_in_schema=False)
async def _debug_list_routes():
    """Quick self-check: confirms which /api paths this process actually serves."""
    return sorted(
        {r.path for r in _iter_api_routes(app.routes) if r.path.startswith("/api")}
    )
