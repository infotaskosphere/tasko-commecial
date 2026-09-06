import React, { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, ShieldCheck, XCircle } from "lucide-react";
import { activateLicense, validateLicense } from "@/lib/licenseApi";

const KEY_STORAGE = "taskosphere_license_key";
const INSTALLATION_STORAGE = "taskosphere_installation_id";
const NAME_STORAGE = "taskosphere_installation_name";

function getInstallationId() {
  let id = localStorage.getItem(INSTALLATION_STORAGE);
  if (!id) {
    const seed = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    id = `install-${seed}`;
    localStorage.setItem(INSTALLATION_STORAGE, id);
  }
  return id;
}

export default function LicenseActivation() {
  const [licenseKey, setLicenseKey] = useState(() => localStorage.getItem(KEY_STORAGE) || "");
  const [installationName, setInstallationName] = useState(() => localStorage.getItem(NAME_STORAGE) || window.location.hostname || "Taskosphere Installation");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!licenseKey) return;
    validateLicense(licenseKey).then((result) => {
      if (result?.valid) setStatus({ ok: true, message: "License is valid.", license: result.license });
    }).catch(() => {});
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      const normalized = licenseKey.trim().toUpperCase();
      const result = await activateLicense(normalized, getInstallationId(), installationName.trim() || "Taskosphere Installation");
      localStorage.setItem(KEY_STORAGE, normalized);
      localStorage.setItem(NAME_STORAGE, installationName.trim() || "Taskosphere Installation");
      setLicenseKey(normalized);
      setStatus({ ok: true, message: "Taskosphere activated successfully.", license: result.license });
    } catch (error) {
      setStatus({ ok: false, message: error?.response?.data?.detail || error?.message || "Unable to activate this license." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-950 p-5">
      <div className="w-full max-w-lg rounded-3xl bg-white p-7 shadow-2xl">
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100"><ShieldCheck size={24} /></div>
        <h1 className="mt-5 text-2xl font-bold text-slate-950">Activate Taskosphere</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">Enter the commercial license number supplied by your Taskosphere provider. Activation is checked against the central license server.</p>

        <form onSubmit={submit} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-slate-700">License Number
            <div className="relative mt-1.5"><KeyRound size={17} className="absolute left-3 top-3 text-slate-400" /><input required value={licenseKey} onChange={(e) => setLicenseKey(e.target.value)} placeholder="TSO-XXXX-XXXX-XXXX-XXXX" className="w-full rounded-xl border border-slate-200 px-3 py-2.5 pl-10 font-mono uppercase tracking-wider outline-none focus:border-slate-400" /></div>
          </label>
          <label className="block text-sm font-semibold text-slate-700">Installation Name
            <input value={installationName} onChange={(e) => setInstallationName(e.target.value)} placeholder="Company Taskosphere" className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-normal outline-none focus:border-slate-400" />
          </label>
          <button disabled={busy} className="w-full rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Activating…" : "Activate License"}</button>
        </form>

        {status && <div className={`mt-5 rounded-2xl border p-4 ${status.ok ? "border-emerald-200 bg-emerald-50" : "border-red-200 bg-red-50"}`}>
          <div className="flex gap-3">{status.ok ? <CheckCircle2 className="text-emerald-600" size={20} /> : <XCircle className="text-red-600" size={20} />}<div><p className="font-semibold text-slate-900">{status.message}</p>{status.license && <p className="mt-1 text-xs text-slate-600">{status.license.package_name} · {status.license.expires_at ? `Expires ${new Date(status.license.expires_at).toLocaleDateString("en-IN")}` : "Lifetime"}</p>}</div></div>
        </div>}

        <p className="mt-6 text-center text-xs text-slate-400">Installation ID: {getInstallationId()}</p>
      </div>
    </div>
  );
}
