import logging
from typing import Dict, Any, List, Optional
from datetime import datetime, timezone
import uuid
from backend.dependencies import db

logger = logging.getLogger("conversation_manager")

class ConversationManager:
    @staticmethod
    async def create_session(user_id: str, company_id: str, title: str = "New Chat") -> Dict[str, Any]:
        """Creates a new user chat session."""
        now = datetime.now(timezone.utc).isoformat()
        session_id = str(uuid.uuid4())
        
        session_doc = {
            "id": session_id,
            "user_id": user_id,
            "company_id": company_id,
            "title": title,
            "messages": [],
            "status": "active",
            "created_at": now,
            "updated_at": now
        }
        await db.copilot_sessions.insert_one(session_doc)
        logger.info(f"Chat session {session_id} created for user {user_id}.")
        return session_doc

    @staticmethod
    async def get_session(
        session_id: str,
        user_id: str,
        company_id: str,
    ) -> Optional[Dict[str, Any]]:
        """Return a session only to its owning user inside their company."""
        if not user_id or not company_id or company_id == "default_comp":
            return None
        return await db.copilot_sessions.find_one({
            "id": session_id,
            "user_id": user_id,
            "company_id": company_id,
        })

    @staticmethod
    async def append_message(
        session_id: str,
        role: str,
        text: str,
        user_id: str,
        company_id: str,
    ) -> bool:
        """Append only to a session owned by this user and company."""
        if not user_id or not company_id or company_id == "default_comp":
            return False
        now = datetime.now(timezone.utc).isoformat()
        msg = {
            "role": role, # user, assistant
            "text": text,
            "timestamp": now
        }
        result = await db.copilot_sessions.update_one(
            {
                "id": session_id,
                "user_id": user_id,
                "company_id": company_id,
            },
            {
                "$push": {"messages": msg},
                "$set": {"updated_at": now}
            }
        )
        return result.modified_count > 0

    @staticmethod
    async def list_user_sessions(
        user_id: str,
        company_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        query: Dict[str, Any] = {"user_id": user_id}
        if company_id:
            query["company_id"] = company_id
        return await db.copilot_sessions.find(query).to_list(100)
