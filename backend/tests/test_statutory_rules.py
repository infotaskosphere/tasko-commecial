"""Tax rules & law updates: effective-dated, never edited in place, used by the calculations."""
import asyncio
import sys
import types
import warnings

import pytest
from fastapi import HTTPException

pytest.importorskip("mongomock_motor")
from mongomock_motor import AsyncMongoMockClient  # noqa: E402

warnings.filterwarnings("ignore")


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def sr(monkeypatch):
    import backend.dependencies as dep
    import backend.statutory_rules as mod
    new = AsyncMongoMockClient()["rules_test"]
    old = dep.db
    for name, m in list(sys.modules.items()):
        if name.startswith("backend") and getattr(m, "db", None) is old:
            monkeypatch.setattr(m, "db", new)
    monkeypatch.setattr(dep, "db", new)
    monkeypatch.setattr(mod, "_can_edit", lambda u: getattr(u, "owner", False))
    mod._CACHE.update({"at": 0.0, "versions": []})
    yield mod
    mod._CACHE.update({"at": 0.0, "versions": []})


OWNER = types.SimpleNamespace(id="o1", email="o@x", owner=True)
STAFF = types.SimpleNamespace(id="s1", email="s@x", owner=False)


def test_built_in_law_by_date(sr):
    assert sr.rule("gst.b2cl_threshold", "2024-07-31") == 250000
    assert sr.rule("gst.b2cl_threshold", "2024-08-01") == 100000
    assert 40 in sr.rule("gst.valid_rates", "2025-09-22")
    assert 40 not in sr.rule("gst.valid_rates", "2025-09-21")
    assert sr.rule("tds.194J", "2026-01-01")["threshold_annual"] == 50000
    assert sr.rule("tds.194J", "2024-01-01") is None          # no verified policy -> callers send to review


def test_a_law_change_applies_from_its_date_and_can_be_withdrawn(sr):
    async def go():
        res = await sr.add_version(sr.NewVersion(key="tds.194J", value={"threshold_annual": 75000},
                                                 effective_from="2027-04-01", source="Finance Act 2027 (example)"), OWNER)
        vid = res["version"]["id"]
        assert sr.rule("tds.194J", "2027-03-31")["threshold_annual"] == 50000     # old transactions keep old law
        new = sr.rule("tds.194J", "2027-04-01")
        assert new["threshold_annual"] == 75000 and new["rate_standard"] == 0.10  # unchanged parts carried over

        from backend.accounting_ai.tds_engine import TDSEngine
        before = TDSEngine.evaluate_tds("5250", 60000, transaction_date="2027-03-31")
        after = TDSEngine.evaluate_tds("5250", 60000, transaction_date="2027-04-02")
        assert before["applicable"] is True and after["applicable"] is False

        listing = await sr.list_rules(on="2027-04-02", current_user=STAFF)
        j = next(r for r in listing["rules"] if r["key"] == "tds.194J")
        assert j["current"]["origin"] == "added" and len(j["history"]) == 2 and listing["can_edit"] is False

        await sr.withdraw_version(vid, sr.Withdraw(reason="entered by mistake"), OWNER)
        assert sr.rule("tds.194J", "2027-04-02")["threshold_annual"] == 50000
        log = await sr.change_log(OWNER)
        assert [x["action"] for x in log] == ["withdrawn", "added"]
    run(go())


def test_only_the_platform_owner_changes_the_law_and_values_are_checked(sr):
    async def go():
        with pytest.raises(HTTPException) as e:
            await sr.add_version(sr.NewVersion(key="gst.b2cl_threshold", value=50000, effective_from="2027-01-01",
                                               source="test"), STAFF)
        assert e.value.status_code == 403
        for bad in ({"key": "gst.gstr3b_due_day", "value": 45}, {"key": "tds.194C", "value": {"rate_company": 5}},
                    {"key": "nope", "value": 1}):
            with pytest.raises(HTTPException):
                await sr.add_version(sr.NewVersion(effective_from="2027-01-01", source="test", **bad), OWNER)
    run(go())
