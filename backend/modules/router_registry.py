"""Controlled runtime router migration registry.

Phase G adapter: modules expose router providers while server.py remains the
single composition root. Registration is explicit and ordered; no automatic
discovery is performed.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable

from fastapi import APIRouter


@dataclass(frozen=True)
class RouterBinding:
    module: str
    capability: str
    provider: Callable[[], APIRouter]


def register_router_bindings(app, bindings: Iterable[RouterBinding], *, prefix="/api") -> None:
    """Register approved module routers exactly once through the composition root."""
    for binding in bindings:
        router = binding.provider()
        if not isinstance(router, APIRouter):
            raise TypeError(f"{binding.module}.{binding.capability} did not provide APIRouter")
        app.include_router(router, prefix=prefix, include_in_schema=False)
