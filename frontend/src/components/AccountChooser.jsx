/**
 * AccountChooser — "Choose account" step when one email signs in to several
 * accounts (in different organisations, or the same one). Used by the login
 * page and by "Switch organisation" in the profile menu.
 */
import React, { useState } from 'react';
import { Building2, ChevronRight, Loader2, X } from 'lucide-react';

export default function AccountChooser({ accounts = [], onChoose, onCancel, title = 'Choose an account' }) {
  const [busy, setBusy] = useState('');

  const pick = async (account) => {
    if (busy) return;
    setBusy(account.user_id);
    try { await onChoose(account); } finally { setBusy(''); }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/50 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl dark:bg-slate-900">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 p-5 dark:border-slate-800">
          <div>
            <h2 className="text-base font-bold text-slate-900 dark:text-slate-100">{title}</h2>
            <p className="mt-0.5 text-xs text-slate-500">This email signs in to {accounts.length} accounts. Pick the one to open.</p>
          </div>
          {onCancel && (
            <button type="button" onClick={onCancel} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Cancel">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
          {accounts.map((account) => (
            <li key={account.user_id}>
              <button
                type="button"
                onClick={() => pick(account)}
                disabled={!!busy}
                className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-slate-50 disabled:opacity-60 dark:hover:bg-slate-800"
              >
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/10">
                  <Building2 className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{account.organisation}</span>
                  <span className="block truncate text-xs text-slate-500">
                    {account.full_name} · {String(account.role || '').replace(/^\w/, (c) => c.toUpperCase())}
                    {account.status && account.status !== 'active' ? ` · ${account.status}` : ''}
                  </span>
                </span>
                {busy === account.user_id ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-300" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
