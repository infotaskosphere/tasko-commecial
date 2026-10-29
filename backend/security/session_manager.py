import hashlib
import logging
import uuid
from datetime import datetime, timezone, timedelta


import backend.dependencies as dependencies

logger = logging.getLogger("session_manager")

SESSION_REPLACED_DETAIL = "SESSION_REPLACED"
SESSION_NOT_BOUND_DETAIL = "SESSION_NOT_BOUND"
SESSION_INVALIDATED_DETAIL = "SESSION_INVALIDATED"


def _raw_db():
    """Return the unwrapped database so session checks are never tenant-scoped."""
    raw_db = dependencies.__dict__.get("_raw_db")
    return raw_db if raw_db is not None else dependencies.db


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


async def _latest_session_for_user(user_id: str, email: str = None):
    """Find the newest session regardless of Mongo user_id type or email."""
    try:
        sessions = await _raw_db().sessions.find({}).to_list(5000)
    except Exception:
        sessions = []

    norm_email = str(email or "").strip().lower()
    # A session belongs to a concrete user identity. Do not merge identities
    # merely because legacy records share an email address.
    matching = [
        s for s in sessions
        if str(s.get("user_id")) == str(user_id)
    ]
    if not matching:
        return None

    return max(
        matching,
        key=lambda item: (
            _as_utc(item.get("created_at") or item.get("login_at"))
            or datetime.min.replace(tzinfo=timezone.utc),
            str(item.get("_id") or item.get("session_token") or ""),
        ),
    )


async def jwt_session_is_live(user, bearer_token: str) -> bool:
    """False when ``bearer_token`` is a JWT bound to a login session (its
    ``sid`` claim) that has been revoked, logged out, replaced or has expired.

    Tokens without a ``sid`` (and opaque SaaS session tokens, which are
    checked against the sessions collection when resolved) are not affected
    here. This check was meant to run before but never did: see the commit
    that removed the code transplant into the auth function.
    """
    if not bearer_token or not user:
        return True
    try:
        import jwt as _jwt

        payload = _jwt.decode(
            bearer_token,
            dependencies.JWT_SECRET,
            algorithms=[dependencies.ALGORITHM],
            options={"verify_exp": False},
        )
    except Exception:
        return True  # not a JWT: an opaque session token
    sid = str(payload.get("sid") or "").strip()
    if not sid:
        return True

    raw_db = _raw_db()
    session = await raw_db.session_manager.find_one({"session_token": sid})
    if not session:
        token_hash = hashlib.sha256(bearer_token.encode("utf-8")).hexdigest()
        session = await raw_db.sessions.find_one(
            {"$or": [{"session_token": sid}, {"token_hash": token_hash}]}
        )
    if not session or session.get("status", "active") != "active":
        return False
    expires_at = _as_utc(session.get("expires_at"))
    if expires_at is not None and expires_at <= datetime.now(timezone.utc):
        return False
    return True


async def _session_was_replaced(user, bearer_token: str) -> bool:
    """Return True when these credentials belong to an older device login."""
    if not bearer_token or not user:
        return False

    # Platform owner is completely exempted from single-device login restrictions
    from backend.platform_owner import is_platform_owner
    if is_platform_owner(user):
        return False

    user_id = str(getattr(user, "id", "") or "")
    user_email = str(getattr(user, "email", "") or "").strip().lower()
    if not user_id and not user_email:
        return False

    raw_db = _raw_db()

    # Commercial SaaS accounts use opaque session tokens stored in db.sessions.
    token_hash = hashlib.sha256(bearer_token.encode("utf-8")).hexdigest()
    try:
        current_saas_session = await raw_db.sessions.find_one({"token_hash": token_hash})
    except Exception:
        current_saas_session = None

    if current_saas_session:
        if current_saas_session.get("status") in {"revoked", "replaced"}:
            return True
        latest = await _latest_session_for_user(user_id, user_email)
        if not latest:
            return False
        return str(latest.get("_id")) != str(current_saas_session.get("_id"))

    # JWT accounts have a session record created at successful login.
    sid = None
    issued_at = None
    try:
        import jwt

        payload = jwt.decode(
            bearer_token,
            dependencies.JWT_SECRET,
            algorithms=[dependencies.ALGORITHM],
            options={"verify_exp": False},
        )
        sid = payload.get("sid")
        payload_email = str(payload.get("email") or "").strip().lower()
        if payload_email:
            user_email = payload_email
        exp = payload.get("exp")
        if exp is not None:
            issued_at = datetime.fromtimestamp(
                float(exp) - (dependencies.ACCESS_TOKEN_EXPIRE_MINUTES * 60),
                tz=timezone.utc,
            )
    except Exception:
        return False

    # For JWT-backed sessions, compare by canonical user id only. Email fallback
    # could incorrectly mark another identity as replaced when legacy duplicates exist.
    user_or_filters = [{"user_id": user_id}, {"user_id": str(user_id)}]

    if sid:
        # Check explicit session doc
        current_sess = await raw_db.session_manager.find_one({"session_token": sid})
        if not current_sess:
            current_sess = await raw_db.sessions.find_one({"session_token": sid})

        if current_sess:
            if current_sess.get("status") in {"revoked", "replaced"}:
                return True
            if current_sess.get("status") != "active":
                return True

            # If there is another active session for this user/email with a different token
            newer = await raw_db.session_manager.find_one({
                "$or": user_or_filters,
                "status": "active",
                "session_token": {"$ne": sid},
            })
            if not newer:
                newer = await raw_db.sessions.find_one({
                    "$or": user_or_filters,
                    "status": "active",
                    "session_token": {"$ne": sid},
                })
            if newer:
                newer_time = _as_utc(newer.get("login_at") or newer.get("created_at"))
                curr_time = _as_utc(current_sess.get("login_at") or current_sess.get("created_at"))
                if newer_time and curr_time and newer_time > curr_time:
                    return True
            return False
        else:
            # Session doc was replaced or not found; if another active session exists, this one was replaced
            active_other = await raw_db.session_manager.find_one({
                "$or": user_or_filters,
                "status": "active",
            })
            if not active_other:
                active_other = await raw_db.sessions.find_one({
                    "$or": user_or_filters,
                    "status": "active",
                })
            if active_other:
                return True

    # JWTs issued for non-Platform-Owner accounts must carry the server-side
    # session id created at login. A cryptographically valid legacy JWT without
    # that binding is not sufficient to authenticate a commercial session.
    if not sid:
        return False

    # Fallback for JWTs that carry a sid but whose legacy session record is not
    # currently available. Compare the token issuance time with active sessions
    # as a compatibility check rather than silently accepting an unbound token.
    try:
        active_sessions = await raw_db.session_manager.find(
            {"$or": user_or_filters, "status": "active"}
        ).to_list(1000)
    except Exception:
        return False

    if not active_sessions:
        return False

    latest_login = max(
        (
            _as_utc(session.get("login_at") or session.get("created_at"))
            for session in active_sessions
            if _as_utc(session.get("login_at") or session.get("created_at")) is not None
        ),
        default=None,
    )
    if latest_login is None or issued_at is None:
        return False

    return latest_login > issued_at.replace(microsecond=0) + timedelta(seconds=5)


class SessionManager:
    @staticmethod
    async def list_user_sessions(user_id: str, include_revoked: bool = False) -> list[dict]:
        """Return sanitized session metadata for one concrete user identity."""
        raw_db = _raw_db()
        user_id_str = str(user_id or "").strip()
        if not user_id_str:
            return []
        query = {"user_id": user_id_str}
        if not include_revoked:
            query["status"] = "active"
        sessions = await raw_db.sessions.find(query).sort("created_at", -1).to_list(100)
        result = []
        for session in sessions:
            result.append({
                "id": str(session.get("_id") or ""),
                "status": session.get("status", "active"),
                "created_at": session.get("created_at"),
                "last_seen_at": session.get("last_seen_at") or session.get("last_activity_at"),
                "expires_at": session.get("expires_at"),
                "client_ip": session.get("client_ip"),
                "user_agent": str(session.get("user_agent") or "")[:240],
                "revoked_reason": session.get("revoked_reason"),
            })
        return result

    @staticmethod
    async def revoke_user_session_by_id(user_id: str, session_id: str, reason: str = "admin_revoked") -> bool:
        """Revoke one session by Mongo id while binding it to the user identity."""
        raw_db = _raw_db()
        user_id_str = str(user_id or "").strip()
        session_id_str = str(session_id or "").strip()
        if not user_id_str or not session_id_str:
            return False
        try:
            from bson import ObjectId
            lookup_id = ObjectId(session_id_str) if ObjectId.is_valid(session_id_str) else session_id_str
        except Exception:
            lookup_id = session_id_str
        now = datetime.now(timezone.utc).isoformat()
        result = await raw_db.sessions.update_one(
            {"_id": lookup_id, "user_id": user_id_str, "status": "active"},
            {"$set": {"status": "revoked", "revoked_at": now, "revoked_reason": reason}},
        )
        return getattr(result, "modified_count", 0) > 0

    @staticmethod
    async def has_active_user_session(user_id: str, email: str = None) -> bool:
        """Return True when this account has an active session."""
        raw_db = _raw_db()
        try:
            filters = [{"user_id": str(user_id)}]
            if email:
                filters.append({"email": str(email).strip().lower()})
            session = await raw_db.session_manager.find_one(
                {"$or": filters, "status": "active"}
            )
            return session is not None
        except Exception:
            return False

    @staticmethod
    async def assert_single_device_login_allowed(user_id: str, email: str = None) -> None:
        """Allow single-session logins to proceed by superseding previous sessions."""
        return
    @staticmethod
    async def create_user_session(user_id: str, client_ip: str, user_agent: str, email: str = None) -> str:
        """Create the user's active session.

        For non-platform owners, any prior active session for the same user_id or email
        is marked as replaced so that older devices/browsers are logged out.
        Platform owners are exempted from single-device restrictions and can remain
        concurrently logged in on multiple devices.
        """
        raw_db = _raw_db()
        from backend.platform_owner import is_platform_owner

        norm_email = str(email or "").strip().lower()
        company_id = ""
        if user_id:
            try:
                found_user = await raw_db.users.find_one(
                    {"$or": [{"id": str(user_id)}, {"_id": user_id}]}
                )
                if found_user:
                    if not norm_email:
                        norm_email = str(found_user.get("email") or "").strip().lower()
                    company_id = str(found_user.get("company_id") or "").strip()
            except Exception:
                pass

        user_identity = {"id": str(user_id)}
        if norm_email:
            user_identity["email"] = norm_email

        is_owner = is_platform_owner(user_identity)
        now = datetime.now(timezone.utc).isoformat()
        now_dt = datetime.now(timezone.utc)
        expires_at = now_dt + timedelta(minutes=dependencies.ACCESS_TOKEN_EXPIRE_MINUTES)

        if not is_owner:
            # Replace sessions for this exact user only. Email is metadata,
            # not an account identity, and must never evict another user's session.
            query_filters = [{"user_id": str(user_id)}]

            replace_query = {"$or": query_filters, "status": "active"}
            replacement_update = {
                "$set": {
                    "status": "replaced",
                    "replaced_at": now,
                    "revoked_reason": "new_login",
                }
            }
            try:
                await raw_db.session_manager.update_many(replace_query, replacement_update)
            except Exception:
                logger.warning("Failed to mark previous session_manager sessions replaced.")

            try:
                await raw_db.sessions.update_many(replace_query, replacement_update)
            except Exception:
                logger.warning("Failed to mark previous sessions replaced.")

        session_token = f"sess_{uuid.uuid4().hex}"
        session_doc = {
            "session_token": session_token,
            "user_id": str(user_id),
            "email": norm_email,
            "company_id": company_id,
            "client_ip": client_ip,
            "user_agent": user_agent,
            "status": "active",
            "login_at": now,
            "created_at": now,
            "last_activity_at": now,
            "expires_at": expires_at,
        }
        await raw_db.session_manager.update_one(
            {"session_token": session_token},
            {"$set": session_doc},
            upsert=True,
        )

        # Mirror in sessions collection with sha256 token hash
        try:
            token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
            await raw_db.sessions.update_one(
                {"token_hash": token_hash},
                {"$set": {
                    "session_token": session_token,
                    "token_hash": token_hash,
                    "user_id": str(user_id),
                    "email": norm_email,
                    "company_id": company_id,
                    "status": "active",
                    "created_at": now_dt,
                    "login_at": now,
                    "last_seen_at": now_dt,
                    "expires_at": expires_at,
                }},
                upsert=True,
            )
        except Exception:
            logger.warning("SaaS session mirror write failed.")

        # A commercial login must have one session representation in both
        # stores so replacement detection remains reliable after restarts.
        try:
            legacy_ok = await raw_db.session_manager.find_one(
                {"session_token": session_token, "user_id": str(user_id), "status": "active"},
                {"_id": 1},
            )
            mirror_ok = await raw_db.sessions.find_one(
                {
                    "token_hash": hashlib.sha256(session_token.encode("utf-8")).hexdigest(),
                    "user_id": str(user_id),
                    "status": "active",
                },
                {"_id": 1},
            )
            if not legacy_ok or not mirror_ok:
                raise RuntimeError("Session state was not persisted consistently.")
        except Exception:
            logger.exception("Failed to establish canonical session state; rejecting login session.")
            try:
                await raw_db.session_manager.update_one(
                    {"session_token": session_token},
                    {"$set": {"status": "revoked", "revoked_reason": "session_state_incomplete"}},
                )
                await raw_db.sessions.update_one(
                    {"token_hash": hashlib.sha256(session_token.encode("utf-8")).hexdigest()},
                    {"$set": {"status": "revoked", "revoked_reason": "session_state_incomplete"}},
                )
            except Exception:
                pass
            raise

        return session_token

    @staticmethod
    async def revoke_session(session_token: str, expected_user_id: str | None = None) -> bool:
        """Revoke this login session in every session store.

        A login writes the session to ``session_manager`` (keyed by the token)
        and, for opaque bearer use, to ``sessions`` (keyed by its hash). Both
        are revoked, otherwise the token that was not revoked keeps working
        after logout. The session must belong to ``expected_user_id`` (the
        authenticated caller); ``sessions`` records may store the user's Mongo
        ``_id`` instead of the application id, so both are accepted.
        """
        now = datetime.now(timezone.utc).isoformat()
        raw_db = _raw_db()
        token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
        revoke = {"$set": {"status": "revoked", "logout_at": now, "revoked_reason": "logout"}}

        owner_ids = None
        if expected_user_id is not None:
            owner_ids = {str(expected_user_id)}
            try:
                from bson import ObjectId

                user_doc = await raw_db.users.find_one(
                    {"id": str(expected_user_id)}, {"_id": 1}
                )
                if user_doc and user_doc.get("_id") is not None:
                    owner_ids.add(str(user_doc["_id"]))
                if ObjectId.is_valid(str(expected_user_id)):
                    owner_ids.add(str(ObjectId(str(expected_user_id))))
            except Exception:
                pass

        def belongs(record) -> bool:
            return owner_ids is None or str(record.get("user_id")) in owner_ids

        revoked = False
        manager_record = await raw_db.session_manager.find_one({"session_token": session_token})
        if manager_record and belongs(manager_record):
            result = await raw_db.session_manager.update_one({"_id": manager_record["_id"]}, revoke)
            revoked = revoked or result.modified_count > 0

        async for record in raw_db.sessions.find(
            {"$or": [{"token_hash": token_hash}, {"session_token": session_token}]}
        ):
            if belongs(record):
                result = await raw_db.sessions.update_one({"_id": record["_id"]}, revoke)
                revoked = revoked or result.modified_count > 0
        return revoked

    @staticmethod
    async def revoke_all_user_sessions(user_id: str, reason: str = "security_event") -> int:
        """Revoke every active session for one concrete user in all session stores."""
        raw_db = _raw_db()
        now = datetime.now(timezone.utc).isoformat()
        user_id_str = str(user_id or "").strip()
        if not user_id_str:
            return 0

        update = {
            "$set": {
                "status": "revoked",
                "revoked_at": now,
                "logout_at": now,
                "revoked_reason": reason,
            }
        }
        # Session records may store the application id or the user's Mongo
        # _id (SaaS sessions do); sessions without a status count as active.
        owner_ids: list = [user_id_str]
        try:
            from bson import ObjectId

            lookup = {"id": user_id_str}
            if ObjectId.is_valid(user_id_str):
                lookup = {"$or": [{"id": user_id_str}, {"_id": ObjectId(user_id_str)}]}
            user_doc = await raw_db.users.find_one(lookup, {"_id": 1, "id": 1})
            if user_doc:
                for value in (user_doc.get("_id"), str(user_doc.get("_id") or ""), user_doc.get("id")):
                    if value not in (None, "") and value not in owner_ids:
                        owner_ids.append(value)
        except Exception:
            pass
        live = {"user_id": {"$in": owner_ids}, "status": {"$nin": ["revoked", "replaced"]}}

        total = 0
        try:
            result = await raw_db.session_manager.update_many(live, update)
            total += int(getattr(result, "modified_count", 0) or 0)
        except Exception:
            logger.warning("Failed to revoke session_manager sessions for user %s.", user_id_str)

        try:
            result = await raw_db.sessions.update_many(live, update)
            total += int(getattr(result, "modified_count", 0) or 0)
        except Exception:
            logger.warning("Failed to revoke sessions records for user %s.", user_id_str)
        return total

    @staticmethod
    async def is_session_active(session_token: str) -> bool:
        sess = await _raw_db().session_manager.find_one({"session_token": session_token})
        if not sess:
            return False
        return sess.get("status") == "active"
