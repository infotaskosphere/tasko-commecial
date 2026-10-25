import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, RefreshCw, Send, Smartphone, Users, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';

const HISTORY_KEY = 'onenexa.engagex.message-history';
const readHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const writeHistory = (rows) => localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(-1000)));
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const normalizePhone = (value) => { const digits = String(value || '').replace(/\D/g, ''); return digits.length < 8 ? null : digits; };
const parseRecipients = (text) => Array.from(new Map(String(text || '').split(/\r?\n|,/).map(normalizePhone).filter(Boolean).map(phone => [phone, phone])).values());

export default function EngageXWhatsAppHub() {
  const [recipientsText, setRecipientsText] = useState('');
  const [message, setMessage] = useState('');
  const [name, setName] = useState('');
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ sent: 0, failed: 0, total: 0 });
  const [recent, setRecent] = useState(() => readHistory().filter(x => x.channel === 'whatsapp').slice(-8).reverse());
  const recipients = useMemo(() => parseRecipients(recipientsText), [recipientsText]);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await api.get('/whatsapp/sessions');
      const connected = (data?.sessions || []).filter(s => ['connected', 'open', 'ready'].includes(String(s.status || '').toLowerCase()) || s.connected === true);
      setSessions(connected);
      if (!sessionId && connected[0]?.sessionId) setSessionId(connected[0].sessionId);
    } catch { setSessions([]); }
  }, [sessionId]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const addHistory = (entry) => {
    const rows = [...readHistory(), entry];
    writeHistory(rows);
    setRecent(rows.filter(x => x.channel === 'whatsapp').slice(-8).reverse());
    window.dispatchEvent(new Event('storage'));
  };

  const sendCampaign = async () => {
    if (!sessionId) return toast.error('Connect a WhatsApp number first.');
    if (!recipients.length) return toast.error('Add at least one valid recipient number.');
    if (!message.trim()) return toast.error('Enter the campaign message.');
    if (running) return;
    setRunning(true);
    setProgress({ sent: 0, failed: 0, total: recipients.length });
    const campaignName = name.trim() || 'WhatsApp Broadcast';
    let sent = 0; let failed = 0;

    for (const phone of recipients) {
      const jid = `${phone}@s.whatsapp.net`;
      const personalized = message.replace(/\{\{phone\}\}/gi, phone);
      try {
        await api.post('/whatsapp/hub/send', { jid, message: personalized, session_id: sessionId });
        sent += 1;
        addHistory({ id: `${Date.now()}-${phone}`, createdAt: new Date().toISOString(), channel: 'whatsapp', name: campaignName, recipients: 1, status: 'sent', phone, message: personalized });
      } catch (error) {
        failed += 1;
        addHistory({ id: `${Date.now()}-${phone}-failed`, createdAt: new Date().toISOString(), channel: 'whatsapp', name: campaignName, recipients: 1, status: 'failed', phone, error: error?.response?.data?.detail || error?.message || 'Send failed' });
      }
      setProgress({ sent, failed, total: recipients.length });
      if (sent + failed < recipients.length) await wait(450);
    }

    setRunning(false);
    toast.success(`Campaign finished: ${sent} sent, ${failed} failed.`);
    setRecipientsText(''); setMessage(''); setName('');
  };

  return <div className="min-h-full bg-slate-50 p-6"><div className="mx-auto max-w-7xl space-y-6">
    <div className="rounded-2xl bg-gradient-to-r from-[#0D3B66] via-[#1479D1] to-[#00B894] p-7 text-white shadow-lg"><div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">EngageX · WhatsApp Hub</p><h1 className="mt-2 text-3xl font-bold">Bulk WhatsApp Messaging</h1><p className="mt-2 max-w-3xl text-sm text-white/80">Send tenant-scoped campaigns through the existing connected WhatsApp bridge, with per-recipient success and failure history.</p></div><div className="rounded-xl bg-white/10 px-5 py-3"><div className="flex items-center gap-2 text-sm"><Smartphone size={17}/>{sessions.length} connected number{sessions.length === 1 ? '' : 's'}</div></div></div></div>
    <div className="grid gap-6 lg:grid-cols-[1.35fr_.65fr]">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-slate-700">Campaign name<input value={name} onChange={e=>setName(e.target.value)} placeholder="October compliance campaign" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-cyan-500" /></label><label className="text-sm font-medium text-slate-700">Sending number<select value={sessionId} onChange={e=>setSessionId(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-cyan-500"><option value="">Select connected number</option>{sessions.map(s=><option key={s.sessionId} value={s.sessionId}>{s.label || s.phone || s.sessionId}</option>)}</select></label></div>
        <label className="mt-5 block text-sm font-medium text-slate-700">WhatsApp numbers<textarea value={recipientsText} onChange={e=>setRecipientsText(e.target.value)} rows="9" placeholder="9198XXXXXXXX\n9199XXXXXXXX" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 font-mono text-sm outline-none focus:border-cyan-500" /></label><div className="mt-2 flex items-center gap-2 text-xs text-slate-500"><Users size={14}/><b>{recipients.length}</b> unique recipients detected · one number per line or comma-separated.</div>
        <label className="mt-5 block text-sm font-medium text-slate-700">Message<textarea value={message} onChange={e=>setMessage(e.target.value)} rows="7" placeholder="Hello, your compliance update is ready. Use {{phone}} when required." className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 outline-none focus:border-cyan-500" /></label>
        {running && <div className="mt-4 rounded-lg bg-slate-50 p-4"><div className="flex justify-between text-xs font-semibold text-slate-600"><span>Sending campaign</span><span>{progress.sent + progress.failed}/{progress.total}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{width:`${progress.total ? ((progress.sent + progress.failed) / progress.total) * 100 : 0}%`}} /></div><div className="mt-2 flex gap-4 text-xs"><span className="text-emerald-700">{progress.sent} sent</span><span className="text-rose-700">{progress.failed} failed</span></div></div>}
        <div className="mt-5 flex justify-end"><button disabled={running || !sessionId || !recipients.length || !message.trim()} onClick={sendCampaign} className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><Send size={16}/>{running ? 'Sending…' : 'Send Campaign'}</button></div>
      </section>
      <aside className="space-y-4"><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h2 className="font-semibold text-slate-900">Delivery safety</h2><AlertCircle size={18} className="text-amber-500"/></div><ul className="mt-4 space-y-3 text-sm text-slate-600"><li>• Use only opted-in contacts.</li><li>• Respect provider/template policies.</li><li>• Campaigns are sent sequentially through the existing bridge.</li><li>• Failed recipients are recorded individually.</li></ul></div><div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h2 className="font-semibold text-slate-900">Recent deliveries</h2><button onClick={loadSessions} className="text-slate-400 hover:text-slate-700"><RefreshCw size={16}/></button></div><div className="mt-4 space-y-3">{recent.length ? recent.map(row=><div key={row.id} className="rounded-lg bg-slate-50 p-3"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-semibold text-slate-800">{row.name}</span>{row.status === 'sent' ? <CheckCircle2 size={16} className="text-emerald-500"/> : <XCircle size={16} className="text-rose-500"/>}</div><div className="mt-1 flex items-center gap-2 text-xs text-slate-500"><Clock3 size={12}/>{new Date(row.createdAt).toLocaleString()} · {row.phone}</div></div>) : <p className="text-sm text-slate-400">No campaign deliveries yet.</p>}</div></div></aside>
    </div>
  </div></div>;
}
