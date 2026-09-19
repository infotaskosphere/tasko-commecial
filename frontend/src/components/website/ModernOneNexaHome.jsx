import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, BarChart3, Bell, CalendarDays, Check, CircleDollarSign, ClipboardList, Home as HomeIcon, Search, Settings, ShieldCheck, Sparkles, TrendingUp, UserRound, Users, Zap } from "lucide-react";

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
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/95 backdrop-blur-xl">
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
        <section className="relative overflow-hidden bg-[linear-gradient(135deg,#f8fbff_0%,#eef7ff_52%,#f4fffb_100%)] lg:min-h-[calc(100vh-76px)]">
          <div className="pointer-events-none absolute -left-28 top-10 h-80 w-80 rounded-full bg-blue-200/30 blur-3xl" />
          <div className="pointer-events-none absolute -right-20 bottom-0 h-96 w-96 rounded-full bg-emerald-200/25 blur-3xl" />
          <div className="relative mx-auto grid min-h-[680px] w-full max-w-7xl items-center gap-10 px-5 py-12 sm:px-8 lg:grid-cols-[.82fr_1.18fr] lg:gap-10 lg:py-10">
            <div className="min-w-0">
              <div className="inline-flex items-center rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-[10px] font-bold uppercase tracking-[.16em] text-blue-700"><Sparkles size={13} className="mr-2" />All-in-one business operating system</div>
              <h1 className="mt-6 max-w-2xl text-5xl font-black leading-[.96] tracking-[-.065em] text-[#102A56] sm:text-6xl xl:text-7xl">Simplify today.<br /><span className="text-[#1687F7]">Scale tomorrow.</span></h1>
              <p className="mt-6 max-w-xl text-base leading-7 text-slate-600 sm:text-lg">OneNexa brings together task management, finance, compliance, HRMS and growth into one intelligent platform built for modern businesses.</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <a href="#modules" className="rounded-xl bg-[#1687F7] px-6 py-3.5 text-sm font-bold text-white shadow-[0_12px_25px_rgba(22,135,247,.22)] transition hover:-translate-y-0.5">Explore Modules <ArrowRight size={16} className="ml-2 inline" /></a>
                <Link to="/login" className="rounded-xl border border-slate-300 bg-white px-6 py-3.5 text-sm font-bold text-slate-800 shadow-sm">Get Started</Link>
              </div>
              <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-xs font-semibold text-slate-500"><span>✓ Modular pricing</span><span>✓ Secure workspace</span><span>✓ Built to scale</span></div>
            </div>

            <div className="relative min-w-0">
              <div className="absolute inset-3 rounded-[2rem] bg-blue-200/40 blur-3xl" />
              <div className="relative overflow-hidden rounded-[1.75rem] border border-white/90 bg-white shadow-[0_30px_80px_rgba(15,23,42,.16)]">
                <div className="flex h-12 items-center gap-2 border-b border-slate-100 bg-white px-4">
                  <img src="/onenexa-logo.png" alt="OneNexa" className="h-7 w-auto max-w-[125px] object-contain" />
                  <div className="ml-3 hidden h-8 max-w-[245px] flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 sm:flex">
                    <Search size={13} className="text-slate-400" />
                    <span className="text-[9px] text-slate-400">Search anything...</span>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="relative flex h-8 w-8 items-center justify-center rounded-lg border border-slate-100 text-slate-500"><Bell size={14} /><span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500" /></div>
                    <div className="flex h-8 items-center gap-2 rounded-lg bg-slate-50 px-2"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#102A56] text-[8px] font-bold text-white">JD</span><span className="hidden text-[9px] font-bold text-slate-700 sm:inline">John Doe</span></div>
                  </div>
                </div>

                <div className="grid gap-3 bg-slate-50/60 p-3 sm:grid-cols-[150px_1fr]">
                  <aside className="rounded-2xl bg-[#102A56] p-3 text-white shadow-inner">
                    <div className="mb-5 flex items-center gap-2 px-1">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm font-black text-white">N</span>
                      <div><div className="text-[11px] font-black tracking-tight">OneNexa</div><div className="text-[6px] font-medium uppercase tracking-[.13em] text-white/45">All in one. Ahead always.</div></div>
                    </div>
                    <div className="space-y-1 text-[10px]">
                      {[
                        ["Dashboard", HomeIcon],
                        ["Tasks", ClipboardList],
                        ["Finix", CircleDollarSign],
                        ["Compliance", ShieldCheck],
                        ["People", Users],
                        ["LeadSense", TrendingUp],
                        ["Clients", UserRound],
                        ["Reports", BarChart3],
                      ].map(([label, Icon], index) => (
                        <div key={label} className={`flex items-center gap-2 rounded-lg px-3 py-2.5 ${index === 0 ? "bg-white/15 text-white shadow-sm" : "text-white/65"}`}>
                          <Icon size={12} />
                          <span>{label}</span>
                        </div>
                      ))}
                    </div>
                    <div className="mt-5 border-t border-white/10 pt-3 text-[9px] text-white/50"><div className="flex items-center gap-2 px-3 py-2"><Settings size={12} /> Settings</div></div>
                  </aside>

                  <div className="min-w-0 p-1">
                    <div className="flex items-end justify-between gap-3">
                      <div><div className="text-[8px] font-bold tracking-[.16em] text-slate-400">ONENEXA WORKSPACE</div><div className="mt-1 text-xl font-black tracking-tight text-slate-900 sm:text-2xl">Everything in one place.</div><div className="mt-1 text-[9px] text-slate-500">Your business at a glance.</div></div>
                      <div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-[8px] font-bold text-slate-600 sm:flex"><CalendarDays size={12} /> Sat, 19 Sep 2026</div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                      {[
                        ["Tasks", "128", "+12%", ClipboardList, "text-blue-600", "bg-blue-50"],
                        ["Clients", "56", "+8%", Users, "text-emerald-600", "bg-emerald-50"],
                        ["Due This Week", "12", "-5%", CalendarDays, "text-orange-600", "bg-orange-50"],
                        ["Productivity", "94%", "+6%", BarChart3, "text-purple-600", "bg-purple-50"],
                      ].map(([label, value, change, Icon, iconColor, iconBg]) => (
                        <div key={label} className="rounded-xl border border-slate-100 bg-white p-2.5 shadow-[0_4px_16px_rgba(15,23,42,.04)]">
                          <div className="flex items-center justify-between"><span className={`flex h-7 w-7 items-center justify-center rounded-lg ${iconBg} `}><Icon size={13} className={iconColor} /></span><span className={`text-[7px] font-bold ${change.startsWith("-") ? "text-red-500" : "text-emerald-600"}`}>{change}</span></div>
                          <div className="mt-2 text-[8px] font-semibold text-slate-400">{label}</div>
                          <div className="mt-0.5 text-xl font-black text-slate-900">{value}</div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 grid gap-2.5 sm:grid-cols-[1.2fr_.8fr]">
                      <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-[0_4px_16px_rgba(15,23,42,.03)]">
                        <div className="flex items-center justify-between"><div className="text-[9px] font-bold text-slate-700">Business Activity</div><span className="text-[7px] font-semibold text-slate-400">This Week</span></div>
                        <div className="mt-3 flex h-20 items-end gap-2">
                          {[35,55,45,70,58,82,68].map((height,index)=><div key={index} className="flex h-full flex-1 items-end"><div className="w-full rounded-t-md bg-blue-200" style={{height: height+"%"}} /></div>)}
                        </div>
                        <div className="mt-1 flex justify-between px-1 text-[6px] font-semibold text-slate-400"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div>
                      </div>
                      <div className="rounded-xl border border-slate-100 bg-white p-3 shadow-[0_4px_16px_rgba(15,23,42,.03)]">
                        <div className="flex items-center justify-between"><div className="text-[9px] font-bold text-slate-700">Upcoming</div><span className="text-[7px] font-bold text-blue-600">View All</span></div>
                        <div className="mt-3 space-y-2.5 text-[8px] text-slate-600">
                          <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-purple-500" />GST return</span><b className="text-red-500">18 Sep</b></div>
                          <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-pink-500" />ROC filing</span><b>20 Sep</b></div>
                          <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />Trademark</span><b>25 Sep</b></div>
                          <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-orange-500" />TDS payment</span><b>28 Sep</b></div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-2.5 grid gap-2.5 sm:grid-cols-[1.15fr_.85fr]">
                      <div className="rounded-xl border border-slate-100 bg-white p-3">
                        <div className="flex items-center justify-between"><div className="text-[9px] font-bold text-slate-700">Recent Tasks</div><span className="text-[7px] font-bold text-blue-600">View All</span></div>
                        <div className="mt-2.5 space-y-2 text-[8px] text-slate-600">
                          <div className="flex items-center gap-2"><span className="h-3 w-3 rounded border border-slate-300" /><span className="min-w-0 flex-1 truncate">Prepare board resolution</span><span className="rounded bg-red-50 px-1.5 py-0.5 text-[6px] font-bold text-red-500">High</span><b className="text-[7px] text-slate-400">19 Sep</b></div>
                          <div className="flex items-center gap-2"><span className="h-3 w-3 rounded border border-slate-300" /><span className="min-w-0 flex-1 truncate">Client document review</span><span className="rounded bg-amber-50 px-1.5 py-0.5 text-[6px] font-bold text-amber-600">Medium</span><b className="text-[7px] text-slate-400">20 Sep</b></div>
                          <div className="flex items-center gap-2"><span className="h-3 w-3 rounded border border-slate-300" /><span className="min-w-0 flex-1 truncate">Trademark application filing</span><span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[6px] font-bold text-emerald-600">Low</span><b className="text-[7px] text-slate-400">22 Sep</b></div>
                        </div>
                      </div>
                      <div className="rounded-xl border border-slate-100 bg-white p-3">
                        <div className="flex items-center justify-between"><div className="text-[9px] font-bold text-slate-700">Module Quick Access</div><span className="text-[7px] font-bold text-blue-600">View All</span></div>
                        <div className="mt-2.5 grid grid-cols-4 gap-1.5">
                          {[[ClipboardList,"Tasks","bg-blue-50","text-blue-600"],[CircleDollarSign,"Finix","bg-emerald-50","text-emerald-600"],[ShieldCheck,"Compliance","bg-orange-50","text-orange-600"],[Users,"People","bg-purple-50","text-purple-600"]].map(([Icon,label,bg,fg])=><div key={label} className="text-center"><span className={`mx-auto flex h-8 w-8 items-center justify-center rounded-lg ${bg} `}><Icon size={14} className={fg} /></span><div className="mt-1 text-[6px] font-bold text-slate-500">{label}</div></div>)}
                        </div>
                      </div>
                    </div>
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
