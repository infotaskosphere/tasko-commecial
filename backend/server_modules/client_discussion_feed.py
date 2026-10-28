"""LeadSense Client Discussion collection feed.

The LeadSense hub requests a collection-level /api/client-discussion feed.
The client_activity router is intentionally client-scoped, so it cannot
satisfy that collection endpoint. Expose a read-only aggregate feed from the
same client_activities collection (tenant-scoped by the database facade)
without changing the existing client activity APIs.
"""
from fastapi import Depends

from backend.dependencies import db, get_current_user


async def _leadsense_client_discussion_feed(current_user=Depends(get_current_user)):
    items = await db.client_activities.find(
        {},
        {"_id": 0},
    ).sort("created_at", -1).limit(500).to_list(500)
    return items


def register_client_discussion_feed(app) -> None:
    for path in ("/api/client-discussion", "/api/client-discussion/"):
        app.add_api_route(
            path,
            _leadsense_client_discussion_feed,
            methods=["GET"],
            include_in_schema=False,
        )
