"""Evidence-based vendor ledger learning for Finix."""

from typing import Dict, Any, Optional
from datetime import datetime, timezone
import logging
from backend.dependencies import db
from backend.accounting_ai.posting_storage import PostingStorage

logger = logging.getLogger("ledger_learning")

MIN_RECOMMENDATION_FREQUENCY = 3
MAX_AUTO_CONFIDENCE = 0.90

class LedgerLearningEngine:
    @staticmethod
    async def get_recommendation(vendor_name: str, gstin: str, company_id: str) -> Optional[Dict[str, Any]]:
        if not company_id or (not vendor_name and not gstin):
            return None
        try:
            record = await PostingStorage.get_ledger_learning(vendor_name, gstin, company_id)
            if not record:
                return None
            frequency = int(record.get("frequency", 0) or 0)
            corrections = int(record.get("corrections_count", 0) or 0)
            if frequency < MIN_RECOMMENDATION_FREQUENCY:
                return None
            confidence = min(MAX_AUTO_CONFIDENCE, 0.55 + frequency * 0.07 - corrections * 0.12)
            if confidence < 0.75:
                return None
            return {
                "preferred_ledger": record.get("preferred_ledger"),
                "department": record.get("department"),
                "cost_center": record.get("cost_center"),
                "project": record.get("project"),
                "confidence_score": round(confidence, 4),
                "evidence_count": frequency,
                "corrections_count": corrections,
                "requires_review": confidence < 0.90,
            }
        except Exception:
            logger.exception("Error reading ledger learning recommendation")
            return None

    @staticmethod
    async def learn_from_approval(vendor_name: str, gstin: str, company_id: str, approved_ledger_code: str, meta: Optional[Dict[str, Any]] = None):
        if not company_id or not approved_ledger_code or (not vendor_name and not gstin):
            return
        now = datetime.now(timezone.utc).isoformat()
        meta = meta or {}
        try:
            existing = await PostingStorage.get_ledger_learning(vendor_name, gstin, company_id)
            if existing:
                same = existing.get("preferred_ledger") == approved_ledger_code
                corrections = int(existing.get("corrections_count", 0) or 0) + (0 if same else 1)
                frequency = int(existing.get("frequency", 0) or 0) + 1 if same else 1
                updates = {
                    "preferred_ledger": approved_ledger_code,
                    "frequency": frequency,
                    "corrections_count": corrections,
                    "updated_at": now,
                }
                for key in ("department", "cost_center", "project", "narration_template"):
                    if meta.get(key):
                        updates[key] = meta[key]
                await db.ledger_learning.update_one({"vendor_name": vendor_name, "gstin": gstin, "company_id": company_id}, {"$set": updates})
            else:
                await PostingStorage.save_ledger_learning(vendor_name, gstin, company_id, {
                    "preferred_ledger": approved_ledger_code,
                    "frequency": 1,
                    "corrections_count": 0,
                    "department": meta.get("department"),
                    "cost_center": meta.get("cost_center"),
                    "project": meta.get("project"),
                    "narration_template": meta.get("narration_template"),
                    "created_at": now,
                    "updated_at": now,
                })
        except Exception:
            logger.exception("Failed to record ledger learning patterns")
