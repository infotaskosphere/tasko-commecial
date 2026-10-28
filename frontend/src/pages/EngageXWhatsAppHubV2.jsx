import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, FileAudio, FileText, FileVideo, Gauge, Megaphone, MessageCircle, Paperclip, Plus, RefreshCw, Send, ShieldOff, Smartphone, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, GuidanceNote, PageBanner } from '@/components/ui/PageKit';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { engagexApi, engagexError, readFileBase64 } from '@/lib/engagexApi';
import AudienceBuilder from '@/components/engagex/AudienceBuilder';
import { CampaignSheet, CampaignTable } from '@/components/engagex/CampaignViews';
import OptOutPanel from '@/components/engagex/OptOutPanel';
import WhatsAppConnectDialog from '@/components/engagex/WhatsAppConnectDialog';
import { BRAND, ExCard, MergeTagBar, insertAtCursor, previewVariables, renderMergePreview } from '@/components/engagex/shared';

const MAX_ATTACHMENTS = 5;
const MAX_MEDIA_MB = 5;
const MAX_TOTAL_MB = 16;
const BLOCKED_EXTENSIONS = ['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'jar', 'apk', 'dll', 'sh', 'reg', 'lnk'];
const ACCEPT = 'image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip';

function fileIcon(type = '') {
  if (type.startsWith('video/')) return FileVideo;
  if (type.startsWith('audio/')) return FileAudio;
  return FileText;
}

function localDateTimeValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function AttachmentPreview({ file, index, count, onMove, onRemove }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900">
      {file.type?.startsWith('image/') ? <img src={`data:${file.type};base64,${file.base64}`} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800">{React.createElement(fileIcon(file.type), { className: 'h-5 w-5 text-slate-500' })}</div>}
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{file.name}</p><p className="text-[11px] text-slate-500">{file.type || 'file'} · {(file.size / 1024).toFixed(0)} KB</p></div>
      {count > 1 ? <div className="flex flex-col"><button type="button" className="px-1 text-xs text-slate-500 disabled:opacity-30" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">▲</button><button type="button" className="px-1 text-xs text-slate-500 disabled:opacity-30" disabled={index === count - 1} onClick={() => onMove(1)} aria-label="Move down">▼</button></div> : null}
      <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" onClick={onRemove} aria-label={`Remove ${file.name}`}><X className="h-4 w-4" /></Button>
    </div>
  );
}

function PhonePreview({ message, recipient, attachments }) {
  const text = renderMergePreview(message, previewVariables(recipient, 'Your company'));
  return (
    <div className="mx-auto w-full max-w-[300px] rounded-[2rem] border-[6px] border-slate-800 bg-slate-800 p-1 shadow-xl">
      <div className="rounded-[1.5rem] bg-[#ECE5DD] p-3 dark:bg-[#0B141A]">
        <div className="mb-3 flex items-center gap-2 rounded-xl bg-[#075E54] px-3 py-2 text-white"><div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-xs font-bold">{(recipient?.name || 'C').slice(0, 1).toUpperCase()}</div><div className="min-w-0"><p className="truncate text-xs font-semibold">{recipient?.name || 'Client'}</p><p className="text-[9px] text-white/70">WhatsApp</p></div></div>
        <div className="ml-auto max-w-[92%] rounded-lg rounded-tr-none bg-[#DCF8C6] p-2 text-[12px] leading-snug text-slate-900 shadow-sm">
          {attachments.map((a) => a.type?.startsWith('image/') ? <img key={a.id} src={`data:${a.type};base64,${a.base64}`} alt="" className="mb-1.5 max-h-36 w-full rounded-md object-cover" /> : <div key={a.id} className="mb-1 flex items-center gap-2 rounded-md bg-black/5 p-1.5">{React.createElement(fileIcon(a.type), { className: 'h-3.5 w-3.5' })}<span className="truncate text-[10px]">{a.name}</span></div>)}
          {text ? <div className="whitespace-pre-wrap break-words">{text}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Composer({ sessions, onConnect, onDone }) {
  const [recipients, setRecipients] = useState([]);
  const [message, setMessage] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [intervalMode, setIntervalMode] = useState('fixed');
  const [fixedInterval, setFixedInterval] = useState(8);
  const [minInterval, setMinInterval] = useState(6);
  const [maxInterval, setMaxInterval] = useState(12);
  const [pauseEvery, setPauseEvery] = useState(25);
  const [pauseSeconds, setPauseSeconds] = useState(60);
  const [partGap, setPartGap] = useState(2);
  const [when, setWhen] = useState('now');
  const [scheduledAt, setScheduledAt] = useState('');
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const fileRef = useRef(null);
  const messageRef = useRef(null);

  const connected = useMemo(() => sessions.filter(s => s.connected), [sessions]);
  const captionOnFile = attachments.length === 1 && !attachments[0].type?.startsWith('audio/');
  const partsPerRecipient = attachments.length + (message.trim() && !captionOnFile ? 1 : 0);
  useEffect(() => {
    if (sessionId && connected.some(s => s.session_id === sessionId)) return;
    setSessionId(connected[0]?.session_id || '');
  }, [connected, sessionId]);

  const addFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    if (attachments.length + files.length > MAX_ATTACHMENTS) return toast.error(`You can attach up to ${MAX_ATTACHMENTS} files in one message.`);
    let total = attachments.reduce((sum, a) => sum + a.size, 0);
    const next = [];
    for (const file of files) {
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      if (file.name.includes('.') && BLOCKED_EXTENSIONS.includes(ext)) { toast.error(`${file.name}: this file type cannot be sent.`); continue; }
      if (!file.size) { toast.error(`${file.name} is empty.`); continue; }
      if (file.size > MAX_MEDIA_MB * 1024 * 1024) { toast.error(`${file.name} is larger than ${MAX_MEDIA_MB} MB.`); continue; }
      if (total + file.size > MAX_TOTAL_MB * 1024 * 1024) { toast.error(`Attachments together must be ${MAX_TOTAL_MB} MB or smaller.`); continue; }
      try {
        const base64 = await readFileBase64(file);
        total += file.size;
        next.push({ id: `${Date.now()}_${file.name}_${Math.random()}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size, base64 });
      } catch { toast.error(`Could not read ${file.name}.`); }
    }
    setAttachments(a => [...a, ...next]);
  };

  const moveAttachment = (index, dir) => setAttachments((items) => {
    const target = index + dir;
    if (target < 0 || target >= items.length) return items;
    const copy = [...items];
    [copy[index], copy[target]] = [copy[target], copy[index]];
    return copy;
  });

  const send = async () => {
    if (!recipients.length) return toast.error('Select at least one recipient.');
    if (!message.trim() && !attachments.length) return toast.error('Write a message or add an attachment.');
    if (!sessionId) return toast.error('Connect/select a WhatsApp number first.');
    if (!consent) return toast.error('Confirm that recipients have agreed to receive WhatsApp messages.');
    const lo = intervalMode === 'fixed' ? Number(fixedInterval) : Number(minInterval);
    const hi = intervalMode === 'fixed' ? Number(fixedInterval) : Number(maxInterval);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < 2 || hi < lo || hi > 600) return toast.error('Enter a valid interval between 2 and 600 seconds (maximum ≥ minimum).');
    const every = Math.max(0, Math.floor(Number(pauseEvery) || 0));
    const pauseFor = Math.max(0, Number(pauseSeconds) || 0);
    const gap = Math.min(30, Math.max(0, Number(partGap) || 0));
    let scheduled = null;
    if (when === 'later') {
      const t = scheduledAt ? new Date(scheduledAt) : null;
      if (!t || Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) return toast.error('Choose a future date and time for the schedule.');
      scheduled = t.toISOString();
    }

    setSending(true);
    try {
      const res = await engagexApi.createWhatsAppCampaign({
        name: campaignName.trim() || `WhatsApp broadcast · ${new Date().toLocaleDateString('en-IN')}`,
        session_id: sessionId,
        message,
        attachments: attachments.map(a => ({ filename: a.name, mime_type: a.type, base64: a.base64 })),
        recipients,
        min_delay_sec: lo,
        max_delay_sec: hi,
        pause_every: every,
        pause_sec: pauseFor,
        part_gap_sec: gap,
        scheduled_at: scheduled,
      });
      const skipped = res?.summary ? (res.summary.suppressed || 0) + (res.summary.invalid || 0) + (res.summary.duplicates || 0) : 0;
      toast.success(scheduled ? `Broadcast scheduled for ${new Date(scheduled).toLocaleString('en-IN')}.` : 'Broadcast queued. It keeps sending even if you close this page.');
      if (skipped) toast.message(`${skipped} recipient${skipped > 1 ? 's were' : ' was'} skipped (opted out, invalid or duplicate).`);
      setMessage(''); setCampaignName(''); setAttachments([]); setRecipients([]); setConsent(false); setWhen('now'); setScheduledAt('');
      onDone?.(res?.campaign);
    } catch (error) {
      toast.error(engagexError(error));
    } finally { setSending(false); }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5 min-w-0">
          <AudienceBuilder channel="whatsapp" value={recipients} onChange={setRecipients} />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">Campaign name<Input className="mt-1.5" value={campaignName} onChange={e => setCampaignName(e.target.value)} placeholder="e.g. October GST reminder" maxLength={160} /></label>
            <label className="text-sm font-medium">Send from
              {connected.length ? (
                <select className="mt-1.5 h-10 w-full rounded-md border bg-background px-3 text-sm" value={sessionId} onChange={e => setSessionId(e.target.value)}>
                  <option value="">Select WhatsApp number</option>{connected.map(s => <option key={s.session_id} value={s.session_id}>{s.label} {s.phone ? `(+${s.phone})` : ''}</option>)}
                </select>
              ) : (
                <Button type="button" variant="outline" className="mt-1.5 h-10 w-full justify-start border-dashed text-emerald-700" onClick={onConnect}><Smartphone className="mr-2 h-4 w-4" />Connect a WhatsApp number</Button>
              )}
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">Message</span><span className="text-[11px] text-slate-400">{message.length}/4096</span></div>
            <MergeTagBar onInsert={tag => setMessage(m => insertAtCursor(messageRef.current, m, tag))} extra={Object.keys(recipients[0]?.variables || {})} />
            <Textarea ref={messageRef} className="mt-2" rows={8} maxLength={4096} value={message} onChange={e => setMessage(e.target.value)} placeholder={"Hi {{first_name|there}},\n\nYour compliance reminder..."} />
            <p className="mt-1.5 text-[11px] text-slate-500">Supports WhatsApp formatting such as *bold*, _italic_ and ~strikethrough~.</p>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="mb-3 flex items-center justify-between"><div><p className="text-sm font-semibold">Attachments</p><p className="text-[11px] text-slate-500">Up to {MAX_ATTACHMENTS} files of any mix — images, PDFs, Word, Excel, PowerPoint, video or audio. {MAX_MEDIA_MB} MB each, {MAX_TOTAL_MB} MB in total.</p></div><Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}><Paperclip className="mr-1.5 h-4 w-4" />Add files</Button></div>
            <input ref={fileRef} type="file" multiple className="hidden" accept={ACCEPT} onChange={addFiles} />
            {attachments.length ? <div className="grid gap-2 sm:grid-cols-2">{attachments.map((a, i) => <AttachmentPreview key={a.id} file={a} index={i} count={attachments.length} onMove={dir => moveAttachment(i, dir)} onRemove={() => setAttachments(items => items.filter((_, x) => x !== i))} />)}</div> : <button type="button" onClick={() => fileRef.current?.click()} className="w-full rounded-xl border-2 border-dashed border-slate-300 p-5 text-center text-sm text-slate-500 hover:border-emerald-400 hover:text-emerald-700"><Paperclip className="mx-auto mb-2 h-5 w-5" />Click to add multiple attachments</button>}
            <p className="mt-2 text-[11px] text-slate-500">{captionOnFile ? 'The message is sent as the caption of the file.' : attachments.length ? 'Each recipient gets the message first, then the files in this order.' : 'Files are sent in the order shown.'}</p>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="mb-3 flex items-center gap-2"><Gauge className="h-4 w-4 text-emerald-600" /><p className="text-sm font-semibold">Interval between messages</p></div>
            <div className="flex gap-2 mb-3"><button type="button" onClick={() => setIntervalMode('fixed')} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${intervalMode === 'fixed' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200'}`}>Fixed interval</button><button type="button" onClick={() => setIntervalMode('random')} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${intervalMode === 'random' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200'}`}>Random interval</button></div>
            {intervalMode === 'fixed' ? <label className="block text-xs font-semibold text-slate-500">Every (seconds)<Input type="number" min="2" max="600" value={fixedInterval} onChange={e => setFixedInterval(e.target.value)} className="mt-1.5 max-w-xs" /></label> : <div className="grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-500">Minimum seconds<Input type="number" min="2" max="300" value={minInterval} onChange={e => setMinInterval(e.target.value)} className="mt-1.5" /></label><label className="text-xs font-semibold text-slate-500">Maximum seconds<Input type="number" min="2" max="600" value={maxInterval} onChange={e => setMaxInterval(e.target.value)} className="mt-1.5" /></label></div>}
            <div className="mt-3 grid gap-3 sm:grid-cols-3"><label className="text-xs font-semibold text-slate-500">Pause after every N recipients<Input type="number" min="0" max="1000" value={pauseEvery} onChange={e => setPauseEvery(e.target.value)} className="mt-1.5" /></label><label className="text-xs font-semibold text-slate-500">Pause duration (sec)<Input type="number" min="0" max="3600" value={pauseSeconds} onChange={e => setPauseSeconds(e.target.value)} className="mt-1.5" /></label><label className="text-xs font-semibold text-slate-500">Gap between parts (sec)<Input type="number" min="0" max="30" value={partGap} onChange={e => setPartGap(e.target.value)} className="mt-1.5" disabled={partsPerRecipient < 2} /></label></div>
            <p className="mt-2 text-[11px] text-slate-500">Set “Pause after” to 0 to turn pauses off. The gap between parts applies when one recipient gets several messages (text and files).</p>
            <GuidanceNote icon={Gauge} className="mt-3">The interval is enforced by the background sender on the server, so closing this page does not stop an active broadcast. Pause, resume or cancel it from the Campaigns tab.</GuidanceNote>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <label className="flex items-start gap-2 text-sm"><Checkbox checked={consent} onCheckedChange={v => setConsent(Boolean(v))} className="mt-0.5" /><span>I confirm these recipients are clients or contacts who have agreed to receive WhatsApp messages from us.</span></label>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <div className="flex gap-2"><button type="button" onClick={() => setWhen('now')} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${when === 'now' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200'}`}>Send now</button><button type="button" onClick={() => { setWhen('later'); if (!scheduledAt) setScheduledAt(localDateTimeValue(new Date(Date.now() + 60 * 60 * 1000))); }} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${when === 'later' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200'}`}><CalendarClock className="mr-1 inline h-3.5 w-3.5" />Schedule</button></div>
              {when === 'later' ? <Input type="datetime-local" value={scheduledAt} min={localDateTimeValue(new Date())} onChange={e => setScheduledAt(e.target.value)} className="max-w-[230px]" /> : null}
            </div>
            <Button onClick={send} disabled={sending || !connected.length} className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white"><Send className="mr-2 h-4 w-4" />{sending ? 'Queuing broadcast…' : `${when === 'later' ? 'Schedule for' : 'Send to'} ${recipients.length || 0} recipient${recipients.length === 1 ? '' : 's'}`}</Button>
          </div>
        </div>

        <div className="space-y-3"><p className="text-center text-xs font-semibold text-slate-500">Message preview</p><PhonePreview message={message} recipient={recipients[0] || { name: 'Client' }} attachments={attachments} /></div>
      </div>
    </div>
  );
}

export default function EngageXWhatsAppHubV2() {
  const { user } = useAuth();
  const [tab, setTab] = useState('campaigns');
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connectOpen, setConnectOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [openId, setOpenId] = useState(null);
  const [canManage, setCanManage] = useState(true);
  const [bridgeError, setBridgeError] = useState(null);

  const loadSessions = async () => {
    setLoading(true);
    try {
      const data = await engagexApi.whatsappSessions();
      setSessions(data.sessions || []);
      setCanManage(data.can_manage !== false);
      setBridgeError(data.bridge_error || null);
    }
    catch (error) { toast.error(engagexError(error)); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadSessions(); }, []);

  const connected = sessions.filter(s => s.connected);
  const senderCompany = user?.company_name || user?.company?.name || 'Your company';

  return (
    <div className="space-y-5 sm:space-y-6 w-full min-w-0 text-slate-800 dark:text-slate-100">
      <PageBanner icon={MessageCircle} eyebrow="EngageX · WhatsApp Hub" title="Bulk WhatsApp Messaging" subtitle="Connect your number, compose personalised broadcasts, control message intervals and send multiple attachments from one workspace." stats={[{ label: 'Numbers', value: loading ? '…' : connected.length }]} />

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-100 bg-emerald-50/50 px-4 py-3 dark:border-emerald-900/40 dark:bg-emerald-950/20">
        <div className="flex min-w-0 items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Smartphone className="h-4 w-4" /></div><div><p className="text-sm font-semibold">WhatsApp connection</p><p className="text-xs text-slate-500">{bridgeError ? 'The WhatsApp service is not reachable right now — try Refresh in a moment.' : connected.length ? `${connected.length} connected number${connected.length > 1 ? 's' : ''}: ${connected.map(s => s.phone ? `+${s.phone}` : s.label).join(', ')}` : 'No number connected yet.'}</p></div></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={loadSessions}><RefreshCw className="mr-1.5 h-4 w-4" />Refresh</Button><Button size="sm" onClick={() => setConnectOpen(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white"><Plus className="mr-1.5 h-4 w-4" />{connected.length ? 'Manage numbers' : 'Connect WhatsApp'}</Button></div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap"><TabsTrigger value="campaigns"><Megaphone className="mr-1.5 h-4 w-4" />Campaigns</TabsTrigger><TabsTrigger value="new"><Plus className="mr-1.5 h-4 w-4" />New broadcast</TabsTrigger><TabsTrigger value="optouts"><ShieldOff className="mr-1.5 h-4 w-4" />Opt-outs</TabsTrigger></TabsList>
        <TabsContent value="campaigns" className="mt-4"><ExCard icon={Megaphone} title="Broadcasts" color={BRAND.whatsapp} description="Your existing EngageX campaigns and delivery history."><CampaignTable channel="whatsapp" refreshKey={refreshKey} onOpen={c => setOpenId(c.id)} emptyAction={<Button size="sm" onClick={() => setTab('new')}>New broadcast</Button>} extraActions={<Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setTab('new')}><Plus className="mr-1 h-4 w-4" />New broadcast</Button>} /></ExCard></TabsContent>
        <TabsContent value="new" className="mt-4"><ExCard icon={Send} title="New broadcast" color={BRAND.whatsapp} description="Background sending, explicit recipient interval and multiple attachments."><Composer sessions={sessions} onConnect={() => setConnectOpen(true)} onDone={(campaign) => { setRefreshKey(k => k + 1); setTab('campaigns'); if (campaign?.id) setOpenId(campaign.id); }} /></ExCard></TabsContent>
        <TabsContent value="optouts" className="mt-4"><ExCard icon={ShieldOff} title="Opt-out list" color={BRAND.whatsapp}><OptOutPanel channel="whatsapp" /></ExCard></TabsContent>
      </Tabs>

      <CampaignSheet channel="whatsapp" campaignId={openId} open={!!openId} onOpenChange={open => { if (!open) setOpenId(null); }} onChanged={() => setRefreshKey(k => k + 1)} />
      <WhatsAppConnectDialog open={connectOpen} onOpenChange={setConnectOpen} sessions={sessions} canManage={canManage} onChanged={loadSessions} />
    </div>
  );
}
