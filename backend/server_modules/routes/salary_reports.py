"""Phase 2 extracted subsystem: salary_reports.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/salary_reports.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.models import User
from datetime import date
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from fastapi import Depends
from fastapi import HTTPException
from typing import Optional
import calendar
from backend.server import IST, api_router  # created in backend/server.py before route modules load

def _hhmm_to_minutes(value: Optional[str], default: str) -> int:
    try:
        t = datetime.strptime(value or default, "%H:%M")
        return t.hour * 60 + t.minute
    except Exception:
        d = datetime.strptime(default, "%H:%M")
        return d.hour * 60 + d.minute


async def _compute_salary_report_for_user(
    user: dict, year: int, mon: int, holiday_data: dict
) -> dict:
    """Builds the salary-due breakdown for a single user for a given month.

    Priority rule (per date, only one status may affect salary):
      Holiday (full) → Leave → Half-Day → Present/Absent → Early Leave

    holiday_data: dict of {date_str: holiday_doc} for ALL confirmed holidays,
    including type='half_day' entries.  Full holidays (type != 'half_day')
    give 0.0 deduction; half-day holidays give 0.5 deduction.

    When a date is marked as Half-Day (via attendance record OR holiday type),
    Early Leave is completely ignored for that date — no early-leave deduction
    is applied.
    """
    from backend.server_modules.routes.application_runtime import EARLY_OUT_CUTOFF_MINUTES  # defined in a module loaded later
    first_day = date(year, mon, 1)
    last_day_num = calendar.monthrange(year, mon)[1]
    last_day = date(year, mon, last_day_num)

    now_ist = datetime.now(IST)
    today_ist = now_ist.date()
    if (year, mon) == (today_ist.year, today_ist.month):
        effective_last_day = min(last_day, today_ist)
    elif date(year, mon, 1) > today_ist:
        effective_last_day = first_day - timedelta(days=1)  # future month → empty
    else:
        effective_last_day = last_day

    start_str = first_day.isoformat()
    end_str = last_day.isoformat()

    # Per-day rate = monthly_salary / TOTAL CALENDAR DAYS in the month
    # (includes Sundays — they're accounted for separately as holidays below,
    #  not excluded from the denominator).
    total_working_days = max(last_day_num, 1)

    monthly_salary = float(user.get("monthly_salary") or 0)
    per_day_salary = monthly_salary / total_working_days

    late_deadline_min = _hhmm_to_minutes(
        user.get("punch_in_time"), "10:30"
    ) + (_hhmm_to_minutes(user.get("grace_time"), "00:10"))

    # Derive separate date sets from holiday_data for clarity:
    #   full_holiday_dates  — paid day off, 0.0 deduction (type != 'half_day')
    #   half_day_holiday_dates — company half-day, 0.5 deduction (type == 'half_day')
    full_holiday_dates = {
        d for d, h in holiday_data.items() if h.get("type") != "half_day"
    }
    half_day_holiday_dates = {
        d for d, h in holiday_data.items() if h.get("type") == "half_day"
    }
    # All holiday dates (used for Sunday continuation-leave check)
    all_holiday_dates = set(holiday_data.keys())

    # Fetch with a 1-day buffer on each side so a Sunday that falls on the
    # 1st or last day of the month can still look at the adjacent Sat/Mon
    # attendance record when deciding whether it's a "continuing holiday".
    fetch_start = (first_day - timedelta(days=1)).isoformat()
    fetch_end = (last_day + timedelta(days=1)).isoformat()
    att_records = await db.attendance.find(
        {"user_id": user["id"], "date": {"$gte": fetch_start, "$lte": fetch_end}},
        {"_id": 0},
    ).to_list(500)
    att_by_date = {r["date"]: r for r in att_records}

    def _is_absent_on(iso_date: str) -> bool:
        """True if the given date counts as a full absence (no half-day).
        A date that is any kind of holiday (full or half_day) is never absent."""
        if iso_date in all_holiday_dates:
            return False
        rec = att_by_date.get(iso_date)
        if not rec:
            return True
        status = rec.get("status") or "absent"
        is_half_day = bool(rec.get("is_half_day") or status == "half_day")
        if is_half_day:
            return False
        return status in ("absent", "leave")

    days = []
    working_days_elapsed = 0
    present_days = 0
    absent_days = 0
    half_days = 0
    late_days = 0
    early_out_days = 0
    holiday_days = 0
    total_deduction_days = 0.0

    d = first_day
    while d <= effective_last_day:
        iso = d.isoformat()

        # ── Priority 1: Full confirmed company holiday → paid day off (0.0) ──
        if iso in full_holiday_dates:
            days.append({
                "date": iso, "status": "holiday", "deduction": 0.0,
                "is_late": False, "early_out": False,
            })
            holiday_days += 1
            d += timedelta(days=1)
            continue

        # ── Sunday → weekly holiday by default. Only deducted as an absent
        # day when it's a "continuing holiday" — the employee was also
        # absent on the Saturday before AND the Monday after.
        if d.weekday() == 6:
            monday = d + timedelta(days=1)
            saturday_iso = (d - timedelta(days=1)).isoformat()
            monday_iso = monday.isoformat()
            monday_has_elapsed = monday <= effective_last_day
            continuing_leave = (
                monday_has_elapsed
                and _is_absent_on(saturday_iso)
                and _is_absent_on(monday_iso)
            )
            if continuing_leave:
                days.append({
                    "date": iso, "status": "absent", "deduction": 1.0,
                    "is_late": False, "early_out": False,
                })
                absent_days += 1
                total_deduction_days += 1.0
            else:
                days.append({
                    "date": iso, "status": "holiday", "deduction": 0.0,
                    "is_late": False, "early_out": False,
                })
                holiday_days += 1
            d += timedelta(days=1)
            continue

        # ── Monday–Saturday → normal working day ──
        working_days_elapsed += 1
        rec = att_by_date.get(iso)
        status = (rec or {}).get("status") or "absent"

        # ── Priority 2: Company-declared half-day (in holidays collection) ──
        # Treat as half-day; Early Leave is completely ignored.
        if iso in half_day_holiday_dates:
            days.append({
                "date": iso, "status": "half_day", "deduction": 0.5,
                "is_late": False, "early_out": False,
                "half_day_source": "holiday",
            })
            half_days += 1
            total_deduction_days += 0.5
            d += timedelta(days=1)
            continue

        # Check if attendance record marks this as a half-day
        is_half_day = bool(rec and (rec.get("is_half_day") or status == "half_day"))

        day_info = {
            "date": iso, "status": "absent", "deduction": 1.0,
            "is_late": False, "early_out": False,
        }

        # ── Priority 3: Absent / Leave (full day) ──
        if not rec or (status in ("absent",) and not is_half_day) or (
            status == "leave" and not is_half_day
        ):
            day_info["status"] = "absent"
            day_info["deduction"] = 1.0
            absent_days += 1

        # ── Priority 4: Half-Day (attendance record) ──
        # Early Leave is completely ignored when half-day is in effect.
        elif is_half_day:
            day_info["status"] = "half_day"
            day_info["deduction"] = 0.5
            half_days += 1

        # ── Priority 5: Present — check Late and Early Leave ──
        else:
            is_late = bool(rec.get("is_late"))

            # Early Leave is only evaluated when there is NO half-day on this date.
            # If the attendance record carries leave_type='early_leave' but the
            # date is already a half-day, Early Leave is suppressed entirely.
            is_early_leave_record = rec.get("leave_type") == "early_leave" or bool(
                rec.get("is_early_leave")
            )
            # is_half_day already False here; double-guard at record level.
            suppress_early_leave = is_half_day  # always False in this branch — kept for clarity

            early_out = False
            punch_out = rec.get("punch_out")
            if punch_out and not suppress_early_leave:
                try:
                    pout_dt = (
                        punch_out if isinstance(punch_out, datetime)
                        else datetime.fromisoformat(str(punch_out))
                    )
                    if pout_dt.tzinfo is None:
                        pout_dt = pout_dt.replace(tzinfo=timezone.utc)
                    pout_ist = pout_dt.astimezone(IST)
                    early_out = (pout_ist.hour * 60 + pout_ist.minute) < EARLY_OUT_CUTOFF_MINUTES
                except Exception:
                    early_out = False

            deduction = 0.0
            if is_late:
                deduction += 0.5
                late_days += 1
            if early_out:
                deduction += 0.5
                early_out_days += 1
            deduction = min(deduction, 1.0)

            day_info["is_late"] = is_late
            day_info["early_out"] = early_out
            day_info["deduction"] = deduction
            if deduction == 0:
                day_info["status"] = "present"
                present_days += 1
            else:
                day_info["status"] = "late" if is_late and not early_out else (
                    "early_out" if early_out and not is_late else "late_and_early_out"
                )

        total_deduction_days += day_info["deduction"]
        days.append(day_info)
        d += timedelta(days=1)

    deduction_amount = round(per_day_salary * total_deduction_days, 2)
    payable_salary = round(monthly_salary - deduction_amount, 2)

    return {
        "user_id": user["id"],
        "full_name": user.get("full_name"),
        "email": user.get("email"),
        "profile_picture": user.get("profile_picture"),
        "departments": user.get("departments") or [],
        "month": f"{year:04d}-{mon:02d}",
        "monthly_salary": round(monthly_salary, 2),
        "total_working_days": total_working_days,
        "working_days_elapsed": working_days_elapsed,
        "per_day_salary": round(per_day_salary, 2),
        "present_days": present_days,
        "absent_days": absent_days,
        "half_days": half_days,
        "late_days": late_days,
        "early_out_days": early_out_days,
        "holiday_days": holiday_days,
        "total_deduction_days": round(total_deduction_days, 2),
        "deduction_amount": deduction_amount,
        "payable_salary": payable_salary,
        "late_after": f"{late_deadline_min // 60:02d}:{late_deadline_min % 60:02d}",
        "early_out_before": "18:00",
        "days": days,
    }


async def _get_confirmed_holiday_dates(start_str: str, end_str: str) -> set:
    """Returns set of FULL confirmed holiday dates (excludes half_day type)."""
    holiday_docs = await db.holidays.find(
        {
            "date": {"$gte": start_str, "$lte": end_str},
            "status": "confirmed",
            "type": {"$ne": "half_day"},
        },
        {"_id": 0, "date": 1},
    ).to_list(500)
    return {h["date"] for h in holiday_docs}


async def _get_confirmed_holiday_data(start_str: str, end_str: str) -> dict:
    """Returns dict of {date: holiday_doc} for all confirmed holidays (including half_day type).
    Full holidays (type != 'half_day') → 0.0 deduction (paid day off).
    Half-day holidays (type == 'half_day') → 0.5 deduction."""
    holiday_docs = await db.holidays.find(
        {"date": {"$gte": start_str, "$lte": end_str}, "status": "confirmed"},
        {"_id": 0, "date": 1, "name": 1, "type": 1},
    ).to_list(500)
    return {h["date"]: h for h in holiday_docs}


async def _upsert_half_day_holiday(date_str: str) -> None:
    """Upsert a 'half_day' type entry into the holidays collection for display
    on the Holiday Card and Attendance Calendar.  Only writes if no full
    (non-half_day) confirmed holiday already exists for that date."""
    existing = await db.holidays.find_one({"date": date_str}, {"_id": 0, "type": 1, "status": 1})
    if existing:
        if existing.get("status") == "confirmed" and existing.get("type") != "half_day":
            # A real full holiday already owns this date — leave it untouched.
            return
        # Update existing pending/half_day entry → confirm as half_day
        await db.holidays.update_one(
            {"date": date_str},
            {
                "$set": {
                    "name": "Half Day",
                    "status": "confirmed",
                    "type": "half_day",
                    "updated_at": datetime.now(timezone.utc).isoformat(),
                }
            },
        )
    else:
        try:
            await db.holidays.insert_one(
                {
                    "date": date_str,
                    "name": "Half Day",
                    "status": "confirmed",
                    "type": "half_day",
                    "created_at": datetime.now(timezone.utc).isoformat(),
                }
            )
        except Exception:
            # Race condition — another request inserted it; ignore.
            pass


async def _remove_half_day_holiday(date_str: str) -> None:
    """Remove a 'half_day' holiday entry when the half-day attendance is
    overridden or removed.  Never removes real full holidays."""
    await db.holidays.delete_one({"date": date_str, "type": "half_day"})


def _parse_month_param(month: Optional[str]) -> tuple:
    if month:
        try:
            year_s, mon_s = month.split("-")
            year, mon = int(year_s), int(mon_s)
            if not (1 <= mon <= 12):
                raise ValueError
            return year, mon
        except Exception:
            raise HTTPException(
                status_code=400, detail="month must be in YYYY-MM format"
            )
    now_ist = datetime.now(IST)
    return now_ist.year, now_ist.month


@api_router.get("/users/salary-report-all")
async def get_salary_report_all(
    month: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Admin-only: salary-due summary for every user with a monthly_salary set."""
    if current_user.role.lower() != "admin":
        raise HTTPException(status_code=403, detail="Admin access required")

    year, mon = _parse_month_param(month)
    first_day = date(year, mon, 1)
    last_day = date(year, mon, calendar.monthrange(year, mon)[1])
    # Use full holiday_data (includes type info) so _compute_salary_report_for_user
    # can distinguish full holidays from half-day holidays.
    holiday_data = await _get_confirmed_holiday_data(
        first_day.isoformat(), last_day.isoformat()
    )

    users = await db.users.find(
        {"is_active": True},
        {
            "_id": 0, "id": 1, "full_name": 1, "email": 1, "profile_picture": 1,
            "departments": 1, "monthly_salary": 1, "punch_in_time": 1,
            "grace_time": 1, "role": 1,
        },
    ).to_list(1000)

    reports = []
    for u in users:
        if u.get("monthly_salary") in (None, 0):
            continue
        report = await _compute_salary_report_for_user(u, year, mon, holiday_data)
        report.pop("days", None)  # keep the summary list lightweight
        reports.append(report)

    reports.sort(key=lambda r: (r.get("full_name") or "").lower())
    return {"month": f"{year:04d}-{mon:02d}", "reports": reports}


@api_router.get("/users/{user_id}/salary-report")
async def get_salary_report_for_user(
    user_id: str,
    month: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Detailed day-by-day salary-due breakdown for one user (admin, or self)."""
    if current_user.role.lower() != "admin" and current_user.id != user_id:
        raise HTTPException(status_code=403, detail="Not allowed")

    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    year, mon = _parse_month_param(month)
    first_day = date(year, mon, 1)
    last_day = date(year, mon, calendar.monthrange(year, mon)[1])
    # Use full holiday_data (includes type info) so priority logic is applied correctly.
    holiday_data = await _get_confirmed_holiday_data(
        first_day.isoformat(), last_day.isoformat()
    )
    return await _compute_salary_report_for_user(user, year, mon, holiday_data)


async def get_top_performers_data(period: str = "monthly", limit: int = 5, db=None):
    now = datetime.now(IST)
    if period == "weekly":
        start_date = now - timedelta(days=7)
    elif period == "monthly":
        start_date = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    else:
        start_date = datetime(2024, 1, 1, tzinfo=timezone.utc)
    pipeline = [
        {
            "$match": {
                "status": "completed",
                "assigned_to": {"$ne": None},
                "$or": [
                    {"completed_at": {"$gte": start_date.isoformat()}},
                    {"updated_at": {"$gte": start_date.isoformat()}},
                ],
            }
        },
        {"$group": {"_id": "$assigned_to", "completed_tasks": {"$sum": 1}}},
        {
            "$lookup": {
                "from": "users",
                "localField": "_id",
                "foreignField": "id",
                "as": "user_info",
            }
        },
        {"$unwind": "$user_info"},
        {
            "$project": {
                "user_id": "$_id",
                "user_name": "$user_info.full_name",
                "profile_picture": "$user_info.profile_picture",
                "completed_tasks": 1,
            }
        },
        {"$sort": {"completed_tasks": -1}},
        {"$limit": limit},
    ]
    performers = await db.tasks.aggregate(pipeline).to_list(limit)
    for idx, p in enumerate(performers):
        p["rank"] = idx + 1
    return performers


# Task routes
