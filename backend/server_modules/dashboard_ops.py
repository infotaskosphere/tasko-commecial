"""Phase 2 extracted subsystem: dashboard_ops.

The implementation below is intentionally preserved from backend.server.py.
register_dashboard_ops executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.

The implementation now lives in backend/server_modules/routes/dashboard_ops.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "dashboard_ops.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_dashboard_ops(namespace):
    from backend.server_modules.routes import load_into
    load_into("dashboard_ops", namespace)
    # Tenant- and permission-scoped Dashboard task data (/api/dashboard/task-summary).
    from backend.server_modules.dashboard_task_summary import router

    namespace["api_router"].include_router(router)
    return namespace
