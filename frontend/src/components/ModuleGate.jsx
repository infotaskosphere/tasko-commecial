import React from 'react';
import { Navigate } from 'react-router-dom';
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

function ModuleGate({ module, children }) {
  const { hasPermission } = useAuth();
  const flag = MODULE_FLAGS[module];
  const granted = flag ? hasPermission(flag) : false;

  if (granted) return children;

  // Do not bounce a customer without Taskosphere back to /dashboard. Pick the
  // first licensed module instead so a module-limited license never loops.
  const fallback = MODULE_HOME.find(([permission]) => hasPermission(permission))?.[1] || '/login';
  return <Navigate to={fallback} replace />;
}

export default ModuleGate;
