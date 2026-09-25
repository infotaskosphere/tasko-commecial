"""Legacy cleanup inventory.

A legacy source may only be removed after its domain boundary, route contract,
frontend endpoint audit, and regression coverage have passed.
"""
from types import MappingProxyType

LEGACY_SOURCES = MappingProxyType({
    "backend.server_modules": "compatibility-runtime",
    "backend.models": "compatibility-models",
    "backend.accounting_core": "finix_ai",
    "backend.accounting_extended": "finix_ai",
    "backend.ai": "aiweave",
    "backend.leads": "leadsense",
    "backend.permission_governance": "people_matrix",
    "backend.trademark_sphere": "trademark",
})

REMOVABLE_LEGACY_SOURCES = ()
