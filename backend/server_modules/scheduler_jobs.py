from __future__ import annotations

import logging
from datetime import datetime

import pytz

logger = logging.getLogger(__name__)


def register_scheduler_jobs(
    scheduler,
    *,
    fetch_indian_holidays_task,
    mark_absent_users_task,
    force_punch_out_11pm_task,
    birthday_automation_job,
    festival_greeting_job,
    service_expiry_alert_job,
    follow_up_reminder_job,
    wa_dsc_expiry_job,
    wa_compliance_job,
    wa_scheduled_bulk_job,
    wa_bridge_keepalive_job,
):
    """Register the existing APScheduler jobs without changing their behavior.

    This function only owns job registration. Job implementations, schedules,
    IDs, timezone, replace_existing behavior, and scheduler.start() semantics
    remain unchanged from backend.server.
    """
    ist = pytz.timezone("Asia/Kolkata")

    scheduler.add_job(
        fetch_indian_holidays_task,
        "cron",
        day=1,
        hour=0,
        minute=5,
    )
    scheduler.add_job(
        fetch_indian_holidays_task,
        "date",
        run_date=datetime.now(ist),
    )

    scheduler.add_job(
        mark_absent_users_task,
        "cron",
        hour=19,
        minute=0,
        timezone=ist,
        id="mark_absent_daily",
        replace_existing=True,
    )

    scheduler.add_job(
        force_punch_out_11pm_task,
        "cron",
        hour=23,
        minute=0,
        timezone=ist,
        id="force_punch_out_11pm",
        replace_existing=True,
    )

    scheduler.add_job(
        birthday_automation_job,
        "cron",
        hour=9,
        minute=0,
        timezone=ist,
        id="birthday_automation",
        replace_existing=True,
    )

    scheduler.add_job(
        festival_greeting_job,
        "cron",
        hour=9,
        minute=5,
        timezone=ist,
        id="festival_greetings",
        replace_existing=True,
    )

    scheduler.add_job(
        service_expiry_alert_job,
        "cron",
        hour=9,
        minute=45,
        timezone=ist,
        id="service_expiry_alerts",
        replace_existing=True,
    )

    scheduler.add_job(
        follow_up_reminder_job,
        "cron",
        hour=10,
        minute=15,
        timezone=ist,
        id="follow_up_reminders",
        replace_existing=True,
    )

    scheduler.add_job(
        wa_dsc_expiry_job,
        "cron",
        hour=9,
        minute=30,
        timezone=ist,
        id="wa_dsc_expiry_alerts",
        replace_existing=True,
    )

    scheduler.add_job(
        wa_compliance_job,
        "cron",
        hour=10,
        minute=0,
        timezone=ist,
        id="wa_compliance_reminders",
        replace_existing=True,
    )

    scheduler.add_job(
        wa_scheduled_bulk_job,
        "interval",
        minutes=1,
        id="wa_scheduled_bulk",
        replace_existing=True,
    )

    scheduler.add_job(
        wa_bridge_keepalive_job,
        "interval",
        minutes=5,
        id="wa_bridge_keepalive",
        replace_existing=True,
    )
