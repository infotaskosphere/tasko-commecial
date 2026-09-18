import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check, ShieldCheck, Sparkles, Zap } from "lucide-react";

const MODULES = [
  { name: "Taskosphere", logo: "/logo-transparent.png", description: "Plan, assign and track work effortlessly.", route: "/tasks", tone: "blue" },
  { name: "Finix", logo: "/finix-logo.png", description: "Simple, smart finance and accounting.", route: "/finix-dashboard", tone: "green" },
  { name: "CompliGenie", logo: "/compligenie-logo.png", description: "Never miss a compliance obligation.", route: "/compliance-dashboard", tone: "orange" },
  { name: "LeadSense", logo: "/leadsense-logo.png", description: "Manage leads and convert opportunities.", route: "/client-proposals-dashboard", tone: "purple" },
  { name: "People Matrix", logo: "/people-matrix-logo.png", description: "HRMS, attendance, payroll and people.", route: "/people-matrix", tone: "pink" },
];

const BENEFITS = [
  { title: "One Platform", text: "Multiple business functions connected in one workspace.", icon: Zap },
  { title: "Secure & Reliable", text: "Permissions and controlled access for your business data.", icon: ShieldCheck },
  { title: "Access Anywhere", text: "Work from the office, home or wherever business takes you.", icon: Sparkles },
  { title: "Dedicated Support", text: "A support experience designed around your team.", icon: Check },
];

function ModuleCard({ module, compact = false }) {
  return (
    <Link to={module.route} className="group flex h-full min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_6px_24px_rgba(15,23,42,.04)] transition duration-200 hover:-translate-y-1 hover:border-blue-200 hover:shadow-[0_18px_45px_rgba(15,23,42,.10)]">
      <div className="flex h-14 items-center">
        <img src={module.logo} alt={module.name} className="max-h-12 max-w-[150px] object-contain" loading="lazy" />
      </div>
      <h3 className="mt-4 text-base font-extrabold tracking-tight text-slate-950">{module.name}</h3>
      <p className="mt-2 min-h-10 text-xs leading-5 text-slate-500">{module.description}</p>
      <div className="mt-auto pt-5">
        <div className="flex items-end justify-between border-t border-slate-100 pt-4">
          <div><div className="text-[9px] font-bold uppercase tracking-[.12em] text-slate-400">Annual licence</div><div className="mt-1 text-xl font-black text-[#102A56]">₹2,999 <span className="text-[10px] font-semibold text-slate-400">/ year</span></div></div>
          {!compact && <span className="flex h-8 w-8 items-center justify-center rounded-full border border-blue-200 text-blue-600 transition group-hover:bg-blue-600 group-hover:text-white"><ArrowRight size={15} /></span>}
        </div>
      </div>
    </Link>
  );
}

export default function ModernOneNexaHome() {
  return (
    <div className="min-h-screen overflow-x-hidden bg-white text-slate-900">
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur-xl">
        <div className="mx-auto flex min-h-[76px] w-full max-w-7xl items-center gap-5 px-5 sm:px-8">
          <Link to="/" className="flex min-w-0 flex-1 items-center">
            <img src="/onenexa-logo.png" alt="OneNexa" className="h-11 w-auto max-w-[190px] object-contain" />
          </Link>
          <nav className="hidden items-center gap-7 md:flex">
            <a href="#modules" className="text-sm font-semibold text-slate-600 hover:text-slate-950">Modules</a>
            <a href="#why" className="text-sm font-semibold text-slate-600 hover:text-slate-950">Why OneNexa</a>
            <a href="#pricing" className="text-sm font-semibold text-slate-600 hover:text-slate-950">Pricing</a>
            <a href="#faq" className="text-sm font-semibold text-slate-600 hover:text-slate-950">FAQs</a>
          </nav>
          <Link to="/login" className="shrink-0 rounded-xl bg-[#102A56] px-5 py-3 text-sm font-bold text-white shadow-[0_10px_24px_rgba(16,42,86,.18)] transition hover:-translate-y-0.5 hover:bg-[#0b2144]">Sign in</Link>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden bg-[linear-gradient(135deg,#f8fbff_0%,#eef7ff_52%,#f4fffb_100%)]">
          <div className="absolute -left-28 top-10 h-80 w-80 rounded-full bg-blue-200/30 blur-3xl" />
          <div className="absolute -right-20 bottom-0 h-96 w-96 rounded-full bg-emerald-200/25 blur-3xl" />
          <div className="relative mx-auto grid min-h-[620px] w-full max-w-7xl items-center gap-12 px-5 py-16 sm:px-8 lg:grid-cols-[.9fr_1.1fr] lg:py-20">
            <div className="min-w-0">
              <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-[10px] font-bold uppercase tracking-[.16em] text-blue-700"><Sparkles size={13} className="mr-2" />All-in-one business operating system</div>
              <h1 className="mt-6 max-w-2xl text-5xl font-black leading-[.98] tracking-[-.065em] text-[#102A56] sm:text-6xl xl:text-7xl">Simplify today.<br /><span className="text-[#1687F7]">Scale tomorrow.</span></h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">OneNexa brings together task management, finance, compliance, HRMS and growth into one intelligent platform built for modern businesses.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#modules" className="rounded-xl bg-[#1687F7] px-6 py-3.5 text-sm font-bold text-white shadow-lg transition hover:-translate-y-0.5">Explore Modules <ArrowRight size={16} className="ml-2 inline" /></a>
                <Link to="/login" className="rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-bold text-slate-800">Get Started</Link>
              </div>
              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-slate-500"><span>✓ Modular pricing</span><span>✓ Secure workspace</span><span>✓ Built to scale</span></div>
            </div>

            <div className="relative min-w-0">
              <div className="absolute inset-5 rounded-[2rem] bg-blue-200/40 blur-2xl" />
              <div className="relative overflow-hidden rounded-[2rem] border border-white/80 bg-white/90 p-4 shadow-[0_30px_80px_rgba(15,23,42,.14)] backdrop-blur-xl">
                <div className="flex items-center gap-2 border-b border-slate-100 px-2 pb-3"><span className="h-2.5 w-2.5 rounded-full bg-slate-200" /><span className="h-2.5 w-2.5 rounded-full bg-slate-200" /><span className="h-2.5 w-2.5 rounded-full bg-slate-200" /><span className="ml-auto h-7 w-36 rounded-full bg-slate-100" /></div>
                <div className="grid gap-4 p-2 sm:grid-cols-[145px_1fr]">
                  <div className="rounded-2xl bg-[#102A56] p-4 text-white">
                    <img src="/onenexa-logo.png" alt="OneNexa" className="mb-7 max-h-9 max-w-full object-contain brightness-0 invert" />
                    <div className="space-y-2.5 text-[10px] text-white/70"><div className="rounded-lg bg-white/15 px-3 py-2 text-white">Dashboard</div><div>Tasks</div><div>Finix</div><div>Compliance</div><div>People</div><div>LeadSense</div></div>
                  </div>
                  <div className="min-w-0 p-1">
                    <div className="flex items-end justify-between gap-3"><div><div className="text-[9px] font-bold tracking-[.16em] text-slate-400">ONENEXA WORKSPACE</div><div className="mt-1 text-xl font-black tracking-tight text-slate-900 sm:text-2xl">Everything in one place.</div></div><div className="rounded-xl bg-emerald-50 px-3 py-2 text-[9px] font-bold text-emerald-700">All systems ready</div></div>
                    <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">{[["Tasks","128"],["Clients","56"],["Due this week","12"],["Productivity","94%"]].map(([label,value])=><div key={label} className="rounded-xl border border-slate-100 bg-slate-50 p-3"><div className="text-[9px] font-semibold text-slate-400">{label}</div><div className="mt-2 text-xl font-black text-slate-900">{value}</div></div>)}</div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-[1.2fr_.8fr]"><div className="h-32 rounded-xl border border-slate-100 bg-white p-3"><div className="text-[9px] font-bold text-slate-500">Business activity</div><div className="mt-5 flex h-16 items-end gap-2">{[35,55,45,70,58,82,68].map((height,index)=><div key={index} className="flex-1 rounded-t-md bg-blue-200" style={{height: height+"%"}} />)}</div></div><div className="h-32 rounded-xl border border-slate-100 bg-white p-3"><div className="text-[9px] font-bold text-slate-500">Upcoming</div><div className="mt-3 space-y-2 text-[9px] text-slate-600"><div>GST return <span className="float-right font-bold text-red-500">18 Sep</span></div><div>ROC filing <span className="float-right font-bold">20 Sep</span></div><div>Trademark <span className="float-right font-bold">25 Sep</span></div></div></div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="modules" className="border-y border-slate-200 bg-white py-20">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-8">
            <div className="mx-auto mb-12 max-w-3xl text-center"><p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-600">Our products</p><h2 className="mt-2 text-3xl font-black tracking-[-.045em] text-slate-950 sm:text-4xl">Powerful modules for every business need</h2><p className="mt-4 text-base leading-7 text-slate-600">Choose the products you need. Every module is available at the same simple annual price.</p></div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">{MODULES.map(module => <ModuleCard key={module.name} module={module} />)}</div>
          </div>
        </section>

        <section id="why" className="bg-[#f8fbff] py-20">
          <div className="mx-auto grid w-full max-w-7xl gap-10 px-5 sm:px-8 lg:grid-cols-[.8fr_1.2fr] lg:items-center">
            <div><p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-600">Why OneNexa</p><h2 className="mt-3 text-3xl font-black tracking-[-.045em] text-[#102A56] sm:text-4xl">One platform. Every business function.</h2><p className="mt-5 max-w-xl text-base leading-8 text-slate-600">Connect work, finance, people, compliance and growth without scattering information across disconnected systems. OneNexa gives your team one clear operating layer.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">{BENEFITS.map(({title,text:body,icon:Icon})=><div key={title} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600"><Icon size={18}/></div><h3 className="mt-4 text-sm font-extrabold">{title}</h3><p className="mt-2 text-xs leading-5 text-slate-500">{body}</p></div>)}</div>
          </div>
        </section>

        <section id="pricing" className="bg-white py-20">
          <div className="mx-auto w-full max-w-7xl px-5 sm:px-8">
            <div className="mx-auto mb-12 max-w-3xl text-center"><p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-600">Simple pricing</p><h2 className="mt-2 text-3xl font-black tracking-[-.045em] text-slate-950 sm:text-4xl">Every module. ₹2,999 per year.</h2><p className="mt-4 text-base text-slate-600">No confusing packages. Activate the products your business needs and expand whenever you are ready.</p></div>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">{MODULES.map(module=><ModuleCard key={"price-"+module.name} module={module} compact />)}</div>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs font-semibold text-slate-500"><span>✓ One simple annual price</span><span>✓ Activate only what you need</span><span>✓ Add modules anytime</span></div>
          </div>
        </section>

        <section className="bg-slate-50 py-12"><div className="mx-auto grid w-full max-w-7xl gap-3 px-5 sm:grid-cols-2 sm:px-8 lg:grid-cols-4">{BENEFITS.map(({title,icon:Icon})=><div key={title} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-4"><Icon size={18} className="shrink-0 text-blue-600"/><span className="text-sm font-bold text-slate-800">{title}</span></div>)}</div></section>

        <section id="faq" className="bg-white py-20"><div className="mx-auto w-full max-w-4xl px-5 sm:px-8"><div className="text-center"><p className="text-[11px] font-bold uppercase tracking-[.18em] text-blue-600">FAQs</p><h2 className="mt-2 text-3xl font-black tracking-[-.04em]">Questions, answered.</h2></div><div className="mt-10 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">{[["What does OneNexa include?","OneNexa connects Taskosphere, Finix, CompliGenie, LeadSense and People Matrix in one business platform."],["What is the price?","Each listed module is ₹2,999 per year."],["Can I activate only one module?","Yes. Modules can be activated according to the capabilities your business needs."],["Can I add more modules later?","Yes. You can expand your OneNexa workspace by adding additional modules." ]].map(([question,answer])=><details key={question} className="p-5"><summary className="cursor-pointer list-none font-bold text-slate-900">{question}</summary><p className="mt-3 text-sm leading-6 text-slate-600">{answer}</p></details>)}</div></div></section>

        <section className="relative overflow-hidden bg-[linear-gradient(135deg,#102A56_0%,#0b426d_55%,#087f75_100%)] py-16 text-white"><div className="mx-auto max-w-4xl px-5 text-center sm:px-8"><p className="text-[10px] font-bold uppercase tracking-[.2em] text-emerald-200">Ready to transform your business?</p><h2 className="mt-3 text-3xl font-black tracking-[-.045em] sm:text-5xl">Get started with OneNexa today.</h2><p className="mx-auto mt-4 max-w-2xl text-white/75">All modules are just ₹2,999 per year. Bring your business functions together in one modern workspace.</p><div className="mt-8 flex flex-wrap justify-center gap-3"><Link to="/login" className="inline-flex items-center rounded-xl bg-white px-6 py-3.5 text-sm font-bold text-[#102A56]">Get Started <ArrowRight size={16} className="ml-2"/></Link><a href="#modules" className="inline-flex items-center rounded-xl border border-white/25 bg-white/10 px-6 py-3.5 text-sm font-bold text-white">View Modules</a></div></div></section>
      </main>

      <footer className="border-t border-slate-200 bg-white py-10"><div className="mx-auto flex w-full max-w-7xl flex-col gap-3 px-5 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-8"><div><span className="font-extrabold text-slate-900">OneNexa</span> — One Platform. Every Business Function.</div><div>© 2026 OneNexa. All rights reserved.</div></div></footer>
    </div>
  );
}
