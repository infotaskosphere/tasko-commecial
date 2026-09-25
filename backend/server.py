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
from backend.ai.aiweave_router import router as aiweave_router, create_aiweave_indexes
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
from backend.server_modules.lifecycle import register_shutdown_handler
from backend.server_modules.holiday_jobs import fetch_indian_holidays_task, configure_event_loop as configure_holiday_event_loop
from backend.server_modules.attendance_jobs import _mark_absent_for_date, mark_absent_users_task, _force_punch_out_at_7pm, force_punch_out_11pm_task, configure_event_loop as configure_attendance_event_loop
from backend.server_modules.helpers import safe_dt, sanitize_user_data, convert_objectids, is_own_record, create_audit_log, _expected_hours_pure, calculate_expected_hours
from backend.server_modules.task_analytics import get_task_analytics as _get_task_analytics
from backend.server_modules.website_activity import register_website_activity
from backend.server_modules.task_popup import create_task_assigned_popup
from backend.server_modules.scheduler_jobs import register_scheduler_jobs
from backend.server_modules.startup_indexes import initialize_startup_indexes
from backend.server_modules.startup_bootstrap import start_bootstrap_tasks
from backend.server_modules.startup_orchestrator import run_startup_orchestration
from backend.server_modules.email_service_routes import register_email_service_routes
from backend.server_modules.task_duplicate_detection import register_task_duplicate_detection
from backend.server_modules.auth_routes import register_auth_routes
from backend.server_modules.users_todos_admin import register_users_todos_admin
from backend.server_modules.attendance_routes import register_attendance_routes
from backend.server_modules.salary_reports import register_salary_reports
from backend.server_modules.task_routes import register_task_routes
from backend.server_modules.dsc_routes import register_dsc_routes
from backend.server_modules.document_routes import register_document_routes
from backend.server_modules.compliance_due_dates import register_compliance_due_dates
from backend.server_modules.reporting_and_master import register_reporting_and_master
from backend.server_modules.client_import_parsing import register_client_import_parsing
from backend.server_modules.client_management import register_client_management
from backend.server_modules.dashboard_ops import register_dashboard_ops
from backend.server_modules.holiday_trademark_misc import register_holiday_trademark_misc

app = FastAPI(title="Taskosphere Backend", redirect_slashes=False)
api_router = APIRouter(prefix="/api")
register_shutdown_handler(app, scheduler)

_PHASE2_ROUTE_MODULES = [
    register_email_service_routes,
    register_task_duplicate_detection,
    register_auth_routes,
    register_users_todos_admin,
    register_attendance_routes,
    register_salary_reports,
    register_task_routes,
    register_dsc_routes,
    register_document_routes,
    register_compliance_due_dates,
    register_reporting_and_master,
    register_client_import_parsing,
    register_client_management,
    register_dashboard_ops,
    register_holiday_trademark_misc,
    register_website_activity,
]

for _register_phase2_routes in _PHASE2_ROUTE_MODULES:
    _register_phase2_routes(globals())

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






async def startup_event():
    await run_startup_orchestration(
        server_module=__import__("backend.server", fromlist=["*"]),
        db=db,
        configure_holiday_event_loop=configure_holiday_event_loop,
        configure_attendance_event_loop=configure_attendance_event_loop,
        initialize_startup_indexes=initialize_startup_indexes,
        register_scheduler_jobs=register_scheduler_jobs,
        start_bootstrap_tasks=start_bootstrap_tasks,
        scheduler=scheduler,
        startup_dependencies={
            "index_factories": {
                "create_compliance_indexes": create_compliance_indexes,
                "create_salary_slip_indexes": create_salary_slip_indexes,
                "create_gst_reconciliation_indexes": create_gst_reconciliation_indexes,
                "create_zte_indexes": create_zte_indexes,
                "create_aiweave_indexes": create_aiweave_indexes,
                "create_gst_portal_sync_indexes": create_gst_portal_sync_indexes,
                "create_accounting_integrity_indexes": create_accounting_integrity_indexes,
                "create_accounting_extended_indexes": create_accounting_extended_indexes,
                "create_desktop_indexes": create_desktop_indexes,
            },
            "scheduler_jobs": {
                "fetch_indian_holidays_task": fetch_indian_holidays_task,
                "mark_absent_users_task": mark_absent_users_task,
                "force_punch_out_11pm_task": force_punch_out_11pm_task,
                "birthday_automation_job": birthday_automation_job,
                "festival_greeting_job": festival_greeting_job,
                "service_expiry_alert_job": service_expiry_alert_job,
                "follow_up_reminder_job": follow_up_reminder_job,
                "wa_dsc_expiry_job": wa_dsc_expiry_job,
                "wa_compliance_job": wa_compliance_job,
                "wa_scheduled_bulk_job": wa_scheduled_bulk_job,
                "wa_bridge_keepalive_job": wa_bridge_keepalive_job,
            },
        },
    )



# ====================== HEALTH ======================
# BUILD_MARKER — bump this string on every deploy-verification change.
# If a request to /health ever shows a DIFFERENT marker than the one you
# just committed, the browser/CDN/Render is NOT serving this exact commit —
# stop looking for a code bug and go fix the deploy instead.
BUILD_MARKER = "session-guard-signature-fix-2026-09-09"


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







# =====================================================================================
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


# DASHBOARD ROUTES
# ============================================


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


async def universal_exception_handler(request: Request, exc: Exception):
    logger.error(f"Critical Error on {request.url.path}: {str(exc)}")
    logger.error(traceback.format_exc())
    # Echo back the request origin when it's a known safe origin. Reuse the
    # same allow-list/regex the CORSMiddleware itself uses (CORS_ALLOWED_ORIGINS,
    # CORS_ORIGIN_REGEX) rather than a separate hardcoded list — otherwise a
    # real 500 on any origin missing from that second list (e.g. the Vercel
    # frontend) gets reported to the browser as a misleading CORS error
    # instead of surfacing the actual server error.
    import re as _re

    origin = request.headers.get("origin", "")
    is_allowed = (origin in CORS_ALLOWED_ORIGINS) or bool(
        _re.match(CORS_ORIGIN_REGEX, origin)
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
app.include_router(aiweave_router, prefix="/api")
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