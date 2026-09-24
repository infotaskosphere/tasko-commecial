"""
AIWeave Omni Capabilities & Model Registry
Centralized catalog of model capabilities, context windows, and cost metadata.
"""
from __future__ import annotations
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

class ModelCapability(BaseModel):
    id: str
    provider: str
    name: str
    context_window: int = 128000
    supports_vision: bool = False
    supports_tools: bool = True
    supports_json: bool = True
    supports_reasoning: bool = False
    supports_streaming: bool = True
    is_free: bool = False
    cost_tier: str = "UNKNOWN"
    input_cost_per_m: float = 0.0
    output_cost_per_m: float = 0.0
    capabilities: List[str] = Field(default_factory=list)

MODEL_CATALOG: Dict[str, ModelCapability] = {
    # OpenAI
    "gpt-5.6-sol": ModelCapability(
        id="gpt-5.6-sol", provider="openai", name="GPT-5.6 Sol",
        context_window=200000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=5.0, output_cost_per_m=15.0,
        capabilities=["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output","long_context"]
    ),
    "gpt-5.6-terra": ModelCapability(
        id="gpt-5.6-terra", provider="openai", name="GPT-5.6 Terra",
        context_window=128000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=2.5, output_cost_per_m=10.0,
        capabilities=["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]
    ),
    "gpt-5.6-luna": ModelCapability(
        id="gpt-5.6-luna", provider="openai", name="GPT-5.6 Luna",
        context_window=128000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=False, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=0.5, output_cost_per_m=1.5,
        capabilities=["chat","coding","vision","document_analysis","structured_output"]
    ),
    # Gemini
    "gemini-3.8-flash": ModelCapability(
        id="gemini-3.8-flash", provider="gemini", name="Gemini 3.8 Flash",
        context_window=1000000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        is_free=True, cost_tier="FREE", input_cost_per_m=0.075, output_cost_per_m=0.30,
        capabilities=["chat","reasoning","coding","vision","document_analysis","tool_calling","long_context","structured_output"]
    ),
    "gemini-3.1-pro-preview": ModelCapability(
        id="gemini-3.1-pro-preview", provider="gemini", name="Gemini 3.1 Pro",
        context_window=2000000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=1.25, output_cost_per_m=5.0,
        capabilities=["chat","reasoning","coding","vision","document_analysis","tool_calling","agent_execution","long_context","structured_output"]
    ),
    "gemini-2.5-flash": ModelCapability(
        id="gemini-2.5-flash", provider="gemini", name="Gemini 2.5 Flash",
        context_window=1000000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=False, supports_streaming=True,
        is_free=True, cost_tier="FREE", input_cost_per_m=0.075, output_cost_per_m=0.30,
        capabilities=["chat","reasoning","coding","vision","document_analysis","tool_calling","long_context","structured_output"]
    ),
    # Claude
    "claude-opus-5": ModelCapability(
        id="claude-opus-5", provider="claude", name="Claude Opus 5",
        context_window=200000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=15.0, output_cost_per_m=75.0,
        capabilities=["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","agent_execution","long_context","structured_output"]
    ),
    "claude-sonnet-5": ModelCapability(
        id="claude-sonnet-5", provider="claude", name="Claude Sonnet 5",
        context_window=200000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=3.0, output_cost_per_m=15.0,
        capabilities=["chat","reasoning","coding","debugging","vision","document_analysis","tool_calling","structured_output"]
    ),
    # xAI Grok
    "grok-4.6": ModelCapability(
        id="grok-4.6", provider="grok", name="Grok 4.6",
        context_window=131072, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=2.0, output_cost_per_m=10.0,
        capabilities=["chat","reasoning","coding","vision","tool_calling","agent_execution","structured_output"]
    ),
    # DeepSeek
    "deepseek-reasoner": ModelCapability(
        id="deepseek-reasoner", provider="deepseek", name="DeepSeek Reasoner",
        context_window=64000, supports_vision=False, supports_tools=False,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=0.55, output_cost_per_m=2.19,
        capabilities=["reasoning","coding","debugging","structured_output"]
    ),
    "deepseek-chat": ModelCapability(
        id="deepseek-chat", provider="deepseek", name="DeepSeek Chat",
        context_window=64000, supports_vision=False, supports_tools=True,
        supports_json=True, supports_reasoning=False, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=0.14, output_cost_per_m=0.28,
        capabilities=["chat","coding","tool_calling","structured_output"]
    ),
    # Qwen
    "qwen-plus": ModelCapability(
        id="qwen-plus", provider="qwen", name="Qwen Plus",
        context_window=131072, supports_vision=False, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=0.8, output_cost_per_m=2.0,
        capabilities=["chat","reasoning","coding","document_analysis","structured_output"]
    ),
    # Mistral
    "mistral-large-latest": ModelCapability(
        id="mistral-large-latest", provider="mistral", name="Mistral Large",
        context_window=128000, supports_vision=False, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="PAID", input_cost_per_m=2.0, output_cost_per_m=6.0,
        capabilities=["chat","reasoning","coding","document_analysis","tool_calling","structured_output"]
    ),
    # Groq
    "llama-3.3-70b-versatile": ModelCapability(
        id="llama-3.3-70b-versatile", provider="groq", name="Llama 3.3 70B Versatile",
        context_window=128000, supports_vision=False, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        is_free=True, cost_tier="FREE", input_cost_per_m=0.0, output_cost_per_m=0.0,
        capabilities=["chat","reasoning","coding","document_analysis","tool_calling","structured_output"]
    ),
    # OpenRouter
    "openrouter/auto": ModelCapability(
        id="openrouter/auto", provider="openrouter", name="OpenRouter Auto",
        context_window=128000, supports_vision=True, supports_tools=True,
        supports_json=True, supports_reasoning=True, supports_streaming=True,
        cost_tier="UNKNOWN", input_cost_per_m=1.0, output_cost_per_m=3.0,
        capabilities=["chat","reasoning","coding","vision","document_analysis","tool_calling"]
    ),
    # Ollama Local
    "qwen2.5-coder:32b": ModelCapability(
        id="qwen2.5-coder:32b", provider="ollama", name="Qwen 2.5 Coder 32B (Local)",
        context_window=32768, supports_vision=False, supports_tools=True,
        supports_json=True, supports_reasoning=False, supports_streaming=True,
        is_free=True, cost_tier="FREE", input_cost_per_m=0.0, output_cost_per_m=0.0,
        capabilities=["coding","debugging","tool_calling","structured_output"]
    ),
}

def get_model_capability(model_id: str, provider: Optional[str] = None) -> ModelCapability:
    if model_id in MODEL_CATALOG:
        return MODEL_CATALOG[model_id]
    
    # Generic fallback capability
    prov = provider or "unknown"
    return ModelCapability(
        id=model_id,
        provider=prov,
        name=model_id,
        context_window=64000,
        supports_vision=False,
        supports_tools=True,
        supports_json=True,
        supports_reasoning=False,
        supports_streaming=True,
        capabilities=["chat"]
    )
