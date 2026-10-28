import re
import logging
from typing import List, Dict, Any, Optional
from datetime import datetime
from backend.dependencies import db

logger = logging.getLogger("ledger_search")

class LedgerSearch:
    @staticmethod
    async def filter_ledger_entries(
        company_id: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        min_amount: Optional[float] = None,
        max_amount: Optional[float] = None,
        search_query: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Performs optimized Mongo searches across general journals."""
        query = {"company_id": company_id}
        
        # Date boundary filters
        date_query = {}
        if start_date:
            date_query["$gte"] = start_date
        if end_date:
            date_query["$lte"] = end_date
        if date_query:
            query["created_at"] = date_query
            
        # Amount range filters
        amount_query = {}
        if min_amount is not None:
            amount_query["$gte"] = min_amount
        if max_amount is not None:
            amount_query["$lte"] = max_amount
        if amount_query:
            query["amount"] = amount_query
            
        if search_query:
            query["narration"] = {"$regex": re.escape(search_query), "$options": "i"}
            
        return await db.journals.find(query).sort("created_at", -1).to_list(1000)
