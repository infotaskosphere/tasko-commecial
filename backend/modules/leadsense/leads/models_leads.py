"""Canonical LeadSense lead Pydantic models."""
from typing import Optional, Any, List
import uuid
from pydantic import BaseModel, ConfigDict, Field, EmailStr

    company_name: str
    contact_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    services: List[str] = Field(default_factory=list)
    status: str = "new"
    source: Optional[str] = None
    notes: Optional[str] = None
    assigned_to: Optional[str] = None
    referred_by: Optional[str] = None


class LeadCreate(LeadBase):
    pass


class Lead(LeadBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None
