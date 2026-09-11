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

function ModuleGate({ module, children }) {
  const { user, hasPermission, isPlatformOwner } = useAuth();
  const location = useLocation();
  const flag = MODULE_FLAGS[module];
  const granted = flag ? hasPermission(flag) : false;

  // User administration is a tenant-control-plane capability. A commercial
  // licensee administrator must always be able to manage the users connected
  // to his own license, even when the separately licensed People Matrix/HRMS
  // module was not purchased.
  const isLicensedAdminUserDirectory = location.pathname === '/users'
    && !isPlatformOwner
    && String(user?.role || '').toLowerCase() === 'admin'
    && !!user?.company_id;

  if (granted || isLicensedAdminUserDirectory) return children;

  const fallback = MODULE_HOME.find(([permission]) => hasPermission(permission))?.[1] || '/login';
  return <Navigate to={fallback} replace />;
}

export default ModuleGate;
