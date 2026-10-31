import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogDescription,
  DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Card, CardContent } from '@/components/ui/card';
import api from '@/lib/api';
import { toast } from 'sonner';
import {
  Plus, Search, Upload, X, Loader2, Pencil, Trash2, UserCheck,
  Briefcase, GraduationCap, IndianRupee, Clock, Building2, Mail, Phone,
  Sparkles, Target, Award, AlertCircle, CheckCircle2, TrendingUp,
  FileText, Calendar, MapPin, Star, Zap, Shield, ChevronRight,
  Brain, Lightbulb, MessageSquare, BarChart3, Activity,
} from 'lucide-react';

// ── Brand Colors ─────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue: '#0D3B66',
  mediumBlue: '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  lightGreen: '#5CCB5F',
  indigo: '#4F46E5',
  violet: '#7C3AED',
  teal: '#0F766E',
  amber: '#B45309',
  coral: '#FF6B6B',
  slate: '#475569',
  red: '#ef4444',
  green: '#059669',
  border: '#e2e8f0',
};

const GRADIENT = `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`;
const GRADIENT_GREEN = `linear-gradient(135deg, ${COLORS.emeraldGreen} 0%, ${COLORS.lightGreen} 100%)`;
const GRADIENT_VIOLET = `linear-gradient(135deg, ${COLORS.violet} 0%, ${COLORS.indigo} 100%)`;

// ── Animation Variants ────────────────────────────────────────────────────────
const springPhysics = {
  card: { type: 'spring', stiffness: 280, damping: 22, mass: 0.85 },
  lift: { type: 'spring', stiffness: 320, damping: 24, mass: 0.9 },
  button: { type: 'spring', stiffness: 400, damping: 28 },
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.05 }
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] }
  },
};

const fadeIn = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: 0.3 } },
  exit: { opacity: 0, transition: { duration: 0.2 } },
};

const slideUp = {
  hidden: { opacity: 0, y: 20 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 300, damping: 25 }
  },
};

// ── Status Configuration ──────────────────────────────────────────────────────
const STATUS_CFG = {
  scheduled: {
    label: 'Scheduled',
    color: '#64748b',
    bg: '#F1F5F9',
    border: '#CBD5E1',
    icon: Calendar,
    gradient: 'from-slate-400 to-slate-500'
  },
  in_review: {
    label: 'In Review',
    color: '#1F6FB2',
    bg: '#EFF6FF',
    border: '#BFDBFE',
    icon: Search,
    gradient: 'from-blue-500 to-cyan-500'
  },
  selected: {
    label: 'Selected',
    color: '#7C3AED',
    bg: '#F5F3FF',
    border: '#DDD6FE',
    icon: CheckCircle2,
    gradient: 'from-violet-500 to-purple-500'
  },
  on_hold: {
    label: 'On Hold',
    color: '#F59E0B',
    bg: '#FFFBEB',
    border: '#FDE68A',
    icon: Clock,
    gradient: 'from-amber-500 to-orange-500'
  },
  rejected: {
    label: 'Rejected',
    color: '#EF4444',
    bg: '#FEF2F2',
    border: '#FECACA',
    icon: X,
    gradient: 'from-red-500 to-rose-500'
  },
  hired: {
    label: 'Hired',
    color: '#1FAF5A',
    bg: '#F0FDF4',
    border: '#BBF7D0',
    icon: UserCheck,
    gradient: 'from-emerald-500 to-green-500'
  },
};

const DEPARTMENTS = [
  { value: 'GST', label: 'GST', color: '#1E3A8A', bg: '#EFF6FF' },
  { value: 'IT', label: 'IT', color: '#374151', bg: '#F9FAFB' },
  { value: 'ACC', label: 'ACC', color: '#065F46', bg: '#ECFDF5' },
  { value: 'Legal', label: 'Legal', color: '#7C2D12', bg: '#FFF7ED' },
  { value: 'TDS', label: 'TDS', color: '#1F2937', bg: '#F9FAFB' },
  { value: 'ROC', label: 'ROC', color: '#92400E', bg: '#FFFBEB' },
  { value: 'TM', label: 'TM', color: '#0F766E', bg: '#F0FDFA' },
  { value: 'MSME', label: 'MSME', color: '#334155', bg: '#F8FAFC' },
  { value: 'FEMA', label: 'FEMA', color: '#475569', bg: '#F8FAFC' },
  { value: 'DSC', label: 'DSC', color: '#3F3F46', bg: '#FAFAFA' },
  { value: 'HR', label: 'HR', color: '#BE185D', bg: '#FDF2F8' },
  { value: 'Sales', label: 'Sales', color: '#0369A1', bg: '#F0F9FF' },
  { value: 'Marketing', label: 'Marketing', color: '#7C3AED', bg: '#F5F3FF' },
  { value: 'Operations', label: 'Operations', color: '#059669', bg: '#ECFDF5' },
  { value: 'Other', label: 'Other', color: '#475569', bg: '#F8FAFC' },
];

const DEPARTMENT_ALIASES = {
  accounts: 'ACC', accounting: 'ACC', finance: 'ACC',
  legal: 'Legal', law: 'Legal',
  hr: 'HR', 'human resources': 'HR',
};

function normalizeDepartment(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  const exact = DEPARTMENTS.find(d => d.value.toLowerCase() === trimmed.toLowerCase());
  if (exact) return exact.value;
  return DEPARTMENT_ALIASES[trimmed.toLowerCase()] || trimmed;
}

const EMPTY_CANDIDATE = {
  full_name: '', email: '', phone: '', position: '', department: '',
  experience_years: '', current_company: '', skills: [], education: '',
  interview_date: '', interviewer: '', pay_scale_offered: '', conditions: '',
  training_period: '', status: 'scheduled', notes: '', resume_text: '',
  source: '', expected_salary: '', notice_period: '', rating: null, tags: [],
};

const SOURCES = [
  'Referral', 'LinkedIn', 'Naukri', 'Indeed', 'Walk-in',
  'Campus', 'Job Portal', 'Agency', 'Other',
];

const EMPTY_CONVERT = {
  full_name: '', email: '', password: '', role: 'staff', departments: [],
  phone: '', punch_in_time: '10:30', grace_time: '00:10', punch_out_time: '19:00',
};

// ── Slim Scroll Styles ────────────────────────────────────────────────────────
const slimScroll = {
  overflowY: 'auto',
  scrollbarWidth: 'thin',
  scrollbarColor: '#cbd5e1 transparent',
};

if (typeof document !== 'undefined' && !document.getElementById('recruitment-slim-scroll')) {
  const s = document.createElement('style');
  s.id = 'recruitment-slim-scroll';
  s.textContent = `
    .recruitment-slim::-webkit-scrollbar { width: 3px; }
    .recruitment-slim::-webkit-scrollbar-track { background: transparent; }
    .recruitment-slim::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
    .dark .recruitment-slim::-webkit-scrollbar-thumb { background: #475569; }
    @keyframes pulse-ring {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0.7); }
      70% { transform: scale(1); box-shadow: 0 0 0 10px rgba(79, 70, 229, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(79, 70, 229, 0); }
    }
    @keyframes shimmer {
      0% { background-position: -1000px 0; }
      100% { background-position: 1000px 0; }
    }
    .ai-pulse { animation: pulse-ring 2s cubic-bezier(0.66, 0, 0, 1) infinite; }
    .shimmer {
      background: linear-gradient(90deg, #f0f0f0 0%, #e0e0e0 50%, #f0f0f0 100%);
      background-size: 1000px 100%;
      animation: shimmer 2s infinite linear;
    }
  `;
  document.head.appendChild(s);
}

export default function Recruitment() {
  const { dark } = useDark();
  const { user } = useAuth();
  const [candidates, setCandidates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [stats, setStats] = useState(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState(EMPTY_CANDIDATE);
  const [saving, setSaving] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [praise, setPraise] = useState(null);
  const [praising, setPraising] = useState(false);

  const [convertOpen, setConvertOpen] = useState(false);
  const [convertTarget, setConvertTarget] = useState(null);
  const [convertForm, setConvertForm] = useState(EMPTY_CONVERT);
  const [converting, setConverting] = useState(false);

  const fetchCandidates = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/recruitment');
      setCandidates(res.data || []);
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await api.get('/recruitment/stats');
      setStats(res.data || null);
    } catch {
      // Non-critical — the page still works without the summary strip
    }
  }, []);

  useEffect(() => { fetchCandidates(); fetchStats(); }, [fetchCandidates, fetchStats]);

  const filtered = useMemo(() => {
    let arr = candidates;
    if (statusFilter !== 'all') arr = arr.filter(c => c.status === statusFilter);
    if (sourceFilter !== 'all') arr = arr.filter(c => (c.source || 'Unspecified') === sourceFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      arr = arr.filter(c =>
        (c.full_name || '').toLowerCase().includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.position || '').toLowerCase().includes(q) ||
        (c.department || '').toLowerCase().includes(q)
      );
    }
    return arr;
  }, [candidates, search, statusFilter, sourceFilter]);

  const openAdd = () => {
    setSelected(null);
    setForm(EMPTY_CANDIDATE);
    setPraise(null);
    setDialogOpen(true);
  };

  const openEdit = (c) => {
    setSelected(c);
    setPraise(null);
    setForm({
      ...EMPTY_CANDIDATE, ...c,
      experience_years: c.experience_years ?? '',
      skills: c.skills || [],
      department: normalizeDepartment(c.department),
    });
    setDialogOpen(true);
  };

  const handleResumeUpload = async (file) => {
    if (!file) return;
    setParsing(true);
    setPraise(null);
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await api.post('/recruitment/parse-resume', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const f = res.data.fields || {};
      const resumeText = res.data.resume_text || '';
      setForm(prev => {
        const next = {
          ...prev,
          full_name: (f.full_name && f.full_name.trim()) ? f.full_name.trim() : prev.full_name,
          email: (f.email && f.email.trim()) ? f.email.trim() : prev.email,
          phone: (f.phone && f.phone.trim()) ? f.phone.trim() : prev.phone,
          position: (f.position && f.position.trim()) ? f.position.trim() : prev.position,
          department: (f.department && f.department.trim()) ? normalizeDepartment(f.department) : prev.department,
          experience_years: (f.experience_years != null && f.experience_years !== 0)
            ? String(f.experience_years) : prev.experience_years,
          current_company: (f.current_company && f.current_company.trim()) ? f.current_company.trim() : prev.current_company,
          skills: (Array.isArray(f.skills) && f.skills.length > 0) ? f.skills : prev.skills,
          education: (f.education && f.education.trim()) ? f.education.trim() : prev.education,
          resume_text: resumeText,
        };
        return next;
      });
      const filled = Object.entries(f).filter(([k, v]) =>
        v && (Array.isArray(v) ? v.length > 0 : String(v).trim())
      ).length;
      toast.success(`Resume parsed — ${filled} fields auto-filled`);

      if (resumeText) {
        setPraising(true);
        api.post('/recruitment/praise-resume-json', {
          resume_text: resumeText,
          position: f.position || '',
        }).then(r => {
          setPraise(r.data);
        }).catch(() => {}).finally(() => setPraising(false));
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Could not parse resume');
    } finally {
      setParsing(false);
    }
  };

  const handleSubmit = async () => {
    if (!form.full_name.trim()) {
      toast.error('Full name is required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        experience_years: form.experience_years === '' ? null : Number(form.experience_years),
      };
      if (selected) {
        await api.put(`/recruitment/${selected.id}`, payload);
        toast.success('Candidate updated');
      } else {
        await api.post('/recruitment', payload);
        toast.success('Candidate added');
      }
      setDialogOpen(false);
      fetchCandidates(); fetchStats();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to save candidate');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`Delete candidate record for ${c.full_name}?`)) return;
    try {
      await api.delete(`/recruitment/${c.id}`);
      toast.success('Candidate removed');
      fetchCandidates(); fetchStats();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to delete');
    }
  };

  const openConvert = (c) => {
    setConvertTarget(c);
    setConvertForm({
      ...EMPTY_CONVERT,
      full_name: c.full_name || '',
      email: c.email || '',
      departments: c.department ? [c.department] : [],
      phone: c.phone || '',
    });
    setConvertOpen(true);
  };

  const handleConvert = async () => {
    if (!convertForm.full_name.trim() || !convertForm.email.trim() || !convertForm.password.trim()) {
      toast.error('Name, email and password are required');
      return;
    }
    setConverting(true);
    try {
      await api.post(`/recruitment/${convertTarget.id}/convert-to-user`, convertForm);
      toast.success('Candidate converted to user — pending admin approval');
      setConvertOpen(false);
      fetchCandidates(); fetchStats();
    } catch (err) {
      toast.error(err?.response?.data?.detail || 'Failed to convert candidate');
    } finally {
      setConverting(false);
    }
  };

  const getDeptConfig = (dept) => DEPARTMENTS.find(d => d.value === dept) || { color: '#475569', bg: '#F8FAFC' };

  return (
    <div className={`min-h-full space-y-5 ${dark ? 'bg-slate-950' : 'bg-slate-50'}`}>
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut' }}
        className="relative overflow-hidden rounded-2xl px-6 py-5"
        style={{ background: GRADIENT, boxShadow: '0 8px 32px rgba(13,59,102,0.25)' }}
      >
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-0 right-0 w-64 h-64 bg-white rounded-full blur-3xl transform translate-x-32 -translate-y-32" />
          <div className="absolute bottom-0 left-0 w-96 h-96 bg-white rounded-full blur-3xl transform -translate-x-48 translate-y-48" />
        </div>
        <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <p className="text-white/60 text-xs font-medium uppercase tracking-widest mb-1">HR Module</p>
            <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
              <Briefcase className="w-6 h-6" /> Recruitment
            </h1>
            <p className="text-white/60 text-sm mt-1">Track candidates end-to-end — source, interview, rate, and convert hires into users in one click</p>
          </div>
          <Button
            onClick={openAdd}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold transition-all active:scale-95 shadow-lg"
            style={{ backgroundColor: '#ffffff', color: COLORS.deepBlue }}
          >
            <Plus className="w-4 h-4" /> Add Candidate
          </Button>
        </div>
      </motion.div>

      {/* Pipeline Stats Strip */}
      {stats && (
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3"
        >
          {[
            { label: 'Total Candidates', value: stats.total, icon: Briefcase, color: COLORS.deepBlue },
            { label: 'In Review', value: stats.by_status?.in_review || 0, icon: Search, color: COLORS.mediumBlue },
            { label: 'Selected', value: stats.by_status?.selected || 0, icon: CheckCircle2, color: COLORS.violet },
            { label: 'Hired (Total)', value: stats.by_status?.hired || 0, icon: UserCheck, color: COLORS.emeraldGreen },
            { label: 'Hired This Month', value: stats.hired_this_month || 0, icon: TrendingUp, color: COLORS.teal },
            { label: 'Converted to User', value: stats.converted_to_user || 0, icon: Shield, color: COLORS.amber },
          ].map(card => (
            <motion.div
              key={card.label}
              variants={itemVariants}
              className={`rounded-2xl border p-3.5 flex items-center gap-3 ${dark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}
            >
              <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: `${card.color}18` }}>
                <card.icon className="w-4.5 h-4.5" style={{ color: card.color }} />
              </div>
              <div className="min-w-0">
                <p className={`text-lg font-black leading-none ${dark ? 'text-white' : 'text-slate-800'}`}>{card.value}</p>
                <p className={`text-[10px] font-medium mt-0.5 truncate ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{card.label}</p>
              </div>
            </motion.div>
          ))}
        </motion.div>
      )}

      {/* Search + Filter */}
      <motion.div
        variants={itemVariants}
        initial="hidden"
        animate="visible"
        className={`flex flex-wrap gap-3 items-center rounded-2xl border p-3 ${dark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}
      >
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search candidates, position, department…"
            className={`w-full pl-9 pr-3 py-2 text-sm rounded-xl ${dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`}
          />
        </div>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className={`w-[150px] text-xs ${dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}`}>
            <SelectValue placeholder="Source" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            {SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex gap-1.5 flex-wrap">
          {[{ val: 'all', label: 'All' }, ...Object.entries(STATUS_CFG).map(([val, c]) => ({ val, label: c.label }))].map(f => (
            <motion.button
              key={f.val}
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setStatusFilter(f.val)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all ${
                statusFilter === f.val
                  ? dark ? 'bg-blue-900/30 border-blue-500 text-blue-400' : 'bg-blue-50 border-blue-500 text-blue-600'
                  : dark ? 'bg-slate-800 border-slate-700 text-slate-400' : 'bg-slate-50 border-transparent text-slate-600'
              }`}
            >
              {f.label}
            </motion.button>
          ))}
        </div>
      </motion.div>

      {/* Candidate List */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : filtered.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className={`rounded-2xl border py-16 text-center ${dark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}
        >
          <Briefcase className="w-12 h-12 mx-auto text-slate-400 mb-3" />
          <p className={`font-semibold ${dark ? 'text-slate-300' : 'text-slate-600'}`}>No candidates found</p>
          <p className={`text-sm mt-1 ${dark ? 'text-slate-500' : 'text-slate-400'}`}>Click "Add Candidate" to log a new interview</p>
        </motion.div>
      ) : (
        <motion.div
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
        >
          {filtered.map(c => {
            const st = STATUS_CFG[c.status] || STATUS_CFG.scheduled;
            const dept = getDeptConfig(c.department);
            const StatusIcon = st.icon;
            return (
              <motion.div
                key={c.id}
                variants={itemVariants}
                whileHover={{ y: -4, transition: { duration: 0.2 } }}
                className={`rounded-2xl border p-4 space-y-3 ${dark ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'}`}
                style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.04)' }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className={`font-bold truncate ${dark ? 'text-white' : 'text-slate-800'}`}>{c.full_name}</p>
                    <p className={`text-xs truncate ${dark ? 'text-slate-400' : 'text-slate-500'}`}>{c.position || 'No position specified'}</p>
                  </div>
                  <Badge
                    variant="outline"
                    className="text-[10px] font-bold px-2 py-0.5 rounded-full uppercase flex-shrink-0"
                    style={{ backgroundColor: st.bg, color: st.color, borderColor: st.border }}
                  >
                    <StatusIcon className="w-3 h-3 mr-1" />
                    {st.label}
                  </Badge>
                </div>

                {(c.source || c.rating) && (
                  <div className="flex items-center justify-between gap-2">
                    {c.source && (
                      <Badge variant="outline" className={`text-[10px] font-medium px-1.5 py-0.5 ${dark ? 'bg-slate-800 border-slate-700 text-slate-300' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                        {c.source}
                      </Badge>
                    )}
                    {c.rating && (
                      <div className="flex items-center gap-0.5">
                        {[1, 2, 3, 4, 5].map(n => (
                          <Star
                            key={n}
                            className="w-3 h-3"
                            style={{ color: '#F59E0B' }}
                            fill={n <= c.rating ? '#F59E0B' : 'none'}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-1.5 text-xs">
                  {c.department && (
                    <div className="flex items-center gap-1.5">
                      <Building2 className="w-3.5 h-3.5 text-slate-400" />
                      <span className={dark ? 'text-slate-300' : 'text-slate-600'}>{c.department}</span>
                    </div>
                  )}
                  {c.experience_years != null && (
                    <div className="flex items-center gap-1.5">
                      <GraduationCap className="w-3.5 h-3.5 text-slate-400" />
                      <span className={dark ? 'text-slate-300' : 'text-slate-600'}>{c.experience_years} yrs experience</span>
                    </div>
                  )}
                  {c.pay_scale_offered && (
                    <div className="flex items-center gap-1.5">
                      <IndianRupee className="w-3.5 h-3.5 text-slate-400" />
                      <span className={dark ? 'text-slate-300' : 'text-slate-600'}>{c.pay_scale_offered}</span>
                    </div>
                  )}
                  {!c.pay_scale_offered && c.expected_salary && (
                    <div className="flex items-center gap-1.5">
                      <IndianRupee className="w-3.5 h-3.5 text-slate-400" />
                      <span className={dark ? 'text-slate-300' : 'text-slate-600'}>Expects {c.expected_salary}</span>
                    </div>
                  )}
                  {c.notice_period && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-slate-400" />
                      <span className={dark ? 'text-slate-300' : 'text-slate-600'}>Notice: {c.notice_period}</span>
                    </div>
                  )}
                  {c.email && (
                    <div className="flex items-center gap-1.5 truncate">
                      <Mail className="w-3.5 h-3.5 text-slate-400 flex-shrink-0" />
                      <span className={`truncate ${dark ? 'text-slate-300' : 'text-slate-600'}`}>{c.email}</span>
                    </div>
                  )}
                  {c.phone && (
                    <div className="flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-slate-400" />
                      <span className={dark ? 'text-slate-300' : 'text-slate-600'}>{c.phone}</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEdit(c)}
                    className={`flex-1 flex items-center justify-center gap-1 text-xs font-semibold ${dark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </Button>
                  {!c.converted_user_id && (
                    <Button
                      size="sm"
                      onClick={() => openConvert(c)}
                      className="flex-1 flex items-center justify-center gap-1 text-xs font-bold text-white"
                      style={{ background: GRADIENT }}
                    >
                      <UserCheck className="w-3 h-3" /> Convert
                    </Button>
                  )}
                  {c.converted_user_id && (
                    <span
                      className="flex-1 text-center text-xs font-semibold py-1.5 rounded-lg"
                      style={{ backgroundColor: '#F0FDF4', color: COLORS.emeraldGreen }}
                    >
                      Converted ✓
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(c)}
                    className="p-1.5 rounded-lg text-red-500 hover:bg-red-50 hover:text-red-600"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </motion.div>
            );
          })}
        </motion.div>
      )}

      {/* Add/Edit Modal */}
      <AnimatePresence>
        {dialogOpen && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogContent className={`max-w-2xl max-h-[90vh] flex flex-col overflow-hidden ${dark ? 'bg-slate-900 border-slate-800' : 'bg-white'}`}>
              <DialogHeader className="flex-shrink-0 px-6 py-4 border-b" style={{ background: GRADIENT }}>
                <DialogTitle className="text-white font-bold flex items-center gap-2">
                  {selected ? <Pencil className="w-5 h-5" /> : <Plus className="w-5 h-5" />}
                  {selected ? 'Edit Candidate' : 'Add Candidate'}
                </DialogTitle>
                <DialogDescription className="text-white/70 text-sm">
                  {selected ? 'Update candidate information' : 'Upload a resume to auto-fill the form or enter details manually'}
                </DialogDescription>
              </DialogHeader>

              <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4 recruitment-slim" style={slimScroll}>
                {/* Resume Upload */}
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`relative border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
                    parsing
                      ? dark ? 'border-violet-500 bg-violet-900/20' : 'border-violet-400 bg-violet-50'
                      : dark ? 'border-slate-700 hover:border-violet-500 hover:bg-slate-800' : 'border-slate-300 hover:border-violet-400 hover:bg-violet-50'
                  }`}
                >
                  <input
                    type="file"
                    accept=".pdf,.docx,.txt"
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                    onChange={e => handleResumeUpload(e.target.files?.[0])}
                    disabled={parsing}
                  />
                  {parsing ? (
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin text-violet-500" />
                      <span className={`text-sm font-medium ${dark ? 'text-violet-300' : 'text-violet-600'}`}>Parsing resume with AI…</span>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-2">
                      <Upload className={`w-4 h-4 ${dark ? 'text-slate-400' : 'text-slate-500'}`} />
                      <span className={`text-sm ${dark ? 'text-slate-300' : 'text-slate-600'}`}>
                        Upload resume (PDF / DOCX / TXT) to auto-fill the form
                      </span>
                    </div>
                  )}
                </motion.div>

                {/* AI Resume Assessment Panel */}
                <AnimatePresence>
                  {(praising || praise) && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      className="overflow-hidden"
                    >
                      <div className={`rounded-xl border overflow-hidden ${dark ? 'border-slate-800' : 'border-slate-200'}`} style={{ boxShadow: '0 4px 20px rgba(79, 70, 229, 0.1)' }}>
                        {/* AI Header */}
                        <div className="px-4 py-3 flex items-center justify-between" style={{ background: GRADIENT_VIOLET }}>
                          <div className="flex items-center gap-2">
                            <div className="relative">
                              <Brain className="w-5 h-5 text-white" />
                              {praising && (
                                <div className="absolute inset-0 ai-pulse rounded-full" />
                              )}
                            </div>
                            <span className="text-white text-sm font-bold">AI Resume Assessment</span>
                            {praising && (
                              <Badge variant="outline" className="text-[10px] bg-white/20 border-white/30 text-white">
                                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                                Analysing
                              </Badge>
                            )}
                          </div>
                          {praise && !praising && praise.verdict && (
                            <Badge
                              variant="outline"
                              className="text-xs font-bold px-2 py-0.5 rounded-full"
                              style={{
                                backgroundColor: praise.verdict === 'Strong Hire' ? '#F0FDF4' : praise.verdict === 'Hire' ? '#EFF6FF' : praise.verdict === 'Maybe' ? '#FFFBEB' : '#FEF2F2',
                                color: praise.verdict === 'Strong Hire' ? '#1FAF5A' : praise.verdict === 'Hire' ? '#1F6FB2' : praise.verdict === 'Maybe' ? '#F59E0B' : '#EF4444',
                                borderColor: praise.verdict === 'Strong Hire' ? '#BBF7D0' : praise.verdict === 'Hire' ? '#BFDBFE' : praise.verdict === 'Maybe' ? '#FDE68A' : '#FECACA',
                              }}
                            >
                              {praise.verdict}
                            </Badge>
                          )}
                        </div>

                        {/* AI Content */}
                        {praising && !praise && (
                          <div className={`px-4 py-8 flex flex-col items-center gap-3 ${dark ? 'bg-slate-800' : 'bg-slate-50'}`}>
                            <div className="relative">
                              <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
                              <div className="absolute inset-0 ai-pulse rounded-full" />
                            </div>
                            <p className={`text-sm font-medium ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Evaluating candidate profile…</p>
                          </div>
                        )}

                        {praise && (
                          <div className={`px-4 py-4 space-y-4 ${dark ? 'bg-slate-900' : 'bg-white'}`}>
                            {/* Score & Summary Row */}
                            <div className="flex items-start gap-4">
                              {/* Circular Score */}
                              <div className="relative flex-shrink-0 w-16 h-16">
                                <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                                  <circle cx="18" cy="18" r="15.9" fill="none" stroke={dark ? '#334155' : '#f1f5f9'} strokeWidth="3" />
                                  <circle
                                    cx="18" cy="18" r="15.9" fill="none"
                                    stroke={praise.fit_score >= 75 ? '#1FAF5A' : praise.fit_score >= 50 ? '#1F6FB2' : praise.fit_score >= 35 ? '#F59E0B' : '#EF4444'}
                                    strokeWidth="3"
                                    strokeDasharray={`${praise.fit_score} ${100 - praise.fit_score}`}
                                    strokeLinecap="round"
                                  />
                                </svg>
                                <div className="absolute inset-0 flex flex-col items-center justify-center">
                                  <span className="text-lg font-black leading-none" style={{ color: praise.fit_score >= 75 ? '#1FAF5A' : praise.fit_score >= 50 ? '#1F6FB2' : praise.fit_score >= 35 ? '#F59E0B' : '#EF4444' }}>
                                    {praise.fit_score}
                                  </span>
                                  <span className={`text-[8px] font-medium ${dark ? 'text-slate-500' : 'text-slate-400'}`}>/100</span>
                                </div>
                              </div>

                              {/* Summary & Skills */}
                              <div className="flex-1 min-w-0">
                                <p className={`text-sm font-semibold leading-snug mb-2 ${dark ? 'text-slate-200' : 'text-slate-700'}`}>
                                  {praise.summary}
                                </p>
                                {praise.standout_skills && praise.standout_skills.length > 0 && (
                                  <div className="flex flex-wrap gap-1">
                                    {praise.standout_skills.map(s => (
                                      <Badge key={s} variant="outline" className="text-[10px] font-medium px-1.5 py-0.5" style={{
                                        backgroundColor: dark ? '#1E3A8A' : '#EFF6FF',
                                        color: dark ? '#93C5FD' : '#1F6FB2',
                                        borderColor: dark ? '#1E40AF' : '#BFDBFE',
                                      }}>
                                        {s}
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* Experience Badge */}
                              <div className="flex-shrink-0 text-center">
                                <div className={`text-[10px] mb-1 ${dark ? 'text-slate-500' : 'text-slate-500'}`}>Experience</div>
                                <Badge
                                  variant="outline"
                                  className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                                  style={{
                                    backgroundColor: praise.experience_quality === 'Excellent' ? '#F0FDF4' : praise.experience_quality === 'Good' ? '#EFF6FF' : praise.experience_quality === 'Average' ? '#FFFBEB' : '#FEF2F2',
                                    color: praise.experience_quality === 'Excellent' ? '#1FAF5A' : praise.experience_quality === 'Good' ? '#1F6FB2' : praise.experience_quality === 'Average' ? '#F59E0B' : '#EF4444',
                                    borderColor: praise.experience_quality === 'Excellent' ? '#BBF7D0' : praise.experience_quality === 'Good' ? '#BFDBFE' : praise.experience_quality === 'Average' ? '#FDE68A' : '#FECACA',
                                  }}
                                >
                                  {praise.experience_quality}
                                </Badge>
                              </div>
                            </div>

                            {/* Strengths & Concerns */}
                            <div className="grid grid-cols-2 gap-3">
                              {/* Strengths */}
                              {praise.strengths && praise.strengths.length > 0 && (
                                <div className={`rounded-lg p-3 ${dark ? 'bg-emerald-900/20 border border-emerald-800' : 'bg-emerald-50 border border-emerald-200'}`}>
                                  <div className="flex items-center gap-1.5 mb-2">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                    <p className={`text-[10px] font-bold uppercase tracking-wider ${dark ? 'text-emerald-400' : 'text-emerald-700'}`}>Strengths</p>
                                  </div>
                                  <ul className="space-y-1.5">
                                    {praise.strengths.map((s, i) => (
                                      <li key={i} className={`text-[11px] leading-snug flex gap-1.5 ${dark ? 'text-slate-300' : 'text-slate-700'}`}>
                                        <span className="text-emerald-500 flex-shrink-0 mt-px">•</span>
                                        <span>{s}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Concerns */}
                              <div className={`rounded-lg p-3 ${
                                praise.concerns && praise.concerns.length > 0
                                  ? dark ? 'bg-red-900/20 border border-red-800' : 'bg-red-50 border border-red-200'
                                  : dark ? 'bg-slate-800 border border-slate-700' : 'bg-slate-50 border border-slate-200'
                              }`}>
                                <div className="flex items-center gap-1.5 mb-2">
                                  {praise.concerns && praise.concerns.length > 0 ? (
                                    <>
                                      <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                                      <p className={`text-[10px] font-bold uppercase tracking-wider ${dark ? 'text-red-400' : 'text-red-700'}`}>Concerns</p>
                                    </>
                                  ) : (
                                    <>
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                                      <p className={`text-[10px] font-bold uppercase tracking-wider ${dark ? 'text-emerald-400' : 'text-emerald-700'}`}>No Concerns</p>
                                    </>
                                  )}
                                </div>
                                {praise.concerns && praise.concerns.length > 0 ? (
                                  <ul className="space-y-1.5">
                                    {praise.concerns.map((c, i) => (
                                      <li key={i} className={`text-[11px] leading-snug flex gap-1.5 ${dark ? 'text-slate-300' : 'text-slate-700'}`}>
                                        <span className="text-red-400 flex-shrink-0 mt-px">•</span>
                                        <span>{c}</span>
                                      </li>
                                    ))}
                                  </ul>
                                ) : (
                                  <p className={`text-[11px] ${dark ? 'text-slate-500' : 'text-slate-400'}`}>Candidate looks good across all areas.</p>
                                )}
                              </div>
                            </div>

                            {/* Recommended Questions */}
                            {praise.recommended_questions && praise.recommended_questions.length > 0 && (
                              <div className={`rounded-lg p-3 ${dark ? 'bg-violet-900/20 border border-violet-800' : 'bg-violet-50 border border-violet-200'}`}>
                                <div className="flex items-center gap-1.5 mb-2">
                                  <MessageSquare className="w-3.5 h-3.5 text-violet-500" />
                                  <p className={`text-[10px] font-bold uppercase tracking-wider ${dark ? 'text-violet-400' : 'text-violet-700'}`}>Suggested Interview Questions</p>
                                </div>
                                <ol className="space-y-1.5">
                                  {praise.recommended_questions.map((q, i) => (
                                    <li key={i} className={`text-[11px] leading-snug flex gap-2 ${dark ? 'text-slate-300' : 'text-slate-700'}`}>
                                      <span className={`font-bold flex-shrink-0 ${dark ? 'text-violet-400' : 'text-violet-500'}`}>{i + 1}.</span>
                                      <span>{q}</span>
                                    </li>
                                  ))}
                                </ol>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Form Fields */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Full Name *</Label>
                    <Input
                      value={form.full_name}
                      onChange={e => setForm(p => ({ ...p, full_name: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Email</Label>
                    <Input
                      type="email"
                      value={form.email}
                      onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Phone</Label>
                    <Input
                      value={form.phone}
                      onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Position Applied For</Label>
                    <Input
                      value={form.position}
                      onChange={e => setForm(p => ({ ...p, position: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Department</Label>
                    <Select value={form.department} onValueChange={v => setForm(p => ({ ...p, department: v }))}>
                      <SelectTrigger className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}>
                        <SelectValue placeholder="Select department" />
                      </SelectTrigger>
                      <SelectContent>
                        {DEPARTMENTS.map(d => (
                          <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Experience (years)</Label>
                    <Input
                      type="number"
                      value={form.experience_years}
                      onChange={e => setForm(p => ({ ...p, experience_years: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Current / Last Company</Label>
                    <Input
                      value={form.current_company}
                      onChange={e => setForm(p => ({ ...p, current_company: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Education</Label>
                    <Input
                      value={form.education}
                      onChange={e => setForm(p => ({ ...p, education: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Source</Label>
                    <Select value={form.source} onValueChange={v => setForm(p => ({ ...p, source: v }))}>
                      <SelectTrigger className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}>
                        <SelectValue placeholder="Where did they come from?" />
                      </SelectTrigger>
                      <SelectContent>
                        {SOURCES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Recruiter Rating</Label>
                    <div className="flex items-center gap-1 h-9">
                      {[1, 2, 3, 4, 5].map(n => (
                        <button
                          key={n}
                          type="button"
                          onClick={() => setForm(p => ({ ...p, rating: p.rating === n ? null : n }))}
                          className="p-0.5"
                        >
                          <Star
                            className="w-5 h-5 transition-colors"
                            style={{ color: '#F59E0B' }}
                            fill={form.rating && n <= form.rating ? '#F59E0B' : 'none'}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Expected Salary</Label>
                    <Input
                      value={form.expected_salary}
                      onChange={e => setForm(p => ({ ...p, expected_salary: e.target.value }))}
                      placeholder="e.g. ₹35,000 / month"
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Notice Period</Label>
                    <Input
                      value={form.notice_period}
                      onChange={e => setForm(p => ({ ...p, notice_period: e.target.value }))}
                      placeholder="e.g. 30 days"
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Interview Date</Label>
                    <Input
                      type="date"
                      value={form.interview_date}
                      onChange={e => setForm(p => ({ ...p, interview_date: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Interviewer</Label>
                    <Input
                      value={form.interviewer}
                      onChange={e => setForm(p => ({ ...p, interviewer: e.target.value }))}
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Pay Scale Offered</Label>
                    <Input
                      value={form.pay_scale_offered}
                      onChange={e => setForm(p => ({ ...p, pay_scale_offered: e.target.value }))}
                      placeholder="e.g. ₹25,000 – ₹30,000 / month"
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Training Period</Label>
                    <Input
                      value={form.training_period}
                      onChange={e => setForm(p => ({ ...p, training_period: e.target.value }))}
                      placeholder="e.g. 3 months"
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div>
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Status</Label>
                    <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                      <SelectTrigger className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(STATUS_CFG).map(([k, v]) => (
                          <SelectItem key={k} value={k}>{v.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-2">
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Skills (comma separated)</Label>
                    <Input
                      value={(form.skills || []).join(', ')}
                      onChange={e => setForm(p => ({ ...p, skills: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                      placeholder="e.g. React, Node.js, Python"
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                  <div className="col-span-2">
                    <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Tags (comma separated)</Label>
                    <Input
                      value={(form.tags || []).join(', ')}
                      onChange={e => setForm(p => ({ ...p, tags: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
                      placeholder="e.g. urgent, referral-bonus-eligible"
                      className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                    />
                  </div>
                </div>

                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Conditions of Offer</Label>
                  <Textarea
                    value={form.conditions}
                    onChange={e => setForm(p => ({ ...p, conditions: e.target.value }))}
                    rows={2}
                    className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                  />
                </div>

                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Notes</Label>
                  <Textarea
                    value={form.notes}
                    onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                    rows={2}
                    className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                  />
                </div>
              </div>

              <DialogFooter className="flex-shrink-0 px-6 py-4 border-t">
                <Button variant="outline" onClick={() => setDialogOpen(false)} className={dark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : ''}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit} disabled={saving} style={{ background: GRADIENT }} className="text-white font-bold">
                  {saving ? 'Saving…' : selected ? 'Save Changes' : 'Add Candidate'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>

      {/* Convert to User Modal */}
      <AnimatePresence>
        {convertOpen && (
          <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
            <DialogContent className={`max-w-lg ${dark ? 'bg-slate-900 border-slate-800' : 'bg-white'}`}>
              <DialogHeader className="px-6 py-4 border-b" style={{ background: GRADIENT }}>
                <DialogTitle className="text-white font-bold flex items-center gap-2">
                  <UserCheck className="w-5 h-5" /> Convert to User
                </DialogTitle>
                <DialogDescription className="text-white/80 text-sm">
                  All fields below are editable — review before creating the account
                </DialogDescription>
              </DialogHeader>
              <div className="px-6 py-5 space-y-3">
                <p className={`text-xs -mt-1 mb-2 ${dark ? 'text-slate-400' : 'text-slate-500'}`}>
                  The new user will need admin approval to log in.
                </p>
                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Full Name *</Label>
                  <Input
                    value={convertForm.full_name}
                    onChange={e => setConvertForm(p => ({ ...p, full_name: e.target.value }))}
                    className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                  />
                </div>
                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Email *</Label>
                  <Input
                    type="email"
                    value={convertForm.email}
                    onChange={e => setConvertForm(p => ({ ...p, email: e.target.value }))}
                    className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                  />
                </div>
                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Temporary Password *</Label>
                  <Input
                    type="password"
                    value={convertForm.password}
                    onChange={e => setConvertForm(p => ({ ...p, password: e.target.value }))}
                    className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                  />
                </div>
                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Phone</Label>
                  <Input
                    value={convertForm.phone}
                    onChange={e => setConvertForm(p => ({ ...p, phone: e.target.value }))}
                    className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}
                  />
                </div>
                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Role</Label>
                  <Select value={convertForm.role} onValueChange={v => setConvertForm(p => ({ ...p, role: v }))}>
                    <SelectTrigger className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="staff">Staff</SelectItem>
                      <SelectItem value="manager">Manager</SelectItem>
                      {user?.role === 'admin' && <SelectItem value="admin">Admin</SelectItem>}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className={`text-xs font-semibold mb-1.5 ${dark ? 'text-slate-300' : 'text-slate-600'}`}>Department</Label>
                  <Select
                    value={(convertForm.departments || [])[0] || ''}
                    onValueChange={v => setConvertForm(p => ({ ...p, departments: v ? [v] : [] }))}
                  >
                    <SelectTrigger className={dark ? 'bg-slate-800 border-slate-700 text-white' : 'bg-white border-slate-200'}>
                      <SelectValue placeholder="Select department" />
                    </SelectTrigger>
                    <SelectContent>
                      {DEPARTMENTS.map(d => (
                        <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <DialogFooter className="px-6 py-4 border-t">
                <Button variant="outline" onClick={() => setConvertOpen(false)} className={dark ? 'border-slate-700 text-slate-300 hover:bg-slate-800' : ''}>
                  Cancel
                </Button>
                <Button onClick={handleConvert} disabled={converting} style={{ background: GRADIENT_GREEN }} className="text-white font-bold">
                  {converting ? 'Creating…' : 'Create User Account'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>
    </div>
  );
}
