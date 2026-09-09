// companies.js — single shared helper for reading company MASTER DATA.
//
// Companies are created / edited in ONE place: Admin → Master Data
// (CompanyProfiles → /companies API in backend/quotations.py). Every other
// page (Quotations, Invoicing, Trademark Sphere, Bank Accounts, Reports,
// Attendance, Users, Journal Entries, Email/WhatsApp settings, GST sync…)
// only READS them.
//
// Use these helpers instead of calling api.get('/companies') directly so that:
//   * the response shape is always normalised to an ARRAY (some endpoints /
//     proxies wrap it as { companies: [...] } or { data: [...] } — mapping over
//     that object is what produced "companies.map is not a function"),
//   * a permission / network failure degrades to an empty list instead of
//     throwing and blanking the whole page,
//   * every page picks the right endpoint:
//       fetchCompanies()     → full records (address, GST, bank, logo, SMTP)
//       fetchCompanyList()   → same records for dropdowns / document headers
//
import api from "@/lib/api";

/** Always return an array of companies, whatever wrapper the API used. */
export function normalizeCompanies(payload) {
  const d = payload?.data !== undefined ? payload.data : payload;
  let list = [];
  if (Array.isArray(d)) list = d;
  else if (Array.isArray(d?.companies)) list = d.companies;
  else if (Array.isArray(d?.data)) list = d.data;
  else if (Array.isArray(d?.items)) list = d.items;
  else if (Array.isArray(d?.results)) list = d.results;

  // Platform Owner Company Master is for operational companies used to create
  // tasks, add employees, and issue invoices. Exclude commercial customer companies
  // created automatically during commercial license generation.
  return list.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    if (c.source === 'commercial-license' || c.source === 'license' || c.source === 'commercial') return false;
    if (c.commercial_customer_id) return false;
    return true;
  });
}

/** Full company master records (needs a logged-in user only). */
export async function fetchCompanies({ silent = true } = {}) {
  try {
    const res = await api.get("/companies");
    return normalizeCompanies(res);
  } catch (err) {
    // Older deployments of the backend exposed the same organization-wide
    // records through the dropdown endpoint but did not yet register the full
    // `/companies` route. Keep the Master Data page usable during a rolling
    // frontend/backend deploy, while the canonical endpoint remains preferred.
    if (err?.response?.status === 404) {
      try {
        const fallback = await api.get("/companies/list");
        return normalizeCompanies(fallback);
      } catch (_) {
        // Fall through to the existing silent/throw behavior below.
      }
    }
    if (!silent) throw err;
    // eslint-disable-next-line no-console
    console.warn("[companies] failed to load /companies:", err?.response?.status || err?.message);
    return [];
  }
}

/** Company list for dropdowns & document headers. */
export async function fetchCompanyList({ silent = true } = {}) {
  try {
    // Prefer the lightweight endpoint, but support older backend deployments
    // where only the canonical /companies route was registered.
    const res = await api.get("/companies/list");
    return normalizeCompanies(res);
  } catch (err) {
    if (err?.response?.status === 404) {
      try {
        const fallback = await api.get("/companies");
        return normalizeCompanies(fallback);
      } catch (_) {
        // Fall through to the existing silent/throw behavior below.
      }
    }
    if (!silent) throw err;
    // eslint-disable-next-line no-console
    console.warn("[companies] failed to load /companies/list:", err?.response?.status || err?.message);
    return [];
  }
}

/**
 * Match a record to a company selection.
 *
 * New invoices store company_id. Older imported invoices may only have a
 * company_name, so filtering by the master-record id must support both shapes.
 */
export function recordBelongsToCompany(record, companyId, companies = []) {
  if (!companyId || companyId === "all") return true;
  const selected = (Array.isArray(companies) ? companies : []).find(
    (company) => String(company?.id) === String(companyId),
  );
  if (String(record?.company_id || "") === String(companyId)) return true;
  if (!selected?.name) return false;

  const selectedName = String(selected.name).trim().toLowerCase();
  return [record?.company_name, record?.company, record?.firm_name]
    .filter(Boolean)
    .some((name) => String(name).trim().toLowerCase() === selectedName);
}

/** One company by id, resolved from the master list (no extra call needed). */
export function findCompany(companies, id) {
  if (!id) return null;
  return (Array.isArray(companies) ? companies : []).find((c) => c?.id === id) || null;
}

export default {
  fetchCompanies,
  fetchCompanyList,
  normalizeCompanies,
  recordBelongsToCompany,
  findCompany,
};
