"""Fail-closed deterministic validation for Finix accounting postings."""

from __future__ import annotations

from typing import Dict, Any, List, Tuple
from datetime import datetime
import logging
from backend.dependencies import db
from backend.accounting_ai.gst_engine import GSTEngine
from backend.accounting_ai.accounting_controls import (
    AccountingControlError,
    parse_accounting_date,
    validate_balanced_lines,
    money,
)

logger = logging.getLogger("financial_validator")


class FinancialValidator:
    @classmethod
    async def check_period_lock(cls, company_id: str, posting_date_iso: str) -> Tuple[bool, str]:
        """Reject locked periods and malformed/out-of-policy accounting dates.

        Database failures are deliberately fail-closed. A system that cannot
        prove a period is open must not post accounting data.
        """
        try:
            posting_date = parse_accounting_date(posting_date_iso)
        except AccountingControlError as exc:
            return False, str(exc)

        try:
            lock_doc = await db.accounting_locks.find_one(
                {"company_id": company_id, "is_active": True}, {"_id": 0}
            )
        except Exception as exc:
            logger.exception("Unable to read accounting lock for company=%s", company_id)
            return False, f"Unable to verify accounting period lock: {type(exc).__name__}. Posting blocked."

        if lock_doc:
            lock_limit = lock_doc.get("locked_until_date")
            if lock_limit:
                try:
                    locked_until = parse_accounting_date(lock_limit)
                except AccountingControlError as exc:
                    return False, f"Invalid accounting lock configuration: {exc}"
                if posting_date <= locked_until:
                    return False, f"Period is locked. The books are locked up to {locked_until.isoformat()}."

        now = datetime.now().date()
        if (now - posting_date).days > 365 * 2 or (posting_date - now).days > 365:
            return False, "Posting date is outside the acceptable operational range (too far in past/future)."

        return True, "Period is open."

    @classmethod
    async def detect_duplicate_invoice(
        cls,
        company_id: str,
        vendor_name: str,
        invoice_no: str,
        total_value: float,
        extracted_data: Dict[str, Any] | None = None,
    ) -> Tuple[bool, str]:
        """Perform layered duplicate detection across journals and documents."""
        extracted_data = extracted_data or {}
        invoice_no = str(invoice_no or "").strip()
        vendor_name = str(vendor_name or "").strip()
        if not invoice_no or not vendor_name:
            return False, "Vendor name and invoice number are required for safe duplicate detection."

        try:
            # Strongest identifier: source document hash / IRN when available.
            source_hash = str(extracted_data.get("source_document_hash") or "").strip()
            irn = str(extracted_data.get("irn") or extracted_data.get("invoice_reference_number") or "").strip()
            if source_hash:
                dup = await db.zte_processed_documents.find_one(
                    {"company_id": company_id, "source_document_hash": source_hash, "status": "posted"},
                    {"_id": 0, "id": 1},
                )
                if dup:
                    return False, f"Duplicate source document detected (document {dup.get('id')})."
            if irn:
                dup = await db.zte_processed_documents.find_one(
                    {"company_id": company_id, "status": "posted", "extracted.irn": irn},
                    {"_id": 0, "id": 1},
                )
                if dup:
                    return False, f"Duplicate invoice IRN detected: {irn}."

            query = {
                "company_id": company_id,
                "source": "ai_zero_touch",
                "narration": {"$regex": invoice_no, "$options": "i"},
            }
            dup = await db.journal_entries.find_one(query, {"_id": 0, "id": 1})
            if dup:
                return False, f"Potential duplicate detected: journal entry {dup['id']} matches invoice {invoice_no}."

            dup_doc = await db.zte_processed_documents.find_one(
                {
                    "company_id": company_id,
                    "status": "posted",
                    "extracted.invoice_number": invoice_no,
                    "extracted.vendor_or_customer_name": vendor_name,
                },
                {"_id": 0, "id": 1},
            )
            if dup_doc:
                return False, f"Potential duplicate: invoice {invoice_no} from {vendor_name} has already been posted."
        except Exception as exc:
            logger.exception("Duplicate detection failed for company=%s invoice=%s", company_id, invoice_no)
            return False, f"Duplicate detection could not be completed ({type(exc).__name__}). Posting blocked."

        return True, "Invoice is unique."

    @classmethod
    async def validate_posting(
        cls,
        company_id: str,
        doc_type: str,
        extracted_data: Dict[str, Any],
        journal_lines: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Run accounting controls; critical failures always block posting."""
        report = {"passed": True, "errors": [], "warnings": [], "details": {}}

        posting_date = extracted_data.get("invoice_date")
        period_ok, period_msg = await cls.check_period_lock(company_id, posting_date or "")
        if not period_ok:
            report["passed"] = False
            report["errors"].append(period_msg)

        vendor_name = extracted_data.get("vendor_or_customer_name") or ""
        invoice_no = extracted_data.get("invoice_number") or ""
        total_val = float(extracted_data.get("total_invoice_value") or 0.0)
        unique_ok, unique_msg = await cls.detect_duplicate_invoice(
            company_id, vendor_name, invoice_no, total_val, extracted_data
        )
        if not unique_ok:
            report["passed"] = False
            report["errors"].append(unique_msg)

        try:
            total_debit, total_credit = validate_balanced_lines(journal_lines)
        except AccountingControlError as exc:
            report["passed"] = False
            report["errors"].append(str(exc))
            total_debit = money(0)
            total_credit = money(0)

        # Every referenced ledger must exist in this company and be active.
        account_ids = [str(line.get("account_id") or "") for line in journal_lines]
        if account_ids:
            try:
                accounts = await db.chart_of_accounts.find(
                    {"company_id": company_id, "id": {"$in": account_ids}},
                    {"_id": 0, "id": 1, "is_active": 1},
                ).to_list(len(account_ids))
            except Exception as exc:
                logger.exception("Chart-of-accounts validation failed for company=%s", company_id)
                report["passed"] = False
                report["errors"].append(
                    f"Unable to verify referenced ledgers ({type(exc).__name__}). Posting blocked."
                )
                accounts = []
            found = {a.get("id"): a for a in accounts}
            for account_id in account_ids:
                account = found.get(account_id)
                if not account:
                    report["passed"] = False
                    report["errors"].append(f"Account {account_id} does not belong to company {company_id}.")
                elif account.get("is_active") is False:
                    report["passed"] = False
                    report["errors"].append(f"Account {account_id} is inactive and cannot receive postings.")

        # GST arithmetic is a hard accounting control, not a warning.
        tax_breakup = extracted_data.get("tax_breakup") or {}
        cgst = float(tax_breakup.get("cgst") or 0.0)
        sgst = float(tax_breakup.get("sgst") or 0.0)
        igst = float(tax_breakup.get("igst") or 0.0)
        cess = float(tax_breakup.get("cess") or 0.0)
        total_tax = float(extracted_data.get("total_tax") or 0.0)
        gst_ok, gst_msg = GSTEngine.validate_gst_calculations(
            taxable_value=float(extracted_data.get("taxable_value") or 0.0),
            cgst=cgst,
            sgst=sgst,
            igst=igst,
            total_tax=total_tax,
        )
        if not gst_ok:
            report["passed"] = False
            report["errors"].append(gst_msg)
        if cess < 0:
            report["passed"] = False
            report["errors"].append("GST cess cannot be negative.")

        report["details"] = {
            "total_debit": float(total_debit),
            "total_credit": float(total_credit),
            "validation_timestamp": datetime.utcnow().isoformat() + "Z",
            "transaction_type": doc_type,
        }
        return report
