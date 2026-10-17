"""Behaviour tests for Finix invoice learning (per-company memory of confirmed decisions).

They run the real application code against an in-memory MongoDB (mongomock_motor);
nothing is mocked except the database and the master-company lookup.
"""
import asyncio
import logging
import sys
import types
import warnings
from datetime import datetime, timedelta, timezone

import pytest

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)

USER = types.SimpleNamespace(id="u1", role="admin", company_id=None, permissions={}, email="a@b.c", username="admin")
GSTIN = "27AAPFU0939F1ZV"
VENDOR = "Cloudy Tech Pvt Ltd"
_counter = {"n": 0}

BILL_TEXT = """TAX INVOICE
Invoice No: {no}
Invoice Date: {dd}
Taxable Value {tv}
CGST 9% {c}
SGST 9% {c}
Grand Total {gt}
"""


@pytest.fixture
def env(monkeypatch):
    import backend.dependencies as dep
    import backend.accounting_core as ac
    import backend.accounting_lock as lk
    import backend.invoicing as inv
    import backend.accounting_ai.invoice_learning as il
    import backend.accounting_ai.accounting_controls  # noqa: F401
    # modules the purchase flow imports lazily: load them now so their `db` is swapped like the rest
    import backend.accounting_ai.ledger_mapper  # noqa: F401
    import backend.accounting_ai.chart_of_accounts as coa
    import backend.accounting_ai.finix_agent_complete  # noqa: F401
    import backend.ai.vendor_learning  # noqa: F401

    old = dep.db
    new = AsyncMongoMockClient()["finix_learning_test"]
    for name, mod in list(sys.modules.items()):
        if name.startswith("backend") and getattr(mod, "db", None) is old:
            monkeypatch.setattr(mod, "db", new)
    monkeypatch.setattr(dep, "db", new)
    ac._acct_id_cache.clear()
    ac._ensured_coa_companies.clear()
    inv._reconcile_last_run.clear()
    coa._coa_cache.clear()
    _counter["n"] += 1
    cid, other = f"lc{_counter['n']}", f"lo{_counter['n']}"
    for c in (cid, other):
        asyncio.run(ac.ensure_default_chart_of_accounts(c, "u1"))

    async def fake_master(user, company_id):
        return {"id": company_id, "name": f"Company {company_id}"} if company_id in (cid, other) else None

    monkeypatch.setattr(inv, "_find_master_company", fake_master)
    return types.SimpleNamespace(db=new, ac=ac, lk=lk, inv=inv, il=il, cid=cid, other=other)


def run(coro):
    return asyncio.run(coro)


async def save_bill(env, n, *, company=None, supplier=VENDOR, gstin=GSTIN, ledger=None, edited=(), learn=True,
                    source="upload", taxable=1000.0, gst=180.0, text=None, invoice_no=None):
    no = invoice_no or f"INV/23-24/{n:04d}"
    payload = dict(
        company_id=company or env.cid, supplier_name=supplier, supplier_gstin=gstin, invoice_no=no,
        invoice_date="2026-10-10", taxable_amount=taxable, cgst_amount=gst / 2, sgst_amount=gst / 2, total_gst=gst,
        grand_total=taxable + gst, buyer_gstin="", edited_fields=list(edited),
        raw_text_excerpt=text if text is not None else BILL_TEXT.format(
            no=no, dd="10/10/2026", tv=f"{taxable:,.2f}", c=f"{gst / 2:,.2f}", gt=f"{taxable + gst:,.2f}"),
        expense_ledger_code=ledger,
    )
    doc, dup = await env.inv._save_purchase_invoice(
        payload, USER, source=source, file_meta={"name": "bill.pdf", "size": 10, "content_type": "application/pdf"},
        acknowledge_mismatch=True, learn=learn)
    assert doc is not None, dup
    return doc


# ── helpers ───────────────────────────────────────────────────────────────────
def test_vendor_key_prefers_gstin_and_normalises_names(env):
    il = env.il
    assert il.vendor_key(GSTIN, "x") == f"gstin:{GSTIN}"
    assert il.vendor_key("not-a-gstin", "M/s. Cloudy Tech Pvt. Ltd.") == il.vendor_key("", "cloudy tech private limited")
    assert il.vendor_key("", "") == ""


def test_gst_rate_snaps_to_slabs_and_ignores_odd_values(env):
    il = env.il
    assert il.snap_gst_rate(1000, 180) == 18.0
    assert il.snap_gst_rate(1000, 50) == 5.0
    assert il.snap_gst_rate(0, 0) is None
    assert il.snap_gst_rate(1000, 133) is None               # 13.3% is not a slab


def test_invoice_shape_collapses_digits_and_letters(env):
    assert env.il.invoice_shape("INV/23-24/0045") == env.il.invoice_shape("TAX/99-00/12") == "A/#-#/#"


# ── steps 1-2: learn from confirmations, per company ─────────────────────────
def test_learning_is_isolated_per_company(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        assert (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["code"] == "5250"
        assert (await env.il.suggest_ledger(env.other, GSTIN, VENDOR))["code"] == ""
        assert await env.il.get_memory(env.other, GSTIN, VENDOR) is None
    run(go())


def test_ledger_is_auto_filled_only_after_three_consistent_confirmations(env):
    async def go():
        await save_bill(env, 1, ledger="5250")                 # person picks Software & Cloud
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert s["code"] == "5250" and not s["auto_apply"] and s["requires_review"]
        b2 = await save_bill(env, 2)                           # accepts Finix's proposal
        assert b2["expense_ledger_code"] == "5250" and b2["classification_source"] == "learned"
        assert not b2["ledger_auto_applied"]
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert not s["auto_apply"]                             # only 2 confirmations so far
        await save_bill(env, 3)
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert s["auto_apply"] and s["confidence"] >= 0.75 and s["confirmations"] == 3
        b4 = await save_bill(env, 4)
        assert b4["ledger_auto_applied"] and b4["expense_ledger_code"] == "5250"
    run(go())


def test_one_correction_withdraws_auto_fill_and_sends_next_bill_to_review(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        assert (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["auto_apply"]
        b4 = await save_bill(env, 4, ledger="5200")            # person overrides the auto-filled ledger
        assert b4["expense_ledger_code"] == "5200"
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert not s["auto_apply"] and s["requires_review"]
        assert s["code"] == "5200"                             # the explicit decision is respected, but flagged
        b5 = await save_bill(env, 5, learn=False)              # unreviewed path: must be flagged for a person
        assert b5["ledger_requires_review"] and b5["needs_review"]
        # ...and trust is rebuilt only by three clean confirmations after the correction
        for i in (6, 7):
            await save_bill(env, i)
        assert not (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["auto_apply"]
        await save_bill(env, 8)
        assert (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["auto_apply"]
    run(go())


def test_unreviewed_paths_never_teach_finix(env):
    async def go():
        for i in range(1, 5):
            await save_bill(env, i, learn=False)               # legacy one-step upload / GSTR-2B import
        assert await env.db.finix_vendor_memory.count_documents({}) == 0
        assert await env.db.finix_learning_events.count_documents({}) == 0
    run(go())


def test_learned_ledger_missing_from_chart_is_ignored(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        await env.db.chart_of_accounts.delete_one({"company_id": env.cid, "code": "5250"})
        b = await save_bill(env, 4)
        assert b["classification_source"] == "rules" and b["expense_ledger_code"] != "5250"
    run(go())


def test_gstin_first_then_name_identity_and_promotion(env):
    async def go():
        await save_bill(env, 1, gstin="", ledger="5250")                # first seen without a GSTIN
        assert (await env.il.suggest_ledger(env.cid, "", VENDOR))["code"] == "5250"
        await save_bill(env, 2, gstin=GSTIN, ledger="5250")             # GSTIN appears: same vendor, promoted
        assert await env.db.finix_vendor_memory.count_documents({"company_id": env.cid}) == 1
        mem = await env.il.get_memory(env.cid, GSTIN, "")
        assert mem["vendor_key"] == f"gstin:{GSTIN}" and mem["stats"]["confirmations"] == 2
    run(go())


def test_mongo_unsafe_keys_are_stored_safely(env):
    async def go():
        for i in range(1, 3):
            await save_bill(env, i, supplier="M/s. A.B. Traders Pvt. Ltd.", gstin="", ledger="5250")
        mem = await env.db.finix_vendor_memory.find_one({"company_id": env.cid})

        def walk(d, path=""):
            for k, v in d.items():
                assert "." not in k and not k.startswith("$"), f"unsafe key {path}{k}"
                if isinstance(v, dict):
                    walk(v, f"{path}{k}.")
        walk({k: v for k, v in mem.items() if k != "_id"})
        listed = await env.il.list_vendor_memory(env.cid)
        assert listed[0]["layout_labels"]["invoice_no"] == "invoice no"
        assert "A.B. Traders" in listed[0]["vendor_name"]
    run(go())


# ── step 3: vendor layout ────────────────────────────────────────────────────
def test_layout_labels_are_learned_and_fill_an_empty_field(env):
    async def go():
        for i in (1, 2):
            await save_bill(env, i, ledger="5250")
        mem = await env.il.get_memory(env.cid, GSTIN, VENDOR)
        text = BILL_TEXT.format(no="INV/23-24/0099", dd="15/11/2026", tv="2,000.00", c="180.00", gt="2,360.00")
        fills, notes = env.il.apply_layout(mem, text, {"invoice_no": "", "invoice_date": "", "taxable_amount": 0.0, "grand_total": 0.0})
        assert fills == {"invoice_no": "INV/23-24/0099", "invoice_date": "2026-11-15", "taxable_amount": 2000.0, "grand_total": 2360.0}
        assert {n["code"] for n in notes} == {"layout_filled"}
    run(go())


def test_layout_never_overwrites_the_readers_value_but_flags_a_disagreement(env):
    async def go():
        for i in (1, 2):
            await save_bill(env, i, ledger="5250")
        mem = await env.il.get_memory(env.cid, GSTIN, VENDOR)
        text = BILL_TEXT.format(no="INV/23-24/0099", dd="15/11/2026", tv="2,000.00", c="180.00", gt="2,360.00")
        fills, notes = env.il.apply_layout(mem, text, {"invoice_no": "INV/23-24/0099", "invoice_date": "2026-11-15",
                                                       "taxable_amount": 2000.0, "grand_total": 9999.0})
        assert fills == {}
        assert [n["code"] for n in notes] == ["layout_differs"] and notes[0]["field"] == "grand_total"
    run(go())


def test_a_label_seen_once_is_not_trusted(env):
    async def go():
        await save_bill(env, 1, ledger="5250")
        mem = await env.il.get_memory(env.cid, GSTIN, VENDOR)
        fills, _ = env.il.apply_layout(mem, BILL_TEXT.format(no="INV/23-24/0099", dd="15/11/2026", tv="2,000.00", c="1", gt="2,360.00"),
                                       {"invoice_no": "", "grand_total": 0.0})
        assert fills == {}
    run(go())


def test_unusual_invoice_number_and_gst_rate_are_flagged(env):
    async def go():
        for i in range(1, 5):
            await save_bill(env, i, ledger="5250")
        mem = await env.il.get_memory(env.cid, GSTIN, VENDOR)
        assert env.il.invoice_no_warning(mem, "INV/23-24/0123") is None
        w = env.il.invoice_no_warning(mem, "ABC123")
        assert w and w["code"] == "invoice_no_unusual"
        assert env.il.gst_rate_warning(mem, 1000, 180) is None
        w = env.il.gst_rate_warning(mem, 1000, 50)
        assert w and w["code"] == "gst_rate_unusual" and "5%" in w["message"] and "18%" in w["message"]
        assert env.il.gst_rate_warning(None, 1000, 50) is None
    run(go())


# ── step 4: ledger and bank signals ──────────────────────────────────────────
def test_editing_a_saved_bills_ledger_is_a_correction_and_is_counted_once(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        kw = dict(gstin=GSTIN, name=VENDOR, to_code="5300", to_name="Office & Admin Expenses", from_code="5250",
                  signal="edit", ref="edit:b3:5300:t1")
        assert (await env.il.record_ledger_signal(env.cid, **kw))["outcome"] == "correction"
        assert (await env.il.record_ledger_signal(env.cid, **kw)).get("duplicate")        # same edit replayed
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert s["code"] == "5300" and not s["auto_apply"]
    run(go())


def test_bank_categorisation_confirms_or_conflicts(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        assert (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["auto_apply"]
        r = await env.il.learn_from_bank_categorization(env.cid, "UPI/CLOUDY TECH PVT LTD/998877", "5250", "Software", txn_id="t1")
        assert r["outcome"] == "confirmation"
        assert (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["auto_apply"]          # agreeing keeps trust
        r = await env.il.learn_from_bank_categorization(env.cid, "NEFT CLOUDY TECH 5521", "5300", "Office", txn_id="t2")
        assert r["outcome"] == "conflict"
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert s["code"] == "5250" and not s["auto_apply"]                                   # conflict: ask again, don't flip
        assert await env.il.learn_from_bank_categorization(env.cid, "SALARY CREDIT", "5100", "Salaries", txn_id="t3") is None
        assert await env.il.learn_from_bank_categorization(env.other, "NEFT CLOUDY TECH 5521", "5300", "Office", txn_id="t4") is None
    run(go())


def test_bank_payment_of_a_bill_reinforces_once(env):
    async def go():
        b = await save_bill(env, 1, ledger="5250")
        assert (await env.il.learn_from_bank_bill_match(env.cid, b, txn_id="t1"))["outcome"] == "confirmation"
        assert (await env.il.learn_from_bank_bill_match(env.cid, b, txn_id="t1")).get("duplicate")
    run(go())


def test_adjustment_note_that_moves_the_expense_head_is_a_correction(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        bill = await env.db.purchase_invoices.find_one({"company_id": env.cid, "invoice_no": "INV/23-24/0003"})
        acc = {a["code"]: a["id"] async for a in env.db.chart_of_accounts.find({"company_id": env.cid})}
        old_lines = [{"account_id": acc["5250"], "debit": 1000.0, "credit": 0.0}, {"account_id": acc["1200"], "debit": 180.0, "credit": 0.0}]
        new_lines = [{"account_id": acc["5300"], "debit": 1000.0, "credit": 0.0}, {"account_id": acc["1200"], "debit": 180.0, "credit": 0.0}]
        original = {"source": "purchase", "source_id": bill["id"]}
        await env.lk._learn_from_adjustment(original, old_lines, new_lines, env.cid, "u1", "note1")
        s = await env.il.suggest_ledger(env.cid, GSTIN, VENDOR)
        assert s["code"] == "5300" and not s["auto_apply"]
        # a note that only touches GST, or a non-purchase entry, teaches nothing
        before = await env.db.finix_learning_events.count_documents({})
        await env.lk._learn_from_adjustment(original, old_lines, old_lines, env.cid, "u1", "note2")
        await env.lk._learn_from_adjustment({"source": "sales", "source_id": "x"}, old_lines, new_lines, env.cid, "u1", "note3")
        assert await env.db.finix_learning_events.count_documents({}) == before
    run(go())


# ── step 5: measuring accuracy ───────────────────────────────────────────────
def test_straight_through_rate_counts_only_reviewed_bills_that_needed_no_edit(env):
    async def go():
        await save_bill(env, 1, ledger="5250")                          # ledger picked over Finix's guess -> not straight-through
        await save_bill(env, 2)                                         # clean
        await save_bill(env, 3)                                         # clean
        await save_bill(env, 4, edited=["invoice_no", "grand_total"])   # reader got two fields wrong
        await save_bill(env, 5, edited=["company_id", "client_id"])     # edits to non-invoice fields don't count as misreads
        await save_bill(env, 6, source="manual")                        # typed by hand: not a reading, not scored
        rep = await env.il.accuracy_report(env.cid)
        assert rep["bills_reviewed"] == 6 and rep["bills_read_by_finix"] == 5
        assert rep["straight_through"] == 3 and rep["straight_through_rate"] == 60.0
        assert rep["field_edits"] == {"grand_total": 1, "invoice_no": 1}
        assert rep["ledger"]["proposals"] == 6 and rep["ledger"]["correct"] == 5
        assert rep["ledger"]["learned"]["n"] == 5 and rep["ledger"]["rules"]["n"] == 1
        v = rep["vendors"][0]
        assert v["bills"] == 6 and v["straight_through_rate"] == 60.0
        assert rep["state"]["vendors_known"] == 1
        assert rep["improvement_points"] is None and "Not enough" in rep["improvement_note"]
    run(go())


def test_accuracy_trend_and_improvement_over_weeks(env):
    async def go():
        now = datetime.now(timezone.utc)

        def ev(days_ago, ok):
            return dict(company_id=env.cid, event="confirm", at=(now - timedelta(days=days_ago)).isoformat(), vendor_key="name:x",
                        vendor_name="X", read_by_machine=True, straight_through=ok, edited_fields=[] if ok else ["grand_total"],
                        ledger_proposed="5250", ledger_final="5250", ledger_corrected=False, proposal_source="rules")
        old = [ev(40 + i, i % 2 == 0) for i in range(10)]               # earlier: 50% right
        new = [ev(1 + i, i != 0) for i in range(10)]                    # recent: 90% right
        await env.db.finix_learning_events.insert_many([dict(e, id=f"e{i}") for i, e in enumerate(old + new)])
        rep = await env.il.accuracy_report(env.cid, days=90)
        assert rep["improvement_points"] == pytest.approx(40.0, abs=0.1)
        assert len(rep["trend"]) >= 2 and all("rate" in t for t in rep["trend"])
        assert rep["straight_through_rate"] == 70.0
        # another company sees nothing
        assert (await env.il.accuracy_report(env.other))["bills_reviewed"] == 0
    run(go())


def test_vendors_that_keep_needing_edits_are_surfaced(env):
    async def go():
        for i in range(1, 5):
            await save_bill(env, i, supplier="Messy Vendor", gstin="", edited=["invoice_no"], ledger="5300")
        rep = await env.il.accuracy_report(env.cid)
        assert rep["vendors"][0]["needs_attention"] is True and rep["vendors"][0]["straight_through_rate"] == 0.0
    run(go())


# ── admin: see and reset ─────────────────────────────────────────────────────
def test_admin_can_list_and_reset_one_vendor_and_the_reset_is_logged(env):
    async def go():
        for i in range(1, 4):
            await save_bill(env, i, ledger="5250")
        await save_bill(env, 1, supplier="Other Vendor", gstin="", ledger="5300")
        listing = await env.il.list_vendor_memory(env.cid)
        top = next(v for v in listing if v["vendor_key"] == f"gstin:{GSTIN}")
        assert top["auto_fill_active"] and top["ledger_code"] == "5250" and top["usual_gst_rate"] == 18.0
        assert await env.il.reset_vendor(env.cid, top["vendor_key"], "u1") is True
        assert (await env.il.suggest_ledger(env.cid, GSTIN, VENDOR))["code"] == ""
        assert len(await env.il.list_vendor_memory(env.cid)) == 1                 # the other vendor is untouched
        assert await env.db.finix_learning_events.count_documents({"event": "reset", "company_id": env.cid}) == 1
        assert await env.il.reset_vendor(env.cid, top["vendor_key"], "u1") is False
        assert await env.il.reset_vendor(env.other, "name:other vendor", "u1") is False   # not another company's
        b = await save_bill(env, 9)                                                # next bill starts fresh: proposal is review-only
        assert not b["ledger_auto_applied"]
    run(go())


def test_reset_endpoint_is_admin_only(env):
    from fastapi import HTTPException
    import backend.accounting_ai.finix_agent_complete as fa
    staff = types.SimpleNamespace(id="u2", role="staff", company_id=env.cid, permissions={"can_view_accounting_reports": True})

    async def go():
        with pytest.raises(HTTPException) as exc:
            await fa.learning_reset_vendor(fa.ResetVendorRequest(vendor_key=f"gstin:{GSTIN}", company_id=env.cid), staff)
        assert exc.value.status_code == 403
        acc = await fa.learning_accuracy(company_id=env.cid, days=30, current_user=staff)          # staff may view
        assert acc["bills_reviewed"] == 0
    run(go())


# ── end-to-end through the real confirm / preview / expense-head code ────────
def test_confirm_endpoint_learns_and_ignores_non_invoice_edits(env):
    async def go():
        data = env.inv.PurchaseInvoiceConfirm(
            company_id=env.cid, supplier_name=VENDOR, supplier_gstin=GSTIN, invoice_no="INV/23-24/0001", invoice_date="2026-10-10",
            taxable_amount=1000, cgst_amount=90, sgst_amount=90, total_gst=180, grand_total=1180,
            file_name="a.pdf", raw_text_excerpt=BILL_TEXT.format(no="INV/23-24/0001", dd="10/10/2026", tv="1,000.00", c="90.00", gt="1,180.00"),
            edited_fields=["company_id", "invoice_no"], expense_ledger_code="5250", acknowledge_mismatch=True)
        res = await env.inv.confirm_purchase_invoice(data, USER)
        assert res["purchase_invoice"]["expense_ledger_code"] == "5250"
        ev = await env.db.finix_learning_events.find_one({"company_id": env.cid, "event": "confirm"})
        assert ev["edited_fields"] == ["invoice_no"] and ev["straight_through"] is False and ev["read_by_machine"] is True
        assert ev["ledger_corrected"] is True and ev["ledger_final"] == "5250"
    run(go())


def test_manual_create_learns_but_is_not_scored_as_a_reading(env):
    async def go():
        data = env.inv.PurchaseInvoiceCreate(
            company_id=env.cid, supplier_name=VENDOR, supplier_gstin=GSTIN, invoice_no="M-1", invoice_date="2026-10-10",
            taxable_amount=1000, total_gst=180, grand_total=1180)
        await env.inv.create_purchase_invoice(data, USER)
        assert (await env.il.get_memory(env.cid, GSTIN, VENDOR))["stats"]["confirmations"] == 1
        assert (await env.il.accuracy_report(env.cid))["bills_read_by_finix"] == 0
    run(go())


def test_expense_heads_endpoint_lists_postable_expense_accounts(env):
    async def go():
        heads = await env.inv.purchase_expense_heads(company_id=env.cid, current_user=USER)
        codes = {h["code"] for h in heads}
        assert {"5250", "5200", "5300"} <= codes and "2000" not in codes
    run(go())


def test_preview_uses_memory_to_fill_layout_and_explain_the_ledger(env, monkeypatch):
    from fastapi import UploadFile
    import io

    async def go():
        for i in (1, 2):
            await save_bill(env, i, ledger="5250")
        monkeypatch.setattr(env.inv, "_purchase_parties", lambda user: _parties(env))
        # a bill whose labels the generic reader may not catch but this vendor always prints the same way
        text = (f"{VENDOR}\nGSTIN: {GSTIN}\n" + BILL_TEXT.format(no="INV/23-24/0042", dd="12/11/2026", tv="3,000.00", c="270.00", gt="3,540.00"))
        up = UploadFile(filename="b.txt", file=io.BytesIO(text.encode()))
        res = await env.inv._read_purchase_upload(up, USER, env.cid, None)
        assert res["learning"]["vendor_known"] and res["learning"]["confirmations"] == 2
        assert res["ledger"]["classification_source"] == "learned" and res["ledger"]["expense_ledger_code"] == "5250"
        codes = {w["code"] for w in res["warnings"]}
        assert "ledger_learned_review" in codes                         # only 2 confirmations: asks the person
        assert res["extracted"]["invoice_no"] == "INV/23-24/0042"
    run(go())


async def _parties(env):
    return [{"id": env.cid, "name": f"Company {env.cid}", "gstin": "", "kind": "company"}]
