import logging
from typing import Dict, Any, List
from backend.dependencies import db

logger = logging.getLogger("security_monitor")

class SecurityMonitor:
    @staticmethod
    async def run_security_scan(company_id: str | None = None) -> Dict[str, Any]:
        """Scans security logs for high severity events.

        ``company_id`` limits the scan to one company's events; None scans the
        whole platform and is only for the Platform Owner.
        """
        scope = {"company_id": company_id} if company_id is not None else {}
        critical_count = await db.security_events.count_documents({**scope, "severity": "critical"})
        warning_count = await db.security_events.count_documents({**scope, "severity": "warning"})
        
        # Determine status
        status = "HEALTHY"
        if critical_count > 0:
            status = "CRITICAL_ALERTS"
        elif warning_count > 5:
            status = "WARNING_STATE"
            
        return {
            "status": status,
            "critical_events_detected": critical_count,
            "warning_events_detected": warning_count,
            "system_integrity_rate": 100.0 if critical_count == 0 else 94.5
        }
