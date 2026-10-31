"""Taskosphere Agent pairing: connect a computer once, no login in the agent."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

import backend.server  # noqa: F401
from backend import dependencies
from backend import desktop_agent_pairing as pairing


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from bson import ObjectId
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["agent_pair_test"]
    monkeypatch.setattr(dependencies, "_raw_db", raw)
    monkeypatch.setattr(dependencies, "db", TenantAwareDatabase(raw, mongo_client=client))
    oid = ObjectId()
    asyncio.run(raw.users.insert_one({"_id": oid, "id": str(oid), "email": "manthan@prodigist.test", "full_name": "Manthan Desai",
                                      "role": "staff", "company_id": "c1", "status": "active", "is_active": True}))
    user = SimpleNamespace(id=str(oid), role="staff", company_id="c1", full_name="Manthan Desai", email="manthan@prodigist.test")
    return raw, user


def _request(token=""):
    return SimpleNamespace(headers={"authorization": f"Bearer {token}"} if token else {})


def _pair(user, machine="MANTHAN-PC"):
    started = asyncio.run(pairing.pair_start(pairing.PairStartIn(agent_id="a1b2c3d4", machine_name=machine, agent_version="4.2.0")))
    claim = pairing.PairClaimIn(code=started["code"], claim_token=started["claim_token"])
    assert asyncio.run(pairing.pair_claim(claim)) == {"status": "pending"}
    details = asyncio.run(pairing.pair_details(started["code"], _request(), current_user=user))
    assert details["machine_name"] == machine and details["status"] == "pending"
    asyncio.run(pairing.pair_approve(started["code"], _request(), current_user=user))
    return started, claim


def test_full_pairing_hands_the_credential_over_once(env):
    raw, user = env
    _started, claim = _pair(user)
    got = asyncio.run(pairing.pair_claim(claim))
    assert got["status"] == "approved" and got["token"].startswith("tsa_") and got["user_id"] == user.id
    assert asyncio.run(pairing.pair_claim(claim)) == {"status": "pending"}  # not handed out twice
    stored = asyncio.run(raw[pairing.PAIRINGS].find_one({}))
    assert "device_token" not in stored  # the plain credential is gone once claimed
    device = asyncio.run(raw[pairing.DEVICES].find_one({}))
    assert device["token_hash"] != got["token"] and got["token"] not in str(device)


def test_wrong_claim_token_or_code_is_refused(env):
    _raw, user = env
    started, _claim = _pair(user)
    with pytest.raises(HTTPException) as err:
        asyncio.run(pairing.pair_claim(pairing.PairClaimIn(code=started["code"], claim_token="x" * 43)))
    assert err.value.status_code == 404
    with pytest.raises(HTTPException):
        asyncio.run(pairing.pair_details("ZZZZZZZZ", _request(), current_user=user))


def test_device_credential_signs_in_as_the_user_until_revoked(env):
    raw, user = env
    _started, claim = _pair(user)
    token = asyncio.run(pairing.pair_claim(claim))["token"]
    resolved = asyncio.run(dependencies.resolve_token_user(SimpleNamespace(credentials=token)))
    assert str(resolved.id) == user.id and resolved.company_id == "c1"

    devices = asyncio.run(pairing.list_devices(_request(), current_user=user))["devices"]
    assert [d["machine_name"] for d in devices] == ["MANTHAN-PC"] and "token_hash" not in devices[0]
    asyncio.run(pairing.revoke_device(devices[0]["id"], _request(), current_user=user))
    with pytest.raises(HTTPException) as err:
        asyncio.run(dependencies.resolve_token_user(SimpleNamespace(credentials=token)))
    assert err.value.status_code == 401


def test_unknown_or_deactivated_user_credential_is_refused(env):
    raw, user = env
    _started, claim = _pair(user)
    token = asyncio.run(pairing.pair_claim(claim))["token"]
    with pytest.raises(HTTPException):
        asyncio.run(dependencies.resolve_token_user(SimpleNamespace(credentials="tsa_not-a-real-token")))
    asyncio.run(raw.users.update_one({"id": user.id}, {"$set": {"status": "inactive"}}))
    with pytest.raises(HTTPException) as err:
        asyncio.run(dependencies.resolve_token_user(SimpleNamespace(credentials=token)))
    assert err.value.status_code == 401


def test_reconnecting_a_computer_replaces_its_old_credential(env):
    raw, user = env
    _s1, c1 = _pair(user)
    first = asyncio.run(pairing.pair_claim(c1))["token"]
    _s2, c2 = _pair(user)
    asyncio.run(pairing.pair_claim(c2))
    with pytest.raises(HTTPException):
        asyncio.run(dependencies.resolve_token_user(SimpleNamespace(credentials=first)))
    assert asyncio.run(raw[pairing.DEVICES].count_documents({"status": "active"})) == 1


def test_device_credential_cannot_manage_devices(env):
    _raw, user = env
    with pytest.raises(HTTPException) as err:
        asyncio.run(pairing.list_devices(_request("tsa_abc"), current_user=user))
    assert err.value.status_code == 403


def test_guard_limits_device_credentials_to_agent_endpoints():
    app = FastAPI()
    pairing.install_device_token_guard(app)
    for path in ("/api/desktop/activity", "/api/notifications/", "/api/invoices", "/api/desktop/devices"):
        app.add_api_route(path, lambda: {"ok": True}, methods=["GET"])
    client = TestClient(app)
    device = {"Authorization": "Bearer tsa_abc"}
    assert client.get("/api/desktop/activity", headers=device).status_code == 200
    assert client.get("/api/notifications/", headers=device).status_code == 200
    assert client.get("/api/invoices", headers=device).status_code == 403
    assert client.get("/api/desktop/devices", headers=device).status_code == 403
    blocked = client.get("/api/invoices", headers=device)
    assert blocked.json()["detail"] == "This credential is only valid for the Taskosphere Agent."
    # Ordinary sessions are not touched by this guard (the app's own license
    # checks, installed globally by backend.server, may still answer).
    normal = client.get("/api/invoices", headers={"Authorization": "Bearer normal-session"})
    assert normal.json().get("detail") != "This credential is only valid for the Taskosphere Agent."
