"""Canonical platform email integration Pydantic models."""
from typing import Optional
from pydantic import BaseModel, ConfigDict

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
