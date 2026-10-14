"""Small, tenant-safe runtime performance helpers.

This module intentionally sits outside the business/permission modules so
performance changes can be enabled without rewriting commercial authorization
logic. It only coalesces/cache-hits a very small set of authenticated GET
responses for a couple of seconds, keyed by the bearer credential hash.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from urllib.parse import parse_qsl, urlencode
from typing import Dict, Tuple

from starlette.responses import Response


_CACHEABLE_PATHS = {
    "/api/dashboard/stats",
    "/api/dashboard/dept-members",
    "/api/duedates/upcoming",
    "/api/attendance/today",
}
_CACHE_TTL_SECONDS = 2.0
_MAX_BODY_BYTES = 1_500_000

_CACHE: Dict[str, Tuple[float, int, list[tuple[bytes, bytes]], bytes]] = {}
_LOCKS: Dict[str, asyncio.Lock] = {}
_LOCK_GUARD = asyncio.Lock()


def _token_hash(request) -> str | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        return None
    token = header[7:].strip()
    if not token:
        return None
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


async def _get_lock(key: str) -> asyncio.Lock:
    async with _LOCK_GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _LOCKS[key] = lock
        return lock


def _cleanup(now: float) -> None:
    stale = [key for key, value in _CACHE.items() if value[0] <= now]
    for key in stale:
        _CACHE.pop(key, None)


def install_performance_cache(app) -> None:
    """Install a tiny authenticated GET cache/coalescer on the FastAPI app."""
    @app.middleware("http")
    async def _performance_cache(request, call_next):
        if request.method.upper() != "GET":
            return await call_next(request)

        # Dashboard only renders a small recent task slice. Keep the legacy
        # endpoint contract intact for every other caller, but prevent the
        # dashboard from accidentally downloading hundreds of task documents.
        if request.url.path == "/api/tasks":
            referer = request.headers.get("referer", "")
            if "/dashboard" in referer:
                params = parse_qsl(request.url.query, keep_blank_values=True)
                changed = False
                normalized = []
                for key, value in params:
                    if key == "page_size":
                        try:
                            if int(value) > 20:
                                value = "20"
                                changed = True
                        except ValueError:
                            pass
                    normalized.append((key, value))
                if changed:
                    request.scope["query_string"] = urlencode(normalized).encode("ascii")

        if request.url.path not in _CACHEABLE_PATHS:
            return await call_next(request)

        token_hash = _token_hash(request)
        if not token_hash:
            return await call_next(request)

        key = f"{token_hash}:{request.url.path}?{request.url.query}"
        now = time.monotonic()
        cached = _CACHE.get(key)
        if cached and cached[0] > now:
            _, status, headers, body = cached
            return Response(content=body, status_code=status, headers={k.decode(): v.decode() for k, v in headers})

        lock = await _get_lock(key)
        async with lock:
            now = time.monotonic()
            cached = _CACHE.get(key)
            if cached and cached[0] > now:
                _, status, headers, body = cached
                return Response(content=body, status_code=status, headers={k.decode(): v.decode() for k, v in headers})

            response = await call_next(request)
            if response.status_code != 200:
                return response

            body = b""
            async for chunk in response.body_iterator:
                body += chunk
                if len(body) > _MAX_BODY_BYTES:
                    return Response(
                        content=body,
                        status_code=response.status_code,
                        headers=dict(response.headers),
                        media_type=response.media_type,
                    )

            headers = [
                (k.lower().encode("latin-1"), v.encode("latin-1"))
                for k, v in response.headers.items()
                if k.lower() not in {"content-length", "content-encoding", "transfer-encoding"}
            ]
            _CACHE[key] = (time.monotonic() + _CACHE_TTL_SECONDS, response.status_code, headers, body)
            if len(_CACHE) > 2048:
                _cleanup(time.monotonic())
            return Response(content=body, status_code=response.status_code, headers={k.decode(): v.decode() for k, v in headers})
