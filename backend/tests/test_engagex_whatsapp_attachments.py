"""EngageX WhatsApp: several attachments per message, part gap, number management."""
import asyncio
import base64

import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend.engagex import common, worker


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


@pytest.fixture
def mockdb(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["engagex_wa_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))
    return raw


@pytest.fixture
def bridge(monkeypatch):
    from backend import whatsapp_integration as wa

    calls = []
    gaps = []

    async def fake_sessions():
        return [{"sessionId": "wa_1", "status": "connected"}]

    async def fake_post(path, payload, retries=3):
        calls.append((path, dict(payload)))
        return {"messageId": str(len(calls))}

    async def fake_post_large(path, payload, retries=2):
        if payload.get("filename") == "broken.pdf":
            raise HTTPException(502, "WA bridge media error: boom")
        calls.append((path, dict(payload)))
        return {"messageId": str(len(calls))}

    real_sleep = asyncio.sleep

    async def fake_sleep(seconds, *a, **k):
        if seconds:
            gaps.append(seconds)
        await real_sleep(0)

    monkeypatch.setattr(wa, "_get_cached_sessions", fake_sessions)
    monkeypatch.setattr(wa, "_bridge_post", fake_post)
    monkeypatch.setattr(wa, "_bridge_post_large", fake_post_large)
    monkeypatch.setattr(worker, "_sleep_with_lease", lambda *_a, **_k: real_sleep(0))
    monkeypatch.setattr(worker.asyncio, "sleep", fake_sleep)
    return calls, gaps


async def _run(raw, content, settings=None, phones=("919800000001",)):
    media = content.pop("_media", [])
    for m in media:
        await raw[common.MEDIA].insert_one({"company_id": "c1", **m})
    campaign = {
        "id": "exc_1", "company_id": "c1", "channel": "whatsapp", "name": "T", "status": "queued", "created_by": "u1",
        "created_at": common.iso(), "sender_company": "Acme", "tenant": {"company_id": "c1"},
        "settings": {"session_id": "wa_1", "min_delay_sec": 2, "max_delay_sec": 2, "pause_every": 0, "pause_sec": 0, **(settings or {})},
        "content": content, "stats": {},
    }
    await raw[common.CAMPAIGNS].insert_one(dict(campaign))
    await raw[common.RECIPIENTS].insert_many([
        {"id": f"r{i}", "company_id": "c1", "campaign_id": "exc_1", "channel": "whatsapp", "phone": p, "name": "Ravi Sharma",
         "status": "pending", "seq": i, "token": f"t{i}", "attempts": 0} for i, p in enumerate(phones)
    ])
    claimed = await worker._claim("exc_1")
    await worker._run_campaign(claimed)
    doc = await raw[common.CAMPAIGNS].find_one({"id": "exc_1"})
    rows = await raw[common.RECIPIENTS].find({"campaign_id": "exc_1"}).sort("seq", 1).to_list(10)
    return doc, rows


def _media(i, name, mime):
    return {"id": f"m{i}", "filename": name, "mime_type": mime, "base64": _b64(name.encode()), "size": len(name)}


def test_text_then_each_attachment_in_order_with_gap(mockdb, bridge):
    calls, gaps = bridge
    media = [_media(1, "invoice.pdf", "application/pdf"), _media(2, "photo.jpg", "image/jpeg"), _media(3, "note.mp3", "audio/mpeg")]
    content = {"message": "Hi {{first_name}}", "attachments": [{"id": m["id"]} for m in media], "_media": media}
    doc, rows = asyncio.run(_run(mockdb, content, settings={"part_gap_sec": 3}))
    assert doc["status"] == "completed" and rows[0]["status"] == "sent"
    assert [c[0] for c in calls] == ["/send", "/send-media-base64", "/send-media-base64", "/send-media-base64"]
    assert calls[0][1]["message"] == "Hi Ravi"
    assert [c[1]["filename"] for c in calls[1:]] == ["invoice.pdf", "photo.jpg", "note.mp3"]
    assert all(c[1]["caption"] == "" for c in calls[1:])
    assert gaps == [3, 3, 3]


def test_single_captionable_file_carries_the_message(mockdb, bridge):
    calls, gaps = bridge
    media = [_media(1, "photo.jpg", "image/jpeg")]
    content = {"message": "Hello {{first_name}}", "attachments": [{"id": "m1"}], "_media": media}
    asyncio.run(_run(mockdb, content))
    assert [c[0] for c in calls] == ["/send-media-base64"]
    assert calls[0][1]["caption"] == "Hello Ravi"
    assert gaps == []


def test_single_audio_file_gets_text_first(mockdb, bridge):
    calls, _ = bridge
    media = [_media(1, "voice.ogg", "audio/ogg")]
    content = {"message": "Listen", "attachments": [{"id": "m1"}], "_media": media}
    asyncio.run(_run(mockdb, content))
    assert [c[0] for c in calls] == ["/send", "/send-media-base64"]


def test_legacy_single_media_campaign_still_sends(mockdb, bridge):
    calls, _ = bridge
    media = [_media(9, "old.pdf", "application/pdf")]
    content = {"message": "Old", "media_id": "m9", "media_name": "old.pdf", "_media": media}
    doc, _ = asyncio.run(_run(mockdb, content))
    assert doc["status"] == "completed"
    assert [(c[0], c[1].get("caption")) for c in calls] == [("/send-media-base64", "Old")]


def test_partial_failure_reports_which_part(mockdb, bridge):
    media = [_media(1, "ok.pdf", "application/pdf"), _media(2, "broken.pdf", "application/pdf")]
    content = {"message": "Hi", "attachments": [{"id": "m1"}, {"id": "m2"}], "_media": media}
    _, rows = asyncio.run(_run(mockdb, content))
    assert rows[0]["status"] == "failed"
    assert "Sent 2 of 3 parts" in rows[0]["error"] and "broken.pdf" in rows[0]["error"]


def test_missing_attachment_pauses_campaign(mockdb, bridge):
    content = {"message": "Hi", "attachments": [{"id": "gone"}]}
    doc, _ = asyncio.run(_run(mockdb, content))
    assert doc["status"] == "paused" and "attachment is missing" in doc["last_error"]


# ── Campaign creation ────────────────────────────────────────────────────────
@pytest.fixture
def create_env(mockdb, monkeypatch):
    from starlette.requests import Request

    from backend import whatsapp_integration as wa
    from backend.engagex import router as ex
    from backend.models import User

    async def yes(*_a, **_k):
        return True

    async def session(_user, sid):
        return sid

    async def profile(_cid):
        return {"name": "Acme"}

    monkeypatch.setattr(ex, "require_page", lambda *a, **k: None)
    monkeypatch.setattr(ex, "workspace_company_id", lambda _u: "c1")
    monkeypatch.setattr(ex, "capture_tenant_context", lambda _u: {"company_id": "c1"})
    monkeypatch.setattr(ex, "company_profile", profile)
    monkeypatch.setattr(ex.worker, "kick", lambda: None)
    monkeypatch.setattr(wa, "_has_wa_access", yes)
    monkeypatch.setattr(wa, "resolve_sendable_session", session)
    user = User(id="u1", email="a@example.com", role="admin", full_name="Admin")
    request = Request({"type": "http", "method": "POST", "path": "/", "headers": [(b"host", b"app.example.com")], "scheme": "https", "server": ("app.example.com", 443)})

    def call(**overrides):
        body = {"name": "B", "session_id": "wa_1", "message": "Hi", "recipients": [{"name": "Ravi", "phone": "9876543210"}]}
        body.update(overrides)
        return asyncio.run(ex.create_whatsapp_campaign(ex.WhatsAppCampaignIn(**body), request, user))

    return ex, call


def test_create_campaign_stores_every_attachment(create_env, mockdb):
    ex, call = create_env
    files = [
        {"filename": "a.pdf", "mime_type": "application/pdf", "base64": _b64(b"%PDF-1")},
        {"filename": "b.png", "mime_type": "image/png", "base64": "data:image/png;base64," + _b64(b"png")},
        {"filename": "c.mp4", "mime_type": "video/mp4", "base64": _b64(b"vid")},
    ]
    out = call(attachments=files, part_gap_sec=4)
    cid = out["campaign"]["id"]
    doc = asyncio.run(mockdb[common.CAMPAIGNS].find_one({"id": cid}))
    assert [a["filename"] for a in doc["content"]["attachments"]] == ["a.pdf", "b.png", "c.mp4"]
    assert doc["content"]["media_id"] == doc["content"]["attachments"][0]["id"]
    assert doc["settings"]["part_gap_sec"] == 4
    stored = asyncio.run(mockdb[common.MEDIA].count_documents({"company_id": "c1"}))
    assert stored == 3


@pytest.mark.parametrize("files,needle", [
    ([{"filename": "x.exe", "mime_type": "application/octet-stream", "base64": _b64(b"MZ")}], "cannot be sent"),
    ([{"filename": "big.pdf", "mime_type": "application/pdf", "base64": _b64(b"0" * (5 * 1024 * 1024 + 1))}], "larger than 5 MB"),
    ([{"filename": "e.pdf", "mime_type": "application/pdf", "base64": ""}], "empty"),
    ([{"filename": "bad.pdf", "mime_type": "application/pdf", "base64": "@@@"}], "could not be read"),
])
def test_create_campaign_rejects_bad_files(create_env, mockdb, files, needle):
    _, call = create_env
    with pytest.raises(HTTPException) as exc:
        call(attachments=files)
    assert exc.value.status_code == 400 and needle in exc.value.detail
    assert asyncio.run(mockdb[common.MEDIA].count_documents({})) == 0


def test_create_campaign_limits_count_and_total_size(create_env):
    ex, call = create_env
    one_mb = _b64(b"0" * (4 * 1024 * 1024))
    with pytest.raises(HTTPException) as exc:
        call(attachments=[{"filename": f"{i}.pdf", "mime_type": "application/pdf", "base64": one_mb} for i in range(5)])
    assert "16 MB" in exc.value.detail
    with pytest.raises(Exception):
        ex.WhatsAppCampaignIn(name="B", session_id="wa_1", attachments=[{"filename": "a", "mime_type": "x", "base64": "AA=="}] * 6)


# ── Number management ────────────────────────────────────────────────────────
@pytest.fixture
def sessions_env(mockdb, monkeypatch):
    from backend import whatsapp_integration as wa
    from backend.models import User

    bridge_calls = []

    async def scope(_user):
        return {"company_id": "c1"}

    async def fake_delete(path):
        bridge_calls.append(("DELETE", path))
        return {}

    async def fake_post(path, payload, retries=3):
        bridge_calls.append(("POST", path, dict(payload)))
        return {"sessionId": payload.get("sessionId"), "status": "connecting"}

    monkeypatch.setattr(wa, "_db", lambda: mockdb)
    monkeypatch.setattr(wa, "_whatsapp_session_scope_query", scope)
    monkeypatch.setattr(wa, "_bridge_delete", fake_delete)
    monkeypatch.setattr(wa, "_bridge_post", fake_post)
    asyncio.run(mockdb["whatsapp_sessions"].insert_many([
        {"session_id": "wa_mine", "company_id": "c1", "label": "Mine"},
        {"session_id": "wa_other", "company_id": "c2", "label": "Theirs"},
    ]))
    user = User(id="u1", email="a@example.com", role="admin", full_name="Admin")
    return wa, user, bridge_calls


def test_remove_other_company_number_never_reaches_bridge(sessions_env, mockdb):
    wa, user, bridge_calls = sessions_env
    with pytest.raises(HTTPException) as exc:
        asyncio.run(wa.remove_session("wa_other", current_user=user))
    assert exc.value.status_code == 404
    assert bridge_calls == []
    assert asyncio.run(mockdb["whatsapp_sessions"].count_documents({"session_id": "wa_other"})) == 1


def test_remove_number_the_bridge_forgot(sessions_env, mockdb, monkeypatch):
    wa, user, _ = sessions_env

    async def gone(path):
        raise HTTPException(502, "WA bridge error: Client error '404 Not Found'")

    monkeypatch.setattr(wa, "_bridge_delete", gone)
    asyncio.run(wa.remove_session("wa_mine", current_user=user))
    assert asyncio.run(mockdb["whatsapp_sessions"].count_documents({"session_id": "wa_mine"})) == 0


def test_reconnect_own_number_with_pairing_code(sessions_env, mockdb):
    wa, user, bridge_calls = sessions_env
    out = asyncio.run(wa.reconnect_session("wa_mine", wa.WASessionCreate(pairing_phone="+91 98765 43210"), current_user=user))
    assert out["mode"] == "pair-code"
    assert bridge_calls == [("POST", "/sessions", {"sessionId": "wa_mine", "pairingPhone": "919876543210"})]
    with pytest.raises(HTTPException):
        asyncio.run(wa.reconnect_session("wa_other", None, current_user=user))


def test_rename_requires_a_name(sessions_env, mockdb):
    wa, user, _ = sessions_env
    with pytest.raises(HTTPException):
        asyncio.run(wa.update_session_label("wa_mine", wa.WASessionCreate(label="   "), current_user=user))
    asyncio.run(wa.update_session_label("wa_mine", wa.WASessionCreate(label="  Front   desk "), current_user=user))
    assert asyncio.run(mockdb["whatsapp_sessions"].find_one({"session_id": "wa_mine"}))["label"] == "Front desk"
