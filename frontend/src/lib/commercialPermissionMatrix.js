/**
 * Commercial permission matrix — single frontend authority for module/page visibility.
 *
 * The commercial console stores two independent layers:
 *   1) modules: which product modules are licensed;
 *   2) selected_features: which pages inside those modules are licensed.
 *
 * User permissions are a second ceiling for non-admin licensee users. A
 * licensee admin receives permissions derived from the same selected_features
 * on the backend. Platform owners bypass commercial licensing entirely.
 */

export const PLATFORM_OWNER_EMAIL = "info.taskosphere@gmail.com";

export const MODULES = Object.freeze({
  taskosphere: { flag: "can_access_taskosphere", aliases: ["taskosphere", "tasks"], landing: "/dashboard" },
  finix: { flag: "can_access_finix", aliases: ["finix", "invoicing", "accounting"], landing: "/finix-dashboard" },
  compliance: { flag: "can_access_compliance", aliases: ["compliance"], landing: "/compliance-dashboard" },
  records: { flag: "can_access_records", aliases: ["records"], landing: "/records-dashboard" },
  proposals: { flag: "can_access_proposals", aliases: ["proposals", "client_proposals"], landing: "/client-proposals-dashboard" },
  people_matrix: { flag: "can_access_people_matrix", aliases: ["people_matrix", "hrms", "peoplematrix"], landing: "/people-matrix" },
});

// This table is deliberately path-based. It is the bridge between the
// DashboardLayout/AppRoutes URLs and the exact feature flags stored by the
// Commercial Console. Prefix matching is longest-match-first.
export const PAGE_MATRIX = Object.freeze([
  // Taskosphere
  ["taskosphere", "can_view_dashboard", "/dashboard"],
  ["taskosphere", "can_view_tasks", "/tasks"],
  ["taskosphere", "can_view_todo_dashboard", "/todos"],
  ["taskosphere", "can_view_attendance", "/attendance"],
  ["taskosphere", "can_view_reminders", "/reminders"],
  ["taskosphere", "can_view_action_center", "/action-center"],
  ["taskosphere", "can_view_client_visits", "/visits"],
  ["taskosphere", "can_view_ai_document_reader", "/ai-reader"],
  ["taskosphere", "can_view_client_portal", "/client-portal-manager"],
  ["taskosphere", "can_reset_client_passwords", "/client-portal-manager/password"],
  ["taskosphere", "can_reset_client_passwords", "/client-portal-manager/reset"],

  // Finix
  ["finix", "can_view_accounting_reports", "/finix-dashboard"],
  ["finix", "can_view_sale", "/invoicing"],
  ["finix", "can_view_purchase", "/purchase"],
  ["finix", "can_view_bank", "/bank-accounts"],
  ["finix", "can_view_chart_of_accounts", "/chart-of-accounts"],
  ["finix", "can_manage_chart_of_accounts", "/chart-of-accounts/manage"],
  ["finix", "can_view_journal_entries", "/journal-entries"],
  ["finix", "can_post_journal_entries", "/zero-touch-entry"],
  ["finix", "can_match_bank", "/bank-reconciliation"],

  // Compliance
  ["compliance", "can_view_compliance", "/compliance-dashboard"],
  ["compliance", "can_view_compliance", "/compliance"],
  ["compliance", "can_view_gst_reconciliation", "/gst-reconciliation"],
  ["compliance", "can_view_trademark_sphere", "/trademark-sphere"],
  ["compliance", "can_view_mis_report", "/mis-report"],
  ["compliance", "can_view_salary_slips", "/salary-slips"],
  ["compliance", "can_view_roc_sphere", "/roc-sphere"],

  // Records
  ["records", "can_view_documents", "/records-dashboard"],
  ["records", "can_view_all_dsc", "/dsc"],
  ["records", "can_view_documents", "/documents"],
  ["records", "can_view_all_clients", "/clients"],
  ["records", "can_view_passwords", "/passwords"],
  ["records", "can_approve_clients", "/client-approvals"],
  ["records", "can_approve_whatsapp_wishes", "/automation/approvals"],

  // Client Proposals
  ["proposals", "can_view_all_leads", "/client-proposals-dashboard"],
  ["proposals", "can_view_all_leads", "/leads"],
  ["proposals", "can_create_quotations", "/quotations"],
  ["proposals", "can_view_client_discussion", "/client-discussion"],

  // People Matrix
  ["people_matrix", "can_view_user_page", "/people-matrix"],
  ["people_matrix", "can_view_user_page", "/users"],
  ["people_matrix", "can_view_leave", "/leave"],
  ["people_matrix", "can_view_payroll", "/payroll"],
  ["people_matrix", "can_view_hr", "/hr"],
  ["people_matrix", "can_view_recruitment", "/recruitment"],
  ["people_matrix", "can_view_performance", "/performance"],
]);

const normalize = (value) => String(value || "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");

export function isPlatformOwner(user) {
  if (!user) return false;
  const email = String(user.email || "").trim().toLowerCase();
  const id = String(user.id || "").trim();
  return email === PLATFORM_OWNER_EMAIL || id === "usr-admin-01" || id === "saas-bootstrap-admin";
}

export function normalizeModules(user) {
  const sources = [
    user?.licensed_modules,
    user?.company?.licensed_modules,
    user?.modules,
    user?.company?.modules,
    user?.license?.modules,
    user?.subscription?.modules,
  ];
  const raw = sources.find((value) => Array.isArray(value) && value.length > 0) || [];
  const result = new Set();
  for (const value of raw) {
    const key = normalize(value);
    for (const [moduleId, def] of Object.entries(MODULES)) {
      if (def.aliases.includes(key) || key === moduleId) result.add(moduleId);
    }
  }
  return result;
}

export function normalizedSelectedFeatures(user) {
  const raw = user?.selected_features || user?.company?.selected_features || user?.license?.selected_features;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [moduleKey, flags] of Object.entries(raw)) {
    const normalizedModule = normalize(moduleKey);
    const moduleId = Object.entries(MODULES).find(([id, def]) => id === normalizedModule || def.aliases.includes(normalizedModule))?.[0] || normalizedModule;
    result[moduleId] = Array.isArray(flags) ? new Set(flags.map((flag) => String(flag).trim())) : new Set();
  }
  return result;
}

export function isCommercialTenant(user) {
  return Boolean(user) && !isPlatformOwner(user) && Boolean(
    user.license_id || user.commercial_customer_id ||
    (Array.isArray(user.licensed_modules) && user.licensed_modules.length > 0) ||
    user.company?.commercial_customer_id || user.company?.license_id
  );
}

export function moduleForPath(pathname) {
  const path = String(pathname || "").split("?", 1)[0];
  const match = PAGE_MATRIX
    .filter(([, , prefix]) => path === prefix || path.startsWith(`${prefix}/`))
    .sort((a, b) => b[2].length - a[2].length)[0];
  return match?.[0] || null;
}

export function pageFlagForPath(pathname) {
  const path = String(pathname || "").split("?", 1)[0];
  const match = PAGE_MATRIX
    .filter(([, , prefix]) => path === prefix || path.startsWith(`${prefix}/`))
    .sort((a, b) => b[2].length - a[2].length)[0];
  return match?.[1] || null;
}

export function hasModuleAccess(user, moduleId) {
  if (!user) return false;
  if (isPlatformOwner(user)) return true;
  const def = MODULES[moduleId];
  if (!def) return false;
  const modules = normalizeModules(user);
  if (modules.has(moduleId)) return true;
  // A license document with selected pages is itself an authoritative module
  // signal when a legacy response omitted licensed_modules.
  const selected = normalizedSelectedFeatures(user);
  return selected[moduleId]?.size > 0;
}

export function hasPageLicense(user, pageFlag, moduleId = null) {
  if (!user || !pageFlag) return false;
  if (isPlatformOwner(user)) return true;
  const selected = normalizedSelectedFeatures(user);
  const module = moduleId || Object.entries(MODULES).find(([id]) => selected[id]?.has(pageFlag))?.[0];
  if (!module || !hasModuleAccess(user, module)) return false;
  // A commercial license must explicitly select the page. Do not fall back to
  // role=admin here: role is the tenant role, not the product license.
  return Boolean(selected[module]?.has(pageFlag));
}

export function hasEffectivePermission(user, permission) {
  if (!user || !permission) return false;
  if (isPlatformOwner(user)) return true;
  if (!isCommercialTenant(user)) {
    return typeof user.permissions?.[permission] === "boolean"
      ? user.permissions[permission]
      : String(user.role || "").toLowerCase() === "admin";
  }

  // Module permission flags are controlled by the license module selection.
  const moduleEntry = Object.entries(MODULES).find(([, def]) => def.flag === permission);
  if (moduleEntry) return hasModuleAccess(user, moduleEntry[0]);

  const pageEntry = PAGE_MATRIX.find(([, flag]) => flag === permission);
  if (pageEntry) {
    const [moduleId] = pageEntry;
    if (!hasPageLicense(user, permission, moduleId)) return false;
    // Licensee admins are hydrated from the license and may use every selected
    // page. Regular licensee users remain capped by their internal permissions.
    if (String(user.role || "").toLowerCase() === "admin") return true;
    return user.permissions?.[permission] === true;
  }

  // Legacy permission flags are only effective inside a commercial tenant when
  // the corresponding license page has been selected. This prevents old admin
  // defaults from reopening an unlicensed page.
  const legacyToPage = {
    can_manage_invoices: "can_view_sale",
    can_create_quotations: "can_create_quotations",
    can_view_clients: "can_view_all_clients",
  };
  const page = legacyToPage[permission];
  if (page) return hasEffectivePermission(user, page) && user.permissions?.[permission] !== false;

  return user.permissions?.[permission] === true;
}

export function canAccessPath(user, pathname) {
  if (!user) return false;
  if (isPlatformOwner(user)) return true;
  const moduleId = moduleForPath(pathname);
  if (!moduleId) return true;
  const flag = pageFlagForPath(pathname);
  if (!flag) return false;
  return hasEffectivePermission(user, flag);
}

export function firstAccessiblePath(user, preferredModule = null) {
  if (!user) return "/login";
  if (isPlatformOwner(user)) return "/dashboard";
  const ordered = preferredModule
    ? [preferredModule, ...Object.keys(MODULES).filter((id) => id !== preferredModule)]
    : Object.keys(MODULES);
  for (const moduleId of ordered) {
    if (!hasModuleAccess(user, moduleId)) continue;
    const page = PAGE_MATRIX.find(([id, flag, path]) => id === moduleId && hasEffectivePermission(user, flag));
    if (page) return page[2];
  }
  return "/login";
}
