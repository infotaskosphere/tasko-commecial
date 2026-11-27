/**
 * After a campaign has started: what it is doing (plan card) and an editor
 * for a paused or scheduled campaign. Messages already sent stay as they
 * were; everything still pending uses the new content and settings.
 */
import React, { Suspense, lazy, useEffect, useState } from 'react';
import { CalendarClock, Gauge, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import SpreadOptions, { spreadFromSettings, spreadPayload } from './SpreadOptions';
import { fmtDateTime, fmtNumber } from './shared';

const EmailEditor = lazy(() => import('./EmailEditor'));

const hour = (h) => `${String(h).padStart(2, '0')}:00`;
const duration = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} min` : `${Math.round(sec)} s`);

export function CampaignPlanCard({ campaign, channel }) {
  const plan = campaign?.plan;
  if (!plan) return null;
  const st = campaign.settings || {};
  const rows = [
    channel === 'email' && ['Email style', st.style === 'newsletter' ? 'Newsletter' : 'Personal'],
    channel === 'email' && campaign.sender_from && ['From', campaign.sender_from],
    plan.started_at && ['Started', fmtDateTime(plan.started_at)],
    ['Pace', `about one every ${duration(plan.seconds_between)}${plan.pause_every ? ` · ${duration(plan.pause_sec || 0)} break after every ${plan.pause_every}` : ''}`],
    ['Per day', `${fmtNumber(plan.per_day)}${plan.mailbox && plan.per_day === plan.mailbox.daily ? ` (${plan.mailbox.provider}'s safe limit)` : plan.daily_limit && plan.per_day === plan.daily_limit ? ' (your daily limit)' : ''}`],
    ['Sending hours', plan.window ? `${hour(plan.window.start)}–${hour(plan.window.end)} India time` : 'Any time'],
    ['Still to send', fmtNumber(plan.remaining)],
    plan.remaining > 0 && ['Time left', plan.days_left > 1 ? `about ${plan.days_left} days` : 'today'],
    plan.finish_estimate && plan.remaining > 0 && ['Expected to finish', fmtDateTime(plan.finish_estimate)],
  ].filter(Boolean);
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-bold text-slate-700 dark:text-slate-200"><Gauge className="h-3.5 w-3.5" />Campaign details</p>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 border-b border-slate-100 py-1 last:border-0 dark:border-slate-800">
            <dt className="shrink-0 text-slate-500">{k}</dt><dd className="min-w-0 truncate text-right font-semibold text-slate-700 dark:text-slate-200" title={String(v)}>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-[11px] text-slate-400">Estimates assume the pace above; the mailbox limit, sending hours and breaks are applied automatically.</p>
    </div>
  );
}

export default function CampaignLiveEdit({ open, onOpenChange, campaign, channel, onSaved }) {
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  useEffect(() => {
    if (!open || !campaign) return;
    const st = campaign.settings || {};
    const c = campaign.content || {};
    setForm({
      name: campaign.name || '',
      subject: c.subject || '', preview_text: c.preview_text || '', html: c.html || '',
      from_name: st.from_name || '', per_minute: st.per_minute || 30,
      message: c.message || '', min_delay_sec: st.min_delay_sec || 6, max_delay_sec: st.max_delay_sec || 12,
      pause_every: st.pause_every || 0, pause_min: Math.round((st.pause_sec || (channel === 'email' ? 300 : 60)) / 60) || 1,
      spread: spreadFromSettings(st),
      scheduled_at: campaign.status === 'scheduled' && campaign.scheduled_at ? new Date(new Date(campaign.scheduled_at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '',
    });
  }, [open, campaign, channel]);

  if (!form) return null;
  const save = async () => {
    const spread = spreadPayload(form.spread);
    const body = {
      name: form.name.trim(),
      pause_every: Number(form.pause_every) || 0,
      pause_sec: (Number(form.pause_min) || 1) * 60,
      daily_limit: spread.daily_limit || 0,
      send_start_hour: spread.send_start_hour ?? -1,
      send_end_hour: spread.send_end_hour ?? 24,
      ...(campaign.status === 'scheduled' && form.scheduled_at ? { scheduled_at: new Date(form.scheduled_at).toISOString() } : {}),
      ...(channel === 'email'
        ? { subject: form.subject, preview_text: form.preview_text, html: form.html, from_name: form.from_name.trim(), per_minute: Number(form.per_minute) || 30 }
        : { message: form.message, min_delay_sec: Number(form.min_delay_sec), max_delay_sec: Number(form.max_delay_sec) }),
    };
    setSaving(true);
    try {
      await engagexApi.liveEdit(channel, campaign.id, body);
      toast.success('Campaign updated', { description: 'Pending recipients will get the new version. Resume when ready.' });
      onSaved?.(); onOpenChange(false);
    } catch (error) { toast.error(engagexError(error)); } finally { setSaving(false); }
  };

  const label = 'text-xs font-semibold text-slate-500';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit campaign</DialogTitle>
          <DialogDescription>{fmtNumber(campaign?.plan?.remaining ?? campaign?.stats?.pending ?? 0)} recipients still to go will get these changes. Messages already sent stay as they were.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={label}>Campaign name<Input className="mt-1" value={form.name} maxLength={160} onChange={(e) => set({ name: e.target.value })} /></label>
            {campaign.status === 'scheduled' && (
              <label className={label}><span className="flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" />Starts at</span>
                <Input type="datetime-local" className="mt-1" value={form.scheduled_at} onChange={(e) => set({ scheduled_at: e.target.value })} /></label>
            )}
          </div>
          {channel === 'email' ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={label}>Subject<Input className="mt-1" value={form.subject} maxLength={300} onChange={(e) => set({ subject: e.target.value })} /></label>
                <label className={label}>Name recipients see<Input className="mt-1" value={form.from_name} maxLength={120} placeholder="Mailbox's own name" onChange={(e) => set({ from_name: e.target.value })} /></label>
              </div>
              <label className={label}>Preview text<Input className="mt-1" value={form.preview_text} maxLength={300} onChange={(e) => set({ preview_text: e.target.value })} /></label>
              <Suspense fallback={<div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>}>
                <EmailEditor value={form.html} onChange={(html) => set({ html })} previewText={form.preview_text} banner={campaign.content?.banner || null} height={340} />
              </Suspense>
              <label className={`${label} block max-w-xs`}>Sending speed (emails / minute)
                <Input type="number" min={1} max={600} className="mt-1" value={form.per_minute} onChange={(e) => set({ per_minute: Math.min(600, Math.max(1, Number(e.target.value) || 1)) })} />
              </label>
            </>
          ) : (
            <>
              <label className={label}>Message<Textarea className="mt-1 min-h-[140px]" value={form.message} maxLength={4096} onChange={(e) => set({ message: e.target.value })} /></label>
              <div className="grid max-w-md grid-cols-2 gap-3">
                <label className={label}>Min gap (s)<Input type="number" min={2} max={300} className="mt-1" value={form.min_delay_sec} onChange={(e) => set({ min_delay_sec: e.target.value })} /></label>
                <label className={label}>Max gap (s)<Input type="number" min={2} max={600} className="mt-1" value={form.max_delay_sec} onChange={(e) => set({ max_delay_sec: e.target.value })} /></label>
              </div>
            </>
          )}
          <div className={label}>Batches
            <div className="mt-1 flex flex-wrap items-center gap-2 font-normal text-slate-600 dark:text-slate-300">
              <span>Pause after every</span>
              <Input type="number" min={0} max={1000} className="w-24" value={form.pause_every || ''} placeholder="off" onChange={(e) => set({ pause_every: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })} />
              <span>{channel === 'email' ? 'emails' : 'messages'}, for</span>
              <Input type="number" min={1} max={360} className="w-20" value={form.pause_min} onChange={(e) => set({ pause_min: Math.max(1, Math.min(360, Number(e.target.value) || 1)) })} />
              <span>minutes</span>
            </div>
          </div>
          <SpreadOptions value={form.spread} onChange={(spread) => set({ spread })} unit={channel === 'email' ? 'emails' : 'messages'}
            total={campaign?.plan?.remaining || 0} mailboxDaily={campaign?.plan?.mailbox?.daily} mailboxName={campaign?.plan?.mailbox?.provider} />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
