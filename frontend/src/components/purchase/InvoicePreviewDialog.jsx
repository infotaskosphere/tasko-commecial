// InvoicePreviewDialog.jsx — EDITABLE PREVIEW shown after a vendor bill is read and
// BEFORE it is added to the Purchase Register.
//
//   left  : the original document, so every figure can be checked by eye
//   right : the fields as read — every one editable — with live checks
//
// Nothing is saved until "Add to Purchase Register" is pressed.
import React, { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, XCircle, Info, CheckCircle2, FileText, ScanLine, Sparkles, Eye, EyeOff, ExternalLink, Database,
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { MiniLoader } from '@/components/ui/GifLoader.jsx';
import api from '@/lib/api';
import InvoiceForm from '@/components/purchase/InvoiceForm.jsx';
import {
  COLORS, CONFIDENCE_LABEL, METHOD_LABEL, errorDetail, errorMessage, fmtNum, liveIssues, num,
} from '@/lib/purchase';

// Server-side notes that the live checks cannot reproduce (everything else is recomputed live as you type).
const NOTE_CODES = new Set([
  'duplicate', 'vendor_known_as', 'oidar', 'proforma', 'receipt', 'advance_adjusted', 'own_company_is_supplier',
  'company_not_matched', 'low_confidence', 'unreadable', 'timeout', 'read_failed', 'ai_text_disagree',
  'gstin_repaired', 'missing_supplier_gstin',
  // Finix learning notes (filled from this vendor's usual layout, unusual GST rate / numbering, learned expense head)
  'layout_filled', 'layout_differs', 'gst_rate_unusual', 'invoice_no_unusual', 'ledger_learned_auto', 'ledger_learned_review',
]);
const OVERRIDABLE = new Set(['mismatch', 'duplicate']);

const s = (v) => (v == null ? '' : String(v));
const n = (v) => (v == null || v === '' || Number(v) === 0 ? '' : String(v));

export function previewToForm(preview) {
  const e = preview?.extracted || {};
  const sg = preview?.suggested || {};
  return {
    company_id: sg.company_id || '',
    client_id: sg.client_id || '',
    supplier_name: s(e.supplier_name), supplier_gstin: s(e.supplier_gstin),
    buyer_name: s(e.buyer_name), buyer_gstin: s(e.buyer_gstin),
    invoice_no: s(e.invoice_no), invoice_date: s(e.invoice_date), due_date: s(e.due_date),
    taxable_amount: n(e.taxable_amount), cgst_amount: n(e.cgst_amount), sgst_amount: n(e.sgst_amount),
    igst_amount: n(e.igst_amount), cess_amount: n(e.cess_amount), total_gst: n(e.total_gst),
    round_off: e.round_off ? String(e.round_off) : '', grand_total: n(e.grand_total),
    currency: s(e.currency) || 'INR', place_of_supply: s(e.place_of_supply), document_type: s(e.document_type) || 'tax_invoice',
  };
}

const NUMERIC = ['taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'total_gst', 'round_off', 'grand_total'];

function formToPayload(form) {
  const p = { ...form };
  NUMERIC.forEach((k) => { p[k] = num(form[k]); });
  return p;
}

function DocumentPane({ file, rawText }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file) { setUrl(''); return undefined; }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  const name = (file?.name || '').toLowerCase();
  const isPdf = name.endsWith('.pdf') || file?.type === 'application/pdf';
  const isImg = /\.(png|jpe?g|webp)$/.test(name) || (file?.type || '').startsWith('image/');
  if (!file) return <div className="h-full flex items-center justify-center text-sm text-slate-400">No document to show</div>;
  if (isPdf) return <iframe title="Invoice document" src={url} className="w-full h-full bg-white" />;
  if (isImg) return <div className="h-full overflow-auto bg-slate-100 dark:bg-slate-950 p-2"><img src={url} alt="Invoice" className="max-w-full mx-auto" /></div>;
  return <pre className="h-full overflow-auto text-xs p-3 whitespace-pre-wrap">{rawText || 'Preview not available for this file type.'}</pre>;
}

export default function InvoicePreviewDialog({
  open, onClose, preview, file, queue = null, companies, clients, isDark, onSaved, onSkip,
}) {
  const initial = useMemo(() => previewToForm(preview), [preview]);
  const [form, setForm] = useState(initial);
  const [forceDup, setForceDup] = useState(false);
  const [ackMismatch, setAckMismatch] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [showDoc, setShowDoc] = useState(false);
  // Expense head: starts at what Finix proposed; only sent to the server when the person actually changes it.
  const proposedHead = preview?.ledger?.expense_ledger_code || '';
  const [ledgerCode, setLedgerCode] = useState(proposedHead);
  const [ledgerTouched, setLedgerTouched] = useState(false);
  const [heads, setHeads] = useState([]);

  useEffect(() => {
    setForm(initial); setForceDup(false); setAckMismatch(false); setServerErrors([]); setShowDoc(false);
    setLedgerCode(proposedHead); setLedgerTouched(false);
  }, [initial, proposedHead]);

  useEffect(() => {
    let alive = true;
    if (!open || !form.company_id) { setHeads([]); return undefined; }
    api.get('/purchase-invoices/expense-heads', { params: { company_id: form.company_id } })
      .then(({ data }) => { if (alive) setHeads(Array.isArray(data) ? data : []); })
      .catch(() => { if (alive) setHeads([]); });
    return () => { alive = false; };
  }, [open, form.company_id]);

  const vendor = preview?.vendor;
  const extractedFile = preview?.file || {};
  const wordsVal = preview?.amount_in_words_value;

  const issues = useMemo(() => {
    const list = liveIssues(form);
    if (wordsVal && num(form.grand_total) > 0 && Math.abs(num(form.grand_total) - wordsVal) > 0.51) {
      list.push({ field: 'grand_total', severity: 'warn', code: 'words',
        message: `The amount in words on the bill is ₹${fmtNum(wordsVal)}, but the total here is ₹${fmtNum(num(form.grand_total))}.` });
    }
    const sameKey = form.invoice_no === initial.invoice_no && form.supplier_name === initial.supplier_name;
    const liveErrors = list.filter((i) => i.severity === 'error').length;
    (preview?.warnings || []).forEach((w) => {
      if (!NOTE_CODES.has(w.code)) return;
      // "could not be read" is only a problem until the person has filled the fields in by hand
      if (['unreadable', 'timeout', 'read_failed'].includes(w.code) && liveErrors === 0) {
        list.push({ field: w.field, severity: 'info', message: 'This bill could not be read automatically — the fields above were entered by you.', code: w.code });
        return;
      }
      if (w.code === 'duplicate' && !sameKey) return;                       // you changed the identity — server re-checks on save
      if (w.code === 'vendor_known_as' && vendor && form.supplier_name === vendor.supplier_name) return;
      if (w.code === 'company_not_matched' && form.company_id) return;
      list.push({ field: w.field, severity: w.severity, message: w.message, code: w.code });
    });
    const rank = { error: 0, warn: 1, info: 2 };
    return list.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  }, [form, preview, initial, vendor, wordsVal]);

  const errors = issues.filter((i) => i.severity === 'error');
  const warns = issues.filter((i) => i.severity === 'warn');
  const infos = issues.filter((i) => i.severity === 'info');
  const hasMismatch = issues.some((i) => i.code === 'mismatch');
  const hasDuplicate = issues.some((i) => i.code === 'duplicate') || serverErrors.some((e) => e.code === 'duplicate');
  const blockers = errors.filter((i) => !OVERRIDABLE.has(i.code) && i.code !== undefined && !['own_company_is_supplier', 'unreadable', 'timeout', 'read_failed'].includes(i.code));
  const canSave = !saving && blockers.length === 0 && (!hasMismatch || ackMismatch) && (!hasDuplicate || forceDup);

  const edited = useMemo(
    () => Object.keys(form).filter((k) => String(form[k] ?? '') !== String(initial[k] ?? '')),
    [form, initial],
  );

  const swapParties = () => setForm((f) => ({
    ...f, supplier_name: f.buyer_name, supplier_gstin: f.buyer_gstin, buyer_name: f.supplier_name, buyer_gstin: f.supplier_gstin,
  }));

  const save = async () => {
    setSaving(true); setServerErrors([]);
    try {
      const { data } = await api.post('/purchase-invoices/confirm', {
        ...formToPayload(form),
        file_name: extractedFile.name || file?.name || '',
        file_size: extractedFile.size || file?.size || 0,
        content_type: extractedFile.content_type || file?.type || '',
        extraction_method: preview?.extraction_method || '',
        parse_confidence: preview?.parse_confidence || 0,
        raw_text_excerpt: preview?.raw_text_excerpt || '',
        edited_fields: edited,
        ...(ledgerTouched && ledgerCode ? { expense_ledger_code: ledgerCode } : {}),
        force_duplicate: forceDup,
        acknowledge_mismatch: ackMismatch,
      });
      toast.success(`Added ${data.purchase_invoice.invoice_no} — ${data.purchase_invoice.supplier_name}`);
      (data.warnings || []).slice(0, 2).forEach((w) => toast.warning(w.message));
      onSaved?.(data.purchase_invoice);
    } catch (err) {
      const d = errorDetail(err);
      if (d?.code === 'duplicate') {
        setServerErrors([{ code: 'duplicate', message: d.message }]);
        toast.error(d.message);
      } else if (d?.errors) {
        setServerErrors(d.errors);
        toast.error(d.message || 'Please correct the highlighted fields');
      } else {
        toast.error(errorMessage(err, 'Could not save the bill'));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!preview) return null;
  const conf = Number(preview.parse_confidence || 0);
  const confTone = conf >= 0.9 ? 'bg-emerald-100 text-emerald-700' : conf >= 0.75 ? 'bg-sky-100 text-sky-700' : 'bg-amber-100 text-amber-800';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !saving) onClose?.(); }}>
      <DialogContent
        className={`sm:max-w-[1400px] w-[96vw] sm:w-[96vw] h-[92vh] p-0 gap-0 overflow-hidden flex flex-col ${isDark ? 'bg-slate-900 text-slate-100 border-slate-800' : 'bg-white text-slate-900'}`}
      >
        <DialogHeader className="px-5 pt-4 pb-3 border-b space-y-1" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle className="text-lg font-bold flex items-center gap-2">
              <FileText className="h-5 w-5" style={{ color: COLORS.mediumBlue }} />
              Check this bill before adding it
            </DialogTitle>
            {queue && <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">Bill {queue.index + 1} of {queue.total}</span>}
            <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${confTone}`}>
              Reading confidence: {CONFIDENCE_LABEL(conf)} ({Math.round(conf * 100)}%)
            </span>
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 inline-flex items-center gap-1">
              {preview.extraction_method?.includes('ai') ? <Sparkles className="h-3 w-3" /> : <ScanLine className="h-3 w-3" />}
              {METHOD_LABEL[preview.extraction_method] || preview.extraction_method}
            </span>
          </div>
          <DialogDescription className="text-xs">
            {extractedFile.name} · Compare with the document, fix anything that is wrong, then add it. Nothing is saved until you press <b>Add</b>.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 grid lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          {/* document */}
          <div className={`${showDoc ? 'block h-[55vh]' : 'hidden'} lg:block lg:h-auto border-b lg:border-b-0 lg:border-r min-h-0`} style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
            <DocumentPane file={file} rawText={preview.raw_text_excerpt} />
          </div>

          {/* form */}
          <div className="min-h-0 overflow-y-auto p-4 md:p-5 space-y-4">
            <button type="button" onClick={() => setShowDoc((v) => !v)} className="lg:hidden text-xs text-blue-600 inline-flex items-center gap-1">
              {showDoc ? <><EyeOff className="h-3.5 w-3.5" /> Hide document</> : <><Eye className="h-3.5 w-3.5" /> Show document</>}
            </button>

            {/* status banner */}
            <div className={`rounded-xl border p-3 text-sm ${errors.length ? 'border-red-300 bg-red-50 dark:bg-red-950/20'
              : warns.length ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/20' : 'border-emerald-300 bg-emerald-50 dark:bg-emerald-950/20'}`}>
              <div className="flex items-center gap-2 font-semibold">
                {errors.length ? <XCircle className="h-4 w-4 text-red-600" /> : warns.length ? <AlertTriangle className="h-4 w-4 text-amber-600" /> : <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                <span className={errors.length ? 'text-red-800 dark:text-red-300' : warns.length ? 'text-amber-800 dark:text-amber-300' : 'text-emerald-800 dark:text-emerald-300'}>
                  {errors.length ? `${errors.length} thing${errors.length > 1 ? 's' : ''} to fix`
                    : warns.length ? `${warns.length} thing${warns.length > 1 ? 's' : ''} to double-check` : 'Everything checks out'}
                  {infos.length > 0 && <span className="font-normal opacity-70"> · {infos.length} note{infos.length > 1 ? 's' : ''}</span>}
                </span>
              </div>
              {issues.length > 0 && (
                <ul className="mt-2 space-y-1 max-h-44 overflow-y-auto pr-1">
                  {issues.map((i, idx) => (
                    <li key={`${i.code}-${idx}`} className="text-xs flex gap-2 leading-snug">
                      {i.severity === 'error' ? <XCircle className="h-3.5 w-3.5 mt-px shrink-0 text-red-500" />
                        : i.severity === 'warn' ? <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0 text-amber-500" />
                          : <Info className="h-3.5 w-3.5 mt-px shrink-0 text-sky-500" />}
                      <span className="flex-1">
                        {i.message}
                        {i.code === 'vendor_known_as' && vendor && (
                          <button type="button" className="ml-2 underline text-blue-600" onClick={() => setForm((f) => ({ ...f, supplier_name: vendor.supplier_name }))}>
                            Use “{vendor.supplier_name}”
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                  {serverErrors.filter((e) => e.code !== 'duplicate').map((e, idx) => (
                    <li key={`srv-${idx}`} className="text-xs flex gap-2 text-red-700"><XCircle className="h-3.5 w-3.5 mt-px shrink-0" />{e.message}</li>
                  ))}
                </ul>
              )}
              {preview.advance_info && (
                <p className="text-xs mt-2 opacity-80">
                  Advance of ₹{fmtNum(preview.advance_info.advance)} already adjusted — balance payable ₹{fmtNum(preview.advance_info.balance)}. The register records the full invoice value.
                </p>
              )}
              {heads.length > 0 && (
                <label className="flex flex-wrap items-center gap-2 text-xs mt-2">
                  <span className="opacity-80">Expense head (Dr) · Accounts Payable (Cr):</span>
                  <select
                    value={form.company_id === preview.suggested?.company_id || ledgerTouched ? ledgerCode : ''}
                    onChange={(e) => { setLedgerCode(e.target.value); setLedgerTouched(true); }}
                    className="rounded border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2 py-1 text-xs max-w-[16rem]"
                    data-testid="expense-head-select"
                  >
                    <option value="">Let Finix choose</option>
                    {heads.map((h) => <option key={h.code} value={h.code}>{h.code} · {h.name}</option>)}
                  </select>
                  {ledgerTouched && ledgerCode && ledgerCode !== proposedHead && (
                    <span className="text-amber-700 dark:text-amber-400">Finix will remember this for this vendor.</span>
                  )}
                </label>
              )}
            </div>

            <InvoiceForm
              form={form}
              onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
              companies={companies}
              clients={clients}
              issues={[...issues, ...serverErrors.map((e) => ({ field: e.field, severity: 'error', message: e.message }))]}
              original={initial}
              isDark={isDark}
              onSwapParties={swapParties}
            />
          </div>
        </div>

        {/* footer */}
        <div className="px-5 py-3 border-t flex flex-col md:flex-row md:items-center justify-between gap-3" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
          <div className="flex flex-col gap-1 text-xs">
            {hasDuplicate && (
              <label className="inline-flex items-center gap-2 text-amber-700">
                <input type="checkbox" checked={forceDup} onChange={(e) => setForceDup(e.target.checked)} />
                This invoice is already in the register — add it again anyway
              </label>
            )}
            {hasMismatch && (
              <label className="inline-flex items-center gap-2 text-amber-700">
                <input type="checkbox" checked={ackMismatch} onChange={(e) => setAckMismatch(e.target.checked)} />
                I checked the document — the bill really adds up differently
              </label>
            )}
            {!hasDuplicate && !hasMismatch && edited.length > 0 && (
              <span className="text-slate-400">{edited.length} field{edited.length > 1 ? 's' : ''} corrected by you</span>
            )}
          </div>
          <div className="flex items-center justify-end gap-2">
            {file?.name && (
              <Button type="button" variant="ghost" size="sm" className="hidden md:inline-flex text-slate-500" onClick={() => { const u = URL.createObjectURL(file); window.open(u, '_blank'); }}>
                <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open original
              </Button>
            )}
            {queue && queue.total > 1 && (
              <Button variant="outline" className="rounded-xl" onClick={onSkip} disabled={saving}>Skip this bill</Button>
            )}
            <Button variant="outline" className="rounded-xl" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={!canSave} className="rounded-xl text-white" style={{ background: canSave ? COLORS.emeraldGreen : undefined }}>
              {saving ? <MiniLoader height={18} /> : <><Database className="h-4 w-4 mr-2" /> Add to Purchase Register</>}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
