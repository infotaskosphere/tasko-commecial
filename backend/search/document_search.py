import re
import logging
from typing import List, Dict, Any, Optional
from backend.dependencies import db

logger = logging.getLogger("document_search")

class DocumentSearch:
    @staticmethod
    async def query_processed_documents(
        company_id: str,
        vendor_name: Optional[str] = None,
        doc_type: Optional[str] = None,
        raw_text_regex: Optional[str] = None
    ) -> List[Dict[str, Any]]:
        """Searches optical character scans and extracted metadata indices."""
        query = {"company_id": company_id}
        
        if vendor_name:
            query["vendor_name"] = {"$regex": re.escape(vendor_name), "$options": "i"}
        if doc_type:
            query["document_type"] = doc_type
        if raw_text_regex:
            query["raw_ocr_text"] = {"$regex": raw_text_regex, "$options": "i"}
            
        return await db.ai_document_memory.find(query).sort("created_at", -1).to_list(500)
