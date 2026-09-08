import React, { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Globe2, KeyRound, LockKeyhole, ShieldCheck, Sparkles, Building2, UserPlus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";
import { lookupLicensedCompany, createLicensedAdmin } from "@/lib/licenseApi";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const spring = { type: "spring", stiffness: 280, damping: 26, mass: 0.9 };

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [config, setConfig] = useState(null);
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverWaking, setServerWaking] = useState(false);
  const [wakingDots, setWakingDots] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [licensedCustomer, setLicensedCustomer] = useState(null);
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);

  useEffect(() => { getPublicWebsiteConfig().then(setConfig).catch(() => setConfig(null)); }, []);
  useEffect(() => {
    if (!serverWaking) return;
    const timer = setInterval(() => setWakingDots((value) => value.length >= 3 ? "" : `${value}.`), 450);
    return () => clearInterval(timer);
  }, [serverWaking]);

  const siteName = config?.site_name || "Taskosphere";
  const logo = config?.logo_url || "/logo.png";
  const primary = config?.primary_color || "#0D3B66";
  const accent = config?.accent_color || "#1FAF5A";
  const backgroundImage = config?.login_background_image;

  const loginWithRetry = async () => {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { return await api.post("/auth/login", { email, password }); }
      catch (error) { lastError = error; if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200)); }
    }
    throw lastError;
  };

  const handleSubmit = async (event) => {
    event?.preventDefault();
    if (!email || !password) { toast.error("Please enter your email and password."); return; }
    setLoading(true);
    const wakingTimer = setTimeout(() => setServerWaking(true), 2500);
    try {
      const response = await loginWithRetry();
      clearTimeout(wakingTimer);
      setServerWaking(false);
      if (keepSignedIn) localStorage.setItem("taskosphere_keep_signed_in", "true"); else localStorage.removeItem("taskosphere_keep_signed_in");
      const authenticated = login(response.data, keepSignedIn);
      if (!authenticated) throw new Error("Invalid login response");
      try { window.postMessage({ type: "SET_TOKEN", token: response.data.access_token }, window.location.origin); } catch {}
      toast.success("Welcome back!");
      navigate("/dashboard", { replace: true });
    } catch (error) {
      clearTimeout(wakingTimer); setServerWaking(false);
      toast.error(error?.response?.data?.detail || "Unable to sign in. Please check your credentials.");
    } finally { setLoading(false); }
  };

  const handleLookup = async (event) => {
    event?.preventDefault();
    if (!companyName.trim() || !licenseKey.trim()) { toast.error("Enter your company name and license number."); return; }
    setLookupBusy(true);
    try {
      const result = await lookupLicensedCompany(companyName.trim(), licenseKey.trim().toUpperCase());
      setLicensedCustomer(result);
      setCompanyName(result.customer?.company_name || companyName.trim());
      setAdminEmail(result.customer?.email || "");
      toast.success("License verified. Company details loaded.");
    } catch (error) {
      setLicensedCustomer(null);
      toast.error(error?.response?.data?.detail || "We could not verify this company and license.");
    } finally { setLookupBusy(false); }
  };

  const handleCreateAdmin = async (event) => {
    event.preventDefault();
    if (!licensedCustomer) { toast.error("Verify your license first."); return; }
    setLookupBusy(true);
    try {
      const result = await createLicensedAdmin({ company_name: licensedCustomer.customer.company_name, license_key: licenseKey.trim().toUpperCase(), full_name: adminName, email: adminEmail, password: adminPassword });
      login(result, true);
      try { window.postMessage({ type: "SET_TOKEN", token: result.access_token }, window.location.origin); } catch {}
      toast.success("Admin account created. Your workspace is ready.");
      navigate("/dashboard", { replace: true });
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to create the admin account.");
    } finally { setLookupBusy(false); }
  };

  const pageStyle = backgroundImage
    ? { backgroundImage: `linear-gradient(120deg, rgba(4,34,31,.78), rgba(8,65,105,.82)), url(${backgroundImage})`, backgroundPosition: "center", backgroundSize: "cover" }
    : { background: "radial-gradient(circle at 4% 8%, rgba(34,197,94,.34) 0, rgba(34,197,94,0) 27%), radial-gradient(circle at 96% 8%, rgba(37,99,235,.34) 0, rgba(37,99,235,0) 30%), radial-gradient(circle at 82% 82%, rgba(14,165,233,.30) 0, rgba(14,165,233,0) 31%), radial-gradient(circle at 10% 94%, rgba(16,185,129,.34) 0, rgba(16,185,129,0) 35%), linear-gradient(135deg, #e8f9f0 0%, #e8f7f8 38%, #e9f3ff 72%, #dff1ff 100%)" };

  return <div className="min-h-screen" style={pageStyle}>
    <div className="mx-auto grid min-h-screen max-w-[1500px] lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden flex-col justify-between p-10 text-slate-800 lg:flex xl:p-14">
        <div><Link to="/" className="inline-flex items-center gap-3"><img src={logo} alt={siteName} className="h-12 w-auto rounded-lg object-contain" /><span className="text-lg font-bold tracking-tight text-[#173f70]">{siteName}</span></Link></div>
        <div className="max-w-xl"><div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/70 bg-white/45 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#173f70] shadow-sm backdrop-blur"><Sparkles size={14} /> {config?.hero_badge || "Business operating system"}</div><h1 className="text-5xl font-black leading-[1.04] tracking-tight text-[#123b69] xl:text-6xl">{config?.hero_title || "One workspace. Every business operation."}</h1><p className="mt-6 max-w-lg text-lg leading-8 text-slate-600">{config?.hero_subtitle || "Manage work, finance, people and compliance from one connected platform."}</p><div className="mt-8 grid gap-3 sm:grid-cols-2">{["Modular commercial packages", "Permission-aware workspaces", "Centralised customer control", "Built for daily operations"].map((item) => <div key={item} className="flex items-center gap-2 text-sm font-semibold text-slate-600"><CheckCircle2 size={17} style={{ color: accent }} />{item}</div>)}</div></div>
        <div className="text-xs text-slate-400">{config?.footer_copyright || `© 2026 ${siteName}`}</div>
      </section>

      <section className="flex items-center justify-center px-4 py-8 sm:px-8 lg:px-10">
        <motion.div initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[520px] rounded-[2rem] border border-white/80 bg-white/95 p-6 shadow-[0_30px_80px_rgba(15,23,42,.18)] backdrop-blur-xl sm:p-9">
          <div className="mb-8 lg:hidden"><Link to="/" className="flex items-center gap-3"><img src={logo} alt={siteName} className="h-10 w-auto object-contain" /><span className="font-bold text-slate-900">{siteName}</span></Link></div>
          <div className="mb-6"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: `${accent}16`, color: accent }}>{mode === "signin" ? <LockKeyhole size={22} /> : <KeyRound size={22} />}</div><h2 className="text-3xl font-black tracking-tight text-slate-950">{mode === "signin" ? (config?.login_title || "Welcome Back") : "I Have a License"}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{mode === "signin" ? (config?.login_subtitle || `Sign in to your ${siteName} workspace.`) : "Enter the company name and license supplied by Taskosphere. Your registered company details will be loaded automatically."}</p></div>

          <div className="mb-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1"><button type="button" onClick={() => setMode("signin")} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${mode === "signin" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}>Sign in</button><button type="button" onClick={() => setMode("license")} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${mode === "license" ? "bg-white text-slate-950 shadow-sm" : "text-slate-500"}`}>I have a license</button></div>

          {mode === "signin" ? <>
            <form onSubmit={handleSubmit} className="space-y-4"><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Work email</span><Input autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-12 rounded-xl border-slate-200 bg-slate-50/70" /></label><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Password</span><div className="relative"><Input autoComplete="current-password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="h-12 rounded-xl border-slate-200 bg-slate-50/70 pr-11" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-3 text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label><div className="flex items-center justify-between gap-3 py-1"><label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600"><input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />Keep me signed in</label><Link to="/forgot-password" className="text-sm font-semibold" style={{ color: primary }}>Forgot password?</Link></div><motion.button type="submit" disabled={loading} whileTap={{ scale: .985 }} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-white shadow-lg disabled:opacity-60" style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}>{loading ? "Signing in…" : <>Sign in <ArrowRight size={17} /></>}</motion.button></form>
            <AnimatePresence>{serverWaking && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 overflow-hidden"><div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">Server is waking up{wakingDots}. This may take a few seconds.</div></motion.div>}</AnimatePresence>
            <div className="mt-7 flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4"><ShieldCheck size={18} className="mt-0.5 shrink-0" style={{ color: accent }} /><div><p className="text-xs font-bold text-slate-800">Secure workspace access</p><p className="mt-1 text-xs leading-5 text-slate-500">{config?.login_card_note || "Your access is protected by the permissions assigned to your account."}</p></div></div>
          </> : <>
            {!licensedCustomer ? <form onSubmit={handleLookup} className="space-y-4"><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Company name</span><div className="relative"><Building2 size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Registered company name" className="h-12 rounded-xl pl-10" /></div></label><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">License number</span><div className="relative"><KeyRound size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())} placeholder="TSO-XXXX-XXXX-XXXX-XXXX" className="h-12 rounded-xl pl-10 font-mono uppercase tracking-wider" /></div></label><button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-slate-950 text-sm font-bold text-white disabled:opacity-60">{lookupBusy ? "Verifying license…" : <>Verify & Load Company <ArrowRight size={17} /></>}</button></form> : <form onSubmit={handleCreateAdmin} className="space-y-4"><div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-start gap-3"><CheckCircle2 size={19} className="mt-0.5 text-emerald-600" /><div><p className="font-bold text-slate-900">License verified</p><p className="mt-1 text-xs text-slate-600">{licensedCustomer.customer.company_name} · {licensedCustomer.license?.package_name} · {licensedCustomer.license?.validity_months || "—"} months</p></div></div></div><div className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Auto-filled company details</p><div className="grid gap-3 sm:grid-cols-2 text-sm"><div><span className="text-xs text-slate-400">Company</span><p className="font-semibold">{licensedCustomer.customer.company_name}</p></div><div><span className="text-xs text-slate-400">GSTIN</span><p className="font-semibold">{licensedCustomer.customer.gstin || "—"}</p></div><div><span className="text-xs text-slate-400">Email</span><p className="font-semibold">{licensedCustomer.customer.email || "—"}</p></div><div><span className="text-xs text-slate-400">Phone</span><p className="font-semibold">{licensedCustomer.customer.phone || "—"}</p></div><div className="sm:col-span-2"><span className="text-xs text-slate-400">Address</span><p className="font-semibold">{licensedCustomer.customer.gst_address || licensedCustomer.customer.address || "—"}</p></div></div></div><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Admin full name</span><Input required value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Owner / administrator name" className="h-12 rounded-xl" /></label><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Admin login email</span><Input required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="h-12 rounded-xl" /></label><label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Create password</span><div className="relative"><Input required minLength={8} type={showAdminPassword ? "text" : "password"} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Minimum 8 characters" className="h-12 rounded-xl pr-11" /><button type="button" onClick={() => setShowAdminPassword((v) => !v)} className="absolute right-3 top-3 text-slate-400">{showAdminPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label><button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-white disabled:opacity-60" style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}>{lookupBusy ? "Creating admin workspace…" : <>Create Admin Login <UserPlus size={17} /></>}</button><button type="button" onClick={() => setLicensedCustomer(null)} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-900">Use a different license</button></form>}
          </>}

          {config?.login_show_website_link !== false && <div className="mt-6 flex flex-wrap items-center justify-center gap-4 text-sm"><Link to="/" className="inline-flex items-center gap-1.5 font-semibold text-slate-500 hover:text-slate-900"><Globe2 size={15} />{config?.login_website_link_text || "Visit website"}</Link><span className="text-slate-300">•</span><Link to="/register" className="font-bold" style={{ color: accent }}>Create account</Link></div>}
        </motion.div>
      </section>
    </div>
  </div>;
}
