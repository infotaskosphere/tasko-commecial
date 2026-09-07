"""Keep commercial administrator permissions synchronized with the active license.

Some commercial administrator accounts were created before feature-level
licensing was introduced, so their persisted permission dictionary can be
missing the new module/page flags. The SaaS session itself is authoritative
for the company; this shim hydrates the admin's permissions from the active
commercial license before governance checks run.

Important FastAPI compatibility note: this dependency must preserve the
HTTPBearer dependency on ``credentials``. Without ``Depends(security)``,
FastAPI interprets ``credentials`` as a required query parameter and governed
GET routes return HTTP 422 before their handlers execute.
"""

from datetime import datetime, timezone

from fastapi import Depends

from backend import dependencies as _dependencies
from backend.models import User
from backend.platform_owner import is_platform_owner

_original_get_current_user = _dependencies.get_current_user


def _aware(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except Exception:
        return None


async def _hydrate(user: User) -> User:
    # Platform owner permissions come from the canonical admin role, not from
    # any customer's purchased module/feature license.
    if is_platform_owner(user):
        return user

    if str(getattr(user, "role", "")).lower() != "admin":
        return user
    company_id = str(getattr(user, "company_id", "") or "").strip()
    if not company_id:
        return user

    try:
        company = await _dependencies.db.companies.find_one(
            {"id": company_id}, {"_id": 0, "source": 1}
        )
        if not company or company.get("source") != "commercial-license":
            return user

        licenses = await _dependencies.db.commercial_licenses.find(
            {"customer_id": company_id}, {"_id": 0}
        ).to_list(100)
        now = datetime.now(timezone.utc)
        active = []
        for license_doc in licenses:
            status = str(license_doc.get("status") or "active").lower()
            if status not in {"active", "trial"}:
                continue
            expires = _aware(license_doc.get("expires_at"))
            if expires and expires <= now:
                continue
            active.append(license_doc)

        if not active:
            return user

        active.sort(key=lambda x: str(x.get("issued_at") or ""), reverse=True)
        license_doc = active[0]
        modules = list(license_doc.get("modules") or license_doc.get("licensed_modules") or [])
        selected_features = license_doc.get("selected_features")

        from backend.commercial_onboarding_extensions import _apply_feature_entitlements

        permissions = _apply_feature_entitlements("admin", modules, selected_features)
        current = getattr(user, "permissions", None)
        if hasattr(current, "model_dump"):
            current = current.model_dump()
        if isinstance(current, dict):
            permissions = {**current, **permissions}

        data = user.model_dump()
        data["permissions"] = permissions
        data["licensed_modules"] = modules
        data["selected_features"] = selected_features or {}
        data["license_id"] = license_doc.get("id")
        data["license_key"] = license_doc.get("license_key")
        return User.model_validate(data)
    except Exception:
        return user


async def get_current_user_with_commercial_admin_permissions(
    credentials=Depends(_dependencies.security),
):
    user = await _original_get_current_user(credentials)
    return await _hydrate(user)


def install() -> None:
    if getattr(_dependencies.get_current_user, "__name__", "") != "get_current_user_with_commercial_admin_permissions":
        _dependencies.get_current_user = get_current_user_with_commercial_admin_permissions
