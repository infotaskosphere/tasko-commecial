import React, { useEffect, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Landmark, Receipt, Shield, Sparkles, Users, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";

const iconMap = { check: CheckCircle2, receipt: Receipt, landmark: Landmark, users: Users, shield: Shield, sparkles: Sparkles, zap: Zap };

function safeHref(href) {
  const value = String(href || "#").trim();
  if (value.startsWith("/") || value.startsWith("#") || /^https?:\/\//i.test(value)) return value;
  return "#";
}

export default function WebsiteHome() {
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    getPublicWebsiteConfig().then(setConfig).catch(() => setError(true));
  }, []);

  if (!config && !error) return <div className="min-h-screen bg-slate-950 text-white flex items-center justify-center">Loading website…</div>;
  if (!config) return <div className="min-h-screen flex items-center justify-center">Website configuration is unavailable.</div>;

  const primary = config.primary_color || "#0D3B66";
  const accent = config.accent_color || "#1FAF5A";
  const features = Array.isArray(config.features) ? config.features : [];
  const solutions = Array.isArray(config.solutions) ? config.solutions : [];
  const pricing = Array.isArray(config.pricing) ? config.pricing : [];
  const testimonials = Array.isArray(config.testimonials) ? config.testimonials : [];

  return (
    <div className="min-h-screen bg-white text-slate-900" style={{ "--primary": primary, "--accent": accent }}>
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
          <Link to="/" className="flex items-center gap-3">
            <img src={config.logo_url || "/logo.png"} alt={config.site_name} className="h-10 w-auto object-contain" />
            <div className="hidden sm:block"><div className="font-bold tracking-tight">{config.site_name}</div><div className="text-xs text-slate-500">{config.site_tagline}</div></div>
          </Link>
          <nav className="hidden items-center gap-7 lg:flex">
            {(config.nav_links || []).map((item) => <a key={`${item.label}-${item.href}`} href={safeHref(item.href)} className="text-sm font-medium text-slate-600 hover:text-slate-950">{item.label}</a>)}
          </nav>
          <Link to="/login" className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white shadow-sm" style={{ background: primary }}>Sign in</Link>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${primary} 0%, #102A43 58%, #061827 100%)` }}>
          <div className="absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
          <div className="absolute -bottom-40 left-1/3 h-96 w-96 rounded-full bg-emerald-400/10 blur-3xl" />
          <div className="relative mx-auto grid max-w-7xl gap-12 px-5 py-20 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:px-8 lg:py-28">
            <div className="text-white">
              <div className="mb-6 inline-flex rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80">{config.hero_badge}</div>
              <h1 className="max-w-4xl text-4xl font-black tracking-tight sm:text-5xl lg:text-6xl">{config.hero_title}</h1>
              <p className="mt-6 max-w-2xl text-lg leading-8 text-white/70">{config.hero_subtitle}</p>
              <div className="mt-9 flex flex-wrap gap-3">
                <a href={safeHref(config.hero_cta_href)} className="inline-flex items-center gap-2 rounded-xl px-5 py-3.5 text-sm font-bold shadow-lg" style={{ background: accent, color: "white" }}>{config.hero_cta_text}<ArrowRight size={17} /></a>
                <Link to={safeHref(config.hero_secondary_href)} className="rounded-xl border border-white/20 bg-white/10 px-5 py-3.5 text-sm font-bold text-white backdrop-blur">{config.hero_secondary_text}</Link>
              </div>
              <div className="mt-9 flex flex-wrap gap-5 text-sm text-white/60"><span>✓ Modular licensing</span><span>✓ Permission-aware</span><span>✓ Commercial ready</span></div>
            </div>
            <div className="rounded-[2rem] border border-white/10 bg-white/10 p-3 shadow-2xl backdrop-blur-xl">
              <div className="overflow-hidden rounded-[1.5rem] bg-white p-7 text-slate-900">
                <div className="flex items-center justify-between"><div><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">Your workspace</p><h3 className="mt-1 text-xl font-bold">One connected control plane</h3></div><div className="rounded-xl p-3" style={{ background: `${accent}18`, color: accent }}><Zap /></div></div>
                <div className="mt-7 grid grid-cols-2 gap-3">{["Tasks", "Invoices", "Accounting", "People"].map((x, i) => <div key={x} className="rounded-2xl border border-slate-100 bg-slate-50 p-4"><div className="text-2xl font-black">{["24", "₹8.4L", "98%", "42"][i]}</div><div className="mt-1 text-xs text-slate-500">{x}</div></div>)}</div>
                <div className="mt-4 rounded-2xl p-4 text-white" style={{ background: primary }}><div className="text-xs text-white/60">Commercial package</div><div className="mt-1 text-lg font-bold">Configured for your business</div><div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10"><div className="h-full w-4/5 rounded-full" style={{ background: accent }} /></div></div>
              </div>
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-7xl px-5 py-20 lg:px-8 lg:py-24">
          <div className="max-w-3xl"><p className="text-sm font-bold uppercase tracking-[0.18em]" style={{ color: accent }}>Platform</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{config.features_title}</h2><p className="mt-4 text-lg leading-8 text-slate-500">{config.features_subtitle}</p></div>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">{features.map((feature) => { const Icon = iconMap[feature.icon] || Sparkles; return <article key={feature.title} className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm transition hover:-translate-y-1 hover:shadow-xl"><div className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: `${accent}16`, color: accent }}><Icon size={22} /></div><h3 className="mt-6 text-xl font-bold">{feature.title}</h3><p className="mt-2 leading-7 text-slate-500">{feature.description}</p></article>; })}</div>
        </section>

        <section id="solutions" className="bg-slate-50"><div className="mx-auto max-w-7xl px-5 py-20 lg:px-8 lg:py-24"><div className="max-w-3xl"><p className="text-sm font-bold uppercase tracking-[0.18em]" style={{ color: accent }}>Commercial Editions</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{config.solutions_title}</h2><p className="mt-4 text-lg text-slate-500">{config.solutions_subtitle}</p></div><div className="mt-12 grid gap-5 lg:grid-cols-3">{solutions.map((solution, idx) => <article key={solution.title} className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><div className="text-xs font-bold uppercase tracking-wider text-slate-400">Edition 0{idx + 1}</div><h3 className="mt-3 text-2xl font-black">{solution.title}</h3><p className="mt-2 text-slate-500">{solution.description}</p><ul className="mt-6 space-y-3">{(solution.points || []).map((point) => <li key={point} className="flex gap-3 text-sm font-medium"><span className="mt-0.5 rounded-full p-1" style={{ background: `${accent}18`, color: accent }}><Check size={12} /></span>{point}</li>)}</ul></article>)}</div></div></section>

        <section id="pricing" className="mx-auto max-w-7xl px-5 py-20 lg:px-8 lg:py-24"><div className="text-center"><p className="text-sm font-bold uppercase tracking-[0.18em]" style={{ color: accent }}>Pricing</p><h2 className="mt-3 text-3xl font-black tracking-tight sm:text-4xl">{config.pricing_title}</h2><p className="mx-auto mt-4 max-w-2xl text-lg text-slate-500">{config.pricing_subtitle}</p></div><div className="mx-auto mt-12 grid max-w-6xl gap-5 lg:grid-cols-3">{pricing.map((plan) => <article key={plan.name} className={`relative rounded-3xl border p-7 shadow-sm ${plan.featured ? "border-transparent text-white shadow-xl" : "border-slate-200 bg-white"}`} style={plan.featured ? { background: primary } : {}}>{plan.featured && <div className="absolute right-5 top-5 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider" style={{ background: accent }}>Popular</div>}<h3 className="text-xl font-bold">{plan.name}</h3><div className="mt-6 text-4xl font-black">{plan.price}</div><div className={plan.featured ? "mt-1 text-sm text-white/60" : "mt-1 text-sm text-slate-400"}>{plan.period}</div><p className={plan.featured ? "mt-5 text-white/70" : "mt-5 text-slate-500"}>{plan.description}</p><Link to="/login" className={`mt-8 block rounded-xl px-4 py-3 text-center text-sm font-bold ${plan.featured ? "bg-white text-slate-900" : "text-white"}`} style={plan.featured ? {} : { background: primary }}>{plan.cta}</Link></article>)}</div></section>

        <section className="bg-slate-950 text-white"><div className="mx-auto max-w-7xl px-5 py-20 lg:px-8 lg:py-24"><h2 className="max-w-3xl text-3xl font-black tracking-tight sm:text-4xl">{config.testimonials_title}</h2><div className="mt-10 grid gap-5 lg:grid-cols-2">{testimonials.map((item) => <blockquote key={item.name} className="rounded-3xl border border-white/10 bg-white/5 p-7"><p className="text-lg leading-8 text-white/80">“{item.quote}”</p><footer className="mt-7"><div className="font-bold">{item.name}</div><div className="text-sm text-white/40">{item.role}</div></footer></blockquote>)}</div></div></section>

        <section id="contact" className="px-5 py-20 lg:px-8"><div className="mx-auto max-w-5xl rounded-[2rem] p-10 text-white shadow-2xl sm:p-14" style={{ background: `linear-gradient(135deg, ${primary}, #061827)` }}><h2 className="max-w-3xl text-3xl font-black sm:text-4xl">{config.cta_title}</h2><p className="mt-4 max-w-2xl text-lg leading-8 text-white/70">{config.cta_subtitle}</p><Link to={safeHref(config.cta_button_href)} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-900">{config.cta_button_text}<ArrowRight size={17} /></Link></div></section>
      </main>

      <footer className="border-t border-slate-200"><div className="mx-auto grid max-w-7xl gap-8 px-5 py-10 text-sm text-slate-500 lg:grid-cols-2 lg:px-8"><div><div className="font-bold text-slate-900">{config.footer_company || config.site_name}</div><p className="mt-2 max-w-xl">{config.footer_text}</p></div><div className="lg:text-right"><div>{config.footer_email}</div><div>{config.footer_phone}</div><div>{config.footer_address}</div><div className="mt-3 text-xs">{config.footer_copyright}</div></div></div></footer>
    </div>
  );
}
