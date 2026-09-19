import React from 'react';
import { ShieldAlert, LogOut, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext.jsx';

/**
 * Shown when a signed-in user has NO page they are entitled to open.
 *
 * Previously firstAccessiblePath() returned "/login" in that case, and because
 * /login is a "public only" route that immediately redirects a signed-in user
 * to firstAccessiblePath() again, the app bounced /login -> /login forever and
 * rendered a completely blank white page. This screen breaks that loop and
 * tells the person (and you, while debugging) what the account actually has.
 */
export default function NoModuleAccess() {
  const { user, logout, refreshUser } = useAuth();

  const modules = Array.isArray(user?.licensed_modules) ? user.licensed_modules : [];
  const featureKeys = user?.selected_features && typeof user.selected_features === 'object'
    ? Object.keys(user.selected_features)
    : [];

  const signOut = async () => {
    try { await logout(); } finally { window.location.replace('/login'); }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="max-w-lg w-full rounded-3xl border border-slate-200 bg-white shadow-sm p-8 text-center">
        <div className="h-14 w-14 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="h-7 w-7 text-amber-500" />
        </div>
        <h2 className="text-lg font-bold text-slate-900">No accessible page on this license</h2>
        <p className="text-sm text-slate-500 mt-2">
          You are signed in{user?.email ? <> as <span className="font-semibold">{user.email}</span></> : null}, but this
          account has no page enabled by its license. Ask the license owner to open the license in the Master Console and
          confirm that the module and at least one page are selected, then refresh.
        </p>
        <div className="mt-4 text-left text-xs rounded-xl bg-slate-50 border border-slate-200 p-3 text-slate-600 space-y-1">
          <div><span className="font-semibold">Licensed modules:</span> {modules.length ? modules.join(', ') : '— none received —'}</div>
          <div><span className="font-semibold">Selected page groups:</span> {featureKeys.length ? featureKeys.join(', ') : '— none received —'}</div>
          <div><span className="font-semibold">Company:</span> {user?.company_id || '—'}</div>
        </div>
        <div className="mt-6 flex gap-3 justify-center">
          <button
            type="button"
            onClick={() => refreshUser?.()}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" /> Refresh access
          </button>
          <button
            type="button"
            onClick={signOut}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
