import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, Building2, Search, RefreshCw, CheckCircle2, XCircle, Eye, Loader2, KeyRound, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { getOnboardingApplications, reviewOnboardingApplication } from "@/lib/commercialConsoleApi";
import { getLicenseState } from "@/lib/licenseApi";

const STATUSES = [
  { value: "pending", label: "Pending" },
  { value: "under_review", label: "Under review" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All applications" },
];
const MODULES = [
  ["taskosphere", "Taskosphere"], ["finix", "Finix / Accounting"], ["aiweave", "AIWeave"],
  ["compliance", "CompliGenie / Compliance"], ["records", "Records"],
  ["proposals", "LeadSense / Proposals"], ["people_matrix", "People Matrix / HR"],
];
const nice = (v) => String(v || "").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

const normaliseModules = (value) => {
  const raw = Array.isArray(value) ? value : [];
  const aliases = {
    tasks: "taskosphere", task_management: "taskosphere", accounting: "finix", invoicing: "finix",
    hr: "people_matrix", payroll: "people_matrix", crm: "proposals", leads: "proposals",
    leadsense: "proposals", complygenie: "compliance", roc: "compliance", gst: "compliance",
  };
  return [...new Set(raw.map((x) => {
    const key = String(x || "").trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
    return aliases[key] || key;
  }).filter(Boolean))];
};

const licenseCompany = (license) => {
  const customer = license?.customer || {};
  return license?.company_name || license?.customer_name || license?.legal_name ||
    customer.company_name || customer.name || license?.admin_name || "Licensed customer";
};

const licenseAdmin = (license) => {
  const customer = license?.customer || {};
  return license?.admin_name || license?.contact_name || customer.admin_name || customer.contact_name || "—";
};

const licenseEmail = (license) => {
  const customer = license?.customer || {};
  return license?.email || license?.contact_email || customer.email || "—";
};

const licenseModules = (license) => normaliseModules(
  license?.approved_modules || license?.selected_modules || license?.modules || license?.licensed_modules || license?.module_access
);

const licenseToApprovedItem = (license) => {
  const customer = license?.customer || {};
  const licenseId = license?.id || license?.license_id || "";
  const licenseKey = license?.license_key || license?.key || "";
  return {
    application_id: license?.application_id || (licenseId ? `LIC-${licenseId}` : `LIC-${licenseKey || "EXISTING"}`),
    legal_name: licenseCompany(license),
    trade_name: license?.trade_name || licenseCompany(license),
    constitution: license?.constitution || customer.constitution || "—",
    pan: license?.pan || customer.pan || "—",
    gstin: license?.gstin || customer.gstin || "—",
    registration_no: license?.registration_no || customer.registration_no || "—",
    business_type: license?.business_type || customer.business_type || "—",
    contact_name: licenseAdmin(license),
    designation: license?.designation || customer.designation || "—",
    email: licenseEmail(license),
    mobile: license?.mobile || license?.phone || customer.mobile || customer.phone || "—",
    address: license?.address || customer.address || "",
    city: license?.city || customer.city || "",
    state: license?.state || customer.state || "",
    pin: license?.pin || license?.pincode || customer.pin || customer.pincode || "",
    website: license?.website || customer.website || "",
    deployment: license?.deployment || "Existing commercial deployment",
    migration: license?.migration || "—",
    isolation: license?.isolation || "Dedicated / Isolated",
    branding: license?.branding || "—",
    custom_domain: license?.custom_domain || "",
    integrations: license?.integrations || [],
    business_description: license?.business_description || "",
    notes: license?.notes || license?.commercial_notes || "Existing license from Commercial License Registry.",
    license_type: license?.license_type || license?.package_name || license?.package || "Commercial License",
    user_count: license?.max_users || license?.user_count || license?.max_user_count || license?.user_limit || "—",
    modules: licenseModules(license),
    created_at: license?.issued_at || license?.created_at || license?.start_date || license?.updated_at,
    updated_at: license?.updated_at,
    status: "approved",
    license_key: licenseKey,
    license_id: licenseId,
    customer_id: license?.customer_id || customer?.id || "",
    invoice_id: license?.invoice_id || "",
    invoice_no: license?.invoice_no || "",
    tenant_id: license?.tenant_id || license?.database_id || "",
    validity_months: license?.validity_months || "",
    expires_at: license?.expires_at || license?.expiry_date || license?.valid_until || "",
    existing_license: true,
    source_license: license,
  };
};

export default function OnboardingApprovalTab({ modules = [], invoiceCompanies = [], onRefresh }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState("pending");
  const [statusOpen, setStatusOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [notes, setNotes] = useState("");
  const [maxUsers, setMaxUsers] = useState("10");
  const [months, setMonths] = useState("12");
  const [amount, setAmount] = useState("");
  const [invoiceCompanyId, setInvoiceCompanyId] = useState("");
  const [approvedModules, setApprovedModules] = useState([]);
  const [selectedFeatures, setSelectedFeatures] = useState({});
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState(null);

  const catalog = useMemo(() => (Array.isArray(modules) ? modules : []).filter((m) => m.id !== "admin" && m.active !== false), [modules]);
  const selectedStatusLabel = STATUSES.find((item) => item.value === status)?.label || "Pending";

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      const params = {};
      if (status !== "all") params.status = status;
      if (search.trim()) params.search = search.trim();

      const [applicationResult, licenseResult] = await Promise.all([
        getOnboardingApplications(params),
        status === "approved" || status === "all" ? getLicenseState().catch(() => ({ licenses: [] })) : Promise.resolve({ licenses: [] }),
      ]);

      const applications = Array.isArray(applicationResult?.items) ? applicationResult.items : [];
      let nextItems = applications;

      // Approved must include licenses already present in the Commercial License Registry.
      // Such licenses may have been issued before the onboarding/Google Form workflow and
      // therefore may not have a commercial_onboarding_applications record.
      if (status === "approved" || status === "all") {
        const existingLicenses = Array.isArray(licenseResult?.licenses) ? licenseResult.licenses : [];
        const approvedApplications = applications.filter((item) => item.status === "approved");
        const representedLicenseIds = new Set(
          approvedApplications.flatMap((item) => [item.license_id, item.license_key]).filter(Boolean).map(String)
        );
        const approvedLicenses = existingLicenses
          .filter((license) => {
            const licenseStatus = String(license?.status || "active").toLowerCase();
            if (["revoked", "deleted", "cancelled", "expired"].includes(licenseStatus)) return false;
            const id = String(license?.id || license?.license_id || "");
            const key = String(license?.license_key || license?.key || "");
            return !representedLicenseIds.has(id) && !representedLicenseIds.has(key);
          })
          .map(licenseToApprovedItem);

        nextItems = status === "approved"
          ? [...approvedApplications, ...approvedLicenses]
          : [...applications, ...approvedLicenses];
      }

      if (search.trim()) {
        const term = search.trim().toLowerCase();
        nextItems = nextItems.filter((item) => [
          item.application_id, item.legal_name, item.trade_name, item.email, item.pan,
          item.gstin, item.license_key, item.license_id, item.customer_id,
        ].some((value) => String(value || "").toLowerCase().includes(term)));
      }

      setItems(nextItems);
    } catch (error) {
      setItems([]);
      toast.error(error?.response?.data?.detail || "Unable to load onboarding applications.");
    } finally { setLoading(false); setRefreshing(false); }
  }, [status, search]);
  useEffect(() => { load(); }, [load]);

  const openDetails = (item) => {
    setSelected(item); setNotes(item.review_notes || "");
    setMaxUsers(String(item.approved_max_users || item.user_count || 10));
    setMonths(String(item.validity_months || 12));
    setAmount(item.amount_charged == null ? "" : String(item.amount_charged));
    setInvoiceCompanyId(item.invoice_company_id || invoiceCompanies[0]?.id || "");
    const chosen = normaliseModules(item.approved_modules || item.modules);
    setApprovedModules([...new Set(chosen.filter((v) => catalog.some((m) => m.id === v)))]);
    setSelectedFeatures(Object.fromEntries(catalog.map((module) => [module.id, (module.features || []).map((f) => f.id || f.flag).filter(Boolean)])));
    setIssued(item.existing_license ? item : null);
  };
  const toggleModule = (id, checked) => setApprovedModules((old) => checked ? [...new Set([...old, id])] : old.filter((v) => v !== id));
  const toggleFeature = (moduleId, featureId, checked) => setSelectedFeatures((old) => {
    const next = { ...old }; const items = new Set(next[moduleId] || []);
    if (checked) items.add(featureId); else items.delete(featureId);
    next[moduleId] = [...items]; return next;
  });

  const action = async (kind) => {
    if (!selected || busy || selected.existing_license) return;
    if (kind === "approve") {
      if (!approvedModules.length) return toast.error("Choose at least one module to approve.");
      if (!Number.isInteger(Number(maxUsers)) || Number(maxUsers) < 1) return toast.error("Enter a valid maximum user count.");
      if (!Number.isInteger(Number(months)) || Number(months) < 1) return toast.error("Select a valid license duration.");
      if (!invoiceCompanyId) return toast.error("Choose the invoice issuer company before approving.");
      const modulesWithoutFeatures = approvedModules.filter((moduleId) => !(selectedFeatures[moduleId] || []).length);
      if (modulesWithoutFeatures.length) {
        return toast.error("Select at least one page/feature for each approved module, or remove the module.");
      }
      if (!window.confirm("Approve this application and create its commercial customer, isolated database, license and invoice?")) return;
    }
    if (kind === "reject" && !window.confirm("Reject this onboarding application?")) return;
    setBusy(true);
    try {
      const response = await reviewOnboardingApplication(selected.application_id, {
        action: kind, review_notes: notes,
        ...(kind === "approve" ? {
          approved_modules: approvedModules, max_users: Number(maxUsers), validity_months: Number(months),
          amount_charged: amount === "" ? null : Number(amount), currency: "INR",
          invoice_company_id: invoiceCompanyId, selected_features: selectedFeatures,
        } : {}),
      });
      if (kind === "approve") {
        toast.success("Application approved. Commercial license and invoice created.");
        setIssued(response); await load(true);
        if (onRefresh) await onRefresh();
      } else {
        toast.success(kind === "reject" ? "Application rejected." : "Application moved to under review.");
        setSelected(null); await load(true);
      }
    } catch (error) {
      toast.error(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Unable to process onboarding review.");
    } finally { setBusy(false); }
  };

  const card = "rounded-2xl border border-slate-200 bg-white shadow-sm";
  const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";
  return <div className="space-y-5">
    <div className={card + " p-5 sm:p-6"}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3"><div className="rounded-xl bg-teal-50 p-3 text-teal-700"><ClipboardCheck size={22}/></div><div>
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue-700">Commercial Licensing</p>
          <h2 className="mt-1 text-xl font-bold text-slate-900">Onboarding Approval</h2>
          <p className="mt-1 text-sm text-slate-500">Review onboarding applications and existing commercial licenses. Google Form integration can be connected later.</p>
        </div></div>
        <button onClick={() => load(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""}/> Refresh</button>
      </div>
      <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative z-10 flex-1"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="Search application ID, company, email, PAN or license key" className={field + " pl-9"}/>
        </div>
        <div className="relative z-20 w-full md:w-[220px]">
          <button type="button" onClick={() => setStatusOpen((open) => !open)} className={field + " flex items-center justify-between gap-3 text-left"} aria-haspopup="listbox" aria-expanded={statusOpen}>
            <span className="truncate">{selectedStatusLabel}</span><ChevronDown size={16} className={"shrink-0 transition-transform " + (statusOpen ? "rotate-180" : "")}/>
          </button>
          {statusOpen && <>
            <button type="button" aria-label="Close status menu" className="fixed inset-0 z-0 cursor-default" onClick={() => setStatusOpen(false)} />
            <div role="listbox" className="absolute right-0 top-[calc(100%+6px)] z-50 w-full overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl ring-1 ring-slate-900/5">
              {STATUSES.map((option) => <button key={option.value} type="button" role="option" aria-selected={status === option.value} onClick={() => { setStatus(option.value); setStatusOpen(false); }} className={"flex w-full items-center rounded-lg px-3 py-2.5 text-left text-sm font-medium transition " + (status === option.value ? "bg-blue-50 text-blue-700" : "text-slate-700 hover:bg-slate-50")}>{option.label}</button>)}
            </div>
          </>}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">{STATUSES.filter((s) => s.value !== "all").map((s) => <button key={s.value} onClick={() => setStatus(s.value)} className={"rounded-xl border p-3 text-left " + (status === s.value ? "border-blue-500 bg-blue-50" : "border-slate-200")}><div className="text-xs text-slate-500">{s.label}</div><div className="mt-1 text-xl font-bold text-slate-900">{items.filter((i) => i.status === s.value).length}</div></button>)}</div>
    </div>

    {loading ? <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500"><Loader2 className="animate-spin" size={18}/> Loading records…</div>
      : items.length === 0 ? <div className={card + " p-10 text-center"}><Building2 className="mx-auto mb-3 text-slate-300" size={34}/><p className="font-semibold text-slate-800">No {status === "approved" ? "approved licenses" : "applications"} found</p><p className="mt-1 text-sm text-slate-500">{status === "approved" ? "Existing commercial licenses will appear here even when they were issued outside the onboarding form workflow." : "Google Form submissions can be connected later."}</p></div>
      : <div className={card + " overflow-hidden"}><div className="overflow-x-auto"><table className="w-full min-w-[1120px] text-sm">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr>{["Application ID","Applicant","Contact","License request","License Key","Submitted","Status","Action"].map((h) => <th key={h} className="px-4 py-3 text-left font-bold">{h}</th>)}</tr></thead>
        <tbody>{items.map((item) => <tr key={`${item.application_id}-${item.license_key || ""}`} className="border-t border-slate-100">
          <td className="px-4 py-3 align-top"><div className="font-bold">{item.application_id}</div><div className="mt-1 text-xs text-slate-500">{item.city}{item.city && item.state ? ", " : ""}{item.state}</div></td>
          <td className="px-4 py-3 align-top"><div className="font-semibold">{item.trade_name || item.legal_name}</div><div className="mt-1 text-xs text-slate-500">{item.email}</div></td>
          <td className="px-4 py-3 align-top"><div>{item.contact_name}</div><div className="text-xs text-slate-500">{item.mobile}</div></td>
          <td className="px-4 py-3 align-top"><div>{item.license_type}</div><div className="mt-1 text-xs text-slate-500">{item.user_count} users</div><div className="mt-1 text-xs text-slate-500">{(item.modules || []).join(", ")}</div></td>
          <td className="px-4 py-3 align-top"><code className="block max-w-[210px] break-all rounded bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-800">{item.license_key || "—"}</code></td>
          <td className="px-4 py-3 align-top whitespace-nowrap">{item.created_at ? new Date(item.created_at).toLocaleDateString("en-IN") : "—"}</td>
          <td className="px-4 py-3 align-top"><span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold " + (item.status === "approved" ? "bg-emerald-100 text-emerald-800" : item.status === "rejected" ? "bg-rose-100 text-rose-800" : item.status === "under_review" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800")}>{nice(item.status)}</span>{item.existing_license && <div className="mt-1 text-[10px] font-semibold text-emerald-700">Existing license</div>}</td>
          <td className="px-4 py-3 align-top"><button onClick={() => openDetails(item)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold text-slate-700"><Eye size={14}/> {["pending","under_review"].includes(item.status) ? "Review" : "View"}</button></td>
        </tr>)}</tbody>
      </table></div></div>}

    {selected && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="commercial-onboarding-title">
      <div className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3"><div><h3 id="commercial-onboarding-title" className="text-xl font-bold text-slate-900">{selected.trade_name || selected.legal_name}</h3><p className="mt-1 text-xs text-slate-500">{selected.application_id} · {selected.created_at ? new Date(selected.created_at).toLocaleString("en-IN") : ""}</p></div><button onClick={() => { setSelected(null); setIssued(null); }} className="rounded-lg border px-3 py-1.5 text-sm">Close</button></div>
        {issued && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-center gap-2 font-bold text-emerald-900"><KeyRound size={16}/> {issued.existing_license ? "Existing commercial license" : "Commercial license created"}</div><p className="mt-1 text-xs text-emerald-800">{issued.existing_license ? "This license is already present in the Commercial License Registry. No new license is being created." : "Save the key securely. The existing flow also creates the licensed customer, tenant database, admin placeholder and invoice."}</p><code className="mt-3 block break-all rounded-lg bg-white p-3 text-sm font-semibold">{issued.license_key}</code><div className="mt-2 text-xs text-emerald-900">Customer: {issued.customer_id || "—"} · License: {issued.license_id || "—"} · Invoice: {issued.invoice_id || issued.invoice_no || "—"}</div>{issued.expires_at && <div className="mt-1 text-xs text-emerald-900">Valid until: {new Date(issued.expires_at).toLocaleDateString("en-IN")}</div>}<button onClick={() => navigator.clipboard?.writeText(issued.license_key || "")} className="mt-2 text-xs font-bold underline">Copy license key</button></div>}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{[
          ["Legal name",selected.legal_name],["Entity type",selected.constitution],["PAN",selected.pan],["GSTIN",selected.gstin],["Registration no.",selected.registration_no],["Business type",selected.business_type],["Contact",selected.contact_name],["Designation",selected.designation],["Email",selected.email],["Mobile",selected.mobile],["Website",selected.website],["Deployment",selected.deployment],["Migration",selected.migration],["Isolation request",selected.isolation],["Branding",selected.branding],["Custom domain",selected.custom_domain],["Integrations",(selected.integrations||[]).join(", ")]
        ].filter(([,v]) => v).map(([label,value]) => <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 break-words text-sm text-slate-800">{value}</div></div>)}
        <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Registered address</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.address}{selected.address && (selected.city || selected.state || selected.pin) ? ", " : ""}{selected.city}, {selected.state} {selected.pin}</div></div>
        {selected.business_description && <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Business description</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.business_description}</div></div>}
        {selected.notes && <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Applicant notes</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.notes}</div></div>}
        {selected.existing_license && <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-emerald-700">Existing license registry data</div><div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 text-sm text-slate-800"><div><span className="text-xs text-slate-500">License key</span><div className="font-semibold break-all">{selected.license_key || "—"}</div></div><div><span className="text-xs text-slate-500">License ID</span><div className="font-semibold break-all">{selected.license_id || "—"}</div></div><div><span className="text-xs text-slate-500">Customer ID</span><div className="font-semibold break-all">{selected.customer_id || "—"}</div></div><div><span className="text-xs text-slate-500">Tenant ID</span><div className="font-semibold break-all">{selected.tenant_id || "—"}</div></div><div><span className="text-xs text-slate-500">Invoice</span><div className="font-semibold break-all">{selected.invoice_no || selected.invoice_id || "—"}</div></div><div><span className="text-xs text-slate-500">Validity</span><div className="font-semibold">{selected.expires_at ? new Date(selected.expires_at).toLocaleDateString("en-IN") : "—"}</div></div></div></div>}
        </div>
        {["pending","under_review"].includes(selected.status) && !issued && !selected.existing_license && <div className="mt-5 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h4 className="font-bold text-slate-900">Approval configuration</h4>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-slate-700">Invoice issuer company <span className="text-rose-600">*</span><select className={field + " mt-1.5"} value={invoiceCompanyId} onChange={(e) => setInvoiceCompanyId(e.target.value)}><option value="">Select invoice issuer</option>{invoiceCompanies.map((company) => <option key={company.id} value={company.id}>{company.name || company.company_name || company.id}</option>)}</select></label>
            <label className="text-xs font-semibold text-slate-700">License duration<select className={field + " mt-1.5"} value={months} onChange={(e) => setMonths(e.target.value)}>{[1,3,6,12,24,36,60].map((m) => <option key={m} value={m}>{m} months</option>)}</select></label>
            <label className="text-xs font-semibold text-slate-700">Maximum users<input type="number" min="1" max="100000" className={field + " mt-1.5"} value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)}/></label>
            <label className="text-xs font-semibold text-slate-700">Amount charged (INR; blank = calculated)<input type="number" min="0" step="0.01" className={field + " mt-1.5"} value={amount} onChange={(e) => setAmount(e.target.value)}/></label>
          </div>
          <div><p className="mb-2 text-xs font-bold text-slate-700">Approved modules</p><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{catalog.map((m) => <label key={m.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700"><input type="checkbox" checked={approvedModules.includes(m.id)} onChange={(e) => toggleModule(m.id,e.target.checked)} className="accent-blue-700"/>{m.name || m.label || m.id}</label>)}</div></div>
          {approvedModules.map((moduleId) => { const m=catalog.find((x)=>x.id===moduleId); const features=m?.features||[]; if(!features.length)return null; return <div key={moduleId} className="rounded-lg border border-slate-200 bg-white p-3"><div className="mb-2 text-sm font-bold text-slate-800">{m.name || m.label || moduleId} pages</div><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{features.map((f) => { const id=f.id||f.flag; return <label key={id} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={(selectedFeatures[moduleId]||[]).includes(id)} onChange={(e)=>toggleFeature(moduleId,id,e.target.checked)} className="accent-blue-700"/>{f.label||f.name||id}</label>; })}</div></div>; })}
          <label className="block text-xs font-semibold text-slate-700">Reviewer notes<textarea className={field + " mt-1.5"} rows={3} value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="Verification, commercial terms and notes…"/></label>
        </div>}
        <div className="mt-5 flex flex-wrap justify-end gap-2"><button onClick={() => {setSelected(null);setIssued(null);}} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Close</button>
          {["pending","under_review"].includes(selected.status) && !issued && !selected.existing_license && <><button disabled={busy} onClick={()=>action("under_review")} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy?"Saving…":"Mark under review"}</button><button disabled={busy} onClick={()=>action("reject")} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50"><XCircle size={15}/> Reject</button><button disabled={busy} onClick={()=>action("approve")} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"><CheckCircle2 size={15}/> Approve & issue license</button></>}
        </div>
      </div>
    </div>}
  </div>;
}
