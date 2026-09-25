"""Service ownership metadata for the domain migration.

The metadata records the intended owner while preserving current production
service implementations.
"""
from types import MappingProxyType

SERVICE_OWNERSHIP = MappingProxyType({
    "taskosphere": (
        "backend.server_modules.task_routes",
        "backend.server_modules.attendance_routes",
        "backend.server_modules.client_management",
        "backend.server_modules.dsc_routes",
        "backend.server_modules.dashboard_ops",
    ),
    "finix_ai": (
        "backend.accounting_core",
        "backend.accounting_extended",
        "backend.accounting_ai.finix_ai_router",
    ),
    "aiweave": (
        "backend.ai.aiweave_router",
        "backend.ai.omni",
    ),
    "compligenie": ("backend.server_modules.compliance_due_dates",),
    "leadsense": ("backend.leads", "backend.client_activity"),
    "people_matrix": ("backend.permission_governance", "backend.roles_admin"),
    "trademark": ("backend.trademark_sphere", "backend.trademark_portals_router"),
})
