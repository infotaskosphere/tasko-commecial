# Load the admin identity compatibility layer before backend.server imports
# route dependencies. This is required for Render deployments that start via
# `uvicorn backend.server:app` instead of backend/run.py.
import backend.admin_identity_compat  # noqa: F401

# Commercial administrator accounts created before feature-level licensing may
# not have the current module/page flags persisted. Hydrate them from the
# active commercial license before installing the API entitlement guard.
import backend.commercial_admin_permission_compat as _commercial_admin_permission_compat
_commercial_admin_permission_compat.install()

# Install the commercial tenant module cap before route modules import
# get_current_user. Internal admins remain unrestricted; licensed company
# accounts are denied at the API boundary when a request targets an unlicensed
# module.
import backend.commercial_module_guard as _commercial_module_guard
_commercial_module_guard.install()

# Load the commercial licensing extension before governed_modules registers the
# legacy commercial router. The extension registers the same public prefix
# first, so its feature-level licensing and invoice workflow takes precedence.
import backend.commercial_onboarding_extensions  # noqa: F401

# Company Master user administration is deliberately outside People Matrix
# licensing. It uses the same users collection and HR fields so every module
# can share one company-scoped user source of truth.
import backend.commercial_master_data  # noqa: F401

# AI Document Reader workspace: persistent company-scoped memory for multiple
# documents and cross-document reasoning. It is mounted onto the existing AI
# reader router so the existing /api/ai/analyze-document route is unchanged.
from backend.ai_document_reader import router as _ai_document_reader_router
from backend.ai.workspace_router import router as _ai_workspace_router
_ai_document_reader_router.include_router(_ai_workspace_router)

# Compatibility shims must load before backend.server imports its routers.
# The user projection shim prevents legacy HR/attendance handlers from losing
# the UUID `id` field in narrow Mongo projections. The WhatsApp SSE shim lets
# EventSource authenticate commercial opaque SaaS session tokens as well as
# legacy JWT tokens.
import backend.user_projection_compat  # noqa: F401
import backend.whatsapp_sse_compat as _whatsapp_sse_compat
_whatsapp_sse_compat.install()

import logging
from datetime import datetime, timezone, timedelta
from typing import Dict, Any

logger = logging.getLogger("enterprise_license")

class EnterpriseLicense:
    @staticmethod
    def generate_unlimited_license(tenant_id: str, subsidiary_count: int = 10) -> Dict[str, Any]:
        """Assembles a premium holding company license template supporting multi-branch setups."""
        now = datetime.now(timezone.utc)
        expires = now + timedelta(days=365)
        return {
            "tenant_id": tenant_id,
            "license_type": "enterprise_unlimited",
            "max_users": 5000,
            "subsidiary_count_allowed": subsidiary_count,
            "status": "active",
            "expires_at": expires.isoformat()
        }
