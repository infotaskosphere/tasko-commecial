import React, { useState, useEffect } from "react";
import {
  Mail, X, Save, RefreshCw, CheckCircle2, AlertTriangle, ShieldCheck
} from "lucide-react";
import { toast } from "sonner";
import {
  getLicenseeEmailSettings,
  updateLicenseeEmailSettings
} from "@/lib/commercialConsoleApi";

export default function LicenseeEmailModal({ customerId, customerName, onClose, onUpdated }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    primary_email: "",
    secondary_email: "",
    billing_email: "",
    notification_email: "",
    recovery_email: "",
    email_enabled: true,
    email_verified: false,
    notification_preferences: {
      security: true,
      billing: true,
      license: true,
      system: true,
      product_updates: true,
      user_invitations: true,
    },
    last_email_sent: null,
    last_email_failure: null,
  });

  useEffect(() => {
    if (customerId) loadCustomerSettings();
  }, [customerId]);

  async function loadCustomerSettings() {
    setLoading(true);
    try {
      const data = await getLicenseeEmailSettings(customerId);
      if (data) {
        setForm({
          primary_email: data.primary_email || "",
          secondary_email: data.secondary_email || "",
          billing_email: data.billing_email || "",
          notification_email: data.notification_email || "",
          recovery_email: data.recovery_email || "",
          email_enabled: data.email_enabled ?? true,
          email_verified: data.email_verified ?? false,
          notification_preferences: {
            security: true,
            billing: true,
            license: true,
            system: true,
            product_updates: true,
            user_invitations: true,
            ...(data.notification_preferences || {}),
          },
          last_email_sent: data.last_email_sent,
          last_email_failure: data.last_email_failure,
        });
      }
    } catch (err) {
      toast.error("Failed to load licensee email settings: " + (err.response?.data?.detail || err.message));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await updateLicenseeEmailSettings(customerId, form);
      toast.success("Licensee email preferences saved successfully!");
      if (onUpdated) onUpdated();
      onClose();
    } catch (err) {
      toast.error("Save failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-4 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-blue-50 text-[#1F6FB2] flex items-center justify-center">
              <Mail size={16} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Email & Notifications: {customerName || "Licensee"}
              </h3>
              <p className="text-xs text-slate-500">Configure customer mailboxes and dispatch channels</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="py-16 flex flex-col items-center justify-center space-y-2">
            <RefreshCw className="w-6 h-6 text-[#0D3B66] animate-spin" />
            <p className="text-xs text-slate-500">Loading licensee email settings...</p>
          </div>
        ) : (
          <form onSubmit={handleSave} className="p-6 overflow-y-auto space-y-6 text-xs flex-1">
            {/* Status & Verification */}
            <div className="flex items-center justify-between p-3.5 bg-slate-50 border border-slate-200 rounded-xl">
              <div>
                <span className="font-bold text-slate-800 block">Email Dispatch Status</span>
                <span className="text-slate-500 text-[11px]">Toggle outbound delivery for this tenant</span>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.email_enabled}
                  onChange={(e) => setForm({ ...form, email_enabled: e.target.checked })}
                  className="w-4 h-4 rounded text-[#0D3B66]"
                />
                <span className="font-semibold text-slate-700">Email Enabled</span>
              </label>
            </div>

            {/* Email Addresses */}
            <div className="space-y-3">
              <h4 className="font-bold text-slate-900 uppercase text-[10px] tracking-wider text-slate-400">
                Mailbox Routing
              </h4>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Primary Email (Admin)</label>
                  <input
                    type="email"
                    value={form.primary_email}
                    onChange={(e) => setForm({ ...form, primary_email: e.target.value })}
                    className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                    required
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Secondary / Backup Email</label>
                  <input
                    type="email"
                    value={form.secondary_email}
                    onChange={(e) => setForm({ ...form, secondary_email: e.target.value })}
                    placeholder="optional backup address"
                    className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Billing & Invoicing Email</label>
                  <input
                    type="email"
                    value={form.billing_email}
                    onChange={(e) => setForm({ ...form, billing_email: e.target.value })}
                    placeholder="finance@client.com"
                    className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                  />
                </div>

                <div>
                  <label className="block font-semibold text-slate-700 mb-1">System Notifications Email</label>
                  <input
                    type="email"
                    value={form.notification_email}
                    onChange={(e) => setForm({ ...form, notification_email: e.target.value })}
                    placeholder="ops@client.com"
                    className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                  />
                </div>
              </div>
            </div>

            {/* Notification Preferences */}
            <div className="space-y-3">
              <h4 className="font-bold text-slate-900 uppercase text-[10px] tracking-wider text-slate-400">
                Notification Categories
              </h4>

              <div className="grid grid-cols-2 gap-2">
                {[
                  { key: "security", label: "Security & Login Alerts" },
                  { key: "billing", label: "Billing & Invoices" },
                  { key: "license", label: "License & Expiry Notices" },
                  { key: "system", label: "System Maintenance Alerts" },
                  { key: "user_invitations", label: "User Invitations" },
                  { key: "product_updates", label: "Product Announcements" },
                ].map((item) => (
                  <label
                    key={item.key}
                    className="flex items-center gap-2.5 p-2.5 rounded-lg border border-slate-200 bg-slate-50/50 cursor-pointer hover:bg-slate-50 transition"
                  >
                    <input
                      type="checkbox"
                      checked={form.notification_preferences[item.key] ?? true}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          notification_preferences: {
                            ...form.notification_preferences,
                            [item.key]: e.target.checked,
                          },
                        })
                      }
                      className="w-3.5 h-3.5 rounded text-[#0D3B66]"
                    />
                    <span className="font-medium text-slate-700">{item.label}</span>
                  </label>
                ))}
              </div>
            </div>
          </form>
        )}

        <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl font-semibold text-xs transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            className="px-4 py-2 bg-[#0D3B66] hover:bg-[#082642] text-white rounded-xl font-bold text-xs shadow-sm flex items-center gap-1.5 transition disabled:opacity-50"
          >
            {saving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
            Save Licensee Preferences
          </button>
        </div>
      </div>
    </div>
  );
}
