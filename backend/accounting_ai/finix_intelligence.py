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
 # The most specific phrase wins ("tds paid" beats the generic "paid"); ties keep list order.
 best,best_len=None,0
 for pattern,event in INTENT_PATTERNS:
  m=re.search(pattern,value,flags=re.I)
  if m and len(m.group(0))>best_len: best,best_len=event,len(m.group(0))
 return best or "JOURNAL"
VALID_GST_RATES = (0.0, 0.1, 0.25, 1.5, 3.0, 5.0, 12.0, 18.0, 28.0)
_MONTHS = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*"
_AMOUNT_TOKEN = r"[0-9][0-9,]*(?:\.[0-9]+)?"
_UNIT_AFTER = r"(?:months?|days?|years?|yrs?|weeks?|hours?|hrs?|units?|pcs|pieces|nos|items?|kgs?|kg|qty|installments?|emis?)\b"
_PARTY_STOP = {
    "for", "of", "on", "at", "against", "plus", "incl", "including", "inclusive", "excl", "excluding",
    "exclusive", "with", "gst", "igst", "cgst", "sgst", "tds", "worth", "amounting", "being", "via",
    "through", "dated", "towards", "extra", "and", "vide", "rs", "inr", "re", "ref", "invoice", "bill",
    "only", "total", "net", "gross", "paid", "received", "payment",
}
_GENERIC_PARTIES = {"bank", "cash", "the bank", "hdfc", "icici", "sbi"}


def _to_decimal(raw: str) -> Optional[Decimal]:
    try:
        value = Decimal(raw.replace(",", "")).quantize(PAISE, rounding=ROUND_HALF_UP)
    except Exception:
        return None
    return value if value > 0 else None


def _strip_non_amounts(text: str) -> str:
    """Remove percentages, dates, invoice/reference numbers, ordinals, GSTINs and quantities
    so that only genuine money figures remain."""
    value = str(text or "")
    value = re.sub(r"\b[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b", " ", value)                # GSTIN
    value = re.sub(r"\b[A-Z]{5}[0-9]{4}[A-Z]\b", " ", value)                                          # PAN
    value = re.sub(r"\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b", " ", value)     # numeric dates
    value = re.sub(rf"\b\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTHS}\b(?:[\s,]+\d{{2,4}})?", " ", value, flags=re.I)   # 5 March 2026
    value = re.sub(rf"\b{_MONTHS}\s+\d{{1,2}}(?:st|nd|rd|th)?(?:[\s,]+\d{{4}})?\b", " ", value, flags=re.I)  # March 5, 2026
    value = re.sub(r"\b\d{1,2}(?:st|nd|rd|th)\b", " ", value, flags=re.I)                             # 5th
    value = re.sub(r"\b\d+(?:\.\d+)?\s*(?:%|percent\b|per\s*cent\b)", " ", value, flags=re.I)         # 18%
    value = re.sub(r"\b(?:invoice|inv|bill|ref(?:erence)?|po|order|voucher|vch|challan|receipt|cheque|chq|utr|txn|no|number)\b[\s.:#\-]*(?:no\.?|number)?[\s.:#\-]*[A-Za-z0-9/\-]*\d[A-Za-z0-9/\-]*", " ", value, flags=re.I)
    value = re.sub(r"#\s*[A-Za-z0-9/\-]*\d[A-Za-z0-9/\-]*", " ", value)
    value = re.sub(rf"\b{_AMOUNT_TOKEN}\s*{_UNIT_AFTER}", " ", value, flags=re.I)                         # 3 months
    value = re.sub(r"\b\d{10,}\b", " ", value)                                                       # phone / account no.
    return value


def extract_amounts(text: str) -> Dict[str, Any]:
    """Return the amount found plus any ambiguity.

    {"amount": Decimal|None, "candidates": [Decimal...], "ambiguous": bool}
    Currency-marked figures (₹ / Rs / INR / "rupees", lakh / crore / k) win over bare numbers.
    """
    cleaned = _strip_non_amounts(text)
    marked: List[Decimal] = []
    plain: List[Decimal] = []

    def add(bucket: List[Decimal], amount: Optional[Decimal]) -> None:
        if amount is not None and amount not in bucket:
            bucket.append(amount)

    consumed = cleaned
    for m in re.finditer(rf"(?:₹|rs\.?|inr)?\s*({_AMOUNT_TOKEN})\s*(lakhs?|lacs?|crores?|cr|k)\b", cleaned, flags=re.I):
        factor = {"lakh": 100000, "lakhs": 100000, "lac": 100000, "lacs": 100000, "crore": 10000000, "crores": 10000000,
                  "cr": 10000000, "k": 1000}[m.group(2).lower()]
        base = _to_decimal(m.group(1))
        if base is not None:
            add(marked, (base * Decimal(factor)).quantize(PAISE, rounding=ROUND_HALF_UP))
        consumed = consumed.replace(m.group(0), " ", 1)
    for m in re.finditer(rf"(?:₹|\brs\.?|\binr)\s*({_AMOUNT_TOKEN})|({_AMOUNT_TOKEN})\s*(?:/-|rupees?\b|\brs\b|\binr\b)", consumed, flags=re.I):
        add(marked, _to_decimal(m.group(1) or m.group(2)))
        consumed = consumed.replace(m.group(0), " ", 1)
    for m in re.finditer(rf"(?<![\w.]){_AMOUNT_TOKEN}(?![\w])", consumed):
        add(plain, _to_decimal(m.group(0)))

    pool = marked or plain
    if not pool:
        return {"amount": None, "candidates": [], "ambiguous": False}
    if len(pool) > 1:
        return {"amount": None, "candidates": pool, "ambiguous": True}
    return {"amount": pool[0], "candidates": pool, "ambiguous": False}


def _extract_amount(text: str) -> Optional[Decimal]:
    """Backwards-compatible helper: the single unambiguous amount, else None."""
    return extract_amounts(text)["amount"]


def parse_gst(text: str, amount: Optional[Decimal]) -> Dict[str, Any]:
    """Detect a GST rate and whether the stated amount is inclusive or exclusive of it."""
    value = str(text or "")
    low = value.lower()
    result: Dict[str, Any] = {"mentioned": bool(re.search(r"\b(?:gst|igst|cgst|sgst)\b", low)), "rate": None, "mode": None,
                              "taxable_amount": None, "gst_amount": None, "gross_amount": None, "clarification": None}
    if not result["mentioned"]:
        return result
    rate = None
    for pat in (r"(\d+(?:\.\d+)?)\s*%\s*(?:igst|cgst|sgst|gst)\b", r"\b(?:igst|cgst|sgst|gst)\b\s*(?:@|at|of|rate)?\s*:?\s*(\d+(?:\.\d+)?)\s*%"):
        m = re.search(pat, low)
        if m:
            rate = float(m.group(1)); break
    result["rate"] = rate
    if rate is None:
        result["clarification"] = "A GST mention was found without a rate. What GST rate applies (5%, 12%, 18% or 28%)?"
        return result
    if rate not in VALID_GST_RATES:
        result["clarification"] = f"{rate:g}% is not a standard GST rate. Which GST rate applies?"
        return result
    inclusive = bool(re.search(r"\b(?:incl(?:uding|usive|uded)?|inc\.?|gst\s+included|inclusive\s+of)\b", low))
    exclusive = bool(re.search(r"\b(?:plus|excl(?:uding|usive|uded)?|extra|over\s+and\s+above|additional)\b|(?<![\w])\+\s*\d", low))
    if inclusive and exclusive:
        result["clarification"] = f"The text mentions both inclusive and exclusive GST. Is {rate:g}% GST included in the amount or added on top?"
        return result
    if not inclusive and not exclusive:
        result["clarification"] = f"Is the amount inclusive of {rate:g}% GST, or is the GST to be added on top?"
        return result
    result["mode"] = "inclusive" if inclusive else "exclusive"
    if amount is not None:
        factor = Decimal(str(rate)) / Decimal("100")
        if inclusive:
            taxable = (amount / (Decimal("1") + factor)).quantize(PAISE, rounding=ROUND_HALF_UP)
            gst = amount - taxable
            gross = amount
        else:
            taxable = amount
            gst = (amount * factor).quantize(PAISE, rounding=ROUND_HALF_UP)
            gross = taxable + gst
        result.update({"taxable_amount": float(taxable), "gst_amount": float(gst), "gross_amount": float(gross)})
    return result


def _clean_party(raw: str) -> Optional[str]:
    tokens = []
    for tok in re.split(r"\s+", raw.strip()):
        bare = tok.strip(",:;()")
        low = bare.lower().rstrip(".")
        if not bare or low in _PARTY_STOP or re.match(r"^[0-9₹@+%]", bare) or bare.startswith("/"):
            break
        tokens.append(bare.rstrip(",:;"))
        if tok.endswith((",", ":", ";")):
            break
    name = " ".join(tokens).strip(" .-&")
    if len(name) < 2 or name.lower() in _GENERIC_PARTIES:
        return None
    return name


def _extract_party(text: str) -> Optional[str]:
    value = str(text or "")
    for pattern in (r"\b(?:invoice|bill)\s+(?:to|from)\s+([A-Za-z][^\n]{1,100})",
                    r"\b(?:customer|vendor|supplier|client|party)\s*:?\s+([A-Za-z][^\n]{1,100})",
                    r"\b(?:to|from|with|by)\s+([A-Za-z][^\n]{1,100})"):
        for m in re.finditer(pattern, value, flags=re.I):
            name = _clean_party(m.group(1))
            if name:
                return name
    return None


class FinixIntelligence:
 @staticmethod
 def interpret(text:str,*,default_company_id:str="")->Dict[str,Any]:
  event=normalize_intent(text)
  found=extract_amounts(text); amount=found["amount"]; party=_extract_party(text)
  gst=parse_gst(text,amount) if event in ("SALE","PURCHASE") else {"mentioned":False,"rate":None,"mode":None,"taxable_amount":None,"gst_amount":None,"gross_amount":None,"clarification":None}
  payload={"company_id":default_company_id,"document_type":event,"amount":float(amount or 0),"total_invoice_value":float(gst.get("gross_amount") or amount or 0),"vendor_or_customer_name":party or ""}
  policy=classify_transaction(event,payload); clarification=[]
  if found["ambiguous"]:
   shown=", ".join(f"{c:,.2f}" for c in found["candidates"][:5])
   clarification.append(f"I found more than one amount ({shown}). Which one is the transaction amount?")
  elif amount is None: clarification.append("What is the transaction amount?")
  if TRANSACTION_POLICIES.get(event,{}).get("requires_party") and not party: clarification.append("Who is the customer/vendor/party involved?")
  if gst.get("clarification"): clarification.append(gst["clarification"])
  if event=="TDS_PAYMENT" and re.search(r"\d\s*%",str(text or "")): clarification.append("A percentage was given for a TDS payment. Is the amount stated the TDS actually deposited, or should TDS be calculated at that rate on a base amount?")
  if policy.get("status")=="REVIEW_REQUIRED" and policy.get("reason") not in clarification: clarification.append(policy["reason"])
  if event=="JOURNAL": clarification.append("Tell me what happened, for example: paid rent, received customer payment, bought stock, or transferred money between bank accounts.")
  # Deterministic confidence from what was actually understood - never a constant.
  confidence=0.30 if event=="JOURNAL" else 0.50
  if event!="JOURNAL":
   if amount is not None: confidence+=0.20
   elif found["ambiguous"]: confidence-=0.05
   if not TRANSACTION_POLICIES.get(event,{}).get("requires_party") or party: confidence+=0.10
   if not gst.get("mentioned") or gst.get("mode"): confidence+=0.05
   if not clarification: confidence+=0.10
   if clarification: confidence=min(confidence,0.70)
  confidence=round(max(0.05,min(confidence,0.95)),2)
  ok=bool(event!="JOURNAL" and amount is not None and not clarification)
  return {"success":ok,"event":event,"amount":float(amount or 0),"party_name":party or "","confidence":confidence,"confidence_band":FinixIntelligence.confidence_band(confidence),"needs_clarification":clarification,"policy":policy,"gst":gst,"taxable_amount":gst.get("taxable_amount") if gst.get("mode") else float(amount or 0),"gst_amount":gst.get("gst_amount") if gst.get("mode") else 0.0,"gross_amount":gst.get("gross_amount") if gst.get("mode") else float(amount or 0),"amount_candidates":[float(c) for c in found["candidates"]],"draft_payload":payload}
 @staticmethod
 def confidence_band(score:float)->str:
  score=float(score or 0); return "AUTO" if score>=0.90 else ("SUGGEST" if score>=0.75 else "REVIEW")
