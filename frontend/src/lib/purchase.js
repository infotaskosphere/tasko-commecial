// purchase.js — shared helpers for the Purchase Register screens
// (Purchase.jsx, InvoicePreviewDialog.jsx, InvoiceForm.jsx, ExportDialog.jsx).
import { format, parseISO, startOfMonth, endOfMonth, subMonths } from 'date-fns';

export const COLORS = {
  deepBlue: '#0D3B66',
  mediumBlue: '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber: '#F59E0B',
  coral: '#FF6B6B',
};

export const PURCHASE_STATUS_META = {
  outstanding:    { label: 'Outstanding',    bg: '#FEF3C7', fg: '#B45309', border: '#FDE68A' },
  partially_paid: { label: 'Partially Paid', bg: '#DBEAFE', fg: '#1D4ED8', border: '#BFDBFE' },
  paid:           { label: 'Paid',           bg: '#DCFCE7', fg: '#15803D', border: '#BBF7D0' },
  cancelled:      { label: 'Cancelled',      bg: '#F1F5F9', fg: '#64748B', border: '#E2E8F0' },
};

export const SORT_OPTIONS = [
  { value: 'invoice_date', label: 'Invoice date' },
  { value: 'created_at', label: 'Date added' },
  { value: 'supplier_name', label: 'Supplier' },
  { value: 'invoice_no', label: 'Invoice no.' },
  { value: 'grand_total', label: 'Invoice total' },
  { value: 'total_gst', label: 'GST amount' },
  { value: 'taxable_amount', label: 'Taxable value' },
  { value: 'amount_due', label: 'Balance due' },
  { value: 'status', label: 'Status' },
];

export const SOURCE_OPTIONS = [
  { value: 'all', label: 'Any source' },
  { value: 'upload', label: 'Uploaded bill' },
  { value: 'manual', label: 'Entered manually' },
  { value: 'gstr2b', label: 'GSTR-2B import' },
];

export const EMPTY_FILTERS = {
  search: '',
  company_id: 'all',
  client_id: 'all',
  status: [],            // [] = every status
  supplier: 'all',
  date_from: '',
  date_to: '',
  amount_min: '',
  amount_max: '',
  ledger: 'all',
  source: 'all',
  tally: 'all',          // all | exported | pending
  review: 'all',         // all | yes
  gst_type: 'all',       // all | igst | cgst_sgst | none
};

export const fmtC = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
export const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtDate = (value) => {
  if (!value) return '—';
  try { return format(parseISO(String(value).slice(0, 10)), 'dd MMM yyyy'); } catch { return value; }
};

export const r2 = (x) => Math.round((Number(x) + Number.EPSILON) * 100) / 100;
export const num = (x) => {
  const v = parseFloat(x);
  return Number.isFinite(v) ? v : 0;
};

/** Register filters → query params the backend understands (empty / "all" values are dropped). */
export function buildPurchaseParams(f, extra = {}) {
  const p = {};
  const put = (k, v) => { if (v !== '' && v !== null && v !== undefined && v !== 'all') p[k] = v; };
  put('search', (f.search || '').trim());
  put('company_id', f.company_id);
  put('client_id', f.client_id);
  if (Array.isArray(f.status) && f.status.length) p.status = f.status.join(',');
  put('supplier', f.supplier);
  put('date_from', f.date_from);
  put('date_to', f.date_to);
  put('amount_min', f.amount_min);
  put('amount_max', f.amount_max);
  put('ledger', f.ledger);
  put('source', f.source);
  put('tally', f.tally);
  put('review', f.review);
  put('gst_type', f.gst_type);
  return { ...p, ...extra };
}

/** Filters shaped for the export endpoint body (same keys as the list params, minus paging / sorting). */
export function exportFilters(f) {
  return buildPurchaseParams(f);
}

/** How many filters are switched on (the search box counts too). */
export function activeFilterCount(f) {
  return Object.keys(buildPurchaseParams(f)).length;
}

/** Date presets for the register (Indian financial year: 1 Apr – 31 Mar). */
export function datePresets(today = new Date()) {
  const iso = (d) => format(d, 'yyyy-MM-dd');
  const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  // Indian FY quarters (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) are plain calendar quarters.
  const qStart = new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1);
  const qEnd = new Date(qStart.getFullYear(), qStart.getMonth() + 3, 0);
  const lastMonth = subMonths(today, 1);
  return [
    { key: 'this_month', label: 'This month', from: iso(startOfMonth(today)), to: iso(endOfMonth(today)) },
    { key: 'last_month', label: 'Last month', from: iso(startOfMonth(lastMonth)), to: iso(endOfMonth(lastMonth)) },
    { key: 'this_quarter', label: 'This quarter', from: iso(qStart), to: iso(qEnd) },
    { key: 'this_fy', label: `FY ${fyStartYear}-${String(fyStartYear + 1).slice(2)}`, from: `${fyStartYear}-04-01`, to: `${fyStartYear + 1}-03-31` },
    { key: 'last_fy', label: `FY ${fyStartYear - 1}-${String(fyStartYear).slice(2)}`, from: `${fyStartYear - 1}-04-01`, to: `${fyStartYear}-03-31` },
  ];
}

/** Turn any API error (including a JSON error returned for a blob download) into a readable string. */
export function errorMessage(err, fallback = 'Something went wrong') {
  const d = err?.response?.data;
  if (!d) return err?.message === 'Network Error' ? 'Cannot reach the server. Check your connection and try again.' : (err?.message || fallback);
  if (typeof d === 'string') return d || fallback;
  const detail = d.detail ?? d.message ?? d;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((x) => (typeof x === 'string' ? x : x?.msg || x?.message || '')).filter(Boolean).join('; ') || fallback;
  }
  return detail?.message || fallback;
}

/** Same as errorMessage, but understands a Blob body (axios returns errors of blob downloads as Blobs). */
export async function errorMessageAsync(err, fallback = 'Something went wrong') {
  const d = err?.response?.data;
  if (typeof Blob !== 'undefined' && d instanceof Blob) {
    try {
      const parsed = JSON.parse(await d.text());
      return errorMessage({ response: { data: parsed } }, fallback);
    } catch { return fallback; }
  }
  return errorMessage(err, fallback);
}

/** Structured error detail ({code, message, ...}) when the backend sent one. */
export function errorDetail(err) {
  const d = err?.response?.data?.detail;
  return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function filenameFromDisposition(header, fallback) {
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header || '');
  return m ? decodeURIComponent(m[1]) : fallback;
}

/** Remember small UI preferences (never throws: storage can be blocked). */
export function loadPref(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch { return fallback; }
}
export function savePref(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

// ─────────────────────────────────────────────────────────────
// Live checks used by the editable preview and the Edit dialog.
// They mirror the server's validation so a mistake is flagged while
// the person is still typing, not after they press Save.
// ─────────────────────────────────────────────────────────────

const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const OIDAR_RE = /^99\d{2}[A-Z]{3}\d{5}[A-Z]{3}$/;
const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function gstinFormatOk(g) {
  const v = (g || '').trim().toUpperCase();
  return GSTIN_RE.test(v) || OIDAR_RE.test(v);
}

export function gstinChecksumOk(g) {
  const v = (g || '').trim().toUpperCase();
  if (!GSTIN_RE.test(v)) return false;
  let factor = 2; let total = 0;
  for (let i = 13; i >= 0; i -= 1) {
    const d = factor * CHARS.indexOf(v[i]);
    factor = factor === 2 ? 1 : 2;
    total += Math.floor(d / 36) + (d % 36);
  }
  return CHARS[(36 - (total % 36)) % 36] === v[14];
}

export function gstComponentsTotal(f) {
  return r2(num(f.cgst_amount) + num(f.sgst_amount) + num(f.igst_amount) + num(f.cess_amount));
}

/** Totals check: taxable + GST + round-off must equal the invoice total (±₹1). */
export function computeChecks(f) {
  const comps = gstComponentsTotal(f);
  const gst = comps > 0 ? comps : r2(num(f.total_gst));
  const sum = r2(num(f.taxable_amount) + gst + num(f.round_off));
  const total = r2(num(f.grand_total));
  const diff = r2(total - sum);
  return {
    gst, sum, total, diff,
    ok: total > 0 && Math.abs(diff) <= 1.0,
    // one-click repairs, each only offered when it is plausible
    fixTotal: sum > 0 ? sum : null,
    fixTaxable: r2(total - gst - num(f.round_off)) > 0 ? r2(total - gst - num(f.round_off)) : null,
    fixRound: Math.abs(r2(total - num(f.taxable_amount) - gst)) <= 1.0 ? r2(total - num(f.taxable_amount) - gst) : null,
    ratePct: num(f.taxable_amount) > 0 ? r2((gst / num(f.taxable_amount)) * 100) : null,
  };
}

/** Field-level problems for the current form values: [{field, severity:'error'|'warn'|'info', message}] */
export function liveIssues(f, { requireCompany = true } = {}) {
  const out = [];
  const add = (field, severity, message, code) => out.push({ field, severity, message, code });
  if (requireCompany && !f.company_id) add('company_id', 'error', 'Pick the company this purchase belongs to.', 'company');
  if (!(f.supplier_name || '').trim()) add('supplier_name', 'error', 'Supplier name is required.', 'supplier');
  if (!(f.invoice_no || '').trim()) add('invoice_no', 'error', 'Invoice number is required.', 'invoice_no');
  if (!f.invoice_date) add('invoice_date', 'error', 'Invoice date is required.', 'date');
  else if (!Number.isNaN(Date.parse(f.invoice_date))) {
    const dd = new Date(f.invoice_date);
    const days = (dd.getTime() - Date.now()) / 86400000;
    if (days > 7) add('invoice_date', 'warn', 'Invoice date is in the future.', 'future');
    if (days < -1096) add('invoice_date', 'warn', 'Invoice date is more than 3 years old.', 'old');
  }
  if (num(f.grand_total) <= 0) add('grand_total', 'error', 'Invoice total must be greater than zero.', 'total');
  ['taxable_amount', 'cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount'].forEach((k) => {
    if (num(f[k]) < 0) add(k, 'error', 'Cannot be negative.', 'neg');
  });
  const sg = (f.supplier_gstin || '').trim().toUpperCase();
  const bg = (f.buyer_gstin || '').trim().toUpperCase();
  if (sg && !gstinFormatOk(sg)) add('supplier_gstin', 'error', 'Not a valid 15-character GSTIN.', 'gstin');
  else if (sg && GSTIN_RE.test(sg) && !gstinChecksumOk(sg)) add('supplier_gstin', 'warn', 'Fails the GST check-digit — a character is probably wrong.', 'gstin_cs');
  if (bg && !gstinFormatOk(bg)) add('buyer_gstin', 'error', 'Not a valid 15-character GSTIN.', 'gstin');
  else if (bg && GSTIN_RE.test(bg) && !gstinChecksumOk(bg)) add('buyer_gstin', 'warn', 'Fails the GST check-digit — a character is probably wrong.', 'gstin_cs');
  if (sg && sg === bg) add('buyer_gstin', 'error', 'Supplier and buyer GSTIN are the same.', 'same');
  const c = computeChecks(f);
  if (num(f.grand_total) > 0 && !c.ok) {
    add('grand_total', 'error', `Taxable + GST + round-off = ₹${fmtNum(c.sum)}, but the total is ₹${fmtNum(c.total)} (off by ₹${fmtNum(Math.abs(c.diff))}).`, 'mismatch');
  }
  const cg = num(f.cgst_amount); const sgst = num(f.sgst_amount); const ig = num(f.igst_amount);
  if ((cg || sgst) && ig) add('igst_amount', 'warn', 'IGST and CGST/SGST are both filled — a bill normally has one or the other.', 'mixed');
  if (cg && sgst && Math.abs(cg - sgst) > 0.02) add('sgst_amount', 'warn', 'CGST and SGST differ — they are normally equal.', 'unequal');
  const ss = sg.slice(0, 2); const bs = bg.slice(0, 2);
  if (/^\d\d$/.test(ss) && /^\d\d$/.test(bs) && c.gst > 0) {
    if (ss === bs && ig > 0 && !(cg || sgst)) add('igst_amount', 'warn', 'Same state for supplier and buyer, but IGST is charged.', 'state');
    if (ss !== bs && (cg || sgst) && !ig) add('cgst_amount', 'warn', 'Different states for supplier and buyer, but CGST/SGST is charged.', 'state');
  }
  return out;
}

export const CONFIDENCE_LABEL = (c) => (c >= 0.9 ? 'High' : c >= 0.75 ? 'Good' : c >= 0.5 ? 'Low' : 'Very low');

export const METHOD_LABEL = {
  text: 'Read from the PDF text',
  ocr: 'Read from a scan (OCR)',
  ai: 'Read by AI from the page image',
  'text+ai': 'PDF text, checked by AI',
  'ocr+ai': 'Scan (OCR), checked by AI',
  manual: 'Entered manually',
  none: 'Could not be read automatically',
};
