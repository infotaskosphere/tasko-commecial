"""
attendance_identix.py  — COMPLETE REWRITE (all fixes applied)
─────────────────────────────────────────────────────────────────────────────
Routes provided:
  DEVICES
    GET    /identix/devices
    POST   /identix/devices
    PUT    /identix/devices/{device_id}
    DELETE /identix/devices/{device_id}
    POST   /identix/devices/{device_id}/test
    POST   /identix/devices/{device_id}/sync-users
    POST   /identix/devices/scan
    GET    /identix/devices/scan/{scan_id}

  ATTENDANCE
    GET    /identix/attendance          (paginated, filterable)
    POST   /identix/attendance/sync
    GET    /identix/attendance/summary  ← was missing (404 fixed)

  ENROLLMENT
    GET    /identix/users
    PATCH  /identix/users/{user_id}/thumb-enrolled
    POST   /identix/users/{user_id}/sync-to-device

HOW TO INTEGRATE:
  1. pip install pyzk
  2. Drop this file in backend/
  3. In server.py:
       from attendance_identix import identix_router
       api_router.include_router(identix_router)
  4. After new_user insert in /auth/register:
       asyncio.create_task(sync_user_to_identix_devices(new_user))
─────────────────────────────────────────────────────────────────────────────
"""

import asyncio
import re
import uuid
import socket
import logging
import traceback
import hashlib
from urllib.parse import parse_qsl
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from typing import Optional, Dict, Any
from fastapi import Request
from fastapi import APIRouter, HTTPException, Depends, BackgroundTasks
from pydantic import BaseModel

logger = logging.getLogger("identix")

from backend.dependencies import db, get_current_user, require_admin
from backend.models import User

identix_router = APIRouter()

# ─────────────────────────────────────────────────────────────────────────────
# IN-MEMORY SCAN STATE  (keyed by scan_id UUID)
# ─────────────────────────────────────────────────────────────────────────────
_SCAN_STATE: Dict[str, Dict[str, Any]] = {}


# ─────────────────────────────────────────────────────────────────────────────
# PYZK HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_zk(ip: str, port: int = 4370, password: int = 0, timeout: int = 5):
    try:
        from zk import ZK
        return ZK(ip, port=port, timeout=timeout, password=password,
                  force_udp=False, ommit_ping=False)
    except ImportError:
        raise RuntimeError(
            "pyzk not installed. Run: pip install pyzk\n"
            "Then restart the backend server."
        )


async def _tcp_reachable(ip: str, port: int, timeout: float = 1.5) -> bool:
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, lambda: _blocking_tcp_ping(ip, port)),
            timeout=timeout,
        )
        return True
    except Exception:
        return False


def _blocking_tcp_ping(ip: str, port: int):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(1.5)
    try:
        s.connect((ip, port))
    finally:
        s.close()


def _try_get_device_info(ip: str, port: int, password: int = 0) -> Optional[dict]:
    """Try to connect via pyzk and read device info. Returns dict or None."""
    try:
        zk   = _get_zk(ip, port, password, timeout=4)
        conn = zk.connect()
        try:
            firmware = conn.get_firmware_version()
            serial   = conn.get_serialnumber()
            users    = conn.get_users()
            return {
                "serialNumber": serial,
                "firmware":     firmware,
                "userCount":    len(users) if users else 0,
            }
        finally:
            conn.disconnect()
    except Exception:
        return None


def _test_device_connection(device: dict) -> dict:
    zk   = _get_zk(
        device["ip_address"],
        device.get("port", 4370),
        int(device.get("comm_password", 0)),
    )
    conn = zk.connect()
    try:
        return {
            "serialNumber": conn.get_serialnumber(),
            "firmware":     conn.get_firmware_version(),
            "userCount":    len(conn.get_users() or []),
        }
    finally:
        conn.disconnect()


def _sync_users_batch_to_device(device: dict, users: list):
    zk     = _get_zk(
        device["ip_address"],
        device.get("port", 4370),
        int(device.get("comm_password", 0)),
    )
    conn   = zk.connect()
    synced = 0
    failed = 0
    try:
        for u in users:
            try:
                conn.set_user(
                    uid=u["identix_uid"],
                    name=u.get("full_name", "")[:24],
                    privilege=0,
                    password="",
                    group_id="",
                    user_id=str(u.get("id", u["identix_uid"])),
                    card=0,
                )
                synced += 1
            except Exception:
                failed += 1
    finally:
        conn.disconnect()
    return synced, failed


def _sync_single_user_to_device(device: dict, identix_uid: int, user_doc: dict):
    zk   = _get_zk(
        device["ip_address"],
        device.get("port", 4370),
        int(device.get("comm_password", 0)),
    )
    conn = zk.connect()
    try:
        conn.set_user(
            uid=identix_uid,
            name=user_doc.get("full_name", "")[:24],
            privilege=0,
            password="",
            group_id="",
            user_id=str(user_doc.get("id", identix_uid)),
            card=0,
        )
    finally:
        conn.disconnect()


def _remove_user_from_device(device: dict, identix_uid: int):
    zk   = _get_zk(
        device["ip_address"],
        device.get("port", 4370),
        int(device.get("comm_password", 0)),
    )
    conn = zk.connect()
    try:
        conn.delete_user(uid=identix_uid)
    finally:
        conn.disconnect()


def _fetch_attendance_from_device(device: dict, from_dt=None) -> list:
    zk   = _get_zk(
        device["ip_address"],
        device.get("port", 4370),
        int(device.get("comm_password", 0)),
    )
    conn = zk.connect()
    try:
        result = []
        for att in conn.get_attendance():
            punch_time = att.timestamp
            if isinstance(punch_time, str):
                punch_time = datetime.fromisoformat(punch_time)
            if from_dt and punch_time < from_dt:
                continue
            result.append({
                "device_user_id": att.user_id,
                "punch_time":     punch_time.isoformat(),
                "punch_type":     "out" if getattr(att, "punch", 0) == 1 else "in",
                "verify_mode":    getattr(att, "status", 0),
                "log_id":         getattr(att, "uid", None),
            })
        return result
    finally:
        conn.disconnect()


# ─────────────────────────────────────────────────────────────────────────────
# LAN SCAN — background coroutine
# ─────────────────────────────────────────────────────────────────────────────

def _auto_detect_subnet() -> str:
    """Attempt to detect the host's local subnet. Falls back to 192.168.1."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        parts = local_ip.split(".")
        return ".".join(parts[:3])
    except Exception:
        return "192.168.1"


async def _do_lan_scan(
    scan_id: str,
    subnet: str,
    port: int,
    registered_ips: set,
):
    """Concurrently probe all 254 hosts on the /24 subnet."""
    state   = _SCAN_STATE[scan_id]
    hosts   = [f"{subnet}.{i}" for i in range(1, 255)]
    total   = len(hosts)
    done_ct = 0
    sem     = asyncio.Semaphore(64)

    async def probe(ip: str):
        nonlocal done_ct
        async with sem:
            reachable = await _tcp_reachable(ip, port, timeout=1.5)
            if reachable:
                loop        = asyncio.get_event_loop()
                device_info = await loop.run_in_executor(
                    None, _try_get_device_info, ip, port
                )
                entry = {
                    "ip_address":         ip,
                    "port":               port,
                    "device_info":        device_info,
                    "already_registered": ip in registered_ips,
                }
                state["found"].append(entry)
                state["message"] = (
                    f"Found {len(state['found'])} device(s) so far… "
                    f"({done_ct}/{total} hosts checked)"
                )
        done_ct += 1
        state["progress"] = int((done_ct / total) * 100)

    await asyncio.gather(*[probe(ip) for ip in hosts])

    state["done"]     = True
    state["progress"] = 100
    count             = len(state["found"])
    state["message"]  = (
        f"Scan complete — {count} ZKTeco device(s) found on {subnet}.0/24"
        if count else
        f"Scan complete — no devices found on {subnet}.0/24 port {port}"
    )


# ─────────────────────────────────────────────────────────────────────────────
# BACKGROUND TASK — sync new user to all active devices
# ─────────────────────────────────────────────────────────────────────────────

# ─── ADMS COMMAND QUEUE HELPERS ──────────────────────────────────────────────

async def _next_seq_id(sn: str) -> int:
    """Monotonically increasing sequence ID per device for ADMS command IDs."""
    counter = await db.counters.find_one_and_update(
        {"_id": f"adms_seq_{sn}"},
        {"$inc": {"seq": 1}},
        upsert=True,
        return_document=True,
    )
    return counter.get("seq", 1)


async def _queue_user_cmd(sn: str, identix_uid: int, name: str, user_id: str):
    """
    Insert a DATA USER command into the pending queue for a specific device SN.
    Format accepted by ZKTeco/Identix ADMS firmware:
      DATA USER UID=1\tUserID=emp001\tName=John Doe\tPri=0\tPasswd=\tCard=0\tGrp=1\tTZ=0000000000000000\tVerify=0\tViceCard=0
    """
    safe_name = (name or "")[:24].replace("\t", " ").replace("\n", " ")
    # UserID must be SHORT numeric string — Identix firmware rejects UUIDs
    # ZKTeco/Identix ADMS firmware accepts USERINFO updates using the
    # DATA UPDATE USERINFO command.  The older `DATA USER ...` syntax is
    # rejected by a number of PUSH/ADMS firmwares (often with -1002).
    cmd_str = (
        f"DATA UPDATE USERINFO PIN={identix_uid}\t"
        f"Name={safe_name}\t"
        f"Privilege=0\t"
        f"Password=\t"
        f"Card=0\t"
        f"Group=1"
    )
    seq = await _next_seq_id(sn)
    await db.identix_cmd_queue.insert_one({
        "cmd_id":        str(uuid.uuid4()),
        "seq_id":        seq,
        "device_serial": sn,
        "cmd_str":       cmd_str,
        "status":        "pending",
        "created_at":    datetime.now(timezone.utc).isoformat(),
        "sent_at":       None,
    })
    logger.info(f"📥 Queued user cmd for SN={sn} uid={identix_uid} name={safe_name}")


async def _queue_fingerprint_query(sn: str, identix_uid: int, user_id: Optional[str] = None):
    """Ask the ADMS device to upload all fingerprints for one employee.

    The device returns the templates through /iclock/cdata.  We never persist
    the biometric template itself; _process_fingerprint_uploads() stores only
    fingerprint slot/status metadata.
    """
    if not sn or identix_uid is None:
        return None
    seq = await _next_seq_id(sn)
    cmd_str = f"DATA QUERY FINGERTMP PIN={identix_uid}"
    await db.identix_cmd_queue.insert_one({
        "cmd_id":        str(uuid.uuid4()),
        "seq_id":        seq,
        "device_serial": sn,
        "cmd_str":        cmd_str,
        "status":        "pending",
        "created_at":    datetime.now(timezone.utc).isoformat(),
        "sent_at":       None,
        "user_id":       user_id,
        "identix_uid":   identix_uid,
        "purpose":       "fingerprint_reconcile",
    })
    logger.info(f"🖐️ Queued fingerprint query for SN={sn} PIN={identix_uid}")
    return seq


async def _prepare_fingerprint_reconciliation(sn: str):
    """Queue a one-time fingerprint reconciliation for existing employees.

    Existing employees may have been enrolled on the physical machine before
    Taskosphere started tracking fingerprint events. Querying FINGERTMP asks
    the device to send those existing templates through ADMS so the enrollment
    tab can be brought up to date without re-pushing or re-enrolling users.
    """
    if not sn:
        return 0

    users = await db.users.find(
        {
            "is_active": {"$ne": False},
            "identix_uid": {"$exists": True, "$ne": None},
        },
        {"_id": 0, "id": 1, "identix_uid": 1},
    ).to_list(5000)

    queued = 0
    for user in users:
        try:
            identix_uid = int(user.get("identix_uid"))
        except (TypeError, ValueError):
            continue

        # Reset only the local machine-derived fingerprint state before the
        # query. If the machine has no fingerprint, the employee correctly
        # remains "Not Added" after reconciliation.
        await db.users.update_one(
            {"id": user["id"]},
            {"$set": {
                "identix_fingerprint_fids": [],
                "identix_fingerprint_count": 0,
                "fingerprint_source": "machine_reconcile",
                "fingerprint_reconcile_requested_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        await _queue_fingerprint_query(sn, identix_uid, user.get("id"))
        queued += 1

    logger.info(
        f"🔄 Existing fingerprint reconciliation queued | SN={sn} | employees={queued}"
    )
    return queued


async def _queue_user_to_all_devices(user_doc: dict) -> int:
    """Queue a user-add command for every active device. Returns count of queued devices."""
    devices = await db.identix_devices.find({"is_active": True}).to_list(50)
    identix_uid = user_doc.get("identix_uid")
    if not identix_uid:
        return 0
    queued = 0
    for device in devices:
        sn = device.get("serial_number", "")
        if not sn:
            continue
        try:
            await _queue_user_cmd(sn, identix_uid, user_doc.get("full_name", ""), user_doc.get("id", ""))
            queued += 1
        except Exception as e:
            logger.error(f"Failed to queue user for device {device.get('name')}: {e}")
    return queued


async def sync_user_to_identix_devices(user_doc: dict):
    """Background task: assign identix_uid and queue ADMS user-add command."""
    try:
        devices = await db.identix_devices.find({"is_active": True}).to_list(50)
        if not devices:
            logger.info("No active Identix devices to sync user to")
            return

        identix_uid = user_doc.get("identix_uid")
        if not identix_uid:
            counter = await db.counters.find_one_and_update(
                {"_id": "identix_uid"},
                {"$inc": {"seq": 1}},
                upsert=True,
                return_document=True,
            )
            identix_uid = counter.get("seq", 1)
            await db.users.update_one(
                {"id": user_doc["id"]},
                {"$set": {
                    "identix_uid":      identix_uid,
                    "identix_enrolled": False,
                    "thumb_enrolled":   False,
                }},
            )
            user_doc["identix_uid"] = identix_uid

        queued = await _queue_user_to_all_devices(user_doc)
        if queued:
            # Do not mark the user as synced merely because a command was queued.
            # The real device state is confirmed by /iclock/devicecmd Return=0.
            await db.users.update_one(
                {"id": user_doc["id"]},
                {"$set": {"identix_enrolled": False}},
            )
            logger.info(f"📤 User {user_doc.get('full_name')} queued for {queued} device(s); waiting for device ACK")
        else:
            logger.warning(f"No devices with serial numbers found to queue user {user_doc.get('full_name')}")

    except Exception as e:
        logger.error(
            f"sync_user_to_identix_devices failed: {e}\n{traceback.format_exc()}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# PYDANTIC MODELS
# ─────────────────────────────────────────────────────────────────────────────

class DeviceCreate(BaseModel):
    name:           str
    serial_number:  str                   # Required for ADMS domain mode
    ip_address:     str = "adms-domain"   # Not used in domain mode
    port:           int = 4370
    comm_password:  str = "0"
    location:       Optional[str] = None


class DeviceUpdate(BaseModel):
    name:           Optional[str]  = None
    ip_address:     Optional[str]  = None
    port:           Optional[int]  = None
    comm_password:  Optional[str]  = None
    is_active:      Optional[bool] = None
    location:       Optional[str]  = None
    serial_number:  Optional[str]  = None


class SyncRequest(BaseModel):
    device_id:  Optional[str] = None
    from_date:  Optional[str] = None
    to_date:    Optional[str] = None


class ScanRequest(BaseModel):
    subnet: Optional[str] = None
    port:   int           = 4370


# ─────────────────────────────────────────────────────────────────────────────
# MACHINE ATTENDANCE NORMALISATION
# ─────────────────────────────────────────────────────────────────────────────

# Identix X2008 is configured for India in the user's environment. ADMS punch
# timestamps are machine-local wall-clock values (e.g. "10:31:22"), not UTC.
# Keep the timezone explicit throughout the biometric integration and store
# canonical attendance timestamps in UTC, just like Taskosphere's manual
# attendance endpoint does.
MACHINE_TZ = ZoneInfo("Asia/Kolkata")

_INDEX_READY = False
_INDEX_LOCK = asyncio.Lock()


def _machine_now_text() -> str:
    """Return the current time in the terminal's local timezone.

    Render runs on UTC.  Never format ``datetime.now()`` directly for an
    Identix terminal: doing so makes the terminal receive UTC (or a partially
    parsed timezone offset) and can shift punch times.  The ADMS time response
    is deliberately a wall-clock value with no timezone suffix.
    """
    return datetime.now(timezone.utc).astimezone(MACHINE_TZ).strftime(
        "%Y-%m-%d %H:%M:%S"
    )


async def _ensure_identix_indexes():
    """Create safe indexes used by the ADMS ingestion path once per process."""
    global _INDEX_READY
    if _INDEX_READY:
        return
    async with _INDEX_LOCK:
        if _INDEX_READY:
            return
        try:
            # Partial unique index only covers new records that carry event_id,
            # so existing legacy records without event_id cannot break startup.
            await db.identix_attendance.create_index(
                [("event_id", 1)],
                unique=True,
                partialFilterExpression={"event_id": {"$exists": True}},
                name="identix_event_id_unique",
            )
            await db.identix_attendance.create_index(
                [("device_serial", 1), ("punch_time", 1)],
                name="identix_device_punch_time",
            )
            await db.identix_attendance.create_index(
                [("device_user_id", 1), ("punch_time", 1)],
                name="identix_user_punch_time",
            )
            _INDEX_READY = True
        except Exception:
            # Index creation must never prevent the ADMS endpoint from accepting
            # a punch. The event-id upsert remains idempotent when the unique
            # index is available, and legacy duplicate checks still apply.
            logger.exception("Failed to initialise Identix attendance indexes")


def _parse_machine_timestamp(value: Any) -> datetime:
    """Parse an Identix timestamp and return an aware IST datetime.

    ADMS commonly sends `YYYY-MM-DD HH:MM:SS` without an offset. Such a value
    represents the time shown on the X2008, so it must be interpreted as IST,
    not UTC. If a future firmware sends an explicit offset, we honour it.
    """
    if isinstance(value, datetime):
        dt = value
    else:
        text = str(value or "").strip()
        if not text:
            raise ValueError("Empty machine punch timestamp")

        # Normalise a trailing Z for datetime.fromisoformat().
        iso_text = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
        try:
            dt = datetime.fromisoformat(iso_text)
        except ValueError:
            parsed = None
            for fmt in (
                "%Y-%m-%d %H:%M:%S",
                "%Y-%m-%d %H:%M",
                "%Y/%m/%d %H:%M:%S",
                "%Y/%m/%d %H:%M",
            ):
                try:
                    parsed = datetime.strptime(text, fmt)
                    break
                except ValueError:
                    continue
            if parsed is None:
                raise ValueError(f"Unsupported machine punch timestamp: {text}")
            dt = parsed

    if dt.tzinfo is None:
        return dt.replace(tzinfo=MACHINE_TZ)
    return dt.astimezone(MACHINE_TZ)


def _to_utc(dt: datetime) -> datetime:
    """Return an aware UTC datetime, treating legacy naive values as UTC."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _read_attendance_datetime(value: Any) -> Optional[datetime]:
    """Read a stored attendance timestamp safely."""
    if value is None:
        return None
    try:
        if isinstance(value, datetime):
            return _to_utc(value)
        return _to_utc(datetime.fromisoformat(str(value)))
    except Exception:
        return None


def _late_for_user(user: dict, punch_dt_ist: datetime) -> bool:
    try:
        pit = datetime.strptime(user.get("punch_in_time") or "10:30", "%H:%M")
        gt = datetime.strptime(user.get("grace_time") or "00:10", "%H:%M")
        grace_minutes = gt.hour * 60 + gt.minute
        deadline = punch_dt_ist.replace(
            hour=pit.hour, minute=pit.minute, second=0, microsecond=0
        ) + timedelta(minutes=grace_minutes)
        return punch_dt_ist > deadline
    except Exception:
        return False


def _early_out_for_user(user: dict, punch_dt_ist: datetime) -> bool:
    try:
        pot = datetime.strptime(user.get("punch_out_time") or "19:00", "%H:%M")
        expected = punch_dt_ist.replace(
            hour=pot.hour, minute=pot.minute, second=0, microsecond=0
        )
        return punch_dt_ist < expected
    except Exception:
        return False


def _overtime_for_user(user: dict, punch_dt_ist: datetime) -> int:
    try:
        pot = datetime.strptime(user.get("punch_out_time") or "19:00", "%H:%M")
        expected = punch_dt_ist.replace(
            hour=pot.hour, minute=pot.minute, second=0, microsecond=0
        )
        return max(0, int((punch_dt_ist - expected).total_seconds() / 60))
    except Exception:
        return 0


def _machine_event_id(
    device_serial: str,
    device_user_id: str,
    punch_time_raw: str,
    punch_type: str,
    punch_code: Optional[str] = None,
    log_id: Optional[Any] = None,
) -> str:
    """Build a deterministic event ID so ADMS retries cannot create duplicates."""
    material = "|".join(
        [
            str(device_serial or ""),
            str(device_user_id or ""),
            str(punch_time_raw or ""),
            str(punch_type or ""),
            str(punch_code or ""),
            str(log_id if log_id is not None else ""),
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()


def _punch_code_to_type(code: Any) -> Optional[str]:
    """Map standard Identix/ZK ADMS punch codes to IN/OUT.

    Unknown codes are ignored instead of being incorrectly treated as OUT.
    """
    code = str(code).strip()
    if code in {"0", "4"}:
        return "in"
    if code in {"1", "5"}:
        return "out"
    return None


async def _find_identix_user(device_user_id: str) -> Optional[dict]:
    """Resolve a machine UID to a Taskosphere user."""
    projection = {
        "_id": 0,
        "id": 1,
        "full_name": 1,
        "departments": 1,
        "identix_uid": 1,
        "punch_in_time": 1,
        "grace_time": 1,
        "punch_out_time": 1,
    }

    if str(device_user_id).isdigit():
        user = await db.users.find_one(
            {"identix_uid": int(device_user_id)}, projection
        )
        if user:
            return user

    return await db.users.find_one(
        {"identix_uid": str(device_user_id)}, projection
    )


async def _store_machine_raw_punch(
    *,
    event_id: str,
    device_serial: str,
    device_id: Optional[str],
    device_name: Optional[str],
    device_user_id: str,
    punch_time_raw: str,
    punch_type: str,
    punch_code: Optional[str],
    verify_mode: Any = 0,
    log_id: Optional[Any] = None,
    source: str = "machine_push",
    user: Optional[dict] = None,
) -> bool:
    """Atomically insert a raw punch. Returns True only for a new event."""
    await _ensure_identix_indexes()

    try:
        punch_dt_ist = _parse_machine_timestamp(punch_time_raw)
    except Exception:
        punch_dt_ist = None

    record = {
        "id": str(uuid.uuid4()),
        "event_id": event_id,
        "device_id": device_id,
        "device_serial": device_serial or None,
        "device_name": device_name,
        "device_user_id": str(device_user_id),
        "punch_time": str(punch_time_raw),
        "punch_type": punch_type,
        "punch_code": str(punch_code) if punch_code is not None else None,
        "verify_mode": verify_mode,
        "log_id": log_id,
        "source": source,
        "user_id": user.get("id") if user else None,
        "user_name": user.get("full_name") if user else None,
        "department": (
            user.get("departments", [None])[0]
            if user and user.get("departments")
            else None
        ),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    if punch_dt_ist is not None:
        record["punch_time_ist"] = punch_dt_ist.isoformat()
        record["punch_time_utc"] = punch_dt_ist.astimezone(timezone.utc)

    try:
        result = await db.identix_attendance.update_one(
            {"event_id": event_id},
            {"$setOnInsert": record},
            upsert=True,
        )
        return bool(result.upserted_id is not None)
    except Exception as exc:
        if exc.__class__.__name__ == "DuplicateKeyError":
            return False
        raise


async def _mirror_machine_punch(
    *,
    user: dict,
    punch_time_raw: str,
    punch_type: str,
    source: str,
    device_name: Optional[str] = None,
    device_serial: Optional[str] = None,
    event_id: Optional[str] = None,
) -> bool:
    """Mirror one accepted biometric punch into Taskosphere attendance.

    Main attendance timestamps are stored as UTC datetimes. Local date, late,
    early-out and overtime calculations are performed in Asia/Kolkata.
    """
    punch_dt_ist = _parse_machine_timestamp(punch_time_raw)
    punch_dt_utc = punch_dt_ist.astimezone(timezone.utc)
    date_str = punch_dt_ist.date().isoformat()
    user_id = user["id"]

    existing_att = await db.attendance.find_one(
        {"user_id": user_id, "date": date_str}, {"_id": 0}
    )

    if punch_type == "in":
        current_in = _read_attendance_datetime(
            existing_att.get("punch_in") if existing_att else None
        )

        update_fields = {
            "status": "present",
            "auto_marked": False,
            "source": source,
            "device_name": device_name,
            "device_serial": device_serial,
            "last_machine_punch_at": punch_dt_utc,
        }
        if event_id:
            update_fields["last_machine_event_id"] = event_id

        # Keep the earliest IN punch of the day. This protects against
        # duplicate/late ADMS retries and multiple accidental IN punches.
        if current_in is None or punch_dt_utc < current_in:
            update_fields.update({
                "punch_in": punch_dt_utc,
                "is_late": _late_for_user(user, punch_dt_ist),
                "leave_reason": None,
            })

            # If OUT arrived before IN, reconcile it now when the sequence is
            # valid. This makes the integration resilient to out-of-order ADMS
            # delivery/retries.
            existing_out = _read_attendance_datetime(
                existing_att.get("punch_out") if existing_att else None
            )
            if existing_out and existing_out >= punch_dt_utc:
                duration = max(
                    0, int((existing_out - punch_dt_utc).total_seconds() / 60)
                )
                existing_out_ist = existing_out.astimezone(MACHINE_TZ)
                update_fields.update({
                    "duration_minutes": duration,
                    "punched_out_early": _early_out_for_user(
                        user, existing_out_ist
                    ),
                    "overtime_minutes": _overtime_for_user(
                        user, existing_out_ist
                    ),
                })

        await db.attendance.update_one(
            {"user_id": user_id, "date": date_str},
            {"$set": update_fields},
            upsert=True,
        )
        return True

    if punch_type == "out":
        current_out = _read_attendance_datetime(
            existing_att.get("punch_out") if existing_att else None
        )

        # STRICT SINGLE PUNCH-OUT RULE:
        # Once any punch-out has been recorded for the day, the biometric
        # device must never overwrite it with another OUT event. A second
        # punch-out is allowed only after an administrator explicitly edits
        # or resets the previous punch-out through the admin attendance flow.
        if current_out is not None:
            logger.warning(
                "Ignoring duplicate machine OUT | user=%s date=%s existing=%s incoming=%s serial=%s",
                user_id, date_str, current_out, punch_dt_utc, device_serial,
            )
            return False

        punch_in_dt = _read_attendance_datetime(
            existing_att.get("punch_in") if existing_att else None
        )

        update_fields = {
            "status": "present",
            "punch_out": punch_dt_utc,
            "punch_out_source": "machine",
            "punch_out_device_serial": device_serial,
            "source": source,
            "device_name": device_name,
            "device_serial": device_serial,
            "last_machine_punch_at": punch_dt_utc,
            "punched_out_early": _early_out_for_user(user, punch_dt_ist),
            "overtime_minutes": _overtime_for_user(user, punch_dt_ist),
        }
        if event_id:
            update_fields["last_machine_event_id"] = event_id

        if punch_in_dt is not None:
            update_fields["duration_minutes"] = max(
                0, int((punch_dt_utc - punch_in_dt).total_seconds() / 60)
            )
        else:
            # Keep the OUT event even if IN has not arrived yet; the IN handler
            # above will reconcile it if the later IN timestamp is earlier.
            update_fields["auto_marked"] = False

        await db.attendance.update_one(
            {"user_id": user_id, "date": date_str},
            {"$set": update_fields},
            upsert=True,
        )
        return True

    return False


# ─────────────────────────────────────────────────────────────────────────────
# DEVICE ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@identix_router.get("/devices")
async def list_devices(current_user: User = Depends(require_admin())):
    devices = await db.identix_devices.find({}, {"_id": 0}).to_list(100)
    now = datetime.now(timezone.utc)
    for d in devices:
        last_hb = d.get("last_heartbeat_at")
        if last_hb:
            try:
                hb_dt = datetime.fromisoformat(last_hb)
                if hb_dt.tzinfo is None:
                    hb_dt = hb_dt.replace(tzinfo=timezone.utc)
                minutes_ago = (now - hb_dt).total_seconds() / 60
                d["is_online"] = minutes_ago <= 10
                d["minutes_since_heartbeat"] = round(minutes_ago, 1)
            except Exception:
                d["is_online"] = False
                d["minutes_since_heartbeat"] = None
        else:
            d["is_online"] = False
            d["minutes_since_heartbeat"] = None
    return {"devices": devices}


@identix_router.post("/devices")
async def add_device(
    payload: DeviceCreate,
    current_user: User = Depends(require_admin()),
):
    device_id = str(uuid.uuid4())
    doc = {
        "id":            device_id,
        "name":          payload.name,
        "ip_address":    payload.ip_address,
        "port":          payload.port,
        "comm_password": payload.comm_password,
        "serial_number": _normalize_serial_number(payload.serial_number),
        "location":      payload.location,
        "is_active":     True,
        "last_sync_at":  None,
        "created_at":    datetime.now(timezone.utc).isoformat(),
    }
    await db.identix_devices.insert_one(doc)
    doc.pop("_id", None)
    return {"device": doc, "message": "Device registered successfully"}


@identix_router.put("/devices/{device_id}")
async def update_device(
    device_id: str,
    payload: DeviceUpdate,
    current_user: User = Depends(require_admin()),
):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if "serial_number" in updates:
        updates["serial_number"] = _normalize_serial_number(updates["serial_number"])
    if not updates:
        raise HTTPException(status_code=400, detail="Nothing to update")
    result = await db.identix_devices.find_one_and_update(
        {"id": device_id},
        {"$set": updates},
        return_document=True,
    )
    if not result:
        raise HTTPException(status_code=404, detail="Device not found")
    result.pop("_id", None)
    return {"device": result}


@identix_router.delete("/devices/{device_id}")
async def delete_device(
    device_id: str,
    current_user: User = Depends(require_admin()),
):
    result = await db.identix_devices.delete_one({"id": device_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Device not found")
    return {"message": "Device deleted"}


@identix_router.post("/devices/{device_id}/test")
async def test_device(
    device_id: str,
    current_user: User = Depends(require_admin()),
):
    """
    ADMS Cloud Connectivity Check.
    Instead of trying a direct LAN TCP connection (which always fails from cloud),
    this checks whether the device has recently sent a heartbeat to this server.
    A device is considered "connected" if it sent a heartbeat within the last 10 minutes.
    """
    device = await db.identix_devices.find_one({"id": device_id}, {"_id": 0})
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    last_heartbeat = device.get("last_heartbeat_at")
    is_online = device.get("is_online", False)
    sn = device.get("serial_number", "")

    if last_heartbeat:
        try:
            hb_dt = datetime.fromisoformat(last_heartbeat)
            if hb_dt.tzinfo is None:
                hb_dt = hb_dt.replace(tzinfo=timezone.utc)
            minutes_ago = (datetime.now(timezone.utc) - hb_dt).total_seconds() / 60
            if minutes_ago <= 10:
                return {
                    "success": True,
                    "connection_type": "adms_cloud",
                    "message": f"✓ Machine is connected via ADMS. Last heartbeat {int(minutes_ago)}m ago.",
                    "last_heartbeat_at": last_heartbeat,
                    "minutes_since_heartbeat": round(minutes_ago, 1),
                    "deviceInfo": {"serialNumber": sn},
                }
            else:
                return {
                    "success": False,
                    "connection_type": "adms_cloud",
                    "message": f"Machine last seen {int(minutes_ago)} minutes ago. It may be offline or ADMS is not configured correctly.",
                    "last_heartbeat_at": last_heartbeat,
                    "minutes_since_heartbeat": round(minutes_ago, 1),
                    "deviceInfo": None,
                }
        except Exception:
            pass

    return {
        "success": False,
        "connection_type": "adms_cloud",
        "message": "No heartbeat received yet. Configure ADMS on the machine with this server's URL.",
        "last_heartbeat_at": None,
        "minutes_since_heartbeat": None,
        "deviceInfo": None,
    }



@identix_router.post("/devices/{device_id}/sync-users")
async def sync_users_to_device(
    device_id: str,
    current_user: User = Depends(require_admin()),
):
    device = await db.identix_devices.find_one({"id": device_id}, {"_id": 0})
    if not device:
        raise HTTPException(status_code=404, detail="Device not found")

    # Fetch ALL active users (not just those with identix_uid already assigned)
    all_users = await db.users.find(
        {"is_active": True},
        {"_id": 0, "id": 1, "full_name": 1, "identix_uid": 1},
    ).to_list(1000)

    if not all_users:
        return {
            "success": True,
            "synced":  0,
            "failed":  0,
            "message": "No active users found",
        }

    sn = device.get("serial_number", "")
    if not sn:
        raise HTTPException(status_code=400, detail="Device has no serial number configured")

    batch_id = str(uuid.uuid4())
    queued = 0
    failed = 0
    command_ids = []
    for u in all_users:
        try:
            identix_uid = u.get("identix_uid")
            # Auto-assign a UID if user doesn't have one yet
            if not identix_uid:
                counter = await db.counters.find_one_and_update(
                    {"_id": "identix_uid"},
                    {"$inc": {"seq": 1}},
                    upsert=True,
                    return_document=True,
                )
                identix_uid = counter.get("seq", 1)
                await db.users.update_one(
                    {"id": u["id"]},
                    {"$set": {
                        "identix_uid":      identix_uid,
                        "identix_enrolled": False,
                        "thumb_enrolled":   False,
                    }},
                )
            # Do not create duplicate pending/sent commands for the same user
            # when the operator double-clicks Sync Users.
            existing = await db.identix_cmd_queue.find_one({
                "device_serial": sn,
                "identix_uid": int(identix_uid),
                "status": {"$in": ["pending", "sent"]},
            }, {"_id": 0, "cmd_id": 1})
            if existing:
                command_ids.append(existing.get("cmd_id"))
                queued += 1
                continue

            safe_name = (u.get("full_name") or "")[:24].replace("\t", " ").replace("\n", " ")
            seq = await _next_seq_id(sn)
            cmd_id = str(uuid.uuid4())
            cmd_str = (
                f"DATA UPDATE USERINFO PIN={int(identix_uid)}\t"
                f"Name={safe_name}\t"
                f"Privilege=0\tPassword=\tCard=0\tGroup=1"
            )
            await db.identix_cmd_queue.insert_one({
                "cmd_id": cmd_id,
                "seq_id": seq,
                "device_serial": sn,
                "identix_uid": int(identix_uid),
                "user_id": u.get("id"),
                "user_name": u.get("full_name", ""),
                "batch_id": batch_id,
                "cmd_str": cmd_str,
                "status": "pending",
                "created_at": datetime.now(timezone.utc).isoformat(),
                "sent_at": None,
                "acknowledged_at": None,
                "return_code": None,
            })
            logger.info(f"📥 Queued user cmd batch={batch_id} SN={sn} uid={identix_uid} name={safe_name}")
            command_ids.append(cmd_id)
            # The device must ACK Return=0 before this is shown as Synced.
            await db.users.update_one({"id": u["id"]}, {"$set": {"identix_enrolled": False}})
            queued += 1
        except Exception as eq:
            logger.warning(f"Failed to queue user {u.get('full_name')}: {eq}")
            failed += 1

    return {
        "success": True,
        "synced":  queued,
        "failed":  failed,
        "batch_id": batch_id,
        "command_ids": command_ids,
        "message": f"Queued {queued} user(s) for ADMS push to {device.get('name')}. Waiting for the machine's ADMS polling cycle.",
    }


# ─────────────────────────────────────────────────────────────────────────────
# LAN SCAN ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@identix_router.post("/devices/scan")
async def start_lan_scan(
    payload: ScanRequest,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_admin()),
):
    """
    Kick off an async LAN scan for ZKTeco/Identix devices.
    Returns a scan_id immediately; poll GET /devices/scan/{scan_id} for results.
    """
    scan_id = str(uuid.uuid4())

    subnet = (payload.subnet or "").strip()
    if not subnet:
        subnet = _auto_detect_subnet()

    existing       = await db.identix_devices.find({}, {"_id": 0, "ip_address": 1}).to_list(100)
    registered_ips = {d["ip_address"] for d in existing}

    _SCAN_STATE[scan_id] = {
        "done":     False,
        "progress": 0,
        "found":    [],
        "subnet":   subnet,
        "port":     payload.port,
        "message":  f"Scanning {subnet}.0/24 on port {payload.port}…",
    }

    background_tasks.add_task(
        _do_lan_scan, scan_id, subnet, payload.port, registered_ips
    )

    return {
        "scan_id": scan_id,
        "subnet":  subnet,
        "port":    payload.port,
        "message": f"Scanning {subnet}.0/24 on port {payload.port}…",
    }


@identix_router.get("/devices/scan/{scan_id}")
async def poll_lan_scan(
    scan_id: str,
    current_user: User = Depends(require_admin()),
):
    """Poll the status and results of an in-progress LAN scan."""
    state = _SCAN_STATE.get(scan_id)
    if not state:
        raise HTTPException(status_code=404, detail="Scan not found or expired")
    return state


# ─────────────────────────────────────────────────────────────────────────────
# ATTENDANCE ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@identix_router.get("/attendance/summary")
async def get_attendance_summary(current_user: User = Depends(require_admin())):
    """
    Returns today's attendance summary for the Identix dashboard.
    Fixes the 404 that was caused by this route being missing.
    """
    from zoneinfo import ZoneInfo
    IST      = ZoneInfo("Asia/Kolkata")
    today_str = datetime.now(IST).date().isoformat()

    total_employees = await db.users.count_documents({"is_active": True})
    pending_thumb   = await db.users.count_documents({
        "is_active":    True,
        "thumb_enrolled": {"$ne": True},
    })

    # Count distinct users present today (from main attendance collection)
    present_pipeline = [
        {"$match": {"date": today_str, "status": "present"}},
        {"$group": {"_id": "$user_id"}},
        {"$count": "total"},
    ]
    present_result = await db.attendance.aggregate(present_pipeline).to_list(1)
    total_present  = present_result[0]["total"] if present_result else 0
    total_absent   = max(0, total_employees - total_present)

    # Breakdown by department
    dept_pipeline = [
        {"$match": {"date": today_str, "status": "present"}},
        {"$lookup": {
            "from":         "users",
            "localField":   "user_id",
            "foreignField": "id",
            "as":           "user",
        }},
        {"$unwind": {"path": "$user", "preserveNullAndEmptyArrays": True}},
        {"$group": {
            "_id":     {"$arrayElemAt": ["$user.departments", 0]},
            "present": {"$sum": 1},
        }},
        {"$project": {"department": "$_id", "present": 1, "_id": 0}},
        {"$sort": {"present": -1}},
    ]
    by_department = await db.attendance.aggregate(dept_pipeline).to_list(50)

    # Recent machine punches today
    recent = await db.identix_attendance.find(
        {"punch_time": {"$gte": today_str}},
        {"_id": 0},
    ).sort("punch_time", -1).limit(20).to_list(20)

    return {
        "date":                   today_str,
        "totalEmployees":         total_employees,
        "totalPresent":           total_present,
        "totalAbsent":            total_absent,
        "pendingThumbEnrollment": pending_thumb,
        "byDepartment":           by_department,
        "recentActivity":         recent,
    }


@identix_router.get("/attendance")
async def get_identix_attendance(
    page:       int           = 1,
    limit:      int           = 50,
    from_date:  Optional[str] = None,
    to_date:    Optional[str] = None,
    department: Optional[str] = None,
    current_user: User        = Depends(require_admin()),
):
    """Paginated list of raw machine punch records."""
    query: Dict[str, Any] = {}
    if from_date or to_date:
        query["punch_time"] = {}
        if from_date:
            query["punch_time"]["$gte"] = from_date
        if to_date:
            query["punch_time"]["$lte"] = to_date + "T23:59:59"
    if department:
        query["department"] = department

    skip    = (page - 1) * limit
    total   = await db.identix_attendance.count_documents(query)
    records = await db.identix_attendance.find(
        query, {"_id": 0}
    ).sort("punch_time", -1).skip(skip).limit(limit).to_list(limit)

    return {"records": records, "total": total, "page": page}


@identix_router.post("/attendance/sync")
async def sync_attendance(
    payload:      SyncRequest,
    current_user: User = Depends(require_admin()),
):
    """
    Pull punch records from all active Identix/ZKTeco devices and mirror them
    into both identix_attendance (raw log) and the main attendance collection.
    """
    if payload.device_id:
        devices = await db.identix_devices.find(
            {"id": payload.device_id}, {"_id": 0}
        ).to_list(1)
    else:
        devices = await db.identix_devices.find(
            {"is_active": True}, {"_id": 0}
        ).to_list(50)

    if not devices:
        return {
            "success":      False,
            "newRecords":   0,
            "totalFetched": 0,
            "message":      "No active devices found",
            "errors":       [],
        }

    from_dt: Optional[datetime] = None
    if payload.from_date:
        try:
            from_dt = datetime.fromisoformat(payload.from_date)
        except ValueError:
            pass

    # Load all users who have an identix_uid assigned
    all_users = await db.users.find(
        {"identix_uid": {"$exists": True}},
        {
            "_id": 0,
            "id": 1,
            "full_name": 1,
            "identix_uid": 1,
            "departments": 1,
            "punch_in_time": 1,
            "grace_time": 1,
            "punch_out_time": 1,
        },
    ).to_list(1000)

    # Build lookup: device UID string → user document
    uid_to_user: Dict[str, dict] = {
        str(u["identix_uid"]): u
        for u in all_users
        if u.get("identix_uid")
    }

    total_new     = 0
    total_fetched = 0
    errors        = []

    for device in devices:
        try:
            logs: list = await asyncio.get_event_loop().run_in_executor(
                None, _fetch_attendance_from_device, device, from_dt
            )
            total_fetched += len(logs)

            for log in logs:
                device_uid     = str(log["device_user_id"])
                user           = uid_to_user.get(device_uid)
                punch_time_iso = log["punch_time"]   # ISO string
                punch_type     = log["punch_type"]   # "in" | "out"

                # ── Skip duplicates in identix_attendance ──────────────────
                event_id = _machine_event_id(
                    device.get("serial_number") or device.get("id", ""),
                    device_uid,
                    punch_time_iso,
                    punch_type,
                    log.get("verify_mode"),
                    log.get("log_id"),
                )

                # ── Skip duplicates in identix_attendance ──────────────────
                existing_raw = None
                if log.get("log_id") is not None:
                    existing_raw = await db.identix_attendance.find_one({
                        "log_id":    log.get("log_id"),
                        "device_id": device["id"],
                    })
                if existing_raw:
                    continue

                is_new = await _store_machine_raw_punch(
                    event_id=event_id,
                    device_serial=device.get("serial_number") or device.get("id", ""),
                    device_id=device["id"],
                    device_name=device.get("name"),
                    device_user_id=device_uid,
                    punch_time_raw=punch_time_iso,
                    punch_type=punch_type,
                    punch_code=None,
                    verify_mode=log.get("verify_mode", 0),
                    log_id=log.get("log_id"),
                    source="machine",
                    user=user,
                )
                if not is_new:
                    continue

                total_new += 1

                # ── Mirror into main attendance collection ─────────────────
                if not user:
                    continue

                try:
                    await _mirror_machine_punch(
                        user=user,
                        punch_time_raw=punch_time_iso,
                        punch_type=punch_type,
                        source="machine",
                        device_name=device.get("name"),
                        device_serial=device.get("serial_number"),
                        event_id=_machine_event_id(
                            device.get("serial_number") or device.get("id", ""),
                            device_uid,
                            punch_time_iso,
                            punch_type,
                            log.get("verify_mode"),
                            log.get("log_id"),
                        ),
                    )
                except Exception as mirror_err:
                    logger.warning(
                        f"Failed to mirror punch to main attendance "
                        f"(user={user.get('id')}): {mirror_err}"
                    )

            # Update last_sync_at on the device
            await db.identix_devices.update_one(
                {"id": device["id"]},
                {"$set": {"last_sync_at": datetime.now(timezone.utc).isoformat()}},
            )

        except Exception as e:
            errors.append(f"{device.get('name', device['id'])}: {str(e)}")
            logger.error(f"Failed to sync from {device.get('name')}: {e}")

    return {
        "success":      len(errors) == 0,
        "newRecords":   total_new,
        "totalFetched": total_fetched,
        "message": (
            f"Imported {total_new} new records from {len(devices)} device(s). "
            "Machine punches have been added to the main attendance system."
        ),
        "errors": errors,
    }


# ─────────────────────────────────────────────────────────────────────────────
# USER ENROLLMENT ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@identix_router.get("/users")
async def get_identix_users(current_user: User = Depends(require_admin())):
    users = await db.users.find(
        {},
        {
            "_id": 0,
            "id": 1,
            "full_name": 1,
            "email": 1,
            "role": 1,
            "departments": 1,
            "is_active": 1,
            "identix_uid": 1,
            "identix_enrolled": 1,
            "thumb_enrolled": 1,
            "identix_fingerprint_fids": 1,
            "identix_fingerprint_count": 1,
            "fingerprint_last_enrolled_at": 1,
            "fingerprint_last_seen_at": 1,
            "fingerprint_source": 1,
            "fingerprint_reconcile_requested_at": 1,
            "created_at": 1,
        },
    ).to_list(500)
    return {"users": users}


@identix_router.post("/users/reconcile-fingerprints")
async def reconcile_existing_fingerprints(
    current_user: User = Depends(require_admin()),
):
    """Manually re-fetch fingerprints for all existing employees from devices."""
    devices = await db.identix_devices.find({"is_active": True}, {"_id": 0, "serial_number": 1}).to_list(50)
    total = 0
    for device in devices:
        sn = _normalize_serial_number(device.get("serial_number", ""))
        if sn:
            total += await _prepare_fingerprint_reconciliation(sn)
    return {
        "queued": total,
        "message": f"Queued fingerprint reconciliation for {total} employee/device pair(s).",
    }


@identix_router.patch("/users/{user_id}/thumb-enrolled")
async def mark_thumb_enrolled(
    user_id:      str,
    current_user: User = Depends(require_admin()),
):
    result = await db.users.find_one_and_update(
        {"id": user_id},
        {"$set": {
            "thumb_enrolled": True,
            "fingerprint_source": "manual",
            "fingerprint_last_enrolled_at": datetime.now(timezone.utc).isoformat(),
        }},
        return_document=True,
    )
    if not result:
        raise HTTPException(status_code=404, detail="User not found")
    return {"message": "Thumb enrollment marked complete", "user_id": user_id}


@identix_router.post("/users/{user_id}/sync-to-device")
async def sync_single_user_to_devices(
    user_id:      str,
    current_user: User = Depends(require_admin()),
):
    """
    Queue a DATA USER command for all active devices.
    The machine picks it up next time it polls /iclock/devicecmd.
    """
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    # Assign identix_uid if not set
    if not user.get("identix_uid"):
        counter = await db.counters.find_one_and_update(
            {"_id": "identix_uid"},
            {"$inc": {"seq": 1}},
            upsert=True,
            return_document=True,
        )
        identix_uid = counter.get("seq", 1)
        await db.users.update_one(
            {"id": user_id},
            {"$set": {"identix_uid": identix_uid}},
        )
        user["identix_uid"] = identix_uid

    queued = await _queue_user_to_all_devices(user)
    await db.users.update_one(
        {"id": user_id},
        {"$set": {"identix_enrolled": False}},
    )
    return {
        "message": f"{user.get('full_name')} queued for push to {queued} device(s). Machine will receive the command on next poll.",
        "queued_devices": queued,
    }
# 🔹 Device handshake (VERY IMPORTANT)
def _normalize_serial_number(sn: Optional[str]) -> str:
    """Canonicalize ADMS serial numbers before comparing/storing them.

    ADMS firmware can send the same serial with different casing or accidental
    surrounding whitespace. The admin UI may still display the values as if
    they match, while an exact MongoDB equality query would not.
    """
    if sn is None:
        return ""
    return "".join(str(sn).strip().split()).upper()


async def _find_device_by_serial(sn: Optional[str], projection: Optional[dict] = None):
    """Find a registered device using a normalized/case-insensitive serial.

    First try the canonical exact value for the common path. Then fall back to
    a case-insensitive, whitespace-tolerant lookup so existing registrations
    created before serial normalization continue to work without manual edits.
    """
    canonical = _normalize_serial_number(sn)
    if not canonical:
        return None

    device = await db.identix_devices.find_one(
        {"serial_number": canonical}, projection
    )
    if device:
        return device

    # Existing records may contain case/whitespace differences.
    # The stored value is normalized after a successful match.
    escaped = re.escape(canonical)
    return await db.identix_devices.find_one(
        {"serial_number": {"$regex": f"^\\s*{escaped}\\s*$", "$options": "i"}},
        projection,
    )



# 🔹 Device handshake (VERY IMPORTANT)
async def _mark_device_online(sn: str):
    """Update heartbeat for the registered device, tolerating serial formatting differences."""
    canonical = _normalize_serial_number(sn)
    if not canonical:
        return

    now = datetime.now(timezone.utc).isoformat()
    device = await _find_device_by_serial(canonical, {"_id": 0, "id": 1, "serial_number": 1})
    if not device:
        logger.warning(f"⚠️  Heartbeat from unknown SN={sn} — not registered in DB")
        return

    # Also repair the stored serial once we have a valid registration.
    device_filter = {"id": device.get("id")} if device.get("id") else {"serial_number": device.get("serial_number")}
    await db.identix_devices.update_one(
        device_filter,
        {"$set": {
            "serial_number": canonical,
            "last_heartbeat_at": now,
            "is_online": True,
        }},
    )
    logger.info(f"✅ Device {canonical} marked online (received SN={sn!r})")

    # Existing employees may already have fingerprints on the machine from
    # before Taskosphere started listening for EnrollFP/ChgFP events. Trigger
    # one automatic reconciliation per device registration. The atomic update
    # prevents every heartbeat/cdata request from queuing the same queries.
    reconcile_claim = await db.identix_devices.find_one_and_update(
        {
            **device_filter,
            "fingerprint_reconcile_queued_at": {"$exists": False},
        },
        {"$set": {"fingerprint_reconcile_queued_at": now}},
        projection={"_id": 0, "id": 1, "serial_number": 1},
        return_document=True,
    )
    if reconcile_claim:
        asyncio.create_task(_prepare_fingerprint_reconciliation(canonical))



def _is_clock_setting_command(cmd_str: str) -> bool:
    """Return True for ADMS commands that can modify the physical clock.

    The attendance integration must never change the terminal's date/time.
    This guard also protects against stale SET OPTIONS DateTime commands left
    in MongoDB by an older deployment.
    """
    text = re.sub(r"\s+", " ", str(cmd_str or "").strip()).upper()
    if not text:
        return False
    return bool(
        re.match(r"^SET\s+OPTIONS?\s+.*\bDATETIME\s*=", text)
        or re.match(r"^SET\s+OPTIONS?\s+.*\bTIMEZONE\s*=", text)
        or re.match(r"^SET\s+OPTIONS?\s+.*\bSYNC(TIME)?\s*=", text)
    )


async def _block_queued_clock_commands(sn: str) -> int:
    """Block any legacy clock-setting commands already stored in the queue."""
    if not sn:
        return 0
    pending = await db.identix_cmd_queue.find(
        {"device_serial": sn, "status": {"$in": ["pending", "sent"]}},
        {"_id": 1, "cmd_str": 1},
    ).to_list(100)
    blocked = 0
    for cmd in pending:
        if _is_clock_setting_command(cmd.get("cmd_str", "")):
            await db.identix_cmd_queue.update_one(
                {"_id": cmd["_id"]},
                {"$set": {
                    "status": "blocked",
                    "blocked_reason": "Automatic device clock changes are disabled",
                    "blocked_at": datetime.now(timezone.utc).isoformat(),
                }},
            )
            blocked += 1
            logger.warning(
                f"⛔ Blocked legacy clock-setting command for SN={sn}: "
                f"{cmd.get('cmd_str', '')[:120]}"
            )
    return blocked


@identix_router.api_route("/iclock/getrequest", methods=["GET", "POST"])
async def iclock_getrequest(request: Request):
    from fastapi.responses import PlainTextResponse
    params = dict(request.query_params)
    sn = _normalize_serial_number(params.get("SN") or params.get("sn", ""))
    logger.info(f"📡 GETREQUEST from SN={sn}")
    await _mark_device_online(sn)

    # Never allow a legacy/stale clock-setting command to reach the terminal.
    await _block_queued_clock_commands(sn)

    # Check if there are pending commands for this device
    pending_count = 0
    if sn:
        pending_count = await db.identix_cmd_queue.count_documents({
            "device_serial": sn, "status": "pending"
        })

    # ZKTeco/Identix ADMS protocol:
    # Returning "OK" = no commands
    # Returning command lines triggers machine to call /iclock/devicecmd
    if pending_count > 0:
        logger.info(f"📬 {pending_count} pending command(s) for {sn} — signaling machine")

    # ZKTeco ADMS protocol:
    # - Pending commands: return "C:seq_id:CMD" lines → device calls /iclock/devicecmd
    # - No commands: return "OK" with timing headers
    if pending_count > 0:
        pending_cmds = await db.identix_cmd_queue.find(
            {"device_serial": sn, "status": "pending"},
            {"_id": 0}
        ).sort("seq_id", 1).to_list(50)
        cmd_lines = []
        for cmd in pending_cmds:
            seq = cmd.get("seq_id", 1)
            cmd_str = cmd.get("cmd_str", "")
            cmd_lines.append(f"C:{seq}:{cmd_str}")

        # IMPORTANT: GETREQUEST only delivers/signals commands.  Keep them
        # pending until /iclock/devicecmd acknowledges execution.  If the
        # device drops the connection after receiving GETREQUEST, the command
        # must remain retryable on the next poll.
        logger.info(
            f"📤 Sending {len(cmd_lines)} pending command(s) to SN={sn}; "
            "waiting for /iclock/devicecmd acknowledgement"
        )
        return PlainTextResponse("\n".join(cmd_lines) + "\n", headers={
            "Pragma": "no-cache",
            "Cache-Control": "no-store",
        })

    return PlainTextResponse("OK\n", headers={
        "Pragma": "no-cache",
        "Cache-Control": "no-store",
        "X-Heartbeat-Interval": "10",
        "X-Ping-Interval":      "10",
        "X-Push-Content":       "attlog",
    })



# ─────────────────────────────────────────────────────────────────────────────
# BIOMETRIC ENROLLMENT PUSH PARSER
# ZKTeco/Identix ADMS sends fingerprint templates through /iclock/cdata with
# table=OPERLOG.  Records have the form:
#   FP PIN=2\tFID=0\tSize=1124\tValid=1\tTMP=<base64>
# We deliberately do NOT persist the biometric template itself.  We only keep
# the enrolled fingerprint slot(s) and timestamps needed by the UI.
# ─────────────────────────────────────────────────────────────────────────────
async def _mark_fingerprint_seen_from_verify_mode(user: Optional[dict], verify_mode: Any) -> bool:
    """Infer fingerprint presence from a successful attendance verification.

    ADMS verify mode 1 is fingerprint; several firmware variants also report
    combined modes containing fingerprint (5, 6, 8, 9, 10, 12, 13, 14).
    This does not claim which finger was used; it only confirms that the device
    has a usable fingerprint template for this employee.
    """
    if not user:
        return False
    try:
        mode = int(str(verify_mode).strip())
    except (TypeError, ValueError):
        return False
    if mode not in {1, 5, 6, 8, 9, 10, 12, 13, 14}:
        return False
    now = datetime.now(timezone.utc).isoformat()
    await db.users.update_one(
        {"id": user["id"]},
        {"$set": {
            "thumb_enrolled": True,
            "fingerprint_source": "attendance_verify",
            "fingerprint_last_seen_at": now,
        }},
    )
    return True

async def _process_fingerprint_uploads(sn: str, raw: str, params: dict) -> int:
    table = str(params.get("table") or "").strip().upper()
    if table not in {"OPERLOG", "FP", "FINGERTMP"} and not re.search(r"(?m)^(?:FP|FINGERTMP)\s+PIN=", raw):
        return 0

    # TMP may be very large, so only parse the header.  The template is never
    # stored in MongoDB.  The lookahead stops at the next FP record or EOF.
    pattern = re.compile(
        r"(?m)^(?:FP|FINGERTMP)\s+PIN=(?P<pin>[^\t\s]+)\s*\t"
        r"(?:FID|FingerID)=(?P<fid>\d+)\s*\t"
        r"Size=(?P<size>\d+)\s*\t"
        r"Valid=(?P<valid>[01])\s*\t(?:TMP|Template)=",
        re.IGNORECASE,
    )
    matches = list(pattern.finditer(raw))
    if not matches:
        # A few firmware versions use spaces instead of tabs between fields.
        pattern = re.compile(
            r"(?m)^(?:FP|FINGERTMP)\s+PIN=(?P<pin>[^\t\s]+)\s+"
            r"(?:FID|FingerID)=(?P<fid>\d+)\s+"
            r"Size=(?P<size>\d+)\s+"
            r"Valid=(?P<valid>[01])\s+(?:TMP|Template)=",
            re.IGNORECASE,
        )
        matches = list(pattern.finditer(raw))

    processed = 0
    now = datetime.now(timezone.utc).isoformat()
    for match in matches:
        pin = match.group("pin").strip()
        fid = int(match.group("fid"))
        size = int(match.group("size"))
        valid = match.group("valid") == "1"
        if not pin or size <= 0:
            continue

        user = await _find_identix_user(pin)
        if not user:
            logger.warning(
                f"⚠️ Fingerprint upload from SN={sn} for unknown Identix PIN={pin}"
            )
            continue

        current = await db.users.find_one(
            {"id": user["id"]},
            {"_id": 0, "identix_fingerprint_fids": 1},
        )
        fids = {int(x) for x in (current or {}).get("identix_fingerprint_fids", []) if str(x).isdigit()}
        if valid:
            fids.add(fid)
        else:
            fids.discard(fid)

        update = {
            "identix_fingerprint_fids": sorted(fids),
            "identix_fingerprint_count": len(fids),
            # Keep the existing UI field for backward compatibility.
            "thumb_enrolled": bool(fids),
            "fingerprint_source": "machine_push",
            "fingerprint_last_seen_at": now,
        }
        if valid:
            update["fingerprint_last_enrolled_at"] = now
            update["fingerprint_last_fid"] = fid

        await db.users.update_one({"id": user["id"]}, {"$set": update})
        processed += 1
        logger.info(
            f"🖐️ Fingerprint {'enrolled' if valid else 'removed'} | "
            f"SN={sn} PIN={pin} FID={fid} total={len(fids)}"
        )

    return processed


# 🔹 Main attendance data endpoint — ADMS cloud push (machine → Render)
@identix_router.api_route("/iclock/cdata", methods=["GET", "POST"])
async def iclock_cdata(request: Request):
    """Receive Identix X2008 ADMS attendance pushes.

    The X2008 normally sends one or more tab-separated lines: 
    ``USER_ID<TAB>YYYY-MM-DD HH:MM:SS<TAB>PUNCH_CODE<TAB>VERIFY...``.

    The machine timestamp is interpreted in Asia/Kolkata. Raw logs are kept
    permanently, while the main attendance collection receives UTC datetimes.
    """
    from fastapi.responses import PlainTextResponse

    try:
        params = dict(request.query_params)
        body = await request.body()
        raw = body.decode("utf-8", errors="replace").strip()

        sn = _normalize_serial_number(params.get("SN") or params.get("sn", ""))
        await _mark_device_online(sn)

        # ADMS asks for the current time using type=time.  Render runs in UTC,
        # so the response must be explicitly formatted in Asia/Kolkata.  A
        # previous implementation returned only OK here and set SyncTime=0;
        # that left the terminal's stale clock in place, which caused the
        # reported 30-minute-late punches.
        if str(params.get("type") or "").strip().lower() == "time":
            server_time = _machine_now_text()
            logger.info(
                f"⏱️ Sending IST device time to SN={sn}: {server_time}"
            )
            return PlainTextResponse(f"{server_time}\n", headers={
                "Pragma": "no-cache",
                "Cache-Control": "no-store",
            })

        # Resolve device once for metadata and punch de-duplication. Unknown
        # devices are still accepted so the machine does not get stuck retrying;
        # they are logged and can be registered from the admin UI afterwards.
        device = None
        if sn:
            sn = _normalize_serial_number(sn)
            device = await _find_device_by_serial(sn, {"_id": 0})
            if not device:
                logger.warning(f"⚠️ ADMS punch from unregistered SN={sn}")

        # ── ADMS registration/config handshake ───────────────────────────────
        # Before a ZKTeco/Identix device will EVER poll /iclock/getrequest for
        # commands, it performs a one-time handshake on first connect/restart:
        #   GET /iclock/cdata?SN=xxx&options=all&pushver=...&language=...
        # Per the ZKTeco PUSH SDK spec, the server MUST answer this with the
        # "GET OPTION FROM: SERVER" configuration block below — a bare "OK" is
        # NOT a valid response to this specific request. Firmware that doesn't
        # receive a valid config block here never considers itself registered,
        # so it keeps re-hitting /iclock/cdata forever and never advances to
        # its normal poll cycle (which is what calls /iclock/getrequest).
        # This was previously falling through to the generic "OK\n" branch
        # below, which is why commands queued in identix_cmd_queue were never
        # picked up even though the device showed as Online (heartbeats still
        # update via _mark_device_online on every cdata hit).
        if params.get("options", "").strip().lower() == "all":
            logger.info(f"📡 Identix ADMS options=all handshake from SN={sn}")
            # Use the standard ADMS registration/config response.  In
            # particular, do not answer the options=all handshake with a
            # bare OK: several firmware versions will keep calling cdata
            # forever and never start polling /iclock/getrequest.
            config_lines = [
                f"GET OPTION FROM: {sn or 'SERVER'}",
                "Stamp=9999",
                "OpStamp=9999",
                "ATTLOGStamp=9999",
                "OPERLOGStamp=9999",
                "ATTPHOTOStamp=9999",
                "ErrorDelay=30",
                "Delay=10",
                "TransTimes=00:00;23:59",
                "TransInterval=1",
                "TransFlag=TransData AttLog\tOpLog\tEnrollUser\tChgUser\tEnrollFP\tChgFP\tFPImag",
                # IMPORTANT: TimeZone is expressed in minutes on this ADMS
                # firmware, not decimal hours. 330 = UTC+05:30 (IST).
                # Sending 5.5 is parsed as 5 and makes every punch 30 minutes
                # early. Omitting the option leaves the old incorrect timezone
                # stored in the terminal, so it must be explicitly corrected
                # during the handshake.
                "TimeZone=330",
                # Ask the terminal to synchronize its clock.  The type=time
                # branch above returns an explicit IST wall-clock value, so the
                # device never has to parse India's half-hour offset from the
                # integer-only TimeZone option.
                "SyncTime=1",
                "Realtime=1",
                "Encrypt=None",
                # ADMS firmware expects the response terminator used by the
                # PUSH protocol. Without this final 0 some terminals keep
                # repeating /iclock/cdata?options=all and never enter the
                # /iclock/getrequest polling cycle.
                "0",
            ]
            return PlainTextResponse(
                "\n".join(config_lines) + "\n",
                headers={"Pragma": "no-cache", "Cache-Control": "no-store"},
            )

        if not raw or raw.upper().startswith("SN="):
            logger.info(f"📡 Identix handshake from SN={sn}")
            return "OK\n"

        # Fingerprint enrollment/change events are pushed through the same
        # cdata endpoint as attendance logs. Process them first so they are
        # not mistaken for attendance rows.
        fingerprint_events = await _process_fingerprint_uploads(sn, raw, params)

        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        logger.info(
            f"✅ Identix push received | SN={sn} | lines={len(lines)} | params={params}"
        )

        inserted = 0
        mirrored = 0
        skipped = 0
        invalid = 0

        # A pure biometric upload contains no attendance rows. ACK it after
        # updating enrollment state; do not try to parse the base64 template as
        # an attendance timestamp.
        if fingerprint_events and str(params.get("table") or "").strip().upper() in {"OPERLOG", "FP", "FINGERTMP"} and not re.search(r"(?m)^\s*\d+\t\d{4}-\d{2}-\d{2} ", raw):
            logger.info(f"Identix fingerprint push complete | SN={sn} | events={fingerprint_events}")
            return f"OK: {fingerprint_events}\n"

        for line in lines:
            parts = line.split("\t")
            if len(parts) < 4:
                invalid += 1
                logger.warning(f"Ignoring malformed Identix ADMS line: {line!r}")
                continue

            device_user_id = parts[0].strip()
            punch_time_raw = parts[1].strip()
            punch_code = parts[2].strip()
            punch_type = _punch_code_to_type(punch_code)

            if not device_user_id or not punch_time_raw or punch_type is None:
                invalid += 1
                logger.warning(
                    f"Ignoring invalid Identix punch: uid={device_user_id!r}, "
                    f"time={punch_time_raw!r}, code={punch_code!r}"
                )
                continue

            try:
                # Validate the timestamp before accepting the event. This also
                # prevents a malformed machine date from creating an attendance
                # record on an unintended day.
                _parse_machine_timestamp(punch_time_raw)
            except ValueError as exc:
                invalid += 1
                logger.warning(f"Ignoring invalid Identix timestamp: {exc}")
                continue

            user = await _find_identix_user(device_user_id)
            verify_mode_raw = parts[3].strip() if len(parts) > 3 else ""
            await _mark_fingerprint_seen_from_verify_mode(user, verify_mode_raw)
            event_id = _machine_event_id(
                sn, device_user_id, punch_time_raw, punch_type, punch_code
            )

            # Backward-compatible duplicate check for old raw records created
            # before event_id existed. New records use the atomic event_id upsert.
            legacy_duplicate = await db.identix_attendance.find_one({
                "device_serial": sn or None,
                "device_user_id": device_user_id,
                "punch_time": punch_time_raw,
                "punch_type": punch_type,
            })
            if not legacy_duplicate and sn:
                # Legacy records may not have device_serial. Avoid treating a
                # matching old record from another device as a duplicate unless
                # its serial is known to match.
                legacy_duplicate = await db.identix_attendance.find_one({
                    "device_user_id": device_user_id,
                    "punch_time": punch_time_raw,
                    "punch_type": punch_type,
                    "source": "machine_push",
                    "device_serial": {"$exists": False},
                })

            if legacy_duplicate:
                skipped += 1
                continue

            is_new = await _store_machine_raw_punch(
                event_id=event_id,
                device_serial=sn,
                device_id=device.get("id") if device else None,
                device_name=device.get("name") if device else None,
                device_user_id=device_user_id,
                punch_time_raw=punch_time_raw,
                punch_type=punch_type,
                punch_code=punch_code,
                verify_mode=verify_mode_raw or 0,
                source="machine_push",
                user=user,
            )
            if not is_new:
                skipped += 1
                continue

            inserted += 1

            if not user:
                logger.warning(
                    f"No Taskosphere user found for Identix UID={device_user_id}; "
                    "raw punch retained for later mapping."
                )
                continue

            try:
                if await _mirror_machine_punch(
                    user=user,
                    punch_time_raw=punch_time_raw,
                    punch_type=punch_type,
                    source="machine_push",
                    device_name=device.get("name") if device else None,
                    device_serial=sn or None,
                    event_id=event_id,
                ):
                    mirrored += 1
            except Exception as mirror_err:
                # Raw punch has already been safely stored. Do not make the
                # machine retry the same event forever because a main attendance
                # calculation failed.
                logger.exception(
                    f"Failed to mirror Identix punch UID={device_user_id}: {mirror_err}"
                )

        logger.info(
            f"Identix push complete | SN={sn} | inserted={inserted} | "
            f"mirrored={mirrored} | skipped={skipped} | invalid={invalid}"
        )
        return "OK\n"

    except Exception as e:
        # ADMS devices generally retry when they receive a non-OK response.
        # Keep the protocol response stable while logging the actual failure.
        logger.error(f"❌ iclock/cdata error: {e}\n{traceback.format_exc()}")
        return "OK\n"

async def _own_device_queue_scope(current_user: User) -> dict:
    """Limit command-queue access to the caller's own devices.

    The queue is one platform-wide collection keyed by device serial; listing or
    clearing it used to touch every company's commands. Devices are
    company-scoped, so the caller's serials are the boundary. The Platform Owner
    manages the whole queue.
    """
    from backend.platform_owner import is_platform_owner

    if is_platform_owner(current_user):
        return {}
    devices = await db.identix_devices.find({}, {"_id": 0, "serial_number": 1}).to_list(5000)
    serials = [
        _normalize_serial_number(d.get("serial_number")) for d in devices if d.get("serial_number")
    ]
    return {"device_serial": {"$in": serials}}


@identix_router.get("/cmd-queue")
async def get_cmd_queue(
    status: Optional[str] = None,
    device_serial: Optional[str] = None,
    batch_id: Optional[str] = None,
    current_user: User = Depends(require_admin()),
):
    """View ADMS commands with optional real-time sync filters."""
    query = await _own_device_queue_scope(current_user)
    if status:
        query["status"] = status
    if device_serial:
        wanted = _normalize_serial_number(device_serial)
        if "device_serial" in query and wanted not in query["device_serial"]["$in"]:
            wanted = "__not_your_device__"
        query["device_serial"] = wanted
    if batch_id:
        query["batch_id"] = batch_id
    cmds = await db.identix_cmd_queue.find(query, {"_id": 0}).sort("created_at", -1).limit(1000).to_list(1000)
    counts = {}
    for c in cmds:
        key = c.get("status", "unknown")
        counts[key] = counts.get(key, 0) + 1
    return {"commands": cmds, "total": len(cmds), "counts": counts}


@identix_router.delete("/cmd-queue")
async def clear_cmd_queue(
    current_user: User = Depends(require_admin()),
):
    """Clear all commands from the queue (sent, failed, and pending)."""
    result = await db.identix_cmd_queue.delete_many(await _own_device_queue_scope(current_user))
    return {"deleted": result.deleted_count, "message": f"Cleared {result.deleted_count} commands from queue"}


@identix_router.get("/")
async def root_test():
    return {"status": "API LIVE"}


# 🔹 Device command endpoint
@identix_router.api_route("/iclock/devicecmd", methods=["GET", "POST"])
async def iclock_devicecmd(request: Request):
    """
    Per the ZKTeco PUSH SDK spec, this endpoint has ONE real job: the device
    POSTs here to report the result of a command it already received via
    /iclock/getrequest. The POST body (form-encoded) looks like:

        ID=<seq>&Return=<code>&CMD=<name>[&Content=<...>]

    Return=0 means the command executed successfully on-device; any other
    value is a device-reported failure. We look the command up by its
    seq_id + device_serial in identix_cmd_queue and record the real
    outcome ("acknowledged" / "failed") instead of leaving it stuck on
    "sent" forever with no visibility into whether the push actually
    worked.

    Some firmware observed against this deployment also GETs this same
    path expecting the next pending command directly (mirroring
    /iclock/getrequest). That legacy behavior is preserved below as a
    fallback for requests that carry no ID/Return fields at all, so it
    keeps working for any device relying on it.
    """
    from fastapi.responses import PlainTextResponse

    params = dict(request.query_params)
    sn_raw = params.get("SN") or params.get("sn", "")
    sn = _normalize_serial_number(sn_raw)
    logger.info(f"📡 DEVICECMD from SN={sn} ({request.method})")
    await _mark_device_online(sn)

    # Acknowledgment fields can arrive as query params or as a form-encoded
    # POST body depending on firmware — merge both, body taking precedence.
    ack_fields = dict(params)
    if request.method == "POST":
        body = await request.body()
        raw = body.decode("utf-8", errors="replace").strip()
        if raw:
            for key, value in parse_qsl(raw, keep_blank_values=True):
                ack_fields[key] = value

    cmd_id = ack_fields.get("ID") or ack_fields.get("id")
    return_code = ack_fields.get("Return") or ack_fields.get("return")

    if cmd_id is not None and return_code is not None:
        # ── This is a command-result acknowledgment, not a poll ──────────
        cmd_name = ack_fields.get("CMD") or ack_fields.get("cmd")
        logger.info(
            f"📬 DEVICECMD ack from SN={sn}: ID={cmd_id} Return={return_code} CMD={cmd_name!r}"
        )
        try:
            seq_id = int(cmd_id)
        except (TypeError, ValueError):
            seq_id = None

        if seq_id is not None and sn:
            matching = await db.identix_cmd_queue.find_one(
                {"device_serial": sn, "seq_id": seq_id},
                {"_id": 0, "cmd_id": 1, "cmd_str": 1, "user_id": 1, "identix_uid": 1},
            )
            if matching:
                success = str(return_code).strip() == "0"
                await db.identix_cmd_queue.update_one(
                    {"cmd_id": matching["cmd_id"]},
                    {"$set": {
                        "status": "acknowledged" if success else "failed",
                        "return_code": return_code,
                        "acknowledged_at": datetime.now(timezone.utc).isoformat(),
                    }},
                )


                # USERINFO command success is the authoritative proof that the
                # employee record was accepted by the physical device.
                if str(matching.get("cmd_str", "")).upper().startswith("DATA UPDATE USERINFO"):
                    pin_match = re.search(r"\bPIN=(\d+)\b", matching.get("cmd_str", ""), re.IGNORECASE)
                    if pin_match:
                        try:
                            pin_value = int(pin_match.group(1))
                            sync_now = datetime.now(timezone.utc).isoformat()
                            user_result = await db.users.find_one_and_update(
                                {"identix_uid": pin_value},
                                {"$set": {
                                    "identix_enrolled": bool(success),
                                    "identix_last_sync_at": sync_now,
                                }},
                                projection={"_id": 0, "id": 1, "identix_uid": 1},
                                return_document=True,
                            )
                            if success and user_result:
                                # The user record is now confirmed on the
                                # device. Ask the device for any fingerprints
                                # that were already enrolled before this push.
                                await _queue_fingerprint_query(
                                    sn, pin_value, user_result.get("id")
                                )
                        except Exception:
                            pass

                logger.info(
                    f"{'✅' if success else '❌'} Command seq={seq_id} SN={sn} "
                    f"marked {'acknowledged' if success else 'failed'} (Return={return_code})"
                )
            else:
                logger.warning(
                    f"⚠️ DEVICECMD ack for unknown seq={seq_id} SN={sn} — no matching queued command"
                )
        return "OK\n"

    # ── Legacy poll fallback (no ack fields present) ─────────────────────
    if not sn:
        return "OK\n"

    device = await _find_device_by_serial(sn, {"_id": 0})
    if not device:
        return "OK\n"

    pending = await db.identix_cmd_queue.find_one(
        {"device_serial": sn, "status": "pending"},
        sort=[("created_at", 1)],
    )
    if not pending:
        return "OK\n"

    cmd_str = pending.get("cmd_str", "")

    # Defense in depth: never deliver a command capable of changing the clock.
    if _is_clock_setting_command(cmd_str):
        await db.identix_cmd_queue.update_one(
            {"_id": pending["_id"]},
            {"$set": {
                "status": "blocked",
                "blocked_reason": "Automatic device clock changes are disabled",
                "blocked_at": datetime.now(timezone.utc).isoformat(),
            }},
        )
        logger.warning(f"⛔ Blocked clock-setting command in legacy DEVICECMD poll for SN={sn}")
        return "OK\n"

    # Mark as sent
    await db.identix_cmd_queue.update_one(
        {"_id": pending["_id"]},
        {"$set": {"status": "sent", "sent_at": datetime.now(timezone.utc).isoformat()}},
    )

    logger.info(f"📤 Sending command to SN={sn}: {cmd_str[:80]}")
    response_body = f"C:{pending.get('seq_id', 1)}:{cmd_str}\n"
    return PlainTextResponse(response_body, headers={"Pragma": "no-cache", "Cache-Control": "no-store"})
