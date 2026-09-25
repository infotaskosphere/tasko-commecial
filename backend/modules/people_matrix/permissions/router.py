"""People Matrix permission router migration adapter."""
from backend.permission_governance import router

def register(namespace=None):
    return router

__all__ = ["router", "register"]
