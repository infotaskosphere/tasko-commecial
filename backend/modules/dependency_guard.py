"""Static dependency guard for domain-module boundaries.

This guard is intentionally side-effect free. It can be run in CI before
runtime router ownership is migrated.
"""
from __future__ import annotations

import ast
from pathlib import Path

from backend.modules.dependencies import MODULE_DEPENDENCIES

MODULE_ROOT = Path(__file__).resolve().parent


def _module_name(path: Path) -> str | None:
    try:
        rel = path.relative_to(MODULE_ROOT)
    except ValueError:
        return None
    if len(rel.parts) < 2 or rel.parts[0].startswith("_"):
        return None
    return rel.parts[0]


def _import_root(node: ast.AST) -> str | None:
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name.startswith("backend.modules."):
                return alias.name.split(".")[2]
    if isinstance(node, ast.ImportFrom) and node.module:
        if node.module.startswith("backend.modules."):
            parts = node.module.split(".")
            if len(parts) >= 3:
                return parts[2]
    return None


def find_violations(root: Path = MODULE_ROOT) -> list[str]:
    violations: list[str] = []
    for path in root.rglob("*.py"):
        owner = _module_name(path)
        if owner not in MODULE_DEPENDENCIES:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            imported = _import_root(node)
            if imported and imported != owner and imported not in MODULE_DEPENDENCIES[owner]:
                violations.append(f"{path}: {owner} -> {imported}")
    return violations


def assert_clean() -> None:
    violations = find_violations()
    if violations:
        raise AssertionError("\n".join(violations))
