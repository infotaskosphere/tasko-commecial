"""Taskosphere todo models extracted from the legacy compatibility module."""
from datetime import datetime, timezone
from typing import Optional, Any
import uuid
from pydantic import BaseModel, ConfigDict, Field

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
    source: Optional[str] = "manual"
    auto_imported: Optional[bool] = False
