/**
 * SignInEmails — Settings → Integrations → My sign-in.
 *
 * An account can sign in with several emails. Adding one emails a 6-digit
 * code to that address; the email is added once the code is entered.
 * Several accounts may also share one email: sign-in then shows a list.
 */
import React, { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { KeyRound, Loader2, Mail, Trash2 } from 'lucide-react';

export default function SignInEmails({ isDark = false }) {
  const [data, setData] = useState(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);

  const card = isDark ? 'bg-slate-800/40 border-slate-700' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const strong = isDark ? 'text-slate-100' : 'text-slate-800';
  const err = (e, f) => e?.response?.data?.detail || f;

  const load = useCallback(async () => {
    try { setData((await api.get('/auth/sign-in-emails')).data); }
    catch (e) { toast.error(err(e, 'Could not load your sign-in emails')); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const sendCode = async () => {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await api.post('/auth/sign-in-emails', { email: email.trim() });
      setPending(email.trim().toLowerCase());
      toast.success(`Code sent to ${email.trim()}`);
    } catch (e) { toast.error(err(e, 'Could not send the code')); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const res = await api.post('/auth/sign-in-emails', { email: pending, code: code.trim() });
      setData((d) => ({ ...(d || {}), emails: res.data.emails }));
      toast.success(`${pending} added`);
      setPending(''); setEmail(''); setCode('');
    } catch (e) { toast.error(err(e, 'That code did not work')); }
    finally { setBusy(false); }
  };

  const remove = async (value) => {
    if (!window.confirm(`Stop signing in with ${value}?`)) return;
    try {
      const res = await api.delete(`/auth/sign-in-emails/${encodeURIComponent(value)}`);
      setData((d) => ({ ...(d || {}), emails: res.data.emails }));
    } catch (e) { toast.error(err(e, 'Could not remove it')); }
  };

  return (
    <div className={`rounded-2xl border p-5 space-y-4 ${card}`}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-50 dark:bg-blue-500/10"><KeyRound className="h-5 w-5 text-blue-600" /></div>
        <div>
          <p className={`text-sm font-bold ${strong}`}>My sign-in emails</p>
          <p className={`text-xs mt-0.5 ${muted}`}>You can sign in with any of these, using your usual password. If one email belongs to several accounts, sign-in asks which one to open.</p>
        </div>
      </div>

      <ul className="space-y-1.5">
        {(data?.emails || []).map((value) => (
          <li key={value} className={`flex items-center justify-between rounded-xl border px-3 py-2 text-sm ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
            <span className={`flex items-center gap-2 ${strong}`}><Mail className="h-3.5 w-3.5 text-slate-400" />{value}{value === data?.primary && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">Main</span>}</span>
            {value !== data?.primary && (
              <button type="button" onClick={() => remove(value)} className="text-red-500 hover:text-red-700" aria-label={`Remove ${value}`}><Trash2 className="h-3.5 w-3.5" /></button>
            )}
          </li>
        ))}
      </ul>

      {!pending ? (
        <div className="flex gap-2">
          <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="another@email.com" className="h-9 rounded-xl text-sm" aria-label="New sign-in email" />
          <Button onClick={sendCode} disabled={busy || !email.trim()} className="h-9 rounded-xl text-sm gap-2">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Send code</Button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className={`text-xs ${muted}`}>Enter the 6-digit code we emailed to <strong>{pending}</strong>.</p>
          <div className="flex gap-2">
            <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="123456" inputMode="numeric" className="h-9 rounded-xl text-sm w-32" aria-label="Verification code" />
            <Button onClick={confirm} disabled={busy || code.length !== 6} className="h-9 rounded-xl text-sm gap-2">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Add email</Button>
            <Button variant="ghost" onClick={() => { setPending(''); setCode(''); }} className="h-9 rounded-xl text-sm">Cancel</Button>
          </div>
        </div>
      )}
    </div>
  );
}
