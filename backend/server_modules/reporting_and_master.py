"""Phase 2 extracted subsystem: reporting_and_master.

The implementation below is intentionally preserved from backend.server.py.
register_reporting_and_master executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.

The implementation now lives in backend/server_modules/routes/reporting_and_master.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "reporting_and_master.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_reporting_and_master(namespace):
    from backend.server_modules.routes import load_into
    return load_into("reporting_and_master", namespace)
