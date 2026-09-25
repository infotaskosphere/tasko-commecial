"""Records document model migration boundary."""
try:
    from backend.models import Document
except ImportError:
    Document = None
__all__ = ["Document"]
