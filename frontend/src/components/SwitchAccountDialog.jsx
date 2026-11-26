/**
 * SwitchAccountDialog — "Switch organisation" from the profile menu.
 *
 * Asks for the password again, lists the other accounts that sign in with
 * the same email(s) and password, and signs in to the one picked.
 */
import React, { useState } from 'react';
import api from '@/lib/api';
import { toast } from 'sonner';
import { Loader2, X } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import AccountChooser from '@/components/AccountChooser';

export default function SwitchAccountDialog({ open, onClose }) {
  const { login, refreshUser, user } = useAuth();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState(null);

  if (!open) return null;

  const close = () => { setPassword(''); setChoice(null); onClose?.(); };

  const findAccounts = async (event) => {
    event?.preventDefault();
    if (!password) return;
    setBusy(true);
    try {
      const res = await api.post('/auth/switch-account/options', { password });
      const others = (res.data.accounts || []);
      if (others.length <= 1) {
        toast.info('No other accounts use your sign-in email with this password.');
        close();
        return;
      }
      setChoice({ token: res.data.choice_token, accounts: others });
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not check your accounts.');
    } finally { setBusy(false); }
  };

  const choose = async (account) => {
    if (account.user_id === user?.id) { close(); return; }
    try {
      const res = await api.post('/auth/login/choose', { choice_token: choice.token, user_id: account.user_id });
      const keep = localStorage.getItem('taskosphere_keep_signed_in') === 'true';
      if (!login(res.data, keep)) throw new Error('Invalid response');
      await refreshUser();
      toast.success(`Switched to ${account.organisation}`);
      close();
      window.location.assign('/');
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not switch account.');
      close();
    }
  };

  if (choice) {
    return <AccountChooser title="Switch organisation" accounts={choice.accounts} onChoose={choose} onCancel={close} />;
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label="Switch organisation">
      <form onSubmit={findAccounts} className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900">
        <div className="mb-3 flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">Switch organisation</h2>
            <p className="mt-0.5 text-xs text-slate-500">Enter your password to see your other accounts.</p>
          </div>
          <button type="button" onClick={close} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100" aria-label="Cancel"><X className="h-4 w-4" /></button>
        </div>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-800"
          placeholder="Password"
          aria-label="Password"
        />
        <button type="submit" disabled={busy || !password} className="mt-3 flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-blue-600 text-sm font-semibold text-white disabled:opacity-60">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}Show my accounts
        </button>
      </form>
    </div>
  );
}
