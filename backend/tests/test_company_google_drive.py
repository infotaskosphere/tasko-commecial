"""Each organisation connects and uses its OWN Google Drive.

Covers: request routing to the right Drive, the connect/callback flow with a
one-time state, the disabled legacy start URL, invoice folders, and the
client-portal "file must be inside the client's folder" rule.
"""
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import backend.run as run_module
from backend import company_drive, dependencies
from backend import google_drive_service as gds
from backend import invoicing
from backend.client_portal import _is_within_folder_sync
from backend.models import User
from backend.tenant_runtime import reset_authenticated_company, set_authenticated_company


# ── fake Google Drive ─────────────────────────────────────────────────────────
class _Call:
    def __init__(self, fn):
        self._fn = fn

    def execute(self):
        return self._fn()


class FakeDrive:
    def __init__(self, email="owner@licensee.example", items=None):
        self.email = email
        self.items = dict(items or {})  # id -> {"parents": [...], "mimeType": ...}
        self.created = []

    def files(self):
        drive = self

        class _Files:
            def create(self, body, fields=None):
                def run():
                    new_id = f"f{len(drive.items) + 1}"
                    drive.items[new_id] = {"parents": body.get("parents", []), "mimeType": body.get("mimeType"), "name": body["name"]}
                    drive.created.append(body["name"])
                    return {"id": new_id}
                return _Call(run)

            def get(self, fileId, fields=None, supportsAllDrives=None):
                def run():
                    if fileId not in drive.items:
                        raise RuntimeError("404")
                    return {"id": fileId, "trashed": False, **drive.items[fileId]}
                return _Call(run)
        return _Files()

    def about(self):
        drive = self

        class _About:
            def get(self, fields=None):
                return _Call(lambda: {"user": {"emailAddress": drive.email, "displayName": "Licensee Owner"}})
        return _About()


def _scope(company_id):
    return set_authenticated_company(company_id)


@pytest.fixture
def states(monkeypatch):
    table = {}
    monkeypatch.setattr(gds, "_company_state_loader", lambda cid: table.get(cid, {"connection": None, "licensee": True}))
    gds.invalidate_company_drive(None)
    yield table
    gds.invalidate_company_drive(None)


# ── routing ───────────────────────────────────────────────────────────────────
def test_unconnected_licensee_never_uses_the_platform_drive(states, monkeypatch):
    monkeypatch.setattr(gds, "_platform_get_drive_service", lambda: pytest.fail("platform Drive used for a licensee"))
    monkeypatch.setattr(gds, "_platform_drive_configured", lambda: True)
    token = _scope("company-licensee")
    try:
        assert gds._drive_configured() is False
        assert gds.drive_folder_id("invoices") is None
        with pytest.raises(HTTPException) as exc:
            gds._get_drive_service()
        assert exc.value.status_code == 503 and "not connected" in exc.value.detail
        with pytest.raises(HTTPException):
            invoicing.DRIVE_FOLDERS["invoices"]
    finally:
        reset_authenticated_company(token)


def test_connected_licensee_uses_its_own_account_and_folders(states, monkeypatch):
    built = []
    monkeypatch.setattr(gds, "build_company_drive_service", lambda refresh: built.append(refresh) or FakeDrive())
    states["company-a"] = {"licensee": True, "connection": {
        "status": "connected", "refresh_token_enc": gds.encrypt_drive_token("refresh-A"),
        "folders": {"root": "rootA", "invoices": "invA", "clients": "cliA"}}}
    states["company-b"] = {"licensee": True, "connection": {
        "status": "connected", "refresh_token_enc": gds.encrypt_drive_token("refresh-B"),
        "folders": {"root": "rootB", "invoices": "invB"}}}
    token = _scope("company-a")
    try:
        assert gds._drive_configured() is True
        gds._get_drive_service()
        gds.get_drive_service_for_file("anything")  # cached client, no rebuild
        assert invoicing.DRIVE_FOLDERS["invoices"] == "invA"
        assert gds.drive_folder_id("clients") == "cliA"
    finally:
        reset_authenticated_company(token)
    token = _scope("company-b")
    try:
        gds._get_drive_service()
        assert invoicing.DRIVE_FOLDERS.get("invoices") == "invB"
    finally:
        reset_authenticated_company(token)
    assert built == ["refresh-A", "refresh-B"]


def test_platform_workspace_keeps_the_original_drive(states, monkeypatch):
    sentinel = object()
    monkeypatch.setattr(gds, "_platform_get_drive_service", lambda: sentinel)
    states["owner-company"] = {"licensee": False, "connection": None}
    token = _scope("owner-company")
    try:
        assert gds._get_drive_service() is sentinel
        assert invoicing.DRIVE_FOLDERS["invoices"] == gds.LEGACY_PLATFORM_FOLDERS["invoices"]
    finally:
        reset_authenticated_company(token)


def test_unreadable_connection_state_fails_closed(monkeypatch):
    def boom(_cid):
        raise RuntimeError("db down")
    monkeypatch.setattr(gds, "_company_state_loader", boom)
    monkeypatch.setattr(gds, "_platform_drive_configured", lambda: True)
    gds.invalidate_company_drive(None)
    token = _scope("company-x")
    try:
        assert gds._drive_configured() is False
    finally:
        reset_authenticated_company(token)
        gds.invalidate_company_drive(None)


# ── connect / callback flow ───────────────────────────────────────────────────
@pytest.fixture
def mongo(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["drive_test"]
    monkeypatch.setattr(dependencies, "_raw_db", raw)
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-id.apps.googleusercontent.com")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "client-secret")
    monkeypatch.setenv("FRONTEND_URL", "https://app.example.com")
    return raw


def _user(role="admin", company="company-a"):
    return User(id=f"{role}-1", email=f"{role}@licensee.example", role=role, full_name=role, company_id=company)


def test_legacy_unauthenticated_start_url_is_disabled():
    client = TestClient(run_module.app)
    response = client.get("/auth/google", follow_redirects=False)
    assert response.status_code == 410


@pytest.mark.asyncio
async def test_callback_rejects_unknown_state_and_stores_nothing(mongo):
    client = TestClient(run_module.app)
    for state in ("", "forged", "drv.forged"):
        response = client.get(f"/auth/google/callback?code=abc&state={state}", follow_redirects=False)
        assert response.status_code == 302
        assert "drive=error" in response.headers["location"]
    assert await mongo[company_drive.COMPANY_DRIVE_COLLECTION].count_documents({}) == 0
    assert await mongo.app_settings.count_documents({}) == 0


@pytest.mark.asyncio
async def test_only_admins_can_start_a_connection(mongo):
    from starlette.requests import Request

    request = Request({"type": "http", "headers": [], "method": "POST", "path": "/"})
    with pytest.raises(HTTPException) as exc:
        await company_drive.drive_connect(request, {}, _user(role="staff"))
    assert exc.value.status_code == 403


@pytest.mark.asyncio
async def test_full_connect_flow_creates_folders_in_the_licensees_drive(mongo, monkeypatch):
    from starlette.requests import Request

    await mongo.companies.insert_one({"id": "company-a", "name": "Acme Advisors"})
    request = Request({"type": "http", "headers": [], "method": "POST", "path": "/"})
    started = await company_drive.drive_connect(request, {"return_url": "https://evil.example/steal"}, _user())
    auth_url = urlparse(started["auth_url"])
    query = parse_qs(auth_url.query)
    state = query["state"][0]
    assert auth_url.netloc == "accounts.google.com"
    assert state.startswith("drv.")
    assert query["scope"] == ["https://www.googleapis.com/auth/drive.file"]
    saved = await mongo[company_drive.STATE_COLLECTION].find_one({"state": state})
    assert saved["company_id"] == "company-a"
    assert saved["return_url"] == "https://app.example.com/settings/general"  # foreign origin refused

    fake = FakeDrive()

    class _Creds:
        refresh_token = "refresh-from-google"

    def fake_fetch(self, code):
        assert code == "auth-code"
        self.oauth2session.token = {"access_token": "x"}

    monkeypatch.setattr("google_auth_oauthlib.flow.Flow.fetch_token", fake_fetch)
    monkeypatch.setattr("google_auth_oauthlib.flow.Flow.credentials", property(lambda self: _Creds()))
    monkeypatch.setattr(company_drive, "build_company_drive_service", lambda token: fake)

    client = TestClient(run_module.app)
    response = client.get(f"/auth/google/callback?code=auth-code&state={state}", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == "https://app.example.com/settings/general?drive=connected"

    connection = await mongo[company_drive.COMPANY_DRIVE_COLLECTION].find_one({"company_id": "company-a"})
    assert connection["status"] == "connected"
    assert connection["google_email"] == "owner@licensee.example"
    assert gds.decrypt_drive_token(connection["refresh_token_enc"]) == "refresh-from-google"
    assert "refresh-from-google" not in str(connection["refresh_token_enc"])
    assert set(connection["folders"]) == {"root", "invoices", "payments", "credit_notes", "backups", "clients"}
    assert fake.created[0] == "OneNexa – Acme Advisors"
    # The state is single-use.
    again = client.get(f"/auth/google/callback?code=auth-code&state={state}", follow_redirects=False)
    assert "drive=error" in again.headers["location"]

    status = await company_drive.drive_status(_user())
    assert status["connected"] and status["google_email"] == "owner@licensee.example"
    assert status["folder_url"].endswith(connection["folders"]["root"])

    other = await company_drive.drive_status(_user(company="company-b"))
    assert other["connected"] is False


# ── client portal: files must be inside the client's folder ───────────────────
def test_portal_file_must_live_under_the_clients_folder():
    drive = FakeDrive(items={
        "clientRoot": {"parents": ["clients"], "mimeType": "application/vnd.google-apps.folder"},
        "sub": {"parents": ["clientRoot"], "mimeType": "application/vnd.google-apps.folder"},
        "mine.pdf": {"parents": ["sub"], "mimeType": "application/pdf"},
        "otherRoot": {"parents": ["clients"], "mimeType": "application/vnd.google-apps.folder"},
        "theirs.pdf": {"parents": ["otherRoot"], "mimeType": "application/pdf"},
    })
    assert _is_within_folder_sync(drive, "mine.pdf", "clientRoot") is True
    assert _is_within_folder_sync(drive, "clientRoot", "clientRoot") is True
    assert _is_within_folder_sync(drive, "theirs.pdf", "clientRoot") is False
    assert _is_within_folder_sync(drive, "missing", "clientRoot") is False
