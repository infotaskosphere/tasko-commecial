"""EngageX Dashboard: deleting selected / all message history."""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend.engagex import common, router as ex


@pytest.fixture
def env(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from bson import ObjectId
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["engagex_hist_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))
    monkeypatch.setattr(ex, "require_page", lambda *_a, **_k: None)
    monkeypatch.setattr(ex, "workspace_company_id", lambda user: user.company_id)

    async def wa_scope(user, company_id):
        return {"company_id": company_id}

    async def log_scope(user, company_id):
        return {"company_id": company_id}

    monkeypatch.setattr(ex, "_wa_scope", wa_scope)
    monkeypatch.setattr(ex, "_email_log_scope", log_scope)
    monkeypatch.setattr(ex, "is_admin", lambda user: user.role == "admin")

    wa_ids = [ObjectId(), ObjectId(), ObjectId()]

    async def seed():
        now = common.iso()
        await raw["whatsapp_messages"].insert_many([
            {"_id": wa_ids[0], "company_id": "c1", "to": "919016621382", "message": "Hi", "status": "sent", "sent_at": now},
            {"_id": wa_ids[1], "company_id": "c1", "to": "919000000001", "message": "Reminder", "status": "failed", "sent_at": now},
            {"_id": wa_ids[2], "company_id": "c2", "to": "919000000002", "message": "Other company", "status": "sent", "sent_at": now},
        ])
        await raw[common.RECIPIENTS].insert_one({"id": "r1", "company_id": "c1", "campaign_id": "exc_1", "channel": "email",
                                                 "email": "csmanthandesai@gmail.com", "rendered_subject": "Happy Diwali",
                                                 "status": "sent", "sent_at": now, "updated_at": now})
        await raw["email_delivery_logs"].insert_many([
            {"id": f"log{i}", "company_id": "c1", "recipient": "info.mdesaiassociates@gmail.com",
             "subject": "Security Notice: New Login", "status": "FAILED", "created_at": now} for i in range(3)
        ])

    asyncio.run(seed())
    return raw, wa_ids


def _user(role="admin", company="c1"):
    return SimpleNamespace(id="u1", role=role, company_id=company)


def _history(user=None, **filters):
    args = {"channel": None, "status": None, "q": None, "campaign_id": None, "date_from": None, "date_to": None,
            "page": 1, "page_size": 25, **filters}
    return asyncio.run(ex.history(current_user=user or _user(), **args))


def test_history_lists_all_sources_and_tells_admins_they_can_delete(env):
    data = _history()
    assert data["total"] == 6 and data["can_delete"] is True
    assert {r["kind"] for r in data["items"]} == {"whatsapp", "engagex", "platform"}
    assert _history(_user(role="staff"))["can_delete"] is False


def test_delete_selected_hides_only_those_rows_and_keeps_records(env):
    raw, wa_ids = env
    body = ex.HistoryDeleteIn(items=[
        {"kind": "whatsapp", "id": str(wa_ids[0])},
        {"kind": "engagex", "id": "r1"},
        {"kind": "platform", "id": "log0"},
        {"kind": "whatsapp", "id": str(wa_ids[2])},  # another company's row: must be ignored
        {"kind": "whatsapp", "id": "not-an-object-id"},
    ])
    result = asyncio.run(ex.delete_history_items(body, current_user=_user()))
    assert result["deleted"] == 3
    data = _history()
    assert data["total"] == 3
    assert {r["summary"] for r in data["items"]} == {"Reminder", "Security Notice: New Login"}
    # Underlying records stay (campaign stats, WhatsApp module, platform email log).
    assert asyncio.run(raw["whatsapp_messages"].count_documents({})) == 3
    other = asyncio.run(raw["whatsapp_messages"].find_one({"_id": wa_ids[2]}))
    assert other.get("history_hidden_at") is None


def test_delete_all_respects_filters_then_clears_everything(env):
    filtered = ex.HistoryDeleteAllIn(channel="email", status="failed")
    assert asyncio.run(ex.delete_history_all(filtered, current_user=_user()))["deleted"] == 3
    assert _history()["total"] == 3
    assert asyncio.run(ex.delete_history_all(ex.HistoryDeleteAllIn(), current_user=_user()))["deleted"] == 3
    assert _history()["total"] == 0
    # The other company's history is untouched.
    assert _history(_user(company="c2"))["total"] == 1


def test_dashboard_counts_follow_deleted_history(env, monkeypatch):
    # mongomock lacks $substrBytes (used for the per-day trend); for ASCII
    # dates it equals $substr, which mongomock does implement.
    import mongomock.aggregate as agg

    original = agg._Parser._handle_string_operator

    def handle(self, operator, values):
        return original(self, "$substr" if operator == "$substrBytes" else operator, values)

    monkeypatch.setattr(agg._Parser, "_handle_string_operator", handle)
    before = asyncio.run(ex.overview(days=30, current_user=_user()))["kpis"]
    assert (before["whatsapp_sent"], before["email_failed"]) == (1, 3)
    asyncio.run(ex.delete_history_all(ex.HistoryDeleteAllIn(), current_user=_user()))
    after = asyncio.run(ex.overview(days=30, current_user=_user()))["kpis"]
    assert (after["whatsapp_sent"], after["whatsapp_failed"], after["email_sent"], after["email_failed"]) == (0, 0, 0, 0)


def test_only_admins_can_delete(env):
    with pytest.raises(HTTPException) as err:
        asyncio.run(ex.delete_history_all(ex.HistoryDeleteAllIn(), current_user=_user(role="staff")))
    assert err.value.status_code == 403
    assert _history()["total"] == 6
