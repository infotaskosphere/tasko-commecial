// Shared EngageX UI building blocks (status, progress, polling, merge tags, file import).
import React, { useEffect, useRef } from 'react';
import { format, formatDistanceToNowStrict } from 'date-fns';

export const BRAND = { teal: '#0E9F8A', whatsapp: '#16A34A', email: '#4F46E5', danger: '#E11D48', amber: '#D97706', slate: '#64748B' };

/**
 * Card with the same look as PageKit's SectionCard. Its title bar is a <div>
 * rather than a <header>: the global module-switcher rules in
 * commercial-business-ui.css / master-data-ui.css target `#root header + div`
 * and would otherwise clamp the card body to 40px and recolour its buttons.
 */
export function ExCard({ icon: Icon, title, description, badge, actions, children, color = BRAND.teal, padded = true, className = '' }) {
  return (
    <section className={`relative min-w-0 max-w-full rounded-2xl border bg-white shadow-sm border-slate-100 dark:bg-slate-800/60 dark:border-slate-700/80 dark:shadow-none ${className}`}>
      {(title || actions) && (
        <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-5 py-4 border-b border-slate-100 dark:border-slate-700/80 min-w-0">
          <div className="flex items-start gap-3 min-w-0">
            {Icon && <div className="p-2 rounded-xl shrink-0" style={{ background: `${color}18` }}><Icon className="h-5 w-5" style={{ color }} /></div>}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-bold text-slate-800 dark:text-slate-100 break-words">{title}</h2>
                {badge !== undefined && badge !== null && <span className="text-[10px] font-extrabold px-2 py-0.5 rounded-full shrink-0" style={{ background: `${color}18`, color }}>{badge}</span>}
              </div>
              {description && <p className="text-xs mt-1 leading-relaxed max-w-2xl text-slate-500 dark:text-slate-400 break-words">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center justify-end gap-2 flex-wrap min-w-0 sm:justify-self-end">{actions}</div>}
        </div>
      )}
      <div className={padded ? 'p-5 min-w-0' : 'min-w-0'}>{children}</div>
    </section>
  );
}

const CAMPAIGN_STATUS = {
  draft: { label: 'Draft', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300' },
  queued: { label: 'Queued', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300' },
  scheduled: { label: 'Scheduled', cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  running: { label: 'Sending', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300', pulse: true },
  paused: { label: 'Paused', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' },
  completed: { label: 'Completed', cls: 'bg-teal-100 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
  failed: { label: 'Failed', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' },
  // recipient / message states
  pending: { label: 'Pending', cls: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300' },
  sending: { label: 'Sending', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300', pulse: true },
  sent: { label: 'Sent', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300' },
  skipped: { label: 'Skipped', cls: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300' },
  opened: { label: 'Opened', cls: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300' },
};

export function StatusBadge({ status }) {
  const meta = CAMPAIGN_STATUS[status] || { label: status || '—', cls: CAMPAIGN_STATUS.draft.cls };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ${meta.cls}`}>
      {meta.pulse && <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />}
      {meta.label}
    </span>
  );
}

export const isActive = (status) => ['queued', 'scheduled', 'running'].includes(status);

/** Stacked delivery bar: sent / failed / skipped out of total. */
export function DeliveryBar({ stats = {}, className = '' }) {
  const total = Math.max(1, stats.total || 0);
  const pct = (n) => `${Math.min(100, ((n || 0) * 100) / total)}%`;
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-slate-700/60 flex ${className}`}>
      <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: pct(stats.sent) }} />
      <div className="h-full bg-rose-500 transition-all duration-500" style={{ width: pct(stats.failed) }} />
      <div className="h-full bg-slate-400/70 transition-all duration-500" style={{ width: pct(stats.skipped) }} />
    </div>
  );
}

export function fmtDateTime(value) {
  if (!value) return '—';
  try { return format(new Date(value), 'dd MMM yyyy, h:mm a'); } catch { return String(value); }
}

export function fmtAgo(value) {
  if (!value) return '';
  try { return `${formatDistanceToNowStrict(new Date(value))} ago`; } catch { return ''; }
}

export const fmtNumber = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-IN'));
export const fmtPct = (n) => (n === null || n === undefined ? '—' : `${n}%`);

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

/** Calls `fn` every `ms` while `enabled`; skips while the tab is hidden. */
export function usePolling(fn, ms, enabled = true) {
  const saved = useRef(fn);
  useEffect(() => { saved.current = fn; }, [fn]);
  useEffect(() => {
    if (!enabled) return undefined;
    const id = window.setInterval(() => { if (!document.hidden) saved.current(); }, ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}

// ── Merge tags ───────────────────────────────────────────────────────────────
export const MERGE_TAGS = [
  { tag: 'first_name', label: 'First name' },
  { tag: 'name', label: 'Full name' },
  { tag: 'company', label: 'Client / company' },
  { tag: 'phone', label: 'Phone' },
  { tag: 'email', label: 'Email' },
  { tag: 'sender_company', label: 'Your company' },
  { tag: 'date', label: "Today's date" },
];

/** Insert text at the caret of a textarea/input ref and return the new value. */
export function insertAtCursor(el, value, text) {
  if (!el) return `${value || ''}${text}`;
  const start = el.selectionStart ?? value.length;
  const end = el.selectionEnd ?? value.length;
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
  requestAnimationFrame(() => {
    el.focus();
    const pos = start + text.length;
    el.setSelectionRange?.(pos, pos);
  });
  return next;
}

export function MergeTagBar({ onInsert, extra = [] }) {
  const tags = [...MERGE_TAGS, ...extra.filter((t) => !MERGE_TAGS.some((m) => m.tag === t)).map((t) => ({ tag: t, label: t }))];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400 mr-1">Personalise:</span>
      {tags.map(({ tag, label }) => (
        <button
          key={tag}
          type="button"
          onClick={() => onInsert(`{{${tag}}}`)}
          className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:border-teal-400 hover:text-teal-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300 dark:hover:text-teal-300"
          title={`Insert {{${tag}}}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Client-side preview of server-side merge rendering ({{tag}} / {{tag|fallback}}). */
export function renderMergePreview(template, variables = {}) {
  return String(template || '').replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\|\s*([^}]*?))?\s*\}\}/g, (_, key, fallback) => {
    const value = variables[key];
    return value !== undefined && value !== null && value !== '' ? String(value) : (fallback || '').trim();
  });
}

export function previewVariables(recipient = {}, senderCompany = '') {
  const name = recipient.name || '';
  return {
    ...(recipient.variables || {}),
    name,
    first_name: name.trim().split(/\s+/)[0] || '',
    email: recipient.email || '',
    phone: recipient.phone || '',
    company: recipient.company || '',
    client_name: recipient.company || '',
    sender_company: senderCompany,
    date: format(new Date(), 'dd MMM yyyy'),
  };
}

// ── Normalisation (mirrors backend/engagex/common.py) ────────────────────────
export function normalizePhone(raw, defaultCountry = '91') {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 && defaultCountry) digits = `${defaultCountry}${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

const EMAIL_RE = /^[A-Za-z0-9._%+\-']+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export function normalizeEmail(raw) {
  const value = String(raw || '').trim().replace(/^<|>$/g, '').toLowerCase();
  return value && value.length <= 254 && EMAIL_RE.test(value) ? value : null;
}

export const normalizeAddress = (channel, value) => (channel === 'whatsapp' ? normalizePhone(value) : normalizeEmail(value));
export const addressKey = (channel) => (channel === 'whatsapp' ? 'phone' : 'email');

/** De-duplicate recipients by normalised address; returns { rows, invalid, duplicates }. */
export function dedupeRecipients(channel, list) {
  const key = addressKey(channel);
  const seen = new Map();
  let invalid = 0;
  for (const row of list) {
    const address = normalizeAddress(channel, row?.[key]);
    if (!address) { invalid += 1; continue; }
    if (!seen.has(address)) seen.set(address, { ...row, [key]: address });
  }
  return { rows: [...seen.values()], invalid, duplicates: Math.max(0, list.length - invalid - seen.size) };
}

// ── File import (CSV / Excel) ────────────────────────────────────────────────
const HEADER_HINTS = {
  phone: ['phone', 'mobile', 'whatsapp', 'contact no', 'contact number', 'number', 'cell', 'mobile no', 'phone number'],
  email: ['email', 'e-mail', 'mail', 'email address', 'email id'],
  name: ['name', 'full name', 'contact name', 'customer name', 'person', 'first name'],
  company: ['company', 'company name', 'client', 'client name', 'business', 'organisation', 'organization', 'firm'],
};

export function detectColumns(headers) {
  const lower = headers.map((h) => String(h || '').trim().toLowerCase());
  const mapping = {};
  for (const [field, hints] of Object.entries(HEADER_HINTS)) {
    const exact = lower.findIndex((h) => hints.includes(h));
    const partial = exact >= 0 ? exact : lower.findIndex((h) => hints.some((hint) => h.includes(hint)));
    if (partial >= 0 && !Object.values(mapping).includes(headers[partial])) mapping[field] = headers[partial];
  }
  return mapping;
}

/** Parse a CSV/XLS/XLSX file into { headers, rows } (rows are objects keyed by header). */
export async function parseSpreadsheet(file) {
  const name = String(file?.name || '').toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.txt') || file.type === 'text/csv') {
    const Papa = (await import('papaparse')).default;
    const text = await file.text();
    const result = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: (h) => String(h || '').trim() });
    return { headers: result.meta.fields || [], rows: result.data || [] };
  }
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return { headers, rows };
}

/** Turn parsed rows + a column mapping into recipient objects; unmapped columns become merge variables. */
export function rowsToRecipients(rows, mapping) {
  const mapped = new Set(Object.values(mapping).filter(Boolean));
  return rows.map((row) => {
    const variables = {};
    for (const [header, value] of Object.entries(row)) {
      if (!mapped.has(header) && value !== '' && value !== null && value !== undefined) {
        const key = header.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
        if (key) variables[key] = String(value).slice(0, 500);
      }
    }
    return {
      name: mapping.name ? String(row[mapping.name] || '').trim() : '',
      phone: mapping.phone ? String(row[mapping.phone] || '').trim() : '',
      email: mapping.email ? String(row[mapping.email] || '').trim() : '',
      company: mapping.company ? String(row[mapping.company] || '').trim() : '',
      variables,
    };
  });
}

/** Parse "name, number" / "name <email>" / bare values pasted one per line. */
export function parsePasted(channel, text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (channel === 'email') {
        const angle = line.match(/^(.*?)<([^>]+)>/);
        if (angle) return [{ name: angle[1].replace(/[",]/g, '').trim(), email: angle[2].trim() }];
        const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
        const email = parts.find((p) => p.includes('@'));
        if (!email) return [];
        return [{ email, name: parts.filter((p) => p !== email).join(' ') }];
      }
      const parts = line.split(/[,;\t]/).map((p) => p.trim()).filter(Boolean);
      if (parts.length === 1 && /\d{6,}/.test(parts[0].replace(/\D/g, ''))) {
        // "Ravi 9876543210" or just "9876543210"
        const match = parts[0].match(/^(.*?)([+\d][\d\s\-()]{7,})$/);
        return [{ name: (match?.[1] || '').trim(), phone: (match?.[2] || parts[0]).trim() }];
      }
      const phone = parts.find((p) => p.replace(/\D/g, '').length >= 10) || '';
      return [{ phone, name: parts.filter((p) => p !== phone).join(' ') }];
    });
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',').pop());
    reader.onerror = () => reject(reader.error || new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

// ── WhatsApp sending pace ────────────────────────────────────────────────────
export const SPEED_PRESETS = {
  safe: { label: 'Safe', hint: 'Best for new or personal numbers', min_delay_sec: 10, max_delay_sec: 20, pause_every: 20, pause_sec: 120 },
  balanced: { label: 'Balanced', hint: 'Recommended for most campaigns', min_delay_sec: 6, max_delay_sec: 12, pause_every: 25, pause_sec: 60 },
  fast: { label: 'Fast', hint: 'Only for warmed-up business numbers', min_delay_sec: 3, max_delay_sec: 6, pause_every: 50, pause_sec: 45 },
};

export function estimateWhatsAppSeconds(count, pace) {
  if (!count) return 0;
  const avg = (Number(pace.min_delay_sec) + Number(pace.max_delay_sec)) / 2;
  const pauses = pace.pause_every ? Math.floor((count - 1) / pace.pause_every) : 0;
  return (count - 1) * avg + pauses * Number(pace.pause_sec || 0);
}

export function localDateTimeValue(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
