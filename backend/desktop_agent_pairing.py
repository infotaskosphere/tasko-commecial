"""Taskosphere Agent: pair a computer once, then run without any login.

Flow (no password is ever typed into the agent, and the browser never has to
talk to the agent on 127.0.0.1, so there is no local-network permission prompt):

1. The agent starts without a saved credential and calls
   ``POST /api/desktop/pair/start``. It gets a short ``code`` (goes in the
   browser URL) and a secret ``claim_token`` (stays on the computer).
2. The agent opens ``<web app>/agent/pair?code=...`` in the default browser.
   The user is already signed in to Taskosphere there and clicks
   **Connect this computer** (``POST /api/desktop/pair/{code}/approve``).
3. The agent polls ``POST /api/desktop/pair/claim`` with code + claim_token and
   receives a long-lived **device credential** (``tsa_...``), saved locally.
   From then on it reports in the background, across restarts.

The device credential is separate from browser sessions (an account has only
one live browser session, and each login replaces the previous one, which used
to silently disconnect the agent). It is accepted only on the agent's own
endpoints (see ``device_token_guard``), and can be revoked from Settings →
Desktop Agent.
"""
from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend.dependencies import get_current_user
from backend.desktop_agent import router
from backend.models import User
from backend.platform_owner import is_platform_owner

logger = logging.getLogger(__name__)

PAIRINGS = "desktop_agent_pairings"
DEVICES = "desktop_agent_devices"
DEVICE_TOKEN_PREFIX = "tsa_"
PAIRING_TTL = timedelta(minutes=15)
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I

# A device credential only opens what the agent itself calls.
DEVICE_ALLOWED_PREFIXES = ("/api/desktop/", "/api/notifications", "/api/activity/report")
# ...and never the endpoints that create, list or revoke device credentials.
DEVICE_FORBIDDEN_PREFIXES = ("/api/desktop/pair", "/api/desktop/devices")


def _raw_db():
    from backend import dependencies

    return getattr(dependencies, "_raw_db", None) or dependencies.db


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _aware(value):
    if isinstance(value, datetime) and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def _clean(value: Optional[str], limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    return header[7:].strip() if header[:7].lower() == "bearer " else ""


def _reject_device_token(request: Request) -> None:
    if _bearer(request).startswith(DEVICE_TOKEN_PREFIX):
        raise HTTPException(status_code=403, detail="Sign in to Taskosphere to manage connected computers.")


async def create_pairing_indexes() -> None:
    db = _raw_db()
    for name, keys, options in (
        (PAIRINGS, [("code", 1)], {"unique": True}),
        (PAIRINGS, [("expires_at", 1)], {"expireAfterSeconds": 0}),
        (DEVICES, [("token_hash", 1)], {"unique": True}),
        (DEVICES, [("user_id", 1), ("status", 1)], {}),
        (DEVICES, [("company_id", 1), ("status", 1)], {}),
    ):
        try:
            await db[name].create_index(keys, **options)
        except Exception as exc:  # never block startup on an index
            logger.warning("Desktop pairing index %s %s skipped: %s", name, keys, exc)


# ── Credential lookup (used by dependencies.get_current_user) ────────────────
async def device_user_id(token: str) -> Optional[str]:
    """User id for an active device credential, or None."""
    if not token or not token.startswith(DEVICE_TOKEN_PREFIX):
        return None
    db = _raw_db()
    device = await db[DEVICES].find_one({"token_hash": _hash(token), "status": "active"})
    if not device:
        return None
    now = _now()
    last_seen = _aware(device.get("last_seen_at"))
    if not isinstance(last_seen, datetime) or (now - last_seen).total_seconds() > 60:
        try:
            await db[DEVICES].update_one({"_id": device["_id"]}, {"$set": {"last_seen_at": now}})
        except Exception:
            pass
    return str(device.get("user_id") or "") or None


def install_device_token_guard(app) -> None:
    """Refuse device credentials outside the agent's own endpoints."""

    @app.middleware("http")
    async def device_token_guard(request: Request, call_next):
        if _bearer(request).startswith(DEVICE_TOKEN_PREFIX):
            path = request.url.path or ""
            allowed = path.startswith(DEVICE_ALLOWED_PREFIXES) and not path.startswith(DEVICE_FORBIDDEN_PREFIXES)
            if not allowed and request.method != "OPTIONS":
                from fastapi.responses import JSONResponse

                return JSONResponse({"detail": "This credential is only valid for the Taskosphere Agent."}, status_code=403)
        return await call_next(request)


# ── Pairing ──────────────────────────────────────────────────────────────────
class PairStartIn(BaseModel):
    agent_id: str = Field(..., min_length=4, max_length=64)
    machine_name: str = Field(..., min_length=1, max_length=120)
    agent_version: str = Field("", max_length=32)
    os_user: str = Field("", max_length=120)


class PairClaimIn(BaseModel):
    code: str = Field(..., min_length=6, max_length=16)
    claim_token: str = Field(..., min_length=20, max_length=200)


def _new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))


@router.post("/pair/start")
async def pair_start(body: PairStartIn):
    """Called by the agent (no sign-in). Returns the code to show in the browser."""
    db = _raw_db()
    claim_token = secrets.token_urlsafe(32)
    now = _now()
    for _ in range(5):
        code = _new_code()
        try:
            await db[PAIRINGS].insert_one({
                "code": code,
                "claim_hash": _hash(claim_token),
                "agent_id": _clean(body.agent_id, 64),
                "machine_name": _clean(body.machine_name, 120),
                "agent_version": _clean(body.agent_version, 32),
                "os_user": _clean(body.os_user, 120),
                "status": "pending",
                "created_at": now,
                "expires_at": now + PAIRING_TTL,
            })
            break
        except Exception:
            continue
    else:
        raise HTTPException(status_code=503, detail="Could not start pairing; try again.")
    return {"code": code, "claim_token": claim_token, "expires_in": int(PAIRING_TTL.total_seconds())}


async def _live_pairing(code: str) -> dict:
    doc = await _raw_db()[PAIRINGS].find_one({"code": _clean(code, 16).upper()})
    if not doc or _aware(doc.get("expires_at")) <= _now():
        raise HTTPException(status_code=404, detail="This connection link has expired. Click “Connect to Taskosphere” in the agent’s tray menu to get a new one.")
    return doc


@router.get("/pair/{code}")
async def pair_details(code: str, request: Request, current_user: User = Depends(get_current_user)):
    """What the confirmation page shows before the user connects the computer."""
    _reject_device_token(request)
    doc = await _live_pairing(code)
    return {"code": doc["code"], "machine_name": doc.get("machine_name"), "os_user": doc.get("os_user"),
            "agent_version": doc.get("agent_version"), "status": doc.get("status"),
            "expires_at": _aware(doc["expires_at"]).isoformat()}


@router.post("/pair/{code}/approve")
async def pair_approve(code: str, request: Request, current_user: User = Depends(get_current_user)):
    """The signed-in user connects this computer to their account."""
    _reject_device_token(request)
    db = _raw_db()
    doc = await _live_pairing(code)
    if doc.get("status") != "pending":
        raise HTTPException(status_code=409, detail="This computer is already connected.")
    token = DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(32)
    now = _now()
    user_id = str(current_user.id)
    # One credential per computer and user: reconnecting replaces the old one.
    await db[DEVICES].update_many(
        {"user_id": user_id, "agent_id": doc["agent_id"], "status": "active"},
        {"$set": {"status": "replaced", "revoked_at": now}},
    )
    device_id = secrets.token_hex(8)
    await db[DEVICES].insert_one({
        "id": device_id,
        "user_id": user_id,
        "user_name": getattr(current_user, "full_name", None) or getattr(current_user, "email", None),
        "company_id": str(getattr(current_user, "company_id", "") or ""),
        "agent_id": doc["agent_id"],
        "machine_name": doc.get("machine_name"),
        "os_user": doc.get("os_user"),
        "token_hash": _hash(token),
        "status": "active",
        "created_at": now,
        "last_seen_at": None,
    })
    # The plain credential waits on the pairing record only until the agent
    # claims it (then it is removed); the record itself expires after
    # PAIRING_TTL. Devices store only its hash.
    res = await db[PAIRINGS].update_one(
        {"_id": doc["_id"], "status": "pending"},
        {"$set": {"status": "approved", "device_token": token, "device_id": device_id, "user_id": user_id,
                  "user_name": getattr(current_user, "full_name", None) or getattr(current_user, "email", None),
                  "approved_at": now}},
    )
    if not res.modified_count:
        await db[DEVICES].update_one({"id": device_id}, {"$set": {"status": "revoked", "revoked_at": now}})
        raise HTTPException(status_code=409, detail="This computer is already connected.")
    return {"connected": True, "machine_name": doc.get("machine_name"), "device_id": device_id}


@router.post("/pair/claim")
async def pair_claim(body: PairClaimIn):
    """Polled by the agent (no sign-in) until the user approves in the browser."""
    db = _raw_db()
    doc = await db[PAIRINGS].find_one({"code": _clean(body.code, 16).upper()})
    if not doc or _aware(doc.get("expires_at")) <= _now() or not secrets.compare_digest(doc.get("claim_hash", ""), _hash(body.claim_token)):
        raise HTTPException(status_code=404, detail="Pairing expired or not found.")
    if doc.get("status") != "approved" or not doc.get("device_token"):
        return {"status": "pending"}
    # Hand the credential over exactly once.
    claimed = await db[PAIRINGS].find_one_and_update(
        {"_id": doc["_id"], "status": "approved"},
        {"$set": {"status": "claimed", "claimed_at": _now()}, "$unset": {"device_token": ""}},
    )
    if not claimed or not claimed.get("device_token"):
        return {"status": "pending"}
    return {"status": "approved", "token": claimed["device_token"], "user_id": claimed.get("user_id"),
            "user_name": claimed.get("user_name"), "device_id": claimed.get("device_id")}


# ── Connected computers ──────────────────────────────────────────────────────
def _is_admin(user: User) -> bool:
    role = getattr(user, "role", "")
    return is_platform_owner(user) or str(getattr(role, "value", role)).lower() == "admin"


def _public_device(doc: dict) -> dict:
    def _iso(v):
        v = _aware(v)
        return v.isoformat() if isinstance(v, datetime) else v
    return {"id": doc.get("id"), "machine_name": doc.get("machine_name"), "os_user": doc.get("os_user"),
            "user_id": doc.get("user_id"), "user_name": doc.get("user_name"),
            "created_at": _iso(doc.get("created_at")), "last_seen_at": _iso(doc.get("last_seen_at"))}


@router.get("/devices")
async def list_devices(request: Request, current_user: User = Depends(get_current_user)):
    """Computers connected to the current user (admins: their whole company)."""
    _reject_device_token(request)
    query = {"status": "active"}
    if _is_admin(current_user):
        query["company_id"] = str(getattr(current_user, "company_id", "") or "")
    else:
        query["user_id"] = str(current_user.id)
    docs = await _raw_db()[DEVICES].find(query, {"_id": 0, "token_hash": 0}).sort("created_at", -1).to_list(500)
    return {"devices": [_public_device(d) for d in docs], "is_admin": _is_admin(current_user)}


@router.delete("/devices/{device_id}")
async def revoke_device(device_id: str, request: Request, current_user: User = Depends(get_current_user)):
    """Disconnect a computer: its agent stops reporting and asks to be connected again."""
    _reject_device_token(request)
    query = {"id": _clean(device_id, 40), "status": "active"}
    if _is_admin(current_user):
        query["company_id"] = str(getattr(current_user, "company_id", "") or "")
    else:
        query["user_id"] = str(current_user.id)
    res = await _raw_db()[DEVICES].update_one(query, {"$set": {"status": "revoked", "revoked_at": _now(),
                                                               "revoked_by": str(current_user.id)}})
    if not res.modified_count:
        raise HTTPException(status_code=404, detail="Connected computer not found.")
    return {"revoked": True}
