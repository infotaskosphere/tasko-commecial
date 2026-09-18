import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Globe2, KeyRound, LockKeyhole, ShieldCheck, Sparkles, Building2, UserPlus, CheckSquare2, UsersRound, FileText, BarChart3, CalendarDays, FolderOpen, Receipt, Bot, ChevronLeft, ChevronRight } from "lucide-react";
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
    return (
    <div className="min-h-screen overflow-x-hidden bg-[#f5f8fc] text-slate-900">
      <div className="mx-auto flex min-h-screen w-full max-w-[1600px] flex-col">
        <header className="flex h-[78px] shrink-0 items-center justify-between border-b border-slate-200/80 bg-white/95 px-6 sm:px-10 lg:px-12">
          <Link to="/" className="inline-flex items-center">
            <img src={logo} alt={siteName} className="h-12 w-auto max-w-[220px] object-contain" />
          </Link>
          <div className="flex items-center gap-5">
            <Link to="/" className="hidden items-center gap-2 text-sm font-semibold text-slate-500 transition hover:text-[#102f62] sm:inline-flex">
              <Globe2 size={15} /> Explore ONENEXA
            </Link>
            <Link to="/" className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs font-bold text-[#102f62] shadow-sm transition hover:border-slate-300 hover:bg-slate-50">
              Request a demo
            </Link>
          </div>
        </header>

        <div className="grid flex-1 lg:grid-cols-[minmax(0,1fr)_440px]">
          <main className="relative overflow-hidden px-6 py-10 sm:px-10 lg:px-14 lg:py-14 xl:px-16">
            <div className="pointer-events-none absolute -left-24 top-20 h-72 w-72 rounded-full bg-cyan-200/30 blur-3xl" />
            <div className="pointer-events-none absolute right-10 top-0 h-80 w-80 rounded-full bg-blue-200/25 blur-3xl" />

            <div className="relative mx-auto flex h-full max-w-[940px] flex-col justify-center">
              <div className="max-w-3xl">
                <div className="inline-flex items-center gap-2 border-l-2 border-cyan-500 pl-3 text-[11px] font-bold uppercase tracking-[.22em] text-[#174a91]">
                  <Sparkles size={14} className="text-cyan-500" />
                  {config?.hero_badge || "The modern business operating system"}
                </div>
                <h1 className="mt-5 max-w-4xl text-5xl font-black leading-[.98] tracking-[-.055em] text-[#102f62] sm:text-6xl xl:text-[4.65rem]">
                  {config?.hero_title || <>Everything your business needs.<br /><span className="bg-gradient-to-r from-[#1769ff] via-[#08a9c9] to-[#16b77a] bg-clip-text text-transparent">Nothing scattered.</span></>}
                </h1>
                <p className="mt-6 max-w-2xl text-base leading-7 text-slate-600 sm:text-lg">
                  {config?.hero_subtitle || "Task management, finance, people, compliance and business operations — connected in one intelligent workspace."}
                </p>
              </div>

              <div className="mt-10 border-y border-slate-200/80 py-7">
                <div className="flex items-end justify-between gap-6">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[.2em] text-slate-400">The ONENEXA product suite</p>
                    <p className="mt-1 text-sm font-semibold text-slate-700">Purpose-built products. One connected ecosystem.</p>
                  </div>
                </div>
                <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                  {[
                    { name: "Taskosphere", logo: "/logo-transparent.png", text: "Tasks" },
                    { name: "Finix", logo: "/finix-logo.png", text: "Accounting" },
                    { name: "People Matrix", logo: "/people-matrix-logo.png", text: "People" },
                    { name: "CompliGenie", logo: "/compligenie-logo.png", text: "Compliance" },
                    { name: "LeadSense", logo: "/leadsense-logo.png", text: "Growth" },
                    { name: "ONENEXA", logo: "/onenexa-logo.png", text: "Platform" },
                  ].map((product) => (
                    <div key={product.name} className="group min-w-0 border border-slate-200 bg-white p-3.5 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-[0_12px_30px_rgba(15,23,42,.07)]">
                      <div className="flex h-14 items-center justify-center border-b border-slate-100 pb-2">
                        <img src={product.logo} alt={product.name} className="max-h-10 max-w-[112px] object-contain" loading="lazy" />
                      </div>
                      <div className="pt-2.5">
                        <p className="truncate text-[11px] font-extrabold text-[#173c70]">{product.name}</p>
                        <p className="mt-0.5 text-[10px] text-slate-400">{product.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-7 grid gap-4 sm:grid-cols-3">
                {[
                  { icon: ShieldCheck, title: "Controlled", text: "Permissions and records stay organised." },
                  { icon: Sparkles, title: "Connected", text: "Business functions work from one workspace." },
                  { icon: BarChart3, title: "Visible", text: "Teams and operations stay measurable." },
                ].map(({ icon: Icon, title, text }) => (
                  <div key={title} className="flex gap-3">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white text-[#1769ff] shadow-sm ring-1 ring-slate-200">
                      <Icon size={15} />
                    </div>
                    <div>
                      <p className="text-xs font-extrabold text-[#173c70]">{title}</p>
                      <p className="mt-1 text-[11px] leading-4 text-slate-500">{text}</p>
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-2 text-[10px] font-semibold text-slate-400">
                <span><strong className="text-sm text-[#163b6e]">500+</strong> businesses</span>
                <span><strong className="text-sm text-[#163b6e]">99.9%</strong> reliability</span>
                <span><strong className="text-sm text-[#163b6e]">24/7</strong> support</span>
                <span>© 2026 ONENEXA</span>
              </div>
            </div>
          </main>

          <aside className="border-t border-slate-200 bg-white lg:border-l lg:border-t-0">
            <div className="flex min-h-full flex-col px-6 py-8 sm:px-10 lg:px-9 lg:py-12">
              <div className="my-auto">
                <div className="mb-7">
                  <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl bg-[#eef5ff] text-[#1769ff]">
                    <LockKeyhole size={20} />
                  </div>
                  <h2 className="text-3xl font-black tracking-[-.04em] text-[#102f62]">
                    {mode === "signin" ? "Welcome back." : "Activate your workspace."}
                  </h2>
                  <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                    {mode === "signin" ? "Sign in to continue to your ONENEXA workspace." : "Verify your license and create the first administrator account."}
                  </p>
                </div>

                <div className="mb-7 flex border-b border-slate-200">
                  <button type="button" onClick={() => setMode("signin")} className={`relative flex-1 pb-3 text-sm font-bold transition ${mode === "signin" ? "text-[#102f62]" : "text-slate-400"}`}>
                    Sign in
                    {mode === "signin" && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#1769ff]" />}
                  </button>
                  <button type="button" onClick={() => setMode("license")} className={`relative flex-1 pb-3 text-sm font-bold transition ${mode === "license" ? "text-[#102f62]" : "text-slate-400"}`}>
                    I have a license
                    {mode === "license" && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[#1769ff]" />}
                  </button>
                </div>

                {mode === "signin" ? (
                  <>
                    <form onSubmit={handleSubmit} className="space-y-5">
                      <label className="block">
                        <span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Email address</span>
                        <Input autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-12 rounded-lg border-slate-200 bg-slate-50 px-4 text-sm focus-visible:ring-2 focus-visible:ring-blue-100" />
                      </label>
                      <label className="block">
                        <span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Password</span>
                        <div className="relative">
                          <Input autoComplete="current-password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="h-12 rounded-lg border-slate-200 bg-slate-50 px-4 pr-11 text-sm focus-visible:ring-2 focus-visible:ring-blue-100" />
                          <button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-3 text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button>
                        </div>
                      </label>
                      <div className="flex items-center justify-between gap-3">
                        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-500">
                          <input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
                          Remember me
                        </label>
                        <Link to="/forgot-password" className="text-xs font-bold text-[#1769ff] hover:text-[#102f62]">Forgot password?</Link>
                      </div>
                      <motion.button type="submit" disabled={loading} whileTap={{ scale: .985 }} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#102f62] text-sm font-bold text-white transition hover:bg-[#0b2855] disabled:opacity-60">
                        {loading ? "Signing in…" : <>Sign in <ArrowRight size={17} /></>}
                      </motion.button>
                    </form>

                    <AnimatePresence>{serverWaking && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 overflow-hidden"><div className="border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">Server is waking up{wakingDots}. This may take a few seconds.</div></motion.div>}</AnimatePresence>

                    <div className="mt-7 border-t border-slate-200 pt-5">
                      <div className="flex items-start gap-3">
                        <ShieldCheck size={17} className="mt-0.5 shrink-0 text-emerald-600" />
                        <div>
                          <p className="text-xs font-bold text-slate-800">Secure workspace access</p>
                          <p className="mt-1 text-xs leading-5 text-slate-500">{config?.login_card_note || "Access is protected by the permissions assigned to your account."}</p>
                        </div>
                      </div>
                    </div>
                    <p className="mt-6 text-center text-xs text-slate-500">New to ONENEXA? <Link to="/" className="font-bold text-[#1769ff]">Request a demo</Link></p>
                  </>
                ) : (
                  <>
                    {!licensedCustomer ? (
                      <form onSubmit={handleLookup} className="space-y-5">
                        <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Company name</span><div className="relative"><Building2 size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Registered company name" className="h-12 rounded-lg pl-10" /></div></label>
                        <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">License number</span><div className="relative"><KeyRound size={17} className="absolute left-3 top-3.5 text-slate-400" /><Input value={licenseKey} onChange={(e) => setLicenseKey(e.target.value.toUpperCase())} placeholder="TSO-XXXX-XXXX-XXXX-XXXX" className="h-12 rounded-lg pl-10 font-mono uppercase tracking-wider" /></div></label>
                        <button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#102f62] text-sm font-bold text-white disabled:opacity-60">{lookupBusy ? "Verifying license…" : <>Verify & Load Company <ArrowRight size={17} /></>}</button>
                      </form>
                    ) : (
                      <form onSubmit={handleCreateAdmin} className="space-y-4">
                        <div className="border border-emerald-200 bg-emerald-50 p-4"><div className="flex items-start gap-3"><CheckCircle2 size={19} className="mt-0.5 text-emerald-600" /><div><p className="font-bold text-slate-900">License verified</p><p className="mt-1 text-xs text-slate-600">{licensedCustomer.customer.company_name} · {licensedCustomer.license?.package_name} · {licensedCustomer.license?.validity_months || "—"} months</p></div></div></div>
                        <div className="border border-slate-200 bg-slate-50 p-4"><p className="mb-3 text-xs font-bold uppercase tracking-wider text-slate-500">Company details</p><div className="grid gap-3 text-sm sm:grid-cols-2"><div><span className="text-xs text-slate-400">Company</span><p className="font-semibold">{licensedCustomer.customer.company_name}</p></div><div><span className="text-xs text-slate-400">GSTIN</span><p className="font-semibold">{licensedCustomer.customer.gstin || "—"}</p></div><div><span className="text-xs text-slate-400">Email</span><p className="font-semibold">{licensedCustomer.customer.email || "—"}</p></div><div><span className="text-xs text-slate-400">Phone</span><p className="font-semibold">{licensedCustomer.customer.phone || "—"}</p></div><div className="sm:col-span-2"><span className="text-xs text-slate-400">Address</span><p className="font-semibold">{licensedCustomer.customer.gst_address || licensedCustomer.customer.address || "—"}</p></div></div></div>
                        <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Admin full name</span><Input required value={adminName} onChange={(e) => setAdminName(e.target.value)} placeholder="Owner / administrator name" className="h-12 rounded-lg" /></label>
                        <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Admin login email</span><Input required type="email" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className="h-12 rounded-lg" /></label>
                        <label className="block"><span className="mb-2 block text-xs font-bold uppercase tracking-wide text-slate-500">Create password</span><div className="relative"><Input required minLength={8} type={showAdminPassword ? "text" : "password"} value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} placeholder="Minimum 8 characters" className="h-12 rounded-lg pr-11" /><button type="button" onClick={() => setShowAdminPassword((v) => !v)} className="absolute right-3 top-3 text-slate-400">{showAdminPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label>
                        <button type="submit" disabled={lookupBusy} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-[#102f62] text-sm font-bold text-white disabled:opacity-60">{lookupBusy ? "Creating admin workspace…" : <>Create Admin Login <UserPlus size={17} /></>}</button>
                        <button type="button" onClick={() => setLicensedCustomer(null)} className="w-full text-xs font-semibold text-slate-500 hover:text-slate-900">Use a different license</button>
                      </form>
                    )}
                  </>
                )}
              </div>

              <div className="mt-10 flex items-center justify-center gap-3 text-[10px] text-slate-400">
                <ShieldCheck size={13} /> Secure access · Privacy · Terms · Support
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
