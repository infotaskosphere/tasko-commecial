"""MailMaster: the platform email service can be edited, removed and restored
per company, and every place that uses it honours that."""
import asyncio

import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend.engagex import common, mailer, router as ex
from backend.models import User


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["platform_sender_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))

    async def profile(_cid):
        return {"name": "Prodigist Ventures", "email": "office@prodigist.example"}

    class FakeEmailService:
        async def get_raw_config(self):
            return {"from_email": "noreply@platform.example", "from_name": "OneNexa", "is_enabled": True, "provider_type": "smtp"}

    import backend.email_service.service as svc

    monkeypatch.setattr(svc, "email_service", FakeEmailService())
    monkeypatch.setattr(mailer, "company_profile", profile)
    monkeypatch.setattr(ex, "company_profile", profile)
    monkeypatch.setattr(ex, "require_page", lambda *a, **k: None)
    monkeypatch.setattr(ex, "workspace_company_id", lambda _u: "c1")
    admin = User(id="a1", email="a@prodigist.example", role="admin", full_name="Admin", company_id="c1")
    return raw, admin


def _run(coro):
    return asyncio.run(coro)


def test_platform_sender_defaults_then_company_overrides(env):
    _, admin = env
    listed = _run(ex.list_senders(current_user=admin))
    platform = listed["senders"][0]
    assert (platform["from_name"], platform["reply_to"], platform["is_default"]) == ("Prodigist Ventures", "office@prodigist.example", True)

    _run(ex.update_sender_profile("platform", ex.SenderProfileIn(from_name="Prodigist Accounts", reply_to="accounts@prodigist.example", label="Company mail"), current_user=admin))
    platform = _run(ex.list_senders(current_user=admin))["senders"][0]
    assert (platform["from_name"], platform["reply_to"], platform["label"]) == ("Prodigist Accounts", "accounts@prodigist.example", "Company mail")
    resolved = _run(mailer.resolve_sender("c1", "platform"))
    assert (resolved.from_name, resolved.reply_to, resolved.from_email) == ("Prodigist Accounts", "accounts@prodigist.example", "noreply@platform.example")

    # Empty values fall back to the company profile.
    _run(ex.update_sender_profile("platform", ex.SenderProfileIn(from_name="", reply_to=None), current_user=admin))
    resolved = _run(mailer.resolve_sender("c1", "platform"))
    assert (resolved.from_name, resolved.reply_to) == ("Prodigist Ventures", "office@prodigist.example")


def test_remove_and_restore_platform_sender(env):
    raw, admin = env
    _run(ex.delete_sender("platform", current_user=admin))
    listed = _run(ex.list_senders(current_user=admin))
    assert listed["platform_removed"] is True and listed["senders"] == []
    with pytest.raises(HTTPException) as exc:
        _run(mailer.resolve_sender("c1", None))
    assert exc.value.status_code == 400 and "removed" in exc.value.detail
    with pytest.raises(HTTPException):
        _run(ex.set_default_sender("platform", current_user=admin))

    _run(ex.restore_platform_sender(current_user=admin))
    listed = _run(ex.list_senders(current_user=admin))
    assert listed["platform_removed"] is False and listed["senders"][0]["id"] == "platform"
    assert _run(mailer.resolve_sender("c1", "platform")).from_email == "noreply@platform.example"


def test_platform_sender_cannot_be_removed_while_a_campaign_uses_it(env):
    raw, admin = env
    _run(raw[common.CAMPAIGNS].insert_one({"id": "exc1", "company_id": "c1", "channel": "email", "status": "scheduled", "settings": {"sender_id": "platform"}}))
    with pytest.raises(HTTPException) as exc:
        _run(ex.delete_sender("platform", current_user=admin))
    assert exc.value.status_code == 409


def test_platform_sender_settings_are_per_company(env):
    raw, admin = env
    _run(ex.delete_sender("platform", current_user=admin))
    assert _run(mailer.resolve_sender("c2", "platform")).from_email == "noreply@platform.example"


def test_connected_sender_still_needs_a_name(env):
    raw, admin = env
    _run(raw[common.SENDERS].insert_one({"id": "exs1", "company_id": "c1", "kind": "smtp", "from_email": "x@prodigist.example"}))
    with pytest.raises(HTTPException) as exc:
        _run(ex.update_sender_profile("exs1", ex.SenderProfileIn(from_name="  "), current_user=admin))
    assert exc.value.status_code == 400
