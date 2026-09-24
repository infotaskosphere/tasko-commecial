import React from "react";
import { HeartPulse, CheckCircle2, AlertTriangle, RefreshCw, Server, Database, ShieldCheck, Mail, Cpu, Globe } from "lucide-react";

export default function SystemHealthTab({ health = {}, onRefresh, loading = false }) {
  const services = health.services || [];
  const allHealthy = services.every(s => s.status === "Healthy");

  return (
    <div className="space-y-6">
      {/* Top Health Badge */}
      <div className={`rounded-3xl p-6 border ${
        allHealthy ? "bg-emerald-50/50 border-emerald-100" : "bg-amber-50/50 border-amber-100"
      }`}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <div className={`h-12 w-12 rounded-2xl flex items-center justify-center text-white shadow-md ${
              allHealthy ? "bg-emerald-600" : "bg-amber-600"
            }`}>
              <HeartPulse size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-slate-900">
                  {allHealthy ? "All Commercial Services Operational" : "Some Services Requiring Attention"}
                </h2>
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                  allHealthy ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
                }`}>
                  {health.status || "Healthy"}
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                Last verified: {health.last_checked ? new Date(health.last_checked).toLocaleTimeString() : "Just now"}
              </p>
            </div>
          </div>

          <button
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-bold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            <span>Re-check Services</span>
          </button>
        </div>
      </div>

      {/* Services Breakdown List */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 mb-4 pb-3 border-b border-slate-100">
          Core Microservices & Integration Checks
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {services.map((svc, idx) => (
            <div
              key={idx}
              className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-xl bg-white border border-slate-200 text-slate-700">
                      {svc.category === "database" && <Database size={16} />}
                      {svc.category === "backend" && <Server size={16} />}
                      {svc.category === "ai" && <Cpu size={16} />}
                      {svc.category === "website" && <Globe size={16} />}
                      {svc.category === "licensing" && <ShieldCheck size={16} />}
                      {svc.category === "integrations" && <Mail size={16} />}
                    </div>
                    <div>
                      <div className="text-xs font-bold text-slate-900">{svc.name}</div>
                      <div className="text-[10px] text-slate-400 capitalize">{svc.category} service</div>
                    </div>
                  </div>

                  <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    svc.status === "Healthy" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"
                  }`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${svc.status === "Healthy" ? "bg-emerald-500" : "bg-amber-500"}`}></span>
                    {svc.status}
                  </span>
                </div>

                <p className="mt-3 text-xs text-slate-600">{svc.message}</p>
              </div>

              <div className="mt-4 pt-3 border-t border-slate-200/60 flex items-center justify-between text-[11px] text-slate-400 font-mono">
                <span>Latency: {svc.latency_ms} ms</span>
                <span>Active</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
