// Campaign list + live detail drawer, shared by WhatsApp Hub and MailMaster.
import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Ban, ChevronLeft, ChevronRight, Copy, Loader2, Paperclip, Pause, Play, RefreshCw, RotateCcw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { EmptyState, LoadingState } from '@/components/ui/PageKit';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import { DeliveryBar, StatusBadge, fmtAgo, fmtDateTime, fmtNumber, isActive, usePolling } from './shared';

export function CampaignTable({ channel, refreshKey, onOpen, emptyAction, extraActions }) {
  const [state, setState] = useState({ loading: true, items: [], total: 0 });
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('all');
  const [q, setQ] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setState((s) => ({ ...s, loading: true }));
    try {
      const data = await engagexApi.campaigns(channel, { page, page_size: 15, status, q });
      setState({ loading: false, items: data.items || [], total: data.total || 0 });
    } catch (error) {
      setState((s) => ({ ...s, loading: false }));
      if (!silent) toast.error(engagexError(error));
    }
  }, [channel, page, status, q]);

  useEffect(() => { load(); }, [load, refreshKey]);
  usePolling(() => load(true), 5000, state.items.some((c) => isActive(c.status)));

  const pages = Math.max(1, Math.ceil(state.total / 15));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search campaigns…" className="pl-8" />
        </div>
        <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1); }}>
          <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(channel === 'email' ? ['draft'] : []).concat(['queued', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed']).map((s) => (
              <SelectItem key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="icon" onClick={() => load()} title="Refresh"><RefreshCw className="h-4 w-4" /></Button>
        {extraActions}
      </div>

      {state.loading ? <LoadingState /> : state.items.length === 0 ? (
        <EmptyState title="No campaigns yet" hint={q || status !== 'all' ? 'Try a different filter.' : 'Create your first campaign to see delivery progress here.'} action={emptyAction} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2.5 text-left font-semibold">Campaign</th>
                <th className="px-4 py-2.5 text-left font-semibold">Status</th>
                <th className="px-4 py-2.5 text-left font-semibold w-[220px]">Delivery</th>
                {channel === 'email' && <th className="px-4 py-2.5 text-right font-semibold">Opens</th>}
                <th className="px-4 py-2.5 text-right font-semibold">Created</th>
              </tr>
            </thead>
            <tbody>
              {state.items.map((c) => {
                const st = c.stats || {};
                const done = (st.sent || 0) + (st.failed || 0) + (st.skipped || 0);
                return (
                  <tr key={c.id} onClick={() => onOpen(c)} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50/70 dark:border-slate-700/60 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-slate-800 dark:text-slate-100">{c.name}</p>
                      <p className="text-[11px] text-slate-500">{c.created_by_name}{c.scheduled_at && c.status === 'scheduled' ? ` · sends ${fmtDateTime(c.scheduled_at)}` : ''}</p>
                    </td>
                    <td className="px-4 py-3"><StatusBadge status={c.status} />{c.last_error && c.status === 'paused' && <AlertTriangle className="ml-1.5 inline h-3.5 w-3.5 text-amber-500" title={c.last_error} />}</td>
                    <td className="px-4 py-3">
                      {c.status === 'draft' ? <span className="text-xs text-slate-400">Not sent</span> : (
                        <>
                          <DeliveryBar stats={st} />
                          <p className="mt-1 text-[11px] text-slate-500">{fmtNumber(st.sent)} sent · {fmtNumber(st.failed)} failed · {fmtNumber(done)}/{fmtNumber(st.total)}</p>
                        </>
                      )}
                    </td>
                    {channel === 'email' && <td className="px-4 py-3 text-right text-xs text-slate-600 dark:text-slate-300">{st.sent ? `${Math.round(((st.opened || 0) * 100) / st.sent)}%` : '—'}</td>}
                    <td className="px-4 py-3 text-right text-xs text-slate-500 whitespace-nowrap">{fmtAgo(c.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
          Page {page} of {pages}
          <Button size="icon" variant="outline" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <Button size="icon" variant="outline" className="h-7 w-7" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
      )}
    </div>
  );
}

const RECIPIENT_FILTERS = { all: 'All', pending: 'Pending', sent: 'Sent', failed: 'Failed', skipped: 'Skipped' };

export function CampaignSheet({ channel, campaignId, open, onOpenChange, onChanged, onEditDraft, onDuplicate }) {
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!campaignId) return;
    try {
      const res = await engagexApi.campaign(channel, campaignId, { status: filter, q, page, page_size: 50 });
      setData(res);
    } catch (error) {
      if (!silent) toast.error(engagexError(error));
    }
  }, [channel, campaignId, filter, q, page]);

  useEffect(() => { if (open) { setData(null); setFilter('all'); setQ(''); setPage(1); } }, [open, campaignId]);
  useEffect(() => { if (open) load(); }, [open, load]);
  usePolling(() => load(true), 3000, open && data && isActive(data.campaign.status));

  const campaign = data?.campaign;
  const st = campaign?.stats || {};
  const act = async (action, label) => {
    setBusy(action);
    try {
      if (action === 'delete') await engagexApi.deleteCampaign(channel, campaignId);
      else await engagexApi.campaignAction(channel, campaignId, action);
      toast.success(label);
      onChanged?.();
      if (action === 'delete') onOpenChange(false); else await load();
    } catch (error) {
      toast.error(engagexError(error));
    } finally {
      setBusy('');
    }
  };

  const key = channel === 'whatsapp' ? 'phone' : 'email';
  const recipients = data?.recipients?.items || [];
  const recipientPages = Math.max(1, Math.ceil((data?.recipients?.total || 0) / 50));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        {!campaign ? <div className="flex h-full items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div> : (
          <div className="space-y-5">
            <SheetHeader>
              <div className="flex items-center gap-2"><StatusBadge status={campaign.status} /><span className="text-xs text-slate-500">Created {fmtDateTime(campaign.created_at)} by {campaign.created_by_name}</span></div>
              <SheetTitle className="text-xl">{campaign.name}</SheetTitle>
              <SheetDescription>
                {channel === 'email' ? `${campaign.content?.subject || 'No subject'}${campaign.sender_from ? ` · from ${campaign.sender_from}` : ''}` : (campaign.content?.message || '').slice(0, 140)}
              </SheetDescription>
            </SheetHeader>

            {channel === 'whatsapp' && (() => {
              const files = campaign.content?.attachments?.length ? campaign.content.attachments : (campaign.content?.media_name ? [{ id: 'legacy', filename: campaign.content.media_name }] : []);
              const st = campaign.settings || {};
              return (
                <div className="space-y-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:text-slate-300">
                  {files.length ? <div className="flex flex-wrap items-center gap-1.5"><Paperclip className="h-3.5 w-3.5" />{files.map((f) => <span key={f.id} className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-slate-800">{f.filename}</span>)}</div> : null}
                  {st.min_delay_sec ? <p>Interval {st.min_delay_sec === st.max_delay_sec ? `${st.min_delay_sec}s` : `${st.min_delay_sec}–${st.max_delay_sec}s`} between recipients{st.pause_every ? ` · ${st.pause_sec}s pause every ${st.pause_every}` : ''}{files.length > 1 || (files.length && campaign.content?.message) ? ` · ${st.part_gap_sec ?? 2}s between parts` : ''}</p> : null}
                </div>
              );
            })()}

            {campaign.last_error && ['paused', 'failed', 'draft'].includes(campaign.status) && (
              <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                <AlertTriangle className="h-4 w-4 shrink-0" />{campaign.last_error}
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[['Recipients', st.total], ['Sent', st.sent], ['Failed', st.failed], channel === 'email' ? ['Opened', st.opened] : ['Skipped', st.skipped]].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <p className="text-[11px] font-semibold text-slate-500">{label}</p>
                  <p className="text-lg font-extrabold text-slate-800 dark:text-slate-100">{fmtNumber(value || 0)}</p>
                </div>
              ))}
            </div>
            {campaign.status !== 'draft' && <DeliveryBar stats={st} className="h-2.5" />}
            {campaign.status === 'scheduled' && <p className="text-xs text-violet-600 dark:text-violet-300">Scheduled for {fmtDateTime(campaign.scheduled_at)}</p>}
            {campaign.status === 'running' && campaign.throttled_until && new Date(campaign.throttled_until) > new Date() && (
              <div className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
                <p className="font-semibold">Waiting for the sending limit — continues automatically at {fmtDateTime(campaign.throttled_until)}</p>
                {campaign.last_error && <p className="mt-0.5">{campaign.last_error}</p>}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {campaign.status === 'draft' && onEditDraft && <Button size="sm" onClick={() => onEditDraft(campaign)}>Edit draft</Button>}
              {['queued', 'scheduled', 'running'].includes(campaign.status) && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act('pause', 'Campaign paused')}><Pause className="h-4 w-4 mr-1.5" />Pause</Button>}
              {campaign.status === 'paused' && <Button size="sm" disabled={!!busy} onClick={() => act('resume', 'Campaign resumed')}><Play className="h-4 w-4 mr-1.5" />Resume</Button>}
              {['paused', 'completed', 'failed', 'cancelled'].includes(campaign.status) && st.failed > 0 && <Button size="sm" variant="outline" disabled={!!busy} onClick={() => act('retry-failed', 'Retrying failed recipients')}><RotateCcw className="h-4 w-4 mr-1.5" />Retry {st.failed} failed</Button>}
              {['queued', 'scheduled', 'running', 'paused'].includes(campaign.status) && <Button size="sm" variant="outline" className="text-rose-600" disabled={!!busy} onClick={() => { if (window.confirm('Cancel this campaign? Remaining recipients will be skipped.')) act('cancel', 'Campaign cancelled'); }}><Ban className="h-4 w-4 mr-1.5" />Cancel</Button>}
              {onDuplicate && <Button size="sm" variant="outline" onClick={() => onDuplicate(campaign)}><Copy className="h-4 w-4 mr-1.5" />Duplicate</Button>}
              {['draft', 'completed', 'cancelled', 'failed'].includes(campaign.status) && <Button size="sm" variant="ghost" className="text-rose-600" disabled={!!busy} onClick={() => { if (window.confirm(campaign.status === 'draft' ? 'Delete this draft?' : 'Remove this campaign from the list? Delivery records are kept for history.')) act('delete', campaign.status === 'draft' ? 'Draft deleted' : 'Campaign archived'); }}><Trash2 className="h-4 w-4 mr-1.5" />{campaign.status === 'draft' ? 'Delete' : 'Archive'}</Button>}
            </div>

            {campaign.status !== 'draft' && (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex rounded-lg border border-slate-200 p-0.5 dark:border-slate-700">
                    {Object.entries(channel === 'email' ? { ...RECIPIENT_FILTERS, opened: 'Opened' } : RECIPIENT_FILTERS).map(([value, label]) => (
                      <button key={value} type="button" onClick={() => { setFilter(value); setPage(1); }} className={`rounded-md px-2.5 py-1 text-xs font-semibold ${filter === value ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500'}`}>{label}</button>
                    ))}
                  </div>
                  <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search recipients" className="h-8 flex-1 min-w-[140px] text-xs" />
                </div>
                <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
                  <table className="w-full text-sm">
                    <tbody>
                      {recipients.length === 0 ? (
                        <tr><td className="px-4 py-8 text-center text-xs text-slate-400">No recipients in this view.</td></tr>
                      ) : recipients.map((r) => (
                        <tr key={r.id} className="border-t border-slate-100 first:border-t-0 dark:border-slate-700/60">
                          <td className="px-3 py-2 min-w-0">
                            <p className="truncate text-slate-800 dark:text-slate-100">{r.name || r[key]}</p>
                            <p className="truncate font-mono text-[11px] text-slate-500">{r[key]}</p>
                            {r.error && <p className="mt-0.5 text-[11px] text-rose-600 dark:text-rose-300">{r.error}</p>}
                          </td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            <StatusBadge status={r.opened_at ? 'opened' : r.status} />
                            <p className="mt-0.5 text-[10px] text-slate-400">{r.sent_at ? fmtDateTime(r.sent_at) : ''}</p>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {recipientPages > 1 && (
                  <div className="flex items-center justify-end gap-2 text-xs text-slate-500">
                    {page} / {recipientPages}
                    <Button size="icon" variant="outline" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></Button>
                    <Button size="icon" variant="outline" className="h-7 w-7" disabled={page >= recipientPages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></Button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
