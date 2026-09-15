"""Deterministic, date-versioned TDS policy engine for Finix."""
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, Any, Optional
PAISE=Decimal("0.01")
BASE_POLICIES={
 "194C":{"name":"Payments to Contractors","threshold_single":30000,"threshold_annual":100000,"rate_individual":Decimal("0.01"),"rate_company":Decimal("0.02")},
 "194J":{"name":"Professional / Technical Services","threshold_single":50000,"threshold_annual":50000,"rate_standard":Decimal("0.10"),"rate_technical":Decimal("0.02")},
 "194I":{"name":"Rent","threshold_annual":240000,"rate_rent":Decimal("0.10")},
}
NEW_ACT_REFS={"194C":"393(1) [Table: Sl. No. 6(i)]","194J":"393(1) [Table: Sl. No. 8]","194I":"393(1) [Table: Sl. No. 3(i)]"}

def financial_year(value:Any)->str:
    if isinstance(value,str): value=date.fromisoformat(value[:10])
    if not isinstance(value,date): raise ValueError("A valid transaction date is required for TDS policy selection.")
    start=value.year if value.month>=4 else value.year-1
    return f"{start}-{str(start+1)[-2:]}"

def _result(**kwargs):
    base={"applicable":False,"requires_review":False,"section":"N/A","statutory_reference":"N/A","rate":0.0,"deduction_amount":0.0};base.update(kwargs);return base

class TDSEngine:
 @staticmethod
 def evaluate_tds(account_code:str,taxable_value:float,cumulative_vendor_annual_spend:float=0.0,vendor_profile:Optional[Dict[str,Any]]=None,*,transaction_date:Any=None,section:Optional[str]=None,service_type:Optional[str]=None,deductee_type:Optional[str]=None,pan_available:Optional[bool]=None)->Dict[str,Any]:
    vendor_profile=vendor_profile or {}
    try:value=Decimal(str(taxable_value or 0)).quantize(PAISE,rounding=ROUND_HALF_UP);cumulative=Decimal(str(cumulative_vendor_annual_spend or 0)).quantize(PAISE,rounding=ROUND_HALF_UP)
    except Exception:return _result(requires_review=True,reason="Invalid monetary value.")
    if value<0 or cumulative<0:return _result(requires_review=True,reason="TDS base cannot be negative.")
    if transaction_date is None:return _result(requires_review=True,reason="Transaction date is required to select the statutory TDS policy.")
    try:
        fy=financial_year(transaction_date);tx_date=date.fromisoformat(str(transaction_date)[:10]) if isinstance(transaction_date,str) else transaction_date
    except Exception:return _result(requires_review=True,reason="Invalid transaction date.")
    policy=BASE_POLICIES if fy in {"2025-26","2026-27"} else None
    if policy is None:return _result(requires_review=True,financial_year=fy,reason="No configured statutory TDS policy exists for this transaction date.")
    chosen=str(section or vendor_profile.get("tds_section") or "").strip().upper();code=str(account_code or "").strip()
    if not chosen:
        if code=="5200":chosen="194I"
        elif code=="5250":chosen="194J"
        elif code in {"5000","5100","5500"}:chosen="194C"
    if chosen not in policy:return _result(requires_review=True,financial_year=fy,reason="TDS section could not be determined safely.")
    statutory_reference=chosen if tx_date<=date(2026,3,31) else NEW_ACT_REFS.get(chosen,"393");cfg=policy[chosen];prior_plus_current=cumulative+value;triggered=False
    if chosen=="194C":
        triggered=value>=cfg["threshold_single"] or prior_plus_current>=cfg["threshold_annual"];entity=str(deductee_type or vendor_profile.get("legal_entity_type") or "individual").lower();rate=cfg["rate_company"] if entity in {"company","llp","pvt_ltd"} else cfg["rate_individual"]
    elif chosen=="194J":
        triggered=value>=cfg["threshold_single"] or prior_plus_current>=cfg["threshold_annual"];rate=cfg["rate_technical"] if str(service_type or "").lower() in {"technical","technical_service"} else cfg["rate_standard"]
    else:triggered=prior_plus_current>=cfg["threshold_annual"];rate=cfg["rate_rent"]
    if not triggered:return _result(section=chosen,statutory_reference=statutory_reference,rate=float(rate),financial_year=fy,reason=f"Threshold not triggered under {statutory_reference}.")
    if pan_available is False:return _result(requires_review=True,section=chosen,statutory_reference=statutory_reference,rate=float(rate),financial_year=fy,reason="PAN is unavailable; applicable higher/non-PAN treatment requires review.")
    deduction=(value*rate).quantize(PAISE,rounding=ROUND_HALF_UP)
    return _result(applicable=True,section=chosen,statutory_reference=statutory_reference,rate=float(rate),deduction_amount=float(deduction),financial_year=fy,reason=f"TDS triggered under {statutory_reference} at {float(rate):.2%}.")
