"""
notifications.py
================
Full notification router + internal event helpers.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from datetime import datetime, timezone
from typing import List, Optional
import uuid
import logging

from backend.dependencies import db, get_current_user
from pydantic import BaseModel, Field, ConfigDict
from backend.models import User

logger = logging.getLogger(__name__)


def safe_dt(value):
    if not value:
        return datetime.now(timezone.utc)
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    try:
        dt = datetime.fromisoformat(str(value))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return datetime.now(timezone.utc)


class NotificationBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str = Field(min_length=1)
    message: str = Field(min_length=1)
    type: str = "system"
    popup: bool = False
    task_id: Optional[str] = None


class Notification(NotificationBase):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    is_read: bool = False
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class AdminNotificationRequest(BaseModel):
    title: str = Field(min_length=1)
    message: str = Field(min_length=1)
    type: str = "system"
    user_id: Optional[str] = None
    user_ids: Optional[List[str]] = None
    broadcast: bool = False
    popup: bool = False
    task_id: Optional[str] = None


def normalize_notification(doc: dict) -> dict:
    if not doc:
        return doc
    if "_id" in doc and "id" not in doc:
        doc["id"] = str(doc["_id"])
    doc.pop("_id", None)
    doc["created_at"] = safe_dt(doc.get("created_at"))
    return doc


router = APIRouter(prefix="/notifications", tags=["Notifications"])


async def create_notification_indexes():
    try:
        await db.notifications.create_index("user_id")
        await db.notifications.create_index("is_read")
        await db.notifications.create_index("created_at")
    except Exception as e:
        logger.error(f"Index creation failed: {e}")


async def create_notification(
    user_id: str,
    title: str,
    message: str,
    type: str = "system",
    popup: bool = False,
    task_id: Optional[str] = None,
) -> Optional[Notification]:
    try:
        notification = Notification(
            user_id=user_id,
            title=title,
            message=message,
            type=type,
            popup=popup,
            task_id=task_id,
        )
        doc = notification.model_dump()
        doc["created_at"] = datetime.now(timezone.utc)
        result = await db.notifications.insert_one(doc)
        if not result.inserted_id:
            raise Exception("Insert failed")
        doc.pop("_id", None)
        return notification
    except Exception as e:
        logger.error(f"[Notification] Failed to create for user {user_id}: {e}")
        return None


def _company_id(user: User) -> str:
    company_id = getattr(user, "company_id", None)
    return str(company_id).strip() if company_id is not None else ""


def _require_send_access(user: User) -> None:
    role = getattr(user, "role", "")
    role_value = role.value if hasattr(role, "value") else str(role)
    if role_value.lower() != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only admins can send targeted notifications.",
        )


async def _get_admin_user_ids(company_id: str) -> List[str]:
    if not company_id:
        return []
    admins = await db.users.find(
        {"role": "admin", "company_id": company_id, "is_active": True},
        {"id": 1, "_id": 0},
    ).to_list(length=500)
    return [u["id"] for u in admins if "id" in u]


async def _get_permitted_user_ids(company_id: str) -> List[str]:
    if not company_id:
        return []
    permitted = await db.users.find(
        {
            "company_id": company_id,
            "role": {"$ne": "admin"},
            "permissions.can_receive_task_notifications": True,
            "is_active": True,
        },
        {"id": 1, "_id": 0},
    ).to_list(length=500)
    return [u["id"] for u in permitted if "id" in u]


async def notify_admins_leave(
    applicant_name: str,
    detail: str = "",
    exclude_user_id: Optional[str] = None,
    company_id: Optional[str] = None,
) -> None:
    admin_ids = await _get_admin_user_ids(company_id or "")
    recipient_ids = list({uid for uid in admin_ids if uid != exclude_user_id})
    if not recipient_ids:
        return
    now = datetime.now(timezone.utc)
    message = f"{applicant_name} applied for leave."
    if detail:
        message = f"{message} {detail}".strip()
    docs = [
        {
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "title": "Leave Application",
            "message": message,
            "type": "leave",
            "is_read": False,
            "created_at": now,
        }
        for uid in recipient_ids
    ]
    try:
        if docs:
            await db.notifications.insert_many(docs, ordered=False)
    except Exception as e:
        logger.error(f"[Notification] leave insert failed: {e}")


async def notify_admins_and_permitted(
    title: str,
    message: str,
    type: str = "task",
    exclude_user_id: Optional[str] = None,
    company_id: Optional[str] = None,
) -> None:
    scoped_company_id = company_id or ""
    admin_ids = await _get_admin_user_ids(scoped_company_id)
    permitted_ids = await _get_permitted_user_ids(scoped_company_id)
    recipient_ids = list({uid for uid in (admin_ids + permitted_ids) if uid != exclude_user_id})
    if not recipient_ids:
        return
    now = datetime.now(timezone.utc)
    docs = [
        {
            "id": str(uuid.uuid4()),
            "user_id": uid,
            "title": title,
            "message": message,
            "type": type,
            "is_read": False,
            "created_at": now,
        }
        for uid in recipient_ids
    ]
    try:
        if docs:
            await db.notifications.insert_many(docs, ordered=False)
    except Exception as e:
        logger.error(f"[Notification] bulk insert failed: {e}")


def _role_value(user: User) -> str:
    role = user.role
    return role.value if hasattr(role, "value") else str(role)


async def on_task_status_changed(
    task_id: str,
    task_title: str,
    new_status: str,
    changed_by_user: User,
) -> None:
    exclude = changed_by_user.id if _role_value(changed_by_user) == "admin" else None
    await notify_admins_and_permitted(
        title="Task Status Updated",
        message=(
            f'Task "{task_title}" was marked as '
            f'"{new_status}" by '
            f'{changed_by_user.full_name or changed_by_user.email}.'
        ),
        type="task",
        exclude_user_id=exclude,
        company_id=_company_id(changed_by_user),
    )


async def on_task_completed(
    task_id: str,
    task_title: str,
    completed_by_user: User,
) -> None:
    await on_task_status_changed(
        task_id=task_id,
        task_title=task_title,
        new_status="completed",
        changed_by_user=completed_by_user,
    )


async def on_task_assigned(
    task_id: str,
    task_title: str,
    assigned_to_user_id: str,
    assigned_by_user: User,
) -> None:
    is_admin_assigning = _role_value(assigned_by_user) == "admin"
    if not is_admin_assigning:
        await notify_admins_and_permitted(
            title="Task Assigned by Staff/Manager",
            message=(
                f'{assigned_by_user.full_name or assigned_by_user.email} '
                f'assigned task "{task_title}" to a team member.'
            ),
            type="task",
            exclude_user_id=assigned_by_user.id,
            company_id=_company_id(assigned_by_user),
        )
    if assigned_to_user_id != assigned_by_user.id:
        target = await db.users.find_one(
            {"id": assigned_to_user_id, "company_id": _company_id(assigned_by_user), "is_active": True},
            {"id": 1, "_id": 0},
        )
        if target:
            await create_notification(
                user_id=assigned_to_user_id,
                title="New Task Assigned",
                message=(
                    f'You have been assigned the task "{task_title}" '
                    f'by {assigned_by_user.full_name or assigned_by_user.email}.'
                ),
                type="task",
            )


async def on_todo_created(todo_title: str, created_by_user: User) -> None:
    if _role_value(created_by_user) == "admin":
        return
    await notify_admins_and_permitted(
        title="New Todo Created",
        message=(
            f'{created_by_user.full_name or created_by_user.email} '
            f'created a new todo: "{todo_title}".'
        ),
        type="todo",
        exclude_user_id=created_by_user.id,
        company_id=_company_id(created_by_user),
    )


async def on_todo_completed(todo_title: str, completed_by_user: User) -> None:
    if _role_value(completed_by_user) == "admin":
        return
    await notify_admins_and_permitted(
        title="Todo Completed",
        message=(
            f'{completed_by_user.full_name or completed_by_user.email} '
            f'completed todo: "{todo_title}".'
        ),
        type="todo",
        exclude_user_id=completed_by_user.id,
        company_id=_company_id(completed_by_user),
    )


@router.post("/send")
async def send_notification(
    payload: AdminNotificationRequest,
    current_user: User = Depends(get_current_user),
):
    now = datetime.now(timezone.utc)
    company_id = _company_id(current_user)

    if payload.broadcast:
        _require_send_access(current_user)
        if not company_id:
            raise HTTPException(status_code=403, detail="Your account is not attached to a customer company.")
        users = await db.users.find(
            {"company_id": company_id, "is_active": True},
            {"id": 1, "_id": 0},
        ).to_list(length=5000)
        if not users:
            return {"status": "success", "message": "No active users found"}
        docs = [
            {
                "id": str(uuid.uuid4()),
                "user_id": u["id"],
                "title": payload.title,
                "message": payload.message,
                "type": payload.type,
                "popup": payload.popup,
                "task_id": payload.task_id,
                "is_read": False,
                "created_at": now,
            }
            for u in users if "id" in u
        ]
        if docs:
            await db.notifications.insert_many(docs, ordered=False)
        return {"status": "success", "message": f"Broadcasted to {len(docs)} users"}

    if payload.user_ids:
        _require_send_access(current_user)
        if not company_id:
            raise HTTPException(status_code=403, detail="Your account is not attached to a customer company.")
        target_ids = list({uid for uid in payload.user_ids if uid})
        if not target_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="user_ids was provided but contained no valid ids",
            )
        valid_users = await db.users.find(
            {"id": {"$in": target_ids}, "company_id": company_id, "is_active": True},
            {"id": 1, "_id": 0},
        ).to_list(length=len(target_ids))
        valid_ids = {u["id"] for u in valid_users if "id" in u}
        unauthorized_ids = sorted(set(target_ids) - valid_ids)
        if unauthorized_ids:
            raise HTTPException(status_code=403, detail="One or more notification recipients are outside your customer account or inactive.")
        docs = [
            {
                "id": str(uuid.uuid4()),
                "user_id": uid,
                "title": payload.title,
                "message": payload.message,
                "type": payload.type,
                "popup": payload.popup,
                "task_id": payload.task_id,
                "is_read": False,
                "created_at": now,
            }
            for uid in target_ids
        ]
        await db.notifications.insert_many(docs, ordered=False)
        return {"status": "success", "message": f"Notification sent to {len(docs)} users"}

    if payload.user_id:
        _require_send_access(current_user)
        if not company_id:
            raise HTTPException(status_code=403, detail="Your account is not attached to a customer company.")
        target = await db.users.find_one(
            {"id": payload.user_id, "company_id": company_id, "is_active": True},
            {"id": 1, "_id": 0},
        )
        if not target:
            raise HTTPException(status_code=403, detail="Notification recipient is outside your customer account or inactive.")
        result = await create_notification(
            user_id=payload.user_id,
            title=payload.title,
            message=payload.message,
            type=payload.type,
            popup=payload.popup,
            task_id=payload.task_id,
        )
        if result:
            return {"status": "success", "message": "Notification sent"}
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create notification")

    result = await create_notification(
        user_id=current_user.id,
        title=payload.title,
        message=payload.message,
        type=payload.type,
        popup=payload.popup,
        task_id=payload.task_id,
    )
    if result:
        return {"status": "success", "message": "Notification sent"}
    raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to create notification")


@router.get("", response_model=List[Notification])
@router.get("/", response_model=List[Notification], include_in_schema=False)
async def get_my_notifications(
    current_user: User = Depends(get_current_user),
    limit: int = 100,
    skip: int = 0,
    unread_only: bool = False,
):
    limit = max(1, min(limit, 100))
    skip = max(0, skip)
    query: dict = {"user_id": current_user.id}
    if unread_only:
        query["is_read"] = False
    raw = (
        await db.notifications.find(query, {"_id": 0})
        .sort("created_at", -1)
        .skip(skip)
        .limit(limit)
        .to_list(length=limit)
    )
    return [normalize_notification(n) for n in raw]


@router.get("/unread-count")
async def get_unread_count(current_user: User = Depends(get_current_user)):
    try:
        count = await db.notifications.count_documents({"user_id": current_user.id, "is_read": False})
        return {"count": int(count or 0)}
    except Exception as e:
        logger.error(f"[Notification] unread-count error: {e}")
        return {"count": 0}


@router.patch("/read-all")
@router.put("/read-all")
async def mark_all_notifications_read(current_user: User = Depends(get_current_user)):
    await db.notifications.update_many(
        {"user_id": current_user.id, "is_read": False},
        {"$set": {"is_read": True}},
    )
    return {"message": "All notifications marked as read"}


@router.delete("/clear-all")
async def clear_all_notifications(current_user: User = Depends(get_current_user)):
    await db.notifications.delete_many({"user_id": current_user.id})
    return {"message": "All notifications cleared"}


@router.patch("/{notification_id}/read")
@router.put("/{notification_id}/read")
async def mark_notification_read(notification_id: str, current_user: User = Depends(get_current_user)):
    result = await db.notifications.update_one(
        {"id": notification_id, "user_id": current_user.id},
        {"$set": {"is_read": True}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found or not authorized")
    return {"message": "Notification marked as read"}


@router.delete("/{notification_id}")
async def delete_notification(notification_id: str, current_user: User = Depends(get_current_user)):
    result = await db.notifications.delete_one(
        {"id": notification_id, "user_id": current_user.id}
    )
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Notification not found or not authorized")
    return {"message": "Notification deleted"}
