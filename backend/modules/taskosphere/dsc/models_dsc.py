"""Canonical Taskosphere DSC Pydantic models."""
from typing import Optional, Any, List
import uuid
from pydantic import BaseModel, ConfigDict, Field

class DSCBase(BaseModel):
    holder_name: str
    dsc_type: Optional[str] = None
    dsc_password: Optional[str] = None
    serial_number: Optional[str] = None
    associated_with: Optional[str] = None
    entity_type: str = "firm"
    issue_date: Any
    expiry_date: Any
    notes: Optional[str] = None
    current_status: str = "IN"
    current_location: str = "with_company"
    taken_by: Optional[str] = None
    taken_date: Optional[Any] = None
    movement_log: List[Any] = Field(default_factory=list)


class DSCCreate(DSCBase):
    pass


class DSC(DSCBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None


class DSCMovement(BaseModel):
    movement_type: str
    person_name: str
    timestamp: Optional[Any] = None
    notes: Optional[str] = None


class DSCListResponse(BaseModel):
    data: List[DSC]
    total: int
    page: int
    limit: int


class DSCMovementRequest(BaseModel):
    movement_type: str
    person_name: str
    notes: Optional[str] = None


class MovementUpdateRequest(BaseModel):
    movement_type: str
    person_name: Optional[str] = None
    notes: Optional[str] = None
