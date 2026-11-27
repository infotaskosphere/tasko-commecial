import asyncio

from backend import whatsapp_integration as wa


def test_concurrent_session_lookups_hit_bridge_once(monkeypatch):
    calls = []

    async def fake_get(path, retries=3):
        calls.append(path)
        await asyncio.sleep(0.05)
        return {"sessions": [{"id": "s1", "status": "disconnected"}]}

    monkeypatch.setattr(wa, "_bridge_get_raw", fake_get)
    monkeypatch.setattr(wa, "_sessions_lock", None)
    wa._invalidate_sessions_cache()

    async def burst():
        return await asyncio.gather(*(wa._get_cached_sessions() for _ in range(5)))

    results = asyncio.run(burst())
    assert calls == ["/sessions"]
    assert all(r == [{"id": "s1", "status": "disconnected"}] for r in results)
