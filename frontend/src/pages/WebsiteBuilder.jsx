import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, Copy, Eye, FileImage,
  GripVertical, ImagePlus, LayoutTemplate, Monitor, Palette, Plus, Redo2, Save, Settings2,
  Smartphone, Sparkles, Trash2, Type, Undo2, Upload, Video, X, Globe2, Menu, Home,
  PanelLeft, ExternalLink, RefreshCcw
} from "lucide-react";
import { toast } from "sonner";
import { getAdminWebsiteConfig, resetWebsiteConfig, saveWebsiteConfig } from "@/lib/websiteApi";

const clone = (v) => JSON.parse(JSON.stringify(v));
const uid = (p = "item") => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

const SECTION_TYPES = [
  ["hero", "Hero", "Homepage banner", Sparkles],
  ["features", "Features", "Services or modules", LayoutTemplate],
  ["text", "Text", "Heading and text", Type],
  ["image", "Image", "Photo or screenshot", FileImage],
  ["imageText", "Image + Text", "Image beside text", LayoutTemplate],
  ["gallery", "Gallery", "Multiple images", ImagePlus],
  ["video", "Video", "YouTube, Vimeo or MP4", Video],
  ["testimonials", "Testimonials", "Customer reviews", Sparkles],
  ["faq", "FAQ", "Questions and answers", ChevronDown],
  ["cta", "Call to Action", "Buttons and next step", ArrowRight],
  ["form", "Contact Form", "Let visitors contact you", Type],
  ["divider", "Divider", "Visual separation", GripVertical]
];

const DEFAULT_BUILDER = {
  version: 5,
  activePageId: "home",
  pages: [{
    id: "home", name: "Home", slug: "/", visible: true,
    sections: [
      { id: "hero", type: "hero", title: "Hero", visible: true, layout: "split", data: {
        badge: "THE MODERN BUSINESS OPERATING SYSTEM",
        title: "Everything your business needs. Nothing scattered.",
        subtitle: "Task management, invoicing, accounting, HRMS, records, compliance and AI — connected in one intelligent workspace.",
        primaryText: "Explore Taskosphere", primaryHref: "#features",
        secondaryText: "Sign in", secondaryHref: "/login", image: "/logo-transparent.png"
      } },
      { id: "features", type: "features", title: "Platform Modules", visible: true, layout: "cards", data: {
        heading: "One platform. Every business function.",
        subtitle: "Choose the exact software package your customer needs and activate it through your commercial license.",
        items: [
          { title: "Task Management", description: "Projects, tasks, workflows, reminders and team visibility." },
          { title: "Invoicing", description: "Quotations, invoices, purchases and customer billing." },
          { title: "Accounting", description: "Ledgers, banking, reports and financial controls." },
          { title: "HRMS", description: "People, attendance, leave, payroll and recruitment." },
          { title: "Compliance", description: "GST, ROC, trademark and compliance workflows." },
          { title: "Records", description: "Client records, documents, approvals and business information." },
          { title: "AI & Automation", description: "Intelligent document processing and operational assistance." }
        ]
      } },
      { id: "why", type: "text", title: "Why Taskosphere", visible: true, data: {
        heading: "Run work from one connected workspace",
        body: "Assign and track work, communicate with your team, manage documents, monitor productivity and keep financial and compliance operations connected — without scattering information across different systems."
      } },
      { id: "cta", type: "cta", title: "Call to Action", visible: true, layout: "center", data: {
        heading: "Ready to build your Taskosphere workspace?", text: "Configure the modules your business needs and get started.", button: "Get started", href: "/login"
      } }
    ]
  }],
  global: {
    header: { sticky: true, showLogin: true, logo: true },
    footer: { show: true, text: "", social: true },
    design: { primary: "#0D3B66", accent: "#1FAF5A", background: "#FFFFFF", text: "#0F172A", font: "Inter", radius: "medium", width: "wide" }
  },
  media: []
};

function Field({ label, value, onChange, area = false, placeholder = "" }) {
  const Tag = area ? "textarea" : "input";
  return <label className="block">
    <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
    <Tag value={value ?? ""} placeholder={placeholder} rows={area ? 5 : undefined} onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" />
  </label>;
}

function ToolButton({ icon: Icon, children, onClick, active = false, disabled = false, title }) {
  return <button type="button" title={title} onClick={onClick} disabled={disabled}
    className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-bold transition ${active ? "bg-[#0D3B66] text-white" : "text-slate-600 hover:bg-slate-100"} disabled:opacity-40`}>
    <Icon size={15} />{children}
  </button>;
}

function MediaBox({ value, video = false, onChange }) {
  const choose = (file) => { if (!file) return; const reader = new FileReader(); reader.onload = () => onChange(String(reader.result)); reader.readAsDataURL(file); };
  return <div className="space-y-3">
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      {value ? (video ? <div className="flex aspect-video items-center justify-center bg-slate-950 text-white"><Video size={28}/><span className="ml-2 max-w-[70%] truncate text-xs">{value}</span></div> : <img src={value} alt="Selected" className="max-h-48 w-full object-cover" />) : <div className="flex aspect-video items-center justify-center text-slate-300"><ImagePlus size={34}/></div>}
    </div>
    {!video && <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white px-3 py-3 text-sm font-bold text-slate-600 hover:border-blue-400 hover:text-blue-600"><Upload size={16}/> Upload image<input type="file" accept="image/*" className="hidden" onChange={e => choose(e.target.files?.[0])}/></label>}
    <Field label={video ? "Video URL" : "Image URL"} value={value} onChange={onChange} placeholder={video ? "https://youtube.com/... or MP4 URL" : "Paste an image URL, or upload above"}/>
  </div>;
}

function PreviewSection({ section, design }) {
  const d = section.data || {}; const p = design.primary || "#0D3B66"; const a = design.accent || "#1FAF5A"; const image = d.image || d.src;
  if (section.type === "hero") return <section className="overflow-hidden px-8 py-14" style={{background:d.background || design.background || "#fff",color:design.text}}><div className={`mx-auto grid max-w-6xl items-center gap-10 ${section.layout === "center" ? "text-center" : "md:grid-cols-2"}`}><div><span className="text-xs font-bold uppercase tracking-[.16em]" style={{color:a}}>{d.badge}</span><h2 className="mt-3 text-4xl font-black leading-tight">{d.title || "Your headline"}</h2><p className="mt-4 max-w-2xl text-base leading-7 opacity-70">{d.subtitle}</p><div className="mt-6 flex flex-wrap gap-2"><span className="rounded-md px-4 py-2.5 text-xs font-bold text-white" style={{background:p}}>{d.primaryText || "Get started"}</span>{d.secondaryText && <span className="rounded-md border border-slate-300 px-4 py-2.5 text-xs font-bold">{d.secondaryText}</span>}</div></div>{section.layout !== "center" && <div className="overflow-hidden rounded-lg bg-slate-100">{d.video ? <iframe title="Hero video" src={d.video} className="aspect-video w-full" allow="autoplay; fullscreen; picture-in-picture"/> : image ? <img src={image} alt="" className="max-h-80 w-full object-cover"/> : <div className="flex aspect-video items-center justify-center text-slate-300"><ImagePlus size={42}/></div>}</div>}</div></section>;
  if (section.type === "features") return <section id="features" className="mx-auto max-w-6xl px-8 py-14"><p className="text-xs font-bold uppercase tracking-[.16em]" style={{color:a}}>Platform</p><h2 className="mt-2 text-3xl font-black">{d.heading || "Features"}</h2><p className="mt-2 text-slate-500">{d.subtitle}</p><div className="mt-7 grid gap-4 md:grid-cols-2 lg:grid-cols-3">{(d.items || []).map((x,i)=><article key={i} className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"><div className="h-9 w-9 rounded-md" style={{background:`${a}20`}}/><h3 className="mt-4 font-bold">{x.title}</h3><p className="mt-1 text-sm leading-6 text-slate-500">{x.description}</p></article>)}</div></section>;
  if (section.type === "text") return <section className="mx-auto max-w-4xl px-8 py-14"><h2 className="text-3xl font-black">{d.heading}</h2><p className="mt-4 whitespace-pre-wrap text-base leading-8 text-slate-600">{d.body}</p></section>;
  if (section.type === "image") return <section className="mx-auto max-w-6xl px-8 py-10">{image ? <img src={image} alt={d.alt || ""} className="max-h-[520px] w-full rounded-lg object-cover shadow-sm"/> : <div className="flex aspect-video items-center justify-center rounded-lg bg-slate-50 text-slate-300"><ImagePlus/></div>}</section>;
  if (section.type === "imageText") return <section className="mx-auto grid max-w-6xl items-center gap-10 px-8 py-14 md:grid-cols-2"><div>{image ? <img src={image} alt={d.alt || ""} className="max-h-96 w-full rounded-lg object-cover"/> : <div className="flex aspect-video items-center justify-center rounded-lg bg-slate-50 text-slate-300"><ImagePlus/></div>}</div><div><h2 className="text-3xl font-black">{d.heading}</h2><p className="mt-4 whitespace-pre-wrap leading-7 text-slate-600">{d.body}</p>{d.button && <span className="mt-5 inline-flex rounded-md px-4 py-2.5 text-xs font-bold text-white" style={{background:p}}>{d.button}</span>}</div></section>;
  if (section.type === "gallery") return <section className="mx-auto max-w-6xl px-8 py-10"><h2 className="text-2xl font-black">{d.heading || "Gallery"}</h2><div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-3">{(d.images || []).map((src,i)=><img key={i} src={src} alt="" className="aspect-square w-full rounded-lg object-cover"/>)}</div></section>;
  if (section.type === "video") return <section className="mx-auto max-w-6xl px-8 py-10"><div className="overflow-hidden rounded-lg bg-slate-950">{d.url ? <iframe title="Video" src={d.url} className="aspect-video w-full" allow="autoplay; fullscreen; picture-in-picture"/> : <div className="flex aspect-video items-center justify-center text-white"><Video size={34}/><span className="ml-2 text-sm">Add a video URL</span></div>}</div></section>;
  if (section.type === "testimonials") return <section className="px-8 py-14" style={{background:p,color:"white"}}><div className="mx-auto max-w-6xl"><h2 className="text-3xl font-black">{d.heading || "What customers say"}</h2><div className="mt-7 grid gap-4 md:grid-cols-3">{(d.items || []).map((x,i)=><blockquote key={i} className="rounded-lg border border-white/10 bg-white/10 p-5"><p className="text-sm leading-6 text-white/80">“{x.quote}”</p><b className="mt-4 block text-sm">{x.name}</b><span className="text-xs text-white/50">{x.role}</span></blockquote>)}</div></div></section>;
  if (section.type === "faq") return <section className="mx-auto max-w-4xl px-8 py-14"><h2 className="text-3xl font-black">{d.heading || "Frequently asked questions"}</h2><div className="mt-6 space-y-2">{(d.items || []).map((x,i)=><details key={i} className="rounded-lg border border-slate-200 bg-white p-4"><summary className="cursor-pointer font-bold">{x.question}</summary><p className="mt-3 text-sm leading-6 text-slate-500">{x.answer}</p></details>)}</div></section>;
  if (section.type === "cta") return <section className="px-8 py-14"><div className="mx-auto max-w-5xl rounded-lg p-10 text-center text-white" style={{background:p}}><h2 className="text-3xl font-black">{d.heading}</h2><p className="mx-auto mt-3 max-w-2xl text-sm text-white/70">{d.text}</p><span className="mt-5 inline-flex rounded-md bg-white px-4 py-2.5 text-xs font-bold text-slate-900">{d.button || "Get started"}</span></div></section>;
  if (section.type === "form") return <section className="mx-auto max-w-5xl px-8 py-14"><div className="rounded-lg border border-slate-200 p-7"><h2 className="text-3xl font-black">{d.heading || "Contact us"}</h2><p className="mt-2 text-slate-500">{d.body}</p><div className="mt-6 grid gap-3 md:grid-cols-2"><div className="h-11 rounded-md bg-slate-100"/><div className="h-11 rounded-md bg-slate-100"/><div className="h-24 rounded-md bg-slate-100 md:col-span-2"/></div></div></section>;
  return <div className="h-10"/>;
}

function newSection(type) {
  const base={id:uid(type),type,title:SECTION_TYPES.find(x=>x[0]===type)?.[1]||type,visible:true,layout:"split",data:{}};
  if(type==="hero")base.data={badge:"Welcome",title:"Your headline",subtitle:"Tell visitors what your business does.",primaryText:"Get started",primaryHref:"/login",secondaryText:"Learn more",secondaryHref:"#",image:""};
  if(type==="text")base.data={heading:"Your heading",body:"Write your content here."};
  if(type==="image")base.data={src:"",alt:""};
  if(type==="imageText")base.data={heading:"Your heading",body:"Tell your story here.",src:"",alt:"",button:"Learn more",href:"#"};
  if(type==="gallery")base.data={heading:"Gallery",images:[]};
  if(type==="video")base.data={url:""};
  if(type==="features")base.data={heading:"Everything you offer",subtitle:"Explain your main services or modules.",items:[{title:"Feature one",description:"Describe the benefit."},{title:"Feature two",description:"Describe the benefit."},{title:"Feature three",description:"Describe the benefit."}]};
  if(type==="testimonials")base.data={heading:"What customers say",items:[{name:"Customer",role:"Client",quote:"Great service."}]};
  if(type==="faq")base.data={heading:"Frequently asked questions",items:[{question:"What do you offer?",answer:"Add your answer here."}]};
  if(type==="cta")base.data={heading:"Ready to get started?",text:"Tell visitors what to do next.",button:"Get started",href:"/login"};
  if(type==="form")base.data={heading:"Contact us",body:"We would love to hear from you."};
  return base;
}

function SectionEditor({ section, patchData }) {
  const d=section.data||{};
  if(section.type === "hero") return <div className="space-y-4"><Field label="Small label" value={d.badge} onChange={v=>patchData({badge:v})}/><Field label="Main heading" value={d.title} onChange={v=>patchData({title:v})}/><Field label="Description" value={d.subtitle} area onChange={v=>patchData({subtitle:v})}/><div className="grid grid-cols-2 gap-3"><Field label="Main button" value={d.primaryText} onChange={v=>patchData({primaryText:v})}/><Field label="Button link" value={d.primaryHref} onChange={v=>patchData({primaryHref:v})}/></div><div className="grid grid-cols-2 gap-3"><Field label="Second button" value={d.secondaryText} onChange={v=>patchData({secondaryText:v})}/><Field label="Second link" value={d.secondaryHref} onChange={v=>patchData({secondaryHref:v})}/></div><MediaBox value={d.image} onChange={v=>patchData({image:v})}/><Field label="Video URL (optional)" value={d.video} onChange={v=>patchData({video:v})}/></div>;
  if(section.type === "features") return <div className="space-y-4"><Field label="Section heading" value={d.heading} onChange={v=>patchData({heading:v})}/><Field label="Section description" value={d.subtitle} area onChange={v=>patchData({subtitle:v})}/>{(d.items||[]).map((item,i)=><div key={i} className="rounded-lg border border-slate-200 p-3"><div className="mb-2 flex items-center justify-between"><b className="text-xs">Module {i+1}</b><button className="text-red-500" onClick={()=>patchData({items:d.items.filter((_,n)=>n!==i)})}><Trash2 size={14}/></button></div><Field label="Title" value={item.title} onChange={v=>patchData({items:d.items.map((x,n)=>n===i?{...x,title:v}:x)})}/><div className="mt-3"><Field label="Description" value={item.description} area onChange={v=>patchData({items:d.items.map((x,n)=>n===i?{...x,description:v}:x)})}/></div></div>)}<button className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 py-3 text-xs font-bold text-blue-600" onClick={()=>patchData({items:[...(d.items||[]),{title:"New module",description:"Describe the benefit."}]})}><Plus size={15}/> Add item</button></div>;
  if(section.type === "text") return <div className="space-y-4"><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/><Field label="Text" value={d.body} area onChange={v=>patchData({body:v})}/></div>;
  if(section.type === "image") return <div className="space-y-4"><MediaBox value={d.src} onChange={v=>patchData({src:v})}/><Field label="Alternative text" value={d.alt} onChange={v=>patchData({alt:v})}/></div>;
  if(section.type === "imageText") return <div className="space-y-4"><MediaBox value={d.src} onChange={v=>patchData({src:v})}/><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/><Field label="Text" value={d.body} area onChange={v=>patchData({body:v})}/><div className="grid grid-cols-2 gap-3"><Field label="Button" value={d.button} onChange={v=>patchData({button:v})}/><Field label="Link" value={d.href} onChange={v=>patchData({href:v})}/></div></div>;
  if(section.type === "gallery") return <div className="space-y-4"><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/><Field label="Image URLs" value={(d.images||[]).join("\n")} area onChange={v=>patchData({images:v.split(/\n/).map(s=>s.trim()).filter(Boolean)})}/></div>;
  if(section.type === "video") return <div className="space-y-4"><MediaBox value={d.url} video onChange={v=>patchData({url:v})}/><p className="text-[11px] leading-5 text-slate-400">Paste a YouTube, Vimeo or direct MP4 link. The preview updates immediately.</p></div>;
  if(section.type === "testimonials") return <div className="space-y-4"><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/>{(d.items||[]).map((x,i)=><div key={i} className="rounded-lg border border-slate-200 p-3 space-y-3"><div className="flex justify-end"><button className="text-red-500" onClick={()=>patchData({items:d.items.filter((_,n)=>n!==i)})}><Trash2 size={14}/></button></div><Field label="Name" value={x.name} onChange={v=>patchData({items:d.items.map((q,n)=>n===i?{...q,name:v}:q)})}/><Field label="Role" value={x.role} onChange={v=>patchData({items:d.items.map((q,n)=>n===i?{...q,role:v}:q)})}/><Field label="Review" value={x.quote} area onChange={v=>patchData({items:d.items.map((q,n)=>n===i?{...q,quote:v}:q)})}/></div>)}<button className="w-full rounded-lg border border-dashed py-3 text-xs font-bold text-blue-600" onClick={()=>patchData({items:[...(d.items||[]),{name:"Customer",role:"Client",quote:"Great service."}]})}><Plus size={14} className="inline mr-1"/> Add review</button></div>;
  if(section.type === "faq") return <div className="space-y-4"><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/>{(d.items||[]).map((x,i)=><div key={i} className="rounded-lg border border-slate-200 p-3 space-y-3"><div className="flex justify-end"><button className="text-red-500" onClick={()=>patchData({items:d.items.filter((_,n)=>n!==i)})}><Trash2 size={14}/></button></div><Field label="Question" value={x.question} onChange={v=>patchData({items:d.items.map((q,n)=>n===i?{...q,question:v}:q)})}/><Field label="Answer" value={x.answer} area onChange={v=>patchData({items:d.items.map((q,n)=>n===i?{...q,answer:v}:q)})}/></div>)}<button className="w-full rounded-lg border border-dashed py-3 text-xs font-bold text-blue-600" onClick={()=>patchData({items:[...(d.items||[]),{question:"New question",answer:"Add your answer here."}]})}><Plus size={14} className="inline mr-1"/> Add question</button></div>;
  if(section.type === "cta") return <div className="space-y-4"><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/><Field label="Description" value={d.text} area onChange={v=>patchData({text:v})}/><div className="grid grid-cols-2 gap-3"><Field label="Button" value={d.button} onChange={v=>patchData({button:v})}/><Field label="Link" value={d.href} onChange={v=>patchData({href:v})}/></div></div>;
  if(section.type === "form") return <div className="space-y-4"><Field label="Heading" value={d.heading} onChange={v=>patchData({heading:v})}/><Field label="Description" value={d.body} area onChange={v=>patchData({body:v})}/></div>;
  return <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">This section is ready to use. You can reorder or remove it from the editor.</div>;
}

function PagesPanel({ pages, activePageId, setActivePageId, addPage, renamePage, duplicatePage, deletePage }) {
  return <div className="h-full overflow-y-auto bg-white"><div className="border-b border-slate-200 p-4"><div className="flex items-center justify-between"><div><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Pages</div><h2 className="mt-1 text-lg font-black text-slate-900">Your website</h2></div><button onClick={addPage} className="grid h-9 w-9 place-items-center rounded-md bg-[#0D3B66] text-white" title="Add page"><Plus size={17}/></button></div><p className="mt-2 text-xs leading-5 text-slate-400">Add pages, rename them and choose which page you want to edit.</p></div><div className="p-3">{pages.map(page=><div key={page.id} className={`mb-2 rounded-lg border ${page.id===activePageId?"border-blue-500 bg-blue-50":"border-slate-200 bg-white"}`}><button onClick={()=>setActivePageId(page.id)} className="flex w-full items-center gap-3 p-3 text-left"><Home size={15} className={page.id===activePageId?"text-blue-600":"text-slate-400"}/><span className="min-w-0 flex-1"><b className="block truncate text-sm text-slate-800">{page.name}</b><small className="text-[10px] text-slate-400">{page.slug}</small></span>{page.id===activePageId&&<Check size={15} className="text-blue-600"/>}</button>{page.id===activePageId&&<div className="flex border-t border-slate-200 bg-white px-2 py-2"><button className="flex-1 py-1 text-[10px] font-bold text-slate-500" onClick={()=>renamePage(page)}>Rename</button><button className="flex-1 py-1 text-[10px] font-bold text-slate-500" onClick={()=>duplicatePage(page)}>Duplicate</button><button disabled={pages.length===1} className="flex-1 py-1 text-[10px] font-bold text-red-500 disabled:opacity-30" onClick={()=>deletePage(page.id)}>Delete</button></div>}</div>)}</div></div>;
}

function AddPanel({ addSection }) {
  return <div className="h-full overflow-y-auto bg-white"><div className="border-b border-slate-200 p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Add</div><h2 className="mt-1 text-lg font-black">Add to your page</h2><p className="mt-2 text-xs leading-5 text-slate-400">Choose something and it will be added to the bottom of this page.</p></div><div className="grid grid-cols-2 gap-2 p-3">{SECTION_TYPES.map(([type,name,desc,Icon])=><button key={type} onClick={()=>addSection(type)} className="group rounded-lg border border-slate-200 bg-white p-3 text-left hover:border-blue-400 hover:bg-blue-50"><span className="grid h-8 w-8 place-items-center rounded-md bg-slate-100 text-slate-500 group-hover:bg-blue-100 group-hover:text-blue-600"><Icon size={16}/></span><b className="mt-2 block text-xs text-slate-800">{name}</b><span className="mt-1 block text-[10px] leading-4 text-slate-400">{desc}</span></button>)}</div></div>;
}

function DesignPanel({ design, patchDesign }) {
  const colors=["#0D3B66","#1FAF5A","#2563EB","#7C3AED","#0F766E","#111827","#B45309"];
  return <div className="h-full overflow-y-auto bg-white"><div className="border-b border-slate-200 p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Design</div><h2 className="mt-1 text-lg font-black">Make it yours</h2><p className="mt-2 text-xs leading-5 text-slate-400">Change colours, width and the overall feel of your website.</p></div><div className="space-y-6 p-4"><div><label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Main colour</label><div className="mt-2 flex flex-wrap gap-2">{colors.map(c=><button key={c} onClick={()=>patchDesign({primary:c})} className={`h-8 w-8 rounded-md border-2 ${design.primary===c?"border-slate-900":"border-white"}`} style={{background:c}}/>)}</div></div><div className="grid grid-cols-2 gap-3"><Field label="Primary" value={design.primary} onChange={v=>patchDesign({primary:v})}/><Field label="Accent" value={design.accent} onChange={v=>patchDesign({accent:v})}/></div><div className="grid grid-cols-2 gap-3"><Field label="Background" value={design.background} onChange={v=>patchDesign({background:v})}/><Field label="Text" value={design.text} onChange={v=>patchDesign({text:v})}/></div><div><label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Website width</label><div className="mt-2 grid grid-cols-2 gap-2"><button onClick={()=>patchDesign({width:"wide"})} className={`rounded-md border px-3 py-2 text-xs font-bold ${design.width==="wide"?"border-blue-500 bg-blue-50 text-blue-700":"border-slate-200"}`}>Wide</button><button onClick={()=>patchDesign({width:"contained"})} className={`rounded-md border px-3 py-2 text-xs font-bold ${design.width==="contained"?"border-blue-500 bg-blue-50 text-blue-700":"border-slate-200"}`}>Contained</button></div></div><div><label className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Font</label><select value={design.font||"Inter"} onChange={e=>patchDesign({font:e.target.value})} className="mt-2 h-10 w-full rounded-md border border-slate-200 px-3 text-sm"><option>Inter</option><option>Arial</option><option>Georgia</option><option>system-ui</option></select></div></div></div>;
}

function SettingsPanel({ config, patchGlobal }) {
  const h=config.global?.header||{}; const f=config.global?.footer||{};
  return <div className="h-full overflow-y-auto bg-white"><div className="border-b border-slate-200 p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Settings</div><h2 className="mt-1 text-lg font-black">Website settings</h2><p className="mt-2 text-xs leading-5 text-slate-400">Manage the website identity and global options.</p></div><div className="space-y-5 p-4"><div className="rounded-lg border border-slate-200 p-3"><b className="text-xs">Header</b><label className="mt-3 flex items-center justify-between text-sm"><span>Show logo</span><input type="checkbox" checked={h.logo!==false} onChange={e=>patchGlobal({header:{...h,logo:e.target.checked}})}/></label><label className="mt-3 flex items-center justify-between text-sm"><span>Sticky header</span><input type="checkbox" checked={h.sticky!==false} onChange={e=>patchGlobal({header:{...h,sticky:e.target.checked}})}/></label><label className="mt-3 flex items-center justify-between text-sm"><span>Show login</span><input type="checkbox" checked={h.showLogin!==false} onChange={e=>patchGlobal({header:{...h,showLogin:e.target.checked}})}/></label></div><div className="rounded-lg border border-slate-200 p-3"><b className="text-xs">Footer</b><label className="mt-3 flex items-center justify-between text-sm"><span>Show footer</span><input type="checkbox" checked={f.show!==false} onChange={e=>patchGlobal({footer:{...f,show:e.target.checked}})}/></label><label className="mt-3 flex items-center justify-between text-sm"><span>Social links</span><input type="checkbox" checked={f.social!==false} onChange={e=>patchGlobal({footer:{...f,social:e.target.checked}})}/></label><div className="mt-3"><Field label="Footer text" value={f.text} onChange={v=>patchGlobal({footer:{...f,text:v}})}/></div></div><div className="rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-800"><b>Taskosphere branding</b><br/>Your Taskosphere logo and application identity remain separate from the website content editor.</div></div></div>;
}

export default function WebsiteBuilder() {
  const [config,setConfig]=useState(clone(DEFAULT_BUILDER));
  const [history,setHistory]=useState([]); const [future,setFuture]=useState([]);
  const [tool,setTool]=useState("pages"); const [selectedId,setSelectedId]=useState("hero");
  const [device,setDevice]=useState("desktop"); const [preview,setPreview]=useState(false); const [saving,setSaving]=useState(false); const [loaded,setLoaded]=useState(false);

  useEffect(()=>{(async()=>{try{const saved=await getAdminWebsiteConfig(); if(saved?.config){setConfig({...clone(DEFAULT_BUILDER),...saved.config,global:{...DEFAULT_BUILDER.global,...saved.config.global},pages:saved.config.pages?.length?saved.config.pages:DEFAULT_BUILDER.pages});}}catch(e){console.error(e);}finally{setLoaded(true);}})();},[]);
  const page=useMemo(()=>config.pages.find(p=>p.id===config.activePageId)||config.pages[0],[config]);
  const selected=page?.sections.find(s=>s.id===selectedId)||page?.sections[0];
  useEffect(()=>{if(selected&&!page.sections.some(s=>s.id===selectedId))setSelectedId(selected.id);},[page,selected,selectedId]);

  const commit=(updater)=>{setHistory(h=>[...h.slice(-29),clone(config)]);setFuture([]);setConfig(prev=>{const next=typeof updater==="function"?updater(prev):updater;return next;});};
  const patchPage=(patch)=>commit(prev=>({...prev,pages:prev.pages.map(p=>p.id===page.id?{...p,...patch}:p)}));
  const patchSection=(id,patch)=>commit(prev=>({...prev,pages:prev.pages.map(p=>p.id===page.id?{...p,sections:p.sections.map(s=>s.id===id?{...s,...patch}:s)}:p)}));
  const patchData=(patch)=>selected&&patchSection(selected.id,{data:{...selected.data,...patch}});
  const patchDesign=(patch)=>commit(prev=>({...prev,global:{...prev.global,design:{...prev.global.design,...patch}}}));
  const patchGlobal=(patch)=>commit(prev=>({...prev,global:{...prev.global,...patch}}));
  const undo=()=>{if(!history.length)return;const prev=history[history.length-1];setFuture(f=>[clone(config),...f]);setHistory(history.slice(0,-1));setConfig(prev);};
  const redo=()=>{if(!future.length)return;const next=future[0];setHistory(h=>[...h,clone(config)]);setFuture(future.slice(1));setConfig(next);};
  const addSection=(type)=>{const s=newSection(type);patchPage({sections:[...(page.sections||[]),s]});setSelectedId(s.id);setTool("pages");};
  const moveSection=(dir)=>{if(!selected)return;const list=[...page.sections];const i=list.findIndex(s=>s.id===selected.id);const j=i+dir;if(j<0||j>=list.length)return;[list[i],list[j]]=[list[j],list[i]];patchPage({sections:list});};
  const deleteSection=()=>{if(!selected)return;patchPage({sections:page.sections.filter(s=>s.id!==selected.id)});setSelectedId(page.sections.find(s=>s.id!==selected.id)?.id||"");};
  const duplicateSection=()=>{if(!selected)return;const i=page.sections.findIndex(s=>s.id===selected.id);const copy={...clone(selected),id:uid(selected.type),title:`${selected.title} copy`};const list=[...page.sections];list.splice(i+1,0,copy);patchPage({sections:list});setSelectedId(copy.id);};
  const addPage=()=>{const id=uid("page");const p={id,name:`Page ${config.pages.length+1}`,slug:`/page-${config.pages.length+1}`,visible:true,sections:[newSection("hero"),newSection("text")]};commit(prev=>({...prev,pages:[...prev.pages,p],activePageId:id}));setSelectedId(p.sections[0].id);};
  const renamePage=(p)=>{const name=window.prompt("Page name",p.name);if(name?.trim())patchPageById(p.id,{name:name.trim()});};
  const patchPageById=(id,patch)=>commit(prev=>({...prev,pages:prev.pages.map(p=>p.id===id?{...p,...patch}:p)}));
  const duplicatePage=(p)=>{const copy={...clone(p),id:uid("page"),name:`${p.name} copy`,slug:`${p.slug}-copy`};commit(prev=>({...prev,pages:[...prev.pages,copy],activePageId:copy.id}));setSelectedId(copy.sections[0]?.id||"");};
  const deletePage=(id)=>{if(config.pages.length===1)return;const remaining=config.pages.filter(p=>p.id!==id);commit(prev=>({...prev,pages:remaining,activePageId:remaining[0].id}));setSelectedId(remaining[0].sections[0]?.id||"");};
  const save=async()=>{setSaving(true);try{await saveWebsiteConfig(config);toast.success("Website saved");}catch(e){toast.error(e?.message||"Unable to save website");}finally{setSaving(false);}};
  const reset=async()=>{if(!window.confirm("Reset the website to the last saved version?"))return;try{const result=await resetWebsiteConfig();if(result?.config)setConfig(result.config);toast.success("Website reset");}catch(e){toast.error(e?.message||"Unable to reset website");}};

  if(!loaded)return <div className="flex h-full items-center justify-center bg-slate-100"><div className="text-sm font-bold text-slate-500">Loading Website Studio…</div></div>;

  if(preview)return <div className="flex h-full flex-col bg-slate-100"><div className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4"><div className="flex items-center gap-3"><button onClick={()=>setPreview(false)} className="grid h-9 w-9 place-items-center rounded-md border border-slate-200"><ArrowLeft size={17}/></button><div><b className="block text-sm">Website preview</b><span className="text-[10px] text-slate-400">This is how visitors will see your website.</span></div></div><div className="flex items-center gap-1"><ToolButton icon={Monitor} active={device==="desktop"} onClick={()=>setDevice("desktop")}>Desktop</ToolButton><ToolButton icon={Smartphone} active={device==="mobile"} onClick={()=>setDevice("mobile")}>Mobile</ToolButton><ToolButton icon={Save} onClick={save}>Save</ToolButton></div></div><div className="flex flex-1 justify-center overflow-auto p-6"><div className={`min-h-full bg-white shadow-xl transition-all ${device==="mobile"?"w-[390px] rounded-2xl overflow-hidden":"w-full max-w-[1180px]"}`} style={{fontFamily:config.global.design.font}}>{page.sections.filter(s=>s.visible!==false).map(s=><PreviewSection key={s.id} section={s} design={config.global.design}/>)}</div></div></div>;

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#eef2f6]" style={{fontFamily:config.global.design.font}}>
    <div className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 shadow-sm">
      <div className="flex min-w-0 items-center gap-3"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-[#0D3B66] text-white"><Sparkles size={19}/></div><div className="min-w-0"><b className="block truncate text-sm font-black text-slate-900">Taskosphere Website Studio</b><span className="text-[11px] text-slate-400">Simple editing · no coding needed</span></div></div>
      <div className="hidden items-center gap-1 md:flex"><ToolButton icon={Undo2} onClick={undo} disabled={!history.length} title="Undo"/><ToolButton icon={Redo2} onClick={redo} disabled={!future.length} title="Redo"/></div>
      <div className="flex items-center gap-2"><span className={`hidden items-center gap-1 rounded-md px-3 py-2 text-[11px] font-bold sm:flex ${saving?"bg-amber-50 text-amber-700":"bg-emerald-50 text-emerald-700"}`}><Check size={14}/>{saving?"Saving…":"Ready to save"}</span><button onClick={()=>setPreview(true)} className="hidden items-center gap-2 rounded-md px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100 sm:flex"><Eye size={15}/> Preview</button><button onClick={save} disabled={saving} className="flex items-center gap-2 rounded-md bg-slate-950 px-4 py-2.5 text-xs font-bold text-white disabled:opacity-60"><Save size={15}/> Save website</button></div>
    </div>

    <div className="grid min-h-0 flex-1 grid-cols-[88px_250px_minmax(420px,1fr)_320px] overflow-hidden">
      <aside className="border-r border-slate-800 bg-[#111827] text-white">
        <div className="flex h-full flex-col"><div className="p-2"><button onClick={()=>setTool("pages")} className={`mb-1 flex w-full flex-col items-center gap-1 rounded-md px-2 py-3 text-[10px] font-bold ${tool==="pages"?"bg-white text-[#0D3B66]":"text-slate-300 hover:bg-white/10"}`}><PanelLeft size={18}/><span>Pages</span></button><button onClick={()=>setTool("add")} className={`mb-1 flex w-full flex-col items-center gap-1 rounded-md px-2 py-3 text-[10px] font-bold ${tool==="add"?"bg-white text-[#0D3B66]":"text-slate-300 hover:bg-white/10"}`}><Plus size={18}/><span>Add</span></button><button onClick={()=>setTool("design")} className={`mb-1 flex w-full flex-col items-center gap-1 rounded-md px-2 py-3 text-[10px] font-bold ${tool==="design"?"bg-white text-[#0D3B66]":"text-slate-300 hover:bg-white/10"}`}><Palette size={18}/><span>Design</span></button><button onClick={()=>setTool("settings")} className={`mb-1 flex w-full flex-col items-center gap-1 rounded-md px-2 py-3 text-[10px] font-bold ${tool==="settings"?"bg-white text-[#0D3B66]":"text-slate-300 hover:bg-white/10"}`}><Settings2 size={18}/><span>Settings</span></button></div><div className="mt-auto border-t border-white/10 p-2"><button onClick={reset} className="flex w-full flex-col items-center gap-1 rounded-md px-2 py-3 text-[10px] font-bold text-slate-400 hover:bg-white/10 hover:text-white"><RefreshCcw size={16}/><span>Reset</span></button></div></div>
      </aside>

      <div className="min-h-0 border-r border-slate-200 bg-white">{tool==="pages"&&<PagesPanel pages={config.pages} activePageId={config.activePageId} setActivePageId={id=>{commit(prev=>({...prev,activePageId:id}));setSelectedId(config.pages.find(p=>p.id===id)?.sections[0]?.id||"");}} addPage={addPage} renamePage={renamePage} duplicatePage={duplicatePage} deletePage={deletePage}/>} {tool==="add"&&<AddPanel addSection={addSection}/>} {tool==="design"&&<DesignPanel design={config.global.design} patchDesign={patchDesign}/>} {tool==="settings"&&<SettingsPanel config={config} patchGlobal={patchGlobal}/>}</div>

      <main className="min-h-0 overflow-auto bg-[#eef2f6] p-5">
        <div className="sticky top-0 z-20 mb-4 flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm"><div><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Editing</div><b className="text-sm text-slate-900">{page.name}</b><span className="ml-2 text-xs text-slate-400">{page.slug}</span></div><div className="flex items-center gap-1 rounded-md bg-slate-100 p-1"><ToolButton icon={Monitor} active={device==="desktop"} onClick={()=>setDevice("desktop")}/><ToolButton icon={Smartphone} active={device==="mobile"} onClick={()=>setDevice("mobile")}/></div></div>
        <div className={`mx-auto overflow-hidden bg-white shadow-xl transition-all ${device==="mobile"?"max-w-[390px] rounded-xl":"max-w-[1050px]"}`}>
          {page.sections.filter(s=>s.visible!==false).map(section=><div key={section.id} onClick={()=>setSelectedId(section.id)} className={`group relative cursor-pointer border-2 transition ${selected?.id===section.id?"border-blue-500":"border-transparent hover:border-blue-200"}`}><PreviewSection section={section} design={config.global.design}/>{selected?.id===section.id&&<div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-md border border-slate-200 bg-white p-1 shadow-lg"><button className="grid h-8 w-8 place-items-center rounded text-slate-600 hover:bg-slate-100" onClick={e=>{e.stopPropagation();moveSection(-1)}} title="Move up"><ArrowUp size={15}/></button><button className="grid h-8 w-8 place-items-center rounded text-slate-600 hover:bg-slate-100" onClick={e=>{e.stopPropagation();moveSection(1)}} title="Move down"><ArrowDown size={15}/></button><button className="grid h-8 w-8 place-items-center rounded text-slate-600 hover:bg-slate-100" onClick={e=>{e.stopPropagation();duplicateSection()}} title="Duplicate"><Copy size={15}/></button><button className="grid h-8 w-8 place-items-center rounded text-red-500 hover:bg-red-50" onClick={e=>{e.stopPropagation();deleteSection()}} title="Delete"><Trash2 size={15}/></button></div>}</div>)}
        </div>
      </main>

      <aside className="min-h-0 overflow-y-auto border-l border-slate-200 bg-white"><div className="border-b border-slate-200 p-4"><div className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Edit</div><div className="mt-1 flex items-center justify-between"><h2 className="text-lg font-black text-slate-900">{selected?.title||"Select a section"}</h2>{selected&&<button className="text-red-500" onClick={deleteSection} title="Delete section"><Trash2 size={16}/></button>}</div><p className="mt-1 text-xs text-slate-400">Click a section in the page to edit it.</p></div>{selected&&<div className="p-4"><div className="mb-4 flex gap-1 rounded-md bg-slate-100 p-1"><button className="flex-1 rounded px-2 py-2 text-[10px] font-bold text-slate-600" onClick={()=>patchSection(selected.id,{layout:"split"})}>Layout</button><button className="flex-1 rounded px-2 py-2 text-[10px] font-bold text-slate-600" onClick={()=>patchSection(selected.id,{visible:selected.visible===false})}>{selected.visible===false?"Show":"Hide"}</button></div><SectionEditor section={selected} patchData={patchData}/><div className="mt-5 border-t border-slate-200 pt-4"><div className="grid grid-cols-3 gap-2"><button onClick={()=>moveSection(-1)} className="rounded-md border border-slate-200 py-2 text-[10px] font-bold"><ArrowUp size={13} className="mx-auto"/>Up</button><button onClick={()=>moveSection(1)} className="rounded-md border border-slate-200 py-2 text-[10px] font-bold"><ArrowDown size={13} className="mx-auto"/>Down</button><button onClick={duplicateSection} className="rounded-md border border-slate-200 py-2 text-[10px] font-bold"><Copy size={13} className="mx-auto"/>Copy</button></div></div></div>}</aside>
    </div>
  </div>;
}
