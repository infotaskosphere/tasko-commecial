import React from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  Check,
  Play,
  Quote,
  Pencil,
  Copy,
  ChevronUp,
  ChevronDown,
  Trash2,
  Eye,
  EyeOff,
  Image as ImageIcon
} from "lucide-react";

export const DEFAULT_BUILDER = {
  version: 6,
  activePageId: "home",
  pages: [{
    id: "home", name: "Home", slug: "/", visible: true,
    sections: [
      { id: "hero", type: "hero", title: "Hero", visible: true, layout: "split", data: {
        badge: "THE MODERN BUSINESS OPERATING SYSTEM",
        title: "Everything your business needs. Nothing scattered.",
        subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
        primaryText: "Explore ONENEXA", primaryHref: "#modules", secondaryText: "Sign in", secondaryHref: "/login", image: "/onenexa-logo.png", theme: "executive"
      }},
      { id: "features", type: "features", title: "Platform Modules", visible: true, layout: "cards", data: {
        heading: "One platform. Every business function.", subtitle: "Choose the capabilities your business needs and activate them through your commercial license.",
        items: [
          { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility.", route: "/tasks" },
          { title: "Invoicing & Billing", description: "Quotations, invoices, purchases and customer billing.", route: "/invoicing" },
          { title: "Accounting & Banking", description: "Ledgers, banking, financial reports and audit controls.", route: "/accounting-reports" },
          { title: "HRMS & People", description: "Attendance, leave, payroll, recruitment and staff activity.", route: "/people-matrix" },
          { title: "Compliance & GST", description: "GST reconciliation, ROC, trademark and legal dates.", route: "/compliance-dashboard" },
          { title: "Client Records", description: "Client records, DSC repository, documents and approvals.", route: "/records-dashboard" },
          { title: "AI & Automation", description: "Intelligent document processing and operational assistance.", route: "/ai-reader" }
        ]
      }},
      { id: "why", type: "text", title: "Why ONENEXA", visible: true, data: { heading: "Run your business from one connected workspace", body: "Assign and track work, communicate with your team, manage documents, monitor productivity and keep financial and compliance operations connected — without scattering information across different systems." }},
      { id: "pricing", type: "pricing", title: "Pricing & Licenses", visible: true, data: { heading: "Transparent Commercial Licensing", subtitle: "Activate standalone modular packages or deploy the complete enterprise business suite.", items: [
        { name: "Starter Suite", price: "₹4,999", period: "/ month", description: "Tasks, billing and client records.", featured: false },
        { name: "Professional Suite", price: "₹9,999", period: "/ month", description: "Invoicing, accounting, HRMS and compliance.", featured: true },
        { name: "Enterprise Custom", price: "Custom", period: "/ year", description: "Dedicated cloud, integrations and tailored workflows.", featured: false }
      ]}},
      { id: "cta", type: "cta", title: "Call to Action", visible: true, data: { heading: "Ready to build your ONENEXA workspace?", text: "Configure the capabilities your business needs and get started today.", button: "Sign in to workspace", href: "/login" }}
    ]
  }],
  global: {
    header: {
      sticky: true,
      showLogin: true,
      logo: true,
      loginText: "Sign in",
      buttonText: "Sign in",
      buttonHref: "/login",
      items: [
        { label: "Home", destination: "/" },
        { label: "About", destination: "#about" },
        { label: "Services", destination: "#features" },
        { label: "Pricing", destination: "#pricing" },
        { label: "Contact", destination: "#contact" }
      ]
    },
    footer: {
      show: true,
      company: "ONENEXA",
      text: "A configurable commercial business operating system.",
      copyright: "© 2026 ONENEXA. All rights reserved.",
      email: "",
      phone: "",
      address: "",
      socials: {
        instagram: "",
        facebook: "",
        linkedin: "",
        youtube: "",
        x: "",
        whatsapp: ""
      }
    },
    design: {
      primary: "#102A56",
      accent: "#16C7A2",
      background: "#FFFFFF",
      text: "#0F172A",
      font: "Plus Jakarta Sans",
      radius: "16",
      width: "wide"
    }
  },
  media: []
};

const pageIdForNav = (builder) => builder?.activePageId || builder?.pages?.[0]?.id || "home";

const cssUrl = (url) => url ? `url("${String(url).replace(/"/g, '\\"')}")` : "none";

export const sectionStyle = (section, design = {}) => {
  const s = section?.style || {};
  return {
    backgroundColor: s.backgroundColor || "transparent",
    backgroundImage: s.backgroundImage ? cssUrl(s.backgroundImage) : "none",
    backgroundSize: s.backgroundSize || "cover",
    backgroundPosition: s.backgroundPosition || "center",
    color: s.textColor || design.text || "#0F172A",
    textAlign: s.textAlign || "left",
    borderRadius: s.borderRadius ? `${s.borderRadius}px` : undefined,
    paddingTop: s.paddingTop != null ? `${s.paddingTop}px` : undefined,
    paddingBottom: s.paddingBottom != null ? `${s.paddingBottom}px` : undefined,
    minHeight: s.minHeight ? `${s.minHeight}px` : undefined
  };
};

export const Container = ({ children, width = "wide", className = "" }) => (
  <div className={`mx-auto w-full px-5 sm:px-8 ${width === "full" ? "max-w-none" : width === "compact" ? "max-w-4xl" : "max-w-7xl"} ${className}`}>
    {children}
  </div>
);

export function SmartLink({ href = "#", children, className = "", style, onClick }) {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className} style={style}>
        {children}
      </button>
    );
  }
  if (href && href.startsWith("/")) {
    return <Link to={href} className={className} style={style}>{children}</Link>;
  }
  return <a href={href || "#"} className={className} style={style}>{children}</a>;
}

/**
 * Clickable inline text field with direct edit trigger for studio canvas
 */
function DirectEditableText({
  tag: Tag = "span",
  text,
  fieldKey,
  sectionId,
  placeholder = "Click to edit text",
  className = "",
  style = {},
  editor = false,
  onEditText,
  children
}) {
  const content = children || text;
  if (!editor || !onEditText) {
    return <Tag className={className} style={style}>{content || placeholder}</Tag>;
  }

  return (
    <Tag
      className={`${className} cursor-text transition hover:outline-dashed hover:outline-2 hover:outline-blue-400 rounded px-1`}
      style={style}
      title="Click to edit this text directly"
      onClick={(e) => {
        e.stopPropagation();
        onEditText(sectionId, fieldKey, text ?? "");
      }}
    >
      {content || <span className="opacity-40 italic">{placeholder}</span>}
    </Tag>
  );
}

function Header({ builder, identity, editor, onSelectHeader, onEditImage }) {
  const d = builder.global?.design || {};
  const h = builder.global?.header || {};
  const logoUrl = identity?.logo_url || builder.global?.identity?.logoUrl || "/onenexa-logo.png";
  const siteName = identity?.site_name || builder.global?.identity?.siteName || "ONENEXA";
  const tagline = identity?.site_tagline || builder.global?.identity?.tagline || "One platform for modern business operations.";

  // Menu items: Use custom header menu items if provided; otherwise fallback to visible pages
  const menuItems = Array.isArray(h.items) && h.items.length > 0
    ? h.items
    : (builder.pages || []).filter((p) => p.visible !== false).map((p) => ({
        label: p.name,
        destination: p.id === "home" ? "/" : `#page-${p.id}`
      }));

  return (
    <header
      className={`${h.sticky ? "sticky top-0" : ""} z-40 border-b border-slate-200/80 bg-white/95 shadow-[0_1px_18px_rgba(15,23,42,.04)] backdrop-blur-xl ${
        editor ? "cursor-pointer transition hover:border-blue-400" : ""
      }`}
      onClick={(e) => {
        if (editor && onSelectHeader) {
          e.stopPropagation();
          onSelectHeader();
        }
      }}
    >
      <Container width={d.width || "wide"} className="flex min-h-[78px] items-center gap-5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {h.logo !== false && (
            <div
              className={`relative ${editor ? "group cursor-pointer" : ""}`}
              onClick={(e) => {
                if (editor && onEditImage) {
                  e.stopPropagation();
                  onEditImage("header", "logo", logoUrl);
                }
              }}
            >
              <img
                src={logoUrl}
                alt={siteName}
                className="h-11 w-auto max-w-[190px] object-contain transition group-hover:opacity-80"
              />
              {editor && (
                <span className="absolute -bottom-1 -right-1 hidden rounded-full bg-blue-600 p-1 text-white shadow group-hover:block">
                  <ImageIcon size={10} />
                </span>
              )}
            </div>
          )}
          <div className="min-w-0">
            <div className="truncate text-lg font-extrabold tracking-tight text-slate-900">{siteName}</div>
            <div className="hidden truncate text-xs text-slate-500 sm:block">{tagline}</div>
          </div>
        </div>

        <nav className="hidden min-w-0 flex-1 items-center justify-center gap-1 md:flex">
          <div className="flex min-w-0 max-w-[min(62vw,720px)] items-center gap-1 overflow-hidden">
            {menuItems.slice(0, 7).map((item, idx) => (
              <SmartLink
                key={idx}
                href={item.destination || "#"}
                className="max-w-[150px] truncate whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 hover:text-slate-950"
              >
                {item.label}
              </SmartLink>
            ))}
          </div>
        </nav>

        {h.showLogin !== false && (
          <SmartLink
            href={h.buttonHref || "/login"}
            className="shrink-0 rounded-xl px-5 py-3 text-sm font-bold text-white shadow-[0_10px_24px_rgba(16,42,86,.2)] transition hover:-translate-y-0.5"
            style={{ background: d.primary || "#102A56" }}
          >
            {h.buttonText || h.loginText || "Sign in"}
          </SmartLink>
        )}
      </Container>
    </header>
  );
}

function Hero({ section, global, editor, onEditText, onEditImage, onEditButton }) {
  const d = section.data || {};
  const design = global.design || {};
  const dark = d.theme !== "light";
  const bg = d.backgroundColor || (dark ? `linear-gradient(135deg, ${design.primary || "#0D3B66"} 0%, #102A43 58%, #061827 100%)` : "#f8fafc");
  const align = d.contentAlign || "left";

  return (
    <section id={`section-${section.id}`} style={{ ...sectionStyle(section, design), background: bg, color: dark ? "#fff" : design.text }}>
      <Container width={design.width || "wide"} className="grid min-h-[520px] items-center gap-12 py-16 lg:grid-cols-[1.05fr_.95fr] lg:py-24">
        <div className={`${align === "center" ? "text-center" : "text-left"} min-w-0`}>
          {d.badge && (
            <div className={`mb-6 inline-flex max-w-full items-center rounded-full border px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[.14em] ${dark ? "border-white/15 bg-white/10 text-white/90" : "border-slate-200 bg-white text-slate-600"}`}>
              <DirectEditableText tag="span" text={d.badge} fieldKey="badge" sectionId={section.id} editor={editor} onEditText={onEditText} />
            </div>
          )}
          <h1 className="break-words text-4xl font-black leading-[1.03] tracking-[-.045em] sm:text-5xl lg:text-6xl xl:text-7xl">
            <DirectEditableText tag="span" text={d.title || "Your headline"} fieldKey="title" sectionId={section.id} editor={editor} onEditText={onEditText} />
          </h1>
          {d.subtitle && (
            <p className={`mt-6 max-w-2xl text-base leading-7 sm:text-lg ${dark ? "text-white/75" : "text-slate-600"} ${align === "center" ? "mx-auto" : ""}`}>
              <DirectEditableText tag="span" text={d.subtitle} fieldKey="subtitle" sectionId={section.id} editor={editor} onEditText={onEditText} />
            </p>
          )}
          <div className={`mt-8 flex flex-wrap gap-3 ${align === "center" ? "justify-center" : "justify-start"}`}>
            {d.primaryText && (
              <SmartLink
                href={d.primaryHref || "#"}
                onClick={editor && onEditButton ? () => onEditButton(section.id, "primary") : undefined}
                className="rounded-xl px-6 py-3.5 text-sm font-bold text-white shadow-lg transition hover:scale-[1.02]"
                style={{ background: design.accent || "#1FAF5A" }}
              >
                {d.primaryText}
                <ArrowRight size={16} className="ml-2 inline" />
              </SmartLink>
            )}
            {d.secondaryText && (
              <SmartLink
                href={d.secondaryHref || "/login"}
                onClick={editor && onEditButton ? () => onEditButton(section.id, "secondary") : undefined}
                className={`rounded-xl border px-6 py-3.5 text-sm font-bold transition hover:scale-[1.02] ${dark ? "border-white/20 bg-white/10 text-white" : "border-slate-300 bg-white text-slate-800"}`}
              >
                {d.secondaryText}
              </SmartLink>
            )}
          </div>
        </div>
        <div className={`relative flex min-h-[300px] items-center justify-center ${d.imagePosition === "left" ? "order-first lg:order-first" : ""}`}>
          <div
            className={`group relative flex w-full min-h-[300px] items-center justify-center overflow-hidden rounded-3xl border p-5 shadow-2xl ${
              dark ? "border-white/10 bg-white/10" : "border-slate-200 bg-white"
            } ${editor ? "cursor-pointer" : ""}`}
            onClick={(e) => {
              if (editor && onEditImage) {
                e.stopPropagation();
                onEditImage(section.id, "image", d.image);
              }
            }}
          >
            {d.image ? (
              <img src={d.image} alt="" className="max-h-[340px] max-w-full object-contain transition group-hover:scale-105" />
            ) : (
              <div className="flex flex-col items-center gap-2 text-sm opacity-60">
                <ImageIcon size={24} />
                <span>Click to add a hero image</span>
              </div>
            )}
            {editor && (
              <span className="absolute right-3 top-3 hidden rounded-lg bg-blue-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow group-hover:inline-flex items-center gap-1">
                <ImageIcon size={12} /> Replace Image
              </span>
            )}
          </div>
        </div>
      </Container>
    </section>
  );
}

function ModuleLogoScroller() {
  const modules = [
    { name: "Taskosphere", logo: "/logo-transparent.png", description: "Work & task management" },
    { name: "Finix", logo: "/finix-logo.png", description: "Finance & accounting" },
    { name: "People Matrix", logo: "/people-matrix-logo.png", description: "People & HRMS" },
    { name: "CompliGenie", logo: "/compligenie-logo.png", description: "Compliance & GST" },
    { name: "LeadSense", logo: "/leadsense-logo.png", description: "Leads & growth" },
    { name: "ONENEXA", logo: "/onenexa-logo.png", description: "Connected business platform" },
  ];
  return (
    <div className="my-8 rounded-2xl border border-slate-200 bg-slate-50/70 p-5">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-slate-400">Integrated Platform Ecosystem</p>
        <p className="text-xs text-slate-500">Connected modules for operations, finance, people and compliance.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {modules.map((module) => (
          <div key={module.name} className="flex min-h-[80px] items-center gap-3.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm">
            <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-lg border border-slate-100 bg-slate-50 px-2">
              <img src={module.logo} alt={module.name} className="max-h-9 max-w-[70px] object-contain" loading="lazy" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-xs font-extrabold text-slate-900">{module.name}</div>
              <div className="truncate text-[11px] text-slate-500">{module.description}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Features({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width={design.width || "wide"}>
        <div className="mx-auto mb-12 max-w-3xl text-center">
          <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
            <DirectEditableText tag="span" text={d.heading || "Platform Features"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
          </h2>
          {d.subtitle && (
            <p className="mt-4 text-base leading-7 text-slate-600">
              <DirectEditableText tag="span" text={d.subtitle} fieldKey="subtitle" sectionId={section.id} editor={editor} onEditText={onEditText} />
            </p>
          )}
        </div>
        <ModuleLogoScroller />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {(d.items || []).map((item, i) => (
            <SmartLink key={i} href={item.route || "#"} className="group rounded-2xl border border-slate-200 bg-white p-6 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg">
              <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-sm" style={{ background: design.primary || "#0D3B66" }}>
                <Check size={19} />
              </div>
              <h3 className="text-lg font-extrabold text-slate-900">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{item.description}</p>
              {item.route && (
                <span className="mt-5 inline-flex items-center text-xs font-bold" style={{ color: design.primary || "#0D3B66" }}>
                  Explore <ArrowRight size={14} className="ml-1" />
                </span>
              )}
            </SmartLink>
          ))}
        </div>
      </Container>
    </section>
  );
}

function TextSection({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width="compact">
        <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
          <DirectEditableText tag="span" text={d.heading || "Section Heading"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
        </h2>
        <p className="mt-5 whitespace-pre-wrap text-base leading-8 text-slate-600">
          <DirectEditableText tag="span" text={d.body || "Write your content here."} fieldKey="body" sectionId={section.id} editor={editor} onEditText={onEditText} />
        </p>
      </Container>
    </section>
  );
}

function Pricing({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width={design.width || "wide"}>
        <div className="mx-auto mb-12 max-w-3xl text-center">
          <h2 className="text-3xl font-black sm:text-4xl">
            <DirectEditableText tag="span" text={d.heading || "Pricing"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
          </h2>
          <p className="mt-4 text-slate-600">
            <DirectEditableText tag="span" text={d.subtitle || "Choose a package"} fieldKey="subtitle" sectionId={section.id} editor={editor} onEditText={onEditText} />
          </p>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          {(d.items || []).map((item, i) => (
            <div key={i} className={`rounded-3xl border p-7 ${item.featured ? "border-2 shadow-xl ring-2 ring-blue-500/20" : "border-slate-200 shadow-sm"}`} style={item.featured ? { borderColor: design.accent || "#1FAF5A" } : undefined}>
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-extrabold">{item.name}</h3>
                {item.featured && (
                  <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-bold text-blue-700">Recommended</span>
                )}
              </div>
              <div className="mt-5 text-4xl font-black">{item.price}</div>
              <div className="mt-1 text-sm text-slate-500">{item.period}</div>
              <p className="mt-5 text-sm leading-6 text-slate-600">{item.description}</p>
              <SmartLink href="/login" className="mt-7 block rounded-xl px-4 py-3 text-center text-sm font-bold text-white shadow-sm transition hover:opacity-95" style={{ background: design.primary || "#0D3B66" }}>
                Get started
              </SmartLink>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

function Cta({ section, global, editor, onEditText, onEditButton }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={{ ...sectionStyle(section, design), background: d.backgroundColor || design.primary || "#0D3B66", color: "#fff" }} className="py-16">
      <Container width="compact" className="text-center">
        <h2 className="text-3xl font-black sm:text-4xl">
          <DirectEditableText tag="span" text={d.heading || "Ready to get started?"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-white/80">
          <DirectEditableText tag="span" text={d.text || "Take the next step today."} fieldKey="text" sectionId={section.id} editor={editor} onEditText={onEditText} />
        </p>
        <SmartLink
          href={d.href || "/login"}
          onClick={editor && onEditButton ? () => onEditButton(section.id, "button") : undefined}
          className="mt-7 inline-flex items-center rounded-xl bg-white px-6 py-3.5 text-sm font-bold shadow-lg transition hover:scale-105"
          style={{ color: design.primary || "#0D3B66" }}
        >
          {d.button || "Get started"}
          <ArrowRight size={16} className="ml-2" />
        </SmartLink>
      </Container>
    </section>
  );
}

function ImageText({ section, global, editor, onEditText, onEditImage }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width={design.width || "wide"}>
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div className={d.imageSide === "left" ? "lg:order-first" : "lg:order-last"}>
            <div
              className={`group relative overflow-hidden rounded-3xl border border-slate-200 shadow-lg ${editor ? "cursor-pointer" : ""}`}
              onClick={(e) => {
                if (editor && onEditImage) {
                  e.stopPropagation();
                  onEditImage(section.id, "image", d.image);
                }
              }}
            >
              {d.image ? (
                <img src={d.image} alt="" className="w-full object-cover transition group-hover:scale-105" />
              ) : (
                <div className="flex h-64 items-center justify-center bg-slate-100 text-slate-400">
                  <ImageIcon size={32} />
                </div>
              )}
              {editor && (
                <span className="absolute right-3 top-3 hidden rounded-lg bg-blue-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow group-hover:inline-flex items-center gap-1">
                  <ImageIcon size={12} /> Replace Image
                </span>
              )}
            </div>
          </div>
          <div>
            <h2 className="text-3xl font-black">
              <DirectEditableText tag="span" text={d.heading || "Tell your story"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
            </h2>
            <p className="mt-5 whitespace-pre-wrap text-base leading-8 text-slate-600">
              <DirectEditableText tag="span" text={d.body || "Describe the image or feature."} fieldKey="body" sectionId={section.id} editor={editor} onEditText={onEditText} />
            </p>
          </div>
        </div>
      </Container>
    </section>
  );
}

function ImageSection({ section, global, editor, onEditImage }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-12">
      <Container width={design.width || "wide"}>
        <div
          className={`group relative overflow-hidden rounded-3xl shadow-lg ${editor ? "cursor-pointer" : ""}`}
          onClick={(e) => {
            if (editor && onEditImage) {
              e.stopPropagation();
              onEditImage(section.id, "image", d.image);
            }
          }}
        >
          {d.image ? (
            <img src={d.image} alt={d.alt || ""} className="max-h-[720px] w-full object-cover" />
          ) : (
            <div className="flex h-64 items-center justify-center bg-slate-100 text-slate-400">
              <ImageIcon size={32} />
            </div>
          )}
          {editor && (
            <span className="absolute right-3 top-3 hidden rounded-lg bg-blue-600/90 px-2.5 py-1 text-xs font-semibold text-white shadow group-hover:inline-flex items-center gap-1">
              <ImageIcon size={12} /> Replace Image
            </span>
          )}
        </div>
      </Container>
    </section>
  );
}

function Gallery({ section, global, editor, onEditImage }) {
  const d = section.data || {};
  const design = global.design || {};
  const items = Array.isArray(d.items) ? d.items : [];
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-16">
      <Container width={design.width || "wide"}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((src, i) => {
            const url = typeof src === "string" ? src : src?.url;
            return (
              <div
                key={i}
                className={`group relative aspect-[4/3] overflow-hidden rounded-2xl bg-slate-100 ${editor ? "cursor-pointer" : ""}`}
                onClick={(e) => {
                  if (editor && onEditImage) {
                    e.stopPropagation();
                    onEditImage(section.id, `gallery_${i}`, url);
                  }
                }}
              >
                {url ? (
                  <img src={url} alt="" className="h-full w-full object-cover transition group-hover:scale-105" />
                ) : (
                  <div className="flex h-full items-center justify-center text-slate-400">
                    <ImageIcon size={24} />
                  </div>
                )}
                {editor && (
                  <span className="absolute bottom-2 right-2 hidden rounded-md bg-blue-600/90 p-1.5 text-white shadow group-hover:block">
                    <ImageIcon size={14} />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Container>
    </section>
  );
}

function VideoSection({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  const url = d.url || d.video || "";
  const embed = url.includes("youtube.com/watch?v=")
    ? `https://www.youtube.com/embed/${url.split("v=")[1].split("&")[0]}`
    : url;
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-16">
      <Container width="wide">
        <div className="aspect-video overflow-hidden rounded-3xl bg-slate-950 shadow-xl">
          {embed ? (
            <iframe title={d.title || "Video"} src={embed} className="h-full w-full" allowFullScreen />
          ) : (
            <div className="flex h-full flex-col items-center justify-center text-white/70">
              <Play size={44} />
              <p className="mt-3 text-sm">Add a YouTube, Vimeo or MP4 link in section settings</p>
            </div>
          )}
        </div>
      </Container>
    </section>
  );
}

function Testimonials({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width="wide">
        <h2 className="mb-10 text-center text-3xl font-black">
          <DirectEditableText tag="span" text={d.heading || "What customers say"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
        </h2>
        <div className="grid gap-5 md:grid-cols-2">
          {(d.items || []).map((x, i) => (
            <div key={i} className="rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
              <Quote size={22} style={{ color: design.accent || "#16C7A2" }} />
              <p className="mt-4 text-lg leading-7 text-slate-700">“{x.quote}”</p>
              <div className="mt-5 text-sm font-bold text-slate-900">{x.name}</div>
              <div className="text-xs text-slate-500">{x.role}</div>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}

function Faq({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width="compact">
        <h2 className="text-3xl font-black">
          <DirectEditableText tag="span" text={d.heading || "Frequently asked questions"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
        </h2>
        <div className="mt-8 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white shadow-sm">
          {(d.items || []).map((x, i) => (
            <details key={i} className="group p-5 transition open:bg-slate-50/60">
              <summary className="cursor-pointer list-none font-bold text-slate-900">
                {x.question}
              </summary>
              <p className="mt-3 text-sm leading-6 text-slate-600">{x.answer}</p>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}

function FormSection({ section, global, editor, onEditText }) {
  const d = section.data || {};
  const design = global.design || {};
  return (
    <section id={`section-${section.id}`} style={sectionStyle(section, design)} className="py-20">
      <Container width="compact">
        <div className="rounded-3xl border border-slate-200 bg-white p-7 sm:p-9 shadow-sm">
          <h2 className="text-3xl font-black">
            <DirectEditableText tag="span" text={d.heading || "Contact us"} fieldKey="heading" sectionId={section.id} editor={editor} onEditText={onEditText} />
          </h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <input className="rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-500" placeholder="Your name" readOnly={editor} />
            <input className="rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-500" placeholder="Email address" readOnly={editor} />
            <textarea className="min-h-32 rounded-xl border border-slate-200 px-4 py-3 text-sm outline-none focus:border-blue-500 sm:col-span-2" placeholder="How can we help your business?" readOnly={editor} />
            <button type="button" className="rounded-xl px-5 py-3 text-sm font-bold text-white sm:col-span-2 shadow-sm transition hover:opacity-95" style={{ background: design.primary || "#102A56" }}>
              Send enquiry
            </button>
          </div>
        </div>
      </Container>
    </section>
  );
}

export function RenderSection({ section, global, editor, onEditText, onEditImage, onEditButton }) {
  if (section.visible === false) return null;
  const props = { section, global, editor, onEditText, onEditImage, onEditButton };
  switch (section.type) {
    case "hero": return <Hero {...props} />;
    case "features": return <Features {...props} />;
    case "text": return <TextSection {...props} />;
    case "pricing": return <Pricing {...props} />;
    case "cta": return <Cta {...props} />;
    case "imageText": return <ImageText {...props} />;
    case "image": return <ImageSection {...props} />;
    case "gallery": return <Gallery {...props} />;
    case "video": return <VideoSection {...props} />;
    case "testimonials": return <Testimonials {...props} />;
    case "faq": return <Faq {...props} />;
    case "form": return <FormSection {...props} />;
    case "divider": return <div id={`section-${section.id}`} className="mx-auto my-8 h-px max-w-6xl bg-slate-200" />;
    default: return null;
  }
}

export default function WebsiteRenderer({
  builder,
  identity = {},
  editor = false,
  selectedSectionId = null,
  onSelectSection,
  onSelectHeader,
  onSelectFooter,
  onEditText,
  onEditImage,
  onEditButton,
  onMoveSection,
  onDuplicateSection,
  onDeleteSection,
  onToggleSectionVisibility,
}) {
  const source = builder && Array.isArray(builder.pages) ? builder : DEFAULT_BUILDER;
  const global = source.global || DEFAULT_BUILDER.global;
  const page = source.pages.find((p) => p.id === source.activePageId) || source.pages[0];

  if (!page) return null;

  return (
    <div
      className="min-h-full bg-white"
      style={{
        color: global.design?.text || "#0F172A",
        fontFamily: global.design?.font || "Plus Jakarta Sans",
      }}
      onClick={() => editor && onSelectSection?.(null)}
    >
      <Header
        builder={source}
        identity={identity}
        editor={editor}
        onSelectHeader={onSelectHeader}
        onEditImage={onEditImage}
      />

      <main>
        {(page.sections || []).map((section, idx) => {
          const isSelected = selectedSectionId === section.id;
          return (
            <div
              key={section.id}
              className={
                editor
                  ? `group relative cursor-pointer outline-offset-[-2px] transition ${
                      isSelected
                        ? "outline-2 outline-blue-600 bg-blue-500/[0.01]"
                        : "hover:outline hover:outline-1 hover:outline-blue-300"
                    }`
                  : ""
              }
              onClick={
                editor
                  ? (e) => {
                      e.stopPropagation();
                      onSelectSection?.(section.id);
                    }
                  : undefined
              }
            >
              {/* Contextual Visual Floating Toolbar for selected element */}
              {editor && isSelected && (
                <div
                  className="absolute right-4 top-4 z-30 flex items-center gap-1 rounded-xl border border-blue-200 bg-white/95 px-2 py-1.5 shadow-xl backdrop-blur-md"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="mr-1 text-[11px] font-extrabold text-blue-700 uppercase tracking-wider">
                    {section.title || section.type}
                  </span>
                  <div className="h-4 w-px bg-slate-200" />
                  <button
                    type="button"
                    onClick={() => onMoveSection?.(section.id, -1)}
                    disabled={idx === 0}
                    className="rounded-lg p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                    title="Move up"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveSection?.(section.id, 1)}
                    disabled={idx === (page.sections?.length || 1) - 1}
                    className="rounded-lg p-1 text-slate-600 hover:bg-slate-100 disabled:opacity-30"
                    title="Move down"
                  >
                    <ChevronDown size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDuplicateSection?.(section.id)}
                    className="rounded-lg p-1 text-slate-600 hover:bg-slate-100"
                    title="Duplicate section"
                  >
                    <Copy size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleSectionVisibility?.(section.id)}
                    className="rounded-lg p-1 text-slate-600 hover:bg-slate-100"
                    title={section.visible === false ? "Show section" : "Hide section"}
                  >
                    {section.visible === false ? <Eye size={15} /> : <EyeOff size={15} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => onDeleteSection?.(section.id)}
                    className="rounded-lg p-1 text-red-500 hover:bg-red-50"
                    title="Remove section"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              )}

              <RenderSection
                section={section}
                global={global}
                editor={editor}
                onEditText={onEditText}
                onEditImage={onEditImage}
                onEditButton={onEditButton}
              />
            </div>
          );
        })}
      </main>

      {global.footer?.show !== false && (
        <footer
          className={`border-t border-slate-200 bg-white py-12 ${
            editor ? "cursor-pointer transition hover:border-blue-400" : ""
          }`}
          onClick={(e) => {
            if (editor && onSelectFooter) {
              e.stopPropagation();
              onSelectFooter();
            }
          }}
        >
          <Container width={global.design?.width || "wide"} className="flex flex-col gap-5 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="font-bold text-slate-800">
                {identity.footer_company || global.footer?.company || identity.site_name || "ONENEXA"}
              </div>
              <div className="text-xs text-slate-500">
                {identity.footer_text || global.footer?.text || "A configurable commercial business operating system."}
              </div>
              {(global.footer?.phone || global.footer?.email) && (
                <div className="text-xs text-slate-400">
                  {[global.footer.phone, global.footer.email].filter(Boolean).join(" · ")}
                </div>
              )}
            </div>
            <div className="text-xs text-slate-400">
              {identity.footer_copyright || global.footer?.copyright || "© 2026 ONENEXA. All rights reserved."}
            </div>
          </Container>
        </footer>
      )}
    </div>
  );
}
