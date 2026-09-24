import React, { useState } from "react";
import { ShieldAlert, Search, CheckCircle2, AlertCircle, Clock, Filter } from "lucide-react";

export default function ActivityAuditTab({ logs = [] }) {
  const [query, setQuery] = useState("");
  const [filterAction, setFilterAction] = useState("all");

  const filtered = logs.filter(log => {
    const q = query.toLowerCase();
    const matchesQ = !q || [log.action, log.actor, log.target, log.customer, log.details]
      .some(v => String(v || "").toLowerCase().includes(q));
    const matchesA = filterAction === "all" || log.action === filterAction;
    return matchesQ && matchesA;
  });

  const actions = Array.from(new Set(logs.map(l => l.action).filter(Boolean)));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Commercial Operations & Activity Audit Log</h2>
          <p className="text-xs text-slate-500">Immutable record of licenses, entitlements, user changes, and system modifications.</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={15} className="absolute left-3.5 top-2.5 text-slate-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by actor, action, customer or target..."
            className="w-full rounded-xl border border-slate-200 pl-9 pr-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
          />
        </div>

        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
        >
          <option value="all">All Actions</option>
          {actions.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-400">
              <tr>
                <th className="p-3.5">Timestamp</th>
                <th className="p-3.5">Action</th>
                <th className="p-3.5">Actor / Admin</th>
                <th className="p-3.5">Target & Details</th>
                <th className="p-3.5">Customer Scope</th>
                <th className="p-3.5 text-right">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((l, idx) => (
                <tr key={l.id || idx} className="hover:bg-slate-50 transition">
                  <td className="p-3.5 text-slate-500 font-mono text-[11px] whitespace-nowrap">
                    {l.timestamp ? new Date(l.timestamp).toLocaleString("en-IN") : "—"}
                  </td>
                  <td className="p-3.5 font-bold text-slate-900 font-mono text-[11px]">
                    <span className="bg-slate-100 px-2 py-0.5 rounded text-slate-700">
                      {l.action}
                    </span>
                  </td>
                  <td className="p-3.5 text-slate-600 font-medium">
                    {l.actor_name || l.actor || "System"}
                  </td>
                  <td className="p-3.5 max-w-md">
                    <div className="font-semibold text-slate-800 truncate">{l.target || "Operation"}</div>
                    <div className="text-[11px] text-slate-400 truncate">{l.details || "—"}</div>
                  </td>
                  <td className="p-3.5 text-slate-500 font-medium">
                    {l.customer || "Global"}
                  </td>
                  <td className="p-3.5 text-right">
                    <span className="inline-flex items-center gap-1 font-bold text-[10px] text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full">
                      <CheckCircle2 size={10} />
                      {l.status || "SUCCESS"}
                    </span>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan="6" className="p-10 text-center text-slate-400">
                    No activity logs match the search query.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
