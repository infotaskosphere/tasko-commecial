"""AIWeave Omni migration facade.

The production implementation remains in backend.ai.omni.engine during the
migration period.
"""

from backend.ai.omni.engine import FallbackEngine

__all__ = ["FallbackEngine"]
