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
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.companies)) return d.companies;
  if (Array.isArray(d?.data)) return d.data;
  if (Array.isArray(d?.items)) return d.items;
  if (Array.isArray(d?.results)) return d.results;
  return [];
}

/**
 * api.js turns a failed collection GET (404 / 502 / 503 / 504) on /companies and
 * /companies/list into a fake "200 OK, empty list" (res._degraded === true) after its
 * retries. A page cannot tell that from "the Master really has no companies", so these
 * helpers treat a degraded answer as a failure and try the other endpoint.
 */
const isDegraded = (res) => Boolean(res && res._degraded);

/** Full company master records (needs a logged-in user only). */
export async function fetchCompanies({ silent = true } = {}) {
  let lastErr = null;
  // The canonical route first; older backends only expose the dropdown route.
  for (const url of ["/companies", "/companies/list"]) {
    try {
      const res = await api.get(url);
      if (isDegraded(res)) { lastErr = new Error(`${url} unavailable`); continue; }
      const list = normalizeCompanies(res);
      if (list.length) return list;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && !silent) throw lastErr;
  if (lastErr) {
    // eslint-disable-next-line no-console
    console.warn("[companies] failed to load /companies:", lastErr?.response?.status || lastErr?.message);
  }
  return [];
}

/** Company list for dropdowns & document headers. */
export async function fetchCompanyList({ silent = true } = {}) {
  let lastErr = null;
  for (const url of ["/companies/list", "/companies"]) {
    try {
      const res = await api.get(url);
      if (isDegraded(res)) { lastErr = new Error(`${url} unavailable`); continue; }
      const list = normalizeCompanies(res);
      if (list.length) return list;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr && !silent) throw lastErr;
  if (lastErr) {
    // eslint-disable-next-line no-console
    console.warn("[companies] could not load the company master:", lastErr?.response?.status || lastErr?.message);
  }
  return [];
}

/**
 * Purchase page: companies (Master Data) + clients in one light call, falling back to the
 * generic company endpoints. Resolves { companies, clients, error, source, diagnostics } and
 * NEVER throws, so the page can tell "failed to load" apart from "master is empty".
 */
export async function fetchPurchaseMasters() {
  let error = null;
  try {
    const res = await api.get("/purchase-invoices/masters", { _silent: true });
    const d = res?.data || {};
    const companies = Array.isArray(d.companies) ? d.companies : [];
    const clients = Array.isArray(d.clients) ? d.clients : [];
    if (companies.length) return { companies, clients, error: null, source: "purchase-masters", diagnostics: d.diagnostics || null };
    // Server answered but found nothing — still try the generic endpoints before saying "empty".
    const fallback = await fetchCompanyList({ silent: true });
    return {
      companies: fallback, clients, error: null,
      source: fallback.length ? "companies-list" : "purchase-masters",
      diagnostics: d.diagnostics || null,
    };
  } catch (err) {
    error = err;
  }
  const fallback = await fetchCompanyList({ silent: true });
  return {
    companies: fallback, clients: [],
    error: fallback.length ? null : error,
    source: fallback.length ? "companies-list" : "none",
    diagnostics: null,
  };
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

/**
 * Options for <SearchableSelect> built from the company MASTER records
 * (Admin → Master Data → Company Profiles). Use this for every "which company?"
 * dropdown so the list always comes from the master and never from a hard-coded
 * or client-derived list.
 */
export function companyOptions(companies) {
  return (Array.isArray(companies) ? companies : [])
    .filter((c) => c?.id && c?.name)
    .map((c) => ({
      value: c.id,
      label: c.name,
      sublabel: [c.gstin, c.city || c.state].filter(Boolean).join(" · "),
    }));
}

/** Always return an array of clients, whatever wrapper the API used. */
export function normalizeClients(payload) {
  const d = payload?.data !== undefined ? payload.data : payload;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.clients)) return d.clients;
  if (Array.isArray(d?.items)) return d.items;
  return [];
}

/** Options for <SearchableSelect> built from client records. */
export function clientOptions(clients) {
  return (Array.isArray(clients) ? clients : [])
    .filter((c) => c?.id && (c?.company_name || c?.name))
    .map((c) => ({
      value: c.id,
      label: c.company_name || c.name,
      sublabel: [c.gstin || c.client_gstin, c.phone].filter(Boolean).join(" · "),
    }));
}

export default {
  fetchCompanies,
  fetchCompanyList,
  fetchPurchaseMasters,
  normalizeCompanies,
  recordBelongsToCompany,
  findCompany,
  companyOptions,
  clientOptions,
  normalizeClients,
};
