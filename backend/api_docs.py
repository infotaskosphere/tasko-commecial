"""Interactive API docs (/docs, /redoc, /openapi.json).

They list every endpoint and its parameters, so they are off in production
(ENV_MODE=production) unless API_DOCS_ENABLED=true is set explicitly.
"""
import os


def docs_settings() -> dict:
    production = str(os.getenv("ENV_MODE") or "").strip().lower() == "production"
    enabled = str(os.getenv("API_DOCS_ENABLED") or "").strip().lower() in {"1", "true", "yes"}
    if production and not enabled:
        return {"docs_url": None, "redoc_url": None, "openapi_url": None}
    return {}


DOCS_SETTINGS = docs_settings()
