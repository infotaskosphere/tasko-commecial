import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  BarChart3, RefreshCw, CheckCircle2, AlertTriangle, Building2,
  TrendingUp, TrendingDown, Landmark, Receipt, Sparkles, Send, Brain, HelpCircle,
  ArrowRight, ShieldCheck, ShieldAlert, PieChart as PieIcon, LineChart as LineIcon,
  Clock, Layers, PlusCircle, ArrowUpRight, ArrowDownLeft, FileText, Check,
  AlertCircle, Calendar, Wallet, FileCheck, ExternalLink, Activity, Scale, ChevronRight, X
} from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, BarChart, Bar
} from 'recharts';
import api from '@/lib/api';
import { createJournalEntry } from '@/lib/journalEntriesApi';
import { normalizeCompanies } from "@/lib/companies";
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { runVerifyAndFix, describeValidationResult } from '@/lib/verifyAndFixLedger';
import { currentFinancialYearRange, financialYearStartYear, toLocalISODate } from '@/lib/financialYear';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { isCommercialTenant, isPlatformOwner } from '@/lib/commercialPermissionMatrix';
import FinixAICommandCenter from '@/components/finix/FinixAICommandCenter.jsx';

const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Friendly display copy for each backend validation rule
const INTEGRITY_CHECKS = [
  { rule: 'Accounts Receivable = Outstanding', title: 'Ledger Balance Reconciliation', okText: 'Accounts receivable matches invoice outstandings exactly. No leakage detected.' },
  { rule: 'Bank Accounts (GL) = Real Bank Statement Balance', title: 'Bank Ledger Compliance', okText: 'Ledger bank balance matches the imported bank statement balance.' },
  { rule: 'GST + Non-GST + Export + Exempt Sales = Revenue', title: 'GST Portal Return Sync Integrity', okText: 'GST/non-GST/export/exempt sales buckets add up to total revenue.' },
  { rule: 'Trial Balance Debits = Credits', title: 'Trial Balance Integrity', okText: 'Every posted journal entry balances — total debits equal total credits.' },
];

const _companiesCache_finix = { data: null, ts: 0, owner: null };
const _metricsCache_finix = new Map();
const COMPANIES_CACHE_TTL_MS = 5 * 60_000;
const METRICS_CACHE_TTL_MS = 60_000;
const ALL_COMPANIES_ID = '__all__';

const SS_METRICS_PREFIX = 'finix:metrics:';
// Bump the cache namespace whenever company-visibility rules change so an
// older browser session cannot retain a pre-isolation company list.
const SS_COMPANIES_KEY = 'finix:companies:v4';

function ssRead(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function ssWrite(key, value) {
  try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

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
  window.addEventListener('company-scoped-caches-purged', () => {
    _companiesCache_finix.data = null;
    _companiesCache_finix.ts = 0;
    _companiesCache_finix.owner = null;
    _metricsCache_finix.clear();
  });
}

function reportReportsDenied(err) {
  const detail = err?.response?.data?.detail;
  const text = typeof detail === 'string' && detail ? detail : 'The server refused access to the accounting reports (403).';
  console.warn('[Finix] reports denied:', text);
  toast.error(text, { id: 'finix-reports-denied', duration: 12000 });
}

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
  const navigate = useNavigate();

  const isPlatformOwnerUser = isPlatformOwner(user);
  const tenantCompanyId = isCommercialTenant(user) ? String(user?.company_id || '') : '';
  const ownerCompanyId = isPlatformOwnerUser ? String(user?.company_id || user?.company?.id || '') : '';
  const tenantCompanyName = user?.company_name || user?.company?.name || 'My Company';

  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState([]);
  // Keep the authoritative, freshly fetched company list available to async
  // metric requests even before React commits the setCompanies state update.
  const companyListRef = useRef([]);
  const [companyId, setCompanyId] = useState('');

  // Financial Metrics
  const [revenue, setRevenue] = useState(0);
  const [receivables, setReceivables] = useState(0);
  const [cashAndBank, setCashAndBank] = useState(0);
  const [payables, setPayables] = useState(0);
  const [netProfit, setNetProfit] = useState(0);
  const [expenses, setExpenses] = useState(0);

  // Upgraded Finix Capabilities
  const [healthScore, setHealthScore] = useState(null);
  const [statutorySummary, setStatutorySummary] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [cashflowForecast, setCashflowForecast] = useState(null);
  const [aiAvailability, setAiAvailability] = useState({ health: true, statutory: true, anomalies: true, cashflow: true });
  const [showHealthModal, setShowHealthModal] = useState(false);

  // Quick Voucher Modal
  const [showQuickVoucherModal, setShowQuickVoucherModal] = useState(false);
  const [quickVoucherType, setQuickVoucherType] = useState('CONTRA');
  const [voucherSubmitting, setVoucherSubmitting] = useState(false);
  const [accountsList, setAccountsList] = useState([]);
  const [voucherForm, setVoucherForm] = useState({
    sourceAccount: '',
    destAccount: '',
    debitAccount: '',
    creditAccount: '',
    amount: '',
    date: toLocalISODate(new Date()),
    narration: '',
  });

  // Chart and breakdown data
  const [chartData, setChartData] = useState([]);
  const [expenseBreakdown, setExpenseBreakdown] = useState([]);

  // AI Insights & Verification
  const [insights, setInsights] = useState([]);
  const [verifying, setVerifying] = useState(false);
  const [validation, setValidation] = useState(null);
  const [lastVerifiedAt, setLastVerifiedAt] = useState(null);

  // Chatbot State
  const [chatMessages, setChatMessages] = useState([
    {
      sender: 'ai',
      text: 'Hello! I am Finix AI, your intelligent financial co-pilot. I have scanned your general ledger, verified debit-credit parity, and reconciled GST/TDS liabilities. How can I assist you with your books today?',
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);
  const fetchIdRef = useRef(0);

  const scopeCompanies = (list) => {
    const rows = Array.isArray(list) ? list : [];
    // A Platform Owner's operational Finix selector must use the same canonical
    // company ID injected by authentication. Do not default to the first company
    // returned by the registry: that may be a different workspace or a licensee.
    if (isPlatformOwnerUser) {
      // /companies is already owner-scoped by the backend. Preserve all
      // returned owner-owned legal entities, while defensively excluding
      // explicitly tenant-marked records from any stale cache. The canonical
      // workspace marker determines the default selection, not the old
      // company_id embedded in a long-lived login session.
      return rows.filter((c) => {
        if (!c || typeof c !== 'object' || !c.id) return false;

        // The backend's authenticated Platform Owner scope is authoritative.
        // Legacy records can retain old commercial source/customer/license
        // markers even after the backend has verified this exact canonical
        // workspace and marked it as the Platform Owner workspace. Do not
        // discard that one verified canonical row because of those stale
        // markers; all other tenant-marked records remain excluded.
        // ownerCompanyId comes from the authenticated backend resolver, which
        // has already built a Platform Owner-only allow-list. The resolver may
        // repair the workspace marker in Mongo after building that list, so the
        // serialized row can legitimately still have a stale/missing marker.
        // Exact ID membership in this already-scoped response is the trusted
        // condition; requiring the marker here would drop the canonical row.
        const isCanonicalOwnerCompany =
          Boolean(ownerCompanyId) && String(c.id) === ownerCompanyId;
        if (isCanonicalOwnerCompany) return true;

        const source = String(c.source || '').trim().toLowerCase();
        const customerId = String(c.commercial_customer_id || '').trim().toLowerCase();
        const licenseId = String(c.license_id || '').trim().toLowerCase();
        if (['commercial-license', 'commercial', 'license', 'commercial-customer'].includes(source)) return false;
        if (customerId && !['platform-owner'].includes(customerId)) return false;
        if (licenseId && !['platform-owner-license'].includes(licenseId)) return false;
        return true;
      });
    }

    // Licensees can operate only inside their authenticated tenant workspace.
    if (tenantCompanyId) {
      const own = rows.filter((c) => c && typeof c === 'object' && String(c.id || '') === tenantCompanyId);
      return own.length ? own : [{ id: tenantCompanyId, name: tenantCompanyName }];
    }

    // Non-commercial users must not see commercial-license company records.
    return rows.filter((c) => {
      if (!c || typeof c !== 'object') return false;
      if (c.source === 'commercial-license' || c.source === 'commercial' || c.source === 'license') return false;
      if (c.commercial_customer_id && c.commercial_customer_id !== 'platform-owner') return false;
      if (c.license_id && c.license_id !== 'platform-owner-license') return false;
      return true;
    });
  };

  const fetchCompanies = async () => {
    ensureCacheOwner(user?.id);
    // Always refresh Platform Owner companies from the authoritative,
    // owner-scoped API. A stale in-memory list must not hide the canonical
    // workspace or survive a workspace marker correction.
    if (!isPlatformOwnerUser && _companiesCache_finix.data && Date.now() - _companiesCache_finix.ts < COMPANIES_CACHE_TTL_MS) {
      const scoped = scopeCompanies(_companiesCache_finix.data);
      companyListRef.current = scoped;
      setCompanies(scoped);
      return scoped;
    }
    const cached = ssRead(SS_COMPANIES_KEY);
    if (!isPlatformOwnerUser && cached?.data && Date.now() - cached.ts < COMPANIES_CACHE_TTL_MS) {
      _companiesCache_finix.data = cached.data;
      _companiesCache_finix.ts = cached.ts;
      const cachedScoped = scopeCompanies(cached.data);
      companyListRef.current = cachedScoped;
      setCompanies(cachedScoped);
    }
    try {
      // Use the canonical Master Data endpoint first. This keeps Finix's
      // selector aligned with the two company records visible in Admin →
      // Master Data instead of a legacy/dropdown-only company population.
      let res;
      try {
        res = await api.get('/companies');
      } catch (masterErr) {
        if (masterErr?.response?.status !== 404) throw masterErr;
        res = await api.get('/companies/list');
      }
      const list = normalizeCompanies(res);
      _companiesCache_finix.data = list;
      _companiesCache_finix.ts = Date.now();
      ssWrite(SS_COMPANIES_KEY, { data: list, ts: _companiesCache_finix.ts });
      const scoped = scopeCompanies(list);
      companyListRef.current = scoped;
      setCompanies(scoped);
      return scoped;
    } catch (error) {
      // Owner company lists are security-sensitive. Never resurrect an old
      // session cache for a Platform Owner when the authoritative registry
      // could not be fetched: it may contain a deleted/stale company ID which
      // will be sent to every Finix report endpoint.
      if (isPlatformOwnerUser) {
        _companiesCache_finix.data = null;
        _companiesCache_finix.ts = 0;
        _metricsCache_finix.clear();
        companyListRef.current = [];
        setCompanies([]);
        try {
          Object.keys(sessionStorage).forEach((key) => {
            if (key.startsWith('finix:')) sessionStorage.removeItem(key);
          });
          localStorage.removeItem('accountingReports:lastCompanyId');
        } catch {}
        console.warn('[Finix] owner company registry unavailable; refusing stale cached IDs', {
          status: error?.response?.status || null,
          message: error?.message || String(error),
        });
        return [];
      }
      const scoped = scopeCompanies(cached?.data || []);
      companyListRef.current = scoped;
      setCompanies(scoped);
      return scoped;
    }
  };

  const persistCompanySelection = (cid) => {
    try {
      if (cid) localStorage.setItem('accountingReports:lastCompanyId', String(cid));
      else localStorage.removeItem('accountingReports:lastCompanyId');
    } catch {}
  };

  // All Finix callers (reports, chart-of-accounts, AI chat, and voucher posting)
  // must resolve the selected company against the freshest authorized registry
  // before issuing a request. Never trust a persisted company_id by itself.
  const resolveAuthorizedCompanyId = (requestedCompanyId) => {
    const availableCompanies = Array.isArray(companyListRef.current)
      ? companyListRef.current
      : [];
    const requested = String(requestedCompanyId || '').trim();

    if (isPlatformOwnerUser) {
      if (availableCompanies.some((company) => String(company?.id || '') === requested)) {
        return requested;
      }
      const fallback =
        availableCompanies.find((company) => company?.is_platform_owner_workspace === true) ||
        availableCompanies.find((company) => String(company?.id || '') === ownerCompanyId) ||
        availableCompanies[0];
      if (!fallback?.id) {
        throw new Error('No verified Platform Owner company is available for Finix. Refresh the company list and try again.');
      }
      const resolved = String(fallback.id);
      console.warn('[Finix] replacing unauthorized/stale owner company selection', {
        requestedCompanyId: requested || null,
        resolvedCompanyId: resolved,
      });
      setCompanyId(resolved);
      persistCompanySelection(resolved);
      return resolved;
    }

    if (tenantCompanyId) {
      // The authenticated licensee company ID is the only permitted fallback.
      const resolved = String(tenantCompanyId);
      if (requested !== resolved) {
        setCompanyId(resolved);
        persistCompanySelection(resolved);
      }
      return resolved;
    }

    if (availableCompanies.some((company) => String(company?.id || '') === requested)) {
      return requested;
    }
    const fallback = availableCompanies.find((company) => company?.id);
    if (!fallback?.id) {
      throw new Error('No verified company is available for Finix reports.');
    }
    const resolved = String(fallback.id);
    setCompanyId(resolved);
    persistCompanySelection(resolved);
    return resolved;
  };

  const loadAccountsForVoucher = async (requestedCid) => {
    let cid;
    try {
      cid = resolveAuthorizedCompanyId(requestedCid);
    } catch (error) {
      setAccountsList([]);
      console.warn('[Finix] chart of accounts was not loaded because company scope could not be verified:', error?.message);
      return;
    }
    if (!cid || cid === ALL_COMPANIES_ID) return;
    // Do not request Chart of Accounts merely because the dashboard is open.
    // It is separately governed from the Journal Entries page. This prevents
    // a legitimate dashboard/metrics load from generating a 403 for users who
    // can see Finix but were not granted Chart of Accounts access.
    const permissions = user?.permissions && typeof user.permissions === 'object' ? user.permissions : {};
    const canViewCOA = user?.role === 'admin' ||
      permissions.can_view_chart_of_accounts === true ||
      permissions.can_manage_chart_of_accounts === true;
    const canPostJournal = user?.role === 'admin' || permissions.can_post_journal_entries === true;
    if (!canViewCOA || !canPostJournal) {
      setAccountsList([]);
      return;
    }
    try {
      const res = await api.get('/chart-of-accounts', { params: { company_id: cid } });
      const list = res?.data?.accounts || res?.data || [];
      if (Array.isArray(list)) setAccountsList(list);
    } catch (e) {
      console.warn('Failed to load chart of accounts for quick voucher:', e);
      setAccountsList([]);
    }
  };

  const buildMonthlyTrend = async (cid) => {
    const now = new Date();
    const fyStartYear = financialYearStartYear(now);
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
      const df = toLocalISODate(start);
      const dt = toLocalISODate(end);
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

  const computeMetricsForCompany = async (requestedCompanyId, { force = false, onValidationSettled } = {}) => {
    // Resolve once from the current authorized list; every report/AI query in
    // this function uses the same verified company ID.
    const cid = resolveAuthorizedCompanyId(requestedCompanyId);

    const cached = _metricsCache_finix.get(cid);
    if (!force && cached && Date.now() - cached.ts < METRICS_CACHE_TTL_MS) {
      return cached.data;
    }
    if (!force) {
      const ss = ssRead(SS_METRICS_PREFIX + cid);
      if (ss && Date.now() - ss.ts < METRICS_CACHE_TTL_MS) {
        const restored = { ...ss.data, lastVerifiedAt: ss.data.lastVerifiedAt ? new Date(ss.data.lastVerifiedAt) : null };
        _metricsCache_finix.set(cid, { ts: ss.ts, data: restored });
        return restored;
      }
    }

    // Jan–Mar belongs to the financial year that began the previous April.
    const { from: df, to: dt } = currentFinancialYearRange(new Date());

    const [batchSettled, trend, validationResult, healthScoreRes, statutoryRes, anomaliesRes, cashflowRes] = await Promise.all([
      Promise.allSettled([
        api.get('/reports/trial-balance', { params: { company_id: cid, date_from: df, date_to: dt } }),
        api.get('/reports/profit-loss', { params: { company_id: cid, date_from: df, date_to: dt } }),
        api.get('/reports/balance-sheet', { params: { company_id: cid, as_of: toLocalISODate(new Date()) } }),
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
      api.get('/finix/ai/health-score', { params: { company_id: cid } }).catch(() => null),
      api.get('/finix/ai/statutory-summary', { params: { company_id: cid } }).catch(() => null),
      api.get('/finix/ai/anomalies', { params: { company_id: cid } }).catch(() => null),
      api.get('/finix/ai/cashflow-forecast', { params: { company_id: cid } }).catch(() => null),
    ]);

    const [tbRes, pnlRes, bsRes] = batchSettled;
    const deniedReport = batchSettled.find((r) => r.status === 'rejected' && r.reason?.response?.status === 403);
    if (deniedReport) reportReportsDenied(deniedReport.reason);

    let tbData = tbRes.status === 'fulfilled' ? tbRes.value.data : null;
    let pnlData = pnlRes.status === 'fulfilled' ? pnlRes.value.data : null;
    let bsData = bsRes.status === 'fulfilled' ? bsRes.value.data : null;

    let revTotal = pnlData?.total_income || pnlData?.revenue || 0;
    if (!revTotal && tbData?.rows) {
      const salesAcct = tbData.rows.find(r => r.code === '4000');
      revTotal = salesAcct ? Math.abs((salesAcct.credit || 0) - (salesAcct.debit || 0)) : 0;
    }

    // Trial-balance rows for a control account AND its party sub-ledgers
    // (codes like 1100-AB12CD34), so receivables/payables are never understated
    // by entries posted straight to a customer/vendor ledger. 1200 is GST Input
    // Credit, NOT receivables, and must never be counted here.
    const sumControl = (rows, code, nature) => (rows || [])
      .filter((r) => r.code === code || String(r.code || '').startsWith(`${code}-`))
      .reduce((acc, r) => acc + (nature === 'dr' ? (r.debit || 0) - (r.credit || 0) : (r.credit || 0) - (r.debit || 0)), 0);
    const bsAmount = (list, code) => (list || [])
      .filter((a) => a.code === code || String(a.code || '').startsWith(`${code}-`))
      .reduce((acc, a) => acc + (a.amount || 0), 0);

    // The AI health endpoint is computed straight from the ledger (party ledgers
    // rolled up); prefer it so every card agrees with the Trial Balance.
    const ledgerHealth = healthScoreRes?.data && healthScoreRes.data.status !== 'NO_DATA' ? healthScoreRes.data : null;

    let arTotal = ledgerHealth?.total_receivables ?? null;
    if (arTotal === null) {
      arTotal = tbData?.rows ? sumControl(tbData.rows, '1100', 'dr') : bsAmount(bsData?.assets, '1100');
    }

    let liquidCash = ledgerHealth?.cash_and_bank ?? null;
    if (liquidCash === null) {
      liquidCash = tbData?.rows
        ? sumControl(tbData.rows, '1000', 'dr') + sumControl(tbData.rows, '1010', 'dr')
        : bsAmount(bsData?.assets, '1000') + bsAmount(bsData?.assets, '1010');
    }

    let apTotal = ledgerHealth?.total_payables ?? null;
    if (apTotal === null) {
      apTotal = tbData?.rows ? sumControl(tbData.rows, '2000', 'cr') : bsAmount(bsData?.liabilities, '2000');
    }

    const expTotal = pnlData?.total_expense ?? 0;
    const netProfitTotal = pnlData?.net_profit ?? (revTotal - expTotal);

    const chartDataResolved = trend.length ? trend : [
      { name: 'This FY', Revenue: round2(revTotal), Expenses: round2(expTotal), Profit: round2(revTotal - expTotal) }
    ];

    const realBreakdown = (pnlData?.expenses || [])
      .filter(e => Math.abs(e.amount || 0) > 0.01)
      .map(e => ({ name: e.name || e.code || 'Other', value: Math.abs(e.amount) }));

    // Insights: plain statements of what the ledger shows - no predictions,
    // benchmarks or advice that the data cannot support.
    const generatedInsights = [];

    if (arTotal < -0.5) {
      generatedInsights.push({
        type: 'warning',
        category: 'Data Integrity',
        title: 'Receivables Are Negative',
        text: `Accounts Receivable shows ${fmtC(arTotal)}. Receipts or credit notes exceed the invoices on the books - usually a credit note or payment left behind after its invoice was deleted. Check Sales > Credit Notes.`
      });
    } else if (arTotal > 0 && revTotal > 0) {
      const arRatio = (arTotal / revTotal) * 100;
      generatedInsights.push({
        type: arRatio > 35 ? 'warning' : 'info',
        category: 'Receivables & Collections',
        title: arRatio > 35 ? 'High Receivable Exposure' : 'Receivables Position',
        text: `Outstanding receivables are ${fmtC(arTotal)}, which is ${arRatio.toFixed(1)}% of this financial year's sales (${fmtC(revTotal)}).`
      });
    }

    if (liquidCash > 0 || apTotal > 0) {
      generatedInsights.push({
        type: liquidCash < apTotal ? 'warning' : 'info',
        category: 'Working Capital',
        title: liquidCash < apTotal ? 'Cash Is Below Payables' : 'Cash Covers Payables',
        text: `Cash and bank balances are ${fmtC(liquidCash)} against ${fmtC(apTotal)} owed to vendors.`
      });
    }

    const margin = (revTotal > 0) ? ((revTotal - expTotal) / revTotal) * 100 : null;
    if (margin !== null) {
      generatedInsights.push({
        type: margin > 0 ? 'info' : 'warning',
        category: 'Profitability',
        title: margin > 0 ? 'Net Margin This Year' : 'Loss This Year',
        text: `Net ${margin >= 0 ? 'profit' : 'loss'} margin for the financial year to date is ${margin.toFixed(1)}%.`
      });
    }

    // Health, statutory, anomalies and cash-flow come ONLY from the ledger-based
    // AI endpoints. When an endpoint fails the card says "unavailable" - the
    // dashboard never substitutes estimated or invented figures.
    const resolvedHealth = healthScoreRes?.data || null;
    const resolvedStatutory = statutoryRes?.data || null;
    const resolvedAnomalies = anomaliesRes?.data?.items || [];
    const resolvedCashflow = cashflowRes?.data || null;
    const aiAvailability = {
      health: !!healthScoreRes?.data,
      statutory: !!statutoryRes?.data,
      anomalies: !!anomaliesRes?.data,
      cashflow: !!cashflowRes?.data,
    };

    const lastVerifiedAt = validationResult ? new Date() : null;
    const data = {
      company_id: cid,
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
      healthScore: resolvedHealth,
      statutorySummary: resolvedStatutory,
      anomalies: resolvedAnomalies,
      cashflowForecast: resolvedCashflow,
      aiAvailability,
    };

    const ts = Date.now();
    _metricsCache_finix.set(cid, { ts, data });
    ssWrite(SS_METRICS_PREFIX + cid, { ts, data: { ...data, lastVerifiedAt: lastVerifiedAt ? lastVerifiedAt.toISOString() : null } });

    return data;
  };

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
    setHealthScore(data.healthScore);
    setStatutorySummary(data.statutorySummary);
    setAnomalies(data.anomalies || []);
    setCashflowForecast(data.cashflowForecast);
    setAiAvailability(data.aiAvailability || { health: true, statutory: true, anomalies: true, cashflow: true });
  };

  const fetchMetrics = async (requestedCid, { force = false } = {}) => {
    let cid;
    try {
      cid = resolveAuthorizedCompanyId(requestedCid);
    } catch (error) {
      setLoading(false);
      setVerifying(false);
      setAccountsList([]);
      toast.error(error?.message || 'No verified company is available for Finix.');
      return;
    }
    const requestId = ++fetchIdRef.current;
    if (!force) {
      const cached = peekMetricsCache(cid);
      if (cached) {
        applySingleCompanyMetrics(cached);
        setLoading(false);
        setVerifying(false);
        loadAccountsForVoucher(cid);
        return;
      }
    }

    setLoading(true);
    setVerifying(true);
    try {
      const data = await computeMetricsForCompany(cid, {
        force,
        onValidationSettled: (v) => {
          if (requestId !== fetchIdRef.current) return;
          setValidation(v);
          setLastVerifiedAt(v ? new Date() : null);
          setVerifying(false);
        },
      });

      if (requestId !== fetchIdRef.current) return;
      applySingleCompanyMetrics(data);
      loadAccountsForVoucher(cid);
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

  const applyAggregateMetrics = (ok, companyList) => {
    if (!ok.length) {
      toast.error('Could not load figures for any company.');
      setRevenue(0); setReceivables(0); setCashAndBank(0); setPayables(0);
      setNetProfit(0); setExpenses(0); setChartData([]); setExpenseBreakdown([]);
      setValidation(null); setLastVerifiedAt(null); setInsights([]);
      setHealthScore(null); setStatutorySummary(null); setAnomalies([]); setCashflowForecast(null);
      return;
    }

    const sum = (key) => ok.reduce((s, { data }) => s + (Number(data[key]) || 0), 0);
    setRevenue(sum('revenue'));
    setReceivables(sum('receivables'));
    setCashAndBank(sum('cashAndBank'));
    setPayables(sum('payables'));
    setExpenses(sum('expenses'));
    setNetProfit(sum('netProfit'));

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

    const catMap = new Map();
    ok.forEach(({ data }) => {
      (data.expenseBreakdown || []).forEach((row) => {
        catMap.set(row.name, (catMap.get(row.name) || 0) + (Number(row.value) || 0));
      });
    });
    setExpenseBreakdown(Array.from(catMap.entries()).map(([name, value]) => ({ name, value })));

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

    // Roll up Health Score - only from companies whose ledger produced a score.
    const scored = ok.filter(({ data }) => typeof data.healthScore?.score === 'number');
    const rollupIssues = ok.flatMap(({ data, company }) => (data.healthScore?.issues || []).map((i) => ({ ...i, message: `${company.name}: ${i.message}` })));
    if (scored.length) {
      const avgScore = Math.round(scored.reduce((acc, { data }) => acc + data.healthScore.score, 0) / scored.length);
      const worstBlocked = rollupIssues.some((i) => i.blocker) ? Math.min(avgScore, 79) : avgScore;
      const grade = worstBlocked >= 90 ? 'A+' : (worstBlocked >= 80 ? 'A' : (worstBlocked >= 65 ? 'B' : 'C'));
      const totalRevenue = sum('revenue');
      setHealthScore({
        score: worstBlocked,
        grade,
        partial: scored.length < ok.length,
        scored_companies: scored.length,
        total_companies: ok.length,
        issues: rollupIssues,
        trial_balance_balanced: scored.every(({ data }) => data.healthScore.trial_balance_balanced) && combinedMismatches.length === 0,
        working_capital: round2(sum('cashAndBank') + sum('receivables') - sum('payables')),
        current_ratio: sum('payables') > 0 ? round2((sum('cashAndBank') + sum('receivables')) / sum('payables')) : null,
        net_profit: sum('netProfit'),
        profit_margin: totalRevenue > 0 ? round2((sum('netProfit') / totalRevenue) * 100) : null,
        breakdown: {},
      });
    } else {
      setHealthScore(null);
    }

    // Roll up Statutory - straight sums of each company's ledger-derived figures.
    const withStat = ok.filter(({ data }) => data.statutorySummary?.gst);
    const sumStat = (path) => withStat.reduce((acc, { data }) => acc + (path(data.statutorySummary) || 0), 0);
    if (withStat.length) {
      const totOutputTax = sumStat((x) => x.gst.total_output_liability);
      const totITC = sumStat((x) => x.gst.total_input_itc);
      const sections = {};
      withStat.forEach(({ data }) => Object.entries(data.statutorySummary.tds?.sections || {}).forEach(([k, v]) => {
        sections[k] = round2((sections[k] || 0) + (v || 0));
      }));
      setStatutorySummary({
        partial: withStat.length < ok.length,
        gst: {
          outward_taxable: round2(sumStat((x) => x.gst.outward_taxable)),
          outward_cgst: round2(sumStat((x) => x.gst.outward_cgst)),
          outward_sgst: round2(sumStat((x) => x.gst.outward_sgst)),
          outward_igst: round2(sumStat((x) => x.gst.outward_igst)),
          total_output_liability: round2(totOutputTax),
          total_input_itc: round2(totITC),
          net_payable: Math.max(0, round2(totOutputTax - totITC)),
          itc_carried_forward: Math.max(0, round2(totITC - totOutputTax)),
          period: withStat[0].data.statutorySummary.gst.period,
        },
        tds: {
          total_deducted: round2(sumStat((x) => x.tds?.total_deducted)),
          tds_payable_balance: round2(sumStat((x) => x.tds?.tds_payable_balance)),
          sections,
          challan_due_date: withStat[0].data.statutorySummary.tds?.challan_due_date,
        },
      });
    } else {
      setStatutorySummary(null);
    }

    // Roll up anomalies
    const allAnomalies = ok.flatMap(({ data, company }) => (data.anomalies || []).map(a => ({ ...a, title: `${company.name}: ${a.title}` })));
    setAnomalies(allAnomalies);

    // Roll up cashflow - summed from each company's own forecast, never re-estimated here.
    const withCash = ok.filter(({ data }) => data.cashflowForecast);
    if (withCash.length) {
      const sumCash = (key) => round2(withCash.reduce((acc, { data }) => acc + (data.cashflowForecast[key] || 0), 0));
      const burns = withCash.map(({ data }) => data.cashflowForecast.average_monthly_expense);
      const burnKnown = burns.every((b) => typeof b === 'number');
      const combinedCash = sumCash('current_cash');
      const totalBurn = burnKnown ? burns.reduce((a, b) => a + b, 0) : null;
      const runway = totalBurn && totalBurn > 0 ? round2(Math.max(combinedCash, 0) / totalBurn) : null;
      const chartLen = withCash[0].data.cashflowForecast.chart?.length || 0;
      setCashflowForecast({
        partial: withCash.length < ok.length,
        current_cash: combinedCash,
        average_monthly_expense: totalBurn,
        runway_months: runway,
        runway_status: runway === null ? 'Not enough expense history' : (runway >= 6 ? 'Comfortable' : (runway >= 3 ? 'Manageable' : 'Tight')),
        forecast_30d: sumCash('forecast_30d'),
        forecast_60d: sumCash('forecast_60d'),
        forecast_90d: sumCash('forecast_90d'),
        assumptions: withCash[0].data.cashflowForecast.assumptions,
        chart: Array.from({ length: chartLen }, (_, i) => ({
          period: withCash[0].data.cashflowForecast.chart[i].period,
          cash: round2(withCash.reduce((acc, { data }) => acc + (data.cashflowForecast.chart[i]?.cash || 0), 0)),
          inflow: round2(withCash.reduce((acc, { data }) => acc + (data.cashflowForecast.chart[i]?.inflow || 0), 0)),
          outflow: round2(withCash.reduce((acc, { data }) => acc + (data.cashflowForecast.chart[i]?.outflow || 0), 0)),
        })),
      });
    } else {
      setCashflowForecast(null);
    }
    setAiAvailability({
      health: scored.length > 0,
      statutory: withStat.length > 0,
      anomalies: ok.some(({ data }) => data.aiAvailability?.anomalies !== false),
      cashflow: withCash.length > 0,
    });

    const combinedInsights = [{
      type: combinedMismatches.length ? 'warning' : 'success',
      category: 'Combined View',
      title: `Combined figures across ${ok.length} of ${companyList.length} companies`,
      text: combinedMismatches.length
        ? `${combinedMismatches.length} integrity check${combinedMismatches.length === 1 ? '' : 's'} failed in at least one company — see the Autonomous Integrity Shield below.`
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
    let effectiveCompanyId;
    try {
      effectiveCompanyId = resolveAuthorizedCompanyId(companyId);
    } catch (error) {
      toast.error(error?.message || 'No verified company is available for Finix verification.');
      return;
    }
    setVerifying(true);
    try {
      const v = await runVerifyAndFix(effectiveCompanyId, { force: true });
      setValidation(v);
      const verifiedAt = new Date();
      setLastVerifiedAt(verifiedAt);
      const cachedMetrics = _metricsCache_finix.get(effectiveCompanyId);
      if (cachedMetrics) {
        cachedMetrics.data = { ...cachedMetrics.data, validation: v, lastVerifiedAt: verifiedAt };
        ssWrite(SS_METRICS_PREFIX + effectiveCompanyId, {
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
      if (isPlatformOwnerUser && !list.length) {
        // Do not leave a previously selected/cached company active when the
        // live owner registry cannot be verified.
        setCompanyId('');
        setLoading(false);
        setVerifying(false);
        persistCompanySelection('');
        toast.error('Finix could not verify the Platform Owner company list. Please refresh and retry.');
        return;
      }
      if (list.length) {
        const stored = localStorage.getItem('accountingReports:lastCompanyId') || '';
        const canonicalOwnerCompany = isPlatformOwnerUser
          ? (list.find((c) => String(c.id || '') === ownerCompanyId) ||
             list.find((c) => c.is_platform_owner_workspace === true))
          : null;
        if (isPlatformOwnerUser && canonicalOwnerCompany) {
          initialCid = canonicalOwnerCompany.id;
        } else if (stored === ALL_COMPANIES_ID || (stored && list.some((c) => c.id === stored))) {
          initialCid = stored;
        } else {
          initialCid = list[0].id;
        }
      }
      setCompanyId(initialCid);
      if (initialCid === ALL_COMPANIES_ID) {
        fetchAggregateMetrics(list);
      } else if (initialCid) {
        fetchMetrics(initialCid);
      }
    })();
  }, [user?.id, user?.company_id, user?.company?.id]);

  const handleCompanyChange = (val) => {
    if (val === ALL_COMPANIES_ID) {
      setCompanyId(val);
      persistCompanySelection(val);
      fetchAggregateMetrics(companies);
      return;
    }
    try {
      const resolved = resolveAuthorizedCompanyId(val);
      setCompanyId(resolved);
      persistCompanySelection(resolved);
      fetchMetrics(resolved);
    } catch (error) {
      toast.error(error?.message || 'This company is not available to the current account.');
    }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!chatInput.trim() || chatLoading) return;

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

    let effectiveCompanyId;
    try {
      effectiveCompanyId = resolveAuthorizedCompanyId(companyId);
    } catch (error) {
      toast.error(error?.message || 'No verified company is available for Finix AI.');
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

    try {
      const res = await api.post('/finix/ai/ask', {
        question: userMsg.text,
        company_id: effectiveCompanyId
      });

      let reply = '';
      if (res.data?.profit !== undefined) {
        reply = `Financial summary for current period:\n• Income: ${fmtC(res.data.income)}\n• Expenses: ${fmtC(res.data.expenses)}\n• Net Profit: ${fmtC(res.data.profit)} (${((res.data.profit / (res.data.income || 1)) * 100).toFixed(1)}% margin)`;
      } else if (res.data?.receivables !== undefined) {
        reply = `Total customer receivables outstanding: ${fmtC(res.data.receivables)} across ${res.data.invoice_count} open invoices.`;
      } else if (res.data?.payables !== undefined) {
        reply = `Total supplier payables outstanding: ${fmtC(res.data.payables)} across ${res.data.invoice_count} vendor bills.`;
      } else if (res.data?.output_gst !== undefined) {
        reply = `GST summary:\n• Output GST: ${fmtC(res.data.output_gst)}\n• Input ITC: ${fmtC(res.data.input_gst)}\n• Net GST: ${fmtC(res.data.net_gst)} ${res.data.net_gst > 0 ? '(Payable)' : '(Credit carry-forward)'}`;
      } else if (res.data?.total_tds_deducted !== undefined) {
        reply = `TDS Deductions: Total ${fmtC(res.data.total_tds_deducted)} deducted this period. Next ITNS 281 Challan deposit deadline is ${res.data.challan_due}.`;
      } else if (res.data?.trial_balance_debits !== undefined) {
        reply = `Trial Balance Equilibrium:\n• Total Debits: ${fmtC(res.data.trial_balance_debits)}\n• Total Credits: ${fmtC(res.data.trial_balance_credits)}\n• Balanced: ${res.data.balanced ? 'Yes (Zero difference)' : 'No (Requires re-sync)'}`;
      } else {
        reply = res.data?.message || 'Finix scanned the ledger and verified your current balances.';
      }

      setChatMessages(prev => [...prev, {
        sender: 'ai',
        text: reply,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    } catch {
      setChatMessages(prev => [...prev, {
        sender: 'ai',
        text: 'Finix co-pilot encountered an error querying live ledger tables. Please retry shortly.',
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  const handlePostQuickVoucher = async (e) => {
    e.preventDefault();
    if (!companyId || companyId === ALL_COMPANIES_ID) {
      toast.error('Select a specific company first.');
      return;
    }
    let effectiveCompanyId;
    try {
      effectiveCompanyId = resolveAuthorizedCompanyId(companyId);
    } catch (error) {
      toast.error(error?.message || 'No verified company is available for Finix posting.');
      return;
    }
    const amt = parseFloat(voucherForm.amount);
    if (!amt || amt <= 0) {
      toast.error('Enter a valid amount greater than zero.');
      return;
    }

    setVoucherSubmitting(true);
    try {
      let lines = [];
      let defaultNarration = '';
      if (quickVoucherType === 'CONTRA') {
        if (!voucherForm.sourceAccount || !voucherForm.destAccount) {
          toast.error('Please select both source and destination accounts.');
          setVoucherSubmitting(false);
          return;
        }
        if (voucherForm.sourceAccount === voucherForm.destAccount) {
          toast.error('Source and destination accounts must be different.');
          setVoucherSubmitting(false);
          return;
        }
        lines = [
          { account_id: voucherForm.destAccount, debit: amt, credit: 0 },
          { account_id: voucherForm.sourceAccount, debit: 0, credit: amt },
        ];
        defaultNarration = voucherForm.narration || `Contra Transfer: ${fmtC(amt)} transferred between accounts`;
      } else {
        if (!voucherForm.debitAccount || !voucherForm.creditAccount) {
          toast.error('Please select both Debit and Credit accounts.');
          setVoucherSubmitting(false);
          return;
        }
        if (voucherForm.debitAccount === voucherForm.creditAccount) {
          toast.error('Debit and Credit accounts must be different.');
          setVoucherSubmitting(false);
          return;
        }
        lines = [
          { account_id: voucherForm.debitAccount, debit: amt, credit: 0 },
          { account_id: voucherForm.creditAccount, debit: 0, credit: amt },
        ];
        defaultNarration = voucherForm.narration || `Journal Entry: ${fmtC(amt)}`;
      }

      await createJournalEntry({
        company_id: effectiveCompanyId,
        entry_date: voucherForm.date,
        narration: defaultNarration,
        lines,
      });

      toast.success(`${quickVoucherType === 'CONTRA' ? 'Contra' : 'Journal'} voucher posted successfully!`);
      setShowQuickVoucherModal(false);
      setVoucherForm({
        sourceAccount: '',
        destAccount: '',
        debitAccount: '',
        creditAccount: '',
        amount: '',
        date: toLocalISODate(new Date()),
        narration: '',
      });
      // Refresh metrics
      fetchMetrics(effectiveCompanyId, { force: true });
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.detail || 'Failed to post voucher.');
    } finally {
      setVoucherSubmitting(false);
    }
  };

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const COLORS_CHART = ['#1FAF5A', '#FF6B6B', '#3B82F6', '#FF9F43'];

  return (
    <div className={`p-6 min-h-screen ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>

      {/* ── Branded Header Banner ── */}
      <div
        className="relative overflow-hidden rounded-3xl mb-6 shadow-lg"
        style={{ background: 'linear-gradient(115deg, #0A2E52 0%, #0D3B66 38%, #0F5C63 72%, #12806B 100%)' }}
      >
        <div
          className="pointer-events-none absolute -right-10 -top-16 w-64 h-64 rounded-full opacity-20"
          style={{ background: 'radial-gradient(circle, #5CCB5F 0%, transparent 70%)' }}
        />
        <div
          className="pointer-events-none absolute -left-16 -bottom-20 w-72 h-72 rounded-full opacity-10"
          style={{ background: 'radial-gradient(circle, #2B8CD1 0%, transparent 70%)' }}
        />

        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-5 px-6 py-5 md:px-8 md:py-6">
          <div className="flex items-center gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-tight text-white">
                  FIN<span style={{ background: 'linear-gradient(90deg, #5CCB5F, #7FE3C4)', WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' }}>IX</span>
                </h1>
                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-white/10 border border-white/20 text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                  <Sparkles className="w-3 h-3" /> Enterprise Financial Suite
                </span>
                {typeof healthScore?.score === 'number' && (
                  <button
                    onClick={() => setShowHealthModal(true)}
                    className="hidden sm:inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 text-xs font-bold transition"
                  >
                    <Activity className="w-3 h-3" /> Health: {healthScore.score}/100 ({healthScore.grade})
                  </button>
                )}
              </div>
              <p className="text-xs md:text-sm mt-1 text-slate-200/80 tracking-wide">
                Automate &middot; Analyze &middot; Ascend — Autonomous Indian Accounting, GST &amp; TDS Engine
              </p>
            </div>
          </div>

          {/* Controls: Company Select & Refresh */}
          <div className="flex items-center gap-3">
            <Building2 className="w-5 h-5 text-slate-200/70 hidden sm:block" />
            <Select value={companyId} onValueChange={handleCompanyChange}>
              <SelectTrigger className="h-11 w-[220px] md:w-[260px] rounded-2xl border border-white/20 bg-white/10 backdrop-blur-sm text-white placeholder:text-white/60 [&>span]:text-white">
                <SelectValue placeholder="Select Company" />
              </SelectTrigger>
              <SelectContent>
                {companies.length > 1 && (
                  <SelectItem value={ALL_COMPANIES_ID}>
                    <span className="flex items-center gap-1.5 font-bold">
                      <Layers className="w-3.5 h-3.5" /> All Companies (Consolidated)
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

      {/* ── Quick Voucher & Workflow Action Bar ── */}
      <div className={`p-3 rounded-2xl mb-6 border shadow-sm flex items-center justify-between gap-3 overflow-x-auto ${isDark ? 'bg-slate-800/80 border-slate-700/80' : 'bg-white border-slate-200/80'}`}>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400 px-2 flex items-center gap-1">
            <PlusCircle className="w-3.5 h-3.5 text-emerald-500" /> Quick Vouchers:
          </span>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate('/invoicing')}
            className="h-8 rounded-xl text-xs font-semibold gap-1.5 hover:border-emerald-500"
          >
            <TrendingUp className="w-3.5 h-3.5 text-emerald-600" /> Sales Invoice
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate('/purchase')}
            className="h-8 rounded-xl text-xs font-semibold gap-1.5 hover:border-purple-500"
          >
            <TrendingDown className="w-3.5 h-3.5 text-purple-600" /> Purchase Bill
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQuickVoucherType('CONTRA');
              setShowQuickVoucherModal(true);
            }}
            className="h-8 rounded-xl text-xs font-semibold gap-1.5 hover:border-blue-500"
          >
            <Landmark className="w-3.5 h-3.5 text-blue-600" /> Contra Transfer
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setQuickVoucherType('JOURNAL');
              setShowQuickVoucherModal(true);
            }}
            className="h-8 rounded-xl text-xs font-semibold gap-1.5 hover:border-amber-500"
          >
            <Scale className="w-3.5 h-3.5 text-amber-600" /> Journal Entry
          </Button>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate('/accounting-reports')}
            className="h-8 rounded-xl text-xs font-medium gap-1 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
          >
            <FileText className="w-3.5 h-3.5" /> Reports <ChevronRight className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {!loading && companyId && companyId !== ALL_COMPANIES_ID && (
        <FinixAICommandCenter companyId={companyId} isDark={isDark} />
      )}

      {companyId === ALL_COMPANIES_ID && !loading && (
        <div className={`mb-6 flex items-center gap-2 text-xs font-semibold px-4 py-2.5 rounded-2xl border ${isDark ? 'bg-blue-500/10 border-blue-500/20 text-blue-300' : 'bg-blue-50 border-blue-100 text-blue-700'}`}>
          <Layers className="w-3.5 h-3.5 shrink-0" />
          Showing combined consolidated figures across all {companies.length} companies. Switch to an individual company for ledger posting or direct AI chat.
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-24">
          <ContentLoader />
          <p className="text-sm text-slate-400 mt-4 animate-pulse">Syncing general ledgers, GST schedules &amp; TDS liabilities...</p>
        </div>
      ) : !companyId ? (
        <div className="text-center py-24 rounded-3xl border border-dashed border-slate-300 dark:border-slate-700">
          <HelpCircle className="w-12 h-12 text-slate-400 mx-auto mb-4" />
          <h3 className="text-lg font-bold">No Company Selected</h3>
          <p className="text-sm text-slate-500 mt-1">Please select a company to initialize the Finix Dashboard.</p>
        </div>
      ) : (
        <div className="space-y-8">

          {/* ── KPI Cards ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 items-stretch">
            
            {/* Card 1: Revenue */}
            <div
              className={`min-h-[110px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-emerald-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(16,185,129,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #ecfdf5 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold uppercase tracking-wider text-emerald-500">Sales &amp; Revenue</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(16,185,129,0.3), rgba(16,185,129,0.08))' : 'linear-gradient(135deg, #a7f3d0, #ecfdf5)' }}>
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(revenue)}</h2>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span className="font-semibold text-emerald-500">Matched with Sales ledgers</span>
                <span className="font-mono text-slate-400">Net Profit: {fmtC(netProfit)}</span>
              </div>
            </div>

            {/* Card 2: Accounts Receivable */}
            <div
              className={`min-h-[110px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-amber-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(245,158,11,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #fffbeb 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold uppercase tracking-wider text-amber-500">Accounts Receivable</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(245,158,11,0.3), rgba(245,158,11,0.08))' : 'linear-gradient(135deg, #fde68a, #fffbeb)' }}>
                  <Receipt className="w-4 h-4 text-amber-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(receivables)}</h2>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span className="font-semibold text-amber-500">Total Customer Due</span>
                <Link to="/outstanding-report" className="text-amber-600 dark:text-amber-400 hover:underline">Aging Report &rarr;</Link>
              </div>
            </div>

            {/* Card 3: Cash & Bank */}
            <div
              className={`min-h-[110px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-blue-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(59,130,246,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #eff6ff 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold uppercase tracking-wider text-blue-500">Bank &amp; Cash Balance</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(59,130,246,0.3), rgba(59,130,246,0.08))' : 'linear-gradient(135deg, #bfdbfe, #eff6ff)' }}>
                  <Landmark className="w-4 h-4 text-blue-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(cashAndBank)}</h2>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span className="font-semibold text-blue-500">Real-time Liquid Reserves</span>
                <Link to="/bank-accounts" className="text-blue-600 dark:text-blue-400 hover:underline">Reconcile &rarr;</Link>
              </div>
            </div>

            {/* Card 4: Accounts Payable */}
            <div
              className={`min-h-[110px] flex flex-col justify-between p-4 rounded-2xl shadow-sm border transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 overflow-hidden ${isDark ? 'border-slate-700' : 'border-purple-100/70'}`}
              style={{ background: isDark ? 'linear-gradient(150deg, rgba(168,85,247,0.12) 0%, rgba(30,41,59,0.9) 55%)' : 'linear-gradient(150deg, #faf5ff 0%, #ffffff 60%)' }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold uppercase tracking-wider text-purple-500">Accounts Payable</span>
                <div className="p-1.5 rounded-lg shrink-0" style={{ background: isDark ? 'linear-gradient(135deg, rgba(168,85,247,0.3), rgba(168,85,247,0.08))' : 'linear-gradient(135deg, #e9d5ff, #faf5ff)' }}>
                  <TrendingDown className="w-4 h-4 text-purple-600" />
                </div>
              </div>
              <h2 className="text-xl font-extrabold font-mono tracking-tight break-all">{fmtC(payables)}</h2>
              <div className="flex items-center justify-between text-[11px] text-slate-400 mt-1">
                <span className="font-semibold text-purple-500">Supplier Dues</span>
                <Link to="/purchase" className="text-purple-600 dark:text-purple-400 hover:underline">Pay Bills &rarr;</Link>
              </div>
            </div>

          </div>

          {/* ── Financial Health Score & Statutory Compliance Cockpit ── */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
            
            {/* Health Score Card */}
            <div className={`p-6 rounded-3xl shadow-sm border flex flex-col justify-between ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-extrabold text-sm uppercase tracking-wider flex items-center gap-2 text-slate-700 dark:text-slate-200">
                    <Activity className="w-4 h-4 text-emerald-500" />
                    Financial Health Score
                  </h3>
                  <span className={`px-2.5 py-0.5 rounded-full text-xs font-extrabold ${healthScore?.grade === 'A+' || healthScore?.grade === 'A' ? 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/30' : 'bg-amber-500/10 text-amber-600 border border-amber-500/30'}`}>
                    Grade {healthScore?.grade ?? '—'}
                  </span>
                </div>

                {typeof healthScore?.score === 'number' ? (
                  <>
                    <div className="flex items-baseline gap-3 my-2">
                      <span className={`text-4xl font-extrabold font-mono ${healthScore.score >= 80 ? 'text-emerald-500' : 'text-amber-500'}`}>{healthScore.score}</span>
                      <span className="text-sm text-slate-400">/ 100</span>
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-md ml-auto ${healthScore.trial_balance_balanced ? 'text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40' : 'text-red-600 bg-red-50 dark:bg-red-950/40'}`}>
                        {healthScore.trial_balance_balanced ? 'Trial Balance Balanced' : 'Trial Balance Out'}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Calculated from the general ledger
                      {typeof healthScore.current_ratio === 'number' ? ` · current ratio ${healthScore.current_ratio}x` : ''}
                      {healthScore.partial ? ` · ${healthScore.scored_companies} of ${healthScore.total_companies} companies scored` : ''}.
                    </p>
                    {(healthScore.issues || []).length > 0 && (
                      <div className="mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-700 dark:text-amber-300">
                        <strong>{healthScore.issues.length} data issue{healthScore.issues.length === 1 ? '' : 's'}</strong>
                        {healthScore.capped ? ' — score capped until fixed' : ''}: {healthScore.issues[0].message}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="my-4 text-xs text-slate-500 dark:text-slate-400">
                    {healthScore?.status === 'NO_DATA'
                      ? (healthScore.message || 'No journal entries yet, so there is nothing to score.')
                      : (aiAvailability.health ? 'No health score is available for this selection.' : 'Health score is unavailable right now (the server did not return it).')}
                    {!aiAvailability.health && (
                      <button className="ml-2 underline font-semibold" onClick={() => companyId === ALL_COMPANIES_ID ? fetchAggregateMetrics(companies, { force: true }) : fetchMetrics(companyId, { force: true })}>Retry</button>
                    )}
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-100 dark:border-slate-700/80 mt-4 flex items-center justify-between">
                <div className="text-[11px] text-slate-400">
                  Working Capital: <strong className="text-slate-700 dark:text-slate-200">{fmtC(typeof healthScore?.working_capital === 'number' ? healthScore.working_capital : ((cashAndBank + receivables) - payables))}</strong>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowHealthModal(true)}
                  className="h-7 text-xs font-semibold text-emerald-600 dark:text-emerald-400 hover:text-emerald-700"
                >
                  Diagnostic Details &rarr;
                </Button>
              </div>
            </div>

            {/* Indian GST Compliance Cockpit */}
            <div className={`p-6 rounded-3xl shadow-sm border flex flex-col justify-between ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-extrabold text-sm uppercase tracking-wider flex items-center gap-2 text-slate-700 dark:text-slate-200">
                    <FileCheck className="w-4 h-4 text-blue-500" />
                    GST Command (GSTR-1 / 3B)
                  </h3>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-600 border border-blue-500/20">
                    {statutorySummary?.gst?.period?.gstr3b_due ? `GSTR-3B due ${statutorySummary.gst.period.gstr3b_due}` : 'Due: 20th of next month'}
                  </span>
                </div>

                {!statutorySummary && (
                  <div className="my-3 text-xs text-slate-500 dark:text-slate-400">
                    GST figures are unavailable right now.
                    <button className="ml-2 underline font-semibold" onClick={() => companyId === ALL_COMPANIES_ID ? fetchAggregateMetrics(companies, { force: true }) : fetchMetrics(companyId, { force: true })}>Retry</button>
                  </div>
                )}
                {statutorySummary && (<>
                <div className="text-[10px] text-slate-400 -mb-1">
                  {statutorySummary.gst?.period?.period ? `Return period ${statutorySummary.gst.period.period} · from the ledger` : 'From the ledger'}
                </div>
                <div className="grid grid-cols-2 gap-3 my-2">
                  <div className={`p-2.5 rounded-xl border ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                    <span className="text-[10px] uppercase font-bold text-slate-400">Output GST (Liab)</span>
                    <div className="text-sm font-extrabold font-mono mt-0.5 text-slate-800 dark:text-slate-100">
                      {fmtC(statutorySummary?.gst?.total_output_liability || 0)}
                    </div>
                  </div>
                  <div className={`p-2.5 rounded-xl border ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                    <span className="text-[10px] uppercase font-bold text-slate-400">Input ITC (Credit)</span>
                    <div className="text-sm font-extrabold font-mono mt-0.5 text-emerald-600 dark:text-emerald-400">
                      {fmtC(statutorySummary?.gst?.total_input_itc || 0)}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between mt-2 text-xs">
                  <span className="text-slate-500">Net Tax Payable:</span>
                  <span className="font-bold font-mono text-sm text-slate-800 dark:text-slate-100">
                    {fmtC(statutorySummary?.gst?.net_payable || 0)}
                  </span>
                </div>
                </>)}
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-700/80 mt-3 flex items-center justify-between text-xs">
                {(() => {
                  const chk = statutorySummary?.gst?.document_check;
                  if (!chk) return <span className="text-[11px] text-slate-400">Filing status is not tracked here</span>;
                  const diff = Math.abs(chk.output_gst_gl_vs_documents || 0) + Math.abs(chk.input_gst_gl_vs_documents || 0);
                  return diff < 1
                    ? <span className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> Ledger agrees with invoices</span>
                    : <span className="text-[11px] text-amber-600 font-semibold flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Ledger differs from invoices by {fmtC(diff)}</span>;
                })()}
                <Link to="/gst-portal-sync" className="text-blue-600 dark:text-blue-400 hover:underline text-[11px] font-semibold">
                  GST Portal Sync &rarr;
                </Link>
              </div>
            </div>

            {/* Indian TDS Compliance Cockpit */}
            <div className={`p-6 rounded-3xl shadow-sm border flex flex-col justify-between ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-extrabold text-sm uppercase tracking-wider flex items-center gap-2 text-slate-700 dark:text-slate-200">
                    <ShieldCheck className="w-4 h-4 text-purple-500" />
                    TDS Deducted (Ledger)
                  </h3>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-600 border border-purple-500/20">
                    {statutorySummary?.tds?.challan_due_date ? `Challan due ${statutorySummary.tds.challan_due_date}` : 'Challan: 7th of next month'}
                  </span>
                </div>

                <div className="my-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-slate-500">Deducted this FY (ledger):</span>
                    <span className="text-xl font-extrabold font-mono text-purple-600 dark:text-purple-400">
                      {fmtC(statutorySummary?.tds?.total_deducted || 0)}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                    <div className={`p-1.5 rounded-lg border text-[10px] ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                      <div className="text-slate-400 font-semibold">194C (Cont)</div>
                      <div className="font-bold mt-0.5">{fmtC(statutorySummary?.tds?.sections?.['194C_contractor'] || 0)}</div>
                    </div>
                    <div className={`p-1.5 rounded-lg border text-[10px] ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                      <div className="text-slate-400 font-semibold">194J (Prof)</div>
                      <div className="font-bold mt-0.5">{fmtC(statutorySummary?.tds?.sections?.['194J_professional'] || 0)}</div>
                    </div>
                    <div className={`p-1.5 rounded-lg border text-[10px] ${isDark ? 'bg-slate-900/50 border-slate-700' : 'bg-slate-50 border-slate-200/60'}`}>
                      <div className="text-slate-400 font-semibold">194I (Rent)</div>
                      <div className="font-bold mt-0.5">{fmtC(statutorySummary?.tds?.sections?.['194I_rent'] || 0)}</div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-700/80 mt-3 flex items-center justify-between text-xs">
                <span className="text-[11px] text-slate-500 flex items-center gap-1">
                  <Clock className="w-3.5 h-3.5" /> {statutorySummary?.tds ? `TDS payable balance ${fmtC(statutorySummary.tds.tds_payable_balance || 0)}` : 'TDS figures unavailable'}
                </span>
                <Link to="/tds-tcs" className="text-purple-600 dark:text-purple-400 hover:underline text-[11px] font-semibold">
                  TDS Register &rarr;
                </Link>
              </div>
            </div>

          </div>

          {/* ── Cash Flow Forecast & Runway Engine ── */}
          {!cashflowForecast && !aiAvailability.cashflow && (
            <div className={`p-4 rounded-3xl border text-xs ${isDark ? 'bg-slate-800/60 border-slate-700/80 text-slate-400' : 'bg-white border-slate-100 text-slate-500'}`}>
              Cash-flow forecast is unavailable right now.
              <button className="ml-2 underline font-semibold" onClick={() => companyId === ALL_COMPANIES_ID ? fetchAggregateMetrics(companies, { force: true }) : fetchMetrics(companyId, { force: true })}>Retry</button>
            </div>
          )}
          {cashflowForecast && (
            <div className={`p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
                <div>
                  <h3 className="font-extrabold text-lg flex items-center gap-2">
                    <Wallet className="w-5 h-5 text-emerald-500" />
                    Cash Flow Trajectory &amp; Runway Forecast
                  </h3>
                  <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Projected 30-60-90 day cash position from open receivables (collection-rate assumptions applied) and payables due, starting from the ledger cash balance
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <div className={`px-3 py-1.5 rounded-2xl border flex items-center gap-2 ${isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-emerald-50 border-emerald-100'}`}>
                    <span className="text-xs text-slate-500 dark:text-slate-400">Runway:</span>
                    <strong className="text-sm font-mono text-emerald-600 dark:text-emerald-400">
                      {typeof cashflowForecast.runway_months === 'number' ? `${cashflowForecast.runway_months} Months (${cashflowForecast.runway_status})` : cashflowForecast.runway_status}
                    </strong>
                  </div>
                  <Link to="/cash-flow">
                    <Button size="sm" variant="outline" className="h-8 rounded-xl text-xs font-semibold">
                      Full Cash Flow &rarr;
                    </Button>
                  </Link>
                </div>
              </div>

              <div className="h-56 w-full font-mono text-xs">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={cashflowForecast.chart} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorCash" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#E2E8F0'} />
                    <XAxis dataKey="period" stroke={isDark ? '#94A3B8' : '#64748B'} />
                    <YAxis stroke={isDark ? '#94A3B8' : '#64748B'} />
                    <Tooltip
                      contentStyle={{ backgroundColor: isDark ? '#1E293B' : '#FFFFFF', border: 'none', borderRadius: '12px' }}
                      formatter={(value) => fmtC(value)}
                    />
                    <Area type="monotone" dataKey="cash" name="Projected Cash Balance" stroke="#0ea5e9" fillOpacity={1} fill="url(#colorCash)" strokeWidth={2.5} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 pt-4 border-t border-slate-100 dark:border-slate-700 text-xs">
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold">Current Liquid Balance</span>
                  <div className="font-bold font-mono text-sm mt-0.5">{fmtC(cashflowForecast.current_cash)}</div>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold">+30 Days Projected</span>
                  <div className="font-bold font-mono text-sm mt-0.5 text-blue-500">{fmtC(cashflowForecast.forecast_30d)}</div>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold">+60 Days Projected</span>
                  <div className="font-bold font-mono text-sm mt-0.5 text-emerald-500">{fmtC(cashflowForecast.forecast_60d)}</div>
                </div>
                <div>
                  <span className="text-slate-400 text-[10px] uppercase font-bold">+90 Days Projected</span>
                  <div className="font-bold font-mono text-sm mt-0.5 text-purple-500">{fmtC(cashflowForecast.forecast_90d)}</div>
                </div>
              </div>
            </div>
          )}

          {/* ── Revenue vs Expenses Trend + Finix AI Accountant ── */}
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
                  "Audit GST output liabilities",
                  "TDS deductions summary",
                  "Trial balance health"
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

          {/* ── Row 3: Operating Cost Distribution + Autonomous Integrity Shield + Auditing Radar ── */}
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

            {/* AI Auditing Summary */}
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

            {/* Live Accounting Anomalies & Insights */}
            <div className={`h-full flex flex-col p-6 rounded-3xl shadow-sm border ${isDark ? 'bg-slate-800/60 border-slate-700/80' : 'bg-white border-slate-100'}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-extrabold text-sm flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-emerald-500" />
                  Live Auditing &amp; Anomaly Radar
                </h3>
                {anomalies.length > 0 && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 border border-amber-500/30">
                    {anomalies.length} Flagged
                  </span>
                )}
              </div>

              <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                {anomalies.map((ano, i) => (
                  <div key={i} className={`p-3.5 rounded-2xl border ${ano.severity === 'high' ? 'bg-red-500/5 border-red-500/20' : 'bg-amber-500/5 border-amber-500/20'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className={`w-3.5 h-3.5 shrink-0 ${ano.severity === 'high' ? 'text-red-500' : 'text-amber-500'}`} />
                      <span className="text-[10px] font-extrabold uppercase tracking-wider text-amber-600">
                        {ano.type}
                      </span>
                    </div>
                    <h4 className="text-xs font-bold">{ano.title}</h4>
                    <p className="text-[11px] text-slate-400 mt-0.5">{ano.description}</p>
                    {ano.action && (
                      <p className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold mt-1">
                        &bull; {ano.action}
                      </p>
                    )}
                  </div>
                ))}

                {insights.map((ins, i) => (
                  <div key={`ins-${i}`} className={`p-3.5 rounded-2xl border ${ins.type === 'warning' ? 'bg-amber-500/5 border-amber-500/20' : ins.type === 'success' ? 'bg-emerald-500/5 border-emerald-500/20' : 'bg-blue-500/5 border-blue-500/20'}`}>
                    <div className="flex items-center gap-2 mb-1">
                      {ins.type === 'warning' ? (
                        <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      ) : (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      )}
                      <span className={`text-[10px] font-extrabold uppercase tracking-wider ${ins.type === 'warning' ? 'text-amber-500' : ins.type === 'success' ? 'text-emerald-500' : 'text-blue-500'}`}>
                        {ins.category}
                      </span>
                    </div>
                    <h4 className="text-xs font-bold leading-tight">{ins.title}</h4>
                    <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{ins.text}</p>
                  </div>
                ))}

                {anomalies.length === 0 && insights.length === 0 && (
                  <p className="text-xs text-slate-400 text-center py-6">All ledger balances verified with zero warnings.</p>
                )}
              </div>
            </div>

          </div>

        </div>
      )}

      {/* ── Financial Health Diagnostic Dialog ── */}
      <Dialog open={showHealthModal} onOpenChange={setShowHealthModal}>
        <DialogContent className={`max-w-lg rounded-3xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white'}`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-xl font-bold">
              <Activity className="w-5 h-5 text-emerald-500" />
              Financial Health Diagnostics
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              Calculated from the general ledger; the score is capped while data-integrity issues remain.
            </DialogDescription>
          </DialogHeader>

          {typeof healthScore?.score === 'number' && (
            <div className="space-y-4 my-2">
              <div className="flex items-center justify-between p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/20">
                <div>
                  <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Composite Health Index</span>
                  <div className="text-2xl font-extrabold text-emerald-600 font-mono mt-0.5">
                    {healthScore.score} / 100 ({healthScore.grade})
                  </div>
                </div>
                <div className="text-right text-xs">
                  <div className="text-slate-400">Current Ratio: <strong>{typeof healthScore.current_ratio === 'number' ? `${healthScore.current_ratio}x` : 'n/a'}</strong></div>
                  <div className="text-slate-400">Net Margin: <strong>{typeof healthScore.profit_margin === 'number' ? `${healthScore.profit_margin}%` : 'n/a'}</strong></div>
                </div>
              </div>

              {(healthScore.issues || []).length > 0 && (
                <div className="space-y-1.5 text-xs">
                  <div className="font-bold text-amber-600">Data issues{healthScore.capped ? ' (score capped until fixed)' : ''}</div>
                  {healthScore.issues.map((issue, i) => (
                    <div key={i} className="p-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 text-[11px] text-amber-800 dark:text-amber-200">
                      {issue.message}
                    </div>
                  ))}
                </div>
              )}

              <div className="space-y-2 text-xs">
                {Object.entries(healthScore.breakdown || {}).map(([key, item]) => (
                  <div key={key} className={`p-3 rounded-xl border flex items-center justify-between ${isDark ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                    <div>
                      <div className="font-bold capitalize">{key.replace(/_/g, ' ')}</div>
                      <div className="text-[11px] text-slate-400 mt-0.5">{item.status}</div>
                    </div>
                    <div className="text-right font-mono font-bold text-emerald-600 dark:text-emerald-400">
                      {item.score} / {item.max} pts
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setShowHealthModal(false)} className="rounded-xl bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Quick Voucher Creation Dialog ── */}
      <Dialog open={showQuickVoucherModal} onOpenChange={setShowQuickVoucherModal}>
        <DialogContent className={`max-w-md rounded-3xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white'}`}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-lg font-bold">
              {quickVoucherType === 'CONTRA' ? (
                <><Landmark className="w-5 h-5 text-blue-500" /> New Contra Voucher (Cash / Bank)</>
              ) : (
                <><Scale className="w-5 h-5 text-amber-500" /> New Journal Voucher</>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs text-slate-400">
              {quickVoucherType === 'CONTRA'
                ? 'Record internal fund transfers between Bank accounts or Cash in Hand.'
                : 'Post balanced double-entry adjustments directly into the General Ledger.'}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handlePostQuickVoucher} className="space-y-3.5 my-2 text-xs">
            {quickVoucherType === 'CONTRA' ? (
              <>
                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Transfer From (Credit)</label>
                  <select
                    value={voucherForm.sourceAccount}
                    onChange={(e) => setVoucherForm({ ...voucherForm, sourceAccount: e.target.value })}
                    className={`w-full p-2.5 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                    required
                  >
                    <option value="">Select Account</option>
                    {accountsList
                      .filter(a => ['1000', '1001', '1002', '1003', '1010'].includes(a.code) || a.name?.toLowerCase().includes('bank') || a.name?.toLowerCase().includes('cash'))
                      .map(a => (
                        <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Transfer To (Debit)</label>
                  <select
                    value={voucherForm.destAccount}
                    onChange={(e) => setVoucherForm({ ...voucherForm, destAccount: e.target.value })}
                    className={`w-full p-2.5 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                    required
                  >
                    <option value="">Select Account</option>
                    {accountsList
                      .filter(a => ['1000', '1001', '1002', '1003', '1010'].includes(a.code) || a.name?.toLowerCase().includes('bank') || a.name?.toLowerCase().includes('cash'))
                      .map(a => (
                        <option key={a.id} value={a.id}>{a.code} - {a.name}</option>
                      ))}
                  </select>
                </div>
              </>
            ) : (
              <>
                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Debit Account</label>
                  <select
                    value={voucherForm.debitAccount}
                    onChange={(e) => setVoucherForm({ ...voucherForm, debitAccount: e.target.value })}
                    className={`w-full p-2.5 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                    required
                  >
                    <option value="">Select Debit Account</option>
                    {accountsList.map(a => (
                      <option key={a.id} value={a.id}>{a.code} - {a.name} ({a.type})</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-semibold">Credit Account</label>
                  <select
                    value={voucherForm.creditAccount}
                    onChange={(e) => setVoucherForm({ ...voucherForm, creditAccount: e.target.value })}
                    className={`w-full p-2.5 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                    required
                  >
                    <option value="">Select Credit Account</option>
                    {accountsList.map(a => (
                      <option key={a.id} value={a.id}>{a.code} - {a.name} ({a.type})</option>
                    ))}
                  </select>
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1 font-semibold">Amount (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  placeholder="0.00"
                  value={voucherForm.amount}
                  onChange={(e) => setVoucherForm({ ...voucherForm, amount: e.target.value })}
                  className={`w-full p-2.5 rounded-xl border font-mono font-bold ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                  required
                />
              </div>
              <div>
                <label className="block text-slate-400 mb-1 font-semibold">Voucher Date</label>
                <input
                  type="date"
                  value={voucherForm.date}
                  onChange={(e) => setVoucherForm({ ...voucherForm, date: e.target.value })}
                  className={`w-full p-2.5 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-slate-400 mb-1 font-semibold">Narration</label>
              <input
                type="text"
                placeholder="Brief description of the transaction"
                value={voucherForm.narration}
                onChange={(e) => setVoucherForm({ ...voucherForm, narration: e.target.value })}
                className={`w-full p-2.5 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200'}`}
              />
            </div>

            <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center justify-between">
              <span>Balanced Double Entry:</span>
              <strong className="font-mono">Dr {fmtC(voucherForm.amount || 0)} = Cr {fmtC(voucherForm.amount || 0)}</strong>
            </div>

            <DialogFooter className="mt-4">
              <Button type="button" variant="outline" onClick={() => setShowQuickVoucherModal(false)} className="rounded-xl">
                Cancel
              </Button>
              <Button type="submit" disabled={voucherSubmitting} className="rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">
                {voucherSubmitting ? 'Posting...' : 'Post to General Ledger'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

    </div>
  );
}
