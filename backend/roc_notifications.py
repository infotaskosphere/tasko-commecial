"""
ROC Sphere — Notifications / Legal Update Engine.

This is an additive ROC-only router. It lets authorised users upload MCA/ICSI/
Companies Act update documents, extracts readable text, identifies likely
affected provisions/forms, and stores a versioned proposed rule update.
Legal-rule changes remain DRAFT until a reviewer explicitly approves them.
"""

import io
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from backend.dependencies import db, get_current_user, check_module_permission
from backend.models import User

VIEW = check_module_permission("roc_sphere", "view")
CREATE = check_module_permission("roc_sphere", "create")
EDIT = check_module_permission("roc_sphere", "edit")
DELETE = check_module_permission("roc_sphere", "delete")

router = APIRouter(prefix="/roc-sphere/companies/{company_id}/notifications", tags=["roc-sphere-notifications"])

NOTIFICATIONS = db.roc_notifications
LEGAL_RULES = db.roc_legal_rules

MAX_FILE_BYTES = 15 * 1024 * 1024

FORM_KEYWORDS = {
    "AOC-4": ["aoc-4", "aoc 4", "financial statements", "financial statement"],
    "MGT-7": ["mgt-7", "mgt 7", "annual return"],
    "MGT-7A": ["mgt-7a", "mgt 7a", "abridged annual return"],
    "ADT-1": ["adt-1", "adt 1", "appointment of auditor", "auditor appointment"],
    "DIR-12": ["dir-12", "dir 12", "appointment of director", "cessation of director"],
    "PAS-3": ["pas-3", "pas 3", "return of allotment", "allotment of securities"],
    "SH-7": ["sh-7", "sh 7", "alteration of share capital", "authorised capital"],
    "MGT-14": ["mgt-14", "mgt 14", "resolutions and agreements"],
    "CHG-1": ["chg-1", "chg 1", "creation of charge", "modification of charge"],
    "CHG-4": ["chg-4", "chg 4", "satisfaction of charge"],
    "DPT-3": ["dpt-3", "dpt 3", "return of deposits"],
    "MSME-1": ["msme-1", "msme 1", "outstanding dues to micro and small enterprises"],
    "DIR-3 KYC": ["dir-3 kyc", "dir 3 kyc", "kyc of directors"],
    "INC-22": ["inc-22", "inc 22", "registered office"],
}

SECTION_RE = re.compile(r"\b(?:section|sec\.?|s\.)\s*([0-9]{1,3}[A-Za-z]?(?:\([0-9A-Za-z]+\))?)\b", re.I)
RULE_RE = re.compile(r"\b(?:rule)\s+([0-9]{1,3}[A-Za-z]?)\b", re.I)
DATE_RE = re.compile(r"\b(\d{1,2}[\-/]\d{1,2}[\-/]\d{4}|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December),?\s+\d{4})\b", re.I)

def _now():
    return datetime.now(timezone.utc).isoformat()

def _id():
    return str(uuid.uuid4())

def _user_name(user: User):
    return getattr(user, "full_name", None) or getattr(user, "username", None) or getattr(user, "email", None) or "—"

def _extract_text(filename: str, content: bytes) -> str:
    name = (filename or "").lower()
    if name.endswith(".pdf"):
        try:
            import pdfplumber
            parts = []
            with pdfplumber.open(io.BytesIO(content)) as pdf:
                for page in pdf.pages:
                    txt = page.extract_text() or ""
                    if txt.strip():
                        parts.append(txt)
                    for table in page.extract_tables():
                        for row in table:
                            if row:
                                parts.append(" | ".join(str(c or "").strip() for c in row))
            return "\n".join(parts)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read PDF: {exc}")
    if name.endswith(".docx"):
        try:
            from docx import Document
            doc = Document(io.BytesIO(content))
            parts = [p.text for p in doc.paragraphs if p.text.strip()]
            for table in doc.tables:
                for row in table.rows:
                    parts.append(" | ".join(cell.text.strip() for cell in row.cells))
            return "\n".join(parts)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=f"Could not read DOCX: {exc}")
    if name.endswith((".txt", ".md", ".csv")):
        return content.decode("utf-8", errors="replace")
    raise HTTPException(status_code=400, detail="Supported update documents: PDF, DOCX, TXT, MD or CSV")

def _analyse(text: str, filename: str) -> Dict[str, Any]:
    low = text.lower()
    forms = [form for form, words in FORM_KEYWORDS.items() if any(w in low for w in words)]
    sections = list(dict.fromkeys(m.group(1) for m in SECTION_RE.finditer(text)))[:100]
    rules = list(dict.fromkeys(m.group(1) for m in RULE_RE.finditer(text)))[:100]
    dates = list(dict.fromkeys(m.group(1) for m in DATE_RE.finditer(text)))[:30]

    change_terms = [
        "amend", "amended", "substituted", "inserted", "omitted", "shall come into force",
        "effective from", "effective date", "notification", "circular", "relaxation",
        "extension", "clarification", "revised", "new form", "modified",
    ]
    change_signals = [term for term in change_terms if term in low]

    proposed = []
    for form in forms:
        proposed.append({
            "rule_key": f"notification:{form.lower().replace(' ', '-')}",
            "affected_form": form,
            "status": "DRAFT",
            "reason": f"Uploaded document contains references associated with {form}.",
            "effective_date_candidates": dates[:10],
            "sections": sections[:20],
        })
    if not proposed and (change_signals or sections or rules):
        proposed.append({
            "rule_key": "notification:general",
            "affected_form": None,
            "status": "DRAFT",
            "reason": "Potential Companies Act / Rules update detected; manual review required.",
            "effective_date_candidates": dates[:10],
            "sections": sections[:20],
            "rules": rules[:20],
        })

    return {
        "document_type": (
            "MCA Notification" if "mca" in low and "notification" in low
            else "Circular" if "circular" in low
            else "Amendment / Rules Update" if "amend" in low or "rules" in low
            else "Regulatory Update"
        ),
        "affected_forms": forms,
        "sections": sections,
        "rules": rules,
        "date_candidates": dates,
        "change_signals": change_signals,
        "proposed_rule_updates": proposed,
        "summary": " ".join(re.sub(r"\\s+", " ", text).split())[:2000],
    }

def _clean_doc(doc):
    if not doc:
        return None
    doc.pop("_id", None)
    doc.pop("document_bytes", None)
    return doc

@router.get("")
async def list_notifications(company_id: str, current_user: User = Depends(VIEW)):
    docs = []
    cursor = NOTIFICATIONS.find({"company_id": company_id}).sort("uploaded_at", -1)
    async for doc in cursor:
        docs.append(_clean_doc(doc))
    return docs

@router.post("/upload")
async def upload_notification(
    company_id: str,
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    authority: Optional[str] = Form(""),
    effective_date: Optional[str] = Form(""),
    current_user: User = Depends(CREATE),
):
    company = await db.roc_companies.find_one({"id": company_id})
    if not company:
        raise HTTPException(status_code=404, detail="ROC company not found")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="Uploaded document is empty")
    if len(content) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="Update document exceeds the 15 MB limit")

    text = _extract_text(file.filename or "", content)
    if not text.strip():
        raise HTTPException(status_code=422, detail="No readable text found in the uploaded document")

    analysis = _analyse(text, file.filename or "")
    now = _now()
    doc_id = _id()
    record = {
        "id": doc_id,
        "company_id": company_id,
        "title": (title or file.filename or "Regulatory Update").strip(),
        "filename": file.filename or "uploaded-document",
        "authority": (authority or "Not specified").strip(),
        "effective_date": (effective_date or "").strip() or None,
        "uploaded_by": _user_name(current_user),
        "uploaded_at": now,
        "file_size": len(content),
        "mime_type": file.content_type or "application/octet-stream",
        "extracted_text": text[:250000],
        "analysis": analysis,
        "status": "UNDER_REVIEW",
        "review_note": "",
        "document_bytes": content if len(content) <= MAX_FILE_BYTES else None,
    }
    await NOTIFICATIONS.insert_one(record)

    for proposed in analysis.get("proposed_rule_updates", []):
        rule = {
            "id": _id(),
            "company_id": company_id,
            "notification_id": doc_id,
            "rule_key": proposed["rule_key"],
            "affected_form": proposed.get("affected_form"),
            "status": "DRAFT",
            "reason": proposed.get("reason"),
            "effective_date_candidates": proposed.get("effective_date_candidates", []),
            "sections": proposed.get("sections", []),
            "created_at": now,
            "created_by": _user_name(current_user),
        }
        await LEGAL_RULES.insert_one(rule)

    return {
        "id": doc_id,
        "filename": record["filename"],
        "analysis": analysis,
        "status": "UNDER_REVIEW",
        "message": "Document read successfully. Proposed legal-rule updates require review before activation.",
    }

@router.get("/{notification_id}")
async def get_notification(company_id: str, notification_id: str, current_user: User = Depends(VIEW)):
    doc = await NOTIFICATIONS.find_one({"id": notification_id, "company_id": company_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Notification not found")
    return _clean_doc(doc)

@router.get("/{notification_id}/rules")
async def notification_rules(company_id: str, notification_id: str, current_user: User = Depends(VIEW)):
    rules = []
    cursor = LEGAL_RULES.find({"company_id": company_id, "notification_id": notification_id}).sort("created_at", -1)
    async for rule in cursor:
        rules.append(_clean_doc(rule))
    return rules

@router.post("/{notification_id}/review")
async def review_notification(
    company_id: str,
    notification_id: str,
    payload: Dict[str, Any],
    current_user: User = Depends(EDIT),
):
    action = str(payload.get("action") or "").upper()
    if action not in {"APPROVE", "REJECT"}:
        raise HTTPException(status_code=400, detail="action must be APPROVE or REJECT")

    doc = await NOTIFICATIONS.find_one({"id": notification_id, "company_id": company_id})
    if not doc:
        raise HTTPException(status_code=404, detail="Notification not found")

    status = "APPROVED" if action == "APPROVE" else "REJECTED"
    now = _now()
    await NOTIFICATIONS.update_one(
        {"id": notification_id},
        {"$set": {"status": status, "review_note": payload.get("note", ""), "reviewed_by": _user_name(current_user), "reviewed_at": now}},
    )
    await LEGAL_RULES.update_many(
        {"company_id": company_id, "notification_id": notification_id},
        {"$set": {"status": "ACTIVE" if action == "APPROVE" else "REJECTED", "approved_by": _user_name(current_user) if action == "APPROVE" else None, "approved_at": now if action == "APPROVE" else None}},
    )
    return {"success": True, "status": status}

@router.get("/rules/active")
async def active_rules(company_id: str, current_user: User = Depends(VIEW)):
    rules = []
    cursor = LEGAL_RULES.find({"company_id": company_id, "status": "ACTIVE"}).sort("created_at", -1)
    async for rule in cursor:
        rules.append(_clean_doc(rule))
    return rules

@router.get("/rules/draft")
async def draft_rules(company_id: str, current_user: User = Depends(VIEW)):
    rules = []
    cursor = LEGAL_RULES.find({"company_id": company_id, "status": "DRAFT"}).sort("created_at", -1)
    async for rule in cursor:
        rules.append(_clean_doc(rule))
    return rules
