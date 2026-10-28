"""Phase 2 extracted subsystem: document_routes.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/document_routes.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import check_module_permission
from backend.dependencies import check_permission
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.models import Document
from backend.models import DocumentCreate
from backend.models import DocumentMovementRequest
from backend.models import User
from backend.server_modules.helpers import create_audit_log
from datetime import datetime
from datetime import timezone
from fastapi import Depends
from fastapi import HTTPException
from typing import List
import uuid
from backend.server import IST, api_router  # created in backend/server.py before route modules load

@api_router.post("/documents", response_model=Document)
async def create_document(
    document_data: DocumentCreate,
    current_user: User = Depends(
        check_module_permission("document_register", "create")
    ),
):
    # Document.created_at is optional on the response model, but every new
    # record must receive a real timestamp before it is serialized for Mongo.
    # Calling .isoformat() on the old None default caused every POST /documents
    # request to fail with a 500 even when the user had the correct permission.
    document = Document(
        **document_data.model_dump(),
        created_by=current_user.id,
        created_at=datetime.now(timezone.utc),
    )
    doc = document.model_dump()
    doc["created_at"] = doc["created_at"].isoformat()
    if doc.get("issue_date"):
        doc["issue_date"] = doc["issue_date"].isoformat()
    if doc.get("valid_upto"):
        doc["valid_upto"] = doc["valid_upto"].isoformat()
    await db.documents.insert_one(doc)
    return document


@api_router.get("/documents", response_model=List[Document])
async def get_documents(
    current_user: User = Depends(check_permission("can_view_documents")),
):
    documents = await db.documents.find({}, {"_id": 0}).to_list(1000)
    for d in documents:
        if isinstance(d["created_at"], str):
            d["created_at"] = datetime.fromisoformat(d["created_at"])
        if d.get("issue_date") and isinstance(d["issue_date"], str):
            d["issue_date"] = datetime.fromisoformat(d["issue_date"])
        if d.get("valid_upto") and isinstance(d["valid_upto"], str):
            d["valid_upto"] = datetime.fromisoformat(d["valid_upto"])
    return documents


@api_router.put("/documents/{document_id}", response_model=Document)
async def update_document(
    document_id: str,
    document_data: DocumentCreate,
    current_user: User = Depends(check_permission("can_edit_documents")),
):
    existing = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Document not found")
    update_data = document_data.model_dump()
    if update_data.get("issue_date"):
        update_data["issue_date"] = update_data["issue_date"].isoformat()
    if update_data.get("valid_upto"):
        update_data["valid_upto"] = update_data["valid_upto"].isoformat()
    await db.documents.update_one({"id": document_id}, {"$set": update_data})
    await create_audit_log(
        current_user,
        action="UPDATE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=existing,
        new_data=update_data,
    )
    updated = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if isinstance(updated["created_at"], str):
        updated["created_at"] = datetime.fromisoformat(updated["created_at"])
    return Document(**updated)


@api_router.delete("/documents/{document_id}")
async def delete_document(
    document_id: str,
    current_user: User = Depends(check_permission("can_edit_documents")),
):
    existing = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Document not found")
    await create_audit_log(
        current_user,
        action="DELETE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=existing,
    )
    result = await db.documents.delete_one({"id": document_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"message": "Document deleted successfully"}


@api_router.post("/documents/{document_id}/movement")
async def record_document_movement(
    document_id: str,
    movement_data: DocumentMovementRequest,
    current_user: User = Depends(get_current_user),
):
    document = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    movement = {
        "id": str(uuid.uuid4()),
        "movement_type": movement_data.movement_type,
        "person_name": movement_data.person_name,
        "timestamp": datetime.now(IST).isoformat(),
        "notes": movement_data.notes,
        "recorded_by": current_user.full_name,
    }
    movement_log = document.get("movement_log", [])
    movement_log.append(movement)
    await db.documents.update_one(
        {"id": document_id},
        {
            "$set": {
                "current_status": movement_data.movement_type,
                "movement_log": movement_log,
            }
        },
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=document,
        new_data={"movement_log": movement_log},
    )
    return {"message": "Movement recorded successfully"}


@api_router.put("/documents/{document_id}/movement/{movement_id}")
async def update_document_movement(
    document_id: str,
    movement_id: str,
    update_data: DocumentMovementRequest,
    current_user: User = Depends(get_current_user),
):
    document = await db.documents.find_one({"id": document_id}, {"_id": 0})
    if not document:
        raise HTTPException(status_code=404, detail="Document not found")
    movement_log = document.get("movement_log", [])
    movement_found = False
    for i, movement in enumerate(movement_log):
        if movement.get("id") == movement_id:
            movement_log[i]["movement_type"] = update_data.movement_type
            movement_log[i]["person_name"] = update_data.person_name
            movement_log[i]["notes"] = update_data.notes
            movement_log[i]["edited_by"] = current_user.full_name
            movement_log[i]["edited_at"] = datetime.now(timezone.utc).isoformat()
            movement_found = True
            break
    if not movement_found:
        raise HTTPException(status_code=404, detail="Movement entry not found")
    new_status = movement_log[-1]["movement_type"] if movement_log else "IN"
    await db.documents.update_one(
        {"id": document_id},
        {"$set": {"current_status": new_status, "movement_log": movement_log}},
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DOCUMENT",
        module="document",
        record_id=document_id,
        old_data=document,
        new_data={"movement_log": movement_log},
    )
    return {"message": "Movement updated successfully"}


# DUE DATE ROUTES
COMPLIANCE_RULES = [
    {
        "keywords": ["gstr-1", "gstr1", "outward supply"],
        "category": "GST",
        "department": "GST",
    },
    {
        "keywords": ["gstr-3b", "gstr3b", "summary return"],
        "category": "GST",
        "department": "GST",
    },
    {
        "keywords": ["gstr-9", "annual return gst"],
        "category": "GST",
        "department": "GST",
    },
    {"keywords": ["gstr-4", "composition"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-7", "tds return gst"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-8", "tcs statement"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-5", "non-resident"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-6", "isd return"], "category": "GST", "department": "GST"},
    {"keywords": ["gstr-10", "final return"], "category": "GST", "department": "GST"},
    {"keywords": ["gst", "goods and service"], "category": "GST", "department": "GST"},
    {
        "keywords": ["itr", "income tax return"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": ["advance tax", "advance income tax"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": ["tax audit", "form 3ca", "form 3cb"],
        "category": "Audit",
        "department": "IT",
    },
    {
        "keywords": ["form 16", "form 26as"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": ["income tax", "direct tax"],
        "category": "Income Tax",
        "department": "IT",
    },
    {
        "keywords": [
            "tds",
            "tax deducted at source",
            "form 24q",
            "form 26q",
            "form 27q",
        ],
        "category": "TDS",
        "department": "TDS",
    },
    {
        "keywords": ["tcs", "tax collected at source"],
        "category": "TDS",
        "department": "TDS",
    },
    {"keywords": ["challan 281"], "category": "TDS", "department": "TDS"},
    {
        "keywords": ["mgt-7", "annual return roc", "annual return mca"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["aoc-4", "financial statement", "filing of financial"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["dir-3", "director kyc", "din kyc"],
        "category": "ROC",
        "department": "ROC",
    },
    {"keywords": ["dir-8", "disqualification"], "category": "ROC", "department": "ROC"},
    {
        "keywords": ["dir-12", "appointment", "resignation of director"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["mbp-1", "disclosure of interest"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["agm", "annual general meeting"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["dpt-3", "return of deposits"],
        "category": "ROC",
        "department": "ROC",
    },
    {"keywords": ["msme-1", "msme samadhaan"], "category": "ROC", "department": "MSME"},
    {
        "keywords": ["pas-6", "reconciliation of share"],
        "category": "ROC",
        "department": "ROC",
    },
    {
        "keywords": ["roc", "mca", "companies act", "registrar of companies"],
        "category": "ROC",
        "department": "ROC",
    },
    {"keywords": ["msme"], "category": "Other", "department": "MSME"},
    {
        "keywords": ["statutory audit", "internal audit", "audit report"],
        "category": "Audit",
        "department": "ACC",
    },
    {
        "keywords": ["adt-1", "appointment of auditor"],
        "category": "Audit",
        "department": "ROC",
    },
    {
        "keywords": ["trademark", "tm renewal"],
        "category": "Trademark",
        "department": "TM",
    },
    {
        "keywords": ["fema", "foreign exchange", "fdi"],
        "category": "FEMA",
        "department": "FEMA",
    },
    {"keywords": ["rera", "real estate"], "category": "RERA", "department": "OTHER"},
    {
        "keywords": ["pf", "provident fund", "epfo"],
        "category": "Other",
        "department": "ACC",
    },
    {"keywords": ["esi", "esic"], "category": "Other", "department": "ACC"},
    {
        "keywords": ["board meeting", "minute book"],
        "category": "ROC",
        "department": "ROC",
    },
]

MONTH_MAP = {
    "january": 1,
    "jan": 1,
    "february": 2,
    "feb": 2,
    "march": 3,
    "mar": 3,
    "april": 4,
    "apr": 4,
    "may": 5,
    "june": 6,
    "jun": 6,
    "july": 7,
    "jul": 7,
    "august": 8,
    "aug": 8,
    "september": 9,
    "sep": 9,
    "sept": 9,
    "october": 10,
    "oct": 10,
    "november": 11,
    "nov": 11,
    "december": 12,
    "dec": 12,
}

