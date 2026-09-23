import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, Copy, Eye, EyeOff, Globe2,
  GripVertical, ImagePlus, LayoutGrid, Monitor, MoreHorizontal, Palette, Plus,
  Redo2, Save, Settings2, Smartphone, Tablet, Trash2, Type, Undo2, Upload, X
} from "lucide-react";
import { toast } from "sonner";
import { getAdminWebsiteConfig, resetWebsiteConfig, saveWebsiteConfig } from "@/lib/websiteApi";
import WebsiteRenderer, { DEFAULT_BUILDER } from "@/components/website/WebsiteRenderer";

const clone = (v) => JSON.parse(JSON.stringify(v));
const uid = (prefix = "item") => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const SECTION_TYPES = [
  ["hero", "Hero"], ["features", "Features"], ["text", "Text"], ["pricing", "Pricing"],
  ["imageText", "Image + Text"], ["image", "Image"], ["gallery", "Gallery"], ["video", "Video"],
  ["testimonials", "Testimonials"], ["faq", "FAQ"], ["form", "Contact Form"], ["cta", "Call to Action"], ["divider", "Divider"]
];

const palettes = [
  ["Taskosphere", "#0D3B66", "#1FAF5A", "#FFFFFF", "#0F172A"],
  ["Slate", "#0F172A", "#0EA5E9", "#FFFFFF", "#0F172A"],
  ["Indigo", "#312E81", "#6366F1", "#FFFFFF", "#111827"],
  ["Emerald", "#064E3B", "#10B981", "#FFFFFF", "#0F172A"],
  ["Sapphire", "#172554", "#3B82F6", "#FFFFFF", "#0F172A"],
  ["Crimson", "#450A0A", "#EF4444", "#FFFFFF", "#0F172A"]
];

function fieldFor(type) {
  const base = { visible: true };
  if (type === "hero") return { ...base, badge: "THE MODERN BUSINESS OPERATING SYSTEM", title: "Your headline", subtitle: "Your website message.", primaryText: "Get started", primaryHref: "#features", secondaryText: "Sign in", secondaryHref: "/login", image: "/logo-transparent.png", theme: "executive" };
  if (type === "features") return { ...base, heading: "One platform. Every business function.", subtitle: "Explain your offering.", items: [{ title: "New feature", description: "Describe it here.", route: "#" }] };
  if (type === "pricing") return { ...base, heading: "Pricing", subtitle: "Choose a package.", items: [{ name: "Starter", price: "Custom", period: "/ month", description: "Package description.", featured: false }] };
  if (type === "text") return { ...base, heading: "Section heading", body: "Write your content here." };
  if (type === "imageText") return { ...base, heading: "Tell your story", body: "Describe the image or feature.", image: "/logo-transparent.png", imageSide: "right" };
  if (type === "image") return { ...base, image: "/logo-transparent.png", alt: "Website image" };
  if (type === "gallery") return { ...base, items: ["/logo-transparent.png"] };
  if (type === "video") return { ...base, title: "Video", url: "" };
  if (type === "testimonials") return { ...base, heading: "What customers say", items: [{ quote: "A great platform.", name: "Customer", role: "Business" }] };
  if (type === "faq") return { ...base, heading: "Frequently asked questions", items: [{ question: "Question?", answer: "Answer." }] };
  if (type === "form") return { ...base, heading: "Contact us" };
  if (type === "cta") return { ...base, heading: "Ready to get started?", text: "Take the next step.", button: "Get started", href: "/login" };
  return base;
}

function TextField({ label, value, onChange, area = false, placeholder = "" }) {
  const Tag = area ? "textarea" : "input";
  return <label className="block min-w-0"><span className="mb-1.5 block text-[11px] font-semibold text-slate-600">{label}</span><Tag value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} rows={area ? 4 : undefined} className={`w-full min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${area ? "resize-y" : "h-10"}`} /></label>;
}

function ColorField({ label, value, onChange }) {
  return <label className="flex min-w-0 items-center justify-between gap-3"><span className="text-xs font-semibold text-slate-600">{label}</span><div className="flex min-w-0 items-center gap-2"><input type="color" value={value || "#ffffff"} onChange={(e) => onChange(e.target.value)} className="h-8 w-10 shrink-0 cursor-pointer rounded border border-slate-200"/><input value={value || ""} onChange={(e) => onChange(e.target.value)} className="w-24 rounded-lg border border-slate-200 px-2 py-1.5 text-xs"/></div></label>;
}

function UploadField({ label, value, onChange }) {
  const choose = (file) => { if (!file) return; if (!file.type.startsWith("image/")) return toast.error("Please choose an image file."); const reader = new FileReader(); reader.onload = () => onChange(String(reader.result)); reader.readAsDataURL(file); };
  return <div className="min-w-0"><span className="mb-1.5 block text-[11px] font-semibold text-slate-600">{label}</span><div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">{value && <img src={value} alt="" className="max-h-32 w-full object-contain p-3"/>}<div className="flex gap-2 p-2"><label className="flex-1 cursor-pointer rounded-lg border border-dashed border-slate-300 bg-white px-3 py-2 text-center text-xs font-bold text-slate-600"><Upload size={13} className="mr-1 inline"/> Upload<input type="file" accept="image/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])}/></label>{value && <button type="button" onClick={() => onChange("")} className="rounded-lg border border-red-100 px-3 text-xs font-bold text-red-500">Clear</button>}</div></div><div className="mt-2"><TextField label="Image URL / path" value={value} onChange={onChange}/></div></div>;
}

function ListEditor({ items, onChange, fields, checkbox }) {
  return <div className="space-y-2">{items.map((item, i) => <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-bold text-slate-700">Item {i + 1}</span><button type="button" onClick={() => onChange(items.filter((_, x) => x !== i))} className="text-red-500"><Trash2 size={14}/></button></div>{fields.map((f) => <div key={f} className="mb-2"><input value={item[f] ?? ""} placeholder={f} onChange={(e) => onChange(items.map((x, idx) => idx === i ? { ...x, [f]: e.target.value } : x))} className="w-full rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-blue-500"/></div>)}{checkbox && <label className="text-xs font-medium"><input type="checkbox" checked={!!item[checkbox]} onChange={(e) => onChange(items.map((x, idx) => idx === i ? { ...x, [checkbox]: e.target.checked } : x))} className="mr-2"/> Featured</label>}</div>)}<button type="button" onClick={() => onChange([...items, { ...Object.fromEntries(fields.map((f) => [f, ""])), ...(checkbox ? { [checkbox]: false } : {}) }])} className="w-full rounded-lg border border-dashed border-slate-300 px-3 py-2 text-xs font-bold text-blue-600"><Plus size={13} className="mr-1 inline"/> Add item</button></div>;
}

function SectionEditor({ section, patchData, patchStyle }) {
  const d = section.data || {}, s = section.style || {};
  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => patchData({}, { visible: section.visible === false })} className="rounded-lg border border-slate-200 px-2 py-2 text-xs font-bold">{section.visible === false ? <><Eye size={14} className="mr-1 inline"/> Show</> : <><EyeOff size={14} className="mr-1 inline"/> Hide</>}</button><select value={section.layout || "default"} onChange={(e) => patchData({}, { layout: e.target.value })} className="rounded-lg border border-slate-200 px-2 text-xs"><option value="default">Default layout</option><option value="split">Split</option><option value="center">Centered</option><option value="cards">Cards</option></select></div>
    <TextField label="Section name" value={section.title} onChange={(v) => patchData({}, { title: v })}/>
    {section.type === "hero" && <><TextField label="Badge" value={d.badge} onChange={(v) => patchData({ badge: v })}/><TextField label="Headline" value={d.title} onChange={(v) => patchData({ title: v })}/><TextField label="Description" value={d.subtitle} area onChange={(v) => patchData({ subtitle: v })}/><div className="grid grid-cols-2 gap-3"><TextField label="Primary button" value={d.primaryText} onChange={(v) => patchData({ primaryText: v })}/><TextField label="Primary link" value={d.primaryHref} onChange={(v) => patchData({ primaryHref: v })}/><TextField label="Secondary button" value={d.secondaryText} onChange={(v) => patchData({ secondaryText: v })}/><TextField label="Secondary link" value={d.secondaryHref} onChange={(v) => patchData({ secondaryHref: v })}/></div><UploadField label="Hero image" value={d.image} onChange={(v) => patchData({ image: v })}/><select value={d.theme || "executive"} onChange={(e) => patchData({ theme: e.target.value })} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"><option value="executive">Dark hero</option><option value="light">Light hero</option></select></>}
    {section.type === "features" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><TextField label="Subtitle" value={d.subtitle} area onChange={(v) => patchData({ subtitle: v })}/><ListEditor items={d.items || []} onChange={(items) => patchData({ items })} fields={["title", "description", "route"]}/></>}
    {section.type === "text" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><TextField label="Body" value={d.body} area onChange={(v) => patchData({ body: v })}/></>}
    {section.type === "pricing" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><TextField label="Subtitle" value={d.subtitle} onChange={(v) => patchData({ subtitle: v })}/><ListEditor items={d.items || []} onChange={(items) => patchData({ items })} fields={["name", "price", "period", "description"]} checkbox="featured"/></>}
    {section.type === "imageText" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><TextField label="Body" value={d.body} area onChange={(v) => patchData({ body: v })}/><UploadField label="Image" value={d.image} onChange={(v) => patchData({ image: v })}/><select value={d.imageSide || "right"} onChange={(e) => patchData({ imageSide: e.target.value })} className="h-10 w-full rounded-lg border border-slate-200 px-3 text-sm"><option value="right">Image right</option><option value="left">Image left</option></select></>}
    {section.type === "image" && <><UploadField label="Image" value={d.image} onChange={(v) => patchData({ image: v })}/><TextField label="Alt text" value={d.alt} onChange={(v) => patchData({ alt: v })}/></>}
    {section.type === "gallery" && <ListEditor items={(d.items || []).map((x) => typeof x === "string" ? { image: x } : x)} onChange={(items) => patchData({ items: items.map((x) => x.image) })} fields={["image"]}/>} 
    {section.type === "video" && <><TextField label="Video title" value={d.title} onChange={(v) => patchData({ title: v })}/><TextField label="YouTube / Vimeo / MP4 URL" value={d.url} onChange={(v) => patchData({ url: v })}/></>}
    {section.type === "testimonials" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><ListEditor items={d.items || []} onChange={(items) => patchData({ items })} fields={["quote", "name", "role"]}/></>}
    {section.type === "faq" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><ListEditor items={d.items || []} onChange={(items) => patchData({ items })} fields={["question", "answer"]}/></>}
    {section.type === "form" && <TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/>} 
    {section.type === "cta" && <><TextField label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })}/><TextField label="Description" value={d.text} area onChange={(v) => patchData({ text: v })}/><div className="grid grid-cols-2 gap-3"><TextField label="Button" value={d.button} onChange={(v) => patchData({ button: v })}/><TextField label="Link" value={d.href} onChange={(v) => patchData({ href: v })}/></div></>}
    <div className="border-t border-slate-200 pt-4"><div className="mb-3 text-[11px] font-bold uppercase tracking-wider text-slate-500">Section design</div><div className="space-y-3"><ColorField label="Background" value={s.backgroundColor || "#ffffff"} onChange={(v) => patchStyle({ backgroundColor: v })}/><ColorField label="Text color" value={s.textColor || "#0f172a"} onChange={(v) => patchStyle({ textColor: v })}/><TextField label="Background image URL" value={s.backgroundImage || ""} onChange={(v) => patchStyle({ backgroundImage: v })}/><div className="grid grid-cols-2 gap-3"><TextField label="Top padding" value={s.paddingTop ?? ""} onChange={(v) => patchStyle({ paddingTop: v === "" ? undefined : Number(v) })}/><TextField label="Bottom padding" value={s.paddingBottom ?? ""} onChange={(v) => patchStyle({ paddingBottom: v === "" ? undefined : Number(v) })}/></div><div className="grid grid-cols-2 gap-3"><TextField label="Min height" value={s.minHeight ?? ""} onChange={(v) => patchStyle({ minHeight: v === "" ? undefined : Number(v) })}/><TextField label="Radius" value={s.borderRadius ?? ""} onChange={(v) => patchStyle({ borderRadius: v === "" ? undefined : Number(v) })}/></div></div></div>
  </div>;
}

export default function WebsiteBuilder() {
  const [config, setConfig] = useState(clone(DEFAULT_BUILDER));
  const [identity, setIdentity] = useState({
    site_name: "Taskosphere",
    site_tagline: "One platform for tasks, finance, compliance and people.",
    logo_url: "/logo.png",
    footer_company: "Taskosphere",
    footer_text: "A configurable commercial business operating system.",
    footer_copyright: "© 2026 Taskosphere. All rights reserved."
  });
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [selectedId, setSelectedId] = useState("hero");
  const [activeTool, setActiveTool] = useState("pages");
  const [preview, setPreview] = useState("desktop");
  const [dragId, setDragId] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobilePanel, setMobilePanel] = useState(null);
  const [showWelcome, setShowWelcome] = useState(true);

  const page = useMemo(() => config.pages.find((p) => p.id === config.activePageId) || config.pages[0], [config]);
  const selected = page?.sections.find((x) => x.id === selectedId) || page?.sections[0];

  const commit = (next) => {
    setHistory((h) => [...h.slice(-39), clone(config)]);
    setFuture([]);
    setConfig(next);
  };
  const updatePage = (mutator) => {
    const next = clone(config);
    const p = next.pages.find((x) => x.id === next.activePageId);
    if (!p) return;
    mutator(p);
    commit(next);
  };
  const patchSection = (patch, meta = {}) => updatePage((p) => {
    const item = p.sections.find((x) => x.id === selectedId);
    if (!item) return;
    Object.assign(item, meta);
    item.data = { ...(item.data || {}), ...patch };
  });
  const patchStyle = (patch) => updatePage((p) => {
    const item = p.sections.find((x) => x.id === selectedId);
    if (!item) return;
    item.style = { ...(item.style || {}), ...patch };
  });

  const addSection = (type) => {
    const next = clone(config);
    const p = next.pages.find((x) => x.id === next.activePageId);
    if (!p) return;
    const id = uid(type);
    p.sections.push({
      id,
      type,
      title: SECTION_TYPES.find((x) => x[0] === type)?.[1] || type,
      visible: true,
      layout: "default",
      data: fieldFor(type)
    });
    commit(next);
    setSelectedId(id);
    setActiveTool("modules");
    setMobilePanel(null);
  };
  const deleteSection = (id) => {
    if (page.sections.length <= 1) return toast.error("Keep at least one section on the page.");
    const next = clone(config);
    const p = next.pages.find((x) => x.id === next.activePageId);
    p.sections = p.sections.filter((x) => x.id !== id);
    commit(next);
    setSelectedId(p.sections[Math.max(0, p.sections.length - 1)]?.id);
  };
  const duplicateSection = (id) => {
    const next = clone(config);
    const p = next.pages.find((x) => x.id === next.activePageId);
    const i = p.sections.findIndex((x) => x.id === id);
    if (i < 0) return;
    const copy = clone(p.sections[i]);
    copy.id = uid(copy.type);
    copy.title = `${copy.title || copy.type} Copy`;
    p.sections.splice(i + 1, 0, copy);
    commit(next);
    setSelectedId(copy.id);
  };
  const moveSection = (id, dir) => {
    const next = clone(config);
    const p = next.pages.find((x) => x.id === next.activePageId);
    const i = p.sections.findIndex((x) => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= p.sections.length) return;
    [p.sections[i], p.sections[j]] = [p.sections[j], p.sections[i]];
    commit(next);
  };
  const dropSection = (targetId) => {
    if (!dragId || dragId === targetId) return;
    const next = clone(config);
    const p = next.pages.find((x) => x.id === next.activePageId);
    const from = p.sections.findIndex((x) => x.id === dragId);
    const to = p.sections.findIndex((x) => x.id === targetId);
    if (from < 0 || to < 0) return;
    const [item] = p.sections.splice(from, 1);
    p.sections.splice(to, 0, item);
    commit(next);
    setDragId(null);
  };

  const addPage = () => {
    const id = uid("page");
    const next = clone(config);
    const firstSection = { id: uid("hero"), type: "hero", title: "Hero", visible: true, layout: "split", data: fieldFor("hero") };
    next.pages.push({ id, name: "New Page", slug: `/${id.replace("page_", "page-")}`, visible: true, sections: [firstSection] });
    next.activePageId = id;
    commit(next);
    setSelectedId(firstSection.id);
    setActiveTool("pages");
  };
  const renamePage = (id) => {
    const p = config.pages.find((x) => x.id === id);
    const name = window.prompt("Give this page a simple name", p?.name || "Page");
    if (!name?.trim()) return;
    const next = clone(config);
    next.pages.find((x) => x.id === id).name = name.trim();
    commit(next);
  };
  const duplicatePage = (id) => {
    const source = config.pages.find((x) => x.id === id);
    if (!source) return;
    const next = clone(config);
    const copy = clone(source);
    copy.id = uid("page");
    copy.name = `${source.name} Copy`;
    copy.slug = `${source.slug}-copy`;
    copy.sections = copy.sections.map((x) => ({ ...x, id: uid(x.type) }));
    next.pages.push(copy);
    next.activePageId = copy.id;
    commit(next);
    setSelectedId(copy.sections[0]?.id);
  };
  const deletePage = (id) => {
    if (config.pages.length <= 1) return toast.error("Your website must have at least one page.");
    const next = clone(config);
    next.pages = next.pages.filter((x) => x.id !== id);
    if (next.activePageId === id) next.activePageId = next.pages[0].id;
    commit(next);
    setSelectedId(next.pages[0]?.sections[0]?.id);
  };
  const setActivePage = (id) => {
    const p = config.pages.find((x) => x.id === id);
    if (!p) return;
    const next = clone(config);
    next.activePageId = id;
    commit(next);
    setSelectedId(p.sections[0]?.id);
  };

  const undo = () => {
    if (!history.length) return;
    const h = [...history];
    const previous = h.pop();
    setFuture((f) => [clone(config), ...f.slice(0, 39)]);
    setHistory(h);
    setConfig(previous);
  };
  const redo = () => {
    if (!future.length) return;
    const f = [...future];
    const next = f.shift();
    setHistory((h) => [...h.slice(-39), clone(config)]);
    setFuture(f);
    setConfig(next);
  };

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const saved = await getAdminWebsiteConfig();
        if (!alive) return;
        if (saved?.builder?.pages?.length) {
          setConfig({
            ...clone(DEFAULT_BUILDER),
            ...saved.builder,
            global: {
              ...DEFAULT_BUILDER.global,
              ...saved.builder.global,
              design: { ...DEFAULT_BUILDER.global.design, ...saved.builder.global?.design },
              header: { ...DEFAULT_BUILDER.global.header, ...saved.builder.global?.header },
              footer: { ...DEFAULT_BUILDER.global.footer, ...saved.builder.global?.footer }
            },
            pages: saved.builder.pages
          });
        }
        if (saved) {
          setIdentity((x) => ({
            ...x,
            site_name: saved.site_name || x.site_name,
            site_tagline: saved.site_tagline || x.site_tagline,
            logo_url: saved.logo_url || x.logo_url,
            footer_company: saved.footer_company || x.footer_company,
            footer_text: saved.footer_text || x.footer_text,
            footer_copyright: saved.footer_copyright || x.footer_copyright
          }));
        }
      } catch {
        toast.error("Unable to load Website Studio");
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveWebsiteConfig({
        ...identity,
        primary_color: config.global.design.primary,
        accent_color: config.global.design.accent,
        builder: config
      });
      if (saved?.builder?.pages?.length) setConfig((c) => ({ ...c, ...saved.builder }));
      toast.success("Website saved successfully");
    } catch (error) {
      toast.error(error?.response?.data?.detail || "Unable to save website");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset the website to the default template?")) return;
    try {
      const data = await resetWebsiteConfig();
      setConfig(clone(DEFAULT_BUILDER));
      setHistory([]);
      setFuture([]);
      setSelectedId("hero");
      if (data) setIdentity((x) => ({ ...x, site_name: data.site_name || x.site_name, site_tagline: data.site_tagline || x.site_tagline, logo_url: data.logo_url || x.logo_url }));
      toast.success("Website reset");
    } catch {
      toast.error("Unable to reset website");
    }
  };

  const applyPalette = (p) => {
    const next = clone(config);
    next.global.design.primary = p[1];
    next.global.design.accent = p[2];
    next.global.design.background = p[3];
    next.global.design.text = p[4];
    commit(next);
  };
  const setIdentityField = (key, value) => setIdentity((x) => ({ ...x, [key]: value }));
  const sectionLabel = (type) => SECTION_TYPES.find((x) => x[0] === type)?.[1] || type;
  const sectionDescription = {
    hero: "Large opening area with headline and buttons.",
    features: "Show your products, services or capabilities.",
    text: "Add simple information, policies or company content.",
    pricing: "Display plans, packages or commercial options.",
    imageText: "Tell a story using text beside an image.",
    image: "Place a large image or banner.",
    gallery: "Show several photos in a clean gallery.",
    video: "Embed a YouTube, Vimeo or MP4 video.",
    testimonials: "Add customer or client feedback.",
    faq: "Answer common questions.",
    form: "Collect enquiries from visitors.",
    cta: "Finish a page with a clear action.",
    divider: "Add visual separation between sections."
  };

  const moduleGroups = [
    { title: "Content", types: ["hero", "text", "imageText", "image", "gallery"] },
    { title: "Business", types: ["features", "pricing", "testimonials", "faq", "form", "cta"] },
    { title: "Media", types: ["video", "divider"] }
  ];

  if (!loaded) {
    return <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Loading Website Studio…</div>;
  }

  const tools = [
    ["pages", LayoutGrid, "Pages", "Create pages and control your site structure"],
    ["modules", Plus, "Modules", "Add or rearrange website blocks"],
    ["design", Palette, "Design", "Change colors, fonts and overall style"],
    ["settings", Settings2, "Settings", "Logo, website name, footer and options"]
  ];

  const renderToolPanel = () => {
    if (activeTool === "pages") {
      return <div className="space-y-4 p-4">
        <div className="flex items-center justify-between">
          <div><h2 className="text-sm font-extrabold text-slate-900">Your pages</h2><p className="mt-1 text-[11px] leading-5 text-slate-500">Think of each page as one screen of your website.</p></div>
          <button type="button" onClick={addPage} className="inline-flex items-center gap-1.5 bg-blue-600 px-3 py-2 text-[11px] font-bold text-white hover:bg-blue-700"><Plus size={14}/> New page</button>
        </div>
        <div className="space-y-2">
          {config.pages.map((p) => <div key={p.id} className={`group border ${p.id === config.activePageId ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-white hover:border-slate-300"}`}>
            <button type="button" onClick={() => setActivePage(p.id)} className="flex w-full min-w-0 items-center gap-3 px-3 py-3 text-left">
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center text-xs font-extrabold ${p.id === config.activePageId ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-500"}`}>{p.name.slice(0, 1).toUpperCase()}</div>
              <div className="min-w-0 flex-1"><div className="truncate text-xs font-bold text-slate-800">{p.name}</div><div className="truncate text-[10px] text-slate-400">{p.slug}</div></div>
              {p.id === config.activePageId && <Check size={15} className="shrink-0 text-blue-600"/>}
            </button>
            <div className="flex items-center gap-3 border-t border-slate-100 px-3 py-2 opacity-0 transition group-hover:opacity-100">
              <button type="button" onClick={() => renamePage(p.id)} className="text-[10px] font-bold text-slate-500 hover:text-blue-600">Rename</button>
              <button type="button" onClick={() => duplicatePage(p.id)} className="text-[10px] font-bold text-slate-500 hover:text-blue-600">Duplicate</button>
              <button type="button" onClick={() => deletePage(p.id)} className="ml-auto text-[10px] font-bold text-red-500">Delete</button>
            </div>
          </div>)}
        </div>
        <div className="border border-dashed border-slate-300 bg-slate-50 p-3 text-[11px] leading-5 text-slate-500"><b className="text-slate-700">Simple rule:</b> Pages are for major areas like Home, About, Services and Contact.</div>
      </div>;
    }
    if (activeTool === "modules") {
      return <div className="space-y-4 p-4">
        <div><h2 className="text-sm font-extrabold text-slate-900">Website modules</h2><p className="mt-1 text-[11px] leading-5 text-slate-500">Click a module to add it. You can edit everything after adding it.</p></div>
        {moduleGroups.map((group) => <div key={group.title}><div className="mb-2 text-[10px] font-extrabold uppercase tracking-[.14em] text-slate-400">{group.title}</div><div className="space-y-2">{group.types.map((type) => <button key={type} type="button" onClick={() => addSection(type)} className="flex w-full items-center gap-3 border border-slate-200 bg-white px-3 py-3 text-left hover:border-blue-300 hover:bg-blue-50/40">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-blue-50 text-blue-600"><Plus size={15}/></div>
          <div className="min-w-0 flex-1"><div className="text-xs font-bold text-slate-800">{sectionLabel(type)}</div><div className="mt-0.5 text-[10px] leading-4 text-slate-500">{sectionDescription[type]}</div></div>
        </button>)}</div></div>)}
        <div className="border border-blue-100 bg-blue-50 p-3 text-[11px] leading-5 text-blue-800">You do not need to know HTML or code. Add a module, select it in the preview, and edit the fields on the right.</div>
      </div>;
    }
    if (activeTool === "design") {
      return <div className="space-y-5 p-4">
        <div><h2 className="text-sm font-extrabold text-slate-900">Website design</h2><p className="mt-1 text-[11px] leading-5 text-slate-500">Choose a ready-made look or adjust individual colors.</p></div>
        <div><div className="mb-2 text-[10px] font-extrabold uppercase tracking-[.14em] text-slate-400">Quick themes</div><div className="grid grid-cols-2 gap-2">{palettes.map((p) => <button key={p[0]} type="button" onClick={() => applyPalette(p)} className="border border-slate-200 bg-white p-2 text-left hover:border-blue-400"><div className="mb-2 flex gap-1"><span className="h-6 flex-1" style={{background:p[1]}}/><span className="h-6 w-7" style={{background:p[2]}}/></div><span className="text-[10px] font-bold text-slate-700">{p[0]}</span></button>)}</div></div>
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <ColorField label="Primary color" value={config.global.design.primary} onChange={(v) => { const n=clone(config); n.global.design.primary=v; commit(n); }}/>
          <ColorField label="Accent color" value={config.global.design.accent} onChange={(v) => { const n=clone(config); n.global.design.accent=v; commit(n); }}/>
          <ColorField label="Page background" value={config.global.design.background} onChange={(v) => { const n=clone(config); n.global.design.background=v; commit(n); }}/>
          <ColorField label="Text color" value={config.global.design.text} onChange={(v) => { const n=clone(config); n.global.design.text=v; commit(n); }}/>
          <label className="block"><span className="mb-1.5 block text-[11px] font-semibold text-slate-600">Website width</span><select value={config.global.design.width || "wide"} onChange={(e) => { const n=clone(config); n.global.design.width=e.target.value; commit(n); }} className="h-10 w-full rounded-none border border-slate-300 bg-white px-3 text-sm"><option value="wide">Wide</option><option value="compact">Compact</option><option value="full">Full width</option></select></label>
        </div>
        <div className="border border-emerald-100 bg-emerald-50 p-3 text-[11px] leading-5 text-emerald-800"><b>Tip:</b> Start with a theme. Only change individual colors if you need your own brand palette.</div>
      </div>;
    }
    return <div className="space-y-5 p-4">
      <div><h2 className="text-sm font-extrabold text-slate-900">Website settings</h2><p className="mt-1 text-[11px] leading-5 text-slate-500">Basic information visitors see across your website.</p></div>
      <TextField label="Website name" value={identity.site_name} onChange={(v) => setIdentityField("site_name", v)}/>
      <TextField label="Short tagline" value={identity.site_tagline} onChange={(v) => setIdentityField("site_tagline", v)}/>
      <UploadField label="Website logo" value={identity.logo_url} onChange={(v) => setIdentityField("logo_url", v)}/>
      <div className="border-t border-slate-100 pt-4"><div className="mb-3 text-[10px] font-extrabold uppercase tracking-[.14em] text-slate-400">Footer</div><div className="space-y-3"><TextField label="Company name" value={identity.footer_company} onChange={(v) => setIdentityField("footer_company", v)}/><TextField label="Footer description" value={identity.footer_text} area onChange={(v) => setIdentityField("footer_text", v)}/><TextField label="Copyright" value={identity.footer_copyright} onChange={(v) => setIdentityField("footer_copyright", v)}/></div></div>
      <button type="button" onClick={reset} className="w-full border border-red-200 bg-red-50 px-3 py-2.5 text-xs font-bold text-red-600 hover:bg-red-100">Reset to default website</button>
    </div>;
  };

  if (!page) return null;

  return <div className="flex h-screen min-h-0 flex-col overflow-hidden bg-slate-100 text-slate-900">
    <header className="z-50 flex min-h-[64px] shrink-0 items-center border-b border-slate-200 bg-white px-3 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-[#0D3B66] text-white"><Globe2 size={18}/></div>
        <div className="min-w-0"><div className="text-sm font-extrabold">Website Studio</div><div className="truncate text-[11px] text-slate-400">{identity.site_name} · {page.name}</div></div>
      </div>
      <div className="hidden items-center gap-2 lg:flex">
        <div className="flex items-center border border-slate-200 bg-slate-50 p-0.5">
          <button type="button" onClick={undo} disabled={!history.length} className="px-2.5 py-1.5 text-[11px] font-bold text-slate-500 disabled:opacity-30">Undo</button>
          <button type="button" onClick={redo} disabled={!future.length} className="border-l border-slate-200 px-2.5 py-1.5 text-[11px] font-bold text-slate-500 disabled:opacity-30">Redo</button>
        </div>
        {["desktop","tablet","mobile"].map((mode) => <button key={mode} type="button" onClick={() => setPreview(mode)} className={`border px-2.5 py-1.5 text-[11px] font-bold ${preview===mode ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-white text-slate-500"}`}>{mode[0].toUpperCase()+mode.slice(1)}</button>)}
        <a href="/" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 border border-slate-200 bg-white px-3 py-2 text-[11px] font-bold text-slate-600 hover:bg-slate-50"><Eye size={14}/> Preview site</a>
        <button type="button" onClick={save} disabled={saving} className="inline-flex items-center gap-1.5 bg-emerald-600 px-4 py-2 text-[11px] font-extrabold text-white hover:bg-emerald-700 disabled:opacity-60"><Save size={14}/>{saving ? "Saving…" : "Save changes"}</button>
      </div>
      <div className="flex items-center gap-1 lg:hidden"><button type="button" onClick={save} disabled={saving} className="bg-emerald-600 px-3 py-2 text-[11px] font-bold text-white">{saving ? "Saving…" : "Save"}</button></div>
    </header>

    {showWelcome && <div className="z-40 flex shrink-0 items-center gap-3 border-b border-blue-100 bg-blue-50 px-4 py-2.5 text-[11px] text-blue-900">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center bg-blue-600 text-white"><Check size={13}/></div>
      <div className="min-w-0 flex-1"><b>Build your website in 4 simple steps:</b> choose a page → add modules → edit the selected module → save.</div>
      <button type="button" onClick={() => setShowWelcome(false)} className="shrink-0 px-2 py-1 font-bold text-blue-600 hover:bg-blue-100">Got it</button>
    </div>}

    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="hidden w-[82px] shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-100 px-2 py-3 text-center text-[9px] font-extrabold uppercase tracking-[.12em] text-slate-400">Build</div>
        <div className="flex-1 space-y-1 p-2">{tools.map(([id, Icon, label]) => <button key={id} type="button" onClick={() => setActiveTool(id)} className={`flex w-full flex-col items-center gap-1 border px-1 py-2.5 text-[9px] font-bold ${activeTool===id ? "border-blue-200 bg-blue-50 text-blue-700" : "border-transparent text-slate-500 hover:border-slate-200 hover:bg-slate-50"}`}><Icon size={18}/>{label}</button>)}</div>
        <div className="border-t border-slate-100 p-2"><button type="button" onClick={() => { setActiveTool("modules"); setMobilePanel("add"); }} className="flex w-full flex-col items-center gap-1 border border-dashed border-slate-300 py-2 text-[9px] font-bold text-blue-600"><Plus size={17}/>Add</button></div>
      </aside>

      <aside className="hidden w-[270px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white lg:block">{renderToolPanel()}</aside>

      <main className="min-w-0 flex-1 overflow-hidden bg-[#e9edf2]">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-[50px] shrink-0 items-center justify-between border-b border-slate-200 bg-white px-3 sm:px-5">
            <div className="min-w-0"><div className="truncate text-xs font-extrabold text-slate-700">{page.name}</div><div className="truncate text-[10px] text-slate-400">{page.slug} · {page.sections.length} modules</div></div>
            <div className="text-[10px] font-semibold text-slate-400">Click any module in the preview to edit it</div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-2 sm:p-5">
            <div className={`mx-auto overflow-hidden bg-white shadow-xl transition-all ${preview==="desktop" ? "w-full max-w-[1280px]" : preview==="tablet" ? "w-[768px] max-w-full" : "w-[390px] max-w-full"}`}>
              <WebsiteRenderer builder={config} identity={identity} editor selectedSectionId={selectedId} onSelectSection={(id) => { if (id) { setSelectedId(id); setActiveTool("modules"); } }} />
            </div>
          </div>
        </div>
      </main>

      <aside className="hidden w-[350px] shrink-0 overflow-y-auto border-l border-slate-200 bg-white xl:block">
        {selected ? <div className="p-4">
          <div className="mb-4 border-b border-slate-100 pb-4">
            <div className="flex items-center justify-between gap-3"><div className="min-w-0"><div className="text-[10px] font-extrabold uppercase tracking-[.14em] text-blue-600">Selected module</div><div className="mt-1 truncate text-sm font-extrabold text-slate-900">{selected.title || sectionLabel(selected.type)}</div></div><button type="button" onClick={() => duplicateSection(selected.id)} className="border border-slate-200 p-2 text-slate-500 hover:bg-slate-50" title="Duplicate module"><Copy size={14}/></button></div>
            <div className="mt-3 flex items-center gap-2"><button type="button" onClick={() => patchSection({}, { visible: selected.visible === false })} className="flex-1 border border-slate-200 px-2 py-2 text-[10px] font-bold text-slate-600">{selected.visible === false ? "Show module" : "Hide module"}</button><button type="button" onClick={() => deleteSection(selected.id)} className="border border-red-200 bg-red-50 px-3 py-2 text-[10px] font-bold text-red-600">Delete</button></div>
          </div>
          <SectionEditor section={selected} patchData={patchSection} patchStyle={patchStyle}/>
          <div className="mt-5 grid grid-cols-2 gap-2 border-t border-slate-100 pt-4"><button type="button" onClick={() => moveSection(selected.id,-1)} className="border border-slate-200 px-2 py-2 text-[10px] font-bold text-slate-600">Move up</button><button type="button" onClick={() => moveSection(selected.id,1)} className="border border-slate-200 px-2 py-2 text-[10px] font-bold text-slate-600">Move down</button></div>
        </div> : <div className="p-5 text-xs text-slate-500">Select a module in the preview to edit it.</div>}
      </aside>

      <div className="fixed bottom-0 left-0 right-0 z-50 flex border-t border-slate-200 bg-white p-1.5 md:hidden">
        {[["pages",LayoutGrid,"Pages"],["modules",Plus,"Modules"],["design",Palette,"Design"],["settings",Settings2,"Settings"]].map(([id,Icon,label]) => <button key={id} type="button" onClick={() => setMobilePanel(id)} className={`flex flex-1 flex-col items-center gap-0.5 py-1 text-[9px] font-bold ${activeTool===id ? "text-blue-600" : "text-slate-500"}`}><Icon size={17}/>{label}</button>)}
        <button type="button" onClick={() => { setSelectedId(selected?.id); setMobilePanel("section"); }} className="flex flex-1 flex-col items-center gap-0.5 py-1 text-[9px] font-bold text-emerald-600"><Type size={17}/>Edit</button>
      </div>

      {mobilePanel && (
        <div className="fixed inset-0 z-[60] bg-slate-950/35 md:hidden" onClick={() => setMobilePanel(null)}>
          <div className="absolute inset-x-0 bottom-0 max-h-[88vh] overflow-y-auto bg-white p-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
              <div className="text-sm font-extrabold text-slate-900">
                {mobilePanel === "section" ? "Edit module" : tools.find((x) => x[0] === mobilePanel)?.[2]}
              </div>
              <button type="button" onClick={() => setMobilePanel(null)} className="p-1 text-slate-500"><X size={18}/></button>
            </div>
            {mobilePanel === "section" ? (
              selected ? <SectionEditor section={selected} patchData={patchSection} patchStyle={patchStyle}/> : <div className="text-xs text-slate-500">Select a module first.</div>
            ) : renderToolPanel()}
          </div>
        </div>
      )}      </div>
    </div>
  </div>;
}
