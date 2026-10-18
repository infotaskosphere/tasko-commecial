import asyncio
import logging
from typing import Dict, Any

from backend.dependencies import db

logger = logging.getLogger("context_manager")


class ContextManager:
    @staticmethod
    async def gather_user_context(company_id: str, tenant_id: str) -> Dict[str, Any]:
        """Collect company-scoped metrics concurrently for AI prompt enrichment."""
        normalized_company_id = str(company_id or "").strip()
        result = {
            "company_id": normalized_company_id or None,
            "tenant_id": tenant_id,
            "unpaid_invoices_count": 0,
            "pending_tasks_count": 0,
            "clients_count": 0,
            "pending_invoices_to_review": 0,
            "pending_approvals": 0,
            "timestamp": True,
        }
        if not normalized_company_id or normalized_company_id == "default_comp":
            logger.warning("Copilot context requested without a valid company scope")
            return result

        scope = {"company_id": normalized_company_id}

        async def safe_count(collection, query, label: str) -> int:
            try:
                return await collection.count_documents(query)
            except Exception:
                logger.exception("Copilot context count failed for %s", label)
                return 0

        counts = await asyncio.gather(
            safe_count(
                db.invoices,
                {**scope, "status": {"$in": ["unpaid", "pending", "overdue", "partially_paid"]}},
                "unpaid_invoices",
            ),
            safe_count(
                db.tasks,
                {**scope, "status": {"$ne": "completed"}},
                "pending_tasks",
            ),
            safe_count(db.clients, scope, "clients"),
            safe_count(
                db.ai_document_memory,
                {**scope, "decision": "REQUIRES_REVIEW"},
                "documents_requiring_review",
            ),
            safe_count(
                db.approval_requests,
                {**scope, "status": "PENDING"},
                "pending_approvals",
            ),
        )
        result["unpaid_invoices_count"] = counts[0]
        result["pending_tasks_count"] = counts[1]
        result["clients_count"] = counts[2]
        result["pending_invoices_to_review"] = counts[3]
        result["pending_approvals"] = counts[4]
        return result
