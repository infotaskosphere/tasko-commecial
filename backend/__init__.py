# Load the admin identity compatibility layer before backend.server imports
# route dependencies. This is required for Render deployments that start via
# `uvicorn backend.server:app` instead of backend/run.py.
import backend.admin_identity_compat  # noqa: F401

# Install the commercial tenant module cap before route modules import
# get_current_user. Internal admins remain unrestricted; licensed company
# accounts are denied at the API boundary when a request targets an unlicensed
# module.
import backend.commercial_module_guard as _commercial_module_guard
_commercial_module_guard.install()

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
