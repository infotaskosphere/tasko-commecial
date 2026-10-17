"""Behaviour tests for the Finix ledger-integrity fixes (items 1-7).

They run the real application code against an in-memory MongoDB
(mongomock_motor); nothing is mocked except the database itself.
"""
import asyncio
import logging
import sys
import types
import warnings
from datetime import date

import pytest

pytest.importorskip("mongomock_motor")
from fastapi import HTTPException  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

USER = types.SimpleNamespace(id="u1", role="admin", company_id=None, permissions={}, email="a@b.c", username="admin")
_counter = {"n": 0}


@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.accounting_core as ac
    import backend.accounting_lock as lk
    import backend.invoicing as inv
    import backend.accounting_ai.finix_metrics as fm
    import backend.accounting_ai.accounting_controls  # noqa: F401  (imported so its db is swapped too)

    old = dep.db
    new = AsyncMongoMockClient()["finix_test"]
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    ac._acct_id_cache.clear()
    ac._ensured_coa_companies.clear()
    inv._reconcile_last_run.clear()
    _counter["n"] += 1
    cid = f"co{_counter['n']}"
    asyncio.run(ac.ensure_default_chart_of_accounts(cid, "u1"))
    return types.SimpleNamespace(db=new, ac=ac, lk=lk, inv=inv, fm=fm, cid=cid)


def run(coro):
    return asyncio.run(coro)


def invoice(env, iid, **over):
    doc = dict(id=iid, invoice_no=iid.upper(), invoice_type="tax_invoice", company_id=env.cid, client_name="Acme",
               status="sent", invoice_date="2026-10-10", due_date="2026-11-10", total_taxable=1000.0, subtotal=1000.0,
               total_gst=180.0, grand_total=1180.0, amount_paid=0.0, amount_due=1180.0, created_by="u1")
    doc.update(over)
    return doc


async def post_invoice(env, iid, **over):
    await env.db.invoices.insert_one(invoice(env, iid, **over))
    return await env.inv.sync_invoice_journal_entry(iid)


async def sales_total(env):
    pl = await env.ac.profit_and_loss(company_id=env.cid, date_from="2026-04-01", date_to="2027-03-31", current_user=USER)
    return pl["total_income"]


async def lock_period(env, through="2026-12-31"):
    await (env.db.accounting_locks.insert_one({"company_id": env.cid, "is_active": True, "locked_until_date": through}))


# ── item 1: deletes cannot break the books ───────────────────────────────────
def test_invoice_with_credit_note_cannot_be_deleted_and_nothing_is_orphaned(env):
    async def go():
        await post_invoice(env, "a")
        await post_invoice(env, "cn", invoice_type="credit_note", status="credit_note", original_invoice_id="a", amount_due=0.0)
        with pytest.raises(HTTPException) as exc:
            await env.inv.delete_invoice("a", USER)
        assert exc.value.status_code == 409 and "credit" in exc.value.detail.lower()
        assert await env.db.invoices.find_one({"id": "a"})            # untouched
        await env.inv.delete_invoice("cn", USER)                       # note first ...
        await env.inv.delete_invoice("a", USER)                        # ... then the invoice
        assert await sales_total(env) == 0
        assert await env.db.journal_entries.count_documents({"company_id": env.cid}) == 0
    run(go())


def test_bulk_delete_reports_blocked_items_and_orders_notes_first(env):
    async def go():
        await post_invoice(env, "a")
        await post_invoice(env, "b")
        await post_invoice(env, "cn", invoice_type="credit_note", status="credit_note", original_invoice_id="a", amount_due=0.0)
        res = await env.inv.bulk_delete_invoices(["a", "cn", "b"], USER)       # selection order is deliberately wrong
        assert res["deleted"] == 3 and res["failed"] == 0
        await post_invoice(env, "c")
        await post_invoice(env, "cn2", invoice_type="credit_note", status="credit_note", original_invoice_id="c", amount_due=0.0)
        res = await env.inv.bulk_delete_invoices(["c"], USER)                  # parent alone -> blocked, reported
        assert res["deleted"] == 0 and res["failed"] == 1 and "credit" in res["errors"][0]["reason"].lower()
    run(go())


def test_orphan_notes_are_listed_and_can_be_deleted(env):
    async def go():
        await post_invoice(env, "cn", invoice_type="credit_note", status="credit_note", original_invoice_id="gone", amount_due=0.0)
        listing = await env.inv.list_orphan_notes(company_id=env.cid, current_user=USER)
        assert listing["count"] == 1 and listing["orphan_notes"][0]["id"] == "cn"
        issues = await env.fm.integrity_issues(env.cid, await env.fm.load_ledger(env.cid))
        assert any(i["code"] == "ORPHAN_NOTE" for i in issues)
        await env.inv.delete_invoice("cn", USER)
        assert (await env.inv.list_orphan_notes(company_id=env.cid, current_user=USER))["count"] == 0
    run(go())


def test_invoice_with_real_payment_cannot_be_deleted(env):
    async def go():
        await post_invoice(env, "a")
        await env.inv.record_payment(env.inv.PaymentCreate(invoice_id="a", amount=500, payment_date="2026-10-12", reference_no="R1"), USER)
        with pytest.raises(HTTPException) as exc:
            await env.inv.delete_invoice("a", USER)
        assert exc.value.status_code == 409 and "payment" in exc.value.detail.lower()
    run(go())


def test_delete_is_audited(env):
    async def go():
        await post_invoice(env, "a")
        await env.inv.delete_invoice("a", USER)
        events = await env.db.accounting_audit.find({"company_id": env.cid}).to_list(50)
        assert any(e.get("event_type") == "INVOICE_DELETED" for e in events)
    run(go())


def test_locked_period_blocks_delete_edit_and_cancel(env):
    async def go():
        await post_invoice(env, "a")
        await lock_period(env)
        with pytest.raises(HTTPException) as e1:
            await env.inv.delete_invoice("a", USER)
        assert e1.value.status_code == 400 and "locked" in e1.value.detail.lower()
        with pytest.raises(HTTPException) as e2:
            await env.inv.update_invoice("a", {"items": [], "grand_total": 5000.0, "total_gst": 0.0, "invoice_date": "2026-10-10"}, None, USER)
        assert e2.value.status_code == 400
        with pytest.raises(HTTPException) as e3:
            await env.inv.update_invoice_status("a", {"status": "cancelled"}, USER)
        assert e3.value.status_code == 400
        assert await sales_total(env) == 1000.0                       # ledger entry still there
    run(go())


def test_failed_resync_never_erases_the_existing_entry(env):
    async def go():
        await post_invoice(env, "a")
        await lock_period(env)
        await env.db.invoices.update_one({"id": "a"}, {"$set": {"grand_total": 9999.0, "total_gst": 0.0}})   # bypasses the API guard
        outcome = await env.inv.sync_invoice_journal_entry("a")
        assert outcome == "failed"
        assert await env.db.journal_entries.count_documents({"source": "sale", "source_id": "a"}) == 1
        failure = await env.db.accounting_posting_failures.find_one({"source": "sale", "source_id": "a"})
        assert failure and failure["status"] == "POSTING_FAILED"
    run(go())


def test_reconcile_cannot_resurrect_a_deleted_invoice(env):
    async def go():
        await post_invoice(env, "a")
        await env.inv.delete_invoice("a", USER)
        env.inv._reconcile_last_run.clear()
        await env.inv._reconcile_and_sync_all_sales_and_payments_impl(env.cid)
        assert await env.db.journal_entries.count_documents({"company_id": env.cid}) == 0
    run(go())


def test_system_entries_cannot_be_deleted_by_hand_even_by_admin(env):
    async def go():
        await post_invoice(env, "a")
        entry = await env.db.journal_entries.find_one({"source": "sale", "source_id": "a"})
        with pytest.raises(HTTPException) as exc:
            await env.ac.delete_journal_entry(entry["id"], USER)
        assert exc.value.status_code == 400
        res = await env.ac.delete_all_journal_entries({"company_id": env.cid}, USER)
        assert res["deleted_count"] == 0 and res["skipped_system_entries"] == 1
        assert await env.db.journal_entries.count_documents({"source_id": "a"}) == 1
    run(go())


def test_delete_all_requires_a_company(env):
    async def go():
        with pytest.raises(HTTPException) as exc:
            await env.ac.delete_all_journal_entries({}, USER)
        assert exc.value.status_code == 400
    run(go())


# ── item 3: payment validation ───────────────────────────────────────────────
def test_payment_validation(env):
    PC = env.inv.PaymentCreate

    async def pay(**kw):
        base = dict(invoice_id="a", amount=100, payment_date="2026-10-12")
        base.update(kw)
        return await env.inv.record_payment(PC(**base), USER)

    async def expect(status, text, **kw):
        with pytest.raises(HTTPException) as exc:
            await pay(**kw)
        assert exc.value.status_code == status and text in exc.value.detail, exc.value.detail

    async def go():
        await post_invoice(env, "a")
        await expect(400, "greater than zero", amount=0)
        await expect(400, "greater than zero", amount=-5)
        await expect(400, "greater than zero", amount=float("nan"))
        await expect(400, "exceeds outstanding", amount=1180.01)
        await expect(400, "valid date", payment_date="12/10/2026")
        ok = await pay(amount=180, reference_no="UTR1")
        assert ok["amount"] == 180
        await expect(409, "duplicate", amount=180, reference_no="UTR1")
        await expect(400, "exceeds outstanding", amount=1001)
        await pay(amount=1000, reference_no="UTR2")                              # settles it exactly
        await expect(400, "exceeds outstanding", amount=1)
        inv_doc = await env.db.invoices.find_one({"id": "a"})
        assert inv_doc["status"] == "paid" and inv_doc["amount_due"] == 0
        # every accepted payment has its journal entry
        for p in await env.db.payments.find({"invoice_id": "a"}).to_list(10):
            assert await env.db.journal_entries.count_documents({"source": "payment", "source_id": p["id"]}) == 1
        await post_invoice(env, "x", status="cancelled")
        await expect(400, "cancelled", invoice_id="x")
        await post_invoice(env, "pf", invoice_type="proforma")
        await expect(400, "tax invoices", invoice_id="pf")
        await post_invoice(env, "bk", paid_bank_txn_id="t1", journal_entry_id="je-1")
        await env.db.journal_entries.insert_one({"id": "je-1", "company_id": env.cid})
        await expect(409, "already settled through bank reconciliation", invoice_id="bk")
    run(go())


def test_payment_in_locked_period_is_rejected(env):
    async def go():
        await post_invoice(env, "a")
        await lock_period(env)
        with pytest.raises(HTTPException) as exc:
            await env.inv.record_payment(env.inv.PaymentCreate(invoice_id="a", amount=100, payment_date="2026-10-12"), USER)
        assert exc.value.status_code == 400 and "locked" in exc.value.detail.lower()
        assert await env.db.payments.count_documents({}) == 0
    run(go())


def test_payment_is_rolled_back_when_ledger_cannot_post(env, monkeypatch):
    async def go():
        await post_invoice(env, "a")
        await env.db.chart_of_accounts.delete_many({"company_id": env.cid, "code": "1010"})
        env.ac._acct_id_cache.clear()
        env.ac._ensured_coa_companies.discard(env.cid)
        await env.db.chart_of_accounts.delete_many({"company_id": env.cid, "code": "1010"})

        async def no_account(company_id, code):
            return None if code == "1010" else "x"
        monkeypatch.setattr(env.ac, "get_default_account_id", no_account)
        with pytest.raises(HTTPException) as exc:
            await env.inv.record_payment(env.inv.PaymentCreate(invoice_id="a", amount=100, payment_date="2026-10-12"), USER)
        assert exc.value.status_code == 409
        assert await env.db.payments.count_documents({}) == 0
    run(go())


# ── items 4-6: ledger-based dashboard numbers ────────────────────────────────
def test_financial_year_start_handles_january_to_march():
    from backend.accounting_ai.finix_metrics import financial_year_start
    assert financial_year_start(date(2027, 1, 15)) == date(2026, 4, 1)
    assert financial_year_start(date(2027, 3, 31)) == date(2026, 4, 1)
    assert financial_year_start(date(2026, 4, 1)) == date(2026, 4, 1)
    assert financial_year_start(date(2026, 12, 31)) == date(2026, 4, 1)


def test_statutory_summary_reads_the_ledger_and_ignores_non_revenue_documents(env):
    async def go():
        today = date.today().isoformat()
        await post_invoice(env, "a", invoice_date=today, total_cgst=90.0, total_sgst=90.0, total_igst=0.0)
        await post_invoice(env, "cn", invoice_date=today, invoice_type="credit_note", status="credit_note", original_invoice_id="a",
                           grand_total=118.0, total_gst=18.0, total_taxable=100.0, total_cgst=9.0, total_sgst=9.0, amount_due=0.0)
        await post_invoice(env, "pf", invoice_date=today, invoice_type="proforma", grand_total=99999.0, total_gst=9999.0)
        await post_invoice(env, "x", invoice_date=today, status="cancelled", grand_total=77777.0, total_gst=7777.0)
        res = await env.fm.statutory_summary(env.cid)
        gst = res["gst"]
        assert gst["total_output_liability"] == 162.0               # 180 - 18, from the ledger
        assert gst["outward_cgst"] == 81.0 and gst["outward_sgst"] == 81.0
        assert gst["outward_taxable"] == 900.0
        assert gst["net_payable"] == 162.0
        assert gst["document_check"]["output_gst_gl_vs_documents"] == 0
        assert "Ready" not in str(gst) and "Nil Return" not in str(gst)
        assert gst["period"]["gstr3b_due"].endswith("-20")
    run(go())


def test_statutory_summary_for_empty_company_claims_nothing(env):
    res = run(env.fm.statutory_summary(env.cid))
    assert res["gst"]["total_output_liability"] == 0 and res["gst"]["has_activity"] is False
    assert "Ready" not in str(res)


def test_health_score_without_data_is_not_invented(env):
    res = run(env.fm.health_score(env.cid))
    assert res["score"] is None and res["status"] == "NO_DATA"


def test_health_score_is_capped_when_an_orphan_note_exists(env):
    async def go():
        await post_invoice(env, "a", invoice_date=date.today().isoformat(), total_taxable=1000000.0, total_gst=0.0, grand_total=1000000.0, amount_due=1000000.0)
        clean = await env.fm.health_score(env.cid)
        assert clean["score"] is not None and not clean["issues"]
        await post_invoice(env, "cn", invoice_date=date.today().isoformat(), invoice_type="credit_note", status="credit_note",
                           original_invoice_id="deleted", grand_total=2000000.0, total_taxable=2000000.0, total_gst=0.0, amount_due=0.0)
        bad = await env.fm.health_score(env.cid)
        codes = {i["code"] for i in bad["issues"]}
        assert {"ORPHAN_NOTE", "NEGATIVE_RECEIVABLES"} <= codes
        assert bad["score"] <= 79 and bad["grade"] in ("B", "C") and bad["score"] < clean["score"]
    run(go())


def test_receivables_include_party_ledgers(env):
    async def go():
        from backend.party_ledgers import get_or_create_party_account
        party = await get_or_create_party_account(env.cid, "customer", "Mehta Traders", created_by="u1")
        sales = await env.ac.get_default_account_id(env.cid, "4000")
        await env.ac.post_journal_entry(env.cid, "2026-10-01", "AI sale", [
            {"account_id": party["account_id"], "account_name": "Mehta", "debit": 500.0, "credit": 0.0},
            {"account_id": sales, "account_name": "Sales", "debit": 0.0, "credit": 500.0}], "manual", None, "u1")
        ledger = await env.fm.load_ledger(env.cid)
        assert ledger.balance("1100", "dr") == 500.0
    run(go())


def test_cashflow_runway_is_none_without_expense_history(env):
    async def go():
        res = await env.fm.cashflow_forecast(env.cid)
        assert res["runway_months"] is None and res["runway_status"] == "Not enough expense history"
        assert res["assumptions"]["collection_rates"]
    run(go())


# ── item 7: AI text interpretation ───────────────────────────────────────────
@pytest.mark.parametrize("text,amount,party", [
    ("Sold services to Mehta Traders for 50000 plus 18% GST", 50000.0, "Mehta Traders"),
    ("Sold services to Mehta Traders plus 18% GST for Rs 50,000", 50000.0, "Mehta Traders"),
    ("Received 50000 from ABC Ltd against invoice INV-2026-0012", 50000.0, "ABC Ltd"),
    ("Paid ₹25,000 for 3 months rent to Shah Estates", 25000.0, "Shah Estates"),
    ("Paid 2 lakh to vendor Zen Tech Pvt Ltd", 200000.0, "Zen Tech Pvt Ltd"),
    ("bought stock 12000 from Sharma & Sons on 5th March 2026", 12000.0, "Sharma & Sons"),
])
def test_amount_and_party_extraction(text, amount, party):
    from backend.accounting_ai.finix_intelligence import FinixIntelligence
    r = FinixIntelligence.interpret(text)
    assert r["amount"] == amount and r["party_name"] == party, r
    assert not r["needs_clarification"]


def test_gst_exclusive_and_inclusive():
    from backend.accounting_ai.finix_intelligence import FinixIntelligence
    ex = FinixIntelligence.interpret("Sold services to Mehta Traders 50000 plus 18% GST")
    assert (ex["taxable_amount"], ex["gst_amount"], ex["gross_amount"]) == (50000.0, 9000.0, 59000.0)
    inc = FinixIntelligence.interpret("Sold services to Mehta Traders 59000 including 18% GST")
    assert (inc["taxable_amount"], inc["gst_amount"], inc["gross_amount"]) == (50000.0, 9000.0, 59000.0)


def test_ambiguity_is_asked_not_guessed():
    from backend.accounting_ai.finix_intelligence import FinixIntelligence
    r = FinixIntelligence.interpret("Sold to Mehta 5000 and 7000")
    assert r["success"] is False and r["amount"] == 0.0 and any("more than one amount" in c for c in r["needs_clarification"])
    g = FinixIntelligence.interpret("Sold services to Mehta Traders 50000 with 18% GST")
    assert g["success"] is False and any("inclusive" in c for c in g["needs_clarification"])
    t = FinixIntelligence.interpret("TDS paid 10% 5000")
    assert t["event"] == "TDS_PAYMENT" and t["success"] is False


def test_confidence_is_computed_not_constant():
    from backend.accounting_ai.finix_intelligence import FinixIntelligence
    clean = FinixIntelligence.interpret("Received 50000 from ABC Ltd")["confidence"]
    vague = FinixIntelligence.interpret("something happened with Mehta")["confidence"]
    ambiguous = FinixIntelligence.interpret("Sold to Mehta 5000 and 7000")["confidence"]
    assert clean > ambiguous > vague or clean > vague
    assert len({clean, vague, ambiguous}) == 3


def test_ai_proposal_posts_gst_lines(env, monkeypatch):
    async def go():
        from backend.accounting_ai import finix_ai_router as router
        res = await router._build_proposal("Sold services to Mehta Traders 50000 plus 18% GST", env.cid, "2026-10-10", USER)
        assert res["success"] is True
        dr = round(sum(l["debit"] for l in res["lines"]), 2)
        cr = round(sum(l["credit"] for l in res["lines"]), 2)
        assert dr == cr == 59000.0
        gst_line = [l for l in res["lines"] if l["account_name"] == "GST Output Payable"][0]
        assert gst_line["credit"] == 9000.0
    run(go())
