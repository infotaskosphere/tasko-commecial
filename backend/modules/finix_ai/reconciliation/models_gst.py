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
