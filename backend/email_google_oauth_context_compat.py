"""Bind saved commercial tenant identity during the Gmail OAuth callback.

Google redirects back without the Taskosphere bearer/session context that was
present when OAuth was started. The OAuth state record is therefore the trusted
server-side bridge for the callback's company/customer identity.
"""

from __future__ import annotations

from typing import Optional

from fastapi import Query, Request

from backend import email_google_oauth as _oauth
from backend.dependencies import _raw_db
from backend.commercial_tenant_scope import (
    reset_authenticated_customer,
    set_authenticated_customer,
)
from backend.tenant_runtime import (
    reset_authenticated_company,
    set_authenticated_company,
)

_STATE_COLLECTION = _oauth.GOOGLE_OAUTH_STATE_COLLECTION
_TARGET_PATH = "/oauth/google/callback"


def _find_callback_route():
    for route in _oauth.router.routes:
        if getattr(route, "path", "") == _TARGET_PATH and hasattr(route, "endpoint"):
            return route
    return None


async def _callback_with_saved_context(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
):
    state_value = state or request.query_params.get("state")
    state_doc = None
    if state_value:
        state_doc = await _raw_db[_STATE_COLLECTION].find_one(
            {"state": state_value},
            {"company_id": 1, "commercial_customer_id": 1},
        )

    company_id = str((state_doc or {}).get("company_id") or "").strip()
    customer_id = str((state_doc or {}).get("commercial_customer_id") or "").strip()

    company_token = None
    customer_token = None
    try:
        if company_id:
            company_token = set_authenticated_company(company_id)
        if customer_id:
            customer_token = set_authenticated_customer(customer_id)
        return await _oauth.google_gmail_oauth_callback(
            request,
            code=code,
            state=state,
            error=error,
        )
    finally:
        if customer_token is not None:
            reset_authenticated_customer(customer_token)
        if company_token is not None:
            reset_authenticated_company(company_token)


def install() -> None:
    route = _find_callback_route()
    if route is None:
        return
    if getattr(route.endpoint, "__name__", "") == "_callback_with_saved_context":
        return
    route.endpoint = _callback_with_saved_context


install()
