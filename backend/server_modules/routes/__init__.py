"""Route modules that used to run from exec()'d SOURCE strings.

Each module here is ordinary Python with explicit imports. backend/server.py
still loads them in the original order through the small register_*()
functions in backend/server_modules/, which call load_into(): import the module
(running its route decorators) and copy its public names into backend.server's
namespace, so code that reads ``backend.server.<name>`` keeps working.
"""
from __future__ import annotations

import importlib
from typing import Any, MutableMapping

# Modules whose frames count as "backend.server" for stack-based trust checks
# (see backend/commercial_user_company_scope.py).
ROUTE_MODULE_PREFIX = __name__ + "."


def load_into(name: str, namespace: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    module = importlib.import_module(f"{__name__}.{name}")
    for key, value in vars(module).items():
        if not key.startswith("__"):
            namespace[key] = value
    return namespace
