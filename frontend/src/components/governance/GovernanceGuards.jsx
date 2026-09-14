// Governance route/action guards. Commercial license entitlements are hard
// caps even when the authenticated tenant user has role=admin.

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useGovernance } from '@/hooks/useGovernance';
import { useAuth } from '@/contexts/AuthContext.jsx';
import { hasEffectivePermission, isPlatformOwner as matrixIsPlatformOwner } from '@/lib/commercialPermissionMatrix';

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
  // module fallback.
  if (module === 'admin' && isAdmin) return children;

  if (isCommercialAdmin) {
    // The central commercial matrix is the license ceiling. The backend has
    // already hydrated the admin permissions from selected_features, so this
    // check stays identical on login and hard refresh.
    const moduleFlag = MODULE_FLAGS[module];
    if (!moduleFlag || !hasEffectivePermission(user, moduleFlag)) return <EntitledHome />;
    if (!page || !hasEffectivePermission(user, page)) return <EntitledHome />;
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
    // Actions are bounded by the selected page. Commercial license selection
    // does not create a second action-grant system; once a page is selected,
    // the existing application action permissions remain authoritative.
    const moduleFlag = MODULE_FLAGS[module];
    if (!moduleFlag || !hasPermission(moduleFlag) || !page || !hasPermission(page)) return fallback;
    return children;
  }

  if (!hasActionAccess(module, page, action)) return fallback;
  return children;
}
