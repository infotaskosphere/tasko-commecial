"""Regression tests for xAI's endpoint-scoped permissions in AIWeave."""
from types import SimpleNamespace

import pytest

from backend.ai import aiweave_router as aiw


class _FakeCollection:
    def __init__(self):
        self.documents = []

    @staticmethod
    def _matches(document, query):
        for key, value in query.items():
            if document.get(key) != value:
                return False
        return True

    async def find_one(self, query, *args, **kwargs):
        for document in self.documents:
            if self._matches(document, query):
                return dict(document)
        return None

    async def insert_one(self, document):
        self.documents.append(dict(document))
        return SimpleNamespace(inserted_id=document.get("id"))

    async def update_one(self, query, update, *args, **kwargs):
        for document in self.documents:
            if self._matches(document, query):
                document.update(update.get("$set") or {})
                return SimpleNamespace(matched_count=1, modified_count=1)
        return SimpleNamespace(matched_count=0, modified_count=0)

    async def count_documents(self, query):
        return sum(1 for document in self.documents if self._matches(document, query))

    async def delete_many(self, query):
        before = len(self.documents)
        self.documents = [
            document for document in self.documents
            if not self._matches(document, query)
        ]
        return SimpleNamespace(deleted_count=before - len(self.documents))

    async def insert_many(self, documents):
        self.documents.extend(dict(document) for document in documents)
        return SimpleNamespace(inserted_ids=[d.get("id") for d in documents])


@pytest.mark.asyncio
async def test_grok_model_discovery_does_not_call_forbidden_models_endpoint(monkeypatch):
    calls = []

    async def unexpected_request(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("xAI GET /models must not be used for automatic discovery")

    monkeypatch.setattr(aiw, "req", unexpected_request)

    result = await aiw.discover({"provider": "grok"}, "test-key-not-a-real-secret")

    assert result == []
    assert calls == []


@pytest.mark.asyncio
async def test_env_sync_uses_grok_catalog_and_does_not_reset_runtime_auth_failure(monkeypatch):
    accounts = _FakeCollection()
    models = _FakeCollection()
    monkeypatch.setattr(
        aiw,
        "db",
        SimpleNamespace(aiweave_provider_accounts=accounts, aiweave_provider_models=models),
    )
    monkeypatch.setattr(aiw, "ENV_PROVIDER_KEYS", {"grok": "AIWEAVE_XAI_API_KEY"})
    monkeypatch.setattr(aiw, "ENV_PROVIDER_IDENTITY", {"grok": "AIWeave Server / Grok"})
    monkeypatch.setattr(aiw, "TYPICAL_FREE_TIER_HINT", {"grok": "PAID"})
    monkeypatch.setattr(
        aiw,
        "env_provider_keys",
        lambda provider: [(1, "test-key-not-a-real-secret")] if provider == "grok" else [],
    )
    monkeypatch.setattr(aiw, "enc", lambda value: "encrypted-test-value")

    def unexpected_request(*args, **kwargs):
        raise AssertionError("AIWeave env sync must not request xAI /models")

    monkeypatch.setattr(aiw, "req", unexpected_request)
    user = SimpleNamespace(id="owner-1", company_id="owner-company-1", role="admin")

    assert await aiw.ensure_env_accounts(user) == 1
    assert len(accounts.documents) == 1
    account = accounts.documents[0]
    assert account["provider"] == "grok"
    assert account["model_discovery_status"] == "CATALOG_FALLBACK"
    assert "maintained Grok catalogue" in account["model_discovery_message"]
    assert account["status"] == "CONNECTED"
    assert account["health"] == "HEALTHY"
    assert models.documents == []

    # Simulate a real chat-completions failure. A later provider list / stats
    # request must not reset the account to healthy or retry discovery per request.
    account["status"] = "AUTH_REQUIRED"
    account["health"] = "UNHEALTHY"
    account["last_error"] = "xAI chat-completions endpoint denied this key"
    assert await aiw.ensure_env_accounts(user) == 1

    assert account["status"] == "AUTH_REQUIRED"
    assert account["health"] == "UNHEALTHY"
    assert account["last_error"] == "xAI chat-completions endpoint denied this key"
    assert account["model_discovery_status"] == "CATALOG_FALLBACK"


@pytest.mark.asyncio
async def test_grok_connection_test_checks_chat_completions_not_models(monkeypatch):
    requests = []

    class _Response:
        status_code = 200

        @staticmethod
        def json():
            return {"choices": [{"message": {"content": "OK"}}]}

    async def fake_request(method, url, headers=None, params=None, json=None, timeout=30):
        requests.append({
            "method": method,
            "url": url,
            "headers": headers,
            "json": json,
            "timeout": timeout,
        })
        return _Response()

    monkeypatch.setattr(aiw, "req", fake_request)
    result = await aiw.test_provider({"provider": "grok"}, "test-key-not-a-real-secret")

    assert result["discovered"] == 0
    assert "chat-completions access verified" in result["message"]
    assert len(requests) == 1
    assert requests[0]["method"] == "POST"
    assert requests[0]["url"] == "https://api.x.ai/v1/chat/completions"
    assert requests[0]["json"]["model"] == "grok-4.7"
    assert requests[0]["json"]["max_tokens"] == 1
    assert requests[0]["headers"]["Authorization"] == "Bearer test-key-not-a-real-secret"


def test_grok_uses_current_maintained_catalog_when_discovery_is_unavailable():
    candidates = aiw.model_candidates(
        "grok",
        "auto",
        "chat",
        {"costPolicy": "FREE_FIRST"},
        [],
    )
    assert candidates
    assert candidates[0]["id"] == "grok-4.7"
