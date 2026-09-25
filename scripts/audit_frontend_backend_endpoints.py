"""Static frontend -> backend endpoint audit.

Scans frontend JavaScript/JSX API calls and backend route declarations,
including namespace-bound SOURCE strings. Audit only; no runtime mutation.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend" / "src"
BACKEND = ROOT / "backend"

CALL_RE = re.compile(r'\\b(?:api|licensingApi|axios)\\.(?:get|post|put|patch|delete)\\(\\s*[\\\"]([^\\\"]+)')
ROUTE_RE = re.compile(r'@(?:api_router|router|app)\\.(?:get|post|put|patch|delete|options|head)\\(\\s*[\\\"]([^\\\"]+)')
SOURCE_ROUTE_RE = re.compile(r'@api_router\\.(?:get|post|put|patch|delete|options|head)\\([\\\"]([^\\\"]+)')

def frontend_calls():
    calls = {}
    for path in FRONTEND.rglob("*"):
        if path.suffix not in {".js", ".jsx", ".ts", ".tsx"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in CALL_RE.finditer(text):
            calls.setdefault(match.group(1), set()).add(str(path.relative_to(ROOT)))
    return calls

def backend_routes():
    routes = {}
    for path in BACKEND.rglob("*.py"):
        text = path.read_text(encoding="utf-8", errors="ignore")
        for route in ROUTE_RE.findall(text) + SOURCE_ROUTE_RE.findall(text):
            routes.setdefault(route, set()).add(str(path.relative_to(ROOT)))
    return routes

def run():
    calls = frontend_calls()
    routes = backend_routes()
    unresolved = sorted(path for path in calls if path.startswith("/") and not any(
        path == route or path.startswith(route.rstrip("/") + "/")
        or route.startswith(path.rstrip("/") + "/")
        for route in routes
    ))
    print(f"frontend endpoint patterns: {len(calls)}")
    print(f"backend route patterns: {len(routes)}")
    print("Potentially unresolved frontend paths:")
    for path in unresolved:
        print(f"  {path} <- {', '.join(sorted(calls[path]))}")

if __name__ == "__main__":
    run()
