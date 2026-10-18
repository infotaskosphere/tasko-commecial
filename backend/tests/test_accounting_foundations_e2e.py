"""End to end on the real app: chart seeding and backfill, capital purchases, depreciation posting, statements, tax booking."""
import datetime as dt
import logging

import pytest

mongomock_motor = pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

FUTURE = (dt.datetime.utcnow() + dt.timedelta(days=200)).isoformat()
CO = "af"


@pytest.fixture(scope="module")
def env():
    import sys

    import backend.server as server
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    logging.disable(logging.CRITICAL)
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["acct_foundations"]
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


@pytest.fixture(scope="module")
def client(env):
    raw = env[1]
    lic = {"id": f"lic-{CO}", "customer_id": CO, "status": "active", "modules": ["finix"], "licensed_modules": ["finix"],
           "expires_at": FUTURE, "issued_at": dt.datetime.utcnow().isoformat(), "max_users": 50}
    _run(raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True))
    _run(raw.companies.replace_one({"id": CO}, {"id": CO, "name": "Acct Foundations", "gstin": "27AAACT2882H1Z7", "created_by": f"{CO}-admin",
                                                 "commercial_customer_id": CO, "license_id": lic["id"]}, upsert=True))
    _run(raw.users.replace_one({"id": f"{CO}-admin"}, {
        "id": f"{CO}-admin", "email": f"admin@{CO}.test", "full_name": "Admin", "role": "admin", "identity_type": "licensee_admin",
        "permissions": {}, "company_id": CO, "license_id": lic["id"], "commercial_customer_id": CO, "is_active": True,
        "hashed_password": "x", "created_at": dt.datetime.utcnow().isoformat()}, upsert=True))
    return TestClient(env[0], raise_server_exceptions=False)


def _h(env):
    return {"Authorization": "Bearer " + env[2].create_access_token({"sub": f"{CO}-admin"})}


def _bill(**kw):
    b = {"company_id": CO, "supplier_name": "Dell India", "supplier_gstin": "", "invoice_no": "D-1", "invoice_date": "2026-04-10",
         "taxable_amount": 100000.0, "igst_amount": 18000.0, "total_gst": 18000.0, "grand_total": 118000.0, "currency": "INR"}
    b.update(kw)
    return b


def _accounts(client, env):
    r = client.get(f"/api/chart-of-accounts?company_id={CO}", headers=_h(env))
    assert r.status_code == 200, r.text
    return {a["code"]: a for a in r.json()}


def _lines_for(env, entry_id):
    return _run(env[1].journal_lines.find({"entry_id": entry_id}).to_list(20))


def test_chart_is_seeded_with_the_full_set_and_every_account_is_classified(client, env):
    # an account that predates classification
    _run(env[1].chart_of_accounts.insert_one({"id": "old-1", "company_id": CO, "code": "1320", "name": "Office Furniture", "type": "asset",
                                              "sub_type": "", "is_system": False, "is_active": True}))
    acc = _accounts(client, env)
    for code in ("1310", "1350", "1400", "1500", "1600", "2300", "2400", "2500", "2600", "2700", "5010", "5450", "5800", "5950", "5960"):
        assert code in acc, code
    assert all(a.get("statement") and a.get("schedule3_head") for a in acc.values())
    assert acc["1310"]["is_contra"] is True and acc["1300"]["nature"] == "capital" and acc["5800"]["schedule3_head"].startswith("Depreciation")
    assert acc["1320"]["nature"] == "capital" and acc["1320"]["schedule3_head"] == "Property, plant and equipment"      # backfilled
    created = client.post("/api/chart-of-accounts", json={"company_id": CO, "code": "5455", "name": "Interest on Term Loan", "type": "expense"}, headers=_h(env))
    assert created.status_code == 200 and created.json()["schedule3_head"] == "Finance costs" and created.json()["statement"] == "profit_and_loss"


def test_a_capital_purchase_goes_to_fixed_assets_and_the_register(client, env):
    r = client.post("/api/purchase-invoices/confirm", json={**_bill(), "treat_as": "capital", "asset_category": "computers"}, headers=_h(env))
    assert r.status_code == 200, r.text
    inv = r.json()["purchase_invoice"]
    assert inv["treatment"] == "capital" and inv["expense_ledger_code"] == "1300" and inv["asset_category"] == "computers" and inv["useful_life_years"] == 3
    entry = _run(env[1].journal_entries.find_one({"source": "purchase", "source_id": inv["id"]}))
    acc = _accounts(client, env)
    by_acct = {l["account_id"]: l for l in _lines_for(env, entry["id"])}
    assert by_acct[acc["1300"]["id"]]["debit"] == 100000.0                    # not charged to profit
    assert by_acct[acc["1200"]["id"]]["debit"] == 18000.0 and by_acct[acc["2000"]["id"]]["credit"] == 118000.0
    asset = _run(env[1].fixed_assets.find_one({"source_purchase_id": inv["id"]}))
    assert asset["cost"] == 100000.0 and asset["salvage_value"] == 5000.0 and asset["category"] == "computers" and asset["status"] == "active"
    assert asset["useful_life_years"] == 3 and asset["purchase_date"] == "2026-04-10"

    exp = client.post("/api/purchase-invoices/confirm", json={**_bill(invoice_no="D-2", taxable_amount=1000.0, igst_amount=180.0, total_gst=180.0, grand_total=1180.0)}, headers=_h(env))
    assert exp.status_code == 200 and exp.json()["purchase_invoice"]["treatment"] == "expense"
    assert _run(env[1].fixed_assets.count_documents({"source_purchase_id": exp.json()["purchase_invoice"]["id"]})) == 0


def test_depreciation_goes_to_depreciation_expense_and_accumulated_depreciation(client, env):
    h = _h(env)
    r = client.post("/api/depreciation/run", data={"company_id": CO, "period_end": "2026-06-30", "fy": "2026-27"}, headers=h)
    assert r.status_code == 200 and r.json()["posted"] == 1, r.text
    acc = _accounts(client, env)
    lines = {l["account_id"]: l for l in _lines_for(env, r.json()["entries"][0]["entry_id"])}
    monthly = round((100000 - 5000) / 36, 2)
    assert lines[acc["5800"]["id"]]["debit"] == monthly and lines[acc["1310"]["id"]]["credit"] == monthly
    assert acc["5500"]["id"] not in lines and acc["1300"]["id"] not in lines          # not freight, not the asset itself
    assert client.post("/api/depreciation/run", data={"company_id": CO, "period_end": "2026-06-30", "fy": "2026-27"}, headers=h).json()["posted"] == 0


def test_legacy_depreciation_booked_to_freight_is_repaired_once(client, env):
    raw, acc = env[1], _accounts(client, env)
    _run(raw.journal_entries.insert_one({"id": "legacy-e", "company_id": CO, "entry_date": "2026-05-31", "source": "depreciation", "narration": "old"}))
    for aid, dr, cr in ((acc["5500"]["id"], 500.0, 0), (acc["1300"]["id"], 0, 500.0)):
        _run(raw.journal_lines.insert_one({"id": f"legacy-{aid}", "entry_id": "legacy-e", "company_id": CO, "account_id": aid, "debit": dr, "credit": cr, "entry_date": "2026-05-31"}))
    first = client.post("/api/depreciation/repair-accounts", data={"company_id": CO}, headers=_h(env))
    assert first.status_code == 200 and first.json()["lines_repaired"] == 2, first.text
    assert {l["account_id"] for l in _lines_for(env, "legacy-e")} == {acc["5800"]["id"], acc["1310"]["id"]}
    assert client.post("/api/depreciation/repair-accounts", data={"company_id": CO}, headers=_h(env)).json()["lines_repaired"] == 0
    # put the books back as the rest of the file expects
    _run(raw.journal_lines.delete_many({"entry_id": "legacy-e"}))
    _run(raw.journal_entries.delete_one({"id": "legacy-e"}))


def test_compliance_report_is_built_from_the_books_and_tax_can_be_booked(client, env):
    from backend import accounting_core as ac
    h, raw = _h(env), env[1]

    async def post(day, *legs):
        ids = {c: await ac.get_default_account_id(CO, c) for c, _, _ in legs}
        await ac.post_journal_entry(CO, day, "test", [{"account_id": ids[c], "debit": d, "credit": cr} for c, d, cr in legs], source="manual", source_id=None, created_by="t")
    _run(post("2026-04-02", ("1010", 600000.0, 0), ("3000", 0, 600000.0)))
    _run(post("2026-04-20", ("1010", 400000.0, 0), ("4000", 0, 400000.0)))

    r = client.get(f"/api/reports/mis-compliance?company_id={CO}&date_from=2026-04-01&date_to=2027-03-31", headers=h)
    assert r.status_code == 200, r.text
    st = r.json()
    bs, pnl = st["schedule_iii"]["balance_sheet"], st["schedule_iii"]["pnl"]
    assert bs["balanced"], bs["difference"]
    monthly = round((100000 - 5000) / 36, 2)
    assert pnl["expenses"]["depreciation"] == monthly                       # the depreciation actually posted, not 10% of fixed assets
    ppe = bs["assets"]["non_current_assets"]
    assert ppe["gross_block"] == 100000.0 and ppe["accumulated_depreciation"] == monthly and ppe["property_plant_equipment"] == round(100000 - monthly, 2)
    assert pnl["revenue_from_operations"] == 400000.0 and pnl["expenses"]["cost_of_purchases"] == 1000.0     # generic revenue bill -> Purchases (trading item); the capital bill is excluded
    assert st["income_tax"]["depreciation_it_deduction"] == 40000.0 and st["income_tax"]["tax_rate_is_assumption"] is True
    assert st["mis"]["cash_flow"]["reconciles"] and st["trading_account"]["ties_to_pnl"]
    assert "simulated_tax_provision" not in pnl and "debtors_aging" in st["mis"]

    # book deferred tax: book WDV (cost - depreciation posted) is above tax WDV, so a liability is required
    dt0 = st["deferred_tax"]
    assert dt0["kind"] == "liability" and dt0["adjustment_to_book"] > 0
    posted = client.post("/api/reports/mis-compliance/deferred-tax/post", json={"company_id": CO, "date_to": "2027-03-31"}, headers=h)
    assert posted.status_code == 200 and posted.json()["posted"] is True, posted.text
    again = client.post("/api/reports/mis-compliance/deferred-tax/post", json={"company_id": CO, "date_to": "2027-03-31"}, headers=h)
    assert again.json()["posted"] is False                                   # nothing left to book

    prov = client.post("/api/reports/mis-compliance/tax-provision/post", json={"company_id": CO, "date_to": "2027-03-31"}, headers=h)
    assert prov.status_code == 200 and prov.json()["posted"] is True and prov.json()["amount"] > 0, prov.text
    assert client.post("/api/reports/mis-compliance/tax-provision/post", json={"company_id": CO, "date_to": "2027-03-31"}, headers=h).json()["posted"] is False

    st2 = client.get(f"/api/reports/mis-compliance?company_id={CO}&date_from=2026-04-01&date_to=2027-03-31", headers=h).json()
    assert st2["deferred_tax"]["adjustment_to_book"] == 0.0 and st2["income_tax"]["tax_to_book"] == 0.0
    assert st2["schedule_iii"]["pnl"]["tax_expense"] > 0 and st2["schedule_iii"]["balance_sheet"]["balanced"]
    assert st2["schedule_iii"]["balance_sheet"]["equity_and_liabilities"]["non_current_liabilities"]["deferred_tax_liabilities"] > 0


def test_cancelling_a_capital_bill_retires_the_asset(client, env):
    inv = _run(env[1].purchase_invoices.find_one({"invoice_no": "D-1"}))
    r = client.patch(f"/api/purchase-invoices/{inv['id']}/status", json={"status": "cancelled"}, headers=_h(env))
    assert r.status_code == 200, r.text
    assert _run(env[1].fixed_assets.find_one({"source_purchase_id": inv["id"]}))["status"] == "cancelled"
