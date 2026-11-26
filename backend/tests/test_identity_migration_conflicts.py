"""The organisation-ID migration must not stop at one email conflict.

Login emails may be shared between organisations; only reserved Platform
Owner emails conflict. Before the fix, a single licensee user whose email
already belonged to the Platform Owner (PO-...) aborted the whole startup
migration on every boot, so every licensee after it never got its ID.
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
    await db.users.insert_one({"id": "owner-1", "email": "admin@taskosphere.com", "role": "admin",
                               "status": "active", "is_platform_owner": True, "company_id": "platform"})
    await ih.ensure_identity_email_link(db, "admin@taskosphere.com", owner_uid, identity_type="platform_owner")
    # Licensee 1: contains the Platform Owner account itself (shared company) and a
    # separate user whose email already belongs to the Platform Owner.
    await db.commercial_license_customers.insert_one({"id": "cus-1", "created_at": "2026-01-01"})
    await db.companies.insert_one({"id": "co-1", "commercial_customer_id": "cus-1"})
    await db.users.insert_one({"id": "owner-in-licensee", "email": "owner2@platform.example", "status": "active",
                               "is_platform_owner": True, "company_id": "co-1"})
    await db.users.insert_one({"id": "dup", "email": "admin@taskosphere.com", "role": "staff",
                               "status": "active", "company_id": "co-1"})
    # A normal email shared by users in two licensees is fine.
    await db.users.insert_one({"id": "shared-1", "email": "ca@shared.example", "role": "staff",
                               "status": "active", "company_id": "co-1"})
    await db.users.insert_one({"id": "ok-1", "email": "staff@licensee1.example", "role": "admin",
                               "status": "active", "company_id": "co-1"})
    # Licensee 2 comes after the conflict and must still be migrated.
    await db.commercial_license_customers.insert_one({"id": "cus-2", "created_at": "2026-02-01"})
    await db.companies.insert_one({"id": "co-2", "commercial_customer_id": "cus-2"})
    await db.users.insert_one({"id": "ok-2", "email": "boss@licensee2.example", "role": "admin",
                               "status": "active", "company_id": "co-2"})
    await db.users.insert_one({"id": "shared-2", "email": "ca@shared.example", "role": "staff",
                               "status": "active", "company_id": "co-2"})
    return owner_uid


def test_migration_completes_and_shares_normal_emails(raw):
    owner_uid = _run(_seed(raw))
    result = _run(ih.migrate_hierarchical_identities(raw))
    assert result["status"] == "completed" and result["conflicts"] == 0

    later = _run(raw.users.find_one({"id": "ok-2"}))
    assert later["identity_org_uid"].startswith("L-") and later["user_uid"]
    first = _run(raw.users.find_one({"id": "ok-1"}))
    assert first["identity_org_uid"].startswith("L-")
    # Platform Owner accounts (by flag or reserved email) are never re-tagged as licensee users.
    for uid in ("owner-in-licensee", "dup"):
        assert not str(_run(raw.users.find_one({"id": uid})).get("identity_org_uid") or "").startswith("L-")
    links = _run(raw.identity_email_links.find({"email_normalized": "admin@taskosphere.com"}).to_list(5))
    assert [l["identity_uid"] for l in links] == [owner_uid]
    # The shared normal email is linked to both licensees.
    shared = _run(raw.identity_email_links.find({"email_normalized": "ca@shared.example"}).to_list(5))
    assert len({l["identity_uid"] for l in shared}) == 2
    for uid in ("shared-1", "shared-2"):
        assert _run(raw.users.find_one({"id": uid}))["user_uid"]
    assert _run(ih.migrate_hierarchical_identities(raw))["status"] == "already-completed"


def test_a_conflicting_user_is_recorded_and_skipped(raw, monkeypatch):
    from fastapi import HTTPException

    _run(_seed(raw))
    real = ih.ensure_user_uid

    async def flaky(db, user, **kw):
        if user.get("id") == "ok-1":
            raise HTTPException(status_code=409, detail="reserved")
        return await real(db, user, **kw)

    monkeypatch.setattr(ih, "ensure_user_uid", flaky)
    result = _run(ih.migrate_hierarchical_identities(raw))
    assert result["status"] == "completed-with-conflicts" and result["conflicts"] == 1
    assert _run(raw.users.find_one({"id": "ok-2"}))["identity_org_uid"].startswith("L-")
    marker = _run(raw.identity_migrations.find_one({"_id": ih.IDENTITY_MIGRATION_KEY}))
    assert [(c["user_id"], c["email_masked"]) for c in marker["conflicts"]] == [("ok-1", "st***@licensee1.example")]


def test_reserved_owner_email_cannot_link_to_a_licensee(raw):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        _run(ih.ensure_identity_email_link(raw, "admin@taskosphere.com", "L-000001", identity_type="licensee"))
    assert exc.value.status_code == 409


def test_licensing_index_bootstrap_has_the_identity_index_helper():
    assert licensing_api.ensure_identity_indexes is ih.ensure_identity_indexes
