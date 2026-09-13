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
from backend.backup_restore import router as backup_restore_router
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
    get_user_permissions,
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
    "https://taskosphere.com",
    "https://www.taskosphere.com",
    "https://tasko-commercial-frontend.vercel.app",
    "https://final-taskosphere-frontend.onrender.com",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
]

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
