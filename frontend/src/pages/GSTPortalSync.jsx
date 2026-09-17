import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Landmark, RefreshCw, AlertTriangle, CheckCircle2, Wifi, WifiOff, Plus,
} from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';

const COLORS = { deepBlue: '#0D3B66', mediumBlue: '#1F6FB2', emeraldGreen: '#1FAF5A', amber: '#F59E0B', coral: '#FF6B6B' };
const fmtC = (n) => (n === null || n === undefined) ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

function MetricCard({ label, value, icon: Icon, color, isDark, sub }) {
  return (
    <div className={`rounded-2xl border p-4 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
      <div className="flex items-center justify-between mb-2">
        <p className={`text-xs font-semibold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
        <div className="h-8 w-8 rounded-lg flex items-center justify-center" style={{ background: `${color}20` }}>
          <Icon className="h-4 w-4" style={{ color }} />
        </div>
      </div>
      <p className={`text-2xl font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{value}</p>
      {sub && <p className={`text-xs mt-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{sub}</p>}
    </div>
  );
}

function GSTPortalSyncInner() {
  const isDark = useDark();
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [riskRows, setRiskRows] = useState([]);
  const [gstin, setGstin] = useState('');

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [m, s, r] = await Promise.allSettled([
        api.get('/gst-portal/dashboard-metrics'),
        api.get('/gst-portal/snapshot'),
        api.get('/gst-portal/audit-risk'),
      ]);
      setMetrics(m.status === 'fulfilled' ? m.value.data : null);
      setSnapshots(s.status === 'fulfilled' ? s.value.data : []);
      setRiskRows(r.status === 'fulfilled' ? r.value.data : []);
    } catch {
      toast.error('Failed to load GST portal data');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { fetchAll(); }, []);

  const registerAndSync = async () => {
    if (!gstin.trim()) { toast.error('Enter a GSTIN first'); return; }
    setSyncing(true);
    try {
      await api.post('/gst-portal/register', { company_id: '', gstin: gstin.trim().toUpperCase(), active: true });
      await api.post(`/gst-portal/sync-now?company_id=&gstin=${encodeURIComponent(gstin.trim().toUpperCase())}`);
      toast.success('Synced live liability & credit ledger.');
      await fetchAll();
    } catch (err) {
      const detail = err.response?.data?.detail || 'Sync failed';
      toast.error(detail);
    } finally {
      setSyncing(false);
    }
  };

  if (loading) return <ContentLoader />;

  const configured = metrics?.portal_configured;

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      <div className="p-4 md:p-6 space-y-5 max-w-[1200px] mx-auto">
        <div className="rounded-3xl overflow-hidden shadow-xl" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="p-6 md:p-7 flex flex-col lg:flex-row lg:items-center justify-between gap-5 text-white">
            <div className="flex items-start gap-4">
              <div className="h-14 w-14 rounded-2xl bg-white/15 border border-white/20 flex items-center justify-center shadow-lg">
                <Landmark className="h-7 w-7" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.25em] text-blue-100 font-bold">AI Accounting · Module 3</p>
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight mt-1">Live Revenue Liabilities &amp; Ledger Fetch</h1>
                <p className="text-sm text-blue-100 mt-1 max-w-2xl">Live Electronic Liability Register (PMT-01) &amp; Electronic Credit Ledger (PMT-02) balances, synced from the tax portal via your GSP connection.</p>
              </div>
            </div>
            <Button onClick={fetchAll} variant="outline" className="bg-white/10 border-white/25 text-white hover:bg-white/20 whitespace-nowrap shrink-0"><RefreshCw className="h-4 w-4 mr-2 shrink-0" />Refresh</Button>
          </div>
        </div>

        {!configured && (
          <div className={`rounded-2xl border p-4 flex items-start gap-3 ${isDark ? 'bg-amber-950/40 border-amber-800' : 'bg-amber-50 border-amber-200'}`}>
            <WifiOff className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
            <div>
              <p className={`font-semibold text-sm ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>GSP not connected</p>
              <p className={`text-sm ${isDark ? 'text-amber-400/80' : 'text-amber-700'}`}>
                Live PMT-01/PMT-02 sync needs a licensed GST Suvidha Provider contract. Set <code>GSP_BASE_URL</code>, <code>GSP_CLIENT_ID</code> and <code>GSP_CLIENT_SECRET</code> on the backend, then sync below.
              </p>
            </div>
          </div>
        )}

        <div className={`rounded-2xl border p-4 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 w-full min-w-0">
            <div className="flex-1 min-w-0 w-full">
              <Input placeholder="Enter GSTIN e.g. 24AAAAA0000A1Z5" value={gstin} onChange={(e) => setGstin(e.target.value)} className="w-full min-w-0" />
            </div>
            <Button onClick={registerAndSync} disabled={syncing} className="w-full sm:w-auto shrink-0 whitespace-nowrap inline-flex items-center justify-center">
              {syncing ? <RefreshCw className="h-4 w-4 mr-2 animate-spin shrink-0" /> : <Plus className="h-4 w-4 mr-2 shrink-0" />}
              <span>{syncing ? 'Syncing…' : 'Register & Sync Now'}</span>
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Total Liability" value={fmtC(metrics?.total_liability)} icon={Landmark} color={COLORS.coral} isDark={isDark} />
          <MetricCard label="Net Available Credits" value={fmtC(metrics?.net_available_credits)} icon={CheckCircle2} color={COLORS.emeraldGreen} isDark={isDark} />
          <MetricCard label="Cash Reserves" value={fmtC(metrics?.cash_reserves)} icon={Wifi} color={COLORS.mediumBlue} isDark={isDark} />
          <MetricCard
            label="Discrepancy %"
            value={metrics?.discrepancy_pct === null || metrics?.discrepancy_pct === undefined ? '—' : `${metrics.discrepancy_pct}%`}
            icon={AlertTriangle}
            color={metrics?.is_audit_risk ? COLORS.coral : COLORS.emeraldGreen}
            isDark={isDark}
            sub={metrics?.is_audit_risk ? 'Above tolerance — review recommended' : metrics?.last_synced_at ? 'Within tolerance' : undefined}
          />
        </div>

        <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="p-4 border-b" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <h3 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Portal Snapshots</h3>
          </div>
          {snapshots.length === 0 ? (
            <p className={`p-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No snapshots synced yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>GSTIN</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Cash Liability</TableHead>
                  <TableHead className="text-right">Total Liability</TableHead>
                  <TableHead className="text-right">Available ITC</TableHead>
                  <TableHead>Fetched At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshots.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.gstin}</TableCell>
                    <TableCell>{s.period}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(s.outward_cash_liability)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(s.outward_total_liability)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(s.available_itc)}</TableCell>
                    <TableCell className="text-xs">{new Date(s.fetched_at).toLocaleString('en-IN')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        <div className={`rounded-3xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="p-4 border-b" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <h3 className={`font-bold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Audit Risk — Portal vs Internal Ledger</h3>
          </div>
          {riskRows.length === 0 ? (
            <p className={`p-6 text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No comparisons run yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead className="text-right">Portal Liability</TableHead>
                  <TableHead className="text-right">Internal Ledger</TableHead>
                  <TableHead className="text-right">Variance</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {riskRows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.period}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(r.portal_liability)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(r.internal_liability)}</TableCell>
                    <TableCell className="text-right font-mono">{fmtC(r.variance)} ({r.variance_pct}%)</TableCell>
                    <TableCell>
                      {r.is_risk
                        ? <Badge variant="destructive">Audit Risk</Badge>
                        : <Badge className="bg-emerald-600 hover:bg-emerald-600">Clean</Badge>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
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
