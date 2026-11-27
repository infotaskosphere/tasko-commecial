"""Bulk client emails from a connected mailbox are queued as a paced campaign."""
import asyncio
import types

import pytest

import backend.server  # noqa: F401
from backend.tenant_runtime import TenantAwareDatabase, reset_authenticated_company, set_authenticated_company


def test_bulk_email_becomes_paced_campaign(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.engagex import router as ex
    from backend.engagex import worker

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["bulk_queue"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))
    monkeypatch.setattr(worker, "kick", lambda: None)

    async def fake_profile(company_id):
        return {"name": "Acme"}

    monkeypatch.setattr(ex, "company_profile", fake_profile)
    user = types.SimpleNamespace(id="u1", full_name="Admin", email="a@x.example", company_id="cus-1", role="admin")

    async def run():
        await raw.engagex_email_senders.insert_one({"id": "exs_1", "company_id": "cus-1", "kind": "smtp", "label": "Office",
                                              "from_email": "office@gmail.com", "from_name": "Acme", "deleted": False,
                                              "smtp": {"host": "smtp.gmail.com", "port": 587}, "owner_user_id": None})
        token = set_authenticated_company("cus-1")
        try:
            return await ex.queue_bulk_email(
                user, sender_id="exs_1", from_name="Prodigist Ventures", subject="Hello {name}",
                html="<p>Dear {name}</p>",
                recipients=[{"name": "A", "email": "a@client.example", "variables": {"name": "A"}},
                            {"name": "B", "email": "b@client.example", "variables": {"name": "B"}}],
                per_minute=6)
        finally:
            reset_authenticated_company(token)

    result = asyncio.run(run())
    campaign = asyncio.run(raw.engagex_campaigns.find_one({"id": result["campaign_id"]}))
    assert result["status"] == "queued"
    assert campaign["settings"]["per_minute"] == 6 and campaign["settings"]["from_name"] == "Prodigist Ventures"
    assert campaign["content"]["subject"] == "Hello {{name}}"
    assert asyncio.run(raw.engagex_recipients.count_documents({"campaign_id": result["campaign_id"]})) == 2
