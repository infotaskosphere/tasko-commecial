"""Deterministic TDS policy engine.

Rates and thresholds are configuration data, not AI guesses. The policy is
versioned by financial year and transaction date so historical vouchers are
not silently reinterpreted when statutory rules change.
"""

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Any, Optional

PAISE = Decimal("0.01")

# FY 2026-27 policy values. These are deliberately explicit so a future
# statutory amendment can be added as a new effective policy without changing
# historical calculations.
TDS_POLICIES = {
    "2026-27": {
        "194C": {"name": "Payments to Contractors", "threshold_single": 30000, "threshold_annual": 100000, "rate_individual": 0.01, "rate_company": 0.02},
        "194J": {"name": "Professional / Technical Services", "threshold_single": 50000, "threshold_annual": 50000, "rate_standard": 0.10, "rate_technical": 0.02},
        "194I": {"name": "Rent", "threshold_annual": 240000, "rate_rent": 0.10},
    },
}


def financial_year(value: Any) -> str:
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    if not isinstance(value, date):
        raise ValueError("A valid transaction date is required for TDS policy selection.")
    start = value.year if value.month >= 4 else value.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


class TDSEngine:
    @staticmethod
    def evaluate_tds(
        account_code: str,
        taxable_value: float,
        cumulative_vendor_annual_spend: float = 0.0,
        vendor_profile: Optional[Dict[str, Any]] = None,
        *,
        transaction_date: Any = None,
        section: Optional[str] = None,
        service_type: Optional[str] = None,
        deductee_type: Optional[str] = None,
        pan_available: Optional[bool] = None,
    ) -> Dict[str, Any]:
        vendor_profile = vendor_profile or {}
        try:
            value = Decimal(str(taxable_value or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)
            cumulative = Decimal(str(cumulative_vendor_annual_spend or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)
        except Exception:
            return {"applicable": False, "requires_review": True, "section": "N/A", "rate": 0.0, "deduction_amount": 0.0, "reason": "Invalid monetary value."}
        if value < 0 or cumulative < 0:
            return {"applicable": False, "requires_review": True, "section": "N/A", "rate": 0.0, "deduction_amount": 0.0, "reason": "TDS base cannot be negative."}

        if transaction_date is None:
            return {"applicable": False, "requires_review": True, "section": "N/A", "rate": 0.0, "deduction_amount": 0.0, "reason": "Transaction date is required to select the statutory TDS policy."}
        try:
            fy = financial_year(transaction_date)
            policy = TDS_POLICIES[fy]
        except (ValueError, KeyError):
            return {"applicable": False, "requires_review": True, "section": "N/A", "rate": 0.0, "deduction_amount": 0.0, "reason": "No configured statutory TDS policy exists for this transaction date."}

        chosen = str(section or vendor_profile.get("tds_section") or "").strip().upper()
        code = str(account_code or "").strip()
        if not chosen:
            if code == "5200": chosen = "194I"
            elif code == "5250": chosen = "194J"
            elif code in {"5000", "5100", "5500"}: chosen = "194C"
        if chosen not in policy:
            return {"applicable": False, "requires_review": True, "section": "N/A", "rate": 0.0, "deduction_amount": 0.0, "reason": "TDS section could not be determined safely."}

        cfg = policy[chosen]
        prior_plus_current = cumulative + value
        triggered = False
        rate = Decimal("0")
        if chosen == "194C":
            triggered = value >= cfg["threshold_single"] or prior_plus_current >= cfg["threshold_annual"]
            entity = str(deductee_type or vendor_profile.get("legal_entity_type") or "individual").lower()
            rate = Decimal(str(cfg["rate_company"] if entity in {"company", "llp", "pvt_ltd"} else cfg["rate_individual"]))
        elif chosen == "194J":
            triggered = value >= cfg["threshold_single"] or prior_plus_current >= cfg["threshold_annual"]
            rate = Decimal(str(cfg["rate_standard"] if str(service_type or "").lower() not in {"technical", "technical_service"} else cfg["rate_technical"]))
        elif chosen == "194I":
            triggered = prior_plus_current >= cfg["threshold_annual"]
            rate = Decimal(str(cfg["rate_rent"]))

        if not triggered:
            return {"applicable": False, "requires_review": False, "section": chosen, "rate": float(rate), "deduction_amount": 0.0, "financial_year": fy, "reason": f"Threshold not triggered under {chosen}."}

        if pan_available is False:
            return {"applicable": False, "requires_review": True, "section": chosen, "rate": float(rate), "deduction_amount": 0.0, "financial_year": fy, "reason": "PAN is unavailable; statutory non-PAN treatment requires review."}

        deduction = (value * rate).quantize(PAISE, rounding=ROUND_HALF_UP)
        return {"applicable": True, "requires_review": False, "section": chosen, "rate": float(rate), "deduction_amount": float(deduction), "financial_year": fy, "reason": f"TDS triggered under {chosen} at {float(rate):.2%}."}
