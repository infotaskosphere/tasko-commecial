"""Read-only check: why does the Platform Owner still see licensee data?

Code scoping filters by ``company_id``. Licensee rows can only appear in the
owner's portal if they are *stamped with the owner's company_id* (or the
licensee's users share it). This script reports exactly that. It never writes.

    python scripts/diagnose_owner_isolation.py

Environment: MONGO_URL (or MONGODB_URI), DB_NAME (or MONGODB_DB_NAME).
"""
from __future__ import annotations

import asyncio
import os
import sys

from motor.motor_asyncio import AsyncIOMotorClient

OWNER_EMAILS = {"info.taskosphere@gmail.com", "infotaskosphere@gmail.com", "admin@taskosphere.com", "csmanthandesai@gmail.com"}
OWNER_EMAILS |= {e.strip().lower() for e in os.getenv("PLATFORM_OWNER_EMAILS", "").split(",") if e.strip()}
COLLECTIONS = ["invoices", "payments", "clients", "tasks", "purchase_invoices", "chart_of_accounts"]


async def main() -> int:
    url = os.getenv("MONGO_URL") or os.getenv("MONGODB_URI")
    if not url:
        print("MONGO_URL / MONGODB_URI is not set.", file=sys.stderr)
        return 2
    db = AsyncIOMotorClient(url)[os.getenv("DB_NAME") or os.getenv("MONGODB_DB_NAME", "taskosphere_commercial")]

    users = await db.users.find({}, {"_id": 0, "id": 1, "email": 1, "role": 1, "company_id": 1, "commercial_customer_id": 1}).to_list(None)
    owners = [u for u in users if str(u.get("email", "")).lower() in OWNER_EMAILS]
    owner_cids = {u.get("company_id") for u in owners}
    print("Owner accounts:")
    for u in owners:
        print(f"  {u['email']}  company_id={u.get('company_id')!r}")
    if None in owner_cids or "" in owner_cids:
        print("  !! an owner has NO company_id -> scoping cannot apply to that account")

    shared = [u for u in users if u not in owners and u.get("company_id") in owner_cids and u.get("company_id")]
    print(f"\nNon-owner users sharing an owner company_id: {len(shared)}")
    for u in shared[:20]:
        print(f"  {u.get('email')} role={u.get('role')} customer={u.get('commercial_customer_id')}")

    user_company = {u["id"]: u.get("company_id") for u in users if u.get("id")}
    for name in COLLECTIONS:
        total = await db[name].count_documents({})
        none = await db[name].count_documents({"$or": [{"company_id": {"$exists": False}}, {"company_id": None}, {"company_id": ""}]})
        own = await db[name].count_documents({"company_id": {"$in": [c for c in owner_cids if c]}}) if owner_cids else 0
        mis = 0
        async for row in db[name].find({"company_id": {"$in": [c for c in owner_cids if c]}}, {"_id": 0, "created_by": 1}):
            c = user_company.get(row.get("created_by"))
            if c and c not in owner_cids:
                mis += 1
        print(f"\n{name}: total={total} no_company_id={none} stamped_owner_company={own} "
              f"owner-stamped_but_created_by_licensee_user={mis}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
