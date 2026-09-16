import logging
from fastapi import APIRouter, Depends, HTTPException, Query
from typing import Dict, Any, List, Optional
from backend.dependencies import get_current_user
from backend.models import User
from backend.learning.learning_storage import LearningStorage
from backend.learning.recommendation_engine import RecommendationEngine
from backend.learning.correction_engine import CorrectionEngine
from backend.learning.knowledge_search import KnowledgeSearch
from backend.learning.audit_engine import LearningAuditEngine
from backend.learning.rule_optimizer import RuleOptimizer

logger = logging.getLogger("learning_router")

router = APIRouter(prefix="/api/learning", tags=["Self-Learning AI Engine"])

@router.get("/stats")
async def get_learning_stats(current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        from backend.report_engine import load_learning_analytics_report
        stats = await load_learning_analytics_report(company_id)
        return stats
    except Exception as e:
        logger.error(f"Error loading learning stats: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/recommendations")
async def get_recommendations(vendor: Optional[str] = None, doc_type: Optional[str] = None, value: float = 0.0, current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        context = {"vendor_name": vendor or "", "document_type": doc_type or "", "invoice_value": value}
        recs = await RecommendationEngine.generate_recommendations(context, company_id)
        return {"status": "SUCCESS", "recommendations": recs}
    except Exception as e:
        logger.error(f"Error generating recommendations: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/approve-recommendation/{rec_id}")
async def approve_recommendation(rec_id: str, current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        success = await LearningStorage.update_recommendation_status(rec_id=rec_id, status="accepted", action_details={"approved_by": current_user.id})
        if not success:
            raise HTTPException(status_code=404, detail="Recommendation ID not found.")
        await LearningAuditEngine.log_learning_event(event_type="recommendation_accepted", source_id=rec_id, company_id=company_id, user_id=current_user.id, description=f"Recommendation {rec_id} manually accepted and approved.", before_state="pending", after_state="accepted", meta_data={"user_id": current_user.id})
        return {"success": True, "message": "Recommendation successfully approved."}
    except Exception as e:
        logger.error(f"Error approving recommendation: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/correction")
async def record_user_correction(correction_type: str, source_id: str, field_name: str, original_value: str, corrected_value: str, current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        corr_id = await CorrectionEngine.record_correction(correction_type=correction_type, source_id=source_id, company_id=company_id, user_id=current_user.id, field_name=field_name, original_value=original_value, corrected_value=corrected_value)
        if not corr_id:
            raise HTTPException(status_code=500, detail="Failed to record correction.")
        return {"success": True, "correction_id": corr_id}
    except Exception as e:
        logger.error(f"Error recording user correction: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/search")
async def semantic_knowledge_search(query: str, target_type: str = "document_text", threshold: float = 0.5, limit: int = 5, current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        results = await KnowledgeSearch.semantic_search(query=query, company_id=company_id, target_type=target_type, threshold=threshold, limit=limit)
        return {"status": "SUCCESS", "results": results}
    except Exception as e:
        logger.error(f"Error in knowledge search: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.get("/audit")
async def get_learning_audit(source_id: Optional[str] = None, current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        trail = await LearningAuditEngine.get_audit_trail_for_entity(company_id, source_id)
        return {"status": "SUCCESS", "audit_trail": trail}
    except Exception as e:
        logger.error(f"Error getting learning audit: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/optimize")
async def trigger_rule_optimization(current_user: User = Depends(get_current_user)):
    try:
        company_id = getattr(current_user, "company_id", "default_comp") or "default_comp"
        proposals = await RuleOptimizer.analyze_and_optimize_rules(company_id, current_user.id)
        return {"status": "SUCCESS", "proposals_generated": len(proposals), "proposals": proposals}
    except Exception as e:
        logger.error(f"Error running rule optimization: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))

# Mount Finix's integrated agent routes onto the same /api router without
# creating a second accounting engine. Imports are safe because the Finix
# extension resolves the core proposal builder lazily inside each request.
from backend.accounting_ai.finix_agent_extensions import router as finix_agent_router  # noqa: E402
router.routes.extend(finix_agent_router.routes)
