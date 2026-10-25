import React, { useMemo, useState } from 'react';
import { CheckCircle2, Clock3, Eye, Mail, Send, Users } from 'lucide-react';
import { toast } from 'sonner';

const HISTORY_KEY = 'onenexa.engagex.message-history';
const readHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } };
const writeHistory = rows => localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(-1000)));
const parseEmails = value => Array.from(new Set(String(value || '').split(/\r?\n|,/).map(v => v.trim().toLowerCase()).filter(v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))));

export default function EngageXMailMaster() {
  const [campaign, setCampaign] = useState('');
  const [subject, setSubject] = useState('');
  const [audience, setAudience] = useState('');
  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
  const [schedule, setSchedule] = useState('Send now');
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState(() => readHistory().filter(x => x.channel === 'email').slice(-10).reverse());
  const recipients = useMemo(() => parseEmails(audience), [audience]);

  const createCampaign = () => {
    if (!recipients.length) return toast.error('Add at least one valid email address.');
    if (!subject.trim()) return toast.error('Enter an email subject.');
    if (!body.trim()) return toast.error('Write the campaign content.');
    setSaving(true);
    const entry = { id: crypto.randomUUID?.() || String(Date.now()), createdAt: new Date().toISOString(), channel: 'email', name: campaign.trim() || 'Email Campaign', subject: subject.trim(), recipients: recipients.length, status: schedule === 'Send now' ? 'queued' : 'scheduled', body };
    const rows = [...readHistory(), entry];
    writeHistory(rows);
    setHistory(rows.filter(x => x.channel === 'email').slice(-10).reverse());
    window.dispatchEvent(new Event('storage'));
    setSaving(false);
    toast.success(schedule === 'Send now' ? 'Campaign added to EngageX delivery queue.' : 'Campaign scheduled in EngageX.');
    setCampaign(''); setSubject(''); setAudience(''); setBody(''); setPreview(false);
  };

  return <div className="min-h-full bg-slate-50 p-6"><div className="mx-auto max-w-7xl space-y-6">
    <div className="rounded-2xl bg-gradient-to-r from-[#243B80] via-[#4169D8] to-[#00A98F] p-7 text-white shadow-lg"><div className="flex flex-wrap items-end justify-between gap-5"><div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">EngageX · MailMaster</p><h1 className="mt-2 text-3xl font-bold">Bulk Email Marketing</h1><p className="mt-2 max-w-3xl text-sm text-white/80">Build professional campaigns with audience validation, content preview, scheduling and delivery history.</p></div><div className="rounded-xl bg-white/10 px-5 py-3"><div className="flex items-center gap-2 text-sm"><Users size={17}/>{recipients.length} valid recipients</div></div></div></div>
    <div className="grid gap-6 xl:grid-cols-[1.2fr_.8fr]">
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-slate-700">Campaign name<input value={campaign} onChange={e=>setCampaign(e.target.value)} placeholder="October client newsletter" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-indigo-500" /></label><label className="text-sm font-medium text-slate-700">Delivery<select value={schedule} onChange={e=>setSchedule(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 outline-none focus:border-indigo-500"><option>Send now</option><option>Schedule for later</option></select></label></div>
        <label className="mt-5 block text-sm font-medium text-slate-700">Audience emails<textarea value={audience} onChange={e=>setAudience(e.target.value)} rows="7" placeholder="client@example.com\ncontact@example.com" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 font-mono text-sm outline-none focus:border-indigo-500" /></label><div className="mt-2 flex items-center justify-between text-xs"><span className="text-slate-400">One email per line or comma-separated.</span><span className="font-semibold text-indigo-600">{recipients.length} valid</span></div>
        <label className="mt-5 block text-sm font-medium text-slate-700">Subject<input value={subject} onChange={e=>setSubject(e.target.value)} placeholder="Important update from your business" className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2.5 outline-none focus:border-indigo-500" /></label>
        <label className="mt-5 block text-sm font-medium text-slate-700">Campaign content<textarea value={body} onChange={e=>setBody(e.target.value)} rows="13" placeholder="Write your campaign content here…\n\nYou can use {{name}} in your copy for future contact-personalisation support." className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-3 outline-none focus:border-indigo-500" /></label>
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4"><button type="button" onClick={()=>setPreview(v=>!v)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Eye size={16}/>{preview ? 'Hide Preview' : 'Preview Email'}</button><button disabled={saving || !recipients.length || !subject.trim() || !body.trim()} onClick={createCampaign} className="inline-flex items-center gap-2 rounded-lg bg-indigo-700 px-5 py-3 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"><Send size={16}/>{saving ? 'Saving…' : schedule === 'Send now' ? 'Queue Campaign' : 'Schedule Campaign'}</button></div>
        {preview && <div className="mt-5 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"><div className="border-b bg-slate-50 px-5 py-3 text-xs text-slate-500">EMAIL PREVIEW</div><div className="p-7"><h2 className="text-xl font-bold text-slate-900">{subject || 'Your subject line'}</h2><div className="prose mt-5 max-w-none whitespace-pre-wrap text-sm text-slate-700">{body || 'Your campaign content will appear here.'}</div></div></div>}
      </section>
      <aside className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">MailMaster workflow</h2><div className="mt-4 space-y-3 text-sm text-slate-600"><div className="rounded-lg bg-slate-50 p-3"><b>1. Audience</b><br/>Validate and deduplicate recipients.</div><div className="rounded-lg bg-slate-50 p-3"><b>2. Content</b><br/>Subject, message and preview.</div><div className="rounded-lg bg-slate-50 p-3"><b>3. Delivery</b><br/>Queue now or schedule.</div><div className="rounded-lg bg-slate-50 p-3"><b>4. History</b><br/>Track every campaign record in EngageX.</div></div></div>
        <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-5 text-sm text-indigo-900"><b>Delivery provider</b><p className="mt-1 text-indigo-800/80">The current application contains inbound email/IMAP functionality but no outbound bulk-email provider endpoint. MailMaster therefore records validated campaigns without pretending they were delivered. Connect SMTP, SES, SendGrid or another approved provider before enabling production delivery.</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center gap-2"><Mail size={17} className="text-indigo-600"/><h2 className="font-semibold text-slate-900">Recent campaigns</h2></div><div className="mt-4 space-y-3">{history.length ? history.map(row=><div key={row.id} className="rounded-lg bg-slate-50 p-3"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-semibold text-slate-800">{row.name}</span><CheckCircle2 size={16} className="text-indigo-500"/></div><div className="mt-1 flex items-center gap-2 text-xs text-slate-500"><Clock3 size={12}/>{new Date(row.createdAt).toLocaleString()} · {row.recipients} recipients · {row.status}</div></div>) : <p className="text-sm text-slate-400">No campaigns yet.</p>}</div></div>
      </aside>
    </div>
  </div></div>;
}
