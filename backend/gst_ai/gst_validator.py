import re
from typing import Dict, Any, List
from datetime import datetime
import logging

logger = logging.getLogger("gst_validator")

# Standard Indian GSTIN Regex
# 15 characters: 2-digit state code, 10-char PAN, 1 alphanumeric entity code, 'Z', 1 alphanumeric check digit
GSTIN_REGEX = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", re.I)
HSN_REGEX = re.compile(r"^\d{2,8}$")

VALID_GST_RATES_BUILTIN = {0.0, 0.1, 0.25, 1.0, 3.0, 5.0, 12.0, 18.0, 28.0}

def _gst_rates(on_date=None):
    """GST rates in use on a date, from Tax rules & law updates (falls back to the built-in list)."""
    try:
        from backend.statutory_rules import rule
        rates = rule("gst.valid_rates", on_date)
        if rates:
            return tuple(float(r) for r in rates)
    except Exception:
        pass
    return tuple(float(r) for r in VALID_GST_RATES_BUILTIN)


class GSTValidator:
    @staticmethod
    def validate_gstin(gstin: str) -> bool:
        if not gstin:
            return False
        return bool(GSTIN_REGEX.match(gstin.strip().upper()))

    @staticmethod
    def validate_hsn(hsn: str) -> bool:
        if not hsn:
            return False
        # Strip decimal dots if present
        hsn_clean = hsn.replace(".", "").strip()
        return bool(HSN_REGEX.match(hsn_clean))

    @classmethod
    def validate_invoice(cls, invoice: Dict[str, Any], tolerance: float = 1.01) -> Dict[str, Any]:
        """
        Performs thorough validation of GST Invoice and returns a structured report.
        """
        errors = []
        warnings = []
        checks = {}

        # 1. GSTIN validation
        supplier_gstin = (invoice.get("supplier_gstin") or invoice.get("tax_registration_number") or "").strip().upper()
        recipient_gstin = (invoice.get("recipient_gstin") or "").strip().upper()

        if supplier_gstin:
            s_valid = cls.validate_gstin(supplier_gstin)
            checks["supplier_gstin_format"] = s_valid
            if not s_valid:
                errors.append(f"Supplier GSTIN format is invalid: '{supplier_gstin}'")
        else:
            errors.append("Supplier GSTIN is missing.")
            checks["supplier_gstin_format"] = False

        if recipient_gstin:
            r_valid = cls.validate_gstin(recipient_gstin)
            checks["recipient_gstin_format"] = r_valid
            if not r_valid:
                errors.append(f"Recipient GSTIN format is invalid: '{recipient_gstin}'")
        else:
            checks["recipient_gstin_format"] = True # Could be unregistered buyer (B2C)

        # 2. HSN/SAC validation
        hsn = str(invoice.get("hsn") or invoice.get("hsn_code") or "").strip()
        if hsn:
            h_valid = cls.validate_hsn(hsn)
            checks["hsn_sac_format"] = h_valid
            if not h_valid:
                warnings.append(f"HSN/SAC code format should be 2 to 8 numeric digits: '{hsn}'")
        else:
            checks["hsn_sac_format"] = True # Optional for small taxpayers

        # 3. Date validation
        inv_date_str = str(invoice.get("invoice_date") or "").strip()
        checks["invoice_date_valid"] = False
        if inv_date_str:
            for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%m/%d/%Y"):
                try:
                    dt = datetime.strptime(inv_date_str, fmt)
                    checks["invoice_date_valid"] = True
                    # Check if invoice date is in the future
                    if dt.date() > datetime.today().date():
                        warnings.append("Invoice date is in the future.")
                    break
                except ValueError:
                    pass
            if not checks["invoice_date_valid"]:
                errors.append(f"Invalid invoice date format: '{inv_date_str}'. Expected YYYY-MM-DD or DD/MM/YYYY.")
        else:
            errors.append("Invoice date is missing.")

        # 4. Place of supply validation
        pos = str(invoice.get("place_of_supply") or "").strip()
        checks["place_of_supply_valid"] = bool(pos)
        if not pos:
            warnings.append("Place of supply is missing or empty.")

        # 5. Math & Calculation validation
        taxable_value = float(invoice.get("taxable_value") or invoice.get("taxable_amount") or 0.0)
        total_invoice_value = float(invoice.get("invoice_value") or invoice.get("total_invoice_value") or 0.0)
        cgst = float(invoice.get("cgst") or 0.0)
        sgst = float(invoice.get("sgst") or 0.0)
        igst = float(invoice.get("igst") or 0.0)
        cess = float(invoice.get("cess") or 0.0)
        rate = float(invoice.get("rate") or invoice.get("tax_rate") or 0.0)

        checks["tax_rate_slabs_valid"] = rate in _gst_rates()
        if not checks["tax_rate_slabs_valid"] and rate > 0:
            warnings.append(f"GST Tax Rate {rate}% is not a standard statutory GST rate.")

        # Check total invoice value consistency
        computed_total = taxable_value + cgst + sgst + igst + cess
        diff_total = abs(total_invoice_value - computed_total)
        checks["value_total_match"] = diff_total <= tolerance
        if not checks["value_total_match"] and total_invoice_value > 0:
            errors.append(f"Invoice total mismatch: stated {total_invoice_value} vs computed {computed_total} (diff: {round(diff_total, 2)})")

        # Check CGST / SGST symmetry
        if cgst > 0 or sgst > 0:
            checks["cgst_sgst_symmetric"] = abs(cgst - sgst) <= 0.05
            if not checks["cgst_sgst_symmetric"]:
                errors.append(f"Asymmetry in CGST ({cgst}) and SGST ({sgst}) values.")
        else:
            checks["cgst_sgst_symmetric"] = True

        # Check Inter-state vs Intra-state logic
        s_state = supplier_gstin[:2] if len(supplier_gstin) >= 2 else ""
        r_state = recipient_gstin[:2] if len(recipient_gstin) >= 2 else ""

        checks["state_tax_logic_valid"] = True
        if s_state and r_state:
            is_intra = s_state == r_state
            if is_intra:
                if igst > 0:
                    errors.append(f"Intra-state supply (same state code {s_state}) cannot have IGST: stated {igst}")
                    checks["state_tax_logic_valid"] = False
            else:
                if cgst > 0 or sgst > 0:
                    errors.append(f"Inter-state supply (different state codes {s_state} vs {r_state}) cannot have CGST/SGST: stated CGST {cgst}, SGST {sgst}")
                    checks["state_tax_logic_valid"] = False

        # Check tax calculation math
        computed_tax = taxable_value * (rate / 100.0)
        stated_tax = igst if igst > 0 else (cgst + sgst)
        checks["tax_calculation_valid"] = abs(computed_tax - stated_tax) <= max(tolerance, taxable_value * 0.01)
        if not checks["tax_calculation_valid"] and taxable_value > 0 and rate > 0:
            warnings.append(f"Stated tax {stated_tax} does not match computed tax {round(computed_tax, 2)} for rate {rate}% and taxable value {taxable_value}")

        # Registration Status
        checks["registration_status_verified"] = True
        status = invoice.get("supplier_registration_status", "ACTIVE")
        if status in ("SUSPENDED", "CANCELLED"):
            errors.append(f"Supplier GST registration status is non-compliant: {status}")
            checks["registration_status_verified"] = False

        return {
            "is_valid": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "checks": checks,
            "timestamp": datetime.utcnow().isoformat()
        }
