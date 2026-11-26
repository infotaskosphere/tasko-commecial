"""One organisation mailbox, connected in Settings, used by every module."""
import asyncio
import base64

import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend import org_mail
from backend.engagex import connected_senders, mailer
from backend.engagex.common import encrypt_secret
from backend.models import User


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["org_mail_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))

    profiles = {"org-a": {"name": "Acme Advisors", "email": "office@acme.example"},
                "org-b": {"name": "Beta & Co", "email": "hello@beta.example"}}

    async def profile(cid):
        return profiles.get(cid, {"name": "", "email": None})

    class FakeEmailService:
        async def get_raw_config(self):
            return {"from_email": "noreply@platform.example", "from_name": "OneNexa", "is_enabled": True}

    import backend.email_service.service as svc

    monkeypatch.setattr(svc, "email_service", FakeEmailService())
    monkeypatch.setattr(mailer, "company_profile", profile)
    monkeypatch.setattr(connected_senders, "company_profile", profile)
    monkeypatch.setattr(org_mail, "company_profile", profile)
    monkeypatch.setattr(org_mail, "_company", lambda user: user.company_id)

    sent = []

    async def fake_send_one(*, sender, session, to_email, subject, html_body, text_body, attachments=None, **_):
        if to_email.startswith("bounce"):
            raise RuntimeError("550 mailbox unavailable")
        sent.append({"kind": sender.kind, "from": sender.from_email, "name": sender.from_name,
                     "reply_to": sender.reply_to, "to": to_email, "subject": subject,
                     "attachments": attachments, "sender_id": sender.id})

    monkeypatch.setattr(mailer, "send_one", fake_send_one)
    monkeypatch.setattr(mailer, "open_session", lambda sender: None)
    return raw, sent


def _run(coro):
    return asyncio.run(coro)


def _admin(company="org-a"):
    return User(id=f"admin-{company}", email=f"admin@{company}.example", role="admin", full_name="Admin", company_id=company)


async def _connect(raw, company, email, kind="google"):
    await connected_senders.save_oauth_sender(company_id=company, user_id="u", kind=kind, email=email,
                                              refresh_token="refresh", scopes=["gmail.send"])
    return await raw.engagex_email_senders.find_one({"company_id": company, "from_email": email})


def test_without_a_mailbox_mail_goes_out_under_the_organisations_name(env):
    raw, sent = env
    result = _run(org_mail.send_org_email(company_id="org-a", to_email="client@x.example", subject="Invoice 1",
                                          html_body="<p>Hi</p>", fallback_reply_to="accounts@acme.example"))
    assert result["kind"] == "platform"
    assert sent[-1]["from"] == "noreply@platform.example"
    assert sent[-1]["name"] == "Acme Advisors"
    assert sent[-1]["reply_to"] == "accounts@acme.example"
    status = _run(org_mail.org_email_status(current_user=_admin()))
    assert status["connected"] is False and status["default_sender_id"] == "platform"


def test_first_connected_mailbox_becomes_the_default_for_every_module(env):
    raw, sent = env
    doc = _run(_connect(raw, "org-a", "accounts@acme.example"))
    assert doc["is_default"] is True
    _run(org_mail.send_org_email(company_id="org-a", to_email="client@x.example", subject="Quote",
                                 html_body="<p>Hi</p>", fallback_reply_to="ignored@acme.example",
                                 attachments=[org_mail.attachment("Q.pdf", b"%PDF", "application/pdf")]))
    assert sent[-1]["kind"] == "google" and sent[-1]["from"] == "accounts@acme.example"
    assert sent[-1]["reply_to"] is None  # replies go to the mailbox itself
    assert base64.b64decode(sent[-1]["attachments"][0]["content"]) == b"%PDF"
    # A second mailbox does not steal the default.
    second = _run(_connect(raw, "org-a", "sales@acme.example", kind="microsoft"))
    assert second["is_default"] is False
    # EngageX campaigns without an explicit sender use the same default.
    resolved = _run(mailer.resolve_sender("org-a", None))
    assert resolved.from_email == "accounts@acme.example"
    status = _run(org_mail.org_email_status(current_user=_admin()))
    assert status["connected"] and status["default_from_email"] == "accounts@acme.example"
    assert [m["from_email"] for m in status["mailboxes"]] == ["accounts@acme.example", "sales@acme.example"]


def test_send_from_another_connected_mailbox(env):
    raw, sent = env
    _run(_connect(raw, "org-a", "accounts@acme.example"))
    sales = _run(_connect(raw, "org-a", "sales@acme.example"))
    _run(org_mail.send_org_email(company_id="org-a", to_email="c@x.example", subject="s", html_body="b",
                                 sender_id=sales["id"]))
    assert sent[-1]["from"] == "sales@acme.example"


def test_an_organisation_can_never_send_from_another_organisations_mailbox(env):
    raw, sent = env
    other = _run(_connect(raw, "org-b", "hello@beta.example"))
    with pytest.raises(HTTPException) as exc:
        _run(org_mail.send_org_email(company_id="org-a", to_email="c@x.example", subject="s", html_body="b",
                                     sender_id=other["id"]))
    assert exc.value.status_code == 404
    assert not [m for m in sent if m["from"] == "hello@beta.example"]
    # org-a's own default is unaffected by org-b's mailbox.
    _run(org_mail.send_org_email(company_id="org-a", to_email="c@x.example", subject="s", html_body="b"))
    assert sent[-1]["kind"] == "platform"
    with pytest.raises(HTTPException):
        _run(org_mail.org_email_set_default(other["id"], current_user=_admin("org-a")))
    with pytest.raises(HTTPException):
        _run(org_mail.org_email_remove(other["id"], current_user=_admin("org-a")))


def test_failures_are_reported_and_recorded_on_the_mailbox(env):
    raw, _ = env
    doc = _run(_connect(raw, "org-a", "accounts@acme.example"))
    with pytest.raises(HTTPException) as exc:
        _run(org_mail.send_org_email(company_id="org-a", to_email="bounce@x.example", subject="s", html_body="b"))
    assert exc.value.status_code == 502 and "accounts@acme.example" in exc.value.detail
    saved = _run(raw.engagex_email_senders.find_one({"id": doc["id"]}))
    assert "550" in saved["last_error"]


def test_removing_the_default_promotes_the_next_mailbox(env):
    raw, sent = env
    first = _run(_connect(raw, "org-a", "accounts@acme.example"))
    _run(_connect(raw, "org-a", "sales@acme.example"))
    _run(org_mail.org_email_remove(first["id"], current_user=_admin()))
    status = _run(org_mail.org_email_status(current_user=_admin()))
    assert status["default_from_email"] == "sales@acme.example"
    removed = _run(raw.engagex_email_senders.find_one({"id": first["id"]}))
    assert removed["deleted"] and removed["refresh_token_enc"] is None


def test_only_admins_manage_mailboxes(env):
    staff = User(id="s1", email="s@acme.example", role="staff", full_name="Staff", company_id="org-a")
    with pytest.raises(HTTPException) as exc:
        _run(org_mail.org_email_set_default("platform", current_user=staff))
    assert exc.value.status_code == 403
    # Staff may still read the list (for "Send from").
    assert _run(org_mail.org_email_status(current_user=staff))["can_manage"] is False


def test_bulk_client_email_uses_the_organisation_mailbox(env, monkeypatch):
    raw, sent = env
    _run(_connect(raw, "org-a", "accounts@acme.example"))
    from backend.server_modules.routes import dashboard_ops

    monkeypatch.setattr("backend.engagex.common.workspace_company_id", lambda user: user.company_id)
    req = dashboard_ops.BulkClientEmailRequest(
        recipients=[{"email": "one@x.example", "name": "One"}, {"email": "two@x.example", "name": "Two"}],
        subject="Hello {name}", body_template="Dear {name},\nThanks")
    result = _run(dashboard_ops.send_bulk_client_emails(req, current_user=_admin()))
    assert result["sent"] == 2
    assert [(m["from"], m["to"], m["subject"]) for m in sent[-2:]] == [
        ("accounts@acme.example", "one@x.example", "Hello One"),
        ("accounts@acme.example", "two@x.example", "Hello Two"),
    ]
