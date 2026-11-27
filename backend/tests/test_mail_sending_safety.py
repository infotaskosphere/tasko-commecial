import asyncio
import types

import pytest
from fastapi import HTTPException

from backend.engagex import router as ex


def test_single_brace_placeholders_become_merge_tags():
    assert ex.to_merge_tags("Dear {name}, GSTIN {gstin} {{first_name}}") == "Dear {{name}}, GSTIN {{gstin}} {{first_name}}"


def test_module_mail_counts_against_gmail_daily_limit(monkeypatch):
    from backend import org_mail
    from backend.engagex import deliverability, mailer

    sender = types.SimpleNamespace(id="exs_1", kind="google", from_email="office@gmail.com", from_name="Acme",
                                   reply_to=None, smtp={}, daily_limit=None)

    async def fake_resolve(company_id, sender_id=None, acting_user_id=None):
        return sender

    sent, recorded = [], []

    async def fake_send_one(**kw):
        sent.append(kw["to_email"])

    class Senders:
        async def update_one(self, *a, **k):
            return None

    window = {"count": 0}

    async def fake_window(mailbox, now=None):
        return window["count"]

    async def fake_record(mailbox, company_id, campaign_id=""):
        recorded.append((mailbox, campaign_id))

    monkeypatch.setattr(org_mail, "resolve_org_sender", fake_resolve)
    monkeypatch.setattr(mailer, "send_one", fake_send_one)
    monkeypatch.setattr(mailer, "open_session", lambda s: None)
    monkeypatch.setattr(org_mail, "raw_db", lambda: {org_mail.SENDERS: Senders()})
    monkeypatch.setattr(deliverability, "sent_in_window", fake_window)
    monkeypatch.setattr(deliverability, "record_send", fake_record)

    async def send():
        return await org_mail.send_org_email(company_id="cus-1", to_email="client@x.com", subject="Invoice",
                                             html_body="<p>Hi</p>", email_type="invoice")

    asyncio.run(send())
    assert sent == ["client@x.com"] and recorded == [("office@gmail.com", "module:invoice")]

    window["count"] = 400  # Gmail safe daily cap reached across all modules
    with pytest.raises(HTTPException) as exc:
        asyncio.run(send())
    assert exc.value.status_code == 429 and "daily limit" in exc.value.detail
    assert sent == ["client@x.com"]
