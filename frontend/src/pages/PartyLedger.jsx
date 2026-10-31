/**
 * PartyLedger.jsx — Redesigned & Alignment-Fixed
 *
 * CHANGES IN THIS VERSION:
 * 1. PDF title: "Account Statement" (unchanged)
 * 2. All table columns properly constrained — no overflow, perfect alignment
 * 3. Summary cards + aging panel restructured into a clean responsive row
 * 4. ADDED: Smart Analytics Panel — DSO, Collection Efficiency, Overdue Risk Score,
 *           Payment Mode Breakdown, Avg Days to Pay, Top Unpaid Invoices, Payment Pattern
 * 5. All additions are UI-only — zero backend changes, zero PDF layout changes
 * 6. Dark mode throughout
 */

import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
} from 'react';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import api from '@/lib/api';
import { toast } from 'sonner';
import { format, parseISO, differenceInDays, startOfDay } from 'date-fns';
import { getXLSX } from '@/lib/lazyLibs';
import {
  X,
  Search,
  BookOpen,
  Download,
  Printer,
  ChevronDown,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Clock,
  BarChart2,
  Zap,
  CheckCircle2,
  CreditCard,
  ChevronRight,
  Info,
  Building2,
} from 'lucide-react';

// ─── Constants ────────────────────────────────────────────────────────────────
const ENTRY_TYPE_META = {
  invoice:    { label: 'Tax Invoice',       side: 'Dr', color: '#1D4ED8', bg: '#EFF6FF', border: '#BFDBFE' },
  proforma:   { label: 'Proforma Invoice',  side: 'Dr', color: '#7C3AED', bg: '#F5F3FF', border: '#DDD6FE' },
  estimate:   { label: 'Estimate',          side: 'Dr', color: '#64748B', bg: '#F8FAFC', border: '#CBD5E1' },
  debit_note: { label: 'Debit Note',        side: 'Dr', color: '#D97706', bg: '#FFFBEB', border: '#FDE68A' },
  credit_note:{ label: 'Credit Note',       side: 'Cr', color: '#059669', bg: '#ECFDF5', border: '#6EE7B7' },
  payment:    { label: 'Payment Received',  side: 'Cr', color: '#059669', bg: '#ECFDF5', border: '#6EE7B7' },
  opening:    { label: 'Opening Balance',   side: null,  color: '#0D3B66', bg: '#EFF6FF', border: '#93C5FD' },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtN = (n) =>
  new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n ?? 0);

const fmtC = (n) => `₹${fmtN(n)}`;

function getIndianFY(date = new Date()) {
  const m = date.getMonth();
  const y = date.getFullYear();
  return m >= 3 ? { start: y, end: y + 1 } : { start: y - 1, end: y };
}

function fyDateRange(fy) {
  return {
    from:  `${fy.start}-04-01`,
    to:    `${fy.end}-03-31`,
    label: `FY ${fy.start}-${String(fy.end).slice(2)}`,
  };
}

const DATE_PRESETS = (() => {
  const today  = new Date();
  const curFY  = getIndianFY(today);
  const prevFY = { start: curFY.start - 1, end: curFY.end - 1 };
  const fmt    = (d) => format(d, 'yyyy-MM-dd');
  const sub    = (days) => { const d = new Date(today); d.setDate(d.getDate() - days); return d; };

  return [
    { id: 'curFY',  ...fyDateRange(curFY),  label: `Current ${fyDateRange(curFY).label}` },
    { id: 'prevFY', ...fyDateRange(prevFY), label: `Prev ${fyDateRange(prevFY).label}` },
    { id: '3m',     from: fmt(sub(90)),     to: fmt(today), label: 'Last 3 months' },
    { id: '6m',     from: fmt(sub(180)),    to: fmt(today), label: 'Last 6 months' },
    { id: '1y',     from: fmt(sub(365)),    to: fmt(today), label: 'Last 1 year' },
    { id: 'all',    from: '2000-01-01',     to: fmt(today), label: 'All time' },
    { id: 'custom', from: '',               to: '',          label: 'Custom' },
  ];
})();

function agingBucket(dueDateStr) {
  if (!dueDateStr) return null;
  const days = differenceInDays(startOfDay(new Date()), startOfDay(parseISO(dueDateStr)));
  if (days <= 0)  return null;
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

// ─── Avatar ───────────────────────────────────────────────────────────────────
const AVATAR_GRADS = [
  ['#0D3B66', '#1F6FB2'],
  ['#064e3b', '#059669'],
  ['#7c2d12', '#ea580c'],
  ['#4c1d95', '#7c3aed'],
  ['#881337', '#e11d48'],
  ['#134e4a', '#0d9488'],
];

const avatarGrad = (name = '') => {
  const i = (name?.charCodeAt(0) || 0) % AVATAR_GRADS.length;
  return `linear-gradient(135deg, ${AVATAR_GRADS[i][0]}, ${AVATAR_GRADS[i][1]})`;
};

// ─── Highlight ────────────────────────────────────────────────────────────────
const Hl = ({ text = '', query = '' }) => {
  if (!query.trim()) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="bg-yellow-200 px-0.5 rounded">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// CLIENT COMBOBOX
// ════════════════════════════════════════════════════════════════════════════════
function ClientCombobox({ clients, value, onChange, isDark }) {
  const [open, setOpen]     = useState(false);
  const [query, setQuery]   = useState('');
  const [focused, setFocus] = useState(-1);
  const wrapRef             = useRef(null);
  const inputRef            = useRef(null);

  const selected = clients.find((c) => c.id === value) || null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients.slice(0, 60);
    return clients
      .filter(
        (c) =>
          (c.company_name || '').toLowerCase().includes(q) ||
          (c.email        || '').toLowerCase().includes(q) ||
          (c.phone        || '').includes(q)
      )
      .slice(0, 40);
  }, [clients, query]);

  useEffect(() => {
    const h = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const pick = (c) => {
    onChange(c?.id || null);
    setOpen(false);
    setQuery('');
    setFocus(-1);
  };

  const base = isDark
    ? 'bg-slate-800 border-slate-600 text-slate-100'
    : 'bg-white border-slate-200 text-slate-800';

  return (
    <div ref={wrapRef} className="relative w-full">
      <div
        onClick={() => { setOpen((o) => !o); setTimeout(() => inputRef.current?.focus(), 20); }}
        className={`w-full flex items-center gap-2.5 h-10 px-3 rounded-xl border text-sm cursor-pointer transition-all
          ${base}
          ${open ? 'border-blue-500 ring-2 ring-blue-100' : isDark ? 'hover:border-slate-500' : 'hover:border-blue-300'}`}
      >
        {selected ? (
          <>
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
              style={{ background: avatarGrad(selected.company_name) }}
            >
              {selected.company_name?.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-sm truncate leading-tight">{selected.company_name}</div>
              <div className="text-[11px] text-slate-400 truncate">{selected.phone || selected.email || ''}</div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); pick(null); }}
              className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-red-100 hover:text-red-500 text-slate-400 flex-shrink-0 text-xs"
            >
              ✕
            </button>
          </>
        ) : (
          <div className="flex-1 flex items-center gap-2 text-slate-400">
            <Search className="w-3.5 h-3.5 flex-shrink-0" />
            <span className="text-sm">Search party / client…</span>
          </div>
        )}
        <ChevronDown className={`w-3.5 h-3.5 text-slate-400 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </div>

      {open && (
        <div className={`absolute z-50 w-full mt-1 rounded-2xl border shadow-2xl py-2 max-h-[300px] overflow-auto
          ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
        >
          <div className="px-2 pb-2">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => { setQuery(e.target.value); setFocus(-1); }}
              placeholder="Type name, phone or email…"
              className={`w-full px-3 h-8 text-sm outline-none rounded-xl border
                ${isDark ? 'bg-slate-700 text-slate-100 border-slate-600' : 'bg-slate-50 border-slate-200'}`}
            />
          </div>

          {filtered.length === 0 && query ? (
            <div className="px-4 py-6 text-center text-slate-400 text-sm">
              No match for &ldquo;{query}&rdquo;
            </div>
          ) : (
            filtered.map((c, i) => (
              <div
                key={c.id}
                onClick={() => pick(c)}
                onMouseEnter={() => setFocus(i)}
                className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors
                  ${i === focused
                    ? isDark ? 'bg-blue-900/40' : 'bg-blue-50'
                    : isDark ? 'hover:bg-slate-700/60' : 'hover:bg-slate-50'}
                  ${c.id === value ? isDark ? 'bg-blue-900/20' : 'bg-blue-50/60' : ''}`}
              >
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                  style={{ background: avatarGrad(c.company_name) }}
                >
                  {c.company_name?.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">
                    <Hl text={c.company_name || ''} query={query} />
                  </div>
                  <div className="text-[11px] text-slate-400 truncate">
                    {c.phone && <span>{c.phone}</span>}
                    {c.email && <span className="ml-2">{c.email}</span>}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// LEDGER ENGINE
// ════════════════════════════════════════════════════════════════════════════════
function buildLedger(invoices, paymentsMap, openingBalance, dateFrom, dateTo) {
  const entries = [];
  const from    = dateFrom ? new Date(dateFrom)              : null;
  const to      = dateTo   ? new Date(dateTo + 'T23:59:59')  : null;

  const inRange = (dateStr) => {
    if (!dateStr) return true;
    const d = new Date(dateStr);
    if (from && d < from) return false;
    if (to   && d > to)   return false;
    return true;
  };

  entries.push({
    id: 'opening',
    date: dateFrom || '2000-01-01',
    type: 'opening',
    ref: '',
    narration: 'Opening Balance',
    dr: openingBalance > 0 ? openingBalance : 0,
    cr: openingBalance < 0 ? Math.abs(openingBalance) : 0,
    sourceId: null,
  });

  invoices.forEach((inv) => {
    if (!inRange(inv.invoice_date)) return;

    const meta = ENTRY_TYPE_META[inv.invoice_type] || ENTRY_TYPE_META.invoice;

    if (meta.side === 'Dr') {
      entries.push({
        id:        `inv-${inv.id}`,
        date:      inv.invoice_date,
        type:      inv.invoice_type,
        ref:       inv.invoice_no || '—',
        narration: `${meta.label}${inv.reference_no ? ` | Ref: ${inv.reference_no}` : ''}`,
        dr:        inv.grand_total || 0,
        cr:        0,
        sourceId:  inv.id,
        dueDate:   inv.due_date,
        status:    inv.status,
      });
    }

    if (meta.side === 'Cr' && inv.invoice_type === 'credit_note') {
      entries.push({
        id:        `cn-${inv.id}`,
        date:      inv.invoice_date,
        type:      'credit_note',
        ref:       inv.invoice_no || '—',
        narration: 'Credit Note',
        dr:        0,
        cr:        inv.grand_total || 0,
        sourceId:  inv.id,
      });
    }

    const pmts = paymentsMap[inv.id] || [];
    pmts.forEach((pmt) => {
      if (!inRange(pmt.payment_date)) return;
      entries.push({
        id:        `pmt-${pmt.id}`,
        date:      pmt.payment_date,
        type:      'payment',
        ref:       pmt.reference_no || `PMT/${pmt.id?.slice(0, 6)?.toUpperCase() || '—'}`,
        narration: `Payment Received${pmt.payment_mode ? ` via ${pmt.payment_mode.toUpperCase()}` : ''}${pmt.notes ? ` | ${pmt.notes}` : ''}`,
        dr:        0,
        cr:        pmt.amount || 0,
        sourceId:  inv.id,
        paymentMode: pmt.payment_mode,
      });
    });
  });

  entries.sort((a, b) => {
    if (a.type === 'opening') return -1;
    if (b.type === 'opening') return 1;
    const da = new Date(a.date);
    const db = new Date(b.date);
    if (da < db) return -1;
    if (da > db) return 1;
    if (a.type === 'payment' && b.type !== 'payment') return 1;
    if (b.type === 'payment' && a.type !== 'payment') return -1;
    return 0;
  });

  let balance = 0;
  return entries.map((entry) => {
    balance += entry.dr - entry.cr;
    return {
      ...entry,
      runningBalance: balance,
      balanceSide:    balance >= 0 ? 'Dr' : 'Cr',
    };
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// PRINT / PDF  — Title: "Account Statement" — LAYOUT UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════
function printLedger(rows, client, company, dateFrom, dateTo, openingBal) {
  const closingRow  = rows[rows.length - 1];
  const closingBal  = closingRow ? Math.abs(closingRow.runningBalance) : 0;
  const closingSide = closingRow?.balanceSide || 'Dr';
  const totalDr     = rows.reduce((s, r) => s + r.dr, 0);
  const totalCr     = rows.reduce((s, r) => s + r.cr, 0);
  const periodLabel = dateFrom && dateTo
    ? `${format(new Date(dateFrom), 'dd-MMM-yyyy')} to ${format(new Date(dateTo), 'dd-MMM-yyyy')}`
    : 'All time';

  const rowsHtml = rows
    .map((r) => {
      const isOpening = r.type === 'opening';
      const drColor   = r.dr > 0 ? '#1D4ED8' : '#9CA3AF';
      const crColor   = r.cr > 0 ? '#059669' : '#9CA3AF';
      const bgColor   = isOpening ? '#EFF6FF' : 'transparent';
      return `
        <tr style="background:${bgColor}; page-break-inside:avoid;">
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:12.5px; color:#374151; white-space:nowrap;">
            ${isOpening ? '' : format(new Date(r.date), 'dd-MMM-yy')}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:12.5px; color:#111827; font-weight:${isOpening ? '600' : '400'}; max-width:320px; overflow:hidden; text-overflow:ellipsis;">
            ${r.narration}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:12px; color:#6B7280; text-align:center; font-family:monospace;">
            ${r.ref}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:12.5px; text-align:right; color:${drColor}; font-weight:500;">
            ${r.dr > 0 ? fmtN(r.dr) : '—'}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:12.5px; text-align:right; color:${crColor}; font-weight:500;">
            ${r.cr > 0 ? fmtN(r.cr) : '—'}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:12.5px; text-align:right; font-weight:600; color:#111827;">
            ${fmtN(Math.abs(r.runningBalance))}
          </td>
          <td style="padding:8px 12px; border-bottom:1px solid #E5E7EB; font-size:11px; text-align:center;">
            <span style="display:inline-block; padding:2px 8px; border-radius:999px; font-weight:700;
              background:${r.balanceSide === 'Dr' ? '#DBEAFE' : '#D1FAE5'};
              color:${r.balanceSide === 'Dr' ? '#1D4ED8' : '#059669'};">
              ${r.balanceSide}
            </span>
          </td>
        </tr>`;
    })
    .join('');

  const html = `<!DOCTYPE html>
<html>
<head>
  <title>Account Statement</title>
  <style>
    @page { margin: 14mm 12mm; size: A4 landscape; }
    * { box-sizing: border-box; }
    body {
      font-family: 'Segoe UI', Arial, Helvetica, sans-serif;
      margin: 0; padding: 0;
      color: #111827;
      font-size: 13px;
    }
    .page-wrap { padding: 0; }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding-bottom: 16px;
      border-bottom: 2.5px solid #1D4ED8;
      margin-bottom: 18px;
    }
    .header-left h1 {
      margin: 0 0 4px;
      font-size: 22px;
      font-weight: 700;
      color: #1D4ED8;
      letter-spacing: -0.5px;
    }
    .header-left .subtitle {
      font-size: 12px;
      color: #6B7280;
      margin: 0;
    }
    .header-right {
      text-align: right;
      font-size: 12.5px;
      color: #374151;
    }
    .header-right .company-name {
      font-size: 15px;
      font-weight: 700;
      color: #111827;
    }
    .meta-row {
      display: flex;
      gap: 24px;
      margin-bottom: 16px;
      padding: 12px 16px;
      background: #F8FAFC;
      border: 1px solid #E2E8F0;
      border-radius: 8px;
    }
    .meta-item label { font-size: 10px; text-transform: uppercase; color: #9CA3AF; letter-spacing: 0.06em; display:block; margin-bottom:2px; }
    .meta-item span  { font-size: 13px; font-weight: 600; color: #111827; }
    .summary-row {
      display: flex;
      gap: 10px;
      margin-bottom: 18px;
    }
    .summary-box {
      flex: 1;
      border: 1px solid #E2E8F0;
      border-radius: 8px;
      padding: 10px 14px;
    }
    .summary-box label { font-size: 10px; text-transform: uppercase; color: #9CA3AF; letter-spacing: 0.06em; display:block; }
    .summary-box .val  { font-size: 16px; font-weight: 700; margin-top: 2px; }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    colgroup col:nth-child(1) { width: 82px; }
    colgroup col:nth-child(2) { width: auto; }
    colgroup col:nth-child(3) { width: 110px; }
    colgroup col:nth-child(4) { width: 110px; }
    colgroup col:nth-child(5) { width: 110px; }
    colgroup col:nth-child(6) { width: 110px; }
    colgroup col:nth-child(7) { width: 58px; }
    thead tr th {
      background: #1D4ED8;
      color: #fff;
      padding: 10px 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border: none;
    }
    thead tr th:nth-child(4),
    thead tr th:nth-child(5),
    thead tr th:nth-child(6) { text-align: right; }
    thead tr th:nth-child(3),
    thead tr th:nth-child(7) { text-align: center; }
    tfoot tr td {
      background: #1E3A5F;
      color: #fff;
      padding: 11px 12px;
      font-weight: 700;
      font-size: 12.5px;
    }
    tfoot tr td:nth-child(2) { text-align: right; }
    tfoot tr td:nth-child(3) { text-align: right; }
    tfoot tr td:nth-child(4) { text-align: right; }
    tfoot tr td:nth-child(5) { text-align: center; }
    .footer {
      margin-top: 28px;
      padding-top: 12px;
      border-top: 1px solid #E5E7EB;
      font-size: 11px;
      color: #9CA3AF;
      display: flex;
      justify-content: space-between;
    }
    @media print {
      thead { display: table-header-group; }
      tfoot { display: table-footer-group; }
    }
  </style>
</head>
<body>
<div class="page-wrap">
  <div class="header">
    <div class="header-left">
      <h1>Account Statement</h1>
      <p class="subtitle">Party / Client Account Ledger</p>
    </div>
    <div class="header-right">
      <div class="company-name">${company?.name || 'Your Company'}</div>
      <div>${company?.address || ''}</div>
      ${company?.phone ? `<div>Ph: ${company.phone}</div>` : ''}
      ${company?.email ? `<div>${company.email}</div>` : ''}
    </div>
  </div>
  <div class="meta-row">
    <div class="meta-item">
      <label>Party Name</label>
      <span>${client?.company_name || '—'}</span>
    </div>
    ${client?.client_gstin ? `<div class="meta-item"><label>GSTIN</label><span>${client.client_gstin}</span></div>` : ''}
    ${client?.phone ? `<div class="meta-item"><label>Phone</label><span>${client.phone}</span></div>` : ''}
    ${client?.email ? `<div class="meta-item"><label>Email</label><span>${client.email}</span></div>` : ''}
    <div class="meta-item">
      <label>Period</label>
      <span>${periodLabel}</span>
    </div>
    <div class="meta-item">
      <label>Opening Balance</label>
      <span>₹${fmtN(openingBal)}</span>
    </div>
  </div>
  <div class="summary-row">
    <div class="summary-box">
      <label>Total Debit (₹)</label>
      <div class="val" style="color:#1D4ED8;">₹${fmtN(totalDr)}</div>
    </div>
    <div class="summary-box">
      <label>Total Credit (₹)</label>
      <div class="val" style="color:#059669;">₹${fmtN(totalCr)}</div>
    </div>
    <div class="summary-box">
      <label>Closing Balance</label>
      <div class="val" style="color:${closingSide === 'Dr' ? '#DC2626' : '#059669'};">₹${fmtN(closingBal)} ${closingSide}</div>
    </div>
    <div class="summary-box">
      <label>Net (Dr - Cr)</label>
      <div class="val" style="color:#6B7280;">₹${fmtN(Math.abs(totalDr - totalCr))}</div>
    </div>
  </div>
  <table>
    <colgroup>
      <col /><col /><col /><col /><col /><col /><col />
    </colgroup>
    <thead>
      <tr>
        <th style="text-align:left;">Date</th>
        <th style="text-align:left;">Particulars / Description</th>
        <th>Voucher No.</th>
        <th>Debit (₹)</th>
        <th>Credit (₹)</th>
        <th>Balance (₹)</th>
        <th>Dr/Cr</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot>
      <tr>
        <td colspan="3" style="text-align:right;">CLOSING BALANCE</td>
        <td style="text-align:right;">₹${fmtN(totalDr)}</td>
        <td style="text-align:right;">₹${fmtN(totalCr)}</td>
        <td style="text-align:right;">₹${fmtN(closingBal)}</td>
        <td style="text-align:center;">${closingSide}</td>
      </tr>
    </tfoot>
  </table>
  <div class="footer">
    <span>This is a computer-generated Account Statement.</span>
    <span>Generated on ${format(new Date(), 'dd-MMM-yyyy hh:mm a')}</span>
  </div>
</div>
</body>
</html>`;

  const win = window.open('', '_blank', 'width=1400,height=920');
  if (!win) {
    toast.error('Please allow pop-ups to print / save PDF.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.onload = () => { win.focus(); win.print(); };
}

// ════════════════════════════════════════════════════════════════════════════════
// EXCEL EXPORT
// ════════════════════════════════════════════════════════════════════════════════
async function exportLedgerReconciliationExcel(rows, client, company, dateFrom, dateTo, openingBalance) {
  const periodLabel = dateFrom && dateTo
    ? `${format(new Date(dateFrom), 'dd-MMM-yyyy')} – ${format(new Date(dateTo), 'dd-MMM-yyyy')}`
    : 'All time';

  const closingRow  = rows[rows.length - 1];
  const closingBal  = closingRow ? Math.abs(closingRow.runningBalance) : 0;
  const closingSide = closingRow?.balanceSide || 'Dr';
  const totalDr     = rows.filter((r) => r.type !== 'opening').reduce((s, r) => s + r.dr, 0);
  const totalCr     = rows.filter((r) => r.type !== 'opening').reduce((s, r) => s + r.cr, 0);

  const sheetData = [
    ['Account Statement', '', '', '', '', '', '', '', '', '', '', ''],
    [],
    ['Company:',   company?.name    || '', '', '', '', '', '', '', '', '', '', ''],
    ['Address:',   company?.address || '', '', '', '', '', '', '', '', '', '', ''],
    ['Phone:',     company?.phone   || '', '', '', '', '', '', 'Email:', company?.email || '', '', ''],
    ['Party:',     client?.company_name || '', '', '', '', '', '', '', '', '', '', ''],
    ['GSTIN:',     client?.client_gstin || '—', '', '', '', '', '', '', '', '', '', ''],
    ['Period:',    periodLabel, '', '', '', '', '', '', '', 'Generated:', format(new Date(), 'dd-MMM-yyyy'), ''],
    [],
    ['Date', 'Particulars / Description', '', '', '', 'Debit (₹)', '', 'Credit (₹)', '', 'Balance (₹)', '', 'Dr/Cr'],
    ['', 'Opening Balance', '', '', '', '', '', '', '', openingBalance || 0, '', ''],
  ];

  rows.forEach((r) => {
    if (r.type === 'opening') return;
    const dateStr = r.date ? format(new Date(r.date), 'dd/MM/yyyy') : '';
    sheetData.push([
      dateStr,
      r.narration, '', '', '',
      r.dr > 0 ? r.dr : '', '',
      r.cr > 0 ? r.cr : '', '',
      Math.abs(r.runningBalance), '',
      r.balanceSide,
    ]);
  });

  sheetData.push(['', 'Closing Balance', '', '', '', '', '', '', '', closingBal, '', closingSide]);
  sheetData.push(['', 'Total',           '', '', '', totalDr,      '', totalCr,   '', '',          '', '']);

  const XLSX = await getXLSX();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);

  ws['!merges'] = [
    { s: { r: 0,  c: 0 }, e: { r: 0,  c: 11 } },
    { s: { r: 2,  c: 0 }, e: { r: 2,  c: 11 } },
    { s: { r: 3,  c: 0 }, e: { r: 3,  c: 11 } },
    { s: { r: 4,  c: 0 }, e: { r: 4,  c: 5  } },
    { s: { r: 4,  c: 7 }, e: { r: 4,  c: 11 } },
    { s: { r: 5,  c: 0 }, e: { r: 5,  c: 11 } },
    { s: { r: 6,  c: 0 }, e: { r: 6,  c: 11 } },
    { s: { r: 7,  c: 0 }, e: { r: 7,  c: 7  } },
    { s: { r: 9,  c: 1 }, e: { r: 9,  c: 4  } },
    { s: { r: 10, c: 1 }, e: { r: 10, c: 4  } },
  ];

  ws['!cols'] = [
    { wch: 12 }, { wch: 48 }, { wch: 6 }, { wch: 6 }, { wch: 6 },
    { wch: 16 }, { wch: 6 }, { wch: 16 }, { wch: 6 },
    { wch: 16 }, { wch: 6 }, { wch: 8 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Account Statement');

  const clientName = (client?.company_name || 'party').replace(/[^a-zA-Z0-9]/g, '_');
  XLSX.writeFile(wb, `Account_Statement_${clientName}_${format(new Date(), 'dd-MMM-yyyy')}.xlsx`);
  toast.success('Account Statement exported successfully');
}

// ════════════════════════════════════════════════════════════════════════════════
// SUMMARY CARD
// ════════════════════════════════════════════════════════════════════════════════
function SummaryCard({ label, value, color, icon: Icon, isDark }) {
  return (
    <div className={`flex items-center gap-3 rounded-2xl px-4 py-3 border min-w-0
      ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200 shadow-sm'}`}
    >
      {Icon && (
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: `${color}18` }}>
          <Icon className="w-4 h-4" style={{ color }} />
        </div>
      )}
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 leading-none mb-1">{label}</div>
        <div className="text-base font-bold leading-none truncate" style={{ color }}>{value}</div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// AGING PILL
// ════════════════════════════════════════════════════════════════════════════════
function AgingPill({ bucket, amount, total, isDark }) {
  const colorMap = {
    '0-30':  { bg: '#DCFCE7', text: '#15803D', bar: '#22c55e' },
    '31-60': { bg: '#FEF9C3', text: '#A16207', bar: '#eab308' },
    '61-90': { bg: '#FFEDD5', text: '#C2410C', bar: '#f97316' },
    '90+':   { bg: '#FEE2E2', text: '#B91C1C', bar: '#ef4444' },
  };
  const c = colorMap[bucket] || colorMap['0-30'];
  const pct = total > 0 ? Math.round((amount / total) * 100) : 0;

  return (
    <div className={`flex flex-col rounded-xl px-3 py-2.5 flex-1 min-w-0 border
      ${isDark ? 'bg-slate-700/60 border-slate-600' : 'border-transparent'}`}
      style={isDark ? {} : { background: c.bg }}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] font-bold uppercase tracking-wider"
          style={{ color: isDark ? '#94a3b8' : c.text }}>{bucket} days
        </div>
        {pct > 0 && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
            style={{ background: isDark ? '#1e293b' : `${c.bar}20`, color: isDark ? '#94a3b8' : c.text }}>
            {pct}%
          </span>
        )}
      </div>
      <div className="text-xs font-bold truncate mb-1.5"
        style={{ color: isDark ? '#e2e8f0' : c.text }}>
        {fmtC(amount)}
      </div>
      {/* Mini bar */}
      <div className={`h-1 rounded-full overflow-hidden ${isDark ? 'bg-slate-600' : 'bg-white/60'}`}>
        <div className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: c.bar }} />
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// SMART ANALYTICS PANEL  (UI-only, no backend, no PDF)
// ════════════════════════════════════════════════════════════════════════════════
function SmartAnalyticsPanel({ invoices, paymentsMap, isDark }) {
  const [expanded, setExpanded] = useState(false);

  // ── Compute all smart metrics from existing data ──
  const metrics = useMemo(() => {
    if (!invoices.length) return null;

    const today = new Date();

    // 1. Total invoiced & collected
    const totalInvoiced  = invoices.reduce((s, i) => s + (i.grand_total || 0), 0);
    const totalCollected = invoices.reduce((s, i) => s + (i.amount_paid || 0), 0);
    const totalDue       = invoices.reduce((s, i) => s + (i.amount_due  || 0), 0);

    // 2. Collection Efficiency %
    const collectionEfficiency = totalInvoiced > 0
      ? Math.round((totalCollected / totalInvoiced) * 100)
      : 0;

    // 3. DSO — Days Sales Outstanding
    //    Average days from invoice date to today for unpaid invoices
    const unpaidInvoices = invoices.filter(i => (i.amount_due || 0) > 0 && i.invoice_date);
    const dso = unpaidInvoices.length > 0
      ? Math.round(
          unpaidInvoices.reduce((s, i) => s + differenceInDays(today, parseISO(i.invoice_date)), 0)
          / unpaidInvoices.length
        )
      : 0;

    // 4. Average Days to Pay (for PAID invoices)
    const paidWithDates = invoices.filter(i =>
      i.status === 'paid' && i.invoice_date
    );
    let avgDaysToPay = null;
    if (paidWithDates.length > 0) {
      const daysArr = paidWithDates.map(inv => {
        const pmts = paymentsMap[inv.id] || [];
        if (!pmts.length) return null;
        const lastPmt = pmts.reduce((a, b) =>
          new Date(a.payment_date) > new Date(b.payment_date) ? a : b
        );
        return lastPmt.payment_date
          ? differenceInDays(parseISO(lastPmt.payment_date), parseISO(inv.invoice_date))
          : null;
      }).filter(d => d !== null && d >= 0);
      avgDaysToPay = daysArr.length > 0
        ? Math.round(daysArr.reduce((s, d) => s + d, 0) / daysArr.length)
        : null;
    }

    // 5. Payment Mode Breakdown
    const modeMap = {};
    Object.values(paymentsMap).flat().forEach(pmt => {
      const mode = (pmt.payment_mode || 'other').toUpperCase();
      modeMap[mode] = (modeMap[mode] || 0) + (pmt.amount || 0);
    });
    const paymentModes = Object.entries(modeMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    const totalModeAmt = paymentModes.reduce((s, [, v]) => s + v, 0);

    // 6. On-time vs Late payment count
    let onTimeCount = 0, lateCount = 0;
    invoices.forEach(inv => {
      if (!inv.due_date) return;
      const pmts = paymentsMap[inv.id] || [];
      pmts.forEach(pmt => {
        if (!pmt.payment_date) return;
        const daysLate = differenceInDays(parseISO(pmt.payment_date), parseISO(inv.due_date));
        if (daysLate <= 0) onTimeCount++; else lateCount++;
      });
    });

    // 7. Overdue Risk Score (0–100)
    //    = weighted by amount + days overdue
    const overdueInvoices = invoices.filter(i =>
      (i.amount_due || 0) > 0 && i.due_date &&
      differenceInDays(today, parseISO(i.due_date)) > 0
    );
    let riskScore = 0;
    if (totalDue > 0 && overdueInvoices.length > 0) {
      const overdueAmt = overdueInvoices.reduce((s, i) => s + i.amount_due, 0);
      const avgOverdueDays = overdueInvoices.reduce((s, i) =>
        s + differenceInDays(today, parseISO(i.due_date)), 0
      ) / overdueInvoices.length;
      riskScore = Math.min(100, Math.round(
        (overdueAmt / totalDue) * 60 +
        Math.min(avgOverdueDays / 180 * 40, 40)
      ));
    }

    // 8. Top unpaid invoices (by amount due, descending)
    const topUnpaid = [...invoices]
      .filter(i => (i.amount_due || 0) > 0)
      .sort((a, b) => b.amount_due - a.amount_due)
      .slice(0, 5);

    // 9. Invoice count stats
    const totalCount   = invoices.length;
    const paidCount    = invoices.filter(i => i.status === 'paid').length;
    const overdueCount = overdueInvoices.length;
    const partialCount = invoices.filter(i => i.status === 'partially_paid').length;

    return {
      totalInvoiced, totalCollected, totalDue,
      collectionEfficiency, dso, avgDaysToPay,
      paymentModes, totalModeAmt,
      onTimeCount, lateCount,
      riskScore, topUnpaid,
      totalCount, paidCount, overdueCount, partialCount,
    };
  }, [invoices, paymentsMap]);

  if (!metrics) return null;

  const card = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';

  // Risk color
  const riskColor = metrics.riskScore >= 70 ? '#ef4444'
    : metrics.riskScore >= 40 ? '#f97316'
    : '#22c55e';
  const riskLabel = metrics.riskScore >= 70 ? 'High Risk'
    : metrics.riskScore >= 40 ? 'Medium Risk'
    : 'Low Risk';

  // Efficiency color
  const effColor = metrics.collectionEfficiency >= 80 ? '#22c55e'
    : metrics.collectionEfficiency >= 50 ? '#f97316'
    : '#ef4444';

  return (
    <div className={`rounded-2xl border ${card} overflow-hidden`}>
      {/* Panel header — always visible, toggleable */}
      <button
        type="button"
        onClick={() => setExpanded(e => !e)}
        className={`w-full flex items-center justify-between px-4 py-3 transition-colors
          ${isDark ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50/60'}`}
      >
        <div className="flex items-center gap-2.5">
          <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0
            ${isDark ? 'bg-violet-900/50' : 'bg-violet-50'}`}>
            <BarChart2 className="w-3.5 h-3.5 text-violet-500" />
          </div>
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Smart Analytics</span>
          {/* Quick KPI chips — always visible */}
          <div className="flex items-center gap-1.5 ml-2 flex-wrap">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: `${effColor}18`, color: effColor }}>
              {metrics.collectionEfficiency}% collected
            </span>
            {metrics.dso > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                style={{ background: '#1d4ed818', color: '#1d4ed8' }}>
                DSO {metrics.dso}d
              </span>
            )}
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
              style={{ background: `${riskColor}18`, color: riskColor }}>
              {riskLabel}
            </span>
          </div>
        </div>
        <ChevronRight className={`w-4 h-4 ${muted} transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} />
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className={`px-4 pb-4 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-3">

            {/* Collection Efficiency */}
            <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50'}`}>
              <div className={`text-[9px] font-bold uppercase tracking-wider mb-1 ${muted}`}>Collection Efficiency</div>
              <div className="text-xl font-black" style={{ color: effColor }}>{metrics.collectionEfficiency}%</div>
              <div className={`h-1.5 rounded-full mt-2 overflow-hidden ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`}>
                <div className="h-full rounded-full" style={{ width: `${metrics.collectionEfficiency}%`, background: effColor }} />
              </div>
              <div className={`text-[9px] mt-1.5 ${muted}`}>{fmtC(metrics.totalCollected)} of {fmtC(metrics.totalInvoiced)}</div>
            </div>

            {/* DSO */}
            <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50'}`}>
              <div className={`text-[9px] font-bold uppercase tracking-wider mb-1 ${muted}`}>Days Sales Outstanding</div>
              <div className="text-xl font-black text-blue-600">{metrics.dso > 0 ? `${metrics.dso}d` : '—'}</div>
              <div className={`text-[9px] mt-1 ${muted}`}>Avg age of unpaid invoices</div>
              {metrics.avgDaysToPay !== null && (
                <div className="text-[10px] font-semibold text-emerald-600 mt-1.5">
                  Avg paid in {metrics.avgDaysToPay}d
                </div>
              )}
            </div>

            {/* Risk Score */}
            <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50'}`}>
              <div className={`text-[9px] font-bold uppercase tracking-wider mb-1 ${muted}`}>Overdue Risk Score</div>
              <div className="text-xl font-black" style={{ color: riskColor }}>{metrics.riskScore}/100</div>
              <div className={`h-1.5 rounded-full mt-2 overflow-hidden ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`}>
                <div className="h-full rounded-full" style={{ width: `${metrics.riskScore}%`, background: riskColor }} />
              </div>
              <div className={`text-[9px] mt-1.5 font-semibold`} style={{ color: riskColor }}>{riskLabel}</div>
            </div>

            {/* Payment Pattern */}
            <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50'}`}>
              <div className={`text-[9px] font-bold uppercase tracking-wider mb-1 ${muted}`}>Payment Pattern</div>
              <div className="flex items-end gap-2 mt-1">
                <div className="text-center">
                  <div className="text-lg font-black text-emerald-600">{metrics.onTimeCount}</div>
                  <div className={`text-[8px] font-semibold ${muted}`}>On-time</div>
                </div>
                <div className={`text-xl font-light ${muted} pb-1`}>/</div>
                <div className="text-center">
                  <div className="text-lg font-black text-red-500">{metrics.lateCount}</div>
                  <div className={`text-[8px] font-semibold ${muted}`}>Late</div>
                </div>
              </div>
              <div className={`text-[9px] mt-1.5 ${muted}`}>
                {metrics.paidCount} paid · {metrics.overdueCount} overdue · {metrics.partialCount} partial
              </div>
            </div>
          </div>

          {/* Bottom row: Payment Modes + Top Unpaid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">

            {/* Payment Mode Breakdown */}
            {metrics.paymentModes.length > 0 && (
              <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50'}`}>
                <div className={`text-[9px] font-bold uppercase tracking-wider mb-2 ${muted}`}>
                  <CreditCard className="w-3 h-3 inline mr-1" />Payment Mode Breakdown
                </div>
                <div className="space-y-1.5">
                  {metrics.paymentModes.map(([mode, amt]) => {
                    const pct = metrics.totalModeAmt > 0 ? Math.round((amt / metrics.totalModeAmt) * 100) : 0;
                    return (
                      <div key={mode} className="flex items-center gap-2">
                        <div className={`text-[10px] font-bold w-14 flex-shrink-0 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{mode}</div>
                        <div className={`flex-1 h-2 rounded-full overflow-hidden ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`}>
                          <div className="h-full rounded-full bg-blue-500" style={{ width: `${pct}%` }} />
                        </div>
                        <div className={`text-[10px] font-semibold w-8 text-right flex-shrink-0 ${muted}`}>{pct}%</div>
                        <div className={`text-[10px] font-semibold w-20 text-right flex-shrink-0 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{fmtC(amt)}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Top Unpaid Invoices */}
            {metrics.topUnpaid.length > 0 && (
              <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50'}`}>
                <div className={`text-[9px] font-bold uppercase tracking-wider mb-2 ${muted}`}>
                  <AlertCircle className="w-3 h-3 inline mr-1 text-amber-500" />Top Unpaid Invoices
                </div>
                <div className="space-y-1.5">
                  {metrics.topUnpaid.map((inv, i) => {
                    const daysOld = inv.invoice_date
                      ? differenceInDays(new Date(), parseISO(inv.invoice_date))
                      : null;
                    const isOverdue = inv.due_date &&
                      differenceInDays(new Date(), parseISO(inv.due_date)) > 0;
                    return (
                      <div key={inv.id} className="flex items-center gap-2">
                        <div className={`text-[9px] font-bold w-4 flex-shrink-0 ${muted}`}>#{i + 1}</div>
                        <div className={`text-[10px] font-mono truncate flex-1 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                          {inv.invoice_no || '—'}
                        </div>
                        {isOverdue && (
                          <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600 flex-shrink-0">OD</span>
                        )}
                        {daysOld !== null && (
                          <div className={`text-[9px] flex-shrink-0 ${muted}`}>{daysOld}d</div>
                        )}
                        <div className="text-[10px] font-bold text-red-600 flex-shrink-0 w-20 text-right">
                          {fmtC(inv.amount_due)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════════
export default function PartyLedger({
  open,
  onClose,
  invoices  = [],
  clients   = [],
  companies = [],
  preselectedClientName = null,
  initialClient = null,
  isDark,
}) {
  const [clientId,      setClientId]      = useState(null);
  const [presetId,      setPresetId]      = useState('curFY');
  const [dateFrom,      setDateFrom]      = useState(DATE_PRESETS[0].from);
  const [dateTo,        setDateTo]        = useState(DATE_PRESETS[0].to);
  const [openingBal,    setOpeningBal]    = useState(0);
  const [paymentsMap,   setPaymentsMap]   = useState({});
  const [loadingPmts,   setLoadingPmts]   = useState(false);
  const [companyFilter, setCompanyFilter] = useState('all'); // 'all' or company.id

  // Pre-select client via name or id
  useEffect(() => {
    if (!open) return;
    if (initialClient) {
      setClientId(typeof initialClient === 'string' ? initialClient : initialClient.id);
      return;
    }
    if (preselectedClientName) {
      const match = clients.find(
        (c) => c.company_name?.toLowerCase() === preselectedClientName.toLowerCase()
      );
      if (match) setClientId(match.id);
      return;
    }
    setClientId(null);
  }, [open, preselectedClientName, initialClient, clients]);

  // Filter invoices for selected client + company
  const clientInvoices = useMemo(() => {
    if (!clientId) return [];
    const client = clients.find((c) => c.id === clientId);
    if (!client) return [];
    let filtered = invoices.filter(
      (inv) => inv.client_name === client.company_name || inv.client_id === clientId
    );
    if (companyFilter !== 'all') {
      filtered = filtered.filter((inv) => inv.company_id === companyFilter);
    }
    return filtered;
  }, [invoices, clientId, clients, companyFilter]);

  // Fetch payments
  useEffect(() => {
    if (!clientInvoices.length) { setPaymentsMap({}); return; }
    setLoadingPmts(true);
    Promise.all(
      clientInvoices.map((inv) =>
        api
          .get('/payments', { params: { invoice_id: inv.id } })
          .then((r) => [inv.id, r.data || []])
          .catch(()  => [inv.id, []])
      )
    ).then((results) => {
      const map = {};
      results.forEach(([id, pmts]) => { map[id] = pmts; });
      setPaymentsMap(map);
    }).finally(() => setLoadingPmts(false));
  }, [clientInvoices]);

  const handlePreset = useCallback((id) => {
    setPresetId(id);
    const p = DATE_PRESETS.find((d) => d.id === id);
    if (p && id !== 'custom') { setDateFrom(p.from); setDateTo(p.to); }
  }, []);

  const rows = useMemo(
    () => buildLedger(clientInvoices, paymentsMap, Number(openingBal) || 0, dateFrom, dateTo),
    [clientInvoices, paymentsMap, openingBal, dateFrom, dateTo]
  );

  const agingSummary = useMemo(() => {
    const buckets = { '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    clientInvoices.forEach((i) => {
      if (i.amount_due > 0 && i.due_date) {
        const b = agingBucket(i.due_date);
        if (b) buckets[b] += i.amount_due;
      }
    });
    return buckets;
  }, [clientInvoices]);

  const agingTotal = useMemo(
    () => Object.values(agingSummary).reduce((s, v) => s + v, 0),
    [agingSummary]
  );

  const summary = useMemo(() => {
    const overdueAmt = clientInvoices
      .filter((i) => i.amount_due > 0 && i.due_date && differenceInDays(new Date(), parseISO(i.due_date)) > 0)
      .reduce((s, i) => s + i.amount_due, 0);
    const closingRow  = rows[rows.length - 1];
    const closingBal  = closingRow ? Math.abs(closingRow.runningBalance) : 0;
    const closingSide = closingRow?.balanceSide || 'Dr';
    const totalDr     = rows.reduce((s, r) => s + r.dr, 0);
    const totalCr     = rows.reduce((s, r) => s + r.cr, 0);
    return { overdueAmt, closingBal, closingSide, totalDr, totalCr };
  }, [rows, clientInvoices]);

  const selectedClient  = clients.find((c) => c.id === clientId) || null;
  const selectedCompany = (companyFilter !== 'all' ? (companies.find((co) => co.id === companyFilter) || companies[0]) : companies[0]) || null;
  const hasData         = rows.length > 1;

  const handlePrint       = () => printLedger(rows, selectedClient, selectedCompany, dateFrom, dateTo, openingBal);
  const handleExportExcel = () => exportLedgerReconciliationExcel(rows, selectedClient, selectedCompany, dateFrom, dateTo, openingBal);

  // ── Style helpers ──
  const surface   = isDark ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-900';
  const card      = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const divider   = isDark ? 'border-slate-700' : 'border-slate-200';
  const labelCls  = 'text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1 block';
  const inputBase = `h-9 rounded-xl text-sm border focus:ring-1 focus:ring-blue-300 focus:border-blue-400 transition-colors
    ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-200'}`;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        hideClose
        className={`max-w-[96vw] w-[1280px] p-0 rounded-3xl border-0 shadow-2xl flex flex-col overflow-hidden ${surface}`}
        style={{ maxHeight: '94vh', height: '94vh' }}
      >

        {/* ── HEADER BAR ────────────────────────────────────── */}
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 px-7 py-5" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-white/15">
              <BookOpen className="w-5 h-5 text-white" />
            </div>
            <div className="min-w-0">
              <DialogTitle className="text-xl font-bold leading-snug text-white">Party Ledger</DialogTitle>
              <DialogDescription className="text-[12px] text-white/75 mt-0.5 leading-snug">
                Account Statement · Invoice · Payment · Credit/Debit Note
              </DialogDescription>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {selectedClient && hasData && (
              <>
                <Button
                  onClick={handleExportExcel}
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs font-medium rounded-xl h-9 px-4 border-white/30 bg-white/10 text-white hover:bg-white/20 hover:text-white"
                >
                  <Download className="w-3.5 h-3.5" />
                  Export Excel
                </Button>
                <Button
                  onClick={handlePrint}
                  size="sm"
                  className="gap-1.5 text-xs font-semibold rounded-xl h-9 px-4 bg-white hover:bg-white/90 text-[#0D3B66]"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print / PDF
                </Button>
              </>
            )}
            <Button
              onClick={onClose}
              variant="ghost"
              size="icon"
              aria-label="Close"
              className="w-8 h-8 rounded-xl flex-shrink-0 bg-white/15 text-white hover:bg-white/25 hover:text-white"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* ── FILTER BAR ────────────────────────────────────── */}
        <div className={`flex-shrink-0 px-7 py-4 border-b ${divider} ${isDark ? 'bg-slate-800/60' : 'bg-white'}`}>
          <div className="flex items-end gap-5">

            {/* Client search */}
            <div className="w-72 flex-shrink-0">
              <span className={labelCls}>Party / Client</span>
              <ClientCombobox clients={clients} value={clientId} onChange={setClientId} isDark={isDark} />
            </div>

            {/* Company filter */}
            {companies.length > 1 && (
              <div className="flex-shrink-0 w-52">
                <span className={labelCls}>Our Company</span>
                <div className="relative">
                  <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                  <select
                    value={companyFilter}
                    onChange={(e) => setCompanyFilter(e.target.value)}
                    className={`${inputBase} pl-8 pr-3 w-full appearance-none cursor-pointer`}
                  >
                    <option value="all">All Companies</option>
                    {companies.map((co) => (
                      <option key={co.id} value={co.id}>{co.name}</option>
                    ))}
                  </select>
                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-400 pointer-events-none" />
                </div>
              </div>
            )}

            {/* Period presets */}
            <div className="flex-1 min-w-0">
              <span className={labelCls}>Period</span>
              <div className="flex flex-wrap gap-1.5">
                {DATE_PRESETS.filter((p) => p.id !== 'custom').map((p) => (
                  <button
                    key={p.id}
                    onClick={() => handlePreset(p.id)}
                    className={`px-3 h-9 text-xs font-semibold rounded-xl border transition-all whitespace-nowrap
                      ${presetId === p.id
                        ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                        : isDark
                          ? 'bg-slate-700 text-slate-300 border-slate-600 hover:border-blue-500 hover:text-blue-400'
                          : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600'
                      }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom date range */}
            <div className="flex items-end gap-2 flex-shrink-0">
              <div>
                <span className={labelCls}>From</span>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setPresetId('custom'); }}
                  className={`${inputBase} w-36`}
                />
              </div>
              <span className="text-slate-400 pb-2 text-sm">—</span>
              <div>
                <span className={labelCls}>To</span>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setPresetId('custom'); }}
                  className={`${inputBase} w-36`}
                />
              </div>
            </div>

            {/* Opening balance */}
            <div className="flex-shrink-0 w-40">
              <span className={labelCls}>Opening Balance (₹)</span>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm pointer-events-none">₹</span>
                <Input
                  type="number"
                  value={openingBal}
                  onChange={(e) => setOpeningBal(parseFloat(e.target.value) || 0)}
                  className={`${inputBase} pl-7`}
                />
              </div>
            </div>
          </div>
        </div>

        {/* ── SCROLLABLE BODY ───────────────────────────────── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {!selectedClient ? (

            /* Empty state */
            <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-4">
              <div className={`w-20 h-20 rounded-3xl flex items-center justify-center ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <Search className="w-9 h-9 text-slate-400" />
              </div>
              <div className="text-center">
                <p className="text-base font-semibold text-slate-500">No party selected</p>
                <p className="text-sm mt-1">Search and select a party to view the account statement</p>
              </div>
            </div>

          ) : (
            <div className="flex flex-col h-full">

              {/* ── CLIENT INFO + SUMMARY STRIP ── */}
              <div className={`flex-shrink-0 px-7 py-4 border-b ${divider} ${isDark ? 'bg-slate-800/40' : 'bg-gradient-to-r from-blue-50/60 to-white'}`}>

                {/* Party info row */}
                <div className="flex items-center gap-4 mb-4">
                  <div
                    className="w-11 h-11 rounded-2xl flex items-center justify-center text-white text-xl font-bold flex-shrink-0 shadow-sm"
                    style={{ background: avatarGrad(selectedClient.company_name) }}
                  >
                    {selectedClient.company_name?.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-bold text-base leading-tight truncate">{selectedClient.company_name}</div>
                    <div className="flex items-center gap-4 text-xs text-slate-500 mt-0.5 flex-wrap">
                      {selectedClient.phone && (
                        <span className="flex items-center gap-1">
                          <span>📞</span>
                          <span>{selectedClient.phone}</span>
                        </span>
                      )}
                      {selectedClient.email && (
                        <span className="flex items-center gap-1">
                          <span>✉</span>
                          <span className="truncate max-w-[200px]">{selectedClient.email}</span>
                        </span>
                      )}
                      {selectedClient.client_gstin && (
                        <span className={`px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                          GST: {selectedClient.client_gstin}
                        </span>
                      )}
                      {/* Invoice count badge */}
                      <span className={`px-2 py-0.5 rounded-md text-[10px] font-semibold ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-blue-50 text-blue-600'}`}>
                        {clientInvoices.length} invoice{clientInvoices.length !== 1 ? 's' : ''}
                      </span>
                      {/* Active company filter badge */}
                      {companyFilter !== 'all' && (() => {
                        const co = companies.find(c => c.id === companyFilter);
                        return co ? (
                          <span className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold ${isDark ? 'bg-violet-900/40 text-violet-300' : 'bg-violet-50 text-violet-600'}`}>
                            <Building2 className="w-2.5 h-2.5" />
                            {co.name}
                          </span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                </div>

                {/* Summary cards row */}
                <div className="grid grid-cols-8 gap-2 mb-3">
                  <div className="col-span-2">
                    <SummaryCard
                      label="Total Invoiced"
                      value={fmtC(summary.totalDr)}
                      color="#1D4ED8"
                      icon={TrendingUp}
                      isDark={isDark}
                    />
                  </div>
                  <div className="col-span-2">
                    <SummaryCard
                      label="Total Received"
                      value={fmtC(summary.totalCr)}
                      color="#059669"
                      icon={TrendingDown}
                      isDark={isDark}
                    />
                  </div>
                  <div className="col-span-2">
                    <SummaryCard
                      label="Outstanding"
                      value={`${fmtC(summary.closingBal)} ${summary.closingSide}`}
                      color={summary.closingSide === 'Dr' ? '#DC2626' : '#059669'}
                      icon={AlertCircle}
                      isDark={isDark}
                    />
                  </div>
                  <div className="col-span-2">
                    <SummaryCard
                      label="Overdue"
                      value={fmtC(summary.overdueAmt)}
                      color="#D97706"
                      icon={Clock}
                      isDark={isDark}
                    />
                  </div>
                </div>

                {/* Aging Analysis */}
                {Object.values(agingSummary).some((v) => v > 0) && (
                  <div className={`rounded-2xl border p-3 mb-3 ${card}`}>
                    <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">
                      Aging Analysis · Overdue Receivables
                    </div>
                    <div className="flex gap-2">
                      {Object.entries(agingSummary).map(([bucket, amount]) => (
                        <AgingPill key={bucket} bucket={bucket} amount={amount} total={agingTotal} isDark={isDark} />
                      ))}
                    </div>
                  </div>
                )}

                {/* Smart Analytics Panel */}
                {clientInvoices.length > 0 && (
                  <SmartAnalyticsPanel
                    invoices={clientInvoices}
                    paymentsMap={paymentsMap}
                    isDark={isDark}
                  />
                )}
              </div>

              {/* ── LEDGER TABLE ── */}
              <div className="flex-1 overflow-auto px-7 py-5">
                {loadingPmts ? (
                  <MiniLoader height={192} />
                ) : !hasData ? (
                  <div className="flex flex-col items-center justify-center h-48 text-slate-400 gap-2">
                    <BookOpen className="w-10 h-10 opacity-40" />
                    <p className="text-sm">No transactions in selected period</p>
                  </div>
                ) : (
                  <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                    <table
                      className="w-full border-collapse"
                      style={{ tableLayout: 'fixed', minWidth: 900 }}
                    >
                      <colgroup>
                        <col style={{ width: 90  }} />
                        <col />
                        <col style={{ width: 130 }} />
                        <col style={{ width: 120 }} />
                        <col style={{ width: 120 }} />
                        <col style={{ width: 120 }} />
                        <col style={{ width: 64  }} />
                      </colgroup>

                      <thead>
                        <tr className={`text-[11px] font-semibold uppercase tracking-wider
                          ${isDark ? 'bg-slate-700/80 text-slate-400' : 'bg-slate-100 text-slate-500'}`}
                        >
                          <th className="px-4 py-3.5 text-left whitespace-nowrap">Date</th>
                          <th className="px-4 py-3.5 text-left">Particulars / Description</th>
                          <th className="px-4 py-3.5 text-center whitespace-nowrap">Voucher No.</th>
                          <th className="px-4 py-3.5 text-right whitespace-nowrap">Debit (₹)</th>
                          <th className="px-4 py-3.5 text-right whitespace-nowrap">Credit (₹)</th>
                          <th className="px-4 py-3.5 text-right whitespace-nowrap">Balance (₹)</th>
                          <th className="px-4 py-3.5 text-center">Dr/Cr</th>
                        </tr>
                      </thead>

                      <tbody>
                        {rows.map((row, idx) => {
                          const isOpening = row.type === 'opening';
                          const isPayment = row.type === 'payment';

                          const rowBg = isOpening
                            ? isDark ? 'bg-blue-900/20' : 'bg-blue-50'
                            : idx % 2 === 0
                              ? isDark ? 'bg-slate-900' : 'bg-white'
                              : isDark ? 'bg-slate-800/40' : 'bg-slate-50/60';

                          // Highlight overdue invoice rows
                          const isOverdueRow = !isOpening && !isPayment &&
                            row.dueDate &&
                            differenceInDays(new Date(), parseISO(row.dueDate)) > 0 &&
                            row.dr > 0;

                          return (
                            <tr
                              key={row.id}
                              className={`border-b transition-colors ${rowBg} ${isDark ? 'border-slate-700/60' : 'border-slate-100'}
                                ${!isOpening ? (isDark ? 'hover:bg-slate-700/30' : 'hover:bg-blue-50/40') : ''}`}
                            >
                              {/* Date */}
                              <td className={`px-4 py-3.5 text-sm whitespace-nowrap ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                {isOpening ? '' : format(new Date(row.date), 'dd MMM yy')}
                              </td>

                              {/* Narration */}
                              <td className="px-4 py-3.5 min-w-0">
                                <div className="flex items-center gap-1.5 min-w-0">
                                  <div
                                    className={`text-sm font-medium truncate flex-1 ${isOpening ? 'font-semibold' : ''}
                                      ${isDark ? 'text-slate-200' : 'text-slate-800'}`}
                                    title={row.narration}
                                  >
                                    {row.narration}
                                  </div>
                                  {/* Overdue badge on invoice rows */}
                                  {isOverdueRow && (
                                    <span className="flex-shrink-0 text-[8px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 text-red-600">
                                      OVERDUE
                                    </span>
                                  )}
                                  {/* Payment mode badge */}
                                  {isPayment && row.paymentMode && (
                                    <span className={`flex-shrink-0 text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase
                                      ${isDark ? 'bg-emerald-900/40 text-emerald-400' : 'bg-emerald-50 text-emerald-600'}`}>
                                      {row.paymentMode}
                                    </span>
                                  )}
                                </div>
                              </td>

                              {/* Voucher */}
                              <td className={`px-4 py-3.5 text-center font-mono text-xs truncate
                                ${isDark ? 'text-slate-400' : 'text-slate-500'}`}
                                title={row.ref}
                              >
                                {row.ref}
                              </td>

                              {/* Debit */}
                              <td className="px-4 py-3.5 text-right text-sm font-semibold text-blue-600">
                                {row.dr > 0 ? fmtN(row.dr) : (
                                  <span className={isDark ? 'text-slate-600' : 'text-slate-300'}>—</span>
                                )}
                              </td>

                              {/* Credit */}
                              <td className="px-4 py-3.5 text-right text-sm font-semibold text-emerald-600">
                                {row.cr > 0 ? fmtN(row.cr) : (
                                  <span className={isDark ? 'text-slate-600' : 'text-slate-300'}>—</span>
                                )}
                              </td>

                              {/* Balance */}
                              <td className={`px-4 py-3.5 text-right text-sm font-bold
                                ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                                {fmtN(Math.abs(row.runningBalance))}
                              </td>

                              {/* Dr/Cr badge */}
                              <td className="px-4 py-3.5 text-center">
                                <span
                                  className={`inline-block px-2.5 py-0.5 text-[11px] font-bold rounded-full
                                    ${row.balanceSide === 'Dr'
                                      ? isDark ? 'bg-blue-900/50 text-blue-400' : 'bg-blue-100 text-blue-700'
                                      : isDark ? 'bg-emerald-900/50 text-emerald-400' : 'bg-emerald-100 text-emerald-700'
                                    }`}
                                >
                                  {row.balanceSide}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>

                      {/* Footer totals */}
                      <tfoot>
                        <tr className="bg-gradient-to-r from-blue-700 to-blue-800 text-white">
                          <td className="px-4 py-4 text-sm font-bold" colSpan={3}>
                            CLOSING BALANCE
                          </td>
                          <td className="px-4 py-4 text-right text-sm font-semibold">
                            {fmtN(summary.totalDr)}
                          </td>
                          <td className="px-4 py-4 text-right text-sm font-semibold">
                            {fmtN(summary.totalCr)}
                          </td>
                          <td className="px-4 py-4 text-right text-base font-bold">
                            {fmtN(summary.closingBal)}
                          </td>
                          <td className="px-4 py-4 text-center">
                            <span className={`inline-block px-2.5 py-0.5 text-[11px] font-bold rounded-full
                              ${summary.closingSide === 'Dr'
                                ? 'bg-blue-500/40 text-blue-100'
                                : 'bg-emerald-500/40 text-emerald-100'}`}
                            >
                              {summary.closingSide}
                            </span>
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── FOOTER BAR ──────────────────────────────────── */}
        {selectedClient && hasData && (
          <div className={`flex-shrink-0 flex items-center justify-between px-7 py-3 border-t text-xs ${divider}
            ${isDark ? 'bg-slate-900 text-slate-400' : 'bg-white text-slate-500'}`}
          >
            <span>
              {rows.length - 1} transaction{rows.length - 1 !== 1 ? 's' : ''} ·{' '}
              {dateFrom && dateTo
                ? `${format(new Date(dateFrom), 'dd MMM yyyy')} – ${format(new Date(dateTo), 'dd MMM yyyy')}`
                : 'All time'}
            </span>
            <span className="flex items-center gap-1">
              <Info className="w-3 h-3" />
              Computer-generated statement
            </span>
          </div>
        )}

      </DialogContent>
    </Dialog>
  );
}
