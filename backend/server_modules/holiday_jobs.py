from __future__ import annotations

import asyncio
import logging
from datetime import datetime

import pytz
import requests

from backend.dependencies import db

logger = logging.getLogger(__name__)
IST = pytz.timezone("Asia/Kolkata")


def fetch_indian_holidays_task():
    """
    Scheduled job (sync wrapper for BackgroundScheduler) to fetch holidays.
    Uses run_coroutine_threadsafe so Motor futures stay on the main event loop.
    """

    async def _async_fetch():
        try:
            now = datetime.now(IST)
            for year in [now.year, now.year + 1]:
                url = f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN"
                response = requests.get(url, timeout=10)
                if response.status_code != 200:
                    continue
                external_holidays = response.json()
                count = 0
                for h in external_holidays:
                    date_str = h["date"]
                    existing = await db.holidays.find_one(
                        {"date": date_str}, {"_id": 0}
                    )
                    if not existing:
                        new_holiday = {
                            "date": date_str,
                            "name": h.get("localName") or h.get("name", "Holiday"),
                            "status": "confirmed",
                            "type": "public",
                            "created_at": datetime.now(IST).isoformat(),
                        }
                        await db.holidays.insert_one(new_holiday)
                        count += 1
                    elif existing.get("status") not in ("confirmed", "rejected"):
                        await db.holidays.update_one(
                            {"date": date_str}, {"$set": {"status": "confirmed"}}
                        )
                logger.info(f"Auto-synced holidays for {year}: {count} new")
        except Exception as e:
            logger.error(f"Holiday Autofetch Failed: {str(e)}")

    try:
        import backend.server as _self

        loop = _self.app_event_loop
        if loop is None or loop.is_closed():
            logger.warning(
                "fetch_indian_holidays_task: main event loop not ready, skipping."
            )
            return
        future = asyncio.run_coroutine_threadsafe(_async_fetch(), loop)
        future.result(timeout=120)
    except Exception as e:
        logger.error(f"fetch_indian_holidays_task failed: {e}")
