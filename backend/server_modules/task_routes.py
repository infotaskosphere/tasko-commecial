"""Phase 2 extracted subsystem: task_routes.

The implementation below is intentionally preserved from backend.server.py.
register_task_routes executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.

The implementation now lives in backend/server_modules/routes/task_routes.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "task_routes.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_task_routes(namespace):
    from backend.server_modules.routes import load_into
    return load_into("task_routes", namespace)
