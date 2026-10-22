import React, { useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { fmtC, fmtN } from '@/components/reports/ReportShared.jsx';
import { fyOptions, isCashBank, todayIso } from '@/lib/books';
import { PROVISION_TREATMENT, RELATIONSHIPS, distinctCurrencies, fxSummary } from '@/lib/standards';
import {
  DataTable, ErrorNote, FormGrid, GhostButton, Labeled, Loading, Pill, PrimaryButton, Section, Stat, clean, field, mutedCls, runAction, useLoad,
} from './ui.jsx';

const SP = '/accounting-books/standards';
const get = (path, params) => api.get(`${SP}${path}`, { params }).then((r) => r.data);

function Lede({ standard, children, isDark }) {
  return (
    <p className={`text-sm ${mutedCls(isDark)}`}>
      <strong className={isDark ? 'text-slate-200' : 'text-slate-700'}>{standard}.</strong> {children}
    </p>
  );
}

/* ═══ Receivables ═══════════════════════════════════════════════════════ */
export function ReceivablesPanel({ companyId, isDark, isAdmin }) {
  const [asOf, setAsOf] = useState(todayIso());
  const { data: d, loading, error, reload } = useLoad(() => get('/receivables/provision', { company_id: companyId, as_of: asOf }), [companyId, asOf]);
  const [rates, setRates] = useState(null);
  const [busy, setBusy] = useState(false);
  const shown = rates || d?.matrix?.rates || [];

  const post = async () => {
    const r = await runAction(setBusy, () => api.post(`${SP}/receivables/provision/post`, { company_id: companyId, as_of: asOf }).then((x) => x.data));
    if (r) { toast.success(r.message || `Provision set to ${fmtC(r.provision_required)}`); reload(); }
  };
  const saveMatrix = async () => {
    const ok = await runAction(setBusy, () => api.put(`${SP}/receivables/matrix`, { company_id: companyId, rates: shown.map(Number), forward_looking_pct: Number(d.matrix.forward_looking_pct) || 0 }), 'Provision rates saved');
    if (ok) { setRates(null); reload(); }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorNote error={error} isDark={isDark} />;
  return (
    <div className="space-y-4">
      <Lede standard={d.standard} isDark={isDark}>{d.basis}</Lede>
      <div className="flex items-center gap-3"><Labeled label="As of" isDark={isDark}><input aria-label="Provision as of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field(isDark)} /></Labeled></div>
      <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
        <Stat label="Outstanding" value={fmtC(d.total_outstanding)} hint={`${d.invoice_count} invoices`} isDark={isDark} />
        <Stat label="Provision required" value={fmtC(d.provision_required)} isDark={isDark} />
        <Stat label="Provision in books" value={fmtC(d.current_provision)} isDark={isDark} />
        <Stat label="Change needed" value={fmtC(d.change_needed)} tone={Math.abs(d.change_needed) >= 1 ? 'bad' : 'good'} isDark={isDark} />
      </div>
      <Section title="Ageing and provision" isDark={isDark}
        action={<PrimaryButton onClick={post} disabled={busy || Math.abs(d.change_needed) < 0.01}>{busy ? 'Posting…' : `Set provision to ${fmtC(d.provision_required)}`}</PrimaryButton>}>
        <DataTable isDark={isDark} rowKey="bucket" rows={d.rows}
          columns={[{ key: 'bucket', label: 'Days past due' }, { key: 'outstanding', label: 'Outstanding', align: 'right', mono: true, render: (r) => fmtC(r.outstanding) },
            { key: 'rate_pct', label: 'Rate', align: 'right', render: (r) => `${r.rate_pct}%` }, { key: 'provision', label: 'Provision', align: 'right', mono: true, render: (r) => fmtC(r.provision) }]} />
      </Section>
      {isAdmin && (
        <Section title="Provision rates" isDark={isDark}>
          <div className="grid gap-3 grid-cols-2 md:grid-cols-6">
            {d.rows.map((r, i) => (
              <Labeled key={r.bucket} label={`${r.bucket} (%)`} isDark={isDark}>
                <input aria-label={`Rate for ${r.bucket}`} type="number" min="0" max="100" step="0.1" value={shown[i] ?? ''} onChange={(e) => setRates(shown.map((x, j) => (j === i ? e.target.value : x)))} className={`${field(isDark)} font-mono`} />
              </Labeled>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className={`text-xs ${mutedCls(isDark)}`}>{d.matrix.is_default ? 'Using the default rates for this standard.' : 'Using your own rates.'}</span>
            <GhostButton isDark={isDark} onClick={saveMatrix} disabled={busy || !rates}>Save rates</GhostButton>
          </div>
        </Section>
      )}
    </div>
  );
}

/* ═══ Provisions and contingencies ══════════════════════════════════════ */
const CATEGORY_OPTIONS = [['litigation', 'Litigation'], ['warranty', 'Warranty'], ['onerous_contract', 'Onerous contract'], ['restructuring', 'Restructuring'], ['tax_dispute', 'Tax dispute'], ['guarantee', 'Guarantee'], ['other', 'Other']].map(([value, label]) => ({ value, label }));
const PROB_OPTIONS = [{ value: 'probable', label: 'Probable (more likely than not)' }, { value: 'possible', label: 'Possible' }, { value: 'remote', label: 'Remote' }];

function ProvisionRow({ p, companyId, accounts, isDark, onDone }) {
  const [mode, setMode] = useState(null);
  const [f, setF] = useState({ as_of: todayIso(), date: todayIso(), probability: p.probability, amount: p.amount });
  const [busy, setBusy] = useState(false);
  const payFrom = useMemo(() => accounts.filter((a) => a.is_active !== false && !a.is_group && (isCashBank(a) || a.type === 'liability')), [accounts]);
  const t = PROVISION_TREATMENT[p.treatment];

  const reassess = async () => {
    const ok = await runAction(setBusy, () => api.put(`${SP}/provisions/${p.id}/reassess`, { company_id: companyId, as_of: f.as_of, probability: f.probability, amount: Number(f.amount) }), 'Reassessed');
    if (ok) { setMode(null); onDone(); }
  };
  const settle = async () => {
    const ok = await runAction(setBusy, () => api.post(`${SP}/provisions/${p.id}/settle`, { company_id: companyId, date: f.date, amount: Number(f.settle_amount), account_id: f.account_id }), 'Settlement posted');
    if (ok) { setMode(null); onDone(); }
  };
  return (
    <>
      <tr className={`border-t align-top ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
        <td className="py-2 pr-3"><div className="font-medium">{p.description}</div><div className={`text-xs ${mutedCls(isDark)}`}>{p.category.replace('_', ' ')} · as of {p.as_of}</div></td>
        <td className="py-2 pr-3 capitalize">{p.probability}</td>
        <td className="py-2 pr-3 text-right font-mono">{fmtC(p.amount)}</td>
        <td className="py-2 pr-3 text-right font-mono">{fmtC(p.recognised)}</td>
        <td className="py-2 pr-3"><Pill tone={t.tone}>{t.label}</Pill></td>
        <td className="py-2 text-right whitespace-nowrap">
          <GhostButton isDark={isDark} onClick={() => setMode(mode === 'reassess' ? null : 'reassess')}>Reassess</GhostButton>{' '}
          {p.recognised > 0 && <GhostButton isDark={isDark} onClick={() => setMode(mode === 'settle' ? null : 'settle')}>Settle</GhostButton>}
        </td>
      </tr>
      {mode && (
        <tr><td colSpan={6} className="pb-3">
          {mode === 'reassess' ? (
            <div className="grid gap-3 md:grid-cols-4 items-end">
              <Labeled label="As of" isDark={isDark}><input type="date" aria-label="Reassess as of" value={f.as_of} onChange={(e) => setF({ ...f, as_of: e.target.value })} className={field(isDark)} /></Labeled>
              <Labeled label="Likelihood" isDark={isDark}><select aria-label="Likelihood" value={f.probability} onChange={(e) => setF({ ...f, probability: e.target.value })} className={field(isDark)}>{PROB_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Labeled>
              <Labeled label="Best estimate (₹)" isDark={isDark}><input type="number" aria-label="Best estimate" min="0" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
              <PrimaryButton onClick={reassess} disabled={busy}>Apply</PrimaryButton>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-4 items-end">
              <Labeled label="Date" isDark={isDark}><input type="date" aria-label="Settlement date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} className={field(isDark)} /></Labeled>
              <Labeled label="Paid from or owed to" isDark={isDark}><select aria-label="Settlement account" value={f.account_id || ''} onChange={(e) => setF({ ...f, account_id: e.target.value })} className={field(isDark)}><option value="">Choose an account</option>{payFrom.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Labeled>
              <Labeled label={`Amount (up to ${fmtC(p.recognised)})`} isDark={isDark}><input type="number" aria-label="Settlement amount" min="0" value={f.settle_amount || ''} onChange={(e) => setF({ ...f, settle_amount: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
              <PrimaryButton onClick={settle} disabled={busy || !f.account_id || !(Number(f.settle_amount) > 0)}>Post settlement</PrimaryButton>
            </div>
          )}
        </td></tr>
      )}
    </>
  );
}

export function ProvisionsPanel({ companyId, isDark, accounts, framework, standards }) {
  const list = useLoad(() => get('/provisions', { company_id: companyId }), [companyId]);
  const [fy, setFy] = useState(fyOptions()[0]);
  const disc = useLoad(() => get('/provisions/disclosure', { company_id: companyId, fy }), [companyId, fy]);
  const [form, setForm] = useState({ category: 'litigation', probability: 'probable', estimable: true, as_of: todayIso() });
  const [busy, setBusy] = useState(false);
  const reloadAll = () => { list.reload(); disc.reload(); };

  const fields = [
    { key: 'description', label: 'What is the obligation?', span: 2 }, { key: 'category', label: 'Class', type: 'select', options: CATEGORY_OPTIONS },
    { key: 'probability', label: 'Likelihood of an outflow', type: 'select', options: PROB_OPTIONS }, { key: 'amount', label: 'Best estimate (₹)', type: 'number', min: 0, step: '0.01' },
    { key: 'as_of', label: 'As of', type: 'date' },
    { key: 'discount_rate_pct', label: 'Discount rate (%)', type: 'number', min: 0, step: '0.1', show: () => framework === 'IND_AS', hint: 'Ind AS 37 discounts a long-dated provision to present value.' },
    { key: 'expected_years', label: 'Years until settlement', type: 'number', min: 0, step: '0.5', show: () => framework === 'IND_AS' },
    { key: 'basis', label: 'Basis of the estimate', span: 2 },
    { key: 'estimable', label: 'The amount can be estimated reliably', type: 'checkbox' },
    { key: 'is_contingent_asset', label: 'This is a possible inflow (contingent asset)', type: 'checkbox' },
  ];
  const add = async () => {
    if (!form.description?.trim() || !(Number(form.amount) >= 0) || form.amount === undefined) { toast.error('Describe the obligation and enter the best estimate.'); return; }
    const r = await runAction(setBusy, () => api.post(`${SP}/provisions`, { company_id: companyId, ...clean(form, ['amount', 'discount_rate_pct', 'expected_years']), estimable: !!form.estimable, is_contingent_asset: !!form.is_contingent_asset }).then((x) => x.data),
      (x) => (x.treatment === 'recognise' ? `Provision of ${fmtC(x.recognised)} booked` : x.treatment === 'disclose' ? 'Recorded for disclosure; nothing is booked' : 'Recorded; remote, so not disclosed'));
    if (r) { setForm({ ...form, description: '', amount: '', basis: '' }); reloadAll(); }
  };

  return (
    <div className="space-y-4">
      <Lede standard={standards?.provisions || 'AS 29 / Ind AS 37'} isDark={isDark}>A provision is booked when an outflow is probable and can be measured. A possible outflow is disclosed as a contingent liability and not booked.</Lede>
      <Section title="Record an obligation" isDark={isDark}>
        <FormGrid fields={fields} values={form} onChange={setForm} isDark={isDark} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={add} disabled={busy}>{busy ? 'Saving…' : 'Record'}</PrimaryButton></div>
      </Section>
      <Section title="Register" isDark={isDark}>
        {list.loading ? <Loading /> : list.error ? <ErrorNote error={list.error} isDark={isDark} /> : !list.data.length ? <p className={`text-sm py-6 text-center ${mutedCls(isDark)}`}>No obligations recorded.</p> : (
          <div className="overflow-x-auto">
            <table className={`w-full text-sm ${isDark ? '!bg-transparent [&_th]:!bg-slate-800 [&_th]:!text-slate-400 [&_td]:!bg-transparent [&_td]:!text-slate-200' : ''}`}>
              <thead><tr className={`text-left text-xs ${mutedCls(isDark)}`}><th className="py-2 pr-3">Obligation</th><th className="py-2 pr-3">Likelihood</th><th className="py-2 pr-3 text-right">Estimate</th><th className="py-2 pr-3 text-right">Booked</th><th className="py-2 pr-3">Treatment</th><th className="py-2"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{list.data.map((p) => <ProvisionRow key={p.id} p={p} companyId={companyId} accounts={accounts} isDark={isDark} onDone={reloadAll} />)}</tbody>
            </table>
          </div>
        )}
      </Section>
      <Section title="Note to accounts" isDark={isDark}
        action={<select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)} className={field(isDark)}>{fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
        {disc.loading ? <Loading /> : disc.error ? <ErrorNote error={disc.error} isDark={isDark} /> : (
          <div className="space-y-4">
            <DataTable isDark={isDark} rowKey="category" empty="No provisions in this year." rows={disc.data.provisions}
              columns={['category', 'opening', 'additions', 'utilised', 'reversed', 'closing'].map((k) => (k === 'category' ? { key: k, label: 'Class', render: (r) => r.category.replace('_', ' ') } : { key: k, label: k[0].toUpperCase() + k.slice(1), align: 'right', mono: true, render: (r) => fmtC(r[k]) }))} />
            {disc.data.contingent_liabilities.length > 0 && (
              <div><p className="text-sm font-semibold mb-1">Contingent liabilities</p>
                <DataTable isDark={isDark} rowKey="description" rows={disc.data.contingent_liabilities} columns={[{ key: 'description', label: 'Matter' }, { key: 'category', label: 'Class', render: (r) => r.category.replace('_', ' ') }, { key: 'estimate', label: 'Estimate', align: 'right', mono: true, render: (r) => (r.estimate === null ? 'Not estimable' : fmtC(r.estimate)) }]} /></div>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}

/* ═══ Foreign currency ══════════════════════════════════════════════════ */
const FX_KINDS = [['receivable', 'Receivable (we are owed)'], ['payable', 'Payable (we owe)'], ['bank', 'Foreign-currency bank balance'], ['loan_given', 'Loan given'], ['loan_taken', 'Loan taken']].map(([value, label]) => ({ value, label }));

export function FxPanel({ companyId, isDark, standards }) {
  const items = useLoad(() => get('/fx/items', { company_id: companyId, status: 'open' }), [companyId]);
  const runs = useLoad(() => get('/fx/revaluations', { company_id: companyId }), [companyId]);
  const [form, setForm] = useState({ kind: 'receivable', date: todayIso() });
  const [asOf, setAsOf] = useState(todayIso());
  const [rates, setRates] = useState({});
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const currencies = distinctCurrencies(items.data || []);

  const fields = [
    { key: 'kind', label: 'Item', type: 'select', options: FX_KINDS }, { key: 'party', label: 'Party' }, { key: 'currency', label: 'Currency (e.g. USD)' },
    { key: 'fc_amount', label: 'Amount in foreign currency', type: 'number', min: 0, step: '0.01' },
    { key: 'booked_rate', label: 'Rate when booked (₹ per unit)', type: 'number', min: 0, step: '0.0001' }, { key: 'date', label: 'Date booked', type: 'date' },
  ];
  const add = async () => {
    if (!form.currency || form.currency.length !== 3 || !(Number(form.fc_amount) > 0) || !(Number(form.booked_rate) > 0)) { toast.error('Enter a 3-letter currency, the amount and the booking rate.'); return; }
    const ok = await runAction(setBusy, () => api.post(`${SP}/fx/items`, { company_id: companyId, ...clean(form, ['fc_amount', 'booked_rate']) }), 'Item added');
    if (ok) { setForm({ ...form, party: '', fc_amount: '' }); items.reload(); }
  };
  const settle = async (it) => { if (await runAction(null, () => api.put(`${SP}/fx/items/${it.id}`, { company_id: companyId, status: 'settled' }), 'Marked as settled')) items.reload(); };
  const body = (dry) => ({ company_id: companyId, as_of: asOf, rates: Object.fromEntries(Object.entries(rates).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)])), dry_run: dry });
  const revalue = async (dry) => {
    const r = await runAction(setBusy, () => api.post(`${SP}/fx/revalue`, body(dry)).then((x) => x.data), dry ? null : (x) => (x.posted ? 'Revaluation posted' : x.message));
    if (!r) return;
    setPreview(r);
    if (!dry) runs.reload();
  };
  const cancel = async (run) => { if (await runAction(null, () => api.post(`${SP}/fx/revaluations/${run.id}/cancel`, null, { params: { company_id: companyId } }), 'Revaluation cancelled')) runs.reload(); };
  const sum = preview ? fxSummary(preview) : null;

  return (
    <div className="space-y-4">
      <Lede standard={standards?.fx || 'AS 11 / Ind AS 21'} isDark={isDark}>Foreign-currency receivables, payables, loans and bank balances are restated at the closing rate. The unrealised difference goes to the profit and loss account and reverses the next day; the real gain or loss is booked when the money is settled.</Lede>
      <Section title="Add a foreign-currency item" isDark={isDark}>
        <FormGrid fields={fields} values={form} onChange={setForm} isDark={isDark} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={add} disabled={busy}>Add item</PrimaryButton></div>
      </Section>
      <Section title="Open items" isDark={isDark}>
        {items.loading ? <Loading /> : <DataTable isDark={isDark} empty="No open foreign-currency items." rows={items.data}
          columns={[{ key: 'party', label: 'Party', render: (r) => r.party || '—' }, { key: 'kind', label: 'Item', render: (r) => FX_KINDS.find((k) => k.value === r.kind)?.label },
            { key: 'fc_amount', label: 'Amount', align: 'right', mono: true, render: (r) => `${fmtN(r.fc_amount)} ${r.currency}` }, { key: 'booked_rate', label: 'Booked at', align: 'right', mono: true, render: (r) => r.booked_rate },
            { key: 'date', label: 'Date' }, { key: 'act', label: '', align: 'right', render: (r) => <GhostButton isDark={isDark} onClick={() => settle(r)}>Mark settled</GhostButton> }]} />}
      </Section>
      <Section title="Revalue at the closing rate" isDark={isDark}>
        <div className="grid gap-3 md:grid-cols-4 items-end">
          <Labeled label="As of" isDark={isDark}><input type="date" aria-label="Revalue as of" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field(isDark)} /></Labeled>
          {currencies.map((c) => (
            <Labeled key={c} label={`Closing rate: ${c}`} isDark={isDark}><input type="number" aria-label={`Closing rate for ${c}`} min="0" step="0.0001" value={rates[c] || ''} onChange={(e) => setRates({ ...rates, [c]: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2 justify-end">
          <GhostButton isDark={isDark} onClick={() => revalue(true)} disabled={busy || !currencies.length}>Preview</GhostButton>
          <PrimaryButton onClick={() => revalue(false)} disabled={busy || !currencies.length}>Post revaluation</PrimaryButton>
        </div>
        {sum && (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 grid-cols-3"><Stat label="Assets" value={fmtC(sum.assets)} tone={sum.assets < 0 ? 'bad' : 'good'} isDark={isDark} /><Stat label="Liabilities" value={fmtC(sum.liabilities)} tone={sum.liabilities < 0 ? 'bad' : 'good'} isDark={isDark} /><Stat label={sum.net >= 0 ? 'Net gain' : 'Net loss'} value={fmtC(Math.abs(sum.net))} tone={sum.net < 0 ? 'bad' : 'good'} isDark={isDark} /></div>
            <DataTable isDark={isDark} rowKey="item_id" rows={preview.rows} columns={[{ key: 'party', label: 'Party' }, { key: 'fc_amount', label: 'Amount', align: 'right', render: (r) => `${fmtN(r.fc_amount)} ${r.currency}` }, { key: 'booked_inr', label: 'Booked ₹', align: 'right', mono: true, render: (r) => fmtC(r.booked_inr) }, { key: 'closing_inr', label: 'At closing ₹', align: 'right', mono: true, render: (r) => fmtC(r.closing_inr) }, { key: 'difference', label: 'Gain / (loss)', align: 'right', mono: true, render: (r) => fmtC(r.difference) }]} />
          </div>
        )}
      </Section>
      <Section title="Revaluations posted" isDark={isDark}>
        {runs.loading ? <Loading /> : <DataTable isDark={isDark} empty="None yet." rows={(runs.data || []).map((r) => ({ ...r, _muted: r.status === 'cancelled' }))}
          columns={[{ key: 'as_of', label: 'As of' }, { key: 'net_gain_loss', label: 'Net gain / (loss)', align: 'right', mono: true, render: (r) => fmtC(r.net_gain_loss) }, { key: 'status', label: 'Status', render: (r) => <Pill tone={r.status === 'active' ? 'good' : 'mute'}>{r.status === 'active' ? 'Posted' : 'Cancelled'}</Pill> },
            { key: 'act', label: '', align: 'right', render: (r) => (r.status === 'active' ? <GhostButton isDark={isDark} onClick={() => cancel(r)}>Cancel</GhostButton> : null) }]} />}
      </Section>
    </div>
  );
}

/* ═══ Related parties ═══════════════════════════════════════════════════ */
const NATURE_OPTIONS = [['sale', 'Sale of goods or services'], ['purchase', 'Purchase of goods or services'], ['loan_given', 'Loan given'], ['loan_taken', 'Loan taken'], ['interest_paid', 'Interest paid'], ['interest_received', 'Interest received'], ['rent_paid', 'Rent paid'], ['rent_received', 'Rent received'], ['remuneration', 'Remuneration'], ['reimbursement', 'Reimbursement of expenses'], ['guarantee', 'Guarantee'], ['dividend', 'Dividend'], ['other', 'Other']].map(([value, label]) => ({ value, label }));

export function RelatedPartiesPanel({ companyId, isDark, standards }) {
  const parties = useLoad(() => get('/related-parties', { company_id: companyId }), [companyId]);
  const [fy, setFy] = useState(fyOptions()[0]);
  const txns = useLoad(() => get('/related-parties/transactions', { company_id: companyId, fy }), [companyId, fy]);
  const disc = useLoad(() => get('/related-parties/disclosure', { company_id: companyId, fy }), [companyId, fy]);
  const [pf, setPf] = useState({ relationship: 'kmp' });
  const [tf, setTf] = useState({ nature: 'sale', date: todayIso() });
  const [busy, setBusy] = useState(false);
  const reloadAll = () => { parties.reload(); txns.reload(); disc.reload(); };

  const addParty = async () => {
    if (!pf.name?.trim()) { toast.error('Enter the name.'); return; }
    if (await runAction(setBusy, () => api.post(`${SP}/related-parties`, { company_id: companyId, ...clean(pf) }), 'Party added')) { setPf({ relationship: pf.relationship }); reloadAll(); }
  };
  const addTxn = async () => {
    if (!tf.party_id || !(Number(tf.amount) > 0)) { toast.error('Choose the party and enter the amount.'); return; }
    if (await runAction(setBusy, () => api.post(`${SP}/related-parties/transactions`, { company_id: companyId, ...clean(tf, ['amount', 'outstanding']) }), 'Transaction recorded')) { setTf({ ...tf, amount: '', outstanding: '', note: '' }); reloadAll(); }
  };
  const delTxn = async (t) => { if (await runAction(null, () => api.delete(`${SP}/related-parties/transactions/${t.id}`, { params: { company_id: companyId } }), 'Removed')) reloadAll(); };
  const delParty = async (p) => { if (await runAction(null, () => api.delete(`${SP}/related-parties/${p.id}`, { params: { company_id: companyId } }), 'Removed')) reloadAll(); };

  return (
    <div className="space-y-4">
      <Lede standard={standards?.related_parties || 'AS 18 / Ind AS 24'} isDark={isDark}>Keep a register of related parties and the transactions with each. The disclosure table below is what goes in the notes.</Lede>
      <Section title="Add a related party" isDark={isDark}>
        <FormGrid isDark={isDark} values={pf} onChange={setPf} fields={[{ key: 'name', label: 'Name', span: 2 }, { key: 'relationship', label: 'Relationship', type: 'select', options: Object.entries(RELATIONSHIPS).map(([value, label]) => ({ value, label })) }, { key: 'pan', label: 'PAN (optional)' }]} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={addParty} disabled={busy}>Add party</PrimaryButton></div>
        {parties.data?.length > 0 && <div className="mt-3"><DataTable isDark={isDark} rows={parties.data} columns={[{ key: 'name', label: 'Party' }, { key: 'relationship', label: 'Relationship', render: (r) => RELATIONSHIPS[r.relationship] }, { key: 'act', label: '', align: 'right', render: (r) => <button type="button" aria-label={`Remove ${r.name}`} onClick={() => delParty(r)} className="h-8 w-8 text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4 mx-auto" /></button> }]} /></div>}
      </Section>
      <Section title="Record a transaction" isDark={isDark}>
        <FormGrid isDark={isDark} values={tf} onChange={setTf} fields={[
          { key: 'party_id', label: 'Party', type: 'select', placeholder: 'Choose a party', options: (parties.data || []).map((p) => ({ value: p.id, label: p.name })) },
          { key: 'date', label: 'Date', type: 'date' }, { key: 'nature', label: 'Nature', type: 'select', options: NATURE_OPTIONS },
          { key: 'amount', label: 'Amount (₹)', type: 'number', min: 0, step: '0.01' }, { key: 'outstanding', label: 'Balance after this (₹, owed to us +, owed by us −)', type: 'number', step: '0.01' }, { key: 'note', label: 'Note' }]} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={addTxn} disabled={busy}>Record transaction</PrimaryButton></div>
      </Section>
      <Section title="Disclosure" isDark={isDark} action={<select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)} className={field(isDark)}>{fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
        {disc.loading ? <Loading /> : disc.error ? <ErrorNote error={disc.error} isDark={isDark} /> : !disc.data.groups.length ? <p className={`text-sm py-6 text-center ${mutedCls(isDark)}`}>No transactions in {fy}.</p> : (
          <div className="space-y-4">
            {disc.data.groups.map((g) => (
              <div key={g.relationship}><p className="text-sm font-semibold mb-1">{g.label}</p>
                <DataTable isDark={isDark} rowKey="party" rows={g.parties} columns={[{ key: 'party', label: 'Party' }, { key: 'tx', label: 'Transactions', render: (p) => p.transactions.map((t) => `${t.label}: ${fmtC(t.amount)}`).join('; ') }, { key: 'outstanding', label: 'Balance', align: 'right', mono: true, render: (p) => fmtC(p.outstanding) }]} /></div>
            ))}
            {disc.data.notes.map((n) => <p key={n} className={`text-xs ${mutedCls(isDark)}`}>{n}</p>)}
          </div>
        )}
        {txns.data?.length > 0 && <div className="mt-4"><p className="text-sm font-semibold mb-1">Transactions</p><DataTable isDark={isDark} rows={txns.data} columns={[{ key: 'date', label: 'Date' }, { key: 'party_name', label: 'Party' }, { key: 'nature', label: 'Nature', render: (r) => NATURE_OPTIONS.find((n) => n.value === r.nature)?.label }, { key: 'amount', label: 'Amount', align: 'right', mono: true, render: (r) => fmtC(r.amount) }, { key: 'act', label: '', align: 'right', render: (r) => <button type="button" aria-label="Remove transaction" onClick={() => delTxn(r)} className="h-8 w-8 text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4 mx-auto" /></button> }]} /></div>}
      </Section>
    </div>
  );
}

/* ═══ Earnings per share ════════════════════════════════════════════════ */
const EVENT_TYPES = [['opening', 'Opening shares'], ['issue', 'Fresh issue'], ['buyback', 'Buyback'], ['bonus', 'Bonus issue'], ['split', 'Split'], ['potential', 'Potential shares (options, convertibles)']].map(([value, label]) => ({ value, label }));

export function EpsPanel({ companyId, isDark, standards }) {
  const events = useLoad(() => get('/share-capital/events', { company_id: companyId }), [companyId]);
  const [form, setForm] = useState({ type: 'opening', date: todayIso(), face_value: 10 });
  const [calc, setCalc] = useState({ fy: fyOptions()[0], preference_dividend: '', average_market_price: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const fields = [
    { key: 'type', label: 'Event', type: 'select', options: EVENT_TYPES }, { key: 'date', label: 'Date', type: 'date' },
    { key: 'shares', label: 'Number of shares', type: 'number', min: 0, show: (v) => ['opening', 'issue', 'buyback', 'potential'].includes(v.type) },
    { key: 'ratio', label: form.type === 'bonus' ? 'Bonus shares per share held (0.5 = 1 for 2)' : 'Split multiple (10 = one becomes ten)', type: 'number', min: 0, step: '0.01', show: (v) => ['bonus', 'split'].includes(v.type) },
    { key: 'face_value', label: 'Face value (₹)', type: 'number', min: 0, show: (v) => v.type === 'opening' },
    { key: 'instrument', label: 'Instrument', type: 'select', placeholder: 'Choose', options: [{ value: 'option', label: 'Employee stock options' }, { value: 'convertible', label: 'Convertible instrument' }], show: (v) => v.type === 'potential' },
    { key: 'exercise_price', label: 'Exercise price (₹)', type: 'number', min: 0, show: (v) => v.type === 'potential' && v.instrument === 'option' },
    { key: 'earnings_addback', label: 'Interest saved after tax (₹)', type: 'number', min: 0, show: (v) => v.type === 'potential' && v.instrument === 'convertible' },
    { key: 'note', label: 'Note', span: 2 },
  ];

  const add = async () => {
    const needsShares = ['opening', 'issue', 'buyback', 'potential'].includes(form.type);
    if (needsShares && !(Number(form.shares) > 0)) { toast.error('Enter the number of shares.'); return; }
    if (!needsShares && !(Number(form.ratio) > 0)) { toast.error('Enter the ratio.'); return; }
    if (await runAction(setBusy, () => api.post(`${SP}/share-capital/events`, { company_id: companyId, ...clean(form, ['shares', 'ratio', 'face_value', 'exercise_price', 'earnings_addback']) }), 'Recorded')) { setForm({ ...form, shares: '', ratio: '', note: '' }); events.reload(); }
  };
  const del = async (e) => { if (await runAction(null, () => api.delete(`${SP}/share-capital/events/${e.id}`, { params: { company_id: companyId } }), 'Removed')) events.reload(); };
  const work = async () => {
    const r = await runAction(setBusy, () => get('/eps', { company_id: companyId, fy: calc.fy, preference_dividend: Number(calc.preference_dividend) || 0, average_market_price: Number(calc.average_market_price) || undefined }));
    if (r) setResult(r);
  };

  return (
    <div className="space-y-4">
      <Lede standard={standards?.eps || 'AS 20 / Ind AS 33'} isDark={isDark}>Profit after tax comes from the books. Record the equity share capital below, then work out basic and diluted EPS for a year.</Lede>
      <Section title="Share capital movements" isDark={isDark}>
        <FormGrid fields={fields} values={form} onChange={setForm} isDark={isDark} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={add} disabled={busy}>Record</PrimaryButton></div>
        {events.data?.length > 0 && <div className="mt-3"><DataTable isDark={isDark} rows={events.data} columns={[{ key: 'date', label: 'Date' }, { key: 'type', label: 'Event', render: (r) => EVENT_TYPES.find((t) => t.value === r.type)?.label }, { key: 'shares', label: 'Shares / ratio', align: 'right', mono: true, render: (r) => (r.shares ? fmtN(r.shares, 0) : r.ratio) }, { key: 'note', label: 'Note' }, { key: 'act', label: '', align: 'right', render: (r) => <button type="button" aria-label="Remove entry" onClick={() => del(r)} className="h-8 w-8 text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4 mx-auto" /></button> }]} /></div>}
      </Section>
      <Section title="Earnings per share" isDark={isDark}>
        <div className="grid gap-3 md:grid-cols-4 items-end">
          <Labeled label="Financial year" isDark={isDark}><select aria-label="EPS financial year" value={calc.fy} onChange={(e) => setCalc({ ...calc, fy: e.target.value })} className={field(isDark)}>{fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}</select></Labeled>
          <Labeled label="Preference dividend (₹)" isDark={isDark}><input type="number" aria-label="Preference dividend" min="0" value={calc.preference_dividend} onChange={(e) => setCalc({ ...calc, preference_dividend: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
          <Labeled label="Average market price (₹, for options)" isDark={isDark}><input type="number" aria-label="Average market price" min="0" value={calc.average_market_price} onChange={(e) => setCalc({ ...calc, average_market_price: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
          <PrimaryButton onClick={work} disabled={busy}>Work out EPS</PrimaryButton>
        </div>
        {result && (
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <Stat label="Basic EPS" value={fmtC(result.basic_eps)} isDark={isDark} /><Stat label="Diluted EPS" value={fmtC(result.diluted_eps)} isDark={isDark} />
              <Stat label="Profit after tax" value={fmtC(result.profit_after_tax)} isDark={isDark} /><Stat label="Weighted average shares" value={fmtN(result.weighted_average_shares, 0)} isDark={isDark} />
            </div>
            {!result.capital_matches && <p role="alert" className="text-sm text-amber-600">Share capital per the register ({fmtC(result.share_capital_per_register)}) differs from the books ({fmtC(result.share_capital_in_books)}). Reconcile before approving the accounts.</p>}
            {result.instruments.length > 0 && <DataTable isDark={isDark} rowKey="description" rows={result.instruments} columns={[{ key: 'description', label: 'Potential shares' }, { key: 'incremental_shares', label: 'Added shares', align: 'right', mono: true, render: (r) => fmtN(r.incremental_shares, 0) }, { key: 'included', label: 'In diluted EPS', render: (r) => (r.included ? <Pill tone="good">Included</Pill> : <Pill>Left out</Pill>) }, { key: 'reason', label: 'Why', render: (r) => r.reason || '' }]} />}
          </div>
        )}
      </Section>
    </div>
  );
}
