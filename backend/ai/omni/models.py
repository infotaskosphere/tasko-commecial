"""
AIWeave Omni Route - Data Models & Contracts
Unified request, response, error and streaming event schemas.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Union
from pydantic import BaseModel, Field, field_validator, model_validator

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

class ChatMessage(BaseModel):
    role: str = Field(default="user", description="system | user | assistant | tool")
    content: str = Field(default="", description="Text content or message body")
    name: Optional[str] = None
    attachments: List[Dict[str, Any]] = Field(default_factory=list)
    tool_calls: Optional[List[Dict[str, Any]]] = None
    tool_call_id: Optional[str] = None

class UserPreferences(BaseModel):
    temperature: Optional[float] = Field(default=0.2, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=128000)
    top_p: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    frequency_penalty: Optional[float] = None
    presence_penalty: Optional[float] = None
    stop: Optional[List[str]] = None
    system_instruction: Optional[str] = Field(default=None, max_length=20000)

MAX_MESSAGES = 100
MAX_MESSAGE_CHARS = 100_000
MAX_TOTAL_CHARS = 400_000
ALLOWED_ROLES = {"system", "user", "assistant", "tool"}


class OmniRequest(BaseModel):
    messages: List[Union[ChatMessage, Dict[str, Any]]] = Field(default_factory=list, max_length=MAX_MESSAGES)
    prompt: Optional[str] = Field(default=None, max_length=MAX_MESSAGE_CHARS)
    model: str = Field(default="auto", max_length=160)
    provider: str = Field(default="auto", max_length=60)
    routing_mode: str = Field(default="balanced", max_length=40, description="auto | fast | balanced | quality | low_cost | reasoning | coding | long_context | vision | custom")
    stream: bool = Field(default=False)
    task_type: str = Field(default="chat", max_length=40, description="chat | reasoning | coding | debugging | vision | document_analysis | structured_output")
    required_capability: Optional[str] = Field(default=None, max_length=40)
    user_preferences: UserPreferences = Field(default_factory=UserPreferences)
    conversation_id: Optional[str] = Field(default=None, max_length=80)
    document_context: Optional[str] = Field(default=None, max_length=200_000)
    files: List[Dict[str, Any]] = Field(default_factory=list, max_length=20)
    tools: Optional[List[Dict[str, Any]]] = Field(default=None, max_length=64)
    response_format: Optional[Dict[str, Any]] = None  # e.g. {"type": "json_object"}
    idempotency_key: Optional[str] = Field(default=None, max_length=120)
    request_id: Optional[str] = Field(default=None, max_length=120)
    mock_simulate_exhaustion: bool = False

    @field_validator("messages")
    @classmethod
    def _bounded_messages(cls, v):
        for m in v:
            content = m.get("content", "") if isinstance(m, dict) else getattr(m, "content", "")
            role = m.get("role", "user") if isinstance(m, dict) else getattr(m, "role", "user")
            if role not in ALLOWED_ROLES:
                raise ValueError(f"Unsupported message role: {role!r}")
            if isinstance(content, str) and len(content) > MAX_MESSAGE_CHARS:
                raise ValueError("A message is longer than the 100,000 character limit.")
        return v

    @model_validator(mode="after")
    def _bounded_total(self):
        total = len(self.prompt or "") + len(self.document_context or "")
        for m in self.messages:
            c = m.get("content", "") if isinstance(m, dict) else getattr(m, "content", "")
            total += len(c) if isinstance(c, str) else 0
        if total > MAX_TOTAL_CHARS:
            raise ValueError("The request is too large. Shorten the conversation or the attached documents.")
        if not (self.prompt or "").strip() and not self.messages:
            raise ValueError("Send a prompt or at least one message.")
        return self

class TokenUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: Optional[float] = None
    provider_reported: bool = False

class FallbackAttempt(BaseModel):
    attempt: int
    provider: str
    account_id: Optional[str] = None
    account_name: Optional[str] = None
    model: Optional[str] = None
    status: str
    reason: Optional[str] = None
    latency_ms: Optional[int] = None
    timestamp: str = Field(default_factory=now_iso)

class OmniResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"omni-{uuid.uuid4().hex[:14]}")
    content: str = ""
    reasoning_content: Optional[str] = None
    model: str
    model_name: Optional[str] = None
    provider: str
    provider_name: Optional[str] = None
    account_id: Optional[str] = None
    account_name: Optional[str] = None
    finish_reason: str = "stop"
    usage: TokenUsage = Field(default_factory=TokenUsage)
    tool_calls: List[Dict[str, Any]] = Field(default_factory=list)
    fallback_trail: List[FallbackAttempt] = Field(default_factory=list)
    latency_ms: int = 0
    created_at: str = Field(default_factory=now_iso)
    metadata: Dict[str, Any] = Field(default_factory=dict)

class OmniStreamChunk(BaseModel):
    id: str
    event: str = Field(default="chunk", description="start | chunk | reasoning | tool_call | finish | error | fallback")
    delta: str = ""
    reasoning_delta: Optional[str] = None
    model: Optional[str] = None
    provider: Optional[str] = None
    finish_reason: Optional[str] = None
    usage: Optional[TokenUsage] = None
    error: Optional[Dict[str, Any]] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)

class OmniErrorDetail(BaseModel):
    code: str
    message: str
    retryable: bool = False
    fallback_attempted: bool = False
    details: Optional[Dict[str, Any]] = None
