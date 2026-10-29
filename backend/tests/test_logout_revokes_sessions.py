"""Logging out must end every credential of that login.

Before: the JWT of a Platform Owner login, the opaque session token of any
password login, and both credentials of SaaS (scrypt) accounts kept working
after logout.
"""
import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import jwt
import pytest
from bson import ObjectId

import backend.server  # noqa: F401
from backend import dependencies
from backend.security import session_manager as sm


@pytest.fixture
def raw(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    db = mongomock_motor.AsyncMongoMockClient()["logout_test"]
    monkeypatch.setattr(sm, "_raw_db", lambda: db)
    return db


def _jwt(**claims):
    return jwt.encode({"sub": "u1", "exp": 4102444800, **claims}, dependencies.JWT_SECRET, algorithm=dependencies.ALGORITHM)


USER = SimpleNamespace(id="u1", email="u1@example.com")
LATER = (datetime.now(timezone.utc) + timedelta(hours=8)).isoformat()


@pytest.mark.parametrize("record,expected", [
    ({"status": "active", "expires_at": LATER}, True),
    ({"status": "revoked", "expires_at": LATER}, False),
    ({"status": "replaced", "expires_at": LATER}, False),
    ({"status": "active", "expires_at": (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()}, False),
    (None, False),
])
def test_jwt_with_session_id_follows_its_session(raw, record, expected):
    if record is not None:
        asyncio.run(raw.session_manager.insert_one({"session_token": "sid-1", "user_id": "u1", **record}))
    assert asyncio.run(sm.jwt_session_is_live(USER, _jwt(sid="sid-1"))) is expected


def test_tokens_without_session_id_are_not_affected(raw):
    assert asyncio.run(sm.jwt_session_is_live(USER, _jwt())) is True
    assert asyncio.run(sm.jwt_session_is_live(USER, "opaque-session-token")) is True


def test_logout_revokes_both_session_stores(raw):
    oid = ObjectId()
    token = "sess-abc"
    asyncio.run(raw.users.insert_one({"_id": oid, "id": "u1"}))
    asyncio.run(raw.session_manager.insert_one({"session_token": token, "user_id": "u1", "status": "active"}))
    asyncio.run(raw.sessions.insert_one({"token_hash": hashlib.sha256(token.encode()).hexdigest(), "user_id": oid, "status": "active"}))

    assert asyncio.run(sm.SessionManager.revoke_session(token, expected_user_id="u1")) is True
    assert asyncio.run(raw.session_manager.find_one({}))["status"] == "revoked"
    assert asyncio.run(raw.sessions.find_one({}))["status"] == "revoked"


def test_logout_cannot_revoke_someone_elses_session(raw):
    token = "sess-other"
    asyncio.run(raw.session_manager.insert_one({"session_token": token, "user_id": "u2", "status": "active"}))
    asyncio.run(raw.sessions.insert_one({"token_hash": hashlib.sha256(token.encode()).hexdigest(), "user_id": "u2", "status": "active"}))

    assert asyncio.run(sm.SessionManager.revoke_session(token, expected_user_id="u1")) is False
    assert asyncio.run(raw.session_manager.find_one({}))["status"] == "active"
    assert asyncio.run(raw.sessions.find_one({}))["status"] == "active"


def test_owner_opaque_session_is_rejected_once_revoked(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import platform_owner_sessions

    db = mongomock_motor.AsyncMongoMockClient()["owner_logout"]
    monkeypatch.setattr(dependencies, "_raw_db", db)
    monkeypatch.setattr(dependencies, "MONGO_URL", "mongodb://test")
    token = "owner-opaque"
    asyncio.run(db.users.insert_one({"_id": ObjectId(), "id": "owner", "email": "admin@taskosphere.com", "status": "active"}))
    user = asyncio.run(db.users.find_one({}))
    asyncio.run(db.sessions.insert_one({
        "token_hash": hashlib.sha256(token.encode()).hexdigest(), "user_id": user["_id"],
        "status": "revoked", "expires_at": datetime.now(timezone.utc) + timedelta(hours=8),
    }))
    assert asyncio.run(platform_owner_sessions.owner_aware_saas_session_user(token)) is None


def test_revoke_all_covers_mongo_id_and_statusless_sessions(raw):
    oid = ObjectId()
    asyncio.run(raw.users.insert_one({"_id": oid, "id": "u1"}))
    asyncio.run(raw.session_manager.insert_one({"session_token": "a", "user_id": "u1", "status": "active"}))
    asyncio.run(raw.sessions.insert_many([
        {"token_hash": "h1", "user_id": oid, "status": "active"},
        {"token_hash": "h2", "user_id": str(oid)},
        {"token_hash": "h3", "user_id": "someone-else", "status": "active"},
    ]))
    assert asyncio.run(sm.SessionManager.revoke_all_user_sessions("u1", reason="password_changed")) == 3
    states = {d["token_hash"]: d.get("status") for d in asyncio.run(raw.sessions.find({}).to_list(10))}
    assert states == {"h1": "revoked", "h2": "revoked", "h3": "active"}


def test_password_reset_no_longer_calls_a_missing_method():
    from pathlib import Path
    source = (Path(__file__).resolve().parents[1] / "auth_password_reset.py").read_text(encoding="utf-8")
    assert "on_password_reset_success" not in source
    assert "revoke_all_user_sessions" in source
