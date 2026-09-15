"""
Posting Storage — persistence boundary for the Accounting Intelligence Engine.

This module intentionally contains persistence concerns only. It must not
invent accounting classifications or silently turn missing data into a valid
accounting event.
"""

from typing import Dict, Any, List, Optional
from datetime import datetime, timezone
import uuid

from backend.dependencies import db
from backend.accounting_ai.accounting_controls import (
    AccountingControlError,
    normalize_document_type,
    ensure_source_key,
)


def _required(value: Any, field: str) -> str:
    """Require a non-empty identifier at the persistence boundary."""
    if value is None or not str(value).strip():
        raise AccountingControlError(f"{field} is required.")
    return str(value).strip()


def _event_type(value: Any) -> str:
    """Canonicalize an accounting event without guessing a fallback."""
    event = normalize_document_type(value)
    if event == "UNCLASSIFIED":
        raise AccountingControlError(
            "Accounting event is unclassified; refusing to persist a guessed event type."
        )
    return event


class PostingStorage:
    @staticmethod
    async def save_ledger_learning(vendor_name: str, gstin: str, company_id: str, data: Dict[str, Any]) -> str:
        """Stores or updates vendor learning patterns within one company."""
        company_id = _required(company_id, "company_id")
        vendor_name = str(vendor_name or "").strip()
        gstin = str(gstin or "").strip()
        if not vendor_name and not gstin:
            raise AccountingControlError("Vendor name or GSTIN is required for ledger learning.")
        if not isinstance(data, dict):
            raise AccountingControlError("Ledger learning data must be an object.")

        now = datetime.now(timezone.utc).isoformat()
        doc = {
            "vendor_name": vendor_name,
            "gstin": gstin,
            "company_id": company_id,
            "preferred_ledger": data.get("preferred_ledger"),
            "frequency": data.get("frequency", 1),
            "corrections_count": data.get("corrections_count", 0),
            "department": data.get("department"),
            "cost_center": data.get("cost_center"),
            "project": data.get("project"),
            "narration_template": data.get("narration_template"),
            "updated_at": now,
        }
        await db.ledger_learning.update_one(
            {"vendor_name": vendor_name, "gstin": gstin, "company_id": company_id},
            {"$set": doc, "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now}},
            upsert=True,
        )
        return gstin or vendor_name

    @staticmethod
    async def get_ledger_learning(vendor_name: str, gstin: str, company_id: str) -> Optional[Dict[str, Any]]:
        """Retrieves learned ledger patterns only from the requested company."""
        company_id = _required(company_id, "company_id")
        vendor_name = str(vendor_name or "").strip()
        gstin = str(gstin or "").strip()
        query = {"company_id": company_id}
        if gstin:
            query["gstin"] = gstin
        elif vendor_name:
            query["vendor_name"] = vendor_name
        else:
            return None
        return await db.ledger_learning.find_one(query, {"_id": 0})

    @staticmethod
    async def save_posting_history(document_id: str, company_id: str, payload: Dict[str, Any]) -> str:
        """Persist posting state without defaulting an unknown event to PURCHASE."""
        document_id = _required(document_id, "document_id")
        company_id = _required(company_id, "company_id")
        if not isinstance(payload, dict):
            raise AccountingControlError("Posting history payload must be an object.")

        event = _event_type(payload.get("accounting_event"))
        now = datetime.now(timezone.utc).isoformat()
        doc_id = str(payload.get("id") or uuid.uuid4())
        doc = {
            "id": doc_id,
            "document_id": document_id,
            "company_id": company_id,
            "accounting_event": event,
            "posting_instructions": payload.get("posting_instructions", {}),
            "journal_entry_id": payload.get("journal_entry_id"),
            "voucher_id": payload.get("voucher_id"),
            "status": payload.get("status", "pending"),
            "created_at": payload.get("created_at") or now,
            "updated_at": now,
        }
        # One posting-history record per source document. Updating by the
        # tenant-scoped natural key makes retries idempotent and prevents
        # duplicate history rows for the same accounting document.
        await db.posting_history.update_one(
            {"company_id": company_id, "document_id": document_id},
            {"$set": doc, "$setOnInsert": {"id": doc_id, "created_at": doc["created_at"]}},
            upsert=True,
        )
        return doc_id

    @staticmethod
    async def get_posting_history_by_doc(document_id: str, company_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """Retrieves posting history, optionally scoped explicitly to a company."""
        document_id = _required(document_id, "document_id")
        query = {"document_id": document_id}
        if company_id is not None:
            query["company_id"] = _required(company_id, "company_id")
        return await db.posting_history.find_one(query, {"_id": 0})

    @staticmethod
    async def save_journal_template(company_id: str, name: str, lines: List[Dict[str, Any]]) -> str:
        """Stores a reusable journal template for automation."""
        company_id = _required(company_id, "company_id")
        name = _required(name, "name")
        if not isinstance(lines, list) or not lines:
            raise AccountingControlError("Journal template requires at least one line.")
        if any(not isinstance(line, dict) for line in lines):
            raise AccountingControlError("Every journal template line must be an object.")

        now = datetime.now(timezone.utc).isoformat()
        template_id = str(uuid.uuid4())
        doc = {
            "id": template_id,
            "company_id": company_id,
            "name": name,
            "lines": lines,
            "created_at": now,
            "updated_at": now,
        }
        await db.journal_templates.insert_one(doc)
        return template_id

    @staticmethod
    async def get_journal_template(company_id: str, name: str) -> Optional[Dict[str, Any]]:
        """Retrieves a journal template within the requested company."""
        company_id = _required(company_id, "company_id")
        name = _required(name, "name")
        return await db.journal_templates.find_one(
            {"company_id": company_id, "name": name}, {"_id": 0}
        )

    @staticmethod
    async def save_accounting_rules(company_id: str, event_type: str, rules: Dict[str, Any]) -> str:
        """Stores company-specific rules for one exact accounting event."""
        company_id = _required(company_id, "company_id")
        event = _event_type(event_type)
        if not isinstance(rules, dict):
            raise AccountingControlError("Accounting rules must be an object.")

        now = datetime.now(timezone.utc).isoformat()
        await db.accounting_rules.update_one(
            {"company_id": company_id, "event_type": event},
            {
                "$set": {"rules": rules, "updated_at": now},
                "$setOnInsert": {"id": str(uuid.uuid4()), "created_at": now},
            },
            upsert=True,
        )
        return event

    @staticmethod
    async def get_accounting_rules(company_id: str, event_type: str) -> Optional[Dict[str, Any]]:
        """Retrieves rules for the exact requested accounting event."""
        company_id = _required(company_id, "company_id")
        event = _event_type(event_type)
        return await db.accounting_rules.find_one(
            {"company_id": company_id, "event_type": event}, {"_id": 0}
        )

    @staticmethod
    async def save_financial_validation(document_id: str, report: Dict[str, Any]) -> str:
        """Saves verification reports; a missing pass flag fails closed."""
        document_id = _required(document_id, "document_id")
        if not isinstance(report, dict):
            raise AccountingControlError("Financial validation report must be an object.")

        now = datetime.now(timezone.utc).isoformat()
        validation_id = str(uuid.uuid4())
        doc = {
            "id": validation_id,
            "document_id": document_id,
            "report": report,
            "passed": report.get("passed") is True,
            "errors": report.get("errors", []),
            "warnings": report.get("warnings", []),
            "created_at": now,
        }
        await db.financial_validations.insert_one(doc)
        return validation_id

    @staticmethod
    async def save_voucher_history(voucher_id: str, company_id: str, data: Dict[str, Any]) -> str:
        """Stores voucher history under a tenant-scoped immutable voucher id."""
        voucher_id = _required(voucher_id, "voucher_id")
        company_id = _required(company_id, "company_id")
        if not isinstance(data, dict):
            raise AccountingControlError("Voucher data must be an object.")

        now = datetime.now(timezone.utc).isoformat()
        voucher_type = data.get("voucher_type")
        if voucher_type is not None:
            voucher_type = _event_type(voucher_type)
        else:
            raise AccountingControlError("voucher_type is required.")

        doc = {
            "id": voucher_id,
            "company_id": company_id,
            "voucher_type": voucher_type,
            "voucher_number": data.get("voucher_number"),
            "document_id": data.get("document_id"),
            "journal_entry_id": data.get("journal_entry_id"),
            "party_name": data.get("party_name"),
            "total_amount": data.get("total_amount", 0.0),
            "details": data.get("details", {}),
            "created_at": data.get("created_at") or now,
            "updated_at": now,
        }
        await db.voucher_history.update_one(
            {"id": voucher_id, "company_id": company_id},
            {"$set": doc, "$setOnInsert": {"created_at": doc["created_at"]}},
            upsert=True,
        )
        return voucher_id

    @staticmethod
    async def save_posting_audit(audit_data: Dict[str, Any]) -> str:
        """Append a posting audit record with a required tenant and document context."""
        if not isinstance(audit_data, dict):
            raise AccountingControlError("Posting audit data must be an object.")
        company_id = _required(audit_data.get("company_id"), "company_id")
        document_id = _required(audit_data.get("document_id"), "document_id")

        now = datetime.now(timezone.utc).isoformat()
        audit_id = str(uuid.uuid4())
        doc = {
            "id": audit_id,
            "posting_time": now,
            "posting_user": audit_data.get("user_id"),
            "document_id": document_id,
            "company_id": company_id,
            "ai_recommendation": audit_data.get("ai_recommendation"),
            "final_decision": audit_data.get("final_decision"),
            "corrections": audit_data.get("corrections", {}),
            "journal_version": audit_data.get("journal_version", 1),
            "voucher_version": audit_data.get("voucher_version", 1),
            "approval_history": audit_data.get("approval_history", []),
            "checksum": audit_data.get("checksum"),
        }
        await db.posting_audit.insert_one(doc)
        return audit_id
