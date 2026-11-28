"""Tax rules & law updates — one effective-dated register of Indian statutory values.

Every limit, rate and due date the accounting code relies on (GST, TDS) lives
here, each with the date it applies from and the notification it comes from.

* The law as it stands today ships as built-in defaults (``DEFAULTS``).
* When the law changes, a Platform Owner adds a NEW VERSION of a rule with its
  "applies from" date and source on the *Tax rules & law updates* page. No code
  change or deploy is needed.
* Every calculation asks for the rule **on the transaction's date**, so an old
  invoice keeps the rule of its day and only later documents pick up the change.
* Versions are never edited in place. A wrong entry is withdrawn (kept, marked
  withdrawn, with who and why), and every add/withdraw is written to a log.

Read with ``rule(key, on_date)`` (sync, uses the cache) or ``await get_rule(...)``.
"""
from __future__ import annotations

import copy
import logging
import time
import uuid
from datetime import date, datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.dependencies import db, get_current_user
from backend.models import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/statutory-rules", tags=["Tax rules & law updates"])

COLLECTION = "statutory_rule_versions"
LOG_COLLECTION = "statutory_rule_log"

_TDS_2025 = {
    "194C": {"name": "Payments to Contractors", "threshold_single": 30000, "threshold_annual": 100000,
             "rate_individual": 0.01, "rate_company": 0.02},
    "194J": {"name": "Professional / Technical Services", "threshold_annual": 50000,
             "rate_standard": 0.10, "rate_technical": 0.02},
    "194I": {"name": "Rent", "threshold_monthly": 50000, "rate_rent": 0.10, "rate_plant_machinery": 0.02},
}

# key -> definition. "versions" are the built-in law, oldest first.
DEFAULTS: Dict[str, Dict[str, Any]] = {
    "gst.b2cl_threshold": {
        "label": "GSTR-1 B2C Large: invoice value above which an inter-state sale to an unregistered buyer is reported invoice-wise (Table 5)",
        "group": "GST", "kind": "amount",
        "versions": [
            {"effective_from": "2017-07-01", "value": 250000, "source": "CGST Rules, rule 59(4)(b)"},
            {"effective_from": "2024-08-01", "value": 100000, "source": "Notification No. 12/2024-Central Tax, 10 Jul 2024"},
        ],
    },
    "gst.valid_rates": {
        "label": "GST rates in use (%)", "group": "GST", "kind": "rate_list",
        "versions": [
            {"effective_from": "2017-07-01", "value": [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28],
             "source": "Notification No. 1/2017-Central Tax (Rate) and later"},
            {"effective_from": "2025-09-22", "value": [0, 0.1, 0.25, 1.5, 3, 5, 12, 18, 28, 40],
             "source": "Notification No. 9/2025-Central Tax (Rate), 17 Sep 2025 (5% / 18% main slabs, 40% special; "
                       "12% and 28% kept only for the few items still notified at those rates)"},
        ],
    },
    "gst.gstr1_due_day": {
        "label": "GSTR-1 (monthly) due day of the following month", "group": "GST", "kind": "day",
        "versions": [{"effective_from": "2017-07-01", "value": 11, "source": "CGST Act s.37 / rule 59"}],
    },
    "gst.gstr3b_due_day": {
        "label": "GSTR-3B (monthly) due day of the following month", "group": "GST", "kind": "day",
        "versions": [{"effective_from": "2017-07-01", "value": 20, "source": "CGST rule 61"}],
    },
    "gst.einvoice_turnover_threshold": {
        "label": "E-invoicing applies above this aggregate annual turnover", "group": "GST", "kind": "amount",
        "versions": [{"effective_from": "2023-08-01", "value": 50000000, "source": "Notification No. 10/2023-Central Tax"}],
    },
    "tds.challan_due_day": {
        "label": "TDS deposit due day of the following month (March: 30 April)", "group": "TDS", "kind": "day",
        "versions": [{"effective_from": "2017-04-01", "value": 7, "source": "Income-tax Rules, rule 30"}],
    },
    "tds.194C": {
        "label": "TDS on contractors (194C / s.393 Table 6(i))", "group": "TDS", "kind": "tds_section",
        "versions": [{"effective_from": "2025-04-01", "value": _TDS_2025["194C"], "source": "Finance Act 2025; Income-tax Act 2025 s.393"}],
    },
    "tds.194J": {
        "label": "TDS on professional / technical fees (194J / s.393 Table 6(iii))", "group": "TDS", "kind": "tds_section",
        "versions": [{"effective_from": "2025-04-01", "value": _TDS_2025["194J"], "source": "Finance Act 2025; Income-tax Act 2025 s.393"}],
    },
    "tds.194I": {
        "label": "TDS on rent (194I / s.393 Table 2(ii)) — monthly threshold", "group": "TDS", "kind": "tds_section",
        "versions": [{"effective_from": "2025-04-01", "value": _TDS_2025["194I"], "source": "Finance Act 2025; Income-tax Act 2025 s.393"}],
    },
}

_CACHE: Dict[str, Any] = {"at": 0.0, "versions": []}
_TTL = 60.0


def _iso(on: Any) -> str:
    if on is None:
        return date.today().isoformat()
    if isinstance(on, (date, datetime)):
        return (on.date() if isinstance(on, datetime) else on).isoformat()
    s = str(on)[:10]
    date.fromisoformat(s)
    return s


def _versions_for(key: str, stored: List[dict]) -> List[dict]:
    """Built-in + stored (active) versions of one rule, oldest first; a stored version wins a same-day tie."""
    out = [dict(v, origin="built-in") for v in DEFAULTS.get(key, {}).get("versions", [])]
    out += [dict(v, origin="added") for v in stored if v.get("key") == key and v.get("status", "active") == "active"]
    out.sort(key=lambda v: (v["effective_from"], v["origin"] == "added", v.get("created_at", "")))
    return out


def _pick(versions: List[dict], on: str) -> Optional[dict]:
    chosen = None
    for v in versions:
        if v["effective_from"] <= on:
            chosen = v
    return chosen


def rule(key: str, on_date: Any = None, default: Any = None) -> Any:
    """The value of a rule in force on a date (cached; sync). ``default`` if none applies."""
    v = _pick(_versions_for(key, _CACHE["versions"]), _iso(on_date))
    return copy.deepcopy(v["value"]) if v else default


async def refresh(force: bool = False) -> None:
    if not force and time.monotonic() - _CACHE["at"] < _TTL:
        return
    try:
        rows = await db[COLLECTION].find({"status": "active"}, {"_id": 0}).to_list(5000)
        _CACHE["versions"] = rows
        _CACHE["at"] = time.monotonic()
    except Exception:
        logger.warning("Could not load statutory rule versions; using built-in law", exc_info=True)


async def get_rule(key: str, on_date: Any = None, default: Any = None) -> Any:
    await refresh()
    return rule(key, on_date, default)


async def rules_on(on_date: Any = None) -> Dict[str, Any]:
    await refresh()
    return {k: rule(k, on_date) for k in DEFAULTS}


# ── validation of a new version ─────────────────────────────────────────────
def _validate(key: str, value: Any) -> Any:
    kind = DEFAULTS[key]["kind"]
    try:
        if kind == "amount":
            v = float(value)
            if v < 0:
                raise ValueError
            return int(v) if v.is_integer() else v
        if kind == "day":
            v = int(value)
            if not 1 <= v <= 31:
                raise ValueError
            return v
        if kind == "rate_list":
            vals = sorted({float(x) for x in value})
            if not vals or any(x < 0 or x > 100 for x in vals):
                raise ValueError
            return [int(x) if x.is_integer() else x for x in vals]
        if kind == "tds_section":
            base = DEFAULTS[key]["versions"][-1]["value"]
            if not isinstance(value, dict) or set(value) - set(base):
                raise ValueError
            merged = {**base, **value}
            for k, x in merged.items():
                if k == "name":
                    continue
                x = float(x)
                if x < 0 or (k.startswith("rate") and x > 1):
                    raise ValueError
                merged[k] = x
            return merged
    except (TypeError, ValueError):
        pass
    raise HTTPException(400, f"That value is not valid for '{DEFAULTS[key]['label']}'.")


def _can_edit(user: User) -> bool:
    from backend.platform_owner import is_platform_owner
    return bool(is_platform_owner(user))


class NewVersion(BaseModel):
    key: str
    value: Any
    effective_from: str = Field(..., description="YYYY-MM-DD: the date the law applies from")
    source: str = Field(..., min_length=3, max_length=300, description="Notification / circular / Act section")
    note: str = Field("", max_length=1000)


class Withdraw(BaseModel):
    reason: str = Field(..., min_length=3, max_length=500)


@router.get("")
async def list_rules(on: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    """Every rule with the value in force on ``on`` (default today) and its full history."""
    await refresh(force=True)
    day = _iso(on)
    out = []
    for key, d in DEFAULTS.items():
        versions = _versions_for(key, _CACHE["versions"])
        current = _pick(versions, day)
        upcoming = [v for v in versions if v["effective_from"] > day]
        out.append({"key": key, "label": d["label"], "group": d["group"], "kind": d["kind"],
                    "current": current, "upcoming": upcoming, "history": versions})
    withdrawn = await db[COLLECTION].find({"status": "withdrawn"}, {"_id": 0}).sort("withdrawn_at", -1).to_list(200)
    return {"as_of": day, "can_edit": _can_edit(current_user), "rules": out, "withdrawn": withdrawn}


@router.get("/effective")
async def effective_rules(on: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    """Plain key -> value map in force on a date (used by GST returns and other screens)."""
    return {"as_of": _iso(on), "rules": await rules_on(on)}


@router.post("")
async def add_version(body: NewVersion, current_user: User = Depends(get_current_user)):
    if not _can_edit(current_user):
        raise HTTPException(403, "Only the Platform Owner can update tax rules; they apply to every company.")
    if body.key not in DEFAULTS:
        raise HTTPException(400, "Unknown rule.")
    try:
        day = _iso(body.effective_from)
    except ValueError:
        raise HTTPException(400, "The 'applies from' date must be YYYY-MM-DD.")
    value = _validate(body.key, body.value)
    now = datetime.now(timezone.utc).isoformat()
    doc = {"id": str(uuid.uuid4()), "key": body.key, "value": value, "effective_from": day,
           "source": body.source.strip(), "note": body.note.strip(), "status": "active",
           "created_by": current_user.id, "created_by_email": getattr(current_user, "email", ""), "created_at": now}
    await db[COLLECTION].insert_one(dict(doc))
    await db[LOG_COLLECTION].insert_one({"id": str(uuid.uuid4()), "action": "added", "version": doc, "at": now,
                                         "by": current_user.id})
    await refresh(force=True)
    logger.info("Statutory rule %s: new version from %s (%s)", body.key, day, body.source)
    return {"success": True, "version": doc}


@router.post("/{version_id}/withdraw")
async def withdraw_version(version_id: str, body: Withdraw, current_user: User = Depends(get_current_user)):
    if not _can_edit(current_user):
        raise HTTPException(403, "Only the Platform Owner can update tax rules.")
    doc = await db[COLLECTION].find_one({"id": version_id, "status": "active"}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "That rule version was not found (built-in law cannot be withdrawn, only superseded).")
    now = datetime.now(timezone.utc).isoformat()
    await db[COLLECTION].update_one({"id": version_id}, {"$set": {
        "status": "withdrawn", "withdrawn_at": now, "withdrawn_by": current_user.id, "withdraw_reason": body.reason}})
    await db[LOG_COLLECTION].insert_one({"id": str(uuid.uuid4()), "action": "withdrawn", "version": doc,
                                         "reason": body.reason, "at": now, "by": current_user.id})
    await refresh(force=True)
    return {"success": True}


@router.get("/log")
async def change_log(current_user: User = Depends(get_current_user)):
    return await db[LOG_COLLECTION].find({}, {"_id": 0}).sort("at", -1).to_list(500)


async def create_statutory_rule_indexes():
    await db[COLLECTION].create_index([("key", 1), ("effective_from", 1)])
    await db[COLLECTION].create_index("id", unique=True)
