import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { useActivityTracker } from '@/hooks/useActivityTracker';
import { canAccessPath, isCommercialTenant } from '@/lib/commercialPermissionMatrix';
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
// Commercial licenses select pages independently. These mappings mirror the
// catalog's page flags so a licensed module never makes unrelated legacy
// screens visible merely because the parent module is enabled.
const COMMERCIAL_PAGE_FLAGS_BY_PATH = {
  '/dashboard': 'can_view_dashboard',
  '/tasks': 'can_view_tasks',
  '/todos': 'can_view_todo_dashboard',
  '/attendance': 'can_view_attendance',
  '/reminders': 'can_view_reminders',
  '/action-center': 'can_view_action_center',
  '/visits': 'can_view_client_visits',
  '/ai-reader': 'can_view_ai_document_reader',
  '/client-portal-manager': 'can_view_client_portal',
  '/compliance-dashboard': 'can_view_compliance',
  '/compliance': 'can_view_compliance',
  '/gst-reconciliation': 'can_view_gst_reconciliation',
  '/trademark-sphere': 'can_view_trademark_sphere',
  '/roc-sphere': 'can_view_roc_sphere',
  '/mis-report': 'can_view_mis_report',
  '/salary-slips': 'can_view_salary_slips',
  '/records-dashboard': 'can_view_documents',
  '/dsc': 'can_view_all_dsc',
  '/documents': 'can_view_documents',
  '/clients': 'can_view_all_clients',
  '/client-approvals': 'can_approve_clients',
  '/client-proposals-dashboard': 'can_view_all_leads',
  '/leads': 'can_view_all_leads',
  '/quotations': 'can_create_quotations',
  '/client-discussion': 'can_view_client_discussion',
  '/finix-dashboard': 'can_view_accounting_reports',
  '/invoicing': 'can_view_sale',
  '/purchase': 'can_view_purchase',
  '/bank-accounts': 'can_view_bank',
  '/journal-entries': 'can_view_journal_entries',
  '/chart-of-accounts': 'can_view_chart_of_accounts',
  '/people-matrix': 'can_view_user_page',
  '/users': 'can_view_user_page',
  '/leave': 'can_view_leave',
  '/payroll': 'can_view_payroll',
  '/hr': 'can_view_hr',
  '/recruitment': 'can_view_recruitment',
};

const COMMERCIAL_UNLICENSED_LEGACY_FINIX_PATHS = new Set([
  '/accounting-reports', '/day-book', '/gst-portal-sync', '/accounting-integrity',
  '/zero-touch-entry', '/cash-bank-book', '/cash-flow', '/outstanding-report',
  '/bank-reconciliation', '/depreciation', '/tds-tcs', '/financial-ratios',
  '/comparative-report', '/yearly-report', '/opening-balances',
  '/accounting-audit-trail', '/bulk-import', '/due-dates', '/import-invoices',
]);
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