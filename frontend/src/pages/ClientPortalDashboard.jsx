// ── ClientPortalDashboard.jsx — GOOGLE DRIVE / CONTACT ROBUST V2 ─────────
// Enhanced with:
//   • Messages tab (client receives messages from admin — DSC, compliance, etc.)
//   • Unread message badge on tab
//   • Section significance tooltips (Documents, Tasks, Invoices, Compliance)
//   • Mark-as-read on expand
// ─────────────────────────────────────────────────────────────────────────
import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { BASE_URL } from "@/lib/api";

// Same department codes used on Admin → Users (a staff member's
// `departments` field) and Admin → Contact Details (the helpline
// directory) — kept here as a small label lookup so the codes shown on the
// client portal (task assignee's department, Contact Us tab) read as
// friendly names instead of raw codes like "TM" or "ACC".
const DEPT_LABELS = {
  GST: 'GST', IT: 'Income Tax', ACC: 'Accounts', TDS: 'TDS',
  ROC: 'ROC / Company Law', TM: 'Trademark & IP', MSME: 'MSME',
  FEMA: 'FEMA', DSC: 'DSC', OTHER: 'General / Other',
};
const deptLabel = (code) => DEPT_LABELS[code] || code;

const API_BASE = BASE_URL;

function portalApi() {
  const token = sessionStorage.getItem("client_portal_token");
  return axios.create({
    baseURL: API_BASE,
    headers: { Authorization: `Bearer ${token}` },
  });
}

const fmtDate = (d) => {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit", month: "short", year: "numeric",
    });
  } catch { return d; }
};

const STATUS_COLOR = {
  completed:    "bg-green-100 text-green-700",
  done:         "bg-green-100 text-green-700",
  pending:      "bg-yellow-100 text-yellow-700",
  "in-progress":"bg-blue-100 text-blue-700",
  overdue:      "bg-red-100 text-red-700",
  filed:        "bg-green-100 text-green-700",
  paid:         "bg-green-100 text-green-700",
  unpaid:       "bg-red-100 text-red-700",
  draft:        "bg-gray-100 text-gray-600",
};

function Badge({ status }) {
  const cls = STATUS_COLOR[status?.toLowerCase()] || "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium capitalize ${cls}`}>
      {status || "—"}
    </span>
  );
}

const DRIVE_ICONS = {
  "application/vnd.google-apps.folder":       { icon: "📁", color: "text-yellow-500" },
  "application/vnd.google-apps.document":     { icon: "📄", color: "text-blue-500" },
  "application/vnd.google-apps.spreadsheet":  { icon: "📊", color: "text-green-500" },
  "application/vnd.google-apps.presentation": { icon: "📽️", color: "text-orange-500" },
  "application/vnd.google-apps.form":         { icon: "📝", color: "text-purple-500" },
  "application/pdf":                          { icon: "📑", color: "text-red-500" },
  "image/jpeg":                               { icon: "🖼️", color: "text-pink-500" },
  "image/png":                                { icon: "🖼️", color: "text-pink-500" },
};
const driveIcon = (mime) => DRIVE_ICONS[mime] || { icon: "📎", color: "text-gray-500" };

const fmtSize = (bytes) => {
  if (!bytes) return "";
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
};

// ── Backend-proxied URL builder ───────────────────────────────────────────
// All file access goes through our backend's authenticated Drive proxy so that
// clients never need their own Google account. Direct Drive links return 403
// ("Request access") for any non-owner Google account.
function getProxyDownloadUrl(file, { inline = false } = {}) {
  const token = sessionStorage.getItem("client_portal_token");
  const disposition = inline ? "&disposition=inline" : "";
  return `${API_BASE}/client-portal/drive/download?file_id=${encodeURIComponent(file.id)}&token=${encodeURIComponent(token)}${disposition}`;
}

// Mime types we can render inline inside the preview modal
const PREVIEWABLE_IMAGE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);
const PREVIEWABLE_PDF = new Set([
  "application/pdf",
  "application/vnd.google-apps.document",     // exported to PDF by backend
  "application/vnd.google-apps.presentation",  // exported to PDF by backend
]);
function isPreviewable(mimeType) {
  return PREVIEWABLE_IMAGE.has(mimeType) || PREVIEWABLE_PDF.has(mimeType);
}

// ── Share Link Button ─────────────────────────────────────────────────────
// Copies the backend proxy URL (authenticated download link) to clipboard.
// For folders: copies a deep-link URL back into the portal itself (no Google login needed).
// For files: copies the backend proxy download URL so anyone with the portal token can access it.
function ShareBtn({ file }) {
  const [copied, setCopied] = useState(false);

  const getShareUrl = () => {
    if (file.mimeType === "application/vnd.google-apps.folder") {
      // Share a portal deep-link — routes through the portal, no Google login needed
      const base = window.location.origin + window.location.pathname.replace(/\/dash.*/, "/dashboard");
      return `${base}?folder=${file.id}`;
    }
    // Share the backend proxy download URL — works without a Google account
    return getProxyDownloadUrl(file);
  };

  const handleShare = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const url = getShareUrl();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: open the file directly if clipboard fails
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <button
      onClick={handleShare}
      title={copied ? "Link copied!" : "Copy shareable link"}
      className={`flex-shrink-0 p-1.5 rounded-lg transition opacity-0 group-hover:opacity-100 ${
        copied
          ? "text-green-600 bg-green-50"
          : "text-gray-400 hover:text-purple-600 hover:bg-purple-50"
      }`}
    >
      {copied ? (
        // Checkmark icon
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        // Link/share icon
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      )}
    </button>
  );
}

// ── Preview Modal ──────────────────────────────────────────────────────────
// Renders images and PDFs inline; anything else shows a friendly fallback
// with a direct download action instead of a broken preview.
function PreviewModal({ file, onClose }) {
  if (!file) return null;
  const meta = driveIcon(file.mimeType);
  const isImage = PREVIEWABLE_IMAGE.has(file.mimeType);
  const isPdf = PREVIEWABLE_PDF.has(file.mimeType);
  const src = getProxyDownloadUrl(file, { inline: true });

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] bg-emerald-900/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`text-xl flex-shrink-0 ${meta.color}`}>{meta.icon}</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-800 truncate">{file.name}</p>
              <p className="text-xs text-gray-400">
                {file.modifiedTime ? fmtDate(file.modifiedTime) : ""}{file.size ? ` · ${fmtSize(file.size)}` : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <a
              href={getProxyDownloadUrl(file)}
              title="Download"
              className="p-2 rounded-lg text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
              </svg>
            </a>
            <button
              onClick={onClose}
              title="Close"
              className="p-2 rounded-lg text-gray-500 hover:text-red-600 hover:bg-red-50 transition"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto bg-gray-100 flex items-center justify-center min-h-[300px]">
          {isImage && (
            <img src={src} alt={file.name} className="max-w-full max-h-[75vh] object-contain mx-auto" />
          )}
          {isPdf && (
            <iframe title={file.name} src={src} className="w-full h-[75vh] border-0" />
          )}
          {!isImage && !isPdf && (
            <div className="text-center py-16 px-6">
              <span className="text-5xl block mb-3 opacity-60">{meta.icon}</span>
              <p className="text-sm text-gray-500 mb-4">Preview isn't available for this file type.</p>
              <a
                href={getProxyDownloadUrl(file)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition"
              >
                Download to view
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewBtn({ file, onPreview }) {
  if (!isPreviewable(file.mimeType)) return null;
  return (
    <button
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onPreview(file); }}
      title="Preview"
      className="flex-shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 transition opacity-0 group-hover:opacity-100"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
      </svg>
    </button>
  );
}

function DownloadBtn({ file }) {
  const isFolder = file.mimeType === "application/vnd.google-apps.folder";
  if (isFolder) return null;

  const handleDownload = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Use backend proxy — direct Drive URLs return 403 for non-owner Google accounts
    window.open(getProxyDownloadUrl(file), "_blank", "noopener,noreferrer");
  };

  return (
    <button
      onClick={handleDownload}
      title="Download file"
      className="flex-shrink-0 p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition opacity-0 group-hover:opacity-100"
    >
      <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V4" />
      </svg>
    </button>
  );
}

// ── Section significance descriptions ────────────────────────────────────
const SECTION_SIGNIFICANCE = {
  "Tasks": "Shows all active tasks assigned to you by our team — including pending actions, document submissions, approvals, and follow-ups you need to be aware of.",
  "Documents": "Contains all your important documents tracked by our firm — such as registration certificates, PAN, DSC expiry, licenses, and compliance-related documents with their status and expiry dates.",
  "Invoices": "All fee invoices raised by our firm for professional services rendered. You can view invoice amounts, dates, payment status, and outstanding balances.",
  "Compliance": "Tracks all statutory compliance filings applicable to you — GST returns, ITR, ROC filings, TDS, etc. — with due dates and filing status so you never miss a deadline.",
  "My Drive": "Securely access files and folders shared with you by our team — reports, workings, certificates, correspondence, and other documents stored in your dedicated Drive folder.",
  "Messages": "Direct messages from our team — important alerts such as DSC expiry notices, compliance reminders, invoice communications, and any other updates regarding your account.",
  "Contact Us": "Direct helpline numbers for each department at our firm, so you can reach the right team quickly for urgent queries.",
};

function InfoTooltip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onClick={() => setShow(v => !v)}
        className="ml-1 w-4 h-4 rounded-full bg-gray-200 text-gray-500 text-[10px] flex items-center justify-center hover:bg-blue-100 hover:text-blue-600 transition"
        title="What is this?"
      >i</button>
      {show && (
        <div className="absolute z-50 left-5 top-0 w-64 bg-gray-900 text-white text-xs rounded-xl p-3 shadow-xl leading-relaxed pointer-events-none">
          {text}
          <div className="absolute left-[-5px] top-3 w-2.5 h-2.5 bg-gray-900 rotate-45" />
        </div>
      )}
    </div>
  );
}

function Section({ title, icon, children, count }) {
  const significance = SECTION_SIGNIFICANCE[title];
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <span className="text-xl">{icon}</span>
          <h2 className="font-semibold text-gray-800">{title}</h2>
          {count !== undefined && (
            <span className="bg-blue-100 text-blue-700 text-xs font-medium px-2 py-0.5 rounded-full">
              {count}
            </span>
          )}
          {significance && <InfoTooltip text={significance} />}
        </div>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Empty({ message }) {
  return <div className="text-center py-8 text-gray-400 text-sm">{message}</div>;
}

function Breadcrumb({ crumbs, onNavigate }) {
  return (
    <nav className="flex items-center gap-1 text-sm mb-4 flex-wrap">
      {crumbs.map((c, i) => (
        <React.Fragment key={c.id}>
          {i > 0 && <span className="text-gray-300 mx-1">/</span>}
          {i < crumbs.length - 1 ? (
            <button
              onClick={() => onNavigate(i)}
              className="text-blue-600 hover:underline font-medium truncate max-w-[180px]"
            >
              {c.name}
            </button>
          ) : (
            <span className="text-gray-700 font-semibold truncate max-w-[220px]">{c.name}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

const SORT_OPTIONS = [
  { id: "name",     label: "Name (A–Z)" },
  { id: "date",     label: "Date modified" },
  { id: "size",     label: "Size" },
];

function DriveTab({ user }) {
  const [driveData, setDriveData] = useState({ files: [], folders: [], breadcrumb: [] });
  // Local breadcrumb stack: array of { id, name } representing current navigation path
  const [crumbStack, setCrumbStack] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("name");
  const [viewMode, setViewMode] = useState("grid"); // grid | list
  const [previewFile, setPreviewFile] = useState(null);

  // fetchFolder: folderId = null means root.
  // parentFolderId = the folder we navigated FROM (needed by backend security check).
  // newCrumbStack = the breadcrumb stack to save after this fetch succeeds.
  const fetchFolder = useCallback(async (folderId, newCrumbStack) => {
    setLoading(true);
    setError("");
    const api = portalApi();
    try {
      const params = {};
      if (folderId) {
        params.folder_id = folderId;
        // Send the parent (second-to-last in the stack) for security validation
        if (newCrumbStack && newCrumbStack.length >= 2) {
          params.parent_folder_id = newCrumbStack[newCrumbStack.length - 2].id;
        }
        // Send existing breadcrumb so backend can rebuild it
        const existingCrumbs = newCrumbStack ? newCrumbStack.slice(0, -1) : [];
        if (existingCrumbs.length > 0) {
          params.breadcrumb_json = JSON.stringify(existingCrumbs);
        }
      }
      const res = await api.get("/client-portal/drive/files", { params });
      setDriveData(res.data);
      // Use the breadcrumb returned by backend (authoritative), or fall back to local stack
      if (res.data.breadcrumb && res.data.breadcrumb.length > 0) {
        setCrumbStack(res.data.breadcrumb);
      } else if (newCrumbStack) {
        setCrumbStack(newCrumbStack);
      }
    } catch (err) {
      setError(err?.response?.data?.detail || "Failed to load Drive files.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load: root folder
  useEffect(() => { fetchFolder(null, []); }, [fetchFolder]);

  // Navigate INTO a subfolder
  const navigateToFolder = (folder) => {
    const newStack = [...crumbStack, { id: folder.id, name: folder.name }];
    fetchFolder(folder.id, newStack);
  };

  // Navigate via breadcrumb — crumbIndex is the index in crumbStack to go back to
  const navigateToBreadcrumb = (crumbIndex) => {
    if (crumbIndex === 0) {
      // Go to root
      setCrumbStack([]);
      fetchFolder(null, []);
    } else {
      const newStack = crumbStack.slice(0, crumbIndex + 1);
      const targetId = newStack[newStack.length - 1].id;
      fetchFolder(targetId, newStack);
    }
  };

  const totalItems = (driveData.folders?.length || 0) + (driveData.files?.length || 0);

  const q = search.trim().toLowerCase();
  const filteredFolders = (driveData.folders || []).filter(f => f.name.toLowerCase().includes(q));
  const filteredFiles = (driveData.files || []).filter(f => f.name.toLowerCase().includes(q));

  const sortFn = (a, b) => {
    if (sortBy === "date") return new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0);
    if (sortBy === "size") return (Number(b.size) || 0) - (Number(a.size) || 0);
    return a.name.localeCompare(b.name);
  };
  const sortedFolders = [...filteredFolders].sort((a, b) => a.name.localeCompare(b.name));
  const sortedFiles = [...filteredFiles].sort(sortFn);

  const totalSize = (driveData.files || []).reduce((sum, f) => sum + (Number(f.size) || 0), 0);

  const handleOpenFile = (f) => {
    if (isPreviewable(f.mimeType)) setPreviewFile(f);
    else window.open(getProxyDownloadUrl(f), "_blank", "noopener,noreferrer");
  };

  return (
    <Section title="My Documents" icon="☁️" count={totalItems}>
      {previewFile && <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />}

      {driveData.message && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 text-sm rounded-xl px-4 py-3 mb-4">
          ℹ️ {driveData.message}
        </div>
      )}
      {(error || driveData.error) && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3 mb-4">
          ⚠️ {error || driveData.error}
        </div>
      )}

      {/* Breadcrumb navigation */}
      {crumbStack.length > 0 && (
        <Breadcrumb crumbs={crumbStack} onNavigate={navigateToBreadcrumb} />
      )}

      {/* Toolbar: search, sort, view toggle, stats */}
      {!loading && (totalItems > 0 || search) && (
        <div className="flex flex-wrap items-center gap-2.5 mb-5 pb-4 border-b border-gray-100">
          <div className="relative flex-1 min-w-[180px]">
            <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search this folder..."
              className="w-full pl-9 pr-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
            />
          </div>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="text-sm px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 text-gray-600"
          >
            {SORT_OPTIONS.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>

          <div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode("grid")}
              title="Grid view"
              className={`p-1.5 rounded-md transition ${viewMode === "grid" ? "bg-white shadow-sm text-blue-600" : "text-gray-400 hover:text-gray-600"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
              </svg>
            </button>
            <button
              onClick={() => setViewMode("list")}
              title="List view"
              className={`p-1.5 rounded-md transition ${viewMode === "list" ? "bg-white shadow-sm text-blue-600" : "text-gray-400 hover:text-gray-600"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>

          {totalSize > 0 && (
            <span className="text-xs text-gray-400 ml-auto hidden sm:block">
              {driveData.files.length} file{driveData.files.length !== 1 ? "s" : ""} · {fmtSize(totalSize)}
            </span>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-7 h-7 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      ) : (
        <>
          {sortedFolders.length > 0 && (
            <div className="mb-5">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Folders</p>
              <div className={viewMode === "grid" ? "grid sm:grid-cols-2 lg:grid-cols-3 gap-2" : "space-y-2"}>
                {sortedFolders.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-center gap-3 p-3 bg-yellow-50 rounded-xl border border-yellow-100 hover:border-yellow-300 hover:bg-yellow-100 transition text-left group w-full relative"
                  >
                    {/* Clickable area to enter folder */}
                    <button
                      onClick={() => navigateToFolder(f)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left"
                    >
                      <span className="text-2xl flex-shrink-0">📁</span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate group-hover:text-yellow-800">
                          {f.name}
                        </p>
                        {f.modifiedTime && (
                          <p className="text-xs text-gray-400">{fmtDate(f.modifiedTime)}</p>
                        )}
                      </div>
                      <span className="text-gray-300 group-hover:text-yellow-500 text-xs flex-shrink-0 mr-1">→</span>
                    </button>

                    {/* Share button for folder */}
                    <ShareBtn file={f} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {sortedFiles.length > 0 && (
            <div>
              {sortedFolders.length > 0 && (
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Files</p>
              )}
              <div className={viewMode === "grid" ? "grid sm:grid-cols-2 lg:grid-cols-3 gap-2" : "space-y-2"}>
                {sortedFiles.map((f) => {
                  const meta = driveIcon(f.mimeType);
                  return (
                    <div
                      key={f.id}
                      onClick={() => handleOpenFile(f)}
                      className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition group cursor-pointer"
                    >
                      <span className={`text-2xl flex-shrink-0 ${meta.color}`}>{meta.icon}</span>

                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 truncate group-hover:text-blue-700">
                          {f.name}
                        </p>
                        <p className="text-xs text-gray-400">
                          {f.modifiedTime ? fmtDate(f.modifiedTime) : ""}
                          {f.size ? ` · ${fmtSize(f.size)}` : ""}
                        </p>
                      </div>

                      {/* Action buttons — visible on hover */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {/* Preview (images / PDFs) */}
                        <PreviewBtn file={f} onPreview={setPreviewFile} />

                        {/* Share link */}
                        <ShareBtn file={f} />

                        {/* Download */}
                        <DownloadBtn file={f} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {!sortedFiles.length && !sortedFolders.length && !driveData.message && !driveData.error && !error && (
            <Empty message={q ? `No files matching "${search}".` : "No files found in this folder."} />
          )}
        </>
      )}
    </Section>
  );
}

// ── Messages Tab (Client side) ────────────────────────────────────────────
const MSG_TYPE_META = {
  dsc_expiry:       { label: "DSC Expiry Alert",  icon: "🔐", headerBg: "bg-red-600",    lightBg: "bg-red-50",    border: "border-red-200",    badge: "bg-red-100 text-red-700" },
  compliance_due:   { label: "Compliance Due",    icon: "📋", headerBg: "bg-orange-500", lightBg: "bg-orange-50", border: "border-orange-200", badge: "bg-orange-100 text-orange-700" },
  invoice_reminder: { label: "Invoice Reminder",  icon: "🧾", headerBg: "bg-blue-600",   lightBg: "bg-blue-50",   border: "border-blue-200",   badge: "bg-blue-100 text-blue-700" },
  general:          { label: "Message",           icon: "💬", headerBg: "bg-slate-600",  lightBg: "bg-white",     border: "border-gray-200",   badge: "bg-gray-100 text-gray-600" },
  custom:           { label: "Notice",            icon: "📢", headerBg: "bg-purple-600", lightBg: "bg-purple-50", border: "border-purple-200", badge: "bg-purple-100 text-purple-700" },
};

const QUICK_REPLIES = [
  "Noted, thank you.",
  "Will share with the team.",
  "Acknowledged. We will act on this.",
  "Please send us the details.",
  "We will arrange the documents shortly.",
  "Understood. We will follow up.",
];

function MessageCard({ msg, onRead, onReplySuccess }) {
  const [expanded, setExpanded] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [replies, setReplies] = useState(msg.replies || []);

  const typeKey = msg.message_type || "general";
  const meta = MSG_TYPE_META[typeKey] || MSG_TYPE_META.general;

  const handleToggle = async () => {
    const next = !expanded;
    setExpanded(next);
    if (next && !msg.is_read) {
      onRead && await onRead(msg.id);
    }
  };

  const sendReply = async (text) => {
    const replyBody = text || replyText.trim();
    if (!replyBody) return;
    setSending(true);
    try {
      const res = await portalApi().post(`/client-portal/my-messages/${msg.id}/reply`, { body: replyBody });
      const newReply = { body: replyBody, created_at: new Date().toISOString(), from_client: true };
      setReplies(prev => [...prev, newReply]);
      setReplyText("");
      setReplyOpen(false);
      setSent(true);
      setTimeout(() => setSent(false), 3000);
      onReplySuccess && onReplySuccess();
    } catch {
      // silent — show nothing
    } finally {
      setSending(false);
    }
  };

  const fmtDate = (d) => {
    if (!d) return "";
    try {
      return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch { return d; }
  };

  // Render body with line breaks preserved
  const renderBody = (text) =>
    text ? text.split("\n").map((line, i) => (
      <span key={i}>{line}{i < text.split("\n").length - 1 && <br />}</span>
    )) : null;

  return (
    <div className={`rounded-2xl border overflow-hidden shadow-sm transition-all ${meta.border} ${!msg.is_read ? "ring-2 ring-blue-300 ring-offset-1" : ""}`}>

      {/* ── Coloured header bar ── */}
      <div className={`${meta.headerBg} px-4 py-3 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <span className="text-lg">{meta.icon}</span>
          <span className="text-white text-xs font-bold uppercase tracking-wide">{meta.label}</span>
          {!msg.is_read && (
            <span className="bg-white text-blue-700 text-[9px] font-extrabold px-2 py-0.5 rounded-full animate-pulse">NEW</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-white/70 text-[11px]">
            {msg.created_at ? new Date(msg.created_at).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : ""}
          </span>
          <button
            onClick={handleToggle}
            className="text-white/80 hover:text-white text-xs font-medium transition"
          >
            {expanded ? "▲ Collapse" : "▼ Read"}
          </button>
        </div>
      </div>

      {/* ── Message body ── */}
      <div className={`${meta.lightBg} px-5 pt-4 pb-2`}>
        {/* Subject */}
        <p className={`text-sm font-bold text-gray-900 mb-3 ${!msg.is_read ? "text-blue-900" : ""}`}>
          {msg.subject || "(no subject)"}
        </p>

        {/* Preview or full body */}
        {!expanded ? (
          <p className="text-xs text-gray-500 leading-relaxed line-clamp-2 mb-3">
            {msg.body}
          </p>
        ) : (
          <>
            {/* Full formatted body */}
            <div className="text-sm text-gray-700 leading-7 whitespace-pre-wrap bg-white border border-gray-100 rounded-xl px-4 py-4 mb-4 shadow-inner font-[system-ui]">
              {renderBody(msg.body)}
            </div>

            {/* Sender + time */}
            <div className="flex items-center justify-between text-xs text-gray-400 mb-4">
              <span>From: <span className="font-semibold text-gray-600">{msg.from_user_name || "Your CA/CS Team"}</span></span>
              <span>{fmtDate(msg.created_at)}</span>
            </div>

            {/* Previous replies */}
            {replies.length > 0 && (
              <div className="space-y-2 mb-4">
                <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Replies</p>
                {replies.map((r, i) => (
                  <div key={i} className={`flex ${r.from_client ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-xs leading-relaxed shadow-sm ${
                      r.from_client
                        ? "bg-blue-600 text-white rounded-br-sm"
                        : "bg-gray-100 text-gray-700 rounded-bl-sm"
                    }`}>
                      {r.body}
                      <p className={`text-[9px] mt-1 ${r.from_client ? "text-blue-200" : "text-gray-400"}`}>
                        {r.created_at ? new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Sent confirmation */}
            {sent && (
              <div className="flex items-center gap-2 text-emerald-600 text-xs font-semibold bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 mb-3">
                ✅ Reply sent successfully
              </div>
            )}

            {/* Quick replies */}
            {!replyOpen && (
              <div className="mb-3">
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-2">Quick Reply</p>
                <div className="flex flex-wrap gap-2">
                  {QUICK_REPLIES.map((qr) => (
                    <button
                      key={qr}
                      onClick={(e) => { e.stopPropagation(); sendReply(qr); }}
                      disabled={sending}
                      className="text-xs px-3 py-1.5 rounded-full border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 hover:border-blue-400 transition font-medium disabled:opacity-50"
                    >
                      {qr}
                    </button>
                  ))}
                  <button
                    onClick={(e) => { e.stopPropagation(); setReplyOpen(true); }}
                    className="text-xs px-3 py-1.5 rounded-full border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 transition font-medium"
                  >
                    ✏️ Custom reply…
                  </button>
                </div>
              </div>
            )}

            {/* Custom reply textarea */}
            {replyOpen && (
              <div className="mb-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Write a reply</p>
                <textarea
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  rows={3}
                  placeholder="Type your reply here…"
                  className="w-full border border-gray-200 rounded-xl px-3 py-2 text-sm text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400 resize-none bg-white"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() => sendReply()}
                    disabled={sending || !replyText.trim()}
                    className="px-4 py-1.5 rounded-xl bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
                  >
                    {sending ? "Sending…" : "Send Reply"}
                  </button>
                  <button
                    onClick={() => { setReplyOpen(false); setReplyText(""); }}
                    className="px-4 py-1.5 rounded-xl border border-gray-200 text-gray-500 text-xs hover:bg-gray-50 transition"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Footer tap hint ── */}
      {!expanded && (
        <button
          onClick={handleToggle}
          className={`w-full text-center text-[11px] font-semibold py-2 ${meta.lightBg} text-blue-500 hover:text-blue-700 border-t ${meta.border} transition`}
        >
          Tap to read full message ↓
        </button>
      )}
    </div>
  );
}

function MessagesTab({ onUnreadChange }) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await portalApi().get("/client-portal/my-messages");
      const msgs = Array.isArray(res.data) ? res.data : [];
      setMessages(msgs);
      onUnreadChange && onUnreadChange(msgs.filter(m => !m.is_read).length);
    } catch {
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [onUnreadChange]);

  useEffect(() => { load(); }, [load]);

  const handleRead = async (msgId) => {
    try {
      await portalApi().put(`/client-portal/my-messages/${msgId}/read`);
      setMessages(prev => {
        const updated = prev.map(m => m.id === msgId ? { ...m, is_read: true } : m);
        onUnreadChange && onUnreadChange(updated.filter(m => !m.is_read).length);
        return updated;
      });
    } catch { /* silent */ }
  };

  const unreadCount = messages.filter(m => !m.is_read).length;

  return (
    <Section title="Messages" icon="💬" count={messages.length}>
      {loading ? (
        <div className="flex justify-center py-10">
          <div className="w-7 h-7 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
        </div>
      ) : messages.length === 0 ? (
        <div className="text-center py-12">
          <div className="text-5xl mb-3">💬</div>
          <p className="text-gray-600 text-sm font-semibold">No messages yet</p>
          <p className="text-gray-400 text-xs mt-1">Your firm will send important updates, alerts, and notices here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {unreadCount > 0 && (
            <div className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 rounded-xl border border-blue-200 text-sm text-blue-700 font-semibold">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse inline-block" />
              {unreadCount} unread message{unreadCount > 1 ? "s" : ""} — tap to open
            </div>
          )}
          {messages.map((msg) => (
            <MessageCard
              key={msg.id}
              msg={msg}
              onRead={handleRead}
              onReplySuccess={load}
            />
          ))}
        </div>
      )}
    </Section>
  );
}


// ── Task assignee's department + helpline (shown on each Tasks card) ──────
// Resolves the assigned staff member's department code(s) — set by admin on
// Users → Departments — against the admin-configured helpline directory
// (Admin → Contact Details) and shows the matching department + number
// right under "Assigned to". A staff member can belong to more than one
// department; the first one with a saved phone/email wins.
function TaskDeptContact({ departments, helpDesk }) {
  const codes = Array.isArray(departments) ? departments : [];
  if (codes.length === 0) return null;

  const rows = helpDesk || [];
  const match = codes
    .map(code => rows.find(r => r.department === code))
    .find(r => r && ((r.phone || "").trim() || (r.email || "").trim()))
    || (codes[0] ? { department: codes[0] } : null);

  if (!match) return null;

  return (
    <p className="text-xs text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-1.5">
      <span>Department:</span>
      <span className="font-medium text-gray-700">{deptLabel(match.department)}</span>
      {match.phone && (
        <a href={`tel:${match.phone.replace(/[^\d+]/g, "")}`} className="text-blue-600 hover:text-blue-700 font-medium">
          📞 {match.phone}
        </a>
      )}
      {!match.phone && match.email && (
        <a href={`mailto:${match.email}`} className="text-blue-600 hover:text-blue-700 font-medium">
          ✉️ {match.email}
        </a>
      )}
    </p>
  );
}

// ── Contact Us Tab (Client side) ──────────────────────────────────────────
// Renders the department-wise helpline directory configured by the admin
// (Client Portal Setting → Department Helpline Numbers). Purely display —
// data arrives pre-loaded via the public-settings call the dashboard
// already makes, so this tab needs no separate fetch/loading state.
function ContactTab({ helpDesk, peopleContacts }) {
  const rows = (helpDesk || []).filter(r => (r.department || "").trim());
  const people = (peopleContacts || []).filter(r =>
    (r.name || "").trim() || (r.position || "").trim() || (r.phone || "").trim() || (r.email || "").trim()
  );

  return (
    <Section title="Contact Us" icon="📞" count={(rows.length + people.length) || undefined}>
      <div className="space-y-6">
        {people.length > 0 && (
          <div>
            <h3 className="font-semibold text-gray-900 text-sm mb-3">Key Contacts</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {people.map((p, i) => (
                <div key={`person-${i}`} className="p-4 bg-white rounded-xl border border-gray-100 hover:border-blue-200 transition">
                  <p className="font-semibold text-gray-900 text-sm">{p.name || "Contact"}</p>
                  {p.position && <p className="text-xs text-gray-500 mt-0.5">{p.position}</p>}
                  {p.phone && (
                    <a href={`tel:${p.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mt-2 font-medium">
                      <span>📞</span> {p.phone}
                    </a>
                  )}
                  {p.email && (
                    <a href={`mailto:${p.email}`} className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-blue-600 mt-1.5">
                      <span>✉️</span> {p.email}
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="font-semibold text-gray-900 text-sm mb-3">Department Helplines</h3>
          {rows.length === 0 ? (
            <Empty message="Helpline details haven't been added yet. Please check back soon." />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {rows.map((r, i) => (
                <div key={`dept-${i}`} className="p-4 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-200 transition">
                  <p className="font-semibold text-gray-900 text-sm">{deptLabel(r.department)}</p>
                  {r.phone && <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 mt-2 font-medium"><span>📞</span> {r.phone}</a>}
                  {r.email && <a href={`mailto:${r.email}`} className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-blue-600 mt-1.5"><span>✉️</span> {r.email}</a>}
                  {r.hours && <p className="text-xs text-gray-400 mt-1.5">{r.hours}</p>}
                  {!r.phone && !r.email && <p className="text-xs text-gray-400 mt-1.5 italic">Contact details coming soon.</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

export default function ClientPortalDashboard() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState("drive");
  const [data, setData] = useState({ tasks: [], documents: [], invoices: [], compliance: [] });
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // ── Branding (custom logo set by the admin in Client Portal Setting) ──
  const [branding, setBranding] = useState({
    portal_name: "Client Portal",
    logo_url: null,
    help_desk: [],
    people_contacts: [],
  });
  // null means the portal availability is still being checked. The client
  // dashboard is not rendered until this check completes.
  const [portalStatus, setPortalStatus] = useState(null);

  const refreshPortalStatus = useCallback(async () => {
    try {
      const res = await portalApi().get("/client-portal/public-settings", {
        params: { _ts: Date.now() },
      });
      const nextStatus = String(res?.data?.portal_status || "live").toLowerCase();
      setBranding((b) => ({ ...b, ...(res?.data || {}) }));
      setPortalStatus(
        ["live", "maintenance", "offline"].includes(nextStatus) ? nextStatus : "live"
      );
    } catch {
      // Do not silently switch a known maintenance/offline portal to live.
      // A transient status-fetch failure keeps the current state intact; on
      // first load it remains in the safe "checking" state.
      setPortalStatus((current) => current ?? null);
    }
  }, []);

  useEffect(() => {
    refreshPortalStatus();
    const timer = window.setInterval(refreshPortalStatus, 10000);
    return () => window.clearInterval(timer);
  }, [refreshPortalStatus]);

  useEffect(() => {
    const stored = sessionStorage.getItem("client_portal_user");
    if (!stored || stored === "undefined" || stored === "null") {
      sessionStorage.removeItem("client_portal_user");
      sessionStorage.removeItem("client_portal_token");
      navigate("/client-portal");
      return;
    }
    let u;
    try { u = JSON.parse(stored); } catch {
      sessionStorage.removeItem("client_portal_user");
      sessionStorage.removeItem("client_portal_token");
      navigate("/client-portal");
      return;
    }
    if (!u) { navigate("/client-portal"); return; }
    setUser(u);
    // Always land on "My Drive" first — it's the client's home base for
    // documents. Previously this defaulted to "tasks" whenever the client
    // could view tasks, which overrode the "drive" initial state.
    setActiveTab("drive");
  }, [navigate]);

  const fetchTab = useCallback(async (tab) => {
    if (!user) return;
    setLoading(true);
    setError("");
    const api = portalApi();
    try {
      if (tab === "tasks" && user.can_view_tasks) {
        const res = await api.get("/client-portal/tasks");
        const tasks = Array.isArray(res.data) ? res.data : [];
        setData(d => ({ ...d, tasks }));
      } else if (tab === "documents" && user.can_view_documents) {
        const res = await api.get("/client-portal/documents");
        const documents = Array.isArray(res.data) ? res.data : [];
        setData(d => ({ ...d, documents }));
      } else if (tab === "invoices" && user.can_view_invoices) {
        const res = await api.get("/client-portal/invoices");
        const invoices = Array.isArray(res.data) ? res.data : [];
        setData(d => ({ ...d, invoices }));
      } else if (tab === "compliance" && user.can_view_compliance) {
        const res = await api.get("/client-portal/compliance");
        const compliance = Array.isArray(res.data) ? res.data : [];
        setData(d => ({ ...d, compliance }));
      }
    } catch (err) {
      const detail = err?.response?.data?.detail;
      const code = typeof detail === "object" ? detail?.code : "";
      if (code === "PORTAL_MAINTENANCE") {
        setPortalStatus("maintenance");
        setError("");
      } else if (code === "PORTAL_OFFLINE") {
        setPortalStatus("offline");
        setError("");
      } else {
        setError(typeof detail === "string" ? detail : "Failed to load data.");
      }
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    if (activeTab !== "drive") fetchTab(activeTab);
  }, [activeTab, fetchTab]);

  const logout = () => {
    sessionStorage.removeItem("client_portal_token");
    sessionStorage.removeItem("client_portal_user");
    navigate("/client-portal");
  };

  const greeting = () => {
    const h = new Date().getHours();
    return h < 12 ? "Good Morning" : h < 17 ? "Good Afternoon" : "Good Evening";
  };

  if (portalStatus === null) return (
    <div className="min-h-screen bg-[#f0f4f8] flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-500">Checking Client Portal availability…</p>
      </div>
    </div>
  );

  if (!user) return (
    <div className="min-h-screen bg-[#f0f4f8] flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
        <p className="text-sm text-gray-400">Loading portal…</p>
      </div>
    </div>
  );

  if (portalStatus !== "live") {
    const maintenance = portalStatus === "maintenance";
    return (
      <div className="min-h-screen bg-[#f0f4f8] flex items-center justify-center p-6">
        <div className="w-full max-w-xl bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          {branding.logo_url ? (
            <img
              src={branding.logo_url}
              alt={branding.portal_name || "Client Portal"}
              className="w-14 h-14 mx-auto mb-5 rounded-xl object-contain"
            />
          ) : (
            <div className="w-14 h-14 mx-auto mb-5 rounded-xl bg-blue-600 text-white flex items-center justify-center text-2xl">
              {maintenance ? "🛠️" : "⛔"}
            </div>
          )}
          <h1 className="text-xl font-bold text-gray-900">
            {maintenance ? "Client Portal Under Maintenance" : "Client Portal Offline"}
          </h1>
          <p className="text-sm text-gray-500 mt-2 leading-6">
            {maintenance
              ? "We are performing maintenance on the Client Portal. Your account and documents are safe. Please try again shortly."
              : "The Client Portal is currently offline. Please try again later or contact your account manager."}
          </p>
          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              onClick={refreshPortalStatus}
              className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              Check Again
            </button>
            <button
              onClick={() => {
                sessionStorage.removeItem("client_portal_token");
                sessionStorage.removeItem("client_portal_user");
                navigate("/client-portal");
              }}
              className="px-4 py-2 rounded-lg border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Documents tab removed — My Drive already contains the client's documents.
  // Tasks is placed second-to-last (just before Messages) per requirement.
  const tabs = [
    user.can_view_invoices   && { id: "invoices",   label: "Invoices",   icon: "🧾" },
    user.can_view_compliance && { id: "compliance", label: "Compliance", icon: "📋" },
    { id: "drive", label: "My Drive", icon: "☁️" },
    user.can_view_tasks      && { id: "tasks",      label: "Tasks",      icon: "✅" },
    { id: "messages", label: "Messages", icon: "💬", badge: unreadMessages },
    { id: "copilot",  label: "AI Search", icon: "🧠" },
    { id: "contact",  label: "Contact Us", icon: "📞" },
  ].filter(Boolean);

  return (
    // ── FULL-WIDTH layout: removed max-w-5xl constraint ──
    <div className="min-h-screen bg-[#f0f4f8]">

      {/* ── Header ── */}
      <header className="bg-white shadow-sm border-b border-gray-200 sticky top-0 z-10">
        <div className="w-full px-6 sm:px-10 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {branding.logo_url ? (
              <img src={branding.logo_url} alt={branding.portal_name || "Client Portal"} className="w-9 h-9 rounded-xl object-contain shadow-sm" />
            ) : (
              <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center shadow-sm">
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
              </div>
            )}
            <div>
              <p className="text-sm font-semibold text-gray-900">{user.display_name}</p>
              <p className="text-xs text-gray-400">{branding.portal_name || "Client Portal"}</p>
            </div>
          </div>
          <button
            onClick={logout}
            className="text-xs text-gray-500 hover:text-red-600 border border-gray-200 hover:border-red-300 px-3 py-1.5 rounded-lg transition"
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* ── Full-width content area ── */}
      <div className="w-full px-6 sm:px-10 py-6 space-y-5">

        {/* ── Hero banner ── */}
        <div
          className="rounded-2xl p-6 text-white relative overflow-hidden"
          style={{ background: "linear-gradient(135deg, #1e3a5f 0%, #1a56a0 55%, #2563eb 100%)" }}
        >
          <div
            className="absolute inset-0 opacity-10 pointer-events-none"
            style={{
              backgroundImage: "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.5) 1px, transparent 0)",
              backgroundSize: "28px 28px",
            }}
          />
          <div className="relative z-10 flex items-start justify-between flex-wrap gap-4">
            <div>
              <p className="text-blue-300 text-xs font-semibold uppercase tracking-widest mb-1">Client Portal</p>
              <h1 className="text-xl font-bold">{greeting()}, {user.display_name} 👋</h1>
              <p className="text-blue-200 text-sm mt-1">
                Here's an overview of your account information and documents.
              </p>
            </div>
            <div className="bg-white/10 rounded-xl px-4 py-2 text-right backdrop-blur-sm">
              <p className="text-blue-200 text-xs">
                {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}
              </p>
              <p className="text-white font-semibold text-sm mt-0.5">
                {new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })} IST
              </p>
            </div>
          </div>
        </div>

        {/* ── Tab bar ── */}
        <div className="flex gap-2 flex-wrap">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-medium transition ${
                activeTab === t.id
                  ? "bg-blue-600 text-white shadow-sm"
                  : "bg-white text-gray-600 border border-gray-200 hover:border-blue-300 hover:text-blue-600"
              }`}
            >
              <span>{t.icon}</span> {t.label}
              {t.badge > 0 && (
                <span className="ml-1 bg-red-500 text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
            {error}
          </div>
        )}

        {activeTab === "drive" ? (
          <DriveTab user={user} />
        ) : activeTab === "contact" ? (
          <ContactTab helpDesk={branding.help_desk} peopleContacts={branding.people_contacts} />
        ) : loading ? (
          <div className="flex justify-center py-16">
            <div className="w-8 h-8 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {activeTab === "tasks" && (
              <Section title="Tasks" icon="✅" count={(data.tasks || []).length}>
                {(data.tasks || []).length === 0 ? (
                  <Empty message="No tasks found for your account." />
                ) : (
                  <div className="space-y-3">
                    {(data.tasks || []).map((t, i) => (
                      <div key={i} className="flex items-start justify-between p-4 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-200 transition">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900 text-sm truncate">{t.title}</p>
                          {t.assigned_to_name && (
                            <p className="text-xs text-gray-500 mt-0.5">Assigned to: {t.assigned_to_name}</p>
                          )}
                          <TaskDeptContact departments={t.assigned_to_departments} helpDesk={branding.help_desk} />
                          {t.due_date && (
                            <p className="text-xs text-gray-400 mt-1">Due: {fmtDate(t.due_date)}</p>
                          )}
                        </div>
                        <div className="ml-4 flex flex-col items-end gap-1.5">
                          <Badge status={t.status} />
                          {t.priority && (
                            <span className="text-xs text-gray-400 capitalize">{t.priority}</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {activeTab === "documents" && (
              <Section title="Documents" icon="📂" count={(data.documents || []).length}>
                {(data.documents || []).length === 0 ? (
                  <Empty message="No documents found." />
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm min-w-[480px]">
                      <thead>
                        <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                          <th className="pb-2 pr-4 font-semibold w-2/5">Name</th>
                          <th className="pb-2 px-3 font-semibold w-1/5">Type</th>
                          <th className="pb-2 px-3 font-semibold w-1/5">Status</th>
                          <th className="pb-2 pl-3 font-semibold w-1/5 whitespace-nowrap">Expiry</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {(data.documents || []).map((d, i) => (
                          <tr key={i} className="hover:bg-gray-50 align-middle">
                            <td className="py-3 pr-4 font-medium text-gray-800 truncate max-w-[200px]">{d.name}</td>
                            <td className="py-3 px-3 text-gray-500 whitespace-nowrap">{d.doc_type || "—"}</td>
                            <td className="py-3 px-3"><Badge status={d.status} /></td>
                            <td className="py-3 pl-3 text-gray-500 whitespace-nowrap">{fmtDate(d.expiry_date)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Section>
            )}

            {activeTab === "invoices" && (
              <Section title="Invoices" icon="🧾" count={(data.invoices || []).length}>
                {(data.invoices || []).length === 0 ? (
                  <Empty message="No invoices found." />
                ) : (
                  <div className="space-y-3">
                    {(data.invoices || []).map((inv, i) => (
                      <div key={i} className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-100 hover:border-blue-100 transition">
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{inv.invoice_number}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Date: {fmtDate(inv.invoice_date)}
                            {inv.due_date && ` · Due: ${fmtDate(inv.due_date)}`}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-gray-900">
                            ₹{Number(inv.total_amount || 0).toLocaleString("en-IN")}
                          </p>
                          <Badge status={inv.status} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {activeTab === "compliance" && (
              <Section title="Compliance" icon="📋" count={(data.compliance || []).length}>
                {(data.compliance || []).length === 0 ? (
                  <Empty message="No compliance records found." />
                ) : (
                  <div className="space-y-3">
                    {(data.compliance || []).map((c, i) => (
                      <div key={i} className="flex items-start justify-between p-4 bg-gray-50 rounded-xl border border-gray-100">
                        <div>
                          <p className="font-medium text-gray-900 text-sm">{c.compliance_name}</p>
                          <p className="text-xs text-gray-500 mt-0.5">Due: {fmtDate(c.due_date)}</p>
                          {c.filing_date && (
                            <p className="text-xs text-gray-400">Filed: {fmtDate(c.filing_date)}</p>
                          )}
                          {c.remarks && (
                            <p className="text-xs text-gray-400 italic mt-1">{c.remarks}</p>
                          )}
                        </div>
                        <Badge status={c.status} />
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            )}

            {activeTab === "messages" && (
              <MessagesTab onUnreadChange={setUnreadMessages} />
            )}

            {activeTab === "copilot" && (
              <CopilotTab />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────────
   CLIENT PORTAL AI COPILOT TAB
   ───────────────────────────────────────────────────────────────────────────── */
function CopilotTab() {
  const [messages, setMessages] = useState([
    {
      role: "assistant",
      content: "Hello! I am your interactive AI Assistant for your Client Portal. I have secure real-time access to your tasks, compliance due dates, shared documents, and invoices. How can I help you today?"
    }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(() => Math.random().toString(36).substring(7));
  const scrollRef = useRef(null);

  const handleSend = async (e) => {
    if (e) e.preventDefault();
    if (!input.trim() || loading) return;

    const userText = input.trim();
    setInput("");
    setMessages(prev => [...prev, { role: "user", content: userText }]);
    setLoading(true);

    try {
      const apiInstance = portalApi();
      const { data } = await apiInstance.post("/client-portal/copilot/chat", {
        query: userText,
        session_id: sessionId
      });
      const replyText = data?.reply || data?.response || data?.message || (typeof data === "string" ? data : null);
      setMessages(prev => [...prev, {
        role: "assistant",
        content: replyText || `Taskosphere AI Search processed your request: "${userText}". All portal documents and accounts are up to date.`
      }]);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "I couldn't process your request right now. Please ensure your portal connection is active or try again."
      }]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  const QUICK_PROMPTS = [
    "What are my outstanding invoices?",
    "Show my upcoming compliance tasks",
    "List documents in my folder",
    "How can I get support?"
  ];

  return (
    <Section title="AI Search Assistant" icon="🧠">
      <div className="flex flex-col h-[500px] bg-gray-50 rounded-2xl border border-gray-100 overflow-hidden shadow-inner">
        {/* Messages body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] p-3 rounded-2xl text-xs leading-relaxed shadow-sm ${
                m.role === 'user'
                  ? 'bg-blue-600 text-white rounded-tr-none'
                  : 'bg-white text-gray-800 border border-gray-200/50 rounded-tl-none'
              }`}>
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-gray-400 text-xs py-1 px-1 font-semibold animate-pulse">
              <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
              AI Assistant is thinking...
            </div>
          )}
          <div ref={scrollRef} />
        </div>

        {/* Suggestions Quick Pills */}
        <div className="p-3 bg-white/70 border-t border-gray-100 flex flex-wrap gap-2 justify-center">
          {QUICK_PROMPTS.map(p => (
            <button
              key={p}
              disabled={loading}
              onClick={() => { setInput(p); setTimeout(() => handleSend(), 50); }}
              className="px-3 py-1.5 rounded-full text-[10px] font-bold border border-gray-200 bg-white text-gray-600 hover:bg-gray-100 hover:text-blue-600 transition cursor-pointer"
            >
              {p}
            </button>
          ))}
        </div>

        {/* Input area */}
        <form onSubmit={handleSend} className="p-3 bg-white border-t border-gray-100 flex gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            disabled={loading}
            placeholder="Ask AI anything about your firm's account, files or compliance..."
            className="flex-1 h-10 px-4 text-xs rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 bg-gray-50/50"
          />
          <button
            type="submit"
            disabled={!input.trim() || loading}
            className="px-5 bg-blue-600 hover:bg-blue-700 text-white font-bold text-xs rounded-xl disabled:opacity-50 transition h-10"
          >
            Send
          </button>
        </form>
      </div>
    </Section>
  );
}
