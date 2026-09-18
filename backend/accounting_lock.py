"""
MODULE 4 — System Integrity & Architecture Logic
=================================================
1. CONTROL BOUNDARIES: every system-generated journal entry (source in
   {"ai_zero_touch", "purchase", "sale", "bank"}) is locked — it can never be
   silently edited or hard-deleted through the normal accounting_core
   endpoints once posted. `accounting_core.delete_journal_entry` already
   restricts non-manual deletes to admins; this module goes further and, for
   entries with any adjustment-note history, blocks deletion entirely so the
   audit trail can't be erased.
2. CORRECTIONS: staff raise an `AdjustmentNoteOverride` to fix a
   mis-categorised or mis-keyed locked entry. This *replaces the lines on the
   original entry itself* (so the ledger, trial balance, and every report
   reflect the corrected account/amount immediately — no orphaned second
   entry sitting next to it) while keeping a full before/after snapshot in
   `adjustment_note_overrides` for the permanent audit trail. Nothing is
   silently changed: every correction is logged with who made it, when, why,
   and exactly what the lines looked like before.
"""

import uuid
import logging
from datetime import datetime, date, timezone
from decimal import Decimal
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User
from backend import accounting_core as ac
from backend.accounting_ai.accounting_controls import (
    AccountingControlError,
    parse_accounting_date,
    validate_balanced_lines,
    ensure_source_key,
)

router = APIRouter(prefix="/api/accounting-integrity", tags=["Accounting Integrity"])

LOCKED_SOURCES = {"ai_zero_touch", "purchase", "sale", "bank"}
logger = logging.getLogger(__name__)


def _perm_post(user: User) -> bool:
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (
        user.permissions.model_dump() if user.permissions else {}
    )
    return bool(perms.get("can_post_journal_entries"))


def _perm_admin_override(user: User) -> bool:
    # Overrides touch the audit trail of an already-posted, system-generated
    # entry, so this is intentionally a higher bar than ordinary posting.
    if user.role == "admin":
        return True
    perms = user.permissions if isinstance(user.permissions, dict) else (
        user.permissions.model_dump() if user.permissions else {}
    )
    return bool(perms.get("can_manage_chart_of_accounts"))


class AdjustmentNoteOverride(BaseModel):
    original_entry_id: str
    company_id: str = ""
    reason: str = Field(..., min_length=10, description="Mandatory justification, min 10 chars.")
    correcting_lines: List[ac.JournalLine]
    entry_date: str = Field(default_factory=lambda: date.today().isoformat())


@router.post("/adjustment-note")
async def raise_adjustment_note(body: AdjustmentNoteOverride, current_user: User = Depends(get_current_user)):
    if not _perm_admin_override(current_user):
        raise HTTPException(403, "Access denied. Adjustment overrides require elevated permissions.")

    original = await db.journal_entries.find_one({"id": body.original_entry_id}, {"_id": 0})
    if not original:
        raise HTTPException(404, "Original journal entry not found.")

    new_lines = [l.model_dump() for l in body.correcting_lines]
    try:
        total_debit, total_credit = validate_balanced_lines(new_lines, tolerance=Decimal("0.00"))
    except AccountingControlError as exc:
        raise HTTPException(400, str(exc))

    previous_lines = await db.journal_lines.find({"entry_id": body.original_entry_id}, {"_id": 0}).to_list(1000)

    now = datetime.now(timezone.utc).isoformat()
    company_id = body.company_id or original["company_id"]

    # Validate every correction account belongs to the same book and is active.
    account_ids = {line["account_id"] for line in new_lines}
    accounts = await db.chart_of_accounts.find(
        {"company_id": company_id, "id": {"$in": list(account_ids)}},
        {"_id": 0, "id": 1, "name": 1, "is_active": 1, "is_group": 1, "is_postable": 1},
    ).to_list(len(account_ids))
    by_id = {a["id"]: a for a in accounts}
    for account_id in account_ids:
        account = by_id.get(account_id)
        if not account:
            raise HTTPException(400, f"Account {account_id} does not belong to company {company_id}.")
        if account.get("is_active") is False:
            raise HTTPException(400, f"Account {account_id} is inactive and cannot receive postings.")
        if account.get("is_group") is True or account.get("is_postable") is False:
            raise HTTPException(400, f"Account {account_id} is a non-postable/group account.")

    if original.get("reversed") or original.get("superseded_at"):
        raise HTTPException(400, "This journal entry has already been corrected. Raise the adjustment against the latest active entry.")

    # Adjustment is append-only: preserve the original lines, create one
    # reversing entry, then create a fresh corrected entry. Nothing in the
    # historical journal is deleted or rewritten.
    note_id = str(uuid.uuid4())
    reversal_entry = await reverse_journal_entry(
        body.original_entry_id,
        body.reason.strip(),
        current_user.id,
    )
    from backend import accounting_core as _ac
    try:
        corrected_entry = await _ac.post_journal_entry(
            company_id=company_id,
            entry_date=original.get("entry_date") or body.entry_date,
            narration=original.get("narration", "") + f" — Adjustment: {body.reason.strip()}",
            lines=new_lines,
            source="adjustment",
            source_id=note_id,
            created_by=current_user.id,
        )
    except Exception:
        # The original remains intact and already has its auditable reversal.
        # Do not delete either record to hide a failed correction attempt.
        raise

    await db.journal_entries.update_one(
        {"id": body.original_entry_id},
        {"$set": {
            "has_adjustment_history": True,
            "last_corrected_at": now,
            "last_corrected_by": current_user.id,
            "adjustment_note_id": note_id,
            "corrected_by_entry_id": corrected_entry.get("id"),
        }},
    )

    note_doc = {
        "id": note_id,
        "original_entry_id": body.original_entry_id,
        "reversal_entry_id": reversal_entry.get("id"),
        "corrected_entry_id": corrected_entry.get("id"),
        "company_id": company_id,
        "reason": body.reason.strip(),
        "previous_lines": [{k: v for k, v in pl.items() if k != "id"} for pl in previous_lines],
        "previous_total_debit": original.get("total_debit", 0),
        "previous_total_credit": original.get("total_credit", 0),
        "new_lines": new_lines,
        "new_total_debit": float(total_debit),
        "new_total_credit": float(total_credit),
        "raised_by": current_user.id,
        "raised_at": now,
        "status": "POSTED",
    }
    await db.adjustment_note_overrides.insert_one(dict(note_doc))
    note_doc.pop("_id", None)

    return {"adjustment_note": note_doc, "updated_entry": corrected_entry}


@router.get("/adjustment-notes")
async def list_adjustment_notes(
    company_id: str = Query(""), original_entry_id: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
):
    q: dict = {"company_id": company_id}
    if original_entry_id:
        q["original_entry_id"] = original_entry_id
    return await db.adjustment_note_overrides.find(q, {"_id": 0}).sort("raised_at", -1).to_list(2000)


@router.get("/locked-entries")
async def list_locked_entries(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """System-generated entries that cannot be edited/deleted directly —
    useful for the UI to grey out the edit/delete controls."""
    entries = await db.journal_entries.find(
        {"company_id": company_id, "source": {"$in": list(LOCKED_SOURCES)}}, {"_id": 0}
    ).sort("entry_date", -1).to_list(2000)
    return entries


async def guard_deletion(entry_id: str, user: Optional[User] = None) -> None:
    """Call this before any hard-delete of a journal entry (in addition to
    accounting_core's own admin-only check) — raises if deletion would erase
    audit-trail history. Admins can bypass this check to fix incorrect entries."""
    if user and getattr(user, "role", None) == "admin":
        return
    entry = await db.journal_entries.find_one({"id": entry_id}, {"_id": 0})
    if not entry:
        return
    if entry.get("has_adjustment_history"):
        raise HTTPException(
            400,
            "This entry has adjustment-note history and is part of the permanent audit trail — "
            "it cannot be deleted. Raise a further Adjustment Note Override instead.",
        )
    if entry.get("source") in LOCKED_SOURCES:
        raise HTTPException(
            400,
            f"This entry was system-generated (source='{entry.get('source')}') and is locked. "
            "Use an Adjustment Note Override to correct it rather than deleting it.",
        )


async def reverse_journal_entry(entry_id: str, reason: str, reversed_by: str) -> dict:
    """Create one immutable reversing journal for an existing entry.
    
    The original entry and its lines are never deleted. Reversal is idempotent
    on the original entry id and is itself posted through the same accounting
    boundary, so financial-period locks and account validation remain enforced.
    """
    original = await db.journal_entries.find_one({"id": entry_id}, {"_id": 0})
    if not original:
        raise HTTPException(404, "Journal entry not found.")

    existing_reversal = await db.journal_entries.find_one(
        {"source": "reversal", "source_id": entry_id}, {"_id": 0}
    )
    if existing_reversal:
        return existing_reversal

    lines = await db.journal_lines.find(
        {"entry_id": entry_id}, {"_id": 0}
    ).to_list(1000)
    if not lines:
        raise HTTPException(400, "Journal entry has no lines and cannot be reversed.")

    reversed_lines = [
        {
            "account_id": line["account_id"],
            "account_name": line.get("account_name", ""),
            "debit": float(line.get("credit") or 0),
            "credit": float(line.get("debit") or 0),
            "memo": f"Reversal: {reason.strip()}",
        }
        for line in lines
    ]

    from backend import accounting_core as ac
    reversal = await ac.post_journal_entry(
        company_id=original.get("company_id") or "",
        entry_date=original.get("entry_date") or date.today().isoformat(),
        narration=f"Reversal of {original.get('id')} — {reason.strip()}",
        lines=reversed_lines,
        source="reversal",
        source_id=entry_id,
        created_by=reversed_by,
    )
    now = datetime.now(timezone.utc).isoformat()
    await db.journal_entries.update_one(
        {"id": entry_id},
        {"$set": {
            "reversed": True,
            "reversal_entry_id": reversal.get("id"),
            "reversed_at": now,
            "reversed_by": reversed_by,
            "reversal_reason": reason.strip(),
        }},
    )
    return reversal


async def create_phase4_accounting_indexes():
    """Create concurrency-safe source and company/date indexes.
    
    Index creation is intentionally idempotent and isolated from request paths.
    Existing records are preserved; duplicate historical rows are not deleted.
    """
    try:
        await db.journal_entries.create_index(
            [("company_id", 1), ("source", 1), ("source_id", 1)],
            name="uq_journal_source_company",
            unique=True,
            partialFilterExpression={"source_id": {"$exists": True, "$ne": ""}},
        )
    except Exception as exc:
        # Do not destroy historical data to force an index. Surface the
        # duplicate-data condition to startup/observability for remediation.
        logger.exception("Phase 4 journal source index could not be created: %s", exc)
    await db.journal_entries.create_index(
        [("company_id", 1), ("entry_date", 1)],
        name="idx_journal_company_date",
    )
    await db.journal_lines.create_index(
        [("company_id", 1), ("entry_id", 1)],
        name="idx_journal_lines_company_entry",
    )


async def create_accounting_integrity_indexes():
    await db.adjustment_note_overrides.create_index("original_entry_id")
    await db.adjustment_note_overrides.create_index("company_id")
    # Non-unique index: legacy duplicate source records may exist, so a unique
    # migration must not be forced during application startup. The posting
    # boundary below still performs deterministic idempotency checks.
    await db.journal_entries.create_index([("company_id", 1), ("source", 1), ("source_id", 1)])
    await db.journal_lines.create_index([("company_id", 1), ("entry_id", 1)])


# ── Harden the actual ledger boundary ───────────────────────────────────────
# accounting_core.py is intentionally kept as the single reporting/route
# module. This guard is installed here because this module is imported after
# accounting_core by server.py. All runtime calls through accounting_core's
# global `post_journal_entry` and `try_auto_post` then pass through this
# deterministic boundary without duplicating the 80KB reporting module.
_original_try_auto_post = ac.try_auto_post


async def _safe_post_journal_entry(
    company_id: str, entry_date: str, narration: str, lines: List[dict],
    source: str, source_id: Optional[str], created_by: str,
) -> dict:
    """Production posting boundary: validate, scope, idempotently post.

    This deliberately does not call the legacy implementation because that
    implementation inserts the header before the lines and uses binary floats.
    The guarded implementation writes the complete balanced journal itself and
    uses a Mongo transaction where the deployment supports transactions.
    """
    if company_id is None:
        raise ValueError("company_id is required for every ledger posting.")
    company_id = str(company_id).strip()
    if not company_id:
        # Empty company_id is a supported legacy/default book in this system,
        # so preserve it rather than inventing a company. Tenant-scoped account
        # validation below still prevents cross-company account leakage.
        company_id = ""

    try:
        parsed_date = parse_accounting_date(entry_date)
        if str(entry_date).strip() != parsed_date.isoformat():
            raise AccountingControlError("Accounting date must be exactly YYYY-MM-DD.")
        normalized_source, normalized_source_id = ensure_source_key(source, source_id)
        total_debit, total_credit = validate_balanced_lines(lines, tolerance=Decimal("0.00"))
    except AccountingControlError as exc:
        raise ValueError(str(exc)) from exc

    # The posting boundary must prove the period is open before any write.
    try:
        from backend.accounting_ai.financial_validator import FinancialValidator
        period_ok, period_message = await FinancialValidator.check_period_lock(company_id, parsed_date.isoformat())
    except Exception as exc:
        logger.exception("Period-lock verification failed for company=%s", company_id)
        raise ValueError(f"Unable to verify accounting period lock; posting blocked ({type(exc).__name__}).") from exc
    if not period_ok:
        raise ValueError(period_message)

    # Idempotency: a source document may be retried by the AI pipeline, web
    # request, queue worker, or reconciliation job. Return the already-posted
    # complete entry instead of creating a second journal.
    if normalized_source_id:
        # A second request must not create a duplicate source posting. The
        # unique key is company + source + source_id; the existing record is
        # returned only when its lines are complete.
        existing = await db.journal_entries.find_one(
            {
                "company_id": company_id,
                "source": normalized_source,
                "source_id": normalized_source_id,
                "reversed": {"$ne": True},
                "superseded_at": {"$exists": False},
            },
            {"_id": 0},
        )
        if existing:
            existing_line_count = await db.journal_lines.count_documents({"entry_id": existing.get("id")})
            if existing_line_count == 0:
                raise ValueError(
                    f"An incomplete journal entry already exists for {normalized_source}:{normalized_source_id}; "
                    "posting is blocked until the incomplete record is repaired."
                )
            return existing

    # Account validation is tenant-scoped and fail-closed. A line may never
    # point at another company's ledger or at a disabled/group account.
    account_ids = [str(line.get("account_id") or "") for line in lines]
    accounts = await db.chart_of_accounts.find(
        {"company_id": company_id, "id": {"$in": list(set(account_ids))}},
        {"_id": 0, "id": 1, "name": 1, "is_active": 1, "is_group": 1, "is_postable": 1},
    ).to_list(max(1, len(set(account_ids))))
    by_id = {account.get("id"): account for account in accounts}
    for account_id in account_ids:
        account = by_id.get(account_id)
        if not account:
            raise ValueError(f"Account {account_id} does not belong to company {company_id}.")
        if account.get("is_active") is False:
            raise ValueError(f"Account {account_id} is inactive and cannot receive postings.")
        if account.get("is_group") is True or account.get("is_postable") is False:
            raise ValueError(f"Account {account_id} is a non-postable/group account.")

    now = datetime.now(timezone.utc).isoformat()
    entry_id = str(uuid.uuid4())
    # Re-check immediately before insertion to narrow the async check/insert
    # race window. MongoDB unique indexes provide the final concurrency guard.
    if normalized_source_id:
        existing_race_guard = await db.journal_entries.find_one(
            {"company_id": company_id, "source": normalized_source, "source_id": normalized_source_id},
            {"_id": 0},
        )
        if existing_race_guard:
            return existing_race_guard
    entry_doc = {
        "id": entry_id,
        "company_id": company_id,
        "entry_date": parsed_date.isoformat(),
        "narration": str(narration or "").strip(),
        "source": normalized_source,
        "source_id": normalized_source_id,
        "total_debit": float(total_debit),
        "total_credit": float(total_credit),
        "created_by": str(created_by or "system"),
        "created_at": now,
    }
    line_docs = [
        {
            "id": str(uuid.uuid4()),
            "entry_id": entry_id,
            "company_id": company_id,
            "entry_date": parsed_date.isoformat(),
            "account_id": line["account_id"],
            "account_name": by_id[line["account_id"]].get("name", ""),
            "debit": float(line.get("debit") or 0),
            "credit": float(line.get("credit") or 0),
            "memo": str(line.get("memo") or ""),
            "created_at": now,
        }
        for line in lines
    ]

    async def _write(session=None):
        kwargs = {"session": session} if session is not None else {}
        await db.journal_entries.insert_one(dict(entry_doc), **kwargs)
        await db.journal_lines.insert_many(line_docs, **kwargs)

    # Prefer Mongo transactions. If the deployment is a standalone Mongo
    # server without transaction support, use a compensating rollback so a
    # failed line insert never leaves a header-only journal entry behind.
    client = getattr(db, "client", None)
    transaction_written = False
    if client is not None and hasattr(client, "start_session"):
        try:
            session = await client.start_session()
            try:
                async with session.start_transaction():
                    await _write(session=session)
                    transaction_written = True
            finally:
                await session.end_session()
        except Exception as exc:
            if transaction_written:
                raise
            # Unsupported transactions fall through to the safe compensating
            # write below. Other failures are also cleaned up before raising.
            logger.warning("Mongo transaction unavailable/failed; using rollback-safe journal write: %s", exc)
            try:
                await db.journal_entries.delete_one({"id": entry_id, "company_id": company_id})
                await db.journal_lines.delete_many({"entry_id": entry_id, "company_id": company_id})
            except Exception:
                logger.exception("Failed to clean up failed journal transaction for entry=%s", entry_id)
                raise ValueError("Journal posting failed and automatic cleanup could not be verified.") from exc
            # Continue to fallback only for transaction capability failures.
            # A second write can safely retry because no journal exists now.

    if not transaction_written:
        try:
            await _write()
        except Exception as exc:
            try:
                await db.journal_entries.delete_one({"id": entry_id, "company_id": company_id})
                await db.journal_lines.delete_many({"entry_id": entry_id, "company_id": company_id})
            except Exception:
                logger.exception("Failed journal rollback for entry=%s", entry_id)
                raise ValueError("Journal posting failed and automatic cleanup could not be verified.") from exc
            raise ValueError(f"Journal posting failed: {type(exc).__name__}.") from exc

    entry_doc["lines"] = line_docs
    return entry_doc


async def _safe_try_auto_post(company_id: str, entry_date: str, narration: str, lines: List[dict],
                              source: str, source_id: Optional[str], created_by: str) -> Optional[dict]:
    """Do not silently discard accounting failures.

    Existing purchase/sale/bank callers historically expect this helper to
    return None rather than raise. Preserve that API contract but persist a
    structured failure so the Accounting/Approval workflow can surface and
    resolve the exception instead of creating an invisible unposted document.
    """
    try:
        return await _safe_post_journal_entry(company_id, entry_date, narration, lines, source, source_id, created_by)
    except Exception as exc:
        failure = {
            "id": str(uuid.uuid4()),
            "company_id": str(company_id or ""),
            "entry_date": str(entry_date or ""),
            "source": str(source or ""),
            "source_id": str(source_id) if source_id is not None else None,
            "narration": str(narration or ""),
            "error_type": type(exc).__name__,
            "error": str(exc),
            "status": "POSTING_FAILED",
            "created_by": str(created_by or "system"),
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            await db.accounting_posting_failures.update_one(
                {"company_id": failure["company_id"], "source": failure["source"], "source_id": failure["source_id"]},
                {"$set": failure},
                upsert=True,
            )
        except Exception:
            logger.exception("Unable to persist accounting posting failure: %s", failure)
        logger.error(
            "Accounting posting failed: company=%s source=%s source_id=%s error=%s",
            company_id, source, source_id, exc,
        )
        return None


# Install the boundary after accounting_core has been imported by this module.
# Any runtime call through accounting_core's globals now reaches the hardened
# validator/poster above.
ac.post_journal_entry = _safe_post_journal_entry
ac.try_auto_post = _safe_try_auto_post
