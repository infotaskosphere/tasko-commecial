"""Uploaded files kept in MongoDB GridFS instead of the server's local disk.

The app runs on hosts whose disk is wiped on every deploy or restart, so a file
written under backend/uploads/ was silently lost. Files stored here live in the
same database as the record that refers to them (the tenant's own database when
the company has one), tagged with the company id so a lookup can never return
another company's file.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase, AsyncIOMotorGridFSBucket

BUCKET = "app_files"
# Only for the in-memory development database, which has no GridFS.
_DEV_DIR = Path(__file__).resolve().parent / "uploads" / "_dev_file_store"


def _raw_database():
    """The authenticated tenant's raw database (central database otherwise)."""
    from backend import dependencies as dep
    from backend.tenant_runtime import authenticated_tenant_database_name, in_platform_owner_context

    tenant_name = authenticated_tenant_database_name()
    if tenant_name and not in_platform_owner_context():
        return dep.client[tenant_name]
    raw = getattr(dep.db, "_database", None)
    return raw if raw is not None else dep._raw_db


def _bucket() -> Optional[AsyncIOMotorGridFSBucket]:
    raw = _raw_database()
    if not isinstance(raw, AsyncIOMotorDatabase):
        return None
    try:
        return AsyncIOMotorGridFSBucket(raw, bucket_name=BUCKET)
    except TypeError:
        # Test doubles that look like motor but are not real databases.
        return None


def _dev_path(name: str, company_id: Optional[str], kind: str) -> Path:
    safe = lambda v: re.sub(r"[^\w.\-]", "_", str(v or "none"))  # noqa: E731
    return _DEV_DIR / safe(company_id) / safe(kind) / safe(name)


async def put_file(data: bytes, *, name: str, content_type: str, company_id: Optional[str], kind: str, **metadata: Any) -> str:
    """Store ``data`` under the unique ``name``; returns the GridFS id."""
    meta = {"content_type": content_type or "application/octet-stream", "company_id": company_id, "kind": kind, **metadata}
    bucket = _bucket()
    if bucket is None:
        path = _dev_path(name, company_id, kind)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        path.with_suffix(path.suffix + ".meta.json").write_text(json.dumps(meta, default=str))
        return f"dev:{name}"
    file_id = await bucket.upload_from_stream(name, data, metadata=meta)
    return str(file_id)


async def get_file(name: str, *, company_id: Optional[str], kind: str) -> Optional[tuple[bytes, dict]]:
    """Return ``(data, metadata)`` for the newest file called ``name`` owned by
    ``company_id``, or None."""
    bucket = _bucket()
    if bucket is None:
        path = _dev_path(name, company_id, kind)
        if not path.is_file():
            return None
        meta_path = path.with_suffix(path.suffix + ".meta.json")
        meta = json.loads(meta_path.read_text()) if meta_path.is_file() else {}
        return path.read_bytes(), meta
    query: dict[str, Any] = {"filename": name, "metadata.kind": kind, "metadata.company_id": company_id}
    async for doc in bucket.find(query).sort("uploadDate", -1).limit(1):
        stream = await bucket.open_download_stream(doc["_id"])
        return await stream.read(), dict(doc.get("metadata") or {})
    return None


async def delete_files(names: list[str], *, company_id: Optional[str], kind: str) -> int:
    bucket = _bucket()
    removed = 0
    if bucket is None:
        for name in names:
            path = _dev_path(name, company_id, kind)
            if path.is_file():
                path.unlink()
                path.with_suffix(path.suffix + ".meta.json").unlink(missing_ok=True)
                removed += 1
        return removed
    async for doc in bucket.find({"filename": {"$in": list(names)}, "metadata.kind": kind, "metadata.company_id": company_id}):
        await bucket.delete(doc["_id"])
        removed += 1
    return removed
