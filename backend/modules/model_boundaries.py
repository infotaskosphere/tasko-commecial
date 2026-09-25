"""Canonical model boundary map.

During migration, these domain modules are the import boundaries. The legacy
model definitions remain available for backward compatibility; new code should
import through these domain boundaries.
"""
from types import MappingProxyType

MODEL_BOUNDARIES = MappingProxyType({
    "taskosphere.tasks": "backend.modules.taskosphere.tasks.models",
    "taskosphere.attendance": "backend.modules.taskosphere.attendance.models",
    "finix_ai.accounting": "backend.modules.finix_ai.accounting.models",
    "people_matrix.permissions": "backend.modules.people_matrix.permissions.models",
    "records.documents": "backend.modules.records.documents.models",
})
