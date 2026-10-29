"""Saving MailMaster senders connected by account (Microsoft OAuth, auto-detected SMTP)."""
from __future__ import annotations

from typing import Any, Optional

from .common import SENDERS, company_profile, encrypt_secret, iso, new_id, raw_db

KIND_LABEL = {"google": "Gmail", "microsoft": "Outlook"}


async def save_oauth_sender(*, company_id: str, user_id: Optional[str], kind: str, email: str,
                            refresh_token: str, scopes: list[str]) -> None:
    profile = await company_profile(company_id)
    now = iso()
    await raw_db()[SENDERS].update_one(
        {"company_id": company_id, "kind": kind, "from_email": email},
        {
            "$set": {
                "kind": kind,
                "label": f"{KIND_LABEL.get(kind, kind.title())} · {email}",
                "from_email": email,
                "username": email,
                "refresh_token_enc": encrypt_secret(refresh_token),
                "scopes": sorted(scopes),
                "verified_at": now,
                "last_error": None,
                "deleted": False,
                "updated_at": now,
            },
            "$setOnInsert": {
                "id": new_id("exs"),
                "company_id": company_id,
                "from_name": profile.get("name") or email,
                "reply_to": None,
                "is_default": False,
                "created_by": user_id,
                "created_at": now,
            },
        },
        upsert=True,
    )


async def store_rotated_refresh_token(company_id: str, sender_id: str, refresh_token: str) -> None:
    await raw_db()[SENDERS].update_one(
        {"company_id": company_id, "id": sender_id},
        {"$set": {"refresh_token_enc": encrypt_secret(refresh_token), "updated_at": iso()}},
    )


async def save_smtp_sender(*, company_id: str, user_id: str, email: str, password: str, cfg: dict[str, Any],
                           from_name: Optional[str], label: Optional[str]) -> dict:
    """Upsert an auto-connected SMTP mailbox (re-adding the same address refreshes it)."""
    profile = await company_profile(company_id)
    now = iso()
    existing = await raw_db()[SENDERS].find_one(
        {"company_id": company_id, "kind": {"$in": ["smtp", None]}, "from_email": email, "deleted": {"$ne": True}}, {"_id": 0})
    fields = {
        "kind": "smtp",
        "label": label or existing and existing.get("label") or f"{cfg.get('provider_label') or 'Email'} · {email}",
        "from_email": email,
        "smtp_host": cfg["host"],
        "smtp_port": int(cfg["port"]),
        "security": cfg["security"],
        "username": cfg.get("username") or email,
        "password_enc": encrypt_secret(password),
        "provider": cfg.get("provider"),
        "verified_at": now,
        "last_error": None,
        "deleted": False,
        "updated_at": now,
    }
    if from_name:
        fields["from_name"] = from_name
    if existing:
        await raw_db()[SENDERS].update_one({"company_id": company_id, "id": existing["id"]}, {"$set": fields})
        return {**existing, **fields}
    doc = {
        "id": new_id("exs"), "company_id": company_id, "reply_to": None, "is_default": False,
        "from_name": from_name or profile.get("name") or email, "created_by": user_id, "created_at": now, **fields,
    }
    await raw_db()[SENDERS].insert_one(dict(doc))
    return doc
