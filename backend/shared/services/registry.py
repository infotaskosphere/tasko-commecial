"""Explicit shared-service ownership registry.

The registry contains names and ownership metadata only. It deliberately does
not instantiate services or import the legacy production modules.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Mapping


SERVICE_OWNERS: Mapping[str, str] = MappingProxyType(
    {
        "user_directory": "people_matrix",
        "client_directory": "taskosphere",
        "company_directory": "platform",
        "task_directory": "taskosphere",
        "quotation_directory": "leadsense",
        "invoice_directory": "finix_ai",
        "audit_writer": "platform",
        "tenant_scope": "platform",
    }
)


def service_owner(service_name: str) -> str:
    try:
        return SERVICE_OWNERS[service_name]
    except KeyError as exc:
        raise KeyError(f"No service owner declared for: {service_name}") from exc
