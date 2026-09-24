import React, { useState } from "react";
import { CreditCard, Check, Plus, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { createCommercialPlan } from "@/lib/commercialConsoleApi";

export default function PlansManagementTab({ plans = [], onRefresh }) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [price, setPrice] = useState("4999");
  const [maxUsers, setMaxUsers] = useState("15");
  const [saving, setSaving] = useState(false);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim() || !code.trim()) return;
    setSaving(true);
    try {
      await createCommercialPlan({
        name: name.trim(),
        code: code.trim().toUpperCase(),
        monthly_price: parseFloat(price) || 0,
        max_users: parseInt(maxUsers) || 10,
        modules: ["taskosphere", "finix", "aiweave"]
      });
      toast.success(`Plan ${name} created.`);
      setShowCreate(false);
      setName("");
      setCode("");
      onRefresh?.();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to create plan.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Commercial SaaS Subscription Plans</h2>
          <p className="text-xs text-slate-500">Tier definitions governing module inclusion, user allowances and limits.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-slate-800 transition"
        >
          <Plus size={14} />
          <span>Create Plan</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((p) => (
          <div
            key={p.id}
            className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm flex flex-col justify-between hover:border-[#1F6FB2] transition"
          >
            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                  {p.code}
                </span>
                <span className="text-xs font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                  Active Tier
                </span>
              </div>

              <h3 className="mt-2 text-xl font-bold text-slate-900">{p.name}</h3>
              <p className="mt-1 text-xs text-slate-500 min-h-[32px]">{p.description}</p>

              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-2xl font-black text-slate-900">
                  ₹{Number(p.monthly_price).toLocaleString("en-IN")}
                </span>
                <span className="text-xs text-slate-400">/ month</span>
              </div>

              <div className="mt-6 space-y-2.5 border-t border-slate-100 pt-4 text-xs text-slate-600">
                <div className="flex items-center gap-2">
                  <Check size={14} className="text-emerald-600 shrink-0" />
                  <span>Up to <strong>{p.max_users}</strong> authorized users</span>
                </div>
                <div className="flex items-center gap-2">
                  <Check size={14} className="text-emerald-600 shrink-0" />
                  <span><strong>{p.max_storage_gb} GB</strong> secure document storage</span>
                </div>
                <div className="flex items-center gap-2">
                  <Check size={14} className="text-emerald-600 shrink-0" />
                  <span><strong>{p.max_ai_requests?.toLocaleString()}</strong> AIWeave Omni requests</span>
                </div>
                <div className="flex items-center gap-2">
                  <Check size={14} className="text-emerald-600 shrink-0" />
                  <span>{p.support_level} Support</span>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-slate-100">
              <span className="block text-center text-xs font-bold text-[#1F6FB2] bg-blue-50 py-2 rounded-xl">
                Configured Tier
              </span>
            </div>
          </div>
        ))}
      </div>

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={handleCreate} className="w-full max-w-md rounded-3xl bg-white p-6 shadow-2xl">
            <h3 className="text-base font-bold text-slate-900">Create Subscription Plan</h3>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Plan Name</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Scale Plus"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Plan Code</label>
                <input
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="e.g. PLAN-SCALE"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Monthly Price (INR)</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Max Users</label>
                <input
                  type="number"
                  value={maxUsers}
                  onChange={(e) => setMaxUsers(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
                />
              </div>
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                {saving ? "Creating…" : "Create Plan"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
