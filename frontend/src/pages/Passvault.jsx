import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { format } from 'date-fns';
import api from '@/lib/api';
import {
  clientToPassvaultPatch,
  fetchClientFillForEntry,
  refillByHolderName,
} from '@/lib/clientPassvaultSync';
import {
  KeyRound, Plus, Search, Eye, EyeOff, Copy, Edit2, Trash2,
  Globe, Lock, X, RefreshCw, Clock, User as UserIcon, Tag,
  Building2, Filter, ExternalLink, Send, Download, Upload,
  FileUp, Users, LayoutGrid, List, AlertTriangle, Loader2,
  ArrowUpDown, ChevronLeft, ChevronRight, Smartphone, Store,
  Activity, WifiOff, ServerCrash, ShieldAlert, Share2, ChevronDown,
  CheckSquare, Square, Info, Sparkles,
} from 'lucide-react';
import { detectPasswordDuplicates } from '@/lib/aiDuplicateEngine';
import AIDuplicateDialog from '@/components/ui/AIDuplicateDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import AIFileInsights from '@/components/ui/AIFileInsights.jsx';
import { getWASettings, buildPasswordMessage } from '@/hooks/useWhatsApp';
import WhatsAppSendDialog from '@/components/ui/WhatsAppSendDialog';

const C = { deepBlue: '#0D3B66', medBlue: '#1F6FB2', green: '#1FAF5A', whatsapp: '#25D366' };
const spring = { type: 'spring', stiffness: 340, damping: 24 };

const PM = {
  MCA: { label: 'MCA/ROC', color: '#1E3A8A', bg: '#EFF6FF', border: '#3B82F6', accent: '#DBEAFE', icon: '🏛️', full: 'Ministry of Corporate Affairs / ROC' },
  ROC: { label: 'MCA/ROC', color: '#1E3A8A', bg: '#EFF6FF', border: '#3B82F6', accent: '#DBEAFE', icon: '🏛️', full: 'Registrar of Companies / MCA' },
  DGFT: { label: 'DGFT', color: '#065F46', bg: '#ECFDF5', border: '#10B981', accent: '#D1FAE5', icon: '🌐', full: 'Directorate General of Foreign Trade' },
  TRADEMARK: { label: 'Trademark', color: '#0F766E', bg: '#F0FDFA', border: '#14B8A6', accent: '#CCFBF1', icon: '™️', full: 'Trademark / IP India' },
  GST: { label: 'GST', color: '#7C3AED', bg: '#F5F3FF', border: '#A78BFA', accent: '#EDE9FE', icon: '📊', full: 'GST Portal' },
  INCOME_TAX: { label: 'Income Tax', color: '#DC2626', bg: '#FEF2F2', border: '#EF4444', accent: '#FEE2E2', icon: '💰', full: 'Income Tax India' },
  TDS: { label: 'TDS', color: '#B45309', bg: '#FFFBEB', border: '#F59E0B', accent: '#FEF3C7', icon: '🧾', full: 'TDS / TRACES' },
  TRACES: { label: 'TRACES', color: '#B45309', bg: '#FFFBEB', border: '#F59E0B', accent: '#FEF3C7', icon: '🔍', full: 'TRACES Portal' },
  EPFO: { label: 'EPFO', color: '#1D4ED8', bg: '#EFF6FF', border: '#3B82F6', accent: '#DBEAFE', icon: '👷', full: 'EPFO / PF Portal' },
  ESIC: { label: 'ESIC', color: '#0369A1', bg: '#F0F9FF', border: '#0EA5E9', accent: '#CFFAFE', icon: '🏥', full: 'ESIC Portal' },
  MSME: { label: 'MSME', color: '#92400E', bg: '#FEF3C7', border: '#F59E0B', accent: '#FCD34D', icon: '🏭', full: 'MSME Samadhaan' },
  RERA: { label: 'RERA', color: '#4B5563', bg: '#F9FAFB', border: '#6B7280', accent: '#F3F4F6', icon: '🏗️', full: 'RERA Portal' },
  OTHER: { label: 'Other', color: '#6B7280', bg: '#F9FAFB', border: '#9CA3AF', accent: '#F3F4F6', icon: '🔗', full: 'Custom / Other Portal' },
};

const PORTAL_TYPES = Object.keys(PM);
const DEPTS = ['GST', 'IT', 'ACC', 'TDS', 'ROC', 'TM', 'MSME', 'FEMA', 'DSC', 'OTHER'];
const HOLDER_TYPES = ['COMPANY', 'DIRECTOR', 'INDIVIDUAL', 'PARTNER', 'TRUSTEE', 'OTHER'];
const HM = {
  COMPANY: { label: 'Company', icon: '🏢', color: '#1E3A8A' },
  DIRECTOR: { label: 'Director', icon: '👔', color: '#7C3AED' },
  INDIVIDUAL: { label: 'Individual', icon: '👤', color: '#065F46' },
  PARTNER: { label: 'Partner', icon: '🤝', color: '#B45309' },
  TRUSTEE: { label: 'Trustee', icon: '⚖️', color: '#0369A1' },
  OTHER: { label: 'Other', icon: '👥', color: '#6B7280' },
};

const SORTS = [
  { value: 'lifo', label: 'Newest First', by: 'created_at', ord: 'desc' },
  { value: 'fifo', label: 'Oldest First', by: 'created_at', ord: 'asc' },
  { value: 'az', label: 'A -> Z', by: 'portal_name', ord: 'asc' },
  { value: 'za', label: 'Z -> A', by: 'portal_name', ord: 'desc' },
];

const PAGE_SIZES = [20, 40, 80, 100];
const cv = { hidden: { opacity: 0 }, visible: { opacity: 1, transition: { staggerChildren: 0.025 } } };
const iv = { hidden: { opacity: 0, y: 12 }, visible: { opacity: 1, y: 0, transition: { duration: 0.2 } } };

function hasPerm(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const p = user.permissions;
  if (!p) return false;
  if (typeof p === 'object' && !Array.isArray(p)) return p[key] === true;
  if (Array.isArray(p)) return p.includes(key);
  return false;
}

function errorMessage(err) {
  if (!err) return 'Unknown error';
  const status = err.response?.status;
  const detail = err.response?.data?.detail;
  if (detail) return `${status ? `[${status}] ` : ''}${detail}`;
  if (status === 401) return '[401] Not authenticated — please log in again.';
  if (status === 403) return '[403] You do not have permission to view passwords.';
  if (status === 404) return '[404] Password API endpoint not found. Check backend.';
  if (status === 500) return '[500] Server error — check backend logs.';
  if (status === 503) return '[503] Backend is starting up. Please wait and retry.';
  if (err.code === 'ERR_NETWORK' || err.message?.includes('Network'))
    return 'Network error — backend may be sleeping. Wait ~30 s and retry.';
  return err.message || 'Unknown error';
}

function WA({ className, style }) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}

function PortalBadge({ type }) {
  const m = PM[type] || PM.OTHER;
  return (
    <span className="inline-flex items-center gap-1 font-bold rounded-full px-2 py-0.5 text-[10px]"
      style={{ background: m.bg, color: m.color, border: `1px solid ${m.border}` }}>
      {m.icon} {m.label}
    </span>
  );
}

function DeptBadge({ dept }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600">
      {dept}
    </span>
  );
}

function HolderBadge({ holderType }) {
  const m = HM[holderType] || HM.OTHER;
  if (holderType === 'COMPANY') return null;
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ background: `${m.color}15`, color: m.color, border: `1px solid ${m.color}30` }}>
      {m.icon} {m.label}
    </span>
  );
}

// All Passvault popups share the app-wide popup header look (navy band).
// `grad` is kept for call-site compatibility but no longer changes the colour.
function ModalHead({ icon, title, sub, grad, onClose }) {
  return (
    <div className="relative overflow-hidden px-6 py-5 flex-shrink-0" style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
      <div aria-hidden="true" className="pointer-events-none absolute -right-20 -top-20 w-56 h-56 opacity-10"
        style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">{icon}</div>
          <div className="min-w-0">
            <p className="text-white font-bold text-xl leading-snug break-words">{title}</p>
            {sub && <p className="text-white/75 text-[13px] mt-0.5 break-words">{sub}</p>}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close"
          className="w-8 h-8 bg-white/15 hover:bg-white/25 rounded-lg flex items-center justify-center transition-all flex-shrink-0">
          <X className="h-4 w-4 text-white" />
        </button>
      </div>
    </div>
  );
}

function RevealPw({ entryId, isDark, canReveal = false }) {
  const [shown, setShown] = useState(false);
  const [pw, setPw] = useState('');
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const toggle = async () => {
    if (shown) { setShown(false); setPw(''); return; }
    setLoading(true);
    try {
      const r = await api.get(`/passwords/${entryId}/reveal`);
      if (!mounted.current) return;
      const pw = r.data.password || '';
      if (pw === '[decryption failed]') {
        toast.error('Password decryption failed — the encryption key may have changed. Re-save the entry to fix it.');
        return;
      }
      setPw(pw);
      setShown(true);
    } catch (e) {
      if (mounted.current) toast.error(errorMessage(e));
    } finally { if (mounted.current) setLoading(false); }
  };

  // Non-admin: just show dots, no reveal button
  if (!canReveal) {
    return <span className="font-mono tracking-widest text-slate-400 text-sm select-none">••••••••••</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      {shown
        ? <span className={`font-mono text-xs break-all ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{pw}</span>
        : <span className="font-mono tracking-widest text-slate-400 text-sm select-none">••••••••••</span>}
      <button type="button" onClick={toggle} disabled={loading}
        className={`flex-shrink-0 p-0.5 rounded ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
        {loading ? <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />
          : shown ? <EyeOff className="h-3 w-3 text-slate-400" />
            : <Eye className="h-3 w-3 text-slate-400" />}
      </button>
      {shown && (
        <button type="button"
          onClick={() => navigator.clipboard.writeText(pw).then(() => toast.success('Copied'))}
          className={`flex-shrink-0 p-0.5 rounded ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
          <Copy className="h-3 w-3 text-slate-400" />
        </button>
      )}
    </div>
  );
}

function DetailModal({ open, onClose, entry, isDark, isAdmin }) {
  if (!entry) return null;
  const m = PM[entry.portal_type] || PM.OTHER;
  const row = (label, val, mono = false) => val ? (
    <div key={label}>
      <p className={`text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{label}</p>
      <p className={`text-sm mt-0.5 ${mono ? 'font-mono' : ''} ${isDark ? 'text-slate-200' : 'text-slate-900'}`}>{val}</p>
    </div>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className={`max-w-2xl rounded-3xl p-0 border-none overflow-hidden [&>button]:hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <ModalHead icon={<span className="text-2xl">{m.icon}</span>} title={entry.portal_name}
          sub={m.full} grad={`linear-gradient(135deg,${m.color},${m.border})`} onClose={onClose} />
        <div className="p-6 space-y-4 max-h-[72vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-3">
            {row('Portal Type', entry.portal_type)}
            {row('Department', entry.department)}
          </div>
          {entry.url && (
            <div>
              <p className={`text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>URL</p>
              <a href={entry.url} target="_blank" rel="noopener noreferrer"
                className="text-sm mt-0.5 text-blue-500 hover:underline flex items-center gap-1 break-all">
                {entry.url}<ExternalLink className="h-3 w-3 flex-shrink-0" />
              </a>
            </div>
          )}
          <div className={`p-4 rounded-xl border ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
            <p className={`font-bold text-xs uppercase tracking-wider mb-3 ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>Login Credentials</p>
            {entry.username && (
              <div className="mb-3">
                <p className={`text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Username / Email</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className={`font-mono text-sm ${isDark ? 'text-slate-200' : 'text-slate-900'}`}>{entry.username}</span>
                  <button type="button"
                    onClick={() => navigator.clipboard.writeText(entry.username).then(() => toast.success('Copied'))}
                    className={`p-1 rounded ${isDark ? 'hover:bg-slate-600' : 'hover:bg-slate-200'}`}>
                    <Copy className="h-3 w-3 text-slate-400" />
                  </button>
                </div>
              </div>
            )}
            {entry.has_password && (
              <div>
                <p className={`text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Password</p>
                <div className="mt-1"><RevealPw entryId={entry.id} isDark={isDark} canReveal={isAdmin} /></div>
              </div>
            )}
          </div>
          {(entry.holder_name || entry.holder_pan || entry.holder_din || entry.holder_type) && (
            <div className="grid grid-cols-2 gap-3">
              {row('Holder Type', entry.holder_type)}
              {row('Holder Name', entry.holder_name)}
              {row('PAN', entry.holder_pan, true)}
              {row('DIN', entry.holder_din, true)}
            </div>
          )}
          {(entry.client_name || entry.client_id) && (
            <div className="grid grid-cols-2 gap-3">
              {row('Client Name', entry.client_name)}
              {row('Client ID', entry.client_id, true)}
            </div>
          )}
          {(entry.mobile || entry.trade_name) && (
            <div className="grid grid-cols-2 gap-3">
              {row('Mobile', entry.mobile, true)}
              {row('Trade Name', entry.trade_name)}
            </div>
          )}
          {entry.notes && (
            <div>
              <p className={`text-xs font-semibold uppercase ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Notes</p>
              <p className={`text-sm mt-0.5 whitespace-pre-wrap ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{entry.notes}</p>
            </div>
          )}
          {entry.tags?.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {entry.tags.map((t, i) => <Badge key={i} variant="secondary" className="rounded-full text-xs">{t}</Badge>)}
            </div>
          )}
          <div className={`p-3 rounded-lg text-xs space-y-0.5 ${isDark ? 'bg-slate-700/30 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
            {entry.created_at && <p>Created: {format(new Date(entry.created_at), 'MMM d, yyyy HH:mm')}</p>}
            {entry.updated_at && <p>Updated: {format(new Date(entry.updated_at), 'MMM d, yyyy HH:mm')}</p>}
            {entry.last_accessed_at && <p>Last access: {format(new Date(entry.last_accessed_at), 'MMM d, yyyy HH:mm')}</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const F = ({ label, children }) => (
  <div><Label className="text-xs font-bold uppercase text-slate-500">{label}</Label>{children}</div>
);

function EditModal({ open, onClose, entry, isDark, onSuccess }) {
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [clientList, setClientList] = useState([]);
  const [clientMode, setClientMode] = useState('select'); // 'select' | 'manual'
  const [linkedClient, setLinkedClient] = useState(null); // currently linked client object
  const qc = useQueryClient();
  
  useEffect(() => {
    if (!open) return;
    setLinkedClient(null);

    if (entry) {
      setForm({
        ...entry,
        password_plain: '',
        department: entry.department || 'OTHER'
      });
    } else {
      setForm({
        portal_type: 'OTHER',
        holder_type: 'COMPANY',
        department: 'OTHER'
      });
    }

    api.get('/clients')
      .then(r => {
        const list = Array.isArray(r.data) ? r.data : [];
        setClientList(list);

        if (entry?.client_id) {
          const found = list.find(c => String(c.id) === String(entry.client_id));
          setClientMode(found ? 'select' : 'manual');
          if (found) {
            setLinkedClient(found);
            // ── Autofill any BLANK fields from the linked client ────────────
            const patch = clientToPassvaultPatch(found, entry);
            if (Object.keys(patch).length) {
              setForm(prev => ({ ...prev, ...patch }));
              toast.message(`Auto-filled ${Object.keys(patch).length} field(s) from client`);
            }
          }
        } else {
          setClientMode('select');
        }
      })
      .catch(() => {
        setClientList([]);
        setClientMode('manual');
      });

    // Extra safety: if /clients list didn't include this client, fetch it directly
    if (entry?.client_id) {
      fetchClientFillForEntry(entry).then(patch => {
        if (patch && Object.keys(patch).length) {
          setForm(prev => {
            // only apply keys that are still empty (don't clobber user edits)
            const merged = { ...prev };
            for (const [k, v] of Object.entries(patch)) {
              if (merged[k] === undefined || merged[k] === '' || merged[k] === null) {
                merged[k] = v;
              }
            }
            return merged;
          });
        }
      });
    }
  }, [open]);

  const set = (k, v) => {
    setForm(prev => ({
      ...prev,
      [k]: v
    }));
  };

  const save = async () => {
    if (!form.portal_name?.trim()) return toast.error('Portal name is required');
    setBusy(true);
    try {
      if (entry?.id) {
        await api.put(`/passwords/${entry.id}`, form);
        toast.success('Entry updated');
      } else {
        await api.post('/passwords', form);
        toast.success('Entry created');
      }

      // ── Reverse sync: fill blank fields on the linked client ──────────
      if (form.client_id) {
        try {
          const linked = clientList.find(c => String(c.id) === String(form.client_id));
          if (linked) {
            const cPatch = {};
            const setIfBlank = (k, v) => {
              if (v && (linked[k] === undefined || linked[k] === null || String(linked[k]).trim() === '')) {
                cPatch[k] = v;
              }
            };
            setIfBlank('phone', form.mobile);
            if (form.username && /\S+@\S+\.\S+/.test(form.username)) setIfBlank('email', form.username);
            setIfBlank('pan', form.holder_pan);
            if (Object.keys(cPatch).length) {
              await api.put(`/clients/${linked.id}`, { ...linked, ...cPatch });
              toast.message(`Synced ${Object.keys(cPatch).length} field(s) back to client`);
              qc.invalidateQueries({ queryKey: ['clients'] });
            }
          }
        } catch { /* non-fatal */ }
      }

      qc.invalidateQueries({ queryKey: ['passwords'] });
      onSuccess?.();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  };

  const ic = `rounded-xl mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`;
  const sc = `rounded-xl mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`;

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className={`max-w-2xl rounded-3xl p-0 border-none overflow-hidden [&>button]:hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <ModalHead
          icon={entry?.id ? <Edit2 className="h-4 w-4 text-white" /> : <Plus className="h-4 w-4 text-white" />}
          title={entry?.id ? 'Edit Entry' : 'Add New Entry'}
          sub="Manage credential details"
          grad={`linear-gradient(135deg,${C.deepBlue},${C.medBlue})`}
          onClose={onClose}
        />
        <div className="p-6 space-y-4 max-h-[72vh] overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <F label="Portal Name *">
              <Input className={ic} value={form.portal_name || ''} onChange={e => set('portal_name', e.target.value)} placeholder="e.g. GST Portal" />
            </F>
            <F label="Portal Type">
              <Select value={form.portal_type || 'OTHER'} onValueChange={v => set('portal_type', v)}>
                <SelectTrigger className={sc}><SelectValue /></SelectTrigger>
                <SelectContent>{PORTAL_TYPES.map(t => <SelectItem key={t} value={t}>{PM[t].icon} {PM[t].label}</SelectItem>)}</SelectContent>
              </Select>
            </F>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <F label="Department *">
              <Select value={form.department || 'OTHER'} onValueChange={v => set('department', v)}>
                <SelectTrigger className={sc}><SelectValue /></SelectTrigger>
                <SelectContent>{DEPTS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
              </Select>
            </F>
            <F label="Portal URL">
              <Input className={ic} value={form.url || ''} onChange={e => set('url', e.target.value)} placeholder="https://..." />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <F label="Username / Email">
              <Input className={ic} value={form.username || ''} onChange={e => set('username', e.target.value)} placeholder="user@example.com" />
            </F>
            <F label="Password">
              <Input type="password" className={ic} value={form.password_plain || ''} onChange={e => set('password_plain', e.target.value)} placeholder="••••••••" />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <F label="Holder Type">
              <Select value={form.holder_type || 'COMPANY'} onValueChange={v => set('holder_type', v)}>
                <SelectTrigger className={sc}><SelectValue /></SelectTrigger>
                <SelectContent>{HOLDER_TYPES.map(t => <SelectItem key={t} value={t}>{HM[t].icon} {HM[t].label}</SelectItem>)}</SelectContent>
              </Select>
            </F>
            <F label="Holder Name">
              <Input
                className={ic}
                value={form.holder_name || ''}
                onChange={e => set('holder_name', e.target.value)}
                onBlur={e => {
                  // When holder_name is set and we have a linked client,
                  // try to auto-fill DIN / mobile / email from matching contact_person
                  if (linkedClient && e.target.value.trim()) {
                    const patch = refillByHolderName(linkedClient, { ...form, holder_name: e.target.value.trim() });
                    if (Object.keys(patch).length) {
                      setForm(prev => ({ ...prev, ...patch }));
                      toast.message(`Auto-filled ${Object.keys(patch).length} field(s) from contact "${e.target.value.trim()}"`);
                    }
                  }
                }}
                placeholder="Director / Company name"
              />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <F label="Holder PAN">
              <Input className={ic} value={form.holder_pan || ''} onChange={e => set('holder_pan', e.target.value.toUpperCase())} placeholder="ABCDE1234F" />
            </F>
            <F label="Holder DIN">
              <Input className={ic} value={form.holder_din || ''} onChange={e => set('holder_din', e.target.value)} placeholder="DIN number" />
            </F>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <F label="Mobile Number">
              <Input className={ic} value={form.mobile || ''} onChange={e => set('mobile', e.target.value)} placeholder="+91 9876543210" />
            </F>
            <F label="Trade Name">
              <Input className={ic} value={form.trade_name || ''} onChange={e => set('trade_name', e.target.value)} placeholder="Business name" />
            </F>
          </div>
          {/* Client Selector */}
          <div className={`rounded-xl border p-3 space-y-3 ${isDark ? 'bg-slate-700/40 border-slate-600' : 'bg-slate-50 border-slate-200'}`}>
            <div className="flex items-center justify-between">
              <Label className="text-xs font-bold uppercase text-slate-500">Link to Client</Label>
              <button type="button"
                onClick={() => setClientMode(m => m === 'select' ? 'manual' : 'select')}
                className={`text-[10px] font-semibold px-2 py-0.5 rounded-lg border transition-colors ${isDark ? 'border-slate-600 text-slate-400 hover:text-slate-200' : 'border-slate-300 text-slate-500 hover:text-slate-700'}`}>
                {clientMode === 'select' ? '✏️ Enter Manually' : '🔍 Pick from Clients'}
              </button>
            </div>
            {clientMode === 'select' ? (
              <Select
                value={form.client_id ? String(form.client_id) : '__none__'}
                onValueChange={v => {
                  if (v === '__none__') { set('client_id', ''); set('client_name', ''); setLinkedClient(null); }
                  else {
                    const c = clientList.find(x => String(x.id) === v);
                    if (c) {
                      setLinkedClient(c);
                      // Link + auto-fill any blank fields from this client
                      setForm(prev => {
                        const base = { ...prev, client_id: String(c.id), client_name: c.company_name };
                        const patch = clientToPassvaultPatch(c, base);
                        const merged = { ...base };
                        let filled = 0;
                        for (const [k, val] of Object.entries(patch)) {
                          if (merged[k] === undefined || merged[k] === '' || merged[k] === null) {
                            merged[k] = val; filled++;
                          }
                        }
                        if (filled) toast.message(`Auto-filled ${filled} field(s) from ${c.company_name}`);
                        return merged;
                      });
                    }
                  }
                }}>
                <SelectTrigger className={`rounded-xl ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
                  <Building2 className="h-3.5 w-3.5 mr-1.5 text-slate-400 flex-shrink-0" />
                  <SelectValue placeholder="— Select a client —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— No client —</SelectItem>
                  {clientList.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.company_name}
                    </SelectItem>
                  ))}
                  {clientList.length === 0 && (
                    <SelectItem value="__loading__" disabled>Loading clients…</SelectItem>
                  )}
                </SelectContent>
              </Select>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[10px] font-semibold uppercase text-slate-400">Client Name</Label>
                  <Input className={`${ic} mt-1`} value={form.client_name || ''} onChange={e => set('client_name', e.target.value)} placeholder="Company name" />
                </div>
                <div>
                  <Label className="text-[10px] font-semibold uppercase text-slate-400">Client ID</Label>
                  <Input className={`${ic} mt-1`} value={form.client_id || ''} onChange={e => set('client_id', e.target.value)} placeholder="Client code" />
                </div>
              </div>
            )}
          </div>
          <F label="Notes">
            <Textarea className={`${ic} resize-none`} rows={3} value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Additional notes…" />
          </F>
          <F label="Tags (comma-separated)">
            <Input className={ic}
              value={Array.isArray(form.tags) ? form.tags.join(', ') : (form.tags || '')}
              onChange={e => set('tags', e.target.value.split(',').map(t => t.trim()).filter(Boolean))}
              placeholder="tag1, tag2" />
          </F>
        </div>
        <DialogFooter className={`px-6 py-4 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <Button variant="ghost" className="rounded-xl" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={busy} className="rounded-xl font-bold text-white" style={{ background: C.green }}>
            {busy ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving…</> : 'Save Entry'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    );
    }

function DeleteModal({ open, onClose, entry, isDark }) {
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  const del = async () => {
    setBusy(true);
    try {
      await api.delete(`/passwords/${entry.id}`);
      toast.success('Entry deleted');
      qc.invalidateQueries({ queryKey: ['passwords'] });
      qc.invalidateQueries({ queryKey: ['pw-stats'] });
      onClose();
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className={`max-w-md rounded-3xl p-0 border-none overflow-hidden [&>button]:hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <ModalHead icon={<Trash2 className="h-4 w-4 text-white" />} title="Delete Entry"
          sub="This action cannot be undone" grad="linear-gradient(135deg,#DC2626,#EF4444)" onClose={onClose} />
        <div className="p-6 space-y-4">
          <p className={`text-sm ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
            Delete <strong>{entry?.portal_name}</strong>? This cannot be undone.
          </p>
          <div className={`p-3 rounded-lg text-xs font-semibold ${isDark ? 'bg-red-900/20 border border-red-800/40 text-red-300' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            ⚠️ All associated credential data will be permanently removed.
          </div>
        </div>
        <DialogFooter className={`px-6 py-4 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <Button variant="ghost" className="rounded-xl" onClick={onClose}>Cancel</Button>
          <Button onClick={del} disabled={busy} className="rounded-xl font-bold text-white bg-red-500 hover:bg-red-600">
            {busy ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WAModal({ open, onClose, entry, isDark }) {
  const [phone, setPhone] = useState('');
  const [pw, setPw] = useState('');
  const [loadPw, setLoadPw] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open || !entry?.id) return;
    setPhone(entry.mobile || '');
    setLoadPw(true);
    api.get(`/passwords/${entry.id}/reveal`)
      .then(r => {
        const pw = r.data.password || '';
        if (pw === '[decryption failed]') {
          toast.error('Password decryption failed — re-save the entry to fix it.');
          setPw('');
        } else {
          setPw(pw);
        }
      })
      .catch(err => {
        const detail = err?.response?.data?.detail;
        if (detail) toast.error(detail);
        setPw('');
      })
      .finally(() => setLoadPw(false));
  }, [open, entry?.id]);

  const msg = useCallback(() => {
    const L = ['🔐 Portal Credentials', '─'.repeat(28)];
    if (entry?.portal_name) L.push(`Portal: ${entry.portal_name}`);
    if (entry?.portal_type) L.push(`Type: ${entry.portal_type}`);
    if (entry?.url) L.push(`URL: ${entry.url}`);
    L.push('', '👤 Login Details', '─'.repeat(28));
    if (entry?.username) L.push(`ID: ${entry.username}`);
    if (pw) L.push(`Password: ${pw}`);
    if (entry?.holder_name) {
      L.push('', '👥 Holder', '─'.repeat(28), `Name: ${entry.holder_name}`);
      if (entry.holder_pan) L.push(`PAN: ${entry.holder_pan}`);
    }
    if (note.trim()) L.push('', '📝 Note', '─'.repeat(28), note.trim());
    L.push('', '─'.repeat(28), 'Sent via Taskosphere 📱');
    return L.join('\n');
  }, [entry, pw, note]);

  const close_ = () => { setPhone(''); setPw(''); setNote(''); onClose(); };

  const [sending, setSending] = useState(false);

  const send = async () => {
    const p = phone || entry?.mobile;
    if (!p) return toast.error('Enter a phone number');
    const digits = p.replace(/\D/g, '');
    const e164 = digits.startsWith('91') ? digits : `91${digits}`;
    setSending(true);
    try {
      // Try direct API send via WA Bridge
      const res = await api.post('/whatsapp/send', {
        to: e164, message: msg(), message_type: 'password', context_id: entry?.id
      }).catch(() => null);
      if (res?.data?.success) {
        toast.success('Message sent via WhatsApp ✓');
      } else {
        // Fallback to WA Web
        window.open(`https://wa.me/${e164}?text=${encodeURIComponent(msg())}`, '_blank');
        toast.success('Opening WhatsApp…');
      }
    } finally {
      setSending(false);
      close_();
    }
  };

  return (
    <Dialog open={open} onOpenChange={close_}>
      <DialogContent className={`max-w-md rounded-3xl p-0 border-none overflow-hidden [&>button]:hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <ModalHead icon={<WA className="h-4 w-4 text-white" />} title="Share via WhatsApp"
          sub="Credentials auto-included" grad="linear-gradient(135deg,#075E54,#25D366)" onClose={close_} />
        <div className="p-5 space-y-4">
          <div>
            <Label className="text-xs font-bold uppercase text-slate-500">Phone Number</Label>
            <Input className={`rounded-xl h-9 mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}
              placeholder="+91 9876543210" value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          {loadPw
            ? <p className="text-xs text-slate-400 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Fetching credentials…</p>
            : pw
              ? <div className={`p-3 rounded-lg text-xs space-y-1 ${isDark ? 'bg-slate-700/50 border border-slate-600' : 'bg-slate-50 border border-slate-200'}`}>
                <p className={`font-semibold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>✓ Credentials ready</p>
                <p className={`font-mono text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>ID: {entry?.username}</p>
                <p className={`font-mono text-[10px] ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Password: {pw}</p>
              </div>
              : null}
          <div>
            <Label className="text-xs font-bold uppercase text-slate-500">Additional Note (optional)</Label>
            <Textarea className={`rounded-xl resize-none text-sm mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}
              rows={3} placeholder="Extra notes…" value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter className={`px-5 py-3 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <Button variant="ghost" className="rounded-xl" onClick={close_}>Cancel</Button>
          <Button disabled={(!phone && !entry?.mobile) || loadPw || sending} onClick={send}
            className="rounded-xl font-bold text-white gap-2" style={{ background: C.whatsapp }}>
            {sending ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : <><Send className="h-4 w-4" /> Send</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportModal({ open, onClose, isDark, onDownloadTemplate }) {
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [aiFile, setAiFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const qc = useQueryClient();

  const pick = e => {
    const f = e.target.files?.[0];
    if (!f) return;
    const ext = f.name.split('.').pop()?.toLowerCase() || '';
    if (!['xlsx', 'xls', 'csv'].includes(ext)) return toast.error('Upload Excel or CSV only');
    setFile(f); setAiFile(f); setResult(null); setStep(1);
  };

  const doImport = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/passwords/bulk-import', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setResult(r.data); setStep(2);
      qc.invalidateQueries({ queryKey: ['passwords'] });
      qc.invalidateQueries({ queryKey: ['pw-stats'] });
      toast.success(`Imported ${r.data.successful_imports} entries`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally { setBusy(false); }
  };

  const close_ = () => { setStep(1); setFile(null); setResult(null); onClose(); };

  // Template columns reference — must match backend exactly
  const TEMPLATE_COLS = [
    { col: 'portal_name', req: true,  eg: 'GST Portal', note: 'Portal or site name' },
    { col: 'portal_type', req: true,  eg: 'GST / MCA / DGFT / TDS…', note: 'Use uppercase keys from the list' },
    { col: 'department',  req: true,  eg: 'GST / ROC / TDS…', note: 'Department code (uppercase)' },
    { col: 'url',         req: false, eg: 'https://www.gst.gov.in', note: 'Full portal URL' },
    { col: 'username',    req: false, eg: 'user@example.com', note: 'Login ID / email' },
    { col: 'password_plain', req: false, eg: 'SecurePass@123', note: 'Plain-text; encrypted on import' },
    { col: 'holder_type', req: false, eg: 'COMPANY / DIRECTOR / INDIVIDUAL', note: 'Defaults to COMPANY' },
    { col: 'holder_name', req: false, eg: 'Rajesh Kumar', note: 'Director / individual name' },
    { col: 'holder_pan',  req: false, eg: 'ABCPK1234D', note: '10-char PAN' },
    { col: 'holder_din',  req: false, eg: '08123456', note: '8-digit DIN' },
    { col: 'mobile',      req: false, eg: '9876543210', note: 'Registered mobile' },
    { col: 'trade_name',  req: false, eg: 'ABC Enterprises', note: 'Business / trade name' },
    { col: 'client_name', req: false, eg: 'XYZ Pvt Ltd', note: 'Client company name' },
    { col: 'client_id',   req: false, eg: 'CL001', note: 'Client code / ID' },
    { col: 'notes',       req: false, eg: 'Quarterly GST filing', note: 'Any extra notes' },
    { col: 'tags',        req: false, eg: 'GST,Client,Q1', note: 'Comma-separated tags' },
  ];

  return (
    <Dialog open={open} onOpenChange={close_}>
      <DialogContent className={`max-w-2xl rounded-3xl p-0 border-none overflow-hidden [&>button]:hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <ModalHead icon={<Upload className="h-4 w-4 text-white" />} title="Bulk Import"
          sub="Upload Excel or CSV to import credentials" grad={`linear-gradient(135deg,${C.deepBlue},${C.medBlue})`} onClose={close_} />
        <div className="p-6 space-y-4 max-h-[76vh] overflow-y-auto">

          {/* ── Step 1 — Upload ── */}
          {step === 1 && (
            <>
              {/* Template download prompt */}
              <div className={`flex items-start gap-3 px-4 py-3 rounded-xl border ${isDark ? 'bg-blue-900/20 border-blue-800/40' : 'bg-blue-50 border-blue-200'}`}>
                <Info className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-semibold ${isDark ? 'text-blue-300' : 'text-blue-700'}`}>
                    Use the official template to ensure correct column order and valid values.
                  </p>
                  <p className={`text-[11px] mt-0.5 ${isDark ? 'text-blue-400' : 'text-blue-500'}`}>
                    Required columns: <span className="font-mono font-bold">portal_name, portal_type, department</span> — all others optional.
                  </p>
                </div>
                <Button size="sm" onClick={onDownloadTemplate}
                  className="flex-shrink-0 rounded-lg font-bold h-7 text-xs gap-1.5 text-white"
                  style={{ background: C.deepBlue }}>
                  <Download className="h-3 w-3" /> Template
                </Button>
              </div>

              {/* File drop zone */}
              <label htmlFor="imp-file"
                className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-colors
                  ${isDark ? 'border-slate-600 hover:border-slate-400 hover:bg-slate-700/40' : 'border-slate-300 hover:border-blue-400 hover:bg-blue-50'}`}>
                <FileUp className="h-10 w-10 mb-2 text-slate-400" />
                <p className={`font-semibold ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Click to upload</p>
                <p className={`text-xs mt-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Excel (.xlsx, .xls) or CSV (.csv)</p>
                <input id="imp-file" type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={pick} />
              </label>
              {file && (
                <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium ${isDark ? 'bg-slate-700 border-slate-600 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  <FileUp className="h-4 w-4 text-blue-500 flex-shrink-0" />
                  {file.name}
                  <button type="button" onClick={() => setFile(null)} className="ml-auto p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-600">
                    <X className="h-3.5 w-3.5 text-slate-400" />
                  </button>
                </div>
              )}
              <AIFileInsights file={aiFile} label="Credential Import Insights" />

              {/* Column reference table */}
              <details className={`rounded-xl border overflow-hidden ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                <summary className={`px-4 py-2.5 text-xs font-bold uppercase tracking-wide cursor-pointer select-none flex items-center gap-2
                  ${isDark ? 'bg-slate-700/60 text-slate-300' : 'bg-slate-50 text-slate-600'}`}>
                  <Info className="h-3.5 w-3.5" /> Column Reference (click to expand)
                </summary>
                <div className={`overflow-x-auto ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
                  <table className="w-full text-[11px]" style={{ minWidth: 520 }}>
                    <thead className={isDark ? 'bg-slate-700/50' : 'bg-slate-50'}>
                      <tr>
                        {['Column Name', 'Required', 'Example Value', 'Description'].map(h => (
                          <th key={h} className={`px-3 py-2 text-left font-bold uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {TEMPLATE_COLS.map((c, i) => (
                        <tr key={c.col} className={`border-t ${isDark ? 'border-slate-700' : 'border-slate-100'} ${i % 2 === 0 ? (isDark ? 'bg-slate-800' : 'bg-white') : (isDark ? 'bg-slate-750' : 'bg-slate-50/50')}`}>
                          <td className="px-3 py-1.5 font-mono font-semibold text-blue-500">{c.col}</td>
                          <td className="px-3 py-1.5 text-center">
                            {c.req
                              ? <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-red-100 text-red-600">YES</span>
                              : <span className="px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-slate-100 text-slate-400">opt</span>}
                          </td>
                          <td className={`px-3 py-1.5 font-mono ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>{c.eg}</td>
                          <td className={`px-3 py-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{c.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>

              {/* Valid portal_type values */}
              <div className={`px-4 py-3 rounded-xl border text-xs ${isDark ? 'bg-slate-700/30 border-slate-600 text-slate-400' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                <span className="font-bold uppercase text-[10px] tracking-wide">Valid portal_type values: </span>
                {['MCA', 'ROC', 'DGFT', 'TRADEMARK', 'GST', 'INCOME_TAX', 'TDS', 'TRACES', 'EPFO', 'ESIC', 'MSME', 'RERA', 'OTHER'].map(t => (
                  <span key={t} className="inline-block font-mono px-1.5 py-0.5 rounded bg-slate-200/60 dark:bg-slate-600/60 mr-1 mt-0.5">{t}</span>
                ))}
              </div>
            </>
          )}

          {/* ── Step 2 — Result ── */}
          {step === 2 && result && (
            <div className={`rounded-xl p-5 space-y-3 ${isDark ? 'bg-green-900/20 border border-green-800/40' : 'bg-green-50 border border-green-200'}`}>
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center flex-shrink-0">
                  <CheckSquare className="h-4 w-4 text-white" />
                </div>
                <p className={`font-bold text-base ${isDark ? 'text-green-300' : 'text-green-700'}`}>Import Complete!</p>
              </div>
              <div className={`grid grid-cols-3 gap-3 text-center text-xs font-bold ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>
                <div className={`rounded-lg p-2 ${isDark ? 'bg-green-900/30' : 'bg-green-100'}`}>
                  <p className="text-lg text-green-600">{result.successful_imports}</p>
                  <p>Imported</p>
                </div>
                <div className={`rounded-lg p-2 ${isDark ? 'bg-red-900/30' : 'bg-red-50'}`}>
                  <p className="text-lg text-red-500">{result.failed_imports}</p>
                  <p>Failed</p>
                </div>
                <div className={`rounded-lg p-2 ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
                  <p className="text-lg text-slate-500">{result.total_processed}</p>
                  <p>Total</p>
                </div>
              </div>
              {result.errors?.length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs cursor-pointer text-red-400 font-semibold">Show errors ({result.errors.length})</summary>
                  <div className="mt-2 space-y-1 max-h-32 overflow-y-auto">
                    {result.errors.slice(0, 15).map((err, i) => (
                      <p key={i} className="text-xs text-red-400 bg-red-900/10 px-2 py-1 rounded">
                        Row {err.row}: {typeof err.error === 'string' ? err.error : JSON.stringify(err.error)}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
        <DialogFooter className={`px-6 py-4 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <Button variant="ghost" className="rounded-xl" onClick={close_}>Close</Button>
          {step === 1 && (
            <Button onClick={doImport} disabled={!file || busy} className="rounded-xl font-bold text-white" style={{ background: C.green }}>
              {busy ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Importing…</> : <><Upload className="h-4 w-4 mr-1.5" />Import Now</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareClientModal({ open, onClose, isDark, entries }) {
  const [selectedClientId, setSelectedClientId] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const [revealing, setRevealing] = useState(false);
  const [revealedMap, setRevealedMap] = useState({});

  // Build unique client list from entries
  const clientOptions = useMemo(() => {
    const m = {};
    entries.forEach(e => {
      if (e.client_id && e.client_name) m[e.client_id] = e.client_name;
    });
    return Object.entries(m).map(([id, name]) => ({ id, name }));
  }, [entries]);

  const clientEntries = useMemo(() =>
    selectedClientId ? entries.filter(e => String(e.client_id) === String(selectedClientId)) : [],
    [entries, selectedClientId]
  );

  useEffect(() => {
    if (!open) { setSelectedClientId(''); setPhone(''); setNote(''); setRevealedMap({}); }
  }, [open]);

  useEffect(() => {
    if (!selectedClientId || clientEntries.length === 0) return;
    setRevealing(true);
    setRevealedMap({});
    Promise.all(
      clientEntries.filter(e => e.has_password).map(e =>
        api.get(`/passwords/${e.id}/reveal`)
          .then(r => ({ id: e.id, pw: r.data.password || '' }))
          .catch(() => ({ id: e.id, pw: '' }))
      )
    ).then(results => {
      const m = {};
      results.forEach(r => { m[r.id] = r.pw; });
      setRevealedMap(m);
    }).finally(() => setRevealing(false));
  }, [selectedClientId, clientEntries.length]);

  const buildMessage = () => {
    const clientName = clientOptions.find(c => c.id === selectedClientId)?.name || 'Client';
    const L = [
      `🏢 *${clientName} — All Portal Credentials*`,
      '━'.repeat(30),
      ''
    ];
    clientEntries.forEach((e, idx) => {
      const m = PM[e.portal_type] || PM.OTHER;
      L.push(`${idx + 1}. ${m.icon} *${e.portal_name}* [${e.department}]`);
      if (e.url) L.push(`   🌐 ${e.url}`);
      if (e.username) L.push(`   👤 ID: ${e.username}`);
      if (e.has_password) {
        const pw = revealedMap[e.id];
        if (pw && pw !== '[decryption failed]') {
          L.push(`   🔑 Password: ${pw}`);
        }
      }
      if (e.holder_name) L.push(`   👔 Holder: ${e.holder_name}${e.holder_din ? ` (DIN: ${e.holder_din})` : ''}`);
      if (e.mobile) L.push(`   📱 Mobile: ${e.mobile}`);
      L.push('');
    });
    if (note.trim()) L.push('📝 Note: ' + note.trim(), '');
    L.push('━'.repeat(30), 'Sent via Taskosphere 📱');
    return L.join('\n');
  };

  const [sendingBulk, setSendingBulk] = useState(false);

  const send = async () => {
    if (!selectedClientId) return toast.error('Please select a client');
    if (!phone) return toast.error('Enter a phone number');
    const digits = phone.replace(/\D/g, '');
    const e164 = digits.startsWith('91') ? digits : `91${digits}`;
    setSendingBulk(true);
    try {
      const res = await api.post('/whatsapp/send', {
        to: e164, message: buildMessage(), message_type: 'password'
      }).catch(() => null);
      if (res?.data?.success) {
        toast.success('All credentials sent via WhatsApp ✓');
      } else {
        window.open(`https://wa.me/${e164}?text=${encodeURIComponent(buildMessage())}`, '_blank');
        toast.success('Opening WhatsApp…');
      }
    } finally {
      setSendingBulk(false);
      onClose();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className={`max-w-xl rounded-3xl p-0 border-none overflow-hidden [&>button]:hidden ${isDark ? 'bg-slate-800' : 'bg-white'}`}>
        <ModalHead
          icon={<Share2 className="h-4 w-4 text-white" />}
          title="Share Client Credentials"
          sub="Bundle all passwords for a client"
          grad="linear-gradient(135deg,#075E54,#25D366)"
          onClose={onClose}
        />
        <div className="p-5 space-y-4 max-h-[72vh] overflow-y-auto">
          <div>
            <Label className="text-xs font-bold uppercase text-slate-500">Select Client</Label>
            <Select value={selectedClientId} onValueChange={setSelectedClientId}>
              <SelectTrigger className={`rounded-xl mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
                <Building2 className="h-3.5 w-3.5 mr-1.5 text-slate-400 flex-shrink-0" />
                <SelectValue placeholder="— Pick a client —" />
              </SelectTrigger>
              <SelectContent>
                {clientOptions.map(c => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
                {clientOptions.length === 0 && (
                  <SelectItem value="__empty__" disabled>No clients linked to passwords yet</SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          {selectedClientId && (
            <>
              {revealing ? (
                <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Revealing passwords for {clientEntries.length} entries…
                </div>
              ) : clientEntries.length > 0 ? (
                <div className={`rounded-xl border divide-y text-xs max-h-52 overflow-y-auto ${isDark ? 'border-slate-600 divide-slate-600 bg-slate-700/30' : 'border-slate-200 divide-slate-100 bg-slate-50'}`}>
                  {clientEntries.map(e => {
                    const m = PM[e.portal_type] || PM.OTHER;
                    return (
                      <div key={e.id} className="px-3 py-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span>{m.icon}</span>
                          <span className={`font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-800'}`}>{e.portal_name}</span>
                          <PortalBadge type={e.portal_type} />
                        </div>
                        <div className={`font-mono shrink-0 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                          {e.username && <span className="mr-2">{e.username}</span>}
                          {e.has_password && (revealedMap[e.id]
                            ? <span className="text-green-600 font-bold">✓ Ready</span>
                            : <span className="text-amber-500">…</span>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-slate-400">No password entries found for this client.</p>
              )}
            </>
          )}

          <div>
            <Label className="text-xs font-bold uppercase text-slate-500">Phone Number</Label>
            <Input className={`rounded-xl h-9 mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}
              placeholder="+91 9876543210" value={phone} onChange={e => setPhone(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs font-bold uppercase text-slate-500">Additional Note (optional)</Label>
            <Textarea className={`rounded-xl resize-none text-sm mt-1 ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}
              rows={2} placeholder="Any extra info…" value={note} onChange={e => setNote(e.target.value)} />
          </div>
        </div>
        <DialogFooter className={`px-5 py-3 border-t ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
          <Button variant="ghost" className="rounded-xl" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!selectedClientId || !phone || revealing || clientEntries.length === 0 || sendingBulk}
            onClick={send}
            className="rounded-xl font-bold text-white gap-2"
            style={{ background: C.whatsapp }}>
            {sendingBulk
              ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</>
              : <><Send className="h-4 w-4" /> Share {clientEntries.length > 0 ? `${clientEntries.length} Credentials` : 'All'}</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Pager({ total, page, size, onPage, onSize, isDark }) {
  const pages = Math.ceil(total / size);
  if (total === 0) return null;
  const vis = 5;
  const start = Math.max(1, Math.min(page - 2, pages - vis + 1));
  const nums = Array.from({ length: Math.min(vis, pages) }, (_, i) => start + i);
  const btn = `h-7 min-w-[28px] px-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center`;
  return (
    <div className={`flex items-center justify-between flex-wrap gap-3 py-2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
      <div className="flex items-center gap-2 text-xs">
        <span>Rows:</span>
        <Select value={String(size)} onValueChange={v => { onSize(Number(v)); onPage(1); }}>
          <SelectTrigger className={`h-7 w-20 rounded-lg text-xs ${isDark ? 'bg-slate-700 border-slate-600 text-slate-200' : 'bg-white'}`}><SelectValue /></SelectTrigger>
          <SelectContent>{PAGE_SIZES.map(s => <SelectItem key={s} value={String(s)}>{s}</SelectItem>)}</SelectContent>
        </Select>
        <span>{Math.min((page - 1) * size + 1, total)}–{Math.min(page * size, total)} of {total}</span>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" disabled={page === 1} onClick={() => onPage(1)} className={`${btn} ${isDark ? 'hover:bg-slate-700 disabled:opacity-30' : 'hover:bg-slate-100 disabled:opacity-30'}`}>«</button>
        <button type="button" disabled={page === 1} onClick={() => onPage(page - 1)} className={`${btn} ${isDark ? 'hover:bg-slate-700 disabled:opacity-30' : 'hover:bg-slate-100 disabled:opacity-30'}`}><ChevronLeft className="h-3.5 w-3.5" /></button>
        {nums.map(p => (
          <button key={p} type="button" onClick={() => onPage(p)}
            className={`${btn} ${p === page ? 'text-white shadow-sm' : isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}
            style={p === page ? { background: `linear-gradient(135deg,${C.deepBlue},${C.medBlue})` } : {}}>{p}</button>
        ))}
        <button type="button" disabled={page === pages} onClick={() => onPage(page + 1)} className={`${btn} ${isDark ? 'hover:bg-slate-700 disabled:opacity-30' : 'hover:bg-slate-100 disabled:opacity-30'}`}><ChevronRight className="h-3.5 w-3.5" /></button>
        <button type="button" disabled={page === pages} onClick={() => onPage(pages)} className={`${btn} ${isDark ? 'hover:bg-slate-700 disabled:opacity-30' : 'hover:bg-slate-100 disabled:opacity-30'}`}>»</button>
      </div>
    </div>
  );
}

function Card({ entry, no, canEdit, isAdmin, onEdit, onDel, onShare, onDetail, isDark, sel, onSel }) {
  const m = PM[entry.portal_type] || PM.OTHER;
  return (
    <motion.div variants={iv} whileHover={{ y: -3, transition: spring }}>
      <div onClick={() => onDetail(entry)}
        className={`rounded-2xl border-2 p-3.5 h-full flex flex-col cursor-pointer transition-all
          ${sel ? (isDark ? 'border-blue-500 bg-blue-900/10' : 'border-blue-400 bg-blue-50')
            : (isDark ? 'bg-slate-800 hover:shadow-xl' : 'bg-white hover:shadow-lg')}`}
        style={!sel ? { borderColor: m.border, boxShadow: `0 0 0 1px ${m.border}18` } : {}}>

        <div className="flex items-start justify-between mb-2.5">
          <div className="flex items-start gap-2 flex-1 min-w-0">
            {isAdmin && (
              <div className="flex-shrink-0 mt-0.5" onClick={e => { e.stopPropagation(); onSel(entry.id); }}>
                <input type="checkbox" checked={sel} readOnly className="w-3.5 h-3.5 rounded cursor-pointer accent-blue-500" />
              </div>
            )}
            <span className="text-[10px] font-black flex-shrink-0 w-5 h-5 rounded-lg flex items-center justify-center text-white mt-0.5"
              style={{ background: m.color }}>{no}</span>
            <div className="flex-1 min-w-0">
              <h3 className={`font-bold text-sm truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{entry.portal_name}</h3>
              <div className="flex items-center gap-1 mt-1 flex-wrap">
                <PortalBadge type={entry.portal_type} />
                <DeptBadge dept={entry.department} />
                <HolderBadge holderType={entry.holder_type} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5 ml-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
            {canEdit && <button type="button" onClick={() => onEdit(entry)} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}><Edit2 className="h-3 w-3 text-slate-400" /></button>}
            {isAdmin && <button type="button" onClick={() => onDel(entry)} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}><Trash2 className="h-3 w-3 text-red-400" /></button>}
          </div>
        </div>

        <div className="h-0.5 rounded-full mb-2.5" style={{ background: `linear-gradient(90deg,${m.color},${m.border})` }} />

        {entry.holder_name && (
          <div className={`flex items-center gap-1.5 mb-2 px-2 py-1 rounded-lg text-xs font-medium ${isDark ? 'bg-purple-900/30 text-purple-300' : 'bg-purple-50 text-purple-700'}`}>
            <UserIcon className="h-3 w-3 flex-shrink-0" /><span className="truncate">{entry.holder_name}</span>
            {entry.holder_din && <span className="text-[10px] opacity-70 flex-shrink-0">DIN:{entry.holder_din}</span>}
          </div>
        )}
        {entry.client_name && (
          <div className={`flex items-center gap-1.5 mb-2 px-2 py-1 rounded-lg text-xs font-medium ${isDark ? 'bg-blue-900/30 text-blue-300' : 'bg-blue-50 text-blue-700'}`}>
            <Building2 className="h-3 w-3 flex-shrink-0" /><span className="truncate">{entry.client_name}</span>
          </div>
        )}
        {entry.trade_name && (
          <div className={`flex items-center gap-1.5 mb-2 px-2 py-1 rounded-lg text-xs font-medium ${isDark ? 'bg-amber-900/30 text-amber-300' : 'bg-amber-50 text-amber-700'}`}>
            <Store className="h-3 w-3 flex-shrink-0" /><span className="truncate">{entry.trade_name}</span>
          </div>
        )}
        {entry.username && (
          <div className="mb-2.5" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <UserIcon className="h-3 w-3 text-slate-400 flex-shrink-0" />
              <span className={`font-mono text-xs truncate flex-1 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{entry.username}</span>
              <button type="button" onClick={() => navigator.clipboard.writeText(entry.username).then(() => toast.success('Copied'))}
                className={`flex-shrink-0 p-0.5 rounded ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
                <Copy className="h-3 w-3 text-slate-400" />
              </button>
            </div>
          </div>
        )}
        <div className="mb-2.5" onClick={e => e.stopPropagation()}>
          <p className={`text-[10px] font-bold uppercase tracking-wider mb-0.5 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>Password</p>
          {entry.has_password
            ? <RevealPw entryId={entry.id} isDark={isDark} canReveal={isAdmin} />
            : <span className={`text-xs italic ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>No password stored</span>}
        </div>
        {entry.mobile && (
          <div className={`flex items-center gap-1.5 mb-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
            <Smartphone className="h-3 w-3 flex-shrink-0" /><span className="font-mono">{entry.mobile}</span>
          </div>
        )}
        {entry.url && (
          <div className="mb-2" onClick={e => e.stopPropagation()}>
            <button type="button" onClick={() => window.open(entry.url, '_blank')}
              className="flex items-center gap-1.5 text-xs font-medium text-blue-500 hover:underline truncate w-full text-left">
              <Globe className="h-3 w-3 flex-shrink-0" /><span className="truncate">{entry.url}</span><ExternalLink className="h-2.5 w-2.5 flex-shrink-0 opacity-60" />
            </button>
          </div>
        )}
        {entry.notes && (
          <div className={`mt-auto pt-2 border-t text-[11px] ${isDark ? 'border-slate-700 text-slate-400' : 'border-slate-100 text-slate-500'}`}>
            {entry.notes.slice(0, 80)}{entry.notes.length > 80 ? '…' : ''}
          </div>
        )}
        <div className={`flex items-center justify-between mt-2.5 pt-2 border-t text-[10px] ${isDark ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
          <span className="flex items-center gap-1"><Clock className="h-2.5 w-2.5" />{entry.updated_at ? format(new Date(entry.updated_at), 'MMM d') : '—'}</span>
          {entry.last_accessed_at && <span className="flex items-center gap-1"><Activity className="h-2.5 w-2.5" />{format(new Date(entry.last_accessed_at), 'MMM d')}</span>}
        </div>
        <motion.button type="button" whileTap={{ scale: 0.97 }} onClick={e => { e.stopPropagation(); onShare(entry); }}
          className="mt-2.5 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-xl text-xs font-bold"
          style={{ background: isDark ? 'rgba(37,211,102,0.08)' : 'rgba(37,211,102,0.07)', color: C.whatsapp, border: `1px solid ${C.whatsapp}28` }}>
          <WA className="h-3 w-3" /> Share via WhatsApp
        </motion.button>
      </div>
    </motion.div>
  );
}

function Row({ entry, no, canEdit, isAdmin, onEdit, onDel, onShare, onDetail, isDark, sel, onSel }) {
  const m = PM[entry.portal_type] || PM.OTHER;
  const primary = entry.client_name || entry.holder_name || '—';
  const isOD = entry.updated_at && false; // no due date concept for passwords

  return (
    <motion.div variants={iv} layout>
      <div
        className={`relative rounded-xl border transition-all duration-200 overflow-hidden group cursor-pointer
          ${sel
            ? (isDark ? 'bg-blue-900/20 border-blue-600' : 'bg-blue-50 border-blue-300')
            : (isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-500 hover:shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm')}`}
        onClick={() => onDetail(entry)}
      >
        {/* Left color stripe matching Tasks strip */}
        <div className="absolute left-0 top-0 h-full w-1 rounded-l-xl" style={{ background: m.color }} />

        <div
          className="pl-5 pr-3 py-2.5 grid items-center gap-0"
          style={{ gridTemplateColumns: isAdmin ? '16px 28px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) 120px 120px 96px' : '28px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) 120px 120px 96px' }}
        >
          {/* Checkbox */}
          {isAdmin && (
            <div onClick={e => { e.stopPropagation(); onSel(entry.id); }}>
              <input type="checkbox" checked={sel} readOnly
                className="w-3.5 h-3.5 rounded cursor-pointer accent-blue-500" />
            </div>
          )}

          {/* Row number */}
          <span className="text-center">
            <span className="text-[10px] font-black text-white rounded px-1.5 py-0.5"
              style={{ background: m.color }}>{no}</span>
          </span>

          {/* Client / Holder */}
          <div className="pl-1 min-w-0">
            <span className={`font-semibold text-sm block truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{primary}</span>
            {entry.client_name && entry.holder_name && (
              <span className={`text-xs truncate block ${isDark ? 'text-purple-300' : 'text-purple-600'}`}>{entry.holder_name}</span>
            )}
            {entry.trade_name && (
              <span className={`text-[10px] truncate block ${isDark ? 'text-amber-300' : 'text-amber-600'}`}>{entry.trade_name}</span>
            )}
          </div>

          {/* Portal name */}
          <div className="min-w-0 pr-2">
            <span className={`font-semibold text-sm block truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>{entry.portal_name}</span>
            {entry.url && (
              <button type="button"
                onClick={e => { e.stopPropagation(); window.open(entry.url, '_blank'); }}
                className="flex items-center gap-1 text-[10px] text-blue-500 hover:underline truncate max-w-full">
                <Globe className="h-2.5 w-2.5 flex-shrink-0" />
                <span className="truncate">{entry.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
              </button>
            )}
          </div>

          {/* Username / Password */}
          <div className="min-w-0 pr-2" onClick={e => e.stopPropagation()}>
            {entry.username && (
              <div className="flex items-center gap-1.5 mb-1">
                <UserIcon className="h-3 w-3 text-slate-400 flex-shrink-0" />
                <span className={`font-mono text-xs truncate flex-1 ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{entry.username}</span>
                <button type="button" onClick={() => navigator.clipboard.writeText(entry.username).then(() => toast.success('Copied'))}
                  className={`flex-shrink-0 p-0.5 rounded ${isDark ? 'hover:bg-slate-700' : 'hover:bg-slate-100'}`}>
                  <Copy className="h-2.5 w-2.5 text-slate-400" />
                </button>
              </div>
            )}
            <RevealPw entryId={entry.id} isDark={isDark} canReveal={isAdmin} />
          </div>

          {/* Type & Dept badges */}
          <div className="flex flex-col items-center gap-1">
            <PortalBadge type={entry.portal_type} />
            <DeptBadge dept={entry.department} />
          </div>

          {/* URL/date */}
          <div className="flex flex-col items-center gap-1 text-[10px]">
            {entry.mobile && (
              <span className={`flex items-center gap-1 font-mono ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                <Smartphone className="h-2.5 w-2.5" />{entry.mobile}
              </span>
            )}
            <span className={`flex items-center gap-1 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
              <Clock className="h-2.5 w-2.5" />
              {entry.updated_at ? format(new Date(entry.updated_at), 'MMM d') : '—'}
            </span>
          </div>

          {/* Actions — show on group hover like Tasks */}
          <div className="flex items-center justify-end gap-0 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={e => e.stopPropagation()}>
            {canEdit && (
              <button type="button" onClick={() => onEdit(entry)}
                className={`p-1 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20 text-slate-400 hover:text-blue-600 transition-colors`}
                title="Edit">
                <Edit2 className="h-3.5 w-3.5" />
              </button>
            )}
            <button type="button" onClick={() => onShare(entry)}
              className={`p-1 rounded transition-colors`}
              title="Share via WhatsApp"
              style={{ color: C.whatsapp }}>
              <WA className="h-3.5 w-3.5" />
            </button>
            {isAdmin && (
              <button type="button" onClick={() => onDel(entry)}
                className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-400 hover:text-red-600 transition-colors"
                title="Delete">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

export default function PasswordRepository() {
  const isDark = useDark();
  const { user } = useAuth();
  const qc = useQueryClient();

  const [view, setView] = useState('list');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('lifo');
  const [fDept, setFDept] = useState('ALL');
  const [fType, setFType] = useState('ALL');
  const [fClient, setFClient] = useState('ALL');
  const [fHolder, setFHolder] = useState('ALL');
  const [selIds, setSelIds] = useState(new Set());
  // ── AI Duplicate detection ────────────────────────────────────────────────
  const [showDupDialog, setShowDupDialog] = useState(false);
  const [dupGroups,     setDupGroups]     = useState([]);
  const [detectingDups, setDetectingDups] = useState(false);

  const [detailOpen, setDetailOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editEntry, setEditEntry] = useState(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delEntry, setDelEntry] = useState(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareEntry, setShareEntry] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [shareClientOpen, setShareClientOpen] = useState(false);

  const isAdmin = user?.role === 'admin';
  const canView = isAdmin || hasPerm(user, 'can_view_passwords');
  const canEdit = isAdmin || hasPerm(user, 'can_edit_passwords');
  const canDeletePasswords = isAdmin || hasPerm(user, 'can_delete_data');

  const sortMeta = SORTS.find(s => s.value === sort) || SORTS[0];

  const { data: entries = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['passwords', search, fDept, fType, fClient, fHolder, sort],
    queryFn: async () => {
      const p = { sort_by: sortMeta.by, sort_order: sortMeta.ord, limit: 500 };
      if (search) p.search = search;
      if (fDept !== 'ALL') p.department = fDept;
      if (fType !== 'ALL') p.portal_type = fType;
      if (fClient !== 'ALL') p.client_id = fClient;
      if (fHolder !== 'ALL') p.holder_type = fHolder;
      const r = await api.get('/passwords', { params: p });
      return Array.isArray(r.data) ? r.data : [];
    },
    enabled: canView,
    staleTime: 30000,
    refetchOnWindowFocus: false,
    retry: 1,
    retryDelay: 2000,
  });

  const { data: stats = {} } = useQuery({
    queryKey: ['pw-stats', user?.id],          // scoped per user
    queryFn: async () => {
      try {
        // /passwords/stats returns counts scoped to the current user's permissions:
        //   Admin   → all entries
        //   Manager → entries in their department(s)
        //   User    → entries in their dept + view_password_departments list
        const r = await api.get('/passwords/stats');
        return r.data || {};
      } catch (e) {
        if (process.env.NODE_ENV === 'development') console.warn('pw-stats:', e.message);
        return {};
      }
    },
    enabled: canView,          // all roles with can_view_passwords, not just admin
    staleTime: 60000,
    retry: false,
  });

  const paginated = useMemo(() => {
    const s = (page - 1) * size;
    return entries.slice(s, s + size);
  }, [entries, page, size]);

  const clients = useMemo(() => {
    const m = {};
    entries.forEach(e => { if (e.client_id && e.client_name) m[e.client_id] = e.client_name; });
    return Object.entries(m).map(([id, name]) => ({ id, name }));
  }, [entries]);

  const hasFilter = fDept !== 'ALL' || fType !== 'ALL' || fClient !== 'ALL' || fHolder !== 'ALL' || !!search;
  const clearFilters = () => { setFDept('ALL'); setFType('ALL'); setFClient('ALL'); setFHolder('ALL'); setSearch(''); setPage(1); };
  const toggleSel = id => { const n = new Set(selIds); n.has(id) ? n.delete(id) : n.add(id); setSelIds(n); };

  // ── AI Duplicate Detection ─────────────────────────────────────────────────
  const handleDetectPasswordDuplicates = () => {
    if (detectingDups) return;
    setDetectingDups(true);
    setTimeout(() => {
      try {
        const all = entries || [];
        const groups = detectPasswordDuplicates(all);
        setDupGroups(groups);
        setShowDupDialog(true);
        if (!groups.length) toast.success(`Scanned ${all.length} entries — no duplicates found ✓`);
        else toast.info(`Found ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''}`);
      } catch (e) {
        toast.error('Duplicate scan failed. Please try again.');
        console.error('Password duplicate detection error:', e);
      } finally {
        setDetectingDups(false);
      }
    }, 60);
  };

  const dlTemplate = async () => {
    try {
      const r = await api.get('/passwords/template', { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data]));
      const a = document.createElement('a');
      a.href = url; a.download = 'password_template.xlsx'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(errorMessage(e)); }
  };

  if (!canView) return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className={`text-center p-12 rounded-3xl border max-w-sm ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
        <div className="w-16 h-16 bg-red-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
          <ShieldAlert className="h-8 w-8 text-red-500" />
        </div>
        <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Access Restricted</h2>
        <p className={`text-sm ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
          You need the <b>View Password Repository</b> permission to see this page.
        </p>
      </motion.div>
    </div>
  );

  return (
    <motion.div className="space-y-4" variants={cv} initial="hidden" animate="visible">
      <motion.div variants={iv}>
        <div className="relative overflow-hidden rounded-2xl px-4 sm:px-6 pt-4 sm:pt-5 pb-4"
          style={{ background: `linear-gradient(135deg,${C.deepBlue} 0%,${C.medBlue} 100%)`, boxShadow: '0 8px 32px rgba(13,59,102,0.28)' }}>
          <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10"
            style={{ background: 'radial-gradient(circle,white 0%,transparent 70%)' }} />
          <div className="absolute right-24 bottom-0 w-32 h-32 rounded-full mb-[-30px] opacity-5" style={{ background: 'white' }} />
          <div className="absolute left-0 bottom-0 w-48 h-48 rounded-full -ml-20 -mb-20 opacity-5" style={{ background: 'white' }} />
          <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 min-w-0">
            <div className="flex-1 min-w-0">
              <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1 flex items-center gap-1.5">
                <KeyRound className="h-3 w-3" /> Password Management
              </p>
              <h1 className="text-lg sm:text-2xl font-bold text-white tracking-tight leading-tight">Password Vault</h1>
              <p className="text-white/60 text-sm mt-1">MCA/ROC · GST · IT · TDS · DGFT · TM & more</p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {canView && stats.total != null && (
                <span className="hidden sm:flex items-center px-3 py-1.5 bg-white/15 rounded-xl text-white text-xs font-bold border border-white/20">
                  {stats.total} entries
                </span>
              )}
              {canEdit && (
                <>
                  <Button onClick={dlTemplate} size="sm"
                    className="rounded-xl font-bold h-8 text-xs gap-1.5 text-white hover:bg-white/20 border border-white/20"
                    style={{ background: 'rgba(255,255,255,0.15)' }}>
                    <Download className="h-3.5 w-3.5" /> Template
                  </Button>
                  <Button onClick={() => setImportOpen(true)} size="sm"
                    className="rounded-xl font-bold h-8 text-xs gap-1.5 text-white hover:bg-white/20 border border-white/20"
                    style={{ background: 'rgba(255,255,255,0.15)' }}>
                    <Upload className="h-3.5 w-3.5" /> Import
                  </Button>
                  <Button onClick={() => setShareClientOpen(true)} size="sm"
                    className="rounded-xl font-bold h-8 text-xs gap-1.5 text-white hover:bg-white/20 border border-white/20"
                    style={{ background: 'rgba(255,255,255,0.15)' }}
                    title="Share all credentials of a client via WhatsApp">
                    <Share2 className="h-3.5 w-3.5" /> Share Client
                  </Button>
                  {/* ── AI Duplicate Detector ── */}
                  <Button
                    onClick={handleDetectPasswordDuplicates}
                    disabled={detectingDups || !(entries && entries.length > 0)}
                    size="sm"
                    className="rounded-xl font-bold h-8 text-xs gap-1.5 transition-all disabled:opacity-40"
                    style={{ background: 'rgba(139,92,246,0.35)', border: '1px solid rgba(167,139,250,0.6)', color: '#ede9fe' }}
                    title="Detect duplicate password entries using AI"
                  >
                    {detectingDups
                      ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Scanning…</>
                      : <><Sparkles className="h-3.5 w-3.5" />AI Duplicates</>}
                  </Button>
                  <Button onClick={() => { setEditEntry(null); setEditOpen(true); }} size="sm"
                    className="rounded-xl font-bold h-8 text-xs gap-1.5 text-white shadow-lg"
                    style={{ background: C.green }}>
                    <Plus className="h-3.5 w-3.5" /> Add
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* Portal-type stats cards — shown for all roles with can_view_passwords.
           Backend /passwords/stats scopes counts to the user's permitted departments. */}
      {canView && stats.by_portal_type && Object.keys(stats.by_portal_type).length > 0 && (
        <motion.div variants={iv} className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {Object.entries(stats.by_portal_type).slice(0, 6).map(([type, count]) => {
            const m = PM[type] || PM.OTHER;
            const active = fType === type;
            return (
              <motion.div key={type} whileHover={{ y: -2, transition: spring }}
                onClick={() => { setFType(active ? 'ALL' : type); setPage(1); }}
                className={`rounded-xl border p-2 cursor-pointer transition-all text-center
                  ${active ? 'shadow-md' : (isDark ? 'bg-slate-800 border-slate-700 hover:border-slate-600' : 'bg-white border-slate-200 hover:border-slate-300')}`}
                style={active ? { background: m.accent, borderColor: m.border, borderWidth: '2px' } : {}}>
                <div className="text-base mb-0.5">{m.icon}</div>
                <p className="text-lg font-black leading-none" style={{ color: m.color }}>{count}</p>
                <p className={`text-[10px] font-semibold mt-0.5 ${isDark && !active ? 'text-slate-400' : 'text-slate-500'}`}>{m.label}</p>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      <motion.div variants={iv}>
        <div className={`flex flex-col sm:flex-row gap-2 p-3 rounded-xl border flex-wrap ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <Input className={`pl-9 rounded-xl h-9 text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}
              placeholder="Search portal, username, client…" value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }} />
          </div>
          <Select value={sort} onValueChange={v => { setSort(v); setPage(1); }}>
            <SelectTrigger className={`w-full sm:w-40 rounded-xl h-9 text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
              <ArrowUpDown className="h-3.5 w-3.5 mr-1.5 text-slate-400" /><SelectValue />
            </SelectTrigger>
            <SelectContent>{SORTS.map(s => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
          </Select>
          {clients.length > 0 && (
            <Select value={fClient} onValueChange={v => { setFClient(v); setPage(1); }}>
              <SelectTrigger className={`w-full sm:w-40 rounded-xl h-9 text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
                <Building2 className="h-3.5 w-3.5 mr-1 text-slate-400" /><SelectValue placeholder="All Clients" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All Clients</SelectItem>
                {clients.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
          <Select value={fHolder} onValueChange={v => { setFHolder(v); setPage(1); }}>
            <SelectTrigger className={`w-full sm:w-36 rounded-xl h-9 text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
              <Users className="h-3.5 w-3.5 mr-1 text-slate-400" /><SelectValue placeholder="Holder" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Holders</SelectItem>
              {HOLDER_TYPES.map(h => <SelectItem key={h} value={h}>{HM[h].icon} {HM[h].label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={fDept} onValueChange={v => { setFDept(v); setPage(1); }}>
            <SelectTrigger className={`w-full sm:w-36 rounded-xl h-9 text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
              <Filter className="h-3.5 w-3.5 mr-1 text-slate-400" /><SelectValue placeholder="Dept" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Depts</SelectItem>
              {DEPTS.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={fType} onValueChange={v => { setFType(v); setPage(1); }}>
            <SelectTrigger className={`w-full sm:w-40 rounded-xl h-9 text-sm ${isDark ? 'bg-slate-700 border-slate-600 text-slate-100' : ''}`}>
              <Tag className="h-3.5 w-3.5 mr-1 text-slate-400" /><SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All Types</SelectItem>
              {PORTAL_TYPES.map(t => <SelectItem key={t} value={t}>{PM[t].icon} {PM[t].label}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className={`flex items-center rounded-xl p-0.5 gap-0.5 border flex-shrink-0 ${isDark ? 'bg-slate-700 border-slate-600' : 'bg-slate-100 border-slate-200'}`}>
            {[['grid', <LayoutGrid className="h-4 w-4" />], ['list', <List className="h-4 w-4" />]].map(([v, icon]) => (
              <button key={v} type="button" onClick={() => setView(v)}
                className={`p-1.5 rounded-lg transition-all ${view === v ? (isDark ? 'bg-slate-500 text-white' : 'bg-white text-slate-700 shadow-sm') : 'text-slate-400 hover:text-slate-600'}`}>
                {icon}
              </button>
            ))}
          </div>
          {hasFilter && <Button variant="ghost" className="rounded-xl h-9 px-2.5 text-xs flex-shrink-0" onClick={clearFilters}><X className="h-3.5 w-3.5 mr-1" /> Clear</Button>}
        </div>
      </motion.div>

      {!isLoading && !isError && entries.length > 0 && (
        <motion.div variants={iv} className="flex items-center justify-between px-1 gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            {isAdmin && (
              <button type="button"
                onClick={() => {
                  if (selIds.size === paginated.length && paginated.length > 0) {
                    setSelIds(new Set());
                  } else {
                    setSelIds(new Set(paginated.map(e => e.id)));
                  }
                }}
                className={`flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg border transition-all
                  ${selIds.size > 0
                    ? (isDark ? 'border-blue-500 text-blue-400 bg-blue-900/20' : 'border-blue-400 text-blue-600 bg-blue-50')
                    : (isDark ? 'border-slate-600 text-slate-400 hover:border-slate-500' : 'border-slate-300 text-slate-500 hover:border-slate-400')}`}>
                {selIds.size === paginated.length && paginated.length > 0
                  ? <CheckSquare className="h-3.5 w-3.5" />
                  : <Square className="h-3.5 w-3.5" />}
                {selIds.size > 0 ? `${selIds.size} selected` : 'Select all'}
              </button>
            )}
            <span className={`text-xs font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
              {entries.length} result{entries.length !== 1 ? 's' : ''}{hasFilter && ' (filtered)'}
            </span>
          </div>
          {selIds.size > 0 && isAdmin && (
            <Button size="sm" variant="destructive" className="h-7 text-xs rounded-lg gap-1.5"
              onClick={async () => {
                const count = selIds.size;
                if (!window.confirm(`Delete ${count} selected entr${count === 1 ? 'y' : 'ies'}? This cannot be undone.`)) return;
                try {
                  await Promise.all([...selIds].map(id => api.delete(`/passwords/${id}`)));
                  toast.success(`${count} entr${count === 1 ? 'y' : 'ies'} deleted`);
                  setSelIds(new Set());
                  qc.invalidateQueries({ queryKey: ['passwords'] });
                  qc.invalidateQueries({ queryKey: ['pw-stats'] });
                } catch (e) { toast.error(errorMessage(e)); }
              }}>
              <Trash2 className="h-3 w-3" /> Delete {selIds.size} selected
            </Button>
          )}
        </motion.div>
      )}

      {isLoading ? (
        <MiniLoader height={350} />
      ) : isError ? (
        <motion.div variants={iv}
          className={`text-center py-14 rounded-2xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          {error?.response?.status === 403
            ? <ShieldAlert className="h-10 w-10 text-red-400 mx-auto mb-3" />
            : error?.response?.status === 404
              ? <ServerCrash className="h-10 w-10 text-amber-400 mx-auto mb-3" />
              : error?.code === 'ERR_NETWORK'
                ? <WifiOff className="h-10 w-10 text-slate-400 mx-auto mb-3" />
                : <AlertTriangle className="h-10 w-10 text-red-400 mx-auto mb-3" />}

          <p className={`font-bold text-base ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>Failed to load password vault</p>
          <p className={`text-sm mt-1.5 mx-auto max-w-md px-4 ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
            {errorMessage(error)}
          </p>

          {error?.response?.status === 404 && (
            <div className={`mt-4 mx-auto max-w-md text-left px-6 py-4 rounded-xl border text-xs ${isDark ? 'bg-slate-700/50 border-slate-600 text-slate-300' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
              <p className="font-bold mb-2">Likely causes:</p>
              <ul className="space-y-1 list-disc list-inside">
                <li>The passwords router isn't included in main.py</li>
                <li>Backend might be on a cold-start — wait ~30s and retry</li>
              </ul>
            </div>
          )}

          <Button variant="ghost" className="mt-5 rounded-xl" onClick={() => refetch()}>
            <RefreshCw className="h-4 w-4 mr-1.5" /> Retry
          </Button>
        </motion.div>
      ) : entries.length === 0 ? (
        <motion.div variants={iv}
          className={`text-center py-16 rounded-2xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200'}`}>
          <KeyRound className="h-10 w-10 text-slate-300 mx-auto mb-3" />
          <p className={`font-semibold text-lg ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>No credentials found</p>
          <p className="text-sm text-slate-400 mt-1 mb-5">
            {hasFilter ? 'Try clearing your filters.' : 'Add your first portal credential to get started.'}
          </p>
          {hasFilter && <Button variant="outline" className="rounded-xl mr-2" onClick={clearFilters}><X className="h-4 w-4 mr-1.5" />Clear filters</Button>}
          {canEdit && (
            <Button onClick={() => { setEditEntry(null); setEditOpen(true); }} className="rounded-xl font-bold text-white" style={{ background: C.green }}>
              <Plus className="h-4 w-4 mr-1.5" /> Add First Entry
            </Button>
          )}
        </motion.div>
      ) : view === 'grid' ? (
        <motion.div variants={iv} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {paginated.map((e, i) => (
            <Card key={e.id} entry={e} no={(page - 1) * size + i + 1}
              canEdit={canEdit} isAdmin={isAdmin}
              onEdit={x => { setEditEntry(x); setEditOpen(true); }}
              onDel={x => { setDelEntry(x); setDelOpen(true); }}
              onShare={x => { setShareEntry(x); setShareOpen(true); }}
              onDetail={x => { setDetailEntry(x); setDetailOpen(true); }}
              isDark={isDark} sel={selIds.has(e.id)} onSel={toggleSel} />
          ))}
        </motion.div>
      ) : (
        <motion.div variants={iv} className="space-y-1.5">
          {/* ── Column header — mirrors Tasks list header style ── */}
          <div
            className={`hidden sm:grid items-center pl-5 pr-3 py-2 text-[10px] font-bold uppercase tracking-widest select-none border-b mb-1
              ${isDark ? 'text-slate-500 border-slate-700' : 'text-slate-400 border-slate-100'}`}
            style={{ gridTemplateColumns: isAdmin ? '16px 28px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) 120px 120px 96px' : '28px minmax(0,1.4fr) minmax(0,1fr) minmax(0,1fr) 120px 120px 96px' }}
          >
            {isAdmin && (
              <button type="button"
                onClick={() => {
                  if (selIds.size === paginated.length && paginated.length > 0) setSelIds(new Set());
                  else setSelIds(new Set(paginated.map(e => e.id)));
                }}
                className="flex items-center justify-center"
                title={selIds.size === paginated.length ? 'Deselect all' : 'Select all on page'}
              >
                {selIds.size === paginated.length && paginated.length > 0
                  ? <CheckSquare className="h-3.5 w-3.5 text-blue-500" />
                  : <Square className="h-3.5 w-3.5 text-slate-400" />}
              </button>
            )}
            <span className="text-center">#</span>
            <span className="pl-1">Client / Holder</span>
            <span>Portal</span>
            <span>Username / Password</span>
            <span className="text-center">Type &amp; Dept</span>
            <span className="text-center">URL / Date</span>
            <span className="text-right">Actions</span>
          </div>

          {paginated.map((e, i) => (
            <Row key={e.id} entry={e} no={(page - 1) * size + i + 1}
              canEdit={canEdit} isAdmin={isAdmin}
              onEdit={x => { setEditEntry(x); setEditOpen(true); }}
              onDel={x => { setDelEntry(x); setDelOpen(true); }}
              onShare={x => { setShareEntry(x); setShareOpen(true); }}
              onDetail={x => { setDetailEntry(x); setDetailOpen(true); }}
              isDark={isDark} sel={selIds.has(e.id)} onSel={toggleSel} />
          ))}

          {paginated.length === 0 && (
            <div className="text-center py-16">
              <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3 ${isDark ? 'bg-slate-700' : 'bg-slate-100'}`}>
                <Search className="h-5 w-5 text-slate-400" />
              </div>
              <p className={`text-sm font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No entries found</p>
              <p className="text-xs text-slate-400 mt-1">Try adjusting your filters</p>
            </div>
          )}
        </motion.div>
      )}

      <Pager total={entries.length} page={page} size={size}
        onPage={p => { setPage(p); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
        onSize={s => { setSize(s); setPage(1); }}
        isDark={isDark} />

      <DetailModal open={detailOpen} onClose={() => setDetailOpen(false)} entry={detailEntry} isDark={isDark} isAdmin={isAdmin} />
      <EditModal open={editOpen} onClose={() => setEditOpen(false)} entry={editEntry} isDark={isDark}
        onSuccess={() => qc.invalidateQueries({ queryKey: ['passwords'] })} />
      <DeleteModal open={delOpen} onClose={() => setDelOpen(false)} entry={delEntry} isDark={isDark} />
      <WAModal open={shareOpen} onClose={() => setShareOpen(false)} entry={shareEntry} isDark={isDark} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} isDark={isDark} onDownloadTemplate={dlTemplate} />
      <ShareClientModal open={shareClientOpen} onClose={() => setShareClientOpen(false)} isDark={isDark} entries={entries} />

      {/* ── AI Duplicate Detection Dialog ─────────────────────────────── */}
      <AIDuplicateDialog
        open={showDupDialog}
        onClose={() => setShowDupDialog(false)}
        groups={dupGroups}
        items={entries || []}
        entityLabel="Password"
        accentColor="#7c3aed"
        isDark={isDark}
        canDelete={canDeletePasswords}
        canEdit={canEdit}
        getTitle={(e) => e.portal_name || (PM[e.portal_type] ? `${PM[e.portal_type].icon} ${PM[e.portal_type].label}` : e.portal_type) || 'Unknown Portal'}
        getSubtitle={(e) => [e.client_name || e.company_name, e.username || e.user_id].filter(Boolean).join(' · ') || null}
        getMeta={(e) => [
          e.portal_type  ? (PM[e.portal_type]?.label || e.portal_type) : null,
          e.department   ? e.department.toUpperCase()                   : null,
          e.pan          ? `PAN: ${e.pan}`                             : null,
        ].filter(Boolean)}
        compareFields={(a, b) => [
          { label: 'Portal',     a: PM[a.portal_type]?.label || a.portal_type, b: PM[b.portal_type]?.label || b.portal_type },
          { label: 'Client',     a: a.client_name || a.company_name,           b: b.client_name || b.company_name },
          { label: 'Username',   a: a.username || a.user_id,                   b: b.username || b.user_id },
          { label: 'PAN',        a: a.pan,                                     b: b.pan },
          { label: 'Department', a: a.department,                              b: b.department },
          { label: 'Notes',      a: (a.notes || '—').slice(0, 60),             b: (b.notes || '—').slice(0, 60) },
          { label: 'Created',    a: a.created_at ? a.created_at.slice(0, 10) : '—', b: b.created_at ? b.created_at.slice(0, 10) : '—' },
        ]}
        onEdit={(e) => { setEditEntry(e); setEditOpen(true); setShowDupDialog(false); }}
        onDelete={(e) => { setDelEntry(e); setDelOpen(true); setShowDupDialog(false); }}
        onView={(e) => { setDetailEntry(e); setDetailOpen(true); setShowDupDialog(false); }}
      />
    </motion.div>
  );
}
