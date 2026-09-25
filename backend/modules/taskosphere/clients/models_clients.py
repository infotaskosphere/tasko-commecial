"""Canonical Taskosphere client/master-client Pydantic models."""
from typing import Optional, Any, List, Dict
import re
import uuid
from pydantic import BaseModel, ConfigDict, Field, EmailStr, model_validator, field_validator

class ContactPerson(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    designation: Optional[str] = None
    birthday: Optional[Any] = None
    din: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def clean_empty_contact_fields(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nullable = ["email", "phone", "designation", "birthday", "din"]
            for field in nullable:
                if field in data and data[field] == "":
                    data[field] = None
        return data


class ClientDSC(BaseModel):
    certificate_number: Optional[str] = None
    holder_name: Optional[str] = None
    issue_date: Optional[Any] = None
    expiry_date: Optional[Any] = None
    notes: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def clean_empty_dsc_fields(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for field in ["certificate_number", "holder_name", "issue_date", "expiry_date", "notes"]:
                if field in data and data[field] == "":
                    data[field] = None
        return data


class ClientBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    company_name: str = Field(..., min_length=3, max_length=255)
    client_type: str = Field(..., pattern="^(proprietor|pvt_ltd|llp|partnership|huf|trust|other|LLP|PVT_LTD|public_ltd|section_8)$")
    client_type_label: Optional[str] = None
    contact_persons: List[ContactPerson] = Field(default_factory=list)
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    date_of_incorporation: Optional[Any] = None
    birthday: Optional[Any] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None  # Primary address PIN — auto-derives `state` (see backend/pincode_lookup.py)
    status: Optional[str] = "active"
    services: List[str] = Field(default_factory=list)
    dsc_details: List[ClientDSC] = Field(default_factory=list)
    assigned_to: Optional[str] = None
    notes: Optional[str] = None
    referred_by: Optional[str] = None
    assignments: Optional[List[Dict[str, Any]]] = Field(
        default_factory=list,
        description="List of {user_id, services} assignments"
    )
    # ── Tax & Billing fields (populated from GST certificate or manual entry) ──
    gstin: Optional[str] = None
    pan: Optional[str] = None
    gst_treatment: Optional[str] = None
    place_of_supply: Optional[str] = None
    default_payment_terms: Optional[str] = None
    credit_limit: Optional[Any] = None
    opening_balance: Optional[Any] = None
    opening_balance_type: Optional[str] = None
    tally_ledger_name: Optional[str] = None
    tally_group: Optional[str] = None
    website: Optional[str] = None
    msme_number: Optional[str] = None
    # ── Address fields: primary + GST certificate address (may differ) ─────────
    gst_address: Optional[str] = None   # Principal place of business from GST REG-06
    gst_city: Optional[str] = None
    gst_state: Optional[str] = None
    gst_pin: Optional[str] = None
    # ── MCA / ROC fields (fetched from MCA portal API or parsed from MCA PDF) ──
    cin: Optional[str] = None           # Corporate Identity Number (Pvt/Public Ltd/Section 8)
    llpin: Optional[str] = None         # LLP Identification Number
    proprietor_name: Optional[str] = None  # Proprietor's full name (Proprietor client type)
    mca_fetch_date: Optional[str] = None  # ISO date when MCA data was last fetched
    # Extended MCA Company Master Data
    mca_registration_number: Optional[str] = None
    mca_roc_name: Optional[str] = None
    mca_rd_name: Optional[str] = None
    mca_company_category: Optional[str] = None
    mca_company_subcategory: Optional[str] = None
    mca_listed: Optional[bool] = None
    mca_active_compliance: Optional[str] = None
    mca_authorized_capital: Optional[Any] = None
    mca_paid_up_capital: Optional[Any] = None
    mca_last_agm_date: Optional[str] = None
    mca_balance_sheet_date: Optional[str] = None
    mca_books_address: Optional[str] = None
    mca_charges: List[Dict[str, Any]] = Field(default_factory=list)
    mca_loan_details: List[Dict[str, Any]] = Field(default_factory=list)
    # ── ITR Client fields ──────────────────────────────────────────────────────
    is_itr_client: Optional[bool] = False   # True when this client is an ITR-only client
    itr_data: Optional[Dict[str, Any]] = None  # JSON blob: itr_type, AY, filing_status, income, etc.

    @model_validator(mode="before")
    @classmethod
    def clean_empty_optional_strings(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nullable_fields = [
                "email", "phone", "referred_by", "notes", "assigned_to",
                "birthday", "date_of_incorporation", "client_type_label",
                "address", "city", "state", "pincode",
                "gstin", "pan", "gst_treatment", "place_of_supply",
                "tally_ledger_name", "tally_group", "website", "msme_number",
                "gst_address", "gst_city", "gst_state", "gst_pin",
                "cin", "llpin", "proprietor_name", "mca_fetch_date",
                "mca_registration_number", "mca_roc_name", "mca_rd_name",
                "mca_company_category", "mca_company_subcategory", "mca_active_compliance",
                "mca_last_agm_date", "mca_balance_sheet_date", "mca_books_address",
            ]
            for field in nullable_fields:
                if field in data and data[field] == "":
                    data[field] = None
        return data

    @field_validator("phone", mode="before")
    @classmethod
    def validate_phone(cls, v) -> Optional[str]:
        if v is None or str(v).strip() == "":
            return None
        cleaned = re.sub(r"\s|-|\+", "", str(v))
        if not cleaned.isdigit():
            raise ValueError("Phone number must contain only digits")
        if not (10 <= len(cleaned) <= 15):
            raise ValueError("Phone number must be 10-15 digits")
        return v

    @field_validator("company_name")
    @classmethod
    def validate_company_name(cls, v: str) -> str:
        v = str(v).strip()
        if len(v) < 3:
            raise ValueError("Company name must be at least 3 characters long")
        return v


class ClientCreate(ClientBase):
    pass


class Client(ClientBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None
    # ── Client approval workflow ─────────────────────────────────────────
    # Any user may add a client, but a client created by a non-admin stays
    # "pending" until an admin (or a user with can_approve_clients) approves
    # it. Pending clients are only visible to their creator and approvers.
    approval_status: str = "approved"          # approved | pending | rejected
    approved_by: Optional[str] = None
    approved_at: Optional[Any] = None
    rejection_reason: Optional[str] = None


class MasterClientForm(BaseModel):
    company_name: str
    client_type: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    date_of_incorporation: Optional[Any] = None
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None
    tan_number: Optional[str] = None
    assigned_to: Optional[str] = None
    services: List[str] = Field(default_factory=list)
    contact_persons: List[Any] = Field(default_factory=list)
    notes: Optional[str] = None
    referred_by: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def clean_empty_strings(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for k, v in data.items():
                if v == "":
                    data[k] = None
        return data
