// Reminders.jsx — Dedicated Reminders & Meetings page
// WelcomeBanner + Full Calendar View + Popup Notifications

import { useDark } from "@/hooks/useDark";
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WelcomeBanner } from "@/components/ui/WelcomeBanner";
import api from "@/lib/api";
import { toast } from "sonner";
import {
  format,
  parseISO,
  isPast,
  isToday as dateFnsIsToday,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  addMonths,
  subMonths,
  getDay,
} from "date-fns";
import {
  Bell,
  BellRing,
  Plus,
  Trash2,
  X,
  Edit2,
  Clock,
  Calendar as CalendarIcon,
  Users,
  ChevronRight,
  ChevronLeft,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Settings2,
  Search,
  List,
  LayoutGrid,
  BellOff,
  CalendarDays,
  RefreshCw,
} from "lucide-react";
import LayoutCustomizer from "../components/layout/LayoutCustomizer";
import { usePageLayout } from "../hooks/usePageLayout";

// ── Constants ────────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue: "#0D3B66",
  mediumBlue: "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  amber: "#F59E0B",
  yellow: "#EAB308",
  coral: "#FF6B6B",
  purple: "#8B5CF6",
};

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.06, delayChildren: 0.1 },
  },
};
const itemVariants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] },
  },
};
const springPhysics = {
  card: { type: "spring", stiffness: 280, damping: 22, mass: 0.85 },
  lift: { type: "spring", stiffness: 320, damping: 24, mass: 0.9 },
};

const slimScroll = {
  overflowY: "auto",
  scrollbarWidth: "thin",
  scrollbarColor: "#cbd5e1 transparent",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function resolveId(r) {
  if (!r) return null;
  const id = r.id ?? r._id ?? r["_id"] ?? null;
  return id ? String(id) : null;
}

function normalizeReminder(r) {
  if (!r) return r;
  return { ...r, id: resolveId(r) };
}

const stripHtml = (str) => (str || "").replace(/<[^>]*>/g, "");

// Converts a Date (or ISO string) into the "YYYY-MM-DDTHH:mm" format a
// <input type="datetime-local"> expects, using LOCAL wall-clock time.
function toDatetimeLocalValue(dateOrIso) {
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (isNaN(d.getTime())) return "";
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

const formatReminderTime = (isoStr) => {
  if (!isoStr) return "—";
  try {
    return format(new Date(isoStr), "MMM d, yyyy · h:mm a");
  } catch {
    return "—";
  }
};

const buildGCalURL = (reminder) => {
  try {
    const start = reminder.remind_at ? new Date(reminder.remind_at) : null;
    if (!start) return "#";
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const fmt = (d) =>
      d
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "");
    return `https://calendar.google.com/calendar/r/eventedit?dates=${fmt(start)}/${fmt(end)}&text=${encodeURIComponent(reminder.title)}&details=${encodeURIComponent(reminder.description || "")}`;
  } catch {
    return "#";
  }
};

function getFiredIds() {
  try {
    const stored = sessionStorage.getItem("rem_fired_ids");
    return new Set(stored ? JSON.parse(stored) : []);
  } catch {
    return new Set();
  }
}
function addFiredId(id) {
  try {
    const set = getFiredIds();
    set.add(String(id));
    sessionStorage.setItem("rem_fired_ids", JSON.stringify([...set]));
  } catch {}
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function sendBrowserNotification(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: "/favicon.ico", tag: title });
    } catch {}
  }
}

function SectionCard({ children, className = "" }) {
  return (
    <div
      className={`bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm ${className}`}
    >
      {children}
    </div>
  );
}

function CardHeaderRow({ iconBg, icon, title, subtitle, action, badge }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
      <div className="flex items-center gap-2.5">
        <div className={`p-1.5 rounded-lg ${iconBg}`}>{icon}</div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">
              {title}
            </h3>
            {badge !== undefined && badge > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-purple-500 text-white leading-none">
                {badge}
              </span>
            )}
          </div>
          {subtitle && (
            <p className="text-xs text-slate-400 dark:text-slate-500">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action && (
        <div className="flex items-center gap-1.5 flex-shrink-0">{action}</div>
      )}
    </div>
  );
}

// ── Hearing status/colour helper ─────────────────────────────────────────────
function getHearingStatus(rem) {
  if (!rem) return null;
  if (rem.hearing_adjourned) {
    return rem.hearing_next_date_disclosed ? "adjourned_dated" : "adjourned_no_date";
  }
  if (rem.hearing_decision === "favourable") return "favourable";
  if (rem.hearing_decision === "unfavourable") return "unfavourable";
  return null;
}

const HEARING_STATUS_STYLES = {
  favourable:        { solid: "#10b981", solidTo: "#059669", tailwindDot: "bg-emerald-500", tailwindPillLight: "bg-emerald-100 text-emerald-700", tailwindPillDark: "bg-emerald-900/40 text-emerald-300" },
  unfavourable:       { solid: "#f59e0b", solidTo: "#d97706", tailwindDot: "bg-amber-500",   tailwindPillLight: "bg-amber-100 text-amber-700",   tailwindPillDark: "bg-amber-900/40 text-amber-300" },
  adjourned_no_date:  { solid: "#eab308", solidTo: "#ca8a04", tailwindDot: "bg-yellow-500",  tailwindPillLight: "bg-yellow-100 text-yellow-700", tailwindPillDark: "bg-yellow-900/40 text-yellow-300" },
  adjourned_dated:    { solid: "#ef4444", solidTo: "#b91c1c", tailwindDot: "bg-red-500",     tailwindPillLight: "bg-red-100 text-red-600",       tailwindPillDark: "bg-red-900/40 text-red-300" },
};

// ── Shared Reminder Detail Popup ─────────────────────────────────────────────
function ReminderDetailPopup({ rem, isDark, isViewingOther, onClose, onEdit, onDelete, onDismiss, onReschedule, COLORS }) {
  if (!rem) return null;
  const remId = resolveId(rem);
  const isDue = rem.remind_at && isPast(new Date(rem.remind_at));
  const gcalUrl = buildGCalURL(rem);
  return (
    <motion.div
      key="reminder-detail-popup"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(10px)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}
    >
      <motion.div initial={{ scale: 0.88, y: 40, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }} exit={{ scale: 0.88, y: 40, opacity: 0 }} transition={{ type: "spring", stiffness: 220, damping: 22 }} className={`w-full max-w-xl rounded-3xl overflow-hidden shadow-2xl ${isDark ? "bg-slate-800 border border-slate-700" : "bg-white border border-slate-200"}`} onClick={(e) => e.stopPropagation()}>
        <div className="px-8 py-7 relative overflow-hidden" style={{ background: (() => { const status = getHearingStatus(rem); if (status) { const s = HEARING_STATUS_STYLES[status]; return `linear-gradient(135deg, ${s.solid}, ${s.solidTo})`; } return `linear-gradient(135deg, ${isDue ? COLORS.coral : COLORS.purple}, ${COLORS.mediumBlue})`; })() }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4"><div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center flex-shrink-0"><BellRing className="w-7 h-7 text-white" /></div><div><p className="text-white/60 text-[11px] font-semibold uppercase tracking-widest mb-1">{rem.reminder_type === "meeting" ? "Meeting" : "Reminder"}{rem.source === "email_auto" && " · From Email"}</p><h2 className="text-xl font-bold text-white leading-tight">{rem.title || "Untitled"}</h2>{isDue && <span className="inline-block mt-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-white/20 text-white">OVERDUE</span>}</div></div>
            <button onClick={onClose} className="w-9 h-9 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center transition-all flex-shrink-0"><X className="w-5 h-5 text-white" /></button>
          </div>
        </div>
        <div className="px-8 py-6 space-y-5 max-h-[65vh] overflow-y-auto">
          {isDue && !isViewingOther && <div className={`rounded-2xl p-4 border ${isDark ? "bg-red-950/40 border-red-800" : "bg-red-50 border-red-200"}`}><div className="flex items-center gap-2 mb-3"><AlertTriangle className="h-4 w-4 text-red-500 flex-shrink-0" /><p className={`text-xs font-bold uppercase tracking-wide ${isDark ? "text-red-400" : "text-red-600"}`}>This reminder is overdue — take action</p></div><div className="flex gap-2 flex-wrap"><button onClick={() => { onDismiss(remId); onClose(); }} className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold transition-all ${isDark ? "bg-slate-700 hover:bg-slate-600 text-slate-200 border border-slate-600" : "bg-white hover:bg-slate-50 text-slate-700 border border-slate-300 shadow-sm"}`}><BellOff className="h-3.5 w-3.5" /> Dismiss</button></div></div>}
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────
export default function Reminders() {
  const isDark = useDark();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [reminders, setReminders] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingReminder, setEditingReminder] = useState(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [showListView, setShowListView] = useState(false);
  const [activePopupReminder, setActivePopupReminder] = useState(null);
  const [rescheduleTarget, setRescheduleTarget] = useState(null);
  const [calendarMonth, setCalendarMonth] = useState(new Date());
  const [formTitle, setFormTitle] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formDatetime, setFormDatetime] = useState("");
  const [formBrandName, setFormBrandName] = useState("");
  const [formAttended, setFormAttended] = useState("");
  const [formDecision, setFormDecision] = useState("");
  const [formAdjourned, setFormAdjourned] = useState(false);
  const [formNextDateDisclosed, setFormNextDateDisclosed] = useState(false);
  const [formHearingNotes, setFormHearingNotes] = useState("");
  const REM_SECTIONS = ["overview", "calendar_view", "reminders_list"];
  const REM_LABELS = { overview: { name: "Overview Stats", icon: "📊", desc: "Reminder statistics" }, calendar_view: { name: "Calendar View", icon: "📅", desc: "Monthly calendar with reminders" }, reminders_list: { name: "Reminders List", icon: "🔔", desc: "All reminders and meetings" } };
  const { order: remOrder, moveSection: remMove, resetOrder: remReset } = usePageLayout("reminders", REM_SECTIONS);
  const [showCustomize, setShowCustomize] = useState(false);
  const [showPopupSettings, setShowPopupSettings] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);

  const refreshDuplicateCount = useCallback(async () => {
    try { const { data } = await api.get("/email/reminders/duplicates"); setDuplicateCount(Array.isArray(data?.duplicate_groups) ? data.duplicate_groups.length : 0); } catch {}
  }, []);
  useEffect(() => { requestNotificationPermission(); }, []);
  useEffect(() => { if (!isAdmin) return; const fetchUsers = async () => { try { const res = await api.get("/users"); if (Array.isArray(res.data)) setAllUsers(res.data); } catch {} }; fetchUsers(); }, [isAdmin]);
  const fetchReminders = useCallback(async () => { setLoading(true); try { const uid = isAdmin && selectedUserId ? selectedUserId : undefined; const url = uid ? `/email/reminders?user_id=${uid}` : "/email/reminders"; const res = await api.get(url); const raw = Array.isArray(res.data) ? res.data : []; setReminders(raw.map(normalizeReminder)); } catch { console.error("Failed to fetch reminders"); } finally { setLoading(false); } }, [isAdmin, selectedUserId]);
  useEffect(() => { fetchReminders(); }, [fetchReminders]);
  useEffect(() => { refreshDuplicateCount(); }, [refreshDuplicateCount, reminders.length]);
  useEffect(() => { if (activePopupReminder) { const updated = reminders.find(r => resolveId(r) === resolveId(activePopupReminder)); if (updated) setActivePopupReminder(updated); else setActivePopupReminder(null); } }, [reminders]);
  useEffect(() => { if (!reminders.length) return; const checkReminders = () => { const firedIds = getFiredIds(); const now = new Date(); reminders.forEach((rem) => { if (rem.is_dismissed) return; const remId = resolveId(rem); if (!remId || firedIds.has(remId)) return; if (!rem.remind_at) return; try { const remDate = new Date(rem.remind_at); const diffMs = remDate.getTime() - now.getTime(); if (diffMs <= 60000 && diffMs >= -300000) { addFiredId(remId); toast.warning(`🔔 Reminder: ${rem.title}`, { description: rem.description ? stripHtml(rem.description).slice(0, 100) : formatReminderTime(rem.remind_at), duration: 10000, action: { label: "Dismiss", onClick: () => handleDismiss(remId) } }); sendBrowserNotification(`🔔 ${rem.title}`, rem.description ? stripHtml(rem.description).slice(0, 100) : `Due: ${formatReminderTime(rem.remind_at)}`); } } catch {} }); }; checkReminders(); const interval = setInterval(checkReminders, 30000); return () => clearInterval(interval); }, [reminders]);
  const handleDismiss = async (id) => { if (!id) return; try { await api.patch(`/email/reminders/${id}`, { is_dismissed: true }); const rem = reminders.find(r => resolveId(r) === String(id)); setReminders((prev) => prev.map((r) => resolveId(r) === String(id) ? { ...r, is_dismissed: true } : r)); if (rem?.event_id) api.delete(`/email/events/${rem.event_id}`).catch(() => {}); } catch {} };
  const handleCreate = async () => { if (!formTitle.trim() || !formDatetime) { toast.error("Title and date/time are required"); return; } try { const payload = { title: formTitle.trim(), description: formDesc.trim() || "", remind_at: new Date(formDatetime).toISOString() }; if (isTmHearing(formTitle)) { payload.brand_name = formBrandName.trim() || null; payload.hearing_attended = formAttended || null; payload.hearing_decision = formDecision || null; payload.hearing_adjourned = formAdjourned; payload.hearing_next_date_disclosed = formAdjourned ? formNextDateDisclosed : null; payload.hearing_notes = formHearingNotes.trim() || null; } await api.post("/email/save-as-reminder", payload); toast.success("Reminder created"); resetForm(); await fetchReminders(); } catch { toast.error("Failed to create reminder"); } };
  const handleUpdate = async () => { if (!editingReminder) return; const remId = resolveId(editingReminder); if (!remId) { toast.error("Cannot update: ID missing"); return; } try { const payload = { title: formTitle.trim(), description: formDesc.trim(), remind_at: formDatetime ? new Date(formDatetime).toISOString() : undefined }; if (isTmHearing(formTitle, editingReminder)) { payload.brand_name = formBrandName.trim() || null; payload.hearing_attended = formAttended || null; payload.hearing_decision = formDecision || null; payload.hearing_adjourned = formAdjourned; payload.hearing_next_date_disclosed = formAdjourned ? formNextDateDisclosed : null; payload.hearing_notes = formHearingNotes.trim() || null; } const { data: savedReminder } = await api.patch(`/email/reminders/${remId}`, payload); toast.success("Reminder updated"); const normalized = normalizeReminder(savedReminder); resetForm(); setActivePopupReminder(normalized); fetchReminders(); } catch { toast.error("Failed to update reminder"); } };
  const handleDelete = async (id) => { if (!id) return; const rem = reminders.find(r => resolveId(r) === String(id)); try { await api.delete(`/email/reminders/${id}`); toast.success("Reminder deleted"); setReminders((prev) => prev.filter((r) => resolveId(r) !== String(id))); if (rem?.event_id) api.delete(`/email/events/${rem.event_id}`).catch(() => {}); } catch { try { await api.patch(`/email/reminders/${id}`, { is_dismissed: true }); toast.success("Reminder dismissed"); setReminders((prev) => prev.filter((r) => resolveId(r) !== String(id))); if (rem?.event_id) api.delete(`/email/events/${rem.event_id}`).catch(() => {}); } catch { toast.error("Failed to delete reminder"); } } };
  const isTmHearing = (title = "", reminderObj = null) => { if (reminderObj?.source === "email_auto") return true; const t = (title || "").toLowerCase(); return t.includes("trademark") || t.includes("hearing") || t.includes("tm app") || t.includes("show cause") || t.includes("registration certificate") || t.includes("certificate") || t.includes("ip india") || t.includes("tmr.gov"); };
  const resetForm = () => { setShowForm(false); setEditingReminder(null); setFormTitle(""); setFormDesc(""); setFormDatetime(""); setFormBrandName(""); setFormAttended(""); setFormDecision(""); setFormAdjourned(false); setFormNextDateDisclosed(false); setFormHearingNotes(""); };
  const startEdit = (rem) => { setEditingReminder(rem); setFormTitle(rem.title || ""); setFormDesc(stripHtml(rem.description || "")); try { setFormDatetime(toDatetimeLocalValue(rem.remind_at)); } catch { setFormDatetime(""); } setFormBrandName(rem.brand_name || ""); setFormAttended(rem.hearing_attended || ""); setFormDecision(rem.hearing_decision || ""); setFormAdjourned(rem.hearing_adjourned || false); setFormNextDateDisclosed(rem.hearing_next_date_disclosed || false); setFormHearingNotes(rem.hearing_notes || ""); setShowForm(true); };
  const openDetailPopup = (rem) => { setActivePopupReminder(rem); };
  const startReschedule = (rem) => { setRescheduleTarget(rem); };
  const handleRescheduleConfirm = async (newDatetime) => { if (!rescheduleTarget) return; const remId = resolveId(rescheduleTarget); if (!remId) return; try { const { data: saved } = await api.patch(`/email/reminders/${remId}`, { remind_at: new Date(newDatetime).toISOString(), is_dismissed: false }); toast.success("Reminder rescheduled"); const normalized = normalizeReminder(saved); setRescheduleTarget(null); setActivePopupReminder(normalized); fetchReminders(); } catch { toast.error("Failed to reschedule reminder"); } };
  const filteredReminders = useMemo(() => { let list = Array.isArray(reminders) ? reminders : []; if (filterStatus === "upcoming") list = list.filter((r) => !r.is_dismissed && r.remind_at && !isPast(new Date(r.remind_at))); else if (filterStatus === "overdue") list = list.filter((r) => !r.is_dismissed && r.remind_at && isPast(new Date(r.remind_at))); else if (filterStatus === "dismissed") list = list.filter((r) => r.is_dismissed); else list = list.filter((r) => !r.is_dismissed); if (searchTerm.trim()) { const q = searchTerm.toLowerCase(); list = list.filter((r) => (r.title || "").toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)); } return list.sort((a, b) => { const da = a.remind_at ? new Date(a.remind_at).getTime() : 0; const db = b.remind_at ? new Date(b.remind_at).getTime() : 0; return da - db; }); }, [reminders, filterStatus, searchTerm]);
  const stats = useMemo(() => { const active = reminders.filter((r) => !r.is_dismissed); const overdue = active.filter((r) => r.remind_at && isPast(new Date(r.remind_at))); const upcoming = active.filter((r) => r.remind_at && !isPast(new Date(r.remind_at))); const todayCount = active.filter((r) => { try { return dateFnsIsToday(new Date(r.remind_at)); } catch { return false; } }); return { total: active.length, overdue: overdue.length, upcoming: upcoming.length, today: todayCount.length }; }, [reminders]);
  const calendarDays = useMemo(() => eachDayOfInterval({ start: startOfMonth(calendarMonth), end: endOfMonth(calendarMonth) }), [calendarMonth]);
  const remindersByDate = useMemo(() => { const map = {}; reminders.filter((r) => !r.is_dismissed && r.remind_at).forEach((r) => { try { const dateKey = format(new Date(r.remind_at), "yyyy-MM-dd"); if (!map[dateKey]) map[dateKey] = []; map[dateKey].push(r); } catch {} }); return map; }, [reminders]);
  const isViewingOther = isAdmin && selectedUserId && selectedUserId !== user?.id;
  const startDayOfWeek = getDay(startOfMonth(calendarMonth));

  return (
    <>
      <LayoutCustomizer isOpen={showCustomize} onClose={() => setShowCustomize(false)} sectionLabels={REM_LABELS} order={remOrder} onDragEnd={remMove} onReset={remReset} isDark={isDark} />
      <PopupSettingsModal isOpen={showPopupSettings} onClose={() => setShowPopupSettings(false)} />
      <AnimatePresence>{showDuplicates && <DuplicatesModal isOpen={showDuplicates} isDark={isDark} onClose={() => setShowDuplicates(false)} onChanged={() => { fetchReminders(); refreshDuplicateCount(); }} />}</AnimatePresence>
      <motion.div className="space-y-4 pb-8" variants={containerVariants} initial="hidden" animate="visible">
        <motion.div variants={itemVariants}>
          <WelcomeBanner
            title="Reminders & Meetings"
            subtitle={isViewingOther ? "Viewing another user's reminders" : "Manage your reminders and meetings"}
            icon={BellRing}
            actions={
              <div className="grid grid-cols-3 gap-2 w-[570px] max-w-full flex-shrink-0">
                {isAdmin && (
                  <Select value={selectedUserId || "all"} onValueChange={(v) => setSelectedUserId(v === "all" ? "" : v)}>
                    <SelectTrigger className="w-full h-9 text-sm rounded-none bg-white/15 border-white/20 text-white placeholder:text-white/50">
                      <SelectValue placeholder="All Users" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">My Reminders</SelectItem>
                      {allUsers.map((u) => <SelectItem key={u.id || u._id} value={String(u.id || u._id)}>{u.full_name || u.name || u.email}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
                <Button onClick={() => { resetForm(); setShowForm(true); }} className="w-full h-9 rounded-none text-sm font-semibold bg-white/15 hover:bg-white/25 text-white border border-white/20"><Plus className="h-4 w-4 mr-1" /> New Reminder</Button>
                <button onClick={() => setShowListView((v) => !v)} title={showListView ? "Show Calendar Only" : "Show List View"} className="w-full h-9 flex items-center justify-center gap-1.5 px-3 rounded-none text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all">{showListView ? <CalendarIcon size={13} /> : <List size={13} />}{showListView ? "Calendar" : "List View"}</button>
                <button onClick={() => setShowCustomize(true)} className="w-full h-9 flex items-center justify-center gap-1.5 px-3 rounded-none text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all"><Settings2 size={13} /> Customize</button>
                <button onClick={() => setShowPopupSettings(true)} className="w-full h-9 flex items-center justify-center gap-1.5 px-3 rounded-none text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all" data-testid="popup-settings-btn"><Bell size={13} /> Popup Settings</button>
                <button onClick={() => setShowDuplicates(true)} className="relative w-full h-9 flex items-center justify-center gap-1.5 px-3 rounded-none text-xs font-semibold bg-white/10 hover:bg-white/20 text-white/70 border border-white/15 transition-all" data-testid="duplicates-btn" title="Find and remove duplicate reminders"><RefreshCw size={13} /> Duplicates{duplicateCount > 0 && <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-coral text-[10px] font-bold flex items-center justify-center text-white" style={{ backgroundColor: COLORS.coral }}>{duplicateCount}</span>}</button>
              </div>
            }
          />
        </motion.div>

        {remOrder.map((sectionId) => {
          if (sectionId === "overview") return null;
          return null;
        })}
      </motion.div>
    </>
  );
}
