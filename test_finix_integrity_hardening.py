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
