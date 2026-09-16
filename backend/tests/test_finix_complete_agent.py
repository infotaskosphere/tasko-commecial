import ast
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_finix_agent_modules_compile():
    files = [
        ROOT / "accounting_ai" / "finix_learning.py",
        ROOT / "accounting_ai" / "finix_ai_router.py",
        ROOT / "accounting_ai" / "finix_agent_complete.py",
        ROOT / "accounting_ai" / "finix_reconciliation_agent.py",
    ]
    for path in files:
        ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def test_complete_agent_is_governed():
    text = (ROOT / "accounting_ai" / "finix_agent_complete.py").read_text(encoding="utf-8")
    assert "post_journal_entry" in text
    assert "_can_post" in text
    assert "record_learning" in text
    assert "finix_ai_proposals" in text


def test_reconciliation_agent_learns_feedback():
    text = (ROOT / "accounting_ai" / "finix_reconciliation_agent.py").read_text(encoding="utf-8")
    assert "record_learning" in text
    assert "BANK_RECONCILIATION" in text
    assert "matched_type" in text
