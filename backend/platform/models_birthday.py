"""Platform email integration request models extracted from the legacy compatibility module."""
from pydantic import BaseModel

class BirthdayEmailRequest(BaseModel):
    client_id: str
