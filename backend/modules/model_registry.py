"""Canonical model/service ownership metadata.

Declarative migration layer only. Existing backend/models.py remains
authoritative until each model group has a verified migration.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple


@dataclass(frozen=True)
class ModelOwnership:
    domain: str
    model_names: Tuple[str, ...]
    source: str


MODEL_OWNERSHIP = (
    ModelOwnership(
        "taskosphere",
        ("TaskBase", "TaskCreate", "Task", "Attendance", "StaffActivityLog", "StaffActivityCreate"),
        "backend.models",
    ),
    ModelOwnership(
        "finix_ai",
        ("JournalEntry", "JournalLine", "BankAccount", "Payment"),
        "backend.models",
    ),
    ModelOwnership(
        "aiweave",
        ("AIWeaveProviderAccount", "AIWeaveProviderModel"),
        "backend.models",
    ),
    ModelOwnership(
        "people_matrix",
        ("User", "UserBase", "UserCreate", "UserPermissions"),
        "backend.models",
    ),
    ModelOwnership(
        "records",
        ("Document",),
        "backend.models",
    ),
    ModelOwnership(
        "leadsense",
        ("Lead",),
        "backend.models",
    ),
    ModelOwnership(
        "compligenie",
        ("DueDate",),
        "backend.models",
    ),
)


def ownership_for(domain: str) -> ModelOwnership:
    for item in MODEL_OWNERSHIP:
        if item.domain == domain:
            return item
    raise KeyError(domain)
