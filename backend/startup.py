import asyncio
import logging
import pytz
from datetime import datetime, timezone
from backend.dependencies import client, db
from apscheduler.schedulers.background import BackgroundScheduler

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler(timezone=pytz.timezone("Asia/Kolkata"))


async def startup_event():
    try:
        # ✅ MongoDB check
        await asyncio.wait_for(client.admin.command("ping"), timeout=5)
        logger.info("MongoDB connected successfully")

        # ✅ YOUR FULL INDEX BLOCK
        await db.tasks.create_index("assigned_to")
        await db.tasks.create_index("created_by")
        await db.tasks.create_index("due_date")
        await db.users.create_index("email")
        await db.staff_activity.create_index("user_id")
        await db.staff_activity.create_index("timestamp")
        await db.staff_activity.create_index([("user_id", 1), ("timestamp", -1)])
        await db.due_dates.create_index("department")
        await db.tasks.create_index([("assigned_to", 1), ("status", 1)])
        await db.tasks.create_index("created_at")
        await db.referrers.create_index("name")
        await db.clients.create_index("assigned_to")
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
        await db.staff_activity.create_index("type")
        await db.staff_activity.create_index("domain")
        await db.staff_activity.create_index([("user_id", 1), ("type", 1)])
        await db.invoices.create_index([("created_by", 1), ("created_at", -1)])
        await db.invoices.create_index("client_id")
        await db.invoices.create_index("lead_id")
        await db.invoices.create_index("status")
        await db.invoices.create_index("invoice_date")
        await db.products.create_index([("created_by", 1), ("name", 1)])
        await db.payments.create_index("invoice_id")
        await db.payments.create_index([("created_by", 1), ("payment_date", -1)])

        # ✅ EMAIL FIX
        try:
            await db.email_connections.drop_index("user_id_1_provider_1")
        except Exception:
            pass
        await db.email_connections.create_index(
            [("user_id", 1), ("email_address", 1)],
            unique=True,
            background=True
        )

        # ✅ UNIQUE INDEXES
        await db.attendance.create_index(
            [("user_id", 1), ("date", 1)],
            unique=True,
            background=True
        )
        await db.clients.create_index(
            [("created_by", 1), ("company_name", 1)],
            unique=True,
            background=True
        )
        await db.holidays.create_index("date", unique=True, background=True)

        # ✅ VISIT REPAIR — backfill missing `id` fields
        visits = await db.visits.find({"id": {"$exists": False}}).to_list(10000)
        for v in visits:
            await db.visits.update_one(
                {"_id": v["_id"]},
                {"$set": {"id": str(v["_id"])}}
            )

        # ✅ USER ID REPAIR & PHANTOM CLEANUP
        try:
            from bson import ObjectId
            users_no_id = await db.users.find({
                "$or": [{"id": {"$exists": False}}, {"id": None}, {"id": ""}]
            }).to_list(10000)
            for u in users_no_id:
                if u.get("_id"):
                    await db.users.update_one({"_id": u["_id"]}, {"$set": {"id": str(u["_id"])}})

            phantom_users = await db.users.find({
                "company_id": "__commercial_control_plane__",
                "is_internal_commercial_admin": True,
            }).to_list(100)
            for pu in phantom_users:
                p_id = pu.get("id")
                if p_id and ObjectId.is_valid(p_id):
                    real_user = await db.users.find_one({
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
                            await db.users.update_one({"_id": real_user["_id"]}, {"$set": sync_fields})
                        await db.users.delete_one({"_id": pu["_id"]})
        except Exception as e:
            logger.warning(f"User ID repair in startup.py failed: {e}")

        # ✅ AUTO MIGRATION — backfill consent_given for existing users
        # (was incorrectly placed in a sync scheduler block in server.py)
        try:
            result = await db.users.update_many(
                {},
                {"$set": {"consent_given": True}}
            )
            logger.info(f"Consent cleanup: Updated {result.modified_count} users")
        except Exception as e:
            logger.error(f"Consent cleanup failed: {e}")

        logger.info("Startup DB setup completed")

        # ✅ Initialize vendor intelligence MongoDB indexes
        try:
            from backend.ai.vendor_storage import init_vendor_indexes
            await init_vendor_indexes()
        except Exception as e:
            logger.error(f"Failed to initialize vendor intelligence indexes: {e}")

        # ✅ Initialize OCR indexes
        try:
            from backend.ai.ocr_storage import init_ocr_indexes
            await init_ocr_indexes()
        except Exception as e:
            logger.error(f"Failed to initialize OCR indexes: {e}")

        # ✅ Initialize validation indexes
        try:
            from backend.ai.validation_storage import init_validation_indexes
            await init_validation_indexes()
        except Exception as e:
            logger.error(f"Failed to initialize validation indexes: {e}")

        # ✅ START SCHEDULER
        if not scheduler.running:
            scheduler.start()

    except Exception as e:
        logger.error(f"Startup failed: {e}")
