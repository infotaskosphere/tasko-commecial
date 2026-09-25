"""Records documents migration boundary."""
from backend.server_modules.document_routes import register_document_routes

def register(namespace):
    return register_document_routes(namespace)

__all__ = ["register"]
