from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import Depends, HTTPException

from backend.dependencies import db, get_current_user
from backend.models import User

logger = logging.getLogger(__name__)


@api_router.get("/activity/websites")
async def get_website_activity(current_user: User = Depends(get_current_user)):
    try:
        pipeline = [
            {"$match": {"user_id": current_user.id, "type": "website"}},
            {
                "$group": {
                    "_id": "$user_id",
                    "websites": {
                        "$push": {
                            "url": "$url",
                            "domain": "$domain",
                            "title": "$title",
                            "duration": "$duration",
                            "timestamp": "$timestamp",
                        }
                    },
                }
            },
            {"$project": {"_id": 0, "user_id": "$_id", "websites": 1}},
        ]

        data = await db.staff_activity.aggregate(pipeline).to_list(100)

        return data

    except Exception as e:
        logger.error(f"Fetch website activity error: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to fetch website activity")


@api_router.post("/activity/track-website")
async def track_website(data: dict, current_user: User = Depends(get_current_user)):
    try:
        url = data.get("url")
        domain = data.get("domain")

        if not url or not domain:
            raise HTTPException(status_code=400, detail="Invalid website data")

        activity = {
            "id": str(uuid.uuid4()),
            "user_id": current_user.id,
            "type": "website",
            "url": url,
            "domain": domain,
            "title": data.get("title", ""),
            "timestamp": datetime.now(timezone.utc),
            "duration": int(data.get("duration", 0)),
        }

        await db.staff_activity.insert_one(activity)

        return {"status": "tracked"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Website tracking error: {str(e)}")
        raise HTTPException(status_code=500, detail="Tracking failed")
