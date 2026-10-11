from __future__ import annotations

import asyncio
import inspect
import logging
from datetime import datetime

import pytz

logger = logging.getLogger(__name__)


def _tenant_targets():
    """Resolve scheduled-job tenant contexts from the central control plane."""
    from backend.dependencies import DB_NAME, client
    from backend.tenant_database_manager import tenant_database_for_customer

    async def load():
        central = client[DB_NAME]
        customers = await central.commercial_license_customers.find({}, {"_id": 0}).to_list(10000)
        targets = []
        for customer in customers:
            customer_id = str(customer.get("id") or "").strip()
            if not customer_id:
                continue
            try:
                tenant_database = tenant_database_for_customer(customer_id, customer)
            except Exception:
                logger.exception("Skipping scheduled tenant job due to invalid DB mapping: %s", customer_id)
                continue
            companies = await central.companies.find(
                {"$or": [{"commercial_customer_id": customer_id}, {"id": customer_id}]},
                {"_id": 0, "id": 1},
            ).to_list(5000)
            company_ids = sorted({str(row.get("id") or "").strip() for row in companies if row.get("id")})
            if not company_ids:
                company_ids = [customer_id]
            for company_id in company_ids:
                targets.append((customer_id, company_id, tenant_database))
        return targets

    return asyncio.run(load())


def _per_tenant(job):
    """Run an existing scheduler job inside each tenant context."""
    def run_for_tenants():
        from backend.commercial_tenant_scope import (
            reset_authenticated_customer, set_authenticated_customer,
        )
        from backend.tenant_runtime import (
            reset_authenticated_company, set_authenticated_company,
            reset_authenticated_tenant_database, set_authenticated_tenant_database,
        )
        try:
            targets = _tenant_targets()
        except Exception:
            logger.exception("Unable to resolve licensees for scheduled job %s", getattr(job, "__name__", job))
            return
        for customer_id, company_id, database_name in targets:
            customer_token = set_authenticated_customer(customer_id)
            company_token = set_authenticated_company(company_id)
            database_token = set_authenticated_tenant_database(database_name)
            try:
                result = job()
                if inspect.isawaitable(result):
                    asyncio.run(result)
            except Exception:
                logger.exception(
                    "Scheduled job %s failed for customer=%s company=%s",
                    getattr(job, "__name__", job), customer_id, company_id,
                )
            finally:
                reset_authenticated_tenant_database(database_token)
                reset_authenticated_company(company_token)
                reset_authenticated_customer(customer_token)
    run_for_tenants.__name__ = f"tenant_scoped_{getattr(job, '__name__', 'job')}"
    return run_for_tenants


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
        _per_tenant(mark_absent_users_task),
        "cron",
        hour=19,
        minute=0,
        timezone=ist,
        id="mark_absent_daily",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(force_punch_out_11pm_task),
        "cron",
        hour=23,
        minute=0,
        timezone=ist,
        id="force_punch_out_11pm",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(birthday_automation_job),
        "cron",
        hour=9,
        minute=0,
        timezone=ist,
        id="birthday_automation",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(festival_greeting_job),
        "cron",
        hour=9,
        minute=5,
        timezone=ist,
        id="festival_greetings",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(service_expiry_alert_job),
        "cron",
        hour=9,
        minute=45,
        timezone=ist,
        id="service_expiry_alerts",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(follow_up_reminder_job),
        "cron",
        hour=10,
        minute=15,
        timezone=ist,
        id="follow_up_reminders",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(wa_dsc_expiry_job),
        "cron",
        hour=9,
        minute=30,
        timezone=ist,
        id="wa_dsc_expiry_alerts",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(wa_compliance_job),
        "cron",
        hour=10,
        minute=0,
        timezone=ist,
        id="wa_compliance_reminders",
        replace_existing=True,
    )

    scheduler.add_job(
        _per_tenant(wa_scheduled_bulk_job),
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
