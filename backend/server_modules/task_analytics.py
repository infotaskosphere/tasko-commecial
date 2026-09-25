from __future__ import annotations

from datetime import datetime

from fastapi import Depends
from backend.dependencies import db
from backend.models import User
from backend.dependencies import check_module_permission

async def get_task_analytics(
    month: str, current_user: User = Depends(check_module_permission("tasks", "view"))
):
    """Get task analytics for a specific month (YYYY-MM)"""
    query = {}
    if current_user.role != "admin":
        query["$or"] = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
    tasks = await db.tasks.find(query, {"_id": 0}).to_list(1000)
    total = 0
    completed = 0
    pending = 0
    for task in tasks:
        created = task.get("created_at")
        if isinstance(created, str):
            if created.startswith(month):
                total += 1
                if task.get("status") == "completed":
                    completed += 1
                elif task.get("status") == "pending":
                    pending += 1
        elif isinstance(created, datetime):
            if created.strftime("%Y-%m") == month:
                total += 1
                if task.get("status") == "completed":
                    completed += 1
                elif task.get("status") == "pending":
                    pending += 1
    return {
        "month": month,
        "total_tasks": total,
        "completed_tasks": completed,
        "pending_tasks": pending,
    }
