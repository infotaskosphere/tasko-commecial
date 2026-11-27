"""Gmail inbox connect must file the account under the request's organisation.

The raw user record can carry a different company_id than the one the request
is scoped to; the Email Accounts list reads the request's organisation, so the
connect flow has to store that one too.
"""
import asyncio
import types

import pytest

import backend.server  # noqa: F401
from backend import email_google_oauth as go
from backend import email_integration as ei
from backend.models import User
from backend.tenant_runtime import (
    TenantAwareDatabase, reset_authenticated_company, set_authenticated_company, set_platform_owner,
)


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["gmail_connect_test"]
    tdb = TenantAwareDatabase(raw, mongo_client=client)
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", tdb)
    monkeypatch.setattr(go, "db", tdb)
    monkeypatch.setattr(ei, "db", tdb)

    class Cred:
        refresh_token = "refresh"
        scopes = ["https://www.googleapis.com/auth/gmail.readonly"]

    class Flow:
        credentials = Cred()

        def fetch_token(self, code):
            return None

    class Gmail:
        def users(self):
            return self

        def getProfile(self, userId):
            return self

        def execute(self):
            return {"emailAddress": "inbox@gmail.com"}

    monkeypatch.setattr(go, "_flow", lambda uri, state=None: Flow())
    monkeypatch.setattr(go, "build", lambda *a, **k: Gmail())
    return raw


def test_connected_inbox_is_listed_when_user_record_company_is_stale(env):
    raw = env
    # Raw user record says "legacy-co"; the request is scoped to "cus-real".
    user = User(id="u1", email="admin@x.example", role="admin", full_name="Admin", company_id="legacy-co")

    async def flow():
        token = set_authenticated_company("cus-real")
        set_platform_owner(False)
        try:
            await go._save_state(state="S1", current_user=user, redirect_uri="https://api/cb",
                                 return_url="https://app/settings/email", linked_page="all",
                                 auto_sync=False, label=None)
        finally:
            reset_authenticated_company(token)

        request = types.SimpleNamespace(query_params={})
        response = await go.google_gmail_oauth_callback_with_saved_context(request, code="c", state="S1", error=None)
        assert "gmail_oauth=connected" in response.headers["location"]

        token = set_authenticated_company("cus-real")
        try:
            listed = await ei.list_connections(current_user=user)
        finally:
            reset_authenticated_company(token)
        return listed

    listed = asyncio.run(flow())
    assert [c.email_address for c in listed["connections"]] == ["inbox@gmail.com"]
    stored = asyncio.run(raw.email_connections.find_one({"email_address": "inbox@gmail.com"}))
    assert stored["company_id"] == "cus-real"


def test_sender_blacklist_saves_and_blocks_senders(env):
    user = User(id="u1", email="admin@x.example", role="admin", full_name="Admin", company_id="cus-real")

    async def flow():
        token = set_authenticated_company("cus-real")
        try:
            empty = await ei.get_sender_blacklist(current_user=user)
            saved = await ei.replace_sender_blacklist(
                body={"senders": [{"email_address": "Spam@Bad.example"}, {"email_address": "@promo.example"},
                                  {"email_address": "spam@bad.example"}, {"email_address": ""}]},
                current_user=user)
            listed = await ei.get_sender_blacklist(current_user=user)
            blocked = await ei._load_sender_blacklist("u1")
        finally:
            reset_authenticated_company(token)
        return empty, saved, listed, blocked

    empty, saved, listed, blocked = asyncio.run(flow())
    assert empty == {"senders": []}
    assert [s["email_address"] for s in listed["senders"]] == ["spam@bad.example", "@promo.example"]
    kept = ei._drop_blacklisted([{"sender_email": "spam@bad.example"}, {"sender_email": "news@promo.example"},
                                 {"sender_email": "client@good.example"}], blocked)
    assert kept == [{"sender_email": "client@good.example"}]


def test_list_brings_in_own_connections_saved_under_another_company(env):
    raw = env
    user = User(id="u1", email="admin@x.example", role="admin", full_name="Admin", company_id="cus-real")

    async def flow():
        await raw.email_connections.insert_many([
            {"user_id": "u1", "company_id": "legacy-co", "email_address": "inbox@gmail.com", "label": "Gmail",
             "imap_host": "gmail-oauth", "imap_port": 443, "provider": "gmail", "auth_type": "google_oauth"},
            {"user_id": "someone-else", "company_id": "legacy-co", "email_address": "other@gmail.com", "label": "x",
             "imap_host": "gmail-oauth", "imap_port": 443},
        ])
        token = set_authenticated_company("cus-real")
        try:
            listed = await ei.list_connections(current_user=user)
        finally:
            reset_authenticated_company(token)
        other = await raw.email_connections.find_one({"email_address": "other@gmail.com"})
        return listed, other

    listed, other = asyncio.run(flow())
    assert [c.email_address for c in listed["connections"]] == ["inbox@gmail.com"]
    assert other["company_id"] == "legacy-co"  # another user's record is untouched


def test_one_google_sign_in_connects_sending_mailbox_and_inbox(env, monkeypatch):
    raw = env
    import backend.engagex.google_sender as gs

    class Creds:
        refresh_token = "R1"
        token = "T1"
        scopes = ["openid", "https://www.googleapis.com/auth/userinfo.email",
                  gs.GMAIL_SEND_SCOPE, gs.GMAIL_READ_SCOPE]

    seen_scopes = []

    class Flow:
        credentials = Creds()
        code_verifier = None

        def authorization_url(self, **kw):
            return "https://accounts.google.com/auth", None

        def fetch_token(self, code):
            return None

    def fake_flow(redirect_uri, state, scopes=None):
        seen_scopes.append(list(scopes or gs.SCOPES))
        return Flow()

    async def fake_email(token):
        return "office@gmail.com"

    async def fake_profile(company_id):
        return {"name": "Acme"}

    monkeypatch.setattr(gs, "_flow", fake_flow)
    monkeypatch.setattr(gs, "_fetch_email", fake_email)
    monkeypatch.setattr(gs, "company_profile", fake_profile)
    import backend.email_google_oauth as go_mod
    monkeypatch.setattr(go_mod, "_redirect_uri", lambda request: "https://api.example/api/email/oauth/google/callback")
    request = types.SimpleNamespace(headers={"host": "api.example"}, query_params={})
    user = types.SimpleNamespace(id="u1")

    async def flow():
        await gs.start(request, user, "cus-real", "/settings/email?tab=organisation", read_inbox=True)
        state = (await raw[gs.STATES].find_one({}))["state"]
        return await gs.handle_callback(request, code="c", state=state, error=None)

    response = asyncio.run(flow())
    assert "google=connected" in response.headers["location"]
    assert gs.GMAIL_READ_SCOPE in seen_scopes[0]
    sender = asyncio.run(raw[gs.SENDERS].find_one({"from_email": "office@gmail.com"}))
    inbox = asyncio.run(raw.email_connections.find_one({"email_address": "office@gmail.com"}))
    assert sender["company_id"] == "cus-real"
    assert inbox["company_id"] == "cus-real" and inbox["user_id"] == "u1" and inbox["auth_type"] == "google_oauth"
