import React, { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  ExternalLink,
  FileText,
  Globe2,
  ImagePlus,
  Link2,
  Receipt,
  ShieldCheck,
  Sparkles,
  Users,
  Video,
  Zap,
} from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { getPublicWebsiteConfig } from "@/lib/websiteApi";

const iconMap = {
  check: CheckCircle2,
  receipt: Receipt,
  landmark: FileText,
  users: Users,
  shield: ShieldCheck,
  sparkles: Sparkles,
  zap: Zap,
};

const moduleMeta = {
  "Task Management": { route: "/tasks", eyebrow: "WORK MANAGEMENT", icon: CheckCircle2 },
  Invoicing: { route: "/invoicing", eyebrow: "FINANCE", icon: Receipt },
  Accounting: { route: "/accounting-reports", eyebrow: "FINANCE & CONTROL", icon: FileText },
  HRMS: { route: "/people-matrix", eyebrow: "PEOPLE OPERATIONS", icon: Users },
  Compliance: { route: "/compliance-dashboard", eyebrow: "COMPLIANCE", icon: ShieldCheck },
  Records: { route: "/records-dashboard", eyebrow: "RECORDS", icon: FileText },
  "AI & Automation": { route: "/ai-reader", eyebrow: "INTELLIGENCE", icon: Sparkles },
};

const normalizeModule = (item = {}) => {
  const rawTitle = String(item.title || "").trim();
  const isCrm = /^(crm|crms)$/i.test(rawTitle);
  const title = isCrm ? "Records" : rawTitle;
  const description = isCrm
    ? "Client records, documents, approvals, credentials and related business information in one place."
    : item.description;
  const meta = moduleMeta[title] || {};
  return { ...item, title, description, route: item.route || meta.route, eyebrow: item.eyebrow || meta.eyebrow };
};

const defaultModules = [
  { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility in one place.", icon: "check" },
  { title: "Invoicing", description: "Sales, quotations, purchases and customer billing without switching systems.", icon: "receipt" },
  { title: "Accounting", description: "Ledgers, banking, reports and financial controls for a connected finance layer.", icon: "landmark" },
  { title: "HRMS", description: "People, attendance, leave, payroll and recruitment with permission-aware access.", icon: "users" },
  { title: "Compliance", description: "GST, ROC, trademark and compliance workflows built into the operating system.", icon: "shield" },
  { title: "Records", description: "Client records, documents, approvals, credentials and related business information in one place.", icon: "check" },
  { title: "AI & Automation", description: "Intelligent document processing, automation and operational assistance.", icon: "sparkles" },
];

const safeHref = (href) => {
  const value = String(href || "#").trim();
  return value.startsWith("/") || value.startsWith("#") || /^https?:\/\//i.test(value) ? value : "#";
};

function ModulePreview({ item, accent }) {
  const Icon = iconMap[item.icon] || moduleMeta[item.title]?.icon || Sparkles;
  if (item.screenshot_url || item.image || item.screenshot) {
    return (
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2">
          <span className="h-2 w-2 rounded-full bg-slate-300" />
          <span className="h-2 w-2 rounded-full bg-slate-300" />
          <span className="h-2 w-2 rounded-full bg-slate-300" />
          <span className="ml-2 truncate text-[10px] font-medium text-slate-400">Taskosphere · {item.title}</span>
        </div>
        <img src={item.screenshot_url || item.image || item.screenshot} alt={`${item.title} module screenshot`} className="block h-44 w-full object-cover object-top sm:h-48" />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center gap-1.5 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-slate-300" />
        <span className="h-2 w-2 rounded-full bg-slate-300" />
        <span className="h-2 w-2 rounded-full bg-slate-300" />
        <span className="ml-2 truncate text-[10px] font-medium text-slate-400">Taskosphere · {item.title}</span>
      </div>
      <div className="grid h-44 grid-cols-[78px_1fr] bg-slate-50 sm:h-48">
        <div className="border-r border-slate-200 bg-slate-950 p-3">
          <div className="mb-4 flex h-7 w-7 items-center justify-center rounded-lg bg-white/10 text-white"><Icon size={14} /></div>
          {[1, 2, 3, 4].map((n) => <div key={n} className="mb-2 h-2 rounded bg-white/10" style={{ width: `${46 + n * 5}px` }} />)}
        </div>
        <div className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[9px] font-bold uppercase tracking-[0.16em]" style={{ color: accent }}>{item.eyebrow || "TASKOSPHERE MODULE"}</div>
              <div className="mt-1 text-sm font-extrabold text-slate-800">{item.title}</div>
            </div>
            <div className="h-7 w-7 rounded-lg bg-white shadow-sm" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            {["Overview", "Activity", "Reports"].map((label, i) => <div key={label} className="rounded-lg border border-slate-200 bg-white p-2"><div className="h-2 w-10 rounded bg-slate-200" /><div className="mt-2 text-[8px] text-slate-400">{label}</div><div className="mt-2 h-1.5 rounded bg-slate-100" style={{ width: `${55 + i * 10}%` }} /></div>)}
          </div>
          <div className="mt-3 h-8 rounded-lg border border-slate-200 bg-white" />
        </div>
      </div>
    </div>
  );
}

function PlatformModules({ heading, subtitle, items, accent }) {
  const modules = (Array.isArray(items) && items.length ? items : defaultModules).map(normalizeModule);
  return (
    <section id="features" className="mx-auto max-w-7xl px-5 py-20 lg:px-8 lg:py-24">
      <div className="max-w-4xl">
        <p className="text-sm font-bold uppercase tracking-[0.18em]" style={{ color: accent }}>Platform</p>
        <h2 className="mt-3 text-3xl font-black tracking-tight text-slate-900 sm:text-4xl lg:text-5xl">{heading}</h2>
        <p className="mt-5 max-w-3xl text-lg leading-8 text-slate-500">{subtitle}</p>
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {modules.map((item, i) => {
          const Icon = iconMap[item.icon] || moduleMeta[item.title]?.icon || Sparkles;
          return (
            <article key={`${item.title}-${i}`} className="group overflow-hidden rounded-[1.65rem] border border-slate-200 bg-white shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-xl">
              <div className="p-3 pb-0"><ModulePreview item={item} accent={accent} /></div>
              <div className="p-6">
                <div className="flex items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl" style={{ background: `${accent}14`, color: accent }}><Icon size={20} /></div>
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">{item.eyebrow || "TASKOSPHERE MODULE"}</p>
                    <h3 className="mt-1 text-xl font-extrabold tracking-tight text-slate-900">{item.title}</h3>
                  </div>
                </div>
                <p className="mt-4 min-h-[72px] leading-7 text-slate-500">{item.description}</p>
                {item.route && (
                  <Link to={safeHref(item.route)} className="mt-5 inline-flex items-center gap-2 text-sm font-bold" style={{ color: accent }}>
                    Explore module <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" />
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-8 text-center text-xs text-slate-400">Module screenshots can be supplied through each module's <code className="rounded bg-slate-100 px-1.5 py-0.5">screenshot_url</code> field; the live module links remain available from every card.</p>
    </section>
  );
}

function BuilderSection({ section, config }) {
  const d = section.data || {};
  const primary = config.primary_color || "#0D3B66";
  const accent = config.accent_color || "#1FAF5A";
  if (section.type === "hero") return <section className="relative overflow-hidden px-5 py-20 text-white lg:px-8 lg:py-28" style={{ background: `linear-gradient(135deg, ${primary}, #102A43 58%, #061827)` }}><div className="mx-auto grid max-w-7xl items-center gap-12 lg:grid-cols-2"><div><span className="inline-flex rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-white/80">{d.badge}</span><h1 className="mt-6 max-w-4xl text-4xl font-black tracking-tight sm:text-5xl lg:text-6xl">{d.title}</h1><p className="mt-6 max-w-2xl text-lg leading-8 text-white/70">{d.subtitle}</p><div className="mt-9 flex flex-wrap gap-3"><a href={safeHref(d.primaryHref || "#")} className="inline-flex items-center gap-2 rounded-xl px-5 py-3.5 text-sm font-bold" style={{ background: accent }}>{d.primaryText || "Get started"}<ArrowRight size={17} /></a>{d.secondaryText && <a href={safeHref(d.secondaryHref || "/login")} className="rounded-xl border border-white/20 bg-white/10 px-5 py-3.5 text-sm font-bold">{d.secondaryText}</a>}</div></div><div className="rounded-[2rem] border border-white/10 bg-white/10 p-3 shadow-2xl backdrop-blur-xl"><div className="flex min-h-72 items-center justify-center overflow-hidden rounded-[1.5rem] bg-white/10 p-5">{d.image ? <img src={d.image} alt="" className="max-h-72 max-w-full rounded-2xl object-contain" /> : <ImagePlus className="text-white/30" size={60} />}</div></div></div></section>;
  if (section.type === "features") return <PlatformModules heading={d.heading} subtitle={d.subtitle} items={d.items} accent={accent} />;
  if (section.type === "pricing") return <section id="pricing" className="bg-slate-50 px-5 py-20 lg:px-8 lg:py-24"><div className="mx-auto max-w-7xl"><div className="max-w-3xl"><p className="text-sm font-bold uppercase tracking-wider" style={{ color: accent }}>Pricing</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">{d.heading}</h2><p className="mt-4 text-lg text-slate-500">{d.subtitle}</p></div><div className="mt-12 grid gap-5 lg:grid-cols-3">{(d.items || []).map((item, i) => <article key={i} className={`relative rounded-3xl border p-7 shadow-sm ${item.featured ? "text-white shadow-xl" : "border-slate-200 bg-white"}`} style={item.featured ? { background: primary, borderColor: primary } : {}}><h3 className="text-xl font-bold">{item.name}</h3><div className="mt-6 text-4xl font-black">{item.price}</div><div className="mt-1 text-sm opacity-60">{item.period}</div><p className="mt-5 opacity-70">{item.description}</p><Link to="/login" className="mt-8 block rounded-xl px-4 py-3 text-center text-sm font-bold" style={{ background: item.featured ? "white" : primary, color: item.featured ? "#0f172a" : "white" }}>Get started</Link></article>)}</div></div></section>;
  if (section.type === "cta") return <section className="px-5 py-20 lg:px-8"><div className="mx-auto max-w-5xl rounded-[2rem] p-10 text-white shadow-2xl sm:p-14" style={{ background: `linear-gradient(135deg, ${primary}, #061827)` }}><h2 className="max-w-3xl text-3xl font-black sm:text-4xl">{d.heading}</h2><p className="mt-4 max-w-2xl text-lg leading-8 text-white/70">{d.text}</p><Link to={safeHref(d.href || "/login")} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-900">{d.button || "Get started"}<ArrowRight size={17} /></Link></div></section>;
  if (["content", "text", "heading"].includes(section.type)) return <section className="mx-auto max-w-4xl px-5 py-16 lg:px-8"><h2 className="text-3xl font-black">{d.heading}</h2><p className="mt-5 whitespace-pre-wrap text-lg leading-8 text-slate-600">{d.body || d.subtitle}</p></section>;
  if (section.type === "image") return <section className="mx-auto max-w-7xl px-5 py-16 lg:px-8"><img src={d.src} alt={d.alt || ""} className="max-h-[620px] w-full rounded-3xl object-cover shadow-lg" /></section>;
  if (section.type === "imageText") return <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 py-16 lg:grid-cols-2 lg:px-8">{d.src ? <img src={d.src} alt={d.alt || ""} className="max-h-[420px] w-full rounded-3xl object-cover shadow-lg" /> : <div className="flex aspect-video items-center justify-center rounded-3xl bg-slate-100 text-slate-300"><ImagePlus size={40} /></div>}<div><h2 className="text-3xl font-black sm:text-4xl">{d.heading}</h2><p className="mt-5 whitespace-pre-wrap text-lg leading-8 text-slate-600">{d.body}</p>{d.button && <a href={safeHref(d.href)} className="mt-7 inline-flex items-center gap-2 rounded-xl px-5 py-3.5 text-sm font-bold text-white" style={{ background: primary }}>{d.button}<ArrowRight size={17} /></a>}</div></section>;
  if (section.type === "video") return <section className="mx-auto max-w-5xl px-5 py-16 lg:px-8"><div className="flex h-80 items-center justify-center rounded-3xl bg-slate-950 text-white"><Video size={46} /><span className="ml-3 font-semibold">{d.url || "Video"}</span></div></section>;
  if (section.type === "divider") return <div className="mx-auto max-w-7xl px-5 py-5"><div className="h-px bg-slate-200" /></div>;
  if (section.type === "gallery") return <section className="mx-auto grid max-w-7xl grid-cols-2 gap-3 px-5 py-16 md:grid-cols-3 lg:px-8">{(d.items || []).map((src, i) => <img key={i} src={src} alt="" className="aspect-square rounded-2xl object-cover" />)}</section>;
  if (section.type === "faq") return <section className="mx-auto max-w-4xl px-5 py-16 lg:px-8"><h2 className="text-3xl font-black">{d.heading || "Frequently asked questions"}</h2><div className="mt-8 space-y-3">{(d.items || []).map((q, i) => <details key={i} className="rounded-2xl border border-slate-200 bg-white p-5"><summary className="cursor-pointer font-bold">{q.question || q}</summary><p className="mt-3 text-slate-500">{q.answer || d.body || "Add your answer in the website builder."}</p></details>)}</div></section>;
  if (section.type === "form") return <section id="contact" className="mx-auto max-w-5xl px-5 py-16 lg:px-8"><div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"><h2 className="text-3xl font-black">{d.heading || "Contact us"}</h2><p className="mt-3 text-slate-500">{d.body}</p><div className="mt-7 grid gap-4 md:grid-cols-2"><input className="rounded-xl border border-slate-200 px-4 py-3" placeholder="Name" /><input className="rounded-xl border border-slate-200 px-4 py-3" placeholder="Email" /><textarea className="min-h-32 rounded-xl border border-slate-200 px-4 py-3 md:col-span-2" placeholder="Message" /><button className="rounded-xl px-5 py-3 text-sm font-bold text-white md:w-fit" style={{ background: primary }}>Send message</button></div></div></section>;
  if (section.type === "testimonials") return <section className="bg-slate-950 px-5 py-20 text-white lg:px-8"><div className="mx-auto max-w-7xl"><h2 className="text-3xl font-black">{d.heading || "What customers say"}</h2><div className="mt-10 grid gap-5 md:grid-cols-2">{(config.testimonials || []).map((x, i) => <blockquote key={i} className="rounded-3xl border border-white/10 bg-white/5 p-7"><p className="leading-8 text-white/75">“{x.quote}”</p><div className="mt-6 font-bold">{x.name}</div><div className="text-sm text-white/40">{x.role}</div></blockquote>)}</div></div></section>;
  if (section.type === "button") return <section className="px-5 py-10 text-center"><a href={safeHref(d.href)} className="inline-flex rounded-xl px-5 py-3 text-sm font-bold text-white" style={{ background: primary }}>{d.text || "Button"}</a></section>;
  if (section.type === "social") return <section className="px-5 py-10 text-center"><div className="inline-flex gap-3 rounded-2xl border border-slate-200 bg-white p-3"><Link2 size={18} /><span className="text-sm font-semibold">Social links</span></div></section>;
  if (section.type === "map") return <section className="mx-auto max-w-7xl px-5 py-16 lg:px-8"><div className="flex h-80 items-center justify-center rounded-3xl bg-slate-100 text-slate-500"><Globe2 /><span className="ml-3 font-semibold">{d.location || "Map location"}</span></div></section>;
  return null;
}

function BuilderWebsite({ config, builder }) {
  const location = useLocation();
  const queryPage = new URLSearchParams(location.search).get("page");
  const pages = Array.isArray(builder.pages) ? builder.pages : [];
  const page = pages.find((x) => x.id === queryPage) || pages.find((x) => x.slug === location.pathname) || pages.find((x) => x.id === builder.activePageId) || pages[0];
  const visiblePages = pages.filter((x) => x.visible !== false);
  const header = builder.global?.header || {};
  const footer = builder.global?.footer || {};
  const showFooter = footer.show !== false;
  const contactLine = [config.footer_email, config.footer_phone, config.footer_address].filter(Boolean).join(" · ");
  return <div className="min-h-screen bg-white text-slate-900" style={{ fontFamily: builder.global?.design?.font || "Inter" }}>
    <header className={`${header.sticky !== false ? "sticky top-0" : ""} z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl`}><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8"><Link to="/" className="flex items-center gap-3">{header.logo !== false && <img src={config.logo_url || "/logo.png"} alt={config.site_name} className="h-10 w-auto object-contain" />}<div className="hidden sm:block"><div className="font-bold">{config.site_name}</div><div className="text-xs text-slate-500">{config.site_tagline}</div></div></Link><nav className="hidden items-center gap-6 lg:flex">{visiblePages.slice(0, 7).map((p) => <a key={p.id} href={`/website?page=${encodeURIComponent(p.id)}`} className="text-sm font-medium text-slate-600 hover:text-slate-950">{p.name}</a>)}</nav>{header.showLogin !== false && <Link to="/login" className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white" style={{ background: config.primary_color || "#0D3B66" }}>Sign in</Link>}</div></header>
    <main>{(page?.sections || []).filter((s) => s.visible !== false).map((section) => <BuilderSection key={section.id} section={section} config={config} />)}</main>
    {showFooter && <footer className="border-t border-slate-200"><div className="mx-auto max-w-7xl px-5 py-10 lg:px-8"><div className="font-bold">{config.footer_company || config.site_name}</div><p className="mt-2 max-w-2xl text-sm text-slate-500">{config.footer_text}</p>{contactLine && <p className="mt-3 text-sm text-slate-500">{contactLine}</p>}<div className="mt-5 text-xs text-slate-400">{config.footer_copyright}</div></div></footer>}
  </div>;
}

function useSiteMeta(config) {
  useEffect(() => {
    if (!config) return;
    const setMeta = (name, content, attr = "name") => {
      if (!content) return;
      let tag = document.head.querySelector(`meta[${attr}="${name}"]`);
      if (!tag) { tag = document.createElement("meta"); tag.setAttribute(attr, name); document.head.appendChild(tag); }
      tag.setAttribute("content", content);
    };
    if (config.seo_title || config.site_name) document.title = config.seo_title || config.site_name;
    setMeta("description", config.seo_description);
    setMeta("og:title", config.seo_title || config.site_name, "property");
    setMeta("og:description", config.seo_description, "property");
    if (config.seo_og_image) setMeta("og:image", config.seo_og_image, "property");
    if (config.favicon_url) {
      let link = document.head.querySelector("link[rel~='icon']");
      if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
      link.href = config.favicon_url;
    }
  }, [config]);
}

export default function WebsiteHome({ configOverride = null }) {
  const [config, setConfig] = useState(configOverride);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (configOverride) {
      setConfig(configOverride);
    } else {
      getPublicWebsiteConfig().then((data) => {
        if (data) setConfig(data);
        else setError(true);
      }).catch(() => setError(true));
    }

    const handleUpdate = (e) => {
      if (e?.detail) setConfig(e.detail);
    };
    window.addEventListener("taskosphere:website-updated", handleUpdate);
    return () => window.removeEventListener("taskosphere:website-updated", handleUpdate);
  }, [configOverride]);
  useSiteMeta(config);
  if (!config && !error) return <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">Loading website…</div>;
  if (!config) return <div className="flex min-h-screen items-center justify-center">Website configuration is unavailable.</div>;
  if (config.builder?.pages?.length) return <BuilderWebsite config={config} builder={config.builder} />;

  const primary = config.primary_color || "#0D3B66";
  const accent = config.accent_color || "#1FAF5A";
  const features = (Array.isArray(config.features) && config.features.length ? config.features : defaultModules).map(normalizeModule);
  const solutions = Array.isArray(config.solutions) ? config.solutions : [];
  const pricing = Array.isArray(config.pricing) ? config.pricing : [];
  const testimonials = Array.isArray(config.testimonials) ? config.testimonials : [];

  return <div className="min-h-screen bg-white text-slate-900">
    <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 lg:px-8">
        <Link to="/" className="flex items-center gap-3"><img src={config.logo_url || "/logo.png"} alt={config.site_name} className="h-10 w-auto object-contain" /><div className="hidden sm:block"><div className="font-bold tracking-tight">{config.site_name}</div><div className="text-xs text-slate-500">{config.site_tagline}</div></div></Link>
        <nav className="hidden items-center gap-7 lg:flex">{(config.nav_links || []).map((item) => <a key={`${item.label}-${item.href}`} href={safeHref(item.href)} className="text-sm font-medium text-slate-600 hover:text-slate-950">{item.label}</a>)}</nav>
        <Link to="/login" className="rounded-xl px-4 py-2.5 text-sm font-semibold text-white" style={{ background: primary }}>Sign in</Link>
      </div>
    </header>

    <main>
      <section className="relative overflow-hidden" style={{ background: `linear-gradient(135deg, ${primary} 0%, #102A43 58%, #061827 100%)` }}>
        <div className="mx-auto grid max-w-7xl gap-12 px-5 py-20 lg:grid-cols-[1.1fr_.9fr] lg:items-center lg:px-8 lg:py-28">
          <div className="text-white"><div className="mb-6 inline-flex rounded-full border border-white/15 bg-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80">{config.hero_badge}</div><h1 className="max-w-4xl text-4xl font-black tracking-tight sm:text-5xl lg:text-6xl">{config.hero_title}</h1><p className="mt-6 max-w-2xl text-lg leading-8 text-white/70">{config.hero_subtitle}</p><div className="mt-9 flex flex-wrap gap-3"><a href={safeHref(config.hero_cta_href || "#features")} className="inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-900">{config.hero_cta_text || "Explore Taskosphere"}<ArrowRight size={17} /></a><Link to={safeHref(config.hero_secondary_href || "/login")} className="rounded-xl border border-white/20 bg-white/10 px-5 py-3.5 text-sm font-bold">{config.hero_secondary_text || "Sign in"}</Link></div></div>
          <div className="rounded-[2rem] border border-white/10 bg-white/10 p-3 shadow-2xl backdrop-blur-xl"><div className="flex min-h-80 items-center justify-center overflow-hidden rounded-[1.5rem] bg-white/10 p-5">{config.hero_image_url ? <img src={config.hero_image_url} alt="Taskosphere platform" className="max-h-80 max-w-full rounded-2xl object-contain" /> : <ImagePlus className="text-white/30" size={60} />}</div></div>
        </div>
      </section>

      <PlatformModules heading={config.features_title || "Everything your team needs. Nothing scattered."} subtitle={config.features_subtitle || "Build the exact software package your customer needs and activate it through your commercial license."} items={features} accent={accent} />

      <section id="solutions" className="bg-slate-50 px-5 py-20 lg:px-8 lg:py-24"><div className="mx-auto max-w-7xl"><div className="max-w-3xl"><p className="text-sm font-bold uppercase tracking-wider" style={{ color: accent }}>Solutions</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">{config.solutions_title}</h2><p className="mt-4 text-lg text-slate-500">{config.solutions_subtitle}</p></div><div className="mt-12 grid gap-5 lg:grid-cols-3">{solutions.map((item, i) => <article key={i} className="rounded-3xl border border-slate-200 bg-white p-7 shadow-sm"><h3 className="text-xl font-bold">{item.title}</h3><p className="mt-3 leading-7 text-slate-500">{item.description}</p><ul className="mt-6 space-y-3">{(item.points || []).map((point, j) => <li key={j} className="flex items-start gap-2 text-sm text-slate-600"><Check size={17} style={{ color: accent }} />{point}</li>)}</ul></article>)}</div></div></section>

      <section id="pricing" className="px-5 py-20 lg:px-8 lg:py-24"><div className="mx-auto max-w-7xl"><div className="max-w-3xl"><p className="text-sm font-bold uppercase tracking-wider" style={{ color: accent }}>Pricing</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">{config.pricing_title}</h2><p className="mt-4 text-lg text-slate-500">{config.pricing_subtitle}</p></div><div className="mt-12 grid gap-5 lg:grid-cols-3">{pricing.map((item, i) => <article key={i} className={`relative rounded-3xl border p-7 shadow-sm ${item.featured ? "text-white shadow-xl" : "border-slate-200 bg-white"}`} style={item.featured ? { background: primary, borderColor: primary } : {}}><h3 className="text-xl font-bold">{item.name}</h3><div className="mt-6 text-4xl font-black">{item.price}</div><div className="mt-1 text-sm opacity-60">{item.period}</div><p className="mt-5 opacity-70">{item.description}</p><Link to="/login" className="mt-8 block rounded-xl px-4 py-3 text-center text-sm font-bold" style={{ background: item.featured ? "white" : primary, color: item.featured ? "#0f172a" : "white" }}>{item.cta || "Get started"}</Link></article>)}</div></div></section>

      {testimonials.length > 0 && <section className="bg-slate-950 px-5 py-20 text-white lg:px-8"><div className="mx-auto max-w-7xl"><p className="text-sm font-bold uppercase tracking-wider" style={{ color: accent }}>Customer voice</p><h2 className="mt-3 text-3xl font-black sm:text-4xl">{config.testimonials_title}</h2><div className="mt-10 grid gap-5 md:grid-cols-2">{testimonials.map((item, i) => <blockquote key={i} className="rounded-3xl border border-white/10 bg-white/5 p-7"><p className="leading-8 text-white/75">“{item.quote}”</p><div className="mt-6 font-bold">{item.name}</div><div className="text-sm text-white/40">{item.role}</div></blockquote>)}</div></div></section>}

      <section id="contact" className="px-5 py-20 lg:px-8"><div className="mx-auto max-w-5xl rounded-[2rem] p-10 text-white shadow-2xl sm:p-14" style={{ background: `linear-gradient(135deg, ${primary}, #061827)` }}><h2 className="max-w-3xl text-3xl font-black sm:text-4xl">{config.cta_title}</h2><p className="mt-4 max-w-2xl text-lg leading-8 text-white/70">{config.cta_subtitle}</p><Link to={safeHref(config.cta_button_href || "/login")} className="mt-8 inline-flex items-center gap-2 rounded-xl bg-white px-5 py-3.5 text-sm font-bold text-slate-900">{config.cta_button_text || "Get started"}<ArrowRight size={17} /></Link></div></section>
    </main>

    <footer className="border-t border-slate-200"><div className="mx-auto max-w-7xl px-5 py-10 lg:px-8"><div className="font-bold">{config.footer_company || config.site_name}</div><p className="mt-2 max-w-2xl text-sm text-slate-500">{config.footer_text}</p><div className="mt-5 text-xs text-slate-400">{config.footer_copyright}</div></div></footer>
  </div>;
}
