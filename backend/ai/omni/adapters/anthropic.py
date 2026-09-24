"""
Anthropic Claude Provider Adapter
Supports Claude Opus 5, Sonnet 5, Haiku, etc.
"""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional
import httpx
from backend.ai.omni.adapters.base import BaseProviderAdapter, ProviderError
from backend.ai.omni.models import OmniRequest, OmniResponse, OmniStreamChunk, TokenUsage

logger = logging.getLogger("aiweave.adapters.claude")

class AnthropicAdapter(BaseProviderAdapter):
    def __init__(self):
        super().__init__("claude", "Anthropic Claude")

    def _classify_error(self, code: int, text: str) -> tuple[str, bool]:
        t = (text or "").lower()
        if "quota" in t or "credit" in t or "usage limit" in t:
            return ("QUOTA_EXHAUSTED", False)
        if code in (401, 403) or "authentication" in t or "invalid api key" in t:
            return ("AUTH_REQUIRED", False)
        if code == 429:
            return ("RATE_LIMITED", True)
        if code in (500, 529, 503, 502):
            return ("PROVIDER_UNAVAILABLE", True)
        return ("NON_RETRYABLE_ACCOUNT_FAILURE", False)

    def validate_request(self, req: OmniRequest, model: str) -> None:
        pass

    def _prepare_claude_messages(self, req: OmniRequest) -> tuple[List[Dict[str, Any]], Optional[str]]:
        messages: List[Dict[str, Any]] = []
        system_prompt: Optional[str] = req.user_preferences.system_instruction

        if req.document_context:
            doc_context = f"Document context:\n{req.document_context.strip()}"
            system_prompt = f"{system_prompt}\n\n{doc_context}" if system_prompt else doc_context

        if req.messages:
            for m in req.messages:
                if isinstance(m, dict):
                    role = m.get("role", "user")
                    content = m.get("content", "")
                else:
                    role = getattr(m, "role", "user")
                    content = getattr(m, "content", "")
                if role == "system":
                    system_prompt = f"{system_prompt}\n\n{content}" if system_prompt else content
                    continue
                messages.append({"role": role, "content": content})
        elif req.prompt:
            messages.append({"role": "user", "content": req.prompt})

        return messages, system_prompt

    async def send_request(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> OmniResponse:
        url = "https://api.anthropic.com/v1/messages"
        messages, system_prompt = self._prepare_claude_messages(req)

        body: Dict[str, Any] = {
            "model": model,
            "max_tokens": req.user_preferences.max_tokens or 4096,
            "messages": messages,
            "temperature": req.user_preferences.temperature or 0.2
        }
        if system_prompt:
            body["system"] = system_prompt
        if req.tools:
            body["tools"] = req.tools

        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.post(url, headers=headers, json=body)
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Claude request timed out.", status_code=504, retryable=True)
            except Exception as e:
                raise ProviderError("NETWORK_ERROR", f"Network error: {str(e)}", status_code=502, retryable=True)

        if resp.status_code != 200:
            err_text = resp.text[:500]
            kind, retryable = self._classify_error(resp.status_code, err_text)
            raise ProviderError(kind, f"[Claude] {err_text}", status_code=resp.status_code, retryable=retryable)

        data = resp.json()
        content_list = data.get("content") or []
        output_text = "".join(str(x.get("text") or "") for x in content_list if x.get("type") == "text")
        usage_data = data.get("usage") or {}
        inp = int(usage_data.get("input_tokens", 0) or 0)
        out = int(usage_data.get("output_tokens", 0) or 0)

        return OmniResponse(
            id=data.get("id") or f"claude-{uuid.uuid4().hex[:12]}",
            content=output_text,
            model=model,
            provider="claude",
            provider_name=self.name,
            account_id=account.get("id"),
            account_name=account.get("name"),
            finish_reason=data.get("stop_reason") or "end_turn",
            usage=TokenUsage(
                input_tokens=inp,
                output_tokens=out,
                total_tokens=inp + out,
                provider_reported=bool(inp or out)
            )
        )

    async def stream_response(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> AsyncIterator[OmniStreamChunk]:
        url = "https://api.anthropic.com/v1/messages"
        messages, system_prompt = self._prepare_claude_messages(req)

        body: Dict[str, Any] = {
            "model": model,
            "max_tokens": req.user_preferences.max_tokens or 4096,
            "messages": messages,
            "stream": True,
            "temperature": req.user_preferences.temperature or 0.2
        }
        if system_prompt:
            body["system"] = system_prompt

        headers = {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
        }
        chunk_id = f"claude-stream-{uuid.uuid4().hex[:12]}"

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream("POST", url, headers=headers, json=body) as resp:
                    if resp.status_code != 200:
                        err_bytes = await resp.aread()
                        err_text = err_bytes.decode("utf-8", errors="ignore")[:500]
                        kind, retryable = self._classify_error(resp.status_code, err_text)
                        raise ProviderError(kind, f"[Claude] {err_text}", status_code=resp.status_code, retryable=retryable)

                    yield OmniStreamChunk(
                        id=chunk_id,
                        event="start",
                        model=model,
                        provider="claude"
                    )

                    async for line in resp.aiter_lines():
                        if not line or not line.strip():
                            continue
                        clean = line.strip()
                        if clean.startswith("data: "):
                            clean = clean[6:].strip()
                        try:
                            parsed = json.loads(clean)
                            event_type = parsed.get("type")
                            if event_type == "content_block_delta":
                                delta_text = (parsed.get("delta") or {}).get("text") or ""
                                if delta_text:
                                    yield OmniStreamChunk(
                                        id=chunk_id,
                                        event="chunk",
                                        delta=delta_text,
                                        model=model,
                                        provider="claude"
                                    )
                            elif event_type == "message_stop":
                                yield OmniStreamChunk(
                                    id=chunk_id,
                                    event="finish",
                                    finish_reason="end_turn",
                                    model=model,
                                    provider="claude"
                                )
                        except json.JSONDecodeError:
                            continue
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Claude stream timed out.", status_code=504, retryable=True)
            except ProviderError:
                raise
            except Exception as e:
                raise ProviderError("NETWORK_ERROR", f"Claude stream network error: {str(e)}", status_code=502, retryable=True)

    async def health_check(self, account: Dict[str, Any], key: str) -> Dict[str, Any]:
        url = "https://api.anthropic.com/v1/models"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            kind, _ = self._classify_error(resp.status_code, resp.text)
            raise ProviderError(kind, f"Claude health check failed: {resp.text[:300]}", status_code=resp.status_code)
        return {"healthy": True, "count": 1, "message": "Anthropic Claude verified."}

    async def discover_models(self, account: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
        url = "https://api.anthropic.com/v1/models"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            return []
        data = resp.json()
        items = data.get("data") or []
        out = []
        for x in items:
            mid = str(x.get("id") or "")
            if mid:
                out.append({
                    "id": mid,
                    "provider": "claude",
                    "name": x.get("display_name") or mid,
                    "capabilities": ["chat", "reasoning", "coding"],
                    "availability": "discovered"
                })
        return out
