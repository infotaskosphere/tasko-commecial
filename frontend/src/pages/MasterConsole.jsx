import React, { useEffect, useMemo, useState } from "react";
import {
  Activity, CheckCircle2, Copy, Globe2, KeyRound, Package, Plus, Search,
  ShieldCheck, Users, XCircle, Building2, IndianRupee, Save, Trash2,
  ReceiptText, ChevronDown, ChevronRight, Loader2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  generateCommercialLicense,
  getLicenseState,
  updateLicenseStatus,
  deleteCommercialCompany,
  getCommercialModuleCatalog,
  updateCommercialModulePrice,
} from "@/lib/licenseApi";
import { fetchCompanyList } from "@/lib/companies";

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
  validity_months: 12, amount_charged: "", currency: "INR", max_users: 10, max_installations: 1, notes: "", invoice_company_id: "",
};

const formatDate = (value) => value ? new Date(value).toLocaleDateString("en-IN") : "Lifetime";
const money = (value) => Number(value || 0).toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 });

function Stat({ icon: Icon, label, value }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="w-fit rounded-xl bg-slate-100 p-2.5"><Icon size={18} /></div><div className="mt-4 text-3xl font-bold text-slate-950">{value}</div><div className="mt-1 text-sm font-medium text-slate-600">{label}</div></div>;
}

const Field = ({ label, children, className = "" }) => <label className={`text-sm font-medium text-slate-700 ${className}`}><span className="mb-1.5 block">{label}</span>{children}</label>;
const Input = (props) => <input {...props} className={`w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 outline-none focus:border-slate-400 ${props.className || ""}`} />;

function featureMapForModule(module) {
  return Object.fromEntries((module?.features || []).map((feature) => [feature.id, feature]));
}

export default function MasterConsole() {
  const navigate = useNavigate();
  const [state, setState] = useState({ packages: [], licenses: [], customers: [] });
  const [modules, setModules] = useState([]);
  const [invoiceCompanies, setInvoiceCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [selectedModules, setSelectedModules] = useState([]);
  const [selectedFeatures, setSelectedFeatures] = useState({});
  const [expandedModules, setExpandedModules] = useState({});
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

  const loadInvoiceCompanies = async () => {
    try {
      const companies = await fetchCompanyList({ silent: false });
      setInvoiceCompanies(companies || []);
      setForm((current) => ({ ...current, invoice_company_id: current.invoice_company_id || companies?.[0]?.id || "" }));
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to load Company Master.");
    }
  };

  useEffect(() => { refresh(); }, []);

  const activeModules = useMemo(() => modules.filter((module) => module.active !== false), [modules]);

  const selectedCatalog = useMemo(() => activeModules.filter((module) => selectedModules.includes(module.id)), [activeModules, selectedModules]);
  const monthlyTotal = useMemo(() => selectedCatalog.reduce((sum, module) => {
    const allFlags = (module.features || []).map((feature) => feature.id);
    const flags = selectedFeatures[module.id] || [];
    if (flags.length === allFlags.length && Number(module.monthly_price || 0) > 0) return sum + Number(module.monthly_price || 0);
    const prices = featureMapForModule(module);
    return sum + flags.reduce((featureSum, flag) => featureSum + Number(prices[flag]?.monthly_price || 0), 0);
  }, 0), [selectedCatalog, selectedFeatures]);
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
      license.license_key, license.customer_name, license.package_name, license.status,
      license.amount_charged, license.invoice_no, license.customer?.gstin,
      ...(license.modules || []).map((module) => MODULE_LABELS[module] || module),
      ...Object.values(license.selected_features || {}).flat(),
    ].some((value) => String(value || "").toLowerCase().includes(q)));
  }, [query, state.licenses]);

  const selectModule = (moduleId, enabled) => {
    const module = activeModules.find((item) => item.id === moduleId);
    if (!module) return;
    if (enabled) {
      setSelectedModules((current) => current.includes(moduleId) ? current : [...current, moduleId]);
      setSelectedFeatures((current) => ({ ...current, [moduleId]: (module.features || []).map((feature) => feature.id) }));
      setExpandedModules((current) => ({ ...current, [moduleId]: true }));
    } else {
      setSelectedModules((current) => current.filter((id) => id !== moduleId));
      setSelectedFeatures((current) => { const next = { ...current }; delete next[moduleId]; return next; });
    }
  };

  const toggleFeature = (moduleId, featureId) => {
    setSelectedFeatures((current) => {
      const existing = current[moduleId] || [];
      const next = existing.includes(featureId) ? existing.filter((id) => id !== featureId) : [...existing, featureId];
      if (!next.length) {
        setSelectedModules((mods) => mods.filter((id) => id !== moduleId));
        const copy = { ...current }; delete copy[moduleId]; return copy;
      }
      if (!selectedModules.includes(moduleId)) setSelectedModules((mods) => [...mods, moduleId]);
      return { ...current, [moduleId]: next };
    });
  };

  const resetCreateForm = () => {
    const first = activeModules[0];
    const defaults = first ? { [first.id]: (first.features || []).map((feature) => feature.id) } : {};
    setForm({ ...emptyForm, invoice_company_id: invoiceCompanies[0]?.id || "" });
    setSelectedModules(first ? [first.id] : []);
    setSelectedFeatures(defaults);
    setExpandedModules(first ? { [first.id]: true } : {});
  };

  const openCreate = async () => {
    resetCreateForm();
    setShowCreate(true);
    await loadInvoiceCompanies();
  };

  const submit = async (event) => {
    event.preventDefault();
    if (generating) return;
    if (!selectedModules.length) { toast.error("Select at least one module."); return; }
    if (!form.invoice_company_id) { toast.error("Select the Company Master company that should issue the invoice."); return; }
    const invalid = selectedModules.some((moduleId) => !(selectedFeatures[moduleId] || []).length);
    if (invalid) { toast.error("Every selected module must have at least one feature."); return; }
    setGenerating(true);
    try {
      const response = await generateCommercialLicense({
        ...form,
        selected_modules: selectedModules,
        selected_features: selectedFeatures,
        validity_months: Number(form.validity_months || 0),
        amount_charged: form.amount_charged === "" ? calculatedAmount : Number(form.amount_charged),
        max_users: Number(form.max_users),
        max_installations: Number(form.max_installations),
      });
      setCreated(response.license || response);
      setShowCreate(false);
      resetCreateForm();
      await refresh();
      toast.success(`License generated${response.invoice?.invoice_no ? ` with invoice ${response.invoice.invoice_no}` : ""}.`);
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to generate license.");
    } finally {
      setGenerating(false);
    }
  };

  const copy = async (key) => { await navigator.clipboard.writeText(key); toast.success("License number copied."); };
  const changeStatus = async (license, status) => {
    try { await updateLicenseStatus(license.id, status); await refresh(); toast.success(`License ${status}.`); }
    catch (error) { toast.error(error?.response?.data?.detail || "Unable to update license."); }
  };
  const removeCompany = async (license) => {
    const confirmed = window.confirm(`Delete ${license.customer_name || "this company"} from the License Registry? This will deactivate its commercial users and remove the commercial license/company record. Historical invoices will be preserved.`);
    if (!confirmed) return;
    try {
      await deleteCommercialCompany(license.id);
      await refresh();
      toast.success(`${license.customer_name || "Company"} removed from License Registry.`);
    } catch (error) { toast.error(error?.response?.data?.detail || "Unable to delete company."); }
  };
  const savePricing = async (module) => {
    try {
      const featurePrices = Object.fromEntries((module.features || []).map((feature) => [feature.id, Number(feature.monthly_price || 0)]));
      const saved = await updateCommercialModulePrice(module.id, Number(module.monthly_price || 0), module.active !== false, featurePrices);
      setModules((items) => items.map((item) => item.id === module.id ? saved : item));
      toast.success(`${module.name} pricing updated.`);
    } catch (error) { toast.error(error?.response?.data?.detail || "Unable to update module pricing."); }
  };

  return <div className="min-h-screen bg-slate-50 p-4 md:p-7"><div className="mx-auto max-w-[1500px]">
    <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
      <div><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400"><ShieldCheck size={15} /> Commercial Control Plane</div><h1 className="mt-1 text-3xl font-bold text-slate-950">Taskosphere Master Console</h1><p className="mt-1 text-sm text-slate-500">Licensing, customers, feature-level entitlements and commercial invoicing.</p></div>
      <div className="flex flex-wrap gap-2"><button onClick={() => navigate("/master-console/website")} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm"><Globe2 size={17} /> Website & Branding</button><button onClick={openCreate} disabled={generating} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"><Plus size={17} /> Generate License</button></div>
    </div>

    <div className="mt-7 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm"><div className="flex flex-wrap items-center gap-1"><button className="rounded-xl bg-slate-950 px-4 py-2.5 text-sm font-semibold text-white">Licensing Control</button><button onClick={() => navigate("/master-console/website")} className="rounded-xl px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-50"><span className="inline-flex items-center gap-2"><Globe2 size={15} /> Website Studio</span></button></div></div>

    <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Stat icon={KeyRound} label="Total Licenses" value={stats.total} /><Stat icon={CheckCircle2} label="Active Licenses" value={stats.active} /><Stat icon={XCircle} label="Expired Licenses" value={stats.expired} /><Stat icon={Users} label="Customers" value={stats.customers} /></div>

    <section className="mt-7 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-start justify-between gap-4"><div><h2 className="font-bold text-slate-900">Module & Feature Catalog</h2><p className="mt-1 text-sm text-slate-500">Set a full-module price and individual feature prices. A customer can buy one feature or any combination inside a module.</p></div><IndianRupee size={20} className="shrink-0 text-slate-400" /></div><div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{modules.map((module) => <div key={module.id} className="rounded-2xl border border-slate-200 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{module.code}</p><h3 className="mt-1 font-bold text-slate-900">{module.name}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{module.description}</p></div><input aria-label={`${module.name} active`} type="checkbox" checked={module.active !== false} onChange={(event) => setModules((items) => items.map((item) => item.id === module.id ? { ...item, active: event.target.checked } : item))} /></div><div className="mt-4"><Field label="Full module price / month"><Input type="number" min="0" step="0.01" value={module.monthly_price ?? 0} onChange={(event) => setModules((items) => items.map((item) => item.id === module.id ? { ...item, monthly_price: event.target.value } : item))} /></Field></div><div className="mt-4 rounded-xl bg-slate-50 p-3"><div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Individual feature pricing</div><div className="space-y-2">{(module.features || []).map((feature) => <div key={feature.id} className="grid grid-cols-[1fr_100px] items-center gap-2"><span className="min-w-0 text-xs font-medium leading-4 text-slate-700">{feature.label}</span><input type="number" min="0" step="0.01" value={feature.monthly_price ?? 0} onChange={(event) => setModules((items) => items.map((item) => item.id === module.id ? { ...item, features: (item.features || []).map((f) => f.id === feature.id ? { ...f, monthly_price: event.target.value } : f) } : item))} className="w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs outline-none focus:border-slate-400" /></div>)}</div></div><button type="button" onClick={() => savePricing(module)} className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold"><Save size={15} /> Save Pricing</button></div>)}</div></section>

    <div className="mt-5 grid gap-5 lg:grid-cols-3"><section className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center justify-between"><div><h2 className="font-bold text-slate-900">Legacy Package Templates</h2><p className="mt-1 text-sm text-slate-500">Kept only for compatibility with existing licenses. New licenses use feature-level selection.</p></div><Package size={20} className="text-slate-400" /></div><div className="mt-5 grid gap-4 md:grid-cols-3">{state.packages.filter((pkg) => pkg.id !== "custom-modules").map((pkg) => <div key={pkg.id} className="rounded-2xl border border-slate-200 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{pkg.code}</p><h3 className="mt-1 font-bold">{pkg.name}</h3><p className="mt-1 text-xs text-slate-500">{pkg.description}</p><p className="mt-3 text-xs text-slate-400">{pkg.max_users} users · {pkg.max_installations} installations</p></div>)}</div></section><section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-bold text-slate-900">Recent Activity</h2><div className="mt-5 space-y-4">{state.licenses.slice(0, 6).map((license) => <div key={license.id} className="flex items-center gap-3"><div className="rounded-lg bg-slate-100 p-2"><Activity size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{license.customer_name}</p><p className="text-xs text-slate-400">{(license.modules || []).map((module) => MODULE_LABELS[module] || module).join(", ") || license.package_name} · {license.validity_months || "—"} months</p></div><span className="text-xs text-slate-400">{formatDate(license.issued_at)}</span></div>)}{!state.licenses.length && <p className="text-sm text-slate-400">No licenses generated yet.</p>}</div></section></div>

    <section className="mt-5 rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex flex-col gap-3 border-b border-slate-100 p-5 md:flex-row md:items-center md:justify-between"><div><h2 className="font-bold">License Registry</h2><p className="mt-1 text-sm text-slate-500">Each record shows modules, individual features, pricing, invoice and customer details.</p></div><div className="relative w-full md:w-80"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search customer, GSTIN, key, invoice or feature" className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm" /></div></div><div className="overflow-x-auto"><table className="w-full min-w-[1650px] text-left text-sm"><thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">License</th><th className="px-5 py-3">Features</th><th className="px-5 py-3">Monthly</th><th className="px-5 py-3">Charged</th><th className="px-5 py-3">Duration</th><th className="px-5 py-3">Invoice</th><th className="px-5 py-3">Issued</th><th className="px-5 py-3">Validity</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{filtered.map((license) => <tr key={license.id}><td className="px-5 py-4"><div className="font-semibold">{license.customer_name}</div><div className="text-xs text-slate-400">{license.customer?.gstin || "GSTIN not recorded"} · {license.customer?.email || "No email"}</div></td><td className="px-5 py-4"><button onClick={() => copy(license.license_key)} className="inline-flex max-w-[190px] items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-xs font-semibold"><span className="break-all">{license.license_key}</span><Copy size={13} className="shrink-0" /></button></td><td className="px-5 py-4"><div className="max-w-[430px] space-y-1.5">{Object.entries(license.selected_features || {}).map(([moduleId, flags]) => <div key={moduleId} className="flex flex-wrap items-center gap-1.5"><span className="text-[10px] font-bold uppercase text-slate-400">{MODULE_LABELS[moduleId] || moduleId}</span>{(flags || []).map((flag) => <span key={flag} className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium">{flag.replace(/^can_view_|^can_manage_/, "").replaceAll("_", " ")}</span>)}</div>)}{!Object.keys(license.selected_features || {}).length && <div className="flex flex-wrap gap-1.5">{(license.modules || []).map((module) => <span key={module} className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium">{MODULE_LABELS[module] || module}</span>)}</div>}</div></td><td className="px-5 py-4 font-semibold">{money(license.monthly_module_price)}</td><td className="px-5 py-4 font-semibold">{money(license.amount_charged)}</td><td className="px-5 py-4 text-slate-500">{license.validity_months || "—"} months</td><td className="px-5 py-4"><div className="inline-flex items-center gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs font-semibold"><ReceiptText size={13} /> {license.invoice_no || "—"}</div></td><td className="px-5 py-4 text-slate-500">{formatDate(license.issued_at)}</td><td className="px-5 py-4 text-slate-500">{formatDate(license.expires_at)}</td><td className="px-5 py-4"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold">{license.status}</span></td><td className="px-5 py-4"><div className="flex items-center gap-2"><select value="" onChange={(event) => event.target.value && changeStatus(license, event.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"><option value="">Status</option><option value="active">Activate</option><option value="suspended">Suspend</option><option value="revoked">Revoke</option></select><button type="button" onClick={() => removeCompany(license)} title="Delete company" className="inline-flex items-center justify-center rounded-lg border border-red-200 p-2 text-red-600 hover:bg-red-50"><Trash2 size={15} /></button></div></td></tr>)}{!filtered.length && <tr><td colSpan="11" className="px-5 py-12 text-center text-slate-400">{loading ? "Loading licensing server…" : "No licenses found."}</td></tr>}</tbody></table></div></section>

    {created && <div className="fixed inset-x-4 bottom-5 z-50 mx-auto max-w-5xl rounded-2xl border border-emerald-200 bg-white p-5 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">License Generated</p><h3 className="mt-1 font-bold">{created.customer_name}</h3><p className="mt-1 text-sm text-slate-500">{(created.modules || []).map((module) => MODULE_LABELS[module] || module).join(", ")} · {created.validity_months} months · {money(created.amount_charged)}</p></div><button onClick={() => setCreated(null)} className="text-slate-400">×</button></div><div className="mt-4 grid gap-3 md:grid-cols-2"><div className="rounded-xl bg-slate-950 p-3"><div className="text-[10px] uppercase tracking-wider text-white/60">License Key</div><div className="mt-1 flex items-center gap-2"><code className="flex-1 break-all text-sm font-bold tracking-wider text-white">{created.license_key}</code><button onClick={() => copy(created.license_key)} className="rounded-lg bg-white/10 p-2 text-white"><Copy size={16} /></button></div></div><div className="rounded-xl bg-slate-50 p-3"><div className="text-[10px] uppercase tracking-wider text-slate-400">Invoice</div><div className="mt-1 flex items-center gap-2 text-sm font-bold text-slate-900"><ReceiptText size={16} /> {created.invoice_no || created.invoice?.invoice_no || "Generated"}</div><div className="mt-1 text-xs text-slate-500">Issuer: {created.invoice_company_id ? invoiceCompanies.find((company) => company.id === created.invoice_company_id)?.name || created.invoice_company_id : "Company Master"}</div></div></div></div>}

    {showCreate && <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-950/40 p-4"><form onSubmit={submit} className="relative my-6 w-full max-w-6xl rounded-2xl bg-white p-6 shadow-2xl"><div className="flex items-center justify-between gap-4"><div><h2 className="text-xl font-bold">Generate Commercial License</h2><p className="mt-1 text-sm text-slate-500">Choose exactly which modules and individual features the customer is buying. The invoice is generated automatically.</p></div><button type="button" disabled={generating} onClick={() => setShowCreate(false)} className="text-slate-400 disabled:opacity-40">×</button></div>
      <div className="mt-6 grid gap-5 lg:grid-cols-3"><div className="lg:col-span-2 rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="mb-3 flex items-center gap-2 font-semibold text-slate-800"><Building2 size={17} /> Customer & GST details</div><div className="grid gap-4 md:grid-cols-2"><Field label="Company Name *"><Input required disabled={generating} value={form.company_name} onChange={(event) => setForm({ ...form, company_name: event.target.value })} placeholder="Registered company / firm name" /></Field><Field label="Contact Person"><Input disabled={generating} value={form.contact_name} onChange={(event) => setForm({ ...form, contact_name: event.target.value })} /></Field><Field label="Email *"><Input required disabled={generating} type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field><Field label="Phone"><Input disabled={generating} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></Field><Field label="GSTIN"><Input disabled={generating} value={form.gstin} onChange={(event) => setForm({ ...form, gstin: event.target.value.toUpperCase() })} placeholder="15-character GSTIN" /></Field><Field label="Pincode"><Input disabled={generating} value={form.pincode} onChange={(event) => setForm({ ...form, pincode: event.target.value })} /></Field><Field label="City"><Input disabled={generating} value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} /></Field><Field label="State"><Input disabled={generating} value={form.state} onChange={(event) => setForm({ ...form, state: event.target.value })} /></Field><Field label="Registered Address"><Input disabled={generating} value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} /></Field><Field label="GST Address"><Input disabled={generating} value={form.gst_address} onChange={(event) => setForm({ ...form, gst_address: event.target.value })} /></Field></div></div><div className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm"><div className="flex items-center gap-2 font-semibold text-slate-800"><ReceiptText size={17} /> Invoice Company</div><p className="mt-1 text-xs leading-5 text-slate-500">Select the existing Company Master company that will issue the commercial license invoice.</p><Field label="Invoice From Company Master *" className="mt-4"><select required disabled={generating} value={form.invoice_company_id} onChange={(event) => setForm({ ...form, invoice_company_id: event.target.value })} className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none focus:border-slate-400"><option value="">Select issuing company</option>{invoiceCompanies.map((company) => <option key={company.id} value={company.id}>{company.name || company.company_name}</option>)}</select></Field>{!invoiceCompanies.length && <p className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">No Company Master records were found. Create the issuing company in Admin → Master Data first.</p>}<div className="mt-5 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">Invoice is created as a tax invoice using the selected issuer's GST registration and normal accounting journal flow.</div></div></div>

      <div className="mt-5 rounded-2xl border border-slate-200 p-4"><div className="flex items-center justify-between gap-3"><div><h3 className="font-bold">Modules & individual features</h3><p className="mt-1 text-xs text-slate-500">Example: select Finix → Sales / Invoicing only to sell only invoicing.</p></div><span className="text-sm font-semibold text-slate-600">{selectedModules.length} modules · {Object.values(selectedFeatures).reduce((sum, items) => sum + items.length, 0)} features</span></div><div className="mt-4 grid gap-3 lg:grid-cols-2">{activeModules.map((module) => { const selected = selectedModules.includes(module.id); const features = module.features || []; return <div key={module.id} className={`rounded-2xl border p-4 ${selected ? "border-slate-900 bg-slate-50" : "border-slate-200 bg-white"}`}><div className="flex items-start gap-3"><input type="checkbox" disabled={generating} className="mt-1" checked={selected} onChange={(event) => selectModule(module.id, event.target.checked)} /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><div><div className="font-bold text-slate-900">{module.name}</div><div className="text-xs text-slate-500">Full module: {money(module.monthly_price)} / month</div></div><button type="button" disabled={generating} onClick={() => setExpandedModules((current) => ({ ...current, [module.id]: !current[module.id] }))} className="rounded-lg p-1.5 text-slate-500 hover:bg-white disabled:opacity-40">{expandedModules[module.id] ? <ChevronDown size={17} /> : <ChevronRight size={17} />}</button></div>{expandedModules[module.id] && <div className="mt-3 space-y-2 border-t border-slate-200 pt-3">{features.map((feature) => { const checked = (selectedFeatures[module.id] || []).includes(feature.id); return <label key={feature.id} className="flex cursor-pointer items-start gap-2 rounded-xl bg-white p-2.5"><input type="checkbox" disabled={generating} className="mt-0.5" checked={checked} onChange={() => toggleFeature(module.id, feature.id)} /><span className="min-w-0 flex-1 text-xs font-medium leading-4 text-slate-700">{feature.label}</span><span className="shrink-0 text-xs font-semibold text-slate-600">{money(feature.monthly_price)}/mo</span></label>; })}</div>}</div></div></div>; })}</div></div>

      <div className="mt-5 rounded-2xl border border-slate-200 p-4"><div className="grid gap-4 md:grid-cols-4"><Field label="License Duration (months) *"><Input required disabled={generating} type="number" min="1" value={form.validity_months} onChange={(event) => setForm({ ...form, validity_months: event.target.value })} /></Field><Field label="Max Users"><Input disabled={generating} type="number" min="1" value={form.max_users} onChange={(event) => setForm({ ...form, max_users: event.target.value })} /></Field><Field label="Max Installations"><Input disabled={generating} type="number" min="1" value={form.max_installations} onChange={(event) => setForm({ ...form, max_installations: event.target.value })} /></Field><Field label="Currency"><Input disabled={generating} value={form.currency} onChange={(event) => setForm({ ...form, currency: event.target.value.toUpperCase() })} /></Field></div><div className="mt-4 grid gap-4 md:grid-cols-3"><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Selected features / month</p><p className="mt-1 text-lg font-bold">{money(monthlyTotal)}</p></div><div className="rounded-xl bg-slate-50 p-3"><p className="text-xs text-slate-500">Calculated license price</p><p className="mt-1 text-lg font-bold">{money(calculatedAmount)}</p></div><Field label="Amount Charged"><Input disabled={generating} type="number" min="0" step="0.01" value={form.amount_charged} onChange={(event) => setForm({ ...form, amount_charged: event.target.value })} /></Field></div><Field label="Notes" className="mt-4"><textarea disabled={generating} value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows="3" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 outline-none focus:border-slate-400 disabled:bg-slate-50" placeholder="Discount, quotation reference, commercial terms, etc." /></Field></div>

      <div className="mt-6 flex justify-end gap-2"><button type="button" disabled={generating} onClick={() => setShowCreate(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold disabled:opacity-50">Cancel</button><button type="submit" disabled={generating || !selectedModules.length || !form.invoice_company_id} className="inline-flex min-w-[205px] items-center justify-center gap-2 rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60">{generating ? <><Loader2 size={17} className="animate-spin" /> Generating License…</> : <>Generate License + Invoice</>}</button></div>

      {generating && <div className="absolute inset-0 z-50 flex items-center justify-center rounded-2xl bg-white/75 backdrop-blur-[2px]"><div className="flex min-w-[260px] flex-col items-center rounded-2xl border border-slate-200 bg-white px-8 py-7 text-center shadow-2xl"><div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100"><Loader2 size={25} className="animate-spin text-slate-800" /></div><p className="mt-4 text-sm font-bold text-slate-900">Generating license & invoice</p><p className="mt-1 text-xs text-slate-500">Please wait while the license, customer record and invoice are created.</p></div></div>}
    </form></div>}
  </div></div>;
}