"""Dependency-light service contracts for cross-domain access.

These protocols deliberately describe behavior rather than implementation.
They allow domain migration without introducing duplicate MongoDB access
layers or changing the existing runtime in Phase B.
"""

from __future__ import annotations

from typing import Any, Mapping, Protocol, Sequence


class UserDirectory(Protocol):
    async def get_user(self, user_id: str) -> Mapping[str, Any] | None: ...


class ClientDirectory(Protocol):
    async def get_client(self, client_id: str) -> Mapping[str, Any] | None: ...


class CompanyDirectory(Protocol):
    async def get_company(self, company_id: str) -> Mapping[str, Any] | None: ...


class AuditWriter(Protocol):
    async def write(
        self,
        *,
        actor: Any,
        action: str,
        module: str,
        record_id: str | None = None,
        old_data: Mapping[str, Any] | None = None,
        new_data: Mapping[str, Any] | None = None,
    ) -> Any: ...


class TaskDirectory(Protocol):
    async def get_task(self, task_id: str) -> Mapping[str, Any] | None: ...


class QuotationDirectory(Protocol):
    async def get_quotation(self, quotation_id: str) -> Mapping[str, Any] | None: ...


class InvoiceDirectory(Protocol):
    async def get_invoice(self, invoice_id: str) -> Mapping[str, Any] | None: ...


class CollectionReader(Protocol):
    """Minimal read contract for migration adapters."""

    async def find_one(
        self,
        query: Mapping[str, Any],
        projection: Mapping[str, Any] | None = None,
    ) -> Mapping[str, Any] | None: ...

    async def find_many(
        self,
        query: Mapping[str, Any],
        limit: int | None = None,
    ) -> Sequence[Mapping[str, Any]]: ...
