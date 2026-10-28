"""Phase 2 extracted subsystem: client_management.

The implementation below is intentionally preserved from backend.server.py.
register_client_management executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.

The implementation now lives in backend/server_modules/routes/client_management.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "client_management.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_client_management(namespace):
    from backend.server_modules.routes import load_into
    return load_into("client_management", namespace)
