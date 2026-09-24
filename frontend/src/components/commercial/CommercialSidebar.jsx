import React from "react";
import {
  LayoutDashboard, Users, KeyRound, Layers, CreditCard,
  Globe, Sparkles, Activity, ShieldAlert, HeartPulse,
  Sliders, ShieldCheck, ChevronRight, Mail, FileText, Send, Lock
} from "lucide-react";

export const SECTIONS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, category: "core" },
  { id: "customers", label: "Customers", icon: Users, category: "core" },
  { id: "licenses", label: "Licenses", icon: KeyRound, category: "core" },
  { id: "plans", label: "Plans & Tiers", icon: CreditCard, category: "core" },
  { id: "modules", label: "Modules & Access", icon: Layers, category: "core" },
  
  { id: "website", label: "Website & Domains", icon: Globe, category: "experience" },
  { id: "aiweave", label: "AIWeave & Omni", icon: Sparkles, category: "experience" },

  { id: "email-config", label: "Email Settings", icon: Mail, category: "communication" },
  { id: "email-templates", label: "Email Templates", icon: FileText, category: "communication" },
  { id: "email-logs", label: "Delivery Logs", icon: Send, category: "communication" },
  { id: "auth-recovery", label: "Account Recovery", icon: Lock, category: "communication" },
  
  { id: "analytics", label: "Usage & Telemetry", icon: Activity, category: "operations" },
  { id: "audit", label: "Activity Audit", icon: ShieldAlert, category: "operations" },
  { id: "health", label: "System Health", icon: HeartPulse, category: "operations" },
];

export default function CommercialSidebar({ currentTab, setTab, stats, unreadAlerts = 0 }) {
  return (
    <aside className="w-full lg:w-64 shrink-0 border-r border-slate-200 bg-white min-h-screen flex flex-col">
      <div className="p-5 border-b border-slate-100 flex items-center gap-3">
        <div className="h-10 w-10 rounded-2xl bg-[#0D3B66] text-white flex items-center justify-center shadow-md font-black text-lg tracking-wider">
          TS
        </div>
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-[#1F6FB2]">Master Console</div>
          <div className="text-sm font-black text-slate-900 leading-tight">Commercial Control</div>
        </div>
      </div>

      <div className="p-3 flex-1 overflow-y-auto space-y-6">
        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Core SaaS Management</div>
          <nav className="space-y-1">
            {SECTIONS.filter(s => s.category === "core").map(item => {
              const Icon = item.icon;
              const active = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    active
                      ? "bg-[#0D3B66] text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} className={active ? "text-white" : "text-slate-400"} />
                    <span>{item.label}</span>
                  </div>
                  {item.id === "customers" && stats?.customers ? (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] ${active ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"}`}>
                      {stats.customers}
                    </span>
                  ) : null}
                  {item.id === "licenses" && stats?.active ? (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] ${active ? "bg-white/20 text-white" : "bg-emerald-50 text-emerald-700"}`}>
                      {stats.active}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
        </div>

        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Customer Experience</div>
          <nav className="space-y-1">
            {SECTIONS.filter(s => s.category === "experience").map(item => {
              const Icon = item.icon;
              const active = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    active
                      ? "bg-[#0D3B66] text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} className={active ? "text-white" : "text-slate-400"} />
                    <span>{item.label}</span>
                  </div>
                  {item.id === "website" && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-blue-50 text-blue-600 font-medium">Studio</span>
                  )}
                  {item.id === "aiweave" && (
                    <span className="text-[10px] px-2 py-0.5 rounded bg-purple-50 text-purple-600 font-medium">Omni</span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Email & Auth Security</div>
          <nav className="space-y-1">
            {SECTIONS.filter(s => s.category === "communication").map(item => {
              const Icon = item.icon;
              const active = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    active
                      ? "bg-[#0D3B66] text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} className={active ? "text-white" : "text-slate-400"} />
                    <span>{item.label}</span>
                  </div>
                </button>
              );
            })}
          </nav>
        </div>

        <div>
          <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-widest text-slate-400">Operations & Health</div>
          <nav className="space-y-1">
            {SECTIONS.filter(s => s.category === "operations").map(item => {
              const Icon = item.icon;
              const active = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTab(item.id)}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-semibold transition-all ${
                    active
                      ? "bg-[#0D3B66] text-white shadow-sm"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <Icon size={16} className={active ? "text-white" : "text-slate-400"} />
                    <span>{item.label}</span>
                  </div>
                  {item.id === "health" && (
                    <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="p-4 border-t border-slate-100 bg-slate-50/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-600">
            <ShieldCheck size={16} className="text-emerald-600" />
            <span className="font-semibold">Platform Owner</span>
          </div>
          <span className="text-[10px] font-bold text-slate-400">v2.4.0</span>
        </div>
      </div>
    </aside>
  );
}
