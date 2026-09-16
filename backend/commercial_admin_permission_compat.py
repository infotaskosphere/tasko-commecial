"""Synchronize commercial administrator permissions with the active license.

The runtime entitlement layer is the canonical license cap. This compatibility
module remains import-safe for older commercial deployments, but it must not
replace FastAPI authentication dependencies at import time: doing so can make
already-registered routes retain a different dependency signature and produce
HTTP 422 validation errors.
"""

from backend import dependencies as _dependencies

_INSTALLED = False


def install() -> None:
    """Keep the existing authentication dependency graph unchanged.

    Commercial page entitlements are applied by
    ``commercial_entitlement_runtime`` during the existing permission
    normalization path. FastAPI routes must continue to use the original
    ``dependencies.get_current_user`` dependency object that was registered
    when the application routers were imported.
    """
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True

    # Preserve the original dependency explicitly for compatibility modules
    # that introspect this bridge. No route dependency is replaced here.
    _dependencies.get_current_user
