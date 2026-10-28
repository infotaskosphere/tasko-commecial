import re
import logging
from typing import List, Dict, Any
from backend.dependencies import db

logger = logging.getLogger("semantic_search")

class SemanticSearch:
    @staticmethod
    async def find_by_semantic_intent(query_text: str, company_id: str) -> List[Dict[str, Any]]:
        """Maps natural query text (e.g., 'rent paid last month') to matching ledger entries."""
        q = query_text.lower()
        search_filter = {"company_id": company_id}
        
        # Build search rules based on semantic keywords
        if "rent" in q:
            search_filter["narration"] = {"$regex": "rent", "$options": "i"}
        elif "salary" in q or "payroll" in q:
            search_filter["narration"] = {"$regex": "salary|payroll", "$options": "i"}
        elif "tax" in q or "gst" in q:
            search_filter["narration"] = {"$regex": "tax|gst", "$options": "i"}
        else:
            # No recognised semantic keyword — fall back to a plain narration match
            # instead of returning up to 100 unrelated journals.
            search_filter["narration"] = {"$regex": re.escape(query_text), "$options": "i"}
            
        return await db.journals.find(search_filter).to_list(100)
