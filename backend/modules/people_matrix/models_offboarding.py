"""Canonical People Matrix offboarding request model."""
from pydantic import BaseModel
from typing import Optional

# ────────────────────────────────────────────────
# OFFBOARDING REQUEST
# ────────────────────────────────────────────────
# ────────────────────────────────────────────────
# OFFBOARDING REQUEST
# ────────────────────────────────────────────────
class OffboardRequest(BaseModel):
    replacement_user_id: str
    transfer_tasks: bool = True
    transfer_clients: bool = True
    transfer_dsc: bool = True
    transfer_documents: bool = True
    transfer_todos: bool = True
    transfer_visits: bool = True
    transfer_leads: bool = True
    update_email: Optional[str] = None
    delete_old_user: bool = True
    notes: Optional[str] = None
