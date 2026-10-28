"""Phase 2 extracted subsystem: client_management.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/client_management.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import assert_module_permission
from backend.dependencies import check_module_permission
from backend.dependencies import db
from backend.dependencies import get_cross_visibility_union
from backend.dependencies import get_current_user
from backend.dependencies import get_team_user_ids
from backend.dependencies import get_user_permissions
from backend.models import Client
from backend.models import ClientCreate
from backend.models import User
from backend.server_modules.helpers import convert_objectids
from backend.server_modules.helpers import create_audit_log
from datetime import date
from datetime import datetime
from datetime import timezone
from fastapi import Body
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import Query
from fastapi import UploadFile
from io import BytesIO
from io import StringIO
from pydantic import ValidationError
from typing import Dict
from typing import List
import csv
import pandas as pd
import re
import uuid
from backend.server import api_router, logger  # created in backend/server.py before route modules load

def _client_import_get(row: dict, *aliases: str) -> str:
    """
    Case/spacing-insensitive lookup across a row's columns, so imports work
    whether the sheet uses 'company_name', 'Company Name' or just 'Company'.
    """
    normalized = { str(k).strip().lower(): v for k, v in row.items() if k is not None }
    for alias in aliases:
        val = normalized.get(alias.strip().lower())
        if val not in (None, ""):
            return str(val).strip()
    return ""


@api_router.post("/clients/import")
async def import_clients_from_csv(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    """
    Bulk-import clients from a CSV or Excel (.xlsx/.xls) file.
    Recognised columns (all optional except company name), matched
    case-insensitively and under a few common aliases:
      company_name / company, client_type / type / constitution, email,
      phone, birthday, address, city, state, services, notes,
      assigned_to, status
    Returns: { message, clients_created, clients_skipped, errors }
    """
    if current_user.role not in ("admin", "manager"):
        perms = get_user_permissions(current_user)
        if not perms.get("can_edit_clients", False):
            raise HTTPException(status_code=403, detail="Permission denied")

    filename = (file.filename or "").lower()
    if not (filename.endswith(".csv") or filename.endswith(".xlsx") or filename.endswith(".xls")):
        raise HTTPException(
            status_code=400,
            detail="Only CSV or Excel files are supported (.csv, .xlsx, .xls)",
        )

    content = await file.read()

    rows: list = []
    if filename.endswith(".csv"):
        try:
            text = content.decode("utf-8-sig")  # handle BOM
        except UnicodeDecodeError:
            text = content.decode("latin-1")
        reader = csv.DictReader(StringIO(text))
        if not reader.fieldnames:
            raise HTTPException(
                status_code=422, detail="CSV file is empty or has no header row"
            )
        rows = list(reader)
    else:
        try:
            engine = "xlrd" if filename.endswith(".xls") else "openpyxl"
            df = pd.read_excel(BytesIO(content), dtype=str, engine=engine).fillna("")
        except Exception as e:
            raise HTTPException(
                status_code=400, detail=f"Could not read Excel file: {str(e)}"
            )
        if df.empty or len(df.columns) == 0:
            raise HTTPException(
                status_code=422, detail="Excel file is empty or has no header row"
            )
        rows = df.to_dict(orient="records")

    created_count = 0
    skipped_count = 0
    errors: list = []
    now_iso = datetime.now(timezone.utc).isoformat()

    # Bulk-import performance: read existing client names once, then insert
    # prepared documents in MongoDB batches. This avoids a find_one call for
    # every spreadsheet row and keeps large Excel/CSV imports reliable.
    existing_cursor = db.clients.find(
        {"created_by": current_user.id},
        {"_id": 0, "company_name": 1},
    )
    existing_names = set()
    async for existing_row in existing_cursor:
        value = str(existing_row.get("company_name") or "").strip().casefold()
        if value:
            existing_names.add(value)

    pending_docs = []
    pending_names = set()

    for i, row in enumerate(rows, start=2):
        company_name = _client_import_get(
            row, "company_name", "company name", "company"
        )
        if not company_name:
            skipped_count += 1
            continue

        company_key = company_name.casefold()
        if company_key in existing_names or company_key in pending_names:
            skipped_count += 1
            continue

        raw_services = _client_import_get(row, "services", "service")
        services = (
            [s.strip() for s in re.split(r"[;,]", raw_services) if s.strip()]
            if raw_services
            else []
        )

        raw_type = _client_import_get(
            row, "client_type", "client type", "type", "constitution"
        ).lower() or "proprietor"
        valid_types = {
            "proprietor",
            "pvt_ltd",
            "llp",
            "partnership",
            "huf",
            "trust",
            "other",
        }
        client_type = raw_type if raw_type in valid_types else "proprietor"

        pending_docs.append(
            {
                "id": str(uuid.uuid4()),
                "company_name": company_name,
                "client_type": client_type,
                "email": _client_import_get(row, "email") or None,
                "phone": _client_import_get(row, "phone", "mobile") or None,
                "birthday": _client_import_get(row, "birthday", "dob") or None,
                "address": _client_import_get(row, "address") or None,
                "city": _client_import_get(row, "city") or None,
                "state": _client_import_get(row, "state") or None,
                "services": services,
                "notes": _client_import_get(row, "notes") or None,
                "referred_by": _client_import_get(
                    row, "referred_by", "referred by"
                ) or None,
                "assigned_to": _client_import_get(
                    row, "assigned_to", "assigned to"
                ) or None,
                "status": (_client_import_get(row, "status") or "active").lower(),
                "created_by": current_user.id,
                "created_at": now_iso,
            }
        )
        pending_names.add(company_key)

    BATCH_SIZE = 250
    for batch_start in range(0, len(pending_docs), BATCH_SIZE):
        batch = pending_docs[batch_start : batch_start + BATCH_SIZE]
        try:
            result = await db.clients.insert_many(batch, ordered=False)
            created_count += len(result.inserted_ids)
        except Exception as exc:
            details = getattr(exc, "details", None) or {}
            write_errors = (
                details.get("writeErrors", [])
                if isinstance(details, dict)
                else []
            )
            if write_errors:
                failed_indexes = {
                    int(item.get("index"))
                    for item in write_errors
                    if str(item.get("index", "")).isdigit()
                }
                created_count += max(len(batch) - len(failed_indexes), 0)
                for item in write_errors:
                    idx = item.get("index")
                    try:
                        idx = int(idx)
                    except (TypeError, ValueError):
                        idx = -1
                    if str(item.get("code")) == "11000":
                        skipped_count += 1
                    else:
                        errors.append(
                            {
                                "row": batch_start + idx + 2,
                                "company": (
                                    batch[idx].get("company_name")
                                    if 0 <= idx < len(batch)
                                    else ""
                                ),
                                "error": str(
                                    item.get("errmsg") or exc
                                )[:120],
                            }
                        )
                        skipped_count += 1
            else:
                errors.append(
                    {
                        "row": batch_start + 2,
                        "company": batch[0].get("company_name") if batch else "",
                        "error": str(exc)[:120],
                    }
                )
                skipped_count += len(batch)

    return {
        "message": f"{created_count} client(s) imported successfully",
        "clients_created": created_count,
        "clients_skipped": skipped_count,
        "errors": errors[:10],
    }



@api_router.post("/clients", response_model=Client)
async def create_client(
    payload: dict,
    current_user: User = Depends(get_current_user),
):
    """
    Create a new client.

    ANY signed-in user may add a client — no special permission is needed.
    What differs is what happens next: an admin (or a user with
    can_approve_clients) creates it as approved, everyone else creates it as
    "pending" and it only joins the master list once an approver signs it off
    from Records ▸ Client Approvals.
    """
    try:
        client_data = ClientCreate(
            **{k: v for k, v in payload.items() if k in ClientCreate.model_fields}
        )
        client = Client(**client_data.model_dump(), created_by=current_user.id)
        doc = client.model_dump()

        # ── Approval workflow ────────────────────────────────────────────
        # Any user can add a client, but unless they are an admin (or hold
        # can_approve_clients) the record is created as "pending" and only
        # becomes part of the master list once an admin approves it.
        perms_now = get_user_permissions(current_user)
        auto_approve = current_user.role == "admin" or perms_now.get(
            "can_approve_clients", False
        )
        doc["approval_status"] = "approved" if auto_approve else "pending"
        doc["approved_by"] = current_user.id if auto_approve else None
        doc["approved_at"] = (
            datetime.now(timezone.utc).isoformat() if auto_approve else None
        )

        # ── safe_iso: handles None, str, date, datetime — never crashes ──────
        def safe_iso(val):
            if val is None:
                return None
            if isinstance(val, str):
                return val[:10] if val else None  # already "2015-04-01", keep as-is
            if isinstance(val, (date, datetime)):
                return val.isoformat()
            return str(val)

        doc["created_at"] = (
            safe_iso(doc.get("created_at")) or datetime.now(timezone.utc).isoformat()
        )
        doc["birthday"] = safe_iso(doc.get("birthday"))

        # Persist extra fields from frontend that live outside Pydantic schema
        for key in (
            "address",
            "city",
            "state",
            "client_type_label",
            "contact_persons",
            "dsc_details",
            "assignments",
            "referred_by",
            "gstin",
            "pan",
            "gst_treatment",
            "place_of_supply",
            "default_payment_terms",
            "credit_limit",
            "opening_balance",
            "opening_balance_type",
            "tally_ledger_name",
            "tally_group",
            "website",
            "msme_number",
            "gst_address",
            "gst_city",
            "gst_state",
            "gst_pin",
            "cin",
            "llpin",
            "mca_fetch_date",
            "mca_company_status",
            "date_of_incorporation",
            "pincode",
            "mca_registration_number",
            "mca_roc_name",
            "mca_rd_name",
            "mca_company_category",
            "mca_company_subcategory",
            "mca_listed",
            "mca_active_compliance",
            "mca_authorized_capital",
            "mca_paid_up_capital",
            "mca_last_agm_date",
            "mca_balance_sheet_date",
            "mca_books_address",
            "mca_charges",
            "mca_loan_details",
            "is_itr_client",
            "itr_data",
        ):
            val = payload.get(key)
            if val is not None:
                doc[key] = val

        doc.pop("_id", None)
        await db.clients.insert_one(doc)
        return client
    except ValidationError as ve:
        logger.error(
            f"create_client ValidationError for '{payload.get('company_name')}': {ve.errors()}",
            exc_info=True,
        )
        raise HTTPException(status_code=422, detail=ve.errors())
    except Exception as e:
        logger.error(
            f"create_client error for '{payload.get('company_name')}': {e}",
            exc_info=True,
        )
        raise HTTPException(status_code=400, detail=str(e))


_DEPT_SERVICE_MAP: Dict[str, List[str]] = {
    "GST": ["GST", "Compliance"],
    "IT": ["Income Tax", "Tax Planning"],
    "ACC": ["Accounting", "Payroll", "Audit"],
    "TDS": ["TDS"],
    "ROC": ["ROC", "Company Registration", "Compliance"],
    "TM": ["Trademark"],
    "MSME": ["MSME"],
    "FEMA": ["FEMA"],
    "DSC": [],
    "OTHER": [],
}


@api_router.get("/users/{user_id}/assigned-clients")
async def get_user_assigned_clients(
    user_id: str,
    current_user: User = Depends(get_current_user),
):
    """
    Return all clients assigned to a specific user, considering BOTH:
      - the legacy single `assigned_to` field, AND
      - the per-service `assignments[].user_id` list
    so that a client whose services are split across multiple users
    shows up for each of those users.

    Each returned client includes an `assigned_services` array listing
    which services this particular user is assigned to on that client
    (legacy `assigned_to` is shown as "All services").

    Access:
      - admin: any user
      - manager: self or any user in their cross-visibility union
      - staff: self only (unless they have can_view_user_page and the
        target user is in their cross-visibility union)
    """
    # ── Access control ─────────────────────────────────────────────
    if current_user.role != "admin" and user_id != current_user.id:
        permissions = get_user_permissions(current_user)
        can_view_dir = permissions.get("can_view_user_page", False)
        cross_ids = await get_cross_visibility_union(current_user.id)
        if current_user.role == "manager":
            if user_id not in cross_ids and user_id != current_user.id:
                raise HTTPException(
                    status_code=403, detail="User not in your visibility scope"
                )
        else:
            if not (can_view_dir and user_id in cross_ids):
                raise HTTPException(status_code=403, detail="Not allowed")

    # ── Query: legacy OR per-service ───────────────────────────────
    query = {
        "$or": [
            {"assigned_to": user_id},
            {"assignments.user_id": user_id},
        ]
    }
    clients_raw = await db.clients.find(query, {"_id": 0}).to_list(2000)

    results = []
    for c in clients_raw:
        # Compute which services this user is assigned to on this client
        assigned_services: List[str] = []
        for a in c.get("assignments") or []:
            if (a or {}).get("user_id") == user_id:
                svcs = a.get("services") or []
                if isinstance(svcs, list):
                    assigned_services.extend([str(s) for s in svcs if s])
        # If legacy assigned_to matches and no per-service entry exists,
        # surface that as "All services"
        legacy_match = c.get("assigned_to") == user_id
        if legacy_match and not assigned_services:
            assigned_services = ["All services"]
        # De-duplicate while preserving order
        seen = set()
        assigned_services = [
            s for s in assigned_services if not (s in seen or seen.add(s))
        ]

        # Coerce dates to iso strings for JSON
        created_at = c.get("created_at")
        if isinstance(created_at, datetime):
            created_at = created_at.isoformat()

        results.append(
            {
                "id": c.get("id"),
                "company_name": c.get("company_name"),
                "client_type": c.get("client_type"),
                "client_type_label": c.get("client_type_label"),
                "email": c.get("email"),
                "phone": c.get("phone"),
                "city": c.get("city"),
                "state": c.get("state"),
                "status": c.get("status") or "active",
                "services": c.get("services") or [],
                "assigned_services": assigned_services,
                "assigned_to": c.get("assigned_to"),
                "assignments": c.get("assignments") or [],
                "gstin": c.get("gstin"),
                "pan": c.get("pan"),
                "created_at": created_at,
            }
        )

    # Sort: active first, then by company name
    results.sort(
        key=lambda r: (
            0 if (r.get("status") or "active") == "active" else 1,
            (r.get("company_name") or "").lower(),
        )
    )
    return {"user_id": user_id, "count": len(results), "clients": results}


@api_router.get("/clients/pending")
async def list_pending_clients(current_user: User = Depends(get_current_user)):
    """Clients awaiting admin approval.

    Approvers (admin / can_approve_clients) see every pending client;
    everyone else only sees the ones they submitted themselves.
    """
    perms = get_user_permissions(current_user)
    is_approver = current_user.role == "admin" or perms.get("can_approve_clients", False)
    query = {"approval_status": "pending"}
    if not is_approver:
        query["created_by"] = current_user.id
    rows = (
        await db.clients.find(query, {"_id": 0})
        .sort("created_at", -1)
        .to_list(500)
    )
    return {"items": rows, "total": len(rows), "can_approve": is_approver}


@api_router.post("/clients/{client_id}/approve")
async def approve_client(client_id: str, current_user: User = Depends(get_current_user)):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_approve_clients", False):
        raise HTTPException(status_code=403, detail="Not authorized to approve clients")
    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")
    await db.clients.update_one(
        {"id": client_id},
        {
            "$set": {
                "approval_status": "approved",
                "approved_by": current_user.id,
                "approved_at": datetime.now(timezone.utc).isoformat(),
                "rejection_reason": None,
            }
        },
    )
    return {"success": True, "id": client_id, "approval_status": "approved"}


@api_router.post("/clients/{client_id}/reject")
async def reject_client(
    client_id: str, payload: dict = Body(default={}), current_user: User = Depends(get_current_user)
):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_approve_clients", False):
        raise HTTPException(status_code=403, detail="Not authorized to reject clients")
    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")
    await db.clients.update_one(
        {"id": client_id},
        {
            "$set": {
                "approval_status": "rejected",
                "approved_by": current_user.id,
                "approved_at": datetime.now(timezone.utc).isoformat(),
                "rejection_reason": (payload or {}).get("reason") or "",
            }
        },
    )
    return {"success": True, "id": client_id, "approval_status": "rejected"}


def _pending_visibility_clause(current_user, permissions):
    """Pending clients are only visible to their creator and to approvers."""
    if current_user.role == "admin" or permissions.get("can_approve_clients", False):
        return None
    return {
        "$or": [
            {"approval_status": {"$in": [None, "approved"]}},
            {"approval_status": {"$exists": False}},
            {"created_by": current_user.id},
        ]
    }


def _build_clients_access_query(current_user, permissions, team_ids=None):
    """Helper: build the MongoDB access-control query for a given user.

    Visibility rules (Records → Clients):
      • admin                      → every client
      • can_view_all_clients       → every client
      • everyone else              → only clients assigned to them (plus the
        ones they created and any explicitly granted in assigned_clients)
    Pending (unapproved) clients are hidden from everyone except their
    creator and users who can approve clients.
    """
    pending_clause = _pending_visibility_clause(current_user, permissions)

    if current_user.role == "admin" or permissions.get("can_view_all_clients", False):
        return {} if pending_clause is None else pending_clause

    extra_clients = permissions.get("assigned_clients", []) or []
    or_clauses = [
        {"assigned_to": current_user.id},
        {"created_by": current_user.id},
        {"assignments.user_id": current_user.id},
    ]
    if extra_clients:
        or_clauses.append({"id": {"$in": extra_clients}})
    if current_user.role == "manager" and team_ids:
        or_clauses.append({"assigned_to": {"$in": team_ids}})
        or_clauses.append({"assignments.user_id": {"$in": team_ids}})
    access = {"$or": or_clauses}
    if pending_clause is None:
        return access
    return {"$and": [access, pending_clause]}


def _normalize_client_dates(client: dict) -> dict:
    """Normalize legacy client records for stable frontend filtering and JSON serialization."""
    raw_type = str(client.get("client_type") or "").strip().lower().replace("-", "_").replace(" ", "_")
    type_aliases = {
        "llp": "llp", "limited_liability_partnership": "llp",
        "limited_liability_partnership_llp": "llp",
        "private_limited": "pvt_ltd", "private_limited_company": "pvt_ltd",
        "public_limited": "public_ltd", "public_limited_company": "public_ltd",
        "section8": "section_8", "section_8_company": "section_8",
    }
    if raw_type:
        client["client_type"] = type_aliases.get(raw_type, raw_type)
    if isinstance(client.get("created_at"), str):
        try:
            client["created_at"] = datetime.fromisoformat(client["created_at"])
        except ValueError:
            client["created_at"] = None
    if client.get("birthday") and isinstance(client["birthday"], str):
        try:
            client["birthday"] = date.fromisoformat(client["birthday"])
        except ValueError:
            client["birthday"] = None
    return client


@api_router.get("/clients", response_model=List[Client])
async def get_clients(
    current_user: User = Depends(check_module_permission("clients", "view")),
    page: int = Query(1, ge=1),
    page_size: int = Query(100, ge=1, le=1000),
):
    """
    Return clients with pagination so the first page renders fast.
    Default page_size=100 keeps initial payload small; callers can pass
    page_size=500 (or loop pages) when they need the full list (e.g. export).
    """
    permissions = get_user_permissions(current_user)
    team_ids = None
    if current_user.role == "manager":
        team_ids = await get_team_user_ids(current_user.id)

    query = _build_clients_access_query(current_user, permissions, team_ids)

    skip = (page - 1) * page_size
    clients = (
        await db.clients.find(query, {"_id": 0})
        .sort("company_name", 1)
        .skip(skip)
        .limit(page_size)
        .to_list(page_size)
    )

    return [_normalize_client_dates(c) for c in clients]


@api_router.get("/clients/search")
async def search_clients(
    q: str = Query("", min_length=0),
    limit: int = Query(30, ge=1, le=100),
    current_user: User = Depends(check_module_permission("clients", "view")),
):
    """
    Fast server-side search used by the Merge dialog (and anywhere else that
    needs a quick typeahead).  Returns only the fields needed for display so
    the payload stays tiny.
    """
    permissions = get_user_permissions(current_user)
    team_ids = None
    if current_user.role == "manager":
        team_ids = await get_team_user_ids(current_user.id)

    access_query = _build_clients_access_query(current_user, permissions, team_ids)

    # Build text filter (regex — fast enough for ≤10 k docs)
    search_filter: dict = {}
    if q.strip():
        regex = {"$regex": q.strip(), "$options": "i"}
        search_filter = {
            "$or": [
                {"company_name": regex},
                {"phone": regex},
                {"email": regex},
                {"gstin": regex},
            ]
        }

    # Combine access control + text filter
    if access_query and search_filter:
        combined = {"$and": [access_query, search_filter]}
    elif search_filter:
        combined = search_filter
    else:
        combined = access_query

    # Minimal projection — only what the Merge dialog renders
    projection = {
        "_id": 0,
        "id": 1,
        "company_name": 1,
        "client_type": 1,
        "phone": 1,
        "email": 1,
        "gstin": 1,
        "status": 1,
    }

    clients = (
        await db.clients.find(combined, projection)
        .sort("company_name", 1)
        .limit(limit)
        .to_list(limit)
    )
    return clients


@api_router.get("/clients/{client_id}", response_model=Client)
async def get_client(client_id: str, current_user: User = Depends(get_current_user)):
    client = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not client:
        raise HTTPException(status_code=404, detail="Client not found")

    # Issue #5: BOTH permission AND visibility must pass
    # Permission check (clients.view → can_view_all_clients)
    assert_module_permission(current_user, "clients", "view")
    # Visibility check - admin passes inside assert_module_permission
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        can_view_all = permissions.get("can_view_all_clients", False)
        is_assigned = client.get("assigned_to") == current_user.id
        is_created_by = client.get("created_by") == current_user.id
        extra_clients = permissions.get("assigned_clients", []) or []
        in_extra_list = client_id in extra_clients
        # Per-service multi-user assignments
        assignments = client.get("assignments") or []
        in_assignments = any(
            (a or {}).get("user_id") == current_user.id for a in assignments
        )
        # Manager also sees team-assigned clients (including per-service team assignments)
        team_in = False
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            team_in = client.get("assigned_to") in team_ids or any(
                (a or {}).get("user_id") in team_ids for a in assignments
            )

        if not (
            can_view_all
            or is_assigned
            or is_created_by
            or in_extra_list
            or in_assignments
            or team_in
        ):
            raise HTTPException(
                status_code=403, detail="Not authorized to view this client"
            )

    if isinstance(client["created_at"], str):
        client["created_at"] = datetime.fromisoformat(client["created_at"])
    if client.get("birthday") and isinstance(client["birthday"], str):
        client["birthday"] = date.fromisoformat(client["birthday"])
    return Client(**client)


@api_router.put("/clients/{client_id}", response_model=Client)
async def update_client(
    client_id: str,
    client_data: dict,  # <-- Changed from ClientCreate to dict
    current_user: User = Depends(check_module_permission("clients", "edit")),
):
    """
    Update an existing client record.

    Accepts a raw dict instead of ClientCreate so that:
      - Extra frontend-only fields (address, city, state, client_type_label)
        are accepted without causing Pydantic validation failures.
      - Empty strings sent by the frontend (email="", phone="") are
        safely converted to None before any validation runs.
      - The referred_by field can be any string without pattern checks.

    Only fields in ALLOWED_FIELDS are written to the database.
    """
    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")

    perms = get_user_permissions(current_user)
    if current_user.role != "admin":
        can_edit_all = perms.get("can_edit_clients", False)
        is_assigned = existing.get("assigned_to") == current_user.id
        is_created_by = existing.get("created_by") == current_user.id
        extra_clients = perms.get("assigned_clients", []) or []
        in_extra_list = client_id in extra_clients
        # Per-service multi-user assignments
        assignments = existing.get("assignments") or []
        in_assignments = any(
            (a or {}).get("user_id") == current_user.id for a in assignments
        )

        if not (
            can_edit_all
            or is_assigned
            or is_created_by
            or in_extra_list
            or in_assignments
        ):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Not authorized to edit this client. Ask an admin for the "
                    "\"Clients — edit / update any client\" permission."
                ),
            )

    # ── Whitelist: only persist known fields ────────────────────────
    ALLOWED_FIELDS = {
        "company_name",
        "client_type",
        "client_type_label",
        "email",
        "phone",
        "birthday",
        "date_of_incorporation",
        "address",
        "city",
        "state",
        "services",
        "notes",
        "assigned_to",
        "assignments",
        "status",
        "contact_persons",
        "dsc_details",
        "referred_by",
        # Tax & Billing
        "gstin",
        "pan",
        "gst_treatment",
        "place_of_supply",
        "default_payment_terms",
        "credit_limit",
        "opening_balance",
        "opening_balance_type",
        "tally_ledger_name",
        "tally_group",
        "website",
        "msme_number",
        "gst_address",
        "gst_city",
        "gst_state",
        "gst_pin",
        # MCA / ROC
        "cin",
        "llpin",
        "mca_fetch_date",
        "mca_company_status",
        "pincode",
        "mca_registration_number",
        "mca_roc_name",
        "mca_rd_name",
        "mca_company_category",
        "mca_company_subcategory",
        "mca_listed",
        "mca_active_compliance",
        "mca_authorized_capital",
        "mca_paid_up_capital",
        "mca_last_agm_date",
        "mca_balance_sheet_date",
        "mca_books_address",
        "mca_charges",
        "mca_loan_details",
        # ITR Client
        "is_itr_client",
        "itr_data",
    }
    update_data = {k: v for k, v in client_data.items() if k in ALLOWED_FIELDS}

    # ── Convert empty strings → None for nullable fields ────────────
    NULLABLE_FIELDS = {
        "email",
        "phone",
        "referred_by",
        "notes",
        "assigned_to",
        "birthday",
        "date_of_incorporation",
        "address",
        "city",
        "state",
        "client_type_label",
        "gstin",
        "pan",
        "place_of_supply",
        "default_payment_terms",
        "credit_limit",
        "opening_balance",
        "tally_ledger_name",
        "tally_group",
        "website",
        "msme_number",
        "gst_address",
        "gst_city",
        "gst_state",
        "gst_pin",
    }
    for field in NULLABLE_FIELDS:
        if field in update_data and update_data[field] == "":
            update_data[field] = None

    # ── Validate and normalise client_type ──────────────────────────
    VALID_CLIENT_TYPES = {
        "proprietor",
        "pvt_ltd",
        "llp",
        "partnership",
        "huf",
        "trust",
        "other",
        # Accept legacy uppercase variants from old data
        "LLP",
        "PVT_LTD",
    }
    if "client_type" in update_data:
        ct = update_data["client_type"]
        if ct not in VALID_CLIENT_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"Invalid client_type '{ct}'. Must be one of: proprietor, pvt_ltd, llp, partnership, huf, trust, other",
            )
        # Normalise to lowercase for consistent storage
        lower_map = {"LLP": "llp", "PVT_LTD": "pvt_ltd"}
        update_data["client_type"] = lower_map.get(ct, ct)

    # ── Validate company_name length ────────────────────────────────
    if "company_name" in update_data:
        name = str(update_data["company_name"]).strip()
        if len(name) < 3:
            raise HTTPException(
                status_code=422,
                detail="Company name must be at least 3 characters long",
            )
        update_data["company_name"] = name

    # ── Validate phone if provided ──────────────────────────────────
    if update_data.get("phone"):
        cleaned_phone = re.sub(r"\s|-|\+", "", str(update_data["phone"]))
        if not cleaned_phone.isdigit():
            raise HTTPException(
                status_code=422, detail="Phone number must contain only digits"
            )
        if not (10 <= len(cleaned_phone) <= 15):
            raise HTTPException(
                status_code=422, detail="Phone number must be 10–15 digits"
            )

    # ── Sanitise date fields before writing so DB always stores ISO strings ──
    def safe_iso(val):
        """Convert None / str / date / datetime → ISO date string (YYYY-MM-DD) or None."""
        if val is None:
            return None
        if isinstance(val, str):
            return val[:10] if val else None
        if isinstance(val, (date, datetime)):
            return val.isoformat()[:10]
        return str(val)

    for date_field in ("birthday", "date_of_incorporation"):
        if date_field in update_data:
            update_data[date_field] = safe_iso(update_data[date_field])

    # Sanitise dates inside dsc_details sub-documents
    if "dsc_details" in update_data and isinstance(update_data["dsc_details"], list):
        for dsc in update_data["dsc_details"]:
            if isinstance(dsc, dict):
                dsc["issue_date"] = safe_iso(dsc.get("issue_date"))
                dsc["expiry_date"] = safe_iso(dsc.get("expiry_date"))

    # Sanitise dates inside contact_persons sub-documents
    if "contact_persons" in update_data and isinstance(
        update_data["contact_persons"], list
    ):
        for cp in update_data["contact_persons"]:
            if isinstance(cp, dict):
                cp["birthday"] = safe_iso(cp.get("birthday"))

    # ── Persist ─────────────────────────────────────────────────────
    await db.clients.update_one({"id": client_id}, {"$set": update_data})

    # Sanitise existing record before passing to audit log so that bare
    # date objects (datetime.date) in old DB records don't cause a
    # pymongo BSON encode error (InvalidDocument) → 500.
    sanitised_existing = convert_objectids(existing)

    await create_audit_log(
        current_user,
        action="UPDATE_CLIENT",
        module="client",
        record_id=client_id,
        old_data=sanitised_existing,
        new_data=update_data,
    )

    updated = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if updated is None:
        raise HTTPException(status_code=404, detail="Client not found after update")

    if isinstance(updated.get("created_at"), str):
        try:
            updated["created_at"] = datetime.fromisoformat(updated["created_at"])
        except ValueError:
            updated["created_at"] = datetime.now(timezone.utc)
    if updated.get("birthday") and isinstance(updated["birthday"], str):
        try:
            updated["birthday"] = date.fromisoformat(updated["birthday"])
        except ValueError:
            updated["birthday"] = None
    if updated.get("date_of_incorporation") and isinstance(
        updated["date_of_incorporation"], str
    ):
        try:
            updated["date_of_incorporation"] = date.fromisoformat(
                updated["date_of_incorporation"]
            )
        except ValueError:
            updated["date_of_incorporation"] = None

    # Strip fields not in Pydantic model before constructing Client
    client_fields = Client.model_fields.keys()
    safe_updated = {k: v for k, v in updated.items() if k in client_fields}
    try:
        return Client(**safe_updated)
    except Exception as e:
        logger.error(
            f"update_client response construction error for {client_id}: {e}",
            exc_info=True,
        )
        raise HTTPException(
            status_code=500, detail=f"Client updated but response failed: {str(e)}"
        )


@api_router.delete("/clients/{client_id}")
async def delete_client(client_id: str, current_user: User = Depends(get_current_user)):
    """
    Delete a client by ID.
    - Nullifies any leads that reference this client (converted_client_id)
      so FK-style references don't leave dangling data.
    - Requires can_delete_data permission (admin always passes).
    """
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_delete_data", False):
        raise HTTPException(
            status_code=403, detail="You do not have permission to delete clients"
        )

    existing = await db.clients.find_one({"id": client_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Client not found")

    # Nullify any leads that were converted to this client
    await db.leads.update_many(
        {"converted_client_id": client_id}, {"$set": {"converted_client_id": None}}
    )

    # Also unlink tasks referencing this client
    await db.tasks.update_many({"client_id": client_id}, {"$set": {"client_id": None}})

    await create_audit_log(
        current_user,
        action="DELETE_CLIENT",
        module="client",
        record_id=client_id,
        old_data=existing,
    )

    result = await db.clients.delete_one({"id": client_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Client not found")

    return {
        "message": f"Client '{existing.get('company_name', client_id)}' deleted successfully"
    }


# ============================================
