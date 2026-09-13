"""Platform-owner session compatibility.

The commercial session creator intentionally skips customer subscription
validation for the Platform Owner.  It must still preserve the owner's own
company workspace so the normal tenant-aware request stack can authenticate
opaque SaaS session tokens and keep the owner's operational workspace intact.

This module is installed by the production/Vercel entry points after the app
module is loaded, so the patch remains isolated from ordinary licensee login.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner


_original_saas_session_user = _dependencies._get_saas_session_user


async def _owner_aware_saas_session_user(token: str):
    """Resolve owner opaque sessions without applying customer subscription gates."""
    if not token or not _dependencies.MONGO_URL:
        return None

    try:
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        raw_db = getattr(_dependencies, "_raw_db", _dependencies.db)
        session = await raw_db.sessions.find_one(
            {
                "token_hash": token_hash,
                "expires_at": {"$gt": datetime.now(timezone.utc)},
            }
        )
        if not session:
            return None

        user_id = session.get("user_id")
        user = None
        if user_id is not None:
            try:
                oid = user_id if isinstance(user_id, ObjectId) else ObjectId(str(user_id))
                user = await raw_db.users.find_one({"_id": oid, "status": "active"})
            except Exception:
                user = await raw_db.users.find_one(
                    {"id": str(user_id), "status": "active"}
                )
        if not user:
            return None

        # Only change the special Platform Owner path. All commercial users
        # continue through the existing company + subscription validation.
        if not is_platform_owner(user):
            return await _original_saas_session_user(token)

        company_id = user.get("company_id") or session.get("company_id")
        if not company_id:
            # The owner account is required to have its own operational
            # workspace. Do not manufacture a tenant here; fail closed rather
            # than accidentally attaching the owner to a customer company.
            return None

        company = await raw_db.companies.find_one(
            {"_id": company_id, "status": "active"}
        )
        if not company:
            try:
                company = await raw_db.companies.find_one(
                    {"_id": ObjectId(str(company_id)), "status": "active"}
                )
            except Exception:
                pass
        if not company:
            company = await raw_db.companies.find_one(
                {"id": str(company_id), "status": "active"}
            )
        if not company:
            return None

        await raw_db.sessions.update_one(
            {"_id": session.get("_id")},
            {
                "$set": {
                    "company_id": company_id,
                    "last_seen_at": datetime.now(timezone.utc),
                }
            },
        )

        user_data = {k: v for k, v in user.items() if k != "_id"}
        user_data["id"] = str(user.get("_id") or user.get("id"))
        user_data["company_id"] = str(company_id)
        user_data["company_name"] = company.get("name")
        user_data["status"] = "active"
        user_data["is_active"] = True
        user_data = _dependencies._normalize_permissions(user_data)
        return _dependencies.User(**user_data)
    except Exception as error:
        _dependencies.logger.exception("Platform-owner session resolution failed: %s", error)
        return None


def install() -> None:
    """Install the owner-aware session resolver exactly once."""
    if getattr(_dependencies._get_saas_session_user, "__name__", "") != "_owner_aware_saas_session_user":
        _dependencies._get_saas_session_user = _owner_aware_saas_session_user


def install_server_session_patch(server_module: Any) -> None:
    """Preserve the owner's company workspace in newly-created SaaS sessions."""
    original = getattr(server_module, "_create_saas_session", None)
    if original is None or getattr(original, "__name__", "") == "_owner_aware_create_saas_session":
        return

    async def _owner_aware_create_saas_session(user: dict):
        owner = is_platform_owner(user)
        owner_company_id = user.get("company_id") if owner else None
        result = await original(user)
        if not owner or not owner_company_id:
            return result

        try:
            session_token, access_token, session_user = result
            raw_db = getattr(server_module, "_raw_db", getattr(_dependencies, "_raw_db", _dependencies.db))
            token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
            await raw_db.sessions.update_one(
                {"token_hash": token_hash},
                {"$set": {"company_id": owner_company_id}},
            )

            company = await raw_db.companies.find_one(
                {"id": str(owner_company_id)}, {"_id": 0, "name": 1}
            )
            if not company:
                try:
                    company = await raw_db.companies.find_one(
                        {"_id": ObjectId(str(owner_company_id))}, {"name": 1}
                    )
                except Exception:
                    company = None

            data = session_user.model_dump() if hasattr(session_user, "model_dump") else dict(session_user)
            data["company_id"] = str(owner_company_id)
            data["company_name"] = (company or {}).get("name")
            session_user = _dependencies.User.model_validate(data)
            return session_token, access_token, session_user
        except Exception as error:
            _dependencies.logger.exception("Platform-owner session workspace patch failed: %s", error)
            raise

    _owner_aware_create_saas_session.__name__ = "_owner_aware_create_saas_session"
    server_module._create_saas_session = _owner_aware_create_saas_session
