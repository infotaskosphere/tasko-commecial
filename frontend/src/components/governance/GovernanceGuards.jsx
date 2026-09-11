// Governance route/action guards. Commercial license entitlements are hard
// caps even when the authenticated tenant user has role=admin.

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useGovernance } from '@/hooks/useGovernance';
import { useAuth } from '@/contexts/AuthContext.jsx';

const MODULE_FALLBACKS = {
  taskosphere: ['can_access_taskosphere', '/dashboard'],
  finix: ['can_access_finix', '/finix-dashboard'],
  compliance: ['can_access_compliance', '/compliance-dashboard'],
  records: ['can_access_records', '/records-dashboard'],
  proposals: ['can_access_proposals', '/client-proposals-dashboard'],
  people_matrix: ['can_access_people_matrix', '/people-matrix'],
};

const MODULE_FLAGS = Object.fromEntries(Object.entries(MODULE_FALLBACKS).map(([key, [flag]]) => [key, flag]));
const MANAGE_ACTIONS = new Set(['create', 'edit', 'delete', 'approve', 'print', 'share']);

function EntitledHome() {
  const { hasPermission } = useAuth();
  const fallback = Object.values(MODULE_FALLBACKS).find(([permission]) => hasPermission(permission))?.[1] || '/login';
  return <Navigate to={fallback} replace />;
}

export function PageGuard({ module, page, children }) {
  const { user, hasPermission, isPlatformOwner } = useAuth();
  const { hasPageAccess } = useGovernance();
  const isAdmin = String(user?.role || '').toLowerCase() === 'admin';
  const isCommercialAdmin = isAdmin && !!user?.company_id && !isPlatformOwner;

  // Admin is the application control-plane area, not one of the six
  // commercially licensed operational modules. Admin-only routes are already
  // role-gated by AppRoutes and must not be redirected through an operational
  // module fallback. This keeps Master Data/Roles reachable for a licensee
  // admin without granting the admin access to unlicensed business modules.
  if (module === 'admin' && isAdmin) return children;

  if (isCommercialAdmin) {
    const moduleFlag = MODULE_FLAGS[module];
    if (!moduleFlag || !hasPermission(moduleFlag) || !hasPermission(page)) return <EntitledHome />;
    return children;
  }

  if (!hasPageAccess(module, page)) return <EntitledHome />;
  return children;
}

export function ActionGuard({ module, page, action, fallback = null, children }) {
  const { user, hasPermission, isPlatformOwner } = useAuth();
  const { hasActionAccess } = useGovernance();
  const isCommercialAdmin = String(user?.role || '').toLowerCase() === 'admin' && !!user?.company_id && !isPlatformOwner;

  if (isCommercialAdmin) {
    const moduleFlag = MODULE_FLAGS[module];
    if (!moduleFlag || !hasPermission(moduleFlag) || !hasPermission(page)) return fallback;
    if (MANAGE_ACTIONS.has(action)) {
      const manageFlag = page.startsWith('can_view_') ? page.replace('can_view_', 'can_manage_') : null;
      if (manageFlag && user?.permissions && Object.prototype.hasOwnProperty.call(user.permissions, manageFlag)) {
        return user.permissions[manageFlag] === true ? children : fallback;
      }
    }
    return children;
  }

  if (!hasActionAccess(module, page, action)) return fallback;
  return children;
}
