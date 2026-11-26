/**
 * OrganisationEmail — Settings → Integrations → Email.
 *
 * Connect the organisation's mailbox once; every module (invoices,
 * quotations, client emails, compliance emails, task reminders, client
 * portal codes, EngageX) sends from it. The first mailbox connected becomes
 * the default. Several mailboxes can be connected (e.g. accounts@ and sales@)
 * and each sending screen can pick one under "Send from".
 *
 *   GET    /api/organisation-email/status
 *   POST   /api/organisation-email/google/start      → {auth_url}
 *   POST   /api/organisation-email/microsoft/start   → {auth_url}
 *   POST   /api/organisation-email/connect           (address + app password)
 *   POST   /api/organisation-email/{id}/default
 *   DELETE /api/organisation-email/{id}
 */
import React, { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CheckCircle2, Inbox, Loader2, Mail, Star, Trash2, AlertTriangle } from 'lucide-react';
import { fetchOrgEmailStatus } from '@/components/SendFromSelect';

const RETURN_PATH = '/settings/general?tab=integrations&section=email';

const KIND_LABEL = { google: 'Gmail / Google Workspace', microsoft: 'Outlook / Microsoft 365', smtp: 'Email account' };

function errText(err, fallback) {
  return err?.response?.data?.detail || err?.message || fallback;
}

export default function OrganisationEmail({ isDark = false }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [showOther, setShowOther] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', from_name: '', smtp_host: '', smtp_port: '' });
  const [showAdvanced, setShowAdvanced] = useState(false);

  const card = isDark ? 'bg-slate-800/40 border-slate-700' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-800';

  const load = useCallback(async () => {
    setLoading(true);
    try { setStatus(await fetchOrgEmailStatus(true)); }
    catch (err) { toast.error(errText(err, 'Could not load email settings')); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    // Result of a Google / Microsoft sign-in round trip.
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get('google') || params.get('microsoft') || params.get('mail');
    if (outcome) {
      if (outcome === 'connected') toast.success('Email connected', { description: params.get('email') || undefined });
      else if (outcome === 'cancelled') toast.warning('Sign-in was cancelled.');
      else toast.error('Email could not be connected', { description: params.get('reason') || undefined });
      ['google', 'microsoft', 'mail', 'email', 'reason'].forEach((k) => params.delete(k));
      const qs = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
    }
    load();
  }, [load]);

  const startOAuth = async (provider) => {
    setBusy(provider);
    try {
      const res = await api.post(`/organisation-email/${provider}/start`, { return_path: RETURN_PATH });
      window.location.href = res.data.auth_url;
    } catch (err) {
      setBusy('');
      toast.error(errText(err, 'Could not start sign-in'));
    }
  };

  const connectOther = async () => {
    if (!form.email.trim() || !form.password) { toast.error('Enter the email address and its app password'); return; }
    setBusy('other');
    try {
      const payload = { email: form.email.trim(), password: form.password, from_name: form.from_name || undefined };
      if (showAdvanced && form.smtp_host.trim()) {
        payload.smtp_host = form.smtp_host.trim();
        payload.smtp_port = Number(form.smtp_port) || 587;
      }
      await api.post('/organisation-email/connect', payload);
      toast.success(`${form.email.trim()} connected`);
      setForm({ email: '', password: '', from_name: '', smtp_host: '', smtp_port: '' });
      setShowOther(false);
      await load();
    } catch (err) {
      toast.error(errText(err, 'Could not connect this mailbox'));
    } finally { setBusy(''); }
  };

  const makeDefault = async (id) => {
    setBusy(id);
    try { await api.post(`/organisation-email/${id}/default`); toast.success('Default mailbox updated'); await load(); }
    catch (err) { toast.error(errText(err, 'Could not change the default')); }
    finally { setBusy(''); }
  };

  const remove = async (m) => {
    if (!window.confirm(`Disconnect ${m.from_email}? Modules will stop sending from it.`)) return;
    setBusy(m.id);
    try { await api.delete(`/organisation-email/${m.id}`); toast.success(`${m.from_email} disconnected`); await load(); }
    catch (err) { toast.error(errText(err, 'Could not disconnect')); }
    finally { setBusy(''); }
  };

  const connectInbox = async (m) => {
    // Optional: also read this Gmail inbox in the Email module (separate Google permission).
    setBusy(`inbox-${m.id}`);
    try {
      const res = await api.get('/email/oauth/google/start', { params: { label: m.from_email, auto_sync: true } });
      window.location.href = res.data.auth_url;
    } catch (err) {
      setBusy('');
      toast.error(errText(err, 'Inbox reading is not available yet'));
    }
  };

  if (loading && !status) {
    return <div className={`rounded-2xl border p-6 flex items-center gap-2 text-sm ${card} ${muted}`}><Loader2 className="h-4 w-4 animate-spin" />Loading email settings…</div>;
  }
  if (!status) return null;
  const canManage = status.can_manage;
  const mailboxes = status.mailboxes || [];

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className={`rounded-2xl border p-5 ${card}`}>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: status.connected ? 'rgba(16,185,129,0.12)' : 'rgba(245,158,11,0.14)' }}>
            {status.connected ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Mail className="h-5 w-5 text-amber-600" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className={`text-sm font-bold ${strong}`}>
              {status.connected ? `Sending as ${status.default_from_email}` : 'No organisation email connected yet'}
            </p>
            <p className={`text-xs mt-0.5 ${muted}`}>
              {status.connected
                ? 'Every module below sends from this mailbox. Each sending screen can also choose another connected mailbox.'
                : `Until you connect one, emails go out through the platform service as “${status.fallback?.from_name || 'your organisation'}”, with replies to ${status.fallback?.reply_to || 'your organisation email'}.`}
            </p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {(status.used_by || []).map((m) => (
                <span key={m} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{m}</span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Connected mailboxes */}
      {mailboxes.length > 0 && (
        <div className={`rounded-2xl border divide-y ${card} ${isDark ? 'divide-slate-700' : 'divide-slate-100'}`}>
          {mailboxes.map((m) => (
            <div key={m.id} className="p-4 flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-semibold truncate ${strong}`}>
                  {m.from_email}
                  {m.is_default && <span className="ml-2 text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 align-middle">Default</span>}
                </p>
                <p className={`text-[11px] ${muted}`}>{KIND_LABEL[m.kind] || 'Email account'}{m.from_name ? ` · sends as “${m.from_name}”` : ''}</p>
                {m.last_error && (
                  <p className="text-[11px] text-red-600 mt-1 flex items-start gap-1"><AlertTriangle className="h-3 w-3 mt-0.5" />Last send failed: {m.last_error}</p>
                )}
              </div>
              {canManage && (
                <div className="flex items-center gap-1.5">
                  {m.kind === 'google' && (
                    <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs gap-1" disabled={!!busy} onClick={() => connectInbox(m)} title="Optional: also read this inbox in the Email module">
                      <Inbox className="h-3.5 w-3.5" />Also read inbox
                    </Button>
                  )}
                  {!m.is_default && (
                    <Button size="sm" variant="outline" className="h-8 rounded-lg text-xs gap-1" disabled={!!busy} onClick={() => makeDefault(m.id)}>
                      {busy === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Star className="h-3.5 w-3.5" />}Make default
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="h-8 rounded-lg text-xs text-red-600" disabled={!!busy} onClick={() => remove(m)} aria-label={`Disconnect ${m.from_email}`}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Connect */}
      {canManage ? (
        <div className={`rounded-2xl border p-5 ${card}`}>
          <p className={`text-sm font-bold ${strong}`}>{mailboxes.length ? 'Connect another mailbox' : 'Connect your organisation email'}</p>
          <p className={`text-xs mt-0.5 mb-3 ${muted}`}>Sign in and click Allow — no password is stored for Google or Microsoft.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => startOAuth('google')} disabled={!!busy} className="h-9 rounded-xl text-sm gap-2 text-white" style={{ background: 'linear-gradient(135deg,#4285F4,#0D47A1)' }}>
              {busy === 'google' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}Connect Google
            </Button>
            <Button onClick={() => startOAuth('microsoft')} disabled={!!busy} className="h-9 rounded-xl text-sm gap-2 text-white" style={{ background: 'linear-gradient(135deg,#0078D4,#004E8C)' }}>
              {busy === 'microsoft' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}Connect Microsoft
            </Button>
            <Button variant="outline" onClick={() => setShowOther((v) => !v)} disabled={!!busy && busy !== 'other'} className="h-9 rounded-xl text-sm">
              Other email
            </Button>
          </div>

          {showOther && (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1"><Label className="text-xs font-semibold">Email address</Label>
                <Input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="accounts@yourfirm.com" className="h-9 rounded-xl text-sm" /></div>
              <div className="space-y-1"><Label className="text-xs font-semibold">App password</Label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="Mailbox or app password" className="h-9 rounded-xl text-sm" autoComplete="new-password" /></div>
              <div className="space-y-1"><Label className="text-xs font-semibold">Sender name (optional)</Label>
                <Input value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} placeholder="Your firm name" className="h-9 rounded-xl text-sm" /></div>
              <div className="flex items-end">
                <button type="button" className="text-[11px] font-semibold text-blue-600 hover:underline" onClick={() => setShowAdvanced((v) => !v)}>
                  {showAdvanced ? 'Hide server settings' : 'Server settings (only if auto-detect fails)'}
                </button>
              </div>
              {showAdvanced && (
                <>
                  <div className="space-y-1"><Label className="text-xs font-semibold">SMTP server</Label>
                    <Input value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} placeholder="smtp.yourprovider.com" className="h-9 rounded-xl text-sm" /></div>
                  <div className="space-y-1"><Label className="text-xs font-semibold">Port</Label>
                    <Input value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} placeholder="587" className="h-9 rounded-xl text-sm" /></div>
                </>
              )}
              <div className="sm:col-span-2 flex items-center gap-2">
                <Button onClick={connectOther} disabled={busy === 'other'} className="h-9 rounded-xl text-sm gap-2">
                  {busy === 'other' && <Loader2 className="h-4 w-4 animate-spin" />}Connect
                </Button>
                <p className={`text-[11px] ${muted}`}>Server settings are detected automatically. Some hosting plans block password-based sending; Google or Microsoft sign-in always works.</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className={`text-xs ${muted}`}>Only an administrator can connect or change the organisation's email.</p>
      )}
    </div>
  );
}
