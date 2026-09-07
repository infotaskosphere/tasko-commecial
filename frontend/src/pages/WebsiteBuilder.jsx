import React, { useEffect, useMemo, useState } from "react";
import { Eye, Globe2, ImagePlus, LayoutTemplate, Palette, RefreshCcw, Save, Search, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { getAdminWebsiteConfig, resetWebsiteConfig, saveWebsiteConfig } from "@/lib/websiteApi";
import WebsiteHome from "./WebsiteHome";

const ARRAY_FIELDS = ["nav_links", "features", "solutions", "pricing", "testimonials"];

function jsonValue(value) {
  try { return JSON.stringify(value || [], null, 2); } catch { return "[]"; }
}

function Field({ label, value, onChange, multiline = false, hint }) {
  const Tag = multiline ? "textarea" : "input";
  return <label className="block text-sm font-semibold text-slate-700"><span>{label}</span><Tag value={value ?? ""} onChange={(e) => onChange(e.target.value)} rows={multiline ? 5 : undefined} className={`mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none transition focus:border-slate-400 focus:ring-2 focus:ring-slate-100 ${multiline ? "resize-y font-mono text-xs" : ""}`} />{hint && <span className="mt-1 block text-xs font-normal text-slate-400">{hint}</span>}</label>;
}

function Section({ title, icon: Icon, children }) { return <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex items-center gap-3"><div className="rounded-xl bg-slate-100 p-2.5"><Icon size={18} /></div><div><h2 className="font-bold text-slate-950">{title}</h2><p className="text-xs text-slate-400">Changes are stored centrally for the commercial deployment.</p></div></div><div className="mt-6">{children}</div></section>; }

export default function WebsiteBuilder() {
  const [config, setConfig] = useState(null);
  const [tab, setTab] = useState("content");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = async () => {
    try { setConfig(await getAdminWebsiteConfig()); } catch (error) { toast.error(error?.response?.data?.detail || "Unable to load website configuration."); }
  };
  useEffect(() => { load(); }, []);

  const update = (key, value) => setConfig((current) => ({ ...current, [key]: value }));
  const updateJson = (key, value) => {
    try { update(key, JSON.parse(value)); }
    catch { toast.error(`Invalid JSON in ${key.replaceAll("_", " ")}.`); }
  };

  const uploadImage = (key, file) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) { toast.error("Please choose an image file."); return; }
    if (file.size > 2 * 1024 * 1024) { toast.error("Please keep website images below 2 MB."); return; }
    const reader = new FileReader();
    reader.onload = () => update(key, reader.result);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    try { const saved = await saveWebsiteConfig(config); setConfig(saved); toast.success("Website configuration published."); }
    catch (error) { toast.error(error?.response?.data?.detail || "Unable to save website configuration."); }
    finally { setSaving(false); }
  };

  const reset = async () => {
    if (!window.confirm("Reset the commercial website to the default Taskosphere design?")) return;
    try { setConfig(await resetWebsiteConfig()); toast.success("Website reset to defaults."); }
    catch (error) { toast.error(error?.response?.data?.detail || "Unable to reset website."); }
  };

  const jsonFields = useMemo(() => ARRAY_FIELDS.reduce((acc, key) => { acc[key] = jsonValue(config?.[key]); return acc; }, {}), [config]);

  if (!config) return <div className="min-h-screen bg-slate-50 p-8"><div className="mx-auto max-w-7xl rounded-3xl border border-slate-200 bg-white p-10 text-center text-slate-400">Loading Website Builder…</div></div>;

  const tabs = [["content", "Website Content", LayoutTemplate], ["brand", "Brand & Images", Palette], ["login", "Login Experience", ShieldCheck], ["seo", "SEO & Metadata", Search], ["preview", "Live Preview", Eye]];

  return <div className="min-h-screen bg-slate-50 p-4 md:p-7"><div className="mx-auto max-w-[1500px]">
    <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between"><div><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-slate-400"><Globe2 size={15} /> Commercial Website Control</div><h1 className="mt-2 text-3xl font-black tracking-tight text-slate-950">Website & Brand Studio</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">Control the public software website and customer login experience from the Master Console. Text, navigation, packages, images, colours and SEO are stored server-side.</p></div><div className="flex gap-2"><button onClick={reset} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold"><RefreshCcw size={16} /> Reset</button><button onClick={save} disabled={saving} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"><Save size={16} /> {saving ? "Publishing…" : "Publish Changes"}</button></div></div>

    <div className="mt-7 flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">{tabs.map(([id, label, Icon]) => <button key={id} onClick={() => { setTab(id); if (id === "preview") setPreview(true); }} className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold ${tab === id ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-50"}`}><Icon size={16} />{label}</button>)}</div>

    {tab === "content" && <div className="mt-5 grid gap-5 lg:grid-cols-2"><Section title="Site & Navigation" icon={LayoutTemplate}><div className="grid gap-4 md:grid-cols-2"><Field label="Site name" value={config.site_name} onChange={(v) => update("site_name", v)} /><Field label="Tagline" value={config.site_tagline} onChange={(v) => update("site_tagline", v)} /><Field label="Navigation JSON" value={jsonFields.nav_links} onChange={(v) => updateJson("nav_links", v)} multiline hint='Example: [{"label":"Features","href":"#features"}]' /></div></Section><Section title="Hero Section" icon={Globe2}><div className="grid gap-4"><Field label="Badge" value={config.hero_badge} onChange={(v) => update("hero_badge", v)} /><Field label="Headline" value={config.hero_title} onChange={(v) => update("hero_title", v)} multiline /><Field label="Subtitle" value={config.hero_subtitle} onChange={(v) => update("hero_subtitle", v)} multiline /><div className="grid gap-4 md:grid-cols-2"><Field label="Primary CTA" value={config.hero_cta_text} onChange={(v) => update("hero_cta_text", v)} /><Field label="Primary CTA link" value={config.hero_cta_href} onChange={(v) => update("hero_cta_href", v)} /><Field label="Secondary CTA" value={config.hero_secondary_text} onChange={(v) => update("hero_secondary_text", v)} /><Field label="Secondary CTA link" value={config.hero_secondary_href} onChange={(v) => update("hero_secondary_href", v)} /></div></div></Section><Section title="Features & Solutions" icon={ShieldCheck}><div className="space-y-4"><Field label="Features title" value={config.features_title} onChange={(v) => update("features_title", v)} /><Field label="Features subtitle" value={config.features_subtitle} onChange={(v) => update("features_subtitle", v)} multiline /><Field label="Features JSON" value={jsonFields.features} onChange={(v) => updateJson("features", v)} multiline hint='Each item: title, description, icon. Icons: check, receipt, landmark, users, shield, sparkles, zap.' /><Field label="Solutions JSON" value={jsonFields.solutions} onChange={(v) => updateJson("solutions", v)} multiline /></div></Section><Section title="Pricing & Social Proof" icon={LayoutTemplate}><div className="space-y-4"><Field label="Pricing title" value={config.pricing_title} onChange={(v) => update("pricing_title", v)} /><Field label="Pricing subtitle" value={config.pricing_subtitle} onChange={(v) => update("pricing_subtitle", v)} multiline /><Field label="Pricing JSON" value={jsonFields.pricing} onChange={(v) => updateJson("pricing", v)} multiline /><Field label="Testimonials title" value={config.testimonials_title} onChange={(v) => update("testimonials_title", v)} /><Field label="Testimonials JSON" value={jsonFields.testimonials} onChange={(v) => updateJson("testimonials", v)} multiline /></div></Section><Section title="Call to Action & Footer" icon={LayoutTemplate}><div className="grid gap-4"><Field label="CTA title" value={config.cta_title} onChange={(v) => update("cta_title", v)} multiline /><Field label="CTA subtitle" value={config.cta_subtitle} onChange={(v) => update("cta_subtitle", v)} multiline /><div className="grid gap-4 md:grid-cols-2"><Field label="CTA button" value={config.cta_button_text} onChange={(v) => update("cta_button_text", v)} /><Field label="CTA link" value={config.cta_button_href} onChange={(v) => update("cta_button_href", v)} /><Field label="Footer company" value={config.footer_company} onChange={(v) => update("footer_company", v)} /><Field label="Footer email" value={config.footer_email} onChange={(v) => update("footer_email", v)} /><Field label="Footer phone" value={config.footer_phone} onChange={(v) => update("footer_phone", v)} /><Field label="Footer address" value={config.footer_address} onChange={(v) => update("footer_address", v)} /></div><Field label="Footer text" value={config.footer_text} onChange={(v) => update("footer_text", v)} multiline /><Field label="Copyright" value={config.footer_copyright} onChange={(v) => update("footer_copyright", v)} /></div></Section></div>}

    {tab === "brand" && <div className="mt-5 grid gap-5 lg:grid-cols-2"><Section title="Brand Colours" icon={Palette}><div className="grid gap-4 md:grid-cols-3"><Field label="Primary colour" value={config.primary_color} onChange={(v) => update("primary_color", v)} /><Field label="Accent colour" value={config.accent_color} onChange={(v) => update("accent_color", v)} /><Field label="Surface colour" value={config.surface_color} onChange={(v) => update("surface_color", v)} /></div></Section><Section title="Logo & Website Images" icon={ImagePlus}><div className="space-y-5">{[["logo_url", "Logo"], ["hero_image_url", "Hero image"], ["favicon_url", "Favicon"]].map(([key, label]) => <div key={key} className="rounded-2xl border border-slate-200 p-4"><Field label={`${label} URL`} value={config[key]} onChange={(v) => update(key, v)} hint="You can paste a hosted image URL or upload a small image below." /><div className="mt-3 flex items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold"><ImagePlus size={14} /> Upload image<input type="file" accept="image/*" className="hidden" onChange={(e) => uploadImage(key, e.target.files?.[0])} /></label>{config[key] && <img src={config[key]} alt="Preview" className="h-10 max-w-40 rounded-lg border border-slate-200 object-contain" />}</div></div>)}</div></Section><Section title="Footer Contact" icon={Globe2}><div className="grid gap-4"><Field label="Footer company" value={config.footer_company} onChange={(v) => update("footer_company", v)} /><Field label="Email" value={config.footer_email} onChange={(v) => update("footer_email", v)} /><Field label="Phone" value={config.footer_phone} onChange={(v) => update("footer_phone", v)} /><Field label="Address" value={config.footer_address} onChange={(v) => update("footer_address", v)} /></div></Section></div>}

    {tab === "login" && <div className="mt-5 grid gap-5 lg:grid-cols-2"><Section title="Customer Login Branding" icon={ShieldCheck}><div className="grid gap-4"><Field label="Login title" value={config.login_title} onChange={(v) => update("login_title", v)} /><Field label="Login subtitle" value={config.login_subtitle} onChange={(v) => update("login_subtitle", v)} /><Field label="Login card note" value={config.login_card_note} onChange={(v) => update("login_card_note", v)} multiline /><Field label="Login background image URL" value={config.login_background_image} onChange={(v) => update("login_background_image", v)} /><div className="flex items-center gap-3"><label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-semibold"><ImagePlus size={14} /> Upload login background<input type="file" accept="image/*" className="hidden" onChange={(e) => uploadImage("login_background_image", e.target.files?.[0])} /></label>{config.login_background_image && <img src={config.login_background_image} alt="Login background" className="h-12 w-20 rounded-lg object-cover" />}</div><label className="flex items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm font-semibold"><input type="checkbox" checked={!!config.login_show_website_link} onChange={(e) => update("login_show_website_link", e.target.checked)} /> Show website link on login</label><Field label="Website link text" value={config.login_website_link_text} onChange={(v) => update("login_website_link_text", v)} /></div></Section><Section title="Login Preview" icon={Eye}><div className="rounded-3xl p-8 text-center" style={{ background: config.login_background_image ? `linear-gradient(135deg, rgba(13,59,102,.82), rgba(6,24,39,.92)), url(${config.login_background_image}) center/cover` : `linear-gradient(135deg, ${config.primary_color}, #061827)` }}><img src={config.logo_url || "/logo.png"} alt={config.site_name} className="mx-auto h-16 w-auto rounded-lg object-contain" /><h3 className="mt-6 text-2xl font-black text-white">{config.login_title}</h3><p className="mt-2 text-sm text-white/70">{config.login_subtitle}</p><div className="mx-auto mt-6 max-w-sm rounded-2xl bg-white p-5 text-left shadow-xl"><div className="h-10 rounded-lg bg-slate-100" /><div className="mt-3 h-10 rounded-lg bg-slate-100" /><div className="mt-4 h-10 rounded-lg" style={{ background: config.accent_color }} /><p className="mt-4 text-center text-xs text-slate-400">{config.login_card_note}</p></div></div></Section></div>}

    {tab === "seo" && <div className="mt-5 grid gap-5 lg:grid-cols-2"><Section title="Search Engine Metadata" icon={Search}><div className="grid gap-4"><Field label="SEO title" value={config.seo_title} onChange={(v) => update("seo_title", v)} /><Field label="SEO description" value={config.seo_description} onChange={(v) => update("seo_description", v)} multiline /><Field label="Open Graph image URL" value={config.seo_og_image} onChange={(v) => update("seo_og_image", v)} /></div></Section><Section title="Publishing Model" icon={ShieldCheck}><div className="rounded-2xl bg-slate-50 p-5 text-sm leading-7 text-slate-600"><p><strong className="text-slate-900">Master Console only:</strong> customers and ordinary users do not receive access to this editor.</p><p className="mt-3"><strong className="text-slate-900">Server-side:</strong> published settings are stored in the commercial database, so a branding change is not tied to one browser.</p><p className="mt-3"><strong className="text-slate-900">Images:</strong> hosted image URLs are supported and small uploads can be stored directly with the configuration for portable deployments.</p></div></Section></div>}

    {tab === "preview" && <div className="mt-5 overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-100 p-4"><div><h2 className="font-bold">Website Preview</h2><p className="text-xs text-slate-400">This is the public website using the current unsaved editor state.</p></div><button onClick={() => setPreview(!preview)} className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold">{preview ? "Close preview" : "Open preview"}</button></div><div className="max-h-[75vh] overflow-auto">{preview && <WebsiteHome />}</div></div>}

    <div className="mt-6 flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 text-xs text-slate-400"><span>Last saved: {config.updated_at ? new Date(config.updated_at).toLocaleString("en-IN") : "Not published yet"}</span><button onClick={save} disabled={saving} className="inline-flex items-center gap-2 font-bold text-slate-700"><Save size={14} /> Publish</button></div>
  </div></div>;
}
