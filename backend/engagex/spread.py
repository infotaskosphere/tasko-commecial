"""Spread a campaign over several days.

Two optional, per-campaign settings (both channels):

* ``daily_limit`` — send at most this many messages per local calendar day;
  the rest continue the next day.
* ``send_start_hour`` / ``send_end_hour`` — only send within these local hours
  (e.g. 10 → 19); outside them the campaign waits for the next window.

Times are in ``timezone`` (default Asia/Kolkata). The worker checks this
before every message and, when it must wait, hands the campaign back to the
scheduler with a resume time, so it carries on by itself over as many days as
it needs.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Optional
from zoneinfo import ZoneInfo

DEFAULT_TZ = "Asia/Kolkata"


def _tz(name: Optional[str]):
    try:
        return ZoneInfo(str(name or DEFAULT_TZ))
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def _window(settings: dict) -> Optional[tuple[int, int]]:
    try:
        start = settings.get("send_start_hour")
        end = settings.get("send_end_hour")
        if start is None or end is None:
            return None
        start, end = int(start), int(end)
    except (TypeError, ValueError):
        return None
    if not (0 <= start < end <= 24):
        return None
    return start, end


def next_window_start(now_local: datetime, settings: dict, *, skip_today: bool = False) -> datetime:
    """Start of the next sending window (or next midnight without a window)."""
    window = _window(settings)
    start_hour = window[0] if window else 0
    candidate = now_local.replace(hour=start_hour, minute=0, second=0, microsecond=0)
    if skip_today or candidate <= now_local:
        candidate += timedelta(days=1)
    return candidate


def outside_window(now_local: datetime, settings: dict) -> Optional[datetime]:
    """When outside the sending hours: the next window start; otherwise None."""
    window = _window(settings)
    if not window:
        return None
    start, end = window
    if start <= now_local.hour < end:
        return None
    return next_window_start(now_local, settings, skip_today=now_local.hour >= end)


def local_day_start_utc(now_local: datetime) -> datetime:
    return now_local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(timezone.utc)


async def spread_wait(campaign: dict, sent_today_counter, now: Optional[datetime] = None) -> Optional[tuple]:
    """(resume_at_utc, reason) when the campaign must wait for its next slot.

    ``sent_today_counter(since_utc)`` returns how many of this campaign's
    messages were sent since the start of the local day."""
    settings = campaign.get("settings") or {}
    tz = _tz(settings.get("timezone"))
    now_local = (now or datetime.now(timezone.utc)).astimezone(tz)
    resume = outside_window(now_local, settings)
    if resume is not None:
        start, end = _window(settings)
        return resume.astimezone(timezone.utc), (
            f"Outside sending hours ({start:02d}:00–{end % 24:02d}:00). Continues automatically at "
            f"{resume:%d %b %H:%M}.")
    try:
        limit = int(settings.get("daily_limit") or 0)
    except (TypeError, ValueError):
        limit = 0
    if limit > 0:
        sent_today = await sent_today_counter(local_day_start_utc(now_local))
        if sent_today >= limit:
            resume = next_window_start(now_local, settings, skip_today=True)
            return resume.astimezone(timezone.utc), (
                f"Today's limit of {limit} reached for this campaign. The rest continues automatically on "
                f"{resume:%d %b} at {resume:%H:%M}.")
    return None
