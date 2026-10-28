"""Phase 2 extracted subsystem: users_todos_admin.

The implementation below is intentionally preserved from backend.server.py.
register_users_todos_admin executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.

The implementation now lives in backend/server_modules/routes/users_todos_admin.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "users_todos_admin.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_users_todos_admin(namespace):
    from backend.server_modules.routes import load_into
    return load_into("users_todos_admin", namespace)
