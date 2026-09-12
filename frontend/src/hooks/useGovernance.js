// useGovernance.js — centralized frontend permission hooks.
// Mirrors backend/governance_core.py and adds the commercial license cap.

import { useAuth } from "@/contexts/AuthContext.jsx";

export const MODULE_FLAGS = {
  taskosphere: "can_access_taskosphere",
  finix: "can_access_finix",
  compliance: "can_access_compliance",
  records: "can_access_records",
  proposals: "can_access_proposals",
  people_matrix: "can_access_people_matrix",
  admin: null,
};

const VIEW_ONLY_ACTIONS = new Set(["view", "export"]);
const MANAGE_ACTIONS = new Set(["create", "edit", "delete", "approve", "print", "share"]);

export function useGovernance() {
  const { user, hasPermission } = useAuth();
  const isAdmin = user?.role?.toLowerCase() === "admin";
  const isCommercialAdmin = isAdmin && !!user?.company_id;
  const perms = user?.permissions || {};

  const hasModuleAccess = (moduleKey) => {
    if (moduleKey === "admin") return isAdmin;
    const flag = MODULE_FLAGS[moduleKey];
    if (!flag) return false;
    return hasPermission(flag);
  };

  const hasPageAccess = (moduleKey, pageFlag) => {
    if (!hasModuleAccess(moduleKey)) return false;
    if (isAdmin && !pageFlag) return true;
    if (hasPermission(pageFlag)) return true;
    return !!perms[pageFlag];
  };

  const hasActionAccess = (moduleKey, pageFlag, action) => {
    if (!hasPageAccess(moduleKey, pageFlag)) return false;
    if (isAdmin) return true;

    const matrixKey = `${moduleKey}.${pageFlag}`;
    const matrix = perms.governance_matrix || {};
    if (matrixKey in matrix) return matrix[matrixKey].includes(action);

    const manageFlag = pageFlag.startsWith("can_view_")
      ? pageFlag.replace("can_view_", "can_manage_")
      : null;

    if (VIEW_ONLY_ACTIONS.has(action)) return !!perms[pageFlag];
    if (MANAGE_ACTIONS.has(action)) {
      if (manageFlag && manageFlag in perms) return !!perms[manageFlag];
      return !!perms[pageFlag];
    }
    return false;
  };

  const getVisibilityScope = (resourceType) => {
    if (isAdmin) return { scope: "organization", selected: [] };
    const legacyFieldMap = {
      tasks: "view_other_tasks",
      attendance: "view_other_attendance",
      reports: "view_other_reports",
      todos: "view_other_todos",
      activity: "view_other_activity",
      visits: "view_other_visits",
      clients: "assigned_clients",
      passwords: "view_password_departments",
    };
    const legacyField = legacyFieldMap[resourceType];
    if (legacyField) {
      const selected = perms[legacyField] || [];
      return { scope: selected.length ? "selected_users" : "own", selected };
    }
    const vis = (perms.visibility_matrix || {})[resourceType];
    if (!vis) return { scope: "own", selected: [] };
    return { scope: vis.scope || "own", selected: vis.selected || [] };
  };

  const hasVisibilityAccess = (resourceType, { ownerId, department, role } = {}) => {
    if (isAdmin) return true;
    const { scope, selected } = getVisibilityScope(resourceType);
    if (scope === "organization") return true;
    if (scope === "own") return ownerId === user?.id;
    if (scope === "selected_users") return selected.includes(ownerId) || ownerId === user?.id;
    if (scope === "selected_departments") return selected.includes(department);
    if (scope === "selected_roles") return selected.includes(role);
    return ownerId === user?.id;
  };

  return { isAdmin, isCommercialAdmin, hasModuleAccess, hasPageAccess, hasActionAccess, getVisibilityScope, hasVisibilityAccess };
}
