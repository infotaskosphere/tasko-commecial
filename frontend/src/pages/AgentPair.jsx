// Connect a computer's Taskosphere Agent to the signed-in account.
//
// The agent opens /agent/pair?code=XXXXXXXX in the browser the first time it
// runs (or from "Connect to Taskosphere" in its tray menu). One click here
// gives that computer its own credential; the agent never asks for a login.
// See backend/desktop_agent_pairing.py.
import React, { useEffect, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2, Monitor, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import api, { getErrorMessage } from '@/lib/api';
import { POPUP_GRADIENT } from '@/components/ui/popup-header';

// Read back after sign-in by AppRoutes (PublicOnly / ProtectedLayout).
const PENDING_PAIR_KEY = 'taskosphere_pending_agent_pair';

function Shell({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 p-4 dark:bg-slate-950">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
        <div className="relative overflow-hidden px-6 py-5 text-white" style={{ background: POPUP_GRADIENT }}>
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center bg-white p-1.5">
              <img src="/icon-mark.png" alt="" className="h-full w-full object-contain" />
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/60">Taskosphere Agent</p>
              <h1 className="text-xl font-bold leading-snug">Connect this computer</h1>
            </div>
          </div>
        </div>
        <div className="space-y-4 px-6 py-6 text-sm text-slate-700 dark:text-slate-200">{children}</div>
      </div>
    </div>
  );
}

export default function AgentPair() {
  const { user, loading } = useAuth();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const code = String(params.get('code') || '').trim().toUpperCase().slice(0, 16);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [state, setState] = useState('loading'); // loading | ready | connecting | done | error

  // Keyed on the id: the auth context may hand out a fresh user object when it
  // refreshes, which must not reset a finished connection back to "ready".
  const userId = user?.id;
  useEffect(() => {
    if (!userId || !code) return;
    let alive = true;
    api.get(`/desktop/pair/${encodeURIComponent(code)}`)
      .then((res) => {
        if (!alive) return;
        setDetails(res.data);
        setState(res.data?.status === 'pending' ? 'ready' : 'done');
      })
      .catch((err) => { if (alive) { setError(getErrorMessage(err)); setState('error'); } });
    return () => { alive = false; };
  }, [userId, code]);

  if (loading) {
    return <Shell><p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p></Shell>;
  }
  if (!user) {
    // Remember the code across sign-in; the login page brings the user back.
    try { if (code) sessionStorage.setItem(PENDING_PAIR_KEY, code); } catch { /* storage unavailable */ }
    return <Navigate to="/login" replace />;
  }
  if (!code) {
    return (
      <Shell>
        <p>This page is opened by the Taskosphere Agent. Right-click the Taskosphere icon in the system tray and choose <b>Connect to Taskosphere</b>.</p>
        <Button variant="outline" onClick={() => navigate('/settings/desktop-agent')}>Desktop Agent settings</Button>
      </Shell>
    );
  }

  const connect = async () => {
    setState('connecting');
    try {
      await api.post(`/desktop/pair/${encodeURIComponent(code)}/approve`);
      setState('done');
    } catch (err) {
      setError(getErrorMessage(err));
      setState('error');
    }
  };

  return (
    <Shell>
      {state === 'loading' && <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Checking the connection request…</p>}

      {(state === 'ready' || state === 'connecting') && details && (
        <>
          <p>Connect the Taskosphere Agent on this computer to your account? It then runs in the background and starts with Windows; no login is needed in the agent.</p>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm dark:border-slate-700 dark:bg-slate-800/60">
            <dt className="text-slate-500">Computer</dt>
            <dd className="flex min-w-0 items-center gap-1.5 break-words font-semibold"><Monitor className="h-4 w-4 shrink-0 text-slate-400" />{details.machine_name}</dd>
            {details.os_user && <><dt className="text-slate-500">Windows user</dt><dd className="min-w-0 break-words font-semibold">{details.os_user}</dd></>}
            <dt className="text-slate-500">Your account</dt>
            <dd className="min-w-0 break-words font-semibold">{user.full_name || user.email}</dd>
          </dl>
          <p className="text-xs text-slate-500">Only connect a computer you are using now. While connected, the agent reports DSC token details, the applications and websites in use, idle time and USB device events from this computer.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => navigate('/dashboard')} disabled={state === 'connecting'}>Cancel</Button>
            <Button onClick={connect} disabled={state === 'connecting'} className="bg-[#0D3B66] text-white hover:bg-[#1F6FB2]">
              {state === 'connecting' ? <><Loader2 className="mr-1.5 h-4 w-4 animate-spin" />Connecting…</> : 'Connect this computer'}
            </Button>
          </div>
        </>
      )}

      {state === 'done' && (
        <>
          <p className="flex items-start gap-2 font-semibold text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />{details?.machine_name || 'This computer'} is connected.</p>
          <p>The agent is running in the background. Look for the Taskosphere icon in the system tray (bottom-right, next to the clock). You can close this tab.</p>
          <div className="flex justify-end"><Button variant="outline" onClick={() => navigate('/settings/desktop-agent')}>Desktop Agent settings</Button></div>
        </>
      )}

      {state === 'error' && (
        <>
          <p className="flex items-start gap-2 font-semibold text-rose-700 dark:text-rose-300"><XCircle className="mt-0.5 h-5 w-5 shrink-0" />Could not connect this computer.</p>
          <p className="break-words">{error}</p>
          <div className="flex justify-end"><Button variant="outline" onClick={() => navigate('/settings/desktop-agent')}>Desktop Agent settings</Button></div>
        </>
      )}
    </Shell>
  );
}
