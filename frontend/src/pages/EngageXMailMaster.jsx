// EngageX · MailMaster — Mailchimp-style bulk email for the company: audiences,
// templates, campaign builder, sender accounts and delivery reports.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  AlertTriangle, AtSign, CalendarClock, CheckCircle2, ChevronLeft, Circle, Contact, FileText, ImageIcon, Inbox, KeyRound, Loader2, Mail,
  Megaphone, Paperclip, Pencil, Plus, RefreshCw, Send, Server, ShieldCheck, ShieldOff, Star, Trash2, Upload, Users, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState, GuidanceNote, LoadingState, PageBanner } from '@/components/ui/PageKit';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { engagexApi, engagexError } from '@/lib/engagexApi';
import AudienceBuilder from '@/components/engagex/AudienceBuilder';
import EmailEditor, { STARTER_TEMPLATES, previewDocument } from '@/components/engagex/EmailEditor';
import { CampaignSheet, CampaignTable } from '@/components/engagex/CampaignViews';
import OptOutPanel from '@/components/engagex/OptOutPanel';
import { BRAND, ExCard, MergeTagBar, fmtAgo, fmtDuration, fmtNumber, localDateTimeValue, previewVariables, renderMergePreview } from '@/components/engagex/shared';

const PLATFORM = 'platform';

// ═════════════════════════════════════════════════════════════════════════════
// Senders
// ═════════════════════════════════════════════════════════════════════════════
const PROVIDERS = {
  outlook: { label: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls', help: 'Authenticated SMTP must be enabled for the mailbox in the Microsoft 365 admin centre.' },
  zoho: { label: 'Zoho Mail (India)', host: 'smtp.zoho.in', port: 465, security: 'ssl', help: 'Use smtp.zoho.com for non-India accounts. An app-specific password is recommended.' },
  yahoo: { label: 'Yahoo Mail', host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl', help: 'Generate an app password in Yahoo account security settings.' },
  ses: { label: 'Amazon SES', host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, security: 'starttls', help: 'Use SES SMTP credentials (not your AWS keys) and a verified sender. Change the region in the host if needed.' },
  sendgrid: { label: 'SendGrid', host: 'smtp.sendgrid.net', port: 587, security: 'starttls', username: 'apikey', help: 'Username is literally "apikey"; the password is your SendGrid API key. The From address must be a verified sender.' },
  brevo: { label: 'Brevo (Sendinblue)', host: 'smtp-relay.brevo.com', port: 587, security: 'starttls', help: 'Use the SMTP login and SMTP key from Brevo → SMTP & API.' },
  mailgun: { label: 'Mailgun', host: 'smtp.mailgun.org', port: 587, security: 'starttls', help: 'Use the SMTP credentials of your Mailgun sending domain.' },
  hosting: { label: 'Domain / cPanel / Hostinger', host: '', port: 465, security: 'ssl', help: 'Use the outgoing (SMTP) server shown in your hosting control panel, e.g. mail.yourdomain.com.' },
  custom: { label: 'Other SMTP server', host: '', port: 587, security: 'starttls', help: 'Enter the SMTP details from your email provider.' },
};

const emptySender = { provider: 'outlook', label: '', from_name: '', from_email: '', reply_to: '', smtp_host: PROVIDERS.outlook.host, smtp_port: 587, security: 'starttls', username: '', password: '' };

function SenderDialog({ open, onOpenChange, initial, companyName, onSaved }) {
  const [form, setForm] = useState(emptySender);
  const [saving, setSaving] = useState(false);
  const editing = !!initial?.id;
  useEffect(() => {
    if (!open) return;
    setForm(editing ? {
      provider: 'custom', label: initial.label, from_name: initial.from_name, from_email: initial.from_email, reply_to: initial.reply_to || '',
      smtp_host: initial.smtp_host, smtp_port: initial.smtp_port, security: initial.security, username: '', password: '',
    } : { ...emptySender, from_name: companyName || '' });
  }, [open, editing, initial, companyName]);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const chooseProvider = (provider) => {
    const p = PROVIDERS[provider];
    set({ provider, smtp_host: p.host, smtp_port: p.port, security: p.security, username: p.username || '' });
  };
  const save = async () => {
    if (!form.from_email || !form.smtp_host) return toast.error('From email and SMTP server are required.');
    if (!editing && !form.password) return toast.error('Enter the password or app password.');
    setSaving(true);
    try {
      const body = {
        label: form.label || form.from_email, from_name: form.from_name || companyName || form.from_email, from_email: form.from_email,
        reply_to: form.reply_to || null, smtp_host: form.smtp_host, smtp_port: Number(form.smtp_port), security: form.security,
        username: form.username || form.from_email, password: form.password || null, verify: true,
      };
      if (editing) await engagexApi.updateSender(initial.id, body); else await engagexApi.createSender(body);
      toast.success('Sender verified and saved');
      onSaved(); onOpenChange(false);
    } catch (error) { toast.error(engagexError(error)); } finally { setSaving(false); }
  };
  const provider = PROVIDERS[form.provider] || PROVIDERS.custom;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit sender' : 'Connect another email provider'}</DialogTitle>
          <DialogDescription>For Outlook, Zoho or a domain mailbox. Using Gmail? Close this and choose “Continue with Google” — no password needed.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {!editing && (
            <label className="block text-xs font-semibold text-slate-500">Provider
              <Select value={form.provider} onValueChange={chooseProvider}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(PROVIDERS).map(([k, p]) => <SelectItem key={k} value={k}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          )}
          {!editing && <GuidanceNote icon={KeyRound}>{provider.help}</GuidanceNote>}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-500">From name<Input className="mt-1" value={form.from_name} onChange={(e) => set({ from_name: e.target.value })} placeholder="Acme Advisors" /></label>
            <label className="text-xs font-semibold text-slate-500">From email *<Input className="mt-1" type="email" value={form.from_email} onChange={(e) => set({ from_email: e.target.value })} placeholder="news@yourdomain.com" /></label>
            <label className="text-xs font-semibold text-slate-500">Reply-To (optional)<Input className="mt-1" type="email" value={form.reply_to} onChange={(e) => set({ reply_to: e.target.value })} placeholder="hello@yourdomain.com" /></label>
            <label className="text-xs font-semibold text-slate-500">Label<Input className="mt-1" value={form.label} onChange={(e) => set({ label: e.target.value })} placeholder="Marketing mailbox" /></label>
          </div>
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_90px_130px]">
            <label className="text-xs font-semibold text-slate-500">SMTP server *<Input className="mt-1" value={form.smtp_host} onChange={(e) => set({ smtp_host: e.target.value })} placeholder="smtp.example.com" /></label>
            <label className="text-xs font-semibold text-slate-500">Port<Input className="mt-1" type="number" value={form.smtp_port} onChange={(e) => set({ smtp_port: e.target.value })} /></label>
            <label className="text-xs font-semibold text-slate-500">Security
              <Select value={form.security} onValueChange={(v) => set({ security: v })}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="starttls">STARTTLS</SelectItem><SelectItem value="ssl">SSL/TLS</SelectItem><SelectItem value="none">None</SelectItem></SelectContent>
              </Select>
            </label>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-slate-500">Username<Input className="mt-1" value={form.username} onChange={(e) => set({ username: e.target.value })} placeholder={form.from_email || 'Usually your email address'} autoComplete="off" /></label>
            <label className="text-xs font-semibold text-slate-500">{editing ? 'New password (leave blank to keep)' : 'Password / app password *'}<Input className="mt-1" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" /></label>
          </div>
        </div>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Verifying…</> : 'Verify & save'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Official multi-colour Google "G" mark for the sign-in button. */
export function GoogleMark({ className = 'h-5 w-5' }) {
  return (
    <svg className={className} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Starts Google sign-in: the browser goes to Google's account chooser and comes back connected. */
export function useGoogleConnect() {
  const [connecting, setConnecting] = useState(false);
  const connect = async () => {
    setConnecting(true);
    try {
      const { auth_url: url } = await engagexApi.startGoogleSender('/engagex/mailmaster?tab=senders');
      window.location.assign(url);
    } catch (error) {
      toast.error(engagexError(error));
      setConnecting(false);
    }
  };
  return { connect, connecting };
}

export function GoogleButton({ onClick, busy, children = 'Continue with Google', className = '' }) {
  return (
    <button type="button" onClick={onClick} disabled={busy}
      className={`inline-flex items-center justify-center gap-3 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:shadow disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 ${className}`}>
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <GoogleMark />}
      {busy ? 'Opening Google…' : children}
    </button>
  );
}

function SenderNameDialog({ sender, onOpenChange, onSaved }) {
  const [fromName, setFromName] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (sender) { setFromName(sender.from_name || ''); setReplyTo(sender.reply_to || ''); } }, [sender]);
  const save = async () => {
    setSaving(true);
    try { await engagexApi.updateSenderProfile(sender.id, { from_name: fromName, reply_to: replyTo || null }); toast.success('Sender updated'); onSaved(); onOpenChange(false); }
    catch (error) { toast.error(engagexError(error)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={!!sender} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Sender details</DialogTitle><DialogDescription>{sender?.from_email}</DialogDescription></DialogHeader>
        <label className="text-xs font-semibold text-slate-500">Name recipients see<Input className="mt-1" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your company name" /></label>
        <label className="text-xs font-semibold text-slate-500">Reply-To (optional)<Input className="mt-1" type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} placeholder="Replies go to the mailbox itself when empty" /></label>
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={saving || !fromName.trim()}>{saving ? 'Saving…' : 'Save'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SendersPanel({ senders, canManage, companyName, reload }) {
  const [editing, setEditing] = useState(null);
  const [naming, setNaming] = useState(null);
  const [testing, setTesting] = useState(null);
  const { user } = useAuth();
  const [testTo, setTestTo] = useState(user?.email || '');
  const { connect, connecting } = useGoogleConnect();

  const act = async (fn, ok) => { try { await fn(); toast.success(ok); reload(); } catch (error) { toast.error(engagexError(error)); } };
  const sendTest = async () => {
    try { await engagexApi.testSend({ to: testTo, sender_id: testing.id, subject: 'MailMaster sender test', html: '<p>Hi {{first_name|there}},</p><p>Your MailMaster sender is working. 🎉</p>' }); toast.success(`Test email sent to ${testTo}`); setTesting(null); }
    catch (error) { toast.error(engagexError(error)); }
  };
  const icon = (s) => (s.kind === PLATFORM ? <Server className="h-4 w-4" /> : s.kind === 'google' ? <GoogleMark className="h-4 w-4" /> : <AtSign className="h-4 w-4" />);
  const subtitle = (s) => (s.kind === PLATFORM ? 'Commercial Console email service' : s.kind === 'google' ? 'Connected with Google' : `${s.smtp_host}:${s.smtp_port}`);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-col items-start gap-4 rounded-2xl border border-slate-200 bg-gradient-to-br from-white to-indigo-50/60 p-5 sm:flex-row sm:items-center sm:justify-between dark:border-slate-700 dark:from-slate-900 dark:to-indigo-500/10">
          <div>
            <p className="text-base font-bold text-slate-800 dark:text-slate-100">Send from your own Gmail or Google Workspace address</p>
            <p className="mt-1 max-w-xl text-sm text-slate-500">Choose your Google account, allow sending, and you’re done — no passwords or app passwords. MailMaster can only send email; it can never read your inbox.</p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <GoogleButton onClick={connect} busy={connecting} className="px-5 py-3" />
            <button type="button" onClick={() => setEditing({})} className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline dark:hover:text-slate-200">Use Outlook, Zoho or a domain mailbox instead</button>
          </div>
        </div>
      )}
      <GuidanceNote icon={ShieldCheck}>Without a connected account, MailMaster sends through the platform email service with <b>your company name</b> as the sender and <b>your company email</b> as Reply-To.</GuidanceNote>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {senders.map((s) => (
          <div key={s.id} className={`rounded-xl border p-4 ${s.is_default ? 'border-teal-400 ring-1 ring-teal-400/40' : 'border-slate-200 dark:border-slate-700'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <div className={`rounded-lg p-2 ${s.kind === PLATFORM ? 'bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' : s.kind === 'google' ? 'bg-white ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-700' : 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300'}`}>{icon(s)}</div>
                <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{s.kind === 'google' ? s.from_email : s.label}</p><p className="truncate text-[11px] text-slate-500">{subtitle(s)}</p></div>
              </div>
              {s.is_default && <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[10px] font-bold text-teal-700 dark:bg-teal-500/15 dark:text-teal-300">DEFAULT</span>}
            </div>
            <dl className="mt-3 space-y-1 text-xs">
              <div className="flex justify-between gap-2"><dt className="shrink-0 text-slate-500">From</dt><dd className="truncate text-right text-slate-700 dark:text-slate-200">{s.from_name} &lt;{s.from_email || 'not configured'}&gt;</dd></div>
              <div className="flex justify-between gap-2"><dt className="shrink-0 text-slate-500">Reply-To</dt><dd className="truncate text-right text-slate-700 dark:text-slate-200">{s.reply_to || (s.kind === 'google' ? 'Same mailbox' : '—')}</dd></div>
            </dl>
            {s.kind === PLATFORM && !s.enabled && <p className="mt-2 text-[11px] text-amber-600">The platform service is not configured yet — connect your Google account above.</p>}
            {s.last_error && <p className="mt-2 text-[11px] text-rose-600">{s.last_error}</p>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" onClick={() => setTesting(s)}><Send className="h-3.5 w-3.5 mr-1" />Test</Button>
              {canManage && !s.is_default && <Button size="sm" variant="outline" onClick={() => act(() => engagexApi.setDefaultSender(s.id), 'Default sender updated')}><Star className="h-3.5 w-3.5 mr-1" />Make default</Button>}
              {canManage && s.kind === 'google' && s.last_error && <Button size="sm" variant="outline" onClick={connect}><RefreshCw className="h-3.5 w-3.5 mr-1" />Reconnect</Button>}
              {canManage && s.kind !== PLATFORM && <Button size="icon" variant="ghost" className="h-8 w-8" title="Edit" onClick={() => (s.kind === 'google' ? setNaming(s) : setEditing(s))}><Pencil className="h-4 w-4" /></Button>}
              {canManage && s.kind !== PLATFORM && <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" title="Remove" onClick={() => { if (window.confirm(`Disconnect ${s.from_email}?`)) act(() => engagexApi.deleteSender(s.id), 'Sender removed'); }}><Trash2 className="h-4 w-4" /></Button>}
            </div>
          </div>
        ))}
      </div>
      {!canManage && <p className="text-xs text-slate-500">Only administrators can connect or change sender accounts.</p>}
      <SenderDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} initial={editing} companyName={companyName} onSaved={reload} />
      <SenderNameDialog sender={naming} onOpenChange={(o) => !o && setNaming(null)} onSaved={reload} />
      <Dialog open={!!testing} onOpenChange={(o) => !o && setTesting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Send a test email</DialogTitle><DialogDescription>From {testing?.from_name} &lt;{testing?.from_email}&gt;</DialogDescription></DialogHeader>
          <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@example.com" />
          <DialogFooter><Button variant="ghost" onClick={() => setTesting(null)}>Cancel</Button><Button onClick={sendTest}>Send test</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Audience lists
// ═════════════════════════════════════════════════════════════════════════════
function ListContacts({ list, onBack, onChanged }) {
  const [state, setState] = useState({ loading: true, items: [], total: 0 });
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [incoming, setIncoming] = useState([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try { const data = await engagexApi.contacts(list.id, { q, page_size: 100 }); setState({ loading: false, items: data.items || [], total: data.total || 0 }); }
    catch (error) { setState((s) => ({ ...s, loading: false })); toast.error(engagexError(error)); }
  }, [list.id, q]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await engagexApi.addContacts(list.id, incoming);
      toast.success(`${fmtNumber(res.added)} added, ${fmtNumber(res.updated)} updated${res.invalid ? `, ${res.invalid} invalid skipped` : ''}`);
      setIncoming([]); setAdding(false); load(); onChanged();
    } catch (error) { toast.error(engagexError(error)); } finally { setSaving(false); }
  };
  const remove = async (c) => { try { await engagexApi.removeContact(list.id, c.id); load(); onChanged(); } catch (error) { toast.error(engagexError(error)); } };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}><ChevronLeft className="h-4 w-4 mr-1" />All lists</Button>
        <div className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" className="h-9 w-[220px]" />
          <Button size="sm" onClick={() => setAdding((v) => !v)}><Plus className="h-4 w-4 mr-1" />Add contacts</Button>
        </div>
      </div>
      <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100">{list.name}</h3>
      {adding && (
        <div className="space-y-3 rounded-xl border border-teal-200 p-4 dark:border-teal-500/30">
          <AudienceBuilder channel="email" value={incoming} onChange={setIncoming} />
          <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => { setAdding(false); setIncoming([]); }}>Cancel</Button><Button disabled={!incoming.length || saving} onClick={save}>{saving ? 'Saving…' : `Save ${fmtNumber(incoming.length)} to list`}</Button></div>
        </div>
      )}
      {state.loading ? <LoadingState /> : state.items.length === 0 ? <EmptyState icon={Contact} title="No contacts" hint="Add clients, paste addresses or import a CSV/Excel file." /> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-700">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60"><tr><th className="px-4 py-2 text-left">Email</th><th className="px-4 py-2 text-left">Name</th><th className="px-4 py-2 text-left">Status</th><th className="px-4 py-2 text-right">Added</th><th /></tr></thead>
            <tbody>
              {state.items.map((c) => (
                <tr key={c.id} className="border-t border-slate-100 dark:border-slate-700/60">
                  <td className="px-4 py-2 font-mono text-xs text-slate-700 dark:text-slate-200">{c.email}</td>
                  <td className="px-4 py-2 text-slate-700 dark:text-slate-200">{c.name || '—'}{c.company ? <span className="text-xs text-slate-400"> · {c.company}</span> : null}</td>
                  <td className="px-4 py-2 text-xs">{c.status === 'subscribed' ? <span className="text-emerald-600">Subscribed</span> : <span className="text-slate-400">Unsubscribed</span>}</td>
                  <td className="px-4 py-2 text-right text-xs text-slate-400">{fmtAgo(c.created_at)}</td>
                  <td className="px-2 py-2 text-right"><Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(c)}><X className="h-4 w-4" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {state.total > state.items.length && <p className="border-t border-slate-100 px-3 py-2 text-center text-xs text-slate-400 dark:border-slate-700">Showing {state.items.length} of {fmtNumber(state.total)} — search to find others.</p>}
        </div>
      )}
    </div>
  );
}

function AudiencePanel({ lists, reload }) {
  const [open, setOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const create = async () => {
    if (!name.trim()) return;
    try { const l = await engagexApi.createList({ name }); setName(''); setCreating(false); reload(); setOpen(l); }
    catch (error) { toast.error(engagexError(error)); }
  };
  const remove = async (l) => {
    if (!window.confirm(`Delete the list “${l.name}” and its ${fmtNumber(l.counts?.subscribed || 0)} contacts?`)) return;
    try { await engagexApi.deleteList(l.id); reload(); } catch (error) { toast.error(engagexError(error)); }
  };
  if (open) return <ListContacts list={open} onBack={() => setOpen(null)} onChanged={reload} />;
  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-2">
        {creating ? (
          <><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder="List name, e.g. GST clients" className="h-9 w-[240px]" /><Button size="sm" onClick={create}>Create</Button><Button size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></>
        ) : <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-4 w-4 mr-1" />New list</Button>}
      </div>
      {lists.length === 0 ? <EmptyState icon={Users} title="No audience lists" hint="Create a list and add contacts from your clients, a pasted list or a spreadsheet." /> : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {lists.map((l) => (
            <div key={l.id} className="rounded-xl border border-slate-200 p-4 dark:border-slate-700">
              <button type="button" className="w-full text-left" onClick={() => setOpen(l)}>
                <p className="font-semibold text-slate-800 hover:text-teal-700 dark:text-slate-100">{l.name}</p>
                <p className="mt-1 text-2xl font-extrabold text-slate-800 dark:text-slate-100">{fmtNumber(l.counts?.subscribed || 0)}<span className="ml-1 text-xs font-medium text-slate-500">subscribed</span></p>
                <p className="text-[11px] text-slate-400">{fmtNumber(l.counts?.unsubscribed || 0)} unsubscribed · updated {fmtAgo(l.updated_at)}</p>
              </button>
              <div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => setOpen(l)}>Manage</Button><Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" onClick={() => remove(l)}><Trash2 className="h-4 w-4" /></Button></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Templates
// ═════════════════════════════════════════════════════════════════════════════
function TemplateEditorDialog({ open, onOpenChange, initial, companyName, onSaved }) {
  const [form, setForm] = useState({ name: '', subject: '', preview_text: '', html: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ name: initial?.name || '', subject: initial?.subject || '', preview_text: initial?.preview_text || '', html: initial?.html || STARTER_TEMPLATES[0].html }); }, [open, initial]);
  const vars = useMemo(() => previewVariables({ name: 'Ravi Sharma', email: 'ravi@example.com', company: 'Sharma Traders' }, companyName), [companyName]);
  const save = async () => {
    if (!form.name.trim()) return toast.error('Name the template.');
    setSaving(true);
    try { if (initial?.id) await engagexApi.updateTemplate('email', initial.id, form); else await engagexApi.createTemplate('email', form); toast.success('Template saved'); onSaved(); onOpenChange(false); }
    catch (error) { toast.error(engagexError(error)); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[92vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{initial?.id ? 'Edit template' : 'New email template'}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-3">
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Template name" />
          <Input value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Default subject" />
          <Input value={form.preview_text} onChange={(e) => setForm((f) => ({ ...f, preview_text: e.target.value }))} placeholder="Preview text" />
        </div>
        <EmailEditor value={form.html} onChange={(html) => setForm((f) => ({ ...f, html }))} previewVars={vars} previewText={form.preview_text} footerCompany={companyName} height={380}
          onUploadImage={async (file) => (await uploadEmailImage(file, 'image')).url} />
        <DialogFooter><Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplatesPanel({ templates, companyName, reload, onUse }) {
  const [editing, setEditing] = useState(null);
  const remove = async (t) => { if (!window.confirm(`Delete “${t.name}”?`)) return; try { await engagexApi.deleteTemplate('email', t.id); reload(); } catch (error) { toast.error(engagexError(error)); } };
  const cards = [...STARTER_TEMPLATES.filter((t) => t.id !== 'blank').map((t) => ({ ...t, starter: true })), ...templates];
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><Button size="sm" onClick={() => setEditing({})}><Plus className="h-4 w-4 mr-1" />New template</Button></div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((t) => (
          <div key={t.id} className="flex flex-col overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
            <div className="relative h-44 overflow-hidden bg-slate-100 dark:bg-slate-900">
              <iframe title={t.name} sandbox="" tabIndex={-1} srcDoc={previewDocument(renderMergePreview(t.html, previewVariables({ name: 'Ravi Sharma' }, companyName)), { footerCompany: companyName })}
                className="pointer-events-none absolute left-0 top-0 origin-top-left border-0" style={{ width: 640, maxWidth: 'none', height: 640, transform: 'scale(0.42)' }} />
            </div>
            <div className="flex flex-1 flex-col p-3">
              <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}{t.starter && <span className="ml-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 dark:bg-slate-700">Starter</span>}</p>
              <p className="truncate text-[11px] text-slate-500">{t.subject || 'No default subject'}</p>
              <div className="mt-auto flex gap-1.5 pt-3">
                <Button size="sm" onClick={() => onUse(t)}>Use</Button>
                {!t.starter && <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditing(t)}><Pencil className="h-4 w-4" /></Button>}
                {!t.starter && <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-600" onClick={() => remove(t)}><Trash2 className="h-4 w-4" /></Button>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <TemplateEditorDialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)} initial={editing} companyName={companyName} onSaved={reload} />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Campaign builder
// ═════════════════════════════════════════════════════════════════════════════
const blankCampaign = (senders) => ({
  id: null, name: '', sender_id: senders.find((s) => s.is_default)?.id || PLATFORM, subject: '', preview_text: '',
  html: STARTER_TEMPLATES[0].html, list_ids: [], recipients: [], per_minute: 30, track_opens: true, footer_address: '', template_id: null,
  banner: null, attachments: [],
});

export const campaignFromDoc = (doc, senders) => ({
  ...blankCampaign(senders),
  id: doc.status === 'draft' ? doc.id : null,
  name: doc.name || '',
  sender_id: doc.settings?.sender_id || PLATFORM,
  subject: doc.content?.subject || '',
  preview_text: doc.content?.preview_text || '',
  html: doc.content?.html || '',
  list_ids: doc.audience?.list_ids || [],
  recipients: doc.audience?.recipients || [],
  per_minute: doc.settings?.per_minute || 30,
  track_opens: doc.settings?.track_opens !== false,
  footer_address: doc.settings?.footer_address || '',
  banner: doc.content?.banner || null,
  attachments: doc.content?.attachments || [],
});

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Upload an image for use in an email (returns its public URL). */
export async function uploadEmailImage(file, purpose = 'image') {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Use a PNG, JPG, GIF or WebP image.');
  if (file.size > 3 * 1024 * 1024) throw new Error('Images must be 3 MB or smaller.');
  try {
    const res = await engagexApi.uploadMailFile(file, purpose);
    return res;
  } catch (error) {
    throw new Error(engagexError(error));
  }
}

function BannerPicker({ banner, onChange }) {
  const ref = React.useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const res = await uploadEmailImage(file, 'banner');
      onChange({ url: res.url, media_id: res.id, link: banner?.link || '', alt: banner?.alt || file.name.replace(/\.[^.]+$/, '') });
    } catch (error) { toast.error(error.message); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-3">
      <input ref={ref} type="file" accept={IMAGE_TYPES.join(',')} className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
      {banner?.url ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
            <img src={banner.url} alt={banner.alt || 'Banner'} className="block h-auto w-full" style={{ maxWidth: '100%' }} />
          </div>
          <div className="space-y-2">
            <label className="block text-xs font-semibold text-slate-500">Banner link (optional)
              <Input className="mt-1" value={banner.link || ''} onChange={(e) => onChange({ ...banner, link: e.target.value })} placeholder="https://yourwebsite.com/offer" />
            </label>
            <label className="block text-xs font-semibold text-slate-500">Alt text (shown if images are blocked)
              <Input className="mt-1" value={banner.alt || ''} onChange={(e) => onChange({ ...banner, alt: e.target.value })} placeholder="Diwali offer from Acme" maxLength={200} />
            </label>
            <div className="flex gap-2 pt-1">
              <Button size="sm" variant="outline" onClick={() => ref.current?.click()} disabled={busy}><RefreshCw className="h-4 w-4 mr-1.5" />Replace</Button>
              <Button size="sm" variant="ghost" className="text-rose-600" onClick={() => onChange(null)}><Trash2 className="h-4 w-4 mr-1.5" />Remove</Button>
            </div>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => ref.current?.click()} disabled={busy}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 py-8 text-slate-500 hover:border-indigo-400 hover:text-indigo-700 dark:border-slate-600 dark:hover:text-indigo-300">
          {busy ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImageIcon className="h-6 w-6" />}
          <span className="text-sm font-semibold">{busy ? 'Uploading…' : 'Upload a banner image'}</span>
          <span className="text-xs">Shown full-width at the top of the email · 1200 × 400 px recommended · PNG, JPG, GIF or WebP up to 3 MB</span>
        </button>
      )}
    </div>
  );
}

function AttachmentPicker({ attachments, onChange }) {
  const ref = React.useRef(null);
  const [busy, setBusy] = useState(false);
  const total = attachments.reduce((n, a) => n + (a.size || 0), 0);
  const pick = async (files) => {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (attachments.length + list.length > MAX_ATTACHMENTS) return toast.error(`You can attach up to ${MAX_ATTACHMENTS} files.`);
    let running = total;
    for (const f of list) {
      if (f.size > MAX_ATTACHMENT_BYTES) return toast.error(`${f.name} is larger than 8 MB.`);
      running += f.size;
    }
    if (running > MAX_ATTACHMENTS_TOTAL) return toast.error('Attachments may total at most 10 MB per email.');
    setBusy(true);
    try {
      const uploaded = [];
      for (const f of list) {
        const res = await engagexApi.uploadMailFile(f, 'attachment');
        uploaded.push({ id: res.id, filename: res.filename, size: res.size, mime_type: res.mime_type });
      }
      onChange([...attachments, ...uploaded]);
      toast.success(`${uploaded.length} file${uploaded.length > 1 ? 's' : ''} attached`);
    } catch (error) { toast.error(engagexError(error)); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <input ref={ref} type="file" multiple className="hidden"
        accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.zip"
        onChange={(e) => { pick(e.target.files); e.target.value = ''; }} />
      {attachments.length > 0 && (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-700 dark:border-slate-700">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-sm"><Paperclip className="h-4 w-4 shrink-0 text-slate-400" /><span className="truncate text-slate-700 dark:text-slate-200">{a.filename}</span><span className="shrink-0 text-xs text-slate-400">{fmtBytes(a.size || 0)}</span></span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onChange(attachments.filter((x) => x.id !== a.id))} aria-label={`Remove ${a.filename}`}><X className="h-4 w-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={() => ref.current?.click()} disabled={busy || attachments.length >= MAX_ATTACHMENTS}>
          {busy ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Upload className="h-4 w-4 mr-1.5" />}{busy ? 'Uploading…' : 'Attach files'}
        </Button>
        <span className="text-xs text-slate-500">Images, PDF, Word, Excel, PowerPoint… up to {MAX_ATTACHMENTS} files, 10 MB in total{attachments.length ? ` · ${fmtBytes(total)} used` : ''}.</span>
      </div>
    </div>
  );
}

function ConnectGmailInline() {
  const { connect, connecting } = useGoogleConnect();
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <GoogleButton onClick={connect} busy={connecting}>Send from my Gmail</GoogleButton>
      <span className="text-xs text-slate-500">Save your draft first — you’ll come back to MailMaster after choosing your Google account.</span>
    </div>
  );
}

function ChecklistRow({ done, title, summary, children }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700">
      <div className="flex items-start gap-3 px-4 py-3">
        {done ? <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-teal-600" /> : <Circle className="mt-0.5 h-5 w-5 shrink-0 text-slate-300" />}
        <div className="min-w-0 flex-1"><p className="text-sm font-bold text-slate-800 dark:text-slate-100">{title}</p>{summary && <p className="text-xs text-slate-500">{summary}</p>}</div>
      </div>
      <div className="border-t border-slate-100 px-4 py-4 dark:border-slate-700/60">{children}</div>
    </div>
  );
}

function CampaignBuilder({ initial, senders, lists, templates, companyName, onClose, onLaunched }) {
  const { user } = useAuth();
  const [c, setC] = useState(initial);
  const [saving, setSaving] = useState('');
  const [showIndividuals, setShowIndividuals] = useState((initial.recipients || []).length > 0);
  const [testOpen, setTestOpen] = useState(false);
  const [testTo, setTestTo] = useState(user?.email || '');
  const [confirm, setConfirm] = useState(null); // 'send' | 'schedule'
  const [scheduleAt, setScheduleAt] = useState(localDateTimeValue(Date.now() + 60 * 60 * 1000));
  const set = (patch) => setC((x) => ({ ...x, ...patch }));

  const sender = senders.find((s) => s.id === c.sender_id) || senders[0];
  const audienceCount = useMemo(() => lists.filter((l) => c.list_ids.includes(l.id)).reduce((n, l) => n + (l.counts?.subscribed || 0), 0) + c.recipients.length, [lists, c.list_ids, c.recipients]);
  const vars = useMemo(() => previewVariables(c.recipients[0] || { name: 'Ravi Sharma', email: 'ravi@example.com', company: 'Sharma Traders' }, sender?.from_name || companyName), [c.recipients, sender, companyName]);
  const ready = { to: audienceCount > 0, from: !!sender && (sender.kind !== PLATFORM || sender.enabled), subject: c.subject.trim().length > 0, content: c.html.replace(/<[^>]+>/g, '').trim().length > 0 };
  const allReady = Object.values(ready).every(Boolean);

  const body = () => ({
    name: c.name.trim() || c.subject.trim() || 'Untitled campaign', sender_id: c.sender_id, subject: c.subject, preview_text: c.preview_text, html: c.html,
    audience: { list_ids: c.list_ids, recipients: c.recipients }, per_minute: Number(c.per_minute), track_opens: c.track_opens, footer_address: c.footer_address, template_id: c.template_id,
    banner: c.banner?.url ? { url: c.banner.url, link: c.banner.link || '', alt: c.banner.alt || '', media_id: c.banner.media_id || null } : null,
    attachments: c.attachments.map(({ id, filename, size, mime_type }) => ({ id, filename, size, mime_type })),
  });

  const saveDraft = async (quiet = false) => {
    setSaving('draft');
    try {
      const res = c.id ? await engagexApi.updateMailCampaign(c.id, body()) : await engagexApi.createMailCampaign(body(), 'draft');
      set({ id: res.campaign.id });
      if (!quiet) toast.success('Draft saved');
      return res.campaign.id;
    } catch (error) { toast.error(engagexError(error)); return null; } finally { setSaving(''); }
  };

  const launch = async (action) => {
    setSaving(action);
    try {
      const when = action === 'schedule' ? new Date(scheduleAt).toISOString() : null;
      let id = c.id;
      if (id) { await engagexApi.updateMailCampaign(id, body()); await engagexApi.launchMailCampaign(id, action, when); }
      else { const res = await engagexApi.createMailCampaign(body(), action, when); id = res.campaign.id; }
      toast.success(action === 'schedule' ? 'Campaign scheduled' : 'Campaign is sending');
      setConfirm(null);
      onLaunched(id);
    } catch (error) {
      const draftId = error?.response?.data?.detail?.campaign_id;
      if (draftId) set({ id: draftId });
      toast.error(engagexError(error));
    } finally { setSaving(''); }
  };

  const sendTest = async () => {
    try {
      const b = body();
      await engagexApi.testSend({ to: testTo, sender_id: c.sender_id, subject: c.subject || '(no subject)', html: c.html, preview_text: c.preview_text, banner: b.banner, attachments: b.attachments });
      toast.success(`Test sent to ${testTo}`); setTestOpen(false);
    } catch (error) { toast.error(engagexError(error)); }
  };

  const saveAsTemplate = async () => {
    const name = window.prompt('Template name', c.name || c.subject || 'My template');
    if (!name) return;
    try { await engagexApi.createTemplate('email', { name, subject: c.subject, preview_text: c.preview_text, html: c.html }); toast.success('Saved as template'); }
    catch (error) { toast.error(engagexError(error)); }
  };

  const etaSeconds = audienceCount ? (audienceCount / Math.max(1, Number(c.per_minute))) * 60 : 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}><ChevronLeft className="h-4 w-4 mr-1" />Campaigns</Button>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={saveAsTemplate}><FileText className="h-4 w-4 mr-1.5" />Save as template</Button>
          <Button variant="outline" size="sm" onClick={() => setTestOpen(true)} disabled={!ready.from}><Send className="h-4 w-4 mr-1.5" />Send test</Button>
          <Button variant="outline" size="sm" onClick={() => saveDraft()} disabled={!!saving}>{saving === 'draft' ? 'Saving…' : 'Save draft'}</Button>
          <Button variant="outline" size="sm" disabled={!allReady || !!saving} onClick={() => setConfirm('schedule')}><CalendarClock className="h-4 w-4 mr-1.5" />Schedule</Button>
          <Button size="sm" disabled={!allReady || !!saving} onClick={() => setConfirm('send')} className="bg-indigo-600 hover:bg-indigo-700 text-white"><Send className="h-4 w-4 mr-1.5" />Send</Button>
        </div>
      </div>

      <Input value={c.name} onChange={(e) => set({ name: e.target.value })} placeholder="Campaign name (internal), e.g. October newsletter" className="h-11 text-base font-semibold" maxLength={160} />

      <ChecklistRow done={ready.to} title="To" summary={audienceCount ? `About ${fmtNumber(audienceCount)} recipients (duplicates and unsubscribed are removed at send time)` : 'Choose who receives this campaign'}>
        {lists.length === 0 ? <p className="text-xs text-slate-500">No audience lists yet — create one in the Audience tab, or add individual recipients below.</p> : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {lists.map((l) => (
              <label key={l.id} className={`flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 ${c.list_ids.includes(l.id) ? 'border-indigo-400 bg-indigo-50/60 dark:bg-indigo-500/10' : 'border-slate-200 dark:border-slate-700'}`}>
                <Checkbox checked={c.list_ids.includes(l.id)} onCheckedChange={(v) => set({ list_ids: v ? [...c.list_ids, l.id] : c.list_ids.filter((x) => x !== l.id) })} />
                <span className="min-w-0"><span className="block truncate text-sm font-medium text-slate-800 dark:text-slate-100">{l.name}</span><span className="text-[11px] text-slate-500">{fmtNumber(l.counts?.subscribed || 0)} subscribed</span></span>
              </label>
            ))}
          </div>
        )}
        <div className="mt-3">
          <Button variant="ghost" size="sm" onClick={() => setShowIndividuals((v) => !v)}><Users className="h-4 w-4 mr-1.5" />{showIndividuals ? 'Hide' : 'Add'} individual recipients{c.recipients.length ? ` (${fmtNumber(c.recipients.length)})` : ''}</Button>
          {showIndividuals && <div className="mt-3"><AudienceBuilder channel="email" value={c.recipients} onChange={(recipients) => set({ recipients })} /></div>}
        </div>
      </ChecklistRow>

      <ChecklistRow done={ready.from} title="From" summary={sender ? `${sender.from_name} <${sender.from_email || 'not configured'}>${sender.reply_to ? ` · replies to ${sender.reply_to}` : ''}` : ''}>
        <Select value={c.sender_id} onValueChange={(v) => set({ sender_id: v })}>
          <SelectTrigger className="max-w-md"><SelectValue /></SelectTrigger>
          <SelectContent>{senders.map((s) => <SelectItem key={s.id} value={s.id}>{s.label} — {s.from_email || 'not configured'}</SelectItem>)}</SelectContent>
        </Select>
        {sender?.kind === PLATFORM && !sender.enabled && <p className="mt-2 text-xs text-amber-600">The platform email service isn’t configured. Connect your Gmail account to send.</p>}
        {!senders.some((s) => s.kind === 'google') && <ConnectGmailInline />}
      </ChecklistRow>

      <ChecklistRow done={ready.subject} title="Subject" summary={c.subject ? renderMergePreview(c.subject, vars) : 'What is this email about?'}>
        <div className="space-y-2">
          <div className="flex items-center gap-2"><Input value={c.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="Subject line" maxLength={300} /><span className={`w-14 text-right text-[11px] ${c.subject.length > 70 ? 'text-amber-600' : 'text-slate-400'}`}>{c.subject.length}/70</span></div>
          <Input value={c.preview_text} onChange={(e) => set({ preview_text: e.target.value })} placeholder="Preview text — shown after the subject in most inboxes (optional)" maxLength={300} />
          <MergeTagBar onInsert={(tag) => set({ subject: `${c.subject}${c.subject && !c.subject.endsWith(' ') ? ' ' : ''}${tag}` })} />
        </div>
      </ChecklistRow>

      <ChecklistRow done={!!c.banner?.url} title="Banner image (optional)" summary={c.banner?.url ? 'A full-width image appears at the top of the email' : 'Add a header image or promotional banner'}>
        <BannerPicker banner={c.banner} onChange={(banner) => set({ banner })} />
      </ChecklistRow>

      <ChecklistRow done={ready.content} title="Content" summary="Design your email. Personalisation tags are filled in for each recipient.">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-semibold text-slate-500">Start from:</span>
          {[...STARTER_TEMPLATES, ...templates].map((t) => (
            <button key={t.id} type="button" onClick={() => { if (c.html.replace(/<[^>]+>/g, '').trim().length > 40 && !window.confirm('Replace the current content with this template?')) return; set({ html: t.html, subject: c.subject || t.subject || '', preview_text: c.preview_text || t.preview_text || '', template_id: t.starter === false ? t.id : null }); }}
              className="rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-medium text-slate-600 hover:border-indigo-400 hover:text-indigo-700 dark:border-slate-600 dark:text-slate-300">{t.name}</button>
          ))}
        </div>
        <EmailEditor value={c.html} onChange={(html) => set({ html })} previewVars={vars} previewText={c.preview_text} footerCompany={sender?.from_name || companyName} footerAddress={c.footer_address}
          banner={c.banner} onUploadImage={async (file) => (await uploadEmailImage(file, 'image')).url} />
      </ChecklistRow>

      <ChecklistRow done={c.attachments.length > 0} title="Attachments (optional)" summary={c.attachments.length ? `${c.attachments.length} file${c.attachments.length > 1 ? 's' : ''} attached to every email` : 'Attach brochures, invoices, images or documents'}>
        <AttachmentPicker attachments={c.attachments} onChange={(attachments) => set({ attachments })} />
      </ChecklistRow>

      <ChecklistRow done title="Settings" summary={`${c.per_minute} emails per minute · open tracking ${c.track_opens ? 'on' : 'off'}`}>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="text-xs font-semibold text-slate-500">Sending speed (emails / minute)
            <Input type="number" min={1} max={600} className="mt-1" value={c.per_minute} onChange={(e) => set({ per_minute: Math.min(600, Math.max(1, Number(e.target.value) || 1)) })} />
            <span className="mt-1 block font-normal text-slate-400">Gmail/Outlook mailboxes: keep at 20–30. SES/SendGrid can go higher.</span>
          </label>
          <label className="text-xs font-semibold text-slate-500">Footer address (recommended)
            <Input className="mt-1" value={c.footer_address} onChange={(e) => set({ footer_address: e.target.value })} placeholder="Office address shown in the footer" maxLength={300} />
          </label>
          <label className="flex items-center gap-3 pt-5 text-sm text-slate-700 dark:text-slate-200"><Switch checked={c.track_opens} onCheckedChange={(v) => set({ track_opens: v })} />Track opens</label>
        </div>
      </ChecklistRow>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Send a test email</DialogTitle><DialogDescription>Personalisation uses sample values. The subject is prefixed with [TEST].</DialogDescription></DialogHeader>
          <Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} />
          <DialogFooter><Button variant="ghost" onClick={() => setTestOpen(false)}>Cancel</Button><Button onClick={sendTest}>Send test</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm === 'schedule' ? 'Schedule this campaign?' : 'Send this campaign now?'}</DialogTitle>
            <DialogDescription>Recipients who unsubscribed or appear twice are removed automatically.</DialogDescription>
          </DialogHeader>
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-slate-500">Recipients</dt><dd className="font-semibold">≈ {fmtNumber(audienceCount)}</dd></div>
            <div className="flex justify-between gap-3"><dt className="shrink-0 text-slate-500">From</dt><dd className="truncate font-semibold">{sender?.from_name} &lt;{sender?.from_email}&gt;</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-slate-500">Subject</dt><dd className="truncate font-semibold">{c.subject}</dd></div>
            {c.attachments.length > 0 && <div className="flex justify-between gap-3"><dt className="text-slate-500">Attachments</dt><dd className="font-semibold">{c.attachments.length} file{c.attachments.length > 1 ? 's' : ''}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-slate-500">Estimated time</dt><dd className="font-semibold">{fmtDuration(etaSeconds)}</dd></div>
          </dl>
          {confirm === 'schedule' && <Input type="datetime-local" value={scheduleAt} min={localDateTimeValue(Date.now() + 2 * 60 * 1000)} onChange={(e) => setScheduleAt(e.target.value)} />}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>Cancel</Button>
            <Button disabled={!!saving} onClick={() => launch(confirm)} className="bg-indigo-600 hover:bg-indigo-700 text-white">{saving ? 'Working…' : confirm === 'schedule' ? 'Schedule' : 'Send now'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Page
// ═════════════════════════════════════════════════════════════════════════════
export default function EngageXMailMaster() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState('campaigns');
  const [senders, setSenders] = useState([]);
  const [canManage, setCanManage] = useState(false);
  const [lists, setLists] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [builder, setBuilder] = useState(null);
  const [openId, setOpenId] = useState(params.get('campaign'));
  const [refreshKey, setRefreshKey] = useState(0);

  const loadSenders = useCallback(async () => { const d = await engagexApi.senders(); setSenders(d.senders || []); setCanManage(!!d.can_manage); return d.senders || []; }, []);
  const loadLists = useCallback(async () => { const d = await engagexApi.lists(); setLists(d.items || []); }, []);
  const loadTemplates = useCallback(async () => { const d = await engagexApi.templates('email'); setTemplates((d.items || []).map((t) => ({ ...t, starter: false }))); }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const loaded = await loadSenders();
      await Promise.all([loadLists(), loadTemplates()]);
      if (params.get('new')) { setBuilder(blankCampaign(loaded)); params.delete('new'); setParams(params, { replace: true }); }
    } catch (error) { setLoadError(engagexError(error)); }
    finally { setLoading(false); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => { const id = params.get('campaign'); if (id) setOpenId(id); }, [params]);

  // Back from Google's account chooser (see backend/engagex/google_sender.py).
  useEffect(() => {
    const google = params.get('google');
    const tabParam = params.get('tab');
    if (!google && !tabParam) return;
    if (tabParam) setTab(tabParam);
    if (google === 'connected') {
      toast.success(`${params.get('email') || 'Your Google account'} is connected`, { description: 'Choose it as the sender when you create a campaign, or make it the default.' });
      setTab('senders');
      loadSenders().catch(() => {});
    } else if (google) {
      toast.error(params.get('reason') || 'Google sign-in did not complete.');
      setTab('senders');
    }
    ['google', 'email', 'reason', 'tab'].forEach((k) => params.delete(k));
    setParams(params, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const companyName = senders.find((s) => s.id === PLATFORM)?.from_name || user?.company_name || 'Your company';
  const platform = senders.find((s) => s.id === PLATFORM);
  const startNew = () => { setBuilder(blankCampaign(senders)); setTab('campaigns'); };
  const closeSheet = (open) => { if (open) return; setOpenId(null); if (params.get('campaign')) { params.delete('campaign'); setParams(params, { replace: true }); } };

  return (
    <div className="space-y-5 sm:space-y-6 w-full min-w-0 text-slate-800 dark:text-slate-100">
      <PageBanner
        icon={Mail}
        eyebrow="EngageX · MailMaster"
        title="Email Campaigns"
        subtitle="Design, send and track bulk emails to your clients — from the platform service or your own mailbox."
        stats={[
          { label: 'Lists', value: fmtNumber(lists.length), loading },
          { label: 'Contacts', value: fmtNumber(lists.reduce((n, l) => n + (l.counts?.subscribed || 0), 0)), loading },
          { label: 'Senders', value: fmtNumber(senders.length), loading },
        ]}
      />

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />Couldn’t load MailMaster: {loadError}</span>
          <Button size="sm" variant="outline" onClick={loadAll}><RefreshCw className="h-4 w-4 mr-1.5" />Retry</Button>
        </div>
      )}
      {loading ? <LoadingState /> : builder ? (
        <ExCard icon={Megaphone} title={builder.id ? 'Edit campaign' : 'New email campaign'} color={BRAND.email}>
          <CampaignBuilder
            key={builder.id || 'new'}
            initial={builder}
            senders={senders}
            lists={lists}
            templates={templates}
            companyName={companyName}
            onClose={() => { setBuilder(null); setRefreshKey((k) => k + 1); }}
            onLaunched={(id) => { setBuilder(null); setRefreshKey((k) => k + 1); setOpenId(id); }}
          />
        </ExCard>
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto">
            <TabsTrigger value="campaigns"><Megaphone className="h-4 w-4 mr-1.5" />Campaigns</TabsTrigger>
            <TabsTrigger value="audience"><Users className="h-4 w-4 mr-1.5" />Audience</TabsTrigger>
            <TabsTrigger value="templates"><FileText className="h-4 w-4 mr-1.5" />Templates</TabsTrigger>
            <TabsTrigger value="senders"><Inbox className="h-4 w-4 mr-1.5" />Senders</TabsTrigger>
            <TabsTrigger value="unsubscribed"><ShieldOff className="h-4 w-4 mr-1.5" />Unsubscribed</TabsTrigger>
          </TabsList>

          <TabsContent value="campaigns" className="mt-4 space-y-4">
            {platform && !platform.enabled && senders.length === 1 && (
              <GuidanceNote tone="warning">The platform email service is not configured yet. Add your own email account in <button type="button" className="font-semibold underline" onClick={() => setTab('senders')}>Senders</button> to start sending.</GuidanceNote>
            )}
            <ExCard icon={Megaphone} title="Campaigns" color={BRAND.email} description="Drafts, scheduled and sent campaigns with delivery and open reports.">
              <CampaignTable channel="email" refreshKey={refreshKey} onOpen={(c) => setOpenId(c.id)}
                emptyAction={<Button size="sm" onClick={startNew}>Create campaign</Button>}
                extraActions={<Button size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white" onClick={startNew}><Plus className="h-4 w-4 mr-1" />Create campaign</Button>} />
            </ExCard>
          </TabsContent>
          <TabsContent value="audience" className="mt-4"><ExCard icon={Users} title="Audience lists" color={BRAND.email}><AudiencePanel lists={lists} reload={loadLists} /></ExCard></TabsContent>
          <TabsContent value="templates" className="mt-4">
            <ExCard icon={FileText} title="Email templates" color={BRAND.email}>
              <TemplatesPanel templates={templates} companyName={companyName} reload={loadTemplates}
                onUse={(t) => setBuilder({ ...blankCampaign(senders), subject: t.subject || '', preview_text: t.preview_text || '', html: t.html, template_id: t.starter ? null : t.id })} />
            </ExCard>
          </TabsContent>
          <TabsContent value="senders" className="mt-4"><ExCard icon={Inbox} title="Sender accounts" color={BRAND.email}><SendersPanel senders={senders} canManage={canManage} companyName={companyName} reload={loadSenders} /></ExCard></TabsContent>
          <TabsContent value="unsubscribed" className="mt-4"><ExCard icon={ShieldOff} title="Unsubscribed" color={BRAND.email}><OptOutPanel channel="email" /></ExCard></TabsContent>
        </Tabs>
      )}

      <CampaignSheet
        channel="email"
        campaignId={openId}
        open={!!openId}
        onOpenChange={closeSheet}
        onChanged={() => { setRefreshKey((k) => k + 1); loadLists().catch(() => {}); }}
        onEditDraft={(doc) => { setOpenId(null); setBuilder(campaignFromDoc(doc, senders)); }}
        onDuplicate={async (doc) => {
          try { const res = await engagexApi.duplicateMailCampaign(doc.id); const full = await engagexApi.campaign('email', res.campaign.id); setOpenId(null); setBuilder(campaignFromDoc(full.campaign, senders)); toast.success('Duplicated as a new draft'); }
          catch (error) { toast.error(engagexError(error)); }
        }}
      />
    </div>
  );
}
