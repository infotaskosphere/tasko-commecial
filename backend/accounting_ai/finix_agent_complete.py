"""Integrated Finix AI orchestration layer.

This module coordinates existing accounting, learning, invoice and bank data.
It deliberately does not replace the governed accounting posting engine.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User
from backend.accounting_ai.finix_learning import get_learning_context, record_learning
from backend.accounting_ai.finix_ai_router import _build_proposal, _can_post, _can_view, _date

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Agent"])


def _company(user: User, company_id: str = "") -> str:
    cid = (company_id or getattr(user, "company_id", "") or "").strip()
    if not cid:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return cid


class AgentProposalRequest(BaseModel):
    text: str = Field(..., min_length=2, max_length=4000)
    company_id: str = ""
    accounting_date: Optional[str] = None


class FeedbackRequest(BaseModel):
    proposal_id: str
    outcome: str = Field(..., pattern="^(APPROVED_POSTED|CORRECTED|REJECTED)$")
    correction: Optional[dict] = None


class InboxActionRequest(BaseModel):
    proposal_id: str
    action: str = Field(..., pattern="^(APPROVE|REJECT)$")


class AskRequest(BaseModel):
    question: str = Field(..., min_length=2, max_length=1000)
    company_id: str = ""


async def _party_history(company_id: str, party_name: str) -> dict:
    if not party_name:
        return {"transactions": [], "invoice_count": 0, "outstanding": 0.0}
    q = {"company_id": company_id, "$or": [
        {"client_name": {"$regex": re.escape(party_name), "$options": "i"}},
        {"supplier_name": {"$regex": re.escape(party_name), "$options": "i"}},
        {"customer_name": {"$regex": re.escape(party_name), "$options": "i"}},
        {"vendor_name": {"$regex": re.escape(party_name), "$options": "i"}},
    ]}
    invoices = await db.invoices.find(q, {"_id": 0}).sort("invoice_date", -1).to_list(20)
    purchases = await db.purchase_invoices.find(q, {"_id": 0}).sort("invoice_date", -1).to_list(20)
    all_docs = invoices + purchases
    return {"transactions": all_docs[:20], "invoice_count": len(all_docs), "outstanding": round(sum(float(d.get("amount_due") or 0) for d in all_docs), 2)}


async def _learning_and_history(result: dict, cid: str) -> dict:
    result["learning"] = await get_learning_context(cid, result.get("event", ""), result.get("party_name", ""))
    result["party_history"] = await _party_history(cid, result.get("party_name", ""))
    result["agent_stage"] = "PROPOSAL_READY"
    return result


@router.post("/agent/propose")
async def agent_propose(payload: AgentProposalRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, payload.company_id)
    return await _learning_and_history(await _build_proposal(payload.text.strip(), cid, _date(payload.accounting_date), current_user), cid)


@router.post("/feedback")
async def agent_feedback(payload: FeedbackRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    if proposal.get("company_id") != getattr(current_user, "company_id", "") and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Proposal belongs to another company.")
    if proposal.get("created_by") != current_user.id and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Only the proposal owner or an admin can provide feedback.")
    await record_learning(proposal.get("company_id", ""), proposal.get("event", ""), proposal.get("interpretation", {}).get("party_name", ""), proposal, payload.outcome, current_user.id, payload.correction)
    await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {"feedback": payload.outcome, "correction": payload.correction, "feedback_by": current_user.id, "feedback_at": datetime.now(timezone.utc).isoformat()}})
    return {"success": True, "learned": True, "outcome": payload.outcome}


@router.get("/inbox")
async def agent_inbox(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)
    items = await db.finix_ai_proposals.find({"company_id": cid, "status": {"$in": ["PROPOSED", "REVIEW_REQUIRED"]}}, {"_id": 0}).sort("created_at", -1).to_list(100)
    return {"items": items, "count": len(items)}


@router.post("/inbox/action")
async def agent_inbox_action(payload: InboxActionRequest, current_user: User = Depends(get_current_user)):
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    is_admin = str(current_user.role or "").lower() == "admin"
    if not is_admin and proposal.get("company_id") != getattr(current_user, "company_id", ""):
        raise HTTPException(403, "Proposal belongs to another company.")
    if proposal.get("created_by") != current_user.id and not is_admin:
        raise HTTPException(403, "Only the proposal owner or an admin can action this proposal.")
    if payload.action == "REJECT":
        await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {"status": "REJECTED", "updated_at": datetime.now(timezone.utc).isoformat()}})
        await record_learning(proposal.get("company_id", ""), proposal.get("event", ""), proposal.get("interpretation", {}).get("party_name", ""), proposal, "REJECTED", current_user.id)
        return {"success": True, "status": "REJECTED"}
    if not _can_post(current_user):
        raise HTTPException(403, "Posting requires journal-posting permission.")
    if proposal.get("status") == "POSTED":
        return {"success": True, "status": "POSTED", "journal_entry": proposal.get("journal_entry")}
    from backend import accounting_core as ac
    try:
        entry = await ac.post_journal_entry(proposal["company_id"], proposal["accounting_date"], proposal["narration"], proposal["lines"], "ai_zero_touch", proposal["id"], current_user.id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Finix posting was blocked: {type(exc).__name__}: {exc}")
    now = datetime.now(timezone.utc).isoformat()
    await db.finix_ai_proposals.update_one({"id": proposal["id"]}, {"$set": {
        "status": "POSTED",
        "journal_entry": entry,
        "posted_by": current_user.id,
        "posted_at": now,
        "updated_at": now,
        "audit": {
            "proposal_created_by": proposal.get("created_by"),
            "approved_by": current_user.id,
            "approved_at": now,
            "accounting_date": proposal.get("accounting_date"),
            "journal_entry_id": entry.get("id") if isinstance(entry, dict) else None,
            "source": "finix_ai_agent",
        },
    }})
    await record_learning(proposal.get("company_id", ""), proposal.get("event", ""), proposal.get("interpretation", {}).get("party_name", ""), proposal, "APPROVED_POSTED", current_user.id)
    return {"success": True, "status": "POSTED", "journal_entry": entry}


async def _extract_upload(upload: UploadFile) -> dict:
    raw = await upload.read()
    name = (upload.filename or "upload").lower()
    text = ""
    extraction = "text"
    if name.endswith((".txt", ".csv")):
        text = raw.decode("utf-8", errors="ignore")[:50000]
        if name.endswith(".csv"):
            rows = list(csv.reader(io.StringIO(text)))[:100]
            text = "\n".join(" | ".join(r) for r in rows)
            extraction = "csv"
    elif name.endswith(".pdf"):
        extraction = "pdf"
        try:
            from pypdf import PdfReader
            text = "\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(raw)).pages)[:50000]
        except Exception:
            text = ""
    elif name.endswith((".xlsx", ".xls")):
        extraction = "spreadsheet"
        try:
            import openpyxl
            wb = openpyxl.load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
            chunks = []
            for ws in wb.worksheets[:5]:
                for row in ws.iter_rows(max_row=100, values_only=True):
                    chunks.append(" | ".join(str(v or "") for v in row))
            text = "\n".join(chunks)[:50000]
        except Exception:
            text = ""
    else:
        extraction = "image_or_unknown"
    return {"filename": upload.filename or "upload", "size": len(raw), "extraction": extraction, "text": text}


@router.post("/upload")
async def agent_upload(file: UploadFile = File(...), company_id: str = "", accounting_date: Optional[str] = None, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, company_id)
    extracted = await _extract_upload(file)
    doc_id = str(uuid.uuid4())
    await db.finix_ai_documents.insert_one({"id": doc_id, "company_id": cid, "filename": extracted["filename"], "size": extracted["size"], "extraction": extracted["extraction"], "text": extracted["text"], "status": "EXTRACTED", "created_by": current_user.id, "created_at": datetime.now(timezone.utc).isoformat()})
    if not extracted["text"].strip():
        return {"success": True, "document_id": doc_id, "status": "REVIEW_REQUIRED", "message": "Document received; readable text could not be extracted. Finix has not posted anything."}
    result = await _build_proposal(extracted["text"], cid, _date(accounting_date), current_user)
    result["document_id"] = doc_id
    result["source_filename"] = extracted["filename"]
    if result.get("success"):
        await db.finix_ai_proposals.update_one({"id": result["proposal_id"]}, {"$set": {"source_document_id": doc_id, "source_filename": extracted["filename"]}})
    return await _learning_and_history(result, cid)


@router.post("/ask")
async def agent_ask(payload: AskRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = _company(current_user, payload.company_id)
    q = payload.question.lower()
    result: dict[str, Any] = {"question": payload.question, "company_id": cid, "source": "live accounting data"}
    if any(x in q for x in ("profit", "loss", "p&l", "p and l")):
        entries = await db.journal_lines.find({"company_id": cid}, {"_id": 0}).to_list(100000)
        account_ids = {a.get("id"): a for a in await db.chart_of_accounts.find({"company_id": cid}, {"_id": 0}).to_list(5000)}
        income = expense = 0.0
        for line in entries:
            acct = account_ids.get(line.get("account_id"), {})
            if acct.get("type") == "income": income += float(line.get("credit") or 0) - float(line.get("debit") or 0)
            elif acct.get("type") == "expense": expense += float(line.get("debit") or 0) - float(line.get("credit") or 0)
        result.update({"income": round(income, 2), "expenses": round(expense, 2), "profit": round(income-expense, 2)})
    elif any(x in q for x in ("receivable", "customer outstanding", "debtors")):
        docs = await db.invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)
        result.update({"receivables": round(sum(float(d.get("amount_due") or 0) for d in docs), 2), "invoice_count": len(docs)})
    elif any(x in q for x in ("payable", "vendor outstanding", "creditors")):
        docs = await db.purchase_invoices.find({"company_id": cid}, {"_id": 0}).to_list(10000)
        result.update({"payables": round(sum(float(d.get("amount_due") or 0) for d in docs), 2), "invoice_count": len(docs)})
    elif "gst" in q:
        lines = await db.journal_lines.find({"company_id": cid}, {"_id": 0}).to_list(100000)
        accounts = {a.get("id"): a for a in await db.chart_of_accounts.find({"company_id": cid, "code": {"$in": ["2100", "1200"]}}, {"_id": 0}).to_list(10)}
        output = input_tax = 0.0
        for line in lines:
            acct = accounts.get(line.get("account_id"), {})
            if acct.get("code") == "2100": output += float(line.get("credit") or 0) - float(line.get("debit") or 0)
            elif acct.get("code") == "1200": input_tax += float(line.get("debit") or 0) - float(line.get("credit") or 0)
        result.update({"output_gst": round(output, 2), "input_gst": round(input_tax, 2), "net_gst": round(output-input_tax, 2)})
    else:
        result["message"] = "Finix can answer live accounting questions for profit/loss, receivables, payables and GST."
    return result
