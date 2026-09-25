"""Runtime ownership declarations for the controlled migration.

This module is metadata only. It intentionally does not alter FastAPI
registration until a subsystem has passed the route audit.
"""
from types import MappingProxyType

RUNTIME_OWNERSHIP = MappingProxyType({
    "taskosphere.tasks": "backend.modules.taskosphere.tasks.router",
    "taskosphere.attendance": "backend.modules.taskosphere.attendance.router",
    "compligenie.compliance": "backend.modules.compligenie.compliance.router",
    "leadsense.leads": "backend.modules.leadsense.leads.router",
    "people_matrix.permissions": "backend.modules.people_matrix.permissions.router",
    "finix_ai.accounting": "backend.modules.finix_ai.accounting.service",
    "finix_ai.banking": "backend.modules.finix_ai.banking.service",
    "finix_ai.ai": "backend.modules.finix_ai.ai.service",
    "aiweave.router": "backend.modules.aiweave.router.router",
    "trademark.sphere": "backend.modules.trademark.sphere.service",
    "trademark.portals": "backend.modules.trademark.portals.service",
})
