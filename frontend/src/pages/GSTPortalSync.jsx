import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Landmark, RefreshCw, AlertTriangle, CheckCircle2, ShieldCheck,
  Search, Copy, Check, ExternalLink, Settings, Building2,
  FileSpreadsheet, Upload, Download, Sparkles, Database, Layers,
  MapPin, Hash, UserCheck, ArrowRight, Play, Wallet, Wifi, Plus, Trash2, Eye, Clock
} from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import {
  lookupGSTIN,
  bulkVerifyGSTINs,
  decodeGSTIN,
  SAMPLE_GSTINS,
} from '@/lib/gstApi';

const COLORS = {
  deepBlue: '#0D3B66',
  mediumBlue: '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber: '#F59E0B',
  coral: '#FF6B6B',
};

const fmtC = (n) => (n === null || n === undefined) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// The company being worked on is the one chosen in Finix; an empty value means the signed-in user's own.
const activeCompanyId = () => {
  try { return localStorage.getItem('accountingReports:lastCompanyId') || ''; } catch { return ''; }
};

const fmtWhen = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};

// What each stored status means to the reader. Only a status an outside service confirmed is shown as
// the taxpayer's real status; a well-formed number nobody has confirmed is labelled for what it is.
const STATUS_STYLE = {
  Active: { cls: 'bg-emerald-600 text-white', note: 'Confirmed active' },
  'Format valid': { cls: 'bg-amber-100 text-amber-800 border border-amber-300', note: 'The number is well-formed, but no GST service confirmed it. Press Update to check again.' },
  'Not checked yet': { cls: 'bg-slate-100 text-slate-600 border border-slate-300', note: 'Not checked yet. Press Update to check it.' },
  'Invalid GSTIN': { cls: 'bg-rose-100 text-rose-700 border border-rose-300', note: 'This is not a valid GSTIN.' },
};
const statusStyle = (status) => STATUS_STYLE[status] || { cls: 'bg-rose-100 text-rose-700 border border-rose-300', note: status };

function MetricCard({ label, value, icon: Icon, color, isDark, sub }) {
  return (
    <div className={`rounded-xl border p-4 shadow-sm transition-all ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
        <div className="h-8 w-8 rounded-lg flex items-center justify-center" style={{ background: `${color}20` }}>
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
      </div>
      <p className={`text-2xl font-bold font-mono ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{value}</p>
      {sub && <p className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{sub}</p>}
    </div>
  );
}

function GSTPortalSyncInner() {
  const isDark = useDark();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeTab, setActiveTab] = useState('lookup');

  // Live metrics and snapshots
  const [metrics, setMetrics] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [riskRows, setRiskRows] = useState([]);

  // The company's saved GSTINs and the status stored for each
  const [gstins, setGstins] = useState([]);
  const [canManage, setCanManage] = useState(true);
  const [addValue, setAddValue] = useState('');
  const [busy, setBusy] = useState(''); // gstin being updated/synced/removed, 'add' or 'all'

  // Search state
  const [searchGstin, setSearchGstin] = useState('');
  const [taxpayerResult, setTaxpayerResult] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);

  // Bulk state
  const [bulkInput, setBulkInput] = useState('');
  const [bulkResults, setBulkResults] = useState(null);
  const [bulkLoading, setBulkLoading] = useState(false);

  // Config modal
  const [configOpen, setConfigOpen] = useState(false);
  const [configData, setConfigData] = useState({
    provider: 'builtin_free',
    api_key: '',
    endpoint_url: '',
  });
  const [savingConfig, setSavingConfig] = useState(false);

  // Reads saved data only. Nothing here contacts an outside GST service.
  const fetchAll = async () => {
    setLoading(true);
    const params = { company_id: activeCompanyId() };
    try {
      const [m, s, r, c, g] = await Promise.allSettled([
        api.get('/gst-portal/dashboard-metrics', { params, cache: false }),
        api.get('/gst-portal/snapshot', { params, cache: false }),
        api.get('/gst-portal/audit-risk', { params, cache: false }),
        api.get('/gst/config'),
        api.get('/gst-portal/gstins', { params, cache: false }),
      ]);
      setMetrics(m.status === 'fulfilled' ? m.value.data : null);
      setSnapshots(s.status === 'fulfilled' ? s.value.data : []);
      setRiskRows(r.status === 'fulfilled' ? r.value.data : []);
      if (c.status === 'fulfilled' && c.value.data?.config) {
        setConfigData(c.value.data.config);
      }
      if (g.status === 'fulfilled') {
        setGstins(g.value.data?.gstins || []);
        setCanManage(g.value.data?.can_manage !== false);
      } else {
        setGstins([]);
        const detail = g.reason?.response?.data?.detail;
        if (detail) toast.error(detail, { id: 'gst-list-error' });
      }
    } catch {
      toast.error('Failed to load GST portal data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
  }, []);

  const replaceEntry = (entry) =>
    setGstins((list) => {
      const rest = list.filter((e) => e.gstin !== entry.gstin);
      return [...rest, entry].sort((a, b) => Number(b.saved) - Number(a.saved) || a.gstin.localeCompare(b.gstin));
    });

  const errorText = (err, fallback) => err?.response?.data?.detail || err?.message || fallback;

  const handleAdd = async (value) => {
    const g = String(value ?? addValue).trim().toUpperCase();
    if (g.length !== 15) { toast.error('A GSTIN has 15 characters.'); return; }
    setBusy('add');
    try {
      const { data } = await api.post('/gst-portal/gstins', { company_id: activeCompanyId(), gstin: g });
      replaceEntry(data);
      setAddValue('');
      toast.success(`${g} added: ${data.status}`);
    } catch (err) {
      toast.error(errorText(err, 'Could not add this GSTIN'));
    } finally {
      setBusy('');
    }
  };

  const handleUpdate = async (g) => {
    setBusy(g);
    try {
      const { data } = await api.post(`/gst-portal/gstins/${encodeURIComponent(g)}/refresh`, null, { params: { company_id: activeCompanyId() } });
      replaceEntry(data);
      toast.success(`${g} updated: ${data.status}`);
    } catch (err) {
      toast.error(errorText(err, 'Could not update this GSTIN'));
    } finally {
      setBusy('');
    }
  };

  const handleUpdateAll = async () => {
    setBusy('all');
    try {
      const { data } = await api.post('/gst-portal/gstins/refresh-all', null, { params: { company_id: activeCompanyId() }, timeout: 180000 });
      (data.updated || []).forEach(replaceEntry);
      if (data.failed?.length) toast.warning(`${data.updated.length} updated, ${data.failed.length} could not be checked.`);
      else toast.success(`${data.updated.length} GSTIN${data.updated.length === 1 ? '' : 's'} updated.`);
    } catch (err) {
      toast.error(errorText(err, 'Could not update GSTINs'));
    } finally {
      setBusy('');
    }
  };

  const handleRemove = async (g) => {
    if (!window.confirm(`Remove ${g} from this company's GSTINs? Its stored status and sync history stay on record.`)) return;
    setBusy(g);
    try {
      await api.delete(`/gst-portal/gstins/${encodeURIComponent(g)}`, { params: { company_id: activeCompanyId() } });
      setGstins((list) => list.filter((e) => e.gstin !== g));
      toast.success(`${g} removed`);
    } catch (err) {
      toast.error(errorText(err, 'Could not remove this GSTIN'));
    } finally {
      setBusy('');
    }
  };

  // Show the details already stored for a saved GSTIN. No lookup.
  const handleView = (entry) => {
    if (!entry.profile) { toast.info('This GSTIN has not been checked yet. Press Update to check it.'); return; }
    setTaxpayerResult({ ...decodeGSTIN(entry.gstin), state_name: entry.state_name, state_code: entry.state_code, pan: entry.pan, entity_type: entry.entity_type, checksum_valid: entry.checksum_valid, ...entry.profile, status: entry.status, status_confirmed: entry.status_confirmed, _stored: true });
    setSearchGstin(entry.gstin);
    requestAnimationFrame(() => document.getElementById('gst-result')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const handleLookup = async (gstinToSearch) => {
    const target = (gstinToSearch || searchGstin).trim().toUpperCase();
    if (!target) {
      toast.error('Please enter a GSTIN');
      return;
    }
    setSearching(true);
    setSearchGstin(target);
    try {
      const res = await lookupGSTIN(target);
      setTaxpayerResult({ ...res, _stored: false });
      if (res.valid) {
        toast.success(`Verified: ${res.legal_name || 'Taxpayer'}`);
      } else {
        toast.warning('GSTIN checksum validation failed');
      }
    } catch (err) {
      toast.error(err.message || 'Lookup failed');
    } finally {
      setSearching(false);
    }
  };

  const handleSyncNow = async (targetGstin) => {
    const g = (targetGstin || taxpayerResult?.gstin || '').trim().toUpperCase();
    if (g.length !== 15) { toast.error('Choose a GSTIN to sync.'); return; }
    setSyncing(true);
    setBusy(`sync:${g}`);
    try {
      const res = await api.post('/gst-portal/sync-now', null, { params: { company_id: activeCompanyId(), gstin: g } });
      toast.success(res.data?.message || 'Synced liability and credit ledger with the books.');
      await fetchAll();
      setActiveTab('ledgers');
    } catch (err) {
      toast.error(errorText(err, 'Sync failed'));
    } finally {
      setSyncing(false);
      setBusy('');
    }
  };

  const handleBulkVerify = async () => {
    const lines = bulkInput
      .split(/[\n,;]+/)
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 14);

    if (lines.length === 0) {
      toast.error('Please enter at least one GSTIN');
      return;
    }

    setBulkLoading(true);
    try {
      const res = await bulkVerifyGSTINs(lines);
      setBulkResults(res);
      toast.success(`Verified ${res.total} GSTINs (${res.valid_count} Valid)`);
    } catch {
      toast.error('Bulk verification failed');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleCopy = (text, key) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleExportBulkCSV = () => {
    if (!bulkResults?.results?.length) return;
    const headers = ['GSTIN', 'Valid', 'Status', 'Legal Name', 'Trade Name', 'State', 'PAN', 'Entity Type', 'Source'];
    const rows = bulkResults.results.map((r) => [
      r.gstin,
      r.valid ? 'YES' : 'NO',
      r.status,
      `"${(r.legal_name || '').replace(/"/g, '""')}"`,
      `"${(r.trade_name || '').replace(/"/g, '""')}"`,
      r.state_name || r.state_code || '',
      r.pan || '',
      `"${(r.entity_type || '').replace(/"/g, '""')}"`,
      r.source || 'Free GST API',
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((e) => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `gstin_verification_report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      await api.post('/gst/config', configData);
      toast.success('GST API settings updated successfully');
      setConfigOpen(false);
      fetchAll();
    } catch {
      toast.error('Failed to save configuration');
    } finally {
      setSavingConfig(false);
    }
  };

  if (loading) return <ContentLoader />;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <div className="p-4 md:p-6 space-y-6 max-w-[1240px] mx-auto">

        {/* ── Banner Header ── */}
        <div
          className="rounded-2xl overflow-hidden shadow-xl"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
        >
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-xl bg-white/15 border-0 flex items-center justify-center shadow-md shrink-0">
                <Landmark className="h-7 w-7 text-white" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">
                    Finix &amp; CompliGenie · Free GST API
                  </p>
                  <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 text-emerald-200 border border-emerald-400/30">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    Free API Mode Active
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-white/10 text-white border-0">
                    <ShieldCheck className="h-3 w-3 text-emerald-300" />
                    Luhn Mod-36 Verified
                  </span>
                </div>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">
                  Live Revenue Liabilities &amp; Free GST API Hub
                </h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">
                  Instant GSTIN validation, taxpayer profile lookup, Luhn mod-36 mathematical verification, bulk audits, and live PMT-01/PMT-02 ledger reconciliation without expensive third-party fees.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 self-start lg:self-center shrink-0">
              <Button
                onClick={() => setConfigOpen(true)}
                variant="outline"
                className="bg-white/10 border-0 text-white hover:bg-white/20 whitespace-nowrap"
              >
                <Settings className="h-4 w-4 mr-2" />
                API Settings
              </Button>
              <Button
                onClick={fetchAll}
                variant="outline"
                className="bg-white/15 border-0 text-white hover:bg-white/25 whitespace-nowrap"
              >
                <RefreshCw className="h-4 w-4 mr-2" />
                Refresh
              </Button>
            </div>
          </div>
        </div>

        {/* ── Main Navigation Tabs ── */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-5">
          <TabsList className={`w-full grid grid-cols-1 md:grid-cols-3 h-auto min-h-[46px] p-1.5 gap-2 rounded-xl border shadow-sm ${
            isDark ? 'bg-slate-800/90 border-slate-700 text-slate-300' : 'bg-slate-100 border-slate-200 text-slate-600'
          }`}>
            <TabsTrigger
              value="lookup"
              className="h-10 py-2 px-4 gap-2 text-xs md:text-sm font-semibold rounded-lg flex items-center justify-center transition-all data-[state=active]:bg-white dark:data-[state=active]:bg-slate-700 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm cursor-pointer"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span>Live GSTIN Search &amp; Verify</span>
            </TabsTrigger>
            <TabsTrigger
              value="bulk"
              className="h-10 py-2 px-4 gap-2 text-xs md:text-sm font-semibold rounded-lg flex items-center justify-center transition-all data-[state=active]:bg-white dark:data-[state=active]:bg-slate-700 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm cursor-pointer"
            >
              <Layers className="h-4 w-4 shrink-0" />
              <span>Bulk GSTIN Audit</span>
            </TabsTrigger>
            <TabsTrigger
              value="ledgers"
              className="h-10 py-2 px-4 gap-2 text-xs md:text-sm font-semibold rounded-lg flex items-center justify-center transition-all data-[state=active]:bg-white dark:data-[state=active]:bg-slate-700 data-[state=active]:text-blue-600 dark:data-[state=active]:text-blue-400 data-[state=active]:shadow-sm cursor-pointer"
            >
              <Database className="h-4 w-4 shrink-0" />
              <span>PMT-01 / PMT-02 &amp; Audit Risk</span>
            </TabsTrigger>
          </TabsList>

          {/* ════════════════════════════════════════════════════════════════════
              TAB 1: LIVE GSTIN SEARCH & VERIFICATION
             ════════════════════════════════════════════════════════════════════ */}
          <TabsContent value="lookup" className="space-y-5">
            {/* ── Saved GSTINs: stored status, no outside call until you add or update ── */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className={`px-5 py-4 flex flex-col md:flex-row md:items-center justify-between gap-3 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                <div>
                  <h3 className="font-bold text-base">Your GSTINs</h3>
                  <p className="text-xs text-slate-500">Status shown is what was stored when each number was last checked. Nothing is checked until you add or update one.</p>
                </div>
                {canManage && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      placeholder="Add a GSTIN (15 characters)"
                      value={addValue}
                      onChange={(e) => setAddValue(e.target.value.toUpperCase().replace(/\s/g, ''))}
                      onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
                      maxLength={15}
                      aria-label="GSTIN to add"
                      className="font-mono uppercase placeholder:normal-case placeholder:font-sans h-10 w-full sm:w-64"
                    />
                    <Button onClick={() => handleAdd()} disabled={busy === 'add' || addValue.length !== 15} className="h-10 whitespace-nowrap bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                      {busy === 'add' ? <RefreshCw className="h-4 w-4 mr-2 animate-spin" /> : <Plus className="h-4 w-4 mr-2" />}
                      Add GSTIN
                    </Button>
                    <Button onClick={handleUpdateAll} disabled={!!busy || !gstins.some((e) => e.saved)} variant="outline" className="h-10 whitespace-nowrap">
                      <RefreshCw className={`h-4 w-4 mr-2 ${busy === 'all' ? 'animate-spin' : ''}`} />
                      Update all
                    </Button>
                  </div>
                )}
              </div>

              {gstins.length === 0 ? (
                <div className="px-5 py-10 text-center">
                  <p className="text-sm font-medium">No GSTINs saved for this company yet.</p>
                  <p className="text-xs text-slate-500 mt-1">{canManage ? 'Add the company\'s GSTIN above to see its status here.' : 'Ask an administrator to add the company\'s GSTIN.'}</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className={`text-left text-[11px] font-semibold uppercase tracking-wide ${isDark ? 'text-slate-400 bg-slate-900/40' : 'text-slate-500 bg-slate-50'}`}>
                        <th className="px-5 py-2.5">GSTIN</th>
                        <th className="px-3 py-2.5">Taxpayer</th>
                        <th className="px-3 py-2.5">Status</th>
                        <th className="px-3 py-2.5">Last checked</th>
                        <th className="px-3 py-2.5">Books sync</th>
                        <th className="px-5 py-2.5 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className={`divide-y ${isDark ? 'divide-slate-700' : 'divide-slate-100'}`}>
                      {gstins.map((e) => {
                        const st = statusStyle(e.status);
                        const rowBusy = busy === e.gstin || busy === `sync:${e.gstin}` || busy === 'all';
                        return (
                          <tr key={e.gstin} className="align-top">
                            <td className="px-5 py-3">
                              <span className="font-mono font-semibold">{e.gstin}</span>
                              {!e.saved && <div className="text-[11px] text-slate-500">From company profile</div>}
                            </td>
                            <td className="px-3 py-3">
                              <div className="font-medium">{e.legal_name || <span className="text-slate-400">Not known yet</span>}</div>
                              <div className="text-[11px] text-slate-500">{e.state_name}</div>
                            </td>
                            <td className="px-3 py-3">
                              <span title={st.note} className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${st.cls}`}>
                                {e.status === 'Active' && <CheckCircle2 className="h-3 w-3" />}
                                {['Format valid', 'Invalid GSTIN'].includes(e.status) && <AlertTriangle className="h-3 w-3" />}
                                {e.status}
                              </span>
                              {e.checked && e.source && <div className="text-[11px] text-slate-500 mt-1 max-w-[190px]">Source: {e.source}</div>}
                            </td>
                            <td className="px-3 py-3 text-xs">
                              {fmtWhen(e.verified_at) ? (<span className="inline-flex items-center gap-1"><Clock className="h-3 w-3 text-slate-400" />{fmtWhen(e.verified_at)}</span>) : <span className="text-slate-400">Never</span>}
                            </td>
                            <td className="px-3 py-3 text-xs">
                              {e.last_synced_at ? (
                                <>
                                  <div>{fmtWhen(e.last_synced_at)}</div>
                                  {e.total_liability != null && <div className="text-slate-500">Liability {fmtC(e.total_liability)}</div>}
                                  {e.is_audit_risk && <div className="text-rose-600 font-semibold">Audit risk · {e.variance_pct}% off books</div>}
                                </>
                              ) : <span className="text-slate-400">Not synced</span>}
                            </td>
                            <td className="px-5 py-3">
                              <div className="flex flex-wrap justify-end gap-1.5">
                                <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => handleView(e)} disabled={!e.checked} title={e.checked ? 'Show stored details' : 'Check it first'}>
                                  <Eye className="h-3.5 w-3.5" />View
                                </Button>
                                {canManage && (
                                  <>
                                    <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => handleUpdate(e.gstin)} disabled={!!busy}>
                                      <RefreshCw className={`h-3.5 w-3.5 ${busy === e.gstin ? 'animate-spin' : ''}`} />Update
                                    </Button>
                                    <Button size="sm" className="h-8 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => handleSyncNow(e.gstin)} disabled={!!busy || rowBusy}>
                                      <Database className="h-3.5 w-3.5" />Sync books
                                    </Button>
                                    {e.saved && (
                                      <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-slate-400 hover:text-rose-600" onClick={() => handleRemove(e.gstin)} disabled={!!busy} aria-label={`Remove ${e.gstin}`}>
                                        <Trash2 className="h-4 w-4" />
                                      </Button>
                                    )}
                                  </>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Search Input Box */}
            <div className={`rounded-xl border p-5 shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <label className="block text-xs font-bold uppercase tracking-wider mb-2 text-slate-500">
                Look up any other GSTIN (not saved)
              </label>
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex-1">
                  <Input
                    placeholder="Enter a 15-character GSTIN"
                    value={searchGstin}
                    onChange={(e) => setSearchGstin(e.target.value.toUpperCase())}
                    onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
                    maxLength={15}
                    className="font-mono uppercase placeholder:normal-case placeholder:font-sans text-base h-11 pr-10"
                  />
                  {searchGstin && (
                    <button
                      type="button"
                      onClick={() => setSearchGstin('')}
                      className="absolute right-3 top-3 text-xs text-slate-400 hover:text-slate-600"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <Button
                  onClick={() => handleLookup()}
                  disabled={searching}
                  className="h-11 px-6 bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  {searching ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Search className="h-4 w-4 mr-2" />
                  )}
                  {searching ? 'Checking…' : 'Look up'}
                </Button>
              </div>

              {/* Sample GSTIN Pills for 1-Click Verification */}
              <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700/80 flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-500 font-medium">Quick Test Sample GSTINs:</span>
                {SAMPLE_GSTINS.map((s) => (
                  <button
                    key={s.gstin}
                    type="button"
                    onClick={() => handleLookup(s.gstin)}
                    className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors cursor-pointer ${
                      searchGstin === s.gstin
                        ? 'bg-blue-600 text-white border-blue-600'
                        : isDark
                        ? 'bg-slate-700 text-slate-200 border-slate-600 hover:bg-slate-600'
                        : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200'
                    }`}
                  >
                    {s.name.split(' ')[0]} ({s.state})
                  </button>
                ))}
              </div>
            </div>

            {/* Taxpayer Verification Card */}
            {taxpayerResult && (
              <div id="gst-result" className={`rounded-xl border shadow-md overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                {/* Header */}
                <div className={`p-5 border-b flex flex-col md:flex-row md:items-center justify-between gap-4 ${isDark ? 'border-slate-700 bg-slate-800/80' : 'border-slate-100 bg-slate-50/80'}`}>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-mono font-bold text-lg text-blue-600 dark:text-blue-400">
                        {taxpayerResult.gstin}
                      </span>
                      {!taxpayerResult.valid ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          Checksum Mismatch
                        </Badge>
                      ) : taxpayerResult.status_confirmed === false ? (
                        <Badge className="bg-amber-100 text-amber-800 border border-amber-300 hover:bg-amber-100 gap-1" title="The number is well-formed, but no GST service confirmed its status.">
                          <AlertTriangle className="h-3 w-3" />
                          Format valid, status not confirmed
                        </Badge>
                      ) : (
                        <Badge className={`${(taxpayerResult.status || 'Active') === 'Active' ? 'bg-emerald-600 hover:bg-emerald-600' : 'bg-rose-600 hover:bg-rose-600'} gap-1`}>
                          <CheckCircle2 className="h-3 w-3" />
                          {taxpayerResult.status || 'Active'}
                        </Badge>
                      )}
                      <Badge variant="outline" className="text-xs">
                        {taxpayerResult.taxpayer_type || 'Regular'}
                      </Badge>
                      <Badge variant="outline" className="text-xs bg-blue-50 dark:bg-blue-950/40 text-blue-600 border-blue-200">
                        {taxpayerResult.state_name} ({taxpayerResult.state_code})
                      </Badge>
                    </div>
                    <h2 className="text-xl font-bold">{taxpayerResult.legal_name}</h2>
                    {taxpayerResult.trade_name && taxpayerResult.trade_name !== taxpayerResult.legal_name && (
                      <p className="text-xs text-slate-500 font-medium">Trade Name: {taxpayerResult.trade_name}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleCopy(JSON.stringify(taxpayerResult, null, 2), 'json')}
                      className="text-xs gap-1"
                    >
                      {copiedKey === 'json' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      Copy JSON
                    </Button>
                    {canManage && !gstins.some((e) => e.saved && e.gstin === taxpayerResult.gstin) && (
                      <Button size="sm" variant="outline" onClick={() => handleAdd(taxpayerResult.gstin)} disabled={busy === 'add'} className="text-xs gap-1">
                        <Plus className="h-3.5 w-3.5" />
                        Add to my GSTINs
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => handleSyncNow(taxpayerResult.gstin)}
                      disabled={syncing || !canManage}
                      className="text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                      Sync Portals &amp; Books
                    </Button>
                  </div>
                </div>

                {/* Details Grid */}
                <div className="p-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Permanent Account Number (PAN)</p>
                    <div className="flex items-center justify-between mt-1">
                      <span className="font-mono font-bold text-base">{taxpayerResult.pan}</span>
                      <button
                        type="button"
                        onClick={() => handleCopy(taxpayerResult.pan, 'pan')}
                        className="p-1 text-slate-400 hover:text-slate-600"
                      >
                        {copiedKey === 'pan' ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    <span className="text-[10px] text-slate-400">Extracted from characters 3–12</span>
                  </div>

                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Entity Constitution</p>
                    <p className="font-semibold text-sm mt-1">{taxpayerResult.entity_type}</p>
                    <span className="text-[10px] text-slate-400">Decoded from PAN 4th character</span>
                  </div>

                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Luhn Mod-36 Check Digit</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className="font-mono font-bold text-base">
                        Char: {taxpayerResult.actual_check_digit || taxpayerResult.gstin?.slice(-1)}
                      </span>
                      {taxpayerResult.checksum_valid ? (
                        <span className="text-xs font-semibold text-emerald-600 flex items-center gap-0.5">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Passing
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-rose-500 flex items-center gap-0.5">
                          <AlertTriangle className="h-3.5 w-3.5" /> Expected {taxpayerResult.expected_check_digit}
                        </span>
                      )}
                    </div>
                    <span className="text-[10px] text-slate-400">Official Indian GSTN Mod-36 formula</span>
                  </div>

                  <div className={`p-3.5 rounded-lg border ${isDark ? 'bg-slate-900/60 border-slate-700/80' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Filing Periodicity</p>
                    <p className="font-semibold text-sm mt-1">{taxpayerResult.filing_frequency || 'Monthly'}</p>
                    <span className="text-[10px] text-slate-400">GSTR-1 (11th) / GSTR-3B (20th)</span>
                  </div>
                </div>

                {/* Address & Source Footer */}
                <div className={`px-5 py-3 border-t text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${isDark ? 'border-slate-700 bg-slate-900/40 text-slate-400' : 'border-slate-100 bg-slate-50 text-slate-600'}`}>
                  <div className="flex items-center gap-1.5">
                    <MapPin className="h-3.5 w-3.5 text-blue-500 shrink-0" />
                    <span>Principal Place: {taxpayerResult.principal_place_of_business?.address || `${taxpayerResult.state_name}, India`}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span>Source: <strong className="text-slate-800 dark:text-slate-200">{taxpayerResult.source || 'Free GST API'}</strong></span>
                    <span>•</span>
                    <span>{taxpayerResult._stored ? 'Last checked' : 'Checked'}: {fmtWhen(taxpayerResult.verified_at) || '—'}</span>
                  </div>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ════════════════════════════════════════════════════════════════════
              TAB 2: BULK GSTIN AUDIT & VERIFICATION
             ════════════════════════════════════════════════════════════════════ */}
          <TabsContent value="bulk" className="space-y-5">
            <div className={`rounded-xl border p-5 shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="font-bold text-base">Bulk GSTIN Verification &amp; Taxpayer Audit</h3>
                  <p className="text-xs text-slate-500">Paste up to 100 GSTIN numbers (one per line, comma or semicolon separated) to batch-verify.</p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkInput(SAMPLE_GSTINS.map((s) => s.gstin).join('\n'))}
                  className="text-xs"
                >
                  Load Sample List
                </Button>
              </div>

              <textarea
                rows={5}
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value.toUpperCase())}
                placeholder="29AABCU9603R1ZJ&#10;27AAACT2882H1Z7&#10;27AAACR0442P1Z8&#10;29AAACW1682B1ZG"
                className={`w-full rounded-lg border p-3 font-mono text-sm leading-relaxed ${
                  isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-900'
                }`}
              />

              <div className="mt-3 flex items-center justify-between flex-wrap gap-2">
                <span className="text-xs text-slate-400">
                  {bulkInput.split(/[\n,;]+/).filter((l) => l.trim().length >= 14).length} GSTINs detected
                </span>
                <Button
                  onClick={handleBulkVerify}
                  disabled={bulkLoading}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  {bulkLoading ? (
                    <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4 mr-2" />
                  )}
                  {bulkLoading ? 'Verifying Batch…' : 'Run Bulk Verification'}
                </Button>
              </div>
            </div>

            {bulkResults && (
              <div className="space-y-4">
                {/* Summary Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <MetricCard label="Total Processed" value={bulkResults.total} icon={Layers} color={COLORS.mediumBlue} isDark={isDark} />
                  <MetricCard label="Passing Checksum" value={bulkResults.valid_count} icon={CheckCircle2} color={COLORS.emeraldGreen} isDark={isDark} />
                  <MetricCard label="Errors / Flagged" value={bulkResults.invalid_count} icon={AlertTriangle} color={COLORS.coral} isDark={isDark} />
                  <div className={`rounded-xl border p-4 shadow-sm flex flex-col justify-center items-start ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                    <p className="text-xs font-semibold text-slate-500 uppercase mb-2">Export Verified Data</p>
                    <Button
                      size="sm"
                      onClick={handleExportBulkCSV}
                      className="w-full bg-emerald-600 hover:bg-emerald-700 text-white text-xs gap-1"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Download CSV Report
                    </Button>
                  </div>
                </div>

                {/* Results Table */}
                <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>GSTIN</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Legal Entity Name</TableHead>
                        <TableHead>State</TableHead>
                        <TableHead>PAN</TableHead>
                        <TableHead>Entity Type</TableHead>
                        <TableHead className="text-right">Action</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bulkResults.results.map((r, i) => (
                        <TableRow key={r.gstin || i}>
                          <TableCell className="font-mono font-bold text-xs">{r.gstin}</TableCell>
                          <TableCell>
                            {r.valid ? (
                              <Badge className="bg-emerald-600 hover:bg-emerald-600 text-[11px]">Valid</Badge>
                            ) : (
                              <Badge variant="destructive" className="text-[11px]">Invalid</Badge>
                            )}
                          </TableCell>
                          <TableCell className="font-medium text-xs max-w-[200px] truncate">{r.legal_name}</TableCell>
                          <TableCell className="text-xs">{r.state_name || r.state_code}</TableCell>
                          <TableCell className="font-mono text-xs">{r.pan}</TableCell>
                          <TableCell className="text-xs text-slate-500">{r.entity_type}</TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setSearchGstin(r.gstin);
                                handleLookup(r.gstin);
                                setActiveTab('lookup');
                              }}
                              className="text-xs text-blue-600 dark:text-blue-400"
                            >
                              Inspect &rarr;
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
          </TabsContent>

          {/* ════════════════════════════════════════════════════════════════════
              TAB 3: PMT-01 / PMT-02 & AUDIT RISK
             ════════════════════════════════════════════════════════════════════ */}
          <TabsContent value="ledgers" className="space-y-5">
            {/* Metric Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricCard label="Total Liability (PMT-01)" value={fmtC(metrics?.total_liability)} icon={Landmark} color={COLORS.coral} isDark={isDark} />
              <MetricCard label="Available ITC (PMT-02)" value={fmtC(metrics?.net_available_credits)} icon={CheckCircle2} color={COLORS.emeraldGreen} isDark={isDark} />
              <MetricCard label="Bank Cash Reserves" value={fmtC(metrics?.cash_reserves)} icon={Wallet} color={COLORS.mediumBlue} isDark={isDark} />
              <MetricCard
                label="Audit Discrepancy"
                value={metrics?.discrepancy_pct === null || metrics?.discrepancy_pct === undefined ? '0.0%' : `${metrics.discrepancy_pct}%`}
                icon={AlertTriangle}
                color={metrics?.is_audit_risk ? COLORS.coral : COLORS.emeraldGreen}
                isDark={isDark}
                sub={metrics?.is_audit_risk ? 'Variance exceeds 5% tolerance' : 'Ledger balanced with books'}
              />
            </div>

            {/* Snapshots Table */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                <h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  Electronic Ledger Snapshots (PMT-01 &amp; PMT-02)
                </h3>
                <span className="text-xs text-slate-500">Synced via Free GST API &amp; Internal Accounting</span>
              </div>
              {snapshots.length === 0 ? (
                <div className="p-8 text-center">
                  <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No portal snapshots stored yet.</p>
                  <Button
                    size="sm"
                    onClick={() => {
                      const saved = gstins.filter((e) => e.saved);
                      if (saved.length === 1) handleSyncNow(saved[0].gstin);
                      else { setActiveTab('lookup'); toast.info(saved.length ? 'Choose a GSTIN and press Sync books.' : 'Add a GSTIN first, then press Sync books.'); }
                    }}
                    className="mt-3 bg-blue-600 hover:bg-blue-700 text-white text-xs"
                  >
                    Sync First Snapshot Now
                  </Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>GSTIN</TableHead>
                      <TableHead>Return Period</TableHead>
                      <TableHead className="text-right">Cash Liability</TableHead>
                      <TableHead className="text-right">Total Liability</TableHead>
                      <TableHead className="text-right">Available Credit (ITC)</TableHead>
                      <TableHead>Timestamp</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {snapshots.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs font-bold">{s.gstin}</TableCell>
                        <TableCell className="text-xs">{s.period}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(s.outward_cash_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{fmtC(s.outward_total_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs text-emerald-600">{fmtC(s.available_itc)}</TableCell>
                        <TableCell className="text-xs text-slate-500">{new Date(s.fetched_at).toLocaleString('en-IN')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>

            {/* Audit Risk Table */}
            <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="p-4 border-b flex items-center justify-between" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
                <h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                  Audit Risk Engine — Portal Liability vs Books Comparison
                </h3>
                <span className="text-xs text-slate-500">Automated 5% Variance Tolerance Gate</span>
              </div>
              {riskRows.length === 0 ? (
                <p className={`p-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  No audit risk comparisons calculated yet. Click &quot;Sync Now&quot; above to run your first check.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Period</TableHead>
                      <TableHead className="text-right">Portal Liability</TableHead>
                      <TableHead className="text-right">Internal Ledger (Books)</TableHead>
                      <TableHead className="text-right">Variance (₹)</TableHead>
                      <TableHead className="text-right">Variance (%)</TableHead>
                      <TableHead>Audit Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {riskRows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="text-xs font-medium">{r.period}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(r.portal_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(r.internal_liability)}</TableCell>
                        <TableCell className="text-right font-mono text-xs">{fmtC(r.variance)}</TableCell>
                        <TableCell className="text-right font-mono text-xs font-bold">{r.variance_pct}%</TableCell>
                        <TableCell>
                          {r.is_risk ? (
                            <Badge variant="destructive" className="text-xs">Audit Risk</Badge>
                          ) : (
                            <Badge className="bg-emerald-600 hover:bg-emerald-600 text-xs">Clean / Reconciled</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* ── API Settings Dialog ── */}
        <Dialog open={configOpen} onOpenChange={setConfigOpen}>
          <DialogContent className={`max-w-md ${isDark ? 'bg-slate-900 text-slate-100 border-slate-700' : 'bg-white text-slate-900'}`}>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Settings className="h-5 w-5 text-blue-500" />
                Free GST API Configuration
              </DialogTitle>
              <DialogDescription className="text-xs">
                Configure your preferred GST verification provider and free tier keys.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-3 text-sm">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-500">
                  GST API Provider
                </label>
                <select
                  value={configData.provider}
                  onChange={(e) => setConfigData({ ...configData, provider: e.target.value })}
                  className={`w-full rounded-lg border p-2.5 text-xs font-medium ${
                    isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
                  }`}
                >
                  <option value="builtin_free">Free Built-in Engine &amp; Public Registry (0-Cost, Unlimited)</option>
                  <option value="sheetgst">SheetGST / GSTINCheck Free Tier</option>
                  <option value="rapidapi">RapidAPI GSTIN Tool (Free Plan)</option>
                  <option value="custom_gsp">Licensed Enterprise GSP / Custom Gateway</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-bold uppercase tracking-wider mb-1.5 text-slate-500">
                  Optional Free API Key
                </label>
                <Input
                  type="password"
                  placeholder="Leave empty for free built-in public search"
                  value={configData.api_key || ''}
                  onChange={(e) => setConfigData({ ...configData, api_key: e.target.value })}
                  className="text-xs"
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  Built-in Free Engine works instantly without requiring any API keys.
                </p>
              </div>

              <div className="rounded-lg p-3 text-xs space-y-1 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900">
                <p className="font-bold text-blue-900 dark:text-blue-300">Free Tier Features Included:</p>
                <p className="text-blue-800 dark:text-blue-400">• Official Indian GSTN Luhn Mod-36 Check Digit Algorithm</p>
                <p className="text-blue-800 dark:text-blue-400">• Real-time State &amp; PAN entity decoding (38 Indian states &amp; UTs)</p>
                <p className="text-blue-800 dark:text-blue-400">• Local database caching for instant 0ms repeated checks</p>
                <p className="text-blue-800 dark:text-blue-400">• Multi-format bulk verification export</p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <Button variant="ghost" onClick={() => setConfigOpen(false)} className="text-xs">
                Cancel
              </Button>
              <Button
                onClick={handleSaveConfig}
                disabled={savingConfig}
                className="bg-blue-600 hover:bg-blue-700 text-white text-xs"
              >
                {savingConfig ? 'Saving…' : 'Save Settings'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function GSTPortalSync() {
  return (
    <RequestAccessGate module="accounting_reports" moduleLabel="Live GST Portal Sync" permissionFlag="can_view_accounting_reports">
      <GSTPortalSyncInner />
    </RequestAccessGate>
  );
}

export default GSTPortalSync;
