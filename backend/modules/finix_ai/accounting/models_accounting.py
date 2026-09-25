"""Finix domain models extracted from backend/accounting_core.py."""
from datetime import date
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

class AccountCreate(BaseModel):
    company_id: str = ""
    code: str
    name: str
    type: str  # asset | liability | equity | income | expense
    sub_type: str = ""

class JournalLine(BaseModel):
    account_id: str
    account_name: str = ""
    debit: float = 0.0
    credit: float = 0.0
    memo: str = ""

class JournalEntryCreate(BaseModel):
    company_id: str = ""
    entry_date: str = Field(default_factory=lambda: date.today().isoformat())
    narration: str = ""
    source: str = "manual"          # manual | purchase | sale | bank
    source_id: Optional[str] = None
    lines: List[JournalLine]


# ── Chart of Accounts routes ─────────────────────────────────────────────

