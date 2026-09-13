import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { useActivityTracker } from '@/hooks/useActivityTracker';
import {
  LayoutDashboard, CheckSquare, FileText, Clock, BarChart3,
  Users, LogOut, Menu, Activity, ChevronDown,
  PanelLeftClose, PanelLeftOpen, Target, Sun, Moon, MapPin,
  Settings, Mail, Receipt, X, KeyRound, BrainCircuit,
  CreditCard, Fingerprint, Bell, Shield, ShieldCheck, ArrowLeftRight, MessageCircle,
  Building2, Zap, Briefcase, ShoppingBag, Landmark, BookOpen, NotebookPen,
  ScanLine, Lock, Search, Loader2,
  Wallet, CalendarOff, UserPlus, Cake,
  Database, FolderOpen, MessagesSquare, FileBarChart2, Phone,
  Crown, Globe,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import NotificationBell from './NotificationBell';
import GifLoader from '@/components/ui/GifLoader.jsx';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';
import api from '@/lib/api';

const COLORS = {
  deepBlue: '#0D3B66', mediumBlue: '#1F6FB2', lightBlue: '#E0F2FE',
  emeraldGreen: '#1FAF5A', lightGreen: '#5CCB5F', sidebarBg: '#0D3B66',
  sidebarBgSoft: '#0A2E52', sidebarBorder: 'rgba(255,255,255,0.08)', sidebarActive: '#2B8CD1',
};
const SIDEBAR_EXPANDED = 280, SIDEBAR_COLLAPSED = 80, HEADER_H = 64, SECTION_BAR_H = 40;
const TOTAL_HEADER_H = HEADER_H + SECTION_BAR_H;

const NAV_GROUPS = [
  { id: 'core', items: [
    { path: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: 'can_view_dashboard' },
    { path: '/tasks', icon: CheckSquare, label: 'Tasks', permission: 'can_view_tasks' },
    { path: '/todos', icon: CheckSquare, label: 'To Do', permission: 'can_view_todo_dashboard' },
    { path: '/attendance', icon: Clock, label: 'Attendance', permission: 'can_view_attendance' },
    { path: '/reminders', icon: Bell, label: 'Reminders', permission: 'can_view_reminders' },
    { path: '/action-center', icon: Zap, label: 'Action Center', permission: 'can_view_action_center' },
    { path: '/visits', icon: MapPin, label: 'Client Visits', permission: 'can_view_client_visits' },
    { path: '/ai-reader', icon: BrainCircuit, label: 'AI Document Reader', permission: 'can_view_ai_document_reader' },
    { path: '/client-portal-manager', icon: Building2, label: 'Client Portal', permission: 'can_view_client_portal' },
  ]},
  { id: 'compliance', dividerLabel: 'Compliance', items: [
    { path: '/compliance-dashboard', icon: LayoutDashboard, label: 'Compliance Dashboard' },
    { path: '/compliance', icon: ShieldCheck, label: 'Compliance Tracker', permission: 'can_view_compliance' },
    { path: '/gst-reconciliation', icon: ArrowLeftRight, label: 'GST Reconciliation', permission: 'can_view_gst_reconciliation' },
    { path: '/trademark-sphere', icon: Shield, label: 'Trademark Sphere', permission: 'can_view_trademark_sphere' },
    { path: '/roc-sphere', icon: Landmark, label: 'ROC Sphere', permission: 'can_view_roc_sphere' },
    { path: '/mis-report', icon: FileBarChart2, label: 'MIS Report', permission: 'can_view_mis_report' },
    { path: '/salary-slips', icon: Receipt, label: 'Salary Slip Generator', permission: 'can_view_salary_slips' },
  ]},
  { id: 'records', dividerLabel: 'Records', items: [
    { path: '/records-dashboard', icon: LayoutDashboard, label: 'Records Dashboard' },
    { path: '/dsc', icon: FileText, label: 'DSC Register', permission: 'can_view_all_dsc' },
    { path: '/documents', icon: FileText, label: 'Document Register', permission: 'can_view_documents' },
    { path: '/clients', icon: Users, label: 'Clients' },
    { path: '/passwords', icon: KeyRound, label: 'Password Vault', permission: 'can_view_passwords' },
    { path: '/client-approvals', icon: UserPlus, label: 'Client Approvals' },
    { path: '/automation/approvals', icon: Cake, label: 'Automation Approvals', permission: ['can_approve_whatsapp_wishes', 'can_approve_email_wishes'] },
  ]},
  { id: 'proposals', dividerLabel: 'Client Proposals', items: [
    { path: '/client-proposals-dashboard', icon: LayoutDashboard, label: 'Client Proposals Dashboard' },
    { path: '/leads', icon: Target, label: 'Lead Management', permission: 'can_view_all_leads' },
    { path: '/quotations', icon: Receipt, label: 'Quotations', permission: 'can_create_quotations' },
    { path: '/client-discussion', icon: MessagesSquare, label: 'Client Discussion', permission: 'can_view_client_discussion' },
  ]},
  { id: 'accounts', dividerLabel: 'Accounts', items: [
    { path: '/finix-dashboard', icon: LayoutDashboard, label: 'Finix Dashboard', permission: 'can_view_accounting_reports' },
    { path: '/invoicing', icon: CreditCard, label: 'Sales', permission: ['can_manage_invoices', 'can_create_quotations', 'can_view_sale'] },
    { path: '/purchase', icon: ShoppingBag, label: 'Purchase', permission: ['can_manage_invoices', 'can_create_quotations', 'can_view_purchase'] },
    { path: '/bank-accounts', icon: Landmark, label: 'Bank Accounts', permission: 'can_view_bank' },
    { path: '/journal-entries', icon: NotebookPen, label: 'Journal Entries', permission: ['can_view_journal_entries', 'can_post_journal_entries'] },
    { path: '/zero-touch-entry', icon: ScanLine, label: 'Zero Touch Entries', permission: 'can_post_journal_entries' },
    { path: '/accounting-reports', icon: BarChart3, label: 'Accounting Reports', permission: 'can_view_accounting_reports' },
    { path: '/day-book', icon: BarChart3, label: 'Extended Accounts Reports', permission: 'can_view_accounting_reports' },
    { path: '/gst-portal-sync', icon: Landmark, label: 'Live GST Portal Sync', permission: 'can_view_accounting_reports' },
    { path: '/accounting-integrity', icon: Lock, label: 'Accounting Integrity', permission: 'can_manage_chart_of_accounts' },
    { path: '/chart-of-accounts', icon: BookOpen, label: 'Charts of Accounts', permission: ['can_view_chart_of_accounts', 'can_manage_chart_of_accounts'] },
  ]},
  { id: 'people-matrix', dividerLabel: 'People Matrix', items: [
    { path: '/people-matrix', icon: LayoutDashboard, label: 'People Matrix Dashboard' },
    { path: '/users', icon: Users, label: 'Users', permission: 'can_view_user_page' },
    { path: '/leave', icon: CalendarOff, label: 'Leave', permission: 'can_view_leave' },
    { path: '/payroll', icon: Wallet, label: 'Payroll', permission: 'can_view_payroll' },
    { path: '/hr', icon: Briefcase, label: 'HR', permission: 'can_view_hr' },
    { path: '/recruitment', icon: UserPlus, label: 'Recruitment', permission: 'can_view_recruitment' },
  ]},
  { id: 'admin', dividerLabel: 'Admin', items: [
    { path: '/admin-dashboard', icon: LayoutDashboard, label: 'Admin Dashboard', adminOnly: true },
    { path: '/permission-matrix', icon: ShieldCheck, label: 'Permission Matrix', adminOnly: true },
    { path: '/staff-activity', icon: Activity, label: 'Team Activity', adminOnly: true },
    { path: '/reports', icon: BarChart3, label: 'Reports', adminOnly: true },
    { path: '/task-audit', icon: Activity, label: 'Audit Logs', adminOnly: true },
    { path: '/master-data', icon: Database, label: 'Master Data', adminOnly: true },
    { path: '/roles', icon: Fingerprint, label: 'Roles', adminOnly: true },
    { path: '/contact-details', icon: Phone, label: 'Contact Details', adminOnly: true },
    { path: '/whatsapp-hub', icon: MessageCircle, label: 'Unified Inbox', adminOnly: true },
  ]},
  { id: 'settings', dividerLabel: 'Settings', items: [
    { path: '/settings/email', icon: Mail, label: 'Email Accounts' },
    { path: '/settings/general', icon: Settings, label: 'General Settings' },
    { path: '/settings/whatsapp', icon: MessageCircle, label: 'Message Automation' },
  ]},
];

const SECTION_META = {
  core: { label: 'Taskosphere', icon: LayoutDashboard, landingPath: '/dashboard' },
  accounts: { label: 'Finix', icon: CreditCard, landingPath: '/finix-dashboard' },
  compliance: { label: 'Compliance', icon: ShieldCheck, landingPath: '/compliance-dashboard' },
  records: { label: 'Records', icon: FileText, landingPath: '/records-dashboard' },
  proposals: { label: 'Client Proposals', icon: Target, landingPath: '/client-proposals-dashboard' },
  'people-matrix': { label: 'People Matrix', icon: Fingerprint, landingPath: '/people-matrix' },
  admin: { label: 'Admin', icon: Lock, landingPath: '/admin-dashboard' },
  settings: { label: 'Settings', icon: Settings, landingPath: '/settings/general' },
};
const SECTION_ORDER = ['core', 'accounts', 'compliance', 'records', 'proposals', 'people-matrix', 'admin', 'settings'];
const GROUP_MODULE_FLAG = { core: 'can_access_taskosphere', accounts: 'can_access_finix', compliance: 'can_access_compliance', records: 'can_access_records', proposals: 'can_access_proposals', 'people-matrix': 'can_access_people_matrix' };
const ITEM_GROUP_ID = new Map();
NAV_GROUPS.forEach((group) => group.items.forEach((item) => ITEM_GROUP_ID.set(item.path, group.id)));
const RIGHT_ALIGNED_SECTIONS = ['admin', 'settings'];
const LEFT_SECTIONS = SECTION_ORDER.filter((id) => !RIGHT_ALIGNED_SECTIONS.includes(id));
const RIGHT_SECTIONS = SECTION_ORDER.filter((id) => RIGHT_ALIGNED_SECTIONS.includes(id));
const EXTRA_SECTION_PREFIXES = [
  ['/day-book', 'accounts'], ['/cash-bank-book', 'accounts'], ['/cash-flow', 'accounts'], ['/outstanding-report', 'accounts'],
  ['/bank-reconciliation', 'accounts'], ['/depreciation', 'accounts'], ['/tds-tcs', 'accounts'], ['/financial-ratios', 'accounts'],
  ['/comparative-report', 'accounts'], ['/yearly-report', 'accounts'], ['/opening-balances', 'accounts'], ['/accounting-audit-trail', 'accounts'],
  ['/bulk-import', 'accounts'], ['/due-dates', 'accounts'], ['/import-invoices', 'accounts'], ['/settings', 'settings'],
];
function getSectionForPath(pathname) {
  let best = null;
  for (const group of NAV_GROUPS) for (const item of group.items) {
    if (pathname === item.path || pathname.startsWith(item.path + '/')) if (!best || item.path.length > best.path.length) best = { path: item.path, groupId: group.id };
  }
  if (best) return best.groupId;
  for (const [prefix, groupId] of EXTRA_SECTION_PREFIXES) if (pathname === prefix || pathname.startsWith(prefix + '/')) return groupId;
  return 'core';
}
const EXTRA_PAGE_TITLES = {
  '/users': 'Users', '/people-matrix': 'People Matrix Dashboard', '/team-activity': 'Team Activity', '/reports': 'Reports',
  '/leave': 'Leave', '/payroll': 'Payroll', '/hr': 'HR', '/recruitment': 'Recruitment', '/admin-dashboard': 'Admin Dashboard',
  '/contact-details': 'Contact Details', '/task-audit': 'Task Audit', '/client-portal-manager': 'Client Portal Manager',
  '/settings': 'Settings', '/records-dashboard': 'Records Dashboard', '/client-approvals': 'Client Approvals',
  '/master-console': 'Commercial Console', '/master-console/website': 'Website Studio',
};
const PLATFORM_OWNER_TOOLS = [
  { path: '/master-console', icon: Crown, label: 'Commercial Console' },
  { path: '/master-console/website', icon: Globe, label: 'Website Studio' },
];
const springSnap = { type: 'spring', stiffness: 500, damping: 28 }, springMed = { type: 'spring', stiffness: 400, damping: 24 }, springSoft = { type: 'spring', stiffness: 300, damping: 20 };

const DashboardLayout = ({ children }) => {
  const { user, logout, hasPermission, loading, isPlatformOwner } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && localStorage.getItem('sidebarCollapsed') === 'true');
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [isDark, setIsDark] = useState(() => typeof window !== 'undefined' && localStorage.getItem('theme') === 'dark');
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024);
  const [hasUnread, setHasUnread] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const sidebarNavRef = useRef(null), mainRef = useRef(null), activeItemRef = useRef(null);
  useEffect(() => { if (mainRef.current) mainRef.current.scrollTo({ top: 0, behavior: 'auto' }); }, [location.pathname]);
  useEffect(() => { if (activeItemRef.current) activeItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [location.pathname]);
  useEffect(() => { localStorage.setItem('theme', isDark ? 'dark' : 'light'); document.documentElement.classList.toggle('dark', isDark); }, [isDark]);
  useActivityTracker(!!user);
  useEffect(() => { localStorage.setItem('sidebarCollapsed', String(collapsed)); }, [collapsed]);
  const handleResize = useCallback(() => { const desktop = window.innerWidth >= 1024; setIsDesktop(desktop); if (!desktop) setCollapsed(false); }, []);
  useEffect(() => { window.addEventListener('resize', handleResize); handleResize(); return () => window.removeEventListener('resize', handleResize); }, [handleResize]);
  useEffect(() => { if (window.innerWidth >= 1024) setSidebarOpen(true); }, []);
  useEffect(() => { if (!isDesktop) setSidebarOpen(false); }, [location.pathname, isDesktop]);
  useEffect(() => { if (!userMenuOpen) return; const handle = (e) => { if (!e.target.closest('[data-user-menu]')) setUserMenuOpen(false); }; document.addEventListener('mousedown', handle); return () => document.removeEventListener('mousedown', handle); }, [userMenuOpen]);
  useEffect(() => {
    const fetchUnread = async () => { try { const { data } = await api.get('/notifications/unread-count', { _silent: true }); setHasUnread((data?.count ?? 0) > 0); } catch {} };
    fetchUnread(); const interval = setInterval(fetchUnread, 30000); return () => clearInterval(interval);
  }, []);
  if (loading) return <GifLoader />;
  if (!user) { navigate('/login', { replace: true }); return null; }
  const handleLogout = async () => {
    if (window.__TASKO_LOGOUT_IN_PROGRESS__) return;
    window.__TASKO_LOGOUT_IN_PROGRESS__ = true;
    window.__STOP_ACTIVITY__ = true;
    setUserMenuOpen(false);
    try {
      await logout();
    } finally {
      toast.success('Logged out successfully');
      navigate('/login', { replace: true });
      window.setTimeout(() => { window.__TASKO_LOGOUT_IN_PROGRESS__ = false; }, 500);
    }
  };
  const checkNavPermission = (item) => {
    if (item.adminOnly) return user?.role === 'admin';
    const groupId = ITEM_GROUP_ID.get(item.path);
    const moduleFlag = GROUP_MODULE_FLAG[groupId];
    if (moduleFlag && !hasPermission(moduleFlag)) return false;
    const permission = item.permission;
    if (!permission) return true;
    if (Array.isArray(permission)) return permission.some(p => hasPermission(p));
    return hasPermission(permission);
  };
  const allNavItems = NAV_GROUPS.flatMap(g => g.items);
  const activeLabel = useMemo(() => {
    const path = location.pathname; let best = null;
    for (const item of allNavItems) if (path === item.path || path.startsWith(item.path + '/')) if (!best || item.path.length > best.path.length) best = item;
    if (best) return best.label; if (EXTRA_PAGE_TITLES[path]) return EXTRA_PAGE_TITLES[path];
    const matchedPrefix = Object.keys(EXTRA_PAGE_TITLES).filter(k => path.startsWith(k + '/')).sort((a,b) => b.length-a.length)[0];
    if (matchedPrefix) return EXTRA_PAGE_TITLES[matchedPrefix]; const slug = path.split('/').filter(Boolean).pop(); return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Dashboard';
  }, [location.pathname]);
  useEffect(() => { document.title = `${activeLabel} · Task-O-Sphere`; }, [activeLabel]);
  const activeSectionId = useMemo(() => getSectionForPath(location.pathname), [location.pathname]);
  useEffect(() => {
    const currentModuleFlag = GROUP_MODULE_FLAG[activeSectionId];
    if (currentModuleFlag && !hasPermission(currentModuleFlag)) {
      const permittedSection = LEFT_SECTIONS.find((id) => { const flag = GROUP_MODULE_FLAG[id]; return !flag || hasPermission(flag); });
      const target = permittedSection ? SECTION_META[permittedSection]?.landingPath || '/dashboard' : '/dashboard';
      if (location.pathname !== target) navigate(target, { replace: true });
    }
  }, [activeSectionId, hasPermission, navigate, location.pathname]);
  const sidebarPx = collapsed ? SIDEBAR_COLLAPSED : SIDEBAR_EXPANDED, offsetPx = isDesktop ? sidebarPx : 0;
  const NavItem = ({ item }) => {
    if (!checkNavPermission(item)) return null;
    const isActive = location.pathname === item.path || (!item.exact && location.pathname.startsWith(item.path + '/') && item.path !== '/');
    const Icon = item.icon;
    return <motion.div ref={isActive ? activeItemRef : null} whileHover={{ x: collapsed ? 0 : 3 }} whileTap={{ scale: 0.97 }} transition={springSnap}>
      <Link to={item.path} onMouseEnter={item.path === '/tasks' ? () => { import('@/pages/Tasks.jsx').catch(() => {}); } : undefined} onFocus={item.path === '/tasks' ? () => { import('@/pages/Tasks.jsx').catch(() => {}); } : undefined} title={collapsed ? item.label : undefined} className={`relative flex items-center gap-3 min-w-0 ${collapsed ? 'justify-center px-0 py-3' : 'px-3 py-2.5'} rounded-lg transition-colors duration-150 group ${isActive ? 'bg-white/[0.09] text-white' : 'text-slate-300 hover:text-white hover:bg-white/[0.07]'}`}>
        {isActive && <span className={`absolute left-0 rounded-r-full ${collapsed ? 'top-1/2 -translate-y-1/2 w-[3px] h-7' : 'top-1/2 -translate-y-1/2 w-[3px] h-5'}`} style={{ background: COLORS.mediumBlue }} />}
        <Icon className={`flex-shrink-0 transition-colors ${collapsed ? 'h-5 w-5' : 'h-4 w-4'} ${isActive ? 'text-white' : 'text-slate-400 group-hover:text-slate-100'}`} />
        {!collapsed && <span className="font-medium text-sm whitespace-nowrap tracking-tight truncate">{item.label}</span>}
        {collapsed && <div className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-800 text-white text-xs font-medium rounded-lg whitespace-nowrap pointer-events-none opacity-0 group-hover:opacity-100 translate-x-1 group-hover:translate-x-0 transition-all duration-200 z-[100] shadow-lg">{item.label}<span className="absolute right-full top-1/2 -translate-y-1/2 border-4 border-transparent border-r-slate-800" /></div>}
      </Link>
    </motion.div>;
  };
  const renderSectionTabs = (sectionIds) => sectionIds.map((sectionId) => {
    const meta = SECTION_META[sectionId]; if (!meta) return null;
    const moduleFlag = GROUP_MODULE_FLAG[sectionId]; if (moduleFlag && !hasPermission(moduleFlag)) return null;
    const group = NAV_GROUPS.find(g => g.id === sectionId); const hasVisibleItems = group?.items.some(item => checkNavPermission(item)); if (!hasVisibleItems) return null;
    const Icon = meta.icon, isActive = sectionId === activeSectionId;
    return <button key={sectionId} id={`nav-tab-${sectionId}`} onClick={() => navigate(meta.landingPath)} className={`group flex items-center gap-1.5 sm:gap-2 px-3 sm:px-3.5 h-full text-[13px] whitespace-nowrap flex-shrink-0 cursor-pointer border-b-2 transition-colors ${isActive ? 'font-semibold text-slate-900 dark:text-white border-[#1F6FB2] dark:border-blue-500 bg-transparent' : 'font-medium text-slate-600 dark:text-slate-400 border-transparent hover:text-slate-900 dark:hover:text-slate-100 hover:bg-transparent'}`}>
      <Icon className={`h-4 w-4 flex-shrink-0 transition-colors ${isActive ? 'text-slate-900 dark:text-white' : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-800 dark:group-hover:text-slate-200'}`} /><span>{meta.label}</span>
    </button>;
  });
  return <div className={`min-h-screen relative ${isDark ? 'bg-[#0f172a]' : 'bg-[#F4F6FA]'}`} style={{ overflowX: 'hidden' }}>
    <AnimatePresence>{sidebarOpen && !isDesktop && <motion.div className="fixed inset-0 bg-emerald-900/50 z-40 lg:hidden backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setSidebarOpen(false)} />}</AnimatePresence>
    <aside className={`fixed left-0 z-[45] flex flex-col transition-all duration-300 ease-in-out ${isDesktop ? 'translate-x-0' : sidebarOpen ? 'translate-x-0' : '-translate-x-full'}`} style={{ top: TOTAL_HEADER_H, height: `calc(100% - ${TOTAL_HEADER_H}px)`, width: sidebarPx, background: `linear-gradient(180deg, ${COLORS.sidebarBg} 0%, ${COLORS.sidebarBgSoft} 100%)`, borderRight: `1px solid ${COLORS.sidebarBorder}`, boxShadow: '10px 0 30px rgba(0,0,0,0.25)' }}>
      <div ref={sidebarNavRef} className="flex-1 overflow-y-auto overflow-x-hidden slim-scroll sidebar-scroll py-4">{NAV_GROUPS.filter(group => group.id === activeSectionId).map(group => { const visibleGroupItems = group.items.filter(item => checkNavPermission(item)); if (!visibleGroupItems.length) return null; return <div key={group.id} className="mb-2"><div className={`space-y-1 ${collapsed ? 'px-2' : 'px-3'}`}>{visibleGroupItems.map(item => <NavItem key={item.path} item={item} />)}</div></div>; })}</div>
      <div className="p-4 border-t hidden lg:block" style={{ borderColor: COLORS.sidebarBorder }}>{isPlatformOwner && <div className="space-y-1 mb-1">{PLATFORM_OWNER_TOOLS.map(item => { const isToolActive = location.pathname === item.path || location.pathname.startsWith(item.path + '/'), ToolIcon = item.icon; return <motion.div key={item.path} whileHover={{ x: collapsed ? 0 : 3 }} whileTap={{ scale: 0.97 }} transition={springSnap}><Button variant="ghost" onClick={() => navigate(item.path)} title={collapsed ? item.label : undefined} className={`w-full flex items-center ${collapsed ? 'justify-center' : 'justify-start gap-3'} h-11 rounded-xl transition-all ${isToolActive ? 'bg-white/[0.09] text-white' : 'text-slate-300 hover:text-white hover:bg-white/[0.07]'}`}><ToolIcon className="h-4 w-4 flex-shrink-0" />{!collapsed && <span className="text-sm font-medium">{item.label}</span>}</Button></motion.div>; })}</div>}<Button variant="ghost" onClick={() => setCollapsed(!collapsed)} className={`w-full flex items-center ${collapsed ? 'justify-center' : 'justify-start gap-3'} h-11 rounded-xl text-slate-300 hover:text-white hover:bg-white/[0.07] transition-all`}>{collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <><PanelLeftClose className="h-4 w-4" /><span className="text-sm font-medium">Collapse Sidebar</span></>}</Button></div>
    </aside>
    <header className="fixed top-0 left-0 right-0 z-50 flex items-center transition-all duration-300 ease-in-out backdrop-blur-md" style={{ height: HEADER_H, background: isDark ? 'linear-gradient(90deg, rgba(15,23,42,0.94) 0%, rgba(23,37,64,0.94) 100%)' : `linear-gradient(90deg, rgba(255,255,255,0.95) 0%, ${COLORS.deepBlue}0d 100%)`, borderBottom: isDark ? '1px solid #334155' : '1px solid #e2e8f0', overflow: 'visible' }}>
      <div className="flex items-center flex-shrink-0 h-full transition-all duration-300 ease-in-out overflow-hidden" style={{ width: isDesktop ? sidebarPx : 'auto', paddingLeft: isDesktop ? 0 : undefined }}><Link to="/dashboard" className="relative flex items-center justify-center w-full min-w-0"><div className="relative flex-shrink-0 flex items-center justify-center"><img src="/logo-lite.png" alt="" aria-hidden="true" style={{ display: 'none' }} /><img src="/logo-dark.png" alt="" aria-hidden="true" style={{ display: 'none' }} />{collapsed && isDesktop ? <img src="/icon-192.png" alt="Task-O-Sphere" className="object-contain block" style={{ height: 52, width: 52 }} /> : <img key={isDark ? 'dark' : 'lite'} src={isDark ? '/logo-dark.png' : '/logo-lite.png'} alt="Task-O-Sphere" className="object-contain block mx-auto transition-opacity duration-150" style={{ height: 54, maxWidth: isDesktop ? sidebarPx - 24 : 200 }} />}</div></Link></div>
      <div className="flex-1 flex items-center justify-between px-3 sm:px-5 min-w-0 gap-2 h-full border-l" style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}><div className="flex items-center gap-2 sm:gap-4 min-w-0"><button onClick={() => setSidebarOpen(prev => !prev)} className="lg:hidden flex-shrink-0 p-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 active:scale-95 transition-all" aria-label="Toggle sidebar"><Menu className="h-5 w-5" /></button><motion.h1 key={location.pathname} className={`text-xs sm:text-sm font-semibold truncate min-w-0 tracking-tight max-w-[80px] xs:max-w-[130px] sm:max-w-[260px] ${isDark ? 'text-slate-100' : 'text-slate-800'}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 400, damping: 26 }}>{activeLabel}</motion.h1></div><div className="flex items-center gap-1.5 sm:gap-3 flex-shrink-0"><motion.button whileTap={{ scale: 0.95 }} onClick={() => setSearchOpen(true)} className={`p-2 rounded-lg border flex items-center justify-center transition-all cursor-pointer ${isDark ? 'border-slate-600 hover:border-slate-500 hover:bg-slate-800 text-slate-300' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-100 text-slate-600'}`} title="Enterprise Search"><Search className="h-4 w-4" /></motion.button><motion.button whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} onClick={() => setCopilotOpen(true)} className="relative p-2 rounded-lg flex items-center justify-center transition-all cursor-pointer shadow-[0_1px_2px_rgba(15,23,42,0.15)]" style={{ background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 55%, #4338ca 100%)' }} title="AI Search"><BrainCircuit className="h-4 w-4 text-white" strokeWidth={2.25} /><span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-white dark:border-slate-900 animate-pulse" /></motion.button><NotificationBell /><motion.button onClick={() => setIsDark(!isDark)} className={`relative flex-shrink-0 w-8 sm:w-[54px] h-8 sm:h-7 rounded-xl sm:rounded-full flex items-center justify-center sm:justify-start border transition-colors shadow-inner ${isDark ? 'bg-slate-800 hover:bg-slate-700/60 border-slate-600 text-slate-300' : 'bg-white hover:bg-slate-50 border-slate-300 text-slate-600'}`} whileTap={{ scale: 0.93 }} transition={springMed} aria-label="Toggle theme"><div className="sm:hidden flex items-center justify-center">{isDark ? <Moon className="h-4 w-4 text-amber-400" /> : <Sun className="h-4 w-4 text-amber-500" />}</div><div className="hidden sm:block"><Sun className="absolute left-1.5 h-3 w-3 text-amber-400" style={{ top: '50%', marginTop: -6 }} /><Moon className="absolute right-1.5 h-3 w-3 text-slate-400" style={{ top: '50%', marginTop: -6 }} /><motion.div className={`absolute w-5 h-5 rounded-full shadow flex items-center justify-center z-10 ${isDark ? 'bg-slate-200' : 'bg-white'}`} animate={{ x: isDark ? 28 : 3 }} transition={springSnap} style={{ top: '50%', marginTop: -10 }}><AnimatePresence mode="wait" initial={false}><motion.div key={isDark ? 'moon' : 'sun'} initial={{ rotate: -30, opacity: 0, scale: 0.7 }} animate={{ rotate: 0, opacity: 1, scale: 1 }} exit={{ rotate: 30, opacity: 0, scale: 0.7 }} transition={{ duration: 0.15 }}>{isDark ? <Moon className="h-3 w-3 text-slate-700" /> : <Sun className="h-3 w-3 text-amber-500" />}</motion.div></AnimatePresence></motion.div></div></motion.button>
      <div className="relative flex-shrink-0" data-user-menu><motion.button onClick={() => setUserMenuOpen(prev => !prev)} className={`flex items-center gap-1.5 sm:gap-2 pl-1.5 pr-2 sm:pr-3 py-1 sm:py-1.5 rounded-xl border transition-all ${isDark ? 'border-slate-600 hover:border-slate-500 hover:bg-slate-700/60 bg-slate-800/60' : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50'}`} whileHover={{ scale: 1.01 }} whileTap={{ scale: 0.98 }} aria-label="Open user menu"><div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full overflow-hidden flex-shrink-0 ring-2 ring-offset-2 transition-shadow" style={{ boxShadow: isDark ? '0 0 0 1px rgba(31,175,90,0.35), 0 2px 8px rgba(0,0,0,0.35)' : '0 0 0 1px rgba(13,59,102,0.15), 0 2px 8px rgba(13,59,102,0.12)', ['--tw-ring-color']: isDark ? '#1FAF5A' : '#0D3B66', ['--tw-ring-offset-color']: isDark ? '#0f172a' : '#ffffff' }}>{user?.profile_picture ? <img src={user.profile_picture} alt={user.full_name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-white font-bold text-xs" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>{user?.full_name?.[0]?.toUpperCase() || 'U'}</div>}</div><span className={`hidden md:block text-xs sm:text-sm font-semibold max-w-[100px] truncate ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>{user?.full_name?.split(' ')[0]}</span><motion.div animate={{ rotate: userMenuOpen ? 180 : 0 }} transition={springSoft}><ChevronDown className="h-3.5 w-3.5 text-slate-400" /></motion.div></motion.button><AnimatePresence>{userMenuOpen && <motion.div initial={{ opacity: 0, y: -8, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.96 }} transition={springSoft} className="absolute right-0 mt-2 z-[200] overflow-hidden" style={{ width: 'min(240px, calc(100vw - 2rem))', background: isDark ? '#1e293b' : '#ffffff', borderRadius: '16px', boxShadow: isDark ? '0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(51,65,85,0.8)' : '0 8px 32px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.06)' }}><div className="px-4 py-3.5" style={{ borderBottom: isDark ? '1px solid #334155' : '1px solid #f1f5f9' }}><div className="flex items-center gap-3 min-w-0"><div className="w-11 h-11 rounded-xl overflow-hidden flex-shrink-0 ring-2 ring-slate-100 dark:ring-slate-700">{user?.profile_picture ? <img src={user.profile_picture} alt={user.full_name} className="w-full h-full object-cover" /> : <div className="w-full h-full flex items-center justify-center text-white font-bold text-sm" style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>{user?.full_name?.[0]?.toUpperCase() || 'U'}</div>}</div><div className="min-w-0 flex-1"><p className={`font-semibold text-sm truncate ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>{user?.full_name}</p><p className="text-xs truncate mt-0.5 text-slate-400">{user?.email}</p></div></div></div><div className="p-1.5"><motion.button onClick={() => { setUserMenuOpen(false); navigate('/settings'); }} whileHover={{ x: 2 }} transition={springSnap} className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-colors mb-0.5 ${isDark ? 'text-slate-300 hover:bg-slate-700' : 'text-slate-600 hover:bg-slate-50'}`}><Settings className="h-4 w-4 flex-shrink-0" /> Settings</motion.button><motion.button onClick={handleLogout} whileHover={{ x: 2 }} transition={springSnap} className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors ${isDark ? 'text-red-400 hover:bg-red-900/30' : 'text-red-600 hover:bg-red-50'}`}><LogOut className="h-4 w-4 flex-shrink-0" /> Sign out</motion.button></div></motion.div>}</AnimatePresence></div></div></div>
    </header>
    <div id="top-module-switcher-bar" className="fixed left-0 right-0 z-[44] flex items-center px-3 sm:px-6 overflow-x-auto slim-scroll" style={{ top: HEADER_H, height: SECTION_BAR_H, background: isDark ? '#0f172a' : '#ffffff', borderBottom: isDark ? '1px solid #1e293b' : '1px solid #e2e8f0' }}>
      <div className="flex items-center h-full gap-0.5 sm:gap-1">{renderSectionTabs(LEFT_SECTIONS)}</div><div className="flex-1 min-w-[12px]" />{RIGHT_SECTIONS.length > 0 && <div className="flex items-center h-full gap-0.5 sm:gap-1 flex-shrink-0">{renderSectionTabs(RIGHT_SECTIONS)}</div>}
    </div>
    <div className="transition-all duration-300 ease-in-out" style={{ marginLeft: offsetPx, paddingTop: TOTAL_HEADER_H, minWidth: 0, maxWidth: '100%', overflowX: 'hidden' }}><main ref={mainRef} style={{ padding: 'clamp(0.875rem, 2vw, 1.75rem)', position: 'relative', height: `calc(100vh - ${TOTAL_HEADER_H}px)`, overflowY: 'auto', overflowX: 'hidden', WebkitOverflowScrolling: 'touch' }}><div className="mx-auto w-full min-w-0" style={{ maxWidth: 'var(--content-max, 1400px)' }}><div className="w-full min-w-0">{children}</div></div></main></div>
    <EnterpriseSearchModal isOpen={searchOpen} onClose={() => setSearchOpen(false)} isDark={isDark} /><AICopilotDrawer isOpen={copilotOpen} onClose={() => setCopilotOpen(false)} isDark={isDark} />
  </div>;
};

function EnterpriseSearchModal({ isOpen, onClose, isDark }) {
  const [query, setQuery] = useState(''); const [category, setCategory] = useState('all'); const [data, setData] = useState(null); const [loading, setLoading] = useState(false); const [searched, setSearched] = useState(false); const [openClientId, setOpenClientId] = useState(null); const [profile, setProfile] = useState(null); const [profileLoading, setProfileLoading] = useState(false);
  const CATEGORIES = [{ key: 'all', label: 'All' }, { key: 'clients', label: 'Companies & People' }, { key: 'tasks', label: 'Tasks' }, { key: 'compliance', label: 'Compliance' }, { key: 'documents', label: 'Documents' }, { key: 'ledger', label: 'Ledger' }];
  const runSearch = async (e, catOverride) => { if (e) e.preventDefault(); const q = query.trim(); if (!q) return; setLoading(true); setOpenClientId(null); setProfile(null); try { const { data: res } = await api.get('/v2/search', { params: { query: q, category: catOverride || category } }); setData(res || null); setSearched(true); } catch { toast.error('Failed to execute search query'); setData(null); } finally { setLoading(false); } };
  const openClient = async (clientId) => { if (!clientId) return; if (openClientId === clientId) { setOpenClientId(null); setProfile(null); return; } setOpenClientId(clientId); setProfile(null); setProfileLoading(true); try { const { data: res } = await api.get(`/v2/search/client/${clientId}`); setProfile(res); } catch { toast.error("Could not load this client's details"); setOpenClientId(null); } finally { setProfileLoading(false); } };
  const goTo = (path, params) => { if (!path) return; const qs = params ? `?${new URLSearchParams(params).toString()}` : ''; onClose(); navigate(`${path}${qs}`); };
  useEffect(() => { if (isOpen) { setQuery(''); setData(null); setSearched(false); setOpenClientId(null); setProfile(null); } }, [isOpen]);
  if (!isOpen) return null;
  const groups = data ? [{ key: 'clients', label: 'Companies', icon: Building2, rows: data.clients || [] }, { key: 'individuals', label: 'Directors & Individuals', icon: Users, rows: data.individuals || [] }, { key: 'tasks', label: 'Tasks', icon: CheckSquare, rows: data.tasks || [] }, { key: 'compliance', label: 'Compliance', icon: ShieldCheck, rows: data.compliance || [] }, { key: 'documents', label: 'Documents', icon: FileText, rows: data.documents || [] }, { key: 'ledger_entries', label: 'Ledger Entries', icon: Receipt, rows: data.ledger_entries || [] }].filter(g => g.rows.length > 0) : [];
  const total = data?.total ?? 0; const card = isDark ? 'bg-slate-950/60 border-slate-800' : 'bg-white border-slate-200'; const sub = isDark ? 'text-slate-400' : 'text-slate-500'; const strong = isDark ? 'text-slate-100' : 'text-slate-800';
  return <div className="fixed inset-0 z-[300] flex items-start justify-center pt-[6%] px-4"><div className="absolute inset-0 bg-emerald-900/60 backdrop-blur-sm" onClick={onClose} /><div className={`relative w-full max-w-3xl rounded-2xl border p-5 shadow-2xl ${isDark ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-800'}`}><div className="flex items-center justify-between mb-4 pb-2 border-b" style={{ borderColor: isDark ? '#334155' : '#f1f5f9' }}><div className="flex items-center gap-2"><Search className="h-5 w-5 text-blue-500" /><h3 className={`font-bold text-sm ${strong}`}>Universal Search</h3>{searched && !loading && <span className={`text-[11px] font-semibold ${sub}`}>{total} record{total === 1 ? '' : 's'}</span>}</div><button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4 text-slate-400" /></button></div><form onSubmit={(e) => runSearch(e)} className="flex gap-2 mb-3"><input autoFocus type="text" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a company, director, individual, task, compliance, document…" className={`flex-1 h-11 px-3 text-sm rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-500 ${isDark ? 'bg-slate-950 border-slate-700 text-slate-100' : 'bg-slate-50 border-slate-200 text-slate-800'}`} /><Button type="submit" disabled={loading} className="h-11 px-5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs cursor-pointer">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}</Button></form><div className="flex flex-wrap gap-1 mb-4 p-1 rounded-xl bg-slate-100 dark:bg-slate-950 w-fit">{CATEGORIES.map(cat => <button key={cat.key} type="button" onClick={() => { setCategory(cat.key); if (query.trim()) runSearch(null, cat.key); }} className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${category === cat.key ? 'bg-blue-600 text-white shadow-sm' : isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}>{cat.label}</button>)}</div><div className="max-h-[55vh] overflow-y-auto slim-scroll space-y-4 pr-1">{loading ? <div className="flex flex-col items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-blue-500 mb-2" /><p className={`text-xs font-semibold ${sub}`}>Searching clients, people, tasks, compliance & documents…</p></div> : groups.length > 0 ? groups.map(g => { const Icon = g.icon; return <div key={g.key} className="space-y-2"><div className="flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-blue-500" /><p className={`text-[11px] font-bold uppercase tracking-wide ${sub}`}>{g.label} · {g.rows.length}</p></div>{g.rows.map((r,i)=>{ const isClientRow=g.key==='clients'; const clientId=isClientRow?r.id:r.client_id; const expanded=isClientRow&&openClientId===r.id; return <div key={r.id||i} className={`rounded-xl border overflow-hidden ${card}`}><button type="button" onClick={()=>{if(isClientRow)return openClient(r.id);if(clientId)return openClient(clientId);return goTo(r.link,{q:r.title||query.trim()});}} className="w-full text-left p-3 flex items-start justify-between gap-3 hover:bg-blue-500/5 transition-colors cursor-pointer"><div className="min-w-0"><p className={`text-sm font-bold truncate ${strong}`}>{r.title}</p><p className={`text-[11px] mt-0.5 truncate ${sub}`}>{[r.subtitle,r.company_name&&r.company_name!==r.subtitle?r.company_name:null,r.din?`DIN ${r.din}`:null,r.gstin?`GSTIN ${r.gstin}`:null,r.pan?`PAN ${r.pan}`:null].filter(Boolean).join(' · ')}</p><div className="flex flex-wrap items-center gap-1.5 mt-1.5">{r.assigned_to_name&&<span className="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/15 text-blue-500">Assigned: {r.assigned_to_name}</span>}{r.status&&<span className="px-2 py-0.5 rounded text-[10px] font-bold capitalize bg-slate-500/15 text-slate-500">{String(r.status).replace(/_/g,' ')}</span>}{r.due_date&&<span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600">Due {String(r.due_date).slice(0,10)}</span>}{isClientRow&&<><span className="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-600">{r.task_count||0} tasks ({r.open_task_count||0} open)</span><span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/15 text-indigo-500">{r.compliance_count||0} compliances ({r.pending_compliance_count||0} pending)</span></>}{r.amount!==undefined&&r.amount!==null&&<span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-blue-500/15 text-blue-500">₹{Number(r.amount).toLocaleString('en-IN')}</span>}</div></div><ChevronDown className={`h-4 w-4 shrink-0 mt-1 text-slate-400 transition-transform ${expanded?'rotate-180':''}`} /></button>{expanded&&<div className="border-t px-3 py-3 space-y-3" style={{borderColor:isDark?'#1e293b':'#f1f5f9'}}>{profileLoading?<div className="flex items-center gap-2 py-3"><Loader2 className="h-4 w-4 animate-spin text-blue-500" /><span className={`text-xs ${sub}`}>Loading full profile…</span></div>:profile?<><div className="grid grid-cols-2 md:grid-cols-3 gap-2">{[['Type',profile.client.client_type],['Assigned to',profile.client.assigned_to_name],['Status',profile.client.status],['Email',profile.client.email],['Phone',profile.client.phone],['GSTIN',profile.client.gstin],['PAN',profile.client.pan],['CIN / LLPIN',profile.client.cin],['City',[profile.client.city,profile.client.state].filter(Boolean).join(', ')]].filter(([,v])=>v).map(([k,v])=><div key={k}><p className={`text-[10px] uppercase font-bold ${sub}`}>{k}</p><p className={`text-xs font-semibold break-words ${strong}`}>{v}</p></div>)}</div>{profile.directors?.length>0&&<div><p className={`text-[10px] uppercase font-bold mb-1 ${sub}`}>Directors / Contact persons</p><div className="flex flex-wrap gap-1.5">{profile.directors.map((d,di)=><span key={di} className="px-2 py-1 rounded-lg text-[11px] font-semibold bg-slate-500/10">{d.name}{d.designation?` · ${d.designation}`:''}{d.din?` · DIN ${d.din}`:''}</span>)}</div></div>}<div><div className="flex items-center justify-between mb-1"><p className={`text-[10px] uppercase font-bold ${sub}`}>Compliances ({profile.stats.compliance_total}, {profile.stats.compliance_pending} pending)</p><button type="button" onClick={()=>goTo('/compliance',{q:profile.client.company_name})} className="text-[10px] font-bold text-blue-500 hover:underline cursor-pointer">Open compliance</button></div>{profile.compliances.length===0?<p className={`text-[11px] ${sub}`}>No compliance assigned.</p>:<div className="space-y-1">{profile.compliances.slice(0,8).map(c=><button key={c.id} type="button" onClick={()=>goTo('/compliance',{q:profile.client.company_name})} className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-blue-500/10 cursor-pointer"><span className={`text-[11px] font-semibold truncate ${strong}`}>{c.name}</span><span className="flex items-center gap-1.5 shrink-0">{c.due_date&&<span className={`text-[10px] ${sub}`}>{String(c.due_date).slice(0,10)}</span>}<span className="text-[10px] font-bold capitalize text-blue-500">{String(c.status||'').replace(/_/g,' ')}</span></span></button>)}</div>}</div><div><div className="flex items-center justify-between mb-1"><p className={`text-[10px] uppercase font-bold ${sub}`}>Tasks ({profile.stats.tasks_total}, {profile.stats.tasks_open} open)</p><button type="button" onClick={()=>goTo('/tasks',{q:profile.client.company_name})} className="text-[10px] font-bold text-blue-500 hover:underline cursor-pointer">Open tasks</button></div>{profile.tasks.length===0?<p className={`text-[11px] ${sub}`}>No tasks for this client.</p>:<div className="space-y-1">{profile.tasks.slice(0,8).map(t=><button key={t.id} type="button" onClick={()=>goTo('/tasks',{q:t.title})} className="w-full text-left flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-blue-500/10 cursor-pointer"><span className={`text-[11px] font-semibold truncate ${strong}`}>{t.title}</span><span className="flex items-center gap-1.5 shrink-0"><span className={`text-[10px] ${sub}`}>{t.assigned_to_name}</span><span className="text-[10px] font-bold capitalize text-emerald-600">{String(t.status||'').replace(/_/g,' ')}</span></span></button>)}</div>}</div><div className="flex flex-wrap gap-2 pt-1"><Button type="button" onClick={()=>goTo('/clients',{q:profile.client.company_name})} className="h-8 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-bold cursor-pointer">Open client record</Button><Button type="button" onClick={()=>goTo('/invoicing',{q:profile.client.company_name})} className="h-8 px-3 rounded-lg bg-slate-500/15 hover:bg-slate-500/25 text-[11px] font-bold cursor-pointer" style={{color:isDark?'#e2e8f0':'#0f172a'}}>Invoices ({profile.stats.invoices_total})</Button></div></>:null}</div>}</div>})}</div>; }) : searched ? <p className={`text-center py-8 text-xs ${sub}`}>No records found for “{query.trim()}”. Try a shorter part of the name, a GSTIN/PAN, or a DIN.</p> : <div className={`text-center py-8 text-xs space-y-1 ${sub}`}><p className="font-bold">Search anything across Taskosphere</p><p>· A company name — see who it's assigned to, its compliances and tasks</p><p>· A director or individual (name, DIN, phone, email)</p><p>· A task title, compliance filing, document or ledger narration</p></div>}</div></div></div>;
}

function AICopilotDrawer({ isOpen, onClose, isDark }) {
  const [messages, setMessages] = useState([{ role: 'assistant', content: "Hello! I'm AI Search. Ask me anything about your tasks, compliance, bank transactions, or accounts." }]);
  const [input, setInput] = useState(''); const [loading, setLoading] = useState(false); const scrollRef = useRef(null);
  const handleSend = async (e) => { e.preventDefault(); if (!input.trim() || loading) return; const userMsg = input.trim(); setInput(''); setMessages(prev => [...prev, { role: 'user', content: userMsg }]); setLoading(true); try { const { data } = await api.post('/v2/copilot/chat', { query: userMsg }); const replyText = data?.reply || data?.response || data?.message || (typeof data === 'string' ? data : null); setMessages(prev => [...prev, { role: 'assistant', content: replyText || `Taskosphere AI Search processed your request: "${userMsg}".` }]); } catch { setTimeout(() => setMessages(prev => [...prev, { role: 'assistant', content: `Sorry, I couldn't process "${userMsg}" right now. Please try again in a moment.` }]), 850); } finally { setLoading(false); } };
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  if (!isOpen) return null;
  return <div className="fixed inset-0 z-[250] flex justify-end"><div className="absolute inset-0 bg-emerald-900/40" onClick={onClose} /><div className={`relative w-full max-w-sm h-full flex flex-col border-l shadow-2xl ${isDark ? 'bg-slate-900 border-slate-800 text-white' : 'bg-white border-slate-200 text-slate-800'}`}><div className="p-4 border-b flex items-center justify-between" style={{ borderColor: isDark ? '#334155' : '#f1f5f9' }}><div className="flex items-center gap-2"><div className="p-1 rounded bg-blue-500/10 animate-pulse"><BrainCircuit className="h-5 w-5 text-blue-500" /></div><div><h3 className={`font-bold text-sm ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>AI Search</h3><p className="text-[10px] text-emerald-500 font-bold flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Workspace Active</p></div></div><button onClick={onClose} className="p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"><X className="h-4 w-4 text-slate-400" /></button></div><div className="flex-1 overflow-y-auto p-4 space-y-3 slim-scroll">{messages.map((m,i)=><div key={i} className={`flex flex-col max-w-[85%] ${m.role==='user'?'ml-auto items-end':'mr-auto items-start'}`}><div className={`p-3 rounded-2xl text-xs leading-relaxed ${m.role==='user'?'bg-blue-600 text-white rounded-tr-none shadow-md':isDark?'bg-slate-800 border border-slate-700 text-slate-200 rounded-tl-none':'bg-slate-100 text-slate-850 rounded-tl-none'}`}>{m.content}</div></div>)}{loading&&<div className="flex items-center gap-2 text-slate-400 text-[11px] font-bold py-1 px-1"><Loader2 className="h-3 w-3 animate-spin text-blue-500" /> AI Search processing...</div>}<div ref={scrollRef} /></div><div className="p-3 border-t flex flex-wrap gap-1.5 justify-center" style={{ borderColor: isDark ? '#334155' : '#f1f5f9' }}>{['Verify GST ITC','Find Unpaid Bills','Audit Bank Entries'].map(p=><button key={p} onClick={()=>setInput(p)} className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border transition hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${isDark?'border-slate-800 bg-slate-950 text-slate-400':'border-slate-200 bg-slate-50 text-slate-600'}`}>{p}</button>)}</div><form onSubmit={handleSend} className="p-3 border-t flex gap-2" style={{ borderColor: isDark ? '#334155' : '#f1f5f9' }}><input type="text" value={input} onChange={e=>setInput(e.target.value)} placeholder="Search or ask AI anything..." className={`flex-1 h-9 px-3 text-xs rounded-xl focus:outline-none border focus:ring-2 focus:ring-blue-500 ${isDark?'bg-slate-950 border-slate-800 text-slate-200':'bg-slate-50 border-slate-200 text-slate-800'}`} /><button type="submit" disabled={!input.trim()||loading} className="px-4 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl disabled:opacity-50 cursor-pointer h-9">Send</button></form></div></div>;
}

export default DashboardLayout;
