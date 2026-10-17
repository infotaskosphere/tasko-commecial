import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, ChevronDown, ChevronUp, RefreshCw, RotateCcw, TrendingDown, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';

const PERIODS = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
];

const FIELD_LABEL = {
  supplier_name: 'Supplier name', supplier_gstin: 'Supplier GSTIN', buyer_name: 'Buyer name', buyer_gstin: 'Buyer GSTIN',
  invoice_no: 'Invoice no.', invoice_date: 'Invoice date', due_date: 'Due date', taxable_amount: 'Taxable value',
  cgst_amount: 'CGST', sgst_amount: 'SGST', igst_amount: 'IGST', cess_amount: 'Cess', total_gst: 'Total GST',
  round_off: 'Round-off', grand_total: 'Grand total', place_of_supply: 'Place of supply', document_type: 'Document type', currency: 'Currency',
};

const pct = (v) => (v == null ? '—' : `${v}%`);

function Stat({ label, value, hint, isDark }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
      <p className={`text-[11px] font-semibold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
      <p className={`text-xl font-bold mt-0.5 ${isDark ? 'text-white' : 'text-slate-900'}`}>{value}</p>
      {hint && <p className={`text-[11px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>{hint}</p>}
    </div>
  );
}

function Badge({ tone, children }) {
  const tones = {
    good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300',
    warn: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300',
    bad: 'bg-red-100 text-red-800 dark:bg-red-500/15 dark:text-red-300',
    idle: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  };
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone] || tones.idle}`}>{children}</span>;
}

export default function FinixLearningPanel({ companyId, isDark = false, isAdmin = false }) {
  const [days, setDays] = useState(90);
  const [report, setReport] = useState(null);
  const [memory, setMemory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState('');

  const load = useCallback(async () => {
    if (!companyId || companyId === '__all__') return;
    setLoading(true); setError('');
    try {
      const [acc, mem] = await Promise.all([
        api.get('/finix/ai/learning/accuracy', { params: { company_id: companyId, days } }),
        api.get('/finix/ai/learning/vendors', { params: { company_id: companyId } }),
      ]);
      setReport(acc.data);
      setMemory(mem.data?.vendors || []);
    } catch (err) {
      setReport(null); setMemory([]);
      setError(err?.response?.data?.detail || 'Could not load Finix accuracy.');
    } finally {
      setLoading(false);
    }
  }, [companyId, days]);

  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => {
    const byKey = new Map();
    (memory || []).forEach((m) => byKey.set(m.vendor_key, { ...m, bills: m.confirmations, read: 0, straight_through_rate: null, ledger_accuracy: null }));
    (report?.vendors || []).forEach((v) => {
      const cur = byKey.get(v.vendor_key) || { vendor_key: v.vendor_key, vendor_name: v.vendor_name, ledger_name: v.learned_ledger, auto_fill_active: v.auto_fill_active, confirmations: 0 };
      byKey.set(v.vendor_key, { ...cur, bills: v.bills, read: v.read, straight_through_rate: v.straight_through_rate, ledger_accuracy: v.ledger_accuracy, needs_attention: v.needs_attention });
    });
    return [...byKey.values()].sort((a, b) => (b.bills || 0) - (a.bills || 0));
  }, [memory, report]);

  const resetVendor = async (row) => {
    const ok = window.confirm(`Make Finix forget what it learned about "${row.vendor_name || row.vendor_key}"?\n\nBills already posted do not change. The next bill from this vendor will be reviewed from scratch.`);
    if (!ok) return;
    setResetting(row.vendor_key);
    try {
      await api.post('/finix/ai/learning/reset-vendor', { vendor_key: row.vendor_key, company_id: companyId });
      toast.success('Finix has forgotten this vendor.');
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not reset this vendor.');
    } finally {
      setResetting('');
    }
  };

  if (!companyId || companyId === '__all__') return null;

  const card = isDark ? 'bg-slate-900/60 border-slate-700' : 'bg-slate-50 border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const text = isDark ? 'text-slate-100' : 'text-slate-900';
  const reviewed = report?.bills_read_by_finix || 0;
  const imp = report?.improvement_points;
  const trend = report?.trend || [];
  const maxBills = Math.max(1, ...trend.map((t) => t.bills));

  return (
    <section className={`mb-6 rounded-2xl border p-4 ${card}`} data-testid="finix-learning-panel">
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex items-center gap-2">
          <Brain className="w-4 h-4 text-violet-500" />
          <h3 className={`text-sm font-bold ${text}`}>Finix accuracy</h3>
          <span className={`text-xs ${muted}`}>how often a purchase bill needed no changes from you</span>
        </div>
        <div className="flex items-center gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.days} type="button" onClick={() => setDays(p.days)}
              className={`text-xs px-2 py-1 rounded-md border ${days === p.days ? 'bg-violet-600 text-white border-violet-600' : isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`}
            >{p.label}</button>
          ))}
          <button type="button" onClick={load} title="Refresh" className={`p-1.5 rounded-md border ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`}>
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button type="button" onClick={() => setOpen((o) => !o)} className={`p-1.5 rounded-md border ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-300 text-slate-600'}`} aria-label={open ? 'Hide vendors' : 'Show vendors'}>
            {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {error && <p className="text-xs text-red-600 mt-3">{String(error)}</p>}

      {!error && report && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">
            <Stat isDark={isDark} label="Straight-through" value={reviewed ? pct(report.straight_through_rate) : '—'}
              hint={reviewed ? `${report.straight_through} of ${reviewed} scanned bills needed no edit` : 'Scan and confirm bills to start measuring'} />
            <Stat isDark={isDark} label="Expense head right" value={pct(report.ledger?.accuracy)}
              hint={report.ledger?.proposals ? `${report.ledger.correct} of ${report.ledger.proposals} proposals kept` : 'No proposals yet'} />
            <Stat isDark={isDark} label="Vendors learned" value={report.state?.vendors_known ?? 0}
              hint={`${report.state?.vendors_auto_filling ?? 0} auto-filling · ${report.state?.layouts_learned ?? 0} layouts`} />
            <div className={`rounded-xl border px-3 py-2.5 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200'}`}>
              <p className={`text-[11px] font-semibold uppercase tracking-wide ${muted}`}>Trend</p>
              {imp == null ? (
                <p className={`text-xs mt-1 ${muted}`}>{report.improvement_note}</p>
              ) : (
                <p className={`text-xl font-bold mt-0.5 flex items-center gap-1 ${imp >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {imp >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                  {imp >= 0 ? '+' : ''}{imp} pts
                  <span className={`text-[11px] font-normal ${muted}`}>vs earlier</span>
                </p>
              )}
              {trend.length > 0 && (
                <div className="flex items-end gap-0.5 h-7 mt-1.5" aria-label="Weekly straight-through rate">
                  {trend.slice(-12).map((t) => (
                    <div key={t.week} title={`Week of ${t.week}: ${t.straight_through}/${t.bills} bills, ${pct(t.rate)}`}
                      className="flex-1 rounded-sm bg-violet-500/70" style={{ height: `${Math.max(12, (t.rate || 0))}%`, opacity: 0.4 + 0.6 * (t.bills / maxBills) }} />
                  ))}
                </div>
              )}
            </div>
          </div>

          {Object.keys(report.field_edits || {}).length > 0 && (
            <p className={`text-xs mt-3 ${muted}`}>
              Most corrected fields:{' '}
              {Object.entries(report.field_edits).slice(0, 4).map(([f, c], i) => (
                <span key={f}>{i ? ' · ' : ''}{FIELD_LABEL[f] || f} ({c})</span>
              ))}
            </p>
          )}

          {open && (
            <div className="mt-3 overflow-x-auto">
              {rows.length === 0 ? (
                <p className={`text-xs ${muted}`}>Nothing learned yet. Finix starts learning from the first purchase bill you confirm.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className={`text-left ${muted}`}>
                      <th className="py-1.5 pr-3 font-semibold">Vendor</th>
                      <th className="py-1.5 pr-3 font-semibold text-right">Bills</th>
                      <th className="py-1.5 pr-3 font-semibold text-right">Straight-through</th>
                      <th className="py-1.5 pr-3 font-semibold">Expense head</th>
                      <th className="py-1.5 pr-3 font-semibold">Status</th>
                      {isAdmin && <th className="py-1.5 font-semibold text-right">Learned data</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 25).map((r) => (
                      <tr key={r.vendor_key} className={`border-t ${isDark ? 'border-slate-700' : 'border-slate-200'} ${text}`}>
                        <td className="py-1.5 pr-3 max-w-[14rem] truncate" title={r.vendor_key}>{r.vendor_name || r.vendor_key}</td>
                        <td className="py-1.5 pr-3 text-right">{r.bills ?? 0}</td>
                        <td className="py-1.5 pr-3 text-right">{r.read >= 1 ? pct(r.straight_through_rate) : '—'}</td>
                        <td className="py-1.5 pr-3 max-w-[12rem] truncate">{r.ledger_name || r.ledger_code || '—'}</td>
                        <td className="py-1.5 pr-3">
                          {r.auto_fill_active ? <Badge tone="good">Auto-fills</Badge>
                            : r.needs_attention ? <Badge tone="bad">Needs attention</Badge>
                              : r.corrections > 0 && r.clean_streak < 3 ? <Badge tone="warn">Re-checking</Badge>
                                : <Badge tone="idle">Learning</Badge>}
                        </td>
                        {isAdmin && (
                          <td className="py-1.5 text-right">
                            {memory.some((m) => m.vendor_key === r.vendor_key) && (
                              <button type="button" disabled={resetting === r.vendor_key} onClick={() => resetVendor(r)}
                                className="inline-flex items-center gap-1 text-red-600 hover:underline disabled:opacity-50">
                                <RotateCcw className="w-3 h-3" />Reset
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
          <p className={`text-[11px] mt-3 ${muted}`}>{report.how_it_works}</p>
        </>
      )}
    </section>
  );
}
