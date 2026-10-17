import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ClipboardCheck, Building2, Search, RefreshCw, CheckCircle2, XCircle, Eye, Loader2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { getOnboardingApplications, reviewOnboardingApplication } from "@/lib/commercialConsoleApi";

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

export default function OnboardingApprovalTab({ modules = [], invoiceCompanies = [], onRefresh }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState("pending");
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
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true); else setRefreshing(true);
    try {
      const params = {};
      if (status !== "all") params.status = status;
      if (search.trim()) params.search = search.trim();
      const data = await getOnboardingApplications(params);
      setItems(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      setItems([]);
      toast.error(error?.response?.data?.detail || "Unable to load onboarding applications.");
    } finally { setLoading(false); setRefreshing(false); }
  }, [status, search]);
  useEffect(() => { load(); }, [load]);

  const openDetails = (item) => {
    setSelected(item); setNotes(item.review_notes || "");
    setMaxUsers(String(item.approved_max_users || item.user_count || 10));
    setMonths("12"); setAmount(""); setInvoiceCompanyId(item.invoice_company_id || invoiceCompanies[0]?.id || "");
    const aliases = { tasks: "taskosphere", task_management: "taskosphere", accounting: "finix", invoicing: "finix", hr: "people_matrix", payroll: "people_matrix", crm: "proposals" };
    const chosen = (item.approved_modules || item.modules || []).map((x) => {
      const key = String(x || "").trim().toLowerCase().replaceAll("-", "_");
      return aliases[key] || key;
    });
    setApprovedModules([...new Set(chosen.filter((v) => catalog.some((m) => m.id === v)))]);
    setSelectedFeatures(Object.fromEntries(catalog.map((module) => [module.id, (module.features || []).map((f) => f.id || f.flag).filter(Boolean)])));
    setIssued(null);
  };
  const toggleModule = (id, checked) => setApprovedModules((old) => checked ? [...new Set([...old, id])] : old.filter((v) => v !== id));
  const toggleFeature = (moduleId, featureId, checked) => setSelectedFeatures((old) => {
    const next = { ...old }; const items = new Set(next[moduleId] || []);
    if (checked) items.add(featureId); else items.delete(featureId);
    next[moduleId] = [...items]; return next;
  });

  const action = async (kind) => {
    if (!selected || busy) return;
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
          <p className="mt-1 text-sm text-slate-500">Review Google Form applications and approve using the existing commercial license flow.</p>
        </div></div>
        <button onClick={() => load(true)} disabled={refreshing} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-60"><RefreshCw size={14} className={refreshing ? "animate-spin" : ""}/> Refresh</button>
      </div>
      <div className="mt-5 flex flex-col gap-3 md:flex-row">
        <div className="relative flex-1"><Search size={15} className="absolute left-3 top-2.5 text-slate-400"/>
          <input value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="Search application ID, company, email or PAN" className={field + " pl-9"}/>
        </div>
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={field}>{STATUSES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">{STATUSES.filter((s) => s.value !== "all").map((s) => <button key={s.value} onClick={() => setStatus(s.value)} className={"rounded-xl border p-3 text-left " + (status === s.value ? "border-blue-500 bg-blue-50" : "border-slate-200")}><div className="text-xs text-slate-500">{s.label}</div><div className="mt-1 text-xl font-bold text-slate-900">{items.filter((i) => i.status === s.value).length}</div></button>)}</div>
    </div>

    {loading ? <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500"><Loader2 className="animate-spin" size={18}/> Loading applications…</div>
      : items.length === 0 ? <div className={card + " p-10 text-center"}><Building2 className="mx-auto mb-3 text-slate-300" size={34}/><p className="font-semibold text-slate-800">No applications found</p><p className="mt-1 text-sm text-slate-500">Google Form submissions appear after the Apps Script bridge is configured.</p></div>
      : <div className={card + " overflow-hidden"}><div className="overflow-x-auto"><table className="w-full min-w-[980px] text-sm">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr>{["Application ID","Applicant","Contact","License request","Submitted","Status","Action"].map((h) => <th key={h} className="px-4 py-3 text-left font-bold">{h}</th>)}</tr></thead>
        <tbody>{items.map((item) => <tr key={item.application_id} className="border-t border-slate-100">
          <td className="px-4 py-3 align-top"><div className="font-bold">{item.application_id}</div><div className="mt-1 text-xs text-slate-500">{item.city}, {item.state}</div></td>
          <td className="px-4 py-3 align-top"><div className="font-semibold">{item.trade_name || item.legal_name}</div><div className="mt-1 text-xs text-slate-500">{item.email}</div></td>
          <td className="px-4 py-3 align-top"><div>{item.contact_name}</div><div className="text-xs text-slate-500">{item.mobile}</div></td>
          <td className="px-4 py-3 align-top"><div>{item.license_type}</div><div className="mt-1 text-xs text-slate-500">{item.user_count} users</div><div className="mt-1 text-xs text-slate-500">{(item.modules || []).join(", ")}</div></td>
          <td className="px-4 py-3 align-top whitespace-nowrap">{item.created_at ? new Date(item.created_at).toLocaleDateString("en-IN") : "—"}</td>
          <td className="px-4 py-3 align-top"><span className={"inline-flex rounded-full px-2.5 py-1 text-[11px] font-bold " + (item.status === "approved" ? "bg-emerald-100 text-emerald-800" : item.status === "rejected" ? "bg-rose-100 text-rose-800" : item.status === "under_review" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800")}>{nice(item.status)}</span></td>
          <td className="px-4 py-3 align-top"><button onClick={() => openDetails(item)} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold text-slate-700"><Eye size={14}/> {["pending","under_review"].includes(item.status) ? "Review" : "View"}</button></td>
        </tr>)}</tbody>
      </table></div></div>}

    {selected && <div className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/60 p-3 sm:p-6" role="dialog" aria-modal="true" aria-labelledby="commercial-onboarding-title">
      <div className="w-full max-w-5xl max-h-[92vh] overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6">
        <div className="flex items-start justify-between gap-3"><div><h3 id="commercial-onboarding-title" className="text-xl font-bold text-slate-900">{selected.trade_name || selected.legal_name}</h3><p className="mt-1 text-xs text-slate-500">{selected.application_id} · {selected.created_at ? new Date(selected.created_at).toLocaleString("en-IN") : ""}</p></div><button onClick={() => { setSelected(null); setIssued(null); }} className="rounded-lg border px-3 py-1.5 text-sm">Close</button></div>
        {issued && <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-center gap-2 font-bold text-emerald-900"><KeyRound size={16}/> Commercial license created</div><p className="mt-1 text-xs text-emerald-800">Save the key securely. The existing flow also creates the licensed customer, tenant database, admin placeholder and invoice.</p><code className="mt-3 block break-all rounded-lg bg-white p-3 text-sm">{issued.license_key}</code><div className="mt-2 text-xs text-emerald-900">Customer: {issued.customer_id} · License: {issued.license_id} · Invoice: {issued.invoice_id || "—"}</div><button onClick={() => navigator.clipboard?.writeText(issued.license_key || "")} className="mt-2 text-xs font-bold underline">Copy license key</button></div>}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{[
          ["Legal name",selected.legal_name],["Entity type",selected.constitution],["PAN",selected.pan],["GSTIN",selected.gstin],["Registration no.",selected.registration_no],["Business type",selected.business_type],["Contact",selected.contact_name],["Designation",selected.designation],["Email",selected.email],["Mobile",selected.mobile],["Website",selected.website],["Deployment",selected.deployment],["Migration",selected.migration],["Isolation request",selected.isolation],["Branding",selected.branding],["Custom domain",selected.custom_domain],["Integrations",(selected.integrations||[]).join(", ")]
        ].filter(([,v]) => v).map(([label,value]) => <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</div><div className="mt-1 break-words text-sm text-slate-800">{value}</div></div>)}
        <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Registered address</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.address}, {selected.city}, {selected.state} {selected.pin}</div></div>
        {selected.business_description && <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Business description</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.business_description}</div></div>}
        {selected.notes && <div className="sm:col-span-2 lg:col-span-3 rounded-lg border border-slate-200 bg-slate-50 p-3"><div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Applicant notes</div><div className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{selected.notes}</div></div>}</div>
        {["pending","under_review"].includes(selected.status) && !issued && <div className="mt-5 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
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
          {["pending","under_review"].includes(selected.status) && !issued && <><button disabled={busy} onClick={()=>action("under_review")} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold disabled:opacity-50">{busy?"Saving…":"Mark under review"}</button><button disabled={busy} onClick={()=>action("reject")} className="inline-flex items-center gap-2 rounded-lg border border-rose-300 px-4 py-2 text-sm font-semibold text-rose-700 disabled:opacity-50"><XCircle size={15}/> Reject</button><button disabled={busy} onClick={()=>action("approve")} className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold text-white disabled:opacity-50"><CheckCircle2 size={15}/> Approve & issue license</button></>}
        </div>
      </div>
    </div>}
  </div>;
}
