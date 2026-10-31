// Leave.jsx — full-featured Leave module page.
//
// Replaces the old generic GovernedListPage stub. Leave applications and
// absence records already live in the `attendance` collection (see
// backend/server.py: POST /attendance/apply-leave, GET /attendance/history,
// GET /attendance/leave-summary, GET /attendance/absent-summary) and are
// surfaced today inside the Attendance page. This page reuses those same
// endpoints and the same permission model (admin / cross-visibility via
// user.permissions.view_other_attendance) so Leave becomes a dedicated,
// fully-working view of that data instead of a disconnected CRUD stub —
// with a complete Past / Today / Upcoming breakdown of applied leave, a
// standalone Absent Records list, and (for admins / permitted viewers) a
// team-wide Leave & Absence overview, all backed by real data.
//
// backend/governed_modules.py's generic `/leave` CRUD router is left in
// place (harmless, unused by this page) in case anything else depends on
// it; this page does not use it.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { format, parseISO, isBefore, isValid, startOfDay, addMonths, subMonths } from 'date-fns';
import { useAuth } from '@/contexts/AuthContext';
import { useDark } from '@/hooks/useDark';
import api from '@/lib/api';
import { toast } from 'sonner';
import ApplyLeaveModal from '@/components/attendance/ApplyLeaveModal';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import {
  CalendarOff, CalendarClock, CalendarDays,
  UserX, Send, X, ChevronDown, ChevronLeft, ChevronRight, Loader2,
  Users, AlertTriangle, History,
} from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────
// TOKENS — mirrors the palette used on the Attendance page so Leave feels
// like part of the same module rather than a bolted-on page.
// ─────────────────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     '#0D3B66',
  mediumBlue:   '#1F6FB2',
  emeraldGreen: '#1FAF5A',
  amber:        '#F59E0B',
  red:          '#EF4444',
  purple:       '#8B5CF6',
  slate200:     '#E2E8F0',
};

const ACCENT = {
  leave:    { fg: '#dc2626', bg: '#fef2f2', bgDark: 'rgba(220,38,38,0.12)',  border: '#fecaca', borderDark: '#7f1d1d' },
  halfDay:  { fg: '#7c3aed', bg: '#f5f3ff', bgDark: 'rgba(124,58,237,0.12)', border: '#ddd6fe', borderDark: '#4c1d95' },
  upcoming: { fg: '#1F6FB2', bg: '#eff6ff', bgDark: 'rgba(31,111,178,0.14)', border: '#bfdbfe', borderDark: '#1e40af' },
  today:    { fg: '#F59E0B', bg: '#fffbeb', bgDark: 'rgba(245,158,11,0.12)', border: '#fde68a', borderDark: '#92400e' },
  absent:   { fg: '#dc2626', bg: '#fef2f2', bgDark: 'rgba(220,38,38,0.10)',  border: '#fecaca', borderDark: '#7f1d1d' },
};

const LEAVE_TYPES = [
  { value: 'full_day',           label: 'Full Day',                 icon: '🗓️', desc: 'Absent the entire day' },
  { value: 'half_day_morning',   label: 'Half Day (Morning Off)',   icon: '🌅', desc: 'Off for the morning session' },
  { value: 'half_day_afternoon', label: 'Half Day (Afternoon Off)', icon: '🌇', desc: 'Off for the afternoon session' },
  { value: 'early_leave',        label: 'Early Leave',              icon: '🚪', desc: 'Present but leaving before office hours end' },
];
const HALF_DAY_LEAVE_TYPES = ['half_day_morning', 'half_day_afternoon'];
const LEAVE_TYPE_LABELS = {
  full_day: 'Full Day',
  half_day_morning: 'Half Day (Morning Off)',
  half_day_afternoon: 'Half Day (Afternoon Off)',
  early_leave: 'Early Leave',
};

const D = {
  bg: '#0f172a', card: '#1e293b', raised: '#263348', border: '#334155',
  text: '#f1f5f9', muted: '#94a3b8', dimmer: '#64748b',
};

const safeParseISO = (s) => {
  if (!s) return null;
  try { const d = parseISO(s); return isValid(d) ? d : null; } catch { return null; }
};

/** past | today | upcoming, based on calendar date only (ignores time). */
function classifyDate(dateStr) {
  const d = safeParseISO(dateStr);
  if (!d) return 'past';
  const today = startOfDay(new Date());
  const dOnly = startOfDay(d);
  if (dOnly.getTime() === today.getTime()) return 'today';
  return isBefore(dOnly, today) ? 'past' : 'upcoming';
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.03, delayChildren: 0.05 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 16 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.23, 1, 0.32, 1] } },
};

// ─────────────────────────────────────────────────────────────────────────
// STAT CARD
// ─────────────────────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, accent, isDark, sublabel }) {
  return (
    <motion.div variants={itemVariants}>
      <Card className="p-4 flex items-center gap-3 h-full" style={{
        backgroundColor: isDark ? D.card : '#ffffff',
        borderColor: isDark ? D.border : '#e2e8f0',
      }}>
        <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: isDark ? `${accent}22` : `${accent}12` }}>
          <Icon className="w-5 h-5" style={{ color: accent }} />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-black leading-tight" style={{ color: isDark ? D.text : '#0f172a' }}>{value}</p>
          <p className="text-xs font-semibold truncate" style={{ color: isDark ? D.muted : '#64748b' }}>{label}</p>
          {sublabel && <p className="text-[10px] mt-0.5" style={{ color: isDark ? D.dimmer : '#94a3b8' }}>{sublabel}</p>}
        </div>
      </Card>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// LEAVE RECORD ROW (personal list)
// ─────────────────────────────────────────────────────────────────────────
function LeaveRecordRow({ record, isDark, bucket }) {
  const d = safeParseISO(record.date);
  const isHalf = HALF_DAY_LEAVE_TYPES.includes(record.leave_type);
  const accent = bucket === 'upcoming' ? ACCENT.upcoming : bucket === 'today' ? ACCENT.today : (isHalf ? ACCENT.halfDay : ACCENT.leave);
  return (
    <div className="flex items-start justify-between gap-3 p-3.5 rounded-xl border"
      style={{
        backgroundColor: isDark ? accent.bgDark : accent.bg,
        borderColor: isDark ? accent.borderDark : accent.border,
      }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold" style={{ color: isDark ? D.text : '#0f172a' }}>
            {d ? format(d, 'EEE, MMM d, yyyy') : record.date}
          </span>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ backgroundColor: `${accent.fg}22`, color: accent.fg }}>
            {LEAVE_TYPE_LABELS[record.leave_type] || 'Full Day'}
          </span>
        </div>
        {record.leave_reason && (
          <p className="text-xs mt-1" style={{ color: isDark ? D.muted : '#475569' }}>
            <span className="font-semibold">Reason: </span>{record.leave_reason}
          </p>
        )}
        {record.leave_type === 'early_leave' && record.early_leave_time && (
          <p className="text-xs mt-0.5" style={{ color: isDark ? D.muted : '#475569' }}>
            <span className="font-semibold">Left at: </span>{record.early_leave_time}
          </p>
        )}
      </div>
      <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-lg flex-shrink-0"
        style={{ color: accent.fg, backgroundColor: isDark ? `${accent.fg}18` : `${accent.fg}10` }}>
        {bucket}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// TEAM USER DETAIL MODAL — drill-down for a row inside the team Leave or
// Absent summary card. Mirrors the equivalent modal on the Attendance page.
// ─────────────────────────────────────────────────────────────────────────
function TeamDetailModal({ detail, onClose, isDark }) {
  if (!detail) return null;
  const { kind, item } = detail; // kind: 'leave' | 'absent'
  const isLeave = kind === 'leave';
  const accent = isLeave ? '#F59E0B' : COLORS.red;
  const records = isLeave ? (item.records || []) : (item.dates || []).map((d) => ({ date: d }));
  const totalLabel = isLeave ? 'Total Leave Days' : 'Total Absent Days';
  const totalValue = isLeave ? item.leave_days : item.absent_days;

  return (
    <motion.div
      className="fixed inset-0 z-[9999] bg-emerald-900/60 flex items-center justify-center p-4"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full max-w-md rounded-3xl shadow-2xl overflow-hidden max-h-[85vh] flex flex-col"
        style={{ backgroundColor: isDark ? D.card : '#ffffff', border: isDark ? `1px solid ${D.border}` : '1px solid #e2e8f0' }}
        initial={{ scale: 0.92, y: 24 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.92, y: 24 }}
        transition={{ type: 'spring', stiffness: 220, damping: 22 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-5 text-white relative overflow-hidden flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
          <div className="relative flex items-start justify-between">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-11 h-11 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
                {isLeave ? <CalendarOff className="w-5 h-5 text-white" /> : <UserX className="w-5 h-5 text-white" />}
              </div>
              <div className="min-w-0">
                <p className="text-white/60 text-[10px] font-bold uppercase tracking-widest mb-0.5">
                  {isLeave ? 'Applied Leave' : 'Absent Record'}
                </p>
                <h2 className="text-lg font-black leading-tight break-words">{item.user_name || 'Unknown'}</h2>
              </div>
            </div>
            <button onClick={onClose} className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center flex-shrink-0">
              <X className="w-4 h-4 text-white" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-3 overflow-y-auto flex-1">
          <div className="flex items-center gap-3 p-3.5 rounded-xl border"
            style={{ backgroundColor: isDark ? `${accent}1F` : `${accent}0C`, borderColor: `${accent}30` }}>
            <p className="text-[10px] font-bold uppercase tracking-wide text-slate-400 flex-shrink-0">{totalLabel}</p>
            <p className="font-semibold text-sm ml-auto" style={{ color: isDark ? D.text : '#1e293b' }}>
              {totalValue} day{totalValue !== 1 ? 's' : ''}
            </p>
          </div>

          <div className="space-y-2.5">
            {records.length === 0 && (
              <p className="text-sm" style={{ color: isDark ? D.muted : '#64748b' }}>No details available.</p>
            )}
            {records.map((rec, i) => (
              <div key={i} className="p-3 rounded-lg border" style={{ backgroundColor: isDark ? D.raised : '#f8fafc', borderColor: isDark ? D.border : '#e2e8f0' }}>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm font-semibold" style={{ color: isDark ? D.text : '#1e293b' }}>
                    {(() => { const d = safeParseISO(rec.date); return d ? format(d, 'EEE, MMM d, yyyy') : rec.date; })()}
                  </span>
                  {isLeave && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full flex-shrink-0" style={{ backgroundColor: `${accent}20`, color: accent }}>
                      {LEAVE_TYPE_LABELS[rec.leave_type] || rec.leave_type || 'Full Day'}
                    </span>
                  )}
                </div>
                {isLeave && rec.reason && (
                  <p className="text-xs" style={{ color: isDark ? D.muted : '#475569' }}>
                    <span className="font-semibold">Reason: </span>{rec.reason}
                  </p>
                )}
                {isLeave && rec.leave_type === 'early_leave' && rec.early_leave_time && (
                  <p className="text-xs mt-1" style={{ color: isDark ? D.muted : '#475569' }}>
                    <span className="font-semibold">Left at: </span>{rec.early_leave_time}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────
export default function Leave() {
  const { user } = useAuth();
  const isDark = useDark();

  const isAdmin = user?.role === 'admin';
  const crossVisAttendance = user?.permissions?.view_other_attendance || [];
  const hasCrossVis = crossVisAttendance.length > 0;
  const canViewTeam = isAdmin || hasCrossVis;

  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [viewUserId, setViewUserId] = useState('me');

  const [teamMonth, setTeamMonth] = useState(new Date());
  const [teamLeaveSummary, setTeamLeaveSummary] = useState([]);
  const [teamAbsentSummary, setTeamAbsentSummary] = useState([]);
  const [teamLoading, setTeamLoading] = useState(false);
  const [expandLeave, setExpandLeave] = useState(true);
  const [expandAbsent, setExpandAbsent] = useState(true);
  const [teamDetail, setTeamDetail] = useState(null); // { kind, item }

  const [activeLeaveTab, setActiveLeaveTab] = useState('upcoming');

  // Apply Leave now uses the shared <ApplyLeaveModal /> (see
  // components/attendance/ApplyLeaveModal.jsx) — the same component the
  // Attendance page uses — so applying leave from either page produces
  // exactly the same result.
  const [showApplyModal, setShowApplyModal] = useState(false);

  const effectiveUserId = viewUserId === 'me' ? user?.id : viewUserId;

  // ── Personal history fetch ────────────────────────────────────────────
  const fetchHistory = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const uid = effectiveUserId || user.id;
      const { data } = await api.get(`/attendance/history?user_id=${uid}`);
      setHistory(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e?.response?.data?.detail || 'Could not load leave history');
      setHistory([]);
    } finally {
      setLoading(false);
    }
  }, [effectiveUserId, user?.id]);

  useEffect(() => { fetchHistory(); }, [fetchHistory]);

  // ── Employees list for the "viewing" switcher (admins / cross-vis only) ─
  useEffect(() => {
    if (!canViewTeam) return;
    api.get('/users').then(({ data }) => {
      const list = Array.isArray(data) ? data : [];
      if (isAdmin) setAllUsers(list);
      else setAllUsers(list.filter((u) => crossVisAttendance.includes(u.id || u._id)));
    }).catch(() => setAllUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewTeam, isAdmin]);

  // ── Team-wide leave / absent summary for the selected month ───────────
  const fetchTeamSummary = useCallback(async () => {
    if (!canViewTeam) return;
    setTeamLoading(true);
    try {
      const month = format(teamMonth, 'yyyy-MM');
      const [leaveRes, absentRes] = await Promise.all([
        api.get(`/attendance/leave-summary?month=${month}`).catch(() => ({ data: { data: [] } })),
        api.get(`/attendance/absent-summary?month=${month}`).catch(() => ({ data: { data: [] } })),
      ]);
      setTeamLeaveSummary(leaveRes.data?.data || []);
      setTeamAbsentSummary(absentRes.data?.data || []);
    } finally {
      setTeamLoading(false);
    }
  }, [canViewTeam, teamMonth]);

  useEffect(() => { fetchTeamSummary(); }, [fetchTeamSummary]);

  // ── Derived personal data ──────────────────────────────────────────────
  const leaveRecords = useMemo(
    () => history.filter((r) => r.status === 'leave').sort((a, b) => (a.date < b.date ? 1 : -1)),
    [history]
  );
  const absentRecords = useMemo(
    () => history.filter((r) => r.status === 'absent').sort((a, b) => (a.date < b.date ? 1 : -1)),
    [history]
  );

  const bucketed = useMemo(() => {
    const buckets = { past: [], today: [], upcoming: [] };
    leaveRecords.forEach((r) => buckets[classifyDate(r.date)].push(r));
    // Past should read most-recent-first; upcoming should read soonest-first.
    buckets.past.sort((a, b) => (a.date < b.date ? 1 : -1));
    buckets.upcoming.sort((a, b) => (a.date > b.date ? 1 : -1));
    return buckets;
  }, [leaveRecords]);

  // "Apply Leave" always applies for the logged-in user themselves (see
  // backend/server.py apply_leave — it uses current_user.id, not whatever
  // user this page happens to be showing), so only compute this when
  // viewUserId is actually 'me'. If an admin is browsing someone else's
  // leave, count stays null and the modal's banner simply doesn't render —
  // showing that other person's leave count in "your" Apply Leave form
  // would be misleading.
  const myMonthLeaveForModal = useMemo(() => {
    if (viewUserId !== 'me') return { count: null, records: [] };
    const monthStr = format(new Date(), 'yyyy-MM');
    const records = leaveRecords
      .filter((r) => (r.date || '').startsWith(monthStr))
      .map((r) => ({ date: r.date, leave_type: r.leave_type || 'full_day', reason: r.leave_reason }));
    return { count: records.length, records };
  }, [leaveRecords, viewUserId]);

  const stats = useMemo(() => {
    const thisMonth = format(new Date(), 'yyyy-MM');
    return {
      totalLeave: leaveRecords.length,
      upcomingLeave: bucketed.upcoming.length,
      absentThisMonth: absentRecords.filter((r) => (r.date || '').startsWith(thisMonth)).length,
      totalAbsent: absentRecords.length,
    };
  }, [leaveRecords, bucketed, absentRecords]);

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6" style={{ color: isDark ? D.text : undefined }}>
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2">
            <CalendarOff className="w-6 h-6" style={{ color: COLORS.mediumBlue }} />
            Leave
          </h1>
          <p className="text-sm mt-1" style={{ color: isDark ? D.muted : '#64748b' }}>
            Applied leave and absence records — past, present and upcoming.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canViewTeam && allUsers.length > 0 && (
            <Select value={viewUserId} onValueChange={setViewUserId}>
              <SelectTrigger className="w-[190px]"><SelectValue placeholder="Viewing" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="me">My Leave</SelectItem>
                {allUsers.filter((u) => (u.id || u._id) !== user?.id).map((u) => (
                  <SelectItem key={u.id || u._id} value={u.id || u._id}>{u.full_name || u.email}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button onClick={() => setShowApplyModal(true)} className="gap-2" style={{ backgroundColor: COLORS.deepBlue }}>
            <Send className="w-4 h-4" /> Apply Leave
          </Button>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <motion.div className="grid grid-cols-2 lg:grid-cols-4 gap-4" variants={containerVariants} initial="hidden" animate="visible">
        <StatCard icon={CalendarDays}   label="Total Leave Days"     value={stats.totalLeave}      accent={COLORS.red}      isDark={isDark} />
        <StatCard icon={CalendarClock}  label="Upcoming Leave"       value={stats.upcomingLeave}   accent={COLORS.mediumBlue} isDark={isDark} sublabel="Applied for future dates" />
        <StatCard icon={AlertTriangle}  label="Absent This Month"    value={stats.absentThisMonth} accent={COLORS.amber}     isDark={isDark} />
        <StatCard icon={UserX}          label="Total Absent Days"    value={stats.totalAbsent}     accent={COLORS.red}       isDark={isDark} sublabel="All-time record" />
      </motion.div>

      {loading ? (
        <div className="flex items-center gap-2 justify-center py-10" style={{ color: isDark ? D.muted : '#64748b' }}>
          <Loader2 className="w-5 h-5 animate-spin" /> Loading leave records…
        </div>
      ) : (
        <>
          {/* ── Applied Leave: Past / Today / Upcoming ── */}
          <Card className="p-5" style={{ backgroundColor: isDark ? D.card : '#ffffff', borderColor: isDark ? D.border : '#e2e8f0' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-bold flex items-center gap-2">
                <History className="w-4 h-4" style={{ color: COLORS.mediumBlue }} />
                {viewUserId === 'me' ? 'My Applied Leave' : `${allUsers.find((u) => (u.id || u._id) === viewUserId)?.full_name || 'Employee'}'s Applied Leave`}
              </h2>
            </div>

            <Tabs value={activeLeaveTab} onValueChange={setActiveLeaveTab}>
              <TabsList>
                <TabsTrigger value="upcoming">Upcoming ({bucketed.upcoming.length})</TabsTrigger>
                <TabsTrigger value="today">Today ({bucketed.today.length})</TabsTrigger>
                <TabsTrigger value="past">Past ({bucketed.past.length})</TabsTrigger>
              </TabsList>
              {['upcoming', 'today', 'past'].map((bucket) => (
                <TabsContent key={bucket} value={bucket} className="space-y-2.5 mt-4">
                  {bucketed[bucket].length === 0 ? (
                    <div className="text-center py-8 text-sm" style={{ color: isDark ? D.muted : '#94a3b8' }}>
                      No {bucket} leave records.
                    </div>
                  ) : (
                    bucketed[bucket].map((r) => (
                      <LeaveRecordRow key={r.date} record={r} isDark={isDark} bucket={bucket} />
                    ))
                  )}
                </TabsContent>
              ))}
            </Tabs>
          </Card>

          {/* ── Absent Records ── */}
          <Card className="p-5" style={{ backgroundColor: isDark ? D.card : '#ffffff', borderColor: isDark ? D.border : '#e2e8f0' }}>
            <h2 className="text-base font-bold flex items-center gap-2 mb-4">
              <UserX className="w-4 h-4" style={{ color: COLORS.red }} />
              {viewUserId === 'me' ? 'My Absent Record' : 'Absent Record'}
              <Badge variant="outline" className="ml-1">{absentRecords.length}</Badge>
            </h2>
            {absentRecords.length === 0 ? (
              <div className="text-center py-8 text-sm" style={{ color: isDark ? D.muted : '#94a3b8' }}>
                No absences on record. 🎉
              </div>
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
                {absentRecords.map((r) => {
                  const d = safeParseISO(r.date);
                  return (
                    <div key={r.date} className="flex items-center justify-between gap-3 p-3 rounded-xl border"
                      style={{
                        backgroundColor: isDark ? ACCENT.absent.bgDark : ACCENT.absent.bg,
                        borderColor: isDark ? ACCENT.absent.borderDark : ACCENT.absent.border,
                      }}>
                      <span className="text-sm font-semibold" style={{ color: isDark ? D.text : '#0f172a' }}>
                        {d ? format(d, 'EEEE, MMM d, yyyy') : r.date}
                      </span>
                      <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-lg"
                        style={{ color: ACCENT.absent.fg, backgroundColor: isDark ? `${ACCENT.absent.fg}18` : `${ACCENT.absent.fg}10` }}>
                        Absent
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* ── Team overview (admin / cross-visibility only) ── */}
          {canViewTeam && (
            <Card className="p-5" style={{ backgroundColor: isDark ? D.card : '#ffffff', borderColor: isDark ? D.border : '#e2e8f0' }}>
              <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <h2 className="text-base font-bold flex items-center gap-2">
                  <Users className="w-4 h-4" style={{ color: COLORS.purple }} />
                  Team Overview
                </h2>
                <div className="flex items-center gap-2">
                  <Button variant="ghost" size="icon" onClick={() => setTeamMonth((m) => subMonths(m, 1))}>
                    <ChevronLeft className="w-4 h-4" />
                  </Button>
                  <span className="text-sm font-semibold w-28 text-center">{format(teamMonth, 'MMMM yyyy')}</span>
                  <Button variant="ghost" size="icon" onClick={() => setTeamMonth((m) => addMonths(m, 1))}>
                    <ChevronRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              {teamLoading ? (
                <div className="flex items-center gap-2 justify-center py-8" style={{ color: isDark ? D.muted : '#64748b' }}>
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading team data…
                </div>
              ) : (
                <div className="grid md:grid-cols-2 gap-4">
                  {/* Applied Leave (team) */}
                  <div className="rounded-xl border overflow-hidden" style={{ borderColor: isDark ? D.border : '#e2e8f0' }}>
                    <button onClick={() => setExpandLeave((v) => !v)}
                      className="w-full flex items-center justify-between px-4 py-3"
                      style={{ backgroundColor: isDark ? `${COLORS.amber}18` : `${COLORS.amber}0C` }}>
                      <span className="text-sm font-bold flex items-center gap-2" style={{ color: isDark ? '#fbbf24' : '#b45309' }}>
                        <CalendarOff className="w-4 h-4" /> Applied Leave
                        <Badge variant="outline" className="ml-1">{teamLeaveSummary.length}</Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${expandLeave ? 'rotate-180' : ''}`} />
                    </button>
                    <AnimatePresence>
                      {expandLeave && (
                        <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
                          <div className="p-3 space-y-2 max-h-64 overflow-y-auto">
                            {teamLeaveSummary.length === 0 ? (
                              <p className="text-xs text-center py-4" style={{ color: isDark ? D.muted : '#94a3b8' }}>No leave applied this month.</p>
                            ) : teamLeaveSummary.map((item) => (
                              <button key={item.user_id} onClick={() => setTeamDetail({ kind: 'leave', item })}
                                className="w-full flex items-center justify-between gap-2 p-2.5 rounded-lg text-left"
                                style={{ backgroundColor: isDark ? D.raised : '#f8fafc' }}>
                                <span className="text-sm font-semibold truncate" style={{ color: isDark ? D.text : '#1e293b' }}>{item.user_name}</span>
                                <span className="text-xs font-bold flex-shrink-0" style={{ color: '#b45309' }}>{item.leave_days} day{item.leave_days !== 1 ? 's' : ''}</span>
                              </button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* Absent This Month (team) */}
                  <div className="rounded-xl border overflow-hidden" style={{ borderColor: isDark ? D.border : '#e2e8f0' }}>
                    <button onClick={() => setExpandAbsent((v) => !v)}
                      className="w-full flex items-center justify-between px-4 py-3"
                      style={{ backgroundColor: isDark ? `${COLORS.red}18` : `${COLORS.red}0C` }}>
                      <span className="text-sm font-bold flex items-center gap-2" style={{ color: isDark ? '#f87171' : '#b91c1c' }}>
                        <UserX className="w-4 h-4" /> Absent This Month
                        <Badge variant="outline" className="ml-1">{teamAbsentSummary.length}</Badge>
                      </span>
                      <ChevronDown className={`w-4 h-4 transition-transform ${expandAbsent ? 'rotate-180' : ''}`} />
                    </button>
                    <AnimatePresence>
                      {expandAbsent && (
                        <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="overflow-hidden">
                          <div className="p-3 space-y-2 max-h-64 overflow-y-auto">
                            {teamAbsentSummary.length === 0 ? (
                              <p className="text-xs text-center py-4" style={{ color: isDark ? D.muted : '#94a3b8' }}>No absences this month.</p>
                            ) : teamAbsentSummary.map((item) => (
                              <button key={item.user_id} onClick={() => setTeamDetail({ kind: 'absent', item })}
                                className="w-full flex items-center justify-between gap-2 p-2.5 rounded-lg text-left"
                                style={{ backgroundColor: isDark ? D.raised : '#f8fafc' }}>
                                <span className="text-sm font-semibold truncate" style={{ color: isDark ? D.text : '#1e293b' }}>{item.user_name}</span>
                                <span className="text-xs font-bold flex-shrink-0" style={{ color: '#b91c1c' }}>{item.absent_days} day{item.absent_days !== 1 ? 's' : ''}</span>
                              </button>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              )}
            </Card>
          )}
        </>
      )}

      {/* ── Team detail modal ── */}
      <AnimatePresence>
        {teamDetail && <TeamDetailModal detail={teamDetail} onClose={() => setTeamDetail(null)} isDark={isDark} />}
      </AnimatePresence>

      {/* Apply Leave — shared modal, see components/attendance/ApplyLeaveModal.jsx.
          Using the same component the Attendance page uses guarantees
          applying leave here produces exactly the same result either way. */}
      <ApplyLeaveModal
        open={showApplyModal}
        onClose={() => setShowApplyModal(false)}
        onSubmitted={async () => { await fetchHistory(); if (canViewTeam) await fetchTeamSummary(); }}
        isDark={isDark}
        colors={COLORS}
        tokens={D}
        monthLeaveCount={myMonthLeaveForModal.count}
        monthLeaveRecords={myMonthLeaveForModal.records}
      />
    </div>
  );
}
