"""Platform-owner and SaaS session compatibility.

The commercial session creator stores an opaque session token, but its legacy
return tuple used the user's id as the second value. The frontend treats that
second value as ``access_token`` and sends it as a Bearer token, which causes
all authenticated API requests to return 401 after a successful login.

The Platform Owner is not a licensee. The owner therefore needs a dedicated
operational workspace that is independent from ``commercial_license_customers``
and customer subscription validation. If an old owner company link was removed
from the licensee registry, this module restores the owner's workspace link
without recreating a licensee/customer record.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId

from backend import dependencies as _dependencies
from backend.platform_owner import is_platform_owner


logger = logging.getLogger(__name__)

_original_saas_session_user = _dependencies._get_saas_session_user


def _owner_workspace_id(user: dict) -> str:
    """Return a stable workspace id that is never a commercial customer id."""
    email = str(user.get("email") or "").strip().lower()
    digest = hashlib.sha256(email.encode("utf-8")).hexdigest()[:16]
    return f"platform-owner-{digest}"


def _company_name_key(value: Any) -> str:
    tokens = re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).split()
    aliases = {"private": "pvt", "p": "pvt", "limited": "ltd"}
    return " ".join(aliases.get(token, token) for token in tokens)


async def _has_separate_licensee_counterpart(raw_db: Any, candidate: dict) -> bool:
    """Confirm duplicate customer/license markers exist on a separate tenant row."""
    company_id = str(candidate.get("id") or "").strip()
    customer_id = str(candidate.get("commercial_customer_id") or "").strip()
    license_id = str(candidate.get("license_id") or "").strip()
    clauses = []
    if customer_id:
        clauses.extend([
            {"id": customer_id},
            {"commercial_customer_id": customer_id},
        ])
    if license_id:
        clauses.append({"license_id": license_id})
    if not company_id or not clauses:
        return False

    counterpart = await raw_db.companies.find_one(
        {
            "$and": [
                {"id": {"$ne": company_id}},
                {"is_platform_owner_workspace": {"$ne": True}},
                {"$or": clauses},
            ]
        },
        {"_id": 0, "id": 1, "source": 1, "commercial_customer_id": 1, "license_id": 1},
    )
    if not counterpart:
        return False

    # A matching row must itself be tied to the same customer or license, not
    # merely have a similar company name.
    return bool(
        (customer_id and (
            str(counterpart.get("id") or "").strip() == customer_id
            or str(counterpart.get("commercial_customer_id") or "").strip() == customer_id
        ))
        or (license_id and str(counterpart.get("license_id") or "").strip() == license_id)
    )


async def _ensure_owner_workspace(raw_db: Any, user: dict, session: dict | None = None) -> tuple[str, dict]:
    """Resolve or create the Platform Owner's independent operational company."""
    user_company_id = str(user.get("company_id") or "").strip()
    session_company_id = str((session or {}).get("company_id") or "").strip()

    # Keep the public/stable owner account ID distinct from Mongo's internal
    # ObjectId. Company records created by Master Data store the stable ID in
    # created_by, so confusing these IDs makes legitimate owner firms disappear.
    owner_ids = {
        str(user.get("id") or "").strip(),
        str(user.get("_id") or "").strip(),
    } - {""}
    configured_workspace_id = str(os.getenv("PLATFORM_OWNER_WORKSPACE_ID") or "").strip()
    owner_workspace_id = configured_workspace_id or _owner_workspace_id(user)
    company = None

    # Highest precedence: a deployment-configured workspace ID, but only if
    # the existing record is explicitly marked as the owner workspace and is
    # not linked to a commercial customer/license.
    if configured_workspace_id:
        candidate = await raw_db.companies.find_one(
            {"id": configured_workspace_id,
             "status": {"$nin": ["deleted", "inactive", "disabled"]}}
        )
        if candidate:
            # Needed by the marked-workspace exception below too; historically
            # source was initialized only for legacy records without this marker.
            source = str(candidate.get("source") or "").strip().lower()
        if candidate and candidate.get("is_platform_owner_workspace") is not True:
            # Some legitimate owner workspaces pre-date the owner marker.
            # Adopt one only when the deployment explicitly names its exact ID,
            # its legal name matches configuration, its creator is independently
            # recognized as a Platform Owner, and no commercial-license linkage
            # exists. Never infer ownership from company name alone.
            configured_name = str(os.getenv("PLATFORM_OWNER_WORKSPACE_NAME") or "").strip()
            source = str(candidate.get("source") or "").strip().lower()
            is_commercial_source = source in {
                "commercial-license", "commercial", "license", "commercial-customer"
            }
            import re
            def _name_key(value: Any) -> str:
                tokens = re.sub(r"[^a-z0-9]+", " ", str(value or "").strip().lower()).split()
                aliases = {"private": "pvt", "p": "pvt", "limited": "ltd"}
                return " ".join(aliases.get(token, token) for token in tokens)
            creator_id = str(candidate.get("created_by") or "").strip()
            creator = None
            if creator_id:
                creator = await raw_db.users.find_one(
                    {"id": creator_id}, {"_id": 0, "id": 1, "email": 1, "role": 1,
                     "is_platform_owner": 1, "isPlatformOwner": 1, "company_id": 1,
                     "identity_type": 1, "licensee_uid": 1, "commercial_customer_id": 1,
                     "license_id": 1, "platform_owner_uid": 1, "identity_org_uid": 1,
                     "user_uid": 1}
                )
                if not creator:
                    try:
                        creator = await raw_db.users.find_one(
                            {"_id": ObjectId(creator_id)}, {"_id": 1, "id": 1, "email": 1,
                             "role": 1, "is_platform_owner": 1, "isPlatformOwner": 1,
                             "company_id": 1, "identity_type": 1, "licensee_uid": 1,
                             "commercial_customer_id": 1, "license_id": 1,
                             "platform_owner_uid": 1, "identity_org_uid": 1, "user_uid": 1}
                        )
                    except Exception:
                        creator = None
            if not (
                not is_commercial_source
                and configured_name
                and _name_key(candidate.get("name")) == _name_key(configured_name)
                and creator
                and is_platform_owner(creator)
            ):
                candidate = None
        if candidate:
            customer_id = str(candidate.get("commercial_customer_id") or "").strip()
            license_id = str(candidate.get("license_id") or "").strip()
            license_ref = await raw_db.commercial_licenses.find_one(
                {
                    "$or": [
                        {"id": configured_workspace_id},
                        {"company_id": configured_workspace_id},
                        {"customer_id": configured_workspace_id},
                        {"id": license_id} if license_id else {"id": "__no_license__"},
                        {"customer_id": customer_id} if customer_id else {"customer_id": "__no_customer__"},
                    ]
                },
                {"_id": 1},
            )
            # A stale/misconfigured workspace ID must never break owner login,
            # and must never cause a licensee company to be adopted as the owner.
            # Reject it and continue through the independently validated owner
            # workspace discovery/creation path below.
            configured_workspace_is_commercial = (
                customer_id not in {"", "platform-owner"}
                or license_id not in {"", "platform-owner-license"}
                or bool(license_ref)
            )
            if customer_id:
                active_license = await raw_db.commercial_licenses.find_one(
                    {"customer_id": customer_id, "status": {"$in": ["active", "trial"]}},
                    {"_id": 1},
                )
                configured_workspace_is_commercial = (
                    configured_workspace_is_commercial or bool(active_license)
                )

            # Recovery for the exact mis-stamped owner workspace: accept stale
            # customer/license markers only when the row is explicitly marked,
            # configured by ID and name, created by a verified owner, and a
            # distinct non-owner company row proves that the same licensee has
            # its own record. Never use name similarity as the ownership proof.
            creator_id = str(candidate.get("created_by") or "").strip()
            owner_creator = creator_id in owner_ids
            if not owner_creator and creator_id:
                creator_doc = await raw_db.users.find_one(
                    {"id": creator_id},
                    {
                        "_id": 0, "id": 1, "email": 1, "role": 1,
                        "is_platform_owner": 1, "isPlatformOwner": 1,
                        "identity_type": 1, "licensee_uid": 1,
                        "commercial_customer_id": 1, "license_id": 1,
                        "platform_owner_uid": 1, "identity_org_uid": 1, "user_uid": 1,
                    },
                )
                owner_creator = bool(creator_doc and is_platform_owner(creator_doc))
            configured_name = str(os.getenv("PLATFORM_OWNER_WORKSPACE_NAME") or "").strip()
            stale_linked_owner_workspace = bool(
                candidate.get("is_platform_owner_workspace") is True
                and configured_workspace_id == str(candidate.get("id") or "").strip()
                and configured_name
                and _company_name_key(candidate.get("name")) == _company_name_key(configured_name)
                and owner_creator
                and source not in {"commercial-license", "commercial", "license", "commercial-customer"}
                and await _has_separate_licensee_counterpart(raw_db, candidate)
            )
            if stale_linked_owner_workspace:
                configured_workspace_is_commercial = False

            if configured_workspace_is_commercial:
                logger.error(
                    "Ignoring PLATFORM_OWNER_WORKSPACE_ID because it resolves to a "
                    "commercial tenant; resolving a separate Platform Owner workspace"
                )
                candidate = None
            if candidate:
                company = candidate

    # Existing marked Master Data firms do not necessarily have source='platform-owner'.
    # Reuse a unique marker-backed company only when creator/owner metadata proves
    # it belongs to the authenticated Platform Owner, and it is not license-linked.
    if not company:
        marked_rows = await raw_db.companies.find(
            {"is_platform_owner_workspace": True,
             "status": {"$nin": ["deleted", "inactive", "disabled"]}},
            {"_id": 0},
        ).to_list(100)
        owned_marked = []
        for candidate in marked_rows:
            creator = str(candidate.get("created_by") or "").strip()
            owner_user_id = str(candidate.get("owner_user_id") or "").strip()
            if creator not in owner_ids and owner_user_id not in owner_ids:
                continue
            customer_id = str(candidate.get("commercial_customer_id") or "").strip()
            license_id = str(candidate.get("license_id") or "").strip()
            company_id = str(candidate.get("id") or "").strip()
            license_ref = await raw_db.commercial_licenses.find_one(
                {
                    "$or": [
                        {"id": company_id},
                        {"company_id": company_id},
                        {"customer_id": company_id},
                        {"id": license_id} if license_id else {"id": "__no_license__"},
                        {"customer_id": customer_id} if customer_id else {"customer_id": "__no_customer__"},
                    ]
                },
                {"_id": 1},
            )
            if (
                customer_id not in {"", "platform-owner"}
                or license_id not in {"", "platform-owner-license"}
                or license_ref
            ):
                continue
            if customer_id:
                active_license = await raw_db.commercial_licenses.find_one(
                    {"customer_id": customer_id, "status": {"$in": ["active", "trial"]}},
                    {"_id": 1},
                )
                if active_license:
                    continue
            if license_id and license_id != "platform-owner-license":
                active_license = await raw_db.commercial_licenses.find_one(
                    {"id": license_id, "status": {"$in": ["active", "trial"]}},
                    {"_id": 1},
                )
                if active_license:
                    continue
            owned_marked.append(candidate)
        if len(owned_marked) == 1:
            company = owned_marked[0]

    # Backward-compatible exact generated workspace, when already present.
    if not company:
        company = await raw_db.companies.find_one(
            {"id": owner_workspace_id, "status": "active"}
        )
    if not company:
        company = await raw_db.companies.find_one(
            {"source": "platform-owner", "is_platform_owner_workspace": True, "status": "active"}
        )
        if company:
            owner_workspace_id = str(company.get("id"))
    if company:
        owner_workspace_id = str(company.get("id") or owner_workspace_id)

    # If the owner still points at an existing company, keep that workspace
    # rather than unnecessarily moving the owner's operational data. Only use
    # it when it is not currently backed by an active customer license.
    if not company:
        for candidate_id in (user_company_id, session_company_id):
            if not candidate_id:
                continue
            candidate = await raw_db.companies.find_one(
                {"id": candidate_id, "status": "active"}
            )
            if not candidate:
                try:
                    candidate = await raw_db.companies.find_one(
                        {"_id": ObjectId(candidate_id), "status": "active"}
                    )
                except Exception:
                    candidate = None
            if not candidate:
                continue

            commercial_customer_id = str(candidate.get("commercial_customer_id") or "").strip()
            commercial_license_id = str(candidate.get("license_id") or "").strip()
            candidate_company_id = str(candidate.get("id") or candidate_id).strip()
            linked_commercial_license = await raw_db.commercial_licenses.find_one(
                {
                    "$or": [
                        {"id": candidate_company_id},
                        {"company_id": candidate_company_id},
                        {"customer_id": candidate_company_id},
                        {"id": commercial_license_id} if commercial_license_id else {"id": "__no_license__"},
                        {"customer_id": commercial_customer_id} if commercial_customer_id else {"customer_id": "__no_customer__"},
                    ]
                },
                {"_id": 1},
            )
            if (
                commercial_customer_id not in {"", "platform-owner"}
                or commercial_license_id not in {"", "platform-owner-license"}
                or linked_commercial_license
            ):
                continue
            active_customer_license = False
            if commercial_customer_id:
                active_customer_license = bool(
                    await raw_db.commercial_licenses.find_one(
                        {"customer_id": commercial_customer_id, "status": {"$in": ["active", "trial"]}},
                        {"_id": 1},
                    )
                )
            if not active_customer_license:
                company = candidate
                owner_workspace_id = candidate_company_id
                break

    # The owner workspace must not depend on the licensee registry. Create it
    # only when no safe existing owner company can be reused.
    if not company:
        now = datetime.now(timezone.utc).isoformat()
        owner_name = str(
            user.get("company_name")
            or os.getenv("PLATFORM_OWNER_COMPANY_NAME", "Taskosphere Platform Owner")
        ).strip()
        company = {
            "id": owner_workspace_id,
            "name": owner_name,
            "source": "platform-owner",
            "is_platform_owner_workspace": True,
            "owner_user_id": str(user.get("id") or user.get("_id") or ""),
            "status": "active",
            "created_at": now,
            "updated_at": now,
        }
        await raw_db.companies.update_one(
            {"id": owner_workspace_id},
            {"$setOnInsert": company},
            upsert=True,
        )
        company = await raw_db.companies.find_one(
            {"id": owner_workspace_id, "status": "active"}
        ) or company
    else:
        owner_workspace_id = str(company.get("id") or owner_workspace_id)
        # Explicitly mark an owner workspace so future license/customer lists
        # cannot treat it as a normal commercial-license company.
        await raw_db.companies.update_one(
            {"id": owner_workspace_id},
            {
                "$set": {
                    "is_platform_owner_workspace": True,
                    "owner_user_id": str(user.get("id") or user.get("_id") or ""),
                }
            },
        )
        company["is_platform_owner_workspace"] = True

    # Persist the recovered workspace on the owner user so deleting a customer
    # registry entry cannot break the next login.
    user_query: dict[str, Any]
    if user.get("_id") is not None:
        user_query = {"_id": user.get("_id")}
    else:
        user_query = {"id": str(user.get("id") or "")}
    if user_query.get("id") or user_query.get("_id") is not None:
        await raw_db.users.update_one(
            user_query,
            {
                "$set": {
                    "company_id": owner_workspace_id,
                    "company_name": company.get("name") or "Taskosphere Platform Owner",
                }
            },
        )

    return owner_workspace_id, company


async def _owner_aware_saas_session_user(token: str):
    """Resolve owner sessions without treating the owner as a licensee."""
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

        company_id, company = await _ensure_owner_workspace(raw_db, user, session)

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
        user_data["id"] = str(user.get("id") or user.get("_id"))
        user_data["company_id"] = str(company_id)
        user_data["company_name"] = company.get("name") or "Taskosphere Platform Owner"
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
    """Fix login access-token compatibility and preserve the owner workspace."""
    original = getattr(server_module, "_create_saas_session", None)
    if original is None or getattr(original, "__name__", "") == "_owner_aware_create_saas_session":
        return

    async def _owner_aware_create_saas_session(user: dict):
        owner = is_platform_owner(user)
        result = await original(user)

        session_token, _legacy_access_value, session_user = result
        user_id = str(
            getattr(session_user, "id", "")
            or user.get("_id")
            or user.get("id")
            or ""
        )
        access_token = _dependencies.create_access_token({"sub": user_id})

        if not owner:
            return session_token, access_token, session_user

        try:
            raw_db = getattr(
                server_module,
                "_raw_db",
                getattr(_dependencies, "_raw_db", _dependencies.db),
            )
            company_id, company = await _ensure_owner_workspace(raw_db, user)
            token_hash = hashlib.sha256(session_token.encode("utf-8")).hexdigest()
            await raw_db.sessions.update_one(
                {"token_hash": token_hash},
                {"$set": {"company_id": company_id}},
            )

            data = (
                session_user.model_dump()
                if hasattr(session_user, "model_dump")
                else dict(session_user)
            )
            data["company_id"] = str(company_id)
            data["company_name"] = company.get("name") or "Taskosphere Platform Owner"
            session_user = _dependencies.User.model_validate(data)
            return session_token, access_token, session_user
        except Exception as error:
            _dependencies.logger.exception(
                "Platform-owner session workspace patch failed: %s", error
            )
            raise

    _owner_aware_create_saas_session.__name__ = "_owner_aware_create_saas_session"
    server_module._create_saas_session = _owner_aware_create_saas_session
    # login() now lives in a real module and looks the helper up in that
    # module's own globals, so patch it there too.
    import sys as _sys
    _auth_routes = _sys.modules.get("backend.server_modules.routes.auth_routes")
    if _auth_routes is not None and hasattr(_auth_routes, "_create_saas_session"):
        _auth_routes._create_saas_session = _owner_aware_create_saas_session


def bootstrap_server(module_name: str) -> None:
    """Install session/licence compatibility on the composed backend.server module.

    (Formerly backend/startup_compat.py.) Commercial entitlement hydration is
    installed once by backend/__init__.py inside the auth chain, before route
    modules capture get_current_user; it is deliberately NOT re-installed here.
    """
    import sys

    install()
    install_server_session_patch(sys.modules[module_name])
