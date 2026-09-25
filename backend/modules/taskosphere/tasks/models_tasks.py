"""Canonical Taskosphere task Pydantic models."""
from typing import Optional, Any, List
import uuid
from pydantic import BaseModel, ConfigDict, Field

class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None
    assigned_to: Optional[str] = None
    sub_assignees: List[str] = Field(default_factory=list)
    due_date: Optional[Any] = None
    priority: str = "medium"
    status: str = "pending"
    category: str = "other"          # legacy single-value (kept for backward compat)
    categories: List[str] = Field(default_factory=list)  # multi-department support
    client_id: Optional[str] = None
    is_recurring: bool = False
    recurrence_pattern: Optional[str] = "monthly"
    recurrence_interval: Optional[int] = 1
    recurrence_end_date: Optional[Any] = None
    type: Optional[str] = None
    # Per-task popup cadence override (minutes). None = use universal default.
    popup_interval_minutes: Optional[int] = None


class TaskCreate(TaskBase):
    pass


class BulkTaskCreate(BaseModel):
    tasks: List[TaskCreate]


class Task(TaskBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None
    updated_at: Optional[Any] = None
    completed_at: Optional[Any] = None
    parent_task_id: Optional[str] = None
