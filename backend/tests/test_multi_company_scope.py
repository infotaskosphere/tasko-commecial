"""A login with several legal companies works on all of them.

Records named by id (open / edit / pay an invoice, its payments and entries) are
found under any of the login's own companies; broad queries keep the login's
main company; other customers stay unreachable; updates and replacements never
move a record to another company.
"""
import asyncio
import sys
import types
import warnings

import pytest

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")

ME = types.SimpleNamespace(id="u1", role="admin", company_id="MDA", permissions={}, email="a@b.c",
                           username="admin", commercial_customer_id=None, license_id=None)


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.invoicing as inv
    from backend import tenant_runtime as tr

    client = AsyncMongoMockClient()
    raw = client["multi_company_scope"]
    tdb = tr.TenantAwareDatabase(raw, mongo_client=client)
    old = dep.db
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", tdb)
    monkeypatch.setattr(dep, "db", tdb)
    return types.SimpleNamespace(raw=raw, db=tdb, inv=inv, tr=tr)


def _as(env, owner: bool):
    env.tr.set_authenticated_company("MDA")
    if owner:
        env.tr.set_platform_owner(True)
        env.tr.set_platform_owner_company_ids({"MDA", "PDV"})
    else:
        env.tr.set_platform_owner(False)
        env.tr.set_tenant_company_ids({"MDA", "PDV"})


@pytest.mark.parametrize("owner", [True, False])
def test_records_by_id_are_found_under_any_own_company(env, owner):
    async def go():
        _as(env, owner)
        await env.raw.invoices.insert_many([
            {"id": "pdv-inv", "company_id": "PDV", "invoice_no": "INV/1", "status": "sent"},
            {"id": "mda-inv", "company_id": "MDA", "invoice_no": "INV/1", "status": "sent"},
            {"id": "foreign", "company_id": "OTHER", "invoice_no": "INV/9", "status": "sent"},
        ])
        await env.raw.payments.insert_one({"id": "p1", "invoice_id": "pdv-inv", "company_id": "PDV", "amount": 5})

        # Open a Prodigist invoice while logged in to Manthan Desai.
        assert (await env.inv.get_invoice("pdv-inv", ME))["company_id"] == "PDV"
        assert len(await env.db.payments.find({"invoice_id": "pdv-inv"}).to_list(10)) == 1
        # Another customer's record stays unreachable.
        assert await env.db.invoices.find_one({"id": "foreign"}) is None
        # Broad queries keep the login company (settings, counters, summaries are not mixed).
        assert [d["id"] for d in await env.db.invoices.find({"status": "sent"}).to_list(10)] == ["mda-inv"]

        # Editing keeps the record in its own company.
        await env.db.invoices.update_one({"id": "pdv-inv"}, {"$set": {"status": "paid"}})
        doc = await env.raw.invoices.find_one({"id": "pdv-inv"})
        assert (doc["status"], doc["company_id"]) == ("paid", "PDV")
        await env.db.invoices.replace_one({"id": "pdv-inv"}, {"id": "pdv-inv", "invoice_no": "INV/1", "status": "sent"})
        assert (await env.raw.invoices.find_one({"id": "pdv-inv"}))["company_id"] == "PDV"
        # An upsert through an id lookup creates the record in the login company.
        await env.db.invoices.update_one({"id": "new-one"}, {"$set": {"status": "draft"}}, upsert=True)
        assert (await env.raw.invoices.find_one({"id": "new-one"}))["company_id"] == "MDA"
    run(go())


@pytest.mark.parametrize("owner", [True, False])
def test_all_companies_lists_cover_every_own_company_only(env, owner):
    async def go():
        _as(env, owner)
        await env.raw.purchase_invoices.insert_many([
            {"id": "b1", "company_id": "PDV", "supplier_name": "A", "created_at": "1"},
            {"id": "b2", "company_id": "MDA", "supplier_name": "B", "created_at": "2"},
            {"id": "b3", "company_id": "OTHER", "supplier_name": "C", "created_at": "3"},
        ])
        q = env.inv._build_purchase_query(ME)
        ids = sorted(d["id"] for d in await env.db.purchase_invoices.find(q).to_list(10))
        assert ids == ["b1", "b2"]
        q1 = env.inv._build_purchase_query(ME, company_id="PDV")
        assert [d["id"] for d in await env.db.purchase_invoices.find(q1).to_list(10)] == ["b1"]
    run(go())


def test_single_company_login_is_unchanged(env):
    async def go():
        env.tr.set_authenticated_company("MDA")
        env.tr.set_platform_owner(False)
        env.tr.set_tenant_company_ids({"MDA"})
        await env.raw.invoices.insert_many([
            {"id": "x", "company_id": "MDA"}, {"id": "y", "company_id": "PDV"},
        ])
        assert await env.db.invoices.find_one({"id": "y"}) is None
        assert (await env.db.invoices.find_one({"id": "x"}))["id"] == "x"
        assert env.tr.own_companies_filter() is None
    run(go())
