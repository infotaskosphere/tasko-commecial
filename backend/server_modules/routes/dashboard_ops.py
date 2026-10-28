"""Phase 2 extracted subsystem: dashboard_ops.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/dashboard_ops.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import check_permission
from backend.dependencies import db
from backend.dependencies import get_cross_visibility_union
from backend.dependencies import get_current_user
from backend.dependencies import get_team_user_ids
from backend.dependencies import get_user_permissions
from backend.dependencies import personal_birthday_candidates
from backend.dependencies import require_admin
from backend.models import DashboardStats
from backend.models import Reminder
from backend.models import ReminderCreate
from backend.models import User
from backend.server_modules.helpers import convert_objectids
from datetime import date
from datetime import datetime
from datetime import timezone
from fastapi import Depends
from fastapi import HTTPException
from pydantic import BaseModel
from typing import List
from typing import Optional
import asyncio
import os
import uuid
from backend.server import IST, api_router, logger  # created in backend/server.py before route modules load
from backend.server_modules.routes.email_service_routes import _brevo_send
from backend.server_modules.routes.users_todos_admin import _scope_users_query_by_company

@api_router.get("/dashboard/dept-members")
async def get_dept_member_count(current_user: User = Depends(get_current_user)):
    """
    Returns count + basic info of users in the same department(s) as the current user.
    Accessible by all roles (admin, manager, staff).
    - Admin: returns count of ALL active users.
    - Manager: returns count of same-department users (staff + other managers).
    - Staff: returns count of same-department users (staff + managers).
    """
    if current_user.role == "admin":
        # Keep Platform Owner and customer/licensee identities isolated even
        # though both may carry role=admin. Reuse the authoritative Users
        # visibility helper so dashboard counts cannot bypass tenant scope.
        user_scope = await _scope_users_query_by_company(
            current_user,
            {"is_active": True, "status": "active"},
        )
        all_users = await db.users.find(
            user_scope,
            {"_id": 0, "id": 1, "full_name": 1, "departments": 1, "role": 1},
        ).to_list(1000)
        return {
            "count": len(all_users),
            "departments": [],
            "members": [
                {
                    "id": u["id"],
                    "full_name": u.get("full_name", ""),
                    "role": u.get("role", ""),
                }
                for u in all_users
            ],
        }

    user_depts = current_user.departments or []
    if not user_depts:
        return {"count": 0, "departments": [], "members": []}

    dept_users = await db.users.find(
        {
            "departments": {"$in": user_depts},
            "id": {"$ne": current_user.id},
            "is_active": True,
            "status": "active",
        },
        {"_id": 0, "id": 1, "full_name": 1, "departments": 1, "role": 1},
    ).to_list(500)

    return {
        "count": len(dept_users),
        "departments": user_depts,
        "members": [
            {
                "id": u["id"],
                "full_name": u.get("full_name", ""),
                "role": u.get("role", ""),
            }
            for u in dept_users
        ],
    }


@api_router.get("/dashboard/stats", response_model=DashboardStats)
async def get_dashboard_stats(current_user: User = Depends(get_current_user)):
    try:
        return await _get_dashboard_stats_impl(current_user)
    except Exception as exc:
        logger.exception("Dashboard stats failed; returning safe fallback: %s", exc)
        try:
            total_tasks = await db.tasks.count_documents({})
            completed_tasks = await db.tasks.count_documents({"status": "completed"})
            pending_tasks = await db.tasks.count_documents({"status": "pending"})
            total_dsc = await db.dsc_register.count_documents({})
            total_clients = await db.clients.count_documents({})
        except Exception:
            total_tasks = completed_tasks = pending_tasks = total_dsc = total_clients = 0
        return DashboardStats(
            total_tasks=int(total_tasks),
            completed_tasks=int(completed_tasks),
            pending_tasks=int(pending_tasks),
            overdue_tasks=0,
            total_dsc=int(total_dsc),
            expiring_dsc_count=0,
            expiring_dsc_list=[],
            total_clients=int(total_clients),
            upcoming_birthdays=0,
            upcoming_due_dates=0,
            team_workload=[],
            compliance_status={},
            expired_dsc_count=0,
        )

async def _get_dashboard_stats_impl(current_user: User = Depends(get_current_user)):
        now = datetime.now(IST)
        task_query = {}
        if current_user.role != "admin":
            permissions = get_user_permissions(current_user)
            if not permissions.get("can_view_all_tasks", False):
                allowed_users = permissions.get("view_other_tasks", []) or []
                if current_user.role == "manager":
                    team_ids = await get_team_user_ids(current_user.id)
                    allowed_users = list(set(allowed_users + team_ids))
                task_query["$or"] = [
                    {"assigned_to": current_user.id},
                    {"sub_assignees": current_user.id},
                    {"created_by": current_user.id},
                    {"assigned_to": {"$in": allowed_users}},
                ]

        # PERF FIX: these six queries are independent of one another (none depends
        # on another's result), but were previously awaited one-at-a-time in series
        # — each round trip to Mongo adds its own latency, so six serial calls take
        # roughly 6x as long as they need to. Firing them concurrently with
        # asyncio.gather cuts dashboard load time down to the slowest single query
        # instead of the sum of all of them.
        if current_user.role == "admin":
            client_query = {}
        else:
            permissions_for_clients = get_user_permissions(current_user)
            extra_clients = permissions_for_clients.get("assigned_clients", []) or []
            or_clauses = [
                {"assigned_to": current_user.id},
                {"created_by": current_user.id},
                {"assignments": {"$elemMatch": {"user_id": current_user.id}}},
            ]
            if extra_clients:
                or_clauses.append({"id": {"$in": extra_clients}})
            client_query = {"$or": or_clauses}

        due_date_query = {"status": "pending"}
        if current_user.role != "admin" and current_user.departments:
            due_date_query["department"] = {"$in": current_user.departments}

        async def _empty_list():
            return []

        # PERF: Use tight projections — fetch only the fields this handler actually
        # reads. Eliminates transmitting large blobs (notes, attachments, address
        # strings, etc.) that the dashboard never touches.
        (
            tasks,
            dsc_list,
            clients,
            closed_masters_stat,
            due_dates,
            users_for_workload,
        ) = await asyncio.gather(
            db.tasks.find(task_query, {
                "_id": 0, "id": 1, "status": 1, "due_date": 1,
                "assigned_to": 1, "sub_assignees": 1, "created_by": 1,
            }).to_list(length=None),
            db.dsc_register.find({}, {
                "_id": 0, "id": 1, "holder_name": 1,
                "certificate_number": 1, "expiry_date": 1,
            }).to_list(length=None),
            db.clients.find(client_query, {
                "_id": 0, "id": 1, "birthday": 1, "client_type": 1,
                "contact_persons": 1, "company_name": 1,
            }).to_list(length=None),
            db.compliance_masters.find(
                {"is_closed": True}, {"_id": 0, "name": 1, "calendar_due_date_id": 1}
            ).to_list(length=None),
            db.due_dates.find(due_date_query, {
                "_id": 0, "id": 1, "title": 1, "due_date": 1, "department": 1,
            }).to_list(length=None),
            db.users.find(
                await _scope_users_query_by_company(current_user, {}),
                {"_id": 0, "id": 1, "full_name": 1},
            ).to_list(length=None)
            if current_user.role != "staff"
            else _empty_list(),
        )
        total_tasks = len(tasks)
        completed_tasks = len([t for t in tasks if t["status"] == "completed"])
        pending_tasks = len([t for t in tasks if t["status"] == "pending"])
        overdue_tasks = 0
        for task in tasks:
            if task.get("due_date") and task["status"] != "completed":
                try:
                    due_date = (
                        datetime.fromisoformat(task["due_date"])
                        if isinstance(task["due_date"], str)
                        else task["due_date"]
                    )
                    if due_date.tzinfo is None:
                        due_date = due_date.replace(tzinfo=timezone.utc)
                    if due_date < now:
                        overdue_tasks += 1
                except (ValueError, TypeError):
                    continue

        total_dsc = len(dsc_list)
        expiring_dsc_count = 0
        expired_dsc_count = 0
        expiring_dsc_list = []
        for dsc in dsc_list:
            try:
                expiry_date = (
                    datetime.fromisoformat(dsc["expiry_date"])
                    if isinstance(dsc["expiry_date"], str)
                    else dsc["expiry_date"]
                )
                days_left = (expiry_date - now).days
                if days_left < 0:
                    expired_dsc_count += 1
                if days_left <= 90:
                    expiring_dsc_count += 1
                    expiring_dsc_list.append(
                        {
                            "id": dsc["id"],
                            "holder_name": dsc["holder_name"],
                            "certificate_number": dsc.get("certificate_number", "N/A"),
                            "expiry_date": dsc["expiry_date"],
                            "days_left": days_left,
                            "status": "expired" if days_left < 0 else "expiring",
                        }
                    )
            except (ValueError, TypeError):
                continue

        total_clients = len(clients)
        today = date.today()
        upcoming_birthdays = 0

        for client in clients:
            for person in personal_birthday_candidates(client):
                raw = person["birthday"]
                try:
                    bday = (
                        date.fromisoformat(raw[:10])
                        if isinstance(raw, str)
                        else raw
                    )
                    try:
                        this_year_bday = bday.replace(year=today.year)
                    except ValueError:
                        this_year_bday = bday.replace(year=today.year, day=28)
                    if this_year_bday < today:
                        try:
                            this_year_bday = bday.replace(year=today.year + 1)
                        except ValueError:
                            this_year_bday = bday.replace(year=today.year + 1, day=28)
                    days_until = (this_year_bday - today).days
                    if 0 <= days_until <= 7:
                        upcoming_birthdays += 1
                except (ValueError, TypeError):
                    continue

        upcoming_due_dates_count = 0

        # Exclude due_dates whose compliance master is marked closed
        closed_names_stat = {
            m["name"].strip().lower() for m in closed_masters_stat if m.get("name")
        }
        closed_cal_ids_stat = {
            m["calendar_due_date_id"]
            for m in closed_masters_stat
            if m.get("calendar_due_date_id")
        }

        for dd in due_dates:
            if dd.get("id") in closed_cal_ids_stat:
                continue
            if dd.get("title", "").strip().lower() in closed_names_stat:
                continue
            try:
                dd_date = (
                    datetime.fromisoformat(dd["due_date"])
                    if isinstance(dd["due_date"], str)
                    else dd["due_date"]
                )
                days_until_due = (dd_date - now).days
                if days_until_due <= 120:
                    upcoming_due_dates_count += 1
            except (ValueError, TypeError):
                continue

        team_workload = []
        if current_user.role != "staff":
            for user in users_for_workload:
                user_tasks = [t for t in tasks if t.get("assigned_to") == user["id"]]
                team_workload.append(
                    {
                        "user_id": user["id"],
                        "user_name": user["full_name"],
                        "total_tasks": len(user_tasks),
                        "pending_tasks": len(
                            [t for t in user_tasks if t["status"] == "pending"]
                        ),
                        "completed_tasks": len(
                            [t for t in user_tasks if t["status"] == "completed"]
                        ),
                    }
                )

        compliance_score = 100
        if total_tasks > 0:
            compliance_score -= (overdue_tasks / total_tasks) * 50
        if total_dsc > 0:
            compliance_score -= (expiring_dsc_count / total_dsc) * 30

        compliance_status = {
            "score": max(0, int(compliance_score)),
            "status": "good"
            if compliance_score >= 80
            else "warning"
            if compliance_score >= 50
            else "critical",
            "overdue_tasks": overdue_tasks,
            "expiring_certificates": expiring_dsc_count,
        }

        return DashboardStats(
            total_tasks=total_tasks,
            completed_tasks=completed_tasks,
            pending_tasks=pending_tasks,
            overdue_tasks=overdue_tasks,
            total_dsc=total_dsc,
            expiring_dsc_count=expiring_dsc_count,
            expiring_dsc_list=expiring_dsc_list,
            total_clients=total_clients,
            upcoming_birthdays=upcoming_birthdays,
            upcoming_due_dates=upcoming_due_dates_count,
            team_workload=team_workload,
            compliance_status=compliance_status,
            expired_dsc_count=expired_dsc_count,
        )


# ==========================================================
# STAFF ACTIVITY ROUTES
# Activity ingestion is owned by backend.activity_log_ingestion.

@api_router.get("/activity/summary")
async def get_activity_summary(
    user_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: User = Depends(check_permission("can_view_staff_activity")),
):
    # PERMISSION MATRIX:
    # Admin   → all activity
    # Manager → own activity only + explicitly granted via view_other_activity list
    # Staff   → own activity only + explicitly granted via view_other_activity list
    # (Manager does NOT get automatic team access — must be granted by admin)
    query = {}
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_others = permissions.get("view_other_activity", []) or []
        # All non-admin roles use the same rule: own + explicit cross-vis list
        visible_ids = list(set(allowed_others + [current_user.id]))

        if user_id:
            if user_id != current_user.id and user_id not in visible_ids:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorised to view this user's activity",
                )
            query["user_id"] = user_id
        else:
            query["user_id"] = {"$in": visible_ids}
    if date_from or date_to:
        query["timestamp"] = {}
    if date_from:
        try:
            query["timestamp"]["$gte"] = datetime.fromisoformat(date_from)
        except Exception:
            pass
    if date_to:
        try:
            query["timestamp"]["$lte"] = datetime.fromisoformat(date_to)
        except Exception:
            pass
    # PERF: tight projection + 5 000-record cap.  The aggregation below only
    # reads six fields per document; fetching the full document (~20 fields
    # including raw page-title strings) wastes bandwidth and memory.
    activities = await db.staff_activity.find(query, {
        "_id": 0,
        "user_id": 1, "duration_seconds": 1, "app_name": 1,
        "category": 1, "website": 1, "idle": 1,
    }).sort("timestamp", -1).limit(5000).to_list(5000)
    user_summary = {}
    for activity in activities:
        uid = activity.get("user_id")
        if not uid:
            continue
        duration = activity.get("duration_seconds") or 0
        app_name = activity.get("app_name", "Unknown App")
        category = activity.get("category", "other")
        website = activity.get("website")
        idle = activity.get("idle", False)
        if uid not in user_summary:
            user_summary[uid] = {
                "user_id": uid,
                "total_duration": 0,
                "active_duration": 0,
                "idle_duration": 0,
                "apps": {},
                "websites": {},
                "categories": {},
            }
        user_summary[uid]["total_duration"] += duration
        if idle:
            user_summary[uid]["idle_duration"] += duration
        else:
            user_summary[uid]["active_duration"] += duration
        if app_name not in user_summary[uid]["apps"]:
            user_summary[uid]["apps"][app_name] = {"count": 0, "duration": 0}
        user_summary[uid]["apps"][app_name]["count"] += 1
        user_summary[uid]["apps"][app_name]["duration"] += duration
        if website:
            if website not in user_summary[uid]["websites"]:
                user_summary[uid]["websites"][website] = 0
            user_summary[uid]["websites"][website] += duration
        if category not in user_summary[uid]["categories"]:
            user_summary[uid]["categories"][category] = 0
        user_summary[uid]["categories"][category] += duration
    users = await db.users.find({}, {"_id": 0, "password": 0}).to_list(200)
    user_map = {
        u.get("id"): u.get("full_name", "Unknown") for u in users if u.get("id")
    }
    result = []
    for uid, data in user_summary.items():
        data["user_name"] = user_map.get(uid, "Unknown")
        data["apps_list"] = sorted(
            [{"name": k, **v} for k, v in data["apps"].items()],
            key=lambda x: x["duration"],
            reverse=True,
        )
        productive_duration = data["categories"].get("productivity", 0)
        total_duration = data["total_duration"]
        data["productivity_percent"] = (
            (productive_duration / total_duration) * 100 if total_duration > 0 else 0
        )
        result.append(data)

    intensity_map = {}
    radar_metrics = {}
    tool_chain_data = []
    for item in result:
        uid = item["user_id"]
        intensity_map[uid] = {
            "duration": item["total_duration"],
            "productivity_percent": item["productivity_percent"],
        }
        radar_metrics[uid] = {
            "productivity": item["productivity_percent"],
            "attendance": 75,
            "task_completion": 80,
        }
        tool_chain_data.append(
            {"user_id": uid, "top_apps": item.get("apps_list", [])[:3]}
        )
    for item in result:
        uid = item["user_id"]
        item["intensityMap"] = intensity_map.get(uid, {})
        item["radarMetrics"] = radar_metrics.get(uid, {})
        item["toolChainData"] = next(
            (t for t in tool_chain_data if t["user_id"] == uid), {}
        )
    return result


@api_router.get("/activity/user/{user_id}")
async def get_user_activity(
    user_id: str,
    limit: int = 100,
    current_user: User = Depends(check_permission("can_view_staff_activity")),
):
    # PERMISSION MATRIX:
    # Admin   → any user's activity
    # Manager → own activity + explicitly granted via view_other_activity (no auto team)
    # Staff   → own activity + explicitly granted via view_other_activity
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_others = permissions.get("view_other_activity", []) or []
        visible_ids = list(set(allowed_others + [current_user.id]))
        if user_id != current_user.id and user_id not in visible_ids:
            raise HTTPException(
                status_code=403,
                detail="You are not authorised to view this user's activity",
            )
    activities = (
        await db.staff_activity.find({"user_id": user_id}, {"_id": 0})
        .sort("timestamp", -1)
        .to_list(limit)
    )
    return activities


# TASK REMINDER ROUTES
# ─── Email Template Defaults ──────────────────────────────────────────────────
_DEFAULT_TASK_EMAIL_TEMPLATE = {
    "accent_color": os.getenv("EMAIL_ACCENT_COLOR", "#4F46E5"),
    "company_name": os.getenv("EMAIL_COMPANY_NAME", "Enterprise Workspace"),
    "tagline": os.getenv("EMAIL_TAGLINE", "Your Productivity. Our Priority."),
    "support_email": os.getenv("SUPPORT_EMAIL", "support@enterprise.com"),
    "website": os.getenv("COMPANY_WEBSITE", "www.enterprise.com"),
    "footer_note": "This is an automated notification. Please do not reply directly to this email.",
    "subject_prefix": "⏰ You Have Pending Tasks!",
    "greeting_line": "We hope you are doing well. This is an automated reminder to let you know that you have pending tasks that require your attention. Please review and complete them at your earliest convenience.",
    "tips": [
        "Log in daily to review and update your task status.",
        "Use the Priority filter to focus on High-priority tasks first.",
        "Set personal reminders inside the app so you never miss a deadline.",
        "Reach out to your team lead if you need deadline extensions or support.",
    ],
}


def build_reminder_email(
    user_name: str,
    task_list: list,
    user_map: dict = None,
    tpl: dict = None,
) -> tuple[str, str]:
    """
    Builds a rich HTML + plain-text task reminder email.
    tpl: optional dict with customisable template fields (from DB email_templates).
    user_map: dict of {user_id: full_name} for resolving 'Assigned By'.
    Returns (subject, html_body).
    """
    from datetime import datetime, timezone

    import html as _html
    import re as _re

    t = {**_DEFAULT_TASK_EMAIL_TEMPLATE, **(tpl or {})}
    subject_prefix = str(t.get("subject_prefix") or "")
    # Template fields are editable by admins and task titles by any user:
    # escape everything that is placed into the HTML body.
    t = {
        k: (_html.escape(v) if isinstance(v, str)
            else [_html.escape(str(x)) for x in v] if isinstance(v, list) else v)
        for k, v in t.items()
    }
    user_map = user_map or {}
    acc = t["accent_color"] if _re.fullmatch(r"#[0-9A-Fa-f]{3,8}", str(t.get("accent_color") or "")) else "#4F46E5"
    t["website"] = _re.sub(r"^https?://", "", str(t.get("website") or ""))
    user_name = _html.escape(str(user_name or ""))
    first = user_name.split()[0] if user_name else "there"
    now = datetime.now(timezone.utc)

    def fmt_date(raw):
        if not raw or raw == "N/A":
            return "N/A"
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            return dt.strftime("%d %b %Y")
        except Exception:
            return str(raw)[:10]

    def parse_dt(raw):
        if not raw:
            return None
        try:
            dt = datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            # Ensure always timezone-aware so comparison with now (UTC) never crashes
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None

    def priority_info(p):
        p = (p or "medium").lower()
        if p in ("critical", "high"):
            return ("🔴", "High", "#dc2626", "#fee2e2")
        if p == "medium":
            return ("🟠", "Medium", "#ea580c", "#fff7ed")
        return ("🟡", "Low", "#ca8a04", "#fefce8")

    def status_color(s):
        s = (s or "pending").lower().replace("_", " ")
        if s in ("completed", "done"):
            return ("#16a34a", "#dcfce7")
        if s in ("in progress",):
            return ("#2563eb", "#dbeafe")
        return ("#6b7280", "#f3f4f6")

    total_count = len(task_list)
    overdue_count = sum(
        1
        for t2 in task_list
        if parse_dt(t2.get("due_date")) and parse_dt(t2.get("due_date")) < now
    )
    week_secs = 7 * 86400
    due_week_count = sum(
        1
        for t2 in task_list
        if parse_dt(t2.get("due_date"))
        and 0 <= (parse_dt(t2.get("due_date")) - now).total_seconds() <= week_secs
    )

    # ── Subject ───────────────────────────────────────────────────────────────
    subject = f"{subject_prefix} — {total_count} Task{'s' if total_count != 1 else ''} Pending"

    # ── Build task rows ───────────────────────────────────────────────────────
    task_rows_html = ""
    for idx, task in enumerate(task_list, start=1):
        title = _html.escape(str(task.get("title") or "Untitled"))
        assigned_by = _html.escape(str(user_map.get(task.get("created_by", ""), "Admin")))
        due_str = fmt_date(task.get("due_date"))
        prio_ico, prio_label, prio_fg, prio_bg = priority_info(task.get("priority"))
        status_raw = (task.get("status") or "Pending").replace("_", " ").title()
        st_fg, st_bg = status_color(task.get("status"))
        row_bg = "#ffffff" if idx % 2 == 1 else "#f8fafc"
        task_rows_html += f"""
        <tr style="background:{row_bg}">
          <td style="padding:10px 14px;color:#64748b;font-size:13px;text-align:center;border-bottom:1px solid #e2e8f0">{idx}</td>
          <td style="padding:10px 14px;color:#1e293b;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0">{title}</td>
          <td style="padding:10px 14px;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0">{assigned_by}</td>
          <td style="padding:10px 14px;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0">{due_str}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:{prio_bg};color:{prio_fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{prio_ico} {prio_label}</span>
          </td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:{st_bg};color:{st_fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{status_raw}</span>
          </td>
        </tr>"""

    # ── Tips rows ─────────────────────────────────────────────────────────────
    tips_html = "".join(
        f'<li style="margin:6px 0;color:#475569;font-size:14px">✔&nbsp; {tip}</li>'
        for tip in t["tips"]
    )

    # ── Full HTML ─────────────────────────────────────────────────────────────
    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:30px 0">
<tr><td align="center">
<table width="620" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <!-- HEADER -->
  <tr>
    <td style="background:linear-gradient(135deg,{acc} 0%,#7C3AED 100%);padding:36px 40px 28px;text-align:center">
      <p style="margin:0 0 6px;color:rgba(255,255,255,0.75);font-size:12px;letter-spacing:2px;text-transform:uppercase">{t["company_name"]}</p>
      <h1 style="margin:0 0 8px;color:#ffffff;font-size:26px;font-weight:800">⏰ You Have Pending Tasks!</h1>
      <p style="margin:0;color:rgba(255,255,255,0.85);font-size:13px;font-style:italic">{t["tagline"]}</p>
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td style="padding:32px 40px 0">
      <p style="margin:0 0 8px;color:#1e293b;font-size:16px">Dear <strong>{user_name}</strong>,</p>
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.7">{t["greeting_line"]}</p>
    </td>
  </tr>

  <!-- SUMMARY STATS -->
  <tr>
    <td style="padding:24px 40px">
      <p style="margin:0 0 14px;color:#1e293b;font-size:15px;font-weight:700">📊 Task Summary</p>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" style="padding:0 6px 0 0">
            <div style="background:#f0f4ff;border-radius:12px;padding:16px;text-align:center">
              <p style="margin:0;font-size:28px;font-weight:800;color:{acc}">{total_count}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Total Pending</p>
            </div>
          </td>
          <td width="33%" style="padding:0 3px">
            <div style="background:#fff1f2;border-radius:12px;padding:16px;text-align:center">
              <p style="margin:0;font-size:28px;font-weight:800;color:#dc2626">{overdue_count}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Overdue</p>
            </div>
          </td>
          <td width="33%" style="padding:0 0 0 6px">
            <div style="background:#f0fdf4;border-radius:12px;padding:16px;text-align:center">
              <p style="margin:0;font-size:28px;font-weight:800;color:#16a34a">{due_week_count}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Due This Week</p>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- TASK TABLE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0 0 14px;color:#1e293b;font-size:15px;font-weight:700">📋 Your Pending Tasks</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        <thead>
          <tr style="background:{acc}">
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:center">#</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Task Name</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Assigned By</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Due Date</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Priority</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Status</th>
          </tr>
        </thead>
        <tbody>{task_rows_html}
        </tbody>
      </table>
    </td>
  </tr>

  <!-- CTA BUTTON -->
  <tr>
    <td style="padding:0 40px 28px;text-align:center">
      <a href="https://{t["website"]}" style="display:inline-block;background:linear-gradient(135deg,{acc},#7C3AED);color:#ffffff;font-weight:700;font-size:15px;padding:14px 36px;border-radius:30px;text-decoration:none">🚀 Take Action Now &rarr;</a>
    </td>
  </tr>

  <!-- TIPS -->
  <tr>
    <td style="padding:0 40px 28px">
      <div style="background:#f8fafc;border-left:4px solid {acc};border-radius:8px;padding:18px 20px">
        <p style="margin:0 0 10px;color:#1e293b;font-size:14px;font-weight:700">💡 Quick Tips to Stay on Track</p>
        <ul style="margin:0;padding-left:16px">{tips_html}</ul>
      </div>
    </td>
  </tr>

  <!-- DIVIDER & FOOTER NOTE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6">If you have any questions or face issues accessing your tasks, please contact your system administrator or reply to this email.</p>
      <p style="margin:14px 0 0;color:#1e293b;font-size:14px">Thank you for your continued dedication.</p>
      <p style="margin:10px 0 0;color:#1e293b;font-size:14px">Warm regards,<br><strong>The {t["company_name"]} Team</strong></p>
      <p style="margin:6px 0 0;color:{acc};font-size:13px">{t["support_email"]} &nbsp;|&nbsp; {t["website"]}</p>
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f8fafc;padding:16px 40px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="margin:0;color:#94a3b8;font-size:11px">{t["footer_note"]}</p>
      <p style="margin:6px 0 0;color:#94a3b8;font-size:11px">© 2026 {t["company_name"]}. All rights reserved.</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>"""

    return subject, html


@api_router.get("/reminders/due-popups")
async def get_due_reminder_popups(current_user: User = Depends(get_current_user)):
    """
    Polled every ~30s by ReminderPopupManager.jsx on the frontend.

    Returns reminders for the current user that are due (remind_at <= now),
    not yet dismissed, and not yet fired — then marks them as fired so they
    don't pop up again on the next poll.

    Also folds in any `db.notifications` docs created with popup=True (e.g.
    the per-task / bulk "raise a popup" button on the Tasks page Actions
    column, sent via POST /notifications/send) that haven't been shown yet,
    so both systems feed the same on-screen popup + desktop Notification()
    pipeline on the frontend.

    ACCESS RULE (popup gating):
      - Admin: always allowed (default on, not revocable via governance).
      - Manager / staff: allowed ONLY IF both are true —
          1. `can_receive_popup_reminders` is granted on their permissions
             (ADMIN_GRANTED_ONLY by default; toggled via Permission
             Governance, same as can_send_reminders).
          2. Cross visibility is switched on for them, i.e. at least one
             view_other_* array is non-empty (get_cross_visibility_union
             returns at least one id).
      If either condition fails, no popups are fetched or marked fired —
      the underlying reminders stay pending so they can fire once the
      user is granted access.
    """
    if current_user.role != "admin":
        perms = get_user_permissions(current_user)
        has_popup_permission = perms.get("can_receive_popup_reminders", False)
        cross_visibility_on = bool(await get_cross_visibility_union(current_user.id))
        if not (has_popup_permission and cross_visibility_on):
            return []

    now_iso = datetime.now(timezone.utc).isoformat()
    cursor = db.reminders.find({
        "user_id": str(current_user.id),
        "remind_at": {"$lte": now_iso},
        "is_dismissed": False,
        "is_fired": False,
    }).sort("remind_at", 1).limit(20)

    due_docs = await cursor.to_list(length=20)
    if due_docs:
        ids = [doc["_id"] for doc in due_docs]
        await db.reminders.update_many(
            {"_id": {"$in": ids}},
            {"$set": {"is_fired": True, "updated_at": now_iso}},
        )

    results = [
        {
            "id": str(doc.get("_id")),
            "type": doc.get("reminder_type", "reminder"),
            "title": doc.get("title", "Reminder"),
            "message": doc.get("description", ""),
            "task_id": doc.get("related_task_id"),
        }
        for doc in due_docs
    ]

    popup_cursor = db.notifications.find({
        "user_id": str(current_user.id),
        "popup": True,
        "is_read": False,
    }).sort("created_at", 1).limit(20)
    popup_docs = await popup_cursor.to_list(length=20)
    if popup_docs:
        popup_ids = [doc["id"] for doc in popup_docs if doc.get("id")]
        if popup_ids:
            await db.notifications.update_many(
                {"id": {"$in": popup_ids}},
                {"$set": {"is_read": True}},
            )
        results.extend([
            {
                "id": doc.get("id"),
                "type": doc.get("type") or "task_popup",
                "title": doc.get("title", "Reminder"),
                "message": doc.get("message", ""),
                "task_id": doc.get("task_id"),
            }
            for doc in popup_docs
        ])

    return results


@api_router.post("/reminders", response_model=Reminder)
async def create_manual_reminder(
    reminder_data: ReminderCreate,
    current_user: User = Depends(get_current_user),
):
    """Create a reminder only after an explicit user approval click.

    The client discussion assistant never calls this endpoint while it is
    analysing a transcript. The UI sends a request only from its
    "Approve & create reminder" action, keeping automation opt-in.
    """
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        if not permissions.get("can_view_reminders", False):
            raise HTTPException(status_code=403, detail="Reminder permission required")

    now = datetime.now(timezone.utc)
    remind_at = reminder_data.remind_at
    if isinstance(remind_at, (datetime, date)):
        remind_at = remind_at.isoformat()
    else:
        remind_at = str(remind_at)

    reminder = Reminder(
        user_id=str(current_user.id),
        title=reminder_data.title.strip(),
        description=reminder_data.description,
        remind_at=remind_at,
        event_id=reminder_data.event_id or f"client-discussion-{uuid.uuid4()}",
        source=reminder_data.source or "manual",
        priority=reminder_data.priority or "medium",
        reminder_type=reminder_data.reminder_type or "reminder",
        related_task_id=reminder_data.related_task_id,
        popup_interval_minutes=reminder_data.popup_interval_minutes,
        created_at=now,
        updated_at=now,
    )
    document = reminder.model_dump()
    document["id"] = str(uuid.uuid4())
    document["created_at"] = now.isoformat()
    document["updated_at"] = now.isoformat()
    await db.reminders.insert_one(document)
    document.pop("_id", None)
    return document


@api_router.post("/send-pending-task-reminders")

async def send_pending_task_reminders(current_user: User = Depends(get_current_user)):
    perms = get_user_permissions(current_user)
    if current_user.role != "admin" and not perms.get("can_send_reminders", False):
        raise HTTPException(status_code=403, detail="Reminder permission required")
    tasks = await db.tasks.find({"status": {"$ne": "completed"}}, {"_id": 0}).to_list(
        1000
    )
    if not tasks:
        return {
            "message": "No pending tasks found",
            "emails_sent": 0,
            "emails_failed": [],
        }

    # Batch lookup: collect all unique assigned_to IDs, fetch users in one query
    assigned_ids = list({t["assigned_to"] for t in tasks if t.get("assigned_to")})
    users_list = await db.users.find({"id": {"$in": assigned_ids}}, {"_id": 0}).to_list(
        1000
    )
    user_by_id = {u["id"]: u for u in users_list}

    user_task_map = {}
    for task in tasks:
        assigned_to = task.get("assigned_to")
        if not assigned_to:
            continue
        user = user_by_id.get(assigned_to)
        if not user:
            continue
        email = user.get("email")
        if not email:
            continue
        user_task_map.setdefault(email, {"user": user, "tasks": []})["tasks"].append(
            task
        )

    # Fetch all users for "Assigned By" column + email template settings
    all_users = await db.users.find({}, {"_id": 0, "id": 1, "full_name": 1}).to_list(
        500
    )
    user_map = {u["id"]: u.get("full_name", "Admin") for u in all_users}
    tpl_doc = await db.email_templates.find_one({"type": "task_reminder"}, {"_id": 0})
    tpl = tpl_doc.get("settings") if tpl_doc else None

    success_count = 0
    failed_emails = []
    for email, data in user_task_map.items():
        try:
            user_name = data["user"].get("full_name", "")
            subject, html_body = build_reminder_email(
                user_name, data["tasks"], user_map=user_map, tpl=tpl
            )
            sent = await _brevo_send(
                email,
                subject,
                body_plain=f"Hello {user_name},\n\nYou have {len(data['tasks'])} pending tasks. Please log in to Task-O-Sphere to review them.",
                body_html=html_body,
            )
            if sent:
                success_count += 1
            else:
                failed_emails.append(email)
        except Exception as e:
            failed_emails.append(email)
            logger.error(f"Error sending reminder to {email}: {str(e)}")
    return {
        "message": "Reminder process completed",
        "total_users": len(user_task_map),
        "emails_sent": success_count,
        "emails_failed": failed_emails,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# EMAIL TEMPLATE SETTINGS  (GET / PUT)
# ═══════════════════════════════════════════════════════════════════════════════


class EmailTemplateUpdateRequest(BaseModel):
    settings: dict


@api_router.get("/email-templates/{template_type}")
async def get_email_template(
    template_type: str,
    current_user: User = Depends(get_current_user),
):
    """
    Returns the saved customisation for an email template.
    Falls back to built-in defaults when nothing has been saved yet.
    template_type: 'task_reminder' | 'compliance_reminder'
    """
    doc = await db.email_templates.find_one({"type": template_type}, {"_id": 0})
    if doc:
        return {"type": template_type, "settings": doc.get("settings", {})}
    # Return defaults so the UI can pre-populate the form
    defaults = {
        "task_reminder": _DEFAULT_TASK_EMAIL_TEMPLATE,
        "compliance_reminder": _DEFAULT_COMPLIANCE_EMAIL_TEMPLATE,
    }
    return {"type": template_type, "settings": defaults.get(template_type, {})}


@api_router.put("/email-templates/{template_type}")
async def update_email_template(
    template_type: str,
    body: EmailTemplateUpdateRequest,
    current_user: User = Depends(require_admin()),
):
    """
    Save (upsert) customisation for an email template. Admin only.
    Accepts a partial settings dict — only the provided keys are updated.
    """
    allowed = ("task_reminder", "compliance_reminder")
    if template_type not in allowed:
        raise HTTPException(400, f"template_type must be one of {allowed}")

    # Merge with existing so partial updates don't wipe other keys
    existing = await db.email_templates.find_one({"type": template_type}, {"_id": 0})
    current_settings = existing.get("settings", {}) if existing else {}
    merged = {**current_settings, **body.settings}

    await db.email_templates.update_one(
        {"type": template_type},
        {
            "$set": {
                "type": template_type,
                "settings": merged,
                "updated_by": current_user.id,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        },
        upsert=True,
    )
    return {"message": "Template updated successfully", "settings": merged}


# ═══════════════════════════════════════════════════════════════════════════════
# COMPLIANCE CLIENT EMAIL
# ═══════════════════════════════════════════════════════════════════════════════

_DEFAULT_COMPLIANCE_EMAIL_TEMPLATE = {
    "subject_prefix": "📋 Compliance Reminder",
    "greeting_line": "We hope this message finds you well. Please find below the compliance items that require your attention. Kindly ensure timely completion to avoid any penalties or legal implications.",
    "footer_note": "This is an automated compliance reminder. For queries, please contact us at the details below.",
    "cta_label": "Contact Us Now",
    "tips": [
        "Ensure all documents are submitted well before the due date.",
        "Keep digital copies of all filed returns and acknowledgments.",
        "Contact us immediately if you need an extension or face any issues.",
    ],
}


def _status_badge_compliance(s: str) -> tuple:
    s = (s or "pending").lower().replace("_", " ")
    if s in ("completed", "filed"):
        return ("#16a34a", "#dcfce7")
    if s in ("in progress",):
        return ("#2563eb", "#dbeafe")
    if s == "overdue":
        return ("#dc2626", "#fee2e2")
    return ("#6b7280", "#f3f4f6")


class ComplianceEmailRequest(BaseModel):
    company_id: str
    client_name: str
    client_email: str
    subject: Optional[str] = None
    compliance_items: List[dict]  # [{name, category, due_date, status, notes}]


@api_router.post("/compliance/send-client-email")
async def send_compliance_client_email(
    req: ComplianceEmailRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Send a branded compliance reminder email to a client.
    Uses the selected company's logo, name, phone, email, and website.
    """
    if current_user.role not in ("admin", "manager"):
        raise HTTPException(403, "Admin or Manager only")

    company = await db.companies.find_one({"id": req.company_id}, {"_id": 0})
    if not company:
        raise HTTPException(404, "Company not found")

    # Check Brevo is configured
    if not os.getenv("BREVO_API_KEY") or not os.getenv("SENDER_EMAIL"):
        raise HTTPException(
            500, "Brevo email not configured (set BREVO_API_KEY and SENDER_EMAIL)"
        )

    tpl_doc = await db.email_templates.find_one(
        {"type": "compliance_reminder"}, {"_id": 0}
    )
    tpl = {
        **_DEFAULT_COMPLIANCE_EMAIL_TEMPLATE,
        **(tpl_doc.get("settings", {}) if tpl_doc else {}),
    }

    comp_name = company.get("name", "Our Firm")
    comp_phone = company.get("phone", "")
    comp_email_c = company.get("email", os.getenv("SENDER_EMAIL", ""))
    comp_website = company.get("website", "")
    comp_address = company.get("address", "")
    comp_gstin = company.get("gstin", "")
    logo_b64 = company.get("logo_base64", "")

    # Strip data-URI prefix if present
    if logo_b64 and "base64," in logo_b64:
        logo_b64 = logo_b64.split("base64,", 1)[1]

    logo_tag = (
        f'<img src="data:image/png;base64,{logo_b64}" alt="{comp_name}" '
        f'style="max-height:54px;max-width:180px;object-fit:contain;margin-bottom:6px">'
        if logo_b64
        else f'<span style="font-size:22px;font-weight:800;color:#ffffff">{comp_name}</span>'
    )

    now = datetime.now(timezone.utc)

    def fmt_d(raw):
        if not raw:
            return "—"
        try:
            return datetime.fromisoformat(str(raw).replace("Z", "+00:00")).strftime(
                "%d %b %Y"
            )
        except Exception:
            return str(raw)[:10]

    total = len(req.compliance_items)
    overdue = sum(
        1
        for c in req.compliance_items
        if c.get("status", "").lower() in ("overdue", "")
    )
    pending = sum(
        1
        for c in req.compliance_items
        if (c.get("status", "") or "pending").lower()
        not in ("completed", "filed", "na")
    )

    rows_html = ""
    for idx, item in enumerate(req.compliance_items, 1):
        st_fg, st_bg = _status_badge_compliance(item.get("status", ""))
        status_label = (item.get("status") or "Pending").replace("_", " ").title()
        row_bg = "#ffffff" if idx % 2 == 1 else "#f8fafc"
        rows_html += f"""
        <tr style="background:{row_bg}">
          <td style="padding:10px 14px;color:#64748b;font-size:13px;text-align:center;border-bottom:1px solid #e2e8f0">{idx}</td>
          <td style="padding:10px 14px;color:#1e293b;font-size:13px;font-weight:600;border-bottom:1px solid #e2e8f0">{item.get("name", "—")}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:#ede9fe;color:#5b21b6;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{item.get("category", "—")}</span>
          </td>
          <td style="padding:10px 14px;color:#475569;font-size:13px;border-bottom:1px solid #e2e8f0">{fmt_d(item.get("due_date"))}</td>
          <td style="padding:10px 14px;border-bottom:1px solid #e2e8f0">
            <span style="background:{st_bg};color:{st_fg};padding:3px 10px;border-radius:20px;font-size:11px;font-weight:700">{status_label}</span>
          </td>
          <td style="padding:10px 14px;color:#64748b;font-size:12px;border-bottom:1px solid #e2e8f0">{item.get("notes") or "—"}</td>
        </tr>"""

    tips_html = "".join(
        f'<li style="margin:6px 0;color:#475569;font-size:14px">✔&nbsp; {tip}</li>'
        for tip in tpl["tips"]
    )

    contact_parts = [p for p in [comp_phone, comp_email_c, comp_website] if p]
    contact_line = " &nbsp;|&nbsp; ".join(contact_parts)
    addr_line = (
        f"<p style='margin:4px 0 0;color:rgba(255,255,255,0.75);font-size:12px'>{comp_address}</p>"
        if comp_address
        else ""
    )
    gstin_line = (
        f"<p style='margin:2px 0 0;color:rgba(255,255,255,0.65);font-size:11px'>GSTIN: {comp_gstin}</p>"
        if comp_gstin
        else ""
    )

    html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:30px 0">
<tr><td align="center">
<table width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">

  <!-- HEADER with company branding -->
  <tr>
    <td style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);padding:30px 40px 24px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td>{logo_tag}</td>
          <td style="text-align:right;vertical-align:top">
            <p style="margin:0;color:rgba(255,255,255,0.7);font-size:11px">{comp_phone}</p>
            <p style="margin:2px 0 0;color:rgba(255,255,255,0.7);font-size:11px">{comp_email_c}</p>
          </td>
        </tr>
      </table>
      <h1 style="margin:16px 0 4px;color:#ffffff;font-size:22px;font-weight:800">📋 Compliance Reminder</h1>
      {addr_line}{gstin_line}
    </td>
  </tr>

  <!-- GREETING -->
  <tr>
    <td style="padding:28px 40px 0">
      <p style="margin:0 0 8px;color:#1e293b;font-size:16px">Dear <strong>{req.client_name}</strong>,</p>
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.7">{tpl["greeting_line"]}</p>
    </td>
  </tr>

  <!-- SUMMARY STATS -->
  <tr>
    <td style="padding:20px 40px">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" style="padding:0 6px 0 0">
            <div style="background:#eff6ff;border-radius:10px;padding:14px;text-align:center">
              <p style="margin:0;font-size:26px;font-weight:800;color:#2563eb">{total}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Total Items</p>
            </div>
          </td>
          <td width="33%" style="padding:0 3px">
            <div style="background:#fef2f2;border-radius:10px;padding:14px;text-align:center">
              <p style="margin:0;font-size:26px;font-weight:800;color:#dc2626">{overdue}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Overdue</p>
            </div>
          </td>
          <td width="33%" style="padding:0 0 0 6px">
            <div style="background:#fffbeb;border-radius:10px;padding:14px;text-align:center">
              <p style="margin:0;font-size:26px;font-weight:800;color:#d97706">{pending}</p>
              <p style="margin:4px 0 0;font-size:12px;color:#64748b;font-weight:600">Pending</p>
            </div>
          </td>
        </tr>
      </table>
    </td>
  </tr>

  <!-- COMPLIANCE TABLE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0 0 14px;color:#1e293b;font-size:15px;font-weight:700">📄 Your Compliance Items</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">
        <thead>
          <tr style="background:#1e3a5f">
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:center">#</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Compliance Name</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Category</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Due Date</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Status</th>
            <th style="padding:11px 14px;color:#fff;font-size:12px;font-weight:700;text-align:left">Notes</th>
          </tr>
        </thead>
        <tbody>{rows_html}
        </tbody>
      </table>
    </td>
  </tr>

  <!-- TIPS -->
  <tr>
    <td style="padding:0 40px 24px">
      <div style="background:#f8fafc;border-left:4px solid #2563eb;border-radius:8px;padding:16px 20px">
        <p style="margin:0 0 10px;color:#1e293b;font-size:14px;font-weight:700">💡 Important Reminders</p>
        <ul style="margin:0;padding-left:16px">{tips_html}</ul>
      </div>
    </td>
  </tr>

  <!-- SIGNATURE -->
  <tr>
    <td style="padding:0 40px 24px">
      <p style="margin:0;color:#475569;font-size:14px;line-height:1.6">For any queries or assistance, please feel free to contact us. We are here to help you stay compliant.</p>
      <p style="margin:14px 0 0;color:#1e293b;font-size:14px">Warm regards,<br><strong>{comp_name}</strong></p>
      {f'<p style="margin:6px 0 0;color:#2563eb;font-size:13px">{contact_line}</p>' if contact_line else ""}
    </td>
  </tr>

  <!-- FOOTER -->
  <tr>
    <td style="background:#f8fafc;padding:14px 40px;border-top:1px solid #e2e8f0;text-align:center">
      <p style="margin:0;color:#94a3b8;font-size:11px">{tpl["footer_note"]}</p>
      <p style="margin:4px 0 0;color:#94a3b8;font-size:11px">© {now.year} {comp_name}. All rights reserved.</p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body>
</html>"""

    plain = (
        f"Dear {req.client_name},\n\n"
        f"{tpl['greeting_line']}\n\n"
        f"You have {total} compliance item(s) requiring attention ({overdue} overdue).\n\n"
        + "\n".join(
            f"- {c.get('name', '?')} | Due: {fmt_d(c.get('due_date'))} | Status: {c.get('status', 'Pending')}"
            for c in req.compliance_items
        )
        + f"\n\nRegards,\n{comp_name}\n{contact_line}"
    )

    subject = req.subject or f"{tpl['subject_prefix']} — {comp_name}"

    try:
        await _brevo_send(req.client_email, subject, body_plain=plain, body_html=html)
    except Exception as e:
        logger.error(f"Compliance email failed: {e}")
        raise HTTPException(500, f"Email send failed: {str(e)}")

    logger.info(f"Compliance email sent to {req.client_email} by {current_user.email}")
    return {"message": f"Compliance email sent to {req.client_email}"}


# ═══════════════════════════════════════════════════════════════════════════════
# CLIENT EMAIL TEMPLATES  —  Full CRUD
# ═══════════════════════════════════════════════════════════════════════════════


class ClientEmailTemplate(BaseModel):
    name: str
    subject: str
    body: str
    is_html: bool = False
    category: str = "general"  # general | follow_up | compliance | greeting | custom
    attachment_name: Optional[str] = ""  # optional file attached to every send
    attachment_base64: Optional[str] = ""  # base64 (no data: prefix) of the attachment


@api_router.get("/email/client-templates")
async def list_client_email_templates(current_user: User = Depends(get_current_user)):
    docs = await db.client_email_templates.find({}, {"_id": 0}).to_list(200)
    return sorted(docs, key=lambda d: d.get("updated_at", ""), reverse=True)


@api_router.post("/email/client-templates")
async def create_client_email_template(
    body: ClientEmailTemplate,
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc).isoformat()
    doc = {
        "id": str(uuid.uuid4()),
        "name": body.name,
        "subject": body.subject,
        "body": body.body,
        "is_html": body.is_html,
        "category": body.category,
        "attachment_name": (body.attachment_name or ""),
        "attachment_base64": (body.attachment_base64 or ""),
        "created_by": current_user.id,
        "created_at": now,
        "updated_at": now,
    }
    try:
        await db.client_email_templates.insert_one(doc)
    except Exception as e:
        logger.error(f"Create client email template failed: {e}")
        raise HTTPException(500, f"Could not save template: {str(e)}")
    # insert_one mutates `doc` to add a BSON _id which is not JSON-serializable —
    # return a clean copy without it to avoid a 500 on the response.
    doc.pop("_id", None)
    return doc


@api_router.put("/email/client-templates/{template_id}")
async def update_client_email_template(
    template_id: str,
    body: ClientEmailTemplate,
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc).isoformat()
    r = await db.client_email_templates.update_one(
        {"id": template_id},
        {
            "$set": {
                "name": body.name,
                "subject": body.subject,
                "body": body.body,
                "is_html": body.is_html,
                "category": body.category,
                "attachment_name": (body.attachment_name or ""),
                "attachment_base64": (body.attachment_base64 or ""),
                "updated_at": now,
                "updated_by": current_user.id,
            }
        },
    )
    if r.matched_count == 0:
        raise HTTPException(404, "Template not found")
    return {"message": "Template updated"}


@api_router.delete("/email/client-templates/{template_id}")
async def delete_client_email_template(
    template_id: str,
    current_user: User = Depends(get_current_user),
):
    r = await db.client_email_templates.delete_one({"id": template_id})
    if r.deleted_count == 0:
        raise HTTPException(404, "Template not found")
    return {"message": "Template deleted"}


# ═══════════════════════════════════════════════════════════════════════════════
# BULK CLIENT EMAIL SEND  —  Brevo API  OR  Company / Gmail SMTP
# ═══════════════════════════════════════════════════════════════════════════════


class BulkEmailRecipient(BaseModel):
    email: str
    name: str = ""
    variables: dict = {}


class BulkClientEmailRequest(BaseModel):
    recipients: List[BulkEmailRecipient]
    subject: str
    body_template: str  # plain-text or HTML with {variable} placeholders
    is_html: bool = False
    company_id: Optional[str] = None  # if set, try company SMTP first
    send_method: str = "auto"  # "auto" | "brevo" | "smtp"
    from_name: Optional[str] = None
    override_sender_email: Optional[str] = (
        None  # per-request sender override (Clients bulk modal)
    )
    override_sender_name: Optional[str] = None
    attachment_name: Optional[str] = ""  # optional single attachment for all recipients
    attachment_base64: Optional[str] = ""  # base64 (no data: prefix)


def _render_body(template: str, variables: dict) -> str:
    """Substitute {key} placeholders; unknown keys are left as-is."""
    result = template
    for k, v in variables.items():
        result = result.replace("{" + k + "}", str(v or ""))
    return result


async def _send_one_smtp(
    smtp_host,
    smtp_port,
    smtp_user,
    smtp_pass,
    from_name,
    to_email,
    subject,
    body_plain,
    body_html=None,
    attachments=None,
):
    """Synchronous SMTP send wrapped for asyncio.
    `attachments` is an optional list of {"name": str, "content": base64str}.
    """
    import smtplib, ssl, base64 as _b64, mimetypes
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.base import MIMEBase
    from email import encoders

    body_part = None
    if body_html:
        body_part = MIMEMultipart("alternative")
        body_part.attach(MIMEText(body_plain, "plain", "utf-8"))
        body_part.attach(MIMEText(body_html, "html", "utf-8"))
    else:
        body_part = MIMEText(body_plain, "plain", "utf-8")

    clean_atts = [a for a in (attachments or []) if a and a.get("content")]
    if clean_atts:
        msg = MIMEMultipart("mixed")
        msg.attach(body_part)
        for a in clean_atts:
            fname = a.get("name") or "attachment"
            try:
                raw = _b64.b64decode(a["content"])
            except Exception:
                continue
            ctype, _ = mimetypes.guess_type(fname)
            maintype, subtype = (
                ctype.split("/", 1) if ctype else ("application", "octet-stream")
            )
            part = MIMEBase(maintype, subtype)
            part.set_payload(raw)
            encoders.encode_base64(part)
            part.add_header("Content-Disposition", "attachment", filename=fname)
            msg.attach(part)
    else:
        msg = body_part

    msg["Subject"] = subject
    msg["From"] = f"{from_name} <{smtp_user}>" if from_name else smtp_user
    msg["To"] = to_email

    ctx = ssl.create_default_context()
    with smtplib.SMTP(smtp_host, int(smtp_port), timeout=20) as server:
        server.ehlo()
        server.starttls(context=ctx)
        server.login(smtp_user, smtp_pass)
        server.sendmail(smtp_user, [to_email], msg.as_string())


@api_router.post("/email/send-bulk-clients")
async def send_bulk_client_emails(
    req: BulkClientEmailRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Send personalised emails to multiple clients.
    Routing priority:
      auto / smtp  → company SMTP (if company_id provided and SMTP configured) →
                     falls back to Brevo if SMTP missing
      brevo        → always Brevo
    """
    if not req.recipients:
        raise HTTPException(400, "No recipients provided")

    # ── Resolve company SMTP settings if requested ─────────────────────────
    company_smtp = None
    company_name = req.from_name or os.getenv("SENDER_NAME", "TaskoSphere")

    # Per-request sender override from Clients bulk modal (takes highest priority for Brevo)
    _override_email = (req.override_sender_email or "").strip()
    _override_name = (req.override_sender_name or "").strip()

    if req.company_id and req.send_method in ("auto", "smtp"):
        comp = await db.companies.find_one({"id": req.company_id}, {"_id": 0})
        if comp:
            sh = (comp.get("smtp_host") or "").strip()
            su = (comp.get("smtp_user") or "").strip()
            sp = (comp.get("smtp_password") or "").strip()
            if sh and su and sp:
                company_smtp = {
                    "host": sh,
                    "port": int(comp.get("smtp_port", 587)),
                    "user": su,
                    "password": sp,
                    "from_name": comp.get("smtp_from_name")
                    or comp.get("name")
                    or company_name,
                }
                company_name = company_smtp["from_name"]

    use_brevo = (req.send_method == "brevo") or (company_smtp is None)

    if use_brevo:
        brevo_key = os.getenv("BREVO_API_KEY")
        # Use per-request override if provided, else fall back to DB active sender, then env
        if _override_email:
            sender_email = _override_email
            company_name = _override_name or company_name
        else:
            try:
                _s_doc = await db.email_sender_settings.find_one(
                    {"type": "active_sender"}, {"_id": 0}
                )
                sender_email = (_s_doc.get("email") or "").strip() if _s_doc else ""
                if _s_doc and _s_doc.get("name"):
                    company_name = _s_doc["name"].strip()
            except Exception:
                sender_email = ""
            if not sender_email:
                sender_email = os.getenv("SENDER_EMAIL")
        if not brevo_key or not sender_email:
            raise HTTPException(
                500,
                "Brevo not configured (BREVO_API_KEY + SENDER_EMAIL required). "
                "Or select a company with SMTP settings.",
            )

    # ── Optional attachment (sent with every recipient) ─────────────────────
    _attachments = None
    if (req.attachment_base64 or "").strip():
        _attachments = [
            {
                "name": (req.attachment_name or "attachment"),
                "content": req.attachment_base64.strip(),
            }
        ]

    # ── Send loop ──────────────────────────────────────────────────────────
    sent_count = 0
    fail_count = 0
    failed_list = []
    import asyncio

    for rec in req.recipients:
        if not rec.email or "@" not in rec.email:
            fail_count += 1
            continue
        vars_ = {"name": rec.name, "email": rec.email, **rec.variables}
        subject_rendered = _render_body(req.subject, vars_)
        body_rendered = _render_body(req.body_template, vars_)
        body_html_r = body_rendered if req.is_html else None
        body_plain_r = (
            body_rendered
            if not req.is_html
            else body_rendered.replace("<br>", "\\n")
            .replace("<br/>", "\\n")
            .replace("<p>", "\\n")
            .replace("</p>", "")
        )

        try:
            if use_brevo:
                await _brevo_send(
                    rec.email,
                    subject_rendered,
                    body_plain_r,
                    body_html_r,
                    attachments=_attachments,
                )
            else:
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    None,
                    lambda: _send_one_smtp(
                        company_smtp["host"],
                        company_smtp["port"],
                        company_smtp["user"],
                        company_smtp["password"],
                        company_smtp["from_name"],
                        rec.email,
                        subject_rendered,
                        body_plain_r,
                        body_html_r,
                        attachments=_attachments,
                    ),
                )
            sent_count += 1
        except Exception as e:
            fail_count += 1
            failed_list.append({"email": rec.email, "error": str(e)})
            logger.error(f"Bulk email to {rec.email} failed: {e}")

        await asyncio.sleep(0.05)  # gentle throttle

    logger.info(
        f"Bulk client email by {current_user.email}: {sent_count} sent, {fail_count} failed"
    )
    return {
        "message": f"Sent {sent_count} email(s). {fail_count} failed.",
        "sent": sent_count,
        "failed": fail_count,
        "failed_list": failed_list[:20],
    }


# AUDIT LOGS ROUTE
@api_router.get("/audit-logs")
async def get_audit_logs(
    module: Optional[str] = None,
    record_id: Optional[str] = None,
    action: Optional[str] = None,
    current_user: User = Depends(check_permission("can_view_audit_logs")),
):
    """
    Task Audit Log — role-scoped data access:
    - Admin: all logs
    - Manager (Own + Team): logs where user_id is own or same-department staff
    - Staff (own only): logs where user_id is own
    """
    query = {}
    if module:
        query["module"] = module
    if record_id:
        query["record_id"] = record_id
    if action and action != "ALL":
        query["action"] = action

    # Scope audit logs by role
    if current_user.role != "admin":
        if current_user.role == "manager":
            # Manager: own logs + same-department team logs
            team_ids = await get_team_user_ids(current_user.id)
            visible_ids = list(set([current_user.id] + team_ids))
        else:
            # Staff: own logs only
            visible_ids = [current_user.id]
        query["user_id"] = {"$in": visible_ids}

    logs = (
        await db.audit_logs.find(query, {"_id": 0}).sort("timestamp", -1).to_list(2000)
    )
    logs = convert_objectids(logs)
    for log in logs:
        if isinstance(log.get("timestamp"), str):
            try:
                log["timestamp"] = datetime.fromisoformat(log["timestamp"])
            except Exception:
                pass
    return logs


# INTERNAL FUNCTION FOR AUTO REMINDER
async def send_pending_task_reminders_internal():
    tasks = await db.tasks.find({"status": {"$ne": "completed"}}, {"_id": 0}).to_list(
        1000
    )
    if not tasks:
        return
    # Batch user lookup - single query for all assigned users
    assigned_ids = list({t["assigned_to"] for t in tasks if t.get("assigned_to")})
    users_list = await db.users.find({"id": {"$in": assigned_ids}}, {"_id": 0}).to_list(
        1000
    )
    user_by_id = {u["id"]: u for u in users_list}

    user_task_map = {}
    for task in tasks:
        assigned_to = task.get("assigned_to")
        if not assigned_to:
            continue
        user = user_by_id.get(assigned_to)
        if not user or not user.get("email"):
            continue
        email = user["email"]
        user_task_map.setdefault(email, {"user": user, "tasks": []})["tasks"].append(
            task
        )

    all_users = await db.users.find({}, {"_id": 0, "id": 1, "full_name": 1}).to_list(
        500
    )
    user_map = {u["id"]: u.get("full_name", "Admin") for u in all_users}
    tpl_doc = await db.email_templates.find_one({"type": "task_reminder"}, {"_id": 0})
    tpl = tpl_doc.get("settings") if tpl_doc else None

    for email, data in user_task_map.items():
        try:
            user_name = data["user"].get("full_name", "")
            subject, html_body = build_reminder_email(
                user_name, data["tasks"], user_map=user_map, tpl=tpl
            )
            await _brevo_send(
                email,
                subject,
                body_plain=f"Hello {user_name},\n\nYou have {len(data['tasks'])} pending tasks. Please log in to Task-O-Sphere to review them.",
                body_html=html_body,
            )
        except Exception as e:
            logger.error(f"Auto reminder failed for {email}: {str(e)}")


# ─────────────────────────────────────────────────────────────────────────────
# AUTO DAILY REMINDER MIDDLEWARE
# ─────────────────────────────────────────────────────────────────────────────
async def _run_daily_reminder_job(today_str: str):
    """
    Runs once per calendar day (India time) to email every user who has
    pending tasks their reminder digest.

    Invoked by the `auto_daily_reminder` HTTP middleware (see
    application_runtime.py) as a fire-and-forget background task. That
    middleware's `_last_reminder_date_cache` is only an in-process
    pre-check -- it cuts down on duplicate calls but can't coordinate
    across multiple worker processes. The real guarantee against sending
    the digest twice on the same day comes from the atomic
    find_one_and_update below: only the first caller to update the
    sentinel document for `today_str` sees a `previous_state` whose
    `last_run_date` differs from today, so only that caller goes on to
    actually send emails.
    """
    try:
        from pymongo import ReturnDocument

        previous_state = await db.system_settings.find_one_and_update(
            {"_id": "daily_task_reminder_job"},
            {
                "$set": {
                    "last_run_date": today_str,
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
            upsert=True,
            return_document=ReturnDocument.BEFORE,
        )

        already_ran_today = (
            bool(previous_state) and previous_state.get("last_run_date") == today_str
        )
        if already_ran_today:
            # Another request/worker already claimed and ran today's job.
            return

        logger.info(f"Running daily task reminder job for {today_str}")
        await send_pending_task_reminders_internal()
        logger.info(f"Daily task reminder job for {today_str} completed")
    except Exception as e:
        logger.error(f"Daily reminder job failed for {today_str}: {str(e)}")
