import logging
import time
from typing import Dict, Any, Optional

# Import sub-modules
from backend.ai.confidence_engine import calculate_field_confidences
from backend.ai.field_validator import validate_extracted_fields
from backend.ai.business_rule_validator import validate_business_rules
from backend.ai.anomaly_detector import detect_anomalies
from backend.ai.confidence_calculator import calculate_overall_confidence
from backend.ai.decision_engine import make_routing_decision
from backend.dependencies import db
from backend.ai.validation_storage import store_validation_report, store_confidence_history, store_anomaly_records

logger = logging.getLogger("document_validator")

MIN_REVIEWED_FOR_HISTORY = 20


async def company_review_accuracy(company_id: Optional[str]) -> float:
    """How often people accepted this company's zero-touch documents when they reviewed them (0-1).
    Measured from the last 200 reviewed documents; with fewer than 20 it is 'unknown' (0.5), not a flattering guess."""
    if not company_id:
        return 0.5
    try:
        rows = await db.zte_processed_documents.find(
            {"company_id": company_id, "reviewed_by": {"$ne": None}, "status": {"$in": ["posted", "rejected"]}},
            {"_id": 0, "status": 1}).sort("created_at", -1).to_list(200)
    except Exception as ex:
        logger.warning("review accuracy unavailable: %s", ex)
        return 0.5
    if len(rows) < MIN_REVIEWED_FOR_HISTORY:
        return 0.5
    return round(sum(1 for r in rows if r.get("status") == "posted") / len(rows), 2)


async def run_document_validation_pipeline(
    extracted_data: Dict[str, Any],
    ocr_metadata: Dict[str, Any],
    filename: str,
    document_id: str,
    vendor_profile: Optional[Dict[str, Any]] = None,
    template_matched: bool = False,
    company_id: Optional[str] = None,
    vendor_match_score: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Coordinates and executes the entire Phase 6 validation workflow:
    1. Runs field-level structural validators.
    2. Executes regulatory, mathematical, and vendor-specific business rules.
    3. Calculates individual field-level confidence scores.
    4. Computes a weighted, composite overall confidence score.
    5. Scans for potential anomalies, risks, and spike variances.
    6. Generates a routing decision (AUTO_POST, REQUIRES_REVIEW, REJECT, etc.).
    7. Persists records to MongoDB for future analytical optimization.
    """
    start_time = time.time()
    logger.info(f"AI Validation Pipeline: Initiated for document {document_id}")

    # 1. Vendor match score: only from evidence. The caller passes the real lookup score; the profile's own
    # trust score (if it has one) can only lower it. A profile with no score at all is "unknown" (0.0), not 0.90.
    scores = []
    if vendor_profile:
        for raw in (vendor_match_score, vendor_profile.get("confidence_score"), vendor_profile.get("match_score")):
            try:
                if raw is not None:
                    scores.append(max(0.0, min(1.0, float(raw))))
            except (TypeError, ValueError):
                continue
    vendor_match_score = min(scores) if scores else 0.0

    # 2. Field-level Pattern Validation
    field_validation_res = await validate_extracted_fields(extracted_data, ocr_metadata, company_id)
    
    # 3. Business Rules Validation
    business_rules_res = await validate_business_rules(extracted_data, vendor_profile, company_id)

    # 4. Field Confidence Scores calculation
    field_confidences = calculate_field_confidences(
        extracted_data=extracted_data,
        ocr_metadata=ocr_metadata,
        vendor_match_score=vendor_match_score,
        template_matched=template_matched
    )

    # 5. Composite Confidence calculation
    overall_confidence = calculate_overall_confidence(
        field_confidences=field_confidences,
        ocr_metadata=ocr_metadata,
        vendor_match_score=vendor_match_score,
        template_matched=template_matched,
        business_rules_passed=business_rules_res.get("is_valid", True),
        historical_accuracy=await company_review_accuracy(company_id)
    )

    # 6. Anomaly Detection
    anomalies = await detect_anomalies(
        extracted_data=extracted_data,
        ocr_metadata=ocr_metadata,
        vendor_profile=vendor_profile,
        validation_details=field_validation_res,
        company_id=company_id
    )

    # 7. Workflow Decision Routing
    decision, reason = await make_routing_decision(
        overall_confidence=overall_confidence,
        validation_report={
            "field_validation": field_validation_res,
            "business_rules": business_rules_res
        },
        anomalies=anomalies,
        extracted_data=extracted_data,
        company_id=company_id
    )

    duration = time.time() - start_time

    # Construct unified validation report
    validation_report = {
        "document_id": document_id,
        "filename": filename,
        "decision": decision,
        "decision_reason": reason,
        "overall_confidence": overall_confidence,
        "processing_time": duration,
        "field_confidences": field_confidences,
        "field_validation": field_validation_res,
        "business_rules": business_rules_res,
        "anomalies": anomalies,
        "template_matched": template_matched,
        "vendor_matched": vendor_profile is not None,
        "ocr_engine": ocr_metadata.get("engine_used")
    }

    # 8. Asynchronous persistence
    try:
        await store_validation_report(document_id, filename, validation_report)
        await store_confidence_history(document_id, field_confidences, overall_confidence)
        await store_anomaly_records(document_id, anomalies)
    except Exception as db_err:
        logger.error(f"Failed to persist validation data: {db_err}", exc_info=True)

    logger.info(f"AI Validation Pipeline: Finished. Decision: {decision}, Time: {duration:.2f}s")
    return validation_report
