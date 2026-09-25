"""Canonical domain-module manifest.

Phase C/D bridge: records intended module boundaries without changing runtime
router registration. Physical implementations remain in their current files
until their migration adapter is verified.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping


MODULE_MANIFEST: Mapping[str, Mapping[str, str]] = MappingProxyType({
    "taskosphere": MappingProxyType({"package": "backend.modules.taskosphere", "status": "boundary"}),
    "finix_ai": MappingProxyType({"package": "backend.modules.finix_ai", "status": "boundary"}),
    "aiweave": MappingProxyType({"package": "backend.modules.aiweave", "status": "boundary"}),
    "compligenie": MappingProxyType({"package": "backend.modules.compligenie", "status": "boundary"}),
    "leadsense": MappingProxyType({"package": "backend.modules.leadsense", "status": "boundary"}),
    "people_matrix": MappingProxyType({"package": "backend.modules.people_matrix", "status": "boundary"}),
    "records": MappingProxyType({"package": "backend.modules.records", "status": "boundary"}),
    "trademark": MappingProxyType({"package": "backend.modules.trademark", "status": "boundary"}),
})


def module_package(name: str) -> str:
    """Return the canonical package path for a domain module."""
    return MODULE_MANIFEST[name]["package"]
