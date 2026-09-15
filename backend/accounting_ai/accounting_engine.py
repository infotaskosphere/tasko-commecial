"""Central deterministic orchestration layer for Finix accounting."""

from typing import Dict, Any, Optional
import logging
from backend.accounting_ai.ledger_mapper import LedgerMapper
from backend.accounting_ai.gst_engine import GSTEngine
from backend.accounting_ai.tds_engine import TDSEngine
from backend.accounting_ai.cost_center_engine import CostCenterEngine
from backend.accounting_ai.narration_generator import NarrationGenerator
from backend.accounting_ai.journal_builder import JournalBuilder
from backend.accounting_ai.financial_validator import FinancialValidator
from backend.accounting_ai.accounting_controls import require_document_type, AccountingControlError
from backend.accounting_ai.accounting_policy import classify_transaction

logger = logging.getLogger("accounting_engine")


class AccountingEngine:
    @classmethod
    async def process_document(cls, company_id: str, extracted_data: Dict[str, Any], vendor_profile: Optional[Dict[str, Any]] = None, cumulative_vendor_annual_spend: float = 0.0) -> Dict[str, Any]:
        try:
            doc_type = require_document_type(extracted_data.get("document_type"))
        except AccountingControlError as exc:
            return {"success": False, "requires_review": True, "accounting_event": "UNCLASSIFIED", "ledger_code": None, "ledger_name": None, "confidence": 0.0, "gst_split": {}, "tds_result": {"applicable": False, "requires_review": True}, "dimensions": {}, "narration": "", "journal_lines": [], "validation_report": {"passed": False, "errors": [str(exc)], "warnings": [], "details": {"classification_status": "UNCLASSIFIED"}}}

        substance = classify_transaction(doc_type, extracted_data)
        if substance.get("status") != "READY":
            return {"success": False, "requires_review": True, "accounting_event": doc_type, "ledger_code": None, "ledger_name": None, "confidence": 0.0, "gst_split": {}, "tds_result": {"applicable": False, "requires_review": True}, "dimensions": {}, "narration": "", "journal_lines": [], "validation_report": {"passed": False, "errors": [substance.get("reason", "Accounting policy review required.")], "warnings": [], "details": {"policy": substance}}}

        ledger_code, ledger_name, mapper_confidence = await LedgerMapper.resolve_ledger(company_id=company_id, extracted_data=extracted_data, vendor_profile=vendor_profile)
        total_tax = float(extracted_data.get("total_tax") or 0.0)
        company_gst = str(extracted_data.get("billed_to_gstin") or "").strip()
        vendor_gst = str(extracted_data.get("tax_registration_number") or "").strip()
        if not company_gst:
            try:
                from backend.dependencies import db
                company_doc = await db.companies.find_one({"id": company_id}, {"_id": 0, "gstin": 1})
                company_gst = str((company_doc or {}).get("gstin") or "").strip()
            except Exception:
                logger.exception("Unable to resolve company GSTIN")

        gst_split = GSTEngine.determine_gst_split(company_gstin=company_gst, vendor_gstin=vendor_gst, total_tax_amount=total_tax, place_of_supply_state=extracted_data.get("place_of_supply_state"), supplier_state=extracted_data.get("supplier_state"))
        if gst_split.get("status") == "REVIEW_REQUIRED":
            return {"success": False, "requires_review": True, "accounting_event": doc_type, "ledger_code": ledger_code, "ledger_name": ledger_name, "confidence": mapper_confidence, "gst_split": gst_split, "tds_result": {"applicable": False, "requires_review": True}, "dimensions": {}, "narration": "", "journal_lines": [], "validation_report": {"passed": False, "errors": [gst_split.get("reason")], "warnings": [], "details": {"gst": gst_split}}}

        tds_result = TDSEngine.evaluate_tds(account_code=ledger_code, taxable_value=float(extracted_data.get("taxable_value") or 0.0), cumulative_vendor_annual_spend=cumulative_vendor_annual_spend, vendor_profile=vendor_profile, transaction_date=extracted_data.get("invoice_date"), section=extracted_data.get("tds_section"), service_type=extracted_data.get("tds_service_type"), deductee_type=extracted_data.get("tds_deductee_type"), pan_available=extracted_data.get("pan_available"))
        dimensions = CostCenterEngine.resolve_dimensions(extracted_data=extracted_data, vendor_profile=vendor_profile)
        narration = NarrationGenerator.generate(event_type=doc_type, extracted_data=extracted_data, category=ledger_name)
        journal_lines = await JournalBuilder.build_journal_lines(company_id=company_id, doc_type=doc_type, extracted_data=extracted_data, resolved_ledger_code=ledger_code, gst_split=gst_split, tds_result=tds_result, dimensions=dimensions)
        validation_report = await FinancialValidator.validate_posting(company_id=company_id, doc_type=doc_type, extracted_data=extracted_data, journal_lines=journal_lines)
        if tds_result.get("requires_review"):
            validation_report["passed"] = False
            validation_report["errors"].append(tds_result.get("reason", "TDS review required."))
        success = bool(validation_report.get("passed"))
        return {"success": success, "requires_review": not success, "accounting_event": doc_type, "ledger_code": ledger_code, "ledger_name": ledger_name, "confidence": mapper_confidence, "gst_split": gst_split, "tds_result": tds_result, "dimensions": dimensions, "narration": narration, "journal_lines": journal_lines, "validation_report": validation_report}

    @classmethod
    async def process_posting(cls, company_id: str, extracted_data: Dict[str, Any], created_by: str, source_id: str, vendor_profile: Optional[Dict[str, Any]] = None, cumulative_vendor_annual_spend: float = 0.0) -> Dict[str, Any]:
        instructions = await cls.process_document(company_id, extracted_data, vendor_profile, cumulative_vendor_annual_spend)
        if not instructions.get("success"):
            raise ValueError("Accounting posting requires review: " + "; ".join(instructions.get("validation_report", {}).get("errors", []) or ["validation failed"]))
        from backend.accounting_core import post_journal_entry
        entry = await post_journal_entry(company_id=company_id, entry_date=extracted_data.get("invoice_date") or "", narration=instructions["narration"], lines=instructions["journal_lines"], source="ai_zero_touch", source_id=source_id, created_by=created_by)
        from backend.accounting_ai.voucher_builder import VoucherBuilder
        voucher = await VoucherBuilder.create_and_save_voucher(company_id=company_id, voucher_type=instructions["accounting_event"], document_id=source_id, journal_entry_id=entry["id"], party_name=extracted_data.get("vendor_or_customer_name") or "", total_amount=float(extracted_data.get("total_invoice_value") or 0.0), journal_lines=instructions["journal_lines"], transaction_date=extracted_data.get("invoice_date"))
        from backend.accounting_ai.ledger_learning import LedgerLearningEngine
        await LedgerLearningEngine.learn_from_approval(vendor_name=extracted_data.get("vendor_or_customer_name") or "", gstin=extracted_data.get("tax_registration_number") or "", company_id=company_id, approved_ledger_code=instructions["ledger_code"], meta={"department": instructions["dimensions"].get("department"), "cost_center": instructions["dimensions"].get("cost_center"), "project": instructions["dimensions"].get("project"), "narration_template": instructions["narration"]})
        from backend.accounting_ai.posting_storage import PostingStorage
        await PostingStorage.save_posting_history(document_id=source_id, company_id=company_id, payload={"id": entry["id"], "accounting_event": instructions["accounting_event"], "posting_instructions": instructions, "journal_entry_id": entry["id"], "voucher_id": voucher["id"], "status": "posted"})
        from backend.accounting_ai.accounting_audit import AccountingAuditTrail
        await AccountingAuditTrail.log_posting_event(user_id=created_by, document_id=source_id, company_id=company_id, ai_recommendation={"ledger_code": instructions["ledger_code"], "ledger_name": instructions["ledger_name"], "accounting_event": instructions["accounting_event"]}, final_decision={"ledger_code": instructions["ledger_code"], "ledger_name": instructions["ledger_name"], "accounting_event": instructions["accounting_event"]}, corrections={}, journal_version=1, voucher_version=1, approval_history=[])
        return entry
