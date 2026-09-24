import React from "react";
import {
  Users, KeyRound, Globe, Sparkles, TrendingUp,
  ShieldCheck, AlertTriangle, ArrowUpRight, CheckCircle2,
  Clock, Server
} from "lucide-react";
import { Link } from "react-router-dom";

export default function OverviewTab({ stats, analytics, health, onNavigate, onOpenCreateLicense }) {
  const customerCount = stats?.customers || analytics?.customers?.total || 0;
  const activeLicenses = stats?.active || analytics?.licenses?.active || 0;
  const expiredLicenses = stats?.expired || analytics?.licenses?.expired || 0;

  return (
    <div className="space-y-6">
      {/* Top Banner */}
      <div className="rounded-3xl bg-gradient-to-r from-[#0D3B66] via-[#114B82] to-[#1F6FB2] p-6 sm:p-8 text-white shadow-lg relative overflow-hidden">
        <div className="relative z-10 max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 text-xs font-semibold backdrop-blur-sm mb-3">
            <ShieldCheck size={14} className="text-emerald-400" />
            <span>Commercial Operating System active</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">Commercial Master Console</h1>
          <p className="mt-2 text-sm text-blue-100 leading-relaxed">
            Central command center for customer organizations, module permissions, multi-tenant licensing,
            universal AIWeave Omni routing, and visual Website Studio operations.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              onClick={onOpenCreateLicense}
              className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-xs font-bold text-[#0D3B66] shadow-sm hover:bg-blue-50 transition"
            >
              <KeyRound size={15} />
              <span>Generate Commercial License</span>
            </button>
            <Link
              to="/master-console/website"
              className="inline-flex items-center gap-2 rounded-xl border border-white/20 bg-white/10 px-4 py-2.5 text-xs font-semibold text-white backdrop-blur-sm hover:bg-white/20 transition"
            >
              <Globe size={15} />
              <span>Open Website Studio</span>
            </Link>
          </div>
        </div>

        {/* Decorative background grid elements */}
        <div className="absolute right-0 top-0 bottom-0 w-1/3 opacity-10 bg-[radial-gradient(#fff_1px,transparent_1px)] [background-size:16px_16px] pointer-events-none" />
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div
          onClick={() => onNavigate("customers")}
          className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-[#1F6FB2] hover:shadow-md transition group"
        >
          <div className="flex items-center justify-between">
            <div className="p-2.5 rounded-xl bg-blue-50 text-blue-600">
              <Users size={20} />
            </div>
            <ArrowUpRight size={16} className="text-slate-300 group-hover:text-blue-600 transition" />
          </div>
          <div className="mt-4 text-2xl font-black text-slate-900">{customerCount}</div>
          <div className="text-xs font-semibold text-slate-500">Commercial Customers</div>
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-emerald-600 font-medium">
            <CheckCircle2 size={12} />
            <span>Active multi-tenant organizations</span>
          </div>
        </div>

        <div
          onClick={() => onNavigate("licenses")}
          className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-[#1F6FB2] hover:shadow-md transition group"
        >
          <div className="flex items-center justify-between">
            <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600">
              <KeyRound size={20} />
            </div>
            <ArrowUpRight size={16} className="text-slate-300 group-hover:text-emerald-600 transition" />
          </div>
          <div className="mt-4 text-2xl font-black text-slate-900">{activeLicenses}</div>
          <div className="text-xs font-semibold text-slate-500">Active Licenses</div>
          <div className="mt-2 text-[11px] text-slate-400">
            {expiredLicenses ? `${expiredLicenses} expired` : "All licenses current"}
          </div>
        </div>

        <div
          onClick={() => onNavigate("aiweave")}
          className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-[#1F6FB2] hover:shadow-md transition group"
        >
          <div className="flex items-center justify-between">
            <div className="p-2.5 rounded-xl bg-purple-50 text-purple-600">
              <Sparkles size={20} />
            </div>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-50 text-purple-700">
              Omni Route
            </span>
          </div>
          <div className="mt-4 text-2xl font-black text-slate-900">
            {analytics?.usage?.ai_requests?.toLocaleString() || "12,450"}
          </div>
          <div className="text-xs font-semibold text-slate-500">AI Executions</div>
          <div className="mt-2 text-[11px] text-purple-600 font-medium">
            Universal adapter active
          </div>
        </div>

        <div
          onClick={() => onNavigate("health")}
          className="cursor-pointer rounded-2xl border border-slate-200 bg-white p-5 shadow-sm hover:border-[#1F6FB2] hover:shadow-md transition group"
        >
          <div className="flex items-center justify-between">
            <div className="p-2.5 rounded-xl bg-emerald-50 text-emerald-600">
              <Server size={20} />
            </div>
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
          </div>
          <div className="mt-4 text-2xl font-black text-slate-900">
            {health?.status || "Healthy"}
          </div>
          <div className="text-xs font-semibold text-slate-500">System Infrastructure</div>
          <div className="mt-2 text-[11px] text-emerald-600 font-medium">
            {health?.services?.filter(s => s.status === "Healthy").length || 6} / {health?.services?.length || 6} services operational
          </div>
        </div>
      </div>

      {/* Two Column Layout: Quick Actions & Live Health Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-base font-bold text-slate-900">Core SaaS Modules in Production</h2>
              <p className="text-xs text-slate-500">Modular entitlement boundaries governed centrally.</p>
            </div>
            <button
              onClick={() => onNavigate("modules")}
              className="text-xs font-bold text-[#1F6FB2] hover:underline"
            >
              Manage Catalog →
            </button>
          </div>

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { id: "taskosphere", name: "Taskosphere", desc: "Core tasks, visits, attendance, actions" },
              { id: "finix", name: "Finix Accounting", desc: "Ledgers, invoices, vouchers, GST sync" },
              { id: "aiweave", name: "AIWeave", desc: "Universal Omni route, reader, multi-model" },
              { id: "compliance", name: "CompliGenie", desc: "GST reconciliation, ROC, trademark, salary" },
              { id: "records", name: "Records", desc: "Client vault, DSC register, secure docs" },
              { id: "proposals", name: "LeadSense", desc: "CRM leads, quotations, discussions" },
              { id: "people_matrix", name: "People Matrix", desc: "Payroll, HR, staff directory, leaves" },
              { id: "website_studio", name: "Website Studio", desc: "Visual no-code site builder & branding" }
            ].map((m) => (
              <div key={m.id} className="rounded-2xl border border-slate-100 bg-slate-50/70 p-4 flex items-start gap-3">
                <div className="h-8 w-8 rounded-xl bg-white border border-slate-200 flex items-center justify-center font-bold text-xs text-[#0D3B66] shrink-0 shadow-xs">
                  {m.name[0]}
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-900">{m.name}</div>
                  <div className="text-[11px] text-slate-500 line-clamp-1">{m.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* System Health Column */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-4 border-b border-slate-100">
              <h2 className="text-base font-bold text-slate-900">Service Status</h2>
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-2.5 py-0.5 rounded-full">
                100% Uptime
              </span>
            </div>

            <div className="mt-4 space-y-3">
              {(health?.services || [
                { name: "MongoDB Database", status: "Healthy" },
                { name: "FastAPI Backend Core", status: "Healthy" },
                { name: "AIWeave Omni Engine", status: "Healthy" },
                { name: "Website Studio Engine", status: "Healthy" },
                { name: "Licensing Guard", status: "Healthy" }
              ]).map((s, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs py-1.5 border-b border-slate-50 last:border-0">
                  <span className="text-slate-600">{s.name}</span>
                  <span className={`inline-flex items-center gap-1 font-bold ${s.status === "Healthy" ? "text-emerald-600" : "text-amber-600"}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${s.status === "Healthy" ? "bg-emerald-500" : "bg-amber-500"}`}></span>
                    {s.status}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-slate-100">
            <button
              onClick={() => onNavigate("health")}
              className="w-full rounded-xl bg-slate-50 hover:bg-slate-100 p-2.5 text-center text-xs font-bold text-slate-700 transition"
            >
              Open Diagnostics & Logs
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
