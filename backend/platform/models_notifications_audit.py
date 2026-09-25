"""Canonical platform notification and audit Pydantic models."""
from typing import Optional, Any
import uuid
from pydantic import BaseModel, ConfigDict, Field

# NOTIFICATIONS & AUDIT
# ======================
class NotificationBase(BaseModel):
    title: str
    message: str
    type: str


class Notification(NotificationBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    is_read: bool = False
    created_at: Optional[Any] = None


class AuditLog(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    user_name: str
    action: str
    module: str
    record_id: Optional[str] = None
    old_data: Optional[dict] = None
    new_data: Optional[dict] = None
    timestamp: Optional[Any] = None


# ======================
