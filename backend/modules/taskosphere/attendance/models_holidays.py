"""Canonical holiday Pydantic models extracted from the legacy model module."""
from typing import Optional, Any
from pydantic import BaseModel

# ======================
# HOLIDAY MODELS
# ======================
class HolidayCreate(BaseModel):
    date: Any
    name: str
    description: Optional[str] = None
    type: str = "manual"
    status: Optional[str] = "confirmed"


class HolidayResponse(BaseModel):
    date: Any
    name: str
    description: Optional[str] = None
    status: str = "confirmed"
    type: Optional[str] = "manual"
