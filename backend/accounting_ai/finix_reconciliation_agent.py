"""Finix reconciliation helpers layered on the existing bank/accounting data."""
from __future__ import annotations
import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from backend.dependencies import db, get_current_user
from backend.models import User
from backend.accounting_ai.finix_learning import record_learning

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Reconciliation"])


def _view(user: User) -> bool:
    if str(user.role or "").lower() == "admin":
        return True
    p = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(p.get("can_view_journal_entries") or p.get("can_view_accounting_reports") or p.get("can_post_journal_entries") or p.get("can_view_bank"))


def _post(user: User) -> bool:
    if str(user.role or "").lower() == "admin":
        return True
    p = user.permissions if isinstance(user.permissions, dict) else (user.permissions.model_dump() if user.permissions else {})
    return bool(p.get("can_post_journal_entries"))


class TransferRequest(BaseModel):
    text: str = Field(..., min_length=2, max_length=2000)
    company_id: str = ""
    amount: float = 0.0
    source_bank_id: str = ""
    destination_bank_id: str = ""


class ReconciliationFeedback(BaseModel):
    bank_transaction_id: str
    matched_type: str = Field(..., min_length=1, max_length=100)
    matched_id: str = ""
    party_name: str = ""
    correction: dict | None = None


async def _banks(cid: str):
    return await db.bank_accounts.find({"company_id": cid}, {"_id": 0, "account_number_full": 0}).sort("is_primary", -1).to_list(100)


@router.post("/bank-transfer/propose")
async def propose_bank_transfer(payload: TransferRequest, current_user: User = Depends(get_current_user)):
    if not _view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not cid:
        raise HTTPException(400, "Select a company/book.")
    banks = await _banks(cid)
    if len(banks) < 2:
        return {"success": False, "status": "REVIEW_REQUIRED", "needs_clarification": ["At least two bank accounts are required for a bank transfer."], "banks": banks}
    lower = payload.text.lower()
    source = next((b for b in banks if b["id"] == payload.source_bank_id), None)
    destination = next((b for b in banks if b["id"] == payload.destination_bank_id), None)
    if not source:
        source = next((b for b in banks if any(str(b.get(k) or "").lower() in lower for k in ("bank_name", "ifsc"))), None)
    if not destination:
        destination = next((b for b in banks if b is not source and any(str(b.get(k) or "").lower() in lower for k in ("bank_name", "ifsc"))), None)
    if not source or not destination or source["id"] == destination["id"]:
        return {"success": False, "status": "REVIEW_REQUIRED", "needs_clarification": ["Select both the source bank account and destination bank account before posting the transfer."], "banks": banks}
    amount = float(payload.amount or 0)
    if amount <= 0:
        m = re.search(r"(?:₹|rs\.?|inr\s*)?\s*([0-9][0-9,]*(?:\.\d+)?)", payload.text, re.I)
        amount = float(m.group(1).replace(",", "")) if m else 0.0
    if amount <= 0:
        return {"success": False, "status": "REVIEW_REQUIRED", "needs_clarification": ["What is the transfer amount?"], "banks": banks}
    source_ledger = source.get("ledger_account_id") or source.get("account_id")
    destination_ledger = destination.get("ledger_account_id") or destination.get("account_id")
    if not source_ledger or not destination_ledger:
        return {"success": False, "status": "REVIEW_REQUIRED", "needs_clarification": ["The selected bank accounts are not linked to accounting ledgers yet. Link each bank account to its Chart of Accounts ledger first."], "banks": banks, "source_bank": source, "destination_bank": destination}
    lines = [
        {"account_id": destination_ledger, "account_name": destination.get("bank_name", "Destination bank"), "debit": amount, "credit": 0.0, "memo": "Bank transfer destination"},
        {"account_id": source_ledger, "account_name": source.get("bank_name", "Source bank"), "debit": 0.0, "credit": amount, "memo": "Bank transfer source"},
    ]
    return {"success": True, "status": "PROPOSED", "event": "BANK_TRANSFER", "amount": amount, "source_bank": source, "destination_bank": destination, "lines": lines, "message": "Review source and destination ledgers, then post through the governed accounting workflow."}


@router.get("/reconciliation/inbox")
async def reconciliation_inbox(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = (company_id or getattr(current_user, "company_id", "") or "").strip()
    txns = await db.bank_transactions.find({"company_id": cid, "$or": [{"matched_type": {"$exists": False}}, {"matched_type": ""}, {"matched_type": None}]}, {"_id": 0}).sort("date", -1).to_list(200)
    return {"items": txns, "count": len(txns)}


@router.post("/reconciliation/feedback")
async def reconciliation_feedback(payload: ReconciliationFeedback, current_user: User = Depends(get_current_user)):
    if not _view(current_user):
        raise HTTPException(403, "Access denied.")
    txn = await db.bank_transactions.find_one({"id": payload.bank_transaction_id}, {"_id": 0})
    if not txn:
        raise HTTPException(404, "Bank transaction not found.")
    cid = txn.get("company_id")
    if cid and cid != getattr(current_user, "company_id", "") and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Bank transaction belongs to another company.")
    await db.bank_transactions.update_one({"id": payload.bank_transaction_id}, {"$set": {"matched_type": payload.matched_type, "matched_id": payload.matched_id, "finix_learned_at": datetime.now(timezone.utc).isoformat()}})
    await record_learning(cid or getattr(current_user, "company_id", ""), "BANK_RECONCILIATION", payload.party_name or txn.get("description", ""), {"id": payload.bank_transaction_id, "transaction": txn, "matched_type": payload.matched_type, "matched_id": payload.matched_id}, "CORRECTED", current_user.id, payload.correction)
    return {"success": True, "learned": True, "bank_transaction_id": payload.bank_transaction_id}
