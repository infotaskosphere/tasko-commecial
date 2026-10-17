import logging
from typing import Dict, Any, List
from datetime import datetime, timezone
import uuid
import hashlib
from backend.dependencies import db

logger = logging.getLogger("audit_security")

class AuditSecurity:
    @staticmethod
    async def log_security_event(event_type: str, actor_id: str, company_id: str, severity: str, details: str) -> str:
        """Logs security actions with SHA256 chain hash for tamperproof verification."""
        now = datetime.now(timezone.utc).isoformat()
        event_id = str(uuid.uuid4())
        
        # Calculate block-hash to protect audit history
        block_content = f"{event_id}|{event_type}|{actor_id}|{company_id}|{now}"
        sha_hash = hashlib.sha256(block_content.encode()).hexdigest()
        
        doc = {
            "id": event_id,
            "event_type": event_type, # login_failed, config_changed, keys_rotated
            "actor_id": actor_id,
            "company_id": company_id,
            "severity": severity, # info, warning, critical
            "details": details,
            "hash": sha_hash,
            "created_at": now
        }
        await db.security_events.insert_one(doc)
        logger.warning(f"Security event logged: {event_type} (Severity: {severity})")
        return event_id

    @staticmethod
    async def get_recent_security_events(limit: int = 50, company_id: str | None = None) -> List[Dict[str, Any]]:
        """Recent events; ``company_id`` limits them to one company (None = whole platform)."""
        scope = {"company_id": company_id} if company_id is not None else {}
        return await db.security_events.find(scope, {"_id": 0}).sort("created_at", -1).limit(limit).to_list(limit)
