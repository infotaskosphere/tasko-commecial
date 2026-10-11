"""Focused role normalization tests for Finix AI access decisions."""
from types import SimpleNamespace

from backend.accounting_ai.finix_access import (
    can_post_finix,
    can_view_finix,
    can_view_finix_reconciliation,
    is_admin_role,
    role_key,
)
from backend.modules.people_matrix.models_users import UserRole


def test_admin_enum_is_recognized_consistently():
    user = SimpleNamespace(role=UserRole.admin, permissions={})

    assert role_key(user) == "admin"
    assert is_admin_role(user)
    assert can_view_finix(user)
    assert can_view_finix_reconciliation(user)
    assert can_post_finix(user)


def test_legacy_admin_role_string_is_normalized():
    user = SimpleNamespace(role="UserRole.admin", permissions={})

    assert role_key(user) == "admin"
    assert can_view_finix(user)
    assert can_post_finix(user)


def test_non_admin_still_requires_explicit_finix_permissions():
    denied = SimpleNamespace(role=UserRole.manager, permissions={})
    viewer = SimpleNamespace(
        role=UserRole.manager,
        permissions={"can_view_accounting_reports": True},
    )
    poster = SimpleNamespace(
        role=UserRole.manager,
        permissions={"can_post_journal_entries": True},
    )

    assert not is_admin_role(denied)
    assert not can_view_finix(denied)
    assert not can_post_finix(denied)
    assert can_view_finix(viewer)
    assert not can_post_finix(viewer)
    assert can_view_finix_reconciliation(poster)
    assert can_post_finix(poster)
