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
