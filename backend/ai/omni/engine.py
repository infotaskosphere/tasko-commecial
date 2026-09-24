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

            try:
                adapter.validate_request(req, model_cap.id)
                async for chunk in adapter.stream_response(account, key, model_cap.id, req, timeout=timeout):
                    received_chunks = True
                    if chunk.delta:
                        total_text += chunk.delta
                    yield chunk

                # Successful stream completion
                latency = int((time.perf_counter() - attempt_start) * 1000)
                await self.touch_account_fn(account, True, latency=latency, inp=0, out=len(total_text.split()))
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
