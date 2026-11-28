"""Leftover ledger entries after invoices are deleted.

* Deleting an invoice removes its automatic receipts and their journal entries
  even when a receipt was stamped with another of the customer's companies.
* A system-generated entry whose source document is gone (or an automatic
  receipt whose invoice is gone) can be deleted from Journal Entries; entries
  whose document still exists stay locked.
"""
import asyncio
import logging
import sys
import types
import warnings

import pytest
from fastapi import HTTPException

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

ME = types.SimpleNamespace(id="u1", role="admin", company_id="MDA", permissions={}, email="a@b.c",
                           username="admin", commercial_customer_id=None, license_id=None)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.accounting_core as ac
    import backend.accounting_lock as lk
    import backend.invoicing as inv
    from backend import tenant_runtime as tr

    client = AsyncMongoMockClient()
    raw = client["orphan_cleanup_test"]
    tdb = tr.TenantAwareDatabase(raw, mongo_client=client)
    old = dep.db
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", tdb)
    monkeypatch.setattr(dep, "db", tdb)
    monkeypatch.setattr(inv, "require_finix_action", lambda *a, **k: None)
    monkeypatch.setattr(ac, "require_finix_action", lambda *a, **k: None)

    async def _visible(_user):  # the customer's two legal companies (Master Data)
        return {"MDA", "PDV"}
    monkeypatch.setattr(inv, "_invoice_delete_visible_company_ids", _visible)
    ac._acct_id_cache.clear()
    ac._ensured_coa_companies.clear()
    return types.SimpleNamespace(raw=raw, ac=ac, lk=lk, inv=inv, tr=tr)


async def _in(env, company, coro_fn):
    tok = env.tr.set_authenticated_company(company)
    try:
        return await coro_fn()
    finally:
        env.tr.reset_authenticated_company(tok)


async def _setup(env):
    env.tr.set_tenant_company_ids({"MDA", "PDV"})
    for c in ("MDA", "PDV"):
        await _in(env, c, lambda c=c: env.ac.ensure_default_chart_of_accounts(c, "u1"))
    await env.raw.invoices.insert_one({
        "id": "inv1", "company_id": "PDV", "invoice_no": "INV/26-27/017", "invoice_type": "tax_invoice",
        "client_name": "DESAI TECH WEAVES LLP", "invoice_date": "2026-06-11", "status": "paid",
        "grand_total": 1700.0, "total_taxable": 1440.68, "total_gst": 259.32, "total_cgst": 129.66,
        "total_sgst": 129.66, "amount_paid": 1700.0, "amount_due": 0.0, "items": [], "created_by": "u1",
    })
    # The automatic receipt was stamped with the login's main company, not the invoice's.
    await env.raw.payments.insert_one({
        "id": "pay1", "invoice_id": "inv1", "company_id": "MDA", "amount": 1700.0,
        "payment_date": "2026-06-11", "payment_mode": "bank", "auto_generated": True,
    })
    await _in(env, "PDV", lambda: env.inv.sync_invoice_journal_entry("inv1"))
    await _in(env, "MDA", lambda: env.inv.sync_payment_journal_entry("pay1"))
    assert await env.raw.journal_entries.count_documents({"source": "payment", "company_id": "MDA"}) == 1
    assert await env.raw.journal_entries.count_documents({"source": "sale"}) == 1


def test_deleting_the_invoice_also_removes_a_receipt_saved_under_another_company(env):
    async def go():
        await _setup(env)
        await _in(env, "MDA", lambda: env.inv.delete_invoice("inv1", ME))
        assert await env.raw.invoices.count_documents({}) == 0
        assert await env.raw.payments.count_documents({}) == 0
        assert await env.raw.journal_entries.count_documents({}) == 0
    run(go())


def test_leftover_entries_can_be_deleted_but_live_ones_stay_locked(env):
    async def go():
        await _setup(env)
        pay_entry = await env.raw.journal_entries.find_one({"source": "payment"}, {"_id": 0})
        sale_entry = await env.raw.journal_entries.find_one({"source": "sale"}, {"_id": 0})

        # Invoice still exists: both entries are locked.
        with pytest.raises(HTTPException) as e:
            await _in(env, "MDA", lambda: env.ac.delete_journal_entry(pay_entry["id"], ME))
        assert e.value.status_code == 400

        # The old delete left these behind: invoice gone, receipt + entries remain.
        await env.raw.invoices.delete_one({"id": "inv1"})
        await _in(env, "MDA", lambda: env.ac.delete_journal_entry(pay_entry["id"], ME))
        res = await _in(env, "PDV", lambda: env.ac.bulk_delete_journal_entries({"entry_ids": [sale_entry["id"]]}, ME))
        assert res["deleted_count"] == 1, res
        assert await env.raw.journal_entries.count_documents({}) == 0
        assert await env.raw.journal_lines.count_documents({}) == 0
        assert await env.raw.payments.count_documents({}) == 0          # orphan receipt removed too
        # every deletion is in the audit trail
        assert await env.raw.accounting_audit.count_documents({"event_type": "JOURNAL_ENTRY_DELETED"}) == 2
    run(go())


def test_manual_receipt_entry_with_its_payment_still_present_stays_locked(env):
    async def go():
        await _setup(env)
        await env.raw.payments.update_one({"id": "pay1"}, {"$set": {"auto_generated": False}})
        await env.raw.invoices.delete_one({"id": "inv1"})
        pay_entry = await env.raw.journal_entries.find_one({"source": "payment"}, {"_id": 0})
        with pytest.raises(HTTPException):
            await _in(env, "MDA", lambda: env.ac.delete_journal_entry(pay_entry["id"], ME))
        assert await env.raw.payments.count_documents({}) == 1
    run(go())


def test_entry_under_another_of_my_companies_is_found_and_deleted_but_not_another_customers(env):
    async def go():
        await _setup(env)
        await env.raw.invoices.delete_one({"id": "inv1"})
        sale_entry = await env.raw.journal_entries.find_one({"source": "sale"}, {"_id": 0})
        assert sale_entry["company_id"] == "PDV"
        # Logged in to MDA, deleting an entry that lives under PDV (one of my companies).
        await _in(env, "MDA", lambda: env.ac.delete_journal_entry(sale_entry["id"], ME))
        assert await env.raw.journal_entries.count_documents({"source": "sale"}) == 0

        # Another customer's entry is never reachable.
        await env.raw.journal_entries.insert_one({"id": "foreign", "company_id": "OTHER", "source": "manual",
                                                   "entry_date": "2026-06-01"})
        with pytest.raises(HTTPException) as e:
            await _in(env, "MDA", lambda: env.ac.delete_journal_entry("foreign", ME))
        assert e.value.status_code == 404
        res = await _in(env, "MDA", lambda: env.ac.bulk_delete_journal_entries({"entry_ids": ["foreign"]}, ME))
        assert res["deleted_count"] == 0
        assert await env.raw.journal_entries.count_documents({"id": "foreign"}) == 1
    run(go())
