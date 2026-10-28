"""Phase 2 extracted subsystem: compliance_due_dates.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/compliance_due_dates.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import check_permission
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.dependencies import get_user_permissions
from backend.models import DueDate
from backend.models import DueDateCreate
from backend.models import User
from backend.server_modules.helpers import create_audit_log
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import Query
from fastapi import UploadFile
from io import BytesIO
from typing import List
import re
from backend.server import IST, api_router, logger  # created in backend/server.py before route modules load
from backend.server_modules.routes.document_routes import COMPLIANCE_RULES, MONTH_MAP

def parse_date_from_text(text: str):
    text = text.strip()
    now = datetime.now()
    year = now.year

    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(january|february|march|april|may|june|july|august|september|october|november|december)"
        r"\s+(\d{4})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            return date(
                int(m.group(3)), MONTH_MAP[m.group(2).lower()], int(m.group(1))
            ).isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december)"
        r"\s+(\d{1,2}),?\s+(\d{4})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            return date(
                int(m.group(3)), MONTH_MAP[m.group(1).lower()], int(m.group(2))
            ).isoformat()
        except Exception:
            pass

    m = re.search(r"\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b", text)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1))).isoformat()
        except Exception:
            pass

    m = re.search(r"\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b", text)
    if m:
        try:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3))).isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+"
        r"(january|february|march|april|may|june|july|august|september|october|november|december)\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = MONTH_MAP[m.group(2).lower()]
            d_val = int(m.group(1))
            target = date(year, mo, d_val)
            if target < date.today():
                target = date(year + 1, mo, d_val)
            return target.isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(january|february|march|april|may|june|july|august|september|october|november|december)"
        r"\s+(\d{1,2})\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = MONTH_MAP[m.group(1).lower()]
            d_val = int(m.group(2))
            target = date(year, mo, d_val)
            if target < date.today():
                target = date(year + 1, mo, d_val)
            return target.isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+next\s+month\b", text, re.IGNORECASE
    )
    if m:
        try:
            day = int(m.group(1))
            today = date.today()
            if today.month < 12:
                target = date(today.year, today.month + 1, day)
            else:
                target = date(today.year + 1, 1, day)
            return target.isoformat()
        except Exception:
            pass

    m = re.search(r"within\s+(\d+)\s+days?", text, re.IGNORECASE)
    if m:
        try:
            return (date.today() + timedelta(days=int(m.group(1)))).isoformat()
        except Exception:
            pass

    m = re.search(
        r"\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\b",
        text,
        re.IGNORECASE,
    )
    if m:
        try:
            mo = MONTH_MAP[m.group(2).lower()]
            d_val = int(m.group(1))
            target = date(year, mo, d_val)
            if target < date.today():
                target = date(year + 1, mo, d_val)
            return target.isoformat()
        except Exception:
            pass

    return None


def classify_compliance(line: str):
    lower = line.lower()
    for rule in COMPLIANCE_RULES:
        if any(kw in lower for kw in rule["keywords"]):
            return {"category": rule["category"], "department": rule["department"]}
    return {"category": "Other", "department": "OTHER"}


def extract_title(line: str) -> str:
    title = re.sub(r"\s+", " ", line).strip()
    title = re.sub(r"^[\-\*\•\|]+\s*", "", title)
    if len(title) > 80:
        title = title[:77].rsplit(" ", 1)[0] + "..."
    return title or "Compliance Task"


def parse_compliance_dates(raw_text: str):
    results = []
    seen = set()
    lines = [l.strip() for l in raw_text.splitlines() if l.strip()]

    for i, line in enumerate(lines):
        if "|" not in line:
            continue
        cols = [c.strip() for c in line.split("|") if c.strip()]
        if len(cols) < 2:
            continue
        date_val = None
        date_col_idx = None
        for idx, col in enumerate(cols):
            d = parse_date_from_text(col)
            if d:
                date_col_idx = idx
                date_val = d
                break
        if not date_val and i + 1 < len(lines):
            date_val = parse_date_from_text(lines[i + 1])
        if not date_val:
            continue
        title_col = next(
            (c for idx, c in enumerate(cols) if idx != date_col_idx and len(c) > 3),
            None,
        )
        if not title_col:
            continue
        title = extract_title(title_col)
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        clf = classify_compliance(line)
        results.append(
            {
                "title": title,
                "due_date": date_val,
                "category": clf["category"],
                "department": clf["department"],
                "description": title_col[:300],
                "status": "pending",
            }
        )

    for i, line in enumerate(lines):
        if len(line) < 8:
            continue
        if re.match(
            r"^(form|compliance|particulars|due date|applicability|sl\.?\s*no)",
            line,
            re.IGNORECASE,
        ):
            continue
        date_val = parse_date_from_text(line)
        if not date_val and i + 1 < len(lines):
            date_val = parse_date_from_text(lines[i + 1])
        if not date_val:
            continue
        clf = classify_compliance(line)
        if clf["category"] == "Other" and clf["department"] == "OTHER" and i > 0:
            clf = classify_compliance(lines[i - 1])
        title = extract_title(line)
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        stripped = re.sub(
            r"\d{1,2}(?:st|nd|rd|th)?\s+\w+\s*\d{0,4}", "", line, flags=re.IGNORECASE
        ).strip()
        if len(stripped) < 5:
            continue
        results.append(
            {
                "title": title,
                "due_date": date_val,
                "category": clf["category"],
                "department": clf["department"],
                "description": line[:300],
                "status": "pending",
            }
        )

    form_pat = re.compile(
        r"((?:GSTR?|ITR|MGT|AOC|DIR|DPT|ADT|PAS|INC|CHG|BEN|SH|CSR|MSME)-[\w\/]+)",
        re.IGNORECASE,
    )
    for i, line in enumerate(lines):
        m = form_pat.search(line)
        if not m:
            continue
        form_name = m.group(1).upper()
        date_val = None
        for j in range(i, min(i + 3, len(lines))):
            date_val = parse_date_from_text(lines[j])
            if date_val:
                break
        if not date_val:
            continue
        title = f"{form_name} Filing"
        if title.lower() in seen:
            continue
        seen.add(title.lower())
        clf = classify_compliance(form_name + " " + line)
        results.append(
            {
                "title": title,
                "due_date": date_val,
                "category": clf["category"],
                "department": clf["department"],
                "description": extract_title(line),
                "status": "pending",
            }
        )

    results.sort(key=lambda x: x.get("due_date", "9999-12-31"))
    return results


# Route registered BEFORE /{due_date_id} param routes to prevent shadowing
@api_router.post("/duedates/extract-from-file")
async def extract_due_dates_from_file(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    filename = (file.filename or "").lower()
    content_type = file.content_type or ""
    file_bytes = await file.read()
    raw_text = ""

    try:
        if content_type.startswith("image/") or filename.endswith(
            (".jpg", ".jpeg", ".png", ".webp", ".bmp")
        ):
            raise HTTPException(
                status_code=400,
                detail="Image upload is not supported on this server. Please upload a PDF or DOCX file instead.",
            )

        elif content_type == "application/pdf" or filename.endswith(".pdf"):
            import pdfplumber

            parts = []
            with pdfplumber.open(BytesIO(file_bytes)) as pdf:
                for page in pdf.pages:
                    t = page.extract_text()
                    if t:
                        parts.append(t)
                    for table in page.extract_tables():
                        for row in table:
                            if row:
                                parts.append("  |  ".join(str(c or "") for c in row))
            raw_text = "\n".join(parts)

        elif filename.endswith((".docx", ".doc")):
            from docx import Document as DocxDocument

            doc = DocxDocument(BytesIO(file_bytes))
            parts = [p.text for p in doc.paragraphs if p.text.strip()]
            for table in doc.tables:
                for row in table.rows:
                    parts.append("  |  ".join(cell.text for cell in row.cells))
            raw_text = "\n".join(parts)

        else:
            raise HTTPException(
                status_code=400,
                detail="Unsupported file type. Use JPG, PNG, PDF, or DOCX.",
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"File extraction error: {e}")
        raise HTTPException(status_code=422, detail=f"Could not read file: {str(e)}")

    if not raw_text or len(raw_text.strip()) < 20:
        raise HTTPException(
            status_code=422,
            detail="No readable text found. Try a clearer image or PDF.",
        )

    extracted = parse_compliance_dates(raw_text)

    if not extracted:
        raise HTTPException(
            status_code=404, detail="No compliance dates detected in this document."
        )

    return {"extracted": extracted, "count": len(extracted)}


# ─── Calendar → Compliance Tracker sync helper ───────────────────────────────
_CALENDAR_CATEGORY_MAP = {
    "GST": "GST",
    "ROC": "ROC",
    "MCA": "ROC",
    "ITR": "ITR",
    "TDS": "TDS",
    "AUDIT": "AUDIT",
    "PF": "PF_ESIC",
    "ESIC": "PF_ESIC",
    "PT": "PT",
    "INCOME TAX": "ITR",
}
_COMPLIANCE_CATEGORIES = ["ROC", "GST", "ITR", "TDS", "AUDIT", "PF_ESIC", "PT", "OTHER"]


async def _sync_due_date_to_compliance(dd: dict, current_user) -> None:
    """Upsert a compliance_master record linked to the given due_date doc."""
    title = (dd.get("title") or "").strip()
    dd_id = dd.get("id")
    due_date = dd.get("due_date")
    if isinstance(due_date, datetime):
        due_date = due_date.strftime("%Y-%m-%d")
    elif isinstance(due_date, str) and "T" in due_date:
        due_date = due_date[:10]

    raw_cat = (dd.get("category") or "OTHER").upper()
    category = _CALENDAR_CATEGORY_MAP.get(raw_cat, "OTHER")
    if category not in _COMPLIANCE_CATEGORIES:
        category = "OTHER"

    existing = await db.compliance_masters.find_one(
        {"calendar_due_date_id": dd_id}, {"_id": 0}
    )
    now_str = datetime.now(timezone.utc).isoformat()

    if existing:
        await db.compliance_masters.update_one(
            {"id": existing["id"]},
            {"$set": {"due_date": due_date, "name": title, "updated_at": now_str}},
        )
    else:
        import uuid as _uuid

        doc = {
            "id": str(_uuid.uuid4()),
            "name": title,
            "category": category,
            "frequency": "one_time",
            "fy_year": None,
            "period_label": None,
            "due_date": due_date,
            "description": dd.get("description", ""),
            "applicable_entity_types": [],
            "calendar_due_date_id": dd_id,
            "created_by": str(getattr(current_user, "id", "")),
            "created_by_name": getattr(current_user, "full_name", ""),
            "created_at": now_str,
            "updated_at": now_str,
        }
        await db.compliance_masters.insert_one({**doc, "_id": doc["id"]})


@api_router.post("/duedates", response_model=DueDate)
async def create_due_date(
    due_date_data: DueDateCreate, current_user: User = Depends(get_current_user)
):
    try:
        if not due_date_data.department:
            raise HTTPException(status_code=400, detail="Department required")

        data = due_date_data.model_dump()

        # ✅ FIX 1: Safe date parsing
        raw_due_date = data.get("due_date")

        if isinstance(raw_due_date, str):
            try:
                parsed_date = datetime.fromisoformat(raw_due_date)
            except:
                parsed_date = datetime.strptime(raw_due_date, "%m/%d/%Y")
        else:
            parsed_date = raw_due_date

        # ✅ FIX 2: Build document safely
        data["due_date"] = parsed_date

        due_date = DueDate(**data, created_by=current_user.id)

        doc = due_date.model_dump()

        # ✅ FIX 3: Safe datetime conversion
        if isinstance(doc.get("created_at"), datetime):
            doc["created_at"] = doc["created_at"].isoformat()

        if isinstance(doc.get("due_date"), datetime):
            doc["due_date"] = doc["due_date"].isoformat()

        # ✅ INSERT
        await db.due_dates.insert_one(doc)

        # ✅ FIX 4: REMOVE ObjectId if added
        doc.pop("_id", None)

        # ✅ Auto-sync to Compliance Tracker
        try:
            await _sync_due_date_to_compliance(doc, current_user)
        except Exception as sync_err:
            logger.warning(f"Compliance sync after create failed: {sync_err}")

        return doc

    except Exception as e:
        logger.error(f"DueDate creation failed: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to save due date")


# ──────────────────────────────────────────────────────────────────────────────
# PATCH 1 of 1  —  GET /api/duedates/upcoming
# File: main.py  (replace the entire get_upcoming_due_dates function)
#
# ROOT CAUSE: the old guard `if now <= dd_date <= future_date` excluded every
# overdue item (dd_date < now).  The Dashboard welcome banner and Deadlines card
# therefore showed nothing when ALL pending items were already past due.
#
# FIX: drop the `now <=` lower bound so overdue items are included.
#       days_remaining is already negative for overdue items via
#       `(dd_date - now).days`, which is correct.
# ──────────────────────────────────────────────────────────────────────────────


@api_router.get("/duedates/upcoming")
async def get_upcoming_due_dates(
    days: int = Query(30), current_user: User = Depends(get_current_user)
):
    now = datetime.now(IST)
    future_date = now + timedelta(days=days)

    query = {"status": "pending"}
    if current_user.role != "admin":
        if current_user.departments:
            query["department"] = {"$in": current_user.departments}
        else:
            return []

    due_dates = await db.due_dates.find(query, {"_id": 0}).to_list(1000)

    # Build a set of compliance names/titles that are closed so we can
    # exclude their matching due_dates entries from the dashboard widget.
    closed_masters = await db.compliance_masters.find(
        {"is_closed": True}, {"_id": 0, "name": 1, "calendar_due_date_id": 1}
    ).to_list(1000)
    closed_names = {m["name"].strip().lower() for m in closed_masters if m.get("name")}
    closed_cal_ids = {
        m["calendar_due_date_id"]
        for m in closed_masters
        if m.get("calendar_due_date_id")
    }

    results = []

    for dd in due_dates:
        # Skip if this due_date is directly linked to a closed compliance master
        if dd.get("id") in closed_cal_ids:
            continue
        # Skip if the title matches a closed compliance master name (case-insensitive)
        if dd.get("title", "").strip().lower() in closed_names:
            continue

        dd_date = (
            datetime.fromisoformat(dd["due_date"])
            if isinstance(dd["due_date"], str)
            else dd["due_date"]
        )
        # Ensure dd_date is timezone-aware for safe comparison with IST-aware `now`
        if dd_date.tzinfo is None:
            dd_date = dd_date.replace(tzinfo=IST)

        if dd_date <= future_date:
            dd["due_date"] = dd_date
            dd["days_remaining"] = (dd_date - now).days  # negative = overdue
            results.append(dd)

    # Sort: overdue first (most-negative days_remaining), then by closest due date
    return sorted(results, key=lambda x: x["days_remaining"])


@api_router.get("/duedates", response_model=List[DueDate])
async def get_due_dates(current_user: User = Depends(get_current_user)):
    query = {}
    if current_user.role == "admin":
        pass
    elif current_user.role == "manager":
        if current_user.departments:
            query["department"] = {"$in": current_user.departments}
    else:
        permissions = get_user_permissions(current_user)
        if not permissions.get("can_view_all_duedates", False):
            if current_user.departments:
                query["department"] = {"$in": current_user.departments}
            else:
                return []
    due_dates = await db.due_dates.find(query, {"_id": 0}).to_list(1000)
    for dd in due_dates:
        if isinstance(dd.get("created_at"), str):
            dd["created_at"] = datetime.fromisoformat(dd["created_at"])
        if isinstance(dd.get("due_date"), str):
            dd["due_date"] = datetime.fromisoformat(dd["due_date"])
    return [DueDate(**dd) for dd in due_dates]


@api_router.put("/duedates/{due_date_id}", response_model=DueDate)
async def update_due_date(
    due_date_id: str,
    due_date_data: DueDateCreate,
    current_user: User = Depends(check_permission("can_edit_due_dates")),
):
    existing = await db.due_dates.find_one({"id": due_date_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Due date not found")
    update_data = due_date_data.model_dump()
    update_data["due_date"] = update_data["due_date"].isoformat()
    await db.due_dates.update_one({"id": due_date_id}, {"$set": update_data})
    await create_audit_log(
        current_user,
        action="UPDATE_DUE_DATE",
        module="duedate",
        record_id=due_date_id,
        old_data=existing,
        new_data=update_data,
    )
    updated = await db.due_dates.find_one({"id": due_date_id}, {"_id": 0})
    if isinstance(updated.get("created_at"), str):
        updated["created_at"] = datetime.fromisoformat(updated["created_at"])
    if isinstance(updated.get("due_date"), str):
        updated["due_date"] = datetime.fromisoformat(updated["due_date"])

    # Auto-sync updated due_date to Compliance Tracker
    try:
        sync_doc = dict(updated)
        if isinstance(sync_doc.get("due_date"), datetime):
            sync_doc["due_date"] = sync_doc["due_date"].isoformat()
        sync_doc["id"] = due_date_id
        await _sync_due_date_to_compliance(sync_doc, current_user)
    except Exception as sync_err:
        logger.warning(f"Compliance sync after update failed: {sync_err}")

    return DueDate(**updated)


@api_router.delete("/duedates/{due_date_id}")
async def delete_due_date(
    due_date_id: str,
    current_user: User = Depends(check_permission("can_edit_due_dates")),
):
    existing = await db.due_dates.find_one({"id": due_date_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Due date not found")
    await create_audit_log(
        current_user,
        action="DELETE_DUE_DATE",
        module="duedate",
        record_id=due_date_id,
        old_data=existing,
    )
    result = await db.due_dates.delete_one({"id": due_date_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Due date not found")
    return {"message": "Due date deleted successfully"}


# Registered before /clients/{client_id} to prevent route shadowing
