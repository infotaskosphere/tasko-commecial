"""ADMS attendance push endpoints (/iclock/*) accept only registered devices,
and a device can only read or write its own company's data."""
import pytest
from fastapi.testclient import TestClient

import backend.run as run_module
from backend import attendance_identix as ai
from backend import dependencies
from backend.tenant_runtime import TenantAwareDatabase

PUNCH = "7\t2026-11-25 09:55:00\t0\t1\n"


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["identix_test"]
    monkeypatch.setattr(dependencies, "_raw_db", raw)
    monkeypatch.setattr(ai, "db", TenantAwareDatabase(raw, mongo_client=client))
    return raw


async def _seed(raw):
    await raw.identix_devices.insert_one({"id": "dev-a", "serial_number": "SN-A", "company_id": "company-a", "is_active": True, "name": "Front door"})
    await raw.identix_devices.insert_one({"id": "dev-off", "serial_number": "SN-OFF", "company_id": "company-a", "is_active": False})
    await raw.identix_cmd_queue.insert_one({"cmd_id": "c1", "device_serial": "SN-B", "status": "pending", "seq_id": 1,
                                            "cmd_str": "DATA UPDATE USERINFO PIN=7\tName=Victim"})
    for company in ("company-b", "company-a"):
        await raw.users.insert_one({"id": f"user-{company}", "full_name": company, "company_id": company,
                                    "identix_uid": 7, "status": "active"})


@pytest.mark.asyncio
async def test_unregistered_or_inactive_devices_are_rejected(env):
    await _seed(env)
    client = TestClient(run_module.app)
    for path in ("/iclock/cdata?SN=ATTACKER&table=ATTLOG", "/api/identix/iclock/cdata?SN=SN-OFF&table=ATTLOG",
                 "/iclock/cdata.aspx?SN=&table=ATTLOG"):
        response = client.post(path, content=PUNCH)
        assert response.status_code == 403, path
    # A spoofed serial no longer receives another device's command queue.
    response = client.get("/iclock/getrequest?SN=SN-B")
    assert response.status_code == 403
    assert "Victim" not in response.text
    assert await env.identix_attendance.count_documents({}) == 0


@pytest.mark.asyncio
async def test_registered_device_only_matches_its_own_companys_employees(env):
    await _seed(env)
    client = TestClient(run_module.app)
    response = client.post("/iclock/cdata?SN=sn-a&table=ATTLOG", content=PUNCH)
    assert response.status_code == 200
    punches = await env.identix_attendance.find({}).to_list(10)
    assert len(punches) == 1
    assert punches[0]["company_id"] == "company-a"
    assert punches[0]["user_id"] == "user-company-a"


@pytest.mark.asyncio
async def test_serial_shared_by_two_companies_is_refused(env):
    await _seed(env)
    await env.identix_devices.insert_one({"id": "dev-dup", "serial_number": "SN-A", "company_id": "company-b", "is_active": True})
    client = TestClient(run_module.app)
    assert client.post("/iclock/cdata?SN=SN-A&table=ATTLOG", content=PUNCH).status_code == 403


@pytest.mark.asyncio
async def test_serial_cannot_be_registered_by_a_second_company(env):
    await _seed(env)
    assert await ai._serial_registered_elsewhere("sn-a ", "company-b") is True
    assert await ai._serial_registered_elsewhere("SN-A", "company-a") is False
