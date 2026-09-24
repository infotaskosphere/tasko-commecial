import React, { useState, useEffect } from "react";
import {
  ShieldCheck, KeyRound, Mail, Clock, RefreshCw, Save,
  AlertTriangle, Lock, ShieldAlert, Check
} from "lucide-react";
import { toast } from "sonner";
import { getRecoverySettings, updateRecoverySettings } from "@/lib/commercialConsoleApi";

export default function AccountRecoveryTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    enable_forgot_password: true,
    enable_forgot_email_id: true,
    require_email_verification: false,
    enable_login_security_notifications: true,
    enable_new_login_alerts: true,
    enable_password_changed_alerts: true,
    password_reset_token_expiry_minutes: 15,
    email_verification_token_expiry_hours: 24,
    max_reset_requests_per_window: 5,
    password_reset_window_minutes: 60,
    lockout_threshold_attempts: 5,
    lockout_duration_minutes: 15,
  });

  useEffect(() => {
    loadSettings();
  }, []);

  async function loadSettings() {
    setLoading(true);
    try {
      const res = await getRecoverySettings();
      if (res.settings) {
        setForm(prev => ({ ...prev, ...res.settings }));
      }
    } catch (err) {
      toast.error("Failed to load recovery settings: " + (err.response?.data?.detail || err.message));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      await updateRecoverySettings(form);
      toast.success("Account recovery policies saved successfully!");
    } catch (err) {
      toast.error("Save failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="p-12 flex flex-col items-center justify-center space-y-3">
        <RefreshCw className="w-8 h-8 text-[#0D3B66] animate-spin" />
        <p className="text-sm font-medium text-slate-500">Loading Recovery Settings...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h2 className="text-xl font-black text-slate-900 tracking-tight">Authentication & Account Recovery</h2>
          <p className="text-xs text-slate-500 mt-1">
            Global security policy controls for Forgot Password, Username/Email recovery, Verification, and Token lifecycles.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadSettings}
            className="px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition"
          >
            <RefreshCw size={14} /> Refresh
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-[#0D3B66] hover:bg-[#082642] text-white text-xs font-bold rounded-xl shadow-sm flex items-center gap-1.5 transition disabled:opacity-50"
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
            Save Recovery Policy
          </button>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Feature Switches */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-3">
            <ShieldCheck size={16} className="text-[#1F6FB2]" /> Recovery & Security Features
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            {[
              {
                id: "enable_forgot_password",
                label: "Enable Forgot Password",
                desc: "Allows users to self-recover passwords via cryptographically secure single-use OTP / reset links.",
              },
              {
                id: "enable_forgot_email_id",
                label: "Enable Forgot Email ID / Username",
                desc: "Allows users to recover masked login credentials via registered phone or license without account enumeration.",
              },
              {
                id: "require_email_verification",
                label: "Require Email Verification Before Login",
                desc: "Requires new accounts and invitees to click single-use verification links before granting full workspace access.",
              },
              {
                id: "enable_login_security_notifications",
                label: "Enable Login Security Notifications",
                desc: "Sends automated security dispatch if an account triggers failed attempts or abnormal patterns.",
              },
              {
                id: "enable_new_login_alerts",
                label: "Enable New Login Device Alerts",
                desc: "Sends transactional notice with IP and device user agent on new successful logins.",
              },
              {
                id: "enable_password_changed_alerts",
                label: "Enable Password Changed Alerts",
                desc: "Notifies registered mailbox immediately whenever password has been updated or reset.",
              },
            ].map((item) => (
              <label
                key={item.id}
                className="flex items-start gap-3 p-3.5 rounded-xl border border-slate-200 hover:border-slate-300 bg-slate-50/50 cursor-pointer transition"
              >
                <input
                  type="checkbox"
                  checked={form[item.id]}
                  onChange={(e) => setForm({ ...form, [item.id]: e.target.checked })}
                  className="w-4 h-4 mt-0.5 rounded text-[#0D3B66] focus:ring-[#0D3B66]"
                />
                <div>
                  <span className="text-xs font-bold text-slate-900 block">{item.label}</span>
                  <span className="text-[11px] text-slate-500 leading-relaxed block mt-0.5">{item.desc}</span>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Token Expiry & Lifecycles */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-3">
            <Clock size={16} className="text-[#1F6FB2]" /> Token Expiry & Security Windows
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Password Reset Token Expiry (Minutes)
              </label>
              <input
                type="number"
                min="5"
                max="120"
                value={form.password_reset_token_expiry_minutes}
                onChange={(e) => setForm({ ...form, password_reset_token_expiry_minutes: parseInt(e.target.value) || 15 })}
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Standard: 15 minutes. Short-lived tokens protect against mailbox compromise.
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Email Verification Token Expiry (Hours)
              </label>
              <input
                type="number"
                min="1"
                max="168"
                value={form.email_verification_token_expiry_hours}
                onChange={(e) => setForm({ ...form, email_verification_token_expiry_hours: parseInt(e.target.value) || 24 })}
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Standard: 24 hours. Single-use hash representation prevents reuse.
              </span>
            </div>
          </div>
        </div>

        {/* Rate Limiting & Throttling */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 border-b border-slate-100 pb-3">
            <ShieldAlert size={16} className="text-[#1F6FB2]" /> Rate Limiting & Account Protection
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Maximum Reset Requests Per Window
              </label>
              <input
                type="number"
                min="1"
                max="20"
                value={form.max_reset_requests_per_window}
                onChange={(e) => setForm({ ...form, max_reset_requests_per_window: parseInt(e.target.value) || 5 })}
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Limits outbound email spam and resource exhaustion attacks.
              </span>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Reset Rate Limit Window (Minutes)
              </label>
              <input
                type="number"
                min="5"
                max="1440"
                value={form.password_reset_window_minutes}
                onChange={(e) => setForm({ ...form, password_reset_window_minutes: parseInt(e.target.value) || 60 })}
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
              <span className="text-[10px] text-slate-400 mt-1 block">
                Rolling duration window for rate limit tracking.
              </span>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
