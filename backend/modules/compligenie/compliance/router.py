"""CompliGenie compliance migration adapter."""
from backend.compliance import router

def register(namespace=None):
    return router

__all__ = ["router", "register"]
