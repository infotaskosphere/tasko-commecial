import hashlib
import io
import logging
import os
from datetime import datetime, timezone
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel

from backend.dependencies import db, get_current_user

logger = logging.getLogger("ai_document_workspace")

router = APIRouter(prefix="/workspace", tags=["AI Document Workspace"])


def _company_key(current_user: Any) -> str:
    company_id = getattr(current_user, "company_id", None)
    if isinstance(current_user, dict):
        company_id = current_user.get("company_id") or company_id
    user_id = getattr(current_user, "id", None)
    if isinstance(current_user, dict):
        user_id = current_user.get("id") or user_id
    if company_id:
        return str(company_id)
    # Keep internal/admin workspaces isolated rather than mixing tenants.
    return f"user:{user_id or 'unknown'}"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _result_snapshot(filename: str, file_hash: str, result: Any) -> Dict[str, Any]:
    if not isinstance(result, dict):
        result = {"analysis": str(result or "")}
    classification = result.get("classification") or {}
    if not isinstance(classification, dict):
        classification = {}
    return {
        "filename": filename,
        "file_hash": file_hash,
        "document_id": result.get("document_id") or result.get("id") or "",
        "document_type": result.get("document_type") or classification.get("document_type") or "Other",
        "classification": classification,
        "vendor_name": result.get("vendor_or_customer_name") or result.get("vendor_name") or "",
        "vendor_gstin": result.get("tax_registration_number") or result.get("vendor_gstin") or "",
        "invoice_number": result.get("invoice_number") or result.get("invoice_no") or "",
        "invoice_date": result.get("invoice_date") or "",
        "invoice_total": result.get("total_invoice_value") or result.get("invoice_total") or 0,
        "taxable_amount": result.get("taxable_value") or result.get("taxable_amount") or 0,
        "gst_amount": result.get("total_tax") or result.get("gst_amount") or 0,
        "analysis": str(result.get("analysis") or "")[:14000],
        "extracted": result,
    }


async def _workspace_docs(company_key: str, limit: int = 80) -> List[dict]:
    return await db.ai_document_workspace.find(
        {"company_key": company_key},
        {"_id": 0},
    ).sort("created_at", -1).to_list(limit)


async def _text_ai(prompt: str) -> str:
    """Use the configured text model for cross-document reasoning."""
    gemini_key = (
        os.environ.get("GEMINI_API_KEY")
        or os.environ.get("GOOGLE_API_KEY")
        or os.environ.get("GOOGLE_AI_STUDIO_API_KEY")
        or ""
    ).strip()
    provider = (os.environ.get("AI_PROVIDER") or "").strip().lower()

    if gemini_key and provider not in ("groq",):
        try:
            import google.generativeai as genai
            genai.configure(api_key=gemini_key)
            model = genai.GenerativeModel(
                (os.environ.get("GEMINI_TEXT_MODEL") or "gemini-2.5-flash").strip()
            )
            response = await model.generate_content_async(prompt)
            return str(getattr(response, "text", "") or "").strip()
        except Exception as exc:
            logger.warning("Gemini workspace reasoning failed; trying Groq: %s", exc)

    groq_key = os.environ.get("GROQ_API_KEY", "").strip()
    if groq_key:
        try:
            import httpx
            payload = {
                "model": os.environ.get(
                    "GROQ_TEXT_MODEL",
                    "llama-3.3-70b-versatile",
                ),
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "You are the persistent document intelligence layer of a business SaaS. "
                            "Use only the supplied workspace documents as evidence. Reconcile repeated "
                            "entities across documents, call out conflicts, and never invent missing data."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.15,
                "max_tokens": 5000,
            }
            async with httpx.AsyncClient(timeout=120) as client:
                response = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {groq_key}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                )
            if response.status_code == 200:
                return str(
                    response.json().get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                ).strip()
            logger.warning("Groq workspace reasoning returned %s", response.status_code)
        except Exception as exc:
            logger.warning("Groq workspace reasoning failed: %s", exc)

    return ""


def _context_text(docs: List[dict], max_chars: int = 60000) -> str:
    chunks: List[str] = []
    total = 0
    for doc in docs:
        chunk = (
            f"DOCUMENT: {doc.get('filename', '')}\n"
            f"TYPE: {doc.get('document_type', '')}\n"
            f"VENDOR/PARTY: {doc.get('vendor_name', '')}\n"
            f"GSTIN: {doc.get('vendor_gstin', '')}\n"
            f"INVOICE/REFERENCE: {doc.get('invoice_number', '')}\n"
            f"DATE: {doc.get('invoice_date', '')}\n"
            f"TOTAL: {doc.get('invoice_total', '')}\n"
            f"ANALYSIS: {doc.get('analysis', '')[:9000]}\n"
        )
        if total + len(chunk) > max_chars:
            break
        chunks.append(chunk)
        total += len(chunk)
    return "\n---\n".join(chunks)


async def _refresh_knowledge(company_key: str, trigger: str = "upload") -> Dict[str, Any]:
    docs = await _workspace_docs(company_key, 80)
    if not docs:
        return {"knowledge_version": 0, "summary": "No documents have been uploaded yet."}

    previous = await db.ai_workspace_knowledge.find_one(
        {"company_key": company_key}, {"_id": 0}
    )
    version = int((previous or {}).get("knowledge_version", 0)) + 1
    context = _context_text(docs)
    prompt = (
        "Build the persistent business knowledge for the uploaded document workspace.\n"
        "This is a mixed-document workspace: invoices, tax records, certificates, audit reports, "
        "identity/business documents, spreadsheets, images and other files may coexist.\n\n"
        "Produce a concise but information-dense knowledge snapshot with these sections:\n"
        "1. ENTITIES: businesses, proprietors/partners/directors/people and identifiers.\n"
        "2. REGISTRATIONS: GSTIN, PAN, trademark numbers/classes, MSME/other registrations.\n"
        "3. FINANCIALS: amounts, tax figures, bank details, accounting/tax periods and notable totals.\n"
        "4. DOCUMENT RELATIONSHIPS: which documents clearly belong to the same entity and why.\n"
        "5. CONFLICTS/UNCERTAINTIES: conflicting names, dates, identifiers or amounts; do not resolve by guessing.\n"
        "6. LEARNED PATTERNS: recurring vendors, document layouts, fields and terminology useful for future uploads.\n"
        "7. FUTURE EXTRACTION RULES: concrete instructions for using this workspace when a new document arrives.\n\n"
        "Every material fact must be traceable to one or more supplied document filenames.\n\n"
        + context
    )
    summary = await _text_ai(prompt)
    if not summary:
        summary = (
            "Persistent memory updated from "
            f"{len(docs)} document(s). Detailed model synthesis is unavailable until an AI text provider is configured."
        )

    record = {
        "company_key": company_key,
        "knowledge_version": version,
        "document_count": len(docs),
        "summary": summary[:50000],
        "source_document_ids": [d.get("document_id") or d.get("file_hash") for d in docs],
        "updated_at": _utc_now(),
        "trigger": trigger,
    }
    await db.ai_workspace_knowledge.update_one(
        {"company_key": company_key}, {"$set": record}, upsert=True
    )
    return {"knowledge_version": version, "summary": record["summary"], "document_count": len(docs)}


class WorkspaceQuery(BaseModel):
    question: str


@router.post("/analyze-documents")
async def analyze_documents(
    files: List[UploadFile] = File(...),
    current_user=Depends(get_current_user),
):
    """Analyze many documents in one workspace and update persistent learning."""
    if not files:
        raise HTTPException(status_code=400, detail="At least one document is required.")
    if len(files) > 25:
        raise HTTPException(status_code=400, detail="Maximum 25 documents per upload batch.")

    # Runtime import avoids a circular import: ai_document_reader registers this router.
    from backend.ai_document_reader import analyze_document

    company_key = _company_key(current_user)
    results: List[dict] = []
    errors: List[dict] = []

    for upload in files:
        filename = upload.filename or "uploaded_file"
        try:
            contents = await upload.read()
            if not contents:
                raise ValueError("The uploaded file is empty.")
            file_hash = hashlib.sha256(contents).hexdigest()
            replay = await db.ai_document_workspace.find_one(
                {"company_key": company_key, "file_hash": file_hash}, {"_id": 0}
            )
            if replay:
                results.append({
                    "filename": filename,
                    "reused_memory": True,
                    "document_id": replay.get("document_id") or file_hash,
                    "document_type": replay.get("document_type"),
                    "analysis": replay.get("analysis", ""),
                    "snapshot": replay,
                })
                continue

            # The existing reader is still the extraction engine. The workspace adds
            # persistence and cross-document reasoning around it.
            fresh_upload = UploadFile(
                file=io.BytesIO(contents),
                filename=filename,
                headers=upload.headers,
            )
            result = await analyze_document(file=fresh_upload, current_user=current_user)
            snapshot = _result_snapshot(filename, file_hash, result)
            snapshot.update({
                "company_key": company_key,
                "created_at": _utc_now(),
                "updated_at": _utc_now(),
            })
            await db.ai_document_workspace.update_one(
                {"company_key": company_key, "file_hash": file_hash},
                {"$set": snapshot},
                upsert=True,
            )
            results.append({
                "filename": filename,
                "reused_memory": False,
                "document_id": snapshot.get("document_id") or file_hash,
                "document_type": snapshot.get("document_type"),
                "analysis": snapshot.get("analysis", ""),
                "snapshot": snapshot,
            })
        except HTTPException as exc:
            errors.append({"filename": filename, "error": str(exc.detail)})
        except Exception as exc:
            logger.exception("Workspace document failed: %s", filename)
            errors.append({"filename": filename, "error": str(exc)})

    knowledge = await _refresh_knowledge(company_key, trigger="upload_batch")
    return {
        "processed": len(results),
        "failed": len(errors),
        "results": results,
        "errors": errors,
        "knowledge": knowledge,
    }


@router.get("/context")
async def get_workspace_context(current_user=Depends(get_current_user)):
    company_key = _company_key(current_user)
    docs = await _workspace_docs(company_key, 80)
    knowledge = await db.ai_workspace_knowledge.find_one(
        {"company_key": company_key}, {"_id": 0}
    )
    return {
        "document_count": len(docs),
        "documents": [
            {
                "document_id": d.get("document_id") or d.get("file_hash"),
                "filename": d.get("filename"),
                "document_type": d.get("document_type"),
                "vendor_name": d.get("vendor_name"),
                "vendor_gstin": d.get("vendor_gstin"),
                "invoice_number": d.get("invoice_number"),
                "invoice_date": d.get("invoice_date"),
                "invoice_total": d.get("invoice_total"),
                "created_at": d.get("created_at"),
            }
            for d in docs
        ],
        "knowledge": knowledge or {
            "knowledge_version": 0,
            "summary": "Upload documents to build persistent workspace knowledge.",
        },
    }


@router.post("/query")
async def query_workspace(body: WorkspaceQuery, current_user=Depends(get_current_user)):
    question = (body.question or "").strip()
    if not question:
        raise HTTPException(status_code=400, detail="Question is required.")
    company_key = _company_key(current_user)
    docs = await _workspace_docs(company_key, 80)
    if not docs:
        return {"answer": "No documents are stored in this workspace yet.", "document_count": 0}

    knowledge = await db.ai_workspace_knowledge.find_one(
        {"company_key": company_key}, {"_id": 0}
    ) or {}
    prompt = (
        "Answer the user's question using the persistent business workspace below. "
        "Use the document evidence and knowledge snapshot together. Cite filenames inline. "
        "If documents conflict, explicitly identify the conflict and do not guess.\n\n"
        f"PERSISTENT KNOWLEDGE:\n{str(knowledge.get('summary') or '')[:40000]}\n\n"
        f"DOCUMENTS:\n{_context_text(docs)}\n\n"
        f"QUESTION:\n{question}"
    )
    answer = await _text_ai(prompt)
    if not answer:
        answer = "The workspace AI provider is unavailable. The uploaded documents are stored, but I cannot answer the cross-document question right now."
    return {"answer": answer, "document_count": len(docs), "knowledge_version": knowledge.get("knowledge_version", 0)}
