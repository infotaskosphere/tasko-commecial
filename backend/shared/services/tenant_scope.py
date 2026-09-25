"""Shared tenant-scope contract.

The existing backend.tenant_runtime implementation remains authoritative.
This module only provides a dependency-neutral protocol for domain services.
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol


class TenantScope(Protocol):
    def company_id(self, current_user: Any) -> str: ...

    def filter(
        self,
        current_user: Any,
        extra: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any]: ...
