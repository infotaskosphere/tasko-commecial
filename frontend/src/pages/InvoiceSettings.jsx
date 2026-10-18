/**
 * InvoiceSettings.jsx  — v2.0  (full rewrite)
 *
 * ── FEATURES ────────────────────────────────────────────────────────────────
 *  • Per-company configuration (switch companies in left panel)
 *  • Numbering  — prefix, separator, FY format, padding, start number,
 *                 separate sequences per document type, sequence counter reset
 *  • Identity   — document titles, authorized signatory, show/hide fields
 *  • Defaults   — payment terms, notes, T&C, supply state, default GST rate
 *  • Bank / UPI — bank details shown on invoice footer, bank detail preview
 *  • Design     — default template, theme/color per company
 *  • Live preview of generated invoice number for ALL document types
 *  • Fully contained — no overflow, all panels scroll internally
 *  • Settings stored in localStorage (JSON per company)
 *
 * ── INTEGRATION ──────────────────────────────────────────────────────────────
 *
 *  import InvoiceSettings, { getInvSettings, getNextInvoiceNumber } from './InvoiceSettings';
 *
 *  <InvoiceSettings
 *    open={settingsOpen}
 *    onClose={() => setSettingsOpen(false)}
 *    companies={companies}
 *    isDark={isDark}
 *  />
 *
 *  const s        = getInvSettings(company.id);
 *  const nextNum  = getNextInvoiceNumber(company.id, 'invoice');
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Button }   from '@/components/ui/button';
import { Input }    from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch }   from '@/components/ui/switch';
import api from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { canPerformFinixAction } from '@/lib/commercialPermissionMatrix';
import { lookupPincode } from '@/lib/pincode';
import { mirrorBankToSettings, bankFromCompany } from '@/lib/bankSync';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  Settings, Building2, Hash, FileText, CreditCard, Palette,
  X, Save, RefreshCw, ChevronRight, Check, Copy, Landmark,
  StickyNote, AlertCircle, Eye, RotateCcw,
  Banknote, Smartphone, Shield, Pen, ChevronDown,
} from 'lucide-react';
import { COLOR_THEMES, INVOICE_TEMPLATES, generateInvoiceHTML } from './InvoiceTemplates';

// ─── Storage ──────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'taskosphere_inv_settings_v2';

// ─── Defaults ────────────────────────────────────────────────────────────────
export const DEFAULT_INV_SETTINGS = {
  // Numbering
  prefix:             'INV',
  separator:          '/',
  include_fy:         true,
  fy_format:          'short',
  include_month:      false,
  number_padding:     3,
  current_number:     1,
  auto_reset_fy:      true,
  proforma_prefix:    'PRO',
  estimate_prefix:    'EST',
  credit_note_prefix: 'CN',
  debit_note_prefix:  'DN',
  // separate counters per type
  proforma_number:    1,
  estimate_number:    1,
  credit_note_number: 1,
  debit_note_number:  1,
  separate_sequences: false,

  // Identity
  invoice_title:       'Tax Invoice',
  proforma_title:      'Proforma Invoice',
  estimate_title:      'Estimate / Quotation',
  credit_note_title:   'Credit Note',
  debit_note_title:    'Debit Note',
  footer_line:         'Thank you for your business!',
  signatory_name:      '',
  signatory_label:     'Authorised Signatory',
  show_logo:           true,
  show_gstin:          true,
  show_bank_details:   true,
  show_signature_box:  true,
  show_seal:           false,
  show_qr_code:        false,
  show_due_date:       true,
  show_po_number:      true,
  show_hsn_column:     true,
  show_discount_column:true,
  show_eway_bill:      false,
  show_vehicle_no:     false,

  // Defaults
  default_payment_terms: 'Due within 30 days',
  default_due_days:      30,
  default_notes:         '',
  default_terms:         '',
  default_gst_rate:      18,
  // Your company's own registered PIN code. Typing a 6-digit PIN here
  // auto-fills Supply State (and its GST state-code) below, which every
  // new invoice then uses to auto-decide CGST+SGST vs IGST against the
  // client's / place-of-supply's state (see frontend/src/lib/pincode.js).
  supply_pincode:        '',
  supply_state:          '',
  supply_state_code:     '',
  currency_symbol:       '₹',
  date_format:           'DD/MM/YYYY',
  round_off:             true,

  // Bank & UPI
  bank_account_holder: '',
  bank_name:           '',
  bank_account_no:     '',
  bank_ifsc:           '',
  bank_branch:         '',
  bank_account_type:   'Current',
  upi_id:              '',
  linked_bank_account_id: '',
  lock_invoice_bank:   false,

  // Design
  template:     'classic',
  theme:        'ocean',
  custom_color: '#0D3B66',
};

// ─── Storage helpers ──────────────────────────────────────────────────────────
function loadAll() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
export function getInvSettings(companyId) {
  const all = loadAll();
  return { ...DEFAULT_INV_SETTINGS, ...(all[companyId] || {}) };
}
function saveInvSettings(companyId, settings) {
  const all = loadAll();
  all[companyId] = settings;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
}

// ─── Sample invoice builder for settings preview ──────────────────────────────
function makeSampleInvoiceForSettings(companyId, settings) {
  const items = [
    {
      description:   'GST Return Filing (Monthly)',
      hsn_sac:       '998311',
      quantity:      1,
      unit:          'month',
      unit_price:    2500,
      discount_pct:  0,
      gst_rate:      settings.default_gst_rate ?? 18,
    },
    {
      description:   'Income Tax Return — Individual',
      hsn_sac:       '998311',
      quantity:      1,
      unit:          'service',
      unit_price:    3500,
      discount_pct:  10,
      gst_rate:      settings.default_gst_rate ?? 18,
    },
    {
      description:   'Bookkeeping & Accounting',
      hsn_sac:       '998222',
      quantity:      3,
      unit:          'month',
      unit_price:    1500,
      discount_pct:  0,
      gst_rate:      settings.default_gst_rate ?? 18,
    },
  ];

  return {
    invoice_no:       'INV/2025-26/0042',
    invoice_type:     'tax_invoice',
    invoice_date:     '2025-07-15',
    due_date:         '2025-08-14',
    client_name:      'Sunrise Technologies Pvt. Ltd.',
    client_address:   '14 Patel Nagar, Ahmedabad, Gujarat – 380009',
    client_email:     'accounts@sunrise.in',
    client_phone:     '9876543210',
    client_gstin:     '24AABCS1429B1Z5',
    client_state:     'Gujarat',
    payment_terms:    settings.default_payment_terms || 'Net 30 Days',
    reference_no:     'PO/2025/1138',
    is_interstate:    false,
    items,
    amount_paid:      10000,
    notes:            settings.default_notes || 'Payment via NEFT/RTGS to bank details below.',
    terms_conditions: settings.default_terms  || 'Goods once sold will not be returned.',
  };
}

// ─── FY helper ────────────────────────────────────────────────────────────────
function getIndianFY(date = new Date()) {
  const m = date.getMonth(), y = date.getFullYear();
  return m >= 3 ? { start: y, end: y + 1 } : { start: y - 1, end: y };
}

// ─── Number generator ────────────────────────────────────────────────────────
export function getNextInvoiceNumber(companyId, type = 'invoice', increment = false) {
  const s   = getInvSettings(companyId);
  const now = new Date();
  const fy  = getIndianFY(now);

  const counterKey = {
    invoice:     'current_number',
    proforma:    s.separate_sequences ? 'proforma_number'    : 'current_number',
    estimate:    s.separate_sequences ? 'estimate_number'    : 'current_number',
    credit_note: s.separate_sequences ? 'credit_note_number' : 'current_number',
    debit_note:  s.separate_sequences ? 'debit_note_number'  : 'current_number',
  }[type] || 'current_number';

  const prefixMap = {
    invoice:     s.prefix,
    proforma:    s.proforma_prefix    || s.prefix,
    estimate:    s.estimate_prefix    || s.prefix,
    credit_note: s.credit_note_prefix || 'CN',
    debit_note:  s.debit_note_prefix  || 'DN',
  };

  const prefix = prefixMap[type] || s.prefix;
  const fyStr  = s.fy_format === 'long'
    ? `${fy.start}-${fy.end}`
    : `${String(fy.start).slice(2)}-${String(fy.end).slice(2)}`;
  const month  = String(now.getMonth() + 1).padStart(2, '0');
  const num    = String(s[counterKey] || 1).padStart(s.number_padding, '0');
  const sep    = (!s.separator || s.separator === 'none') ? '' : s.separator;
  const parts  = [prefix];
  if (s.include_fy)    parts.push(fyStr);
  if (s.include_month) parts.push(month);
  parts.push(num);

  if (increment) {
    saveInvSettings(companyId, { ...s, [counterKey]: (s[counterKey] || 1) + 1 });
  }
  return parts.join(sep);
}

// ─── Preview (uses local form state) ─────────────────────────────────────────
function previewNumber(s, type = 'invoice') {
  const fy  = getIndianFY();
  const counterKey = {
    invoice:     'current_number',
    proforma:    s.separate_sequences ? 'proforma_number'    : 'current_number',
    estimate:    s.separate_sequences ? 'estimate_number'    : 'current_number',
    credit_note: s.separate_sequences ? 'credit_note_number' : 'current_number',
    debit_note:  s.separate_sequences ? 'debit_note_number'  : 'current_number',
  }[type] || 'current_number';

  const prefixMap = {
    invoice:     s.prefix,
    proforma:    s.proforma_prefix    || s.prefix,
    estimate:    s.estimate_prefix    || s.prefix,
    credit_note: s.credit_note_prefix || 'CN',
    debit_note:  s.debit_note_prefix  || 'DN',
  };
  const prefix = prefixMap[type] || s.prefix;
  const fyStr  = s.fy_format === 'long'
    ? `${fy.start}-${fy.end}`
    : `${String(fy.start).slice(2)}-${String(fy.end).slice(2)}`;
  const month  = String(new Date().getMonth() + 1).padStart(2, '0');
  const num    = String(s[counterKey] || 1).padStart(s.number_padding || 3, '0');
  const sep    = (!s.separator || s.separator === 'none') ? '' : s.separator;
  const parts  = [prefix];
  if (s.include_fy)    parts.push(fyStr);
  if (s.include_month) parts.push(month);
  parts.push(num);
  return parts.join(sep);
}

// ─── Avatar gradient ─────────────────────────────────────────────────────────
const GRADS = [
  ['#0D3B66','#1F6FB2'],['#064e3b','#059669'],['#7c2d12','#ea580c'],
  ['#4c1d95','#7c3aed'],['#881337','#e11d48'],['#134e4a','#0d9488'],
];
const avatarGrad = name => {
  const i = ((name || '').charCodeAt(0) || 0) % GRADS.length;
  return `linear-gradient(135deg,${GRADS[i][0]},${GRADS[i][1]})`;
};

// ─── Tabs config ──────────────────────────────────────────────────────────────
const TABS = [
  { id: 'numbering', label: 'Numbering',  icon: Hash,      sub: 'Format & sequence' },
  { id: 'identity',  label: 'Identity',   icon: FileText,  sub: 'Titles & display'  },
  { id: 'defaults',  label: 'Defaults',   icon: StickyNote,sub: 'Terms & notes'     },
  { id: 'bank',      label: 'Bank / UPI', icon: Landmark,  sub: 'Payment details'   },
  { id: 'design',    label: 'Design',     icon: Palette,   sub: 'Template & theme'  },
  { id: 'preview',   label: 'Preview',    icon: Eye,        sub: 'Live invoice mock' },
];

// ════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ════════════════════════════════════════════════════════════════════════════
export default function InvoiceSettings({ open, onClose, companies = [], isDark }) {
  const { user } = useAuth();
  const canEditInvoiceSettings = canPerformFinixAction(user, 'can_view_sale', 'edit');
  const [cid,   setCid]   = useState('');
  const [form,  setForm]  = useState({ ...DEFAULT_INV_SETTINGS });
  const [tab,   setTab]   = useState('numbering');
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  const [settingsPreviewHtml, setSettingsPreviewHtml] = useState('');
  const [previewKey, setPreviewKey]                   = useState(0);
  const [bankAccounts, setBankAccounts]               = useState([]);

  useEffect(() => {
    if (!cid) return;
    api.get('/bank-accounts/picker-list', { params: { company_id: cid } })
      .then(r => setBankAccounts(r.data || []))
      .catch(() => {});
  }, [cid]);

  useEffect(() => {
    if (open) {
      const id = cid || companies[0]?.id || '';
      setCid(id);
      if (id) setForm({ ...getInvSettings(id), ...bankFromCompany(companies.find(c => c.id === id)) });
      setTab('numbering');
      setSaved(false);
    }
  }, [open]); // eslint-disable-line

  useEffect(() => {
    if (cid) setForm({ ...getInvSettings(cid), ...bankFromCompany(companies.find(c => c.id === cid)) });
    setSaved(false);
  }, [cid, companies]);

  useEffect(() => {
    if (tab !== 'preview' || !cid) return;

    const sampleInv = makeSampleInvoiceForSettings(cid, form);
    const company   = {
      ...(companies.find(c => c.id === cid) || {}),
      bank_name:        form.bank_name,
      bank_account_no:  form.bank_account_no,
      bank_account:     form.bank_account_no,
      bank_ifsc:        form.bank_ifsc,
      bank_branch:      form.bank_branch,
      upi_id:           form.upi_id,
      show_qr_code:     form.show_qr_code,
      invoice_title:    form.invoice_title,
      signatory_name:   form.signatory_name,
      signatory_label:  form.signatory_label,
      footer_line:      form.footer_line,
    };

    const html = generateInvoiceHTML(sampleInv, {
      company,
      template:    form.template    || 'classic',
      theme:       form.theme       || 'classic_blue',
      customColor: form.custom_color || '#0D3B66',
    });

    setSettingsPreviewHtml(html);
    setPreviewKey(k => k + 1);
  }, [tab, cid, form, companies]);

  const set = useCallback((k, v) => setForm(p => ({ ...p, [k]: v })), []);

  const handleSave = useCallback(async () => {
    if (!canEditInvoiceSettings) { toast.error('Edit permission is required. Ask your admin to grant it in Permission Matrix.'); return; }
    if (!cid) { toast.error('Select a company first'); return; }
    const updatedForm = { ...form, lock_invoice_bank: true };
    setForm(updatedForm);
    saveInvSettings(cid, updatedForm);

    try {
      await api.put(`/companies/${cid}`, {
        bank_account_name:  updatedForm.bank_account_holder,
        bank_account_holder:updatedForm.bank_account_holder,
        bank_name:          updatedForm.bank_name,
        bank_account_no:    updatedForm.bank_account_no,
        bank_ifsc:          updatedForm.bank_ifsc,
        bank_branch:        updatedForm.bank_branch,
        bank_account_type:  updatedForm.bank_account_type,
        upi_id:             updatedForm.upi_id,
      });
      // Mirror the same bank details into the Quotation settings (and back
      // into Invoice settings) so all three places stay in sync instantly.
      mirrorBankToSettings(cid, updatedForm);
    } catch (err) {
      toast.warning('Settings saved locally but failed to sync bank/UPI to server');
    }

    setSaved(true);
    toast.success(`Saved — ${companies.find(c => c.id === cid)?.name}`);
    setTimeout(() => setSaved(false), 2500);
  }, [cid, form, companies, canEditInvoiceSettings]);

  const handleReset = useCallback(() => {
    if (!canEditInvoiceSettings) { toast.error('Edit permission is required. Ask your admin to grant it in Permission Matrix.'); return; }
    if (!window.confirm('Reset all settings for this company to defaults?')) return;
    const fresh = { ...DEFAULT_INV_SETTINGS };
    setForm(fresh);
    if (cid) saveInvSettings(cid, fresh);
    toast.success('Reset to defaults');
  }, [cid, canEditInvoiceSettings]);

  const copyNum = (val) => {
    navigator.clipboard.writeText(val).then(() => {
      setCopied(val);
      setTimeout(() => setCopied(''), 1500);
    });
  };

  const selectedCompany = companies.find(c => c.id === cid);

  // ── Style helpers ───────────────────────────────────────────────────────
  const D = isDark;
  const card  = `rounded-2xl border p-5 ${D ? 'bg-slate-800/50 border-slate-700/60' : 'bg-white border-slate-200/80'} shadow-sm`;
  const lbl   = `block text-[10px] font-bold uppercase tracking-widest mb-1.5 ${D ? 'text-slate-400' : 'text-slate-500'}`;
  const inp   = `h-9 rounded-xl text-sm ${D ? 'bg-slate-700/80 border-slate-600 text-slate-100 placeholder:text-slate-500 focus:border-blue-500' : 'bg-white border-slate-200 focus:border-blue-400'}`;
  const inpLg = `rounded-xl text-sm min-h-[80px] resize-none ${D ? 'bg-slate-700/80 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-200'}`;
  const secH  = (t, s) => (
    <div className="mb-4">
      <h3 className={`text-sm font-bold ${D ? 'text-slate-100' : 'text-slate-800'}`}>{t}</h3>
      {s && <p className="text-xs text-slate-400 mt-0.5">{s}</p>}
    </div>
  );

  // ─── Document types for preview ──────────────────────────────────────────
  const DOC_TYPES = [
    { type: 'invoice',     label: 'Tax Invoice' },
    { type: 'proforma',    label: 'Proforma' },
    { type: 'estimate',    label: 'Estimate' },
    { type: 'credit_note', label: 'Credit Note' },
    { type: 'debit_note',  label: 'Debit Note' },
  ];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        className={[
          'max-w-[min(1120px,96vw)] w-[1120px]',
          'h-[min(700px,92vh)]',
          'flex flex-col overflow-hidden',
          'rounded-2xl border shadow-2xl p-0',
          '[&>button.absolute]:hidden',
          D ? 'bg-slate-900 border-slate-700' : 'bg-slate-50 border-slate-200',
        ].join(' ')}
      >
        <DialogTitle className="sr-only">Invoice Settings</DialogTitle>
        <DialogDescription className="sr-only">Per-company invoice configuration</DialogDescription>

        {/* ══ HEADER ════════════════════════════════════════════════════════ */}
        <div
          className="flex-shrink-0 px-6 py-4 relative overflow-hidden"
          style={{ background: 'linear-gradient(135deg,#0D3B66 0%,#1a5fa8 60%,#2176c7 100%)' }}
        >
          <div className="absolute -right-10 -top-10 w-48 h-48 rounded-full opacity-[.08]"
            style={{ background: 'radial-gradient(circle,white 0%,transparent 70%)' }} />
          <div className="absolute right-32 bottom-0 w-24 h-24 rounded-full opacity-[.06]"
            style={{ background: 'radial-gradient(circle,white 0%,transparent 70%)' }} />

          <div className="relative flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
                <Settings className="h-5 w-5 text-white" />
              </div>
              <div>
                <h2 className="text-white font-bold text-lg leading-tight">Invoice Settings</h2>
                <p className="text-blue-200 text-xs mt-0.5">Per-company configuration</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {canEditInvoiceSettings && <Button size="sm" onClick={handleReset}
                className="h-8 px-3 text-xs rounded-xl bg-white/10 hover:bg-white/20 text-white border border-white/20 gap-1.5">
                <RotateCcw className="h-3 w-3" /> Reset
              </Button>}
              {canEditInvoiceSettings && <Button size="sm" onClick={handleSave}
                className={`h-8 px-4 text-xs rounded-xl font-semibold gap-1.5 transition-all ${saved ? 'bg-emerald-500 text-white' : 'bg-white text-slate-800 hover:bg-blue-50'}`}>
                {saved ? <><Check className="h-3.5 w-3.5" />Saved!</> : <><Save className="h-3.5 w-3.5" />Save</>}
              </Button>}
              <button onClick={onClose}
                className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all">
                <X className="h-4 w-4 text-white" />
              </button>
            </div>
          </div>
        </div>

        {/* ══ BODY ══════════════════════════════════════════════════════════ */}
        <div className="flex-1 overflow-hidden flex min-h-0">

          {/* ── LEFT: company list ─────────────────────────────────────────── */}
          <aside className={`w-52 flex-shrink-0 border-r flex flex-col overflow-hidden ${D ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-white'}`}>
            <div className={`px-4 py-2.5 border-b flex-shrink-0 ${D ? 'border-slate-700' : 'border-slate-200'}`}>
              <p className="text-[9px] font-bold uppercase tracking-widest text-slate-400">Companies</p>
            </div>
            <div className="flex-1 overflow-y-auto py-1.5">
              {companies.length === 0 ? (
                <div className="flex flex-col items-center py-10 gap-2 px-4 text-center">
                  <Building2 className="h-7 w-7 opacity-20" />
                  <p className="text-xs text-slate-400">Add a company profile first.</p>
                </div>
              ) : companies.map(c => {
                const active = c.id === cid;
                return (
                  <button key={c.id} onClick={() => setCid(c.id)}
                    className={[
                      'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left transition-all',
                      active
                        ? (D ? 'bg-blue-900/40 border-r-2 border-blue-400' : 'bg-blue-50 border-r-2 border-blue-500')
                        : (D ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50'),
                    ].join(' ')}>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0 overflow-hidden"
                      style={{ background: c.logo_base64 ? 'transparent' : avatarGrad(c.name) }}>
                      {c.logo_base64
                        ? <img src={c.logo_base64} alt={c.name} className="w-full h-full object-contain" />
                        : (c.name || '?').charAt(0).toUpperCase()
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-xs font-semibold truncate ${active ? 'text-blue-600 dark:text-blue-400' : (D ? 'text-slate-200' : 'text-slate-800')}`}>
                        {c.name}
                      </p>
                      {c.gstin && <p className="text-[9px] font-mono text-slate-400 truncate">{c.gstin}</p>}
                    </div>
                    {active && <ChevronRight className="h-3 w-3 text-blue-500 flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          </aside>

          {/* ── RIGHT: settings ────────────────────────────────────────────── */}
          {!cid ? (
            <div className="flex-1 flex items-center justify-center flex-col gap-3">
              <Settings className="h-10 w-10 opacity-15" />
              <p className={`text-sm font-medium ${D ? 'text-slate-500' : 'text-slate-400'}`}>Select a company to configure</p>
            </div>
          ) : (
            <div className="flex-1 overflow-hidden flex flex-col min-w-0">

              {/* Tab bar */}
              <div className={`flex border-b flex-shrink-0 overflow-x-auto scrollbar-none ${D ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-white'}`}>
                {TABS.map(t => (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className={[
                      'flex items-center gap-1.5 px-4 py-3 text-xs font-semibold border-b-2 transition-all whitespace-nowrap flex-shrink-0',
                      tab === t.id
                        ? `border-blue-500 ${D ? 'text-blue-400 bg-blue-900/20' : 'text-blue-600 bg-blue-50/60'}`
                        : `border-transparent ${D ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/30' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'}`,
                    ].join(' ')}>
                    <t.icon className="h-3.5 w-3.5 flex-shrink-0" />
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Scrollable content */}
              <div className="flex-1 overflow-y-auto p-5 space-y-4">

                {/* ══ TAB: NUMBERING ══════════════════════════════════════════ */}
                {tab === 'numbering' && (
                  <>
                    {/* Live preview strip */}
                    <div className={`rounded-2xl p-4 border ${D ? 'bg-blue-950/40 border-blue-800/60' : 'bg-blue-50 border-blue-200'}`}>
                      <p className={`text-[9px] font-bold uppercase tracking-widest mb-3 ${D ? 'text-blue-400' : 'text-blue-600'}`}>
                        Live Preview — All Document Types
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {DOC_TYPES.map(({ type, label }) => {
                          const val = previewNumber(form, type);
                          return (
                            <div key={type}
                              className={`flex items-center gap-2 px-3 py-2 rounded-xl border ${D ? 'bg-slate-700/70 border-slate-600' : 'bg-white border-slate-200'}`}>
                              <span className={`text-[9px] font-medium ${D ? 'text-slate-400' : 'text-slate-500'}`}>{label}:</span>
                              <span className={`font-mono font-bold text-sm ${D ? 'text-blue-300' : 'text-blue-700'}`}>{val}</span>
                              <button onClick={() => copyNum(val)}
                                className={`transition-colors ${copied === val ? 'text-emerald-500' : 'text-slate-400 hover:text-slate-600'}`}>
                                {copied === val ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      {/* Main format */}
                      <div className={card}>
                        {secH('Invoice Number Format', 'Applied to Tax Invoices by default')}
                        <div className="space-y-3.5">
                          <div>
                            <label className={lbl}>Prefix</label>
                            <Input className={inp} placeholder="INV" value={form.prefix}
                              onChange={e => set('prefix', e.target.value.toUpperCase())} />
                            <p className="text-[10px] text-slate-400 mt-1">e.g. INV, TAX, GST, your initials</p>
                          </div>
                          <div>
                            <label className={lbl}>Separator</label>
                            <Select value={form.separator} onValueChange={v => set('separator', v)}>
                              <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="/">Forward slash &nbsp;( / )</SelectItem>
                                <SelectItem value="-">Hyphen &nbsp;( - )</SelectItem>
                                <SelectItem value="_">Underscore &nbsp;( _ )</SelectItem>
                                <SelectItem value=".">Dot &nbsp;( . )</SelectItem>
                                <SelectItem value="none">No separator</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <label className={lbl}>Number Padding</label>
                            <Select value={String(form.number_padding)} onValueChange={v => set('number_padding', parseInt(v))}>
                              <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="2">2 digits — 01, 02 …</SelectItem>
                                <SelectItem value="3">3 digits — 001, 002 …</SelectItem>
                                <SelectItem value="4">4 digits — 0001, 0002 …</SelectItem>
                                <SelectItem value="5">5 digits — 00001 …</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div>
                            <label className={lbl}>Starting / Current Number</label>
                            <Input type="number" min="1" className={inp} value={form.current_number}
                              onChange={e => set('current_number', parseInt(e.target.value) || 1)} />
                            <p className="text-[10px] text-slate-400 mt-1">Next invoice will use this number</p>
                          </div>
                        </div>
                      </div>

                      {/* FY & toggles */}
                      <div className={card}>
                        {secH('Financial Year & Options')}
                        <div className="space-y-3.5">
                          <div className="flex items-center justify-between">
                            <div>
                              <p className={`text-sm font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Include Financial Year</p>
                              <p className="text-xs text-slate-400">Adds FY e.g. 25-26</p>
                            </div>
                            <Switch checked={form.include_fy} onCheckedChange={v => set('include_fy', v)} />
                          </div>
                          {form.include_fy && (
                            <div>
                              <label className={lbl}>FY Format</label>
                              <Select value={form.fy_format} onValueChange={v => set('fy_format', v)}>
                                <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="short">Short — 25-26</SelectItem>
                                  <SelectItem value="long">Long — 2025-2026</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <div>
                              <p className={`text-sm font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Include Month</p>
                              <p className="text-xs text-slate-400">e.g. INV/25-26/03/001</p>
                            </div>
                            <Switch checked={form.include_month} onCheckedChange={v => set('include_month', v)} />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <p className={`text-sm font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Auto-reset on new FY</p>
                              <p className="text-xs text-slate-400">Counter resets to 1 on Apr 1</p>
                            </div>
                            <Switch checked={form.auto_reset_fy} onCheckedChange={v => set('auto_reset_fy', v)} />
                          </div>
                          <div className="flex items-center justify-between">
                            <div>
                              <p className={`text-sm font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Separate Sequences</p>
                              <p className="text-xs text-slate-400">Each type has its own counter</p>
                            </div>
                            <Switch checked={form.separate_sequences} onCheckedChange={v => set('separate_sequences', v)} />
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Doc-specific prefixes */}
                    <div className={card}>
                      {secH('Document-Specific Prefixes', 'Override prefix per document type')}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        {[
                          { pKey: 'proforma_prefix',    nKey: 'proforma_number',    label: 'Proforma',    ph: 'PRO' },
                          { pKey: 'estimate_prefix',    nKey: 'estimate_number',    label: 'Estimate',    ph: 'EST' },
                          { pKey: 'credit_note_prefix', nKey: 'credit_note_number', label: 'Credit Note', ph: 'CN'  },
                          { pKey: 'debit_note_prefix',  nKey: 'debit_note_number',  label: 'Debit Note',  ph: 'DN'  },
                        ].map(({ pKey, nKey, label, ph }) => (
                          <div key={pKey} className="space-y-2">
                            <label className={lbl}>{label}</label>
                            <Input className={inp} placeholder={ph} value={form[pKey]}
                              onChange={e => set(pKey, e.target.value.toUpperCase())} />
                            {form.separate_sequences && (
                              <Input type="number" min="1" className={inp} placeholder="Start #" value={form[nKey]}
                                onChange={e => set(nKey, parseInt(e.target.value) || 1)} />
                            )}
                          </div>
                        ))}
                      </div>
                      {!form.separate_sequences && (
                        <p className="text-[10px] text-slate-400 mt-3">
                          Enable "Separate Sequences" above to set individual counters per type.
                        </p>
                      )}
                    </div>
                  </>
                )}

                {/* ══ TAB: IDENTITY ═══════════════════════════════════════════ */}
                {tab === 'identity' && (
                  <>
                    {/* Company identity preview */}
                    <div className={`rounded-2xl p-4 border ${D ? 'bg-slate-800/50 border-slate-700/60' : 'bg-white border-slate-200/80'} shadow-sm`}>
                      <p className={`text-[9px] font-bold uppercase tracking-widest mb-3 ${D ? 'text-slate-400' : 'text-slate-500'}`}>
                        Company Identity Preview
                      </p>
                      <div className="flex items-center gap-4">
                        <div className={`w-16 h-16 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden border-2 ${D ? 'border-slate-600 bg-slate-700' : 'border-slate-200 bg-slate-50'}`}>
                          {selectedCompany?.logo_base64 ? (
                            <img src={selectedCompany.logo_base64} alt="Company logo" className="w-full h-full object-contain p-1" />
                          ) : (
                            <div className="flex flex-col items-center gap-1">
                              <Building2 className={`h-6 w-6 ${D ? 'text-slate-500' : 'text-slate-300'}`} />
                              <p className={`text-[8px] ${D ? 'text-slate-500' : 'text-slate-400'}`}>No logo</p>
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`font-bold text-base truncate ${D ? 'text-slate-100' : 'text-slate-800'}`}>
                            {selectedCompany?.name || '—'}
                          </p>
                          {selectedCompany?.gstin && (
                            <p className="font-mono text-xs text-slate-400 mt-0.5">GSTIN: {selectedCompany.gstin}</p>
                          )}
                          {selectedCompany?.address && (
                            <p className="text-xs text-slate-400 mt-0.5 truncate">{selectedCompany.address}</p>
                          )}
                          {(selectedCompany?.phone || selectedCompany?.email) && (
                            <p className="text-xs text-slate-400 mt-0.5 truncate">
                              {[selectedCompany.phone, selectedCompany.email].filter(Boolean).join('  ·  ')}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-col gap-1.5 flex-shrink-0">
                          {selectedCompany?.logo_base64 ? (
                            <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                              ✓ Logo Set
                            </span>
                          ) : (
                            <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400">
                              No Logo
                            </span>
                          )}
                          {selectedCompany?.signature_base64 && (
                            <span className="text-[9px] font-bold px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400">
                              ✓ Signature
                            </span>
                          )}
                        </div>
                      </div>
                      {!selectedCompany?.logo_base64 && (
                        <p className={`text-[10px] mt-3 pt-3 border-t ${D ? 'border-slate-700 text-slate-400' : 'border-slate-100 text-slate-400'}`}>
                          Upload a logo in <strong>Manage Companies</strong> on the Quotations page.
                        </p>
                      )}
                    </div>

                    <div className={card}>
                      {secH('Document Titles', 'Heading printed at the top of each document type')}
                      <div className="grid grid-cols-2 gap-3.5">
                        {[
                          { key: 'invoice_title',     label: 'Tax Invoice',          ph: 'Tax Invoice' },
                          { key: 'proforma_title',    label: 'Proforma Invoice',     ph: 'Proforma Invoice' },
                          { key: 'estimate_title',    label: 'Estimate / Quotation', ph: 'Estimate / Quotation' },
                          { key: 'credit_note_title', label: 'Credit Note',          ph: 'Credit Note' },
                          { key: 'debit_note_title',  label: 'Debit Note',           ph: 'Debit Note' },
                          { key: 'footer_line',       label: 'Footer Line',          ph: 'Thank you for your business!' },
                        ].map(({ key, label, ph }) => (
                          <div key={key}>
                            <label className={lbl}>{label}</label>
                            <Input className={inp} placeholder={ph} value={form[key]}
                              onChange={e => set(key, e.target.value)} />
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className={card}>
                      {secH('Authorised Signatory', 'Text shown in signature / seal area')}
                      <div className="grid grid-cols-2 gap-3.5">
                        <div>
                          <label className={lbl}>Signatory Name</label>
                          <Input className={inp} placeholder="e.g. Rahul Shah" value={form.signatory_name}
                            onChange={e => set('signatory_name', e.target.value)} />
                        </div>
                        <div>
                          <label className={lbl}>Signatory Label</label>
                          <Input className={inp} placeholder="Authorised Signatory" value={form.signatory_label}
                            onChange={e => set('signatory_label', e.target.value)} />
                        </div>
                      </div>
                    </div>

                    <div className={card}>
                      {secH('Show / Hide Sections', 'Toggle fields on printed invoices')}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
                        {[
                          { key: 'show_logo',            label: 'Company Logo' },
                          { key: 'show_gstin',           label: 'GSTIN on Invoice' },
                          { key: 'show_bank_details',    label: 'Bank Details' },
                          { key: 'show_signature_box',   label: 'Signature Box' },
                          { key: 'show_seal',            label: 'Company Seal Placeholder' },
                          { key: 'show_qr_code',         label: 'UPI QR Code' },
                          { key: 'show_due_date',        label: 'Due Date' },
                          { key: 'show_po_number',       label: 'PO / Reference No.' },
                          { key: 'show_hsn_column',      label: 'HSN/SAC Column' },
                          { key: 'show_discount_column', label: 'Discount Column' },
                          { key: 'show_eway_bill',       label: 'E-Way Bill No.' },
                          { key: 'show_vehicle_no',      label: 'Vehicle / Transport No.' },
                        ].map(({ key, label }) => (
                          <div key={key} className="flex items-center justify-between gap-2">
                            <p className={`text-xs ${D ? 'text-slate-300' : 'text-slate-700'}`}>{label}</p>
                            <Switch checked={!!form[key]} onCheckedChange={v => set(key, v)} />
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {/* ══ TAB: DEFAULTS ═══════════════════════════════════════════ */}
                {tab === 'defaults' && (
                  <>
                    <div className={card}>
                      {secH('Payment & Tax Defaults', 'Pre-filled when creating a new invoice')}
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3.5">
                        <div>
                          <label className={lbl}>Default Payment Terms</label>
                          <Input className={inp} placeholder="Due within 30 days"
                            value={form.default_payment_terms}
                            onChange={e => set('default_payment_terms', e.target.value)} />
                        </div>
                        <div>
                          <label className={lbl}>Default Due Days</label>
                          <Input type="number" min="0" className={inp} value={form.default_due_days}
                            onChange={e => set('default_due_days', parseInt(e.target.value) || 30)} />
                        </div>
                        <div>
                          <label className={lbl}>Default GST Rate (%)</label>
                          <Select value={String(form.default_gst_rate)} onValueChange={v => set('default_gst_rate', parseFloat(v))}>
                            <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {[0, 5, 12, 18, 28].map(r => (
                                <SelectItem key={r} value={String(r)}>{r}%</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className={lbl}>Currency Symbol</label>
                          <Select value={form.currency_symbol} onValueChange={v => set('currency_symbol', v)}>
                            <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="₹">₹ — Indian Rupee</SelectItem>
                              <SelectItem value="$">$ — US Dollar</SelectItem>
                              <SelectItem value="€">€ — Euro</SelectItem>
                              <SelectItem value="£">£ — British Pound</SelectItem>
                              <SelectItem value="AED">AED — UAE Dirham</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className={lbl}>Date Format</label>
                          <Select value={form.date_format} onValueChange={v => set('date_format', v)}>
                            <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                              <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                              <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                              <SelectItem value="DD-MMM-YYYY">DD-MMM-YYYY</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <label className={lbl}>Your Company PIN Code</label>
                          <Input className={`${inp} font-mono`} placeholder="6-digit PIN" maxLength={6}
                            value={form.supply_pincode}
                            onChange={async e => {
                              const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                              set('supply_pincode', digits);
                              if (digits.length === 6) {
                                const r = await lookupPincode(digits);
                                if (r?.valid) {
                                  set('supply_state', r.state);
                                  set('supply_state_code', r.state_code || '');
                                  toast.success(`Supply State auto-set to ${r.state}`);
                                }
                              }
                            }} />
                          <p className="text-[10px] text-slate-400 mt-1">Auto-fills Supply State on the right</p>
                        </div>
                        <div>
                          <label className={lbl}>Supply State</label>
                          <Input className={inp} placeholder="e.g. Gujarat" value={form.supply_state}
                            onChange={e => { set('supply_state', e.target.value); set('supply_state_code', ''); }} />
                          <p className="text-[10px] text-slate-400 mt-1">Auto-detect IGST vs CGST+SGST — editable if the PIN lookup is wrong</p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-4 pt-4 border-t border-slate-200 dark:border-slate-700">
                        <div>
                          <p className={`text-sm font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Round Off Total</p>
                          <p className="text-xs text-slate-400">Round invoice total to nearest rupee</p>
                        </div>
                        <Switch checked={form.round_off} onCheckedChange={v => set('round_off', v)} />
                      </div>
                    </div>

                    <div className={card}>
                      {secH('Default Notes & Terms', 'Pre-filled on every new invoice — can be overridden per invoice')}
                      <div className="space-y-3.5">
                        <div>
                          <label className={lbl}>Default Notes (shown on invoice)</label>
                          <Textarea className={inpLg} placeholder="e.g. All payments subject to clearance…"
                            value={form.default_notes} onChange={e => set('default_notes', e.target.value)} />
                        </div>
                        <div>
                          <label className={lbl}>Default Terms & Conditions</label>
                          <Textarea className={`${inpLg} min-h-[100px]`}
                            placeholder="e.g. Goods once sold will not be taken back…"
                            value={form.default_terms} onChange={e => set('default_terms', e.target.value)} />
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ══ TAB: BANK / UPI ═════════════════════════════════════════ */}
                {tab === 'bank' && (
                  <>
                    <div className={`rounded-2xl p-3.5 border flex items-start gap-3 ${D ? 'bg-amber-900/20 border-amber-700/50' : 'bg-amber-50 border-amber-200'}`}>
                      <AlertCircle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700 dark:text-amber-300">
                        Bank details are printed on invoices. Verify the account number and IFSC before saving.
                      </p>
                    </div>

                    <div className={`flex items-center justify-between p-3.5 rounded-2xl border ${D ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'} mt-3 mb-1`}>
                      <div>
                        <p className={`text-xs font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Lock Invoice Bank Details</p>
                        <p className="text-[10px] text-slate-400">Prevent other pages (Bank Accounts or Quotation settings) from overwriting these details</p>
                      </div>
                      <Switch checked={!!form.lock_invoice_bank} onCheckedChange={v => set('lock_invoice_bank', v)} />
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                      <div className={card}>
                        {secH('Bank Account', 'Shown on invoice for direct transfers')}
                        <div className="space-y-3">
                          <div>
                            <label className={lbl}>Link Bank Account</label>
                            <Select
                              value={form.linked_bank_account_id || '__none__'}
                              onValueChange={v => {
                                if (v === '__none__') {
                                  setForm(p => ({ ...p, linked_bank_account_id: '' }));
                                  return;
                                }
                                const ba = bankAccounts.find(b => b.id === v);
                                if (ba) {
                                  setForm(p => ({
                                    ...p,
                                    linked_bank_account_id: v,
                                    bank_name:           ba.bank_name || p.bank_name,
                                    bank_account_holder: ba.account_holder || p.bank_account_holder,
                                    bank_account_no:     ba.account_number_full || ba.account_number_masked || p.bank_account_no,
                                    bank_ifsc:           ba.ifsc || p.bank_ifsc,
                                    bank_branch:         ba.branch || p.bank_branch,
                                    bank_account_type:   (ba.account_type || 'current').charAt(0).toUpperCase() + (ba.account_type || 'current').slice(1),
                                    upi_id:              ba.upi_id || p.upi_id,
                                  }));
                                }
                              }}
                            >
                              <SelectTrigger className={inp}>
                                <SelectValue placeholder="Select a bank account..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">— Not linked —</SelectItem>
                                {bankAccounts.map(ba => (
                                  <SelectItem key={ba.id} value={ba.id}>
                                    {ba.bank_name}{ba.account_number_masked ? ` · ${ba.account_number_masked}` : ''}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          {[
                            { key: 'bank_account_holder', label: 'Account Holder Name', ph: 'As per bank records' },
                            { key: 'bank_name',           label: 'Bank Name',           ph: 'e.g. HDFC Bank' },
                            { key: 'bank_account_no',     label: 'Account Number',      ph: '0000000000000' },
                            { key: 'bank_ifsc',           label: 'IFSC Code',           ph: 'HDFC0001234' },
                            { key: 'bank_branch',         label: 'Branch',              ph: 'e.g. Surat Main Branch' },
                          ].map(({ key, label, ph }) => (
                            <div key={key}>
                              <label className={lbl}>{label}</label>
                              <Input className={inp} placeholder={ph} value={form[key]}
                                onChange={e => set(key, e.target.value)} />
                            </div>
                          ))}
                          <div>
                            <label className={lbl}>Account Type</label>
                            <Select value={form.bank_account_type} onValueChange={v => set('bank_account_type', v)}>
                              <SelectTrigger className={inp}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="Current">Current Account</SelectItem>
                                <SelectItem value="Savings">Savings Account</SelectItem>
                                <SelectItem value="OD">OD Account</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>

                      <div className="space-y-4 flex flex-col">
                        {/* UPI */}
                        <div className={card}>
                          {secH('UPI / QR Payment')}
                          <div className="space-y-3">
                            <div>
                              <label className={lbl}>UPI ID</label>
                              <Input className={inp} placeholder="yourname@bankname" value={form.upi_id}
                                onChange={e => set('upi_id', e.target.value)} />
                            </div>
                            <div className="flex items-center justify-between">
                              <div>
                                <p className={`text-sm font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>Show QR on Invoice</p>
                                <p className="text-xs text-slate-400">UPI QR printed in footer</p>
                              </div>
                              <Switch checked={form.show_qr_code} onCheckedChange={v => set('show_qr_code', v)} />
                            </div>
                          </div>
                        </div>

                        {/* Bank preview */}
                        <div className={card}>
                          {secH('Preview', 'How this will appear on your invoice')}
                          <div className={`rounded-xl p-3.5 border text-xs space-y-1.5 font-mono ${D ? 'bg-slate-700/60 border-slate-600 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-700'}`}>
                            <p className={`font-bold text-[9px] uppercase tracking-wider mb-2 ${D ? 'text-slate-400' : 'text-slate-500'}`}>Bank Details</p>
                            <p><span className="text-slate-400 mr-1">Name:</span>{form.bank_account_holder || '—'}</p>
                            <p><span className="text-slate-400 mr-1">Bank:</span>{form.bank_name || '—'}</p>
                            <p><span className="text-slate-400 mr-1">A/C:</span>{form.bank_account_no || '—'}{form.bank_account_no && form.bank_account_type ? ` (${form.bank_account_type})` : ''}</p>
                            <p><span className="text-slate-400 mr-1">IFSC:</span>{form.bank_ifsc || '—'}</p>
                            {form.bank_branch && <p><span className="text-slate-400 mr-1">Branch:</span>{form.bank_branch}</p>}
                            {form.upi_id && <p><span className="text-slate-400 mr-1">UPI:</span>{form.upi_id}</p>}
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ══ TAB: DESIGN ═════════════════════════════════════════════ */}
                {tab === 'design' && (
                  <>
                    {/* Logo + color preview strip */}
                    <div className={`rounded-2xl p-4 border flex items-center gap-4 ${D ? 'bg-slate-800/50 border-slate-700/60' : 'bg-white border-slate-200/80'} shadow-sm`}>
                      <div className={`w-14 h-14 rounded-xl flex items-center justify-center flex-shrink-0 overflow-hidden border-2 ${D ? 'border-slate-600 bg-slate-700' : 'border-slate-200 bg-slate-50'}`}>
                        {selectedCompany?.logo_base64 ? (
                          <img src={selectedCompany.logo_base64} alt="logo" className="w-full h-full object-contain p-1" />
                        ) : (
                          <Building2 className={`h-5 w-5 ${D ? 'text-slate-500' : 'text-slate-300'}`} />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`font-semibold text-sm truncate ${D ? 'text-slate-200' : 'text-slate-700'}`}>{selectedCompany?.name}</p>
                        <p className="text-xs text-slate-400 mt-0.5">Template and theme below apply to this company's invoices</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <div className="w-8 h-8 rounded-lg shadow-sm"
                          style={{ background: form.theme === 'custom' ? form.custom_color : ((COLOR_THEMES || []).find(t => t.id === form.theme)?.primary || '#0D3B66') }} />
                        <div>
                          <p className={`text-[9px] font-bold uppercase tracking-wide ${D ? 'text-slate-400' : 'text-slate-500'}`}>Active Theme</p>
                          <p className={`text-xs font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>
                            {form.theme === 'custom' ? 'Custom' : ((COLOR_THEMES || []).find(t => t.id === form.theme)?.name || form.theme)}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className={card}>
                      {secH('Invoice Template', 'Default template when printing for this company')}
                      <div className="flex flex-wrap gap-3">
                        {(INVOICE_TEMPLATES || []).map(t => (
                          <button key={t.id} onClick={() => set('template', t.id)}
                            className={[
                              'flex flex-col items-center gap-2 rounded-xl border-2 p-3 transition-all',
                              form.template === t.id
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30'
                                : (D ? 'border-slate-600 hover:border-slate-500 bg-slate-700/30' : 'border-slate-200 hover:border-blue-300 bg-white'),
                            ].join(' ')}>
                            <div className={`w-14 h-18 rounded-lg overflow-hidden border flex flex-col gap-1 p-1.5 ${D ? 'bg-slate-600 border-slate-500' : 'bg-slate-100 border-slate-200'}`}
                              style={{ height: '4.5rem' }}>
                              <div className="h-3 rounded w-full" style={{ background: form.template === t.id ? '#1F6FB2' : (D ? '#4b5563' : '#cbd5e1') }} />
                              {[...Array(3)].map((_, i) => (
                                <div key={i} className={`h-1 rounded ${i === 2 ? 'w-2/3' : 'w-full'}`}
                                  style={{ background: D ? '#374151' : '#e2e8f0' }} />
                              ))}
                            </div>
                            <p className={`text-[10px] font-semibold text-center leading-tight ${form.template === t.id ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500'}`}>
                              {t.name}
                            </p>
                            {form.template === t.id && <Check className="h-3 w-3 text-blue-500" />}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className={card}>
                      {secH('Color Theme', 'Primary color used in the invoice template')}
                      <div className="flex flex-wrap gap-3">
                        {(COLOR_THEMES || []).map(t => (
                          <button key={t.id} onClick={() => set('theme', t.id)}
                            className={[
                              'flex flex-col items-center gap-2 p-3 rounded-xl border-2 transition-all',
                              form.theme === t.id
                                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                : (D ? 'border-slate-600 hover:border-slate-500 bg-slate-700/30' : 'border-slate-200 hover:border-blue-300 bg-white'),
                            ].join(' ')}>
                            <div className="w-9 h-9 rounded-xl shadow-sm overflow-hidden relative flex-shrink-0">
                              <div className="absolute inset-0" style={{ background: t.primary }} />
                              <div className="absolute right-0 bottom-0 w-4 h-4 rounded-tl-lg" style={{ background: t.secondary }} />
                            </div>
                            <p className={`text-[9px] font-semibold text-center leading-tight ${form.theme === t.id ? 'text-blue-600 dark:text-blue-400' : 'text-slate-400'}`}>
                              {t.name}
                            </p>
                            {form.theme === t.id && <Check className="h-3 w-3 text-blue-500" />}
                          </button>
                        ))}
                      </div>

                      {/* Custom color */}
                      <div className={`mt-5 pt-4 border-t ${D ? 'border-slate-700' : 'border-slate-200'}`}>
                        <label className={lbl}>Custom Brand Color</label>
                        <div className="flex items-center gap-3 mt-1.5">
                          <input type="color" value={form.custom_color}
                            onChange={e => { set('custom_color', e.target.value); set('theme', 'custom'); }}
                            className="w-10 h-9 rounded-lg cursor-pointer border border-slate-300 p-0.5 bg-transparent" />
                          <Input className={`${inp} w-32 font-mono uppercase`} value={form.custom_color}
                            onChange={e => { set('custom_color', e.target.value); set('theme', 'custom'); }} />
                          {form.theme === 'custom' && (
                            <span className="text-[10px] font-bold px-2.5 py-1 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">
                              ✓ Active
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </>
                )}

                {/* ══ TAB: PREVIEW ════════════════════════════════════════════ */}
                {tab === 'preview' && (
                  <div className="space-y-3">
                    {/* Toolbar */}
                    <div className="flex items-center justify-between px-1 flex-wrap gap-2">
                      <div>
                        <p className={`text-xs font-semibold ${D ? 'text-slate-300' : 'text-slate-600'}`}>
                          Live preview — uses real template engine, reflects every setting change
                        </p>
                        <p className={`text-[10px] mt-0.5 ${D ? 'text-slate-500' : 'text-slate-400'}`}>
                          This is pixel-identical to the PDF &amp; Google Drive output
                        </p>
                      </div>
                      <span className={`text-[10px] px-2.5 py-1 rounded-full font-medium flex-shrink-0
                        ${D ? 'bg-blue-900/40 text-blue-300' : 'bg-blue-50 text-blue-600'}`}>
                        Sample data · live render
                      </span>
                    </div>

                    {/* iframe — same engine as PDF / Drive */}
                    {settingsPreviewHtml ? (
                      <div className={`rounded-2xl border overflow-hidden shadow-xl
                        ${D ? 'border-slate-600' : 'border-slate-200'}`}
                        style={{ background: D ? '#1e293b' : '#e2e8f0', padding: 12 }}>
                        <div style={{
                          maxWidth: 794,
                          margin:   '0 auto',
                          boxShadow:'0 8px 32px rgba(0,0,0,0.18)',
                          borderRadius: 4,
                          overflow: 'hidden',
                          background: 'white',
                        }}>
                          <iframe
                            key={previewKey}
                            srcDoc={settingsPreviewHtml}
                            title="Settings Invoice Preview"
                            style={{ width: '100%', height: 1050, border: 'none', display: 'block' }}
                            sandbox="allow-scripts"
                          />
                        </div>
                      </div>
                    ) : (
                      <div className={`rounded-2xl border p-12 text-center
                        ${D ? 'bg-slate-800/50 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                        <p className="text-sm text-slate-400">Select a company and configure settings to see the live preview.</p>
                      </div>
                    )}

                    <p className={`text-center text-[10px] ${D ? 'text-slate-500' : 'text-slate-400'}`}>
                      Preview uses sample data. Actual invoices will show real client &amp; item details.
                    </p>
                  </div>
                )}

              </div>
              {/* ── END scrollable content ──────────────────────────────────── */}

              {/* ── FOOTER ──────────────────────────────────────────────────── */}
              <div className={`flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3 border-t ${D ? 'border-slate-700 bg-slate-800/60' : 'border-slate-200 bg-white'}`}>
                <p className="text-xs text-slate-400">
                  Configuring:&nbsp;
                  <span className={`font-semibold ${D ? 'text-slate-200' : 'text-slate-700'}`}>{selectedCompany?.name}</span>
                  {selectedCompany?.gstin && (
                    <span className="ml-1.5 font-mono text-slate-400 text-[10px]">{selectedCompany.gstin}</span>
                  )}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={onClose}
                    className={`h-8 px-4 text-xs rounded-xl ${D ? 'text-slate-400' : 'text-slate-500'}`}>
                    Close
                  </Button>
                  {canEditInvoiceSettings && <Button onClick={handleSave}
                    className={`h-8 px-5 text-xs rounded-xl font-semibold gap-1.5 transition-all ${saved ? 'bg-emerald-500 text-white' : 'text-white'}`}
                    style={saved ? {} : { background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                    {saved ? <><Check className="h-3.5 w-3.5" />Saved!</> : <><Save className="h-3.5 w-3.5" />Save Settings</>}
                  </Button>}
                </div>
              </div>

            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
