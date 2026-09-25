"""Canonical platform password repository Pydantic models."""
from typing import Optional, List
from pydantic import BaseModel, Field, ConfigDict

# PASSWORD REPOSITORY MODELS
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
