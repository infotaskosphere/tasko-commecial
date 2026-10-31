"""MailMaster deliverability: personal style (inbox placement) and mailbox protection."""
import asyncio
from datetime import timedelta

import pytest

import backend.server  # noqa: F401
from backend.engagex import common, deliverability as dlv, mailer, public, worker
from backend.engagex.mailer import ResolvedSender, build_mime


# ── Provider detection ───────────────────────────────────────────────────────
@pytest.mark.parametrize("kind,email,host,provider,daily", [
    ("smtp", "info.prodigist@gmail.com", "smtp.gmail.com", "Gmail", 400),
    ("google", "info.prodigist@gmail.com", "", "Gmail", 400),
    ("google", "ca@firm.in", "", "Google Workspace", 1500),
    ("smtp", "ca@firm.in", "smtp.gmail.com", "Google Workspace", 1500),
    ("smtp", "me@outlook.com", "smtp-mail.outlook.com", "Outlook.com", 250),
    ("microsoft", "me@hotmail.com", "", "Outlook.com", 250),
    ("microsoft", "ca@firm.in", "", "Microsoft 365", 8000),
])
def test_known_mailboxes_get_limits_below_the_providers(kind, email, host, provider, daily):
    limits = dlv.mailbox_limits(kind, email, host)
    assert (limits.provider, limits.daily) == (provider, daily)
    assert limits.daily < limits.provider_daily


def test_unknown_relays_have_no_cap_and_override_only_lowers():
    assert dlv.mailbox_limits("smtp", "news@acme.in", "email-smtp.ap-south-1.amazonaws.com") is None
    assert dlv.mailbox_limits("platform", "noreply@onenexa.in") is None
    assert dlv.mailbox_limits("google", "ca@firm.in", "", daily_override=450).daily == 450
    assert dlv.mailbox_limits("google", "me@gmail.com", "", daily_override=5000).daily == 400


@pytest.mark.parametrize("error,hours", [
    ("(550, b'5.4.5 Daily user sending limit exceeded. For more information on Gmail sending limits')", 24),
    ("Gmail rejected the message: Daily user sending quota exceeded.", 24),
    ("(421, b'4.7.0 Try again later, closing connection. (EHLO)')", 0.5),
    ("Microsoft Graph 429 ApplicationThrottled", 0.5),
])
def test_provider_limit_errors_stop_the_run(error, hours):
    wait, _reason = dlv.provider_backoff(error)
    assert wait == timedelta(hours=hours)


@pytest.mark.parametrize("error", ["(550, b'5.1.1 The email account that you tried to reach does not exist.')",
                                   "Recipient address rejected", ""])
def test_ordinary_failures_do_not_stop_the_run(error):
    assert dlv.provider_backoff(error) is None


# ── Personal style content ───────────────────────────────────────────────────
def test_personal_html_has_no_bulk_signals():
    html = dlv.build_personal_html(body_html="<p>Hi Manthan,</p><p>Happy Diwali!</p>")
    assert "Happy Diwali" in html
    for marker in ("Unsubscribe", "You received this email", "display:none", "width=\"1\"", "background:#f1f5f9"):
        assert marker not in html
    sender = ResolvedSender(id="s", label="s", from_name="Prodigist", from_email="info.prodigist@gmail.com", reply_to=None, kind="smtp")
    mime = build_mime(sender=sender, to_email="r@x.test", subject="Happy Diwali", html_body=html, text_body="Hi")
    assert "List-Unsubscribe" not in mime and "X-EngageX-Campaign" not in mime


def test_old_campaigns_keep_newsletter_behaviour():
    assert dlv.campaign_style({}) == "newsletter"
    assert dlv.campaign_style({"style": "personal"}) == "personal"
    assert dlv.campaign_style({"style": "weird"}) == "newsletter"


# ── Worker (in-memory database, fake SMTP) ───────────────────────────────────
def _parts(raw_message):
    """Headers plus decoded HTML of a MIME message."""
    import email as email_lib

    msg = email_lib.message_from_string(raw_message)
    html = next(p.get_payload(decode=True).decode() for p in msg.walk() if p.get_content_type() == "text/html")
    return msg, html


class _FakeSession:
    def __init__(self, fail_with=None):
        self.sent = []
        self.fail_with = fail_with

    async def send(self, from_email, to_email, message):
        if self.fail_with:
            raise RuntimeError(self.fail_with)
        self.sent.append((to_email, message))

    async def close(self):
        return None


@pytest.fixture
def mail_env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["engagex_dlv_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))
    monkeypatch.setattr(worker, "_sleep_with_lease", lambda *_a, **_k: asyncio.sleep(0))
    sender = ResolvedSender(id="exs_1", label="Gmail", from_name="PRODIGIST VENTURES P LTD",
                            from_email="info.prodigist@gmail.com", reply_to=None, kind="smtp",
                            smtp={"host": "smtp.gmail.com"})
    state = {"session": _FakeSession()}

    async def fake_resolve(company_id, sender_id):
        return sender

    monkeypatch.setattr(mailer, "resolve_sender", fake_resolve)
    monkeypatch.setattr(mailer, "open_session", lambda s: state["session"])
    return raw, state


async def _make_campaign(raw, style="personal", recipients=2):
    campaign = {
        "id": "exc_m", "company_id": "c1", "channel": "email", "name": "Diwali", "status": "queued", "created_by": "u1",
        "created_at": common.iso(), "sender_company": "Prodigist", "tenant": {"company_id": "c1"},
        "public_base_url": "https://api.test",
        "settings": {"sender_id": "exs_1", "per_minute": 30, "style": style, "track_opens": True},
        "content": {"subject": "Happy Diwali", "html": "<p>Hi {{first_name}},</p><p>Happy Diwali!</p>"}, "stats": {},
    }
    await raw[common.CAMPAIGNS].insert_one(dict(campaign))
    await raw[common.RECIPIENTS].insert_many([
        {"id": f"r{i}", "company_id": "c1", "campaign_id": "exc_m", "channel": "email", "email": f"p{i}@gmail.com",
         "name": f"Person {i}", "status": "pending", "seq": i, "token": f"tok{i}", "attempts": 0}
        for i in range(recipients)
    ])
    return await worker._claim("exc_m")


def test_personal_campaign_sends_plain_mail_and_counts_the_mailbox(mail_env):
    raw, state = mail_env

    async def scenario():
        await worker._run_campaign(await _make_campaign(raw))
        return (await raw[common.CAMPAIGNS].find_one({"id": "exc_m"}),
                await raw[dlv.SEND_LOG].count_documents({"mailbox": "info.prodigist@gmail.com"}))

    doc, logged = asyncio.run(scenario())
    assert doc["status"] == "completed" and doc["stats"]["sent"] == 2 and logged == 2
    for _to, message in state["session"].sent:
        msg, html = _parts(message)
        assert msg["List-Unsubscribe"] is None and msg["X-EngageX-Campaign"] is None
        assert "Hi Person" in html and "Happy Diwali" in html
        assert "/api/engagex-public/o/" not in html  # no tracking pixel
        assert "Unsubscribe" not in html


def test_newsletter_campaign_keeps_tracking_and_unsubscribe(mail_env):
    raw, state = mail_env
    asyncio.run(worker._run_campaign(asyncio.run(_make_campaign(raw, style="newsletter", recipients=1))))
    msg, html = _parts(state["session"].sent[0][1])
    assert msg["List-Unsubscribe"] == "<https://api.test/api/engagex-public/u/tok0>"
    assert "/api/engagex-public/o/tok0.gif" in html and "Unsubscribe" in html


def test_daily_allowance_used_up_waits_instead_of_sending(mail_env):
    raw, state = mail_env

    async def scenario():
        now = common.utcnow()
        await raw[dlv.SEND_LOG].insert_many([{"mailbox": "info.prodigist@gmail.com", "company_id": "c1",
                                              "at": now - timedelta(hours=23, minutes=59 - (i % 50))} for i in range(400)])
        await worker._run_campaign(await _make_campaign(raw))
        doc = await raw[common.CAMPAIGNS].find_one({"id": "exc_m"})
        pending = await raw[common.RECIPIENTS].count_documents({"campaign_id": "exc_m", "status": "pending"})
        return doc, pending, now

    doc, pending, now = asyncio.run(scenario())
    assert state["session"].sent == [] and pending == 2
    assert doc["status"] == "running" and doc["lease_owner"] is None
    assert doc["throttled_until"] > common.iso(now) and doc["lease_until"] == doc["throttled_until"]
    assert "Daily sending limit reached" in doc["last_error"]
    # Not claimable before the window frees up.
    assert asyncio.run(worker._claim("exc_m")) is None


def test_provider_limit_response_requeues_and_stops(mail_env):
    raw, state = mail_env
    state["session"] = _FakeSession(fail_with="(550, b'5.4.5 Daily user sending limit exceeded.')")

    async def scenario():
        await worker._run_campaign(await _make_campaign(raw))
        doc = await raw[common.CAMPAIGNS].find_one({"id": "exc_m"})
        statuses = sorted([r["status"] async for r in raw[common.RECIPIENTS].find({"campaign_id": "exc_m"})])
        return doc, statuses

    doc, statuses = asyncio.run(scenario())
    assert statuses == ["pending", "pending"]  # nothing marked failed, nothing retried in a loop
    assert doc["stats"]["failed"] == 0 and doc["status"] == "running"
    assert doc["throttled_until"] >= common.iso(common.utcnow() + timedelta(hours=23))


# ── Open tracking ────────────────────────────────────────────────────────────
def test_open_right_after_sending_is_ignored(mail_env):
    raw, _state = mail_env

    async def scenario():
        now = common.utcnow()
        await raw[common.RECIPIENTS].insert_many([
            {"id": "a", "channel": "email", "token": "fresh", "opened_at": None, "sent_at": common.iso(now)},
            {"id": "b", "channel": "email", "token": "older", "opened_at": None, "sent_at": common.iso(now - timedelta(minutes=5))},
        ])
        await public.open_pixel("fresh")
        await public.open_pixel("older")
        return {r["token"]: r["opened_at"] async for r in raw[common.RECIPIENTS].find({})}

    opened = asyncio.run(scenario())
    assert opened["fresh"] is None and opened["older"] is not None
