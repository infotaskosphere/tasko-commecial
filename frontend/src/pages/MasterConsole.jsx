import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Ban,
  CheckCircle2,
  ChevronDown,
  Copy,
  KeyRound,
  LayoutDashboard,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Users,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  createLicense,
  DEFAULT_PACKAGES,
  getLicenseState,
  subscribeLicenseState,
  updateLicenseStatus,
  upgradeLicense,
} from "@/lib/licenseApi";

const MODULE_LABELS = {
  TASKS: "Task Management",
  INVOICING: "Invoicing",
  ACCOUNTING: "Accounting",
  HRMS: "HRMS",
};

const money = (value) => `₹${Number(value || 0).toLocaleString("en-IN")}`;
const formatDate = (value) => (value ? new Date(value).toLocaleDateString("en-IN") : "Lifetime");

const initialForm = {
  company_name: "",
  contact_name: "",
  email: "",
  phone: "",
  package_id: "essential",
  validity_days: 365,
  max_users: 10,
  max_installations: 1,
};

function StatCard({ icon: Icon, label, value, note }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="rounded-xl bg-slate-100 p-2.5"><Icon size={19} /></div>
        <span className="text-xs font-medium text-slate-400">Master Console</span>
      </div>
      <div className="mt-5 text-3xl font-bold tracking-tight text-slate-900">{value}</div>
      <div className="mt-1 text-sm font-medium text-slate-600">{label}</div>
      {note && <div className="mt-2 text-xs text-slate-400">{note}</div>}
    </div>
  );
}

function PackageCard({ pkg }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{pkg.code}</p>
          <h3 className="mt-1 text-lg font-bold text-slate-900">{pkg.name}</h3>
          <p className="mt-1 text-sm text-slate-500">{pkg.description}</p>
        </div>
        <Package className="text-slate-400" size={20} />
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {pkg.modules.map((module) => (
          <span key={module} className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
            {MODULE_LABELS[module] || module}
          </span>
        ))}
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm">
        <div><span className="text-slate-400">Users</span><div className="font-semibold">{pkg.max_users}</div></div>
        <div><span className="text-slate-400">Installations</span><div className="font-semibold">{pkg.max_installations}</div></div>
      </div>
    </div>
  );
}

export default function MasterConsole() {
  const [state, setState] = useState(getLicenseState);
  const [activeTab, setActiveTab] = useState("overview");
  const [query, setQuery] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(initialForm);
  const [lastCreated, setLastCreated] = useState(null);

  useEffect(() => subscribeLicenseState(setState), []);

  const stats = useMemo(() => {
    const active = state.licenses.filter((l) => l.status === "active").length;
    const expired = state.licenses.filter((l) => l.expires_at && new Date(l.expires_at) < new Date()).length;
    const customers = new Set(state.licenses.map((l) => l.customer_id)).size;
    return { total: state.licenses.length, active, expired, customers };
  }, [state]);

  const filteredLicenses = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.licenses;
    return state.licenses.filter((license) =>
      [license.license_key, license.customer_name, license.package_name, license.status].some((value) =>
        String(value || "").toLowerCase().includes(q)
      )
    );
  }, [query, state.licenses]);

  const handlePackageChange = (packageId) => {
    const pkg = state.packages.find((item) => item.id === packageId) || DEFAULT_PACKAGES[0];
    setForm((current) => ({ ...current, package_id: packageId, max_users: pkg.max_users, max_installations: pkg.max_installations }));
  };

  const handleCreate = (event) => {
    event.preventDefault();
    if (!form.company_name.trim()) return toast.error("Company name is required.");
    try {
      const license = createLicense(form);
      setLastCreated(license);
      setForm(initialForm);
      setShowCreate(false);
      toast.success("License generated successfully.");
    } catch (error) {
      toast.error(error.message || "Unable to generate license.");
    }
  };

  const copyKey = async (key) => {
    await navigator.clipboard.writeText(key);
    toast.success("License number copied.");
  };

  const changeStatus = (license, status) => {
    updateLicenseStatus(license.id, status);
    toast.success(`License ${status}.`);
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-7">
      <div className="mx-auto max-w-[1500px]">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
              <ShieldCheck size={15} /> Commercial Control Plane
            </div>
            <h1 className="mt-1 text-3xl font-bold tracking-tight text-slate-950">Taskosphere Master Console</h1>
            <p className="mt-1 text-sm text-slate-500">Manage packages, customers and commercial licenses.</p>
          </div>
          <button onClick={() => setShowCreate(true)} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">
            <Plus size={17} /> Generate License
          </button>
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard icon={KeyRound} label="Total Licenses" value={stats.total} />
          <StatCard icon={CheckCircle2} label="Active Licenses" value={stats.active} />
          <StatCard icon={XCircle} label="Expired Licenses" value={stats.expired} />
          <StatCard icon={Users} label="Customers" value={stats.customers} />
        </div>

        <div className="mt-7 flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm">
          {["overview", "licenses", "packages"].map((tab) => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`rounded-lg px-4 py-2 text-sm font-semibold capitalize ${activeTab === tab ? "bg-slate-900 text-white" : "text-slate-500 hover:bg-slate-100"}`}>
              {tab}
            </button>
          ))}
        </div>

        {activeTab === "overview" && (
          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex items-center justify-between">
                <div><h2 className="font-bold text-slate-900">Commercial Packages</h2><p className="mt-1 text-sm text-slate-500">Your initial product editions.</p></div>
                <Package size={20} className="text-slate-400" />
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                {state.packages.map((pkg) => <PackageCard key={pkg.id} pkg={pkg} />)}
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="font-bold text-slate-900">License Activity</h2>
              <div className="mt-5 space-y-4">
                {state.licenses.slice(0, 5).map((license) => (
                  <div key={license.id} className="flex items-center gap-3">
                    <div className="rounded-lg bg-slate-100 p-2"><Activity size={16} /></div>
                    <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold">{license.customer_name}</p><p className="text-xs text-slate-400">{license.package_name}</p></div>
                    <span className="text-xs text-slate-400">{formatDate(license.issued_at)}</span>
                  </div>
                ))}
                {!state.licenses.length && <p className="text-sm text-slate-400">No licenses generated yet.</p>}
              </div>
            </div>
          </div>
        )}

        {activeTab === "licenses" && (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-col gap-3 border-b border-slate-100 p-5 md:flex-row md:items-center md:justify-between">
              <div><h2 className="font-bold text-slate-900">License Registry</h2><p className="mt-1 text-sm text-slate-500">Issue and control customer entitlements.</p></div>
              <div className="relative w-full md:w-80"><Search size={16} className="absolute left-3 top-3 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search customer, key or package" className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-slate-400" /></div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">License</th><th className="px-5 py-3">Package</th><th className="px-5 py-3">Validity</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Actions</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLicenses.map((license) => (
                    <tr key={license.id}>
                      <td className="px-5 py-4"><div className="font-semibold text-slate-900">{license.customer_name}</div><div className="text-xs text-slate-400">{license.max_users} users · {license.max_installations} installations</div></td>
                      <td className="px-5 py-4"><button onClick={() => copyKey(license.license_key)} className="inline-flex items-center gap-2 rounded-lg bg-slate-100 px-2.5 py-1.5 font-mono text-xs font-semibold text-slate-700 hover:bg-slate-200">{license.license_key}<Copy size={13} /></button></td>
                      <td className="px-5 py-4 font-medium text-slate-700">{license.package_name}</td>
                      <td className="px-5 py-4 text-slate-500">{formatDate(license.expires_at)}</td>
                      <td className="px-5 py-4"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${license.status === "active" ? "bg-emerald-50 text-emerald-700" : license.status === "suspended" ? "bg-amber-50 text-amber-700" : "bg-red-50 text-red-700"}`}>{license.status}</span></td>
                      <td className="px-5 py-4"><select value="" onChange={(e) => e.target.value && changeStatus(license, e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"><option value="">Action</option><option value="active">Activate</option><option value="suspended">Suspend</option><option value="revoked">Revoke</option></select></td>
                    </tr>
                  ))}
                  {!filteredLicenses.length && <tr><td colSpan="6" className="px-5 py-12 text-center text-sm text-slate-400">No licenses match your search.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === "packages" && (
          <div className="mt-5 grid gap-5 md:grid-cols-3">{state.packages.map((pkg) => <PackageCard key={pkg.id} pkg={pkg} />)}</div>
        )}

        {lastCreated && (
          <div className="fixed inset-x-4 bottom-5 z-50 mx-auto max-w-2xl rounded-2xl border border-emerald-200 bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-wider text-emerald-600">License Generated</p><h3 className="mt-1 font-bold text-slate-900">{lastCreated.customer_name}</h3><p className="text-sm text-slate-500">{lastCreated.package_name}</p></div><button onClick={() => setLastCreated(null)} className="text-slate-400">×</button></div>
            <div className="mt-4 flex items-center gap-2 rounded-xl bg-slate-950 p-3"><code className="flex-1 break-all text-sm font-bold tracking-wider text-white">{lastCreated.license_key}</code><button onClick={() => copyKey(lastCreated.license_key)} className="rounded-lg bg-white/10 p-2 text-white hover:bg-white/20"><Copy size={16} /></button></div>
            <p className="mt-3 text-xs text-slate-500">Store this license number securely. The next phase will connect activation and server-side validation.</p>
          </div>
        )}

        {showCreate && (
          <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 p-4">
            <form onSubmit={handleCreate} className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
              <div className="flex items-center justify-between"><div><h2 className="text-xl font-bold text-slate-950">Generate License</h2><p className="mt-1 text-sm text-slate-500">Create a commercial entitlement for a customer.</p></div><button type="button" onClick={() => setShowCreate(false)} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100">×</button></div>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <label className="text-sm font-medium text-slate-700">Company Name<input required value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal outline-none focus:border-slate-400" /></label>
                <label className="text-sm font-medium text-slate-700">Contact Person<input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal outline-none focus:border-slate-400" /></label>
                <label className="text-sm font-medium text-slate-700">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal outline-none focus:border-slate-400" /></label>
                <label className="text-sm font-medium text-slate-700">Phone<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal outline-none focus:border-slate-400" /></label>
                <label className="text-sm font-medium text-slate-700">Package<select value={form.package_id} onChange={(e) => handlePackageChange(e.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"><option value="essential">Taskosphere Essential — Tasks + Invoicing</option><option value="professional">Taskosphere Professional — Tasks + Invoicing + HRMS</option><option value="enterprise">Taskosphere Enterprise — Tasks + Invoicing + Accounting + HRMS</option></select></label>
                <label className="text-sm font-medium text-slate-700">Validity<select value={form.validity_days} onChange={(e) => setForm({ ...form, validity_days: Number(e.target.value) })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal"><option value="365">1 Year</option><option value="730">2 Years</option><option value="1095">3 Years</option><option value="0">Lifetime</option></select></label>
                <label className="text-sm font-medium text-slate-700">Maximum Users<input type="number" min="1" value={form.max_users} onChange={(e) => setForm({ ...form, max_users: Number(e.target.value) })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" /></label>
                <label className="text-sm font-medium text-slate-700">Maximum Installations<input type="number" min="1" value={form.max_installations} onChange={(e) => setForm({ ...form, max_installations: Number(e.target.value) })} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal" /></label>
              </div>
              <div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setShowCreate(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600">Cancel</button><button type="submit" className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white">Generate License</button></div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
