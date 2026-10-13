// =============================================================================
// WhatsAppSettings.jsx — Multi-number WhatsApp Web + Message Templates
// =============================================================================
//
// FIX SUMMARY (429 Too Many Requests / 502 Bad Gateway on Render free tier)
// ─────────────────────────────────────────────────────────────────────────────
// Root cause: the old code polled the wa-bridge far too aggressively.
//   • ConnectedNumbersTab polled /sessions every 8 s — any open tab hammered
//     the bridge constantly, causing 429 rate-limit responses.
//   • QRModal polled the QR endpoint every 3 s — even more aggressive.
//   • No pause when the browser tab was hidden/background.
//   • No backoff after a 429 — the next poll still fired at the normal rate.
//
// Changes in this file:
//   1. ConnectedNumbersTab: interval 8 s → 30 s.
//   2. ConnectedNumbersTab: polling paused when tab is hidden (visibilitychange).
//   3. ConnectedNumbersTab: exponential backoff (up to 120 s) after a 429.
//   4. QRModal: interval 3 s → 6 s.
//   5. QRModal: exponential backoff after a 429.
//   6. Updated the "QR refreshes every N seconds" hint to match new interval.
// =============================================================================

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useDark } from "@/hooks/useDark";
import { useAuth } from "@/contexts/AuthContext";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  MessageCircle, Settings, Save, CheckCircle2, FileText, Users,
  Shield, Key, Eye, Building2, Plus, Trash2, Smartphone, QrCode,
  Wifi, WifiOff, RefreshCw, Link, Unlink, ChevronRight, AlertCircle,
  Pencil, Check, X, Phone, Hash, Copy, ShieldCheck,
  Clock, Calendar, Send, Cake, Power, Sparkles, Loader2,
} from "lucide-react";
import { getWASettings, saveWASettings } from "@/hooks/useWhatsApp";
import api from "@/lib/api";
import { normalizeCompanies } from "@/lib/companies";

// ─── Brand colours ────────────────────────────────────────────────────────────
const EMERALD   = "#128C7E";
const GREEN     = "#25D366";
const GRADIENT  = `linear-gradient(135deg, ${EMERALD} 0%, ${GREEN} 100%)`;
const GRAD_BTN  = `linear-gradient(135deg, ${EMERALD}, ${GREEN})`;

// ─── Templates ────────────────────────────────────────────────────────────────
const TEMPLATES = [
  { key: "invoiceTemplate",  label: "Invoice Reminder", vars: "{number}  {amount}  {due_date}  {status}", icon: FileText, color: "#3b82f6", pk: "invoice",  sample: { number: "INV-2024-001", amount: "25,000.00", due_date: "31 May 2026", status: "PENDING" } },
  { key: "clientTemplate",   label: "Client Message",   vars: "{name}  {firm}  {message}",                icon: Users,    color: "#8b5cf6", pk: "client",   sample: { name: "Infosys Ltd", firm: "Your CA Firm", message: "Reminder about pending compliance." } },
  { key: "dscTemplate",      label: "DSC Expiry Alert", vars: "{holder}  {expiry}  {days}",               icon: Shield,   color: "#f59e0b", pk: "dsc",      sample: { holder: "John Doe", expiry: "15 Jun 2026", days: "22" } },
  { key: "passwordTemplate", label: "Password Share",   vars: "{portal}  {username}  {password}",         icon: Key,      color: "#ef4444", pk: "password", sample: { portal: "GST Portal", username: "user@firm.com", password: "••••••••" } },
];

function buildPreviewText(settings, pk) {
  const lines = [];
  if (settings.includeGreeting) { lines.push((settings.greetingTemplate || "Dear {name},").replace("{name}", "Valued Client")); lines.push(""); }
  if (settings.firmName) { lines.push("*" + settings.firmName + "*" + (settings.firmTagline ? " | " + settings.firmTagline : "")); lines.push(""); }
  const tpl = TEMPLATES.find(t => t.pk === pk);
  if (tpl) {
    let msg = settings[tpl.key] || "";
    Object.entries(tpl.sample).forEach(([k, v]) => { msg = msg.replace(new RegExp(`\\{${k}\\}`, "g"), v); });
    lines.push(msg);
  }
  if (settings.includeFooter && settings.footerNote) { lines.push(""); lines.push(settings.footerNote); }
  return lines.join("\n");
}

function Toggle({ on, onChange, isDark }) {
  return (
    <div onClick={() => onChange(!on)} style={{ width: 40, height: 22, borderRadius: 11, cursor: "pointer", background: on ? GREEN : (isDark ? "#334155" : "#cbd5e1"), position: "relative", transition: "background 0.2s", flexShrink: 0 }}>
      <div style={{ position: "absolute", top: 3, left: on ? 20 : 3, width: 16, height: 16, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
    </div>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    connected:     { label: "Connected",     color: "#22c55e", bg: "#dcfce7" },
    awaiting_scan: { label: "Scan QR",       color: "#f59e0b", bg: "#fef3c7" },
    connecting:    { label: "Connecting…",   color: "#6366f1", bg: "#ede9fe" },
    reconnecting:  { label: "Reconnecting",  color: "#f97316", bg: "#ffedd5" },
    disconnected:  { label: "Disconnected",  color: "#ef4444", bg: "#fee2e2" },
  };
  const s = map[status] || { label: status || "Unknown", color: "#6b7280", bg: "#f3f4f6" };
  return (
    <span style={{ background: s.bg, color: s.color, padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
      {s.label}
    </span>
  );
}

// ─── QR Modal ─────────────────────────────────────────────────────────────────
// FIX: interval increased from 3 s → 6 s; exponential backoff on 429.
const QR_POLL_BASE_MS = 6000;

function QRModal({ sessionId, label, onClose, isDark }) {
  const [qr, setQr]         = useState(null);
  const [status, setStatus] = useState("loading");
  const pollRef             = useRef(null);
  const backoffRef          = useRef(QR_POLL_BASE_MS);

  const scheduleNext = useCallback((delayMs) => {
    clearTimeout(pollRef.current);
    pollRef.current = setTimeout(() => fetchQR(), delayMs); // eslint-disable-line
  }, []); // eslint-disable-line

  const fetchQR = useCallback(async () => {
    try {
      const { data } = await api.get(`/whatsapp/sessions/${sessionId}/qr`);
      backoffRef.current = QR_POLL_BASE_MS;
      if (data.status === "connected") {
        setStatus("connected");
        clearTimeout(pollRef.current);
        setTimeout(onClose, 1500);
        return;
      }
      if (data.qr) { setQr(data.qr); setStatus("ready"); }
      else         { setStatus(data.status || "waiting"); }
      scheduleNext(QR_POLL_BASE_MS);
    } catch (err) {
      const statusCode = err?.response?.status;
      if (statusCode === 429) {
        // Back off: double the current interval, cap at 60 s
        backoffRef.current = Math.min(backoffRef.current * 2, 60000);
        scheduleNext(backoffRef.current);
      } else {
        setStatus("error");
      }
    }
  }, [sessionId, onClose, scheduleNext]);

  useEffect(() => {
    fetchQR();
    return () => clearTimeout(pollRef.current);
  }, [fetchQR]);

  const card  = isDark ? "#1e293b" : "#fff";
  const muted = isDark ? "#94a3b8" : "#64748b";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(6,78,59,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }} onClick={onClose}>
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ background: card, borderRadius: 20, padding: 32, maxWidth: 380, width: "90%", boxShadow: "0 24px 80px rgba(0,0,0,0.3)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: isDark ? "#f1f5f9" : "#0f172a" }}>Scan QR Code</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: muted }}>{label}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: muted, padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ background: isDark ? "#0f172a" : "#f8fafc", borderRadius: 16, padding: 20, display: "flex", alignItems: "center", justifyContent: "center", minHeight: 280, flexDirection: "column", gap: 12 }}>
          {status === "connected" && (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ textAlign: "center" }}>
              <CheckCircle2 size={56} color="#22c55e" />
              <p style={{ color: "#22c55e", fontWeight: 700, marginTop: 12 }}>Connected!</p>
            </motion.div>
          )}
          {status === "ready" && qr && (
            <motion.img key={qr} initial={{ opacity: 0 }} animate={{ opacity: 1 }} src={qr} alt="WhatsApp QR" style={{ width: 220, height: 220, borderRadius: 8 }} />
          )}
          {(status === "loading" || status === "connecting" || status === "waiting") && (
            <div style={{ textAlign: "center" }}>
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}>
                <RefreshCw size={36} color={GREEN} />
              </motion.div>
              <p style={{ color: muted, fontSize: 13, marginTop: 12 }}>
                {status === "loading" ? "Loading QR code…" : "Waiting for QR code…"}
              </p>
            </div>
          )}
          {status === "error" && (
            <div style={{ textAlign: "center" }}>
              <AlertCircle size={36} color="#ef4444" />
              <p style={{ color: "#ef4444", fontSize: 13, marginTop: 8 }}>Failed to load QR</p>
              <button onClick={fetchQR} style={{ marginTop: 8, background: GRAD_BTN, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13 }}>Retry</button>
            </div>
          )}
        </div>

        {status === "ready" && (
          <p style={{ textAlign: "center", fontSize: 12, color: muted, marginTop: 16, lineHeight: 1.6 }}>
            Open WhatsApp on your phone → Linked Devices → Link a Device → Scan this QR code
          </p>
        )}

        <p style={{ textAlign: "center", fontSize: 11, color: muted, marginTop: 8 }}>
          QR refreshes automatically every 6 seconds
        </p>
      </motion.div>
    </div>
  );
}

// ─── Pairing Code Modal ───────────────────────────────────────────────────────
const PAIR_POLL_BASE_MS = 4000;

function PairCodeModal({ sessionId, label, onClose, isDark }) {
  const [code,   setCode]   = useState(null);
  const [status, setStatus] = useState("loading");
  const [copied, setCopied] = useState(false);
  const pollRef             = useRef(null);
  const backoffRef          = useRef(PAIR_POLL_BASE_MS);

  const scheduleNext = useCallback((ms) => {
    clearTimeout(pollRef.current);
    pollRef.current = setTimeout(() => fetchCode(), ms); // eslint-disable-line
  }, []); // eslint-disable-line

  const fetchCode = useCallback(async () => {
    try {
      const { data } = await api.get(`/whatsapp/sessions/${sessionId}/pair-code`);
      backoffRef.current = PAIR_POLL_BASE_MS;
      if (data.status === "connected") { setStatus("connected"); clearTimeout(pollRef.current); setTimeout(onClose, 1500); return; }
      if (data.code) { setCode(data.code); setStatus("ready"); }
      else           { setStatus(data.status || "waiting"); }
      scheduleNext(PAIR_POLL_BASE_MS);
    } catch (err) {
      if (err?.response?.status === 429) {
        backoffRef.current = Math.min(backoffRef.current * 2, 30000);
        scheduleNext(backoffRef.current);
      } else { setStatus("error"); }
    }
  }, [sessionId, onClose, scheduleNext]);

  useEffect(() => { fetchCode(); return () => clearTimeout(pollRef.current); }, [fetchCode]);

  const handleCopy = () => { if (code) { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 2000); } };

  const card  = isDark ? "#1e293b" : "#fff";
  const muted = isDark ? "#94a3b8" : "#64748b";

  // Format code as XXXX-XXXX
  const formatted = code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(6,78,59,0.6)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", backdropFilter: "blur(4px)" }} onClick={onClose}>
      <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} style={{ background: card, borderRadius: 20, padding: 32, maxWidth: 400, width: "90%", boxShadow: "0 24px 80px rgba(0,0,0,0.3)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: isDark ? "#f1f5f9" : "#0f172a" }}>Phone Pairing Code</h3>
            <p style={{ margin: "4px 0 0", fontSize: 12, color: muted }}>{label}</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: muted, padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ background: isDark ? "#0f172a" : "#f8fafc", borderRadius: 16, padding: 24, minHeight: 200, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16 }}>
          {status === "connected" && (
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ textAlign: "center" }}>
              <CheckCircle2 size={56} color="#22c55e" />
              <p style={{ color: "#22c55e", fontWeight: 700, marginTop: 12 }}>Connected!</p>
            </motion.div>
          )}
          {status === "ready" && formatted && (
            <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} style={{ textAlign: "center", width: "100%" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 8 }}>
                <Hash size={20} color={GREEN} />
                <span style={{ fontSize: 13, fontWeight: 600, color: muted }}>Your Pairing Code</span>
              </div>
              <div style={{ fontSize: 38, fontWeight: 900, letterSpacing: "0.12em", color: isDark ? "#f1f5f9" : "#0f172a", fontFamily: "monospace", marginBottom: 16 }}>
                {formatted}
              </div>
              <button onClick={handleCopy} style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 auto", background: copied ? "#22c55e22" : GRAD_BTN, color: copied ? "#22c55e" : "#fff", border: copied ? "1.5px solid #22c55e" : "none", borderRadius: 10, padding: "10px 20px", cursor: "pointer", fontSize: 13, fontWeight: 700, transition: "all 0.2s" }}>
                {copied ? <><Check size={14} /> Copied!</> : <><Copy size={14} /> Copy Code</>}
              </button>
            </motion.div>
          )}
          {(status === "loading" || status === "connecting" || status === "waiting") && (
            <div style={{ textAlign: "center" }}>
              <motion.div animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1, ease: "linear" }}>
                <RefreshCw size={36} color={GREEN} />
              </motion.div>
              <p style={{ color: muted, fontSize: 13, marginTop: 12 }}>Generating pairing code…</p>
            </div>
          )}
          {status === "error" && (
            <div style={{ textAlign: "center" }}>
              <AlertCircle size={36} color="#ef4444" />
              <p style={{ color: "#ef4444", fontSize: 13, marginTop: 8 }}>Failed to get pairing code</p>
              <button onClick={fetchCode} style={{ marginTop: 8, background: GRAD_BTN, color: "#fff", border: "none", borderRadius: 8, padding: "8px 16px", cursor: "pointer", fontSize: 13 }}>Retry</button>
            </div>
          )}
        </div>

        {status === "ready" && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 12, color: muted, lineHeight: 1.7, margin: 0 }}>
              <strong style={{ color: isDark ? "#e2e8f0" : "#334155" }}>Steps:</strong><br />
              1. Open WhatsApp on your phone<br />
              2. Go to <strong>Linked Devices</strong> → <strong>Link a Device</strong><br />
              3. Tap <strong>"Link with phone number instead"</strong><br />
              4. Enter your phone number, then type the code above
            </p>
          </div>
        )}
      </motion.div>
    </div>
  );
}

// ─── Connected Numbers Tab ────────────────────────────────────────────────────
// FIX: interval 8 s → 30 s; paused when tab is hidden; exponential backoff on 429.
const SESSIONS_POLL_MS = 30000;

function ConnectedNumbersTab({ isDark }) {
  const [sessions,    setSessions]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [newLabel,    setNewLabel]    = useState("");
  const [newPhone,    setNewPhone]    = useState("");
  const [authMode,    setAuthMode]    = useState("qr");   // "qr" | "phone"
  const [adding,      setAdding]      = useState(false);
  const [qrSession,   setQrSession]   = useState(null);
  const [pairSession, setPairSession] = useState(null);
  const [editingId,   setEditingId]   = useState(null);
  const [editLabel,   setEditLabel]   = useState("");
  const [deletingId,  setDeletingId]  = useState(null);

  const backoffRef  = useRef(SESSIONS_POLL_MS);
  const timerRef    = useRef(null);

  const card   = isDark ? "bg-slate-800 border-slate-700"  : "bg-white border-slate-200";
  const inner  = isDark ? "bg-slate-900 border-slate-700"  : "bg-slate-50 border-slate-200";
  const txt    = isDark ? "text-slate-100"                  : "text-slate-800";
  const muted  = isDark ? "text-slate-400"                  : "text-slate-500";
  const inputC = ["w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-400 transition",
                   isDark ? "bg-slate-900 border-slate-700 text-slate-100 placeholder-slate-600" : "bg-white border-slate-300 text-slate-800 placeholder-slate-400"].join(" ");

  const fetchSessions = useCallback(async () => {
    if (document.hidden) return;
    setLoading(true);
    try {
      const { data } = await api.get("/whatsapp/sessions");
      backoffRef.current = SESSIONS_POLL_MS;
      setSessions(data.sessions || []);
    } catch (err) {
      const statusCode = err?.response?.status;
      if (statusCode === 429) {
        backoffRef.current = Math.min(backoffRef.current * 2, 120000);
      } else {
        toast.error("Could not reach WhatsApp bridge — is wa-bridge running?");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSessions();
    const schedule = () => {
      timerRef.current = setTimeout(async () => { await fetchSessions(); schedule(); }, backoffRef.current);
    };
    schedule();
    const onVisibility = () => {
      if (!document.hidden) { clearTimeout(timerRef.current); fetchSessions().then(schedule); }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { clearTimeout(timerRef.current); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchSessions]);

  const handleAddSession = async () => {
    if (!newLabel.trim()) { toast.error("Enter a label for this number"); return; }
    if (authMode === "phone" && !newPhone.trim()) { toast.error("Enter the phone number with country code"); return; }
    setAdding(true);
    try {
      const payload = { label: newLabel.trim() };
      if (authMode === "phone") payload.pairing_phone = newPhone.replace(/\D/g, "");
      const { data } = await api.post("/whatsapp/sessions", payload);
      toast.success(authMode === "phone" ? "Session started — get your pairing code!" : "Session started — scan the QR code!");
      setNewLabel(""); setNewPhone("");
      await fetchSessions();
      if (authMode === "phone") setPairSession({ sessionId: data.sessionId, label: data.label || newLabel });
      else                      setQrSession(  { sessionId: data.sessionId, label: data.label || newLabel });
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to start session");
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (sessionId) => {
    setDeletingId(sessionId);
    try {
      await api.delete(`/whatsapp/sessions/${sessionId}`);
      toast.success("WhatsApp number disconnected");
      await fetchSessions();
    } catch {
      toast.error("Failed to remove session");
    } finally {
      setDeletingId(null);
    }
  };

  const handleSaveLabel = async (sessionId) => {
    try {
      await api.patch(`/whatsapp/sessions/${sessionId}/label`, { label: editLabel });
      setEditingId(null);
      await fetchSessions();
    } catch {
      toast.error("Failed to update label");
    }
  };

  const connectedCount = sessions.filter(s => s.status === "connected").length;

  return (
    <div className="space-y-4">
      {qrSession   && <QRModal       sessionId={qrSession.sessionId}   label={qrSession.label}   isDark={isDark} onClose={() => { setQrSession(null);   fetchSessions(); }} />}
      {pairSession && <PairCodeModal sessionId={pairSession.sessionId} label={pairSession.label} isDark={isDark} onClose={() => { setPairSession(null); fetchSessions(); }} />}

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Connected",    value: connectedCount,                                       color: "#22c55e" },
          { label: "Total Linked", value: sessions.length,                                      color: GREEN },
          { label: "Pending",      value: sessions.filter(s => s.status !== "connected").length, color: "#f59e0b" },
        ].map(s => (
          <div key={s.label} className={`rounded-xl border p-4 text-center ${card}`}>
            <div style={{ fontSize: 28, fontWeight: 800, color: s.color }}>{s.value}</div>
            <div className={`text-xs mt-1 ${muted}`}>{s.label}</div>
          </div>
        ))}
      </div>

      {/* Add new number */}
      <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
        <div className="flex items-center gap-2 mb-4">
          <Plus size={16} className="text-emerald-500" />
          <span className={`text-sm font-bold ${txt}`}>Add WhatsApp Number</span>
        </div>

        {/* Auth mode toggle */}
        <div className={`flex gap-1 p-1 rounded-xl mb-4 ${isDark ? "bg-slate-900" : "bg-slate-100"}`} style={{ width: "fit-content" }}>
          {[
            { id: "qr",    label: "QR Code",     icon: QrCode },
            { id: "phone", label: "Phone Number", icon: Phone  },
          ].map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setAuthMode(id)}
              className={`flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-bold transition ${authMode === id ? "bg-white text-slate-800 shadow" : (isDark ? "text-slate-400 hover:text-slate-200" : "text-slate-500 hover:text-slate-700")}`}
              style={authMode === id ? { background: isDark ? "#1e293b" : "#fff" } : {}}>
              <Icon size={12} />{label}
            </button>
          ))}
        </div>

        {/* Phone number input (only for phone mode) */}
        {authMode === "phone" && (
          <div className="mb-3">
            <input
              className={`${inputC} mb-1`}
              placeholder="Phone with country code, e.g. 919876543210"
              value={newPhone}
              onChange={e => setNewPhone(e.target.value)}
              type="tel"
            />
            <p className={`text-[11px] ${muted}`}>Include country code, no + or spaces — e.g. 91 for India</p>
          </div>
        )}

        <div className="flex gap-3">
          <input
            className={`${inputC} flex-1`}
            placeholder='Label e.g. "MDA GST", "Office Line"…'
            value={newLabel}
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAddSession()}
          />
          <button
            onClick={handleAddSession}
            disabled={adding}
            className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-bold text-white transition hover:opacity-90 active:scale-95 disabled:opacity-60"
            style={{ background: GRAD_BTN, whiteSpace: "nowrap" }}
          >
            {adding ? <RefreshCw size={14} className="animate-spin" /> : (authMode === "phone" ? <Hash size={14} /> : <QrCode size={14} />)}
            {adding ? "Starting…" : (authMode === "phone" ? "Get Code" : "Get QR")}
          </button>
        </div>

        <div className={`mt-3 p-3 rounded-xl text-xs ${isDark ? "bg-slate-900/60 text-slate-400" : "bg-slate-50 text-slate-500"}`}>
          {authMode === "phone"
            ? <span><strong className={isDark ? "text-slate-300" : "text-slate-700"}>Phone Number method:</strong> No QR camera needed. An 8-digit code appears — enter it in WhatsApp → Linked Devices → Link with phone number.</span>
            : <span><strong className={isDark ? "text-slate-300" : "text-slate-700"}>QR Code method:</strong> A QR code appears — scan it in WhatsApp → Linked Devices → Link a Device.</span>
          }
        </div>
      </div>

      {/* Session list */}
      <div className={`rounded-2xl border shadow-sm ${card}`}>
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }}>
          <div className="flex items-center gap-2">
            <Smartphone size={16} className="text-emerald-500" />
            <span className={`text-sm font-bold ${txt}`}>Linked Numbers</span>
          </div>
          <div className="flex items-center gap-2">
            {connectedCount > 0 && (
              <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-500">
                <ShieldCheck size={12} /> Auto-reconnect ON
              </span>
            )}
            <button onClick={fetchSessions} className={`p-1.5 rounded-lg transition hover:bg-slate-100 ${muted}`}>
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {loading && sessions.length === 0 ? (
          <div className={`p-8 text-center ${muted} text-sm`}>
            <RefreshCw size={24} className="animate-spin mx-auto mb-3 opacity-50" />
            Connecting to bridge…
          </div>
        ) : sessions.length === 0 ? (
          <div className={`p-10 text-center ${muted}`}>
            <Smartphone size={40} className="mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">No numbers linked yet</p>
            <p className="text-xs mt-1 opacity-70">Add a number above to get started</p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }}>
            <AnimatePresence>
              {sessions.map(s => (
                <motion.div key={s.sessionId} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
                  className="flex items-center gap-4 p-4">
                  <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: s.status === "connected" ? "#dcfce7" : (isDark ? "#1e293b" : "#f1f5f9") }}>
                    {s.status === "connected" ? <Wifi size={18} color="#22c55e" /> : <WifiOff size={18} color="#94a3b8" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    {editingId === s.sessionId ? (
                      <div className="flex gap-2 items-center">
                        <input
                          className={`${inputC} text-xs py-1`}
                          value={editLabel}
                          onChange={e => setEditLabel(e.target.value)}
                          onKeyDown={e => { if (e.key === "Enter") handleSaveLabel(s.sessionId); if (e.key === "Escape") setEditingId(null); }}
                          autoFocus
                        />
                        <button onClick={() => handleSaveLabel(s.sessionId)} className="p-1 rounded text-emerald-500 hover:bg-emerald-50"><Check size={14} /></button>
                        <button onClick={() => setEditingId(null)} className={`p-1 rounded ${muted} hover:bg-slate-100`}><X size={14} /></button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <span className={`text-sm font-semibold truncate ${txt}`}>{s.label}</span>
                        <button onClick={() => { setEditingId(s.sessionId); setEditLabel(s.label || ""); }} className={`p-0.5 rounded opacity-0 group-hover:opacity-100 hover:opacity-100 ${muted}`}><Pencil size={11} /></button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-1">
                      <StatusBadge status={s.status} />
                      {s.phoneNumber && <span className={`text-[11px] ${muted}`}>+{s.phoneNumber}</span>}
                      {s.displayName && <span className={`text-[11px] font-medium truncate ${muted}`}>{s.displayName}</span>}
                      {s.status === "reconnecting" && <span className={`text-[10px] italic ${muted}`}>auto-retrying…</span>}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    {s.status !== "connected" && (
                      <>
                        <button
                          onClick={() => setQrSession({ sessionId: s.sessionId, label: s.label })}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-white transition hover:opacity-90"
                          style={{ background: GRAD_BTN }}
                          title="Show QR to reconnect"
                        >
                          <QrCode size={12} /> QR
                        </button>
                        <button
                          onClick={() => setPairSession({ sessionId: s.sessionId, label: s.label })}
                          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition hover:bg-emerald-50 ${muted}`}
                          style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }}
                          title="Show phone pairing code"
                        >
                          <Hash size={12} /> Code
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => handleDelete(s.sessionId)}
                      disabled={deletingId === s.sessionId}
                      className={`p-1.5 rounded-lg transition hover:bg-red-50 hover:text-red-500 ${muted} disabled:opacity-40`}
                      title="Disconnect number"
                    >
                      {deletingId === s.sessionId ? <RefreshCw size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Auto-Send & Scheduling Tab ───────────────────────────────────────────────
function AutoSendTab({ isDark, onOpenAutomation }) {
  const [auto, setAuto] = useState(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState({ connected: false, loading: true });

  // one-off scheduler
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [when, setWhen] = useState("");
  const [jobs, setJobs] = useState([]);
  const [scheduling, setScheduling] = useState(false);

  const card  = isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200";
  const txt   = isDark ? "text-slate-100" : "text-slate-800";
  const muted = isDark ? "text-slate-400" : "text-slate-500";
  const inputCls = ["w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-400 transition",
    isDark ? "bg-slate-900 border-slate-700 text-slate-100" : "bg-white border-slate-300 text-slate-800"].join(" ");
  const labelCls = `block text-[11px] font-semibold uppercase tracking-wider mb-1 ${muted}`;

  const loadJobs = useCallback(() => {
    api.get("/whatsapp/scheduled-bulk").then(r => setJobs(r.data?.jobs || [])).catch(() => {});
  }, []);

  useEffect(() => {
    api.get("/whatsapp/auto-settings").then(r => setAuto(r.data)).catch(() => setAuto({}));
    api.get("/whatsapp/status").then(r => setStatus({ ...r.data, loading: false })).catch(() => setStatus({ connected: false, loading: false }));
    loadJobs();
  }, [loadJobs]);

  const set = (k, v) => setAuto(a => ({ ...a, [k]: v }));

  const saveAuto = async () => {
    setSaving(true);
    try {
      const r = await api.put("/whatsapp/auto-settings", auto);
      setAuto(r.data);
      toast.success("Auto-send settings saved");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to save");
    } finally { setSaving(false); }
  };

  const schedule = async () => {
    if (!phone.trim() || !message.trim() || !when) { toast.error("Phone, message and time are required"); return; }
    setScheduling(true);
    try {
      const iso = new Date(when).toISOString();
      await api.post("/whatsapp/schedule-bulk", {
        recipients: [{ phone: phone.replace(/\D/g, ""), message }],
        scheduled_at: iso,
        message_type: "manual_scheduled",
      });
      toast.success("Message scheduled");
      setPhone(""); setMessage(""); setWhen("");
      loadJobs();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to schedule");
    } finally { setScheduling(false); }
  };

  const cancelJob = async (jobId) => {
    try { await api.delete(`/whatsapp/scheduled-bulk/${jobId}`); toast.success("Cancelled"); loadJobs(); }
    catch { toast.error("Failed to cancel"); }
  };

  if (!auto) return <div className={`text-sm ${muted}`}>Loading…</div>;

  const rows = [
    { k: "dsc_enabled", label: "DSC expiry alerts", desc: "7-day & 1-day warnings", icon: Shield, color: "#f59e0b" },
    { k: "compliance_enabled", label: "Compliance reminders", desc: "7-day & 1-day due-date alerts", icon: FileText, color: "#3b82f6" },
  ];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* Connection notice */}
      {!status.loading && !status.connected && (
        <div className="xl:col-span-2 flex items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          No WhatsApp number is connected. Scheduled and automatic messages will not be sent until you connect a number under <b className="mx-1">Connected Numbers</b>.
        </div>
      )}

      {/* Auto-send toggles */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
          <div className="flex items-center gap-2 mb-4"><Power className="h-4 w-4 text-emerald-500" /><span className={`text-sm font-bold ${txt}`}>Automatic Messages</span></div>
          <div className="space-y-3">
            {rows.map(r => {
              const I = r.icon;
              return (
                <div key={r.k} className={`flex items-center justify-between rounded-xl border p-3 ${isDark ? "border-slate-700" : "border-slate-200"}`}>
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: r.color + "22" }}><I className="h-4 w-4" style={{ color: r.color }} /></div>
                    <div><p className={`text-sm font-semibold ${txt}`}>{r.label}</p><p className={`text-[11px] ${muted}`}>{r.desc}</p></div>
                  </div>
                  <Toggle on={auto[r.k] !== false} onChange={v => set(r.k, v)} isDark={isDark} />
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-xl border border-pink-200 bg-pink-50 dark:bg-pink-950/20 dark:border-pink-900 px-3 py-2.5 flex items-start gap-2">
            <Cake className="h-4 w-4 text-pink-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className={`text-xs font-semibold ${txt}`}>Birthday & festival wishes live right here now</p>
              <p className={`text-[11px] mt-0.5 ${muted}`}>
                Birthday (and festival) wishes across WhatsApp and Email — templates, images, and the admin
                approval gate — are managed in the same Message Automation page.
              </p>
              <button type="button" onClick={onOpenAutomation} className="text-[11px] font-semibold mt-1 inline-block hover:underline" style={{ color: "#ec4899" }}>
                Open Birthday & Approval Gate →
              </button>
            </div>
          </div>
          <button onClick={saveAuto} disabled={saving} className="w-full mt-4 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-white transition hover:opacity-90" style={{ background: GRAD_BTN }}>
            <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save Settings"}
          </button>
        </div>
      </motion.div>

      {/* Scheduler */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
          <div className="flex items-center gap-2 mb-4"><Clock className="h-4 w-4 text-emerald-500" /><span className={`text-sm font-bold ${txt}`}>Schedule a Message</span></div>
          <div className="space-y-3">
            <div><label className={labelCls}>Phone number</label><input className={inputCls} value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 9876543210" /></div>
            <div><label className={labelCls}>Message</label><textarea rows={4} className={`${inputCls} resize-none`} value={message} onChange={e => setMessage(e.target.value)} placeholder="Type the WhatsApp message…" /></div>
            <div><label className={labelCls}>Send at</label><input type="datetime-local" className={inputCls} value={when} onChange={e => setWhen(e.target.value)} /></div>
            <button onClick={schedule} disabled={scheduling} className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-white transition hover:opacity-90" style={{ background: GRAD_BTN }}>
              <Send className="h-4 w-4" /> {scheduling ? "Scheduling…" : "Schedule Message"}
            </button>
          </div>

          <div className="mt-5">
            <div className="flex items-center justify-between mb-2">
              <span className={`text-xs font-bold ${txt}`}>Upcoming scheduled</span>
              <button onClick={loadJobs} className={`p-1 rounded hover:bg-slate-100 ${muted}`}><RefreshCw className="h-3.5 w-3.5" /></button>
            </div>
            {jobs.length === 0 ? (
              <p className={`text-xs ${muted}`}>No pending scheduled messages.</p>
            ) : (
              <div className="space-y-2">
                {jobs.map(j => (
                  <div key={j.id} className={`flex items-center justify-between rounded-lg border px-3 py-2 text-xs ${isDark ? "border-slate-700" : "border-slate-200"}`}>
                    <div>
                      <p className={`font-semibold ${txt}`}><Calendar className="inline h-3 w-3 mr-1" />{new Date(j.scheduled_at).toLocaleString()}</p>
                      <p className={muted}>{j.recipient_count} recipient(s) · {j.message_type}</p>
                    </div>
                    <button onClick={() => cancelJob(j.job_id)} className="text-red-500 hover:bg-red-50 p-1 rounded"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Automation Tab (Birthday Wishes, Festivals, Approval Gate, Follow-ups) ───
// Folded in from the old standalone Automation Settings page so it all lives
// under Message Automation now.

function AutomationTab({ isDark }) {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newFestival, setNewFestival] = useState({ name: "", month_day: "", wa_template: "", wa_image_url: "", email_template: "" });
  const [addingFestival, setAddingFestival] = useState(false);

  const card  = isDark ? "bg-slate-800 border-slate-700" : "bg-white border-slate-200";
  const txt   = isDark ? "text-slate-100" : "text-slate-800";
  const muted = isDark ? "text-slate-400" : "text-slate-500";
  const inputCls = ["w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-400 transition",
    isDark ? "bg-slate-900 border-slate-700 text-slate-100" : "bg-white border-slate-300 text-slate-800"].join(" ");
  const labelCls = `block text-[11px] font-semibold uppercase tracking-wider mb-1 ${muted}`;
  const rowCls = `flex items-center justify-between rounded-xl border p-3 ${isDark ? "border-slate-700" : "border-slate-200"}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/automation/settings");
      setSettings(res.data);
    } catch (err) {
      toast.error("Failed to load automation settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const save = async (patch) => {
    setSaving(true);
    try {
      const res = await api.put("/automation/settings", patch);
      setSettings(res.data);
      toast.success("Saved");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const addFestival = async () => {
    if (!newFestival.name || !newFestival.month_day) {
      toast.error("Name and date (MM-DD) are required");
      return;
    }
    setAddingFestival(true);
    try {
      const res = await api.post("/automation/settings/festivals", {
        name: newFestival.name,
        month_day: newFestival.month_day,
        wa_template: newFestival.wa_template || `🪔 Happy ${newFestival.name}! Wishing you and your family joy and prosperity.`,
        wa_image_url: newFestival.wa_image_url || null,
        email_template: newFestival.email_template || `Dear {name},\n\nWishing you a very Happy ${newFestival.name}!\n\nBest wishes,\nTaskosphere Team`,
        enabled: true,
      });
      setSettings(res.data);
      setNewFestival({ name: "", month_day: "", wa_template: "", wa_image_url: "", email_template: "" });
      toast.success("Festival added");
    } catch (err) {
      toast.error("Failed to add festival");
    } finally {
      setAddingFestival(false);
    }
  };

  const removeFestival = async (id) => {
    try {
      const res = await api.delete(`/automation/settings/festivals/${id}`);
      setSettings(res.data);
    } catch (err) {
      toast.error("Failed to remove");
    }
  };

  if (loading || !settings) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;
  }

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      {/* Approval gate */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
          <div className="flex items-center gap-2 mb-4"><ShieldCheck className="h-4 w-4 text-violet-500" /><span className={`text-sm font-bold ${txt}`}>Approval Gate</span></div>
          <div className="space-y-3">
            <div className={rowCls}>
              <div className="pr-4">
                <p className={`text-sm font-semibold ${txt}`}>Require admin approval before sending birthday wishes</p>
                <p className={`text-[11px] mt-0.5 ${muted}`}>When on, wishes are queued in Pending Approvals instead of sent automatically.</p>
              </div>
              <Toggle on={!!settings.birthday_requires_approval} onChange={v => save({ birthday_requires_approval: v })} isDark={isDark} />
            </div>
            <div className={rowCls}>
              <p className={`text-sm font-semibold ${txt}`}>Require admin approval before sending festival greetings</p>
              <Toggle on={!!settings.festival_requires_approval} onChange={v => save({ festival_requires_approval: v })} isDark={isDark} />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Birthday wishes */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
        <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
          <div className="flex items-center gap-2 mb-4"><Cake className="h-4 w-4 text-pink-500" /><span className={`text-sm font-bold ${txt}`}>Birthday Wishes</span></div>
          <div className="flex flex-wrap gap-5 mb-3">
            <label className={`flex items-center gap-2.5 cursor-pointer text-sm ${muted}`}><Toggle on={!!settings.birthday_wa_enabled} onChange={v => save({ birthday_wa_enabled: v })} isDark={isDark} />Send via WhatsApp</label>
            <label className={`flex items-center gap-2.5 cursor-pointer text-sm ${muted}`}><Toggle on={!!settings.birthday_email_enabled} onChange={v => save({ birthday_email_enabled: v })} isDark={isDark} />Send via Email</label>
          </div>
          <div className="mb-3">
            <label className={labelCls}>WhatsApp template <span className="normal-case font-normal opacity-70">(use {"{name}"})</span></label>
            <textarea rows={2} className={`${inputCls} resize-none`} defaultValue={settings.birthday_wa_template} onBlur={e => save({ birthday_wa_template: e.target.value })} />
          </div>
          <div className="mb-3">
            <label className={labelCls}>WhatsApp image URL <span className="normal-case font-normal opacity-70">(optional — sent as an image with the message as caption)</span></label>
            <input className={inputCls} placeholder="https://…/birthday-banner.jpg" defaultValue={settings.birthday_wa_image_url || ""} onBlur={e => save({ birthday_wa_image_url: e.target.value })} />
            {settings.birthday_wa_image_url && (
              <img src={settings.birthday_wa_image_url} alt="Birthday WhatsApp preview" className="mt-2 h-16 rounded-lg border object-cover" style={{ borderColor: isDark ? "#334155" : "#e2e8f0" }} />
            )}
          </div>
          <div>
            <label className={labelCls}>Email template <span className="normal-case font-normal opacity-70">(use {"{name}"})</span></label>
            <textarea rows={4} className={`${inputCls} resize-none`} defaultValue={settings.birthday_email_template} onBlur={e => save({ birthday_email_template: e.target.value })} />
          </div>
        </div>
      </motion.div>

      {/* Festivals */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
        <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
          <div className="flex items-center gap-2 mb-3"><Sparkles className="h-4 w-4 text-orange-500" /><span className={`text-sm font-bold ${txt}`}>Festival Greetings</span></div>
          <div className="space-y-2 mb-4">
            {(settings.festivals || []).length === 0 && <p className={`text-xs ${muted}`}>No festivals added yet.</p>}
            {(settings.festivals || []).map(f => (
              <div key={f.id} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${isDark ? "border-slate-700" : "border-slate-200"}`}>
                <div className="flex items-center gap-2">
                  {f.wa_image_url && <img src={f.wa_image_url} alt="" className="h-7 w-7 rounded object-cover flex-shrink-0" />}
                  <div><span className={`text-sm font-semibold ${txt}`}>{f.name}</span><span className={`text-xs ml-2 ${muted}`}>{f.month_day}</span></div>
                </div>
                <button onClick={() => removeFestival(f.id)} className="p-1 text-slate-400 hover:text-red-500"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input className={inputCls} placeholder="Festival name (e.g. Diwali)" value={newFestival.name} onChange={e => setNewFestival({ ...newFestival, name: e.target.value })} />
            <input className={inputCls} placeholder="MM-DD (e.g. 11-01)" value={newFestival.month_day} onChange={e => setNewFestival({ ...newFestival, month_day: e.target.value })} />
            <input className={`${inputCls} col-span-2`} placeholder="WhatsApp image URL (optional)" value={newFestival.wa_image_url} onChange={e => setNewFestival({ ...newFestival, wa_image_url: e.target.value })} />
          </div>
          <button onClick={addFestival} disabled={addingFestival} className="mt-3 h-9 px-4 rounded-lg text-sm font-semibold text-white flex items-center gap-1.5" style={{ background: "#EA580C" }}>
            {addingFestival ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Add Festival
          </button>
        </div>
      </motion.div>

      {/* Follow-ups & renewals */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }}>
        <div className={`rounded-2xl border shadow-sm p-5 ${card}`}>
          <div className="flex items-center gap-2 mb-4"><Clock className="h-4 w-4 text-cyan-500" /><span className={`text-sm font-bold ${txt}`}>Follow-ups & Renewals</span></div>
          <div className={`${rowCls} mb-3`}>
            <p className={`text-sm font-semibold pr-4 ${txt}`}>Nudge assigned user if a client hasn't been contacted</p>
            <Toggle on={!!settings.follow_up_enabled} onChange={v => save({ follow_up_enabled: v })} isDark={isDark} />
          </div>
          <div className="mb-3">
            <label className={labelCls}>Days without contact before nudging</label>
            <input type="number" min={1} className={`${inputCls} w-32`} defaultValue={settings.follow_up_days_threshold} onBlur={e => save({ follow_up_days_threshold: parseInt(e.target.value, 10) || 30 })} />
          </div>
          <div className={rowCls}>
            <div className="pr-4">
              <p className={`text-sm font-semibold ${txt}`}>Alert on service/license renewal due dates</p>
              <p className={`text-[11px] mt-0.5 ${muted}`}>Set per-client renewal dates from the client's Renewals tab.</p>
            </div>
            <Toggle on={!!settings.expiry_alert_enabled} onChange={v => save({ expiry_alert_enabled: v })} isDark={isDark} />
          </div>
        </div>
      </motion.div>

      {saving && <div className={`text-xs flex items-center gap-1 xl:col-span-2 ${muted}`}><Save className="h-3 w-3" /> Saving…</div>}
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function WhatsAppSettings() {
  const isDark   = useDark();
  const { user, isPlatformOwner } = useAuth();
  // Role may be serialized as a string or { value }, and platform owners must
  // receive the same administration tabs as licensee admins on this page.
  const normalizedRole = String(user?.role?.value || user?.role || "").trim().toLowerCase();
  const isAdmin = normalizedRole === "admin" || Boolean(isPlatformOwner);

  const [settings,   setSettings]   = useState(getWASettings);
  const [saved,      setSaved]      = useState(false);
  const [previewKey, setPreviewKey] = useState("invoice");
  const [activeTab,  setActiveTab]  = useState(isAdmin ? "numbers" : "templates");
  const [companies,  setCompanies]  = useState([]);

  useEffect(() => { api.get("/companies").then(r => setCompanies(normalizeCompanies(r))).catch(() => {}); }, []);
  useEffect(() => {
    if (companies.length > 0 && !settings.firmName) {
      const first = companies[0];
      setSettings(s => ({ ...s, firmName: first.name || first.trade_name || "" }));
    }
  }, [companies]); // eslint-disable-line

  const update = (key, val) => setSettings(s => ({ ...s, [key]: val }));

  const handleSave = () => {
    saveWASettings(settings);
    toast.success("WhatsApp templates saved — all pages updated!");
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const card   = isDark ? "bg-slate-800 border-slate-700"  : "bg-white border-slate-200";
  const inner  = isDark ? "bg-slate-900 border-slate-700"  : "bg-slate-50 border-slate-200";
  const txt    = isDark ? "text-slate-100"                  : "text-slate-800";
  const muted  = isDark ? "text-slate-400"                  : "text-slate-500";
  const divider = isDark ? "border-slate-700"               : "border-slate-200";

  const inputCls = ["w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-400 transition",
                     isDark ? "bg-slate-900 border-slate-700 text-slate-100 placeholder-slate-600" : "bg-white border-slate-300 text-slate-800 placeholder-slate-400"].join(" ");
  const labelCls = `block text-[11px] font-semibold uppercase tracking-wider mb-1 ${muted}`;

  const TABS = [
    ...(isAdmin ? [{ id: "numbers",   label: "Connected Numbers", icon: Smartphone  }] : []),
    ...(isAdmin ? [{ id: "templates", label: "Message Templates", icon: MessageCircle }] : []),
    ...(isAdmin ? [{ id: "autosend", label: "Auto-Send & Scheduling", icon: Clock }] : []),
    ...(isAdmin ? [{ id: "automation", label: "Birthday & Approval Gate", icon: Sparkles }] : []),
    { id: "info", label: "How It Works", icon: Eye },
  ];

  const previewText = buildPreviewText(settings, previewKey);

  return (
    <div className="space-y-4 w-full min-w-0 overflow-x-hidden">
      {/* Banner */}
      <motion.div
        className="wa-automation-shell"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
      >
        {/* The green title banner and the tabs are deliberately separate full-width rows. */}
        <div
          className="wa-automation-hero relative overflow-hidden rounded-2xl px-4 sm:px-6 pt-4 sm:pt-5 pb-4"
          style={{ background: GRADIENT, boxShadow: "0 8px 32px rgba(18,140,126,0.25)" }}
        >
          <div
            className="absolute right-0 top-0 w-48 h-48 rounded-full -mr-16 -mt-16 opacity-10"
            style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }}
          />
          <div className="relative flex min-w-0 items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 flex items-center justify-center flex-shrink-0">
              <MessageCircle className="h-5 w-5 text-white" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-white tracking-tight leading-tight">Message Automation</h1>
              <p className="text-white/60 text-[10px] font-semibold uppercase tracking-widest mt-0.5">
                {isAdmin ? "WhatsApp connection · Templates · Birthday & festival automation" : "Message templates · Shared across all pages"}
              </p>
            </div>
          </div>
        </div>

        <div className="wa-automation-tabs" role="tablist" aria-label="Message Automation sections">
          {TABS.map(t => {
            const I = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.id)}
                className={`wa-automation-tab ${active ? "is-active" : ""}`}
              >
                <I className="h-3.5 w-3.5" />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </motion.div>
      {/* Connected Numbers Tab */}
      {activeTab === "numbers" && isAdmin && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <ConnectedNumbersTab isDark={isDark} />
        </motion.div>
      )}

      {/* Auto-Send & Scheduling Tab */}
      {activeTab === "autosend" && isAdmin && (
        <AutoSendTab isDark={isDark} onOpenAutomation={() => setActiveTab("automation")} />
      )}

      {/* Birthday Wishes / Festivals / Approval Gate Tab */}
      {activeTab === "automation" && isAdmin && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <AutomationTab isDark={isDark} />
        </motion.div>
      )}

      {/* Templates Tab */}
      {activeTab === "templates" && isAdmin && (
        <div className="grid grid-cols-1 xl:grid-cols-5 gap-4">
          <motion.div initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 }} className="xl:col-span-3">
            <div className={`rounded-2xl border shadow-sm p-5 sm:p-6 space-y-5 ${card}`}>
              {/* Firm identity */}
              <div>
                <div className="flex items-center gap-2 mb-3"><Building2 className="h-4 w-4 text-emerald-500" /><span className={`text-sm font-bold ${txt}`}>Firm Identity</span></div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Firm Name</label>
                    {companies.length > 0 ? (
                      <div className="flex gap-2">
                        <input className={inputCls} value={settings.firmName || ""} onChange={e => update("firmName", e.target.value)} placeholder="Your CA Firm" />
                        <div className="relative flex-shrink-0">
                          <select className={`${inputCls} pr-7 appearance-none cursor-pointer`} style={{ width: "auto", minWidth: 32 }} value="" onChange={e => { if (e.target.value) update("firmName", e.target.value); }} title="Pick from companies">
                            <option value="">↓</option>
                            {companies.map(co => (<option key={co.id} value={co.name || co.trade_name || ""}>{co.name || co.trade_name}</option>))}
                          </select>
                        </div>
                      </div>
                    ) : (
                      <input className={inputCls} value={settings.firmName || ""} onChange={e => update("firmName", e.target.value)} placeholder="Your CA Firm" />
                    )}
                    {companies.length > 0 && <p className={`text-[10px] mt-1 ${muted}`}>Click ↓ to pick from your companies</p>}
                  </div>
                  <div>
                    <label className={labelCls}>Tagline</label>
                    <input className={inputCls} value={settings.firmTagline || ""} onChange={e => update("firmTagline", e.target.value)} placeholder="Trusted Compliance Partner" />
                  </div>
                </div>
                <div className="flex flex-wrap gap-5 mt-4">
                  {[{ key: "includeGreeting", label: "Include Greeting" }, { key: "includeFooter", label: "Include Footer" }].map(({ key, label }) => (
                    <label key={key} className={`flex items-center gap-2.5 cursor-pointer text-sm ${muted}`}>
                      <Toggle on={!!settings[key]} onChange={v => update(key, v)} isDark={isDark} />{label}
                    </label>
                  ))}
                </div>
                {settings.includeGreeting && (<div className="mt-3"><label className={labelCls}>Greeting line <span className="normal-case font-normal opacity-70">(use {"{name}"})</span></label><input className={inputCls} value={settings.greetingTemplate || ""} onChange={e => update("greetingTemplate", e.target.value)} placeholder='Dear {name},' /></div>)}
                {settings.includeFooter && (<div className="mt-3"><label className={labelCls}>Footer note</label><input className={inputCls} value={settings.footerNote || ""} onChange={e => update("footerNote", e.target.value)} placeholder="Thank you for your trust." /></div>)}
              </div>
              <div className={`border-t ${divider}`} />
              {/* Templates */}
              <div>
                <div className="flex items-center gap-2 mb-3"><MessageCircle className="h-4 w-4 text-emerald-500" /><span className={`text-sm font-bold ${txt}`}>Message Templates</span><span className={`text-xs ml-1 ${muted}`}>— click any field to preview it</span></div>
                <div className="space-y-4">
                  {TEMPLATES.map(tpl => {
                    const Icon = tpl.icon;
                    const isActive = previewKey === tpl.pk;
                    return (
                      <div key={tpl.key} className={`rounded-xl border p-4 transition ${inner} ${isActive ? "ring-2 ring-emerald-400/40" : ""}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: tpl.color + "22" }}><Icon className="h-3.5 w-3.5" style={{ color: tpl.color }} /></div>
                          <span className={`text-xs font-bold ${txt}`}>{tpl.label}</span>
                          <span className={`text-[10px] ml-auto font-mono opacity-60 ${muted}`}>{tpl.vars}</span>
                        </div>
                        <textarea rows={3} className={`${inputCls} resize-none font-mono text-xs`} value={settings[tpl.key] || ""} onChange={e => update(tpl.key, e.target.value)} onFocus={() => setPreviewKey(tpl.pk)} placeholder={`Write your ${tpl.label} message here…`} />
                      </div>
                    );
                  })}
                </div>
              </div>
              <button onClick={handleSave} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-bold text-white transition hover:opacity-90 active:scale-[0.98]" style={{ background: saved ? "#25D366" : GRAD_BTN }}>
                {saved ? <><CheckCircle2 className="h-4 w-4" /> Saved to all pages!</> : <><Save className="h-4 w-4" /> Save Templates</>}
              </button>
            </div>
          </motion.div>
          <motion.div initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.1 }} className="xl:col-span-2 flex flex-col gap-4">
            <div className={`rounded-2xl border shadow-sm p-5 flex flex-col gap-4 ${card}`}>
              <div className="flex items-center gap-2"><MessageCircle className="h-4 w-4 text-emerald-500" /><span className={`text-sm font-bold ${txt}`}>Live Preview</span></div>
              <div className="flex flex-wrap gap-1.5">
                {TEMPLATES.map(t => (<button key={t.pk} onClick={() => setPreviewKey(t.pk)} className="px-3 py-1 rounded-full text-xs font-semibold border transition" style={{ borderColor: previewKey === t.pk ? t.color : (isDark ? "#334155" : "#e2e8f0"), background: previewKey === t.pk ? t.color + "22" : "transparent", color: previewKey === t.pk ? t.color : (isDark ? "#94a3b8" : "#64748b") }}>{t.label}</button>))}
              </div>
              <div className="rounded-xl p-3 min-h-[160px]" style={{ background: isDark ? "#0b141a" : "#e5ddd5" }}>
                <div className="rounded-lg p-3 max-w-[85%] leading-relaxed whitespace-pre-wrap break-words" style={{ background: isDark ? "#005c4b" : "#dcf8c6", color: isDark ? "#e9edef" : "#111827", borderRadius: "8px 8px 8px 2px", fontSize: 12 }}>
                  {previewText || "Configure a template on the left to see the preview here."}
                </div>
                <p className={`text-right text-[10px] mt-1 ${muted}`}>Delivered ✓✓</p>
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Info tab */}
      {activeTab === "info" && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <div className={`rounded-2xl border shadow-sm p-6 max-w-2xl ${card}`}>
            <div className="flex items-center gap-2 mb-4"><Eye className="h-4 w-4 text-emerald-500" /><span className={`text-base font-bold ${txt}`}>How WhatsApp Integration Works</span></div>
            <div className="space-y-4 text-sm">
              {[
                { step: "1", title: "Two ways to link your number",         desc: "QR Code: scan with your phone camera like WhatsApp Web. Phone Number: get an 8-digit pairing code, enter it in WhatsApp → Linked Devices → Link with phone number. The phone method avoids QR rate-limit errors on Render free tier." },
                { step: "2", title: "Multiple numbers can be connected",    desc: "You can link as many numbers as needed. Each session is stored and reconnects automatically on restart — there's no hard retry limit, so connections persist until you manually disconnect." },
                { step: "3", title: "Auto-reconnect until manually removed", desc: "If the bridge restarts or loses connection, it will keep retrying with exponential backoff (up to 2 min between attempts). Only an explicit Disconnect removes the number permanently." },
                { step: "4", title: "All users share the connected numbers", desc: "Once admin connects a number, every user with WhatsApp access can send messages through it." },
                { step: "5", title: "Messages are sent directly via bridge", desc: "The wa-bridge service (Node.js) handles the WhatsApp Web protocol — no Meta API or third-party fees." },
              ].map(item => (
                <div key={item.step} className="flex gap-4">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0 mt-0.5" style={{ background: GRAD_BTN }}>{item.step}</div>
                  <div><p className={`font-semibold mb-0.5 ${txt}`}>{item.title}</p><p className={muted}>{item.desc}</p></div>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      )}
    </div>
  );
}
