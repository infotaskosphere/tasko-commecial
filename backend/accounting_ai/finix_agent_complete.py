"""Integrated Finix AI orchestration layer.

This module coordinates existing accounting, learning, invoice and bank data.
It deliberately does not replace the governed accounting posting engine.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime, date, timezone, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User
from backend.accounting_ai.finix_learning import get_learning_context, record_learning
from backend.accounting_ai.finix_ai_router import _build_proposal, _can_post, _can_view, _date
from backend.accounting_ai.finix_access import is_admin_role

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Agent"])


def _safe_float(value: Any, default: float = 0.0) -> float:
    """Normalize legacy accounting values without letting one malformed field crash Finix."""
    if value is None or value == "":
        return default
    try:
        if hasattr(value, "to_decimal"):
            return float(value.to_decimal())
        return float(value)
    except (TypeError, ValueError, OverflowError):
        return default


def _date_key(value: Any) -> str:
    """Normalize Mongo/date/string due dates to YYYY-MM-DD for forecast comparisons."""
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or "")[:10]


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
    return {"transactions": all_docs[:20], "invoice_count": len(all_docs), "outstanding": round(sum(_safe_float(d.get("amount_due")) for d in all_docs), 2)}


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
    if proposal.get("company_id") != getattr(current_user, "company_id", "") and not is_admin_role(current_user):
        raise HTTPException(403, "Proposal belongs to another company.")
    if proposal.get("created_by") != current_user.id and not is_admin_role(current_user):
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
    is_admin = is_admin_role(current_user)
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
            if acct.get("type") == "income": income += _safe_float(line.get("credit")) - _safe_float(line.get("debit"))
            elif acct.get("type") == "expense": expense += _safe_float(line.get("debit")) - _safe_float(line.get("credit"))
        result.update({"income": round(income, 2), "expenses": round(expense, 2), "profit": round(income-expense, 2)})
    elif any(x in q for x in ("receivable", "customer outstanding", "debtors")):
        from backend.accounting_ai import finix_metrics
        ledger = await finix_metrics.load_ledger(cid)
        result.update({"receivables": ledger.balance("1100", "dr"), "basis": "general ledger incl. party ledgers"})
    elif any(x in q for x in ("payable", "vendor outstanding", "creditors")):
        from backend.accounting_ai import finix_metrics
        ledger = await finix_metrics.load_ledger(cid)
        result.update({"payables": ledger.balance("2000", "cr"), "basis": "general ledger incl. party ledgers"})
    elif "gst" in q:
        from backend.accounting_ai import finix_metrics
        ledger = await finix_metrics.load_ledger(cid)
        output, input_tax = ledger.balance("2100", "cr"), ledger.balance("1200", "dr")
        result.update({"output_gst": output, "input_gst": input_tax, "net_gst": round(output - input_tax, 2)})
    elif any(x in q for x in ("tds", "tax deducted")):
        from backend.accounting_ai import finix_metrics
        ledger = await finix_metrics.load_ledger(cid)
        result.update({"tds_payable_balance": ledger.balance("2200", "cr"),
                       "challan_due": finix_metrics.tds_challan_due(date.today().replace(day=1))})
    elif any(x in q for x in ("health", "score", "audit", "trial balance")):
        lines = await db.journal_lines.find({"company_id": cid}, {"_id": 0, "debit": 1, "credit": 1}).to_list(100000)
        dr = sum(_safe_float(l.get("debit")) for l in lines)
        cr = sum(_safe_float(l.get("credit")) for l in lines)
        result.update({"trial_balance_debits": round(dr, 2), "trial_balance_credits": round(cr, 2), "balanced": abs(dr - cr) < 0.05})
    elif any(x in q for x in ("cash flow", "forecast", "runway")):
        from backend.accounting_ai import finix_metrics
        forecast = await finix_metrics.cashflow_forecast(cid)
        result.update({"current_cash_bank": forecast["current_cash"], "runway_months": forecast["runway_months"],
                       "forecast_30d": forecast["forecast_30d"], "forecast_90d": forecast["forecast_90d"]})
    else:
        result["message"] = "Finix can answer live accounting questions for profit/loss, receivables, payables, GST, TDS, trial balance and cash flow."
    return result


@router.get("/health-score")
async def agent_health_score(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import finix_metrics
    return await finix_metrics.health_score(_company(current_user, company_id))


@router.get("/statutory-summary")
async def agent_statutory_summary(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import finix_metrics
    return await finix_metrics.statutory_summary(_company(current_user, company_id))


@router.get("/anomalies")
async def agent_anomalies(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import finix_metrics
    return await finix_metrics.anomalies(_company(current_user, company_id))


@router.get("/cashflow-forecast")
async def agent_cashflow_forecast(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import finix_metrics
    return await finix_metrics.cashflow_forecast(_company(current_user, company_id))


@router.get("/ledger-diagnostics")
async def agent_ledger_diagnostics(company_id: str = "", current_user: User = Depends(get_current_user)):
    """List the journal entries behind negative receivables / phantom figures."""
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import finix_metrics
    return await finix_metrics.ledger_diagnostics(_company(current_user, company_id))


@router.post("/resync")
async def agent_resync(company_id: str = "", current_user: User = Depends(get_current_user)):
    """Re-run the books reconcile now: removes ledger entries whose invoice/payment/bill is gone
    (never touching locked-period or adjusted entries) and re-posts missing ones."""
    if not _can_post(current_user):
        raise HTTPException(403, "Re-syncing the books requires journal-posting permission.")
    cid = _company(current_user, company_id)
    from backend import invoicing
    await invoicing._reconcile_and_sync_all_sales_and_payments_impl(cid)
    await invoicing._reconcile_and_sync_all_purchases_and_payments_impl(cid)
    from backend.accounting_ai import finix_metrics
    return {"success": True, "remaining_findings": (await finix_metrics.ledger_diagnostics(cid))["count"]}


# ── Finix learning: accuracy, what was learned, admin reset ────────────────────

@router.get("/learning/accuracy")
async def learning_accuracy(company_id: str = "", days: int = 90, current_user: User = Depends(get_current_user)):
    """How often Finix read and classified purchase bills right first time (straight-through rate),
    overall, per vendor and by week. Counts only bills a person reviewed."""
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import invoice_learning
    return await invoice_learning.accuracy_report(_company(current_user, company_id), days)


@router.get("/learning/vendors")
async def learning_vendors(company_id: str = "", current_user: User = Depends(get_current_user)):
    """What Finix has learned about each vendor in this company."""
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    from backend.accounting_ai import invoice_learning
    return {"vendors": await invoice_learning.list_vendor_memory(_company(current_user, company_id))}


class ResetVendorRequest(BaseModel):
    vendor_key: str = Field(..., min_length=3, max_length=300)
    company_id: str = ""


@router.post("/learning/reset-vendor")
async def learning_reset_vendor(body: ResetVendorRequest, current_user: User = Depends(get_current_user)):
    """Admin only: make Finix forget what it learned about one vendor (ledger, GST rate, layout).
    Bills already posted are not changed; the reset itself is logged."""
    if not is_admin_role(current_user):
        raise HTTPException(403, "Only an admin can reset what Finix has learned.")
    from backend.accounting_ai import invoice_learning
    cid = _company(current_user, body.company_id)
    if not await invoice_learning.reset_vendor(cid, body.vendor_key, current_user.id):
        raise HTTPException(404, "Finix has no learned data for that vendor.")
    return {"success": True, "vendor_key": body.vendor_key}
