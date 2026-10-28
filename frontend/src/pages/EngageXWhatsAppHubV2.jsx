import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Gauge, Link as LinkIcon, Megaphone, MessageCircle, Paperclip, Plus, RefreshCw, Send, ShieldOff, Smartphone, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState, GuidanceNote, PageBanner } from '@/components/ui/PageKit';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import { useBulkWASender } from '@/components/BulkWASenderContext';
import AudienceBuilder from '@/components/engagex/AudienceBuilder';
import { CampaignSheet, CampaignTable } from '@/components/engagex/CampaignViews';
import OptOutPanel from '@/components/engagex/OptOutPanel';
import WhatsAppConnectDialog from '@/components/engagex/WhatsAppConnectDialog';
import { BRAND, ExCard, MergeTagBar, insertAtCursor, previewVariables, renderMergePreview } from '@/components/engagex/shared';

const MAX_ATTACHMENTS = 5;
const MAX_MEDIA_MB = 5;

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function AttachmentPreview({ file, onRemove }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-2.5 dark:border-slate-700 dark:bg-slate-900">
      {file.type?.startsWith('image/') ? <img src={`data:${file.type};base64,${file.base64}`} alt="" className="h-12 w-12 rounded-lg object-cover" /> : <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800"><FileText className="h-5 w-5 text-slate-500" /></div>}
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{file.name}</p><p className="text-[11px] text-slate-500">{file.type || 'file'} · {(file.size / 1024).toFixed(0)} KB</p></div>
      <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" onClick={onRemove}><X className="h-4 w-4" /></Button>
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
          {attachments.map((a) => a.type?.startsWith('image/') ? <img key={a.id} src={`data:${a.type};base64,${a.base64}`} alt="" className="mb-1.5 max-h-36 w-full rounded-md object-cover" /> : <div key={a.id} className="mb-1 flex items-center gap-2 rounded-md bg-black/5 p-1.5"><FileText className="h-3.5 w-3.5" /><span className="truncate text-[10px]">{a.name}</span></div>)}
          {text ? <div className="whitespace-pre-wrap break-words">{text}</div> : null}
        </div>
      </div>
    </div>
  );
}

function Composer({ sessions, onConnect, onRefresh, onDone }) {
  const { startBatch } = useBulkWASender();
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
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const fileRef = useRef(null);
  const messageRef = useRef(null);

  const connected = useMemo(() => sessions.filter(s => s.connected), [sessions]);
  useEffect(() => { if (!sessionId && connected[0]) setSessionId(connected[0].session_id); }, [connected, sessionId]);

  const addFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    if (attachments.length + files.length > MAX_ATTACHMENTS) return toast.error(`You can attach up to ${MAX_ATTACHMENTS} files in one broadcast.`);
    const next = [];
    for (const file of files) {
      if (file.size > MAX_MEDIA_MB * 1024 * 1024) { toast.error(`${file.name} is larger than ${MAX_MEDIA_MB} MB.`); continue; }
      try {
        const base64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '').split(',').pop()); r.onerror = reject; r.readAsDataURL(file); });
        next.push({ id: `${Date.now()}_${file.name}_${Math.random()}`, name: file.name, type: file.type || 'application/octet-stream', size: file.size, base64 });
      } catch { toast.error(`Could not read ${file.name}.`); }
    }
    setAttachments(a => [...a, ...next]);
  };

  const send = async () => {
    if (!recipients.length) return toast.error('Select at least one recipient.');
    if (!message.trim() && !attachments.length) return toast.error('Write a message or add an attachment.');
    if (!sessionId) return toast.error('Connect/select a WhatsApp number first.');
    if (!consent) return toast.error('Confirm that recipients have agreed to receive WhatsApp messages.');
    setSending(true);
    const lo = intervalMode === 'fixed' ? Number(fixedInterval) : Number(minInterval);
    const hi = intervalMode === 'fixed' ? Number(fixedInterval) : Number(maxInterval);
    if (lo < 2 || hi < lo) { setSending(false); return toast.error('Enter a valid interval. Minimum is 2 seconds.'); }

    try {
      const enriched = recipients.map(r => ({ ...r, message, attachments }));
      await startBatch({
        batchName: campaignName.trim() || `EngageX WhatsApp · ${new Date().toLocaleDateString('en-IN')}`,
        recipients: enriched,
        sessionId,
        minDelaySec: lo,
        maxDelaySec: hi,
        pauseEnabled: Number(pauseEvery) > 0,
        pauseAfterCount: Number(pauseEvery),
        pauseDurationSec: Number(pauseSeconds),
        messageType: 'engagex_campaign',
      });
      setMessage(''); setCampaignName(''); setAttachments([]); setRecipients([]); setConsent(false);
      onDone?.();
    } finally { await delay(250); setSending(false); }
  };

  return (
    <div className="space-y-5">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5 min-w-0">
          <AudienceBuilder channel="whatsapp" value={recipients} onChange={setRecipients} />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm font-medium">Campaign name<Input className="mt-1.5" value={campaignName} onChange={e => setCampaignName(e.target.value)} placeholder="e.g. October GST reminder" maxLength={160} /></label>
            <label className="text-sm font-medium">Send from
              <select className="mt-1.5 h-10 w-full rounded-md border bg-background px-3 text-sm" value={sessionId} onChange={e => setSessionId(e.target.value)}>
                <option value="">Select WhatsApp number</option>{connected.map(s => <option key={s.session_id} value={s.session_id}>{s.label} {s.phone ? `(+${s.phone})` : ''}</option>)}
              </select>
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="mb-2 flex items-center justify-between"><span className="text-sm font-semibold">Message</span><span className="text-[11px] text-slate-400">{message.length}/4096</span></div>
            <MergeTagBar onInsert={tag => setMessage(m => insertAtCursor(messageRef.current, m, tag))} extra={Object.keys(recipients[0]?.variables || {})} />
            <Textarea ref={messageRef} className="mt-2" rows={8} maxLength={4096} value={message} onChange={e => setMessage(e.target.value)} placeholder="Hi {{first_name|there}},\n\nYour compliance reminder..." />
            <p className="mt-1.5 text-[11px] text-slate-500">Supports WhatsApp formatting such as *bold*, _italic_ and ~strikethrough~.</p>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="mb-3 flex items-center justify-between"><div><p className="text-sm font-semibold">Multiple attachments</p><p className="text-[11px] text-slate-500">Attach up to {MAX_ATTACHMENTS} images, PDFs, Word, Excel, PowerPoint or videos.</p></div><Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={attachments.length >= MAX_ATTACHMENTS}><Paperclip className="mr-1.5 h-4 w-4" />Add files</Button></div>
            <input ref={fileRef} type="file" multiple className="hidden" accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,video/mp4" onChange={addFiles} />
            {attachments.length ? <div className="grid gap-2 sm:grid-cols-2">{attachments.map((a, i) => <AttachmentPreview key={a.id} file={a} onRemove={() => setAttachments(items => items.filter((_, x) => x !== i))} />)}</div> : <button type="button" onClick={() => fileRef.current?.click()} className="w-full rounded-xl border-2 border-dashed border-slate-300 p-5 text-center text-sm text-slate-500 hover:border-emerald-400 hover:text-emerald-700"><Paperclip className="mx-auto mb-2 h-5 w-5" />Click to add multiple attachments</button>}
            <p className="mt-2 text-[11px] text-slate-500">WhatsApp/bridge delivery treats each selected file as a media message in the same broadcast, preserving the selected recipient interval between recipients.</p>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <div className="mb-3 flex items-center gap-2"><Gauge className="h-4 w-4 text-emerald-600" /><p className="text-sm font-semibold">Interval between messages</p></div>
            <div className="flex gap-2 mb-3"><button type="button" onClick={() => setIntervalMode('fixed')} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${intervalMode === 'fixed' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200'}`}>Fixed interval</button><button type="button" onClick={() => setIntervalMode('random')} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${intervalMode === 'random' ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200'}`}>Random interval</button></div>
            {intervalMode === 'fixed' ? <label className="block text-xs font-semibold text-slate-500">Every (seconds)<Input type="number" min="2" max="600" value={fixedInterval} onChange={e => setFixedInterval(e.target.value)} className="mt-1.5 max-w-xs" /></label> : <div className="grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-500">Minimum seconds<Input type="number" min="2" max="300" value={minInterval} onChange={e => setMinInterval(e.target.value)} className="mt-1.5" /></label><label className="text-xs font-semibold text-slate-500">Maximum seconds<Input type="number" min="2" max="600" value={maxInterval} onChange={e => setMaxInterval(e.target.value)} className="mt-1.5" /></label></div>}
            <div className="mt-3 grid grid-cols-2 gap-3"><label className="text-xs font-semibold text-slate-500">Pause every messages<Input type="number" min="0" max="1000" value={pauseEvery} onChange={e => setPauseEvery(e.target.value)} className="mt-1.5" /></label><label className="text-xs font-semibold text-slate-500">Pause duration (sec)<Input type="number" min="0" max="3600" value={pauseSeconds} onChange={e => setPauseSeconds(e.target.value)} className="mt-1.5" /></label></div>
            <GuidanceNote icon={Gauge} className="mt-3">The interval is enforced by the background sender, so closing the browser page does not stop an active broadcast.</GuidanceNote>
          </div>

          <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
            <label className="flex items-start gap-2 text-sm"><Checkbox checked={consent} onCheckedChange={v => setConsent(Boolean(v))} className="mt-0.5" /><span>I confirm these recipients are clients or contacts who have agreed to receive WhatsApp messages from us.</span></label>
            <Button onClick={send} disabled={sending || !connected.length} className="mt-4 w-full bg-emerald-600 hover:bg-emerald-700 text-white"><Send className="mr-2 h-4 w-4" />{sending ? 'Starting broadcast…' : `Send to ${recipients.length || 0} recipients`}</Button>
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

  const loadSessions = async () => {
    setLoading(true);
    try { const data = await engagexApi.whatsappSessions(); setSessions(data.sessions || []); }
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
        <div className="flex min-w-0 items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-100 text-emerald-700"><Smartphone className="h-4 w-4" /></div><div><p className="text-sm font-semibold">WhatsApp connection</p><p className="text-xs text-slate-500">{connected.length ? `${connected.length} connected number${connected.length > 1 ? 's' : ''}` : 'No number connected yet.'}</p></div></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={loadSessions}><RefreshCw className="mr-1.5 h-4 w-4" />Refresh</Button><Button size="sm" onClick={() => setConnectOpen(true)} className="bg-emerald-600 hover:bg-emerald-700 text-white"><Plus className="mr-1.5 h-4 w-4" />Connect WhatsApp</Button></div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap"><TabsTrigger value="campaigns"><Megaphone className="mr-1.5 h-4 w-4" />Campaigns</TabsTrigger><TabsTrigger value="new"><Plus className="mr-1.5 h-4 w-4" />New broadcast</TabsTrigger><TabsTrigger value="optouts"><ShieldOff className="mr-1.5 h-4 w-4" />Opt-outs</TabsTrigger></TabsList>
        <TabsContent value="campaigns" className="mt-4"><ExCard icon={Megaphone} title="Broadcasts" color={BRAND.whatsapp} description="Your existing EngageX campaigns and delivery history."><CampaignTable channel="whatsapp" refreshKey={refreshKey} onOpen={c => setOpenId(c.id)} emptyAction={<Button size="sm" onClick={() => setTab('new')}>New broadcast</Button>} extraActions={<Button size="sm" className="bg-emerald-600 hover:bg-emerald-700 text-white" onClick={() => setTab('new')}><Plus className="mr-1 h-4 w-4" />New broadcast</Button>} /></ExCard></TabsContent>
        <TabsContent value="new" className="mt-4"><ExCard icon={Send} title="New broadcast" color={BRAND.whatsapp} description="Background sending, explicit recipient interval and multiple attachments."><Composer sessions={sessions} onConnect={() => setConnectOpen(true)} onRefresh={loadSessions} onDone={() => { setRefreshKey(k => k + 1); }} /></ExCard></TabsContent>
        <TabsContent value="optouts" className="mt-4"><ExCard icon={ShieldOff} title="Opt-out list" color={BRAND.whatsapp}><OptOutPanel channel="whatsapp" /></ExCard></TabsContent>
      </Tabs>

      <CampaignSheet channel="whatsapp" campaignId={openId} open={!!openId} onOpenChange={open => { if (!open) setOpenId(null); }} onChanged={() => setRefreshKey(k => k + 1)} />
      <WhatsAppConnectDialog open={connectOpen} onOpenChange={setConnectOpen} sessions={sessions} onChanged={loadSessions} />
    </div>
  );
}
