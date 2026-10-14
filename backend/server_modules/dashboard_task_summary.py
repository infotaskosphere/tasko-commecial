"""Tenant- and permission-scoped task data for the Dashboard.

The endpoint returns bounded, projected task rows for the visible Dashboard
lists and computes counts/trends in MongoDB instead of sending hundreds of
complete task documents to the browser.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException

from backend.dependencies import (
    check_module_permission,
    db,
    get_team_user_ids,
    get_user_permissions,
)


router = APIRouter()
IST = ZoneInfo("Asia/Kolkata")

_TASK_ROW_PROJECTION = {
    "_id": 0,
    "id": 1,
    "title": 1,
    "description": 1,
    "status": 1,
    "priority": 1,
    "category": 1,
    "assigned_to": 1,
    "created_by": 1,
    "sub_assignees": 1,
    "client_id": 1,
    "due_date": 1,
    "created_at": 1,
    "updated_at": 1,
}


def _and_query(*clauses: dict) -> dict:
    """Combine Mongo filters without overwriting their logical operators."""
    present = [clause for clause in clauses if clause]
    if not present:
        return {}
    if len(present) == 1:
        return present[0]
    return {"$and": present}


async def _task_scope(current_user) -> tuple[dict, list[str]]:
    """Mirror GET /tasks visibility and add an explicit company boundary."""
    company_id = str(getattr(current_user, "company_id", "") or "").strip()
    if not company_id:
        raise HTTPException(status_code=403, detail="A company workspace is required.")

    query = {
        "type": {"$ne": "todo"},
        "company_id": company_id,
    }
    allowed_users: list[str] = []

    if current_user.role != "admin":
        permissions = get_user_permissions(current_user)
        allowed_users = [
            str(user_id)
            for user_id in (permissions.get("view_other_tasks", []) or [])
            if user_id
        ]
        if current_user.role == "manager":
            team_ids = await get_team_user_ids(current_user.id)
            allowed_users.extend(str(user_id) for user_id in (team_ids or []) if user_id)
        allowed_users = list(dict.fromkeys(allowed_users))

        visible_task_owners = [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
            {"created_by": current_user.id},
        ]
        if allowed_users:
            visible_task_owners.extend(
                [
                    {"assigned_to": {"$in": allowed_users}},
                    {"created_by": {"$in": allowed_users}},
                ]
            )
        query["$or"] = visible_task_owners

    return query, allowed_users


def _date_conversion(field: str) -> dict:
    return {
        "$convert": {
            "input": f"${field}",
            "to": "date",
            "onError": None,
            "onNull": None,
        }
    }


def _is_recently_completed_clause(today_start_utc: datetime) -> dict:
    # Match the Dashboard's existing rule: completed tasks remain visible on
    # their completion day; an absent or invalid updated_at is not hidden.
    return {
        "$or": [
            {"status": {"$ne": "completed"}},
            {
                "$and": [
                    {"status": "completed"},
                    {
                        "$or": [
                            {"_dashboard_updated_at": {"$gte": today_start_utc}},
                            {"_dashboard_updated_at": None},
                        ]
                    },
                ]
            },
        ]
    }


async def _fetch_recent_rows(
    base_query: dict,
    extra_query: dict,
    today_start_utc: datetime,
    limit: int,
) -> list[dict]:
    pipeline = [
        {"$match": _and_query(base_query, extra_query)},
        {"$addFields": {"_dashboard_updated_at": _date_conversion("updated_at")}},
        {"$match": _is_recently_completed_clause(today_start_utc)},
        {"$sort": {"created_at": -1}},
        {"$limit": limit},
        # An inclusion projection naturally omits the temporary field; mixing
        # inclusion and exclusion flags in $project is invalid in MongoDB.
        {"$project": _TASK_ROW_PROJECTION},
    ]
    return await db.tasks.aggregate(pipeline).to_list(length=limit)


def _member_ids_expression() -> dict:
    assigned_id = {
        "$cond": [
            {
                "$and": [
                    {"$ne": ["$assigned_to", None]},
                    {"$ne": ["$assigned_to", ""]},
                ]
            },
            ["$assigned_to"],
            [],
        ]
    }
    sub_assignee_ids = {
        "$filter": {
            "input": {
                "$cond": [
                    {"$isArray": "$sub_assignees"},
                    "$sub_assignees",
                    [],
                ]
            },
            "as": "user_id",
            "cond": {
                "$and": [
                    {"$ne": ["$$user_id", None]},
                    {"$ne": ["$$user_id", ""]},
                ]
            },
        }
    }
    return {"$setUnion": [assigned_id, sub_assignee_ids]}


def _analytics_pipeline(
    task_query: dict,
    current_user_id: str,
    today_start_utc: datetime,
    tomorrow_start_utc: datetime,
    week_start_utc: datetime,
    now_utc: datetime,
) -> list[dict]:
    my_task_filter = {
        "$or": [
            {"assigned_to": current_user_id},
            {"sub_assignees": current_user_id},
        ]
    }
    overdue_expression = {
        "$and": [
            {"$ne": ["$_dashboard_due_at", None]},
            {"$lt": ["$_dashboard_due_at", now_utc]},
            {"$ne": ["$status", "completed"]},
        ]
    }
    day_key = {
        "$dateToString": {
            "format": "%Y-%m-%d",
            "date": "$_dashboard_created_at",
            "timezone": "Asia/Kolkata",
        }
    }
    completed_day_key = {
        "$dateToString": {
            "format": "%Y-%m-%d",
            "date": "$_dashboard_updated_at",
            "timezone": "Asia/Kolkata",
        }
    }

    return [
        {"$match": task_query},
        {
            "$addFields": {
                "_dashboard_created_at": _date_conversion("created_at"),
                "_dashboard_updated_at": _date_conversion("updated_at"),
                "_dashboard_due_at": _date_conversion("due_date"),
            }
        },
        {
            "$facet": {
                "totals": [
                    {
                        "$group": {
                            "_id": None,
                            "total_task_count": {"$sum": 1},
                            "completed_task_count": {
                                "$sum": {
                                    "$cond": [
                                        {"$eq": ["$status", "completed"]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "pending_task_count": {
                                "$sum": {
                                    "$cond": [
                                        {"$eq": ["$status", "pending"]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "overdue_task_count": {"$sum": {"$cond": [overdue_expression, 1, 0]}},
                        }
                    }
                ],
                "my_totals": [
                    {"$match": my_task_filter},
                    {
                        "$group": {
                            "_id": None,
                            "my_task_count": {"$sum": 1},
                            "my_completed_task_count": {
                                "$sum": {
                                    "$cond": [
                                        {"$eq": ["$status", "completed"]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                            "my_overdue_count": {
                                "$sum": {"$cond": [overdue_expression, 1, 0]}
                            },
                        }
                    },
                ],
                "today_new": [
                    {"$match": my_task_filter},
                    {
                        "$match": {
                            "_dashboard_created_at": {
                                "$gte": today_start_utc,
                                "$lt": tomorrow_start_utc,
                            }
                        }
                    },
                    {"$count": "count"},
                ],
                "created_trend": [
                    {
                        "$match": {
                            "_dashboard_created_at": {
                                "$gte": week_start_utc,
                                "$lt": now_utc,
                            }
                        }
                    },
                    {"$group": {"_id": day_key, "count": {"$sum": 1}}},
                ],
                "completed_trend": [
                    {"$match": {"status": "completed"}},
                    {
                        "$match": {
                            "_dashboard_updated_at": {
                                "$gte": week_start_utc,
                                "$lt": now_utc,
                            }
                        }
                    },
                    {"$group": {"_id": completed_day_key, "count": {"$sum": 1}}},
                ],
                "assigned_user_ids": [
                    {"$match": {"assigned_to": {"$nin": [None, ""]}}},
                    {"$group": {"_id": "$assigned_to"}},
                ],
                "member_counts": [
                    {
                        "$project": {
                            "status": 1,
                            "_dashboard_member_ids": _member_ids_expression(),
                        }
                    },
                    {"$unwind": "$_dashboard_member_ids"},
                    {
                        "$group": {
                            "_id": "$_dashboard_member_ids",
                            "pending_count": {
                                "$sum": {
                                    "$cond": [
                                        {"$ne": ["$status", "completed"]},
                                        1,
                                        0,
                                    ]
                                }
                            },
                        }
                    },
                ],
            }
        },
    ]


async def _enrich_task_rows(rows: list[dict]) -> list[dict]:
    user_ids = set()
    for row in rows:
        related_ids = [row.get("assigned_to"), row.get("created_by")]
        sub_assignees = row.get("sub_assignees")
        if isinstance(sub_assignees, list):
            related_ids.extend(sub_assignees)
        user_ids.update(str(value) for value in related_ids if value)
    client_ids = {str(row["client_id"]) for row in rows if row.get("client_id")}

    users, clients = await asyncio.gather(
        db.users.find(
            {"id": {"$in": list(user_ids)}},
            {"_id": 0, "id": 1, "full_name": 1},
        ).to_list(length=len(user_ids))
        if user_ids
        else asyncio.sleep(0, result=[]),
        db.clients.find(
            {"id": {"$in": list(client_ids)}},
            {"_id": 0, "id": 1, "company_name": 1},
        ).to_list(length=len(client_ids))
        if client_ids
        else asyncio.sleep(0, result=[]),
    )
    user_names = {
        str(user["id"]): user.get("full_name", "Unknown")
        for user in users
        if user.get("id")
    }
    client_names = {
        str(client["id"]): client.get("company_name")
        for client in clients
        if client.get("id")
    }

    enriched = []
    for row in rows:
        task = dict(row)
        if task.get("assigned_to"):
            task["assigned_to"] = str(task["assigned_to"])
            if task["assigned_to"] not in user_names:
                task["assigned_to"] = None
        task["assigned_to_name"] = user_names.get(
            task.get("assigned_to"), "Unassigned"
        )
        if task.get("created_by"):
            task["created_by"] = str(task["created_by"])
        task["created_by_name"] = user_names.get(
            task.get("created_by"), "Unknown"
        )
        raw_sub_assignees = task.get("sub_assignees")
        task["sub_assignees"] = [
            str(user_id)
            for user_id in (raw_sub_assignees if isinstance(raw_sub_assignees, list) else [])
            if str(user_id) in user_names
        ]
        if task.get("client_id"):
            task["client_id"] = str(task["client_id"])
            if task["client_id"] not in client_names:
                task["client_id"] = None
        task["client_name"] = client_names.get(task.get("client_id"))
        enriched.append(task)
    return enriched


@router.get("/dashboard/task-summary")
async def get_dashboard_task_summary(
    current_user=Depends(check_module_permission("tasks", "view")),
):
    """Return bounded Dashboard task rows plus exact scope-aware aggregates."""
    task_query, allowed_users = await _task_scope(current_user)
    now_utc = datetime.now(timezone.utc)
    now_ist = now_utc.astimezone(IST)
    today_start_ist = datetime.combine(now_ist.date(), time.min, tzinfo=IST)
    tomorrow_start_ist = today_start_ist + timedelta(days=1)
    today_start_utc = today_start_ist.astimezone(timezone.utc)
    tomorrow_start_utc = tomorrow_start_ist.astimezone(timezone.utc)
    week_start_utc = (today_start_ist - timedelta(days=6)).astimezone(timezone.utc)

    my_task_filter = {
        "$or": [
            {"assigned_to": current_user.id},
            {"sub_assignees": current_user.id},
        ]
    }
    aggregate_result, recent_rows, assigned_rows, created_rows = await asyncio.gather(
        db.tasks.aggregate(
            _analytics_pipeline(
                task_query,
                str(current_user.id),
                today_start_utc,
                tomorrow_start_utc,
                week_start_utc,
                now_utc,
            )
        ).to_list(length=1),
        _fetch_recent_rows(task_query, {}, today_start_utc, 5),
        _fetch_recent_rows(
            task_query,
            {"assigned_to": current_user.id},
            today_start_utc,
            6,
        ),
        _fetch_recent_rows(
            task_query,
            _and_query(
                {"created_by": current_user.id},
                {"assigned_to": {"$ne": current_user.id}},
            ),
            today_start_utc,
            6,
        ),
    )

    facets = aggregate_result[0] if aggregate_result else {}
    totals = (facets.get("totals") or [{}])[0]
    my_totals = (facets.get("my_totals") or [{}])[0]
    assigned_user_ids = list(
        dict.fromkeys(
            str(item["_id"])
            for item in (facets.get("assigned_user_ids") or [])
            if item.get("_id") not in (None, "")
        )
    )

    # Resolve all member IDs through the authenticated user's tenant-aware
    # users collection before returning IDs or using them in team counts.
    requested_member_ids = (
        assigned_user_ids
        if current_user.role == "admin"
        else allowed_users
    )
    candidate_member_ids = list(
        dict.fromkeys([str(current_user.id), *requested_member_ids])
    )
    member_docs = (
        await db.users.find(
            {"id": {"$in": candidate_member_ids}},
            {"_id": 0, "id": 1},
        ).to_list(length=len(candidate_member_ids))
        if candidate_member_ids
        else []
    )
    valid_member_ids = {
        str(member["id"]) for member in member_docs if member.get("id")
    }
    valid_member_ids.add(str(current_user.id))
    visible_team_ids = [str(current_user.id)] + [
        user_id
        for user_id in dict.fromkeys(requested_member_ids)
        if user_id != str(current_user.id) and user_id in valid_member_ids
    ]

    team_task_total = 0
    if visible_team_ids:
        team_task_total = await db.tasks.count_documents(
            _and_query(
                task_query,
                {"status": {"$ne": "completed"}},
                {
                    "$or": [
                        {"assigned_to": {"$in": visible_team_ids}},
                        {"sub_assignees": {"$in": visible_team_ids}},
                    ]
                },
            )
        )

    member_counts = {
        str(item["_id"]): int(item.get("pending_count") or 0)
        for item in (facets.get("member_counts") or [])
        if item.get("_id") not in (None, "")
    }
    team_task_breakdown = [
        {"user_id": user_id, "pending_count": member_counts.get(user_id, 0)}
        for user_id in visible_team_ids
        if member_counts.get(user_id, 0) > 0
    ]

    created_by_day = {
        str(item["_id"]): int(item.get("count") or 0)
        for item in (facets.get("created_trend") or [])
        if item.get("_id")
    }
    completed_by_day = {
        str(item["_id"]): int(item.get("count") or 0)
        for item in (facets.get("completed_trend") or [])
        if item.get("_id")
    }
    weekly_trend = []
    for offset in range(6, -1, -1):
        day = now_ist.date() - timedelta(days=offset)
        day_key = day.isoformat()
        weekly_trend.append(
            {
                "date": day_key,
                "created": created_by_day.get(day_key, 0),
                "completed": completed_by_day.get(day_key, 0),
            }
        )

    task_rows = await _enrich_task_rows(
        [*recent_rows, *assigned_rows, *created_rows]
    )
    row_by_id = {str(row.get("id")): row for row in task_rows if row.get("id")}
    row_groups = {
        "recent_tasks": recent_rows,
        "assigned_to_me": assigned_rows,
        "assigned_by_me": created_rows,
    }
    result = {
        key: [
            row_by_id[str(row.get("id"))]
            for row in rows
            if row.get("id") and str(row.get("id")) in row_by_id
        ]
        for key, rows in row_groups.items()
    }
    result.update(
        {
            "total_task_count": int(totals.get("total_task_count") or 0),
            "completed_task_count": int(totals.get("completed_task_count") or 0),
            "pending_task_count": int(totals.get("pending_task_count") or 0),
            "overdue_task_count": int(totals.get("overdue_task_count") or 0),
            "my_task_count": int(my_totals.get("my_task_count") or 0),
            "my_completed_task_count": int(
                my_totals.get("my_completed_task_count") or 0
            ),
            "my_overdue_count": int(my_totals.get("my_overdue_count") or 0),
            "today_new_task_count": int(
                (facets.get("today_new") or [{}])[0].get("count") or 0
            ),
            "team_task_total": int(team_task_total),
            "team_task_breakdown": team_task_breakdown,
            "assigned_user_ids": [
                user_id
                for user_id in assigned_user_ids
                if user_id in valid_member_ids and user_id != str(current_user.id)
            ],
            "weekly_trend": weekly_trend,
        }
    )
    return result
