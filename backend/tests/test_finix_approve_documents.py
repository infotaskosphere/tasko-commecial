"""Approving a Finix chat proposal creates the right DOCUMENT, never a bare journal for sales/receipts/bills."""
import asyncio
import sys
import types
import warnings

import pytest
from fastapi import HTTPException

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
ADMIN = types.SimpleNamespace(id="u1", role="admin", company_id="C1", permissions={}, email="a@b", username="a",
                              commercial_customer_id=None, license_id=None)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.accounting_core as ac
    import backend.invoicing as inv
    import backend.accounting_ai.finix_ai_router as fr
    import uuid as _uuid
    new = AsyncMongoMockClient()[f"finix_approve_{_uuid.uuid4().hex[:8]}"]
    old = dep.db
    for name, mod in list(sys.modules.items()):
        cur = getattr(mod, "db", None) if name.startswith("backend") else None
        # also modules first imported during an earlier test (they kept that test's database)
        if cur is old or isinstance(cur, type(new)):
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    ac._acct_id_cache.clear()
    ac._ensured_coa_companies.clear()
    from backend.accounting_ai import chart_of_accounts as _coa
    _coa._coa_cache.clear()
    run(ac.ensure_default_chart_of_accounts("C1", "u1"))
    return types.SimpleNamespace(db=new, fr=fr, inv=inv)


def _proposal(event, **kw):
    base = {"id": f"p-{event}", "company_id": "C1", "accounting_date": "2026-11-20", "narration": f"{event} test",
            "event": event, "amount": 11800.0, "party_name": "SHIVAM SALES AGENCY", "status": "PROPOSED",
            "interpretation": {"taxable_amount": 10000.0, "gst_amount": 1800.0}, "lines": [], "created_by": "u1"}
    base.update(kw)
    return base


def test_rejected_or_review_proposals_cannot_be_posted(env):
    async def go():
        for st in ("REJECTED", "REVIEW_REQUIRED"):
            with pytest.raises(HTTPException) as e:
                await env.fr.approve_proposal(_proposal("PAYMENT", status=st), ADMIN)
            assert e.value.status_code == 409
        assert await env.db.journal_entries.count_documents({}) == 0
    run(go())


def test_purchase_goes_to_the_purchase_register_not_a_journal(env):
    async def go():
        with pytest.raises(HTTPException) as e:
            await env.fr.approve_proposal(_proposal("PURCHASE"), ADMIN)
        assert e.value.detail["code"] == "use_purchase"
        assert await env.db.journal_entries.count_documents({}) == 0
    run(go())


def test_sale_becomes_a_draft_sales_invoice(env):
    async def go():
        p = _proposal("SALE")
        await env.db.finix_ai_proposals.insert_one(dict(p))
        res = await env.fr.approve_proposal(p, ADMIN)
        assert res["document"]["type"] == "sales_invoice" and res["journal_entry"] is None
        doc = await env.db.invoices.find_one({"id": res["document"]["id"]})
        assert doc["status"] == "draft" and doc["client_name"] == "SHIVAM SALES AGENCY"
        assert round(doc["grand_total"], 2) == 11800.0
        assert (await env.db.finix_ai_proposals.find_one({"id": p["id"]}))["status"] == "POSTED"
    run(go())


def test_receipt_is_recorded_against_the_clients_open_invoice(env):
    async def go():
        await env.db.invoices.insert_one({
            "id": "i1", "company_id": "C1", "invoice_no": "INV/1", "invoice_type": "tax_invoice", "status": "sent",
            "client_name": "Nayak Impex", "invoice_date": "2026-11-01", "grand_total": 10650.0, "amount_due": 10650.0,
            "amount_paid": 0.0, "total_taxable": 10650.0, "total_gst": 0.0, "items": []})
        await env.inv.sync_invoice_journal_entry("i1")
        p = _proposal("RECEIPT", amount=10650.0, party_name="Nayak Impex")
        res = await env.fr.approve_proposal(p, ADMIN)
        assert res["document"]["type"] == "receipt" and res["document"]["invoice_no"] == "INV/1"
        assert await env.db.payments.count_documents({"invoice_id": "i1"}) == 1
        # A customer with no matching open invoice: nothing is posted, the user is asked to pick.
        with pytest.raises(HTTPException) as e:
            await env.fr.approve_proposal(_proposal("RECEIPT", id="p2", amount=999.0, party_name="Nobody"), ADMIN)
        assert e.value.detail["code"] == "pick_invoice"
    run(go())
