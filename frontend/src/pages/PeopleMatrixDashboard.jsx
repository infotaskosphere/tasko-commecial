import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowRight, BarChart3, Briefcase, CalendarDays, CheckCircle2,
  ClipboardList, FileText, IdCard, Loader2, Settings, ShieldCheck, UserCog,
  UserPlus, Users, Wallet, XCircle,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import api from '@/lib/api';
import useDark from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { listRuns } from '@/lib/payroll/store';

const MODULES = [
  { path: '/users', icon: Users, label: 'Users', description: 'Manage staff accounts, roles and permissions.', color: '#1F6FB2', permission: 'can_view_user_page', countKey: 'users' },
  { path: '/staff-activity', icon: Activity, label: 'Team Activity', description: 'Monitor login sessions, productivity and desktop activity.', color: '#1FAF5A', adminOnly: true, countKey: 'activityToday' },
  { path: '/leave', icon: CalendarDays, label: 'Leave', description: 'Applied leave, absences and the team leave calendar.', color: '#F59E0B', permission: 'can_view_leave', countKey: 'onLeaveToday' },
  { path: '/payroll', icon: Wallet, label: 'Payroll', description: 'Run monthly payroll, statutory deductions and payslips.', color: '#0EA5E9', permission: 'can_view_payroll', countKey: 'payrollRuns' },
  { path: '/hr', icon: IdCard, label: 'HR', description: 'Staff attendance trends and roster overview at a glance.', color: '#EC4899', permission: 'can_view_hr' },
  { path: '/recruitment', icon: Briefcase, label: 'Recruitment', description: 'Track candidates, resumes and the hiring pipeline end-to-end.', color: '#7C3AED', permission: 'can_view_recruitment', countKey: 'recruitment' },
  { path: '/reports', icon: BarChart3, label: 'Reports', description: 'Performance rankings, attendance and workforce reports.', color: '#F97316', adminOnly: true },
];

const QUICK_ACTIONS = [
  { path: '/users', icon: UserPlus, label: 'Add Employee', permission: 'can_view_user_page' },
  { path: '/leave', icon: CalendarDays, label: 'Apply Leave', permission: 'can_view_leave' },
  { path: '/attendance', icon: CheckCircle2, label: 'Attendance', permission: 'can_view_attendance' },
  { path: '/recruitment', icon: ClipboardList, label: 'Recruitment', permission: 'can_view_recruitment' },
  { path: '/payroll', icon: Wallet, label: 'Payroll', permission: 'can_view_payroll' },
  { path: '/reports', icon: BarChart3, label: 'Generate Report', adminOnly: true },
];

function extractCount(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return data.length;
  if (typeof data?.total === 'number') return data.total;
  if (typeof data?.count === 'number') return data.count;
  if (Array.isArray(data?.items)) return data.items.length;
  if (Array.isArray(data?.results)) return data.results.length;
  if (Array.isArray(data?.data)) return data.data.length;
  return null;
}

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase() || '—';
}

function KpiCard({ icon: Icon, label, value, color, loading, helper }) {
  return (
    <div className="pm-card pm-kpi p-4 sm:p-5 flex items-center gap-4 min-w-0">
      <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0" style={{ background: `${color}16` }}>
        <Icon className="h-5 w-5" style={{ color }} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-slate-500 truncate">{label}</p>
        <p className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white">
          {loading ? <Loader2 className="h-5 w-5 animate-spin text-slate-400" /> : value ?? '—'}
        </p>
        {helper && <p className="text-[10px] font-semibold text-slate-400 mt-0.5">{helper}</p>}
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children, action, isDark }) {
  return (
    <section className="pm-card overflow-hidden min-w-0">
      <div className="px-5 py-4 border-b flex items-center justify-between gap-3" style={{ borderColor: isDark ? '#1e293b' : '#eef2f7' }}>
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold text-slate-800 dark:text-slate-100 truncate">{title}</h2>
          {subtitle && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export default function PeopleMatrixDashboard() {
  const isDark = useDark();
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({});
  const [employees, setEmployees] = useState([]);
  const [birthdays, setBirthdays] = useState([]);
  const [activityRows, setActivityRows] = useState([]);

  const canSee = (item) => {
    if (item.adminOnly) return user?.role === 'admin';
    if (!item.permission || user?.role === 'admin') return true;
    return hasPermission(item.permission);
  };

  const visibleModules = useMemo(() => MODULES.filter(canSee), [user, hasPermission]);
  const quickActions = useMemo(() => QUICK_ACTIONS.filter(canSee), [user, hasPermission]);

  useEffect(() => {
    let cancelled = false;
    const today = new Date().toISOString().slice(0, 10);
    const monthKey = today.slice(0, 7);
    (async () => {
      setLoading(true);
      const requests = {
        users: api.get('/users', { _silent: true }),
        recruitment: api.get('/recruitment', { _silent: true }),
        activity: api.get('/activity/summary', { params: { date_from: today, date_to: `${today}T23:59:59` }, _silent: true }),
        leave: api.get('/attendance/leave-summary', { params: { month: monthKey }, _silent: true }),
      };
      const keys = Object.keys(requests);
      const results = await Promise.allSettled(keys.map((key) => requests[key]));
      if (cancelled) return;
      const next = {};
      results.forEach((result, index) => {
        const key = keys[index];
        if (result.status !== 'fulfilled') return;
        const data = result.value?.data;
        if (key === 'activity') {
          const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
          next.activityToday = list.filter((row) => Number(row.total_active_seconds || row.active_time || 0) > 0).length;
          setActivityRows(list.slice(0, 4));
        } else if (key === 'leave') {
          const list = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
          next.onLeaveToday = list.filter((row) => Array.isArray(row.records) && row.records.some((record) => record.date === today)).length;
        } else if (key === 'users') {
          next.users = extractCount(data);
          const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : Array.isArray(data?.results) ? data.results : Array.isArray(data?.data) ? data.data : [];
          setEmployees(list.slice(0, 5));
          const upcoming = list.filter((person) => {
            const raw = person.date_of_birth || person.dob || person.birth_date;
            if (!raw) return false;
            const value = String(raw).slice(0, 10);
            return value.slice(5) >= today.slice(5);
          }).slice(0, 3);
          setBirthdays(upcoming);
        } else {
          next[key] = extractCount(data);
        }
      });
      try { next.payrollRuns = (listRuns() || []).length; } catch { next.payrollRuns = null; }
      setCounts(next);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const fmt = (value) => value == null ? '—' : value;
  const dateLabel = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date());

  return (
    <div className="people-matrix-dashboard space-y-5">
      <section className="pm-hero px-5 py-5 sm:px-7 sm:py-6">
        <div className="relative z-10 flex flex-col xl:flex-row xl:items-center justify-between gap-6 h-full">
          <div className="min-w-0 max-w-2xl">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.18em] text-[#1F6FB2] mb-2 flex items-center gap-2"><UserCog className="h-3.5 w-3.5" /> People Matrix</p>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight text-[#0D3B66] dark:text-white">Good Evening, {user?.full_name?.split(' ')[0] || 'there'}! <span aria-hidden="true">👋</span></h1>
            <p className="text-sm font-semibold text-slate-600 dark:text-slate-300 mt-1">Great people build greater businesses.</p>
            <p className="text-sm italic text-slate-500 dark:text-slate-400 mt-2">“Empower people today for a stronger tomorrow.”</p>
          </div>
          <div className="relative z-10 shrink-0 rounded-2xl border border-white/70 dark:border-slate-700 bg-white/85 dark:bg-slate-900/80 backdrop-blur px-5 py-4 min-w-[250px]">
            <div className="flex items-center gap-3"><CalendarDays className="h-5 w-5 text-[#1F6FB2]" /><div><p className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Today</p><p className="text-sm font-extrabold text-slate-800 dark:text-white">{dateLabel}</p></div></div>
            <div className="flex items-center gap-2 mt-3"><div className="h-2 w-2 rounded-full bg-[#1FAF5A]" /><span className="text-xs font-semibold text-slate-500 dark:text-slate-400">People Matrix workspace active</span></div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard icon={Users} label="Total Employees" value={fmt(counts.users)} color="#1F6FB2" loading={loading} helper="Live staff records" />
        <KpiCard icon={Activity} label="Active Today" value={fmt(counts.activityToday)} color="#1FAF5A" loading={loading} helper="Recorded activity" />
        <KpiCard icon={CalendarDays} label="On Leave Today" value={fmt(counts.onLeaveToday)} color="#F59E0B" loading={loading} helper="Leave records" />
        <KpiCard icon={Briefcase} label="Candidates" value={fmt(counts.recruitment)} color="#7C3AED" loading={loading} helper="Recruitment pipeline" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,.9fr)] gap-5">
        <Panel title="People Matrix Modules" subtitle="Every existing People Matrix feature remains available with the current permission model." isDark={isDark}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-4">
            {visibleModules.map((module) => {
              const Icon = module.icon;
              return <button key={module.path} type="button" onClick={() => navigate(module.path)} className="pm-action p-4 text-left flex flex-col gap-3 cursor-pointer group">
                <div className="flex items-center justify-between"><span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: `${module.color}16` }}><Icon className="h-5 w-5" style={{ color: module.color }} /></span>{module.countKey && counts[module.countKey] != null && <span className="text-[10px] font-extrabold px-2 py-1 rounded-full" style={{ color: module.color, background: `${module.color}12` }}>{counts[module.countKey]}</span>}</div>
                <div className="min-w-0"><h3 className="text-sm font-extrabold text-slate-800 dark:text-white">{module.label}</h3><p className="text-[11px] leading-relaxed text-slate-500 dark:text-slate-400 mt-1 line-clamp-2">{module.description}</p></div>
                <span className="mt-auto flex items-center gap-1 text-[11px] font-extrabold text-blue-600">Open <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1" /></span>
              </button>;
            })}
          </div>
        </Panel>

        <Panel title="Quick Actions" subtitle="Shortcuts to the current People Matrix features." isDark={isDark}>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-2 gap-3 p-4">
            {quickActions.map((action) => { const Icon = action.icon; return <button key={action.path} type="button" onClick={() => navigate(action.path)} className="pm-action px-3 py-4 flex flex-col items-center justify-center text-center gap-2 cursor-pointer group"><span className="w-9 h-9 rounded-xl bg-blue-50 dark:bg-blue-500/10 flex items-center justify-center"><Icon className="h-4 w-4 text-blue-600" /></span><span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">{action.label}</span></button>; })}
          </div>
        </Panel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Panel title="Recent Staff" subtitle="Latest records available to this workspace." action={<button type="button" onClick={() => navigate('/users')} className="text-[11px] font-bold text-blue-600">View all</button>} isDark={isDark}>
          <div className="px-5">
            {employees.length ? employees.map((person, index) => { const name = person.full_name || person.name || person.username || 'Unnamed employee'; return <div className="pm-list-row py-3 flex items-center gap-3" key={person.id || index}><div className="w-9 h-9 rounded-full bg-blue-50 dark:bg-blue-500/10 text-blue-600 flex items-center justify-center text-[10px] font-extrabold">{initials(name)}</div><div className="min-w-0"><p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">{name}</p><p className="text-[10px] text-slate-400 truncate">{person.role || person.designation || person.department || 'Staff'}</p></div></div>; }) : <div className="py-8 text-center text-xs text-slate-400">No staff records available.</div>}
          </div>
        </Panel>

        <Panel title="Upcoming Birthdays" subtitle="Only dates present in staff records are shown." action={<button type="button" onClick={() => navigate('/users')} className="text-[11px] font-bold text-blue-600">View all</button>} isDark={isDark}>
          <div className="px-5">
            {birthdays.length ? birthdays.map((person, index) => { const name = person.full_name || person.name || 'Employee'; const dob = person.date_of_birth || person.dob || person.birth_date; return <div className="pm-list-row py-3 flex items-center gap-3" key={person.id || index}><div className="w-9 h-9 rounded-full bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 flex items-center justify-center text-[10px] font-extrabold">{initials(name)}</div><div className="min-w-0 flex-1"><p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">{name}</p><p className="text-[10px] text-slate-400">{String(dob).slice(5, 10)}</p></div></div>; }) : <div className="py-8 text-center text-xs text-slate-400">Birthday data is not available.</div>}
          </div>
        </Panel>

        <Panel title="Today's Activity" subtitle="Live activity records where available." action={<button type="button" onClick={() => navigate('/staff-activity')} className="text-[11px] font-bold text-blue-600">Open activity</button>} isDark={isDark}>
          <div className="px-5">
            {activityRows.length ? activityRows.map((row, index) => { const name = row.user_name || row.full_name || row.email || 'Staff member'; const active = Number(row.total_active_seconds || row.active_time || 0); return <div className="pm-list-row py-3 flex items-center gap-3" key={row.user_id || row.id || index}><Activity className="h-4 w-4 text-[#1FAF5A] shrink-0" /><div className="min-w-0 flex-1"><p className="text-xs font-bold text-slate-800 dark:text-slate-100 truncate">{name}</p><p className="text-[10px] text-slate-400">{active > 0 ? 'Activity recorded today' : 'No active time recorded'}</p></div>{active > 0 ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-slate-300" />}</div>; }) : <div className="py-8 text-center text-xs text-slate-400">No activity data available.</div>}
          </div>
        </Panel>
      </div>

      <div className="pm-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div><p className="text-[11px] font-extrabold uppercase tracking-widest text-[#1F6FB2]">People Matrix</p><h2 className="text-lg font-extrabold text-slate-800 dark:text-white mt-1">Workforce management, kept together.</h2><p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Use the module tabs above and the current sidebar to manage people, leave, payroll, HR and recruitment.</p></div>
        <button type="button" onClick={() => navigate('/settings/general')} className="shrink-0 inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-[#0D3B66] text-white text-xs font-bold hover:bg-[#0b3155] transition-colors"><Settings className="h-4 w-4" /> Workspace Settings</button>
      </div>
    </div>
  );
}
