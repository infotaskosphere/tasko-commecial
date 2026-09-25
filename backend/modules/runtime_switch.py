"""Controlled runtime switch primitives.

The switch is opt-in and defaults to legacy registration. It provides a
single explicit gate for future subsystem migrations without changing current
startup behavior.
"""
from __future__ import annotations

from types import MappingProxyType

RUNTIME_SWITCHES = MappingProxyType({
    "taskosphere.tasks": False,
    "taskosphere.attendance": False,
    "taskosphere.clients": False,
    "taskosphere.dsc": False,
    "taskosphere.dashboard": False,
    "finix_ai.accounting": False,
    "finix_ai.banking": False,
    "finix_ai.ai": False,
    "aiweave.router": False,
    "compligenie.compliance": False,
    "leadsense.leads": False,
    "people_matrix.permissions": False,
    "trademark.sphere": False,
    "trademark.portals": False,
})


def is_migrated(name: str) -> bool:
    return bool(RUNTIME_SWITCHES.get(name, False))
