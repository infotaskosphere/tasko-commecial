import React, { useState, useEffect } from "react";
import {
  Mail, Server, Key, Send, ShieldCheck, CheckCircle2, AlertTriangle,
  RefreshCw, Save, Lock, ArrowUpRight, Check, X, Info, Zap
} from "lucide-react";
import { toast } from "sonner";
import {
  getEmailConfig,
  updateEmailConfig,
  testEmailDispatch,
  getEmailStats
} from "@/lib/commercialConsoleApi";

export default function EmailConfigTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testRecipient, setTestRecipient] = useState("");
  const [testResult, setTestResult] = useState(null);
  const [stats, setStats] = useState(null);

  const [form, setForm] = useState({
    enabled: true,
    provider_type: "smtp",
    from_name: "TaskoSphere",
    from_email: "noreply@taskosphere.com",
    reply_to: "support@taskosphere.com",
    // SMTP fields
    smtp_host: "",
    smtp_port: 587,
    smtp_username: "",
    smtp_password: "",
    smtp_use_tls: true,
    smtp_use_ssl: false,
    // SendGrid fields
    sendgrid_api_key: "",
    // Brevo fields
    brevo_api_key: "",
    brevo_smtp_host: "smtp-relay.brevo.com",
  });

  const [masked, setMasked] = useState({
    smtp_password_masked: "",
    sendgrid_api_key_masked: "",
    brevo_api_key_masked: "",
  });

  const [statusInfo, setStatusInfo] = useState({
    provider_connected: false,
    sender_verified: true,
    last_tested_at: null,
    last_test_status: null,
    last_test_error: null,
    last_email_sent_at: null,
    last_email_failure_at: null,
  });

  useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    setLoading(true);
    try {
      const [cfg, st] = await Promise.all([
        getEmailConfig(),
        getEmailStats().catch(() => null)
      ]);
      if (cfg) {
        setForm({
          enabled: cfg.enabled ?? true,
          provider_type: cfg.provider_type || "smtp",
          from_name: cfg.from_name || "TaskoSphere",
          from_email: cfg.from_email || "",
          reply_to: cfg.reply_to || "",
          smtp_host: cfg.smtp_host || "",
          smtp_port: cfg.smtp_port || 587,
          smtp_username: cfg.smtp_username || "",
          smtp_password: "", // never populate plain password
          smtp_use_tls: cfg.smtp_use_tls ?? true,
          smtp_use_ssl: cfg.smtp_use_ssl ?? false,
          sendgrid_api_key: "",
          brevo_api_key: "",
          brevo_smtp_host: cfg.brevo_smtp_host || "smtp-relay.brevo.com",
        });
        setMasked({
          smtp_password_masked: cfg.smtp_password_masked || "",
          sendgrid_api_key_masked: cfg.sendgrid_api_key_masked || "",
          brevo_api_key_masked: cfg.brevo_api_key_masked || "",
        });
        setStatusInfo({
          provider_connected: cfg.provider_connected ?? false,
          sender_verified: cfg.sender_verified ?? true,
          last_tested_at: cfg.last_tested_at,
          last_test_status: cfg.last_test_status,
          last_test_error: cfg.last_test_error,
          last_email_sent_at: cfg.last_email_sent_at,
          last_email_failure_at: cfg.last_email_failure_at,
        });
      }
      if (st) setStats(st);
    } catch (err) {
      toast.error("Failed to load email settings: " + (err.response?.data?.detail || err.message));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    if (e) e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      // Only send passwords/keys if user entered a new value
      if (!payload.smtp_password) delete payload.smtp_password;
      if (!payload.sendgrid_api_key) delete payload.sendgrid_api_key;
      if (!payload.brevo_api_key) delete payload.brevo_api_key;

      const res = await updateEmailConfig(payload);
      toast.success("Email configuration updated successfully!");
      if (res.config) {
        setMasked({
          smtp_password_masked: res.config.smtp_password_masked || masked.smtp_password_masked,
          sendgrid_api_key_masked: res.config.sendgrid_api_key_masked || masked.sendgrid_api_key_masked,
          brevo_api_key_masked: res.config.brevo_api_key_masked || masked.brevo_api_key_masked,
        });
        // Clear entered secret fields after saving
        setForm(prev => ({
          ...prev,
          smtp_password: "",
          sendgrid_api_key: "",
          brevo_api_key: "",
        }));
      }
    } catch (err) {
      toast.error("Save failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    if (!testRecipient || !testRecipient.includes("@")) {
      toast.error("Please enter a valid recipient email for testing");
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await testEmailDispatch(testRecipient.trim());
      setTestResult({
        success: true,
        message: res.message || `Test message delivered to ${testRecipient}`,
        timestamp: new Date().toISOString(),
      });
      toast.success("Test email dispatched successfully!");
      setStatusInfo(prev => ({
        ...prev,
        provider_connected: true,
        last_tested_at: new Date().toISOString(),
        last_test_status: "success",
        last_test_error: null,
      }));
    } catch (err) {
      const detail = err.response?.data?.detail || err.message || "Connection refused";
      setTestResult({
        success: false,
        message: detail,
        timestamp: new Date().toISOString(),
      });
      toast.error("Test email failed: " + detail);
      setStatusInfo(prev => ({
        ...prev,
        last_tested_at: new Date().toISOString(),
        last_test_status: "failed",
        last_test_error: detail,
      }));
    } finally {
      setTesting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-12 flex flex-col items-center justify-center space-y-3">
        <RefreshCw className="w-8 h-8 text-[#0D3B66] animate-spin" />
        <p className="text-sm font-medium text-slate-500">Loading Central Email Configuration...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-black text-slate-900 tracking-tight">Central Email Service</h2>
            <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${
              form.enabled ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
            }`}>
              {form.enabled ? "Active" : "Disabled"}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Platform-wide transactional dispatch adapter for Super Admin, Commercial Tenants, Auth, Licensing & Notifications.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadConfig}
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
            Save Configuration
          </button>
        </div>
      </div>

      {/* Section F: Live Status & Health Banner */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Email System</span>
            <Zap size={14} className={form.enabled ? "text-emerald-500" : "text-slate-400"} />
          </div>
          <div className="text-lg font-black text-slate-900 mt-1">
            {form.enabled ? "Online & Routing" : "Globally Disabled"}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            Provider: <strong className="uppercase text-slate-700">{form.provider_type}</strong>
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Provider Status</span>
            {statusInfo.provider_connected ? (
              <CheckCircle2 size={14} className="text-emerald-500" />
            ) : (
              <AlertTriangle size={14} className="text-amber-500" />
            )}
          </div>
          <div className="text-lg font-black text-slate-900 mt-1">
            {statusInfo.provider_connected ? "Connected" : "Unverified"}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {statusInfo.last_tested_at
              ? `Tested ${new Date(statusInfo.last_tested_at).toLocaleTimeString()}`
              : "Not tested yet"}
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Sender Identity</span>
            <ShieldCheck size={14} className="text-blue-500" />
          </div>
          <div className="text-lg font-black text-slate-900 mt-1 truncate" title={form.from_email}>
            {form.from_email || "Not set"}
          </div>
          <div className="text-[11px] text-slate-500 mt-1 truncate">
            Name: {form.from_name || "TaskoSphere"}
          </div>
        </div>

        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-4">
          <div className="flex items-center justify-between text-xs text-slate-500 font-medium">
            <span>Success Rate</span>
            <CheckCircle2 size={14} className="text-emerald-500" />
          </div>
          <div className="text-lg font-black text-slate-900 mt-1">
            {stats?.success_rate_percent ?? 100}%
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {stats?.total_sent_all_time ?? 0} dispatched all-time
          </div>
        </div>
      </div>

      <form onSubmit={handleSave} className="space-y-8">
        {/* Section A: Provider Selection */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-5">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Server size={16} className="text-[#1F6FB2]" /> Section A: Email Provider Architecture
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Switch providers transparently without modifying business logic. Secrets are never exposed to frontend code.
              </p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <span className="text-xs font-semibold text-slate-700">Enable Email Service</span>
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                className="w-4 h-4 rounded text-[#0D3B66] focus:ring-[#0D3B66]"
              />
            </label>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              {
                id: "smtp",
                name: "Standard SMTP",
                desc: "Universal SMTP (Gmail, AWS SES, Mailgun, Postmark, Private Exchange)",
                badge: "Universal",
              },
              {
                id: "sendgrid",
                name: "Twilio SendGrid",
                desc: "High-volume transactional API with dynamic template features",
                badge: "REST API",
              },
              {
                id: "brevo",
                name: "Brevo (Sendinblue)",
                desc: "Integrated transactional relay with HTTP API & SMTP",
                badge: "Legacy Relay",
              },
            ].map((p) => {
              const selected = form.provider_type === p.id;
              return (
                <div
                  key={p.id}
                  onClick={() => setForm({ ...form, provider_type: p.id })}
                  className={`cursor-pointer rounded-xl p-4 border-2 transition-all ${
                    selected
                      ? "border-[#0D3B66] bg-blue-50/40 shadow-sm"
                      : "border-slate-200 hover:border-slate-300 bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-slate-900">{p.name}</span>
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      selected ? "bg-[#0D3B66] text-white" : "bg-slate-100 text-slate-600"
                    }`}>
                      {p.badge}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">{p.desc}</p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Section B: Sender Identity */}
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
          <div className="border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
              <Mail size={16} className="text-[#1F6FB2]" /> Section B: Sender & Branding Defaults
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Default FROM name and mailbox used on all outgoing security alerts, invitations, and license events.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">From Name</label>
              <input
                type="text"
                value={form.from_name}
                onChange={(e) => setForm({ ...form, from_name: e.target.value })}
                placeholder="TaskoSphere"
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">From Address</label>
              <input
                type="email"
                value={form.from_email}
                onChange={(e) => setForm({ ...form, from_email: e.target.value })}
                placeholder="noreply@taskosphere.com"
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Reply-To Address</label>
              <input
                type="email"
                value={form.reply_to}
                onChange={(e) => setForm({ ...form, reply_to: e.target.value })}
                placeholder="support@taskosphere.com"
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
            </div>
          </div>
        </div>

        {/* Section C: SMTP Configuration */}
        {form.provider_type === "smtp" && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Server size={16} className="text-[#1F6FB2]" /> Section C: SMTP Connection Details
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Host, Port, and authenticated credentials for your standard SMTP mail provider.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700 mb-1">SMTP Host</label>
                <input
                  type="text"
                  value={form.smtp_host}
                  onChange={(e) => setForm({ ...form, smtp_host: e.target.value })}
                  placeholder="smtp.mailgun.org / email-smtp.us-east-1.amazonaws.com"
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">SMTP Port</label>
                <input
                  type="number"
                  value={form.smtp_port}
                  onChange={(e) => setForm({ ...form, smtp_port: parseInt(e.target.value) || 587 })}
                  placeholder="587"
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">SMTP Username</label>
                <input
                  type="text"
                  value={form.smtp_username}
                  onChange={(e) => setForm({ ...form, smtp_username: e.target.value })}
                  placeholder="postmaster@taskosphere.com"
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                  <span>SMTP Password</span>
                  {masked.smtp_password_masked && (
                    <span className="text-[11px] text-slate-400 font-mono">
                      Current: {masked.smtp_password_masked}
                    </span>
                  )}
                </label>
                <input
                  type="password"
                  value={form.smtp_password}
                  onChange={(e) => setForm({ ...form, smtp_password: e.target.value })}
                  placeholder={masked.smtp_password_masked ? "Leave empty to keep current password" : "Enter SMTP password"}
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                />
              </div>
            </div>

            <div className="flex items-center gap-6 pt-2">
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={form.smtp_use_tls}
                  onChange={(e) => setForm({ ...form, smtp_use_tls: e.target.checked, smtp_use_ssl: e.target.checked ? false : form.smtp_use_ssl })}
                  className="w-4 h-4 rounded text-[#0D3B66]"
                />
                Use STARTTLS (Recommended, port 587)
              </label>
              <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-slate-700">
                <input
                  type="checkbox"
                  checked={form.smtp_use_ssl}
                  onChange={(e) => setForm({ ...form, smtp_use_ssl: e.target.checked, smtp_use_tls: e.target.checked ? false : form.smtp_use_tls })}
                  className="w-4 h-4 rounded text-[#0D3B66]"
                />
                Use SSL (Port 465)
              </label>
            </div>
          </div>
        )}

        {/* Section D: SendGrid Configuration */}
        {form.provider_type === "sendgrid" && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Key size={16} className="text-[#1F6FB2]" /> Section D: SendGrid REST API Credentials
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                SendGrid API Key requires Mail Send full permissions. Sender verification must be completed in SendGrid console.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                <span>SendGrid API Key</span>
                {masked.sendgrid_api_key_masked && (
                  <span className="text-[11px] text-slate-400 font-mono">
                    Current: {masked.sendgrid_api_key_masked}
                  </span>
                )}
              </label>
              <input
                type="password"
                value={form.sendgrid_api_key}
                onChange={(e) => setForm({ ...form, sendgrid_api_key: e.target.value })}
                placeholder={masked.sendgrid_api_key_masked ? "Leave empty to retain current key" : "SG.xxxxxxxxxxxx"}
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
            </div>
          </div>
        )}

        {/* Section D (Alt): Brevo Configuration */}
        {form.provider_type === "brevo" && (
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
            <div className="border-b border-slate-100 pb-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Key size={16} className="text-[#1F6FB2]" /> Section D: Brevo (Sendinblue) API Credentials
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Preserves backward compatibility with legacy Brevo email relay keys.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                <span>Brevo API Key (v3)</span>
                {masked.brevo_api_key_masked && (
                  <span className="text-[11px] text-slate-400 font-mono">
                    Current: {masked.brevo_api_key_masked}
                  </span>
                )}
              </label>
              <input
                type="password"
                value={form.brevo_api_key}
                onChange={(e) => setForm({ ...form, brevo_api_key: e.target.value })}
                placeholder={masked.brevo_api_key_masked ? "Leave empty to retain current key" : "xkeysib-xxxxxxxxxxxx"}
                className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
              />
            </div>
          </div>
        )}
      </form>

      {/* Section E: Live Testing Suite */}
      <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm space-y-4">
        <div className="border-b border-slate-100 pb-3">
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Send size={16} className="text-[#1F6FB2]" /> Section E: Dispatch Verification & Diagnostic Test
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Send an immediate live diagnostic test message to confirm socket connection, TLS handshake, and sender authenticity.
          </p>
        </div>

        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="email"
            value={testRecipient}
            onChange={(e) => setTestRecipient(e.target.value)}
            placeholder="Enter recipient email (e.g. admin@yourdomain.com)"
            className="flex-1 text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
          />
          <button
            type="button"
            onClick={handleSendTest}
            disabled={testing}
            className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 transition disabled:opacity-50"
          >
            {testing ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
            Send Test Email
          </button>
        </div>

        {testResult && (
          <div className={`p-4 rounded-xl text-xs border ${
            testResult.success ? "bg-emerald-50 border-emerald-200 text-emerald-900" : "bg-rose-50 border-rose-200 text-rose-900"
          }`}>
            <div className="flex items-start gap-2">
              {testResult.success ? (
                <CheckCircle2 size={16} className="text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle size={16} className="text-rose-600 shrink-0 mt-0.5" />
              )}
              <div className="space-y-1">
                <div className="font-bold">
                  {testResult.success ? "Test Dispatch Successful" : "Test Dispatch Failed"}
                </div>
                <div>{testResult.message}</div>
                <div className="text-[10px] text-slate-500">
                  Timestamp: {new Date(testResult.timestamp).toLocaleString()}
                </div>
              </div>
            </div>
          </div>
        )}

        {statusInfo.last_test_status === "failed" && !testResult && statusInfo.last_test_error && (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800 flex items-start gap-2">
            <AlertTriangle size={16} className="shrink-0 text-amber-600 mt-0.5" />
            <div>
              <strong>Last failed test:</strong> {statusInfo.last_test_error}
              {statusInfo.last_tested_at && (
                <span className="block text-[10px] text-amber-600 mt-0.5">
                  Occurred: {new Date(statusInfo.last_tested_at).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
