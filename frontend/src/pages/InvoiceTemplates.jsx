/**
 * InvoiceTemplates.jsx  —  v3.1  BUGS FIXED
 *
 * FIXES:
 *  1. signRow() was missing its closing brace — function body never closed
 *  2. wordsBox() used nested backtick template literals inside ${} — replaced with string concatenation
 *  3. itemsTableHTML() had nested backticks inside map() — replaced with string concatenation
 *  4. bankQrHTML() had nested backticks — replaced with string concatenation
 *  5. All other nested backtick patterns cleaned throughout
 *
 * Exports:
 *   COLOR_THEMES, INVOICE_TEMPLATES
 *   generateInvoiceHTML(), openInvoicePrint()
 *   InvoiceDesignModal
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input }  from '@/components/ui/input';
import { X, Printer, Eye, Check, Palette, Layout } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// 1. COLOR THEMES  — IDs match Invoicing.jsx invoice_theme field
// ═══════════════════════════════════════════════════════════════

export const COLOR_THEMES = [
  { id: 'classic_blue', name: 'Classic Blue',   primary: '#0D3B66', secondary: '#1F6FB2', light: '#EFF6FF', accent: '#BFDBFE' },
  { id: 'emerald',      name: 'Emerald',         primary: '#065f46', secondary: '#059669', light: '#ECFDF5', accent: '#6EE7B7' },
  { id: 'purple',       name: 'Royal Purple',    primary: '#4c1d95', secondary: '#7c3aed', light: '#F5F3FF', accent: '#DDD6FE' },
  { id: 'coral',        name: 'Coral Sunrise',   primary: '#7c2d12', secondary: '#ea580c', light: '#FFF7ED', accent: '#FED7AA' },
  { id: 'teal',         name: 'Deep Teal',       primary: '#134e4a', secondary: '#0d9488', light: '#F0FDFA', accent: '#99F6E4' },
  { id: 'slate',        name: 'Slate Pro',       primary: '#1e293b', secondary: '#475569', light: '#F8FAFC', accent: '#CBD5E1' },
  { id: 'rose',         name: 'Rose Gold',       primary: '#881337', secondary: '#e11d48', light: '#FFF1F2', accent: '#FECDD3' },
  { id: 'amber',        name: 'Amber Gold',      primary: '#78350f', secondary: '#d97706', light: '#FFFBEB', accent: '#FDE68A' },
];

// ═══════════════════════════════════════════════════════════════
// 2. TEMPLATE METADATA
// ═══════════════════════════════════════════════════════════════

export const INVOICE_TEMPLATES = [
  { id:'classic',      name:'Classic',       desc:'Solid colour header bar, logo left, invoice number right.',          badge:'Default',  thermal:false },
  { id:'theme2',       name:'Theme 2',        desc:'Two-row compact header. Company strip on top, meta row below.',      badge:'Clean',    thermal:false },
  { id:'theme3',       name:'Theme 3',        desc:'Fully bordered box header — company left, invoice details right.',   badge:'Boxed',    thermal:false },
  { id:'theme4',       name:'Theme 4',        desc:'Centered company details with large coloured invoice banner.',       badge:'Centred',  thermal:false },
  { id:'theme5',       name:'Theme 5',        desc:'Wide colour stripe with three floating info cards underneath.',      badge:'Cards',    thermal:false },
  { id:'theme6',       name:'Theme 6',        desc:'Full-width gradient hero, circular logo, three shadow cards.',      badge:'Gradient', thermal:false },
  { id:'theme7',       name:'Theme 7',        desc:'Coloured left sidebar with logo + client + bank details.',          badge:'Sidebar',  thermal:false },
  { id:'theme8',       name:'Theme 8',        desc:'Ultra-minimal white with colour accent strip.',                     badge:'Minimal',  thermal:false },
  { id:'frenchelite',  name:'French Elite',   desc:'Premium amber double-rule border, elegant two-zone header.',        badge:'Elite \u2605',  thermal:false },
  { id:'doubledivine', name:'Double Divine',  desc:'Two equal coloured panels side-by-side in header.',                badge:'Divine \u2605', thermal:false },
  { id:'gsttheme1',    name:'GST Theme 1',    desc:'GSTIN-emphasis layout with separate HSN summary table.',           badge:'GST',      thermal:false },
  { id:'tallytheme',   name:'Tally Theme',    desc:'Tally-style monochrome accounting layout.',                        badge:'Tally',    thermal:false },
  { id:'thermal1',     name:'Thermal 1',      desc:'58mm/80mm thermal roll — compact single column.',                  badge:'Thermal',  thermal:true  },
  { id:'thermal2',     name:'Thermal 2',      desc:'80mm thermal roll — bold company name, QR, itemised totals.',      badge:'Thermal',  thermal:true  },
];

// ═══════════════════════════════════════════════════════════════
// 3. CALCULATION ENGINE
// ═══════════════════════════════════════════════════════════════

function computeItem(item, isInter) {
  const qty     = parseFloat(item.quantity)    || 0;
  const price   = parseFloat(item.unit_price)  || 0;
  const discPct = parseFloat(item.discount_pct)|| 0;
  const gstRate = parseFloat(item.gst_rate)    || 0;
  const disc    = price * qty * discPct / 100;
  const taxable = Math.round((price * qty - disc) * 100) / 100;
  if (isInter) {
    const igst = Math.round(taxable * gstRate / 100 * 100) / 100;
    return { ...item, taxable_value: taxable, cgst_rate: 0, sgst_rate: 0, igst_rate: gstRate,
      cgst_amount: 0, sgst_amount: 0, igst_amount: igst,
      total_amount: Math.round((taxable + igst) * 100) / 100 };
  } else {
    const half = gstRate / 2;
    const cgst = Math.round(taxable * half / 100 * 100) / 100;
    const sgst = Math.round(taxable * half / 100 * 100) / 100;
    return { ...item, taxable_value: taxable, cgst_rate: half, sgst_rate: half, igst_rate: 0,
      cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0,
      total_amount: Math.round((taxable + cgst + sgst) * 100) / 100 };
  }
}

function recomputeTotals(inv) {
  const isInter = inv.is_interstate || false;
  const items   = (inv.items || []).map(it => computeItem(it, isInter));
  const subtotal      = items.reduce((s, i) => s + parseFloat(i.unit_price || 0) * parseFloat(i.quantity || 0), 0);
  const totalDiscount = items.reduce((s, i) => s + parseFloat(i.unit_price || 0) * parseFloat(i.quantity || 0) * (parseFloat(i.discount_pct || 0) / 100), 0)
                      + parseFloat(inv.discount_amount || 0);
  const totalTaxable  = items.reduce((s, i) => s + (i.taxable_value || 0), 0);
  const totalCGST     = items.reduce((s, i) => s + (i.cgst_amount   || 0), 0);
  const totalSGST     = items.reduce((s, i) => s + (i.sgst_amount   || 0), 0);
  const totalIGST     = items.reduce((s, i) => s + (i.igst_amount   || 0), 0);
  const totalGST      = Math.round((totalCGST + totalSGST + totalIGST) * 100) / 100;
  const shipping      = parseFloat(inv.shipping_charges || 0);
  const other         = parseFloat(inv.other_charges    || 0);
  const grandTotal    = Math.round((totalTaxable + totalGST + shipping + other - parseFloat(inv.discount_amount || 0)) * 100) / 100;
  // Use the larger of amount_paid / advance_received so Balance Due is always
  // grand_total minus what has actually been received (advance counts as paid).
  const advanceReceived = parseFloat(inv.advance_received || 0);
  const rawAmountPaid   = parseFloat(inv.amount_paid || 0);
  const amountPaid      = Math.max(rawAmountPaid, advanceReceived);
  const amountDue       = Math.max(Math.round((grandTotal - amountPaid) * 100) / 100, 0);
  return { ...inv, items,
    subtotal:       Math.round(subtotal      * 100) / 100,
    total_discount: Math.round(totalDiscount * 100) / 100,
    total_taxable:  Math.round(totalTaxable  * 100) / 100,
    total_cgst:     Math.round(totalCGST     * 100) / 100,
    total_sgst:     Math.round(totalSGST     * 100) / 100,
    total_igst:     Math.round(totalIGST     * 100) / 100,
    total_gst: totalGST, grand_total: grandTotal,
    amount_paid: amountPaid, amount_due: amountDue };
}

// ═══════════════════════════════════════════════════════════════
// 4. UTILITIES
// ═══════════════════════════════════════════════════════════════

const fmtN = (n) => new Intl.NumberFormat('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2}).format(n??0);
const fmtC = (n) => '\u20B9' + fmtN(n);

function amountToWords(amount) {
  const num = Math.round(amount);
  if (num === 0) return 'Zero Rupees Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function conv(n) {
    if (n === 0) return '';
    if (n < 20) return ones[n] + ' ';
    if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? ' '+ones[n%10] : '') + ' ';
    return ones[Math.floor(n/100)] + ' Hundred ' + conv(n%100);
  }
  const cr=Math.floor(num/10000000),lk=Math.floor((num%10000000)/100000),th=Math.floor((num%100000)/1000),re=num%1000;
  let r = '';
  if (cr) r += conv(cr) + 'Crore ';
  if (lk) r += conv(lk) + 'Lakh ';
  if (th) r += conv(th) + 'Thousand ';
  if (re) r += conv(re);
  return r.trim() + ' Rupees Only';
}

function getThemeColor(selectedTheme, customColor) {
  if (selectedTheme === 'custom') return { id:'custom', name:'Custom', primary: customColor, secondary: customColor, light:'#F8FAFC', accent:'#CBD5E1' };
  return COLOR_THEMES.find(t => t.id === selectedTheme) || COLOR_THEMES[0];
}

// ═══════════════════════════════════════════════════════════════
// 5. LOGO HELPER
// ═══════════════════════════════════════════════════════════════

function getLogoHTML(company, theme, size, shape, variant) {
  size   = size   || 52;
  shape  = shape  || 'rounded';
  variant= variant|| 'on-white';
  const rawName = ((company && company.name) || 'CO').trim();
  const words   = rawName.split(/\s+/);
  const initials= words.length >= 2 ? (words[0][0]+words[words.length-1][0]).toUpperCase() : rawName.slice(0,2).toUpperCase();
  const r       = shape==='circle' ? size/2 : shape==='sharp' ? 3 : size*0.22;
  const bgFill  = variant==='on-color' ? 'rgba(255,255,255,0.20)' : theme.primary;
  const rimColor= variant==='on-color' ? 'rgba(255,255,255,0.40)' : theme.secondary;
  const fs      = size*0.37;
  if ((company && company.logo_url) || (company && company.logo_base64)) {
    const src = company.logo_base64 || company.logo_url;
    const f   = variant==='on-color' ? 'brightness(0) invert(1)' : 'none';
    const blendStyle = variant==='on-white' ? 'mix-blend-mode:multiply;background:white;' : '';
    return '<img src="' + src + '" alt="' + rawName + '" style="height:' + size + 'px;width:auto;max-width:' + (size*3) + 'px;object-fit:contain;filter:' + f + ';display:block;' + blendStyle + '"/>';
  }
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" xmlns="http://www.w3.org/2000/svg" style="display:block;flex-shrink:0;">'
    + '<rect width="' + size + '" height="' + size + '" rx="' + r + '" fill="' + bgFill + '"/>'
    + '<rect x="2.5" y="2.5" width="' + (size-5) + '" height="' + (size-5) + '" rx="' + Math.max(r-2,1) + '" fill="none" stroke="' + rimColor + '" stroke-width="1.5"/>'
    + '<text x="' + (size/2) + '" y="' + (size/2+fs*0.38) + '" text-anchor="middle" font-family="\'Segoe UI\',Arial,sans-serif" font-weight="900" font-size="' + fs + '" fill="white" letter-spacing="1">' + initials + '</text>'
    + '</svg>';
}

// ═══════════════════════════════════════════════════════════════
// 6. QR CODE HELPER
// ═══════════════════════════════════════════════════════════════

function buildUpiUrl(company, inv) {
  if (!company || !company.upi_id) return '';
  const hasExplicitDue = inv && inv.amount_due != null;
  const pendingAmount = parseFloat((hasExplicitDue ? inv.amount_due : (inv && inv.grand_total)) || 0);
  if (!Number.isFinite(pendingAmount) || pendingAmount <= 0) return '';
  
  // Clean payee name: replace '&' with 'and', allow only letters, numbers, spaces, dots, and hyphens.
  // UPI apps do not URL-decode parameters scanned from QR codes, so having double-encoded or % encoded
  // characters (like %20 or %26) in the URI causes validation to fail with "Payment is restricted".
  let rawName = (company && (company.company_name || company.name)) || 'Merchant';
  rawName = rawName.replace(/&/g, 'and');
  rawName = rawName.replace(/[^a-zA-Z0-9\s.\-]/g, '');
  rawName = rawName.replace(/\s+/g, ' ').trim();
  
  // A malformed VPA produces a QR that can look valid but is rejected by the
  // receiving bank. Keep the VPA intact (including its case), but reject
  // whitespace and characters that are not valid in a UPI ID.
  const pa = String(company.upi_id).trim().replace(/\s+/g, '');
  if (!/^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9.-]{2,64}$/.test(pa)) return '';
  
  // UPI apps and the bank switch use the transaction reference to identify a
  // merchant collection. Keep it short and deterministic so rescanning the
  // same invoice does not create a different payment request.
  let reference = String((inv && inv.invoice_no) || 'Invoice');
  reference = reference.replace(/[^a-zA-Z0-9.\-]/g, '').slice(0, 35) || 'Invoice';
  const rawTn = ('Invoice ' + reference).slice(0, 80);
  
  const am = pendingAmount > 0 ? '&am=' + pendingAmount.toFixed(2) : '';

  // Merchant Category Code: tags this as a merchant (P2M) transaction rather than a
  // generic P2P transfer, matching how a bank-issued merchant QR is classified.
  // Only included if the company has one on file (set in Invoice/Quotation Settings).
  const mcRaw = (company.upi_mcc || '').trim();
  const mc = mcRaw ? '&mc=' + mcRaw.replace(/[^0-9]/g, '') : '';

  // Keep the values compatible with UPI intent parsers: no percent-encoding
  // inside the payload (the complete URI is encoded once by getQrHTML).
  return 'upi://pay?pa=' + pa
    + '&pn=' + rawName
    + mc
    + '&tr=' + reference
    + '&tn=' + rawTn
    + am
    + '&cu=INR';
}

// Preferred entry point for rendering a payment QR on an invoice. If the company has
// uploaded their bank's own registered Merchant/UPI QR image (e.g. YONO SBI, BHIM SBI
// Pay), that image is used as-is — bank-issued merchant QRs are pre-vetted P2M
// transactions and far less prone to being declined by the receiving bank than a QR we
// build ourselves from a raw upi://pay link. Falls back to the dynamic link-based QR
// (with amount pre-filled) when no bank QR image has been uploaded for the company.
function getPaymentQrHTML(company, inv, size, label) {
  size = size || 90;
  if (!company) return '';
  const hasExplicitDue = inv && inv.amount_due != null;
  const pendingAmount = Number(hasExplicitDue ? inv.amount_due : (inv && inv.grand_total));
  // Never display a payable QR for an already-settled invoice. A QR without
  // an amount is especially risky because a payer may submit a duplicate
  // payment and the receiving bank can refund or decline it.
  if (!Number.isFinite(pendingAmount) || pendingAmount <= 0) return '';
  const bankQrImage = company.upi_qr_image_base64 || company.upi_qr_image_url;
  if (bankQrImage) {
    const lbl = label || 'Scan to Pay via UPI';
    return '<div style="text-align:center;flex-shrink:0">'
      + '<img src="' + bankQrImage + '" alt="UPI QR" style="width:' + size + 'px;height:' + size + 'px;display:block;object-fit:contain;border-radius:4px;border:1px solid #E0E0E0;margin:0 auto"/>'
      + '<div style="font-size:8px;color:#9E9E9E;margin-top:3px;line-height:1.3">' + lbl + '</div>'
      + '<div style="font-size:7px;color:#BDBDBD;margin-top:1px;line-height:1.3;max-width:' + (size+30) + 'px">Enter the amount shown above after scanning</div>'
      + '</div>';
  }
  return getQrHTML(buildUpiUrl(company, inv), size, label);
}

function getQrHTML(upiUrl, size, label) {
  size  = size  || 90;
  label = label || 'Scan to Pay (Balance Due)';
  if (!upiUrl) return '';
  const enc = encodeURIComponent(upiUrl);
  // Note: occasionally a UPI app shows "Receiver's bank does not allow payments to this
  // bank account" - this is a transient decline from the RECEIVING bank/NPCI switch, not
  // a problem with this QR's data (retrying the exact same QR moments later typically
  // succeeds). The line below sets that expectation so payers don't assume the QR is broken.
  return '<div style="text-align:center;flex-shrink:0">'
    + '<img src="https://api.qrserver.com/v1/create-qr-code/?data=' + enc + '&size=' + size + 'x' + size + '&qzone=1&margin=0"'
    + ' alt="UPI QR" style="width:' + size + 'px;height:' + size + 'px;display:block;border-radius:4px;border:1px solid #E0E0E0;margin:0 auto"/>'
    + '<div style="font-size:8px;color:#9E9E9E;margin-top:3px;line-height:1.3">' + label + '</div>'
    + '<div style="font-size:7px;color:#BDBDBD;margin-top:1px;line-height:1.3;max-width:' + (size+30) + 'px">If payment fails/declines, please retry after a minute or use bank details</div>'
    + '</div>';
}

// ═══════════════════════════════════════════════════════════════
// 7. SHARED BUILDERS
// ═══════════════════════════════════════════════════════════════

const BASE_CSS = '*{margin:0;padding:0;box-sizing:border-box;}body{font-family:\'Segoe UI\',Arial,sans-serif;font-size:11.5px;color:#212121;background:white;-webkit-print-color-adjust:exact;print-color-adjust:exact;}table{width:100%;border-collapse:collapse;}@media print{body{margin:0;}@page{size:A4;margin:8mm;}}';

function itemTableCSS(p, light) {
  return 'table.itbl{border:1px solid #CFD8DC;border-radius:4px;overflow:hidden;margin-bottom:0}'
    + 'table.itbl thead tr{background:' + p + '}'
    + 'table.itbl thead th{color:white;padding:7px 5px;font-size:9px;font-weight:700;text-align:center;white-space:nowrap}'
    + 'table.itbl tbody tr{}'
    + 'table.itbl tbody tr.alt{background:' + light + '}'
    + 'table.itbl tbody td{padding:6px 5px;font-size:10.5px;border-bottom:1px solid #ECEFF1;color:#424242;vertical-align:top}'
    + 'table.itbl tbody td.r{text-align:right}'
    + 'table.itbl tbody td.c{text-align:center}'
    + 'table.itbl tbody td.desc{font-weight:600;color:#212121}'
    + 'table.itbl tbody td.bld{font-weight:700;color:#212121}'
    + 'table.ttbl{width:100%}'
    + 'table.ttbl td{padding:3.5px 6px;font-size:10.5px}'
    + 'table.ttbl .lbl{color:#616161;text-align:right}'
    + 'table.ttbl .val{text-align:right;font-weight:600;color:#212121}'
    + 'table.ttbl .red{color:#E53935}'
    + 'table.ttbl .grn{color:#2E7D32}'
    + 'table.ttbl .due{color:#C62828;font-weight:700}'
    + 'table.ttbl .grand{background:' + p + ';border-radius:3px}'
    + 'table.ttbl .grand td{color:white;font-size:13px;font-weight:800;padding:7px 8px}';
}

function itemsTableHTML(inv, p, light) {
  const isInter = inv.is_interstate;
  const items   = inv.items || [];
  var rows = '';
  items.forEach(function(it, i) {
    var itemDetailHtml = it.item_details
      ? '<div style="font-size:9.5px;color:#757575;font-weight:400;margin-top:2px;line-height:1.4;white-space:pre-wrap">' + it.item_details + '</div>'
      : '';
    var gstCells = isInter
      ? '<td class="r">' + fmtN(it.igst_amount) + '</td>'
      : '<td class="r">' + fmtN(it.cgst_amount) + '</td><td class="r">' + fmtN(it.sgst_amount) + '</td>';
    rows += '<tr class="' + (i%2===1 ? 'alt' : '') + '">'
      + '<td class="c">' + (i+1) + '</td>'
      + '<td class="desc">' + (it.description||'') + itemDetailHtml + '</td>'
      + '<td class="c">' + (it.hsn_sac||'') + '</td>'
      + '<td class="r">' + fmtN(it.quantity) + '</td>'
      + '<td class="c">' + (it.unit||'') + '</td>'
      + '<td class="r">' + fmtN(it.unit_price) + '</td>'
      + '<td class="c">' + (it.discount_pct||0) + '%</td>'
      + '<td class="r">' + fmtN(it.taxable_value) + '</td>'
      + '<td class="c">' + (it.gst_rate||0) + '%</td>'
      + gstCells
      + '<td class="r bld">' + fmtN(it.total_amount) + '</td>'
      + '</tr>';
  });
  var igstHeader  = isInter ? '<th>IGST (\u20B9)</th>' : '<th>CGST (\u20B9)</th><th>SGST (\u20B9)</th>';
  return '<table class="itbl"><thead><tr>'
    + '<th style="width:20px">#</th>'
    + '<th style="text-align:left">Description</th>'
    + '<th>HSN/SAC</th>'
    + '<th>Qty</th>'
    + '<th>Unit</th>'
    + '<th>Rate (\u20B9)</th>'
    + '<th>Disc%</th>'
    + '<th>Taxable (\u20B9)</th>'
    + '<th>GST%</th>'
    + igstHeader
    + '<th>Amount (\u20B9)</th>'
    + '</tr></thead><tbody>'
    + rows
    + '</tbody></table>';
}

function totalsHTML(inv) {
  var isInter = inv.is_interstate;
  var html = '<table class="ttbl">'
    + '<tr><td class="lbl">Sub Total</td><td class="val">' + fmtC(inv.subtotal) + '</td></tr>';
  if ((inv.total_discount||0) > 0) {
    html += '<tr><td class="lbl red">(-) Discount</td><td class="val red">- ' + fmtC(inv.total_discount) + '</td></tr>';
  }
  html += '<tr><td class="lbl">Taxable Value</td><td class="val">' + fmtC(inv.total_taxable) + '</td></tr>';
  if (isInter) {
    html += '<tr><td class="lbl">IGST</td><td class="val">' + fmtC(inv.total_igst) + '</td></tr>';
  } else {
    html += '<tr><td class="lbl">CGST</td><td class="val">' + fmtC(inv.total_cgst) + '</td></tr>'
          + '<tr><td class="lbl">SGST / UTGST</td><td class="val">' + fmtC(inv.total_sgst) + '</td></tr>';
  }
  if ((inv.shipping_charges||0) > 0) {
    html += '<tr><td class="lbl">Shipping</td><td class="val">' + fmtC(inv.shipping_charges) + '</td></tr>';
  }
  if ((inv.other_charges||0) > 0) {
    html += '<tr><td class="lbl">Other Charges</td><td class="val">' + fmtC(inv.other_charges) + '</td></tr>';
  }
  html += '<tr class="grand"><td>Total</td><td>' + fmtC(inv.grand_total) + '</td></tr>';
  if ((inv.advance_received||inv.amount_paid||0) > 0) {
    html += '<tr><td class="lbl grn">\u2212 Advance Received</td><td class="val grn">\u2212 ' + fmtC(inv.advance_received||inv.amount_paid) + '</td></tr>';
  }
  // Always show Balance Due (even if equal to grand total or zero) so the
  // payable amount after deducting any advance is always visible on the invoice.
  html += '<tr><td class="lbl due">Balance Due</td><td class="val due">' + fmtC(inv.amount_due||0) + '</td></tr>';
  html += '</table>';
  return html;
}

function bankQrHTML(company, inv) {
  if (!company || !company.upi_id) return '';
  if (company.show_qr_code === false) return '';
  const pendingAmt = parseFloat((inv && inv.amount_due) || 0);
  const qrLabel = pendingAmt > 0
    ? 'Scan to Pay \u00B7 Balance Due: ' + fmtC(pendingAmt)
    : 'Scan to Pay via UPI';
  const qr = getPaymentQrHTML(company, inv, 82, qrLabel);
  if (!qr) return '';
  if (!company.bank_name && !company.bank_account_no && !company.bank_account) {
    return '<div style="text-align:center;margin:8px 0">' + qr + '</div>';
  }
  var bankHtml = '<div style="flex:1">'
    + '<div style="font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#9E9E9E;margin-bottom:5px">Bank Details</div>';
  if (company.company_name || company.name) {
    bankHtml += '<div style="font-size:10.5px;margin-bottom:4px"><span style="color:#9E9E9E;min-width:62px;display:inline-block">Name</span><strong>' + (company.company_name || company.name) + '</strong></div>';
  }
  if (company.bank_name) {
    bankHtml += '<div style="font-size:10.5px;margin-bottom:2px"><span style="color:#9E9E9E;min-width:62px;display:inline-block">Bank</span><strong>' + company.bank_name + '</strong></div>';
  }
  if (company.bank_account_no || company.bank_account) {
    bankHtml += '<div style="font-size:10.5px;margin-bottom:2px"><span style="color:#9E9E9E;min-width:62px;display:inline-block">A/c No.</span><strong>' + (company.bank_account_no || company.bank_account) + '</strong></div>';
  }
  if (company.bank_ifsc) {
    bankHtml += '<div style="font-size:10.5px;margin-bottom:2px"><span style="color:#9E9E9E;min-width:62px;display:inline-block">IFSC</span><strong>' + company.bank_ifsc + '</strong></div>';
  }
  if (company.upi_id) {
    bankHtml += '<div style="font-size:10.5px"><span style="color:#9E9E9E;min-width:62px;display:inline-block">UPI ID</span><strong>' + company.upi_id + '</strong></div>';
  }
  if (pendingAmt > 0) {
    bankHtml += '<div style="margin-top:6px;padding:4px 8px;background:#FFF3CD;border-radius:4px;font-size:9.5px;color:#856404;font-weight:700">Balance Due: ' + fmtC(pendingAmt) + '</div>';
  }
  bankHtml += '</div>';
  return '<div style="display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap">' + bankHtml + qr + '</div>';
}

function signRow(company, inv) {
  var leftHtml = '';
  if (inv.notes) leftHtml += '<strong>Notes:</strong> ' + inv.notes + '<br>';
  if (inv.terms_conditions) leftHtml += '<strong>T&amp;C:</strong> ' + inv.terms_conditions;
  if (!inv.notes && !inv.terms_conditions) leftHtml += '<em>Thanks for doing business with us!</em>';

  // Resolve signature image from all possible field names
  var sigImg = (company && (
    company.signature_image    ||
    company.signature_base64   ||
    company.signature_url      ||
    company.signatureImage     ||
    company.signatureBase64
  )) || '';

  var signatoryHtml = '';
  if (sigImg) {
    // Show actual signature image above the line
    signatoryHtml = '<div style="margin-top:6px;margin-bottom:4px;text-align:right">'
      + '<img src="' + sigImg + '" alt="Signature" style="height:38px;max-width:160px;object-fit:contain;display:inline-block;vertical-align:bottom;mix-blend-mode:multiply;background:white;"/>'
      + '</div>'
      + '<div style="border-top:1px solid #9E9E9E;padding-top:5px;font-size:9.5px;color:#9E9E9E">'
      + ((company && company.signatory_name) ? '<span style="font-weight:600;color:#424242">' + company.signatory_name + '</span><br>' : '')
      + ((company && company.signatory_label) || 'Authorised Signatory')
      + '</div>';
  } else if (company && company.signatory_name) {
    signatoryHtml = '<div style="font-size:10px;font-weight:600;color:#424242;margin-top:28px">' + company.signatory_name + '</div>'
      + '<div style="border-top:1px solid #9E9E9E;padding-top:5px;font-size:9.5px;color:#9E9E9E">' + ((company && company.signatory_label) || 'Authorised Signatory') + '</div>';
  } else {
    signatoryHtml = '<div style="border-top:1px solid #9E9E9E;margin-top:34px;padding-top:5px;font-size:9.5px;color:#9E9E9E">' + ((company && company.signatory_label) || 'Authorised Signatory') + '</div>';
  }

  return '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:10px;padding-top:8px;border-top:1px solid #E0E0E0">'
    + '<div style="font-size:9.5px;color:#757575;max-width:60%;line-height:1.7">' + leftHtml + '</div>'
    + '<div style="text-align:right">'
    + '<div style="font-size:9px;color:#9E9E9E">For&nbsp;' + ((company && company.name) || 'Your Company') + '</div>'
    + signatoryHtml
    + '</div>'
    + '</div>';
}

function partyBoxes(inv, p) {
  return '<div style="display:grid;grid-template-columns:1fr 1fr;border:1px solid #E0E0E0;border-radius:4px;overflow:hidden;margin-bottom:8px">'
    + '<div style="padding:9px 12px;border-right:1px solid #E0E0E0">'
      + '<div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:' + p + ';margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #E0E0E0">Bill To</div>'
      + '<div style="font-size:12.5px;font-weight:700;color:#212121;margin-bottom:3px">' + (inv.client_name || '\u2014') + '</div>'
      + '<div style="font-size:10.5px;color:#424242;line-height:1.65">' + (inv.client_address || '') + '</div>'
      + (inv.client_email ? '<div style="font-size:10px;color:#424242">\u2709 ' + inv.client_email + '</div>' : '')
      + (inv.client_phone ? '<div style="font-size:10px;color:#424242">\uD83D\uDCDE ' + inv.client_phone + '</div>' : '')
      + (inv.client_gstin ? '<div style="display:inline-block;background:' + p + ';color:white;font-size:8px;font-weight:700;padding:2px 7px;border-radius:2px;margin-top:3px">GSTIN&nbsp;' + inv.client_gstin + '</div>' : '')
    + '</div>'
    + '<div style="padding:9px 12px">'
      + '<div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:' + p + ';margin-bottom:5px;padding-bottom:3px;border-bottom:1px solid #E0E0E0">Invoice Details</div>'
      + '<div style="font-size:10.5px;color:#424242;line-height:1.75">'
        + '<div><strong>Invoice No:</strong> ' + (inv.invoice_no || '\u2014') + '</div>'
        + '<div><strong>Date:</strong> ' + (inv.invoice_date || '\u2014') + '</div>'
        + (inv.due_date ? '<div><strong>Due Date:</strong> ' + inv.due_date + '</div>' : '')
        + (inv.payment_terms ? '<div><strong>Terms:</strong> ' + inv.payment_terms + '</div>' : '')
        + (inv.reference_no ? '<div><strong>Ref/PO:</strong> ' + inv.reference_no + '</div>' : '')
        + '<div><strong>Supply:</strong> ' + (inv.is_interstate ? 'Interstate (IGST)' : 'Intrastate (CGST+SGST)') + '</div>'
      + '</div>'
    + '</div>'
  + '</div>';
}

function wordsBox(inv, p, light, accent) {
  var html = '<div style="background:' + light + ';border:1px solid ' + accent + ';border-radius:4px;padding:7px 10px;margin-bottom:8px">'
    + '<div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:' + p + ';margin-bottom:2px">Invoice Amount in Words</div>'
    + '<div style="font-size:10.5px;font-weight:600;color:#212121">' + amountToWords(inv.grand_total||0) + '</div>';
  if ((inv.amount_due||0) > 0) {
    html += '<div style="font-size:9px;color:#C62828;margin-top:3px;font-weight:700">Balance Due: ' + fmtC(inv.amount_due) + '</div>';
  }
  html += '</div>';
  return html;
}

// Returns the correct document-type heading for a given invoice, so
// Proforma Invoices / Estimates / Credit Notes / Debit Notes never get
// mislabelled as "Tax Invoice" on the printed/PDF document.
function docTypeLabel(inv, company) {
  var map = {
    proforma:    'Proforma Invoice',
    estimate:    'Estimate',
    credit_note: 'Credit Note',
    debit_note:  'Debit Note',
  };
  var type = (inv && inv.invoice_type) || 'tax_invoice';
  return map[type] || ((company && company.invoice_title) || 'Tax Invoice');
}

// ═══════════════════════════════════════════════════════════════
// 8. TEMPLATE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function tplClassic(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 54, 'rounded', 'on-color');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto}'
    + '.hdr{background:' + p + ';display:flex;align-items:center;padding:12px 16px;gap:14px}'
    + '.co-name{font-size:17px;font-weight:800;color:white}'
    + '.co-sub{font-size:9.5px;color:rgba(255,255,255,0.7);margin-top:3px;line-height:1.6}'
    + '.co-tag{display:inline-block;margin-top:4px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);color:white;font-size:8.5px;font-weight:700;padding:2px 8px;border-radius:3px}'
    + '.inv-r{text-align:right;flex-shrink:0}'
    + '.inv-type{font-size:8.5px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:3px}'
    + '.inv-no{font-size:20px;font-weight:900;color:white}'
    + '.inv-meta{font-size:9.5px;color:rgba(255,255,255,0.65);margin-top:3px;line-height:1.7}'
    + '.body{padding:10px 14px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + logo
    + '<div style="flex:1">'
    + '<div class="co-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="co-sub">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<span class="co-tag">GSTIN&nbsp;' + company.gstin + '</span>' : '')
    + (company && company.phone ? '<span class="co-tag" style="margin-left:4px">\uD83D\uDCDE&nbsp;' + company.phone + '</span>' : '')
    + '</div>'
    + '<div class="inv-r">'
    + '<div class="inv-type">' + docTypeLabel(inv, company) + '</div>'
    + '<div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div>'
    + '<div class="inv-meta">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? '<br>Due: ' + inv.due_date : '') + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="body">'
    + partyBoxes(inv, p)
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTheme2(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 48, 'rounded', 'on-color');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto}'
    + '.strip1{background:' + p + ';padding:8px 16px;display:flex;align-items:center;justify-content:space-between}'
    + '.co-name{font-size:17px;font-weight:800;color:white}'
    + '.tax-lbl{font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,0.65)}'
    + '.strip2{background:' + l + ';border:1px solid ' + a + ';padding:8px 16px;display:flex;align-items:center;gap:14px}'
    + '.s2-addr{flex:1;font-size:10px;color:#424242;line-height:1.65}'
    + '.s2-addr .gstin{display:inline-block;background:' + p + ';color:white;font-size:8px;font-weight:700;padding:1px 6px;border-radius:2px;margin-top:3px}'
    + '.s2-inv{text-align:right;flex-shrink:0}'
    + '.inv-no{font-size:22px;font-weight:900;color:' + p + '}'
    + '.inv-dt{font-size:9.5px;color:#616161;margin-top:2px;line-height:1.6}'
    + '.body{padding:10px 14px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="strip1"><div class="co-name">' + ((company && company.name)||'Your Company') + '</div><div class="tax-lbl">' + docTypeLabel(inv, company) + '</div></div>'
    + '<div class="strip2">'
    + logo
    + '<div class="s2-addr">'
    + ((company && company.address)||'') + '<br>'
    + (company && company.phone ? '\uD83D\uDCDE ' + company.phone + '&nbsp;&nbsp;' : '')
    + (company && company.gstin ? '<span class="gstin">GSTIN&nbsp;' + company.gstin + '</span>' : '')
    + '</div>'
    + '<div class="s2-inv">'
    + '<div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div>'
    + '<div class="inv-dt">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? '<br>Due: ' + inv.due_date : '') + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="body">'
    + partyBoxes(inv, p)
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTheme3(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 52, 'rounded', 'on-white');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto;border:2px solid ' + p + '}'
    + '.hdr{display:grid;grid-template-columns:1fr 1fr;border-bottom:2px solid ' + p + '}'
    + '.hl{padding:14px 16px;display:flex;align-items:center;gap:12px}'
    + '.co-name{font-size:17px;font-weight:800;color:' + p + '}'
    + '.co-sub{font-size:9.5px;color:#616161;margin-top:3px;line-height:1.65}'
    + '.co-gstin{display:inline-block;margin-top:4px;background:' + l + ';border:1px solid ' + a + ';color:' + p + ';font-size:8.5px;font-weight:700;padding:2px 8px;border-radius:3px}'
    + '.hr{background:' + p + ';padding:14px 16px;display:flex;flex-direction:column;justify-content:center;align-items:flex-end}'
    + '.inv-type{font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:4px}'
    + '.inv-no{font-size:22px;font-weight:900;color:white}'
    + '.inv-dt{font-size:9.5px;color:rgba(255,255,255,0.7);margin-top:4px;text-align:right;line-height:1.7}'
    + '.body{padding:10px 14px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + '<div class="hl">' + logo + '<div><div class="co-name">' + ((company && company.name)||'Your Company') + '</div><div class="co-sub">' + ((company && company.address)||'') + '</div>' + (company && company.gstin ? '<span class="co-gstin">GSTIN&nbsp;' + company.gstin + '</span>' : '') + '</div></div>'
    + '<div class="hr"><div class="inv-type">' + docTypeLabel(inv, company) + '</div><div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div><div class="inv-dt">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? '<br>Due: ' + inv.due_date : '') + '</div></div>'
    + '</div>'
    + '<div class="body">'
    + partyBoxes(inv, p)
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTheme4(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 58, 'circle', 'on-color');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto}'
    + '.hdr{background:' + p + ';padding:16px 20px;display:flex;flex-direction:column;align-items:center;position:relative;overflow:hidden}'
    + '.hdr::before{content:"";position:absolute;top:-50px;right:-50px;width:180px;height:180px;background:rgba(255,255,255,0.05);border-radius:50%}'
    + '.hdr-row{display:flex;align-items:center;gap:16px;position:relative}'
    + '.co-name{font-size:20px;font-weight:900;color:white;letter-spacing:-0.3px}'
    + '.co-sub{font-size:9.5px;color:rgba(255,255,255,0.7);margin-top:3px;line-height:1.6}'
    + '.co-tag{display:inline-block;margin-top:4px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);color:white;font-size:8.5px;font-weight:700;padding:2px 8px;border-radius:3px}'
    + '.inv-banner{background:rgba(0,0,0,0.25);border-radius:8px;padding:8px 24px;margin-top:10px;text-align:center;position:relative}'
    + '.inv-banner-type{font-size:9px;font-weight:800;letter-spacing:2.5px;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:3px}'
    + '.inv-banner-no{font-size:24px;font-weight:900;color:white}'
    + '.inv-banner-dt{font-size:9.5px;color:rgba(255,255,255,0.65);margin-top:3px}'
    + '.body{padding:10px 14px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + '<div class="hdr-row">'
    + logo
    + '<div>'
    + '<div class="co-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="co-sub">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<span class="co-tag">GSTIN&nbsp;' + company.gstin + '</span>' : '')
    + '</div>'
    + '</div>'
    + '<div class="inv-banner">'
    + '<div class="inv-banner-type">' + docTypeLabel(inv, company) + '</div>'
    + '<div class="inv-banner-no">' + (inv.invoice_no||'\u2014') + '</div>'
    + '<div class="inv-banner-dt">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? ' &nbsp;\u00B7&nbsp; Due: ' + inv.due_date : '') + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="body">'
    + partyBoxes(inv, p)
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTheme5(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 48, 'rounded', 'on-color');
  var card1 = '<div class="card"><h4>Bill To</h4><div class="cn">' + (inv.client_name||'\u2014') + '</div><p>' + (inv.client_address||'') + '</p>'
    + (inv.client_gstin ? '<p style="margin-top:3px;font-size:9px;font-weight:700;color:' + p + '">GSTIN: ' + inv.client_gstin + '</p>' : '') + '</div>';
  var card2 = '<div class="card"><h4>Invoice Details</h4><p><strong>No:</strong> ' + (inv.invoice_no||'\u2014') + '</p>'
    + (inv.due_date ? '<p><strong>Due:</strong> ' + inv.due_date + '</p>' : '')
    + '<p><strong>Terms:</strong> ' + (inv.payment_terms||'Due on receipt') + '</p></div>';
  var card3 = '<div class="card"><h4>Summary</h4><p><strong>Taxable:</strong> ' + fmtC(inv.total_taxable) + '</p>'
    + '<p><strong>GST:</strong> ' + fmtC(inv.total_gst) + '</p>'
    + '<p><strong>Total:</strong> ' + fmtC(inv.grand_total) + '</p>'
    + ((inv.amount_due||0) > 0 ? '<p style="color:#C62828;font-weight:700"><strong>Due:</strong> ' + fmtC(inv.amount_due) + '</p>' : '')
    + '</div>';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto}'
    + '.stripe{background:' + p + ';display:flex;align-items:center;justify-content:space-between;padding:10px 16px}'
    + '.co-block{display:flex;align-items:center;gap:12px}'
    + '.co-name{font-size:16px;font-weight:800;color:white}'
    + '.co-sub{font-size:9px;color:rgba(255,255,255,0.65);margin-top:2px}'
    + '.inv-no{font-size:22px;font-weight:900;color:white;text-align:right;margin-top:3px}'
    + '.inv-dt{font-size:9px;color:rgba(255,255,255,0.65);text-align:right}'
    + '.cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:10px 14px}'
    + '.card{background:white;border:1px solid #E0E0E0;border-top:3px solid ' + s + ';border-radius:0 0 6px 6px;padding:10px 12px;box-shadow:0 2px 6px rgba(0,0,0,0.06)}'
    + '.card h4{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:' + p + ';margin-bottom:5px}'
    + '.card .cn{font-size:12px;font-weight:700;color:#212121;margin-bottom:2px}'
    + '.card p{font-size:10px;color:#424242;line-height:1.65}'
    + '.body{padding:0 14px 10px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="stripe">'
    + '<div class="co-block">'
    + logo
    + '<div>'
    + '<div class="co-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="co-sub">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<div style="font-size:8.5px;color:rgba(255,255,255,0.7);margin-top:2px">GSTIN&nbsp;' + company.gstin + '</div>' : '')
    + '</div>'
    + '</div>'
    + '<div>'
    + '<div style="font-size:8.5px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.65)">' + docTypeLabel(inv, company) + '</div>'
    + '<div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div>'
    + '<div class="inv-dt">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? ' \u00B7 Due: ' + inv.due_date : '') + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="cards">' + card1 + card2 + card3 + '</div>'
    + '<div class="body">'
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTheme6(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 58, 'circle', 'on-color');
  var fc1 = '<div class="fc"><h4>Bill To</h4><div class="cn">' + (inv.client_name||'\u2014') + '</div><p>' + (inv.client_address||'') + '</p>'
    + (inv.client_gstin ? '<p style="color:' + p + ';font-size:9px;font-weight:700;margin-top:2px">GSTIN: ' + inv.client_gstin + '</p>' : '') + '</div>';
  var fc2 = '<div class="fc"><h4>Invoice Info</h4><p><strong>Terms:</strong> ' + (inv.payment_terms||'Due on receipt') + '</p>'
    + '<p><strong>Type:</strong> ' + (inv.is_interstate ? 'Interstate (IGST)' : 'CGST+SGST') + '</p>'
    + (inv.reference_no ? '<p><strong>Ref:</strong> ' + inv.reference_no + '</p>' : '') + '</div>';
  var fc3 = '<div class="fc"><h4>Amount Summary</h4><p><strong>Total:</strong> ' + fmtC(inv.grand_total) + '</p>'
    + '<p><strong>Paid:</strong> ' + fmtC(inv.amount_paid) + '</p>'
    + ((inv.amount_due||0) > 0 ? '<p style="color:#C62828;font-weight:700"><strong>Balance:</strong> ' + fmtC(inv.amount_due) + '</p>' : '') + '</div>';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto;overflow:hidden}'
    + '.banner{background:linear-gradient(130deg,' + p + ' 0%,' + s + ' 100%);padding:20px 20px 42px;position:relative;overflow:hidden}'
    + '.banner::before{content:"";position:absolute;top:-60px;left:-40px;width:200px;height:200px;background:rgba(255,255,255,0.05);border-radius:50%}'
    + '.banner-inner{display:flex;justify-content:space-between;align-items:center;position:relative}'
    + '.ring{width:70px;height:70px;border-radius:50%;background:rgba(255,255,255,0.2);border:2.5px solid rgba(255,255,255,0.5);display:flex;align-items:center;justify-content:center;flex-shrink:0}'
    + '.co-block{display:flex;align-items:center;gap:14px}'
    + '.co-name{font-size:19px;font-weight:900;color:white}'
    + '.co-sub{font-size:9.5px;color:rgba(255,255,255,0.65);margin-top:3px;line-height:1.6}'
    + '.inv-r{text-align:right;position:relative}'
    + '.inv-no{font-size:26px;font-weight:900;color:white;line-height:1}'
    + '.inv-dt{font-size:9.5px;color:rgba(255,255,255,0.65);margin-top:4px;line-height:1.7}'
    + '.float-cards{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;padding:0 14px;margin-top:-22px;margin-bottom:10px}'
    + '.fc{background:white;border-radius:8px;padding:12px 13px;box-shadow:0 3px 14px rgba(0,0,0,0.10)}'
    + '.fc h4{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:' + s + ';margin-bottom:5px}'
    + '.fc .cn{font-size:12px;font-weight:700;color:#212121;margin-bottom:2px}'
    + '.fc p{font-size:10px;color:#424242;line-height:1.65}'
    + '.body{padding:0 14px 10px}'
    + '.brow{display:grid;grid-template-columns:1fr 250px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="banner"><div class="banner-inner">'
    + '<div class="co-block"><div class="ring">' + logo + '</div>'
    + '<div>'
    + '<div class="co-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="co-sub">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<span style="display:inline-block;margin-top:4px;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);color:white;font-size:8.5px;font-weight:700;padding:2px 8px;border-radius:10px">GSTIN&nbsp;' + company.gstin + '</span>' : '')
    + '</div></div>'
    + '<div class="inv-r">'
    + '<div style="font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:6px">' + docTypeLabel(inv, company) + '</div>'
    + '<div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div>'
    + '<div class="inv-dt">Issued: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? '<br>Due: ' + inv.due_date : '') + '</div>'
    + '</div>'
    + '</div></div>'
    + '<div class="float-cards">' + fc1 + fc2 + fc3 + '</div>'
    + '<div class="body">'
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTheme7(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 54, 'rounded', 'on-color');
  const pendingAmt= parseFloat((inv && inv.amount_due) || 0);
  const qrLabel   = pendingAmt > 0 ? 'Balance Due: ' + fmtC(pendingAmt) : 'Scan to Pay';
  const qr        = getPaymentQrHTML(company, inv, 80, qrLabel);
  const isInter   = inv.is_interstate;
  var sbBank = '';
  if (company && company.bank_name) {
    sbBank = '<div class="sb-sec"><h4>Bank</h4><p>' + company.bank_name + '</p>'
      + (company.bank_account_no ? '<p>A/c: ' + company.bank_account_no + '</p>' : '')
      + (company.bank_ifsc ? '<p>IFSC: ' + company.bank_ifsc + '</p>' : '')
      + (company.upi_id ? '<p>UPI: ' + company.upi_id + '</p>' : '')
      + '</div>';
  }
  var igstRows = isInter
    ? '<div class="tb-row"><span>IGST</span><span>' + fmtC(inv.total_igst) + '</span></div>'
    : '<div class="tb-row"><span>CGST</span><span>' + fmtC(inv.total_cgst) + '</span></div><div class="tb-row"><span>SGST</span><span>' + fmtC(inv.total_sgst) + '</span></div>';
  var discRow = (inv.total_discount||0) > 0
    ? '<div class="tb-row"><span>Discount</span><span>-' + fmtC(inv.total_discount) + '</span></div>'
    : '';
  var balRow = (inv.amount_due||0) > 0
    ? '<div style="display:flex;justify-content:flex-end;margin-top:6px"><div style="background:#FFEBEE;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:700;color:#C62828;display:flex;gap:10px"><span>Balance Due</span><span>' + fmtC(inv.amount_due) + '</span></div></div>'
    : '';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto;min-height:297mm;display:flex}'
    + '.sidebar{width:62mm;flex-shrink:0;background:' + p + ';color:white;padding:18px 14px;display:flex;flex-direction:column;position:relative;overflow:hidden}'
    + '.sb-name{font-size:15px;font-weight:900;line-height:1.2;margin-bottom:4px;margin-top:10px}'
    + '.sb-addr{font-size:9px;opacity:0.65;line-height:1.7}'
    + '.sb-tag{display:inline-block;background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.3);font-size:8.5px;font-weight:700;padding:2px 8px;border-radius:3px;margin-top:5px}'
    + '.sb-div{border:none;border-top:1px solid rgba(255,255,255,0.18);margin:12px 0}'
    + '.sb-sec{margin-bottom:14px}'
    + '.sb-sec h4{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:2px;opacity:0.5;margin-bottom:6px}'
    + '.sb-sec p{font-size:10px;opacity:0.85;line-height:1.75}'
    + '.sb-sec .sn{font-size:11px;font-weight:700;opacity:1}'
    + '.main{flex:1;padding:18px 16px;background:white}'
    + '.main-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;padding-bottom:12px;border-bottom:2px solid ' + l + '}'
    + '.inv-type{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2.5px;color:' + s + ';margin-bottom:3px}'
    + '.inv-no{font-size:24px;font-weight:900;color:' + p + ';line-height:1}'
    + '.mc{background:' + l + ';border:1px solid ' + a + ';border-radius:4px;padding:4px 10px;font-size:10px;margin-bottom:4px}'
    + '.mc .mk{font-size:8px;color:#9E9E9E;text-transform:uppercase;letter-spacing:1px}'
    + '.mc .mv{font-size:11px;font-weight:700;color:' + p + ';margin-top:1px}'
    + '.tot-wrap{display:flex;justify-content:flex-end;margin-top:10px}'
    + '.tot-box{width:200px;background:' + p + ';border-radius:8px;padding:12px}'
    + '.tb-row{display:flex;justify-content:space-between;font-size:10.5px;padding:2.5px 0;color:rgba(255,255,255,0.8)}'
    + '.tb-total{display:flex;justify-content:space-between;font-size:16px;font-weight:900;padding-top:8px;margin-top:6px;border-top:1px solid rgba(255,255,255,0.3);color:white}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="sidebar">'
    + logo
    + '<div class="sb-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="sb-addr">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<span class="sb-tag">GSTIN&nbsp;' + company.gstin + '</span>' : '')
    + '<hr class="sb-div"/>'
    + '<div class="sb-sec"><h4>Invoice To</h4><div class="sn">' + (inv.client_name||'\u2014') + '</div><p>' + (inv.client_address||'') + '</p>' + (inv.client_gstin ? '<p style="font-size:9px;font-weight:700;opacity:1">GSTIN: ' + inv.client_gstin + '</p>' : '') + '</div>'
    + '<div class="sb-sec"><h4>Payment</h4><p>' + (inv.payment_terms||'Due on receipt') + '</p><p>' + (isInter ? 'IGST (Interstate)' : 'CGST + SGST') + '</p></div>'
    + sbBank
    + (pendingAmt > 0 ? '<div style="background:rgba(255,255,255,0.15);border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:10px;font-weight:700">Balance Due<br>' + fmtC(pendingAmt) + '</div>' : '')
    + (qr ? '<div style="text-align:center;margin-top:auto">' + qr + '</div>' : '')
    + '</div>'
    + '<div class="main">'
    + '<div class="main-top">'
    + '<div><div class="inv-type">' + docTypeLabel(inv, company) + '</div><div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div></div>'
    + '<div><div class="mc"><div class="mk">Invoice Date</div><div class="mv">' + (inv.invoice_date||'\u2014') + '</div></div>' + (inv.due_date ? '<div class="mc"><div class="mk">Due Date</div><div class="mv">' + inv.due_date + '</div></div>' : '') + '</div>'
    + '</div>'
    + itemsTableHTML(inv, p, l)
    + '<div class="tot-wrap"><div class="tot-box">'
    + '<div class="tb-row"><span>Taxable</span><span>' + fmtC(inv.total_taxable) + '</span></div>'
    + igstRows
    + discRow
    + '<div class="tb-total"><span>Total</span><span>' + fmtC(inv.grand_total) + '</span></div>'
    + '<div style="font-size:9px;color:rgba(255,255,255,0.6);margin-top:4px;font-style:italic">' + amountToWords(inv.grand_total||0) + '</div>'
    + '</div></div>'
    + balRow
    + '<div style="display:flex;justify-content:flex-end;margin-top:14px;padding-top:8px;border-top:1px solid #E0E0E0">'
    + '<div style="text-align:right">'
    + '<div style="font-size:9px;color:#9E9E9E">For&nbsp;' + ((company && company.name)||'') + '</div>'
    + '<div style="border-top:1px solid #9E9E9E;margin-top:34px;padding-top:5px;font-size:9.5px;color:#9E9E9E">Authorised Signatory</div>'
    + '</div></div>'
    + '</div>'
    + '</div></body></html>';
}

function tplTheme8(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 50, 'rounded', 'on-white');
  var pb1 = '<div class="pb"><h4>Billed To</h4><div class="pn">' + (inv.client_name||'\u2014') + '</div><p>' + (inv.client_address||'') + '</p>'
    + (inv.client_gstin ? '<p style="font-size:9px;font-weight:700;color:' + p + ';margin-top:3px">GSTIN: ' + inv.client_gstin + '</p>' : '') + '</div>';
  var pb2 = '<div class="pb"><h4>Contact</h4><p>' + (inv.client_email||'\u2014') + '</p><p>' + (inv.client_phone||'') + '</p></div>';
  var pb3 = '<div class="pb"><h4>Details</h4><p><strong>Terms:</strong> ' + (inv.payment_terms||'Due on receipt') + '</p>'
    + '<p><strong>Tax:</strong> ' + (inv.is_interstate ? 'IGST' : 'CGST+SGST') + '</p>'
    + (inv.reference_no ? '<p><strong>Ref:</strong> ' + inv.reference_no + '</p>' : '') + '</div>';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto;padding:12mm 18mm}'
    + '.hdr{display:flex;justify-content:space-between;align-items:flex-start}'
    + '.co-name{font-size:24px;font-weight:900;color:' + p + ';letter-spacing:-0.5px}'
    + '.co-sub{font-size:10px;color:#9E9E9E;margin-top:3px;line-height:1.7}'
    + '.co-gstin{font-size:9.5px;font-weight:700;color:' + p + ';margin-top:4px}'
    + '.inv-block{text-align:right;display:flex;flex-direction:column;align-items:flex-end;gap:8px}'
    + '.inv-lbl{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:2.5px;color:#9E9E9E}'
    + '.inv-no{font-size:26px;font-weight:900;color:' + p + ';line-height:1}'
    + '.inv-dt{font-size:10.5px;color:#9E9E9E;margin-top:3px}'
    + '.accent{height:3px;background:linear-gradient(90deg,' + p + ',' + s + ');border-radius:2px;margin:18px 0 16px}'
    + '.party-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;padding-bottom:18px;border-bottom:1px solid #F5F5F5;margin-bottom:18px}'
    + '.pb h4{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:2px;color:' + s + ';margin-bottom:6px}'
    + '.pb .pn{font-size:12.5px;font-weight:700;color:#212121;margin-bottom:3px}'
    + '.pb p{font-size:10.5px;color:#424242;line-height:1.65}'
    + '.brow{display:grid;grid-template-columns:1fr 220px;gap:22px;margin-top:18px}'
    + itemTableCSS(p,l)
    + 'table.itbl thead th{background:transparent;color:' + p + ';border-bottom:2px solid ' + p + ';padding:0 8px 8px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;text-align:center}'
    + 'table.itbl tbody td{border-bottom:1px solid #F9F9F9;padding:9px 8px}'
    + 'table.itbl tbody tr.alt{background:' + l + '}'
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + '<div>'
    + '<div class="co-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="co-sub">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<div class="co-gstin">GSTIN&nbsp;' + company.gstin + '</div>' : '')
    + '</div>'
    + '<div class="inv-block">'
    + logo
    + '<div>'
    + '<div class="inv-lbl">Invoice Number</div>'
    + '<div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div>'
    + '<div class="inv-dt">' + (inv.invoice_date||'\u2014') + (inv.due_date ? ' \u2192 Due ' + inv.due_date : '') + '</div>'
    + '</div>'
    + '</div>'
    + '</div>'
    + '<div class="accent"></div>'
    + '<div class="party-row">' + pb1 + pb2 + pb3 + '</div>'
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div>'
    + wordsBox(inv, p, l, a)
    + bankQrHTML(company, inv)
    + (inv.notes ? '<p style="font-size:10px;color:#757575;margin-top:8px"><strong>Notes:</strong> ' + inv.notes + '</p>' : '')
    + (inv.terms_conditions ? '<p style="font-size:10px;color:#757575;margin-top:4px"><strong>T&amp;C:</strong> ' + inv.terms_conditions + '</p>' : '')
    + '</div>'
    + '<div>' + totalsHTML(inv) + '</div>'
    + '</div>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:20px;padding-top:12px;border-top:1px solid #F5F5F5">'
    + '<div style="text-align:right"><div style="font-size:9px;color:#9E9E9E">For&nbsp;' + ((company && company.name)||'') + '</div><div style="border-top:1px solid #9E9E9E;margin-top:34px;padding-top:5px;font-size:9.5px;color:#9E9E9E">Authorised Signatory</div></div>'
    + '</div>'
    + '</div></body></html>';
}

function tplFrenchElite(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 54, 'rounded', 'on-color');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto;border:3px solid ' + p + ';outline:1px solid ' + a + ';outline-offset:-6px;min-height:297mm}'
    + '.hdr{display:grid;grid-template-columns:1fr 220px;border-bottom:3px solid ' + p + '}'
    + '.hl{background:' + l + ';padding:16px 18px;display:flex;align-items:center;gap:14px;border-right:3px solid ' + p + '}'
    + '.co-name{font-size:17px;font-weight:900;color:' + p + '}'
    + '.co-sub{font-size:9.5px;color:#616161;margin-top:3px;line-height:1.65}'
    + '.co-gstin{display:inline-block;margin-top:4px;background:' + p + ';color:white;font-size:8.5px;font-weight:700;padding:2px 9px;border-radius:3px}'
    + '.hr{background:' + p + ';padding:16px 18px;display:flex;flex-direction:column;justify-content:center;align-items:flex-end}'
    + '.inv-type{font-size:8.5px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:4px}'
    + '.inv-no{font-size:20px;font-weight:900;color:white}'
    + '.inv-dt{font-size:9.5px;color:rgba(255,255,255,0.7);margin-top:4px;text-align:right;line-height:1.7}'
    + '.ornament{text-align:center;margin:12px 0;font-size:14px;color:' + p + ';letter-spacing:6px}'
    + '.body{padding:0 16px 14px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid ' + a + '}'
    + '.bl{padding:10px 12px;border-right:1px solid ' + a + '}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + '<div class="hl">' + logo + '<div><div class="co-name">' + ((company && company.name)||'Your Company') + '</div><div class="co-sub">' + ((company && company.address)||'') + '</div>' + (company && company.gstin ? '<span class="co-gstin">GSTIN&nbsp;' + company.gstin + '</span>' : '') + '</div></div>'
    + '<div class="hr"><div class="inv-type">' + docTypeLabel(inv, company) + '</div><div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div><div class="inv-dt">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? '<br>Due: ' + inv.due_date : '') + '</div></div>'
    + '</div>'
    + '<div class="ornament">\u2014 \u2726 \u2014</div>'
    + '<div class="body">'
    + partyBoxes(inv, p)
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplDoubleDivine(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo = getLogoHTML(company, theme, 52, 'rounded', 'on-color');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto}'
    + '.hdr{display:grid;grid-template-columns:1fr 1fr;min-height:88px}'
    + '.hl{background:' + p + ';padding:16px 18px;display:flex;align-items:center;gap:14px}'
    + '.co-name{font-size:17px;font-weight:900;color:white}'
    + '.co-sub{font-size:9.5px;color:rgba(255,255,255,0.7);margin-top:3px;line-height:1.65}'
    + '.co-tag{display:inline-block;margin-top:4px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);color:white;font-size:8.5px;font-weight:700;padding:2px 9px;border-radius:3px}'
    + '.hr{background:' + s + ';padding:16px 18px;display:flex;flex-direction:column;justify-content:center;align-items:flex-end}'
    + '.divine-lbl{font-size:9px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.65);margin-bottom:4px}'
    + '.inv-no{font-size:22px;font-weight:900;color:white}'
    + '.inv-dt{font-size:9.5px;color:rgba(255,255,255,0.7);margin-top:4px;text-align:right;line-height:1.7}'
    + '.divine-stripe{height:4px;background:linear-gradient(90deg,' + p + ' 50%,' + s + ' 50%)}'
    + '.body{padding:10px 14px}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + '<div class="hl">' + logo + '<div><div class="co-name">' + ((company && company.name)||'Your Company') + '</div><div class="co-sub">' + ((company && company.address)||'') + '</div>' + (company && company.gstin ? '<span class="co-tag">GSTIN&nbsp;' + company.gstin + '</span>' : '') + '</div></div>'
    + '<div class="hr"><div class="divine-lbl">' + docTypeLabel(inv, company) + '</div><div class="inv-no">' + (inv.invoice_no||'\u2014') + '</div><div class="inv-dt">Date: ' + (inv.invoice_date||'\u2014') + (inv.due_date ? '<br>Due: ' + inv.due_date : '') + '</div></div>'
    + '</div>'
    + '<div class="divine-stripe"></div>'
    + '<div class="body">'
    + partyBoxes(inv, p)
    + itemsTableHTML(inv, p, l)
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplGstTheme1(inv, company, theme) {
  const {primary:p, secondary:s, light:l, accent:a} = theme;
  const logo    = getLogoHTML(company, theme, 50, 'rounded', 'on-color');
  const isInter = inv.is_interstate;
  const items   = inv.items || [];
  const gstGroups = {};
  items.forEach(function(it) {
    const rate = it.gst_rate || 0;
    if (!gstGroups[rate]) gstGroups[rate] = {rate:rate, taxable:0, cgst:0, sgst:0, igst:0};
    gstGroups[rate].taxable += (it.taxable_value || 0);
    gstGroups[rate].cgst    += (it.cgst_amount   || 0);
    gstGroups[rate].sgst    += (it.sgst_amount   || 0);
    gstGroups[rate].igst    += (it.igst_amount   || 0);
  });
  var gstRows = Object.values(gstGroups).map(function(g) {
    var tax = isInter ? g.igst : g.cgst + g.sgst;
    var gstCols = isInter
      ? '<td>' + fmtN(g.igst) + '</td>'
      : '<td>' + fmtN(g.cgst) + '</td><td>' + fmtN(g.sgst) + '</td>';
    return '<tr><td style="text-align:left">GST @ ' + g.rate + '%</td><td>' + fmtN(g.taxable) + '</td>' + gstCols + '<td>' + fmtN(tax) + '</td></tr>';
  }).join('');
  var totalTax = isInter ? inv.total_igst : (inv.total_cgst||0) + (inv.total_sgst||0);
  var gstTotalCols = isInter
    ? '<td>' + fmtN(inv.total_igst) + '</td>'
    : '<td>' + fmtN(inv.total_cgst) + '</td><td>' + fmtN(inv.total_sgst) + '</td>';
  var gstTotalRow = '<tr style="font-weight:700;background:' + l + '"><td style="text-align:left">Total</td><td>' + fmtN(inv.total_taxable) + '</td>' + gstTotalCols + '<td>' + fmtN(totalTax) + '</td></tr>';
  var igstHeader = isInter ? '<th>IGST (\u20B9)</th>' : '<th>CGST (\u20B9)</th><th>SGST/UTGST (\u20B9)</th>';
  var refRow = inv.reference_no ? '<div class="row"><span class="mk">Ref/PO No.</span><span class="mv">' + inv.reference_no + '</span></div>' : '';
  var dueDateRow = inv.due_date ? '<div class="row"><span class="mk">Due Date</span><span class="mv">' + inv.due_date + '</span></div>' : '';
  var clientEmailRow = inv.client_email ? '<div style="font-size:10px;color:#424242;margin-top:2px">\u2709 ' + inv.client_email + '</div>' : '';
  var clientPhoneRow = inv.client_phone ? '<div style="font-size:10px;color:#424242">\uD83D\uDCDE ' + inv.client_phone + '</div>' : '';
  var clientGstinTag = inv.client_gstin ? '<div style="display:inline-block;background:' + p + ';color:white;font-size:8px;font-weight:700;padding:2px 7px;border-radius:2px;margin-top:3px">GSTIN&nbsp;' + inv.client_gstin + '</div>' : '';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + BASE_CSS
    + '.page{max-width:210mm;margin:0 auto}'
    + '.hdr{background:' + p + ';display:flex;align-items:center;padding:10px 14px;gap:12px;border-bottom:4px solid ' + s + '}'
    + '.co-name{font-size:16px;font-weight:800;color:white}'
    + '.co-sub{font-size:9px;color:rgba(255,255,255,0.7);margin-top:2px;line-height:1.6}'
    + '.tax-inv-badge{background:white;color:' + p + ';font-size:9px;font-weight:900;letter-spacing:1.5px;text-transform:uppercase;padding:4px 14px;border-radius:3px}'
    + '.body{padding:8px 12px}'
    + '.meta2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}'
    + '.meta2-box{background:' + l + ';border:1px solid ' + a + ';border-radius:4px;padding:8px 10px}'
    + '.meta2-box h4{font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:' + p + ';margin-bottom:5px}'
    + '.meta2-box .row{display:flex;gap:8px;font-size:10px;margin-bottom:2px}'
    + '.meta2-box .mk{color:#9E9E9E;min-width:90px}'
    + '.meta2-box .mv{font-weight:600;color:#212121}'
    + '.gst-sum{border:1px solid ' + a + ';border-radius:4px;overflow:hidden;margin-top:10px}'
    + '.gst-sum table thead tr{background:' + p + '}'
    + '.gst-sum table thead th{color:white;padding:6px 8px;font-size:9px;font-weight:700;text-align:center}'
    + '.gst-sum table tbody td{padding:5px 8px;font-size:10.5px;text-align:right;border-bottom:1px solid #ECEFF1;color:#424242}'
    + '.gst-sum table tbody td:first-child{text-align:left;font-weight:600}'
    + '.brow{display:grid;grid-template-columns:1fr 230px;gap:0;border-top:1px solid #E0E0E0}'
    + '.bl{padding:10px 12px;border-right:1px solid #E0E0E0}'
    + '.br{padding:10px 12px}'
    + itemTableCSS(p,l)
    + '</style></head><body><div class="page">'
    + '<div class="hdr">'
    + logo
    + '<div style="flex:1">'
    + '<div class="co-name">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="co-sub">' + ((company && company.address)||'') + (company && company.phone ? ' \u00B7 \uD83D\uDCDE ' + company.phone : '') + '</div>'
    + (company && company.gstin ? '<div style="font-size:9px;color:rgba(255,255,255,0.7);margin-top:2px">GSTIN: <strong style="color:white">' + company.gstin + '</strong></div>' : '')
    + '</div>'
    + '<div><div class="tax-inv-badge">' + docTypeLabel(inv, company) + '</div></div>'
    + '</div>'
    + '<div class="body">'
    + '<div class="meta2">'
    + '<div class="meta2-box"><h4>Invoice Details</h4>'
    + '<div class="row"><span class="mk">Invoice No.</span><span class="mv">' + (inv.invoice_no||'\u2014') + '</span></div>'
    + '<div class="row"><span class="mk">Invoice Date</span><span class="mv">' + (inv.invoice_date||'\u2014') + '</span></div>'
    + dueDateRow
    + '<div class="row"><span class="mk">Supply Type</span><span class="mv">' + (isInter ? 'Interstate (IGST)' : 'Intrastate (CGST+SGST)') + '</span></div>'
    + '<div class="row"><span class="mk">Place of Supply</span><span class="mv">' + (inv.client_state||'\u2014') + '</span></div>'
    + refRow
    + '</div>'
    + '<div class="meta2-box"><h4>Bill To</h4>'
    + '<div style="font-size:12.5px;font-weight:700;color:#212121;margin-bottom:3px">' + (inv.client_name||'\u2014') + '</div>'
    + '<div style="font-size:10.5px;color:#424242;line-height:1.65">' + (inv.client_address||'') + '</div>'
    + clientEmailRow
    + clientPhoneRow
    + clientGstinTag
    + '</div>'
    + '</div>'
    + itemsTableHTML(inv, p, l)
    + '<div class="gst-sum"><table><thead><tr>'
    + '<th style="text-align:left">GST Rate</th>'
    + '<th>Taxable Value (\u20B9)</th>'
    + igstHeader
    + '<th>Total Tax (\u20B9)</th>'
    + '</tr></thead><tbody>'
    + gstRows
    + gstTotalRow
    + '</tbody></table></div>'
    + '<div class="brow">'
    + '<div class="bl">' + wordsBox(inv, p, l, a) + bankQrHTML(company, inv) + '</div>'
    + '<div class="br">' + totalsHTML(inv) + '</div>'
    + '</div>'
    + signRow(company, inv)
    + '</div>'
    + '</div></body></html>';
}

function tplTallyTheme(inv, company, theme) {
  const isInter = inv.is_interstate;
  const items   = inv.items || [];
  const TALLY_CSS = '*{margin:0;padding:0;box-sizing:border-box}body{font-family:\'Courier New\',Courier,monospace;font-size:11px;color:#000;background:white;-webkit-print-color-adjust:exact;print-color-adjust:exact}table{width:100%;border-collapse:collapse;}@media print{body{margin:0;}@page{size:A4;margin:8mm;}}'
    + '.page{max-width:210mm;margin:0 auto;padding:10mm 12mm}'
    + '.center{text-align:center}.right{text-align:right}.bold{font-weight:bold}'
    + 'hr.solid{border:none;border-top:2px solid #000;margin:3px 0}'
    + 'hr.dash{border:none;border-top:1px dashed #000;margin:3px 0}'
    + '.grid{display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:2px}'
    + 'table.itbl{border-collapse:collapse;margin:4px 0}'
    + 'table.itbl thead th{border-top:1px solid #000;border-bottom:1px solid #000;font-size:10px;font-weight:bold;padding:3px 4px;text-align:center}'
    + 'table.itbl tbody td{padding:2.5px 4px;font-size:10.5px;color:#000;text-align:center}'
    + 'table.itbl tbody td.l{text-align:left}'
    + 'table.itbl tbody td.r{text-align:right}'
    + '.tot-row{display:flex;justify-content:space-between;padding:1px 0;font-size:10.5px}'
    + '.tot-grand{display:flex;justify-content:space-between;padding:2px 0;font-size:11.5px;font-weight:bold}';
  var igstThHeader = isInter ? '<th>GST%</th><th>IGST</th>' : '<th>CGST%</th><th>CGST</th><th>SGST%</th><th>SGST</th>';
  var itemRows = items.map(function(it, i) {
    var gstCols = isInter
      ? '<td>' + (it.gst_rate||0) + '%</td><td class="r">' + fmtN(it.igst_amount) + '</td>'
      : '<td>' + ((it.gst_rate||0)/2) + '%</td><td class="r">' + fmtN(it.cgst_amount) + '</td><td>' + ((it.gst_rate||0)/2) + '%</td><td class="r">' + fmtN(it.sgst_amount) + '</td>';
    return '<tr>'
      + '<td class="l">' + (i+1) + '</td>'
      + '<td class="l">' + (it.description||'') + '</td>'
      + '<td>' + (it.hsn_sac||'') + '</td>'
      + '<td class="r">' + fmtN(it.quantity) + '&nbsp;' + (it.unit||'') + '</td>'
      + '<td class="r">' + fmtN(it.unit_price) + '</td>'
      + '<td class="r">' + fmtN(it.taxable_value) + '</td>'
      + gstCols
      + '<td class="r" style="font-weight:bold">' + fmtN(it.total_amount) + '</td>'
      + '</tr>';
  }).join('');
  var igstTotRow = isInter
    ? '<div class="tot-row"><span>IGST</span><span>' + fmtC(inv.total_igst) + '</span></div>'
    : '<div class="tot-row"><span>CGST</span><span>' + fmtC(inv.total_cgst) + '</span></div><div class="tot-row"><span>SGST/UTGST</span><span>' + fmtC(inv.total_sgst) + '</span></div>';
  var bankBlock = '';
  if (company && company.bank_name) {
    bankBlock = '<hr class="dash"/><div style="font-size:10px"><strong>Bank:</strong> ' + company.bank_name + '</div>'
      + (company.bank_account_no ? '<div style="font-size:10px"><strong>A/c No.:</strong> ' + company.bank_account_no + '</div>' : '')
      + (company.bank_ifsc ? '<div style="font-size:10px"><strong>IFSC:</strong> ' + company.bank_ifsc + '</div>' : '')
      + (company.upi_id ? '<div style="font-size:10px"><strong>UPI:</strong> ' + company.upi_id + '</div>' : '');
  }
  var qrBlock = (company && company.upi_id)
    ? '<hr class="dash"/>' + getPaymentQrHTML(company, inv, 80, (inv.amount_due||0) > 0 ? 'Balance Due: ' + fmtC(inv.amount_due) : 'Scan to Pay via UPI')
    : '';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>' + TALLY_CSS + '</style></head><body><div class="page">'
    + '<div class="center bold" style="font-size:13px">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="center" style="font-size:10px">' + ((company && company.address)||'') + '</div>'
    + (company && company.phone ? '<div class="center" style="font-size:10px">Ph: ' + company.phone + '</div>' : '')
    + (company && company.gstin ? '<div class="center" style="font-size:10px">GSTIN: ' + company.gstin + '</div>' : '')
    + '<hr class="solid"/>'
    + '<div class="center bold">' + docTypeLabel(inv, company).toUpperCase() + '</div>'
    + '<hr class="dash"/>'
    + '<div class="grid"><span>Invoice No: <strong>' + (inv.invoice_no||'\u2014') + '</strong></span><span>Date: <strong>' + (inv.invoice_date||'\u2014') + '</strong></span></div>'
    + (inv.due_date ? '<div class="grid"><span></span><span>Due: <strong>' + inv.due_date + '</strong></span></div>' : '')
    + '<hr class="dash"/>'
    + '<div><strong>Party:</strong> ' + (inv.client_name||'\u2014') + '</div>'
    + '<div style="font-size:10.5px">' + (inv.client_address||'') + '</div>'
    + (inv.client_gstin ? '<div style="font-size:10.5px">GSTIN: ' + inv.client_gstin + '</div>' : '')
    + '<hr class="dash"/>'
    + '<div class="grid"><span><strong>Supply:</strong> ' + (inv.client_state||'\u2014') + '</span><span><strong>Tax Type:</strong> ' + (isInter ? 'IGST' : 'CGST+SGST') + '</span></div>'
    + '<hr class="solid"/>'
    + '<table class="itbl"><thead><tr>'
    + '<th style="text-align:left;width:20px">#</th>'
    + '<th style="text-align:left">Particulars</th>'
    + '<th>HSN</th><th>Qty</th><th>Rate</th><th>Taxable</th>'
    + igstThHeader
    + '<th style="text-align:right">Amount</th>'
    + '</tr></thead><tbody>'
    + itemRows
    + '</tbody></table>'
    + '<hr class="solid"/>'
    + '<div style="display:grid;grid-template-columns:1fr 220px;gap:8px">'
    + '<div>'
    + '<div style="font-size:10px;font-style:italic"><strong>Amount in Words:</strong><br>' + amountToWords(inv.grand_total||0) + '</div>'
    + bankBlock
    + ((inv.amount_due||0) > 0 ? '<hr class="dash"/><div style="font-size:10px;font-weight:bold;color:#C62828">Balance Due: ' + fmtC(inv.amount_due) + '</div>' : '')
    + (inv.terms_conditions ? '<hr class="dash"/><div style="font-size:9.5px"><strong>Terms:</strong> ' + inv.terms_conditions + '</div>' : '')
    + '</div>'
    + '<div>'
    + '<div class="tot-row"><span>Sub Total</span><span>' + fmtC(inv.subtotal) + '</span></div>'
    + ((inv.total_discount||0) > 0 ? '<div class="tot-row"><span>(-) Discount</span><span>-' + fmtC(inv.total_discount) + '</span></div>' : '')
    + '<div class="tot-row"><span>Taxable Value</span><span>' + fmtC(inv.total_taxable) + '</span></div>'
    + igstTotRow
    + '<hr class="solid"/>'
    + '<div class="tot-grand"><span>Total</span><span>' + fmtC(inv.grand_total) + '</span></div>'
    + '<hr class="solid"/>'
    + ((inv.advance_received||inv.amount_paid||0) > 0 ? '<div class="tot-row" style="color:#059669"><span>\u2212 Advance Received</span><span>\u2212 ' + fmtC(inv.advance_received||inv.amount_paid) + '</span></div>' : '')
    + '<div class="tot-row" style="font-weight:bold;color:#C62828"><span>Balance Due at Delivery</span><span>' + fmtC(inv.amount_due||0) + '</span></div>'
    + '</div>'
    + '</div>'
    + qrBlock
    + '<hr class="solid"/>'
    + '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-top:6px">'
    + '<div style="font-size:9.5px">Thanks for doing business with us!</div>'
    + '<div style="text-align:right"><div style="font-size:9.5px">For&nbsp;' + ((company && company.name)||'') + '</div><div style="margin-top:30px;padding-top:4px;border-top:1px solid #212121;font-size:9.5px">Authorised Signatory</div></div>'
    + '</div>'
    + '</div></body></html>';
}

function tplThermal1(inv, company, theme) {
  const {primary:p} = theme;
  const isInter    = inv.is_interstate;
  const items      = inv.items || [];
  const pendingAmt = parseFloat((inv && inv.amount_due) || 0);
  const qr         = company && company.upi_id ? getPaymentQrHTML(company, inv, 80, pendingAmt > 0 ? 'Balance: ' + fmtC(pendingAmt) : 'Scan to Pay') : '';
  var igstRows = isInter
    ? '<tr><td>IGST</td><td class="r">' + fmtC(inv.total_igst) + '</td></tr>'
    : '<tr><td>CGST</td><td class="r">' + fmtC(inv.total_cgst) + '</td></tr><tr><td>SGST</td><td class="r">' + fmtC(inv.total_sgst) + '</td></tr>';
  var discRow = (inv.total_discount||0) > 0
    ? '<tr><td>Discount</td><td class="r">-' + fmtC(inv.total_discount) + '</td></tr>'
    : '';
  var itemRows = items.map(function(it) {
    return '<tr><td colspan="3" style="padding-bottom:0"><strong>' + (it.description||'') + '</strong></td></tr>'
      + '<tr><td style="font-size:10px">@' + fmtN(it.unit_price) + ' GST' + (it.gst_rate||0) + '%</td>'
      + '<td style="text-align:center">' + fmtN(it.quantity) + (it.unit ? ' ' + it.unit : '') + '</td>'
      + '<td class="r">' + fmtN(it.total_amount) + '</td></tr>';
  }).join('');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:\'Courier New\',monospace;font-size:12px;width:80mm;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media print{body{margin:0}@page{size:80mm auto;margin:0}}'
    + '.c{text-align:center}.r{text-align:right}.b{font-weight:bold}'
    + 'hr.s{border:none;border-top:1px dashed #000;margin:3px 0}hr.s2{border:none;border-top:2px solid #000;margin:3px 0}'
    + 'table{width:100%}td{padding:1px 2px;font-size:11px}.gt{font-size:13px;font-weight:bold}'
    + '</style></head><body>'
    + '<div class="c b" style="font-size:13px">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="c" style="font-size:10px">' + ((company && company.address)||'') + '</div>'
    + (company && company.phone ? '<div class="c" style="font-size:10px">\uD83D\uDCDE ' + company.phone + '</div>' : '')
    + (company && company.gstin ? '<div class="c" style="font-size:10px">GSTIN: ' + company.gstin + '</div>' : '')
    + '<hr class="s2"/><div class="c b">' + docTypeLabel(inv, company).toUpperCase() + '</div><hr class="s"/>'
    + '<table>'
    + '<tr><td>Invoice No:</td><td class="r b">' + (inv.invoice_no||'\u2014') + '</td></tr>'
    + '<tr><td>Date:</td><td class="r">' + (inv.invoice_date||'\u2014') + '</td></tr>'
    + (inv.due_date ? '<tr><td>Due Date:</td><td class="r">' + inv.due_date + '</td></tr>' : '')
    + '</table><hr class="s"/>'
    + '<div><strong>Party: ' + (inv.client_name||'\u2014') + '</strong></div>'
    + (inv.client_address ? '<div style="font-size:10px">' + inv.client_address + '</div>' : '')
    + (inv.client_gstin ? '<div style="font-size:10px">GSTIN: ' + inv.client_gstin + '</div>' : '')
    + '<hr class="s"/>'
    + '<table><thead><tr><th style="text-align:left">Item</th><th>Qty</th><th class="r">Amt</th></tr></thead>'
    + '<tbody>' + itemRows + '</tbody></table>'
    + '<hr class="s"/>'
    + '<table>'
    + '<tr><td>Taxable</td><td class="r">' + fmtC(inv.total_taxable) + '</td></tr>'
    + igstRows
    + discRow
    + '</table><hr class="s2"/>'
    + '<table><tr class="gt"><td><strong>TOTAL</strong></td><td class="r"><strong>' + fmtC(inv.grand_total) + '</strong></td></tr></table>'
    + '<hr class="s2"/>'
    + ((inv.amount_paid||0) > 0 ? '<table><tr><td>Received</td><td class="r">' + fmtC(inv.amount_paid) + '</td></tr></table>' : '')
    + '<table><tr><td><strong>Balance Due</strong></td><td class="r"><strong>' + fmtC(pendingAmt) + '</strong></td></tr></table>'
    + '<hr class="s"/>'
    + '<div style="font-size:10px;text-align:center;font-style:italic">' + amountToWords(inv.grand_total||0) + '</div>'
    + (qr ? '<hr class="s"/><div class="c">' + qr + '</div>' : '')
    + (company && company.upi_id ? '<div class="c" style="font-size:10px">UPI: ' + company.upi_id + '</div>' : '')
    + '<hr class="s"/>'
    + (inv.terms_conditions ? '<div style="font-size:9px;text-align:center">' + inv.terms_conditions + '</div><hr class="s"/>' : '')
    + '<div class="c" style="font-size:10px">Thanks for your business!</div>'
    + '<div style="text-align:right;margin-top:20px;font-size:10px;border-top:1px solid #000;padding-top:3px">Authorised Signatory</div>'
    + '</body></html>';
}

function tplThermal2(inv, company, theme) {
  const {primary:p} = theme;
  const isInter    = inv.is_interstate;
  const items      = inv.items || [];
  const pendingAmt = parseFloat((inv && inv.amount_due) || 0);
  const qr         = company && company.upi_id ? getPaymentQrHTML(company, inv, 90, pendingAmt > 0 ? 'Balance: ' + fmtC(pendingAmt) : 'Scan to Pay') : '';
  var igstRows = isInter
    ? '<tr><td>IGST</td><td class="r">' + fmtC(inv.total_igst) + '</td></tr>'
    : '<tr><td>CGST</td><td class="r">' + fmtC(inv.total_cgst) + '</td></tr><tr><td>SGST/UTGST</td><td class="r">' + fmtC(inv.total_sgst) + '</td></tr>';
  var discRow = (inv.total_discount||0) > 0
    ? '<tr><td>Discount</td><td class="r">-' + fmtC(inv.total_discount) + '</td></tr>'
    : '';
  var paidRows = '';
  if ((inv.amount_paid||0) > 0) {
    paidRows = '<hr class="d"/><table><tr><td>Received</td><td class="r">' + fmtC(inv.amount_paid) + '</td></tr>'
      + (pendingAmt > 0 ? '<tr><td><strong>Balance Due</strong></td><td class="r"><strong>' + fmtC(pendingAmt) + '</strong></td></tr>' : '')
      + '</table>';
  }
  var itemRows = items.map(function(it) {
    return '<tr>'
      + '<td>' + (it.description||'') + '<br><span style="font-size:9px;color:#555">HSN:' + (it.hsn_sac||'') + ' @' + fmtN(it.unit_price) + ' GST:' + (it.gst_rate||0) + '%</span></td>'
      + '<td style="text-align:center">' + fmtN(it.quantity) + (it.unit ? ' ' + it.unit : '') + '</td>'
      + '<td class="r">' + fmtN(it.total_amount) + '</td>'
      + '</tr>';
  }).join('');
  var bankRow = (company && company.bank_name)
    ? '<hr class="d"/><div style="font-size:10px;padding:1px 2px"><strong>Bank:</strong> ' + company.bank_name + ' | A/c: ' + ((company.bank_account_no||company.bank_account)||'') + ' | IFSC: ' + (company.bank_ifsc||'') + '</div>'
    : '';
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>' + (inv.invoice_no||'Invoice') + '</title>'
    + '<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:11px;width:80mm;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}@media print{body{margin:0}@page{size:80mm auto;margin:0}}'
    + '.c{text-align:center}.r{text-align:right}'
    + '.hdr-band{background:#000;color:white;padding:5px;text-align:center;font-size:13px;font-weight:bold}'
    + 'hr.s{border:none;border-top:1px solid #000;margin:3px 0}hr.d{border:none;border-top:1px dashed #000;margin:3px 0}'
    + 'table{width:100%}td{padding:1.5px 2px;font-size:11px}'
    + '.grand-band{background:#000;color:white;padding:4px 6px;display:flex;justify-content:space-between;font-size:12px;font-weight:bold}'
    + '</style></head><body>'
    + '<div class="hdr-band">' + ((company && company.name)||'Your Company') + '</div>'
    + '<div class="c" style="font-size:10px;padding:2px">' + ((company && company.address)||'') + '</div>'
    + (company && company.gstin ? '<div class="c" style="font-size:10px">GSTIN: ' + company.gstin + '</div>' : '')
    + (company && company.phone ? '<div class="c" style="font-size:10px">\uD83D\uDCDE ' + company.phone + '</div>' : '')
    + '<hr class="s"/>'
    + '<table>'
    + '<tr><td><strong>Invoice:</strong> ' + (inv.invoice_no||'\u2014') + '</td><td class="r">' + (inv.invoice_date||'\u2014') + '</td></tr>'
    + (inv.due_date ? '<tr><td colspan="2" class="r" style="font-size:10px">Due: ' + inv.due_date + '</td></tr>' : '')
    + '<tr><td><strong>' + (inv.client_name||'\u2014') + '</strong></td><td class="r">' + (isInter ? 'IGST' : 'CGST+SGST') + '</td></tr>'
    + (inv.client_gstin ? '<tr><td colspan="2" style="font-size:9px">GSTIN: ' + inv.client_gstin + '</td></tr>' : '')
    + '</table><hr class="s"/>'
    + '<table><thead><tr><th style="text-align:left">Description</th><th style="text-align:center">Qty</th><th style="text-align:right">Total</th></tr></thead>'
    + '<tbody>' + itemRows + '</tbody></table>'
    + '<hr class="s"/>'
    + '<table>'
    + '<tr><td>Taxable Value</td><td class="r">' + fmtC(inv.total_taxable) + '</td></tr>'
    + igstRows
    + discRow
    + '</table><hr class="s"/>'
    + '<div class="grand-band"><span>GRAND TOTAL</span><span>' + fmtC(inv.grand_total) + '</span></div>'
    + paidRows
    + '<hr class="s"/>'
    + '<div class="c" style="font-size:9.5px;font-style:italic;padding:2px">' + amountToWords(inv.grand_total||0) + '</div>'
    + (qr ? '<hr class="d"/><div class="c" style="padding:3px">' + qr + '</div>' : '')
    + bankRow
    + '<hr class="s"/>'
    + (inv.terms_conditions ? '<div style="font-size:9px;padding:1px 2px">' + inv.terms_conditions + '</div><hr class="d"/>' : '')
    + '<div class="c" style="font-size:11px;font-weight:bold;padding:3px">Thank You! Visit Again.</div>'
    + '<div style="text-align:right;margin-top:18px;padding-top:3px;border-top:1px dashed #000;font-size:10px">Authorised Signatory</div>'
    + '</body></html>';
}

// ═══════════════════════════════════════════════════════════════
// 9. DISPATCHER
// ═══════════════════════════════════════════════════════════════

const TEMPLATE_FNS = {
  classic:      tplClassic,
  theme2:       tplTheme2,
  theme3:       tplTheme3,
  theme4:       tplTheme4,
  theme5:       tplTheme5,
  theme6:       tplTheme6,
  theme7:       tplTheme7,
  theme8:       tplTheme8,
  frenchelite:  tplFrenchElite,
  doubledivine: tplDoubleDivine,
  gsttheme1:    tplGstTheme1,
  tallytheme:   tplTallyTheme,
  thermal1:     tplThermal1,
  thermal2:     tplThermal2,
};

export function generateInvoiceHTML(inv, { company, template, theme, customColor } = {}) {
  const invWithTotals = recomputeTotals(inv || {});
  const resolvedTheme = getThemeColor(theme || 'classic_blue', customColor || '#0D3B66');
  const fn = TEMPLATE_FNS[template] || tplClassic;
  return fn(invWithTotals, company || {}, resolvedTheme);
}

export function openInvoicePrint(inv, company, templateId, themeId, customColor) {
  templateId  = templateId  || 'classic';
  themeId     = themeId     || 'classic_blue';
  customColor = customColor || '#0D3B66';
  if (!inv) return;
  const html = generateInvoiceHTML(inv, { company: company, template: templateId, theme: themeId, customColor: customColor });
  const win  = window.open('', '_blank', 'width=900,height=700');
  if (!win) { alert('Please allow pop-ups to print invoices'); return; }
  win.document.write(html);
  win.document.close();
  win.onload = function() { win.focus(); win.print(); };
}

// ═══════════════════════════════════════════════════════════════
// 10. PREVIEW HOOK
// ═══════════════════════════════════════════════════════════════

export function useInvoicePreviewHtml(form, totals, companies, editingInv) {
  return useMemo(function() {
    try {
      const company = (companies && companies.find(function(c) { return c.id === (form && form.company_id); })) || {
        name: 'Your Company', gstin: 'GSTIN', address: 'Company Address'
      };
      const previewItems = (form && form.items && form.items.filter(function(it) { return it.description && it.description.trim(); }).length > 0)
        ? form.items
        : [{ description: 'Sample Service', quantity: 1, unit: 'service',
             unit_price: 10000, discount_pct: 0, gst_rate: 18,
             taxable_value: 10000, cgst_rate: 9, sgst_rate: 9,
             cgst_amount: 900, sgst_amount: 900, igst_amount: 0, total_amount: 11800 }];
      const previewInv = {
        ...(form || {}),
        items:        previewItems,
        invoice_no:   (editingInv && editingInv.invoice_no) || 'PREVIEW-001',
        invoice_date: (form && form.invoice_date) || new Date().toISOString().slice(0,10),
        due_date:     (form && form.due_date)     || new Date(Date.now() + 30*86400000).toISOString().slice(0,10),
        client_name:  (form && form.client_name)  || 'Client Name',
      };
      return generateInvoiceHTML(previewInv, {
        company:     company,
        template:    (form && form.invoice_template)     || 'classic',
        theme:       (form && form.invoice_theme)        || 'classic_blue',
        customColor: (form && form.invoice_custom_color) || '#0D3B66',
      });
    } catch (e) {
      return '<p style="padding:20px;color:#999">Preview not available \u2014 fill in invoice details first</p>';
    }
  }, [
    form && form.items, form && form.invoice_template, form && form.invoice_theme,
    form && form.invoice_custom_color, form && form.company_id, form && form.client_name,
    form && form.is_interstate, form && form.discount_amount, form && form.shipping_charges,
    form && form.other_charges, editingInv && editingInv.invoice_no, companies
  ]);
}

// ═══════════════════════════════════════════════════════════════
// 11. SAMPLE DATA
// ═══════════════════════════════════════════════════════════════

function makeSampleInvoice() {
  const items = [
    { description: 'GST Return Filing (Monthly)', hsn_sac: '998311', quantity: 1, unit: 'month',
      unit_price: 2500, discount_pct: 0, gst_rate: 18 },
    { description: 'Income Tax Return \u2014 Individual', hsn_sac: '998311', quantity: 1, unit: 'service',
      unit_price: 3500, discount_pct: 10, gst_rate: 18 },
    { description: 'Bookkeeping & Accounting', hsn_sac: '998222', quantity: 3, unit: 'month',
      unit_price: 1500, discount_pct: 0, gst_rate: 18 },
  ];
  const base = {
    invoice_no: 'INV/2025-26/0042', invoice_type: 'tax_invoice',
    invoice_date: '15 Jul 2025', due_date: '14 Aug 2025',
    client_name: 'Sunrise Technologies Pvt. Ltd.',
    client_address: '14 Patel Nagar, Ahmedabad, Gujarat \u2013 380009',
    client_email: 'accounts@sunrise.in', client_phone: '9876543210',
    client_gstin: '24AABCS1429B1Z5', client_state: 'Gujarat',
    payment_terms: 'Net 30 Days', reference_no: 'PO/2025/1138',
    is_interstate: false, items: items,
    amount_paid: 10000,
    notes: 'Payment via NEFT/RTGS to bank details below.',
    terms_conditions: 'Goods once sold will not be returned. Subject to Ahmedabad jurisdiction.',
  };
  return recomputeTotals(base);
}

function makeSampleCompany() {
  return {
    name:            'Enterprise Solutions & Co.',
    address:         'Suite 401, Business Boulevard, Commercial District, Mumbai \u2013 400051',
    gstin:           '27AAAAA0000A1Z5',
    phone:           '+91 22 2847 0000',
    bank_name:       'State Bank of India',
    bank_account_no: '00000012345678',
    bank_ifsc:       'SBIN0001234',
    upi_id:          'billing@bank',
  };
}

// ═══════════════════════════════════════════════════════════════
// 12. INVOICE DESIGN MODAL
// ═══════════════════════════════════════════════════════════════

export const InvoiceDesignModal = ({
  open, onClose,
  selectedTemplate, onTemplateChange,
  selectedTheme, onThemeChange,
  customColor, onCustomColorChange,
  sampleInvoice, sampleCompany, isDark
}) => {
  const [previewHtml, setPreviewHtml] = useState('');
  const iframeRef = useRef(null);
  const activeTheme = getThemeColor(selectedTheme, customColor);

  useEffect(function() {
    if (!open) return;
    const inv = sampleInvoice || makeSampleInvoice();
    const co  = sampleCompany || makeSampleCompany();
    setPreviewHtml(generateInvoiceHTML(inv, { company: co, template: selectedTemplate, theme: selectedTheme, customColor: customColor }));
  }, [open, selectedTemplate, selectedTheme, customColor, sampleInvoice, sampleCompany]);

  const handlePrint = useCallback(function() {
    const inv = sampleInvoice || makeSampleInvoice();
    const co  = sampleCompany || makeSampleCompany();
    openInvoicePrint(inv, co, selectedTemplate, selectedTheme, customColor);
  }, [sampleInvoice, sampleCompany, selectedTemplate, selectedTheme, customColor]);

  const regularTemplates = INVOICE_TEMPLATES.filter(function(t) { return !t.thermal; });
  const thermalTemplates = INVOICE_TEMPLATES.filter(function(t) { return t.thermal; });

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={[
        'max-w-[min(1100px,96vw)] w-[1100px] max-h-[93vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0',
        isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
      ].join(' ')}>
        <DialogTitle className="sr-only">Invoice Design Studio</DialogTitle>
        <DialogDescription className="sr-only">Choose a template, colour, then preview.</DialogDescription>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b flex items-center justify-between"
          style={{ background: 'linear-gradient(135deg,' + activeTheme.primary + ',' + activeTheme.secondary + ')' }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center">
              <Layout className="h-5 w-5 text-white"/>
            </div>
            <div>
              <h2 className="text-white font-bold text-lg">Invoice Design Studio</h2>
              <p className="text-white/60 text-xs">Templates &middot; Colour Picker &middot; Live Preview &middot; UPI QR with Balance</p>
            </div>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all">
            <X className="h-4 w-4 text-white"/>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left panel */}
          <div className={[
            'w-[300px] flex-shrink-0 flex flex-col border-r overflow-y-auto',
            isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-200 bg-slate-50/40'
          ].join(' ')}>

            {/* Regular Templates */}
            <div className="p-4 border-b" style={{ borderColor: isDark ? 'rgba(255,255,255,0.07)' : '#e2e8f0' }}>
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: activeTheme.primary }}>
                Regular Themes ({regularTemplates.length})
              </p>
              <div className="grid grid-cols-3 gap-2">
                {regularTemplates.map(function(tpl) {
                  return (
                    <button key={tpl.id} onClick={function() { onTemplateChange(tpl.id); }}
                      className={[
                        'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all',
                        selectedTemplate === tpl.id
                          ? 'border-blue-500 shadow-sm'
                          : isDark ? 'border-slate-600 hover:border-slate-500' : 'border-slate-200 hover:border-blue-300'
                      ].join(' ')}>
                      <div className="w-12 h-16 rounded-lg overflow-hidden flex-shrink-0 relative"
                        style={{ background: activeTheme.light, border: '1px solid ' + activeTheme.accent }}>
                        <div className="absolute inset-x-0 top-0 h-5 rounded-t-lg" style={{ background: activeTheme.primary }}/>
                        <div className="absolute inset-x-1 top-6 space-y-1">
                          {[0,1,2].map(function(i) {
                            return <div key={i} className="h-1 rounded" style={{ background: isDark ? '#374151' : '#e2e8f0', width: i===2 ? '70%' : '100%' }}/>;
                          })}
                        </div>
                        {selectedTemplate === tpl.id && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                            <Check className="h-4 w-4 text-white"/>
                          </div>
                        )}
                      </div>
                      <p className={'text-[9px] font-semibold text-center leading-tight ' + (selectedTemplate === tpl.id ? 'text-blue-600' : isDark ? 'text-slate-300' : 'text-slate-600')}>
                        {tpl.name}
                      </p>
                      {tpl.badge && <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full" style={{ background: activeTheme.light, color: activeTheme.primary }}>{tpl.badge}</span>}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Thermal Templates */}
            <div className="p-4 border-b" style={{ borderColor: isDark ? 'rgba(255,255,255,0.07)' : '#e2e8f0' }}>
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: activeTheme.primary }}>
                Thermal Roll ({thermalTemplates.length})
              </p>
              <div className="grid grid-cols-2 gap-2">
                {thermalTemplates.map(function(tpl) {
                  return (
                    <button key={tpl.id} onClick={function() { onTemplateChange(tpl.id); }}
                      className={[
                        'flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all',
                        selectedTemplate === tpl.id
                          ? 'border-blue-500 shadow-sm'
                          : isDark ? 'border-slate-600 hover:border-slate-500' : 'border-slate-200 hover:border-blue-300'
                      ].join(' ')}>
                      <div className="w-10 h-16 rounded-lg overflow-hidden flex-shrink-0 relative"
                        style={{ background: '#f9fafb', border: '1px solid #e2e8f0' }}>
                        <div className="absolute inset-x-0 top-0 h-5 bg-black rounded-t-lg"/>
                        <div className="absolute inset-x-1 top-6 space-y-1">
                          {[0,1,2,3].map(function(i) { return <div key={i} className="h-0.5 rounded bg-gray-300"/>; })}
                        </div>
                        {selectedTemplate === tpl.id && (
                          <div className="absolute inset-0 flex items-center justify-center bg-black/20">
                            <Check className="h-3 w-3 text-white"/>
                          </div>
                        )}
                      </div>
                      <p className={'text-[9px] font-semibold text-center leading-tight ' + (selectedTemplate === tpl.id ? 'text-blue-600' : isDark ? 'text-slate-300' : 'text-slate-600')}>
                        {tpl.name}
                      </p>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Colours */}
            <div className="p-4">
              <p className="text-[10px] font-bold uppercase tracking-widest mb-3" style={{ color: activeTheme.primary }}>
                Colour Theme
              </p>
              <div className="grid grid-cols-4 gap-2 mb-3">
                {COLOR_THEMES.map(function(t) {
                  return (
                    <button key={t.id} onClick={function() { onThemeChange(t.id); }} title={t.name}
                      style={{
                        width: '100%', aspectRatio: '1', borderRadius: 8,
                        background: 'linear-gradient(135deg,' + t.primary + ',' + t.secondary + ')',
                        border: selectedTheme === t.id ? '3px solid white' : '3px solid transparent',
                        boxShadow: selectedTheme === t.id ? '0 0 0 2px ' + t.primary : 'none',
                        cursor: 'pointer', transition: 'all 0.15s',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                      }}>
                      {selectedTheme === t.id && <Check style={{ width: 12, height: 12, color: 'white' }}/>}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-slate-400 mb-3">
                Selected: <span className="font-semibold" style={{ color: activeTheme.primary }}>
                  {(COLOR_THEMES.find(function(t) { return t.id === selectedTheme; }) || {}).name || 'Custom'}
                </span>
              </p>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5">Custom Colour</p>
              <div className="flex items-center gap-2">
                <input type="color" value={customColor}
                  onChange={function(e) { onCustomColorChange(e.target.value); onThemeChange('custom'); }}
                  className="w-9 h-9 rounded-lg border border-slate-200 cursor-pointer p-0.5"/>
                <Input value={customColor}
                  onChange={function(e) { onCustomColorChange(e.target.value); onThemeChange('custom'); }}
                  className={['flex-1 h-9 rounded-xl text-xs font-mono', isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'].join(' ')}/>
              </div>
            </div>

            {/* Selected template description */}
            {(function() {
              const tpl = INVOICE_TEMPLATES.find(function(t) { return t.id === selectedTemplate; });
              return tpl ? (
                <div className="mx-4 mb-4 rounded-xl p-3 border" style={{ background: activeTheme.light, borderColor: activeTheme.accent }}>
                  <p className="text-xs font-bold" style={{ color: activeTheme.primary }}>{tpl.name}</p>
                  <p className="text-[10px] text-slate-500 mt-1">{tpl.desc}</p>
                </div>
              ) : null;
            })()}
          </div>

          {/* Right preview */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className={['flex-shrink-0 flex items-center justify-between px-5 py-3 border-b', isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-100 bg-slate-50'].join(' ')}>
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-slate-400"/>
                <span className="text-xs font-semibold text-slate-500">Live Preview</span>
                <span className="text-[10px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">Sample data &middot; QR shows balance due</span>
              </div>
              <div className="flex gap-2">
                <Button onClick={handlePrint} size="sm"
                  className="h-8 px-4 rounded-xl text-white text-xs font-semibold gap-1.5"
                  style={{ background: 'linear-gradient(135deg,' + activeTheme.primary + ',' + activeTheme.secondary + ')' }}>
                  <Printer className="h-3.5 w-3.5"/>Print Preview
                </Button>
                <Button onClick={onClose} size="sm" variant="outline" className="h-8 px-4 rounded-xl text-xs">
                  Save &amp; Close
                </Button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4" style={{ background: isDark ? '#1e293b' : '#e2e8f0' }}>
              <div style={{ maxWidth: 794, margin: '0 auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)', borderRadius: 4, overflow: 'hidden', background: 'white' }}>
                <iframe
                  ref={iframeRef}
                  srcDoc={previewHtml}
                  title="Invoice Preview"
                  style={{
                    width: '100%',
                    height: (INVOICE_TEMPLATES.find(function(t) { return t.id === selectedTemplate; }) || {}).thermal ? 500 : 1122,
                    border: 'none', display: 'block'
                  }}
                  sandbox="allow-scripts"
                />
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
