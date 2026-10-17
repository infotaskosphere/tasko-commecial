import logging
from typing import Dict, Any, List, Tuple
from backend.dependencies import db

logger = logging.getLogger("decision_engine")

# Default configurable thresholds
DEFAULT_THRESHOLDS = {
    "auto_post_min_confidence": 0.85,
    "review_min_confidence": 0.50,
    "approval_required_amount": 50000.0 # amounts above this require approval even if confident
}

def _company_thresholds(profile: Dict[str, Any], current: Dict[str, float]) -> Dict[str, float]:
    """A company's own thresholds, accepted only when they are sane: confidences are 0-1 and auto-post must be
    stricter than review; the approval limit cannot be negative. Anything else keeps the safe defaults."""
    out = dict(current)

    def num(key: str):
        try:
            return float(profile[key]) if key in profile and profile[key] not in (None, "") else None
        except (TypeError, ValueError):
            return None

    auto, review, limit = num("auto_post_min_confidence"), num("review_min_confidence"), num("approval_required_amount")
    if review is not None and 0.0 <= review <= 1.0:
        out["review_min_confidence"] = review
    if auto is not None and 0.0 < auto <= 1.0 and auto >= out["review_min_confidence"]:
        out["auto_post_min_confidence"] = auto
    if limit is not None and limit >= 0:
        out["approval_required_amount"] = limit
    return out


async def make_routing_decision(
    overall_confidence: float,
    validation_report: Dict[str, Any],
    anomalies: List[Dict[str, Any]],
    extracted_data: Dict[str, Any],
    company_id: str = None
) -> Tuple[str, str]:
    """
    Evaluates confidence, anomalies, and validation rules to determine the next workflow step.
    
    Returns a Tuple of: (Decision, Reason_String)
    
    Possible Decisions:
      - AUTO_POST
      - REQUIRES_REVIEW
      - REQUIRES_APPROVAL
      - REJECT
      - INSUFFICIENT_DATA
    """
    # Load dynamic thresholds from company config if possible
    thresholds = DEFAULT_THRESHOLDS.copy()
    if company_id:
        try:
            # Companies are keyed by `id` (a uuid string), not Mongo's `_id` - looking up `_id` never found
            # one, so a company's own thresholds were silently ignored. `_id` is kept only as a legacy fallback.
            company_profile = (await db.companies.find_one({"id": company_id}, {"_id": 0})
                               or await db.companies.find_one({"_id": company_id}, {"_id": 0}))
            if company_profile:
                thresholds.update(_company_thresholds(company_profile, thresholds))
        except Exception as e:
            logger.error(f"Error reading custom company thresholds: {e}")

    # Parse pricing info safely
    def parse_float(val) -> float:
        if val is None or str(val).strip() == "":
            return 0.0
        try:
            return float(str(val).replace(",", "").strip())
        except ValueError:
            return 0.0

    total_invoice_value = parse_float(extracted_data.get("total_invoice_value"))
    is_field_valid = validation_report.get("field_validation", {}).get("is_valid", True)
    is_biz_valid = validation_report.get("business_rules", {}).get("is_valid", True)
    
    field_errors = validation_report.get("field_validation", {}).get("errors", [])
    biz_errors = validation_report.get("business_rules", {}).get("errors", [])
    all_errors = field_errors + biz_errors
    
    # Check for Critical Rejection conditions
    # 1. Duplicate invoice already posted
    for anomaly in anomalies:
        if anomaly.get("anomaly_type") == "DUPLICATE_INVOICE":
            logger.info("Decision: REJECT due to duplicate invoice entry.")
            return "REJECT", f"Duplicate invoice check failed: {anomaly.get('details')}"
            
    # 2. Critical mathematical or negative value errors
    for anomaly in anomalies:
        if anomaly.get("anomaly_type") == "NEGATIVE_VALUES" and anomaly.get("severity") == "HIGH":
            logger.info("Decision: REJECT due to negative value errors.")
            return "REJECT", "Document contains high-severity negative financial values."

    # 3. Insufficient data to post
    missing_mandatory = [err for err in all_errors if "missing mandatory" in err.lower()]
    if missing_mandatory:
        logger.info("Decision: INSUFFICIENT_DATA due to missing mandatory fields.")
        return "INSUFFICIENT_DATA", f"Mandatory posting fields missing: {', '.join(missing_mandatory)}"

    # 4. Hard validation failures
    if not is_field_valid or not is_biz_valid:
        # Any mathematical total sum mismatch constitutes a hard error
        math_err = [err for err in all_errors if "math" in err.lower() or "mismatch" in err.lower()]
        if math_err:
            logger.info("Decision: REJECT due to critical total mismatch.")
            return "REJECT", f"Calculated totals mismatch: {math_err[0]}"
            
        logger.info("Decision: REQUIRES_REVIEW due to validation errors.")
        return "REQUIRES_REVIEW", f"Validation errors found: {', '.join(all_errors[:2])}"

    # 5. Check High Value Approval requirement
    if total_invoice_value > thresholds["approval_required_amount"]:
        logger.info(f"Decision: REQUIRES_APPROVAL. Value {total_invoice_value} exceeds policy threshold.")
        return "REQUIRES_APPROVAL", f"Invoice total ({total_invoice_value:.2f}) exceeds the auto-posting limit of {thresholds['approval_required_amount']:.2f}."

    # 6. Evaluate Overall Confidence against Auto-Post Threshold
    if overall_confidence >= thresholds["auto_post_min_confidence"]:
        # Ensure we have no medium/high compliance anomalies
        critical_anomalies = [a for a in anomalies if a.get("severity") in ["HIGH", "MEDIUM"]]
        if critical_anomalies:
            logger.info("Decision: REQUIRES_REVIEW due to medium/high risk anomalies.")
            anomaly_types = [a.get("anomaly_type") for a in critical_anomalies]
            return "REQUIRES_REVIEW", f"Overall confidence was high ({overall_confidence:.2f}) but anomalies detected: {', '.join(anomaly_types)}"
            
        logger.info(f"Decision: AUTO_POST. Confident match ({overall_confidence:.2f}).")
        return "AUTO_POST", f"Document validation succeeded with overall confidence score: {overall_confidence:.2f}"

    # 7. Evaluate for standard review routing
    if overall_confidence >= thresholds["review_min_confidence"]:
        logger.info(f"Decision: REQUIRES_REVIEW. Medium confidence ({overall_confidence:.2f}).")
        return "REQUIRES_REVIEW", f"Extracted data has medium confidence ({overall_confidence:.2f}). Needs manual review."
    else:
        logger.info(f"Decision: REQUIRES_REVIEW. Low confidence ({overall_confidence:.2f}).")
        return "REQUIRES_REVIEW", f"Low overall confidence score ({overall_confidence:.2f}) below minimum review threshold."
