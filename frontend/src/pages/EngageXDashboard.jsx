// EngageX Dashboard — KPIs, delivery trend, recent campaigns and the unified
// WhatsApp + email message history for the current company.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Area, AreaChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ArrowRight, ChevronLeft, ChevronRight, Download, History, Mail, MailOpen, Megaphone, MessageCircle,
  RefreshCw, Search, Send, ShieldOff, TrendingUp,
} from 'lucide-react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, LoadingState, PageBanner, PageShell, StatRow } from '@/components/ui/PageKit';
import useDark from '@/hooks/useDark';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import { BRAND, ExCard, DeliveryBar, StatusBadge, fmtAgo, fmtDateTime, fmtNumber, fmtPct, isActive, usePolling } from '@/components/engagex/shared';

const RANGES = [7, 30, 90];
const SOURCE_LABEL = { engagex: 'EngageX campaign', engagex_campaign: 'EngageX campaign', platform: 'Platform email' };
const sourceLabel = (s) => SOURCE_LABEL[s] || String(s || 'App').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

function TrendChart({ data, isDark }) {
  const axis = isDark ? '#94A3B8' : '#64748B';
  const grid = isDark ? '#334155' : '#E2E8F0';
  const rows = data.map((d) => ({ ...d, label: format(new Date(`${d.date}T00:00:00`), 'dd MMM') }));
  const empty = rows.every((r) => !r.whatsapp && !r.email && !r.failed);
  if (empty) return <EmptyState icon={TrendingUp} title="No messages in this period" hint="Delivery activity will be charted here." />;
  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer>
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="exWa" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={BRAND.whatsapp} stopOpacity={0.35} /><stop offset="100%" stopColor={BRAND.whatsapp} stopOpacity={0} /></linearGradient>
            <linearGradient id="exMail" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={BRAND.email} stopOpacity={0.3} /><stop offset="100%" stopColor={BRAND.email} stopOpacity={0} /></linearGradient>
          </defs>
          <CartesianGrid stroke={grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fill: axis, fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={18} />
          <YAxis allowDecimals={false} tick={{ fill: axis, fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip contentStyle={{ borderRadius: 12, border: `1px solid ${grid}`, background: isDark ? '#0F172A' : '#FFFFFF', fontSize: 12 }} />
          <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="whatsapp" name="WhatsApp sent" stroke={BRAND.whatsapp} strokeWidth={2} fill="url(#exWa)" />
          <Area type="monotone" dataKey="email" name="Emails sent" stroke={BRAND.email} strokeWidth={2} fill="url(#exMail)" />
          <Area type="monotone" dataKey="failed" name="Failed" stroke={BRAND.danger} strokeWidth={1.5} strokeDasharray="4 3" fill="transparent" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function RecentCampaigns({ campaigns, onOpen }) {
  if (!campaigns.length) return <EmptyState icon={Megaphone} title="No campaigns yet" hint="Broadcasts and email campaigns you create will appear here." />;
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-700/60 -my-2">
      {campaigns.map((c) => (
        <li key={c.id}>
          <button type="button" onClick={() => onOpen(c)} className="w-full py-3 text-left group">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                {c.channel === 'whatsapp' ? <MessageCircle className="h-4 w-4 shrink-0 text-emerald-600" /> : <Mail className="h-4 w-4 shrink-0 text-indigo-600" />}
                <span className="truncate text-sm font-semibold text-slate-800 group-hover:text-teal-700 dark:text-slate-100 dark:group-hover:text-teal-300">{c.name}</span>
              </span>
              <StatusBadge status={c.status} />
            </div>
            {c.status !== 'draft' && <DeliveryBar stats={c.stats} className="mt-2" />}
            <p className="mt-1 text-[11px] text-slate-500">{fmtNumber(c.stats?.sent)} / {fmtNumber(c.stats?.total)} sent · {fmtAgo(c.created_at)}</p>
          </button>
        </li>
      ))}
    </ul>
  );
}

function HistoryTable({ onCampaign }) {
  const [filters, setFilters] = useState({ channel: 'all', status: 'all', q: '', date_from: '', date_to: '' });
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ loading: true, items: [], total: 0 });
  const [selected, setSelected] = useState(null);
  const [exporting, setExporting] = useState(false);
  const pageSize = 25;

  const params = useMemo(() => ({ ...filters, page, page_size: pageSize }), [filters, page]);
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await engagexApi.history(params);
      setState({ loading: false, items: data.items || [], total: data.total || 0 });
    } catch (error) {
      setState({ loading: false, items: [], total: 0 });
      toast.error(engagexError(error));
    }
  }, [params]);

  useEffect(() => { const t = setTimeout(load, filters.q ? 300 : 0); return () => clearTimeout(t); }, [load, filters.q]);
  const set = (key) => (value) => { setFilters((f) => ({ ...f, [key]: value })); setPage(1); };
  const pages = Math.max(1, Math.ceil(state.total / pageSize));

  const exportCsv = async () => {
    setExporting(true);
    try { await engagexApi.exportHistory(filters); } catch (error) { toast.error(engagexError(error)); } finally { setExporting(false); }
  };

  return (
    <ExCard
      icon={History}
      title="Message history"
      badge={state.loading ? undefined : fmtNumber(state.total)}
      description="Every WhatsApp message and email sent from this workspace — EngageX campaigns, client reminders, invoices and platform emails."
      color={BRAND.teal}
      actions={<Button size="sm" variant="outline" onClick={exportCsv} disabled={exporting}><Download className="h-4 w-4 mr-1.5" />{exporting ? 'Exporting…' : 'Export CSV'}</Button>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={filters.q} onChange={(e) => set('q')(e.target.value)} placeholder="Search recipient, message or subject…" className="pl-8" />
        </div>
        <Select value={filters.channel} onValueChange={set('channel')}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All channels</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem><SelectItem value="email">Email</SelectItem></SelectContent>
        </Select>
        <Select value={filters.status} onValueChange={set('status')}>
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">Any status</SelectItem><SelectItem value="sent">Sent</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="opened">Opened</SelectItem></SelectContent>
        </Select>
        <Input type="date" value={filters.date_from} onChange={(e) => set('date_from')(e.target.value)} className="w-[150px]" aria-label="From date" />
        <Input type="date" value={filters.date_to} onChange={(e) => set('date_to')(e.target.value)} className="w-[150px]" aria-label="To date" />
      </div>

      {state.loading ? <LoadingState /> : state.items.length === 0 ? (
        <EmptyState icon={History} title="No messages found" hint="Try widening the filters or date range." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">When</th>
                <th className="px-4 py-2.5 text-left font-semibold">Recipient</th>
                <th className="px-4 py-2.5 text-left font-semibold">Message / subject</th>
                <th className="px-4 py-2.5 text-left font-semibold">Source</th>
                <th className="px-4 py-2.5 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((row) => (
                <tr key={`${row.channel}-${row.id}`} onClick={() => setSelected(row)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50/70 dark:border-slate-700/60 dark:hover:bg-slate-800/40">
                  <td className="px-4 py-2.5 whitespace-nowrap text-xs text-slate-500">{fmtDateTime(row.at)}</td>
                  <td className="px-4 py-2.5">
                    <span className="flex items-center gap-2">
                      {row.channel === 'whatsapp' ? <MessageCircle className="h-3.5 w-3.5 shrink-0 text-emerald-600" /> : <Mail className="h-3.5 w-3.5 shrink-0 text-indigo-600" />}
                      <span className="min-w-0">
                        {row.recipient_name && <span className="block truncate text-slate-800 dark:text-slate-100">{row.recipient_name}</span>}
                        <span className="block truncate font-mono text-xs text-slate-600 dark:text-slate-300">{row.recipient}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-4 py-2.5 max-w-[320px]"><p className="truncate text-slate-700 dark:text-slate-200">{row.summary || '—'}</p></td>
                  <td className="px-4 py-2.5 text-xs text-slate-500">{row.campaign_name || sourceLabel(row.source)}</td>
                  <td className="px-4 py-2.5 text-right"><StatusBadge status={row.opened_at ? 'opened' : row.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-slate-500">
          Page {page} of {pages}
          <Button size="icon" variant="outline" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="icon" variant="outline" className="h-7 w-7" disabled={page >= pages || page >= 200} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-lg">
          {selected && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">{selected.channel === 'whatsapp' ? <MessageCircle className="h-5 w-5 text-emerald-600" /> : <Mail className="h-5 w-5 text-indigo-600" />}{selected.recipient_name || selected.recipient}</DialogTitle>
                <DialogDescription>{fmtDateTime(selected.at)} · {selected.campaign_name || sourceLabel(selected.source)}</DialogDescription>
              </DialogHeader>
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-2"><StatusBadge status={selected.status} />{selected.opened_at && <span className="text-xs text-indigo-600">Opened {fmtDateTime(selected.opened_at)}</span>}</div>
                <p className="font-mono text-xs text-slate-500">{selected.recipient}</p>
                <div className="max-h-[260px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-slate-700 dark:bg-slate-800 dark:text-slate-200">{selected.summary || 'No content recorded.'}</div>
                {selected.error && <p className="rounded-lg bg-rose-50 p-3 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{selected.error}</p>}
                {selected.campaign_id && selected.source === 'engagex' && (
                  <Button size="sm" variant="outline" onClick={() => { onCampaign({ id: selected.campaign_id, channel: selected.channel }); setSelected(null); }}>Open campaign <ArrowRight className="h-4 w-4 ml-1.5" /></Button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </ExCard>
  );
}

export default function EngageXDashboard() {
  const navigate = useNavigate();
  const isDark = useDark();
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setOverview(await engagexApi.overview(days));
    } catch (error) {
      if (!silent) toast.error(engagexError(error));
    } finally {
      setLoading(false);
    }
  }, [days]);

  useEffect(() => { load(); }, [load]);
  usePolling(() => load(true), 15000, !!overview?.recent_campaigns?.some((c) => isActive(c.status)));

  const k = overview?.kpis || {};
  const openCampaign = (c) => navigate(`/engagex/${c.channel === 'whatsapp' ? 'whatsapp' : 'mailmaster'}?campaign=${encodeURIComponent(c.id)}`);

  return (
    <PageShell className="text-slate-800 dark:text-slate-100">
      <PageBanner
        icon={Megaphone}
        eyebrow="EngageX"
        title="Communications Dashboard"
        subtitle="WhatsApp broadcasts, MailMaster campaigns and every message your team sends — in one place."
        stats={[
          { label: 'WA sent', value: fmtNumber(k.whatsapp_sent), loading },
          { label: 'Emails', value: fmtNumber(k.email_sent), loading },
          { label: 'Open rate', value: fmtPct(k.email_open_rate), loading },
          { label: 'Active', value: fmtNumber(k.campaigns_active), loading },
        ]}
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-800">
          {RANGES.map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${days === d ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
              Last {d} days
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => load()}><RefreshCw className="h-4 w-4 mr-1.5" />Refresh</Button>
          <Button size="sm" variant="outline" onClick={() => navigate('/engagex/mailmaster?new=1')}><Mail className="h-4 w-4 mr-1.5" />New email campaign</Button>
          <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => navigate('/engagex/whatsapp?new=1')}><Send className="h-4 w-4 mr-1.5" />New WhatsApp broadcast</Button>
        </div>
      </div>

      <StatRow items={[
        { icon: MessageCircle, label: `WhatsApp delivered · ${fmtPct(k.whatsapp_delivery_rate)}`, value: fmtNumber(k.whatsapp_sent), color: BRAND.whatsapp, loading },
        { icon: Mail, label: `Emails delivered · ${fmtPct(k.email_delivery_rate)}`, value: fmtNumber(k.email_sent), color: BRAND.email, loading },
        { icon: MailOpen, label: 'MailMaster opens', value: fmtNumber(k.email_opened), color: '#7C3AED', loading },
        { icon: ShieldOff, label: 'Opted out', value: fmtNumber(k.opted_out), color: BRAND.slate, loading },
      ]} />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <ExCard icon={TrendingUp} title="Delivery trend" description={`Messages sent per day over the last ${days} days.`} color={BRAND.teal}>
          {loading && !overview ? <LoadingState /> : <TrendChart data={overview?.trend || []} isDark={isDark} />}
        </ExCard>
        <ExCard icon={Megaphone} title="Recent campaigns" badge={k.campaigns_total ? fmtNumber(k.campaigns_total) : undefined} color={BRAND.teal}>
          {loading && !overview ? <LoadingState /> : <RecentCampaigns campaigns={overview?.recent_campaigns || []} onOpen={openCampaign} />}
        </ExCard>
      </div>

      <HistoryTable onCampaign={openCampaign} />
    </PageShell>
  );
}
