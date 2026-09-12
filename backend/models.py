import uuid
import re
from datetime import datetime, date, timedelta, timezone
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, model_validator, Field, ConfigDict, EmailStr, field_validator
from enum import Enum

# Timezone Configuration
india_tz = timezone(timedelta(hours=5, minutes=30))

# ────────────────────────────────────────────────
# ROLE ENUM
# ────────────────────────────────────────────────
class UserRole(str, Enum):
    admin = "admin"
    manager = "manager"
    staff = "staff"

# ────────────────────────────────────────────────
# DEFAULT ROLE PERMISSION TEMPLATES
# ────────────────────────────────────────────────
DEFAULT_ROLE_PERMISSIONS: Dict[str, Dict[str, Any]] = {
      "admin": {
          # Admin has GLOBAL scope with ALL permissions (VIEW CREATE EDIT DELETE UPDATE)
          "can_view_tasks": True,            # GATE: access /tasks endpoint
          "can_view_clients": True,           # GATE: access /clients endpoint
          "can_view_all_tasks": True,
          "can_view_all_clients": True,
          "can_view_all_dsc": True,
          "can_view_documents": True,
          "can_view_all_duedates": True,
          "can_view_reports": True,
          "can_view_attendance": True,
          "can_view_all_leads": True,
          "can_edit_tasks": True,
          "can_edit_clients": True,
          "can_approve_clients": True,
          "can_edit_dsc": True,
          "can_edit_documents": True,
          "can_edit_due_dates": True,
          "can_edit_users": True,
          "can_download_reports": True,
          "can_manage_users": True,
          "can_manage_settings": True,
          "can_assign_tasks": True,
          "can_assign_clients": True,
          "can_view_staff_activity": True,
          "can_send_reminders": True,
          "can_receive_popup_reminders": True,   # Admin always gets popup reminders
          "can_view_user_page": True,
          "can_view_audit_logs": True,
          "can_view_selected_users_reports": True,
          "can_view_todo_dashboard": True,
          "can_view_dashboard": True,
          "can_view_reminders": True,
          "can_view_action_center": True,
          "can_view_client_visits": True,
          "can_view_ai_document_reader": True,
          "can_use_chat": True,
          "can_view_staff_rankings": True,
          "can_delete_data": True,
          "can_delete_tasks": True,
          "can_connect_email": True,
          "can_view_own_data": True,
          "can_create_quotations": True,
          "can_manage_invoices": True,
          "can_view_passwords": True,
          "can_edit_passwords": True,
          "view_password_departments": [],   # empty = all (admin sees everything)
          "can_view_compliance": True,       # Compliance Tracker — view all categories
          "can_manage_compliance": True,     # Create / edit / delete compliance masters
          "can_view_gst_reconciliation": True,  # GST Reconciliation — admin always has access
          "can_view_trademark_sphere": True,    # Trademark Sphere — admin always has access
          "can_view_mis_report": True,        # MIS Report — admin always has access
          "can_manage_mis_report": True,      # MIS Report — upload / create / delete data
          "can_view_salary_slips": True,        # Salary Slip Generator — admin always has access
          "can_manage_salary_slips": True,
          "can_view_roc_sphere": True,           # ROC Sphere — admin always has access
          "can_manage_roc_sphere": True,         # ROC Sphere — create/edit/delete company masters & generate documents
          "can_access_whatsapp_hub": True,    # WhatsApp Hub
          "can_view_all_visits": True,
          "can_edit_attendance": True,
          "can_edit_visits": True,
          "can_delete_visits": True,
          "can_delete_own_visits": True,
          "view_other_visits": [],
          "view_other_tasks": [],
          "view_other_attendance": [],
          "view_other_reports": [],
          "view_other_todos": [],
          "view_other_activity": [],
          "can_access_whatsapp_hub": True,     # ADMIN_GRANTED_ONLY
          "can_view_recruitment": True,          # Admin always has recruitment access
          "can_manage_recruitment": True,        # Admin always has recruitment access
          "assigned_clients": [],
          # ── Accounts module governance (Bank / Chart of Accounts / Journal) ──
          # Admin has full access by default. Manager/staff must be granted
          # these explicitly by an admin via the Permission Governance portal
          # (Users → Permission Governance → approve an access request).
          "can_view_purchase": True,
          "can_view_sale": True,
          "can_view_bank": True,
          "can_view_chart_of_accounts": True,
          "can_manage_chart_of_accounts": True,
          "can_view_journal_entries": True,
          "can_post_journal_entries": True,
          "can_view_accounting_reports": True,
          "can_match_bank": True,          # Match / Edit Match / Unmatch bank reconciliations
          # ── Main permission module hierarchy — admin has every module on ──
          "can_access_taskosphere": True,
          "can_access_finix": True,
          "can_access_compliance": True,
          "can_access_records": True,
          "can_access_proposals": True,
          "can_access_people_matrix": True,
          "can_view_client_portal": True,
          "can_reset_client_passwords": True,
      },
      "manager": {
          # Manager: SCOPE = OWN + SAME_DEPARTMENT (Own + Team)
          # CROSS_VISIBILITY = SAME_DEPARTMENT_USERS
          # DEFAULT: Only modules explicitly listed in the Manager permission spec are ON.
          # Everything else is ADMIN_GRANTED_ONLY.
          # DATA_ACCESS_RULE: resource.department == user.department
          #   AND (resource.user_id == user.id OR resource.user_id IN SAME_DEPARTMENT_USERS)
          "can_view_tasks": True,            # GATE: access /tasks endpoint (scope handled server-side)
          "can_view_clients": True,          # GATE: access /clients endpoint (scope handled server-side)
          "can_view_all_tasks": False,       # SCOPE handled server-side by department query
          "can_view_all_clients": False,     # ADMIN_GRANTED_ONLY
          "can_view_all_dsc": False,         # ADMIN_GRANTED_ONLY
          "can_view_documents": False,       # ADMIN_GRANTED_ONLY
          "can_view_all_duedates": True,     # Compliance Calendar → VIEW (Own + Team)
          "can_view_reports": True,          # Reports → VIEW (Own + Team)
          "can_view_attendance": True,       # Attendance → VIEW (Own + Team)
          "can_view_all_leads": False,       # ADMIN_GRANTED_ONLY (Leads Pipeline not in default spec)
          "can_edit_tasks": True,            # Tasks → EDIT/UPDATE (Own + Team)
          "can_edit_clients": False,         # ADMIN_GRANTED_ONLY
          "can_approve_clients": False,      # ADMIN_GRANTED_ONLY
          "can_edit_dsc": False,             # ADMIN_GRANTED_ONLY
          "can_edit_documents": False,       # ADMIN_GRANTED_ONLY
          "can_edit_due_dates": True,        # Compliance Calendar → EDIT/UPDATE (Own + Team)
          "can_edit_users": False,           # ADMIN_GRANTED_ONLY
          "can_download_reports": True,      # Reports → VIEW includes export (Own + Team)
          "can_manage_users": False,         # ADMIN_GRANTED_ONLY
          "can_manage_settings": True,       # General Settings → VIEW, UPDATE (Own + Team)
          "can_assign_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_assign_clients": False,       # ADMIN_GRANTED_ONLY
          "can_view_staff_activity": False,  # Admin-only — not grantable to manager/staff
          "can_send_reminders": False,       # ADMIN_GRANTED_ONLY
          "can_receive_popup_reminders": False,  # ADMIN_GRANTED_ONLY — also requires cross visibility to be on
          "can_view_user_page": False,       # ADMIN_GRANTED_ONLY
          "can_view_audit_logs": False,      # ADMIN_GRANTED_ONLY
          "can_view_selected_users_reports": True,  # Reports → VIEW (Team scope)
          "can_view_todo_dashboard": True,   # To Do → VIEW (Own + Team)
          "can_view_dashboard": True,        # Dashboard → VIEW
          "can_view_reminders": True,        # Reminders → VIEW (Own + Team)
          "can_view_action_center": True,    # Action Center → VIEW (Own + Team)
          "can_view_client_visits": True,    # Client Visits → VIEW (Own + Team)
          "can_view_ai_document_reader": True,  # AI Document Reader → VIEW (Own + Team)
          "can_use_chat": False,             # ADMIN_GRANTED_ONLY
          "can_view_staff_rankings": False,  # ADMIN_GRANTED_ONLY
          "can_delete_data": False,          # ADMIN_GRANTED_ONLY
          "can_delete_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_connect_email": True,         # Email Accounts → VIEW, CREATE, EDIT, UPDATE (Own + Team)
          "can_view_own_data": True,         # Dashboard → VIEW
          "can_create_quotations": False,    # ADMIN_GRANTED_ONLY (Quotations not in default spec)
          "can_manage_invoices": False,      # ADMIN_GRANTED_ONLY
          "can_view_passwords": False,       # ADMIN_GRANTED_ONLY
          "can_edit_passwords": False,       # ADMIN_GRANTED_ONLY
          "view_password_departments": [],   # defaults to own departments
          "can_view_compliance": True,       # Compliance Tracker → VIEW (Own + Team)
          "can_manage_compliance": True,     # Compliance Tracker → CREATE, EDIT, UPDATE (Own + Team)
          "can_view_mis_report": False,      # MIS Report — ADMIN_GRANTED_ONLY
          "can_manage_mis_report": False,    # MIS Report — ADMIN_GRANTED_ONLY
          "can_edit_attendance": False,      # Attendance correction is Admin-only
          "can_view_all_visits": False,      # SCOPE handled server-side by department query
          "can_edit_visits": True,           # Client Visits → EDIT/UPDATE (Own + Team)
          "can_delete_visits": False,        # ADMIN_GRANTED_ONLY
          "can_delete_own_visits": True,     # Always allowed
          "view_other_visits": [],
          "view_other_tasks": [],
          "view_other_attendance": [],
          "view_other_reports": [],
          "view_other_todos": [],
          "view_other_activity": [],
                    "can_access_whatsapp_hub": False,     # ADMIN_GRANTED_ONLY
          "can_view_recruitment": False,         # ADMIN_GRANTED_ONLY
          "can_manage_recruitment": False,       # ADMIN_GRANTED_ONLY
          "assigned_clients": [],
          # Accounts module governance — ADMIN_GRANTED_ONLY, request via Permission Governance
          "can_view_purchase": False,
          "can_view_sale": False,
          "can_view_bank": False,
          "can_view_chart_of_accounts": False,
          "can_manage_chart_of_accounts": False,
          "can_view_journal_entries": False,
          "can_post_journal_entries": False,
          "can_view_accounting_reports": False,
          "can_match_bank": True,          # Manager: Match / Edit Match / Unmatch by default (still gated by can_view_bank to reach the page)
          # ── Main permission module hierarchy — Taskosphere always on, the
          # other five are ADMIN_GRANTED_ONLY via the Permission Governance portal.
          "can_access_taskosphere": True,
          "can_access_finix": False,
          "can_access_compliance": False,
          "can_access_records": False,
          "can_access_proposals": False,
          "can_access_people_matrix": False,
          "can_view_client_portal": False,   # ADMIN_GRANTED_ONLY
          "can_reset_client_passwords": False,   # ADMIN_GRANTED_ONLY
      },
      "staff": {
          # Staff: SCOPE = OWN only
          # DEFAULT: Only modules explicitly listed in the Staff permission spec are ON.
          # Everything else is ADMIN_GRANTED_ONLY.
          # DATA_ACCESS_RULE: resource.department == user.department AND resource.user_id == user.id
          "can_view_tasks": True,            # GATE: access /tasks endpoint (own scope enforced server-side)
          "can_view_clients": True,          # GATE: access /clients endpoint (assigned scope enforced server-side)
          "can_view_all_tasks": False,       # SCOPE: own only
          "can_view_all_clients": False,     # ADMIN_GRANTED_ONLY
          "can_view_all_dsc": False,         # ADMIN_GRANTED_ONLY
          "can_view_documents": False,       # ADMIN_GRANTED_ONLY
          "can_view_all_duedates": True,     # Compliance Calendar → VIEW (Own)
          "can_view_reports": True,          # Reports → VIEW (Own)
          "can_view_attendance": True,       # Attendance → VIEW (Own)
          "can_view_all_leads": False,       # ADMIN_GRANTED_ONLY (Leads Pipeline not in default spec)
          "can_edit_tasks": True,            # Tasks → EDIT/UPDATE (Own)
          "can_edit_clients": False,         # ADMIN_GRANTED_ONLY
          "can_approve_clients": False,      # ADMIN_GRANTED_ONLY
          "can_edit_dsc": False,             # ADMIN_GRANTED_ONLY
          "can_edit_documents": False,       # ADMIN_GRANTED_ONLY
          "can_edit_due_dates": True,        # Compliance Calendar → EDIT/UPDATE (Own)
          "can_edit_users": False,           # ADMIN_GRANTED_ONLY
          "can_download_reports": True,      # Reports → VIEW includes export (Own)
          "can_manage_users": False,         # ADMIN_GRANTED_ONLY
          "can_manage_settings": True,       # General Settings → VIEW, UPDATE (Own)
          "can_assign_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_assign_clients": False,       # ADMIN_GRANTED_ONLY
          "can_view_staff_activity": False,  # Admin-only — not grantable to manager/staff
          "can_send_reminders": False,       # ADMIN_GRANTED_ONLY
          "can_receive_popup_reminders": False,  # ADMIN_GRANTED_ONLY — also requires cross visibility to be on
          "can_view_user_page": False,       # ADMIN_GRANTED_ONLY
          "can_view_audit_logs": False,      # ADMIN_GRANTED_ONLY
          "can_view_selected_users_reports": False, # ADMIN_GRANTED_ONLY (staff sees own reports only)
          "can_view_todo_dashboard": True,   # To Do → VIEW (Own)
          "can_view_dashboard": True,        # Dashboard → VIEW
          "can_view_reminders": True,        # Reminders → VIEW (Own)
          "can_view_action_center": True,    # Action Center → VIEW (Own)
          "can_view_client_visits": True,    # Client Visits → VIEW (Own)
          "can_view_ai_document_reader": True,  # AI Document Reader → VIEW (Own)
          "can_use_chat": False,             # ADMIN_GRANTED_ONLY
          "can_view_staff_rankings": False,  # ADMIN_GRANTED_ONLY
          "can_delete_data": False,          # ADMIN_GRANTED_ONLY
          "can_delete_tasks": False,         # ADMIN_GRANTED_ONLY
          "can_connect_email": True,         # Email Accounts → VIEW, CREATE, EDIT, UPDATE (Own)
          "can_view_own_data": True,         # Dashboard → VIEW (Own)
          "can_create_quotations": False,    # ADMIN_GRANTED_ONLY (Quotations not in default spec)
          "can_manage_invoices": False,      # ADMIN_GRANTED_ONLY
          "can_view_passwords": False,       # ADMIN_GRANTED_ONLY
          "can_edit_passwords": False,       # ADMIN_GRANTED_ONLY
          "view_password_departments": [],
          "can_view_compliance": True,       # Compliance Tracker → VIEW (Own)
          "can_manage_compliance": True,     # Compliance Tracker → CREATE, EDIT, UPDATE (Own)
          "can_view_mis_report": False,      # MIS Report — ADMIN_GRANTED_ONLY
          "can_manage_mis_report": False,    # MIS Report — ADMIN_GRANTED_ONLY
          "can_edit_attendance": False,      # Attendance correction is Admin-only
          "can_view_all_visits": False,      # SCOPE: own visits only (server-side scoped)
          "can_edit_visits": True,           # Client Visits → EDIT/UPDATE (Own)
          "can_delete_visits": False,        # ADMIN_GRANTED_ONLY
          "can_delete_own_visits": True,     # Always allowed
          "view_other_visits": [],
          "view_other_tasks": [],
          "view_other_attendance": [],
          "view_other_reports": [],
          "view_other_todos": [],
          "view_other_activity": [],
                    "can_access_whatsapp_hub": False,     # ADMIN_GRANTED_ONLY
          "can_view_recruitment": False,         # ADMIN_GRANTED_ONLY
          "can_manage_recruitment": False,       # ADMIN_GRANTED_ONLY
          "assigned_clients": [],
          # Accounts module governance — ADMIN_GRANTED_ONLY, request via Permission Governance
          "can_view_purchase": False,
          "can_view_sale": False,
          "can_view_bank": False,
          "can_view_chart_of_accounts": False,
          "can_manage_chart_of_accounts": False,
          "can_view_journal_entries": False,
          "can_post_journal_entries": False,
          "can_view_accounting_reports": False,
          "can_match_bank": False,          # Staff: view-only by default; admin can grant Match/Edit Match/Unmatch via Permission Governance
          # ── Main permission module hierarchy — Taskosphere always on, the
          # other five are ADMIN_GRANTED_ONLY via the Permission Governance portal.
          "can_access_taskosphere": True,
          "can_access_finix": False,
          "can_access_compliance": False,
          "can_access_records": False,
          "can_access_proposals": False,
          "can_access_people_matrix": False,
          "can_view_client_portal": False,   # ADMIN_GRANTED_ONLY
          "can_reset_client_passwords": False,   # ADMIN_GRANTED_ONLY
      },
  }

# ────────────────────────────────────────────────
# MAIN PERMISSION MODULE HIERARCHY
# ────────────────────────────────────────────────
# Single source of truth for the "Permission Governance" hierarchy shown on
# the Users → Permissions → Modules tab. Six main permission modules
# (Taskosphere, Finix, Compliance, Records, Client Proposals, People Matrix)
# each own a master "module access" flag plus a set of individual page-level
# flags that already existed in this system. A page flag can only ever be
# effectively True while its parent module's master flag is also True —
# enforced in backend/permission_governance.py::_enforce_module_hierarchy
# every time permissions are saved, and mirrored in the frontend so a page
# toggle is greyed out until its module is switched on.
#
# NOTE: every page inside Taskosphere — Dashboard, Tasks, To-Do, Attendance,
# Reminders, Action Center, Client Visits, AI Document Reader and Client
# Portal Manager — now carries its own individually-governed page flag, same
# as every other module. All default True for every role (see
# DEFAULT_ROLE_PERMISSIONS above) so nobody loses access on upgrade; an admin
# can revoke any one of them per user from Users → Permission Governance.
# Dashboard is still never enforced with a hard redirect in the frontend
# route guard (see frontend/src/AppRoutes.jsx) — its flag only controls
# whether the Dashboard link shows in the sidebar, so turning it off can
# never create a redirect loop (denied-access redirects always land on
# /dashboard).
MODULE_HIERARCHY: Dict[str, Dict[str, Any]] = {
    "taskosphere": {
        "flag": "can_access_taskosphere",
        "label": "Taskosphere",
        "description": "Core workspace — Tasks, To-Do, Attendance, Reminders, Action Center, Client Visits, AI Document Reader and Client Portal Manager.",
        "pages": [
            {"flag": "can_view_dashboard",          "label": "Dashboard",           "actions": ["view"]},
            {"flag": "can_view_tasks",               "label": "Tasks",                "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_todo_dashboard",      "label": "To-Do",                "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_attendance",          "label": "Attendance",           "actions": ["view", "edit"]},
            {"flag": "can_view_reminders",           "label": "Reminders",            "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_action_center",       "label": "Action Center",        "actions": ["view"]},
            {"flag": "can_view_client_visits",       "label": "Client Visits",        "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_view_ai_document_reader",  "label": "AI Document Reader",   "actions": ["view", "create"]},
            {"flag": "can_view_client_portal",       "label": "Client Portal Manager", "actions": ["view", "create", "edit", "delete", "export", "print", "share"]},
            {"flag": "can_reset_client_passwords",   "label": "Password Reset", "actions": ["view", "edit", "export"]},
        ],
    },
    "finix": {
        "flag": "can_access_finix",
        "label": "Finix",
        "description": "Accounting & finance — Sales, Purchase, Bank Accounts, Chart of Accounts, Journal Entries and Accounting Reports.",
        "pages": [
            {"flag": "can_view_accounting_reports", "label": "Finix Dashboard & Accounting Reports", "actions": ["view", "export", "print"]},
            {"flag": "can_view_sale",                "label": "Sales / Invoicing", "actions": ["view", "create", "edit", "delete", "export", "print", "share"]},
            {"flag": "can_view_purchase",             "label": "Purchase", "actions": ["view", "create", "edit", "delete", "export", "print"]},
            {"flag": "can_view_bank",                 "label": "Bank Accounts", "actions": ["view", "create", "export"]},
            {"flag": "can_view_chart_of_accounts",    "label": "Chart of Accounts (view)", "actions": ["view", "export"]},
            {"flag": "can_manage_chart_of_accounts",  "label": "Chart of Accounts (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_journal_entries",      "label": "Journal Entries (view)", "actions": ["view", "export"]},
            {"flag": "can_post_journal_entries",       "label": "Journal Entries & Zero Touch Entry (post)", "actions": ["create", "edit", "approve"]},
            {"flag": "can_match_bank",                "label": "Bank Reconciliation (match/unmatch)", "actions": ["edit"]},
        ],
    },
    "compliance": {
        "flag": "can_access_compliance",
        "label": "Compliance",
        "description": "Compliance Tracker, GST Reconciliation, Trademark Sphere, MIS Report, Salary Slip Generator and ROC Sphere.",
        "pages": [
            {"flag": "can_view_compliance",          "label": "Compliance Tracker (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_compliance",        "label": "Compliance Tracker (manage)", "actions": ["create", "edit", "delete", "approve"]},
            {"flag": "can_view_gst_reconciliation",  "label": "GST Reconciliation", "actions": ["view", "export"]},
            {"flag": "can_view_trademark_sphere",    "label": "Trademark Sphere", "actions": ["view", "create", "edit", "export", "print"]},
            {"flag": "can_view_mis_report",          "label": "MIS Report (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_mis_report",        "label": "MIS Report (manage)", "actions": ["create", "edit", "delete", "upload"]},
            {"flag": "can_view_salary_slips",        "label": "Salary Slip Generator (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_salary_slips",      "label": "Salary Slip Generator (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_roc_sphere",          "label": "ROC Sphere (view)", "actions": ["view", "export", "print"]},
            {"flag": "can_manage_roc_sphere",        "label": "ROC Sphere (manage)", "actions": ["create", "edit", "delete", "upload"]},
        ],
    },
    "records": {
        "flag": "can_access_records",
        "label": "Records",
        "description": "DSC Register, Document Register, Clients (with approval workflow) and Password Vault.",
        "pages": [
            {"flag": "can_view_all_dsc",   "label": "DSC Register", "actions": ["view", "export"]},
            {"flag": "can_view_documents", "label": "Document Register", "actions": ["view", "export"]},
            {"flag": "can_view_passwords", "label": "Password Vault (view)", "actions": ["view"]},
            {"flag": "can_edit_passwords", "label": "Password Vault (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_all_clients", "label": "Clients — visibility of other users' clients", "actions": ["view"]},
            {"flag": "can_edit_clients",     "label": "Clients — edit / update any client", "actions": ["edit", "update"]},
            {"flag": "can_approve_clients",  "label": "Clients — approve newly added clients", "actions": ["approve"]},
            {"flag": "can_approve_whatsapp_wishes", "label": "Automation — approve WhatsApp birthday/festival wishes", "actions": ["approve"]},
            {"flag": "can_approve_email_wishes",    "label": "Automation — approve Email birthday/festival wishes", "actions": ["approve"]},
        ],
    },
    "proposals": {
        "flag": "can_access_proposals",
        "label": "Client Proposals",
        "description": "Lead management, quotations and client discussion threads.",
        "pages": [
            {"flag": "can_view_all_leads",    "label": "Lead Management", "actions": ["view", "create", "edit", "delete", "export"]},
            {"flag": "can_create_quotations", "label": "Quotations", "actions": ["view", "create", "edit", "delete", "export", "print", "share", "approve"]},
            {"flag": "can_view_client_discussion",   "label": "Client Discussion (view)", "actions": ["view"]},
            {"flag": "can_manage_client_discussion", "label": "Client Discussion (manage)", "actions": ["create", "edit", "delete"]},
        ],
    },
    "people_matrix": {
        "flag": "can_access_people_matrix",
        "label": "People Matrix",
        "description": "User directory, Attendance, Leave, Payroll, HR, Recruitment (candidate pipeline & interviews) and Performance (HRMS).",
        "pages": [
            {"flag": "can_view_user_page",  "label": "User Directory", "actions": ["view", "export"]},

            {"flag": "can_view_leave",        "label": "Leave (view)", "actions": ["view"]},
            {"flag": "can_manage_leave",      "label": "Leave (manage)", "actions": ["create", "edit", "delete", "approve"]},
            {"flag": "can_view_payroll",      "label": "Payroll (view)", "actions": ["view", "export"]},
            {"flag": "can_manage_payroll",    "label": "Payroll (manage)", "actions": ["create", "edit", "approve"]},
            {"flag": "can_view_hr",           "label": "HR (view)", "actions": ["view"]},
            {"flag": "can_manage_hr",         "label": "HR (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_recruitment",  "label": "Recruitment (view)", "actions": ["view", "export"]},
            {"flag": "can_manage_recruitment","label": "Recruitment (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_performance",  "label": "Performance (view)", "actions": ["view"]},
            {"flag": "can_manage_performance","label": "Performance (manage)", "actions": ["create", "edit"]},
        ],
    },
    # Admin is intentionally NOT gated by a stored per-user flag the way the
    # other six modules are — role == "admin" is itself the gate (see
    # section 1 of the governance spec: "Admin should NEVER require any
    # permission"). It is included here only so the module tree / dynamic
    # sidebar can render it uniformly; `has_module_access()` in
    # backend/governance_core.py special-cases "admin" to `user.role == "admin"`
    # rather than looking up a flag.
    "admin": {
        "flag": "can_access_admin",
        "label": "Admin",
        "description": "Users, Permission Matrix, Audit Logs, Settings, Master Data, Roles and Activity Logs.",
        "pages": [
            {"flag": "can_view_user_page",     "label": "Users", "actions": ["view", "create", "edit", "delete"]},
            {"flag": "can_manage_permissions", "label": "Permission Matrix", "actions": ["view", "edit", "approve"]},
            {"flag": "can_view_audit_logs",    "label": "Audit Logs", "actions": ["view", "export"]},
            {"flag": "can_manage_settings",    "label": "Settings", "actions": ["view", "edit"]},
            {"flag": "can_view_master_data",   "label": "Master Data (view)", "actions": ["view"]},
            {"flag": "can_manage_master_data", "label": "Master Data (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_roles",         "label": "Roles (view)", "actions": ["view"]},
            {"flag": "can_manage_roles",       "label": "Roles (manage)", "actions": ["create", "edit", "delete"]},
            {"flag": "can_view_staff_activity","label": "Activity Logs", "actions": ["view", "export"]},
        ],
    },
}

# ======================
# CORE USER & PERMISSIONS
# ======================
class UserPermissions(BaseModel):
    can_view_tasks: bool = True       # GATE flag — all roles True by default
    can_view_clients: bool = True      # GATE flag — all roles True by default
    can_view_all_tasks: bool = False
    can_view_all_clients: bool = False
    can_view_all_dsc: bool = False
    can_view_documents: bool = False
    can_view_all_duedates: bool = False
    can_view_reports: bool = False
    can_view_attendance: bool = False
    # Attendance correction is strictly Admin-only. Backend also enforces role == admin.
    can_edit_attendance: bool = False
    can_view_all_leads: bool = False
    can_edit_tasks: bool = False
    can_edit_clients: bool = False
    # Approve / reject client records created by other users (admin workflow)
    can_approve_clients: bool = False
    # Delegated rights to approve queued automated client messages —
    # separate from can_manage_automation_settings, which controls
    # templates/toggles/festivals (structural config, admin by default).
    can_approve_whatsapp_wishes: bool = False
    can_approve_email_wishes: bool = False
    can_edit_dsc: bool = False
    can_edit_documents: bool = False
    can_edit_due_dates: bool = False
    can_edit_users: bool = False
    can_download_reports: bool = False
    can_manage_users: bool = False
    can_manage_settings: bool = False
    can_assign_tasks: bool = False
    can_assign_clients: bool = False
    can_view_staff_activity: bool = False
    can_send_reminders: bool = False
    can_receive_popup_reminders: bool = False
    can_view_user_page: bool = False
    can_view_audit_logs: bool = False
    can_view_selected_users_reports: bool = False
    can_view_todo_dashboard: bool = False
    # ── Individually-governed Taskosphere pages (see MODULE_HIERARCHY["taskosphere"]
    # in this file). These used to be wide open to every signed-in user with no
    # flag of their own; they now default True for every role so nobody loses
    # access on upgrade, but an admin can revoke any one of them per user from
    # Users → Permission Governance, same as Client Portal Manager already worked.
    can_view_dashboard: bool = True
    can_view_reminders: bool = True
    can_view_action_center: bool = True
    can_view_client_visits: bool = True
    can_view_ai_document_reader: bool = True
    can_use_chat: bool = False
    can_view_staff_rankings: bool = False
    can_delete_data: bool = False
    can_delete_tasks: bool = False
    can_connect_email: bool = True
    can_view_own_data: bool = True
    can_create_quotations: bool = False
    # ── Invoicing & Billing ──────────────────────────────────────────────────
    # Grants access to: create/edit/delete invoices, record payments,
    # download PDFs, manage product catalog.
    # Admin always has this regardless of the flag.
    can_manage_invoices: bool = False
    # ── Password Repository ──────────────────────────────────────────────────
    can_view_passwords: bool = False
    can_edit_passwords: bool = False
    view_password_departments: List[str] = Field(default_factory=list)
    # ── Compliance Tracker ───────────────────────────────────────────────────
    # can_view_compliance  → access the Compliance Tracker page
    #   admin:   all categories; manager/staff: own department categories only
    # can_manage_compliance → create / edit / delete compliance masters
    #   admin/manager: True by default; staff: False (update assignments only)
    can_view_compliance: bool = False
    can_manage_compliance: bool = False
    # ── GST Reconciliation ───────────────────────────────────────────────────
    # can_view_gst_reconciliation → access the GST Reconciliation page
    #   Grant this to GST department users only.
    #   Admin always has access regardless of this flag.
    can_view_gst_reconciliation: bool = False
    # ── Trademark Sphere ─────────────────────────────────────────────────────
    # can_view_trademark_sphere → access the Trademark Sphere page
    #   Admin always has access regardless of this flag.
    can_view_trademark_sphere: bool = False
    # ── MIS Report ───────────────────────────────────────────────────────────
    # can_view_mis_report → access the MIS Report page (Financial Dashboard,
    #   Receivables/Payables/Revenue/Expense/Profitability MIS) for clients
    #   they're allowed to see (scoped by can_view_all_clients/assigned_clients).
    #   Admin always has access regardless of this flag.
    # can_manage_mis_report → upload source documents (sales/purchase/bank/
    #   balance sheet/GST reports), create MIS reports/periods, add new
    #   clients from the MIS screen, and edit manual-entry figures.
    can_view_mis_report: bool = False
    can_manage_mis_report: bool = False
    # ── Salary Slip Generator (Compliance) ───────────────────────────────────
    # Generates payslips for CLIENT COMPANIES' employees (distinct from the
    # People Matrix → Payroll module, which runs payroll for the firm's own
    # staff). Payroll data is sensitive, so — like GST Reconciliation and
    # Trademark Sphere — this is admin-granted only by default.
    can_view_salary_slips: bool = False
    can_manage_salary_slips: bool = False
    # ── ROC Sphere ────────────────────────────────────────────────────────────
    # Companies Act / ROC compliance module — company master, document
    # generation (Board Resolution, Notices, Minutes, Shareholder Register)
    # and the compliance checklist. Like GST Reconciliation, Trademark
    # Sphere and Salary Slips, this is admin-granted only by default.
    # can_view_roc_sphere → open the page, view company masters, checklist,
    #   generate/download documents.
    # can_manage_roc_sphere → create/edit/delete company masters and upload
    #   AOC-4/MGT-7 to prefill them.
    can_view_roc_sphere: bool = False
    can_manage_roc_sphere: bool = False
    # ── Visit-specific permissions ───────────────────────────────────────────
    can_view_all_visits: bool = False
    can_edit_visits: bool = False
    can_delete_visits: bool = False
    can_delete_own_visits: bool = True
    view_other_visits: List[str] = Field(default_factory=list)
    # ── List permissions ─────────────────────────────────────────────────────
    view_other_tasks: List[str] = Field(default_factory=list)
    view_other_attendance: List[str] = Field(default_factory=list)
    view_other_reports: List[str] = Field(default_factory=list)
    view_other_todos: List[str] = Field(default_factory=list)
    view_other_activity: List[str] = Field(default_factory=list)
    assigned_clients: List[str] = Field(default_factory=list)
    can_access_whatsapp_hub: bool = False
    governed_users: List[str] = Field(default_factory=list)   # users this person can manage (when can_manage_users=True)
    # ── Accounts module governance ───────────────────────────────────────────
    # Purchase / Sale / Bank / Chart of Accounts / Journal Entries / Reports.
    # Admin has all of these True by default (see DEFAULT_ROLE_PERMISSIONS).
    # Manager/staff default to False and must be granted access by an admin
    # via the Permission Governance portal (Users → Permission Governance),
    # normally after the user submits an access request from the gated page.
    can_view_purchase: bool = False
    can_view_sale: bool = False
    can_view_bank: bool = False
    can_view_chart_of_accounts: bool = False
    can_manage_chart_of_accounts: bool = False
    can_view_journal_entries: bool = False
    can_post_journal_entries: bool = False
    can_view_accounting_reports: bool = False
    # can_match_bank → Bank Accounts page: Match / Edit Match / Unmatch actions.
    # Distinct from can_view_bank (which only gates read access to the page).
    # Admin: always True. Manager: True by default. Staff: False by default —
    # grant via Permission Governance for permission-based access.
    can_match_bank: bool = False
    # ── Main permission module hierarchy (see MODULE_HIERARCHY above) ────────
    # Master "module access" flags for the six main areas of the app, shown on
    # Users → Permissions → Modules. A page-level flag above can only ever be
    # effectively True while its parent module flag here is also True.
    # Taskosphere defaults True for every role (matching its historically-open
    # pages), but — unlike before — is now a real, editable master switch: an
    # admin can turn it off for a user, which cascades and clears every page
    # flag nested beneath it (Dashboard, Tasks, To-Do, Attendance, Reminders,
    # Action Center, Client Visits, AI Document Reader, Client Portal Manager),
    # exactly like Finix/Compliance/Records/Proposals/People Matrix already do.
    can_access_taskosphere: bool = True
    can_access_finix: bool = False
    can_access_compliance: bool = False
    can_access_records: bool = False
    can_access_proposals: bool = False
    can_access_people_matrix: bool = False
    # Admin is role-gated, not flag-gated (see MODULE_HIERARCHY["admin"] note
    # above) — this flag exists only for uniform module-tree rendering and is
    # never consulted by has_module_access() for real access decisions.
    can_access_admin: bool = False

    # ── New pages added under the centralized Governance & Permission Matrix
    # (records, proposals, people_matrix, admin) — all default False / staff
    # scope, granted the same way as every other page flag above, through
    # Permission Governance. Nothing here changes any existing flag's
    # behaviour or default.
    can_view_client_discussion: bool = False
    can_manage_client_discussion: bool = False
    can_view_leave: bool = False
    can_manage_leave: bool = False
    can_view_payroll: bool = False
    can_manage_payroll: bool = False
    can_view_hr: bool = False
    can_manage_hr: bool = False
    can_view_recruitment: bool = False
    can_manage_recruitment: bool = False
    can_view_performance: bool = False
    can_manage_performance: bool = False
    can_view_master_data: bool = False
    can_manage_master_data: bool = False
    can_view_roles: bool = False
    can_manage_roles: bool = False
    can_manage_permissions: bool = False   # Admin → Permission Matrix (grant/revoke others' access)
    # ── Client Portal Manager ────────────────────────────────────────────────
    # Lives under the Taskosphere module (see MODULE_HIERARCHY["taskosphere"]
    # above) — grant/revoke per user from Users → Permission Governance /
    # Permission Matrix. Admin always has access regardless of this flag.
    can_view_client_portal: bool = False
    # ── Password Reset (Client Portal Manager → Password Reset) ──────────────
    # Allows resetting client-portal login passwords, including the bulk
    # reset shortcut, and downloading the resulting credentials sheet.
    # Admin always has this; manager/staff must be granted it via Access
    # Governance / Permission Matrix.
    can_reset_client_passwords: bool = False

    # ── Centralized action-level + visibility governance (additive layer) ───
    # `governance_matrix`: { "<module>.<page_flag>": ["view","create","edit",
    #   "delete","export","approve", ...] } — fine-grained action grants on
    # top of the page flags above. A page flag above still gates whether the
    # page is reachable at all (VISIBILITY of the page); this matrix governs
    # which ACTIONS are available once on it. Empty/absent = no per-action
    # restriction beyond the legacy flags (see has_action_access() in
    # backend/governance_core.py for the exact fallback rules — this keeps
    # every page that predates this system working exactly as before).
    governance_matrix: Dict[str, List[str]] = Field(default_factory=dict)
    # `visibility_matrix`: { "<resource_type>": {"scope": "own"|"selected_users"
    #   |"selected_departments"|"selected_roles"|"organization", "selected": [...]}}
    # Generalizes the existing view_other_tasks / assigned_clients / etc.
    # list-fields into one place for NEW resource types going forward.
    # Existing resource types keep using their original list-fields — see
    # has_visibility_access() for the mapping.
    visibility_matrix: Dict[str, Dict[str, Any]] = Field(default_factory=dict)

    model_config = ConfigDict(extra="ignore")


class User(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str
    email: str
    full_name: Optional[str] = None
    role: UserRole = UserRole.staff
    # Optional custom-role key (see backend/roles_admin.py). `role` always
    # stays one of admin/manager/staff so every existing role check works.
    role_key: Optional[str] = None
    password: Optional[str] = None
    consent_given: bool = False
    departments: List[str] = Field(default_factory=list)
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    profile_picture: Optional[str] = None
    punch_in_time: Optional[str] = "10:30"
    grace_time: Optional[str] = "00:10"
    punch_out_time: Optional[str] = "19:00"
    telegram_id: Optional[int] = None
    permissions: UserPermissions = Field(default_factory=UserPermissions)
    created_at: Optional[Any] = None
    is_active: bool = True
    status: str = "pending_approval"
    approved_by: Optional[str] = None
    approved_at: Optional[Any] = None
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    commercial_customer_id: Optional[str] = None
    license_id: Optional[str] = None
    license_key: Optional[str] = None
    licensed_modules: List[str] = Field(default_factory=list)
    selected_features: Dict[str, Any] = Field(default_factory=dict)
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None          # Date the employee joined
    training_period_end: Optional[Any] = None   # End date of the training / probation period
    payroll_date: Optional[Any] = None          # Monthly payroll processing date (day of month or full date)
    monthly_salary: Optional[float] = None      # Gross monthly salary (admin-set); used for salary-due calculation

    @field_validator("monthly_salary", mode="before")
    @classmethod
    def empty_salary_to_none(cls, v):
        if v == "" or v is None:
            return None
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    @field_validator("birthday", mode="before")
    @classmethod
    def empty_string_to_none(cls, v):
        if v == "" or v is None:
            return None
        return v


class UserCreate(BaseModel):
    full_name: str
    email: str
    password: str
    role: UserRole = UserRole.staff
    departments: List[str] = Field(default_factory=list)
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    telegram_id: Optional[int] = None
    punch_in_time: Optional[str] = "10:30"
    grace_time: Optional[str] = "00:10"
    punch_out_time: Optional[str] = "19:00"
    profile_picture: Optional[str] = None
    is_active: bool = True
    permissions: Optional[Dict[str, Any]] = None
    status: Optional[str] = "pending_approval"
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None
    training_period_end: Optional[Any] = None
    payroll_date: Optional[Any] = None
    monthly_salary: Optional[float] = None


class UserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    password: Optional[str] = None
    role: Optional[UserRole] = None
    departments: Optional[List[str]] = None
    phone: Optional[str] = None
    birthday: Optional[Any] = None
    punch_in_time: Optional[str] = None
    grace_time: Optional[str] = None
    punch_out_time: Optional[str] = None
    is_active: Optional[bool] = None
    profile_picture: Optional[str] = None
    telegram_id: Optional[int] = None
    company_id: Optional[str] = None
    company_name: Optional[str] = None
    # ── Employment / Payroll fields ──────────────────────────────────────────
    joining_date: Optional[Any] = None
    training_period_end: Optional[Any] = None
    payroll_date: Optional[Any] = None
    monthly_salary: Optional[float] = None
    model_config = ConfigDict(from_attributes=True, extra="ignore")


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str
    user: User
    consent_given: Optional[bool] = None  # Fixed: was 'Noner'
    session_token: Optional[str] = None  # for POST /auth/logout


# ======================
# TODOS & TASKS
# ======================
class Todo(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    title: str
    description: Optional[str] = None
    is_completed: bool = False
    status: str = "pending"
    due_date: Optional[Any] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    completed_at: Optional[Any] = None


class TodoCreate(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Optional[datetime] = None
    is_completed: bool = False
    status: str = "pending"
    source: Optional[str] = "manual"      # 'manual' | 'email_sync' | 'auto'
    auto_imported: Optional[bool] = False


class TaskBase(BaseModel):
    title: str
    description: Optional[str] = None
    assigned_to: Optional[str] = None
    sub_assignees: List[str] = Field(default_factory=list)
    due_date: Optional[Any] = None
    priority: str = "medium"
    status: str = "pending"
    category: str = "other"          # legacy single-value (kept for backward compat)
    categories: List[str] = Field(default_factory=list)  # multi-department support
    client_id: Optional[str] = None
    is_recurring: bool = False
    recurrence_pattern: Optional[str] = "monthly"
    recurrence_interval: Optional[int] = 1
    recurrence_end_date: Optional[Any] = None
    type: Optional[str] = None
    # Per-task popup cadence override (minutes). None = use universal default.
    popup_interval_minutes: Optional[int] = None


class TaskCreate(TaskBase):
    pass


class BulkTaskCreate(BaseModel):
    tasks: List[TaskCreate]


class Task(TaskBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None
    updated_at: Optional[Any] = None
    completed_at: Optional[Any] = None
    parent_task_id: Optional[str] = None


# ======================
# ATTENDANCE
# ======================
class AttendanceProof(BaseModel):
    """
    Embedded proof document stored inside an attendance record.
    All fields are optional — any combination of note / photos / documents is valid.
    """
    model_config = ConfigDict(extra="ignore")
    note: Optional[str] = None
    photos: List[str] = Field(default_factory=list)
    documents: List[str] = Field(default_factory=list)
    uploaded_at: Optional[str] = None
    updated_at: Optional[str] = None


class Attendance(BaseModel):
    model_config = ConfigDict(extra="ignore", populate_by_name=True)
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    date: str
    status: str = "absent"
    punch_in: Optional[Any] = None
    punch_out: Optional[Any] = None
    duration_minutes: Optional[int] = 0
    leave_reason: Optional[str] = None
    is_late: bool = False
    punched_out_early: bool = False
    auto_marked: Optional[bool] = False
    auto_punch_out: Optional[bool] = False
    auto_punch_reason: Optional[str] = None
    proof: Optional[AttendanceProof] = None
    overtime_minutes: Optional[int] = 0

    @field_validator("status", mode="before")
    @classmethod
    def normalise_status(cls, v: Any) -> str:
        if v is None or v == "":
            return "absent"
        return str(v)

    @field_validator("duration_minutes", "overtime_minutes", mode="before")
    @classmethod
    def coerce_duration(cls, v: Any) -> int:
        if v is None:
            return 0
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0

    @field_validator("is_late", "punched_out_early", "auto_marked", "auto_punch_out", mode="before")
    @classmethod
    def coerce_bool(cls, v: Any) -> bool:
        if v is None:
            return False
        if isinstance(v, bool):
            return v
        return bool(v)


class AttendanceBase(BaseModel):
    punch_in: Any
    punch_out: Optional[Any] = None


class AttendanceCreate(BaseModel):
    action: str


# ======================
# STAFF ACTIVITY
# ======================
class StaffActivityCreate(BaseModel):
    app_name: str = "Taskosphere Web"
    window_title: Optional[str] = None
    url: Optional[str] = None
    website: Optional[str] = None
    category: str = "productivity"
    duration_seconds: int = 0
    idle: Optional[bool] = False
    activity_type: str = "active_time"
    description: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class StaffActivityLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    activity_type: str = "active_time"
    app_name: str = "Taskosphere Web"
    window_title: Optional[str] = None
    url: Optional[str] = None
    category: str = "other"
    duration_seconds: int = 0
    timestamp: Optional[Any] = None
    metadata: Optional[Dict[str, Any]] = None


class ActivityLog(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    date: str
    screen_time_minutes: int = 0
    tasks_completed: int = 0


class ActivityLogUpdate(BaseModel):
    screen_time_minutes: Optional[int] = None
    tasks_completed: Optional[int] = None


# ======================
# DSC MANAGEMENT
# ======================
class DSCBase(BaseModel):
    holder_name: str
    dsc_type: Optional[str] = None
    dsc_password: Optional[str] = None
    serial_number: Optional[str] = None
    associated_with: Optional[str] = None
    entity_type: str = "firm"
    issue_date: Any
    expiry_date: Any
    notes: Optional[str] = None
    current_status: str = "IN"
    current_location: str = "with_company"
    taken_by: Optional[str] = None
    taken_date: Optional[Any] = None
    movement_log: List[Any] = Field(default_factory=list)


class DSCCreate(DSCBase):
    pass


class DSC(DSCBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None


class DSCMovement(BaseModel):
    movement_type: str
    person_name: str
    timestamp: Optional[Any] = None
    notes: Optional[str] = None


class DSCListResponse(BaseModel):
    data: List[DSC]
    total: int
    page: int
    limit: int


class DSCMovementRequest(BaseModel):
    movement_type: str
    person_name: str
    notes: Optional[str] = None


class MovementUpdateRequest(BaseModel):
    movement_type: str
    person_name: Optional[str] = None
    notes: Optional[str] = None


# ======================
# REMINDER MODELS
# ======================
class ReminderCreate(BaseModel):
    model_config = ConfigDict(extra="ignore")
    title: str
    description: Optional[str] = None
    remind_at: Any
    event_id: Optional[str] = None
    source: Optional[str] = "manual"
    priority: Optional[str] = "medium"
    reminder_type: Optional[str] = "reminder"
    related_task_id: Optional[str] = None
    # Per-reminder popup cadence override (minutes). None = universal default.
    popup_interval_minutes: Optional[int] = None


class Reminder(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    title: str
    description: Optional[str] = None
    remind_at: Any
    event_id: Optional[str] = None
    source: Optional[str] = "manual"
    priority: Optional[str] = "medium"
    reminder_type: Optional[str] = "reminder"
    related_task_id: Optional[str] = None
    is_dismissed: bool = False
    is_fired: bool = False
    status: Optional[str] = None
    popup_interval_minutes: Optional[int] = None
    created_at: Optional[Any] = None
    updated_at: Optional[Any] = None


# ======================
# DOCUMENT MANAGEMENT
# ======================
class DocumentBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    document_name: Optional[str] = None
    document_type: Optional[str] = None
    document_password: Optional[str] = None
    holder_name: Optional[str] = None
    associated_with: Optional[str] = None
    entity_type: str = "firm"
    issue_date: Optional[Any] = None
    valid_upto: Optional[Any] = None
    notes: Optional[str] = None
    current_status: str = "IN"
    current_location: str = "with_company"
    movement_log: List[Any] = Field(default_factory=list)

    @field_validator("issue_date", "valid_upto", mode="before")
    @classmethod
    def coerce_date_fields(cls, v: Any) -> Any:
        if v is None or v == "" or v == "null":
            return None
        if isinstance(v, (datetime, date)):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return v


class DocumentCreate(DocumentBase):
    pass


class Document(DocumentBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None

    @field_validator("created_at", mode="before")
    @classmethod
    def coerce_created_at(cls, v: Any) -> Any:
        if v is None or v == "":
            return None
        if isinstance(v, datetime):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return v


class DocumentMovement(BaseModel):
    movement_type: str
    person_name: str
    timestamp: Optional[Any] = None
    notes: Optional[str] = None


class DocumentMovementRequest(BaseModel):
    movement_type: str
    person_name: str
    notes: Optional[str] = None


class DocumentMovementUpdateRequest(BaseModel):
    movement_id: str
    movement_type: str
    person_name: Optional[str] = None
    notes: Optional[str] = None


# ======================
# CLIENT MANAGEMENT
# ======================
class ContactPerson(BaseModel):
    name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    designation: Optional[str] = None
    birthday: Optional[Any] = None
    din: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def clean_empty_contact_fields(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nullable = ["email", "phone", "designation", "birthday", "din"]
            for field in nullable:
                if field in data and data[field] == "":
                    data[field] = None
        return data


class ClientDSC(BaseModel):
    certificate_number: Optional[str] = None
    holder_name: Optional[str] = None
    issue_date: Optional[Any] = None
    expiry_date: Optional[Any] = None
    notes: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def clean_empty_dsc_fields(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for field in ["certificate_number", "holder_name", "issue_date", "expiry_date", "notes"]:
                if field in data and data[field] == "":
                    data[field] = None
        return data


class ClientBase(BaseModel):
    model_config = ConfigDict(extra="ignore")
    company_name: str = Field(..., min_length=3, max_length=255)
    client_type: str = Field(..., pattern="^(proprietor|pvt_ltd|llp|partnership|huf|trust|other|LLP|PVT_LTD|public_ltd|section_8)$")
    client_type_label: Optional[str] = None
    contact_persons: List[ContactPerson] = Field(default_factory=list)
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    date_of_incorporation: Optional[Any] = None
    birthday: Optional[Any] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    pincode: Optional[str] = None  # Primary address PIN — auto-derives `state` (see backend/pincode_lookup.py)
    status: Optional[str] = "active"
    services: List[str] = Field(default_factory=list)
    dsc_details: List[ClientDSC] = Field(default_factory=list)
    assigned_to: Optional[str] = None
    notes: Optional[str] = None
    referred_by: Optional[str] = None
    assignments: Optional[List[Dict[str, Any]]] = Field(
        default_factory=list,
        description="List of {user_id, services} assignments"
    )
    # ── Tax & Billing fields (populated from GST certificate or manual entry) ──
    gstin: Optional[str] = None
    pan: Optional[str] = None
    gst_treatment: Optional[str] = None
    place_of_supply: Optional[str] = None
    default_payment_terms: Optional[str] = None
    credit_limit: Optional[Any] = None
    opening_balance: Optional[Any] = None
    opening_balance_type: Optional[str] = None
    tally_ledger_name: Optional[str] = None
    tally_group: Optional[str] = None
    website: Optional[str] = None
    msme_number: Optional[str] = None
    # ── Address fields: primary + GST certificate address (may differ) ─────────
    gst_address: Optional[str] = None   # Principal place of business from GST REG-06
    gst_city: Optional[str] = None
    gst_state: Optional[str] = None
    gst_pin: Optional[str] = None
    # ── MCA / ROC fields (fetched from MCA portal API or parsed from MCA PDF) ──
    cin: Optional[str] = None           # Corporate Identity Number (Pvt/Public Ltd/Section 8)
    llpin: Optional[str] = None         # LLP Identification Number
    proprietor_name: Optional[str] = None  # Proprietor's full name (Proprietor client type)
    mca_fetch_date: Optional[str] = None  # ISO date when MCA data was last fetched
    # ── ITR Client fields ──────────────────────────────────────────────────────
    is_itr_client: Optional[bool] = False   # True when this client is an ITR-only client
    itr_data: Optional[Dict[str, Any]] = None  # JSON blob: itr_type, AY, filing_status, income, etc.

    @model_validator(mode="before")
    @classmethod
    def clean_empty_optional_strings(cls, data: Any) -> Any:
        if isinstance(data, dict):
            nullable_fields = [
                "email", "phone", "referred_by", "notes", "assigned_to",
                "birthday", "date_of_incorporation", "client_type_label",
                "address", "city", "state", "pincode",
                "gstin", "pan", "gst_treatment", "place_of_supply",
                "tally_ledger_name", "tally_group", "website", "msme_number",
                "gst_address", "gst_city", "gst_state", "gst_pin",
                "cin", "llpin", "proprietor_name", "mca_fetch_date",
            ]
            for field in nullable_fields:
                if field in data and data[field] == "":
                    data[field] = None
        return data

    @field_validator("phone", mode="before")
    @classmethod
    def validate_phone(cls, v) -> Optional[str]:
        if v is None or str(v).strip() == "":
            return None
        cleaned = re.sub(r"\s|-|\+", "", str(v))
        if not cleaned.isdigit():
            raise ValueError("Phone number must contain only digits")
        if not (10 <= len(cleaned) <= 15):
            raise ValueError("Phone number must be 10-15 digits")
        return v

    @field_validator("company_name")
    @classmethod
    def validate_company_name(cls, v: str) -> str:
        v = str(v).strip()
        if len(v) < 3:
            raise ValueError("Company name must be at least 3 characters long")
        return v


class ClientCreate(ClientBase):
    pass


class Client(ClientBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None
    # ── Client approval workflow ─────────────────────────────────────────
    # Any user may add a client, but a client created by a non-admin stays
    # "pending" until an admin (or a user with can_approve_clients) approves
    # it. Pending clients are only visible to their creator and approvers.
    approval_status: str = "approved"          # approved | pending | rejected
    approved_by: Optional[str] = None
    approved_at: Optional[Any] = None
    rejection_reason: Optional[str] = None


class MasterClientForm(BaseModel):
    company_name: str
    client_type: str
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    date_of_incorporation: Optional[Any] = None
    gst_number: Optional[str] = None
    pan_number: Optional[str] = None
    tan_number: Optional[str] = None
    assigned_to: Optional[str] = None
    services: List[str] = Field(default_factory=list)
    contact_persons: List[Any] = Field(default_factory=list)
    notes: Optional[str] = None
    referred_by: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def clean_empty_strings(cls, data: Any) -> Any:
        if isinstance(data, dict):
            for k, v in data.items():
                if v == "":
                    data[k] = None
        return data


# ======================
# LEADS MODEL
# ======================
class LeadBase(BaseModel):
    company_name: str
    contact_name: Optional[str] = None
    email: Optional[EmailStr] = None
    phone: Optional[str] = None
    services: List[str] = Field(default_factory=list)
    status: str = "new"
    source: Optional[str] = None
    notes: Optional[str] = None
    assigned_to: Optional[str] = None
    referred_by: Optional[str] = None


class LeadCreate(LeadBase):
    pass


class Lead(LeadBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None


# ======================
# DUE DATES & REMINDERS
# ======================
class DueDateBase(BaseModel):
    title: str
    description: Optional[str] = None
    due_date: Any
    reminder_days: int = 30
    category: Optional[str] = None
    department: str
    assigned_to: Optional[str] = None
    client_id: Optional[str] = None
    status: str = "pending"

    @field_validator("due_date", mode="before")
    @classmethod
    def coerce_due_date(cls, v: Any) -> Any:
        if v is None or v == "":
            raise ValueError("due_date is required")
        if isinstance(v, (date, datetime)):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                pass
            try:
                return date.fromisoformat(v)
            except ValueError:
                raise ValueError(f"Invalid due_date format: {v}")
        return v

    @field_validator("reminder_days", mode="before")
    @classmethod
    def coerce_reminder_days(cls, v: Any) -> int:
        if v is None:
            return 30
        try:
            return int(v)
        except (TypeError, ValueError):
            return 30

    @field_validator("department", mode="before")
    @classmethod
    def coerce_department(cls, v: Any) -> str:
        if v is None or str(v).strip() == "":
            raise ValueError("department is required")
        return str(v).strip()


class DueDateCreate(DueDateBase):
    pass


class DueDate(DueDateBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    created_by: str
    created_at: Optional[Any] = None

    @field_validator("created_at", mode="before")
    @classmethod
    def coerce_created_at(cls, v: Any) -> Any:
        if v is None or v == "":
            return None
        if isinstance(v, datetime):
            return v
        if isinstance(v, str):
            try:
                return datetime.fromisoformat(v)
            except ValueError:
                return None
        return v


class BirthdayEmailRequest(BaseModel):
    client_id: str


# ======================
# NOTIFICATIONS & AUDIT
# ======================
class NotificationBase(BaseModel):
    title: str
    message: str
    type: str


class Notification(NotificationBase):
    model_config = ConfigDict(extra="ignore")
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    is_read: bool = False
    created_at: Optional[Any] = None


class AuditLog(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    user_id: str
    user_name: str
    action: str
    module: str
    record_id: Optional[str] = None
    old_data: Optional[dict] = None
    new_data: Optional[dict] = None
    timestamp: Optional[Any] = None


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
# HOLIDAY MODELS
# ======================
class HolidayCreate(BaseModel):
    date: Any
    name: str
    description: Optional[str] = None
    type: str = "manual"
    status: Optional[str] = "confirmed"


class HolidayResponse(BaseModel):
    date: Any
    name: str
    description: Optional[str] = None
    status: str = "confirmed"
    type: Optional[str] = "manual"


# ======================
# EMAIL INTEGRATION MODELS
# ======================
class EmailConnection(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    provider: str
    method: str
    email_address: Optional[str] = None
    access_token: Optional[str] = None
    refresh_token: Optional[str] = None
    expires_at: Optional[str] = None
    app_password_enc: Optional[str] = None
    imap_host: Optional[str] = None
    imap_port: Optional[int] = None
    connected_at: Optional[str] = None


class ExtractedEvent(BaseModel):
    title: str
    event_type: str
    date: Optional[str] = None
    time: Optional[str] = None
    location: Optional[str] = None
    organizer: Optional[str] = None
    description: Optional[str] = None
    urgency: str = "medium"
    source_subject: str
    source_from: str
    source_date: str
    raw_snippet: Optional[str] = None


# ======================
# PASSWORD REPOSITORY MODELS
# ======================

PORTAL_TYPES_LIST = [
    "MCA", "DGFT", "TRADEMARK", "GST", "INCOME_TAX", "TDS",
    "EPFO", "ESIC", "TRACES", "MSME", "RERA", "ROC", "OTHER",
]


class PasswordEntryCreate(BaseModel):
    """Payload to create a new portal credential entry."""
    portal_name: str = Field(..., min_length=2, max_length=120)
    portal_type: str = "OTHER"
    url: Optional[str] = None
    username: Optional[str] = None
    password_plain: Optional[str] = None   # plain text — backend encrypts
    department: str = "OTHER"
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None
    tags: List[str] = Field(default_factory=list)


class PasswordEntryUpdate(BaseModel):
    portal_name: Optional[str] = None
    portal_type: Optional[str] = None
    url: Optional[str] = None
    username: Optional[str] = None
    password_plain: Optional[str] = None
    department: Optional[str] = None
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None
    tags: Optional[List[str]] = None


class PasswordEntry(BaseModel):
    """Public-facing model — never includes the encrypted password field."""
    model_config = ConfigDict(extra="ignore")
    id: str
    portal_name: str
    portal_type: str
    url: Optional[str] = None
    username: Optional[str] = None
    department: str
    client_name: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None
    tags: List[str] = []
    created_by: str
    created_by_name: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    last_accessed_at: Optional[str] = None
    has_password: bool = False


class PasswordRevealResponse(BaseModel):
    id: str
    username: Optional[str]
    password: str
    portal_name: str


# ────────────────────────────────────────────────
# OFFBOARDING REQUEST
# ────────────────────────────────────────────────
class OffboardRequest(BaseModel):
    replacement_user_id: str
    transfer_tasks: bool = True
    transfer_clients: bool = True
    transfer_dsc: bool = True
    transfer_documents: bool = True
    transfer_todos: bool = True
    transfer_visits: bool = True
    transfer_leads: bool = True
    update_email: Optional[str] = None
    delete_old_user: bool = True
    notes: Optional[str] = None
