import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext.jsx';

const MODULE_FLAGS = {
  taskosphere: 'can_access_taskosphere',
  finix: 'can_access_finix',
  compliance: 'can_access_compliance',
  records: 'can_access_records',
  proposals: 'can_access_proposals',
  peopleMatrix: 'can_access_people_matrix',
};

const MODULE_HOME = [
  ['can_access_taskosphere', '/dashboard'],
  ['can_access_finix', '/finix-dashboard'],
  ['can_access_compliance', '/compliance-dashboard'],
  ['can_access_records', '/records-dashboard'],
  ['can_access_proposals', '/client-proposals-dashboard'],
  ['can_access_people_matrix', '/people-matrix'],
];

// Commercial licenses select pages independently from the parent module.
// Keep this route-to-permission table in the existing route gate rather than
// introducing another permission system. Unmapped commercial routes fail
// closed, which is safer than allowing a newly-added page accidentally.
const ROUTE_PAGE_PREFIXES = {
  taskosphere: [
    ['can_view_dashboard', '/dashboard'],
    ['can_view_tasks', '/tasks'],
    ['can_view_todo_dashboard', '/todos'],
    ['can_view_attendance', '/attendance'],
    ['can_view_reminders', '/reminders'],
    ['can_view_action_center', '/action-center'],
    ['can_view_client_visits', '/visits'],
    ['can_view_ai_document_reader', '/ai-reader'],
    ['can_view_client_portal', '/client-portal-manager'],
  ],
  finix: [
    ['can_view_accounting_reports', '/finix-dashboard'],
    ['can_view_sale', '/invoicing'],
    ['can_view_sale', '/sales'],
    ['can_view_sale', '/invoices'],
    ['can_view_purchase', '/purchase'],
    ['can_view_purchase', '/purchase-invoices'],
    ['can_view_bank', '/bank-accounts'],
    ['can_view_chart_of_accounts', '/chart-of-accounts'],
    ['can_view_journal_entries', '/journal-entries'],
    ['can_post_journal_entries', '/zero-touch-entry'],
    ['can_match_bank', '/bank-reconciliation'],
  ],
  compliance: [
    ['can_view_compliance', '/compliance-dashboard'],
    ['can_view_compliance', '/compliance'],
    ['can_view_gst_reconciliation', '/gst-reconciliation'],
    ['can_view_trademark_sphere', '/trademark-sphere'],
    ['can_view_mis_report', '/mis-report'],
    ['can_view_salary_slips', '/salary-slips'],
    ['can_view_roc_sphere', '/roc-sphere'],
  ],
  records: [
    ['can_view_documents', '/records-dashboard'],
    ['can_view_all_dsc', '/dsc'],
    ['can_view_documents', '/documents'],
    ['can_view_all_clients', '/clients'],
    ['can_view_clients', '/client-approvals'],
    ['can_view_passwords', '/passwords'],
  ],
  proposals: [
    ['can_view_all_leads', '/client-proposals-dashboard'],
    ['can_view_all_leads', '/leads'],
    ['can_create_quotations', '/quotations'],
    ['can_view_client_discussion', '/client-discussion'],
  ],
  peopleMatrix: [
    ['can_view_user_page', '/people-matrix'],
    ['can_view_user_page', '/users'],
    ['can_view_leave', '/leave'],
    ['can_view_payroll', '/payroll'],
    ['can_view_hr', '/hr'],
    ['can_view_recruitment', '/recruitment'],
    ['can_view_performance', '/performance'],
  ],
};

function matchesPath(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function selectedPageForPath(module, pathname) {
  const entries = ROUTE_PAGE_PREFIXES[module] || [];
  return entries
    .filter(([, prefix]) => matchesPath(pathname, prefix))
    .sort((a, b) => b[1].length - a[1].length)[0]?.[0] || null;
}

function ModuleGate({ module, children }) {
  const { user, hasPermission, isPlatformOwner } = useAuth();
  const location = useLocation();
  const flag = MODULE_FLAGS[module];
  const granted = flag ? hasPermission(flag) : false;
  const isCommercialTenant = !isPlatformOwner
    && (!!user?.license_id || !!user?.commercial_customer_id);

  // User administration is a tenant-control-plane capability. A commercial
  // licensee administrator must always be able to manage the users connected
  // to the license, even when People Matrix itself was not purchased.
  const isLicensedAdminUserDirectory = location.pathname === '/users'
    && isCommercialTenant
    && String(user?.role || '').toLowerCase() === 'admin';

  if (!granted && !isLicensedAdminUserDirectory) {
    const fallback = MODULE_HOME.find(([permission]) => hasPermission(permission))?.[1] || '/login';
    return <Navigate to={fallback} replace />;
  }

  if (isCommercialTenant && !isLicensedAdminUserDirectory) {
    const pageFlag = selectedPageForPath(module, location.pathname);
    // A commercial module purchase is deliberately not sufficient for route
    // access. Every known page must have its own selected feature permission.
    // If a route is not mapped yet, fail closed until its page entitlement is
    // explicitly wired.
    if (!pageFlag || !hasPermission(pageFlag)) {
      const fallback = MODULE_HOME.find(([permission]) => hasPermission(permission))?.[1] || '/login';
      return <Navigate to={fallback} replace />;
    }
  }

  return children;
}

export default ModuleGate;
