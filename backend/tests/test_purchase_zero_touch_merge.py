"""Zero Touch is merged into Purchase: foreign-currency bills are booked in rupees, one duplicate check covers both
the register and bills booked through the old Zero Touch page, and pending Zero Touch documents are cleared from Purchase."""
import datetime as dt
import logging

import pytest

mongomock_motor = pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

FUTURE = (dt.datetime.utcnow() + dt.timedelta(days=200)).isoformat()
CO = "pu"


@pytest.fixture(scope="module")
def env():
    import sys

    import backend.server as server
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    logging.disable(logging.CRITICAL)
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["purchase_merge"]
    wrapped = TenantAwareDatabase(raw, mongo_client=client)
    original, original_raw = dep.db, dep._raw_db
    swapped = []
    for name, mod in list(sys.modules.items()):
        if (name == "backend" or name.startswith("backend.")) and mod is not None and getattr(mod, "db", None) is original:
            swapped.append(mod)
            mod.db = wrapped
    dep._raw_db, dep.db = raw, wrapped
    yield server.app, raw, dep
    for name, mod in list(sys.modules.items()):
        if (name == "backend" or name.startswith("backend.")) and mod is not None and getattr(mod, "db", None) is wrapped:
            mod.db = original
    for mod in swapped:
        mod.db = original
    dep.db, dep._raw_db = original, original_raw
    logging.disable(logging.NOTSET)


def _run(coro):
    import asyncio
    return asyncio.new_event_loop().run_until_complete(coro)


async def _seed(raw):
    lic = {"id": f"lic-{CO}", "customer_id": CO, "status": "active", "modules": ["finix"], "licensed_modules": ["finix"],
           "expires_at": FUTURE, "issued_at": dt.datetime.utcnow().isoformat(), "max_users": 50}
    await raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True)
    await raw.companies.replace_one({"id": CO}, {"id": CO, "name": "Pune Traders", "gstin": "27AAACT2882H1Z7", "created_by": f"{CO}-admin",
                                                  "commercial_customer_id": CO, "license_id": lic["id"]}, upsert=True)
    await raw.users.replace_one({"id": f"{CO}-admin"}, {
        "id": f"{CO}-admin", "email": f"admin@{CO}.test", "full_name": "Admin", "role": "admin", "identity_type": "licensee_admin",
        "permissions": {}, "company_id": CO, "license_id": lic["id"], "commercial_customer_id": CO, "is_active": True,
        "hashed_password": "x", "created_at": dt.datetime.utcnow().isoformat()}, upsert=True)


@pytest.fixture(scope="module")
def client(env):
    _run(_seed(env[1]))
    return TestClient(env[0], raise_server_exceptions=False)


def _h(env):
    return {"Authorization": "Bearer " + env[2].create_access_token({"sub": f"{CO}-admin"})}


def _bill(**kw):
    b = {"company_id": CO, "supplier_name": "Acme Supplies", "supplier_gstin": "", "invoice_no": "A-1", "invoice_date": "2026-09-10",
         "taxable_amount": 1000.0, "igst_amount": 180.0, "total_gst": 180.0, "grand_total": 1180.0, "currency": "INR"}
    b.update(kw)
    return b


def test_foreign_currency_bill_is_booked_in_rupees(client, env, monkeypatch):
    from backend import zero_touch_entry as zte

    async def rate(frm, to, on):
        assert (frm, to, on) == ("USD", "INR", "2026-09-10")
        return 83.0

    monkeypatch.setattr(zte, "get_historical_fx_rate", rate)
    r = client.post("/api/purchase-invoices/confirm", json=_bill(supplier_name="Cloud Inc", invoice_no="US-1", currency="USD",
                                                                 taxable_amount=100.0, igst_amount=0.0, total_gst=0.0, grand_total=100.0),
                    headers=_h(env))
    assert r.status_code == 200, r.text
    inv = r.json()["purchase_invoice"]
    assert inv["currency"] == "INR" and inv["grand_total"] == 8300.0 and inv["amount_due"] == 8300.0
    assert inv["original_currency"] == "USD" and inv["original_grand_total"] == 100.0 and inv["fx_rate"] == 83.0
    entry = _run(env[1].journal_entries.find_one({"source": "purchase", "source_id": inv["id"]}))
    assert entry and "USD 100.0 @ 83.0000" in entry["narration"]
    lines = _run(env[1].journal_lines.find({"entry_id": entry["id"]}).to_list(10))
    assert round(sum(l["debit"] for l in lines), 2) == round(sum(l["credit"] for l in lines), 2) == 8300.0


def test_rate_outage_stops_the_save_instead_of_booking_dollars_as_rupees(client, env, monkeypatch):
    from fastapi import HTTPException
    from backend import zero_touch_entry as zte

    async def down(*a):
        raise HTTPException(502, "rate service down")

    monkeypatch.setattr(zte, "get_historical_fx_rate", down)
    r = client.post("/api/purchase-invoices/confirm", json=_bill(invoice_no="US-2", currency="EUR"), headers=_h(env))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "fx_unavailable"
    assert _run(env[1].purchase_invoices.count_documents({"invoice_no": "US-2"})) == 0


def test_a_bill_booked_through_zero_touch_cannot_be_entered_again(client, env):
    _run(env[1].zte_processed_documents.insert_one({
        "id": "z-done", "company_id": CO, "status": "posted", "created_at": "2026-09-01T00:00:00+00:00", "filename": "old.pdf",
        "extracted": {"vendor_or_customer_name": "Old Vendor", "tax_registration_number": "", "invoice_number": "OV/77",
                      "invoice_date": "2026-08-30", "total_invoice_value": 590.0, "document_type": "PURCHASE"}}))
    r = client.post("/api/purchase-invoices/confirm", json=_bill(supplier_name="Old Vendor", invoice_no="ov-77"), headers=_h(env))
    assert r.status_code == 409 and r.json()["detail"]["code"] == "duplicate"
    assert r.json()["detail"]["existing"]["booked_via"] == "zero_touch"


def test_zero_touch_posting_checks_the_purchase_register_too(client, env, monkeypatch):
    from backend.accounting_ai import financial_validator as fv
    from backend.accounting_ai.financial_validator import FinancialValidator
    monkeypatch.setattr(fv, "db", env[2].db)      # other test modules may have left this module bound to their own database
    assert client.post("/api/purchase-invoices/confirm", json=_bill(supplier_name="Beta Co", invoice_no="B/1"), headers=_h(env)).status_code == 200
    ok, msg = _run(FinancialValidator.detect_duplicate_invoice(CO, "Beta Co", "b-1", 1180.0, {"document_type": "PURCHASE"}))
    assert ok is False and "Purchase Register" in msg
    ok, _ = _run(FinancialValidator.detect_duplicate_invoice(CO, "Beta Co", "b-2", 1180.0, {"document_type": "PURCHASE"}))
    assert ok is True


def test_a_cancelled_bill_does_not_block_entering_it_again(client, env):
    r = client.post("/api/purchase-invoices/confirm", json=_bill(supplier_name="Gamma", invoice_no="G-1"), headers=_h(env))
    assert r.status_code == 200
    assert client.post("/api/purchase-invoices/confirm", json=_bill(supplier_name="Gamma", invoice_no="G-1"), headers=_h(env)).status_code == 409
    _run(env[1].purchase_invoices.update_one({"id": r.json()["purchase_invoice"]["id"]}, {"$set": {"status": "cancelled"}}))
    assert client.post("/api/purchase-invoices/confirm", json=_bill(supplier_name="Gamma", invoice_no="G-1"), headers=_h(env)).status_code == 200


def _pending(doc_id, **ex):
    base = {"vendor_or_customer_name": "Pending Vendor", "tax_registration_number": "27AABCU9603R1ZV", "invoice_number": f"P-{doc_id}",
            "invoice_date": "2026-09-15", "taxable_value": 2000.0, "total_tax": 360.0, "total_invoice_value": 2360.0,
            "currency": "INR", "document_type": "PURCHASE"}
    base.update(ex)
    return {"id": doc_id, "company_id": CO, "status": "pending_approval", "created_at": "2026-09-16T00:00:00+00:00",
            "filename": f"{doc_id}.pdf", "posting_error": "Low confidence", "extracted": base}


def test_pending_zero_touch_documents_are_cleared_from_purchase(client, env):
    raw = env[1]
    _run(raw.zte_processed_documents.insert_one(_pending("z1")))
    _run(raw.zte_processed_documents.insert_one(_pending("z2")))
    _run(raw.zte_processed_documents.insert_one({**_pending("zs"), "extracted": {**_pending("zs")["extracted"], "document_type": "SALE"}}))
    items = client.get("/api/purchase-invoices/inbox", headers=_h(env)).json()["items"]
    assert {i["id"] for i in items} == {"z1", "z2"}                     # sales documents do not belong here

    d = client.get("/api/purchase-invoices/inbox/z1/draft", headers=_h(env))
    assert d.status_code == 200, d.text
    ex = d.json()["extracted"]
    assert ex["supplier_name"] == "Pending Vendor" and ex["invoice_no"] == "P-z1"
    assert ex["cgst_amount"] == ex["sgst_amount"] == 180.0 and ex["igst_amount"] == 0.0     # same state (27) as the company
    assert d.json()["zte_doc_id"] == "z1" and d.json()["suggested"]["company_id"] == CO

    body = {**_bill(supplier_name=ex["supplier_name"], supplier_gstin=ex["supplier_gstin"], invoice_no=ex["invoice_no"], invoice_date=ex["invoice_date"],
                    taxable_amount=2000.0, cgst_amount=180.0, sgst_amount=180.0, igst_amount=0.0, total_gst=360.0, grand_total=2360.0),
            "zte_doc_id": "z1"}
    r = client.post("/api/purchase-invoices/confirm", json=body, headers=_h(env))
    assert r.status_code == 200, r.text
    z = _run(raw.zte_processed_documents.find_one({"id": "z1"}))
    assert z["status"] == "posted" and z["purchase_invoice_id"] == r.json()["purchase_invoice"]["id"]
    # booked once: one purchase journal, and none from the old Zero Touch path
    assert _run(raw.journal_entries.count_documents({"source": "purchase", "source_id": z["purchase_invoice_id"]})) == 1
    assert _run(raw.journal_entries.count_documents({"source": "ai_zero_touch"})) == 0

    again = client.post("/api/purchase-invoices/confirm", json=body, headers=_h(env))
    assert again.status_code == 409 and again.json()["detail"]["code"] == "inbox_done"
    assert {i["id"] for i in client.get("/api/purchase-invoices/inbox", headers=_h(env)).json()["items"]} == {"z2"}


def test_a_pending_bill_can_be_dismissed_with_a_reason(client, env):
    h = _h(env)
    assert client.post("/api/purchase-invoices/inbox/z2/dismiss", json={"reason": "x"}, headers=h).status_code == 422
    assert client.post("/api/purchase-invoices/inbox/z2/dismiss", json={"reason": "Not our bill"}, headers=h).status_code == 200
    z = _run(env[1].zte_processed_documents.find_one({"id": "z2"}))
    assert z["status"] == "rejected" and z["rejection_reason"] == "Not our bill"
    assert client.get("/api/purchase-invoices/inbox", headers=h).json()["items"] == []
    assert client.post("/api/purchase-invoices/inbox/z2/dismiss", json={"reason": "again"}, headers=h).status_code == 409
