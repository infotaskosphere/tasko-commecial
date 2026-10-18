import api from '@/lib/api';

// ─── Short-lived result cache ──────────────────────────────────────────────
// /reports/validation-engine is expensive — with companyId='' it re-syncs
// and re-validates every company's book sequentially on the backend. Several
// pages (Journal Entries, Extended Reports, Accounting Reports) all call
// this on mount/tab-switch, so without a cache, simply navigating back and
// forth to Journal Entries re-runs a full all-books ledger rebuild every
// single time. Cache keeps repeat calls within the TTL instant; pass
// { force: true } (e.g. from an explicit "Refresh" button) to bypass it.
const _cache = new Map(); // key: companyId||'__all__' -> { data, ts }
const CACHE_TTL_MS = 60_000;

/**
 * Re-syncs every invoice/bill/payment into the ledger and runs the
 * consistency engine (Revenue=Collections+Outstanding, TB Debits=Credits,
 * AR=Outstanding, Customer Ledger=AR, Sales Ledger=Invoice Revenue,
 * GST+NonGST+Export+Exempt=Revenue, Bank GL=Real Balance).
 *
 * Mirrors backend/accounting_ai/reconciliation_validator.py::run_validation_engine
 * via GET /reports/validation-engine.
 *
 * @param {string} companyId - pass '' to run across every book (all companies).
 * @param {{force?: boolean}} opts - pass force:true to bypass the cache and re-run.
 * @returns {Promise<object>} validation report (or { books: [...] } when companyId is '').
 */
export async function runVerifyAndFix(companyId = '', { force = false } = {}) {
  const key = companyId || '__all__';
  const cached = _cache.get(key);
  if (!force && cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  // "Re-verify" must really re-run the check: tell the server to skip its saved answer and keep the
  // browser's read cache out of it too.
  const params = companyId ? { company_id: companyId } : {};
  if (force) params.fresh = true;
  const { data } = await api.get('/reports/validation-engine', { params, ...(force ? { cache: false } : {}) });
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

/**
 * Turns a validation report (or { books: [...] } for the all-companies
 * variant) into a toast-friendly { variant, title, text } triple.
 */
export function describeValidationResult(summary) {
  const reports = Array.isArray(summary?.books) ? summary.books : [summary];
  const allMismatches = reports.flatMap((r) => r?.mismatches || []);
  const anyHealed = reports.some((r) => r?.healed_by_rebuild);
  const allPassed = reports.every((r) => r?.passed);

  if (allPassed) {
    return {
      variant: 'success',
      title: 'Ledger verified',
      text: anyHealed
        ? 'Everything re-synced cleanly and all checks now pass.'
        : 'All consistency checks passed — no discrepancies found.',
    };
  }

  const ruleNames = [...new Set(allMismatches.map((m) => m.rule))];
  const preview = ruleNames.slice(0, 2).join('; ');
  const more = ruleNames.length > 2 ? ` (+${ruleNames.length - 2} more)` : '';

  return {
    variant: 'warning',
    title: anyHealed ? 'Some issues fixed, some remain' : 'Discrepancies found',
    text: `${allMismatches.length} mismatch${allMismatches.length === 1 ? '' : 'es'} in: ${preview}${more}.`,
  };
}
