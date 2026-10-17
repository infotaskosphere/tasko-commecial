import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardCheck, Building2, Search, RefreshCw, CheckCircle2, XCircle, Eye, Loader2, KeyRound, ChevronDown, ArrowLeft, ArrowRight, Copy } from "lucide-react";
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

const nice = (v) => String(v || "").replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());

const normalizeModules = (modules) => {
  const aliases = {
    tasks: "taskosphere",
    task_management: "taskosphere",
    accounting: "finix",
    invoicing: "finix",
    hr: "people_matrix",
    payroll: "people_matrix",
    crm: "proposals",
  };
  return [...new Set((Array.isArray(modules) ? modules : []).map((x) => {
    const key = String(x || "").trim().toLowerCase().replaceAll("-", "_");
    return aliases[key] || key;
  }).filter(Boolean))];
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
  const [stage, setStage] = useState("review");

  const catalog = useMemo(
    () => (Array.isArray(modules) ? modules : []).filter((m) => m.id !== "admin" && m.active !== false),
    [modules]
  );
  const selectedStatusLabel = STATUSES.find((item) => item.value === status)?.label || "Pending";

  const mergePreviouslyIssuedLicenses = useCallback(async (applications) => {
    try {
      const licenseState = await getLicenseState();
      const licenses = Array.isArray(licenseState?.licenses) ? licenseState.licenses : [];
      const customers = Array.isArray(licenseState?.customers) ? licenseState.customers : [];
      const customerById = Object.fromEntries(customers.map((customer) => [String(customer.id), customer]));
      const existing = Array.isArray(applications) ? applications : [];

      const legacy = licenses.map((license) => {
        const customer = license.customer || customerById[String(license.customer_id)] || {};
        const company = license.company_name || customer.company_name || license.customer_name || "Previously licensed customer";
        const email = customer.email || license.email || "";
        const applicationId = license.application_id || `LEGACY-LICENSE-${license.id || license.license_uid || license.license_key}`;
        return {
          application_id: applicationId,
          status: "approved",
          legacy_approved: true,
          license_id: license.id,
          license_key: license.license_key,
          licensee_uid: license.licensee_uid,
          license_uid: license.license_uid,
          trade_name: company,
          legal_name: company,
          company_name: company,
          email,
          contact_name: license.admin_name || customer.admin_name || "—",
          mobile: customer.phone || license.phone || "",
          gstin: customer.gstin || license.gstin || "",
          user_count: license.max_users || customer.max_users || "—",
          client_count: customer.client_count,
          country: customer.country,
          address: customer.address || license.address,
          city: customer.city || license.city,
          state: customer.state || license.state,
          pin: customer.pincode || license.pincode,
          business_type: customer.business_type,
          modules: license.modules || [],
          approved_modules: license.modules || [],
          selected_features: license.selected_features || {},
          approved_max_users: license.max_users,
          expires_at: license.expires_at,
          created_at: license.created_at || license.issued_at,
          review_notes: "Previously issued before Commercial Onboarding was introduced.",
        };
      });

      const seen = new Set();
      const merged = [...existing];
      existing.forEach((item) => {
        [item.application_id, item.license_key, item.license_id, item.customer_id].filter(Boolean).forEach((key) => seen.add(String(key)));
        const companyKey = `${String(item.trade_name || item.legal_name || item.company_name || "").trim().toLowerCase()}|${String(item.email || "").trim().toLowerCase()}`;
        if (companyKey !== "|") seen.add(companyKey);
      });

      legacy.forEach((item) => {
        const companyKey = `${String(item.trade_name || "").trim().toLowerCase()}|${String(item.email || "").trim().toLowerCase()}`;
        const duplicate = [item.application_id, item.license_key, item.license_id, companyKey]
          .filter(Boolean)
          .some((key) => seen.has(String(key)));
        if (!duplicate) merged.push(item);
      });

      return merged;
    } catch {
      return applications;
    }
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      // Always load the complete application set so the status cards remain
      // accurate even when the selected filter is Pending. Legacy licenses are
      // then added as approved records below.
      const data = await getOnboardingApplications({ status: "all" });
      const applications = Array.isArray(data?.items) ? data.items : [];
      const merged = await mergePreviouslyIssuedLicenses(applications);
      setItems(merged);
    } catch (error) {
      setItems([]);
      toast.error(error?.response?.data?.detail || "Unable to load onboarding applications.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [mergePreviouslyIssuedLicenses]);

  useEffect(() => { load(); }, [load]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      const statusMatch = status === "all" || item.status === status;
      if (!statusMatch) return false;
      if (!q) return true;
      return [
        item.application_id,
        item.trade_name,
        item.legal_name,
        item.company_name,
        item.email,
        item.pan,
        item.gstin,
        item.license_key,
      ].some((value) => String(value || "").toLowerCase().includes(q));
    });
  }, [items, search, status]);

  const openDetails = (item) => {
    setSelected(item);
    setStage("review");
    setNotes(item.review_notes || "");
    setMaxUsers(String(item.approved_max_users || item.user_count || 10));
    setMonths("12");
    setAmount(item.amount_charged == null ? "" : String(item.amount_charged));
    setInvoiceCompanyId(item.invoice_company_id || invoiceCompanies[0]?.id || "");
    const chosen = normalizeModules(item.approved_modules || item.modules || []);
    setApprovedModules(chosen.filter((id) => catalog.some((m) => m.id === id)));
    setSelectedFeatures(
      Object.fromEntries(
        catalog.map((module) => [
          module.id,
          item.selected_features?.[module.id] || (module.features || []).map((f) => f.id || f.flag).filter(Boolean),
        ])
      )
    );
    setIssued(null);
  };

  const toggleModule = (id, checked) => {
    setApprovedModules((old) => checked ? [...new Set([...old, id])] : old.filter((v) => v !== id));
  };

  const toggleFeature = (moduleId, featureId, checked) => setSelectedFeatures((old) => {
    const next = { ...old };
    const featureIds = new Set(next[moduleId] || []);
    if (checked) featureIds.add(featureId); else featureIds.delete(featureId);
    next[moduleId] = [...featureIds];
    return next;
  });

  const action = async (kind) => {
    if (!selected || busy || selected.legacy_approved) return;
    if (kind === "approve") {
      if (!approvedModules.length) return toast.error("Choose at least one module to approve.");
      if (!Number.isInteger(Number(maxUsers)) || Number(maxUsers) < 1) return toast.error("Enter a valid maximum user count.");
      if (!Number.isInteger(Number(months)) || Number(months) < 1) return toast.error("Select a valid license duration.");
      if (!invoiceCompanyId) return toast.error("Choose the invoice issuer company before approving.");
      if (approvedModules.some((moduleId) => !(selectedFeatures[moduleId] || []).length)) {
        return toast.error("Select at least one page/feature for each approved module, or remove the module.");
      }
      if (!window.confirm("Generate the license? This approves the application and creates the customer, isolated database, license key and invoice.")) return;
    }
    if (kind === "reject" && !window.confirm("Reject this onboarding application?")) return;

    setBusy(true);
    try {
      const response = await reviewOnboardingApplication(selected.application_id, {
        action: kind,
        review_notes: notes,
        ...(kind === "approve" ? {
          approved_modules: approvedModules,
          max_users: Number(maxUsers),
          validity_months: Number(months),
          amount_charged: amount === "" ? null : Number(amount),
          currency: "INR",
          invoice_company_id: invoiceCompanyId,
          selected_features: selectedFeatures,
        } : {}),
      });
      if (kind === "approve") {
        toast.success("License generated. Copy the key and share it with the client.");
        setIssued(response);
        await load(true);
        if (onRefresh) await onRefresh();
      } else {
        toast.success(kind === "reject" ? "Application rejected." : "Application moved to under review.");
        setSelected(null);
        await load(true);
      }
    } catch (error) {
      toast.error(error?.response?.data?.detail?.message || error?.response?.data?.detail || "Unable to process onboarding review.");
    } finally {
      setBusy(false);
    }
  };

  const card = "rounded-2xl border border-slate-200 bg-white shadow-sm";
  const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

  return <div className="space-y-5">
    <div className={card + " p-5 sm:p-6"}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-xl bg-teal-50 p-3 text-teal-700"><ClipboardCheck size={22}/></div>
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-blue-700">Commercial Licensing</p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">Onboarding Approval</h2>
            <p className="mt-1 text-sm text-slate-500">Review Google Form applications and approve using the existing commercial license flow.</p>
          </div>
        </div>
        <button onClick={() => load(true)} disabled={refreshing} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60">
          <RefreshCw size={14} className={refreshing ? "animate-spin" : ""}/><span>Refresh</span>
        </button>
      </div>

      <div className="mt-5 flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative z-10 flex-1">
          <Search size={15} className="absolute left-3 top-2.5 text-slate-400"/>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search application ID, company, email or PAN" className={field + " pl-9"}/>
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

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {STATUSES.filter((s) => s.value !== "all").map((s) => <button key={s.value} onClick={() => setStatus(s.value)} className={"rounded-xl border p-3 text-left " + (status === s.value ? "border-blue-500 bg-blue-50" : "border-slate-200")}>
          <div className="whitespace-nowrap text-xs text-slate-500">{s.label}</div><div className="mt-1 text-xl font-bold text-slate-900">{items.filter((i) => i.status === s.value).length}</div>
        </button>)}
      </div>
    </div>

    {loading ? <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500"><Loader2 className="animate-spin" size={18}/> Loading applications…</div>
      : visibleItems.length === 0 ? <div className={card + " p-10 text-center"}><Building2 className="mx-auto mb-3 text-slate-300" size={34}/><p className="font-semibold text-slate-800">No applications found</p><p className="mt-1 text-sm text-slate-500">Google Form submissions appear after the Apps Script bridge is configured.</p></div>
      : <div className={card + " overflow-hidden"}><div className="overflow-x-auto"><table className="w-full min-w-[980px] text-sm"><colgroup><col className="w-[160px]"/><col className="w-[180px]"/><col className="w-[150px]"/><col className="w-[200px]"/><col className="w-[110px]"/><col className="w-[170px]"/><col className="w-[100px]"/></colgroup>
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr>{["Application ID","Applicant","Contact","License request","Submitted","Status","Action"].map((h) => <th key={h} className="px-4 py-3 text-left font-bold">{h}</th>)}</tr></thead>
        <tbody>{visibleItems.map((item) => <tr key={item.application_id} className="border-t border-slate-100">
          <td className="px-4 py-3 align-top"><div className="font-bold">{item.application_id}</div><div className="mt-1 text-xs text-slate-500">{[item.city, item.state].filter(Boolean).join(", ")}</div></td>
          <td className="px-4 py-3 align-top"><div className="font-semibold">{item.trade_name || item.legal_name}</div><div className="mt-1 text-xs text-slate-500">{item.email || "—"}</div></td>
          <td className="px-4 py-3 align-top"><div>{item.contact_name || "—"}</div><div className="text-xs text-slate-500">{item.mobile || "—"}</div></td>
          <td className="px-4 py-3 align-top"><div>{item.license_type && item.license_type !== "To be assigned" ? item.license_type : (item.business_type || (item.legacy_approved ? "Previously issued license" : "—"))}</div><div className="mt-1 text-xs text-slate-500">{item.user_count || "—"} employees</div>{(item.modules || []).length > 0 && <div className="mt-1 text-xs text-slate-500">{(item.modules || []).join(", ")}</div>}</td>
          <td className="px-4 py-3 align-top whitespace-nowrap">{item.created_at ? new Date(item.created_at).toLocaleDateString("en-IN") : (item.expires_at ? `Valid until ${new Date(item.expires_at).toLocaleDateString("en-IN")}` : "—")}</td>
          <td className="w-[170px] px-4 py-3 align-top"><span className={"inline-flex w-max max-w-none whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold " + (item.status === "approved" ? "bg-emerald-100 text-emerald-800" : item.status === "rejected" ? "bg-rose-100 text-rose-800" : item.status === "under_review" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800")}>{item.legacy_approved ? "Previously approved" : nice(item.status)}</span></td>
          <td className="w-[100px] whitespace-nowrap px-4 py-3 align-top"><button onClick={() => openDetails(item)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold text-slate-700"><Eye size={14}/> {["pending","under_review"].includes(item.status) && !item.legacy_approved ? "Review" : "View"}</button></td>
        </tr>)}</tbody>
      </table></div></div>}

    {selected && createPortal(<div className="fixed inset-0 z-[110] flex min-h-screen w-screen items-center justify-center bg-slate-950/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="commercial-onboarding-title">
      <div className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3"><div><h3 id="commercial-onboarding-title" className="text-xl font-bold text-slate-900">{selected.trade_name || selected.legal_name}</h3><p className="mt-1 text-xs text-slate-500">{selected.application_id} · {selected.created_at ? new Date(selected.created_at).toLocaleString("en-IN") : "Previously issued license"}</p></div><button onClick={() => { setSelected(null); setIssued(null); }} className="rounded-lg border px-3 py-1.5 text-sm">Close</button></div>

        {selected.legacy_approved && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-center gap-2 font-bold text-emerald-900"><CheckCircle2 size={16}/> Previously approved license</div><p className="mt-1 text-xs text-emerald-800">This license was issued before the Commercial Onboarding feature was introduced, so it is included here as an approved historical record.</p>{selected.license_key && <><code className="mt-3 block break-all rounded-lg bg-white p-3 text-sm">{selected.license_key}</code><button onClick={() => { navigator.clipboard?.writeText(selected.license_key || ""); toast.success("License key copied."); }} className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline"><Copy size={12}/> Copy license key</button></>}</div>}

        {issued && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-center gap-2 font-bold text-emerald-900"><KeyRound size={16}/> License generated</div><p className="mt-1 text-xs text-emerald-800">Save the key securely. A licensed customer, an isolated tenant database, an admin placeholder and an invoice were created with it.</p><code className="mt-3 block break-all rounded-lg bg-white p-3 text-sm">{issued.license_key}</code><div className="mt-2 text-xs text-emerald-900">Customer: {issued.customer_id} · License: {issued.license_id} · Invoice: {issued.invoice_id || "—"}</div><button onClick={() => { navigator.clipboard?.writeText(issued.license_key || ""); toast.success("License key copied."); }} className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold underline"><Copy size={12}/> Copy license key</button></div>}

        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{[
          ["Legal name",selected.legal_name],["Entity type",selected.constitution],["PAN",selected.pan],["GSTIN",selected.gstin],["Registration no.",selected.registration_no],["Industry",selected.business_type],["Employees",selected.user_count],["Clients / entities",selected.client_count],["Country",selected.country],["Contact",selected.contact_name],["Designation",selected.designation],["Email",selected.email],["Mobile",selected.mobile],["Website",selected.website],["Go-live target",selected.go_live_date],["License key",selected.license_key],["Expires",selected.expires_at ? new Date(selected.expires_at).toLocaleDateString("en-IN") : null]
        ].filter(([,v]) => v).map(([label,value]) => <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 break-words text-sm text-slate-800">{value}</div></div>)}</div>
        {selected.address && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Registered address</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.address}, {selected.city}, {selected.state}{selected.country ? ", " + selected.country : ""} {selected.pin}</div></div>}
        {selected.business_description && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Business description</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.business_description}</div></div>}
        {selected.notes && <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Applicant notes</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.notes}</div></div>}

        {["pending","under_review"].includes(selected.status) && !selected.legacy_approved && !issued && stage === "setup" && <div className="mt-5 space-y-4 rounded-xl border border-blue-200 bg-slate-50 p-4">
          <div><h4 className="font-bold text-slate-900">License setup</h4><p className="mt-0.5 text-xs text-slate-500">Choose what this client can use, then generate the license key.</p></div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="text-xs font-semibold text-slate-700">Invoice issuer company <span className="text-rose-600">*</span><select className={field + " mt-1.5"} value={invoiceCompanyId} onChange={(e) => setInvoiceCompanyId(e.target.value)}><option value="">Select invoice issuer</option>{invoiceCompanies.map((company) => <option key={company.id} value={company.id}>{company.name || company.company_name || company.id}</option>)}</select></label>
            <label className="text-xs font-semibold text-slate-700">License duration<select className={field + " mt-1.5"} value={months} onChange={(e) => setMonths(e.target.value)}>{[1,3,6,12,24,36,60].map((m) => <option key={m} value={m}>{m} months</option>)}</select></label>
            <label className="text-xs font-semibold text-slate-700">Maximum users (client said {selected.user_count || "—"} employees)<input type="number" min="1" max="100000" className={field + " mt-1.5"} value={maxUsers} onChange={(e) => setMaxUsers(e.target.value)}/></label>
            <label className="text-xs font-semibold text-slate-700">Amount charged (INR; blank = calculated)<input type="number" min="0" step="0.01" className={field + " mt-1.5"} value={amount} onChange={(e) => setAmount(e.target.value)}/></label>
          </div>
          <div><div className="mb-2 flex items-center justify-between"><p className="text-xs font-bold text-slate-700">Module access <span className="text-rose-600">*</span></p><div className="flex gap-3 text-[11px] font-bold text-blue-700"><button type="button" onClick={() => setApprovedModules(catalog.map((m) => m.id))}>Select all</button><button type="button" onClick={() => setApprovedModules([])}>Clear</button></div></div><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{catalog.map((m) => <label key={m.id} className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700"><input type="checkbox" checked={approvedModules.includes(m.id)} onChange={(e) => toggleModule(m.id,e.target.checked)} className="accent-blue-700"/>{m.name || m.label || m.id}</label>)}</div></div>
          {approvedModules.map((moduleId) => { const m=catalog.find((x)=>x.id===moduleId); const features=m?.features||[]; if(!features.length)return null; return <div key={moduleId} className="rounded-lg border border-slate-200 bg-white p-3"><div className="mb-2 text-sm font-bold text-slate-800">{m.name || m.label || moduleId} pages</div><div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{features.map((f) => { const id=f.id||f.flag; return <label key={id} className="flex items-center gap-2 text-xs text-slate-700"><input type="checkbox" checked={(selectedFeatures[moduleId]||[]).includes(id)} onChange={(e)=>toggleFeature(moduleId,id,e.target.checked)} className="accent-blue-700"/>{f.label||f.name||id}</label>; })}</div></div>; })}
          <label className="block text-xs font-semibold text-slate-700">Reviewer notes<textarea className={field + " mt-1.5"} rows={3} value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="Verification, commercial terms and notes…"/></label>
        </div>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onClick={() => {setSelected(null);setIssued(null);}} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700">Close</button>
          {["pending","under_review"].includes(selected.status) && !selected.legacy_approved && !issued && stage === "review" && <><button disabled={busy} onClick={()=>action("under_review")} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy?"Saving…":"Mark under review"}</button><button disabled={busy} onClick={()=>action("reject")} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50"><XCircle size={15}/> Reject</button><button disabled={busy} onClick={()=>setStage("setup")} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"><CheckCircle2 size={15}/> Approve and set up license <ArrowRight size={15}/></button></>}
          {["pending","under_review"].includes(selected.status) && !selected.legacy_approved && !issued && stage === "setup" && <><button disabled={busy} onClick={()=>setStage("review")} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50"><ArrowLeft size={15}/> Back to application</button><button disabled={busy || !approvedModules.length || !invoiceCompanyId} onClick={()=>action("approve")} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"><KeyRound size={15}/> {busy ? "Generating…" : "Generate license"}</button></>}
        </div>
      </div>
    </div>, document.body)}
  </div>;
}
