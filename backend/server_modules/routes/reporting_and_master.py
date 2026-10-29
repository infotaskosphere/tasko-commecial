"""Phase 2 extracted subsystem: reporting_and_master.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/reporting_and_master.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import check_module_permission
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.dependencies import get_user_permissions
from backend.models import PerformanceMetric
from backend.models import User
from backend.server_modules.helpers import create_audit_log
from backend.server_modules.helpers import safe_dt
from collections import Counter
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import Query
from fastapi import UploadFile
from fastapi.responses import StreamingResponse
from fpdf import FPDF
from io import BytesIO
from io import StringIO
from typing import List
from typing import Optional
import asyncio
import csv
import os
import pandas as pd
import uuid
from backend.server import IST, api_router, logger  # created in backend/server.py before route modules load
from backend.server_modules.routes.users_todos_admin import _scope_users_query_by_company
rankings_cache = {}
rankings_cache_time = {}  # per-process cache for staff rankings

@api_router.get("/leads/meta/services")
async def get_leads_services_meta(current_user: User = Depends(get_current_user)):
    if current_user.role != "admin":
        perms = get_user_permissions(current_user)
        if not perms.get("can_view_all_leads", False):
            raise HTTPException(status_code=403, detail="Leads access not permitted")
    services = await db.clients.distinct("services")
    services = [s for s in services if s and isinstance(s, str)]
    return {"services": list(set(services))}


# REPORTS ROUTES
@api_router.get("/reports/efficiency")
async def get_efficiency_report(
    user_id: Optional[str] = None,
    current_user: User = Depends(check_module_permission("reports", "view")),
):
    target_user_id = user_id or current_user.id
    if target_user_id != current_user.id:
        perms = get_user_permissions(current_user)
        if current_user.role != "admin" and not perms.get("can_view_reports", False):
            raise HTTPException(
                status_code=403, detail="You do not have permission to view reports"
            )
    if target_user_id != current_user.id:
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_reports", []) or []
            # All non-admin roles (including manager) can only see own + explicitly granted users.
            # Manager does NOT get automatic team access to reports — must be granted via view_other_reports.
            if target_user_id not in allowed_users:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view other users' reports",
                )
    logs = (
        await db.activity_logs.find({"user_id": target_user_id}, {"_id": 0})
        .sort("date", -1)
        .limit(30)
        .to_list(100)
    )
    total_screen_time = sum(l.get("screen_time_minutes", 0) for l in logs)
    total_tasks_completed = sum(l.get("tasks_completed", 0) for l in logs)
    target_user_doc = await db.users.find_one(
        {"id": target_user_id}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0}
    )
    user_info = {
        "id": target_user_id,
        "full_name": target_user_doc.get("full_name", "Unknown")
        if target_user_doc
        else "Unknown",
    }
    return {
        "user_id": target_user_id,
        "user": user_info,
        "total_screen_time": total_screen_time,
        "total_tasks_completed": total_tasks_completed,
        "days_logged": len(logs),
    }


@api_router.get("/reports/export")
async def export_reports(
    format: str = "csv",
    user_id: Optional[str] = None,
    current_user: User = Depends(check_module_permission("reports", "download")),
):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_download_reports", False):
        raise HTTPException(
            status_code=403, detail="You do not have permission to download reports"
        )
    target_user_id = user_id or current_user.id
    if target_user_id != current_user.id:
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_reports", []) or []
            # All non-admin roles (including manager) can only export own + explicitly granted users.
            if target_user_id not in allowed_users:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to access other users' reports",
                )
    logs = await db.activity_logs.find({"user_id": target_user_id}, {"_id": 0}).to_list(
        100
    )
    total_screen_time = sum(l.get("screen_time_minutes", 0) for l in logs)
    total_tasks_completed = sum(l.get("tasks_completed", 0) for l in logs)
    report = {
        "user_id": target_user_id,
        "total_screen_time": total_screen_time,
        "total_tasks_completed": total_tasks_completed,
        "days_logged": len(logs),
    }
    if format == "csv":
        output = StringIO()

        def sanitize_csv_value(val):
            val_str = str(val)
            # Strip newlines to prevent CSV row injection in addition to formula injection
            val_str = val_str.replace("\r", "").replace("\n", " ")
            if val_str and val_str[0] in ["=", "+", "-", "@"]:
                return f"'{val_str}"
            return val_str

        writer = csv.writer(output)
        writer.writerow(["User ID", "Screen Time", "Tasks Completed", "Days Logged"])
        writer.writerow(
            [
                sanitize_csv_value(report["user_id"]),
                sanitize_csv_value(report["total_screen_time"]),
                sanitize_csv_value(report["total_tasks_completed"]),
                sanitize_csv_value(report["days_logged"]),
            ]
        )
        output.seek(0)
        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={
                "Content-Disposition": f"attachment; filename=efficiency_report_{target_user_id}.csv"
            },
        )
    elif format == "pdf":
        pdf = FPDF()
        pdf.add_page()
        pdf.set_font("Arial", size=12)
        pdf.cell(200, 10, txt="Efficiency Report", ln=1, align="C")
        pdf.ln(10)
        pdf.multi_cell(0, 8, f"User ID: {report['user_id']}")
        pdf.multi_cell(0, 8, f"Screen Time: {report['total_screen_time']} minutes")
        pdf.multi_cell(0, 8, f"Tasks Completed: {report['total_tasks_completed']}")
        pdf.multi_cell(0, 8, f"Days Logged: {report['days_logged']}")
        pdf_output = BytesIO()
        pdf_output.write(pdf.output(dest="S").encode("latin1"))
        pdf_output.seek(0)
        return StreamingResponse(
            pdf_output,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=efficiency_report_{target_user_id}.pdf"
            },
        )
    else:
        raise HTTPException(status_code=400, detail="Invalid format")


# ====================== PERFORMANCE RANKINGS ======================
# --- Scoring configuration (env-overridable) ---
# Monthly work-hours target used for the Work Hours component of the score.
MONTHLY_HOURS_TARGET = float(os.environ.get("MONTHLY_HOURS_TARGET", 180))
# Extra hours beyond the target are converted into bonus points at this rate,
# capped at HOURS_BONUS_POINTS_MAX. Bonus points are strictly additive.
HOURS_BONUS_POINTS_PER_HOUR = float(os.environ.get("HOURS_BONUS_POINTS_PER_HOUR", 0.1))
HOURS_BONUS_POINTS_MAX = float(os.environ.get("HOURS_BONUS_POINTS_MAX", 5))


@api_router.get("/reports/performance-rankings", response_model=List[PerformanceMetric])
async def get_performance_rankings(
    period: str = Query("monthly", enum=["weekly", "monthly", "all_time"]),
    # FIX: was check_module_permission("reports","view") → can_view_reports.
    # Called as a secondary/widget call by Attendance page. All roles may see rankings.
    current_user: User = Depends(get_current_user),
):
    global rankings_cache, rankings_cache_time
    # Ranking results are tenant-scoped. A single global cache key can
    # otherwise return Licensee A's users to Licensee B or to the Platform Owner.
    from backend.platform_owner import is_platform_owner
    if is_platform_owner(current_user):
        ranking_scope = "platform-owner"
    else:
        ranking_scope = (
            str(getattr(current_user, "commercial_customer_id", "") or "").strip()
            or str(getattr(current_user, "company_id", "") or "").strip()
            or "unscoped"
        )
    cache_key = f"rankings_{ranking_scope}_{period}"
    if (
        cache_key in rankings_cache
        and cache_key in rankings_cache_time
        and
        # Use timezone-aware UTC datetime for cache comparison to avoid TypeError
        (datetime.now(timezone.utc) - rankings_cache_time[cache_key]).total_seconds()
        < 300
    ):
        return rankings_cache[cache_key]

    now = datetime.now(IST)
    if period == "weekly":
        start_date = now - timedelta(days=7)
    elif period == "monthly":
        start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start_date = datetime(2024, 1, 1, tzinfo=timezone.utc)

    end_date_str = now.strftime("%Y-%m-%d")
    start_date_str = start_date.strftime("%Y-%m-%d")

    # FIX: expected_working_days used to be a hard-coded 22 (monthly) / 5 (weekly).
    # That unfairly tanks attendance_percent for EVERYONE right after a new period
    # starts — e.g. viewing "monthly" on the 1st compares 0-1 days present against
    # 22 expected days, so the attendance component (25% of the score) rounds to 0
    # for the whole team. We now count only the working days that have actually
    # ELAPSED so far in the period (Mon-Fri, minus confirmed company holidays).
    holiday_docs = await db.holidays.find(
        {
            "date": {"$gte": start_date_str, "$lte": end_date_str},
            "status": "confirmed",
        },
        {"_id": 0, "date": 1},
    ).to_list(500)
    holiday_dates = {h["date"] for h in holiday_docs}
    expected_working_days = 0
    cursor_date = start_date.date()
    today_date = now.date()
    while cursor_date <= today_date:
        if cursor_date.weekday() < 5 and cursor_date.isoformat() not in holiday_dates:
            expected_working_days += 1
        cursor_date += timedelta(days=1)
    expected_working_days = max(expected_working_days, 1)

    ranking_user_query = await _scope_users_query_by_company(
        current_user,
        {"role": {"$ne": "admin"}},
    )
    users = await db.users.find(
        ranking_user_query, {"id": 1, "full_name": 1, "profile_picture": 1}
    ).to_list(length=None)
    uids = [u["id"] for u in users]

    # PERF FIX: this endpoint used to run ~8 separate DB queries PER USER
    # inside the loop below (attendance, desktop-activity, 4x count_documents,
    # due-tasks, completed-todos) — for 30 staff that's 240+ sequential round
    # trips on every cache miss. It's called by both the Tasks page and the
    # Attendance page, so that N+1 pattern was the single biggest cause of lag
    # on both. Fixed by batch-fetching each collection ONCE with an `$in` on
    # all user ids, then grouping the results in Python per user below —
    # same math, 8 queries total instead of 8 x N.
    (
        all_attendance,
        all_agent_logs,
        all_due_tasks,
        all_completed_todos,
        all_tasks_assigned,
        all_completed_tasks,
        all_todos_assigned,
        all_completed_todos_count,
    ) = await asyncio.gather(
        db.attendance.find(
            {"user_id": {"$in": uids}, "date": {"$gte": start_date_str, "$lte": end_date_str}},
            {"_id": 0, "user_id": 1, "duration_minutes": 1, "is_late": 1, "status": 1},
        ).to_list(100000),
        db.desktop_activity.find(
            {"user_id": {"$in": uids}, "date": {"$gte": start_date_str, "$lte": end_date_str}},
            {"_id": 0, "user_id": 1, "activeSeconds": 1},
        ).to_list(100000),
        db.tasks.find(
            {"assigned_to": {"$in": uids}, "status": "completed", "due_date": {"$ne": None}},
            {"_id": 0, "assigned_to": 1, "due_date": 1, "completed_at": 1, "updated_at": 1},
        ).to_list(100000),
        db.todos.find(
            {"user_id": {"$in": uids}, "is_completed": True},
            {"_id": 0, "user_id": 1, "due_date": 1, "completed_at": 1},
        ).to_list(100000),
        db.tasks.find(
            {"assigned_to": {"$in": uids}}, {"_id": 0, "assigned_to": 1}
        ).to_list(100000),
        db.tasks.find(
            {"assigned_to": {"$in": uids}, "status": "completed"}, {"_id": 0, "assigned_to": 1}
        ).to_list(100000),
        db.todos.find(
            {"user_id": {"$in": uids}}, {"_id": 0, "user_id": 1}
        ).to_list(100000),
        db.todos.find(
            {"user_id": {"$in": uids}, "is_completed": True}, {"_id": 0, "user_id": 1}
        ).to_list(100000),
    )

    def _group_by(docs, key):
        out = {}
        for d in docs:
            out.setdefault(d.get(key), []).append(d)
        return out

    attendance_by_uid = _group_by(all_attendance, "user_id")
    agent_logs_by_uid = _group_by(all_agent_logs, "user_id")
    due_tasks_by_uid = _group_by(all_due_tasks, "assigned_to")
    completed_todos_by_uid = _group_by(all_completed_todos, "user_id")
    tasks_assigned_count = Counter(d.get("assigned_to") for d in all_tasks_assigned)
    completed_tasks_count = Counter(d.get("assigned_to") for d in all_completed_tasks)
    todos_assigned_count = Counter(d.get("user_id") for d in all_todos_assigned)
    completed_todos_count_map = Counter(d.get("user_id") for d in all_completed_todos_count)

    rankings = []
    for user in users:
        uid = user["id"]

        # ---------------- Attendance & punctuality ----------------
        att_records = attendance_by_uid.get(uid, [])
        # FIX: this used to count EVERY attendance document as a "present" day —
        # including the auto-marked "absent" record the system inserts each night
        # for anyone who never punched in. That silently counted absences as
        # attendance. Only present-type statuses count now; absences are tracked
        # separately below and used as an explicit discipline penalty.
        present_statuses = {"present", "half_day", "wfh", "late"}
        present_records = [r for r in att_records if r.get("status") in present_statuses]
        days_present = len(present_records)
        absent_days = len([r for r in att_records if r.get("status") == "absent"])
        total_minutes = sum(r.get("duration_minutes", 0) or 0 for r in present_records)
        total_hours = round(total_minutes / 60, 1)
        attendance_percent = round(
            min((days_present / expected_working_days) * 100, 100), 1
        )
        timely_days = len([r for r in present_records if not r.get("is_late", False)])
        timely_punchin_percent = (
            round((timely_days / days_present) * 100, 1) if days_present else 0
        )

        # ---------------- Desktop-agent hours worked on PC ----------------
        # FIX: the desktop agent already reports real active-time per day
        # (db.desktop_activity.activeSeconds) but it was never read anywhere in
        # the ranking calculation. Where the agent is installed and has reported
        # data for this period, its measured active time now drives "Duration of
        # working"; otherwise we fall back to punch-in/punch-out duration.
        agent_logs = agent_logs_by_uid.get(uid, [])
        agent_hours = round(sum(a.get("activeSeconds", 0) or 0 for a in agent_logs) / 3600, 1)
        effective_hours = agent_hours if agent_logs else total_hours

        # ---------------- Task completion percentage ----------------
        # FIX (this is what was STILL causing 0% after the first patch):
        # the numerator ("tasks completed") was gated to completed_at/updated_at
        # >= start_date. That's fine for a mid-period check, but on day 1 of a
        # new week/month essentially nobody has completed anything WITHIN that
        # brand-new window yet, so the numerator is legitimately 0 and the
        # percentage resets to 0 for the whole team every single period. This
        # metric should reflect current workload completion — the same "17/20"
        # style figure already shown on the Tasks page — not get wiped out at
        # the start of every week/month. It is now a lifetime completed/assigned
        # ratio (tasks + todos), independent of the period filter. Attendance,
        # hours and punctuality below remain correctly period-scoped, since
        # those genuinely are about "this week/month" specifically.
        tasks_assigned = tasks_assigned_count.get(uid, 0)
        completed_tasks = completed_tasks_count.get(uid, 0)
        todos_assigned = todos_assigned_count.get(uid, 0)
        completed_todos = completed_todos_count_map.get(uid, 0)
        total_assigned = tasks_assigned + todos_assigned
        total_completed = completed_tasks + completed_todos
        task_completion_percent = (
            round(min((total_completed / total_assigned) * 100, 100), 1)
            if total_assigned
            else 0
        )

        # ---------------- On-time completion ----------------
        # FIX: same period-reset problem as above, PLUS this metric used to only
        # look at db.todos (the small personal checklist) and completely ignored
        # db.tasks — the app's actual primary work unit (Task Management, 150+
        # tasks with due dates). Anyone who does real work through Tasks but
        # rarely touches the separate To-Do widget always scored 0% here, losing
        # 15 guaranteed points. This is now a lifetime on-time ratio across both
        # tasks and todos that have a due date, not reset every period.
        due_tasks = due_tasks_by_uid.get(uid, [])
        ontime_tasks = 0
        for t in due_tasks:
            due = safe_dt(t.get("due_date"))
            completed_at = safe_dt(t.get("completed_at")) or safe_dt(t.get("updated_at"))
            if due and completed_at and completed_at <= due:
                ontime_tasks += 1

        completed_todos_docs = completed_todos_by_uid.get(uid, [])
        ontime_todos = 0
        todos_with_due = 0
        for t in completed_todos_docs:
            if t.get("due_date"):
                todos_with_due += 1
                due = safe_dt(t.get("due_date"))
                completed_at = safe_dt(t.get("completed_at"))
                if due and completed_at and completed_at <= due:
                    ontime_todos += 1

        ontime_total = len(due_tasks) + todos_with_due
        ontime_completed = ontime_tasks + ontime_todos
        todo_ontime_percent = (
            round((ontime_completed / ontime_total) * 100, 1) if ontime_total else 0
        )

        # ---------------- Composite score ----------------
        # Work Hours scoring (configurable):
        #   hours < target  -> proportional points
        #   hours >= target -> ALWAYS full points (never reduced)
        #   extra hours     -> converted into bonus points (capped)
        hours_worked = float(effective_hours or 0)
        safe_hours_ratio = min((hours_worked / MONTHLY_HOURS_TARGET), 1) if hours_worked else 0
        extra_hours = max(0.0, hours_worked - MONTHLY_HOURS_TARGET)
        bonus_points = round(
            min(extra_hours * HOURS_BONUS_POINTS_PER_HOUR, HOURS_BONUS_POINTS_MAX), 2
        )
        score = (
            float(attendance_percent or 0) * 0.25
            + safe_hours_ratio * 100 * 0.20
            + float(task_completion_percent or 0) * 0.25
            + float(todo_ontime_percent or 0) * 0.15
            + float(timely_punchin_percent or 0) * 0.15
        )
        # FIX: "number of absent days" was tracked nowhere in the score even
        # though the spec calls for it. Each unexplained absence this period now
        # costs 2 pts, capped at a 10-pt maximum deduction, so it visibly affects
        # ranking without being able to wipe out an otherwise strong score.
        discipline_penalty = min(absent_days * 2, 10)
        # Bonus points are additive only — they never replace or reduce the
        # base Work Hours contribution.
        overall_score = round(min(max(score - discipline_penalty, 0) + bonus_points, 100), 1)

        if overall_score >= 95:
            badge = "Star Performer"
        elif overall_score >= 85:
            badge = "Top Performer"
        else:
            badge = "Good Performer"

        rankings.append(
            PerformanceMetric(
                user_id=str(uid),
                user_name=str(user.get("full_name", "Unknown")),
                profile_picture=user.get("profile_picture"),
                attendance_percent=float(attendance_percent or 0),
                total_hours=float(effective_hours or 0),
                task_completion_percent=float(task_completion_percent or 0),
                todo_ontime_percent=float(todo_ontime_percent or 0),
                timely_punchin_percent=float(timely_punchin_percent or 0),
                overall_score=float(overall_score or 0),
                badge=str(badge),
                auto_absent_count=int(absent_days),
                discipline_penalty=float(discipline_penalty),
                final_score=float(overall_score or 0),
                extra_hours=float(round(extra_hours, 2)),
                bonus_points=float(bonus_points),
            )
        )

    rankings.sort(key=lambda x: x.overall_score, reverse=True)
    for i, r in enumerate(rankings):
        r.rank = i + 1

    rankings_cache[cache_key] = rankings
    # Store as timezone-aware UTC datetime so comparison never throws TypeError
    rankings_cache_time[cache_key] = datetime.now(timezone.utc)
    return rankings


# ==============================================================
# INTEGRATED MASTER DATA SYSTEM & CLIENT ROUTES
# ==============================================================
@api_router.post("/master/import-master-preview")
async def import_master_data_preview(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    if current_user.role.lower() != "admin":
        raise HTTPException(
            status_code=403,
            detail="Administrative clearance required for Master Data access.",
        )
    filename = file.filename.lower()
    if not filename.endswith((".xlsx", ".xls")):
        raise HTTPException(
            status_code=400,
            detail="Deployment failed: Only Excel formats (.xlsx, .xls) supported.",
        )
    try:
        content = await file.read()
        excel = pd.ExcelFile(BytesIO(content))
        parsed_blueprint = {}
        total_vectors = 0
        for sheet_name in excel.sheet_names:
            df = pd.read_excel(excel, sheet_name=sheet_name)
            df = df.fillna("")
            records = df.to_dict(orient="records")
            parsed_blueprint[sheet_name] = records
            total_vectors += len(records)
        return {
            "status": "Ready for Audit",
            "message": f"Detected {len(excel.sheet_names)} operational layers with {total_vectors} vectors.",
            "sheets_found": excel.sheet_names,
            "data": parsed_blueprint,
        }
    except Exception as e:
        logger.error(f"Blueprint Error: {str(e)}")
        raise HTTPException(status_code=400, detail=f"Excel parse failure: {str(e)}")


@api_router.post("/master/sync-sheets")
async def sync_master_sheets(
    file: UploadFile = File(...), current_user: User = Depends(get_current_user)
):
    if current_user.role.lower() != "admin":
        raise HTTPException(
            status_code=403, detail="Master Data clearance level 5 required."
        )
    try:
        content = await file.read()
        excel = pd.ExcelFile(BytesIO(content))
        sync_results = {"clients": 0, "compliance": 0, "staff": 0}
        now_iso = datetime.now(timezone.utc).isoformat()
        for sheet in excel.sheet_names:
            df = pd.read_excel(excel, sheet_name=sheet).fillna("")
            records = df.to_dict(orient="records")
            sheet_type = sheet.lower()
            if "client" in sheet_type:
                for rec in records:
                    await db.clients.update_one(
                        {"company_name": str(rec.get("company_name", "")).strip()},
                        {
                            "$set": {
                                **rec,
                                "id": str(uuid.uuid4())
                                if "id" not in rec
                                else rec["id"],
                                "created_by": current_user.id,
                                "updated_at": now_iso,
                            }
                        },
                        upsert=True,
                    )
                    sync_results["clients"] += 1
            elif "due" in sheet_type or "compliance" in sheet_type:
                for rec in records:
                    await db.due_dates.insert_one(
                        {
                            **rec,
                            "id": str(uuid.uuid4()),
                            "created_by": current_user.id,
                            "created_at": now_iso,
                            "status": "pending",
                        }
                    )
                    sync_results["compliance"] += 1
            elif "staff" in sheet_type or "user" in sheet_type:
                for rec in records:
                    await db.users.update_one(
                        {"email": rec.get("email")},
                        {"$set": {**rec, "id": str(uuid.uuid4()), "is_active": True}},
                        upsert=True,
                    )
                    sync_results["staff"] += 1
            await create_audit_log(
                current_user=current_user,
                action="GLOBAL_MASTER_SYNC",
                module="master_data",
                record_id="multi_sheet_payload",
                new_data=sync_results,
            )
        return {
            "message": "Global Master Sync Successfully Executed",
            "telemetry": sync_results,
        }
    except Exception as e:
        logger.error(f"Sync Failure: {str(e)}")
        raise HTTPException(
            status_code=400, detail=f"Database synchronization failed: {str(e)}"
        )


# ==============================================================
# GST CERTIFICATE PDF PARSER  (pure pdfplumber — no 3rd-party AI)
# ==============================================================

# ─────────────────────────────────────────────────────────────────────────────
# Legacy company-list compatibility route
# Attendance still requests GET /api/companies/list. Keep this read-only route
# available after the Phase 2 extraction without changing the Attendance UI or
# company-master data model. The tenant-aware db.companies collection applies
# the existing company visibility scope for the authenticated user.
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/companies/list")
async def list_companies_for_attendance(current_user: User = Depends(get_current_user)):
    companies = await db.companies.find(
        {},
        {
            "_id": 0,
            "id": 1,
            "name": 1,
            "company_name": 1,
            "commercial_customer_id": 1,
            "status": 1,
            "gstin": 1,
            "pan": 1,
        },
    ).sort("name", 1).to_list(5000)
    return companies


