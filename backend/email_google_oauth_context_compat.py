"""Compatibility fixes for the direct Gmail OAuth flow.

Google redirects back without the Taskosphere bearer/session context that was
present when OAuth was started. The OAuth state record is therefore the trusted
server-side bridge for the callback's company/customer identity.

This module also normalizes Gmail connection output because the legacy
email_integration connection serializer returns a Pydantic ``ConnectionOut``
model, while the first Gmail adapter attempted to mutate it like a dict.
"""

from __future__ import annotations

from typing import Optional, Any

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


def _safe_conn_doc_to_out(doc: dict[str, Any]):
    """Serialize a connection without assuming the legacy serializer returns a dict."""
    original = getattr(_oauth, "_ORIGINAL_CONN_DOC_TO_OUT", None)
    if original is None:
        original = getattr(_oauth._email, "_conn_doc_to_out")

    out = original(doc)
    if hasattr(out, "model_dump"):
        data = out.model_dump()
    elif isinstance(out, dict):
        data = dict(out)
    else:
        return out

    if doc.get("auth_type") == "google_oauth":
        data["imap_host"] = "Google Gmail API"
        data["imap_port"] = 443
        # ConnectionOut does not expose auth_type/oauth_provider, so keep the
        # public response aligned with the existing model instead of mutating
        # a Pydantic instance with dictionary syntax.

    connection_model = getattr(_oauth._email, "ConnectionOut", None)
    if connection_model is not None and hasattr(connection_model, "model_validate"):
        return connection_model.model_validate(data)
    return data


def install() -> None:
    route = _find_callback_route()
    if route is not None and getattr(route.endpoint, "__name__", "") != "_callback_with_saved_context":
        route.endpoint = _callback_with_saved_context

    # email_google_oauth.py's serializer decorates the original serializer but
    # attempts item assignment on ConnectionOut. Replace that narrow adapter
    # with a model-safe serializer for both module references used at runtime.
    _oauth._conn_doc_to_out = _safe_conn_doc_to_out
    _oauth._email._conn_doc_to_out = _safe_conn_doc_to_out


install()
