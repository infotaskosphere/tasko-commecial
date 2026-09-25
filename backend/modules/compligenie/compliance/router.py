"""CompliGenie compliance router migration adapter."""
from backend.server_modules.compliance_due_dates import register_compliance_due_dates

def register(namespace):
    return register_compliance_due_dates(namespace)

__all__ = ["register"]
