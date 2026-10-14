"""Regression checks for the Dashboard's bounded, tenant-scoped task payload."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.server_modules import dashboard_task_summary as task_summary


def test_admin_task_scope_stays_inside_the_authenticated_company():
    user = SimpleNamespace(id="owner-admin", company_id="company-owner", role="admin")

    query, allowed_users = asyncio.run(task_summary._task_scope(user))

    assert query["company_id"] == "company-owner"
    assert query["type"] == {"$ne": "todo"}
    assert "$or" not in query
    assert allowed_users == []


def test_staff_scope_preserves_own_and_explicit_cross_visibility(monkeypatch):
    user = SimpleNamespace(
        id="staff-1",
        company_id="company-1",
        role="staff",
        permissions={"view_other_tasks": ["staff-2", "staff-2"]},
    )
    monkeypatch.setattr(task_summary, "get_user_permissions", lambda current: current.permissions)

    query, allowed_users = asyncio.run(task_summary._task_scope(user))

    assert query["company_id"] == "company-1"
    assert query["type"] == {"$ne": "todo"}
    assert allowed_users == ["staff-2"]
    assert query["$or"] == [
        {"assigned_to": "staff-1"},
        {"sub_assignees": "staff-1"},
        {"created_by": "staff-1"},
        {"assigned_to": {"$in": ["staff-2"]}},
        {"created_by": {"$in": ["staff-2"]}},
    ]


def test_manager_team_ids_are_added_without_widening_company_scope(monkeypatch):
    user = SimpleNamespace(
        id="manager-1",
        company_id="company-1",
        role="manager",
        permissions={"view_other_tasks": ["staff-2"]},
    )
    monkeypatch.setattr(task_summary, "get_user_permissions", lambda current: current.permissions)

    async def team_ids(_manager_id):
        return ["staff-3", "staff-2"]

    monkeypatch.setattr(task_summary, "get_team_user_ids", team_ids)
    query, allowed_users = asyncio.run(task_summary._task_scope(user))

    assert query["company_id"] == "company-1"
    assert allowed_users == ["staff-2", "staff-3"]
    assert {"assigned_to": {"$in": ["staff-2", "staff-3"]}} in query["$or"]
    assert {"created_by": {"$in": ["staff-2", "staff-3"]}} in query["$or"]


def test_task_summary_fails_closed_without_authenticated_company():
    user = SimpleNamespace(id="staff-1", company_id=None, role="staff")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(task_summary._task_scope(user))

    assert exc.value.status_code == 403


def test_analytics_starts_with_scoped_match_and_returns_bounded_facets():
    scope = {"company_id": "company-1", "type": {"$ne": "todo"}}
    now = datetime.now(timezone.utc)
    pipeline = task_summary._analytics_pipeline(
        scope,
        "staff-1",
        now,
        now,
        now,
        now,
    )

    assert pipeline[0] == {"$match": scope}
    facets = pipeline[-1]["$facet"]
    assert {
        "totals",
        "my_totals",
        "today_new",
        "created_trend",
        "completed_trend",
        "assigned_user_ids",
        "member_counts",
    } == set(facets)
    assert facets["totals"][0]["$group"]["total_task_count"] == {"$sum": 1}
    assert facets["created_trend"][0]["$match"]["_dashboard_created_at"]["$gte"] == now


def test_recent_completed_filter_keeps_today_and_unknown_dates():
    start_of_today = datetime(2026, 10, 14, tzinfo=timezone.utc)

    clause = task_summary._is_recently_completed_clause(start_of_today)

    branches = clause["$or"]
    assert branches[0] == {"status": {"$ne": "completed"}}
    assert branches[1]["$and"][0] == {"status": "completed"}
    assert {"_dashboard_updated_at": {"$gte": start_of_today}} in branches[1]["$and"][1]["$or"]
    assert {"_dashboard_updated_at": None} in branches[1]["$and"][1]["$or"]
