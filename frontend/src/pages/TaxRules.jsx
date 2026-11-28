import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Scale, RefreshCw, Plus, History, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import api from '@/lib/api';
import { useDark } from '@/hooks/useDark';

// Tax rules & law updates: every GST / TDS limit, rate and due date the books use,
// with the date it applies from. A law change is added as a NEW version with its
// own "applies from" date, so older transactions keep the rule of their day.

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;
const pct = (r) => `${+(Number(r) * 100).toFixed(4)}%`;

function showValue(kind, v) {
  if (v === null || v === undefined) return '—';
  if (kind === 'amount') return inr(v);
  if (kind === 'day') return `${v}th of next month`;
  if (kind === 'rate_list') return v.map((x) => `${x}%`).join(', ');
  if (kind === 'tds_section') {
    const parts = [];
    for (const [k, x] of Object.entries(v)) {
      if (k === 'name') continue;
      parts.push(`${k.replace(/_/g, ' ')}: ${k.startsWith('rate') ? pct(x) : inr(x)}`);
    }
    return parts.join(' · ');
  }
  return String(v);
}

function ValueEditor({ rule, value, onChange }) {
  if (!rule) return null;
  if (rule.kind === 'amount' || rule.kind === 'day') {
    return <Input type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
      placeholder={rule.kind === 'day' ? 'Day of month (1-31)' : 'Amount in ₹'} />;
  }
  if (rule.kind === 'rate_list') {
    return <Input value={value ?? ''} onChange={(e) => onChange(e.target.value)} placeholder="e.g. 0, 0.25, 3, 5, 18, 40" />;
  }
  // TDS section: one field per limit / rate; only the changed ones need filling.
  const base = rule.current?.value || {};
  const v = value || {};
  return (
    <div className="grid grid-cols-2 gap-2">
      {Object.keys(base).filter((k) => k !== 'name').map((k) => (
        <label key={k} className="text-xs text-slate-500">
          {k.replace(/_/g, ' ')} {k.startsWith('rate') ? '(e.g. 0.10 = 10%)' : '(₹)'}
          <Input type="number" step="any" value={v[k] ?? ''} placeholder={String(base[k])}
            onChange={(e) => onChange({ ...v, [k]: e.target.value })} />
        </label>
      ))}
    </div>
  );
}

export default function TaxRules() {
  const isDark = useDark();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState({});
  const [form, setForm] = useState({ key: '', value: null, effective_from: '', source: '', note: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const { data: d } = await api.get('/statutory-rules');
      setData(d);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load tax rules');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const selected = useMemo(() => (data?.rules || []).find((r) => r.key === form.key), [data, form.key]);
  const groups = useMemo(() => {
    const g = {};
    for (const r of data?.rules || []) (g[r.group] = g[r.group] || []).push(r);
    return g;
  }, [data]);

  const save = async () => {
    if (!selected) return toast.error('Pick the rule that changed');
    let value = form.value;
    if (selected.kind === 'rate_list') value = String(value || '').split(',').map((x) => x.trim()).filter(Boolean).map(Number);
    if (selected.kind === 'tds_section') {
      value = Object.fromEntries(Object.entries(value || {}).filter(([, x]) => x !== '' && x !== null).map(([k, x]) => [k, Number(x)]));
      if (!Object.keys(value).length) return toast.error('Fill at least one changed limit or rate');
    }
    if (!form.effective_from) return toast.error('Enter the date the change applies from');
    if (!form.source.trim()) return toast.error('Enter the notification / Act section');
    setSaving(true);
    try {
      await api.post('/statutory-rules', { key: form.key, value, effective_from: form.effective_from, source: form.source, note: form.note });
      toast.success('Law change saved. Transactions dated on or after that day now use it.');
      setForm({ key: '', value: null, effective_from: '', source: '', note: '' });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (v) => {
    const reason = window.prompt('Why is this version being withdrawn? (kept in the log)');
    if (!reason || reason.trim().length < 3) return;
    try {
      await api.post(`/statutory-rules/${v.id}/withdraw`, { reason });
      toast.success('Withdrawn. The previous version applies again.');
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not withdraw');
    }
  };

  const card = `rounded-2xl border p-4 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`;
  if (loading && !data) return <ContentLoader />;

  return (
    <div className="p-4 md:p-6 space-y-5 max-w-6xl">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-600/10 flex items-center justify-center"><Scale className="h-5 w-5 text-blue-600" /></div>
          <div>
            <h1 className={`text-xl font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Tax rules &amp; law updates</h1>
            <p className="text-sm text-slate-500">GST and TDS limits, rates and due dates used by the books, with the date each applies from.
              Each transaction uses the rule in force on its own date.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={load} className="gap-1.5"><RefreshCw className="h-4 w-4" />Refresh</Button>
      </div>

      {Object.entries(groups).map(([group, rules]) => (
        <div key={group} className={card}>
          <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">{group}</p>
          <div className="divide-y divide-slate-100 dark:divide-slate-700">
            {rules.map((r) => (
              <div key={r.key} className="py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{r.label}</p>
                    <p className="text-sm mt-0.5">{showValue(r.kind, r.current?.value)}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Applies from {r.current?.effective_from || '—'} · {r.current?.source || 'not set'}
                      {r.current?.origin === 'added' && <Badge className="ml-2" variant="secondary">updated</Badge>}
                    </p>
                    {r.upcoming?.length > 0 && (
                      <p className="text-xs text-amber-600 mt-1">
                        Upcoming: {r.upcoming.map((u) => `${showValue(r.kind, u.value)} from ${u.effective_from}`).join('; ')}
                      </p>
                    )}
                  </div>
                  <Button variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setOpen((o) => ({ ...o, [r.key]: !o[r.key] }))}>
                    <History className="h-3.5 w-3.5" />History ({r.history.length})
                  </Button>
                </div>
                {open[r.key] && (
                  <div className="mt-2 rounded-xl bg-slate-50 dark:bg-slate-900/40 p-3 space-y-1.5">
                    {r.history.slice().reverse().map((v, i) => (
                      <div key={v.id || `${v.effective_from}-${i}`} className="flex items-start justify-between gap-2 text-xs">
                        <div>
                          <span className="font-semibold">{v.effective_from}</span> — {showValue(r.kind, v.value)}
                          <span className="text-slate-400"> · {v.source}{v.note ? ` · ${v.note}` : ''} · {v.origin === 'added' ? `added by ${v.created_by_email || 'admin'}` : 'built in'}</span>
                        </div>
                        {v.origin === 'added' && data?.can_edit && (
                          <button onClick={() => withdraw(v)} className="text-red-500 hover:text-red-600 flex items-center gap-1 flex-shrink-0">
                            <Undo2 className="h-3 w-3" />Withdraw
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

      {data?.can_edit ? (
        <div className={card}>
          <p className={`text-sm font-bold mb-1 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}><Plus className="h-4 w-4 inline mr-1" />Add a law change</p>
          <p className="text-xs text-slate-500 mb-3">Enter the new value and the date it applies from. Earlier transactions keep the old rule.
            Nothing is overwritten; a mistaken entry can be withdrawn.</p>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-500">Rule that changed</label>
              <Select value={form.key} onValueChange={(k) => setForm((f) => ({ ...f, key: k, value: null }))}>
                <SelectTrigger><SelectValue placeholder="Pick a rule" /></SelectTrigger>
                <SelectContent>
                  {(data?.rules || []).map((r) => <SelectItem key={r.key} value={r.key}>{r.group}: {r.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-slate-500">Applies from</label>
              <Input type="date" value={form.effective_from} onChange={(e) => setForm((f) => ({ ...f, effective_from: e.target.value }))} />
            </div>
            <div className="md:col-span-2">
              <label className="text-xs text-slate-500">New value {selected ? `(now: ${showValue(selected.kind, selected.current?.value)})` : ''}</label>
              <ValueEditor rule={selected} value={form.value} onChange={(v) => setForm((f) => ({ ...f, value: v }))} />
            </div>
            <div>
              <label className="text-xs text-slate-500">Source (notification / circular / Act section)</label>
              <Input value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} placeholder="e.g. Notification No. 5/2027-Central Tax" />
            </div>
            <div>
              <label className="text-xs text-slate-500">Note (optional)</label>
              <Textarea rows={1} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={save} disabled={saving} className="bg-blue-600 hover:bg-blue-700 text-white">{saving ? 'Saving…' : 'Save law change'}</Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-slate-400">Only the Platform Owner can add law changes, because they apply to every company.</p>
      )}
    </div>
  );
}
