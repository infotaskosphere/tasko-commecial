"""Finix physical model extraction integrity checks."""
import importlib

PAIRS = [
    ("backend.accounting_core", "backend.modules.finix_ai.accounting.models_accounting"),
    ("backend.accounting_extended", "backend.modules.finix_ai.accounting.models_extended"),
    ("backend.accounting_ai.finix_ai_router", "backend.modules.finix_ai.ai.models_finix_ai"),
    ("backend.bank_accounts", "backend.modules.finix_ai.banking.models_banking"),
    ("backend.gst_reconciliation", "backend.modules.finix_ai.reconciliation.models_gst"),
    ("backend.party_ledgers", "backend.modules.finix_ai.accounting.models_party_ledgers"),
]

MODEL_NAMES = {
    "backend.accounting_core": ("AccountCreate", "JournalLine", "JournalEntryCreate"),
    "backend.accounting_extended": ("OpeningBalanceLine", "OpeningBalanceRequest", "MatchRequest", "FixedAssetRequest", "TDSTCSEntry", "BulkJournalLine", "BulkJournalEntry", "BulkImportRequest"),
    "backend.accounting_ai.finix_ai_router": ("FinixAIRequest", "FinixAIPostRequest"),
    "backend.bank_accounts": ("BankAccountCreate", "ManualMatchInput", "UnmatchInput", "AIAutoMatchInput", "IgnoreInput", "BankRulePayload", "ManualReconcilePayload", "BackfillSuspenseInput"),
    "backend.gst_reconciliation": ("ReconciliationSession", "SessionSaveBody", "GSTR3BBody", "ITCReversalBody", "VendorCommunicationBody", "GSTINBatchBody", "TradeNameBody", "TradeNamesBatchBody", "SessionUpdateBody", "AIInsightBody"),
    "backend.party_ledgers": ("RenameRequest",),
}

def test_finix_legacy_modules_reexport_physical_models():
    for legacy_name, physical_name in PAIRS:
        legacy = importlib.import_module(legacy_name)
        physical = importlib.import_module(physical_name)
        for name in MODEL_NAMES[legacy_name]:
            assert getattr(legacy, name) is getattr(physical, name)
