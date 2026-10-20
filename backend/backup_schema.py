"""Versioned metadata for OneNexa application backups."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

BACKUP_FORMAT = "onenexa"
BACKUP_FORMAT_VERSION = 1


def build_backup_metadata(*, modules: list[str] | None = None) -> dict[str, Any]:
    return {
        "backup_format": BACKUP_FORMAT,
        "backup_format_version": BACKUP_FORMAT_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "modules": list(modules or []),
    }


def validate_backup_metadata(metadata: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if metadata.get("backup_format") != BACKUP_FORMAT:
        errors.append("Unsupported backup format")
    version = metadata.get("backup_format_version")
    if not isinstance(version, int) or version < 1 or version > BACKUP_FORMAT_VERSION:
        errors.append(f"Unsupported backup format version: {version}")
    return errors
