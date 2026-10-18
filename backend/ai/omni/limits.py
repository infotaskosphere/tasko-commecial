"""
AIWeave usage limits.

Every request costs real provider money, so each user gets a rolling per-minute
allowance, a daily allowance and a cap on simultaneous requests. Limits are held
in process memory: with several workers each worker enforces its own counters,
which is a deliberate trade for not adding a hard dependency on Redis. Values
come from the environment so an operator can tune them without a deploy.
"""
from __future__ import annotations
import os
import time
from collections import defaultdict, deque
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Deque, Dict, Iterator


def _env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


class UsageLimitError(Exception):
    def __init__(self, message: str, retry_after: int):
        super().__init__(message)
        self.message = message
        self.retry_after = max(1, int(retry_after))


@dataclass
class _State:
    minute: Deque[float]
    day: Deque[float]
    running: Deque[float] = None  # start times of requests still running


class UsageLimiter:
    STALE_SECONDS = 600

    def __init__(self, per_minute: int | None = None, per_day: int | None = None, concurrent: int | None = None):
        self.per_minute = per_minute or _env_int("AIWEAVE_RATE_PER_MINUTE", 20)
        self.per_day = per_day or _env_int("AIWEAVE_REQUESTS_PER_DAY", 400)
        self.concurrent = concurrent or _env_int("AIWEAVE_MAX_CONCURRENT", 3)
        self._state: Dict[str, _State] = defaultdict(lambda: _State(deque(), deque(), deque()))

    def reset(self) -> None:
        self._state.clear()

    def acquire(self, key: str, now: float | None = None) -> None:
        """Reserve one request slot for `key` or raise UsageLimitError."""
        t = time.monotonic() if now is None else now
        st = self._state[key]
        while st.minute and t - st.minute[0] >= 60:
            st.minute.popleft()
        while st.day and t - st.day[0] >= 86400:
            st.day.popleft()
        # A request whose connection dropped before it could release is forgotten after STALE_SECONDS.
        while st.running and t - st.running[0] >= self.STALE_SECONDS:
            st.running.popleft()
        if len(st.running) >= self.concurrent:
            raise UsageLimitError(
                f"You already have {len(st.running)} AI requests running. Wait for one to finish.", 3)
        if len(st.minute) >= self.per_minute:
            raise UsageLimitError(
                f"Rate limit reached: {self.per_minute} AI requests per minute.", 60 - (t - st.minute[0]))
        if len(st.day) >= self.per_day:
            raise UsageLimitError(
                f"Daily limit reached: {self.per_day} AI requests per day.", 86400 - (t - st.day[0]))
        st.minute.append(t)
        st.day.append(t)
        st.running.append(t)

    def release(self, key: str) -> None:
        st = self._state.get(key)
        if st and st.running:
            st.running.popleft()

    @contextmanager
    def slot(self, key: str) -> Iterator[None]:
        self.acquire(key)
        try:
            yield
        finally:
            self.release(key)


USAGE_LIMITER = UsageLimiter()
