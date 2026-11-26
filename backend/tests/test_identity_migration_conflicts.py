"""The organisation-ID migration must not stop at one email conflict.

One email can belong to only one organisation. Before this fix, a single
licensee user whose email already belonged to the Platform Owner (PO-...)
aborted the whole startup migration on every boot, so every licensee after
it never received its organisation ID.
"""
import asyncio

import pytest

import backend.server  # noqa: F401
from backend import identity_hierarchy as ih
from backend import licensing_api


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def raw():
    mongomock_motor = pytest.importorskip("mongomock_motor")
    return mongomock_motor.AsyncMongoMockClient()["identity_test"]


async def _seed(db):
    owner_uid = await ih.ensure_platform_owner_identity(db)
    await db.users.insert_one({"id": "owner-1", "email": "owner@platform.example", "role": "admin",
                               "status": "active", "is_platform_owner": True, "company_id": "platform"})
    await ih.ensure_identity_email_link(db, "owner@platform.example", owner_uid, identity_type="platform_owner")
    # Licensee 1: contains the Platform Owner account itself (shared company) and a
    # separate user whose email already belongs to the Platform Owner.
    await db.commercial_license_customers.insert_one({"id": "cus-1", "created_at": "2026-01-01"})
    await db.companies.insert_one({"id": "co-1", "commercial_customer_id": "cus-1"})
    await db.users.insert_one({"id": "owner-in-licensee", "email": "owner2@platform.example", "status": "active",
                               "is_platform_owner": True, "company_id": "co-1"})
    await db.users.insert_one({"id": "dup", "email": "owner@platform.example", "role": "staff",
                               "status": "active", "company_id": "co-1"})
    await db.users.insert_one({"id": "ok-1", "email": "staff@licensee1.example", "role": "admin",
                               "status": "active", "company_id": "co-1"})
    # Licensee 2 comes after the conflict and must still be migrated.
    await db.commercial_license_customers.insert_one({"id": "cus-2", "created_at": "2026-02-01"})
    await db.companies.insert_one({"id": "co-2", "commercial_customer_id": "cus-2"})
    await db.users.insert_one({"id": "ok-2", "email": "boss@licensee2.example", "role": "admin",
                               "status": "active", "company_id": "co-2"})
    return owner_uid


def test_one_conflict_no_longer_stops_the_migration(raw):
    owner_uid = _run(_seed(raw))
    result = _run(ih.migrate_hierarchical_identities(raw))
    assert result["status"] == "completed-with-conflicts"
    assert result["conflicts"] == 1

    later = _run(raw.users.find_one({"id": "ok-2"}))
    assert later["identity_org_uid"].startswith("L-") and later["user_uid"]
    first = _run(raw.users.find_one({"id": "ok-1"}))
    assert first["identity_org_uid"].startswith("L-")
    # The Platform Owner account is never re-tagged as a licensee user.
    owner = _run(raw.users.find_one({"id": "owner-in-licensee"}))
    assert not str(owner.get("identity_org_uid") or "").startswith("L-")
    # The duplicate is skipped, and the owner keeps the email.
    dup = _run(raw.users.find_one({"id": "dup"}))
    assert "user_uid" not in dup
    link = _run(raw.identity_email_links.find_one({"email_normalized": "owner@platform.example"}))
    assert link["identity_uid"] == owner_uid

    marker = _run(raw.identity_migrations.find_one({"_id": ih.IDENTITY_MIGRATION_KEY}))
    assert marker["completed"] is True
    assert [(c["user_id"], c["email_masked"]) for c in marker["conflicts"]] == [("dup", "ow***@platform.example")]
    # Later boots don't redo it or fail.
    assert _run(ih.migrate_hierarchical_identities(raw))["status"] == "already-completed"


def test_licensing_index_bootstrap_has_the_identity_index_helper():
    assert licensing_api.ensure_identity_indexes is ih.ensure_identity_indexes
