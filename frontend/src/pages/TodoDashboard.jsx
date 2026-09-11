import { useDark } from '@/hooks/useDark';
import LayoutCustomizer from '@/components/layout/LayoutCustomizer';
import { usePageLayout } from '@/hooks/usePageLayout';
import GifLoader, { MiniLoader } from '@/components/ui/GifLoader.jsx';
import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import api from '@/lib/api';
import { motion, AnimatePresence } from 'framer-motion';
import { format, isPast, parseISO, isToday, isTomorrow } from 'date-fns';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Plus, Zap, Trash2, CheckCircle2, Sparkles, ShieldCheck,
  GripVertical, Settings2,
  RefreshCw, Target, TrendingUp, AlertCircle,
  Calendar as CalendarIcon, History, Users, Search, X,
  User as UserIcon, Activity, Layers, CheckSquare, Circle,
  ChevronRight, Briefcase, Clock, FileText, Tag, ArrowUpRight,
  ArrowRight, Building2, List, LayoutGrid, Loader2,
  } from 'lucide-react';
import { detectTodoDuplicates } from '@/lib/aiDuplicateEngine';
import AIDuplicateDialog from '@/components/ui/AIDuplicateDialog';

// ── Brand Colors ──────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  lightGreen:   '#5CCB5F',
  coral:        '#FF6B6B',
  amber:        '#F59E0B',
};

// ── Departments (mirrors Tasks.jsx) ──────────────────────────────────────────
const DEPARTMENTS = [
  { value: 'gst',          label: 'GST' },
  { value: 'income_tax',   label: 'INCOME TAX' },
  { value: 'accounts',     label: 'ACCOUNTS' },
  { value: 'tds',          label: 'TDS' },
  { value: 'roc',          label: 'ROC' },
  { value: 'trademark',    label: 'TRADEMARK' },
  { value: 'msme_smadhan', label: 'MSME SMADHAN' },
  { value: 'fema',         label: 'FEMA' },
  { value: 'dsc',          label: 'DSC' },
  { value: 'other',        label: 'OTHER' },
];

// ── Spring Physics ─────────────────────────────────────────────────────────────
const springPhysics = {
  card:   { type: 'spring', stiffness: 280, damping: 22, mass: 0.85 },
  lift:   { type: 'spring', stiffness: 320, damping: 24, mass: 0.9  },
  button: { type: 'spring', stiffness: 400, damping: 28 },
  icon:   { type: 'spring', stiffness: 450, damping: 25 },
  tap:    { type: 'spring', stiffness: 500, damping: 30 },
};

// ── Animation Variants ─────────────────────────────────────────────────────────
const containerVariants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};

const itemVariants = {
  hidden:  { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] } },
  exit:    { opacity: 0, y: 12, transition: { duration: 0.3 } },
};

const rowVariant = {
  hidden:  { opacity: 0, x: -10 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] } },
  exit:    { opacity: 0, x: 10, transition: { duration: 0.18 } },
};

// ── Slim scroll injection ─────────────────────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('todo-slim-scroll')) {
  const s = document.createElement('style');
  s.id = 'todo-slim-scroll';
  s.textContent = `
    .todo-slim::-webkit-scrollbar { width: 3px; }
    .todo-slim::-webkit-scrollbar-track { background: transparent; }
    .todo-slim::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 99px; }
    .todo-slim::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
    .dark .todo-slim::-webkit-scrollbar-thumb { background: #475569; }
  `;
  document.head.appendChild(s);
}

// ── DUE LABEL HELPER ──────────────────────────────────────────────────────────
const getDueLabel = (due_date) => {
  if (!due_date) return null;
  try {
    const d = parseISO(due_date);
    if (isToday(d))    return { label: 'Today',    color: COLORS.amber  };
    if (isTomorrow(d)) return { label: 'Tomorrow', color: '#1F6FB2'     };
    if (isPast(d))     return { label: 'Overdue',  color: COLORS.coral  };
    return { label: format(d, 'MMM d'), color: '#94A3B8' };
  } catch { return null; }
};

// ── STRIPE COLOR HELPER ───────────────────────────────────────────────────────
const getTodoStripeColor = (todo) => {
  const isCompleted = todo.is_completed === true || todo.status === 'completed';
  if (isCompleted) return 'bg-blue-600';
  if (!todo.due_date) return 'bg-slate-300';
  try { if (isPast(parseISO(todo.due_date))) return 'bg-red-700'; } catch {}
  return 'bg-emerald-500';
};

// ── SOURCE BADGE HELPER ───────────────────────────────────────────────────────
const getTodoSource = (todo) => {
  if (todo.source === 'email_sync' || todo.auto_imported || 
      (todo.description && todo.description.includes('Auto-imported from email'))) {
    return 'synced';
  }
  return 'manual';
};

const SourceBadge = ({ todo, compact = false }) => {
  const source = getTodoSource(todo);
  if (source === 'synced') {
    return (
      <span className={`inline-flex items-center gap-0.5 font-bold rounded-md leading-none ${
        compact 
          ? 'text-[7px] px-1 py-px bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400'
          : 'text-[9px] px-1.5 py-0.5 bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-400'
      }`}>
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
          <polyline points="17 8 12 3 7 8"/>
          <line x1="12" y1="3" x2="12" y2="15"/>
        </svg>
        {compact ? 'SYNC' : 'AUTO-SYNC'}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center gap-0.5 font-bold rounded-md ${
      compact
        ? 'text-[8px] px-1 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
        : 'text-[9px] px-1.5 py-0.5 bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400'
    }`}>
      <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
      {compact ? 'MAN' : 'MANUAL'}
    </span>
  );
};

// ── SECTION CARD ──────────────────────────────────────────────────────────────
function SectionCard({ children, className = '' }) {
  return (
    <div className={`bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm ${className}`}>
      {children}
    </div>
  );
}

// ── CARD HEADER ROW ───────────────────────────────────────────────────────────
function CardHeaderRow({ iconBg, icon, title, subtitle, action }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
      <div className="flex items-center gap-2.5">
        <div className={`p-1.5 rounded-lg ${iconBg}`}>{icon}</div>
        <div>
          <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
          <p className="text-xs text-slate-400 dark:text-slate-500">{subtitle}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

// ── METRIC CARD ───────────────────────────────────────────────────────────────
function MetricCard({ icon: Icon, label, value, sub, accent, progress, onClick }) {
  return (
    <motion.div
      whileHover={{ y: -3, transition: springPhysics.card }}
      whileTap={{ scale: 0.985 }}
      onClick={onClick}
      className="rounded-2xl shadow-sm hover:shadow-lg transition-all cursor-pointer group border bg-white dark:bg-slate-800 border-slate-200/80 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600"
    >
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-400">{label}</p>
            <p className="text-2xl font-bold mt-1 tracking-tight" style={{ color: accent }}>{value}</p>
            {sub && <p className="text-[10px] mt-0.5 text-slate-400 dark:text-slate-500">{sub}</p>}
          </div>
          <div className="p-2 rounded-xl group-hover:scale-110 transition-transform" style={{ backgroundColor: `${accent}18` }}>
            <Icon className="h-4 w-4" style={{ color: accent }} />
          </div>
        </div>
        {progress !== undefined && (
          <div className="mt-2.5 h-1.5 rounded-full overflow-hidden bg-slate-100 dark:bg-slate-700">
            <motion.div
              className="h-full rounded-full transition-all duration-700"
              style={{ background: `linear-gradient(90deg, ${accent}, ${accent}bb)` }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(progress, 100)}%` }}
              transition={{ duration: 0.9, ease: 'easeOut', delay: 0.2 }}
            />
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── PROMOTE TO TASK MODAL ─────────────────────────────────────────────────────
function PromoteToTaskModal({ todo, isDark, onClose, onConfirm, isLoading, allUsers, allClients }) {
  const [form, setForm] = useState({
    title:               todo?.title || '',
    description:         todo?.description || '',
    assigned_to:         'unassigned',
    sub_assignees:       [],
    due_date:            todo?.due_date ? format(new Date(todo.due_date), 'yyyy-MM-dd') : '',
    priority:            'medium',
    status:              'pending',
    category:            'other',
    client_id:           '',
    is_recurring:        false,
    recurrence_pattern:  'monthly',
    recurrence_interval: 1,
  });

  if (!todo) return null;

  const set = (key, val) => setForm(prev => ({ ...prev, [key]: val }));

  const handleSubmit = (e) => {
    e.preventDefault();
    onConfirm(todo.id || todo._id, {
      ...form,
      assigned_to:   form.assigned_to === 'unassigned' ? null : form.assigned_to,
      client_id:     form.client_id || null,
      due_date: form.due_date ? `${form.due_date}T00:00:00.000Z` : null,
      sub_assignees: form.sub_assignees || [],
    });
  };

  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(7,15,30,0.78)', backdropFilter: 'blur(10px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className={`w-full max-w-2xl rounded-3xl overflow-hidden shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'}`}
        initial={{ scale: 0.88, y: 40 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.88, y: 40 }}
        transition={{ type: 'spring', stiffness: 200, damping: 22 }}
        onClick={e => e.stopPropagation()}
        style={{ maxHeight: '92vh', overflowY: 'auto' }}
      >
        {/* Header */}
        <div
          className="relative px-6 py-5 overflow-hidden"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, #1a5fa8 100%)` }}
        >
          <div className="absolute right-0 top-0 w-48 h-48 rounded-full -mr-12 -mt-12 opacity-10"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-white/20 rounded-2xl flex items-center justify-center flex-shrink-0">
                <Zap className="w-5 h-5 text-amber-300" />
              </div>
              <div>
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest mb-0.5">
                  Promote Todo → Master Task
                </p>
                <h2 className="text-lg font-bold text-white leading-tight pr-8">
                  Fill Task Details
                </h2>
                <p className="text-white/50 text-xs mt-0.5 pr-8 line-clamp-1">
                  From: {todo.title}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 bg-white/20 hover:bg-white/30 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">

          {/* Title */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Task Title <span className="text-red-500">*</span>
            </Label>
            <input
              type="text"
              value={form.title}
              onChange={e => set('title', e.target.value)}
              required
              placeholder="Task title…"
              className={`w-full h-10 rounded-xl border px-3 text-sm font-medium outline-none transition-all
                focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                ${isDark
                  ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500'
                  : 'bg-slate-50 border-slate-200 text-slate-800 placeholder:text-slate-400'}`}
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Description / Notes
            </Label>
            <textarea
              value={form.description}
              onChange={e => set('description', e.target.value)}
              rows={3}
              placeholder="Task details, checklist items (use - bullet for checklist)…"
              className={`w-full rounded-xl border px-3 py-2.5 text-sm resize-none outline-none transition-all
                focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                ${isDark
                  ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500'
                  : 'bg-slate-50 border-slate-200 text-slate-800 placeholder:text-slate-400'}`}
            />
          </div>

          {/* Due Date + Client */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Due Date
              </Label>
              <input
                type="date"
                value={form.due_date}
                onChange={e => set('due_date', e.target.value)}
                className={`w-full h-10 rounded-xl border px-3 text-sm outline-none transition-all
                  focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                  ${isDark
                    ? 'bg-slate-800 border-slate-600 text-slate-100'
                    : 'bg-slate-50 border-slate-200 text-slate-800'}`}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Client
              </Label>
              <select
                value={form.client_id || ''}
                onChange={e => set('client_id', e.target.value)}
                className={`w-full h-10 rounded-xl border px-3 text-sm outline-none transition-all
                  focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                  ${isDark
                    ? 'bg-slate-800 border-slate-600 text-slate-100'
                    : 'bg-slate-50 border-slate-200 text-slate-800'}`}
              >
                <option value="">No Client</option>
                {(allClients || []).map(c => (
                  <option key={c.id || c._id} value={c.id || c._id}>{c.company_name}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Assignee */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Assign To
            </Label>
            <select
              value={form.assigned_to}
              onChange={e => set('assigned_to', e.target.value)}
              className={`w-full h-10 rounded-xl border px-3 text-sm outline-none transition-all
                focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                ${isDark
                  ? 'bg-slate-800 border-slate-600 text-slate-100'
                  : 'bg-slate-50 border-slate-200 text-slate-800'}`}
            >
              <option value="unassigned">Unassigned</option>
              {(allUsers || []).map(u => (
                <option key={u.id || u._id} value={u.id || u._id}>
                  {u.full_name || u.user_name}
                </option>
              ))}
            </select>
          </div>

          {/* Priority + Status */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Priority
              </Label>
              <select
                value={form.priority}
                onChange={e => set('priority', e.target.value)}
                className={`w-full h-10 rounded-xl border px-3 text-sm outline-none transition-all
                  focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                  ${isDark
                    ? 'bg-slate-800 border-slate-600 text-slate-100'
                    : 'bg-slate-50 border-slate-200 text-slate-800'}`}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                Status
              </Label>
              <select
                value={form.status}
                onChange={e => set('status', e.target.value)}
                className={`w-full h-10 rounded-xl border px-3 text-sm outline-none transition-all
                  focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40
                  ${isDark
                    ? 'bg-slate-800 border-slate-600 text-slate-100'
                    : 'bg-slate-50 border-slate-200 text-slate-800'}`}
              >
                <option value="pending">To Do</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>

          {/* Department */}
          <div className="space-y-2">
            <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
              Department
            </Label>
            <div className="flex flex-wrap gap-1.5">
              {DEPARTMENTS.map(dept => (
                <button
                  key={dept.value}
                  type="button"
                  onClick={() => set('category', dept.value)}
                  className={`h-7 px-3 rounded-lg text-[11px] font-semibold transition-all
                    ${form.category === dept.value
                      ? 'bg-blue-700 text-white shadow-sm'
                      : isDark
                        ? 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                >
                  {dept.label}
                </button>
              ))}
            </div>
          </div>

          {/* Recurring toggle */}
          <div className={`border rounded-xl p-4 space-y-3 ${isDark ? 'border-slate-700 bg-slate-800/40' : 'border-slate-200 bg-slate-50'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4 text-slate-400" />
                <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Recurring Task</span>
              </div>
              <button
                type="button"
                onClick={() => set('is_recurring', !form.is_recurring)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none
                  ${form.is_recurring ? 'bg-blue-600' : isDark ? 'bg-slate-600' : 'bg-slate-200'}`}
              >
                <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform
                  ${form.is_recurring ? 'translate-x-4' : 'translate-x-1'}`} />
              </button>
            </div>
            {form.is_recurring && (
              <div className={`grid grid-cols-2 gap-3 pt-3 border-t ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Repeat</Label>
                  <select
                    value={form.recurrence_pattern}
                    onChange={e => set('recurrence_pattern', e.target.value)}
                    className={`w-full h-9 rounded-xl border px-3 text-sm outline-none transition-all
                      ${isDark
                        ? 'bg-slate-800 border-slate-600 text-slate-100'
                        : 'bg-white border-slate-200 text-slate-800'}`}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Every (interval)</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="365"
                      value={form.recurrence_interval}
                      onChange={e => set('recurrence_interval', parseInt(e.target.value) || 1)}
                      className={`w-20 h-9 rounded-xl border px-3 text-sm outline-none transition-all
                        ${isDark
                          ? 'bg-slate-800 border-slate-600 text-slate-100'
                          : 'bg-white border-slate-200 text-slate-800'}`}
                    />
                    <span className="text-xs text-slate-400">
                      {form.recurrence_pattern === 'daily'   && 'day(s)'}
                      {form.recurrence_pattern === 'weekly'  && 'week(s)'}
                      {form.recurrence_pattern === 'monthly' && 'month(s)'}
                      {form.recurrence_pattern === 'yearly'  && 'year(s)'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Actions */}
          <div className={`flex items-center justify-between gap-3 pt-4 border-t ${isDark ? 'border-slate-700' : 'border-slate-200'}`}>
            <button
              type="button"
              onClick={onClose}
              className={`px-4 py-2.5 text-sm font-semibold rounded-xl border transition-all
                ${isDark
                  ? 'border-slate-600 text-slate-300 hover:bg-slate-700'
                  : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!form.title.trim() || isLoading}
              className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-xl text-white transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
            >
              {isLoading ? (
                <><RefreshCw size={14} className="animate-spin" /> Promoting…</>
              ) : (
                <><Zap size={14} className="text-amber-300" /> Promote to Task</>
              )}
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

// ── TODO DETAIL MODAL ─────────────────────────────────────────────────────────
function TodoDetailModal({ todo, isDark, onClose, onToggle, onPromote, onDelete, ownerName }) {
  if (!todo) return null;
  const isCompleted = todo.is_completed === true || todo.status === 'completed';
  const due         = getDueLabel(todo.due_date);
  const isOverdue   = due?.label === 'Overdue';

  const safeFormat = (dt) => {
    if (!dt) return '—';
    try { return format(new Date(dt), 'MMM d, yyyy · h:mm a'); } catch { return '—'; }
  };

  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: 'rgba(7,15,30,0.72)', backdropFilter: 'blur(8px)' }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className={`w-full max-w-md rounded-3xl overflow-hidden shadow-2xl ${isDark ? 'bg-slate-900' : 'bg-white'}`}
        initial={{ scale: 0.9, y: 32 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.9, y: 32 }}
        transition={{ type: 'spring', stiffness: 200, damping: 22 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="relative px-6 py-5 overflow-hidden"
          style={{
            background: isOverdue && !isCompleted
              ? `linear-gradient(135deg, #B91C1C, #EF4444)`
              : isCompleted
              ? `linear-gradient(135deg, ${COLORS.emeraldGreen}, ${COLORS.lightGreen})`
              : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})`,
          }}
        >
          <div className="absolute right-0 top-0 w-40 h-40 rounded-full -mr-10 -mt-10 opacity-10"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="relative flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-white/20 rounded-2xl flex items-center justify-center flex-shrink-0">
                {isCompleted
                  ? <CheckCircle2 className="w-5 h-5 text-white" />
                  : isOverdue
                  ? <AlertCircle className="w-5 h-5 text-white" />
                  : <CheckSquare className="w-5 h-5 text-white" />
                }
              </div>
              <div>
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest mb-0.5">
                  {isCompleted ? 'Completed Todo' : isOverdue ? 'Overdue Todo' : 'Active Todo'}
                </p>
                <h2 className="text-lg font-bold text-white leading-tight pr-8">{todo.title || 'Untitled'}</h2>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 bg-white/20 hover:bg-white/30 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors active:scale-90"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {todo.description && (
            <div className={`p-4 rounded-2xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2 flex items-center gap-1.5">
                <FileText size={10} /> Description
              </p>
              <p className={`text-sm leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-700'}`}>{todo.description}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className={`p-3 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1 flex items-center gap-1">
                <CalendarIcon size={9} /> Due Date
              </p>
              {due ? (
                <span
                  className="inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full"
                  style={{ background: `${due.color}18`, color: due.color }}
                >
                  {due.label === 'Overdue' || due.label === 'Today' || due.label === 'Tomorrow'
                    ? due.label
                    : format(parseISO(todo.due_date), 'MMM d, yyyy')
                  }
                </span>
              ) : (
                <p className={`text-xs font-medium ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>No due date</p>
              )}
            </div>

            <div className={`p-3 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1 flex items-center gap-1">
                <Activity size={9} /> Status
              </p>
              <span className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full ${
                isCompleted
                  ? 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400'
                  : isOverdue
                  ? 'bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400'
                  : isDark ? 'bg-slate-700 text-slate-300' : 'bg-slate-200 text-slate-600'
              }`}>
                {isCompleted ? '✓ Done' : isOverdue ? '⚠ Overdue' : '⏳ Pending'}
              </span>
            </div>

            {ownerName && (
              <div className={`p-3 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
                <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1 flex items-center gap-1">
                  <UserIcon size={9} /> Owner
                </p>
                <p className={`text-xs font-semibold truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{ownerName}</p>
              </div>
            )}

            <div className={`p-3 rounded-xl border ${isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1 flex items-center gap-1">
                <Clock size={9} /> Created
              </p>
              <p className={`text-xs font-medium ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {todo.created_at ? format(new Date(todo.created_at), 'MMM d, yyyy') : '—'}
              </p>
            </div>

            {isCompleted && todo.completed_at && (
              <div className={`col-span-2 p-3 rounded-xl border border-emerald-200 dark:border-emerald-800 ${isDark ? 'bg-emerald-900/20' : 'bg-emerald-50'}`}>
                <p className="text-[10px] font-bold uppercase tracking-widest text-emerald-600 dark:text-emerald-400 mb-1 flex items-center gap-1">
                  <CheckCircle2 size={9} /> Completed At
                </p>
                <p className={`text-xs font-medium ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>{safeFormat(todo.completed_at)}</p>
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className={`px-6 py-4 border-t flex items-center justify-between gap-3 ${isDark ? 'border-slate-700 bg-slate-800/60' : 'border-slate-100 bg-slate-50'}`}>
          <div className="flex items-center gap-2">
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => { onDelete(todo.id || todo._id); onClose(); }}
              className="w-9 h-9 flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-600 text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 hover:border-red-200 dark:hover:border-red-700 transition-all"
            >
              <Trash2 size={14} />
            </motion.button>
            <motion.button
              whileTap={{ scale: 0.9 }}
              onClick={() => { onPromote(todo); onClose(); }}
              disabled={isCompleted}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl border border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            >
              <Zap size={12} /> Promote
            </motion.button>
          </div>
          <button
            onClick={() => { onToggle(todo.id || todo._id); onClose(); }}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold rounded-xl text-white transition-all active:scale-95"
            style={{
              background: isCompleted
                ? `linear-gradient(135deg, #64748B, #94A3B8)`
                : `linear-gradient(135deg, ${COLORS.emeraldGreen}, ${COLORS.lightGreen})`,
            }}
          >
            <CheckCircle2 size={14} />
            {isCompleted ? 'Mark Pending' : 'Mark Done'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── TODO ROW (list view — matches TaskRow strip layout) ───────────────────────
function TodoRow({ todo, onToggle, onPromote, onDelete, showOwner, ownerName, onClickDetail }) {
  const isCompleted = todo.is_completed === true || todo.status === 'completed';
  const due         = getDueLabel(todo.due_date);
  const isOverdue   = due?.label === 'Overdue';
  const stripe      = getTodoStripeColor(todo);
  const isSynced    = getTodoSource(todo) === 'synced';

  return (
    <motion.div
      layout
      variants={rowVariant}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <div
        className={`relative rounded-xl border transition-all duration-200 overflow-hidden group mx-4 my-1
          ${isCompleted
            ? 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 opacity-70'
            : isOverdue
              ? 'bg-red-50/60 dark:bg-red-900/10 border-red-200 dark:border-red-800 hover:border-red-300 dark:hover:border-red-700 hover:shadow-sm'
              : isSynced
                ? 'bg-violet-50/40 dark:bg-violet-900/10 border-violet-200 dark:border-violet-800/50 hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-sm'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-500 hover:shadow-sm'
          }`}
      >
        {/* Left colored stripe */}
        <div className={`absolute left-0 top-0 h-full w-1 ${stripe}`} />

        <div
          className="pl-5 pr-3 py-2.5 grid items-center gap-0"
          style={{ gridTemplateColumns: '24px minmax(0,1fr) 110px 76px 90px 100px' }}
        >
          {/* Toggle circle */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(todo.id || todo._id); }}
            className="flex items-center justify-center"
            title="Toggle complete"
          >
            <span
              className="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all"
              style={{
                borderColor:     isCompleted ? COLORS.emeraldGreen : '#CBD5E1',
                backgroundColor: isCompleted ? COLORS.emeraldGreen : 'transparent',
              }}
            >
              {isCompleted && (
                <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ duration: 0.15 }}>
                  <CheckCircle2 size={9} color="#fff" />
                </motion.div>
              )}
            </span>
          </button>

          {/* Title */}
          <button
            className={`min-w-0 text-left font-medium transition-colors pl-1 pr-2 text-sm flex items-center gap-1.5
              ${isCompleted
                ? 'text-slate-400 dark:text-slate-500 line-through'
                : 'text-slate-800 dark:text-slate-100 hover:text-blue-700 dark:hover:text-blue-400'
              }`}
            onClick={() => onClickDetail(todo)}
          >
            <span className="truncate">{todo.title || 'Untitled'}</span>
            <SourceBadge todo={todo} compact={true} />
            {showOwner && ownerName && (
              <span className="text-[10px] font-normal text-slate-400 flex-shrink-0">· {ownerName}</span>
            )}
          </button>

          {/* Due label */}
          <div className="flex items-center justify-center overflow-hidden">
            {due ? (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-md whitespace-nowrap"
                style={{ background: `${due.color}18`, color: due.color }}
              >
                {due.label === 'Overdue' || due.label === 'Today' || due.label === 'Tomorrow'
                  ? due.label
                  : format(parseISO(todo.due_date), 'MMM d')}
              </span>
            ) : (
              <span className="text-slate-300 dark:text-slate-600 text-[10px]">—</span>
            )}
          </div>

          {/* Status badge */}
          <div className="flex items-center justify-center overflow-hidden">
            {isOverdue && !isCompleted ? (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-400 whitespace-nowrap">
                OVERDUE
              </span>
            ) : isCompleted ? (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-400 whitespace-nowrap">
                DONE
              </span>
            ) : (
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                PENDING
              </span>
            )}
          </div>

          {/* Created date */}
          <div className="flex items-center justify-center gap-1 overflow-hidden text-slate-400 dark:text-slate-500">
            {todo.created_at ? (
              <>
                <Clock className="h-3 w-3 flex-shrink-0" />
                <span className="text-[10px] font-medium truncate">
                  {format(new Date(todo.created_at), 'MMM d')}
                </span>
              </>
            ) : <span className="text-[10px]">—</span>}
          </div>

          {/* Actions — visible on hover */}
          <div
            className="flex items-center justify-end gap-0 opacity-0 group-hover:opacity-100 transition-opacity overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => onClickDetail(todo)}
              className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              title="View details"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onPromote(todo)}
              disabled={isCompleted}
              className="p-1 rounded hover:bg-amber-50 dark:hover:bg-amber-900/30 text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
              title="Promote to Task"
            >
              <Zap className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => onDelete(todo.id || todo._id)}
              className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-600 dark:hover:text-red-400 transition-colors"
              title="Delete"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ── TODO BOARD CARD (board view) ──────────────────────────────────────────────
function TodoBoardCard({ todo, onToggle, onPromote, onDelete, onClickDetail, showOwner, ownerName }) {
  const isCompleted = todo.is_completed === true || todo.status === 'completed';
  const due         = getDueLabel(todo.due_date);
  const isOverdue   = due?.label === 'Overdue';
  const stripe      = getTodoStripeColor(todo);

  return (
    <motion.div layout variants={itemVariants}>
      <div
        className={`relative rounded-xl border overflow-hidden transition-all duration-200 group cursor-pointer
          ${isCompleted
            ? 'bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 opacity-75'
            : isOverdue
              ? 'bg-red-50/60 dark:bg-red-900/10 border-red-200 dark:border-red-800 hover:border-red-300 dark:hover:border-red-700 hover:shadow-md'
              : getTodoSource(todo) === 'synced'
                ? 'bg-violet-50/40 dark:bg-violet-900/10 border-violet-200 dark:border-violet-800/50 hover:border-violet-300 dark:hover:border-violet-700 hover:shadow-md'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-500 hover:shadow-md'
          }`}
        onClick={() => onClickDetail(todo)}
      >
        {/* Top stripe */}
        <div className={`h-1 w-full ${stripe}`} />

        <div className="p-3 space-y-2.5">
          {/* Title row */}
          <div className="flex items-start justify-between gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(todo.id || todo._id); }}
              className="mt-0.5 flex-shrink-0"
            >
              <span
                className="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-all"
                style={{
                  borderColor:     isCompleted ? COLORS.emeraldGreen : '#CBD5E1',
                  backgroundColor: isCompleted ? COLORS.emeraldGreen : 'transparent',
                }}
              >
                {isCompleted && <CheckCircle2 size={9} color="#fff" />}
              </span>
            </button>
            <p
              className={`flex-1 text-sm font-semibold leading-snug
                ${isCompleted
                  ? 'line-through text-slate-400 dark:text-slate-500'
                  : 'text-slate-800 dark:text-slate-100'
                }`}
            >
              {todo.title || 'Untitled'}
            </p>
            {/* Hover actions */}
            <div
              className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              onClick={e => e.stopPropagation()}
            >
              <button
                onClick={() => onPromote(todo)}
                disabled={isCompleted}
                className="p-1 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/30 text-slate-400 hover:text-amber-600 dark:hover:text-amber-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Promote to Task"
              >
                <Zap size={13} />
              </button>
              <button
                onClick={() => onDelete(todo.id || todo._id)}
                className="p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                title="Delete"
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>

          {/* Badges */}
          <div className="flex flex-wrap gap-1.5">
            <SourceBadge todo={todo} compact={false} />
            {due && (
              <span
                className="text-[10px] font-bold px-2 py-0.5 rounded-md"
                style={{ background: `${due.color}18`, color: due.color }}
              >
                {due.label === 'Overdue' || due.label === 'Today' || due.label === 'Tomorrow'
                  ? due.label
                  : format(parseISO(todo.due_date), 'MMM d')}
              </span>
            )}
            {showOwner && ownerName && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                {ownerName}
              </span>
            )}
          </div>

          {/* Description preview */}
          {todo.description && (
            <p className="text-[11px] text-slate-400 dark:text-slate-500 leading-relaxed line-clamp-2">
              {todo.description}
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── LOG EVENT BADGE ────────────────────────────────────────────────────────────
function EventBadge({ entry }) {
  const safeFormat = (dt) => { try { return format(new Date(dt), 'MMM d, h:mm a'); } catch { return '—'; } };
  if (entry.event === 'deleted' || entry.deleted_at) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 whitespace-nowrap">
        <X size={10} /> Deleted · {safeFormat(entry.deleted_at || Date.now())}
      </span>
    );
  }
  if (entry.event === 'uncompleted') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 whitespace-nowrap">
        ↩ Reopened
      </span>
    );
  }
  if (entry.event === 'promoted') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-400 whitespace-nowrap">
        <Zap size={10} /> Promoted · {safeFormat(entry.completed_at)}
      </span>
    );
  }
  if (entry.completed_at) {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 rounded-lg bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400 whitespace-nowrap">
        <CheckCircle2 size={10} /> Completed · {safeFormat(entry.completed_at)}
      </span>
    );
  }
  return null;
}

// ── SEARCH INPUT ──────────────────────────────────────────────────────────────
function SearchInput({ value, onChange, placeholder }) {
  return (
    <div className="relative">
      <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full h-9 pl-8 pr-8 text-sm rounded-xl border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none transition-all focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40"
      />
      {value && (
        <button onClick={() => onChange('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-slate-400">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ── TAB PILL ──────────────────────────────────────────────────────────────────
function TabPill({ id, label, icon: Icon, count, activeTab, setActiveTab }) {
  const active = activeTab === id;
  return (
    <button
      onClick={() => setActiveTab(id)}
      className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all ${
        active
          ? 'bg-slate-800 dark:bg-slate-200 text-white dark:text-slate-900 shadow-sm'
          : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
      }`}
    >
      <Icon size={13} />
      {label}
      {count > 0 && (
        <span className={`text-[9px] font-black px-1.5 py-0.5 rounded-full ${
          active
            ? 'bg-white/20 dark:bg-slate-900/20 text-white dark:text-slate-900'
            : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
        }`}>
          {count}
        </span>
      )}
    </button>
  );
}

// ── FILTER CHIP ───────────────────────────────────────────────────────────────
function FilterChip({ id, label, count, todoFilter, setTodoFilter }) {
  const active = todoFilter === id;
  return (
    <button
      onClick={() => setTodoFilter(id)}
      className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-all ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-500'
      }`}
    >
      {label}
      {count !== undefined && <span className="text-[9px] font-black opacity-75">{count}</span>}
    </button>
  );
}

// ── MAIN COMPONENT ────────────────────────────────────────────────────────────
export default function TodoDashboard() {
  const { user, hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const isAdmin     = user?.role === 'admin';
  const isManager   = user?.role === 'manager';
  const canDeleteTodo = isAdmin || hasPermission('can_delete_tasks');
  const isDark      = useDark();
  const [showCustomize, setShowCustomize] = useState(false);
  const TD_SECTIONS = ['stats_row', 'content_area'];
  const TD_LABELS = {
    stats_row:    { name:'Stats Row',      icon:'📊', desc:'Total, overdue, completion rate and health score' },
    content_area: { name:'Todo Content',   icon:'✅', desc:'Create new todos, list, tasks and completed items' },
  };
  const { order: tdOrder, moveSection: tdMove, resetOrder: tdReset } = usePageLayout('tododashboard', TD_SECTIONS);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [title,       setTitle]       = useState('');
  const [description, setDescription] = useState('');
  const [dueDate,     setDueDate]     = useState('');

  // ── UI state ───────────────────────────────────────────────────────────────
  const [activeTab,    setActiveTab]    = useState('todos');
  const [selectedUser, setSelectedUser] = useState('self');
  const [todoFilter,   setTodoFilter]   = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all'); // 'all' | 'manual' | 'synced'
  const [search,       setSearch]       = useState('');
  const [logSearch,    setLogSearch]    = useState('');
  const [viewMode,     setViewMode]     = useState('list'); // 'list' | 'board'

  // ── Detail popup ──────────────────────────────────────────────────────────
  const [selectedTodo,    setSelectedTodo]    = useState(null);
  const [todoToDelete,    setTodoToDelete]    = useState(null);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);

  // ── Promote modal ─────────────────────────────────────────────────────────
  const [promoteTarget,    setPromoteTarget]    = useState(null);
  const [promoteLoading,   setPromoteLoading]   = useState(false);

  // ── Activity log ──────────────────────────────────────────────────────────
  const [todoLog, setTodoLog] = useState([]);
  // ── AI Duplicate detection ────────────────────────────────────────────────
  const [showDupDialog, setShowDupDialog] = useState(false);
  const [dupGroups,     setDupGroups]     = useState([]);
  const [detectingDups, setDetectingDups] = useState(false);


  // ── Fetch all users ────────────────────────────────────────────────────────
  const { data: allUsers = [] } = useQuery({
    queryKey: ['users'],
    enabled:  true,
    queryFn:  async () => {
      try {
        const res = await api.get('/users');
        return res.data || [];
      } catch {
        return [];
      }
    },
  });

  // ── Fetch all clients ──────────────────────────────────────────────────────
  const { data: allClients = [] } = useQuery({
    queryKey: ['clients'],
    queryFn:  async () => {
      try {
        const res = await api.get('/clients');
        return res.data || [];
      } catch (e) {
        const detail = e?.response?.data?.detail;
        if (e?.response?.status === 403 && typeof detail === 'string' && (detail.includes('does not include') || detail.includes('license') || detail.includes('feature'))) {
          return [];
        }
        if (e?.response?.status === 403) toast.error("You don't have permission to view clients.");
        return [];
      }
    },
  });

  // ── "Everyone" visibility ──────────────────────────────────────────────────
  const canSeeEveryone = useMemo(() => {
    if (isAdmin) return true;
    const list = Array.isArray(user?.permissions?.view_other_todos)
      ? user.permissions.view_other_todos
      : [];
    return list.includes('everyone');
  }, [isAdmin, user]);

  // ── Permitted users ────────────────────────────────────────────────────────
  const permittedUsers = useMemo(() => {
    const selfId = user?.id;
    if (isAdmin) return allUsers.filter(u => (u.id || u._id) !== selfId);
    if (isManager) {
      const list = Array.isArray(user?.permissions?.view_other_todos)
        ? user.permissions.view_other_todos.filter(id => id !== 'everyone')
        : [];
      if (canSeeEveryone) return allUsers.filter(u => (u.id || u._id) !== selfId);
      if (list.length > 0) return allUsers.filter(u => list.includes(u.id || u._id) && (u.id || u._id) !== selfId);
      // Fallback: use any users returned by /users API (backend already filtered by cross-vis)
      return allUsers.filter(u => (u.id || u._id) !== selfId);
    }
    const list = Array.isArray(user?.permissions?.view_other_todos)
      ? user.permissions.view_other_todos.filter(id => id !== 'everyone')
      : [];
    if (list.length > 0) return allUsers.filter(u => list.includes(u.id || u._id) && (u.id || u._id) !== selfId);
    // Fallback for staff with cross-vis: use API-returned users
    return allUsers.filter(u => (u.id || u._id) !== selfId);
  }, [isAdmin, isManager, allUsers, user, canSeeEveryone]);

  const showDropdown = isAdmin || canSeeEveryone || permittedUsers.length > 0;

  // ── Resolved user id ───────────────────────────────────────────────────────
  const resolvedUserId = useMemo(() => {
    if (selectedUser === 'self')     return user?.id || 'self';
    if (selectedUser === 'everyone') return 'all';
    return selectedUser;
  }, [selectedUser, user?.id]);

  // ── Fetch todos ────────────────────────────────────────────────────────────
  const { data: todosRaw = [], isLoading } = useQuery({
    queryKey: ['todos', 'page', resolvedUserId],
    enabled:  true,
    queryFn:  async () => {
      const params = {};
      if (resolvedUserId === 'all') {
        params.user_id = 'all';
      } else if (resolvedUserId && resolvedUserId !== user?.id) {
        params.user_id = resolvedUserId;
      }
      const res = await api.get('/todos', { params });
      return res.data || [];
    },
  });

  const todos = useMemo(() => todosRaw, [todosRaw]);

  // ── User map ───────────────────────────────────────────────────────────────
  const userMap = useMemo(() => {
    const map = {};
    allUsers.forEach(u => {
      const id = u.id || u._id;
      if (id) map[id] = u.full_name || u.user_name || 'Unknown';
    });
    if (user?.id) map[user.id] = user.full_name || user.email || 'Me';
    return map;
  }, [allUsers, user]);

  const resolveUserName = useCallback((userId) => {
    if (!userId) return 'Unknown';
    if (userId === user?.id) return user?.full_name || 'Me';
    return userMap[userId] || userId;
  }, [userMap, user]);

  // ── Seed log from completed todos ──────────────────────────────────────────
  useEffect(() => {
    const completed = todos.filter(t => t.is_completed === true || t.status === 'completed');
    if (!completed.length) return;
    setTodoLog(prev => {
      const existingIds = new Set(prev.map(e => e.id));
      const fresh = completed
        .filter(t => !existingIds.has(t.id || t._id))
        .map(t => ({
          id:            t.id || t._id,
          title:         t.title || 'Untitled',
          created_by_id: t.user_id || t.created_by || null,
          owner_id:      t.user_id || null,
          created_at:    t.created_at || null,
          completed_at:  t.completed_at
            ? new Date(t.completed_at)
            : t.updated_at ? new Date(t.updated_at) : new Date(),
          deleted_at:    null,
          event:         'completed',
        }));
      if (!fresh.length) return prev;
      return [...fresh, ...prev]
        .sort((a, b) => {
          const at = a.completed_at || a.deleted_at || new Date(a.created_at || 0);
          const bt = b.completed_at || b.deleted_at || new Date(b.created_at || 0);
          return bt - at;
        })
        .slice(0, 200);
    });
  }, [todos]);


  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total     = todos.length;
    const completed = todos.filter(t => t.is_completed === true || t.status === 'completed').length;
    const pending   = total - completed;
    const overdue   = todos.filter(t => {
      if (!t.due_date) return false;
      if (t.is_completed === true || t.status === 'completed') return false;
      try { return isPast(parseISO(t.due_date)); } catch { return false; }
    }).length;
    const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;
    const healthScore    = Math.max(0, Math.min(100, 100 - (overdue * 10)));
    const manualCount = todos.filter(t => getTodoSource(t) === 'manual').length;
    const syncedCount = todos.filter(t => getTodoSource(t) === 'synced').length;
    return { total, completed, pending, overdue, completionRate, healthScore, manualCount, syncedCount };
  }, [todos]);

  // ── Filtered todos ─────────────────────────────────────────────────────────
  const filteredTodos = useMemo(() => {
    let list = todos;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(t =>
        (t.title || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q)
      );
    }
    switch (todoFilter) {
      case 'pending':   list = list.filter(t => !(t.is_completed === true || t.status === 'completed')); break;
      case 'completed': list = list.filter(t => t.is_completed === true || t.status === 'completed'); break;
      case 'overdue':
        list = list.filter(t => {
          if (!t.due_date || t.is_completed === true || t.status === 'completed') return false;
          try { return isPast(parseISO(t.due_date)); } catch { return false; }
        });
        break;
      default: break;
    }
    // Source filter
    if (sourceFilter === 'manual') {
      list = list.filter(t => getTodoSource(t) === 'manual');
    } else if (sourceFilter === 'synced') {
      list = list.filter(t => getTodoSource(t) === 'synced');
    }
    return list;
  }, [todos, search, todoFilter, sourceFilter]);

  // ── Filtered log ───────────────────────────────────────────────────────────
  const filteredLog = useMemo(() => {
    let list = todoLog;
    if (logSearch) {
      const q = logSearch.toLowerCase();
      list = list.filter(e => (e.title || '').toLowerCase().includes(q));
    }
    if (selectedUser === 'self') {
      list = list.filter(e => e.owner_id === user?.id);
    } else if (selectedUser !== 'everyone') {
      list = list.filter(e => e.owner_id === selectedUser);
    }
    return list;
  }, [todoLog, logSearch, selectedUser, user?.id]);

  // ── Dropdown label ─────────────────────────────────────────────────────────
  const selectedUserLabel = useMemo(() => {
    if (selectedUser === 'self')     return `My Todos — ${user?.full_name || 'Me'}`;
    if (selectedUser === 'everyone') return 'Everyone — All Users';
    const u = allUsers.find(u => (u.id || u._id) === selectedUser);
    return u ? `${u.full_name || u.user_name}'s Todos` : 'Selected User';
  }, [selectedUser, allUsers, user]);

  // ── Notification helper ────────────────────────────────────────────────────
  const sendNotification = useCallback(async ({ title: t, message }) => {
    try { await api.post('/notifications/send', { title: t, message, type: 'todo' }); } catch (_) {}
  }, []);

  // ── Invalidate ─────────────────────────────────────────────────────────────
  const invalidateTodos = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['todos', 'page', resolvedUserId] });
    queryClient.invalidateQueries({ queryKey: ['todos', 'dashboard-card', user?.id] });
    queryClient.invalidateQueries({ queryKey: ['todos'] });
  }, [queryClient, resolvedUserId, user?.id]);

  // ── Mutations ──────────────────────────────────────────────────────────────
  const addMutation = useMutation({
    mutationFn: (payload) => api.post('/todos', payload),
    onSuccess: (_, vars) => {
      invalidateTodos();
      toast.success('Todo created');
      setTitle(''); setDescription(''); setDueDate('');
      sendNotification({ title: '📝 New Todo', message: `"${vars.title}" created by ${user?.full_name || 'a user'}.` });
    },
    onError: () => toast.error('Failed to create todo'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id }) => {
      const todo = todos.find(t => (t.id || t._id) === id);
      if (!todo) throw new Error('Todo not found');
      const nowCompleted = !(todo.is_completed === true || todo.status === 'completed');
      const payload = {
        title: todo.title || "",
        description: todo.description || "",
        due_date: todo.due_date || null,
        is_completed: nowCompleted,
        status: nowCompleted ? "completed" : "pending"
      };
      return api.patch(`/todos/${id}`, payload);
    },
    onSuccess: (_, { id }) => {
      const todo = todos.find(t => (t.id || t._id) === id);
      if (todo) {
        const wasCompleted = todo.is_completed === true || todo.status === 'completed';
        setTodoLog(prev => [{
          id:            todo.id || todo._id,
          title:         todo.title || 'Untitled',
          created_by_id: todo.user_id || todo.created_by || null,
          owner_id:      todo.user_id || null,
          created_at:    todo.created_at || null,
          completed_at:  wasCompleted ? null : new Date(),
          deleted_at:    null,
          event:         wasCompleted ? 'uncompleted' : 'completed',
        }, ...prev].slice(0, 200));
        if (!wasCompleted) {
          sendNotification({ title: '✅ Todo Completed', message: `"${todo.title}" completed by ${user?.full_name || 'a user'}.` });
          // Remove linked email event from Action Center when todo is completed (best-effort)
          if (todo.event_id) {
            api.delete(`/email/events/${todo.event_id}`).catch(() => {});
          }
        }
      }
      invalidateTodos();
    },
    onError: () => toast.error('Failed to update todo'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.delete(`/todos/${id}`),
    onSuccess: (_, id) => {
      const deleted = todos.find(t => (t.id || t._id) === id);
      if (deleted) {
        setTodoLog(prev => [{
          id:            deleted.id || deleted._id,
          title:         deleted.title || 'Untitled',
          created_by_id: deleted.user_id || deleted.created_by || null,
          owner_id:      deleted.user_id || null,
          created_at:    deleted.created_at || null,
          completed_at:  null,
          deleted_at:    new Date(),
          event:         'deleted',
        }, ...prev].slice(0, 200));
        // Also remove the linked email event from Action Center (best-effort)
        if (deleted.event_id) {
          api.delete(`/email/events/${deleted.event_id}`).catch(() => {});
        }
      }
      invalidateTodos();
      toast.success('Todo deleted');
    },
    onError: () => toast.error('Failed to delete todo'),
  });

  // ── AI Duplicate Detection ─────────────────────────────────────────────────
  const handleDetectTodoDuplicates = () => {
    if (detectingDups) return;
    setDetectingDups(true);
    setTimeout(() => {
      try {
        const all = todos || [];
        const groups = detectTodoDuplicates(all);
        setDupGroups(groups);
        setShowDupDialog(true);
        if (!groups.length) toast.success(`Scanned ${all.length} todos — no duplicates found ✓`);
        else toast.info(`Found ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''}`);
      } catch (e) {
        toast.error('Duplicate scan failed. Please try again.');
        console.error('Todo duplicate detection error:', e);
      } finally {
        setDetectingDups(false);
      }
    }, 60);
  };

  // ── Handlers ───────────────────────────────────────────────────────────────
  const handleAdd = () => {
    if (!title.trim()) return;
    addMutation.mutate({
      title:        title.trim(),
      description:  description.trim(),
      due_date:     dueDate || null,
      is_completed: false,
      status:       'pending',
    });
  };

  const handleToggle  = (id) => toggleMutation.mutate({ id });
  const handleDelete  = (todoOrId) => {
    let todoObj = null;
    if (typeof todoOrId === 'object' && todoOrId !== null) {
      todoObj = todoOrId;
    } else {
      todoObj = todos.find(t => (t.id || t._id) === todoOrId) || { id: todoOrId, title: 'this todo' };
    }
    setTodoToDelete(todoObj);
    setDeleteModalOpen(true);
  };

  const handleConfirmDeleteTodo = () => {
    if (!todoToDelete) return;
    const targetId = todoToDelete.id || todoToDelete._id;
    deleteMutation.mutate(targetId, {
      onSettled: () => {
        setDeleteModalOpen(false);
        setTodoToDelete(null);
        if (selectedTodo && (selectedTodo.id || selectedTodo._id) === targetId) {
          setSelectedTodo(null);
        }
      }
    });
  };

  const handleOpenPromote = (todo) => {
    setSelectedTodo(null);
    setPromoteTarget(todo);
  };

  const handleConfirmPromote = async (todoId, taskData) => {
    setPromoteLoading(true);
    try {
      await api.post(`/todos/${todoId}/promote-to-task`, taskData);
      toast.success('Promoted to Master Task!');

      const todo = todos.find(t => (t.id || t._id) === todoId);
      if (todo) {
        setTodoLog(prev => [{
          id:            todo.id || todo._id,
          title:         todo.title || 'Untitled',
          created_by_id: todo.user_id || todo.created_by || null,
          owner_id:      todo.user_id || null,
          created_at:    todo.created_at || null,
          completed_at:  new Date(),
          deleted_at:    null,
          event:         'promoted',
        }, ...prev].slice(0, 200));
      }

      sendNotification({
        title:   '⚡ Todo Promoted',
        message: `"${todo?.title || 'A todo'}" promoted to task by ${user?.full_name || 'a user'}.`,
      });

      invalidateTodos();
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
      setPromoteTarget(null);
    } catch (err) {
      const msg = err?.response?.data?.message || err?.response?.data?.error || 'Failed to promote todo';
      toast.error(msg);
    } finally {
      setPromoteLoading(false);
    }
  };

  // ── User selector ──────────────────────────────────────────────────────────
  const UserSelector = () => (
    showDropdown ? (
      <Select value={selectedUser} onValueChange={setSelectedUser}>
        <SelectTrigger className="h-9 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-sm font-medium" style={{ minWidth: 200 }}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="self">My Todos ({user?.full_name || 'Me'})</SelectItem>
          {canSeeEveryone && (
            <SelectItem value="everyone">
              <span className="flex items-center gap-2"><Users size={12} className="text-blue-500" />Everyone — All Users</span>
            </SelectItem>
          )}
          {permittedUsers.map(u => (
            <SelectItem key={u.id || u._id} value={u.id || u._id}>
              {u.full_name || u.user_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null
  );

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────────
  return (
    <motion.div
      className="space-y-4"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      {/* ── Todo Detail Modal ────────────────────────────────────────────────── */}
      <AnimatePresence>
        {selectedTodo && !promoteTarget && (
          <TodoDetailModal
            todo={selectedTodo}
            isDark={isDark}
            onClose={() => setSelectedTodo(null)}
            onToggle={(id) => { handleToggle(id); setSelectedTodo(null); }}
            onPromote={(todo) => handleOpenPromote(todo)}
            onDelete={(id) => { handleDelete(id); setSelectedTodo(null); }}
            ownerName={selectedTodo.user_id ? resolveUserName(selectedTodo.user_id) : null}
          />
        )}
      </AnimatePresence>

      {/* ── Promote to Task Modal ────────────────────────────────────────────── */}
      <AnimatePresence>
        {promoteTarget && (
          <PromoteToTaskModal
            todo={promoteTarget}
            isDark={isDark}
            onClose={() => setPromoteTarget(null)}
            onConfirm={handleConfirmPromote}
            isLoading={promoteLoading}
            allUsers={isAdmin || isManager ? allUsers : [
              ...(user ? [{ id: user.id, _id: user.id, full_name: user.full_name, role: user.role }] : []),
              ...permittedUsers,
            ]}
            allClients={allClients}
          />
        )}
      </AnimatePresence>

      <LayoutCustomizer
        isOpen={showCustomize}
        onClose={() => setShowCustomize(false)}
        order={tdOrder}
        sectionLabels={TD_LABELS}
        onDragEnd={tdMove}
        onReset={tdReset}
        isDark={isDark}
      />

      {/* ── Page Header ─────────────────────────────────────────────────────── */}
      <motion.div variants={itemVariants}>
        <div
          className="relative overflow-hidden rounded-2xl px-6 py-5"
          style={{
            background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`,
            boxShadow: `0 8px 32px rgba(13,59,102,0.28)`,
          }}
        >
          <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10"
            style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
          <div className="absolute right-24 bottom-0 w-32 h-32 rounded-full mb-[-30px] opacity-5"
            style={{ background: 'white' }} />

          <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <p className="text-white/60 text-xs font-medium uppercase tracking-widest mb-1">
                {format(new Date(), 'EEEE, MMMM d, yyyy')}
                {selectedUser !== 'self' && selectedUser !== 'everyone' && (() => {
                  const u = allUsers.find(u => (u.id || u._id) === selectedUser);
                  return u ? ` · ${u.full_name || u.user_name}'s list` : '';
                })()}
                {selectedUser === 'everyone' && ' · All users view'}
              </p>
              <h1 className="text-2xl font-bold text-white tracking-tight">Todo Management</h1>
              <p className="text-white/60 text-sm mt-1">
                {stats.total === 0
                  ? 'No todos yet — add some to get started'
                  : stats.overdue > 0
                    ? `${stats.overdue} overdue item${stats.overdue === 1 ? '' : 's'} need attention`
                    : stats.completionRate === 100
                      ? 'All todos completed — great work!'
                      : `${stats.pending} remaining · ${stats.completionRate}% complete`
                }
              </p>
            </div>

            <div className="flex items-center gap-1 p-1 rounded-xl"
              style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.18)' }}>
              <TabPill id="todos" label="Todos"    icon={CheckSquare} count={stats.pending}      activeTab={activeTab} setActiveTab={setActiveTab} />
              <TabPill id="log"   label="Activity" icon={History}     count={filteredLog.length} activeTab={activeTab} setActiveTab={setActiveTab} />
            </div>
          </div>
        </div>
      </motion.div>

      {/* CUSTOMIZE BUTTON */}
      <motion.div variants={itemVariants} className="flex justify-end">
        <button
          onClick={() => setShowCustomize(true)}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold border transition-all hover:shadow-md ${
            isDark
              ? 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-500'
              : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
          }`}
        >
          <Settings2 size={13} /> Customize Layout
        </button>
      </motion.div>

      {/* ORDERED SECTIONS */}
      {tdOrder.map((sectionId) => {
        if (sectionId === 'stats_row') return (
          <React.Fragment key="stats_row">
            <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3" variants={itemVariants}>
              <MetricCard icon={Layers}      label="Total"        value={stats.total}                sub="todos tracked"                              accent={COLORS.deepBlue} />
              <MetricCard icon={AlertCircle} label="Overdue"      value={stats.overdue}              sub="need attention"                             accent={stats.overdue > 0 ? COLORS.coral : '#94A3B8'} />
              <MetricCard icon={TrendingUp}  label="Completion"   value={`${stats.completionRate}%`} sub={`${stats.completed} of ${stats.total}`}     accent={COLORS.emeraldGreen} progress={stats.completionRate} />
              <MetricCard icon={Sparkles}    label="Health Score" value={`${stats.healthScore}%`}    sub={stats.healthScore >= 80 ? 'On track' : 'Needs focus'} accent={stats.healthScore >= 80 ? '#1F6FB2' : COLORS.amber} progress={stats.healthScore} />
            </motion.div>
          </React.Fragment>
        );

        if (sectionId === 'content_area') return (
          <React.Fragment key="content_area">
            <AnimatePresence mode="wait">

              {/* ─────────────── TODOS TAB ───────────────────────────────────────── */}
              {activeTab === 'todos' && (
                <motion.div key="todos" variants={containerVariants} initial="hidden" animate="visible" exit={{ opacity: 0 }} className="space-y-4">
                  <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">

                    {/* LEFT — Create form */}
                    <div className="xl:col-span-4 flex flex-col gap-4">

                      <motion.div variants={itemVariants}>
                        <SectionCard>
                          <CardHeaderRow
                            iconBg="bg-emerald-50 dark:bg-emerald-900/40"
                            icon={<Plus className="h-4 w-4 text-emerald-600" />}
                            title="New Todo"
                            subtitle="Add to your list"
                          />
                          <div className="p-4 space-y-4">
                            <div>
                              <label className="block text-[10px] font-semibold uppercase tracking-widest mb-1.5 text-slate-400">Title *</label>
                              <input
                                type="text" value={title} onChange={e => setTitle(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && handleAdd()}
                                placeholder="What needs to get done?"
                                className="w-full h-10 rounded-xl border border-slate-200 dark:border-slate-600 px-3 text-sm font-medium placeholder:font-normal bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-100 outline-none transition-all focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold uppercase tracking-widest mb-1.5 text-slate-400">Notes</label>
                              <textarea
                                value={description} onChange={e => setDescription(e.target.value)}
                                placeholder="Additional context…" rows={3}
                                className="w-full rounded-xl border border-slate-200 dark:border-slate-600 px-3 py-2.5 text-sm resize-none bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-100 placeholder:text-slate-400 outline-none transition-all focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-semibold uppercase tracking-widest mb-1.5 text-slate-400">Due Date</label>
                              <input
                                type="date" value={dueDate} onChange={e => setDueDate(e.target.value)}
                                className="w-full h-10 rounded-xl border border-slate-200 dark:border-slate-600 px-3 text-sm bg-slate-50 dark:bg-slate-700 text-slate-800 dark:text-slate-100 outline-none transition-all focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-900/40"
                              />
                            </div>
                            <Button
                              onClick={handleAdd}
                              disabled={!title.trim() || addMutation.isPending}
                              className="w-full h-10 rounded-xl text-sm font-semibold flex items-center justify-center gap-2"
                              style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}
                            >
                              {addMutation.isPending
                                ? <><RefreshCw size={14} className="animate-spin" /> Creating…</>
                                : <><Plus size={14} /> Create Todo</>
                              }
                            </Button>
                          </div>
                        </SectionCard>
                      </motion.div>

                      {/* Quick stats */}
                      <motion.div variants={itemVariants}>
                        <SectionCard>
                          <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-700">
                            {[
                              { label: 'Done',  value: `${stats.completionRate}%`, color: COLORS.emeraldGreen },
                              { label: 'Alert', value: stats.overdue,              color: COLORS.amber         },
                              { label: 'Left',  value: stats.pending,              color: COLORS.deepBlue      },
                            ].map(({ label, value, color }) => (
                              <div key={label} className="px-3 py-4 text-center">
                                <div className="text-xl font-bold tabular-nums" style={{ color }}>{value}</div>
                                <div className="text-[9px] font-semibold uppercase tracking-widest mt-0.5 text-slate-400">{label}</div>
                              </div>
                            ))}
                          </div>
                        </SectionCard>
                      </motion.div>

                      {/* Progress bar */}
                      <motion.div variants={itemVariants}>
                        <SectionCard>
                          <div className="p-4">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Overall Progress</span>
                              <span className="text-xs font-bold tabular-nums text-slate-700 dark:text-slate-200">{stats.completionRate}%</span>
                            </div>
                            <div className="h-2 rounded-full overflow-hidden flex gap-0.5 bg-slate-100 dark:bg-slate-700">
                              {stats.total > 0 ? (
                                <>
                                  {stats.completed > 0 && (
                                    <motion.div className="h-full rounded-l-full" style={{ background: COLORS.emeraldGreen, width: `${(stats.completed / stats.total) * 100}%`, minWidth: 4 }}
                                      initial={{ width: 0 }} animate={{ width: `${(stats.completed / stats.total) * 100}%` }} transition={{ duration: 0.9, ease: 'easeOut', delay: 0.1 }} />
                                  )}
                                  {stats.overdue > 0 && (
                                    <motion.div className="h-full" style={{ background: COLORS.coral, width: `${(stats.overdue / stats.total) * 100}%`, minWidth: 4 }}
                                      initial={{ width: 0 }} animate={{ width: `${(stats.overdue / stats.total) * 100}%` }} transition={{ duration: 0.9, ease: 'easeOut', delay: 0.25 }} />
                                  )}
                                  {(stats.pending - stats.overdue) > 0 && (
                                    <motion.div className="h-full rounded-r-full flex-1 bg-slate-200 dark:bg-slate-600" style={{ minWidth: 4 }}
                                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.5, delay: 0.4 }} />
                                  )}
                                </>
                              ) : (
                                <div className="h-full w-full rounded-full bg-slate-200 dark:bg-slate-600" />
                              )}
                            </div>
                            <div className="flex items-center gap-4 mt-2.5 flex-wrap">
                              {[
                                { color: COLORS.emeraldGreen, label: 'Completed', count: stats.completed,               hide: false },
                                { color: COLORS.coral,        label: 'Overdue',   count: stats.overdue,                 hide: stats.overdue === 0 },
                                { color: '#CBD5E1',            label: 'Pending',   count: stats.pending - stats.overdue, hide: false },
                              ].filter(i => !i.hide).map(({ color, label, count }) => (
                                <div key={label} className="flex items-center gap-1.5">
                                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: color }} />
                                  <span className="text-[10px] font-medium text-slate-400">
                                    {label} <span className="font-bold text-slate-600 dark:text-slate-300">{count}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </SectionCard>
                      </motion.div>

                      {/* AI Audit */}
                      <motion.div variants={itemVariants} className="flex-1">
                        <SectionCard className="h-full">
                          <div className="p-4 h-full flex flex-col">
                            <div className="flex items-center gap-3">
                              <div className="p-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/40">
                                <Sparkles className="h-4 w-4 text-purple-500" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">AI Audit</h3>
                                <p className="text-xs text-slate-400 dark:text-slate-500">
                                  {stats.total === 0 ? 'No todos yet — add some to get started'
                                    : stats.overdue > 0 ? `⚠️ ${stats.overdue} overdue ${stats.overdue === 1 ? 'todo' : 'todos'} need attention`
                                    : stats.completionRate === 100 ? '🎉 All todos completed — great work!'
                                    : stats.completionRate >= 75 ? `✅ ${stats.completionRate}% done — almost there!`
                                    : `📋 ${stats.pending} remaining · ${stats.completionRate}% on track`
                                  }
                                </p>
                              </div>
                              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                style={{
                                  background: stats.overdue > 0 ? COLORS.coral : stats.completionRate >= 75 ? COLORS.emeraldGreen : COLORS.amber,
                                  boxShadow:  `0 0 0 3px ${(stats.overdue > 0 ? COLORS.coral : stats.completionRate >= 75 ? COLORS.emeraldGreen : COLORS.amber)}28`,
                                }}
                              />
                            </div>
                            {stats.total > 0 && (
                              <div className="mt-3 pt-3 border-t border-slate-100 dark:border-slate-700 flex items-start gap-2">
                                <AlertCircle size={12} style={{ color: stats.overdue > 0 ? COLORS.coral : COLORS.mediumBlue, marginTop: 1, flexShrink: 0 }} />
                                <p className="text-[11px] font-medium leading-relaxed text-slate-400 dark:text-slate-500">
                                  {stats.overdue > 0
                                    ? `Address your ${stats.overdue} overdue ${stats.overdue === 1 ? 'item' : 'items'} first to improve your health score from ${stats.healthScore}%.`
                                    : stats.pending > 0
                                      ? `${stats.pending} ${stats.pending === 1 ? 'todo' : 'todos'} left. Health score: ${stats.healthScore}% — keep the momentum!`
                                      : `Perfect score! Health at ${stats.healthScore}%. Consider adding new goals.`
                                  }
                                </p>
                              </div>
                            )}
                          </div>
                        </SectionCard>
                      </motion.div>

                    </div>

                    {/* RIGHT — Todo list / board */}
                    <div className="xl:col-span-8 space-y-4">

                      {showDropdown && (
                        <motion.div variants={itemVariants}>
                          <SectionCard>
                            <CardHeaderRow
                              iconBg={isDark ? 'bg-blue-900/40' : 'bg-blue-50'}
                              icon={<Users className="h-4 w-4 text-blue-500" />}
                              title={isAdmin ? 'Filter by Team Member' : 'View Todo List'}
                              subtitle="Switch between user views"
                              action={
                                isAdmin && (
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-widest bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">
                                    Admin
                                  </span>
                                )
                              }
                            />
                            <div className="p-4">
                              <UserSelector />
                            </div>
                          </SectionCard>
                        </motion.div>
                      )}

                      <motion.div variants={itemVariants}>
                        <SectionCard>
                          {/* ── Section header with List/Board toggle ── */}
                          <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700">
                            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                              <div className="flex items-center gap-2.5 flex-1 min-w-0">
                                <div className="p-1.5 rounded-lg bg-emerald-50 dark:bg-emerald-900/40">
                                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                                </div>
                                <div className="min-w-0">
                                  <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100 truncate">{selectedUserLabel}</h3>
                                  <p className="text-xs text-slate-400 dark:text-slate-500">{filteredTodos.length} items · click any row for details</p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2 flex-shrink-0">
                                {/* List / Board toggle */}
                                <div className={`flex items-center gap-0.5 p-0.5 rounded-lg border ${isDark ? 'bg-slate-700/50 border-slate-600' : 'bg-slate-100 border-slate-200'}`}>
                                  <button
                                    onClick={() => setViewMode('list')}
                                    title="List view"
                                    className={`p-1.5 rounded-md transition-all ${viewMode === 'list'
                                      ? isDark ? 'bg-slate-600 text-slate-100 shadow-sm' : 'bg-white text-slate-700 shadow-sm'
                                      : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                                  >
                                    <List size={13} />
                                  </button>
                                  <button
                                    onClick={() => setViewMode('board')}
                                    title="Board view"
                                    className={`p-1.5 rounded-md transition-all ${viewMode === 'board'
                                      ? isDark ? 'bg-slate-600 text-slate-100 shadow-sm' : 'bg-white text-slate-700 shadow-sm'
                                      : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                                  >
                                    <LayoutGrid size={13} />
                                  </button>
                                </div>
                                <div className="w-52">
                                  <SearchInput value={search} onChange={setSearch} placeholder="Search todos…" />
                                </div>
                                {/* AI Duplicate Detector */}
                                <button
                                  onClick={handleDetectTodoDuplicates}
                                  disabled={detectingDups || (todos || []).length === 0}
                                  className={`h-8 px-3 text-xs font-semibold rounded-xl border transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 ${isDark ? 'bg-violet-900/30 border-violet-700 text-violet-300 hover:bg-violet-900/50' : 'bg-violet-50 border-violet-300 text-violet-700 hover:bg-violet-100'}`}
                                >
                                  {detectingDups
                                    ? <><Loader2 className="h-3 w-3 animate-spin" />Scanning…</>
                                    : <><Sparkles className="h-3 w-3" />AI Duplicates</>}
                                </button>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 mt-3 flex-wrap">
                              <FilterChip id="all"       label="All"       count={todos.length}    todoFilter={todoFilter} setTodoFilter={setTodoFilter} />
                              <FilterChip id="pending"   label="Pending"   count={stats.pending}   todoFilter={todoFilter} setTodoFilter={setTodoFilter} />
                              <FilterChip id="completed" label="Completed" count={stats.completed} todoFilter={todoFilter} setTodoFilter={setTodoFilter} />
                              {stats.overdue > 0 && (
                                <FilterChip id="overdue" label="Overdue" count={stats.overdue} todoFilter={todoFilter} setTodoFilter={setTodoFilter} />
                              )}
                              {/* Source filter divider */}
                              <span className="text-slate-300 dark:text-slate-600 text-xs">|</span>
                              <button
                                onClick={() => setSourceFilter(sourceFilter === 'manual' ? 'all' : 'manual')}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-all ${
                                  sourceFilter === 'manual'
                                    ? 'bg-slate-700 text-white border-slate-700'
                                    : 'border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-500'
                                }`}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                                </svg>
                                Manual
                                <span className="text-[9px] font-black opacity-75">{stats.manualCount}</span>
                              </button>
                              <button
                                onClick={() => setSourceFilter(sourceFilter === 'synced' ? 'all' : 'synced')}
                                className={`flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border transition-all ${
                                  sourceFilter === 'synced'
                                    ? 'bg-violet-600 text-white border-violet-600'
                                    : 'border-violet-200 dark:border-violet-700 text-violet-600 dark:text-violet-400 hover:border-violet-300 dark:hover:border-violet-600'
                                }`}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                  <polyline points="17 8 12 3 7 8"/>
                                  <line x1="12" y1="3" x2="12" y2="15"/>
                                </svg>
                                Synced
                                <span className="text-[9px] font-black opacity-75">{stats.syncedCount}</span>
                              </button>
                            </div>
                          </div>

                          {/* ── LIST VIEW ── */}
                          {viewMode === 'list' && (
                            <>
                              <div
                                className="py-2 border-b border-slate-100 dark:border-slate-700 grid items-center bg-slate-50/80 dark:bg-slate-700/30"
                                style={{ gridTemplateColumns: '24px minmax(0,1fr) 110px 76px 90px 100px', paddingLeft: '2.25rem', paddingRight: '1.75rem' }}
                              >
                                <div />
                                <span className="pl-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">Title</span>
                                <span className="text-center text-[10px] font-semibold uppercase tracking-widest text-slate-400">Due</span>
                                <span className="text-center text-[10px] font-semibold uppercase tracking-widest text-slate-400">Status</span>
                                <span className="text-center text-[10px] font-semibold uppercase tracking-widest text-slate-400">Created</span>
                                <span className="text-right text-[10px] font-semibold uppercase tracking-widest text-slate-400">Actions</span>
                              </div>
                              <div style={{ maxHeight: 500, overflowY: 'auto' }} className="todo-slim py-1">
                                {isLoading ? (
                                  <MiniLoader height={300} />
                                ) : filteredTodos.length === 0 ? (
                                  <div className="py-16 flex flex-col items-center gap-3">
                                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-slate-100 dark:bg-slate-700">
                                      <CheckSquare size={24} className="text-slate-300 dark:text-slate-500" />
                                    </div>
                                    <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">
                                      {search || todoFilter !== 'all' ? 'No matching todos' : 'No todos yet'}
                                    </p>
                                    <p className="text-xs font-medium text-slate-400 dark:text-slate-500">
                                      {search || todoFilter !== 'all' ? 'Try adjusting your filters' : 'Create one using the form on the left'}
                                    </p>
                                  </div>
                                ) : (
                                  <AnimatePresence>
                                    {filteredTodos.map(todo => (
                                      <TodoRow
                                        key={todo.id || todo._id}
                                        todo={todo}
                                        onToggle={handleToggle}
                                        onPromote={handleOpenPromote}
                                        onDelete={handleDelete}
                                        showOwner={selectedUser === 'everyone'}
                                        ownerName={resolveUserName(todo.user_id)}
                                        onClickDetail={setSelectedTodo}
                                      />
                                    ))}
                                  </AnimatePresence>
                                )}
                              </div>
                            </>
                          )}

                          {/* ── BOARD VIEW ── */}
                          {viewMode === 'board' && (
                            <div className="p-4">
                              {isLoading ? (
                                <MiniLoader height={300} />
                              ) : (
                                (() => {
                                  const columns = [
                                    {
                                      id:    'pending',
                                      label: 'To Do',
                                      color: '#EF4444',
                                      bg:    isDark ? 'bg-red-900/10 border-red-800' : 'bg-red-50/60 border-red-200',
                                      items: filteredTodos.filter(t => {
                                        const done = t.is_completed === true || t.status === 'completed';
                                        if (done) return false;
                                        try { return t.due_date ? !isPast(parseISO(t.due_date)) : true; } catch { return true; }
                                      }),
                                    },
                                    {
                                      id:    'overdue',
                                      label: 'Overdue',
                                      color: '#B91C1C',
                                      bg:    isDark ? 'bg-red-900/20 border-red-800' : 'bg-red-100/60 border-red-300',
                                      items: filteredTodos.filter(t => {
                                        if (t.is_completed === true || t.status === 'completed') return false;
                                        if (!t.due_date) return false;
                                        try { return isPast(parseISO(t.due_date)); } catch { return false; }
                                      }),
                                    },
                                    {
                                      id:    'completed',
                                      label: 'Done',
                                      color: '#2563EB',
                                      bg:    isDark ? 'bg-blue-900/10 border-blue-800' : 'bg-blue-50/60 border-blue-200',
                                      items: filteredTodos.filter(t => t.is_completed === true || t.status === 'completed'),
                                    },
                                  ];

                                  return (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                      {columns.map(col => (
                                        <div key={col.id} className={`rounded-xl border ${col.bg} p-3`}>
                                          {/* Column header */}
                                          <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-2">
                                              <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: col.color }} />
                                              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: col.color }}>{col.label}</span>
                                            </div>
                                            <span
                                              className="text-[10px] font-black px-2 py-0.5 rounded-full"
                                              style={{ background: `${col.color}18`, color: col.color }}
                                            >
                                              {col.items.length}
                                            </span>
                                          </div>

                                          {/* Cards */}
                                          <div className="space-y-2 max-h-[520px] overflow-y-auto todo-slim">
                                            {col.items.length === 0 ? (
                                              <div className="py-8 flex flex-col items-center gap-2 opacity-50">
                                                <CheckSquare size={18} className="text-slate-400" />
                                                <p className="text-[11px] font-medium text-slate-400">Empty</p>
                                              </div>
                                            ) : (
                                              <AnimatePresence>
                                                {col.items.map(todo => (
                                                  <TodoBoardCard
                                                    key={todo.id || todo._id}
                                                    todo={todo}
                                                    onToggle={handleToggle}
                                                    onPromote={handleOpenPromote}
                                                    onDelete={handleDelete}
                                                    onClickDetail={setSelectedTodo}
                                                    showOwner={selectedUser === 'everyone'}
                                                    ownerName={resolveUserName(todo.user_id)}
                                                  />
                                                ))}
                                              </AnimatePresence>
                                            )}
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  );
                                })()
                              )}
                            </div>
                          )}

                        </SectionCard>
                      </motion.div>
                    </div>
                  </div>


                  {/* ── Focus Board — Full-width horizontal card below both columns ── */}
                  <motion.div variants={itemVariants}>
                    <SectionCard>
                      <div className="p-5">
                        <div className="flex flex-col lg:flex-row gap-6">

                          {/* Left section: header + health score ring */}
                          <div className="flex items-start gap-4 lg:w-64 flex-shrink-0">
                            <div className="p-1.5 rounded-lg bg-amber-50 dark:bg-amber-900/40 flex-shrink-0 mt-0.5">
                              <Target className="h-4 w-4 text-amber-500" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">Focus Board</h3>
                              <p className="text-xs text-slate-400 dark:text-slate-500 mb-3">Today's priority queue</p>
                              <div className="flex items-center gap-3">
                                <div className="relative w-14 h-14 flex-shrink-0">
                                  <svg viewBox="0 0 44 44" className="w-14 h-14 -rotate-90">
                                    <circle cx="22" cy="22" r="17" strokeWidth="4" fill="none"
                                      stroke={isDark ? '#334155' : '#e2e8f0'} />
                                    <circle cx="22" cy="22" r="17" strokeWidth="4" fill="none"
                                      strokeDasharray={`${(stats.healthScore / 100) * 106.8} 106.8`}
                                      strokeLinecap="round"
                                      stroke={stats.healthScore >= 80 ? COLORS.emeraldGreen : stats.healthScore >= 50 ? COLORS.amber : COLORS.coral} />
                                  </svg>
                                  <span className="absolute inset-0 flex items-center justify-center text-[12px] font-black"
                                    style={{ color: stats.healthScore >= 80 ? COLORS.emeraldGreen : stats.healthScore >= 50 ? COLORS.amber : COLORS.coral }}>
                                    {stats.healthScore}
                                  </span>
                                </div>
                                <div>
                                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Health Score</p>
                                  <p className="text-sm font-bold mt-0.5" style={{ color: stats.healthScore >= 80 ? COLORS.emeraldGreen : stats.healthScore >= 50 ? COLORS.amber : COLORS.coral }}>
                                    {stats.healthScore >= 80 ? 'Excellent' : stats.healthScore >= 50 ? 'Fair' : 'Needs Work'}
                                  </p>
                                  <p className="text-[10px] text-slate-400 mt-0.5">{stats.completed}/{stats.total} done</p>
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Vertical divider */}
                          <div className="hidden lg:block w-px bg-slate-100 dark:bg-slate-700 flex-shrink-0" />

                          {/* Middle section: priority todo grid */}
                          <div className="flex-1 min-w-0">
                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2.5">
                              {stats.overdue > 0 ? '🔥 Clear These First' : '📌 Up Next'}
                            </p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              {(() => {
                                const overdueTodos = todos.filter(t => {
                                  if (t.is_completed === true || t.status === 'completed') return false;
                                  if (!t.due_date) return false;
                                  try { return isPast(parseISO(t.due_date)); } catch { return false; }
                                });
                                const pendingTodos = todos.filter(t => {
                                  if (t.is_completed === true || t.status === 'completed') return false;
                                  if (!t.due_date) return true;
                                  try { return !isPast(parseISO(t.due_date)); } catch { return true; }
                                });
                                const focusList = [...overdueTodos, ...pendingTodos].slice(0, 6);
                                if (focusList.length === 0) return (
                                  <div className="col-span-3 flex flex-col items-center justify-center py-4 gap-2">
                                    <CheckCircle2 size={20} className="text-emerald-400" />
                                    <p className="text-xs font-semibold text-slate-400">All clear — nothing pending!</p>
                                  </div>
                                );
                                return focusList.map((t, i) => {
                                  const isOvrd = t.due_date && !t.is_completed
                                    ? (() => { try { return isPast(parseISO(t.due_date)); } catch { return false; } })()
                                    : false;
                                  return (
                                    <motion.div
                                      key={t.id || t._id}
                                      initial={{ opacity: 0, y: 6 }}
                                      animate={{ opacity: 1, y: 0 }}
                                      transition={{ delay: i * 0.04 }}
                                      onClick={() => setSelectedTodo(t)}
                                      className="flex items-center gap-2 px-2.5 py-2 rounded-lg border cursor-pointer group transition-all hover:shadow-sm"
                                      style={{
                                        borderColor: isOvrd ? (isDark ? '#7f1d1d' : '#fecaca') : (isDark ? '#334155' : '#e2e8f0'),
                                        backgroundColor: isOvrd
                                          ? (isDark ? 'rgba(239,68,68,0.06)' : '#fef2f2')
                                          : (isDark ? 'rgba(255,255,255,0.02)' : '#fafafa'),
                                      }}
                                    >
                                      <span
                                        className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 text-[10px] font-black"
                                        style={{
                                          backgroundColor: isOvrd ? `${COLORS.coral}18` : `${COLORS.mediumBlue}12`,
                                          color: isOvrd ? COLORS.coral : COLORS.mediumBlue,
                                        }}
                                      >
                                        {i + 1}
                                      </span>
                                      <span className="flex-1 text-xs font-medium truncate" style={{ color: isDark ? '#e2e8f0' : '#1e293b' }}>
                                        {t.title}
                                      </span>
                                      {isOvrd && (
                                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-red-100 dark:bg-red-900/40 text-red-500 flex-shrink-0">
                                          Late
                                        </span>
                                      )}
                                    </motion.div>
                                  );
                                });
                              })()}
                            </div>
                          </div>

                          {/* Vertical divider */}
                          <div className="hidden lg:block w-px bg-slate-100 dark:bg-slate-700 flex-shrink-0" />

                          {/* Right section: tip + ranking suggestion */}
                          <div className="lg:w-52 flex-shrink-0 flex flex-col justify-between gap-3">
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-2">Quick Tip</p>
                              <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/40">
                                <Zap size={12} className="text-amber-500 mt-0.5 flex-shrink-0" />
                                <p className="text-[11px] font-medium text-amber-800 dark:text-amber-300 leading-relaxed">
                                  {stats.total === 0
                                    ? 'Add your first todo to get started tracking your work.'
                                    : stats.overdue > 0
                                    ? `Knock out ${Math.min(stats.overdue, 3)} overdue items today to boost your score by ${Math.min(stats.overdue, 3) * 10}pts.`
                                    : stats.pending > 3
                                    ? `Focus on 3 todos at a time. You have ${stats.pending} pending — pick the most impactful ones.`
                                    : stats.pending > 0
                                    ? `You're almost there! Complete your last ${stats.pending} ${stats.pending === 1 ? 'todo' : 'todos'} to hit 100%.`
                                    : 'Perfect score! Consider adding new goals to keep the momentum.'
                                  }
                                </p>
                              </div>
                            </div>

                            {stats.overdue > 0 && (
                              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-800/40">
                                <AlertCircle size={12} className="text-red-500 flex-shrink-0" />
                                <p className="text-[11px] font-semibold text-red-600 dark:text-red-400">
                                  {stats.overdue} overdue · health at {stats.healthScore}%
                                </p>
                              </div>
                            )}
                          </div>

                        </div>
                      </div>
                    </SectionCard>
                  </motion.div>

                </motion.div>
              )}

              {/* ─────────────── LOG TAB ─────────────────────────────────────────── */}
              {activeTab === 'log' && (
                <motion.div key="log" variants={containerVariants} initial="hidden" animate="visible" exit={{ opacity: 0 }} className="space-y-4">

                  <motion.div variants={itemVariants} className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
                    <div className="flex-1 min-w-0 max-w-sm">
                      <SearchInput value={logSearch} onChange={setLogSearch} placeholder="Search activity log…" />
                    </div>
                    {showDropdown && (
                      <div className="flex-shrink-0 w-64"><UserSelector /></div>
                    )}
                    <div className="flex-shrink-0">
                      <span className="text-xs font-semibold px-3 py-2 rounded-xl bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                        {filteredLog.length} entries
                      </span>
                    </div>
                  </motion.div>

                  <motion.div variants={itemVariants}>
                    <SectionCard>
                      <CardHeaderRow
                        iconBg={isDark ? 'bg-blue-900/40' : 'bg-blue-50'}
                        icon={<Activity className="h-4 w-4 text-blue-500" />}
                        title="Todo Activity Log"
                        subtitle={
                          selectedUser === 'everyone' ? 'All users'
                            : selectedUser === 'self' ? 'My activity'
                            : (() => { const u = allUsers.find(u => (u.id||u._id) === selectedUser); return u ? `${u.full_name || u.user_name}'s activity` : 'Selected user'; })()
                        }
                        action={
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400">
                            {filteredLog.length}
                          </span>
                        }
                      />

                      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-700/30">
                        <div className="grid gap-4 items-center" style={{ gridTemplateColumns: '1fr 150px 150px 190px' }}>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Todo Title</span>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Owner</span>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Created On</span>
                          <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Event</span>
                        </div>
                      </div>

                      {filteredLog.length === 0 ? (
                        <div className="py-16 flex flex-col items-center gap-3">
                          <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-slate-100 dark:bg-slate-700">
                            <History size={24} className="text-slate-300 dark:text-slate-500" />
                          </div>
                          <p className="text-sm font-semibold text-slate-500 dark:text-slate-400">No activity yet</p>
                          <p className="text-xs font-medium text-slate-400 dark:text-slate-500">Complete or delete a todo and it will appear here</p>
                        </div>
                      ) : (
                        <div style={{ maxHeight: 600, overflowY: 'auto' }} className="todo-slim">
                          <AnimatePresence>
                            {filteredLog.map((entry, idx) => {
                              const ownerName   = resolveUserName(entry.owner_id || entry.created_by_id);
                              const createdDate = entry.created_at
                                ? (() => { try { return format(new Date(entry.created_at), 'MMM d, yyyy'); } catch { return '—'; } })()
                                : '—';
                              return (
                                <motion.div
                                  key={`${entry.id}-${idx}`}
                                  variants={rowVariant}
                                  initial="hidden"
                                  animate="visible"
                                  exit="exit"
                                  className="px-4 py-3 border-b border-slate-100 dark:border-slate-700 last:border-b-0 hover:bg-slate-50 dark:hover:bg-slate-700/30 transition-colors"
                                >
                                  <div className="grid gap-4 items-center" style={{ gridTemplateColumns: '1fr 150px 150px 190px' }}>
                                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate" title={entry.title}>{entry.title}</p>
                                    <div className="flex items-center gap-1.5">
                                      <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 bg-blue-50 dark:bg-blue-900/30">
                                        <UserIcon size={10} className="text-blue-500" />
                                      </div>
                                      <span className="text-xs font-medium truncate text-slate-600 dark:text-slate-300">{ownerName}</span>
                                    </div>
                                    <span className="text-xs font-medium text-slate-400 dark:text-slate-500">{createdDate}</span>
                                    <div className="flex justify-start"><EventBadge entry={entry} /></div>
                                  </div>
                                </motion.div>
                              );
                            })}
                          </AnimatePresence>
                        </div>
                      )}
                    </SectionCard>
                  </motion.div>
                </motion.div>
              )}

            </AnimatePresence>
          </React.Fragment>
        );
        return null;
      })}

      {/* ── AI Duplicate Detection Dialog ─────────────────────────────── */}
      <AIDuplicateDialog
        open={showDupDialog}
        onClose={() => setShowDupDialog(false)}
        groups={dupGroups}
        items={todos || []}
        entityLabel="Todo"
        accentColor="#7c3aed"
        isDark={isDark}
        canDelete={canDeleteTodo}
        canEdit={isAdmin || isManager}
        getTitle={(t) => t.title || 'Untitled'}
        getSubtitle={(t) => t.due_date ? `Due: ${format(new Date(t.due_date), 'MMM dd, yyyy')}` : null}
        getMeta={(t) => [
          t.status ? t.status.replace('_', ' ').toUpperCase() : null,
          t.priority ? t.priority.toUpperCase() : null,
          t.due_date && new Date(t.due_date) < new Date() ? '⚠ OVERDUE' : null,
        ].filter(Boolean)}
        compareFields={(a, b) => [
          { label: 'Title',       a: a.title,       b: b.title },
          { label: 'Description', a: a.description, b: b.description },
          { label: 'Status',      a: a.status,      b: b.status },
          { label: 'Priority',    a: a.priority,    b: b.priority },
          { label: 'Due Date',    a: a.due_date ? format(new Date(a.due_date), 'MMM dd, yyyy') : '—', b: b.due_date ? format(new Date(b.due_date), 'MMM dd, yyyy') : '—' },
          { label: 'Created',     a: a.created_at ? format(new Date(a.created_at), 'MMM dd, yyyy') : '—', b: b.created_at ? format(new Date(b.created_at), 'MMM dd, yyyy') : '—' },
        ]}
        onEdit={(t) => {
          // Open todo inline for edit — set selected todo
          setSelectedTodo(t);
          setShowDupDialog(false);
        }}
        onDelete={(t) => handleDelete(t)}
        onView={(t) => { setSelectedTodo(t); setShowDupDialog(false); }}
      />

      {/* ── Delete Confirmation Modal ───────────────────────────── */}
      <AlertDialog open={deleteModalOpen} onOpenChange={(open) => {
        if (!deleteMutation.isPending) {
          setDeleteModalOpen(open);
          if (!open) setTodoToDelete(null);
        }
      }}>
        <AlertDialogContent className={`max-w-md rounded-2xl ${isDark ? 'bg-slate-900 border-slate-700 text-slate-100' : 'bg-white border-slate-200 text-slate-900'}`}>
          <AlertDialogHeader className="space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 flex items-center justify-center">
              <Trash2 className="w-6 h-6" />
            </div>
            <div>
              <AlertDialogTitle className="text-lg font-bold">Delete Todo?</AlertDialogTitle>
              <AlertDialogDescription className={`text-sm mt-1.5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                Are you sure you want to delete <span className="font-semibold text-slate-800 dark:text-slate-200">"{todoToDelete?.title || 'this todo'}"</span>? This action cannot be undone.
              </AlertDialogDescription>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6 flex items-center gap-2 sm:justify-end">
            <AlertDialogCancel
              onClick={() => { setDeleteModalOpen(false); setTodoToDelete(null); }}
              disabled={deleteMutation.isPending}
              className={`rounded-xl h-10 px-4 text-xs font-semibold ${isDark ? 'border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300' : ''}`}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleConfirmDeleteTodo();
              }}
              disabled={deleteMutation.isPending}
              className="rounded-xl h-10 px-4 text-xs font-semibold bg-red-600 hover:bg-red-700 text-white flex items-center gap-2 shadow-md shadow-red-600/20"
            >
              {deleteMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="w-4 h-4" />
                  Delete Todo
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </motion.div>
  );
}
