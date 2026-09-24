"""
Google Gemini Provider Adapter
Supports Gemini models (gemini-3.8-flash, gemini-3.1-pro-preview, gemini-2.5-flash).
"""
from __future__ import annotations
import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional
import httpx
from backend.ai.omni.adapters.base import BaseProviderAdapter, ProviderError
from backend.ai.omni.models import OmniRequest, OmniResponse, OmniStreamChunk, TokenUsage

logger = logging.getLogger("aiweave.adapters.gemini")

class GeminiAdapter(BaseProviderAdapter):
    def __init__(self):
        super().__init__("gemini", "Google Gemini")

    def _classify_error(self, code: int, text: str) -> tuple[str, bool]:
        t = (text or "").lower()
        if "quota" in t or "resource_exhausted" in t or code == 429:
            return ("QUOTA_EXHAUSTED", False)
        if code in (401, 403) or "api_key_invalid" in t or "permission_denied" in t:
            return ("AUTH_REQUIRED", False)
        if code in (500, 503, 502):
            return ("PROVIDER_UNAVAILABLE", True)
        return ("NON_RETRYABLE_ACCOUNT_FAILURE", False)

    def validate_request(self, req: OmniRequest, model: str) -> None:
        pass

    def _prepare_gemini_contents(self, req: OmniRequest) -> tuple[List[Dict[str, Any]], Optional[Dict[str, Any]]]:
        contents: List[Dict[str, Any]] = []
        system_instruction = None

        if req.user_preferences.system_instruction or req.document_context:
            sys_text = req.user_preferences.system_instruction or ""
            if req.document_context:
                sys_text += f"\n\nDocument Context:\n{req.document_context.strip()}"
            system_instruction = {"parts": [{"text": sys_text.strip()}]}

        if req.messages:
            for m in req.messages:
                if isinstance(m, dict):
                    role = "user" if m.get("role") in ("user", "system") else "model"
                    content = m.get("content", "")
                else:
                    role = "user" if getattr(m, "role", "user") in ("user", "system") else "model"
                    content = getattr(m, "content", "")
                contents.append({
                    "role": role,
                    "parts": [{"text": content}]
                })
        elif req.prompt:
            contents.append({
                "role": "user",
                "parts": [{"text": req.prompt}]
            })

        return contents, system_instruction

    async def send_request(
        self,
        account: Dict[str, Any],
        key: str,
        model: str,
        req: OmniRequest,
        timeout: float = 60.0
    ) -> OmniResponse:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        contents, system_instruction = self._prepare_gemini_contents(req)

        body: Dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": req.user_preferences.temperature or 0.2
            }
        }
        if req.user_preferences.max_tokens:
            body["generationConfig"]["maxOutputTokens"] = req.user_preferences.max_tokens
        if system_instruction:
            body["systemInstruction"] = system_instruction
        if req.response_format and req.response_format.get("type") == "json_object":
            body["generationConfig"]["responseMimeType"] = "application/json"

        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": key
        }

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                resp = await client.post(url, headers=headers, json=body)
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Gemini request timed out.", status_code=504, retryable=True)
            except Exception as e:
                raise ProviderError("NETWORK_ERROR", f"Network error: {str(e)}", status_code=502, retryable=True)

        if resp.status_code != 200:
            err_text = resp.text[:500]
            kind, retryable = self._classify_error(resp.status_code, err_text)
            raise ProviderError(kind, f"[Gemini] {err_text}", status_code=resp.status_code, retryable=retryable)

        data = resp.json()
        candidates = data.get("candidates") or [{}]
        cand = candidates[0]
        content_obj = cand.get("content") or {}
        parts = content_obj.get("parts") or []
        output_text = "".join(str(p.get("text") or "") for p in parts if isinstance(p, dict))
        usage_meta = data.get("usageMetadata") or {}
        inp = int(usage_meta.get("promptTokenCount", 0) or 0)
        out = int(usage_meta.get("candidatesTokenCount", 0) or 0)

        return OmniResponse(
            id=f"gemini-{uuid.uuid4().hex[:12]}",
            content=output_text,
            model=model,
            provider="gemini",
            provider_name=self.name,
            account_id=account.get("id"),
            account_name=account.get("name"),
            finish_reason=cand.get("finishReason", "STOP").lower(),
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
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
        contents, system_instruction = self._prepare_gemini_contents(req)

        body: Dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": req.user_preferences.temperature or 0.2
            }
        }
        if req.user_preferences.max_tokens:
            body["generationConfig"]["maxOutputTokens"] = req.user_preferences.max_tokens
        if system_instruction:
            body["systemInstruction"] = system_instruction
        if req.response_format and req.response_format.get("type") == "json_object":
            body["generationConfig"]["responseMimeType"] = "application/json"

        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": key
        }
        chunk_id = f"gemini-stream-{uuid.uuid4().hex[:12]}"

        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                async with client.stream("POST", url, headers=headers, json=body) as resp:
                    if resp.status_code != 200:
                        err_bytes = await resp.aread()
                        err_text = err_bytes.decode("utf-8", errors="ignore")[:500]
                        kind, retryable = self._classify_error(resp.status_code, err_text)
                        raise ProviderError(kind, f"[Gemini] {err_text}", status_code=resp.status_code, retryable=retryable)

                    yield OmniStreamChunk(
                        id=chunk_id,
                        event="start",
                        model=model,
                        provider="gemini"
                    )

                    async for line in resp.aiter_lines():
                        if not line or not line.strip():
                            continue
                        clean = line.strip()
                        if clean.startswith("data: "):
                            clean = clean[6:].strip()
                        try:
                            parsed = json.loads(clean)
                            cands = parsed.get("candidates") or []
                            if cands:
                                cand = cands[0]
                                parts = (cand.get("content") or {}).get("parts") or []
                                text_piece = "".join(str(p.get("text") or "") for p in parts if isinstance(p, dict))
                                if text_piece:
                                    yield OmniStreamChunk(
                                        id=chunk_id,
                                        event="chunk",
                                        delta=text_piece,
                                        model=model,
                                        provider="gemini"
                                    )
                                finish_r = cand.get("finishReason")
                                if finish_r:
                                    yield OmniStreamChunk(
                                        id=chunk_id,
                                        event="finish",
                                        finish_reason=finish_r.lower(),
                                        model=model,
                                        provider="gemini"
                                    )
                        except json.JSONDecodeError:
                            continue
            except httpx.TimeoutException:
                raise ProviderError("TIMEOUT", "Gemini stream timed out.", status_code=504, retryable=True)
            except ProviderError:
                raise
            except Exception as e:
                raise ProviderError("NETWORK_ERROR", f"Gemini stream network error: {str(e)}", status_code=502, retryable=True)

    async def health_check(self, account: Dict[str, Any], key: str) -> Dict[str, Any]:
        url = "https://generativelanguage.googleapis.com/v1beta/models"
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers={"x-goog-api-key": key}, params={"pageSize": 1})
        if resp.status_code != 200:
            kind, _ = self._classify_error(resp.status_code, resp.text)
            raise ProviderError(kind, f"Gemini health check failed: {resp.text[:300]}", status_code=resp.status_code)
        return {"healthy": True, "count": 1, "message": "Google Gemini verified."}

    async def discover_models(self, account: Dict[str, Any], key: str) -> List[Dict[str, Any]]:
        url = "https://generativelanguage.googleapis.com/v1beta/models"
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(url, headers={"x-goog-api-key": key}, params={"pageSize": 1000})
        if resp.status_code != 200:
            return []
        data = resp.json()
        models = data.get("models") or []
        out = []
        for x in models:
            mid = str(x.get("name", "")).replace("models/", "")
            if mid:
                out.append({
                    "id": mid,
                    "provider": "gemini",
                    "name": x.get("displayName") or mid,
                    "capabilities": ["chat", "vision", "long_context"],
                    "availability": "discovered"
                })
        return out
