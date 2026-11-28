// Reads an invoice list exported to Excel/CSV (rows already turned into arrays
// by SheetJS) into the payload /invoices/import-backup expects.
//
// Rules: columns are matched by their exact name (after trimming case and
// punctuation) so "Due Date" is never read as the balance and "GST" is never
// read as the client's GSTIN; the amounts, status and dates in the file are
// kept as written; nothing is guessed when the column exists.

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const COLUMNS = {
  invoice_no: ['invoice no', 'invoice number', 'invoice', 'inv no', 'invoice num', 'bill no', 'bill number', 'voucher no'],
  type:       ['type', 'invoice type', 'voucher type'],
  client:     ['client', 'client name', 'customer', 'customer name', 'party', 'party name', 'buyer'],
  company:    ['company', 'company name', 'firm', 'firm name', 'business', 'billed by', 'seller'],
  date:       ['date', 'invoice date', 'bill date', 'voucher date'],
  due_date:   ['due date', 'due on', 'payment due date'],
  taxable:    ['taxable', 'taxable value', 'taxable amount', 'sub total', 'subtotal'],
  gst:        ['gst', 'gst amount', 'total gst', 'tax', 'tax amount'],
  cgst:       ['cgst', 'cgst amount'],
  sgst:       ['sgst', 'sgst amount'],
  igst:       ['igst', 'igst amount'],
  total:      ['total', 'grand total', 'invoice total', 'total amount', 'amount', 'invoice amount', 'invoice value'],
  paid:       ['paid', 'amount paid', 'paid amount', 'received', 'amount received'],
  balance:    ['balance', 'balance due', 'amount due', 'due', 'outstanding', 'pending'],
  status:     ['status', 'payment status'],
  gstin:      ['gstin', 'client gstin', 'customer gstin', 'party gstin', 'gst no', 'gst number', 'gstin uin'],
  phone:      ['phone', 'mobile', 'phone no', 'mobile no', 'contact'],
  email:      ['email', 'email id', 'e mail'],
  address:    ['address', 'billing address'],
  state:      ['state', 'place of supply', 'supply state'],
  notes:      ['notes', 'description', 'remarks', 'narration'],
  terms:      ['payment terms', 'terms'],
  ref:        ['reference', 'reference no', 'ref', 'ref no', 'po', 'po no'],
};

const STATUS = {
  draft: 'draft', sent: 'sent', unpaid: 'sent', pending: 'sent', due: 'sent', issued: 'sent',
  paid: 'paid', received: 'paid', settled: 'paid', closed: 'paid',
  'partially paid': 'partially_paid', 'partially_paid': 'partially_paid', partial: 'partially_paid', 'part paid': 'partially_paid',
  overdue: 'overdue', cancelled: 'cancelled', canceled: 'cancelled', void: 'cancelled',
};

const TYPES = [
  [/proforma/, 'proforma'], [/estimate|quotation|quote/, 'estimate'],
  [/credit/, 'credit_note'], [/debit/, 'debit_note'],
];

const GST_SLABS = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 12, 18, 28, 40];

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Any date as it appears in Excel → "YYYY-MM-DD", or null when it isn't a date. */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v)) return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number' && isFinite(v) && v > 59 && v < 2958466) {        // Excel serial day
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/);        // 2026-11-24
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/);                 // 24/11/2026 (Indian order)
  if (m) return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-/ ]([a-z]{3})[a-z]*[-/ ,]+(\d{2}|\d{4})$/i);        // 24-Nov-2026
  if (m && MONTHS.includes(m[2].toLowerCase())) {
    return iso(m[3].length === 2 ? 2000 + +m[3] : +m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  }
  return null;
}

/** "₹ 1,23,456.50" → 123456.5; blank → null (so "not given" differs from 0). */
export function parseAmount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[₹,\s]|rs\.?|inr/gi, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s);
  const n = parseFloat(s.replace(/[()]/g, ''));
  return isNaN(n) ? null : (neg ? -n : n);
}

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const addDays = (isoDate, days) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + days * 86400000);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
};
const gstRate = (taxable, gst) => {
  if (!taxable || !gst) return 0;
  const raw = (gst / taxable) * 100;
  const slab = GST_SLABS.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
  return Math.abs(slab - raw) <= 0.5 ? slab : r2(raw);
};

function findHeader(rows) {
  const names = new Set(COLUMNS.invoice_no.concat(COLUMNS.client));
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if ((rows[i] || []).some((c) => names.has(norm(c)))) return i;
  }
  return 0;
}

/**
 * @param rows  array of row arrays (SheetJS sheet_to_json with header: 1)
 * @param today "YYYY-MM-DD", used only when a row has no readable date
 * @returns {{ invoices: object[], skipped: {row:number, reason:string}[], warnings: string[], columns: string[] }}
 */
export function parseInvoiceRows(rows, today) {
  const headerIdx = findHeader(rows);
  const headers = (rows[headerIdx] || []).map(norm);
  const idx = {};
  for (const [key, aliases] of Object.entries(COLUMNS)) {
    // First alias that matches wins, so "Invoice No" beats a later "Invoice".
    for (const a of aliases) {
      const i = headers.indexOf(a);
      if (i >= 0 && !Object.values(idx).includes(i)) { idx[key] = i; break; }
    }
  }
  const has = (k) => idx[k] !== undefined;
  const warnings = [];
  const skipped = [];
  const invoices = [];

  rows.slice(headerIdx + 1).forEach((row, n) => {
    const excelRow = headerIdx + n + 2;
    if (!row || !row.some((c) => c !== '' && c !== null && c !== undefined)) return;
    const raw = (k) => (has(k) ? row[idx[k]] : undefined);
    const text = (k) => { const v = raw(k); return v === undefined || v === null ? '' : String(v).trim(); };
    const num = (k) => parseAmount(raw(k));

    const invoiceNo = text('invoice_no');
    const clientName = text('client');
    if (!invoiceNo && !clientName) { skipped.push({ row: excelRow, reason: 'no invoice number or client' }); return; }

    let invDate = parseDate(raw('date'));
    if (!invDate) {
      if (text('date')) warnings.push(`Row ${excelRow}: could not read date "${text('date')}", used ${today}`);
      invDate = today;
    }
    const dueDate = parseDate(raw('due_date')) || addDays(invDate, 30);

    let taxable = num('taxable');
    let cgst = num('cgst'), sgst = num('sgst'), igst = num('igst');
    let gst = num('gst');
    if (gst === null && (cgst !== null || sgst !== null || igst !== null)) gst = (cgst || 0) + (sgst || 0) + (igst || 0);
    let total = num('total');

    if (taxable === null && gst === null) {
      // Nothing about tax in the file: old behaviour, assume 18% is inside the total.
      total = total || 0;
      taxable = r2(total / 1.18);
      gst = r2(total - taxable);
    } else {
      if (taxable === null) taxable = r2((total || 0) - (gst || 0));
      if (gst === null) gst = total !== null ? Math.max(r2(total - taxable), 0) : 0;
      if (total === null) total = r2(taxable + gst);
    }
    if (cgst === null && sgst === null && igst === null) {
      igst = 0;
      cgst = r2(gst / 2);
      sgst = r2(gst - cgst);
    }
    cgst = cgst || 0; sgst = sgst || 0; igst = igst || 0;
    const rate = gstRate(taxable, gst);
    const interstate = igst > 0 && cgst === 0 && sgst === 0;

    let paid = num('paid');
    let balance = num('balance');
    if (paid === null && balance === null) { paid = 0; balance = total; }
    else if (paid === null) paid = r2(total - balance);
    else if (balance === null) balance = Math.max(r2(total - paid), 0);

    let status = STATUS[norm(text('status'))] || STATUS[text('status').toLowerCase()];
    if (!status) {
      if (text('status')) warnings.push(`Row ${excelRow}: unknown status "${text('status')}", worked out from the amounts`);
      status = balance <= 0 && total > 0 ? 'paid' : paid > 0 && balance > 0 ? 'partially_paid' : balance > 0 ? 'sent' : 'draft';
    }

    const typeText = norm(text('type'));
    const invoiceType = (TYPES.find(([re]) => re.test(typeText)) || [null, 'tax_invoice'])[1];
    const notes = text('notes');
    const half = r2(rate / 2);

    invoices.push({
      source_row:     excelRow,
      company_label:  text('company'),
      invoice_type:   invoiceType,
      invoice_no:     invoiceNo,
      client_name:    clientName || 'Unknown',
      client_email:   text('email'),
      client_phone:   text('phone'),
      client_gstin:   text('gstin'),
      client_address: text('address'),
      client_state:   text('state'),
      invoice_date:   invDate,
      due_date:       dueDate,
      reference_no:   text('ref'),
      notes,
      payment_terms:  text('terms') || 'Imported',
      is_interstate:  interstate,
      items: [{
        description:   notes || `Import – ${invoiceNo || clientName}`,
        hsn_sac:       '',
        quantity:      1,
        unit:          'service',
        unit_price:    taxable,
        discount_pct:  0,
        gst_rate:      rate,
        taxable_value: taxable,
        cgst_rate:     interstate ? 0 : half,
        sgst_rate:     interstate ? 0 : half,
        igst_rate:     interstate ? rate : 0,
        cgst_amount:   cgst,
        sgst_amount:   sgst,
        igst_amount:   igst,
        total_amount:  total,
      }],
      subtotal:         taxable,
      total_taxable:    taxable,
      total_cgst:       cgst,
      total_sgst:       sgst,
      total_igst:       igst,
      total_gst:        r2(gst),
      grand_total:      total,
      amount_paid:      paid,
      amount_due:       balance,
      status,
      discount_amount:  0,
      shipping_charges: 0,
      other_charges:    0,
    });
  });

  return { invoices, skipped, warnings, columns: Object.keys(idx) };
}

/** Best match of a "Company" value from the file to one of the app's companies. */
export function matchCompany(label, companies) {
  const l = norm(label);
  if (!l) return '';
  const list = (companies || []).map((c) => ({ id: c.id, n: norm(c.name) }));
  const exact = list.find((c) => c.n === l);
  if (exact) return exact.id;
  const strip = (s) => s.replace(/\b(private|pvt|limited|ltd|llp|and|co|the)\b/g, '').replace(/\s+/g, ' ').trim();
  const sl = strip(l);
  const loose = list.filter((c) => sl && (strip(c.n) === sl || strip(c.n).includes(sl) || sl.includes(strip(c.n))));
  return loose.length === 1 ? loose[0].id : '';
}
