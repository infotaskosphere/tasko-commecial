import React, { useState, useEffect } from "react";
import {
  FileText, Search, Eye, Edit3, Send, RotateCcw, CheckCircle2,
  XCircle, Filter, Copy, Check, RefreshCw, X, AlertCircle, Sparkles
} from "lucide-react";
import { toast } from "sonner";
import {
  getEmailTemplates,
  updateEmailTemplate,
  previewEmailTemplate,
  testSendEmailTemplate,
  resetEmailTemplate
} from "@/lib/commercialConsoleApi";

export default function EmailTemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");

  // Modal states
  const [activeTemplate, setActiveTemplate] = useState(null);
  const [modalMode, setModalMode] = useState(null); // 'edit' | 'preview' | 'test' | null
  const [saving, setSaving] = useState(false);
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [testingSend, setTestingSend] = useState(false);
  const [copiedVar, setCopiedVar] = useState(null);

  // Edit form state
  const [editSubject, setEditSubject] = useState("");
  const [editHtml, setEditHtml] = useState("");
  const [editText, setEditText] = useState("");
  const [editIsActive, setEditIsActive] = useState(true);

  useEffect(() => {
    loadTemplates();
  }, []);

  async function loadTemplates() {
    setLoading(true);
    try {
      const res = await getEmailTemplates();
      setTemplates(res.templates || []);
    } catch (err) {
      toast.error("Failed to load templates: " + (err.response?.data?.detail || err.message));
    } finally {
      setLoading(false);
    }
  }

  function handleOpenEdit(tmpl) {
    setActiveTemplate(tmpl);
    setEditSubject(tmpl.subject || "");
    setEditHtml(tmpl.html_body || "");
    setEditText(tmpl.text_body || "");
    setEditIsActive(tmpl.is_active ?? true);
    setModalMode("edit");
  }

  async function handleOpenPreview(tmpl) {
    setActiveTemplate(tmpl);
    setModalMode("preview");
    setPreviewLoading(true);
    try {
      const res = await previewEmailTemplate(tmpl.code);
      setPreviewData(res.rendered);
    } catch (err) {
      toast.error("Preview failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setPreviewLoading(false);
    }
  }

  function handleOpenTest(tmpl) {
    setActiveTemplate(tmpl);
    setTestEmail("");
    setModalMode("test");
  }

  async function handleSaveEdit() {
    if (!activeTemplate) return;
    setSaving(true);
    try {
      const res = await updateEmailTemplate(activeTemplate.code, {
        subject: editSubject,
        html_body: editHtml,
        text_body: editText,
        is_active: editIsActive,
      });
      toast.success(`Template ${activeTemplate.code} updated successfully!`);
      setTemplates(prev => prev.map(t => t.code === activeTemplate.code ? res.template : t));
      setModalMode(null);
    } catch (err) {
      toast.error("Failed to save template: " + (err.response?.data?.detail || err.message));
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    if (!testEmail || !testEmail.includes("@")) {
      toast.error("Enter a valid recipient email");
      return;
    }
    setTestingSend(true);
    try {
      await testSendEmailTemplate(activeTemplate.code, testEmail.trim());
      toast.success(`Test email sent to ${testEmail}!`);
      setModalMode(null);
    } catch (err) {
      toast.error("Send failed: " + (err.response?.data?.detail || err.message));
    } finally {
      setTestingSend(false);
    }
  }

  async function handleReset(code) {
    if (!window.confirm(`Reset template ${code} back to system default? Any custom copy will be restored.`)) {
      return;
    }
    try {
      const res = await resetEmailTemplate(code);
      toast.success(`Template ${code} restored to default!`);
      setTemplates(prev => prev.map(t => t.code === code ? res.template : t));
    } catch (err) {
      toast.error("Reset failed: " + (err.response?.data?.detail || err.message));
    }
  }

  function copyVar(variable) {
    navigator.clipboard.writeText(`{{${variable}}}`);
    setCopiedVar(variable);
    toast.success(`Copied {{${variable}}} to clipboard`);
    setTimeout(() => setCopiedVar(null), 1800);
  }

  // Filter templates
  const filtered = templates.filter(t => {
    const matchesSearch =
      t.name.toLowerCase().includes(search.toLowerCase()) ||
      t.code.toLowerCase().includes(search.toLowerCase()) ||
      (t.purpose || "").toLowerCase().includes(search.toLowerCase());
    const matchesCat =
      categoryFilter === "all" || (t.category || "").toLowerCase() === categoryFilter.toLowerCase();
    return matchesSearch && matchesCat;
  });

  const categories = ["all", "auth", "security", "licensing", "user", "system"];

  return (
    <div className="space-y-6 max-w-5xl">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-5">
        <div>
          <h2 className="text-xl font-black text-slate-900 tracking-tight">Central Email Templates</h2>
          <p className="text-xs text-slate-500 mt-1">
            Manage the 15 system-critical notification and transactional email templates with live preview and testing.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadTemplates}
            className="px-3 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search templates by name, code..."
            className="w-full text-xs pl-9 pr-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold capitalize transition ${
                categoryFilter === cat
                  ? "bg-[#0D3B66] text-white shadow-sm"
                  : "bg-slate-100 text-slate-600 hover:bg-slate-200"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Templates List */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-600">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-500 font-bold uppercase tracking-wider text-[10px]">
              <tr>
                <th className="py-3 px-4">Template Name</th>
                <th className="py-3 px-4">Code</th>
                <th className="py-3 px-4">Purpose</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((t) => (
                <tr key={t.code} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-3.5 px-4 font-bold text-slate-900">
                    <div className="flex items-center gap-2">
                      <FileText size={15} className="text-[#1F6FB2] shrink-0" />
                      <span>{t.name}</span>
                    </div>
                  </td>
                  <td className="py-3.5 px-4 font-mono text-[11px] text-slate-700">
                    {t.code}
                  </td>
                  <td className="py-3.5 px-4 text-slate-500 max-w-xs truncate" title={t.purpose}>
                    {t.purpose}
                  </td>
                  <td className="py-3.5 px-4">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-slate-100 text-slate-700">
                      {t.category || "General"}
                    </span>
                  </td>
                  <td className="py-3.5 px-4">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      t.is_active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"
                    }`}>
                      {t.is_active ? <CheckCircle2 size={11} /> : <XCircle size={11} />}
                      {t.is_active ? "Active" : "Disabled"}
                    </span>
                  </td>
                  <td className="py-3.5 px-4 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleOpenPreview(t)}
                        title="Preview template"
                        className="p-1.5 hover:bg-slate-100 text-slate-600 hover:text-slate-900 rounded-lg transition"
                      >
                        <Eye size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenTest(t)}
                        title="Send test email"
                        className="p-1.5 hover:bg-emerald-50 text-slate-600 hover:text-emerald-700 rounded-lg transition"
                      >
                        <Send size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpenEdit(t)}
                        title="Edit template"
                        className="p-1.5 hover:bg-blue-50 text-slate-600 hover:text-[#0D3B66] rounded-lg transition"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReset(t.code)}
                        title="Reset to default"
                        className="p-1.5 hover:bg-rose-50 text-slate-400 hover:text-rose-600 rounded-lg transition"
                      >
                        <RotateCcw size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center py-8 text-slate-400">
                    No templates matching your query.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Modal: Edit Template ────────────────────────────────────────── */}
      {modalMode === "edit" && activeTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Edit Template: {activeTemplate.name} ({activeTemplate.code})
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">{activeTemplate.purpose}</p>
              </div>
              <button
                onClick={() => setModalMode(null)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-4 text-xs">
              {/* Variable Chips */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                <span className="font-bold text-slate-700 block mb-1.5">
                  Available Dynamic Variables (Click to copy):
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {(activeTemplate.variables || []).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => copyVar(v)}
                      className="px-2 py-0.5 bg-white border border-slate-300 hover:border-[#0D3B66] rounded-md font-mono text-[11px] text-slate-700 flex items-center gap-1 transition"
                    >
                      <span>{`{{${v}}}`}</span>
                      {copiedVar === v ? <Check size={11} className="text-emerald-600" /> : <Copy size={11} className="text-slate-400" />}
                    </button>
                  ))}
                </div>
              </div>

              {/* Subject */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Subject Line</label>
                <input
                  type="text"
                  value={editSubject}
                  onChange={(e) => setEditSubject(e.target.value)}
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                />
              </div>

              {/* Active Toggle */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="tmpl-active"
                  checked={editIsActive}
                  onChange={(e) => setEditIsActive(e.target.checked)}
                  className="w-4 h-4 rounded text-[#0D3B66]"
                />
                <label htmlFor="tmpl-active" className="font-semibold text-slate-700 cursor-pointer">
                  Template Active for Dispatch
                </label>
              </div>

              {/* HTML Body */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">HTML Body</label>
                <textarea
                  rows={10}
                  value={editHtml}
                  onChange={(e) => setEditHtml(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                />
              </div>

              {/* Plain Text Body */}
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Plain Text Fallback Body</label>
                <textarea
                  rows={4}
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="w-full text-xs font-mono px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="px-4 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl font-semibold text-xs transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                disabled={saving}
                className="px-4 py-2 bg-[#0D3B66] hover:bg-[#082642] text-white rounded-xl font-bold text-xs shadow-sm flex items-center gap-1.5 transition disabled:opacity-50"
              >
                {saving ? <RefreshCw size={14} className="animate-spin" /> : null}
                Save Template Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Preview Template ─────────────────────────────────────── */}
      {modalMode === "preview" && activeTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Preview: {activeTemplate.name}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">Rendered with representative mock variables</p>
              </div>
              <button
                onClick={() => setModalMode(null)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 flex-1 overflow-y-auto space-y-4 text-xs">
              {previewLoading ? (
                <div className="py-12 flex flex-col items-center justify-center space-y-2">
                  <RefreshCw className="w-6 h-6 text-[#0D3B66] animate-spin" />
                  <p className="text-slate-500">Rendering preview...</p>
                </div>
              ) : previewData ? (
                <div className="space-y-3">
                  <div className="bg-slate-50 p-3 rounded-xl border border-slate-200">
                    <span className="text-[10px] uppercase font-bold text-slate-400 block">Subject:</span>
                    <span className="font-bold text-slate-900">{previewData.subject}</span>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">HTML Preview:</span>
                    <div
                      className="border border-slate-200 rounded-xl p-4 bg-white overflow-x-auto min-h-[220px]"
                      dangerouslySetInnerHTML={{ __html: previewData.html }}
                    />
                  </div>

                  {previewData.text && (
                    <div>
                      <span className="text-[10px] uppercase font-bold text-slate-400 block mb-1">Plain Text Preview:</span>
                      <pre className="bg-slate-50 border border-slate-200 p-3 rounded-xl whitespace-pre-wrap font-mono text-[11px] text-slate-700">
                        {previewData.text}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-slate-400 text-center py-6">No preview available.</p>
              )}
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setModalMode("test");
                  setTestEmail("");
                }}
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 transition"
              >
                <Send size={13} /> Send Test Dispatch
              </button>
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="px-4 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl font-semibold text-xs transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Send Test Email ───────────────────────────────────────── */}
      {modalMode === "test" && activeTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">
                Send Test: {activeTemplate.name}
              </h3>
              <button
                onClick={() => setModalMode(null)}
                className="p-1 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-4 text-xs">
              <p className="text-slate-500">
                This will render template <strong>{activeTemplate.code}</strong> with sample context and send it via your active email provider.
              </p>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">Recipient Email Address</label>
                <input
                  type="email"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  placeholder="admin@yourcompany.com"
                  className="w-full text-xs px-3 py-2 border border-slate-200 rounded-xl focus:outline-none focus:border-[#0D3B66]"
                  autoFocus
                />
              </div>
            </div>

            <div className="p-4 border-t border-slate-200 bg-slate-50 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setModalMode(null)}
                className="px-4 py-2 border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 rounded-xl font-semibold text-xs transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendTest}
                disabled={testingSend}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs shadow-sm flex items-center gap-1.5 transition disabled:opacity-50"
              >
                {testingSend ? <RefreshCw size={14} className="animate-spin" /> : <Send size={14} />}
                Send Test Now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
