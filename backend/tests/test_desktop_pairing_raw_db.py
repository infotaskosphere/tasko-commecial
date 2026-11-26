"""_raw_db must not truth-test Database objects (pymongo/motor refuse bool())."""
from backend import dependencies, desktop_agent_pairing


class _StrictDatabase:
    def __bool__(self):
        raise NotImplementedError("Database objects do not implement truth value testing")


def test_raw_db_returns_database_without_truth_testing(monkeypatch):
    strict = _StrictDatabase()
    monkeypatch.setattr(dependencies, "_raw_db", strict, raising=False)
    assert desktop_agent_pairing._raw_db() is strict


def test_raw_db_falls_back_to_db(monkeypatch):
    monkeypatch.setattr(dependencies, "_raw_db", None, raising=False)
    assert desktop_agent_pairing._raw_db() is dependencies.db
