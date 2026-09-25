"""Finix AI Accounting workflow.

Natural language is used only to understand and propose an accounting action.
The existing party-ledger, chart-of-accounts and guarded journal-posting
boundary remain the source of truth for the actual books.
"""
from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.modules.finix_ai.ai.models_finix_ai import FinixAIRequest, FinixAIPostRequest

from backend.models import User
from backend.accounting_core import get_default_account_id
from backend.party_ledgers import get_or_create_party_account
from backend.accounting_ai.finix_intelligence import FinixIntelligence
from backend.accounting_ai.accounting_policy import classify_transaction

router = APIRouter(prefix="/finix/ai", tags=["Finix AI Accounting"])
PAISE = Decimal("0.01")




@router.post("/interpret")
async def finix_ai_interpret(payload: FinixAIRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return await _build_proposal(payload.text.strip(), company_id, _date(payload.accounting_date), current_user)


@router.post("/propose")
async def finix_ai_propose(payload: FinixAIRequest, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = (payload.company_id or getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(400, "Select a company/book before using Finix AI Accounting.")
    return await _build_proposal(payload.text.strip(), company_id, _date(payload.accounting_date), current_user)


@router.post("/post")
async def finix_ai_post(payload: FinixAIPostRequest, current_user: User = Depends(get_current_user)):
    if not _can_post(current_user):
        raise HTTPException(403, "Posting requires journal-posting permission.")
    proposal = await db.finix_ai_proposals.find_one({"id": payload.proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    if proposal.get("created_by") != current_user.id and str(current_user.role or "").lower() != "admin":
        raise HTTPException(403, "Only the proposal owner or an admin can post this proposal.")
    if proposal.get("status") == "POSTED":
        return {"success": True, "status": "POSTED", "journal_entry": proposal.get("journal_entry")}

    try:
        # accounting_lock.py installs the hardened post_journal_entry boundary
        # on this shared accounting_core symbol. We deliberately call that
        # shared function instead of creating a second AI posting engine.
        from backend import accounting_core as ac
        entry = await ac.post_journal_entry(
            proposal["company_id"], proposal["accounting_date"], proposal["narration"],
            proposal["lines"], "ai_zero_touch", proposal["id"], current_user.id,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Finix posting was blocked: {type(exc).__name__}: {exc}")

    now = datetime.now(timezone.utc).isoformat()
    await db.finix_ai_proposals.update_one(
        {"id": proposal["id"]},
        {"$set": {
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
                "source": "finix_ai",
            },
        }},
    )
    return {"success": True, "status": "POSTED", "journal_entry": entry, "message": "Transaction posted through the governed accounting ledger."}


@router.get("/proposal/{proposal_id}")
async def finix_ai_get_proposal(proposal_id: str, current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    proposal = await db.finix_ai_proposals.find_one({"id": proposal_id}, {"_id": 0})
    if not proposal:
        raise HTTPException(404, "Finix proposal not found.")
    return proposal


@router.get("/recent")
async def finix_ai_recent(company_id: str = "", current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    cid = (company_id or getattr(current_user, "company_id", "") or "").strip()
    return await db.finix_ai_proposals.find({"company_id": cid}, {"_id": 0}).sort("created_at", -1).to_list(50)


async def create_finix_ai_indexes():
    await db.finix_ai_proposals.create_index([("company_id", 1), ("created_at", -1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("status", 1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("source_id", 1)])
    await db.finix_ai_proposals.create_index([("company_id", 1), ("status", 1), ("id", 1)])
