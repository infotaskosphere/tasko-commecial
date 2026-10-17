import logging
from typing import Dict, Any, List, Optional
from backend.dependencies import db

logger = logging.getLogger("business_rule_validator")

# Standard GST percentage rates in India
VALID_GST_RATES = {0.0, 5.0, 12.0, 18.0, 28.0}

async def validate_business_rules(
    extracted_data: Dict[str, Any],
    vendor_profile: Optional[Dict[str, Any]] = None,
    company_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Validates transactional fields against accounting and GST regulatory rules:
    - CGST + SGST = GST (and CGST should equal SGST)
    - Taxable Value + CGST + SGST + IGST + CESS = Total Invoice Value
    - Interstate vs. Intrastate: Supplier state code vs Company state code
    - Reverse charge flag conditions
    - TDS applicability thresholds (e.g. > 30,000 INR for 194C)
    - Threshold matching for auto-post
    """
    errors: List[str] = []
    warnings: List[str] = []
    details: Dict[str, Any] = {}
    
    # 1. Fetch company configuration for dynamic rules
    company_config = {}
    if company_id:
        try:
            # Look up company profile from db (state code, max auto-post limits etc)
            company_config = await db.companies.find_one({"_id": company_id}) or {}
        except Exception as e:
            logger.error(f"Failed to load company config: {e}")

    company_state_code = str(company_config.get("state_code") or "27").strip()[:2] # Default to e.g. Maharashtra 27
    max_auto_post_limit = float(company_config.get("max_auto_post_limit") or 100000.0) # Configurable threshold limit

    # Parse and normalize numerical fields
    def parse_float(val) -> float:
        if val is None or str(val).strip() == "":
            return 0.0
        try:
            return float(str(val).replace(",", "").strip())
        except ValueError:
            return 0.0

    taxable = parse_float(extracted_data.get("taxable_value"))
    cgst = parse_float(extracted_data.get("cgst"))
    sgst = parse_float(extracted_data.get("sgst"))
    igst = parse_float(extracted_data.get("igst"))
    cess = parse_float(extracted_data.get("cess"))
    total_val = parse_float(extracted_data.get("total_invoice_value"))
    
    # 2. Mathematical total verification: Taxable + CGST + SGST + IGST + CESS == Total Value
    calculated_total = taxable + cgst + sgst + igst + cess
    # Use a small tolerance margin of 1.00 INR/USD for rounding differences
    if abs(calculated_total - total_val) > 1.01:
        msg = f"Mathematical mismatch: Taxable ({taxable}) + Taxes ({cgst + sgst + igst + cess}) = {calculated_total:.2f}, but extracted Total is {total_val:.2f}."
        errors.append(msg)
        details["math_sum_check"] = {"status": "error", "message": msg}
    else:
        details["math_sum_check"] = {"status": "ok"}

    # 3. CGST vs. SGST equality check
    if cgst > 0.0 or sgst > 0.0:
        if abs(cgst - sgst) > 0.05:
            msg = f"CGST ({cgst}) and SGST ({sgst}) must be equal for intrastate transactions."
            errors.append(msg)
            details["cgst_sgst_equality"] = {"status": "error", "message": msg}
        else:
            details["cgst_sgst_equality"] = {"status": "ok"}

    # 4. Interstate vs. Intrastate check
    supplier_gst = str(extracted_data.get("tax_registration_number") or "").strip()
    if len(supplier_gst) >= 2:
        supplier_state_code = supplier_gst[:2]
        is_interstate = supplier_state_code != company_state_code
        
        if is_interstate:
            # Interstate requires IGST. CGST/SGST should be 0.
            if (cgst > 0.0 or sgst > 0.0) and igst == 0.0:
                msg = f"Interstate transaction detected (Supplier: {supplier_state_code} vs Company: {company_state_code}). Expected IGST, but found CGST/SGST."
                warnings.append(msg)
                details["interstate_check"] = {"status": "warning", "message": msg}
            else:
                details["interstate_check"] = {"status": "ok", "type": "interstate"}
        else:
            # Intrastate requires CGST/SGST. IGST should be 0.
            if igst > 0.0 and (cgst == 0.0 or sgst == 0.0):
                msg = f"Intrastate transaction detected (Supplier and Company state codes match: {company_state_code}). Expected CGST/SGST, but found IGST."
                warnings.append(msg)
                details["interstate_check"] = {"status": "warning", "message": msg}
            else:
                details["interstate_check"] = {"status": "ok", "type": "intrastate"}

    # 5. GST percentage rate validity
    # Estimate rate: total tax / taxable value (only if taxable is not zero)
    total_tax = cgst + sgst + igst
    if taxable > 0.0 and total_tax > 0.0:
        estimated_rate = round((total_tax / taxable) * 100.0, 1)
        # Find closest valid rate
        closest_rate = min(VALID_GST_RATES, key=lambda x: abs(x - estimated_rate))
        if abs(estimated_rate - closest_rate) > 1.5:
            msg = f"Suspicious calculated GST rate: {estimated_rate}%. Standard Indian GST rates are 0%, 5%, 12%, 18%, 28%."
            warnings.append(msg)
            details["gst_rate_check"] = {"status": "warning", "message": msg, "estimated_rate": estimated_rate}
        else:
            details["gst_rate_check"] = {"status": "ok", "rate": closest_rate}
    else:
        details["gst_rate_check"] = {"status": "ok", "rate": 0.0}

    # 6. TDS applicability warning rules (for Indian Income Tax compliance)
    # Advisory only (the TDS engine decides at posting). The lowest single-payment trigger is 194C's 30,000 (it
    # applies when a payment EXCEEDS it); 194J is 50,000 a year and rent is 50,000 a month, so which section
    # applies depends on what was bought - the vendor's saved section is used when there is one.
    if total_val > 30000.0:
        tds_section = "194C"
        if vendor_profile:
            tds_section = vendor_profile.get("preferred_tds_section") or "194C"
        msg = f"Invoice total ({total_val}) is above INR 30,000, where TDS can apply depending on the nature of the payment. Please verify TDS Section {tds_section} compliance."
        warnings.append(msg)
        details["tds_applicability"] = {"status": "warning", "message": msg, "suggested_section": tds_section}

    # 7. Reverse charge validation (where specified or vendor matches RCM profile)
    rcm_applicable = False
    if vendor_profile and vendor_profile.get("reverse_charge_applicable"):
        rcm_applicable = True
        
    if rcm_applicable:
        # For Reverse Charge, CGST/SGST/IGST charged on invoice should be 0 (paid by buyer directly)
        if total_tax > 0.0:
            msg = f"Vendor profile specifies Reverse Charge Mechanism, but invoice contains calculated taxes: {total_tax}."
            warnings.append(msg)
            details["rcm_check"] = {"status": "warning", "message": msg}
        else:
            details["rcm_check"] = {"status": "ok", "rcm_active": True}

    # 8. Limit auto-posting check
    if total_val > max_auto_post_limit:
        msg = f"Invoice total ({total_val}) exceeds company auto-posting limit limit ({max_auto_post_limit}). Direct approval required."
        warnings.append(msg)
        details["limits_check"] = {"status": "warning", "message": msg}

    # Overall business validation passes if no hard errors
    is_valid = len(errors) == 0

    return {
        "is_valid": is_valid,
        "errors": errors,
        "warnings": warnings,
        "details": details
    }
