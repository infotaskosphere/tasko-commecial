import hashlib
import logging
import uuid
from datetime import datetime, timezone
from types import FunctionType
from typing import Optional

from backend.dependencies import db

logger = logging.getLogger("session_manager")

SESSION_REPLACED_DETAIL = "SESSION_REPLACED"


def _as_utc(value):
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if value:
        try:
            parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except Exception:
            return None
    return None


async def _latest_session_for_user(collection_name: str, user_id: str):
    try:
        sessions = await getattr(db, collection_name).find({"user_id": user_id}).to_list(1000)
    except Exception:
        return None
    if not sessions:
        return None
    return max(
        sessions,
        key=lambda item: (
            _as_utc(item.get("created_at") or item.get("login_at")) or datetime.min.replace(tzinfo=timezone.utc),
            str(item.get("_id") or item.get("session_token") or ""),
        ),
    )


async def _session_was_replaced(user, bearer_token: str) -> bool:
    """Return True when this credential belongs to an older device login."""
    if not bearer_token or not user:
        return False

    user_id = str(getattr(user, "id", "") or "")
    if not user_id:
        return False

    # Commercial SaaS accounts use opaque session tokens stored in db.sessions.
    token_hash = hashlib.sha256(bearer_token.encode("utf-8")).hexdigest()
    try:
        current_saas_session = await db.sessions.find_one({"token_hash": token_hash})
    except Exception:
        current_saas_session = None

    if current_saas_session:
        latest = await _latest_session_for_user("sessions", user_id)
        if not latest:
            return False
        return str(latest.get("_id")) != str(current_saas_session.get("_id"))

    # Legacy JWT accounts have a session record created at successful login.
    # The JWT contains exp but historically did not contain iat. Since the
    # expiry is always ACCESS_TOKEN_EXPIRE_MINUTES after issuance, issuance
    # time can be reconstructed without changing existing JWT structure.
    try:
        from jose import jwt
        import backend.dependencies as dependencies

        payload = jwt.decode(
            bearer_token,
            dependencies.JWT_SECRET,
            algorithms=[dependencies.ALGORITHM],
            options={"verify_exp": False},
        )
        exp = payload.get("exp")
        if exp is None:
            return False
        issued_at = datetime.fromtimestamp(
            float(exp) - (dependencies.ACCESS_TOKEN_EXPIRE_MINUTES * 60),
            tz=timezone.utc,
        )
    except Exception:
        return False

    try:
        active_sessions = await db.session_manager.find(
            {"user_id": user_id, "status": "active"}
        ).to_list(1000)
    except Exception:
        return False

    if not active_sessions:
        # Preserve compatibility with older accounts whose login was not
        # session-tracked successfully.
        return False

    latest_login = max(
        (
            _as_utc(session.get("login_at"))
            for session in active_sessions
            if _as_utc(session.get("login_at")) is not None
        ),
        default=None,
    )
    if latest_login is None:
        return False

    # A small tolerance prevents clock/serialization differences around the
    # exact moment of login from invalidating the newly-issued device.
    return latest_login > issued_at.replace(microsecond=0) + __import__("datetime").timedelta(seconds=10)


async def _guarded_get_current_user(credentials):
    import backend.dependencies as dependencies
    from fastapi import HTTPException

    original = dependencies.__dict__["_single_session_original_get_current_user"]
    user = await original(credentials)
    if await _session_was_replaced(user, credentials.credentials):
        raise HTTPException(
            status_code=401,
            detail=SESSION_REPLACED_DETAIL,
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


class SessionManager:
    @staticmethod
    async def create_user_session(user_id: str, client_ip: str, user_agent: str) -> str:
        """Create the user's one allowed legacy session and revoke older ones."""
        try:
            previous_sessions = await db.session_manager.find(
                {"user_id": str(user_id), "status": "active"}
            ).to_list(1000)
            now = datetime.now(timezone.utc).isoformat()
            for previous in previous_sessions:
                previous_token = previous.get("session_token")
                if previous_token:
                    await db.session_manager.update_one(
                        {"session_token": previous_token},
                        {"$set": {"status": "revoked", "logout_at": now, "revoked_reason": "new_login"}},
                    )
        except Exception:
            logger.exception("Failed to revoke previous sessions for user %s", user_id)

        now = datetime.now(timezone.utc).isoformat()
        session_token = f"sess_{uuid.uuid4().hex}"
        session_doc = {
            "session_token": session_token,
            "user_id": str(user_id),
            "client_ip": client_ip,
            "user_agent": user_agent,
            "status": "active",
            "login_at": now,
            "last_activity_at": now,
        }
        await db.session_manager.update_one(
            {"session_token": session_token},
            {"$set": session_doc},
            upsert=True,
        )
        return session_token

    @staticmethod
    async def revoke_session(session_token: str) -> bool:
        now = datetime.now(timezone.utc).isoformat()
        result = await db.session_manager.update_one(
            {"session_token": session_token},
            {"$set": {"status": "revoked", "logout_at": now}},
        )
        return result.modified_count > 0

    @staticmethod
    async def is_session_active(session_token: str) -> bool:
        sess = await db.session_manager.find_one({"session_token": session_token})
        if not sess:
            return False
        return sess.get("status") == "active"


# All route modules import get_current_user from backend.dependencies. That
# function object may already have been imported by several routers before this
# module is loaded. Replace its code in-place so every existing reference gets
# the same single-session guard without changing each router individually.
def _install_global_single_session_guard():
    try:
        import backend.dependencies as dependencies

        current = dependencies.get_current_user
        if getattr(current, "_single_session_guard_installed", False):
            return

        original = FunctionType(
            current.__code__,
            current.__globals__,
            current.__name__,
            current.__defaults__,
            current.__closure__,
        )

        dependencies.__dict__["_single_session_original_get_current_user"] = original
        dependencies.__dict__["_single_session_guard_installed"] = True

        guarded = _guarded_get_current_user
        current.__code__ = guarded.__code__
        current.__defaults__ = guarded.__defaults__
        current.__kwdefaults__ = guarded.__kwdefaults__
        current.__doc__ = guarded.__doc__
        current._single_session_guard_installed = True
    except Exception:
        logger.exception("Failed to install global single-session authentication guard")


_install_global_single_session_guard()
