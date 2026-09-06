"""Central tenant-isolation helpers for the commercial SaaS backend.

The authenticated user's company is the authoritative tenant boundary. Request
payloads, query parameters, and path parameters must never be trusted to select
a different company.
"""

from __future__ import annotations

from typing import Any, Mapping

from fastapi import HTTPException, status


COMPANY_FIELD = "company_id"


def get_company_id(current_user: Any) -> str:
    """Return the authenticated user's company id or reject the request."""
    company_id = getattr(current_user, COMPANY_FIELD, None)
    if company_id is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with a company",
        )
    company_id = str(company_id).strip()
    if not company_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Authenticated user is not associated with a company",
        )
    return company_id


def company_filter(current_user: Any, extra: Mapping[str, Any] | None = None) -> dict[str, Any]:
    """Build a MongoDB filter rooted in the authenticated company."""
    query: dict[str, Any] = {COMPANY_FIELD: get_company_id(current_user)}
    if extra:
        query.update(dict(extra))
    return query


def enforce_company_value(current_user: Any, value: Any) -> str:
    """Validate an optional client-supplied company id against the session."""
    authenticated = get_company_id(current_user)
    if value is not None and str(value).strip() != authenticated:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cross-company access is not permitted",
        )
    return authenticated


def force_company_id(current_user: Any, record: dict[str, Any]) -> dict[str, Any]:
    """Return a copy whose company_id is always the authenticated tenant."""
    result = dict(record)
    result[COMPANY_FIELD] = get_company_id(current_user)
    return result


def assert_record_company(current_user: Any, record: Mapping[str, Any] | None) -> None:
    """Reject a record that does not belong to the authenticated company."""
    if record is None:
        return
    authenticated = get_company_id(current_user)
    record_company = record.get(COMPANY_FIELD)
    if record_company is None or str(record_company) != authenticated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Record not found",
        )
