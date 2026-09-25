"""Finix domain models extracted from backend/gst_reconciliation.py."""
from datetime import date, datetime
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

class ReconciliationSession(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str; period: Optional[str]=None; portal_filename: str; books_filename: str
    created_at: datetime; created_by: str; created_by_name: Optional[str]=None
    summary: Dict[str,Any]=Field(default_factory=dict)

class SessionSaveBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period: Optional[str]=None; client_id: Optional[str]=None
    client_name: Optional[str]=None; client_gstin: Optional[str]=None
    portal_filename: str=""; books_filename: str=""
    summary: Dict[str,Any]=Field(default_factory=dict)
    full_result: Optional[Dict[str,Any]]=None
    company: Optional[Dict[str,Any]]=None

class GSTR3BBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period: Optional[str]=None; client_id: Optional[str]=None; client_name: Optional[str]=None
    gstr3b_igst: float=0.0; gstr3b_cgst: float=0.0; gstr3b_sgst: float=0.0
    gstr2b_igst: float=0.0; gstr2b_cgst: float=0.0; gstr2b_sgst: float=0.0

class ITCReversalBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    period: str; reversal_reason: str; client_id: Optional[str]=None; notes: Optional[str]=None
    igst_reversed: float=0.0; cgst_reversed: float=0.0; sgst_reversed: float=0.0

class VendorCommunicationBody(BaseModel):
    model_config = ConfigDict(extra="ignore")
    gstin: str; trade_name: Optional[str]=None
    issues: List[str]=Field(default_factory=list); period: Optional[str]=None


class GSTINBatchBody(BaseModel):
    gstins: List[str] = Field(default_factory=list)

class TradeNameBody(BaseModel):
    gstin: str
    name: str

class TradeNamesBatchBody(BaseModel):
    names: Dict[str, str] = Field(default_factory=dict)

class SessionUpdateBody(BaseModel):
    period: Optional[str] = None
    client_id: Optional[str] = None
    client_name: Optional[str] = None
    client_gstin: Optional[str] = None
    company: Optional[Dict[str, Any]] = None
    portal_filename: Optional[str] = None
    books_filename: Optional[str] = None
    summary: Optional[Dict[str, Any]] = None
    full_result: Optional[Dict[str, Any]] = None

class AIInsightBody(BaseModel):
    period: Optional[str] = None
    summary: Dict[str, Any] = Field(default_factory=dict)
    mismatch_count: int = 0
    mismatch_value: float = 0.0
    portal_only_count: int = 0
    portal_only_value: float = 0.0
    books_only_count: int = 0
    books_only_value: float = 0.0
    high_risk_vendors: int = 0
    itc_eligible_total: float = 0.0
    itc_at_risk_total: float = 0.0
    top_mismatches: List[Dict[str, Any]] = Field(default_factory=list)
