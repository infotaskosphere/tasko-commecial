import logging
from typing import Dict, Any, Optional

logger = logging.getLogger("confidence_engine")

def calculate_field_confidences(
    extracted_data: Dict[str, Any],
    ocr_metadata: Dict[str, Any],
    vendor_match_score: float = 0.0,
    template_matched: bool = False
) -> Dict[str, float]:
    """
    Calculates dynamic field-level confidence scores based on:
    - Extraction method (e.g., template vs. general AI extraction)
    - OCR quality metrics (resolution, noise, blur)
    - Match scores (e.g., vendor matching score)
    - Field existence and pattern validity
    
    Returns a dictionary mapping field names to confidence scores (between 0.0 and 1.0).
    """
    field_scores: Dict[str, float] = {}
    
    # 1. Base confidence from extraction source/quality
    ocr_confidence = float(ocr_metadata.get("confidence", 0.80))
    quality_score = float(ocr_metadata.get("quality_score", 0.80))
    engine_used = ocr_metadata.get("engine_used", "unknown")
    
    # Heuristic baseline confidence. A model can never be more sure of a field than it says it is.
    if template_matched:
        base_field_conf = 0.98
    elif engine_used == "native_pdf_reader":
        base_field_conf = 0.95
    elif engine_used == "gemini_vision":
        base_field_conf = min(0.88, max(0.0, ocr_confidence))
    else:
        base_field_conf = 0.80 * (0.5 + 0.5 * quality_score)

    fields_to_assess = [
        "vendor_or_customer_name",
        "invoice_number",
        "invoice_date",
        "tax_registration_number",  # GSTIN
        "taxable_value",
        "cgst",
        "sgst",
        "igst",
        "cess",
        "total_invoice_value",
        "hsn_sac",
        "ledger_mapping",
        "document_type",
        "currency",
        "narration",
        "payment_terms"
    ]

    for field in fields_to_assess:
        val = extracted_data.get(field)
        
        # If field is completely missing, confidence is 0.0
        if val is None or str(val).strip() == "":
            field_scores[field] = 0.0
            continue
            
        field_conf = base_field_conf
        
        # Specific field overrides/adjustments
        if field == "vendor_or_customer_name":
            # If we matched a registered vendor profile confidently
            if vendor_match_score > 0.0:
                field_conf = max(field_conf, vendor_match_score)
            else:
                field_conf = min(field_conf, 0.70)  # Unknown vendor is less confident
                
        elif field == "tax_registration_number":
            # GSTIN checks: GSTIN should be 15 chars and match standard format
            gst_str = str(val).strip().replace(" ", "")
            if len(gst_str) == 15:
                field_conf = min(1.0, field_conf + 0.05)
            else:
                field_conf = max(0.1, field_conf - 0.40)
                
        elif field == "invoice_number":
            # Invoice numbers shouldn't be excessively long or short
            inv_str = str(val).strip()
            if 3 <= len(inv_str) <= 25:
                field_conf = min(1.0, field_conf + 0.02)
            else:
                field_conf = max(0.2, field_conf - 0.20)
                
        elif field in ["taxable_value", "total_invoice_value"]:
            # Financial amounts should be parsable as numbers
            try:
                float(str(val).replace(",", "").strip())
                field_conf = min(1.0, field_conf + 0.02)
            except ValueError:
                field_conf = 0.10
                
        elif field in ["cgst", "sgst", "igst", "cess"]:
            # Taxes are optional; if present and numeric, keep base conf or slightly boost
            try:
                float(str(val).replace(",", "").strip())
                field_conf = min(1.0, field_conf + 0.02)
            except ValueError:
                # If they wrote e.g. "N/A" or "0", it's fine but if present it must be clean
                field_conf = max(0.3, field_conf - 0.10)
                
        elif field == "document_type":
            # Ensure document type is recognized
            if str(val).upper() in ["PURCHASE", "SALE", "RECEIPT", "INVOICE"]:
                field_conf = min(1.0, field_conf + 0.05)
            else:
                field_conf = max(0.3, field_conf - 0.20)
                
        elif field == "currency":
            # Normalize currency checks (standard formats like INR, USD, EUR)
            curr_str = str(val).strip().upper()
            if len(curr_str) == 3 or curr_str in ["₹", "$", "€", "£"]:
                field_conf = min(1.0, field_conf + 0.05)
            else:
                field_conf = max(0.3, field_conf - 0.15)
                
        field_scores[field] = round(max(0.0, min(1.0, field_conf)), 2)

    logger.info(f"Confidence Engine: Completed field assessment for document. Fields with scores: {len(field_scores)}")
    return field_scores
