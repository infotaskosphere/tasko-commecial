import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap, RefreshCw, CheckSquare, Bell, Calendar, Search, Filter, X,
  Clock, AlertCircle, CheckCircle2, Loader2, Inbox, ArrowUpDown,
  ChevronDown, ChevronUp, Mail, Eye, Trash2, Save, Info,
  TrendingUp, ExternalLink, LayoutList, LayoutGrid, XCircle,
  ClipboardList, Plus, Users, Building2, SlidersHorizontal, FileText,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { useDark } from "@/hooks/useDark";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";

// ─── design tokens ───────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     "#0D3B66",
  mediumBlue:   "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  purple:       "#7C3AED",
  amber:        "#F59E0B",
  red:          "#EF4444",
  orange:       "#F97316",
};

const D_DARK = {
  bg:     "#0F1117",
  card:   "#1A1D27",
  raised: "#21253A",
  border: "#2A2F45",
  text:   "#E2E8F0",
  muted:  "#8892B0",
  dimmer: "#4A5568",
};

// ─── category config ──────────────────────────────────────────────────────────
const CATEGORY_CONFIG = {
  reminder: {
    label:   "Reminder",
    color:   COLORS.deepBlue,
    bg:      "#EFF6FF",
    darkBg:  "rgba(13,59,102,0.20)",
    border:  "#BFDBFE",
    icon:    Bell,
    apiPath: "/email/save-as-reminder",
    saveFn:  (ev) => ({
      event_id: ev.id,
      title: ev.title,
      remind_at: ev.date ? `${ev.date}T${ev.time || "09:00"}:00` : null,
      description: ev.description,
      email_account: ev.email_account,
    }),
  },
  todo: {
    label:   "Todo",
    color:   COLORS.purple,
    bg:      "#F5F3FF",
    darkBg:  "rgba(124,58,237,0.12)",
    border:  "#DDD6FE",
    icon:    CheckSquare,
    apiPath: "/email/save-as-todo",
    saveFn:  (ev) => ({
      event_id: ev.id,
      title: ev.title,
      remind_at: ev.date ? `${ev.date}T${ev.time || "09:00"}:00` : null,
      description: ev.description,
      email_account: ev.email_account,
    }),
  },
  visit: {
    label:   "Visit",
    color:   COLORS.emeraldGreen,
    bg:      "#F0FDF4",
    darkBg:  "rgba(31,175,90,0.12)",
    border:  "#BBF7D0",
    icon:    Calendar,
    apiPath: "/email/save-as-visit",
    saveFn:  (ev) => ({
      event_id: ev.id,
      title: ev.title,
      visit_date: ev.date || null,
      visit_time: ev.time || null,
      description: ev.description,
      email_account: ev.email_account,
    }),
  },
};

const URGENCY_COLORS = {
  high:   { bg: "#FEF2F2", dark: "rgba(239,68,68,0.15)", text: COLORS.red,    border: "#FECACA" },
  medium: { bg: "#FFFBEB", dark: "rgba(245,158,11,0.15)", text: COLORS.amber,  border: "#FDE68A" },
  low:    { bg: "#F0FDF4", dark: "rgba(31,175,90,0.12)", text: COLORS.emeraldGreen, border: "#BBF7D0" },
};

const DEPARTMENTS = [
  { value: "gst",          label: "GST" },
  { value: "income_tax",   label: "INCOME TAX" },
  { value: "accounts",     label: "ACCOUNTS" },
  { value: "tds",          label: "TDS" },
  { value: "roc",          label: "ROC" },
  { value: "trademark",    label: "TRADEMARK" },
  { value: "dsc",          label: "DSC" },
  { value: "other",        label: "OTHER" },
];

const EMPTY_TASK_FORM = {
  title: "", description: "", assigned_to: "unassigned", sub_assignees: [],
  due_date: "", priority: "medium", status: "pending", category: "other", client_id: "",
};

// ─── helpers ──────────────────────────────────────────────────────────────────
function resolveCategory(ev) {
  if (ev.save_category) return ev.save_category;
  const t = (ev.event_type || "").toLowerCase();
  if (t.includes("hearing") || t.includes("deadline") || t.includes("notice")) return "reminder";
  if (t.includes("meeting") || t.includes("visit")) return "visit";
  return "reminder";
}

function isEventPast(ev) {
  if (!ev.date) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return new Date(ev.date) < today;
}

function formatDate(dateStr) {
  if (!dateStr) return "No date";
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", weekday: "short" });
  } catch { return dateStr; }
}

function daysFromNow(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr + "T00:00:00");
  const diff = Math.round((d - today) / 86400000);
  return diff;
}

function getGroupLabel(dateStr) {
  if (!dateStr) return "No Date";
  const days = daysFromNow(dateStr);
  if (days < 0)  return "Past Events";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days <= 7)  return "This Week";
  if (days <= 30) return "This Month";
  return "Later";
}

const GROUP_ORDER = ["Today", "Tomorrow", "This Week", "This Month", "Later", "No Date", "Past Events"];

// ─── animation variants ───────────────────────────────────────────────────────
const containerV = { hidden: {}, visible: { transition: { staggerChildren: 0.04 } } };
const itemV      = { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 320, damping: 26 } } };

// ─── StatCard ─────────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, unit, color, trend, isDark }) {
  const D = isDark ? D_DARK : {};
  return (
    <motion.div variants={itemV} whileHover={{ y: -2 }}
      className="rounded-2xl border p-4"
      style={{ backgroundColor: isDark ? D.card : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider mb-1 truncate" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>{label}</p>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="text-2xl font-black" style={{ color }}>{value}</span>
            {unit && <span className="text-xs font-medium" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>{unit}</span>}
          </div>
          {trend && <p className="text-[11px] font-medium mt-1 truncate" style={{ color: isDark ? D_DARK.dimmer : "#94a3b8" }}>{trend}</p>}
        </div>
        <div className="p-2.5 rounded-xl flex-shrink-0" style={{ backgroundColor: `${color}18` }}>
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
      </div>
    </motion.div>
  );
}

// ─── AddTaskModal ──────────────────────────────────────────────────────────────
function AddTaskModal({ event, isDark, onClose, canAssignTasks, users, clients, onTaskCreated }) {
  const D = isDark ? D_DARK : {};
  const [form, setForm] = useState({
    ...EMPTY_TASK_FORM,
    title: event?.title || "",
    due_date: event?.date || "",
    description: event?.description || "",
  });
  const [saving, setSaving] = useState(false);
  const [subOpen, setSubOpen] = useState(false);
  const [clientOpen, setClientOpen] = useState(false);
  const [clientSearch, setClientSearch] = useState("");

  const filteredClients = clients.filter(c =>
    c.company_name?.toLowerCase().includes(clientSearch.toLowerCase())
  );

  const toggleSub = (uid) => {
    setForm(p => ({
      ...p,
      sub_assignees: p.sub_assignees.includes(uid)
        ? p.sub_assignees.filter(id => id !== uid)
        : [...p.sub_assignees, uid],
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) { toast.error("Title is required"); return; }
    setSaving(true);
    try {
      const res = await api.post("/tasks", {
        ...form,
        assigned_to: form.assigned_to === "unassigned" ? null : form.assigned_to,
        due_date: form.due_date || null,
        client_id: form.client_id || null,
        sub_assignees: form.sub_assignees || [],
      });
      // Flag the source Action Center event as saved on the backend so it
      // stops reappearing on future syncs — /tasks itself has no concept of
      // email-extracted events, so this has to happen as a follow-up call.
      if (event?.id) {
        try {
          await api.post(`/email/events/${event.id}/mark-saved`, {
            category: "task",
            saved_id: res?.data?.id || res?.data?._id || null,
          });
        } catch (_) { /* best-effort — task itself is already created */ }
      }
      toast.success("✓ Task created");
      onTaskCreated?.();
      onClose();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to create task");
    } finally { setSaving(false); }
  };

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-emerald-900/50 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ type: "spring", stiffness: 340, damping: 26 }}
        className="relative w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl shadow-2xl overflow-hidden"
        style={{ backgroundColor: isDark ? D_DARK.bg : "#f8fafc" }}
      >
        {/* Header */}
        <div className="flex-shrink-0 px-6 pt-5 pb-4"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)` }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-white/20 flex items-center justify-center flex-shrink-0">
              <ClipboardList className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-lg font-bold text-white">Create Task</h2>
              <p className="text-white/60 text-xs mt-0.5">From Action Center event</p>
            </div>
            <button onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/10 hover:bg-white/20 flex items-center justify-center transition-all flex-shrink-0">
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 min-h-0">
          <form id="ac-task-form" onSubmit={handleSubmit}>

            {/* Section 1 — Task Details */}
            <div className="mx-5 mt-4 mb-1 rounded-2xl overflow-hidden border"
              style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
              <div className="flex items-center gap-2 px-4 py-2.5 border-b"
                style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9", backgroundColor: isDark ? D_DARK.raised : "#f8fafc" }}>
                <FileText className="w-3.5 h-3.5" style={{ color: COLORS.mediumBlue }} />
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Task Details</span>
              </div>
              <div className="p-4 space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>
                    Task Title <span className="text-red-400">*</span>
                  </label>
                  <input
                    value={form.title}
                    onChange={e => setForm(p => ({ ...p, title: e.target.value }))}
                    placeholder="e.g. Reply to Examination Report"
                    required
                    className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                    style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Description</label>
                  <textarea
                    value={form.description}
                    onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                    rows={2}
                    placeholder="Add notes or checklist items..."
                    className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none transition-colors"
                    style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}
                  />
                </div>
              </div>
            </div>

            {/* Section 2 — Assignment & Schedule */}
            <div className="mx-5 mt-3 mb-1 rounded-2xl overflow-hidden border"
              style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
              <div className="flex items-center gap-2 px-4 py-2.5 border-b"
                style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9", backgroundColor: isDark ? D_DARK.raised : "#f8fafc" }}>
                <Calendar className="w-3.5 h-3.5 text-emerald-500" />
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Assignment &amp; Schedule</span>
              </div>
              <div className="p-4 space-y-3">
                {/* Client + Due Date row */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Client dropdown */}
                  <div className="space-y-1 relative">
                    <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Client</label>
                    <button type="button" onClick={() => { setClientOpen(v => !v); setSubOpen(false); }}
                      className="w-full flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border text-left focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                      style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: form.client_id ? (isDark ? D_DARK.text : "#1e293b") : (isDark ? D_DARK.dimmer : "#94a3b8") }}>
                      <Building2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />
                      <span className="truncate flex-1">
                        {form.client_id ? (clients.find(c => c.id === form.client_id)?.company_name || "Client") : "Select client…"}
                      </span>
                      <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
                    </button>
                    {clientOpen && (
                      <div className="absolute left-0 top-full mt-1 z-50 w-full rounded-xl border shadow-xl overflow-hidden"
                        style={{ backgroundColor: isDark ? D_DARK.card : "#fff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
                        <div className="p-2 border-b" style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9" }}>
                          <input autoFocus value={clientSearch} onChange={e => setClientSearch(e.target.value)}
                            placeholder="Search clients…" className="w-full text-xs px-2 py-1.5 rounded-lg border focus:outline-none"
                            style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }} />
                        </div>
                        <div className="max-h-40 overflow-y-auto py-1">
                          <button type="button" onClick={() => { setForm(p => ({ ...p, client_id: "" })); setClientOpen(false); setClientSearch(""); }}
                            className="w-full text-left px-3 py-2 text-xs italic transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                            style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>No Client</button>
                          {filteredClients.map(c => (
                            <button key={c.id} type="button"
                              onClick={() => { setForm(p => ({ ...p, client_id: c.id })); setClientOpen(false); setClientSearch(""); }}
                              className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                              style={{ color: isDark ? D_DARK.text : "#1e293b" }}>
                              {form.client_id === c.id && <CheckCircle2 className="w-3 h-3 text-blue-500 flex-shrink-0" />}
                              <span className="truncate">{c.company_name}</span>
                            </button>
                          ))}
                          {filteredClients.length === 0 && <p className="px-3 py-2 text-xs text-center" style={{ color: isDark ? D_DARK.dimmer : "#94a3b8" }}>No clients found</p>}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Due date */}
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Due Date</label>
                    <input type="date" value={form.due_date} onChange={e => setForm(p => ({ ...p, due_date: e.target.value }))}
                      className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                      style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }} />
                  </div>
                </div>

                {/* Assignee + Co-assignees — only shown if canAssignTasks */}
                {canAssignTasks && (
                  <div className="grid grid-cols-2 gap-3">
                    {/* Primary Assignee */}
                    <div className="space-y-1">
                      <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Assignee</label>
                      <select value={form.assigned_to} onChange={e => setForm(p => ({ ...p, assigned_to: e.target.value }))}
                        className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                        style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}>
                        <option value="unassigned">— Unassigned</option>
                        {users.map(u => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                      </select>
                    </div>

                    {/* Co-assignees */}
                    <div className="space-y-1 relative">
                      <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Co-assignees</label>
                      <button type="button" onClick={() => { setSubOpen(v => !v); setClientOpen(false); }}
                        className="w-full flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl border text-left focus:outline-none transition-colors"
                        style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: form.sub_assignees.length > 0 ? (isDark ? D_DARK.text : "#1e293b") : (isDark ? D_DARK.dimmer : "#94a3b8") }}>
                        <Users className="w-3.5 h-3.5 flex-shrink-0" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />
                        <span className="truncate flex-1 text-sm">
                          {form.sub_assignees.length > 0 ? `${form.sub_assignees.length} selected` : "None selected"}
                        </span>
                        <ChevronDown className="w-3.5 h-3.5 flex-shrink-0 opacity-50" />
                      </button>
                      {subOpen && (
                        <div className="absolute left-0 top-full mt-1 z-50 w-full rounded-xl border shadow-xl p-2"
                          style={{ backgroundColor: isDark ? D_DARK.card : "#fff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
                          <p className="text-[10px] font-bold uppercase tracking-widest px-1 mb-2" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>Add Co-assignees</p>
                          <div className="space-y-0.5 max-h-40 overflow-y-auto">
                            {users.filter(u => u.id !== form.assigned_to).map(u => (
                              <label key={u.id} className="flex items-center gap-2.5 cursor-pointer px-2 py-1.5 rounded-lg transition-colors hover:bg-slate-50 dark:hover:bg-slate-700">
                                <input type="checkbox" checked={form.sub_assignees.includes(u.id)} onChange={() => toggleSub(u.id)}
                                  className="w-3.5 h-3.5 rounded" />
                                <span className="text-xs" style={{ color: isDark ? D_DARK.text : "#374151" }}>{u.full_name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Section 3 — Classification */}
            <div className="mx-5 mt-3 mb-4 rounded-2xl overflow-hidden border"
              style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
              <div className="flex items-center gap-2 px-4 py-2.5 border-b"
                style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9", backgroundColor: isDark ? D_DARK.raised : "#f8fafc" }}>
                <SlidersHorizontal className="w-3.5 h-3.5 text-violet-500" />
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Classification</span>
              </div>
              <div className="p-4 space-y-3">
                {/* Department chips */}
                <div className="space-y-1.5">
                  <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Department</label>
                  <div className="flex flex-wrap gap-1.5">
                    {DEPARTMENTS.map(dept => (
                      <button key={dept.value} type="button"
                        onClick={() => setForm(p => ({ ...p, category: dept.value }))}
                        className="h-7 px-3 rounded-lg text-[10px] font-bold uppercase tracking-wide transition-all border"
                        style={form.category === dept.value
                          ? { background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})`, color: "#fff", border: "1px solid transparent", boxShadow: "0 2px 8px rgba(13,59,102,0.3)" }
                          : { backgroundColor: isDark ? D_DARK.raised : "#fff", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.muted : "#64748b" }}>
                        {dept.label}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Priority + Status */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Priority</label>
                    <select value={form.priority} onChange={e => setForm(p => ({ ...p, priority: e.target.value }))}
                      className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                      style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}>
                      <option value="low">🟢 Low</option>
                      <option value="medium">🟡 Medium</option>
                      <option value="high">🔴 High</option>
                      <option value="critical">🚨 Critical</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] font-semibold" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Status</label>
                    <select value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))}
                      className="w-full px-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400 transition-colors"
                      style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}>
                      <option value="pending">📋 To Do</option>
                      <option value="in_progress">⚡ In Progress</option>
                      <option value="completed">✅ Completed</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </form>
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 px-5 py-3.5 border-t flex items-center justify-between"
          style={{ backgroundColor: isDark ? D_DARK.card : "#fff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm rounded-xl border font-medium transition-all"
            style={{ borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.muted : "#64748b", backgroundColor: isDark ? D_DARK.raised : "#f8fafc" }}>
            Cancel
          </button>
          <button type="submit" form="ac-task-form" disabled={saving}
            className="flex items-center gap-2 px-5 py-2 text-sm rounded-xl font-bold text-white transition-all active:scale-95 shadow-lg"
            style={{ background: saving ? "#9CA3AF" : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Saving…</> : <><Plus className="w-4 h-4" /> Create Task</>}
          </button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}


function EventCard({ event, isDark, savedKeys, onSaved, onDismiss, onAddTask, viewMode }) {
  const D = isDark ? D_DARK : {};
  const cat     = resolveCategory(event);
  const catCfg  = CATEGORY_CONFIG[cat] || CATEGORY_CONFIG.reminder;
  const CatIcon = catCfg.icon;
  const urg     = URGENCY_COLORS[event.urgency] || URGENCY_COLORS.low;
  const past    = isEventPast(event);
  const days    = daysFromNow(event.date);
  const key     = event.id || `${event.title}::${event.date}`;
  const saved   = savedKeys.has(key);
  const [saving, setSaving] = useState(null);
  const [override, setOverride] = useState(cat);
  const isList = viewMode === "list";

  const handleSave = async () => {
    if (saving || saved) return;
    const cfg = CATEGORY_CONFIG[override] || catCfg;
    setSaving(override);
    try {
      await api.post(cfg.apiPath, cfg.saveFn(event));
      toast.success(`✓ Saved as ${cfg.label}`);
      onSaved(key);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Save failed");
    } finally { setSaving(null); }
  };

  // ── LIST VIEW LAYOUT ───────────────────────────────────────────────────────
  if (isList) {
    return (
      <motion.div variants={itemV} layout
        className="rounded-xl border overflow-hidden transition-all"
        style={{
          backgroundColor: isDark ? D_DARK.card : "#ffffff",
          borderColor: saved ? catCfg.color + "40" : isDark ? D_DARK.border : "#e2e8f0",
          opacity: past && !saved ? 0.7 : 1,
          borderLeft: `3px solid ${saved ? catCfg.color : past ? "#e2e8f0" : catCfg.color}`,
        }}>
        <div className="px-4 py-3 flex items-center gap-3">
          {/* Category icon */}
          <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ backgroundColor: isDark ? catCfg.darkBg : catCfg.bg }}>
            <CatIcon className="w-3.5 h-3.5" style={{ color: catCfg.color }} />
          </div>

          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="text-sm font-semibold truncate" style={{ color: isDark ? D_DARK.text : "#1e293b" }}>
                {event.title || "Untitled Event"}
              </p>
              {event.urgency && (
                <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full uppercase flex-shrink-0"
                  style={{ backgroundColor: isDark ? urg.dark : urg.bg, color: urg.text, border: `1px solid ${urg.border}` }}>
                  {event.urgency}
                </span>
              )}
              {saved && (
                <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex items-center gap-1 flex-shrink-0"
                  style={{ backgroundColor: isDark ? "rgba(31,175,90,0.15)" : "#dcfce7", color: COLORS.emeraldGreen }}>
                  <CheckCircle2 className="w-2.5 h-2.5" /> Saved
                </span>
              )}
            </div>
            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
              {event.date && (
                <span className="text-xs flex items-center gap-1" style={{ color: days !== null && days <= 3 && !past ? COLORS.red : (isDark ? D_DARK.muted : "#64748b") }}>
                  <Clock className="w-3 h-3" />
                  {formatDate(event.date)}
                  {days !== null && !past && days <= 7 && (
                    <span className="font-bold ml-0.5" style={{ color: days === 0 ? COLORS.red : days <= 3 ? COLORS.orange : COLORS.amber }}>
                      {days === 0 ? "(Today!)" : days === 1 ? "(Tomorrow)" : `(${days}d)`}
                    </span>
                  )}
                </span>
              )}
              {event.tm_app_no && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                  style={{ backgroundColor: isDark ? "rgba(124,58,237,0.12)" : "#F5F3FF", color: COLORS.purple }}>
                  TM: {event.tm_app_no}
                </span>
              )}
              {event.event_type && (
                <span className="text-[10px] font-medium" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>
                  {event.event_type}
                </span>
              )}
            </div>
          </div>

          {/* Actions — always visible in list view */}
          {!past && !saved && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="text-xs font-medium hidden sm:block" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Save as:</span>
              {Object.entries(CATEGORY_CONFIG).map(([k, cfg]) => {
                const Ic = cfg.icon;
                const active = override === k;
                return (
                  <button key={k} onClick={() => setOverride(k)}
                    className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold border-2 transition-all"
                    style={{
                      borderColor: active ? cfg.color : "transparent",
                      backgroundColor: active ? (isDark ? cfg.darkBg : cfg.bg) : (isDark ? D_DARK.raised : "#f1f5f9"),
                      color: active ? cfg.color : (isDark ? D_DARK.muted : "#64748b"),
                    }}>
                    <Ic className="w-3 h-3" />
                    <span className="hidden sm:inline">{cfg.label}</span>
                  </button>
                );
              })}
              <button onClick={handleSave} disabled={!!saving}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white transition-all active:scale-95"
                style={{ background: saving ? "#9CA3AF" : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                <span className="hidden sm:inline">{saving ? "…" : "Save"}</span>
              </button>
            </div>
          )}

          {/* Add Task button — opens full task modal */}
          <button
            onClick={() => onAddTask(event)}
            title="Create a task from this event"
            className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold border transition-all hover:scale-105"
            style={{
              borderColor: isDark ? "#2A2F45" : "#e2e8f0",
              backgroundColor: isDark ? "#21253A" : "#f8fafc",
              color: isDark ? "#8892B0" : "#64748b",
            }}>
            <ClipboardList className="w-3 h-3" />
            <span className="hidden sm:inline">Task</span>
          </button>

          {/* Close/Dismiss button — always visible */}
          <button
            onClick={() => onDismiss(key, event)}
            title="Dismiss / Remove from Action Center"
            className="flex-shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:scale-110"
            style={{
              backgroundColor: isDark ? "rgba(239,68,68,0.12)" : "#FEF2F2",
              color: isDark ? "#f87171" : "#ef4444",
            }}>
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </motion.div>
    );
  }

  // ── BOARD VIEW LAYOUT (original card) ─────────────────────────────────────
  return (
    <motion.div variants={itemV} layout
      className="rounded-2xl border overflow-hidden transition-all"
      style={{
        backgroundColor: isDark ? D_DARK.card : "#ffffff",
        borderColor: saved ? catCfg.color + "40" : past ? (isDark ? D_DARK.border : "#e2e8f0") : (isDark ? D_DARK.border : "#e2e8f0"),
        opacity: past && !saved ? 0.7 : 1,
      }}>
      {/* Top accent bar */}
      <div className="h-0.5 w-full" style={{ backgroundColor: saved ? catCfg.color : past ? "#e2e8f0" : catCfg.color + "80" }} />

      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Category icon */}
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 mt-0.5"
            style={{ backgroundColor: isDark ? catCfg.darkBg : catCfg.bg }}>
            <CatIcon className="w-4 h-4" style={{ color: catCfg.color }} />
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0 overflow-hidden">
            <div className="flex items-start justify-between gap-2 mb-1">
              <p className="text-sm font-bold leading-tight break-words" style={{ color: isDark ? D_DARK.text : "#1e293b" }}>
                {event.title || "Untitled Event"}
              </p>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {/* Urgency badge */}
                {event.urgency && (
                  <span className="text-[10px] font-black px-2 py-0.5 rounded-full uppercase"
                    style={{ backgroundColor: isDark ? urg.dark : urg.bg, color: urg.text, border: `1px solid ${urg.border}` }}>
                    {event.urgency}
                  </span>
                )}
                {saved && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1"
                    style={{ backgroundColor: isDark ? "rgba(31,175,90,0.15)" : "#dcfce7", color: COLORS.emeraldGreen }}>
                    <CheckCircle2 className="w-3 h-3" /> Saved
                  </span>
                )}
                {past && !saved && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: isDark ? D_DARK.raised : "#f1f5f9", color: isDark ? D_DARK.muted : "#94a3b8" }}>
                    Past
                  </span>
                )}
                {/* ── Close / Dismiss button ── */}
                <button
                  onClick={() => onDismiss(key, event)}
                  title="Dismiss / Remove from Action Center"
                  className="w-6 h-6 rounded-lg flex items-center justify-center transition-all hover:scale-110"
                  style={{
                    backgroundColor: isDark ? "rgba(239,68,68,0.12)" : "#FEF2F2",
                    color: isDark ? "#f87171" : "#ef4444",
                  }}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Date & time row */}
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              {event.date ? (
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3 flex-shrink-0" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />
                  <span className="text-xs font-semibold" style={{ color: days !== null && days <= 3 && !past ? COLORS.red : (isDark ? D_DARK.muted : "#64748b") }}>
                    {formatDate(event.date)}
                    {days !== null && !past && days <= 7 && (
                      <span className="ml-1 font-bold" style={{ color: days === 0 ? COLORS.red : days <= 3 ? COLORS.orange : COLORS.amber }}>
                        {days === 0 ? "(Today!)" : days === 1 ? "(Tomorrow)" : `(${days}d)`}
                      </span>
                    )}
                  </span>
                </div>
              ) : (
                <span className="text-xs" style={{ color: isDark ? D_DARK.dimmer : "#94a3b8" }}>No date extracted</span>
              )}
              {event.time && (
                <span className="text-xs font-medium" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>@ {event.time}</span>
              )}
              {event.email_account && (
                <span className="text-[10px] flex items-center gap-1" style={{ color: isDark ? D_DARK.dimmer : "#94a3b8" }}>
                  <Mail className="w-3 h-3" /> {event.email_account}
                </span>
              )}
            </div>

            {/* Description */}
            {event.description && (
              <p className="text-xs leading-relaxed mb-3 line-clamp-2" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>
                {event.description}
              </p>
            )}

            {/* Event type + TM app no */}
            <div className="flex items-center gap-2 flex-wrap">
              {event.event_type && (
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-lg border"
                  style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.muted : "#64748b" }}>
                  {event.event_type}
                </span>
              )}
              {event.tm_app_no && (
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-lg"
                  style={{ backgroundColor: isDark ? "rgba(124,58,237,0.12)" : "#F5F3FF", color: COLORS.purple }}>
                  TM: {event.tm_app_no}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Action row */}
        {!past && !saved && (
          <div className="mt-3 pt-3 border-t flex items-center gap-2" style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9" }}>
            <span className="text-xs font-medium mr-1" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Save as:</span>
            {Object.entries(CATEGORY_CONFIG).map(([k, cfg]) => {
              const Ic = cfg.icon;
              const active = override === k;
              return (
                <button key={k} onClick={() => setOverride(k)}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-semibold border-2 transition-all"
                  style={{
                    borderColor: active ? cfg.color : "transparent",
                    backgroundColor: active ? (isDark ? cfg.darkBg : cfg.bg) : (isDark ? D_DARK.raised : "#f8fafc"),
                    color: active ? cfg.color : (isDark ? D_DARK.muted : "#64748b"),
                  }}>
                  <Ic className="w-3 h-3" /> {cfg.label}
                </button>
              );
            })}
            <button onClick={handleSave} disabled={!!saving}
              className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white transition-all active:scale-95"
              style={{ background: saving ? "#9CA3AF" : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
              {saving
                ? <><Loader2 className="w-3 h-3 animate-spin" /> Saving…</>
                : <><Save className="w-3 h-3" /> Save</>}
            </button>
          </div>
        )}
        {saved && (
          <div className="mt-3 pt-3 border-t flex items-center gap-2" style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9" }}>
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            <span className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
              Saved as {CATEGORY_CONFIG[cat]?.label || cat}
            </span>
          </div>
        )}

        {/* Add Task button — opens full task modal */}
        <div className="mt-2 pt-2 border-t" style={{ borderColor: isDark ? D_DARK.border : "#f1f5f9" }}>
          <button onClick={() => onAddTask(event)}
            className="flex items-center gap-1.5 text-xs font-semibold px-2 py-1 rounded-lg border transition-all hover:scale-105"
            style={{ borderColor: isDark ? "#2A2F45" : "#e2e8f0", backgroundColor: isDark ? "#21253A" : "#f8fafc", color: isDark ? "#8892B0" : "#64748b" }}>
            <ClipboardList className="w-3 h-3" /> Add Task
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── main page ────────────────────────────────────────────────────────────────
export default function ActionCenter() {
  const isDark = useDark();
  const D = isDark ? D_DARK : {};
  const { user: authUser, hasPermission } = useAuth();

  const isAdmin = authUser?.role === "admin";
  const canAssignTasks = isAdmin || hasPermission("can_assign_tasks");

  const [events,       setEvents]      = useState([]);
  const [loading,      setLoading]     = useState(true);
  const [scanning,     setScanning]    = useState(false);
  const [retroSyncing, setRetroSyncing]= useState(false);
  const [showRetroMenu,setShowRetroMenu]= useState(false);
  const [retroMenuPos, setRetroMenuPos] = useState(null);
  const retroBtnRef = useRef(null);
  const [searchQ,      setSearchQ]     = useState("");
  const [filterCat,    setFilterCat]   = useState("all");
  const [filterUrgency,setFilterUrgency]= useState("all");
  const [sortBy,       setSortBy]      = useState("date_asc");
  const [showPast,     setShowPast]    = useState(false);
  const [savedKeys,    setSavedKeys]   = useState(() => new Set());
  const [dismissedKeys,setDismissedKeys]= useState(() => new Set());
  const [collapsed,    setCollapsed]   = useState({});
  const [viewMode,     setViewMode]    = useState("list"); // "list" | "board"

  // Users & clients for task form
  const [users,   setUsers]   = useState([]);
  const [clients, setClients] = useState([]);
  // Task modal state
  const [taskModalEvent, setTaskModalEvent] = useState(null);

  // Load stored events from backend
  const loadEvents = useCallback(async (force = false) => {
    setLoading(true);
    try {
      const url = force
        ? "/email/extract-events?force_refresh=true&limit=100"
        : "/email/importer/events?limit=200";
      const res = await api.get(url, { timeout: force ? 90000 : 20000 });
      setEvents(res.data || []);
      if (force) toast.success(`✓ Scan complete — ${(res.data || []).length} events loaded`);
    } catch (err) {
      if (err?.response?.status === 404 || err?.response?.status === 422) {
        // fallback: use extract-events endpoint without force
        try {
          const res2 = await api.get("/email/extract-events?force_refresh=true&limit=100", { timeout: 60000 });
          setEvents(res2.data || []);
        } catch { toast.error("Could not load events"); }
      } else {
        toast.error(err?.response?.data?.detail || "Failed to load events");
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadEvents(false); }, [loadEvents]);

  // Load users & clients for the full task form
  useEffect(() => {
    api.get("/users").then(r => setUsers(r.data || [])).catch(() => {});
    api.get("/clients?limit=200").then(r => setClients(r.data?.clients || r.data || [])).catch(() => {});
  }, []);

  const handleScanFresh = async () => {
    setScanning(true);
    try { await loadEvents(true); }
    finally { setScanning(false); }
  };

  // Retrospective sync — re-scans further back than the normal rolling
  // window across ALL connected accounts. Results are merged into the
  // existing list (never replace it), keyed by event id, so nothing already
  // on screen disappears and nothing already-seen gets duplicated. The
  // backend itself also skips any email it has already imported (matched
  // by Message-ID), so this is safe to run as many times as needed.
  const RETRO_PRESETS = [
    { daysBack: 30,  label: "Last 30 days" },
    { daysBack: 90,  label: "Last 90 days" },
    { daysBack: 365, label: "Last 1 year" },
    { daysBack: null, label: "All time" },
  ];

  // Rendered through a portal (see header below) because this button lives
  // inside a header div with overflow-hidden (used for the decorative corner
  // glow), which was clipping/hiding a normally-positioned dropdown.
  const toggleRetroMenu = () => {
    if (!showRetroMenu && retroBtnRef.current) {
      const r = retroBtnRef.current.getBoundingClientRect();
      setRetroMenuPos({ top: r.bottom + 6, left: r.right - 192 }); // 192px = menu width (w-48)
    }
    setShowRetroMenu(v => !v);
  };

  useEffect(() => {
    if (!showRetroMenu) return;
    const close = () => setShowRetroMenu(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [showRetroMenu]);

  const handleSyncRetro = async (preset) => {
    setShowRetroMenu(false);
    setRetroSyncing(true);
    try {
      const sinceDate = preset.daysBack
        ? new Date(Date.now() - preset.daysBack * 86400000).toISOString().slice(0, 10)
        : "1970-01-01";
      const res = await api.get(
        `/email/extract-events?force_refresh=true&limit=300&since_date=${sinceDate}`,
        { timeout: 120000 }
      );
      const incoming = res.data || [];
      setEvents(prev => {
        const existingIds = new Set(prev.map(e => e.id));
        const newOnes = incoming.filter(e => !existingIds.has(e.id));
        return [...prev, ...newOnes];
      });
      const newCount = incoming.filter(e => !events.some(ev => ev.id === e.id)).length;
      toast.success(
        incoming.length === 0
          ? `No legal events found for ${preset.label.toLowerCase()}`
          : `✓ Retrospective sync complete — ${newCount} new event${newCount !== 1 ? "s" : ""} added (duplicates auto-skipped)`
      );
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Retrospective sync failed");
    } finally {
      setRetroSyncing(false);
    }
  };

  const handleEventSaved = useCallback((key) => {
    setSavedKeys(prev => { const s = new Set(prev); s.add(key); return s; });
    // Remove from Action Center after a short delay so user sees the "Saved" flash
    setTimeout(() => {
      setDismissedKeys(prev => { const s = new Set(prev); s.add(key); return s; });
    }, 1200);
  }, []);

  const handleTaskCreated = useCallback(() => {
    if (!taskModalEvent) return;
    const key = taskModalEvent.id || `${taskModalEvent.title}::${taskModalEvent.date}`;
    setEvents(prev => prev.map(e => {
      const k = e.id || `${e.title}::${e.date}`;
      return k === key ? { ...e, save_category: "task" } : e;
    }));
    handleEventSaved(key);
  }, [taskModalEvent, handleEventSaved]);

  const handleDismiss = useCallback(async (key, event) => {
    // Optimistically remove from UI
    setDismissedKeys(prev => { const s = new Set(prev); s.add(key); return s; });
    // Remove from backend so it won't reappear after next load
    if (event?.id) {
      try { await api.delete(`/email/events/${event.id}`); }
      catch (_) { /* best-effort — UI already dismissed */ }
    }
    toast.info("Event removed from Action Center");
  }, []);

  // Filtered + sorted events
  const processed = useMemo(() => {
    let arr = [...events];

    // Dismissed filter — remove events the user has closed
    arr = arr.filter(e => !dismissedKeys.has(e.id || `${e.title}::${e.date}`));

    // Search
    if (searchQ.trim()) {
      const q = searchQ.toLowerCase();
      arr = arr.filter(e =>
        (e.title || "").toLowerCase().includes(q) ||
        (e.description || "").toLowerCase().includes(q) ||
        (e.event_type || "").toLowerCase().includes(q) ||
        (e.email_account || "").toLowerCase().includes(q)
      );
    }

    // Category
    if (filterCat !== "all") {
      arr = arr.filter(e => resolveCategory(e) === filterCat);
    }

    // Urgency
    if (filterUrgency !== "all") {
      arr = arr.filter(e => (e.urgency || "low") === filterUrgency);
    }

    // Past filter
    if (!showPast) {
      arr = arr.filter(e => !isEventPast(e) || savedKeys.has(e.id || `${e.title}::${e.date}`));
    }

    // Sort
    arr.sort((a, b) => {
      if (sortBy === "date_asc")  return (a.date || "9999") > (b.date || "9999") ? 1 : -1;
      if (sortBy === "date_desc") return (a.date || "") < (b.date || "") ? 1 : -1;
      if (sortBy === "urgency")   {
        const u = { high: 0, medium: 1, low: 2 };
        return (u[a.urgency] ?? 2) - (u[b.urgency] ?? 2);
      }
      return 0;
    });

    return arr;
  }, [events, searchQ, filterCat, filterUrgency, showPast, sortBy, savedKeys, dismissedKeys]);

  // Group by date bucket
  const grouped = useMemo(() => {
    const map = {};
    for (const ev of processed) {
      const grp = getGroupLabel(ev.date);
      if (!map[grp]) map[grp] = [];
      map[grp].push(ev);
    }
    return GROUP_ORDER.filter(g => map[g]?.length).map(g => ({ label: g, events: map[g] }));
  }, [processed]);

  // Stats
  const futureEvents  = useMemo(() => events.filter(e => !isEventPast(e)), [events]);
  const todayEvents   = useMemo(() => events.filter(e => daysFromNow(e?.date) === 0), [events]);
  const urgentEvents  = useMemo(() => futureEvents.filter(e => e.urgency === "high"), [futureEvents]);
  const reminderCount = useMemo(() => futureEvents.filter(e => resolveCategory(e) === "reminder").length, [futureEvents]);

  const toggleGroup = (label) => setCollapsed(prev => ({ ...prev, [label]: !prev[label] }));

  const CAT_FILTERS = [
    { val: "all",      label: "All" },
    { val: "reminder", label: "Reminders", color: COLORS.deepBlue },
    { val: "todo",     label: "Todos",     color: COLORS.purple },
    { val: "visit",    label: "Visits",    color: COLORS.emeraldGreen },
    { val: "task",     label: "Tasks",     color: COLORS.amber },
  ];

  return (
    <>
    <motion.div className="min-h-full space-y-5"
      style={{ background: isDark ? D_DARK.bg : "#f8fafc" }}
      variants={containerV} initial="hidden" animate="visible">

      {/* ══ HEADER ══ */}
      <motion.div variants={itemV}>
        <div className="relative overflow-hidden rounded-2xl px-6 py-5"
          style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`, boxShadow: "0 8px 32px rgba(13,59,102,0.25)" }}>
          <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
          <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <p className="text-white/60 text-xs font-medium uppercase tracking-widest mb-1">Email Intelligence</p>
              <h1 className="text-2xl font-bold text-white tracking-tight flex items-center gap-2">
                <Zap className="w-6 h-6 text-yellow-300" /> Action Center
              </h1>
              <p className="text-white/60 text-sm mt-1">
                All email-linked due dates, hearings &amp; events — review and save in one place
              </p>
            </div>
            <div className="grid grid-cols-3 gap-2 w-[520px] max-w-full flex-shrink-0 min-w-0">
              <button onClick={() => { window.location.href = "/settings/email"; }}
                className="w-full min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95 whitespace-nowrap"
                style={{ backgroundColor: "rgba(255,255,255,0.10)", borderColor: "rgba(255,255,255,0.22)", color: "#ffffff" }}>
                <Mail className="w-3.5 h-3.5" /> Email Settings
              </button>
              <button onClick={handleScanFresh} disabled={scanning || loading}
                className="w-full min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95 whitespace-nowrap"
                style={{ backgroundColor: "rgba(255,255,255,0.15)", borderColor: "rgba(255,255,255,0.25)", color: "#ffffff" }}>
                {scanning
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning…</>
                  : <><RefreshCw className="w-3.5 h-3.5" /> Scan Fresh</>}
              </button>
              <div className="relative w-full min-w-0">
                <button ref={retroBtnRef} onClick={toggleRetroMenu} disabled={retroSyncing}
                  title="Re-scan older mail across all connected accounts — already-imported emails are skipped automatically"
                  className="w-full min-w-0 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95 whitespace-nowrap"
                  style={{ backgroundColor: "rgba(255,255,255,0.15)", borderColor: "rgba(255,255,255,0.25)", color: "#ffffff" }}>
                  {retroSyncing
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Syncing…</>
                    : <><Clock className="w-3.5 h-3.5" /> Sync Older Mail <ChevronDown className="w-3.5 h-3.5" /></>}
                </button>
                {showRetroMenu && retroMenuPos && createPortal(
                  <>
                    <div className="fixed inset-0 z-[9998]" onClick={() => setShowRetroMenu(false)} />
                    <div className="fixed z-[9999] w-48 rounded-xl border shadow-lg overflow-hidden"
                      style={{ top: retroMenuPos.top, left: retroMenuPos.left, backgroundColor: isDark ? D.card : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0" }}>
                      {RETRO_PRESETS.map(preset => (
                        <button key={preset.label} onClick={() => handleSyncRetro(preset)}
                          className="w-full text-left px-3 py-2 text-xs font-semibold transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                          style={{ color: isDark ? D.text : "#1e293b" }}>
                          {preset.label}
                        </button>
                      ))}
                      <div className="px-3 py-1.5 text-[10px] border-t" style={{ color: isDark ? D.muted : "#94a3b8", borderColor: isDark ? D.border : "#f1f5f9" }}>
                        Duplicates skipped automatically
                      </div>
                    </div>
                  </>,
                  document.body
                )}
              </div>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ══ STAT CARDS ══ */}
      <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3" variants={itemV}>
        <StatCard icon={Inbox}       label="Total Events"  value={futureEvents.length}  unit="upcoming"    color={COLORS.deepBlue}     trend={`${events.length} total · ${events.length - futureEvents.length} past`} isDark={isDark} />
        <StatCard icon={Clock}       label="Due Today"     value={todayEvents.length}   unit="events"      color={COLORS.red}          trend={todayEvents.length > 0 ? "Needs attention!" : "Clear today"} isDark={isDark} />
        <StatCard icon={AlertCircle} label="Urgent"        value={urgentEvents.length}  unit="high priority" color={COLORS.orange}    trend="High urgency events" isDark={isDark} />
        <StatCard icon={Bell}        label="Reminders"     value={reminderCount}        unit="hearings/deadlines" color={COLORS.mediumBlue} trend="From email scans" isDark={isDark} />
      </motion.div>

      {/* ══ FILTER BAR ══ */}
      <motion.div variants={itemV}>
        <div className="rounded-2xl border p-3 flex flex-col sm:flex-row gap-3"
          style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
          {/* Search */}
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />
            <input
              value={searchQ} onChange={e => setSearchQ(e.target.value)}
              placeholder="Search events, dates, accounts…"
              className="w-full pl-9 pr-3 py-2 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400"
              style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}
            />
            {searchQ && (
              <button onClick={() => setSearchQ("")} className="absolute right-2.5 top-1/2 -translate-y-1/2" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Category filter */}
          <div className="flex gap-1.5 flex-wrap">
            {CAT_FILTERS.map(f => (
              <button key={f.val} onClick={() => setFilterCat(f.val)}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all"
                style={{
                  borderColor: filterCat === f.val ? (f.color || COLORS.deepBlue) : "transparent",
                  backgroundColor: filterCat === f.val
                    ? (isDark ? `${f.color || COLORS.deepBlue}20` : `${f.color || COLORS.deepBlue}12`)
                    : (isDark ? D_DARK.raised : "#f8fafc"),
                  color: filterCat === f.val ? (f.color || COLORS.deepBlue) : (isDark ? D_DARK.muted : "#64748b"),
                }}>
                {f.label}
              </button>
            ))}
          </div>

          {/* Urgency filter */}
          <select value={filterUrgency} onChange={e => setFilterUrgency(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400"
            style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}>
            <option value="all">All Urgency</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>

          {/* Sort */}
          <select value={sortBy} onChange={e => setSortBy(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-400"
            style={{ backgroundColor: isDark ? D_DARK.raised : "#f8fafc", borderColor: isDark ? D_DARK.border : "#e2e8f0", color: isDark ? D_DARK.text : "#1e293b" }}>
            <option value="date_asc">Date ↑ (Soonest)</option>
            <option value="date_desc">Date ↓ (Latest)</option>
            <option value="urgency">Urgency</option>
          </select>

          {/* Past toggle */}
          <button onClick={() => setShowPast(s => !s)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all"
            style={{
              borderColor: showPast ? COLORS.amber : (isDark ? D_DARK.border : "#e2e8f0"),
              backgroundColor: showPast ? (isDark ? "rgba(245,158,11,0.12)" : "#FFFBEB") : (isDark ? D_DARK.raised : "#f8fafc"),
              color: showPast ? COLORS.amber : (isDark ? D_DARK.muted : "#64748b"),
            }}>
            <Eye className="w-3.5 h-3.5" />
            {showPast ? "Hiding Past" : "Show Past"}
          </button>

          {/* View mode toggle */}
          <div className="flex items-center rounded-xl border overflow-hidden flex-shrink-0"
            style={{ borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
            <button onClick={() => setViewMode("list")}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold transition-all"
              title="List view"
              style={{
                backgroundColor: viewMode === "list" ? COLORS.deepBlue : (isDark ? D_DARK.raised : "#f8fafc"),
                color: viewMode === "list" ? "#fff" : (isDark ? D_DARK.muted : "#64748b"),
              }}>
              <LayoutList className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setViewMode("board")}
              className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold transition-all"
              title="Board view"
              style={{
                backgroundColor: viewMode === "board" ? COLORS.deepBlue : (isDark ? D_DARK.raised : "#f8fafc"),
                color: viewMode === "board" ? "#fff" : (isDark ? D_DARK.muted : "#64748b"),
              }}>
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </motion.div>

      {/* ══ INFO BANNER ══ */}
      <motion.div variants={itemV}>
        <div className="px-4 py-3 rounded-2xl border flex items-start gap-3"
          style={{ backgroundColor: isDark ? "rgba(59,130,246,0.08)" : "#eff6ff", borderColor: isDark ? "#1d4ed8" : "#bfdbfe" }}>
          <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
          <div className="text-xs" style={{ color: isDark ? "#93c5fd" : "#1e40af" }}>
            <span className="font-bold">All email-extracted events are shown here. </span>
            Click <strong>Scan Fresh</strong> to re-scan all connected accounts. Use the category buttons on each event to override before saving.
            Past events are hidden by default — toggle <em>Show Past</em> to reveal them.
            Once saved, items appear in their respective module (Reminders, Todos, or Visits).
          </div>
        </div>
      </motion.div>

      {/* ══ EVENT GROUPS ══ */}
      {loading ? (
        <motion.div variants={itemV} className="flex flex-col items-center justify-center py-24 gap-4">
          <Loader2 className="w-8 h-8 animate-spin" style={{ color: COLORS.mediumBlue }} />
          <p className="text-sm font-medium" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>Loading email events…</p>
        </motion.div>
      ) : events.length === 0 ? (
        <motion.div variants={itemV}>
          <div className="rounded-2xl border py-16 text-center space-y-4"
            style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto"
              style={{ backgroundColor: isDark ? D_DARK.raised : "#f1f5f9" }}>
              <Inbox className="w-8 h-8" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />
            </div>
            <div>
              <p className="font-semibold" style={{ color: isDark ? D_DARK.text : "#374151" }}>No email events found</p>
              <p className="text-sm mt-1" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>
                Connect an email account and run a scan to extract due dates, hearings, and meetings.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button onClick={() => { window.location.href = "/settings/email"; }}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold border active:scale-95 transition-all"
                style={{ color: COLORS.mediumBlue, borderColor: COLORS.mediumBlue + "40", backgroundColor: isDark ? COLORS.mediumBlue + "15" : COLORS.mediumBlue + "08" }}>
                <Mail className="w-4 h-4" />
                Connect Email
              </button>
              <button onClick={handleScanFresh} disabled={scanning}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white active:scale-95 transition-all"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Scan Email Accounts
              </button>
            </div>
          </div>
        </motion.div>
      ) : processed.length === 0 ? (
        <motion.div variants={itemV}>
          <div className="rounded-2xl border py-12 text-center"
            style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
            <p className="font-semibold" style={{ color: isDark ? D_DARK.text : "#374151" }}>No events match your filters</p>
            <p className="text-sm mt-1" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }}>Try clearing the search or changing filters</p>
          </div>
        </motion.div>
      ) : (
        <AnimatePresence>
          {grouped.map(group => (
            <motion.div key={group.label} variants={itemV} layout className="space-y-3">
              {/* Group header */}
              <button onClick={() => toggleGroup(group.label)}
                className="w-full flex items-center gap-3 py-1 text-left"
                style={{ color: isDark ? D_DARK.text : "#374151" }}>
                <div className="flex-1 flex items-center gap-2.5">
                  <div className="h-px flex-1 max-w-[24px]" style={{ backgroundColor: isDark ? D_DARK.border : "#e2e8f0" }} />
                  <span className="text-sm font-bold uppercase tracking-wide"
                    style={{
                      color: group.label === "Today" ? COLORS.red
                        : group.label === "Tomorrow" ? COLORS.orange
                        : group.label === "Past Events" ? (isDark ? D_DARK.dimmer : "#94a3b8")
                        : (isDark ? D_DARK.muted : "#64748b"),
                    }}>
                    {group.label}
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style={{ backgroundColor: isDark ? D_DARK.raised : "#f1f5f9", color: isDark ? D_DARK.muted : "#64748b" }}>
                    {group.events.length}
                  </span>
                  <div className="h-px flex-1" style={{ backgroundColor: isDark ? D_DARK.border : "#e2e8f0" }} />
                </div>
                {collapsed[group.label]
                  ? <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />
                  : <ChevronUp className="w-4 h-4 flex-shrink-0" style={{ color: isDark ? D_DARK.muted : "#94a3b8" }} />}
              </button>

              {/* Events grid */}
              <AnimatePresence>
                {!collapsed[group.label] && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                    className={viewMode === "board"
                      ? "grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
                      : "grid grid-cols-1 gap-2"}>
                    {group.events.map(ev => (
                      <div key={ev.id || `${ev.title}::${ev.date}`} className="min-w-0">
                        <EventCard
                          event={ev} isDark={isDark}
                          savedKeys={savedKeys}
                          onSaved={handleEventSaved}
                          onDismiss={handleDismiss}
                          onAddTask={ev => setTaskModalEvent(ev)}
                          viewMode={viewMode} />
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          ))}
        </AnimatePresence>
      )}

      {/* ══ TIPS ══ */}
      {!loading && events.length > 0 && (
        <motion.div variants={itemV}>
          <div className="rounded-2xl border p-4"
            style={{ backgroundColor: isDark ? D_DARK.card : "#ffffff", borderColor: isDark ? D_DARK.border : "#e2e8f0" }}>
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="w-4 h-4" style={{ color: COLORS.mediumBlue }} />
              <p className="text-sm font-bold" style={{ color: isDark ? D_DARK.text : "#374151" }}>Tips</p>
            </div>
            <ul className="space-y-1.5">
              {[
                "Click the category buttons (Reminder / Todo / Visit) on each card to override the AI's suggestion before saving.",
                "Events saved here appear instantly in Reminders, Todos, or Client Visits pages.",
                "Use Scan Fresh to pick up new emails from all connected accounts.",
                "High-urgency events are flagged automatically — check them first.",
                "Go to Email Accounts settings to connect new accounts or manage existing ones.",
              ].map((tip, i) => (
                <li key={i} className="flex items-start gap-2 text-xs" style={{ color: isDark ? D_DARK.muted : "#64748b" }}>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        </motion.div>
      )}

    </motion.div>

    {/* ── Full Task Creation Modal ── */}
    <AnimatePresence>
      {taskModalEvent && (
        <AddTaskModal
          event={taskModalEvent}
          isDark={isDark}
          onClose={() => setTaskModalEvent(null)}
          canAssignTasks={canAssignTasks}
          users={users}
          clients={clients}
          onTaskCreated={handleTaskCreated}
        />
      )}
    </AnimatePresence>
    </>
  );
}

// ─── Append: modal render already inside component above
