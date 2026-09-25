from __future__ import annotations
from datetime import datetime, date, time, timedelta, timezone
from typing import Any
import pytz
from bson import ObjectId
from backend.dependencies import db
from backend.models import AuditLog, User
IST=pytz.timezone("Asia/Kolkata")

def safe_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(IST)
    try:
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=pytz.UTC).astimezone(IST)
        return dt
    except Exception:
        return None




def sanitize_user_data(users, current_user=None):
    is_single = False
    if not isinstance(users, list):
        users = [users]
        is_single = True
    sanitized = []
    for user in users:
        if isinstance(user, dict):
            safe_user = {k: v for k, v in user.items() if k not in ["password", "_id"]}
            sanitized.append(safe_user)
        else:
            user_dict = user.model_dump() if hasattr(user, "model_dump") else vars(user)
            safe_user = {
                k: v for k, v in user_dict.items() if k not in ["password", "_id"]
            }
            sanitized.append(safe_user)
    return sanitized[0] if is_single else sanitized




def convert_objectids(data):
    """Recursively convert MongoDB ObjectId / date / datetime fields to JSON-safe types.

    PyMongo's BSON encoder accepts datetime.datetime but NOT datetime.date, so we
    convert bare date objects to ISO strings here to prevent InvalidDocument errors
    when inserting audit-log entries whose old_data came straight out of MongoDB
    (where birthday / date_of_incorporation may have been stored as date objects).
    """
    if isinstance(data, list):
        return [convert_objectids(item) for item in data]
    if isinstance(data, dict):
        new_dict = {}
        for key, value in data.items():
            if isinstance(value, ObjectId):
                new_dict[key] = str(value)
            elif isinstance(value, datetime):
                # Keep as datetime — pymongo handles datetime natively
                new_dict[key] = value
            elif isinstance(value, date):
                # Convert bare date → ISO string; pymongo cannot encode datetime.date
                new_dict[key] = value.isoformat()
            elif isinstance(value, (dict, list)):
                new_dict[key] = convert_objectids(value)
            else:
                new_dict[key] = value
        return new_dict
    if isinstance(data, ObjectId):
        return str(data)
    if isinstance(data, date) and not isinstance(data, datetime):
        return data.isoformat()
    return data




def is_own_record(current_user: User, record: dict) -> bool:
    uid = current_user.id
    return (
        record.get("user_id") == uid
        or record.get("assigned_to") == uid
        or record.get("created_by") == uid
        or uid in record.get("sub_assignees", [])
    )




async def create_audit_log(
    current_user: User,
    action: str,
    module: str,
    record_id: str,
    old_data: dict = None,
    new_data: dict = None,
):
    log_entry = AuditLog(
        user_id=current_user.id,
        user_name=current_user.full_name,
        action=action,
        module=module,
        record_id=record_id,
        old_data=convert_objectids(old_data) if old_data else None,
        new_data=convert_objectids(new_data) if new_data else None,
        timestamp=datetime.now(timezone.utc),
    )
    await db.audit_logs.insert_one(log_entry.model_dump())




def _expected_hours_pure(
    start_date_str: str,
    end_date_str: str,
    shift_start: str,
    shift_end: str,
    holidays: set,
):
    """Same calculation as calculate_expected_hours(), but takes an
    already-fetched holidays set instead of querying the DB. Lets callers
    that need this for many users (e.g. a staff report) fetch holidays
    ONCE and reuse it, instead of re-querying db.holidays on every
    iteration of a loop."""
    try:
        start = date.fromisoformat(start_date_str)
        end = date.fromisoformat(end_date_str)
    except Exception:
        return 0
    if start > end:
        return 0
    try:
        t1 = datetime.strptime(shift_start, "%H:%M")
        t2 = datetime.strptime(shift_end, "%H:%M")
        hrs_per_day = (t2 - t1).total_seconds() / 3600
    except Exception:
        hrs_per_day = 8.5
    total_hours = 0
    current_date = start
    while current_date <= end:
        if current_date.weekday() < 5 and current_date.isoformat() not in holidays:
            total_hours += hrs_per_day
        current_date += timedelta(days=1)
    return round(total_hours, 2)




async def calculate_expected_hours(
    start_date_str: str,
    end_date_str: str,
    shift_start: str = "10:30",
    shift_end: str = "19:00",
):
    holidays_cursor = db.holidays.find({"status": "confirmed"})
    holidays = {h["date"] for h in await holidays_cursor.to_list(length=None)}
    return _expected_hours_pure(start_date_str, end_date_str, shift_start, shift_end, holidays)


