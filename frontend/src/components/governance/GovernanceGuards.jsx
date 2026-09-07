// Governance route/action guards. Module entitlements are enforced before
// page permissions, including for commercial administrators.

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

function EntitledHome() {
  const { hasPermission } = useAuth();
  const fallback = Object.values(MODULE_FALLBACKS).find(([permission]) => hasPermission(permission))?.[1] || '/login';
  return <Navigate to={fallback} replace />;
}

export function PageGuard({ module, page, children }) {
  const { hasPageAccess } = useGovernance();
  if (!hasPageAccess(module, page)) return <EntitledHome />;
  return children;
}

export function ActionGuard({ module, page, action, fallback = null, children }) {
  const { hasActionAccess } = useGovernance();
  if (!hasActionAccess(module, page, action)) return fallback;
  return children;
}
