"""Canonical Records document Pydantic models."""
from typing import Optional, Any, List
from datetime import datetime, date
import uuid
from pydantic import BaseModel, ConfigDict, Field, field_validator

class DocumentBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    document_name: Optional[str] = None
    document_type: Optional[str] = None
    document_password: Optional[str] = None
    holder_name: Optional[str] = None
    associated_with: Optional[str] = None
    entity_type: str = "firm"
    issue_date: Optional[Any] = None
    valid_upto: Optional[Any] = None
    notes: Optional[str] = None
    current_status: str = "IN"
    current_location: str = "with_company"
    movement_log: List[Any] = Field(default_factory=list)

    @field_validator("issue_date", "valid_upto", mode="before")
    @classmethod
    def coerce_date_fields(cls, v: Any) -> Any:
        if v is None or v == "" or v == "null":
            return None
        if isinstance(v, (datetime, date)):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return v


class DocumentCreate(DocumentBase):
    pass


class Document(DocumentBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None

    @field_validator("created_at", mode="before")
    @classmethod
    def coerce_created_at(cls, v: Any) -> Any:
        if v is None or v == "":
            return None
        if isinstance(v, datetime):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return v


class DocumentMovement(BaseModel):
    movement_type: str
    person_name: str
    timestamp: Optional[Any] = None
    notes: Optional[str] = None


class DocumentMovementRequest(BaseModel):
    movement_type: str
    person_name: str
    notes: Optional[str] = None


class DocumentMovementUpdateRequest(BaseModel):
    movement_id: str
    movement_type: str
    person_name: Optional[str] = None
    notes: Optional[str] = None
