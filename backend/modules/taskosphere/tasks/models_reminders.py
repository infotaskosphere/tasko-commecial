"""Canonical Taskosphere reminder Pydantic models."""
from typing import Optional, Any
import uuid
from pydantic import BaseModel, ConfigDict, Field

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
# REMINDER MODELS
# ======================
# ======================
# REMINDER MODELS
# ======================
class ReminderCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    description: Optional[str] = None
    remind_at: Any
    event_id: Optional[str] = None
    source: Optional[str] = "manual"
    priority: Optional[str] = "medium"
    reminder_type: Optional[str] = "reminder"
    related_task_id: Optional[str] = None
    # Per-reminder popup cadence override (minutes). None = universal default.
    popup_interval_minutes: Optional[int] = None


class Reminder(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    title: str
    description: Optional[str] = None
    remind_at: Any
    event_id: Optional[str] = None
    source: Optional[str] = "manual"
    priority: Optional[str] = "medium"
    reminder_type: Optional[str] = "reminder"
    related_task_id: Optional[str] = None
    is_dismissed: bool = False
    is_fired: bool = False
    status: Optional[str] = None
    popup_interval_minutes: Optional[int] = None
    created_at: Optional[Any] = None
    updated_at: Optional[Any] = None
