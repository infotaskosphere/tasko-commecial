// EngageX · WhatsApp Hub — bulk WhatsApp broadcasts delivered server-side
// through the company's connected WhatsApp number(s).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, Check, CheckCircle2, ChevronLeft, ChevronRight, Clock3, FileText, Gauge, Megaphone,
  MessageCircle, Paperclip, Pencil, Plus, Send, ShieldOff, Smartphone, Trash2, Users, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, GuidanceNote, LoadingState, PageBanner } from '@/components/ui/PageKit';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import AudienceBuilder from '@/components/engagex/AudienceBuilder';
import { CampaignSheet, CampaignTable } from '@/components/engagex/CampaignViews';
import OptOutPanel from '@/components/engagex/OptOutPanel';
import {
  BRAND, ExCard, MergeTagBar, SPEED_PRESETS, estimateWhatsAppSeconds, fileToBase64, fmtDuration, fmtNumber,
  insertAtCursor, localDateTimeValue, previewVariables, renderMergePreview,
} from '@/components/engagex/shared';

const MAX_MEDIA_MB = 5;
const STEPS = [
  { id: 'audience', label: 'Audience', icon: Users },
  { id: 'message', label: 'Message', icon: MessageCircle },
  { id: 'delivery', label: 'Delivery', icon: Gauge },
  { id: 'review', label: 'Review & send', icon: Send },
];

/** WhatsApp text formatting (*bold* _italic_ ~strike~ ```mono```) on escaped text. */
function waFormat(text) {
  const escaped = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/```([\s\S]+?)```/g, '<code class="font-mono text-[12px]">$1</code>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1<strong>$2</strong>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s.,!?)]|$)/g, '$1<s>$2</s>');
}

function PhonePreview({ message, recipient, senderCompany, attachment }) {
  const text = renderMergePreview(message, previewVariables(recipient, senderCompany));
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[2rem] border-[6px] border-slate-800 bg-slate-800 shadow-xl">
      <div className="flex items-center gap-2 rounded-t-[1.5rem] bg-[#075E54] px-4 py-3 text-white">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20 text-xs font-bold">{(recipient?.name || '?').slice(0, 1).toUpperCase()}</div>
        <div className="min-w-0"><p className="truncate text-sm font-semibold">{recipient?.name || 'Recipient'}</p><p className="truncate text-[10px] text-white/70">{recipient?.phone ? `+${recipient.phone}` : 'online'}</p></div>
      </div>
      <div className="min-h-[300px] rounded-b-[1.5rem] bg-[#ECE5DD] p-3 dark:bg-[#0B141A]">
        {(message || attachment) ? (
          <div className="ml-auto w-fit max-w-[92%] rounded-lg rounded-tr-none bg-[#DCF8C6] px-2.5 py-1.5 text-[13px] leading-snug text-slate-900 shadow-sm dark:bg-[#005C4B] dark:text-slate-50">
            {attachment && (attachment.type?.startsWith('image/')
              ? <img src={`data:${attachment.type};base64,${attachment.base64}`} alt="" className="mb-1.5 max-h-48 w-full rounded-md object-cover" />
              : <div className="mb-1.5 flex items-center gap-2 rounded-md bg-black/5 px-2 py-1.5 text-xs dark:bg-white/10"><FileText className="h-4 w-4" /><span className="truncate">{attachment.name}</span></div>)}
            <div className="whitespace-pre-wrap break-words" dangerouslySetInnerHTML={{ __html: waFormat(text) }} />
            <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-slate-500 dark:text-slate-300">{new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<Check className="h-3 w-3" /></div>
          </div>
        ) : <p className="pt-24 text-center text-xs text-slate-500">Your message preview appears here</p>}
      </div>
    </div>
  );
}

function Stepper({ step, onStep, canGo }) {
  return (
    <ol className="flex flex-wrap items-center gap-2">
      {STEPS.map((s, i) => {
        const Icon = s.icon;
        const state = i < step ? 'done' : i === step ? 'current' : 'todo';
        return (
          <li key={s.id} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!canGo(i)}
              onClick={() => onStep(i)}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed ${state === 'current' ? 'bg-emerald-600 text-white' : state === 'done' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-slate-800'}`}
            >
              {state === 'done' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Icon className="h-3.5 w-3.5" />}{s.label}
            </button>
            {i < STEPS.length - 1 && <ChevronRight className="h-4 w-4 text-slate-300" />}
          </li>
        );
      })}
    </ol>
  );
}

function TemplateDialog({ open, onOpenChange, initial, onSaved }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (open) { setName(initial?.name || ''); setMessage(initial?.message || ''); } }, [open, initial]);
  const save = async () => {
    if (!name.trim() || !message.trim()) return toast.error('Give the template a name and a message.');
    setSaving(true);
    try {
      if (initial?.id) await engagexApi.updateTemplate('whatsapp', initial.id, { name, message });
      else await engagexApi.createTemplate('whatsapp', { name, message });
      toast.success('Template saved');
      onSaved(); onOpenChange(false);
    } catch (error) { toast.error(engagexError(error)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{initial?.id ? 'Edit template' : 'New WhatsApp template'}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Template name, e.g. GST due-date reminder" />
          <MergeTagBar onInsert={(tag) => setMessage((m) => insertAtCursor(ref.current, m, tag))} />
          <Textarea ref={ref} rows={8} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Hi {{first_name}}, …" />
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplatesPanel({ onUse }) {
  const [state, setState] = useState({ loading: true, items: [] });
  const [editing, setEditing] = useState(null);
  const load = useCallback(async () => {
    try { const data = await engagexApi.templates('whatsapp'); setState({ loading: false, items: data.items || [] }); }
    catch (error) { setState({ loading: false, items: [] }); toast.error(engagexError(error)); }
  }, []);
  useEffect(() => { load(); }, [load]);
  const remove = async (t) => {
    if (!window.confirm(`Delete template “${t.name}”?`)) return;
    try { await engagexApi.deleteTemplate('whatsapp', t.id); load(); } catch (error) { toast.error(engagexError(error)); }
  };
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEditing({})}><Plus className="h-4 w-4 mr-1" />New template</Button></div>
      {state.loading ? <LoadingState /> : state.items.length === 0 ? (
        <EmptyState icon={FileText} title="No templates yet" hint="Save messages you send often — reminders, greetings, payment follow-ups." action={<Button size="sm" onClick={() => setEditing({})}>Create template</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {state.items.map((t) => (
            <div key={t.id} className="flex flex-col rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <p className="font-semibold text-slate-800 dark:text-slate-100">{t.name}</p>
              <p className="mt-1 line-clamp-4 flex-1 whitespace-pre-wrap text-sm text-slate-500">{t.message}</p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={() => onUse(t)}>Use</Button>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(t)}><Pencil className="h-4 w-4" /></Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" onClick={() => remove(t)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <TemplateDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} initial={editing} onSaved={load} />
    </div>
  );
}

const emptyDraft = () => ({
  name: '', recipients: [], message: '', attachment: null, sessionId: '', pace: 'balanced',
  custom: { ...SPEED_PRESETS.balanced }, when: 'now', scheduledAt: localDateTimeValue(Date.now() + 60 * 60 * 1000), consent: false,
});

function BroadcastWizard({ sessions, sessionsLoading, senderCompany, draft, setDraft, onLaunched }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [templates, setTemplates] = useState([]);
  const messageRef = useRef(null);
  const fileRef = useRef(null);
  const connected = sessions.filter((s) => s.connected);
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const pace = draft.pace === 'custom' ? draft.custom : SPEED_PRESETS[draft.pace];
  const eta = estimateWhatsAppSeconds(draft.recipients.length, pace);

  useEffect(() => { engagexApi.templates('whatsapp').then((d) => setTemplates(d.items || [])).catch(() => {}); }, []);
  useEffect(() => { if (!draft.sessionId && connected[0]) set({ sessionId: connected[0].session_id }); }, [connected.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const valid = [
    draft.recipients.length > 0,
    draft.message.trim().length > 0 || !!draft.attachment,
    !!draft.sessionId && (draft.when === 'now' || new Date(draft.scheduledAt).getTime() > Date.now() + 60_000) && Number(pace.max_delay_sec) >= Number(pace.min_delay_sec),
    true,
  ];
  const canGo = (i) => valid.slice(0, i).every(Boolean);

  const attach = async (file) => {
    if (!file) return;
    if (file.size > MAX_MEDIA_MB * 1024 * 1024) return toast.error(`Attachments must be ${MAX_MEDIA_MB} MB or smaller.`);
    try { set({ attachment: { name: file.name, type: file.type || 'application/octet-stream', size: file.size, base64: await fileToBase64(file) } }); }
    catch { toast.error('Could not read that file.'); }
  };

  const launch = async () => {
    if (!draft.consent) return toast.error('Please confirm your recipients have agreed to receive WhatsApp messages.');
    setSaving(true);
    try {
      const body = {
        name: draft.name.trim() || `WhatsApp broadcast · ${new Date().toLocaleDateString('en-IN')}`,
        session_id: draft.sessionId,
        message: draft.message.trim(),
        media: draft.attachment ? { filename: draft.attachment.name, mime_type: draft.attachment.type, base64: draft.attachment.base64 } : null,
        recipients: draft.recipients,
        min_delay_sec: Number(pace.min_delay_sec), max_delay_sec: Number(pace.max_delay_sec),
        pause_every: Number(pace.pause_every), pause_sec: Number(pace.pause_sec),
        scheduled_at: draft.when === 'later' ? new Date(draft.scheduledAt).toISOString() : null,
      };
      const res = await engagexApi.createWhatsAppCampaign(body);
      const s = res.summary || {};
      toast.success(draft.when === 'later' ? 'Broadcast scheduled' : 'Broadcast started', {
        description: `${fmtNumber(s.valid - (s.suppressed || 0))} recipients${s.suppressed ? ` · ${s.suppressed} opted out (skipped)` : ''}`,
      });
      setStep(0);
      onLaunched(res.campaign);
    } catch (error) {
      toast.error(engagexError(error));
    } finally {
      setSaving(false);
    }
  };

  const previewRecipient = draft.recipients[0] || { name: 'Ravi Sharma', phone: '919876543210', company: 'Sharma Traders' };
  const selectedSession = sessions.find((s) => s.session_id === draft.sessionId);

  return (
    <div className="space-y-5">
      <Stepper step={step} onStep={setStep} canGo={canGo} />

      {step === 0 && <AudienceBuilder channel="whatsapp" value={draft.recipients} onChange={(recipients) => set({ recipients })} />}

      {step === 1 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-4 min-w-0">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Campaign name
                <Input className="mt-1.5" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. October GST reminder" maxLength={160} />
              </label>
              <label className="text-sm font-medium text-slate-700 dark:text-slate-200">Start from a template
                <Select key={`tpl-${templates.length}-${draft.message.length === 0}`} onValueChange={(id) => { const t = templates.find((x) => x.id === id); if (t) set({ message: t.message, name: draft.name || t.name }); }}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder={templates.length ? 'Choose a template…' : 'No saved templates'} /></SelectTrigger>
                  <SelectContent>{templates.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent>
                </Select>
              </label>
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Message</span>
                <span className={`text-[11px] ${draft.message.length > 4000 ? 'text-rose-600' : 'text-slate-400'}`}>{draft.message.length}/4096</span>
              </div>
              <MergeTagBar onInsert={(tag) => set({ message: insertAtCursor(messageRef.current, draft.message, tag) })} extra={Object.keys(draft.recipients[0]?.variables || {})} />
              <Textarea ref={messageRef} className="mt-2 font-[inherit]" rows={10} maxLength={4096} value={draft.message} onChange={(e) => set({ message: e.target.value })}
                placeholder={'Hi {{first_name|there}},\n\nYour GST return for October is due on 20th. Please share your sales invoices by the 15th.\n\n– {{sender_company}}'} />
              <p className="mt-1.5 text-[11px] text-slate-500">WhatsApp formatting: *bold*, _italic_, ~strikethrough~. Use {'{{tag|fallback}}'} when a value may be missing.</p>
            </div>
            <div>
              <input ref={fileRef} type="file" className="hidden" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,video/mp4" onChange={(e) => { attach(e.target.files?.[0]); e.target.value = ''; }} />
              {draft.attachment ? (
                <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                  <span className="flex min-w-0 items-center gap-2 text-sm">{draft.attachment.type?.startsWith('image/') ? <img src={`data:${draft.attachment.type};base64,${draft.attachment.base64}`} alt="" className="h-10 w-10 rounded object-cover" /> : <Paperclip className="h-4 w-4 text-slate-500" />}<span className="truncate">{draft.attachment.name}</span><span className="text-xs text-slate-400">{(draft.attachment.size / 1024).toFixed(0)} KB</span></span>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => set({ attachment: null })}><X className="h-4 w-4" /></Button>
                </div>
              ) : (
                <button type="button" onClick={() => fileRef.current?.click()}
                  className="flex w-full items-center gap-3 rounded-xl border-2 border-dashed border-slate-300 px-4 py-3 text-left text-slate-500 hover:border-emerald-400 hover:text-emerald-700 dark:border-slate-600 dark:hover:text-emerald-300">
                  <span className="rounded-lg bg-emerald-50 p-2 text-emerald-600 dark:bg-emerald-500/15"><Paperclip className="h-5 w-5" /></span>
                  <span><span className="block text-sm font-semibold">Attach an image or document</span><span className="block text-xs">Photo, poster, PDF, Word, Excel, PowerPoint or short video · up to {MAX_MEDIA_MB} MB</span></span>
                </button>
              )}
              {draft.attachment && <p className="mt-1 text-[11px] text-slate-500">The message is sent as the attachment's caption.</p>}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-center text-xs font-semibold text-slate-500">Preview for {previewRecipient.name || `+${previewRecipient.phone}`}</p>
            <PhonePreview message={draft.message} recipient={previewRecipient} senderCompany={senderCompany} attachment={draft.attachment} />
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-4">
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">Send from</p>
              {sessionsLoading ? <p className="text-sm text-slate-400">Checking connected numbers…</p> : connected.length === 0 ? (
                <GuidanceNote tone="warning" icon={AlertTriangle}>No WhatsApp number is connected for your company. An administrator can connect one in <Link to="/settings/whatsapp" className="font-semibold underline">Settings → WhatsApp</Link>.</GuidanceNote>
              ) : (
                <div className="grid gap-2">
                  {sessions.map((s) => (
                    <button key={s.session_id} type="button" disabled={!s.connected} onClick={() => set({ sessionId: s.session_id })}
                      className={`flex items-center justify-between rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${draft.sessionId === s.session_id ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-slate-700'}`}>
                      <span className="flex items-center gap-2"><Smartphone className="h-4 w-4 text-emerald-600" /><span><span className="block text-sm font-semibold text-slate-800 dark:text-slate-100">{s.label}</span><span className="block font-mono text-[11px] text-slate-500">{s.phone ? `+${s.phone}` : s.session_id}</span></span></span>
                      <span className={`text-[11px] font-semibold ${s.connected ? 'text-emerald-600' : 'text-slate-400'}`}>{s.connected ? 'Connected' : s.status || 'Offline'}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-sm font-medium text-slate-700 dark:text-slate-200">When</p>
              <div className="flex gap-2">
                {[['now', 'Send now'], ['later', 'Schedule']].map(([v, label]) => (
                  <button key={v} type="button" onClick={() => set({ when: v })} className={`flex-1 rounded-lg border px-3 py-2 text-sm font-semibold ${draft.when === v ? 'border-emerald-500 bg-emerald-50/60 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'}`}>{label}</button>
                ))}
              </div>
              {draft.when === 'later' && <Input type="datetime-local" className="mt-2" value={draft.scheduledAt} min={localDateTimeValue(Date.now() + 2 * 60 * 1000)} onChange={(e) => set({ scheduledAt: e.target.value })} />}
            </div>
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Sending pace</p>
            <div className="grid gap-2">
              {Object.entries(SPEED_PRESETS).map(([key, p]) => (
                <button key={key} type="button" onClick={() => set({ pace: key })} className={`rounded-xl border px-3 py-2.5 text-left ${draft.pace === key ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
                  <span className="flex items-center justify-between"><span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{p.label}</span><span className="text-[11px] text-slate-500">{p.min_delay_sec}–{p.max_delay_sec}s gap · pause {p.pause_sec}s every {p.pause_every}</span></span>
                  <span className="text-xs text-slate-500">{p.hint}</span>
                </button>
              ))}
              <button type="button" onClick={() => set({ pace: 'custom' })} className={`rounded-xl border px-3 py-2.5 text-left ${draft.pace === 'custom' ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">Custom</span>
              </button>
              {draft.pace === 'custom' && (
                <div className="grid grid-cols-2 gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  {[['min_delay_sec', 'Min gap (s)', 2], ['max_delay_sec', 'Max gap (s)', 2], ['pause_every', 'Pause every (msgs)', 0], ['pause_sec', 'Pause length (s)', 0]].map(([k, label, min]) => (
                    <label key={k} className="text-[11px] font-semibold text-slate-500">{label}
                      <Input type="number" min={min} className="mt-1 h-8" value={draft.custom[k]} onChange={(e) => set({ custom: { ...draft.custom, [k]: Math.max(min, Number(e.target.value) || 0) } })} />
                    </label>
                  ))}
                </div>
              )}
            </div>
            <GuidanceNote icon={Clock3}>Estimated sending time for {fmtNumber(draft.recipients.length)} recipients: <b>{fmtDuration(eta)}</b>. Messages are sent from the server, so you can close this page.</GuidanceNote>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-3">
            <dl className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
              {[
                ['Campaign', draft.name.trim() || 'WhatsApp broadcast'],
                ['Recipients', `${fmtNumber(draft.recipients.length)} unique numbers`],
                ['Send from', selectedSession ? `${selectedSession.label}${selectedSession.phone ? ` (+${selectedSession.phone})` : ''}` : '—'],
                ['When', draft.when === 'later' ? new Date(draft.scheduledAt).toLocaleString('en-IN') : 'Immediately'],
                ['Pace', `${pace.min_delay_sec}–${pace.max_delay_sec}s between messages · about ${fmtDuration(eta)}`],
                ['Attachment', draft.attachment?.name || 'None'],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 px-4 py-2.5 text-sm"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium text-slate-800 dark:text-slate-100">{v}</dd></div>
              ))}
            </dl>
            <GuidanceNote tone="warning" icon={ShieldOff}>Numbers on your opt-out list are skipped automatically. Sending unsolicited bulk messages can get a WhatsApp number restricted.</GuidanceNote>
            <label className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-200">
              <Checkbox className="mt-0.5" checked={draft.consent} onCheckedChange={(v) => set({ consent: Boolean(v) })} />
              I confirm these recipients are my clients or contacts who have agreed to receive WhatsApp messages from us.
            </label>
          </div>
          <PhonePreview message={draft.message} recipient={previewRecipient} senderCompany={senderCompany} attachment={draft.attachment} />
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-100 pt-4 dark:border-slate-700">
        <Button variant="ghost" disabled={step === 0} onClick={() => setStep((s) => s - 1)}><ChevronLeft className="h-4 w-4 mr-1" />Back</Button>
        {step < STEPS.length - 1 ? (
          <Button disabled={!valid[step]} onClick={() => setStep((s) => s + 1)} className="bg-emerald-600 hover:bg-emerald-700 text-white">Continue<ChevronRight className="h-4 w-4 ml-1" /></Button>
        ) : (
          <Button disabled={saving || !draft.consent || !connected.length} onClick={launch} className="bg-emerald-600 hover:bg-emerald-700 text-white">
            <Send className="h-4 w-4 mr-1.5" />{saving ? 'Starting…' : draft.when === 'later' ? 'Schedule broadcast' : `Send to ${fmtNumber(draft.recipients.length)}`}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function EngageXWhatsAppHub() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState(params.get('new') ? 'new' : 'campaigns');
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [draft, setDraft] = useState(emptyDraft);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openId, setOpenId] = useState(params.get('campaign'));

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try { const data = await engagexApi.whatsappSessions(); setSessions(data.sessions || []); if (data.bridge_error) toast.warning('WhatsApp service is not reachable right now.'); }
    catch (error) { toast.error(engagexError(error)); }
    finally { setSessionsLoading(false); }
  }, []);
  useEffect(() => { loadSessions(); }, [loadSessions]);

  useEffect(() => {
    const id = params.get('campaign');
    if (id) setOpenId(id);
    if (params.get('new')) setTab('new');
  }, [params]);

  const connectedCount = useMemo(() => sessions.filter((s) => s.connected).length, [sessions]);
  const senderCompany = user?.company_name || user?.company?.name || 'Your company';

  const closeSheet = (open) => {
    if (open) return;
    setOpenId(null);
    if (params.get('campaign')) { params.delete('campaign'); setParams(params, { replace: true }); }
  };

  return (
    <div className="space-y-5 sm:space-y-6 w-full min-w-0 text-slate-800 dark:text-slate-100">
      <PageBanner
        icon={MessageCircle}
        eyebrow="EngageX · WhatsApp Hub"
        title="Bulk WhatsApp Messaging"
        subtitle="Personalised broadcasts to your clients from your connected WhatsApp number, with safe pacing, live progress and full delivery history."
        stats={[{ label: 'Numbers', value: sessionsLoading ? '…' : connectedCount }]}
      />

      <Tabs value={tab} onValueChange={(v) => { setTab(v); if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }); } }}>
        <TabsList className="h-auto">
          <TabsTrigger value="campaigns"><Megaphone className="h-4 w-4 mr-1.5" />Campaigns</TabsTrigger>
          <TabsTrigger value="new"><Plus className="h-4 w-4 mr-1.5" />New broadcast</TabsTrigger>
          <TabsTrigger value="templates"><FileText className="h-4 w-4 mr-1.5" />Templates</TabsTrigger>
          <TabsTrigger value="optouts"><ShieldOff className="h-4 w-4 mr-1.5" />Opt-outs</TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns" className="mt-4">
          <ExCard icon={Megaphone} title="Broadcasts" color={BRAND.whatsapp} description="Delivery runs on the server — progress updates live.">
            <CampaignTable channel="whatsapp" refreshKey={refreshKey} onOpen={(c) => setOpenId(c.id)}
              emptyAction={<Button size="sm" onClick={() => setTab('new')}>New broadcast</Button>}
              extraActions={<Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setTab('new')}><Plus className="h-4 w-4 mr-1" />New broadcast</Button>} />
          </ExCard>
        </TabsContent>

        <TabsContent value="new" className="mt-4">
          <ExCard icon={Send} title="New broadcast" color={BRAND.whatsapp}
            actions={(draft.recipients.length || draft.message) ? <Button size="sm" variant="ghost" onClick={() => { if (window.confirm('Discard this draft?')) setDraft(emptyDraft()); }}>Start over</Button> : null}>
            <BroadcastWizard sessions={sessions} sessionsLoading={sessionsLoading} senderCompany={senderCompany} draft={draft} setDraft={setDraft}
              onLaunched={(campaign) => { setDraft(emptyDraft()); setTab('campaigns'); setRefreshKey((k) => k + 1); setOpenId(campaign.id); }} />
          </ExCard>
        </TabsContent>

        <TabsContent value="templates" className="mt-4">
          <ExCard icon={FileText} title="Message templates" color={BRAND.whatsapp}>
            <TemplatesPanel onUse={(t) => { setDraft((d) => ({ ...d, message: t.message, name: d.name || t.name })); setTab('new'); }} />
          </ExCard>
        </TabsContent>

        <TabsContent value="optouts" className="mt-4">
          <ExCard icon={ShieldOff} title="Opt-out list" color={BRAND.whatsapp}><OptOutPanel channel="whatsapp" /></ExCard>
        </TabsContent>
      </Tabs>

      <CampaignSheet channel="whatsapp" campaignId={openId} open={!!openId} onOpenChange={closeSheet} onChanged={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}
