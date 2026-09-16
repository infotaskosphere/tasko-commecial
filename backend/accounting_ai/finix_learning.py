"""Governed Finix learning memory.

Finix learns from structured accounting outcomes, not by rewriting production
code or accounting rules. Approved outcomes become company-scoped evidence
that can be retrieved on later proposals.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from backend.dependencies import db


def _key(value: Any) -> str:
    return " ".join(str(value or "").strip().lower().split())


async def get_learning_context(company_id: str, event: str, party_name: str = "") -> dict:
    q = {"company_id": company_id, "event": event}
    if party_name:
        q["party_key"] = _key(party_name)
    docs = await db.finix_ai_learning.find(q, {"_id": 0}).sort("approved_count", -1).to_list(10)
    return {
        "matches": docs,
        "learned": bool(docs),
        "message": "Finix found prior approved accounting patterns for this company." if docs else "No prior approved pattern found; Finix will rely on current context and governed rules.",
    }


async def record_learning(
    company_id: str,
    event: str,
    party_name: str,
    proposal: dict,
    outcome: str,
    user_id: str,
    correction: Optional[dict] = None,
) -> None:
    """Store evidence from an approved/rejected/corrected proposal.

    This is intentionally evidence-only: it never changes accounting policy,
    chart-of-accounts rules, validators, or posting permissions.
    """
    party_key = _key(party_name)
    account_ids = [str(x.get("account_id")) for x in proposal.get("lines", []) if x.get("account_id")]
    now = datetime.now(timezone.utc).isoformat()
    query = {"company_id": company_id, "event": event, "party_key": party_key}
    existing = await db.finix_ai_learning.find_one(query, {"_id": 0})

    if existing:
        update = {
            "$set": {"last_outcome": outcome, "last_user_id": user_id, "updated_at": now, "last_account_ids": account_ids},
            "$inc": {"approved_count": 1 if outcome == "APPROVED_POSTED" else 0, "correction_count": 1 if outcome == "CORRECTED" else 0, "rejection_count": 1 if outcome == "REJECTED" else 0},
        }
        if correction:
            update["$set"]["last_correction"] = correction
        await db.finix_ai_learning.update_one({"id": existing["id"]}, update)
        return

    import uuid
    await db.finix_ai_learning.insert_one({
        "id": str(uuid.uuid4()), "company_id": company_id, "event": event,
        "party_key": party_key, "party_name": party_name, "last_account_ids": account_ids,
        "last_outcome": outcome, "last_user_id": user_id,
        "approved_count": 1 if outcome == "APPROVED_POSTED" else 0,
        "correction_count": 1 if outcome == "CORRECTED" else 0,
        "rejection_count": 1 if outcome == "REJECTED" else 0,
        "last_correction": correction, "created_at": now, "updated_at": now,
    })


async def create_finix_learning_indexes() -> None:
    await db.finix_ai_learning.create_index([("company_id", 1), ("event", 1), ("party_key", 1)], unique=True)
    await db.finix_ai_learning.create_index([("company_id", 1), ("updated_at", -1)])
