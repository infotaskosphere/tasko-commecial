#!/usr/bin/env python3
"""Copy a legacy licensee's operational records into its dedicated database.

Safe by default: this script only reports. --apply copies and verifies records,
then activates tenant database routing in the central customer registry. Source
records are retained as a rollback copy. It never deletes source records.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from backend.tenant_runtime import TENANT_COLLECTIONS  # noqa: E402
from backend.tenant_database_manager import provision_tenant_database, tenant_database_name  # noqa: E402

CENTRAL_ONLY = {
    "users", "companies", "commercial_licenses", "commercial_license_customers",
    "commercial_license_packages", "commercial_customers", "identity_email_links",
    "identity_migrations", "identity_sequences", "licenses", "license_activations",
}


def _ownership_query(customer_id: str, company_ids: list[str]) -> dict:
    branches = [
        {"commercial_customer_id": customer_id},
        {"customer_id": customer_id},
        {"licensee_id": customer_id},
    ]
    if company_ids:
        branches.append({"company_id": {"$in": company_ids}})
    return {"$or": branches}


async def migrate(customer_id: str, apply: bool) -> int:
    mongo_url = os.getenv("MONGO_URL") or os.getenv("MONGODB_URI")
    if not mongo_url:
        raise RuntimeError("Set MONGO_URL or MONGODB_URI before running migration")
    central_name = os.getenv("DB_NAME") or os.getenv("MONGODB_DB_NAME", "taskosphere_commercial")
    client = AsyncIOMotorClient(mongo_url)
    try:
        central = client[central_name]
        customer = await central.commercial_license_customers.find_one({"id": customer_id}, {"_id": 0})
        if not customer:
            raise RuntimeError(f"No commercial customer found for id {customer_id!r}")
        company_docs = await central.companies.find(
            {"$or": [{"commercial_customer_id": customer_id}, {"id": customer_id}]},
            {"_id": 0, "id": 1},
        ).to_list(5000)
        company_ids = sorted({str(d.get("id")) for d in company_docs if d.get("id")})
        query = _ownership_query(customer_id, company_ids)
        target_name = tenant_database_name(customer_id)

        if not apply:
            print(f"DRY RUN customer={customer_id} database={target_name}")
            print(f"Resolved company IDs: {company_ids or '(none)'}")
            for name in sorted(set(TENANT_COLLECTIONS) - CENTRAL_ONLY):
                count = await central[name].count_documents(query)
                if count:
                    print(f"  {name}: {count} record(s) would be copied")
            print("No data was changed. Re-run with --apply after reviewing this report.")
            return 0

        await provision_tenant_database(client, customer_id)
        tenant = client[target_name]
        summary: dict[str, int] = {}
        for name in sorted(set(TENANT_COLLECTIONS) - CENTRAL_ONLY):
            source, destination = central[name], tenant[name]
            copied = 0
            async for document in source.find(query):
                await destination.replace_one({"_id": document["_id"]}, document, upsert=True)
                copied += 1
            if copied:
                async for row in source.find(query, {"_id": 1}):
                    if await destination.count_documents({"_id": row["_id"]}) != 1:
                        raise RuntimeError(f"Verification failed for {name} _id={row['_id']}")
                summary[name] = copied

        await central.commercial_license_customers.update_one(
            {"id": customer_id},
            {"$set": {
                "tenant_database_name": target_name,
                "tenant_database_status": "ready",
                "tenant_database_migrated_at": datetime.now(timezone.utc).isoformat(),
                "tenant_database_migration_version": 1,
            }},
        )
        print(f"Migration verified and routing activated for {customer_id} -> {target_name}")
        print("Shared source records were retained for rollback.")
        for name, count in sorted(summary.items()):
            print(f"  {name}: {count} record(s) copied")
        return 0
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--customer-id", required=True, help="Central commercial customer ID")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--dry-run", action="store_true", help="Report records without changing data")
    group.add_argument("--apply", action="store_true", help="Copy, verify, then enable tenant routing")
    args = parser.parse_args()
    return asyncio.run(migrate(args.customer_id, args.apply))


if __name__ == "__main__":
    raise SystemExit(main())
