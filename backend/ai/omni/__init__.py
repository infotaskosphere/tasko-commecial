"""
AIWeave Omni Package Init
"""
from backend.ai.omni.models import (
    OmniRequest, OmniResponse, OmniStreamChunk, OmniErrorDetail, ChatMessage, UserPreferences
)
from backend.ai.omni.registry import MODEL_CATALOG, ModelCapability, get_model_capability
from backend.ai.omni.adapters.base import BaseProviderAdapter, ProviderError
from backend.ai.omni.adapters.registry import ADAPTER_REGISTRY
from backend.ai.omni.accounts import ACCOUNT_HEALTH_MANAGER
from backend.ai.omni.selector import CANDIDATE_SELECTOR
from backend.ai.omni.engine import FallbackEngine

__all__ = [
    "OmniRequest", "OmniResponse", "OmniStreamChunk", "OmniErrorDetail",
    "ChatMessage", "UserPreferences", "MODEL_CATALOG", "ModelCapability",
    "get_model_capability", "BaseProviderAdapter", "ProviderError",
    "ADAPTER_REGISTRY", "ACCOUNT_HEALTH_MANAGER", "CANDIDATE_SELECTOR", "FallbackEngine"
]
