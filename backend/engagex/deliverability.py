"""MailMaster deliverability: inbox placement and mailbox protection.

Two concerns live here.

1. **Email style.** Gmail (and Outlook) sort mail into tabs using the signals
   a message carries. A one-click ``List-Unsubscribe`` header, an open-tracking
   pixel, a newsletter-style card layout, a hidden preheader and a "you are
   receiving this because…" footer all mark a message as bulk/marketing, and
   Gmail files it under Promotions. The **personal** style sends a plain,
   letter-like message without any of those, which is how one-to-one mail
   looks, so it is far more likely to land in the Primary inbox. The
   **newsletter** style keeps tracking and unsubscribe for real marketing.

   Nothing a sender does can *guarantee* the Primary tab: the recipient's
   mailbox provider decides. The personal style removes the signals we control.

2. **Mailbox protection.** Personal mailboxes have hard daily sending limits
   (rolling 24 hours). Going over them gets the account blocked from sending,
   and repeated bursts can get it suspended. Limits below are kept under the
   providers' published numbers with a safety margin, the pace is slowed and
   varied, large lists continue automatically when the window frees up, and a
   "limit reached"/"too many messages" response from the provider stops the run
   instead of hammering the account.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional

from .common import raw_db, utcnow

STYLE_PERSONAL = "personal"
STYLE_NEWSLETTER = "newsletter"
STYLES = (STYLE_PERSONAL, STYLE_NEWSLETTER)

# Every successful send through a mailbox, kept 2 days (TTL index) so the
# rolling 24-hour count covers all campaigns and companies using that mailbox.
SEND_LOG = "engagex_send_log"

# Opens recorded this soon after sending are ignored: they come from the
# sender viewing their own Sent copy (the pixel is in it too), not the recipient.
OPEN_GRACE_SECONDS = 60


def campaign_style(settings: Optional[dict]) -> str:
    """Campaigns created before styles existed keep the newsletter behaviour."""
    style = str((settings or {}).get("style") or STYLE_NEWSLETTER)
    return style if style in STYLES else STYLE_NEWSLETTER


# ── Mailbox limits ───────────────────────────────────────────────────────────
@dataclass(frozen=True)
class MailboxLimits:
    provider: str          # human label shown in the UI
    daily: int             # our cap per rolling 24 hours (below the provider's)
    provider_daily: int    # the provider's published limit, for reference
    per_minute: int        # maximum pace we allow

    def as_dict(self) -> dict:
        return {"provider": self.provider, "daily": self.daily, "provider_daily": self.provider_daily,
                "per_minute": self.per_minute}


_GMAIL_CONSUMER = MailboxLimits("Gmail", 400, 500, 8)
_GOOGLE_WORKSPACE = MailboxLimits("Google Workspace", 1500, 2000, 15)
_OUTLOOK_CONSUMER = MailboxLimits("Outlook.com", 250, 300, 8)
_MICROSOFT_365 = MailboxLimits("Microsoft 365", 8000, 10000, 25)

_GOOGLE_HOSTS = ("smtp.gmail.com", "smtp.googlemail.com")
_MICROSOFT_HOSTS = ("smtp.office365.com", "smtp-mail.outlook.com", "outlook.office365.com", "smtp.outlook.com")
_GMAIL_DOMAINS = ("gmail.com", "googlemail.com")
_OUTLOOK_DOMAINS = ("outlook.com", "hotmail.com", "live.com", "msn.com", "outlook.in", "hotmail.co.uk", "live.in")


def _domain(address: str) -> str:
    return str(address or "").rsplit("@", 1)[-1].strip().lower()


def mailbox_limits(kind: str, from_email: str, smtp_host: str = "", daily_override: Optional[int] = None) -> Optional[MailboxLimits]:
    """Sending limits for a company mailbox, or None when there is no known cap
    (the platform service, SES/SendGrid/Brevo relays, cPanel mail…)."""
    host = str(smtp_host or "").strip().lower()
    domain = _domain(from_email)
    limits: Optional[MailboxLimits] = None
    if kind == "google" or host in _GOOGLE_HOSTS:
        limits = _GMAIL_CONSUMER if domain in _GMAIL_DOMAINS else _GOOGLE_WORKSPACE
    elif kind == "microsoft" or host in _MICROSOFT_HOSTS:
        limits = _OUTLOOK_CONSUMER if domain in _OUTLOOK_DOMAINS else _MICROSOFT_365
    if limits and daily_override:
        # A lower limit can be set per sender (e.g. a Workspace trial: 500/day).
        limits = MailboxLimits(limits.provider, max(1, min(int(daily_override), limits.daily)), limits.provider_daily,
                               limits.per_minute)
    return limits


def mailbox_key(from_email: str) -> str:
    return str(from_email or "").strip().lower()


async def sent_in_window(mailbox: str, now: Optional[datetime] = None) -> int:
    now = now or utcnow()
    return await raw_db()[SEND_LOG].count_documents({"mailbox": mailbox, "at": {"$gt": now - timedelta(hours=24)}})


async def record_send(mailbox: str, company_id: str, campaign_id: str = "") -> None:
    await raw_db()[SEND_LOG].insert_one({"mailbox": mailbox, "company_id": company_id, "campaign_id": campaign_id,
                                         "at": utcnow()})


async def capacity_resume_at(mailbox: str, limits: MailboxLimits, now: Optional[datetime] = None) -> Optional[datetime]:
    """None while the mailbox may send; otherwise when the next send is allowed
    (the moment enough sends leave the rolling 24-hour window)."""
    now = now or utcnow()
    since = now - timedelta(hours=24)
    count = await raw_db()[SEND_LOG].count_documents({"mailbox": mailbox, "at": {"$gt": since}})
    if count < limits.daily:
        return None
    # The (count - daily + 1)-th oldest send in the window must expire first.
    skip = count - limits.daily
    rows = await raw_db()[SEND_LOG].find({"mailbox": mailbox, "at": {"$gt": since}}, {"_id": 0, "at": 1}) \
        .sort("at", 1).skip(skip).limit(1).to_list(1)
    oldest = rows[0]["at"] if rows else now
    if oldest.tzinfo is None:  # Mongo returns naive UTC datetimes
        from datetime import timezone

        oldest = oldest.replace(tzinfo=timezone.utc)
    return max(now + timedelta(minutes=1), oldest + timedelta(hours=24, minutes=1))


# ── Provider "slow down / limit reached" responses ───────────────────────────
_DAILY_LIMIT = re.compile(
    r"5\.4\.5|daily (user )?sending (quota|limit)|sending limit exceeded|dailylimitexceeded|quotaexceeded|"
    r"reached a limit for sending|exceeded the (daily|message) (limit|quota)|ErrorExceededMessageLimit|"
    r"SubmissionQuotaExceeded|recipient rate limit|5\.2\.0 .*limit|WASCL",
    re.IGNORECASE,
)
_RATE_LIMIT = re.compile(
    r"\b421\b|4\.7\.0|4\.7\.28|\b429\b|rate ?limit|too many (messages|connections|requests|login)|try again later|"
    r"throttl|userRateLimitExceeded|MailboxConcurrency|ApplicationThrottled|temporarily (deferred|rejected|blocked)",
    re.IGNORECASE,
)


def provider_backoff(error: str) -> Optional[tuple[timedelta, str]]:
    """When a delivery error means the provider is limiting this mailbox,
    return how long to stop and a plain-language reason. Otherwise None
    (an ordinary per-recipient failure such as a bad address)."""
    text = str(error or "")
    if _DAILY_LIMIT.search(text):
        return timedelta(hours=24), "The email provider reports this mailbox reached its daily sending limit."
    if _RATE_LIMIT.search(text):
        return timedelta(minutes=30), "The email provider asked this mailbox to slow down."
    return None


# ── Personal (letter-style) message body ─────────────────────────────────────
def build_personal_html(*, body_html: str, banner_markup: str = "") -> str:
    """A plain, letter-like HTML body: no background, card, hidden preheader,
    tracking pixel or unsubscribe footer. Content the user wrote is kept as is."""
    content = body_html or ""
    if re.search(r"(?i)<body[^>]*>", content):
        # A full document from the editor: keep it, only add the banner.
        if banner_markup:
            content = re.sub(r"(?i)(<body[^>]*>)", r"\1" + banner_markup.replace("\\", "\\\\"), content, count=1)
        return content
    hero = f"<div>{banner_markup}</div>" if banner_markup else ""
    return ('<!doctype html><html><head><meta charset="utf-8"></head><body>'
            f'<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#222222">{hero}{content}</div>'
            '</body></html>')

