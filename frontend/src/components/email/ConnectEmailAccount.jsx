// "Add email account" — connect a mailbox the way mail apps do.
// Google and Microsoft accounts use sign-in (no password stored). Any other
// address needs only the email and password: the server works out the mail
// server for that address by itself. Shared by MailMaster senders and the
// Commercial Console platform email service.
import React, { useEffect, useState } from 'react';
import { AtSign, ChevronDown, ChevronLeft, KeyRound, Loader2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const errorText = (error) => {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.map((d) => d?.msg).filter(Boolean).join(' ') || 'Something went wrong.';
  return error?.message || 'Something went wrong.';
};

/** Official multi-colour Google "G". */
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

/** Microsoft four-square mark. */
export function MicrosoftMark({ className = 'h-5 w-5' }) {
  return (
    <svg className={className} viewBox="0 0 23 23" aria-hidden="true">
      <path fill="#F25022" d="M1 1h10v10H1z" /><path fill="#7FBA00" d="M12 1h10v10H12z" />
      <path fill="#00A4EF" d="M1 12h10v10H1z" /><path fill="#FFB900" d="M12 12h10v10H12z" />
    </svg>
  );
}

function ProviderButton({ icon, children, busy, disabled, onClick, note, className = '' }) {
  return (
    <div className="flex flex-col items-stretch">
      <button type="button" onClick={onClick} disabled={busy || disabled}
        className={`inline-flex items-center justify-center gap-3 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 hover:shadow disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800 ${className}`}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
        {children}
      </button>
      {note && <span className="mt-1 text-center text-[11px] text-slate-500">{note}</span>}
    </div>
  );
}

/**
 * Starts Google / Microsoft sign-in. `api.startGoogle(loginHint)` and
 * `api.startMicrosoft(loginHint)` resolve to { auth_url }; the browser leaves
 * for the provider and comes back with ?google=… or ?microsoft=….
 */
export function useAccountSignIn(api) {
  const [busy, setBusy] = useState(null);
  const signIn = async (provider, loginHint) => {
    setBusy(provider);
    try {
      const { auth_url: url } = await (provider === 'google' ? api.startGoogle(loginHint) : api.startMicrosoft(loginHint));
      window.location.assign(url);
    } catch (error) {
      toast.error(errorText(error));
      setBusy(null);
    }
  };
  return { signIn, busy };
}

/** The three ways in, as a row of buttons. */
export function ConnectAccountButtons({ api, options, onOther, size = 'md' }) {
  const { signIn, busy } = useAccountSignIn(api);
  const pad = size === 'lg' ? 'px-5 py-3' : '';
  const googleOff = options && options.google_available === false;
  const microsoftOff = options && options.microsoft_available === false;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <ProviderButton icon={<GoogleMark />} busy={busy === 'google'} disabled={googleOff} onClick={() => signIn('google')} className={pad}
        note={googleOff ? 'Not enabled on this server' : null}>
        {busy === 'google' ? 'Opening Google…' : 'Continue with Google'}
      </ProviderButton>
      <ProviderButton icon={<MicrosoftMark />} busy={busy === 'microsoft'} disabled={microsoftOff} onClick={() => signIn('microsoft')} className={pad}
        note={microsoftOff ? 'Not enabled yet — use Other email' : null}>
        {busy === 'microsoft' ? 'Opening Microsoft…' : 'Continue with Microsoft'}
      </ProviderButton>
      <ProviderButton icon={<AtSign className="h-5 w-5 text-slate-500" />} onClick={onOther} className={pad}>Other email</ProviderButton>
    </div>
  );
}

/**
 * Dialog for "Other email": type the address → we detect the provider →
 * Gmail/Outlook addresses go to sign-in, everything else asks for the password.
 *
 * api: { detect(email), startGoogle(hint), startMicrosoft(hint), connectPassword({ email, password, from_name, advanced }) }
 */
export function ConnectEmailDialog({ open, onOpenChange, api, onConnected, defaultName = '', askName = true, onManualSetup }) {
  const [step, setStep] = useState('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fromName, setFromName] = useState('');
  const [info, setInfo] = useState(null);
  const [working, setWorking] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advanced, setAdvanced] = useState({ host: '', port: 465, security: 'ssl', username: '' });
  const { signIn, busy } = useAccountSignIn(api);

  useEffect(() => {
    if (!open) return;
    setStep('email'); setEmail(''); setPassword(''); setInfo(null); setShowAdvanced(false);
    setFromName(defaultName || ''); setAdvanced({ host: '', port: 465, security: 'ssl', username: '' });
  }, [open, defaultName]);

  const next = async (e) => {
    e?.preventDefault();
    const address = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return toast.error('Enter a valid email address.');
    setWorking(true);
    try {
      const found = await api.detect(address);
      setInfo(found);
      const first = found.candidates?.[0];
      if (first) setAdvanced({ host: first.host, port: first.port, security: first.security, username: '' });
      setStep('password');
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setWorking(false);
    }
  };

  const connect = async (e) => {
    e?.preventDefault();
    if (!password) return toast.error('Enter the password.');
    setWorking(true);
    try {
      const result = await api.connectPassword({
        email: email.trim(), password, from_name: askName ? (fromName.trim() || null) : undefined,
        advanced: showAdvanced ? { host: advanced.host.trim(), port: Number(advanced.port) || 587, security: advanced.security, username: advanced.username.trim() || null } : null,
      });
      toast.success(`${email.trim()} is connected`);
      onConnected?.(result);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorText(error));
      setShowAdvanced((v) => v || /server|reach|Advanced/i.test(errorText(error)));
    } finally {
      setWorking(false);
    }
  };

  const signingIn = !!busy;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{step === 'email' ? 'Add an email account' : `Sign in to ${info?.provider_label || 'your email'}`}</DialogTitle>
          <DialogDescription>
            {step === 'email'
              ? 'Enter the address you want to send from. Next you’ll enter its password — the mail server is found automatically.'
              : email.trim()}
          </DialogDescription>
        </DialogHeader>

        {step === 'email' ? (
          <form onSubmit={next} className="space-y-3">
            <label className="block text-xs font-semibold text-slate-500">Email address
              <Input className="mt-1" type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourcompany.com" autoComplete="email" />
            </label>
            {signingIn && <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Opening {busy === 'google' ? 'Google' : 'Microsoft'} sign-in…</p>}
            <DialogFooter className="gap-2 sm:justify-between">
              {onManualSetup ? <button type="button" onClick={onManualSetup} className="text-xs text-slate-500 underline-offset-2 hover:underline">Set up manually (SMTP relay)</button> : <span />}
              <Button type="submit" disabled={working || signingIn}>{working ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Checking…</> : 'Next'}</Button>
            </DialogFooter>
          </form>
        ) : (
          <form onSubmit={connect} className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:bg-slate-800 dark:text-slate-300">
              <Mail className="h-4 w-4 shrink-0" /><span className="truncate">{info?.provider_label}</span>
            </div>
            <label className="block text-xs font-semibold text-slate-500">{info?.provider === 'google' ? 'App password' : 'Password'}
              <Input className="mt-1" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            </label>
            {info?.password_help && <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-300"><KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />{info.password_help}</p>}
            {(info?.oauth === 'google' || (info?.oauth === 'microsoft' && info?.microsoft_available)) && (
              <button type="button" onClick={() => signIn(info.oauth, email.trim())} disabled={signingIn}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
                {info.oauth === 'google' ? <GoogleMark className="h-4 w-4" /> : <MicrosoftMark className="h-4 w-4" />}
                Or sign in with {info.oauth === 'google' ? 'Google' : 'Microsoft'} instead (no password)
              </button>
            )}
            {askName && (
              <label className="block text-xs font-semibold text-slate-500">Name recipients see
                <Input className="mt-1" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Your company name" />
              </label>
            )}
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
              <ChevronDown className={`h-3.5 w-3.5 transition ${showAdvanced ? 'rotate-180' : ''}`} />Advanced (mail server)
            </button>
            {showAdvanced && (
              <div className="grid gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700 sm:grid-cols-[minmax(0,1fr)_80px_110px]">
                <label className="text-[11px] font-semibold text-slate-500">Outgoing (SMTP) server<Input className="mt-1 h-8" value={advanced.host} onChange={(e) => setAdvanced({ ...advanced, host: e.target.value })} placeholder="mail.yourdomain.com" /></label>
                <label className="text-[11px] font-semibold text-slate-500">Port<Input className="mt-1 h-8" type="number" value={advanced.port} onChange={(e) => setAdvanced({ ...advanced, port: e.target.value })} /></label>
                <label className="text-[11px] font-semibold text-slate-500">Security
                  <select className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-900" value={advanced.security} onChange={(e) => setAdvanced({ ...advanced, security: e.target.value })}>
                    <option value="ssl">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">None</option>
                  </select>
                </label>
                <label className="text-[11px] font-semibold text-slate-500 sm:col-span-3">Username (if not the email address)<Input className="mt-1 h-8" value={advanced.username} onChange={(e) => setAdvanced({ ...advanced, username: e.target.value })} autoComplete="off" /></label>
              </div>
            )}
            <DialogFooter className="gap-2 sm:justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep('email')}><ChevronLeft className="mr-1 h-4 w-4" />Back</Button>
              <Button type="submit" disabled={working}>{working ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Connecting…</> : 'Connect'}</Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
