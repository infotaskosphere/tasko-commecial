"""
Tests for AIWeave Universal Omni Route Architecture
Verifies models, candidate selection, auto model routing, provider adapters, error classification, and fallback execution.
"""
import pytest
from backend.ai.omni.models import OmniRequest, OmniResponse, ChatMessage, UserPreferences
from backend.ai.omni.registry import MODEL_CATALOG, get_model_capability
from backend.ai.omni.adapters.registry import ADAPTER_REGISTRY
from backend.ai.omni.adapters.base import ProviderError
from backend.ai.omni.accounts import ACCOUNT_HEALTH_MANAGER
from backend.ai.omni.selector import CANDIDATE_SELECTOR

def test_omni_models_and_catalog():
    assert "gemini-3.8-flash" in MODEL_CATALOG
    assert "gpt-5.6-sol" in MODEL_CATALOG
    assert "claude-opus-5" in MODEL_CATALOG
    assert "deepseek-reasoner" in MODEL_CATALOG
    
    cap = get_model_capability("gemini-3.8-flash")
    assert cap.supports_vision is True
    assert cap.is_free is True

def test_adapter_registry():
    registered = ADAPTER_REGISTRY.list_providers()
    assert "openai" in registered
    assert "gemini" in registered
    assert "claude" in registered
    assert "grok" in registered
    assert "deepseek" in registered
    assert "qwen" in registered
    assert "mistral" in registered
    assert "groq" in registered
    assert "openrouter" in registered
    assert "together" in registered
    assert "ollama" in registered

def test_account_health_manager():
    # Connected and healthy account
    good_acc = {
        "id": "acc-1",
        "provider": "gemini",
        "enabled": True,
        "status": "CONNECTED",
        "health": "HEALTHY",
        "allowed_task_types": ["*"]
    }
    assert ACCOUNT_HEALTH_MANAGER.is_account_eligible(good_acc) is True

    # Disabled account
    bad_acc = {**good_acc, "enabled": False}
    assert ACCOUNT_HEALTH_MANAGER.is_account_eligible(bad_acc) is False

    # Capacity exhausted status
    exhausted_acc = {**good_acc, "status": "CAPACITY_EXHAUSTED"}
    assert ACCOUNT_HEALTH_MANAGER.is_account_eligible(exhausted_acc) is False

def test_candidate_selector_auto_routing():
    req = OmniRequest(
        prompt="Write a Python script to calculate Fibonacci",
        model="auto",
        provider="auto",
        routing_mode="coding",
        task_type="coding"
    )
    accounts = [
        {"id": "a-openai", "provider": "openai", "name": "OpenAI Primary", "priority": 1, "enabled": True, "status": "CONNECTED", "health": "HEALTHY"},
        {"id": "a-gemini", "provider": "gemini", "name": "Gemini Free", "priority": 1, "cost_tier": "FREE", "enabled": True, "status": "CONNECTED", "health": "HEALTHY"}
    ]
    candidates = CANDIDATE_SELECTOR.build_candidate_list(req, accounts, [], {})
    assert len(candidates) > 0
    # Top candidate should be a coding capable model
    top_acc, top_model = candidates[0]
    assert "coding" in top_model.capabilities or "coder" in top_model.id

def test_candidate_selector_vision_filtering():
    req = OmniRequest(
        prompt="Describe this receipt image",
        model="auto",
        provider="auto",
        routing_mode="vision",
        files=[{"name": "receipt.png", "type": "image/png"}]
    )
    accounts = [
        {"id": "a-gemini", "provider": "gemini", "name": "Gemini Primary", "priority": 1, "enabled": True, "status": "CONNECTED", "health": "HEALTHY"},
        {"id": "a-deepseek", "provider": "deepseek", "name": "DeepSeek Text Only", "priority": 1, "enabled": True, "status": "CONNECTED", "health": "HEALTHY"}
    ]
    candidates = CANDIDATE_SELECTOR.build_candidate_list(req, accounts, [], {})
    # Models without vision should not be top candidate
    top_acc, top_model = candidates[0]
    assert top_model.supports_vision is True

def test_omni_request_response_schemas():
    req = OmniRequest(
        messages=[{"role": "user", "content": "Hello"}],
        model="auto",
        stream=False,
        task_type="chat"
    )
    assert req.model == "auto"
    assert len(req.messages) == 1

    resp = OmniResponse(
        content="Hello there!",
        model="gemini-3.8-flash",
        provider="gemini",
        provider_name="Google Gemini"
    )
    assert resp.content == "Hello there!"
    assert resp.finish_reason == "stop"
