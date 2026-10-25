"""EngageX: entitlement, tenancy, normalisation, merge rendering and delivery worker."""
import asyncio

import pytest
from fastapi import HTTPException

import backend.server  # noqa: F401
from backend.engagex import common, worker
from backend.engagex.mailer import build_email_html, build_mime, html_to_text, ResolvedSender


# ── Normalisation & merge tags ───────────────────────────────────────────────
@pytest.mark.parametrize("raw,expected", [
    ("98765 43210", "919876543210"),
    ("+91 98765-43210", "919876543210"),
    ("098765 43210", "919876543210"),
    ("0091 9876543210", "919876543210"),
    ("447700900123", "447700900123"),
    ("12345", None),
    ("", None),
])
def test_normalize_phone(raw, expected):
    assert common.normalize_phone(raw) == expected


def test_normalize_email():
    assert common.normalize_email("  Ravi@Example.COM ") == "ravi@example.com"
    assert common.normalize_email("<ravi@example.com>") == "ravi@example.com"
    assert common.normalize_email("bad@") is None


def test_render_merge_fallback_and_escaping():
    variables = common.merge_variables({"name": "Ravi Sharma", "company": "<b>Acme</b>"}, "Sender Co")
    assert common.render_merge("Hi {{first_name}} from {{sender_company}}", variables) == "Hi Ravi from Sender Co"
    assert common.render_merge("Hi {{nickname|there}}", variables) == "Hi there"
    assert common.render_merge("{{company}}", variables, escape_html=True) == "&lt;b&gt;Acme&lt;/b&gt;"
    assert common.merge_tags_in("{{a}} {{ b | x }}", "{{a}}") == ["a", "b"]


def test_scoped_pins_company_and_rejects_cross_tenant():
    assert common.scoped("c1", {"x": 1}) == {"x": 1, "company_id": "c1"}
    with pytest.raises(HTTPException) as exc:
        common.scoped("c1", {"company_id": "c2"})
    assert exc.value.status_code == 403


def test_smtp_secret_round_trip(monkeypatch):
    monkeypatch.setenv("JWT_SECRET", "x" * 40)
    monkeypatch.delenv("ENGAGEX_ENCRYPT_KEY", raising=False)
    monkeypatch.delenv("EMAIL_ENCRYPT_KEY", raising=False)
    cipher = common.encrypt_secret("app-pass-123")
    assert "app-pass-123" not in cipher
    assert common.decrypt_secret(cipher) == "app-pass-123"


# ── Entitlement ──────────────────────────────────────────────────────────────
FULL_SUITE = ["taskosphere", "finix", "aiweave", "compliance", "records", "proposals", "people_matrix"]
ENGAGEX_PAGES = ["can_view_engagex_dashboard", "can_view_engagex_whatsapp", "can_view_engagex_mailmaster"]


def test_legacy_full_suite_license_implies_engagex_with_all_pages():
    from backend.commercial_licensee_admin import (
        effective_license_module_names, get_all_admin_permissions, normalize_license_selected_features, resolve_license_modules,
    )

    lic = {"modules": FULL_SUITE, "selected_features": {}}
    assert "engagex" in resolve_license_modules(lic)
    assert "engagex" in effective_license_module_names(lic)
    assert sorted(normalize_license_selected_features(lic)["engagex"]) == sorted(ENGAGEX_PAGES)
    perms = get_all_admin_permissions(lic)
    assert perms["can_access_engagex"] is True and all(perms[p] for p in ENGAGEX_PAGES)


def test_partial_license_does_not_get_engagex():
    from backend.commercial_licensee_admin import get_all_admin_permissions, resolve_license_modules

    lic = {"modules": ["taskosphere", "finix"], "selected_features": {}}
    assert "engagex" not in resolve_license_modules(lic)
    assert not get_all_admin_permissions(lic).get("can_access_engagex")


def test_explicit_engagex_page_selection_is_respected():
    from backend.commercial_licensee_admin import get_all_admin_permissions

    lic = {"modules": ["taskosphere", "engagex"], "page_catalog_version": 2,
           "selected_features": {"taskosphere": [], "engagex": ["can_view_engagex_mailmaster"]}}
    perms = get_all_admin_permissions(lic)
    assert perms["can_view_engagex_mailmaster"] is True
    assert not perms.get("can_view_engagex_whatsapp")


def test_user_model_keeps_engagex_flags():
    from backend.models import User

    user = User(id="u1", email="u@example.com", permissions={"can_access_engagex": True, "can_view_engagex_whatsapp": True})
    assert user.permissions.can_access_engagex is True
    assert user.permissions.can_view_engagex_whatsapp is True


@pytest.mark.parametrize("path,flag", [
    ("/api/engagex/overview", "can_view_engagex_dashboard"),
    ("/api/engagex/history/export", "can_view_engagex_dashboard"),
    ("/api/engagex/whatsapp/campaigns/x/pause", "can_view_engagex_whatsapp"),
    ("/api/engagex/mail/senders", "can_view_engagex_mailmaster"),
])
def test_engagex_paths_map_to_page_permissions(path, flag):
    from backend.commercial_module_guard import feature_for_path, module_for_path

    assert module_for_path(path) == "engagex"
    assert feature_for_path(path) == ("engagex", flag)


def test_engagex_routes_are_mounted():
    # FastAPI keeps included routers nested, so probe over HTTP instead of
    # inspecting app.routes: protected routes demand auth, public ones answer.
    from fastapi.testclient import TestClient

    client = TestClient(backend.server.app, raise_server_exceptions=False)
    for path in ("/api/engagex/overview", "/api/engagex/whatsapp/campaigns", "/api/engagex/mail/campaigns"):
        assert client.get(path).status_code in (401, 403), path
    pixel = client.get("/api/engagex-public/o/unknown-token.gif")
    assert pixel.status_code == 200 and pixel.headers["content-type"] == "image/gif"


# ── Mail rendering ───────────────────────────────────────────────────────────
def test_email_html_and_mime_headers():
    html = build_email_html(body_html="<p>Hello</p>", preview_text="Pre", footer_company="Acme & Co", footer_address="Pune",
                            unsubscribe_url="https://x.test/u/t", open_pixel_url="https://x.test/o/t.gif")
    assert "Acme &amp; Co" in html and "https://x.test/u/t" in html and "t.gif" in html
    assert html_to_text('<p>Hi <a href="https://a.b">there</a></p>') == "Hi there (https://a.b)"
    sender = ResolvedSender(id="s", label="s", from_name="Acme", from_email="news@acme.test", reply_to="hello@acme.test", kind="smtp")
    mime = build_mime(sender=sender, to_email="r@x.test", subject="S", html_body=html, text_body="t", unsubscribe_url="https://x.test/u/t")
    assert "List-Unsubscribe: <https://x.test/u/t>" in mime
    assert "List-Unsubscribe-Post: List-Unsubscribe=One-Click" in mime
    assert "Reply-To: hello@acme.test" in mime


# ── Worker (in-memory database, stubbed WhatsApp bridge) ─────────────────────
def test_worker_delivers_whatsapp_campaign_once_per_recipient(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend import whatsapp_integration as wa
    from backend.tenant_runtime import TenantAwareDatabase

    client = mongomock_motor.AsyncMongoMockClient()
    raw = client["engagex_test"]
    monkeypatch.setattr(dep, "_raw_db", raw)
    monkeypatch.setattr(dep, "db", TenantAwareDatabase(raw, mongo_client=client))
    sent = []

    async def fake_sessions():
        return [{"sessionId": "wa_1", "status": "connected"}]

    async def fake_post(path, payload, retries=3):
        if payload["to"].endswith("0000"):
            raise RuntimeError("not on WhatsApp")
        sent.append(payload)
        return {"messageId": str(len(sent))}

    monkeypatch.setattr(wa, "_get_cached_sessions", fake_sessions)
    monkeypatch.setattr(wa, "_bridge_post", fake_post)
    monkeypatch.setattr(worker, "_sleep_with_lease", lambda *_a, **_k: asyncio.sleep(0))

    async def scenario():
        campaign = {
            "id": "exc_1", "company_id": "c1", "channel": "whatsapp", "name": "Test", "status": "queued", "created_by": "u1",
            "created_at": common.iso(), "sender_company": "Acme", "tenant": {"company_id": "c1"},
            "settings": {"session_id": "wa_1", "min_delay_sec": 2, "max_delay_sec": 2, "pause_every": 0, "pause_sec": 0},
            "content": {"message": "Hi {{first_name}} — {{sender_company}}"}, "stats": {},
        }
        await raw[common.CAMPAIGNS].insert_one(dict(campaign))
        rows = [("919800000001", "Ravi Sharma", "pending"), ("919800000000", "Bad", "pending"), ("919800000002", "Optout", "skipped")]
        await raw[common.RECIPIENTS].insert_many([
            {"id": f"r{i}", "company_id": "c1", "campaign_id": "exc_1", "channel": "whatsapp", "phone": p, "name": n, "status": s,
             "seq": i, "token": f"t{i}", "attempts": 0} for i, (p, n, s) in enumerate(rows)
        ])
        claimed = await worker._claim("exc_1")
        assert claimed and claimed["status"] == "running"
        await worker._run_campaign(claimed)
        doc = await raw[common.CAMPAIGNS].find_one({"id": "exc_1"})
        history = await raw["whatsapp_messages"].find({"batch_id": "exc_1"}).to_list(10)
        return doc, history

    doc, history = asyncio.run(scenario())
    assert doc["status"] == "completed"
    assert (doc["stats"]["sent"], doc["stats"]["failed"], doc["stats"]["skipped"]) == (1, 1, 1)
    assert [p["to"] for p in sent] == ["919800000001"]
    assert sent[0]["message"] == "Hi Ravi — Acme"
    assert {h["status"] for h in history} == {"sent", "failed"}
