import asyncio
import types

import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend.tenant_runtime import TenantAwareDatabase, reset_authenticated_company, set_authenticated_company


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.engagex import mailer, router as ex
    from backend.engagex.mailer import ResolvedSender

    raw = mongomock_motor.AsyncMongoMockClient()["live_edit"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=None))
    monkeypatch.setattr(ex, "require_page", lambda *a, **k: None)
    sender = ResolvedSender(id="exs_1", label="Gmail", from_name="Prodigist", from_email="info.prodigist@gmail.com",
                            reply_to=None, kind="google")

    async def fake_resolve(company_id, sender_id, **k):
        return sender

    monkeypatch.setattr(mailer, "resolve_sender", fake_resolve)
    routes = {r.name: r.endpoint for r in ex.router.routes if hasattr(r, "name")}
    return raw, ex, routes


USER = types.SimpleNamespace(id="u1", company_id="c1", role="admin", full_name="A", email="a@x")


def _run(coro):
    async def go():
        t = set_authenticated_company("c1")
        try:
            return await coro
        finally:
            reset_authenticated_company(t)
    return asyncio.run(go())


def _campaign(status):
    return {"id": "c", "company_id": "c1", "channel": "email", "name": "Black Friday", "status": status,
            "created_at": "2026-11-27T08:42:00+00:00", "sender_from": "Prodigist <info.prodigist@gmail.com>",
            "settings": {"sender_id": "exs_1", "per_minute": 30, "style": "personal"},
            "content": {"subject": "Old subject", "html": "<p>Old</p>"}, "stats": {"total": 10000, "pending": 9700, "sent": 300}}


def test_paused_campaign_can_be_edited_and_running_cannot(env):
    raw, ex, routes = env
    edit = routes["email_campaign_live_edit"]
    _run(raw.engagex_campaigns.insert_one(_campaign("running")))
    with pytest.raises(HTTPException) as exc:
        _run(edit("c", ex.LiveEditIn(subject="New"), USER))
    assert exc.value.status_code == 409

    _run(raw.engagex_campaigns.update_one({"id": "c"}, {"$set": {"status": "paused"}}))
    out = _run(edit("c", ex.LiveEditIn(subject="New subject", html="<p>New</p>", from_name="Prodigist Ventures",
                                         daily_limit=300, send_start_hour=10, send_end_hour=19, pause_every=50,
                                         pause_sec=600), USER))
    doc = _run(raw.engagex_campaigns.find_one({"id": "c"}))
    assert doc["content"]["subject"] == "New subject" and doc["content"]["html"] == "<p>New</p>"
    assert doc["settings"]["daily_limit"] == 300 and doc["settings"]["send_start_hour"] == 10
    assert doc["settings"]["from_name"] == "Prodigist Ventures"
    assert doc["sender_from"] == "Prodigist Ventures <info.prodigist@gmail.com>"
    assert doc["status"] == "paused" and "content" in out["changed"]


def test_plan_estimates_days_from_the_tightest_daily_cap(env):
    raw, ex, _ = env
    doc = _campaign("running")
    doc["settings"].update({"daily_limit": 500, "send_start_hour": 10, "send_end_hour": 19})
    plan = _run(ex._campaign_plan(doc))
    assert plan["per_day"] == 400  # Gmail's safe cap beats the 500 chosen
    assert plan["days_left"] == 25 and plan["remaining"] == 9700
    assert plan["mailbox"]["provider"] == "Gmail" and plan["window"] == {"start": 10, "end": 19}
