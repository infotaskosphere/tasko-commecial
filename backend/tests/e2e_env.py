"""Shared plumbing for end-to-end tests: a private in-memory database swapped into every backend module, and a
licensed company with an administrator and a staff user whose accounting permissions are explicitly denied (an empty permission map gets platform defaults)."""
import asyncio
import contextlib
import datetime as dt
import logging
import sys

FUTURE = (dt.datetime.utcnow() + dt.timedelta(days=200)).isoformat()


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@contextlib.contextmanager
def swapped_database(name: str):
    import mongomock_motor

    import backend.server as server
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    logging.disable(logging.CRITICAL)
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client[name]
    wrapped = TenantAwareDatabase(raw, mongo_client=client)
    original, original_raw = dep.db, dep._raw_db
    swapped = []
    for mod_name, mod in list(sys.modules.items()):
        if (mod_name == "backend" or mod_name.startswith("backend.")) and mod is not None and getattr(mod, "db", None) is original:
            swapped.append(mod)
            mod.db = wrapped
    dep._raw_db, dep.db = raw, wrapped
    try:
        yield server.app, raw, dep
    finally:
        for mod_name, mod in list(sys.modules.items()):
            if (mod_name == "backend" or mod_name.startswith("backend.")) and mod is not None and getattr(mod, "db", None) is wrapped:
                mod.db = original
        for mod in swapped:
            mod.db = original
        dep.db, dep._raw_db = original, original_raw
        logging.disable(logging.NOTSET)


def seed_company(raw, co: str, name: str = "Test Co", gstin: str = "27AAACT2882H1Z7") -> None:
    now = dt.datetime.utcnow().isoformat()
    lic = {"id": f"lic-{co}", "customer_id": co, "status": "active", "modules": ["finix"], "licensed_modules": ["finix"],
           "expires_at": FUTURE, "issued_at": now, "max_users": 50}
    run(raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True))
    run(raw.companies.replace_one({"id": co}, {"id": co, "name": name, "gstin": gstin, "created_by": f"{co}-admin",
                                              "commercial_customer_id": co, "license_id": lic["id"]}, upsert=True))
    for uid, role in ((f"{co}-admin", "admin"), (f"{co}-viewer", "staff")):
        run(raw.users.replace_one({"id": uid}, {
            "id": uid, "email": f"{uid}@{co}.test", "full_name": uid, "role": role,
            "identity_type": "licensee_admin" if role == "admin" else "licensee_user",
            "permissions": ({} if role == "admin" else {k: False for k in (
                "can_post_journal_entries", "can_view_accounting_reports", "can_view_extended_accounts_reports", "can_view_journal_entries",
                "can_manage_chart_of_accounts")}), "company_id": co, "license_id": lic["id"], "commercial_customer_id": co, "is_active": True,
            "hashed_password": "x", "created_at": now}, upsert=True))


def headers(dep, user_id: str) -> dict:
    return {"Authorization": "Bearer " + dep.create_access_token({"sub": user_id})}
