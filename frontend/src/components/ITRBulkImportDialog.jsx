/**
 * ITRBulkImportDialog.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Bulk-import ITR clients from the standard Income Tax software Excel export.
 *
 * UPDATE: Preview step now shows ALL parsed rows (not just first 100),
 * with search, inline edit, and delete-row support before import.
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  FileSpreadsheet, Upload, Download, CheckCircle2,
  XCircle, Loader2, AlertCircle, ChevronDown, ChevronUp,
  X, FileText, Eye, Pencil, Trash2, Search, Save
} from 'lucide-react';
import { getXLSX } from '@/lib/lazyLibs';
import api from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TO_CLIENT_TYPE = {
  'individual':              'proprietor',
  'huf':                     'huf',
  'firm':                    'partnership',
  'firm (limited liability)':'llp',
  'private ltd.':            'pvt_ltd',
  'private limited':         'pvt_ltd',
  'pvt ltd':                 'pvt_ltd',
  'aop (trust)':             'trust',
  'aop':                     'trust',
  'trust':                   'trust',
  'proprietor':              'proprietor',
  'partnership':             'partnership',
  'llp':                     'llp',
};

const CLIENT_TYPES = [
  { v: 'proprietor', l: 'Individual' },
  { v: 'huf',        l: 'HUF' },
  { v: 'partnership',l: 'Firm' },
  { v: 'llp',        l: 'LLP' },
  { v: 'pvt_ltd',    l: 'Pvt Ltd' },
  { v: 'trust',      l: 'Trust' },
];

const INDIAN_CITIES = [
  'SURAT','AHMEDABAD','MUMBAI','NEW DELHI','DELHI','PUNE','VADODARA','BARODA','RAJKOT',
  'NAVSARI','BHARUCH','ANKLESHWAR','ANAND','GANDHINAGAR','NADIAD','VALSAD','BILIMORA',
  'BHAVNAGAR','JAMNAGAR','JUNAGADH','PORBANDAR','MEHSANA','PALANPUR','MORBI',
  'KOLKATA','CHENNAI','HYDERABAD','SECUNDERABAD','BENGALURU','BANGALORE','MYSORE',
  'JAIPUR','JODHPUR','UDAIPUR','LUCKNOW','KANPUR','VARANASI','NOIDA','GHAZIABAD','GURUGRAM','GURGAON','FARIDABAD',
  'INDORE','BHOPAL','NAGPUR','NASHIK','AURANGABAD','COIMBATORE','MADURAI',
  'PATNA','CHANDIGARH','THANE','NAVI MUMBAI','KOCHI','TRIVANDRUM','VISAKHAPATNAM','VIJAYWADA',
  // Surat sub-area names that often appear at end of address
  'KAMREJ','OLPAD','MANDVI','BARDOLI','VYARA','SONGADH','PALSANA',
];

// ─────────────────────────────────────────────────────────────────────────────
// Parsing helpers
// ─────────────────────────────────────────────────────────────────────────────

const STATE_BY_PIN_PREFIX = [
  // first 2 digits → state. Covers India PIN ranges.
  { rx: /^(11)/, state: 'Delhi' },
  { rx: /^(12|13)/, state: 'Haryana' },
  { rx: /^(14|15|16)/, state: 'Punjab' },
  { rx: /^(17)/, state: 'Himachal Pradesh' },
  { rx: /^(18|19)/, state: 'Jammu and Kashmir' },
  { rx: /^(20|21|22|23|24|25|26|27|28)/, state: 'Uttar Pradesh' },
  { rx: /^(30|31|32|33|34|35|36|37)/, state: 'Rajasthan' },
  { rx: /^(38|39)/, state: 'Gujarat' },
  { rx: /^(4)/,  state: 'Maharashtra' }, // 40-44 MH, 45-48 MP/CG, refined below
  { rx: /^(45|46|47|48|49)/, state: 'Madhya Pradesh' },
  { rx: /^(5)/,  state: 'Andhra Pradesh' }, // refined
  { rx: /^(56|57|58|59)/, state: 'Karnataka' },
  { rx: /^(6)/,  state: 'Tamil Nadu' },
  { rx: /^(67|68|69)/, state: 'Kerala' },
  { rx: /^(7)/,  state: 'West Bengal' },
  { rx: /^(75|76|77)/, state: 'Odisha' },
  { rx: /^(78)/, state: 'Assam' },
  { rx: /^(8)/,  state: 'Bihar' },
  { rx: /^(82|83|84|85)/, state: 'Jharkhand' },
  { rx: /^(9)/,  state: 'Tamil Nadu' },
];

function stateFromPincode(pin) {
  if (!pin || pin.length !== 6) return 'Gujarat';
  for (let i = STATE_BY_PIN_PREFIX.length - 1; i >= 0; i--) {
    if (STATE_BY_PIN_PREFIX[i].rx.test(pin)) return STATE_BY_PIN_PREFIX[i].state;
  }
  return 'Gujarat';
}

function titleCaseCity(c) {
  return c.toLowerCase().split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function parseDOB(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  // Already an ISO date or Date object
  if (raw instanceof Date && !isNaN(raw)) {
    const yyyy = raw.getFullYear();
    const mm = String(raw.getMonth() + 1).padStart(2,'0');
    const dd = String(raw.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  }
  const s = String(raw).trim();
  // dd/mm/yyyy or dd-mm-yyyy
  let m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
  }
  // yyyy-mm-dd
  m = s.match(/^(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})$/);
  if (m) {
    const [, yyyy, mm, dd] = m;
    return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
  }
  // Excel serial number
  if (/^\d{4,6}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 20000 && n < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000);
      if (!isNaN(d)) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      }
    }
  }
  return null;
}

function cleanPhone(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  // Many cells contain multiple numbers separated by , / ; or whitespace — take the first valid 10-digit mobile.
  const parts = String(raw).split(/[,;\/\n\r]+/).map(p => p.trim()).filter(Boolean);
  for (const p of parts.length ? parts : [String(raw)]) {
    let d = p.replace(/\D/g,'');
    if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
    if (d.length === 11 && d.startsWith('0'))  d = d.slice(1);
    if (d.length === 13 && d.startsWith('091')) d = d.slice(3);
    if (d.length === 10 && /^[6-9]/.test(d))   return d;
  }
  // Fallback: last 10 digits of the whole field
  const all = String(raw).replace(/\D/g,'');
  if (all.length >= 10) {
    const tail = all.slice(-10);
    if (/^[6-9]/.test(tail)) return tail;
  }
  return null;
}

function formatAadhaar(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const d = String(raw).replace(/\D/g,'');
  if (d.length !== 12) return null; // don't surface partial junk as a warning
  return `${d.slice(0,4)} ${d.slice(4,8)} ${d.slice(8,12)}`;
}

function cleanText(raw) {
  if (raw === null || raw === undefined) return '';
  // Strip carriage-return entities ("_x000D_") and normalize whitespace.
  return String(raw).replace(/_x000D_/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseAddress(raw) {
  const fallback = { address: '', city: '', state: '', pincode: '' };
  if (!raw) return fallback;
  const s = cleanText(raw);

  // 1) Pincode — anywhere in the string, but prefer one at/near the end.
  let pincode = '';
  const pinAll = s.match(/\b(\d{6})\b/g);
  if (pinAll && pinAll.length) pincode = pinAll[pinAll.length - 1];

  // 2) City — segment immediately before the pincode (or the last meaningful segment).
  //    Standard ITR-software format: "..., <Post Office>, <Locality>-<PIN>"
  let city = '';
  let body = s;
  if (pincode) {
    // Cut off "<separator><pin>" tail
    const cutIdx = s.lastIndexOf(pincode);
    body = s.slice(0, cutIdx).replace(/[\s,\-]+$/, '');
  }
  const segments = body.split(',').map(x => x.trim()).filter(Boolean);

  // Try a known-city match in the LAST 3 segments (most reliable).
  if (segments.length) {
    const tail = segments.slice(-3).join(',').toUpperCase();
    for (const c of INDIAN_CITIES) {
      const rx = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`);
      if (rx.test(tail)) { city = titleCaseCity(c); break; }
    }
  }
  // Fallback: use second-last segment (Post Office is usually last, City second-last)
  if (!city && segments.length >= 2) {
    let candidate = segments[segments.length - 2]
      .replace(/\b(S\.O|B\.O|H\.O|R\.S)\b\.?/gi, '')
      .replace(/[-\s]+\d+\s*$/, '')
      .trim();
    if (candidate && candidate.length <= 40) city = titleCaseCity(candidate);
  }
  // Fallback: last segment cleaned
  if (!city && segments.length) {
    let candidate = segments[segments.length - 1]
      .replace(/\b(S\.O|B\.O|H\.O|R\.S)\b\.?/gi, '')
      .replace(/[-\s]+\d+\s*$/, '')
      .trim();
    if (candidate && candidate.length <= 40) city = titleCaseCity(candidate);
  }
  if (!city) city = 'Surat';

  // 3) Address — everything except the city-segment + PO + pincode tail.
  let address = s
    .replace(new RegExp(`[\\s,\\-]*\\b${pincode}\\b\\s*$`), '')
    .replace(/[\s,]+$/, '')
    .trim();
  if (!address) address = s;

  // 4) State — derive from pincode (defaults to Gujarat).
  const state = stateFromPincode(pincode);

  return { address, city, state, pincode };
}

function extractAY(title) {
  if (!title) return null;
  const m = String(title).match(/A\.?Y\.?\s*['\u2018\u2019]?\s*(\d{4})\s*[-\/]\s*(\d{2,4})/i);
  if (!m) return null;
  const start = m[1];
  let end = m[2];
  if (end.length === 4) end = end.slice(-2);
  return `${start}-${end}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Import validation
// ─────────────────────────────────────────────────────────────────────────────

const PAN_RE     = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GSTIN_RE   = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/;
const AADHAAR_RE = /^\d{4}\s?\d{4}\s?\d{4}$/;
const PIN_RE     = /^\d{6}$/;
const PHONE_RE   = /^[6-9]\d{9}$/;

function validateRow(row) {
  const errors = {};
  const warnings = {};

  const name = (row.company_name || '').trim();
  if (!name) errors.company_name = 'Name is required';
  else if (name.length < 2) errors.company_name = 'Name too short';
  else if (name.length > 150) errors.company_name = 'Name exceeds 150 chars';

  const pan = (row.pan || '').trim().toUpperCase();
  if (!pan) errors.pan = 'PAN is required';
  else if (!PAN_RE.test(pan)) errors.pan = 'Invalid PAN (expected AAAAA9999A)';

  if (row.email && !EMAIL_RE.test(String(row.email).trim())) errors.email = 'Invalid email format';

  if (row.phone) {
    const p = String(row.phone).replace(/\D/g, '');
    if (!PHONE_RE.test(p)) errors.phone = 'Mobile must be 10 digits, start 6-9';
  }

  if (row.gstin) {
    const g = String(row.gstin).trim().toUpperCase();
    if (!GSTIN_RE.test(g)) warnings.gstin = 'Invalid GSTIN format';
  }

  const aadhaar = row.itr_data?.aadhaar;
  if (aadhaar && !AADHAAR_RE.test(String(aadhaar).trim())) warnings.aadhaar = 'Aadhaar must be 12 digits';

  const pin = row.itr_data?.pincode;
  if (pin && !PIN_RE.test(String(pin).trim())) warnings.pincode = 'Pincode must be 6 digits';

  return { errors, warnings, valid: Object.keys(errors).length === 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core parser
// ─────────────────────────────────────────────────────────────────────────────

function buildColMap(headerRow) {
  // Map normalized header → column index. Normalization strips
  // _x000D_, line breaks, dots, spaces, slashes, hyphens.
  const map = {};
  headerRow.forEach((h, i) => {
    if (h === null || h === undefined) return;
    const key = String(h)
      .replace(/_x000D_/g, ' ')
      .replace(/[\r\n]+/g, ' ')
      .toLowerCase()
      .replace(/[^\w]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (key && !(key in map)) map[key] = i;
    // Also store a "compact" key with no underscores so look-ups like "pan" find "p_a_n"
    const compact = key.replace(/_/g, '');
    if (compact && !(compact in map)) map[compact] = i;
  });
  return map;
}

function getByCol(row, colMap, ...candidates) {
  for (const c of candidates) {
    const key = c.toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '');
    const compact = key.replace(/_/g, '');
    const idx = colMap[key] !== undefined ? colMap[key]
              : colMap[compact] !== undefined ? colMap[compact]
              : undefined;
    if (idx !== undefined) {
      const v = row[idx];
      if (v !== null && v !== undefined && String(v).trim() !== '') {
        return cleanText(v);
      }
    }
  }
  return '';
}

function isFilterOrEmptyRow(r) {
  if (!Array.isArray(r) || r.length === 0) return true;
  const nonEmpty = r.filter(c => c !== null && c !== undefined && String(c).trim() !== '');
  if (nonEmpty.length === 0) return true;
  // ITR exports include a "(All)" filter row — every non-empty cell equals "(All)".
  const allFilter = nonEmpty.every(c => String(c).trim().toLowerCase() === '(all)');
  return allFilter;
}

function parseITRExcel(workbook, XLSX) {
  const results = [];
  let detectedAY = null;

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: true });
    if (rawRows.length < 3) continue;

    // Detect AY from any cell in the first 3 rows (title row may not always be row 0).
    if (!detectedAY) {
      for (let i = 0; i < Math.min(3, rawRows.length); i++) {
        for (const cell of rawRows[i]) {
          const ay = extractAY(cell);
          if (ay) { detectedAY = ay; break; }
        }
        if (detectedAY) break;
      }
    }

    // Locate the header row dynamically — it's the row that contains a "PAN" header.
    let headerRowIdx = -1;
    for (let i = 0; i < Math.min(6, rawRows.length); i++) {
      const row = rawRows[i] || [];
      const hasName = row.some(h => /\bname\b/i.test(String(h || '')));
      const hasPan  = row.some(h => /\bpan\b/i.test(String(h || '')));
      if (hasName && hasPan) { headerRowIdx = i; break; }
    }
    if (headerRowIdx < 0) headerRowIdx = 2; // fallback to standard layout

    const headerRow = rawRows[headerRowIdx] || [];
    const colMap = buildColMap(headerRow);

    for (let ri = headerRowIdx + 1; ri < rawRows.length; ri++) {
      const r = rawRows[ri];
      if (isFilterOrEmptyRow(r)) continue;

      const name = getByCol(r, colMap, 'name', 'full_name', 'assessee_name', 'client_name');
      const pan  = getByCol(r, colMap, 'pan', 'pan_number', 'pan_no').toUpperCase();
      if (!name && !pan) continue;
      if (pan === '(ALL)' || name === '(ALL)') continue;

      const rawStatus = getByCol(r, colMap, 'status', 'client_type', 'type').toLowerCase();
      const clientType = STATUS_TO_CLIENT_TYPE[rawStatus] || 'proprietor';

      const mobile = cleanPhone(
        getByCol(r, colMap, 'mobile', 'mobile_no', 'mobile_number', 'cell', 'cell_no')
      ) || cleanPhone(
        getByCol(r, colMap, 'phone', 'phone_no', 'phone_number', 'contact')
      ) || cleanPhone(
        getByCol(r, colMap, 'aadhaar_linked_mobile')
      );

      const addrRaw = getByCol(r, colMap, 'address', 'full_address', 'addr');
      const { address, city, state, pincode } = parseAddress(addrRaw);

      const aadhaar = formatAadhaar(getByCol(r, colMap, 'aadhaar', 'aadhar', 'aadhaar_number', 'aadhar_number'));
      const dob = parseDOB(getByCol(r, colMap, 'dob_doi', 'dob', 'date_of_birth', 'doi', 'date_of_incorporation'));

      const email = (getByCol(r, colMap, 'email', 'email_id', 'e_mail', 'mail') || '').toLowerCase() || null;
      const gstin = (getByCol(r, colMap, 'gstin', 'gst_no', 'gst_number') || '').toUpperCase() || null;
      const remarks = getByCol(r, colMap, 'remark', 'remarks', 'notes') || null;

      results.push({
        company_name: name || pan,
        pan: pan || null,
        client_type: clientType,
        email,
        phone: mobile,
        address: address || addrRaw || '',
        city: city || 'Surat',
        state: state || 'Gujarat',
        birthday: dob,
        gstin,
        notes: remarks,
        status: 'active',
        services: ['Income Tax'],
        is_itr_client: true,
        itr_data: {
          assessment_year: detectedAY || '2025-26',
          itr_type: getByCol(r, colMap, 'itr_type', 'return_type') || 'ITR-1',
          filing_status: getByCol(r, colMap, 'filing_status') || 'pending',
          aadhaar,
          code: getByCol(r, colMap, 'code', 'client_code') || null,
          group: getByCol(r, colMap, 'group') || null,
          residential_status: getByCol(r, colMap, 'residential_status', 'residentialstatus') || null,
          ward: getByCol(r, colMap, 'ward') || null,
          tan: getByCol(r, colMap, 'tan') || null,
          pan_aadhaar_linked: getByCol(r, colMap, 'pan_aadhaar_linked', 'panaadhaarlinked') || null,
          father_husband: getByCol(r, colMap, 'father_husband', 'father', 'husband') || null,
          gender: getByCol(r, colMap, 'gender') || null,
          passport: getByCol(r, colMap, 'passport', 'passport_no') || null,
          it_portal_user: getByCol(r, colMap, 'userid', 'user_id', 'portal_user', 'it_portal_user') || null,
          it_portal_password: getByCol(r, colMap, 'password', 'portal_password', 'it_portal_password') || null,
          category: getByCol(r, colMap, 'category') || null,
          remarks,
          din: getByCol(r, colMap, 'din') || null,
          bank_account_no: getByCol(r, colMap, 'a_c_no', 'account_no', 'ac_no', 'bank_account_no') || null,
          bank_name: getByCol(r, colMap, 'bank_name', 'bank') || null,
          ifsc_code: getByCol(r, colMap, 'ifsc', 'ifsc_code') || null,
          no_of_bank: getByCol(r, colMap, 'no_of_bank', 'number_of_bank') || null,
          aadhaar_linked_mobile: cleanPhone(getByCol(r, colMap, 'aadhaar_linked_mobile')) || null,
          sn: getByCol(r, colMap, 'sn', 's_n', 'sr_no', 'srno') || null,
          pincode,
          company_links: [],
        },
      });
    }
  }

  // De-duplicate on PAN (keep the first, merge non-empty fields from later occurrences).
  const byPan = new Map();
  for (const row of results) {
    const key = (row.pan || row.company_name || '').toUpperCase();
    if (!key) continue;
    if (!byPan.has(key)) {
      byPan.set(key, row);
    } else {
      const existing = byPan.get(key);
      // Merge top-level scalar fields
      for (const k of Object.keys(row)) {
        if (k === 'itr_data') continue;
        if (!existing[k] && row[k]) existing[k] = row[k];
      }
      // Merge itr_data
      for (const k of Object.keys(row.itr_data || {})) {
        if (!existing.itr_data[k] && row.itr_data[k]) existing.itr_data[k] = row.itr_data[k];
      }
    }
  }
  const deduped = Array.from(byPan.values());

  return { rows: deduped, detectedAY, totalParsed: results.length, duplicatesMerged: results.length - deduped.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit Row Modal
// ─────────────────────────────────────────────────────────────────────────────

function EditRowModal({ row, isDark, onSave, onCancel }) {
  const [form, setForm] = useState({
    company_name: row.company_name || '',
    pan: row.pan || '',
    client_type: row.client_type || 'proprietor',
    phone: row.phone || '',
    email: row.email || '',
    city: row.city || '',
    address: row.address || '',
    gstin: row.gstin || '',
    it_portal_user: row.itr_data?.it_portal_user || '',
    it_portal_password: row.itr_data?.it_portal_password || '',
  });

  const bg          = isDark ? '#0f172a' : '#ffffff';
  const border      = isDark ? '#1e3a5f' : '#e2e8f0';
  const textPrimary = isDark ? '#e2e8f0' : '#0f172a';
  const textMuted   = isDark ? '#94a3b8' : '#64748b';
  const inputBg     = isDark ? '#1e293b' : '#f8fafc';

  const field = (label, key, type = 'text') => (
    <div className="space-y-1">
      <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
        {label}
      </label>
      <input
        type={type}
        value={form[key]}
        onChange={(e) => setForm(f => ({ ...f, [key]: e.target.value }))}
        className="w-full px-2.5 py-1.5 rounded-md text-xs border outline-none focus:border-teal-500"
        style={{ background: inputBg, borderColor: border, color: textPrimary }}
      />
    </div>
  );

  const save = () => {
    onSave({
      ...row,
      company_name: form.company_name.trim(),
      pan: form.pan.trim().toUpperCase() || null,
      client_type: form.client_type,
      phone: form.phone.trim() || null,
      email: form.email.trim().toLowerCase() || null,
      city: form.city.trim(),
      address: form.address.trim(),
      gstin: form.gstin.trim() || null,
      itr_data: {
        ...(row.itr_data || {}),
        it_portal_user: form.it_portal_user.trim() || null,
        it_portal_password: form.it_portal_password.trim() || null,
      },
    });
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(6,78,59,0.5)' }}
      onClick={onCancel}
    >
      <div
        className="rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
        style={{ background: bg, border: `1px solid ${border}` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between px-5 py-3"
          style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
        >
          <p className="text-white font-semibold text-sm">Edit Client</p>
          <button onClick={onCancel} className="p-1 rounded hover:bg-white/20">
            <X className="h-4 w-4 text-white" />
          </button>
        </div>

        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          {field('Name', 'company_name')}
          <div className="grid grid-cols-2 gap-3">
            {field('PAN', 'pan')}
            <div className="space-y-1">
              <label className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: textMuted }}>
                Client Type
              </label>
              <select
                value={form.client_type}
                onChange={(e) => setForm(f => ({ ...f, client_type: e.target.value }))}
                className="w-full px-2.5 py-1.5 rounded-md text-xs border outline-none focus:border-teal-500"
                style={{ background: inputBg, borderColor: border, color: textPrimary }}
              >
                {CLIENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field('Mobile', 'phone')}
            {field('Email', 'email', 'email')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field('City', 'city')}
            {field('GSTIN', 'gstin')}
          </div>
          {field('Address', 'address')}
          <div className="grid grid-cols-2 gap-3">
            {field('IT Portal User', 'it_portal_user')}
            {field('IT Portal Password', 'it_portal_password')}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t"
          style={{ borderColor: border, background: isDark ? '#1e293b' : '#f8fafc' }}>
          <Button variant="ghost" size="sm" onClick={onCancel} style={{ color: textMuted }}>Cancel</Button>
          <Button size="sm" onClick={save} className="gap-1.5"
            style={{ background: 'linear-gradient(135deg, #0f766e, #0369a1)', color: '#fff', border: 'none' }}>
            <Save className="h-3.5 w-3.5" /> Save
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

export default function ITRBulkImportDialog({ open, onClose, onImported, isDark = false }) {
  const fileInputRef = useRef(null);
  const [step, setStep] = useState('upload'); // upload | preview | importing | done
  const [fileName, setFileName] = useState('');
  const [parsedRows, setParsedRows] = useState([]);
  const [detectedAY, setDetectedAY] = useState(null);
  const [results, setResults] = useState({ created: 0, skipped: 0, errors: [] });
  const [showErrors, setShowErrors] = useState(false);
  const [progress, setProgress] = useState(0);
  const [search, setSearch] = useState('');
  const [editingIdx, setEditingIdx] = useState(null);
  const [errorFilter, setErrorFilter] = useState('all'); // all | errors | warnings | valid

  const reset = useCallback(() => {
    setStep('upload');
    setFileName('');
    setParsedRows([]);
    setDetectedAY(null);
    setResults({ created: 0, skipped: 0, errors: [] });
    setShowErrors(false);
    setProgress(0);
    setSearch('');
    setEditingIdx(null);
    setErrorFilter('all');
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose?.();
  }, [reset, onClose]);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['xlsx', 'xls', 'csv'].includes(ext)) {
      toast.error('Please upload an .xlsx, .xls, or .csv file.');
      return;
    }
    setFileName(file.name);

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const XLSX = await getXLSX();
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: false, raw: true });
        const { rows, detectedAY: ay } = parseITRExcel(wb, XLSX);

        if (rows.length === 0) {
          toast.error('No valid client rows found. Make sure the file has Name and PAN columns.');
          setFileName('');
          return;
        }

        setParsedRows(rows);
        setDetectedAY(ay);
        setStep('preview');
        toast.success(`Parsed ${rows.length} client${rows.length !== 1 ? 's' : ''} from ${wb.SheetNames.length} sheet${wb.SheetNames.length > 1 ? 's' : ''}.${ay ? ` AY ${ay} detected.` : ''}`);
      } catch (err) {
        console.error('Parse error:', err);
        toast.error('Failed to parse file: ' + (err.message || 'Unknown error'));
        setFileName('');
      }
    };
    reader.readAsArrayBuffer(file);
  }, []);

  const onInputChange = useCallback((e) => handleFile(e.target.files?.[0]), [handleFile]);
  const onDrop = useCallback((e) => {
    e.preventDefault();
    handleFile(e.dataTransfer.files?.[0]);
  }, [handleFile]);

  // ── Validation (per-row + duplicate PAN within batch) ───────────────────
  const validations = useMemo(() => {
    const panCount = {};
    parsedRows.forEach(r => {
      const p = (r.pan || '').toUpperCase();
      if (p) panCount[p] = (panCount[p] || 0) + 1;
    });
    return parsedRows.map(r => {
      const v = validateRow(r);
      const p = (r.pan || '').toUpperCase();
      if (p && panCount[p] > 1) v.warnings.pan_duplicate = `PAN appears ${panCount[p]}× in file`;
      return v;
    });
  }, [parsedRows]);

  const validationStats = useMemo(() => {
    let errors = 0, warnings = 0, valid = 0;
    validations.forEach(v => {
      if (!v.valid) errors++;
      else if (Object.keys(v.warnings).length) warnings++;
      else valid++;
    });
    return { errors, warnings, valid };
  }, [validations]);

  // ── Filtered list ────────────────────────────────────────────────────────
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return parsedRows
      .map((r, i) => ({ row: r, originalIdx: i, v: validations[i] }))
      .filter(({ row: r, v }) => {
        if (errorFilter === 'errors' && v.valid) return false;
        if (errorFilter === 'warnings' && (!v.valid || !Object.keys(v.warnings).length)) return false;
        if (errorFilter === 'valid' && (!v.valid || Object.keys(v.warnings).length)) return false;
        if (!q) return true;
        return (r.company_name || '').toLowerCase().includes(q) ||
               (r.pan || '').toLowerCase().includes(q) ||
               (r.phone || '').toLowerCase().includes(q) ||
               (r.email || '').toLowerCase().includes(q) ||
               (r.city || '').toLowerCase().includes(q);
      });
  }, [parsedRows, validations, search, errorFilter]);

  // ── Row edit / delete ───────────────────────────────────────────────────
  const deleteRow = useCallback((idx) => {
    setParsedRows(rows => rows.filter((_, i) => i !== idx));
  }, []);

  const saveEdit = useCallback((updated) => {
    setParsedRows(rows => rows.map((r, i) => (i === editingIdx ? updated : r)));
    setEditingIdx(null);
    toast.success('Row updated');
  }, [editingIdx]);

  // ── Import ────────────────────────────────────────────────────────────────
  const runImport = useCallback(async () => {
    // Block invalid rows from being sent to the API
    const invalidIdxs = validations
      .map((v, i) => (!v.valid ? i : -1))
      .filter(i => i !== -1);

    if (invalidIdxs.length === parsedRows.length) {
      toast.error('All rows have validation errors. Fix them before importing.');
      return;
    }
    if (invalidIdxs.length > 0) {
      const ok = confirm(
        `${invalidIdxs.length} row(s) have validation errors and will be skipped.\n` +
        `Proceed and import the ${parsedRows.length - invalidIdxs.length} valid row(s)?`
      );
      if (!ok) return;
    }

    setStep('importing');
    setProgress(0);
    let created = 0, skipped = 0;
    const errors = [];

    // Pre-record validation skips so user sees them on the done step
    invalidIdxs.forEach(i => {
      const row = parsedRows[i];
      const msgs = Object.entries(validations[i].errors).map(([k, m]) => `${k}: ${m}`).join('; ');
      errors.push({ row: i + 1, name: row.company_name || row.pan || `Row ${i+1}`, error: `Validation: ${msgs}` });
      skipped++;
    });

    const toImport = parsedRows.filter((_, i) => validations[i].valid);

    for (let i = 0; i < toImport.length; i++) {
      setProgress(Math.round(((i + 1) / toImport.length) * 100));
      const row = toImport[i];
      try {
        await api.post('/clients', row);
        created++;
      } catch (err) {
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail;
        const msg = Array.isArray(detail)
          ? detail.map(d => d.msg).join(', ')
          : (typeof detail === 'string' ? detail : (err.message || 'Unknown error'));

        if (status === 409 || msg.toLowerCase().includes('duplicate') || msg.toLowerCase().includes('already exists')) {
          skipped++;
        } else {
          errors.push({ row: i + 1, name: row.company_name || row.pan || `Row ${i+1}`, error: msg });
          skipped++;
        }
      }
    }

    setResults({ created, skipped, errors });
    setStep('done');

    if (created > 0) {
      toast.success(`${created} ITR client${created !== 1 ? 's' : ''} imported successfully!`);
      onImported?.();
    } else {
      toast.warning('No new clients were imported.');
    }
  }, [parsedRows, validations, onImported]);

  // ── Styles ────────────────────────────────────────────────────────────────
  const bg          = isDark ? '#0f172a' : '#ffffff';
  const border      = isDark ? '#1e3a5f' : '#e2e8f0';
  const textPrimary = isDark ? '#e2e8f0' : '#0f172a';
  const textMuted   = isDark ? '#94a3b8' : '#64748b';
  const cardBg      = isDark ? '#1e293b' : '#f8fafc';
  const rowAlt      = isDark ? '#162032' : '#f1f5f9';
  const inputBg     = isDark ? '#1e293b' : '#ffffff';

  const typeBadge = (t) => {
    const map = {
      proprietor: ['#dbeafe','#1d4ed8'], huf: ['#ede9fe','#7c3aed'],
      partnership: ['#fce7f3','#be185d'], llp: ['#fef3c7','#b45309'],
      pvt_ltd: ['#dcfce7','#15803d'], trust: ['#ffedd5','#c2410c'],
    };
    const [bgC, color] = map[t] || ['#f1f5f9','#475569'];
    return isDark ? { background: color + '33', color } : { background: bgC, color };
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        hideClose
        className="p-0 overflow-hidden rounded-2xl shadow-2xl"
        style={{ maxWidth: 900, width: '95vw', background: bg, borderColor: border }}
      >
        <DialogTitle className="sr-only">Bulk Import ITR Clients</DialogTitle>
        <DialogDescription className="sr-only">Upload Income Tax Excel to import clients</DialogDescription>

        {/* ── Header ── */}
        <div
          className="flex items-center justify-between px-6 py-4"
          style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center rounded-xl bg-white/15 flex-shrink-0">
              <FileSpreadsheet className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-white font-bold text-xl leading-snug">Bulk Import ITR Clients</p>
              <p className="text-white/70 text-xs">
                {step === 'preview' && parsedRows.length > 0
                  ? `${parsedRows.length} clients ready${detectedAY ? ` · AY ${detectedAY}` : ''}`
                  : 'Upload Income Tax software Excel export (.xlsx)'}
              </p>
            </div>
          </div>
          <button onClick={handleClose} aria-label="Close" className="w-8 h-8 flex items-center justify-center rounded-lg bg-white/15 hover:bg-white/25 transition-colors flex-shrink-0">
            <X className="h-4 w-4 text-white" />
          </button>
        </div>

        {/* ── Body ── */}
        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">

          {/* ── STEP: upload ── */}
          {step === 'upload' && (
            <>
              <div
                className="rounded-xl p-3 border text-xs space-y-1"
                style={{ background: isDark ? '#0c1a2e' : '#f0f9ff', borderColor: isDark ? '#1e3a5f' : '#bae6fd', color: isDark ? '#93c5fd' : '#0369a1' }}
              >
                <p className="font-semibold">✅ Supported format: Income Tax software Excel export</p>
                <p style={{ color: textMuted }}>
                  The file should have: Row 1 = Title (A.Y. year), Row 3 = Column headers
                  (SN, Code, Name, PAN, Group, Status …), Row 4 = data rows.
                  Both sheets are imported automatically.
                </p>
              </div>

              <div
                className="border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all hover:border-teal-400 hover:bg-teal-50/5"
                style={{ borderColor: isDark ? '#334155' : '#cbd5e1', background: cardBg }}
                onClick={() => fileInputRef.current?.click()}
                onDrop={onDrop}
                onDragOver={e => e.preventDefault()}
              >
                <Upload className="h-9 w-9 mx-auto mb-3" style={{ color: textMuted }} />
                <p className="text-sm font-semibold" style={{ color: textPrimary }}>
                  Click to upload or drag & drop
                </p>
                <p className="text-xs mt-1" style={{ color: textMuted }}>
                  .xlsx · .xls · .csv — Income Tax software export
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={onInputChange}
                />
              </div>

              <div className="rounded-xl border p-3" style={{ borderColor: border, background: cardBg }}>
                <p className="text-xs font-semibold mb-2" style={{ color: textMuted }}>
                  Fields imported from each row:
                </p>
                <div className="flex flex-wrap gap-1">
                  {['Name','PAN','AADHAAR','Email','Mobile','Address','DOB','GSTIN',
                    'IT Portal UserID','IT Portal Password','Bank A/c','IFSC','Ward',
                    'Group','Status→Client Type','Remark'].map(f => (
                    <span key={f} className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                      style={{ background: isDark ? '#0f172a' : '#e2e8f0', color: textMuted }}>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── STEP: preview ── */}
          {step === 'preview' && (
            <>
              {/* File badge */}
              <div
                className="flex items-center gap-2 rounded-xl p-3 border"
                style={{ borderColor: isDark ? '#166534' : '#bbf7d0', background: isDark ? '#1e293b' : '#f0fdf4' }}
              >
                <FileText className="h-4 w-4 shrink-0" style={{ color: isDark ? '#4ade80' : '#16a34a' }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate" style={{ color: isDark ? '#4ade80' : '#16a34a' }}>
                    {fileName}
                  </p>
                  <p className="text-[10px]" style={{ color: textMuted }}>
                    {parsedRows.length} clients detected
                    {detectedAY ? ` · Assessment Year: ${detectedAY}` : ''}
                  </p>
                </div>
                <button onClick={reset} className="p-1 rounded hover:bg-red-500/20 transition-colors shrink-0">
                  <X className="h-3.5 w-3.5" style={{ color: isDark ? '#f87171' : '#ef4444' }} />
                </button>
              </div>

              {/* Type breakdown */}
              {(() => {
                const counts = {};
                parsedRows.forEach(r => { counts[r.client_type] = (counts[r.client_type]||0)+1; });
                const labels = { proprietor:'Individual', huf:'HUF', partnership:'Firm', llp:'LLP', pvt_ltd:'Pvt Ltd', trust:'Trust' };
                return (
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(counts).map(([type, count]) => (
                      <span key={type} className="text-[11px] font-semibold px-2.5 py-1 rounded-full"
                        style={typeBadge(type)}>
                        {labels[type] || type}: {count}
                      </span>
                    ))}
                  </div>
                );
              })()}

              {/* Validation summary + filter chips */}
              <div className="flex flex-wrap items-center gap-2">
                {[
                  { key: 'all',      label: `All ${parsedRows.length}`,                   color: '#64748b' },
                  { key: 'valid',    label: `✓ Valid ${validationStats.valid}`,           color: '#16a34a' },
                  { key: 'warnings', label: `⚠ Warnings ${validationStats.warnings}`,     color: '#d97706' },
                  { key: 'errors',   label: `✕ Errors ${validationStats.errors}`,         color: '#dc2626' },
                ].map(c => {
                  const active = errorFilter === c.key;
                  return (
                    <button
                      key={c.key}
                      onClick={() => setErrorFilter(c.key)}
                      className="text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-all"
                      style={{
                        borderColor: active ? c.color : border,
                        background: active ? c.color + (isDark ? '33' : '22') : 'transparent',
                        color: active ? c.color : textMuted,
                      }}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>

              {/* Search bar */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5" style={{ color: textMuted }} />
                <input
                  type="text"
                  placeholder="Search by name, PAN, mobile, email, city…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-8 pr-3 py-2 rounded-lg text-xs border outline-none focus:border-teal-500"
                  style={{ background: inputBg, borderColor: border, color: textPrimary }}
                />
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-black/10"
                  >
                    <X className="h-3 w-3" style={{ color: textMuted }} />
                  </button>
                )}
              </div>

              {/* Preview table — ALL rows, scrollable */}
              <div className="rounded-xl border overflow-hidden" style={{ borderColor: border }}>
                <div className="overflow-auto" style={{ maxHeight: '50vh' }}>
                  <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
                    <thead className="sticky top-0 z-10">
                      <tr style={{ background: isDark ? '#1e293b' : '#f1f5f9' }}>
                        {['#','Status','Name','PAN','Type','Mobile','City','IT Portal','Actions'].map(h => (
                          <th key={h} className="text-left px-3 py-2 font-semibold uppercase text-[10px] tracking-wide whitespace-nowrap"
                            style={{ color: textMuted, borderBottom: `1px solid ${border}` }}>
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.length === 0 && (
                        <tr>
                          <td colSpan={9} className="text-center py-8 text-xs" style={{ color: textMuted }}>
                            No rows match your filter.
                          </td>
                        </tr>
                      )}
                      {filteredRows.map(({ row: r, originalIdx, v }) => {
                        const errList = Object.entries(v.errors).map(([,m]) => m);
                        const warnList = Object.entries(v.warnings).map(([,m]) => m);
                        const statusTitle = [
                          errList.length ? 'Errors:\n• ' + errList.join('\n• ') : '',
                          warnList.length ? 'Warnings:\n• ' + warnList.join('\n• ') : '',
                        ].filter(Boolean).join('\n\n') || 'Valid';
                        return (
                        <tr key={originalIdx} style={{ background: originalIdx % 2 === 0 ? bg : rowAlt }}>
                          <td className="px-3 py-1.5 text-[10px]" style={{ color: textMuted }}>{originalIdx + 1}</td>
                          <td className="px-3 py-1.5" title={statusTitle}>
                            {!v.valid ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                style={{ background: isDark ? '#7f1d1d55' : '#fee2e2', color: isDark ? '#fca5a5' : '#b91c1c' }}>
                                <XCircle className="h-3 w-3" /> {errList.length}
                              </span>
                            ) : warnList.length ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                style={{ background: isDark ? '#78350f55' : '#fef3c7', color: isDark ? '#fcd34d' : '#b45309' }}>
                                <AlertCircle className="h-3 w-3" /> {warnList.length}
                              </span>
                            ) : (
                              <span className="inline-flex items-center text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                                style={{ background: isDark ? '#14532d55' : '#dcfce7', color: isDark ? '#86efac' : '#15803d' }}>
                                <CheckCircle2 className="h-3 w-3" />
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 font-medium max-w-[220px] truncate" style={{ color: textPrimary }} title={r.company_name}>
                            {r.company_name}
                          </td>
                          <td className="px-3 py-1.5 font-mono text-[11px]"
                            style={{ color: v.errors.pan ? (isDark ? '#fca5a5' : '#b91c1c') : textMuted }}>
                            {r.pan || '—'}
                          </td>
                          <td className="px-3 py-1.5">
                            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full whitespace-nowrap"
                              style={typeBadge(r.client_type)}>
                              {r.client_type}
                            </span>
                          </td>
                          <td className="px-3 py-1.5"
                            style={{ color: v.errors.phone ? (isDark ? '#fca5a5' : '#b91c1c') : textMuted }}>
                            {r.phone || '—'}
                          </td>
                          <td className="px-3 py-1.5" style={{ color: textMuted }}>{r.city || '—'}</td>
                          <td className="px-3 py-1.5">
                            {r.itr_data?.it_portal_user
                              ? <span className="text-[10px] text-emerald-600">✓</span>
                              : <span className="text-[10px]" style={{ color: textMuted }}>—</span>}
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => setEditingIdx(originalIdx)}
                                className="p-1 rounded hover:bg-teal-500/20 transition-colors"
                                title="Edit"
                              >
                                <Pencil className="h-3.5 w-3.5" style={{ color: isDark ? '#5eead4' : '#0d9488' }} />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`Remove "${r.company_name}" from import?`)) deleteRow(originalIdx);
                                }}
                                className="p-1 rounded hover:bg-red-500/20 transition-colors"
                                title="Delete"
                              >
                                <Trash2 className="h-3.5 w-3.5" style={{ color: isDark ? '#f87171' : '#ef4444' }} />
                              </button>
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="px-4 py-2 text-center text-[10px] border-t"
                  style={{ borderColor: border, color: textMuted, background: cardBg }}>
                  Showing {filteredRows.length} of {parsedRows.length} rows
                </div>
              </div>
            </>
          )}

          {/* ── STEP: importing ── */}
          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-12 gap-5">
              <Loader2 className="h-10 w-10 animate-spin" style={{ color: '#0d9488' }} />
              <div className="w-full max-w-xs space-y-2">
                <div className="flex justify-between text-xs" style={{ color: textMuted }}>
                  <span>Importing clients…</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full rounded-full h-2" style={{ background: isDark ? '#1e293b' : '#e2e8f0' }}>
                  <div
                    className="h-2 rounded-full transition-all"
                    style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #0f766e, #0369a1)' }}
                  />
                </div>
                <p className="text-[10px] text-center" style={{ color: textMuted }}>
                  Do not close this window
                </p>
              </div>
            </div>
          )}

          {/* ── STEP: done ── */}
          {step === 'done' && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                {[
                  { icon: CheckCircle2, label: 'Imported',  value: results.created, light: ['#f0fdf4','#bbf7d0','#16a34a'], dark: '#4ade80' },
                  { icon: AlertCircle,  label: 'Skipped',   value: results.skipped, light: ['#fffbeb','#fde68a','#d97706'], dark: '#fbbf24' },
                  { icon: XCircle,      label: 'Errors',    value: results.errors.length, light: ['#fef2f2','#fecaca','#dc2626'], dark: '#f87171' },
                ].map(({ icon: Icon, label, value, light, dark }) => (
                  <div key={label} className="rounded-xl p-4 text-center border"
                    style={{
                      background: isDark ? dark + '22' : light[0],
                      borderColor: isDark ? dark + '55' : light[1],
                    }}
                  >
                    <Icon className="h-6 w-6 mx-auto mb-1" style={{ color: isDark ? dark : light[2] }} />
                    <p className="text-2xl font-bold" style={{ color: isDark ? dark : light[2] }}>{value}</p>
                    <p className="text-[10px] mt-0.5" style={{ color: textMuted }}>{label}</p>
                  </div>
                ))}
              </div>

              {results.errors.length > 0 && (
                <div className="rounded-xl border overflow-hidden"
                  style={{ borderColor: isDark ? '#991b1b' : '#fecaca' }}>
                  <button
                    className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold"
                    style={{ background: isDark ? '#7f1d1d33' : '#fef2f2', color: isDark ? '#f87171' : '#dc2626' }}
                    onClick={() => setShowErrors(v => !v)}
                  >
                    <span>{results.errors.length} error{results.errors.length !== 1 ? 's' : ''} — click to view</span>
                    {showErrors ? <ChevronUp className="h-3.5 w-3.5"/> : <ChevronDown className="h-3.5 w-3.5"/>}
                  </button>
                  {showErrors && (
                    <div className="max-h-40 overflow-y-auto" style={{ background: cardBg }}>
                      {results.errors.map((e, i) => (
                        <div key={i} className="px-4 py-2 border-t text-xs"
                          style={{ borderColor: border }}>
                          <span className="font-medium" style={{ color: textPrimary }}>
                            #{e.row} {e.name}:
                          </span>{' '}
                          <span style={{ color: isDark ? '#f87171' : '#dc2626' }}>{e.error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-between px-5 py-4 border-t"
          style={{ borderColor: border, background: cardBg }}>

          {step === 'upload' && (
            <>
              <Button variant="ghost" size="sm" onClick={handleClose} style={{ color: textMuted }}>
                Cancel
              </Button>
              <p className="text-[10px]" style={{ color: textMuted }}>Both sheets imported automatically</p>
            </>
          )}

          {step === 'preview' && (
            <>
              <Button variant="ghost" size="sm" onClick={reset} style={{ color: textMuted }}>
                ← Change File
              </Button>
              <Button size="sm" onClick={runImport}
                disabled={parsedRows.length === 0 || (validationStats.valid + validationStats.warnings) === 0}
                className="gap-2"
                style={{ background: 'linear-gradient(135deg, #0f766e, #0369a1)', color: '#fff', border: 'none' }}>
                <Upload className="h-3.5 w-3.5" />
                Import {validationStats.valid + validationStats.warnings} Valid
                {validationStats.errors > 0 ? ` (skip ${validationStats.errors} invalid)` : ''}
              </Button>
            </>
          )}

          {step === 'importing' && (
            <div className="w-full text-center text-xs" style={{ color: textMuted }}>
              Importing {parsedRows.length} clients…
            </div>
          )}

          {step === 'done' && (
            <>
              <Button variant="ghost" size="sm" onClick={reset} style={{ color: textMuted }}>
                Import Another File
              </Button>
              <Button size="sm" onClick={handleClose}
                style={{ background: 'linear-gradient(135deg, #0f766e, #0369a1)', color: '#fff', border: 'none' }}>
                Done
              </Button>
            </>
          )}
        </div>

        {/* ── Edit row modal ── */}
        {editingIdx !== null && parsedRows[editingIdx] && (
          <EditRowModal
            row={parsedRows[editingIdx]}
            isDark={isDark}
            onCancel={() => setEditingIdx(null)}
            onSave={saveEdit}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
