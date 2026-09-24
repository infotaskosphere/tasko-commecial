import React, { useState, useEffect } from "react";
import {
  Send, Search, RefreshCw, AlertTriangle, CheckCircle2,
  Clock, RotateCcw, Filter, FileText, Check, ShieldAlert
} from "lucide-react";
import { toast } from "sonner";
import { getEmailLogs, retryEmailLog, getEmailStats } from "@/lib/commercialConsoleApi";

export default function EmailDeliveryLogsTab() {
  const [logs, setLogs] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [searchRecipient, setSearchRecipient] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;

  useEffect(() => {
    loadData();
  }, [statusFilter, page]);

  async function loadData() {
    setLoading(true);
    try {
      const params = {
        limit,
        skip: page * limit,
      };
      if (statusFilter !== "all") params.status = statusFilter;
      if (searchRecipient.trim()) params.recipient = searchRecipient.trim();

      const [logRes, statsRes] = await Promise.all([
        getEmailLogs(params),
        getEmailStats().catch(() => null),
      ]);
      setLogs(logRes.logs || []);
      if (statsRes) setStats(statsRes);
    } catch (err) {
      toast.error("Failed to load delivery logs: " + (err.response?.data?.detail || err.message));
    } finally {
      setLoading(false);
    }
  }

  function handleSearch(e) {
    e.preventDefault();
    setPage(0);
    loadData();
  }

  async function handleRetry(logId) {
    setRetryingId(logId);
    try {
      const res = await retryEmailLog(logId);
      toast.success(res.message || "Retry dispatched!");
      loadData();
    } catch (err) {
      toast.error("Retry failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setRetryingId(null);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h2 className="text-xl font-black text-slate-900 tracking-tight">Email Delivery Logs & Audit Queue</h2>
          <p className="text-xs text-slate-500 mt-1">
            Real-time delivery status, error telemetry, and manual re-dispatch for failed transactional alerts.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadData}
            className="px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh Logs
          </button>
        </div>
      </div>

      {/* Stats Summary Bar */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 block">Sent Today</span>
            <span className="text-lg font-black text-slate-900 mt-0.5 block">{stats.total_sent_today ?? 0}</span>
          </div>
          <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-700 block">Delivered All-Time</span>
            <span className="text-lg font-black text-emerald-900 mt-0.5 block">{stats.total_sent_all_time ?? 0}</span>
          </div>
          <div className="bg-rose-50 border border-rose-200 rounded-xl p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-rose-700 block">Failed Deliveries</span>
            <span className="text-lg font-black text-rose-900 mt-0.5 block">{stats.total_failed_all_time ?? 0}</span>
          </div>
          <div className="bg-blue-50 border border-blue-200 rounded-xl p-3.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-700 block">Success Rate</span>
            <span className="text-lg font-black text-blue-900 mt-0.5 block">{stats.success_rate_percent ?? 100}%</span>
          </div>
        </div>
      )}

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <form onSubmit={handleSearch} className="relative w-full sm:w-80">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            value={searchRecipient}
            onChange={(e) => setSearchRecipient(e.target.value)}
            placeholder="Search by recipient email..."
            className="w-full text-xs pl-9 pr-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
          />
        </form>

        <div className="flex items-center gap-1.5 w-full sm:w-auto">
          {["all", "sent", "failed", "retrying"].map((st) => (
            <button
              key={st}
              onClick={() => {
                setStatusFilter(st);
                setPage(0);
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition ${
                statusFilter === st
                  ? "bg-[#0D3B66] text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Delivery Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3 px-4">Date / Time</th>
                <th className="py-3 px-4">Recipient</th>
                <th className="py-3 px-4">Subject</th>
                <th className="py-3 px-4">Template</th>
                <th className="py-3 px-4">Provider</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-3 px-4 whitespace-nowrap text-slate-500 font-mono text-[11px]">
                    {log.created_at ? new Date(log.created_at).toLocaleString() : "—"}
                  </td>
                  <td className="py-3 px-4 font-bold text-slate-900">
                    {log.recipient_email}
                  </td>
                  <td className="py-3 px-4 max-w-xs truncate" title={log.subject}>
                    {log.subject}
                  </td>
                  <td className="py-3 px-4">
                    <span className="font-mono text-[10px] px-2 py-0.5 bg-slate-100 rounded text-slate-700">
                      {log.template_code || "CUSTOM"}
                    </span>
                  </td>
                  <td className="py-3 px-4 uppercase text-[10px] font-bold text-slate-500">
                    {log.provider_used || "SMTP"}
                  </td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                      log.status === "sent" ? "bg-emerald-100 text-emerald-800" :
                      log.status === "failed" ? "bg-rose-100 text-rose-800" :
                      "bg-amber-100 text-amber-800"
                    }`}>
                      {log.status === "sent" ? <CheckCircle2 size={10} /> : <AlertTriangle size={10} />}
                      {log.status}
                    </span>
                    {log.error_message && (
                      <span className="block text-[10px] text-rose-600 truncate max-w-xs mt-0.5" title={log.error_message}>
                        {log.error_message}
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    {log.status === "failed" || log.status === "retrying" ? (
                      <button
                        type="button"
                        onClick={() => handleRetry(log.id)}
                        disabled={retryingId === log.id}
                        className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-semibold inline-flex items-center gap-1 transition"
                      >
                        <RotateCcw size={11} className={retryingId === log.id ? "animate-spin" : ""} />
                        Retry
                      </button>
                    ) : (
                      <span className="text-[11px] text-slate-400">Delivered</span>
                    )}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center py-8 text-slate-400">
                    No delivery log records found.
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
