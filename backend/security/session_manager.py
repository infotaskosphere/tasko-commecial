import hashlib
import logging
import uuid
from datetime import datetime, timezone, timedelta
from types import FunctionType

import backend.dependencies as dependencies

logger = logging.getLogger("session_manager")

SESSION_REPLACED_DETAIL = "SESSION_REPLACED"


def _raw_db():
    """Return the unwrapped database so session checks are never tenant-scoped."""
    raw_db = dependencies.__dict__.get("_raw_db")
    return raw_db if raw_db is not None else dependencies.db


def _as_utc(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if value:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None

