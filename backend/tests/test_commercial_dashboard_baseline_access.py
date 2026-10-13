"""Regression tests for the licensee dashboard baseline entitlement."""

from types import SimpleNamespace

from backend import commercial_module_guard as guard


def _licensee_admin():
    return SimpleNamespace(
        role=SimpleNamespace(value="admin"),
        identity_type="licensee_admin",
        permissions={},
    )


def test_taskosphere_dashboard_is_available_to_licensee_admin_with_enabled_pages(monkeypatch):
    selected_pages = {"can_view_tasks", "can_view_attendance", "can_view_reminders"}
    monkeypatch.setattr(
        guard,
        "_selected_license_features",
        lambda license_doc, module: selected_pages if module == "taskosphere" else set(),
    )

    allowed = guard._permission_flag(
        _licensee_admin(),
        "can_view_dashboard",
        {"id": "license-1"},
        "taskosphere",
    )

    assert allowed is True


def test_taskosphere_dashboard_remains_closed_when_no_taskosphere_pages_are_enabled(monkeypatch):
    monkeypatch.setattr(guard, "_selected_license_features", lambda license_doc, module: set())

    allowed = guard._permission_flag(
        _licensee_admin(),
        "can_view_dashboard",
        {"id": "license-1"},
        "taskosphere",
    )

    assert allowed is False


def test_unselected_taskosphere_pages_remain_restricted_for_licensee_admin(monkeypatch):
    monkeypatch.setattr(
        guard,
        "_selected_license_features",
        lambda license_doc, module: {"can_view_tasks"},
    )

    allowed = guard._permission_flag(
        _licensee_admin(),
        "can_view_attendance",
        {"id": "license-1"},
        "taskosphere",
    )

    assert allowed is False
