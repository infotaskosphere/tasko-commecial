// InvoiceForm.jsx — the editable invoice fields, shared by
//   • the EDITABLE PREVIEW that opens after a bill is read (InvoicePreviewDialog), and
//   • the Edit dialog for bills already in the register.
//
// It shows live checks while you type (taxable + GST + round-off must equal the total,
// GSTIN check-digit, same-state IGST…) and offers one-click repairs for common misreads.
import React, { useMemo } from 'react';
import { ArrowLeftRight, Wand2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import SearchableSelect from '@/components/ui/SearchableSelect.jsx';
import { companyOptions, clientOptions } from '@/lib/companies';
import { computeChecks, fmtNum, gstComponentsTotal, num, r2 } from '@/lib/purchase';

const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };

/** {field: worstIssue} so each input can show the single most important message. */
export function groupIssues(issues) {
  const out = {};
  (issues || []).forEach((i) => {
    if (!i?.field) return;
    if (!out[i.field] || (SEVERITY_RANK[i.severity] ?? 3) < (SEVERITY_RANK[out[i.field].severity] ?? 3)) out[i.field] = i;
  });
  return out;
}

function Field({ label, issue, edited, hint, children, className = '' }) {
  const tone = issue?.severity === 'error' ? 'text-red-600' : issue?.severity === 'warn' ? 'text-amber-600' : 'text-slate-400';
  return (
    <div className={className}>
      <label className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        {label}
        {edited && <span className="text-[9px] normal-case font-semibold px-1.5 py-px rounded bg-blue-100 text-blue-700">edited</span>}
      </label>
      <div className="mt-1">{children}</div>
      {issue ? <p className={`text-[11px] mt-1 leading-snug ${tone}`}>{issue.message}</p>
        : hint ? <p className="text-[11px] mt-1 text-slate-400 leading-snug">{hint}</p> : null}
    </div>
  );
}

const inputClass = (issue, isDark, extra = '') => {
  const tone = issue?.severity === 'error'
    ? 'border-red-400 bg-red-50/60 focus-visible:ring-red-300 dark:bg-red-950/20'
    : issue?.severity === 'warn'
      ? 'border-amber-400 bg-amber-50/60 focus-visible:ring-amber-300'
      : isDark ? 'bg-slate-900 border-slate-700' : 'bg-white';
  return `rounded-xl h-9 ${tone} ${extra}`;
};

export default function InvoiceForm({
  form,
  onChange,
  companies = [],
  clients = [],
  issues = [],
  original = null,          // extracted values, to mark edited fields
  isDark = false,
  showBuyer = true,
  showCurrency = true,      // new bills only: a saved bill is already in rupees
  companyLabel = 'Concerned company (from Master Data)',
  companyHint = 'The company whose books this purchase is posted to.',
  onSwapParties,
}) {
  const byField = useMemo(() => groupIssues(issues), [issues]);
  const checks = useMemo(() => computeChecks(form), [form]);
  const compsTotal = gstComponentsTotal(form);
  const ccy = String(form.currency || 'INR').toUpperCase().trim() || 'INR';
  const foreign = ccy !== 'INR';
  const sym = foreign ? `${ccy} ` : '₹';
  const compOptions = useMemo(() => companyOptions(companies), [companies]);
  const cliOptions = useMemo(() => clientOptions(clients), [clients]);

  const isEdited = (k) => original && String(original[k] ?? '') !== String(form[k] ?? '') && !(original[k] == null && form[k] === '');

  const set = (patch) => {
    const next = { ...patch };
    if (['cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount'].some((k) => k in patch)) {
      const merged = { ...form, ...patch };
      const sum = gstComponentsTotal(merged);
      next.total_gst = sum > 0 ? String(sum) : (merged.total_gst || '');
    }
    onChange(next);
  };

  const text = (key, label, props = {}, extra = {}) => (
    <Field label={label} issue={byField[key]} edited={isEdited(key)} {...extra}>
      <Input
        value={form[key] ?? ''}
        onChange={(e) => set({ [key]: props.upper ? e.target.value.toUpperCase().replace(/\s+/g, '') : e.target.value })}
        className={inputClass(byField[key], isDark, props.mono ? 'font-mono text-[13px]' : '')}
        placeholder={props.placeholder}
        type={props.type}
        maxLength={props.maxLength}
      />
    </Field>
  );

  const money = (key, label, extra = {}) => (
    <Field label={label} issue={byField[key]} edited={isEdited(key)} {...extra}>
      <Input
        type="number" step="0.01" inputMode="decimal"
        value={form[key] ?? ''}
        onChange={(e) => set({ [key]: e.target.value })}
        className={inputClass(byField[key], isDark, 'text-right tabular-nums')}
        placeholder="0.00"
      />
    </Field>
  );

  const statusTone = checks.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
    : num(form.grand_total) > 0 ? 'border-red-300 bg-red-50 text-red-800 dark:bg-red-950/30 dark:text-red-300'
      : 'border-slate-200 bg-slate-50 text-slate-600 dark:bg-slate-800 dark:text-slate-300';

  return (
    <div className="space-y-5">
      {/* ── Who ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Parties</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Field label={companyLabel} issue={byField.company_id} edited={isEdited('company_id')} hint={companyHint}>
            <SearchableSelect
              options={compOptions} value={form.company_id || ''} isDark={isDark}
              onChange={(v) => set({ company_id: v })}
              placeholder="Select company…" emptyText="No company in Master Data"
              className={byField.company_id ? 'border-red-400' : ''}
            />
          </Field>
          <Field label="Linked client (optional)" edited={isEdited('client_id')} hint="Only if this purchase is on behalf of one of your clients.">
            <SearchableSelect
              options={cliOptions} value={form.client_id || ''} isDark={isDark}
              onChange={(v) => set({ client_id: v })} allowClear placeholder="None" emptyText="No clients"
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-3 items-start">
          <div className="space-y-3">
            {text('supplier_name', 'Supplier name', { placeholder: 'Who issued the bill' })}
            {text('supplier_gstin', 'Supplier GSTIN', { upper: true, mono: true, maxLength: 15, placeholder: '15-character GSTIN' })}
          </div>
          {showBuyer && onSwapParties ? (
            <button
              type="button" onClick={onSwapParties}
              title="Supplier and buyer are the wrong way round — swap them"
              className="hidden md:flex mt-7 h-8 w-8 items-center justify-center rounded-full border border-slate-300 text-slate-500 hover:text-blue-600 hover:border-blue-400 bg-white dark:bg-slate-800"
            >
              <ArrowLeftRight className="h-4 w-4" />
            </button>
          ) : <span className="hidden md:block" />}
          {showBuyer && (
            <div className="space-y-3">
              {text('buyer_name', 'Buyer name (as printed)', { placeholder: 'Billed to' })}
              {text('buyer_gstin', 'Buyer GSTIN', { upper: true, mono: true, maxLength: 15, placeholder: '15-character GSTIN' })}
            </div>
          )}
        </div>
        {showBuyer && onSwapParties && (
          <button type="button" onClick={onSwapParties} className="md:hidden text-xs text-blue-600 inline-flex items-center gap-1">
            <ArrowLeftRight className="h-3.5 w-3.5" /> Swap supplier ↔ buyer
          </button>
        )}
      </section>

      {/* ── Bill ── */}
      <section className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Bill</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {text('invoice_no', 'Invoice no.', { placeholder: 'As printed' })}
          {text('invoice_date', 'Invoice date', { type: 'date' })}
          {text('due_date', 'Due date (optional)', { type: 'date' })}
        </div>
      </section>

      {/* ── Money ── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Amounts ({foreign ? ccy : '₹'})</h3>
          {showCurrency && <label className="flex items-center gap-2 text-xs text-slate-500">
            Currency
            <Input
              value={ccy} maxLength={3} aria-label="Currency"
              onChange={(e) => set({ currency: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })}
              className={inputClass(byField.currency, isDark, 'h-8 w-16 text-center font-mono text-[13px]')}
            />
          </label>}
        </div>
        {foreign && showCurrency && (
          <p className="text-xs text-sky-700 dark:text-sky-300">
            Enter the amounts exactly as printed in {ccy}. When you add the bill they are converted to rupees at the exchange rate for the invoice date.
          </p>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {money('taxable_amount', 'Taxable value')}
          {money('cgst_amount', 'CGST')}
          {money('sgst_amount', 'SGST')}
          {money('igst_amount', 'IGST')}
          {money('cess_amount', 'Cess')}
          <Field label="Total GST" edited={false} hint={compsTotal > 0 ? 'Sum of the tax boxes' : undefined}>
            <Input
              type="number" step="0.01" inputMode="decimal"
              value={compsTotal > 0 ? compsTotal : (form.total_gst ?? '')}
              readOnly={compsTotal > 0}
              onChange={(e) => set({ total_gst: e.target.value })}
              className={inputClass(byField.total_gst, isDark, `text-right tabular-nums ${compsTotal > 0 ? 'opacity-70' : ''}`)}
              placeholder="0.00"
            />
          </Field>
          {money('round_off', 'Round-off')}
          {money('grand_total', 'Invoice total', {})}
        </div>

        <div className={`rounded-xl border px-3 py-2.5 text-xs ${statusTone}`}>
          <div className="flex items-start gap-2">
            {checks.ok ? <CheckCircle2 className="h-4 w-4 mt-px shrink-0" /> : <AlertTriangle className="h-4 w-4 mt-px shrink-0" />}
            <div className="min-w-0 flex-1">
              {num(form.grand_total) <= 0 ? (
                <span>Enter the invoice total to check the figures.</span>
              ) : checks.ok ? (
                <span>
                  Figures add up: {sym}{fmtNum(num(form.taxable_amount))} + GST {sym}{fmtNum(checks.gst)}
                  {num(form.round_off) !== 0 && <> {num(form.round_off) > 0 ? '+' : '−'} round-off {sym}{fmtNum(Math.abs(num(form.round_off)))}</>} = {sym}{fmtNum(checks.total)}
                  {checks.ratePct != null && checks.gst > 0 && <span className="opacity-75"> · GST ≈ {checks.ratePct}% of taxable</span>}
                </span>
              ) : (
                <>
                  <p className="font-semibold">
                    Taxable + GST + round-off = {sym}{fmtNum(checks.sum)} but the total says {sym}{fmtNum(checks.total)} (off by {sym}{fmtNum(Math.abs(checks.diff))}).
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {checks.fixTotal != null && (
                      <button type="button" onClick={() => set({ grand_total: String(checks.fixTotal) })}
                        className="px-2 py-1 rounded-lg bg-white/80 border border-current/20 hover:bg-white font-medium inline-flex items-center gap-1">
                        <Wand2 className="h-3 w-3" /> Set total to {sym}{fmtNum(checks.fixTotal)}
                      </button>
                    )}
                    {checks.fixTaxable != null && (
                      <button type="button" onClick={() => set({ taxable_amount: String(checks.fixTaxable) })}
                        className="px-2 py-1 rounded-lg bg-white/80 border border-current/20 hover:bg-white font-medium inline-flex items-center gap-1">
                        <Wand2 className="h-3 w-3" /> Set taxable to {sym}{fmtNum(checks.fixTaxable)}
                      </button>
                    )}
                    {checks.fixRound != null && checks.fixRound !== 0 && (
                      <button type="button" onClick={() => set({ round_off: String(checks.fixRound) })}
                        className="px-2 py-1 rounded-lg bg-white/80 border border-current/20 hover:bg-white font-medium inline-flex items-center gap-1">
                        <Wand2 className="h-3 w-3" /> Set round-off to {checks.fixRound > 0 ? '+' : '−'}{sym}{fmtNum(Math.abs(checks.fixRound))}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          {compsTotal === 0 && num(form.total_gst) > 0 && (
            <div className="mt-2 pt-2 border-t border-current/15 flex items-center justify-between gap-2">
              <span className="opacity-80">Only a total GST is filled — split it into CGST + SGST for Tally.</span>
              <button
                type="button"
                onClick={() => { const t = num(form.total_gst); const h = r2(t / 2); set({ cgst_amount: String(h), sgst_amount: String(r2(t - h)), igst_amount: '' }); }}
                className="px-2 py-1 rounded-lg bg-white/80 border border-current/20 hover:bg-white font-medium whitespace-nowrap"
              >
                Split equally
              </button>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
