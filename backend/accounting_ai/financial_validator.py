"""Fail-closed deterministic validation for Finix accounting postings."""

from __future__ import annotations
from typing import Dict, Any, List, Tuple
from datetime import datetime
import logging
from backend.dependencies import db
from backend.accounting_ai.gst_engine import GSTEngine
from backend.accounting_ai.accounting_controls import AccountingControlError, parse_accounting_date, validate_balanced_lines, money

logger = logging.getLogger("financial_validator")


class FinancialValidator:
    @classmethod
    async def check_period_lock(cls, company_id: str, posting_date_iso: str) -> Tuple[bool, str]:
        try:
            text = str(posting_date_iso or "").strip()
            if len(text) != 10:
                raise AccountingControlError("Accounting date is required in YYYY-MM-DD format.")
            posting_date = parse_accounting_date(text)
        except AccountingControlError as exc:
            return False, str(exc)
        try:
            lock_doc = await db.accounting_locks.find_one({"company_id": company_id, "is_active": True}, {"_id": 0})
        except Exception as exc:
            logger.exception("Unable to read accounting lock")
            return False, f"Unable to verify accounting period lock: {type(exc).__name__}. Posting blocked."
        if lock_doc and lock_doc.get("locked_until_date"):
            try:
                locked_until = parse_accounting_date(lock_doc["locked_until_date"])
            except AccountingControlError as exc:
                return False, f"Invalid accounting lock configuration: {exc}"
            if posting_date <= locked_until:
                return False, f"Period is locked through {locked_until.isoformat()}."
        now = datetime.now().date()
        if (now - posting_date).days > 730 or (posting_date - now).days > 365:
            return False, "Posting date is outside the acceptable operational range."
        return True, "Period is open."

    @classmethod
    async def detect_duplicate_invoice(cls, company_id: str, vendor_name: str, invoice_no: str, total_value: float, extracted_data: Dict[str, Any] | None = None) -> Tuple[bool, str]:
        extracted_data = extracted_data or {}
        invoice_no, vendor_name = str(invoice_no or "").strip(), str(vendor_name or "").strip()
        if not invoice_no or not vendor_name:
            return False, "Vendor/customer name and invoice number are required for safe duplicate detection."
        try:
            source_hash = str(extracted_data.get("source_document_hash") or "").strip()
            irn = str(extracted_data.get("irn") or extracted_data.get("invoice_reference_number") or "").strip()
            if source_hash and await db.zte_processed_documents.find_one({"company_id": company_id, "source_document_hash": source_hash, "status": "posted"}, {"_id": 0, "id": 1}):
                return False, "Duplicate source document detected."
            if irn and await db.zte_processed_documents.find_one({"company_id": company_id, "status": "posted", "$or": [{"extracted.irn": irn}, {"extracted.invoice_reference_number": irn}]}, {"_id": 0, "id": 1}):
                return False, "Duplicate invoice IRN/reference detected."
            if await db.journal_entries.find_one({"company_id": company_id, "source": "ai_zero_touch", "narration": {"$regex": invoice_no, "$options": "i"}}, {"_id": 0, "id": 1}):
                return False, f"Potential duplicate journal entry for invoice {invoice_no}."
            if await db.zte_processed_documents.find_one({"company_id": company_id, "status": "posted", "extracted.invoice_number": invoice_no, "extracted.vendor_or_customer_name": vendor_name}, {"_id": 0, "id": 1}):
                return False, f"Invoice {invoice_no} from {vendor_name} has already been posted."
        except Exception as exc:
            logger.exception("Duplicate detection failed")
            return False, f"Duplicate detection could not be completed ({type(exc).__name__}). Posting blocked."
        return True, "Invoice is unique."

    @classmethod
    async def validate_posting(cls, company_id: str, doc_type: str, extracted_data: Dict[str, Any], journal_lines: List[Dict[str, Any]]) -> Dict[str, Any]:
        report = {"passed": True, "errors": [], "warnings": [], "details": {}}
        period_ok, period_msg = await cls.check_period_lock(company_id, extracted_data.get("invoice_date") or "")
        if not period_ok:
            report["passed"], report["errors"] = False, report["errors"] + [period_msg]
        vendor_name, invoice_no = extracted_data.get("vendor_or_customer_name") or "", extracted_data.get("invoice_number") or ""
        unique_ok, unique_msg = await cls.detect_duplicate_invoice(company_id, vendor_name, invoice_no, float(extracted_data.get("total_invoice_value") or 0), extracted_data)
        if not unique_ok:
            report["passed"], report["errors"] = False, report["errors"] + [unique_msg]
        try:
            total_debit, total_credit = validate_balanced_lines(journal_lines)
        except AccountingControlError as exc:
            report["passed"], report["errors"] = False, report["errors"] + [str(exc)]
            total_debit = total_credit = money(0)
        account_ids = list(dict.fromkeys(str(line.get("account_id") or "") for line in journal_lines))
        if account_ids:
            try:
                accounts = await db.chart_of_accounts.find({"company_id": company_id, "id": {"$in": account_ids}}, {"_id": 0, "id": 1, "is_active": 1, "is_group": 1, "is_postable": 1}).to_list(len(account_ids))
            except Exception as exc:
                logger.exception("COA validation failed")
                accounts = []
                report["passed"], report["errors"] = False, report["errors"] + [f"Unable to verify ledgers ({type(exc).__name__}). Posting blocked."]
            found = {a.get("id"): a for a in accounts}
            for account_id in account_ids:
                account = found.get(account_id)
                if not account:
                    report["passed"], report["errors"] = False, report["errors"] + [f"Account {account_id} does not belong to company {company_id}."]
                elif account.get("is_active") is False or account.get("is_group") is True or account.get("is_postable") is False:
                    report["passed"], report["errors"] = False, report["errors"] + [f"Account {account_id} is not an active postable ledger."]
        tax = extracted_data.get("tax_breakup") or {}
        try:
            gst_ok, gst_msg = GSTEngine.validate_gst_calculations(float(extracted_data.get("taxable_value") or 0), float(tax.get("cgst") or 0), float(tax.get("sgst") or 0), float(tax.get("igst") or 0), float(extracted_data.get("total_tax") or 0), float(tax.get("cess") or 0))
        except (TypeError, ValueError) as exc:
            gst_ok, gst_msg = False, f"Invalid GST data: {exc}"
        if not gst_ok:
            report["passed"], report["errors"] = False, report["errors"] + [gst_msg]
        report["details"] = {"total_debit": float(total_debit), "total_credit": float(total_credit), "validation_timestamp": datetime.utcnow().isoformat() + "Z", "transaction_type": doc_type}
        return report
