// ExportDialog.jsx — "full export report" for the Purchase Register.
//
//   Excel / CSV : Register + Tally voucher lines + month/supplier summary
//   Tally       : XML you can import into Tally to record the purchases as Purchase vouchers
//
// Scope is either the ticked bills or everything matching the current register filters.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  Download, FileSpreadsheet, FileCode2, AlertTriangle, CheckCircle2, Info, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MiniLoader } from '@/components/ui/GifLoader.jsx';
import api from '@/lib/api';
import {
  COLORS, downloadBlob, errorDetail, errorMessageAsync, exportFilters, filenameFromDisposition, fmtC, loadPref, savePref,
} from '@/lib/purchase';

const PREF_KEY = 'purchase.tally.options.v1';
const DEFAULT_OPTIONS = {
  tally_company: '',
  voucher_type: 'Purchase',
  purchase_ledger: 'Purchases',
  purchase_ledger_mode: 'single',
  cgst_ledger: 'Input CGST',
  sgst_ledger: 'Input SGST',
  igst_ledger: 'Input IGST',
  cess_ledger: 'Input Cess',
  round_off_ledger: 'Round Off',
  rate_wise_ledgers: false,
  voucher_number_mode: 'invoice_no',
  bill_allocations: true,
  create_masters: true,
};

function LabeledInput({ label, hint, isDark, ...props }) {
  return (
    <div>
      <label className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</label>
      <Input {...props} className={`mt-1 rounded-xl h-9 ${isDark ? 'bg-slate-900 border-slate-700' : ''}`} />
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

export default function ExportDialog({
  open, onClose, isDark, selectedIds = [], filters, matchingCount = 0, sortBy, sortDir,
}) {
  const [tab, setTab] = useState('tally');
  const [scope, setScope] = useState('filtered');
  const [opts, setOpts] = useState(() => loadPref(PREF_KEY, DEFAULT_OPTIONS));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [markExported, setMarkExported] = useState(true);
  const [check, setCheck] = useState(null);       // dry-run result
  const [checkError, setCheckError] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState('');
  const reqId = useRef(0);

  useEffect(() => {
    if (!open) return;
    setScope(selectedIds.length > 0 ? 'selected' : 'filtered');
    setCheck(null); setCheckError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => { savePref(PREF_KEY, opts); }, [opts]);

  const count = scope === 'selected' ? selectedIds.length : matchingCount;
  const setOpt = (patch) => setOpts((o) => ({ ...o, ...patch }));

  const body = useCallback((fmt, extra = {}) => ({
    format: fmt,
    ids: scope === 'selected' ? selectedIds : undefined,
    filters: scope === 'selected' ? {} : exportFilters(filters),
    options: opts,
    sort_by: sortBy === 'created_at' ? 'invoice_date' : sortBy || 'invoice_date',
    sort_dir: sortBy === 'created_at' ? 'asc' : sortDir || 'asc',
    ...extra,
  }), [scope, selectedIds, filters, opts, sortBy, sortDir]);

  // Pre-flight check for Tally: how many vouchers, what will be skipped, any mixed-company problem.
  useEffect(() => {
    if (!open || tab !== 'tally' || count === 0) return undefined;
    const id = ++reqId.current;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const { data } = await api.post('/purchase-invoices/export', body('tally_xml', { dry_run: true }));
        if (id !== reqId.current) return;
        setCheck(data); setCheckError(null);
      } catch (err) {
        if (id !== reqId.current) return;
        setCheck(null);
        const d = errorDetail(err);
        setCheckError(d ? { code: d.code, message: d.message, companies: d.companies } : { message: await errorMessageAsync(err) });
      } finally {
        if (id === reqId.current) setChecking(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [open, tab, scope, count, body]);

  const download = async (fmt, fallbackName, extra = {}) => {
    setBusy(fmt);
    try {
      const res = await api.post('/purchase-invoices/export', body(fmt, extra), { responseType: 'blob', timeout: 120000 });
      downloadBlob(res.data, filenameFromDisposition(res.headers?.['content-disposition'], fallbackName));
      toast.success(fmt.startsWith('tally') ? 'Tally file downloaded' : 'Report downloaded');
      if (fmt === 'tally_xml' && markExported) setCheck(null);
    } catch (err) {
      const msg = await errorMessageAsync(err, 'Export failed');
      toast.error(msg);
    } finally {
      setBusy('');
    }
  };

  const stamp = format(new Date(), 'yyyyMMdd');
  const tallyBlocked = !!checkError || (check && check.voucher_count === 0);
  const tone = isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-slate-50';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose?.(); }}>
      <DialogContent className={`sm:max-w-3xl max-h-[92vh] overflow-y-auto ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            <Download className="h-5 w-5" style={{ color: COLORS.mediumBlue }} /> Export purchase register
          </DialogTitle>
          <DialogDescription>Get a full report, or a file you can import into Tally to record these purchases.</DialogDescription>
        </DialogHeader>

        {/* scope */}
        <div className={`rounded-xl border p-3 text-sm flex flex-wrap items-center gap-x-5 gap-y-2 ${tone}`}>
          <span className="font-semibold">What to export</span>
          <label className={`inline-flex items-center gap-2 ${selectedIds.length === 0 ? 'opacity-40' : ''}`}>
            <input type="radio" name="scope" disabled={selectedIds.length === 0} checked={scope === 'selected'} onChange={() => setScope('selected')} />
            Ticked bills ({selectedIds.length})
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="scope" checked={scope === 'filtered'} onChange={() => setScope('filtered')} />
            Everything matching the current filters ({matchingCount})
          </label>
        </div>

        {/* tabs */}
        <div className="flex gap-2 border-b" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
          {[
            { k: 'tally', label: 'Tally import', icon: FileCode2 },
            { k: 'report', label: 'Excel / CSV report', icon: FileSpreadsheet },
          ].map((t) => (
            <button key={t.k} type="button" onClick={() => setTab(t.k)}
              className={`px-3 py-2 text-sm font-semibold inline-flex items-center gap-2 border-b-2 -mb-px ${tab === t.k ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500'}`}>
              <t.icon className="h-4 w-4" /> {t.label}
            </button>
          ))}
        </div>

        {count === 0 && <p className="text-sm text-slate-400 py-6 text-center">No bills in this selection.</p>}

        {count > 0 && tab === 'report' && (
          <div className="space-y-4">
            <div className={`rounded-xl border p-4 text-sm ${tone}`}>
              <p className="font-semibold mb-1">The Excel report has three sheets</p>
              <ul className="list-disc ml-5 text-slate-500 space-y-0.5 text-[13px]">
                <li><b>Purchase Register</b> — every bill with GSTINs, taxable value, CGST/SGST/IGST/Cess, round-off, total, paid, balance, status, expense head, source, Tally status — with filters and a totals row.</li>
                <li><b>Tally Vouchers</b> — each bill as its Debit/Credit ledger lines (party, purchase, input GST, round-off), ready for Tally’s Excel import or for keying in.</li>
                <li><b>Summary</b> — month-wise and supplier-wise totals.</li>
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => download('xlsx', `Purchase_Register_${stamp}.xlsx`)} disabled={!!busy} className="rounded-xl text-white" style={{ background: COLORS.emeraldGreen }}>
                {busy === 'xlsx' ? <MiniLoader height={18} /> : <><FileSpreadsheet className="h-4 w-4 mr-2" /> Download Excel ({count})</>}
              </Button>
              <Button variant="outline" onClick={() => download('csv', `Purchase_Register_${stamp}.csv`)} disabled={!!busy} className="rounded-xl">
                {busy === 'csv' ? <MiniLoader height={18} /> : <><Download className="h-4 w-4 mr-2" /> Download CSV</>}
              </Button>
            </div>
          </div>
        )}

        {count > 0 && tab === 'tally' && (
          <div className="space-y-4">
            {/* pre-flight */}
            <div className={`rounded-xl border p-3 text-sm ${checkError ? 'border-red-300 bg-red-50 dark:bg-red-950/20' : tone}`}>
              {checking && !check && !checkError && <span className="text-slate-400">Checking the bills…</span>}
              {checkError && (
                <div className="flex gap-2 text-red-800 dark:text-red-300">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-semibold">{checkError.message}</p>
                    {checkError.companies && <p className="text-xs mt-1">Companies in this selection: {checkError.companies.join(', ')}</p>}
                  </div>
                </div>
              )}
              {check && !checkError && (
                <div className="space-y-1.5">
                  <p className="flex items-center gap-2 font-semibold">
                    {check.voucher_count > 0 ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-600" />}
                    {check.voucher_count} purchase voucher{check.voucher_count === 1 ? '' : 's'} · {fmtC(check.total)}
                    {check.masters > 0 && <span className="font-normal text-slate-500">· {check.masters} ledger master{check.masters === 1 ? '' : 's'}</span>}
                    {checking && <span className="text-xs font-normal text-slate-400">updating…</span>}
                  </p>
                  {check.already_exported > 0 && (
                    <p className="text-xs text-amber-700 flex gap-1.5"><Info className="h-3.5 w-3.5 mt-px shrink-0" />
                      {check.already_exported} of these bill{check.already_exported === 1 ? ' was' : 's were'} already exported to Tally. Importing them again can create duplicate vouchers.</p>
                  )}
                  {check.skipped?.length > 0 && (
                    <p className="text-xs text-slate-500">Skipped: {check.skipped.slice(0, 4).map((x) => `${x.invoice} (${x.reason})`).join(', ')}{check.skipped.length > 4 ? ` +${check.skipped.length - 4} more` : ''}</p>
                  )}
                  {check.issue_count > 0 && (
                    <details className="text-xs text-amber-700">
                      <summary className="cursor-pointer">{check.issue_count} thing{check.issue_count === 1 ? '' : 's'} to be aware of</summary>
                      <ul className="list-disc ml-5 mt-1 space-y-0.5">{check.issues.slice(0, 12).map((x, i) => <li key={i}>{x}</li>)}</ul>
                    </details>
                  )}
                </div>
              )}
            </div>

            {/* essential options */}
            <div className="grid sm:grid-cols-2 gap-3">
              <LabeledInput isDark={isDark} label="Tally company name" value={opts.tally_company} onChange={(e) => setOpt({ tally_company: e.target.value })}
                placeholder="Exactly as in Tally (optional)" hint="Must match the company name open in Tally. Leave blank to import into whichever company is open." />
              <LabeledInput isDark={isDark} label="Purchase ledger" value={opts.purchase_ledger} onChange={(e) => setOpt({ purchase_ledger: e.target.value })}
                hint="Ledger debited with the taxable value." />
            </div>
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={opts.purchase_ledger_mode === 'per_invoice'} onChange={(e) => setOpt({ purchase_ledger_mode: e.target.checked ? 'per_invoice' : 'single' })} />
              Use each bill’s expense head (e.g. “Rent Expense”) instead of one purchase ledger
            </label>

            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-xs font-semibold text-blue-600 inline-flex items-center gap-1">
              {showAdvanced ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />} Ledger names & import options
            </button>
            {showAdvanced && (
              <div className={`rounded-xl border p-3 space-y-3 ${tone}`}>
                <div className="grid sm:grid-cols-3 gap-3">
                  <LabeledInput isDark={isDark} label="Input CGST ledger" value={opts.cgst_ledger} onChange={(e) => setOpt({ cgst_ledger: e.target.value })} />
                  <LabeledInput isDark={isDark} label="Input SGST ledger" value={opts.sgst_ledger} onChange={(e) => setOpt({ sgst_ledger: e.target.value })} />
                  <LabeledInput isDark={isDark} label="Input IGST ledger" value={opts.igst_ledger} onChange={(e) => setOpt({ igst_ledger: e.target.value })} />
                  <LabeledInput isDark={isDark} label="Cess ledger" value={opts.cess_ledger} onChange={(e) => setOpt({ cess_ledger: e.target.value })} />
                  <LabeledInput isDark={isDark} label="Round-off ledger" value={opts.round_off_ledger} onChange={(e) => setOpt({ round_off_ledger: e.target.value })} />
                  <LabeledInput isDark={isDark} label="Voucher type" value={opts.voucher_type} onChange={(e) => setOpt({ voucher_type: e.target.value })} />
                </div>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={opts.rate_wise_ledgers} onChange={(e) => setOpt({ rate_wise_ledgers: e.target.checked })} />
                  Rate-wise tax ledgers (e.g. “Input CGST 9%”)</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={opts.bill_allocations} onChange={(e) => setOpt({ bill_allocations: e.target.checked })} />
                  Track each supplier bill (bill-by-bill outstanding in Tally)</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={opts.voucher_number_mode === 'auto'} onChange={(e) => setOpt({ voucher_number_mode: e.target.checked ? 'auto' : 'invoice_no' })} />
                  Let Tally number the vouchers (otherwise the supplier’s invoice number is used)</label>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={opts.create_masters} onChange={(e) => setOpt({ create_masters: e.target.checked })} />
                  Include ledger masters (supplier, purchase, GST, round-off) in the same file
                </label>
              </div>
            )}

            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" checked={markExported} onChange={(e) => setMarkExported(e.target.checked)} />
              Mark these bills as “Exported to Tally” so they can be filtered and not exported twice
            </label>

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => download('tally_xml', `Tally_Purchase_Vouchers_${stamp}.xml`, { mark_exported: markExported })}
                disabled={!!busy || tallyBlocked || checking} className="rounded-xl text-white" style={{ background: COLORS.mediumBlue }}>
                {busy === 'tally_xml' ? <MiniLoader height={18} /> : <><FileCode2 className="h-4 w-4 mr-2" /> Download Tally XML{check ? ` (${check.voucher_count})` : ''}</>}
              </Button>
              <Button variant="outline" onClick={() => download('tally_masters', `Tally_Ledger_Masters_${stamp}.xml`)} disabled={!!busy || tallyBlocked}
                className="rounded-xl" title="Import this first if the supplier / GST ledgers do not exist in Tally yet">
                {busy === 'tally_masters' ? <MiniLoader height={18} /> : 'Ledger masters only'}
              </Button>
            </div>

            <div className={`rounded-xl border p-3 text-xs text-slate-500 space-y-1 ${tone}`}>
              <p className="font-semibold text-slate-600 dark:text-slate-300">How to import in Tally</p>
              <ol className="list-decimal ml-5 space-y-0.5">
                <li>If the supplier / GST ledgers are new to Tally, import <b>Ledger masters only</b> first (or keep “Include ledger masters” ticked).</li>
                <li>Open the company in Tally → <b>Import</b> (Alt+O in Tally Prime) → <b>Data</b> → pick the downloaded XML → choose to <b>add/combine</b>.</li>
                <li>Check the import log, then open <b>Day Book</b> to confirm the Purchase vouchers.</li>
              </ol>
              <p>Tip: import one or two bills first to confirm your ledger names match, then do the rest.</p>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
