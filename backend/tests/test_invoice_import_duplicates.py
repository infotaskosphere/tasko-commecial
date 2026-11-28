"""Excel invoice import: every invoice in the file comes in.

A number reused for a different client (two series sharing a prefix, or two
companies) is a different invoice and must not be dropped as a duplicate.
Re-uploading the same file still skips every row.
"""
import asyncio
import logging
import sys
import types
import warnings

import pytest

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

USER = types.SimpleNamespace(id="u1", role="admin", company_id=None, permissions={}, email="a@b.c", username="admin")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def inv(monkeypatch):
    import backend.dependencies as dep
    import backend.invoicing as invoicing

    old = dep.db
    new = AsyncMongoMockClient()["invoice_import_test"]
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    return types.SimpleNamespace(db=new, m=invoicing)


def _row(no, client, date, total, status="paid"):
    return {"invoice_no": no, "client_name": client, "invoice_date": date, "due_date": date,
            "grand_total": total, "total_taxable": total, "amount_paid": total if status == "paid" else 0,
            "amount_due": 0 if status == "paid" else total, "status": status, "items": []}


# Real pairs from the customer's file: same number, different client.
COMPANY_A = [  # charges GST
    _row("INV-0004/26-27", "SPECTEVO HEALTHCARE PRIVATE LIMITED", "2026-04-14", 10620),
    _row("INV/26-27/017", "DESAI TECH WEAVES LLP", "2026-06-11", 1700),
]
COMPANY_B = [
    _row("INV-0004/26-27", "DHAMELIYA & CO", "2026-04-01", 21450),
    _row("INV/26-27/078", "SOHINI NX", "2026-06-01", 17300),
    _row("INV/26-27/017", "DIVINE VISION PRIVATE LIMITED", "2026-06-03", 10000),
    # same number again, other series, same company if the user maps both series here
    _row("INV/26-27/078", "BAJRANG GREEN ENERGY PRIVATE LIMITED", "2026-10-26", 13100, "draft"),
]


async def _import(m, company_id, rows):
    data = m.ImportBackupRequest(company_id=company_id, source="excel", invoices=[dict(r) for r in rows])
    return await m.import_backup(data, USER)


def test_reused_numbers_for_other_clients_all_import_and_reupload_skips(inv):
    async def go():
        a = await _import(inv.m, "coA", COMPANY_A)
        b = await _import(inv.m, "coB", COMPANY_B)
        assert (a.invoices_imported, a.invoices_skipped) == (2, 0)
        assert (b.invoices_imported, b.invoices_skipped) == (4, 0)
        assert await inv.db.invoices.count_documents({}) == 6
        assert await inv.db.invoices.count_documents({"company_id": "coB", "invoice_no": "INV/26-27/078"}) == 2

        # Same files again: nothing new
        a2 = await _import(inv.m, "coA", COMPANY_A)
        b2 = await _import(inv.m, "coB", COMPANY_B)
        assert (a2.invoices_imported, a2.invoices_skipped) == (0, 2)
        assert (b2.invoices_imported, b2.invoices_skipped) == (0, 4)
        assert await inv.db.invoices.count_documents({}) == 6
    run(go())


def test_exact_same_row_twice_in_one_upload_is_kept_once(inv):
    async def go():
        r = _row("INV/26-27/141", "SHIVAM SALES AGENCY", "2026-11-24", 8150, "draft")
        res = await _import(inv.m, "coB", [r, dict(r)])
        assert (res.invoices_imported, res.invoices_skipped) == (1, 1)
    run(go())


def test_file_values_are_saved_as_given(inv):
    async def go():
        r = _row("INV/26-27/027", "STAR BOTTLING & CEMENT TRADERS", "2026-11-01", 37820, "partially_paid")
        r.update(total_taxable=32150, total_gst=5670, total_cgst=2835, total_sgst=2835,
                 amount_paid=0, amount_due=37820, invoice_type="tax_invoice", due_date="2026-12-01")
        await _import(inv.m, "coA", [r])
        doc = await inv.db.invoices.find_one({"invoice_no": "INV/26-27/027"})
        assert doc["invoice_date"] == "2026-11-01" and doc["due_date"] == "2026-12-01"
        assert (doc["total_taxable"], doc["total_gst"], doc["grand_total"]) == (32150, 5670, 37820)
        assert doc["status"] == "partially_paid" and doc["company_id"] == "coA"
    run(go())


# ── The invoice list shows every company of the login, not just its own ──────

@pytest.fixture
def scoped(monkeypatch):
    import backend.dependencies as dep
    import backend.invoicing as invoicing
    from backend import tenant_runtime as tr

    client = AsyncMongoMockClient()
    raw = client["invoice_scope_test"]
    tdb = tr.TenantAwareDatabase(raw, mongo_client=client)
    old = dep.db
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", tdb)
    monkeypatch.setattr(dep, "db", tdb)
    return types.SimpleNamespace(raw=raw, m=invoicing, tr=tr)


@pytest.mark.parametrize("owner", [True, False])
def test_list_shows_invoices_of_all_my_companies_and_no_one_elses(scoped, owner):
    tr, m = scoped.tr, scoped.m
    me = types.SimpleNamespace(id="u1", role="admin", company_id="MDA", permissions={}, email="a@b.c", username="a")

    async def go():
        await scoped.raw.invoices.insert_one({"id": "x", "company_id": "OTHER", "invoice_no": "Z", "created_at": "1"})
        t1 = tr.set_authenticated_company("MDA")
        t2 = tr.set_platform_owner(True) if owner else tr.set_tenant_company_ids({"MDA", "PDV", "MSA"})
        t3 = tr.set_platform_owner_company_ids({"MDA", "PDV", "MSA"}) if owner else None
        for cid in ("MDA", "PDV", "MSA"):
            await m.import_backup(m.ImportBackupRequest(company_id=cid, invoices=[_row("INV/26-27/017", cid, "2026-06-03", 100)]), me)
        res = await m.list_invoices(page=1, page_size=100, status=None, search=None, company_id=None, current_user=me)
        assert sorted(i["company_id"] for i in res["invoices"]) == ["MDA", "MSA", "PDV"]
        one = await m.list_invoices(page=1, page_size=100, status=None, search=None, company_id="PDV", current_user=me)
        assert [i["company_id"] for i in one["invoices"]] == ["PDV"]
    run(go())
