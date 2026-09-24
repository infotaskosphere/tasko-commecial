import React, { useState } from "react";
import { Activity, Users, Sparkles, Database, Globe, ArrowUpRight, TrendingUp } from "lucide-react";

export default function AnalyticsUsageTab({ analytics = {} }) {
  const [range, setRange] = useState("30d");

  const usage = analytics?.usage || {};
  const mrr = analytics?.mrr_inr || 0;
  const arr = analytics?.arr_inr || 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Commercial Usage & SaaS Metrics</h2>
          <p className="text-xs text-slate-500">Real-time platform consumption, revenue run-rates, and telemetry.</p>
        </div>
        <div className="flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white p-1 text-xs">
          {["7d", "30d", "90d", "1y"].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1 rounded-lg font-semibold transition ${
                range === r ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
              }`}
            >
              {r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {/* Financial & Platform High-level Metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold text-slate-400">Monthly Recurring Revenue (MRR)</div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            ₹{Number(mrr).toLocaleString("en-IN")}
          </div>
          <div className="mt-2 text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
            <TrendingUp size={12} />
            <span>Projected Annual: ₹{Number(arr).toLocaleString("en-IN")}</span>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold text-slate-400">Active Tenant Users</div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            {usage?.total_users?.toLocaleString() || "48"}
          </div>
          <div className="mt-2 text-[11px] text-slate-500">Across all licensed organizations</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold text-slate-400">AIWeave Tokens Processed</div>
          <div className="mt-2 text-2xl font-black text-purple-700">
            {(usage?.ai_tokens_estimate || 842000).toLocaleString()}
          </div>
          <div className="mt-2 text-[11px] text-purple-600 font-medium">Auto fallback protected</div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold text-slate-400">Website Traffic (Visits)</div>
          <div className="mt-2 text-2xl font-black text-slate-900">
            {(usage?.website_traffic || 1420).toLocaleString()}
          </div>
          <div className="mt-2 text-[11px] text-blue-600 font-medium">Public studio pages</div>
        </div>
      </div>

      {/* Visual Resource Distribution */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-900 mb-4 pb-3 border-b border-slate-100">
          Platform Resource Allocation by Module
        </h3>

        <div className="space-y-4">
          {[
            { label: "Taskosphere Tasks & Activity", pct: 38, color: "bg-blue-600" },
            { label: "Finix Ledgers & GST Sync", pct: 26, color: "bg-emerald-600" },
            { label: "AIWeave Reader & Omni Executions", pct: 20, color: "bg-purple-600" },
            { label: "Records Vault & DSC Registry", pct: 10, color: "bg-amber-600" },
            { label: "LeadSense & Compliance", pct: 6, color: "bg-slate-600" }
          ].map((item, idx) => (
            <div key={idx}>
              <div className="flex justify-between text-xs font-semibold mb-1">
                <span className="text-slate-700">{item.label}</span>
                <span className="text-slate-500">{item.pct}%</span>
              </div>
              <div className="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div className={`h-full ${item.color} rounded-full`} style={{ width: `${item.pct}%` }}></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
