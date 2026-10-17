"""Tests for audit items 8 (zero-touch confidence / company lookup / auto-post) and 9 (TDS thresholds).

TDS tests are pure. The zero-touch tests run the real code against an in-memory MongoDB (mongomock_motor).
"""
import asyncio
import logging
import sys
import types
import warnings

import pytest

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

from backend.accounting_ai.tds_engine import TDSEngine  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

USER = types.SimpleNamespace(id="u1", role="admin", company_id=None, permissions={}, email="a@b.c", username="admin")


def run(coro):
    return asyncio.run(coro)


# ── item 9: TDS thresholds (rules in force from 1 April 2025, carried into the Income-tax Act 2025) ──────────
def tds(code, value, prior=0, date="2026-09-15", **kw):
    return TDSEngine.evaluate_tds(code, value, prior, transaction_date=date, pan_available=True, **kw)


def test_rent_threshold_is_50000_a_month_and_exactly_50000_is_not_taxed():
    assert tds("5200", 50000)["applicable"] is False
    r = tds("5200", 50000.01)
    assert r["applicable"] is True and r["rate"] == 0.10 and r["section"] == "194I"


def test_rent_is_no_longer_tested_against_an_annual_2_40_000():
    # the old rule would have deducted: 40,000 a month is 4,80,000 a year, over the old 2,40,000
    r = tds("5200", 40000, prior=440000)
    assert r["applicable"] is False


def test_multi_month_rent_bill_is_tested_per_month():
    assert tds("5200", 150000, rent_period_months=3)["applicable"] is False        # 50,000 a month exactly
    assert tds("5200", 150000, rent_period_months=2)["applicable"] is True         # 75,000 a month
    r = tds("5200", 150000)
    assert r["applicable"] is True and "one month" in r["reason"]                  # assumption is stated, not hidden


def test_plant_and_machinery_rent_is_2_percent():
    r = tds("5200", 100000, service_type="machinery")
    assert r["applicable"] and r["rate"] == 0.02 and r["deduction_amount"] == 2000.0


def test_professional_fees_threshold_is_50000_for_the_year():
    assert tds("5250", 50000)["applicable"] is False
    assert tds("5250", 50000.01)["applicable"] is True
    assert tds("5250", 25000, prior=30000)["applicable"] is True                    # 55,000 for the year
    assert tds("5250", 20000, prior=30000)["applicable"] is False                   # exactly 50,000
    r = tds("5250", 100000, service_type="technical")
    assert r["rate"] == 0.02 and r["deduction_amount"] == 2000.0
    assert tds("5250", 100000)["rate"] == 0.10


def test_contractor_thresholds_are_strictly_exceeded():
    assert tds("5000", 30000)["applicable"] is False
    assert tds("5000", 30000.01)["applicable"] is True
    assert tds("5000", 25000, prior=75000)["applicable"] is False                   # exactly 1,00,000 for the year
    assert tds("5000", 25000, prior=75000.01)["applicable"] is True
    assert tds("5000", 100000, deductee_type="company")["rate"] == 0.02
    assert tds("5000", 100000)["rate"] == 0.01


def test_new_act_references_from_april_2026_and_old_sections_before():
    assert tds("5250", 100000, date="2026-03-31")["statutory_reference"] == "194J"
    assert "6(iii)" in tds("5250", 100000, date="2026-04-01")["statutory_reference"]
    assert "2(ii)" in tds("5200", 100000, date="2026-04-01")["statutory_reference"]
    assert "6(i)" in tds("5000", 100000, date="2026-04-01")["statutory_reference"]


def test_a_year_without_a_verified_policy_goes_to_review_instead_of_guessing():
    r = tds("5200", 100000, date="2024-09-01")
    assert r["requires_review"] is True and r["applicable"] is False


# ── item 8: zero-touch ───────────────────────────────────────────────────────
@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.zero_touch_entry as zte
    import backend.ai.decision_engine as de
    import backend.ai.document_validator as dv
    import backend.ai.validation_storage  # noqa: F401
    import backend.accounting_ai.accounting_engine  # noqa: F401

    old = dep.db
    new = AsyncMongoMockClient()["audit_items_test"]
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    return types.SimpleNamespace(db=new, zte=zte, de=de, dv=dv)


VALID = {"field_validation": {"is_valid": True, "errors": []}, "business_rules": {"is_valid": True, "errors": []}}


def test_company_thresholds_are_found_by_company_id_not_mongo_underscore_id(env):
    async def go():
        await env.db.companies.insert_one({"id": "c1", "name": "Acme", "auto_post_min_confidence": 0.95})
        d, _ = await env.de.make_routing_decision(0.90, VALID, [], {"total_invoice_value": 1000}, company_id="c1")
        assert d == "REQUIRES_REVIEW"                                  # this company wants 0.95 before auto-posting
        d, _ = await env.de.make_routing_decision(0.90, VALID, [], {"total_invoice_value": 1000}, company_id="other")
        assert d == "AUTO_POST"                                        # unknown company: safe defaults (0.85)
    run(go())


def test_nonsense_company_thresholds_are_ignored(env):
    async def go():
        await env.db.companies.insert_one({"id": "c2", "name": "Bad", "auto_post_min_confidence": 0.1, "review_min_confidence": 0.9,
                                           "approval_required_amount": -5})
        t = env.de._company_thresholds({"auto_post_min_confidence": 0.1, "review_min_confidence": 0.9, "approval_required_amount": -5},
                                       env.de.DEFAULT_THRESHOLDS)
        assert t["auto_post_min_confidence"] == 0.85 and t["approval_required_amount"] == 50000.0
        assert t["review_min_confidence"] == 0.9
        t = env.de._company_thresholds({"auto_post_min_confidence": "abc", "review_min_confidence": 7}, env.de.DEFAULT_THRESHOLDS)
        assert t == env.de.DEFAULT_THRESHOLDS
    run(go())


def test_a_vendor_profile_without_a_score_is_not_assumed_to_be_90_percent_sure(env):
    async def go():
        data = {"vendor_or_customer_name": "Acme", "invoice_number": "INV-1", "invoice_date": "2026-10-01",
                "taxable_value": 1000, "total_invoice_value": 1180}
        meta = {"confidence": 0.9, "quality_score": 0.9, "engine_used": "gemini_vision", "pages_processed": 1}
        none = await env.dv.run_document_validation_pipeline(data, meta, "a.pdf", "d1", vendor_profile={"vendor_name": "Acme"}, company_id="c1")
        assert none["field_confidences"]["vendor_or_customer_name"] <= 0.70      # unknown score = unknown vendor confidence
        scored = await env.dv.run_document_validation_pipeline(data, meta, "a.pdf", "d2", vendor_profile={"vendor_name": "Acme"},
                                                               company_id="c1", vendor_match_score=0.8)
        assert scored["field_confidences"]["vendor_or_customer_name"] > 0.70
        assert scored["overall_confidence"] > none["overall_confidence"]
        # the profile's own trust score can only lower the match score, never raise it
        distrusted = await env.dv.run_document_validation_pipeline(
            data, meta, "a.pdf", "d3", vendor_profile={"vendor_name": "Acme", "confidence_score": 0.2}, company_id="c1", vendor_match_score=0.8)
        assert distrusted["overall_confidence"] < scored["overall_confidence"]
        lone = await env.dv.run_document_validation_pipeline(data, meta, "a.pdf", "d4", vendor_profile={"vendor_name": "Acme", "confidence_score": 0.2},
                                                             company_id="c1")
        assert lone["overall_confidence"] == distrusted["overall_confidence"]
    run(go())


def test_the_models_own_confidence_caps_field_confidence():
    from backend.ai.confidence_engine import calculate_field_confidences
    data = {"vendor_or_customer_name": "A", "invoice_number": "INV-1", "taxable_value": 100}
    high = calculate_field_confidences(data, {"confidence": 0.95, "quality_score": 0.9, "engine_used": "gemini_vision"}, 1.0)
    low = calculate_field_confidences(data, {"confidence": 0.40, "quality_score": 0.9, "engine_used": "gemini_vision"}, 1.0)
    assert high["invoice_number"] > low["invoice_number"]
    assert low["invoice_number"] <= 0.45


def test_historical_accuracy_is_measured_and_unknown_until_enough_reviews(env):
    async def go():
        assert await env.dv.company_review_accuracy("c1") == 0.5
        docs = [{"company_id": "c1", "reviewed_by": "u1", "status": "posted" if i < 15 else "rejected", "created_at": f"2026-10-{i + 1:02d}"}
                for i in range(20)]
        await env.db.zte_processed_documents.insert_many(docs)
        assert await env.dv.company_review_accuracy("c1") == 0.75
        assert await env.dv.company_review_accuracy("") == 0.5
        assert await env.dv.company_review_accuracy("someone-else") == 0.5
    run(go())


def _patch_pipeline(monkeypatch, env, captured, decision="AUTO_POST"):
    zte = env.zte
    monkeypatch.setattr(zte, "_file_to_image_b64", lambda c, f: ("b64", "image/png"))

    async def fake_extract(img, mime):
        return dict(captured["extracted"])
    monkeypatch.setattr(zte, "_vision_extract_json", fake_extract)

    async def fake_company(user, extracted):
        return "c1", "matched", 1.0
    monkeypatch.setattr(zte, "resolve_company", fake_company)

    async def fake_preview(cid, extracted):
        return {"lines": [], "narration": "n", "entry_date": "2026-10-01", "fx": None}
    monkeypatch.setattr(zte, "build_ledger_preview", fake_preview)

    async def fake_validate(**kw):
        captured["validate"] = kw
        return {"decision": decision, "decision_reason": "test", "overall_confidence": 0.9}
    monkeypatch.setattr("backend.ai.document_validator.run_document_validation_pipeline", fake_validate)

    from backend.accounting_ai.accounting_engine import AccountingEngine

    async def fake_posting(**kw):
        captured["posting"] = kw
        saved = await env.db.zte_processed_documents.find_one({"id": kw["source_id"]})
        captured["saved_before_posting"] = bool(saved)
        return {"id": "je-1"}
    monkeypatch.setattr(AccountingEngine, "process_posting", staticmethod(fake_posting))


EXTRACTED = {"document_type": "SALE", "vendor_or_customer_name": "Acme Customers Ltd", "tax_registration_number": "27AAPFU0939F1ZV",
             "invoice_number": "S-77", "invoice_date": "2026-10-01", "taxable_value": 1000, "total_invoice_value": 1180}


def test_auto_post_saves_the_document_first_and_posts_its_real_data(env, monkeypatch):
    cap = {"extracted": dict(EXTRACTED, confidence=0.93)}
    _patch_pipeline(monkeypatch, env, cap)

    async def go():
        rec = await env.zte.process_document(b"x", "a.png", USER)
        assert rec["status"] == "posted" and rec["journal_entry_id"] == "je-1"
        assert cap["saved_before_posting"] is True                       # the posting could see this document's own record
        assert cap["posting"]["extracted_data"]["invoice_number"] == "S-77"      # ... and was NOT the "Unknown Party" fallback
        assert cap["posting"]["extracted_data"]["document_type"] == "SALE"
        stored = await env.db.zte_processed_documents.find({"id": rec["id"]}).to_list(5)
        assert len(stored) == 1 and stored[0]["status"] == "posted" and stored[0]["journal_entry_id"] == "je-1"
        assert "_saved" not in stored[0] and "_id" not in rec
    run(go())


def test_a_missing_model_confidence_is_passed_on_as_unknown_not_85_percent(env, monkeypatch):
    cap = {"extracted": dict(EXTRACTED)}                                  # the model gave no "confidence"
    _patch_pipeline(monkeypatch, env, cap, decision="REQUIRES_REVIEW")

    async def go():
        rec = await env.zte.process_document(b"x", "a.png", USER)
        meta = cap["validate"]["ocr_metadata"]
        assert meta["confidence_reported"] is False and meta["confidence"] == 0.5 and meta["quality_score"] == 0.5
        assert rec["status"] == "pending_approval" and "posting" not in cap
        cap["extracted"] = dict(EXTRACTED, confidence=0.9)
        await env.zte.process_document(b"x", "b.png", USER)
        assert cap["validate"]["ocr_metadata"]["confidence_reported"] is True and cap["validate"]["ocr_metadata"]["confidence"] == 0.9
        cap["extracted"] = dict(EXTRACTED, confidence=7)                  # nonsense is not trusted either
        await env.zte.process_document(b"x", "c.png", USER)
        assert cap["validate"]["ocr_metadata"]["confidence_reported"] is False
    run(go())


def test_the_vendor_match_score_is_passed_to_the_decision_pipeline(env, monkeypatch):
    cap = {"extracted": dict(EXTRACTED, confidence=0.9)}
    _patch_pipeline(monkeypatch, env, cap, decision="REQUIRES_REVIEW")

    async def fake_match(name, gstin=""):
        return {"vendor_name": name}, 0.6, "fuzzy"
    monkeypatch.setattr(env.zte, "find_best_vendor_match", fake_match)

    async def go():
        await env.zte.process_document(b"x", "a.png", USER)
        assert cap["validate"]["vendor_match_score"] == 0.6
    run(go())
