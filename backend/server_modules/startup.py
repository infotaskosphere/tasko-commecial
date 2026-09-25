from __future__ import annotations
import asyncio
import logging
import os
import httpx
import pytz
from bson import ObjectId
from backend.dependencies import db
from backend.server_modules.attendance_jobs import mark_absent_users_task, force_punch_out_11pm_task
logger=logging.getLogger(__name__)

def register_startup_event(app, scheduler, set_event_loop):
    @app.on_event("startup")
    async def startup_event():
        import backend.server as _server
        for _name, _value in vars(_server).items():
            if not _name.startswith("__"):
                globals()[_name]=_value
        import backend.server as _self

        _self.app_event_loop = asyncio.get_event_loop()
        try:
            await db.tasks.create_index("assigned_to")
            # ── Activity Timeline & Automation Engine indexes ──────────────────
            await db.client_activities.create_index([("client_id", 1), ("created_at", -1)])
            await db.pending_client_messages.create_index([("status", 1), ("created_at", -1)])
            await db.service_expiries.create_index("client_id")
            await db.service_expiries.create_index("expiry_date")
            await create_compliance_indexes()
            await create_salary_slip_indexes()
            await create_gst_reconciliation_indexes()
            try:
                await db.mis_transactions.create_index([("client_id", 1), ("period", 1), ("doc_type", 1)])
                await db.mis_uploads.create_index([("client_id", 1), ("period", 1)])
                await db.mis_manual.create_index([("client_id", 1), ("period", 1)], unique=True)
            except Exception as _mis_idx_err:
                logger.warning(f"MIS index creation skipped: {_mis_idx_err}")
            await create_zte_indexes()
        
            # --- PHASE 10 SELF-LEARNING INDEXES ---
            try:
                await db.knowledge_base.create_index([("company_id", 1), ("category", 1), ("key", 1)], unique=True)
                await db.learning_events.create_index([("company_id", 1), ("created_at", -1)])
                await db.manual_corrections.create_index([("company_id", 1), ("created_at", -1)])
                await db.recommendation_history.create_index([("company_id", 1), ("status", 1)])
                await db.embeddings.create_index([("target_id", 1), ("target_type", 1)])
                await db.learning_versions.create_index([("entity_id", 1), ("entity_type", 1)])
                await db.learning_queue.create_index([("status", 1), ("created_at", 1)])
                await db.learning_audit.create_index([("company_id", 1), ("timestamp", -1)])
                logger.info("Phase 10 Self-Learning MongoDB indexes built.")
            except Exception as e_idx10:
                logger.warning(f"Phase 10 index creation warning: {e_idx10}")

            # --- PHASE 11 ENTERPRISE AUTOMATION INDEXES ---
            try:
                await db.workflow_definitions.create_index([("company_id", 1), ("category", 1)])
                await db.workflow_definitions.create_index("id", unique=True, background=True)
                await db.workflow_instances.create_index([("company_id", 1), ("status", 1)])
                await db.workflow_instances.create_index("id", unique=True, background=True)
                await db.workflow_history.create_index([("company_id", 1), ("instance_id", 1)])
                await db.workflow_templates.create_index("id", unique=True, background=True)
                await db.approval_requests.create_index([("company_id", 1), ("status", 1)])
                await db.approval_requests.create_index("id", unique=True, background=True)
                await db.approval_history.create_index([("company_id", 1), ("approval_id", 1)])
                await db.automation_rules.create_index([("company_id", 1), ("is_active", 1)])
                await db.business_events.create_index([("company_id", 1), ("event_type", 1)])
                await db.notification_history.create_index([("company_id", 1), ("user_id", 1)])
                await db.dashboard_cache.create_index("id", unique=True, background=True)
                await db.analytics_data.create_index("company_id")
                await db.kpi_history.create_index("company_id")
                await db.workflow_audit.create_index([("company_id", 1), ("action", 1)])
                logger.info("Phase 11 Enterprise Automation MongoDB indexes built.")
            except Exception as e_idx11:
                logger.warning(f"Phase 11 index creation warning: {e_idx11}")

            # AI Memory Foundation indexes
            await db.ai_document_memory.create_index("fingerprint")
            await db.ai_document_memory.create_index("vendor_gstin")
            await db.ai_document_memory.create_index("invoice_number")
            await db.ai_document_memory.create_index("vendor_name")
            await db.ai_document_memory.create_index("created_at")
            # AIWeave tenant-scoped provider/account/model/routing/audit indexes
            await create_aiweave_indexes()
            await create_gst_portal_sync_indexes()
            await create_accounting_integrity_indexes()
            await create_accounting_extended_indexes()
            await db.tasks.create_index("created_by")
            await db.tasks.create_index("due_date")
            await db.users.create_index("email")
            await db.staff_activity.create_index("user_id")
            await db.staff_activity.create_index("timestamp")
            await db.staff_activity.create_index([("user_id", 1), ("timestamp", -1)])
            await db.due_dates.create_index("department")
            await create_desktop_indexes()
            await db.tasks.create_index([("assigned_to", 1), ("status", 1)])
            await db.tasks.create_index("created_at")
            await db.referrers.create_index("name")
            await db.clients.create_index("assigned_to")
            # Performance: faster paginated list + merge search
            await db.clients.create_index("company_name")
            await db.clients.create_index("created_by")
            await db.clients.create_index([("assignments.user_id", 1)])
            await db.clients.create_index("status")
            await db.clients.create_index([("company_name", 1), ("status", 1)])
            await db.dsc_register.create_index("expiry_date")
            await db.todos.create_index([("user_id", 1), ("created_at", -1)])
            await db.attendance.create_index([("user_id", 1), ("date", -1)])
            await db.notifications.create_index("user_id")
            await db.visits.create_index([("assigned_to", 1), ("visit_date", -1)])
            await db.visits.create_index("visit_date")
            await db.visits.create_index("client_id")
            await db.visits.create_index("status")
            await db.notifications.create_index([("user_id", 1), ("is_read", 1)])
            await db.notifications.create_index("created_at")
            await db.quotations.create_index([("created_by", 1), ("created_at", -1)])
            await db.quotations.create_index("status")
            await db.quotations.create_index("service")
            await db.companies.create_index("created_by")
            await db.companies.create_index("name")
            # Bank / Accounting / Permission Governance (added for AI accounting features)
            await db.bank_accounts.create_index("company_id")
            await db.bank_transactions.create_index([("bank_account_id", 1), ("date", -1)])
            await db.bank_transactions.create_index("matched_type")
            await db.bank_reconciliation_audit.create_index([("bank_transaction_id", 1), ("timestamp", -1)])
            await db.chart_of_accounts.create_index([("company_id", 1), ("code", 1)], unique=True)
            await db.journal_entries.create_index([("company_id", 1), ("entry_date", -1)])
            await db.journal_lines.create_index("entry_id")
            await db.journal_lines.create_index("account_id")
            await db.access_requests.create_index([("user_id", 1), ("status", 1)])
            await db.access_requests.create_index("status")
            await db.staff_activity.create_index("type")
            await db.staff_activity.create_index("domain")
            await db.staff_activity.create_index([("user_id", 1), ("timestamp", -1)])
            await db.staff_activity.create_index([("user_id", 1), ("type", 1)])
            await db.trademark_sphere.create_index("application_number", unique=True)

            # ── FIXED: EMAIL CONNECTIONS INDEX ──────────────────────────────────
            try:
                # Drop old rule (Unique User + Provider)
                await db.email_connections.drop_index("user_id_1_provider_1")
            except Exception:
                pass

            # Create new rule (Unique User + Email Address)
            await db.email_connections.create_index(
                [("user_id", 1), ("email_address", 1)], unique=True, background=True
            )

            # Unique indexes — use background=True so they don't block startup if they already exist
            await db.attendance.create_index(
                [("user_id", 1), ("date", 1)], unique=True, background=True
            )
            await db.clients.create_index(
                [("created_by", 1), ("company_name", 1)], unique=True, background=True
            )
            await db.holidays.create_index("date", unique=True, background=True)

            # ── WhatsApp Hub indexes ─────────────────────────────────────────────
            # message_id + session_id: used by duplicate check on every bulk-sync insert
            # Without this index, bulk-sync with 1000+ messages does a full collection scan
            # per message → extremely slow, times out, and appears to store nothing.
            await db.whatsapp_hub_messages.create_index(
                [("message_id", 1), ("session_id", 1)], background=True, sparse=True
            )
            await db.whatsapp_hub_messages.create_index(
                [("jid", 1), ("timestamp", -1)], background=True
            )
            await db.whatsapp_hub_messages.create_index("timestamp", background=True)
            await db.whatsapp_hub_contacts.create_index("jid", unique=True, background=True)
            await db.whatsapp_hub_contacts.create_index(
                [("last_message_at", -1)], background=True
            )
            await db.whatsapp_hub_contacts.create_index("session_id", background=True)
            await db.whatsapp_hub_groups.create_index("jid", unique=True, background=True)

            # ── ACCOUNTING / INVOICING — the most-queried collections ────────────
            # These are called on every report load, reconcile, and invoice CRUD.
            # Without indexes every call does a full collection scan; with large
            # data sets (10k+ invoices) that causes 5-10 s latency per page.
            await db.invoices.create_index([("company_id", 1), ("status", 1)], background=True)
            await db.invoices.create_index([("company_id", 1), ("invoice_date", -1)], background=True)
            await db.invoices.create_index([("company_id", 1), ("invoice_type", 1)], background=True)
            await db.invoices.create_index("id", unique=True, background=True)
            await db.invoices.create_index("paid_bank_txn_id", background=True, sparse=True)

            await db.payments.create_index([("company_id", 1), ("invoice_id", 1)], background=True)
            await db.payments.create_index("invoice_id", background=True)
            await db.payments.create_index("id", unique=True, background=True)

            await db.purchase_invoices.create_index([("company_id", 1), ("status", 1)], background=True)
            await db.purchase_invoices.create_index([("company_id", 1), ("invoice_date", -1)], background=True)
            await db.purchase_invoices.create_index("id", unique=True, background=True)
            await db.purchase_invoices.create_index("paid_bank_txn_id", background=True, sparse=True)

            await db.purchase_payments.create_index([("company_id", 1), ("purchase_invoice_id", 1)], background=True)
            await db.purchase_payments.create_index("purchase_invoice_id", background=True)
            await db.purchase_payments.create_index("id", unique=True, background=True)

            # Journal entries: source+source_id compound is hit on every sync
            await db.journal_entries.create_index([("company_id", 1), ("source", 1), ("source_id", 1)], background=True)
            await db.journal_entries.create_index([("source", 1), ("source_id", 1)], background=True)
            await db.journal_entries.create_index("id", unique=True, background=True)

            # Journal lines: compound index covering Trial Balance aggregation
            await db.journal_lines.create_index([("company_id", 1), ("entry_date", -1), ("account_id", 1)], background=True)
            await db.journal_lines.create_index([("entry_id", 1), ("account_id", 1)], background=True)

            # Audit logs: queried by module+record_id and user+timestamp
            await db.audit_logs.create_index([("module", 1), ("record_id", 1), ("timestamp", -1)], background=True)
            await db.audit_logs.create_index([("user_id", 1), ("timestamp", -1)], background=True)

            # DSC register: expiry-based lookups
            await db.dsc_register.create_index([("assigned_to", 1), ("expiry_date", 1)], background=True)

        except Exception as e:
            # Log index creation errors but do NOT crash the server
            logger.warning(f"Index creation warning (non-fatal): {e}")

        try:
            visits = await db.visits.find({"id": {"$exists": False}}).to_list(10000)
            repaired = 0
            for v in visits:
                raw_id = v.get("_id")
                new_id = str(raw_id)
                await db.visits.update_one({"_id": raw_id}, {"$set": {"id": new_id}})
                repaired += 1
            logger.info(f"✅ Visit ID repair: {repaired} documents patched")
        except Exception as e:
            logger.error(f"⚠️ Visit ID repair failed (non-fatal): {e}")

        # ✅ USER ID REPAIR & PHANTOM CLEANUP
        try:
            from backend import dependencies as _dependencies
            from bson import ObjectId
            raw_db = getattr(_dependencies, "_raw_db", db)
            users_no_id = await raw_db.users.find({
                "$or": [{"id": {"$exists": False}}, {"id": None}, {"id": ""}]
            }).to_list(10000)
            user_repaired = 0
            for u in users_no_id:
                raw_id = u.get("_id")
                if raw_id:
                    await raw_db.users.update_one({"_id": raw_id}, {"$set": {"id": str(raw_id)}})
                    user_repaired += 1
            if user_repaired:
                logger.info(f"✅ User ID repair: {user_repaired} user documents patched with id field")

            # Clean up any phantom commercial control plane users that duplicate real users
            phantom_users = await raw_db.users.find({
                "company_id": "__commercial_control_plane__",
                "is_internal_commercial_admin": True,
            }).to_list(100)
            for pu in phantom_users:
                p_id = pu.get("id")
                if p_id and ObjectId.is_valid(p_id):
                    real_user = await raw_db.users.find_one({
                        "_id": ObjectId(p_id),
                        "company_id": {"$ne": "__commercial_control_plane__"},
                    })
                    if real_user:
                        sync_fields = {}
                        if pu.get("full_name") and pu.get("full_name") not in ("Taskosphere Commercial Control Plane", "Commercial Admin"):
                            sync_fields["full_name"] = pu["full_name"]
                        for fld in ("phone", "birthday", "profile_picture"):
                            if pu.get(fld):
                                sync_fields[fld] = pu[fld]
                        if sync_fields:
                            await raw_db.users.update_one({"_id": real_user["_id"]}, {"$set": sync_fields})
                        await raw_db.users.delete_one({"_id": pu["_id"]})
                        logger.info(f"✅ Cleaned up phantom control-plane identity shadowing user {p_id}")
        except Exception as e:
            logger.error(f"⚠️ User ID repair failed (non-fatal): {e}")

        try:
            from backend.commercial_licensee_admin import sync_all_licensee_admins
            synced_count = await sync_all_licensee_admins()
            if synced_count:
                logger.info(f"✅ Licensee admin sync: {synced_count} licensee administrators active with all rights.")
        except Exception as e:
            logger.warning(f"⚠️ Licensee admin sync skipped: {e}")

        # Scheduled jobs=====================================================================
        try:
            scheduler.add_job(fetch_indian_holidays_task, "cron", day=1, hour=0, minute=5)
            # Also run immediately on startup so holidays are available from day 1
            scheduler.add_job(
                fetch_indian_holidays_task,
                "date",
                run_date=datetime.now(pytz.timezone("Asia/Kolkata")),
            )
            # Absent marking job — fires every working day at 19:00 IST
            scheduler.add_job(
                mark_absent_users_task,
                "cron",
                hour=19,
                minute=0,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="mark_absent_daily",
                replace_existing=True,
            )
            # Auto punch-out job — fires at 23:00 IST; records punch_out = 7 PM for
            # any user who punched in today but never manually punched out.
            scheduler.add_job(
                force_punch_out_11pm_task,
                "cron",
                hour=23,
                minute=0,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="force_punch_out_11pm",
                replace_existing=True,
            )

            # ── Automation Engine jobs ────────────────────────────────────────
            # Supersedes the old WA-only wa_birthday_job: handles WhatsApp +
            # Email birthdays, the admin approval gate, and timeline logging.
            scheduler.add_job(
                birthday_automation_job,
                "cron",
                hour=9,
                minute=0,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="birthday_automation",
                replace_existing=True,
            )
            scheduler.add_job(
                festival_greeting_job,
                "cron",
                hour=9,
                minute=5,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="festival_greetings",
                replace_existing=True,
            )
            scheduler.add_job(
                service_expiry_alert_job,
                "cron",
                hour=9,
                minute=45,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="service_expiry_alerts",
                replace_existing=True,
            )
            scheduler.add_job(
                follow_up_reminder_job,
                "cron",
                hour=10,
                minute=15,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="follow_up_reminders",
                replace_existing=True,
            )

            # ── WhatsApp notification jobs ────────────────────────────────────
            scheduler.add_job(
                wa_dsc_expiry_job,
                "cron",
                hour=9,
                minute=30,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="wa_dsc_expiry_alerts",
                replace_existing=True,
            )
            scheduler.add_job(
                wa_compliance_job,
                "cron",
                hour=10,
                minute=0,
                timezone=pytz.timezone("Asia/Kolkata"),
                id="wa_compliance_reminders",
                replace_existing=True,
            )
            # Scheduled bulk send runner — checks every minute for due jobs
            scheduler.add_job(
                wa_scheduled_bulk_job,
                "interval",
                minutes=1,
                id="wa_scheduled_bulk",
                replace_existing=True,
            )
            # Keep wa-bridge warm so Render's free instance never spins down —
            # fixes the 429/CORS/502 cascade caused by cold-start request bursts.
            scheduler.add_job(
                wa_bridge_keepalive_job,
                "interval",
                minutes=5,
                id="wa_bridge_keepalive",
                replace_existing=True,
            )

            scheduler.start()
            logger.info("APScheduler started successfully.")
        except Exception as e:
            logger.error(f"APScheduler startup failed: {e}")

        # ── AUTO-SYNC HOLIDAYS ON EVERY BOOT ─────────────────────────────────────
        # Runs async in the background — never blocks startup.
        # Fetches Indian public holidays (current + next year) from date.nager.at
        # and saves them all as 'confirmed'. Any existing 'pending' ones are upgraded.
        async def _boot_holiday_sync():
            try:
                import httpx as _httpx

                now_ist = datetime.now(pytz.timezone("Asia/Kolkata"))
                total_added = 0
                for year in [now_ist.year, now_ist.year + 1]:
                    try:
                        async with _httpx.AsyncClient(timeout=10) as http:
                            resp = await http.get(
                                f"https://date.nager.at/api/v3/PublicHolidays/{year}/IN"
                            )
                        if resp.status_code != 200:
                            continue
                        for h in resp.json():
                            date_str = h["date"]
                            name = h.get("localName") or h.get("name", "Holiday")
                            existing = await db.holidays.find_one(
                                {"date": date_str}, {"_id": 0}
                            )
                            if not existing:
                                await db.holidays.insert_one(
                                    {
                                        "date": date_str,
                                        "name": name,
                                        "status": "confirmed",
                                        "type": "public",
                                        "created_at": now_ist.isoformat(),
                                    }
                                )
                                total_added += 1
                            elif existing.get("status") not in ("confirmed", "rejected"):
                                await db.holidays.update_one(
                                    {"date": date_str}, {"$set": {"status": "confirmed"}}
                                )
                    except Exception as year_err:
                        logger.warning(f"Holiday sync for {year} failed: {year_err}")
                logger.info(f"Boot holiday sync complete: {total_added} new holidays added")
            except Exception as e:
                logger.warning(f"Boot holiday sync failed (non-fatal): {e}")

        asyncio.create_task(_boot_holiday_sync())

        # ── KEEP-ALIVE SELF-PING (prevents Render basic plan spin-down) ───────────
        # Pings our own /health endpoint every 10 minutes so Render never marks
        # the service as idle and spins it down. This is critical for the Identix
        # machine — it expects the server to be awake 24/7 to receive punches.
        async def _keep_alive_ping():
            await asyncio.sleep(60)  # wait 1 min after boot before starting
            import os as _os

            _self_url = _os.environ.get("RENDER_EXTERNAL_URL", "").rstrip("/")
            if not _self_url:
                # fallback: derive from RENDER_SERVICE_NAME or use localhost
                svc = _os.environ.get("RENDER_SERVICE_NAME", "")
                _self_url = (
                    f"https://{svc}.onrender.com" if svc else "http://localhost:8000"
                )
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
                await asyncio.sleep(600)  # 10 minutes

        asyncio.create_task(_keep_alive_ping())

        # 🔥 AUTO MIGRATION: Add consent_given for old users
        try:
            result = await db.users.update_many(
                {},  # all users
                {"$set": {"consent_given": True}},
            )
            logger.info(f"Consent cleanup: Updated {result.modified_count} users")
        except Exception as e:
            logger.error(f"Consent cleanup failed: {e}")

        # ── PHASE 10 SELF-LEARNING SCHEDULER START ──
        try:
            from backend.learning.learning_scheduler import LearningScheduler
            LearningScheduler.start()
            logger.info("Phase 10 Self-Learning Scheduler started successfully on boot.")
        except Exception as e_sched:
            logger.error(f"Failed to start Phase 10 Self-Learning Scheduler on boot: {e_sched}")

        # ── PHASE 11 WORKFLOW SCHEDULER & BOOTSTRAP START ──
        try:
            from backend.workflow.workflow_templates import WorkflowTemplates
            from backend.workflow.workflow_scheduler import WorkflowScheduler
        
            # Bootstrap templates asynchronously
            async def bootstrap_workflow_templates():
                try:
                    await WorkflowTemplates.bootstrap_templates()
                    logger.info("Phase 11 default workflow templates bootstrapped successfully on boot.")
                except Exception as e_tmpl:
                    logger.error(f"Failed to bootstrap default workflow templates: {e_tmpl}")

            asyncio.create_task(bootstrap_workflow_templates())

            # Start the escalation & automation scheduler background loop
            WorkflowScheduler.start()
            logger.info("Phase 11 Workflow Scheduler started successfully on boot.")
        except Exception as e_wf_sched:
            logger.error(f"Failed to start Phase 11 Workflow Scheduler on boot: {e_wf_sched}")

        # ── PHASE 12 PLATFORM BOOTSTRAP START ──
        try:
            from backend.platform.platform_engine import PlatformEngine
        
            async def bootstrap_saas_platform_async():
                try:
                    await PlatformEngine.bootstrap_saas_platform()
                    logger.info("Phase 12 SaaS Platform bootstrapped successfully on boot.")
                except Exception as e_saas:
                    logger.error(f"Failed to bootstrap SaaS Platform: {e_saas}")

            asyncio.create_task(bootstrap_saas_platform_async())
        except Exception as e_saas_import:
            logger.error(f"Failed to import SaaS Platform Engine: {e_saas_import}")



    # ====================== HEALTH ======================
    # BUILD_MARKER — bump this string on every deploy-verification change.
    # If a request to /health ever shows a DIFFERENT marker than the one you
    # just committed, the browser/CDN/Render is NOT serving this exact commit —
    # stop looking for a code bug and go fix the deploy instead.
    BUILD_MARKER = "session-guard-signature-fix-2026-09-09"


