"""Authentication regressions for browser requests arriving after logout."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from backend.commercial_auth_bootstrap_compat import _raw_get_current_user


@pytest.mark.parametrize(
    "credentials",
    [
        None,
        SimpleNamespace(credentials=""),
        SimpleNamespace(credentials=None),
        SimpleNamespace(),
    ],
)
def test_missing_bearer_credentials_return_401_not_500(credentials):
    with pytest.raises(HTTPException) as exc:
        asyncio.run(_raw_get_current_user(credentials))

    assert exc.value.status_code == 401
    assert exc.value.detail == "Could not validate credentials"
    assert exc.value.headers == {"WWW-Authenticate": "Bearer"}
