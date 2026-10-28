"""Phase 2 application runtime extracted from backend.server.

Preserved application runtime code is executed after backend.server initializes
its shared namespace, FastAPI app, API router, dependencies, and Phase 2 modules.

The implementation now lives in backend/server_modules/routes/application_runtime.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "application_runtime.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_application_runtime(namespace):
    from backend.server_modules.routes import load_into
    return load_into("application_runtime", namespace)
