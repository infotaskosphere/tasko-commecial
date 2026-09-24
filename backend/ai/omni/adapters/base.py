"""
AIWeave Omni Provider Adapter Base
Defines the standard abstract contract for all LLM provider adapters.
"""
from __future__ import annotations
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Dict, List, Optional
from backend.ai.omni.models import OmniRequest, OmniResponse, OmniStreamChunk, TokenUsage

class ProviderError(Exception):
    def __init__(self, kind: str, message: str, status_code: int = 500, retryable: bool = False):
        super().__init__(message)
        self.kind = kind
        self.message = message
        self.status_code = status_code
        self.retryable = retryable

class BaseProviderAdapter(ABC):
    provider_id: str
    name: str

    def __init__(self, provider_id: str, name: str):
        self.provider_id = provider_id
        self.name = name

    @abstractmethod
    def validate_request(self, req: OmniRequest, model: str) -> None:
        """Validate whether the requested model and options can be serviced by this provider."""
        pass

    @abstractmethod
    async def send_request(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> OmniResponse:
        """Execute a non-streaming completion and return normalized OmniResponse."""
        pass

    @abstractmethod
    async def stream_response(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> AsyncIterator[OmniStreamChunk]:
        """Stream normalized chunks yielding OmniStreamChunk."""
        pass

    @abstractmethod
    async def health_check(self, account: Dict[str, Any], key: str) -> Dict[str, Any]:
        """Check authentication, network reachability, and account status."""
        pass

    @abstractmethod
    async def discover_models(self, account: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
        """Query provider API for available models."""
        pass
