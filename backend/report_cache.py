"""Short-lived cache for expensive, read-only accounting reports.

The Finix dashboard asks for the trial balance, P&L, balance sheet and four AI
summaries every time it opens, and each one reads a large part of the ledger.
Opening it twice, or two people opening the same company, repeated all of that.

A cached answer is reused only while nothing it could depend on has changed:

* every write to a finance collection (invoices, payments, journals, chart of
  accounts, bank accounts...) bumps one process-wide revision number, and a
  cached answer from an older revision is never served;
* an answer also expires after REPORT_CACHE_TTL_SECONDS (default 60) as a
  backstop for writes made by another server process, which this process
  cannot see. Set it to 0 to switch the cache off;
* identical requests that arrive while one is already being computed share that
  one computation instead of each scanning the ledger.

The key includes the signed-in company and Platform-Owner context, so one
company's report can never be served to another.
"""
from __future__ import annotations

import asyncio
import copy
import os
import time
from typing import Any, Awaitable, Callable, Dict, Tuple

FINANCE_COLLECTIONS = frozenset({
    "journal_entries", "journal_lines", "chart_of_accounts",
    "invoices", "purchase_invoices", "payments", "purchase_payments",
    "bank_accounts", "bank_transactions", "credit_notes", "debit_notes",
    "customers", "vendors", "party_ledgers", "tds_entries", "gst_returns",
})

MAX_ENTRIES = 300

_revision = 0
_entries: Dict[Tuple, Tuple[float, int, Any]] = {}
_inflight: Dict[Tuple, Tuple[int, "asyncio.Future"]] = {}


def ttl_seconds() -> float:
    try:
        return max(0.0, float(os.environ.get("REPORT_CACHE_TTL_SECONDS", "60")))
    except (TypeError, ValueError):
        return 60.0


def bump(collection: str) -> None:
    """Called after any write; only finance collections matter."""
    global _revision
    if collection in FINANCE_COLLECTIONS:
        _revision += 1


def revision() -> int:
    return _revision


def clear() -> None:
    _entries.clear()
    _inflight.clear()


def _scope() -> Tuple[str, bool, bool]:
    from backend import tenant_runtime as t
    return (
        str(t.authenticated_company_id() or ""),
        bool(t.in_platform_owner_context()),
        bool(t.in_system_context()),
    )


async def cached(
    name: str,
    params: Tuple,
    compute: Callable[[], Awaitable[Any]],
    *,
    fresh: bool = False,
) -> Any:
    """Return compute()'s result, reusing a still-valid earlier one.

    `params` must hold every request input that changes the answer, as a tuple of
    hashable values. Callers check permissions BEFORE calling this."""
    ttl = ttl_seconds()
    if ttl <= 0:
        return await compute()

    key = (name, _scope(), params)
    rev = _revision
    now = time.monotonic()

    if not fresh:
        hit = _entries.get(key)
        if hit and hit[1] == rev and now - hit[0] < ttl:
            return copy.deepcopy(hit[2])
        pending = _inflight.get(key)
        if pending and pending[0] == rev:
            return copy.deepcopy(await asyncio.shield(pending[1]))

    future: "asyncio.Future" = asyncio.get_running_loop().create_future()
    _inflight[key] = (rev, future)
    try:
        result = await compute()
    except BaseException as exc:
        if not future.done():
            future.set_exception(exc if isinstance(exc, Exception) else RuntimeError("cancelled"))
            future.exception()  # mark retrieved so an unshared failure is not logged as unhandled
        raise
    else:
        future.set_result(result)
        if len(_entries) >= MAX_ENTRIES:
            oldest = min(_entries, key=lambda k: _entries[k][0])
            _entries.pop(oldest, None)
        _entries[key] = (time.monotonic(), rev, copy.deepcopy(result))
        return result
    finally:
        if _inflight.get(key, (None, None))[1] is future:
            _inflight.pop(key, None)
