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

function EntitledHome() {
  const { hasPermission } = useAuth();
  const fallback = Object.values(MODULE_FALLBACKS).find(([permission]) => hasPermission(permission))?.[1] || '/login';
  return <Navigate to={fallback} replace />;
}

export function PageGuard({ module, page, children }) {
  const { user, hasPermission, isPlatformOwner } = useAuth();
  const { hasPageAccess } = useGovernance();
  const isCommercialAdmin = String(user?.role || '').toLowerCase() === 'admin' && !!user?.company_id && !isPlatformOwner;

  // AuthContext is the live license-authoritative permission source. This
  // explicit branch prevents the generic admin bypass from reopening a page
  // that the customer's active license does not contain.
  if (isCommercialAdmin) {
    const moduleFlag = MODULE_FLAGS[module];
    if (!moduleFlag || !hasPermission(moduleFlag) || !hasPermission(page)) return <EntitledHome />;
    return children;
  }

  if (!hasPageAccess(module, page)) return <EntitledHome />;
  return children;
}

export function ActionGuard({ module, page, action, fallback = null, children }) {
  const { hasActionAccess } = useGovernance();
  if (!hasActionAccess(module, page, action)) return fallback;
  return children;
}
