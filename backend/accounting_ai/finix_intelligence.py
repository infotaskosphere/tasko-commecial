"""
Finix Intelligence — layman-first AI accounting orchestration.

This module deliberately sits above the deterministic accounting engine. AI may
interpret a user's natural-language intent and propose classifications, but it
must not bypass double-entry validation, statutory controls, period locks, or
approval/audit controls.
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Dict, List, Optional
import re

from backend.accounting_ai.accounting_controls import AccountingControlError, money
from backend.accounting_ai.accounting_policy import TRANSACTION_POLICIES, classify_transaction

PAISE = Decimal("0.01")

# Human language -> canonical accounting event. The vocabulary is intentionally
# broad so a non-accountant can speak normally.
INTENT_PATTERNS = [
    (r"\b(sold|sales invoice|invoice to customer|customer invoice|raised invoice)\b", "SALE"),
    (r"\b(bought|purchase invoice|supplier invoice|vendor bill|purchased)\b", "PURCHASE"),
    (r"\b(paid|payment to|paid to|settled vendor|supplier payment)\b", "PAYMENT"),
    (r"\b(received|money received|customer payment|collection received|collected)\b", "RECEIPT"),
    (r"\b(transferred|transfer from|transfer to|bank transfer)\b", "BANK_TRANSFER"),
    (r"\b(cash deposited|cash withdrawal|withdrawn from bank|deposited into bank)\b", "CONTRA"),
    (r"\b(bank charge|bank fee|charges by bank)\b", "BANK_CHARGE"),
    (r"\b(loan received|loan taken|loan proceeds)\b", "LOAN_RECEIPT"),
    (r"\b(loan repaid|emi paid|loan repayment)\b", "LOAN_REPAYMENT"),
    (r"\b(salary|payroll|salaries paid)\b", "PAYROLL"),
    (r"\b(depreciation|depreciate)\b", "DEPRECIATION"),
    (r"\b(gst paid|paid gst|gst payment)\b", "GST_PAYMENT"),
    (r"\b(tds paid|paid tds|tds payment)\b", "TDS_PAYMENT"),
    (r"\b(returned goods to supplier|purchase return)\b", "PURCHASE_RETURN"),
    (r"\b(customer returned|sales return)\b", "SALE_RETURN"),
    (r"\b(advance paid|paid advance)\b", "ADVANCE_PAYMENT"),
    (r"\b(advance received|received advance)\b", "ADVANCE_RECEIPT"),
]


def normalize_intent(text: str) -> str:
    value = str(text or "").strip().lower()
    for pattern, event in INTENT_PATTERNS:
        if re.search(pattern, value, flags=re.IGNORECASE):
            return event
    return "JOURNAL"


def _extract_amount(text: str) -> Optional[Decimal]:
    value = str(text or "")
    # Supports common Indian forms: 1,25,000 / 125000 / 1.25 lakh.
    lakh = re.search(r"(?:₹|rs\.?|inr\s*)?\s*([0-9]+(?:\.[0-9]+)?)\s*lakh\b", value, flags=re.I)
    if lakh:
        return (Decimal(lakh.group(1)) * Decimal("100000")).quantize(PAISE, rounding=ROUND_HALF_UP)
    matches = re.findall(r"(?:₹|rs\.?|inr\s*)\s*([0-9][0-9,]*(?:\.[0-9]+)?)|\b([0-9][0-9,]*(?:\.[0-9]+)?)\b", value, flags=re.I)
    nums: List[Decimal] = []
    for first, second in matches:
        raw = (first or second).replace(",", "")
        try:
            amount = Decimal(raw).quantize(PAISE, rounding=ROUND_HALF_UP)
            if amount > 0:
                nums.append(amount)
        except Exception:
            continue
    return nums[0] if nums else None


def _extract_party(text: str) -> Optional[str]:
    patterns = [
        r"\b(?:to|from|with|customer|vendor|supplier)\s+([A-Za-z][A-Za-z0-9&.\- ]{1,80})",
        r"\b(?:invoice|bill)\s+(?:to|from)\s+([A-Za-z][A-Za-z0-9&.\- ]{1,80})",
    ]
    for pattern in patterns:
        m = re.search(pattern, str(text or ""), flags=re.I)
        if m:
            return re.split(r"\s+(?:for|of|on|amounting|worth)\s+|[,:;]", m.group(1).strip(), maxsplit=1, flags=re.I)[0].strip()
    return None


class FinixIntelligence:
    @staticmethod
    def interpret(text: str, *, default_company_id: str = "") -> Dict[str, Any]:
        event = normalize_intent(text)
        amount = _extract_amount(text)
        party = _extract_party(text)
        result = {
            "success": event in TRANSACTION_POLICIES and amount is not None,
            "event": event,
            "amount": float(amount or Decimal("0.00")),
            "party_name": party or "",
            "confidence": 0.70 if event != "JOURNAL" else 0.45,
            "needs_clarification": [],
            "explanation": "",
            "draft_payload": {},
        }
        if amount is None:
            result["needs_clarification"].append("What is the transaction amount?")
        if TRANSACTION_POLICIES.get(event, {}).get("requires_party") and not party:
            result["needs_clarification"].append("Who is the customer/vendor/party involved?")
        if event == "JOURNAL":
            result["needs_clarification"].append("What happened in accounting terms (for example: paid rent, received customer payment, bought stock)?")
        result["explanation"] = {
            "SALE": "Finix will treat this as customer revenue and create receivable/GST entries when applicable.",
            "PURCHASE": "Finix will treat this as a supplier purchase and create payable/GST entries when applicable.",
            "PAYMENT": "Finix will treat this as settlement of a payable or other payment transaction.",
            "RECEIPT": "Finix will treat this as receipt/collection against a customer or other receivable.",
        }.get(event, "Finix has identified the accounting event and will validate the proposed entry before posting.")
        result["draft_payload"] = {
            "company_id": default_company_id,
            "document_type": event,
            "amount": float(amount or Decimal("0.00")),
            "total_invoice_value": float(amount or Decimal("0.00")),
            "vendor_or_customer_name": party or "",
        }
        return result

    @staticmethod
    def confidence_band(score: float) -> str:
        score = float(score or 0)
        if score >= 0.90:
            return "AUTO"
        if score >= 0.75:
            return "SUGGEST"
        return "REVIEW"
