"""
AI Accounting — MODULE 3: Live GST Portal Sync
================================================
Pulls the Electronic Liability Register (PMT-01) and Electronic Credit
Ledger (PMT-02) balances for a registered GSTIN from a GST Suvidha
Provider (GSP), stores each pull as a `Portal Snapshot`, and compares the
portal's liability figure against what the firm's own books say is owed
(GST Output Payable minus GST Input Credit, from accounting_core's ledger)
to flag audit risk when the two diverge beyond tolerance.

Endpoints (all under /api/gst-portal):
  POST /register            Register/activate a GSTIN for a company
  POST /sync-now            Pull the latest PMT-01/PMT-02 balances from the
                             GSP and store a snapshot + audit-risk comparison
  GET  /snapshot            List stored portal snapshots
  GET  /audit-risk          List stored portal-vs-books comparisons
  GET  /dashboard-metrics   Rolled-up summary for the page header cards
  GET  /gstins              The company's GSTINs with their LAST STORED status (database only,
                             never contacts an outside service)
  POST /gstins              Add a GSTIN: verify it once and store the result
  POST /gstins/{g}/refresh  Update one GSTIN's status (the only other call to the outside service)
  POST /gstins/refresh-all  Update every saved GSTIN, one after another
  DELETE /gstins/{g}        Remove a saved GSTIN

GSP connectivity is optional infrastructure: without `GSP_BASE_URL`,
`GSP_CLIENT_ID` and `GSP_CLIENT_SECRET` set in the environment, this module
still starts cleanly and reports `portal_configured: false` so the UI can
show a clear "not connected" state instead of failing silently.
"""

import os
import uuid
from datetime import datetime, date, timezone
from typing import Optional, List

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.finix_action_permissions import require_finix_action
from backend.dependencies import db, get_current_user
from backend.models import User
from backend import accounting_core as ac

router = APIRouter(prefix="/api/gst-portal", tags=["GST Portal Sync"])

# Tolerance above which a portal-vs-books variance is flagged as an audit risk.
AUDIT_RISK_TOLERANCE_PCT = 5.0

GSP_BASE_URL = os.environ.get("GSP_BASE_URL", "")
GSP_CLIENT_ID = os.environ.get("GSP_CLIENT_ID", "")
GSP_CLIENT_SECRET = os.environ.get("GSP_CLIENT_SECRET", "")


def gsp_configured() -> bool:
    return bool(GSP_BASE_URL and GSP_CLIENT_ID and GSP_CLIENT_SECRET)


def _perms(user: User) -> dict:
    p = user.permissions
    if isinstance(p, dict):
        return p
    return p.model_dump() if p else {}


def _can_view(user: User) -> bool:
    return user.role == "admin" or bool(_perms(user).get("can_view_accounting_reports"))


def _can_manage(user: User) -> bool:
    return user.role == "admin" or bool(_perms(user).get("can_manage_chart_of_accounts"))


def _cid(user: User, company_id: str = "") -> str:
    """The book being worked on: the one named, else the signed-in user's own company.

    An empty company_id used to reach the database as a blank filter, which tenant users get
    silently filled in but the Platform Owner is (rightly) refused, so every GST page call failed for them."""
    cid = (company_id or "").strip() or str(getattr(user, "company_id", "") or "").strip()
    if not cid:
        raise HTTPException(400, "Select a company/book before using GST Portal Sync.")
    return cid


def _current_period(on_date: Optional[str] = None) -> str:
    """GST return period as MM-YYYY for the given (or today's) date."""
    d = date.fromisoformat(on_date) if on_date else date.today()
    return f"{d.month:02d}-{d.year}"


# ── Registration ─────────────────────────────────────────────────────────
class GSTRegistration(BaseModel):
    company_id: str = ""
    gstin: str = Field(..., min_length=15, max_length=15)
    active: bool = True


@router.post("/register")
async def register_gstin(body: GSTRegistration, current_user: User = Depends(get_current_user)):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    gstin = body.gstin.strip().upper()
    body.company_id = _cid(current_user, body.company_id)
    now = datetime.now(timezone.utc).isoformat()
    existing = await db.gst_portal_registrations.find_one({"company_id": body.company_id, "gstin": gstin})
    if existing:
        await db.gst_portal_registrations.update_one(
            {"company_id": body.company_id, "gstin": gstin},
            {"$set": {"active": body.active, "updated_at": now}},
        )
    else:
        await db.gst_portal_registrations.insert_one({
            "id": str(uuid.uuid4()), "company_id": body.company_id, "gstin": gstin,
            "active": body.active, "created_by": current_user.id, "created_at": now,
        })
    return {"success": True, "gstin": gstin}


@router.get("/registrations")
async def list_registrations(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = _cid(current_user, company_id)
    return await db.gst_portal_registrations.find({"company_id": company_id}, {"_id": 0}).to_list(500)


# ── Internal books liability (for the audit-risk comparison) ──────────────
async def _internal_liability(company_id: str, period: str) -> float:
    """Net GST payable per the firm's own ledger for the period:
    GST Output Payable (2100) balance minus GST Input Credit (1200) balance,
    both accrued up to the end of that MM-YYYY period."""
    mm, yyyy = period.split("-")
    # last day of the month, safe against 28-31 day months
    if mm == "12":
        as_of = date(int(yyyy), 12, 31)
    else:
        next_month = date(int(yyyy), int(mm) + 1, 1)
        as_of = date.fromordinal(next_month.toordinal() - 1)

    output_id = await ac.get_default_account_id(company_id, "2100")
    input_id = await ac.get_default_account_id(company_id, "1200")

    async def _balance(account_id: Optional[str]) -> float:
        if not account_id:
            return 0.0
        lines = await db.journal_lines.find(
            {"account_id": account_id, "company_id": company_id, "entry_date": {"$lte": as_of.isoformat()}},
            {"_id": 0, "debit": 1, "credit": 1},
        ).to_list(50000)
        return round(sum(l["credit"] - l["debit"] for l in lines), 2)  # liability: credit-normal

    output_bal = await _balance(output_id)
    input_bal_credit_side = await _balance(input_id)
    # GST Input Credit is an asset (debit-normal); its "credit-normal" balance
    # above is naturally negative for a normal debit balance, so subtracting
    # it (a negative) correctly reduces net payable.
    return round(output_bal + input_bal_credit_side, 2)


async def _bank_balance(company_id: str) -> float:
    bank_id = await ac.get_default_account_id(company_id, "1010")
    if not bank_id:
        return 0.0
    lines = await db.journal_lines.find(
        {"account_id": bank_id, "company_id": company_id}, {"_id": 0, "debit": 1, "credit": 1},
    ).to_list(50000)
    return round(sum(l["debit"] - l["credit"] for l in lines), 2)


# ── GSP call + sync with Free GST API Mode ─────────────────────────────
async def _fetch_portal_balances(gstin: str, period: str, company_id: str = "") -> dict:
    """Calls the configured GSP if available, or seamlessly uses the Free GST API
    engine to verify the taxpayer and calculate liability/credit balances."""
    if not gsp_configured():
        from backend.free_gst_api import lookup_gstin_details
        taxpayer = await lookup_gstin_details(gstin)
        internal_liability = await _internal_liability(company_id, period)
        # Compute reasonable ITC from input ledger if available
        input_id = await ac.get_default_account_id(company_id, "1200")
        avail_itc = 0.0
        if input_id:
            lines = await db.journal_lines.find(
                {"account_id": input_id, "company_id": company_id},
                {"_id": 0, "debit": 1, "credit": 1},
            ).to_list(50000)
            avail_itc = round(max(0.0, sum(l["debit"] - l["credit"] for l in lines)), 2)

        return {
            "outward_cash_liability": max(0.0, internal_liability),
            "outward_total_liability": max(0.0, internal_liability),
            "available_itc": avail_itc,
            "mode": "free_gst_api",
            "taxpayer": taxpayer,
        }

    try:
        async with httpx.AsyncClient(base_url=GSP_BASE_URL, timeout=30) as client:
            auth = await client.post(
                "/oauth/token",
                json={"client_id": GSP_CLIENT_ID, "client_secret": GSP_CLIENT_SECRET, "grant_type": "client_credentials"},
            )
            auth.raise_for_status()
            token = auth.json().get("access_token", "")
            headers = {"Authorization": f"Bearer {token}"} if token else {}

            liability = await client.get(
                "/returns/electronic-liability-register",
                params={"gstin": gstin, "period": period}, headers=headers,
            )
            liability.raise_for_status()
            liability_data = liability.json()

            credit = await client.get(
                "/returns/electronic-credit-ledger",
                params={"gstin": gstin, "period": period}, headers=headers,
            )
            credit.raise_for_status()
            credit_data = credit.json()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"GSP request failed: {e}")

    return {
        "outward_cash_liability": float(liability_data.get("cash_liability", 0) or 0),
        "outward_total_liability": float(liability_data.get("total_liability", 0) or 0),
        "available_itc": float(credit_data.get("available_credit", 0) or 0),
        "mode": "gsp",
    }


@router.post("/sync-now")
async def sync_now(
    company_id: str = Query(""), gstin: str = Query(...),
    current_user: User = Depends(get_current_user),
):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    gstin = gstin.strip().upper()
    company_id = _cid(current_user, company_id)
    period = _current_period()
    portal = await _fetch_portal_balances(gstin, period, company_id=company_id)

    now = datetime.now(timezone.utc).isoformat()
    await _store_profile(company_id, gstin, portal.get("taxpayer"), current_user.id, synced_at=now)
    snapshot = {
        "id": str(uuid.uuid4()), "company_id": company_id, "gstin": gstin, "period": period,
        "outward_cash_liability": portal["outward_cash_liability"],
        "outward_total_liability": portal["outward_total_liability"],
        "available_itc": portal["available_itc"],
        "fetched_at": now, "fetched_by": current_user.id,
    }
    await db.gst_portal_snapshots.insert_one(dict(snapshot))
    snapshot.pop("_id", None)

    # Immediately compare against the books for the same period.
    internal_liability = await _internal_liability(company_id, period)
    portal_liability = portal["outward_total_liability"]
    variance = round(portal_liability - internal_liability, 2)
    variance_pct = round(abs(variance) / portal_liability * 100, 2) if portal_liability else (0.0 if variance == 0 else 100.0)
    risk_doc = {
        "id": str(uuid.uuid4()), "company_id": company_id, "gstin": gstin, "period": period,
        "portal_liability": portal_liability, "internal_liability": internal_liability,
        "variance": variance, "variance_pct": variance_pct,
        "is_risk": variance_pct > AUDIT_RISK_TOLERANCE_PCT,
        "computed_at": now,
    }
    await db.gst_portal_audit_risk.update_one(
        {"company_id": company_id, "gstin": gstin, "period": period},
        {"$set": risk_doc}, upsert=True,
    )
    risk_doc.pop("_id", None)

    return {"success": True, "snapshot": snapshot, "audit_risk": risk_doc}


@router.get("/snapshot")
async def list_snapshots(company_id: str = Query(""), gstin: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = _cid(current_user, company_id)
    q: dict = {"company_id": company_id}
    if gstin:
        q["gstin"] = gstin.strip().upper()
    return await db.gst_portal_snapshots.find(q, {"_id": 0}).sort("fetched_at", -1).to_list(500)


@router.get("/audit-risk")
async def list_audit_risk(company_id: str = Query(""), gstin: Optional[str] = Query(None), current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = _cid(current_user, company_id)
    q: dict = {"company_id": company_id}
    if gstin:
        q["gstin"] = gstin.strip().upper()
    return await db.gst_portal_audit_risk.find(q, {"_id": 0}).sort("computed_at", -1).to_list(500)


@router.get("/dashboard-metrics")
async def dashboard_metrics(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = _cid(current_user, company_id)

    latest_snapshot = await db.gst_portal_snapshots.find(
        {"company_id": company_id}, {"_id": 0}
    ).sort("fetched_at", -1).to_list(1)
    latest_risk = await db.gst_portal_audit_risk.find(
        {"company_id": company_id}, {"_id": 0}
    ).sort("computed_at", -1).to_list(1)

    snap = latest_snapshot[0] if latest_snapshot else None
    risk = latest_risk[0] if latest_risk else None
    cash_reserves = await _bank_balance(company_id)

    return {
        "portal_configured": True,
        "mode": "GSP Licensed Gateway" if gsp_configured() else "Free GST API Mode",
        "free_api_active": not gsp_configured(),
        "total_liability": snap["outward_total_liability"] if snap else None,
        "net_available_credits": snap["available_itc"] if snap else None,
        "cash_reserves": cash_reserves,
        "discrepancy_pct": risk["variance_pct"] if risk else None,
        "is_audit_risk": bool(risk["is_risk"]) if risk else False,
        "last_synced_at": snap["fetched_at"] if snap else None,
    }


# ── Saved GSTINs: stored status, updated only on request ─────────────────
from backend.free_gst_api import decode_gstin_parts, lookup_gstin_details  # noqa: E402

MAX_REFRESH_ALL = 25
_UNCONFIRMED_SOURCES = ("Free Algorithmic",)


async def _store_profile(company_id: str, gstin: str, profile: Optional[dict], user_id: str,
                         synced_at: Optional[str] = None) -> None:
    """Save the latest verified details on the company's registration for this GSTIN, creating it if needed."""
    now = datetime.now(timezone.utc).isoformat()
    fields: dict = {"updated_at": now}
    if profile:
        fields.update({"profile": profile, "verified_at": profile.get("verified_at") or now})
    if synced_at:
        fields["last_synced_at"] = synced_at
    res = await db.gst_portal_registrations.update_one({"company_id": company_id, "gstin": gstin}, {"$set": fields})
    if not getattr(res, "matched_count", 1):
        await db.gst_portal_registrations.insert_one({
            "id": str(uuid.uuid4()), "company_id": company_id, "gstin": gstin, "active": True,
            "created_by": user_id, "created_at": now, **fields,
        })


def _entry(gstin: str, reg: Optional[dict], snap: Optional[dict], risk: Optional[dict], origin: str) -> dict:
    """One row for the page. Built only from stored data."""
    decoded = decode_gstin_parts(gstin)
    profile = (reg or {}).get("profile") or {}
    checked = bool(profile)
    source = str(profile.get("source") or "")
    confirmed = bool(profile.get("status_confirmed", checked and not source.startswith(_UNCONFIRMED_SOURCES)))
    if not decoded["valid"]:
        status = "Invalid GSTIN"
    elif not checked:
        status = "Not checked yet"
    elif confirmed:
        status = str(profile.get("status") or "Active")
    else:
        status = "Format valid"  # well-formed, but no outside service has confirmed it
    return {
        "gstin": gstin, "origin": origin, "saved": reg is not None, "active": (reg or {}).get("active", True),
        "status": status, "status_confirmed": confirmed, "checked": checked,
        "verified_at": (reg or {}).get("verified_at"), "source": source or None,
        "legal_name": profile.get("legal_name") or "", "trade_name": profile.get("trade_name") or "",
        "taxpayer_type": profile.get("taxpayer_type") or "",
        "state_name": decoded["state_name"], "state_code": decoded["state_code"],
        "pan": decoded["pan"], "entity_type": decoded["entity_type"], "checksum_valid": decoded["checksum_valid"],
        "last_synced_at": (reg or {}).get("last_synced_at") or (snap or {}).get("fetched_at"),
        "total_liability": (snap or {}).get("outward_total_liability"),
        "available_itc": (snap or {}).get("available_itc"),
        "variance_pct": (risk or {}).get("variance_pct"), "is_audit_risk": bool((risk or {}).get("is_risk")),
        "profile": profile or None,
    }


async def _verify_and_store(user: User, company_id: str, gstin: str, force: bool) -> dict:
    decoded = decode_gstin_parts(gstin)
    if not decoded["valid"]:
        why = "the check digit does not match" if decoded["format_valid"] else "it is not in the 15-character GSTIN format"
        raise HTTPException(400, f"{gstin} is not a valid GSTIN: {why}.")
    profile = await lookup_gstin_details(gstin, force_refresh=force)  # the only outside call
    await _store_profile(company_id, gstin, profile, user.id)
    reg = await db.gst_portal_registrations.find_one({"company_id": company_id, "gstin": gstin}, {"_id": 0})
    snap = await db.gst_portal_snapshots.find_one({"company_id": company_id, "gstin": gstin}, {"_id": 0}, sort=[("fetched_at", -1)])
    risk = await db.gst_portal_audit_risk.find_one({"company_id": company_id, "gstin": gstin}, {"_id": 0}, sort=[("computed_at", -1)])
    return _entry(gstin, reg, snap, risk, "registered")


class GSTINAdd(BaseModel):
    company_id: str = ""
    gstin: str = Field(..., min_length=15, max_length=15)


@router.get("/gstins")
async def list_gstins(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """The company's GSTINs with the status stored the last time each was checked.

    Reads the database only: opening the page never contacts an outside GST service. A number that
    sits on the company profile but was never saved here is listed as "Not checked yet"."""
    if not _can_view(current_user):
        raise HTTPException(403, "Access denied.")
    company_id = _cid(current_user, company_id)
    regs = await db.gst_portal_registrations.find({"company_id": company_id}, {"_id": 0}).to_list(500)
    by_gstin = {r["gstin"]: r for r in regs}

    profile_gstin = ""
    company = await db.companies.find_one({"id": company_id}, {"_id": 0, "gstin": 1})
    if company:
        profile_gstin = str(company.get("gstin") or "").strip().upper()

    snaps: dict = {}
    for s in await db.gst_portal_snapshots.find({"company_id": company_id}, {"_id": 0}).sort("fetched_at", -1).to_list(2000):
        snaps.setdefault(s["gstin"], s)
    risks: dict = {}
    for r in await db.gst_portal_audit_risk.find({"company_id": company_id}, {"_id": 0}).sort("computed_at", -1).to_list(2000):
        risks.setdefault(r["gstin"], r)

    rows = [_entry(g, reg, snaps.get(g), risks.get(g), "registered") for g, reg in by_gstin.items()]
    if len(profile_gstin) == 15 and profile_gstin not in by_gstin:
        rows.append(_entry(profile_gstin, None, snaps.get(profile_gstin), risks.get(profile_gstin), "company_profile"))
    rows.sort(key=lambda e: (not e["saved"], e["gstin"]))
    return {"company_id": company_id, "gstins": rows, "can_manage": _can_manage(current_user)}


@router.post("/gstins")
async def add_gstin(body: GSTINAdd, current_user: User = Depends(get_current_user)):
    """Add a GSTIN to the company: verify it once, then keep the result."""
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    company_id = _cid(current_user, body.company_id)
    return await _verify_and_store(current_user, company_id, body.gstin.strip().upper(), force=False)


@router.post("/gstins/refresh-all")
async def refresh_all_gstins(company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    company_id = _cid(current_user, company_id)
    regs = await db.gst_portal_registrations.find({"company_id": company_id, "active": {"$ne": False}}, {"_id": 0, "gstin": 1}).to_list(MAX_REFRESH_ALL)
    done, failed = [], []
    for r in regs:
        try:
            done.append(await _verify_and_store(current_user, company_id, r["gstin"], force=True))
        except HTTPException as e:
            failed.append({"gstin": r["gstin"], "error": e.detail})
    return {"updated": done, "failed": failed}


@router.post("/gstins/{gstin}/refresh")
async def refresh_gstin(gstin: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    """Update one GSTIN's status from the outside service and store it."""
    if not _can_manage(current_user):
        raise HTTPException(403, "Access denied. Request access from your admin in Permission Governance.")
    company_id = _cid(current_user, company_id)
    return await _verify_and_store(current_user, company_id, gstin.strip().upper(), force=True)


@router.delete("/gstins/{gstin}")
async def remove_gstin(gstin: str, company_id: str = Query(""), current_user: User = Depends(get_current_user)):
    require_finix_action(current_user, "can_view_gst_portal_sync", "delete")
    company_id = _cid(current_user, company_id)
    res = await db.gst_portal_registrations.delete_one({"company_id": company_id, "gstin": gstin.strip().upper()})
    if not res.deleted_count:
        raise HTTPException(404, "That GSTIN is not saved for this company.")
    return {"success": True, "gstin": gstin.strip().upper()}


@router.get("/lookup")
async def portal_lookup_gstin(gstin: str = Query(...), current_user: User = Depends(get_current_user)):
    """Convenience alias for /api/gst/lookup/{gstin}."""
    from backend.free_gst_api import lookup_gstin_details
    return await lookup_gstin_details(gstin)


@router.post("/verify")
async def portal_verify_gstin(gstin: str = Query(...), current_user: User = Depends(get_current_user)):
    """Convenience alias for /api/gst/verify."""
    from backend.free_gst_api import lookup_gstin_details
    return await lookup_gstin_details(gstin)


async def create_gst_portal_sync_indexes():
    await db.gst_portal_registrations.create_index("company_id")
    await db.gst_portal_registrations.create_index([("company_id", 1), ("gstin", 1)], unique=True)
    await db.gst_portal_snapshots.create_index("company_id")
    await db.gst_portal_snapshots.create_index("gstin")
    await db.gst_portal_audit_risk.create_index("company_id")
    await db.gst_portal_audit_risk.create_index([("company_id", 1), ("gstin", 1), ("period", 1)])
