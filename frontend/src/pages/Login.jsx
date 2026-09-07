import React, { useEffect, useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Globe2, LockKeyhole, ShieldCheck, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { useAuth } from "@/contexts/AuthContext";
import api from "@/lib/api";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

const spring = { type: "spring", stiffness: 280, damping: 26, mass: 0.9 };

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [config, setConfig] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [keepSignedIn, setKeepSignedIn] = useState(false);
  const [loading, setLoading] = useState(false);
  const [serverWaking, setServerWaking] = useState(false);
  const [wakingDots, setWakingDots] = useState("");

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
      clearTimeout(wakingTimer);
      setServerWaking(false);
      toast.error(error?.response?.data?.detail || "Unable to sign in. Please check your credentials.");
    } finally { setLoading(false); }
  };

  const pageStyle = backgroundImage
    ? { backgroundImage: `linear-gradient(120deg, rgba(5,18,31,.96), rgba(13,59,102,.86)), url(${backgroundImage})`, backgroundPosition: "center", backgroundSize: "cover" }
    : { background: `radial-gradient(circle at 15% 20%, ${accent}22, transparent 30%), radial-gradient(circle at 85% 80%, #38bdf822, transparent 32%), linear-gradient(135deg, #f8fafc, #eef6f7)` };

  return <div className="min-h-screen" style={pageStyle}>
    <div className="mx-auto grid min-h-screen max-w-[1500px] lg:grid-cols-[1.05fr_.95fr]">
      <section className="hidden flex-col justify-between p-10 text-white lg:flex xl:p-14">
        <div><Link to="/" className="inline-flex items-center gap-3"><img src={logo} alt={siteName} className="h-12 w-auto rounded-lg object-contain" /><span className="text-lg font-bold tracking-tight">{siteName}</span></Link></div>
        <div className="max-w-xl">
          <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/75"><Sparkles size={14} /> {config?.hero_badge || "Business operating system"}</div>
          <h1 className="text-5xl font-black leading-[1.04] tracking-tight xl:text-6xl">{config?.hero_title || "One workspace. Every business operation."}</h1>
          <p className="mt-6 max-w-lg text-lg leading-8 text-white/65">{config?.hero_subtitle || "Manage work, finance, people and compliance from one connected platform."}</p>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">{["Modular commercial packages", "Permission-aware workspaces", "Centralised customer control", "Built for daily operations"].map((item) => <div key={item} className="flex items-center gap-2 text-sm text-white/75"><CheckCircle2 size={17} style={{ color: accent }} />{item}</div>)}</div>
        </div>
        <div className="text-xs text-white/35">{config?.footer_copyright || `© 2026 ${siteName}`}</div>
      </section>

      <section className="flex items-center justify-center px-4 py-8 sm:px-8 lg:px-10">
        <motion.div initial={{ opacity: 0, y: 22 }} animate={{ opacity: 1, y: 0 }} transition={spring} className="w-full max-w-[480px] rounded-[2rem] border border-white/70 bg-white/95 p-6 shadow-[0_30px_80px_rgba(15,23,42,.18)] backdrop-blur-xl sm:p-9">
          <div className="mb-8 lg:hidden"><Link to="/" className="flex items-center gap-3"><img src={logo} alt={siteName} className="h-10 w-auto object-contain" /><span className="font-bold text-slate-900">{siteName}</span></Link></div>
          <div className="mb-8"><div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: `${accent}16`, color: accent }}><LockKeyhole size={22} /></div><h2 className="text-3xl font-black tracking-tight text-slate-950">{config?.login_title || "Welcome Back"}</h2><p className="mt-2 text-sm leading-6 text-slate-500">{config?.login_subtitle || `Sign in to your ${siteName} workspace.`}</p></div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Work email</span><Input autoComplete="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="h-12 rounded-xl border-slate-200 bg-slate-50/70" /></label>
            <label className="block"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">Password</span><div className="relative"><Input autoComplete="current-password" type={showPassword ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" className="h-12 rounded-xl border-slate-200 bg-slate-50/70 pr-11" /><button type="button" onClick={() => setShowPassword((value) => !value)} className="absolute right-3 top-3 text-slate-400 hover:text-slate-700">{showPassword ? <EyeOff size={19} /> : <Eye size={19} />}</button></div></label>

            <div className="flex items-center justify-between gap-3 py-1"><label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-600"><input type="checkbox" checked={keepSignedIn} onChange={(e) => setKeepSignedIn(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />Keep me signed in</label><Link to="/forgot-password" className="text-sm font-semibold" style={{ color: primary }}>Forgot password?</Link></div>

            <motion.button type="submit" disabled={loading} whileTap={{ scale: .985 }} className="flex h-12 w-full items-center justify-center gap-2 rounded-xl text-sm font-bold text-white shadow-lg disabled:opacity-60" style={{ background: `linear-gradient(135deg, ${primary}, ${accent})` }}>{loading ? "Signing in…" : <>Sign in <ArrowRight size={17} /></>}</motion.button>
          </form>

          <AnimatePresence>{serverWaking && <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-4 overflow-hidden"><div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800">Server is waking up{wakingDots}. This may take a few seconds.</div></motion.div>}</AnimatePresence>

          <div className="mt-7 flex items-start gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-4"><ShieldCheck size={18} className="mt-0.5 shrink-0" style={{ color: accent }} /><div><p className="text-xs font-bold text-slate-800">Secure workspace access</p><p className="mt-1 text-xs leading-5 text-slate-500">{config?.login_card_note || "Your access is protected by the permissions assigned to your account."}</p></div></div>

          {config?.login_show_website_link !== false && <div className="mt-6 flex items-center justify-center gap-4 text-sm"><Link to="/" className="inline-flex items-center gap-1.5 font-semibold text-slate-500 hover:text-slate-900"><Globe2 size={15} />{config?.login_website_link_text || "Visit website"}</Link><span className="text-slate-300">•</span><span className="text-slate-400">New customer? <Link to="/register" className="font-bold" style={{ color: accent }}>Create account</Link></span></div>}
        </motion.div>
      </section>
    </div>
  </div>;
}
