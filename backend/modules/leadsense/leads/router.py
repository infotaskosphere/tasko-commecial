"""LeadSense leads migration adapter."""
from backend.leads import router

def register(namespace=None):
    return router

__all__ = ["router", "register"]
