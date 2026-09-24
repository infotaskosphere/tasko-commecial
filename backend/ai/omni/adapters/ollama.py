"""
Ollama Local Inference Provider Adapter
Supports local models (Qwen 2.5 Coder, Llama 3.3, Mistral, etc.) running on host or remote endpoint.
"""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional
import httpx
from backend.ai.omni.adapters.base import BaseProviderAdapter, ProviderError
from backend.ai.omni.models import OmniRequest, OmniResponse, OmniStreamChunk, TokenUsage

logger = logging.getLogger("aiweave.adapters.ollama")

class OllamaAdapter(BaseProviderAdapter):
    def __init__(self):
        super().__init__("ollama", "Ollama (Local)")

    def validate_request(self, req: OmniRequest, model: str) -> None:
        pass

    def _prepare_payload(self, req: OmniRequest, model: str, stream: bool = False) -> Dict[str, Any]:
        messages: List[Dict[str, Any]] = []
        if req.user_preferences.system_instruction:
            messages.append({"role": "system", "content": req.user_preferences.system_instruction})

        if req.document_context:
            messages.append({"role": "system", "content": f"Document context:\n{req.document_context.strip()}"})

        if req.messages:
            for m in req.messages:
                if isinstance(m, dict):
                    messages.append({"role": m.get("role", "user"), "content": m.get("content", "")})
                else:
                    messages.append({"role": getattr(m, "role", "user"), "content": getattr(m, "content", "")})
        elif req.prompt:
            messages.append({"role": "user", "content": req.prompt})

        return {
            "model": model,
            "messages": messages,
            "stream": stream,
            "options": {
                "temperature": req.user_preferences.temperature or 0.2
            }
        }

    async def send_request(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> OmniResponse:
        base = (account.get("base_url") or "http://127.0.0.1:11434").rstrip("/")
        url = f"{base}/api/chat"
        payload = self._prepare_payload(req, model, stream=False)

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.post(url, json=payload)
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Ollama request timed out.", status_code=504, retryable=True)
            except Exception as e:
                raise ProviderError("PROVIDER_UNAVAILABLE", f"Ollama unreachable: {str(e)}", status_code=503, retryable=True)

        if resp.status_code != 200:
            raise ProviderError("NON_RETRYABLE_ACCOUNT_FAILURE", f"Ollama error: {resp.text[:300]}", status_code=resp.status_code)

        data = resp.json()
        msg = data.get("message") or {}
        inp = int(data.get("prompt_eval_count", 0) or 0)
        out = int(data.get("eval_count", 0) or 0)

        return OmniResponse(
            id=f"ollama-{uuid.uuid4().hex[:12]}",
            content=str(msg.get("content") or ""),
            model=model,
            provider="ollama",
            provider_name=self.name,
            account_id=account.get("id"),
            account_name=account.get("name"),
            finish_reason="stop",
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
        base = (account.get("base_url") or "http://127.0.0.1:11434").rstrip("/")
        url = f"{base}/api/chat"
        payload = self._prepare_payload(req, model, stream=True)
        chunk_id = f"ollama-stream-{uuid.uuid4().hex[:12]}"

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream("POST", url, json=payload) as resp:
                    if resp.status_code != 200:
                        err_content = await resp.aread()
                        raise ProviderError("NON_RETRYABLE_ACCOUNT_FAILURE", f"Ollama stream error: {err_content.decode()[:300]}")

                    yield OmniStreamChunk(
                        id=chunk_id,
                        event="start",
                        model=model,
                        provider="ollama"
                    )

                    async for line in resp.aiter_lines():
                        if not line or not line.strip():
                            continue
                        try:
                            parsed = json.loads(line)
                            msg = parsed.get("message") or {}
                            delta_text = msg.get("content") or ""
                            if delta_text:
                                yield OmniStreamChunk(
                                    id=chunk_id,
                                    event="chunk",
                                    delta=delta_text,
                                    model=model,
                                    provider="ollama"
                                )
                            if parsed.get("done"):
                                yield OmniStreamChunk(
                                    id=chunk_id,
                                    event="finish",
                                    finish_reason="stop",
                                    model=model,
                                    provider="ollama"
                                )
                        except json.JSONDecodeError:
                            continue
            except Exception as e:
                raise ProviderError("PROVIDER_UNAVAILABLE", f"Ollama streaming error: {str(e)}", retryable=True)

    async def health_check(self, account: Dict[str, Any], key: str) -> Dict[str, Any]:
        base = (account.get("base_url") or "http://127.0.0.1:11434").rstrip("/")
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/api/tags")
        if resp.status_code != 200:
            raise ProviderError("PROVIDER_UNAVAILABLE", "Ollama instance is offline or unreachable.")
        return {"healthy": True, "count": len(resp.json().get("models", [])), "message": "Ollama local verified."}

    async def discover_models(self, account: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
        base = (account.get("base_url") or "http://127.0.0.1:11434").rstrip("/")
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{base}/api/tags")
        if resp.status_code != 200:
            return []
        items = resp.json().get("models") or []
        out = []
        for x in items:
            name = str(x.get("name") or "")
            if name:
                out.append({
                    "id": name,
                    "provider": "ollama",
                    "name": name,
                    "capabilities": ["chat", "coding"],
                    "availability": "discovered",
                    "isLocal": True,
                    "isFree": True
                })
        return out
