from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def register_shutdown_handler(app, scheduler):
    """Register graceful shutdown for the shared APScheduler instance."""
    @app.on_event("shutdown")
    async def shutdown_event():
        try:
            if scheduler.running:
                scheduler.shutdown(wait=False)
                logger.info("APScheduler shutdown completed.")
        except Exception as exc:
            logger.warning("APScheduler shutdown warning: %s", exc)
