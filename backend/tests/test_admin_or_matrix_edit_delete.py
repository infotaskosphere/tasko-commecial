"""Edit/delete is admin-only unless Permission Matrix grants it.

Covers Finix (licensee tenants and the Platform Owner's own books) and the
Platform Owner console (licensees, licenses, installations, settings).
"""
import ast
import pathlib

import pytest
from fastapi import HTTPException

from backend.finix_action_permissions import has_finix_action_permission, require_finix_action
from backend.modules.people_matrix.models_users import User
from backend.platform_owner import is_platform_owner, is_platform_owner_admin
from backend.platform_owner_actions import has_platform_owner_action, require_platform_owner_action

ROOT = pathlib.Path(__file__).resolve().parents[2]
OWNER_CO = "platform-owner-48fe785fdd75127f"


def make_user(role="staff", permissions=None, **extra):
    data = {"id": f"u-{role}", "email": f"{role}@example.test", "role": role,
            "permissions": permissions or {}, **extra}
    return User.model_validate(data)


def owner_admin():
    return make_user("admin", company_id=OWNER_CO, identity_type="platform_owner_admin",
                     is_platform_owner=True, platform_owner_uid="PO-000001")


def owner_staff(permissions=None):
    return make_user("staff", permissions, company_id=OWNER_CO, identity_type="platform_owner_user",
                     is_platform_owner=True, platform_owner_uid="PO-000001")


def licensee_admin(pages=("can_view_sale",)):
    return make_user("admin", {"can_access_finix": True, **{p: True for p in pages}},
                     company_id="cust-1", commercial_customer_id="cust-1", license_id="lic-1",
                     identity_type="licensee_admin", licensed_modules=["finix"],
                     selected_features={"finix": list(pages)})


def licensee_staff(matrix=None, pages=("can_view_sale",)):
    perms = {"can_access_finix": True, **{p: True for p in pages}, "governance_matrix": matrix or {}}
    return make_user("staff", perms, company_id="cust-1", commercial_customer_id="cust-1",
                     license_id="lic-1", identity_type="licensee_user", licensed_modules=["finix"],
                     selected_features={"finix": list(pages)})


# ── Identity ────────────────────────────────────────────────────────────────

def test_owner_staff_is_owner_but_not_owner_admin():
    assert is_platform_owner(owner_staff())
    assert not is_platform_owner_admin(owner_staff())
    assert is_platform_owner_admin(owner_admin())


def test_reserved_owner_email_is_owner_admin_even_without_admin_role():
    user = make_user("staff", email="info.taskosphere@gmail.com")
    assert is_platform_owner_admin(user)


# ── Finix ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("action", ["edit", "delete"])
def test_owner_admin_can_edit_and_delete_everything(action):
    for page in ("can_view_sale", "can_view_purchase", "can_view_bank", "can_view_journal_entries"):
        assert has_finix_action_permission(owner_admin(), page, action)


@pytest.mark.parametrize("action", ["edit", "delete"])
def test_owner_staff_needs_permission_matrix(action):
    viewer = owner_staff({"can_access_finix": True, "can_view_sale": True,
                          "governance_matrix": {"finix.can_view_sale": ["view"]}})
    assert not has_finix_action_permission(viewer, "can_view_sale", action)
    with pytest.raises(HTTPException) as exc:
        require_finix_action(viewer, "can_view_sale", action)
    assert exc.value.status_code == 403 and "Permission Matrix" in exc.value.detail

    granted = owner_staff({"can_access_finix": True, "can_view_sale": True,
                           "governance_matrix": {"finix.can_view_sale": ["view", action]}})
    assert has_finix_action_permission(granted, "can_view_sale", action)
    other = "delete" if action == "edit" else "edit"
    assert not has_finix_action_permission(granted, "can_view_sale", other)


def test_owner_staff_grant_requires_page_access():
    no_page = owner_staff({"can_access_finix": True, "can_view_sale": False,
                           "governance_matrix": {"finix.can_view_sale": ["edit", "delete"]}})
    assert not has_finix_action_permission(no_page, "can_view_sale", "delete")


def test_licensee_admin_full_inside_licensed_pages_only():
    admin = licensee_admin(pages=("can_view_sale",))
    assert has_finix_action_permission(admin, "can_view_sale", "delete")
    assert has_finix_action_permission(admin, "can_view_sale", "edit")
    assert not has_finix_action_permission(admin, "can_view_purchase", "delete")


def test_licensee_staff_needs_permission_matrix():
    assert not has_finix_action_permission(licensee_staff(), "can_view_sale", "delete")
    granted = licensee_staff({"finix.can_view_sale": ["view", "delete"]})
    assert has_finix_action_permission(granted, "can_view_sale", "delete")
    assert not has_finix_action_permission(granted, "can_view_sale", "edit")


def test_licensee_staff_grant_is_capped_by_license():
    staff = licensee_staff({"finix.can_view_purchase": ["delete"]}, pages=("can_view_sale",))
    staff.permissions.governance_matrix["finix.can_view_purchase"] = ["delete"]
    assert not has_finix_action_permission(staff, "can_view_purchase", "delete")


def test_manager_is_not_an_admin():
    manager = make_user("manager", {"can_access_finix": True, "can_view_sale": True})
    assert not has_finix_action_permission(manager, "can_view_sale", "edit")


def test_only_edit_and_delete_are_decided_here():
    assert not has_finix_action_permission(owner_admin(), "can_view_sale", "view")


# ── Platform Owner console ──────────────────────────────────────────────────

def test_console_owner_admin_allowed_staff_needs_grant_licensee_never():
    page = "can_view_platform_licenses"
    assert has_platform_owner_action(owner_admin(), page, "edit")
    assert not has_platform_owner_action(owner_staff(), page, "edit")
    granted = owner_staff({"governance_matrix": {f"platform_console.{page}": ["view", "edit"]}})
    assert has_platform_owner_action(granted, page, "edit")
    assert not has_platform_owner_action(granted, page, "delete")
    assert not has_platform_owner_action(licensee_admin(), page, "edit")
    with pytest.raises(HTTPException) as exc:
        require_platform_owner_action(licensee_admin(), page, "delete")
    assert exc.value.status_code == 403


# ── Route contract: every mutation is gated ────────────────────────────────

def _routes(path):
    src = (ROOT / path).read_text()
    tree = ast.parse(src)
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if isinstance(dec, ast.Call) and isinstance(dec.func, ast.Attribute) and dec.func.attr in {"put", "patch", "delete"}:
                yield node.name, ast.get_source_segment(src, node)


FINIX_FILES = [
    "backend/invoicing.py", "backend/purchases.py", "backend/bank_accounts.py",
    "backend/accounting_core.py", "backend/party_ledgers.py", "backend/gst_portal_sync.py",
]


@pytest.mark.parametrize("path", FINIX_FILES)
def test_every_finix_put_patch_delete_route_is_gated(path):
    ungated = [name for name, body in _routes(path) if "require_finix_action" not in body]
    assert ungated == [], f"{path}: ungated edit/delete routes {ungated}"


OWNER_GATED = {
    "backend/commercial_customer_directory.py": {"update_commercial_customer", "update_commercial_license"},
    "backend/licensing_api.py": {"update_license_status", "upgrade_license", "save_package", "revoke_installation"},
    "backend/commercial_onboarding.py": {"update_custom_module_catalog", "delete_commercial_company"},
    "backend/commercial_onboarding_extensions.py": {"update_custom_module_catalog", "delete_commercial_company"},
    "backend/commercial_console_api.py": {"update_omni_settings", "delete_domain", "update_email_config",
                                         "update_email_template", "update_recovery_settings",
                                         "update_licensee_email_settings"},
    "backend/commercial_master_data.py": {"update_platform_company_user", "delete_platform_company_user"},
}


@pytest.mark.parametrize("path,names", OWNER_GATED.items())
def test_owner_console_mutations_are_gated(path, names):
    src = (ROOT / path).read_text()
    tree = ast.parse(src)
    bodies = {n.name: ast.get_source_segment(src, n) for n in ast.walk(tree)
              if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    for name in names:
        assert "require_platform_owner_action" in bodies[name], f"{path}:{name} is not gated"
