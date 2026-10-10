"""One-time backfill: stamp legacy audit_logs rows with their tenant company_id.

``audit_logs`` is now a tenant-scoped collection (backend/tenant_runtime.py).
Rows written before that change carry no ``company_id`` and would become
invisible to everyone, so each row is stamped from the company of the user who
produced it (``audit_logs.user_id`` -> ``users.company_id``).

Rows whose user cannot be resolved are left untouched on purpose: they stay
hidden from every tenant (fail closed) and can be reviewed by hand.

Usage (dry run is the default):
    python scripts/backfill_audit_log_company.py            # report only
    python scripts/backfill_audit_log_company.py --apply    # write changes

Environment: MONGO_URL (or MONGODB_URI) and DB_NAME (or MONGODB_DB_NAME).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys

from motor.motor_asyncio import AsyncIOMotorClient


async def main(apply: bool) -> int:
    mongo_url = os.getenv("MONGO_URL") or os.getenv("MONGODB_URI")
    if not mongo_url:
        print("MONGO_URL / MONGODB_URI is not set.", file=sys.stderr)
        return 2
    db_name = os.getenv("DB_NAME") or os.getenv("MONGODB_DB_NAME", "taskosphere_commercial")
    db = AsyncIOMotorClient(mongo_url)[db_name]

    missing = {"$or": [{"company_id": {"$exists": False}}, {"company_id": None}, {"company_id": ""}]}
    total_missing = await db.audit_logs.count_documents(missing)
    user_ids = [uid for uid in await db.audit_logs.distinct("user_id", missing) if uid]

    stamped = 0
    unresolved = 0
    for user_id in user_ids:
        user = await db.users.find_one({"id": user_id}, {"_id": 0, "company_id": 1})
        company_id = str((user or {}).get("company_id") or "").strip()
        rows = await db.audit_logs.count_documents({"user_id": user_id, **missing})
        if not company_id:
            unresolved += rows
            continue
        if apply:
            await db.audit_logs.update_many(
                {"user_id": user_id, **missing}, {"$set": {"company_id": company_id}}
            )
        stamped += rows

    mode = "APPLIED" if apply else "DRY RUN"
    print(f"[{mode}] audit_logs without company_id: {total_missing}")
    print(f"[{mode}] rows stamped from their user's company: {stamped}")
    print(f"[{mode}] rows left unscoped (user not found / no company): {unresolved}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--apply", action="store_true", help="write the changes (default is a dry run)")
    raise SystemExit(asyncio.run(main(parser.parse_args().apply)))
