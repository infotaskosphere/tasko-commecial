import asyncio
from datetime import timedelta

import pytest

from backend.engagex.worker import tag_asset_urls

BASE = "https://api.example"


def test_hosted_images_get_the_recipient_token():
    html = (f'<img src="{BASE}/api/engagex-public/a/AbC_123/Offer%20Banner.png"> '
            '<img src="https://other.example/x.png">')
    out = tag_asset_urls(html, BASE, "tok1")
    assert f"{BASE}/api/engagex-public/a/AbC_123/Offer%20Banner.png?r=tok1" in out
    assert "https://other.example/x.png\"" in out  # other sites untouched


def test_loading_a_tagged_image_records_the_open(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    from backend import dependencies as dep
    from backend.engagex import public
    from backend.engagex.common import iso, utcnow

    raw = mongomock_motor.AsyncMongoMockClient()["opens"]
    monkeypatch.setattr(dep, "_raw_db", raw)

    async def run():
        await raw.engagex_media.insert_one({"public_token": "AbC_123", "purpose": "banner", "mime_type": "image/png",
                                            "base64": "iVBORw0KGgo="})
        await raw.engagex_recipients.insert_many([
            {"token": "tok1", "channel": "email", "opened_at": None, "sent_at": iso(utcnow() - timedelta(minutes=5))},
            {"token": "tok2", "channel": "email", "opened_at": None, "sent_at": iso(utcnow())},  # just sent
        ])
        r1 = await public.public_asset("AbC_123", "b.png", r="tok1")
        await public.public_asset("AbC_123", "b.png", r="tok2")
        await public.public_asset("AbC_123", "b.png")
        return r1, await raw.engagex_recipients.find_one({"token": "tok1"}), await raw.engagex_recipients.find_one({"token": "tok2"})

    r1, opened, fresh = asyncio.run(run())
    assert r1.status_code == 200
    assert opened["opened_at"] is not None
    assert fresh["opened_at"] is None  # loads within seconds of sending are the sender's own copy
