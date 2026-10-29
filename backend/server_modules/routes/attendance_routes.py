"""Phase 2 extracted subsystem: attendance_routes.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/attendance_routes.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.dependencies import get_team_user_ids
from backend.dependencies import get_user_permissions
from backend.dependencies import require_admin
from backend.models import Attendance
from backend.models import User
from backend.notifications import notify_admins_leave
from backend.server_modules.attendance_jobs import _mark_absent_for_date
from backend.server_modules.helpers import _expected_hours_pure
from backend.server_modules.helpers import create_audit_log
from backend.server_modules.helpers import safe_dt
from datetime import datetime
from datetime import timedelta
from datetime import timezone
from fastapi import Depends
from fastapi import File
from fastapi import Form
from fastapi import HTTPException
from fastapi import Request
from fastapi import UploadFile
from fastapi.responses import StreamingResponse
from fpdf import FPDF
from io import BytesIO
from typing import List
from typing import Optional
from zoneinfo import ZoneInfo
import calendar
import re
import uuid

from backend import file_store as _file_store
from backend.server import IST, PROOF_UPLOAD_DIR, api_router, logger  # created in backend/server.py before route modules load

def get_real_client_ip(request: Request):
    x_forwarded_for = request.headers.get("x-forwarded-for")
    if x_forwarded_for:
        return x_forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def check_is_late(user: dict, punch_in_ist: datetime) -> bool:
    try:
        pit = datetime.strptime(user.get("punch_in_time", "10:30"), "%H:%M")
        if user.get("late_grace_minutes") is not None:
            grace_minutes = int(user["late_grace_minutes"])
        else:
            raw = str(user.get("grace_time", "00:10"))
            gt = datetime.strptime(raw, "%H:%M")
            grace_minutes = gt.hour * 60 + gt.minute
        deadline = punch_in_ist.replace(
            hour=pit.hour, minute=pit.minute, second=0, microsecond=0
        ) + timedelta(minutes=grace_minutes)
        return punch_in_ist > deadline
    except Exception:
        return False


def check_punched_out_early(user: dict, punch_out_ist: datetime) -> bool:
    try:
        pot = datetime.strptime(user.get("punch_out_time", "19:00"), "%H:%M")
        expected_out = punch_out_ist.replace(
            hour=pot.hour, minute=pot.minute, second=0, microsecond=0
        )
        return punch_out_ist < expected_out
    except Exception:
        return False


@api_router.post("/attendance")
async def handle_attendance(data: dict, current_user: User = Depends(get_current_user)):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    today_str = today.isoformat()
    # Note: We do NOT block punch-in on holidays.
    # Users who choose to work on holidays can still punch in/out freely.
    # The frontend suppresses the auto-popup on holidays but keeps the button visible.
    action = data.get("action")
    if action not in ["punch_in", "punch_out"]:
        raise HTTPException(status_code=400, detail="Invalid action")
    attendance = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0}
    )
    if action == "punch_in":
        if attendance and attendance.get("punch_in"):
            raise HTTPException(status_code=400, detail="Already punched in")
        user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0})
        punch_in_utc = datetime.now(timezone.utc)
        punch_in_ist = punch_in_utc.astimezone(ZoneInfo("Asia/Kolkata"))
        is_late = check_is_late(user_doc or {}, punch_in_ist)
        location_data = data.get("location")
        update_fields = {
            "status": "present",
            "punch_in": punch_in_utc,
            "is_late": is_late,
            "leave_reason": None,
            # Clear auto_absent flag if user punches in manually
            "auto_marked": False,
        }
        location_verified = True
        if location_data:
            update_fields["location"] = location_data
            # Soft-fail geofence: allow punch but flag if outside office radius
            lat = location_data.get("latitude")
            lng = location_data.get("longitude")
            if lat is not None and lng is not None:
                import math

                OFFICE_LAT = 21.18796
                OFFICE_LNG = 72.81375
                GEOFENCE_RADIUS_M = 200
                R = 6371000  # Earth radius in metres
                phi1 = math.radians(OFFICE_LAT)
                phi2 = math.radians(lat)
                dphi = math.radians(lat - OFFICE_LAT)
                dlambda = math.radians(lng - OFFICE_LNG)
                a = (
                    math.sin(dphi / 2) ** 2
                    + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
                )
                distance_m = R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                if distance_m > GEOFENCE_RADIUS_M:
                    location_verified = False
                    logger.info(
                        f"Geofence: user {current_user.id} punched in from {distance_m:.0f}m away — flagged as remote."
                    )
        update_fields["location_verified"] = location_verified
        await db.attendance.update_one(
            {"user_id": current_user.id, "date": today_str},
            {"$set": update_fields},
            upsert=True,
        )
        return {
            "message": "Punched in successfully",
            "is_late": is_late,
            "location_verified": location_verified,
        }

    # PUNCH_OUT_BLOCK
    if action == "punch_out":
        if not attendance or not attendance.get("punch_in"):
            raise HTTPException(status_code=400, detail="Not punched in yet")

        if attendance.get("punch_out"):
            raise HTTPException(
                status_code=409,
                detail="Punch Out already recorded. A second Punch Out is not allowed unless an administrator edits/resets the previous Punch Out."
            )

        punch_in_dt = attendance.get("punch_in")
        punch_out_utc = datetime.now(timezone.utc)
        punch_out_ist = punch_out_utc.astimezone(ZoneInfo("Asia/Kolkata"))

        user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0})
        punched_out_early = check_punched_out_early(user_doc or {}, punch_out_ist)

        # FIX: MongoDB may return punch_in as a naive datetime (no tzinfo).
        # Treat naive datetimes as UTC before computing the delta.
        if isinstance(punch_in_dt, datetime):
            if punch_in_dt.tzinfo is None:
                punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
        else:
            # Fallback: parse from string if stored as ISO string
            try:
                punch_in_dt = datetime.fromisoformat(str(punch_in_dt))
                if punch_in_dt.tzinfo is None:
                    punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
            except Exception:
                punch_in_dt = punch_out_utc  # safeguard: 0-minute duration

        delta = punch_out_utc - punch_in_dt.astimezone(timezone.utc)
        duration_minutes = int(delta.total_seconds() / 60)

        update_fields = {
            "punch_out": punch_out_utc,
            "punched_out_early": punched_out_early,
            "duration_minutes": max(0, duration_minutes),
        }

        if data.get("location"):
            update_fields["punch_out_location"] = data.get("location")

        # ── Overtime: minutes worked past the user's own shift-end time ──────
        _pot_str = (user_doc or {}).get("punch_out_time") or "19:00"
        try:
            _pot = datetime.strptime(_pot_str, "%H:%M")
        except ValueError:
            _pot = datetime.strptime("19:00", "%H:%M")
        shift_end_ist = punch_out_ist.replace(
            hour=_pot.hour, minute=_pot.minute, second=0, microsecond=0
        )
        if punch_out_ist > shift_end_ist:
            update_fields["overtime_minutes"] = max(
                0, int((punch_out_ist - shift_end_ist).total_seconds() / 60)
            )
        else:
            update_fields["overtime_minutes"] = 0
        # ─────────────────────────────────────────────────────────────────────

        await db.attendance.update_one(
            {"user_id": current_user.id, "date": today_str}, {"$set": update_fields}
        )

        return {
            "message": "Punched out successfully",
            "duration": duration_minutes,
            "punched_out_early": punched_out_early,
        }


@api_router.post("/attendance/mark-leave-today")
async def mark_leave_today(current_user: User = Depends(get_current_user)):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    today_str = today.isoformat()
    await db.attendance.update_one(
        {"user_id": current_user.id, "date": today_str},
        {
            "$set": {
                "status": "leave",
                "punch_in": None,
                "punch_out": None,
                "leave_reason": "Marked on leave today",
            }
        },
        upsert=True,
    )
    # Notify admins that this user marked themselves on leave today.
    try:
        await notify_admins_leave(
            applicant_name=(current_user.full_name or current_user.email),
            detail=f"full day · {today_str} · Marked on leave today",
            exclude_user_id=current_user.id,
        )
    except Exception:
        pass
    return {"message": "Marked on leave today"}


@api_router.get("/attendance/today")
async def get_today_attendance(current_user: User = Depends(get_current_user)):
    today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
    today_str = today.isoformat()
    # FIX: Added {"_id": 0} projection — without it ObjectId leaks into JSON response
    # and causes ValueError: 'ObjectId' object is not iterable (500 error)
    holiday = await db.holidays.find_one({"date": today_str}, {"_id": 0})
    attendance = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0}
    )
    # BUGFIX: previously, whenever today had a holiday record we returned an
    # early "punch_in: None" response and never even looked at the user's
    # actual attendance doc. That meant punching in on a holiday/half-day
    # (which is explicitly allowed — see /attendance below) still showed
    # "please punch in" on the Dashboard and Attendance page afterwards,
    # while the punch-in button itself correctly rejected a second punch-in
    # with "Already punched in". A real attendance record must always win.
    if attendance:
        if "status" not in attendance:
            attendance["status"] = "present" if attendance.get("punch_in") else "absent"
        if holiday:
            attendance["holiday"] = holiday
        return attendance
    if holiday:
        return {
            "status": "holiday",
            "holiday": holiday,
            "punch_in": None,
            "punch_out": None,
            "leave_reason": None,
        }
    return {
        "status": "absent",
        "punch_in": None,
        "punch_out": None,
        "leave_reason": None,
    }


@api_router.post("/attendance/apply-leave")
async def apply_leave(data: dict, current_user: User = Depends(get_current_user)):
    try:
        # Target user is NEVER trusted from the client without a role check.
        # Admin may act on one selected employee; everyone else can only act
        # on their own attendance record.
        requested_target_user_id = data.get("target_user_id") or data.get("user_id")
        if current_user.role == "admin":
            target_user_id = requested_target_user_id or current_user.id
        else:
            if requested_target_user_id and requested_target_user_id != current_user.id:
                raise HTTPException(
                    status_code=403,
                    detail="Only Admin can apply leave for another employee",
                )
            target_user_id = current_user.id

        target_user = await db.users.find_one(
            {"id": target_user_id},
            {"_id": 0, "id": 1, "full_name": 1, "email": 1, "is_active": 1, "status": 1},
        )
        if not target_user:
            raise HTTPException(status_code=404, detail="Selected employee not found")
        if target_user.get("is_active") is False or target_user.get("status") == "inactive":
            raise HTTPException(status_code=400, detail="Selected employee is inactive")

        from_date = datetime.fromisoformat(data["from_date"]).date()
        to_date = datetime.fromisoformat(data.get("to_date", data["from_date"])).date()
        reason = data.get("reason", "Leave Applied")
        leave_type = data.get(
            "leave_type", "full_day"
        )  # full_day | half_day_morning | half_day_afternoon | early_leave
        early_leave_time = data.get(
            "early_leave_time"
        )  # "HH:MM" string for early leave

        VALID_LEAVE_TYPES = (
            "full_day",
            "half_day_morning",
            "half_day_afternoon",
            "early_leave",
        )
        if leave_type not in VALID_LEAVE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid leave_type. Must be one of: {VALID_LEAVE_TYPES}",
            )

        if to_date < from_date:
            raise HTTPException(status_code=400, detail="Invalid date range")

        # For partial-day leave types, only single-day makes sense
        if leave_type in ("half_day_morning", "half_day_afternoon", "early_leave"):
            if to_date != from_date:
                raise HTTPException(
                    status_code=400,
                    detail="Half-day and early leave can only be applied for a single day",
                )

        current = from_date
        while current <= to_date:
            current_str = current.isoformat()
            existing = await db.attendance.find_one(
                {"user_id": target_user_id, "date": current_str}, {"_id": 0}
            )

            if leave_type == "full_day":
                update_fields = {
                    "status": "leave",
                    "leave_reason": reason,
                    "leave_type": "full_day",
                    "punch_in": None,
                    "punch_out": None,
                    "duration_minutes": 0,
                }

            elif leave_type == "half_day_morning":
                # Morning off — not expected to punch in before noon
                update_fields = {
                    "status": "present",
                    "leave_reason": reason,
                    "leave_type": "half_day_morning",
                    "is_half_day": True,
                    # Don't wipe punch_in/out if already recorded
                }
                if not existing or not existing.get("punch_in"):
                    update_fields["punch_in"] = None
                    update_fields["punch_out"] = None
                    update_fields["duration_minutes"] = 0

            elif leave_type == "half_day_afternoon":
                # Afternoon off — present in morning, leaves at noon
                update_fields = {
                    "status": "present",
                    "leave_reason": reason,
                    "leave_type": "half_day_afternoon",
                    "is_half_day": True,
                }
                # Set a nominal punch-out at 13:30 IST if not already punched out
                if (
                    existing
                    and existing.get("punch_in")
                    and not existing.get("punch_out")
                ):
                    punch_in_dt = existing["punch_in"]
                    if isinstance(punch_in_dt, str):
                        punch_in_dt = datetime.fromisoformat(punch_in_dt)
                    if punch_in_dt.tzinfo is None:
                        punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
                    half_day_out = datetime.now(timezone.utc).replace(
                        hour=8, minute=0, second=0, microsecond=0
                    )  # 13:30 IST = 08:00 UTC
                    delta = half_day_out - punch_in_dt
                    dur = max(0, int(delta.total_seconds() / 60))
                    update_fields["punch_out"] = half_day_out
                    update_fields["duration_minutes"] = dur
                    update_fields["punched_out_early"] = True

            elif leave_type == "early_leave":
                # Present but left early at a specified time
                update_fields = {
                    "status": "present",
                    "leave_reason": reason,
                    "leave_type": "early_leave",
                    "is_early_leave": True,
                    "early_leave_time": early_leave_time,
                }
                # If a departure time given and user is punched in without punch-out, record it
                if (
                    early_leave_time
                    and existing
                    and existing.get("punch_in")
                    and not existing.get("punch_out")
                ):
                    try:
                        punch_in_dt = existing["punch_in"]
                        if isinstance(punch_in_dt, str):
                            punch_in_dt = datetime.fromisoformat(punch_in_dt)
                        if punch_in_dt.tzinfo is None:
                            punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
                        # Parse "HH:MM" departure time as IST then convert to UTC
                        h, m = map(int, early_leave_time.split(":"))
                        today_ist = datetime.now(ZoneInfo("Asia/Kolkata")).replace(
                            hour=h, minute=m, second=0, microsecond=0
                        )
                        early_out_utc = today_ist.astimezone(timezone.utc)
                        delta = early_out_utc - punch_in_dt
                        dur = max(0, int(delta.total_seconds() / 60))
                        update_fields["punch_out"] = early_out_utc
                        update_fields["duration_minutes"] = dur
                        update_fields["punched_out_early"] = True
                    except Exception:
                        pass

            await db.attendance.update_one(
                {"user_id": target_user_id, "date": current_str},
                {"$set": update_fields},
                upsert=True,
            )

            # IMPORTANT: Do NOT create a global holidays collection entry for
            # employee-specific half-day leave.  A holiday document is global
            # for a date, so doing that would incorrectly make every employee
            # appear to have a half-day.  The attendance record above is the
            # authoritative per-user source of truth.

            await create_audit_log(
                current_user,
                action="APPLY_LEAVE_FOR_USER" if target_user_id != current_user.id else "APPLY_LEAVE",
                module="attendance",
                record_id=f"{target_user_id}_{current_str}",
                old_data=existing,
                new_data={**update_fields, "target_user_id": target_user_id},
            )

            current += timedelta(days=1)

        # Notify admins with the actual employee for whom the leave was applied.
        try:
            span = (
                from_date.isoformat()
                if from_date == to_date
                else f"{from_date.isoformat()} → {to_date.isoformat()}"
            )
            applicant_name = target_user.get("full_name") or target_user.get("email") or target_user_id
            admin_action = "Admin applied" if target_user_id != current_user.id else "Leave applied"
            await notify_admins_leave(
                applicant_name=applicant_name,
                detail=f"{admin_action}: {leave_type.replace('_', ' ')} · {span} · {reason}",
                exclude_user_id=current_user.id if target_user_id != current_user.id else None,
            )
        except Exception:
            pass

        return {
            "message": "Leave applied successfully",
            "leave_type": leave_type,
            "user_id": target_user_id,
            "user_name": target_user.get("full_name"),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@api_router.get("/attendance/history", response_model=List[Attendance])
async def get_attendance_history(
    user_id: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    query = {}
    if current_user.role == "admin":
        if user_id:
            query["user_id"] = user_id
        # No user_id from admin = return ALL records (aggregate view)
    elif current_user.role == "manager":
        permissions_mgr = get_user_permissions(current_user)
        # Manager: Own + Team (same department) + explicit cross-visibility list
        team_ids = await get_team_user_ids(current_user.id)
        allowed_users = list(
            set((permissions_mgr.get("view_other_attendance", []) or []) + team_ids)
        )
        if user_id:
            if user_id == current_user.id:
                query["user_id"] = user_id
            else:
                if not permissions_mgr.get("can_view_attendance", False):
                    raise HTTPException(
                        status_code=403,
                        detail="You do not have permission to view other users' attendance",
                    )
                if user_id not in allowed_users:
                    raise HTTPException(
                        status_code=403, detail="This user is outside your team scope"
                    )
                query["user_id"] = user_id
        else:
            if permissions_mgr.get("can_view_attendance", False):
                query["user_id"] = {"$in": list(set(allowed_users + [current_user.id]))}
            else:
                query["user_id"] = current_user.id
    else:
        if user_id and user_id != current_user.id:
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_attendance", [])
            if user_id not in allowed_users:
                raise HTTPException(
                    status_code=403,
                    detail="Not authorized to view other users' attendance",
                )
        query["user_id"] = user_id if user_id else current_user.id
    attendance_list = (
        await db.attendance.find(query, {"_id": 0}).sort("date", -1).to_list(1000)
    )
    for attendance in attendance_list:
        attendance["punch_in"] = safe_dt(attendance.get("punch_in"))
        attendance["punch_out"] = safe_dt(attendance.get("punch_out"))
        if "status" not in attendance:
            attendance["status"] = "present" if attendance.get("punch_in") else "absent"
    return attendance_list


@api_router.get("/attendance/my-summary")
async def get_my_attendance_summary(current_user: User = Depends(get_current_user)):
    now = datetime.now(IST)
    current_month = now.strftime("%Y-%m")
    attendance_list = (
        await db.attendance.find({"user_id": current_user.id}, {"_id": 0})
        .sort("date", -1)
        .to_list(1000)
    )
    monthly_data = {}
    total_minutes_all = 0
    total_days = 0
    for attendance in attendance_list:
        month = attendance["date"][:7]
        if month not in monthly_data:
            monthly_data[month] = {"total_minutes": 0, "days_present": 0}
        duration = attendance.get("duration_minutes")
        if isinstance(duration, (int, float)):
            monthly_data[month]["total_minutes"] += duration
            total_minutes_all += duration
            monthly_data[month]["days_present"] += 1
            total_days += 1
    formatted_data = []
    for month, data in monthly_data.items():
        minutes = data["total_minutes"]
        hours = minutes // 60
        mins = minutes % 60
        formatted_data.append(
            {
                "month": month,
                "total_minutes": minutes,
                "total_hours": f"{hours}h {mins}m",
                "days_present": data["days_present"],
            }
        )
    return {
        "current_month": current_month,
        "total_days": total_days,
        "total_minutes": total_minutes_all,
        "monthly_summary": formatted_data,
    }


@api_router.get("/attendance/staff-report")
async def get_staff_attendance_report(
    month: Optional[str] = None,
    # FIX: was check_module_permission("attendance","view") → can_view_attendance.
    # Any authenticated user can hit this endpoint; data scope is enforced below.
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")
    users = await db.users.find({}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0}).to_list(length=None)
    user_map = {u["id"]: u for u in users}

    # SCOPE enforcement
    attendance_query = {"date": {"$regex": f"^{target_month}"}}
    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_others = permissions.get("view_other_attendance", []) or []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_others = list(set(allowed_others + team_ids))
        visible_ids = list(set(allowed_others + [current_user.id]))
        attendance_query["user_id"] = {"$in": visible_ids}

    attendance_list = await db.attendance.find(attendance_query, {"_id": 0}).to_list(
        length=None
    )
    staff_report = {}
    for attendance in attendance_list:
        uid = attendance["user_id"]
        if uid not in staff_report:
            user_info = user_map.get(uid, {})
            staff_report[uid] = {
                "user_id": uid,
                "user_name": user_info.get("full_name", "Unknown"),
                "role": user_info.get("role", "staff"),
                "total_minutes": 0,
                "days_present": 0,
                "days_absent": 0,
                "late_days": 0,
                "early_out_days": 0,
                "records": [],
            }
        # count absent days separately
        if attendance.get("status") == "absent":
            staff_report[uid]["days_absent"] += 1
        duration = attendance.get("duration_minutes")
        if isinstance(duration, (int, float)) and attendance.get("status") == "present":
            staff_report[uid]["total_minutes"] += duration
            staff_report[uid]["days_present"] += 1
        if attendance.get("is_late"):
            staff_report[uid]["late_days"] += 1
        if attendance.get("punched_out_early"):
            staff_report[uid]["early_out_days"] += 1
        staff_report[uid]["records"].append(
            {
                "date": attendance["date"],
                "status": attendance.get("status", "absent"),
                "punch_in": attendance.get("punch_in"),
                "punch_out": attendance.get("punch_out"),
                "duration_minutes": duration,
                "is_late": attendance.get("is_late", False),
                "punched_out_early": attendance.get("punched_out_early", False),
            }
        )
    result = []
    # PERF FIX: calculate_expected_hours() used to re-query db.holidays on
    # every single iteration of this loop (one full collection scan per
    # staff member). Fetching the holiday set once, up front, and reusing it
    # turns N DB round trips into 1 — this was the main reason the Attendance
    # page got slower as headcount grew.
    holidays_cursor = db.holidays.find({"status": "confirmed"})
    holidays_set = {h["date"] for h in await holidays_cursor.to_list(length=None)}
    for uid, data in staff_report.items():
        total_minutes = data["total_minutes"]
        hours = total_minutes // 60
        minutes = total_minutes % 60
        data["total_hours"] = f"{hours}h {minutes}m"
        if data["days_present"] > 0:
            data["avg_hours_per_day"] = round(
                (total_minutes / data["days_present"]) / 60, 1
            )
        else:
            data["avg_hours_per_day"] = 0
        user_data = user_map.get(uid, {})
        year, month_val = map(int, target_month.split("-"))
        _, last_day = calendar.monthrange(year, month_val)
        expected_hours = _expected_hours_pure(
            f"{target_month}-01",
            f"{target_month}-{last_day}",
            user_data.get("punch_in_time", "10:30"),
            user_data.get("punch_out_time", "19:00"),
            holidays_set,
        )
        data["expected_hours"] = expected_hours
        result.append(data)
    result.sort(key=lambda x: x["total_minutes"], reverse=True)
    return result


@api_router.get("/attendance/export-pdf")
async def export_attendance_pdf(
    user_id: str, current_user: User = Depends(get_current_user)
):
    if user_id != current_user.id:
        permissions = get_user_permissions(current_user)
        if current_user.role != "admin" and not permissions.get("can_view_attendance"):
            raise HTTPException(
                status_code=403,
                detail="Not authorized to export other users' attendance",
            )
    records = (
        await db.attendance.find({"user_id": user_id}, {"_id": 0})
        .sort("date", 1)
        .to_list(1000)
    )
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Arial", "B", 14)
    pdf.cell(200, 10, txt="Attendance Report", ln=True, align="C")
    pdf.ln(5)
    pdf.set_font("Arial", size=10)
    for rec in records:
        status = rec.get("status", "unknown")
        late_flag = " [LATE]" if rec.get("is_late") else ""
        early_flag = " [EARLY OUT]" if rec.get("punched_out_early") else ""
        if status == "absent":
            pdf.multi_cell(
                0,
                8,
                f"Date: {rec.get('date')} | Status: ABSENT"
                f"{' [AUTO-MARKED 7PM]' if rec.get('auto_marked') else ''}",
            )
        else:
            pdf.multi_cell(
                0,
                8,
                f"Date: {rec.get('date')} | In: {rec.get('punch_in')} | "
                f"Out: {rec.get('punch_out')} | Duration: {rec.get('duration_minutes')} mins"
                f"{late_flag}{early_flag}",
            )
        pdf.ln(2)
    output = BytesIO()
    output.write(pdf.output(dest="S").encode("latin1"))
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=attendance_{user_id}.pdf"
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# EDIT ATTENDANCE RECORD — Admin / permitted users
# PATCH /api/attendance/edit-record
# ─────────────────────────────────────────────────────────────────────────────
@api_router.patch("/attendance/edit-record")
async def edit_attendance_record(
    data: dict, current_user: User = Depends(require_admin())
):
    """
    Admin-only manual attendance correction.
    Body: { date, user_id, status, note }
    The selected user is the ONLY attendance record that can be changed.
    """
    date_str = data.get("date")
    user_id = data.get("user_id")
    if not user_id or user_id == "everyone":
        raise HTTPException(status_code=400, detail="A specific employee user_id is required")
    status = data.get("status")
    note = data.get("note", "").strip()

    if not date_str or not status:
        raise HTTPException(status_code=400, detail="date and status are required")

    valid_statuses = {"present", "absent", "half_day", "leave", "late", "wfh"}
    if status not in valid_statuses:
        raise HTTPException(
            status_code=400, detail=f"Invalid status. Must be one of: {valid_statuses}"
        )

    target_user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "full_name": 1, "is_active": 1, "status": 1},
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="Selected employee not found")
    if target_user.get("is_active") is False or target_user.get("status") == "inactive":
        raise HTTPException(status_code=400, detail="Selected employee is inactive")

    existing = await db.attendance.find_one(
        {"user_id": user_id, "date": date_str}, {"_id": 0}
    )

    update_fields = {
        "status": status,
        "edited_by": current_user.id,
        "edited_at": datetime.now(timezone.utc).isoformat(),
        "admin_note": note or None,
        "auto_marked": False,
    }

    # Status-specific adjustments.  Explicitly clear mutually-exclusive
    # flags so an Admin can safely reverse Half Day → Present/Absent/Leave.
    if status == "present":
        update_fields["is_half_day"] = False
        update_fields["leave_type"] = None
        update_fields["leave_reason"] = None
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "absent":
        update_fields["punch_in"] = None
        update_fields["punch_out"] = None
        update_fields["duration_minutes"] = 0
        update_fields["is_half_day"] = False
        update_fields["leave_type"] = None
        update_fields["leave_reason"] = None
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "leave":
        update_fields["punch_in"] = None
        update_fields["punch_out"] = None
        update_fields["duration_minutes"] = 0
        update_fields["leave_reason"] = note or "Admin marked leave"
        update_fields["leave_type"] = "full_day"
        update_fields["is_half_day"] = False
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "half_day":
        update_fields["is_half_day"] = True
        update_fields["leave_type"] = None
        update_fields["is_early_leave"] = False
        update_fields["early_leave_time"] = None
    elif status == "late":
        update_fields["is_late"] = True
    elif status == "wfh":
        update_fields["location_type"] = "wfh"

    await db.attendance.update_one(
        {"user_id": user_id, "date": date_str}, {"$set": update_fields}, upsert=True
    )

    # IMPORTANT: Admin-marked Half Day is employee-specific.  Do NOT create
    # or remove a global holidays document here.  The attendance record above
    # is scoped by {user_id, date}, so changing Employee A cannot affect
    # Employee B on the same date.

    await create_audit_log(
        current_user,
        action="EDIT_ATTENDANCE_RECORD",
        module="attendance",
        record_id=f"{user_id}_{date_str}",
        old_data=existing,
        new_data=update_fields,
    )

    return {
        "message": f"Attendance updated to '{status}' for {date_str}",
        "date": date_str,
        "user_id": user_id,
        "status": status,
    }


@api_router.patch("/attendance/admin-reset-punch-out")
async def admin_reset_punch_out(
    data: dict, current_user: User = Depends(require_admin())
):
    """
    Admin-only correction for an accidental punch-out.

    This restores the selected employee's day to an active punched-in state:
      - keeps the original punch_in
      - clears punch_out and punch-out metadata
      - resets duration/overtime/early-out values

    Body: {"date": "YYYY-MM-DD", "user_id": "...", "note": "..."}
    The operation is strictly scoped to {user_id, date}.
    """
    date_str = data.get("date")
    user_id = data.get("user_id")
    note = (data.get("note") or "").strip()

    if not date_str or not user_id or user_id == "everyone":
        raise HTTPException(status_code=400, detail="Specific employee and date are required")

    target_user = await db.users.find_one(
        {"id": user_id},
        {"_id": 0, "id": 1, "full_name": 1, "is_active": 1, "status": 1},
    )
    if not target_user:
        raise HTTPException(status_code=404, detail="Selected employee not found")
    if target_user.get("is_active") is False or target_user.get("status") == "inactive":
        raise HTTPException(status_code=400, detail="Selected employee is inactive")

    existing = await db.attendance.find_one(
        {"user_id": user_id, "date": date_str}, {"_id": 0}
    )
    if not existing:
        raise HTTPException(status_code=404, detail="Attendance record not found")
    if not existing.get("punch_in"):
        raise HTTPException(status_code=400, detail="Employee has no punch-in record to restore")
    if not existing.get("punch_out"):
        raise HTTPException(status_code=400, detail="Punch-out is already cleared")

    update_fields = {
        "punch_out": None,
        "punch_out_location": None,
        "punch_out_source": None,
        "punch_out_device_serial": None,
        "duration_minutes": 0,
        "punched_out_early": False,
        "overtime_minutes": 0,
        "edited_by": current_user.id,
        "edited_at": datetime.now(timezone.utc).isoformat(),
        "admin_note": note or "Admin restored accidental punch-out",
        "auto_marked": False,
    }

    await db.attendance.update_one(
        {"user_id": user_id, "date": date_str},
        {"$set": update_fields},
    )

    await create_audit_log(
        current_user,
        action="ADMIN_RESET_PUNCH_OUT",
        module="attendance",
        record_id=f"{user_id}_{date_str}",
        old_data={
            "punch_in": existing.get("punch_in"),
            "punch_out": existing.get("punch_out"),
            "duration_minutes": existing.get("duration_minutes", 0),
        },
        new_data=update_fields,
    )

    return {
        "message": f"Punch-out restored to active punch-in for {target_user.get('full_name') or user_id}",
        "date": date_str,
        "user_id": user_id,
        "punch_in": existing.get("punch_in"),
        "punch_out": None,
    }


# ─────────────────────────────────────────────────────────────────────────────
# MANUAL ABSENT MARKING ENDPOINT (Admin only)
# POST /api/attendance/mark-absent-bulk
# Body: { "date": "YYYY-MM-DD" }  (optional — defaults to today IST)
# ─────────────────────────────────────────────────────────────────────────────
@api_router.post("/attendance/mark-absent-bulk")
async def mark_absent_bulk(
    data: dict = {}, current_user: User = Depends(require_admin())
):
    """
    Admin-only manual absent marking.

    - user_id supplied: mark ONLY that employee absent.
    - user_id omitted: preserve the explicit bulk/all-active behavior for
      backward compatibility (the frontend disables this path when a specific
      employee is selected so an accidental universal update cannot occur).
    """
    target_date_str = (data or {}).get("date") or datetime.now(IST).date().isoformat()
    target_user_id = (data or {}).get("user_id") or (data or {}).get("target_user_id")
    if target_user_id == "everyone":
        raise HTTPException(status_code=400, detail="Select one specific employee")
    try:
        datetime.strptime(target_date_str, "%Y-%m-%d")
    except ValueError:
        raise HTTPException(
            status_code=400, detail="Invalid date format. Use YYYY-MM-DD."
        )
    result = await _mark_absent_for_date(target_date_str, target_user_id=target_user_id, actor_user_id=current_user.id)
    if target_user_id:
        result["marked_by"] = current_user.id
        if result.get("marked"):
            await create_audit_log(
                current_user,
                action="ADMIN_MARK_ABSENT",
                module="attendance",
                record_id=f"{target_user_id}_{target_date_str}",
                old_data={"status": result.get("previous_status")} if result.get("previous_status") else None,
                new_data={"status": "absent", "user_id": target_user_id, "date": target_date_str},
            )
    return result


# ─────────────────────────────────────────────────────────────────────────────
# ABSENT SUMMARY ENDPOINT
# GET /api/attendance/absent-summary?month=YYYY-MM
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/attendance/absent-summary")
async def get_absent_summary(
    month: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    """
    Returns per-user absent day counts for the given month.
    Admin sees all users; non-admins see themselves plus any user
    covered by their "view_other_attendance" cross-visibility permission.
    """
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")

    if current_user.role == "admin":
        query = {"date": {"$regex": f"^{target_month}"}, "status": "absent"}
    else:
        # Non-admins may see this card only for users explicitly granted to
        # them via the "view_other_attendance" cross-visibility permission,
        # in addition to their own record.
        perms = get_user_permissions(current_user)
        cross_ids = list(perms.get("view_other_attendance") or [])
        visible_ids = list(set(cross_ids + [current_user.id]))
        query = {
            "user_id": {"$in": visible_ids},
            "date": {"$regex": f"^{target_month}"},
            "status": "absent",
        }

    absent_records = await db.attendance.find(query, {"_id": 0}).to_list(5000)
    summary: dict = {}
    for rec in absent_records:
        uid = rec["user_id"]
        if uid not in summary:
            summary[uid] = {"user_id": uid, "absent_days": 0, "dates": []}
        summary[uid]["absent_days"] += 1
        summary[uid]["dates"].append(rec["date"])

    # Attach display names for every user in the summary (admin or
    # cross-visibility-permitted viewer), not just admins.
    user_ids = list(summary.keys())
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}
        ).to_list(1000)
        name_map = {u["id"]: u["full_name"] for u in users}
        for uid in summary:
            summary[uid]["user_name"] = name_map.get(uid, "Unknown")

    return {"month": target_month, "data": list(summary.values())}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/attendance/leave-summary?month=YYYY-MM
# Mirrors /attendance/absent-summary but for users on applied leave.
# Admin sees everyone; non-admins see only users covered by their
# "view_other_attendance" cross-visibility permission (plus themselves).
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/attendance/leave-summary")
async def get_leave_summary(
    month: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    """
    Returns per-user applied-leave details for the given month, including
    the reason, leave type, and dates for each leave record — so an admin
    (or a permitted cross-visibility viewer) can drill into why someone
    applied for leave.
    """
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")

    if current_user.role == "admin":
        query = {"date": {"$regex": f"^{target_month}"}, "status": "leave"}
    else:
        perms = get_user_permissions(current_user)
        cross_ids = list(perms.get("view_other_attendance") or [])
        visible_ids = list(set(cross_ids + [current_user.id]))
        query = {
            "user_id": {"$in": visible_ids},
            "date": {"$regex": f"^{target_month}"},
            "status": "leave",
        }

    leave_records = await db.attendance.find(query, {"_id": 0}).to_list(5000)
    summary: dict = {}
    for rec in leave_records:
        uid = rec["user_id"]
        if uid not in summary:
            summary[uid] = {"user_id": uid, "leave_days": 0, "records": []}
        summary[uid]["leave_days"] += 1
        summary[uid]["records"].append(
            {
                "date": rec.get("date"),
                "leave_type": rec.get("leave_type", "full_day"),
                "reason": rec.get("leave_reason"),
                "early_leave_time": rec.get("early_leave_time"),
                "punch_in": rec.get("punch_in"),
                "punch_out": rec.get("punch_out"),
            }
        )

    user_ids = list(summary.keys())
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}
        ).to_list(1000)
        name_map = {u["id"]: u["full_name"] for u in users}
        for uid in summary:
            summary[uid]["user_name"] = name_map.get(uid, "Unknown")

    return {"month": target_month, "data": list(summary.values())}


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/attendance/location-summary?month=YYYY-MM
# Mirrors /attendance/absent-summary and /attendance/leave-summary but for
# GPS punch-in/punch-out locations. Unlike those two, this is visible to
# EVERY user (not just admins / cross-visibility-permitted viewers) — the
# frontend calls it unconditionally on the Attendance page. The same
# visibility rule as the other summaries still applies underneath: admins
# see every user's location days, everyone else sees their own plus any
# user covered by their "view_other_attendance" cross-visibility
# permission — for a regular user with no cross-visibility grant, that
# just means "only myself", which is exactly what "visible to all users"
# should mean for a self-service GPS log.
# ─────────────────────────────────────────────────────────────────────────────
@api_router.get("/attendance/location-summary")
async def get_location_summary(
    month: Optional[str] = None, current_user: User = Depends(get_current_user)
):
    """
    Returns per-user GPS punch-in/punch-out location records for the given
    month, for any day that captured at least one location. Powers the
    "Location History" drill-down card and the reverse-geocode pre-warm
    effect on the Attendance page.
    """
    now = datetime.now(IST)
    target_month = month or now.strftime("%Y-%m")

    base_filter = {
        "date": {"$regex": f"^{target_month}"},
        "$or": [
            {"location": {"$exists": True, "$ne": None}},
            {"punch_out_location": {"$exists": True, "$ne": None}},
        ],
    }
    if current_user.role == "admin":
        query = base_filter
    else:
        perms = get_user_permissions(current_user)
        cross_ids = list(perms.get("view_other_attendance") or [])
        visible_ids = list(set(cross_ids + [current_user.id]))
        query = {"user_id": {"$in": visible_ids}, **base_filter}

    location_records = await db.attendance.find(query, {"_id": 0}).to_list(5000)
    summary: dict = {}
    for rec in location_records:
        uid = rec["user_id"]
        if uid not in summary:
            summary[uid] = {"user_id": uid, "location_days": 0, "records": []}
        summary[uid]["location_days"] += 1
        summary[uid]["records"].append(
            {
                "date": rec.get("date"),
                "punch_in": rec.get("punch_in"),
                "punch_out": rec.get("punch_out"),
                # DB stores the punch-in location under "location"; the
                # frontend's Location History modal reads it as
                # "punch_in_location" (to sit alongside punch_out_location).
                "punch_in_location": rec.get("location"),
                "punch_out_location": rec.get("punch_out_location"),
            }
        )

    user_ids = list(summary.keys())
    if user_ids:
        users = await db.users.find(
            {"id": {"$in": user_ids}}, {"_id": 0, "id": 1, "full_name": 1}
        ).to_list(1000)
        name_map = {u["id"]: u["full_name"] for u in users}
        for uid in summary:
            summary[uid]["user_name"] = name_map.get(uid, "Unknown")

    return {"month": target_month, "data": list(summary.values())}


# =============================================================
# NEW: POST /attendance/punch-out
# Dedicated auto punch-out endpoint.
# Called by the frontend Smart Auto Punch-Out feature when the
# user is inactive for >60 minutes after the shift grace period.
# Falls back gracefully if the user is already punched out.
# =============================================================
@api_router.post("/attendance/punch-out")
async def auto_punch_out(data: dict, current_user: User = Depends(get_current_user)):
    """
    Auto punch-out triggered by the frontend inactivity detector.
    Accepts { auto: true, reason: "inactive_after_shift" }.
    Records overtime_minutes (minutes worked past 7 PM IST).
    """
    today_str = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()

    attendance = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0}
    )
    if not attendance or not attendance.get("punch_in"):
        raise HTTPException(status_code=400, detail="Not punched in yet")
    if attendance.get("punch_out"):
        # A second punch-out is never permitted. The only way to reopen the
        # attendance record is through the admin reset/edit workflow.
        raise HTTPException(
            status_code=409,
            detail="Punch Out already recorded. A second Punch Out is not allowed unless an administrator edits/resets the previous Punch Out."
        )

    punch_in_dt = attendance.get("punch_in")
    punch_out_utc = datetime.now(timezone.utc)
    punch_out_ist = punch_out_utc.astimezone(ZoneInfo("Asia/Kolkata"))

    # Normalise punch_in to aware datetime
    if isinstance(punch_in_dt, datetime):
        if punch_in_dt.tzinfo is None:
            punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
    else:
        try:
            punch_in_dt = datetime.fromisoformat(str(punch_in_dt))
            if punch_in_dt.tzinfo is None:
                punch_in_dt = punch_in_dt.replace(tzinfo=timezone.utc)
        except Exception:
            punch_in_dt = punch_out_utc

    delta = punch_out_utc - punch_in_dt.astimezone(timezone.utc)
    duration_minutes = max(0, int(delta.total_seconds() / 60))

    # Fetch user doc first so we can use their personal shift-end time
    user_doc = await db.users.find_one({"id": current_user.id}, {"_id": 0})
    punched_out_early = check_punched_out_early(user_doc or {}, punch_out_ist)

    # Overtime: minutes worked past this user's own punch_out_time
    _pot_str = (user_doc or {}).get("punch_out_time") or "19:00"
    try:
        _pot = datetime.strptime(_pot_str, "%H:%M")
    except ValueError:
        _pot = datetime.strptime("19:00", "%H:%M")
    shift_end_ist = punch_out_ist.replace(
        hour=_pot.hour, minute=_pot.minute, second=0, microsecond=0
    )
    overtime_minutes = 0
    if punch_out_ist > shift_end_ist:
        overtime_minutes = max(
            0, int((punch_out_ist - shift_end_ist).total_seconds() / 60)
        )

    update_fields = {
        "punch_out": punch_out_utc,
        "punched_out_early": punched_out_early,
        "duration_minutes": duration_minutes,
        "auto_punch_out": True,
        "auto_punch_reason": data.get("reason", "inactive_after_shift"),
        "overtime_minutes": overtime_minutes,
    }

    await db.attendance.update_one(
        {"user_id": current_user.id, "date": today_str}, {"$set": update_fields}
    )

    logger.info(
        "Auto punch-out: user=%s date=%s duration=%dm overtime=%dm reason=%s",
        current_user.id,
        today_str,
        duration_minutes,
        overtime_minutes,
        data.get("reason", "inactive_after_shift"),
    )

    return {
        "message": "Auto punch-out recorded",
        "duration": duration_minutes,
        "overtime_minutes": overtime_minutes,
        "auto": True,
    }


# =============================================================
# NEW: POST /attendance/proof
# Upload photos, documents, and a note as attendance proof.
# Example: "Visited client → upload photo".
# Files are stored in MongoDB GridFS (backend/file_store.py); the server disk is
# wiped on every deploy, so files written to uploads/ used to be lost.
# The proof dict is embedded inside the attendance document.
# =============================================================
ALLOWED_PHOTO_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/heic",
}
ALLOWED_DOC_TYPES = {
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
    "text/csv",
}
MAX_FILE_SIZE_MB = 10
MAX_FILES_PER_UPLOAD = 5
PROOF_FILE_KIND = "attendance_proof"


@api_router.post("/attendance/proof")
async def upload_attendance_proof(
    note: str = Form(default=""),
    photos: List[UploadFile] = File(default=[]),
    documents: List[UploadFile] = File(default=[]),
    current_user: User = Depends(get_current_user),
):
    """
    Attach proof to today's attendance record.
    - note:      free-text description (e.g. "Visited ABC client office")
    - photos:    up to 5 image files (JPEG, PNG, WebP, GIF, HEIC)
    - documents: up to 5 document files (PDF, DOC, DOCX, XLS, XLSX, TXT, CSV)

    Each call REPLACES the existing proof for today (idempotent upsert).
    """
    today_str = datetime.now(ZoneInfo("Asia/Kolkata")).date().isoformat()
    now_iso = datetime.now(timezone.utc).isoformat()

    # Validate counts
    if len(photos) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_FILES_PER_UPLOAD} photos allowed"
        )
    if len(documents) > MAX_FILES_PER_UPLOAD:
        raise HTTPException(
            status_code=400, detail=f"Maximum {MAX_FILES_PER_UPLOAD} documents allowed"
        )

    saved_photos: List[str] = []
    saved_docs: List[str] = []

    # ── Save photos ────────────────────────────────────────────────────────────
    for photo in photos:
        if not photo.filename:
            continue
        content_type = photo.content_type or ""
        if content_type not in ALLOWED_PHOTO_TYPES and not content_type.startswith(
            "image/"
        ):
            raise HTTPException(
                status_code=400,
                detail=f"File '{photo.filename}' is not an allowed image type",
            )
        contents = await photo.read()
        if len(contents) > MAX_FILE_SIZE_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"Photo '{photo.filename}' exceeds {MAX_FILE_SIZE_MB} MB limit",
            )
        safe_name = re.sub(r"[^\w.\-]", "_", photo.filename)
        filename = (
            f"{current_user.id}_{today_str}_photo_{uuid.uuid4().hex[:8]}_{safe_name}"
        )
        await _file_store.put_file(
            contents, name=filename, content_type=photo.content_type or "application/octet-stream",
            company_id=getattr(current_user, "company_id", None), kind=PROOF_FILE_KIND,
            user_id=current_user.id, date=today_str,
        )
        saved_photos.append(filename)
        await photo.seek(0)  # reset for any downstream use

    # ── Save documents ─────────────────────────────────────────────────────────
    for doc in documents:
        if not doc.filename:
            continue
        content_type = doc.content_type or ""
        if content_type not in ALLOWED_DOC_TYPES and not doc.filename.lower().endswith(
            (".pdf", ".doc", ".docx", ".xls", ".xlsx", ".txt", ".csv")
        ):
            raise HTTPException(
                status_code=400,
                detail=f"File '{doc.filename}' is not an allowed document type",
            )
        contents = await doc.read()
        if len(contents) > MAX_FILE_SIZE_MB * 1024 * 1024:
            raise HTTPException(
                status_code=413,
                detail=f"Document '{doc.filename}' exceeds {MAX_FILE_SIZE_MB} MB limit",
            )
        safe_name = re.sub(r"[^\w.\-]", "_", doc.filename)
        filename = (
            f"{current_user.id}_{today_str}_doc_{uuid.uuid4().hex[:8]}_{safe_name}"
        )
        await _file_store.put_file(
            contents, name=filename, content_type=doc.content_type or "application/octet-stream",
            company_id=getattr(current_user, "company_id", None), kind=PROOF_FILE_KIND,
            user_id=current_user.id, date=today_str,
        )
        saved_docs.append(filename)
        await doc.seek(0)

    # ── Build proof dict ───────────────────────────────────────────────────────
    # Check if a previous proof exists so we can merge (not replace) file lists
    existing = await db.attendance.find_one(
        {"user_id": current_user.id, "date": today_str}, {"_id": 0, "proof": 1}
    )
    existing_proof = existing.get("proof", {}) if existing else {}

    # Merge: keep old files, append new ones
    merged_photos = (existing_proof.get("photos") or []) + saved_photos
    merged_docs = (existing_proof.get("documents") or []) + saved_docs

    proof_payload = {
        "note": note.strip() if note.strip() else (existing_proof.get("note") or ""),
        "photos": merged_photos,
        "documents": merged_docs,
        "uploaded_at": existing_proof.get("uploaded_at")
        or now_iso,  # first upload time
        "updated_at": now_iso,  # last update time
    }

    await db.attendance.update_one(
        {"user_id": current_user.id, "date": today_str},
        {"$set": {"proof": proof_payload}},
        upsert=True,
    )

    logger.info(
        "Proof uploaded: user=%s date=%s photos=%d docs=%d note_len=%d",
        current_user.id,
        today_str,
        len(saved_photos),
        len(saved_docs),
        len(note),
    )

    return {
        "message": "Proof saved successfully",
        "photos_saved": len(saved_photos),
        "documents_saved": len(saved_docs),
        "note_saved": bool(note.strip()),
        "total_photos": len(merged_photos),
        "total_documents": len(merged_docs),
        "date": today_str,
    }


async def _can_view_attendance_of(current_user: User, user_id: str) -> bool:
    if user_id == current_user.id or current_user.role == "admin":
        return True
    if current_user.role != "manager":
        return False
    perms = get_user_permissions(current_user)
    if not perms.get("can_view_attendance", False):
        return False
    team_ids = await get_team_user_ids(current_user.id)
    return user_id in set((perms.get("view_other_attendance", []) or []) + team_ids)


@api_router.get("/attendance/proof/file/{filename}")
async def download_attendance_proof(filename: str, current_user: User = Depends(get_current_user)):
    """Download one proof photo/document. Allowed for the employee, admins and
    managers who may view that employee's attendance."""
    if not filename or "/" in filename or "\\" in filename or filename.startswith("."):
        raise HTTPException(status_code=404, detail="File not found")
    record = await db.attendance.find_one(
        {"$or": [{"proof.photos": filename}, {"proof.documents": filename}]},
        {"_id": 0, "user_id": 1, "company_id": 1},
    )
    if not record or not await _can_view_attendance_of(current_user, record.get("user_id")):
        raise HTTPException(status_code=404, detail="File not found")
    company_id = record.get("company_id") or getattr(current_user, "company_id", None)
    found = await _file_store.get_file(filename, company_id=company_id, kind=PROOF_FILE_KIND)
    if found:
        data, meta = found
        content_type = meta.get("content_type") or "application/octet-stream"
    else:
        # Files uploaded before the move to GridFS, if this server still has them.
        legacy = PROOF_UPLOAD_DIR / filename
        if legacy.resolve().parent != PROOF_UPLOAD_DIR.resolve() or not legacy.is_file():
            raise HTTPException(status_code=404, detail="This file is no longer available.")
        data = legacy.read_bytes()
        import mimetypes
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
    # Never inline SVG or other active types.
    inline = content_type in {"image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"}
    original = re.sub(r"^.*?_(?:photo|doc)_[0-9a-f]{8}_", "", filename) or filename
    return StreamingResponse(
        BytesIO(data),
        media_type=content_type,
        headers={
            "Content-Disposition": f'{"inline" if inline else "attachment"}; filename="{original}"',
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "private, max-age=300",
        },
    )

