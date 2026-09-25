"""Canonical Taskosphere dashboard and performance metric models."""
from typing import List, Optional
from pydantic import BaseModel

# DASHBOARD & METRICS
# ======================
# DASHBOARD & METRICS
# ======================
class DashboardStats(BaseModel):
    total_tasks: int
    completed_tasks: int
    pending_tasks: int
    overdue_tasks: int
    total_dsc: int
    expiring_dsc_count: int
    expiring_dsc_list: List[dict]
    total_clients: int
    upcoming_birthdays: int
    upcoming_due_dates: int
    team_workload: List[dict]
    compliance_status: dict
    expired_dsc_count: int = 0


class PerformanceMetric(BaseModel):
    user_id: str
    user_name: str
    profile_picture: Optional[str] = None
    attendance_percent: float = 0.0
    total_hours: float = 0.0
    task_completion_percent: float = 0.0
    todo_ontime_percent: float = 0.0
    timely_punchin_percent: float = 0.0
    overall_score: float = 0.0
    rank: int = 0
    badge: str = "Good Performer"
    # New ranking fields
    attendance_score: float = 0.0
    task_completion_score: float = 0.0
    task_timeliness_score: float = 0.0
    working_hours_score: float = 0.0
    quality_score: float = 0.0
    consistency_bonus: float = 0.0
    no_auto_absent_bonus: float = 0.0
    discipline_penalty: float = 0.0
    auto_absent_count: int = 0
    final_score: float = 0.0
    # Work-hours bonus: extra hours logged beyond the monthly target are
    # converted into bonus points. They ONLY add to the score and can never
    # reduce the base Work Hours points.
    extra_hours: float = 0.0
    bonus_points: float = 0.0


# ======================
