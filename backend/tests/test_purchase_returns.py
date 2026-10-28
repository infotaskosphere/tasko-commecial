"""Purchase Returns: a return REVERSES the bill through its own journal entry;
deleting the return DELETES that entry. The bill's own entry is never edited.

Runs the real application code against an in-memory MongoDB (mongomock_motor).
"""
import asyncio
import logging
import sys
import types
import warnings

import pytest

pytest.importorskip("mongomock_motor")
from fastapi import HTTPException  # noqa: E402
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

USER = types.SimpleNamespace(id="u1", role="admin", company_id=None, permissions={}, email="a@b.c", username="admin")
_counter = {"n": 0}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.accounting_core as ac
    import backend.accounting_lock as lk
    import backend.invoicing as inv
    import backend.purchase_returns as pr

    old = dep.db
    new = AsyncMongoMockClient()["purchase_returns_test"]
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    ac._acct_id_cache.clear()
    ac._ensured_coa_companies.clear()
    _counter["n"] += 1
    cid = f"prco{_counter['n']}"
    run(ac.ensure_default_chart_of_accounts(cid, "u1"))
    return types.SimpleNamespace(db=new, ac=ac, lk=lk, inv=inv, pr=pr, cid=cid)


async def _bill(env, bid="b1", total=11800.0, gst=1800.0):
    await env.db.purchase_invoices.insert_one({
        "id": bid, "invoice_no": f"BILL-{bid}", "company_id": env.cid, "supplier_name": "Acme Supplies",
        "invoice_date": "2026-10-01", "grand_total": total, "total_gst": gst, "taxable_amount": total - gst,
        "status": "outstanding", "amount_paid": 0.0, "amount_due": total, "created_by": "u1",
    })
    await env.inv.sync_purchase_journal_entry(bid)


async def _balance(env, code):
    acct = await env.ac.get_default_account_id(env.cid, code)
    lines = await env.db.journal_lines.find({"account_id": acct}).to_list(10000)
    return round(sum(float(l.get("debit") or 0) - float(l.get("credit") or 0) for l in lines), 2)


def _ret(**kw):
    from backend.purchase_returns import PurchaseReturnCreate
    return PurchaseReturnCreate(**{"return_date": "2026-10-10", "taxable_amount": 1000, "gst_amount": 180, **kw})


def test_return_posts_its_own_reversing_entry_and_leaves_the_bill_entry_untouched(env):
    async def go():
        await _bill(env)
        bill_entry = await env.db.journal_entries.find_one({"source": "purchase", "source_id": "b1"}, {"_id": 0})
        res = await env.pr.create_purchase_return("b1", _ret(), USER)

        # the bill's entry is the same entry, unchanged
        after = await env.db.journal_entries.find_one({"source": "purchase", "source_id": "b1"}, {"_id": 0})
        assert after["id"] == bill_entry["id"]
        # the return has its own entry
        ret_entry = await env.db.journal_entries.find_one({"source": "purchase_return", "source_id": res["purchase_return"]["id"]})
        assert ret_entry is not None
        # books: AP owed 11800 - 1180, purchases 10000 - 1000, GST input 1800 - 180
        assert await _balance(env, "2000") == -(11800 - 1180)
        assert await _balance(env, "5000") == 10000 - 1000
        assert await _balance(env, "1200") == 1800 - 180
        bill = await env.db.purchase_invoices.find_one({"id": "b1"})
        assert bill["amount_returned"] == 1180 and bill["amount_due"] == 10620 and bill["status"] == "outstanding"
    run(go())


def test_deleting_a_return_deletes_only_its_entry_and_restores_outstanding(env):
    async def go():
        await _bill(env)
        res = await env.pr.create_purchase_return("b1", _ret(), USER)
        rid = res["purchase_return"]["id"]
        await env.pr.delete_purchase_return(rid, USER)
        assert await env.db.journal_entries.count_documents({"source": "purchase_return", "source_id": rid}) == 0
        assert await env.db.journal_entries.count_documents({"source": "purchase", "source_id": "b1"}) == 1
        assert await _balance(env, "2000") == -11800
        bill = await env.db.purchase_invoices.find_one({"id": "b1"})
        assert bill["amount_due"] == 11800 and bill["amount_returned"] == 0
    run(go())


def test_cannot_return_more_than_the_bill_or_its_gst(env):
    async def go():
        await _bill(env)
        await env.pr.create_purchase_return("b1", _ret(taxable_amount=9000, gst_amount=1620), USER)
        with pytest.raises(HTTPException) as e1:
            await env.pr.create_purchase_return("b1", _ret(taxable_amount=1500, gst_amount=0), USER)   # 10620 + 1500 > 11800
        assert e1.value.status_code == 400
        with pytest.raises(HTTPException) as e2:
            await env.pr.create_purchase_return("b1", _ret(taxable_amount=0, gst_amount=200), USER)    # GST 1620 + 200 > 1800
        assert e2.value.status_code == 400
    run(go())


def test_bill_with_returns_cannot_be_deleted_or_cancelled(env):
    async def go():
        await _bill(env)
        await env.pr.create_purchase_return("b1", _ret(), USER)
        with pytest.raises(HTTPException) as e1:
            await env.inv.delete_purchase_invoice("b1", USER)
        assert e1.value.status_code == 409 and "return" in e1.value.detail.lower()
        with pytest.raises(HTTPException) as e2:
            await env.inv.update_purchase_invoice_status("b1", {"status": "cancelled"}, USER)
        assert e2.value.status_code == 409
        assert await env.db.purchase_invoices.find_one({"id": "b1"})
    run(go())


def test_payment_is_limited_to_the_bill_less_returns(env):
    async def go():
        await _bill(env)
        await env.pr.create_purchase_return("b1", _ret(), USER)          # 1180 returned, 10620 owed
        with pytest.raises(HTTPException):
            await env.inv.update_purchase_invoice_status("b1", {"status": "partially_paid", "amount": 11000}, USER)
        res = await env.inv.update_purchase_invoice_status("b1", {"status": "paid"}, USER)
        assert res["status"] == "paid" and res["amount_due"] == 0 and res["amount_paid"] == 10620
        assert await _balance(env, "2000") == 0
    run(go())


def test_return_in_a_locked_period_is_refused(env):
    async def go():
        await _bill(env)
        await env.db.accounting_locks.insert_one({"company_id": env.cid, "is_active": True, "locked_until_date": "2026-10-31"})
        with pytest.raises(HTTPException) as e:
            await env.pr.create_purchase_return("b1", _ret(), USER)
        assert e.value.status_code == 400 and "locked" in e.value.detail.lower()
        assert await env.db.purchase_returns.count_documents({}) == 0
    run(go())


def test_purchase_returns_are_tenant_scoped():
    from backend.tenant_runtime import TENANT_COLLECTIONS
    assert "purchase_returns" in TENANT_COLLECTIONS


def test_sale_return_credit_note_reverses_through_its_own_entry(env):
    """Mirror rule on the sales side: a credit note never edits the invoice's entry."""
    async def go():
        await env.db.invoices.insert_one({
            "id": "s1", "invoice_no": "INV-S1", "invoice_type": "tax_invoice", "company_id": env.cid,
            "client_name": "Beta", "invoice_date": "2026-10-01", "due_date": "2026-10-31", "status": "sent",
            "items": [], "total_taxable": 10000.0, "total_gst": 1800.0, "total_cgst": 900.0, "total_sgst": 900.0,
            "total_igst": 0.0, "grand_total": 11800.0, "amount_paid": 0.0, "amount_due": 11800.0, "created_by": "u1"})
        await env.inv.sync_invoice_journal_entry("s1")
        sale_entry = await env.db.journal_entries.find_one({"source": "sale", "source_id": "s1"}, {"_id": 0})
        await env.db.invoices.insert_one({
            "id": "cn1", "invoice_no": "CN-1", "invoice_type": "credit_note", "status": "credit_note",
            "original_invoice_id": "s1", "company_id": env.cid, "client_name": "Beta", "invoice_date": "2026-10-05",
            "items": [], "total_taxable": 1000.0, "total_gst": 180.0, "total_cgst": 90.0, "total_sgst": 90.0,
            "total_igst": 0.0, "grand_total": 1180.0, "amount_paid": 0.0, "amount_due": 0.0, "created_by": "u1"})
        await env.inv.sync_invoice_journal_entry("cn1")
        after = await env.db.journal_entries.find_one({"source": "sale", "source_id": "s1"}, {"_id": 0})
        assert after["id"] == sale_entry["id"]
        assert await env.db.journal_entries.count_documents({"source_id": "cn1"}) == 1
    run(go())


def test_gst_summary_nets_purchase_returns_and_documents_agree_with_ledger(env):
    from datetime import date
    import backend.accounting_ai.finix_metrics as fm

    async def go():
        await env.db.purchase_invoices.insert_one({
            "id": "g1", "invoice_no": "BILL-G1", "company_id": env.cid, "supplier_name": "Acme Supplies",
            "invoice_date": "2026-10-01", "grand_total": 11800.0, "total_gst": 1800.0, "taxable_amount": 10000.0,
            "cgst_amount": 900.0, "sgst_amount": 900.0, "igst_amount": 0.0,
            "status": "outstanding", "amount_paid": 0.0, "amount_due": 11800.0, "created_by": "u1"})
        await env.inv.sync_purchase_journal_entry("g1")
        await env.pr.create_purchase_return("g1", _ret(cgst_amount=90, sgst_amount=90), USER)
        summary = await fm.statutory_summary(env.cid, today=date(2026, 10, 28))
        month = summary["gst"]["month"]
        assert month["inward_taxable"] == 9000.0
        assert month["inward_cgst"] == 810.0 and month["inward_sgst"] == 810.0
        assert month["total_input_itc"] == 1620.0
        assert month["document_check"]["input_gst_gl_vs_documents"] == 0.0
    run(go())


def test_payables_ageing_subtracts_returns(env):
    import backend.accounting_extended as ae

    async def go():
        await _bill(env)
        await env.pr.create_purchase_return("b1", _ret(), USER)
        report = await ae.outstanding_payable(company_id=env.cid, as_of="2026-10-28", current_user=USER)
        assert report["total_outstanding"] == 10620.0
        assert report["rows"][0]["amount_returned"] == 1180.0
    run(go())
