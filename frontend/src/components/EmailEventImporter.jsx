// ═══════════════════════════════════════════════════════════════════════════════
// EmailEventImporter.jsx
// Shared modal component used by:
//   - Attendance.jsx  (mode="reminder")  → pre-fills the New Reminder form
//   - VisitsPage.jsx  (mode="visit")     → pre-fills the Schedule Visit form
//
// Props:
//   mode          "reminder" | "visit"
//   onSelectEvent (event: ExtractedEventOut) => void   — called when user clicks "Use This"
//   onClose       () => void
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import api from "@/lib/api";
import {
  Mail, X, Loader2, RefreshCw, Bell, Calendar,
  AlertCircle, CheckCircle2, ArrowRight, Zap, Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";

// ── Brand colors (matches both parent pages) ──────────────────────────────────
const C = {
  deepBlue:   "#0D3B66",
  mediumBlue: "#1F6FB2",
  purple:     "#8B5CF6",
  emerald:    "#1FAF5A",
  amber:      "#F59E0B",
  coral:      "#FF6B6B",
};

// Which event_types qualify as Reminders vs Visits
const REMINDER_TYPES = new Set([
  "Trademark Hearing", "Court Hearing", "Deadline", "Appointment", "Other",
]);
const VISIT_TYPES = new Set([
  "Visit", "Online Meeting", "Conference", "Interview", "Meeting",
]);

function urgencyColor(u) {
  if (u === "high" || u === "urgent") return "#EF4444";
  if (u === "medium") return C.amber;
  return "#6B7280";
}

function EventTypeChip({ type }) {
  const isReminder = REMINDER_TYPES.has(type);
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border"
      style={{
        backgroundColor: isReminder ? `${C.purple}12` : `${C.mediumBlue}12`,
        borderColor:     isReminder ? `${C.purple}30` : `${C.mediumBlue}30`,
        color:           isReminder ? C.purple          : C.mediumBlue,
      }}
    >
      {isReminder ? <Bell className="w-2.5 h-2.5" /> : <Calendar className="w-2.5 h-2.5" />}
      {type}
    </span>
  );
}

export default function EmailEventImporter({ mode, onSelectEvent, onClose }) {
  const [events,    setEvents]    = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [scanning,  setScanning]  = useState(false);
  const [noConn,    setNoConn]    = useState(false);
  const [selected,  setSelected]  = useState(null);

  // Load cached events (or trigger scan if none)
  const loadEvents = useCallback(async (forceRefresh = false) => {
    forceRefresh ? setScanning(true) : setLoading(true);
    try {
      // 1. Check if user has any connected accounts
      const connRes = await api.get("/email/connections");
      const connections = connRes.data?.connections || [];
      if (connections.length === 0) {
        setNoConn(true);
        return;
      }

      // 2. Fetch events (use cache unless force refresh)
      const url = forceRefresh
        ? "/email/extract-events?force_refresh=true&limit=100"
        : "/email/importer/events?limit=100";
      const res = await api.get(url, { timeout: 90000 });
      const all = res.data || [];

      // 3. Filter by mode
      const filtered = all.filter(e =>
        mode === "reminder" ? REMINDER_TYPES.has(e.event_type) : VISIT_TYPES.has(e.event_type)
      );

      setEvents(filtered);
      if (forceRefresh && filtered.length === 0) {
        toast.info("No new legal events found — junk emails were filtered out.");
      }
    } catch (err) {
      if (err.code === "ECONNABORTED" || err.message?.includes("timeout")) {
        toast.error("Scan taking too long. Try again in a moment.");
      } else {
        toast.error("Failed to load email events.");
      }
      console.error("EmailEventImporter load error:", err);
    } finally {
      setLoading(false);
      setScanning(false);
    }
  }, [mode]);

  useEffect(() => { loadEvents(false); }, [loadEvents]);

  const handleUse = (event) => {
    onSelectEvent(event);
    onClose();
    toast.success(
      mode === "reminder"
        ? `✓ Reminder form pre-filled from email`
        : `✓ Visit form pre-filled from email`
    );
  };

  const modeColor  = mode === "reminder" ? C.purple : C.mediumBlue;
  const modeLabel  = mode === "reminder" ? "Reminder" : "Visit";
  const ModeIcon   = mode === "reminder" ? Bell : Calendar;

  return (
    <motion.div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ background: "rgba(7,15,30,0.72)", backdropFilter: "blur(8px)" }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden flex flex-col"
        style={{ maxHeight: "85vh" }}
        initial={{ scale: 0.92, y: 24 }}
        animate={{ scale: 1,    y: 0  }}
        exit={{ scale: 0.92,    y: 24 }}
        transition={{ type: "spring", stiffness: 280, damping: 26 }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div
          className="px-6 py-5 text-white flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}
        >
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-white/20 rounded-2xl flex items-center justify-center">
                <Mail className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-black">Import from Email</h2>
                <p className="text-xs opacity-80 mt-0.5">
                  {mode === "reminder"
                    ? "Hearings & deadlines extracted from your inbox"
                    : "Client meetings & visits extracted from your inbox"}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-xl bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors active:scale-90"
            >
              <X className="w-4 h-4 text-white" />
            </button>
          </div>

          {/* Rescan button */}
          <button
            onClick={() => loadEvents(true)}
            disabled={scanning || loading}
            className="mt-4 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold border-2 border-white/30 text-white hover:bg-white/15 disabled:opacity-60 active:scale-95 transition-all"
          >
            {scanning
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Scanning inbox…</>
              : <><RefreshCw className="w-3.5 h-3.5" />Refresh from inbox</>}
          </button>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto min-h-0">
          {/* No connections state */}
          {noConn && (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center gap-4">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center">
                <Mail className="w-7 h-7 text-slate-300" />
              </div>
              <div>
                <p className="font-bold text-slate-700">No email accounts connected</p>
                <p className="text-sm text-slate-400 mt-1">
                  Go to <strong>Settings → Email Accounts</strong> to connect your Gmail or Outlook.
                </p>
              </div>
              <Button
                onClick={onClose}
                className="rounded-xl text-white font-bold"
                style={{ background: `linear-gradient(135deg, ${C.deepBlue}, ${C.mediumBlue})` }}
              >
                <ArrowRight className="w-4 h-4 mr-1.5" />
                Go to Email Settings
              </Button>
            </div>
          )}

          {/* Loading state */}
          {!noConn && loading && (
            <div className="flex flex-col items-center justify-center py-14 gap-3">
              <Loader2 className="w-8 h-8 animate-spin" style={{ color: modeColor }} />
              <p className="text-sm text-slate-500 font-medium">
                Loading extracted events…
              </p>
            </div>
          )}

          {/* Empty state */}
          {!noConn && !loading && events.length === 0 && (
            <div className="flex flex-col items-center justify-center py-14 px-6 text-center gap-4">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center"
                style={{ backgroundColor: `${modeColor}12` }}>
                <ModeIcon className="w-7 h-7" style={{ color: modeColor }} />
              </div>
              <div>
                <p className="font-bold text-slate-700">
                  No {modeLabel.toLowerCase()} events found
                </p>
                <p className="text-sm text-slate-400 mt-1">
                  {mode === "reminder"
                    ? "No hearings, deadlines, or appointments were extracted from your recent emails."
                    : "No client visits or meeting invites were extracted from your recent emails."}
                </p>
              </div>
              <div className="p-3.5 rounded-xl bg-blue-50 border border-blue-100 text-left w-full">
                <div className="flex items-start gap-2">
                  <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-blue-700">
                    Only <strong>legal and compliance emails</strong> are extracted — Jio bills, bank alerts,
                    and marketing emails are automatically filtered out. Click{" "}
                    <strong>Refresh from inbox</strong> above to re-scan.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Event list */}
          {!noConn && !loading && events.length > 0 && (
            <div className="p-4 space-y-2.5">
              <p className="text-xs font-bold text-slate-400 uppercase tracking-wider px-1">
                {events.length} event{events.length !== 1 ? "s" : ""} found — tap one to pre-fill the form
              </p>

              <AnimatePresence>
                {events.map((ev, i) => {
                  const isSelected = selected?.id === ev.id || selected === ev;
                  return (
                    <motion.div
                      key={ev.id || i}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.03 }}
                      onClick={() => setSelected(isSelected ? null : ev)}
                      className="rounded-2xl border-2 cursor-pointer transition-all overflow-hidden"
                      style={{
                        borderColor: isSelected ? modeColor : "#E5E7EB",
                        backgroundColor: isSelected ? `${modeColor}08` : "white",
                      }}
                    >
                      {/* Card header row */}
                      <div className="flex items-start gap-3 px-4 py-3">
                        {/* Urgency dot */}
                        <div
                          className="w-2 h-2 rounded-full flex-shrink-0 mt-1.5"
                          style={{ backgroundColor: urgencyColor(ev.urgency) }}
                        />

                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-slate-800 leading-snug line-clamp-2">
                            {ev.title}
                          </p>
                          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                            <EventTypeChip type={ev.event_type} />
                            {ev.date && (
                              <span className="text-[11px] font-mono text-slate-500 font-semibold">
                                📅 {ev.date}{ev.time ? ` · ${ev.time}` : ""}
                              </span>
                            )}
                            {!ev.date && (
                              <span className="text-[11px] text-red-500 font-semibold">
                                ⚠ Date not found
                              </span>
                            )}
                          </div>
                          {ev.description && (
                            <p className="text-xs text-slate-500 mt-1 line-clamp-1">{ev.description}</p>
                          )}
                          {ev.email_account && (
                            <p className="text-[10px] text-slate-400 mt-0.5">
                              📧 {ev.email_account}
                            </p>
                          )}
                        </div>

                        {/* Use button (shown on hover / selected) */}
                        <button
                          onClick={e => { e.stopPropagation(); handleUse(ev); }}
                          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white transition-all active:scale-95 hover:opacity-90"
                          style={{ background: `linear-gradient(135deg, ${modeColor}, ${modeColor}BB)` }}
                        >
                          <Zap className="w-3 h-3" />
                          Use
                        </button>
                      </div>

                      {/* Expanded detail (shown when selected) */}
                      <AnimatePresence>
                        {isSelected && (
                          <motion.div
                            initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }}
                            className="overflow-hidden"
                          >
                            <div
                              className="px-4 pb-4 pt-0 space-y-1.5 border-t"
                              style={{ borderColor: `${modeColor}20` }}
                            >
                              {ev.organizer && (
                                <p className="text-xs text-slate-600">
                                  <span className="font-bold text-slate-500">From: </span>{ev.organizer}
                                </p>
                              )}
                              {ev.source_subject && (
                                <p className="text-xs text-slate-600 line-clamp-2">
                                  <span className="font-bold text-slate-500">Subject: </span>{ev.source_subject}
                                </p>
                              )}
                              {ev.raw_snippet && (
                                <p className="text-[11px] text-slate-400 italic line-clamp-3 font-mono">
                                  {ev.raw_snippet}
                                </p>
                              )}
                              <button
                                onClick={() => handleUse(ev)}
                                className="mt-2 w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-bold text-white transition-all active:scale-[0.98] hover:opacity-90"
                                style={{ background: `linear-gradient(135deg, ${modeColor}, ${modeColor}BB)` }}
                              >
                                <ModeIcon className="w-4 h-4" />
                                Use this — pre-fill {modeLabel} form
                                <ArrowRight className="w-4 h-4" />
                              </button>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex-shrink-0 flex items-center justify-between gap-3">
          <p className="text-xs text-slate-400 leading-tight">
            AI filters out bills, OTPs &amp; marketing.<br />
            Only legal &amp; compliance events are shown.
          </p>
          <Button variant="outline" onClick={onClose} className="rounded-xl font-bold text-sm flex-shrink-0">
            Cancel
          </Button>
        </div>
      </motion.div>
    </motion.div>
  );
}
