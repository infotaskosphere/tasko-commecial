"""
AIWeave Omni Execution & Fallback Engine
Coordinates candidate attempts, adapter execution, fallback logic, streaming, and telemetry tracking.
"""
from __future__ import annotations
import logging
import time
import uuid
from typing import Any, AsyncIterator, Callable, Dict, List, Optional
from backend.ai.omni.models import (
    OmniRequest, OmniResponse, OmniStreamChunk, FallbackAttempt, TokenUsage
)
from backend.ai.omni.adapters.base import ProviderError
from backend.ai.omni.adapters.registry import ADAPTER_REGISTRY
from backend.ai.omni.selector import CANDIDATE_SELECTOR
from backend.ai.omni.accounts import ACCOUNT_HEALTH_MANAGER

logger = logging.getLogger("aiweave.fallback_engine")


def estimate_tokens(text: str) -> int:
    """Rough token estimate (about four characters per token) for providers that
    do not report usage while streaming."""
    return max(0, (len(text or "") + 3) // 4)


def estimate_input_tokens(req: OmniRequest) -> int:
    parts: List[str] = [req.prompt or "", req.document_context or "", req.user_preferences.system_instruction or ""]
    for m in req.messages or []:
        parts.append(str(m.get("content", "") if isinstance(m, dict) else getattr(m, "content", "")))
    return estimate_tokens("\n".join(parts))

class FallbackEngine:
    MAX_TOTAL_ATTEMPTS = 12

    def __init__(
        self,
        decrypt_fn: Callable[[str], str],
        touch_account_fn: Callable[..., Any],
        record_execution_fn: Callable[..., Any]
    ):
        self.decrypt_fn = decrypt_fn
        self.touch_account_fn = touch_account_fn
        self.record_execution_fn = record_execution_fn

    async def execute_request(
        self,
        req: OmniRequest,
        accounts: List[Dict[str, Any]],
        discovered_models: List[Dict[str, Any]],
        routing_config: Dict[str, Any],
        user: Any = None,
        scope_info: Dict[str, Any] = None
    ) -> OmniResponse:
        candidates = CANDIDATE_SELECTOR.build_candidate_list(
            req, accounts, discovered_models, routing_config
        )

        if not candidates:
            raise ProviderError(
                "PROVIDER_UNAVAILABLE",
                "No healthy AI providers or compatible models are currently available.",
                status_code=503
            )

        trail: List[FallbackAttempt] = []
        max_attempts = min(self.MAX_TOTAL_ATTEMPTS, int(routing_config.get("maxTotalAttempts", 12)))
        timeout = float(routing_config.get("timeoutMs", 60000)) / 1000.0

        attempts = 0
        started = time.perf_counter()

        for account, model_cap in candidates:
            if attempts >= max_attempts:
                break
            attempts += 1
            pid = account.get("provider")
            adapter = ADAPTER_REGISTRY.get_adapter(pid)
            if not adapter:
                trail.append(FallbackAttempt(
                    attempt=attempts,
                    provider=pid,
                    account_id=account.get("id"),
                    account_name=account.get("name"),
                    model=model_cap.id,
                    status="NO_ADAPTER",
                    reason=f"No provider adapter registered for {pid}."
                ))
                continue

            key = self.decrypt_fn(account.get("credential_encrypted", ""))
            attempt_start = time.perf_counter()

            # Mock simulation flag for testing
            if req.mock_simulate_exhaustion and attempts == 1:
                e = ProviderError("QUOTA_EXHAUSTED", "Simulated quota exhaustion for fallback verification.", 429)
                latency = int((time.perf_counter() - attempt_start) * 1000)
                await self.touch_account_fn(account, False, e.kind, latency=latency, error=e.message)
                trail.append(FallbackAttempt(
                    attempt=attempts,
                    provider=pid,
                    account_id=account.get("id"),
                    account_name=account.get("name"),
                    model=model_cap.id,
                    status=e.kind,
                    reason=e.message,
                    latency_ms=latency
                ))
                continue

            try:
                adapter.validate_request(req, model_cap.id)
                response = await adapter.send_request(
                    account, key, model_cap.id, req, timeout=timeout
                )
                latency = int((time.perf_counter() - attempt_start) * 1000)
                response.latency_ms = latency
                response.fallback_trail = trail
                response.model_name = model_cap.name

                await self.touch_account_fn(
                    account, True, latency=latency,
                    inp=response.usage.input_tokens,
                    out=response.usage.output_tokens
                )

                if self.record_execution_fn:
                    await self.record_execution_fn(
                        response, req, account, model_cap, trail, user, scope_info
                    )

                return response

            except ProviderError as pe:
                latency = int((time.perf_counter() - attempt_start) * 1000)
                await self.touch_account_fn(account, False, pe.kind, latency=latency, error=pe.message)
                logger.warning("AIWeave provider attempt failed: provider=%s, model=%s, kind=%s", pid, model_cap.id, pe.kind)
                trail.append(FallbackAttempt(
                    attempt=attempts,
                    provider=pid,
                    account_id=account.get("id"),
                    account_name=account.get("name"),
                    model=model_cap.id,
                    status=pe.kind,
                    reason=pe.message[:250],
                    latency_ms=latency
                ))

            except Exception as ex:
                latency = int((time.perf_counter() - attempt_start) * 1000)
                await self.touch_account_fn(account, False, "UNEXPECTED_ERROR", latency=latency, error=str(ex))
                trail.append(FallbackAttempt(
                    attempt=attempts,
                    provider=pid,
                    account_id=account.get("id"),
                    account_name=account.get("name"),
                    model=model_cap.id,
                    status="UNEXPECTED_ERROR",
                    reason=str(ex)[:250],
                    latency_ms=latency
                ))

        summary = " -> ".join(f"{t.provider}:{t.model}:{t.status}" for t in trail)
        raise ProviderError(
            "ALL_PROVIDERS_EXHAUSTED",
            f"All AI providers and fallback candidates failed. Trail: {summary}",
            status_code=503
        )

    async def stream_request(
        self,
        req: OmniRequest,
        accounts: List[Dict[str, Any]],
        discovered_models: List[Dict[str, Any]],
        routing_config: Dict[str, Any],
        user: Any = None,
        scope_info: Dict[str, Any] = None
    ) -> AsyncIterator[OmniStreamChunk]:
        candidates = CANDIDATE_SELECTOR.build_candidate_list(
            req, accounts, discovered_models, routing_config
        )

        if not candidates:
            yield OmniStreamChunk(
                id=f"err-{uuid.uuid4().hex[:12]}",
                event="error",
                error={"code": "PROVIDER_UNAVAILABLE", "message": "No healthy AI providers available."}
            )
            return

        timeout = float(routing_config.get("timeoutMs", 60000)) / 1000.0
        max_attempts = min(self.MAX_TOTAL_ATTEMPTS, int(routing_config.get("maxTotalAttempts", 12)))
        attempts = 0
        trail: List[FallbackAttempt] = []

        for account, model_cap in candidates:
            if attempts >= max_attempts:
                break
            attempts += 1
            pid = account.get("provider")
            adapter = ADAPTER_REGISTRY.get_adapter(pid)
            if not adapter:
                continue

            key = self.decrypt_fn(account.get("credential_encrypted", ""))
            attempt_start = time.perf_counter()
            received_chunks = False
            total_text = ""
            total_reasoning = ""
            finish_reason = "stop"
            usage_reported: Optional[TokenUsage] = None

            try:
                adapter.validate_request(req, model_cap.id)
                async for chunk in adapter.stream_response(account, key, model_cap.id, req, timeout=timeout):
                    received_chunks = True
                    if chunk.delta:
                        total_text += chunk.delta
                    if chunk.reasoning_delta:
                        total_reasoning += chunk.reasoning_delta
                    if chunk.event == "finish":
                        finish_reason = chunk.finish_reason or finish_reason
                        if chunk.usage:
                            usage_reported = chunk.usage
                    yield chunk

                # Successful stream completion: account for it exactly like a
                # non-streaming run, so streamed answers show up in executions,
                # statistics and the saved conversation.
                latency = int((time.perf_counter() - attempt_start) * 1000)
                if usage_reported and (usage_reported.input_tokens or usage_reported.output_tokens):
                    usage = usage_reported
                else:
                    inp = estimate_input_tokens(req)
                    out = estimate_tokens(total_text)
                    usage = TokenUsage(input_tokens=inp, output_tokens=out, total_tokens=inp + out, provider_reported=False)
                await self.touch_account_fn(
                    account, True, latency=latency,
                    inp=usage.input_tokens, out=usage.output_tokens
                )
                response = OmniResponse(
                    content=total_text,
                    reasoning_content=total_reasoning or None,
                    model=model_cap.id,
                    model_name=model_cap.name,
                    provider=pid,
                    account_id=account.get("id"),
                    account_name=account.get("name"),
                    finish_reason=finish_reason,
                    usage=usage,
                    fallback_trail=trail,
                    latency_ms=latency,
                )
                execution_id = None
                if self.record_execution_fn:
                    try:
                        execution_id = await self.record_execution_fn(
                            response, req, account, model_cap, trail, user, scope_info
                        )
                    except Exception:
                        logger.exception("AIWeave could not record a completed stream")
                yield OmniStreamChunk(
                    id=f"done-{uuid.uuid4().hex[:12]}",
                    event="done",
                    model=model_cap.id,
                    provider=pid,
                    finish_reason=finish_reason,
                    usage=usage,
                    metadata={
                        "execution_id": execution_id,
                        "model_name": model_cap.name,
                        "account_name": account.get("name"),
                        "latency_ms": latency,
                        "fallback_trail": [t.model_dump() for t in trail],
                    },
                )
                return

            except Exception as ex:
                latency = int((time.perf_counter() - attempt_start) * 1000)
                pe_kind = getattr(ex, "kind", "STREAMING_ERROR")
                msg = getattr(ex, "message", str(ex))
                await self.touch_account_fn(account, False, pe_kind, latency=latency, error=msg)
                
                trail.append(FallbackAttempt(
                    attempt=attempts,
                    provider=pid,
                    account_id=account.get("id"),
                    account_name=account.get("name"),
                    model=model_cap.id,
                    status=pe_kind,
                    reason=msg[:250],
                    latency_ms=latency
                ))

                if received_chunks:
                    # Chunks were already flushed to client; cannot cleanly restart stream from another provider
                    yield OmniStreamChunk(
                        id=f"err-{uuid.uuid4().hex[:12]}",
                        event="error",
                        error={"code": pe_kind, "message": f"Stream interrupted: {msg}"}
                    )
                    return

                # Send fallback notification chunk so client UI knows automatic fallback is underway
                yield OmniStreamChunk(
                    id=f"fallback-{uuid.uuid4().hex[:12]}",
                    event="fallback",
                    metadata={
                        "from_provider": pid,
                        "from_model": model_cap.id,
                        "reason": msg[:150],
                        "attempt": attempts
                    }
                )

        # If we exhausted all candidates
        yield OmniStreamChunk(
            id=f"err-{uuid.uuid4().hex[:12]}",
            event="error",
            error={"code": "ALL_PROVIDERS_EXHAUSTED", "message": "All fallback candidates exhausted."}
        )
