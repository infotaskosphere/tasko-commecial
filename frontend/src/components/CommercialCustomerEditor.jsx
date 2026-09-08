import React, { useMemo, useState } from "react";
import { Building2, Check, ChevronDown, ChevronRight, Loader2, Mail, Phone, Save, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { updateCommercialCustomer, updateCommercialLicense } from "@/lib/licenseApi";

const MODULE_LABELS = {
  taskosphere: "Taskosphere",
  finix: "Finix",
  compliance: "Compliance",
  records: "Records",
  proposals: "Client Proposals",
  people_matrix: "People Matrix",
};

const prettyFlag = (flag) => String(flag || "").replace(/^can_(view|manage)_/, "").replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());

export default function CommercialCustomerEditor({ license, customer, modules = [], onClose, onSaved }) {
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState("company");
  const [expanded, setExpanded] = useState({});
  const [company, setCompany] = useState({
    company_name: customer?.company_name || license?.customer_name || "",
    contact_name: customer?.contact_name || "",
    email: customer?.email || "",
    phone: customer?.phone || "",
    gstin: customer?.gstin || "",
    address: customer?.address || "",
    gst_address: customer?.gst_address || "",
    city: customer?.city || "",
    state: customer?.state || "",
    pincode: customer?.pincode || "",
  });
  const [selectedModules, setSelectedModules] = useState(() => [...(license?.modules || [])]);
  const [selectedFeatures, setSelectedFeatures] = useState(() => ({ ...(license?.selected_features || {}) }));
  const [limits, setLimits] = useState({
    max_users: license?.max_users ?? 10,
    max_installations: license?.max_installations ?? 1,
  });

  const activeCatalog = useMemo(() => modules.filter((m) => m.active !== false), [modules]);

  const toggleModule = (moduleId) => {
    const module = activeCatalog.find((m) => m.id === moduleId);
    if (!module) return;
    setSelectedModules((current) => {
      if (current.includes(moduleId)) return current.filter((id) => id !== moduleId);
      return [...current, moduleId];
    });
    setSelectedFeatures((current) => ({
      ...current,
      [moduleId]: current[moduleId]?.length ? current[moduleId] : (module.features || []).map((feature) => feature.id),
    }));
  };

  const toggleFeature = (moduleId, featureId) => {
    setSelectedFeatures((current) => {
      const existing = current[moduleId] || [];
      const next = existing.includes(featureId) ? existing.filter((id) => id !== featureId) : [...existing, featureId];
      return { ...current, [moduleId]: next };
    });
  };

  const save = async (event) => {
    event.preventDefault();
    if (saving) return;
    if (!company.company_name.trim()) { toast.error("Company name is required."); return; }
    if (!company.email.trim()) { toast.error("Email is required."); return; }
    if (!selectedModules.length) { toast.error("Select at least one licensed module."); return; }
    const invalid = selectedModules.some((moduleId) => !(selectedFeatures[moduleId] || []).length);
    if (invalid) { toast.error("Every licensed module must retain at least one feature."); return; }

    setSaving(true);
    try {
      const [updatedCustomer, updatedLicense] = await Promise.all([
        updateCommercialCustomer(license.customer_id, company),
        updateCommercialLicense(license.id, {
          modules: selectedModules,
          selected_features: selectedFeatures,
          max_users: Math.max(1, Number(limits.max_users || 1)),
          max_installations: Math.max(1, Number(limits.max_installations || 1)),
        }),
      ]);
      toast.success("Customer and license details updated.");
      onSaved?.({ customer: updatedCustomer, license: updatedLicense });
      onClose?.();
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to save customer details.");
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    ["company", "Company Details"],
    ["license", "License Access"],
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/55 p-3 md:p-6" role="dialog" aria-modal="true" aria-label="Commercial customer details">
      <form onSubmit={save} className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 md:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-slate-900 text-white"><Building2 size={20} /></div>
            <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">License Registry</p><h2 className="truncate text-xl font-bold text-slate-950">{company.company_name || "Customer Details"}</h2><p className="mt-0.5 truncate text-xs text-slate-500">{license?.license_key || "No license key"}</p></div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 disabled:opacity-40"><X size={20} /></button>
        </div>

        <div className="flex gap-1 border-b border-slate-100 px-5 pt-3 md:px-7">
          {tabs.map(([id, label]) => <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-t-xl px-4 py-2.5 text-sm font-semibold ${tab === id ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-50"}`}>{label}</button>)}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 md:p-7">
          {tab === "company" && <div className="space-y-5">
            <section className="rounded-2xl border border-slate-200 p-5">
              <div className="mb-4 flex items-center gap-2 font-bold text-slate-900"><Building2 size={17} /> Company & Contact</div>
              <div className="grid gap-4 md:grid-cols-2">
                {[["Company Name", "company_name", "text"], ["Contact Person", "contact_name", "text"], ["Email", "email", "email"], ["Mobile / Phone", "phone", "text"], ["GSTIN", "gstin", "text"], ["Pincode", "pincode", "text"], ["City", "city", "text"], ["State", "state", "text"]].map(([label, key, type]) => <label key={key} className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">{label}</span><input type={type} value={company[key]} onChange={(e) => setCompany((current) => ({ ...current, [key]: key === "gstin" ? e.target.value.toUpperCase() : e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" /></label>)}
                <label className="text-sm font-medium text-slate-700 md:col-span-2"><span className="mb-1.5 block">Registered Address</span><textarea rows="2" value={company.address} onChange={(e) => setCompany((current) => ({ ...current, address: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" /></label>
                <label className="text-sm font-medium text-slate-700 md:col-span-2"><span className="mb-1.5 block">GST Address</span><textarea rows="2" value={company.gst_address} onChange={(e) => setCompany((current) => ({ ...current, gst_address: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" /></label>
              </div>
            </section>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-slate-200 p-4"><Mail size={16} className="text-slate-400" /><p className="mt-2 text-xs text-slate-400">Login / billing email</p><p className="mt-1 break-all text-sm font-semibold">{company.email || "—"}</p></div>
              <div className="rounded-2xl border border-slate-200 p-4"><Phone size={16} className="text-slate-400" /><p className="mt-2 text-xs text-slate-400">Contact number</p><p className="mt-1 text-sm font-semibold">{company.phone || "—"}</p></div>
              <div className="rounded-2xl border border-slate-200 p-4"><ShieldCheck size={16} className="text-slate-400" /><p className="mt-2 text-xs text-slate-400">License status</p><p className="mt-1 text-sm font-semibold capitalize">{license?.status || "—"}</p></div>
            </div>
          </div>}

          {tab === "license" && <div className="space-y-5">
            <section className="rounded-2xl border border-slate-200 p-5">
              <div className="mb-4 flex items-start justify-between gap-4"><div><h3 className="font-bold text-slate-900">Licensed Modules</h3><p className="mt-1 text-xs text-slate-500">Control which modules and individual features this customer can use.</p></div><ShieldCheck size={18} className="text-slate-400" /></div>
              <div className="grid gap-3 md:grid-cols-2">{activeCatalog.map((module) => {
                const enabled = selectedModules.includes(module.id);
                const features = module.features || [];
                return <div key={module.id} className={`rounded-2xl border p-4 ${enabled ? "border-slate-900 bg-slate-50" : "border-slate-200"}`}>
                  <div className="flex items-center gap-3"><input type="checkbox" checked={enabled} disabled={saving} onChange={() => toggleModule(module.id)} /><div className="min-w-0 flex-1"><p className="font-semibold text-slate-900">{module.name}</p><p className="text-xs text-slate-400">{(selectedFeatures[module.id] || []).length} of {features.length} features enabled</p></div><button type="button" disabled={!enabled || saving} onClick={() => setExpanded((current) => ({ ...current, [module.id]: !current[module.id] }))} className="rounded-lg p-1.5 text-slate-400 hover:bg-white disabled:opacity-30">{expanded[module.id] ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button></div>
                  {enabled && expanded[module.id] && <div className="mt-3 space-y-1 border-t border-slate-200 pt-3">{features.map((feature) => <label key={feature.id} className="flex items-center gap-2 rounded-lg px-2 py-2 hover:bg-white"><input type="checkbox" disabled={saving} checked={(selectedFeatures[module.id] || []).includes(feature.id)} onChange={() => toggleFeature(module.id, feature.id)} /><span className="text-xs font-medium text-slate-700">{feature.label || prettyFlag(feature.id)}</span></label>)}</div>}
                </div>;
              })}</div>
            </section>

            <section className="rounded-2xl border border-slate-200 p-5"><h3 className="font-bold text-slate-900">License Limits</h3><div className="mt-4 grid gap-4 md:grid-cols-2"><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Maximum Users</span><input type="number" min="1" value={limits.max_users} onChange={(e) => setLimits((current) => ({ ...current, max_users: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label><label className="text-sm font-medium text-slate-700"><span className="mb-1.5 block">Maximum Installations</span><input type="number" min="1" value={limits.max_installations} onChange={(e) => setLimits((current) => ({ ...current, max_installations: e.target.value }))} disabled={saving} className="w-full rounded-xl border border-slate-200 px-3 py-2.5" /></label></div></section>
          </div>}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-100 bg-slate-50 px-5 py-4 md:px-7"><p className="text-xs text-slate-500">Changes are restricted to the Platform Owner and are recorded against the commercial customer/license.</p><div className="flex gap-2"><button type="button" onClick={onClose} disabled={saving} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">Cancel</button><button type="submit" disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{saving ? "Saving…" : "Save Changes"}</button></div></div>
        {saving && <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/65 backdrop-blur-[1px]"><div className="rounded-2xl border border-slate-200 bg-white px-6 py-5 text-center shadow-xl"><Loader2 size={24} className="mx-auto animate-spin text-slate-800" /><p className="mt-2 text-sm font-semibold">Saving customer details…</p></div></div>}
      </form>
    </div>
  );
}
