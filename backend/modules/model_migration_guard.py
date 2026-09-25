"""Guardrails for safe model ownership migration.

This module is observational. It records which domain facades currently
delegate to the legacy model source and prevents accidental claim of a
physical migration before verification.
"""
from types import MappingProxyType

MODEL_FACADE_STATUS = MappingProxyType({
    "taskosphere.tasks": "legacy-backed-facade",
    "taskosphere.attendance": "legacy-backed-facade",
    "finix_ai.accounting": "legacy-backed-facade",
    "people_matrix.permissions": "legacy-backed-facade",
    "records.documents": "legacy-backed-facade",
})

def is_physical_migration_complete(domain: str) -> bool:
    return MODEL_FACADE_STATUS.get(domain) == "physical"
