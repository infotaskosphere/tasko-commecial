"""Portable Taskosphere customer backup / restore.

The portable .taskosphere file is a single encrypted container. It stores a
manifest, MongoDB documents in Canonical Extended JSON (BSON type preserving),
and index definitions. Full backups cover every tenant-scoped MongoDB
collection plus tenant-linked settings. Custom backups can select modules or
individual collections.

Authentication sessions/tokens are never exported. On cross-license restore,
the target company/license and the administrator's live authentication
credentials are preserved so a restore cannot lock the target account out.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId, json_util
from bson.json_util import CANONICAL_JSON_OPTIONS
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from backend.dependencies import DB_NAME, MONGO_URL, client, db, get_current_user, get_user_permissions
from backend.models import User
from backend.tenant_runtime import TENANT_COLLECTIONS
from backend.permission_governance import GOVERNED_MODULES
from backend.platform_owner import is_platform_owner

GOVERNED_MODULES.setdefault(
    "backup_restore",
    {"flag": "can_view_backup_restore", "label": "Backup & Restore"},
)

router = APIRouter(prefix="/app-backup", tags=["Application Backup"])

FORMAT_MAGIC = b"TASKOSPHERE-BACKUP-V1\n"
FORMAT_VERSION = 1
PBKDF2_ITERATIONS = 390_000
CHUNK_SIZE = 1024 * 1024
MAX_BACKUP_BYTES = 100 * 1024 * 1024
MAX_ARCHIVE_BYTES = 250 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 2000

EXCLUDED_COLLECTIONS = {
    "sessions", "refresh_tokens", "access_tokens", "password_resets",
    "password_reset_tokens", "verification_tokens", "email_verification_tokens",
    "oauth_states", "oauth_tokens", "rate_limits",
}

AUTH_FIELDS_TO_PRESERVE = {
    "password", "password_hash", "hashed_password", "hash", "auth_provider",
    "google_id", "google_sub", "mfa_secret", "two_factor_secret",
    "reset_token", "reset_token_expires", "verification_token",
    "token_version", "session_version", "security_stamp",
}

USER_LINKED_FIELDS = {
    "user_id", "created_by", "updated_by", "owner_id", "assigned_to",
    "assigned_to_user_id", "employee_id", "requested_by", "approved_by",
    "decided_by", "actor_user_id", "admin_id", "manager_id", "staff_id",
}
IDENTITY_FIELDS = {"company_id", "license_id", "commercial_customer_id"}

MODULE_COLLECTION_MAP = {
    "taskosphere": {"tasks", "todos", "reminders", "notification_history", "notifications"},
    "records": {"clients", "knowledge_base", "learning_events", "documents", "passwords"},
    "proposals": {"leads", "quotations", "proposals", "client_discussions", "client_activities"},
    "finix": {
        "invoices", "payments", "purchase_invoices", "purchase_payments", "purchases",
        "bank_accounts", "bank_transactions", "chart_of_accounts", "journal_entries", "journal_lines",
    },
    "people_matrix": {"attendance", "leave_requests", "payroll_records", "hr_records", "performance_records", "recruitment"},
    "compliance": {"compliance", "gst_reconciliation", "roc_records", "salary_slips", "due_dates"},
    "automation": {"workflow_definitions", "workflow_instances", "workflow_history", "approval_requests", "approval_history", "automation_rules", "business_events", "workflow_audit"},
    "analytics": {"analytics_data", "kpi_history", "recommendation_history", "learning_audit"},
    "settings": {"settings", "app_settings", "general_settings", "email_settings", "whatsapp_settings", "automation_settings", "feature_settings", "user_settings", "notification_settings", "integration_settings", "role_definitions"},
}


def _is_admin(user: User) -> bool:
    return str(getattr(user, "role", "")).lower() == "admin" or is_platform_owner(user)


def _require_backup_access(user: User) -> None:
    if _is_admin(user):
        return
    permissions = get_user_permissions(user)
    if permissions.get("can_view_backup_restore", False):
        return
    raise HTTPException(status_code=403, detail="Backup access has not been approved for your account.")


def _require_admin(user: User) -> None:
    if _is_admin(user):
        return
    raise HTTPException(status_code=403, detail="Only an administrator can restore an application backup.")


def _raw_db():
    raw = getattr(db, "_database", None)
    return raw if raw is not None else client[DB_NAME]


def _key(password: str, salt: bytes) -> bytes:
    if len(password or "") < 8:
        raise HTTPException(status_code=400, detail="Backup password must be at least 8 characters.")
    return PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITERATIONS).derive(password.encode("utf-8"))


def _header(salt: bytes, nonce: bytes) -> bytes:
    metadata = {"format": "taskosphere-backup", "version": FORMAT_VERSION, "cipher": "AES-256-GCM", "kdf": "PBKDF2-HMAC-SHA256", "iterations": PBKDF2_ITERATIONS, "salt": base64.b64encode(salt).decode(), "nonce": base64.b64encode(nonce).decode()}
    return FORMAT_MAGIC + json.dumps(metadata, separators=(",", ":")).encode() + b"\n"


def _read_header(handle):
    if handle.readline() != FORMAT_MAGIC:
        raise HTTPException(status_code=400, detail="Invalid Taskosphere backup file.")
    try:
        metadata = json.loads(handle.readline().decode())
        if metadata.get("format") != "taskosphere-backup" or metadata.get("version") != FORMAT_VERSION:
            raise ValueError("unsupported backup version")
        salt = base64.b64decode(metadata["salt"])
        nonce = base64.b64decode(metadata["nonce"])
        if len(salt) != 16 or len(nonce) != 12:
            raise ValueError("invalid encryption parameters")
        return salt, nonce
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid backup header: {exc}") from exc


def _encrypt(zip_path: str, output_path: str, password: str) -> None:
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    encryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce)).encryptor()
    with open(output_path, "wb") as out, open(zip_path, "rb") as source:
        out.write(_header(salt, nonce))
        while chunk := source.read(CHUNK_SIZE):
            out.write(encryptor.update(chunk))
        out.write(encryptor.finalize())
        out.write(encryptor.tag)


def _decrypt(source_path: str, password: str) -> str:
    if os.path.getsize(source_path) > MAX_BACKUP_BYTES:
        raise HTTPException(status_code=413, detail="Backup file exceeds the 100 MB limit.")
    with open(source_path, "rb") as source:
        salt, nonce = _read_header(source)
        payload = source.read()
    if len(payload) <= 16:
        raise HTTPException(status_code=400, detail="Backup payload is incomplete.")
    ciphertext, tag = payload[:-16], payload[-16:]
    try:
        decryptor = Cipher(algorithms.AES(_key(password, salt)), modes.GCM(nonce, tag)).decryptor()
        plaintext = decryptor.update(ciphertext) + decryptor.finalize()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Backup password is incorrect or the backup is corrupted.") from exc
    if len(plaintext) > MAX_ARCHIVE_BYTES:
        raise HTTPException(status_code=413, detail="Backup archive exceeds the 250 MB limit.")
    fd, path = tempfile.mkstemp(prefix="taskosphere-restore-", suffix=".zip")
    os.close(fd)
    try:
        with open(path, "wb") as out:
            out.write(plaintext)
        return path
    except Exception:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        raise


def _dump(value: Any) -> str:
    return json_util.dumps(value, json_options=CANONICAL_JSON_OPTIONS)


def _load(value: str) -> Any:
    return json_util.loads(value, json_options=CANONICAL_JSON_OPTIONS)


def _s(value: Any) -> str:
    return str(value).strip() if value is not None else ""


def _company_query(company_id: str) -> dict:
    values: list[Any] = [company_id]
    if ObjectId.is_valid(company_id):
        values.append(ObjectId(company_id))
    return {"$or": [{"company_id": value} for value in values]}


async def _tenant_context(user: User):
    company_id = _s(getattr(user, "company_id", None))
    if not company_id:
        raise HTTPException(status_code=403, detail="Your account is not attached to a customer company.")
    raw = _raw_db()
    company = await raw.companies.find_one({"id": company_id})
    if not company and ObjectId.is_valid(company_id):
        company = await raw.companies.find_one({"_id": ObjectId(company_id)})
    users = await raw.users.find(_company_query(company_id), {"_id": 1, "id": 1}).to_list(100000)
    user_ids = {_s(u.get("id")) for u in users if u.get("id")}
    user_ids.update(_s(u.get("_id")) for u in users if u.get("_id") is not None)
    identities = {field: {_s(getattr(user, field, None))} for field in IDENTITY_FIELDS}
    for field in IDENTITY_FIELDS:
        if company and company.get(field) is not None:
            identities[field].add(_s(company[field]))
        identities[field].discard("")
    return company_id, company, user_ids, identities


def _linked(doc: dict, user_ids: set[str], identities: dict[str, set[str]]) -> bool:
    for field in IDENTITY_FIELDS:
        if _s(doc.get(field)) in identities.get(field, set()):
            return True
    for field in USER_LINKED_FIELDS:
        value = doc.get(field)
        if _s(value) in user_ids:
            return True
        if isinstance(value, list) and any(_s(item) in user_ids for item in value):
            return True
    return False


async def _collection_docs(raw, name: str, company_id: str, user_ids: set[str], identities: dict[str, set[str]], company: dict | None):
    if name in EXCLUDED_COLLECTIONS:
        return []
    if name == "companies":
        docs = await raw[name].find({"id": company_id}).to_list(10)
        if not docs and company and company.get("_id") is not None:
            docs = await raw[name].find({"_id": company["_id"]}).to_list(10)
        return docs
    if name == "users" or name in TENANT_COLLECTIONS:
        return await raw[name].find(_company_query(company_id)).to_list(100000)
    docs = await raw[name].find({"$or": [{"company_id": {"$exists": True}}, {"user_id": {"$exists": True}}]}).to_list(100000)
    return [doc for doc in docs if _linked(doc, user_ids, identities)]


async def _resolve_collections(user: User, requested: list[str] | None):
    company_id, company, user_ids, identities = await _tenant_context(user)
    raw = _raw_db()
    available = sorted(set(await raw.list_collection_names()) - EXCLUDED_COLLECTIONS)
    if not requested:
        selected = available
    else:
        requested_set = {name for name in requested if name in available}
        if not requested_set:
            raise HTTPException(status_code=400, detail="No valid backup collections were selected.")
        selected = sorted(requested_set)
    return company_id, company, user_ids, identities, selected


async def _build_archive(user: User, password: str, requested: list[str] | None):
    company_id, company, user_ids, identities, selected = await _resolve_collections(user, requested)
    raw = _raw_db()
    manifest = {"format": "taskosphere-backup", "version": FORMAT_VERSION, "created_at": datetime.now(timezone.utc).isoformat(), "database": DB_NAME, "scope": "single_customer_tenant", "source_company_id": company_id, "source_license_id": next(iter(identities["license_id"]), None), "source_commercial_customer_id": next(iter(identities["commercial_customer_id"]), None), "owner_user_id": _s(user.id), "company_name": (company or {}).get("name"), "bson_encoding": "MongoDB Extended JSON v2 canonical", "encryption": "AES-256-GCM + PBKDF2-HMAC-SHA256", "selection": "full" if not requested else "custom", "collections": {}, "excluded_collections": sorted(EXCLUDED_COLLECTIONS)}
    fd, zip_path = tempfile.mkstemp(prefix="taskosphere-backup-", suffix=".zip")
    os.close(fd)
    output = None
    try:
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            for name in selected:
                docs = await _collection_docs(raw, name, company_id, user_ids, identities, company)
                if not docs:
                    continue
                safe = name.replace("/", "_")
                archive.writestr(f"collections/{safe}.jsonl", "".join(_dump(d) + "\n" for d in docs))
                try:
                    indexes = await raw[name].list_indexes().to_list(1000)
                    indexes = [idx for idx in indexes if idx.get("name") != "_id_"]
                    if indexes:
                        archive.writestr(f"indexes/{safe}.json", _dump(indexes))
                except Exception:
                    pass
                manifest["collections"][name] = {"documents": len(docs), "safe_name": safe}
            archive.writestr("manifest.json", json.dumps(manifest, indent=2, sort_keys=True))
        if os.path.getsize(zip_path) > MAX_ARCHIVE_BYTES:
            raise HTTPException(status_code=413, detail="Backup archive exceeds the 250 MB limit.")
        fd, output = tempfile.mkstemp(prefix="taskosphere-backup-", suffix=".taskosphere")
        os.close(fd)
        _encrypt(zip_path, output, password)
        if os.path.getsize(output) > MAX_BACKUP_BYTES:
            raise HTTPException(status_code=413, detail="Encrypted backup exceeds the 100 MB limit.")
        return output, manifest
    finally:
        try:
            os.unlink(zip_path)
        except FileNotFoundError:
            pass
        if output and os.path.exists(output):
            try:
                os.unlink(output)
            except FileNotFoundError:
                pass


@router.get("/info")
async def backup_info(current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    company_id, company, user_ids, identities = await _tenant_context(current_user)
    raw = _raw_db()
    available = sorted(set(await raw.list_collection_names()) - EXCLUDED_COLLECTIONS)
    modules = {module: sorted(set(collections) & set(available)) for module, collections in MODULE_COLLECTION_MAP.items()}
    return {"format": "Taskosphere Portable Backup v1", "company_id": company_id, "company_name": (company or {}).get("name"), "user_count": len(user_ids), "collections": available, "modules": modules, "encrypted": True, "requires_password": True, "mongo_database": DB_NAME, "mongo_connection_configured": bool(MONGO_URL), "excluded_security_collections": sorted(EXCLUDED_COLLECTIONS), "limits": {"encrypted_backup_bytes": MAX_BACKUP_BYTES, "archive_bytes": MAX_ARCHIVE_BYTES, "archive_entries": MAX_ARCHIVE_ENTRIES}, "notes": ["Full backup includes tenant MongoDB data, tenant-linked settings and index definitions.", "Live sessions, reset tokens and OAuth state are never exported.", "Cross-license restore remaps company/license/customer identifiers to the target tenant."]}


@router.post("/create")
async def create_backup(password: str = Form(...), collections: str = Form(""), current_user: User = Depends(get_current_user)):
    _require_backup_access(current_user)
    requested = [item.strip() for item in collections.split(",") if item.strip()] or None
    output, _manifest = await _build_archive(current_user, password, requested)
    filename = f"taskosphere-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.taskosphere"
    return FileResponse(output, media_type="application/octet-stream", filename=filename, background=BackgroundTask(lambda: os.path.exists(output) and os.unlink(output)))


async def _read_archive(zip_path: str):
    try:
        if os.path.getsize(zip_path) > MAX_ARCHIVE_BYTES:
            raise ValueError("archive exceeds the 250 MB limit")
        with zipfile.ZipFile(zip_path, "r") as archive:
            infos = archive.infolist()
            if len(infos) > MAX_ARCHIVE_ENTRIES:
                raise ValueError("archive contains too many entries")
            total_uncompressed = sum(max(0, info.file_size) for info in infos)
            if total_uncompressed > MAX_ARCHIVE_BYTES:
                raise ValueError("archive expands beyond the 250 MB limit")
            names = {info.filename for info in infos}
            if "manifest.json" not in names:
                raise ValueError("manifest.json is missing")
            manifest = json.loads(archive.read("manifest.json").decode())
            if manifest.get("format") != "taskosphere-backup" or manifest.get("version") != FORMAT_VERSION:
                raise ValueError("unsupported backup format")
            collections = []
            for name, meta in (manifest.get("collections") or {}).items():
                safe_name = meta.get("safe_name") if isinstance(meta, dict) else None
                if not safe_name or safe_name.replace("/", "_") != safe_name:
                    raise ValueError(f"Invalid collection archive name: {name}")
                entry = f"collections/{safe_name}.jsonl"
                if entry not in names:
                    raise ValueError(f"Collection payload missing: {name}")
                docs = [_load(line) for line in archive.read(entry).decode().splitlines() if line.strip()]
                collections.append((name, docs))
            return manifest, collections
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Backup archive is invalid: {exc}") from exc


def _replace(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        return replacements.get(value, value)
    if isinstance(value, list):
        return [_replace(item, replacements) for item in value]
    if isinstance(value, dict):
        return {key: _replace(item, replacements) for key, item in value.items()}
    return value


def _user_email(doc: dict) -> str:
    for field in ("email", "email_address", "username"):
        value = _s(doc.get(field)).lower()
        if "@" in value:
            return value
    return ""


async def _build_user_mapping(raw, source_users: list[dict], current_user: User, target_company_id: str) -> dict[str, str]:
    target_users = await raw.users.find(_company_query(target_company_id)).to_list(100000)
    by_email = {}
    for user in target_users:
        email = _user_email(user)
        if email:
            by_email[email] = _s(user.get("id"))
    mapping = {}
    current_id = _s(current_user.id)
    for source in source_users:
        source_id = _s(source.get("id"))
        if not source_id:
            continue
        if source_id == _s(source_users[0].get("id")) and _s(source.get("email")) == _s(current_user.email):
            mapping[source_id] = current_id
            continue
        email = _user_email(source)
        if email and email in by_email:
            mapping[source_id] = by_email[email]
        else:
            mapping[source_id] = str(uuid.uuid4())
    mapping.setdefault(_s(source_users[0].get("id")) if source_users else "", current_id)
    mapping.pop("", None)
    return mapping


def _validate_restore_documents(collections: list[tuple[str, list[dict]]], source_user_ids: set[str]) -> None:
    for name, docs in collections:
        if name in EXCLUDED_COLLECTIONS:
            raise HTTPException(status_code=400, detail=f"Backup contains excluded security collection: {name}")
        if not isinstance(docs, list):
            raise HTTPException(status_code=400, detail=f"Invalid document payload for collection: {name}")
        for doc in docs:
            if not isinstance(doc, dict):
                raise HTTPException(status_code=400, detail=f"Invalid document in collection: {name}")
            if name == "users" and not _s(doc.get("id")):
                raise HTTPException(status_code=400, detail="Backup contains a user without an id.")
    if "users" in {name for name, _ in collections} and not source_user_ids:
        raise HTTPException(status_code=400, detail="Backup user collection is empty or invalid.")


async def _restore(manifest: dict, collections: list[tuple[str, list[dict]]], current_user: User):
    target_company_id, target_company, target_user_ids, target_identities = await _tenant_context(current_user)
    source_company = _s(manifest.get("source_company_id"))
    source_owner = _s(manifest.get("owner_user_id"))
    if not source_company or not source_owner:
        raise HTTPException(status_code=400, detail="Backup is missing tenant ownership metadata.")
    source_license = _s(manifest.get("source_license_id"))
    source_customer = _s(manifest.get("source_commercial_customer_id"))
    target_license = next(iter(target_identities["license_id"]), "")
    target_customer = next(iter(target_identities["commercial_customer_id"]), "")
    source_users = next((docs for name, docs in collections if name == "users"), [])
    source_user_ids = {_s(doc.get("id")) for doc in source_users if _s(doc.get("id"))}
    if source_owner not in source_user_ids:
        source_user_ids.add(source_owner)
    _validate_restore_documents(collections, source_user_ids)
    raw = _raw_db()
    user_mapping = await _build_user_mapping(raw, source_users, current_user, target_company_id) if source_users else {source_owner: _s(current_user.id)}
    user_mapping[source_owner] = _s(current_user.id)
    replacements = {source_company: target_company_id, **user_mapping}
    if source_license and target_license:
        replacements[source_license] = target_license
    if source_customer and target_customer:
        replacements[source_customer] = target_customer

    selected_names = {name for name, _ in collections}
    delete_plan = []
    for name in selected_names:
        if name in EXCLUDED_COLLECTIONS or name == "companies":
            continue
        if name == "users":
            delete_plan.append((name, {"company_id": target_company_id, "id": {"$ne": _s(current_user.id)}}))
        elif name in TENANT_COLLECTIONS:
            delete_plan.append((name, {"company_id": target_company_id}))
        else:
            existing = await raw[name].find({}).to_list(100000)
            ids = [doc["_id"] for doc in existing if _linked(doc, {_s(current_user.id)}, target_identities) and doc.get("_id") is not None]
            delete_plan.append((name, {"_id": {"$in": ids}}) if ids else None)
    delete_plan = [item for item in delete_plan if item]

    restored = removed = 0
    for name, query in delete_plan:
        result = await raw[name].delete_many(query)
        removed += getattr(result, "deleted_count", 0)

    for name, docs in collections:
        if name in EXCLUDED_COLLECTIONS:
            continue
        rewritten = [_replace(doc, replacements) for doc in docs]
        if name == "companies":
            if not rewritten:
                continue
            doc = rewritten[0]
            doc["id"] = target_company_id
            if target_license:
                doc["license_id"] = target_license
            if target_customer:
                doc["commercial_customer_id"] = target_customer
            if target_company and target_company.get("_id") is not None:
                doc["_id"] = target_company["_id"]
            query = {"_id": target_company["_id"]} if target_company and target_company.get("_id") is not None else {"id": target_company_id}
            await raw.companies.replace_one(query, doc, upsert=True)
            restored += 1
            continue
        if name == "users":
            live_admin = await raw.users.find_one({"id": current_user.id})
            for doc in rewritten:
                if _s(doc.get("id")) == _s(current_user.id):
                    if live_admin:
                        for field in AUTH_FIELDS_TO_PRESERVE:
                            if field in live_admin:
                                doc[field] = live_admin[field]
                    doc["id"] = current_user.id
                    doc["company_id"] = target_company_id
                else:
                    doc["company_id"] = target_company_id
                await raw.users.replace_one({"id": doc.get("id")}, doc, upsert=True)
                restored += 1
            continue
        for doc in rewritten:
            if "company_id" in doc:
                doc["company_id"] = target_company_id
            query = {"_id": doc["_id"]} if doc.get("_id") is not None else {"id": doc.get("id")}
            await raw[name].replace_one(query, doc, upsert=True)
            restored += 1

    indexes_restored = 0
    with zipfile.ZipFile(_restore_zip_path, "r") as archive:
        for name in selected_names:
            meta = next((meta for cname, meta in (manifest.get("collections") or {}).items() if cname == name), None)
            if not meta:
                continue
            safe = meta.get("safe_name")
            index_entry = f"indexes/{safe}.json"
            if index_entry not in archive.namelist():
                continue
            try:
                for index in _load(archive.read(index_entry).decode()):
                    if not isinstance(index, dict) or not index.get("key") or index.get("name") == "_id_":
                        continue
                    key = index["key"]
                    options = {k: v for k, v in index.items() if k not in {"key", "name", "v", "ns"}}
                    await raw[name].create_index(list(key.items()), **options)
                    indexes_restored += 1
            except Exception:
                continue
    return {"restored_documents": restored, "removed_documents": removed, "restored_indexes": indexes_restored, "target_company_id": target_company_id}


@router.post("/restore")
async def restore_backup(backup: UploadFile = File(...), password: str = Form(...), confirmation: str = Form(...), current_user: User = Depends(get_current_user)):
    _require_admin(current_user)
    if confirmation.strip() != "RESTORE":
        raise HTTPException(status_code=400, detail="Type RESTORE exactly to confirm the operation.")
    if not backup.filename or not backup.filename.endswith(".taskosphere"):
        raise HTTPException(status_code=400, detail="Upload a .taskosphere backup file.")
    fd, source_path = tempfile.mkstemp(prefix="taskosphere-upload-", suffix=".taskosphere")
    os.close(fd)
    zip_path = None
    global _restore_zip_path
    _restore_zip_path = None
    try:
        total = 0
        with open(source_path, "wb") as out:
            while chunk := await backup.read(CHUNK_SIZE):
                total += len(chunk)
                if total > MAX_BACKUP_BYTES:
                    raise HTTPException(status_code=413, detail="Backup file exceeds the 100 MB limit.")
                out.write(chunk)
        zip_path = _decrypt(source_path, password)
        _restore_zip_path = zip_path
        manifest, collections = await _read_archive(zip_path)
        if manifest.get("scope") != "single_customer_tenant":
            raise HTTPException(status_code=400, detail="Unsupported backup scope.")
        result = await _restore(manifest, collections, current_user)
        return {"success": True, "message": "Application backup restored successfully.", **result}
    finally:
        _restore_zip_path = None
        try:
            os.unlink(source_path)
        except FileNotFoundError:
            pass
        if zip_path:
            try:
                os.unlink(zip_path)
            except FileNotFoundError:
                pass
