/**
 * GoogleDriveConnect.jsx
 * ──────────────────────────────────────────────────────────────────────────
 * FIX: The google_auth router is mounted on `app` (not `api_router`), so its
 * routes are at /auth/google/... NOT /api/auth/google/...
 * The `api` axios instance always prepends /api, so status & disconnect calls
 * must go directly to BACKEND_URL using fetch() with the token header.
 *
 * Routes used:
 *   GET  BACKEND_URL/auth/google/status      → check connection
 *   POST BACKEND_URL/auth/google/disconnect  → remove token
 *   GET  BACKEND_URL/auth/google             → start OAuth (browser redirect)
 */

import React, { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import {
  HardDriveUpload, CheckCircle2, Info, Loader2,
  Unplug, RefreshCw, ExternalLink, ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BACKEND_BASE_URL } from '@/lib/api';

// ── Resolve the raw backend base URL (no /api suffix) ────────────────────
const BACKEND_URL = BACKEND_BASE_URL;

// ── Token lookup ───────────────────────────────────────────────────────────
// NOTE: api.js's exported getToken() only checks localStorage, but
// AuthContext.persistAuth() stores the token in sessionStorage instead
// whenever "Keep me signed in" was NOT checked at login. Axios calls still
// work in that case because AuthContext also sets
// api.defaults.headers.common.Authorization directly in memory — but this
// component talks to the backend via raw fetch(), bypassing axios entirely,
// so it must check both storages itself or it silently sends no auth header
// for any session that isn't "remembered".
function getAuthToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}

// ── Authenticated fetch directly to BACKEND_URL (bypasses /api prefix) ───
async function authFetch(path, options = {}) {
  const token = getAuthToken();
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Status pill ───────────────────────────────────────────────────────────
function StatusPill({ connected, loading }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </span>
    );
  }
  return connected ? (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      Connected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400">
      <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
      Not connected
    </span>
  );
}

// ── Feature row ───────────────────────────────────────────────────────────
function FeatureRow({ icon: Icon, text, isDark }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ background: 'rgba(31,111,178,0.12)' }}>
        <Icon className="h-3.5 w-3.5 text-[#1F6FB2]" />
      </div>
      <p className={`text-xs leading-snug ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{text}</p>
    </div>
  );
}

// ── Google Drive SVG icon ─────────────────────────────────────────────────
function DriveIcon({ className = 'w-6 h-6' }) {
  return (
    <svg viewBox="0 0 87.3 78" xmlns="http://www.w3.org/2000/svg" className={className}>
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z" fill="#00ac47"/>
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 27h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
export default function GoogleDriveConnect({ isDark = false }) {
  const [status,        setStatus]        = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);

  // ── Fetch status from /auth/google/status (no /api prefix) ──────────
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const data = await authFetch('/auth/google/status');
      setStatus(data);
    } catch (err) {
      console.warn('Drive status check failed:', err.message);
      setStatus({ connected: false, source: 'none' });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  // ── On mount: handle OAuth return params + fetch status ─────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const driveParam = params.get('drive');

    if (driveParam === 'connected') {
      toast.success('Google Drive connected!', {
        description: 'Invoices will now be saved to your Drive automatically.',
      });
      params.delete('drive');
      const clean = params.toString()
        ? `${window.location.pathname}?${params}`
        : window.location.pathname;
      window.history.replaceState({}, '', clean);
    } else if (driveParam === 'error') {
      const reason = params.get('reason') || 'unknown error';
      if (reason === 'no_refresh_token') {
        toast.error('No refresh token received', {
          description: 'Click Disconnect then reconnect to force a new Google consent screen.',
        });
      } else {
        toast.error('Google Drive connection failed', { description: reason });
      }
      params.delete('drive');
      params.delete('reason');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (driveParam === 'denied') {
      toast.warning('Google Drive access was denied.');
      params.delete('drive');
      window.history.replaceState({}, '', window.location.pathname);
    }

    fetchStatus();
  }, []); // eslint-disable-line

  // ── Connect: redirect browser to backend OAuth start ────────────────
  const handleConnect = () => {
    window.location.href = `${BACKEND_URL}/auth/google`;
  };

  // ── Disconnect ───────────────────────────────────────────────────────
  const handleDisconnect = async () => {
    if (!window.confirm('Disconnect Google Drive? Invoice uploads will stop until you reconnect.')) return;
    setDisconnecting(true);
    try {
      await authFetch('/auth/google/disconnect', { method: 'POST' });
      setStatus({ connected: false, source: 'none' });
      toast.success('Google Drive disconnected.');
    } catch (err) {
      toast.error('Failed to disconnect.', { description: err.message });
    } finally {
      setDisconnecting(false);
    }
  };

  const D = isDark;
  const connected = status?.connected ?? false;

  return (
    <div className={`rounded-2xl border overflow-hidden shadow-sm ${D ? 'bg-slate-800/60 border-slate-700/70' : 'bg-white border-slate-200'}`}>
      {/* Gradient top bar */}
      <div className="h-1 w-full" style={{
        background: connected
          ? 'linear-gradient(90deg,#1FAF5A,#5CCB5F)'
          : 'linear-gradient(90deg,#0D3B66,#1F6FB2)',
      }} />

      <div className="p-6">
        {/* Header row */}
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm"
              style={{ background: connected ? 'linear-gradient(135deg,#e8f5e9,#c8e6c9)' : 'linear-gradient(135deg,#e3f0fb,#c5dcf7)' }}>
              <DriveIcon className="w-6 h-6" />
            </div>
            <div>
              <h3 className={`font-bold text-base ${D ? 'text-slate-100' : 'text-slate-800'}`}>Google Drive</h3>
              <p className={`text-xs mt-0.5 ${D ? 'text-slate-400' : 'text-slate-500'}`}>Cloud storage integration</p>
            </div>
          </div>
          <StatusPill connected={connected} loading={statusLoading} />
        </div>

        {/* Feature list */}
        <div className={`rounded-xl p-4 mb-5 space-y-3 ${D ? 'bg-slate-700/40' : 'bg-slate-50'}`}>
          <FeatureRow icon={HardDriveUpload} text="Auto-save invoices and PDFs to your Drive folder" isDark={D} />
          <FeatureRow icon={ShieldCheck}     text="Secure OAuth 2.0 — no passwords stored" isDark={D} />
          <FeatureRow icon={ExternalLink}    text="Client portal users can browse Drive folders you share" isDark={D} />
        </div>

        {/* Connected details */}
        {!statusLoading && connected && (
          <div className={`rounded-xl p-4 mb-5 border flex items-start gap-3 ${D ? 'bg-emerald-900/20 border-emerald-700/40' : 'bg-emerald-50 border-emerald-200'}`}>
            <CheckCircle2 className="h-4 w-4 text-emerald-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className={`text-sm font-semibold ${D ? 'text-emerald-300' : 'text-emerald-700'}`}>Drive is active and ready</p>
              <p className={`text-xs mt-0.5 ${D ? 'text-emerald-400' : 'text-emerald-600'}`}>
                {status?.source === 'env' ? 'Token loaded from environment variable.' : 'Token stored securely in database.'}
                {' '}Invoice uploads and client portal documents are enabled.
              </p>
            </div>
          </div>
        )}

        {/* Not connected hint */}
        {!statusLoading && !connected && (
          <div className={`rounded-xl p-4 mb-5 border flex items-start gap-3 ${D ? 'bg-amber-900/20 border-amber-700/40' : 'bg-amber-50 border-amber-200'}`}>
            <Info className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className={`text-xs ${D ? 'text-amber-300' : 'text-amber-700'}`}>
              Connect your Google account to enable invoice auto-save and client portal document browsing.
              You'll be taken to Google's login page — no passwords are stored by Taskosphere.
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3 flex-wrap">
          {!connected ? (
            <Button
              onClick={handleConnect}
              disabled={statusLoading}
              className="h-9 px-5 rounded-xl text-sm font-semibold text-white gap-2 shadow-sm"
              style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}
            >
              <DriveIcon className="w-4 h-4" />
              Connect Google Drive
            </Button>
          ) : (
            <>
              <Button
                onClick={handleDisconnect}
                disabled={disconnecting}
                variant="outline"
                className={`h-9 px-4 rounded-xl text-sm gap-2 ${D ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                Disconnect
              </Button>
              <Button
                onClick={handleConnect}
                variant="outline"
                className={`h-9 px-4 rounded-xl text-sm gap-2 ${D ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Reconnect
              </Button>
            </>
          )}
          <button
            onClick={fetchStatus}
            disabled={statusLoading}
            className={`h-9 w-9 rounded-xl border flex items-center justify-center transition-colors ${D ? 'border-slate-600 text-slate-400 hover:bg-slate-700' : 'border-slate-200 text-slate-400 hover:bg-slate-50'}`}
            title="Refresh status"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Footer note */}
        <p className={`text-[10px] mt-4 pt-4 border-t ${D ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
          After connecting, also set <strong>GOOGLE_REFRESH_TOKEN</strong> in your Render environment variables
          for persistence across server restarts. The token is saved in the database for immediate use.
        </p>
      </div>
    </div>
  );
}
