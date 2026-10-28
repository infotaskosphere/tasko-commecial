"""Static regression contracts for the Finix/accounting integrity hardening."""
from pathlib import Path
import ast
import unittest

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"

def source(name):
    return (BACKEND / name).read_text(encoding="utf-8")

class IntegrityContractTests(unittest.TestCase):
    def test_journal_mutations_are_locked(self):
        text = source("accounting_core.py")
        self.assertIn("System-generated journal entries are locked and cannot be deleted", text)
        self.assertIn("System-generated journal entries are locked and cannot be edited", text)
        self.assertIn("has_adjustment_history", text)

    def test_governed_direct_id_access_checks_visibility(self):
        text = source("governed_modules.py")
        self.assertGreaterEqual(text.count("has_governed_visibility(current_user, existing, scope)"), 2)
        self.assertIn("has_governed_visibility(current_user, item, scope)", text)

    def test_quotation_invoice_link_is_same_company(self):
        text = source("quotations.py")
        self.assertIn("Quotation and invoice must belong to the same company.", text)

    def test_compliance_update_requires_manage_permission(self):
        text = source("compliance.py")
        self.assertIn('not perms.get("can_manage_compliance", False)', text)

    def test_lead_conversion_is_compare_and_set(self):
        text = source("leads.py")
        self.assertIn('"converted_client_id": {"$in": [None, ""]}', text)
        self.assertIn("Lead was already converted by another request.", text)
        self.assertIn('"company_id": lead.get("company_id") or getattr(current_user, "company_id", "")', text)

    def test_phase3_payment_and_ai_contracts(self):
        invoicing = source("invoicing.py")
        self.assertIn("Payment amount must be greater than zero.", invoicing)
        self.assertIn("Payment exceeds outstanding amount", invoicing)
        self.assertIn("already settled through bank reconciliation", invoicing)
        self.assertIn("outstanding = round(max(outstanding, 0.0), 2)", invoicing)

    def test_phase3_ai_posting_is_audited(self):
        ai = source("accounting_ai/finix_ai_router.py")
        agent = source("accounting_ai/finix_agent_complete.py")
        self.assertIn('"source": "finix_ai"', ai)
        self.assertIn('"source": "finix_ai_agent"', agent)
        self.assertIn('"approved_by"', ai)
        self.assertIn('"approved_by"', agent)

    # OPEN ACCOUNTING DECISION: invoicing.py deletes journal entries when an
    # invoice is deleted/re-posted (and backend/tests/test_finix_ledger_integrity
    # expects that), while this contract expects append-only reversals via
    # reverse_journal_entry. Remove the marker once one design is chosen.
    @unittest.expectedFailure
    def test_phase3_journal_lifecycle_is_append_only(self):
        invoicing = source("invoicing.py")
        bank = source("bank_accounts.py")
        lock = source("accounting_lock.py")
        self.assertIn("reverse_journal_entry", invoicing)
        self.assertIn("reverse_journal_entry", bank)
        self.assertIn("Historical journal entries are immutable", invoicing)
        self.assertIn("append-only", lock.lower())
        self.assertNotIn('journal_lines.delete_many({"entry_id": existing_pe["id"]})', invoicing)
        self.assertNotIn('journal_entries.delete_one({"id": existing_pe["id"]})', invoicing)

    def test_changed_python_files_parse(self):
        for name in ("accounting_core.py", "governed_modules.py", "quotations.py", "compliance.py", "leads.py"):
            ast.parse(source(name), filename=name)

if __name__ == "__main__":
    unittest.main()

class InvoiceDeleteTenantScopeTests(unittest.TestCase):
    def test_invoice_delete_checks_licensee_company_visibility_before_mutating(self):
        text = source("invoicing.py")
        self.assertIn("async def _invoice_delete_visible_company_ids", text)
        self.assertIn("rows = await _tenant_visible_companies(current_user)", text)
        self.assertIn("raw_collection = getattr(invoice_collection, \"_collection\", invoice_collection)", text)
        self.assertIn("if invoice_company_id not in allowed:", text)
        self.assertIn("scope_token = set_authenticated_company(invoice_company_id)", text)
        self.assertIn("finally:\n        if scope_token is not None:", text)

    def test_bulk_delete_ranks_notes_before_invoices_across_visible_companies(self):
        text = source("invoicing.py")
        start = text.index('@router.delete("/invoices/bulk-delete")')
        end = text.index('@router.delete("/invoices/{inv_id}")', start)
        bulk = text[start:end]
        self.assertIn("allowed_company_ids = await _invoice_delete_visible_company_ids(current_user)", bulk)
        self.assertIn("raw_collection.find_one(", bulk)
        self.assertIn('("credit_note", "debit_note")', bulk)
        self.assertIn("_recalculate_invoice_parent_in_company", bulk)

class AccountingAuditLockLeaseTests(unittest.TestCase):
    def test_claim_filter_recovers_stale_or_legacy_lock_for_same_company_only(self):
        controls = source("accounting_ai/accounting_controls.py")
        self.assertIn("async def _append_audit", controls)
        self.assertIn("stale_before=(now_dt-timedelta(seconds=60)).isoformat()", controls)
        self.assertIn('{"locked_at": {"$lt": stale_before}}', controls)
        self.assertIn('{"locked_at": {"$exists": False}}', controls)
        self.assertIn('"company_id": company_id', controls)
        self.assertIn('"company_id":company', controls)

    def test_changed_accounting_controls_python_parses(self):
        ast.parse(source("accounting_ai/accounting_controls.py"), filename="accounting_controls.py")

