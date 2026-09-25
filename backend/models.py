import uuid
import re
from datetime import datetime, date, timedelta, timezone
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, model_validator, Field, ConfigDict, EmailStr, field_validator
from enum import Enum

# Timezone Configuration
india_tz = timezone(timedelta(hours=5, minutes=30))

# ────────────────────────────────────────────────
# PEOPLE MATRIX USER / PERMISSION MODELS
from backend.modules.people_matrix.models_users import (
    UserRole,
    DEFAULT_ROLE_PERMISSIONS,
    UserPermissions,
    User,
    UserCreate,
    UserUpdate,
    UserLogin,
    Token,
)

# ======================
# TODOS & TASKS
# ======================
from backend.modules.taskosphere.tasks.models_todos import Todo, TodoCreate

from backend.modules.taskosphere.tasks.models_tasks import TaskBase, TaskCreate, BulkTaskCreate, Task

# ======================
# ATTENDANCE
# ======================
# ======================
# ATTENDANCE
# ======================
from backend.modules.taskosphere.attendance.models_attendance import (
    AttendanceProof,
    Attendance,
    AttendanceBase,
    AttendanceCreate,
    StaffActivityCreate,
    StaffActivityLog,
    ActivityLog,
    ActivityLogUpdate,
)

# ======================
# REMINDER MODELS
# ======================
from backend.modules.taskosphere.tasks.models_reminders import ReminderCreate, Reminder

# ======================
# DOCUMENT MANAGEMENT
# ======================
# ======================
# DOCUMENT MANAGEMENT
# ======================
# ======================
# DOCUMENT MANAGEMENT
# ======================
from backend.modules.records.documents.models_documents import (
    DocumentBase,
    DocumentCreate,
    Document,
    DocumentMovement,
    DocumentMovementRequest,
    DocumentMovementUpdateRequest,
)

# ======================
# CLIENT MANAGEMENT
# ======================
# ======================
# CLIENT MANAGEMENT
# ======================
# ======================
# CLIENT MANAGEMENT
# ======================
from backend.modules.taskosphere.clients.models_clients import (
    ContactPerson,
    ClientDSC,
    ClientBase,
    ClientCreate,
    Client,
    MasterClientForm,
)

# ======================
# LEADS MODEL
# ======================
# ======================
# LEADS MODEL
# ======================
from backend.modules.leadsense.leads.models_leads import LeadBase, LeadCreate, Lead

# ======================
# DUE DATE MODELS
# ======================
# ======================
# DUE DATES & REMINDERS
# ======================
from backend.modules.compligenie.due_dates.models_due_dates import DueDateBase, DueDateCreate, DueDate

from backend.platform.models_birthday import BirthdayEmailRequest


# ======================
# ======================
# NOTIFICATIONS & AUDIT
# ======================
from backend.platform.models_notifications_audit import NotificationBase, Notification, AuditLog

# ======================
# ======================
# DASHBOARD & METRICS
# ======================
from backend.modules.taskosphere.dashboard.models_dashboard import DashboardStats, PerformanceMetric

# ======================
# HOLIDAY MODELS
# ======================
# HOLIDAY MODELS
# ======================
from backend.modules.taskosphere.attendance.models_holidays import HolidayCreate, HolidayResponse

# ======================
# DSC MANAGEMENT
# ======================
from backend.modules.taskosphere.dsc.models_dsc import (
    DSCBase,
    DSCCreate,
    DSC,
    DSCMovement,
    DSCListResponse,
    DSCMovementRequest,
    MovementUpdateRequest,
)

# ======================
# ======================
# EMAIL INTEGRATION MODELS
# ======================
from backend.platform.models_email import EmailConnection, ExtractedEvent

# ======================
# ======================
# PASSWORD REPOSITORY MODELS
# ======================
from backend.modules.records.passwords.models_passwords import (
    PORTAL_TYPES_LIST,
    PasswordEntryCreate,
    PasswordEntryUpdate,
    PasswordEntry,
    PasswordRevealResponse,
)

# ────────────────────────────────────────────────
# OFFBOARDING REQUEST
# ────────────────────────────────────────────────
from backend.modules.people_matrix.models_offboarding import OffboardRequest

