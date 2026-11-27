"""All bulk WhatsApp goes through the paced EngageX broadcast engine."""
import asyncio
import types

import pytest

import backend.server  # noqa: F401
from backend.tenant_runtime import TenantAwareDatabase, reset_authenticated_company, set_authenticated_company


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend import whatsapp_integration as wa
    from backend.engagex import router as ex
    from backend.engagex import worker

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["wa_bulk"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))
    monkeypatch.setattr(worker, "kick", lambda: None)

    async def yes(user):
        return True

    async def session(user, sid):
        return "wa_1"

    async def profile(company_id):
        return {"name": "Acme"}

    monkeypatch.setattr(wa, "_has_wa_access", yes)
    monkeypatch.setattr(wa, "resolve_sendable_session", session)
    monkeypatch.setattr(ex, "company_profile", profile)
    return raw, wa


def _user():
    return types.SimpleNamespace(id="u1", full_name="Admin", email="a@x.example", company_id="cus-1", role="admin")


def _run(coro):
    async def go():
        token = set_authenticated_company("cus-1")
        try:
            return await coro
        finally:
            reset_authenticated_company(token)
    return asyncio.run(go())


def test_clients_bulk_whatsapp_becomes_paced_broadcast(env):
    raw, wa = env
    body = wa.WABulkCampaignRequest(
        name="GST reminder", message="Dear {Name}, your GSTIN {gstin}",
        recipients=[wa.WABulkCampaignRecipient(phone="9876543210", name="Acme", variables={"name": "Acme", "gstin": "27AAA"}),
                    wa.WABulkCampaignRecipient(phone="9876500000", name="Beta", variables={"name": "Beta", "gstin": "27BBB"})],
        min_delay_sec=1, max_delay_sec=2)  # too fast: raised to a safe pace
    out = _run(wa._queue_bulk(_user(), body))
    c = asyncio.run(raw.engagex_campaigns.find_one({"id": out["campaign_id"]}))
    assert c["channel"] == "whatsapp" and c["status"] == "queued"
    assert c["content"]["message"] == "Dear {{name}}, your GSTIN {{gstin}}"
    assert c["settings"]["min_delay_sec"] >= 5 and c["settings"]["pause_every"] == 20
    assert asyncio.run(raw.engagex_recipients.count_documents({"campaign_id": out["campaign_id"]})) == 2


def test_scheduled_bulk_is_listed_and_cancellable(env):
    raw, wa = env
    body = wa.WAScheduleBulkRequest(recipients=[wa.WAScheduledRecipient(phone="9876543210", message="Hello Acme, line1\\nline2")],
                                    scheduled_at="2099-01-01T09:00:00")
    out = _run(wa.schedule_bulk_send(body, current_user=_user()))
    c = asyncio.run(raw.engagex_campaigns.find_one({"id": out["job_id"]}))
    assert c["status"] == "scheduled" and c["scheduled_at"].startswith("2099-01-01T03:30")  # 09:00 IST
    row = asyncio.run(raw.engagex_recipients.find_one({"campaign_id": out["job_id"]}))
    assert row["variables"]["message_body"] == "Hello Acme, line1\\nline2"
    jobs = _run(wa.list_scheduled_bulk(current_user=_user()))["jobs"]
    assert any(j["job_id"] == out["job_id"] for j in jobs)
    _run(wa.cancel_scheduled_bulk(out["job_id"], current_user=_user()))
    assert asyncio.run(raw.engagex_campaigns.find_one({"id": out["job_id"]}))["status"] == "cancelled"
