"""Regression tests for the authentication dependency chain.

Several compatibility layers transplant code into the *same* ``get_current_user``
function object that every route captured at import time. On 2026-10-25 a second
transplant (entitlement hydration re-installed from ``bootstrap_server``)
replaced the public ``(request, credentials)`` dependency with a one-argument
body. FastAPI then called it with ``request=`` and every protected route
returned HTTP 500, while direct callers had the bearer token shifted into the
``request`` slot and got HTTP 401 ("Unable to sign in" in production).
"""
import asyncio
import inspect

import pytest
from fastapi.security import HTTPAuthorizationCredentials

import backend.server  # noqa: F401  (composes the full auth chain)
from backend import dependencies


def _positional(func):
    return func.__code__.co_varnames[: func.__code__.co_argcount]


def test_public_auth_dependency_keeps_request_and_credentials():
    auth = dependencies.get_current_user
    assert _positional(auth) == ("request", "credentials")
    assert list(inspect.signature(auth).parameters) == ["request", "credentials"]


def test_bearer_token_reaches_the_inner_auth_layer_intact(monkeypatch):
    received = {}

    async def spy(*args, **kwargs):
        received["args"] = args
        received["kwargs"] = kwargs
        raise RuntimeError("stop")

    monkeypatch.setitem(dependencies.__dict__, "_single_session_original_get_current_user", spy)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="token-123")
    with pytest.raises(RuntimeError):
        asyncio.run(dependencies.get_current_user(request=object(), credentials=creds))
    passed = list(received["args"]) + list(received["kwargs"].values())
    assert creds in passed, "the credentials object must be forwarded unchanged"
    assert not any(type(value).__name__ == "Depends" for value in passed), "a Depends() placeholder leaked into the call"


def test_entitlement_install_is_idempotent():
    from backend import commercial_license_entitlement_compat as compat

    before = dependencies.get_current_user.__code__
    compat.install()
    compat.install()
    assert dependencies.get_current_user.__code__ is before


def test_entitlement_hydration_is_still_in_the_chain():
    """The import-time install must remain wired into an inner auth layer."""
    import sys

    hydrated_layers = [
        name for name, module in list(sys.modules.items())
        if name.startswith("backend") and getattr(module, "__dict__", {}).get("_commercial_entitlement_patch_installed")
    ]
    assert hydrated_layers, "license entitlement hydration is not installed anywhere"


def test_activity_logger_forwards_credentials_to_two_argument_auth(monkeypatch):
    from backend import activity_log_ingestion

    seen = {}

    async def fake_auth(request, credentials):
        seen["credentials"] = credentials
        return "user"

    monkeypatch.setattr(dependencies, "get_current_user", fake_auth)
    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="abc")
    assert asyncio.run(activity_log_ingestion._call_auth_dependency(object(), creds)) == "user"
    assert seen["credentials"] is creds


def test_identity_resolver_unwraps_the_tenant_database_facade():
    """getattr(facade, "_raw_db") used to return a *collection* named _raw_db."""
    from backend.identity_hierarchy import _identity_database
    from backend.tenant_runtime import TenantAwareDatabase

    class FakeDatabase:
        def __getitem__(self, name):
            return ("collection", name)

    raw = FakeDatabase()
    assert _identity_database(TenantAwareDatabase(raw)) is raw
    assert _identity_database(raw) is raw
