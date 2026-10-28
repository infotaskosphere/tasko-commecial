"""Phase 2 extracted subsystem: holiday_trademark_misc.

The implementation below is intentionally preserved from backend.server.py.
register_holiday_trademark_misc executes the preserved source against the server namespace so
existing cross-subsystem references and FastAPI route registration remain
backward compatible without refactoring unrelated behavior.

The implementation now lives in backend/server_modules/routes/holiday_trademark_misc.py as a
normal Python module (it used to be a SOURCE string run with exec()).
"""
from pathlib import Path

_IMPLEMENTATION = Path(__file__).with_name("routes") / "holiday_trademark_misc.py"

# Kept for tools/tests that read the route source text.
SOURCE = _IMPLEMENTATION.read_text(encoding="utf-8")


def register_holiday_trademark_misc(namespace):
    from backend.server_modules.routes import load_into
    return load_into("holiday_trademark_misc", namespace)
