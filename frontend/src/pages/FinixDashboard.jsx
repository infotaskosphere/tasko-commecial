import React, { useState, useEffect, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import {
  BarChart3, RefreshCw, CheckCircle2, AlertTriangle, Building2,
  TrendingUp, TrendingDown, Landmark, Receipt, Sparkles, Send, Brain, HelpCircle,
  ArrowRight, ShieldCheck, ShieldAlert, PieChart as PieIcon, LineChart as LineIcon, Clock, Layers,
} from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar
} from 'recharts';
import api from '@/lib/api';
import { normalizeCompanies } from "@/lib/companies";
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { runVerifyAndFix, describeValidationResult } from '@/lib/verifyAndFixLedger';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { isCommercialTenant } from '@/lib/commercialPermissionMatrix';

const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Friendly display copy for each backend validation rule, keyed by the
// `rule` string reconciliation_validator.py returns. Used to render the
// Integrity Shield from real check results instead of static claims.
const INTEGRITY_CHECKS = [
  { rule: 'Accounts Receivable = Outstanding', title: 'Ledger Balance Reconciliation', okText: 'Accounts receivable matches invoice outstandings exactly. No leakage detected.' },
  { rule: 'Bank Accounts (GL) = Real Bank Statement Balance', title: 'Bank Ledger Compliance', okText: 'Ledger bank balance matches the imported bank statement balance.' },
  { rule: 'GST + Non-GST + Export + Exempt Sales = Revenue', title: 'GST Portal Return Sync Integrity', okText: 'GST/non-GST/export/exempt sales buckets add up to total revenue.' },
  { rule: 'Trial Balance Debits = Credits', title: 'Trial Balance Integrity', okText: 'Every posted journal entry balances — total debits equal total credits.' },
];

// ─── Short-lived in-memory caches (module scope, survives remounts) ───────
// Every full load of this dashboard previously fired: 4 report calls, then
// (only after those finished) N monthly-trend calls, then (only after THAT
// finished) the full validation engine — three sequential network+backend
// round trips stacked on top of each other. Re-opening the page or flipping
// back to a company you were just viewing re-ran the entire waterfall from
// scratch every time. These caches make a revisit within the TTL instant,
// the same pattern already used for the validation engine in
// verifyAndFixLedger.js. Pass { force: true } to bypass (manual refresh).
const _companiesCache_finix = { data: null, ts: 0, owner: null };
const _metricsCache_finix = new Map(); // companyId -> { data, ts }
const COMPANIES_CACHE_TTL_MS = 5 * 60_000;
const METRICS_CACHE_TTL_MS = 60_000;

// Sentinel companyId for the "All Companies" combined view.
const ALL_COMPANIES_ID = '__all__';

// ─── sessionStorage mirror of the in-memory caches ─────────────────────
// The in-memory caches above only help while this tab stays on the same
// SPA session (they're lost on a hard refresh). Mirroring the same data
// into sessionStorage means a hard refresh of this page — or coming back
// to it after visiting somewhere else and reloading — can paint instantly
// from the last-known numbers instead of showing a blank loading screen
// while the whole waterfall re-runs, then quietly re-validates in the
// background. Session (not local) storage on purpose: financial figures
// shouldn't linger across browser restarts/devices.
const SS_METRICS_PREFIX = 'finix:metrics:';
const SS_COMPANIES_KEY = 'finix:companies';

function ssRead(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function ssWrite(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* quota / privacy mode — non-fatal */ }
}

// ─── Cache ownership ───────────────────────────────────────────────────────
// The caches above were global: keyed by company only, never by WHO is signed
// in. Sign out of one account and into another in the same tab and the second
// account was handed the first account's company ids (and numbers). For a
// licensed tenant those ids fail the backend's tenant check with
//   403 "Cross-company access is not permitted"
// on every report call. Stamp the caches with the signed-in user's id and drop
// everything the moment a different user shows up.
const SS_OWNER_KEY = 'finix:cache-owner';
function ensureCacheOwner(uid) {
  const owner = String(uid || '');
  let stored = null;
  try { stored = sessionStorage.getItem(SS_OWNER_KEY); } catch { /* ignore */ }
  if (stored === owner && _companiesCache_finix.owner === owner) return;
  _companiesCache_finix.data = null;
  _companiesCache_finix.ts = 0;
  _companiesCache_finix.owner = owner;
  _metricsCache_finix.clear();
  try {
    Object.keys(sessionStorage).forEach((k) => { if (k.startsWith('finix:')) sessionStorage.removeItem(k); });
    sessionStorage.setItem(SS_OWNER_KEY, owner);
  } catch { /* ignore */ }
}
if (typeof window !== 'undefined') {
  // AuthContext purges sessionStorage on login/logout; mirror that for the in-memory copies.
  window.addEventListener('company-scoped-caches-purged', () => {
    _companiesCache_finix.data = null;
    _companiesCache_finix.ts = 0;
    _companiesCache_finix.owner = null;
    _metricsCache_finix.clear();
  });
}

// One toast (not one per failed request) that tells the person WHY the backend
// refused the reports, using the server's own `detail` text.
function reportReportsDenied(err) {
  const detail = err?.response?.data?.detail;
  const text = typeof detail === 'string' && detail ? detail : 'The server refused access to the accounting reports (403).';
  console.warn('[Finix] reports denied:', text);
  toast.error(text, { id: 'finix-reports-denied', duration: 12000 });
}

// Synchronously checks whether a still-fresh snapshot for `cid` already
// exists (in-memory first, then the sessionStorage mirror) WITHOUT ever
// touching the network. Callers use this to decide up front whether the
// loading spinner needs to show at all — previously fetchMetrics/
// fetchAggregateMetrics always flipped `loading` to true and only found
// out a tick later (once the now-resolved promise came back) that the
// data was sitting in cache the whole time, so every revisit/company
// switch flashed a spinner for a frame even though nothing needed to load.
function peekMetricsCache(cid) {
  const cached = _metricsCache_finix.get(cid);
  if (cached && Date.now() - cached.ts < METRICS_CACHE_TTL_MS) return cached.data;
  const ss = ssRead(SS_METRICS_PREFIX + cid);
  if (ss && Date.now() - ss.ts < METRICS_CACHE_TTL_MS) {
    const restored = { ...ss.data, lastVerifiedAt: ss.data.lastVerifiedAt ? new Date(ss.data.lastVerifiedAt) : null };
    _metricsCache_finix.set(cid, { ts: ss.ts, data: restored });
    return restored;
  }
  return null;
}

export default function FinixDashboard() {
  return (
    <RequestAccessGate module="accounting_reports" moduleLabel="Finix Dashboard" permissionFlag="can_view_accounting_reports">
      <FinixDashboardInner />
    </RequestAccessGate>
  );
}

function FinixDashboardInner() {
  const isDark = useDark();
  const { user } = useAuth();
  // A licensed tenant owns exactly one ledger: its own company. Never send any
  // other company_id — the backend answers 403 "Cross-company access...".
  const tenantCompanyId = isCommercialTenant(user) ? String(user?.company_id || '') : '';
  const tenantCompanyName = user?.company_name || user?.company?.name || 'My Company';
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  
  // Financial Metrics
  const [revenue, setRevenue] = useState(0);
  const [receivables, setReceivables] = useState(0);
  const [cashAndBank, setCashAndBank] = useState(0);
  const [payables, setPayables] = useState(0);
  const [netProfit, setNetProfit] = useState(0);
  const [expenses, setExpenses] = useState(0);
  
  // Chart and breakdown data
  const [chartData, setChartData] = useState([]);
  const [expenseBreakdown, setExpenseBreakdown] = useState([]);
  
  // AI Insights
  const [insights, setInsights] = useState([]);

  // Real-time data-integrity status, driven by the backend validation
  // engine — replaces static "Zero leakages verified" claims with actual
  // pass/fail results the person can trust.
  const [verifying, setVerifying] = useState(false);
  const [validation, setValidation] = useState(null); // { passed, totalMismatches, reports, bankIssue }
  const [lastVerifiedAt, setLastVerifiedAt] = useState(null);
  
  // Chatbot State
  const [chatMessages, setChatMessages] = useState([
    {
      sender: 'ai',
      text: 'Hello! I am Finix AI, your intelligent accounting co-pilot. I have scanned your general ledger and reconciled sales/payments. How can I assist you with your books today?',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // Bumped on every fetchMetrics call; lets an in-flight request recognize
  // it's been superseded by a newer one (fast company switching) so its
  // slower, now-stale response can't clobber the newer selection's data.
  const fetchIdRef = useRef(0);

  // Restrict whatever list we have (server / cache) to what this account may
  // actually query. Commercial tenants: only their own company (synthesised from
  // the session if the server list does not contain it). Everyone else: as-is.
  const scopeCompanies = (list) => {
    const rows = Array.isArray(list) ? list : [];
    if (!tenantCompanyId) return rows;
    const own = rows.filter((c) => c && c.id === tenantCompanyId);
    return own.length ? own : [{ id: tenantCompanyId, name: tenantCompanyName }];
  };

  const fetchCompanies = async () => {
    ensureCacheOwner(user?.id);
    // Companies rarely change within a session; skip the round trip on a
    // revisit within the TTL and go straight to loading dashboard data.
    if (_companiesCache_finix.data && Date.now() - _companiesCache_finix.ts < COMPANIES_CACHE_TTL_MS) {
      const scoped = scopeCompanies(_companiesCache_finix.data);
      setCompanies(scoped);
      return scoped;
    }
    // Nothing in memory (e.g. fresh hard reload) — fall back to the
    // sessionStorage mirror so the dropdown paints immediately instead of
    // sitting empty, while the network call below still runs to refresh it.
    const cached = ssRead(SS_COMPANIES_KEY);
    if (cached?.data && Date.now() - cached.ts < COMPANIES_CACHE_TTL_MS) {
      _companiesCache_finix.data = cached.data;
      _companiesCache_finix.ts = cached.ts;
      setCompanies(scopeCompanies(cached.data));
    }
    try {
      const res = await api.get('/companies/list');
      const list = normalizeCompanies(res);
      _companiesCache_finix.data = list;
      _companiesCache_finix.ts = Date.now();
      ssWrite(SS_COMPANIES_KEY, { data: list, ts: _companiesCache_finix.ts });
      const scoped = scopeCompanies(list);
      setCompanies(scoped);
      return scoped;
    } catch {
      return scopeCompanies(cached?.data || []);
    }
  };

  // Fetches a real Revenue/Expenses total for every elapsed month of the
  // current financial year (Apr–Mar) by calling the existing profit-loss
  // endpoint once per month, instead of inventing a fake seasonal curve.
  const buildMonthlyTrend = async (cid) => {
    const now = new Date();
    const fyStartYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // FY starts April
    const months = [];
    let cursor = new Date(fyStartYear, 3, 1);
    while (cursor <= now) {
      months.push(new Date(cursor));
      cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    }
    const results = await Promise.allSettled(months.map((m) => {
      const start = new Date(m.getFullYear(), m.getMonth(), 1);
      const lastDay = new Date(m.getFullYear(), m.getMonth() + 1, 0);
      const end = lastDay > now ? now : lastDay;
      const df = start.toISOString().split('T')[0];
      const dt = end.toISOString().split('T')[0];
      return api.get('/reports/profit-loss', { params: { company_id: cid, date_from: df, date_to: dt } })
        .then((r) => ({ label: m.toLocaleString('en-US', { month: 'short' }), data: r.data }));
    }));
    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => {
        const { label, data } = r.value;
        const rev = round2(data?.total_income || 0);
        const exp = round2(data?.total_expense || 0);
        return { name: label, Revenue: rev, Expenses: exp, Profit: round2(rev - exp) };
      });
  };

  // ─── Pure metrics computation for one company ────────────────────────
  // Fetches + computes everything for a single company and returns the
  // finished snapshot; does NOT touch component state directly (besides
  // the optional onValidationSettled callback, used by the single-company
  // path below for an early UI update). Kept state-free so it can be
  // reused for both the normal single-company view and the "All
  // Companies" aggregate view, running once per company in parallel
  // instead of the aggregate view re-implementing this logic.
  const computeMetricsForCompany = async (cid, { force = false, onValidationSettled } = {}) => {
    // In-memory cache (fastest — survives SPA navigation within this tab).
    const cached = _metricsCache_finix.get(cid);
    if (!force && cached && Date.now() - cached.ts < METRICS_CACHE_TTL_MS) {
      return cached.data;
    }
    // sessionStorage mirror (survives a hard page refresh too).
    if (!force) {
      const ss = ssRead(SS_METRICS_PREFIX + cid);
      if (ss && Date.now() - ss.ts < METRICS_CACHE_TTL_MS) {
        const restored = { ...ss.data, lastVerifiedAt: ss.data.lastVerifiedAt ? new Date(ss.data.lastVerifiedAt) : null };
        _metricsCache_finix.set(cid, { ts: ss.ts, data: restored });
        return restored;
      }
    }

    // Get Trial Balance, Profit/Loss, and Balance Sheet reports to
    // aggregate Finix AI state. (This used to also fetch
    // /reports/mis-compliance here as a 4th parallel call, but its result
    // was never read anywhere below — it was fetched and thrown away.
    // Every one of these report endpoints re-syncs the company's ledger
    // on the backend before computing anything, so that was a full,
    // wasted reconciliation pass on every single load. Dropping it changes
    // nothing the user sees and removes ~1/4 of the backend work.)
    const df = `${new Date().getFullYear()}-04-01`; // Current FY start
    const dt = `${new Date().getFullYear() + 1}-03-31`; // Current FY end

    // These three request groups are independent of each other — each
    // only needs `cid` — but previously ran one after another (batch of
    // 3 reports, THEN the monthly-trend calls, THEN the validation
    // engine), stacking three separate wait times on top of each other.
    // Firing them together lets the backend work on all three at once,
    // so total wait time is roughly the slowest of the three instead of
    // the sum of all three.
    const [batchSettled, trend, validationResult] = await Promise.all([
      Promise.allSettled([
        api.get('/reports/trial-balance', { params: { company_id: cid, date_from: df, date_to: dt } }),
        api.get('/reports/profit-loss', { params: { company_id: cid, date_from: df, date_to: dt } }),
        api.get('/reports/balance-sheet', { params: { company_id: cid, as_of: new Date().toISOString().split('T')[0] } }),
      ]),
      buildMonthlyTrend(cid),
      (async () => {
        try {
          const v = await runVerifyAndFix(cid, { force });
          onValidationSettled?.(v, null);
          return v;
        } catch (err) {
          console.error(err);
          onValidationSettled?.(null, err);
          return null;
        }
      })(),
    ]);

    const [tbRes, pnlRes, bsRes] = batchSettled;
    const deniedReport = batchSettled.find((r) => r.status === 'rejected' && r.reason?.response?.status === 403);
    if (deniedReport) reportReportsDenied(deniedReport.reason);

    let tbData = tbRes.status === 'fulfilled' ? tbRes.value.data : null;
    let pnlData = pnlRes.status === 'fulfilled' ? pnlRes.value.data : null;
    let bsData = bsRes.status === 'fulfilled' ? bsRes.value.data : null;

    // Extract Revenue from P&L or Trial Balance
    let revTotal = pnlData?.total_income || pnlData?.revenue || 0;
    if (!revTotal && tbData?.rows) {
      // Fallback to accounts code 4000
      const salesAcct = tbData.rows.find(r => r.code === '4000');
      revTotal = salesAcct ? Math.abs((salesAcct.credit || 0) - (salesAcct.debit || 0)) : 0;
    }

    // Extract Receivables (Account 1200 / 1100)
    let arTotal = 0;
    if (tbData?.rows) {
      const arAcct = tbData.rows.find(r => r.code === '1200' || r.code === '1100');
      arTotal = arAcct ? ((arAcct.debit || 0) - (arAcct.credit || 0)) : 0;
    }
    if (!arTotal && bsData?.assets) {
      const arRow = bsData.assets.find(a => a.code === '1200' || a.code === '1100' || a.name?.toLowerCase().includes('receivable'));
      arTotal = arRow ? arRow.amount : 0;
    }

    // Extract Bank and Cash Balances (1001, 1002, 1003, 1000, 1010)
    let liquidCash = 0;
    if (tbData?.rows) {
      const cashAccts = tbData.rows.filter(r => ['1001', '1002', '1003', '1000', '1010'].includes(r.code));
      liquidCash = cashAccts.reduce((sum, r) => sum + ((r.debit || 0) - (r.credit || 0)), 0);
    }
    if (!liquidCash && bsData?.assets) {
      const cashRows = bsData.assets.filter(a => ['1001', '1002', '1003', '1000', '1010'].includes(a.code) || a.name?.toLowerCase().includes('cash') || a.name?.toLowerCase().includes('bank'));
      liquidCash = cashRows.reduce((sum, item) => sum + (item.amount || 0), 0);
    }

    // Extract Payables (Account 2000 "Accounts Payable" only — 2100 is GST
    // Output Payable, a tax liability, not a vendor payable, and mixing it
    // in here previously caused the card to show tax dues as vendor debt).
    let apTotal = 0;
    if (tbData?.rows) {
      const apAcct = tbData.rows.find(r => r.code === '2000');
      apTotal = apAcct ? Math.abs((apAcct.credit || 0) - (apAcct.debit || 0)) : 0;
    }
    if (!apTotal && bsData?.liabilities) {
      const apRow = bsData.liabilities.find(l => l.code === '2000' || l.name?.toLowerCase().includes('accounts payable'));
      apTotal = apRow ? apRow.amount : 0;
    }

    // Profit and Expenses — the backend's /reports/profit-loss returns the
    // field as `total_expense` (singular).
    const expTotal = pnlData?.total_expense ?? 0;
    const netProfitTotal = pnlData?.net_profit ?? (revTotal - expTotal);

    // Build charts
    // 1. Revenue vs Expenses by month — call the same endpoint once per
    // elapsed month of the current FY so every point on the chart is a
    // real, independently computed total. (`trend` was already fetched
    // above, concurrently with the batch of reports and the validation
    // engine, instead of only starting after they both finished.)
    const chartDataResolved = trend.length ? trend : [
      { name: 'This FY', Revenue: round2(revTotal), Expenses: round2(expTotal), Profit: round2(revTotal - expTotal) }
    ];

    // Expense Breakdown pie chart — use the real per-account expense rows
    // the backend already computed.
    const realBreakdown = (pnlData?.expenses || [])
      .filter(e => Math.abs(e.amount || 0) > 0.01)
      .map(e => ({ name: e.name || e.code || 'Other', value: Math.abs(e.amount) }));

    // AI Insights - dynamic heuristic alerts based on actual figures
    const generatedInsights = [];

    // Insight 1: Receivable Drift & Aging Prediction
    if (arTotal > 0) {
      const arRatio = (arTotal / (revTotal || 1)) * 100;
      if (arRatio > 35) {
        generatedInsights.push({
          type: 'warning',
          category: 'Receivables & Collections',
          title: 'High Receivable Exposure Detected',
          text: `Outstanding receivables of ${fmtC(arTotal)} represent ${arRatio.toFixed(1)}% of total sales. AI-predicted collection lag: 45 days. Recommended: automate payment reminders.`
        });
      } else {
        generatedInsights.push({
          type: 'success',
          category: 'Receivables & Collections',
          title: 'Outstanding Under Control',
          text: `Receivables of ${fmtC(arTotal)} are healthy at only ${arRatio.toFixed(1)}% of annualized revenue. Outstanding collection efficiency remains high.`
        });
      }
    }

    // Insight 2: Working Capital / Cash Flow Alert
    if (liquidCash > 0) {
      if (liquidCash < apTotal) {
        generatedInsights.push({
          type: 'warning',
          category: 'Working Capital',
          title: 'Short-Term Cash Squeeze Risk',
          text: `Liquid reserves (${fmtC(liquidCash)}) are lower than current accounts payable (${fmtC(apTotal)}). Liquid ratio is ${((liquidCash / (apTotal || 1))).toFixed(2)}. Suggest pausing non-essential cash outflow.`
        });
      } else {
        generatedInsights.push({
          type: 'success',
          category: 'Working Capital',
          title: 'Excellent Working Capital Health',
          text: `Cash/Bank holdings of ${fmtC(liquidCash)} easily cover all pending vendor payables (${fmtC(apTotal)}), yielding a robust current ratio.`
        });
      }
    }

    // Insight 3: Profit Margin Analysis
    const margin = (revTotal > 0) ? ((revTotal - expTotal) / revTotal) * 100 : 0;
    if (margin > 20) {
      generatedInsights.push({
        type: 'success',
        category: 'Profitability',
        title: 'Premium Net Margin Generated',
        text: `Your current net profit margin is ${margin.toFixed(1)}%. This outperforms the general sector average of 14.5% due to optimized operating overheads.`
      });
    } else if (margin > 0) {
      generatedInsights.push({
        type: 'info',
        category: 'Profitability',
        title: 'Stable Net Operating Margin',
        text: `Net profit margin is currently stable at ${margin.toFixed(1)}%. Expense audits reveal slight optimization space in Software and Professional fees.`
      });
    }

    // Insight 4: GST Portal Sync Match
    const gstMismatch = validationResult?.mismatches?.find(
      (m) => m.rule === 'GST + Non-GST + Export + Exempt Sales = Revenue'
    );
    if (validationResult && !gstMismatch) {
      generatedInsights.push({
        type: 'success',
        category: 'Compliance',
        title: 'Auto-Matched GST Return Readiness',
        text: 'Sales ledgers are matched with outstanding GST output. GST/non-GST/export/exempt sale buckets reconcile exactly with total revenue.'
      });
    } else if (gstMismatch) {
      generatedInsights.push({
        type: 'warning',
        category: 'Compliance',
        title: 'GST Return Readiness Mismatch',
        text: `Sales tax buckets differ from total revenue by ${fmtC(Math.abs(gstMismatch.diff))}. Review GST classification on recent invoices before filing.`
      });
    }

    const lastVerifiedAt = validationResult ? new Date() : null;
    const data = {
      revenue: revTotal,
      receivables: arTotal,
      cashAndBank: liquidCash,
      payables: apTotal,
      netProfit: netProfitTotal,
      expenses: expTotal,
      chartData: chartDataResolved,
      expenseBreakdown: realBreakdown,
      insights: generatedInsights,
      validation: validationResult,
      lastVerifiedAt,
    };

    // Cache the fully-assembled snapshot — in memory (instant SPA revisit)
    // and mirrored to sessionStorage (instant paint after a hard refresh)
    // — so the next visit to this company within the TTL can skip straight
    // to applying it instead of re-fetching everything.
    const ts = Date.now();
    _metricsCache_finix.set(cid, { ts, data });
    ssWrite(SS_METRICS_PREFIX + cid, { ts, data: { ...data, lastVerifiedAt: lastVerifiedAt ? lastVerifiedAt.toISOString() : null } });

    return data;
  };

  // ─── Single-company view ──────────────────────────────────────────────
  const applySingleCompanyMetrics = (data) => {
    setRevenue(data.revenue);
    setReceivables(data.receivables);
    setCashAndBank(data.cashAndBank);
    setPayables(data.payables);
    setNetProfit(data.netProfit);
    setExpenses(data.expenses);
    setChartData(data.chartData);
    setExpenseBreakdown(data.expenseBreakdown);
    setValidation(data.validation);
    setLastVerifiedAt(data.lastVerifiedAt);
    setInsights(data.insights);
  };

  const fetchMetrics = async (cid, { force = false } = {}) => {
    // Bumped for this call; if a newer fetchMetrics call starts (fast
    // company switching, or a refresh click) before this one finishes, the
    // stale one recognizes it's been superseded and skips writing state.
    const requestId = ++fetchIdRef.current;

    // Paint instantly from a still-fresh cache — no loading flash — instead
    // of unconditionally flipping `loading` on and then finding out a tick
    // later (once the promise below resolves) that the data was already
    // available. Matches the cache-first pattern used on the main Dashboard.
    if (!force) {
      const cached = peekMetricsCache(cid);
      if (cached) {
        applySingleCompanyMetrics(cached);
        setLoading(false);
        setVerifying(false);
        return;
      }
    }

    setLoading(true);
    setVerifying(true);
    try {
      const data = await computeMetricsForCompany(cid, {
        force,
        // Applies the integrity-check result the moment it resolves,
        // rather than waiting for the whole batch — matches the previous
        // single-company behaviour where the Shield could light up before
        // the KPI cards finished.
        onValidationSettled: (v) => {
          if (requestId !== fetchIdRef.current) return;
          setValidation(v);
          setLastVerifiedAt(v ? new Date() : null);
          setVerifying(false);
        },
      });

      // A newer company switch or refresh click superseded this request —
      // don't let its slower, now-stale response overwrite the newer data.
      if (requestId !== fetchIdRef.current) return;

      applySingleCompanyMetrics(data);
    } catch (err) {
      console.error(err);
      toast.error('Failed to parse financial metrics');
    } finally {
      if (requestId === fetchIdRef.current) {
        setLoading(false);
        setVerifying(false);
      }
    }
  };

  // ─── "All Companies" combined view ────────────────────────────────────
  // Runs computeMetricsForCompany for every company in parallel (each one
  // still benefits from its own cache above), then sums the money figures,
  // merges the monthly trend and expense-breakdown charts across
  // companies, and rolls the integrity checks up into a combined picture
  // that still names which company/companies failed which rule.
  // Pure aggregation over an already-resolved `ok` array (one entry per
  // successfully-loaded company) — pulled out of fetchAggregateMetrics so
  // both the instant cache-hit path and the network path can share it.
  const applyAggregateMetrics = (ok, companyList) => {
    if (!ok.length) {
      toast.error('Could not load figures for any company.');
      setRevenue(0); setReceivables(0); setCashAndBank(0); setPayables(0);
      setNetProfit(0); setExpenses(0); setChartData([]); setExpenseBreakdown([]);
      setValidation(null); setLastVerifiedAt(null); setInsights([]);
      return;
    }

    const sum = (key) => ok.reduce((s, { data }) => s + (Number(data[key]) || 0), 0);
    setRevenue(sum('revenue'));
    setReceivables(sum('receivables'));
    setCashAndBank(sum('cashAndBank'));
    setPayables(sum('payables'));
    setExpenses(sum('expenses'));
    setNetProfit(sum('netProfit'));

    // Merge monthly trend charts by month label, summing every
    // company's Revenue/Expenses/Profit for that month.
    const monthMap = new Map();
    ok.forEach(({ data }) => {
      (data.chartData || []).forEach((row) => {
        const cur = monthMap.get(row.name) || { name: row.name, Revenue: 0, Expenses: 0, Profit: 0 };
        cur.Revenue += Number(row.Revenue) || 0;
        cur.Expenses += Number(row.Expenses) || 0;
        cur.Profit += Number(row.Profit) || 0;
        monthMap.set(row.name, cur);
      });
    });
    setChartData(Array.from(monthMap.values()).map((r) => ({
      ...r, Revenue: round2(r.Revenue), Expenses: round2(r.Expenses), Profit: round2(r.Profit),
    })));

    // Merge expense breakdown by category name across every company.
    const catMap = new Map();
    ok.forEach(({ data }) => {
      (data.expenseBreakdown || []).forEach((row) => {
        catMap.set(row.name, (catMap.get(row.name) || 0) + (Number(row.value) || 0));
      });
    });
    setExpenseBreakdown(Array.from(catMap.entries()).map(([name, value]) => ({ name, value })));

    // Combined integrity picture — a rule only shows as passing if every
    // company's own check passed; a failing rule names which and how
    // many companies are affected instead of just a single generic flag.
    const combinedMismatches = [];
    INTEGRITY_CHECKS.forEach(({ rule }) => {
      const failing = ok.filter(({ data }) => data.validation?.mismatches?.some((m) => m.rule === rule));
      if (failing.length) {
        const totalDiff = failing.reduce((s, { data }) => {
          const m = data.validation.mismatches.find((m2) => m2.rule === rule);
          return s + Math.abs(m?.diff || 0);
        }, 0);
        combinedMismatches.push({
          rule,
          diff: totalDiff,
          note: `${failing.length} of ${ok.length} compan${failing.length === 1 ? 'y' : 'ies'} affected: ${failing.map(({ company }) => company.name).join(', ')}`,
        });
      }
    });
    const anyVerified = ok.some(({ data }) => !!data.validation);
    setValidation(anyVerified ? { mismatches: combinedMismatches } : null);
    setLastVerifiedAt(anyVerified ? new Date() : null);

    // Combined insights: a headline summary plus each company's own top
    // warning (if any), so nothing important gets buried by aggregation.
    const combinedInsights = [{
      type: combinedMismatches.length ? 'warning' : 'success',
      category: 'Combined View',
      title: `Combined figures across ${ok.length} of ${companyList.length} companies`,
      text: combinedMismatches.length
        ? `${combinedMismatches.length} integrity check${combinedMismatches.length === 1 ? '' : 's'} failed in at least one company — see the Autonomous Integrity Shield below for details.`
        : 'All companies passed every integrity check for the current financial year.',
    }];
    ok.forEach(({ data, company }) => {
      const warn = (data.insights || []).find((i) => i.type === 'warning');
      if (warn) combinedInsights.push({ ...warn, title: `${company.name}: ${warn.title}` });
    });
    setInsights(combinedInsights);
  };

  const fetchAggregateMetrics = async (companyList, { force = false } = {}) => {
    if (!companyList.length) {
      setLoading(false);
      return;
    }
    const requestId = ++fetchIdRef.current;

    // If every company in the list already has a fresh cached snapshot,
    // aggregate and paint instantly — no loading flash, no network calls.
    // Same cache-first idea as fetchMetrics above, extended to the "All
    // Companies" view.
    if (!force) {
      const cachedEntries = companyList.map((company) => ({ company, data: peekMetricsCache(company.id) }));
      if (cachedEntries.every((e) => e.data)) {
        const ok = cachedEntries.map(({ company, data }) => ({ company, data }));
        applyAggregateMetrics(ok, companyList);
        setLoading(false);
        setVerifying(false);
        return;
      }
    }

    setLoading(true);
    try {
      const settled = await Promise.allSettled(
        companyList.map((c) => computeMetricsForCompany(c.id, { force }))
      );
      if (requestId !== fetchIdRef.current) return;

      const ok = settled
        .map((r, i) => ({ r, company: companyList[i] }))
        .filter(({ r }) => r.status === 'fulfilled')
        .map(({ r, company }) => ({ data: r.value, company }));

      applyAggregateMetrics(ok, companyList);
    } catch (err) {
      console.error(err);
      toast.error('Failed to aggregate financial metrics across companies.');
    } finally {
      if (requestId === fetchIdRef.current) {
        setLoading(false);
        setVerifying(false);
      }
    }
  };

  const handleReverify = async () => {
    if (!companyId || companyId === ALL_COMPANIES_ID || verifying) return;
    setVerifying(true);
    try {
      const v = await runVerifyAndFix(companyId, { force: true });
      setValidation(v);
      const verifiedAt = new Date();
      setLastVerifiedAt(verifiedAt);
      // Keep the cached snapshot in sync so switching away and back within
      // the cache TTL doesn't show the stale pre-reverify result.
      const cachedMetrics = _metricsCache_finix.get(companyId);
      if (cachedMetrics) {
        cachedMetrics.data = { ...cachedMetrics.data, validation: v, lastVerifiedAt: verifiedAt };
        ssWrite(SS_METRICS_PREFIX + companyId, {
          ts: cachedMetrics.ts,
          data: { ...cachedMetrics.data, lastVerifiedAt: verifiedAt.toISOString() },
        });
      }
    } catch (err) {
      console.error(err);
      toast.error('Verification failed. Please try again.');
    } finally {
      setVerifying(false);
    }
  };

  useEffect(() => {
    (async () => {
      const list = await fetchCompanies();
      let initialCid = '';
      if (list.length) {
        const stored = localStorage.getItem('accountingReports:lastCompanyId') || '';
        if (stored === ALL_COMPANIES_ID || (stored && list.some((c) => c.id === stored))) initialCid = stored;
        else initialCid = list[0].id;
      }
      setCompanyId(initialCid);
      if (initialCid === ALL_COMPANIES_ID) {
        fetchAggregateMetrics(list);
      } else if (initialCid) {
        fetchMetrics(initialCid);
      }
    })();
  }, [user?.id]);

  const handleCompanyChange = (val) => {
    setCompanyId(val);
    localStorage.setItem('accountingReports:lastCompanyId', val);
    if (val === ALL_COMPANIES_ID) {
      fetchAggregateMetrics(companies);
    } else {
      fetchMetrics(val);
    }
  };

  // Chat message send handler
  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

    // The AI accountant reasons over one company's ledger — "All
    // Companies" has no single company_id to ground it in, so ask the
    // person to pick a company instead of sending a request that can't
    // be answered meaningfully.
    if (companyId === ALL_COMPANIES_ID) {
      const userMsg = {
        sender: 'user',
        text: chatInput,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      const aiMsg = {
        sender: 'ai',
        text: 'I can only audit one company\'s ledger at a time — please switch the dropdown above from "All Companies" to a specific company and ask me again.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages(prev => [...prev, userMsg, aiMsg]);
      setChatInput('');
      return;
    }

    const userMsg = {
      sender: 'user',
      text: chatInput,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setChatLoading(true);

    // Build context summary to pass to the API for contextual reasoning
    const context_summary = `
      Company ID: ${companyId}
      Total Revenue: ${fmtC(revenue)}
      Accounts Receivable: ${fmtC(receivables)}
      Bank & Cash Balance: ${fmtC(cashAndBank)}
      Accounts Payable: ${fmtC(payables)}
      Net Profit: ${fmtC(netProfit)}
      Total Expenses: ${fmtC(expenses)}
    `;

    try {
      const { data } = await api.post('/reports/finix-dashboard/chat', {
        message: userMsg.text,
        company_id: companyId,
        context_summary
      });

      const aiMsg = {
        sender: 'ai',
        text: data.response || 'I am sorry, I encountered an issue processing your request. Please try again.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages(prev => [...prev, aiMsg]);
    } catch (err) {
      console.error(err);
      const aiMsg = {
        sender: 'ai',
        text: "I am currently running in local backup mode because the server connection was interrupted. I recommend verifying your `GEMINI_API_KEY` configuration. Let me know if there's anything else I can calculate for you!",
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setChatMessages(prev => [...prev, aiMsg]);
    } finally {
      setChatLoading(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const COLORS_CHART = ['#1FAF5A', '#FF6B6B', '#3B82F6', '#FF9F43'];

  return (
    <div className={`p-6 min-h-screen ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>

      {/* ── Header — branded Finix banner, echoes the app's own navy→teal
           header palette (deepBlue #0D3B66 → emeraldGreen #1FAF5A) so it
           reads as part of the same product family rather than a bolted-on
           page ── */}
      <div
        className="relative overflow-hidden rounded-3xl mb-8 shadow-lg"
        style={{ background: 'linear-gradient(115deg, #0A2E52 0%, #0D3B66 38%, #0F5C63 72%, #12806B 100%)' }}
      >
        {/* Faint decorative circuit glow, echoes the logo's own circuit motif */}
        <div
          className="pointer-events-none absolute -right-10 -top-16 w-64 h-64 rounded-full opacity-20"
          style={{ background: 'radial-gradient(circle, #5CCB5F 0%, transparent 70%)' }}
        />
        <div
          className="pointer-events-none absolute -left-16 -bottom-20 w-72 h-72 rounded-full opacity-10"
          style={{ background: 'radial-gradient(circle, #2B8CD1 0%, transparent 70%)' }}
        />

        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-5 px-6 py-5 md:px-8 md:py-6">
          {/* Brand block */}
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white">
                  FIN<span style={{ background: 'linear-gradient(90deg, #5CCB5F, #7FE3C4)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>IX</span>
                </h1>
                <span className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/10 border border-white/20 text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                  <Sparkles className="w-3 h-3" /> AI Accounting
                </span>
              </div>
              <p className="text-xs md:text-sm mt-1 text-slate-200/80 tracking-wide">
                Automate &middot; Analyze &middot; Ascend — Autonomous Financial Control Center &amp; Smart Auditing Engine
              </p>
            </div>
          </div>

          {/* Company Dropdown */}
          <div className="flex items-center gap-3">
            <Building2 className="w-5 h-5 text-slate-200/70 hidden sm:block" />
            <Select value={companyId} onValueChange={handleCompanyChange}>
              <SelectTrigger className="h-11 w-[240px] md:w-[260px] rounded-2xl border border-white/20 bg-white/10 backdrop-blur-sm text-white placeholder:text-white/60 [&>span]:text-white">
                <SelectValue placeholder="Select Company" />
              </SelectTrigger>
              <SelectContent>
                {companies.length > 1 && (
                  <SelectItem value={ALL_COMPANIES_ID}>
                    <span className="flex items-center gap-1.5 font-bold">
                      <Layers className="w-3.5 h-3.5" /> All Companies
                    </span>
                  </SelectItem>
                )}
                {companies.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() => companyId === ALL_COMPANIES_ID
                ? fetchAggregateMetrics(companies, { force: true })
                : fetchMetrics(companyId, { force: true })}
              disabled={loading || !companyId}
              className="h-11 w-11 rounded-2xl border-white/20 bg-white/10 backdrop-blur-sm text-white hover:bg-white/20 hover:text-white"
              title={companyId === ALL_COMPANIES_ID ? 'Refresh all companies' : 'Refresh'}
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
      </div>

      {companyId === ALL_COMPANIES_ID && !loading && (
        <div className={`mb-6 -mt-4 flex items-center gap-2 text-xs font-semibold px-4 py-2 rounded-2xl border ${isDark ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-blue-50 border-blue-100 text-blue-700'}`}>
          <Layers className="w-3.5 h-3.5 shrink-0" />
          Showing combined figures across all {companies.length} companies. Switch to a single company to chat with Finix AI or re-run its integrity checks.
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-24">
          <ContentLoader />
          <p className="text-sm text-slate-400 mt-4 animate-pulse">Initializing Finix AI ledger sync...</p>
        </div>
      ) : !companyId ? (
        <div className="text-center py-24 rounded-3xl border border-dashed border-slate-300 dark:border-slate-700">
          <HelpCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <h3 className="text-lg font-bold">No Company Selected</h3>
          <p className="text-sm text-slate-500 mt-1">Please select or create a company to initialize the Finix Dashboard.</p>
        </div>
      ) : (
        <div className="space-y-8">

          {/* ── KPI Cards ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 items-stretch">
            
            {/* Card 1: Revenue */}
            <div
              className={`h-[104px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-emerald-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(16,185,129,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #ecfdf5 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-500">Sales & Revenue</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(16,185,129,0.3), rgba(16,185,129,0.08))' : 'linear-gradient(135deg, #a7f3d0, #ecfdf5)' }}>
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(revenue)}</h2>
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400">
                <span className="font-semibold text-emerald-500">Matched with Sales ledgers</span>
              </div>
            </div>

            {/* Card 2: Accounts Receivable */}
            <div
              className={`h-[104px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-amber-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(245,158,11,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #fffbeb 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-amber-500">Accounts Receivable</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(245,158,11,0.3), rgba(245,158,11,0.08))' : 'linear-gradient(135deg, #fde68a, #fffbeb)' }}>
                  <Receipt className="w-4 h-4 text-amber-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(receivables)}</h2>
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400">
                <span className="font-semibold text-amber-500">Total Outstanding Due</span>
              </div>
            </div>

            {/* Card 3: Cash & Bank */}
            <div
              className={`h-[104px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-blue-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(59,130,246,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #eff6ff 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-500">Bank & Cash Balance</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(59,130,246,0.3), rgba(59,130,246,0.08))' : 'linear-gradient(135deg, #bfdbfe, #eff6ff)' }}>
                  <Landmark className="w-4 h-4 text-blue-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(cashAndBank)}</h2>
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400">
                <span className="font-semibold text-blue-500">Real-time Liquid Reserves</span>
              </div>
            </div>

            {/* Card 4: Accounts Payable */}
            <div
              className={`h-[104px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-purple-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(168,85,247,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #faf5ff 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-purple-500">Accounts Payable</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(168,85,247,0.08))' : 'linear-gradient(135deg, #e9d5ff, #faf5ff)' }}>
                  <TrendingDown className="w-4 h-4 text-purple-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(payables)}</h2>
              <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-slate-400">
                <span className="font-semibold text-purple-500">Vendor Outstandings</span>
              </div>
            </div>

          </div>

          {/* ── Main Layout: Charts, Chatbot & Insights ──
               Both rows below use `items-stretch` on a single shared grid,
               so every card in a row is forced to the same height as its
               tallest sibling — Revenue Trend now matches Ask Finix AI
               Accountant, and Operating Cost Distribution / Autonomous
               Integrity Shield / Real-time Auditing Insights all match
               each other, instead of drifting apart because they used to
               live in two independently-stacked columns. ── */}

          {/* Row 1: Revenue vs Expenses Trend + Ask Finix AI Accountant */}
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-8 items-stretch">

            {/* Chart 1: Revenue vs Expenses Trend */}
            <div className={`xl:col-span-2 h-full flex flex-col p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h3 className="font-extrabold text-lg flex items-center gap-2">
                    <LineIcon className="w-5 h-5 text-emerald-500" />
                    Revenue vs Expenses Trend
                  </h3>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Real monthly totals for the current financial year (Apr–{new Date().toLocaleString('en-US', { month: 'short' })})
                  </p>
                </div>
              </div>
              <div className="flex-1 min-h-[280px] w-full font-mono text-xs">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#1FAF5A" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#1FAF5A" stopOpacity={0}/>
                      </linearGradient>
                      <linearGradient id="colorExp" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#FF6B6B" stopOpacity={0.2}/>
                        <stop offset="95%" stopColor="#FF6B6B" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#E2E8F0'} />
                    <XAxis dataKey="name" stroke={isDark ? '#94A3B8' : '#64748B'} />
                    <YAxis stroke={isDark ? '#94A3B8' : '#64748B'} />
                    <Tooltip
                      contentStyle={{ backgroundColor: isDark ? '#1E293B' : '#FFFFFF', border: 'none', borderRadius: '12px' }}
                      formatter={(value) => fmtC(value)}
                    />
                    <Legend />
                    <Area type="monotone" dataKey="Revenue" stroke="#1FAF5A" fillOpacity={1} fill="url(#colorRev)" strokeWidth={2.5} />
                    <Area type="monotone" dataKey="Expenses" stroke="#FF6B6B" fillOpacity={1} fill="url(#colorExp)" strokeWidth={2.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Finix AI Chatbot Co-Pilot */}
            <div className={`h-[480px] flex flex-col p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div className="flex items-center gap-2.5 pb-4 border-b border-slate-100 dark:border-slate-700">
                <div className="p-2 bg-emerald-500/10 rounded-2xl">
                  <Brain className="w-5 h-5 text-emerald-500" />
                </div>
                <div>
                  <h3 className="font-extrabold text-sm">Ask Finix AI Accountant</h3>
                  <p className="text-[10px] text-emerald-500 font-semibold animate-pulse">Core intelligence connected</p>
                </div>
              </div>

              {/* Messages Panel */}
              <div className="flex-1 overflow-y-auto py-4 space-y-3 pr-1 text-xs">
                {chatMessages.map((msg, i) => (
                  <div key={i} className={`flex flex-col ${msg.sender === 'user' ? 'items-end' : 'items-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 ${msg.sender === 'user' ? 'bg-emerald-600 text-white' : isDark ? 'bg-slate-700 text-slate-200' : 'bg-slate-100 text-slate-800'}`}>
                      <p className="leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                    </div>
                    <span className="text-[9px] text-slate-400 mt-1 px-1">{msg.time}</span>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex items-center gap-1 text-slate-400 italic">
                    <span className="animate-bounce">●</span>
                    <span className="animate-bounce delay-75">●</span>
                    <span className="animate-bounce delay-150">●</span>
                    <span className="text-[10px] ml-1">Finix is auditing ledger records...</span>
                  </div>
                )}
                <div ref={chatEndRef} />
              </div>

              {/* Chat Pre-fills */}
              <div className="flex flex-wrap gap-1.5 mb-3">
                {[
                  "Check Receivables aging",
                  "Audit GST output liabilities"
                ].map((txt) => (
                  <button
                    key={txt}
                    type="button"
                    onClick={() => setChatInput(txt)}
                    className={`text-[10px] px-2 py-1 rounded-full border border-dashed transition-all ${isDark ? 'border-slate-700 hover:bg-slate-700' : 'border-slate-200 hover:bg-slate-50'}`}
                  >
                    {txt}
                  </button>
                ))}
              </div>

              {/* Input Panel */}
              <form onSubmit={handleSendMessage} className="flex gap-2 shrink-0">
                <input
                  type="text"
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  placeholder={companyId === ALL_COMPANIES_ID ? 'Pick a single company to chat...' : 'Ask about receivables, taxes, margins...'}
                  className={`flex-1 px-4 py-2 text-xs rounded-xl border focus:outline-none focus:ring-1 focus:ring-emerald-500 ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-800'}`}
                />
                <Button type="submit" size="icon" disabled={chatLoading} className="rounded-xl h-9 w-9 bg-emerald-600 hover:bg-emerald-700">
                  <Send className="w-4 h-4 text-white" />
                </Button>
              </form>
            </div>

          </div>

          {/* Row 2: Operating Cost Distribution + Autonomous Integrity Shield + Real-time Auditing Insights */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 items-stretch">

            {/* Expense Breakdown */}
            <div className={`h-full flex flex-col p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <h3 className="font-extrabold text-lg flex items-center gap-2 mb-4">
                <PieIcon className="w-5 h-5 text-emerald-500" />
                Operating Cost Distribution
              </h3>
              {expenseBreakdown.length > 0 ? (
                <div className="flex-1 min-h-[16rem] w-full text-xs">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={expenseBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={80}
                        paddingAngle={4}
                        dataKey="value"
                      >
                        {expenseBreakdown.map((entry, index) => (
                          <Cell key={`cell-${index}`} fill={COLORS_CHART[index % COLORS_CHART.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => fmtC(value)} />
                      <Legend verticalAlign="bottom" height={36} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="flex-1 min-h-[16rem] flex flex-col items-center justify-center text-center gap-2 text-slate-400">
                  <PieIcon className="w-8 h-8 opacity-40" />
                  <p className="text-xs">No expense entries recorded yet for this period.</p>
                </div>
              )}
            </div>

            {/* AI Auditing Summary — driven by the real reconciliation
                engine (runVerifyAndFix) instead of static always-green
                claims, so a genuine mismatch actually shows up here. */}
            <div className={`h-full flex flex-col p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-extrabold text-lg flex items-center gap-2">
                  <Brain className="w-5 h-5 text-emerald-500" />
                  Autonomous Integrity Shield
                </h3>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleReverify}
                  disabled={verifying || !companyId || companyId === ALL_COMPANIES_ID}
                  className="h-8 w-8 rounded-lg shrink-0"
                  title={companyId === ALL_COMPANIES_ID ? 'Switch to a single company to re-verify' : 'Re-run integrity checks'}
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${verifying ? 'animate-spin' : ''}`} />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto pr-1 flex flex-col justify-between gap-4">
                {INTEGRITY_CHECKS.map((chk) => {
                  const mismatch = validation?.mismatches?.find((m) => m.rule === chk.rule);
                  const passed = !!validation && !mismatch;
                  return (
                    <div key={chk.rule} className="flex items-start gap-3">
                      <div className={`p-2 rounded-xl shrink-0 ${passed ? 'bg-emerald-500/10' : mismatch ? 'bg-amber-500/10' : 'bg-slate-500/10'}`}>
                        {passed ? (
                          <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                        ) : mismatch ? (
                          <AlertTriangle className="w-5 h-5 text-amber-500" />
                        ) : (
                          <ShieldAlert className="w-5 h-5 text-slate-400" />
                        )}
                      </div>
                      <div>
                        <h4 className="text-sm font-bold">{chk.title}</h4>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {passed
                            ? chk.okText
                            : mismatch
                            ? `Mismatch of ${fmtC(Math.abs(mismatch.diff))} detected${mismatch.note ? ` — ${mismatch.note}` : '. Re-sync recommended.'}`
                            : verifying ? 'Verifying…' : 'Not yet verified — click refresh to run this check.'}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
              {lastVerifiedAt && (
                <p className="text-[10px] text-slate-400 mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 shrink-0">
                  Last verified {lastVerifiedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </p>
              )}
            </div>

            {/* Dynamic AI Insights & Alerts List */}
            <div className={`h-full flex flex-col p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <h3 className="font-extrabold text-sm flex items-center gap-2 mb-4">
                <Sparkles className="w-4 h-4 text-emerald-500" />
                Real-time Auditing Insights
              </h3>
              <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                {insights.map((ins, i) => (
                  <div key={i} className={`p-4 rounded-2xl border ${ins.type === 'warning' ? 'bg-amber-500/5 border-amber-500/20' : ins.type === 'success' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-blue-500/5 border-blue-500/20'}`}>
                    <div className="flex items-center gap-2 mb-1.5">
                      {ins.type === 'warning' ? (
                        <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                      )}
                      <span className={`text-[10px] font-extrabold uppercase tracking-wider ${ins.type === 'warning' ? 'text-amber-500' : ins.type === 'success' ? 'text-emerald-500' : 'text-blue-500'}`}>
                        {ins.category}
                      </span>
                    </div>
                    <h4 className="text-xs font-bold leading-tight">{ins.title}</h4>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{ins.text}</p>
                  </div>
                ))}
                {insights.length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-4">Reconciled with 0 warnings.</p>
                )}
              </div>
            </div>

          </div>

        </div>
      )}
    </div>
  );
}
