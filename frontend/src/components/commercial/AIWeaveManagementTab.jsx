import React, { useState } from "react";
import {
  Sparkles, Cpu, Activity, ShieldCheck, CheckCircle2,
  RefreshCw, Settings, Play, Database, Zap, AlertTriangle
} from "lucide-react";
import { toast } from "sonner";
import { updateCommercialOmniSettings } from "@/lib/commercialConsoleApi";

export default function AIWeaveManagementTab({ omniSettings = {}, onRefresh }) {
  const [settings, setSettings] = useState({
    routing_mode: omniSettings.routing_mode || "AUTO",
    fallback_enabled: omniSettings.fallback_enabled ?? true,
    max_attempts: omniSettings.max_attempts || 3,
    timeout_seconds: omniSettings.timeout_seconds || 30,
    circuit_breaker_enabled: omniSettings.circuit_breaker_enabled ?? true,
    cooldown_seconds: omniSettings.cooldown_seconds || 60,
    preferred_provider: omniSettings.preferred_provider || "auto"
  });
  const [saving, setSaving] = useState(false);

  const saveConfig = async () => {
    setSaving(true);
    try {
      await updateCommercialOmniSettings(settings);
      toast.success("AIWeave Omni Route settings saved to production.");
      onRefresh?.();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Failed to save AIWeave settings.");
    } finally {
      setSaving(false);
    }
  };

  const providers = [
    { name: "Google Gemini", id: "gemini", status: "HEALTHY", models: ["gemini-3.8-flash", "gemini-3.1-pro-preview"], priority: 1 },
    { name: "Anthropic Claude", id: "anthropic", status: "HEALTHY", models: ["claude-opus-5", "claude-sonnet-4-6"], priority: 2 },
    { name: "OpenAI", id: "openai", status: "HEALTHY", models: ["gpt-5.6-sol", "gpt-5-mini"], priority: 3 },
    { name: "xAI Grok", id: "xai", status: "HEALTHY", models: ["grok-2-1212", "grok-2-vision"], priority: 4 },
    { name: "Moonshot Kimi", id: "kimi", status: "HEALTHY", models: ["moonshot-v1-128k"], priority: 5 },
    { name: "DeepSeek", id: "deepseek", status: "HEALTHY", models: ["deepseek-chat", "deepseek-reasoner"], priority: 6 },
    { name: "Ollama (Self-Hosted)", id: "ollama", status: "HEALTHY", models: ["llama3.3:70b", "qwen2.5:72b"], priority: 7 },
  ];

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="rounded-2xl border border-purple-100 bg-purple-50/50 p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-2xl bg-purple-600 text-white flex items-center justify-center shadow-md">
              <Sparkles size={24} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-900">AIWeave Universal Omni Route</h2>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                  Active (v3.0)
                </span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">
                All client requests route to <code className="font-mono text-purple-700 bg-purple-100 px-1 rounded">/api/aiweave/omni</code> with zero exposed API keys.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={saveConfig}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-[#0D3B66] px-4 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? <RefreshCw size={14} className="animate-spin" /> : <Settings size={14} />}
              Save Omni Settings
            </button>
          </div>
        </div>
      </div>

      {/* Grid: Omni Configuration & Provider Health */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Omni Route Engine Controls */}
        <div className="lg:col-span-1 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b pb-3">
            <Zap size={16} className="text-[#1F6FB2]" />
            Routing Policy Engine
          </h3>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Global Routing Mode</label>
            <select
              value={settings.routing_mode}
              onChange={(e) => setSettings({ ...settings, routing_mode: e.target.value })}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
            >
              <option value="AUTO">AUTO (Dynamic Intelligence)</option>
              <option value="BALANCED">BALANCED (Quality & Cost)</option>
              <option value="FAST">FAST (Low Latency / High Throughput)</option>
              <option value="QUALITY">QUALITY (Highest Capability Models)</option>
              <option value="LOW_COST">LOW_COST (Economical First)</option>
              <option value="REASONING">REASONING (CoT & Deep Logic)</option>
              <option value="CODING">CODING (Code Gen & Debugging)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Max Cascade Attempts</label>
            <input
              type="number"
              min="1"
              max="10"
              value={settings.max_attempts}
              onChange={(e) => setSettings({ ...settings, max_attempts: parseInt(e.target.value) || 3 })}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Request Timeout (seconds)</label>
            <input
              type="number"
              min="5"
              max="120"
              value={settings.timeout_seconds}
              onChange={(e) => setSettings({ ...settings, timeout_seconds: parseInt(e.target.value) || 30 })}
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none focus:border-[#1F6FB2]"
            />
          </div>

          <div className="pt-2 space-y-3 border-t border-slate-100">
            <label className="flex items-center justify-between text-xs font-semibold text-slate-700 cursor-pointer">
              <span>Automatic Failover</span>
              <input
                type="checkbox"
                checked={settings.fallback_enabled}
                onChange={(e) => setSettings({ ...settings, fallback_enabled: e.target.checked })}
                className="rounded border-slate-300 h-4 w-4 text-[#1F6FB2]"
              />
            </label>

            <label className="flex items-center justify-between text-xs font-semibold text-slate-700 cursor-pointer">
              <span>Circuit Breaker Protection</span>
              <input
                type="checkbox"
                checked={settings.circuit_breaker_enabled}
                onChange={(e) => setSettings({ ...settings, circuit_breaker_enabled: e.target.checked })}
                className="rounded border-slate-300 h-4 w-4 text-[#1F6FB2]"
              />
            </label>
          </div>
        </div>

        {/* Provider Adapter Pool & Account Registry */}
        <div className="lg:col-span-2 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between border-b pb-3">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Cpu size={16} className="text-purple-600" />
              Connected AI Provider Adapters
            </h3>
            <span className="text-xs text-slate-400 font-medium">All credentials masked backend-only</span>
          </div>

          <div className="space-y-2.5">
            {providers.map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between p-3.5 rounded-2xl border border-slate-100 bg-slate-50/50 hover:bg-white hover:border-slate-200 transition"
              >
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 rounded-xl bg-white border border-slate-200 flex items-center justify-center text-xs font-bold text-purple-700 shadow-xs">
                    {p.name[0]}
                  </div>
                  <div>
                    <div className="text-xs font-bold text-slate-900">{p.name}</div>
                    <div className="text-[11px] text-slate-400">
                      Models: {p.models.join(", ")}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                    {p.status}
                  </span>
                  <div className="text-[11px] font-mono text-slate-400 bg-white px-2 py-1 rounded border border-slate-100">
                    Priority #{p.priority}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3 text-[11px] text-slate-500 flex items-center gap-2">
            <ShieldCheck size={16} className="text-emerald-600 shrink-0" />
            <span>Customer users interact seamlessly through AIWeave with no quota leak or key exposure.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
