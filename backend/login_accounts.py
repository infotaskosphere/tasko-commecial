"""Sign-in when one email belongs to several accounts, and extra sign-in emails.

Several accounts may share one login email, in different organisations or in
the same one, and one account may sign in with extra, verified emails
(``login_emails``). At sign-in every active account reachable through the
typed email is checked against the password:

* none match  → the usual "Invalid email or password";
* one matches → signed in directly, exactly as before;
* several     → the person picks one from a short list. The list is backed by
                a single-use choice code that expires after 5 minutes and only
                works for the accounts it lists.

Platform Owner emails stay reserved: the app recognises the Platform Owner
partly by email, so no other account may use or add one.
"""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from fastapi import HTTPException

logger = logging.getLogger(__name__)

CHOICE_COLLECTION = "login_account_choices"
ALIAS_CODE_COLLECTION = "login_email_codes"
CHOICE_TTL = timedelta(minutes=5)
ALIAS_CODE_TTL = timedelta(minutes=15)
ALIAS_CODE_MAX_ATTEMPTS = 5
MAX_LOGIN_EMAILS = 10
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_email(value: Any) -> str:
    email = str(value or "").strip().lower()
    return email if _EMAIL_RE.match(email) else ""


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _aware(value: Any) -> Optional[datetime]:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    return None


# ── Platform Owner emails are reserved ────────────────────────────────────────

def is_reserved_owner_email(email: Any) -> bool:
    from backend.platform_owner import platform_owner_emails

    return normalize_email(email) in platform_owner_emails()


def _is_owner_account(user: dict) -> bool:
    if user.get("is_platform_owner") is True:
        return True
    for key in ("platform_owner_uid", "identity_org_uid", "user_uid"):
        if str(user.get(key) or "").upper().startswith("PO-"):
            return True
    return str(user.get("identity_type") or "").lower().startswith("platform_owner")


def assert_login_email_allowed(email: Any, *, for_platform_owner: bool = False) -> str:
    """Several accounts may share a login email; only Platform Owner emails are reserved."""
    normalized = normalize_email(email)
    if not normalized:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")
    if not for_platform_owner and is_reserved_owner_email(normalized):
        raise HTTPException(status_code=409, detail="This email is reserved and cannot be used for this account.")
    return normalized


# ── Finding the accounts behind an email ──────────────────────────────────────

def _email_query(normalized: str) -> dict:
    exact_ci = {"$regex": f"^{re.escape(normalized)}$", "$options": "i"}
    return {
        "status": {"$ne": "deleted"},
        "$or": [
            {"email_normalized": normalized},
            {"email": normalized},
            {"email": exact_ci},
            {"login_emails": normalized},
        ],
    }


async def find_login_accounts(db, email: Any) -> list[dict]:
    """Every non-deleted account that signs in with ``email`` (primary or extra)."""
    normalized = normalize_email(email)
    if not normalized:
        return []
    accounts = await db.users.find(_email_query(normalized)).sort("created_at", 1).to_list(50)
    seen, unique = set(), []
    for account in accounts:
        key = str(account.get("id") or account.get("_id"))
        if key not in seen:
            seen.add(key)
            unique.append(account)
    if is_reserved_owner_email(normalized):
        # A reserved owner email only ever reaches the genuine owner account(s).
        unique = [a for a in unique if _is_owner_account(a)] or unique[:1]
    return unique


def password_matches(user: dict, password: str) -> bool:
    from backend.server_modules.routes.auth_routes import _verify_saas_password, verify_password

    if not password:
        return False
    if user.get("password_hash") and user.get("password_salt"):
        return _verify_saas_password(password, user)
    hashed = user.get("password")
    if not hashed:
        return False
    try:
        return bool(verify_password(password, hashed))
    except Exception:
        return False


async def emails_of(user: dict) -> list[str]:
    values = [user.get("email"), *(user.get("login_emails") or [])]
    out = []
    for value in values:
        normalized = normalize_email(value)
        if normalized and normalized not in out:
            out.append(normalized)
    return out


# ── Account chooser ───────────────────────────────────────────────────────────

async def _organisation_name(db, user: dict) -> str:
    company_id = str(user.get("company_id") or "")
    if company_id:
        company = await db.companies.find_one({"id": company_id}, {"_id": 0, "name": 1, "company_name": 1})
        if company and (company.get("name") or company.get("company_name")):
            return company.get("name") or company.get("company_name")
        customer = await db.commercial_license_customers.find_one({"id": company_id}, {"_id": 0, "company_name": 1})
        if customer and customer.get("company_name"):
            return customer["company_name"]
    if _is_owner_account(user):
        return "Platform Owner"
    return "Organisation"


async def account_summary(db, user: dict) -> dict:
    role = user.get("role")
    return {
        "user_id": str(user.get("id")),
        "full_name": user.get("full_name") or user.get("name") or user.get("email"),
        "email": user.get("email"),
        "role": str(getattr(role, "value", role) or "staff"),
        "organisation": await _organisation_name(db, user),
        "organisation_uid": user.get("identity_org_uid") or user.get("licensee_uid") or user.get("platform_owner_uid"),
        "status": user.get("status") or "active",
    }


async def issue_choice(db, accounts: Iterable[dict], *, email: str, client_ip: str, user_agent: str) -> dict:
    accounts = list(accounts)
    token = secrets.token_urlsafe(32)
    now = _now()
    await db[CHOICE_COLLECTION].insert_one({
        "token_hash": _hash(token),
        "user_ids": [str(a.get("id")) for a in accounts],
        "email": normalize_email(email),
        "client_ip": client_ip,
        "user_agent_hash": _hash(user_agent or ""),
        "created_at": now,
        "expires_at": now + CHOICE_TTL,
    })
    return {
        "requires_account_choice": True,
        "choice_token": token,
        "expires_in": int(CHOICE_TTL.total_seconds()),
        "accounts": [await account_summary(db, a) for a in accounts],
    }


async def consume_choice(db, token: str, user_id: str, *, client_ip: str, user_agent: str) -> dict:
    """Single-use: returns the chosen account's user document, or raises 401."""
    doc = await db[CHOICE_COLLECTION].find_one_and_delete({"token_hash": _hash(str(token or ""))}) if token else None
    expires_at = _aware((doc or {}).get("expires_at"))
    if not doc or not expires_at or expires_at <= _now():
        raise HTTPException(status_code=401, detail="This sign-in choice expired. Please sign in again.")
    if doc.get("user_agent_hash") != _hash(user_agent or ""):
        raise HTTPException(status_code=401, detail="This sign-in choice expired. Please sign in again.")
    if str(user_id) not in set(doc.get("user_ids") or []):
        raise HTTPException(status_code=403, detail="That account is not available for this sign-in.")
    user = await db.users.find_one({"id": str(user_id), "status": {"$ne": "deleted"}})
    if not user:
        raise HTTPException(status_code=401, detail="That account is no longer available.")
    return user


# ── Extra sign-in emails for one account ──────────────────────────────────────

async def start_add_login_email(db, user: dict, email: Any) -> dict:
    normalized = assert_login_email_allowed(email, for_platform_owner=_is_owner_account(user))
    current = await emails_of(user)
    if normalized in current:
        raise HTTPException(status_code=409, detail="This email is already one of your sign-in emails.")
    if len(current) >= MAX_LOGIN_EMAILS:
        raise HTTPException(status_code=400, detail=f"An account can have at most {MAX_LOGIN_EMAILS} sign-in emails.")
    code = f"{secrets.randbelow(1_000_000):06d}"
    now = _now()
    await db[ALIAS_CODE_COLLECTION].delete_many({"user_id": str(user.get("id")), "email": normalized})
    await db[ALIAS_CODE_COLLECTION].insert_one({
        "user_id": str(user.get("id")), "email": normalized, "code_hash": _hash(code),
        "attempts": 0, "created_at": now, "expires_at": now + ALIAS_CODE_TTL,
    })
    from backend.email_service.service import email_service

    body = (
        f"Hello {user.get('full_name') or ''},\n\n"
        f"Your code to add {normalized} as a sign-in email is: {code}\n\n"
        f"It expires in 15 minutes. If you did not ask for this, ignore this email."
    )
    sent = await email_service.send_email(
        to_email=normalized, subject="Your sign-in email verification code", body_plain=body,
        email_type="security", related_user_id=str(user.get("id")), queue_if_fail=False,
    )
    if not sent:
        await db[ALIAS_CODE_COLLECTION].delete_many({"user_id": str(user.get("id")), "email": normalized})
        raise HTTPException(status_code=502, detail="The verification code could not be emailed. Please try again later.")
    return {"sent": True, "email": normalized, "expires_in": int(ALIAS_CODE_TTL.total_seconds())}


async def confirm_add_login_email(db, user: dict, email: Any, code: str) -> list[str]:
    normalized = normalize_email(email)
    doc = await db[ALIAS_CODE_COLLECTION].find_one({"user_id": str(user.get("id")), "email": normalized})
    expires_at = _aware((doc or {}).get("expires_at"))
    if not doc or not expires_at or expires_at <= _now():
        raise HTTPException(status_code=400, detail="The code expired. Request a new one.")
    if int(doc.get("attempts") or 0) >= ALIAS_CODE_MAX_ATTEMPTS:
        await db[ALIAS_CODE_COLLECTION].delete_one({"_id": doc["_id"]})
        raise HTTPException(status_code=429, detail="Too many wrong codes. Request a new one.")
    if not secrets.compare_digest(doc.get("code_hash") or "", _hash(str(code or "").strip())):
        await db[ALIAS_CODE_COLLECTION].update_one({"_id": doc["_id"]}, {"$inc": {"attempts": 1}})
        raise HTTPException(status_code=400, detail="That code is not correct.")
    await db[ALIAS_CODE_COLLECTION].delete_one({"_id": doc["_id"]})
    await db.users.update_one({"id": str(user.get("id"))}, {"$addToSet": {"login_emails": normalized}})
    fresh = await db.users.find_one({"id": str(user.get("id"))}) or user
    return await emails_of(fresh)


async def remove_login_email(db, user: dict, email: Any) -> list[str]:
    normalized = normalize_email(email)
    if normalized == normalize_email(user.get("email")):
        raise HTTPException(status_code=400, detail="Your main email can't be removed here.")
    await db.users.update_one({"id": str(user.get("id"))}, {"$pull": {"login_emails": normalized}})
    fresh = await db.users.find_one({"id": str(user.get("id"))}) or user
    return await emails_of(fresh)


async def create_login_account_indexes(db) -> None:
    try:
        await db[CHOICE_COLLECTION].create_index("token_hash", unique=True)
        await db[CHOICE_COLLECTION].create_index("expires_at", expireAfterSeconds=0)
        await db[ALIAS_CODE_COLLECTION].create_index([("user_id", 1), ("email", 1)])
        await db[ALIAS_CODE_COLLECTION].create_index("expires_at", expireAfterSeconds=0)
        await db.users.create_index("login_emails")
    except Exception as exc:
        logger.warning("Login account index creation skipped: %s", exc)
