"""Shared login emails, the account chooser, and extra sign-in emails."""
import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from passlib.context import CryptContext

import backend.run as run_module
from backend import dependencies, login_accounts

PWD = CryptContext(schemes=["bcrypt"], deprecated="auto")


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import auth_password_reset
    from backend.server_modules.routes import auth_routes
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["login_test"]
    tenant_db = TenantAwareDatabase(raw, mongo_client=client)
    monkeypatch.setattr(dependencies, "_raw_db", raw)
    monkeypatch.setattr(dependencies, "db", tenant_db)
    monkeypatch.setattr(auth_routes, "db", tenant_db)
    monkeypatch.setattr(auth_password_reset, "db", tenant_db)

    async def no_limit(*a, **k):
        return None

    monkeypatch.setattr(auth_routes, "_enforce_auth_rate_limit", no_limit)
    monkeypatch.setattr(auth_routes, "_sync_saas_bootstrap_password", no_limit)
    return raw


def _run(coro):
    return asyncio.run(coro)


def _user(uid, email, company, password="Correct-Horse-9", **extra):
    return {"id": uid, "email": email, "email_normalized": email, "full_name": uid.title(), "role": "staff",
            "status": "active", "company_id": company, "password": PWD.hash(password),
            "created_at": "2026-01-01T00:00:00+00:00", **extra}


async def _seed(raw):
    await raw.companies.insert_many([{"id": "co-a", "name": "Acme Advisors"}, {"id": "co-b", "name": "Beta & Co"}])
    await raw.users.insert_many([
        _user("anita-a", "anita@ca.example", "co-a"),
        _user("anita-b", "anita@ca.example", "co-b"),
        _user("front-1", "frontdesk@acme.example", "co-a"),
        _user("front-2", "frontdesk@acme.example", "co-a", password="Other-Pass-77"),
        _user("ravi", "ravi@acme.example", "co-a", login_emails=["ravi.personal@mail.example"]),
    ])


UA = {"user-agent": "pytest-browser"}


def test_same_email_in_two_organisations_shows_the_chooser(env):
    _run(_seed(env))
    client = TestClient(run_module.app)
    res = client.post("/api/auth/login", json={"email": "anita@ca.example", "password": "Correct-Horse-9"}, headers=UA)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["requires_account_choice"] is True and "access_token" not in body
    assert sorted(a["organisation"] for a in body["accounts"]) == ["Acme Advisors", "Beta & Co"]

    # Choosing an account that was not offered is refused; the code is then used up.
    bad = client.post("/api/auth/login/choose", json={"choice_token": body["choice_token"], "user_id": "ravi"}, headers=UA)
    assert bad.status_code == 403
    again = client.post("/api/auth/login/choose", json={"choice_token": body["choice_token"], "user_id": "anita-b"}, headers=UA)
    assert again.status_code == 401

    res = client.post("/api/auth/login", json={"email": "anita@ca.example", "password": "Correct-Horse-9"}, headers=UA)
    token = res.json()["choice_token"]
    other_device = client.post("/api/auth/login/choose", json={"choice_token": token, "user_id": "anita-b"},
                               headers={"user-agent": "someone-else"})
    assert other_device.status_code == 401  # bound to the browser that signed in

    res = client.post("/api/auth/login", json={"email": "anita@ca.example", "password": "Correct-Horse-9"}, headers=UA)
    chosen = client.post("/api/auth/login/choose", json={"choice_token": res.json()["choice_token"], "user_id": "anita-b"}, headers=UA)
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["access_token"] and chosen.json()["user"]["id"] == "anita-b"


def test_shared_email_in_one_organisation_signs_in_the_account_whose_password_matches(env):
    _run(_seed(env))
    client = TestClient(run_module.app)
    res = client.post("/api/auth/login", json={"email": "frontdesk@acme.example", "password": "Other-Pass-77"}, headers=UA)
    assert res.status_code == 200 and res.json()["user"]["id"] == "front-2"
    wrong = client.post("/api/auth/login", json={"email": "frontdesk@acme.example", "password": "nope-nope-nope"}, headers=UA)
    assert wrong.status_code == 401


def test_extra_sign_in_email_works(env):
    _run(_seed(env))
    client = TestClient(run_module.app)
    res = client.post("/api/auth/login", json={"email": "Ravi.Personal@mail.example", "password": "Correct-Horse-9"}, headers=UA)
    assert res.status_code == 200 and res.json()["user"]["id"] == "ravi"


def test_adding_a_sign_in_email_needs_the_emailed_code(env, monkeypatch):
    _run(_seed(env))
    sent = {}

    class FakeService:
        async def send_email(self, *, to_email, body_plain, **kw):
            sent["to"] = to_email
            sent["code"] = body_plain.split("is: ")[1][:6]
            return True

    import backend.email_service.service as svc

    monkeypatch.setattr(svc, "email_service", FakeService())
    db = dependencies.db
    ravi = _run(env.users.find_one({"id": "ravi"}))
    _run(login_accounts.start_add_login_email(db, ravi, "ravi@work2.example"))
    assert sent["to"] == "ravi@work2.example"
    with pytest.raises(HTTPException):
        _run(login_accounts.confirm_add_login_email(db, ravi, "ravi@work2.example", "000000" if sent["code"] != "000000" else "111111"))
    emails = _run(login_accounts.confirm_add_login_email(db, ravi, "ravi@work2.example", sent["code"]))
    assert "ravi@work2.example" in emails
    with pytest.raises(HTTPException) as exc:
        _run(login_accounts.start_add_login_email(db, ravi, "admin@taskosphere.com"))
    assert exc.value.status_code == 409


def test_reserved_owner_emails_cannot_be_used_by_other_accounts():
    with pytest.raises(HTTPException) as exc:
        login_accounts.assert_login_email_allowed("admin@taskosphere.com")
    assert exc.value.status_code == 409
    assert login_accounts.assert_login_email_allowed("Someone@Firm.example") == "someone@firm.example"


def test_password_reset_updates_every_account_with_that_email(env):
    from datetime import datetime, timedelta, timezone

    from backend import auth_password_reset as apr

    _run(_seed(env))
    _run(env.password_reset_tokens.insert_one({
        "email": "anita@ca.example", "token_hash": apr._hash_reset_token("123456"),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}))
    client = TestClient(run_module.app)
    res = client.post("/api/auth/reset-password",
                      json={"email": "anita@ca.example", "token": "123456", "new_password": "Brand-New-Pass-2026"}, headers=UA)
    assert res.status_code == 200, res.text
    for uid in ("anita-a", "anita-b"):
        doc = _run(env.users.find_one({"id": uid}))
        assert PWD.verify("Brand-New-Pass-2026", doc["password"])
    other = _run(env.users.find_one({"id": "ravi"}))
    assert PWD.verify("Correct-Horse-9", other["password"])
