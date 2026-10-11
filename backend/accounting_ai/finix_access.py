"""Shared role/permission normalization for Finix AI endpoints.

FastAPI authentication returns UserRole enum members in production. Comparing
str(user.role) with "admin" is incorrect for str/Enum roles on Python 3.12
(the value renders as UserRole.admin). Keep the decision consistent across
Finix proposal, posting, and reconciliation routes.
"""
from __future__ import annotations

from typing import Any


def role_key(user: Any) -> str:
    role = getattr(user, "role", "")
    for candidate in (getattr(role, "value", None), getattr(role, "name", None), role):
        normalized = str(candidate or "").strip().lower()
        if normalized:
            return normalized.rsplit(".", 1)[-1]
    return ""


def is_admin_role(user: Any) -> bool:
    return role_key(user) == "admin"


def permissions_dict(user: Any) -> dict:
    permissions = getattr(user, "permissions", None)
    if isinstance(permissions, dict):
        return permissions
    if permissions is not None and hasattr(permissions, "model_dump"):
        try:
            dumped = permissions.model_dump()
            return dumped if isinstance(dumped, dict) else {}
        except Exception:
            return {}
    return {}


def can_view_finix(user: Any) -> bool:
    if is_admin_role(user):
        return True
    permissions = permissions_dict(user)
    return any(
        bool(permissions.get(flag))
        for flag in (
            "can_view_accounting_reports",
            "can_view_journal_entries",
            "can_post_journal_entries",
        )
    )


def can_view_finix_reconciliation(user: Any) -> bool:
    if is_admin_role(user):
        return True
    permissions = permissions_dict(user)
    return any(
        bool(permissions.get(flag))
        for flag in (
            "can_view_journal_entries",
            "can_view_accounting_reports",
            "can_post_journal_entries",
            "can_view_bank",
        )
    )


def can_post_finix(user: Any) -> bool:
    return is_admin_role(user) or bool(
        permissions_dict(user).get("can_post_journal_entries")
    )
