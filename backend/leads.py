from fastapi import APIRouter, Depends, HTTPException, status, Query, File, UploadFile
from typing import List, Optional, Literal
from pydantic import BaseModel, Field, ConfigDict, EmailStr, field_validator
from datetime import datetime, timezone
from bson import ObjectId
import uuid
import logging
import pandas as pd
from io import BytesIO

from backend.dependencies import (
    db,
    get_current_user,
    create_audit_log,
    can_view_lead,
    can_edit_lead,
    can_delete_lead,
    _get_perm,
    assert_module_permission,
    check_module_permission,
)

from backend.notifications import create_notification

router = APIRouter(prefix="/leads", tags=["Leads Management"])

logger = logging.getLogger(__name__)


# ====================== MODELS ======================

class LeadBase(BaseModel):
    model_config = ConfigDict(extra="ignore")

    company_name: str = Field(..., description="Name of the company or business")
    contact_name: Optional[str] = Field(None)
    email: Optional[EmailStr] = Field(None)
    phone: Optional[str] = Field(None)

    services: List[str] = Field(default_factory=list)
    quotation_amount: Optional[float] = Field(None)

    status: Literal[
        "new", "contacted", "meeting", "proposal",
        "negotiation", "on_hold", "won", "lost"
    ] = "new"
    source: Optional[str] = "direct"

    # WhatsApp lead provenance (optional; populated only for AI-captured leads)
    whatsapp_group_jid: Optional[str] = None
    whatsapp_group_name: Optional[str] = None
    whatsapp_message_id: Optional[str] = None
    whatsapp_sender_phone: Optional[str] = None
    whatsapp_sender_name: Optional[str] = None
    whatsapp_original_message: Optional[str] = None

    date_of_meeting: Optional[datetime] = None
    next_follow_up: Optional[datetime] = None
    notes: Optional[str] = None
    assigned_to: Optional[str] = None
    converted_client_id: Optional[str] = None
    closure_probability: Optional[float] = None

    # Pipeline tracking flags (post-won workflow)
    checklist_sent: Optional[bool] = False
    documents_received: Optional[bool] = False

    @field_validator(
        'quotation_amount', 'assigned_to', 'contact_name',
        'email', 'phone', mode='before'
    )
    @classmethod
    def empty_string_to_none(cls, v):
        if v == "" or v is None:
            return None
        return v

    @field_validator('services', mode='before')
    @classmethod
    def ensure_list_format(cls, v):
        if isinstance(v, str):
            return [s.strip() for s in v.split(',') if s.strip()]
        return v or []


class LeadCreate(LeadBase):
    pass


class LeadUpdate(BaseModel):
    company_name: Optional[str] = None
    contact_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    services: Optional[List[str]] = None
    quotation_amount: Optional[float] = None
    date_of_meeting: Optional[datetime] = None
    status: Optional[Literal[
        "new", "contacted", "meeting", "proposal",
        "negotiation", "on_hold", "qualified", "won", "lost"
    ]] = None
    source: Optional[Literal[
        "direct", "website", "referral", "social_media", "event", "whatsapp"
    ]] = None
    whatsapp_group_jid: Optional[str] = None
    whatsapp_group_name: Optional[str] = None
    whatsapp_message_id: Optional[str] = None
    whatsapp_sender_phone: Optional[str] = None
    whatsapp_sender_name: Optional[str] = None
    whatsapp_original_message: Optional[str] = None
    next_follow_up: Optional[datetime] = None
    notes: Optional[str] = None
    assigned_to: Optional[str] = None
    converted_client_id: Optional[str] = None
    closure_probability: Optional[float] = None
    checklist_sent: Optional[bool] = None
    documents_received: Optional[bool] = None


class Lead(LeadBase):
    id: str
    created_by: str
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )


# ====================== ONBOARDING TASK REQUEST ======================

class OnboardingTaskRequest(BaseModel):
    """
    Payload sent by the frontend when a won lead is being converted to a client.
    Carries task-creation details filled in by the user in the conversion dialog.
    """
    assigned_to: Optional[str] = None          # user id to assign the onboarding task
    due_date: Optional[datetime] = None         # task due date
    priority: Optional[str] = "medium"         # low | medium | high | critical
    task_notes: Optional[str] = None           # additional task description / checklist
    task_title: Optional[str] = None           # override default task title


# ====================== HELPERS ======================

def normalize_lead_doc(doc: dict) -> dict:
    """
    Normalise a raw MongoDB lead document before Pydantic response validation.

    IMPORTANT:
    - Existing MongoDB records may contain None for company_name or other
      fields because older/AI-created records did not always have every field.
    - company_name is required as a string by Lead, so None MUST become an
      empty string instead of causing FastAPI ResponseValidationError (HTTP 500).
    - Missing information must remain blank; this function must NEVER invent
      or derive a value from another field.
    """
    if not doc:
        return doc

    if "_id" in doc:
        doc["id"] = str(doc["_id"])

    # Lead.company_name is a required string. Older records can contain None.
    # Convert only the missing value to an empty string; preserve real data.
    if doc.get("company_name") is None:
        doc["company_name"] = ""

    # Optional string fields may safely remain None in the API model. Do not
    # manufacture placeholder values such as '-', 'N/A', or 'Unknown'.
    for field in [
        "created_at",
        "updated_at",
        "contact_name",
        "phone",
        "whatsapp_group_jid",
        "whatsapp_group_name",
        "whatsapp_message_id",
        "whatsapp_sender_phone",
        "whatsapp_sender_name",
        "whatsapp_original_message",
        "next_follow_up",
        "date_of_meeting",
    ]:
        if field in doc and doc[field] is not None and hasattr(doc[field], 'isoformat'):
            doc[field] = doc[field].isoformat()

    # Ensure tracking flags always present.
    if "checklist_sent" not in doc or doc["checklist_sent"] is None:
        doc["checklist_sent"] = False
    if "documents_received" not in doc or doc["documents_received"] is None:
        doc["documents_received"] = False

    return doc


def validate_obj_id(id_str: str) -> ObjectId:
    if not ObjectId.is_valid(id_str):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid Lead ID format"
        )
    return ObjectId(id_str)


def calculate_closure_probability(notes: str) -> float:
    if not notes:
        return 0.0
    notes_lower = notes.lower()
    positive_keywords = [
        "interested", "yes", "proceed", "deal", "sign",
        "agree", "excited", "good", "positive"
    ]
    negative_keywords = [
        "no", "not interested", "decline", "reject",
        "bad", "negative", "issue", "problem"
    ]
    positive_count = sum(1 for kw in positive_keywords if kw in notes_lower)
    negative_count = sum(1 for kw in negative_keywords if kw in notes_lower)
    total = positive_count + negative_count
    if total == 0:
        return 50.0
    score = (positive_count - negative_count) / total
    probability = max(0.0, min(1.0, 0.5 + score * 0.5))
    return round(probability * 100, 2)


def _build_lead_query(current_user) -> dict:
    """
    LEADS – View query builder.
      1. Admin         → all records
      2. Universal     → can_view_all_leads → all records
      3. Ownership     → assigned_to == user OR created_by == user
    """
    if current_user.role == "admin":
        return {}
    if _get_perm(current_user, "can_view_all_leads"):
        return {}
    return {
        "$or": [
            {"assigned_to": current_user.id},
            {"created_by": current_user.id},
        ]
    }


# ====================== ROUTES ======================

@router.get("/meta/services", response_model=List[str])
async def get_unique_services(current_user=Depends(check_module_permission("leads", "view"))):
    """Returns distinct services from leads + clients combined."""
    lead_services = await db.leads.distinct("services")
    client_services = await db.clients.distinct("services")
    defaults = [
        "GST Registration", "Trademark", "ROC Compliance",
        "Income Tax", "Audit"
    ]
    combined = list(set(lead_services + client_services + defaults))
    return sorted([s for s in combined if s])


@router.get("/followups")
async def get_due_followups(current_user=Depends(check_module_permission("leads", "view"))):
    """Returns leads with follow-up dates that are due."""
    now = datetime.now(timezone.utc)
    scope_filter = _build_lead_query(current_user)

    query = {
        "next_follow_up": {"$lte": now},
        "status": {"$nin": ["won", "lost"]},
    }
    if scope_filter:
        if "$or" in scope_filter:
            query["$or"] = scope_filter["$or"]
        else:
            query.update(scope_filter)

    leads = await db.leads.find(query).to_list(100)
    return [normalize_lead_doc(lead) for lead in leads]


@router.post("/import")
async def import_leads(
    file: UploadFile = File(...),
    current_user=Depends(check_module_permission("leads", "create"))
):
    if not file.filename.endswith('.csv'):
        raise HTTPException(status_code=400, detail="Only CSV files allowed")
    contents = await file.read()
    df = pd.read_csv(BytesIO(contents))
    return {"message": f"Imported {len(df)} leads (processing logic pending)"}


@router.post("", response_model=Lead)
async def create_lead(
    lead_data: LeadCreate,
    current_user=Depends(check_module_permission("leads", "create")),
):
    """Create a new lead."""
    now = datetime.now(timezone.utc)
    lead_dict = lead_data.model_dump()
    lead_dict.update({
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    })

    result = await db.leads.insert_one(lead_dict)
    lead_dict["_id"] = result.inserted_id

    await create_audit_log(
        current_user=current_user,
        action="CREATE_LEAD",
        module="leads",
        record_id=str(result.inserted_id),
        new_data={"company_name": lead_dict.get("company_name")},
    )

    return normalize_lead_doc(lead_dict)


@router.get("", response_model=List[Lead])
@router.get("/", response_model=List[Lead], include_in_schema=False)
async def get_leads(
    status_filter: Optional[Literal[
        "new", "contacted", "meeting", "proposal",
        "negotiation", "on_hold", "qualified", "won", "lost"
    ]] = Query(None, alias="status"),
    current_user=Depends(check_module_permission("leads", "view")),
):
    """List leads with permission matrix applied."""
    query = _build_lead_query(current_user)
    if status_filter:
        query["status"] = status_filter

    cursor = db.leads.find(query).sort("updated_at", -1)
    leads_raw = await cursor.to_list(length=1000)
    return [normalize_lead_doc(lead) for lead in leads_raw]


@router.get("/{lead_id}/quotations")
async def get_lead_quotations(lead_id: str, current_user=Depends(check_module_permission("leads", "view"))):
    """
    Returns all quotations linked to a specific lead.
    Powers the Quotations panel inside the Lead card on LeadsPage.
    """
    obj_id = validate_obj_id(lead_id)

    raw_lead = await db.leads.find_one({"_id": obj_id})
    if not raw_lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not can_view_lead(current_user, raw_lead):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to view this lead"
        )

    quotations = await db.quotations.find(
        {"lead_id": lead_id},
        {"_id": 0}
    ).sort("created_at", -1).to_list(50)

    return quotations


@router.get("/{lead_id}/quotation-count")
async def get_lead_quotation_count(lead_id: str, current_user=Depends(check_module_permission("leads", "view"))):
    """
    Returns count of quotations linked to a lead.
    Lightweight badge count for lead cards.
    """
    obj_id = validate_obj_id(lead_id)

    raw_lead = await db.leads.find_one({"_id": obj_id})
    if not raw_lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not can_view_lead(current_user, raw_lead):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to view this lead"
        )

    count = await db.quotations.count_documents({"lead_id": lead_id})
    return {"lead_id": lead_id, "count": count}


@router.get("/{lead_id}", response_model=Lead)
async def get_lead(lead_id: str, current_user=Depends(check_module_permission("leads", "view"))):
    """Get a single lead by ID."""
    obj_id = validate_obj_id(lead_id)

    raw_lead = await db.leads.find_one({"_id": obj_id})
    if not raw_lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    # Issue #1: visibility check (permission already enforced by Depends above)
    if not can_view_lead(current_user, raw_lead):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to view this lead"
        )

    return normalize_lead_doc(raw_lead)


@router.patch("/{lead_id}", response_model=Lead)
async def update_lead(
    lead_id: str,
    updates: LeadUpdate,
    current_user=Depends(check_module_permission("leads", "edit")),
):
    """Update a lead."""
    obj_id = validate_obj_id(lead_id)

    existing = await db.leads.find_one({"_id": obj_id})
    if not existing:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not can_edit_lead(current_user, existing):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to edit this lead"
        )

    update_dict = updates.model_dump(exclude_unset=True)
    if not update_dict:
        return normalize_lead_doc(existing)

    if update_dict.get("assigned_to"):
        user_exists = await db.users.find_one({"id": update_dict["assigned_to"]})
        if not user_exists:
            raise HTTPException(status_code=400, detail="Assigned user not found")

    if update_dict.get("status") == "won" and not existing.get("converted_client_id"):
        if "converted_client_id" not in update_dict:
            raise HTTPException(
                status_code=400,
                detail="Use the /convert endpoint to mark a lead as won"
            )

    # NOTE: Removed the past-date validation for next_follow_up on edit.
    # On edit, users may legitimately keep or view past follow-up dates.
    # Validation is only applied on create via frontend guidance.

    if "notes" in update_dict:
        update_dict["closure_probability"] = calculate_closure_probability(
            update_dict["notes"]
        )

    update_dict["updated_at"] = datetime.now(timezone.utc)

    await db.leads.update_one({"_id": obj_id}, {"$set": update_dict})

    await create_audit_log(
        current_user=current_user,
        action="UPDATE_LEAD",
        module="leads",
        record_id=lead_id,
        old_data={"status": existing.get("status")},
        new_data=update_dict,
    )

    updated_doc = await db.leads.find_one({"_id": obj_id})
    return normalize_lead_doc(updated_doc)


@router.post("/{lead_id}/convert", status_code=status.HTTP_201_CREATED)
async def convert_lead_to_client(
    lead_id: str,
    task_request: Optional[OnboardingTaskRequest] = None,
    current_user=Depends(check_module_permission("leads", "edit")),
):
    """
    Convert a lead to a client.

    Accepts an optional OnboardingTaskRequest body that carries the
    onboarding task details filled in by the user in the conversion dialog:
      - assigned_to : user id for the task (defaults to lead's assigned_to)
      - due_date    : task due date
      - priority    : task priority (low/medium/high/critical)
      - task_notes  : extra description / checklist for the onboarding task
      - task_title  : override the default "Client Onboarding - <company>" title
    """
    obj_id = validate_obj_id(lead_id)

    lead = await db.leads.find_one({"_id": obj_id})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not can_edit_lead(current_user, lead):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to convert this lead"
        )

    if lead.get("converted_client_id"):
        raise HTTPException(status_code=400, detail="Lead already converted")

    now = datetime.now(timezone.utc)

    client_id = str(uuid.uuid4())
    client_data = {
        "id": client_id,
        "company_id": lead.get("company_id") or getattr(current_user, "company_id", ""),
        "company_name": lead["company_name"],
        "contact_name": lead.get("contact_name"),
        "email": lead.get("email"),
        "phone": lead.get("phone") or "0000000000",
        "services": lead.get("services", []),
        "client_type": "other",
        "assigned_to": lead.get("assigned_to") or current_user.id,
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
        "notes": f"Converted from Lead. Original Notes: {lead.get('notes', 'N/A')}",
    }

    await db.clients.insert_one(client_data)

    conversion_guard = {
        "_id": obj_id,
        "converted_client_id": {"$in": [None, ""]},
    }
    await db.leads.update_one(
        conversion_guard,
        {
            "$set": {
                "status": "won",
                "converted_client_id": client_id,
                "updated_at": now,
            }
        }
    )

    # ── Build onboarding task with user-provided details ──────────────────
    tr = task_request or OnboardingTaskRequest()

    task_assigned_to = (
        tr.assigned_to
        or lead.get("assigned_to")
        or current_user.id
    )
    task_title = (
        tr.task_title
        or f"Client Onboarding - {lead['company_name']}"
    )
    default_description = (
        "Lead converted to client. Start onboarding process.\n"
        "- Send welcome email\n"
        "- Collect KYC documents\n"
        "- Schedule onboarding call\n"
        "- Set up client portal access"
    )
    task_description = tr.task_notes or default_description

    task = {
        "id": str(uuid.uuid4()),
        "title": task_title,
        "description": task_description,
        "assigned_to": task_assigned_to,
        "sub_assignees": [],
        "status": "pending",
        "priority": tr.priority or "medium",
        "created_by": current_user.id,
        "client_id": client_id,
        "lead_id": str(obj_id),
        "category": "other",
        "is_recurring": False,
        "created_at": now,
        "updated_at": now,
    }
    if tr.due_date:
        task["due_date"] = tr.due_date

    await db.tasks.insert_one(task)

    # Notify the task assignee (if different from current user)
    if task_assigned_to != current_user.id:
        await create_notification(
            user_id=task_assigned_to,
            title="Onboarding Task Assigned",
            message=f"You have been assigned the onboarding task for {lead['company_name']}",
            type="task"
        )

    await create_audit_log(
        current_user=current_user,
        action="LEAD_CONVERTED",
        module="leads",
        record_id=lead_id,
        old_data=None,
        new_data={"client_id": client_id},
    )

    target_user = lead.get("assigned_to") or current_user.id

    await create_notification(
        user_id=target_user,
        title="Lead Converted",
        message=f"{lead['company_name']} has been converted to a client",
        type="lead"
    )

    if target_user != current_user.id:
        await create_notification(
            user_id=current_user.id,
            title="Lead Converted",
            message=f"You converted {lead['company_name']} to client",
            type="lead"
        )

    return {
        "status": "success",
        "message": "Lead successfully converted to client",
        "client_id": client_id,
        "task_id": task["id"],
        "task_assigned_to": task_assigned_to,
    }


@router.delete("/{lead_id}")
async def delete_lead(lead_id: str, current_user=Depends(check_module_permission("leads", "delete"))):
    """Delete a lead permanently. Issue #7: requires leads.delete (can_manage_users flag)."""
    # can_delete_lead check is already handled by check_module_permission above

    obj_id = validate_obj_id(lead_id)

    existing = await db.leads.find_one({"_id": obj_id}, {"_id": 0, "company_name": 1})

    result = await db.leads.delete_one({"_id": obj_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Lead not found")

    await create_audit_log(
        current_user=current_user,
        action="DELETE_LEAD",
        module="leads",
        record_id=lead_id,
        old_data=existing,
        new_data=None
    )

    return {"status": "success", "message": "Lead permanently removed"}


@router.post("/{lead_id}/predict_closure")
async def predict_lead_closure(
    lead_id: str,
    current_user=Depends(check_module_permission("leads", "view")),
):
    """Predict closure probability for a lead."""
    obj_id = validate_obj_id(lead_id)

    lead = await db.leads.find_one({"_id": obj_id})
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    if not can_view_lead(current_user, lead):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have permission to access this lead"
        )

    probability = calculate_closure_probability(lead.get("notes", ""))

    await db.leads.update_one(
        {"_id": obj_id},
        {
            "$set": {
                "closure_probability": probability,
                "updated_at": datetime.now(timezone.utc)
            }
        }
    )

    return {"closure_probability": probability}
