"""Deterministic, date-versioned TDS policy engine for Finix.

Thresholds and rates below are the ones in force from 1 April 2025 (Finance Act 2025) and carried over
unchanged into the Income-tax Act, 2025 (section 393) from 1 April 2026:

  194C  contractors      1% individual/HUF, 2% others   deduct when ONE payment exceeds 30,000
                                                          or the year's total exceeds 1,00,000
  194J  professional /   10% (2% for technical services) deduct when the year's total exceeds 50,000
        technical fees                                    (was 30,000 until 31 Mar 2025)
  194I  rent             10% land/building/furniture,    deduct when rent exceeds 50,000 for a month
                         2% plant/machinery/equipment      or part of a month (was 2,40,000 a year
                                                          until 31 Mar 2025)

"Exceeds" is strict: a payment of exactly the threshold does not attract TDS. Rates are the deductor-side
rates for a payee with a PAN; the higher no-PAN rate is not computed here - it is sent to review.
A year with no configured policy is also sent to review rather than guessed.
"""
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Any, Optional

PAISE = Decimal("0.01")

_POLICY_2025 = {
    "194C": {"name": "Payments to Contractors", "threshold_single": 30000, "threshold_annual": 100000,
             "rate_individual": Decimal("0.01"), "rate_company": Decimal("0.02")},
    "194J": {"name": "Professional / Technical Services", "threshold_annual": 50000,
             "rate_standard": Decimal("0.10"), "rate_technical": Decimal("0.02")},
    "194I": {"name": "Rent", "threshold_monthly": 50000,
             "rate_rent": Decimal("0.10"), "rate_plant_machinery": Decimal("0.02")},
}
# Financial years we have verified rules for. Each year gets its own copy so a future change is a new entry,
# never an edit that silently re-prices old transactions.
POLICIES: Dict[str, Dict[str, Dict[str, Any]]] = {
    "2025-26": _POLICY_2025,
    "2026-27": _POLICY_2025,
}
# Kept for callers that import the old name: the policy in force for the current year.
BASE_POLICIES = POLICIES["2026-27"]

# Income-tax Act, 2025, section 393(1) table clauses (from 1 April 2026).
NEW_ACT_REFS = {"194C": "393(1) [Table: Sl. No. 6(i)]", "194J": "393(1) [Table: Sl. No. 6(iii)]", "194I": "393(1) [Table: Sl. No. 2(ii)]"}

_PLANT_MACHINERY = {"plant", "machinery", "equipment", "plant_machinery", "plant_and_machinery"}
_TECHNICAL = {"technical", "technical_service", "technical_services"}


def financial_year(value: Any) -> str:
    if isinstance(value, str):
        value = date.fromisoformat(value[:10])
    if not isinstance(value, date):
        raise ValueError("A valid transaction date is required for TDS policy selection.")
    start = value.year if value.month >= 4 else value.year - 1
    return f"{start}-{str(start + 1)[-2:]}"


def _result(**kwargs):
    base = {"applicable": False, "requires_review": False, "section": "N/A", "statutory_reference": "N/A", "rate": 0.0, "deduction_amount": 0.0}
    base.update(kwargs)
    return base


class TDSEngine:
    @staticmethod
    def evaluate_tds(account_code: str, taxable_value: float, cumulative_vendor_annual_spend: float = 0.0,
                     vendor_profile: Optional[Dict[str, Any]] = None, *, transaction_date: Any = None,
                     section: Optional[str] = None, service_type: Optional[str] = None,
                     deductee_type: Optional[str] = None, pan_available: Optional[bool] = None,
                     rent_period_months: Optional[int] = None) -> Dict[str, Any]:
        """TDS on one payment. `taxable_value` is the amount WITHOUT GST. `cumulative_vendor_annual_spend` is what
        was already paid to this payee in the same financial year. For rent, `rent_period_months` is how many months
        the bill covers (default 1) because the rent threshold is monthly."""
        vendor_profile = vendor_profile or {}
        try:
            value = Decimal(str(taxable_value or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)
            cumulative = Decimal(str(cumulative_vendor_annual_spend or 0)).quantize(PAISE, rounding=ROUND_HALF_UP)
        except Exception:
            return _result(requires_review=True, reason="Invalid monetary value.")
        if value < 0 or cumulative < 0:
            return _result(requires_review=True, reason="TDS base cannot be negative.")
        if transaction_date is None:
            return _result(requires_review=True, reason="Transaction date is required to select the statutory TDS policy.")
        try:
            fy = financial_year(transaction_date)
            tx_date = date.fromisoformat(str(transaction_date)[:10]) if isinstance(transaction_date, str) else transaction_date
        except Exception:
            return _result(requires_review=True, reason="Invalid transaction date.")
        policy = POLICIES.get(fy)
        if policy is None:
            return _result(requires_review=True, financial_year=fy, reason="No configured statutory TDS policy exists for this transaction date.")

        chosen = str(section or vendor_profile.get("tds_section") or "").strip().upper()
        code = str(account_code or "").strip()
        if not chosen:
            if code == "5200":
                chosen = "194I"
            elif code == "5250":
                chosen = "194J"
            elif code in {"5000", "5100", "5500"}:
                chosen = "194C"
        if chosen not in policy:
            return _result(requires_review=True, financial_year=fy, reason="TDS section could not be determined safely.")

        reference = chosen if tx_date <= date(2026, 3, 31) else NEW_ACT_REFS.get(chosen, "393")
        cfg = policy[chosen]
        prior_plus_current = cumulative + value
        stype = str(service_type or "").strip().lower()
        note = ""

        if chosen == "194C":
            triggered = value > cfg["threshold_single"] or prior_plus_current > cfg["threshold_annual"]
            entity = str(deductee_type or vendor_profile.get("legal_entity_type") or "individual").lower()
            rate = cfg["rate_company"] if entity in {"company", "llp", "pvt_ltd"} else cfg["rate_individual"]
        elif chosen == "194J":
            triggered = prior_plus_current > cfg["threshold_annual"]
            rate = cfg["rate_technical"] if stype in _TECHNICAL else cfg["rate_standard"]
        else:  # 194I - the test is per month (or part of a month), not per year
            months = max(int(rent_period_months or 1), 1)
            per_month = (value / months).quantize(PAISE, rounding=ROUND_HALF_UP)
            triggered = per_month > cfg["threshold_monthly"]
            rate = cfg["rate_plant_machinery"] if stype in _PLANT_MACHINERY else cfg["rate_rent"]
            if rent_period_months is None:
                note = " Assumes this bill covers one month; pass the number of months for a multi-month bill."

        if not triggered:
            return _result(section=chosen, statutory_reference=reference, rate=float(rate), financial_year=fy,
                           reason=f"Threshold not triggered under {reference}.{note}")
        if pan_available is False:
            return _result(requires_review=True, section=chosen, statutory_reference=reference, rate=float(rate), financial_year=fy,
                           reason="PAN is unavailable; applicable higher/non-PAN treatment requires review.")
        deduction = (value * rate).quantize(PAISE, rounding=ROUND_HALF_UP)
        return _result(applicable=True, section=chosen, statutory_reference=reference, rate=float(rate),
                       deduction_amount=float(deduction), financial_year=fy,
                       reason=f"TDS triggered under {reference} at {float(rate):.2%}.{note}")
