"""Phase 2 extracted subsystem: task_routes.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/task_routes.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import assert_module_permission
from backend.dependencies import assert_record_visibility
from backend.dependencies import check_module_permission
from backend.dependencies import check_permission
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.dependencies import get_team_user_ids
from backend.dependencies import get_user_permissions
from backend.models import BulkTaskCreate
from backend.models import Task
from backend.models import TaskCreate
from backend.models import User
from backend.notifications import create_notification
from backend.server_modules.helpers import create_audit_log
from backend.server_modules.helpers import is_own_record
from backend.server_modules.helpers import safe_dt
from backend.server_modules.task_popup import create_task_assigned_popup
from datetime import datetime
from datetime import timezone
from dateutil import parser
from fastapi import Depends
from fastapi import File
from fastapi import HTTPException
from fastapi import Query
from fastapi import UploadFile
from fastapi.responses import StreamingResponse
from fpdf import FPDF
from io import BytesIO
from io import StringIO
from typing import Optional
import csv
import uuid
from backend.server import IST, api_router  # created in backend/server.py before route modules load

async def _assert_task_tenant_references(current_user, assigned_to=None, sub_assignees=None, client_id=None):
    """Reject task relationships that point outside the authenticated company.

    The central collection wrapper scopes every lookup to the current company;
    this explicit check also makes the assignment rule clear at the API boundary.
    """
    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="A company workspace is required.")

    target_user_ids = set()
    if assigned_to:
        target_user_ids.add(str(assigned_to).strip())
    for user_id in (sub_assignees or []):
        if user_id:
            target_user_ids.add(str(user_id).strip())

    for user_id in target_user_ids:
        if user_id == str(getattr(current_user, "id", "")):
            continue
        target_user = await db.users.find_one(
            {"id": user_id},
            {"_id": 0, "id": 1, "company_id": 1},
        )
        if not target_user or str(target_user.get("company_id") or "").strip() != company_id:
            raise HTTPException(
                status_code=403,
                detail="Tasks can only be assigned to users in your own company workspace.",
            )

    if client_id:
        client = await db.clients.find_one(
            {"id": str(client_id).strip()},
            {"_id": 0, "id": 1, "company_id": 1},
        )
        if not client or str(client.get("company_id") or "").strip() != company_id:
            raise HTTPException(
                status_code=403,
                detail="A task can only be linked to a client in your own company workspace.",
            )


@api_router.post("/tasks", response_model=Task)
async def create_task(
    task_data: TaskCreate,
    # GLITCH FIX: previously gated behind check_module_permission("tasks", "create")
    # which required the universal `can_edit_tasks` flag for EVERYONE, including
    # a user creating their own task. Per spec, every user can create their own
    # task by default; only assigning a task to a DIFFERENT user needs extra
    # permission (checked below via can_assign_tasks OR cross-visibility).
    current_user: User = Depends(get_current_user),
):
    await _assert_task_tenant_references(
        current_user,
        assigned_to=task_data.assigned_to,
        sub_assignees=task_data.sub_assignees,
        client_id=task_data.client_id,
    )
    if (
        task_data.assigned_to
        and task_data.assigned_to != current_user.id
        and current_user.role != "admin"
    ):
        perms = get_user_permissions(current_user)
        # GLITCH FIX: a user who has been granted cross-visibility to another
        # user (view_other_tasks) should also be able to create/assign tasks
        # for that user, not just view them.
        cross_visible_users = perms.get("view_other_tasks", []) or []
        if (
            not perms.get("can_assign_tasks", False)
            and task_data.assigned_to not in cross_visible_users
        ):
            raise HTTPException(
                status_code=403,
                detail="You do not have permission to assign tasks to other users",
            )
    task_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)
    task = Task(
        **task_data.model_dump(),
        id=task_id,
        created_by=current_user.id,
        created_at=now,
        updated_at=now,
    )
    doc = task.model_dump()
    doc["company_id"] = str(current_user.company_id)
    date_fields = ["created_at", "updated_at", "due_date", "recurrence_end_date"]
    for field in date_fields:
        if doc.get(field) and isinstance(doc[field], datetime):
            doc[field] = doc[field].isoformat()
    await db.tasks.insert_one(doc)
    if task.assigned_to and task.assigned_to != current_user.id:
        await create_notification(
            user_id=task.assigned_to,
            title="New Task Assigned",
            message=f"You have been assigned task '{task.title}'",
            type="assignment",
        )
        await create_task_assigned_popup(task.assigned_to, task.title)
    await create_audit_log(
        current_user=current_user,
        action="CREATE_TASK",
        module="tasks",
        record_id=task_id,
        new_data={"title": task.title},
    )
    return task


@api_router.get("/tasks/{task_id}/comments")
async def get_task_comments(
    task_id: str, current_user: User = Depends(get_current_user)
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    is_admin = getattr(current_user, "role", "").lower() == "admin"
    is_involved = is_own_record(current_user, task)
    if not is_admin and not is_involved:
        raise HTTPException(
            status_code=403, detail="Unauthorized to view these comments"
        )
    return task.get("comments", [])


@api_router.post("/tasks/bulk")
async def create_tasks_bulk(
    payload: BulkTaskCreate,
    # GLITCH FIX: see create_task above — creating your own task(s) must not
    # require the universal can_edit_tasks flag.
    current_user: User = Depends(get_current_user),
):
    # Validate the full batch before inserting anything, so a cross-tenant
    # reference cannot leave a partially imported batch behind.
    for task_data in payload.tasks:
        await _assert_task_tenant_references(
            current_user,
            assigned_to=task_data.assigned_to,
            sub_assignees=task_data.sub_assignees,
            client_id=task_data.client_id,
        )

    created_tasks = []
    for task_data in payload.tasks:
        task_dict = task_data.model_dump()
        task_dict["id"] = str(uuid.uuid4())
        task_dict["created_by"] = current_user.id
        task_dict["company_id"] = str(current_user.company_id)
        task_dict["created_at"] = datetime.now(IST).isoformat()
        task_dict["updated_at"] = datetime.now(IST).isoformat()
        if task_dict.get("due_date"):
            task_dict["due_date"] = task_dict["due_date"].isoformat()
        await db.tasks.insert_one(task_dict)
        if task_dict.get("assigned_to") and task_dict["assigned_to"] != current_user.id:
            await create_notification(
                user_id=task_dict["assigned_to"],
                title="New Task Assigned",
                message=f"You have been assigned task '{task_dict['title']}'",
            )
            await create_task_assigned_popup(task_dict["assigned_to"], task_dict["title"])
        created_tasks.append(task_dict)
    return {"message": "Tasks created successfully", "count": len(created_tasks)}


@api_router.post("/tasks/import")
async def import_tasks_from_csv(
    file: UploadFile = File(...),
    # GLITCH FIX: see create_task above — creating your own task(s) must not
    # require the universal can_edit_tasks flag.
    current_user: User = Depends(get_current_user),
):
    if file.content_type != "text/csv":
        raise HTTPException(400, "Invalid file type")
    content = await file.read()
    content_str = content.decode("utf-8")
    csv_reader = csv.DictReader(StringIO(content_str))
    tasks = []
    for row in csv_reader:
        task_data = TaskCreate(
            title=row.get("title", ""),
            description=row.get("description"),
            assigned_to=row.get("assigned_to"),
            sub_assignees=row.get("sub_assignees", "").split(",")
            if row.get("sub_assignees")
            else [],
            due_date=parser.parse(row["due_date"]) if row.get("due_date") else None,
            priority=row.get("priority", "medium"),
            status=row.get("status", "pending"),
            category=row.get("category", "other"),
            client_id=row.get("client_id"),
            is_recurring=bool(row.get("is_recurring", False)),
            recurrence_pattern=row.get("recurrence_pattern", "monthly"),
            recurrence_interval=int(row.get("recurrence_interval", 1)),
        )
        tasks.append(task_data)
    payload = BulkTaskCreate(tasks=tasks)
    return await create_tasks_bulk(payload, current_user)


@api_router.get("/tasks")
async def get_tasks(
    current_user: User = Depends(check_module_permission("tasks", "view")),
    page: Optional[int] = Query(None, ge=1, description="Optional: page number for paginated response"),
    page_size: Optional[int] = Query(None, ge=1, le=500, description="Optional: results per page (only used if `page` is set)"),
):
    """
    BUG FIX: this used to hard-cap at .to_list(1000) — any company with more
    than 1000 tasks silently lost the rest with no error or indication.
    Now fetches everything the (permission-scoped) query matches.

    Pagination is opt-in and backward compatible: existing callers that don't
    pass `page` get the same shape as before (a plain array, unpaginated) —
    nothing breaks. Pass `page` (and optionally `page_size`, default 100) to
    get back a paginated {tasks, total, page, page_size, total_pages} object
    instead, for future adoption by list views that don't need the whole
    dataset client-side at once.
    """
    query = {"type": {"$ne": "todo"}, "company_id": str(current_user.company_id)}
    if current_user.role == "admin":
        pass
    else:
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            # Manager: Own + Team (same department)
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        or_clauses = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
        if allowed_users:
            or_clauses.append({"assigned_to": {"$in": allowed_users}})
            or_clauses.append({"created_by": {"$in": allowed_users}})
        query["$or"] = or_clauses

    total = None
    if page is not None:
        page_size = page_size or 100
        total = await db.tasks.count_documents(query)
        skip = (page - 1) * page_size
        tasks = (
            await db.tasks.find(query, {"_id": 0})
            .sort("created_at", -1)
            .skip(skip)
            .limit(page_size)
            .to_list(page_size)
        )
    else:
        tasks = await db.tasks.find(query, {"_id": 0}).to_list(length=None)

    user_ids = {
        task.get("assigned_to") for task in tasks if task.get("assigned_to")
    } | {task.get("created_by") for task in tasks if task.get("created_by")} | {
        user_id
        for task in tasks
        for user_id in (task.get("sub_assignees") or [])
        if user_id
    }
    users = await db.users.find(
        {"id": {"$in": list(user_ids)}}, {"_id": 0, "password": 0, "password_hash": 0, "password_salt": 0}
    ).to_list(length=None)
    user_map = {u["id"]: u["full_name"] for u in users}
    client_ids = {task.get("client_id") for task in tasks if task.get("client_id")}
    visible_client_ids = set()
    if client_ids:
        visible_clients = await db.clients.find(
            {"id": {"$in": list(client_ids)}}, {"_id": 0, "id": 1}
        ).to_list(length=None)
        visible_client_ids = {c["id"] for c in visible_clients if c.get("id")}
    for task in tasks:
        task["created_at"] = safe_dt(task.get("created_at"))
        task["updated_at"] = safe_dt(task.get("updated_at"))
        task["due_date"] = safe_dt(task.get("due_date"))
        if task.get("assigned_to") and task["assigned_to"] not in user_map:
            # Hide stale/cross-tenant assignee references instead of treating a
            # licensee identity as a staff member in this workspace.
            task["assigned_to"] = None
        task["assigned_to_name"] = user_map.get(task.get("assigned_to"), "Unassigned")
        task["created_by_name"] = user_map.get(task.get("created_by"), "Unknown")
        if not isinstance(task.get("sub_assignees"), list):
            task["sub_assignees"] = []
        else:
            task["sub_assignees"] = [
                user_id for user_id in task["sub_assignees"] if user_id in user_map
            ]
        if task.get("client_id") and task["client_id"] not in visible_client_ids:
            task["client_id"] = None
        if not isinstance(task.get("comments"), list):
            task["comments"] = []

    if page is not None:
        return {
            "tasks": tasks,
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": max(1, -(-total // page_size)),
        }
    return tasks



@api_router.get("/tasks/{task_id}/detail")
async def get_task_detail(task_id: str, current_user: User = Depends(get_current_user)):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if current_user.role != "admin":
        if not is_own_record(current_user, task):
            permissions = get_user_permissions(current_user)
            allowed_users = permissions.get("view_other_tasks", []) or []
            if current_user.role == "manager":
                team_ids = await get_team_user_ids(current_user.id)
                allowed_users = list(set(allowed_users + team_ids))
            if task.get("assigned_to") not in allowed_users:
                raise HTTPException(status_code=403, detail="Not authorized")
    # Batch all user lookups in one query instead of 3 separate find_one calls
    user_ids_to_fetch = list(
        filter(
            None,
            [
                task.get("assigned_to"),
                task.get("created_by"),
                *(task.get("sub_assignees") or []),
            ],
        )
    )
    users_batch = {}
    if user_ids_to_fetch:
        fetched = await db.users.find(
            {"id": {"$in": user_ids_to_fetch}},
            {"_id": 0, "id": 1, "full_name": 1, "profile_picture": 1, "email": 1},
        ).to_list(100)
        users_batch = {u["id"]: u for u in fetched}

    assigned_user = users_batch.get(task.get("assigned_to"))
    created_user = users_batch.get(task.get("created_by"))
    sub_assignee_names = [
        users_batch[uid]["full_name"]
        for uid in (task.get("sub_assignees") or [])
        if uid in users_batch
    ]

    client_name = None
    if task.get("client_id"):
        client_doc = await db.clients.find_one(
            {"id": task["client_id"]}, {"_id": 0, "company_name": 1}
        )
        if client_doc:
            client_name = client_doc.get("company_name")
        else:
            # Do not return a client reference that is outside this workspace.
            task["client_id"] = None
    if task.get("assigned_to") and task["assigned_to"] not in users_batch:
        task["assigned_to"] = None
    if isinstance(task.get("sub_assignees"), list):
        task["sub_assignees"] = [
            user_id for user_id in task["sub_assignees"] if user_id in users_batch
        ]
    else:
        task["sub_assignees"] = []
    task["assigned_to_name"] = (
        assigned_user.get("full_name", "Unknown") if assigned_user else "Unknown"
    )
    task["assigned_to_email"] = assigned_user.get("email") if assigned_user else None
    task["assigned_to_picture"] = (
        assigned_user.get("profile_picture") if assigned_user else None
    )
    task["created_by_name"] = (
        created_user.get("full_name", "Unknown") if created_user else "Unknown"
    )
    task["sub_assignee_names"] = sub_assignee_names
    task["client_name"] = client_name
    task["created_at"] = safe_dt(task.get("created_at"))
    task["updated_at"] = safe_dt(task.get("updated_at"))
    task["due_date"] = safe_dt(task.get("due_date"))
    if task.get("completed_at"):
        task["completed_at"] = safe_dt(task.get("completed_at"))
    return task


@api_router.get("/tasks/{task_id}", response_model=Task)
async def get_task(
    task_id: str, current_user: User = Depends(check_module_permission("tasks", "view"))
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if current_user.role == "admin":
        pass
    elif is_own_record(current_user, task):
        pass
    else:
        permissions = get_user_permissions(current_user)
        allowed_users = permissions.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        if task.get("assigned_to") not in allowed_users:
            raise HTTPException(status_code=403, detail="Not authorized")
    # Detail-by-ID must not echo an assignee/sub-assignee/client reference that
    # cannot be resolved inside the authenticated company's scope.
    related_user_ids = {
        str(value) for value in [
            task.get("assigned_to"),
            *(task.get("sub_assignees") or []),
        ] if value
    }
    related_users = await db.users.find(
        {"id": {"$in": list(related_user_ids)}}, {"_id": 0, "id": 1}
    ).to_list(len(related_user_ids) or 1)
    visible_user_ids = {user["id"] for user in related_users if user.get("id")}
    if task.get("assigned_to") and task["assigned_to"] not in visible_user_ids:
        task["assigned_to"] = None
    if isinstance(task.get("sub_assignees"), list):
        task["sub_assignees"] = [
            user_id for user_id in task["sub_assignees"] if user_id in visible_user_ids
        ]
    if task.get("client_id"):
        visible_client = await db.clients.find_one(
            {"id": task["client_id"]}, {"_id": 0, "id": 1}
        )
        if not visible_client:
            task["client_id"] = None
    return Task(**task)


@api_router.api_route("/tasks/{task_id}", methods=["PATCH", "PUT"], response_model=Task)
async def patch_task(
    task_id: str,
    updates: dict,
    # GLITCH FIX: previously gated behind check_module_permission("tasks", "edit"),
    # which required the universal `can_edit_tasks` flag for EVERYONE before the
    # request body was even fetched — so a user editing their OWN task (which
    # the ownership check below already allows) was wrongly 403'd whenever an
    # admin had turned their personal can_edit_tasks flag off. Per spec, every
    # user can edit their own task by default; ownership + cross-visibility are
    # checked below against the actual record instead of a blanket flag.
    current_user: User = Depends(get_current_user),
):
    existing_task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not existing_task:
        raise HTTPException(status_code=404, detail="Task not found")
    is_authorized = current_user.role.lower() == "admin" or is_own_record(
        current_user, existing_task
    )
    if not is_authorized:
        # GLITCH FIX: a user with cross-visibility to another user's tasks
        # (view_other_tasks) should also be able to edit/update those tasks,
        # not just view them.
        perms = get_user_permissions(current_user)
        allowed_users = perms.get("view_other_tasks", []) or []
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users = list(set(allowed_users + team_ids))
        if (
            existing_task.get("assigned_to") in allowed_users
            or existing_task.get("created_by") in allowed_users
        ):
            is_authorized = True
    if not is_authorized:
        raise HTTPException(status_code=403, detail="Unauthorized to modify this task")
    old_data = existing_task.copy()
    # Whitelist: prevent patching of immutable/sensitive fields
    IMMUTABLE_FIELDS = {
        "id", "created_by", "created_at", "_id", "company_id",
        "commercial_customer_id", "license_id", "licensee_uid", "identity_org_uid",
    }
    for field in IMMUTABLE_FIELDS:
        updates.pop(field, None)

    # Validate any changed relationship, regardless of whether the caller is
    # an admin. Admin permissions do not grant cross-tenant assignment rights.
    await _assert_task_tenant_references(
        current_user,
        assigned_to=updates.get("assigned_to") if "assigned_to" in updates else None,
        sub_assignees=updates.get("sub_assignees") if "sub_assignees" in updates else None,
        client_id=updates.get("client_id") if "client_id" in updates else None,
    )
    updates["updated_at"] = datetime.now(IST).isoformat()
    if updates.get("status") == "completed":
        updates["completed_at"] = datetime.now(IST).isoformat()
    await db.tasks.update_one({"id": task_id}, {"$set": updates})
    updated_task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    action_type = (
        "TASK_STATUS_CHANGED"
        if "status" in updates and old_data.get("status") != updates.get("status")
        else "UPDATE_TASK"
    )
    await create_audit_log(
        current_user=current_user,
        action=action_type,
        module="task",
        record_id=task_id,
        old_data=old_data,
        new_data=updates,
    )
    return Task(**updated_task)


@api_router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, current_user: User = Depends(get_current_user)):
    existing = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="Task not found")
    # Issue #7: use can_delete_tasks (not can_edit_tasks)
    # Issue #1: must also satisfy visibility (own or team)
    assert_module_permission(current_user, "tasks", "delete")
    team_ids = (
        await get_team_user_ids(current_user.id)
        if current_user.role == "manager"
        else []
    )
    assert_record_visibility(current_user, existing, team_ids)
    await db.tasks.delete_one({"id": task_id})
    await create_audit_log(
        current_user=current_user,
        action="DELETE_TASK",
        module="task",
        record_id=task_id,
        old_data=existing,
    )
    return {"message": "Task deleted successfully"}


@api_router.post("/tasks/{task_id}/comments")
async def add_task_comment(
    task_id: str, comment_data: dict, current_user: User = Depends(get_current_user)
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    is_involved = current_user.role.lower() == "admin" or is_own_record(
        current_user, task
    )
    if not is_involved:
        raise HTTPException(
            status_code=403,
            detail="Access denied: You must be involved in this task to comment.",
        )
    comment = {
        "id": str(uuid.uuid4()),
        "user_id": current_user.id,
        "user_name": current_user.full_name,
        "text": comment_data.get("text"),
        "created_at": datetime.now(IST).isoformat(),
    }
    await db.tasks.update_one({"id": task_id}, {"$push": {"comments": comment}})
    return comment


# =========================================================
# EXPORT TASK AUDIT LOG PDF
# =========================================================
@api_router.get("/tasks/{task_id}/export-log-pdf")
async def export_task_log_pdf(
    task_id: str, current_user: User = Depends(check_permission("can_view_audit_logs"))
):
    task = await db.tasks.find_one({"id": task_id}, {"_id": 0})
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    logs = (
        await db.audit_logs.find({"module": "task", "record_id": task_id}, {"_id": 0})
        .sort("timestamp", 1)
        .to_list(1000)
    )
    if not logs:
        raise HTTPException(status_code=404, detail="No audit logs found")
    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=10)
    pdf.add_page()
    pdf.set_font("Arial", "B", 16)
    pdf.cell(0, 10, "Task Lifecycle Report", ln=True, align="C")
    pdf.ln(5)
    pdf.set_font("Arial", "B", 12)
    pdf.cell(0, 8, "Task Information", ln=True)
    pdf.ln(3)
    pdf.set_font("Arial", size=11)
    pdf.multi_cell(0, 7, f"Title: {task.get('title', '-')}")
    pdf.multi_cell(0, 7, f"Description: {task.get('description', '-')}")
    pdf.multi_cell(
        0,
        7,
        f"Assigned To: {task.get('assigned_to_name', task.get('assigned_to', '-'))}",
    )
    pdf.multi_cell(
        0, 7, f"Created By: {task.get('created_by_name', task.get('created_by', '-'))}"
    )
    pdf.multi_cell(0, 7, f"Created At: {task.get('created_at', '-')}")
    pdf.multi_cell(0, 7, f"Current Status: {task.get('status', '-')}")
    pdf.ln(8)
    pdf.set_font("Arial", "B", 12)
    pdf.cell(0, 8, "Activity Timeline", ln=True)
    pdf.ln(4)
    pdf.set_font("Arial", size=10)
    for log in logs:
        timestamp = log.get("timestamp")
        if isinstance(timestamp, datetime):
            timestamp = timestamp.strftime("%b %d, %Y %I:%M %p")
        action = log.get("action", "UNKNOWN")
        user = log.get("user_name", "Unknown User")
        pdf.set_font("Arial", "B", 10)
        pdf.multi_cell(
            0, 6, f"{timestamp} — {action.replace('_', ' ').title()} by {user}"
        )
        pdf.set_font("Arial", size=10)
        if action == "TASK_STATUS_CHANGED":
            old_status = log.get("old_data", {}).get("status", "-")
            new_status = log.get("new_data", {}).get("status", "-")
            pdf.multi_cell(0, 6, f" Status changed: {old_status} -> {new_status}")
        elif action == "TASK_COMPLETED":
            pdf.multi_cell(0, 6, " Task marked as completed.")
        elif action == "DELETE_TASK":
            pdf.multi_cell(0, 6, " Task was deleted.")
        elif action == "CREATE_TASK":
            pdf.multi_cell(0, 6, " Task was created.")
        elif action == "UPDATE_TASK":
            pdf.multi_cell(0, 6, " Task details updated.")
        if log.get("old_data") and log.get("new_data"):
            old_data = log.get("old_data")
            new_data = log.get("new_data")
            for key in new_data:
                old_val = old_data.get(key)
                new_val = new_data.get(key)
                if old_val != new_val:
                    pdf.multi_cell(
                        0,
                        6,
                        f" {key.replace('_', ' ').title()}: {old_val} -> {new_val}",
                    )
        pdf.ln(3)
    pdf.ln(5)
    pdf.set_font("Arial", "I", 8)
    pdf.multi_cell(
        0, 5, f"Generated on {datetime.utcnow().strftime('%b %d, %Y %I:%M %p')} UTC"
    )
    output = BytesIO()
    output.write(pdf.output(dest="S").encode("latin1"))
    output.seek(0)
    return StreamingResponse(
        output,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f"attachment; filename=task_lifecycle_{task_id}.pdf"
        },
    )


# ═══════════════════════════════════════════════════════════════════════════════
# DSC ROUTES
# ═══════════════════════════════════════════════════════════════════════════════

