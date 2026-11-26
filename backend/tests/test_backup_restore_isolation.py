"""Backup restore must not let a licensee admin escape its own company.

A backup file is encrypted with a password the uploader chooses, so its
contents are attacker-controlled. These tests replay crafted archives through
the real restore path and check that:
  * a restored user can never carry Platform Owner identity;
  * control-plane collections (licences, app settings, ...) are never written;
  * a restored record never overwrites another company's record;
  * login emails may be shared, so a restored user may use an email that
    another company also uses (sign-in checks each account's password).
"""
import json
import zipfile

import pytest
from bson import json_util
from bson.json_util import CANONICAL_JSON_OPTIONS
from fastapi import HTTPException

import backend.server  # noqa: F401  (composes the full app)
from backend import backup_restore as br
from backend.models import User

TARGET = "company-attacker"
OTHER = "company-victim"


@pytest.fixture
def mongo(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    client = mongomock_motor.AsyncMongoMockClient()
    monkeypatch.setattr(br, "client", client)
    monkeypatch.setattr(br, "_raw_db", lambda: client[br.DB_NAME])
    return client[br.DB_NAME]


def _admin():
    return User(id="admin-a", email="admin@attacker.example", role="admin",
                full_name="Attacker Admin", company_id=TARGET)


def _archive(tmp_path, collections: dict[str, list[dict]]):
    path = tmp_path / "crafted.zip"
    manifest = {
        "format": "taskosphere-backup",
        "version": br.FORMAT_VERSION,
        "scope": "single_customer_tenant",
        "source_company_id": "company-source",
        "owner_user_id": "admin-source",
        "collections": {name: {"safe_name": name} for name in collections},
    }
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, docs in collections.items():
            lines = "\n".join(json_util.dumps(d, json_options=CANONICAL_JSON_OPTIONS) for d in docs)
            archive.writestr(f"collections/{name}.jsonl", lines)
    return str(path)


async def _seed(raw):
    await raw.companies.insert_one({"id": TARGET, "name": "Attacker Co", "license_id": "lic-a", "status": "active"})
    await raw.companies.insert_one({"id": OTHER, "name": "Victim Co"})
    await raw.users.insert_one({"id": "admin-a", "email": "admin@attacker.example", "role": "admin",
                                "company_id": TARGET, "password": "live-hash"})
    await raw.users.insert_one({"id": "victim-user", "email": "boss@victim.example", "role": "admin",
                                "company_id": OTHER, "password": "victim-hash"})
    await raw.invoices.insert_one({"id": "inv-victim", "company_id": OTHER, "total": 100})
    await raw.commercial_licenses.insert_one({"id": "lic-a", "customer_id": "cus-a", "max_users": 5})


async def _run(tmp_path, collections):
    zip_path = _archive(tmp_path, collections)
    manifest, entries = await br._read_archive(zip_path)
    allowed, skipped = br._split_restorable(entries)
    result = await br._restore(manifest, allowed, _admin(), zip_path)
    return result, skipped


@pytest.mark.asyncio
async def test_restored_user_cannot_become_platform_owner(mongo, tmp_path):
    await _seed(mongo)
    for crafted in (
        {"id": "evil-1", "email": "evil@attacker.example", "is_platform_owner": True, "status": "active"},
        {"id": "evil-2", "email": "admin@taskosphere.com", "status": "active"},
        {"id": "evil-3", "email": "evil3@attacker.example", "role": "superadmin"},
        {"id": "evil-4", "email": "evil4@attacker.example", "platform_owner_uid": "PO-1"},
    ):
        with pytest.raises(HTTPException) as exc:
            await _run(tmp_path, {"users": [crafted]})
        assert exc.value.status_code == 400
        assert await mongo.users.find_one({"id": crafted["id"]}) is None
    # The live admin record survived the failed restores untouched.
    live = await mongo.users.find_one({"id": "admin-a"})
    assert live["password"] == "live-hash" and live["company_id"] == TARGET


@pytest.mark.asyncio
async def test_control_plane_collections_are_never_restored(mongo, tmp_path):
    await _seed(mongo)
    result, skipped = await _run(tmp_path, {
        "invoices": [{"id": "inv-new", "total": 5}],
        "commercial_licenses": [{"id": "lic-a", "customer_id": "cus-a", "max_users": 99999}],
        "app_settings": [{"_id": "google_drive", "refresh_token": "attacker-token"}],
        "session_manager": [{"session_token": "forged", "status": "active"}],
    })
    assert set(skipped) == {"commercial_licenses", "app_settings", "session_manager"}
    assert (await mongo.commercial_licenses.find_one({"id": "lic-a"}))["max_users"] == 5
    assert await mongo.app_settings.find_one({"_id": "google_drive"}) is None
    assert await mongo.session_manager.find_one({"session_token": "forged"}) is None
    assert (await mongo.invoices.find_one({"id": "inv-new"}))["company_id"] == TARGET


@pytest.mark.asyncio
async def test_restore_never_overwrites_another_companys_records(mongo, tmp_path):
    await _seed(mongo)
    victim_user = await mongo.users.find_one({"id": "victim-user"})
    victim_invoice = await mongo.invoices.find_one({"id": "inv-victim"})
    result, _ = await _run(tmp_path, {
        "users": [
            {"_id": victim_user["_id"], "id": "victim-user", "email": "boss@victim.example",
             "role": "admin", "password": "attacker-hash", "status": "active"},
            {"id": "dup-email", "email": "boss@victim.example", "password": "x"},
            {"id": "staff-1", "email": "staff@attacker.example", "role": "admin",
             "licensed_modules": ["everything"], "status": "active"},
        ],
        "invoices": [{"_id": victim_invoice["_id"], "id": "inv-victim", "total": 0}],
    })
    still = await mongo.users.find_one({"id": "victim-user"})
    assert still["password"] == "victim-hash" and still["company_id"] == OTHER
    shared = await mongo.users.find_one({"id": "dup-email"})
    assert shared["company_id"] == TARGET  # shared login email allowed, own company only
    assert result["skipped_conflicting_users"] == 1

    victim_rows = await mongo.invoices.find({"company_id": OTHER}).to_list(10)
    assert [row["total"] for row in victim_rows] == [100]
    attacker_rows = await mongo.invoices.find({"company_id": TARGET}).to_list(10)
    assert [row["total"] for row in attacker_rows] == [0]
    assert attacker_rows[0]["_id"] != victim_invoice["_id"]

    staff = await mongo.users.find_one({"id": "staff-1"})
    assert staff["company_id"] == TARGET and "licensed_modules" not in staff
    assert staff["license_id"] == "lic-a"


@pytest.mark.asyncio
async def test_company_registry_fields_keep_live_values(mongo, tmp_path):
    await _seed(mongo)
    await _run(tmp_path, {"companies": [{"id": "company-source", "name": "Renamed",
                                           "license_id": "lic-forged", "status": "suspended",
                                           "tenant_database_name": "tenant_victim"}]})
    company = await mongo.companies.find_one({"id": TARGET})
    assert company["name"] == "Renamed"
    assert company["license_id"] == "lic-a"
    assert company["status"] == "active"
    assert "tenant_database_name" not in company
