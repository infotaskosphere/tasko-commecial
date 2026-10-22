import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';
import { fmtC } from '@/components/reports/ReportShared.jsx';
import { fyOptions, todayIso } from '@/lib/books';
import { LEASE_TREATMENT, isCapitalLease, leaseNextStep } from '@/lib/standards';
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

const trash = (label, onClick) => (
  <button type="button" aria-label={label} onClick={onClick} className="h-8 w-8 text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4 mx-auto" /></button>
);

/* ═══ Employee benefits ═════════════════════════════════════════════════ */
export function BenefitsPanel({ companyId, isDark, standards }) {
  const emps = useLoad(() => get('/employee-benefits/employees', { company_id: companyId }), [companyId]);
  const [asOf, setAsOf] = useState(todayIso());
  const val = useLoad(() => get('/employee-benefits/valuation', { company_id: companyId, as_of: asOf }), [companyId, asOf]);
  const posts = useLoad(() => get('/employee-benefits/postings', { company_id: companyId }), [companyId]);
  const [form, setForm] = useState({ joining_date: todayIso() });
  const [act, setAct] = useState({});
  const [busy, setBusy] = useState(false);
  const reloadAll = () => { emps.reload(); val.reload(); posts.reload(); };

  const add = async () => {
    if (!form.name?.trim() || !form.joining_date || !(Number(form.monthly_basic) > 0)) { toast.error('Enter the name, joining date and monthly basic pay.'); return; }
    if (await runAction(setBusy, () => api.post(`${SP}/employee-benefits/employees`, { company_id: companyId, ...clean(form, ['monthly_basic', 'leave_days']) }), 'Employee added')) { setForm({ joining_date: todayIso() }); reloadAll(); }
  };
  const del = async (e) => { if (await runAction(null, () => api.delete(`${SP}/employee-benefits/employees/${e.id}`, { params: { company_id: companyId } }), 'Removed')) reloadAll(); };
  const post = async () => {
    const body = { company_id: companyId, as_of: asOf, ...clean(act, ['actuarial_gratuity', 'actuarial_leave']) };
    const r = await runAction(setBusy, () => api.post(`${SP}/employee-benefits/post`, body).then((x) => x.data));
    if (r) { r.posted ? toast.success(`Provision posted as voucher ${r.voucher_no}`) : toast.info(r.message); reloadAll(); }
  };
  const v = val.data;

  return (
    <div className="space-y-4">
      <Lede standard={standards?.employee_benefits || 'AS 15 / Ind AS 19'} isDark={isDark}>Gratuity and encashable leave are provided at the balance sheet date. The figure here follows the statutory formula; enter an actuary's figure when you have one.</Lede>
      <Section title="Add an employee" isDark={isDark}>
        <FormGrid isDark={isDark} values={form} onChange={setForm} fields={[
          { key: 'name', label: 'Name', span: 2 }, { key: 'joining_date', label: 'Date of joining', type: 'date' },
          { key: 'monthly_basic', label: 'Monthly basic + DA (₹)', type: 'number', min: 0, step: '0.01' }, { key: 'leave_days', label: 'Encashable leave (days)', type: 'number', min: 0, step: '0.5' },
          { key: 'exit_date', label: 'Date of leaving (if any)', type: 'date' }]} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={add} disabled={busy}>Add employee</PrimaryButton></div>
      </Section>
      <Section title="Valuation" isDark={isDark} action={<input aria-label="Valuation as of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field(isDark)} />}>
        {val.loading ? <Loading /> : val.error ? <ErrorNote error={val.error} isDark={isDark} /> : (
          <div className="space-y-4">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <Stat label="Gratuity by formula" value={fmtC(v.gratuity_formula)} isDark={isDark} /><Stat label="Gratuity in books" value={fmtC(v.gratuity_in_books)} isDark={isDark} />
              <Stat label="Leave encashment" value={fmtC(v.leave_encashment)} isDark={isDark} /><Stat label="Leave in books" value={fmtC(v.leave_in_books)} isDark={isDark} />
            </div>
            <DataTable isDark={isDark} rowKey="employee_id" empty="No employees yet." rows={v.employees}
              columns={[{ key: 'name', label: 'Employee' }, { key: 'service_years', label: 'Service (years)', align: 'right' },
                { key: 'gratuity', label: 'Gratuity', align: 'right', mono: true, render: (r) => (r.gratuity_eligible ? fmtC(r.gratuity) : <span className={mutedCls(isDark)}>Under 5 years</span>) },
                { key: 'leave_encashment', label: 'Leave encashment', align: 'right', mono: true, render: (r) => fmtC(r.leave_encashment) },
                { key: 'act', label: '', align: 'right', render: (r) => trash(`Remove ${r.name}`, () => del({ id: r.employee_id })) }]} />
            <p className={`text-xs ${mutedCls(isDark)}`}>{v.note}</p>
            <div className="grid gap-3 md:grid-cols-3 items-end">
              <Labeled label="Actuary's gratuity figure (₹, optional)" isDark={isDark}><input type="number" aria-label="Actuarial gratuity" min="0" value={act.actuarial_gratuity || ''} onChange={(e) => setAct({ ...act, actuarial_gratuity: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
              <Labeled label="Actuary's leave figure (₹, optional)" isDark={isDark}><input type="number" aria-label="Actuarial leave" min="0" value={act.actuarial_leave || ''} onChange={(e) => setAct({ ...act, actuarial_leave: e.target.value })} className={`${field(isDark)} font-mono`} /></Labeled>
              <PrimaryButton onClick={post} disabled={busy}>{busy ? 'Posting…' : 'Post provision'}</PrimaryButton>
            </div>
          </div>
        )}
      </Section>
      <Section title="Provisions posted" isDark={isDark}>
        {posts.loading ? <Loading /> : <DataTable isDark={isDark} empty="None yet." rows={posts.data || []}
          columns={[{ key: 'as_of', label: 'As of' }, { key: 'method', label: 'Basis' }, { key: 'gratuity', label: 'Gratuity', align: 'right', mono: true, render: (r) => fmtC(r.gratuity) }, { key: 'leave', label: 'Leave', align: 'right', mono: true, render: (r) => fmtC(r.leave) },
            { key: 'chg', label: 'Charged', align: 'right', mono: true, render: (r) => fmtC(r.gratuity_change + r.leave_change) }]} />}
      </Section>
    </div>
  );
}

/* ═══ Leases ═════════════════════════════════════════════════════════════ */
const FREQ = [['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['half_yearly', 'Half-yearly'], ['yearly', 'Yearly']].map(([value, label]) => ({ value, label }));

function LeaseCard({ l, companyId, isDark, onDone }) {
  const [open, setOpen] = useState(false);
  const [through, setThrough] = useState(todayIso());
  const [busy, setBusy] = useState(false);
  const detail = useLoad(() => (open ? get(`/leases/${l.id}`, { company_id: companyId }) : Promise.resolve(null)), [open, l.id, l.periods_posted, l.recognised]);
  const t = LEASE_TREATMENT[l.treatment];
  const next = leaseNextStep(l);

  const recognise = async () => { if (await runAction(setBusy, () => api.post(`${SP}/leases/${l.id}/recognise`, null, { params: { company_id: companyId } }), 'Lease recognised')) onDone(); };
  const postPeriods = async () => {
    const r = await runAction(setBusy, () => api.post(`${SP}/leases/${l.id}/post-periods`, { company_id: companyId, through_date: through }).then((x) => x.data));
    if (!r) return;
    if (r.problem) toast.warning(r.problem);
    if (r.posted_periods.length) toast.success(`Posted ${r.posted_periods.length} period${r.posted_periods.length === 1 ? '' : 's'}`);
    else if (r.message) toast.info(r.message);
    onDone();
  };
  const del = async () => { if (await runAction(null, () => api.delete(`${SP}/leases/${l.id}`, { params: { company_id: companyId } }), 'Lease deleted')) onDone(); };

  return (
    <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div><span className="font-semibold">{l.asset}</span> <span className={`text-xs ${mutedCls(isDark)}`}>from {l.lessor} · {l.start_date} · {l.periods} {l.frequency.replace('_', '-')} payments of {fmtC(l.payment)}</span></div>
        <Pill tone={t.tone}>{t.label}</Pill>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {isCapitalLease(l) && <span className="text-sm">Liability at start <strong className="font-mono">{fmtC(l.present_value)}</strong></span>}
        <span className={`text-xs ${mutedCls(isDark)}`}>{l.periods_posted} of {l.periods} periods posted</span>
        <span className="flex-1" />
        {next === 'recognise' && <PrimaryButton onClick={recognise} disabled={busy}>Recognise lease</PrimaryButton>}
        {next === 'post' && (
          <>
            <input aria-label={`Post periods through for ${l.asset}`} type="date" value={through} onChange={(e) => setThrough(e.target.value)} className={field(isDark)} />
            <GhostButton isDark={isDark} onClick={postPeriods} disabled={busy}>Post periods</GhostButton>
          </>
        )}
        <GhostButton isDark={isDark} onClick={() => setOpen(!open)}>{open ? 'Hide schedule' : 'Schedule'}</GhostButton>
        {!l.recognised && !l.periods_posted && <button type="button" aria-label={`Delete ${l.asset}`} onClick={del} className="h-8 w-8 text-slate-400 hover:text-red-600"><Trash2 className="h-4 w-4 mx-auto" /></button>}
      </div>
      {open && (
        <div className="mt-3">
          {detail.loading || !detail.data ? <Loading /> : (
            <DataTable isDark={isDark} rowKey="period" rows={detail.data.schedule}
              columns={[{ key: 'period', label: '#' }, { key: 'end', label: 'Period ends' }, { key: 'payment', label: 'Payment', align: 'right', mono: true, render: (r) => fmtC(r.payment) },
                ...(isCapitalLease(l) ? [{ key: 'interest', label: 'Interest', align: 'right', mono: true, render: (r) => fmtC(r.interest) }, { key: 'principal', label: 'Principal', align: 'right', mono: true, render: (r) => fmtC(r.principal) }, { key: 'closing', label: 'Liability', align: 'right', mono: true, render: (r) => fmtC(r.closing) }] : []),
                { key: 'posted', label: '', render: (r) => (r.posted ? <Pill tone="good">Posted</Pill> : null) }]} />
          )}
        </div>
      )}
    </div>
  );
}

export function LeasesPanel({ companyId, isDark, standards, framework }) {
  const list = useLoad(() => get('/leases', { company_id: companyId }), [companyId]);
  const [asOf, setAsOf] = useState(todayIso());
  const disc = useLoad(() => get('/leases/disclosure', { company_id: companyId, as_of: asOf }), [companyId, asOf, list.data?.length]);
  const [form, setForm] = useState({ frequency: 'monthly', start_date: todayIso() });
  const [busy, setBusy] = useState(false);
  const reloadAll = () => { list.reload(); disc.reload(); };
  const indAs = framework === 'IND_AS';

  const fields = [
    { key: 'lessor', label: 'Lessor' }, { key: 'asset', label: 'Asset' }, { key: 'start_date', label: 'Lease starts', type: 'date' },
    { key: 'periods', label: 'Number of payments', type: 'number', min: 1, step: '1' }, { key: 'frequency', label: 'Payment frequency', type: 'select', options: FREQ },
    { key: 'payment', label: 'Payment each period (₹)', type: 'number', min: 0, step: '0.01' },
    { key: 'escalation_pct', label: 'Yearly rent increase (%)', type: 'number', min: 0, step: '0.5' },
    { key: 'discount_rate_pct', label: 'Discount rate (%)', type: 'number', min: 0, step: '0.1', hint: indAs ? 'Your incremental borrowing rate.' : 'Only needed for a finance lease.' },
    { key: 'in_advance', label: 'Paid at the start of each period', type: 'checkbox' },
    indAs ? { key: 'low_value', label: 'Low-value asset (expense straight-line)', type: 'checkbox' } : { key: 'finance_lease', label: 'Finance lease: substantially all risks and rewards pass to us', type: 'checkbox' },
  ];
  const add = async () => {
    if (!form.lessor?.trim() || !form.asset?.trim() || !(Number(form.periods) >= 1) || !(Number(form.payment) > 0)) { toast.error('Enter the lessor, asset, number of payments and the payment.'); return; }
    const r = await runAction(setBusy, () => api.post(`${SP}/leases`, { company_id: companyId, ...clean(form, ['periods', 'payment', 'escalation_pct', 'discount_rate_pct']), in_advance: !!form.in_advance, low_value: !!form.low_value, finance_lease: !!form.finance_lease }).then((x) => x.data),
      (x) => `Lease recorded as ${LEASE_TREATMENT[x.treatment].label.toLowerCase()}`);
    if (r) { setForm({ ...form, lessor: '', asset: '', periods: '', payment: '' }); reloadAll(); }
  };
  const d = disc.data;

  return (
    <div className="space-y-4">
      <Lede standard={standards?.leases || 'AS 19 / Ind AS 116'} isDark={isDark}>
        {indAs ? 'Each lease becomes a right-of-use asset and a lease liability, except short-term and low-value leases. Rent you have already booked as an expense is reclassified each period.'
          : 'Operating leases are expensed straight-line over the term. A finance lease is capitalised with a matching liability. Rent already booked as an expense is reclassified each period.'}
      </Lede>
      <Section title="Record a lease" isDark={isDark}>
        <FormGrid fields={fields} values={form} onChange={setForm} isDark={isDark} />
        <div className="mt-3 flex justify-end"><PrimaryButton onClick={add} disabled={busy}>Record lease</PrimaryButton></div>
      </Section>
      <Section title="Leases" isDark={isDark}>
        {list.loading ? <Loading /> : list.error ? <ErrorNote error={list.error} isDark={isDark} /> : !list.data.length ? <p className={`text-sm py-6 text-center ${mutedCls(isDark)}`}>No leases recorded.</p> : (
          <div className="space-y-3">{list.data.map((l) => <LeaseCard key={l.id} l={l} companyId={companyId} isDark={isDark} onDone={reloadAll} />)}</div>
        )}
      </Section>
      <Section title="Lease note" isDark={isDark} action={<input aria-label="Lease note as of" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className={field(isDark)} />}>
        {disc.loading || !d ? <Loading /> : (
          <div className="space-y-3">
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              <Stat label="Right-of-use assets (net)" value={fmtC(d.right_of_use_net)} isDark={isDark} /><Stat label="Lease liability" value={fmtC(d.lease_liability)} hint={`${fmtC(d.liability_current)} due within a year`} isDark={isDark} />
              <Stat label="Payments within 1 year" value={fmtC(d.maturity.within_1_year)} isDark={isDark} /><Stat label="Payments after 1 year" value={fmtC(d.maturity['1_to_5_years'] + d.maturity.over_5_years)} isDark={isDark} />
            </div>
            <p className={`text-xs ${mutedCls(isDark)}`}>{d.note}</p>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ═══ Borrowing costs ═══════════════════════════════════════════════════ */
export function BorrowingPanel({ companyId, isDark, standards }) {
  const [fy, setFy] = useState(fyOptions()[0]);
  const list = useLoad(() => get('/borrowing-costs', { company_id: companyId, fy }), [companyId, fy]);
  const [form, setForm] = useState({ start_date: todayIso(), end_date: todayIso() });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const NUM = ['principal', 'rate_pct', 'temporary_income', 'interest_override'];
  const body = () => ({ company_id: companyId, ...clean(form, NUM), qualifying_asset: !!form.qualifying_asset });
  const valid = form.asset_description?.trim() && Number(form.principal) > 0 && Number(form.rate_pct) > 0;

  const doPreview = async () => {
    if (!valid) { toast.error('Enter the asset, the loan amount and the rate.'); return; }
    const r = await runAction(setBusy, () => api.post(`${SP}/borrowing-costs/preview`, body()).then((x) => x.data));
    if (r) setPreview(r);
  };
  const post = async () => {
    if (!valid) { toast.error('Enter the asset, the loan amount and the rate.'); return; }
    const r = await runAction(setBusy, () => api.post(`${SP}/borrowing-costs`, body()).then((x) => x.data), (x) => `${fmtC(x.capitalisable)} capitalised as voucher ${x.voucher_no}`);
    if (r) { setPreview(null); setForm({ ...form, asset_description: '', principal: '', qualifying_asset: false }); list.reload(); }
  };
  const cancel = async (rec) => { if (await runAction(null, () => api.post(`${SP}/borrowing-costs/${rec.id}/cancel`, null, { params: { company_id: companyId } }), 'Cancelled')) list.reload(); };

  return (
    <div className="space-y-4">
      <Lede standard={standards?.borrowing_costs || 'AS 16 / Ind AS 23'} isDark={isDark}>Interest on a loan taken to build or acquire a qualifying asset, one that needs a substantial period (over 12 months) to get ready, moves from finance cost into the asset. This assumes the interest is already booked as an expense.</Lede>
      <Section title="Capitalise interest" isDark={isDark}>
        <FormGrid isDark={isDark} values={form} onChange={setForm} fields={[
          { key: 'asset_description', label: 'Asset being built or acquired', span: 2 }, { key: 'loan_description', label: 'Loan' },
          { key: 'principal', label: 'Loan used (₹)', type: 'number', min: 0 }, { key: 'rate_pct', label: 'Interest rate (% a year)', type: 'number', min: 0, step: '0.1' },
          { key: 'start_date', label: 'From', type: 'date' }, { key: 'end_date', label: 'To (asset ready, or year end)', type: 'date' },
          { key: 'temporary_income', label: 'Income from parking unspent loan (₹)', type: 'number', min: 0 }, { key: 'interest_override', label: 'Actual interest charged (₹, optional)', type: 'number', min: 0 },
          { key: 'qualifying_asset', label: 'This is a qualifying asset', type: 'checkbox', hint: 'It takes a substantial period to get ready for use.' }]} />
        {preview && <p className="mt-3 text-sm" aria-live="polite">{preview.days} days of interest is <strong className="font-mono">{fmtC(preview.interest)}</strong>; after investment income, <strong className="font-mono">{fmtC(preview.capitalisable)}</strong> can be capitalised.</p>}
        <div className="mt-3 flex justify-end gap-2"><GhostButton isDark={isDark} onClick={doPreview} disabled={busy}>Work it out</GhostButton><PrimaryButton onClick={post} disabled={busy || !form.qualifying_asset}>Capitalise</PrimaryButton></div>
      </Section>
      <Section title="Capitalised" isDark={isDark} action={<select aria-label="Financial year" value={fy} onChange={(e) => setFy(e.target.value)} className={field(isDark)}>{fyOptions().map((y) => <option key={y} value={y}>{y}</option>)}</select>}>
        {list.loading ? <Loading /> : list.error ? <ErrorNote error={list.error} isDark={isDark} /> : (
          <>
            <DataTable isDark={isDark} empty="Nothing capitalised in this year." rows={list.data.records.map((r) => ({ ...r, _muted: r.status === 'cancelled' }))}
              columns={[{ key: 'asset_description', label: 'Asset' }, { key: 'period', label: 'Period', render: (r) => `${r.start_date} to ${r.end_date}` }, { key: 'capitalisable', label: 'Capitalised', align: 'right', mono: true, render: (r) => fmtC(r.capitalisable) },
                { key: 'act', label: '', align: 'right', render: (r) => (r.status === 'active' ? <GhostButton isDark={isDark} onClick={() => cancel(r)}>Cancel</GhostButton> : <Pill>Cancelled</Pill>) }]} />
            <p className="mt-3 text-sm">Total capitalised in {fy}: <strong className="font-mono">{fmtC(list.data.total_capitalised)}</strong></p>
          </>
        )}
      </Section>
    </div>
  );
}
