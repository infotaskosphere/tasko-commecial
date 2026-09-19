/**
 * Commercial permission matrix — single frontend authority for module/page visibility.
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

export const PAGE_MATRIX = Object.freeze([
  ["taskosphere", "can_view_dashboard", "/dashboard"], ["taskosphere", "can_view_tasks", "/tasks"], ["taskosphere", "can_view_todo_dashboard", "/todos"], ["taskosphere", "can_view_attendance", "/attendance"], ["taskosphere", "can_view_reminders", "/reminders"], ["taskosphere", "can_view_action_center", "/action-center"], ["taskosphere", "can_view_client_visits", "/visits"], ["taskosphere", "can_view_ai_document_reader", "/ai-reader"], ["taskosphere", "can_view_client_portal", "/client-portal-manager"], ["taskosphere", "can_reset_client_passwords", "/client-portal-manager/password"], ["taskosphere", "can_reset_client_passwords", "/client-portal-manager/reset"],
  ["finix", "can_view_accounting_reports", "/finix-dashboard"], ["finix", null, "/accounting-reports"], ["finix", null, "/zero-touch-entry"], ["finix", null, "/gst-portal-sync"], ["finix", null, "/accounting-integrity"], ["finix", null, "/day-book"], ["finix", null, "/cash-bank-book"], ["finix", null, "/cash-flow"], ["finix", null, "/outstanding-report"], ["finix", null, "/bank-reconciliation"], ["finix", null, "/depreciation"], ["finix", null, "/tds-tcs"], ["finix", null, "/financial-ratios"], ["finix", null, "/comparative-report"], ["finix", null, "/yearly-report"], ["finix", null, "/opening-balances"], ["finix", null, "/accounting-audit-trail"], ["finix", null, "/bulk-import"], ["finix", null, "/due-dates"], ["finix", null, "/import-invoices"], ["finix", "can_view_sale", "/invoicing"], ["finix", "can_view_purchase", "/purchase"], ["finix", "can_view_bank", "/bank-accounts"], ["finix", "can_view_chart_of_accounts", "/chart-of-accounts"], ["finix", "can_manage_chart_of_accounts", "/chart-of-accounts/manage"], ["finix", "can_view_journal_entries", "/journal-entries"], ["finix", "can_post_journal_entries", "/journal-entries/post"], ["finix", "can_match_bank", "/bank-reconciliation"],
  ["compliance", "can_view_compliance", "/compliance-dashboard"], ["compliance", "can_view_compliance", "/compliance"], ["compliance", "can_manage_compliance", "/compliance/manage"], ["compliance", "can_view_gst_reconciliation", "/gst-reconciliation"], ["compliance", "can_view_trademark_sphere", "/trademark-sphere"], ["compliance", "can_view_mis_report", "/mis-report"], ["compliance", "can_manage_mis_report", "/mis-report/manage"], ["compliance", "can_view_salary_slips", "/salary-slips"], ["compliance", "can_manage_salary_slips", "/salary-slips/manage"], ["compliance", "can_view_roc_sphere", "/roc-sphere"], ["compliance", "can_manage_roc_sphere", "/roc-sphere/manage"],
  ["records", "can_view_documents", "/records-dashboard"], ["records", "can_view_all_dsc", "/dsc"], ["records", "can_view_documents", "/documents"], ["records", "can_view_passwords", "/passwords"], ["records", "can_edit_passwords", "/passwords/manage"], ["records", "can_view_all_clients", "/clients"], ["records", "can_edit_clients", "/clients/manage"], ["records", "can_approve_clients", "/clients/approve"], ["records", "can_approve_whatsapp_wishes", "/automation/whatsapp"], ["records", "can_approve_email_wishes", "/automation/email"],
  ["proposals", "can_view_all_leads", "/client-proposals-dashboard"], ["proposals", "can_view_all_leads", "/leads"], ["proposals", "can_create_quotations", "/quotations"], ["proposals", "can_view_client_discussion", "/client-discussion"], ["proposals", "can_manage_client_discussion", "/client-discussion/manage"],
  ["people_matrix", "can_view_user_page", "/people-matrix"], ["people_matrix", "can_view_user_page", "/users"], ["people_matrix", "can_view_leave", "/leave"], ["people_matrix", "can_manage_leave", "/leave/manage"], ["people_matrix", "can_view_payroll", "/payroll"], ["people_matrix", "can_manage_payroll", "/payroll/manage"], ["people_matrix", "can_view_hr", "/hr"], ["people_matrix", "can_manage_hr", "/hr/manage"], ["people_matrix", "can_view_recruitment", "/recruitment"], ["people_matrix", "can_manage_recruitment", "/recruitment/manage"], ["people_matrix", "can_view_performance", "/performance"], ["people_matrix", "can_manage_performance", "/performance/manage"],
]);

const normalize = (value) => String(value || "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");

export function isPlatformOwner(user) { if (!user) return false; const email = String(user.email || "").trim().toLowerCase(); const id = String(user.id || "").trim(); return email === PLATFORM_OWNER_EMAIL || id === "usr-admin-01" || id === "saas-bootstrap-admin"; }

export function normalizeModules(user) {
  const sources = [user?.licensed_modules, user?.modules, user?.company?.licensed_modules, user?.company?.modules, user?.license?.modules, user?.subscription?.modules];
  const raw = sources.find((value) => Array.isArray(value) && value.length > 0) || []; const result = new Set();
  for (const value of raw) { const key = normalize(value); for (const [moduleId, def] of Object.entries(MODULES)) if (def.aliases.includes(key) || key === moduleId) result.add(moduleId); }
  return result;
}

const DASHBOARD_FLAG_BY_MODULE = Object.freeze({ taskosphere: "can_view_dashboard", finix: "can_view_accounting_reports", compliance: "can_view_compliance", records: "can_view_documents", proposals: "can_view_all_leads", people_matrix: "can_view_user_page" });
const ALL_PAGE_FLAGS_BY_MODULE = Object.freeze({
  taskosphere: ["can_view_dashboard", "can_view_tasks", "can_view_todo_dashboard", "can_view_attendance", "can_view_reminders", "can_view_action_center", "can_view_client_visits", "can_view_ai_document_reader", "can_view_client_portal", "can_reset_client_passwords"],
  finix: ["can_view_accounting_reports", "can_view_sale", "can_view_purchase", "can_view_bank", "can_view_chart_of_accounts", "can_manage_chart_of_accounts", "can_view_journal_entries", "can_post_journal_entries", "can_match_bank"],
  compliance: ["can_view_compliance", "can_manage_compliance", "can_view_gst_reconciliation", "can_view_trademark_sphere", "can_view_mis_report", "can_manage_mis_report", "can_view_salary_slips", "can_manage_salary_slips", "can_view_roc_sphere", "can_manage_roc_sphere"],
  records: ["can_view_documents", "can_view_all_dsc", "can_view_passwords", "can_edit_passwords", "can_view_all_clients", "can_edit_clients", "can_approve_clients", "can_approve_whatsapp_wishes", "can_approve_email_wishes"],
  proposals: ["can_view_all_leads", "can_create_quotations", "can_view_client_discussion", "can_manage_client_discussion"],
  people_matrix: ["can_view_user_page", "can_view_leave", "can_manage_leave", "can_view_payroll", "can_manage_payroll", "can_view_hr", "can_manage_hr", "can_view_recruitment", "can_manage_recruitment", "can_view_performance", "can_manage_performance"],
});

export function normalizedSelectedFeatures(user) {
  const raw = user?.selected_features || user?.company?.selected_features || user?.license?.selected_features; if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result = {};
  for (const [moduleKey, flags] of Object.entries(raw)) {
    const normalizedModule = normalize(moduleKey);
    const moduleId = Object.entries(MODULES).find(([id, def]) => id === normalizedModule || def.aliases.includes(normalizedModule))?.[0] || normalizedModule;
    const list = Array.isArray(flags) ? flags.map((flag) => normalize(flag)) : [];
    const hasAll = list.some((flag) => ["all", "*", "all_features", "full", "complete"].includes(flag));
    const effectiveFlags = new Set(hasAll ? (ALL_PAGE_FLAGS_BY_MODULE[moduleId] || []) : list.map((flag) => String(flag).trim()));
    // Dashboard/report landing access is a derived entitlement. Existing
    // licenses can contain selected pages without the persisted derived flag.
    const dashboardFlag = DASHBOARD_FLAG_BY_MODULE[moduleId];
    if (dashboardFlag && effectiveFlags.size > 0) effectiveFlags.add(dashboardFlag);
    result[moduleId] = effectiveFlags;
  }
  return result;
}

export function isCommercialTenant(user) { return Boolean(user) && !isPlatformOwner(user) && Boolean(user.company_id || user.license_id || user.commercial_customer_id || (Array.isArray(user.licensed_modules) && user.licensed_modules.length > 0) || user.company?.commercial_customer_id || user.company?.license_id); }

export function moduleForPath(pathname) { const path = String(pathname || "").split("?", 1)[0]; const match = PAGE_MATRIX.filter(([, , prefix]) => path === prefix || path.startsWith(`${prefix}/`)).sort((a, b) => b[2].length - a[2].length)[0]; return match?.[0] || null; }
export function pageFlagForPath(pathname) { const path = String(pathname || "").split("?", 1)[0]; const match = PAGE_MATRIX.filter(([, , prefix]) => path === prefix || path.startsWith(`${prefix}/`)).sort((a, b) => b[2].length - a[2].length)[0]; return match?.[1] || null; }

export function hasModuleAccess(user, moduleId) { if (!user) return false; if (isPlatformOwner(user)) return true; if (!MODULES[moduleId]) return false; const modules = normalizeModules(user); if (modules.has(moduleId)) return true; const selected = normalizedSelectedFeatures(user); return selected[moduleId]?.size > 0; }

export function hasPageLicense(user, pageFlag, moduleId = null) {
  if (!user || !pageFlag) return false;
  if (isPlatformOwner(user)) return true;
  const selected = normalizedSelectedFeatures(user);
  const module = moduleId || Object.entries(MODULES).find(([id]) => selected[id]?.has(pageFlag))?.[0];
  if (!module || !hasModuleAccess(user, module)) return false;
  if (DASHBOARD_FLAG_BY_MODULE[module] === pageFlag) {
    if (selected[module]?.has(pageFlag)) return true;
    if (!selected[module] && user.permissions?.[pageFlag] === true) return true;
    return false;
  }
  if (pageFlag === "can_view_client_discussion" && selected[module]?.has("can_view_all_leads")) return true;
  return Boolean(selected[module]?.has(pageFlag));
}

export function hasEffectivePermission(user, permission) {
  if (!user || !permission) return false; if (isPlatformOwner(user)) return true;
  if (!isCommercialTenant(user)) return typeof user.permissions?.[permission] === "boolean" ? user.permissions[permission] : String(user.role || "").toLowerCase() === "admin";
  const moduleEntry = Object.entries(MODULES).find(([, def]) => def.flag === permission); if (moduleEntry) return hasModuleAccess(user, moduleEntry[0]);
  const pageEntry = PAGE_MATRIX.find(([, flag]) => flag === permission);
  if (pageEntry) {
    const [moduleId] = pageEntry;
    if (!hasPageLicense(user, permission, moduleId)) return false;
    return user.permissions?.[permission] === true || (permission === "can_view_client_discussion" && user.permissions?.can_view_all_leads === true);
  }
  const legacyToPage = { can_manage_invoices: "can_view_sale", can_create_quotations: "can_create_quotations", can_view_clients: "can_view_all_clients" }; const page = legacyToPage[permission]; if (page) return hasEffectivePermission(user, page) && user.permissions?.[permission] !== false; return user.permissions?.[permission] === true;
}

export function canAccessPath(user, pathname) { if (!user) return false; if (isPlatformOwner(user)) return true; const moduleId = moduleForPath(pathname); if (!moduleId) return true; const flag = pageFlagForPath(pathname); if (!flag) return false; return hasEffectivePermission(user, flag); }
export function firstAccessiblePath(user, preferredModule = null) { if (!user) return "/login"; if (isPlatformOwner(user)) return "/dashboard"; const ordered = preferredModule ? [preferredModule, ...Object.keys(MODULES).filter((id) => id !== preferredModule)] : Object.keys(MODULES); for (const moduleId of ordered) { if (!hasModuleAccess(user, moduleId)) continue; const page = PAGE_MATRIX.find(([id, flag, path]) => id === moduleId && hasEffectivePermission(user, flag)); if (page) return page[2]; } return "/login"; }
