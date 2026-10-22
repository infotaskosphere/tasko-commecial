import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BookMarked, Plus, Trash2, Ban, CheckCircle2, AlertTriangle, Info, ChevronDown, ChevronRight, Lock, Unlock } from 'lucide-react';
import { ContentLoader } from '@/components/ui/GifLoader.jsx';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { normalizeCompanies } from '@/lib/companies';
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import RequestAccessGate from '@/components/RequestAccessGate.jsx';
import { PageHeader, ReportCard, Row, EmptyState, fmtC } from '@/components/reports/ReportShared.jsx';
import { AccountSelect, Labeled, field, labelCls } from './books/ui.jsx';
import InventoryTab from './books/InventoryTab.jsx';
import StandardsTab from './books/StandardsTab.jsx';
import NotesTab from './books/NotesTab.jsx';
import {
  ENTERABLE, FRAMEWORK_INFO, VOUCHER_LABELS, errText, fyOptions, isCashBank, journalTotals,
  particularAccounts, particularsTotal, sortChecklist, todayIso,
} from '@/lib/books';

const TABS = [
  ['vouchers', 'Vouchers'],
  ['period-end', 'Period-end'],
  ['year-end', 'Year-end'],
  ['groups', 'Groups'],
  ['inventory', 'Inventory'],
  ['standards', 'Standards'],
  ['notes', 'Notes'],
  ['settings', 'Settings'],
];

/* ═══ Vouchers ═══════════════════════════════════════════════════════════ */
const blankRow = () => ({ account_id: '', amount: '', memo: '' });
const blankLine = () => ({ account_id: '', debit: '', credit: '', memo: '' });

function VoucherForm({ companyId, accounts, isDark, onSaved }) {
  const [type, setType] = useState('payment');
  const [date, setDate] = useState(todayIso());
  const [narration, setNarration] = useState('');
  const [reference, setReference] = useState('');
  const [cashId, setCashId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [rows, setRows] = useState([blankRow()]);
  const [lines, setLines] = useState([blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);

  const cashBank = useMemo(() => accounts.filter((a) => a.is_active !== false && isCashBank(a)), [accounts]);
  const others = useMemo(() => particularAccounts(accounts), [accounts]);
  const totals = journalTotals(lines);
  const sideWord = type === 'payment' ? 'Paid from' : 'Received into';

  useEffect(() => { setCashId(''); setToId(''); }, [companyId]);

  const patchRow = (i, p) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const patchLine = (i, p) => setLines((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const save = async () => {
    const body = { company_id: companyId, voucher_type: type, date, narration, reference_no: reference };
    if (type === 'payment' || type === 'receipt') {
      Object.assign(body, { cash_bank_account_id: cashId, particulars: rows.filter((r) => r.account_id && Number(r.amount) > 0).map((r) => ({ account_id: r.account_id, amount: Number(r.amount), memo: r.memo })) });
    } else if (type === 'contra') {
      Object.assign(body, { cash_bank_account_id: cashId, to_account_id: toId, amount: Number(amount) || undefined });
    } else {
      Object.assign(body, { lines: lines.filter((l) => l.account_id && (Number(l.debit) > 0 || Number(l.credit) > 0)).map((l) => ({ account_id: l.account_id, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo })) });
    }
    setSaving(true);
    try {
      const { data } = await api.post('/accounting-books/vouchers', body);
      toast.success(`${VOUCHER_LABELS[type]} voucher ${data.voucher_no} saved`);
      setNarration(''); setReference(''); setAmount(''); setRows([blankRow()]); setLines([blankLine(), blankLine()]);
      onSaved?.();
    } catch (e) {
      toast.error(errText(e, 'Could not save the voucher.'));
    } finally {
      setSaving(false);
    }
  };

  const canSave = !saving && companyId && date && (
    ((type === 'payment' || type === 'receipt') && cashId && particularsTotal(rows) > 0)
    || (type === 'contra' && cashId && toId && Number(amount) > 0)
    || (type === 'journal' && totals.balanced)
  );

  return (
    <ReportCard title="New voucher" isDark={isDark}>
      <div className="flex flex-wrap gap-2 mb-4" role="group" aria-label="Voucher type">
        {ENTERABLE.map((t) => (
          <button key={t} type="button" aria-pressed={type === t} onClick={() => setType(t)}
            className={`px-3 h-8 rounded-lg text-xs font-semibold border ${type === t ? 'bg-blue-600 border-blue-600 text-white' : isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-700/40' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>
            {VOUCHER_LABELS[t]}
          </button>
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Labeled label="Date" isDark={isDark}><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field(isDark)} /></Labeled>
        {(type === 'payment' || type === 'receipt') && (
          <Labeled label={sideWord} isDark={isDark} className="md:col-span-2">
            <AccountSelect accounts={cashBank} value={cashId} onChange={setCashId} isDark={isDark} placeholder="Choose a cash or bank account" ariaLabel={sideWord} />
          </Labeled>
        )}
        {type === 'contra' && (
          <>
            <Labeled label="Transfer from" isDark={isDark}><AccountSelect accounts={cashBank} value={cashId} onChange={setCashId} isDark={isDark} placeholder="Cash or bank account" ariaLabel="Transfer from" /></Labeled>
            <Labeled label="Transfer to" isDark={isDark}><AccountSelect accounts={cashBank.filter((a) => a.id !== cashId)} value={toId} onChange={setToId} isDark={isDark} placeholder="Cash or bank account" ariaLabel="Transfer to" /></Labeled>
            <Labeled label="Amount (₹)" isDark={isDark}><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={field(isDark)} /></Labeled>
          </>
        )}
      </div>

      {(type === 'payment' || type === 'receipt') && (
        <div className="mt-4 space-y-2">
          <p className={labelCls(isDark)}>{type === 'payment' ? 'Paid to (accounts debited)' : 'Received from (accounts credited)'}</p>
          {rows.map((r, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[1fr_9rem_1fr_2.25rem]">
              <AccountSelect accounts={others} value={r.account_id} onChange={(v) => patchRow(i, { account_id: v })} isDark={isDark} ariaLabel={`Account ${i + 1}`} />
              <input aria-label={`Amount ${i + 1}`} type="number" min="0" step="0.01" placeholder="Amount" value={r.amount} onChange={(e) => patchRow(i, { amount: e.target.value })} className={`${field(isDark)} text-right font-mono`} />
              <input aria-label={`Note ${i + 1}`} placeholder="Note (optional)" value={r.memo} onChange={(e) => patchRow(i, { memo: e.target.value })} className={field(isDark)} />
              <button aria-label={`Remove row ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((x) => x.filter((_, j) => j !== i))} className="h-9 w-9 rounded-lg border border-transparent text-slate-400 hover:text-red-600 disabled:opacity-30"><Trash2 className="h-4 w-4 mx-auto" /></button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setRows((x) => [...x, blankRow()])}><Plus className="h-3.5 w-3.5 mr-1" />Add row</Button>
            <span className="text-sm font-mono font-semibold">Total {fmtC(particularsTotal(rows))}</span>
          </div>
        </div>
      )}

      {type === 'journal' && (
        <div className="mt-4 space-y-2">
          <p className={labelCls(isDark)}>Journals cannot use cash or bank accounts. Use a Payment, Receipt or Contra for those.</p>
          {lines.map((l, i) => (
            <div key={i} className="grid gap-2 md:grid-cols-[1fr_8rem_8rem_1fr_2.25rem]">
              <AccountSelect accounts={others} value={l.account_id} onChange={(v) => patchLine(i, { account_id: v })} isDark={isDark} ariaLabel={`Journal account ${i + 1}`} />
              <input aria-label={`Debit ${i + 1}`} type="number" min="0" step="0.01" placeholder="Debit" value={l.debit} onChange={(e) => patchLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} className={`${field(isDark)} text-right font-mono`} />
              <input aria-label={`Credit ${i + 1}`} type="number" min="0" step="0.01" placeholder="Credit" value={l.credit} onChange={(e) => patchLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} className={`${field(isDark)} text-right font-mono`} />
              <input aria-label={`Journal note ${i + 1}`} placeholder="Note (optional)" value={l.memo} onChange={(e) => patchLine(i, { memo: e.target.value })} className={field(isDark)} />
              <button aria-label={`Remove line ${i + 1}`} disabled={lines.length <= 2} onClick={() => setLines((x) => x.filter((_, j) => j !== i))} className="h-9 w-9 rounded-lg text-slate-400 hover:text-red-600 disabled:opacity-30"><Trash2 className="h-4 w-4 mx-auto" /></button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setLines((x) => [...x, blankLine()])}><Plus className="h-3.5 w-3.5 mr-1" />Add line</Button>
            <span className={`text-sm font-mono ${totals.balanced ? 'text-emerald-600' : 'text-amber-600'}`} role="status">
              Dr {fmtC(totals.debit)} · Cr {fmtC(totals.credit)} {totals.balanced ? '· balanced' : totals.debit || totals.credit ? `· off by ${fmtC(Math.abs(totals.difference))}` : ''}
            </span>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_14rem]">
        <Labeled label="Narration" isDark={isDark}><input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="What this voucher is for" className={field(isDark)} /></Labeled>
        <Labeled label="Cheque / reference no." isDark={isDark}><input value={reference} onChange={(e) => setReference(e.target.value)} className={field(isDark)} /></Labeled>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={save} disabled={!canSave} className="h-9 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50">{saving ? 'Saving…' : `Save ${VOUCHER_LABELS[type].toLowerCase()} voucher`}</Button>
      </div>
    </ReportCard>
  );
}

function VoucherList({ companyId, isDark, refreshKey, onChanged }) {
  const [type, setType] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const { data: d } = await api.get('/accounting-books/vouchers', { params: { company_id: companyId, voucher_type: type || undefined, search: search || undefined, page, page_size: 25 } });
      setData(d);
    } catch (e) {
      toast.error(errText(e, 'Could not load vouchers.'));
    } finally {
      setLoading(false);
    }
  }, [companyId, type, search, page]);
  useEffect(() => { load(); }, [load, refreshKey]);
  useEffect(() => { setPage(1); }, [type, search, companyId]);

  const cancel = async (v) => {
    const reason = window.prompt(`Cancel ${v.voucher_no}? It stays in the books with its number and a reversing entry is posted.\n\nReason:`, '');
    if (reason === null) return;
    try {
      await api.post(`/accounting-books/vouchers/${v.id}/cancel`, null, { params: { reason } });
      toast.success(`${v.voucher_no} cancelled`);
      onChanged?.();
      load();
    } catch (e) {
      toast.error(errText(e, 'Could not cancel the voucher.'));
    }
  };

  return (
    <ReportCard title="Vouchers" isDark={isDark}>
      <div className="flex flex-wrap gap-2 mb-3">
        <select aria-label="Voucher type filter" value={type} onChange={(e) => setType(e.target.value)} className={field(isDark)}>
          <option value="">All types</option>
          {Object.entries(VOUCHER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input aria-label="Search vouchers" placeholder="Search number, narration or reference" value={search} onChange={(e) => setSearch(e.target.value)} className={`${field(isDark)} flex-1 min-w-[12rem]`} />
      </div>
      {loading ? <ContentLoader /> : !data?.vouchers?.length ? <EmptyState text="No vouchers match." /> : (
        <>
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${isDark ? '!bg-transparent [&_th]:!bg-slate-800 [&_th]:!text-slate-400 [&_td]:!bg-transparent [&_td]:!text-slate-200' : ''}`}>
              <thead><tr className={`text-left text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <th className="py-2 pr-3 font-semibold">Voucher no.</th><th className="py-2 pr-3 font-semibold">Date</th><th className="py-2 pr-3 font-semibold">Type</th>
                <th className="py-2 pr-3 font-semibold">Narration</th><th className="py-2 pr-3 text-right font-semibold">Amount</th><th className="py-2 w-10"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody className={isDark ? 'text-slate-200' : 'text-slate-800'}>
                {data.vouchers.map((v) => (
                  <tr key={v.id} className={`border-t ${isDark ? 'border-slate-700' : 'border-slate-200'} ${v.reversed ? 'opacity-50' : ''}`}>
                    <td className="py-2 pr-3 font-mono text-xs whitespace-nowrap">{v.voucher_no}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">{v.entry_date}</td>
                    <td className="py-2 pr-3">{VOUCHER_LABELS[v.voucher_type] || v.voucher_type}</td>
                    <td className="py-2 pr-3 max-w-[22rem] truncate" title={v.narration}>{v.narration}{v.reversed && <span className="ml-2 text-xs text-red-500">cancelled</span>}</td>
                    <td className="py-2 pr-3 text-right font-mono">{fmtC(v.total_debit)}</td>
                    <td className="py-2 text-right">
                      {String(v.source || '').startsWith('voucher_') && !v.reversed && (
                        <button aria-label={`Cancel ${v.voucher_no}`} title="Cancel voucher" onClick={() => cancel(v)} className="h-8 w-8 rounded-lg text-slate-400 hover:text-red-600"><Ban className="h-4 w-4 mx-auto" /></button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between pt-3 text-xs">
            <span className={labelCls(isDark)}>{data.total} voucher{data.total === 1 ? '' : 's'}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
              <span>Page {data.page} of {data.total_pages}</span>
              <Button variant="outline" size="sm" className="h-8" disabled={page >= data.total_pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </>
      )}
    </ReportCard>
  );
}

function VouchersTab({ companyId, accounts, isDark }) {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div className="space-y-4">
      <VoucherForm companyId={companyId} accounts={accounts} isDark={isDark} onSaved={() => setRefreshKey((k) => k + 1)} />
      <VoucherList companyId={companyId} isDark={isDark} refreshKey={refreshKey} onChanged={() => setRefreshKey((k) => k + 1)} />
    </div>
  );
}

/* ═══ Period-end ═════════════════════════════════════════════════════════ */
function PeriodEndTab({ companyId, accounts, isDark }) {
  const [kinds, setKinds] = useState([]);
  const [kind, setKind] = useState('prepaid_expense');
  const [asOf, setAsOf] = useState(todayIso());
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [target, setTarget] = useState('');
  const [narration, setNarration] = useState('');
  const [again, setAgain] = useState(false);
  const [saving, setSaving] = useState(false);
  const [list, setList] = useState(null);

  const spec = kinds.find((k) => k.kind === kind);
  const choices = useMemo(() => accounts.filter((a) => a.is_active !== false && !a.is_group && a.type === spec?.account_type), [accounts, spec]);

  const load = useCallback(async () => {
    if (!companyId) return;
    try {
      const { data } = await api.get('/accounting-books/period-end/adjustments', { params: { company_id: companyId } });
      setList(data);
    } catch (e) { toast.error(errText(e, 'Could not load adjustments.')); }
  }, [companyId]);
  useEffect(() => { api.get('/accounting-books/period-end/kinds').then((r) => setKinds(r.data || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setAccountId(''); }, [kind]);

  const save = async () => {
    setSaving(true);
    try {
      const body = { company_id: companyId, kind, as_of: asOf, narration, allow_duplicate: again };
      if (kind === 'provision_doubtful_debts') body.target_balance = Number(target);
      else Object.assign(body, { amount: Number(amount), account_id: accountId });
      const { data } = await api.post('/accounting-books/period-end/adjustments', body);
      if (data.posted) toast.success(`Posted as ${data.voucher_no}`, { description: data.warning || undefined });
      else toast.info(data.message || 'Nothing to post.');
      setAmount(''); setTarget(''); setNarration(''); setAgain(false);
      load();
    } catch (e) {
      toast.error(errText(e, 'Could not post the adjustment.'));
    } finally { setSaving(false); }
  };
  const cancel = async (a) => {
    if (!window.confirm('Cancel this adjustment? Its reversing entry (if posted) is undone too.')) return;
    try { await api.post(`/accounting-books/period-end/adjustments/${a.id}/cancel`); toast.success('Adjustment cancelled'); load(); }
    catch (e) { toast.error(errText(e, 'Could not cancel.')); }
  };
  const ready = companyId && asOf && (kind === 'provision_doubtful_debts' ? target !== '' : accountId && Number(amount) > 0);

  return (
    <div className="space-y-4">
      <ReportCard title="Period-end adjustment" isDark={isDark}>
        <p className={`text-xs mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          Accruals and prepayments are reversed automatically on the next day, so next period's bill or payment does not double count.
          A provision stays until you set a new balance.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Labeled label="Adjustment" isDark={isDark} className="md:col-span-2">
            <select aria-label="Adjustment" value={kind} onChange={(e) => setKind(e.target.value)} className={field(isDark)}>
              {kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </Labeled>
          <Labeled label="As of" isDark={isDark}><input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field(isDark)} /></Labeled>
          {kind === 'provision_doubtful_debts' ? (
            <Labeled label="Provision should stand at (₹)" isDark={isDark}><input type="number" min="0" step="0.01" value={target} onChange={(e) => setTarget(e.target.value)} className={`${field(isDark)} font-mono`} /></Labeled>
          ) : (
            <>
              <Labeled label={spec?.account_type === 'income' ? 'Income account' : 'Expense account'} isDark={isDark} className="md:col-span-2">
                <AccountSelect accounts={choices} value={accountId} onChange={setAccountId} isDark={isDark} ariaLabel="Account adjusted" />
              </Labeled>
              <Labeled label="Amount (₹)" isDark={isDark}><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${field(isDark)} font-mono`} /></Labeled>
            </>
          )}
          <Labeled label="Narration" isDark={isDark} className="md:col-span-3"><input value={narration} onChange={(e) => setNarration(e.target.value)} className={field(isDark)} /></Labeled>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <label className="inline-flex items-center gap-2 text-xs"><input type="checkbox" checked={again} onChange={(e) => setAgain(e.target.checked)} />Record again even if an identical one exists</label>
          <Button onClick={save} disabled={!ready || saving} className="h-9">{saving ? 'Posting…' : 'Post adjustment'}</Button>
        </div>
      </ReportCard>

      <ReportCard title="Adjustments posted" isDark={isDark}>
        {!list ? <ContentLoader /> : !list.length ? <EmptyState text="No period-end adjustments yet." /> : (
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${isDark ? '!bg-transparent [&_th]:!bg-slate-800 [&_th]:!text-slate-400 [&_td]:!bg-transparent [&_td]:!text-slate-200' : ''}`}>
              <thead><tr className={`text-left text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <th className="py-2 pr-3 font-semibold">As of</th><th className="py-2 pr-3 font-semibold">Adjustment</th><th className="py-2 pr-3 font-semibold">Account</th>
                <th className="py-2 pr-3 text-right font-semibold">Amount</th><th className="py-2 pr-3 font-semibold">Status</th><th className="py-2 w-10"><span className="sr-only">Actions</span></th>
              </tr></thead>
              <tbody className={isDark ? 'text-slate-200' : 'text-slate-800'}>
                {list.map((a) => (
                  <tr key={a.id} className={`border-t ${isDark ? 'border-slate-700' : 'border-slate-200'} ${a.status === 'cancelled' ? 'opacity-50' : ''}`}>
                    <td className="py-2 pr-3 whitespace-nowrap">{a.as_of}</td>
                    <td className="py-2 pr-3">{kinds.find((k) => k.kind === a.kind)?.label || a.kind}</td>
                    <td className="py-2 pr-3">{a.account_name || '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono">{fmtC(a.amount)}</td>
                    <td className="py-2 pr-3 text-xs">{a.status === 'cancelled' ? 'Cancelled' : a.reversal_pending ? 'Reversal pending' : a.auto_reverse ? 'Reverses next day' : 'Active'}</td>
                    <td className="py-2 text-right">{a.status !== 'cancelled' && <button aria-label="Cancel adjustment" onClick={() => cancel(a)} className="h-8 w-8 rounded-lg text-slate-400 hover:text-red-600"><Ban className="h-4 w-4 mx-auto" /></button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ReportCard>
    </div>
  );
}

/* ═══ Year-end ═══════════════════════════════════════════════════════════ */
const SEV = {
  blocker: { icon: AlertTriangle, cls: 'text-red-600', word: 'Must fix' },
  warning: { icon: AlertTriangle, cls: 'text-amber-600', word: 'Check' },
  info: { icon: Info, cls: 'text-blue-600', word: 'Note' },
};

function YearEndTab({ companyId, isDark, isAdmin }) {
  const years = useMemo(() => fyOptions(), []);
  const [fy, setFy] = useState(years[1] || years[0]);
  const [check, setCheck] = useState(null);
  const [closings, setClosings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [force, setForce] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const [c, l] = await Promise.all([
        api.get('/accounting-books/year-end/checklist', { params: { company_id: companyId, fy } }),
        api.get('/accounting-books/year-end/closings', { params: { company_id: companyId } }),
      ]);
      setCheck(c.data); setClosings(l.data || []);
    } catch (e) { toast.error(errText(e, 'Could not run the checklist.')); } finally { setBusy(false); }
  }, [companyId, fy]);
  useEffect(() => { load(); }, [load]);

  const close = async () => {
    if (!window.confirm(`Close ${fy}? The books will be locked through 31 March ${fy.slice(0, 4) * 1 + 1}. An administrator can reopen the year.`)) return;
    setBusy(true);
    try {
      const { data } = await api.post('/accounting-books/year-end/close', { company_id: companyId, fy, force });
      toast.success(`${fy} closed`, { description: `Locked through ${data.locked_through}. Profit after tax ${fmtC(data.net_profit_after_tax)}.` });
      setForce(false); await load();
    } catch (e) { toast.error(errText(e, 'Could not close the year.')); await load(); } finally { setBusy(false); }
  };
  const reopen = async () => {
    setBusy(true);
    try {
      await api.post('/accounting-books/year-end/reopen', { company_id: companyId, fy, reason });
      toast.success(`${fy} reopened`); setReason(''); await load();
    } catch (e) { toast.error(errText(e, 'Could not reopen the year.')); } finally { setBusy(false); }
  };

  const items = sortChecklist(check?.items);
  return (
    <div className="space-y-4">
      <ReportCard title="Close a financial year" isDark={isDark}>
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <Labeled label="Financial year" isDark={isDark}>
            <select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)} className={field(isDark)}>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select>
          </Labeled>
          {check?.closed && <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-emerald-600"><Lock className="h-4 w-4" />Closed</span>}
        </div>
        {busy && !check ? <ContentLoader /> : (
          <ul className="space-y-2" aria-label="Year-end checklist">
            {items.length === 0 && <li className="flex items-center gap-2 text-sm text-emerald-600"><CheckCircle2 className="h-4 w-4" />Nothing is outstanding for {fy}.</li>}
            {items.map((i) => {
              const s = SEV[i.severity] || SEV.info; const Icon = s.icon;
              return (
                <li key={i.code} className={`flex gap-3 rounded-xl border p-3 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <Icon className={`h-4 w-4 mt-0.5 shrink-0 ${s.cls}`} />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">{i.title} <span className={`ml-1 text-[11px] font-medium ${s.cls}`}>{s.word}</span></p>
                    <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{i.detail}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {isAdmin && !check?.closed && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className="inline-flex items-center gap-2 text-xs"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />Close even though checks remain open (must-fix items still stop it)</label>
            <Button onClick={close} disabled={busy || !check || check.blockers > 0 || (check.warnings > 0 && !force)} className="h-9"><Lock className="h-4 w-4 mr-1.5" />Close {fy}</Button>
          </div>
        )}
        {isAdmin && check?.closed && (
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <Labeled label="Reason for reopening" isDark={isDark} className="flex-1 min-w-[14rem]"><input value={reason} onChange={(e) => setReason(e.target.value)} className={field(isDark)} /></Labeled>
            <Button variant="outline" onClick={reopen} disabled={busy || reason.trim().length < 5} className="h-9"><Unlock className="h-4 w-4 mr-1.5" />Reopen {fy}</Button>
          </div>
        )}
        {!isAdmin && <p className={`mt-4 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Only an administrator can close or reopen a year.</p>}
      </ReportCard>

      <ReportCard title="Closed years" isDark={isDark}>
        {!closings.length ? <EmptyState text="No year has been closed yet." /> : closings.map((c) => (
          <div key={c.id} className={`py-3 border-t first:border-0 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
            <p className="text-sm font-semibold">{c.fy} <span className="text-xs font-normal text-slate-500">· {c.status}{c.forced ? ' · closed with open checks' : ''}</span></p>
            <Row label="Revenue" value={c.revenue} isDark={isDark} /><Row label="Profit after tax" value={c.net_profit_after_tax} isDark={isDark} bold />
          </div>
        ))}
      </ReportCard>
    </div>
  );
}

/* ═══ Groups ═════════════════════════════════════════════════════════════ */
function GroupNode({ node, depth, isDark }) {
  const [open, setOpen] = useState(depth === 0);
  const hasMore = node.children.length > 0 || node.accounts.length > 0;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!hasMore}
        className={`w-full flex items-center justify-between gap-3 py-1.5 text-left rounded-lg ${isDark ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50'}`} style={{ paddingLeft: depth * 18 }}>
        <span className={`flex items-center gap-1.5 text-sm ${depth === 0 ? 'font-bold' : 'font-medium'}`}>
          {hasMore ? (open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : <span className="w-3.5" />}{node.group}
        </span>
        <span className="flex gap-6 font-mono text-sm shrink-0"><span className="w-28 text-right">{node.debit ? fmtC(node.debit) : ''}</span><span className="w-28 text-right">{node.credit ? fmtC(node.credit) : ''}</span></span>
      </button>
      {open && (
        <>
          {node.accounts.map((a) => (
            <div key={a.account_id} className="flex items-center justify-between gap-3 py-1 text-xs" style={{ paddingLeft: depth * 18 + 30 }}>
              <span className={isDark ? 'text-slate-300' : 'text-slate-600'}>{a.code} {a.name}</span>
              <span className="flex gap-6 font-mono shrink-0"><span className="w-28 text-right">{a.debit ? fmtC(a.debit) : ''}</span><span className="w-28 text-right">{a.credit ? fmtC(a.credit) : ''}</span></span>
            </div>
          ))}
          {node.children.map((c) => <GroupNode key={c.group} node={c} depth={depth + 1} isDark={isDark} />)}
        </>
      )}
    </div>
  );
}

function GroupsTab({ companyId, isDark }) {
  const [dateTo, setDateTo] = useState(todayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try { setData((await api.get('/accounting-books/groups/trial-balance', { params: { company_id: companyId, date_to: dateTo } })).data); }
    catch (e) { toast.error(errText(e, 'Could not load the trial balance.')); } finally { setLoading(false); }
  }, [companyId, dateTo]);
  useEffect(() => { load(); }, [load]);
  return (
    <ReportCard title="Trial balance by group" isDark={isDark}>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <Labeled label="As at" isDark={isDark}><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={field(isDark)} /></Labeled>
        {data && <span className={`text-xs ${data.balanced ? 'text-emerald-600' : 'text-red-600'}`} role="status">{data.balanced ? 'Debits equal credits.' : 'Debits and credits differ.'} Income and expenses run from {data.date_from}.</span>}
      </div>
      {loading && !data ? <ContentLoader /> : !data?.groups?.length ? <EmptyState text="Nothing is posted yet." /> : (
        <div>
          <div className={`flex justify-end gap-6 pb-1 text-xs font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}><span className="w-28 text-right">Debit</span><span className="w-28 text-right">Credit</span></div>
          {data.groups.map((g) => <GroupNode key={g.group} node={g} depth={0} isDark={isDark} />)}
          <div className={`mt-2 pt-2 border-t flex items-center justify-between font-bold text-sm ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
            <span>Total</span><span className="flex gap-6 font-mono"><span className="w-28 text-right">{fmtC(data.total_debit)}</span><span className="w-28 text-right">{fmtC(data.total_credit)}</span></span>
          </div>
        </div>
      )}
    </ReportCard>
  );
}

/* ═══ Settings ═══════════════════════════════════════════════════════════ */
function SettingsTab({ companyId, isDark, isAdmin }) {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!companyId) return;
    api.get('/accounting-books/settings', { params: { company_id: companyId } }).then((r) => setS(r.data)).catch((e) => toast.error(errText(e, 'Could not load settings.')));
  }, [companyId]);
  if (!s) return <ContentLoader />;
  const save = async () => {
    setSaving(true);
    try {
      const { data } = await api.put('/accounting-books/settings', { company_id: companyId, framework: s.framework, inventory_method: s.inventory_method, tax_rate_pct: Number(s.tax_rate_pct), capitalisation_threshold: Number(s.capitalisation_threshold) });
      setS(data); toast.success('Settings saved');
    } catch (e) { toast.error(errText(e, 'Could not save settings.')); } finally { setSaving(false); }
  };
  return (
    <ReportCard title="Accounting settings" isDark={isDark}>
      <fieldset disabled={!isAdmin} className="space-y-5">
        <div>
          <legend className="text-sm font-semibold mb-2">Standards this company follows</legend>
          <div className="grid gap-3 md:grid-cols-2">
            {Object.entries(FRAMEWORK_INFO).map(([key, info]) => (
              <label key={key} className={`flex gap-3 rounded-xl border p-3 cursor-pointer ${s.framework === key ? 'border-blue-600 ring-1 ring-blue-600' : isDark ? 'border-slate-700' : 'border-slate-300'}`}>
                <input type="radio" name="framework" checked={s.framework === key} onChange={() => setS({ ...s, framework: key })} className="mt-1" />
                <span><span className="block text-sm font-semibold">{info.label}</span><span className={`block text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{info.blurb}</span></span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <Labeled label="Stock valuation" isDark={isDark}>
            <select aria-label="Stock valuation" value={s.inventory_method} onChange={(e) => setS({ ...s, inventory_method: e.target.value })} className={field(isDark)}>
              <option value="WEIGHTED_AVG">Weighted average cost</option><option value="FIFO">First in, first out (FIFO)</option>
            </select>
          </Labeled>
          <Labeled label="Income tax rate (%)" isDark={isDark}><input type="number" min="0" max="60" step="0.01" value={s.tax_rate_pct} onChange={(e) => setS({ ...s, tax_rate_pct: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
          <Labeled label="Capitalise purchases from (₹)" isDark={isDark}><input type="number" min="0" step="1" value={s.capitalisation_threshold} onChange={(e) => setS({ ...s, capitalisation_threshold: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
        </div>
      </fieldset>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{isAdmin ? 'Changing the standard affects the notes and measurement rules added to reports from now on. Posted entries are not changed.' : 'Only an administrator can change these.'}</span>
        {isAdmin && <Button onClick={save} disabled={saving} className="h-9">{saving ? 'Saving…' : 'Save settings'}</Button>}
      </div>
    </ReportCard>
  );
}

/* ═══ Page ═══════════════════════════════════════════════════════════════ */
function AccountingBooksInner() {
  const isDark = useDark();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const [tab, setTab] = useState('vouchers');
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const list = normalizeCompanies(await api.get('/companies/list'));
        setCompanies(list);
        let initial = list[0]?.id || '';
        try { const stored = localStorage.getItem('accountingBooks:companyId'); if (stored && list.some((c) => c.id === stored)) initial = stored; } catch { /* storage unavailable */ }
        setCompanyId(initial);
      } catch { toast.error('Could not load companies.'); }
    })();
  }, []);

  useEffect(() => {
    if (!companyId) { setAccounts([]); return; }
    try { localStorage.setItem('accountingBooks:companyId', companyId); } catch { /* storage unavailable */ }
    api.get('/chart-of-accounts', { params: { company_id: companyId } }).then((r) => setAccounts(Array.isArray(r.data) ? r.data : [])).catch(() => setAccounts([]));
  }, [companyId]);

  return (
    <div className={`min-h-screen ${isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900'}`}>
      <div className="p-4 md:p-6 space-y-5 max-w-[1200px] mx-auto">
        <PageHeader icon={BookMarked} title="Books & Vouchers" isDark={isDark}
          subtitle="Vouchers, period-end adjustments, year-end closing, inventory, accounting standards (AS and Ind AS) and notes to accounts."
          extra={(
            <select aria-label="Company" value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="h-9 rounded-lg px-3 text-sm bg-white/15 border border-white/30 text-white">
              {companies.map((c) => <option key={c.id} value={c.id} className="text-slate-900">{c.name || c.company_name || c.id}</option>)}
            </select>
          )} />
        <nav className="flex flex-wrap gap-2" aria-label="Sections">
          {TABS.map(([key, label]) => (
            <button key={key} onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}
              className={`h-9 px-4 rounded-xl text-sm font-semibold border ${tab === key ? 'bg-blue-600 border-blue-600 text-white' : isDark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-300 text-slate-600 hover:bg-white'}`}>{label}</button>
          ))}
        </nav>
        {!companyId ? <EmptyState text="Choose a company to begin." /> : (
          <>
            {tab === 'vouchers' && <VouchersTab companyId={companyId} accounts={accounts} isDark={isDark} />}
            {tab === 'period-end' && <PeriodEndTab companyId={companyId} accounts={accounts} isDark={isDark} />}
            {tab === 'year-end' && <YearEndTab companyId={companyId} isDark={isDark} isAdmin={isAdmin} />}
            {tab === 'groups' && <GroupsTab companyId={companyId} isDark={isDark} />}
            {tab === 'inventory' && <InventoryTab companyId={companyId} isDark={isDark} />}
            {tab === 'standards' && <StandardsTab companyId={companyId} accounts={accounts} isDark={isDark} isAdmin={isAdmin} />}
            {tab === 'notes' && <NotesTab companyId={companyId} isDark={isDark} isAdmin={isAdmin} />}
            {tab === 'settings' && <SettingsTab companyId={companyId} isDark={isDark} isAdmin={isAdmin} />}
          </>
        )}
      </div>
    </div>
  );
}

export default function AccountingBooks() {
  return (
    <RequestAccessGate module="accounting_reports" moduleLabel="Books & Vouchers" permissionFlag="can_view_accounting_reports">
      <AccountingBooksInner />
    </RequestAccessGate>
  );
}
