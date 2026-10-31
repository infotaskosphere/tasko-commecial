/**
 * DriveFolderVisibility.jsx
 * ─────────────────────────────────────────────────────────────────────────
 * Admin panel for controlling which Google Drive files/folders are visible
 * to a specific client portal user.
 *
 * Usage:
 *   <DriveFolderVisibility
 *     portalUserId="..."
 *     portalUsername="acme_corp"
 *     onClose={() => setShow(false)}
 *   />
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import api from "@/lib/api";
import { Cloud } from "lucide-react";
import { PopupHeader } from "@/components/ui/popup-header";

// ── MIME helpers ──────────────────────────────────────────────────────────
const MIME_META = {
  "application/vnd.google-apps.folder":       { icon: "📁", label: "Folder",       color: "text-yellow-600" },
  "application/vnd.google-apps.document":     { icon: "📄", label: "Doc",          color: "text-blue-600" },
  "application/vnd.google-apps.spreadsheet":  { icon: "📊", label: "Sheet",        color: "text-green-600" },
  "application/vnd.google-apps.presentation": { icon: "📽️", label: "Slides",       color: "text-orange-500" },
  "application/vnd.google-apps.form":         { icon: "📝", label: "Form",         color: "text-purple-500" },
  "application/pdf":                           { icon: "📑", label: "PDF",          color: "text-red-500" },
  "image/jpeg":                                { icon: "🖼️", label: "Image",        color: "text-pink-500" },
  "image/png":                                 { icon: "🖼️", label: "Image",        color: "text-pink-500" },
  "text/plain":                                { icon: "📃", label: "Text",         color: "text-gray-500" },
};
const getMeta = (mime) => MIME_META[mime] || { icon: "📎", label: "File", color: "text-gray-500" };

const fmtSize = (bytes) => {
  if (!bytes) return "";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

const fmtDate = (d) => {
  if (!d) return "";
  try { return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return ""; }
};

// ── Small pill ────────────────────────────────────────────────────────────
function Pill({ visible }) {
  return visible
    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-100 text-green-700 text-xs font-medium">✓ Visible</span>
    : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-600 text-xs font-medium">✕ Hidden</span>;
}

// ── Toggle switch ─────────────────────────────────────────────────────────
function Switch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative flex-shrink-0 w-11 h-6 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
        checked ? "bg-indigo-500" : "bg-gray-300"
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
          checked ? "translate-x-5" : ""
        }`}
      />
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
export default function DriveFolderVisibility({ portalUserId, portalUsername, onClose }) {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all"); // all | visible | hidden
  const [dirty, setDirty] = useState(false);

  // Local visibility state: Map<fileId, boolean>  true = visible
  const [visibility, setVisibility] = useState({});
  const originalRef = useRef({}); // snapshot for change detection

  // ── Load ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.get(`/client-portal/drive/admin/files/${portalUserId}`);
      const { files: rawFiles = [], hidden_ids = [] } = res.data;
      const hiddenSet = new Set(hidden_ids);
      const visMap = {};
      rawFiles.forEach(f => { visMap[f.id] = !hiddenSet.has(f.id); });
      setFiles(rawFiles);
      setVisibility(visMap);
      originalRef.current = { ...visMap };
      setDirty(false);
    } catch (err) {
      setError(err?.response?.data?.detail || err?.response?.data?.message || "Failed to load Drive files.");
    } finally {
      setLoading(false);
    }
  }, [portalUserId]);

  useEffect(() => { load(); }, [load]);

  // ── Toggle single file ──────────────────────────────────────────────────
  const toggle = (fileId, val) => {
    setVisibility(v => {
      const next = { ...v, [fileId]: val };
      // Check if anything changed from original
      const changed = Object.keys(next).some(id => next[id] !== originalRef.current[id]);
      setDirty(changed);
      return next;
    });
    setSuccess("");
  };

  // ── Bulk actions ────────────────────────────────────────────────────────
  const setAll = (val) => {
    const next = {};
    files.forEach(f => { next[f.id] = val; });
    setVisibility(next);
    const changed = Object.keys(next).some(id => next[id] !== originalRef.current[id]);
    setDirty(changed);
    setSuccess("");
  };

  // Apply to currently filtered files only
  const setFiltered = (val) => {
    const filtered = filteredFiles.map(f => f.id);
    setVisibility(v => {
      const next = { ...v };
      filtered.forEach(id => { next[id] = val; });
      const changed = Object.keys(next).some(id => next[id] !== originalRef.current[id]);
      setDirty(changed);
      return next;
    });
    setSuccess("");
  };

  // ── Save ────────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const hidden_ids = Object.entries(visibility)
        .filter(([, vis]) => !vis)
        .map(([id]) => id);
      await api.put(`/client-portal/drive/admin/visibility/${portalUserId}`, { hidden_ids });
      originalRef.current = { ...visibility };
      setDirty(false);
      setSuccess(`Saved! ${hidden_ids.length} file(s) hidden, ${files.length - hidden_ids.length} visible.`);
    } catch (err) {
      setError(err?.response?.data?.detail || "Failed to save visibility settings.");
    } finally {
      setSaving(false);
    }
  };

  // ── Filtered list ───────────────────────────────────────────────────────
  const filteredFiles = files.filter(f => {
    const matchSearch = !search || f.name.toLowerCase().includes(search.toLowerCase());
    const isVisible = visibility[f.id] !== false;
    if (filterType === "visible" && !isVisible) return false;
    if (filterType === "hidden"  && isVisible)  return false;
    return matchSearch;
  });

  const visibleCount = Object.values(visibility).filter(Boolean).length;
  const hiddenCount  = files.length - visibleCount;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 bg-emerald-900/50 z-50 flex items-center justify-center p-4"
      onClick={e => e.target === e.currentTarget && !dirty && onClose?.()}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden">

        {/* ── Header ───────────────────────────────────────────────────── */}
        <PopupHeader
          icon={Cloud}
          eyebrow="Client portal"
          title="Drive Folder Visibility"
          subtitle={<>Control which files <span className="font-semibold text-white">@{portalUsername}</span> can see in their portal</>}
          onClose={onClose}
        />

        {/* ── Stats bar ────────────────────────────────────────────────── */}
        {!loading && files.length > 0 && (
          <div className="flex items-center gap-4 px-6 py-3 bg-gray-50 border-b border-gray-100 flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-green-400 inline-block" />
              <span className="text-sm text-gray-600"><strong>{visibleCount}</strong> visible</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400 inline-block" />
              <span className="text-sm text-gray-600"><strong>{hiddenCount}</strong> hidden</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-gray-300 inline-block" />
              <span className="text-sm text-gray-600"><strong>{files.length}</strong> total</span>
            </div>

            {dirty && (
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-600 bg-amber-50 border border-amber-200 px-2.5 py-1 rounded-full font-medium">
                ⚠ Unsaved changes
              </span>
            )}
          </div>
        )}

        {/* ── Toolbar ──────────────────────────────────────────────────── */}
        {!loading && files.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-gray-100 flex-shrink-0">
            {/* Search */}
            <div className="relative flex-1 min-w-[180px]">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm">🔍</span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search files…"
                className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              />
            </div>

            {/* Filter pills */}
            {["all", "visible", "hidden"].map(t => (
              <button
                key={t}
                onClick={() => setFilterType(t)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium capitalize transition ${
                  filterType === t
                    ? "bg-indigo-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
              >
                {t}
              </button>
            ))}

            {/* Bulk actions */}
            <div className="flex items-center gap-1 ml-auto">
              <button
                onClick={() => setFiltered(true)}
                className="px-2.5 py-1.5 text-xs bg-green-50 text-green-700 border border-green-200 rounded-lg hover:bg-green-100 transition"
              >
                Show all filtered
              </button>
              <button
                onClick={() => setFiltered(false)}
                className="px-2.5 py-1.5 text-xs bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition"
              >
                Hide all filtered
              </button>
            </div>
          </div>
        )}

        {/* ── Content ──────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">

          {/* Loading */}
          {loading && (
            <div className="flex flex-col items-center justify-center py-20 gap-3">
              <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Loading Drive files…</p>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div className="m-6 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-4">
              <p className="font-medium mb-1">⚠️ {error}</p>
              <button onClick={load} className="text-xs underline">Retry</button>
            </div>
          )}

          {/* No Drive folder set */}
          {!loading && !error && files.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-center px-6">
              <span className="text-5xl mb-4">📂</span>
              <p className="text-gray-700 font-medium">No Google Drive folder linked</p>
              <p className="text-sm text-gray-400 mt-1">
                Go to "Portal Access" for this client and set a Google Drive Folder ID first.
              </p>
            </div>
          )}

          {/* File list */}
          {!loading && !error && files.length > 0 && (
            <div className="divide-y divide-gray-50">
              {filteredFiles.length === 0 ? (
                <div className="text-center py-12 text-gray-400 text-sm">
                  No files match your filter.
                </div>
              ) : (
                filteredFiles.map(f => {
                  const meta = getMeta(f.mimeType);
                  const isVis = visibility[f.id] !== false;
                  return (
                    <div
                      key={f.id}
                      className={`flex items-center gap-4 px-6 py-3.5 transition group hover:bg-gray-50 ${
                        !isVis ? "opacity-60" : ""
                      }`}
                    >
                      {/* Icon */}
                      <span className={`text-2xl flex-shrink-0 ${meta.color}`}>{meta.icon}</span>

                      {/* File info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <a
                            href={f.webViewLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm font-medium text-gray-800 truncate hover:text-indigo-700 hover:underline"
                          >
                            {f.name}
                          </a>
                          <span className={`text-xs px-1.5 py-0.5 rounded font-medium bg-gray-100 ${meta.color}`}>
                            {meta.label}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {fmtDate(f.modifiedTime)}
                          {f.size ? ` · ${fmtSize(f.size)}` : ""}
                          <span className="ml-2 font-mono opacity-50">{f.id.slice(0, 16)}…</span>
                        </p>
                      </div>

                      {/* Visibility pill + switch */}
                      <div className="flex items-center gap-3 flex-shrink-0">
                        <Pill visible={isVis} />
                        <Switch
                          checked={isVis}
                          onChange={val => toggle(f.id, val)}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────── */}
        <div className="border-t border-gray-100 px-6 py-4 flex items-center justify-between gap-4 flex-shrink-0 bg-white">
          <div className="flex-1">
            {success && (
              <p className="text-sm text-green-700 flex items-center gap-1.5">
                <span className="text-green-500">✓</span> {success}
              </p>
            )}
            {error && !loading && (
              <p className="text-sm text-red-600">{error}</p>
            )}
            {!success && !error && files.length > 0 && (
              <p className="text-xs text-gray-400">
                Changes apply instantly for the client after saving.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition"
            >
              {dirty ? "Discard & Close" : "Close"}
            </button>
            {files.length > 0 && (
              <button
                onClick={save}
                disabled={saving || !dirty}
                className={`px-5 py-2 text-sm font-semibold rounded-lg transition flex items-center gap-2 ${
                  dirty
                    ? "bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
                    : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }`}
              >
                {saving && (
                  <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                )}
                {saving ? "Saving…" : "Save Changes"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
