"""Public Microsoft sign-in callback: /api/email/oauth/microsoft/callback.

Microsoft redirects here without the user's session, so the server-side state
record says what was being connected:

* ``exm.`` states connect a MailMaster sender for one company;
* ``pes.`` states connect the Commercial Console platform email service.
"""
from __future__ import annotations

from typing import Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Query, Request
from fastapi.responses import RedirectResponse

from backend import mail_connect

router = APIRouter(prefix="/oauth/microsoft", tags=["email-microsoft-oauth"])

SENDER_PREFIX = "exm."
PLATFORM_PREFIX = "pes."


def _result(return_url: str, outcome: str, **extra: str) -> RedirectResponse:
    params = {"microsoft": outcome, **{k: str(v)[:160] for k, v in extra.items() if v}}
    sep = "&" if "?" in return_url else "?"
    return RedirectResponse(f"{return_url}{sep}{urlencode(params)}", status_code=302)


@router.get("/callback")
async def microsoft_mail_callback(
    request: Request,
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    fallback = mail_connect.frontend_return_url(request, None, "/engagex/mailmaster?tab=senders")
    if not state:
        return _result(fallback, "error", reason="Microsoft sign-in did not return to the right place. Please try again.")
    try:
        outcome = await mail_connect.microsoft_finish(state=state, code=code, error=error, error_description=error_description)
    except Exception:
        mail_connect.logger.exception("Microsoft sign-in failed")
        return _result(fallback, "error", reason="Microsoft sign-in failed. Please try again.")
    doc = outcome.get("state_doc") or {}
    return_url = doc.get("return_url") or fallback
    if outcome.get("error"):
        return _result(return_url, "cancelled" if outcome.get("cancelled") else "error", reason=outcome["error"])
    email = outcome["email"]
    try:
        if state.startswith(PLATFORM_PREFIX):
            from backend.email_service.service import email_service

            await email_service.save_connected_account(
                "microsoft_oauth", email=email, refresh_token=outcome["refresh_token"], updated_by=doc.get("user_id") or "oauth")
        else:
            from backend.engagex.connected_senders import save_oauth_sender

            await save_oauth_sender(company_id=doc["company_id"], user_id=doc.get("user_id"), kind="microsoft",
                                    email=email, refresh_token=outcome["refresh_token"], scopes=outcome.get("scopes") or [])
    except Exception:
        mail_connect.logger.exception("Saving the Microsoft mailbox failed")
        return _result(return_url, "error", reason="Signed in, but the mailbox could not be saved. Please try again.")
    return _result(return_url, "connected", email=email)
