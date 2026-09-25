"""Taskosphere Tasks route-source equivalence contract."""
from __future__ import annotations
import re
from backend.server_modules.task_routes import SOURCE

_DECORATOR_RE = re.compile(r'@api_router\.(get|post|put|patch|delete|options|head)\("([^"]+)"')

def route_signatures(source: str = SOURCE):
    return {(method.upper(), path) for method, path in _DECORATOR_RE.findall(source)}

def assert_route_equivalence() -> None:
    signatures = route_signatures()
    if not signatures:
        raise AssertionError("Taskosphere Tasks source contains no API route decorators")
