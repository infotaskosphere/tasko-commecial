"""Canonical domain-module registration registry.

Declarative only. It does not import or register FastAPI routers.
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Tuple

@dataclass(frozen=True)
class ModuleRegistration:
    name: str
    package: str
    capabilities: Tuple[str, ...]

MODULE_REGISTRATIONS = (
    ModuleRegistration("taskosphere", "backend.modules.taskosphere", ("tasks", "attendance", "clients", "dsc", "dashboard")),
    ModuleRegistration("finix_ai", "backend.modules.finix_ai", ("accounting", "banking", "reconciliation", "ai")),
    ModuleRegistration("aiweave", "backend.modules.aiweave", ("router", "omni", "providers", "routing")),
    ModuleRegistration("compligenie", "backend.modules.compligenie", ("compliance", "due_dates", "masters")),
    ModuleRegistration("leadsense", "backend.modules.leadsense", ("leads", "activities", "quotations")),
    ModuleRegistration("people_matrix", "backend.modules.people_matrix", ("permissions", "roles", "governance")),
    ModuleRegistration("records", "backend.modules.records", ("documents", "client_records")),
    ModuleRegistration("trademark", "backend.modules.trademark", ("sphere", "portals", "quality")),
)

def get_module_registration(name: str) -> ModuleRegistration:
    for registration in MODULE_REGISTRATIONS:
        if registration.name == name:
            return registration
    raise KeyError(name)
