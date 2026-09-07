import React, { useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Copy, Globe2, KeyRound, Package, Plus, Search, ShieldCheck, Users, XCircle, Building2, CalendarDays, IndianRupee, Save } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  generateCommercialLicense,
  getLicenseState,
  updateLicenseStatus,
  getCommercialModuleCatalog,
  updateCommercialModulePrice,
} from "@/lib/licenseApi";

const MODULE_LABELS = {
  taskosphere: "Taskosphere",
  finix: "Finix",
  compliance: "Compliance",
  records: "Records",
  proposals: "Client Proposals",
  people_matrix: "People Matrix",
};

const emptyForm = {
  company_name: "", contact_name: "", email: "", phone: "", gstin: "", address: "", gst_address: "", city: "", state: "", pincode: "",
  validity_months: 12, amount_charged: "", currency: "INR", max_users: 10, max_installations: 1, notes: "",
};

const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-IN") : "Lifetime";
const money = (value) => Number(value || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

function Stat({ icon: Icon, label, value }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="w-fit rounded-xl bg-slate-100 p-2.5"><Icon size={18} /></div><div className="mt-4 text-3xl font-bold text-slate-950">{value}</div><div className="mt-1 text-sm font-medium text-slate-600">{label}</div></div>;
}

const Field = ({ label, children, className = "" }) => <label className={`text-sm font-medium text-slate-700 ${className}`}><span className="block">{label}</span>{children}</label>;
const Input = (props) => <input {...props} className={`mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-slate-400 ${props.className || ""}`} />;

export default function MasterConsole() {
  const navigate = useNavigate();
  const [state, setState] = useState({ packages: [], licenses: [], customers: [] });
  const [modules, setModules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [selectedModules, setSelectedModules] = useState(["taskosphere"]);
  const [created, setCreated] = useState(null);

  const refresh = async () => {
    try {
      const [licenseState, moduleState] = await Promise.all([getLicenseState(), getCommercialModuleCatalog()]);
      setState(licenseState);
      setModules(moduleState.modules || []);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to connect to commercial licensing API.");
    } finally { setLoading(false); }
  };

  useEffect(() => { refresh(); }, []);

  const selectedCatalog = useMemo(() => modules.filter((module) => selectedModules.includes(module.id)), [modules, selectedModules]);
  const monthlyTotal = useMemo(() => selectedCatalog.reduce((sum, module) => sum + Number(module.monthly_price || 0), 0), [selectedCatalog]);
  const calculatedAmount = useMemo(() => monthlyTotal * Number(form.validity_months || 0), [monthlyTotal, form.validity_months]);

  useEffect(() => {
    if (!showCreate) return;
    setForm((current) => ({ ...current, amount_charged: Number(current.amount_charged || 0) === 0 ? calculatedAmount : current.amount_charged }));
  }, [calculatedAmount, showCreate]);

  const stats = useMemo(() => ({
    total: state.licenses.length,
    active: state.licenses.filter((l) => l.status === "active" && (!l.expires_at || new Date(l.expires_at) >= new Date())).length,
    expired: state.licenses.filter((l) => l.expires_at && new Date(l.expires_at) < new Date()).length,
    customers: new Set(state.licenses.map((l) => l.customer_id)).size,
  }), [state]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.licenses;
    return state.licenses.filter((license) => [
      license.license_key,
      license.customer_name,
      license.package_name,
      license.status,
      license.amount_charged,
      ...(license.modules || []).map((module) => MODULE_LABELS[module] || module),
      license.customer?.gstin,
    ].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [query, state.licenses]);

  const toggleModule = (moduleId) => setSelectedModules((current) => current.includes(moduleId) ? current.filter((id) => id !== moduleId) : [...current, moduleId]);

  const resetCreateForm = () => {
    setForm(emptyForm);
    setSelectedModules([modules.find((module) => module.active)?.id || "taskosphere"]);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!selectedModules.length) { toast.error("Select at least one module."); return; }
    try {
      const response = await generateCommercialLicense({
        ...form,
        selected_modules: selectedModules,
        validity_months: Number(form.validity_months || 0),
        amount_charged: form.amount_charged === "" ? calculatedAmount : Number(form.amount_charged),
        max_users: Number(form.max_users),
        max_installations: Number(form.max_installations),
      });
      setCreated(response.license || response);
      setShowCreate(false);
      resetCreateForm();
      await refresh();
      toast.success("License generated with the selected modules.");
    } catch (error) { toast.error(error?.response?.data?.detail || "Unable to generate license."); }
  };

  const copy = async (key) => { await navigator.clipboard.writeText(key); toast.success("License number copied."); };
  const changeStatus = async (license, status) => {
    try { await updateLicenseStatus(license.id, status); await refresh(); toast.success(`License ${status}.`); }
    catch (error) { toast.error(error?.response?.data?.detail || "Unable to update license."); }
  };
  const savePrice = async (module) => {
    try { await updateCommercialModulePrice(module.id, Number(module.monthly_price || 0), module.active !== false); await refresh(); toast.success(`${module.name} pricing updated.`); }
    catch (error) { toast.error(error?.response?.data?.detail || "Unable to update module pricing."); }
  };

  return <div className="min-h-screen bg-slate-50 p-4 md:p-7"><div className="mx-auto max-w-[1500px]">
    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><ShieldCheck size={15} /> Commercial Control Plane</div><h1 className="mt-1 text-3xl font-bold text-slate-950">Taskosphere Master Console</h1><p className="mt-1 text-sm text-slate-500">Licensing, customers and the complete customer-facing software website.</p></div>
      <div className="flex flex-wrap gap-2"><button onClick={() => navigate("/master-console/website")} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm"><Globe2 size={17} /> Website & Branding</button><button onClick={() => { resetCreateForm(); setShowCreate(true); }} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white"><Plus size={17} /> Generate License</button></div>
    </div>

    <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm"><div className="flex flex-wrap items-center gap-1"><button className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">Licensing Control</button><button onClick={() => navigate("/master-console/website")} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"><span className="inline-flex items-center gap-2"><Globe2 size={15} /> Website Studio</span></button></div></div>

    <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Stat icon={KeyRound} label="Total Licenses" value={stats.total} /><Stat icon={CheckCircle2} label="Active Licenses" value={stats.active} /><Stat icon={XCircle} label="Expired Licenses" value={stats.expired} /><Stat icon={Users} label="Customers" value={stats.customers} /></div>

    <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center justify-between"><div><h2 className="font-bold text-slate-900">Module Catalog & Pricing</h2><p className="mt-1 text-sm text-slate-500">Set the monthly price for each module. License pricing is calculated from the selected modules × license duration.</p></div><IndianRupee size={20} className="text-slate-400" /></div><div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{modules.map((module) => <div key={module.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{module.code}</p><h3 className="mt-1 font-bold">{module.name}</h3><p className="mt-1 text-xs text-slate-500">{module.description}</p></div><input type="checkbox" checked={module.active !== false} onChange={(event) => setModules((items) => items.map((item) => item.id === module.id ? { ...item, active: event.target.checked } : item))} /></div><div className="mt-4 flex items-end gap-2"><div className="flex-1"><Field label="Monthly price"><Input type="number" min="0" step="0.01" value={module.monthly_price ?? 0} onChange={(event) => setModules((items) => items.map((item) => item.id === module.id ? { ...item, monthly_price: event.target.value } : item))} /></Field></div><button type="button" onClick={() => savePrice(module)} className="mb-0 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold"><Save size={15} /> Save</button></div></div>)}</div></section>

    <div className="mt-5 grid gap-5 lg:grid-cols-3"><section className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center justify-between"><div><h2 className="font-bold text-slate-900">Legacy Package Templates</h2><p className="mt-1 text-sm text-slate-500">Kept for compatibility with existing licenses. New licenses use the module selector above.</p></div><Package size={20} className="text-slate-400" /></div><div className="mt-5 grid gap-4 md:grid-cols-3">{state.packages.filter((pkg) => pkg.id !== "custom-modules").map((pkg) => <div key={pkg.id} className="rounded-2xl border border-slate-200 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{pkg.code}</p><h3 className="mt-1 font-bold">{pkg.name}</h3><p className="mt-1 text-xs text-slate-500">{pkg.description}</p><p className="mt-3 text-xs text-slate-400">{pkg.max_users} users · {pkg.max_installations} installations</p></div>)}</div></section><section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-bold text-slate-900">Recent Activity</h2><div className="mt-5 space-y-4">{state.licenses.slice(0, 6).map((license) => <div key={license.id} className="flex items-center gap-3"><div className="rounded-lg bg-slate-100 p-2"><Activity size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{license.customer_name}</p><p className="text-xs text-slate-400">{(license.modules || []).map((module) => MODULE_LABELS[module] || module).join(", ") || license.package_name} · {license.validity_months || "—"} months</p></div><span className="text-xs text-slate-400">{formatDate(license.issued_at)}</span></div>)}{!state.licenses.length && <p className="text-sm text-slate-400">No licenses generated yet.</p>}</div></section></div>

    <section className="mt-5 rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-3 border-b border-slate-100 p-5 md:flex-row md:items-center md:justify-between"><div><h2 className="font-bold">License Registry</h2><p className="mt-1 text-sm text-slate-500">Each license records exactly which modules were sold, pricing, duration and customer details.</p></div><div className="relative w-full md:w-80"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, GSTIN, key or module" className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm" /></div></div><div className="overflow-x-auto"><table className="w-full min-w-[1450px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">License</th><th className="px-5 py-3">Modules</th><th className="px-5 py-3">Monthly</th><th className="px-5 py-3">Charged</th><th className="px-5 py-3">Duration</th><th className="px-5 py-3">Issued</th><th className="px-5 py-3">Validity</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{filtered.map((license) => <tr key={license.id}><td className="px-5 py-4"><div className="font-semibold">{license.customer_name}</div><div className="text-xs text-slate-400">{license.customer?.gstin || "GSTIN not recorded"} · {license.customer?.email || "No email"}</div></td><td className="px-5 py-4"><button onClick={() => copy(license.license_key)} className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-xs font-semibold">{license.license_key}<Copy size={13} /></button></td><td className="px-5 py-4"><div className="flex max-w-[330px] flex-wrap gap-1.5">{(license.modules || []).map((module) => <span key={module} className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium">{MODULE_LABELS[module] || module}</span>)}</div></td><td className="px-5 py-4 font-semibold">{money(license.monthly_module_price)}</td><td className="px-5 py-4 font-semibold">{money(license.amount_charged)}</td><td className="px-5 py-4 text-slate-500">{license.validity_months || "—"} months</td><td className="px-5 py-4 text-slate-500">{formatDate(license.issued_at)}</td><td className="px-5 py-4 text-slate-500">{formatDate(license.expires_at)}</td><td className="px-5 py-4"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold">{license.status}</span></td><td className="px-5 py-4"><select value="" onChange={(event) => event.target.value && changeStatus(license, event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"><option value="">Action</option><option value="active">Activate</option><option value="suspended">Suspend</option><option value="revoked">Revoke</option></select></td></tr>)}{!filtered.length && <tr><td colSpan="10" className="px-5 py-12 text-center text-slate-400">{loading ? "Loading licensing server…" : "No licenses found."}</td></tr>}</tbody></table></div></section>

    {created && <div className="fixed inset-x-4 bottom-5 z-50 mx-auto max-w-4xl rounded-2xl border border-emerald-200 bg-white p-5 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">License Generated</p><h3 className="mt-1 font-bold">{created.customer_name}</h3><p className="mt-1 text-sm text-slate-500">{(created.modules || []).map((module) => MODULE_LABELS[module] || module).join(", ")} · {created.validity_months} months · {money(created.amount_charged)}</p></div><button onClick={() => setCreated(null)} className="text-slate-400">×</button></div><div className="mt-4 flex items-center gap-2 rounded-xl bg-slate-950 p-3"><code className="flex-1 break-all text-sm font-bold tracking-wider text-white">{created.license_key}</code><button onClick={() => copy(created.license_key)} className="rounded-lg bg-white/10 p-2 text-white"><Copy size={16} /></button></div><div className="mt-4 grid gap-3 text-xs text-slate-600 sm:grid-cols-4"><div><b>Issued:</b> {formatDate(created.issued_at)}</div><div><b>Expires:</b> {formatDate(created.expires_at)}</div><div><b>Monthly:</b> {money(created.monthly_module_price)}</div><div><b>GSTIN:</b> {created.customer?.gstin || "—"}</div></div></div>}

    {showCreate && <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4"><form onSubmit={submit} className="my-6 w-full max-w-5xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between"><div><h2 className="text-xl font-bold">Generate Commercial License</h2><p className="mt-1 text-sm text-slate-500">Select exactly which modules the customer is buying. No fixed Task + Finix/HRMS bundle is required.</p></div><button type="button" onClick={() => setShowCreate(false)} className="text-slate-400">×</button></div>
      <div className="mt-6 rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="mb-3 flex items-center gap-2 font-semibold text-slate-800"><Building2 size={17} /> Customer & GST details</div><div className="grid gap-4 md:grid-cols-2"><Field label="Company Name *"><Input required value={form.company_name} onChange={(event) => setForm({ ...form, company_name: event.target.value })} placeholder="Registered company / firm name" /></Field><Field label="Contact Person"><Input value={form.contact_name} onChange={(event) => setForm({ ...form, contact_name: event.target.value })} /></Field><Field label="Email *"><Input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field><Field label="Phone"><Input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /><span className="mt-1 block text-xs text-slate-400">Used for the licensed company record.</span></Field><Field label="GSTIN"><Input value={form.gstin} onChange={(event) => setForm({ ...form, gstin: event.target.value.toUpperCase() })} placeholder="15-character GSTIN" /></Field><Field label="Pincode"><Input value={form.pincode} onChange={(event) => setForm({ ...form, pincode: event.target.value })} /></Field><Field label="City"><Input value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></Field><Field label="State"><Input value={form.state} onChange={(event) => setForm({ ...form, state: event.target.value })} /></Field><Field label="Registered Address"><Input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></Field><Field label="GST Address"><Input value={form.gst_address} onChange={(event) => setForm({ ...form, gst_address: event.target.value })} /></Field></div></div>

      <div className="mt-5 rounded-2xl border border-slate-200 p-4"><div className="flex items-center justify-between"><div><h3 className="font-bold">Select Modules</h3><p className="mt-1 text-xs text-slate-500">Access is capped at the selected modules for the customer administrator and all staff created under the license.</p></div><span className="text-sm font-semibold text-slate-600">{selectedModules.length} selected</span></div><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">{modules.filter((module) => module.active !== false).map((module) => <label key={module.id} className={`cursor-pointer rounded-2xl border p-4 transition ${selectedModules.includes(module.id) ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white"}`}><div className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={selectedModules.includes(module.id)} onChange={() => toggleModule(module.id)} /><div className="min-w-0"><div className="flex items-center justify-between gap-2"><span className="font-bold">{module.name}</span><span className="text-sm font-semibold">{money(module.monthly_price)} / month</span></div><p className="mt-1 text-xs leading-5 text-slate-500">{module.description}</p></div></div></label>)}</div></div>

      <div className="mt-5 rounded-2xl border border-slate-200 p-4"><div className="grid gap-4 md:grid-cols-4"><Field label="License Duration (months) *"><Input required type="number" min="1" value={form.validity_months} onChange={(event) => setForm({ ...form, validity_months: event.target.value })} /></Field><Field label="Max Users"><Input type="number" min="1" value={form.max_users} onChange={(event) => setForm({ ...form, max_users: event.target.value })} /></Field><Field label="Max Installations"><Input type="number" min="1" value={form.max_installations} onChange={(event) => setForm({ ...form, max_installations: event.target.value })} /></Field><Field label="Currency"><Input value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></Field></div><div className="mt-4 grid gap-4 md:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Selected modules / month</p><p className="mt-1 text-lg font-bold">{money(monthlyTotal)}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Calculated license price</p><p className="mt-1 text-lg font-bold">{money(calculatedAmount)}</p></div><Field label="Amount Charged"><Input type="number" min="0" step="0.01" value={form.amount_charged} onChange={(event) => setForm({ ...form, amount_charged: event.target.value })} /></Field></div><Field label="Notes" className="mt-4"><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows="3" className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-slate-400" placeholder="Discount, quotation reference, commercial terms, etc." /></Field></div>

      <div className="mt-6 flex justify-end gap-2"><button type="button" onClick={() => setShowCreate(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold">Cancel</button><button type="submit" disabled={!selectedModules.length} className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">Generate License</button></div>
    </form></div>}
  </div></div>;
}
