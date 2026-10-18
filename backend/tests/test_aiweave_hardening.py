"""AIWeave hardening: usage limits, private conversations, recorded streams, input bounds.

Runs the real app against an in-memory database with a fake provider adapter, so
nothing here calls an external AI service.
"""
import datetime as dt
import json
import logging

import pytest

mongomock_motor = pytest.importorskip("mongomock_motor")
from fastapi.testclient import TestClient  # noqa: E402

FUTURE = (dt.datetime.utcnow() + dt.timedelta(days=200)).isoformat()


@pytest.fixture(scope="module")
def env():
    """The real app wired to an in-memory database, restored afterwards."""
    import sys

    import backend.server as server
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    logging.disable(logging.CRITICAL)
    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["aiweave_hardening"]
    wrapped = TenantAwareDatabase(raw, mongo_client=client)

    original = dep.db
    original_raw = dep._raw_db
    swapped = []
    for name, mod in list(sys.modules.items()):
        if (name == "backend" or name.startswith("backend.")) and mod is not None:
            if getattr(mod, "db", None) is original:
                swapped.append(mod)
                mod.db = wrapped
    dep._raw_db = raw
    dep.db = wrapped

    yield server.app, raw, dep

    # Modules first imported while the tests ran (lazy imports) captured the
    # in-memory database as their own; hand every such reference back too, or
    # later test modules would keep talking to this database.
    for name, mod in list(sys.modules.items()):
        if (name == "backend" or name.startswith("backend.")) and mod is not None:
            if getattr(mod, "db", None) is wrapped:
                mod.db = original
    for mod in swapped:
        mod.db = original
    dep.db = original
    dep._raw_db = original_raw
    logging.disable(logging.NOTSET)


def _run(coro):
    import asyncio

    return asyncio.new_event_loop().run_until_complete(coro)


async def _seed(raw, cust, modules, selected=None):
    lic = {
        "id": f"lic-{cust}", "customer_id": cust, "status": "active", "modules": modules,
        "licensed_modules": modules, "expires_at": FUTURE,
        "issued_at": dt.datetime.utcnow().isoformat(), "max_users": 50,
    }
    if selected is not None:
        lic["selected_features"] = selected
    await raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True)
    await raw.companies.replace_one(
        {"id": cust},
        {"id": cust, "name": cust, "commercial_customer_id": cust, "license_id": lic["id"]},
        upsert=True,
    )
    base = {
        "company_id": cust, "license_id": lic["id"], "commercial_customer_id": cust,
        "is_active": True, "hashed_password": "x", "created_at": dt.datetime.utcnow().isoformat(),
    }
    await raw.users.replace_one(
        {"id": f"{cust}-admin"},
        {**base, "id": f"{cust}-admin", "email": f"admin@{cust}.test", "full_name": "Admin",
         "role": "admin", "identity_type": "licensee_admin", "permissions": {}},
        upsert=True,
    )
    await raw.users.replace_one(
        {"id": f"{cust}-staff"},
        {**base, "id": f"{cust}-staff", "email": f"staff@{cust}.test", "full_name": "Staff",
         "role": "staff", "permissions": {}},
        upsert=True,
    )



from backend.ai.omni.adapters.base import BaseProviderAdapter, ProviderError  # noqa: E402
from backend.ai.omni.models import OmniResponse, OmniStreamChunk, TokenUsage  # noqa: E402


class FakeAdapter(BaseProviderAdapter):
    """Stands in for the OpenAI adapter; answers 'Hello there' without a network call."""

    def __init__(self, fail_stream_after_text=False):
        super().__init__("openai", "Fake")
        self.fail_stream_after_text = fail_stream_after_text

    def validate_request(self, req, model):
        return None

    async def send_request(self, account, key, model, req, timeout=60.0):
        return OmniResponse(content="Hello there", model=model, provider="openai",
                            usage=TokenUsage(input_tokens=5, output_tokens=2, total_tokens=7, provider_reported=True))

    async def stream_response(self, account, key, model, req, timeout=60.0):
        yield OmniStreamChunk(id="s", event="start", model=model, provider="openai")
        yield OmniStreamChunk(id="s", event="chunk", delta="Hello ", model=model, provider="openai")
        yield OmniStreamChunk(id="s", event="chunk", delta="there", model=model, provider="openai")
        if self.fail_stream_after_text:
            raise ProviderError("NETWORK_ERROR", "connection dropped", 502, True)
        yield OmniStreamChunk(id="s", event="finish", finish_reason="stop", model=model, provider="openai")

    async def health_check(self, account, key):
        return {}

    async def discover_models(self, account, key):
        return []


async def _seed_tenant(raw, cust):
    lic = {"id": f"lic-{cust}", "customer_id": cust, "status": "active", "modules": ["aiweave"],
           "licensed_modules": ["aiweave"], "expires_at": FUTURE,
           "issued_at": dt.datetime.utcnow().isoformat(), "max_users": 50}
    await raw.commercial_licenses.replace_one({"id": lic["id"]}, lic, upsert=True)
    await raw.companies.replace_one({"id": cust}, {"id": cust, "name": cust, "commercial_customer_id": cust,
                                                   "license_id": lic["id"]}, upsert=True)
    base = {"company_id": cust, "license_id": lic["id"], "commercial_customer_id": cust, "is_active": True,
            "hashed_password": "x", "created_at": dt.datetime.utcnow().isoformat()}
    await raw.users.replace_one({"id": f"{cust}-admin"}, {**base, "id": f"{cust}-admin", "email": f"a@{cust}.test",
                                "full_name": "Admin", "role": "admin", "identity_type": "licensee_admin",
                                "permissions": {}}, upsert=True)
    for who in ("ann", "bob"):
        await raw.users.replace_one({"id": f"{cust}-{who}"}, {**base, "id": f"{cust}-{who}", "email": f"{who}@{cust}.test",
                                    "full_name": who.title(), "role": "staff", "permissions": {}}, upsert=True)
    await raw.aiweave_provider_accounts.replace_one(
        {"id": f"acc-{cust}"},
        {"id": f"acc-{cust}", "scope_type": "company", "scope_id": cust, "company_id": cust, "provider": "openai",
         "name": "Test account", "enabled": True, "status": "CONNECTED", "health": "HEALTHY",
         "allowed_task_types": ["*"], "allowed_users": ["*"], "allowed_companies": [cust],
         "credential_encrypted": "", "cost_tier": "FREE", "priority": 1, "capabilities": []},
        upsert=True)


@pytest.fixture(scope="module")
def tenant(env):
    _run(_seed_tenant(env[1], "ai_co"))
    return "ai_co"


@pytest.fixture(autouse=True)
def fake_provider(env, tenant, monkeypatch):
    """Use the fake adapter, no env-account discovery, and fresh usage counters per test."""
    from backend.ai import aiweave_router as r
    from backend.ai.omni.adapters.registry import ADAPTER_REGISTRY
    from backend.ai.omni.limits import USAGE_LIMITER

    async def no_env_accounts(user):
        return None

    original = ADAPTER_REGISTRY.get_adapter("openai")
    ADAPTER_REGISTRY.register_adapter(FakeAdapter())
    monkeypatch.setattr(r, "ensure_env_accounts", no_env_accounts)
    USAGE_LIMITER.reset()
    yield
    ADAPTER_REGISTRY.register_adapter(original)
    USAGE_LIMITER.reset()


@pytest.fixture(scope="module")
def client(env, tenant):
    return TestClient(env[0], raise_server_exceptions=False)


def _auth(env, user_id):
    return {"Authorization": "Bearer " + env[2].create_access_token({"sub": user_id})}


def _sse(text):
    events = []
    for block in text.split("\n\n"):
        block = block.strip()
        if block.startswith("data: ") and block != "data: [DONE]":
            events.append(json.loads(block[6:]))
    return events


# --------------------------------------------------------------------------- #

def test_omni_answers_and_records_the_run(client, env):
    ann = _auth(env, "ai_co-ann")
    r = client.post("/api/aiweave/omni", json={"prompt": "hi"}, headers=ann)
    assert r.status_code == 200, r.text
    assert r.json()["content"] == "Hello there"
    runs = client.get("/api/aiweave/executions", headers=ann).json()
    assert any(x["prompt"] == "hi" for x in runs)


def test_streamed_answer_is_recorded_and_saved_to_the_conversation(client, env):
    ann = _auth(env, "ai_co-ann")
    conv = client.post("/api/aiweave/conversations", json={"title": "t"}, headers=ann).json()
    r = client.post("/api/aiweave/omni", json={"prompt": "stream please", "stream": True,
                                                "conversation_id": conv["conversation_id"]}, headers=ann)
    assert r.status_code == 200
    events = _sse(r.text)
    assert "".join(e["delta"] for e in events if e["event"] == "chunk") == "Hello there"
    done = [e for e in events if e["event"] == "done"]
    assert len(done) == 1 and done[0]["metadata"]["execution_id"]
    assert done[0]["usage"]["output_tokens"] > 0

    saved = client.get(f"/api/aiweave/conversations/{conv['conversation_id']}", headers=ann).json()
    assert [m["role"] for m in saved["messages"]] == ["user", "assistant"]
    assert saved["messages"][1]["content"] == "Hello there"
    runs = client.get("/api/aiweave/executions", headers=ann).json()
    assert any(x["prompt"] == "stream please" and x["status"] == "SUCCESS" for x in runs)


def test_interrupted_stream_is_not_saved_as_an_answer(client, env):
    from backend.ai.omni.adapters.registry import ADAPTER_REGISTRY
    ADAPTER_REGISTRY.register_adapter(FakeAdapter(fail_stream_after_text=True))
    ann = _auth(env, "ai_co-ann")
    conv = client.post("/api/aiweave/conversations", json={}, headers=ann).json()
    r = client.post("/api/aiweave/omni", json={"prompt": "will break", "stream": True,
                                                "conversation_id": conv["conversation_id"]}, headers=ann)
    events = _sse(r.text)
    assert events[-1]["event"] == "error"
    assert not [e for e in events if e["event"] == "done"]
    saved = client.get(f"/api/aiweave/conversations/{conv['conversation_id']}", headers=ann).json()
    assert saved["messages"] == []


def test_colleagues_cannot_read_or_write_each_others_conversations(client, env):
    ann, bob, admin = (_auth(env, f"ai_co-{u}") for u in ("ann", "bob", "admin"))
    conv = client.post("/api/aiweave/conversations", json={"title": "private"}, headers=ann).json()
    cid = conv["conversation_id"]
    assert cid in [c["conversation_id"] for c in client.get("/api/aiweave/conversations", headers=ann).json()]
    assert cid not in [c["conversation_id"] for c in client.get("/api/aiweave/conversations", headers=bob).json()]
    assert client.get(f"/api/aiweave/conversations/{cid}", headers=bob).status_code == 404
    assert client.delete(f"/api/aiweave/conversations/{cid}", headers=bob).status_code == 404
    assert client.post(f"/api/aiweave/conversations/{cid}/messages", json={"content": "x"}, headers=bob).status_code == 404
    # a colleague also cannot make the AI write into it
    client.post("/api/aiweave/omni", json={"prompt": "intrude", "conversation_id": cid}, headers=bob)
    saved = client.get(f"/api/aiweave/conversations/{cid}", headers=ann).json()
    assert saved["messages"] == []
    assert client.get(f"/api/aiweave/conversations/{cid}", headers=admin).status_code == 404


def test_run_history_is_private_to_each_person_but_visible_to_the_admin(client, env):
    ann, bob, admin = (_auth(env, f"ai_co-{u}") for u in ("ann", "bob", "admin"))
    client.post("/api/aiweave/omni", json={"prompt": "ann secret prompt"}, headers=ann)
    assert not any("ann secret" in x["prompt"] for x in client.get("/api/aiweave/executions", headers=bob).json())
    assert any("ann secret" in x["prompt"] for x in client.get("/api/aiweave/executions", headers=ann).json())
    assert any("ann secret" in x["prompt"] for x in client.get("/api/aiweave/executions", headers=admin).json())


def test_rate_limit_returns_429_with_retry_after(client, env, monkeypatch):
    from backend.ai.omni.limits import USAGE_LIMITER
    monkeypatch.setattr(USAGE_LIMITER, "per_minute", 3)
    ann = _auth(env, "ai_co-ann")
    codes = [client.post("/api/aiweave/omni", json={"prompt": f"q{i}"}, headers=ann).status_code for i in range(5)]
    assert codes == [200, 200, 200, 429, 429]
    blocked = client.post("/api/aiweave/omni", json={"prompt": "again"}, headers=ann)
    assert int(blocked.headers["Retry-After"]) >= 1
    # another person is not affected
    assert client.post("/api/aiweave/omni", json={"prompt": "bob"}, headers=_auth(env, "ai_co-bob")).status_code == 200


def test_execute_route_shares_the_same_limit(client, env, monkeypatch):
    from backend.ai.omni.limits import USAGE_LIMITER
    monkeypatch.setattr(USAGE_LIMITER, "per_minute", 1)
    ann = _auth(env, "ai_co-ann")
    client.post("/api/aiweave/omni", json={"prompt": "one"}, headers=ann)
    assert client.post("/api/aiweave/execute", json={"prompt": "two"}, headers=ann).status_code == 429


def test_finished_requests_release_their_concurrency_slot(client, env, monkeypatch):
    from backend.ai.omni.limits import USAGE_LIMITER
    monkeypatch.setattr(USAGE_LIMITER, "concurrent", 1)
    ann = _auth(env, "ai_co-ann")
    for i in range(4):
        assert client.post("/api/aiweave/omni", json={"prompt": f"seq{i}", "stream": i % 2 == 0}, headers=ann).status_code == 200
    assert not USAGE_LIMITER._state["ai_co:ai_co-ann"].running


def test_limiter_window_and_concurrency_unit():
    from backend.ai.omni.limits import UsageLimiter, UsageLimitError
    lim = UsageLimiter(per_minute=2, per_day=3, concurrent=1)
    lim.acquire("u", now=0)
    with pytest.raises(UsageLimitError):  # second while first still running
        lim.acquire("u", now=1)
    lim.release("u")
    lim.acquire("u", now=2)
    lim.release("u")
    with pytest.raises(UsageLimitError) as e:  # minute window full
        lim.acquire("u", now=3)
    assert 1 <= e.value.retry_after <= 60
    lim.acquire("u", now=70)  # window moved on; third request of the day
    lim.release("u")
    with pytest.raises(UsageLimitError):  # daily cap
        lim.acquire("u", now=140)
    # a request whose connection dropped before release stops blocking after a while
    lim2 = UsageLimiter(per_minute=50, per_day=500, concurrent=1)
    lim2.acquire("v", now=0)
    lim2.acquire("v", now=lim2.STALE_SECONDS + 1)


def test_oversized_and_malformed_requests_are_rejected(client, env):
    ann = _auth(env, "ai_co-ann")
    post = lambda body: client.post("/api/aiweave/omni", json=body, headers=ann).status_code  # noqa: E731
    assert post({"prompt": "x" * 100_001}) == 422
    assert post({}) == 422
    assert post({"messages": [{"role": "root", "content": "hi"}]}) == 422
    assert post({"messages": [{"role": "user", "content": "x"}] * 101}) == 422
    assert post({"prompt": "ok", "document_context": "d" * 200_001}) == 422
    assert post({"messages": [{"role": "user", "content": "y" * 90_000}] * 6}) == 422
    assert post({"prompt": "fine"}) == 200


def test_only_admins_can_use_the_simulated_failure_flag(client, env):
    """The flag fails the first attempt on a real account, so a normal user's flag is ignored."""
    ann, admin = _auth(env, "ai_co-ann"), _auth(env, "ai_co-admin")
    body = {"prompt": "p", "mock_simulate_exhaustion": True}
    assert client.post("/api/aiweave/omni", json=body, headers=ann).json()["fallback_trail"] == []
    trail = client.post("/api/aiweave/omni", json=body, headers=admin).json()["fallback_trail"]
    assert trail and trail[0]["status"] == "QUOTA_EXHAUSTED"


def test_ordinary_users_are_not_aiweave_administrators(client, env):
    ann, admin = _auth(env, "ai_co-ann"), _auth(env, "ai_co-admin")
    assert client.put("/api/aiweave/routing-config", json={"strategy": "PRIORITY"}, headers=ann).status_code == 403
    assert client.put("/api/aiweave/routing-config", json={"strategy": "PRIORITY"}, headers=admin).status_code == 200


def test_conversation_history_is_capped(client, env):
    from backend.ai import aiweave_router as r
    ann = _auth(env, "ai_co-ann")
    cid = client.post("/api/aiweave/conversations", json={}, headers=ann).json()["conversation_id"]
    original = r.MAX_STORED_MESSAGES
    r.MAX_STORED_MESSAGES = 6
    try:
        for i in range(5):
            client.post("/api/aiweave/omni", json={"prompt": f"m{i}", "conversation_id": cid}, headers=_auth(env, "ai_co-ann"))
            from backend.ai.omni.limits import USAGE_LIMITER
            USAGE_LIMITER.reset()
    finally:
        r.MAX_STORED_MESSAGES = original
    saved = client.get(f"/api/aiweave/conversations/{cid}", headers=ann).json()
    assert len(saved["messages"]) == 6
    assert saved["messages"][-2]["content"] == "m4"
    assert len(saved["execution_history"]) <= r.MAX_STORED_HISTORY
