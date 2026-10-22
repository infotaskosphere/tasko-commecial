import React, { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { errText } from '@/lib/books';

/* Small building blocks shared by the Books & Vouchers tabs. */

export const field = (isDark) => `h-9 rounded-lg border px-3 text-sm ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-300 text-slate-800'}`;
export const labelCls = (isDark) => `text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
export const mutedCls = (isDark) => (isDark ? 'text-slate-400' : 'text-slate-500');

export function Labeled({ label, isDark, children, className = '' }) {
  return (
    <label className={`flex flex-col gap-1 ${className}`}>
      <span className={labelCls(isDark)}>{label}</span>
      {children}
    </label>
  );
}

export function AccountSelect({ accounts, value, onChange, isDark, placeholder = 'Choose an account', ariaLabel }) {
  return (
    <select aria-label={ariaLabel || placeholder} value={value || ''} onChange={(e) => onChange(e.target.value)} className={`${field(isDark)} w-full min-w-0`}>
      <option value="">{placeholder}</option>
      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
    </select>
  );
}

const SPAN = { 1: '', 2: 'md:col-span-2', 3: 'md:col-span-3', 4: 'md:col-span-4' };

/**
 * A grid of labelled inputs described by data.
 * fields: [{ key, label, type: text|number|date|select|checkbox|account, options, step, min, span, hint, show(values), accounts }]
 */
export function FormGrid({ fields, values, onChange, isDark, columns = 3 }) {
  const set = (key, v) => onChange({ ...values, [key]: v });
  const cols = { 2: 'md:grid-cols-2', 3: 'md:grid-cols-3', 4: 'md:grid-cols-4' }[columns] || 'md:grid-cols-3';
  return (
    <div className={`grid gap-3 ${cols}`}>
      {fields.filter((f) => !f.show || f.show(values)).map((f) => {
        const v = values[f.key] ?? '';
        const wrap = `${SPAN[f.span || 1]}`;
        if (f.type === 'checkbox') {
          return (
            <label key={f.key} className={`flex items-start gap-2 text-sm ${wrap}`}>
              <input type="checkbox" checked={!!values[f.key]} onChange={(e) => set(f.key, e.target.checked)} className="mt-1" />
              <span>{f.label}{f.hint && <span className={`block text-xs ${mutedCls(isDark)}`}>{f.hint}</span>}</span>
            </label>
          );
        }
        let input;
        if (f.type === 'select') {
          input = (
            <select aria-label={f.label} value={v} onChange={(e) => set(f.key, e.target.value)} className={`${field(isDark)} w-full`}>
              {f.placeholder !== undefined && <option value="">{f.placeholder}</option>}
              {f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          );
        } else if (f.type === 'account') {
          input = <AccountSelect accounts={f.accounts || []} value={v} onChange={(x) => set(f.key, x)} isDark={isDark} placeholder={f.placeholder || 'Choose an account'} ariaLabel={f.label} />;
        } else {
          input = (
            <input aria-label={f.label} type={f.type || 'text'} value={v} min={f.min} step={f.step} placeholder={f.placeholder}
              onChange={(e) => set(f.key, e.target.value)} className={`${field(isDark)} w-full ${f.type === 'number' ? 'font-mono' : ''}`} />
          );
        }
        return (
          <Labeled key={f.key} label={f.label} isDark={isDark} className={wrap}>
            {input}
            {f.hint && <span className={`text-xs ${mutedCls(isDark)}`}>{f.hint}</span>}
          </Labeled>
        );
      })}
    </div>
  );
}

/** A simple table. columns: [{ key, label, align, render(row), mono }] */
export function DataTable({ columns, rows, isDark, empty = 'Nothing here yet.', rowKey = 'id' }) {
  if (!rows?.length) return <p className={`text-sm py-6 text-center ${mutedCls(isDark)}`}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className={`w-full text-sm ${isDark ? '!bg-transparent [&_th]:!bg-slate-800 [&_th]:!text-slate-400 [&_td]:!bg-transparent [&_td]:!text-slate-200' : ''}`}>
        <thead>
          <tr className={`text-left text-xs ${mutedCls(isDark)}`}>
            {columns.map((c) => <th key={c.key} className={`py-2 pr-3 font-semibold ${c.align === 'right' ? 'text-right' : ''}`}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody className={isDark ? 'text-slate-200' : 'text-slate-800'}>
          {rows.map((r, i) => (
            <tr key={r[rowKey] ?? i} className={`border-t align-top ${isDark ? 'border-slate-700' : 'border-slate-200'} ${r._muted ? 'opacity-50' : ''}`}>
              {columns.map((c) => (
                <td key={c.key} className={`py-2 pr-3 ${c.align === 'right' ? 'text-right' : ''} ${c.mono ? 'font-mono text-xs' : ''}`}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TONES = {
  good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  warn: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  bad: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
  mute: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
};

export function Pill({ tone = 'mute', children }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${TONES[tone] || TONES.mute}`}>{children}</span>;
}

export function Stat({ label, value, hint, isDark, tone }) {
  return (
    <div className={`rounded-2xl border p-3 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-white'}`}>
      <p className={labelCls(isDark)}>{label}</p>
      <p className={`mt-1 text-lg font-bold font-mono ${tone === 'bad' ? 'text-red-500' : tone === 'good' ? 'text-emerald-600' : ''}`}>{value}</p>
      {hint && <p className={`mt-0.5 text-xs ${mutedCls(isDark)}`}>{hint}</p>}
    </div>
  );
}

/** Inner navigation inside a tab. Plain buttons (not role=tab) so the app's global tab styling does not restyle them. */
export function SubNav({ tabs, value, onChange, isDark, label = 'Section' }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {tabs.map(([key, text]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}
          className={`px-3 h-8 rounded-lg text-xs font-semibold border ${value === key ? 'bg-blue-600 border-blue-600 text-white' : isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-700/40' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function PrimaryButton({ children, ...props }) {
  return (
    <button type="button" {...props}
      className={`h-9 px-4 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed ${props.className || ''}`}>
      {children}
    </button>
  );
}

export function GhostButton({ children, isDark, ...props }) {
  return (
    <button type="button" {...props}
      className={`h-8 px-3 rounded-lg text-xs font-semibold border disabled:opacity-50 ${isDark ? 'border-slate-600 text-slate-200 hover:bg-slate-700/50' : 'border-slate-300 text-slate-700 hover:bg-slate-50'} ${props.className || ''}`}>
      {children}
    </button>
  );
}

/** Load data for a panel. fn returns the data; the hook gives { data, loading, error, reload }. */
export function useLoad(fn, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      setState({ data: await fn(), loading: false, error: '' });
    } catch (e) {
      setState({ data: null, loading: false, error: errText(e, 'Could not load this.') });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { ...state, reload };
}

/** Run a server action with a busy flag and a toast. Returns the result, or null on failure. */
export async function runAction(setBusy, fn, success) {
  setBusy?.(true);
  try {
    const r = await fn();
    if (success) toast.success(typeof success === 'function' ? success(r) : success);
    return r ?? true;
  } catch (e) {
    toast.error(errText(e));
    return null;
  } finally {
    setBusy?.(false);
  }
}

export function Loading() {
  return <ContentLoader />;
}

export function ErrorNote({ error, isDark }) {
  return error ? <p role="alert" className={`text-sm py-4 ${isDark ? 'text-red-300' : 'text-red-600'}`}>{error}</p> : null;
}

/** Drop empty strings and turn numeric fields into numbers before sending a form to the server. */
export function clean(values, numeric = []) {
  const out = {};
  Object.entries(values).forEach(([k, v]) => {
    if (v === '' || v === undefined || v === null) return;
    out[k] = numeric.includes(k) ? Number(v) : v;
  });
  return out;
}

export function Section({ title, children, action, isDark }) {
  return (
    <section className={`rounded-2xl border ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
      <div className={`flex items-center justify-between gap-2 px-4 py-3 border-b ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
        <h4 className="text-sm font-bold">{title}</h4>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
