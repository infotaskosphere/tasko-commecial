import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Globe2, KeyRound, LockKeyhole, ShieldCheck, Sparkles, Building2, UserPlus, CheckSquare2, UsersRound, FileText, BarChart3, CalendarDays, FolderOpen, Settings2, Receipt, Bot, ChevronLeft, ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";
import { lookupLicensedCompany, createLicensedAdmin } from "@/lib/licenseApi";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const spring = { type: "spring", stiffness: 280, damping: 26, mass: 0.9 };

const MODULES = [
  { title: "Task Management", subtitle: "Plan. Track. Deliver.", icon: CheckSquare2, tone: "blue" },
  { title: "Clients & CRM", subtitle: "Build stronger relationships.", icon: UsersRound, tone: "green" },
  { title: "Invoicing", subtitle: "Create. Share. Get paid.", icon: Receipt, tone: "orange" },
  { title: "Accounting", subtitle: "Simple. Accurate. Compliant.", icon: BarChart3, tone: "purple" },
  { title: "HRMS", subtitle: "Your team. Your strength.", icon: UsersRound, tone: "cyan" },
  { title: "Compliance", subtitle: "Never miss a due date.", icon: CalendarDays, tone: "pink" },
  { title: "Documents", subtitle: "Store. Organise. Access.", icon: FolderOpen, tone: "indigo" },
  { title: "Reports & Insights", subtitle: "Make smarter decisions.", icon: FileText, tone: "sky" },
  { title: "Settings & Control", subtitle: "Customise for your business.", icon: Settings2, tone: "teal" },
  { title: "Intelligence", subtitle: "Work smarter with automation.", icon: Bot, tone: "violet" },
];

const TONES = {
  blue: "bg-blue-50 text-blue-600 border-blue-100",
  green: "bg-emerald-50 text-emerald-600 border-emerald-100",
  orange: "bg-orange-50 text-orange-600 border-orange-100",
  purple: "bg-violet-50 text-violet-600 border-violet-100",
  cyan: "bg-cyan-50 text-cyan-600 border-cyan-100",
  pink: "bg-pink-50 text-pink-600 border-pink-100",
  indigo: "bg-indigo-50 text-indigo-600 border-indigo-100",
  sky: "bg-sky-50 text-sky-600 border-sky-100",
  teal: "bg-teal-50 text-teal-600 border-teal-100",
  violet: "bg-fuchsia-50 text-fuchsia-600 border-fuchsia-100",
};

export default function Login() {
  const { login, refreshUser } = useAuth();
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
  const railRef = useRef(null);

  useEffect(() => { getPublicWebsiteConfig().then(setConfig).catch(() => setConfig(null)); }, []);
  useEffect(() => {
    if (!serverWaking) return;
    const timer = setInterval(() => setWakingDots((value) => value.length >= 3 ? "" : `${value}.`), 450);
    return () => clearInterval(timer);
  }, [serverWaking]);

  const siteName = "OneNexa";
  const logo = "/onenexa-logo.svg";
  const primary = "#0B2B61";
  const accent = "#08BDE8";
  const backgroundImage = config?.login_background_image;

  const scrollModules = (direction) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollBy({ left: direction * Math.max(300, rail.clientWidth * 0.65), behavior: "smooth" });
  };

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
      const authoritativeUser = await refreshUser();
      if (!authoritativeUser) throw new Error("Unable to load licensed access");
      try { window.postMessage({ type: "SET_TOKEN", token: response.data.access_token }, window.location.origin); } catch {}
      toast.success("Welcome back!");
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
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to create the admin account.");
    } finally { setLookupBusy(false); }
  };

  const pageStyle = backgroundImage
    ? { backgroundImage: `linear-gradient(120deg, rgba(245,251,255,.90), rgba(238,250,250,.92)), url(${backgroundImage})`, backgroundPosition: "center", backgroundSize: "cover" }
    : { background: "radial-gradient(circle at 8% 8%, rgba(8,189,232,.12), transparent 28%), radial-gradient(circle at 76% 0%, rgba(37,99,235,.11), transparent 28%), radial-gradient(circle at 20% 100%, rgba(16,185,129,.12), transparent 30%), linear-gradient(135deg, #f7fbff 0%, #f4fbfb 46%, #f5f8ff 100%)" };

  const duplicatedModules = useMemo(() => [...MODULES, ...MODULES], []);

  return (
    <div className="min-h-screen overflow-x-hidden text-slate-900" style={pageStyle}>
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-32 -top-32 h-80 w-80 rounded-full bg-cyan-200/20 blur-3xl" />
        <div className="absolute right-[28%] top-[-12rem] h-96 w-96 rounded-full bg-blue-200/20 blur-3xl" />
        <div className="absolute bottom-[-10rem] left-[18%] h-96 w-96 rounded-full bg-emerald-200/15 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-[1680px] flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_520px]">
        <main className="flex min-w-0 flex-1 flex-col px-6 pb-8 pt-6 sm:px-10 lg:px-14 lg:py-8 xl:px-20">
          <header className="flex items-center justify-between gap-4">
            <Link to="/" className="inline-flex items-center">
              <img src={logo} alt={siteName} className="h-12 w-auto max-w-[260px] object-contain sm:h-14" />
            </Link>
            <Link to="/" className="hidden items-center gap-2 text-sm font-semibold text-slate-500 transition hover:text-[#0B2B61] sm:inline-flex">
              <Globe2 size={15} /> Explore OneNexa
            </Link>
          </header>

          <div className="flex flex-1 flex-col justify-center py-10 lg:py-6">
            <div className="max-w-4xl">
              <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-blue-100 bg-white/75 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[#174a91] shadow-sm backdrop-blur">
                <Sparkles size={14} className="text-cyan-500" />
                {config?.hero_badge || "The modern business operating system"}
              </div>
              <h1 className="max-w-4xl text-4xl font-black leading-[1.04] tracking-[-0.04em] text-[#102f62] sm:text-5xl xl:text-[4.25rem]">
                {config?.hero_title || <>Everything your business needs.<br /><span className="bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500 bg-clip-text text-transparent">Nothing scattered.</span></>}
              </h1>
              <p className="mt-5 max-w-3xl text-base leading-7 text-slate-600 sm:text-lg">
                {config?.hero_subtitle || "Task management, invoicing, accounting, HRMS, records, compliance and intelligent automation — connected in one workspace."}
              </p>
            </div>

            <section className="mt-9 min-w-0" aria-label="OneNexa modules">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-slate-400">Everything connected</p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">One platform. Every business function.</p>
                </div>
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => scrollModules(-1)} aria-label="Previous modules" className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/85 text-slate-500 shadow-sm transition hover:border-blue-200 hover:text-blue-600"><ChevronLeft size={17} /></button>
                  <button type="button" onClick={() => scrollModules(1)} aria-label="Next modules" className="flex h-9 w-9 items-center justify-center rounded-full border border-slate-200 bg-white/85 text-slate-500 shadow-sm transition hover:border-blue-200 hover:text-blue-600"><ChevronRight size={17} /></button>
                </div>
              </div>
              <div ref={railRef} className="flex gap-3 overflow-x-auto pb-3 pr-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden snap-x snap-mandatory">
                {duplicatedModules.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <motion.article key={`${item.title}-${index}`} whileHover={{ y: -3 }} className="w-[168px] min-w-[168px] snap-start rounded-2xl border border-white/90 bg-white/80 p-4 shadow-[0_12px_30px_rgba(15,23,42,.07)] backdrop-blur sm:w-[185px] sm:min-w-[185px]">
                      <div className={`mb-5 flex h-11 w-11 items-center justify-center rounded-xl border ${TONES[item.tone]}`}>
                        <Icon size={21} strokeWidth={2.1} />
                      </div>
                      <h3 className="text-sm font-extrabold leading-5 text-[#153a6b]">{item.title}</h3>
                      <p className="mt-1.5 text-[11px] leading-4 text-slate-500">{item.subtitle}</p>
                    </motion.article>
                  );
                })}
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="h-1.5 w-7 rounded-full bg-blue-500" />
                <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                <span className="text-[10px] font-semibold text-slate-400">Scroll to explore</span>
              </div>
            </section>

            <div className="mt-8 grid max-w-4xl grid-cols-1 gap-3 sm:grid-cols-3">
              {[
                { title: "Secure & Reliable", text: "Enterprise-grade access", icon: ShieldCheck, tone: "text-blue-600 bg-blue-50" },
                { title: "Save Time", text: "Automate routine work", icon: Sparkles, tone: "text-emerald-600 bg-emerald-50" },
                { title: "Grow Faster", text: "All tools in one place", icon: BarChart3, tone: "text-violet-600 bg-violet-50" },
              ].map(({ title, text, icon: Icon, tone }) => (
                <div key={title} className="flex items-center gap-3 rounded-2xl border border-white/80 bg-white/55 px-4 py-3 backdrop-blur">
                  <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon size={18} /></div>
                  <div><p className="text-xs font-extrabold text-[#163b6e]">{title}</p><p className="mt-0.5 text-[11px] text-slate-500">{text}</p></div>
                </div>
              ))}
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-200/70 pt-5 text-xs text-slate-400">
            <div className="flex items-center gap-5">
              <span><strong className="text-lg text-[#163b6e]">500+</strong> businesses</span>
              <span className="hidden h-5 w-px bg-slate-200 sm:block" />
              <span><strong className="text-lg text-[#163b6e]">99.9%</strong> reliability</span>
              <span className="hidden h-5 w-px bg-slate-200 sm:block" />
              <span><strong className="text-lg text-[#163b6e]">24/7</strong> support</span>
            </div>
            <span>{config?.footer_copyright || `© 2026 ${siteName}`}</span>
          </footer>
        </main>

        <aside className="relative flex min-w-0 flex-col border-t border-slate-200/70 bg-white/65 px-5 py-6 backdrop-blur-xl sm:px-10 lg:border-l lg:border-t-0 lg:px-10 lg:py-8 xl:px-14">
          <div className="flex justify-end">
            <Link to="/" className="rounded-xl border border-blue-200 bg-white px-4 py-2.5 text-xs font-bold text-blue-600 shadow-sm transition hover:bg-blue-50">Request a Demo</Link>
          </div>

          <div className="flex flex-1 items-center justify-center py-7">
            <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[470px] rounded-[28px] border border-slate-200/80 bg-white p-6 shadow-[0_30px_80px_rgba(15,23,42,.13)] sm:p-9">
              <div className="mb-7 text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600"><LockKeyhole size={22} /></div>
                <h2 className="text-3xl font-black tracking-[-0.03em] text-[#102f62]">{mode === "signin" ? (config?.login_title || "Welcome back") : "I Have a License"}</h2>
                <p className="mt-2 text-sm leading-6 text-slate-500">{mode === "signin" ? (config?.login_subtitle || `Sign in to your ${siteName} account`) : "Verify your company license to create the first administrator account."}</p>
              </div>

              <div className="mb-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1">
                <button type="button" onClick={() => setMode("signin")} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${mode === "signin" ? "bg-white text-[#102f62] shadow-sm" : "text-slate-500"}`}>Sign in</button>
                <button type="button" onClick={() => setMode("license")} className={`rounded-lg px-3 py-2.5 text-sm font-bold transition ${mode === "license" ? "bg-white text-[#102f62] shadow-sm" : "text-slate-500"}`}>I have a license</button>
              </div>

              {mode === "signin" ? (
                <>
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Email address</span><Input autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-12 rounded-xl border-slate-200 bg-slate-50/60 px-4" /></label>
                    <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Password</span><div className="relative"><Input autoComplete="current-password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="h-12 rounded-xl border-slate-200 bg-slate-50/60 px-4 pr-11" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-3 text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label>
                    <div className="flex items-center justify-between gap-3 py-1"><label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600"><input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />Remember me</label><Link to="/forgot-password" className="text-sm font-bold text-blue-600 hover:text-blue-700">Forgot password?</Link></div>
                    <motion.button type="submit" disabled={loading} whileTap={{ scale: .985 }} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-white shadow-lg shadow-blue-500/15 disabled:opacity-60" style={{ background: "linear-gradient(135deg, #1769ff, #0ac6b5)" }}>{loading ? "Signing in…" : <>Sign in <ArrowRight size={17} /></>}</motion.button>
                  </form>

                  <AnimatePresence>{serverWaking && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 overflow-hidden"><div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">Server is waking up{wakingDots}. This may take a few seconds.</div></motion.div>}</AnimatePresence>

                  <div className="mt-6 flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50/80 p-4"><ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-600" /><div><p className="text-xs font-bold text-slate-800">Your workspace is protected</p><p className="mt-1 text-xs leading-5 text-slate-500">{config?.login_card_note || "Access is protected by the permissions assigned to your account."}</p></div></div>

                  <div className="mt-6 text-center text-sm text-slate-500">New to OneNexa? <Link to="/" className="font-bold text-blue-600">Request a Demo</Link></div>
                </>
              ) : (
                <>
                  {!licensedCustomer ? (
                    <form onSubmit={handleLookup} className="space-y-4">
                      <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Company name</span><div className="relative"><Building2 size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Registered company name" className="h-12 rounded-xl pl-10" /></div></label>
                      <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">License number</span><div className="relative"><KeyRound size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())} placeholder="TSO-XXXX-XXXX-XXXX-XXXX" className="h-12 rounded-xl pl-10 font-mono uppercase tracking-wider" /></div></label>
                      <button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#102f62] text-sm font-bold text-white shadow-lg shadow-slate-900/10 disabled:opacity-60">{lookupBusy ? "Verifying license…" : <>Verify & Load Company <ArrowRight size={17} /></>}</button>
                    </form>
                  ) : (
                    <form onSubmit={handleCreateAdmin} className="space-y-4">
                      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-start gap-3"><CheckCircle2 size={19} className="mt-0.5 text-emerald-600" /><div><p className="font-bold text-slate-900">License verified</p><p className="mt-1 text-xs text-slate-600">{licensedCustomer.customer.company_name} · {licensedCustomer.license?.package_name} · {licensedCustomer.license?.validity_months || "—"} months</p></div></div></div>
                      <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Auto-filled company details</p><div className="grid gap-3 text-sm sm:grid-cols-2"><div><span className="text-xs text-slate-400">Company</span><p className="font-semibold">{licensedCustomer.customer.company_name}</p></div><div><span className="text-xs text-slate-400">GSTIN</span><p className="font-semibold">{licensedCustomer.customer.gstin || "—"}</p></div><div><span className="text-xs text-slate-400">Email</span><p className="font-semibold">{licensedCustomer.customer.email || "—"}</p></div><div><span className="text-xs text-slate-400">Phone</span><p className="font-semibold">{licensedCustomer.customer.phone || "—"}</p></div><div className="sm:col-span-2"><span className="text-xs text-slate-400">Address</span><p className="font-semibold">{licensedCustomer.customer.gst_address || licensedCustomer.customer.address || "—"}</p></div></div></div>
                      <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Admin full name</span><Input required value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Owner / administrator name" className="h-12 rounded-xl" /></label>
                      <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Admin login email</span><Input required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="h-12 rounded-xl" /></label>
                      <label className="block"><span className="mb-1.5 block text-sm font-semibold text-slate-700">Create password</span><div className="relative"><Input required minLength={8} type={showAdminPassword ? "text" : "password"} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Minimum 8 characters" className="h-12 rounded-xl pr-11" /><button type="button" onClick={() => setShowAdminPassword((v) => !v)} className="absolute right-3 top-3 text-slate-400">{showAdminPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label>
                      <button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-white disabled:opacity-60" style={{ background: "linear-gradient(135deg, #1769ff, #0ac6b5)" }}>{lookupBusy ? "Creating admin workspace…" : <>Create Admin Login <UserPlus size={17} /></>}</button>
                      <button type="button" onClick={() => setLicensedCustomer(null)} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-900">Use a different license</button>
                    </form>
                  )}
                </>
              )}
            </motion.div>
          </div>

          <div className="flex items-center justify-center gap-3 pb-1 text-[10px] text-slate-400">
            <ShieldCheck size={14} /> Secure access · Privacy · Terms · Support
          </div>
        </aside>
      </div>
    </div>
  );
}
