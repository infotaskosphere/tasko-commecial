"""API docs are hidden in production unless explicitly enabled."""
from backend import api_docs


def test_docs_hidden_in_production(monkeypatch):
    monkeypatch.setenv("ENV_MODE", "production")
    monkeypatch.delenv("API_DOCS_ENABLED", raising=False)
    assert api_docs.docs_settings() == {"docs_url": None, "redoc_url": None, "openapi_url": None}


def test_docs_can_be_enabled_and_stay_on_outside_production(monkeypatch):
    monkeypatch.setenv("ENV_MODE", "production")
    monkeypatch.setenv("API_DOCS_ENABLED", "true")
    assert api_docs.docs_settings() == {}
    monkeypatch.setenv("ENV_MODE", "development")
    monkeypatch.delenv("API_DOCS_ENABLED", raising=False)
    assert api_docs.docs_settings() == {}
