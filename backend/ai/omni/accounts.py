"""
AIWeave Omni Account Pool & Circuit Breaker Manager
Monitors account health, quota state, cooldowns, failure counts, and circuit breaker status.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

logger = logging.getLogger("aiweave.account_pool")

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def today_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")

def this_month_str() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")

def next_utc_midnight_iso() -> str:
    n = datetime.now(timezone.utc)
    return (n + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()

class CircuitBreakerState:
    CLOSED = "CLOSED"      # Healthy, executing normally
    OPEN = "OPEN"          # Tripped, blocking attempts
    HALF_OPEN = "HALF_OPEN" # Probing after cooldown

class AccountHealthManager:
    FAILURE_THRESHOLD = 5
    COOLDOWN_SECONDS = 300  # 5 minutes for general failure cooldown

    def is_account_eligible(self, account: Dict[str, Any], task_type: str = "chat", required_cap: Optional[str] = None) -> bool:
        if not account.get("enabled", True):
            return False
        
        status = account.get("status", "CONNECTED")
        if status in {"DISABLED", "DISCONNECTED", "AUTH_REQUIRED", "UNHEALTHY", "RATE_LIMITED", "CAPACITY_EXHAUSTED", "ERROR"}:
            return False
            
        health = account.get("health", "HEALTHY")
        if health not in {"HEALTHY", "DEGRADED"}:
            return False

        # Cooldown check
        cd = account.get("cooldown_until")
        if cd:
            try:
                if datetime.fromisoformat(cd) > datetime.now(timezone.utc):
                    return False
            except Exception:
                pass

        # Quota check
        daily_limit = int(account.get("daily_limit") or 0)
        daily_used = int(account.get("daily_usage_tokens", 0) or 0) if account.get("daily_reset_at") == today_str() else 0
        if daily_limit and daily_used >= daily_limit:
            return False

        monthly_limit = int(account.get("monthly_limit") or 0)
        monthly_used = int(account.get("monthly_usage_tokens", 0) or 0) if account.get("monthly_reset_at") == this_month_str() else 0
        if monthly_limit and monthly_used >= monthly_limit:
            return False

        # Task type check
        allowed = account.get("allowed_task_types") or ["*"]
        if "*" not in allowed and task_type not in allowed:
            return False

        # Required capability
        if required_cap:
            caps = account.get("capabilities") or []
            if caps and required_cap not in caps:
                return False

        return True

    def calculate_cooldown(self, failure_kind: str) -> Optional[str]:
        if failure_kind in {"QUOTA_EXHAUSTED", "TOKEN_EXHAUSTED", "CAPACITY_EXHAUSTED"}:
            return next_utc_midnight_iso()
        elif failure_kind == "RATE_LIMITED":
            # 60s cooldown for rate limits
            return (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        elif failure_kind in {"RETRYABLE_ACCOUNT_FAILURE", "TIMEOUT", "PROVIDER_UNAVAILABLE"}:
            # 120s cooldown
            return (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()
        return None

ACCOUNT_HEALTH_MANAGER = AccountHealthManager()
