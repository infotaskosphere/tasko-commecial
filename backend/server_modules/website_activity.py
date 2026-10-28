"""Phase 2 extracted subsystem: website activity.

The route implementation is preserved and executed only after backend.server has
created api_router. This prevents import-time decorator evaluation from
requiring server globals before they exist.

The implementation now lives in backend/server_modules/routes/website_activity.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "website_activity.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_website_activity(namespace):
    from backend.server_modules.routes import load_into
    return load_into("website_activity", namespace)
