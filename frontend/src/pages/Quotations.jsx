import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDark } from '@/hooks/useDark';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import { useAuth } from '@/contexts/AuthContext';
import api from '@/lib/api';
import { fetchCompanies } from "@/lib/companies";
import axios from 'axios';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Edit, Trash2, Download, Search, Building2, FileText, Landmark,
  ChevronRight, ChevronLeft, Check, X, Loader2, Receipt,
  Phone, Mail, Globe, CreditCard, User, Tag, Info,
  IndianRupee, Percent, Hash, Calendar, Link, Link2, ExternalLink,
  Send, MessageCircle, Settings, Eye, ArrowRight, Users,
  Printer, LayoutGrid, List, Filter, TrendingUp, AlertCircle,
  CheckCircle2, Clock, ArrowUpRight, RefreshCw, FileCheck,
  DollarSign, BarChart3, ChevronDown, CheckSquare, Copy,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { generateQuotationHTML } from './QuotationTemplates';
import QuotationSettings, { getQtnSettings } from './QuotationSettings';
import WhatsAppSendDialog from '@/components/ui/WhatsAppSendDialog';
import { getWASettings } from '@/hooks/useWhatsApp';
import { mirrorBankToSettings } from '@/lib/bankSync';
import { CompanyListModal } from '@/components/CompanyProfiles';
import SendFromSelect from '@/components/SendFromSelect';

// ─── Brand Colors ─────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber:        '#F59E0B',
  coral:        '#EF4444',
  purple:       '#7C3AED',
};

// ─── Dark palette ─────────────────────────────────────────────────────────────
const D = {
  bg: '#0f172a', card: '#1e293b', raised: '#263348',
  border: '#334155', text: '#f1f5f9', muted: '#94a3b8', dimmer: '#64748b',
};

const STATUS_META = {
  draft:    { label: 'Draft',    bg: 'bg-slate-100 dark:bg-slate-700',       text: 'text-slate-600 dark:text-slate-300',    dot: 'bg-slate-400',   hex: '#94A3B8', darkBg: 'rgba(148,163,184,0.15)' },
  sent:     { label: 'Sent',     bg: 'bg-blue-50 dark:bg-blue-900/30',       text: 'text-blue-600 dark:text-blue-400',      dot: 'bg-blue-500',    hex: '#1F6FB2', darkBg: 'rgba(31,111,178,0.20)'  },
  accepted: { label: 'Accepted', bg: 'bg-emerald-50 dark:bg-emerald-900/20', text: 'text-emerald-700 dark:text-emerald-400', dot: 'bg-emerald-500', hex: '#1FAF5A', darkBg: 'rgba(31,175,90,0.15)'  },
  rejected: { label: 'Rejected', bg: 'bg-red-50 dark:bg-red-900/20',        text: 'text-red-600 dark:text-red-400',        dot: 'bg-red-500',     hex: '#EF4444', darkBg: 'rgba(239,68,68,0.15)'   },
};

const STEPS = ['Client & Lead', 'Services & Items', 'Terms', 'Preview'];
const UNIT_OPTIONS = ['service','month','hour','year','session','document','return','filing','visit','item'];

const fmt  = (n) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n ?? 0);
const fmtC = (n) => `₹${fmt(n)}`;

// ─── Helpers ──────────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem('token') || sessionStorage.getItem('token') || '';

// ── Safe error-message extractor (handles FastAPI/Pydantic array `detail`) ───
const stringifyDetail = (d) => {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) {
    return d.map((e) => {
      if (typeof e === 'string') return e;
      if (e && typeof e === 'object') {
        const loc = Array.isArray(e.loc) ? e.loc.filter(x => x !== 'body').join('.') : '';
        return [loc, e.msg || e.message || ''].filter(Boolean).join(': ');
      }
      return String(e);
    }).filter(Boolean).join(' • ');
  }
  if (typeof d === 'object') return d.msg || d.message || JSON.stringify(d);
  return String(d);
};
const getErrMsg = (err, fallback = 'Something went wrong') => {
  const data = err?.response?.data;
  if (!data) return err?.message || fallback;
  return stringifyDetail(data.detail) || stringifyDetail(data.message) || err?.message || fallback;
};

const extractBlobError = async (error) => {
  try {
    if (error?.response?.data instanceof Blob) {
      const text = await error.response.data.text();
      try {
        const json = JSON.parse(text);
        return stringifyDetail(json?.detail) || stringifyDetail(json?.message) || text || 'PDF generation failed';
      } catch { return text || 'PDF generation failed'; }
    }
    return getErrMsg(error, 'PDF generation failed');
  } catch { return 'PDF generation failed due to an unknown error.'; }
};

const openWhatsApp = (phone, message) => {
  let cleaned = (phone || '').replace(/\D/g, '');
  if (cleaned.length === 10) cleaned = '91' + cleaned;
  window.open(`https://web.whatsapp.com/send?phone=${cleaned}&text=${encodeURIComponent(message)}`, '_blank');
};

const avatarGrad = (name) => {
  const colors = ['#0D3B66','#1F6FB2','#1FAF5A','#7C3AED','#F59E0B','#EF4444','#0D9488'];
  const i = (name || '?').charCodeAt(0) % colors.length;
  return `linear-gradient(135deg, ${colors[i]}, ${colors[(i+2)%colors.length]})`;
};

// ════════════════════════════════════════════════════════════════════════════════
// STAT CARD
// ════════════════════════════════════════════════════════════════════════════════
const StatCard = ({ label, value, sub, icon: Icon, color, bg, onClick, isDark, trend }) => (
  <div
    onClick={onClick}
    className={`rounded-2xl border p-5 relative overflow-hidden cursor-pointer hover:shadow-lg hover:-translate-y-0.5 transition-all ${isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-600' : 'bg-white border-slate-200/80 hover:border-slate-300'}`}
  >
    <div className="absolute left-0 top-4 bottom-4 w-[3px] rounded-r-full" style={{ background: color }} />
    <div className="flex items-start justify-between mb-3 pl-2">
      <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: bg }}>
        <Icon className="h-5 w-5" style={{ color }} />
      </div>
      {trend !== undefined && (
        <span className={`text-[10px] font-bold px-2 py-1 rounded-full ${trend >= 0 ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-600'}`}>
          {trend >= 0 ? '+' : ''}{trend}%
        </span>
      )}
    </div>
    <p className="text-[10px] font-bold uppercase tracking-widest mb-1 pl-2 text-slate-400">{label}</p>
    <p className={`text-2xl font-bold tracking-tight pl-2 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{value}</p>
    {sub && <p className={`text-xs pl-2 mt-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{sub}</p>}
  </div>
);

// ── Status chip ───────────────────────────────────────────────────────────────
const StatusChip = ({ status }) => {
  const m = STATUS_META[status] || STATUS_META.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-1 rounded-full ${m.bg} ${m.text} whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} />{m.label}
    </span>
  );
};

// ── Inline status dropdown ─────────────────────────────────────────────────────
const INLINE_QTN_STATUSES = ['draft', 'sent', 'accepted', 'rejected'];

const InlineQuotationStatusDropdown = ({ qtn, onStatusChange, isDark }) => {
  const [open, setOpen]       = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [dropPos, setDropPos] = React.useState({ top: 0, left: 0 });
  const triggerRef            = React.useRef(null);
  const m = STATUS_META[qtn?.status] || STATUS_META.draft;

  const handleToggle = (e) => {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      const dropHeight = INLINE_QTN_STATUSES.length * 38 + 38;
      const spaceBelow = window.innerHeight - r.bottom;
      const topPos = spaceBelow < dropHeight + 8 ? r.top - dropHeight - 4 : r.bottom + 4;
      setDropPos({ top: Math.max(4, topPos), left: Math.max(8, r.right - 160) });
    }
    setOpen(v => !v);
  };

  const handleSelect = async (newStatus) => {
    if (newStatus === qtn.status) { setOpen(false); return; }
    setLoading(true);
    try {
      await api.put(`/quotations/${qtn.id}`, { status: newStatus, status_history_entry: { status: newStatus, changed_at: new Date().toISOString() } });
      onStatusChange(qtn.id, newStatus);
      toast.success(`Status → ${STATUS_META[newStatus]?.label || newStatus}`);
    } catch {
      toast.error('Failed to update status');
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  return (
    <div onClick={e => e.stopPropagation()}>
      <button ref={triggerRef} type="button" onClick={handleToggle}
        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full transition-all
          hover:ring-2 hover:ring-offset-1 hover:ring-current cursor-pointer select-none
          ${m.bg} ${m.text} whitespace-nowrap`}
        title="Click to change status">
        {loading ? <RefreshCw className="w-2.5 h-2.5 animate-spin" />
          : <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${m.dot}`} />}
        {m.label}
        <ChevronDown className={`w-2.5 h-2.5 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
          <div className={`fixed z-[9999] w-40 rounded-xl border shadow-2xl overflow-hidden
            ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}
            style={{ top: dropPos.top, left: dropPos.left }}>
            <div className={`px-3 py-2 border-b text-[9px] font-bold uppercase tracking-widest
              ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
              Change Status
            </div>
            {INLINE_QTN_STATUSES.map(s => {
              const sm = STATUS_META[s];
              const isCurrent = qtn.status === s;
              return (
                <button key={s} type="button" onClick={() => handleSelect(s)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-[11px] font-semibold transition-colors
                    ${isCurrent ? `${sm.bg} ${sm.text}` : isDark ? 'text-slate-300 hover:bg-slate-700/70' : 'text-slate-600 hover:bg-slate-50'}`}>
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sm.dot}`} />
                  <span className="flex-1 text-left">{sm.label}</span>
                  {isCurrent && <Check className="w-3 h-3 opacity-70" />}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// EMAIL MODAL
// ════════════════════════════════════════════════════════════════════════════════
function EmailModal({ open, onClose, quotation, company, pdfType = 'quotation' }) {
  const [toEmail,  setToEmail]  = useState('');
  const [subject,  setSubject]  = useState('');
  const [body,     setBody]     = useState('');
  const [sending,  setSending]  = useState(false);
  const [senderId, setSenderId] = useState('');

  useEffect(() => {
    if (!open || !quotation) return;
    setSenderId('');
    setToEmail(quotation.client_email || '');
    setSubject(`Quotation ${quotation.quotation_no} from ${company?.name || ''}`);
    setBody(
      `Dear ${quotation.client_name || 'Sir/Madam'},\n\n` +
      `Please find attached our ${pdfType === 'checklist' ? 'document checklist' : 'quotation'} ` +
      `${quotation.quotation_no} for ${quotation.service}.\n\n` +
      (pdfType === 'quotation' ? `Total Amount: Rs. ${(quotation.total || 0).toLocaleString()}\nValidity: ${quotation.validity_days || 30} days\n\n` : '') +
      `Regards,\n${company?.name || ''}`
    );
  }, [open, quotation, company, pdfType]);

  const handleSend = async () => {
    if (!toEmail.trim()) { toast.error('Enter recipient email'); return; }
    setSending(true);
    try {
      const res = await api.post(`/quotations/${quotation.id}/send-email`, { to_email: toEmail, subject, body, pdf_type: pdfType, sender_id: senderId || undefined });
      toast.success(res.data?.message || `Email sent to ${toEmail}`); onClose();
    } catch (err) { toast.error(getErrMsg(err, 'Failed to send email')); }
    finally { setSending(false); }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" style={{ color: COLORS.deepBlue }}>
            <Mail className="h-5 w-5" /> Send {pdfType === 'checklist' ? 'Checklist' : 'Quotation'} via Email
          </DialogTitle>
          <DialogDescription>PDF will be generated and attached automatically.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <SendFromSelect value={senderId} onChange={setSenderId} />
          <div className="space-y-1.5"><Label className="text-xs font-semibold">To Email *</Label><Input value={toEmail} onChange={e => setToEmail(e.target.value)} placeholder="client@company.com" className="h-9 rounded-xl text-sm" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-semibold">Subject</Label><Input value={subject} onChange={e => setSubject(e.target.value)} className="h-9 rounded-xl text-sm" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-semibold">Message</Label><Textarea value={body} onChange={e => setBody(e.target.value)} rows={6} className="resize-none rounded-xl text-sm" /></div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          <Button onClick={handleSend} disabled={sending} className="rounded-xl gap-2" style={{ background: COLORS.deepBlue }}>
            {sending ? <><Loader2 className="h-4 w-4 animate-spin" />Sending…</> : <><Send className="h-4 w-4" />Send Email</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// WHATSAPP MODAL
// ════════════════════════════════════════════════════════════════════════════════
function WhatsAppModal({ open, onClose, quotation, company, pdfType = 'quotation' }) {
  const [phone,   setPhone]   = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!open || !quotation) return;
    setPhone(quotation.client_phone || '');
    const base = pdfType === 'checklist'
      ? `Hi ${quotation.client_name || ''},\n\nPlease find the document checklist for *${quotation.service}* (Ref: ${quotation.quotation_no}).\n\nKindly arrange the required documents.\n\nRegards,\n${company?.name || ''}`
      : `Hi ${quotation.client_name || ''},\n\nPlease find our quotation *${quotation.quotation_no}* for *${quotation.service}*.\n\n💰 *Total: Rs. ${(quotation.total || 0).toLocaleString()}*\n📅 Valid for ${quotation.validity_days || 30} days\n\nLooking forward to working with you.\n\nRegards,\n${company?.name || ''}`;
    setMessage(base);
  }, [open, quotation, company, pdfType]);

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" style={{ color: '#25D366' }}>
            <MessageCircle className="h-5 w-5" />Send via WhatsApp
          </DialogTitle>
          <DialogDescription>Opens WhatsApp Web. Download PDF first, then attach in the chat.</DialogDescription>
        </DialogHeader>
        <div className="p-3 rounded-xl bg-green-50 border border-green-200 text-xs text-green-800">
          <strong>How it works:</strong> Click "Open WhatsApp Web" — message will be pre-filled. Download PDF separately and attach.
        </div>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5"><Label className="text-xs font-semibold">WhatsApp Number *</Label><Input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+91 98765 43210" className="h-9 rounded-xl text-sm" /></div>
          <div className="space-y-1.5"><Label className="text-xs font-semibold">Message</Label><Textarea value={message} onChange={e => setMessage(e.target.value)} rows={7} className="resize-none rounded-xl text-sm" /></div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} className="rounded-xl">Cancel</Button>
          <Button
            onClick={() => {
              if (!phone.trim()) { toast.error('Enter WhatsApp number'); return; }
              openWhatsApp(phone, message);
              toast.success('WhatsApp Web opened — attach the PDF manually.');
              onClose();
            }}
            className="rounded-xl gap-2 bg-[#25D366] hover:bg-[#20bc5a] text-white"
          >
            <MessageCircle className="h-4 w-4" />Open WhatsApp Web
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// ════════════════════════════════════════════════════════════════════════════════
// QUOTATION MANAGER (create / edit wizard)
// ════════════════════════════════════════════════════════════════════════════════
function QuotationManager({ onClose, onSaved, editingQuotation }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    company_id: '', lead_id: '', client_id: '',
    client_name: '', client_address: '', client_email: '', client_phone: '',
    service: '', subject: '',
    scope_of_work: [''],
    items: [{ description: '', quantity: 1, unit: 'service', unit_price: 0, amount: 0 }],
    gst_rate: 18.0, payment_terms: '', timeline: '', validity_days: 30,
    advance_terms: '', extra_terms: [''], notes: '', extra_checklist_items: [''],
    attach_checklist: true,
    status: 'draft',
  });
  const [companies, setCompanies] = useState([]);
  const [leads,     setLeads]     = useState([]);
  const [clients,   setClients]   = useState([]);
  const [services,  setServices]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [saving,    setSaving]    = useState(false);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        // Companies are ORG-WIDE MASTER DATA (Admin -> Master Data).
        // Always read them through fetchCompanies() so the /companies/list
        // fallback kicks in when the canonical route 404s on older backends.
        const [companyList, lRes, sRes, clRes] = await Promise.all([
          fetchCompanies(), api.get('/leads'),
          api.get('/quotations/services'), api.get('/clients'),
        ]);
        setCompanies(companyList); setLeads(lRes.data);
        setServices(sRes.data.services); setClients(clRes.data);
        if (editingQuotation) {
          setForm({
            company_id: editingQuotation.company_id || '',
            lead_id: editingQuotation.lead_id || '',
            client_id: editingQuotation.client_id || '',
            client_name: editingQuotation.client_name || '',
            client_address: editingQuotation.client_address || '',
            client_email: editingQuotation.client_email || '',
            client_phone: editingQuotation.client_phone || '',
            service: editingQuotation.service || '',
            subject: editingQuotation.subject || '',
            scope_of_work: editingQuotation.scope_of_work?.length ? editingQuotation.scope_of_work : [''],
            items: editingQuotation.items?.length ? editingQuotation.items : [{ description: '', quantity: 1, unit: 'service', unit_price: 0, amount: 0 }],
            gst_rate: editingQuotation.gst_rate || 18.0,
            payment_terms: editingQuotation.payment_terms || '',
            timeline: editingQuotation.timeline || '',
            validity_days: editingQuotation.validity_days || 30,
            advance_terms: editingQuotation.advance_terms || '',
            extra_terms: editingQuotation.extra_terms?.length ? editingQuotation.extra_terms : [''],
            notes: editingQuotation.notes || '',
            extra_checklist_items: editingQuotation.extra_checklist_items?.length ? editingQuotation.extra_checklist_items : [''],
            attach_checklist: editingQuotation.attach_checklist !== false,
            status: editingQuotation.status || 'draft',
          });
        } else if (companyList.length > 0) {
          setForm(prev => ({ ...prev, company_id: companyList[0].id }));
        }
      } catch (err) { toast.error(getErrMsg(err, 'Failed to load data')); }
      finally { setLoading(false); }
    };
    fetchData();
  }, [editingQuotation]);

  // Draft persistence
  const QTN_DRAFT_KEY = 'taskosphere_quotation_add_draft';
  useEffect(() => {
    if (!editingQuotation && !loading) {
      try { localStorage.setItem(QTN_DRAFT_KEY, JSON.stringify({ form, step })); } catch {}
    }
  }, [form, step, editingQuotation, loading]);
  useEffect(() => {
    if (!editingQuotation) {
      try {
        const saved = localStorage.getItem(QTN_DRAFT_KEY);
        if (saved) {
          const { form: savedForm, step: savedStep } = JSON.parse(saved);
          if (savedForm?.client_name?.trim() || savedForm?.service?.trim()) {
            setForm(prev => ({ ...prev, ...savedForm }));
            if (savedStep > 1) setStep(savedStep);
          }
        }
      } catch {}
    }
  }, []); // eslint-disable-line

  const handleChange = e => setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));

  const handleClientSelect = (clientId) => {
    if (!clientId || clientId === 'none') { setForm(prev => ({ ...prev, client_id: '' })); return; }
    const c = clients.find(c => c.id === clientId); if (!c) return;
    const addr = [c.address, c.city, c.state].filter(Boolean).join(', ');
    const contact = c.contact_persons?.[0];
    setForm(prev => ({ ...prev, client_id: clientId, client_name: c.company_name || '', client_email: c.email || contact?.email || '', client_phone: c.phone || contact?.phone || '', client_address: addr }));
  };

  const handleLeadSelect = (leadId) => {
    if (!leadId || leadId === 'none') { setForm(prev => ({ ...prev, lead_id: '' })); return; }
    setForm(prev => ({ ...prev, lead_id: leadId }));
    const l = leads.find(l => l.id === leadId);
    if (l && !form.client_name) setForm(prev => ({ ...prev, lead_id: leadId, client_name: l.company_name || l.name || prev.client_name, client_email: l.email || prev.client_email, client_phone: l.phone || prev.client_phone }));
  };

  const handleItemChange = (index, field, value) => {
    const items = [...form.items]; items[index][field] = value;
    if (field === 'quantity' || field === 'unit_price') items[index].amount = items[index].quantity * items[index].unit_price;
    setForm(prev => ({ ...prev, items }));
  };
  const addItem    = () => setForm(prev => ({ ...prev, items: [...prev.items, { description: '', quantity: 1, unit: 'service', unit_price: 0, amount: 0 }] }));
  const removeItem = (i) => setForm(prev => ({ ...prev, items: prev.items.filter((_, idx) => idx !== i) }));

  const handleListChange = (list, i, val) => { const a = [...form[list]]; a[i] = val; setForm(prev => ({ ...prev, [list]: a })); };
  const addListItem      = (list) => setForm(prev => ({ ...prev, [list]: [...prev[list], ''] }));
  const removeListItem   = (list, i) => setForm(prev => ({ ...prev, [list]: prev[list].filter((_, idx) => idx !== i) }));

  const handleSave = async () => {
    if (!form.company_id) { toast.error('Please select a company'); setStep(1); return; }
    if (!form.client_name.trim()) { toast.error('Client name is required'); setStep(1); return; }
    if (!form.service.trim()) { toast.error('Service is required — please select a service in Step 2'); setStep(2); return; }
    setSaving(true);
    try {
      // Snapshot the active template/theme so the quotation always renders
      // with the same look in preview, PDF, print and the converted invoice
      // (independent of later company-default changes).
      const _qtnSettingsForSave = getQtnSettings(form.company_id);
      const _companyForSave = companies.find(c => c.id === form.company_id) || {};
      const _resolvedColorForSave = _qtnSettingsForSave.theme === 'custom'
        ? (_qtnSettingsForSave.custom_color || '#0D3B66')
        : (_qtnSettingsForSave.custom_color || _companyForSave.invoice_custom_color || '#0D3B66');
      const payload = {
        ...form,
        scope_of_work: form.scope_of_work.filter(s => s.trim()),
        extra_terms: form.extra_terms.filter(t => t.trim()),
        extra_checklist_items: form.extra_checklist_items.filter(c => c.trim()),
        lead_id: form.lead_id || null,
        client_id: form.client_id || null,
        invoice_template:     _qtnSettingsForSave.template || _companyForSave.invoice_template || 'classic',
        invoice_theme:        _qtnSettingsForSave.theme    || 'custom',
        invoice_custom_color: _resolvedColorForSave,
      };
      editingQuotation
        ? await api.put(`/quotations/${editingQuotation.id}`, payload)
        : await api.post('/quotations', payload);
      if (!editingQuotation) { try { localStorage.removeItem(QTN_DRAFT_KEY); } catch {} }
      toast.success(editingQuotation ? 'Quotation updated' : 'Quotation created');
      onSaved(); onClose();
    } catch (err) { toast.error(getErrMsg(err, 'Failed to save quotation')); }
    finally { setSaving(false); }
  };

  const subtotal  = form.items.reduce((sum, it) => sum + (it.quantity * it.unit_price), 0);
  const gstAmount = subtotal * (form.gst_rate / 100);
  const total     = subtotal + gstAmount;

  if (loading) return (
    <Dialog open={true} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle className="sr-only">Loading</DialogTitle><DialogDescription className="sr-only">Loading…</DialogDescription></DialogHeader>
        <MiniLoader height={160} />
      </DialogContent>
    </Dialog>
  );

  return (
    <Dialog open={true} onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2" style={{ color: COLORS.deepBlue }}>
            <Receipt className="h-5 w-5" />{editingQuotation ? `Edit ${editingQuotation.quotation_no}` : 'Create New Quotation'}
          </DialogTitle>
          <DialogDescription>Step-by-step professional quotation builder.</DialogDescription>
        </DialogHeader>

        {/* Step tabs */}
        <div className="flex space-x-2 mb-2">
          {STEPS.map((s, i) => (
            <button key={s} onClick={() => setStep(i + 1)}
              className={cn('flex-1 text-center py-2 px-1 rounded-xl text-xs font-medium transition-colors', step === (i + 1) ? 'bg-blue-100 text-blue-700 font-semibold' : 'bg-slate-50 text-slate-500 hover:bg-slate-100')}>
              <span className={cn('inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] mr-1', step === (i + 1) ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-600')}>{i + 1}</span>{s}
            </button>
          ))}
        </div>

        <div className="max-h-[58vh] overflow-y-auto pr-1">

          {/* Step 1 */}
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Select Company *</Label>
                  <Select value={form.company_id} onValueChange={v => { const co = companies.find(c => c.id === v); setForm(p => ({ ...p, company_id: v, gst_rate: co?.has_gst === false ? 0 : (p.gst_rate || 18) })); }}>
                    <SelectTrigger className="h-9 rounded-xl text-sm"><SelectValue placeholder="Select company" /></SelectTrigger>
                    <SelectContent>{companies.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                  </Select>
                  {companies.length === 0 && <p className="text-xs text-amber-600">No companies found. Add a company first.</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Link to Lead (Optional)</Label>
                  <Select value={form.lead_id || 'none'} onValueChange={handleLeadSelect}>
                    <SelectTrigger className="h-9 rounded-xl text-sm"><SelectValue placeholder="Select a lead" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">-- No Lead --</SelectItem>
                      {leads.map(l => <SelectItem key={l.id} value={l.id}>{l.company_name || l.name || 'Unnamed'}{(l.contact_name || l.email) ? ` — ${l.contact_name || l.email}` : ''}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="p-3 rounded-xl bg-blue-50 border border-blue-100">
                <Label className="text-xs font-semibold text-blue-700 flex items-center gap-1 mb-2"><Users className="h-3.5 w-3.5" />Select from Client List (auto-fills details)</Label>
                <Select value={form.client_id || 'none'} onValueChange={handleClientSelect}>
                  <SelectTrigger className="h-9 rounded-xl text-sm bg-white"><SelectValue placeholder="Choose existing client…" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">-- Enter manually below --</SelectItem>
                    {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.company_name}{c.phone ? ` — ${c.phone}` : ''}{c.email ? ` — ${c.email}` : ''}</SelectItem>)}
                  </SelectContent>
                </Select>
                {form.client_id && <p className="text-[10px] text-blue-600 mt-1">✓ Client details loaded — you can edit below.</p>}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5"><Label className="text-xs font-semibold">Client Name *</Label><Input name="client_name" value={form.client_name} onChange={handleChange} className="h-9 rounded-xl text-sm" /></div>
                <div className="space-y-1.5"><Label className="text-xs font-semibold">Client Email</Label><Input name="client_email" value={form.client_email} onChange={handleChange} type="email" className="h-9 rounded-xl text-sm" /></div>
                <div className="space-y-1.5"><Label className="text-xs font-semibold">Client Phone</Label><Input name="client_phone" value={form.client_phone} onChange={handleChange} className="h-9 rounded-xl text-sm" /></div>
                <div className="space-y-1.5"><Label className="text-xs font-semibold">Client Address</Label><Textarea name="client_address" value={form.client_address} onChange={handleChange} rows={2} className="resize-none rounded-xl text-sm" /></div>
              </div>
            </div>
          )}

          {/* Step 2 */}
          {step === 2 && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Service *</Label>
                  <div className="flex gap-2">
                    <Select value={services.includes(form.service) ? form.service : ''} onValueChange={v => setForm(p => ({ ...p, service: v }))}>
                      <SelectTrigger className={`h-9 rounded-xl text-sm ${!form.service ? 'border-red-300' : ''}`}><SelectValue placeholder="Select a service" /></SelectTrigger>
                      <SelectContent>{services.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input value={form.service} onChange={e => setForm(p => ({ ...p, service: e.target.value }))} placeholder="Or type custom service *" className={`h-9 rounded-xl text-sm flex-1 ${!form.service ? 'border-red-300 ring-1 ring-red-200' : ''}`} />
                  </div>
                  {!form.service && <p className="text-[11px] text-red-500 font-medium">⚠ Service is required</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-semibold">Subject</Label>
                  <Input name="subject" value={form.subject} onChange={handleChange} className="h-9 rounded-xl text-sm" placeholder="e.g., Quotation for GST Registration" />
                </div>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Scope of Work</Label>
                {form.scope_of_work.map((s, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input value={s} onChange={e => handleListChange('scope_of_work', i, e.target.value)} className="h-9 rounded-xl text-sm" placeholder="e.g., Filing of GSTR-1 monthly" />
                    {form.scope_of_work.length > 1 && <Button variant="ghost" size="icon" onClick={() => removeListItem('scope_of_work', i)}><Trash2 className="h-4 w-4 text-red-400" /></Button>}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => addListItem('scope_of_work')} className="rounded-xl gap-1 text-blue-600 border-blue-200 hover:bg-blue-50"><Plus className="h-3.5 w-3.5" />Add Scope Item</Button>
              </div>
              <div className="space-y-2">
                <Label className="text-xs font-semibold">Quotation Items *</Label>
                <div className="grid grid-cols-12 gap-1 text-[10px] font-semibold text-slate-500 px-1">
                  <div className="col-span-4">Description</div>
                  <div className="col-span-2">Qty</div>
                  <div className="col-span-2">Unit</div>
                  <div className="col-span-2 text-right">Unit Price</div>
                  <div className="col-span-2 text-right">Amount</div>
                </div>
                {form.items.map((item, i) => (
                  <div key={i} className="grid grid-cols-12 gap-1 items-center">
                    <Input value={item.description} onChange={e => handleItemChange(i, 'description', e.target.value)} className="col-span-4 h-8 rounded-lg text-sm" placeholder="Item description" />
                    <Input value={item.quantity} onChange={e => handleItemChange(i, 'quantity', parseFloat(e.target.value) || 0)} type="number" step="0.01" className="col-span-2 h-8 rounded-lg text-sm" />
                    <Select value={item.unit} onValueChange={v => handleItemChange(i, 'unit', v)}>
                      <SelectTrigger className="col-span-2 h-8 rounded-lg text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{UNIT_OPTIONS.map(u => <SelectItem key={u} value={u}>{u}</SelectItem>)}</SelectContent>
                    </Select>
                    <Input value={item.unit_price} onChange={e => handleItemChange(i, 'unit_price', parseFloat(e.target.value) || 0)} type="number" step="0.01" className="col-span-2 h-8 rounded-lg text-sm text-right" />
                    <div className="col-span-1 text-right text-sm text-slate-600 font-medium">{item.amount.toFixed(0)}</div>
                    {form.items.length > 1 && <Button variant="ghost" size="icon" className="col-span-1 h-8 w-8" onClick={() => removeItem(i)}><Trash2 className="h-3.5 w-3.5 text-red-400" /></Button>}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={addItem} className="rounded-xl gap-1 text-blue-600 border-blue-200 hover:bg-blue-50"><Plus className="h-3.5 w-3.5" />Add Item</Button>
              </div>
            </div>
          )}

          {/* Step 3 */}
          {step === 3 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { label: 'GST Rate (%)',   name: 'gst_rate',      type: 'number' },
                { label: 'Validity (Days)',name: 'validity_days',  type: 'number' },
                { label: 'Timeline',       name: 'timeline',       type: 'text', placeholder: 'e.g., 7 working days' },
                { label: 'Advance Terms',  name: 'advance_terms',  type: 'text', placeholder: 'e.g., 50% advance required' },
              ].map(f => (
                <div key={f.name} className="space-y-1.5">
                  <Label className="text-xs font-semibold">{f.label}</Label>
                  <Input name={f.name} value={form[f.name]} onChange={handleChange} type={f.type} placeholder={f.placeholder || ''} className="h-9 rounded-xl text-sm" />
                </div>
              ))}
              <div className="md:col-span-2 space-y-1.5">
                <Label className="text-xs font-semibold">Payment Terms</Label>
                <Textarea name="payment_terms" value={form.payment_terms} onChange={handleChange} rows={2} className="resize-none rounded-xl text-sm" />
              </div>
              <div className="md:col-span-2 space-y-2">
                <Label className="text-xs font-semibold">Extra Terms &amp; Conditions</Label>
                {form.extra_terms.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input value={t} onChange={e => handleListChange('extra_terms', i, e.target.value)} className="h-9 rounded-xl text-sm" placeholder="Additional term..." />
                    {form.extra_terms.length > 1 && <Button variant="ghost" size="icon" onClick={() => removeListItem('extra_terms', i)}><Trash2 className="h-4 w-4 text-red-400" /></Button>}
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => addListItem('extra_terms')} className="rounded-xl gap-1 text-blue-600 border-blue-200 hover:bg-blue-50"><Plus className="h-3.5 w-3.5" />Add Term</Button>
              </div>
              <div className="md:col-span-2 space-y-1.5">
                <Label className="text-xs font-semibold">Notes</Label>
                <Textarea name="notes" value={form.notes} onChange={handleChange} rows={2} className="resize-none rounded-xl text-sm" />
              </div>
              <div className="md:col-span-2 flex items-center justify-between gap-3 p-3 rounded-xl border border-blue-100 bg-blue-50/50">
                <div className="space-y-0.5">
                  <Label className="text-xs font-semibold flex items-center gap-1.5"><FileCheck className="h-3.5 w-3.5 text-blue-600" />Attach Document Checklist</Label>
                  <p className="text-[11px] text-slate-500">When ON, the document checklist for this service is included in the quotation PDF, preview, and print.</p>
                </div>
                <Switch
                  checked={!!form.attach_checklist}
                  onCheckedChange={(v) => setForm(prev => ({ ...prev, attach_checklist: !!v }))}
                />
              </div>
              {form.attach_checklist && (
                <div className="md:col-span-2 space-y-2">
                  <Label className="text-xs font-semibold">Extra Document Checklist Items</Label>
                  {form.extra_checklist_items.map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input value={item} onChange={e => handleListChange('extra_checklist_items', i, e.target.value)} className="h-9 rounded-xl text-sm" placeholder="e.g., Latest Bank Statement" />
                      {form.extra_checklist_items.length > 1 && <Button variant="ghost" size="icon" onClick={() => removeListItem('extra_checklist_items', i)}><Trash2 className="h-4 w-4 text-red-400" /></Button>}
                    </div>
                  ))}
                  <Button variant="outline" size="sm" onClick={() => addListItem('extra_checklist_items')} className="rounded-xl gap-1 text-blue-600 border-blue-200 hover:bg-blue-50"><Plus className="h-3.5 w-3.5" />Add Checklist Item</Button>
                </div>
              )}
            </div>
          )}

          {/* Step 4 — Live PDF Preview */}
          {step === 4 && (() => {
            const previewCompany = companies.find(c => c.id === form.company_id) || {};
            const previewQtn = {
              ...form,
              quotation_no: editingQuotation?.quotation_no || 'QTN-PREVIEW',
              date: editingQuotation?.date || new Date().toISOString().slice(0, 10),
            };
            const _qtnSettings  = getQtnSettings(form.company_id);
            const _activeColor  = _qtnSettings.theme === 'custom'
              ? _qtnSettings.custom_color
              : (_qtnSettings.custom_color || previewCompany.invoice_custom_color || '#0D3B66');
            const previewHTML = generateQuotationHTML(previewQtn, {
              company:     previewCompany,
              template:    _qtnSettings.template    || previewCompany.invoice_template    || 'classic',
              theme:       _qtnSettings.theme       || 'custom',
              customColor: _activeColor,
              attachChecklist: form.attach_checklist !== false,
            });
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-50 border border-blue-100 text-xs text-blue-700">
                  <Eye className="h-3.5 w-3.5 flex-shrink-0" />
                  <span><strong>Live preview</strong> — uses real template engine, reflects every setting change. This is pixel-identical to the PDF &amp; printed output.</span>
                </div>
                <div className="rounded-xl border border-slate-200 overflow-hidden shadow-sm" style={{ height: '52vh' }}>
                  <iframe
                    key={JSON.stringify(form)}
                    title="Quotation Preview"
                    style={{ width: '100%', height: '100%', border: 'none' }}
                    srcDoc={previewHTML}
                  />
                </div>
                {/* Quick totals bar */}
                <div className="flex items-center justify-between px-4 py-2 rounded-xl bg-slate-800 text-white text-sm">
                  <span className="text-slate-400 text-xs">Subtotal: <strong className="text-white">₹{subtotal.toFixed(2)}</strong></span>
                  {form.gst_rate > 0 && <span className="text-slate-400 text-xs">GST ({form.gst_rate}%): <strong className="text-white">₹{gstAmount.toFixed(2)}</strong></span>}
                  <span className="font-bold text-base" style={{ color: '#4ade80' }}>Total: ₹{total.toFixed(2)}</span>
                </div>
              </div>
            );
          })()}
        </div>

        <DialogFooter className="gap-2 pt-2 border-t">
          {step > 1 && <Button variant="outline" onClick={() => setStep(p => p - 1)} className="rounded-xl gap-1"><ChevronLeft className="h-4 w-4" />Previous</Button>}
          {step < STEPS.length && <Button onClick={() => setStep(p => p + 1)} className="rounded-xl gap-1" style={{ background: COLORS.deepBlue }}>Next<ChevronRight className="h-4 w-4" /></Button>}
          {step === STEPS.length && (
            <Button onClick={handleSave} disabled={saving} className="rounded-xl gap-2" style={{ background: COLORS.emeraldGreen }}>
              {saving ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><Check className="h-4 w-4" />Save Quotation</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// QUOTATION DETAIL PANEL
// ════════════════════════════════════════════════════════════════════════════════
const QuotationDetailPanel = ({
  quotation: q, open, onClose, onEdit, onDelete, isDark, companies,
  downloading, handleDownload, handleDownloadChecklistPdf,
  handleConvertToInvoice, convertingId,
  setEmailModalQuotation, setEmailModalPdfType, setIsEmailModalOpen,
  setWhatsAppModalQuotation, setWhatsAppModalPdfType, setIsWhatsAppModalOpen,
}) => {
  const meta    = STATUS_META[q?.status] || STATUS_META.draft;
  const company = companies?.find(c => c.id === q?.company_id);
  if (!q) return null;

  const surface    = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const textPrimary = isDark ? 'text-slate-100' : 'text-slate-900';
  const textSub    = isDark ? 'text-slate-400' : 'text-slate-500';
  const divider    = isDark ? 'border-slate-700' : 'border-slate-100';
  const cardBg     = isDark ? 'bg-slate-700/50' : 'bg-slate-50';

  const items      = q.items || [];
  const scopeItems = Array.isArray(q.scope_of_work) ? q.scope_of_work : (q.scope_of_work ? [q.scope_of_work] : []);

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent hideClose className={`max-w-3xl max-h-[92vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 ${surface}`}>
        <DialogTitle className="sr-only">Quotation Detail</DialogTitle>
        <DialogDescription className="sr-only">Full quotation details</DialogDescription>

        {/* HEADER */}
        <div className="px-7 py-5 relative overflow-hidden flex-shrink-0"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
          <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
                <FileText className="h-5 w-5 text-white" />
              </div>
              <div>
                <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                  <p className="text-white font-bold text-lg">{q.quotation_no}</p>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${meta.bg} ${meta.text}`}>{meta.label}</span>
                </div>
                <p className="text-white/70 text-sm">{q.client_name}</p>
                <p className="text-white/50 text-xs mt-0.5">{q.date} · Valid {q.validity_days || 30} days · {q.service}</p>
              </div>
            </div>
            <button onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center flex-shrink-0 transition-colors">
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* BODY */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-6 space-y-5">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className={`rounded-xl p-4 border ${cardBg} ${divider}`}>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${textSub}`}>Total Amount</p>
                <p className="text-xl font-black text-emerald-600 dark:text-emerald-400">{fmtC(q.total || 0)}</p>
              </div>
              <div className={`rounded-xl p-4 border ${cardBg} ${divider}`}>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${textSub}`}>GST Rate</p>
                <p className={`text-xl font-black ${textPrimary}`}>{q.gst_rate ?? 18}%</p>
              </div>
              <div className={`rounded-xl p-4 border ${cardBg} ${divider}`}>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-1 ${textSub}`}>Status</p>
                <span className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full ${meta.bg} ${meta.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />{meta.label}
                </span>
              </div>
            </div>

            {/* Client info */}
            <div className={`rounded-xl border p-4 ${cardBg} ${divider}`}>
              <p className={`text-[10px] font-bold uppercase tracking-widest mb-3 ${textSub}`}>Client Information</p>
              <div className="grid grid-cols-2 gap-3">
                <div><p className={`text-xs ${textSub}`}>Name</p><p className={`text-sm font-semibold ${textPrimary}`}>{q.client_name || '—'}</p></div>
                {q.client_email && <div><p className={`text-xs ${textSub}`}>Email</p><p className={`text-sm font-semibold ${textPrimary}`}>{q.client_email}</p></div>}
                {q.client_phone && <div><p className={`text-xs ${textSub}`}>Phone</p><p className={`text-sm font-semibold ${textPrimary}`}>{q.client_phone}</p></div>}
                {q.client_address && <div className="col-span-2"><p className={`text-xs ${textSub}`}>Address</p><p className={`text-sm font-semibold ${textPrimary}`}>{q.client_address}</p></div>}
                {company && <div><p className={`text-xs ${textSub}`}>Our Company</p><p className={`text-sm font-semibold ${textPrimary}`}>{company.name}</p></div>}
              </div>
            </div>

            {/* Line items */}
            {items.length > 0 && (
              <div className={`rounded-xl border overflow-hidden ${divider}`}>
                <div className={`px-5 py-3 border-b ${cardBg} ${divider}`}>
                  <p className={`text-xs font-bold uppercase tracking-widest ${textSub}`}>Line Items ({items.length})</p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className={`border-b ${isDark ? 'border-slate-700 bg-slate-700/40' : 'bg-slate-50/60 border-slate-100'}`}>
                        {['#', 'Description', 'Qty', 'Unit', 'Rate', 'Amount'].map(h => (
                          <th key={h} className={`px-4 py-2 text-left text-[10px] font-bold uppercase tracking-wider ${textSub}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, i) => (
                        <tr key={i} className={`border-b last:border-0 ${isDark ? 'border-slate-700' : 'border-slate-50'}`}>
                          <td className={`px-4 py-3 text-xs font-bold ${textSub}`}>{i + 1}</td>
                          <td className={`px-4 py-3 text-sm ${textPrimary}`}>{item.description || '—'}</td>
                          <td className={`px-4 py-3 text-sm ${textPrimary}`}>{item.quantity}</td>
                          <td className={`px-4 py-3 text-xs ${textSub}`}>{item.unit || 'service'}</td>
                          <td className={`px-4 py-3 text-sm ${textPrimary}`}>{fmtC(item.unit_price || 0)}</td>
                          <td className="px-4 py-3 text-sm font-semibold text-emerald-600 dark:text-emerald-400">{fmtC(item.amount || (item.unit_price * item.quantity) || 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={`flex justify-end px-5 py-3 border-t ${divider} gap-6`}>
                  <span className={`text-xs ${textSub}`}>Total</span>
                  <span className="text-sm font-black text-emerald-600 dark:text-emerald-400">{fmtC(q.total || 0)}</span>
                </div>
              </div>
            )}

            {/* Scope of work */}
            {scopeItems.filter(Boolean).length > 0 && (
              <div className={`rounded-xl border p-4 ${cardBg} ${divider}`}>
                <p className={`text-[10px] font-bold uppercase tracking-widest mb-3 ${textSub}`}>Scope of Work</p>
                <ul className="space-y-1.5">
                  {scopeItems.filter(Boolean).map((s, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Check className="h-3.5 w-3.5 text-emerald-500 mt-0.5 flex-shrink-0" />
                      <span className={`text-sm ${textPrimary}`}>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Terms grid */}
            {(q.payment_terms || q.timeline || q.advance_terms || q.notes) && (
              <div className="grid grid-cols-2 gap-3">
                {q.payment_terms && (
                  <div className={`rounded-xl border p-4 ${cardBg} ${divider}`}>
                    <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${textSub}`}>Payment Terms</p>
                    <p className={`text-sm ${textPrimary}`}>{q.payment_terms}</p>
                  </div>
                )}
                {q.timeline && (
                  <div className={`rounded-xl border p-4 ${cardBg} ${divider}`}>
                    <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${textSub}`}>Timeline</p>
                    <p className={`text-sm ${textPrimary}`}>{q.timeline}</p>
                  </div>
                )}
                {q.advance_terms && (
                  <div className={`rounded-xl border p-4 ${cardBg} ${divider}`}>
                    <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${textSub}`}>Advance Terms</p>
                    <p className={`text-sm ${textPrimary}`}>{q.advance_terms}</p>
                  </div>
                )}
                {q.notes && (
                  <div className={`rounded-xl border p-4 ${cardBg} ${divider} col-span-2`}>
                    <p className={`text-[10px] font-bold uppercase tracking-widest mb-1.5 ${textSub}`}>Notes</p>
                    <p className={`text-sm ${textPrimary}`}>{q.notes}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* FOOTER ACTIONS */}
        <div className={`flex-shrink-0 border-t ${divider} px-6 py-4 flex items-center gap-2 flex-wrap ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
          <Button size="sm" variant="outline" title="Edit Quotation" onClick={() => { onEdit(q); onClose(); }} className="h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold">
            <Edit className="h-3.5 w-3.5" /> Edit
          </Button>
          <Button size="sm" variant="outline" title="Download PDF" onClick={() => handleDownload(q.id, q.quotation_no)} disabled={downloading === q.id}
            className="h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold">
            {downloading === q.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} PDF
          </Button>
          {q.attach_checklist !== false && (
            <Button size="sm" variant="outline" title="Download Document Checklist" onClick={() => handleDownloadChecklistPdf(q.id, q.quotation_no)} disabled={downloading === q.id + '-checklist'}
              className="h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold">
              {downloading === q.id + '-checklist' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck className="h-3.5 w-3.5" />} Checklist
            </Button>
          )}
          <Button size="sm" variant="outline" title="Send via Email" onClick={() => { setEmailModalQuotation(q); setEmailModalPdfType('quotation'); setIsEmailModalOpen(true); onClose(); }}
            className="h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold">
            <Mail className="h-3.5 w-3.5" /> Email
          </Button>
          <Button size="sm" variant="outline" title="Send via WhatsApp" onClick={() => { setWhatsAppModalQuotation(q); setWhatsAppModalPdfType('quotation'); setIsWhatsAppModalOpen(true); onClose(); }}
            className="h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold text-green-600 border-green-200 hover:bg-green-50">
            <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
          </Button>
          <Button size="sm" title="Convert to Invoice" onClick={() => { handleConvertToInvoice(q.id); onClose(); }} disabled={convertingId === q.id}
            className="h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold bg-purple-600 hover:bg-purple-700 text-white ml-auto">
            {convertingId === q.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />} Convert to Invoice
          </Button>
          <Button size="sm" variant="ghost" title="Delete Quotation" onClick={() => { if (window.confirm('Delete this quotation?')) { onDelete(q.id); onClose(); } }}
            className="h-9 px-3 rounded-xl text-xs text-red-500 hover:bg-red-50">
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

// ════════════════════════════════════════════════════════════════════════════════
// LINK ACTION BUTTON  — link a quotation to a Lead or an existing Invoice
// ════════════════════════════════════════════════════════════════════════════════
function LinkActionButton({ q, onUpdated, isDark, compact = false }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // ── Lead state ────────────────────────────────────────────────────────────
  const [leads, setLeads] = useState([]);
  const [loadingLeads, setLoadingLeads] = useState(false);
  const [savingLead, setSavingLead] = useState(false);
  const [pickingLead, setPickingLead] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState(q.lead_id || '');

  // ── Invoice link state ────────────────────────────────────────────────────
  const [pickingInvoice, setPickingInvoice] = useState(false);
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceResults, setInvoiceResults] = useState([]);
  const [searchingInv, setSearchingInv] = useState(false);
  const [savingInvoice, setSavingInvoice] = useState(false);
  const invSearchRef = useRef(null);

  // Lazy-load leads the first time the popover opens.
  const ensureLeads = async () => {
    if (leads.length || loadingLeads) return;
    setLoadingLeads(true);
    try {
      const res = await api.get('/leads');
      setLeads(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      toast.error(getErrMsg(err, 'Failed to load leads'));
    } finally {
      setLoadingLeads(false);
    }
  };

  const linkedLead = useMemo(
    () => leads.find(l => l.id === q.lead_id) || null,
    [leads, q.lead_id]
  );

  const saveLeadLink = async (leadId) => {
    setSavingLead(true);
    try {
      // Partial PUT — backend merges into existing quotation.
      await api.put(`/quotations/${q.id}`, { lead_id: leadId || null });
      toast.success(leadId ? 'Quotation linked to lead' : 'Lead link removed');
      setPickingLead(false);
      setOpen(false);
      onUpdated && onUpdated();
    } catch (err) {
      toast.error(getErrMsg(err, 'Failed to update link'));
    } finally {
      setSavingLead(false);
    }
  };

  const goToLead = () => {
    setOpen(false);
    // /leads is the Lead Management page in AppRoutes.jsx
    navigate(`/leads?lead_id=${encodeURIComponent(q.lead_id)}`);
  };

  // ── Invoice helpers ────────────────────────────────────────────────────────
  const searchInvoices = useCallback(async (term) => {
    if (!term || term.length < 2) { setInvoiceResults([]); return; }
    setSearchingInv(true);
    try {
      const res = await api.get('/invoices', { params: { search: term, page_size: 8 } });
      setInvoiceResults(Array.isArray(res.data?.invoices) ? res.data.invoices : []);
    } catch { setInvoiceResults([]); }
    finally { setSearchingInv(false); }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchInvoices(invoiceSearch), 300);
    return () => clearTimeout(t);
  }, [invoiceSearch, searchInvoices]);

  const openInvoicePicker = () => {
    setPickingInvoice(true); setInvoiceSearch(''); setInvoiceResults([]);
    setTimeout(() => invSearchRef.current?.focus(), 50);
  };
  const cancelInvoicePicker = () => { setPickingInvoice(false); setInvoiceSearch(''); setInvoiceResults([]); };

  const saveInvoiceLink = async (inv) => {
    setSavingInvoice(true);
    try {
      await api.post(`/quotations/${q.id}/link-invoice`, { invoice_id: inv.id });
      toast.success(`Linked to invoice ${inv.invoice_no}`);
      cancelInvoicePicker(); setOpen(false); onUpdated && onUpdated();
    } catch (err) { toast.error(getErrMsg(err, 'Failed to link invoice')); }
    finally { setSavingInvoice(false); }
  };

  const unlinkInvoice = async () => {
    if (!window.confirm('Remove the invoice link from this quotation?')) return;
    setSavingInvoice(true);
    try {
      await api.delete(`/quotations/${q.id}/link-invoice`);
      toast.success('Invoice link removed');
      setOpen(false); onUpdated && onUpdated();
    } catch (err) { toast.error(getErrMsg(err, 'Failed to remove link')); }
    finally { setSavingInvoice(false); }
  };

  const goToInvoice = () => {
    setOpen(false);
    if (q.invoice_id) navigate(`/invoicing?invoice_id=${encodeURIComponent(q.invoice_id)}`);
    else navigate(`/invoicing?search=${encodeURIComponent(q.quotation_no || '')}`);
  };

  const hasAnyLink = q.lead_id || q.invoice_id;
  const btnClass = compact
    ? `w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${hasAnyLink ? (isDark ? 'text-amber-400 hover:bg-amber-900/30' : 'text-amber-600 hover:bg-amber-50') : (isDark ? 'text-slate-400 hover:text-amber-400 hover:bg-amber-900/30' : 'text-slate-400 hover:text-amber-600 hover:bg-amber-50')}`
    : 'h-9 px-4 rounded-xl gap-1.5 text-xs font-semibold';

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (v) { ensureLeads(); setPickingInvoice(false); } }}>
      <PopoverTrigger asChild>
        {compact ? (
          <button
            title={hasAnyLink ? 'Manage links (lead / invoice)' : 'Link to lead or invoice'}
            className={btnClass}
            onClick={(e) => e.stopPropagation()}
          >
            <Link2 className="h-3.5 w-3.5" />
          </button>
        ) : (
          <Button size="sm" variant="outline" title="Link" className={btnClass}
            onClick={(e) => e.stopPropagation()}>
            <Link2 className="h-3.5 w-3.5" /> Link
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-3 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Lead section ─────────────────────────────────────────────── */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
              <Users className="h-3 w-3" /> Linked Lead
            </p>
            {q.lead_id && !pickingLead && (
              <button
                onClick={() => setPickingLead(true)}
                className="text-[10px] font-semibold text-blue-600 hover:underline"
              >
                Change
              </button>
            )}
          </div>

          {q.lead_id && !pickingLead ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 p-2.5 space-y-2">
              <p className="text-xs font-semibold text-slate-800 truncate">
                {linkedLead
                  ? (linkedLead.company_name || linkedLead.name || 'Lead')
                  : (loadingLeads ? 'Loading lead…' : 'Lead linked')}
              </p>
              <div className="flex gap-1.5">
                <Button size="sm" variant="default"
                  className="h-7 px-2 text-[11px] gap-1 bg-amber-600 hover:bg-amber-700 text-white"
                  onClick={goToLead}>
                  <ExternalLink className="h-3 w-3" /> Open Lead
                </Button>
                <Button size="sm" variant="ghost"
                  className="h-7 px-2 text-[11px] text-red-500 hover:bg-red-50"
                  disabled={savingLead}
                  onClick={() => saveLeadLink('')}>
                  Unlink
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Select
                value={selectedLeadId || 'none'}
                onValueChange={(v) => setSelectedLeadId(v === 'none' ? '' : v)}
                disabled={loadingLeads || savingLead}
              >
                <SelectTrigger className="h-8 text-xs rounded-lg">
                  <SelectValue placeholder={loadingLeads ? 'Loading leads…' : 'Select a lead…'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— No lead —</SelectItem>
                  {leads.map(l => (
                    <SelectItem key={l.id} value={l.id}>
                      {(l.company_name || l.name || 'Lead')}
                      {l.phone ? ` · ${l.phone}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-1.5">
                <Button size="sm" className="h-7 px-2 text-[11px] gap-1 bg-blue-600 hover:bg-blue-700 text-white"
                  disabled={savingLead || (selectedLeadId === (q.lead_id || ''))}
                  onClick={() => saveLeadLink(selectedLeadId)}>
                  {savingLead ? <Loader2 className="h-3 w-3 animate-spin" /> : <Link2 className="h-3 w-3" />}
                  Save Link
                </Button>
                {pickingLead && (
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                    onClick={() => { setPickingLead(false); setSelectedLeadId(q.lead_id || ''); }}>
                    Cancel
                  </Button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── INVOICE SECTION ──────────────────────────────────────────── */}
        <div className="border-t pt-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1">
              <Receipt className="h-3 w-3" /> Linked Invoice
            </p>
            {q.invoice_id && !pickingInvoice && (
              <button onClick={openInvoicePicker}
                className="text-[10px] font-semibold text-blue-600 hover:underline">
                Change
              </button>
            )}
          </div>

          {/* Already linked */}
          {q.invoice_id && !pickingInvoice ? (
            <div className="rounded-lg border border-purple-200 bg-purple-50/60 p-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <Receipt className="h-3.5 w-3.5 text-purple-500 flex-shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-slate-800 truncate">{q.invoice_no || q.invoice_id}</p>
                  <p className="text-[10px] text-slate-500">Invoice linked</p>
                </div>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="default"
                  className="h-7 px-2 text-[11px] gap-1 bg-purple-600 hover:bg-purple-700 text-white"
                  onClick={goToInvoice}>
                  <ExternalLink className="h-3 w-3" /> Open Invoice
                </Button>
                <Button size="sm" variant="ghost"
                  className="h-7 px-2 text-[11px] text-red-500 hover:bg-red-50"
                  disabled={savingInvoice}
                  onClick={unlinkInvoice}>
                  {savingInvoice ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Unlink'}
                </Button>
              </div>
            </div>

          ) : pickingInvoice ? (
            /* Invoice search picker */
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 pointer-events-none" />
                <input
                  ref={invSearchRef}
                  value={invoiceSearch}
                  onChange={e => setInvoiceSearch(e.target.value)}
                  placeholder="Search by invoice no. or client…"
                  className={`w-full pl-7 pr-7 h-8 text-xs rounded-lg border outline-none focus:ring-1 focus:ring-purple-400 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100 placeholder:text-slate-400' : 'bg-white border-slate-200 text-slate-800 placeholder:text-slate-400'}`}
                />
                {searchingInv && (
                  <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3 w-3 text-slate-400 animate-spin" />
                )}
              </div>

              {invoiceSearch.length >= 2 && (
                <div className={`rounded-lg border max-h-44 overflow-y-auto divide-y ${isDark ? 'bg-slate-800 border-slate-700 divide-slate-700' : 'bg-white border-slate-200 divide-slate-100'}`}>
                  {invoiceResults.length === 0 && !searchingInv ? (
                    <p className="px-3 py-3 text-[11px] text-slate-400 text-center">No invoices found</p>
                  ) : invoiceResults.map(inv => (
                    <button key={inv.id} disabled={savingInvoice}
                      onClick={() => saveInvoiceLink(inv)}
                      className={`w-full flex items-center justify-between px-3 py-2 text-left transition-colors ${isDark ? 'hover:bg-purple-900/20' : 'hover:bg-purple-50'}`}>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>
                          {inv.invoice_no}
                        </p>
                        <p className="text-[10px] text-slate-400 truncate">
                          {inv.client_name}{inv.invoice_date ? ` · ${inv.invoice_date}` : ''}
                        </p>
                      </div>
                      <span className="text-[10px] font-bold text-purple-600 flex-shrink-0 ml-2">
                        {savingInvoice ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Link'}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] w-full"
                onClick={cancelInvoicePicker}>
                Cancel
              </Button>
            </div>

          ) : (
            /* No invoice linked yet */
            <div className="space-y-2">
              <p className="text-[11px] text-slate-500 leading-snug">
                No invoice linked. Convert this quotation to create a new invoice, or link it to an existing one below.
              </p>
              <Button size="sm" variant="default"
                className="h-7 px-2 text-[11px] gap-1 bg-purple-600 hover:bg-purple-700 text-white w-full"
                onClick={openInvoicePicker}>
                <Link2 className="h-3 w-3" /> Link Existing Invoice
              </Button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ════════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════════════════════
export default function Quotations() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isDark   = useDark();

  // ── State ──────────────────────────────────────────────────────────────────
  const [quotations,    setQuotations]    = useState([]);
  const [companies,     setCompanies]     = useState([]);
  const [services,      setServices]      = useState([]);
  const [loading,       setLoading]       = useState(true);
  const [viewMode,      setViewMode]      = useState('list');
  const [filterStatus,  setFilterStatus]  = useState('all');
  const [filterService, setFilterService] = useState('all');
  const [searchInput,   setSearchInput]   = useState('');
  const [searchTerm,    setSearchTerm]    = useState('');
  const [downloading,   setDownloading]   = useState(null);
  const [convertingId,  setConvertingId]  = useState(null);

  // Modals
  const [isManagerOpen,         setIsManagerOpen]         = useState(false);
  const [editingQuotation,      setEditingQuotation]      = useState(null);
  const [isCompanyListOpen,     setIsCompanyListOpen]     = useState(false);
  const [isSettingsOpen,        setIsSettingsOpen]        = useState(false);
  const [isEmailModalOpen,      setIsEmailModalOpen]      = useState(false);
  const [emailModalQuotation,   setEmailModalQuotation]   = useState(null);
  const [emailModalPdfType,     setEmailModalPdfType]     = useState('quotation');
  const [isWhatsAppModalOpen,   setIsWhatsAppModalOpen]   = useState(false);
  const [whatsAppModalQuotation,setWhatsAppModalQuotation]= useState(null);
  const [whatsAppModalPdfType,  setWhatsAppModalPdfType]  = useState('quotation');
  const [detailQuotation,       setDetailQuotation]       = useState(null);
  const [isDetailOpen,          setIsDetailOpen]          = useState(false);

  // Pagination
  const SECTION_PAGE_SIZE = 10;
  const [pendingPage,  setPendingPage]  = useState(1);
  const [closedPage,   setClosedPage]   = useState(1);
  const [selectedIds,  setSelectedIds]  = useState(new Set());

  // ── Debounce search ────────────────────────────────────────────────────────
  useEffect(() => {
    const t = setTimeout(() => { setSearchTerm(searchInput); setPendingPage(1); setClosedPage(1); }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => { setPendingPage(1); setClosedPage(1); }, [filterStatus, filterService]);

  // Shows a non-blocking "server is waking up" hint while api.js is still
  // retrying a cold-started backend, instead of the page just silently
  // rendering "0 quotations" / "0 companies" with no explanation. Clears
  // itself the moment a real (non-degraded) response comes back.
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectRetryRef = useRef(null);

  // ── Data fetching ──────────────────────────────────────────────────────────
  const fetchQuotations = async () => {
    setLoading(true);
    try {
      // api.js waits for the backend to finish waking up (Render cold start)
      // and degrades a still-unavailable collection to an empty list, so a
      // transient 404 no longer shows a scary error toast here.
      const res = await api.get('/quotations');
      setQuotations(Array.isArray(res.data) ? res.data : (res.data?.quotations || []));
      if (res?._degraded) {
        // api.js already retried for ~50s and still couldn't reach the
        // route — keep the reconnecting hint up and quietly try again in
        // the background rather than leaving the page stuck on 0 records.
        setReconnecting(true);
        clearTimeout(reconnectRetryRef.current);
        reconnectRetryRef.current = setTimeout(() => { fetchQuotations(); fetchMeta(); }, 15000);
      } else {
        setReconnecting(false);
      }
    } catch (err) {
      if (err?.response?.status === 404) {
        try {
          const fallback = await api.get('/quotations/list');
          setQuotations(Array.isArray(fallback.data) ? fallback.data : []);
          return;
        } catch (_) { /* fall through */ }
      }
      setQuotations([]);
      toast.error(getErrMsg(err, 'Failed to fetch quotations'));
    }
    finally { setLoading(false); }
  };

  const fetchMeta = async () => {
    try {
      const [companyList, sRes] = await Promise.all([fetchCompanies(), api.get('/quotations/services')]);
      setCompanies(companyList); setServices(sRes.data.services);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[quotations] failed to load meta:', err?.response?.status || err?.message);
    }
  };

  useEffect(() => {
    fetchMeta(); fetchQuotations();
    return () => clearTimeout(reconnectRetryRef.current);
  }, []);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total        = quotations.length;
    const totalValue   = quotations.reduce((s, q) => s + (q.total || 0), 0);
    const accepted     = quotations.filter(q => q.status === 'accepted');
    const acceptedValue = accepted.reduce((s, q) => s + (q.total || 0), 0);
    const pending      = quotations.filter(q => q.status === 'draft' || q.status === 'sent').length;
    const convRate     = total > 0 ? Math.round((accepted.length / total) * 100) : 0;
    return { total, totalValue, acceptedValue, pending, convRate, acceptedCount: accepted.length };
  }, [quotations]);

  // ── Filtered ───────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return quotations.filter(q => {
      if (filterStatus !== 'all' && q.status !== filterStatus) return false;
      if (filterService !== 'all' && q.service !== filterService) return false;
      if (!searchTerm) return true;
      const s = searchTerm.toLowerCase();
      return q.quotation_no?.toLowerCase().includes(s) || q.client_name?.toLowerCase().includes(s) || q.service?.toLowerCase().includes(s) || q.client_email?.toLowerCase().includes(s);
    });
  }, [quotations, filterStatus, filterService, searchTerm]);

  // ── Board columns ──────────────────────────────────────────────────────────
  const boardColumns = useMemo(() => {
    const cols = [
      { id: 'draft',    label: 'Draft',    color: '#94A3B8',          bgLight: '#F8FAFC', bgDark: 'rgba(148,163,184,0.08)' },
      { id: 'sent',     label: 'Sent',     color: COLORS.mediumBlue,  bgLight: '#EFF6FF', bgDark: 'rgba(31,111,178,0.10)'  },
      { id: 'accepted', label: 'Accepted', color: COLORS.emeraldGreen,bgLight: '#F0FDF4', bgDark: 'rgba(31,175,90,0.08)'   },
      { id: 'rejected', label: 'Rejected', color: COLORS.coral,       bgLight: '#FEF2F2', bgDark: 'rgba(239,68,68,0.08)'   },
    ];
    return cols.map(col => ({ ...col, items: filtered.filter(q => (q.status || 'draft') === col.id) }));
  }, [filtered]);

  // ── Split: pending (draft/sent) vs closed (accepted/rejected) ─────────────
  const pendingQuotations = useMemo(() =>
    filtered.filter(q => q.status === 'draft' || q.status === 'sent' || !q.status),
    [filtered]);
  const closedQuotations = useMemo(() =>
    filtered.filter(q => q.status === 'accepted' || q.status === 'rejected'),
    [filtered]);

  const paginatedPending = useMemo(() => {
    const start = (pendingPage - 1) * SECTION_PAGE_SIZE;
    return pendingQuotations.slice(start, start + SECTION_PAGE_SIZE);
  }, [pendingQuotations, pendingPage]);
  const totalPendingPages = useMemo(() => Math.max(1, Math.ceil(pendingQuotations.length / SECTION_PAGE_SIZE)), [pendingQuotations]);

  const paginatedClosed = useMemo(() => {
    const start = (closedPage - 1) * SECTION_PAGE_SIZE;
    return closedQuotations.slice(start, start + SECTION_PAGE_SIZE);
  }, [closedQuotations, closedPage]);
  const totalClosedPages = useMemo(() => Math.max(1, Math.ceil(closedQuotations.length / SECTION_PAGE_SIZE)), [closedQuotations]);

  // ── Helpers ────────────────────────────────────────────────────────────────
  const getCompany = (id) => companies.find(c => c.id === id);

  const handleStatusChange = async (qtnId, newStatus) => {
    try {
      const historyEntry = { status: newStatus, changed_at: new Date().toISOString() };
      await api.put(`/quotations/${qtnId}`, { status: newStatus });
      toast.success('Status updated');
      setQuotations(prev => prev.map(q => q.id === qtnId
        ? { ...q, status: newStatus, status_history: [...(q.status_history || []), historyEntry] }
        : q));
    } catch { toast.error('Failed to update status'); }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this quotation?')) return;
    try {
      await api.delete(`/quotations/${id}`);
      toast.success('Quotation deleted');
      setQuotations(prev => prev.filter(q => q.id !== id));
    } catch (err) { toast.error(getErrMsg(err, 'Failed to delete quotation')); }
  };

  const handleConvertToInvoice = async (qtnId) => {
    const existing = quotations.find(x => x.id === qtnId);
    if (existing && existing.invoice_id) {
      if (!window.confirm('This quotation has already been converted. Open the existing invoice?')) return;
      navigate(`/invoicing?invoice_id=${existing.invoice_id}`);
      return;
    }
    if (!window.confirm('Convert this quotation to a Tax Invoice?')) return;
    setConvertingId(qtnId);
    try {
      const { data: invoice } = await api.post(`/invoices/from-quotation/${qtnId}`);
      // Optimistically reflect status change locally so the button hides immediately.
      setQuotations(prev => prev.map(q => q.id === qtnId
        ? { ...q, status: 'converted', invoice_id: invoice?.id, invoice_no: invoice?.invoice_no }
        : q));
      toast.success(`Invoice ${invoice?.invoice_no || ''} created`);
      if (invoice?.id) {
        navigate(`/invoicing?invoice_id=${invoice.id}`);
      } else {
        navigate('/invoicing');
      }
    } catch (err) { toast.error(getErrMsg(err, 'Conversion failed')); }
    finally { setConvertingId(null); }
  };

  const handlePreview = (q) => {
    const company  = getCompany(q.company_id) || {};
    const settings = getQtnSettings(q.company_id);
    const activeColor = q.invoice_custom_color
      || (settings.theme === 'custom'
            ? settings.custom_color
            : (settings.custom_color || company.invoice_custom_color || '#0D3B66'));
    const html = generateQuotationHTML(q, {
      company,
      template:    q.invoice_template || settings.template || company.invoice_template || 'classic',
      theme:       q.invoice_theme    || settings.theme    || 'custom',
      customColor: activeColor,
      attachChecklist: q.attach_checklist !== false,
    });
    const win = window.open('', '_blank'); win.document.write(html); win.document.close();
  };

  const handlePrint = (q) => {
    const company  = getCompany(q.company_id) || {};
    const settings = getQtnSettings(q.company_id);
    const activeColor = q.invoice_custom_color
      || (settings.theme === 'custom'
            ? settings.custom_color
            : (settings.custom_color || company.invoice_custom_color || '#0D3B66'));
    const html = generateQuotationHTML(q, {
      company,
      template:    q.invoice_template || settings.template || company.invoice_template || 'classic',
      theme:       q.invoice_theme    || settings.theme    || 'custom',
      customColor: activeColor,
      attachChecklist: q.attach_checklist !== false,
    });
    const win = window.open('', '_blank'); win.document.write(html); win.document.close(); win.print();
  };

  const handleDownloadPdf = (qtnId, qtnNo, companyId) => {
    const q = quotations.find(x => x.id === qtnId);
    if (!q) { toast.error('Quotation not found'); return; }
    const company  = getCompany(q.company_id) || {};
    const settings = getQtnSettings(q.company_id);
    const activeColor = q.invoice_custom_color
      || (settings.theme === 'custom'
            ? settings.custom_color
            : (settings.custom_color || company.invoice_custom_color || '#0D3B66'));
    const html = generateQuotationHTML(q, {
      company,
      template:    q.invoice_template || settings.template || company.invoice_template || 'classic',
      theme:       q.invoice_theme    || settings.theme    || 'custom',
      customColor: activeColor,
      attachChecklist: q.attach_checklist !== false,
    });
    const win = window.open('', '_blank');
    if (!win) { toast.error('Pop-up blocked — please allow pop-ups for this site'); return; }
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
  };

  const handleDownloadChecklistPdf = async (qtnId, qtnNo, companyId) => {
    setDownloading(qtnId + '-checklist');
    try {
      const token   = getToken();
      const baseURL = (api.defaults?.baseURL ?? '/api').toString().replace(/\/$/, '');
      const response = await axios.get(`${baseURL}/quotations/${qtnId}/checklist-pdf`, { responseType: 'blob', headers: { Authorization: `Bearer ${token}` } });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const a   = document.createElement('a'); a.href = url;
      const co  = companies.find(c => c.id === companyId);
      const companySlug = (co?.name || '').replace(/[^a-zA-Z0-9\s]/g, '').trim().replace(/\s+/g, '_');
      const qtnSlug = (qtnNo || qtnId).replace(/\//g, '-');
      a.download = companySlug ? `${companySlug}_checklist-${qtnSlug}.pdf` : `checklist-${qtnSlug}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a); window.URL.revokeObjectURL(url);
      toast.success('Checklist PDF downloaded');
    } catch (err) { toast.error(await extractBlobError(err)); }
    finally { setDownloading(null); }
  };

  // ── Quotation action buttons (reusable) ────────────────────────────────────
  const QuotationActions = ({ q, compact = false }) => (
    <div className="flex flex-wrap gap-1">
      <Button variant="outline" size="sm" title="Download PDF"
        onClick={() => handleDownloadPdf(q.id, q.quotation_no)}
        className={cn('rounded-lg gap-1 text-xs text-blue-600 border-blue-200 hover:bg-blue-50', compact && 'h-7 px-2')}>
        <Download className="h-3 w-3" />{!compact && 'PDF'}
      </Button>
      <Button variant="outline" size="sm" title="Preview Quotation"
        onClick={() => handlePreview(q)}
        className={cn('rounded-lg gap-1 text-xs text-purple-600 border-purple-200 hover:bg-purple-50', compact && 'h-7 px-2')}>
        <Eye className="h-3 w-3" />{!compact && 'Preview'}
      </Button>
      <Button variant="outline" size="sm" title="Print Quotation"
        onClick={() => handlePrint(q)}
        className={cn('rounded-lg gap-1 text-xs text-emerald-600 border-emerald-200 hover:bg-emerald-50', compact && 'h-7 px-2')}>
        <Printer className="h-3 w-3" />{!compact && 'Print'}
      </Button>
      <Button variant="outline" size="sm" title="Send via Email"
        onClick={() => { setEmailModalQuotation(q); setEmailModalPdfType('quotation'); setIsEmailModalOpen(true); }}
        className={cn('rounded-lg gap-1 text-xs text-blue-600 border-blue-200 hover:bg-blue-50', compact && 'h-7 px-2')}>
        <Mail className="h-3 w-3" />{!compact && 'Email'}
      </Button>
      <Button variant="outline" size="sm" title="Send via WhatsApp"
        onClick={() => { setWhatsAppModalQuotation(q); setWhatsAppModalPdfType('quotation'); setIsWhatsAppModalOpen(true); }}
        className={cn('rounded-lg gap-1 text-xs text-green-600 border-green-200 hover:bg-green-50', compact && 'h-7 px-2')}>
        <MessageCircle className="h-3 w-3" />{!compact && 'WA'}
      </Button>
    </div>
  );

  // ── Shared sub-components for list view ───────────────────────────────────
  const QtnRow = ({ q, srNo }) => (
    <tr
      className={`border-b last:border-0 transition-colors cursor-pointer ${isDark ? 'border-slate-700 hover:bg-slate-700/30' : 'border-slate-50 hover:bg-slate-50'}`}
      onClick={() => { setDetailQuotation(q); setIsDetailOpen(true); }}
    >
      <td className="w-1 p-0" style={{ width: 4, padding: 0 }}>
        <div style={{ width: 4, minHeight: 48, background: STATUS_META[q.status]?.hex || '#94A3B8', borderRadius: '0 4px 4px 0' }} />
      </td>
      <td className={`px-3 py-3.5 text-xs font-mono w-10 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{srNo}</td>
      <td className="px-4 py-3.5">
        <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{q.quotation_no}</p>
        <p className="text-[10px] text-slate-400 mt-0.5">Valid {q.validity_days || 30}d</p>
      </td>
      <td className="px-4 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
            style={{ background: avatarGrad(q.client_name) }}>
            {(q.client_name || '?').charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className={`text-sm font-medium truncate max-w-[180px] ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{q.client_name || '—'}</p>
            {q.client_phone && <p className="text-[10px] text-slate-400 flex items-center gap-1"><Phone className="h-2.5 w-2.5" />{q.client_phone}</p>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3.5">
        <p className={`text-sm truncate max-w-[140px] ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{q.service}</p>
        {getCompany(q.company_id) && (
          <p className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
            <Building2 className="h-2.5 w-2.5" />{getCompany(q.company_id)?.name}
          </p>
        )}
      </td>
      <td className="px-4 py-3.5">
        <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{q.date}</p>
      </td>
      <td className="px-4 py-3.5">
        <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{fmtC(q.total || 0)}</p>
      </td>
      <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
        <InlineQuotationStatusDropdown qtn={q} onStatusChange={handleStatusChange} isDark={isDark} />
      </td>
      <td className="px-4 py-3.5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          <button onClick={() => { setEditingQuotation(q); setIsManagerOpen(true); }} title="Edit"
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-blue-400 hover:bg-blue-900/30' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'}`}>
            <Edit className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => handleDownloadPdf(q.id, q.quotation_no, q.company_id)} title="Download PDF"
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-emerald-400 hover:bg-emerald-900/30' : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'}`}>
            <Download className="h-3.5 w-3.5" />
          </button>
          {q.attach_checklist !== false && (
            <button onClick={() => handleDownloadChecklistPdf(q.id, q.quotation_no, q.company_id)} title="Checklist PDF"
              disabled={downloading === q.id + '-checklist'}
              className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-slate-200 hover:bg-slate-700' : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'}`}>
              {downloading === q.id + '-checklist' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileCheck className="h-3.5 w-3.5" />}
            </button>
          )}
          <button onClick={() => handleConvertToInvoice(q.id)} title="Convert to Invoice"
            disabled={convertingId === q.id}
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-purple-400 hover:bg-purple-900/30' : 'text-slate-400 hover:text-purple-600 hover:bg-purple-50'}`}>
            {convertingId === q.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRight className="h-3.5 w-3.5" />}
          </button>
          <LinkActionButton q={q} onUpdated={fetchQuotations} isDark={isDark} compact />
          <button onClick={() => handleDelete(q.id)} title="Delete"
            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'text-slate-400 hover:text-red-400 hover:bg-red-900/30' : 'text-slate-400 hover:text-red-500 hover:bg-red-50'}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );

  const TableHead = () => (
    <thead>
      <tr className={`border-b ${isDark ? 'border-slate-700 bg-slate-700/40' : 'border-slate-100 bg-slate-50/60'}`}>
        <th className="w-1 p-0" style={{ width: 4, padding: 0 }} />
        <th className={`px-3 py-3 text-left text-[10px] font-bold uppercase tracking-wider w-10 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Sr</th>
        {['Quotation', 'Client', 'Service', 'Date', 'Amount', 'Status', 'Actions'].map(h => (
          <th key={h} className={`px-4 py-3 text-left text-[10px] font-bold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{h}</th>
        ))}
      </tr>
    </thead>
  );

  const PaginationBar = ({ page, totalPages, setPage, accentClass, bgClass }) => totalPages <= 1 ? null : (
    <div className={`flex items-center justify-between px-5 py-3 border-t ${isDark ? 'border-slate-700 bg-slate-800/60' : `border-slate-100 ${bgClass}`}`}>
      <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-1">
        <button disabled={page === 1} onClick={() => setPage(p => Math.max(1, p - 1))}
          className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-colors disabled:opacity-30 ${isDark ? 'hover:bg-slate-700 text-slate-300' : `hover:${accentClass} text-slate-600`}`}>‹</button>
        {Array.from({ length: totalPages }, (_, i) => i + 1)
          .filter(p => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
          .reduce((acc, p, i, arr) => { if (i > 0 && p - arr[i-1] > 1) acc.push('…'); acc.push(p); return acc; }, [])
          .map((p, i) => p === '…' ? (
            <span key={`e${i}`} className="px-1 text-xs text-slate-400">…</span>
          ) : (
            <button key={p} onClick={() => setPage(p)}
              className={`w-7 h-7 rounded-lg text-xs font-bold transition-colors ${page === p ? 'text-white shadow-sm' : `${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600'}`}`}
              style={page === p ? { background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` } : {}}>{p}</button>
          ))}
        <button disabled={page === totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}
          className={`w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-colors disabled:opacity-30 ${isDark ? 'hover:bg-slate-700 text-slate-300' : `hover:${accentClass} text-slate-600`}`}>›</button>
      </div>
    </div>
  );

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className={`min-h-full space-y-5 ${isDark ? 'bg-slate-900' : 'bg-slate-50'}`}>

      {/* ── PAGE HEADER ───────────────────────────────────────────────────── */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-200/80 shadow-sm"
        style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 60%, #1a8fcc 100%)` }}>
        <div className="absolute inset-0 opacity-10" style={{ backgroundImage: 'radial-gradient(circle at 80% 20%, white 0%, transparent 60%)' }} />
        <div className="relative flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 px-4 sm:px-6 pt-4 sm:pt-5 pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/15 backdrop-blur-sm border border-white/20 flex-shrink-0">
              <FileText className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight leading-tight">Quotations</h1>
              <p className="text-sm text-blue-200 mt-0.5">Professional quotes · PDF &amp; email · Convert to invoice · Track status</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setIsCompanyListOpen(true)}
              className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm font-semibold">
              <Building2 className="h-4 w-4" /> Companies
              {companies.length > 0 && <span className="bg-white/20 px-1.5 py-0.5 rounded-full text-[10px] font-bold">{companies.length}</span>}
            </Button>
            <Button variant="outline" onClick={() => setIsSettingsOpen(true)}
              className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm font-semibold">
              <Settings className="h-4 w-4" /> Settings
            </Button>
            <Button variant="outline" onClick={() => fetchQuotations()}
              className="h-9 px-4 text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 rounded-xl gap-2 backdrop-blur-sm">
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button onClick={() => { setEditingQuotation(null); setIsManagerOpen(true); }}
              className="h-9 px-5 text-sm rounded-xl bg-white text-slate-800 hover:bg-blue-50 shadow-sm gap-2 font-semibold border-0">
              <Plus className="h-4 w-4" /> New Quotation
            </Button>
          </div>
        </div>
      </div>

      {/* ── STAT CARDS ────────────────────────────────────────────────────── */}
      {stats.total > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard label="Total Quotations" value={stats.total} sub={`${stats.pending} pending`} icon={FileText} color={COLORS.mediumBlue} bg={`${COLORS.mediumBlue}12`} isDark={isDark} onClick={() => setFilterStatus('all')} />
          <StatCard label="Total Value" value={fmtC(stats.totalValue)} sub="all quotations" icon={IndianRupee} color={COLORS.emeraldGreen} bg={`${COLORS.emeraldGreen}12`} isDark={isDark} />
          <StatCard label="Accepted Value" value={fmtC(stats.acceptedValue)} sub={`${stats.acceptedCount} accepted`} icon={CheckCircle2} color="#059669" bg="#05966912" isDark={isDark} onClick={() => setFilterStatus('accepted')} />
          <StatCard label="Conversion Rate" value={`${stats.convRate}%`} sub={`${stats.acceptedCount} of ${stats.total}`} icon={TrendingUp} color={COLORS.amber} bg={`${COLORS.amber}12`} isDark={isDark} />
        </div>
      )}

      {/* ── RECONNECTING HINT ─────────────────────────────────────────────
          Shown only while api.js is still retrying a cold-started backend
          (see lib/api.js). Replaces silent "0 quotations / 0 companies"
          with an explanation, and the page auto-refreshes once the
          server responds for real — no manual reload needed. ────────── */}
      {reconnecting && (
        <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-800 flex items-center gap-2 dark:bg-blue-900/20 dark:border-blue-700/50 dark:text-blue-300">
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" />
          <span>Waking up the server — this can take up to a minute on first load. Data will refresh automatically.</span>
        </div>
      )}

      {/* ── COMPANY MISSING WARNING ───────────────────────────────────────── */}
      {!reconnecting && companies.length === 0 && (
        <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-center gap-2 dark:bg-amber-900/20 dark:border-amber-700/50 dark:text-amber-300">
          <Info className="h-4 w-4 flex-shrink-0" />
          <span>No company profiles yet. <button onClick={() => setIsCompanyListOpen(true)} className="underline font-semibold">Add a company</button> before creating quotations.</span>
        </div>
      )}

      {/* ── FILTERS + VIEW TOGGLE ─────────────────────────────────────────── */}
      <div className={`rounded-2xl border shadow-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-100'}`}>
        {/* Search row */}
        <div className={`flex items-center gap-3 px-3.5 py-3 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
            <Input
              placeholder="Search by quotation no., client, service…"
              className={`pl-10 h-9 border-none focus-visible:ring-1 focus-visible:ring-blue-300 rounded-xl text-sm ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
            />
            {searchInput && (
              <button onClick={() => setSearchInput('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className={`h-9 px-3 flex items-center rounded-xl text-xs font-bold border whitespace-nowrap flex-shrink-0 ${isDark ? 'bg-slate-700 text-slate-300 border-slate-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}>
            {filtered.length} <span className="ml-1 font-normal text-slate-400">quotations</span>
          </div>
          {/* View mode toggle */}
          <div className={`flex items-center rounded-xl border overflow-hidden flex-shrink-0 ${isDark ? 'border-slate-600' : 'border-slate-200'}`}>
            <button onClick={() => setViewMode('list')}
              className={`h-9 px-3 flex items-center gap-1.5 text-xs font-semibold transition-all ${viewMode === 'list' ? 'bg-blue-600 text-white' : (isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-500 hover:bg-slate-50')}`}>
              <List className="h-3.5 w-3.5" /> List
            </button>
            <button onClick={() => setViewMode('board')}
              className={`h-9 px-3 flex items-center gap-1.5 text-xs font-semibold transition-all ${viewMode === 'board' ? 'bg-blue-600 text-white' : (isDark ? 'bg-slate-700 text-slate-300 hover:bg-slate-600' : 'bg-white text-slate-500 hover:bg-slate-50')}`}>
              <LayoutGrid className="h-3.5 w-3.5" /> Board
            </button>
          </div>
        </div>
        {/* Filter row */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 overflow-x-auto">
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className={`h-9 w-[140px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {Object.entries(STATUS_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterService} onValueChange={setFilterService}>
            <SelectTrigger className={`h-9 w-[150px] border-none rounded-xl text-xs flex-shrink-0 font-semibold ${isDark ? 'bg-slate-700 text-slate-100' : 'bg-slate-50'}`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Services</SelectItem>
              {services.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>
          {(filterStatus !== 'all' || filterService !== 'all' || searchTerm) && (
            <button
              onClick={() => { setFilterStatus('all'); setFilterService('all'); setSearchInput(''); }}
              className={`h-9 px-3 rounded-xl text-xs font-semibold flex items-center gap-1.5 ${isDark ? 'bg-red-900/30 text-red-400 hover:bg-red-900/50' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}>
              <X className="h-3 w-3" /> Clear
            </button>
          )}
        </div>
      </div>

      {/* ── LOADING / EMPTY / CONTENT ─────────────────────────────────────── */}
      {loading ? (
        <div className={`rounded-2xl border p-16 text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <MiniLoader height={120} />
          <p className={`text-sm font-medium mt-3 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Loading quotations…</p>
        </div>

      ) : filtered.length === 0 ? (
        <div className={`rounded-2xl border p-16 text-center ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-4"
            style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}20, ${COLORS.mediumBlue}20)` }}>
            <Receipt className="h-8 w-8" style={{ color: COLORS.mediumBlue }} />
          </div>
          <h3 className={`text-lg font-bold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>No quotations found</h3>
          <p className={`text-sm mb-6 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            {searchTerm || filterStatus !== 'all' ? 'Try adjusting your filters' : 'Create your first quotation to get started'}
          </p>
          <Button onClick={() => { setEditingQuotation(null); setIsManagerOpen(true); }}
            className="h-10 px-6 rounded-xl text-white gap-2"
            style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
            <Plus className="h-4 w-4" /> New Quotation
          </Button>
        </div>

      ) : viewMode === 'list' ? (
        /* ─── LIST VIEW ──────────────────────────────────────────────────── */
        <div className="space-y-4">
          {/* ── ACTIVE section (draft + sent) ── */}
          {pendingQuotations.length > 0 && (
            <div className={`rounded-2xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className={`flex items-center gap-3 px-5 py-3 border-b ${isDark ? 'border-slate-700 bg-slate-700/30' : 'border-slate-100 bg-amber-50/60'}`}>
                <div className="w-2 h-6 rounded-full" style={{ background: 'linear-gradient(180deg, #1F6FB2, #F59E0B)' }} />
                <Clock className="h-4 w-4 text-amber-500" />
                <span className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Active</span>
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${isDark ? 'bg-amber-900/40 text-amber-300' : 'bg-amber-100 text-amber-700'}`}>{pendingQuotations.length}</span>
                <span className={`ml-auto text-xs font-bold ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>
                  {fmtC(pendingQuotations.reduce((s, q) => s + (q.total || 0), 0))} pending
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full" style={{ minWidth: 700 }}>
                  <TableHead />
                  <tbody>
                    {paginatedPending.map((q, idx) => (
                      <QtnRow key={q.id} q={q} srNo={(pendingPage - 1) * SECTION_PAGE_SIZE + idx + 1} />
                    ))}
                  </tbody>
                </table>
              </div>
              <PaginationBar page={pendingPage} totalPages={totalPendingPages} setPage={setPendingPage} accentClass="bg-amber-100" bgClass="bg-amber-50/40" />
            </div>
          )}

          {/* ── CLOSED section (accepted + rejected) ── */}
          {closedQuotations.length > 0 && (
            <div className={`rounded-2xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              <div className={`flex items-center gap-3 px-5 py-3 border-b ${isDark ? 'border-slate-700 bg-slate-700/30' : 'border-slate-100 bg-emerald-50/60'}`}>
                <div className="w-2 h-6 rounded-full bg-emerald-500" />
                <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                <span className={`text-sm font-bold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Closed</span>
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${isDark ? 'bg-emerald-900/40 text-emerald-300' : 'bg-emerald-100 text-emerald-700'}`}>{closedQuotations.length}</span>
                <span className={`ml-auto text-xs font-bold ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                  {fmtC(closedQuotations.filter(q => q.status === 'accepted').reduce((s, q) => s + (q.total || 0), 0))} accepted
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full" style={{ minWidth: 700 }}>
                  <TableHead />
                  <tbody>
                    {paginatedClosed.map((q, idx) => (
                      <QtnRow key={q.id} q={q} srNo={(closedPage - 1) * SECTION_PAGE_SIZE + idx + 1} />
                    ))}
                  </tbody>
                </table>
              </div>
              <PaginationBar page={closedPage} totalPages={totalClosedPages} setPage={setClosedPage} accentClass="bg-emerald-100" bgClass="bg-emerald-50/40" />
            </div>
          )}
        </div>

      ) : (
        /* ─── BOARD VIEW (Kanban) ─────────────────────────────────────────── */
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {boardColumns.map(col => (
            <div key={col.id} className={`rounded-2xl border flex flex-col min-h-[300px] ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
              {/* Column header */}
              <div className="flex items-center justify-between px-4 py-3 border-b"
                style={{ borderColor: isDark ? '#334155' : '#f1f5f9', backgroundColor: isDark ? col.bgDark : col.bgLight }}>
                <div className="flex items-center gap-2.5">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: col.color }} />
                  <span className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{col.label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: isDark ? `${col.color}25` : `${col.color}18`, color: col.color }}>
                    {col.items.length}
                  </span>
                  <span className="text-xs font-semibold" style={{ color: col.color }}>
                    {fmtC(col.items.reduce((s, q) => s + (q.total || 0), 0))}
                  </span>
                </div>
              </div>

              {/* Cards */}
              <div className="flex-1 overflow-y-auto p-3 space-y-3" style={{ maxHeight: '70vh' }}>
                {col.items.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-2"
                      style={{ backgroundColor: isDark ? `${col.color}15` : `${col.color}10` }}>
                      <Receipt className="h-5 w-5 opacity-40" style={{ color: col.color }} />
                    </div>
                    <p className={`text-xs ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>No {col.label.toLowerCase()} quotations</p>
                  </div>
                ) : (
                  <AnimatePresence>
                    {col.items.map((q, idx) => (
                      <motion.div key={q.id}
                        initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}
                        transition={{ duration: 0.18, delay: idx * 0.04 }}
                        className={`rounded-xl border p-4 cursor-default transition-shadow hover:shadow-md ${isDark ? 'bg-slate-750 border-slate-700 hover:border-slate-600' : 'bg-white border-slate-200/80 hover:border-slate-300'}`}
                        style={{ borderLeft: `3px solid ${col.color}` }}
                      >
                        {/* Card top */}
                        <div className="flex items-start justify-between mb-2.5 gap-2">
                          <div className="min-w-0">
                            <p className={`text-xs font-bold truncate ${isDark ? 'text-blue-400' : 'text-blue-600'}`}>{q.quotation_no}</p>
                            <p className={`text-sm font-semibold truncate mt-0.5 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{q.client_name}</p>
                          </div>
                          <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                            style={{ background: avatarGrad(q.client_name) }}>
                            {(q.client_name || '?').charAt(0).toUpperCase()}
                          </div>
                        </div>

                        <p className={`text-xs truncate mb-2.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{q.service}</p>

                        <div className="flex items-center justify-between mb-3">
                          <span className={`text-base font-black ${isDark ? 'text-emerald-400' : 'text-emerald-700'}`}>{fmtC(q.total || 0)}</span>
                          <span className={`text-[10px] ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>{q.date} · {q.validity_days}d</span>
                        </div>

                        {getCompany(q.company_id) && (
                          <p className={`text-[10px] flex items-center gap-1 mb-2.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                            <Building2 className="h-2.5 w-2.5" />{getCompany(q.company_id)?.name}
                          </p>
                        )}

                        <Select value={q.status || 'draft'} onValueChange={(v) => handleStatusChange(q.id, v)}>
                          <SelectTrigger className="h-7 rounded-lg text-[11px] mb-2.5 border-0 px-0 bg-transparent focus:ring-0 shadow-none w-full">
                            <StatusChip status={q.status || 'draft'} />
                          </SelectTrigger>
                          <SelectContent>{Object.entries(STATUS_META).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
                        </Select>

                        {/* Board card action buttons */}
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          <Button variant="outline" size="sm" title="Download PDF"
                            onClick={() => handleDownloadPdf(q.id, q.quotation_no)}
                            disabled={downloading === q.id + '-pdf'}
                            className="h-6 px-1.5 rounded-md gap-0.5 text-[10px] text-blue-600 border-blue-200 hover:bg-blue-50">
                            {downloading === q.id + '-pdf' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Download className="h-2.5 w-2.5" />} PDF
                          </Button>
                          <Button variant="outline" size="sm" title="Preview Quotation"
                            onClick={() => handlePreview(q)}
                            className="h-6 px-1.5 rounded-md gap-0.5 text-[10px] text-purple-600 border-purple-200 hover:bg-purple-50">
                            <Eye className="h-2.5 w-2.5" /> View
                          </Button>
                          <Button variant="outline" size="sm" title="Send via Email"
                            onClick={() => { setEmailModalQuotation(q); setEmailModalPdfType('quotation'); setIsEmailModalOpen(true); }}
                            className="h-6 px-1.5 rounded-md gap-0.5 text-[10px] text-blue-600 border-blue-200 hover:bg-blue-50">
                            <Mail className="h-2.5 w-2.5" /> Email
                          </Button>
                          <Button variant="outline" size="sm" title="Send via WhatsApp"
                            onClick={() => { setWhatsAppModalQuotation(q); setWhatsAppModalPdfType('quotation'); setIsWhatsAppModalOpen(true); }}
                            className="h-6 px-1.5 rounded-md gap-0.5 text-[10px] text-green-600 border-green-200 hover:bg-green-50">
                            <MessageCircle className="h-2.5 w-2.5" /> WA
                          </Button>
                        </div>

                        <div className="flex items-center gap-1 border-t pt-2" style={{ borderColor: isDark ? '#334155' : '#f1f5f9' }}>
                          {q.attach_checklist !== false && (
                            <Button variant="outline" size="sm" title="Download Document Checklist"
                              onClick={() => handleDownloadChecklistPdf(q.id, q.quotation_no)}
                              disabled={downloading === q.id + '-checklist'}
                              className="h-6 px-1.5 rounded-md text-[10px] text-slate-600 border-slate-200 flex-1">
                              {downloading === q.id + '-checklist' ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <FileCheck className="h-2.5 w-2.5" />} Checklist
                            </Button>
                          )}
                          <Button variant="outline" size="sm" title="Convert to Invoice"
                            onClick={() => handleConvertToInvoice(q.id)}
                            disabled={convertingId === q.id}
                            className="h-6 px-1.5 rounded-md text-[10px] text-purple-600 border-purple-200">
                            {convertingId === q.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <ArrowRight className="h-2.5 w-2.5" />}
                          </Button>
                          <Button variant="outline" size="sm" title="Edit Quotation"
                            onClick={() => { setEditingQuotation(q); setIsManagerOpen(true); }}
                            className="h-6 px-1.5 rounded-md text-[10px] text-slate-600 border-slate-200">
                            <Edit className="h-2.5 w-2.5" />
                          </Button>
                          <Button variant="outline" size="sm" title="Delete Quotation"
                            onClick={() => handleDelete(q.id)}
                            className="h-6 px-1.5 rounded-md text-[10px] text-red-600 border-red-200">
                            <Trash2 className="h-2.5 w-2.5" />
                          </Button>
                        </div>
                      </motion.div>
                    ))}
                  </AnimatePresence>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── MODALS ───────────────────────────────────────────────────────── */}
      {isManagerOpen && (
        <QuotationManager
          onClose={() => setIsManagerOpen(false)}
          onSaved={() => { fetchQuotations(); fetchMeta(); }}
          editingQuotation={editingQuotation}
        />
      )}
      <CompanyListModal open={isCompanyListOpen} onClose={() => setIsCompanyListOpen(false)} onRefresh={fetchMeta} />
      {isSettingsOpen && <QuotationSettings open={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} companies={companies} isDark={isDark} />}
      {isEmailModalOpen && (
        <EmailModal
          open={isEmailModalOpen}
          onClose={() => setIsEmailModalOpen(false)}
          quotation={emailModalQuotation}
          company={getCompany(emailModalQuotation?.company_id)}
          pdfType={emailModalPdfType}
        />
      )}
      {isWhatsAppModalOpen && (
        <WhatsAppModal
          open={isWhatsAppModalOpen}
          onClose={() => setIsWhatsAppModalOpen(false)}
          quotation={whatsAppModalQuotation}
          company={getCompany(whatsAppModalQuotation?.company_id)}
          pdfType={whatsAppModalPdfType}
        />
      )}
      {detailQuotation && (
        <QuotationDetailPanel
          quotation={detailQuotation}
          open={isDetailOpen}
          onClose={() => setIsDetailOpen(false)}
          onEdit={(q) => { setEditingQuotation(q); setIsManagerOpen(true); }}
          onDelete={handleDelete}
          isDark={isDark}
          companies={companies}
          downloading={downloading}
          handleDownload={handleDownloadPdf}
          handleDownloadChecklistPdf={handleDownloadChecklistPdf}
          handleConvertToInvoice={handleConvertToInvoice}
          convertingId={convertingId}
          setEmailModalQuotation={setEmailModalQuotation}
          setEmailModalPdfType={setEmailModalPdfType}
          setIsEmailModalOpen={setIsEmailModalOpen}
          setWhatsAppModalQuotation={setWhatsAppModalQuotation}
          setWhatsAppModalPdfType={setWhatsAppModalPdfType}
          setIsWhatsAppModalOpen={setIsWhatsAppModalOpen}
        />
      )}
    </div>
  );
}
