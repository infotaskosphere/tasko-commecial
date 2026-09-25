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
# ======================
# TODOS & TASKS
# ======================
class Todo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    title: str
    description: Optional[str] = None
    is_completed: bool = False
    status: str = "pending"
    due_date: Optional[Any] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[Any] = None


class TodoCreate(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[datetime] = None
    is_completed: bool = False
    status: str = "pending"
    source: Optional[str] = "manual"      # 'manual' | 'email_sync' | 'auto'
    auto_imported: Optional[bool] = False


class TaskBase_import_marker(BaseModel):
    """Compatibility marker; task models are re-exported below."""
    pass

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

class BirthdayEmailRequest(BaseModel):

    client_id: str


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
# EMAIL INTEGRATION MODELS
# ======================
class EmailConnection(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    provider: str
    method: str
    email_address: Optional[str] = None
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    expires_at: Optional[str] = None
    app_password_enc: Optional[str] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    connected_at: Optional[str] = None


class ExtractedEvent(BaseModel):
    title: str
    event_type: str
    date: Optional[str] = None
    time: Optional[str] = None
    location: Optional[str] = None
    organizer: Optional[str] = None
    description: Optional[str] = None
    urgency: str = "medium"
    source_subject: str
    source_from: str
    source_date: str
    raw_snippet: Optional[str] = None


# ======================
# PASSWORD REPOSITORY MODELS
# ======================

PORTAL_TYPES_LIST = [
    "MCA", "DGFT", "TRADEMARK", "GST", "INCOME_TAX", "TDS",
    "EPFO", "ESIC", "TRACES", "MSME", "RERA", "ROC", "OTHER",
]


class PasswordEntryCreate(BaseModel):
    """Payload to create a new portal credential entry."""
    portal_name: str = Field(..., min_length=2, max_length=120)
    portal_type: str = "OTHER"
    url: Optional[str] = None
    username: Optional[str] = None
    password_plain: Optional[str] = None   # plain text — backend encrypts
    department: str = "OTHER"
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class PasswordEntryUpdate(BaseModel):
    portal_name: Optional[str] = None
    portal_type: Optional[str] = None
    url: Optional[str] = None
    username: Optional[str] = None
    password_plain: Optional[str] = None
    department: Optional[str] = None
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[List[str]] = None


class PasswordEntry(BaseModel):
    """Public-facing model — never includes the encrypted password field."""
    model_config = ConfigDict(extra="ignore")
    id: str
    portal_name: str
    portal_type: str
    url: Optional[str] = None
    username: Optional[str] = None
    department: str
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None
    tags: List[str] = []
    created_by: str
    created_by_name: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    last_accessed_at: Optional[str] = None
    has_password: bool = False


class PasswordRevealResponse(BaseModel):
    id: str
    username: Optional[str]
    password: str
    portal_name: str


# ────────────────────────────────────────────────
# OFFBOARDING REQUEST
# ────────────────────────────────────────────────
class OffboardRequest(BaseModel):
    replacement_user_id: str
    transfer_tasks: bool = True
    transfer_clients: bool = True
    transfer_dsc: bool = True
    transfer_documents: bool = True
    transfer_todos: bool = True
    transfer_visits: bool = True
    transfer_leads: bool = True
    update_email: Optional[str] = None
    delete_old_user: bool = True
    notes: Optional[str] = None
