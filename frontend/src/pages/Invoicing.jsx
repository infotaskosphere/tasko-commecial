import Papa from 'papaparse/papaparse.js';
import { getJsPDF, getHtml2Canvas, getXLSX } from '@/lib/lazyLibs';
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import api from '@/lib/api';
import { lookupPincode, isInterState } from '@/lib/pincode';
import { fetchCompanies, normalizeCompanies, recordBelongsToCompany } from "@/lib/companies";
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { format, parseISO, differenceInDays, startOfMonth, endOfMonth, subMonths } from 'date-fns';
// XLSX is loaded on demand at each import/export entry point (not statically
// imported) so opening the Invoicing page doesn't force-download ~420KB
// of spreadsheet library that most visits never use.
let XLSX;
import {
  Plus, Edit, Trash2, FileText, Search, Download, X, ChevronRight,
  Check, Eye, Printer, Layout, Palette, LayoutGrid,
  CheckCircle2, Clock, AlertCircle, TrendingUp, DollarSign, BarChart3,
  Building2, Users, Receipt, CreditCard, RefreshCw, Send, Copy,
  Repeat, Package, Tag, ChevronDown, ChevronUp, Percent, Truck,
  ArrowUpRight, Activity, Zap, Shield, Star, Filter,
  IndianRupee, CalendarDays, FileCheck, ArrowRightLeft, Layers,
  Upload, Database, FileUp, CheckSquare, AlertTriangle, Phone, Mail,
  FileSpreadsheet, Briefcase, PieChart, Settings, Table, FileDown, BookOpen,
  ExternalLink, GripVertical, MessageCircle, Square, Share2} from 'lucide-react';
import InvoiceSettings, { getInvSettings } from './InvoiceSettings';
import { COLOR_THEMES, INVOICE_TEMPLATES, generateInvoiceHTML } from './InvoiceTemplates';
import PartyLedger from './PartyLedger';
import WhatsAppSendDialog from '@/components/ui/WhatsAppSendDialog';
import { buildInvoiceMessage, getWASettings } from '@/hooks/useWhatsApp';
import ReferralSummaryDialog from '@/components/ReferralSummaryDialog';

// ─── Brand Colors ─────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue: '#0D3B66',
  mediumBlue: '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  lightGreen: '#5CCB5F',
  coral: '#FF6B6B',
  amber: '#F59E0B',
  purple: '#7C3AED',
  teal: '#0D9488',
};

// ─── Constants ────────────────────────────────────────────────────────────────
const GST_RATES = [0, 5, 12, 18, 28];
const UNITS = ['service','nos','kg','ltr','mtr','sqft','hr','day','month','year','set','lot','pcs','box'];
const PAY_MODES = ['cash','cheque','neft','rtgs','imps','upi','card','other'];
const INV_TYPES = [
  { value: 'tax_invoice', label: 'Tax Invoice' },
  { value: 'proforma', label: 'Proforma Invoice' },
  { value: 'estimate', label: 'Estimate' },
  { value: 'credit_note', label: 'Credit Note' },
  { value: 'debit_note', label: 'Debit Note' },
];
const STATUS_META = {
  draft: { label: 'Invoiced', bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-600 dark:text-slate-300', dot: 'bg-slate-400', hex: '#94A3B8' },
  sent: { label: 'Sent', bg: 'bg-blue-50 dark:bg-blue-900/30', text: 'text-blue-600 dark:text-blue-400', dot: 'bg-blue-500', hex: COLORS.mediumBlue },
  partially_paid: { label: 'Partial', bg: 'bg-amber-50 dark:bg-amber-900/20', text: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-400', hex: COLORS.amber },
  paid: { label: 'Paid', bg: 'bg-emerald-50 dark:bg-emerald-900/20', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500', hex: COLORS.emeraldGreen },
  overdue: { label: 'Overdue', bg: 'bg-red-50 dark:bg-red-900/20', text: 'text-red-600 dark:text-red-400', dot: 'bg-red-500', hex: COLORS.coral },
  cancelled: { label: 'Cancelled', bg: 'bg-slate-100 dark:bg-slate-700', text: 'text-slate-500 dark:text-slate-400', dot: 'bg-slate-400', hex: '#94A3B8' },
  credit_note: { label: 'Credit Note', bg: 'bg-purple-50 dark:bg-purple-900/20', text: 'text-purple-600 dark:text-purple-400', dot: 'bg-purple-500', hex: COLORS.purple },
};

// ─── Pure Module-Level Helpers ────────────────────────────────────────────────
const fmt = (n) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n ?? 0);
const fmtC = (n) => `₹${fmt(n)}`;

// ── Robust money helpers ────────────────────────────────────────────────────
// Accounting engine rule: workflow status (Draft/Sent/Partial/Paid/etc) is
// UI only and must NEVER be branched on to decide money figures. Outstanding
// and Paid are driven only by Invoice Amount, Payments, Credit Notes, Debit
// Notes, and Cancellation — all of which the backend already folds into
// amount_paid / amount_due via recalculate_invoice_accounting() every time a
// payment, credit note, debit note, or edit happens. So the client trusts
// those two fields directly instead of re-deriving them from `status`.
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const calcPaid = (inv) => {
  if (!inv) return 0;
  // amount_paid is the canonical "received so far" field, maintained by the
  // accounting engine. Fall back to advance_received only for legacy rows
  // that predate that field being populated.
  if (inv.amount_paid !== undefined && inv.amount_paid !== null) return num(inv.amount_paid);
  return num(inv.advance_received);
};
const calcDue = (inv) => {
  if (!inv) return 0;
  // Cancelled invoices never carry Outstanding, regardless of amount_due.
  if (inv.status === 'cancelled') return 0;
  if (inv.amount_due !== undefined && inv.amount_due !== null) return round2(num(inv.amount_due));
  // Legacy fallback for rows the engine hasn't touched yet.
  const grand = num(inv.grand_total);
  return round2(Math.max(0, grand - calcPaid(inv)));
};
const isFullyPaid = (inv) => {
  if (!inv) return false;
  return num(inv.grand_total) > 0 && calcDue(inv) <= 0.009;
};
const isPartiallyPaid = (inv) => {
  if (!inv) return false;
  return calcPaid(inv) > 0.009 && calcDue(inv) > 0.009;
};

const getStatusMeta = (inv) => {
  if (inv.status && STATUS_META[inv.status]) return STATUS_META[inv.status];
  if (calcDue(inv) > 0 && inv.due_date && differenceInDays(parseISO(inv.due_date), new Date()) < 0)
    return STATUS_META.overdue;
  return STATUS_META.draft;
};
const emptyItem = () => ({
  description: '', hsn_sac: '', quantity: 1, unit: 'service',
  unit_price: 0, discount_pct: 0, gst_rate: 18,
  taxable_value: 0, cgst_rate: 9, sgst_rate: 9, igst_rate: 0,
  cgst_amount: 0, sgst_amount: 0, igst_amount: 0, total_amount: 0,
  item_details: '',
});

// Maps compliance category codes → invoice item description prefix
// Used when auto-populating invoice items from compliance govt fees
const COMPLIANCE_CATEGORY_LABELS = {
  ROC:     'ROC',
  GST:     'GST',
  ITR:     'IT',
  TDS:     'IT',
  AUDIT:   'Audit',
  PF_ESIC: 'PF/ESIC',
  PT:      'PT',
  OTHER:   'Other',
};

// Pure helper — no hooks, safe to call anywhere
const fyRange = (year) => {
  if (!year || year === 'all') return null;
  const y = parseInt(year);
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
};

// ─── Item Memory (localStorage + live invoices) ────────────────────────────────
const getItemMemory = () => {
  try { return JSON.parse(localStorage.getItem('inv_item_memory') || '{}'); }
  catch { return {}; }
};
const saveItemMemory = (items = []) => {
  try {
    const mem = getItemMemory();
    items.forEach(it => {
      const key = (it.description || '').trim().toLowerCase();
      if (key) mem[key] = { description: it.description, unit_price: it.unit_price, gst_rate: it.gst_rate, unit: it.unit, hsn_sac: it.hsn_sac };
    });
    localStorage.setItem('inv_item_memory', JSON.stringify(mem));
  } catch {}
};
// Build merged suggestion list from localStorage + live invoice items
const buildItemSuggestions = (liveInvoices = []) => {
  const mem = getItemMemory(); // from localStorage (saved on submit)
  // Also seed from live invoices so autocomplete works across sessions/devices
  (liveInvoices || []).forEach(inv => {
    (inv.items || []).forEach(it => {
      const key = (it.description || '').trim().toLowerCase();
      if (key && !mem[key]) {
        mem[key] = { description: it.description, unit_price: it.unit_price || 0, gst_rate: it.gst_rate || 18, unit: it.unit || 'service', hsn_sac: it.hsn_sac || '' };
      }
    });
  });
  return mem;
};
const computeItem = (item, isInter) => {
  const disc = item.unit_price * item.quantity * (item.discount_pct / 100);
  const taxable = Math.round((item.unit_price * item.quantity - disc) * 100) / 100;
  const g = item.gst_rate;
  if (isInter) {
    const igst = Math.round(taxable * g / 100 * 100) / 100;
    return { ...item, taxable_value: taxable, cgst_rate: 0, sgst_rate: 0, igst_rate: g,
      cgst_amount: 0, sgst_amount: 0, igst_amount: igst,
      total_amount: Math.round((taxable + igst) * 100) / 100 };
  } else {
    const half = g / 2;
    const cgst = Math.round(taxable * half / 100 * 100) / 100;
    const sgst = Math.round(taxable * half / 100 * 100) / 100;
    return { ...item, taxable_value: taxable, cgst_rate: half, sgst_rate: half, igst_rate: 0,
      cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0,
      total_amount: Math.round((taxable + cgst + sgst) * 100) / 100 };
  }
};
const computeTotals = (items, isInter, discAmt = 0, shipping = 0, other = 0) => {
  const comp = items.map(it => computeItem(it, isInter));
  const subtotal = comp.reduce((s, i) => s + i.unit_price * i.quantity, 0);
  const totDisc = comp.reduce((s, i) => s + i.unit_price * i.quantity * i.discount_pct / 100, 0) + discAmt;
  const totTax = comp.reduce((s, i) => s + i.taxable_value, 0);
  const totCGST = comp.reduce((s, i) => s + i.cgst_amount, 0);
  const totSGST = comp.reduce((s, i) => s + i.sgst_amount, 0);
  const totIGST = comp.reduce((s, i) => s + i.igst_amount, 0);
  const totGST = Math.round((totCGST + totSGST + totIGST) * 100) / 100;
  const grand = Math.round((totTax + totGST + shipping + other - discAmt) * 100) / 100;
  return {
    items: comp,
    subtotal: Math.round(subtotal * 100) / 100,
    total_discount: Math.round(totDisc * 100) / 100,
    total_taxable: Math.round(totTax * 100) / 100,
    total_cgst: Math.round(totCGST * 100) / 100,
    total_sgst: Math.round(totSGST * 100) / 100,
    total_igst: Math.round(totIGST * 100) / 100,
    total_gst: totGST,
    grand_total: grand,
  };
};
const AVATAR_GRADS = [
  ['#0D3B66','#1F6FB2'],['#065f46','#059669'],['#7c2d12','#ea580c'],
  ['#4c1d95','#7c3aed'],['#831843','#db2777'],['#134e4a','#0d9488'],
];
const avatarGrad = (name = '') => {
  const i = (name.charCodeAt(0) || 0) % AVATAR_GRADS.length;
  return `linear-gradient(135deg, ${AVATAR_GRADS[i][0]}, ${AVATAR_GRADS[i][1]})`;
};
// Returns a solid colour for the left stripe based on which company the invoice belongs to
const getCompanyStripColor = (companyId, companies = []) => {
  if (!companyId) return AVATAR_GRADS[0][0];
  const idx = companies.findIndex(c => c.id === companyId);
  const slot = idx >= 0 ? idx : (String(companyId).split('').reduce((s, c) => s + c.charCodeAt(0), 0));
  return AVATAR_GRADS[slot % AVATAR_GRADS.length][0];
};
// ─── Invoice age-based colour strip ─────────────────────────────────────────
// green = paid / fully-received
// orange = outstanding 15-30 days since invoice date
// red = outstanding > 30 days since invoice date OR past due date
const getInvoiceStripe = (inv) => {
  if (inv.status === 'paid' || calcDue(inv) <= 0) return { color: '#1FAF5A', label: 'Paid' };
  if (inv.status === 'cancelled') return { color: '#94A3B8', label: 'Cancelled' };
  const today = new Date();
  const invoiceDate = inv.invoice_date ? new Date(inv.invoice_date) : null;
  const dueDate = inv.due_date ? new Date(inv.due_date) : null;
  // If past due date → red
  if (dueDate && differenceInDays(today, dueDate) > 0) return { color: '#FF6B6B', label: 'Overdue' };
  // Days since invoice was created
  const daysSince = invoiceDate ? differenceInDays(today, invoiceDate) : 0;
  if (daysSince > 30) return { color: '#FF6B6B', label: '>30 days' };
  if (daysSince > 15) return { color: '#F59E0B', label: '>15 days' };
  return { color: '#1F6FB2', label: 'Recent' };
};

const Hl = ({ text = '', query = '' }) => {
  if (!query.trim()) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-yellow-200 text-yellow-900 rounded px-0.5 not-italic font-bold">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
};

// ─── DriveUploadBtn component ─────────────────────────────────────────
// Fixed to produce 100% identical PDF to browser Print
//
// ROOT CAUSE OF DIFFERENCE:
// The old code used html2canvas (screenshot-based) which renders differently from
// browser's native PDF renderer used in window.print().
//
// FIX:
// Instead of html2canvas, we send the raw HTML to the backend and let the
// backend use a headless browser (Puppeteer/Playwright) to render it — producing
// a pixel-perfect PDF identical to browser print.
//
// FALLBACK:
// If the backend doesn't support /upload-html-to-drive, we fall back to
// the improved html2canvas approach with settings that better match print output.
const DriveUploadBtn = ({ invoiceId, invoiceNo, invoice, companies }) => {
  const [loading, setLoading] = useState(false);
  const [waInvoice, setWaInvoice] = useState(null);
  const [waDialogOpen, setWaDialogOpen] = useState(false);

  const handleDriveUpload = async () => {
    setLoading(true);
    try {
      // 1. Fetch full invoice data if items are missing
      const invData = (invoice.items?.length || 0) > 0
        ? invoice
        : (await api.get(`/invoices/${invoiceId}`)).data;

      // 2. Resolve company + settings (identical to handleDownloadPdf)
      const baseCompany = (companies || []).find(c => c.id === invData.company_id) || {};
      const invSettings = getInvSettings(invData.company_id);
      const company = {
        ...baseCompany,
        bank_name:        baseCompany.bank_name        || invSettings.bank_name        || '',
        bank_account_no:  baseCompany.bank_account_no  || invSettings.bank_account_no  || '',
        bank_account:     baseCompany.bank_account     || invSettings.bank_account_no  || '',
        bank_ifsc:        baseCompany.bank_ifsc        || invSettings.bank_ifsc        || '',
        bank_branch:      baseCompany.bank_branch      || invSettings.bank_branch      || '',
        upi_id:           baseCompany.upi_id           || invSettings.upi_id           || '',
        show_qr_code:     invSettings.show_qr_code     ?? true,
        invoice_title:    invSettings.invoice_title    || 'Tax Invoice',
        signatory_name:   invSettings.signatory_name   || '',
        signatory_label:  invSettings.signatory_label  || 'Authorised Signatory',
        footer_line:      invSettings.footer_line      || '',
        signature_image:  baseCompany.signature_image  || baseCompany.signature_base64  || baseCompany.signature_url  || invSettings.signature_image || '',
        signature_base64: baseCompany.signature_base64 || baseCompany.signature_image   || '',
        logo_url:         baseCompany.logo_url         || baseCompany.logo              || '',
        logo_base64:      baseCompany.logo_base64      || '',
      };

      // 3. Generate the EXACT same HTML used by handleDownloadPdf / Print
      const html = generateInvoiceHTML(invData, {
        company,
        template:    invData.invoice_template     || invSettings.template     || 'classic',
        theme:       invData.invoice_theme        || invSettings.theme        || 'classic_blue',
        customColor: invData.invoice_custom_color || invSettings.custom_color || '#0D3B66',
      });

      const clientSlug = (invData.client_name || '').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
      const invoiceSlug = (invoiceNo || '').replace(/[/\s]/g, '_');
      const filename = clientSlug ? `${clientSlug}_${invoiceSlug}.pdf` : `Invoice_${invoiceSlug}.pdf`;

      // 4. PRIMARY: Try backend HTML-to-PDF endpoint (uses headless browser = identical to print)
      //    This is the PREFERRED path — produces 100% identical output to browser print
      try {
        const htmlResponse = await api.post(`/invoices/${invoiceId}/upload-html-to-drive`, {
          html_content: html,
          filename,
        });

        if (htmlResponse.data?.drive_link) {
          toast.success('Saved to Google Drive ✅ (identical to Print PDF)');
          if (window.confirm('Open in Google Drive?')) {
            window.open(htmlResponse.data.drive_link, '_blank');
          }
          return;
        }
      } catch (htmlErr) {
        // Backend doesn't support HTML endpoint — fall through to canvas method
        console.warn('HTML-to-PDF endpoint not available, using canvas fallback:', htmlErr.message);
      }

      // 5. FALLBACK: Use html2canvas with improved settings to minimize difference from print
      //    Key improvements over old code:
      //    - scale:3 (instead of 2) for sharper text closer to print quality
      //    - useCORS:true for external images (QR codes, logos)
      //    - Proper A4 page slicing
      const jsPDF = await getJsPDF();
      const pdf = new jsPDF('p', 'mm', 'a4');

      const blob    = new Blob([html], { type: 'text/html;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);

      await new Promise((resolve, reject) => {
        const iframe = document.createElement('iframe');
        iframe.style.cssText = [
          'position:fixed',
          'top:-9999px',
          'left:-9999px',
          'width:794px',   // A4 at 96dpi
          'height:1123px', // A4 height at 96dpi
          'border:none',
          'visibility:hidden',
        ].join(';');

        document.body.appendChild(iframe);

        iframe.onload = async () => {
          try {
            const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

            // Force A4 width layout identical to @page CSS
            iframeDoc.body.style.width  = '794px';
            iframeDoc.body.style.margin = '0';
            iframeDoc.body.style.padding = '0';
            iframeDoc.documentElement.style.width = '794px';

            // Wait for ALL images to load (logo, signature, QR code from external URL)
            const imgs = Array.from(iframeDoc.querySelectorAll('img'));
            await Promise.all(
              imgs.map(img =>
                img.complete
                  ? Promise.resolve()
                  : new Promise(res => {
                      img.onload  = res;
                      img.onerror = res;
                      setTimeout(res, 5000); // 5s max per image
                    })
              )
            );

            // Extra settle for QR API and web fonts
            await new Promise(r => setTimeout(r, 1000));

            const fullHeight = Math.max(
              iframeDoc.body.scrollHeight,
              iframeDoc.documentElement.scrollHeight,
              1123
            );

            // Use scale:3 for higher fidelity (closer to print 300dpi)
            const html2canvas = await getHtml2Canvas();
            const canvas = await html2canvas(iframeDoc.body, {
              scale:           3,
              useCORS:         true,
              allowTaint:      false,
              logging:         false,
              width:           794,
              height:          fullHeight,
              windowWidth:     794,
              windowHeight:    fullHeight,
              scrollX:         0,
              scrollY:         0,
              backgroundColor: '#ffffff',
              imageTimeout:    8000,
              removeContainer: false,
              // These options help match print rendering more closely:
              letterRendering: true,
              foreignObjectRendering: false,
            });

            // A4 dimensions
            const A4_W = 210;
            const A4_H = 297;

            // Use PNG instead of JPEG to avoid compression artifacts
            const imgData     = canvas.toDataURL('image/png');
            const imgHeightMM = (canvas.height * A4_W) / canvas.width;

            let pageCount = Math.ceil(imgHeightMM / A4_H);
            if (pageCount < 1) pageCount = 1;

            for (let page = 0; page < pageCount; page++) {
              if (page > 0) pdf.addPage();
              const yOffset = -(page * A4_H);
              pdf.addImage(imgData, 'PNG', 0, yOffset, A4_W, imgHeightMM);
            }

            document.body.removeChild(iframe);
            URL.revokeObjectURL(blobUrl);
            resolve();
          } catch (err) {
            if (document.body.contains(iframe)) document.body.removeChild(iframe);
            URL.revokeObjectURL(blobUrl);
            reject(err);
          }
        };

        iframe.onerror = () => {
          if (document.body.contains(iframe)) document.body.removeChild(iframe);
          URL.revokeObjectURL(blobUrl);
          reject(new Error('iframe load failed'));
        };

        iframe.src = blobUrl;
      });

      // 6. Upload base64 PDF to backend
      const base64 = pdf.output('datauristring').split(',')[1];

      const response = await api.post(`/invoices/${invoiceId}/upload-pdf-to-drive`, {
        pdf_base64: base64,
        filename,
      });

      if (response.data?.drive_link) {
        toast.success('Saved to Google Drive ✅');
        if (window.confirm('Open in Google Drive?')) {
          window.open(response.data.drive_link, '_blank');
        }
      } else {
        toast.warning(response.data?.message || 'Upload failed');
      }

    } catch (err) {
      console.error('Drive upload error:', err);
      toast.error(`Drive upload failed: ${err.response?.data?.detail || err.message || 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDriveUpload}
      disabled={loading}
      className="rounded-xl text-xs h-9 gap-1.5 border-blue-200 text-blue-600 hover:bg-blue-50"
      title="Save invoice to Google Drive (identical to Print PDF)"
    >
      {loading ? (
        <span className="flex items-center gap-1">
          <span className="w-3.5 h-3.5 border border-blue-500 border-t-transparent rounded-full animate-spin" />
          Uploading…
        </span>
      ) : (
        'Save to Drive'
      )}
    </Button>
  );
};

function parseExcelInvoices(file) {
  return new Promise(async (resolve, reject) => {
    XLSX = await getXLSX();
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb      = XLSX.read(e.target.result, { type: 'array' });
        const ws      = wb.Sheets[wb.SheetNames[0]];
        const rows    = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
 
        // Find header row (first row containing "Invoice No" or "invoice no")
        let headerIdx = rows.findIndex(r =>
          String(r[0] || '').toLowerCase().includes('invoice') ||
          String(r[1] || '').toLowerCase().includes('invoice')
        );
        if (headerIdx === -1) headerIdx = 0;
 
        const headers   = (rows[headerIdx] || []).map(h => String(h).trim().toLowerCase());
        const dataRows  = rows.slice(headerIdx + 1).filter(r => r.some(cell => cell !== ''));
 
        const col = (name) => {
          const idx = headers.findIndex(h => h.includes(name));
          return idx;
        };
 
        const invoices = dataRows.map((row, i) => {
          const get = (name, fallback = '') => {
            const idx = col(name);
            return idx >= 0 ? String(row[idx] || '').trim() : fallback;
          };
          const getNum = (name, fallback = 0) => {
            const idx = col(name);
            return idx >= 0 ? (parseFloat(row[idx]) || fallback) : fallback;
          };
 
          const rawDate   = get('date');
          const invoiceNo = get('invoice no') || get('invoice #') || `IMP-${String(i + 1).padStart(4, '0')}`;
          const clientName= get('customer') || get('client') || get('party') || 'Unknown';
          const gstin     = get('gstin') || get('gst');
          const phone     = get('phone') || get('mobile');
          const total     = getNum('total') || getNum('amount') || getNum('grand');
          const paid      = getNum('paid') || getNum('received');
          const balance   = getNum('balance') || getNum('due') || Math.max(total - paid, 0);
          const notes     = get('notes') || get('description') || get('remarks');
          const terms     = get('payment terms') || get('terms');
 
          // Normalise date  DD/MM/YYYY → YYYY-MM-DD
          let invDate = format(new Date(), 'yyyy-MM-dd');
          if (rawDate) {
            const parts = rawDate.split(/[\/\-\.]/);
            if (parts.length === 3) {
              const y = parts[2].length === 2 ? '20' + parts[2] : parts[2];
              const m = parts[1].padStart(2, '0');
              const d = parts[0].padStart(2, '0');
              const parsed = new Date(`${y}-${m}-${d}`);
              if (!isNaN(parsed)) invDate = format(parsed, 'yyyy-MM-dd');
            }
          }
 
          const dueDate = format(
            new Date(new Date(invDate).getTime() + 30 * 86400000),
            'yyyy-MM-dd'
          );
 
          // Derive status
          let status = 'draft';
          if (balance <= 0 && total > 0)            status = 'paid';
          else if (paid > 0 && balance > 0)          status = 'partially_paid';
          else if (balance > 0)                      status = 'sent';
 
          // Back-calculate taxable assuming 18% GST
          const gstRate  = 18;
          const taxable  = Math.round(total / 1.18 * 100) / 100;
          const gstAmt   = Math.round((total - taxable) * 100) / 100;
          const cgst     = Math.round(gstAmt / 2 * 100) / 100;
 
          return {
            invoice_type:    'tax_invoice',
            invoice_no:      invoiceNo,
            client_name:     clientName,
            client_email:    get('email') || '',
            client_phone:    phone,
            client_gstin:    gstin,
            client_address:  get('address') || '',
            client_state:    get('state') || '',
            invoice_date:    invDate,
            due_date:        dueDate,
            reference_no:    get('ref') || get('po') || '',
            notes:           notes,
            payment_terms:   terms || 'Due on receipt',
            is_interstate:   false,
            items: [{
              description:    notes || `Import – ${invoiceNo}`,
              hsn_sac:        '',
              quantity:       1,
              unit:           'service',
              unit_price:     taxable,
              discount_pct:   0,
              gst_rate:       gstRate,
              taxable_value:  taxable,
              cgst_rate:      9,
              sgst_rate:      9,
              igst_rate:      0,
              cgst_amount:    cgst,
              sgst_amount:    cgst,
              igst_amount:    0,
              total_amount:   total,
            }],
            subtotal:        taxable,
            total_taxable:   taxable,
            total_cgst:      cgst,
            total_sgst:      cgst,
            total_igst:      0,
            total_gst:       gstAmt,
            grand_total:     total,
            amount_paid:     paid,
            amount_due:      balance,
            status,
            discount_amount:  0,
            shipping_charges: 0,
            other_charges:    0,
          };
        }).filter(inv => (inv.grand_total || 0) > 0);
 
        resolve(invoices);
      } catch (err) {
        reject(new Error(`Failed to parse Excel: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
//  Module-level: used by Invoicing header AND ImportModal 
// ════════════════════════════════════════════════════════════════════════════════
const downloadInvoiceTemplate = () => {
  const headers = [
    "Invoice No","Date","Customer Name","GSTIN","Phone",
    "Item Description","HSN/SAC","Quantity","Unit",
    "Unit Price","Discount %","GST %",
    "Shipping","Other Charges",
    "Total Amount","Paid Amount","Balance",
    "Payment Terms","Notes"
  ];
  const sampleRows = [
    ["INV-001","01/04/2026","ABC Pvt Ltd","24ABCDE1234F1Z5","9876543210",
     "Consulting Service","9983","1","service","10000","0","18",
     "0","0","11800","5000","6800","Due in 30 days","First invoice"]
  ];
  const csvContent = [
    headers.join(","),
    ...sampleRows.map(r => r.join(","))
  ].join("\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "invoice_template.csv";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};


// ════════════════════════════════════════════════════════════════════════════════
// CLIENT SEARCH COMBOBOX
// ════════════════════════════════════════════════════════════════════════════════
const ClientSearchCombobox = ({ clients = [], value, onSelect, onAddNew, isDark }) => {
  // ── useState ──
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(-1);

  // ── useRef ──
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // ── useMemo ──
  const selected = useMemo(() => clients.find(c => c.id === value) || null, [clients, value]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return clients; // show all clients when no query
    return clients.filter(c =>
      (c.company_name || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q) ||
      (c.gstin || c.client_gstin || '').toLowerCase().includes(q)
    ); // no artificial cap — show all matches
  }, [clients, query]);

  // ── useEffect ──
  useEffect(() => {
    const h = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false); setQuery(''); setFocused(-1);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (focused >= 0 && listRef.current) {
      listRef.current.querySelector(`[data-idx="${focused}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [focused]);

  // ── Handlers ──
  const openDrop = () => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 20); };
  const pick = (client) => { onSelect(client); setOpen(false); setQuery(''); setFocused(-1); };
  const clear = (e) => { e.stopPropagation(); onSelect(null); };
  const onKeyDown = (e) => {
    if (!open) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrop(); } return; }
    const total = filtered.length + 1;
    if (e.key === 'ArrowDown') { e.preventDefault(); setFocused(f => Math.min(f + 1, total - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setFocused(f => Math.max(f - 1, -1)); }
    if (e.key === 'Escape') { setOpen(false); setQuery(''); setFocused(-1); }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (focused === filtered.length) { setOpen(false); onAddNew?.(); return; }
      if (focused >= 0 && filtered[focused]) pick(filtered[focused]);
    }
  };

  const inputCls = `w-full flex items-center gap-2.5 h-11 px-3 rounded-xl border text-sm transition-all outline-none
    ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}
    ${open ? 'border-blue-400 ring-2 ring-blue-100 shadow-sm' : 'hover:border-blue-300'}`;

  return (
    <div ref={wrapRef} className="relative" onKeyDown={onKeyDown}>
      <button type="button" onClick={open ? () => { setOpen(false); setQuery(''); } : openDrop}
        className={inputCls} aria-haspopup="listbox" aria-expanded={open}>
        {selected ? (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
              style={{ background: avatarGrad(selected.company_name) }}>
              {selected.company_name?.charAt(0).toUpperCase() || '?'}
            </div>
            <div className="flex-1 min-w-0 text-left">
              <p className={`text-sm font-semibold truncate leading-tight ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                {selected.company_name}
              </p>
              <p className={`text-[10px] truncate leading-tight ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>
                {selected.phone || selected.email || 'No contact info'}
              </p>
            </div>
          </div>
        ) : (
          <span className={`flex-1 text-left text-sm ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>
            — Search or select client —
          </span>
        )}
        <div className="flex items-center gap-1 flex-shrink-0">
          {selected && (
            <span onClick={clear} role="button" tabIndex={-1}
              className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-red-100 hover:text-red-500 text-slate-300 transition-colors">
              <X className="h-3 w-3" />
            </span>
          )}
          <ChevronDown className={`h-4 w-4 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {open && (
        <div className={`absolute z-50 w-full mt-1.5 rounded-2xl border shadow-2xl overflow-hidden flex flex-col ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
          style={{ maxHeight: 340 }}>
          <div className={`flex items-center gap-2 px-3 py-2.5 border-b flex-shrink-0 ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100'}`}>
            <Search className="h-4 w-4 text-slate-400 flex-shrink-0" />
            <input ref={inputRef} value={query} onChange={e => { setQuery(e.target.value); setFocused(-1); }}
              placeholder="Type name, GSTIN, phone or email…"
              className={`flex-1 text-sm outline-none placeholder:text-slate-400 bg-transparent ${isDark ? 'text-slate-100' : 'text-slate-800'}`}
              autoComplete="off" />
            {query && (
              <button type="button" onClick={() => { setQuery(''); setFocused(-1); inputRef.current?.focus(); }}
                className="text-slate-300 hover:text-slate-500">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div ref={listRef} className="overflow-y-auto flex-1">
            {filtered.length === 0 && query ? (
              <div className="flex flex-col items-center justify-center py-8 text-slate-400">
                <Search className="h-5 w-5 mb-2 opacity-30" />
                <p className="text-xs font-medium">No matches for "{query}"</p>
              </div>
            ) : filtered.map((c, i) => {
              const isActive = i === focused;
              const isSelected = c.id === value;
              return (
                <div key={c.id} data-idx={i} role="option" aria-selected={isSelected}
                  onClick={() => pick(c)} onMouseEnter={() => setFocused(i)}
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer border-b last:border-0 transition-colors
                    ${isDark ? 'border-slate-700' : 'border-slate-50'}
                    ${isActive ? (isDark ? 'bg-blue-900/30' : 'bg-blue-50') : (isDark ? 'hover:bg-slate-700/40' : 'hover:bg-slate-50')}
                    ${isSelected ? (isDark ? 'bg-blue-900/20' : 'bg-blue-50/60') : ''}`}>
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0 shadow-sm"
                    style={{ background: avatarGrad(c.company_name) }}>
                    {c.company_name?.charAt(0).toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                        <Hl text={c.company_name || ''} query={query} />
                      </p>
                      {isSelected && (
                        <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full border border-emerald-200 flex-shrink-0">
                          ✓ Selected
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {c.phone && (
                        <span className="flex items-center gap-1 text-[10px] text-slate-400">
                          <Phone className="h-2.5 w-2.5" /><Hl text={c.phone} query={query} />
                        </span>
                      )}
                      {c.email && (
                        <span className="flex items-center gap-1 text-[10px] text-slate-400 max-w-[180px] truncate">
                          <Mail className="h-2.5 w-2.5 flex-shrink-0" /><Hl text={c.email} query={query} />
                        </span>
                      )}
                      {c.client_gstin && (
                        <span className="text-[10px] text-slate-400 font-mono">
                          <Hl text={c.client_gstin} query={query} />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className={`flex-shrink-0 border-t ${isDark ? 'border-slate-700 bg-slate-800/80' : 'border-slate-100 bg-slate-50/60'}`}>
            <button type="button" data-idx={filtered.length}
              onMouseEnter={() => setFocused(filtered.length)}
              onClick={() => { setOpen(false); onAddNew?.(); }}
              className={`w-full flex items-center gap-3 px-4 py-3 transition-colors text-left
                ${focused === filtered.length ? (isDark ? 'bg-blue-900/30' : 'bg-blue-50') : (isDark ? 'hover:bg-slate-700/40' : 'hover:bg-blue-50/60')}`}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm"
                style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                <Plus className="h-4 w-4 text-white" />
              </div>
              <div>
                <p className="text-sm font-semibold text-blue-700 dark:text-blue-400">Add New Client</p>
                <p className="text-[10px] text-slate-400">Quick-add client without leaving this invoice</p>
              </div>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// GST REPORTS MODAL
// ════════════════════════════════════════════════════════════════════════════════
const GSTReportsModal = ({ open, onClose, invoices = [], companies = [], clients = [], isDark }) => {
  const [tab, setTab] = useState('gstr1');
  const [month, setMonth] = useState(format(new Date(), 'yyyy-MM'));
  const [companyFilter, setCompanyFilter] = useState('all');
  const [exporting, setExporting] = useState(null);

  // ── Base filtered data ──────────────────────────────────────────────────
  const baseInvoices = useMemo(() => {
    return (invoices || []).filter(inv => {
      if (!recordBelongsToCompany(inv, companyFilter, companies)) return false;
      if (!inv.invoice_date?.startsWith(month)) return false;
      if (!['tax_invoice', 'credit_note', 'debit_note'].includes(inv.invoice_type)) return false;
      if (inv.status === 'cancelled') return false;
      return true;
    });
  }, [invoices, month, companyFilter, companies]);

  // ── GSTR-1 data ─────────────────────────────────────────────────────────
  const gstr1 = useMemo(() => {
    const b2b = [], b2cL = [], b2cS = [], cdnr = [];
    const hsnMap = {};

    // Build a fallback map: client_id → gstin, for invoices where client_gstin was not saved
    const clientGstinMap = {};
    for (const c of clients) {
      const gstin = (c.client_gstin || c.gstin || '').trim();
      if (c.id && gstin) clientGstinMap[c.id] = gstin;
    }

    for (const inv of baseInvoices) {
      // Use gstin directly on invoice; fall back to clients list if blank
      const gstin = inv.client_gstin?.trim() || (inv.client_id ? clientGstinMap[inv.client_id] : '') || '';
      const hasGstin = !!gstin;
      const isCDN = ['credit_note', 'debit_note'].includes(inv.invoice_type);
      const total = inv.grand_total || 0;

      if (isCDN && hasGstin) cdnr.push({ ...inv, client_gstin: gstin });
      else if (hasGstin) b2b.push({ ...inv, client_gstin: gstin });
      else if (total > 250000) b2cL.push(inv);
      else b2cS.push(inv);

      for (const item of (inv.items || [])) {
        // ✅ FIX 2: 'UNKNOWN' → '—'
        const key = item.hsn_sac?.trim() || '—';
        if (!hsnMap[key]) hsnMap[key] = {
          hsn_sac: key, description: item.description || '',
          quantity: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0,
        };
        hsnMap[key].quantity  += item.quantity || 0;
        hsnMap[key].taxable   += item.taxable_value || 0;
        hsnMap[key].igst      += item.igst_amount || 0;
        hsnMap[key].cgst      += item.cgst_amount || 0;
        hsnMap[key].sgst      += item.sgst_amount || 0;
      }
    }

    const b2cSTotal = b2cS.reduce((a, inv) => ({
      taxable: a.taxable + (inv.total_taxable || 0),
      igst:    a.igst    + (inv.total_igst    || 0),
      cgst:    a.cgst    + (inv.total_cgst    || 0),
      sgst:    a.sgst    + (inv.total_sgst    || 0),
    }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });

    return { b2b, b2cL, b2cS, b2cSTotal, cdnr, hsnSummary: Object.values(hsnMap) };
  }, [baseInvoices]);

  // ── GSTR-3B data ────────────────────────────────────────────────────────
  const gstr3b = useMemo(() => {
    const outward = baseInvoices
      .filter(i => i.invoice_type === 'tax_invoice')
      .reduce((a, inv) => ({
        taxable: a.taxable + (inv.total_taxable || 0),
        igst:    a.igst    + (inv.total_igst    || 0),
        cgst:    a.cgst    + (inv.total_cgst    || 0),
        sgst:    a.sgst    + (inv.total_sgst    || 0),
      }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });

    const credits = baseInvoices
      .filter(i => i.invoice_type === 'credit_note')
      .reduce((a, inv) => ({
        taxable: a.taxable + (inv.total_taxable || 0),
        igst:    a.igst    + (inv.total_igst    || 0),
        cgst:    a.cgst    + (inv.total_cgst    || 0),
        sgst:    a.sgst    + (inv.total_sgst    || 0),
      }), { taxable: 0, igst: 0, cgst: 0, sgst: 0 });

    const netIGST = outward.igst - credits.igst;
    const netCGST = outward.cgst - credits.cgst;
    const netSGST = outward.sgst - credits.sgst;

    return {
      outward, credits, netIGST, netCGST, netSGST,
      netTotal: netIGST + netCGST + netSGST,
    };
  }, [baseInvoices]);

  // ── Indian state-code map (POS code) ───────────────────────────────────
  const STATE_CODE = {
    'jammu and kashmir':'01','himachal pradesh':'02','punjab':'03','chandigarh':'04','uttarakhand':'05',
    'haryana':'06','delhi':'07','rajasthan':'08','uttar pradesh':'09','bihar':'10','sikkim':'11',
    'arunachal pradesh':'12','nagaland':'13','manipur':'14','mizoram':'15','tripura':'16','meghalaya':'17',
    'assam':'18','west bengal':'19','jharkhand':'20','odisha':'21','orissa':'21','chhattisgarh':'22',
    'madhya pradesh':'23','gujarat':'24','daman and diu':'25','dadra and nagar haveli':'26',
    'dadra and nagar haveli and daman and diu':'26','maharashtra':'27','karnataka':'29','goa':'30',
    'lakshadweep':'31','kerala':'32','tamil nadu':'33','puducherry':'34','andaman and nicobar islands':'35',
    'telangana':'36','andhra pradesh':'37','ladakh':'38','other territory':'97',
  };
  const stateCode = (s) => {
    if (!s) return '';
    const k = String(s).trim().toLowerCase();
    if (STATE_CODE[k]) return STATE_CODE[k];
    // also accept "24-Gujarat" / "24" inputs
    const m = k.match(/^(\d{2})/);
    return m ? m[1] : '';
  };
  const posLabel = (s) => {
    const code = stateCode(s);
    const name = (s||'').replace(/^\d+[-\s]*/, '').trim();
    return code ? `${code}-${name || Object.keys(STATE_CODE).find(k=>STATE_CODE[k]===code) || ''}`.trim() : (name || '');
  };
  const fmtDDMMYYYY = (d) => {
    if (!d) return '';
    // accept yyyy-mm-dd or dd/mm/yyyy or dd-mm-yyyy
    const m1 = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
    const m2 = String(d).match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
    if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;
    return String(d);
  };
  const fmtMon = (d) => { // 01-Feb-2026
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return d;
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dt.getMonth()];
    return `${String(dt.getDate()).padStart(2,'0')}-${mon}-${dt.getFullYear()}`;
  };

  // Build per-rate item rows for a single invoice (groups items by gst_rate)
  const itemsByRate = (inv) => {
    const map = {};
    for (const it of (inv.items || [])) {
      const rate = Number(it.gst_rate || 0);
      if (!map[rate]) map[rate] = { rate, taxable:0, cgst:0, sgst:0, igst:0, cess:0 };
      map[rate].taxable += Number(it.taxable_value || 0);
      map[rate].cgst    += Number(it.cgst_amount  || 0);
      map[rate].sgst    += Number(it.sgst_amount  || 0);
      map[rate].igst    += Number(it.igst_amount  || 0);
      map[rate].cess    += Number(it.cess_amount  || 0);
    }
    if (Object.keys(map).length === 0) {
      // fallback to invoice totals at gst_rate
      const rate = Number(inv.gst_rate || 18);
      map[rate] = {
        rate,
        taxable: Number(inv.total_taxable || 0),
        cgst: Number(inv.total_cgst || 0),
        sgst: Number(inv.total_sgst || 0),
        igst: Number(inv.total_igst || 0),
        cess: 0,
      };
    }
    return Object.values(map);
  };

  // ── Export helpers ──────────────────────────────────────────────────────
  const handleExport = async (exportFormat = 'excel') => {
    setExporting(exportFormat);
    try {
      if (exportFormat !== 'json') XLSX = await getXLSX();
      const co = companies.find(c => c.id === companyFilter);
      const companyName = companyFilter === 'all' ? 'All' : (co?.name || companyFilter);
      const supplierGSTIN = (co?.gstin || co?.gst_number || '24AALCP5501B1ZW').toUpperCase();
      const supplierState = co?.state || 'Gujarat';
      const supplierStateCode = stateCode(supplierState);
      const periodLabel = (() => {
        const [y,m] = month.split('-');
        const mn = ['January','February','March','April','May','June','July','August','September','October','November','December'][parseInt(m,10)-1];
        return `${mn} ${y} - ${mn} ${y}`;
      })();
      const fp = (() => { const [y,m] = month.split('-'); return `${m}${y}`; })(); // GSTN fp = MMYYYY

      // ─────────── JSON (GSTN schema) for GSTR-1 ────────────
      if (exportFormat === 'json') {
        // group b2b by ctin
        const b2bMap = {};
        for (const inv of gstr1.b2b) {
          const ctin = (inv.client_gstin||'').toUpperCase();
          if (!b2bMap[ctin]) b2bMap[ctin] = [];
          const pos = stateCode(inv.client_state) || stateCode(inv.client_address) || supplierStateCode;
          const rates = itemsByRate(inv);
          b2bMap[ctin].push({
            inum: inv.invoice_no,
            idt:  fmtDDMMYYYY(inv.invoice_date),
            val:  Number((inv.grand_total||0).toFixed(2)),
            pos,
            rchrg: 'N',
            inv_typ: 'R',
            itms: rates.map((r,i)=>({
              num: i+1,
              itm_det: {
                txval: Number(r.taxable.toFixed(2)),
                rt:    r.rate,
                camt:  Number(r.cgst.toFixed(2)),
                samt:  Number(r.sgst.toFixed(2)),
                iamt:  Number(r.igst.toFixed(2)),
                csamt: Number(r.cess.toFixed(2)),
              }
            })),
          });
        }
        const b2b = Object.entries(b2bMap).map(([ctin, inv]) => ({ ctin, inv }));

        // b2cl: invoice value > 2.5L AND interstate (no gstin)
        const b2cl = {};
        for (const inv of gstr1.b2cL) {
          const pos = stateCode(inv.client_state) || stateCode(inv.client_address) || supplierStateCode;
          if (!b2cl[pos]) b2cl[pos] = { pos, inv: [] };
          const rates = itemsByRate(inv);
          b2cl[pos].inv.push({
            inum: inv.invoice_no,
            idt:  fmtDDMMYYYY(inv.invoice_date),
            val:  Number((inv.grand_total||0).toFixed(2)),
            itms: rates.map((r,i)=>({
              num: i+1,
              itm_det: { txval: Number(r.taxable.toFixed(2)), rt: r.rate, iamt: Number(r.igst.toFixed(2)), csamt: Number(r.cess.toFixed(2)) }
            })),
          });
        }

        // b2cs: aggregated by rate + POS + supply type
        const b2csMap = {};
        for (const inv of gstr1.b2cS) {
          const pos = stateCode(inv.client_state) || stateCode(inv.client_address) || supplierStateCode;
          const sply = pos === supplierStateCode ? 'INTRA' : 'INTER';
          for (const r of itemsByRate(inv)) {
            const key = `${pos}|${r.rate}|${sply}`;
            if (!b2csMap[key]) b2csMap[key] = { sply_ty: sply, pos, typ: 'OE', rt: r.rate, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
            b2csMap[key].txval += r.taxable;
            b2csMap[key].iamt  += r.igst;
            b2csMap[key].camt  += r.cgst;
            b2csMap[key].samt  += r.sgst;
            b2csMap[key].csamt += r.cess;
          }
        }
        const b2cs = Object.values(b2csMap).map(x => ({
          ...x,
          txval: Number(x.txval.toFixed(2)),
          iamt:  Number(x.iamt.toFixed(2)),
          camt:  Number(x.camt.toFixed(2)),
          samt:  Number(x.samt.toFixed(2)),
          csamt: Number(x.csamt.toFixed(2)),
        }));

        // hsn data
        const hsnData = [];
        let hsnNum = 1;
        for (const h of gstr1.hsnSummary) {
          hsnData.push({
            num: hsnNum++,
            hsn_sc: h.hsn_sac && h.hsn_sac !== '—' ? h.hsn_sac : '',
            desc: h.description || '',
            uqc: 'NA',
            qty: Number(h.quantity || 0),
            txval: Number((h.taxable||0).toFixed(2)),
            iamt: Number((h.igst||0).toFixed(2)),
            camt: Number((h.cgst||0).toFixed(2)),
            samt: Number((h.sgst||0).toFixed(2)),
            csamt: 0,
          });
        }

        // doc_issue (13)
        const docs = baseInvoices
          .filter(i => i.invoice_type === 'tax_invoice')
          .map(i => i.invoice_no)
          .sort();
        const doc_issue = {
          doc_det: docs.length ? [{
            doc_num: 1,
            doc_typ: 'Invoices for outward supply',
            docs: [{ num: 1, from: docs[0], to: docs[docs.length-1], totnum: docs.length, cancel: 0, net_issue: docs.length }]
          }] : []
        };

        const json = {
          gstin: supplierGSTIN,
          fp,
          version: 'GST3.2.2',
          hash: 'hash',
          ...(b2b.length    ? { b2b }    : {}),
          ...(b2cl.length   ? { b2cl: Object.values(b2cl) } : {}),
          ...(b2cs.length   ? { b2cs }   : {}),
          ...(hsnData.length? { hsn: { data: hsnData } } : {}),
          ...(docs.length   ? { doc_issue } : {}),
        };

        const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `GSTR1_Report_${fp.slice(0,2)}_${fp.slice(2)}.json`;
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
        toast.success('GSTR-1 JSON (GSTN schema) exported!');
        return;
      }

      // ─────────── SALE REPORT (matches SaleReport sample) ───────────
      if (exportFormat === 'sale') {
        const rows = [
          [`Generated on ${format(new Date(),'MMMM d, yyyy')} at ${format(new Date(),'h:mm a').toLowerCase()}`],
          [],
          ['Date','Invoice No','Party Name','GSTIN','Transaction Type','Total Amount','Payment Type','Received/Paid Amount','Balance Due'],
        ];
        for (const inv of baseInvoices) {
          const paid = Number(inv.amount_paid || inv.advance_received || 0);
          const total = Number(inv.grand_total || 0);
          const bal = Math.max(0, total - paid);
          rows.push([
            fmtDDMMYYYY(inv.invoice_date).replace(/-/g,'/'),
            inv.invoice_no,
            inv.client_name || '',
            inv.client_gstin || '',
            inv.invoice_type === 'credit_note' ? 'Credit Note' : inv.invoice_type === 'debit_note' ? 'Debit Note' : 'Sale ',
            total,
            (companies.find(c=>c.id===inv.company_id)?.name || '').toUpperCase(),
            paid,
            bal,
          ]);
        }
        const ws = XLSX.utils.aoa_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Sale Report');
        const [y,m] = month.split('-');
        XLSX.writeFile(wb, `SaleReport_01_${m}_${y.slice(2)}_to_28_${m}_${y.slice(2)}.xlsx`);
        toast.success('Sale Report exported!');
        return;
      }

      // ─────────── EXCEL EXPORT (GSTR-1 official multi-sheet) ───────────
      if (tab === 'gstr1') {
        const wb = XLSX.utils.book_new();

        // Sheet: GSTR1 Report (header)
        const hdr = [
          ['Period', periodLabel],
          [],
          ['1. GSTIN', supplierGSTIN],
          ['2.a Legal name of the registered person.', (co?.legal_name || co?.name || companyName).toUpperCase()],
          ['2.b Trade name, if any', co?.trade_name || ''],
          ['3.a Aggregate turnover of the preceeding Financial Year', ''],
          ['3.b Aggregate turnover, April to June 2017', ''],
          [],
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(hdr), 'GSTR1 Report');

        // b2b,sez,de
        const b2bRows = [
          ['Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)'],
          ['No. of Recipients', null, 'No. of Invoices', null, 'Total Invoice Value', null, null, null, null, null, null, 'Total Taxable Value', 'Total Cess'],
          [
            new Set(gstr1.b2b.map(i=>i.client_gstin)).size,
            null,
            gstr1.b2b.length,
            null,
            gstr1.b2b.reduce((s,i)=>s+Number(i.grand_total||0),0),
            null,null,null,null,null,null,
            gstr1.b2b.reduce((s,i)=>s+Number(i.total_taxable||0),0),
            0,
          ],
          ['GSTIN/UIN of Recipient','Receiver Name','Invoice Number','Invoice date','Invoice Value','Place Of Supply','Reverse Charge','Applicable % of Tax Rate','Invoice Type','E-Commerce GSTIN','Rate','Taxable Value','Cess Amount'],
        ];
        for (const inv of gstr1.b2b) {
          const pos = posLabel(inv.client_state) || posLabel(supplierState);
          for (const r of itemsByRate(inv)) {
            b2bRows.push([
              (inv.client_gstin||'').toUpperCase(),
              (inv.client_name||'').toUpperCase(),
              inv.invoice_no,
              fmtMon(inv.invoice_date),
              Number(inv.grand_total||0),
              pos,
              'N',
              null,
              'Regular B2B',
              null,
              r.rate,
              Number(r.taxable.toFixed(2)),
              Number(r.cess.toFixed(2)),
            ]);
          }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2bRows), 'b2b,sez,de');

        // b2cl
        const b2clRows = [
          ['Summary For B2CL(5)'],
          ['No. of Invoices', null, 'Total Invoice Value', null, null, null, 'Total Taxable Value', 'Total Cess'],
          [gstr1.b2cL.length, null, gstr1.b2cL.reduce((s,i)=>s+Number(i.grand_total||0),0), null, null, null, gstr1.b2cL.reduce((s,i)=>s+Number(i.total_taxable||0),0), 0],
          ['Invoice Number','Invoice date','Invoice Value','Place Of Supply','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount','E-Commerce GSTIN'],
        ];
        for (const inv of gstr1.b2cL) {
          for (const r of itemsByRate(inv)) {
            b2clRows.push([inv.invoice_no, fmtMon(inv.invoice_date), Number(inv.grand_total||0), posLabel(inv.client_state), null, r.rate, Number(r.taxable.toFixed(2)), Number(r.cess.toFixed(2)), null]);
          }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2clRows), 'b2cl');

        // b2cs (aggregated by rate+pos)
        const b2csAgg = {};
        for (const inv of gstr1.b2cS) {
          const pos = posLabel(inv.client_state) || posLabel(supplierState);
          const intra = stateCode(inv.client_state) === supplierStateCode || !inv.client_state;
          for (const r of itemsByRate(inv)) {
            const k = `${pos}|${r.rate}|${intra?'OE':'OE'}`;
            if (!b2csAgg[k]) b2csAgg[k] = { type:'OE', pos, rate: r.rate, taxable: 0, cess: 0 };
            b2csAgg[k].taxable += r.taxable; b2csAgg[k].cess += r.cess;
          }
        }
        const b2csList = Object.values(b2csAgg);
        const b2csRows = [
          ['Summary For B2CS(7)'],
          [null, null, null, null, 'Total Taxable Value', 'Total Cess'],
          [null, null, null, null, b2csList.reduce((s,x)=>s+x.taxable,0), b2csList.reduce((s,x)=>s+x.cess,0)],
          ['Type','Place Of Supply','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount','E-Commerce GSTIN'],
          ...b2csList.map(x => [x.type, x.pos, null, x.rate, Number(x.taxable.toFixed(2)), Number(x.cess.toFixed(2)), null]),
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(b2csRows), 'b2cs');

        // cdnr
        const cdnrRows = [
          ['Summary For CDNR(9B)'],
          ['No. of Recipients', null, 'No. of Notes', null, null, null, null, null, 'Total Note Value', null, null, 'Total Taxable Value', 'Total Cess'],
          [
            new Set(gstr1.cdnr.map(i=>i.client_gstin)).size, null,
            gstr1.cdnr.length, null, null, null, null, null,
            gstr1.cdnr.reduce((s,i)=>s+Number(i.grand_total||0),0), null, null,
            gstr1.cdnr.reduce((s,i)=>s+Number(i.total_taxable||0),0), 0,
          ],
          ['GSTIN/UIN of Recipient','Receiver Name','Note Number','Note Date','Note Type','Place Of Supply','Reverse Charge','Note Supply Type','Note Value','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount'],
        ];
        for (const inv of gstr1.cdnr) {
          for (const r of itemsByRate(inv)) {
            cdnrRows.push([
              (inv.client_gstin||'').toUpperCase(),
              (inv.client_name||'').toUpperCase(),
              inv.invoice_no, fmtMon(inv.invoice_date),
              inv.invoice_type === 'credit_note' ? 'C' : 'D',
              posLabel(inv.client_state) || posLabel(supplierState),
              'N','Regular',
              Number(inv.grand_total||0), null, r.rate,
              Number(r.taxable.toFixed(2)), Number(r.cess.toFixed(2)),
            ]);
          }
        }
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cdnrRows), 'cdnr');

        // cdnur (empty placeholder)
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['Summary For CDNUR(9B)'],
          [null, 'No. of Notes/Vouchers', null, null, null, 'Total Note Value', null, null, 'Total Taxable Value', 'Total Cess'],
          [null, 0, null, null, null, 0, null, null, 0, 0],
          ['UR Type','Note Number','Note Date','Note Type','Place Of Supply','Note Value','Applicable % of Tax Rate','Rate','Taxable Value','Cess Amount'],
        ]), 'cdnur');

        // exp / at / atadj / exemp (empty placeholders matching official template)
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['Summary For EXP(6)'],
          [null,'No. of Invoices', null,'Total Invoice Value', null,'No. of Shipping Bill', null, null, 'Total Taxable Value'],
          [],
          ['Export Type','Invoice Number','Invoice date','Invoice Value','Port Code','Shipping Bill Number','Shipping Bill Date','Rate','Taxable Value'],
        ]), 'exp');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['Summary For Advance Received(11B)'],
          [null,null,null,'Total Advance Received','Total Cess'],
          [],
          ['Place Of Supply','Applicable % of Tax Rate','Rate','Gross Advance Received','Cess Amount'],
        ]), 'at');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['Summary For Advance Adjusted(11B)'],
          [null,null,null,'Total Advance Adjusted','Total Cess'],
          [],
          ['Place Of Supply','Applicable % of Tax Rate','Rate','Gross Advance Adjusted','Cess Amount'],
        ]), 'atadj');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['Summary For Nil rated, exempted and non GST outward supplies (8)'],
          [null,'Total Nil Rated Supplies','Total Exempted Supplies','Total Non-GST Supplies'],
          [null, 0, 0, 0],
          ['Description','Nil Rated Supplies','Exempted(other than nil rated/non GST supply)','Non-GST Supplies'],
          ['Inter-State supplies to registered persons', 0, 0, 0],
          ['Intra-State supplies to registered persons', 0, 0, 0],
          ['Inter-State supplies to unregistered persons', 0, 0, 0],
          ['Intra-State supplies to unregistered persons', 0, 0, 0],
        ]), 'exemp');

        // hsn(b2b), hsn(b2c), itemSummary
        const hsnB2bAgg = {};
        for (const inv of gstr1.b2b) {
          for (const r of itemsByRate(inv)) {
            const k = `${r.rate}`;
            if (!hsnB2bAgg[k]) hsnB2bAgg[k] = { rate:r.rate, value:0, taxable:0, igst:0, cgst:0, sgst:0, cess:0, qty:0 };
            hsnB2bAgg[k].value   += Number(inv.grand_total || 0) * (r.taxable / Math.max(1, Number(inv.total_taxable||0) || r.taxable));
            hsnB2bAgg[k].taxable += r.taxable;
            hsnB2bAgg[k].igst    += r.igst;
            hsnB2bAgg[k].cgst    += r.cgst;
            hsnB2bAgg[k].sgst    += r.sgst;
            hsnB2bAgg[k].cess    += r.cess;
          }
        }
        const buildHsnSheet = (agg, title) => [
          ['Summary For HSN(12)'],
          ['No. of HSN', null, null, null, 'Total Value', null, 'Total Taxable Value', 'Total Integrated Tax', 'Total Central Tax', 'Total State/UT Tax', 'Total Cess'],
          [Object.keys(agg).length, null, null, null,
            Object.values(agg).reduce((s,x)=>s+x.value,0), null,
            Object.values(agg).reduce((s,x)=>s+x.taxable,0),
            Object.values(agg).reduce((s,x)=>s+x.igst,0),
            Object.values(agg).reduce((s,x)=>s+x.cgst,0),
            Object.values(agg).reduce((s,x)=>s+x.sgst,0),
            Object.values(agg).reduce((s,x)=>s+x.cess,0)],
          ['HSN','Description','UQC','Total Quantity','Total Value','Rate','Taxable Value','Integrated Tax Amount','Central Tax Amount','State/UT Tax Amount','Cess Amount'],
          ...Object.values(agg).map(x => [null, null, 'NA-NOT APPLICABLE', 0, Number(x.value.toFixed(2)), x.rate, Number(x.taxable.toFixed(2)), Number(x.igst.toFixed(2)), Number(x.cgst.toFixed(2)), Number(x.sgst.toFixed(2)), Number(x.cess.toFixed(2))]),
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildHsnSheet(hsnB2bAgg)), 'hsn(b2b)');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(buildHsnSheet({})), 'hsn(b2c)');

        // itemSummary
        const itemAgg = {};
        for (const inv of [...gstr1.b2b, ...gstr1.b2cL, ...gstr1.b2cS]) {
          for (const it of (inv.items || [])) {
            const desc = (it.description || '').trim().toUpperCase();
            const rate = Number(it.gst_rate || 0);
            const k = `${desc}|${rate}`;
            if (!itemAgg[k]) itemAgg[k] = { desc, rate, value:0, taxable:0, igst:0, cgst:0, sgst:0, cess:0 };
            const tx = Number(it.taxable_value || 0);
            const cgst = Number(it.cgst_amount || 0), sgst = Number(it.sgst_amount || 0), igst = Number(it.igst_amount || 0);
            itemAgg[k].taxable += tx;
            itemAgg[k].cgst    += cgst;
            itemAgg[k].sgst    += sgst;
            itemAgg[k].igst    += igst;
            itemAgg[k].value   += tx + cgst + sgst + igst;
          }
        }
        const itemRows = [
          ['Summary For HSN(12)'],
          ['No. of HSN', null, null, null, 'Total Value', null, 'Total Taxable Value', 'Total Integrated Tax', 'Total Central Tax', 'Total State/UT Tax', 'Total Cess'],
          [Object.keys(itemAgg).length, null, null, null,
            Object.values(itemAgg).reduce((s,x)=>s+x.value,0), null,
            Object.values(itemAgg).reduce((s,x)=>s+x.taxable,0),
            Object.values(itemAgg).reduce((s,x)=>s+x.igst,0),
            Object.values(itemAgg).reduce((s,x)=>s+x.cgst,0),
            Object.values(itemAgg).reduce((s,x)=>s+x.sgst,0),
            Object.values(itemAgg).reduce((s,x)=>s+x.cess,0)],
          ['HSN','Description','UQC','Total Quantity','Total Value','Rate','Taxable Value','Integrated Tax Amount','Central Tax Amount','State/UT Tax Amount','Cess Amount'],
          ...Object.values(itemAgg).map(x => [null, x.desc, 'NA-NOT APPLICABLE', 0, Number(x.value.toFixed(2)), x.rate, Number(x.taxable.toFixed(2)), Number(x.igst.toFixed(2)), Number(x.cgst.toFixed(2)), Number(x.sgst.toFixed(2)), Number(x.cess.toFixed(2))]),
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(itemRows), 'itemSummary');

        // docs (13)
        const taxDocs = baseInvoices.filter(i => i.invoice_type === 'tax_invoice')
          .map(i => i.invoice_no).sort();
        const cnDocs = baseInvoices.filter(i => i.invoice_type === 'credit_note')
          .map(i => i.invoice_no).sort();
        const docsRows = [
          ['Summary of documents issued during the tax period (13)'],
          [null, null, null, 'Total Number', 'Total Cancelled'],
          [null, null, null, String(taxDocs.length + cnDocs.length), '0'],
          ['Nature of Document','Sr. No. From','Sr. No. To','Total Number','Cancelled'],
        ];
        if (taxDocs.length) docsRows.push(['Invoices for outward supply', taxDocs[0], taxDocs[taxDocs.length-1], String(taxDocs.length), '0']);
        if (cnDocs.length)  docsRows.push(['Credit Note', cnDocs[0], cnDocs[cnDocs.length-1], String(cnDocs.length), '0']);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(docsRows), 'docs');

        const [yy,mm] = month.split('-');
        XLSX.writeFile(wb, `GSTR1_Report_${mm}_${yy.slice(2)}_to_${mm}_${yy.slice(2)}.xlsx`);
        toast.success('GSTR-1 (official format) exported!');
        return;
      }

      // ─────────── GSTR-3B official format ───────────
      const wb = XLSX.utils.book_new();
      const [yy, mm] = month.split('-');
      const fpDisp = `${mm}/${yy}`;

      const r31 = [
        ['From', fpDisp],
        ['To',   fpDisp],
        ['Nature of Supplies','Total Taxable Value','Integrated Tax','Central Tax','State/UT Tax','Cess'],
        [],
        ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted', gstr3b.outward.taxable, gstr3b.outward.igst, gstr3b.outward.cgst, gstr3b.outward.sgst, 0],
        ['(b) Outward taxable supplies (zero rated)', 0, 0, 0, 0, 0],
        ['(c) Other outward supplies (nil rated, exempted)', 0, 0, 0, 0, 0],
        ['(d) Inward supplies (liable to reverse charge)', 0, 0, 0, 0, 0],
        ['(e) Non-GST outward supplies', 0, 0, 0, 0, 0],
      ];
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(r31), '3.1 Report');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Place of Supply (State/UT)','Supplies Made To Unregistered Persons', null, 'Supplies Made To Composition Taxable Persons', null, 'Supplies Made To UIN Holders', null],
        [],
        [null,'Total taxable value','Amount of integrated tax','Total taxable value','Amount of integrated tax','Total taxable value','Amount of integrated tax'],
      ]), '3.2 Report');

      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
        ['Details','Integrated Tax','Central Tax','State/UT Tax','Cess'],
        [],
        ['(A) ITC Available (Whether in full or part)', 0, 0, 0, 0],
        ['(1) Import of goods', 0, 0, 0, 0],
        ['(2) Import of services', 0, 0, 0, 0],
        ['(3) Inward supplies liable to reverse charge', 0, 0, 0, 0],
        ['(4) Inward supplies from ISD', 0, 0, 0, 0],
        ['(5) All other ITC', 0, 0, 0, 0],
        ['(B) ITC Reversed', 0, 0, 0, 0],
        ['(C) Net ITC available (A-B)', 0, 0, 0, 0],
        ['(D) Other Details', 0, 0, 0, 0],
      ]), '4 Report');

      XLSX.writeFile(wb, `GSTR3B_Report_${mm}_${yy.slice(2)}_to_${mm}_${yy.slice(2)}.xlsx`);
      toast.success('GSTR-3B (official format) exported!');
    } catch (e) {
      console.error(e);
      toast.error('Export failed: ' + (e.message || e));
    } finally {
      setExporting(null);
    }
  };

  // ── Shared table styles ─────────────────────────────────────────────────
  const thCls = `px-3 py-2.5 text-left text-[9px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`;
  const tdCls = `px-3 py-2 text-xs ${isDark ? 'text-slate-300' : 'text-slate-700'}`;
  const trCls = `border-b last:border-0 ${isDark ? 'border-slate-700 hover:bg-slate-700/30' : 'border-slate-50 hover:bg-slate-50'}`;
  const cardCls = `rounded-xl border ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-slate-50 border-slate-200'}`;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={`max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 [&>button.absolute]:hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
        <DialogTitle className="sr-only">GST Returns</DialogTitle>
        <DialogDescription className="sr-only">GSTR-1 and GSTR-3B reports</DialogDescription>

        {/* Header */}
        <div
          className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #064e3b, #065f46, #047857)' }}
        >
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="h-5 w-5 text-white" />
            <div>
              <h2 className="text-white font-bold text-lg leading-tight">GST Returns</h2>
              <p className="text-emerald-200 text-xs">GSTR-1 · GSTR-3B · {baseInvoices.length} invoices in view</p>
            </div>
          </div>

          {/* ✅ FIX 1: removed stray }), FIX 3: added close button */}
          <div className="flex items-center gap-2 flex-wrap">
            <Select value={companyFilter} onValueChange={setCompanyFilter}>
              <SelectTrigger className={`h-9 w-[160px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-blue-50 text-blue-700'}`}>
                <Building2 className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
                <SelectValue placeholder="Select Company" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Companies</SelectItem>
                {(companies || []).map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          
            <input
              type="month"
              value={month}
              onChange={e => setMonth(e.target.value)}
              className="h-9 px-3 rounded-xl bg-white/15 text-white text-xs border border-white/20 [color-scheme:dark] focus:outline-none"
            />
            <button
              onClick={() => handleExport('excel')}
              disabled={exporting}
              className="h-9 px-3 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-semibold flex items-center gap-1.5 border border-white/20 transition-colors disabled:opacity-50"
            >
              <Download className="h-3.5 w-3.5" />
              {exporting === 'excel' ? 'Exporting…' : 'Excel'}
            </button>
            <button
              onClick={() => handleExport('json')}
              disabled={exporting}
              className="h-9 px-3 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-semibold flex items-center gap-1.5 border border-white/20 transition-colors disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" />
              {exporting === 'json' ? 'Exporting…' : 'JSON'}
            </button>
            <button
              onClick={() => handleExport('sale')}
              disabled={exporting}
              className="h-9 px-3 rounded-xl bg-white/15 hover:bg-white/25 text-white text-xs font-semibold flex items-center gap-1.5 border border-white/20 transition-colors disabled:opacity-50"
              title="Sale Report (Tally-style)"
            >
              <FileSpreadsheet className="h-3.5 w-3.5" />
              {exporting === 'sale' ? 'Exporting…' : 'Sale Report'}
            </button>
            {/* ✅ FIX 3: Close button */}
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors flex-shrink-0"
              title="Close"
            >
              <X className="h-4 w-4 text-white" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className={`flex border-b flex-shrink-0 ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          {[
            { id: 'gstr1',  label: 'GSTR-1',  sub: 'Outward Supplies' },
            { id: 'gstr3b', label: 'GSTR-3B', sub: 'Tax Summary' },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-6 py-3.5 text-sm font-semibold border-b-2 transition-all ${
                tab === t.id
                  ? `border-emerald-500 ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`
                  : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`
              }`}>
              {t.label}
              <span className={`text-[10px] font-normal ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{t.sub}</span>
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {baseInvoices.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-3">
              <FileSpreadsheet className="h-10 w-10 opacity-20" />
              <p className="text-sm font-medium">No invoices for {month}{companyFilter !== 'all' ? ' · selected company' : ''}</p>
              <p className="text-xs">Adjust the month or company filter above</p>
            </div>
          ) : tab === 'gstr1' ? (
            <div className="space-y-5">
              {/* Summary pills */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'B2B Invoices',      value: gstr1.b2b.length,  color: COLORS.mediumBlue,   desc: 'Registered buyers (GSTIN)' },
                  { label: 'B2C Large',          value: gstr1.b2cL.length, color: COLORS.amber,        desc: 'Unregistered > ₹2.5L' },
                  { label: 'B2C Small',          value: gstr1.b2cS.length, color: COLORS.emeraldGreen, desc: 'Unregistered ≤ ₹2.5L' },
                  { label: 'Credit/Debit Notes', value: gstr1.cdnr.length, color: COLORS.coral,        desc: 'CDNR' },
                ].map(s => (
                  <div key={s.label} className={`${cardCls} p-3`}>
                    <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1">{s.label}</p>
                    <p className="text-2xl font-black" style={{ color: s.color }}>{s.value}</p>
                    <p className="text-[9px] text-slate-400 mt-0.5">{s.desc}</p>
                  </div>
                ))}
              </div>

              {/* B2B */}
              {gstr1.b2b.length > 0 && (
                <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <div className={`px-4 py-2.5 border-b ${isDark ? 'bg-slate-700/60 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                      B2B — Registered Buyers ({gstr1.b2b.length})
                    </p>
                  </div>
                  <div className="overflow-x-auto max-h-56 overflow-y-auto">
                    <table className="w-full">
                      <thead className={`sticky top-0 ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
                        <tr>
                          {['Invoice No','Date','Client','GSTIN','Taxable','CGST','SGST','IGST','Total'].map(h => (
                            <th key={h} className={thCls}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {gstr1.b2b.map((inv, i) => (
                          <tr key={inv.id || i} className={trCls}>
                            <td className={`${tdCls} font-mono font-semibold`}>{inv.invoice_no}</td>
                            <td className={tdCls}>{inv.invoice_date}</td>
                            <td className={`${tdCls} max-w-[140px] truncate`}>{inv.client_name}</td>
                            <td className={`${tdCls} font-mono text-[10px]`}>{inv.client_gstin}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_taxable)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_cgst)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_sgst)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_igst)}</td>
                            <td className={`${tdCls} text-right font-bold`}>{fmtC(inv.grand_total)}</td>
                          </tr>
                        ))}
                        <tr className={`border-t-2 font-bold ${isDark ? 'border-slate-600 bg-slate-700/40' : 'border-slate-200 bg-slate-50'}`}>
                          <td colSpan={4} className={`${tdCls} font-bold`}>B2B Total</td>
                          <td className={`${tdCls} text-right font-bold`} style={{ color: COLORS.mediumBlue }}>{fmtC(gstr1.b2b.reduce((s,i)=>s+(i.total_taxable||0),0))}</td>
                          <td className={`${tdCls} text-right font-bold`}>{fmtC(gstr1.b2b.reduce((s,i)=>s+(i.total_cgst||0),0))}</td>
                          <td className={`${tdCls} text-right font-bold`}>{fmtC(gstr1.b2b.reduce((s,i)=>s+(i.total_sgst||0),0))}</td>
                          <td className={`${tdCls} text-right font-bold`}>{fmtC(gstr1.b2b.reduce((s,i)=>s+(i.total_igst||0),0))}</td>
                          <td className={`${tdCls} text-right font-bold`} style={{ color: COLORS.mediumBlue }}>{fmtC(gstr1.b2b.reduce((s,i)=>s+(i.grand_total||0),0))}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* B2C Large */}
              {gstr1.b2cL.length > 0 && (
                <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <div className={`px-4 py-2.5 border-b ${isDark ? 'bg-slate-700/60 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">B2C Large — &gt;₹2.5L ({gstr1.b2cL.length})</p>
                  </div>
                  <div className="overflow-x-auto max-h-44 overflow-y-auto">
                    <table className="w-full">
                      <thead className={`sticky top-0 ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
                        <tr>{['Invoice No','Date','Client','Taxable','CGST','SGST','IGST','Total'].map(h=><th key={h} className={thCls}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {gstr1.b2cL.map((inv,i)=>(
                          <tr key={inv.id||i} className={trCls}>
                            <td className={`${tdCls} font-mono`}>{inv.invoice_no}</td>
                            <td className={tdCls}>{inv.invoice_date}</td>
                            <td className={`${tdCls} max-w-[160px] truncate`}>{inv.client_name}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_taxable)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_cgst)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_sgst)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(inv.total_igst)}</td>
                            <td className={`${tdCls} text-right font-bold`}>{fmtC(inv.grand_total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* B2C Small Summary */}
              {gstr1.b2cS.length > 0 && (
                <div className={`${cardCls} p-4`}>
                  <p className={`text-xs font-bold uppercase tracking-wider mb-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    B2C Small Summary — {gstr1.b2cS.length} invoices (≤₹2.5L each, consolidated)
                  </p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {[
                      { label: 'Taxable', val: gstr1.b2cSTotal.taxable, color: COLORS.deepBlue },
                      { label: 'CGST',    val: gstr1.b2cSTotal.cgst,    color: COLORS.mediumBlue },
                      { label: 'SGST',    val: gstr1.b2cSTotal.sgst,    color: COLORS.mediumBlue },
                      { label: 'IGST',    val: gstr1.b2cSTotal.igst,    color: COLORS.amber },
                    ].map(s => (
                      <div key={s.label} className={`rounded-lg p-2.5 ${isDark ? 'bg-slate-800' : 'bg-white'} border ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
                        <p className="text-[9px] text-slate-400 uppercase tracking-wider">{s.label}</p>
                        <p className="text-sm font-black mt-0.5" style={{ color: s.color }}>{fmtC(s.val)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* HSN Summary */}
              {gstr1.hsnSummary.length > 0 && (
                <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                  <div className={`px-4 py-2.5 border-b ${isDark ? 'bg-slate-700/60 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                    <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">HSN/SAC Summary</p>
                  </div>
                  <div className="overflow-x-auto max-h-48 overflow-y-auto">
                    <table className="w-full">
                      <thead className={`sticky top-0 ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
                        <tr>{['HSN/SAC','Description','Qty','Taxable Value','CGST','SGST','IGST'].map(h=><th key={h} className={thCls}>{h}</th>)}</tr>
                      </thead>
                      <tbody>
                        {gstr1.hsnSummary.sort((a,b)=>b.taxable-a.taxable).map((h,i)=>(
                          <tr key={h.hsn_sac||i} className={trCls}>
                            <td className={`${tdCls} font-mono font-bold`}>{h.hsn_sac}</td>
                            <td className={`${tdCls} max-w-[180px] truncate`}>{h.description || '—'}</td>
                            <td className={`${tdCls} text-right`}>{h.quantity.toFixed(2)}</td>
                            <td className={`${tdCls} text-right font-semibold`}>{fmtC(h.taxable)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(h.cgst)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(h.sgst)}</td>
                            <td className={`${tdCls} text-right`}>{fmtC(h.igst)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : (
            // GSTR-3B
            <div className="space-y-5">
              {/* Net Tax Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Net IGST',           value: gstr3b.netIGST,  color: COLORS.coral },
                  { label: 'Net CGST',           value: gstr3b.netCGST,  color: COLORS.mediumBlue },
                  { label: 'Net SGST',           value: gstr3b.netSGST,  color: COLORS.teal },
                  { label: 'Total Tax Liability', value: gstr3b.netTotal, color: COLORS.deepBlue },
                ].map(s => (
                  <div key={s.label} className={`${cardCls} p-3`}>
                    <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1">{s.label}</p>
                    <p className="text-xl font-black" style={{ color: s.color }}>{fmtC(s.value)}</p>
                  </div>
                ))}
              </div>

              {/* 3.1 Outward Supplies */}
              <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                <div className={`px-4 py-2.5 border-b ${isDark ? 'bg-slate-700/60 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">3.1 — Outward Taxable Supplies</p>
                </div>
                <table className="w-full">
                  <thead>
                    <tr className={isDark ? 'bg-slate-700/30' : 'bg-slate-50/60'}>
                      {['Description','Taxable Value','IGST','CGST','SGST','Total Tax'].map(h=><th key={h} className={thCls}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['Outward Taxable Supplies (Tax Invoice)', gstr3b.outward],
                      ['Credit Note Adjustments (−)',           gstr3b.credits],
                    ].map(([label, d]) => (
                      <tr key={label} className={trCls}>
                        <td className={`${tdCls} font-semibold`}>{label}</td>
                        <td className={`${tdCls} text-right`}>{fmtC(d.taxable)}</td>
                        <td className={`${tdCls} text-right`}>{fmtC(d.igst)}</td>
                        <td className={`${tdCls} text-right`}>{fmtC(d.cgst)}</td>
                        <td className={`${tdCls} text-right`}>{fmtC(d.sgst)}</td>
                        <td className={`${tdCls} text-right font-bold`}>{fmtC(d.igst + d.cgst + d.sgst)}</td>
                      </tr>
                    ))}
                    <tr className={`border-t-2 ${isDark ? 'border-slate-600 bg-slate-700/40' : 'border-slate-200 bg-emerald-50/60'}`}>
                      <td className={`${tdCls} font-black`} style={{ color: COLORS.emeraldGreen }}>Net Tax Payable</td>
                      <td className={`${tdCls} text-right font-bold`}>{fmtC(gstr3b.outward.taxable - gstr3b.credits.taxable)}</td>
                      <td className={`${tdCls} text-right font-bold`} style={{ color: COLORS.coral }}>{fmtC(gstr3b.netIGST)}</td>
                      <td className={`${tdCls} text-right font-bold`} style={{ color: COLORS.mediumBlue }}>{fmtC(gstr3b.netCGST)}</td>
                      <td className={`${tdCls} text-right font-bold`} style={{ color: COLORS.teal }}>{fmtC(gstr3b.netSGST)}</td>
                      <td className="px-3 py-2 text-right text-sm font-black" style={{ color: COLORS.deepBlue }}>{fmtC(gstr3b.netTotal)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Invoice list for the month */}
              <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                <div className={`px-4 py-2.5 border-b ${isDark ? 'bg-slate-700/60 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                  <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    All Invoices in {month} ({baseInvoices.length})
                  </p>
                </div>
                <div className="overflow-x-auto max-h-64 overflow-y-auto">
                  <table className="w-full">
                    <thead className={`sticky top-0 ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
                      <tr>{['Invoice No','Type','Client','Date','Taxable','CGST','SGST','IGST','Total'].map(h=><th key={h} className={thCls}>{h}</th>)}</tr>
                    </thead>
                    <tbody>
                      {baseInvoices.map((inv,i)=>(
                        <tr key={inv.id||i} className={trCls}>
                          <td className={`${tdCls} font-mono font-semibold`}>{inv.invoice_no}</td>
                          <td className={tdCls}>
                            <span className={`text-[9px] font-bold px-2 py-0.5 rounded-full ${isDark?'bg-slate-700 text-slate-300':'bg-slate-100 text-slate-600'}`}>
                              {INV_TYPES.find(t=>t.value===inv.invoice_type)?.label||inv.invoice_type}
                            </span>
                          </td>
                          <td className={`${tdCls} max-w-[160px] truncate`}>{inv.client_name}</td>
                          <td className={tdCls}>{inv.invoice_date}</td>
                          <td className={`${tdCls} text-right`}>{fmtC(inv.total_taxable)}</td>
                          <td className={`${tdCls} text-right`}>{fmtC(inv.total_cgst)}</td>
                          <td className={`${tdCls} text-right`}>{fmtC(inv.total_sgst)}</td>
                          <td className={`${tdCls} text-right`}>{fmtC(inv.total_igst)}</td>
                          <td className={`${tdCls} text-right font-bold`}>{fmtC(inv.grand_total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
// ════════════════════════════════════════════════════════════════════════════════
// EXCEL IMPORT — parse Excel/CSV invoice template
// ════════════════════════════════════════════════════════════════════════════════
function parseSaleReportExcel(file) {
  return new Promise(async (resolve, reject) => {
    XLSX = await getXLSX();
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
        let headerIdx = rows.findIndex(r => String(r[0]).trim().toLowerCase() === 'date');
        if (headerIdx === -1) headerIdx = 2;
        const dataRows = rows.slice(headerIdx + 1).filter(r => r[0] && String(r[0]).trim());
        const invoices = dataRows.map((row, i) => {
          const rawDate = String(row[0] || '').trim();
          const orderNo = String(row[1] || '').trim();
          const invoiceNo = String(row[2] || '').trim();
          const partyName = String(row[3] || '').trim() || 'Unknown';
          const gstin = String(row[4] || '').trim();
          const phone = String(row[5] || '').trim();
          const txnType = String(row[6] || '').trim().toLowerCase();
          const totalAmount = parseFloat(row[7]) || 0;
          const paymentType = String(row[8] || '').trim();
          const received = parseFloat(row[9]) || 0;
          const balanceDue = parseFloat(row[10]) || 0;
          const paymentStatus = String(row[11] || '').trim().toLowerCase();
          const description = String(row[12] || '').trim();
          let invDate = format(new Date(), 'yyyy-MM-dd');
          if (rawDate) {
            const parts = rawDate.split('/');
            if (parts.length === 3) {
              const yr = parts[2].length === 2 ? '20' + parts[2] : parts[2];
              invDate = `${yr}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
            }
          }
          const dueDate = format(new Date(new Date(invDate).getTime() + 30 * 86400000), 'yyyy-MM-dd');
          let status = 'draft';
          if (['paid', 'received', 'clear'].includes(paymentStatus)) status = 'paid';
          else if (received > 0 && balanceDue > 0) status = 'partially_paid';
          else if (balanceDue > 0) status = 'sent';
          let invoice_type = 'tax_invoice';
          if (txnType.includes('credit')) invoice_type = 'credit_note';
          else if (txnType.includes('estimate')) invoice_type = 'estimate';
          const taxable = Math.round(totalAmount / 1.18 * 100) / 100;
          const gstAmt = Math.round((totalAmount - taxable) * 100) / 100;
          const cgst = Math.round(gstAmt / 2 * 100) / 100;
          const sgst = Math.round(gstAmt / 2 * 100) / 100;
          return {
            invoice_type,
            client_name: partyName,
            client_email: '',
            client_phone: phone,
            client_gstin: gstin,
            client_address: '',
            client_state: '',
            invoice_date: invDate,
            due_date: dueDate,
            reference_no: orderNo || invoiceNo,
            notes: description || paymentType,
            is_interstate: false,
            items: [{ description: description || `Sale - ${invoiceNo || i + 1}`, hsn_sac: '', quantity: 1, unit: 'service', unit_price: taxable, discount_pct: 0, gst_rate: 18, taxable_value: taxable, cgst_rate: 9, sgst_rate: 9, igst_rate: 0, cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0, total_amount: totalAmount }],
            subtotal: taxable, total_taxable: taxable, total_cgst: cgst, total_sgst: sgst, total_igst: 0,
            total_gst: gstAmt, grand_total: totalAmount, amount_paid: received, amount_due: balanceDue,
            status, payment_terms: paymentType || 'Due on receipt',
          };
        }).filter(inv => inv.grand_total > 0);
        resolve(invoices);
      } catch (err) { reject(new Error(`Failed to parse SaleReport: ${err.message}`)); }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsArrayBuffer(file);
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// REMOVE BACKUP SECTION (shown inside ImportModal choose step)
// ════════════════════════════════════════════════════════════════════════════════
const RemoveBackupSection = ({ isDark }) => {
  const [sources, setSources] = useState([]);
  const [loadingSources, setLoadingSources] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(null); // source string being removed

  const SOURCE_LABELS = {
    khatabook: 'KhataBook (.vyp / .vyb)',
    tally: 'Tally Export (.xml)',
    json: 'Vyapar / JSON',
    excel: 'Excel / CSV',
    unknown: 'Unknown Source',
  };

  const loadSources = async () => {
    setLoadingSources(true);
    try {
      const res = await api.get('/invoices/backup-sources');
      setSources(res.data || []);
    } catch { setSources([]); }
    setLoadingSources(false);
  };

  const handleExpand = () => {
    if (!expanded) loadSources();
    setExpanded(v => !v);
  };

  const handleRemove = async (source) => {
    const src = sources.find(s => s.source === source);
    if (!window.confirm(
      `Remove all data imported from "${SOURCE_LABELS[source] || source}"?\n\n` +
      `This will delete:\n• ${src?.invoice_count || 0} invoices\n• ${src?.client_count || 0} clients\n• ${src?.product_count || 0} products\n\nThis cannot be undone.`
    )) return;
    setRemoving(source);
    try {
      const res = await api.delete('/invoices/remove-backup', { params: { source } });
      toast.success(`Removed: ${res.data.invoices_deleted} invoices, ${res.data.clients_deleted} clients, ${res.data.products_deleted} products`);
      setSources(prev => prev.filter(s => s.source !== source));
    } catch {
      toast.error('Failed to remove backup data');
    }
    setRemoving(null);
  };

  return (
    <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700 bg-slate-700/20' : 'border-red-100 bg-red-50/40'}`}>
      <button
        type="button"
        onClick={handleExpand}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${isDark ? 'hover:bg-slate-700/40' : 'hover:bg-red-50'}`}>
        <div className="w-9 h-9 rounded-xl bg-red-100 dark:bg-red-900/30 flex items-center justify-center flex-shrink-0">
          <Trash2 className="h-4 w-4 text-red-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Remove Imported Backup</p>
          <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Delete all data from a previously imported backup</p>
        </div>
        {loadingSources ? <RefreshCw className="h-4 w-4 text-slate-400 animate-spin flex-shrink-0" /> : <ChevronDown className={`h-4 w-4 text-slate-400 flex-shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} />}
      </button>
      {expanded && (
        <div className={`border-t px-4 py-3 space-y-2 ${isDark ? 'border-slate-700' : 'border-red-100'}`}>
          {loadingSources ? (
            <div className="flex items-center justify-center py-4">
              <RefreshCw className="h-4 w-4 animate-spin text-slate-400" />
              <span className="ml-2 text-xs text-slate-400">Loading imported backups…</span>
            </div>
          ) : sources.length === 0 ? (
            <p className={`text-xs text-center py-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No imported backups found</p>
          ) : (
            sources.map(s => (
              <div key={s.source} className={`flex items-center gap-3 px-3 py-2.5 rounded-xl ${isDark ? 'bg-slate-700/40' : 'bg-white border border-red-100'}`}>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{SOURCE_LABELS[s.source] || s.source}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">
                    {s.invoice_count} invoices · {s.client_count} clients · {s.product_count} products
                  </p>
                </div>
                <button
                  type="button"
                  disabled={removing === s.source}
                  onClick={() => handleRemove(s.source)}
                  className="flex-shrink-0 flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold text-red-500 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 disabled:opacity-50 transition-colors">
                  {removing === s.source ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Remove
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// UNIFIED IMPORT MODAL
// ════════════════════════════════════════════════════════════════════════════════
const KB_PAY_STATUS = { 1: 'sent', 2: 'partially_paid', 3: 'paid' };

const ImportModal = ({ open, onClose, isDark, companies, onImportComplete }) => {
  // ── useState ──
  const [step, setStep] = useState('choose');
  const [importMode, setImportMode] = useState('');
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState({ imported: 0, clients: 0, clients_updated: 0, skipped: 0, errors: [] });
  const [selectedFirm, setSelectedFirm] = useState('__none__');
  const [importClients, setImportClients] = useState(true);
  const [importInvoices, setImportInvoices] = useState(true);
  const [selectedCompanyId, setSelectedCompanyId] = useState('__none__');

  // ── useRef ──
  const dropRef = useRef(null);

  // ── Handlers ──
  const reset = () => {
    setStep('choose'); setImportMode(''); setFile(null); setParsed(null);
    setError(''); setLoading(false); setProgress(0);
    setResults({ imported: 0, clients: 0, skipped: 0, errors: [], clients_updated: 0 });
  }; 

  const handleClose = () => { reset(); onClose(); };

  const handleFileDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!f) return;
    const name = f.name.toLowerCase();
    const ALLOWED_EXTS = {
      vyp: ['.vyp', '.vyb', '.db'],
      tally: ['.xml', '.tbk'],
      excel: ['.xlsx', '.xls', '.csv'],
      json: ['.json'],
    };
    const allowed = ALLOWED_EXTS[importMode] || [];
    if (allowed.length > 0 && !allowed.some(ext => name.endsWith(ext))) {
      setError(`Please upload one of: ${allowed.join(', ')}`);
      return;
    }
    setFile(f); setError('');
  }, [importMode]);

  const parseBackupViaAPI = async (f) => {
    const formData = new FormData();
    formData.append('file', f);
    try {
      const resp = await api.post('/invoices/parse-backup', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return resp.data;
    } catch (err) {
      throw new Error(err.response?.data?.detail || 'Server could not parse backup file');
    }
  };

  const handleParse = async () => {
    if (!file) return;
    setLoading(true); setError('');
    try {
      if (importMode === 'excel') {
        XLSX = await getXLSX();
        // Auto-detect SaleReport vs template
        const firstCell = await new Promise(res => {
          const sniffReader = new FileReader();
          sniffReader.onload = (ev) => {
            try {
              const wb = XLSX.read(ev.target.result, { type: 'array' });
              const ws = wb.Sheets[wb.SheetNames[0]];
              const rows = XLSX.utils.sheet_to_json(ws, { defval: '', header: 1 });
              res(String(rows[0]?.[0] || ''));
            } catch { res(''); }
          };
          sniffReader.readAsArrayBuffer(file);
        });
        const isSaleReport = firstCell.toLowerCase().includes('generated on');
        let invoices;
        if (isSaleReport) {
          invoices = await parseSaleReportExcel(file);
          if (!invoices.length) throw new Error('No valid sale rows found in SaleReport format.');
          setParsed({ invoices, firms: [], clients: [], items: [], mode: 'excel', source_label: 'SaleReport (Auto-detected)' });
        } else {
          invoices = await parseExcelInvoices(file);
          if (!invoices.length) throw new Error('No valid invoice rows found. Check the template format.');
          setParsed({ invoices, firms: [], clients: [], items: [], mode: 'excel', source_label: 'Excel/CSV' });
        }
      } else {
        const data = await parseBackupViaAPI(file);
        const mode = importMode === 'vyp' ? 'vyp' : importMode;
        setParsed({ ...data, mode });
        if (data.firms?.length > 0) setSelectedFirm(String(data.firms[0].firm_id));
      }
      setStep('preview');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

const handleImport = async () => {
  if (!parsed) return;
  setStep('importing');
  setProgress(5);

  const companyId = selectedCompanyId === '__none__' ? '' : selectedCompanyId;
  const source    = parsed.source || parsed.mode || 'unknown';
  const CHUNK     = 150; // invoices per request — keeps each call well under 30 s

  // Filter invoices by selected firm (for VYP multi-firm backups)
  const allInvToImport = (parsed.mode === 'excel'
    ? (parsed.invoices || [])
    : selectedFirm === '__none__'
      ? (parsed.invoices || [])
      : (parsed.invoices || []).filter(i => String(i.company_id) === selectedFirm)
  ).map(inv => {
    const clean = { ...inv };
    // Ensure items have at least one entry
    if (!clean.items?.length) {
      clean.items = [{
        description: 'Imported service', hsn_sac: '', quantity: 1, unit: 'service',
        unit_price: clean.grand_total || 0, discount_pct: 0, gst_rate: 18,
        taxable_value: clean.grand_total || 0,
        cgst_rate: 9, sgst_rate: 9, igst_rate: 0,
        cgst_amount: 0, sgst_amount: 0, igst_amount: 0,
        total_amount: clean.grand_total || 0,
      }];
    }
    return clean;
  });

  const totals = { imported: 0, clients: 0, clients_updated: 0, skipped: 0, errors: [] };

  try {
    // ── Chunk 0: send clients + items + payments + first slice of invoices ──
    const chunks = [];
    for (let i = 0; i < allInvToImport.length; i += CHUNK) {
      chunks.push(allInvToImport.slice(i, i + CHUNK));
    }
    if (chunks.length === 0) chunks.push([]); // at least one request

    const totalChunks = chunks.length;

    for (let ci = 0; ci < totalChunks; ci++) {
      const isFirst = ci === 0;
      const payload = {
        company_id:      companyId,
        source,
        invoices:        chunks[ci],
        // Only send clients / items / payments on the first chunk
        clients:         isFirst && importClients && parsed.mode !== 'excel' ? (parsed.clients || []) : [],
        items:           isFirst ? (parsed.items  || []) : [],
        payments:        isFirst ? (parsed.payments || []) : [],
        skip_duplicates: true,
      };

      // 5 minutes per chunk — bulk backend should finish in seconds but we give plenty of headroom
      const resp = await api.post('/invoices/import-backup', payload, { timeout: 300_000 });
      const d    = resp.data;

      totals.imported        += d.invoices_imported  || 0;
      totals.clients         += d.clients_imported   || 0;
      totals.clients_updated += d.clients_updated    || 0;
      totals.skipped         += d.invoices_skipped   || 0;
      if (d.errors?.length)    totals.errors.push(...d.errors);

      // Smooth progress: 5 % → 95 % across chunks, then 100 % on finish
      setProgress(Math.round(5 + ((ci + 1) / totalChunks) * 90));
    }

    setProgress(100);
    setResults({
      imported:         totals.imported,
      clients:          totals.clients,
      clients_updated:  totals.clients_updated,
      skipped:          totals.skipped,
      errors:           totals.errors.slice(0, 50),
    });
    setStep('done');
    onImportComplete?.();
    toast.success(`Imported ${totals.imported} invoice${totals.imported !== 1 ? 's' : ''} successfully`);
  } catch (err) {
    const detail = err.response?.data?.detail || err.message || 'Import failed';
    setResults({ imported: totals.imported, clients: totals.clients, skipped: totals.skipped, errors: [detail, ...totals.errors].slice(0, 50) });
    setStep('done');
    toast.error(`Import failed: ${detail}`);
  }
};

  const inputCls = `h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={`w-full max-w-xl rounded-2xl border shadow-2xl p-0 overflow-hidden flex flex-col ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}
        style={{ maxHeight: '90vh' }}>
        <DialogTitle className="sr-only">Import Invoices</DialogTitle>
        <DialogDescription className="sr-only">Import invoices from KhataBook .vyp or Excel file</DialogDescription>
        {/* Header */}
        <div className="px-6 py-5 relative overflow-hidden flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #065f46, #059669)' }}>
          <div className="absolute right-0 top-0 w-40 h-40 rounded-full -mr-12 -mt-12 opacity-10"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0"><Database className="h-5 w-5 text-white" /></div>
              <div><h2 className="text-white font-bold text-lg leading-tight">Import Invoices</h2><p className="text-emerald-200 text-xs mt-0.5">KhataBook · Tally · Vyapar · Excel</p></div>
            </div>
            <button onClick={handleClose} className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all flex-shrink-0"><X className="h-4 w-4 text-white" /></button>
          </div>
          {step !== 'choose' && (
            <div className="relative mt-4 flex items-center gap-1">
              {['upload', 'preview', 'importing', 'done'].map((s, i) => {
                const stepKeys = ['upload', 'preview', 'importing', 'done'];
                const current = stepKeys.indexOf(step);
                const isActive = i === current;
                const isDoneStep = i < current;
                return (
                  <React.Fragment key={s}>
                    <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${isActive ? 'bg-white text-emerald-700' : isDoneStep ? 'bg-white/30 text-white' : 'bg-white/10 text-white/50'}`}>
                      {isDoneStep ? <CheckCircle2 className="h-3 w-3" /> : <span className="w-3 h-3 flex items-center justify-center">{i + 1}</span>}
                      {['Upload', 'Preview', 'Import', 'Done'][i]}
                    </div>
                    {i < 3 && <div className={`flex-1 h-px ${isDoneStep ? 'bg-white/60' : 'bg-white/20'}`} />}
                  </React.Fragment>
                );
              })}
            </div>
          )}
        </div>
        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* STEP: CHOOSE MODE */}
          {step === 'choose' && (
            <div className="space-y-4">
              <p className={`text-sm font-medium text-center mb-5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Choose your import source</p>
              <div className={`rounded-xl border-2 border-dashed p-4 ${isDark ? 'border-slate-600 bg-slate-700/30' : 'border-slate-200 bg-slate-50'}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center flex-shrink-0"><FileDown className="h-5 w-5 text-amber-600" /></div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Download Excel Template</p>
                    <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Get a ready-made template with sample data & instructions</p>
                  </div>
                  <Button type="button" size="sm" onClick={downloadInvoiceTemplate} className="h-8 px-3 rounded-xl text-xs font-semibold gap-1.5 flex-shrink-0 text-white" style={{ background: 'linear-gradient(135deg, #b45309, #d97706)' }}><Download className="h-3.5 w-3.5" /> Download</Button>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3">
                {[
                  { mode: 'vyp', icon: Database, title: 'KhataBook Backup (.vyp / .vyb)', desc: 'Import clients, items & invoices from KhataBook .vyp or KhataBook Pro .vyb backup', color: 'from-emerald-600 to-emerald-700', badge: 'Recommended' },
                  { mode: 'tally', icon: FileSpreadsheet, title: 'Tally Export (.xml)', desc: 'Import from TallyPrime / Tally.ERP 9 XML export or .tbk backup', color: 'from-purple-600 to-purple-700', badge: 'Tally' },
                  { mode: 'json', icon: FileText, title: 'Vyapar / JSON (.json)', desc: 'Import from Vyapar JSON export or any JSON formatted backup file', color: 'from-amber-600 to-amber-700', badge: 'Vyapar' },
                  { mode: 'excel', icon: Table, title: 'Excel / CSV (.xlsx, .xls, .csv)', desc: 'Import from any spreadsheet — Sage, myBillBook, Zoho, Xero, or our template', color: 'from-blue-600 to-blue-700', badge: 'Universal' },
                ].map(opt => (
                  <button key={opt.mode} type="button"
                    onClick={() => { setImportMode(opt.mode); setStep('upload'); setError(''); setFile(null); }}
                    className={`w-full flex items-center gap-4 p-4 rounded-xl border-2 transition-all text-left hover:shadow-md ${isDark ? 'border-slate-600 hover:border-emerald-500 bg-slate-700/40' : 'border-slate-200 hover:border-emerald-400 bg-white'}`}>
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center text-white flex-shrink-0 bg-gradient-to-br ${opt.color}`}><opt.icon className="h-6 w-6" /></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{opt.title}</p>
                        <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">{opt.badge}</span>
                      </div>
                      <p className={`text-xs mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{opt.desc}</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-slate-400 flex-shrink-0" />
                  </button>
                ))}
              </div>
              {/* Remove Backup Section */}
              <RemoveBackupSection isDark={isDark} />
            </div>
          )}
          {/* STEP: UPLOAD FILE */}
          {step === 'upload' && (
            <div className="space-y-5">
              <button type="button" onClick={() => { setStep('choose'); setFile(null); setError(''); }}
                className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700">← Back to source selection</button>
              <div ref={dropRef} onDrop={handleFileDrop} onDragOver={(e) => e.preventDefault()}
                onClick={() => {
                  const inp = document.createElement('input'); inp.type = 'file';
                  inp.accept = importMode === 'vyp' ? '.vyp,.vyb,.db' : importMode === 'tally' ? '.xml,.tbk' : importMode === 'excel' ? '.xlsx,.xls,.csv' : '.json';
                  inp.onchange = handleFileDrop; inp.click();
                }}
                className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-all ${file ? (isDark ? 'border-emerald-500 bg-emerald-900/20' : 'border-emerald-400 bg-emerald-50') : (isDark ? 'border-slate-600 bg-slate-700/30 hover:border-emerald-500' : 'border-slate-300 bg-slate-50 hover:border-emerald-400')}`}>
                {file ? (
                  <div className="flex flex-col items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center"><CheckCircle2 className="h-7 w-7 text-emerald-600" /></div>
                    <div><p className={`text-sm font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{file.name}</p><p className="text-xs text-slate-400 mt-1">{(file.size / 1024).toFixed(1)} KB · Click or drop to change</p></div>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${isDark ? 'bg-slate-600' : 'bg-slate-200'}`}><Upload className="h-7 w-7 text-slate-400" /></div>
                    <div>
                      <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Drop your file here or click to browse</p>
                      <p className="text-xs text-slate-400 mt-1">
                        {importMode === 'vyp' && 'Accepts .vyp, .vyb, or .db files'}
                        {importMode === 'tally' && 'Accepts .xml or .tbk files'}
                        {importMode === 'excel' && 'Accepts .xlsx, .xls, or .csv files'}
                        {importMode === 'json' && 'Accepts .json files'}
                      </p>
                    </div>
                  </div>
                )}
              </div>
              {error && (
                <div className={`rounded-xl border p-3 flex items-start gap-2 ${isDark ? 'bg-red-900/20 border-red-800 text-red-300' : 'bg-red-50 border-red-200 text-red-700'}`}>
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /><p className="text-xs">{error}</p>
                </div>
              )}
              <Button onClick={handleParse} disabled={!file || loading} className="w-full h-11 rounded-xl text-white font-semibold"
                style={{ background: !file || loading ? '#94a3b8' : 'linear-gradient(135deg, #065f46, #059669)' }}>
                {loading ? <span className="flex items-center gap-2"><span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Parsing file…</span>
                  : <span className="flex items-center gap-2"><FileUp className="h-4 w-4" /> Parse & Preview</span>}
              </Button>
            </div>
          )}
{step === 'preview' && parsed && (
  <div className="space-y-5">
    <button
      type="button"
      onClick={() => setStep('upload')}
      className="flex items-center gap-1 text-xs font-semibold text-emerald-600 hover:text-emerald-700"
    >
      ← Back to upload
    </button>

    <div className={`rounded-xl border p-4 ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-emerald-50 border-emerald-200'}`}>
      <p className={`text-xs font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
        Parsed: {parsed.source_label || parsed.mode}
      </p>

      <div className="grid grid-cols-3 md:grid-cols-5 gap-3">
        {[
          { label: 'Firms', val: parsed.stats?.firms ?? parsed.firms?.length ?? 0 },
          { label: 'Clients', val: parsed.stats?.clients ?? parsed.clients?.length ?? 0 },
          { label: 'Items', val: parsed.stats?.items ?? parsed.items?.length ?? 0 },
          { label: 'Invoices', val: parsed.stats?.invoices ?? parsed.invoices?.length ?? 0 },
          { label: 'Payments', val: parsed.stats?.payments ?? parsed.payments?.length ?? 0 },
        ].map(s => (
          <div key={s.label} className="text-center">
            <p className={`text-xl font-black ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{s.val}</p>
            <p className="text-[10px] font-semibold text-slate-400 uppercase">{s.label}</p>
          </div>
        ))}
      </div>
    </div>

    {(parsed.firms?.length || 0) > 1 && (
      <div>
        <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">
          Select Firm
        </label>
        <Select value={selectedFirm} onValueChange={setSelectedFirm}>
          <SelectTrigger className={inputCls}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">All firms</SelectItem>
            {(parsed.firms || []).map(f => (
              <SelectItem key={f.firm_id} value={String(f.firm_id)}>
                {f.firm_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    )}

    <div>
      <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">
        Import Into Company Profile
      </label>
      <Select value={selectedCompanyId} onValueChange={setSelectedCompanyId}>
        <SelectTrigger className={inputCls}>
          <SelectValue placeholder="Select target company" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__none__">— Select later —</SelectItem>
          {(companies || []).map(c => (
            <SelectItem key={c.id} value={c.id}>
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>

    {parsed.mode !== 'excel' && (parsed.clients?.length || 0) > 0 && (
      <div className="flex items-center gap-3">
        <Switch checked={importClients} onCheckedChange={setImportClients} />
        <div>
          <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
            Import Clients ({parsed.clients.length})
          </p>
          <p className="text-xs text-slate-400">Add as client records</p>
        </div>
      </div>
    )}

    {(parsed.invoices?.length || 0) > 0 && (
      <div className={`rounded-xl border max-h-48 overflow-y-auto ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
        <div className={`px-4 py-2 border-b sticky top-0 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-50 border-slate-100'}`}>
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
            Invoice Preview ({parsed.invoices.length})
          </p>
        </div>

        {(parsed.invoices || []).slice(0, 20).map((inv, i) => (
          <div
            key={i}
            className={`flex items-center justify-between px-4 py-2 border-b last:border-0 ${isDark ? 'border-slate-700' : 'border-slate-50'}`}
          >
            <div className="flex-1 min-w-0">
              <p className={`text-xs font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>
                {inv.client_name || 'Unknown'}
              </p>
              <p className="text-[10px] text-slate-400">
                {inv.invoice_no || `#${i + 1}`} · {inv.invoice_date || '—'}
              </p>
            </div>
            <p className={`text-xs font-bold ${isDark ? 'text-slate-100' : 'text-slate-700'}`}>
              {fmtC(inv.grand_total || 0)}
            </p>
          </div>
        ))}

        {parsed.invoices.length > 20 && (
          <div className="px-4 py-2 text-center text-xs text-slate-400">
            +{parsed.invoices.length - 20} more…
          </div>
        )}
      </div>
    )}

    <Button
      onClick={handleImport}
      className="w-full h-11 rounded-xl text-white font-semibold"
      style={{ background: 'linear-gradient(135deg, #065f46, #059669)' }}
    >
      <CheckSquare className="h-4 w-4 mr-2" />

      Import {
        parsed.mode === 'excel' || selectedFirm === '__none__'
          ? parsed.invoices?.length || 0
          : (parsed.invoices || []).filter(
              i => String(i.company_id) === selectedFirm
            ).length
      } Invoices
      {
        importClients && (parsed.clients?.length || 0) > 0
          ? ` + ${parsed.clients.length} Clients`
          : ''
      }
    </Button>
  </div>
)}
          {/* STEP: IMPORTING */}
          {step === 'importing' && (
            <div className="flex flex-col items-center justify-center py-10 gap-6">
              <MiniLoader height={100} />
              <div className="w-full max-w-xs">
                <div className={`h-3 rounded-full overflow-hidden ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                  <div className="h-full rounded-full transition-all duration-300" style={{ width: `${progress}%`, background: 'linear-gradient(90deg, #065f46, #059669)' }} /></div>
                <p className="text-center text-xs font-bold text-emerald-600 mt-2">{progress}%</p>
              </div>
            </div>
          )}
          {/* STEP: DONE */}
          {step === 'done' && (
            <div className="space-y-5">
              <div className="flex flex-col items-center justify-center py-6 gap-4">
                <div className="w-16 h-16 rounded-2xl bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center"><CheckCircle2 className="h-8 w-8 text-emerald-600" /></div>
                <p className={`text-lg font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Import Complete!</p>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[
                  { label: 'Invoices Imported', val: results.imported, color: '#1FAF5A' },
                  { label: 'Clients Added/Updated', val: results.clients, color: '#1F6FB2' },
                  { label: 'Inv Skipped (Dup)', val: results.skipped, color: '#F59E0B' },
                  { label: 'Errors', val: results.errors?.length || 0, color: results.errors?.length ? '#EF4444' : '#94A3B8' },
                ].map(s => (
                  <div key={s.label} className={`rounded-xl border p-4 text-center ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
                    <p className="text-2xl font-black" style={{ color: s.color }}>{s.val}</p>
                    <p className="text-[10px] font-semibold text-slate-400 uppercase mt-1">{s.label}</p>
                  </div>
                ))}
              </div>
              {(results.errors?.length || 0) > 0 && (
                <div className={`rounded-xl border p-3 max-h-32 overflow-y-auto ${isDark ? 'bg-red-900/20 border-red-800' : 'bg-red-50 border-red-200'}`}>
                  <p className="text-[10px] font-bold uppercase tracking-widest text-red-500 mb-2">Errors ({results.errors.length})</p>
                  {results.errors.slice(0, 10).map((err, i) => <p key={i} className="text-xs text-red-600 dark:text-red-400">{err}</p>)}
                </div>
              )}
              <div className="flex gap-3">
                <Button variant="outline" onClick={handleClose} className="flex-1 h-10 rounded-xl">Close</Button>
                <Button onClick={() => reset()} className="flex-1 h-10 rounded-xl text-white" style={{ background: 'linear-gradient(135deg, #065f46, #059669)' }}>Import More</Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// STATUS PILL
// ════════════════════════════════════════════════════════════════════════════════
const StatusPill = ({ inv }) => {
  const m = getStatusMeta(inv);
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full ${m.bg} ${m.text} whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />{m.label}
    </span>
  );
};

// Selectable statuses exposed in the inline dropdown (overdue is computed, not stored)
const INLINE_STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'cancelled'];

const InlineStatusDropdown = ({ inv, onStatusChange, isDark }) => {
  const [open, setOpen]       = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  // Fixed-position coordinates — computed from the trigger button's screen rect
  const [dropPos, setDropPos] = React.useState({ top: 0, left: 0 });
  const triggerRef            = React.useRef(null);
  const m = getStatusMeta(inv);

  // States for the Payment Bank/Cash dialog
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [bankAccounts, setBankAccounts] = React.useState([]);
  const [selectedBankAcct, setSelectedBankAcct] = React.useState('');
  const [paymentMode, setPaymentMode] = React.useState('bank');
  const [fetchingAccounts, setFetchingAccounts] = React.useState(false);

  const recalcPos = React.useCallback(() => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    // Approximate height of dropdown (header + N rows)
    const dropHeight = INLINE_STATUSES.length * 38 + 38;
    const spaceBelow = window.innerHeight - r.bottom;
    // Flip above the trigger if not enough space below
    const topPos = spaceBelow < dropHeight + 8 ? r.top - dropHeight - 4 : r.bottom + 4;
    setDropPos({
      top:  Math.max(4, topPos),
      left: Math.max(8, r.right - 160),   // 160 = w-40
    });
  }, []);

  const handleToggle = (e) => {
    e.stopPropagation();
    if (!open) recalcPos();
    setOpen(v => !v);
  };

  // The dropdown is position:fixed (viewport-relative) so it does NOT move
  // with the page when the user scrolls after opening it — that's what was
  // causing it to appear to "jump" up near the top of the page while the
  // trigger row stayed further down. Keep it glued to the trigger by
  // recalculating on every scroll/resize while open, and close it if the
  // trigger scrolls out of view entirely.
  React.useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => {
      if (!triggerRef.current) { setOpen(false); return; }
      const r = triggerRef.current.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) { setOpen(false); return; }
      recalcPos();
    };
    // capture: true so this also fires for scroll on any scrollable
    // ancestor container, not just the window itself.
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open, recalcPos]);

  const handleSelect = async (newStatus) => {
    if (newStatus === inv.status) { setOpen(false); return; }
    
    if (newStatus === 'paid') {
      setOpen(false);
      setFetchingAccounts(true);
      setPaymentMode('bank');
      setSelectedBankAcct('');
      try {
        const companyId = inv.company_id || '';
        const { data } = await api.get(`/bank-accounts${companyId ? `?company_id=${companyId}` : ''}`);
        setBankAccounts(data || []);
        if (data && data.length > 0) {
          const primary = data.find(acc => acc.is_primary);
          setSelectedBankAcct(primary ? primary.id : data[0].id);
        }
      } catch (err) {
        console.error('Failed to fetch bank accounts', err);
        setBankAccounts([]);
      } finally {
        setFetchingAccounts(false);
        setDialogOpen(true);
      }
      return;
    }

    setLoading(true);
    try {
      const { data } = await api.patch(`/invoices/${inv.id}/status`, { status: newStatus });
      // data now includes amount_paid and amount_due from the server — pass them
      // so the parent can update the invoice row accurately without a refetch.
      onStatusChange(inv.id, newStatus, {
        amount_paid: data.amount_paid,
        amount_due:  data.amount_due,
      });
      toast.success(`Status updated → ${STATUS_META[newStatus]?.label || newStatus}`);
    } catch {
      toast.error('Failed to update status');
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  const handleConfirmPaid = async () => {
    setLoading(true);
    setDialogOpen(false);
    try {
      const { data } = await api.patch(`/invoices/${inv.id}/status`, {
        status: 'paid',
        payment_mode: paymentMode,
        bank_account_id: paymentMode === 'bank' ? selectedBankAcct : null
      });
      onStatusChange(inv.id, 'paid', {
        amount_paid: data.amount_paid,
        amount_due:  data.amount_due,
      });
      toast.success('Invoice marked as Paid successfully');
    } catch (err) {
      toast.error('Failed to update status to Paid');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div onClick={e => e.stopPropagation()}>
      {/* Trigger pill */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full transition-all
          hover:ring-2 hover:ring-offset-1 hover:ring-current cursor-pointer select-none
          ${m.bg} ${m.text} whitespace-nowrap`}
        title="Click to change status"
      >
        {loading
          ? <RefreshCw className="w-2.5 h-2.5 animate-spin" />
          : <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.dot}`} />}
        {m.label}
        <ChevronDown className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown — rendered via portal into document.body so it's always
          positioned relative to the true viewport. Without this, any
          transformed ancestor (hover:scale, hover:-translate-y, etc. found
          elsewhere in this layout) silently becomes the containing block for
          position:fixed children, which is what was pushing this dropdown to
          the wrong spot on screen instead of anchoring under the trigger. */}
      {open && createPortal(
        <>
          {/* Full-screen backdrop to close on outside click */}
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div
            className={`fixed z-[9999] w-40 rounded-xl border shadow-2xl overflow-hidden
              ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}
            style={{ top: dropPos.top, left: dropPos.left }}
          >
            {/* Header */}
            <div className={`px-3 py-2 border-b text-[9px] font-bold uppercase tracking-widest
              ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
              Change Status
            </div>
            {INLINE_STATUSES.map(s => {
              const sm = STATUS_META[s];
              const isCurrent = inv.status === s;
              return (
                <button key={s} type="button" onClick={() => handleSelect(s)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[11px] font-semibold transition-colors
                    ${isCurrent
                      ? `${sm.bg} ${sm.text}`
                      : isDark
                        ? 'text-slate-300 hover:bg-slate-700/70'
                        : 'text-slate-600 hover:bg-slate-50'}`}>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sm.dot}`} />
                  <span className="flex-1 text-left">{sm.label}</span>
                  {isCurrent && <Check className="w-3 h-3 opacity-70" />}
                </button>
              );
            })}
          </div>
        </>,
        document.body
      )}

      {/* Paid Confirmation Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className={`max-w-md p-6 rounded-2xl border shadow-2xl ${isDark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'}`}>
          <DialogTitle className="text-base font-bold flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5 text-emerald-500" />
            Mark Invoice as Paid
          </DialogTitle>
          <DialogDescription className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            Please select the account where the payment was received.
          </DialogDescription>
          
          <div className="mt-4 space-y-4">
            <div>
              <label className="text-xs font-semibold block mb-1.5">Payment Method</label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setPaymentMode('bank')}
                  className={`flex items-center justify-center gap-2 p-2.5 rounded-xl border text-xs font-semibold transition-all ${
                    paymentMode === 'bank'
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
                      : isDark
                        ? 'border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700/50'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <CreditCard className="w-4 h-4" />
                  Bank Account
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentMode('cash')}
                  className={`flex items-center justify-center gap-2 p-2.5 rounded-xl border text-xs font-semibold transition-all ${
                    paymentMode === 'cash'
                      ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500'
                      : isDark
                        ? 'border-slate-700 bg-slate-800 text-slate-400 hover:bg-slate-700/50'
                        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <IndianRupee className="w-4 h-4" />
                  Cash
                </button>
              </div>
            </div>

            {paymentMode === 'bank' && (
              <div>
                <label className="text-xs font-semibold block mb-1.5">Select Bank Account</label>
                {fetchingAccounts ? (
                  <div className="text-xs text-slate-500 animate-pulse flex items-center gap-2 py-2">
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    Fetching bank accounts...
                  </div>
                ) : bankAccounts.length === 0 ? (
                  <div className="text-xs text-amber-500 bg-amber-500/10 p-3 rounded-xl border border-amber-500/20">
                    No bank accounts are currently linked for this company. A generic Bank Accounts entry will be posted.
                  </div>
                ) : (
                  <Select value={selectedBankAcct} onValueChange={setSelectedBankAcct}>
                    <SelectTrigger className={`w-full text-xs ${isDark ? 'bg-slate-750 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                      <SelectValue placeholder="Select a bank account" />
                    </SelectTrigger>
                    <SelectContent className={isDark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'}>
                      {bankAccounts.map(acc => (
                        <SelectItem key={acc.id} value={acc.id} className="text-xs">
                          {acc.bank_name} — {acc.account_holder} (..{acc.account_number?.slice(-4) || 'XXXX'})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            )}
          </div>
          
          <div className="mt-6 flex justify-end gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDialogOpen(false)}
              className="text-xs rounded-xl"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleConfirmPaid}
              disabled={paymentMode === 'bank' && bankAccounts.length > 0 && !selectedBankAcct}
              className="text-xs bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl"
            >
              Confirm Payment
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// STAT CARD
// ════════════════════════════════════════════════════════════════════════════════
const StatCard = ({ label, value, sub, icon: Icon, color, bg, onClick, isDark, trend }) => (
  <div onClick={onClick}
    className={`rounded-2xl border p-5 relative overflow-hidden cursor-pointer hover:shadow-lg hover:-translate-y-0.5 transition-all ${isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-600' : 'bg-white border-slate-200/80 hover:border-slate-300'}`}>
    <div className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full" style={{ background: color }} />
    <div className="flex items-start justify-between mb-3 pl-2">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: bg }}><Icon className="h-5 w-5" style={{ color }} /></div>
      {trend !== undefined && (<span className={`text-[10px] font-bold px-2 py-1 rounded-full ${trend >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>{trend >= 0 ? '+' : ''}{trend}%</span>)}
    </div>
    <p className="text-[10px] font-bold uppercase tracking-widest mb-1 pl-2 text-slate-400">{label}</p>
    <p className={`text-2xl font-bold tracking-tight pl-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{value}</p>
    {sub && <p className={`text-xs pl-2 mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{sub}</p>}
  </div>
);

// ─── Enhanced Revenue Trend ───────────────────────────────────────────────────
const EnhancedRevenueTrend = ({ invoices = [], isDark }) => {
  // ── useState ──
  const [trendRange, setTrendRange] = useState('12m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [showServiceBreakdown, setShowServiceBreakdown] = useState(false);
  const [selectedServices, setSelectedServices] = useState([]);
  const [chartType, setChartType] = useState('line');
  const [selectedPoint, setSelectedPoint] = useState(null);

  // ── Pure helpers (no hooks) ──
  const fmtAxis = (v) => v >= 10000000 ? `${(v/10000000).toFixed(1)}Cr` : v >= 100000 ? `${(v/100000).toFixed(1)}L` : v >= 1000 ? `${(v/1000).toFixed(0)}k` : v.toFixed(0);

  // ── useCallback: getRange (stable, used by memos) ──
  const getRange = useCallback(() => {
    const now = new Date();
    if (trendRange === 'custom') {
      return {
        start: customFrom ? new Date(customFrom + 'T00:00:00') : subMonths(now, 12),
        end: customTo ? new Date(customTo + 'T23:59:59') : now,
      };
    }
    const m = { '1m': 1, '3m': 3, '6m': 6, '12m': 12 }[trendRange] || 12;
    return { start: subMonths(now, m), end: now };
  }, [trendRange, customFrom, customTo]);

  // ── useCallback: getMonths ──
  const getMonths = useCallback((start, end) => {
    const months = [];
    let cur = startOfMonth(start);
    while (cur <= end) {
      months.push(format(cur, 'yyyy-MM'));
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
    }
    return months;
  }, []);

  // ── useMemo: allServices ──
  const allServices = useMemo(() => {
    const s = new Set();
    (invoices || []).forEach(inv => (inv.items || []).forEach(it => { if (it.description?.trim()) s.add(it.description.trim()); }));
    return Array.from(s).slice(0, 30);
  }, [invoices]);

  // ── useMemo: itemSuggestions — merged localStorage + live invoices for autocomplete ──
  const itemSuggestions = useMemo(() => buildItemSuggestions(invoices), [invoices]);

  // ── useMemo: currentData ──
  const currentData = useMemo(() => {
    const { start, end } = getRange();
    return getMonths(start, end).map(m => {
      const monthInvs = (invoices || []).filter(i => i.invoice_date?.startsWith(m) && i.status !== 'cancelled');
      let serviceRevenue = 0;
      if (selectedServices.length > 0) {
        monthInvs.forEach(inv => (inv.items || []).forEach(it => {
          if (selectedServices.includes(it.description?.trim())) serviceRevenue += (it.total_amount || 0);
        }));
      }
      return {
        month: m, label: format(new Date(m + '-15'), 'MMM yy'),
        revenue: monthInvs.reduce((s, i) => s + (i.grand_total || 0), 0),
        collected: monthInvs.reduce((s, i) => s + (i.amount_paid || 0), 0),
        count: monthInvs.length, serviceRevenue,
      };
    });
  }, [invoices, trendRange, customFrom, customTo, selectedServices, getRange, getMonths]);

  // ── useMemo: prevData ──
  const prevData = useMemo(() => {
    if (!compareEnabled) return [];
    const { start, end } = getRange();
    const diff = end.getTime() - start.getTime();
    const prevStart = new Date(start.getTime() - diff);
    const prevEnd = new Date(start);
    return getMonths(prevStart, prevEnd).map(m => {
      const monthInvs = (invoices || []).filter(i => i.invoice_date?.startsWith(m) && i.status !== 'cancelled');
      return {
        month: m, label: format(new Date(m + '-15'), 'MMM yy'),
        revenue: monthInvs.reduce((s, i) => s + (i.grand_total || 0), 0),
        collected: monthInvs.reduce((s, i) => s + (i.amount_paid || 0), 0),
      };
    });
  }, [invoices, compareEnabled, trendRange, customFrom, customTo, getRange, getMonths]);

  // ── useMemo: serviceBreakdown ──
  const serviceBreakdown = useMemo(() => {
    const { start, end } = getRange();
    const startStr = format(start, 'yyyy-MM-dd'), endStr = format(end, 'yyyy-MM-dd');
    const map = {};
    (invoices || []).filter(i => i.invoice_date >= startStr && i.invoice_date <= endStr && i.status !== 'cancelled')
      .forEach(inv => (inv.items || []).forEach(it => {
        const k = (it.description || 'Unknown').trim();
        if (!map[k]) map[k] = { description: k, revenue: 0, count: 0 };
        map[k].revenue += (it.total_amount || 0); map[k].count++;
      }));
    return Object.values(map).sort((a, b) => b.revenue - a.revenue);
  }, [invoices, trendRange, customFrom, customTo, getRange]);

  // ── useMemo: aggregate totals (depend on currentData / prevData) ──
  const totalRevenue = useMemo(() => currentData.reduce((s, d) => s + d.revenue, 0), [currentData]);
  const totalCollected = useMemo(() => currentData.reduce((s, d) => s + d.collected, 0), [currentData]);
  const prevTotal = useMemo(() => prevData.reduce((s, d) => s + d.revenue, 0), [prevData]);
  const growthPct = useMemo(() => prevTotal > 0 ? Math.round((totalRevenue - prevTotal) / prevTotal * 100) : null, [totalRevenue, prevTotal]);

  // SVG chart params (derived, no hooks needed)
  const W = 700, H = 160, pad = { t: 20, b: 34, l: 58, r: 16 };
  const allVals = [...currentData.map(d => d.revenue), ...(compareEnabled ? prevData.map(d => d.revenue) : [])];
  const maxVal = Math.max(...allVals, 1);
  const n = currentData.length;
  const xStep = n > 1 ? (W - pad.l - pad.r) / (n - 1) : 0;
  const yS = (v) => H - pad.b - (v / maxVal) * (H - pad.t - pad.b);
  const pts = currentData.map((d, i) => [pad.l + i * xStep, yS(d.revenue)]);
  const colPts = currentData.map((d, i) => [pad.l + i * xStep, yS(d.collected)]);
  const svcPts = selectedServices.length > 0 ? currentData.map((d, i) => [pad.l + i * xStep, yS(d.serviceRevenue)]) : [];
  const chartPoint = selectedPoint !== null ? currentData[selectedPoint] : null;
  const prevAligned = compareEnabled ? currentData.map((_, i) => prevData[i] || { revenue: 0 }) : [];
  const prevPts = prevAligned.map((d, i) => [pad.l + i * xStep, yS(d.revenue)]);

  const RANGE_BTNS = [{ v:'1m',l:'1M' },{ v:'3m',l:'3M' },{ v:'6m',l:'6M' },{ v:'12m',l:'12M' },{ v:'custom',l:'Custom' }];

  if (!(invoices || []).some(i => (i.grand_total||0) > 0)) return null;

  return (
    <div className={`rounded-2xl border p-5 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200/80'}`}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-blue-50 dark:bg-blue-900/40"><BarChart3 className="h-4 w-4 text-blue-500" /></div>
          <div>
            <h3 className={`font-semibold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Revenue Trend</h3>
            <p className="text-xs text-slate-400">
              {fmtC(totalRevenue)} · {currentData.length} months
              {growthPct !== null && <span className={`ml-2 font-bold ${growthPct >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{growthPct >= 0 ? '↑' : '↓'} {Math.abs(growthPct)}% vs prev period</span>}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <div className={`flex rounded-xl overflow-hidden border ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
            {RANGE_BTNS.map(b => (
              <button key={b.v} onClick={() => setTrendRange(b.v)}
                className={`px-2.5 py-1.5 text-[10px] font-bold transition-all whitespace-nowrap ${trendRange === b.v ? 'bg-blue-600 text-white' : isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>
                {b.l}
              </button>
            ))}
          </div>
          <button onClick={() => setCompareEnabled(c => !c)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-bold border transition-all ${compareEnabled ? 'bg-purple-600 text-white border-purple-600' : isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-white text-slate-600 border-slate-200'}`}>
            <ArrowRightLeft className="h-3 w-3" /> Compare
          </button>
          <button onClick={() => setShowServiceBreakdown(s => !s)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[10px] font-bold border transition-all ${showServiceBreakdown ? 'bg-emerald-600 text-white border-emerald-600' : isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-white text-slate-600 border-slate-200'}`}>
            <PieChart className="h-3 w-3" /> By Service
          </button>
        </div>
      </div>

      {/* Custom date range */}
      {trendRange === 'custom' && (
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          <CalendarDays className="h-3.5 w-3.5 text-slate-400" />
          <input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
            className={`h-8 px-2 rounded-lg text-xs border ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 [color-scheme:dark]' : 'bg-white border-slate-200 text-slate-800'}`} />
          <span className="text-slate-400 text-xs">to</span>
          <input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
            className={`h-8 px-2 rounded-lg text-xs border ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 [color-scheme:dark]' : 'bg-white border-slate-200 text-slate-800'}`} />
        </div>
      )}

      {/* Comparative totals */}
      {compareEnabled && (
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: 'Current Period', val: totalRevenue, color: COLORS.mediumBlue },
            { label: 'Previous Period', val: prevTotal, color: COLORS.purple },
            { label: totalRevenue >= prevTotal ? 'Growth ↑' : 'Decline ↓', val: Math.abs(totalRevenue - prevTotal), sub: growthPct !== null ? `${Math.abs(growthPct)}%` : '—', color: totalRevenue >= prevTotal ? COLORS.emeraldGreen : COLORS.coral },
          ].map(c => (
            <div key={c.label} className={`rounded-xl border p-3 ${isDark ? 'bg-slate-700/60 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
              <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-1">{c.label}</p>
              <p className="text-base font-black" style={{ color: c.color }}>{fmtC(c.val)}</p>
              {c.sub && <p className="text-[10px] text-slate-400 mt-0.5">{c.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Service filter chips */}
      {showServiceBreakdown && allServices.length > 0 && (
        <div className="mb-4">
          <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400 mb-2">Filter by Service (multi-select — also highlights on chart)</p>
          <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
            <button onClick={() => setSelectedServices([])}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all ${selectedServices.length === 0 ? 'bg-blue-600 text-white border-blue-600' : isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-white text-slate-600 border-slate-200'}`}>
              All
            </button>
            {allServices.map(name => (
              <button key={name} title={name}
                onClick={() => setSelectedServices(prev => prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name])}
                className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold border transition-all max-w-[180px] truncate ${selectedServices.includes(name) ? 'bg-emerald-600 text-white border-emerald-600' : isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-white text-slate-600 border-slate-200'}`}>
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chart mode + interactive Revenue Trend chart */}
      {currentData.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className={`text-[10px] font-semibold ${isDark ? 'text-slate-300' : 'text-slate-500'}`}>
              Click any {chartType === 'line' ? 'point' : 'bar'} to view the exact turnover.
            </p>
            <div className={`flex rounded-lg overflow-hidden border ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
              <button
                type="button"
                onClick={() => { setChartType('line'); setSelectedPoint(null); }}
                className={`px-2.5 py-1 text-[10px] font-bold transition-all ${chartType === 'line' ? 'bg-blue-600 text-white' : isDark ? 'bg-slate-700 text-slate-300' : 'bg-white text-slate-600'}`}
              >
                Line
              </button>
              <button
                type="button"
                onClick={() => { setChartType('bar'); setSelectedPoint(null); }}
                className={`px-2.5 py-1 text-[10px] font-bold transition-all ${chartType === 'bar' ? 'bg-blue-600 text-white' : isDark ? 'bg-slate-700 text-slate-300' : 'bg-white text-slate-600'}`}
              >
                Bar
              </button>
            </div>
          </div>
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="none" style={{ overflow: 'visible' }}>
            <defs>
              <linearGradient id="trendAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.mediumBlue} stopOpacity="0.28" />
                <stop offset="65%" stopColor={COLORS.mediumBlue} stopOpacity="0.07" />
                <stop offset="100%" stopColor={COLORS.mediumBlue} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="collectedAreaGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={COLORS.emeraldGreen} stopOpacity="0.18" />
                <stop offset="100%" stopColor={COLORS.emeraldGreen} stopOpacity="0" />
              </linearGradient>
              <filter id="glowBlue" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
              <filter id="glowGreen" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="2" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            {[0.25, 0.5, 0.75, 1].map(f => {
              const y = H - pad.b - f * (H - pad.t - pad.b);
              return (
                <g key={f}>
                  <line x1={pad.l} y1={y} x2={W - pad.r} y2={y} stroke={isDark ? '#1e293b' : '#f1f5f9'} strokeWidth="1" strokeDasharray="4 4" />
                  <text x={pad.l - 6} y={y + 3.5} textAnchor="end" fontSize="8" fill={isDark ? '#475569' : '#94a3b8'} fontFamily="monospace">{fmtAxis(maxVal * f)}</text>
                </g>
              );
            })}
            {chartType === 'bar' ? (
              currentData.map((d, i) => {
                const x = currentData.length > 1 ? pad.l + i * xStep : W / 2;
                const barW = Math.min(30, Math.max(12, xStep * 0.55));
                const y = yS(d.revenue);
                const barH = Math.max(0, H - pad.b - y);
                const selected = selectedPoint === i;
                return (
                  <g key={`bar-${d.month}`} role="button" tabIndex={0} onClick={() => setSelectedPoint(i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedPoint(i); }} style={{ cursor: 'pointer' }}>
                    <rect x={x - barW/2} y={y} width={barW} height={barH} rx="5" fill={COLORS.mediumBlue} opacity={selected ? 1 : 0.86} />
                    {selected && <rect x={x - barW/2 - 2} y={y - 2} width={barW + 4} height={barH + 2} rx="6" fill="none" stroke={COLORS.mediumBlue} strokeWidth="2" opacity="0.45" />}
                    {d.revenue > 0 && i === currentData.length - 1 && (
                      <>
                        <rect x={x-30} y={Math.max(2, y-22)} width="60" height="14" rx="4" fill={COLORS.mediumBlue} opacity="0.92" />
                        <text x={x} y={Math.max(12, y-12)} textAnchor="middle" fontSize="7.5" fill="white" fontFamily="monospace" fontWeight="bold">{fmtAxis(d.revenue)}</text>
                      </>
                    )}
                    <text x={x} y={H-6} textAnchor="middle" fontSize="8" fill={isDark ? '#475569' : '#94a3b8'}>{d.label}</text>
                  </g>
                );
              })
            ) : (
              (() => {
                const smooth = (pp) => {
                  if (pp.length < 2) return '';
                  let d = `M${pp[0][0]},${pp[0][1]}`;
                  for (let i = 0; i < pp.length - 1; i++) {
                    const x0 = i > 0 ? pp[i-1][0] : pp[i][0], y0 = i > 0 ? pp[i-1][1] : pp[i][1];
                    const x1 = pp[i][0], y1 = pp[i][1];
                    const x2 = pp[i+1][0], y2 = pp[i+1][1];
                    const x3 = i < pp.length-2 ? pp[i+2][0] : x2, y3 = i < pp.length-2 ? pp[i+2][1] : y2;
                    const cp1x = x1 + (x2-x0)/5, cp1y = y1 + (y2-y0)/5;
                    const cp2x = x2 - (x3-x1)/5, cp2y = y2 - (y3-y1)/5;
                    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${x2},${y2}`;
                  }
                  return d;
                };
                const smoothArea = (pp) => {
                  if (pp.length < 2) return '';
                  return `${smooth(pp)} L${pp[pp.length-1][0]},${H-pad.b} L${pp[0][0]},${H-pad.b} Z`;
                };
                return (
                  <>
                    {colPts.length > 1 && <path d={smoothArea(colPts)} fill="url(#collectedAreaGrad)" />}
                    {pts.length > 1 && <path d={smoothArea(pts)} fill="url(#trendAreaGrad)" />}
                    {compareEnabled && prevPts.length > 1 && <path d={smooth(prevPts)} fill="none" stroke={COLORS.purple} strokeWidth="2" strokeDasharray="6 3" opacity="0.75" strokeLinecap="round" strokeLinejoin="round" />}
                    {selectedServices.length > 0 && svcPts.length > 1 && <path d={smooth(svcPts)} fill="none" stroke={COLORS.amber} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />}
                    {colPts.length > 1 && <path d={smooth(colPts)} fill="none" stroke={COLORS.emeraldGreen} strokeWidth="2" strokeDasharray="5 3" strokeLinecap="round" strokeLinejoin="round" filter="url(#glowGreen)" />}
                    {pts.length > 1 && <path d={smooth(pts)} fill="none" stroke={COLORS.mediumBlue} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" filter="url(#glowBlue)" />}
                    {pts.map(([x, y], i) => {
                      const selected = selectedPoint === i;
                      return (
                        <g key={i} role="button" tabIndex={0} onClick={() => setSelectedPoint(i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setSelectedPoint(i); }} style={{ cursor: 'pointer' }}>
                          <circle cx={x} cy={y} r={selected ? 9 : 7} fill={COLORS.mediumBlue} opacity={selected ? 0.18 : 0.10} />
                          <circle cx={x} cy={y} r={selected ? 5 : 3.5} fill="white" stroke={COLORS.mediumBlue} strokeWidth="2.5" />
                          {selected && (
                            <g>
                              <rect x={x-70} y={Math.max(2, y-46)} width="140" height="34" rx="7" fill={isDark ? '#0f172a' : '#0f172a'} opacity="0.96" />
                              <text x={x} y={Math.max(16, y-30)} textAnchor="middle" fontSize="8" fill="#cbd5e1" fontWeight="600">{currentData[i]?.label}</text>
                              <text x={x} y={Math.max(28, y-16)} textAnchor="middle" fontSize="10" fill="white" fontFamily="monospace" fontWeight="bold">Turnover: {fmtC(currentData[i]?.revenue || 0)}</text>
                            </g>
                          )}
                          {i === pts.length - 1 && currentData[i]?.revenue > 0 && !selected && (
                            <>
                              <rect x={x-24} y={y-22} width="48" height="14" rx="4" fill={COLORS.mediumBlue} opacity="0.92" />
                              <text x={x} y={y-12} textAnchor="middle" fontSize="7.5" fill="white" fontFamily="monospace" fontWeight="bold">{fmtAxis(currentData[i].revenue)}</text>
                            </>
                          )}
                          <text x={x} y={H-6} textAnchor="middle" fontSize="8" fill={isDark ? '#475569' : '#94a3b8'}>{currentData[i]?.label}</text>
                        </g>
                      );
                    })}
                  </>
                );
              })()
            )}
          </svg>

          {chartPoint && (
            <div className={`mt-3 rounded-xl border p-3 flex flex-wrap items-center justify-between gap-3 ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
              <div>
                <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400">Selected period</p>
                <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{chartPoint.label}</p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400">Exact turnover</p>
                <p className="text-lg font-black" style={{ color: COLORS.mediumBlue }}>{fmtC(chartPoint.revenue)}</p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400">Collected</p>
                <p className="text-sm font-bold" style={{ color: COLORS.emeraldGreen }}>{fmtC(chartPoint.collected)}</p>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-wider font-bold text-slate-400">Invoices</p>
                <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{chartPoint.count}</p>
              </div>
              <button type="button" onClick={() => setSelectedPoint(null)} className="text-[10px] font-bold text-slate-400 hover:text-slate-600">Clear</button>
            </div>
          )}

          <div className="flex flex-wrap gap-4 text-[10px] mt-2 text-slate-400">
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block rounded-full" style={{ background: COLORS.mediumBlue }} />Revenue / Turnover</span>
            <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block rounded-full border-t-2 border-dashed" style={{ borderColor: COLORS.emeraldGreen }} />Collected</span>
            {compareEnabled && <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block border-t-2 border-dashed" style={{ borderColor: COLORS.purple }} />Prev Period</span>}
            {selectedServices.length > 0 && <span className="flex items-center gap-1.5"><span className="w-5 h-0.5 inline-block rounded-full" style={{ background: COLORS.amber }} />Selected Services</span>}
          </div>
        </div>
      )}

      {/* Comparative table */}
      {compareEnabled && currentData.length > 0 && (
        <div className={`mt-4 rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <div className={`px-4 py-2 border-b ${isDark ? 'bg-slate-700/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
            <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Month-by-Month Comparison</p>
          </div>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead><tr className={isDark ? 'bg-slate-700/30' : 'bg-slate-50/60'}>
                {['Month','Revenue','Collected','Prev Revenue','Change'].map(h => (
                  <th key={h} className={`px-3 py-2 text-left text-[9px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {currentData.map((d, i) => {
                  const prev = prevData[i];
                  const chg = prev != null ? d.revenue - prev.revenue : null;
                  return (
                    <tr key={d.month} className={`border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
                      <td className={`px-3 py-2 font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{d.label}</td>
                      <td className={`px-3 py-2 font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{fmtC(d.revenue)}</td>
                      <td className="px-3 py-2 text-emerald-600">{fmtC(d.collected)}</td>
                      <td className={`px-3 py-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{prev != null ? fmtC(prev.revenue) : '—'}</td>
                      <td className={`px-3 py-2 font-bold ${chg == null ? '' : chg >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                        {chg == null ? '—' : `${chg >= 0 ? '+' : ''}${fmtC(chg)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Service breakdown table */}
      {showServiceBreakdown && serviceBreakdown.length > 0 && (
        <div className={`mt-4 rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
          <div className={`px-4 py-2.5 border-b ${isDark ? 'bg-slate-700/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
            <p className="text-[9px] font-bold uppercase tracking-wider text-slate-400">Revenue by Service / Item — click to toggle chart highlight</p>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {serviceBreakdown.map((s, i) => {
              const pct = totalRevenue > 0 ? (s.revenue / totalRevenue) * 100 : 0;
              const isSelected = selectedServices.includes(s.description);
              return (
                <div key={s.description}
                  onClick={() => setSelectedServices(prev => prev.includes(s.description) ? prev.filter(n => n !== s.description) : [...prev, s.description])}
                  className={`flex items-center gap-3 px-4 py-2.5 border-b last:border-0 cursor-pointer transition-colors ${isSelected ? (isDark ? 'bg-emerald-900/20' : 'bg-emerald-50') : (isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50')} ${isDark ? 'border-slate-700' : 'border-slate-50'}`}>
                  <div className="w-5 h-5 rounded flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                    style={{ background: isSelected ? COLORS.emeraldGreen : `linear-gradient(135deg,${COLORS.deepBlue},${COLORS.mediumBlue})` }}>
                    {isSelected ? '✓' : i + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{s.description}</p>
                    <div className={`h-1 rounded-full mt-1 ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: `linear-gradient(90deg,${COLORS.deepBlue},${COLORS.mediumBlue})` }} />
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs font-bold" style={{ color: COLORS.mediumBlue }}>{fmtC(s.revenue)}</p>
                    <p className="text-[9px] text-slate-400">{pct.toFixed(1)}% · {s.count}×</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// PAYMENT MODAL
// ════════════════════════════════════════════════════════════════════════════════
const PaymentModal = ({ invoice, open, onClose, onSuccess, isDark }) => {
  const [form, setForm] = useState({ amount: '', payment_date: format(new Date(), 'yyyy-MM-dd'), payment_mode: 'neft', reference_no: '', notes: '' });
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [histLoading, setHistLoading] = useState(false);

  useEffect(() => {
    if (open && invoice) {
      setForm(p => ({ ...p, amount: invoice.amount_due?.toFixed(2) || '' }));
      setHistLoading(true);
      api.get('/payments', { params: { invoice_id: invoice.id } })
        .then(r => setHistory(r.data || []))
        .catch(() => setHistory([]))
        .finally(() => setHistLoading(false));
    }
  }, [open, invoice]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const amt = parseFloat(form.amount);
    if (!amt || amt <= 0) { toast.error('Enter a valid amount'); return; }
    if (amt > amountDue + 0.01) {
      if (!window.confirm(`Amount ₹${amt.toLocaleString()} exceeds balance due ₹${amountDue.toLocaleString()}. Record anyway?`)) return;
    }
    setLoading(true);
    try {
      await api.post('/payments', { invoice_id: invoice.id, amount: amt, payment_date: form.payment_date, payment_mode: form.payment_mode, reference_no: form.reference_no, notes: form.notes });
      toast.success('Payment recorded!'); onSuccess?.(); onClose();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to record payment'); }
    finally { setLoading(false); }
  };

  const quickFill = (pct) => {
    const amt = Math.round(amountDue * pct / 100 * 100) / 100;
    setForm(p => ({ ...p, amount: String(amt) }));
  };

  if (!invoice) return null;

  const enteredAmt = parseFloat(form.amount) || 0;
  const amountDue  = invoice?.amount_due || 0;
  const balanceAfter = Math.max(0, amountDue - enteredAmt);
  const isPartial = enteredAmt > 0 && enteredAmt < amountDue - 0.01;
  const isFull    = enteredAmt >= amountDue - 0.01;
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg rounded-2xl p-0 overflow-hidden">
        <DialogTitle className="sr-only">Record Payment</DialogTitle>
        <DialogDescription className="sr-only">Record payment for {invoice.invoice_no}</DialogDescription>

        {/* ── Header ── */}
        <div className="px-6 py-5" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center"><IndianRupee className="h-5 w-5 text-white" /></div>
            <div>
              <p className="text-white/60 text-[10px] uppercase tracking-widest">Record Payment</p>
              <h2 className="text-white font-bold text-lg">{invoice.invoice_no}</h2>
              <p className="text-white/50 text-xs">{invoice.client_name}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {[['Invoice Total', invoice.grand_total, 'text-white'], ['Paid So Far', invoice.amount_paid, 'text-emerald-300'], ['Balance Due', amountDue, 'text-amber-300']].map(([l, v, cls]) => (
              <div key={l} className="bg-white/10 rounded-xl px-3 py-2">
                <p className="text-white/50 text-[9px] uppercase tracking-wider">{l}</p>
                <p className={`font-bold text-sm ${cls}`}>{fmtC(v)}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="p-6 space-y-4 max-h-[65vh] overflow-y-auto">

          {/* ── Payment history ── */}
          {(histLoading || history.length > 0) && (
            <div className={`rounded-xl border p-3 ${isDark ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50/60'}`}>
              <p className={`text-[10px] font-bold uppercase tracking-widest mb-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Payment History</p>
              {histLoading ? (
                <p className="text-xs text-slate-400 py-1">Loading…</p>
              ) : (
                <div className="space-y-1.5">
                  {history.map((p, i) => (
                    <div key={p.id || i} className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{p.payment_mode || 'other'}</span>
                        <span className={`truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{p.payment_date}{p.reference_no ? ` · ${p.reference_no}` : ''}</span>
                      </div>
                      <span className={`font-bold flex-shrink-0 ml-2 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>{fmtC(p.amount)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Amount + quick-fill ── */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">Payment Amount (₹) *</label>
              <div className="relative mb-2">
                <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 font-bold text-sm">₹</span>
                <Input type="number" step="0.01" min="0.01" className="pl-8 h-11 rounded-xl" value={form.amount}
                  onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} required />
              </div>
              {/* Quick-fill buttons */}
              <div className="grid grid-cols-4 gap-2">
                {[['Full', 100], ['75%', 75], ['50%', 50], ['25%', 25]].map(([label, pct]) => (
                  <button key={label} type="button" onClick={() => quickFill(pct)}
                    className={`py-2 px-1 rounded-xl text-xs font-bold transition-all border ${
                      (pct === 100 && isFull) || (pct !== 100 && isPartial && Math.abs(enteredAmt - Math.round(amountDue*pct/100*100)/100) < 0.01)
                        ? (isDark ? 'border-blue-500 bg-blue-900/30 text-blue-300' : 'border-blue-500 bg-blue-50 text-blue-700')
                        : (isDark ? 'border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50')
                    }`}>
                    <p>{label}</p>
                    <p className={`text-[10px] font-normal mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>{fmtC(Math.round(amountDue*pct/100*100)/100)}</p>
                  </button>
                ))}
              </div>
              {/* Live balance-after indicator */}
              {enteredAmt > 0 && (
                <div className={`mt-2 flex items-center justify-between text-xs px-3 py-2 rounded-lg ${
                  isFull
                    ? (isDark ? 'bg-emerald-900/20 text-emerald-400' : 'bg-emerald-50 text-emerald-700')
                    : (isDark ? 'bg-amber-900/20 text-amber-400' : 'bg-amber-50 text-amber-700')
                }`}>
                  <span>{isFull ? '✓ Invoice will be fully paid' : `Partial — balance remaining:`}</span>
                  {!isFull && <span className="font-bold">{fmtC(balanceAfter)}</span>}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">Payment Date *</label>
                <Input type="date" className="h-11 rounded-xl" value={form.payment_date}
                  onChange={e => setForm(p => ({ ...p, payment_date: e.target.value }))} required />
              </div>
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">Payment Mode</label>
                <Select value={form.payment_mode} onValueChange={v => setForm(p => ({ ...p, payment_mode: v }))}>
                  <SelectTrigger className="h-11 rounded-xl"><SelectValue /></SelectTrigger>
                  <SelectContent>{PAY_MODES.map(m => <SelectItem key={m} value={m}>{m.toUpperCase()}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">Reference / UTR No.</label>
              <Input className="h-11 rounded-xl" placeholder="Transaction / cheque reference"
                value={form.reference_no} onChange={e => setForm(p => ({ ...p, reference_no: e.target.value }))} />
            </div>

            <div>
              <label className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block">Notes</label>
              <Textarea className="rounded-xl text-sm min-h-[60px] resize-none" value={form.notes}
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
            </div>

            <div className="flex gap-3 pt-1">
              <Button type="button" variant="ghost" onClick={onClose} className="flex-1 h-11 rounded-xl">Cancel</Button>
              <Button type="submit" disabled={loading} className="flex-1 h-11 rounded-xl text-white font-semibold"
                style={{ background: isFull ? `linear-gradient(135deg, ${COLORS.emeraldGreen}, #15803d)` : `linear-gradient(135deg, ${COLORS.amber}, #d97706)` }}>
                {loading ? 'Recording…' : isFull ? '✓ Record Full Payment' : '✓ Record Partial Payment'}
              </Button>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// INVOICE FORM
// ════════════════════════════════════════════════════════════════════════════════

// ── Memoized Item Row — prevents full InvoiceForm re-render on every keystroke ──
const ItemRow = React.memo(function ItemRow({
  item, idx, isInterstate, isDark, inputCls, labelCls,
  onUpdate, onRemove, fillFromProduct, products,
  focusedItemIdx, setFocusedItemIdx,
  dragIdx, dragOverIdx, setDragIdx, setDragOverIdx,
  reorderItems, itemCount,
  itemSuggestions,
}) {
  const comp = computeItem(item, isInterstate);
  const mem  = itemSuggestions || getItemMemory();

  // Local state so number inputs don't cause full-form re-renders while typing
  const [localQty,   setLocalQty]   = React.useState(String(item.quantity));
  const [localPrice, setLocalPrice] = React.useState(String(item.unit_price));
  const [localDisc,  setLocalDisc]  = React.useState(String(item.discount_pct));

  // Keep local state in sync when parent pushes a change (product catalog fill, etc.)
  React.useEffect(() => setLocalQty(String(item.quantity)),    [item.quantity]);
  React.useEffect(() => setLocalPrice(String(item.unit_price)), [item.unit_price]);
  React.useEffect(() => setLocalDisc(String(item.discount_pct)), [item.discount_pct]);

  const suggestions = focusedItemIdx === idx && (item.description || '').length > 1
    ? Object.values(mem).filter(m =>
        m.description.toLowerCase().includes(item.description.toLowerCase())
      ).slice(0, 5)
    : [];

  const isDragging   = dragIdx === idx;
  const isDropTarget = dragOverIdx === idx && dragIdx !== idx;

  return (
    <div
      draggable
      onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; setDragIdx(idx); }}
      onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverIdx(idx); }}
      onDrop={e => { e.preventDefault(); reorderItems(dragIdx, idx); setDragIdx(null); setDragOverIdx(null); }}
      onDragEnd={() => { setDragIdx(null); setDragOverIdx(null); }}
      className={`relative border rounded-2xl transition-all
        ${isDragging   ? 'opacity-40 scale-[0.98] shadow-inner' : ''}
        ${isDropTarget
          ? isDark ? 'border-blue-500 shadow-lg shadow-blue-900/30 bg-blue-900/10'
                   : 'border-blue-400 shadow-lg shadow-blue-100 bg-blue-50/60'
          : isDark ? 'border-slate-700 bg-slate-800/40'
                   : 'border-slate-200 bg-slate-50/40'}`}
    >
      {isDropTarget && <div className="absolute -top-0.5 left-4 right-4 h-0.5 rounded-full bg-blue-500 shadow shadow-blue-400" />}

      {/* Header row */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <div className={`flex-shrink-0 cursor-grab active:cursor-grabbing p-1 rounded-lg transition-colors ${isDark ? 'text-slate-600 hover:text-slate-400 hover:bg-slate-700' : 'text-slate-300 hover:text-slate-500 hover:bg-slate-100'}`} title="Drag to reorder">
          <GripVertical className="h-4 w-4" />
        </div>
        <span className={`text-[10px] font-black px-2.5 py-1 rounded-full flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}># {idx + 1}</span>
        <div className="flex-1" />
        <Select value={item.product_id || '__none__'} onValueChange={v => fillFromProduct(idx, v)}>
          <SelectTrigger className="h-7 w-36 text-[10px] rounded-lg border-dashed flex-shrink-0"><SelectValue placeholder="From catalog" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__">— From catalog —</SelectItem>
            {(products || []).map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
        {itemCount > 1 && (
          <button type="button" onClick={() => onRemove(idx)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors flex-shrink-0" title="Remove item">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="px-3 pb-3 space-y-3">
        {/* Row 1: Description, HSN, Qty, Unit */}
        <div className="grid grid-cols-6 gap-3">
          <div className="col-span-6 md:col-span-3 relative">
            <label className={labelCls}>Description *</label>
            <Input className={inputCls} placeholder="Item / Service description"
              value={item.description}
              onChange={e => onUpdate(idx, 'description', e.target.value)}
              onFocus={() => setFocusedItemIdx(idx)}
              onBlur={() => setTimeout(() => setFocusedItemIdx(f => f === idx ? -1 : f), 160)}
            />
            {suggestions.length > 0 && (
              <div className={`absolute z-20 w-full mt-1 rounded-xl border shadow-xl overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
                <div className={`px-3 py-1.5 border-b text-[9px] font-bold uppercase tracking-wider ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>Suggestions from past invoices</div>
                {suggestions.map(s => (
                  <button key={s.description} type="button" onMouseDown={e => e.preventDefault()}
                    onClick={() => {
                      onUpdate(idx, 'description', s.description);
                      onUpdate(idx, 'unit_price',  s.unit_price);
                      onUpdate(idx, 'gst_rate',    s.gst_rate);
                      onUpdate(idx, 'unit',        s.unit);
                      setFocusedItemIdx(-1);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2.5 text-xs transition-colors border-b last:border-0 ${isDark ? 'hover:bg-blue-900/30 text-slate-200 border-slate-700' : 'hover:bg-blue-50 text-slate-700 border-slate-50'}`}>
                    <span className="font-medium truncate">{s.description}</span>
                    <span className={`text-[10px] ml-2 flex-shrink-0 font-semibold ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>{fmtC(s.unit_price)} · {s.gst_rate}%</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div><label className={labelCls}>HSN/SAC</label><Input className={inputCls} placeholder="HSN" value={item.hsn_sac} onChange={e => onUpdate(idx, 'hsn_sac', e.target.value)} /></div>
          <div>
            <label className={labelCls}>Qty</label>
            <Input type="number" min="0" step="any" className={inputCls}
              value={localQty}
              onChange={e => setLocalQty(e.target.value)}
              onBlur={e => { const v = parseFloat(e.target.value) || 0; setLocalQty(String(v)); onUpdate(idx, 'quantity', v); }}
            />
          </div>
          <div>
            <label className={labelCls}>Unit</label>
            <Select value={item.unit} onValueChange={v => onUpdate(idx, 'unit', v)}>
              <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
              <SelectContent>{UNITS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>

        {/* Row 2: Price, Disc, GST, Taxable, Total */}
        <div className="grid grid-cols-5 gap-3">
          <div>
            <label className={labelCls}>Unit Price (₹)</label>
            <Input type="number" min="0" step="any" className={inputCls}
              value={localPrice}
              onChange={e => setLocalPrice(e.target.value)}
              onBlur={e => { const v = parseFloat(e.target.value) || 0; setLocalPrice(String(v)); onUpdate(idx, 'unit_price', v); }}
            />
          </div>
          <div>
            <label className={labelCls}>Disc %</label>
            <Input type="number" min="0" max="100" step="any" className={inputCls}
              value={localDisc}
              onChange={e => setLocalDisc(e.target.value)}
              onBlur={e => { const v = parseFloat(e.target.value) || 0; setLocalDisc(String(v)); onUpdate(idx, 'discount_pct', v); }}
            />
          </div>
          <div>
            <label className={labelCls}>GST %</label>
            <Select value={String(item.gst_rate)} onValueChange={v => onUpdate(idx, 'gst_rate', parseFloat(v))}>
              <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
              <SelectContent>{GST_RATES.map(r => <SelectItem key={r} value={String(r)}>{r}%</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className={labelCls}>Taxable</label>
            <div className={`h-11 px-3 rounded-xl flex items-center text-sm font-medium ${isDark ? 'bg-slate-700/50 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>{fmtC(comp.taxable_value)}</div>
          </div>
          <div>
            <label className={labelCls}>Total</label>
            <div className={`h-11 px-3 rounded-xl flex items-center text-sm font-black ${isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-700'}`}>{fmtC(comp.total_amount)}</div>
          </div>
        </div>

        {item.item_details !== undefined && (
          <div>
            <label className={labelCls}>Item Notes</label>
            <Input className={`${inputCls} text-xs`} placeholder="Optional item notes"
              value={item.item_details || ''}
              onChange={e => onUpdate(idx, 'item_details', e.target.value)}
            />
          </div>
        )}
      </div>
    </div>
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// QUICK ADD CLIENT DIALOG — inline create from inside the Invoice form
// ════════════════════════════════════════════════════════════════════════════════
const QuickAddClientDialog = ({ open, onClose, onCreated, isDark }) => {
  const QUICK_ADD_SERVICES = [
    'GST', 'Trademark', 'Income Tax', 'ROC', 'Audit', 'Compliance',
    'Company Registration', 'Tax Planning', 'Accounting', 'Payroll', 'Other'
  ];
  const blank = {
    company_name: '', client_type: 'proprietor',
    gstin: '', pan: '', email: '', phone: '',
    address: '', city: '', state: '', pincode: '',
    msme_number: '', referred_by: '', services: [],
    contact_persons: [{ name: '', email: '', phone: '', designation: '' }],
  };
  const [data, setData] = useState(blank);
  const [saving, setSaving] = useState(false);

  // ── Smart Document Import state ──
  const [smartFiles, setSmartFiles]       = useState({ gst: null, udyam: null, mca: null });
  const [smartLoading, setSmartLoading]   = useState(false);
  const [smartError, setSmartError]       = useState('');
  const [smartExtracted, setSmartExtracted] = useState(false); // shows success badge

  useEffect(() => {
    if (open) {
      setData(blank);
      setSmartFiles({ gst: null, udyam: null, mca: null });
      setSmartLoading(false);
      setSmartError('');
      setSmartExtracted(false);
    }
  // eslint-disable-next-line
  }, [open]);

  const setField = (k, v) => setData(p => ({ ...p, [k]: v }));

  // ── Constitution map (same as Clients page) ──
  const constitutionMap = {
    proprietorship: 'proprietor', proprietor: 'proprietor', 'sole proprietorship': 'proprietor',
    'private limited': 'pvt_ltd', 'private limited company': 'pvt_ltd', pvt_ltd: 'pvt_ltd', 'pvt ltd': 'pvt_ltd',
    llp: 'llp', 'limited liability partnership': 'llp',
    partnership: 'partnership', 'partnership firm': 'partnership',
    huf: 'huf', 'hindu undivided family': 'huf',
    trust: 'trust', 'public limited': 'pvt_ltd', 'public limited company': 'pvt_ltd',
  };

  // ── Extract & Fill from uploaded documents ──
  const handleExtract = async () => {
    if (!smartFiles.gst && !smartFiles.udyam && !smartFiles.mca) return;
    setSmartLoading(true);
    setSmartError('');
    setSmartExtracted(false);
    try {
      const fd = new FormData();
      if (smartFiles.gst)   fd.append('files', smartFiles.gst);
      if (smartFiles.udyam) fd.append('files', smartFiles.udyam);
      if (smartFiles.mca)   fd.append('files', smartFiles.mca);
      const res = await api.post('/clients/parse-multi-documents', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const parsed = res.data;
      const mappedConstitution = parsed.constitution && parsed.constitution !== 'other'
        ? parsed.constitution
        : constitutionMap[(parsed.constitution_raw || '').toLowerCase().trim()] || 'other';
      setData(prev => ({
        ...prev,
        company_name:  parsed.company_name || prev.company_name,
        client_type:   mappedConstitution,
        gstin:         parsed.gstin        || prev.gstin,
        pan:           parsed.pan          || prev.pan,
        email:         parsed.email        || prev.email,
        phone:         parsed.phone        || prev.phone,
        address:       parsed.address      || prev.address,
        city:          parsed.city         || prev.city,
        state:         parsed.state        || prev.state,
        msme_number:   parsed.udyam_number || prev.msme_number,
      }));
      setSmartFiles({ gst: null, udyam: null, mca: null });
      setSmartExtracted(true);
      const docTypes = parsed.doc_types_found?.join(' + ') || 'document';
      toast.success(`Data extracted from ${docTypes}! Review and save.`, { duration: 5000 });
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message || 'Failed to parse documents';
      setSmartError(msg);
      toast.error(msg);
    } finally {
      setSmartLoading(false);
    }
  };

  const handleSave = async () => {
    if (!data.company_name.trim()) { toast.error('Client / Company name is required'); return; }
    const gstin = (data.gstin || '').trim().toUpperCase();
    if (gstin && gstin.length !== 15) { toast.error('GSTIN must be 15 characters'); return; }

    setSaving(true);
    try {
      const payload = {
        company_name: data.company_name.trim(),
        client_type:  data.client_type || 'proprietor',
        email:        data.email.trim() || null,
        phone:        (data.phone || '').replace(/\D/g, '') || null,
        address:      data.address.trim() || null,
        city:         data.city.trim() || null,
        state:        data.state.trim() || null,
        pincode:      (data.pincode || '').trim() || null,
        gstin:        gstin || null,
        pan:          (data.pan || '').trim().toUpperCase() || null,
        msme_number:  (data.msme_number || '').trim() || null,
        referred_by:  (data.referred_by || '').trim() || null,
        services: data.services || [],
        contact_persons: (data.contact_persons || []).filter(cp => cp.name?.trim()),
        dsc_details: [],
        assignments: [],
        assigned_to: null,
        status: 'active',
      };
      const res = await api.post('/clients', payload);
      let created = res?.data;
      if (!created || !created.id) {
        try {
          const list = await api.get('/clients');
          const arr = list?.data || [];
          created = arr.find(c =>
            (gstin && (c.gstin || '').toUpperCase() === gstin) ||
            (c.company_name || '').toLowerCase() === payload.company_name.toLowerCase()
          ) || created;
        } catch { /* ignore */ }
      }
      if (!created || !created.id) {
        toast.error('Client saved but could not be auto-selected — please pick it from the list');
        onClose?.();
        return;
      }
      toast.success(`Client "${created.company_name}" created`);
      onCreated?.(created);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Failed to create client');
    } finally {
      setSaving(false);
    }
  };

  const inputCls = `h-10 rounded-xl text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`;
  const labelCls = `text-[10px] font-bold uppercase tracking-widest mb-1.5 block ${isDark ? 'text-slate-400' : 'text-slate-500'}`;

  const anyFile = smartFiles.gst || smartFiles.udyam || smartFiles.mca;

  // ── Drop zone sub-component ──
  const DropZone = ({ fileKey, label, sublabel, hoverColor, icon, accept }) => {
    const file = smartFiles[fileKey];
    return (
      <div
        className={`relative border-2 border-dashed rounded-xl p-3 flex flex-col items-center gap-1.5 cursor-pointer transition-all ${
          file
            ? 'border-emerald-400 bg-emerald-50/60'
            : `border-slate-200 bg-white/60 ${hoverColor}`
        }`}
        onClick={() => document.getElementById(`_qi_${fileKey}`)?.click()}
      >
        {file ? (
          <>
            <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center">
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-emerald-600"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
            </div>
            <p className="text-[10px] font-bold text-emerald-700 text-center leading-tight">{file.name.length > 18 ? file.name.slice(0, 16) + '…' : file.name}</p>
            <button type="button" onClick={e => { e.stopPropagation(); setSmartFiles(p => ({ ...p, [fileKey]: null })); }} className="text-[9px] text-red-400 hover:text-red-600 font-medium">Remove</button>
          </>
        ) : (
          <>
            <div className={`w-8 h-8 rounded-full flex items-center justify-center`} style={{ background: icon.bg }}>{icon.svg}</div>
            <p className="text-[10px] font-bold text-slate-600">{label}</p>
            <p className="text-[9px] text-slate-400">{sublabel}</p>
          </>
        )}
        <input id={`_qi_${fileKey}`} type="file" accept={accept} className="hidden"
          onChange={e => { if (e.target.files[0]) setSmartFiles(p => ({ ...p, [fileKey]: e.target.files[0] })); e.target.value = ''; }} />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && !smartLoading && onClose?.()}>
      <DialogContent className={`max-w-2xl p-0 overflow-hidden rounded-2xl ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        {/* Header */}
        <div className="px-6 py-4 text-white" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <DialogTitle className="text-lg font-bold flex items-center gap-2">
            <Plus className="h-5 w-5" /> Quick Add Client
          </DialogTitle>
          <DialogDescription className="text-white/80 text-xs mt-1">
            Add a new client without leaving this invoice. You can edit full details later from the Clients page.
          </DialogDescription>
        </div>

        <div className="max-h-[72vh] overflow-y-auto">
          {/* ── Smart Document Import Panel ── */}
          <div className={`mx-6 mt-5 mb-4 border-2 rounded-2xl p-4 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-gradient-to-br from-blue-50/80 to-indigo-50/50 border-blue-100'}`}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-8 h-8 rounded-xl flex items-center justify-center text-white flex-shrink-0 shadow-sm" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-white"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5zM6 20V4h5v7h7v9H6z"/></svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Auto-fill from Documents</p>
                <p className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Upload GST Certificate, Udyam, or MCA Master Data — form fills automatically</p>
              </div>
              {smartExtracted && (
                <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-100 border border-emerald-200">
                  <svg viewBox="0 0 24 24" className="h-3 w-3 fill-emerald-600"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
                  <span className="text-[9px] font-bold text-emerald-700">Filled!</span>
                </div>
              )}
            </div>

            {/* Drop zones */}
            <div className="grid grid-cols-3 gap-2 mb-3">
              <DropZone
                fileKey="gst" label="GST Certificate" sublabel="Form GST REG-06 PDF"
                hoverColor="hover:border-blue-400 hover:bg-blue-50/60" accept=".pdf"
                icon={{ bg: '#EFF6FF', svg: <svg viewBox="0 0 24 24" className="h-4 w-4 fill-blue-600"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 1.5L18.5 9H13V3.5z"/></svg> }}
              />
              <DropZone
                fileKey="udyam" label="Udyam Certificate" sublabel="Udyam Registration PDF"
                hoverColor="hover:border-orange-400 hover:bg-orange-50/60" accept=".pdf"
                icon={{ bg: '#FFF7ED', svg: <svg viewBox="0 0 24 24" className="h-4 w-4 fill-orange-600"><path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/></svg> }}
              />
              <DropZone
                fileKey="mca" label="MCA Master Data" sublabel="Excel (.xlsx) or MCA PDF"
                hoverColor="hover:border-violet-400 hover:bg-violet-50/60" accept=".xlsx,.xls,.pdf"
                icon={{ bg: '#F5F3FF', svg: <svg viewBox="0 0 24 24" className="h-4 w-4 fill-violet-600"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 3c1.93 0 3.5 1.57 3.5 3.5S13.93 13 12 13s-3.5-1.57-3.5-3.5S10.07 6 12 6zm7 13H5v-.23c0-.62.28-1.2.76-1.58C7.47 15.82 9.64 15 12 15s4.53.82 6.24 2.19c.48.38.76.97.76 1.58V19z"/></svg> }}
              />
            </div>

            {/* Extract button */}
            {anyFile && (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={smartLoading}
                  onClick={handleExtract}
                  className="h-8 px-4 text-xs rounded-xl text-white font-semibold shadow-sm disabled:opacity-50 flex items-center gap-1.5 transition-all"
                  style={{ background: smartLoading ? '#94a3b8' : 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
                >
                  {smartLoading ? (
                    <><div className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" /> Extracting…</>
                  ) : (
                    <><svg viewBox="0 0 24 24" className="h-3 w-3 fill-white"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg> Extract &amp; Fill</>
                  )}
                </button>
                <p className="text-[10px] text-slate-400">
                  {[smartFiles.gst && 'GST', smartFiles.udyam && 'Udyam', smartFiles.mca && 'MCA'].filter(Boolean).join(' + ')} ready
                </p>
              </div>
            )}

            {smartError && (
              <div className="mt-2 flex items-center gap-2 px-3 py-2 rounded-xl border border-red-200 bg-red-50">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-red-500 flex-shrink-0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>
                <p className="text-xs text-red-700 font-medium">{smartError}</p>
              </div>
            )}
          </div>

          {/* ── Manual Fields ── */}
          <div className="px-6 pb-5 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className={labelCls}>Client / Company Name *</label>
              <Input className={inputCls} autoFocus value={data.company_name}
                onChange={e => setField('company_name', e.target.value)} placeholder="Acme Pvt Ltd" />
            </div>
            <div>
              <label className={labelCls}>Client Type</label>
              <Select value={data.client_type} onValueChange={v => setField('client_type', v)}>
                <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="proprietor">Proprietor</SelectItem>
                  <SelectItem value="partnership">Partnership</SelectItem>
                  <SelectItem value="llp">LLP</SelectItem>
                  <SelectItem value="pvt_ltd">Private Limited</SelectItem>
                  <SelectItem value="public_ltd">Public Limited</SelectItem>
                  <SelectItem value="individual">Individual</SelectItem>
                  <SelectItem value="huf">HUF</SelectItem>
                  <SelectItem value="trust">Trust</SelectItem>
                  <SelectItem value="society">Society</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className={labelCls}>GSTIN</label>
              <Input className={inputCls} value={data.gstin}
                onChange={e => setField('gstin', e.target.value.toUpperCase())}
                placeholder="15-digit GSTIN" maxLength={15} />
            </div>
            <div>
              <label className={labelCls}>PAN</label>
              <Input className={inputCls} value={data.pan}
                onChange={e => setField('pan', e.target.value.toUpperCase())}
                placeholder="ABCDE1234F" maxLength={10} />
            </div>
            <div>
              <label className={labelCls}>MSME / Udyam No.</label>
              <Input className={inputCls} value={data.msme_number}
                onChange={e => setField('msme_number', e.target.value)}
                placeholder="UDYAM-XX-00-0000000" />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <Input type="email" className={inputCls} value={data.email}
                onChange={e => setField('email', e.target.value)} placeholder="name@company.com" />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <Input className={inputCls} value={data.phone}
                onChange={e => setField('phone', e.target.value)} placeholder="10-digit number" />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Address</label>
              <Textarea
                className={`rounded-xl text-sm min-h-[64px] resize-none ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}
                value={data.address} onChange={e => setField('address', e.target.value)} placeholder="Street, area…" />
            </div>
            <div>
              <label className={labelCls}>City</label>
              <Input className={inputCls} value={data.city} onChange={e => setField('city', e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>PIN Code <span className="text-slate-400 font-normal normal-case">(auto-fills state)</span></label>
              <Input className={`${inputCls} font-mono`} maxLength={6} placeholder="6-digit PIN"
                value={data.pincode}
                onChange={async e => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setField('pincode', digits);
                  if (digits.length === 6) {
                    const r = await lookupPincode(digits);
                    if (r?.valid) { setField('state', r.state); toast.success(`State auto-set to ${r.state}`); }
                  }
                }} />
            </div>
            <div>
              <label className={labelCls}>State</label>
              <Input className={inputCls} value={data.state} onChange={e => setField('state', e.target.value)}
                placeholder="Maharashtra, Delhi…" />
            </div>
            <div>
              <label className={labelCls}>Referred By</label>
              <Input className={inputCls} value={data.referred_by} onChange={e => setField('referred_by', e.target.value)} placeholder="Optional" />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Services</label>
              <div className="flex flex-wrap gap-2">
                {QUICK_ADD_SERVICES.map(s => {
                  const checked = (data.services || []).includes(s);
                  return (
                    <button
                      key={s} type="button"
                      onClick={() => setField('services', checked ? data.services.filter(x => x !== s) : [...(data.services || []), s])}
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-colors ${
                        checked
                          ? 'bg-blue-600 border-blue-600 text-white'
                          : isDark ? 'border-slate-600 text-slate-300 hover:border-blue-400' : 'border-slate-200 text-slate-600 hover:border-blue-300'
                      }`}
                    >{s}</button>
                  );
                })}
              </div>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Primary Contact Person <span className="text-slate-400 font-normal normal-case">(optional)</span></label>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                <Input className={inputCls} placeholder="Name" value={data.contact_persons[0]?.name || ''}
                  onChange={e => setField('contact_persons', [{ ...data.contact_persons[0], name: e.target.value }])} />
                <Input className={inputCls} placeholder="Email" value={data.contact_persons[0]?.email || ''}
                  onChange={e => setField('contact_persons', [{ ...data.contact_persons[0], email: e.target.value }])} />
                <Input className={inputCls} placeholder="Phone" value={data.contact_persons[0]?.phone || ''}
                  onChange={e => setField('contact_persons', [{ ...data.contact_persons[0], phone: e.target.value }])} />
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className={`px-6 py-4 flex items-center justify-end gap-3 border-t ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-slate-50'}`}>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving || smartLoading}
            className="h-10 px-5 text-sm rounded-xl">Cancel</Button>
          <Button type="button" onClick={handleSave} disabled={saving || smartLoading}
            className="h-10 px-6 text-sm rounded-xl text-white font-semibold gap-2"
            style={{ background: (saving || smartLoading) ? '#94a3b8' : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
            {saving ? 'Saving…' : (<><Check className="h-4 w-4" /> Save & Use</>)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const InvoiceForm = ({ open, onClose, editingInv, companies, clients, leads, onSuccess, isDark, itemSuggestions }) => {
  const navigate = useNavigate();
  const defaultForm = {
    invoice_type: 'tax_invoice', company_id: '', client_id: '', lead_id: '',
    invoice_no: '',
    client_name: '', client_address: '', client_email: '', client_phone: '', client_gstin: '', client_state: '',
    // PIN-driven place-of-supply automation (frontend/src/lib/pincode.js) —
    // typing a 6-digit client PIN auto-fills client_state/client_state_code
    // and, together with supply_pincode/supply_state_code from Invoice
    // Settings, auto-decides CGST+SGST vs IGST.
    client_pincode: '', client_state_code: '',
    invoice_date: format(new Date(), 'yyyy-MM-dd'),
    due_date: '',  // intentionally empty — user sets this manually or via quick-fill buttons
    supply_state: '', supply_state_code: '', supply_pincode: '', is_interstate: false,
    items: [emptyItem()],
    gst_rate: 18, discount_amount: 0, shipping_charges: 0, other_charges: 0,
    advance_received: 0, partial_payment: 0,
    payment_terms: 'Due on receipt', notes: '', terms_conditions: '', reference_no: '',
    is_recurring: false, recurrence_pattern: 'monthly', status: 'draft',
    invoice_template: 'prestige', invoice_theme: 'classic_blue', invoice_custom_color: '#0D3B66',
  };

  // ── useState ──
  const [form, setForm] = useState(defaultForm);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('details');
  const [products, setProducts] = useState([]);
  const [focusedItemIdx, setFocusedItemIdx] = useState(-1); // which item description is focused
  const [dragIdx, setDragIdx] = useState(null);             // which item is being dragged
  const [dragOverIdx, setDragOverIdx] = useState(null);     // which item is the drop target
  // Clients created inline via the Quick-Add dialog (augments the parent `clients` prop)
  const [localClients, setLocalClients] = useState([]);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const mergedClients = useMemo(
    () => [...(clients || []), ...localClients],
    [clients, localClients]
  );

  // ── useRef ──
  const previewRef = useRef(null);

  // ── Fetch next invoice number from backend (DB-accurate, respects Invoice Settings format) ──
  const fetchNextInvoiceNo = async (companyId, invoiceType = 'tax_invoice') => {
    if (!companyId) return '';
    try {
      const s = getInvSettings(companyId);

      // Pick the right prefix per invoice type (respects separate prefixes in settings)
      const prefixMap = {
        tax_invoice:  s.prefix               || 'INV',
        proforma:     s.proforma_prefix       || s.prefix || 'PRO',
        estimate:     s.estimate_prefix       || s.prefix || 'EST',
        credit_note:  s.credit_note_prefix    || 'CN',
        debit_note:   s.debit_note_prefix     || 'DN',
      };
      const prefix = prefixMap[invoiceType] || s.prefix || 'INV';

      const params = {
        company_id:     companyId,
        invoice_type:   invoiceType,
        prefix,
        separator:      (!s.separator || s.separator === 'none') ? '' : s.separator,
        include_fy:     s.include_fy  !== undefined ? s.include_fy  : true,
        fy_format:      s.fy_format   || 'short',
        include_month:  s.include_month !== undefined ? s.include_month : false,
        number_padding: s.number_padding || 3,
      };
      const { data } = await api.get('/invoices/next-number', { params });
      return data.invoice_no || '';
    } catch {
      return '';
    }
  };

  // ── useEffect ──
  const INV_DRAFT_KEY = 'taskosphere_invoice_add_draft';
  useEffect(() => {
    if (open) {
      if (editingInv) {
        setForm({
          ...defaultForm,
          ...editingInv,
          invoice_date: (editingInv.invoice_date || '').slice(0, 10) || format(new Date(), 'yyyy-MM-dd'),
          due_date: (editingInv.due_date || '').slice(0, 10) || '',
        });
      } else {
        // Restore draft if available — but NEVER restore invoice_no from draft
        // (it is stale: the number was reserved for a previous session and may
        //  already be in use or no longer be the next-in-sequence).
        let restoredForm = defaultForm;
        try {
          const saved = localStorage.getItem(INV_DRAFT_KEY);
          if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed?.client_name?.trim() || parsed?.items?.length > 1) {
              restoredForm = { ...defaultForm, ...parsed, invoice_no: '' };
            }
          }
        } catch { /* ignore */ }
        setForm(restoredForm);

        // If the draft already had a company selected, immediately fetch a fresh
        // invoice number so the user never sees a stale or duplicate number.
        if (restoredForm.company_id) {
          fetchNextInvoiceNo(restoredForm.company_id, restoredForm.invoice_type || 'tax_invoice')
            .then(no => { if (no) setField('invoice_no', no); })
            .catch(() => {});
        }
      }
      setActiveTab('details');
    }
  }, [open, editingInv]);

  // Save draft when form changes in add mode
  useEffect(() => {
    if (open && !editingInv) {
      try { localStorage.setItem(INV_DRAFT_KEY, JSON.stringify(form)); } catch {}
    }
  }, [form, open, editingInv]);

  useEffect(() => { api.get('/products').then(r => setProducts(r.data || [])).catch(() => {}); }, []);

  // ── useMemo ──
  const totals = useMemo(() => computeTotals(form.items, form.is_interstate, form.discount_amount, form.shipping_charges, form.other_charges), [form.items, form.is_interstate, form.discount_amount, form.shipping_charges, form.other_charges]);

  // ── useCallback ──
  const setField = useCallback((k, v) => setForm(p => ({ ...p, [k]: v })), []);

  // Auto-fill Due Date when Payment Terms is changed (only if invoice_date is set)
  const TERMS_DAYS = {
    'Due on receipt': 0, 'Due in 7 days': 7, 'Due in 15 days': 15,
    'Due in 30 days': 30, 'Due in 45 days': 45, 'Due in 60 days': 60,
    'Due in 90 days': 90,
  };
  const setPaymentTerms = useCallback((terms) => {
    setForm(p => {
      const days = TERMS_DAYS[terms];
      if (days !== undefined && p.invoice_date) {
        const base = new Date(p.invoice_date);
        base.setDate(base.getDate() + days);
        return { ...p, payment_terms: terms, due_date: format(base, 'yyyy-MM-dd') };
      }
      return { ...p, payment_terms: terms };
    });
  }, []);

  // Quick-fill due date from invoice_date + N days
  const quickFillDueDate = useCallback((days) => {
    setForm(p => {
      const base = p.invoice_date ? new Date(p.invoice_date) : new Date();
      base.setDate(base.getDate() + days);
      return { ...p, due_date: format(base, 'yyyy-MM-dd') };
    });
  }, []);
  const updateItem = useCallback((idx, k, val) => setForm(p => ({ ...p, items: p.items.map((it, i) => i !== idx ? it : { ...it, [k]: val }) })), []);
  const addItem = useCallback(() => {
    const co = (companies || []).find(c => c.id === form.company_id);
    const noGst = co?.has_gst === false;
    setForm(p => ({ ...p, items: [...p.items, { ...emptyItem(), gst_rate: noGst ? 0 : 18, cgst_rate: noGst ? 0 : 9, sgst_rate: noGst ? 0 : 9 }] }));
  }, [companies, form.company_id]);
  const removeItem = useCallback((idx) => setForm(p => ({ ...p, items: p.items.filter((_, i) => i !== idx) })), []);

  // Move item from fromIdx to toIdx (drag-and-drop reorder)
  const reorderItems = useCallback((fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    setForm(p => {
      const next = [...p.items];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      return { ...p, items: next };
    });
  }, []);

  const handleClientSelect = useCallback(async (client) => {
    if (!client) { setForm(p => ({ ...p, client_id: '', client_name: '', client_email: '', client_phone: '', client_address: '', client_state: '', client_state_code: '', client_pincode: '', client_gstin: '' })); return; }
    const addressParts = [client.address, client.city, client.state].filter(Boolean).join(', ');
    setForm(p => {
      const clientStateCode = client.state_code || '';
      // Prefer comparing GST state-codes (exact); fall back to state-name
      // string compare when a code isn't available (e.g. legacy clients
      // saved before this field existed).
      const interstate = clientStateCode && p.supply_state_code
        ? isInterState(p.supply_state_code, clientStateCode)
        : (p.supply_state ? p.supply_state.toLowerCase() !== (client.state || '').toLowerCase() : p.is_interstate);
      return {
        ...p, client_id: client.id, client_name: client.company_name || '',
        client_email: client.email || '', client_phone: client.phone || '',
        client_address: addressParts, client_state: client.state || '',
        client_state_code: clientStateCode, client_pincode: client.pincode || '',
        client_gstin: client.client_gstin || client.gstin || '',
        is_interstate: interstate === null ? p.is_interstate : interstate,
      };
    });

    // ── Auto-populate pending government fees into invoice items ────────────────
    // Only fees not already consumed by an invoice are eligible. A fee marked
    // "next billing cycle" stays out of the current invoice and becomes
    // eligible once the invoice date moves into a later calendar month.
    try {
      const [complianceRes, standaloneRes] = await Promise.all([
        api.get(`/compliance/by-client/${client.id}`, { params: { govt_fees: true } }),
        api.get('/compliance/standalone-govt-fees', { params: { client_id: client.id } }),
      ]);
      const invoiceCycle = String(form.invoice_date || format(new Date(), 'yyyy-MM')).slice(0, 7);
      const isEligible = (item) => {
        if (item.govt_fee_invoice_id) return false;
        if (!item.bill_in_next_cycle) return true;
        const deferredCycle = String(item.govt_fee_deferred_at || '').slice(0, 7);
        return !deferredCycle || invoiceCycle > deferredCycle;
      };
      const complianceItems = (complianceRes.data?.items || []).filter(
        item => Number(item.govt_fees_amount) > 0 && item.govt_fees_srn && isEligible(item)
      ).map(item => ({
        ...item,
        fee_marker: `compliance_govt_fee:${item.assignment_id}`,
        fee_title: item.name || '',
        fee_category: COMPLIANCE_CATEGORY_LABELS[item.category] || item.category || 'Compliance',
        fee_amount: Number(item.govt_fees_amount) || 0,
        fee_srn: item.govt_fees_srn || '',
      }));
      const standaloneItems = (standaloneRes.data?.items || []).filter(
        item => Number(item.amount) > 0 && isEligible(item)
      ).map(item => ({
        ...item,
        fee_marker: `standalone_govt_fee:${item.id}`,
        fee_title: item.title || 'Government fee',
        fee_category: item.category || 'OTHER',
        fee_amount: Number(item.amount) || 0,
        fee_srn: item.srn || '',
      }));
      const feeItems = [...complianceItems, ...standaloneItems];

      if (feeItems.length > 0) {
        // Build one internal, traceable invoice line per government fee.
        const newItems = feeItems.map(item => {
          const description = item.fee_title || `${item.fee_category} Govt Fees`;
          const item_details = [`${item.fee_category} Govt Fees`, item.fee_srn ? `SRN: ${item.fee_srn}` : ''].filter(Boolean).join(' | ');

          return {
            ...emptyItem(),
            product_id: item.fee_marker,
            description,
            unit_price: item.fee_amount,
            gst_rate: 0,      // Govt fees are typically not subject to GST
            cgst_rate: 0,
            sgst_rate: 0,
            igst_rate: 0,
            item_details,
          };
        });

        // Calculate total reimbursed amount → goes into advance_received
        const totalReimbursed = feeItems.reduce((sum, item) => {
          if (item.reimbursed) {
            return sum + (parseFloat(item.reimbursed_amount ?? item.fee_amount) || 0);
          }
          return sum;
        }, 0);

        setForm(p => ({
          ...p,
          // Keep manual items, but remove an auto line if the client is selected
          // twice in the same form so it cannot be duplicated by the UI.
          items: (p.items.length === 1 && !p.items[0].description && p.items[0].unit_price === 0)
            ? newItems
            : [...newItems, ...p.items.filter(it =>
                (it.description || it.unit_price > 0) &&
                !newItems.some(next => next.product_id && next.product_id === it.product_id)
              )],
          ...(totalReimbursed > 0 ? { advance_received: totalReimbursed } : {}),
        }));

        toast.success(
          `Auto-filled ${newItems.length} government fee${newItems.length > 1 ? 's' : ''}${totalReimbursed > 0 ? ` • ₹${totalReimbursed.toLocaleString('en-IN')} advance` : ''}`,
          { duration: 3000 }
        );
      } else {
        toast.success(`Auto-filled client details from "${client.company_name}"`, { duration: 1500 });
      }
    } catch (err) {
      // Compliance fetch failed — still show the basic client fill toast
      console.warn('Could not fetch compliance fees for client:', err);
      toast.success(`Auto-filled from "${client.company_name}"`, { duration: 1500 });
    }
  }, [clients, form.invoice_date]);

  const fillFromProduct = useCallback((idx, productId) => {
    if (productId === '__none__') return;
    const prod = products.find(x => x.id === productId);
    if (!prod) return;
    setForm(p => ({ ...p, items: p.items.map((it, i) => i !== idx ? it : { ...it, product_id: productId, description: prod.name, hsn_sac: prod.hsn_sac || '', unit: prod.unit || 'service', unit_price: prod.unit_price || 0, gst_rate: prod.gst_rate || 18 }) }));
  }, [products]);

  const handlePreview = useCallback(() => {
    const company = (companies || []).find(c => c.id === form.company_id) || {};
    const advance = parseFloat(form.advance_received) || 0;
    const partial = parseFloat(form.partial_payment) || 0;
    const existingPaid = parseFloat(editingInv?.amount_paid) || 0;
    const grand   = totals.grand_total || 0;
    const received = editingInv?.id ? Math.max(existingPaid, advance) + partial : advance + partial;
    const previewInv = {
      ...form,
      ...totals,                         // ensure grand_total/taxes are present
      invoice_no: form.invoice_no || editingInv?.invoice_no || 'PREVIEW-001',
      invoice_date: form.invoice_date || format(new Date(), 'yyyy-MM-dd'),
      due_date: form.due_date || format(new Date(Date.now() + 30 * 86400000), 'yyyy-MM-dd'),
      client_name: form.client_name || 'Client Name',
      advance_received: advance,
      amount_paid: received,
      amount_due:  Math.max(0, Math.round((grand - received) * 100) / 100),
    };
    const html = generateInvoiceHTML(previewInv, {
      company,
      template: form.invoice_template,
      theme: form.invoice_theme,
      customColor: form.invoice_custom_color
    });
    if (previewRef.current) {
      previewRef.current.srcdoc = html;
    }
  }, [companies, form, totals, editingInv]);

  const handleSubmit = useCallback(async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!form.company_id) { toast.error('Please select a company profile'); return; }
    if (!form.client_name?.trim()) { toast.error('Client name is required'); return; }
    if (!form.items.some(it => it.description?.trim())) { toast.error('Add at least one item'); return; }
    setLoading(true);
    try {
      // ── Apply Advance Received to amount_paid / amount_due so the saved
      //    invoice (and generated PDF) match what the popup shows.
      const advance      = parseFloat(form.advance_received) || 0;
      const grand        = totals.grand_total || 0;
      const existingPaid = parseFloat(editingInv?.amount_paid) || 0;
      // Never reduce previously-recorded payments (e.g. partial payments via /payments)
      const amountPaid   = Math.max(existingPaid, advance);
      const amountDue    = Math.max(0, Math.round((grand - amountPaid) * 100) / 100);
      const payload = {
        ...form,
        ...totals,
        advance_received: advance,
        amount_paid: amountPaid,
        amount_due:  amountDue,
      };
      let savedInvoice = null;
      if (editingInv?.id) savedInvoice = await api.put(`/invoices/${editingInv.id}`, payload);
      else if (['credit_note', 'debit_note'].includes(form.invoice_type) && form.original_invoice_id) {
        // Dedicated endpoint: links to the original invoice, posts the
        // reversing/additional journal entry, and re-derives that invoice's
        // Outstanding — none of which the generic /invoices POST does.
        const notePath = form.invoice_type === 'credit_note' ? '/credit-notes' : '/debit-notes';
        await api.post(notePath, {
          original_invoice_id: form.original_invoice_id,
          company_id: form.company_id,
          client_name: form.client_name,
          reason: form.notes?.trim() || `${form.invoice_type === 'credit_note' ? 'Credit' : 'Debit'} note against ${form.reference_no || 'invoice'}`,
          items: totals.items,
          notes: form.notes || '',
        });
        try { localStorage.removeItem(INV_DRAFT_KEY); } catch {}
      } else {
        savedInvoice = await api.post('/invoices', payload);
        try { localStorage.removeItem(INV_DRAFT_KEY); } catch {}
      }

      // Partial Payment is an actual receipt, not a display-only deduction.
      // Store it in db.payments so the existing payment journal synchronisation
      // posts Dr Cash/Bank and Cr Accounts Receivable and the accounting engine
      // immediately recalculates amount_paid / amount_due.
      const partial = Math.max(0, parseFloat(form.partial_payment) || 0);
      const savedInvoiceId = editingInv?.id || savedInvoice?.data?.id;
      if (partial > 0) {
        if (!savedInvoiceId) throw new Error('Invoice was saved but its ID was not returned; partial payment was not posted.');
        await api.post('/payments', {
          invoice_id: savedInvoiceId,
          amount: partial,
          payment_date: form.invoice_date || format(new Date(), 'yyyy-MM-dd'),
          payment_mode: 'neft',
          reference_no: '',
          notes: 'Partial payment received with invoice entry',
          payment_type: 'partial',
        });
      }

      toast.success(
        partial > 0
          ? `${editingInv?.id ? 'Invoice updated' : 'Invoice created'} and partial payment of ${fmtC(partial)} recorded`
          : (editingInv?.id ? 'Invoice updated successfully' : 'Invoice created successfully')
      );
      saveItemMemory(form.items);
      // Auto-sync client details back to the client record AND all invoices (non-fatal)
      if (form.client_id) {
        try {
          // 1. Update client record in clients DB
          const clientRecordFields = {};
          if (form.client_name)    clientRecordFields.company_name = form.client_name;
          if (form.client_gstin)   clientRecordFields.gstin        = form.client_gstin;
          if (form.client_phone)   clientRecordFields.phone        = form.client_phone.replace(/\D/g, '');
          if (form.client_email)   clientRecordFields.email        = form.client_email;
          if (form.client_address) clientRecordFields.address      = form.client_address;
          if (form.client_state)   clientRecordFields.state        = form.client_state;
          if (Object.keys(clientRecordFields).length > 0) {
            await api.put(`/clients/${form.client_id}`, clientRecordFields);
          }
          // 2. Propagate the same client details to ALL invoices for this client
          const invoiceClientFields = {};
          if (form.client_name)    invoiceClientFields.client_name    = form.client_name;
          if (form.client_gstin)   invoiceClientFields.client_gstin   = form.client_gstin;
          if (form.client_phone)   invoiceClientFields.client_phone   = form.client_phone;
          if (form.client_email)   invoiceClientFields.client_email   = form.client_email;
          if (form.client_address) invoiceClientFields.client_address = form.client_address;
          if (form.client_state)   invoiceClientFields.client_state   = form.client_state;
          if (Object.keys(invoiceClientFields).length > 0) {
            await api.patch(`/invoices/sync-client/${form.client_id}`, invoiceClientFields);
          }
        } catch { /* non-fatal */ }
      }
      onSuccess?.();
      onClose();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to save invoice'); }
    finally { setLoading(false); }
  }, [form, totals, editingInv, onSuccess, onClose]);

  const labelCls = "text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1.5 block";
  const inputCls = `h-11 rounded-xl text-sm border-slate-200 dark:border-slate-600 focus:border-blue-400 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`;
  const sectionCls = `border rounded-2xl p-5 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50/60 border-slate-100'}`;
  const tabs = [
    { id: 'details', label: 'Details', icon: FileText },
    { id: 'items', label: 'Items', icon: Package },
    { id: 'totals', label: 'Totals', icon: IndianRupee },
    { id: 'settings', label: 'Settings', icon: Layers },
    { id: 'design', label: 'Design & Preview', icon: Palette },
  ];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={`max-w-5xl max-h-[96vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 [&>button.absolute]:hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
        <DialogTitle className="sr-only">{editingInv ? 'Edit Invoice' : 'Create Invoice'}</DialogTitle>
        <DialogDescription className="sr-only">Invoice form</DialogDescription>
        <div className="sticky top-0 z-20 flex-shrink-0">
          <div className="px-7 py-5 relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
            <div className="absolute right-0 top-0 w-56 h-56 rounded-full -mr-20 -mt-20 opacity-10" style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
            <div className="relative flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center"><Receipt className="h-5 w-5 text-white" /></div>
                <div><p className="text-white/50 text-[10px] uppercase tracking-widest">{editingInv?.id ? `Edit · ${editingInv.invoice_no}` : editingInv ? 'Duplicate Document' : 'New Document'}</p><h2 className="text-white font-bold text-xl">{editingInv?.id ? 'Edit Invoice' : editingInv ? 'Duplicate Invoice' : 'Create Invoice / Estimate'}</h2></div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Select value={form.invoice_type} onValueChange={async v => {
                  setField('invoice_type', v);
                  if (form.company_id) {
                    // Always refresh when type changes: for new invoices, or if company was changed during this edit session
                    const n = await fetchNextInvoiceNo(form.company_id, v);
                    if (n) setField('invoice_no', n);
                  }
                }}>
                  <SelectTrigger className="w-44 h-9 rounded-xl border-white/20 bg-white/10 text-white text-xs font-semibold"><SelectValue /></SelectTrigger>
                  <SelectContent>{INV_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
                </Select>
                {!editingInv && (
                  <button type="button"
                    title="Clear all form data and start fresh"
                    onClick={() => {
                      if (window.confirm('Clear all form data and start fresh?')) {
                        try { localStorage.removeItem(INV_DRAFT_KEY); } catch {}
                        setForm(defaultForm);
                        setActiveTab('details');
                      }
                    }}
                    className="h-9 px-3 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors flex-shrink-0">
                    <X className="h-3 w-3" />
                    Clear
                  </button>
                )}
                <button type="button" onClick={onClose}
                  className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors">
                  <X className="h-4 w-4 text-white" />
                </button>
              </div>
            </div>
          </div>
          <div className={`flex w-full border-b ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'}`}>
            {tabs.map(t => (
              <button key={t.id} type="button" onClick={() => setActiveTab(t.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-2 py-3.5 text-xs font-semibold border-b-2 transition-all text-center min-h-[48px] h-full ${
                  activeTab === t.id
                    ? `border-blue-500 ${isDark ? 'text-blue-400 bg-blue-900/20' : 'text-blue-600 bg-blue-50/60'}`
                    : `border-transparent ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`
                }`}>
                <t.icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate sm:whitespace-normal leading-tight">{t.label}</span>
              </button>
            ))}
          </div>
        </div>
        <form className="flex-1 overflow-y-auto">
          <div className="p-7 space-y-5">
            {activeTab === 'details' && (
              <div className="space-y-5">
                <div className={sectionCls}>
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}20, ${COLORS.mediumBlue}20)` }}>
                      <FileText className="h-3.5 w-3.5" style={{ color: COLORS.mediumBlue }} />
                    </div>
                    <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Invoice Details</h3>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div>
                      <label className={labelCls}>Company Profile *</label>
                      <Select value={form.company_id} onValueChange={async v => {
                        const s = getInvSettings(v);
                        const co = (companies || []).find(c => c.id === v);
                        const prevCompanyId = form.company_id;
                        const companyChanged = prevCompanyId && prevCompanyId !== v;
                        // Fetch next invoice number when:
                        //   1. Creating a new invoice (always — to avoid stale/duplicate numbers), OR
                        //   2. Editing an existing invoice and the company changed
                        const shouldFetchNextNo = !editingInv?.id || companyChanged;
                        const nextNo = shouldFetchNextNo ? (await fetchNextInvoiceNo(v, form.invoice_type) || '') : '';
                        if (companyChanged && nextNo) {
                          toast.info(`Invoice number updated to ${nextNo} for the new company`, { duration: 3000 });
                        }
                        setForm(p => ({
                          ...p,
                          company_id: v,
                          invoice_no: shouldFetchNextNo ? nextNo : p.invoice_no,
                          supply_state:        s.supply_state        || p.supply_state,
                          supply_state_code:   s.supply_state_code   || p.supply_state_code,
                          supply_pincode:      s.supply_pincode      || p.supply_pincode,
                          notes:               s.default_notes       || p.notes,
                          terms_conditions:    s.default_terms       || p.terms_conditions,
                          invoice_template:    s.template            || p.invoice_template,
                          invoice_theme:       s.theme               || p.invoice_theme,
                          invoice_custom_color:s.custom_color        || p.invoice_custom_color,
                          items: p.items.map(it => ({
                            ...it,
                            gst_rate: co?.has_gst === false ? 0 : it.gst_rate,
                            cgst_rate: co?.has_gst === false ? 0 : it.cgst_rate,
                            sgst_rate: co?.has_gst === false ? 0 : it.sgst_rate,
                            igst_rate: co?.has_gst === false ? 0 : it.igst_rate,
                          })),
                        }));
                      }}>
                        <SelectTrigger className={`${inputCls} ${!form.company_id ? 'border-amber-300 dark:border-amber-600' : ''}`}>
                          <SelectValue placeholder="— Select company profile —" />
                        </SelectTrigger>
                        <SelectContent>{(companies || []).map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                      </Select>
                      {!form.company_id && <p className="text-[10px] text-amber-500 mt-1">⚠ Required to generate invoice</p>}
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className={labelCls + " mb-0"}>Invoice Number *</label>
                        {form.company_id && !editingInv?.id && (
                          <button type="button"
                            onClick={async () => setField('invoice_no', await fetchNextInvoiceNo(form.company_id, form.invoice_type) || '')}
                            className="text-[10px] font-semibold text-blue-500 hover:text-blue-400 transition-colors flex items-center gap-1">
                            <RefreshCw className="h-2.5 w-2.5" /> Auto
                          </button>
                        )}
                      </div>
                      <Input className={`${inputCls} font-mono`}
                        placeholder="e.g. INV-2024-001"
                        value={form.invoice_no || ''}
                        onChange={e => setField('invoice_no', e.target.value)} />
                      <p className={`text-[10px] mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>Editable — auto-filled from settings</p>
                    </div>
                    <div>
                      <label className={labelCls}>Reference No. <span className="text-slate-400 font-normal normal-case">(PO / Order no.)</span></label>
                      <Input className={inputCls} placeholder="e.g. PO-2024-001" value={form.reference_no} onChange={e => setField('reference_no', e.target.value)} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Invoice Date *</label>
                      <Input type="date" className={inputCls} value={form.invoice_date} onChange={e => setField('invoice_date', e.target.value)} />
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className={labelCls + " mb-0"}>Due Date <span className={`font-normal normal-case ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>(optional)</span></label>
                        {form.due_date && (
                          <button type="button" onClick={() => setField('due_date', '')}
                            className="text-[10px] text-slate-400 hover:text-red-400 transition-colors">✕ Clear</button>
                        )}
                      </div>
                      <Input type="date" className={inputCls} value={form.due_date}
                        onChange={e => setField('due_date', e.target.value)}
                        placeholder="dd-mm-yyyy" />
                      {/* Quick-fill shortcuts */}
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Quick set:</span>
                        {[['0d', 0, 'On receipt'], ['7d', 7, '+7'], ['15d', 15, '+15'], ['30d', 30, '+30'], ['45d', 45, '+45'], ['60d', 60, '+60']].map(([key, days, lbl]) => (
                          <button key={key} type="button" onClick={() => quickFillDueDate(days)}
                            className={`text-[10px] font-semibold px-2 py-0.5 rounded-md transition-colors ${
                              isDark ? 'bg-slate-700 text-slate-300 hover:bg-blue-900/40 hover:text-blue-300' : 'bg-slate-100 text-slate-600 hover:bg-blue-50 hover:text-blue-600'
                            }`}>{lbl}</button>
                        ))}
                      </div>
                      <p className={`text-[10px] mt-1 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>
                        Tip: selecting a Payment Term below auto-fills this date
                      </p>
                    </div>
                  </div>
                </div>
                <div className={sectionCls}>
                  <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `${COLORS.emeraldGreen}20` }}>
                        <Users className="h-3.5 w-3.5" style={{ color: COLORS.emeraldGreen }} />
                      </div>
                      <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Client Details</h3>
                    </div>
                    {form.client_name && (
                      <span className={`text-[10px] font-semibold px-2.5 py-1 rounded-full ${isDark ? 'bg-emerald-900/30 text-emerald-400' : 'bg-emerald-50 text-emerald-600'}`}>
                        ✓ Client selected
                      </span>
                    )}
                  </div>
                  <div className="mb-4">
                    <label className={labelCls}>Search & Select Client <span className={`font-normal normal-case ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>— auto-fills fields below</span></label>
                    <ClientSearchCombobox
                      clients={mergedClients}
                      value={form.client_id}
                      onSelect={handleClientSelect}
                      onAddNew={() => setQuickAddOpen(true)}
                      isDark={isDark}
                    />
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div><label className={labelCls}>Client / Company Name *</label><Input className={inputCls} placeholder="Client name" value={form.client_name} onChange={e => setField('client_name', e.target.value)} /></div>
                    <div><label className={labelCls}>GSTIN</label><Input className={inputCls} placeholder="15-digit GSTIN" value={form.client_gstin} onChange={e => setField('client_gstin', e.target.value.toUpperCase())} /></div>
                    <div><label className={labelCls}>Email</label><Input type="email" className={inputCls} value={form.client_email} onChange={e => setField('client_email', e.target.value)} /></div>
                    <div><label className={labelCls}>Phone</label><Input className={inputCls} value={form.client_phone} onChange={e => setField('client_phone', e.target.value)} /></div>
                    <div className="md:col-span-2"><label className={labelCls}>Billing Address</label><Textarea className={`rounded-xl text-sm min-h-[72px] resize-none ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} value={form.client_address} onChange={e => setField('client_address', e.target.value)} /></div>
                    <div>
                      <label className={labelCls}>Client PIN Code <span className="text-slate-400 font-normal normal-case">(auto-fills state)</span></label>
                      <Input className={`${inputCls} font-mono`} placeholder="6-digit PIN" maxLength={6}
                        value={form.client_pincode}
                        onChange={async e => {
                          const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                          setField('client_pincode', digits);
                          if (digits.length === 6) {
                            const r = await lookupPincode(digits);
                            if (r?.valid) {
                              setForm(p => {
                                const interstate = r.state_code && p.supply_state_code
                                  ? isInterState(p.supply_state_code, r.state_code)
                                  : (p.supply_state ? p.supply_state.toLowerCase() !== r.state.toLowerCase() : p.is_interstate);
                                return { ...p, client_state: r.state, client_state_code: r.state_code || '', is_interstate: interstate === null ? p.is_interstate : interstate };
                              });
                              toast.success(`Place of Supply auto-set to ${r.state}`);
                            }
                          }
                        }} />
                    </div>
                    <div><label className={labelCls}>Client State</label><Input className={inputCls} placeholder="Maharashtra, Delhi…" value={form.client_state} onChange={e => { setField('client_state', e.target.value); setField('client_state_code', ''); }} /></div>
                    <div>
                      <label className={labelCls}>Your Company PIN Code <span className="text-slate-400 font-normal normal-case">(auto-fills your state)</span></label>
                      <Input className={`${inputCls} font-mono`} placeholder="6-digit PIN" maxLength={6}
                        value={form.supply_pincode}
                        onChange={async e => {
                          const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                          setField('supply_pincode', digits);
                          if (digits.length === 6) {
                            const r = await lookupPincode(digits);
                            if (r?.valid) {
                              setForm(p => {
                                const interstate = r.state_code && p.client_state_code
                                  ? isInterState(r.state_code, p.client_state_code)
                                  : (p.client_state ? r.state.toLowerCase() !== p.client_state.toLowerCase() : p.is_interstate);
                                return { ...p, supply_state: r.state, supply_state_code: r.state_code || '', is_interstate: interstate === null ? p.is_interstate : interstate };
                              });
                              toast.success(`Your Supply State auto-set to ${r.state}`);
                            }
                          }
                        }} />
                    </div>
                    <div><label className={labelCls}>Your Supply State</label><Input className={inputCls} placeholder="Your state" value={form.supply_state} onChange={e => { setField('supply_state', e.target.value); setField('supply_state_code', ''); if (form.client_state) setField('is_interstate', e.target.value.toLowerCase() !== form.client_state.toLowerCase()); }} /></div>
                  </div>
                  <div className="flex items-center gap-3 mt-4 p-3 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 dark:bg-amber-900/10 dark:border-amber-700">
                    <Switch checked={form.is_interstate} onCheckedChange={v => setField('is_interstate', v)} />
                    <div>
                      <p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Interstate Supply (IGST)</p>
                      <p className="text-xs text-slate-400">{form.is_interstate ? 'IGST applies — inter-state transaction' : 'CGST + SGST applies — intra-state transaction'}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'items' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `${COLORS.mediumBlue}20` }}>
                      <Package className="h-3.5 w-3.5" style={{ color: COLORS.mediumBlue }} />
                    </div>
                    <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Line Items</h3>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>{form.items.length}</span>
                  </div>
                  <Button type="button" size="sm" onClick={addItem} className="h-8 px-3 text-xs rounded-xl text-white gap-1.5" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}><Plus className="h-3.5 w-3.5" /> Add Item</Button>
                </div>
                {form.items.map((item, idx) => (
                  <ItemRow
                    key={idx}
                    item={item}
                    idx={idx}
                    isInterstate={form.is_interstate}
                    isDark={isDark}
                    inputCls={inputCls}
                    labelCls={labelCls}
                    onUpdate={updateItem}
                    onRemove={removeItem}
                    fillFromProduct={fillFromProduct}
                    products={products}
                    focusedItemIdx={focusedItemIdx}
                    setFocusedItemIdx={setFocusedItemIdx}
                    dragIdx={dragIdx}
                    dragOverIdx={dragOverIdx}
                    setDragIdx={setDragIdx}
                    setDragOverIdx={setDragOverIdx}
                    reorderItems={reorderItems}
                    itemCount={form.items.length}
                    itemSuggestions={itemSuggestions}
                  />
                ))}
                <Button type="button" variant="outline" onClick={addItem} className="w-full h-10 rounded-xl border-dashed text-xs gap-2"><Plus className="h-3.5 w-3.5" /> Add Another Item</Button>
              </div>
            )}
            {activeTab === 'totals' && (
              <div className="space-y-5">
                <div className={sectionCls}>
                  <div className="flex items-center gap-2 mb-4">
                    <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: `${COLORS.amber}20` }}>
                      <IndianRupee className="h-3.5 w-3.5" style={{ color: COLORS.amber }} />
                    </div>
                    <h3 className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Additional Charges</h3>
                  </div>
                  <div className="grid grid-cols-3 gap-4">
                    <div><label className={labelCls}>Discount (₹)</label><Input type="number" min="0" step="any" className={inputCls} value={form.discount_amount} onChange={e => setField('discount_amount', parseFloat(e.target.value) || 0)} /></div>
                    <div><label className={labelCls}>Shipping (₹)</label><Input type="number" min="0" step="any" className={inputCls} value={form.shipping_charges} onChange={e => setField('shipping_charges', parseFloat(e.target.value) || 0)} /></div>
                    <div><label className={labelCls}>Other Charges (₹)</label><Input type="number" min="0" step="any" className={inputCls} value={form.other_charges} onChange={e => setField('other_charges', parseFloat(e.target.value) || 0)} /></div>
                  </div>
                  <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Existing advance receipt */}
                    <div className={`p-4 rounded-xl border-2 border-dashed ${isDark ? 'border-emerald-700/50 bg-emerald-900/10' : 'border-emerald-200 bg-emerald-50/50'}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-5 h-5 rounded-md bg-emerald-500/20 flex items-center justify-center"><IndianRupee className="h-3 w-3 text-emerald-600" /></div>
                        <label className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>Advance Received from Client</label>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="relative flex-1"><span className={`absolute left-3 top-1/2 -translate-y-1/2 font-bold text-sm ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>₹</span><Input type="number" min="0" step="any" className={`${inputCls} pl-7`} placeholder="0.00" value={form.advance_received || ''} onChange={e => setField('advance_received', parseFloat(e.target.value) || 0)} /></div>
                        <div className="flex gap-1.5">
                          {[25, 50, 75, 100].map(pct => (
                            <button key={pct} type="button"
                              onClick={() => setField('advance_received', Math.round(totals.grand_total * pct / 100 * 100) / 100)}
                              className={`text-[10px] font-bold px-2.5 py-1.5 rounded-lg transition-colors ${isDark ? 'bg-slate-700 text-slate-300 hover:bg-emerald-900/40 hover:text-emerald-300' : 'bg-slate-100 text-slate-600 hover:bg-emerald-100 hover:text-emerald-700'}`}>
                              {pct}%
                            </button>
                          ))}
                        </div>
                      </div>
                      {(form.advance_received || 0) > 0 && (
                        <p className={`text-xs mt-2 font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>
                          Balance after advance: {fmtC(Math.max(0, totals.grand_total - (form.advance_received || 0)))}
                        </p>
                      )}
                    </div>

                    {/* New partial receipt — this is posted to db.payments and therefore the Party Ledger */}
                    <div className={`p-4 rounded-xl border-2 border-dashed ${isDark ? 'border-blue-700/50 bg-blue-900/10' : 'border-blue-200 bg-blue-50/50'}`}>
                      <div className="flex items-center gap-2 mb-3">
                        <div className="w-5 h-5 rounded-md bg-blue-500/20 flex items-center justify-center"><IndianRupee className="h-3 w-3 text-blue-600" /></div>
                        <label className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>Partial Payment</label>
                      </div>
                      <div className="relative">
                        <span className={`absolute left-3 top-1/2 -translate-y-1/2 font-bold text-sm ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>₹</span>
                        <Input type="number" min="0" step="any" className={`${inputCls} pl-7`} placeholder="Enter payment received" value={form.partial_payment || ''} onChange={e => setField('partial_payment', parseFloat(e.target.value) || 0)} />
                      </div>
                      {(form.partial_payment || 0) > 0 && (
                        <p className={`text-xs mt-2 font-medium ${isDark ? 'text-blue-400' : 'text-blue-700'}`}>
                          New receipt: {fmtC(form.partial_payment)} · Remaining after receipt: {fmtC(Math.max(0, totals.grand_total - (form.advance_received || 0) - (form.partial_payment || 0)))}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
                <div className={`${sectionCls} space-y-2`}>
                  <h3 className={`text-sm font-semibold mb-4 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Invoice Summary</h3>
                  {[
                    ['Subtotal', fmtC(totals.subtotal)],
                    ['Total Discount', `− ${fmtC(totals.total_discount)}`],
                    ['Taxable Value', fmtC(totals.total_taxable)],
                    form.is_interstate ? ['IGST', fmtC(totals.total_igst)] : null,
                    !form.is_interstate ? ['CGST', fmtC(totals.total_cgst)] : null,
                    !form.is_interstate ? ['SGST', fmtC(totals.total_sgst)] : null,
                    ['Total GST', fmtC(totals.total_gst)],
                    ['Shipping', fmtC(form.shipping_charges)],
                    ['Other Charges', fmtC(form.other_charges)],
                  ].filter(Boolean).map(([label, val]) => (
                    <div key={label} className="flex justify-between text-sm py-1.5 border-b border-dashed border-slate-200 dark:border-slate-700">
                      <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>{label}</span>
                      <span className={`font-medium ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{val}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-base font-bold pt-3">
                    <span className={isDark ? 'text-slate-100' : 'text-slate-900'}>Grand Total</span>
                    <span style={{ color: COLORS.mediumBlue }}>{fmtC(totals.grand_total)}</span>
                  </div>
                  {((form.advance_received || 0) > 0 || (form.partial_payment || 0) > 0) && (<>
                    {(form.advance_received || 0) > 0 && (
                      <div className="flex justify-between text-sm py-1.5 border-b border-dashed border-emerald-200 dark:border-emerald-800">
                        <span className={`font-medium ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>− Advance Received</span>
                        <span className={`font-semibold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>− {fmtC(form.advance_received)}</span>
                      </div>
                    )}
                    {(form.partial_payment || 0) > 0 && (
                      <div className="flex justify-between text-sm py-1.5 border-b border-dashed border-blue-200 dark:border-blue-800">
                        <span className={`font-medium ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>− Partial Payment</span>
                        <span className={`font-semibold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>− {fmtC(form.partial_payment)}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-base font-bold pt-2">
                      <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>Balance Due</span>
                      <span className={isDark ? 'text-amber-300' : 'text-amber-700'}>{fmtC(Math.max(0, totals.grand_total - (form.advance_received||0) - (form.partial_payment||0)))}</span>
                    </div>
                  </>)}
                </div>
                <div className={sectionCls}>
                  <h3 className={`text-sm font-semibold mb-4 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Payment Terms</h3>
                  <Select value={form.payment_terms} onValueChange={setPaymentTerms}>
                    <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {['Due on receipt','Due in 7 days','Due in 15 days','Due in 30 days','Due in 45 days','Due in 60 days','Due in 90 days','Advance payment'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className={`text-[10px] mt-1.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Changing this will auto-update the Due Date field</p>
                  <div className="mt-4">
                    <Select value={form.status} onValueChange={v => setField('status', v)}>
                      <SelectTrigger className={inputCls}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(STATUS_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            )}
            {activeTab === 'settings' && (
              <div className="space-y-5">
                <div className={sectionCls}>
                  <h3 className={`text-sm font-semibold mb-4 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Notes & Terms</h3>
                  <div className="space-y-4">
                    {[['Notes (shown on invoice)', 'notes'], ['Terms & Conditions', 'terms_conditions']].map(([label, key]) => (
                      <div key={key}><label className={labelCls}>{label}</label><Textarea className={`rounded-xl text-sm min-h-[80px] resize-none ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`} value={form[key]} onChange={e => setField(key, e.target.value)} /></div>
                    ))}
                  </div>
                </div>
                <div className={sectionCls}>
                  <h3 className={`text-sm font-semibold mb-4 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Recurring Settings</h3>
                  <div className="flex items-center gap-3 mb-4"><Switch checked={form.is_recurring} onCheckedChange={v => setField('is_recurring', v)} /><div><p className={`text-sm font-semibold ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>Enable Recurring Invoice</p><p className="text-xs text-slate-400">Auto-generate new invoice on schedule</p></div></div>
                  {form.is_recurring && (
                    <div className="grid grid-cols-2 gap-4">
                      <div><label className={labelCls}>Recurrence Pattern</label><Select value={form.recurrence_pattern} onValueChange={v => setField('recurrence_pattern', v)}><SelectTrigger className={inputCls}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="monthly">Monthly</SelectItem><SelectItem value="quarterly">Quarterly</SelectItem><SelectItem value="yearly">Yearly</SelectItem></SelectContent></Select></div>
                      <div><label className={labelCls}>Recurrence End Date</label><Input type="date" className={inputCls} value={form.recurrence_end || ''} onChange={e => setField('recurrence_end', e.target.value)} /></div>
                    </div>
                  )}
                </div>
              </div>
            )}
            {activeTab === 'design' && (
              <div className="space-y-5">
                <div className={sectionCls}>
                  <h3 className={`text-sm font-semibold mb-4 flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}><Layout className="h-4 w-4" /> Invoice Template</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    {INVOICE_TEMPLATES.map(t => (
                      <button key={t.id} type="button" onClick={() => setField('invoice_template', t.id)}
                        className={`relative p-4 rounded-xl border-2 text-left transition-all hover:shadow-md ${form.invoice_template === t.id ? 'border-blue-500 shadow-md' : (isDark ? 'border-slate-600 hover:border-slate-500' : 'border-slate-200 hover:border-slate-300')}`}>
                        {form.invoice_template === t.id && <div className="absolute top-2 right-2 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center"><Check className="h-3 w-3 text-white" /></div>}
                        {t.badge && <span className="inline-block text-[9px] font-bold px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 mb-2">{t.badge}</span>}
                        <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{t.name}</p>
                        <p className={`text-[10px] mt-1 leading-relaxed ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{t.desc}</p>
                      </button>
                    ))}
                  </div>
                </div>
                <div className={sectionCls}>
                  <h3 className={`text-sm font-semibold mb-4 flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}><Palette className="h-4 w-4" /> Color Theme</h3>
                  <div className="grid grid-cols-4 md:grid-cols-8 gap-3">
                    {COLOR_THEMES.map(theme => (
                      <button key={theme.id} type="button" onClick={() => setField('invoice_theme', theme.id)}
                        className={`flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 transition-all ${form.invoice_theme === theme.id ? 'border-blue-500 shadow-md' : (isDark ? 'border-slate-600 hover:border-slate-500' : 'border-slate-200 hover:border-slate-300')}`}>
                        <div className="relative w-8 h-8 rounded-lg overflow-hidden flex-shrink-0"><div className="absolute inset-0" style={{ background: theme.primary }} /><div className="absolute bottom-0 right-0 w-4 h-4" style={{ background: theme.secondary }} />{form.invoice_theme === theme.id && <div className="absolute inset-0 flex items-center justify-center bg-black/30"><Check className="h-3 w-3 text-white" /></div>}</div>
                        <p className={`text-[9px] font-semibold text-center leading-tight ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{theme.name}</p>
                      </button>
                    ))}
                    <div className="flex flex-col items-center gap-1.5 p-2 rounded-xl border-2 border-dashed border-slate-300 dark:border-slate-600">
                      <label className="cursor-pointer"><div className="w-8 h-8 rounded-lg overflow-hidden border border-slate-300"><input type="color" value={form.invoice_custom_color} onChange={e => { setField('invoice_custom_color', e.target.value); setField('invoice_theme', 'custom'); }} className="w-12 h-12 -ml-1 -mt-1 cursor-pointer border-0 p-0" /></div></label>
                      <p className={`text-[9px] font-semibold text-center leading-tight ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>Custom</p>
                    </div>
                  </div>
                </div>
                <div className={sectionCls}>
                  <div className="flex items-center justify-between mb-4">
                    <h3 className={`text-sm font-semibold flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-800'}`}><Eye className="h-4 w-4" /> Live Preview</h3>
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="outline" onClick={handlePreview} className="h-8 px-3 text-xs rounded-xl gap-1.5">
                        <Eye className="h-3.5 w-3.5" /> Preview
                      </Button>
                      <Button type="button" size="sm" variant="outline"
                        onClick={() => {
                          const company = (companies || []).find(c => c.id === form.company_id) || {};
                          const previewInv = {
                            ...form,
                            invoice_no: form.invoice_no || editingInv?.invoice_no || 'PREVIEW-001',
                            invoice_date: form.invoice_date || format(new Date(), 'yyyy-MM-dd'),
                            due_date: form.due_date || format(new Date(Date.now() + 30 * 86400000), 'yyyy-MM-dd'),
                            client_name: form.client_name || 'Client Name'
                          };
                          const html = generateInvoiceHTML(previewInv, {
                            company,
                            template: form.invoice_template,
                            theme: form.invoice_theme,
                            customColor: form.invoice_custom_color
                          });
                          const blob = new Blob([html], { type: 'text/html' });
                          const url = URL.createObjectURL(blob);
                          const win = window.open(url, '_blank');
                          win.onload = () => win.print();
                        }}
                        className="h-8 px-3 text-xs rounded-xl gap-1.5"><Printer className="h-3.5 w-3.5" /> Open Print Preview</Button>
                    </div>
                  </div>
                  <div className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-600' : 'border-slate-200'}`} style={{ height: 600 }}>
                    <iframe
                      ref={previewRef}
                      className="w-full h-[600px] border rounded-xl bg-white"
                      title="Invoice Preview"
                      sandbox="allow-scripts"
                    />
                  </div>
                  <p className={`text-[10px] mt-2 text-center ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    Click <strong>Preview</strong> to load the invoice in the iframe below.<br />
                    Use "Open Print Preview" to open in a new tab for printing/saving as PDF.
                  </p>
                </div>
              </div>
            )}
          </div>
        </form>
        <div className={`flex-shrink-0 flex items-center justify-between gap-3 px-7 py-4 border-t ${isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'}`}>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose} className="h-10 px-5 text-sm rounded-xl text-slate-500">Cancel</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setActiveTab('design')} className="h-10 px-4 text-xs rounded-xl gap-1.5 border-purple-200 text-purple-600 hover:bg-purple-50"><Palette className="h-3.5 w-3.5" /> Design & Preview</Button>
          </div>
          <div className="flex items-center gap-3">
            {totals.grand_total > 0 && (<span className={`text-sm font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Total: <span style={{ color: COLORS.mediumBlue }}>{fmtC(totals.grand_total)}</span></span>)}
            {activeTab !== 'design' ? (
              <Button type="button" onClick={() => { const order = ['details', 'items', 'totals', 'settings', 'design']; const next = order[order.indexOf(activeTab) + 1]; if (next) setActiveTab(next); }}
                className="h-10 px-7 text-sm rounded-xl text-white font-semibold shadow-sm gap-2" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>Next <ChevronRight className="h-4 w-4" /></Button>
            ) : (
              <Button type="button" onClick={handleSubmit} disabled={loading} className="h-10 px-7 text-sm rounded-xl text-white font-semibold shadow-sm" style={{ background: loading ? '#94a3b8' : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>{loading ? 'Saving…' : editingInv ? '✓ Update Invoice' : '✓ Create Invoice'}</Button>
            )}
          </div>
        </div>
      </DialogContent>
      <QuickAddClientDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        isDark={isDark}
        onCreated={(newClient) => {
          setLocalClients(prev => [...prev, newClient]);
          handleClientSelect(newClient);
          setQuickAddOpen(false);
        }}
      />
    </Dialog>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// INVOICE DETAIL PANEL
// ════════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════════
// EMAIL PREVIEW MODAL
// ════════════════════════════════════════════════════════════════════════════════
const InvoicePreviewModal = ({ open, onClose, invoice, previewHtml, isDark }) => {
  if (!invoice) return null;
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        hideClose
        className={`max-w-2xl max-h-[92vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 [&>button.absolute]:hidden ${
          isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
        }`}
      >
        <DialogTitle className="sr-only">Invoice Preview</DialogTitle>
        <DialogDescription className="sr-only">Preview invoice</DialogDescription>

        {/* HEADER */}
        <div
          className="px-7 py-5 relative overflow-hidden flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #0D3B66, #1565C0)' }}
        >
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
                <Eye className="h-5 w-5 text-white" />
              </div>
              <div>
                <p className="text-white font-bold text-lg">Invoice Preview</p>
                <p className="text-white/60 text-sm mt-0.5">{invoice.invoice_no} · {invoice.client_name}</p>
                <p className="text-white/40 text-xs mt-0.5">{invoice.invoice_date}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* PREVIEW LABEL */}
        <div className={`px-7 py-2.5 flex-shrink-0 border-b text-xs font-semibold uppercase tracking-widest ${
          isDark ? 'bg-slate-700/50 border-slate-700 text-slate-400' : 'bg-slate-50 border-slate-100 text-slate-500'
        }`}>
          Invoice Preview
        </div>

        {/* INVOICE IFRAME */}
        <div className="flex-1 overflow-hidden">
          <iframe
            srcDoc={previewHtml}
            title="Invoice Preview"
            className="w-full h-full border-0"
            style={{ minHeight: '420px' }}
          />
        </div>

        {/* FOOTER */}
        <div className={`flex-shrink-0 flex items-center justify-end gap-3 px-7 py-4 border-t ${
          isDark ? 'border-slate-700 bg-slate-800' : 'border-slate-100 bg-white'
        }`}>
          <Button variant="outline" size="sm" onClick={onClose} className="rounded-xl h-9 px-4 text-xs">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

const InvoiceDetailPanel = ({
  invoice,
  open,
  onClose,
  onPayment,
  onEdit,
  onDelete,
  onDownloadPdf,
  onSendEmail,
  onWhatsApp,
  onPreview,
  onDuplicate,
  onSaleReturn,
  isDark,
  companies // ✅ REQUIRED for DriveUploadBtn
}) => {
  const [payments, setPayments] = useState([]);
  const [statusHistory, setStatusHistory] = useState([]);

  useEffect(() => {
    if (open && invoice) {
      api.get('/payments', { params: { invoice_id: invoice.id } })
        .then(r => setPayments(r.data || []))
        .catch(() => setPayments([]));
      // Fetch full invoice to get status_history
      api.get(`/invoices/${invoice.id}`)
        .then(r => setStatusHistory(r.data?.status_history || []))
        .catch(() => setStatusHistory([]));
    }
  }, [open, invoice?.id]);

  if (!invoice) return null;

  const meta = getStatusMeta(invoice);
  const isInterstate = invoice.is_interstate;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent
        hideClose
        className={`max-w-2xl max-h-[92vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 [&>button.absolute]:hidden ${
          isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'
        }`}
      >
        <DialogTitle className="sr-only">Invoice Detail</DialogTitle>
        <DialogDescription className="sr-only">
          Invoice details
        </DialogDescription>

        {/* HEADER */}
        <div
          className="px-7 py-5 relative overflow-hidden flex-shrink-0"
          style={{
            background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})`
          }}
        >
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center">
                <Receipt className="h-5 w-5 text-white" />
              </div>

              <div>
                <div className="flex items-center gap-2 mb-0.5">
                  <p className="text-white font-bold text-lg">
                    {invoice.invoice_no}
                  </p>
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${meta.bg} ${meta.text}`}
                  >
                    {meta.label}
                  </span>
                </div>

                <p className="text-white/60 text-sm">
                  {invoice.client_name}
                </p>

                <p className="text-white/40 text-xs mt-0.5">
                  {invoice.invoice_date} ·{' '}
                  {INV_TYPES.find(t => t.value === invoice.invoice_type)
                    ?.label || 'Tax Invoice'}
                </p>
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* BODY */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-7 space-y-5">

            {/* LINE ITEMS */}
            <div className={`border rounded-2xl overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
              <div className={`px-5 py-3 border-b ${isDark ? 'bg-slate-700/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                <p className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  Line Items ({invoice.items?.length || 0})
                </p>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className={isDark ? 'bg-slate-700/30' : 'bg-slate-50/60'}>
                      {['#', 'Description', 'HSN', 'Qty', 'Rate', 'Taxable', isInterstate ? 'IGST' : 'CGST+SGST', 'Total'].map(h => (
                        <th key={h} className="px-3 py-2.5 text-left font-bold uppercase text-[9px] text-slate-400">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>

                  <tbody>
                    {(invoice.items || []).map((it, i) => (
                      <tr key={i} className={`border-t ${isDark ? 'border-slate-700 hover:bg-slate-700/20' : 'border-slate-100 hover:bg-slate-50'}`}>
                        <td className="px-3 py-2.5 font-mono font-bold text-slate-400">{i + 1}</td>
                        <td className={`${isDark ? 'text-slate-200' : 'text-slate-800'} px-3 py-2.5 font-medium`}>{it.description}</td>
                        <td className="px-3 py-2.5 text-slate-500">{it.hsn_sac || '—'}</td>
                        <td className="px-3 py-2.5 text-slate-600">{it.quantity} {it.unit}</td>
                        <td className="px-3 py-2.5 text-slate-600">{fmtC(it.unit_price)}</td>
                        <td className="px-3 py-2.5 text-slate-600">{fmtC(it.taxable_value)}</td>
                        <td className="px-3 py-2.5 text-amber-600 font-medium">
                          {isInterstate ? fmtC(it.igst_amount) : fmtC((it.cgst_amount || 0) + (it.sgst_amount || 0))}
                        </td>
                        <td className="px-3 py-2.5 font-bold">{fmtC(it.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-5 py-3 space-y-1.5 border-t">
                <div className="flex justify-between text-xs">
                  <span>Taxable Value</span>
                  <span>{fmtC(invoice.total_taxable)}</span>
                </div>

                <div className="flex justify-between text-xs font-bold pt-2 border-t">
                  <span>Grand Total</span>
                  <span>{fmtC(invoice.grand_total)}</span>
                </div>
              </div>
            </div>

            {/* STATUS HISTORY TIMELINE */}
            {statusHistory.length > 0 && (
              <div className={`border rounded-2xl overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                <div className={`px-5 py-3 border-b ${isDark ? 'bg-slate-700/50 border-slate-700' : 'bg-slate-50 border-slate-100'}`}>
                  <p className={`text-xs font-bold uppercase tracking-widest ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                    Status Change Log
                  </p>
                </div>
                <div className="px-5 py-4 space-y-3">
                  {[...statusHistory].reverse().map((entry, i) => {
                    const sm = STATUS_META[entry.status] || STATUS_META.draft;
                    return (
                      <div key={i} className="flex items-start gap-3">
                        <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${sm.dot}`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${sm.bg} ${sm.text}`}>
                              {sm.label}
                            </span>
                            {entry.changed_by && (
                              <span className={`text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                by {entry.changed_by}
                              </span>
                            )}
                          </div>
                          <p className={`text-[10px] mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            {entry.changed_at
                              ? new Date(entry.changed_at).toLocaleString('en-IN', {
                                  day: '2-digit', month: 'short', year: 'numeric',
                                  hour: '2-digit', minute: '2-digit',
                                })
                              : '—'}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        </div>

        {/* FOOTER */}
        <div
          className={`flex-shrink-0 flex items-center gap-2 px-7 py-4 border-t flex-wrap ${
            isDark
              ? 'border-slate-700 bg-slate-800'
              : 'border-slate-100 bg-white'
          }`}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose();
              onEdit?.(invoice);
            }}
            className="rounded-xl text-xs h-9 gap-1.5"
          >
            <Edit className="h-3.5 w-3.5" /> Edit
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose();
              onDuplicate?.(invoice);
            }}
            className="rounded-xl text-xs h-9 gap-1.5"
          >
            <Copy className="h-3.5 w-3.5" /> Duplicate
          </Button>

          {/* Sale Return: Credit Note & Debit Note — only for Tax Invoices */}
          {invoice.invoice_type === 'tax_invoice' && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onClose();
                  onSaleReturn?.(invoice, 'credit_note');
                }}
                className={`rounded-xl text-xs h-9 gap-1.5 ${isDark ? 'border-purple-700 text-purple-400 hover:bg-purple-900/30' : 'border-purple-200 text-purple-600 hover:bg-purple-50'}`}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" /> Credit Note
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onClose();
                  onSaleReturn?.(invoice, 'debit_note');
                }}
                className={`rounded-xl text-xs h-9 gap-1.5 ${isDark ? 'border-amber-700 text-amber-400 hover:bg-amber-900/30' : 'border-amber-200 text-amber-600 hover:bg-amber-50'}`}
              >
                <ArrowRightLeft className="h-3.5 w-3.5" /> Debit Note
              </Button>
            </>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={() => onDownloadPdf?.(invoice)}
            className="rounded-xl text-xs h-9 gap-1.5"
          >
            <Download className="h-3.5 w-3.5" /> PDF
          </Button>

          {/* ✅ FIXED: inv → invoice */}
          <DriveUploadBtn
            invoiceId={invoice.id}
            invoiceNo={invoice.invoice_no}
            invoice={invoice}
            companies={companies}
          />

          <Button
            variant="outline"
            size="sm"
            onClick={() => onPreview?.(invoice)}
            className="rounded-xl text-xs h-9 gap-1.5"
          >
            <Eye className="h-3.5 w-3.5" /> Preview
          </Button>

          {invoice.client_email && (
            <Button
              size="sm"
              onClick={() => {
                onClose();
                onSendEmail?.(invoice);
              }}
              className="rounded-xl text-xs h-9 gap-1.5 bg-blue-600 text-white"
            >
              <Send className="h-3.5 w-3.5" /> Send Email
            </Button>
          )}

          {/* WhatsApp button — always visible; opens send dialog */}
          <Button
            size="sm"
            onClick={() => { onClose(); onWhatsApp?.(invoice); }}
            className="rounded-xl text-xs h-9 gap-1.5"
            style={{ background: invoice.client_phone ? 'linear-gradient(135deg,#128C7E,#25D366)' : 'rgba(37,211,102,0.15)', color: invoice.client_phone ? '#fff' : '#25D366', border: invoice.client_phone ? 'none' : '1px solid rgba(37,211,102,0.3)' }}
            title={invoice.client_phone ? 'Send via WhatsApp' : 'No phone — click to enter manually'}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
            {invoice.client_phone ? 'WhatsApp' : 'WhatsApp (add #)'}
          </Button>

          {invoice.amount_due > 0 && (
            <Button
              size="sm"
              onClick={() => {
                onClose();
                onPayment?.(invoice);
              }}
              className="rounded-xl text-xs h-9 gap-1.5 text-white"
              style={{
                background: `linear-gradient(135deg, ${COLORS.emeraldGreen}, #15803d)`
              }}
            >
              <IndianRupee className="h-3.5 w-3.5" /> Record Payment
            </Button>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={() => onDelete?.(invoice)}
            className="rounded-xl text-xs h-9 gap-1.5 text-red-500 hover:bg-red-50 ml-auto"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// SERVICE MASTER MODAL (unified, feature-rich)
// ════════════════════════════════════════════════════════════════════════════════
const CATEGORY_COLORS = [
  { label: 'Blue', value: 'blue', bg: 'bg-blue-100', text: 'text-blue-700', dot: 'bg-blue-500' },
  { label: 'Green', value: 'green', bg: 'bg-emerald-100', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  { label: 'Purple', value: 'purple', bg: 'bg-purple-100', text: 'text-purple-700', dot: 'bg-purple-500' },
  { label: 'Orange', value: 'orange', bg: 'bg-orange-100', text: 'text-orange-700', dot: 'bg-orange-500' },
  { label: 'Pink', value: 'pink', bg: 'bg-pink-100', text: 'text-pink-700', dot: 'bg-pink-500' },
  { label: 'Teal', value: 'teal', bg: 'bg-teal-100', text: 'text-teal-700', dot: 'bg-teal-500' },
];
const getCatColor = (cat) => CATEGORY_COLORS.find(c => c.value === cat) || CATEGORY_COLORS[0];

const ProductModal = ({ open, onClose, isDark, onSaved, invoices = [] }) => {
  const emptyForm = { name: '', description: '', hsn_sac: '', unit: 'service', unit_price: 0, gst_rate: 18, category: '', is_service: true, color: 'blue', notes: '', discount: 0 };
  const [products, setProducts] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [sortBy, setSortBy] = useState('name');
  const [viewMode, setViewMode] = useState('grid'); // 'list' | 'grid'
  const [activeTab, setActiveTab] = useState('catalog'); // 'catalog' | 'add' | 'analytics'
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [priceRangeFilter, setPriceRangeFilter] = useState('all'); // 'all' | 'low' | 'mid' | 'high'
  const [gstFilter, setGstFilter] = useState('all');

  const fetchProducts = () => api.get('/products').then(r => setProducts(r.data || [])).catch(() => {});
  useEffect(() => {
    if (open) { fetchProducts(); setForm(emptyForm); setEditing(null); setSearch(''); setSelectedIds(new Set()); }
  }, [open]);

  const handleSave = async () => {
    if (!form.name?.trim()) { toast.error('Service name is required'); return; }
    setLoading(true);
    try {
      if (editing) await api.put(`/products/${editing.id}`, form);
      else await api.post('/products', form);
      toast.success(editing ? 'Updated!' : 'Added!');
      fetchProducts(); setForm(emptyForm); setEditing(null); onSaved?.();
      if (!editing) setActiveTab('catalog');
    } catch { toast.error('Failed to save'); }
    finally { setLoading(false); }
  };

  const handleEdit = (p) => {
    setEditing(p);
    setForm({ name: p.name, description: p.description || '', hsn_sac: p.hsn_sac || '', unit: p.unit || 'service', unit_price: p.unit_price || 0, gst_rate: p.gst_rate || 18, category: p.category || '', is_service: p.is_service !== false, color: p.color || 'blue', notes: p.notes || '', discount: p.discount || 0 });
    setActiveTab('add');
  };

  const handleDelete = async (id) => {
    try { await api.delete(`/products/${id}`); setProducts(p => p.filter(x => x.id !== id)); toast.success('Deleted'); if (editing?.id === id) { setEditing(null); setForm(emptyForm); } }
    catch { toast.error('Failed'); }
  };

  const handleBulkDelete = async () => {
    if (!selectedIds.size) return;
    try {
      await Promise.all([...selectedIds].map(id => api.delete(`/products/${id}`)));
      toast.success(`Deleted ${selectedIds.size} items`);
      setProducts(p => p.filter(x => !selectedIds.has(x.id)));
      setSelectedIds(new Set());
      setBulkDeleteConfirm(false);
    } catch { toast.error('Some deletes failed'); }
  };

  const handleDuplicate = async (p) => {
    try {
      await api.post('/products', { ...p, id: undefined, name: `${p.name} (Copy)` });
      toast.success('Duplicated!'); fetchProducts();
    } catch { toast.error('Failed to duplicate'); }
  };

  const handleImport = () => {
    const existing = new Set(products.map(p => p.name?.trim().toLowerCase()));
    const toAdd = [];
    (invoices || []).forEach(inv => (inv.items || []).forEach(it => {
      const name = (it.description || '').trim();
      if (name && !existing.has(name.toLowerCase())) {
        existing.add(name.toLowerCase());
        toAdd.push({ name, description: '', hsn_sac: it.hsn_sac || '', unit: it.unit || 'service', unit_price: it.unit_price || 0, gst_rate: it.gst_rate || 18, category: '', is_service: true, color: 'blue', notes: '', discount: 0 });
      }
    }));
    if (!toAdd.length) { toast.info('No new services found in invoices'); return; }
    Promise.all(toAdd.map(s => api.post('/products', s))).then(() => { toast.success(`Imported ${toAdd.length} service${toAdd.length > 1 ? 's' : ''}`); fetchProducts(); onSaved?.(); }).catch(() => toast.error('Some imports failed'));
  };

  const handleExportCSV = async () => {
    const rows = [['Name', 'Description', 'Type', 'Category', 'Unit', 'Unit Price', 'GST %', 'Discount %', 'HSN/SAC', 'Notes']];
    products.forEach(p => rows.push([p.name, p.description || '', p.is_service ? 'Service' : 'Product', p.category || '', p.unit || '', p.unit_price || 0, p.gst_rate || 18, p.discount || 0, p.hsn_sac || '', p.notes || '']));
    XLSX = await getXLSX();
    const ws = XLSX.utils.aoa_to_sheet(rows); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Catalog'); XLSX.writeFile(wb, 'service_catalog.xlsx');
    toast.success('Exported!');
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filtered.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filtered.map(p => p.id)));
  };

  const categories = useMemo(() => [...new Set(products.map(p => p.category).filter(Boolean))], [products]);
  const gstRates = useMemo(() => [...new Set(products.map(p => p.gst_rate).filter(r => r !== undefined && r !== null))].sort((a,b) => a - b), [products]);

  const analytics = useMemo(() => {
    const totalRevenue = (invoices || []).reduce((sum, inv) =>
      sum + (inv.items || []).reduce((s, it) => {
        const match = products.find(p => p.name?.toLowerCase() === it.description?.toLowerCase());
        return match ? s + ((it.unit_price || 0) * (it.quantity || 1)) : s;
      }, 0), 0);
    const serviceUsage = {};
    (invoices || []).forEach(inv => (inv.items || []).forEach(it => {
      const key = (it.description || '').trim();
      if (key) serviceUsage[key] = (serviceUsage[key] || 0) + 1;
    }));
    const topServices = Object.entries(serviceUsage).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const avgPrice = products.length ? Math.round(products.reduce((s, p) => s + (p.unit_price || 0), 0) / products.length) : 0;
    const byCategory = categories.map(cat => ({ cat, count: products.filter(p => p.category === cat).length })).sort((a,b) => b.count - a.count);
    return { totalRevenue, topServices, totalProducts: products.length, services: products.filter(p => p.is_service !== false).length, goods: products.filter(p => p.is_service === false).length, avgPrice, byCategory };
  }, [products, invoices, categories]);

  const filtered = useMemo(() => {
    let list = products;
    if (filterType !== 'all') list = list.filter(p => filterType === 'service' ? p.is_service !== false : p.is_service === false);
    if (filterCat !== 'all') list = list.filter(p => (p.category || '') === filterCat);
    if (gstFilter !== 'all') list = list.filter(p => String(p.gst_rate) === gstFilter);
    if (priceRangeFilter !== 'all') {
      if (priceRangeFilter === 'low') list = list.filter(p => (p.unit_price || 0) < 1000);
      else if (priceRangeFilter === 'mid') list = list.filter(p => (p.unit_price || 0) >= 1000 && (p.unit_price || 0) < 10000);
      else if (priceRangeFilter === 'high') list = list.filter(p => (p.unit_price || 0) >= 10000);
    }
    if (search) list = list.filter(p => p.name?.toLowerCase().includes(search.toLowerCase()) || p.description?.toLowerCase().includes(search.toLowerCase()) || p.hsn_sac?.includes(search) || p.category?.toLowerCase().includes(search.toLowerCase()));
    if (sortBy === 'name') list = [...list].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sortBy === 'price_asc') list = [...list].sort((a, b) => (a.unit_price || 0) - (b.unit_price || 0));
    else if (sortBy === 'price_desc') list = [...list].sort((a, b) => (b.unit_price || 0) - (a.unit_price || 0));
    else if (sortBy === 'gst') list = [...list].sort((a, b) => (b.gst_rate || 0) - (a.gst_rate || 0));
    else if (sortBy === 'category') list = [...list].sort((a, b) => (a.category || '').localeCompare(b.category || ''));
    return list;
  }, [products, search, filterCat, filterType, sortBy, priceRangeFilter, gstFilter]);

  const inputCls = `h-9 rounded-xl text-sm px-3 border w-full focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all ${isDark ? 'bg-slate-700 text-slate-100 border-slate-600 placeholder-slate-400' : 'bg-white text-slate-800 border-slate-200 placeholder-slate-400'}`;
  const labelCls = 'text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1 block';

  const tabBtn = (id, label, icon) => (
    <button onClick={() => setActiveTab(id)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${activeTab === id ? (isDark ? 'bg-slate-700 text-slate-100 shadow' : 'bg-white text-slate-800 shadow') : (isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}>
      {icon}{label}
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={`max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 ${isDark ? 'bg-slate-900 border-slate-700' : 'bg-white border-slate-200'}`}>
        <DialogTitle className="sr-only">Service Catalog</DialogTitle>
        <DialogDescription className="sr-only">Manage your services and products catalog</DialogDescription>

        {/* ── HEADER ── */}
        <div className={`px-5 py-3.5 border-b flex items-center justify-between flex-shrink-0 ${isDark ? 'border-slate-700' : 'border-slate-100'}`} style={{ background: isDark ? undefined : `linear-gradient(135deg, ${COLORS.deepBlue}08 0%, ${COLORS.mediumBlue}05 100%)` }}>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white shadow-lg flex-shrink-0" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
              <Layers className="h-4.5 w-4.5" style={{ width: 18, height: 18 }} />
            </div>
            <div>
              <h2 className={`font-bold text-base leading-tight ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>Service Catalog</h2>
              <p className="text-[11px] text-slate-400">{analytics.services} services · {analytics.goods} products · avg ₹{analytics.avgPrice.toLocaleString('en-IN')}</p>
            </div>
          </div>

          {/* Tab switcher */}
          <div className={`flex items-center rounded-xl p-1 gap-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
            {tabBtn('catalog', 'Catalog', <Package style={{ width: 13, height: 13 }} />)}
            {tabBtn('add', editing ? 'Edit Item' : 'Add New', <Plus style={{ width: 13, height: 13 }} />)}
            {tabBtn('analytics', 'Analytics', <PieChart style={{ width: 13, height: 13 }} />)}
          </div>

          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="outline" onClick={handleImport} className={`h-8 px-3 text-xs rounded-xl gap-1.5 ${isDark ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : ''}`}>
              <Download className="h-3.5 w-3.5" /> Import
            </Button>
            <Button size="sm" variant="outline" onClick={handleExportCSV} className={`h-8 px-3 text-xs rounded-xl gap-1.5 ${isDark ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : ''}`}>
              <FileDown className="h-3.5 w-3.5" /> Export
            </Button>
            <button onClick={onClose} className={`w-8 h-8 flex items-center justify-center rounded-xl transition-colors ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-700' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}><X className="h-4 w-4" /></button>
          </div>
        </div>

        {/* ── CATALOG TAB ── */}
        {activeTab === 'catalog' && (
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            {/* Filters bar */}
            <div className={`px-4 py-2.5 border-b flex flex-wrap items-center gap-2 flex-shrink-0 ${isDark ? 'border-slate-700 bg-slate-800/40' : 'border-slate-100 bg-slate-50/60'}`}>
              {/* Search */}
              <div className="relative flex-1 min-w-[180px] max-w-xs">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input
                  className={`h-8 pl-8 pr-3 rounded-xl text-xs border w-full focus:outline-none focus:ring-2 focus:ring-blue-400/30 transition-all ${isDark ? 'bg-slate-700 text-slate-100 border-slate-600 placeholder-slate-400' : 'bg-white text-slate-800 border-slate-200 placeholder-slate-400'}`}
                  placeholder="Search name, HSN, category…"
                  value={search} onChange={e => setSearch(e.target.value)}
                />
                {search && <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-3 w-3" /></button>}
              </div>

              {/* Type filter */}
              <div className={`flex rounded-xl p-0.5 gap-0.5 flex-shrink-0 ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                {[['all', 'All'], ['service', 'Services'], ['product', 'Products']].map(([v, l]) => (
                  <button key={v} onClick={() => setFilterType(v)} className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all ${filterType === v ? (isDark ? 'bg-slate-900 text-slate-100 shadow' : 'bg-white text-slate-800 shadow') : (isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700')}`}>{l}</button>
                ))}
              </div>

              {/* Price range */}
              <select value={priceRangeFilter} onChange={e => setPriceRangeFilter(e.target.value)} className={`h-8 px-2 rounded-xl text-xs border flex-shrink-0 focus:outline-none ${isDark ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-white text-slate-700 border-slate-200'}`}>
                <option value="all">All Prices</option>
                <option value="low">Under ₹1K</option>
                <option value="mid">₹1K–₹10K</option>
                <option value="high">Above ₹10K</option>
              </select>

              {/* GST filter */}
              {gstRates.length > 0 && (
                <select value={gstFilter} onChange={e => setGstFilter(e.target.value)} className={`h-8 px-2 rounded-xl text-xs border flex-shrink-0 focus:outline-none ${isDark ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-white text-slate-700 border-slate-200'}`}>
                  <option value="all">All GST</option>
                  {gstRates.map(r => <option key={r} value={String(r)}>GST {r}%</option>)}
                </select>
              )}

              {/* Category filter */}
              {categories.length > 0 && (
                <select value={filterCat} onChange={e => setFilterCat(e.target.value)} className={`h-8 px-2 rounded-xl text-xs border flex-shrink-0 focus:outline-none ${isDark ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-white text-slate-700 border-slate-200'}`}>
                  <option value="all">All Categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              )}

              {/* Sort */}
              <select value={sortBy} onChange={e => setSortBy(e.target.value)} className={`h-8 px-2 rounded-xl text-xs border flex-shrink-0 focus:outline-none ${isDark ? 'bg-slate-700 text-slate-200 border-slate-600' : 'bg-white text-slate-700 border-slate-200'}`}>
                <option value="name">Sort: Name</option>
                <option value="price_asc">Price ↑</option>
                <option value="price_desc">Price ↓</option>
                <option value="gst">GST Rate</option>
                <option value="category">Category</option>
              </select>

              {/* View toggle */}
              <div className={`flex rounded-xl p-0.5 gap-0.5 flex-shrink-0 ml-auto ${isDark ? 'bg-slate-700' : 'bg-slate-200'}`}>
                <button onClick={() => setViewMode('grid')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'grid' ? (isDark ? 'bg-slate-900 shadow text-slate-200' : 'bg-white shadow text-slate-700') : 'text-slate-400'}`} title="Grid view">
                  <LayoutGrid className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setViewMode('list')} className={`p-1.5 rounded-lg transition-all ${viewMode === 'list' ? (isDark ? 'bg-slate-900 shadow text-slate-200' : 'bg-white shadow text-slate-700') : 'text-slate-400'}`} title="List view">
                  <Table className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Category quick chips */}
            {categories.length > 0 && (
              <div className={`px-4 py-2 border-b flex gap-1.5 flex-wrap flex-shrink-0 ${isDark ? 'border-slate-700/60' : 'border-slate-100'}`}>
                <button onClick={() => setFilterCat('all')} className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all border ${filterCat === 'all' ? 'bg-blue-600 text-white border-blue-600' : (isDark ? 'border-slate-600 text-slate-400 hover:border-slate-400' : 'border-slate-200 text-slate-500 hover:border-slate-400')}`}>All ({products.length})</button>
                {categories.map(cat => {
                  const cc = getCatColor(products.find(p => p.category === cat)?.color || 'blue');
                  const cnt = products.filter(p => p.category === cat).length;
                  return (
                    <button key={cat} onClick={() => setFilterCat(filterCat === cat ? 'all' : cat)}
                      className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold transition-all border ${filterCat === cat ? `${cc.dot} text-white border-transparent` : (isDark ? `border-slate-600 text-slate-400 hover:${cc.bg}` : `border-slate-200 ${cc.text} ${cc.bg}`)}`}>
                      {cat} ({cnt})
                    </button>
                  );
                })}
              </div>
            )}

            {/* Bulk actions bar */}
            {selectedIds.size > 0 && (
              <div className={`px-4 py-2 border-b flex items-center gap-3 flex-shrink-0 ${isDark ? 'border-slate-700 bg-blue-900/20' : 'border-blue-100 bg-blue-50'}`}>
                <span className="text-xs font-semibold text-blue-600">{selectedIds.size} selected</span>
                <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-500 hover:text-slate-700 underline">Clear</button>
                <button onClick={toggleSelectAll} className="text-xs text-blue-500 hover:text-blue-700 underline">{selectedIds.size === filtered.length ? 'Deselect all' : 'Select all'}</button>
                <div className="ml-auto">
                  {!bulkDeleteConfirm ? (
                    <button onClick={() => setBulkDeleteConfirm(true)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-100 text-red-600 hover:bg-red-200 transition-colors">
                      <Trash2 className="h-3.5 w-3.5" /> Delete {selectedIds.size} items
                    </button>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-600 font-medium">Confirm delete {selectedIds.size} items?</span>
                      <button onClick={handleBulkDelete} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 transition-colors">Yes, Delete</button>
                      <button onClick={() => setBulkDeleteConfirm(false)} className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-slate-200 text-slate-700 hover:bg-slate-300 transition-colors">Cancel</button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Results count */}
            <div className={`px-4 py-1.5 text-[11px] flex items-center justify-between flex-shrink-0 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              <span>{filtered.length} of {products.length} items{(search || filterCat !== 'all' || filterType !== 'all' || priceRangeFilter !== 'all' || gstFilter !== 'all') ? ' (filtered)' : ''}</span>
              <div className="flex items-center gap-2">
                {filtered.length !== products.length && <button className="text-blue-500 hover:underline text-[11px]" onClick={() => { setSearch(''); setFilterCat('all'); setFilterType('all'); setPriceRangeFilter('all'); setGstFilter('all'); }}>Clear all filters</button>}
                {filtered.length > 0 && <button onClick={toggleSelectAll} className="text-slate-400 hover:text-slate-600 text-[11px] hover:underline">{selectedIds.size === filtered.length ? 'Deselect all' : 'Select all'}</button>}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full py-20 text-slate-400">
                  <Layers className="h-12 w-12 mb-3 opacity-20" />
                  <p className="text-sm font-semibold">{products.length === 0 ? 'Catalog is empty' : 'No matches found'}</p>
                  <p className="text-xs mt-1">{products.length === 0 ? 'Add your first service or product' : 'Try adjusting your filters'}</p>
                  {products.length === 0 && (
                    <div className="flex gap-2 mt-4">
                      <Button size="sm" onClick={() => setActiveTab('add')} className="h-8 text-xs rounded-xl gap-1.5 text-white" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}><Plus className="h-3.5 w-3.5" />Add First Item</Button>
                      <Button size="sm" onClick={handleImport} className="h-8 text-xs rounded-xl gap-1.5" variant="outline"><Download className="h-3.5 w-3.5" />Import from Invoices</Button>
                    </div>
                  )}
                </div>
              ) : viewMode === 'grid' ? (
                <div className="p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {filtered.map(p => {
                    const cc = getCatColor(p.color || 'blue');
                    const isSelected = selectedIds.has(p.id);
                    return (
                      <div key={p.id}
                        className={`relative rounded-2xl border cursor-pointer group transition-all ${isSelected ? (isDark ? 'bg-blue-900/30 border-blue-600' : 'bg-blue-50 border-blue-300 shadow-md') : (isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-500 hover:shadow-md' : 'bg-white border-slate-150 hover:border-blue-200 hover:shadow-md')}`}
                        style={{ boxShadow: isSelected ? `0 0 0 2px ${COLORS.mediumBlue}40` : undefined }}>

                        {/* Select checkbox */}
                        <div className={`absolute top-2.5 left-2.5 z-10 transition-opacity ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                          <button onClick={(e) => { e.stopPropagation(); toggleSelect(p.id); }} className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-blue-600 border-blue-600' : (isDark ? 'border-slate-500 bg-slate-700' : 'border-slate-300 bg-white')}`}>
                            {isSelected && <Check className="h-3 w-3 text-white" />}
                          </button>
                        </div>

                        {/* Action buttons */}
                        <div className={`absolute top-2.5 right-2.5 z-10 flex gap-1 transition-opacity ${isSelected ? 'opacity-0' : 'opacity-0 group-hover:opacity-100'}`} onClick={e => e.stopPropagation()}>
                          <button onClick={() => handleDuplicate(p)} className={`w-6 h-6 flex items-center justify-center rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:bg-slate-700 hover:text-slate-200' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'}`} title="Duplicate"><Copy className="h-3 w-3" /></button>
                          <button onClick={() => handleEdit(p)} className="w-6 h-6 flex items-center justify-center rounded-lg text-blue-500 hover:bg-blue-50 transition-colors"><Edit className="h-3 w-3" /></button>
                          <button onClick={() => handleDelete(p.id)} className="w-6 h-6 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"><Trash2 className="h-3 w-3" /></button>
                        </div>

                        <div className="p-4 pt-3" onClick={() => handleEdit(p)}>
                          {/* Type icon + color bar */}
                          <div className="flex items-center gap-2 mb-3">
                            <div className={`w-8 h-8 rounded-xl flex items-center justify-center text-white flex-shrink-0 shadow-sm ${cc.dot}`}>
                              {p.is_service !== false ? <Briefcase className="h-3.5 w-3.5" /> : <Package className="h-3.5 w-3.5" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={`text-xs font-medium truncate ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{p.is_service !== false ? 'Service' : 'Product'}</p>
                            </div>
                          </div>

                          {/* Name */}
                          <p className={`text-sm font-bold leading-snug mb-1 pr-4 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{p.name}</p>
                          {p.description && <p className="text-[11px] text-slate-400 mb-2 line-clamp-2">{p.description}</p>}

                          {/* Price */}
                          <div className="flex items-baseline gap-1 mb-2">
                            <span className={`text-base font-extrabold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>₹{(p.unit_price || 0).toLocaleString('en-IN')}</span>
                            <span className="text-[11px] text-slate-400">/ {p.unit || 'service'}</span>
                          </div>

                          {/* Tags row */}
                          <div className="flex flex-wrap gap-1">
                            {p.category && <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${cc.bg} ${cc.text}`}>{p.category}</span>}
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${isDark ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>GST {p.gst_rate}%</span>
                            {p.discount > 0 && <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-orange-100 text-orange-600">{p.discount}% off</span>}
                            {p.hsn_sac && <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isDark ? 'bg-slate-700 text-slate-500' : 'bg-slate-100 text-slate-400'}`}>{p.hsn_sac}</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                // List view
                <table className="w-full text-sm">
                  <thead className={`sticky top-0 z-10 ${isDark ? 'bg-slate-800 text-slate-400' : 'bg-slate-50 text-slate-500'}`}>
                    <tr>
                      <th className="w-8 pl-4 py-2.5 text-left">
                        <button onClick={toggleSelectAll} className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${selectedIds.size === filtered.length && filtered.length > 0 ? 'bg-blue-600 border-blue-600' : (isDark ? 'border-slate-500' : 'border-slate-300')}`}>
                          {selectedIds.size === filtered.length && filtered.length > 0 && <Check className="h-2.5 w-2.5 text-white" />}
                        </button>
                      </th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Name</th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Type</th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">Category</th>
                      <th className="px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide">Price</th>
                      <th className="px-3 py-2.5 text-center text-[11px] font-semibold uppercase tracking-wide">GST</th>
                      <th className="px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wide">HSN/SAC</th>
                      <th className="px-4 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(p => {
                      const cc = getCatColor(p.color || 'blue');
                      const isSelected = selectedIds.has(p.id);
                      return (
                        <tr key={p.id} className={`border-b group transition-colors cursor-pointer ${isSelected ? (isDark ? 'bg-blue-900/20 border-blue-800/30' : 'bg-blue-50 border-blue-100') : (isDark ? 'border-slate-700/60 hover:bg-slate-800/60' : 'border-slate-100 hover:bg-slate-50')}`}>
                          <td className="pl-4 py-2.5 w-8">
                            <button onClick={(e) => { e.stopPropagation(); toggleSelect(p.id); }} className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-blue-600 border-blue-600' : (isDark ? 'border-slate-500' : 'border-slate-300')}`}>
                              {isSelected && <Check className="h-2.5 w-2.5 text-white" />}
                            </button>
                          </td>
                          <td className="px-3 py-2.5" onClick={() => handleEdit(p)}>
                            <div className="flex items-center gap-2">
                              <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-white flex-shrink-0 ${cc.dot}`}>
                                {p.is_service !== false ? <Briefcase className="h-3 w-3" /> : <Package className="h-3 w-3" />}
                              </div>
                              <div>
                                <p className={`text-sm font-semibold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{p.name}</p>
                                {p.description && <p className="text-[11px] text-slate-400 truncate max-w-[200px]">{p.description}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${p.is_service !== false ? 'bg-purple-100 text-purple-700' : 'bg-emerald-100 text-emerald-700'}`}>
                              {p.is_service !== false ? 'Service' : 'Product'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5">
                            {p.category && <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${cc.bg} ${cc.text}`}>{p.category}</span>}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <span className={`text-sm font-bold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>₹{(p.unit_price || 0).toLocaleString('en-IN')}</span>
                            {p.discount > 0 && <span className="ml-1 text-[10px] text-orange-500">{p.discount}% off</span>}
                          </td>
                          <td className="px-3 py-2.5 text-center">
                            <span className={`text-[11px] font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{p.gst_rate}%</span>
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="text-[11px] text-slate-400 font-mono">{p.hsn_sac || '—'}</span>
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <div className="flex gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                              <button onClick={() => handleDuplicate(p)} className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors ${isDark ? 'text-slate-400 hover:bg-slate-700 hover:text-slate-200' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-600'}`}><Copy className="h-3.5 w-3.5" /></button>
                              <button onClick={() => handleEdit(p)} className="w-7 h-7 flex items-center justify-center rounded-lg text-blue-500 hover:bg-blue-50 transition-colors"><Edit className="h-3.5 w-3.5" /></button>
                              <button onClick={() => handleDelete(p.id)} className="w-7 h-7 flex items-center justify-center rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"><Trash2 className="h-3.5 w-3.5" /></button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            {products.length > 0 && (
              <div className={`px-4 py-2 border-t text-[11px] flex justify-between items-center flex-shrink-0 ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
                <span>{analytics.services} services · {analytics.goods} products</span>
                <span>Click a row to edit · Items appear as suggestions in new invoices</span>
              </div>
            )}
          </div>
        )}

        {/* ── ADD / EDIT TAB ── */}
        {activeTab === 'add' && (
          <div className="flex-1 overflow-y-auto p-6">
            <div className="max-w-2xl mx-auto">
              {editing && (
                <div className={`mb-4 px-4 py-3 rounded-xl border flex items-center justify-between ${isDark ? 'bg-blue-900/20 border-blue-800/30' : 'bg-blue-50 border-blue-200'}`}>
                  <span className="text-xs font-semibold text-blue-600">Editing: <span className="font-bold">{editing.name}</span></span>
                  <button onClick={() => { setEditing(null); setForm(emptyForm); }} className="text-xs text-slate-400 hover:text-slate-600 flex items-center gap-1"><X className="h-3 w-3" /> Cancel edit</button>
                </div>
              )}

              {/* Type toggle */}
              <div className={`flex rounded-xl p-1 gap-1 mb-5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                <button onClick={() => setForm(p => ({ ...p, is_service: true }))} className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 ${form.is_service ? 'bg-white text-slate-800 shadow' : (isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500')}`}>
                  <Briefcase className="h-4 w-4" /> Service
                </button>
                <button onClick={() => setForm(p => ({ ...p, is_service: false }))} className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-2 ${!form.is_service ? 'bg-white text-slate-800 shadow' : (isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500')}`}>
                  <Package className="h-4 w-4" /> Product
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <label className={labelCls}>Name *</label>
                  <input className={inputCls} placeholder="e.g. GST Filing, Website Design" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Description</label>
                  <input className={inputCls} placeholder="Short description of the service" value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Unit Price (₹)</label>
                  <input type="number" className={inputCls} value={form.unit_price} onChange={e => setForm(p => ({ ...p, unit_price: parseFloat(e.target.value) || 0 }))} />
                </div>
                <div>
                  <label className={labelCls}>GST %</label>
                  <select className={inputCls} value={form.gst_rate} onChange={e => setForm(p => ({ ...p, gst_rate: parseFloat(e.target.value) }))}>
                    {[0, 5, 12, 18, 28].map(r => <option key={r} value={r}>{r}%</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>HSN / SAC Code</label>
                  <input className={inputCls} placeholder="998311" value={form.hsn_sac} onChange={e => setForm(p => ({ ...p, hsn_sac: e.target.value }))} />
                </div>
                <div>
                  <label className={labelCls}>Unit</label>
                  <select className={inputCls} value={form.unit} onChange={e => setForm(p => ({ ...p, unit: e.target.value }))}>
                    {['service', 'hour', 'day', 'month', 'year', 'piece', 'kg', 'litre', 'nos'].map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Category</label>
                  <input className={inputCls} placeholder="e.g. GST, Legal, Design" value={form.category} list="cat-list" onChange={e => setForm(p => ({ ...p, category: e.target.value }))} />
                  <datalist id="cat-list">{categories.map(c => <option key={c} value={c} />)}</datalist>
                </div>
                <div>
                  <label className={labelCls}>Discount %</label>
                  <input type="number" className={inputCls} min="0" max="100" value={form.discount} onChange={e => setForm(p => ({ ...p, discount: parseFloat(e.target.value) || 0 }))} />
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Color Tag</label>
                  <div className="flex gap-2 mt-1 flex-wrap">
                    {['blue', 'green', 'purple', 'orange', 'red', 'teal'].map(c => {
                      const cc = getCatColor(c);
                      return (
                        <button key={c} type="button" onClick={() => setForm(p => ({ ...p, color: c }))}
                          className={`w-7 h-7 rounded-full transition-all ${cc.dot} ${form.color === c ? 'ring-2 ring-offset-2 ring-blue-500 scale-110' : 'hover:scale-105'}`} />
                      );
                    })}
                  </div>
                </div>
                <div className="col-span-2">
                  <label className={labelCls}>Internal Notes</label>
                  <textarea className={`${inputCls} h-16 py-2 resize-none`} placeholder="Private notes about this item…" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
                </div>
              </div>

              <div className="flex gap-3 mt-6">
                <Button onClick={handleSave} disabled={loading} className="flex-1 h-10 rounded-xl gap-2 text-white font-semibold" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                  {loading ? 'Saving…' : (editing ? '✓ Update Item' : '+ Add to Catalog')}
                </Button>
                <Button variant="outline" onClick={() => { setEditing(null); setForm(emptyForm); setActiveTab('catalog'); }} className="h-10 px-4 rounded-xl">Cancel</Button>
              </div>
            </div>
          </div>
        )}

        {/* ── ANALYTICS TAB ── */}
        {activeTab === 'analytics' && (
          <div className="flex-1 overflow-y-auto p-5">
            {/* Summary cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
              {[
                { label: 'Total Items', value: analytics.totalProducts, icon: Package, color: 'blue' },
                { label: 'Services', value: analytics.services, icon: Briefcase, color: 'purple' },
                { label: 'Products', value: analytics.goods, icon: Tag, color: 'green' },
                { label: 'Avg Price', value: `₹${analytics.avgPrice.toLocaleString('en-IN')}`, icon: IndianRupee, color: 'amber' },
              ].map(({ label, value, icon: Icon, color }) => (
                <div key={label} className={`rounded-xl p-4 border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'} shadow-sm`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center mb-2 ${color === 'blue' ? 'bg-blue-100 text-blue-600' : color === 'purple' ? 'bg-purple-100 text-purple-600' : color === 'green' ? 'bg-emerald-100 text-emerald-600' : 'bg-amber-100 text-amber-600'}`}><Icon className="h-4 w-4" /></div>
                  <p className={`text-xl font-extrabold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{value}</p>
                  <p className="text-xs text-slate-400">{label}</p>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Top services */}
              <div className={`rounded-xl border p-5 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'} shadow-sm`}>
                <h3 className={`text-sm font-bold mb-4 flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  <TrendingUp className="h-4 w-4 text-blue-500" /> Most Used in Invoices
                </h3>
                {analytics.topServices.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4 text-center">No invoice data yet</p>
                ) : analytics.topServices.map(([name, count], i) => {
                  const pct = Math.round((count / analytics.topServices[0][1]) * 100);
                  return (
                    <div key={name} className="mb-3 last:mb-0">
                      <div className="flex justify-between mb-1">
                        <span className={`text-xs font-medium truncate max-w-[70%] ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                          <span className="text-slate-400 mr-1">#{i + 1}</span>{name}
                        </span>
                        <span className="text-xs text-slate-400">{count}x</span>
                      </div>
                      <div className={`h-1.5 rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
                        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Categories */}
              <div className={`rounded-xl border p-5 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'} shadow-sm`}>
                <h3 className={`text-sm font-bold mb-4 flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  <Tag className="h-4 w-4 text-purple-500" /> By Category
                </h3>
                {analytics.byCategory.length === 0 ? (
                  <p className="text-xs text-slate-400 py-4 text-center">No categories set yet</p>
                ) : (
                  <div className="space-y-2.5">
                    {analytics.byCategory.map(({ cat, count }) => {
                      const cc = getCatColor(products.find(p => p.category === cat)?.color || 'blue');
                      const pct = Math.round((count / products.length) * 100);
                      return (
                        <div key={cat}>
                          <div className="flex justify-between mb-1">
                            <span className={`text-xs font-semibold ${cc.text}`}>{cat}</span>
                            <span className="text-xs text-slate-400">{count} items · {pct}%</span>
                          </div>
                          <div className={`h-1.5 rounded-full ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
                            <div className={`h-1.5 rounded-full transition-all ${cc.dot}`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* GST breakdown */}
              <div className={`rounded-xl border p-5 ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'} shadow-sm sm:col-span-2`}>
                <h3 className={`text-sm font-bold mb-4 flex items-center gap-2 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                  <FileSpreadsheet className="h-4 w-4 text-emerald-500" /> GST Rate Distribution
                </h3>
                <div className="flex flex-wrap gap-3">
                  {gstRates.map(rate => {
                    const count = products.filter(p => p.gst_rate === rate).length;
                    const pct = Math.round((count / products.length) * 100);
                    return (
                      <div key={rate} className={`flex-1 min-w-[100px] rounded-xl p-3 text-center ${isDark ? 'bg-slate-700' : 'bg-slate-50'}`}>
                        <p className={`text-lg font-extrabold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{rate}%</p>
                        <p className="text-xs text-slate-400">{count} items · {pct}%</p>
                      </div>
                    );
                  })}
                  {gstRates.length === 0 && <p className="text-xs text-slate-400">No items yet</p>}
                </div>
              </div>
            </div>
          </div>
        )}

      </DialogContent>
    </Dialog>
  );
};


// ════════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════════════════════
const LIST_PAGE_SIZE = 20;
function Invoicing() {
  // ── A. ALL useState (top of component) ──────────────────────────────────────
  const [invoices, setInvoices] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [clients, setClients] = useState([]);
  const [leads, setLeads] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editingInv, setEditingInv] = useState(null);
  const [detailInv, setDetailInv] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [payInv, setPayInv] = useState(null);
  const [payOpen, setPayOpen] = useState(false);
  const [catOpen, setCatOpen] = useState(false);
  const [serviceMasterOpen, setServiceMasterOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [gstOpen, setGstOpen] = useState(false);
  const [gstOnlyFilter, setGstOnlyFilter] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledgerClient, setLedgerClient] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [companyFilter, setCompanyFilter] = useState('all');
  const [yearFilter, setYearFilter] = useState('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkDeleteLoading, setBulkDeleteLoading] = useState(false);
  const [listPage, setListPage] = useState(1);
  const [outstandingPage, setOutstandingPage] = useState(1);
  const [receivedPage, setReceivedPage] = useState(1);
  const [listViewFilter, setListViewFilter] = useState('all'); // 'all' | 'outstanding' | 'received'
  const [waInvoice, setWaInvoice] = useState(null);
  const [waDialogOpen, setWaDialogOpen] = useState(false);
  const [bulkWAOpen, setBulkWAOpen] = useState(false);
  const [referrerFilter, setReferrerFilter] = useState('all');
  const [referralSummaryOpen, setReferralSummaryOpen] = useState(false);
  const [savedReferrers, setSavedReferrers] = useState([]);

  // Unprepared direct income states
  const [unpreparedIncomes, setUnpreparedIncomes] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [activeSubTab, setActiveSubTab] = useState('invoices'); // 'invoices' | 'other_income'
  const [incomeFormOpen, setIncomeFormOpen] = useState(false);
  const [editingIncome, setEditingIncome] = useState(null);
  const [incomeForm, setIncomeForm] = useState({
    company_id: '',
    date: new Date().toISOString().slice(0, 10),
    amount: '',
    payer_name: '',
    description: '',
    receipt_account_id: '',
    income_account_id: '',
  });

  // ── B. ALL useRef ─────────────────────────────────────────────────────────
  const iframeRef = useRef(null);
  const searchRef = useRef(null);
  const invoiceListRef = useRef(null); // scroll target for stat-card clicks

  // ── hooks from context/router (treat as stable) ──
  const { user } = useAuth();
  const isDark = useDark();
  const navigate = useNavigate();

  // ── D. ALL useMemo: BASE DATA ─────────────────────────────────────────────

  const availableYears = useMemo(() => {
    const years = new Set((invoices || []).map(i => i.invoice_date?.slice(0, 4)).filter(Boolean));
    return Array.from(years).sort().reverse();
  }, [invoices]);

  // ── referrerByClient / getInvoiceReferrer ────────────────────────────────
  // Maps each invoice to the referrer recorded on its client (the person/
  // company via whom that client was received) so invoices can be filtered
  // and grouped by referrer without an extra field on the invoice itself.
  const { referrerById, referrerByName } = useMemo(() => {
    const byId = {}; const byName = {};
    (clients || []).forEach(c => {
      if (!c.referred_by) return;
      if (c.id) byId[c.id] = c.referred_by;
      if (c.company_name) byName[c.company_name] = c.referred_by;
    });
    return { referrerById: byId, referrerByName: byName };
  }, [clients]);

  const getInvoiceReferrer = useCallback((inv) => {
    return (inv.client_id && referrerById[inv.client_id]) || referrerByName[inv.client_name] || null;
  }, [referrerById, referrerByName]);

  const localStats = useMemo(() => {
    const now = new Date();
    const curMonth = format(now, 'yyyy-MM');
    const fy = fyRange(yearFilter === 'all' ? null : yearFilter);
    const base = (invoices || []).filter(inv => {
      if (!recordBelongsToCompany(inv, companyFilter, companies)) return false;
      if (fy && (inv.invoice_date < fy.from || inv.invoice_date > fy.to)) return false;
      return true;
    });
    // Accounting engine rule — matches backend invoice_stats() exactly:
    //   Revenue      = Sum(all non-cancelled TAX INVOICE grand totals)
    //   Collections  = Sum(amount_paid) on those same invoices
    //   Outstanding  = Sum(amount_due)  on those same invoices
    //   Revenue = Collections + Outstanding   (always)
    // Credit Notes and Debit Notes are real accounting, but they never touch
    // Revenue directly — they only net into the ORIGINAL invoice's
    // amount_due, which recalculate_invoice_accounting() already applies
    // server-side. Proforma/Estimate are quotations, never posted to the
    // books, so they're excluded the same way the backend excludes them.
    const recognized = base.filter(i =>
      i.status !== 'cancelled' && (i.invoice_type || 'tax_invoice') === 'tax_invoice'
    );
    const total_revenue = recognized.reduce((s, i) => s + (i.grand_total || 0), 0);
    const total_outstanding = recognized.reduce((s, i) => s + calcDue(i), 0);
    const total_collected = recognized.reduce((s, i) => s + calcPaid(i), 0);
    const total_gst = recognized.reduce((s, i) => s + (i.total_gst || 0), 0);
    const total_invoices = base.length;
    const month_revenue = recognized.filter(i => i.invoice_date?.startsWith(curMonth)).reduce((s, i) => s + (i.grand_total || 0), 0);
    const month_invoices = recognized.filter(i => i.invoice_date?.startsWith(curMonth)).length;
    const overdue_count = recognized.filter(i => calcDue(i) > 0 && i.due_date && differenceInDays(new Date(), parseISO(i.due_date)) > 0).length;
    const paid_count = base.filter(i => i.status === 'paid').length;
    const draft_count = base.filter(i => i.status === 'draft').length;
    const monthly_trend = Array.from({ length: 12 }, (_, i) => {
      const d = subMonths(now, 11 - i); const key = format(d, 'yyyy-MM');
      const monthInvs = recognized.filter(inv => inv.invoice_date?.startsWith(key));
      return { label: format(d, 'MMM yy'), revenue: monthInvs.reduce((s, inv) => s + (inv.grand_total || 0), 0), collected: monthInvs.reduce((s, inv) => s + calcPaid(inv), 0) };
    });
    const clientMap = {};
    recognized.forEach(inv => { if (!inv.client_name) return; clientMap[inv.client_name] = (clientMap[inv.client_name] || 0) + (inv.grand_total || 0); });
    const top_clients = Object.entries(clientMap).map(([name, revenue]) => ({ name, revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 5);
    // Self-check: Revenue must equal Collections + Outstanding. A mismatch
    // means some invoice's amount_paid/amount_due drifted from the engine
    // (e.g. a very old record it hasn't recalculated yet) — surface it in
    // the console instead of silently showing wrong totals.
    const _mismatch = Math.round((total_revenue - (total_collected + total_outstanding)) * 100) / 100;
    if (Math.abs(_mismatch) > 0.05) {
      // Find the actual offending invoice(s) instead of only logging the
      // aggregate gap — since Revenue/Collections/Outstanding are each
      // summed straight from grand_total/amount_paid/amount_due, any
      // invoice where those three don't individually add up is, by
      // construction, a source of the aggregate drift.
      const _culprits = recognized
        .map(i => {
          const grand = num(i.grand_total);
          const diff = round2(grand - (calcPaid(i) + calcDue(i)));
          return { id: i.id, invoice_number: i.invoice_number || '(no number)', grand_total: grand, amount_paid: calcPaid(i), amount_due: calcDue(i), diff };
        })
        .filter(c => Math.abs(c.diff) > 0.05)
        .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      console.warn(`[accounting-reconciliation] Revenue (${total_revenue.toFixed(2)}) != Collections (${total_collected.toFixed(2)}) + Outstanding (${total_outstanding.toFixed(2)}), diff=${_mismatch}`);
      if (_culprits.length) {
        console.warn(`[accounting-reconciliation] ${_culprits.length} invoice(s) with grand_total != amount_paid + amount_due:`, _culprits);
      } else {
        console.warn('[accounting-reconciliation] No single invoice is individually broken — likely several invoices each off by a small rounding amount that adds up. Try Verify & Fix on Accounting Reports.');
      }
    }
    return { total_revenue, total_outstanding, total_collected, total_gst, total_invoices, month_revenue, month_invoices, overdue_count, paid_count, draft_count, monthly_trend, top_clients };
  }, [invoices, companyFilter, yearFilter, companies]);

  // ── E. ALL useMemo: DERIVED DATA ──────────────────────────────────────────

  // ── useMemo: itemSuggestions — merged localStorage + live invoices for autocomplete ──
  const itemSuggestions = useMemo(() => buildItemSuggestions(invoices), [invoices]);

  const filtered = useMemo(() => {
    const fy = fyRange(yearFilter === 'all' ? null : yearFilter);
    return (invoices || []).filter(inv => {
      if (!recordBelongsToCompany(inv, companyFilter, companies)) return false;
      if (fy && (inv.invoice_date < fy.from || inv.invoice_date > fy.to)) return false;
      if (searchTerm && !inv.invoice_no?.toLowerCase().includes(searchTerm.toLowerCase()) && !inv.client_name?.toLowerCase().includes(searchTerm.toLowerCase())) return false;
      if (statusFilter === 'outstanding') {
        if (inv.status === 'paid' || inv.status === 'cancelled') return false;
        if (calcDue(inv) <= 0 && inv.status !== 'draft') return false;
      } else if (statusFilter !== 'all' && inv.status !== statusFilter) return false;
      if (listViewFilter === 'outstanding') {
        if (inv.status === 'paid' || inv.status === 'cancelled') return false;
        if (calcDue(inv) <= 0 && inv.status !== 'draft') return false;
      } else if (listViewFilter === 'received') {
        if (!(inv.status === 'paid' || (calcDue(inv) <= 0 && inv.status !== 'draft' && inv.status !== 'cancelled'))) return false;
      }
      if (typeFilter !== 'all') {
        if (inv.invoice_type !== typeFilter) return false;
      } else if (inv.invoice_type === 'proforma') {
        // Proforma Invoices are quotations, not real sales — keep them out of
        // the default "All Invoices" list. Select "Proforma Invoice" from the
        // type filter to view them separately.
        return false;
      }
      if (referrerFilter !== 'all' && getInvoiceReferrer(inv) !== referrerFilter) return false;
      if (fromDate && inv.invoice_date < fromDate) return false;
      if (toDate && inv.invoice_date > toDate) return false;
      if (gstOnlyFilter && !(Number(inv.total_gst || 0) > 0)) return false;
      return true;
    });
  }, [invoices, companyFilter, yearFilter, searchTerm, statusFilter, typeFilter, referrerFilter, getInvoiceReferrer, fromDate, toDate, listViewFilter, gstOnlyFilter, companies]);

  // ── F. ALL useMemo: TOTALS / AGGREGATIONS ────────────────────────────────

  const enrichedFiltered = useMemo(() => (filtered || []).map(inv => {
    // amount_paid / amount_due come straight from the accounting engine
    // (Invoice Amount − Payments − Credit Notes + Debit Notes); calcDue/
    // calcPaid just read those canonical fields now.
    const computedDue = calcDue(inv);
    const computedPaid = calcPaid(inv);
    const enriched = { ...inv, amount_due: computedDue, amount_paid: computedPaid };
    if (enriched.status === 'sent' && computedDue > 0 && enriched.due_date && differenceInDays(parseISO(enriched.due_date), new Date()) < 0) {
      enriched.status = 'overdue';
    }
    return enriched;
  }), [filtered]);

  const filteredUnpreparedIncomes = useMemo(() => {
    return (unpreparedIncomes || []).filter(inc => {
      // Company filter
      if (companyFilter !== 'all' && inc.company_id !== companyFilter) return false;
      
      // Date filter (from / to)
      if (fromDate && inc.date < fromDate) return false;
      if (toDate && inc.date > toDate) return false;
      
      // Year Filter
      if (yearFilter !== 'all') {
        const year = inc.date?.slice(0, 4);
        if (year !== yearFilter) return false;
      }
      
      // Search term (payer_name or description)
      if (searchTerm) {
        const term = searchTerm.toLowerCase();
        const pName = (inc.payer_name || '').toLowerCase();
        const desc = (inc.description || '').toLowerCase();
        if (!pName.includes(term) && !desc.includes(term)) return false;
      }
      
      return true;
    });
  }, [unpreparedIncomes, companyFilter, fromDate, toDate, yearFilter, searchTerm]);

  // ── paginatedFiltered: client-side page slice of enrichedFiltered ──────────
  const paginatedFiltered = useMemo(() => {
    const start = (listPage - 1) * LIST_PAGE_SIZE;
    return enrichedFiltered.slice(start, start + LIST_PAGE_SIZE);
  }, [enrichedFiltered, listPage]);

  const totalListPages = useMemo(
    () => Math.max(1, Math.ceil(enrichedFiltered.length / LIST_PAGE_SIZE)),
    [enrichedFiltered]
  );

  // ── Quick view summary counts (for pill labels) ──────────────────────────
  const outstandingCount = useMemo(() =>
    enrichedFiltered.filter(inv => inv.status !== 'paid' && (calcDue(inv) > 0 || inv.status === 'draft' || inv.status === 'cancelled')).length,
    [enrichedFiltered]
  );
  const receivedCount = useMemo(() =>
    enrichedFiltered.filter(inv => inv.status === 'paid' || (calcDue(inv) <= 0 && inv.status !== 'draft' && inv.status !== 'cancelled')).length,
    [enrichedFiltered]
  );

  // ── G. ALL useCallback (AFTER ALL MEMOS) ─────────────────────────────────

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }, []);

  // toggleSelectAll depends on enrichedFiltered — declared AFTER it ✓
  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => prev.size === enrichedFiltered.length ? new Set() : new Set(enrichedFiltered.map(i => i.id)));
  }, [enrichedFiltered]);

  // fetchAll declared before handleBulkDelete ✓
const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [invR, compR, clientR, leadR, statR, otherIncR, accountsR] = await Promise.allSettled([
        api.get('/invoices', { params: { page: 1, page_size: 5000 } }),
        fetchCompanies({ silent: false }),
        api.get('/clients', { params: { page: 1, page_size: 100 } }),
        api.get('/leads'),
        api.get('/invoices/stats'),
        api.get('/unprepared-incomes'),
        api.get('/chart-of-accounts'),
      ]);

      if (invR.status === 'fulfilled') {
        const invPayload = invR.value.data;
        setInvoices(Array.isArray(invPayload) ? invPayload : (invPayload?.invoices || []));
      } else {
        console.error('Failed to load invoices:', invR.reason);
        toast.error('Failed to load invoices');
        setInvoices([]);
      }

      if (compR.status === 'fulfilled') setCompanies(normalizeCompanies(compR.value));
      else { console.error('Failed to load companies:', compR.reason); setCompanies([]); }

      if (clientR.status === 'fulfilled') {
        // Load first page immediately, then fetch remaining pages in background
        const firstPage = clientR.value.data || [];
        setClients(firstPage);
        const PAGE_SIZE = 100;
        if (firstPage.length >= PAGE_SIZE) {
          (async () => {
            let page = 2;
            while (true) {
              try {
                const r = await api.get('/clients', { params: { page, page_size: PAGE_SIZE } });
                const batch = r.data || [];
                if (batch.length > 0) {
                  setClients(prev => {
                    const ids = new Set(prev.map(c => c.id));
                    const fresh = batch.filter(c => !ids.has(c.id));
                    return fresh.length ? [...prev, ...fresh] : prev;
                  });
                }
                if (batch.length < PAGE_SIZE) break;
                page++;
              } catch { break; }
            }
          })();
        }
      } else { console.error('Failed to load clients:', clientR.reason); setClients([]); }

      if (leadR.status === 'fulfilled') setLeads(leadR.value.data || []);
      else { console.error('Failed to load leads:', leadR.reason); setLeads([]); }

      if (statR.status === 'fulfilled') setStats(statR.value.data || null);
      else { console.error('Failed to load stats:', statR.reason); setStats(null); }

      if (otherIncR.status === 'fulfilled') {
        setUnpreparedIncomes(otherIncR.value.data || []);
      } else {
        console.error('Failed to load unprepared incomes:', otherIncR.reason);
        setUnpreparedIncomes([]);
      }

      if (accountsR.status === 'fulfilled') {
        setAccounts(accountsR.value.data || []);
      } else {
        console.error('Failed to load accounts:', accountsR.reason);
        setAccounts([]);
      }

    } catch (err) {
      console.error('fetchAll unexpected error:', err);
      toast.error('Failed to load invoicing data');
    } finally {
      setLoading(false);
    }
  }, []);

  // handleBulkDelete depends on fetchAll — declared AFTER it ✓
  const handleBulkDelete = useCallback(async () => {
    if (!selectedIds.size) return;
    if (!window.confirm(`Permanently delete ${selectedIds.size} invoice${selectedIds.size > 1 ? 's' : ''}? This cannot be undone.`)) return;
    setBulkDeleteLoading(true);
    try {
      const ids = Array.from(selectedIds);
      await api.delete('/invoices/bulk-delete', { data: ids });
      setSelectedIds(new Set());
      fetchAll();
      toast.success(`Deleted ${ids.length} invoice${ids.length > 1 ? 's' : ''}`);
    } catch {
      // fallback: delete one by one
      let deleted = 0, failed = 0;
      for (const id of selectedIds) {
        try { await api.delete(`/invoices/${id}`); deleted++; }
        catch { failed++; }
      }
      setSelectedIds(new Set());
      fetchAll();
      toast.success(`Deleted ${deleted} invoice${deleted > 1 ? 's' : ''}${failed ? ` (${failed} failed)` : ''}`);
    }
    setBulkDeleteLoading(false);
  }, [selectedIds, fetchAll]);

  const handleEdit = useCallback((inv) => { setEditingInv(inv); setFormOpen(true); }, []);

  // Duplicate: clone the invoice (no id) → opens form in "new" mode pre-filled with cloned data
  const handleDuplicateInv = useCallback((inv) => {
    const { id, invoice_no, created_at, updated_at, status_history, amount_paid, amount_due, ...rest } = inv;
    setEditingInv({
      ...rest,
      id: null,
      invoice_no: '',          // will be auto-filled when company is selected
      status: 'draft',
      amount_paid: 0,
      invoice_date: format(new Date(), 'yyyy-MM-dd'),
      due_date: '',
    });
    setFormOpen(true);
    toast.info('Duplicated — edit details and save as new invoice', { duration: 2500 });
  }, []);

  // Sale Return: open form pre-filled as Credit Note / Debit Note referencing the original invoice
  const handleSaleReturn = useCallback((inv, returnType) => {
    const { id, invoice_no, created_at, updated_at, status_history, amount_paid, amount_due, ...rest } = inv;
    const label = returnType === 'credit_note' ? 'Credit Note' : 'Debit Note';
    setEditingInv({
      ...rest,
      id: null,
      invoice_no: '',
      invoice_type: returnType,
      reference_no: invoice_no,        // human-readable reference on the note itself
      original_invoice_id: id,         // the real link the accounting engine nets against
      status: 'draft',
      amount_paid: 0,
      invoice_date: format(new Date(), 'yyyy-MM-dd'),
      due_date: '',
    });
    setFormOpen(true);
    toast.info(`${label} pre-filled from ${invoice_no} — review and save`, { duration: 2500 });
  }, []);

  const handleDelete = useCallback(async (inv) => {
    if (!window.confirm(`Delete invoice ${inv.invoice_no}?`)) return;
    try { await api.delete(`/invoices/${inv.id}`); toast.success('Invoice deleted'); fetchAll(); setDetailOpen(false); }
    catch { toast.error('Failed to delete'); }
  }, [fetchAll]);

  // Convert a Proforma Invoice into a real Tax Invoice (new invoice record,
  // proforma stays as-is with a backlink so it shows "Converted").
  const handleConvertToInvoice = useCallback(async (inv) => {
    if (inv.converted_invoice_id) {
      toast.info(`Already converted to ${inv.converted_invoice_no || 'an invoice'}`);
      return;
    }
    if (!window.confirm(`Convert Proforma ${inv.invoice_no} into a Tax Invoice?`)) return;
    try {
      toast.info('Converting to invoice…', { duration: 1500 });
      const { data } = await api.post(`/invoices/${inv.id}/convert-to-invoice`);
      toast.success(`Converted to Tax Invoice ${data.invoice_no || ''}`);
      fetchAll();
      setDetailOpen(false);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to convert to invoice');
    }
  }, [fetchAll]);

  const handleDownloadPdf = useCallback(async (inv) => {
    try {
      toast.info('Generating PDF…', { duration: 1500 });
      const invData = (inv.items?.length || 0) > 0
        ? inv
        : (await api.get(`/invoices/${inv.id}`)).data;
      const baseCompany = (companies || []).find(c => c.id === invData.company_id) || {};
      const invSettings = getInvSettings(invData.company_id);
      const company = {
        ...baseCompany,
        bank_name:        baseCompany.bank_name        || invSettings.bank_name        || '',
        bank_account_no:  baseCompany.bank_account_no  || invSettings.bank_account_no  || '',
        bank_account:     baseCompany.bank_account     || invSettings.bank_account_no  || '',
        bank_ifsc:        baseCompany.bank_ifsc        || invSettings.bank_ifsc        || '',
        bank_branch:      baseCompany.bank_branch      || invSettings.bank_branch      || '',
        upi_id:           baseCompany.upi_id           || invSettings.upi_id           || '',
        show_qr_code:     invSettings.show_qr_code     ?? true,
        invoice_title:    invSettings.invoice_title    || 'Tax Invoice',
        signatory_name:   invSettings.signatory_name   || '',
        signatory_label:  invSettings.signatory_label  || 'Authorised Signatory',
        footer_line:      invSettings.footer_line      || '',
        signature_image:  baseCompany.signature_image  || invSettings.signature_image  || '',
        logo_url:         baseCompany.logo_url         || baseCompany.logo             || '',
      };
      const html = generateInvoiceHTML(invData, {
        company,
        template:    invData.invoice_template     || invSettings.template     || 'classic',
        theme:       invData.invoice_theme        || invSettings.theme        || 'classic_blue',
        customColor: invData.invoice_custom_color || invSettings.custom_color || '#0D3B66',
      });
      const win = window.open('', '_blank', 'width=900,height=700');
      if (!win) { toast.error('Allow pop-ups to download PDF'); return; }
      win.document.write(html);
      win.document.close();
      win.onload = () => {
        // Set document title to drive browser PDF filename: ClientName_InvoiceNo
        const clientSlug = (invData.client_name || '').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
        const invoiceSlug = (invData.invoice_no || '').replace(/[\/\s]/g, '_');
        win.document.title = clientSlug ? `${clientSlug}_${invoiceSlug}` : invoiceSlug;
        win.focus();
        win.print();
      };
      toast.success(`PDF ready: ${inv.invoice_no}`);
    } catch (err) {
      console.error('PDF error:', err);
      toast.error('PDF generation failed');
    }
  }, [companies]);

  // Direct Print from actions column — opens print dialog without download flow
  const handlePrintInvoice = useCallback(async (inv) => {
    try {
      toast.info('Preparing print…', { duration: 1200 });
      const invData = (inv.items?.length || 0) > 0
        ? inv
        : (await api.get(`/invoices/${inv.id}`)).data;
      const baseCompany = (companies || []).find(c => c.id === invData.company_id) || {};
      const invSettings = getInvSettings(invData.company_id);
      const company = {
        ...baseCompany,
        bank_name:        baseCompany.bank_name        || invSettings.bank_name        || '',
        bank_account_no:  baseCompany.bank_account_no  || invSettings.bank_account_no  || '',
        bank_account:     baseCompany.bank_account     || invSettings.bank_account_no  || '',
        bank_ifsc:        baseCompany.bank_ifsc        || invSettings.bank_ifsc        || '',
        bank_branch:      baseCompany.bank_branch      || invSettings.bank_branch      || '',
        upi_id:           baseCompany.upi_id           || invSettings.upi_id           || '',
        show_qr_code:     invSettings.show_qr_code     ?? true,
        invoice_title:    invSettings.invoice_title    || 'Tax Invoice',
        signatory_name:   invSettings.signatory_name   || '',
        signatory_label:  invSettings.signatory_label  || 'Authorised Signatory',
        footer_line:      invSettings.footer_line      || '',
        signature_image:  baseCompany.signature_image  || invSettings.signature_image  || '',
        logo_url:         baseCompany.logo_url         || baseCompany.logo             || '',
      };
      const html = generateInvoiceHTML(invData, {
        company,
        template:    invData.invoice_template     || invSettings.template     || 'classic',
        theme:       invData.invoice_theme        || invSettings.theme        || 'classic_blue',
        customColor: invData.invoice_custom_color || invSettings.custom_color || '#0D3B66',
      });
      const win = window.open('', '_blank', 'width=900,height=700');
      if (!win) { toast.error('Allow pop-ups to print'); return; }
      win.document.write(html);
      win.document.close();
      win.onload = () => {
        const clientSlug = (invData.client_name || '').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
        const invoiceSlug = (invData.invoice_no || '').replace(/[\/\s]/g, '_');
        win.document.title = clientSlug ? `${clientSlug}_${invoiceSlug}` : invoiceSlug;
        win.focus();
        win.print();
      };
    } catch (err) {
      console.error('Print error:', err);
      toast.error('Print failed');
    }
  }, [companies]);

  const handleMarkSent = useCallback(async (inv) => {
    try { await api.post(`/invoices/${inv.id}/mark-sent`); fetchAll(); toast.success('Marked as sent'); } catch { toast.error('Failed'); }
  }, [fetchAll]);

  // Optimistic status update — avoids a full refetch on every dropdown change
  const handleStatusChange = useCallback((invId, newStatus, serverAmounts = {}) => {
    setInvoices(prev => prev.map(i => {
      if (i.id !== invId) return i;
      const updated = { ...i, status: newStatus };
      // Use server-returned amounts if available (backend is the source of truth)
      if (serverAmounts.amount_paid !== undefined) updated.amount_paid = serverAmounts.amount_paid;
      if (serverAmounts.amount_due  !== undefined) updated.amount_due  = serverAmounts.amount_due;
      // Fallback optimistic sync when no server amounts returned
      if (newStatus === 'paid' && serverAmounts.amount_paid === undefined) {
        updated.amount_paid = num(i.grand_total);
        updated.amount_due  = 0;
      }
      if (newStatus === 'cancelled' && serverAmounts.amount_due === undefined) {
        updated.amount_due = 0;
      }
      return updated;
    }));
  }, []);

  const [invoicePreviewOpen, setInvoicePreviewOpen] = useState(false);
  const [invoicePreviewInv, setInvoicePreviewInv]   = useState(null);
  const [invoicePreviewHtml, setInvoicePreviewHtml] = useState('');

  const buildPreviewHtml = useCallback((inv) => {
    const baseCompany = (companies || []).find(c => c.id === inv.company_id) || {};
    const invSettings = getInvSettings(inv.company_id);
    const previewCompany = {
      ...baseCompany,
      bank_name:       baseCompany.bank_name       || invSettings.bank_name       || '',
      bank_account_no: baseCompany.bank_account_no || invSettings.bank_account_no || '',
      bank_account:    baseCompany.bank_account    || invSettings.bank_account_no || '',
      bank_ifsc:       baseCompany.bank_ifsc       || invSettings.bank_ifsc       || '',
      upi_id:          baseCompany.upi_id          || invSettings.upi_id          || '',
      show_qr_code:    invSettings.show_qr_code    ?? true,
      invoice_title:   invSettings.invoice_title   || 'Tax Invoice',
      signatory_name:  invSettings.signatory_name  || '',
      footer_line:     invSettings.footer_line     || '',
      logo_url:        baseCompany.logo_url        || baseCompany.logo            || '',
      logo_base64:     baseCompany.logo_base64     || '',
    };
    return generateInvoiceHTML(inv, {
      company:     previewCompany,
      template:    inv.invoice_template     || invSettings.template     || 'classic',
      theme:       inv.invoice_theme        || invSettings.theme        || 'classic_blue',
      customColor: inv.invoice_custom_color || invSettings.custom_color || '#0D3B66',
    });
  }, [companies, getInvSettings]);

  const handlePreviewInvoice = useCallback((inv) => {
    setInvoicePreviewInv(inv);
    setInvoicePreviewHtml(buildPreviewHtml(inv));
    setInvoicePreviewOpen(true);
  }, [buildPreviewHtml]);

  const handleSendEmail = useCallback(async (inv) => {
    if (!inv.client_email) { toast.error('Client email address is missing'); return; }
    if (!window.confirm(`Send invoice ${inv.invoice_no} to ${inv.client_email}?`)) return;
    try { await api.post(`/invoices/${inv.id}/send-email`); toast.success(`Email queued for ${inv.invoice_no}`); fetchAll(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed to queue email'); }
  }, [fetchAll]);

  const handleWhatsAppInvoice = useCallback((inv) => {
    setWaInvoice(inv);
    setWaDialogOpen(true);
  }, []);

  const handleExport = useCallback(async () => {
    if (!(enrichedFiltered?.length)) { toast.error('No invoices to export'); return; }
    const rows = [['Invoice No','Type','Client','Date','Due Date','Taxable','GST','Total','Paid','Balance','Status'],
      ...enrichedFiltered.map(inv => [inv.invoice_no, INV_TYPES.find(t => t.value === inv.invoice_type)?.label || inv.invoice_type, inv.client_name, inv.invoice_date, inv.due_date, inv.total_taxable, inv.total_gst, inv.grand_total, inv.amount_paid, inv.amount_due, inv.status])];
    XLSX = await getXLSX();
    const ws = XLSX.utils.aoa_to_sheet(rows); const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Invoices');
    XLSX.writeFile(wb, `invoices_${format(new Date(), 'dd-MMM-yyyy')}.xlsx`);
    toast.success(`Exported ${enrichedFiltered.length} invoices`);
  }, [enrichedFiltered]);

  // ── H. ALL useEffect ──────────────────────────────────────────────────────

  useEffect(() => { const t = setTimeout(() => { setSearchTerm(searchInput); setListPage(1); setOutstandingPage(1); setReceivedPage(1); }, 250); return () => clearTimeout(t); }, [searchInput]);

  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'n' && !formOpen && !detailOpen && !payOpen && !gstOpen && document.activeElement.tagName === 'BODY') setFormOpen(true);
    };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  }, [formOpen, detailOpen, payOpen, gstOpen]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── referrers list ────────────────────────────────────────────────────────
  // Uses the SAME saved-referrer list as the Clients page (/referrers) so the
  // "Referred By" options are identical on both screens, instead of deriving
  // them from raw client.referred_by values (which can contain stray/legacy
  // entries such as a phone number typed directly into a client record).
  useEffect(() => {
    api.get('/referrers')
      .then(r => setSavedReferrers((r.data || []).map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean)))
      .catch(() => {
        try { setSavedReferrers(JSON.parse(localStorage.getItem('taskosphere_referrers') || '[]').map(x => (typeof x === 'string' ? x : x.name)).filter(Boolean)); }
        catch { setSavedReferrers([]); }
      });
  }, []);

  // Deep-link: when navigated with ?invoice_id=… (e.g. just-converted from a
  // quotation), open that invoice's detail drawer as soon as it's loaded.
  useEffect(() => {
    if (loading) return;
    const params = new URLSearchParams(window.location.search);
    const targetId = params.get('invoice_id');
    if (!targetId) return;
    const target = invoices.find(i => i.id === targetId);
    if (target) {
      setDetailInv(target);
      setDetailOpen(true);
      // Clean the URL so refresh doesn't keep re-opening it.
      const url = new URL(window.location.href);
      url.searchParams.delete('invoice_id');
      window.history.replaceState({}, '', url.toString());
    }
  }, [loading, invoices]);

  const handleSaveIncome = async (e) => {
    e.preventDefault();
    if (!incomeForm.company_id) { toast.error('Please select a company'); return; }
    if (!incomeForm.date) { toast.error('Please select a date'); return; }
    if (!incomeForm.amount || parseFloat(incomeForm.amount) <= 0) { toast.error('Please enter a valid amount'); return; }
    if (!incomeForm.payer_name) { toast.error('Please enter a payer name'); return; }
    if (!incomeForm.receipt_account_id) { toast.error('Please select a receipt ledger account'); return; }
    if (!incomeForm.income_account_id) { toast.error('Please select an income ledger account'); return; }

    try {
      const payload = {
        ...incomeForm,
        amount: parseFloat(incomeForm.amount),
      };
      if (editingIncome) {
        await api.put(`/unprepared-incomes/${editingIncome.id}`, payload);
        toast.success('Direct income updated successfully');
      } else {
        await api.post('/unprepared-incomes', payload);
        toast.success('Direct income recorded successfully');
      }
      setIncomeFormOpen(false);
      setEditingIncome(null);
      setIncomeForm({
        company_id: '',
        date: new Date().toISOString().slice(0, 10),
        amount: '',
        payer_name: '',
        description: '',
        receipt_account_id: '',
        income_account_id: '',
      });
      fetchAll();
    } catch (err) {
      console.error(err);
      toast.error(err?.response?.data?.detail || 'Failed to save direct income');
    }
  };

  const handleDeleteIncome = async (incomeId) => {
    if (!window.confirm('Are you sure you want to delete this direct income record?')) return;
    try {
      await api.delete(`/unprepared-incomes/${incomeId}`);
      toast.success('Direct income deleted');
      fetchAll();
    } catch (err) {
      console.error(err);
      toast.error('Failed to delete direct income');
    }
  };

  // Reset list page whenever filters or search change
  useEffect(() => { setListPage(1); setOutstandingPage(1); setReceivedPage(1); }, [statusFilter, typeFilter, companyFilter, yearFilter, fromDate, toDate, searchTerm, gstOnlyFilter]);

  // ── I. JSX return ─────────────────────────────────────────────────────────

  return (
    <div className={`min-h-full space-y-5 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>
      {/* PAGE HEADER */}
      <div className="relative overflow-hidden rounded-2xl shadow-sm" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 60%, #1a8fcc 100%)` }}>
        <div className="absolute right-0 top-0 w-72 h-72 rounded-full -mr-24 -mt-24 opacity-10" style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
        <div className="relative flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-4 sm:px-6 pt-4 sm:pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/15 backdrop-blur-sm border border-white/20 flex-shrink-0"><Receipt className="h-5 w-5 text-white" /></div>
            <div><h1 className="text-2xl font-bold text-white tracking-tight leading-tight">Invoicing & Billing</h1><p className="text-sm text-blue-200 mt-0.5">GST-compliant · Smart client search · GSTR reports · Email invoices · <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-white/20 font-mono">Ctrl+K</kbd> · <kbd className="px-1.5 py-0.5 rounded text-[10px] bg-white/20 font-mono">N</kbd> new</p></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setLedgerClient(null); setLedgerOpen(true); }} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm font-semibold"><BookOpen className="h-4 w-4" /> Party Ledger</Button>
            <Button variant="outline" onClick={() => setGstOpen(true)} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm font-semibold"><FileSpreadsheet className="h-4 w-4" /> GST Returns</Button>
            <Button variant="outline" onClick={() => setSettingsOpen(true)} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm font-semibold"><Settings className="h-4 w-4" /> Settings</Button>
            <Button variant="outline" onClick={() => setImportOpen(true)} className="h-9 px-4 text-sm bg-emerald-500/20 border-emerald-300/40 text-white hover:bg-emerald-500/30 rounded-xl gap-2 backdrop-blur-sm font-semibold"><Database className="h-4 w-4" /> Import</Button>
            <Button variant="outline" onClick={downloadInvoiceTemplate} className="h-9 px-4 text-sm bg-amber-500/20 border-amber-300/40 text-white hover:bg-amber-500/30 rounded-xl gap-2 backdrop-blur-sm font-semibold"><FileDown className="h-4 w-4" /> Template</Button>
            <Button variant="outline" onClick={() => setCatOpen(true)} className="h-9 px-4 text-sm bg-white/15 border-white/30 text-white hover:bg-white/25 rounded-xl gap-2 backdrop-blur-sm font-semibold"><Layers className="h-4 w-4" /> Service Catalog</Button>
            <Button variant="outline" onClick={handleExport} className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm"><Download className="h-4 w-4" /> Export</Button>
            <Button variant="outline" onClick={() => setBulkWAOpen(true)} className="h-9 px-4 text-sm bg-emerald-600/30 border-emerald-400/40 text-white hover:bg-emerald-600/50 rounded-xl gap-2 backdrop-blur-sm font-semibold"><MessageCircle className="h-4 w-4" /> Bulk WA</Button>
            <Button onClick={() => { setEditingInv(null); setFormOpen(true); }} className="h-9 px-5 text-sm rounded-xl bg-white text-slate-800 hover:bg-blue-50 shadow-sm gap-2 font-semibold border-0"><Plus className="h-4 w-4" /> New Invoice</Button>
          </div>
        </div>
      </div>

      {/* STATS */}
      {((localStats?.total_invoices || 0) > 0 || (invoices?.length || 0) > 0) && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Revenue" value={fmtC(localStats.total_revenue)} sub={`${localStats.total_invoices} invoices`} icon={IndianRupee} color={COLORS.mediumBlue} bg={`${COLORS.mediumBlue}12`} isDark={isDark} onClick={() => { setStatusFilter('all'); setFromDate(''); setToDate(''); setTimeout(() => invoiceListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }} />
          <StatCard label="Outstanding" value={fmtC(localStats.total_outstanding)} sub={`${localStats.overdue_count} overdue`} icon={AlertCircle} color={COLORS.coral} bg={`${COLORS.coral}15`} isDark={isDark} onClick={() => { setStatusFilter('outstanding'); setFromDate(''); setToDate(''); setTimeout(() => invoiceListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }} />
          <StatCard label="This Month" value={fmtC(localStats.month_revenue)} sub={`${localStats.month_invoices} invoices`} icon={TrendingUp} color={COLORS.emeraldGreen} bg={`${COLORS.emeraldGreen}12`} isDark={isDark}
            onClick={() => {
              const now = new Date();
              const first = format(new Date(now.getFullYear(), now.getMonth(), 1), 'yyyy-MM-dd');
              const last  = format(new Date(now.getFullYear(), now.getMonth() + 1, 0), 'yyyy-MM-dd');
              setFromDate(first); setToDate(last); setStatusFilter('all'); setYearFilter('all');
              setTimeout(() => invoiceListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
            }} />
          <div className={gstOnlyFilter ? "ring-2 ring-amber-500 rounded-2xl shadow-md transition-all scale-[1.01]" : "transition-all"}>
            <StatCard label="Total GST" value={fmtC(localStats.total_gst)} sub={`${localStats.paid_count} paid · ${localStats.draft_count} invoiced`} icon={Shield} color={COLORS.amber} bg={`${COLORS.amber}12`} isDark={isDark} onClick={() => { setGstOnlyFilter(prev => !prev); setTimeout(() => invoiceListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80); }} />
          </div>
        </div>
      )}

      {localStats?.monthly_trend?.some(d => d.revenue > 0) && (
        <EnhancedRevenueTrend invoices={invoices || []} isDark={isDark} />
      )}

      {/* TABS FOR INVOICES VS OTHER DIRECT INCOME */}
      <div className="flex border-b border-slate-200 dark:border-slate-700 space-x-1 mt-4">
        <button
          onClick={() => { setActiveSubTab('invoices'); setSearchInput(''); setSearchTerm(''); }}
          className={`px-5 py-2.5 text-sm font-bold border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === 'invoices'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400 font-extrabold'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
          }`}
        >
          <Receipt className="h-4 w-4" /> Prepared Invoices ({invoices.length})
        </button>
        <button
          onClick={() => { setActiveSubTab('other_income'); setSearchInput(''); setSearchTerm(''); }}
          className={`px-5 py-2.5 text-sm font-bold border-b-2 transition-all flex items-center gap-2 ${
            activeSubTab === 'other_income'
              ? 'border-blue-500 text-blue-600 dark:text-blue-400 font-extrabold'
              : 'border-transparent text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
          }`}
        >
          <IndianRupee className="h-4 w-4" /> Direct Income / No Invoice ({unpreparedIncomes.length})
        </button>
      </div>

      {activeSubTab === 'invoices' ? (
        <>
          {/* FILTERS */}
      <div className={`rounded-2xl border shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
        <div className={`flex items-center gap-3 px-3.5 py-3 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <Input ref={searchRef} placeholder="Search invoice no. or client… (Ctrl+K)" className={`pl-10 h-9 border-none focus-visible:ring-1 focus-visible:ring-blue-300 rounded-xl text-sm ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`} value={searchInput} onChange={e => setSearchInput(e.target.value)} />
            {searchInput && <button onClick={() => setSearchInput('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-3.5 w-3.5" /></button>}
          </div>
          <div className={`h-9 px-3 flex items-center rounded-xl text-xs font-bold border whitespace-nowrap flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>{enrichedFiltered.length} <span className="ml-1 font-normal text-slate-400">invoices</span></div>
        </div>
        <div className="flex items-center gap-2 px-3.5 py-2.5 overflow-x-auto scrollbar-none flex-wrap">
          {(companies?.length || 0) > 1 && (
            <Select value={companyFilter} onValueChange={setCompanyFilter}><SelectTrigger className={`h-9 w-[160px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-blue-50 text-blue-700'}`}><Building2 className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Companies</SelectItem>{(companies || []).map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select>
          )}
          <Select value={yearFilter} onValueChange={setYearFilter}><SelectTrigger className={`h-9 w-[130px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><CalendarDays className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Years</SelectItem>{availableYears.map(y => <SelectItem key={y} value={y}>FY {y}-{String(parseInt(y) + 1).slice(2)}</SelectItem>)}</SelectContent></Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className={`h-9 w-[130px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Status</SelectItem><SelectItem value="outstanding">Outstanding</SelectItem>{Object.entries(STATUS_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent></Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}><SelectTrigger className={`h-9 w-[130px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All Types</SelectItem>{INV_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent></Select>
          {savedReferrers.length > 0 && (
            <Select value={referrerFilter} onValueChange={setReferrerFilter}><SelectTrigger className={`h-9 w-[150px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-violet-50 text-violet-700'}`}><Share2 className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" /><SelectValue placeholder="Referred By" /></SelectTrigger><SelectContent><SelectItem value="all">All Referrers</SelectItem>{savedReferrers.map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent></Select>
          )}
          <button onClick={() => setReferralSummaryOpen(true)} className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center gap-1.5 flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-200 hover:bg-slate-600' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
            <Share2 className="h-3.5 w-3.5" /> By Referral
          </button>
          <div className="flex items-center gap-1.5">
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className={`h-9 px-2 rounded-xl text-xs border ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 [color-scheme:dark]' : 'bg-white border-slate-200'}`} />
            <span className="text-slate-400 text-xs">–</span>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className={`h-9 px-2 rounded-xl text-xs border ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 [color-scheme:dark]' : 'bg-white border-slate-200'}`} />
          </div>
          {(statusFilter !== 'all' || typeFilter !== 'all' || companyFilter !== 'all' || yearFilter !== 'all' || referrerFilter !== 'all' || fromDate || toDate) && (
            <button onClick={() => { setStatusFilter('all'); setTypeFilter('all'); setCompanyFilter('all'); setYearFilter('all'); setReferrerFilter('all'); setFromDate(''); setToDate(''); }} className="h-9 px-3 rounded-xl text-xs font-semibold text-red-500 hover:bg-red-50 flex items-center gap-1"><X className="h-3 w-3" /> Clear</button>
          )}
        </div>
        {selectedIds.size > 0 && (
          <div className={`px-4 py-2.5 border-t flex items-center gap-3 flex-wrap ${isDark ? 'border-slate-700 bg-blue-900/20' : 'border-blue-100 bg-blue-50/60'}`}>
            <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${isDark ? 'bg-blue-900/40 text-blue-300' : 'bg-blue-100 text-blue-700'}`}>
              <CheckSquare className="h-3 w-3" />
              {selectedIds.size} invoice{selectedIds.size > 1 ? 's' : ''} selected
            </div>
            <button
              onClick={() => setSelectedIds(new Set(enrichedFiltered.map(i => i.id)))}
              className={`text-xs font-semibold px-2.5 py-1 rounded-full transition-colors ${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100'}`}>
              Select all {enrichedFiltered.length}
            </button>
            <Button size="sm" variant="ghost" onClick={handleBulkDelete} disabled={bulkDeleteLoading}
              className="h-7 px-3 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg gap-1.5 font-semibold">
              {bulkDeleteLoading ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
              Delete {selectedIds.size} invoice{selectedIds.size > 1 ? 's' : ''}
            </Button>
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-400 hover:text-slate-600 ml-auto flex items-center gap-1">
              <X className="h-3 w-3" /> Clear selection
            </button>
          </div>
        )}
      </div>

      {/* INVOICE LIST — unified with pill filter */}
      <div ref={invoiceListRef} className="scroll-mt-4" />
      {/* ── Active-filter banner ── */}
      {(statusFilter !== 'all' || fromDate || toDate || gstOnlyFilter) && (
        <div className={`flex items-center gap-3 px-4 py-2.5 rounded-xl border ${
          isDark ? 'bg-slate-800 border-slate-700' : 'bg-blue-50 border-blue-100'
        }`}>
          <Filter className="h-3.5 w-3.5 text-blue-500 flex-shrink-0" />
          <div className="flex items-center gap-2 flex-wrap flex-1">
            {statusFilter !== 'all' && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-blue-500 text-white">
                {statusFilter === 'outstanding' ? '⚠ Outstanding' : STATUS_META[statusFilter]?.label || statusFilter}
              </span>
            )}
            {(fromDate || toDate) && (
              <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                isDark ? 'bg-emerald-900/40 text-emerald-300' : 'bg-emerald-100 text-emerald-700'
              }`}>
                📅 {fromDate || '…'} → {toDate || '…'}
              </span>
            )}
            {gstOnlyFilter && (
              <span className="text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-500 text-white flex items-center gap-1">
                <Shield className="w-3 h-3" /> GST Only
              </span>
            )}
            <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {enrichedFiltered.length} invoice{enrichedFiltered.length !== 1 ? 's' : ''} match
            </span>
            {gstOnlyFilter && (
              <button
                type="button"
                onClick={handleExport}
                className="ml-auto text-xs font-bold px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 rounded-xl transition-colors cursor-pointer"
                title="Download GST Invoices"
              >
                <Download className="w-3.5 h-3.5" /> Download GST Invoices (Excel)
              </button>
            )}
          </div>
          <button onClick={() => { setStatusFilter('all'); setFromDate(''); setToDate(''); setGstOnlyFilter(false); }}
            className="text-xs text-slate-400 hover:text-red-500 font-semibold flex-shrink-0 transition-colors">✕ Clear filter</button>
        </div>
      )}
      {loading ? (
        <MiniLoader height={350} />
      ) : enrichedFiltered.length === 0 ? (
        <div className={`rounded-2xl border p-16 text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-4" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}20, ${COLORS.mediumBlue}20)` }}>
            <Receipt className="h-8 w-8" style={{ color: COLORS.mediumBlue }} />
          </div>
          <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>No invoices found</h3>
          <p className={`text-sm mb-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {searchTerm || statusFilter !== 'all' || typeFilter !== 'all' || fromDate || toDate ? 'No invoices match the current filter' : 'Create your first GST invoice'}
          </p>
          <Button onClick={() => { setEditingInv(null); setFormOpen(true); }} className="h-10 px-6 rounded-xl text-white gap-2" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
            <Plus className="h-4 w-4" /> New Invoice
          </Button>
        </div>
      ) : (
        <div className={`rounded-2xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          {/* ── Single unified list — receive/outstanding via filter dropdown ── */}
          <div className={`flex items-center gap-3 px-5 py-2.5 border-b ${isDark ? 'border-slate-700 bg-slate-700/20' : 'border-slate-100 bg-slate-50/60'}`}>
            <span className={`text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Filter</span>
            <Select value={listViewFilter} onValueChange={(v) => { setListViewFilter(v); setListPage(1); }}>
              <SelectTrigger className={`h-8 w-[180px] rounded-lg text-xs font-semibold border-none ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white text-slate-700'}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Invoices ({enrichedFiltered.length})</SelectItem>
                <SelectItem value="outstanding">Outstanding ({outstandingCount})</SelectItem>
                <SelectItem value="received">Received ({receivedCount})</SelectItem>
              </SelectContent>
            </Select>
            <div className="ml-auto flex items-center gap-4 text-xs">
              <span className={`font-bold ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                {fmtC(enrichedFiltered.reduce((s, i) => s + calcDue(i), 0))} due
              </span>
              <span className={`font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                {fmtC(enrichedFiltered.reduce((s, i) => s + calcPaid(i), 0))} collected
              </span>
            </div>
          </div>

          {/* ── Table ── */}
          <div className="overflow-x-auto">
            <table className="w-full" style={{minWidth:700}}>
              <thead>
                <tr className={`border-b ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50/60'}`}>
                  <th className="w-1 p-0" style={{ width: 4, padding: 0 }} />
                  <th className={`px-3 py-3 text-left text-[10px] font-bold uppercase tracking-wider w-10 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Sr</th>
                  <th className="px-4 py-3 w-10" onClick={e => e.stopPropagation()}>
                    <input type="checkbox"
                      className="w-4 h-4 rounded cursor-pointer accent-blue-600"
                      checked={enrichedFiltered.length > 0 && enrichedFiltered.every(i => selectedIds.has(i.id))}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  {['Invoice', 'Client', 'Date', 'Type', 'Amount', 'Status', 'Actions'].map(h => (
                    <th key={h} className={`px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {paginatedFiltered.map((inv, idx) => {
                  const srNo = (listPage - 1) * LIST_PAGE_SIZE + idx + 1;
                  const isSelected = selectedIds.has(inv.id);
                  const due = calcDue(inv);
                  const paid = calcPaid(inv);
                  const isReceived = inv.status === 'paid' || (due <= 0 && inv.status !== 'draft' && inv.status !== 'cancelled');
                  return (
                  <tr key={inv.id}
                    className={`border-b last:border-0 transition-colors cursor-pointer relative ${isSelected ? (isDark ? 'bg-blue-900/20' : 'bg-blue-50/60') : (isDark ? 'border-slate-700 hover:bg-slate-700/30' : 'border-slate-50 hover:bg-slate-50')}`}
                    onClick={() => { setDetailInv(inv); setDetailOpen(true); }}>
                    <td className="w-1 p-0" style={{ width: 4, padding: 0 }}>
                      <div style={{ width: 4, minHeight: 48, background: getCompanyStripColor(inv.company_id, companies), borderRadius: '0 4px 4px 0' }} />
                    </td>
                    <td className={`px-3 py-3.5 text-xs font-mono w-10 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{srNo}</td>
                    <td className="px-4 py-3.5 w-10" onClick={e => e.stopPropagation()}>
                      <input type="checkbox" className="w-4 h-4 rounded cursor-pointer accent-blue-600" checked={isSelected} onChange={() => toggleSelect(inv.id)} />
                    </td>
                    <td className="px-4 py-3.5">
                      <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                        <Hl text={inv.invoice_no || '—'} query={searchTerm} />
                      </p>
                      {(() => { const co = (companies||[]).find(c=>c.id===inv.company_id); return co ? (
                        <p className="text-[10px] mt-0.5 font-semibold truncate max-w-[180px]" style={{color: getCompanyStripColor(inv.company_id, companies)}}>{co.name}</p>
                      ) : null; })()}
                      {inv.reference_no && <p className="text-[10px] text-slate-400 mt-0.5">Ref: {inv.reference_no}</p>}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ background: avatarGrad(inv.client_name) }}>
                          {(inv.client_name || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className={`text-sm font-medium truncate max-w-[180px] ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
                            <Hl text={inv.client_name || '—'} query={searchTerm} />
                          </p>
                          {inv.client_gstin && <p className="text-[10px] text-slate-400 font-mono truncate">{inv.client_gstin}</p>}
                          {getInvoiceReferrer(inv) && (
                            <p className={`text-[10px] flex items-center gap-1 mt-0.5 truncate max-w-[180px] ${isDark ? 'text-violet-300' : 'text-violet-600'}`}>
                              <Share2 className="h-2.5 w-2.5 flex-shrink-0" /> Ref: {getInvoiceReferrer(inv)}
                            </p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{inv.invoice_date}</p>
                      {inv.due_date && <p className="text-[10px] text-slate-400">Due: {inv.due_date}</p>}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-100 text-slate-600'}`}>
                        {INV_TYPES.find(t => t.value === inv.invoice_type)?.label || inv.invoice_type}
                      </span>
                    </td>
                    <td className="px-4 py-3.5">
                      <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{fmtC(inv.grand_total)}</p>
                      {isReceived ? (
                        <p className={`text-[10px] font-semibold mt-0.5 inline-block px-1.5 py-0.5 rounded ${isDark ? 'bg-emerald-900/30 text-emerald-400' : 'bg-emerald-50 text-emerald-600'}`}>
                          Paid in full
                        </p>
                      ) : due > 0.009 ? (
                        <>
                          <p className={`text-[10px] font-bold mt-0.5 inline-block px-1.5 py-0.5 rounded ${isDark ? 'bg-red-900/30' : 'bg-red-50'}`}
                            style={{ color: getInvoiceStripe(inv).color }}
                            title={paid > 0.009 ? `Advance/Paid: ${fmtC(paid)}  •  Outstanding: ${fmtC(due)}` : `Outstanding: ${fmtC(due)}`}>
                            Due: {fmtC(due)}
                          </p>
                          {paid > 0.009 && (
                            <p className={`text-[10px] font-medium mt-0.5 ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>Adv: {fmtC(paid)}</p>
                          )}
                        </>
                      ) : null}
                    </td>
                    <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
                      <InlineStatusDropdown inv={inv} onStatusChange={handleStatusChange} isDark={isDark} />
                    </td>
                    <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        <button onClick={() => { setEditingInv(inv); setFormOpen(true); }} title="Edit" className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-blue-400 hover:bg-blue-900/30' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'}`}><Edit className="h-3.5 w-3.5" /></button>
                        <button onClick={() => handleDuplicateInv(inv)} title="Duplicate" className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-purple-400 hover:bg-purple-900/30' : 'text-slate-400 hover:text-purple-600 hover:bg-purple-50'}`}><Copy className="h-3.5 w-3.5" /></button>
                        {inv.invoice_type === 'proforma' && (
                          <button
                            onClick={() => handleConvertToInvoice(inv)}
                            title={inv.converted_invoice_id ? `Converted to ${inv.converted_invoice_no}` : 'Convert to Tax Invoice'}
                            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                              inv.converted_invoice_id
                                ? (isDark ? 'text-emerald-400' : 'text-emerald-600')
                                : (isDark ? 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-900/30' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50')
                            }`}>
                            {inv.converted_invoice_id ? <Check className="h-3.5 w-3.5" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
                          </button>
                        )}
                        <button onClick={() => handleDownloadPdf(inv)} title="Download PDF" className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-900/30' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}><Download className="h-3.5 w-3.5" /></button>
                        <button onClick={() => handlePrintInvoice(inv)} title="Print Invoice" className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-indigo-400 hover:bg-indigo-900/30' : 'text-slate-400 hover:text-indigo-600 hover:bg-indigo-50'}`}><Printer className="h-3.5 w-3.5" /></button>
                        <button
                          onClick={() => handleWhatsAppInvoice(inv)}
                          title={inv.client_phone ? 'Send Invoice via WhatsApp' : 'Send via WhatsApp (no phone saved)'}
                          className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors`}
                          style={{
                            color: inv.client_phone ? '#25D366' : (isDark ? '#475569' : '#94a3b8'),
                            background: inv.client_phone ? (isDark ? 'rgba(37,211,102,0.12)' : 'rgba(37,211,102,0.08)') : 'transparent',
                          }}>
                          <MessageCircle className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => handleDelete(inv)} title="Delete" className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-red-400 hover:bg-red-900/30' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {/* ── Pagination ── */}
          {totalListPages > 1 && (
            <div className={`flex items-center justify-between px-5 py-3 border-t ${
              isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-100 bg-slate-50/40'
            }`}>
              <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Showing {((listPage - 1) * LIST_PAGE_SIZE) + 1}–{Math.min(listPage * LIST_PAGE_SIZE, enrichedFiltered.length)} of {enrichedFiltered.length}
              </span>
              <div className="flex items-center gap-1">
                <button disabled={listPage === 1} onClick={() => setListPage(p => Math.max(1, p - 1))}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-colors disabled:opacity-30 ${isDark ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>‹</button>
                {Array.from({ length: totalListPages }, (_, i) => i + 1)
                  .filter(p => p === 1 || p === totalListPages || Math.abs(p - listPage) <= 1)
                  .reduce((acc, p, idx, arr) => { if (idx > 0 && p - arr[idx - 1] > 1) acc.push('...'); acc.push(p); return acc; }, [])
                  .map((p, i) => p === '...' ? (
                    <span key={`pg-ellipsis-${i}`} className="px-1 text-xs text-slate-400">…</span>
                  ) : (
                    <button key={p} onClick={() => setListPage(p)}
                      className={`w-7 h-7 rounded-lg text-xs font-bold transition-colors ${listPage === p ? 'text-white shadow-sm' : isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-100'}`}
                      style={listPage === p ? { background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` } : {}}
                    >{p}</button>
                  ))}
                <button disabled={listPage === totalListPages} onClick={() => setListPage(p => Math.min(totalListPages, p + 1))}
                  className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-colors disabled:opacity-30 ${isDark ? 'hover:bg-slate-700 text-slate-300' : 'hover:bg-slate-100 text-slate-600'}`}>›</button>
              </div>
            </div>
          )}
        </div>
      )}
        </>
      ) : (
        /* OTHER INCOME RENDERING SECTION */
        <div className="space-y-4">
          {/* STATS HEADER FOR OTHER INCOME */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className={`rounded-2xl p-5 border shadow-sm flex items-center gap-4 ${isDark ? 'bg-slate-800/60 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-emerald-500/10">
                <IndianRupee className="h-6 w-6 text-emerald-500" />
              </div>
              <div>
                <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Total Direct Income</p>
                <h3 className={`text-xl font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                  {fmtC(filteredUnpreparedIncomes.reduce((acc, x) => acc + (x.amount || 0), 0))}
                </h3>
                <p className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{filteredUnpreparedIncomes.length} Direct records</p>
              </div>
              <Button
                onClick={() => {
                  setEditingIncome(null);
                  setIncomeForm({
                    company_id: companies?.[0]?.id || '',
                    date: new Date().toISOString().slice(0, 10),
                    amount: '',
                    payer_name: '',
                    description: '',
                    receipt_account_id: accounts.find(a => a.type === 'asset' && a.code === 1010)?.id || accounts.find(a => a.type === 'asset')?.id || '',
                    income_account_id: accounts.find(a => a.type === 'income' && a.code === 4000)?.id || accounts.find(a => a.type === 'income')?.id || '',
                  });
                  setIncomeFormOpen(true);
                }}
                className="ml-auto h-9 px-4 rounded-xl text-white gap-1.5"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
              >
                <Plus className="h-4 w-4" /> Record Direct Income
              </Button>
            </div>
          </div>

          {/* OTHER INCOME FILTERS */}
          <div className={`rounded-2xl border shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
            <div className={`flex items-center gap-3 px-3.5 py-3 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                <Input
                  placeholder="Search payer name or description..."
                  className={`pl-10 h-9 border-none focus-visible:ring-1 focus-visible:ring-blue-300 rounded-xl text-sm ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                />
                {searchInput && <button onClick={() => setSearchInput('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"><X className="h-3.5 w-3.5" /></button>}
              </div>
              <div className={`h-9 px-3 flex items-center rounded-xl text-xs font-bold border whitespace-nowrap flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                {filteredUnpreparedIncomes.length} <span className="ml-1 font-normal text-slate-400">records</span>
              </div>
            </div>
            <div className="flex items-center gap-2 px-3.5 py-2.5 overflow-x-auto scrollbar-none flex-wrap">
              {(companies?.length || 0) > 1 && (
                <Select value={companyFilter} onValueChange={setCompanyFilter}>
                  <SelectTrigger className={`h-9 w-[160px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-blue-50 text-blue-700'}`}>
                    <Building2 className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Companies</SelectItem>
                    {(companies || []).map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Select value={yearFilter} onValueChange={setYearFilter}>
                <SelectTrigger className={`h-9 w-[130px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}>
                  <CalendarDays className="h-3.5 w-3.5 mr-1.5 flex-shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Years</SelectItem>
                  {availableYears.map(y => <SelectItem key={y} value={y}>FY {y}-{String(parseInt(y) + 1).slice(2)}</SelectItem>)}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className={`h-9 px-2 rounded-xl text-xs border ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 [color-scheme:dark]' : 'bg-white border-slate-200'}`} />
                <span className="text-slate-400 text-xs">–</span>
                <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className={`h-9 px-2 rounded-xl text-xs border ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 [color-scheme:dark]' : 'bg-white border-slate-200'}`} />
              </div>
              {(companyFilter !== 'all' || yearFilter !== 'all' || fromDate || toDate) && (
                <button onClick={() => { setCompanyFilter('all'); setYearFilter('all'); setFromDate(''); setToDate(''); }} className="h-9 px-3 rounded-xl text-xs font-semibold text-red-500 hover:bg-red-50 flex items-center gap-1"><X className="h-3 w-3" /> Clear</button>
              )}
            </div>
          </div>

          {/* LIST */}
          {filteredUnpreparedIncomes.length === 0 ? (
            <div className={`rounded-2xl border p-16 text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-4 bg-emerald-500/10">
                <IndianRupee className="h-8 w-8 text-emerald-500" />
              </div>
              <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>No direct income records</h3>
              <p className={`text-sm mb-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {searchTerm || companyFilter !== 'all' || yearFilter !== 'all' || fromDate || toDate ? 'No records match the current filters' : 'Record direct income whose invoice is not prepared'}
              </p>
              <Button
                onClick={() => {
                  setEditingIncome(null);
                  setIncomeForm({
                    company_id: companies?.[0]?.id || '',
                    date: new Date().toISOString().slice(0, 10),
                    amount: '',
                    payer_name: '',
                    description: '',
                    receipt_account_id: accounts.find(a => a.type === 'asset' && a.code === 1010)?.id || accounts.find(a => a.type === 'asset')?.id || '',
                    income_account_id: accounts.find(a => a.type === 'income' && a.code === 4000)?.id || accounts.find(a => a.type === 'income')?.id || '',
                  });
                  setIncomeFormOpen(true);
                }}
                className="h-10 px-6 rounded-xl text-white gap-2"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
              >
                <Plus className="h-4 w-4" /> Record Direct Income
              </Button>
            </div>
          ) : (
            <div className={`rounded-2xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse" style={{ minWidth: 700 }}>
                  <thead>
                    <tr className={`border-b text-[11px] font-bold uppercase tracking-wider ${isDark ? 'bg-slate-800/40 border-slate-700 text-slate-400' : 'bg-slate-50/70 border-slate-100 text-slate-500'}`}>
                      <th className="p-4">Date</th>
                      <th className="p-4">Company</th>
                      <th className="p-4">Payer</th>
                      <th className="p-4 text-right">Amount</th>
                      <th className="p-4">Receipt (Asset Account)</th>
                      <th className="p-4">Category (Income Head)</th>
                      <th className="p-4">Description</th>
                      <th className="p-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUnpreparedIncomes.map(inc => {
                      const co = companies.find(c => c.id === inc.company_id);
                      const rcAcc = accounts.find(a => a.id === inc.receipt_account_id);
                      const incAcc = accounts.find(a => a.id === inc.income_account_id);
                      return (
                        <tr key={inc.id} className={`border-b last:border-0 transition-colors ${isDark ? 'border-slate-700 hover:bg-slate-700/30' : 'border-slate-50 hover:bg-slate-50/50'}`}>
                          <td className="p-4 text-sm font-semibold">{fmtDate(inc.date)}</td>
                          <td className="p-4 text-xs font-semibold">
                            <span className="px-2 py-1 rounded bg-blue-500/10 text-blue-500 border border-blue-500/20">
                              {co ? co.name : 'Unknown Company'}
                            </span>
                          </td>
                          <td className="p-4 text-sm font-semibold">{inc.payer_name}</td>
                          <td className="p-4 text-sm font-bold text-right text-emerald-600 dark:text-emerald-400">{fmtC(inc.amount)}</td>
                          <td className="p-4 text-xs font-medium text-slate-500">
                            {rcAcc ? `${rcAcc.name} (${rcAcc.code})` : '—'}
                          </td>
                          <td className="p-4 text-xs font-medium text-slate-500">
                            {incAcc ? `${incAcc.name} (${incAcc.code})` : '—'}
                          </td>
                          <td className="p-4 text-xs text-slate-400 max-w-xs truncate" title={inc.description}>{inc.description || '—'}</td>
                          <td className="p-4 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => {
                                  setEditingIncome(inc);
                                  setIncomeForm({
                                    company_id: inc.company_id,
                                    date: inc.date,
                                    amount: String(inc.amount),
                                    payer_name: inc.payer_name,
                                    description: inc.description || '',
                                    receipt_account_id: inc.receipt_account_id,
                                    income_account_id: inc.income_account_id,
                                  });
                                  setIncomeFormOpen(true);
                                }}
                                title="Edit"
                                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-blue-400 hover:bg-blue-900/30' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'}`}
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDeleteIncome(inc.id)}
                                title="Delete"
                                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-red-400 hover:bg-red-900/30' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* MODALS */}
      <InvoiceForm
        open={formOpen}
        onClose={() => { setFormOpen(false); setEditingInv(null); }}
        editingInv={editingInv}
        companies={companies}
        clients={clients}
        leads={leads}
        onSuccess={fetchAll}
        isDark={isDark}
        itemSuggestions={itemSuggestions}
      />
      <InvoiceDetailPanel
        invoice={detailInv}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onPayment={inv => { setPayInv(inv); setPayOpen(true); }}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onDownloadPdf={handleDownloadPdf}
        onSendEmail={handleSendEmail}
        onWhatsApp={handleWhatsAppInvoice}
        onPreview={handlePreviewInvoice}
        onDuplicate={handleDuplicateInv}
        onSaleReturn={handleSaleReturn}
        isDark={isDark}
        companies={companies}
      />
      <PaymentModal
        invoice={payInv}
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onSuccess={() => { fetchAll(); setPayOpen(false); }}
        isDark={isDark}
      />
      <ProductModal open={catOpen} onClose={() => setCatOpen(false)} isDark={isDark} onSaved={fetchAll} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} isDark={isDark} companies={companies} onImportComplete={fetchAll} />
      <InvoicePreviewModal
        open={invoicePreviewOpen}
        onClose={() => setInvoicePreviewOpen(false)}
        invoice={invoicePreviewInv}
        previewHtml={invoicePreviewHtml}
        isDark={isDark}
      />
      <GSTReportsModal open={gstOpen} onClose={() => setGstOpen(false)} invoices={invoices} companies={companies} clients={clients} isDark={isDark} />
      {settingsOpen && <InvoiceSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} companies={companies} isDark={isDark} />}
      {ledgerOpen && <PartyLedger open={ledgerOpen} onClose={() => setLedgerOpen(false)} invoices={invoices} clients={clients} companies={companies} isDark={isDark} initialClient={ledgerClient} />}
      
      {/* DIRECT INCOME DIALOG MODAL */}
      <Dialog open={incomeFormOpen} onOpenChange={(v) => { if(!v) { setIncomeFormOpen(false); setEditingIncome(null); } }}>
        <DialogContent className={`max-w-md rounded-2xl border shadow-2xl p-6 ${isDark ? 'bg-slate-800 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-800'}`}>
          <DialogHeader>
            <DialogTitle className="text-lg font-bold flex items-center gap-2">
              <IndianRupee className="h-5 w-5 text-emerald-500" />
              {editingIncome ? 'Edit Direct Income Record' : 'Record Direct Income / Other Income'}
            </DialogTitle>
            <p className="text-xs text-slate-400">Record payments received directly without a prepared sales invoice.</p>
          </DialogHeader>
          <form onSubmit={handleSaveIncome} className="space-y-4 mt-4">
            <div className="space-y-1">
              <Label className="text-xs font-semibold">Select Company</Label>
              <Select
                value={incomeForm.company_id}
                onValueChange={(v) => setIncomeForm({ ...incomeForm, company_id: v })}
              >
                <SelectTrigger className={`h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 focus:border-blue-400 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`}>
                  <SelectValue placeholder="Choose company profile..." />
                </SelectTrigger>
                <SelectContent>
                  {companies.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Date</Label>
                <Input
                  type="date"
                  required
                  value={incomeForm.date}
                  onChange={(e) => setIncomeForm({ ...incomeForm, date: e.target.value })}
                  className={`h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 ${isDark ? 'bg-slate-700 text-slate-100 [color-scheme:dark]' : 'bg-white'}`}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-semibold">Amount (INR)</Label>
                <Input
                  type="number"
                  step="any"
                  required
                  placeholder="e.g. 15000"
                  value={incomeForm.amount}
                  onChange={(e) => setIncomeForm({ ...incomeForm, amount: e.target.value })}
                  className={`h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`}
                />
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Payer / Client Name</Label>
              <Input
                type="text"
                required
                placeholder="Name of the person/firm paying"
                value={incomeForm.payer_name}
                onChange={(e) => setIncomeForm({ ...incomeForm, payer_name: e.target.value })}
                className={`h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`}
              />
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Receipt Account (Asset)</Label>
              <Select
                value={incomeForm.receipt_account_id}
                onValueChange={(v) => setIncomeForm({ ...incomeForm, receipt_account_id: v })}
              >
                <SelectTrigger className={`h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 focus:border-blue-400 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`}>
                  <SelectValue placeholder="Choose receipt ledger account..." />
                </SelectTrigger>
                <SelectContent>
                  {accounts.filter(a => a.type === 'asset').map(a => (
                    <SelectItem key={a.id} value={a.id}>{a.name} ({a.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Income Category (Income Head)</Label>
              <Select
                value={incomeForm.income_account_id}
                onValueChange={(v) => setIncomeForm({ ...incomeForm, income_account_id: v })}
              >
                <SelectTrigger className={`h-10 rounded-xl text-sm border-slate-200 dark:border-slate-600 focus:border-blue-400 ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-white'}`}>
                  <SelectValue placeholder="Choose income category account..." />
                </SelectTrigger>
                <SelectContent>
                  {accounts.filter(a => a.type === 'income').map(a => (
                    <SelectItem key={a.id} value={a.id}>{a.name} ({a.code})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label className="text-xs font-semibold">Description / Remarks</Label>
              <textarea
                placeholder="Optional remarks or details of transaction..."
                value={incomeForm.description}
                onChange={(e) => setIncomeForm({ ...incomeForm, description: e.target.value })}
                className={`w-full p-2.5 rounded-xl border text-sm border-slate-200 dark:border-slate-600 focus:ring-1 focus:ring-blue-400 min-h-[60px] ${isDark ? 'bg-slate-700 text-slate-100 text-sm' : 'bg-white'}`}
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-4 border-t border-slate-100 dark:border-slate-700">
              <Button
                type="button"
                variant="outline"
                onClick={() => { setIncomeFormOpen(false); setEditingIncome(null); }}
                className="rounded-xl h-10 px-4 text-xs font-bold"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="rounded-xl h-10 px-5 text-xs font-bold text-white"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
              >
                Save Record
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* WHATSAPP INVOICE DIALOG */}
      {waInvoice && (
        <WhatsAppSendDialog
          open={waDialogOpen}
          onClose={() => { setWaDialogOpen(false); setWaInvoice(null); }}
          phone={waInvoice.client_phone || ''}
          entityName={'Invoice ' + (waInvoice.invoice_number || '') + ' — ' + (waInvoice.client_name || '')}
          message={buildInvoiceMessage(waInvoice, getWASettings())}
          title="Send Invoice via WhatsApp"
          subtitle={'₹' + Number(waInvoice.grand_total || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}
          isDark={isDark}
          canSendScreenshot={true}
        />
      )}
      {/* BULK WA MODAL */}
      <BulkInvoiceWAModal
        open={bulkWAOpen}
        onClose={() => setBulkWAOpen(false)}
        invoices={enrichedFiltered}
        isDark={isDark}
      />
      {/* CLIENTS BY REFERRER */}
      <ReferralSummaryDialog
        open={referralSummaryOpen}
        onClose={() => setReferralSummaryOpen(false)}
        isDark={isDark}
      />
    </div>
    );
}

// ─── Bulk WhatsApp Modal for Invoices ─────────────────────────────────────────
const INVOICE_SEND_MODES = { DIRECT: 'direct', WHATSAPP_WEB: 'web', EXPORT: 'export' };
const WA_GRN = '#25D366';
const WA_DRK = '#128C7E';

const BulkInvoiceWAModal = React.memo(({ open, onClose, invoices, isDark }) => {
  const [message, setMessage] = useState('');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [search, setSearch] = useState('');
  const [sendMode, setSendMode] = useState(INVOICE_SEND_MODES.DIRECT);
  const [waConnected, setWaConnected] = useState(null);
  const [waSessions, setWaSessions] = useState([]);
  const [waSession, setWaSession] = useState(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState(null);
  const [copied, setCopied] = useState(false);
  const [exportDone, setExportDone] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState('');

  const waSettings = getWASettings();

  // Template options from WA settings
  const TEMPLATE_OPTIONS = [
    { label: 'Invoice Reminder', key: 'invoiceTemplate' },
    { label: 'Client Message', key: 'clientTemplate' },
  ];

  useEffect(() => {
    if (!open) return;
    const withPhone = invoices.filter(i => i.client_phone);
    setSelectedIds(new Set(withPhone.map(i => i.id)));
    setSearch(''); setMessage(''); setCopied(false); setExportDone(false);
    setSendMode(INVOICE_SEND_MODES.DIRECT); setProgress(null); setSending(false);
    setSelectedTemplate('');
    api.get('/whatsapp/sessions')
      .then(r => {
        const connected = (r.data?.sessions || []).filter(s => s.status === 'connected');
        setWaConnected(connected.length > 0);
        setWaSessions(connected);
        if (connected.length === 1) setWaSession(connected[0].sessionId);
      })
      .catch(() => { setWaConnected(false); setWaSessions([]); });
  }, [open]); // eslint-disable-line

  const displayed = useMemo(() => {
    if (!search.trim()) return invoices;
    const q = search.toLowerCase();
    return invoices.filter(i =>
      (i.client_name || '').toLowerCase().includes(q) ||
      (i.invoice_number || '').toLowerCase().includes(q)
    );
  }, [invoices, search]);

  const selected = useMemo(() => invoices.filter(i => selectedIds.has(i.id)), [invoices, selectedIds]);
  const phoneCount = selected.filter(i => i.client_phone).length;

  const toggle = useCallback((id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const applyTemplate = useCallback((key) => {
    if (!key) return;
    const tmpl = waSettings[key] || '';
    setMessage(tmpl);
    setSelectedTemplate(key);
  }, [waSettings]);

  const buildMsg = useCallback((inv) => {
    const raw = message;
    const s = waSettings;
    const lines = [];
    if (s.includeGreeting) { lines.push((s.greetingTemplate || 'Dear {name},').replace('{name}', inv.client_name || 'Valued Client')); lines.push(''); }
    if (s.firmName) lines.push(`*${s.firmName}*${s.firmTagline ? ` | ${s.firmTagline}` : ''}`);
    lines.push('');
    const body = raw
      .replace(/\{name\}/gi, inv.client_name || 'Valued Client')
      .replace(/\{number\}/gi, inv.invoice_number || inv.id || 'N/A')
      .replace(/\{amount\}/gi, Number(inv.grand_total || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }))
      .replace(/\{due_date\}/gi, inv.due_date || 'N/A')
      .replace(/\{status\}/gi, (inv.status || '').replace(/_/g, ' ').toUpperCase());
    lines.push(body);
    if (s.includeFooter && s.footerNote) { lines.push(''); lines.push(s.footerNote); }
    return lines.join('\n');
  }, [message, waSettings]);

  const handleDirectSend = useCallback(async () => {
    if (!message.trim()) { toast.error('Write a message first'); return; }
    const toSend = selected.filter(i => i.client_phone);
    if (!toSend.length) { toast.error('No selected invoices have a client phone number'); return; }
    setSending(true); setProgress({ done: 0, total: toSend.length, results: [] });
    const results = [];
    for (let i = 0; i < toSend.length; i++) {
      const inv = toSend[i];
      const digits = inv.client_phone.replace(/\D/g, '');
      const waPhone = digits.length === 10 ? `91${digits}` : digits;
      try {
        await api.post('/whatsapp/send', { to: waPhone, message: buildMsg(inv), message_type: 'invoice', context_id: inv.id, session_id: waSession || undefined });
        results.push({ id: inv.id, name: inv.client_name, status: 'sent' });
      } catch (err) {
        results.push({ id: inv.id, name: inv.client_name, status: 'failed', error: err?.response?.data?.detail || 'Failed' });
      }
      setProgress({ done: i + 1, total: toSend.length, results: [...results] });
    }
    setSending(false);
    const sentCount = results.filter(r => r.status === 'sent').length;
    const failCount = results.filter(r => r.status === 'failed').length;
    toast.success(`Sent ${sentCount} messages${failCount > 0 ? `, ${failCount} failed` : ''}`);
  }, [message, selected, buildMsg, waSession]);

  const handleWebCopy = useCallback(async () => {
    if (!message.trim()) { toast.error('Write a message first'); return; }
    await navigator.clipboard.writeText(message.trim()).catch(() => {});
    setCopied(true);
    toast.success('Message copied! Opening WhatsApp Web…');
    setTimeout(() => { window.open('https://web.whatsapp.com', '_blank'); setCopied(false); }, 800);
  }, [message]);

  const handleExport = useCallback(() => {
    const withPhone = selected.filter(i => i.client_phone);
    if (!withPhone.length) { toast.error('No selected invoices have a client phone number'); return; }
    const rows = [
      ['Client', 'Invoice #', 'Amount', 'Phone', 'WA Number', 'Message'],
      ...withPhone.map(i => {
        const digits = i.client_phone.replace(/\D/g, '');
        const wa = digits.length === 10 ? `91${digits}` : digits;
        return [i.client_name || '', i.invoice_number || '', i.grand_total || '', i.client_phone, wa, buildMsg(i)];
      }),
    ];
    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a'); a.href = url; a.download = `invoice_wa_broadcast.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    const nums = withPhone.map(i => { const d = i.client_phone.replace(/\D/g,''); return d.length===10?`91${d}`:d; }).join('\n');
    navigator.clipboard.writeText(nums).catch(() => {});
    setExportDone(true); setTimeout(() => setExportDone(false), 3000);
    toast.success(`CSV downloaded + ${withPhone.length} numbers copied!`);
  }, [selected, buildMsg]);

  const bg = isDark ? '#0f172a' : '#fff';
  const border = isDark ? '#1e3a5f' : '#e2e8f0';
  const subtle = isDark ? '#0f172a' : '#fafafa';
  const txt = isDark ? '#e2e8f0' : '#0f172a';
  const muted = isDark ? '#475569' : '#94a3b8';
  const row = isDark ? '#1e2d3d' : '#f1f5f9';
  const sendBtnOk = message.trim() && phoneCount > 0;

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0"
        style={{ background: bg, borderColor: border }}>
        <DialogTitle className="sr-only">Bulk WhatsApp — Invoices</DialogTitle>

        {/* Header */}
        <div className="flex-shrink-0 px-6 py-4 border-b" style={{ background: 'linear-gradient(135deg, #064e3b, #065f46)', borderColor: 'transparent' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'rgba(255,255,255,0.15)' }}>
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-bold text-white">Bulk WhatsApp — Invoices</h2>
              <p className="text-xs mt-0.5" style={{ color: 'rgba(255,255,255,0.65)' }}>Send personalized invoice reminders directly to clients</p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {waConnected !== null && (
                <span className="text-[11px] font-bold px-2.5 py-1 rounded-full flex items-center gap-1.5"
                  style={{ background: waConnected ? 'rgba(37,211,102,0.2)' : 'rgba(239,68,68,0.2)', color: waConnected ? '#4ade80' : '#f87171', border: `1px solid ${waConnected ? 'rgba(37,211,102,0.4)' : 'rgba(239,68,68,0.3)'}` }}>
                  <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: waConnected ? '#4ade80' : '#f87171' }} />
                  {waConnected ? `WA Connected${waSessions.length > 1 ? ` (${waSessions.length})` : ''}` : 'WA Offline'}
                </span>
              )}
              {waSessions.length > 1 && (
                <select value={waSession || ''} onChange={e => setWaSession(e.target.value || null)}
                  style={{ fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 8, background: 'rgba(255,255,255,0.15)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)', cursor: 'pointer', outline: 'none' }}>
                  <option value="" style={{ background: '#0f172a' }}>Auto-pick account</option>
                  {waSessions.map(s => <option key={s.sessionId} value={s.sessionId} style={{ background: '#0f172a' }}>{s.displayName || `+${s.phoneNumber}`}</option>)}
                </select>
              )}
              <span className="text-xs font-bold px-2.5 py-1 rounded-full" style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>{phoneCount} with phone</span>
            </div>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* Left: invoice list */}
          <div className="w-64 flex-shrink-0 flex flex-col border-r" style={{ borderColor: row, background: subtle }}>
            <div className="px-3 py-2 border-b flex-shrink-0" style={{ borderColor: row }}>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <input className="w-full pl-8 pr-3 h-8 text-xs rounded-lg border focus:outline-none"
                  style={{ borderColor: isDark ? '#334155' : '#e2e8f0', background: isDark ? '#1e293b' : '#fff', color: txt }}
                  placeholder="Search invoices…" value={search} onChange={e => setSearch(e.target.value)} />
              </div>
            </div>
            <div className="flex items-center justify-between px-3 py-1.5 border-b flex-shrink-0" style={{ borderColor: row }}>
              <span className="text-[10px]" style={{ color: muted }}>{selectedIds.size} of {invoices.filter(i => i.client_phone).length} selected</span>
              <div className="flex gap-2">
                <button onClick={() => setSelectedIds(new Set(invoices.filter(i => i.client_phone).map(i => i.id)))}
                  className="text-[10px] font-semibold px-2 py-0.5 rounded border" style={{ borderColor: WA_GRN, color: WA_GRN, background: WA_GRN + '18' }}>Select All</button>
                <button onClick={() => setSelectedIds(new Set())}
                  className="text-[10px] font-semibold px-2 py-0.5 rounded border" style={{ borderColor: isDark ? '#334155' : '#e2e8f0', color: muted }}>Clear</button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {displayed.map(inv => {
                const isSel = selectedIds.has(inv.id);
                const hasPhone = !!inv.client_phone;
                return (
                  <div key={inv.id} onClick={() => hasPhone && toggle(inv.id)}
                    className="flex items-center gap-2.5 px-3 py-2.5 border-b transition-all"
                    style={{ borderColor: isDark ? '#1e2d3d' : '#f1f5f9', opacity: hasPhone ? 1 : 0.35, cursor: hasPhone ? 'pointer' : 'not-allowed', background: isSel && hasPhone ? (isDark ? 'rgba(37,211,102,0.06)' : 'rgba(37,211,102,0.05)') : 'transparent' }}>
                    <span style={{ color: isSel && hasPhone ? WA_GRN : muted }}>
                      {isSel && hasPhone ? <CheckSquare className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] font-semibold truncate" style={{ color: txt }}>{inv.client_name || '—'}</p>
                      <p className="text-[10px] truncate" style={{ color: muted }}>{inv.invoice_number || inv.id} · {inv.client_phone || '— no phone'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: compose + send */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-5 space-y-4">

              {/* Template picker */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest mb-1.5 block" style={{ color: muted }}>Load from WhatsApp Settings Template</label>
                <div className="flex flex-wrap gap-2">
                  {TEMPLATE_OPTIONS.map(t => (
                    <button key={t.key} onClick={() => applyTemplate(t.key)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all"
                      style={{ background: selectedTemplate === t.key ? WA_GRN + '22' : (isDark ? '#1e293b' : '#f8fafc'), borderColor: selectedTemplate === t.key ? WA_GRN : (isDark ? '#334155' : '#e2e8f0'), color: selectedTemplate === t.key ? WA_GRN : (isDark ? '#94a3b8' : '#64748b') }}>
                      {t.label}
                    </button>
                  ))}
                  <span className="text-[10px] self-center" style={{ color: muted }}>or write your own below</span>
                </div>
              </div>

              {/* Message composer */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[10px] font-bold uppercase tracking-widest" style={{ color: muted }}>Message Body</label>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded" style={{ background: isDark ? '#1e293b' : '#f1f5f9', color: muted }}>
                    Variables: {'{name}'} {'{number}'} {'{amount}'} {'{due_date}'} {'{status}'}
                  </span>
                </div>
                <textarea
                  className="w-full min-h-[130px] border rounded-xl text-sm p-3.5 resize-none outline-none transition-all leading-relaxed"
                  style={{ background: isDark ? '#1e293b' : '#f8fafc', borderColor: isDark ? '#334155' : '#e2e8f0', color: txt }}
                  placeholder={"Your invoice *{number}* for *₹{amount}* is ready.\n\nDue Date: {due_date}\nStatus: {status}\n\nPlease make the payment at your earliest convenience."}
                  value={message} onChange={e => { setMessage(e.target.value); setSelectedTemplate(''); }} />
                <p className="text-[10px] mt-1" style={{ color: muted }}>{message.length} chars · greeting & footer from WhatsApp Settings are auto-added</p>
              </div>

              {/* Send mode tabs */}
              <div>
                <label className="text-[10px] font-bold uppercase tracking-widest mb-2 block" style={{ color: muted }}>Send Method</label>
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { key: INVOICE_SEND_MODES.DIRECT, label: '⚡ Direct Send', desc: 'Via WA bridge', color: WA_GRN, req: waConnected },
                    { key: INVOICE_SEND_MODES.WHATSAPP_WEB, label: '🌐 WA Web', desc: 'Copy & open', color: '#3b82f6', req: true },
                    { key: INVOICE_SEND_MODES.EXPORT, label: '📤 Export CSV', desc: 'Broadcast list', color: '#8b5cf6', req: true },
                  ].map(({ key, label, desc, color, req }) => (
                    <button key={key} onClick={() => setSendMode(key)}
                      className="flex flex-col items-center gap-0.5 p-2.5 rounded-xl border text-center transition-all"
                      style={{ background: sendMode === key ? color + '15' : (isDark ? '#1e293b' : '#f8fafc'), borderColor: sendMode === key ? color : (isDark ? '#334155' : '#e2e8f0'), opacity: req === false ? 0.45 : 1 }}>
                      <span className="text-xs font-bold" style={{ color: sendMode === key ? color : muted }}>{label}</span>
                      <span className="text-[9px]" style={{ color: muted }}>{desc}</span>
                      {req === false && <span className="text-[9px] text-red-400">WA offline</span>}
                    </button>
                  ))}
                </div>
              </div>

              {/* Direct send info */}
              {sendMode === INVOICE_SEND_MODES.DIRECT && (
                <div className="rounded-xl border p-4 space-y-2" style={{ background: isDark ? '#0a1628' : '#f0fdf4', borderColor: isDark ? '#1a3a1a' : '#bbf7d0' }}>
                  <p className="text-xs font-bold" style={{ color: isDark ? '#4ade80' : '#166534' }}>⚡ Direct Send — {phoneCount} invoices with phone</p>
                  <p className="text-xs" style={{ color: isDark ? '#6ee7b7' : '#15803d' }}>Each client receives a personalized message with their invoice details.</p>
                  {progress && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs font-semibold" style={{ color: isDark ? '#4ade80' : '#166534' }}>
                        <span>Sending {progress.done} / {progress.total}</span>
                        <span>{Math.round(progress.done / progress.total * 100)}%</span>
                      </div>
                      <div className="h-2 rounded-full overflow-hidden" style={{ background: isDark ? '#1e3a1e' : '#dcfce7' }}>
                        <div className="h-full rounded-full transition-all" style={{ width: `${progress.done / progress.total * 100}%`, background: WA_GRN }} />
                      </div>
                      <div className="max-h-20 overflow-y-auto space-y-0.5">
                        {progress.results.slice(-5).map((r, i) => (
                          <p key={i} className="text-[10px]" style={{ color: r.status === 'sent' ? (isDark ? '#4ade80' : '#166534') : '#ef4444' }}>
                            {r.status === 'sent' ? '✓' : '✗'} {r.name}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              {sendMode === INVOICE_SEND_MODES.WHATSAPP_WEB && (
                <div className="rounded-xl border p-4" style={{ background: isDark ? '#0a1628' : '#eff6ff', borderColor: isDark ? '#1e3a5f' : '#bfdbfe' }}>
                  <p className="text-xs font-bold mb-1" style={{ color: isDark ? '#93c5fd' : '#1e40af' }}>🌐 Copy & Open WhatsApp Web</p>
                  <p className="text-xs" style={{ color: isDark ? '#60a5fa' : '#1d4ed8' }}>Copies message to clipboard and opens WhatsApp Web. Paste and send manually.</p>
                </div>
              )}
              {sendMode === INVOICE_SEND_MODES.EXPORT && (
                <div className="rounded-xl border-2 border-dashed p-4" style={{ borderColor: isDark ? '#2d4a2d' : '#86efac', background: isDark ? '#0a1a0a' : '#f0fdf4' }}>
                  <p className="text-sm font-bold mb-1" style={{ color: isDark ? '#4ade80' : '#166534' }}>📤 Export for WhatsApp Broadcast</p>
                  <p className="text-xs" style={{ color: isDark ? '#6ee7b7' : '#15803d' }}>Downloads a CSV with all phone numbers + personalized messages. Numbers also copied to clipboard.</p>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 flex items-center justify-between gap-3 px-5 py-3.5 border-t" style={{ borderColor: isDark ? '#1e2d3d' : '#f1f5f9', background: isDark ? '#0a1220' : '#fff' }}>
              <Button type="button" variant="ghost" onClick={onClose} className="h-10 px-4 text-sm rounded-xl" style={{ color: muted }}>Cancel</Button>
              {sendMode === INVOICE_SEND_MODES.DIRECT && (
                <button disabled={!sendBtnOk || sending || !waConnected} onClick={handleDirectSend}
                  className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                  style={{ background: sendBtnOk && waConnected ? `linear-gradient(135deg, ${WA_DRK}, ${WA_GRN})` : '#94a3b8', boxShadow: sendBtnOk && waConnected ? `0 4px 14px ${WA_GRN}40` : 'none' }}>
                  {sending ? <><RefreshCw className="h-4 w-4 animate-spin" /> Sending {progress?.done}/{progress?.total}…</> : <><Send className="h-4 w-4" /> Send to {phoneCount} clients</>}
                </button>
              )}
              {sendMode === INVOICE_SEND_MODES.WHATSAPP_WEB && (
                <button disabled={!message.trim() || !phoneCount} onClick={handleWebCopy}
                  className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                  style={{ background: message.trim() && phoneCount ? 'linear-gradient(135deg, #1e40af, #3b82f6)' : '#94a3b8' }}>
                  {copied ? <><CheckCircle2 className="h-4 w-4" /> Copied!</> : <><Copy className="h-4 w-4" /> Copy & Open WA Web</>}
                </button>
              )}
              {sendMode === INVOICE_SEND_MODES.EXPORT && (
                <button disabled={!phoneCount} onClick={handleExport}
                  className="flex items-center gap-2 h-10 px-5 rounded-xl text-white text-sm font-bold transition-all disabled:opacity-50"
                  style={{ background: exportDone ? 'linear-gradient(135deg, #059669, #10b981)' : `linear-gradient(135deg, ${WA_DRK}, ${WA_GRN})` }}>
                  {exportDone ? <><CheckCircle2 className="h-4 w-4" /> Exported!</> : <><Download className="h-4 w-4" /> Export CSV ({phoneCount} invoices)</>}
                </button>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
});

export default Invoicing;
