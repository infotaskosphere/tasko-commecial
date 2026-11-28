"""GSTR-3B from the books: output tax, input credit, reverse charge, statutory set-off order."""
import asyncio
import sys
import types
import warnings

import pytest
from fastapi import HTTPException

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
USER = types.SimpleNamespace(id="u1", role="admin", company_id="C1", permissions={}, email="a@b", username="a")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def inv(monkeypatch):
    import backend.dependencies as dep
    import backend.invoicing as m
    new = AsyncMongoMockClient()["gstr3b_test"]
    old = dep.db
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    return types.SimpleNamespace(m=m, db=new)


def test_set_off_order_follows_section_49():
    from backend.invoicing import gst_set_off
    # Output: IGST 100, CGST 50, SGST 50. Credit: IGST 120, CGST 10, SGST 80.
    r = gst_set_off({"igst": 100, "cgst": 50, "sgst": 50, "cess": 0}, {"igst": 120, "cgst": 10, "sgst": 80, "cess": 0})
    u = r["credit_used"]
    assert u["igst->igst"] == 100 and u["igst->cgst"] == 20          # IGST credit: IGST first, then CGST
    assert u["cgst->cgst"] == 10 and u["sgst->sgst"] == 50          # CGST / SGST credit on their own heads
    assert r["cash_payable"] == {"igst": 0, "cgst": 20, "sgst": 0, "cess": 0}
    assert r["credit_carried_forward"]["sgst"] == 30                 # SGST credit never used for CGST
    assert r["credit_carried_forward"]["cgst"] == 0


def test_gstr3b_for_one_company_month(inv):
    async def go():
        await inv.db.invoices.insert_many([
            {"id": "s1", "company_id": "C1", "invoice_type": "tax_invoice", "status": "sent", "invoice_date": "2026-11-05",
             "total_taxable": 10000, "total_cgst": 900, "total_sgst": 900, "total_igst": 0, "total_gst": 1800},
            {"id": "s2", "company_id": "C1", "invoice_type": "tax_invoice", "status": "draft", "invoice_date": "2026-11-09",
             "total_taxable": 8150, "total_gst": 0},
            {"id": "cn", "company_id": "C1", "invoice_type": "credit_note", "status": "sent", "invoice_date": "2026-11-10",
             "total_taxable": 1000, "total_cgst": 90, "total_sgst": 90, "total_gst": 180},
            {"id": "x", "company_id": "C1", "invoice_type": "tax_invoice", "status": "cancelled", "invoice_date": "2026-11-11",
             "total_taxable": 99999, "total_cgst": 9999, "total_sgst": 9999, "total_gst": 19998},
            {"id": "other", "company_id": "C2", "invoice_type": "tax_invoice", "status": "sent", "invoice_date": "2026-11-11",
             "total_taxable": 5000, "total_igst": 900, "total_gst": 900},
        ])
        await inv.db.purchase_invoices.insert_many([
            {"id": "p1", "company_id": "C1", "invoice_date": "2026-11-03", "status": "outstanding",
             "taxable_amount": 2000, "cgst_amount": 180, "sgst_amount": 180},
            {"id": "p2", "company_id": "C1", "invoice_date": "2026-11-04", "status": "outstanding", "reverse_charge": True,
             "taxable_amount": 5000, "cgst_amount": 450, "sgst_amount": 450},
            {"id": "p3", "company_id": "C1", "invoice_date": "2026-11-04", "status": "outstanding", "gstr2b_itc_eligible": False,
             "taxable_amount": 1000, "igst_amount": 180},
        ])
        r = await inv.m.gstr3b_summary(company_id="C1", month="2026-11", current_user=USER)
        a = r["t31"]["a_outward_taxable"]
        assert (a["taxable"], a["cgst"], a["sgst"]) == (9000, 810, 810)        # invoice − credit note
        assert r["t31"]["c_nil_exempt"]["taxable"] == 8150
        assert r["t31"]["d_inward_reverse_charge"]["cgst"] == 450
        assert r["t4"]["a5_all_other"]["cgst"] == 180 and r["t4"]["a3_reverse_charge"]["cgst"] == 450
        assert r["t4"]["d_ineligible"]["igst"] == 180
        # Credit 630 per head covers 810 output down to 180; RCM 450 per head is paid in cash on top.
        assert r["cash_payable"] == {"igst": 0, "cgst": 630, "sgst": 630, "cess": 0}
        with pytest.raises(HTTPException):
            await inv.m.gstr3b_summary(company_id="all", month="2026-11", current_user=USER)
    run(go())


def test_reverse_charge_bill_posts_tax_payable_and_input_credit(inv):
    async def go():
        import backend.accounting_core as ac
        ac._acct_id_cache.clear()
        ac._ensured_coa_companies.clear()
        await ac.ensure_default_chart_of_accounts("C1", "u1")
        await inv.db.purchase_invoices.insert_one({
            "id": "rcm1", "company_id": "C1", "invoice_no": "LEGAL/7", "supplier_name": "Advocate X",
            "invoice_date": "2026-11-04", "status": "outstanding", "reverse_charge": True,
            "taxable_amount": 5000, "cgst_amount": 450, "sgst_amount": 450, "total_gst": 900, "grand_total": 5000})
        assert await inv.m.sync_purchase_journal_entry("rcm1") == "posted"
        entry = await inv.db.journal_entries.find_one({"source": "purchase", "source_id": "rcm1"})
        lines = await inv.db.journal_lines.find({"entry_id": entry["id"]}).to_list(10)
        codes = {a["id"]: a["code"] for a in await inv.db.chart_of_accounts.find({"company_id": "C1"}).to_list(500)}
        by = {}
        for l in lines:
            c = codes[l["account_id"]]
            by[c] = (by.get(c, (0, 0))[0] + l["debit"], by.get(c, (0, 0))[1] + l["credit"])
        assert by["2000"] == (0, 5000)            # supplier is owed the bill value only
        assert by["1200"] == (900, 0)             # input credit on the reverse-charge tax
        assert by["2100"] == (0, 900)             # we owe that tax to the government
        assert sum(l["debit"] for l in lines) == sum(l["credit"] for l in lines) == 5900
    run(go())
