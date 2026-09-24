"""
AIWeave Omni Provider Adapter Registry
Instantiates and routes to appropriate adapter implementation for any provider.
New providers are simply registered here without changing router logic.
"""
from __future__ import annotations
from typing import Dict, List, Optional
from backend.ai.omni.adapters.base import BaseProviderAdapter
from backend.ai.omni.adapters.openai_compatible import OpenAICompatibleAdapter
from backend.ai.omni.adapters.gemini import GeminiAdapter
from backend.ai.omni.adapters.anthropic import AnthropicAdapter
from backend.ai.omni.adapters.ollama import OllamaAdapter

# Endpoint base URLs for standard OpenAI-compatible providers
OPENAI_COMPATIBLE_BASES = {
    "openai": ("OpenAI / ChatGPT", "https://api.openai.com/v1"),
    "grok": ("xAI Grok", "https://api.x.ai/v1"),
    "kimi": ("Moonshot AI / Kimi", "https://api.moonshot.ai/v1"),
    "deepseek": ("DeepSeek", "https://api.deepseek.com/v1"),
    "qwen": ("Alibaba Qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
    "mistral": ("Mistral AI", "https://api.mistral.ai/v1"),
    "llama": ("Meta Llama (Groq)", "https://api.groq.com/openai/v1"),
    "groq": ("Groq LPU", "https://api.groq.com/openai/v1"),
    "openrouter": ("OpenRouter", "https://openrouter.ai/api/v1"),
    "together": ("Together AI", "https://api.together.xyz/v1"),
}

class AdapterRegistry:
    def __init__(self):
        self._adapters: Dict[str, BaseProviderAdapter] = {}
        self._register_defaults()

    def _register_defaults(self):
        # Dedicated custom adapters
        self.register_adapter(GeminiAdapter())
        self.register_adapter(AnthropicAdapter())
        self.register_adapter(OllamaAdapter())

        # OpenAI compatible providers
        for pid, (name, base_url) in OPENAI_COMPATIBLE_BASES.items():
            self.register_adapter(OpenAICompatibleAdapter(pid, name, base_url))

    def register_adapter(self, adapter: BaseProviderAdapter):
        self._adapters[adapter.provider_id] = adapter

    def get_adapter(self, provider_id: str) -> Optional[BaseProviderAdapter]:
        return self._adapters.get(provider_id)

    def list_providers(self) -> List[str]:
        return list(self._adapters.keys())

ADAPTER_REGISTRY = AdapterRegistry()
