"""Layman-first Finix AI accounting interpretation layer."""
from __future__ import annotations
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional
import re
from backend.accounting_ai.accounting_policy import TRANSACTION_POLICIES, classify_transaction
PAISE=Decimal("0.01")
INTENT_PATTERNS=[(r"\b(sold|sales invoice|invoice to customer|customer invoice|raised invoice)\b","SALE"),(r"\b(bought|purchase invoice|supplier invoice|vendor bill|purchased)\b","PURCHASE"),(r"\b(paid|payment to|paid to|settled vendor|supplier payment)\b","PAYMENT"),(r"\b(received|money received|customer payment|collection received|collected)\b","RECEIPT"),(r"\b(transferred|transfer from|transfer to|bank transfer)\b","BANK_TRANSFER"),(r"\b(cash deposited|cash withdrawal|withdrawn from bank|deposited into bank)\b","CONTRA"),(r"\b(bank charge|bank fee|charges by bank)\b","BANK_CHARGE"),(r"\b(loan received|loan taken|loan proceeds)\b","LOAN_RECEIPT"),(r"\b(loan repaid|emi paid|loan repayment)\b","LOAN_REPAYMENT"),(r"\b(salary|payroll|salaries paid)\b","PAYROLL"),(r"\b(depreciation|depreciate)\b","DEPRECIATION"),(r"\b(gst paid|paid gst|gst payment)\b","GST_PAYMENT"),(r"\b(tds paid|paid tds|tds payment)\b","TDS_PAYMENT"),(r"\b(returned goods to supplier|purchase return)\b","PURCHASE_RETURN"),(r"\b(customer returned|sales return)\b","SALE_RETURN"),(r"\b(advance paid|paid advance)\b","ADVANCE_PAYMENT"),(r"\b(advance received|received advance)\b","ADVANCE_RECEIPT"),(r"\b(fixed asset|bought machinery|bought equipment|bought furniture)\b","FIXED_ASSET"),(r"\b(prepaid|prepayment)\b","PREPAID_EXPENSE"),(r"\b(accrual|accrued)\b","ACCRUAL"),(r"\b(provision|provided for)\b","PROVISION"),(r"\b(debit note)\b","DEBIT_NOTE"),(r"\b(credit note)\b","CREDIT_NOTE"),(r"\b(reverse charge|rcm)\b","RCM_PURCHASE"),(r"\b(stock journal|stock transfer|moved stock)\b","STOCK_JOURNAL"),(r"\b(inventory adjustment|stock adjustment|physical stock)\b","INVENTORY_ADJUSTMENT"),(r"\b(interest)\b","INTEREST")]
def normalize_intent(text:str)->str:
 value=str(text or "").strip().lower()
 for pattern,event in INTENT_PATTERNS:
  if re.search(pattern,value,flags=re.I): return event
 return "JOURNAL"
def _extract_amount(text:str)->Optional[Decimal]:
 value=str(text or "")
 lakh=re.search(r"(?:₹|rs\.?|inr\s*)?\s*([0-9]+(?:\.[0-9]+)?)\s*lakh\b",value,flags=re.I)
 if lakh:return (Decimal(lakh.group(1))*Decimal("100000")).quantize(PAISE,rounding=ROUND_HALF_UP)
 matches=re.findall(r"(?:₹|rs\.?|inr\s*)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|\b([0-9][0-9,]*(?:\.[0-9]+)?)\b",value,flags=re.I); nums=[]
 for first,second in matches:
  try:
   amount=Decimal((first or second).replace(",","")).quantize(PAISE,rounding=ROUND_HALF_UP)
   if amount>0: nums.append(amount)
  except Exception: pass
 return nums[0] if nums else None
def _extract_party(text:str)->Optional[str]:
 for pattern in [r"\b(?:to|from|with|customer|vendor|supplier)\s+([A-Za-z][A-Za-z0-9&.\- ]{1,80})",r"\b(?:invoice|bill)\s+(?:to|from)\s+([A-Za-z][A-Za-z0-9&.\- ]{1,80})"]:
  m=re.search(pattern,str(text or ""),flags=re.I)
  if m:return re.split(r"\s+(?:for|of|on|amounting|worth)\s+|[,:;]",m.group(1).strip(),maxsplit=1,flags=re.I)[0].strip() or None
 return None
class FinixIntelligence:
 @staticmethod
 def interpret(text:str,*,default_company_id:str="")->Dict[str,Any]:
  event=normalize_intent(text); amount=_extract_amount(text); party=_extract_party(text)
  payload={"company_id":default_company_id,"document_type":event,"amount":float(amount or 0),"total_invoice_value":float(amount or 0),"vendor_or_customer_name":party or ""}; policy=classify_transaction(event,payload); clarification=[]
  if amount is None: clarification.append("What is the transaction amount?")
  if TRANSACTION_POLICIES.get(event,{}).get("requires_party") and not party: clarification.append("Who is the customer/vendor/party involved?")
  if policy.get("status")=="REVIEW_REQUIRED" and policy.get("reason") not in clarification: clarification.append(policy["reason"])
  if event=="JOURNAL": clarification.append("Tell me what happened, for example: paid rent, received customer payment, bought stock, or transferred money between bank accounts.")
  confidence=0.90 if event!="JOURNAL" and amount is not None and not clarification else (0.65 if event!="JOURNAL" else 0.40)
  return {"success":bool(event!="JOURNAL" and amount is not None and not clarification),"event":event,"amount":float(amount or 0),"party_name":party or "","confidence":confidence,"confidence_band":FinixIntelligence.confidence_band(confidence),"needs_clarification":clarification,"policy":policy,"draft_payload":payload}
 @staticmethod
 def confidence_band(score:float)->str:
  score=float(score or 0); return "AUTO" if score>=0.90 else ("SUGGEST" if score>=0.75 else "REVIEW")
