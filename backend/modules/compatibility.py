"""Compatibility boundary for the architecture migration.

Legacy modules remain supported while domain ownership moves incrementally.
This module contains metadata only; it does not monkey-patch or alter imports.
"""
from types import MappingProxyType

LEGACY_OWNERSHIP = MappingProxyType({
    "backend.models": "shared-model-compatibility",
    "backend.server_modules": "legacy-router-compatibility",
    "backend.accounting_core": "finix_ai",
    "backend.accounting_extended": "finix_ai",
    "backend.ai": "aiweave",
    "backend.leads": "leadsense",
    "backend.permission_governance": "people_matrix",
    "backend.trademark_sphere": "trademark",
})
