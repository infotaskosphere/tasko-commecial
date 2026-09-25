"""AIWeave router migration facade.

The existing production router remains authoritative. This facade provides
the future module import boundary without changing registration order.
"""

from backend.ai.aiweave_router import create_aiweave_indexes, router

__all__ = ["router", "create_aiweave_indexes"]
