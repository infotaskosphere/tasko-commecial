"""Connecting a mailbox by account: provider detection, SMTP auto-connect,
Microsoft sign-in (MailMaster sender and platform service) and sending."""
import asyncio
import base64
import json
import smtplib

import httpx
import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend import mail_connect
from backend.engagex import common, mailer, router as ex
from backend.models import User


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def no_dns(monkeypatch):
    async def none(_domain):
        return []

    monkeypatch.setattr(mail_connect, "_mx_hosts", none)


# ── Detection ────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("email,provider,oauth", [
    ("a@gmail.com", "google", "google"),
    ("a@hotmail.com", "microsoft", "microsoft"),
    ("a@outlook.in", "microsoft", "microsoft"),
    ("a@yahoo.co.in", "yahoo", None),
    ("a@icloud.com", "icloud", None),
    ("a@zoho.in", "zoho", None),
])
def test_detect_public_domains(no_dns, email, provider, oauth):
    info = _run(mail_connect.detect(email))
    assert (info["provider"], info["oauth"]) == (provider, oauth)
    assert info["candidates"]


@pytest.mark.parametrize("mx,provider,first_host", [
    (["aspmx.l.google.com"], "google", "smtp.gmail.com"),
    (["prodigist-in.mail.protection.outlook.com"], "microsoft", "smtp.office365.com"),
    (["mx.zoho.in"], "zoho", "smtp.zoho.in"),
    (["mx.zoho.com"], "zoho", "smtp.zoho.com"),
    (["mailstore1.secureserver.net"], "godaddy", "smtpout.secureserver.net"),
    (["mx1.titan.email"], "titan", "smtp.titan.email"),
])
def test_detect_company_domain_by_mx(monkeypatch, mx, provider, first_host):
    async def fake(_domain):
        return mx

    monkeypatch.setattr(mail_connect, "_mx_hosts", fake)
    info = _run(mail_connect.detect("info@prodigist.co"))
    assert info["provider"] == provider
    assert info["candidates"][0]["host"] == first_host


def test_detect_unknown_domain_guesses_mail_and_smtp_hosts(no_dns):
    info = _run(mail_connect.detect("info@prodigist.in"))
    hosts = [c["host"] for c in info["candidates"]]
    assert info["provider"] == "other" and "mail.prodigist.in" in hosts and "smtp.prodigist.in" in hosts


# ── SMTP auto-connect ────────────────────────────────────────────────────────
def test_auto_smtp_skips_unreachable_servers(no_dns, monkeypatch):
    tried = []

    def fake_login(host, port, security, username, password, timeout):
        tried.append((host, port))
        if len(tried) < 3:
            raise OSError("connection refused")

    monkeypatch.setattr(mail_connect, "_try_login", fake_login)
    cfg = _run(mail_connect.auto_smtp("info@prodigist.in", "secret"))
    assert (cfg["host"], cfg["port"]) == tried[-1] and len(tried) == 3
    assert cfg["username"] == "info@prodigist.in"


def test_auto_smtp_wrong_password_stops_with_provider_hint(no_dns, monkeypatch):
    tried = []

    def fake_login(host, port, security, username, password, timeout):
        tried.append(host)
        raise mail_connect._AuthFailed("535 bad credentials")

    monkeypatch.setattr(mail_connect, "_try_login", fake_login)
    with pytest.raises(HTTPException) as exc:
        _run(mail_connect.auto_smtp("a@yahoo.com", "wrong"))
    assert len(tried) == 1 and "app password" in exc.value.detail


def test_auto_smtp_manual_server(no_dns, monkeypatch):
    seen = []
    monkeypatch.setattr(mail_connect, "_try_login", lambda *a: seen.append(a[:3]))
    cfg = _run(mail_connect.auto_smtp("a@prodigist.in", "pw", manual={"host": "mx.host.in", "port": 465, "security": "ssl"}))
    assert seen == [("mx.host.in", 465, "ssl")] and cfg["security"] == "ssl"


def test_try_login_maps_auth_errors(monkeypatch):
    class FakeSMTP:
        def __init__(self, *a, **k): pass
        def ehlo(self): pass
        def starttls(self, **k): pass
        def login(self, u, p): raise smtplib.SMTPAuthenticationError(535, b"no")
        def quit(self): pass

    monkeypatch.setattr(smtplib, "SMTP", FakeSMTP)
    with pytest.raises(mail_connect._AuthFailed):
        mail_connect._try_login("h", 587, "starttls", "u", "p", 5)


# ── MailMaster wiring ────────────────────────────────────────────────────────
@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["mail_connect_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))

    async def profile(_cid):
        return {"name": "Prodigist Ventures", "email": "office@prodigist.example"}

    from backend.engagex import connected_senders

    monkeypatch.setattr(connected_senders, "company_profile", profile)
    monkeypatch.setattr(ex, "company_profile", profile)
    monkeypatch.setattr(ex, "require_page", lambda *a, **k: None)
    monkeypatch.setattr(ex, "workspace_company_id", lambda _u: "c1")
    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "ms-client")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "ms-secret")
    monkeypatch.setenv("FRONTEND_URL", "https://app.example")
    admin = User(id="a1", email="a@prodigist.example", role="admin", full_name="Admin", company_id="c1")
    return raw, admin


def test_connect_mailbox_with_only_email_and_password(env, no_dns, monkeypatch):
    raw, admin = env
    monkeypatch.setattr(mail_connect, "_try_login", lambda *a: None)
    out = _run(ex.connect_mailbox(ex.ConnectMailboxIn(email="Accounts@Zoho.in", password="pw"), current_user=admin))
    assert out["kind"] == "smtp" and out["from_email"] == "accounts@zoho.in" and out["smtp_host"] == "smtp.zoho.in"
    assert out["from_name"] == "Prodigist Ventures" and out["provider"] == "zoho"
    stored = _run(raw[common.SENDERS].find_one({"id": out["id"]}))
    assert stored["password_enc"] != "pw" and common.decrypt_secret(stored["password_enc"]) == "pw"

    # Adding the same address again refreshes it instead of duplicating.
    again = _run(ex.connect_mailbox(ex.ConnectMailboxIn(email="accounts@zoho.in", password="pw2"), current_user=admin))
    assert again["id"] == out["id"]
    assert _run(raw[common.SENDERS].count_documents({"from_email": "accounts@zoho.in"})) == 1
    resolved = _run(mailer.resolve_sender("c1", out["id"]))
    assert resolved.kind == "smtp" and resolved.smtp["password"] == "pw2"


class _FakeRequest:
    def __init__(self, host="tasko-commercial-backend.onrender.com"):
        self.headers = {"host": host, "x-forwarded-proto": "https", "origin": "https://app.example"}


def _ms_transport(*, scope="Mail.Send User.Read offline_access", email="owner@prodigist.onmicrosoft.com"):
    def handler(request: httpx.Request):
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "AT", "refresh_token": "RT", "scope": scope, "expires_in": 3600})
        if request.url.path.endswith("/me"):
            return httpx.Response(200, json={"mail": email, "displayName": "Owner"})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


def _patch_httpx(monkeypatch, transport):
    real = httpx.AsyncClient

    def factory(*a, **k):
        k["transport"] = transport
        return real(*a, **k)

    monkeypatch.setattr(mail_connect.httpx, "AsyncClient", factory)


def test_microsoft_sign_in_adds_mailmaster_sender(env, monkeypatch):
    raw, admin = env
    url = _run(ex.start_microsoft_sender(ex.GoogleStartIn(return_path="/engagex/mailmaster?tab=senders"), _FakeRequest(), current_user=admin))["auth_url"]
    assert url.startswith("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?")
    assert "Mail.Send" in url and "redirect_uri=https%3A%2F%2Ftasko-commercial-backend.onrender.com%2Fapi%2Femail%2Foauth%2Fmicrosoft%2Fcallback" in url
    state = _run(raw[mail_connect.MS_STATES].find_one({}))["state"]
    assert state.startswith("exm.")

    _patch_httpx(monkeypatch, _ms_transport())
    from backend.mail_connect_routes import microsoft_mail_callback

    res = _run(microsoft_mail_callback(_FakeRequest(), code="CODE", state=state, error=None, error_description=None))
    assert res.status_code == 302 and "microsoft=connected" in res.headers["location"]
    assert res.headers["location"].startswith("https://app.example/engagex/mailmaster?tab=senders")
    sender = _run(raw[common.SENDERS].find_one({"kind": "microsoft"}))
    assert sender["from_email"] == "owner@prodigist.onmicrosoft.com" and common.decrypt_secret(sender["refresh_token_enc"]) == "RT"
    resolved = _run(mailer.resolve_sender("c1", sender["id"]))
    session = mailer.open_session(resolved)
    assert isinstance(session, mail_connect.GraphSession)
    _run(session.close())

    # State is single-use.
    again = _run(microsoft_mail_callback(_FakeRequest(), code="CODE", state=state, error=None, error_description=None))
    assert "microsoft=error" in again.headers["location"]


def test_microsoft_sign_in_requires_send_permission(env, monkeypatch):
    raw, admin = env
    _run(ex.start_microsoft_sender(ex.GoogleStartIn(), _FakeRequest(), current_user=admin))
    state = _run(raw[mail_connect.MS_STATES].find_one({}))["state"]
    _patch_httpx(monkeypatch, _ms_transport(scope="User.Read offline_access"))
    from backend.mail_connect_routes import microsoft_mail_callback

    res = _run(microsoft_mail_callback(_FakeRequest(), code="CODE", state=state, error=None, error_description=None))
    assert "microsoft=error" in res.headers["location"] and _run(raw[common.SENDERS].count_documents({})) == 0


def test_microsoft_not_configured_explains_alternative(env, monkeypatch):
    _, admin = env
    monkeypatch.delenv("MICROSOFT_CLIENT_ID")
    with pytest.raises(HTTPException) as exc:
        _run(ex.start_microsoft_sender(ex.GoogleStartIn(), _FakeRequest(), current_user=admin))
    assert exc.value.status_code == 503 and "Other email" in exc.value.detail


def test_graph_session_sends_mime_and_stores_rotated_token(monkeypatch):
    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "id")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "secret")
    sent, rotated = [], []

    def handler(request: httpx.Request):
        if request.url.path.endswith("/token"):
            return httpx.Response(200, json={"access_token": "AT", "refresh_token": "RT2", "expires_in": 3600})
        sent.append((request.headers["authorization"], request.headers["content-type"], request.content))
        return httpx.Response(202)

    async def on_rotate(token):
        rotated.append(token)

    async def go():
        session = mail_connect.GraphSession("RT1", on_rotate=on_rotate, transport=httpx.MockTransport(handler))
        await session.send("a@x.com", "b@y.com", "Subject: hi\r\n\r\nbody")
        await session.close()

    _run(go())
    assert rotated == ["RT2"]
    assert sent[0][0] == "Bearer AT" and sent[0][1] == "text/plain"
    assert base64.b64decode(sent[0][2]).startswith(b"Subject: hi")


# ── Platform email service ───────────────────────────────────────────────────
@pytest.fixture
def platform(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    import backend.email_service.service as svc

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["platform_connect_test"]
    monkeypatch.setattr(svc, "db", raw)
    from backend import dependencies as dep

    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setenv("MICROSOFT_CLIENT_ID", "ms-client")
    monkeypatch.setenv("MICROSOFT_CLIENT_SECRET", "ms-secret")
    return svc.CentralEmailService(), raw, svc


def test_platform_service_connects_microsoft_account(platform, monkeypatch):
    service, raw, svc = platform
    monkeypatch.setattr(svc, "email_service", service)
    url = _run(mail_connect.microsoft_start(_FakeRequest(), prefix="pes.", company_id="", user_id="owner",
                                            return_url="https://app.example/master-console?tab=email-config"))
    assert "login.microsoftonline.com" in url
    state = _run(raw[mail_connect.MS_STATES].find_one({}))["state"]
    _patch_httpx(monkeypatch, _ms_transport(email="alerts@prodigist.in"))
    from backend.mail_connect_routes import microsoft_mail_callback

    res = _run(microsoft_mail_callback(_FakeRequest(), code="CODE", state=state, error=None, error_description=None))
    assert res.headers["location"].startswith("https://app.example/master-console?tab=email-config&microsoft=connected")
    masked = _run(service.get_masked_config())
    assert masked["provider_type"] == "microsoft_oauth" and masked["from_email"] == "alerts@prodigist.in"
    assert masked["connected_account"]["kind"] == "microsoft"
    provider = _run(service.get_provider())
    assert provider.__class__.__name__ == "ConnectedAccountProvider" and provider.refresh_token == "RT"

    masked = _run(service.disconnect_account())
    assert masked["provider_type"] == "smtp" and masked["connected_account"] is None


def test_platform_service_password_connect_and_send_via_google(platform, monkeypatch):
    service, raw, _ = platform
    masked = _run(service.save_connected_account(
        "smtp", email="alerts@zoho.in", password="pw",
        smtp={"host": "smtp.zoho.in", "port": 465, "security": "ssl", "username": "alerts@zoho.in", "provider_label": "Zoho Mail"}))
    assert (masked["smtp_host"], masked["smtp_port"], masked["smtp_use_ssl"], masked["smtp_use_tls"]) == ("smtp.zoho.in", 465, True, False)
    assert masked["connected_account"] == {"kind": "password", "email": "alerts@zoho.in", "provider_label": "Zoho Mail",
                                           "connected_at": masked["connected_account"]["connected_at"]}

    _run(service.save_connected_account("google_oauth", email="owner@gmail.com", refresh_token="GRT"))
    provider = _run(service.get_provider())
    sent = []

    class FakeGmail:
        def __init__(self, token): self.token = token
        async def send(self, f, t, message): sent.append((self.token, f, t, message))
        async def close(self): pass

    import backend.engagex.google_sender as gs

    monkeypatch.setattr(gs, "GmailSession", FakeGmail)
    _run(provider.send(to_email="client@x.com", subject="Hello", body_plain="Hi", body_html="<p>Hi</p>", from_name="OneNexa"))
    token, sender, to, message = sent[0]
    assert (token, sender, to) == ("GRT", "owner@gmail.com", "client@x.com")
    assert "From: OneNexa <owner@gmail.com>" in message
