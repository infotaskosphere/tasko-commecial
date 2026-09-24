/**
 * DriveIntegrations.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Multi-cloud-drive hub for Taskosphere.
 *
 * Features:
 *  • Google Drive — fully wired (OAuth via /auth/google/*)
 *  • OneDrive, Dropbox, Box — UI shown; "Coming Soon" state (ready to wire up)
 *  • Inline file browser for connected drives (Google Drive)
 *  • Share-to-download: generate a public shareable link for any file
 *  • Copy-to-clipboard share links
 *  • Dark mode aware
 *
 * Backend routes consumed (Google Drive):
 *   GET  BACKEND_URL/auth/google/status
 *   POST BACKEND_URL/auth/google/disconnect
 *   GET  BACKEND_URL/auth/google          (browser redirect, OAuth)
 *   GET  BACKEND_URL/auth/google/files    (list files in Drive)
 *   POST BACKEND_URL/auth/google/share    (create/get shareable link)
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  HardDrive, CheckCircle2, Loader2, Unplug, RefreshCw,
  FolderOpen, Share2, Download, Copy, Check,
  File, FileText, FileImage, Film, FileArchive,
  ChevronRight, ChevronDown, Search, X, Link2,
  AlertCircle, ExternalLink, CloudOff, Plus, ShieldCheck,
  Clock, HardDriveUpload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BACKEND_BASE_URL } from '@/lib/api';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const BACKEND_URL = BACKEND_BASE_URL;

function getAuthToken() {
  return localStorage.getItem('token') || sessionStorage.getItem('token');
}

async function authFetch(path, options = {}) {
  const token = getAuthToken();
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVE CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const DRIVES = [
  {
    id: 'google',
    name: 'Google Drive',
    tagline: 'Cloud storage integration',
    color: '#4285F4',
    gradient: 'linear-gradient(135deg, #4285F4 0%, #0D47A1 100%)',
    badge: '#34A853',
    available: true,
    icon: GoogleDriveIcon,
    features: [
      'Auto-save invoices & PDFs to your Drive folder',
      'Secure OAuth 2.0 — no passwords stored',
      'Browse & share Drive files with download links',
    ],
  },
  {
    id: 'onedrive',
    name: 'OneDrive',
    tagline: 'Microsoft cloud storage',
    color: '#0078D4',
    gradient: 'linear-gradient(135deg, #0078D4 0%, #003087 100%)',
    badge: '#0078D4',
    available: false,
    icon: OneDriveIcon,
    features: [
      'Sync files with Microsoft OneDrive',
      'Share documents directly from Office 365',
      'Auto-upload invoices & reports',
    ],
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    tagline: 'Simple cloud storage',
    color: '#0061FF',
    gradient: 'linear-gradient(135deg, #0061FF 0%, #0039A6 100%)',
    badge: '#0061FF',
    available: false,
    icon: DropboxIcon,
    features: [
      'Access & share Dropbox folders',
      'Auto-backup key documents',
      'Team folder collaboration',
    ],
  },
  {
    id: 'box',
    name: 'Box',
    tagline: 'Enterprise content management',
    color: '#0075CF',
    gradient: 'linear-gradient(135deg, #0075CF 0%, #004994 100%)',
    badge: '#0075CF',
    available: false,
    icon: BoxIcon,
    features: [
      'Secure enterprise file storage',
      'Compliance-ready document management',
      'Granular access controls',
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SVG ICONS (inline, no extra deps)
// ─────────────────────────────────────────────────────────────────────────────

function GoogleDriveIcon({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 87.3 78" className={className}>
      <path fill="#0066da" d="M6.6 66.85 3.3 72.9c-.7 1.2.2 2.6 1.6 2.6h20.1l3.5-8.7z" />
      <path fill="#00ac47" d="M81 75.5l-3.3-6.05-6.4-11.1H43.5l16.8 17.1z" />
      <path fill="#ea4335" d="M43.5 57.25l11.8-20.4-6.1-10.5L28.95 57.25z" />
      <path fill="#00832d" d="M63.7 45.3l-10.4 11.95h17.9l3.5 8.7H87l-3.3-5.7z" />
      <path fill="#2684fc" d="M24.95 75.5l-3.5-8.7H5.0L1.5 73.1l3.3 2.4z" />
      <path fill="#ffba00" d="M43.5 57.25H28.95L24.95 75.5h37.3z" />
      <path fill="#0066da" d="M25.2 26.55L12.5 48.95l6.45 8.3H43.5L55.3 36.9 43.5 15.35z" />
    </svg>
  );
}

function OneDriveIcon({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path fill="#0078D4" d="M14.5 6.5C13.2 4.4 10.9 3 8.3 3 4.3 3 1 6.1 1 10c0 .2 0 .4.1.6C.4 11.2 0 12.1 0 13c0 2.2 1.8 4 4 4h15c2.8 0 5-2.2 5-5 0-2.5-1.8-4.5-4.2-4.9-.3-1.5-1.3-2.7-2.5-3.4-.9-.4-1.9-.4-2.8-.2z" />
    </svg>
  );
}

function DropboxIcon({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path fill="#0061FF" d="M12 2.5L6 6l6 3.5L18 6zm-6 7L0 13l6 3.5 6-3.5zm12 0l-6 3.5 6 3.5 6-3.5zM6 16.5L0 20l6 1.5 6-1.5zm12 0l-6 3.5 6 1.5 6-1.5zM12 13.5l-6-3.5-6 3.5 6 3.5z" />
    </svg>
  );
}

function BoxIcon({ size = 24, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path fill="#0075CF" d="M0 8.5h2.5v7H0zm21.5 0H24v7h-2.5zM12 3c-2.8 0-5.1 1.9-5.8 4.5H3.7C4.5 3.6 7.9 1 12 1s7.5 2.6 8.3 6.5H17.8C17.1 4.9 14.8 3 12 3zm0 18c-2.8 0-5.1-1.9-5.8-4.5H3.7c.8 3.9 4.2 6.5 8.3 6.5s7.5-2.6 8.3-6.5H17.8c-.7 2.6-3 4.5-5.8 4.5z" />
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MIME → Icon/label/color
// ─────────────────────────────────────────────────────────────────────────────

const MIME_MAP = {
  'application/vnd.google-apps.folder':       { Icon: FolderOpen,   label: 'Folder',  color: '#F59E0B' },
  'application/vnd.google-apps.document':     { Icon: FileText,     label: 'Doc',     color: '#4285F4' },
  'application/vnd.google-apps.spreadsheet':  { Icon: FileText,     label: 'Sheet',   color: '#34A853' },
  'application/vnd.google-apps.presentation': { Icon: Film,         label: 'Slides',  color: '#FBBC04' },
  'application/pdf':                           { Icon: FileText,     label: 'PDF',     color: '#EA4335' },
  'image/jpeg':                                { Icon: FileImage,    label: 'Image',   color: '#EC4899' },
  'image/png':                                 { Icon: FileImage,    label: 'Image',   color: '#EC4899' },
  'application/zip':                           { Icon: FileArchive,  label: 'Archive', color: '#8B5CF6' },
  'video/mp4':                                 { Icon: Film,         label: 'Video',   color: '#0EA5E9' },
};

function getMimeMeta(mimeType) {
  return MIME_MAP[mimeType] || { Icon: File, label: 'File', color: '#64748B' };
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const n = Number(bytes);
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return ''; }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARE FILE MODAL
// ─────────────────────────────────────────────────────────────────────────────

function ShareFileModal({ file, onClose, isDark }) {
  const [loading, setLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  const generateLink = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFetch('/auth/google/share', {
        method: 'POST',
        body: JSON.stringify({ file_id: file.id }),
      });
      setShareUrl(data.share_url || data.web_view_link || data.web_content_link || '');
    } catch (err) {
      // Graceful fallback — construct standard Google Drive share URL
      setShareUrl(`https://drive.google.com/file/d/${file.id}/view?usp=sharing`);
      setError('Could not create server share link — using direct Drive link.');
    } finally {
      setLoading(false);
    }
  }, [file.id]);

  useEffect(() => {
    generateLink();
  }, []);

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl).then(() => {
      setCopied(true);
      toast.success('Share link copied!');
      setTimeout(() => setCopied(false), 2500);
    });
  };

  const card = isDark ? 'bg-slate-800 border-slate-700' : 'bg-white border-slate-200';
  const text = isDark ? 'text-slate-100' : 'text-slate-800';
  const muted = isDark ? 'text-slate-400' : 'text-slate-500';
  const inputCls = isDark
    ? 'bg-slate-900 border-slate-600 text-slate-200 placeholder-slate-500 focus:border-blue-500'
    : 'bg-slate-50 border-slate-200 text-slate-700 placeholder-slate-400 focus:border-blue-500';

  const { Icon, color } = getMimeMeta(file.mimeType);

  return (
    <AnimatePresence>
      {/* Backdrop — click outside to close */}
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(6,78,59,0.55)', backdropFilter: 'blur(4px)' }}
        onClick={onClose}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.93, y: 12 }}
          transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
          className={`w-full max-w-md rounded-2xl border shadow-2xl ${card}`}
          onClick={e => e.stopPropagation()}  // prevent backdrop close when clicking modal
        >
          {/* Header */}
          <div className={`flex items-center gap-3 px-5 py-4 border-b ${isDark ? 'border-slate-700' : 'border-slate-100'}`}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: `${color}18` }}>
              <Icon size={18} style={{ color }} />
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-bold truncate ${text}`}>{file.name}</p>
              <p className={`text-xs ${muted}`}>Share &amp; Download</p>
            </div>
            <button onClick={onClose} className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${isDark ? 'hover:bg-slate-700 text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}>
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="p-5 space-y-4">
            {/* Share URL */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className={`text-xs font-semibold uppercase tracking-wider ${muted}`}>Share Link</p>
                <button
                  onClick={generateLink}
                  disabled={loading}
                  className={`flex items-center gap-1 text-xs font-medium transition-colors ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'} disabled:opacity-50`}
                >
                  <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                  Refresh
                </button>
              </div>
              {error && (
                <p className={`text-[11px] mb-2 ${isDark ? 'text-amber-400' : 'text-amber-600'}`}>
                  ⚠ {error}
                </p>
              )}
              <div className="flex gap-2">
                {loading ? (
                  <div className={`flex-1 h-10 rounded-xl border flex items-center justify-center gap-2 ${isDark ? 'border-slate-600 bg-slate-900' : 'border-slate-200 bg-slate-50'}`}>
                    <Loader2 size={14} className="animate-spin text-blue-500" />
                    <span className={`text-xs ${muted}`}>Generating link…</span>
                  </div>
                ) : (
                  <input
                    ref={inputRef}
                    readOnly
                    value={shareUrl}
                    onClick={() => inputRef.current?.select()}
                    placeholder="Link will appear here…"
                    className={`flex-1 h-10 px-3 text-xs rounded-xl border outline-none transition-colors font-mono ${inputCls}`}
                  />
                )}
                <button
                  onClick={handleCopy}
                  disabled={!shareUrl || loading}
                  className="h-10 w-10 rounded-xl flex items-center justify-center border transition-all disabled:opacity-40"
                  style={shareUrl && !loading ? { background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)', border: 'none' } : {}}
                  title="Copy to clipboard"
                >
                  {copied
                    ? <Check size={16} className="text-white" />
                    : <Copy size={16} className={shareUrl && !loading ? 'text-white' : (isDark ? 'text-slate-400' : 'text-slate-500')} />
                  }
                </button>
              </div>
              <p className={`text-[10px] mt-1.5 ${muted}`}>
                Anyone with this link can view the file · Access can be revoked from Google Drive settings
              </p>
            </div>

            {/* Direct Download */}
            <div className={`flex items-center gap-3 p-3 rounded-xl border ${isDark ? 'border-slate-700 bg-slate-900/40' : 'border-slate-100 bg-slate-50'}`}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: 'rgba(16,185,129,0.12)' }}>
                <Download size={15} className="text-emerald-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-xs font-semibold ${text}`}>Direct Download</p>
                <p className={`text-[11px] ${muted}`}>Opens file or downloads directly</p>
              </div>
              <a
                href={`https://drive.google.com/uc?export=download&id=${file.id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="h-8 px-3 rounded-lg flex items-center gap-1.5 text-xs font-semibold text-white transition-all hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#059669,#10B981)' }}
              >
                <Download size={12} />
                Download
              </a>
            </div>

            {/* View in Drive */}
            <a
              href={`https://drive.google.com/file/d/${file.id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className={`flex items-center gap-2 text-xs font-medium transition-colors ${isDark ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
            >
              <ExternalLink size={12} />
              Open in Google Drive
            </a>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE ROW
// ─────────────────────────────────────────────────────────────────────────────

function FileRow({ file, isDark, onShare }) {
  const { Icon, color } = getMimeMeta(file.mimeType);
  const isFolder = file.mimeType === 'application/vnd.google-apps.folder';
  const text = isDark ? 'text-slate-200' : 'text-slate-700';
  const muted = isDark ? 'text-slate-500' : 'text-slate-400';

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      className={`flex items-center gap-3 px-3 py-2.5 rounded-xl group transition-colors ${isDark ? 'hover:bg-slate-700/50' : 'hover:bg-slate-50'}`}
    >
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}18` }}>
        <Icon size={16} style={{ color }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium truncate ${text}`}>{file.name}</p>
        <p className={`text-[10px] flex items-center gap-2 ${muted}`}>
          {getMimeMeta(file.mimeType).label}
          {file.size && <span>· {fmtSize(file.size)}</span>}
          {file.modifiedTime && <span>· {fmtDate(file.modifiedTime)}</span>}
        </p>
      </div>
      {!isFolder && (
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onShare(file)}
            className={`h-7 w-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'hover:bg-slate-600 text-slate-400 hover:text-slate-200' : 'hover:bg-slate-200 text-slate-500 hover:text-slate-700'}`}
            title="Share / Download"
          >
            <Share2 size={13} />
          </button>
          <a
            href={`https://drive.google.com/uc?export=download&id=${file.id}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className={`h-7 w-7 rounded-lg flex items-center justify-center transition-colors ${isDark ? 'hover:bg-slate-600 text-slate-400 hover:text-slate-200' : 'hover:bg-slate-200 text-slate-500 hover:text-slate-700'}`}
            title="Quick Download"
          >
            <Download size={13} />
          </a>
        </div>
      )}
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE DRIVE PANEL
// ─────────────────────────────────────────────────────────────────────────────

function GoogleDrivePanel({ isDark, expanded, onToggle }) {
  const [statusLoading, setStatusLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState('');
  const [search, setSearch] = useState('');
  const [showFiles, setShowFiles] = useState(false);
  const [shareFile, setShareFile] = useState(null);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const d = await authFetch('/auth/google/status');
      setConnected(!!d.connected);
    } catch {
      setConnected(false);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const handleConnect = () => {
    window.location.href = `${BACKEND_URL}/auth/google`;
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await authFetch('/auth/google/disconnect', { method: 'POST' });
      setConnected(false);
      setShowFiles(false);
      setFiles([]);
      toast.success('Google Drive disconnected');
    } catch (err) {
      toast.error(`Disconnect failed: ${err.message}`);
    } finally {
      setDisconnecting(false);
    }
  };

  const loadFiles = useCallback(async () => {
    setFilesLoading(true);
    setFilesError('');
    try {
      const data = await authFetch('/auth/google/files');
      setFiles(Array.isArray(data.files) ? data.files : []);
    } catch (err) {
      setFilesError(err.message || 'Failed to load files');
      setFiles([]);
    } finally {
      setFilesLoading(false);
    }
  }, []);

  const toggleFiles = () => {
    if (!showFiles) loadFiles();
    setShowFiles(v => !v);
  };

  const filteredFiles = files.filter(f =>
    !search || f.name?.toLowerCase().includes(search.toLowerCase())
  );

  const D = isDark;
  const card = D ? 'bg-slate-800/60 border-slate-700' : 'bg-white border-slate-200';
  const text = D ? 'text-slate-100' : 'text-slate-800';
  const muted = D ? 'text-slate-400' : 'text-slate-500';

  return (
    <>
      <div className={`rounded-2xl border overflow-hidden transition-all ${card} ${expanded ? 'shadow-lg' : 'shadow-sm'}`}>
        {/* Drive header */}
        <div
          className={`flex items-center gap-4 p-4 cursor-pointer transition-colors ${D ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50/80'}`}
          onClick={onToggle}
        >
          <div className="w-12 h-12 rounded-2xl flex items-center justify-center flex-shrink-0 shadow-sm" style={{ background: 'linear-gradient(135deg,#4285F4,#0D47A1)' }}>
            <GoogleDriveIcon size={26} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p className={`text-sm font-bold ${text}`}>Google Drive</p>
              {statusLoading ? (
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${D ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                  <Loader2 size={10} className="animate-spin" />Checking…
                </span>
              ) : connected ? (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  Connected
                </span>
              ) : (
                <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold ${D ? 'bg-slate-700 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                  <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                  Not connected
                </span>
              )}
            </div>
            <p className={`text-xs mt-0.5 ${muted}`}>Cloud storage integration</p>
          </div>
          <div className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
            <ChevronRight size={16} className={muted} />
          </div>
        </div>

        {/* Expanded content */}
        <AnimatePresence>
          {expanded && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
              className="overflow-hidden"
            >
              <div className={`border-t px-4 pb-4 pt-4 space-y-4 ${D ? 'border-slate-700' : 'border-slate-100'}`}>
                {/* Features */}
                <div className="space-y-2">
                  {[
                    { icon: HardDriveUpload, text: 'Auto-save invoices & PDFs to your Drive folder' },
                    { icon: ShieldCheck, text: 'Secure OAuth 2.0 — no passwords stored' },
                    { icon: Share2, text: 'Browse, share & download files with one click' },
                  ].map(({ icon: Icon, text: t }) => (
                    <div key={t} className="flex items-start gap-2.5">
                      <div className="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: 'rgba(66,133,244,0.12)' }}>
                        <Icon size={12} style={{ color: '#4285F4' }} />
                      </div>
                      <p className={`text-xs leading-relaxed pt-0.5 ${muted}`}>{t}</p>
                    </div>
                  ))}
                </div>

                {/* Status banner */}
                {connected && (
                  <div className={`flex items-center gap-2.5 p-3 rounded-xl border ${D ? 'border-emerald-800/40 bg-emerald-900/20' : 'border-emerald-200 bg-emerald-50'}`}>
                    <CheckCircle2 size={16} className="text-emerald-500 flex-shrink-0" />
                    <div>
                      <p className={`text-xs font-semibold ${D ? 'text-emerald-400' : 'text-emerald-700'}`}>Drive is active and ready</p>
                      <p className={`text-[11px] ${D ? 'text-emerald-500/80' : 'text-emerald-600/80'}`}>Token stored securely. Invoice uploads and file sharing are enabled.</p>
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2">
                  {!connected ? (
                    <Button
                      onClick={handleConnect}
                      disabled={statusLoading}
                      className="h-9 px-5 rounded-xl text-sm font-semibold text-white gap-2 shadow-sm"
                      style={{ background: 'linear-gradient(135deg,#4285F4,#0D47A1)' }}
                    >
                      <GoogleDriveIcon size={16} />
                      Connect Google Drive
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={toggleFiles}
                        variant="outline"
                        className={`h-9 px-4 rounded-xl text-sm gap-2 ${D ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                      >
                        <FolderOpen size={14} />
                        {showFiles ? 'Hide Files' : 'Browse Files'}
                        {showFiles ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </Button>
                      <Button
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                        variant="outline"
                        className={`h-9 px-4 rounded-xl text-sm gap-2 ${D ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                        {disconnecting ? <Loader2 size={14} className="animate-spin" /> : <Unplug size={14} />}
                        Disconnect
                      </Button>
                      <Button
                        onClick={handleConnect}
                        variant="outline"
                        className={`h-9 px-4 rounded-xl text-sm gap-2 ${D ? 'border-slate-600 text-slate-300 hover:bg-slate-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                      >
                        <RefreshCw size={14} />
                        Reconnect
                      </Button>
                      <button
                        onClick={fetchStatus}
                        disabled={statusLoading}
                        className={`h-9 w-9 rounded-xl border flex items-center justify-center transition-colors ${D ? 'border-slate-600 text-slate-400 hover:bg-slate-700' : 'border-slate-200 text-slate-400 hover:bg-slate-50'}`}
                        title="Refresh status"
                      >
                        <RefreshCw size={14} className={statusLoading ? 'animate-spin' : ''} />
                      </button>
                    </>
                  )}
                </div>

                {/* File browser */}
                <AnimatePresence>
                  {showFiles && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.22 }}
                      className="overflow-hidden"
                    >
                      <div className={`rounded-xl border ${D ? 'border-slate-700 bg-slate-900/40' : 'border-slate-200 bg-slate-50'}`}>
                        {/* Search */}
                        <div className={`flex items-center gap-2 px-3 py-2 border-b ${D ? 'border-slate-700' : 'border-slate-200'}`}>
                          <Search size={13} className={muted} />
                          <input
                            type="text"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            placeholder="Search files…"
                            className={`flex-1 bg-transparent text-xs outline-none ${D ? 'text-slate-200 placeholder-slate-500' : 'text-slate-700 placeholder-slate-400'}`}
                          />
                          {search && <button onClick={() => setSearch('')}><X size={12} className={muted} /></button>}
                          <button onClick={loadFiles} title="Refresh files">
                            <RefreshCw size={12} className={`${filesLoading ? 'animate-spin' : ''} ${muted}`} />
                          </button>
                        </div>

                        {/* File list */}
                        <div className="p-2 max-h-72 overflow-y-auto">
                          {filesLoading ? (
                            <div className="flex items-center justify-center py-8 gap-2">
                              <Loader2 size={16} className="animate-spin text-blue-500" />
                              <span className={`text-xs ${muted}`}>Loading files…</span>
                            </div>
                          ) : filesError ? (
                            <div className="flex flex-col items-center justify-center py-8 gap-2">
                              <AlertCircle size={20} className="text-red-400" />
                              <p className={`text-xs ${muted} text-center max-w-[200px]`}>{filesError}</p>
                              <button onClick={loadFiles} className="text-xs text-blue-500 hover:underline">Retry</button>
                            </div>
                          ) : filteredFiles.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-8 gap-2">
                              <CloudOff size={20} className={muted} />
                              <p className={`text-xs ${muted}`}>{search ? 'No matching files' : 'No files found'}</p>
                            </div>
                          ) : (
                            <AnimatePresence>
                              {filteredFiles.map(f => (
                                <FileRow key={f.id} file={f} isDark={D} onShare={setShareFile} />
                              ))}
                            </AnimatePresence>
                          )}
                        </div>

                        {/* Footer */}
                        {filteredFiles.length > 0 && (
                          <div className={`px-3 py-2 border-t flex items-center justify-between ${D ? 'border-slate-700' : 'border-slate-200'}`}>
                            <p className={`text-[10px] ${muted}`}>{filteredFiles.length} item{filteredFiles.length !== 1 ? 's' : ''}</p>
                            <a
                              href="https://drive.google.com"
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`text-[10px] flex items-center gap-1 font-medium ${D ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
                            >
                              Open Drive <ExternalLink size={10} />
                            </a>
                          </div>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Footer note */}
                <p className={`text-[10px] border-t pt-3 ${D ? 'border-slate-700 text-slate-500' : 'border-slate-100 text-slate-400'}`}>
                  After connecting, also set <strong>GOOGLE_REFRESH_TOKEN</strong> in your Render environment variables for persistence across server restarts.
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Share modal */}
      {shareFile && (
        <ShareFileModal
          file={shareFile}
          isDark={isDark}
          onClose={() => setShareFile(null)}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMING-SOON DRIVE CARD
// ─────────────────────────────────────────────────────────────────────────────

function ComingSoonDriveCard({ drive, isDark }) {
  const D = isDark;
  const card = D ? 'bg-slate-800/40 border-slate-700' : 'bg-slate-50/60 border-slate-200';
  const text = D ? 'text-slate-300' : 'text-slate-600';
  const muted = D ? 'text-slate-500' : 'text-slate-400';
  const Icon = drive.icon;

  return (
    <div className={`rounded-2xl border p-4 opacity-80 ${card}`}>
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm" style={{ background: drive.gradient }}>
          <Icon size={22} className="text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className={`text-sm font-bold ${text}`}>{drive.name}</p>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${D ? 'bg-slate-700 text-slate-400' : 'bg-slate-200 text-slate-500'}`}>
              Coming Soon
            </span>
          </div>
          <p className={`text-xs mt-0.5 ${muted}`}>{drive.tagline}</p>
          <div className="mt-2 space-y-1.5">
            {drive.features.map(f => (
              <div key={f} className="flex items-center gap-1.5">
                <span className={`w-1 h-1 rounded-full flex-shrink-0 ${D ? 'bg-slate-600' : 'bg-slate-300'}`} />
                <p className={`text-[11px] ${muted}`}>{f}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          disabled
          className={`h-8 px-4 rounded-xl text-xs font-semibold border flex items-center gap-1.5 cursor-not-allowed ${D ? 'border-slate-700 text-slate-500 bg-slate-800' : 'border-slate-200 text-slate-400 bg-white'}`}
        >
          <Clock size={12} />
          Coming Soon
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────

export default function DriveIntegrations({ isDark }) {
  const [expandedDrive, setExpandedDrive] = useState('google');

  return (
    <div className="space-y-3">
      {/* Section label */}
      <div className="flex items-center gap-2 mb-4">
        <div className="w-6 h-6 rounded-lg flex items-center justify-center" style={{ background: 'rgba(66,133,244,0.12)' }}>
          <HardDrive size={13} style={{ color: '#4285F4' }} />
        </div>
        <div>
          <p className={`text-sm font-bold ${isDark ? 'text-slate-100' : 'text-slate-800'}`}>Cloud Drives</p>
          <p className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Connect storage providers to sync and share files</p>
        </div>
      </div>

      {/* Google Drive — fully functional */}
      <GoogleDrivePanel
        isDark={isDark}
        expanded={expandedDrive === 'google'}
        onToggle={() => setExpandedDrive(v => v === 'google' ? '' : 'google')}
      />

      {/* Coming soon drives */}
      <div className="grid grid-cols-1 gap-3">
        {DRIVES.filter(d => !d.available).map(drive => (
          <ComingSoonDriveCard key={drive.id} drive={drive} isDark={isDark} />
        ))}
      </div>
    </div>
  );
}
