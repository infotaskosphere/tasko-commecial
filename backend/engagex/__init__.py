"""EngageX: marketing & communications module (Dashboard, WhatsApp Hub, MailMaster)."""
from __future__ import annotations


def install(app) -> None:
    """Mount the EngageX API and start the background delivery worker."""
    from . import worker
    from .public import router as public_router
    from .router import router

    app.include_router(router, prefix="/api")
    app.include_router(public_router, prefix="/api")
    worker.install(app)
