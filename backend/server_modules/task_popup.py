from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from backend.dependencies import db

logger = logging.getLogger(__name__)


async def create_task_assigned_popup(assigned_to_user_id: str, task_title: str) -> None:
    try:
        now_iso = datetime.now(timezone.utc).isoformat()
        await db.reminders.insert_one({
            "user_id": str(assigned_to_user_id),
            "title": "New Task Assigned",
            "description": f"You have been assigned a new task: \"{task_title}\".",
            "remind_at": now_iso,
            "event_id": f"task-assigned-{uuid.uuid4()}",
            "source": "task",
            "priority": "high",
            "reminder_type": "task_assigned",
            "related_task_id": None,
            "is_dismissed": False,
            "is_fired": False,
            "created_at": now_iso,
            "updated_at": now_iso,
        })
    except Exception as e:
        logger.error(
            f"[Popup] Failed to create task-assigned popup for {assigned_to_user_id}: {e}"
        )
