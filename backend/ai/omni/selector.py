"""
AIWeave Omni Candidate Selector
Implements model="auto" analysis, routing modes (FAST, BALANCED, QUALITY, LOW_COST, REASONING, CODING, etc.)
and generates a prioritized list of (provider, account, model) candidates.
"""
from __future__ import annotations
import logging
from typing import Any, Dict, List, Optional
from backend.ai.omni.models import OmniRequest
from backend.ai.omni.registry import MODEL_CATALOG, ModelCapability, get_model_capability
from backend.ai.omni.accounts import ACCOUNT_HEALTH_MANAGER

logger = logging.getLogger("aiweave.candidate_selector")

class CandidateSelector:
    def classify_task_requirements(self, req: OmniRequest) -> Dict[str, Any]:
        """Inspects prompt length, message structure, attachments, and flags to determine required capabilities."""
        text_content = req.prompt or ""
        for m in req.messages:
            if isinstance(m, dict):
                text_content += " " + str(m.get("content") or "")
            else:
                text_content += " " + str(getattr(m, "content", "") or "")

        token_est = len(text_content.split()) * 1.3
        is_long_context = token_est > 16000 or bool(req.document_context)
        
        has_vision = bool(req.files and any(f.get("type", "").startswith("image/") for f in req.files))
        has_tools = bool(req.tools)
        has_json = bool(req.response_format and req.response_format.get("type") == "json_object")

        task = (req.task_type or "chat").lower()
        needs_reasoning = task in ("reasoning", "debugging") or "reasoning" in req.routing_mode.lower()
        needs_coding = task in ("coding", "debugging") or "coding" in req.routing_mode.lower()

        return {
            "estimated_tokens": token_est,
            "long_context": is_long_context,
            "vision": has_vision,
            "tools": has_tools,
            "json": has_json,
            "reasoning": needs_reasoning,
            "coding": needs_coding,
        }

    def score_model(
        self,
        model: ModelCapability,
        routing_mode: str,
        requirements: Dict[str, Any],
        is_free: bool = False
    ) -> float:
        score = 100.0

        # Hard requirements
        if requirements["vision"] and not model.supports_vision:
            return -1000.0
        if requirements["tools"] and not model.supports_tools:
            return -1000.0
        if requirements["json"] and not model.supports_json:
            return -1000.0
        if requirements["long_context"] and model.context_window < 100000:
            score -= 30.0

        # Routing mode adjustments
        mode = routing_mode.lower()
        if mode == "fast":
            # Prefer fast models like Flash, Haiku, Groq
            if "flash" in model.id or "haiku" in model.id or model.provider == "groq":
                score += 50.0
        elif mode == "quality":
            # Prefer frontier models
            if model.id in {"claude-opus-5", "gemini-3.1-pro-preview", "gpt-5.6-sol", "grok-4.6"}:
                score += 60.0
            elif "pro" in model.id or "sonnet" in model.id:
                score += 30.0
        elif mode == "low_cost":
            if is_free or model.is_free:
                score += 80.0
            else:
                score -= (model.input_cost_per_m + model.output_cost_per_m) * 2.0
        elif mode == "reasoning":
            if model.supports_reasoning:
                score += 70.0
        elif mode == "coding":
            if "coding" in model.capabilities or "coder" in model.id:
                score += 60.0
        elif mode == "vision":
            if model.supports_vision:
                score += 50.0
        elif mode == "long_context":
            score += (model.context_window / 100000.0) * 10.0
        else: # "balanced" or "auto"
            # High quality + good speed + free tier preference
            if is_free or model.is_free:
                score += 35.0
            if "flash" in model.id or "sonnet" in model.id:
                score += 25.0
            if model.supports_reasoning:
                score += 15.0

        return score

    def build_candidate_list(
        self,
        req: OmniRequest,
        accounts: List[Dict[str, Any]],
        discovered_models: List[Dict[str, Any]],
        routing_config: Dict[str, Any]
    ) -> List[tuple[Dict[str, Any], ModelCapability]]:
        """
        Returns a sorted list of (account, ModelCapability) pairs ready for fallback execution.
        """
        requirements = self.classify_task_requirements(req)
        routing_mode = req.routing_mode or "balanced"
        requested_provider = req.provider if req.provider != "auto" else None
        requested_model = req.model if req.model != "auto" else None

        candidates: List[tuple[float, Dict[str, Any], ModelCapability]] = []

        # Filter healthy accounts
        eligible_accounts = [
            a for a in accounts
            if ACCOUNT_HEALTH_MANAGER.is_account_eligible(a, req.task_type, req.required_capability)
        ]

        if requested_provider:
            eligible_accounts = [a for a in eligible_accounts if a.get("provider") == requested_provider]

        for acc in eligible_accounts:
            pid = acc.get("provider")
            acc_is_free = str(acc.get("cost_tier", "")).upper() == "FREE"

            # Models for this provider
            provider_models = [m for m in MODEL_CATALOG.values() if m.provider == pid]
            # Also include discovered models for this provider
            disc = [m for m in discovered_models if m.get("provider") == pid]
            for d in disc:
                mid = d.get("id")
                if mid and mid not in MODEL_CATALOG:
                    provider_models.append(get_model_capability(mid, pid))

            if requested_model:
                provider_models = [m for m in provider_models if m.id == requested_model]

            for model_cap in provider_models:
                score = self.score_model(model_cap, routing_mode, requirements, is_free=acc_is_free)
                if score > -500.0:
                    # Factor in account priority and weight
                    prio = int(acc.get("priority", 1))
                    score -= (prio - 1) * 5.0
                    candidates.append((score, acc, model_cap))

        # If health metadata is stale/inconsistent, do not fail the entire
        # Omni request before a provider gets a real execution attempt.
        # This second pass only runs when the normal health gate produced zero
        # candidates. It still requires an enabled account and a usable
        # provider/model, while the execution engine remains responsible for
        # marking failed credentials unhealthy and continuing fallback.
        if not candidates:
            logger.warning(
                "AIWeave selector produced no healthy candidates; using connected-account recovery pass."
            )
            recovery_accounts = [
                a for a in accounts
                if a.get("enabled", True)
                and str(a.get("status", "CONNECTED")).upper()
                    not in {"DISABLED", "DISCONNECTED", "AUTH_REQUIRED"}
                and ("*" in (a.get("allowed_task_types") or ["*"])
                     or req.task_type in (a.get("allowed_task_types") or ["*"]))
            ]
            for acc in recovery_accounts:
                pid = acc.get("provider")
                provider_models = [
                    m for m in MODEL_CATALOG.values() if m.provider == pid
                ]
                disc = [m for m in discovered_models if m.get("provider") == pid]
                for d in disc:
                    mid = d.get("id")
                    if mid and mid not in MODEL_CATALOG:
                        provider_models.append(get_model_capability(mid, pid))
                if requested_model:
                    provider_models = [m for m in provider_models if m.id == requested_model]
                for model_cap in provider_models:
                    score = self.score_model(
                        model_cap,
                        routing_mode,
                        requirements,
                        is_free=str(acc.get("cost_tier", "")).upper() == "FREE",
                    )
                    if score > -500.0:
                        candidates.append((score, acc, model_cap))

        # Sort by score descending
        candidates.sort(key=lambda x: x[0], reverse=True)
        return [(acc, m) for (_, acc, m) in candidates]

CANDIDATE_SELECTOR = CandidateSelector()
