import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, ChevronRight, Copy, Eye, FileImage,
  GripVertical, ImagePlus, LayoutTemplate, Monitor, Palette, Plus, Redo2, Save, Settings2,
  Smartphone, Sparkles, Trash2, Type, Undo2, Upload, Video, X, Globe2, Menu, Home,
  PanelLeft, ExternalLink, RefreshCcw, Download, Share2, Layers, Tablet, CheckCircle2,
  CreditCard, MessageSquare, Phone, Mail, MapPin, AlignLeft, Sliders, ShieldCheck
} from "lucide-react";
import { toast } from "sonner";
import {
  getAdminWebsiteConfig,
  resetWebsiteConfig,
  saveWebsiteConfig,
  downloadWebsiteConfigJSON,
  downloadWebsiteHTML
} from "@/lib/websiteApi";

const clone = (v) => JSON.parse(JSON.stringify(v));
const uid = (p = "item") => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const SECTION_TYPES = [
  ["hero", "Hero Banner", "High-impact main headline, call-to-action & imagery", Sparkles],
  ["features", "Platform Modules", "Showcase platform modules or core service features", LayoutTemplate],
  ["pricing", "Pricing Plans", "Highlight packages, commercial licenses or subscription tiers", CreditCard],
  ["text", "Content / Story", "Rich heading and descriptive body text", Type],
  ["imageText", "Media + Story", "Side-by-side screenshot or illustration with description", LayoutTemplate],
  ["testimonials", "Client Reviews", "Social proof and testimonials from verified clients", MessageSquare],
  ["faq", "FAQ Accordion", "Answers to frequent questions in expandable rows", ChevronDown],
  ["cta", "Call to Action", "High-conversion banner with buttons and next step", ArrowRight],
  ["form", "Contact Form", "Lead capture or inquiry form with contact details", Mail],
  ["image", "Full Image", "Full-width screenshot, banner or diagram", FileImage],
  ["gallery", "Photo Gallery", "Grid of product photos or office imagery", ImagePlus],
  ["video", "Video Showcase", "Embed YouTube, Vimeo or MP4 walkthrough", Video],
  ["divider", "Divider", "Clean separator line between sections", GripVertical]
];

const THEME_PALETTES = [
  { name: "Taskosphere Navy & Emerald", primary: "#0D3B66", accent: "#1FAF5A", bg: "#FFFFFF", text: "#0F172A" },
  { name: "Executive Slate & Cyan", primary: "#0F172A", accent: "#0EA5E9", bg: "#FFFFFF", text: "#0F172A" },
  { name: "Modern Indigo & Violet", primary: "#1E1B4B", accent: "#6366F1", bg: "#FFFFFF", text: "#0F172A" },
  { name: "Forest Emerald & Teal", primary: "#064E3B", accent: "#10B981", bg: "#FFFFFF", text: "#0F172A" },
  { name: "Deep Royal Sapphire", primary: "#172554", accent: "#3B82F6", bg: "#FFFFFF", text: "#0F172A" },
  { name: "Corporate Crimson", primary: "#450A0A", accent: "#EF4444", bg: "#FFFFFF", text: "#0F172A" }
];

const DEFAULT_BUILDER = {
  version: 5,
  activePageId: "home",
  pages: [{
    id: "home", name: "Home", slug: "/", visible: true,
    sections: [
      { id: "hero", type: "hero", title: "Hero", visible: true, layout: "split", theme: "executive", data: {
        badge: "THE MODERN BUSINESS OPERATING SYSTEM",
        title: "Everything your business needs. Nothing scattered.",
        subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
        primaryText: "Explore Taskosphere", primaryHref: "#features",
        secondaryText: "Sign in", secondaryHref: "/login", image: "/logo-transparent.png",
        theme: "executive"
      } },
      { id: "features", type: "features", title: "Platform Modules", visible: true, layout: "cards", data: {
        heading: "One platform. Every business function.",
        subtitle: "Choose the exact software package your customer needs and activate it through your commercial license.",
        items: [
          { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility.", route: "/tasks" },
          { title: "Invoicing & Billing", description: "Quotations, invoices, purchases and customer billing.", route: "/invoicing" },
          { title: "Accounting & Banking", description: "Ledgers, banking, financial reports and audit controls.", route: "/accounting-reports" },
          { title: "HRMS & People", description: "Attendance, leave, payroll, recruitment and staff activity.", route: "/people-matrix" },
          { title: "Compliance & GST", description: "GST reconciliation, ROC filing, trademark and legal dates.", route: "/compliance-dashboard" },
          { title: "Client Records", description: "Client records, DSC repository, document register and approvals.", route: "/records-dashboard" },
          { title: "AI & Automation", description: "Intelligent document processing and operational assistance.", route: "/ai-reader" }
        ]
      } },
      { id: "why", type: "text", title: "Why Taskosphere", visible: true, data: {
        heading: "Run work from one connected workspace",
        body: "Assign and track work, communicate with your team, manage documents, monitor productivity and keep financial and compliance operations connected — without scattering information across different systems."
      } },
      { id: "pricing", type: "pricing", title: "Pricing & Licenses", visible: true, data: {
        heading: "Transparent Commercial Licensing",
        subtitle: "Activate standalone modular packages or deploy the complete enterprise business suite.",
        items: [
          { name: "Starter Suite", price: "₹4,999", period: "/ month", description: "Ideal for growing agencies and independent firms needing tasks, billing and client records.", featured: false },
          { name: "Professional Suite", price: "₹9,999", period: "/ month", description: "Complete enterprise stack including Invoicing, Full Accounting, HRMS and Compliance.", featured: true },
          { name: "Enterprise Custom", price: "Custom", period: "/ year", description: "Dedicated Cloud deployment, custom SLA, WhatsApp gateway and tailored integrations.", featured: false }
        ]
      } },
      { id: "cta", type: "cta", title: "Call to Action", visible: true, layout: "center", data: {
        heading: "Ready to build your Taskosphere workspace?", text: "Configure the modules your business needs and get started today.", button: "Sign in to workspace", href: "/login"
      } }
    ]
  }],
  global: {
    header: { sticky: true, showLogin: true, logo: true },
    footer: { show: true, text: "A configurable commercial business operating system.", social: true },
    design: { primary: "#0D3B66", accent: "#1FAF5A", background: "#FFFFFF", text: "#0F172A", font: "Plus Jakarta Sans", radius: "medium", width: "wide" }
  },
  media: []
};

const DEFAULT_IDENTITY = {
  site_name: "Taskosphere",
  site_tagline: "One platform for tasks, finance, compliance and people.",
  logo_url: "/logo.png",
  favicon_url: "/favicon.png",
  seo_title: "Taskosphere — Business Operating System",
  seo_description: "Task management, invoicing, accounting, HRMS and compliance in one connected platform.",
  seo_og_image: "",
  footer_company: "Taskosphere",
  footer_text: "A configurable commercial business operating system.",
  footer_email: "support@taskosphere.com",
  footer_phone: "+91 98765 43210",
  footer_address: "Tech Hub, 4th Floor, Sector 62, India",
  footer_copyright: "© 2026 Taskosphere. All rights reserved."
};

function Field({ label, value, onChange, area = false, placeholder = "", helper = "" }) {
  const Tag = area ? "textarea" : "input";
  return (
    <label className="block">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <Tag
        value={value ?? ""}
        placeholder={placeholder}
        rows={area ? 4 : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm text-slate-800 transition outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
      />
      {helper && <span className="mt-1 block text-[11px] text-slate-400 leading-tight">{helper}</span>}
    </label>
  );
}

function MediaBox({ value, video = false, onChange, label }) {
  const choose = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };
  return (
    <div className="space-y-2">
      {label && <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</span>}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-1">
        {value ? (
          video ? (
            <div className="flex aspect-video items-center justify-center bg-slate-950 text-white rounded-lg">
              <Video size={24} />
              <span className="ml-2 max-w-[70%] truncate text-xs">{value}</span>
            </div>
          ) : (
            <img src={value} alt="Selected" className="max-h-36 w-full object-contain bg-slate-100 rounded-lg p-2" />
          )
        ) : (
          <div className="flex aspect-video items-center justify-center text-slate-300">
            <ImagePlus size={32} />
          </div>
        )}
      </div>
      <div className="flex gap-2">
        {!video && (
          <label className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:border-blue-500 hover:text-blue-600 transition">
            <Upload size={14} /> Upload image
            <input type="file" accept="image/*" className="hidden" onChange={(e) => choose(e.target.files?.[0])} />
          </label>
        )}
        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-red-500 hover:bg-red-50"
          >
            Clear
          </button>
        )}
      </div>
      <Field
        label={video ? "Video URL" : "Image URL or Path"}
        value={value}
        onChange={onChange}
        placeholder={video ? "https://youtube.com/embed/... or MP4" : "e.g. /logo-transparent.png or https://..."}
      />
    </div>
  );
}

function SectionEditor({ section, patchData }) {
  const d = section.data || {};

  if (section.type === "hero") {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
          <label className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Color Theme</label>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => patchData({ theme: "executive" })}
              className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${(d.theme === "executive" || !d.theme) ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-600"}`}
            >
              Executive Dark
            </button>
            <button
              type="button"
              onClick={() => patchData({ theme: "light" })}
              className={`rounded-lg border px-3 py-2 text-xs font-bold transition ${d.theme === "light" ? "border-blue-600 bg-blue-50 text-blue-800" : "border-slate-200 bg-white text-slate-600"}`}
            >
              Clean Light
            </button>
          </div>
        </div>
        <Field label="Top Badge / Eyebrow" value={d.badge} onChange={(v) => patchData({ badge: v })} />
        <Field label="Main Headline (H1)" value={d.title} onChange={(v) => patchData({ title: v })} />
        <Field label="Subtitle / Description" value={d.subtitle} area onChange={(v) => patchData({ subtitle: v })} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Primary Button Text" value={d.primaryText} onChange={(v) => patchData({ primaryText: v })} />
          <Field label="Primary Link" value={d.primaryHref} onChange={(v) => patchData({ primaryHref: v })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Secondary Button Text" value={d.secondaryText} onChange={(v) => patchData({ secondaryText: v })} />
          <Field label="Secondary Link" value={d.secondaryHref} onChange={(v) => patchData({ secondaryHref: v })} />
        </div>
        <MediaBox label="Hero Image / Graphic" value={d.image} onChange={(v) => patchData({ image: v })} />
      </div>
    );
  }

  if (section.type === "features") {
    return (
      <div className="space-y-4">
        <Field label="Section Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <Field label="Section Subtitle" value={d.subtitle} area onChange={(v) => patchData({ subtitle: v })} />
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Modules / Features List</span>
            <span className="text-[10px] text-slate-400">{(d.items || []).length} items</span>
          </div>
          {(d.items || []).map((item, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-700">Module #{i + 1}</span>
                <button
                  type="button"
                  onClick={() => patchData({ items: d.items.filter((_, idx) => idx !== i) })}
                  className="text-red-500 hover:text-red-700 p-1"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <Field
                label="Module Name"
                value={item.title}
                onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, title: v } : x) })}
              />
              <Field
                label="Description"
                value={item.description}
                area
                onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, description: v } : x) })}
              />
              <Field
                label="Internal Route (optional)"
                value={item.route || ""}
                onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, route: v } : x) })}
                placeholder="e.g. /tasks, /invoicing"
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => patchData({ items: [...(d.items || []), { title: "New Module", description: "Describe the module benefits.", route: "" }] })}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-400 bg-blue-50/50 py-2.5 text-xs font-bold text-blue-600 hover:bg-blue-50"
          >
            <Plus size={14} /> Add Module Card
          </button>
        </div>
      </div>
    );
  }

  if (section.type === "pricing") {
    return (
      <div className="space-y-4">
        <Field label="Pricing Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <Field label="Pricing Subtitle" value={d.subtitle} area onChange={(v) => patchData({ subtitle: v })} />
        <div className="space-y-3">
          {(d.items || []).map((tier, i) => (
            <div key={i} className={`rounded-xl border p-3 space-y-2.5 ${tier.featured ? "border-blue-500 bg-blue-50/40" : "border-slate-200 bg-slate-50"}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-800">Tier #{i + 1}</span>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={Boolean(tier.featured)}
                      onChange={(e) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, featured: e.target.checked } : x) })}
                    />
                    Featured
                  </label>
                  <button
                    type="button"
                    onClick={() => patchData({ items: d.items.filter((_, idx) => idx !== i) })}
                    className="text-red-500 hover:text-red-700"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Tier Name" value={tier.name} onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, name: v } : x) })} />
                <Field label="Price" value={tier.price} onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, price: v } : x) })} />
              </div>
              <Field label="Billing Period" value={tier.period} onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, period: v } : x) })} placeholder="/ month or / year" />
              <Field label="Description" value={tier.description} area onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, description: v } : x) })} />
            </div>
          ))}
          <button
            type="button"
            onClick={() => patchData({ items: [...(d.items || []), { name: "Package Plan", price: "₹2,999", period: "/ month", description: "Plan details.", featured: false }] })}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-400 bg-blue-50/50 py-2.5 text-xs font-bold text-blue-600 hover:bg-blue-50"
          >
            <Plus size={14} /> Add Pricing Plan
          </button>
        </div>
      </div>
    );
  }

  if (section.type === "text") {
    return (
      <div className="space-y-4">
        <Field label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <Field label="Body Content" value={d.body} area onChange={(v) => patchData({ body: v })} />
      </div>
    );
  }

  if (section.type === "imageText") {
    return (
      <div className="space-y-4">
        <MediaBox label="Feature Graphic / Screenshot" value={d.src} onChange={(v) => patchData({ src: v })} />
        <Field label="Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <Field label="Body Story" value={d.body} area onChange={(v) => patchData({ body: v })} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Button Label" value={d.button} onChange={(v) => patchData({ button: v })} />
          <Field label="Button Link" value={d.href} onChange={(v) => patchData({ href: v })} />
        </div>
      </div>
    );
  }

  if (section.type === "testimonials") {
    return (
      <div className="space-y-4">
        <Field label="Section Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <div className="space-y-3">
          {(d.items || []).map((t, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => patchData({ items: d.items.filter((_, idx) => idx !== i) })}
                  className="text-red-500 hover:text-red-700"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Client Name" value={t.name} onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, name: v } : x) })} />
                <Field label="Role / Company" value={t.role} onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, role: v } : x) })} />
              </div>
              <Field label="Review Quote" value={t.quote} area onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, quote: v } : x) })} />
            </div>
          ))}
          <button
            type="button"
            onClick={() => patchData({ items: [...(d.items || []), { name: "Director", role: "Enterprise Client", quote: "Taskosphere streamlined our business." }] })}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-400 bg-blue-50/50 py-2.5 text-xs font-bold text-blue-600 hover:bg-blue-50"
          >
            <Plus size={14} /> Add Testimonial
          </button>
        </div>
      </div>
    );
  }

  if (section.type === "faq") {
    return (
      <div className="space-y-4">
        <Field label="FAQ Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <div className="space-y-3">
          {(d.items || []).map((q, i) => (
            <div key={i} className="rounded-xl border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => patchData({ items: d.items.filter((_, idx) => idx !== i) })}
                  className="text-red-500 hover:text-red-700"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <Field label="Question" value={q.question} onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, question: v } : x) })} />
              <Field label="Answer" value={q.answer} area onChange={(v) => patchData({ items: d.items.map((x, idx) => idx === i ? { ...x, answer: v } : x) })} />
            </div>
          ))}
          <button
            type="button"
            onClick={() => patchData({ items: [...(d.items || []), { question: "Can I customize the platform?", answer: "Yes, you can activate modules and configure branding." }] })}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-blue-400 bg-blue-50/50 py-2.5 text-xs font-bold text-blue-600 hover:bg-blue-50"
          >
            <Plus size={14} /> Add FAQ Question
          </button>
        </div>
      </div>
    );
  }

  if (section.type === "cta") {
    return (
      <div className="space-y-4">
        <Field label="Call to Action Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <Field label="Subtext" value={d.text} area onChange={(v) => patchData({ text: v })} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Button Label" value={d.button} onChange={(v) => patchData({ button: v })} />
          <Field label="Button Link" value={d.href} onChange={(v) => patchData({ href: v })} />
        </div>
      </div>
    );
  }

  if (section.type === "form") {
    return (
      <div className="space-y-4">
        <Field label="Form Heading" value={d.heading} onChange={(v) => patchData({ heading: v })} />
        <Field label="Form Description" value={d.body} area onChange={(v) => patchData({ body: v })} />
      </div>
    );
  }

  if (section.type === "image") {
    return (
      <div className="space-y-4">
        <MediaBox label="Full Width Image" value={d.src} onChange={(v) => patchData({ src: v })} />
        <Field label="Alt Text" value={d.alt} onChange={(v) => patchData({ alt: v })} />
      </div>
    );
  }

  if (section.type === "video") {
    return (
      <div className="space-y-4">
        <MediaBox video label="Video Embed" value={d.url} onChange={(v) => patchData({ url: v })} />
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-slate-50 p-4 text-xs text-slate-500">
      Section properties ready. Edit the content directly or reorder using the toolbar.
    </div>
  );
}

function PreviewCanvasSection({ section, design, isSelected, onClick }) {
  const d = section.data || {};
  const primary = design?.primary || "#0D3B66";
  const accent = design?.accent || "#1FAF5A";
  const isDarkHero = (d.theme === "executive" || !d.theme);

  return (
    <div
      onClick={onClick}
      className={`relative cursor-pointer transition-all duration-150 ${
        isSelected
          ? "ring-2 ring-blue-500 ring-offset-2 z-10"
          : "hover:ring-1 hover:ring-blue-300"
      }`}
    >
      {/* Floating Section Tag */}
      <div className="absolute top-2 left-3 z-20 opacity-0 transition group-hover:opacity-100 pointer-events-none">
        <span className="rounded-md bg-slate-900/80 px-2 py-1 text-[10px] font-bold text-white backdrop-blur">
          {section.title || section.type}
        </span>
      </div>

      {section.type === "hero" && (
        <section
          className={`relative overflow-hidden px-6 py-20 ${isDarkHero ? "text-white" : "bg-white text-slate-900"}`}
          style={{
            background: isDarkHero ? `linear-gradient(135deg, ${primary} 0%, #102A43 58%, #061827 100%)` : "#ffffff"
          }}
        >
          <div className={`mx-auto max-w-6xl grid items-center gap-10 ${section.layout === "center" ? "text-center" : "lg:grid-cols-2"}`}>
            <div>
              {d.badge && (
                <span
                  className={`inline-block px-3.5 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider mb-4 ${
                    isDarkHero ? "bg-white/10 text-white/90 border border-white/15" : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {d.badge}
                </span>
              )}
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-black tracking-tight leading-tight">
                {d.title || "Your Platform Headline"}
              </h1>
              <p className={`mt-5 text-base sm:text-lg leading-relaxed max-w-xl ${isDarkHero ? "text-white/75" : "text-slate-600"}`}>
                {d.subtitle || "Describe how your solution empowers customers."}
              </p>
              <div className={`mt-8 flex flex-wrap gap-3 ${section.layout === "center" ? "justify-center" : ""}`}>
                <span
                  className="px-5 py-3 rounded-xl font-bold text-xs sm:text-sm text-white shadow-md inline-flex items-center gap-2"
                  style={{ background: accent }}
                >
                  {d.primaryText || "Get Started"} <ArrowRight size={15} />
                </span>
                {d.secondaryText && (
                  <span
                    className={`px-5 py-3 rounded-xl font-bold text-xs sm:text-sm border ${
                      isDarkHero ? "border-white/20 bg-white/10 text-white" : "border-slate-300 text-slate-700"
                    }`}
                  >
                    {d.secondaryText}
                  </span>
                )}
              </div>
            </div>

            {section.layout !== "center" && (
              <div className="rounded-2xl border border-white/10 bg-white/10 p-3 shadow-xl backdrop-blur-xl">
                <div className="flex min-h-[260px] items-center justify-center rounded-xl bg-white/5 p-6">
                  {d.image ? (
                    <img src={d.image} alt="Hero" className="max-h-60 max-w-full object-contain" />
                  ) : (
                    <div className="flex flex-col items-center text-white/40">
                      <ImagePlus size={44} />
                      <span className="text-xs mt-2">Upload Hero Graphic</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      {section.type === "features" && (
        <section className="py-20 px-6 max-w-6xl mx-auto">
          <div className="text-center max-w-3xl mx-auto mb-14">
            <span className="text-xs font-bold uppercase tracking-widest" style={{ color: accent }}>Modules & Services</span>
            <h2 className="mt-2 text-2xl sm:text-3xl lg:text-4xl font-black text-slate-900">{d.heading || "Platform Modules"}</h2>
            <p className="mt-3 text-slate-600 text-sm sm:text-base leading-relaxed">{d.subtitle}</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {(d.items || []).map((item, i) => (
              <div key={i} className="p-6 rounded-2xl bg-white border border-slate-200/80 shadow-sm hover:shadow-md transition">
                <div className="h-10 w-10 rounded-xl flex items-center justify-center mb-4" style={{ background: `${accent}15`, color: accent }}>
                  <Sparkles size={18} />
                </div>
                <h3 className="text-base font-bold text-slate-900">{item.title}</h3>
                <p className="mt-2 text-xs sm:text-sm text-slate-500 leading-relaxed">{item.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {section.type === "pricing" && (
        <section className="py-20 px-6 bg-slate-50/70 border-y border-slate-100">
          <div className="max-w-6xl mx-auto">
            <div className="text-center max-w-2xl mx-auto mb-14">
              <span className="text-xs font-bold uppercase tracking-widest" style={{ color: accent }}>Pricing</span>
              <h2 className="mt-2 text-2xl sm:text-3xl font-black text-slate-900">{d.heading || "Commercial Licenses"}</h2>
              <p className="mt-3 text-slate-600 text-sm">{d.subtitle}</p>
            </div>
            <div className="grid md:grid-cols-3 gap-6">
              {(d.items || []).map((tier, i) => (
                <div
                  key={i}
                  className={`relative rounded-2xl p-7 border transition ${
                    tier.featured
                      ? "text-white shadow-xl scale-105"
                      : "bg-white border-slate-200 shadow-sm"
                  }`}
                  style={tier.featured ? { background: primary, borderColor: primary } : {}}
                >
                  {tier.featured && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full px-3 py-0.5 text-[10px] font-black uppercase tracking-wider bg-emerald-500 text-white shadow">
                      Recommended
                    </span>
                  )}
                  <h3 className="text-lg font-bold">{tier.name}</h3>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-3xl font-black">{tier.price}</span>
                    <span className="text-xs opacity-70">{tier.period}</span>
                  </div>
                  <p className="mt-4 text-xs leading-relaxed opacity-80">{tier.description}</p>
                  <div
                    className="mt-6 block rounded-xl px-4 py-2.5 text-center text-xs font-bold"
                    style={{
                      background: tier.featured ? "white" : primary,
                      color: tier.featured ? "#0f172a" : "white"
                    }}
                  >
                    Get started
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {section.type === "text" && (
        <section className="py-16 px-6 max-w-4xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-black text-slate-900">{d.heading}</h2>
          <p className="mt-5 text-slate-600 text-sm sm:text-base leading-relaxed whitespace-pre-wrap">{d.body}</p>
        </section>
      )}

      {section.type === "imageText" && (
        <section className="py-16 px-6 max-w-6xl mx-auto grid md:grid-cols-2 gap-10 items-center">
          <div>
            {d.src ? (
              <img src={d.src} alt="Visual" className="rounded-2xl max-h-80 w-full object-cover shadow-md" />
            ) : (
              <div className="aspect-video rounded-2xl bg-slate-100 flex items-center justify-center text-slate-400">
                <ImagePlus size={36} />
              </div>
            )}
          </div>
          <div>
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900">{d.heading}</h2>
            <p className="mt-4 text-slate-600 text-sm sm:text-base leading-relaxed whitespace-pre-wrap">{d.body}</p>
            {d.button && (
              <span
                className="mt-6 inline-flex rounded-xl px-5 py-2.5 text-xs font-bold text-white shadow"
                style={{ background: primary }}
              >
                {d.button}
              </span>
            )}
          </div>
        </section>
      )}

      {section.type === "testimonials" && (
        <section className="py-20 px-6 text-white" style={{ background: primary }}>
          <div className="max-w-6xl mx-auto">
            <h2 className="text-2xl sm:text-3xl font-black text-center">{d.heading || "What Clients Say"}</h2>
            <div className="mt-10 grid md:grid-cols-3 gap-5">
              {(d.items || []).map((item, i) => (
                <div key={i} className="rounded-2xl border border-white/10 bg-white/10 p-6 backdrop-blur">
                  <p className="text-xs sm:text-sm leading-relaxed text-white/85">“{item.quote}”</p>
                  <div className="mt-5 font-bold text-sm">{item.name}</div>
                  <div className="text-xs text-white/50">{item.role}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {section.type === "faq" && (
        <section className="py-16 px-6 max-w-4xl mx-auto">
          <h2 className="text-2xl sm:text-3xl font-black text-slate-900 text-center">{d.heading || "Frequently Asked Questions"}</h2>
          <div className="mt-8 space-y-3">
            {(d.items || []).map((q, i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="font-bold text-sm text-slate-800">{q.question}</div>
                <div className="mt-2 text-xs sm:text-sm text-slate-500 leading-relaxed">{q.answer}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {section.type === "cta" && (
        <section className="py-16 px-6">
          <div className="max-w-5xl mx-auto rounded-3xl p-10 sm:p-14 text-center text-white shadow-xl" style={{ background: `linear-gradient(135deg, ${primary}, #061827)` }}>
            <h2 className="text-2xl sm:text-3xl sm:text-4xl font-black">{d.heading}</h2>
            <p className="mt-4 max-w-xl mx-auto text-sm sm:text-base text-white/80 leading-relaxed">{d.text}</p>
            <div className="mt-8">
              <span className="inline-flex rounded-xl bg-white px-6 py-3 text-xs sm:text-sm font-black text-slate-900 shadow-md">
                {d.button || "Get Started"}
              </span>
            </div>
          </div>
        </section>
      )}

      {section.type === "form" && (
        <section className="py-16 px-6 max-w-4xl mx-auto">
          <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
            <h2 className="text-2xl font-black text-slate-900">{d.heading || "Contact Us"}</h2>
            <p className="mt-2 text-sm text-slate-500">{d.body}</p>
            <div className="mt-6 grid sm:grid-cols-2 gap-4">
              <input className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs" placeholder="Full Name" readOnly />
              <input className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs" placeholder="Email Address" readOnly />
              <textarea className="sm:col-span-2 rounded-xl border border-slate-200 px-4 py-2.5 text-xs" rows={3} placeholder="Message" readOnly />
              <button type="button" className="rounded-xl px-5 py-2.5 text-xs font-bold text-white w-fit" style={{ background: primary }}>
                Send Message
              </button>
            </div>
          </div>
        </section>
      )}

      {section.type === "divider" && (
        <div className="max-w-6xl mx-auto px-6 py-4">
          <div className="h-px bg-slate-200" />
        </div>
      )}
    </div>
  );
}

export default function WebsiteBuilder() {
  const [config, setConfig] = useState(clone(DEFAULT_BUILDER));
  const [identity, setIdentity] = useState(clone(DEFAULT_IDENTITY));
  const [history, setHistory] = useState([]);
  const [future, setFuture] = useState([]);
  const [activeTab, setActiveTab] = useState("sections"); // "pages" | "sections" | "design" | "settings"
  const [selectedSectionId, setSelectedSectionId] = useState("hero");
  const [device, setDevice] = useState("desktop"); // "desktop" | "tablet" | "mobile"
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exportCopied, setExportCopied] = useState(false);

  // Load initial config from API or local storage
  useEffect(() => {
    (async () => {
      try {
        const saved = await getAdminWebsiteConfig();
        if (saved) {
          setIdentity({
            ...clone(DEFAULT_IDENTITY),
            ...Object.fromEntries(
              Object.keys(DEFAULT_IDENTITY)
                .map((k) => [k, saved[k]])
                .filter(([, v]) => v !== undefined && v !== null)
            )
          });
          const builder = saved.builder;
          if (builder && Array.isArray(builder.pages) && builder.pages.length) {
            setConfig({
              ...clone(DEFAULT_BUILDER),
              ...builder,
              global: {
                ...DEFAULT_BUILDER.global,
                ...builder.global,
                design: { ...DEFAULT_BUILDER.global.design, ...builder.global?.design }
              },
              pages: builder.pages
            });
          }
        }
      } catch (e) {
        console.error("Failed to load website config:", e);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const activePage = useMemo(
    () => config.pages.find((p) => p.id === config.activePageId) || config.pages[0],
    [config]
  );

  const selectedSection = useMemo(
    () => activePage?.sections.find((s) => s.id === selectedSectionId) || activePage?.sections[0],
    [activePage, selectedSectionId]
  );

  useEffect(() => {
    if (selectedSection && !activePage.sections.some((s) => s.id === selectedSectionId)) {
      setSelectedSectionId(selectedSection.id);
    }
  }, [activePage, selectedSection, selectedSectionId]);

  const commit = (updater) => {
    setHistory((h) => [...h.slice(-25), clone(config)]);
    setFuture([]);
    setConfig((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      return next;
    });
  };

  const patchPage = (patch) =>
    commit((prev) => ({
      ...prev,
      pages: prev.pages.map((p) => (p.id === activePage.id ? { ...p, ...patch } : p))
    }));

  const patchSection = (id, patch) =>
    commit((prev) => ({
      ...prev,
      pages: prev.pages.map((p) =>
        p.id === activePage.id
          ? {
              ...p,
              sections: p.sections.map((s) => (s.id === id ? { ...s, ...patch } : s))
            }
          : p
      )
    }));

  const patchSectionData = (patch) => {
    if (!selectedSection) return;
    patchSection(selectedSection.id, {
      data: { ...selectedSection.data, ...patch }
    });
  };

  const patchDesign = (patch) =>
    commit((prev) => ({
      ...prev,
      global: {
        ...prev.global,
        design: { ...prev.global.design, ...patch }
      }
    }));

  const patchGlobal = (patch) =>
    commit((prev) => ({
      ...prev,
      global: { ...prev.global, ...patch }
    }));

  const patchIdentity = (patch) => setIdentity((prev) => ({ ...prev, ...patch }));

  const undo = () => {
    if (!history.length) return;
    const prev = history[history.length - 1];
    setFuture((f) => [clone(config), ...f]);
    setHistory(history.slice(0, -1));
    setConfig(prev);
  };

  const redo = () => {
    if (!future.length) return;
    const next = future[0];
    setHistory((h) => [...h, clone(config)]);
    setFuture(future.slice(1));
    setConfig(next);
  };

  const addSection = (type) => {
    const sectionMeta = SECTION_TYPES.find((x) => x[0] === type);
    const newSec = {
      id: uid(type),
      type,
      title: sectionMeta ? sectionMeta[1] : type,
      visible: true,
      layout: "split",
      data: {}
    };

    if (type === "hero") {
      newSec.data = {
        badge: "WELCOME TO TASKOSPHERE",
        title: "Your Platform Headline",
        subtitle: "Empower your business with smart digital workflows.",
        primaryText: "Get Started",
        primaryHref: "/login",
        secondaryText: "Learn More",
        secondaryHref: "#",
        theme: "executive"
      };
    } else if (type === "features") {
      newSec.data = {
        heading: "Platform Modules",
        subtitle: "Everything your organization needs in one place.",
        items: [
          { title: "Core Operations", description: "Manage workflows seamlessly." },
          { title: "Finance & Accounting", description: "Real-time ledgers and invoicing." },
          { title: "Automations", description: "Save hours every week with automated jobs." }
        ]
      };
    } else if (type === "pricing") {
      newSec.data = {
        heading: "Simple, Transparent Plans",
        subtitle: "Choose the package tailored to your size.",
        items: [
          { name: "Starter", price: "₹2,499", period: "/mo", description: "Essential tools for small teams." },
          { name: "Pro", price: "₹5,999", period: "/mo", description: "Complete suite with all modules.", featured: true }
        ]
      };
    } else if (type === "text") {
      newSec.data = {
        heading: "About Our Business",
        body: "Add your organization mission and story here."
      };
    } else if (type === "testimonials") {
      newSec.data = {
        heading: "Client Reviews",
        items: [{ name: "Rajesh Kumar", role: "CEO, TechCorp", quote: "Taskosphere changed how we handle all daily operations." }]
      };
    } else if (type === "faq") {
      newSec.data = {
        heading: "Frequently Asked Questions",
        items: [{ question: "How easy is setup?", answer: "Setup takes under 2 minutes." }]
      };
    } else if (type === "cta") {
      newSec.data = {
        heading: "Ready to get started?",
        text: "Join thousands of businesses managing everything in Taskosphere.",
        button: "Explore Platform",
        href: "/login"
      };
    }

    patchPage({ sections: [...(activePage.sections || []), newSec] });
    setSelectedSectionId(newSec.id);
    setShowAddModal(false);
    toast.success(`Added ${newSec.title} section`);
  };

  const moveSection = (dir) => {
    if (!selectedSection) return;
    const list = [...activePage.sections];
    const i = list.findIndex((s) => s.id === selectedSection.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    patchPage({ sections: list });
  };

  const duplicateSection = () => {
    if (!selectedSection) return;
    const i = activePage.sections.findIndex((s) => s.id === selectedSection.id);
    const copy = {
      ...clone(selectedSection),
      id: uid(selectedSection.type),
      title: `${selectedSection.title} (Copy)`
    };
    const list = [...activePage.sections];
    list.splice(i + 1, 0, copy);
    patchPage({ sections: list });
    setSelectedSectionId(copy.id);
    toast.success("Section duplicated");
  };

  const deleteSection = (id = selectedSection?.id) => {
    if (!id) return;
    const remaining = activePage.sections.filter((s) => s.id !== id);
    patchPage({ sections: remaining });
    if (selectedSectionId === id) {
      setSelectedSectionId(remaining[0]?.id || "");
    }
    toast.success("Section removed");
  };

  const addPage = () => {
    const pageNum = config.pages.length + 1;
    const id = uid("page");
    const newP = {
      id,
      name: `Page ${pageNum}`,
      slug: `/page-${pageNum}`,
      visible: true,
      sections: [
        {
          id: uid("hero"),
          type: "hero",
          title: "Hero",
          visible: true,
          layout: "split",
          data: {
            badge: "NEW PAGE",
            title: `Welcome to Page ${pageNum}`,
            subtitle: "Customize your new page layout and content.",
            primaryText: "Learn More",
            primaryHref: "#"
          }
        },
        {
          id: uid("text"),
          type: "text",
          title: "Content",
          visible: true,
          data: {
            heading: "Page Information",
            body: "Add your detailed page content here."
          }
        }
      ]
    };
    commit((prev) => ({
      ...prev,
      pages: [...prev.pages, newP],
      activePageId: id
    }));
    setSelectedSectionId(newP.sections[0].id);
    toast.success(`Created ${newP.name}`);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...identity,
        primary_color: config.global?.design?.primary,
        accent_color: config.global?.design?.accent,
        builder: config
      };
      await saveWebsiteConfig(payload);
      toast.success("Website successfully saved and published live!");
    } catch (e) {
      toast.error(e?.response?.data?.detail || e?.message || "Unable to save website");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm("Reset website to the default template? This will revert all custom sections and colors.")) {
      return;
    }
    try {
      await resetWebsiteConfig();
      setConfig(clone(DEFAULT_BUILDER));
      setIdentity(clone(DEFAULT_IDENTITY));
      setHistory([]);
      setFuture([]);
      setSelectedSectionId("hero");
      toast.success("Website reset to default template");
    } catch (e) {
      toast.error("Failed to reset website");
    }
  };

  const handleDownloadJSON = () => {
    const payload = {
      ...identity,
      primary_color: config.global?.design?.primary,
      accent_color: config.global?.design?.accent,
      builder: config
    };
    downloadWebsiteConfigJSON(payload, "taskosphere-website-config.json");
    toast.success("Downloaded website config JSON file");
    setShowExportMenu(false);
  };

  const handleDownloadHTML = () => {
    const payload = {
      ...identity,
      primary_color: config.global?.design?.primary,
      accent_color: config.global?.design?.accent,
      builder: config
    };
    downloadWebsiteHTML(payload, "taskosphere-website.html");
    toast.success("Downloaded standalone website HTML file");
    setShowExportMenu(false);
  };

  const handleCopyJSON = () => {
    const payload = {
      ...identity,
      primary_color: config.global?.design?.primary,
      accent_color: config.global?.design?.accent,
      builder: config
    };
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setExportCopied(true);
    setTimeout(() => setExportCopied(false), 2000);
    toast.success("Copied website configuration to clipboard");
  };

  if (!loaded) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-900 text-white">
        <div className="flex items-center gap-3">
          <Sparkles className="animate-spin text-emerald-400" size={24} />
          <span className="font-bold text-sm">Loading Website Studio…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-slate-100" style={{ fontFamily: config.global?.design?.font || "Plus Jakarta Sans" }}>
      {/* 1. TOP APP BAR - Site123 Header */}
      <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 shadow-sm z-30">
        {/* Left: Brand & Page Selector */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5">
            <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#0D3B66] text-white shadow">
              <Sparkles size={18} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-sm font-black text-slate-900 tracking-tight">Taskosphere Studio</h1>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700 border border-emerald-200">
                  Live Sync
                </span>
              </div>
              <p className="text-[10px] text-slate-400 font-medium">Site123 Management Edition</p>
            </div>
          </div>

          <div className="h-6 w-px bg-slate-200" />

          {/* Quick Page Switcher */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-400">Page:</span>
            <select
              value={config.activePageId}
              onChange={(e) => {
                const pId = e.target.value;
                commit((prev) => ({ ...prev, activePageId: pId }));
                setSelectedSectionId(config.pages.find((p) => p.id === pId)?.sections[0]?.id || "");
              }}
              className="rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100 outline-none focus:border-blue-500"
            >
              {config.pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.sections.length} sections)
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Center: Device Switcher & History */}
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl bg-slate-100 p-1 border border-slate-200">
            <button
              type="button"
              onClick={() => setDevice("desktop")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                device === "desktop" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
              title="Desktop View"
            >
              <Monitor size={15} /> Desktop
            </button>
            <button
              type="button"
              onClick={() => setDevice("tablet")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                device === "tablet" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
              title="Tablet View"
            >
              <Tablet size={15} /> Tablet
            </button>
            <button
              type="button"
              onClick={() => setDevice("mobile")}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                device === "mobile" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
              title="Mobile View"
            >
              <Smartphone size={15} /> Mobile
            </button>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={undo}
              disabled={!history.length}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              title="Undo"
            >
              <Undo2 size={16} />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!future.length}
              className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
              title="Redo"
            >
              <Redo2 size={16} />
            </button>
          </div>
        </div>

        {/* Right: Export Menu & Save & Publish */}
        <div className="flex items-center gap-2">
          {/* Download / Export dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowExportMenu(!showExportMenu)}
              className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 shadow-sm"
            >
              <Download size={14} className="text-slate-500" />
              Download / Share
              <ChevronDown size={13} />
            </button>

            {showExportMenu && (
              <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-slate-200 bg-white p-2 shadow-xl z-50">
                <div className="px-3 py-2 border-b border-slate-100 mb-1">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Shareable Files</div>
                  <div className="text-xs font-semibold text-slate-700">Uncompressed (No Zip)</div>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadJSON}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 text-left"
                >
                  <Download size={15} className="text-blue-600" />
                  <div>
                    <div>Download Config (.json)</div>
                    <div className="text-[10px] font-normal text-slate-400">Pure schema file to backup or share</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleDownloadHTML}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 text-left"
                >
                  <Globe2 size={15} className="text-emerald-600" />
                  <div>
                    <div>Download Webpage (.html)</div>
                    <div className="text-[10px] font-normal text-slate-400">Single self-contained HTML file</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleCopyJSON}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 text-left"
                >
                  <Copy size={15} className="text-purple-600" />
                  <div>
                    <div>{exportCopied ? "Copied!" : "Copy JSON to Clipboard"}</div>
                    <div className="text-[10px] font-normal text-slate-400">Instant clipboard paste</div>
                  </div>
                </button>
              </div>
            )}
          </div>

          <a
            href="/"
            target="_blank"
            rel="noopener noreferrer"
            className="hidden sm:flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 hover:bg-slate-50 shadow-sm"
            title="Open Live Public Website"
          >
            <Eye size={14} className="text-slate-500" />
            Live Preview
          </a>

          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 px-4 py-2 text-xs font-black text-white shadow-md transition disabled:opacity-60"
          >
            {saving ? (
              <>
                <Sparkles size={14} className="animate-spin" /> Saving…
              </>
            ) : (
              <>
                <Save size={14} /> Publish Website
              </>
            )}
          </button>
        </div>
      </header>

      {/* 2. THREE-PANE MAIN WORKSPACE */}
      <div className="grid min-h-0 flex-1 grid-cols-[72px_280px_minmax(400px,1fr)_340px] overflow-hidden">
        {/* TAB 1: SITE123 PRIMARY DOCK (72px) */}
        <aside className="border-r border-slate-800 bg-[#0F172A] text-white flex flex-col justify-between p-2 z-20">
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveTab("sections")}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-2 py-3 text-[10px] font-bold transition ${
                activeTab === "sections" ? "bg-white text-[#0D3B66] shadow" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              <Layers size={20} />
              <span>Sections</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("pages")}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-2 py-3 text-[10px] font-bold transition ${
                activeTab === "pages" ? "bg-white text-[#0D3B66] shadow" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              <PanelLeft size={20} />
              <span>Pages</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("design")}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-2 py-3 text-[10px] font-bold transition ${
                activeTab === "design" ? "bg-white text-[#0D3B66] shadow" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              <Palette size={20} />
              <span>Design</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("settings")}
              className={`flex w-full flex-col items-center gap-1 rounded-xl px-2 py-3 text-[10px] font-bold transition ${
                activeTab === "settings" ? "bg-white text-[#0D3B66] shadow" : "text-slate-300 hover:bg-white/10"
              }`}
            >
              <Settings2 size={20} />
              <span>Settings</span>
            </button>
          </div>

          <div className="border-t border-white/10 pt-2 space-y-1">
            <button
              type="button"
              onClick={reset}
              className="flex w-full flex-col items-center gap-1 rounded-xl px-2 py-2 text-[10px] font-bold text-slate-400 hover:bg-white/10 hover:text-white"
              title="Reset Website"
            >
              <RefreshCcw size={16} />
              <span>Reset</span>
            </button>
          </div>
        </aside>

        {/* TAB 2: SECONDARY PANEL (280px) - Sections / Pages / Design / Settings */}
        <div className="border-r border-slate-200 bg-white flex flex-col min-h-0 z-10 shadow-sm">
          {/* SECTIONS TAB */}
          {activeTab === "sections" && (
            <div className="flex flex-col h-full min-h-0">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Page Structure</div>
                  <h2 className="text-sm font-black text-slate-900">{activePage.name} Sections</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="flex items-center gap-1 rounded-xl bg-[#0D3B66] px-3 py-1.5 text-xs font-bold text-white shadow hover:bg-blue-900"
                >
                  <Plus size={14} /> Add
                </button>
              </div>

              {/* Sections List */}
              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {activePage.sections.map((section, idx) => {
                  const isSelected = selectedSectionId === section.id;
                  const isVisible = section.visible !== false;

                  return (
                    <div
                      key={section.id}
                      onClick={() => setSelectedSectionId(section.id)}
                      className={`group rounded-xl border p-3 cursor-pointer transition ${
                        isSelected
                          ? "border-blue-500 bg-blue-50/50 shadow-sm"
                          : "border-slate-200 bg-white hover:border-slate-300"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div
                            className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 ${
                              isSelected ? "bg-blue-600 text-white" : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            <Layers size={14} />
                          </div>
                          <div className="min-w-0">
                            <span className="block truncate text-xs font-bold text-slate-800">
                              {section.title || section.type}
                            </span>
                            <span className="text-[10px] text-slate-400 capitalize">{section.type}</span>
                          </div>
                        </div>

                        {/* Quick actions */}
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              patchSection(section.id, { visible: !isVisible });
                            }}
                            className={`p-1 text-slate-400 hover:text-slate-700 ${!isVisible ? "opacity-40" : ""}`}
                            title={isVisible ? "Hide Section" : "Show Section"}
                          >
                            <Eye size={14} />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteSection(section.id);
                            }}
                            className="p-1 text-slate-400 hover:text-red-600"
                            title="Delete Section"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={() => setShowAddModal(true)}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 py-3 text-xs font-bold text-slate-600 hover:border-blue-500 hover:text-blue-600"
                >
                  <Plus size={15} /> Add New Section
                </button>
              </div>
            </div>
          )}

          {/* PAGES TAB */}
          {activeTab === "pages" && (
            <div className="flex flex-col h-full min-h-0">
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Site Hierarchy</div>
                  <h2 className="text-sm font-black text-slate-900">Pages</h2>
                </div>
                <button
                  type="button"
                  onClick={addPage}
                  className="flex items-center gap-1 rounded-xl bg-[#0D3B66] px-3 py-1.5 text-xs font-bold text-white shadow hover:bg-blue-900"
                >
                  <Plus size={14} /> Add Page
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {config.pages.map((p) => {
                  const isActive = p.id === config.activePageId;
                  return (
                    <div
                      key={p.id}
                      className={`rounded-xl border p-3 transition ${
                        isActive ? "border-blue-500 bg-blue-50/50 shadow-sm" : "border-slate-200 bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          commit((prev) => ({ ...prev, activePageId: p.id }));
                          setSelectedSectionId(p.sections[0]?.id || "");
                        }}
                        className="flex w-full items-center justify-between text-left"
                      >
                        <div className="flex items-center gap-2">
                          <Home size={15} className={isActive ? "text-blue-600" : "text-slate-400"} />
                          <div>
                            <div className="text-xs font-bold text-slate-800">{p.name}</div>
                            <div className="text-[10px] text-slate-400">{p.slug}</div>
                          </div>
                        </div>
                        {isActive && <CheckCircle2 size={16} className="text-blue-600" />}
                      </button>

                      {isActive && (
                        <div className="mt-3 flex items-center gap-2 border-t border-slate-100 pt-2 text-[11px]">
                          <button
                            type="button"
                            onClick={() => {
                              const name = window.prompt("Rename page:", p.name);
                              if (name?.trim()) {
                                commit((prev) => ({
                                  ...prev,
                                  pages: prev.pages.map((item) =>
                                    item.id === p.id ? { ...item, name: name.trim() } : item
                                  )
                                }));
                              }
                            }}
                            className="font-bold text-slate-600 hover:text-slate-900"
                          >
                            Rename
                          </button>
                          <span className="text-slate-300">·</span>
                          <button
                            type="button"
                            onClick={() => {
                              const slug = window.prompt("Page URL slug:", p.slug);
                              if (slug?.trim()) {
                                commit((prev) => ({
                                  ...prev,
                                  pages: prev.pages.map((item) =>
                                    item.id === p.id ? { ...item, slug: slug.trim() } : item
                                  )
                                }));
                              }
                            }}
                            className="font-bold text-slate-600 hover:text-slate-900"
                          >
                            Edit URL
                          </button>
                          <span className="text-slate-300">·</span>
                          <button
                            type="button"
                            disabled={config.pages.length === 1}
                            onClick={() => {
                              if (window.confirm(`Delete page "${p.name}"?`)) {
                                const remaining = config.pages.filter((item) => item.id !== p.id);
                                commit((prev) => ({
                                  ...prev,
                                  pages: remaining,
                                  activePageId: remaining[0].id
                                }));
                                setSelectedSectionId(remaining[0].sections[0]?.id || "");
                              }
                            }}
                            className="font-bold text-red-500 hover:text-red-700 disabled:opacity-30"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* DESIGN TAB */}
          {activeTab === "design" && (
            <div className="flex flex-col h-full min-h-0 overflow-y-auto p-4 space-y-6">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Design System</div>
                <h2 className="text-sm font-black text-slate-900 mt-0.5">Colors & Theme</h2>
              </div>

              {/* Palette Presets */}
              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Color Presets</span>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {THEME_PALETTES.map((pal) => (
                    <button
                      key={pal.name}
                      type="button"
                      onClick={() => patchDesign({ primary: pal.primary, accent: pal.accent })}
                      className="flex items-center gap-2 rounded-xl border border-slate-200 p-2 text-left hover:border-blue-400 transition"
                    >
                      <div className="flex -space-x-1.5">
                        <div className="h-5 w-5 rounded-full border border-white shadow" style={{ background: pal.primary }} />
                        <div className="h-5 w-5 rounded-full border border-white shadow" style={{ background: pal.accent }} />
                      </div>
                      <span className="text-[10px] font-bold text-slate-700 truncate">{pal.name}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Custom Colors */}
              <div className="space-y-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Custom Colors</span>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Primary Color</label>
                    <div className="flex items-center gap-2 rounded-xl border border-slate-200 p-1.5">
                      <input
                        type="color"
                        value={config.global?.design?.primary || "#0D3B66"}
                        onChange={(e) => patchDesign({ primary: e.target.value })}
                        className="h-7 w-7 rounded-lg border-0 cursor-pointer"
                      />
                      <span className="text-xs font-mono font-bold text-slate-700">{config.global?.design?.primary}</span>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-slate-600 block mb-1">Accent Color</label>
                    <div className="flex items-center gap-2 rounded-xl border border-slate-200 p-1.5">
                      <input
                        type="color"
                        value={config.global?.design?.accent || "#1FAF5A"}
                        onChange={(e) => patchDesign({ accent: e.target.value })}
                        className="h-7 w-7 rounded-lg border-0 cursor-pointer"
                      />
                      <span className="text-xs font-mono font-bold text-slate-700">{config.global?.design?.accent}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Typography */}
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Typography Font</span>
                <select
                  value={config.global?.design?.font || "Plus Jakarta Sans"}
                  onChange={(e) => patchDesign({ font: e.target.value })}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 outline-none"
                >
                  <option value="Plus Jakarta Sans">Plus Jakarta Sans (Modern & Clean)</option>
                  <option value="Inter">Inter (System Tech)</option>
                  <option value="Outfit">Outfit (Geometric Display)</option>
                  <option value="Montserrat">Montserrat (Corporate Bold)</option>
                  <option value="Roboto">Roboto (Standard)</option>
                </select>
              </div>

              {/* Header Toggles */}
              <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Header Settings</span>
                <label className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>Sticky Header</span>
                  <input
                    type="checkbox"
                    checked={config.global?.header?.sticky !== false}
                    onChange={(e) => patchGlobal({ header: { ...config.global.header, sticky: e.target.checked } })}
                  />
                </label>
                <label className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>Show Sign In Button</span>
                  <input
                    type="checkbox"
                    checked={config.global?.header?.showLogin !== false}
                    onChange={(e) => patchGlobal({ header: { ...config.global.header, showLogin: e.target.checked } })}
                  />
                </label>
              </div>
            </div>
          )}

          {/* SETTINGS TAB */}
          {activeTab === "settings" && (
            <div className="flex flex-col h-full min-h-0 overflow-y-auto p-4 space-y-4">
              <div>
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Configuration</div>
                <h2 className="text-sm font-black text-slate-900 mt-0.5">Website Identity</h2>
              </div>

              <Field label="Website Name" value={identity.site_name} onChange={(v) => patchIdentity({ site_name: v })} />
              <Field label="Tagline" value={identity.site_tagline} onChange={(v) => patchIdentity({ site_tagline: v })} />
              <MediaBox label="Logo" value={identity.logo_url} onChange={(v) => patchIdentity({ logo_url: v })} />
              <Field label="Support Email" value={identity.footer_email} onChange={(v) => patchIdentity({ footer_email: v })} />
              <Field label="Phone / WhatsApp" value={identity.footer_phone} onChange={(v) => patchIdentity({ footer_phone: v })} />
              <Field label="Office Address" value={identity.footer_address} onChange={(v) => patchIdentity({ footer_address: v })} />
              <Field label="Copyright Line" value={identity.footer_copyright} onChange={(v) => patchIdentity({ footer_copyright: v })} />
            </div>
          )}
        </div>

        {/* TAB 3: CENTER CANVAS - Live WYSIWYG Viewport */}
        <main className="flex-1 overflow-y-auto bg-slate-200/80 p-6 flex flex-col items-center">
          {/* Responsive viewport container */}
          <div
            className={`transition-all duration-200 bg-white shadow-2xl rounded-2xl overflow-hidden border border-slate-300/80 flex flex-col ${
              device === "mobile"
                ? "w-[390px] min-h-[780px]"
                : device === "tablet"
                ? "w-[768px] min-h-[900px]"
                : "w-full max-w-5xl min-h-[900px]"
            }`}
          >
            {/* Live Website Header */}
            <header className="sticky top-0 z-20 flex items-center justify-between border-b border-slate-100 bg-white/95 px-6 py-3.5 backdrop-blur">
              <div className="flex items-center gap-2.5">
                {identity.logo_url && (
                  <img src={identity.logo_url} alt="Logo" className="h-8 w-auto object-contain" />
                )}
                <div>
                  <span className="font-bold text-slate-900 text-sm">{identity.site_name}</span>
                </div>
              </div>
              <nav className="hidden sm:flex items-center gap-5 text-xs font-semibold text-slate-600">
                {config.pages.map((p) => (
                  <span
                    key={p.id}
                    onClick={() => {
                      commit((prev) => ({ ...prev, activePageId: p.id }));
                      setSelectedSectionId(p.sections[0]?.id || "");
                    }}
                    className={`cursor-pointer hover:text-slate-900 ${
                      p.id === activePage.id ? "text-blue-600 font-bold" : ""
                    }`}
                  >
                    {p.name}
                  </span>
                ))}
              </nav>
              {config.global?.header?.showLogin !== false && (
                <span
                  className="rounded-xl px-3.5 py-1.5 text-xs font-bold text-white shadow-sm"
                  style={{ background: config.global?.design?.primary || "#0D3B66" }}
                >
                  Sign In
                </span>
              )}
            </header>

            {/* Sections Content */}
            <div className="flex-1">
              {activePage.sections
                .filter((s) => s.visible !== false)
                .map((section) => (
                  <PreviewCanvasSection
                    key={section.id}
                    section={section}
                    design={config.global?.design}
                    isSelected={selectedSectionId === section.id}
                    onClick={() => setSelectedSectionId(section.id)}
                  />
                ))}
            </div>

            {/* Live Footer */}
            {config.global?.footer?.show !== false && (
              <footer className="border-t border-slate-200 bg-slate-50 px-6 py-8 mt-auto text-xs text-slate-500">
                <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
                  <div>
                    <div className="font-bold text-slate-800">{identity.footer_company || identity.site_name}</div>
                    <div className="text-slate-400 mt-0.5">{identity.footer_text}</div>
                  </div>
                  <div className="text-right">
                    <div>{identity.footer_copyright}</div>
                    <div className="text-slate-400 mt-0.5">{[identity.footer_email, identity.footer_phone].filter(Boolean).join(" · ")}</div>
                  </div>
                </div>
              </footer>
            )}
          </div>
        </main>

        {/* TAB 4: RIGHT INSPECTOR - Section Deep Content & Property Editor */}
        <aside className="border-l border-slate-200 bg-white flex flex-col min-h-0 z-10 shadow-sm">
          {selectedSection ? (
            <div className="flex flex-col h-full min-h-0">
              {/* Header */}
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Content Editor</div>
                  <h2 className="text-sm font-black text-slate-900 truncate max-w-[180px]">
                    {selectedSection.title || selectedSection.type}
                  </h2>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveSection(-1)}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                    title="Move Section Up"
                  >
                    <ArrowUp size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSection(1)}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                    title="Move Section Down"
                  >
                    <ArrowDown size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={duplicateSection}
                    className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                    title="Duplicate Section"
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSection(selectedSection.id)}
                    className="p-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"
                    title="Delete Section"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>

              {/* Layout Switcher if applicable */}
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 flex items-center justify-between">
                <span className="text-[11px] font-bold text-slate-500">Layout Format</span>
                <select
                  value={selectedSection.layout || "split"}
                  onChange={(e) => patchSection(selectedSection.id, { layout: e.target.value })}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs font-bold text-slate-700"
                >
                  <option value="split">Split (Side-by-side)</option>
                  <option value="center">Centered</option>
                  <option value="cards">Card Grid</option>
                </select>
              </div>

              {/* Form Fields */}
              <div className="flex-1 overflow-y-auto p-4">
                <SectionEditor section={selectedSection} patchData={patchSectionData} />
              </div>
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center p-6 text-center text-slate-400">
              <Layers size={36} className="mb-3 text-slate-300" />
              <p className="text-xs font-bold text-slate-600">No Section Selected</p>
              <p className="text-[11px] mt-1">Click on any section in the center canvas to edit its text, colors and images.</p>
            </div>
          )}
        </aside>
      </div>

      {/* ADD SECTION MODAL (Site123 Section Catalog) */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-white p-6 shadow-2xl border border-slate-100 max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div>
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Section Library</span>
                <h3 className="text-lg font-black text-slate-900">Add a Section to {activePage.name}</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="grid h-8 w-8 place-items-center rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200"
              >
                <X size={16} />
              </button>
            </div>

            <div className="grid sm:grid-cols-2 gap-3 overflow-y-auto py-4 flex-1">
              {SECTION_TYPES.map(([type, label, desc, Icon]) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => addSection(type)}
                  className="flex items-start gap-3 rounded-2xl border border-slate-200 p-3.5 text-left hover:border-blue-500 hover:bg-blue-50/50 transition group"
                >
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-slate-100 text-slate-600 group-hover:bg-blue-600 group-hover:text-white transition shrink-0">
                    <Icon size={20} />
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900 group-hover:text-blue-600">{label}</div>
                    <div className="text-[11px] text-slate-400 leading-tight mt-0.5">{desc}</div>
                  </div>
                </button>
              ))}
            </div>

            <div className="border-t border-slate-100 pt-3 text-right">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
