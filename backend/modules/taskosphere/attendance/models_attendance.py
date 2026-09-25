"""Canonical Taskosphere attendance and staff-activity models."""
from typing import Optional, Any, List, Dict
import uuid
from pydantic import BaseModel, ConfigDict, Field, field_validator

class AttendanceProof(BaseModel):
    """
    Embedded proof document stored inside an attendance record.
    All fields are optional — any combination of note / photos / documents is valid.
    """
    model_config = ConfigDict(extra="ignore")
    note: Optional[str] = None
    photos: List[str] = Field(default_factory=list)
    documents: List[str] = Field(default_factory=list)
    uploaded_at: Optional[str] = None
    updated_at: Optional[str] = None


class Attendance(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    date: str
    status: str = "absent"
    punch_in: Optional[Any] = None
    punch_out: Optional[Any] = None
    duration_minutes: Optional[int] = 0
    leave_reason: Optional[str] = None
    is_late: bool = False
    punched_out_early: bool = False
    auto_marked: Optional[bool] = False
    auto_punch_out: Optional[bool] = False
    auto_punch_reason: Optional[str] = None
    proof: Optional[AttendanceProof] = None
    overtime_minutes: Optional[int] = 0

    @field_validator("status", mode="before")
    @classmethod
    def normalise_status(cls, v: Any) -> str:
        if v is None or v == "":
            return "absent"
        return str(v)

    @field_validator("duration_minutes", "overtime_minutes", mode="before")
    @classmethod
    def coerce_duration(cls, v: Any) -> int:
        if v is None:
            return 0
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    @field_validator("is_late", "punched_out_early", "auto_marked", "auto_punch_out", mode="before")
    @classmethod
    def coerce_bool(cls, v: Any) -> bool:
        if v is None:
            return False
        if isinstance(v, bool):
            return v
        return bool(v)


class AttendanceBase(BaseModel):
    punch_in: Any
    punch_out: Optional[Any] = None


class AttendanceCreate(BaseModel):
    action: str


# ======================
# STAFF ACTIVITY
# ======================
class StaffActivityCreate(BaseModel):
    app_name: str = "Taskosphere Web"
    window_title: Optional[str] = None
    url: Optional[str] = None
    website: Optional[str] = None
    category: str = "productivity"
    duration_seconds: int = 0
    idle: Optional[bool] = False
    activity_type: str = "active_time"
    description: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class StaffActivityLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    activity_type: str = "active_time"
    app_name: str = "Taskosphere Web"
    window_title: Optional[str] = None
    url: Optional[str] = None
    category: str = "other"
    duration_seconds: int = 0
    timestamp: Optional[Any] = None
    metadata: Optional[Dict[str, Any]] = None


class ActivityLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    date: str
    screen_time_minutes: int = 0
    tasks_completed: int = 0


class ActivityLogUpdate(BaseModel):
    screen_time_minutes: Optional[int] = None
    tasks_completed: Optional[int] = None
