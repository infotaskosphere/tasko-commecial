import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, KeyRound, Laptop, Loader2, Monitor, RefreshCw, ShieldAlert, Unplug, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { GuidanceNote, PageBanner } from '@/components/ui/PageKit';
import { useAuth } from '@/contexts/AuthContext';
import api, { getErrorMessage } from '@/lib/api';
import {
  AGENT_DOWNLOAD_URL,
  agentEnabledInThisBrowser,
  compareVersions,
  connectAgent,
  disconnectAgent,
  getAgentHealth,
  getLatestAgentVersion,
  setAgentEnabledInThisBrowser,
} from '@/lib/desktopAgent';

function currentToken() {
  try {
    return sessionStorage.getItem('token') || localStorage.getItem('token') || '';
  } catch {
    return '';
  }
}

function Step({ n, title, children, done }) {
  return (
    <div className="flex gap-3">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100'}`}>
        {done ? <CheckCircle2 className="h-4 w-4" /> : n}
      </div>
      <div className="min-w-0 flex-1 pb-5">
        <p className="text-sm font-semibold">{title}</p>
        <div className="mt-1 text-sm text-slate-600 dark:text-slate-300">{children}</div>
      </div>
    </div>
  );
}

export default function DesktopAgentSettings() {
  const { user } = useAuth();
  const [checking, setChecking] = useState(false);
  const [checkedOnce, setCheckedOnce] = useState(false);
  const [health, setHealth] = useState(null);
  const [latest, setLatest] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [downloaded, setDownloaded] = useState(false);
  const [devices, setDevices] = useState({ loading: true, items: [], isAdmin: false });

  // Computers connected by pairing (the agent's own credential).
  const loadDevices = useCallback(async () => {
    try {
      const res = await api.get('/desktop/devices');
      setDevices({ loading: false, items: res.data?.devices || [], isAdmin: !!res.data?.is_admin });
    } catch {
      setDevices({ loading: false, items: [], isAdmin: false });
    }
  }, []);
  useEffect(() => { loadDevices(); }, [loadDevices]);

  const revoke = async (device) => {
    try {
      await api.delete(`/desktop/devices/${encodeURIComponent(device.id)}`);
      toast.success(`${device.machine_name} disconnected. Its agent will ask to be connected again.`);
      loadDevices();
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  // Contacting 127.0.0.1 can make the browser ask for local-network permission,
  // so the page only checks automatically where the agent was set up before.
  const check = useCallback(async () => {
    setChecking(true);
    const result = await getAgentHealth();
    setHealth(result);
    setCheckedOnce(true);
    setChecking(false);
    return result;
  }, []);

  useEffect(() => {
    getLatestAgentVersion().then(setLatest);
    if (agentEnabledInThisBrowser()) {
      check().then((result) => setConnected(Boolean(result)));
    }
  }, [check]);

  const connect = async () => {
    setConnecting(true);
    try {
      const result = health || (await check());
      if (!result) {
        toast.error('The agent is not running on this computer yet. Install it, then try again.');
        return;
      }
      await connectAgent(currentToken(), user?.id);
      setConnected(true);
      toast.success('Desktop Agent connected to your account.');
    } catch (error) {
      toast.error(`Could not connect the agent: ${error.message}`);
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    await disconnectAgent();
    setAgentEnabledInThisBrowser(false);
    setConnected(false);
    toast.success('Desktop Agent disconnected from your account on this computer.');
  };

  const running = Boolean(health);
  const outdated = running && latest && compareVersions(latest, health.version) > 0;

  let statusTone = 'slate';
  let statusText = 'Not checked yet';
  let StatusIcon = Monitor;
  if (checking) {
    statusText = 'Checking this computer…';
    StatusIcon = Loader2;
  } else if (running && connected) {
    statusTone = 'emerald';
    statusText = `Running and connected · version ${health.version}`;
    StatusIcon = CheckCircle2;
  } else if (running) {
    statusTone = 'amber';
    statusText = `Running · version ${health.version} · not connected to your account`;
    StatusIcon = Unplug;
  } else if (checkedOnce) {
    statusTone = 'rose';
    statusText = 'Not detected on this computer';
    StatusIcon = XCircle;
  }
  const toneClass = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200',
    amber: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
    rose: 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  }[statusTone];

  return (
    <div className="w-full min-w-0 space-y-5 text-slate-800 dark:text-slate-100">
      <PageBanner
        icon={Monitor}
        eyebrow="Settings"
        title="Desktop Agent"
        subtitle="A small Windows program that reads your DSC token for auto-fill and DSC expiry tracking, and reports desktop activity to Taskosphere."
      />

      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${toneClass}`}>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <StatusIcon className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
          {statusText}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={check} disabled={checking}>
            <RefreshCw className="mr-1.5 h-4 w-4" />Check this computer
          </Button>
          {running && !connected ? (
            <Button size="sm" onClick={connect} disabled={connecting} className="bg-emerald-600 text-white hover:bg-emerald-700">
              {connecting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <KeyRound className="mr-1.5 h-4 w-4" />}Connect to my account
            </Button>
          ) : null}
          {connected ? (
            <Button size="sm" variant="outline" onClick={disconnect} className="border-rose-200 text-rose-600 hover:bg-rose-50">
              <Unplug className="mr-1.5 h-4 w-4" />Disconnect
            </Button>
          ) : null}
        </div>
      </div>

      {outdated ? (
        <GuidanceNote icon={Download} tone="warning">
          Version {latest} is available (this computer has {health.version}). Download and run the installer again to update; your settings are kept.
        </GuidanceNote>
      ) : null}

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <p className="mb-4 text-sm font-semibold">Set up on this computer</p>
        <Step n={1} title="Download the installer" done={downloaded || running}>
          <p>For Windows 10 and 11 (64-bit). No administrator rights needed.</p>
          <a href={AGENT_DOWNLOAD_URL} onClick={() => setDownloaded(true)} rel="noopener">
            <Button size="sm" className="mt-2 bg-blue-600 text-white hover:bg-blue-700">
              <Download className="mr-1.5 h-4 w-4" />Download for Windows{latest ? ` (v${latest})` : ''}
            </Button>
          </a>
        </Step>
        <Step n={2} title="Run TaskosphereAgentSetup.exe" done={running || devices.items.length > 0}>
          <p>Open the downloaded file and click through the installer. The agent starts straight away, shows the Taskosphere icon in the system tray (bottom-right, next to the clock; it may be under the <b>^</b> arrow), and from then on starts whenever you sign in to Windows.</p>
          <p className="mt-1 flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            If Windows shows “Windows protected your PC”, click <b>More info</b> → <b>Run anyway</b>. The installer is not yet code-signed.
          </p>
        </Step>
        <Step n={3} title="Click “Connect this computer”" done={connected || devices.items.length > 0}>
          <p>The first time it runs, the agent opens a Taskosphere page in your browser. Click <b>Connect this computer</b> there. No login is needed in the agent, and it stays connected after restarts.</p>
          <p className="mt-1">If the page did not open, right-click the Taskosphere tray icon and choose <b>Connect to Taskosphere</b>.</p>
        </Step>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">{devices.isAdmin ? 'Connected computers in your company' : 'Your connected computers'}</p>
          <Button size="sm" variant="outline" onClick={loadDevices}><RefreshCw className="mr-1.5 h-4 w-4" />Refresh</Button>
        </div>
        {devices.loading ? (
          <p className="flex items-center gap-2 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : devices.items.length === 0 ? (
          <p className="text-sm text-slate-500">No computer is connected yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {devices.items.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <Laptop className="h-5 w-5 shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold">{d.machine_name}{d.os_user ? <span className="font-normal text-slate-500"> · {d.os_user}</span> : null}</p>
                    <p className="text-xs text-slate-500">
                      {devices.isAdmin && d.user_name ? `${d.user_name} · ` : ''}
                      Connected {d.created_at ? new Date(d.created_at).toLocaleDateString() : ''}
                      {d.last_seen_at ? ` · last active ${new Date(d.last_seen_at).toLocaleString()}` : ' · not active yet'}
                    </p>
                  </div>
                </div>
                <Button size="sm" variant="outline" onClick={() => revoke(d)} className="border-rose-200 text-rose-600 hover:bg-rose-50">
                  <Unplug className="mr-1.5 h-4 w-4" />Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <GuidanceNote icon={Monitor}>
        While connected, the agent sends Taskosphere your DSC token details, the applications and websites in use, idle time and USB device events from this computer. Disconnect here, or uninstall it from Windows Settings → Apps, to stop.
      </GuidanceNote>
    </div>
  );
}
