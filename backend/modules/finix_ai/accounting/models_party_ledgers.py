"""Finix domain models extracted from backend/party_ledgers.py."""
from datetime import date
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, ConfigDict

class RenameRequest(dict):
    pass

