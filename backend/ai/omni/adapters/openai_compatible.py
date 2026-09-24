"""
OpenAI & OpenAI-Compatible Provider Adapter
Works with OpenAI, xAI Grok, Moonshot Kimi, DeepSeek, Qwen, Mistral, Meta Llama, Groq, OpenRouter, Together.
"""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional
import httpx
from backend.ai.omni.adapters.base import BaseProviderAdapter, ProviderError
from backend.ai.omni.models import OmniRequest, OmniResponse, OmniStreamChunk, TokenUsage

logger = logging.getLogger("aiweave.adapters.openai")

class OpenAICompatibleAdapter(BaseProviderAdapter):
    def __init__(self, provider_id: str, name: str, base_url: str):
        super().__init__(provider_id, name)
        self.base_url = base_url.rstrip("/")

    def _classify_error(self, code: int, text: str) -> tuple[str, bool]:
        t = (text or "").lower()
        if any(x in t for x in ("quota", "token limit", "tokens exhausted", "usage limit", "insufficient quota", "exceeded your current quota", "billing")):
            return ("QUOTA_EXHAUSTED", False)
        if code in (401, 403) or "unauthorized" in t or "invalid api key" in t:
            return ("AUTH_REQUIRED", False)
        if code == 429:
            return ("RATE_LIMITED", True)
        if code == 413 or "context length" in t or "maximum context" in t:
            return ("CAPACITY_EXHAUSTED", False)
        if code in (408, 409, 425, 502, 503, 504):
            return ("RETRYABLE_ACCOUNT_FAILURE", True)
        if code >= 500:
            return ("PROVIDER_UNAVAILABLE", True)
        return ("NON_RETRYABLE_ACCOUNT_FAILURE", False)

    def validate_request(self, req: OmniRequest, model: str) -> None:
        pass

    def _prepare_payload(self, req: OmniRequest, model: str, stream: bool = False) -> Dict[str, Any]:
        messages: List[Dict[str, Any]] = []
        if req.user_preferences.system_instruction:
            messages.append({"role": "system", "content": req.user_preferences.system_instruction})

        if req.document_context:
            doc_msg = (
                "Document context:\n"
                f"{req.document_context.strip()}\n\n"
                "Please use this document context to answer questions."
            )
            messages.append({"role": "system", "content": doc_msg})

        if req.messages:
            for m in req.messages:
                if isinstance(m, dict):
                    role = m.get("role", "user")
                    content = m.get("content", "")
                else:
                    role = getattr(m, "role", "user")
                    content = getattr(m, "content", "")
                messages.append({"role": role, "content": content})
        elif req.prompt:
            messages.append({"role": "user", "content": req.prompt})

        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "stream": stream,
        }
        if req.user_preferences.temperature is not None:
            payload["temperature"] = req.user_preferences.temperature
        if req.user_preferences.max_tokens:
            payload["max_tokens"] = req.user_preferences.max_tokens
        if req.user_preferences.top_p is not None:
            payload["top_p"] = req.user_preferences.top_p
        if req.tools:
            payload["tools"] = req.tools
        if req.response_format:
            payload["response_format"] = req.response_format
        return payload

    async def send_request(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> OmniResponse:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json"
        }
        if self.provider_id == "openrouter":
            headers["HTTP-Referer"] = "https://taskosphere.io"
            headers["X-Title"] = "Taskosphere AIWeave"

        payload = self._prepare_payload(req, model, stream=False)

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.post(url, headers=headers, json=payload)
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Provider request timed out.", status_code=504, retryable=True)
            except Exception as e:
                raise ProviderError("NETWORK_ERROR", f"Network error: {str(e)}", status_code=502, retryable=True)

        if resp.status_code != 200:
            err_text = resp.text[:500]
            kind, retryable = self._classify_error(resp.status_code, err_text)
            raise ProviderError(kind, f"[{self.name}] {err_text}", status_code=resp.status_code, retryable=retryable)

        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        usage_data = data.get("usage") or {}
        inp = int(usage_data.get("prompt_tokens", 0) or 0)
        out = int(usage_data.get("completion_tokens", 0) or 0)

        # Detect reasoning tokens / content (DeepSeek / OpenAI reasoning)
        reasoning = message.get("reasoning_content") or message.get("reasoning")

        return OmniResponse(
            id=data.get("id") or f"resp-{uuid.uuid4().hex[:12]}",
            content=str(message.get("content") or ""),
            reasoning_content=str(reasoning) if reasoning else None,
            model=model,
            provider=self.provider_id,
            provider_name=self.name,
            account_id=account.get("id"),
            account_name=account.get("name"),
            finish_reason=choice.get("finish_reason") or "stop",
            usage=TokenUsage(
                input_tokens=inp,
                output_tokens=out,
                total_tokens=inp + out,
                provider_reported=bool(inp or out)
            ),
            tool_calls=message.get("tool_calls") or []
        )

    async def stream_response(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> AsyncIterator[OmniStreamChunk]:
        url = f"{self.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json"
        }
        if self.provider_id == "openrouter":
            headers["HTTP-Referer"] = "https://taskosphere.io"
            headers["X-Title"] = "Taskosphere AIWeave"

        payload = self._prepare_payload(req, model, stream=True)
        chunk_id = f"stream-{uuid.uuid4().hex[:12]}"

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream("POST", url, headers=headers, json=payload) as resp:
                    if resp.status_code != 200:
                        err_content = await resp.aread()
                        err_text = err_content.decode("utf-8", errors="ignore")[:500]
                        kind, retryable = self._classify_error(resp.status_code, err_text)
                        raise ProviderError(kind, f"[{self.name}] {err_text}", status_code=resp.status_code, retryable=retryable)

                    yield OmniStreamChunk(
                        id=chunk_id,
                        event="start",
                        model=model,
                        provider=self.provider_id
                    )

                    async for line in resp.aiter_lines():
                        if not line or not line.strip():
                            continue
                        clean = line.strip()
                        if clean.startswith("data: "):
                            clean = clean[6:].strip()
                        if clean == "[DONE]":
                            yield OmniStreamChunk(
                                id=chunk_id,
                                event="finish",
                                finish_reason="stop",
                                model=model,
                                provider=self.provider_id
                            )
                            break
                        try:
                            parsed = json.loads(clean)
                            choice = (parsed.get("choices") or [{}])[0]
                            delta = choice.get("delta") or {}
                            text_piece = delta.get("content") or ""
                            reasoning_piece = delta.get("reasoning_content") or delta.get("reasoning") or None
                            finish_r = choice.get("finish_reason")

                            if text_piece:
                                yield OmniStreamChunk(
                                    id=chunk_id,
                                    event="chunk",
                                    delta=text_piece,
                                    model=model,
                                    provider=self.provider_id
                                )
                            if reasoning_piece:
                                yield OmniStreamChunk(
                                    id=chunk_id,
                                    event="reasoning",
                                    reasoning_delta=reasoning_piece,
                                    model=model,
                                    provider=self.provider_id
                                )
                            if finish_r:
                                yield OmniStreamChunk(
                                    id=chunk_id,
                                    event="finish",
                                    finish_reason=finish_r,
                                    model=model,
                                    provider=self.provider_id
                                )
                        except json.JSONDecodeError:
                            continue
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Provider stream timed out.", status_code=504, retryable=True)
            except ProviderError:
                raise
            except Exception as e:
                raise ProviderError("NETWORK_ERROR", f"Streaming network error: {str(e)}", status_code=502, retryable=True)

    async def health_check(self, account: Dict[str, Any], key: str) -> Dict[str, Any]:
        url = f"{self.base_url}/models"
        headers = {"Authorization": f"Bearer {key}"}
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            kind, _ = self._classify_error(resp.status_code, resp.text)
            raise ProviderError(kind, f"Health check failed: {resp.text[:300]}", status_code=resp.status_code)
        try:
            d = resp.json()
            models_list = d.get("data") or d.get("models") or []
            return {"healthy": True, "count": len(models_list), "message": f"{self.name} reachable."}
        except Exception:
            return {"healthy": True, "count": 0, "message": f"{self.name} reachable."}

    async def discover_models(self, account: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
        url = f"{self.base_url}/models"
        headers = {"Authorization": f"Bearer {key}"}
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            return []
        data = resp.json()
        items = data.get("data") or data.get("models") or []
        out = []
        for x in items:
            mid = str(x.get("id") or "")
            if mid:
                out.append({
                    "id": mid,
                    "provider": self.provider_id,
                    "name": mid,
                    "capabilities": ["chat"],
                    "availability": "discovered"
                })
        return out
