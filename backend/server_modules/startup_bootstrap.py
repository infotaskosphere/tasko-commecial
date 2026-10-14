from __future__ import annotations

import asyncio
import logging
import os

import httpx
import pytz
from datetime import datetime

logger = logging.getLogger(__name__)


async def start_bootstrap_tasks(*, db, logger_instance=None):
    """Start the existing non-blocking startup/bootstrap tasks."""
    _logger = logger_instance or logger

    async def _boot_holiday_sync():
        try:
            import httpx as _httpx
            now_ist = datetime.now(pytz.timezone("Asia/Kolkata"))
            total_added = 0
            for year in [now_ist.year, now_ist.year + 1]:
                try:
                    async with _httpx.AsyncClient(timeout=10) as http:
                        resp = await http.get(f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN")
                    if resp.status_code != 200:
                        continue
                    for h in resp.json():
                        date_str = h["date"]
                        name = h.get("localName") or h.get("name", "Holiday")
                        existing = await db.holidays.find_one({"date": date_str}, {"_id": 0})
                        if not existing:
                            await db.holidays.insert_one({"date": date_str, "name": name, "status": "confirmed", "type": "public", "created_at": now_ist.isoformat()})
                            total_added += 1
                        elif existing.get("status") not in ("confirmed", "rejected"):
                            await db.holidays.update_one({"date": date_str}, {"$set": {"status": "confirmed"}})
                except Exception as year_err:
                    logger.warning(f"Holiday sync for {year} failed: {year_err}")
            logger.info(f"Boot holiday sync complete: {total_added} new holidays added")
        except Exception as e:
            logger.warning(f"Boot holiday sync failed (non-fatal): {e}")

    asyncio.create_task(_boot_holiday_sync())

    async def _keep_alive_ping():
        await asyncio.sleep(60)
        import os as _os
        _self_url = _os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
        if not _self_url:
            svc = _os.environ.get("RENDER_SERVICE_NAME", "")
            _self_url = f"https://{svc}.onrender.com" if svc else "http://localhost:8000"
        ping_url = f"{_self_url}/health"
        logger.info(f"Keep-alive ping started → {ping_url} every 10 min")
        while True:
            try:
                import httpx as _httpx
                async with _httpx.AsyncClient(timeout=10) as _http:
                    r = await _http.get(ping_url)
                logger.debug(f"Keep-alive ping OK ({r.status_code})")
            except Exception as _pe:
                logger.warning(f"Keep-alive ping failed (non-fatal): {_pe}")
            await asyncio.sleep(600)

    asyncio.create_task(_keep_alive_ping())

    # Only migrate legacy rows that actually lack consent_given. Rewriting the
    # entire users collection on every boot created avoidable MongoDB write load.
    try:
        result = await db.users.update_many(
            {"$or": [{"consent_given": {"$exists": False}}, {"consent_given": None}]},
            {"$set": {"consent_given": True}},
        )
        logger.info(f"Consent cleanup: Updated {result.modified_count} users")
    except Exception as e:
        logger.error(f"Consent cleanup failed: {e}")

    try:
        from backend.learning.learning_scheduler import LearningScheduler
        LearningScheduler.start()
        logger.info("Phase 10 Self-Learning Scheduler started successfully on boot.")
    except Exception as e_sched:
        logger.error(f"Failed to start Phase 10 Self-Learning Scheduler on boot: {e_sched}")

    try:
        from backend.workflow.workflow_templates import WorkflowTemplates
        from backend.workflow.workflow_scheduler import WorkflowScheduler

        async def bootstrap_workflow_templates():
            try:
                await WorkflowTemplates.bootstrap_templates()
                logger.info("Phase 11 default workflow templates bootstrapped successfully on boot.")
            except Exception as e_tmpl:
                logger.error(f"Failed to bootstrap default workflow templates on boot: {e_tmpl}")

        asyncio.create_task(bootstrap_workflow_templates())
        WorkflowScheduler.start()
        logger.info("Phase 11 Workflow Scheduler started successfully on boot.")
    except Exception as e_wf_sched:
        logger.error(f"Failed to start Phase 11 Workflow Scheduler on boot: {e_wf_sched}")

    try:
        from backend.platform.platform_engine import PlatformEngine

        async def bootstrap_saas_platform_async():
            try:
                await PlatformEngine.bootstrap_saas_platform()
                logger.info("Phase 12 SaaS Platform bootstrapped successfully on boot.")
            except Exception as e_saas:
                logger.error(f"Failed to bootstrap SaaS Platform on boot: {e_saas}")

        asyncio.create_task(bootstrap_saas_platform_async())
    except Exception as e_saas_import:
        logger.error(f"Failed to import SaaS Platform Engine: {e_saas_import}")
