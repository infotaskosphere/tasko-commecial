import asyncio
from datetime import datetime, timezone

from backend.engagex.spread import spread_wait
from backend.engagex.worker import _MailChannel

IST_10AM_UTC = datetime(2026, 11, 27, 4, 30, tzinfo=timezone.utc)   # 10:00 IST
IST_8PM_UTC = datetime(2026, 11, 27, 14, 30, tzinfo=timezone.utc)   # 20:00 IST


def _wait(settings, now, sent_today=0):
    async def counter(since):
        return sent_today
    return asyncio.run(spread_wait({"id": "c1", "settings": settings}, counter, now))


def test_no_spread_settings_never_waits():
    assert _wait({}, IST_8PM_UTC) is None


def test_outside_sending_hours_waits_for_next_morning():
    resume, reason = _wait({"send_start_hour": 10, "send_end_hour": 19}, IST_8PM_UTC)
    assert resume == datetime(2026, 11, 28, 4, 30, tzinfo=timezone.utc)  # 28 Nov 10:00 IST
    assert "sending hours" in reason


def test_inside_hours_under_daily_limit_sends():
    assert _wait({"send_start_hour": 10, "send_end_hour": 19, "daily_limit": 100}, IST_10AM_UTC, sent_today=99) is None


def test_daily_limit_reached_continues_next_day():
    resume, reason = _wait({"send_start_hour": 10, "send_end_hour": 19, "daily_limit": 100}, IST_10AM_UTC, sent_today=100)
    assert resume == datetime(2026, 11, 28, 4, 30, tzinfo=timezone.utc)
    assert "100" in reason


def test_daily_limit_without_hours_resumes_at_local_midnight():
    resume, _ = _wait({"daily_limit": 5}, IST_8PM_UTC, sent_today=5)
    assert resume == datetime(2026, 11, 27, 18, 30, tzinfo=timezone.utc)  # 28 Nov 00:00 IST


def test_email_batching_pauses_after_every_n():
    ch = _MailChannel({"id": "c", "settings": {"per_minute": 30, "pause_every": 20, "pause_sec": 600}})
    assert ch.delay(20) == 600 and ch.delay(40) == 600
    assert ch.delay(7) < 10


def test_keepalive_pings_only_while_campaigns_are_pending(monkeypatch):
    import pytest
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.engagex import worker

    raw = mongomock_motor.AsyncMongoMockClient()["ka"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setenv("RENDER_EXTERNAL_URL", "https://api.example")
    calls = []

    class Client:
        def __init__(self, **kw): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def get(self, url): calls.append(url)

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    asyncio.run(worker._keepalive())
    assert calls == []
    asyncio.run(raw.engagex_campaigns.insert_one({"id": "c1", "status": "running"}))
    asyncio.run(worker._keepalive())
    assert calls == ["https://api.example/health"]
