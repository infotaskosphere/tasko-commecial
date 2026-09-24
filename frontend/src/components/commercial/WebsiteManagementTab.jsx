import React, { useState } from "react";
import { Globe, Plus, Trash2, ShieldCheck, CheckCircle2, AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { createCommercialDomain, deleteCommercialDomain } from "@/lib/commercialConsoleApi";

export default function WebsiteManagementTab({ domains = [], onRefresh }) {
  const [newDomain, setNewDomain] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [adding, setAdding] = useState(false);

  const handleAddDomain = async (e) => {
    e.preventDefault();
    if (!newDomain.trim()) return;
    setAdding(true);
    try {
      await createCommercialDomain({ domain: newDomain.trim(), is_primary: isPrimary });
      toast.success(`Domain ${newDomain} connected. DNS instructions generated.`);
      setNewDomain("");
      setIsPrimary(false);
      onRefresh?.();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to add domain.");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (domainId, domainName) => {
    if (!window.confirm(`Disconnect domain ${domainName}?`)) return;
    try {
      await deleteCommercialDomain(domainId);
      toast.success("Domain disconnected.");
      onRefresh?.();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to remove domain.");
    }
  };

  return (
    <div className="space-y-6">
      {/* Website Studio Callout */}
      <div className="rounded-3xl border border-blue-100 bg-gradient-to-r from-blue-50 to-indigo-50/40 p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5">
          <div className="h-12 w-12 rounded-2xl bg-[#0D3B66] text-white flex items-center justify-center shadow-md">
            <Globe size={24} />
          </div>
          <div>
            <h2 className="text-base font-bold text-slate-900">Taskosphere Website Studio</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Single unified visual editor for public marketing sites, landing pages, and customer portals.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link
            to="/master-console/website"
            className="inline-flex items-center gap-2 rounded-xl bg-[#0D3B66] px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-slate-800 transition"
          >
            <Globe size={14} />
            <span>Open Website Studio</span>
          </Link>
          <a
            href="/"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
          >
            <span>Live Site</span>
            <ExternalLink size={13} />
          </a>
        </div>
      </div>

      {/* Domain Management Section */}
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-100 pb-4">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Custom Domains & SSL</h3>
            <p className="text-xs text-slate-500">Connect white-label domains to your commercial platform and websites.</p>
          </div>
        </div>

        {/* Add Domain Form */}
        <form onSubmit={handleAddDomain} className="mt-5 flex flex-wrap items-center gap-3">
          <input
            type="text"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="e.g. app.yourdomain.com or company.com"
            className="flex-1 min-w-[240px] rounded-xl border border-slate-200 px-3.5 py-2 text-xs outline-none focus:border-[#1F6FB2]"
          />
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
            <input
              type="checkbox"
              checked={isPrimary}
              onChange={(e) => setIsPrimary(e.target.checked)}
              className="rounded border-slate-300 text-[#1F6FB2]"
            />
            Primary Domain
          </label>
          <button
            type="submit"
            disabled={adding || !newDomain.trim()}
            className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white shadow-sm disabled:opacity-50"
          >
            {adding ? <RefreshCw size={13} className="animate-spin" /> : <Plus size={14} />}
            <span>Add Domain</span>
          </button>
        </form>

        {/* Domains Table */}
        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-[10px] uppercase font-bold text-slate-400">
              <tr>
                <th className="p-3">Domain</th>
                <th className="p-3">Status</th>
                <th className="p-3">SSL Certificate</th>
                <th className="p-3">DNS Configuration</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {domains.map((dom) => (
                <tr key={dom.id} className="hover:bg-slate-50 transition">
                  <td className="p-3 font-semibold text-slate-900 flex items-center gap-2">
                    <Globe size={14} className="text-slate-400" />
                    <span>{dom.domain}</span>
                    {dom.is_primary && (
                      <span className="text-[10px] font-bold bg-blue-50 text-[#1F6FB2] px-2 py-0.5 rounded-full">
                        Primary
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <span className={`inline-flex items-center gap-1 font-bold ${
                      dom.status === "connected" ? "text-emerald-700 bg-emerald-50" : "text-amber-700 bg-amber-50"
                    } px-2 py-0.5 rounded-full text-[10px]`}>
                      {dom.status === "connected" ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
                      {dom.status}
                    </span>
                  </td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1 text-slate-600 font-medium">
                      <ShieldCheck size={13} className="text-emerald-600" />
                      {dom.ssl || "Active"}
                    </span>
                  </td>
                  <td className="p-3 text-slate-500 font-mono text-[11px]">
                    CNAME → sites.taskosphere.com
                  </td>
                  <td className="p-3 text-right">
                    {!dom.is_primary && (
                      <button
                        onClick={() => handleDelete(dom.id, dom.domain)}
                        className="p-1.5 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition"
                        title="Disconnect domain"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
