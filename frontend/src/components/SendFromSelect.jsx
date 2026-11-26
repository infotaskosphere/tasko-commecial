/**
 * SendFromSelect — "Send from" picker used by every screen that emails clients.
 *
 * Lists the organisation's connected mailboxes (Settings → Integrations →
 * Email) and the signed-in user's own mailboxes. The organisation default is pre-selected; with no mailbox
 * connected, mail goes out through the platform email service under the
 * organisation's name, and a link to connect one is shown.
 *
 * Value: a sender id, or "" for "use the organisation default".
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '@/lib/api';
import { Mail } from 'lucide-react';

export const ORG_EMAIL_SETTINGS_PATH = '/settings/general?tab=integrations&section=email';

let cached = null;
let cachedAt = 0;

export async function fetchOrgEmailStatus(force = false) {
  if (!force && cached && Date.now() - cachedAt < 60_000) return cached;
  const res = await api.get('/organisation-email/status');
  cached = res.data;
  cachedAt = Date.now();
  return cached;
}

export function useOrgEmailStatus() {
  const [status, setStatus] = useState(cached);
  useEffect(() => {
    let alive = true;
    fetchOrgEmailStatus().then((s) => alive && setStatus(s)).catch(() => alive && setStatus(null));
    return () => { alive = false; };
  }, []);
  return status;
}

export default function SendFromSelect({ value, onChange, className = '', compact = false }) {
  const status = useOrgEmailStatus();
  if (!status) return null;
  const mailboxes = status.mailboxes || [];

  if (!mailboxes.length) {
    return (
      <div className={`flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800 ${className}`}>
        <Mail className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
        <span>
          Sends through the platform email service under your organisation's name.{' '}
          <Link to={ORG_EMAIL_SETTINGS_PATH} className="font-semibold underline">Connect your email in Settings</Link>{' '}
          to send from your own address.
        </span>
      </div>
    );
  }

  return (
    <div className={`space-y-1 ${className}`}>
      {!compact && <label className="text-xs font-semibold block">Send from</label>}
      <div className="flex items-center gap-2">
        <select
          value={value || ''}
          onChange={(e) => onChange?.(e.target.value)}
          className="h-9 flex-1 rounded-xl border border-slate-200 bg-white px-3 text-sm dark:bg-slate-800 dark:border-slate-700"
          aria-label="Send from"
        >
          <option value="">{status.default_from_email ? `${status.default_from_email} (organisation default)` : "Platform email service (organisation's name)"}</option>
          {mailboxes.filter((m) => !m.is_default && !m.personal).map((m) => (
            <option key={m.id} value={m.id}>{m.from_email}</option>
          ))}
          {mailboxes.some((m) => m.personal) && (
            <optgroup label="My mailboxes">
              {mailboxes.filter((m) => m.personal).map((m) => (
                <option key={m.id} value={m.id}>{`${m.from_email} (only you)`}</option>
              ))}
            </optgroup>
          )}
        </select>
        <Link to={ORG_EMAIL_SETTINGS_PATH} className="text-[11px] font-semibold text-blue-600 hover:underline whitespace-nowrap">Manage</Link>
      </div>
    </div>
  );
}
