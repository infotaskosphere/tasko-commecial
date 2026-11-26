// ═══════════════════════════════════════════════════════════════════════════════
// EmailSettings.jsx  v6  — Preview-before-save, past-date filtering, dedup
// Changes from v5:
//   1. ScanPreviewPanel — shows all extracted events BEFORE any data is written
//      - Checkbox per event (checked by default if future & not already saved)
//      - Past-dated events greyed + unchecked + "PAST — SKIPPED" badge
//      - Already-saved events get "ALREADY SAVED" badge + disabled checkbox
//      - Override save-type dropdown per event
//      - "Select All Future / None" bulk controls
//      - "Save N Selected" button — saves in one batch call
//   2. Sync base date — each account's Sync button passes last_synced to API
//      (?since_date=...) so only new emails since last sync are fetched
//   3. Session-level dedup — savedKeys Set tracks event keys saved this session;
//      a new scan deduplicates against it before merging into the panel
//   4. Old EventRow (individual save buttons) removed — replaced by preview panel
// ═══════════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import api from "@/lib/api";
import SendFromSelect from '@/components/SendFromSelect';
import OrganisationEmail from '@/components/OrganisationEmail';
import { normalizeCompanies } from "@/lib/companies";
import { useDark } from "@/hooks/useDark";
import { useAuth } from "@/contexts/AuthContext";
import {
  Mail, Plus, Trash2, CheckCircle2, AlertCircle,
  Loader2, Eye, EyeOff, ExternalLink, ChevronDown, ChevronUp,
  Wifi, WifiOff, Edit2, Check, X, Info, Shield,
  RefreshCw, Calendar, Bell, Eraser, Clock,
  Settings2, AlertTriangle,
  CheckSquare, Filter, Tag, BookOpen, Activity, ChevronRight,
  Square, Save, CalendarOff,
  Send, FileText, Building2, Pencil, Users,
  ToggleLeft, ToggleRight, Copy, Zap, Paperclip,
  UserPlus, UserMinus, Key,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { format, parseISO, isBefore, startOfDay } from "date-fns";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const COLORS = {
  deepBlue:     "#0D3B66",
  mediumBlue:   "#1F6FB2",
  emeraldGreen: "#1FAF5A",
  lightGreen:   "#5CCB5F",
  amber:        "#F59E0B",
  orange:       "#F97316",
  red:          "#EF4444",
  purple:       "#8B5CF6",
};

const D = {
  bg:      "#0f172a",
  card:    "#1e293b",
  raised:  "#263348",
  border:  "#334155",
  text:    "#f1f5f9",
  muted:   "#94a3b8",
  dimmer:  "#64748b",
};

const containerVariants = {
  hidden:  { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.06, delayChildren: 0.1 } },
};
const itemVariants = {
  hidden:  { opacity: 0, y: 24 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.45, ease: [0.23, 1, 0.32, 1] } },
};
const springPhysics = { lift: { type: "spring", stiffness: 320, damping: 24, mass: 0.9 } };

const PROVIDER_COLORS = {
  gmail: "#EA4335", outlook: "#0078D4", yahoo: "#720E9E", icloud: "#3B82F6", other: "#374151",
};
const PROVIDER_ICONS = {
  gmail: "G", outlook: "M", yahoo: "Y", icloud: "iC", other: "@",
};
const CATEGORY_CONFIG = {
  todo: {
    label: "Todo", color: COLORS.purple,
    bg: "#F5F3FF", border: "#DDD6FE", darkBg: "rgba(139,92,246,0.12)",
  },
  reminder: {
    label: "Reminder", color: COLORS.deepBlue,
    bg: "#EFF6FF", border: "#BFDBFE", darkBg: "rgba(13,59,102,0.18)",
  },
  visit: {
    label: "Visit", color: COLORS.emeraldGreen,
    bg: "#F0FDF4", border: "#BBF7D0", darkBg: "rgba(31,175,90,0.12)",
  },
};

// ─── Date helpers ─────────────────────────────────────────────────────────────
function isEventPast(event) {
  if (!event.date) return false;
  try { return isBefore(startOfDay(parseISO(event.date)), startOfDay(new Date())); }
  catch { return false; }
}

// Stable dedup key: prefer event_id from backend, else title+date+time
function eventKey(event) {
  return event.id || event.event_id || `${event.title}||${event.date}||${event.time || ""}`;
}

// Determine category for an event using save_category or event_type fallback
function resolveCategory(event) {
  if (event.save_category && ["todo","reminder","visit"].includes(event.save_category)) return event.save_category;
  const et = event.event_type || "";
  if (["Visit","Online Meeting","Conference","Interview","Meeting"].includes(et)) return "visit";
  if (["Trademark Hearing","Court Hearing","Deadline","Appointment"].includes(et)) return "reminder";
  return "reminder";
}

const QUICK_PROVIDERS = [
  {
    id: "gmail", label: "Gmail", color: "#EA4335", icon: "G",
    domain: "gmail.com", imap_host: "imap.gmail.com", imap_port: 993,
    app_password_url: "https://myaccount.google.com/apppasswords",
    imap_enable_url:  "https://mail.google.com/mail/u/0/#settings/fwdandpop",
    steps: [
      { num: 1, text: "Enable IMAP:", link: "https://mail.google.com/mail/u/0/#settings/fwdandpop", linkText: "Gmail → Settings → Forwarding and POP/IMAP → Enable IMAP → Save" },
      { num: 2, text: "Enable 2-Step Verification:", link: "https://myaccount.google.com/security", linkText: "myaccount.google.com/security" },
      { num: 3, text: "Create App Password:", link: "https://myaccount.google.com/apppasswords", linkText: "myaccount.google.com/apppasswords" },
      { num: 4, text: "Select App: Mail · Device: Other · Name: Taskosphere → Generate" },
      { num: 5, text: "Copy the 16-character password shown and paste it below" },
    ],
    note: "⚠️ All 3 steps above are required. AUTHENTICATION FAILED means IMAP is off or App Password is wrong.",
    placeholder: "abcd efgh ijkl mnop",
  },
  {
    id: "outlook", label: "Outlook / Hotmail", color: "#0078D4", icon: "M",
    domain: "outlook.com", imap_host: "outlook.office365.com", imap_port: 993,
    app_password_url: "https://account.microsoft.com/security",
    imap_enable_url: null,
    steps: [
      { num: 1, text: "Open", link: "https://account.microsoft.com/security", linkText: "account.microsoft.com/security" },
      { num: 2, text: "Click 'Advanced security options'" },
      { num: 3, text: "Under App passwords → Create a new app password" },
      { num: 4, text: "Copy the generated password and paste below" },
    ],
    note: "⚠️ Requires Microsoft account with 2-step verification on.",
    placeholder: "xxxx xxxx xxxx xxxx",
  },
  {
    id: "yahoo", label: "Yahoo Mail", color: "#720E9E", icon: "Y",
    domain: "yahoo.com", imap_host: "imap.mail.yahoo.com", imap_port: 993,
    app_password_url: "https://login.yahoo.com/myaccount/security/",
    imap_enable_url: null,
    steps: [
      { num: 1, text: "Open", link: "https://login.yahoo.com/myaccount/security/", linkText: "Yahoo Account Security" },
      { num: 2, text: "Click 'Generate app password'" },
      { num: 3, text: "Select 'Other App' → enter Taskosphere → Get password" },
      { num: 4, text: "Copy and paste the password below" },
    ],
    note: "⚠️ Do NOT use your Yahoo login password here.",
    placeholder: "xxxx xxxx xxxx xxxx",
  },
  {
    id: "icloud", label: "iCloud Mail", color: "#3B82F6", icon: "iC",
    domain: "icloud.com", imap_host: "imap.mail.me.com", imap_port: 993,
    app_password_url: "https://appleid.apple.com",
    imap_enable_url: null,
    steps: [
      { num: 1, text: "Open", link: "https://appleid.apple.com", linkText: "appleid.apple.com" },
      { num: 2, text: "Sign In & Security → App-Specific Passwords" },
      { num: 3, text: "Click + → name it Taskosphere → Create" },
      { num: 4, text: "Copy and paste the password below" },
    ],
    note: "⚠️ Apple ID must have 2FA enabled.",
    placeholder: "xxxx-xxxx-xxxx-xxxx",
  },
  {
    id: "other", label: "Other Email", color: "#374151", icon: "@",
    domain: "", imap_host: "", imap_port: 993, app_password_url: "",
    imap_enable_url: null,
    steps: [
      { num: 1, text: "Ask your email provider for IMAP settings" },
      { num: 2, text: "Typical host: imap.yourdomain.com · Port: 993" },
      { num: 3, text: "Use your regular password or an app password if available" },
    ],
    note: "",
    placeholder: "your email password",
  },
];

const SUGGESTED_SENDERS = [
  { email_address: "@ipindia.gov.in",            label: "IP India (all)" },
  { email_address: "noreply@ipindia.gov.in",     label: "IP India No-Reply" },
  { email_address: "@mca.gov.in",                label: "MCA Portal (all)" },
  { email_address: "@gst.gov.in",                label: "GST Portal (all)" },
  { email_address: "@incometax.gov.in",          label: "Income Tax (all)" },
  { email_address: "@taxinformationnetwork.com", label: "TIN / TDS" },
  { email_address: "@zoom.us",                   label: "Zoom Meetings" },
  { email_address: "@calendar.google.com",       label: "Google Calendar" },
];

// ─────────────────────────────────────────────────────────────────────────────
// SHARED LAYOUT PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function SectionCard({ children, className = "", style = {} }) {
  return (
    <div className={`bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 rounded-2xl overflow-hidden shadow-sm ${className}`} style={style}>
      {children}
    </div>
  );
}

function CardHeaderRow({ iconBg, icon, title, subtitle, action, badge }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-700">
      <div className="flex items-center gap-2.5">
        <div className={`p-1.5 rounded-lg ${iconBg}`}>{icon}</div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm text-slate-800 dark:text-slate-100">{title}</h3>
            {badge !== undefined && badge > 0 && (
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-blue-500 text-white leading-none">{badge}</span>
            )}
          </div>
          {subtitle && <p className="text-xs text-slate-400 dark:text-slate-500">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="flex items-center gap-1.5 flex-shrink-0">{action}</div>}
    </div>
  );
}

function StatCard({ icon: Icon, label, value, unit, color, trend }) {
  return (
    <motion.div variants={itemVariants} whileHover={{ y: -3, transition: springPhysics.lift }} whileTap={{ scale: 0.985 }}>
      <div className="rounded-2xl shadow-sm border h-full bg-white dark:bg-slate-800 border-slate-200/80 dark:border-slate-700 hover:shadow-md transition-all">
        <div className="p-4">
          <div className="flex items-start justify-between mb-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">{label}</p>
              <p className="text-2xl font-bold tracking-tight" style={{ color }}>{value}</p>
              <p className="text-xs font-medium text-slate-400 dark:text-slate-500 mt-0.5">{unit}</p>
            </div>
            <div className="p-2 rounded-xl" style={{ backgroundColor: `${color}15` }}>
              <Icon className="w-4 h-4" style={{ color }} />
            </div>
          </div>
          {trend && (
            <p className="text-[11px] font-medium text-slate-400 dark:text-slate-500 truncate border-t border-slate-100 dark:border-slate-700 pt-2 mt-1">{trend}</p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function GmailChecklistBanner({ onDismiss, isDark }) {
  return (
    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
      className="rounded-2xl overflow-hidden border"
      style={{ borderColor: isDark ? "#7f1d1d" : "#fecaca", backgroundColor: isDark ? "rgba(239,68,68,0.08)" : "#fef2f2" }}>
      <div className="flex items-center gap-3 px-4 py-3 border-b"
        style={{ borderColor: isDark ? "#7f1d1d" : "#fecaca", backgroundColor: isDark ? "rgba(239,68,68,0.12)" : "#fee2e2" }}>
        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
        <p className="text-sm font-bold text-red-500 flex-1">Authentication Failed — Complete these 3 steps for Gmail</p>
        <button onClick={onDismiss} className="text-red-400 hover:text-red-300"><X className="w-4 h-4" /></button>
      </div>
      <div className="p-4 space-y-3">
        {[
          { num: 1, title: "Enable IMAP in Gmail", link: "https://mail.google.com/mail/u/0/#settings/fwdandpop", linkText: "Open Gmail IMAP Settings →", detail: "Settings → See all settings → Forwarding and POP/IMAP → Enable IMAP → Save Changes" },
          { num: 2, title: "Turn on 2-Step Verification", link: "https://myaccount.google.com/security", linkText: "Open Google Security →", detail: "Security → 2-Step Verification → Turn On" },
          { num: 3, title: "Generate a fresh App Password", link: "https://myaccount.google.com/apppasswords", linkText: "Create App Password →", detail: "App: Mail · Device: Other (Taskosphere) → Generate → Copy 16 chars" },
        ].map(step => (
          <div key={step.num} className="flex items-start gap-3">
            <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center flex-shrink-0 mt-0.5">
              <span className="text-[10px] font-black text-white">{step.num}</span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold text-red-500">{step.title}</p>
              <p className="text-xs mt-0.5" style={{ color: isDark ? "#fca5a5" : "#dc2626" }}>{step.detail}</p>
              <a href={step.link} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1 mt-1 text-xs font-bold text-red-500 underline hover:text-red-400">
                {step.linkText}<ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

function CategoryRulesPanel({ isDark }) {
  const [open, setOpen] = useState(false);
  return (
    <SectionCard>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3.5 text-left transition-colors"
        style={{ backgroundColor: open ? (isDark ? D.raised : "#f8fafc") : "transparent" }}>
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/40">
            <BookOpen className="w-4 h-4 text-purple-500" />
          </div>
          <div>
            <p className="font-semibold text-sm text-slate-800 dark:text-slate-100">Smart Categorization Rules</p>
            <p className="text-xs text-slate-400 dark:text-slate-500">How emails are automatically classified</p>
          </div>
        </div>
        {open ? <ChevronUp className="w-4 h-4 text-slate-400 flex-shrink-0" /> : <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0" />}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="px-4 pb-4 pt-1 space-y-3 border-t border-slate-100 dark:border-slate-700">
              {[
                { cat: "todo",     label: "→ Saved as Todo",     desc: "Action required notices",      examples: ["Examination Report","Office Action","Objection Raised","Reply Required","Show Cause Notice","Reply within X days"] },
                { cat: "reminder", label: "→ Saved as Reminder", desc: "Scheduled dates and hearings", examples: ["Trademark Hearing","Court Hearing (NCLT, HC)","GST Filing Dates","Income Tax / Advance Tax","Due Dates","ROC Filing Deadlines"] },
                { cat: "visit",    label: "→ Saved as Visit",    desc: "Meetings and consultations",   examples: ["Zoom Meeting Invite","Google Meet Link","Microsoft Teams","Client Visit Scheduled","Office Visit","Conference / Webinar"] },
              ].map(({ cat, label, desc, examples }) => {
                const cfg = CATEGORY_CONFIG[cat];
                return (
                  <div key={cat} className="rounded-xl border p-3.5"
                    style={{ borderColor: isDark ? `${cfg.color}30` : cfg.border, backgroundColor: isDark ? cfg.darkBg : cfg.bg }}>
                    <div className="flex items-center gap-2 mb-2.5">
                      <span className="text-xs font-black px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: cfg.color }}>{cfg.label.toUpperCase()}</span>
                      <span className="text-xs font-bold" style={{ color: cfg.color }}>{label}</span>
                      <span className="text-[10px] ml-auto" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>{desc}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {examples.map(ex => (
                        <span key={ex} className="text-[10px] font-medium px-2 py-0.5 rounded-md border"
                          style={{ backgroundColor: isDark ? "rgba(255,255,255,0.05)" : "#ffffff", borderColor: isDark ? `${cfg.color}35` : cfg.border, color: cfg.color }}>
                          {ex}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
              <p className="text-[10px] pt-1" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
                ℹ️ AI uses these rules + context to classify. You can override the category in the preview panel before saving.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECT FORM
// ─────────────────────────────────────────────────────────────────────────────
function ConnectForm({ provider, onSuccess, onCancel, isDark }) {
  const [emailVal,    setEmailVal]    = useState(provider.domain ? `@${provider.domain}` : "");
  const [password,    setPassword]    = useState("");
  const [host,        setHost]        = useState(provider.imap_host);
  const [port,        setPort]        = useState(provider.imap_port);
  const [label,       setLabel]       = useState("");
  const [linkedPage,  setLinkedPage]  = useState("all");
  const [autoSync,    setAutoSync]    = useState(false);
  const [showPass,    setShowPass]    = useState(false);
  const [showSteps,   setShowSteps]   = useState(provider.id !== "gmail");
  const [loading,     setLoading]     = useState(false);
  const [oauthLoading,setOauthLoading]= useState(false);
  const [authError,   setAuthError]   = useState(false);
  const emailRef = useRef(null);
  const supportsOAuth = provider.id === "gmail";

  const LINKED_PAGE_OPTIONS = [
    { value: "all",      label: "All Pages",    icon: "🌐" },
    { value: "leads",    label: "Leads",        icon: "🎯" },
    { value: "invoicing",label: "Invoicing",    icon: "📄" },
    { value: "tasks",    label: "Tasks",        icon: "✅" },
    { value: "reminders",label: "Reminders",    icon: "🔔" },
    { value: "visits",   label: "Visits",       icon: "📍" },
  ];

  useEffect(() => { setTimeout(() => emailRef.current?.focus(), 50); }, []);

  const inputStyle = { backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#d1d5db", color: isDark ? D.text : "#1e293b" };
  const inputCls = "w-full px-3.5 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all";

  const handleConnect = async () => {
    const trimEmail = emailVal.trim();
    if (!trimEmail || !trimEmail.includes("@")) { toast.error("Enter a valid email address"); return; }
    if (!password) { toast.error("App Password is required"); return; }
    setAuthError(false); setLoading(true);
    try {
      await api.post("/email/connections", {
        email_address: trimEmail, app_password: password,
        imap_host: host || undefined, imap_port: Number(port), label: label || undefined,
        linked_page: linkedPage, auto_sync: autoSync,
      });
      toast.success(`✓ ${trimEmail} connected successfully!`);
      onSuccess();
    } catch (err) {
      const msg = err?.response?.data?.detail || "Connection failed. Check your credentials.";
      const isAuthFail = msg.toLowerCase().includes("authentication") || msg.toLowerCase().includes("login failed") || msg.toLowerCase().includes("invalid credentials");
      if (isAuthFail && provider.id === "gmail") { setAuthError(true); setShowSteps(true); }
      toast.error(msg);
    } finally { setLoading(false); }
  };

  const handleOAuthConnect = async () => {
    setOauthLoading(true);
    try {
      const res = await api.get("/email/oauth/google/start", {
        params: {
          linked_page: linkedPage,
          auto_sync: autoSync,
          label: label || undefined,
        },
      });
      if (!res.data?.auth_url) throw new Error("Google OAuth URL was not returned");
      window.location.href = res.data.auth_url;
    } catch (err) {
      const msg = err?.response?.data?.detail || "Google one-click connection is not configured yet. Use App Password fallback.";
      toast.error(msg);
      setShowSteps(true);
    } finally {
      setOauthLoading(false);
    }
  };

  return (
    <SectionCard>
      <div className="px-5 py-4 flex items-center gap-3 border-b border-slate-100 dark:border-slate-700"
        style={{ backgroundColor: provider.color + (isDark ? "20" : "0d") }}>
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-black text-white flex-shrink-0"
          style={{ backgroundColor: provider.color }}>{provider.icon}</div>
        <div className="flex-1">
          <p className="font-bold text-sm" style={{ color: isDark ? D.text : "#1e293b" }}>Connect {provider.label}</p>
          <p className="text-xs" style={{ color: isDark ? D.muted : "#64748b" }}>
            {supportsOAuth ? "Recommended: Google sign-in · App Password fallback" : "IMAP · App Password"}
          </p>
        </div>
        {provider.app_password_url && (
          <a href={provider.app_password_url} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all hover:opacity-80"
            style={{ color: provider.color, borderColor: provider.color + "40", backgroundColor: isDark ? provider.color + "18" : provider.color + "10" }}>
            <ExternalLink className="w-3 h-3" /> Get App Password
          </a>
        )}
      </div>
      <div className="p-5 space-y-4">
        <AnimatePresence>
          {authError && provider.id === "gmail" && (
            <GmailChecklistBanner onDismiss={() => setAuthError(false)} isDark={isDark} />
          )}
        </AnimatePresence>

        {supportsOAuth && (
          <div className="rounded-2xl border overflow-hidden"
            style={{ borderColor: isDark ? "#14532d" : "#bbf7d0", background: isDark ? "rgba(31,175,90,0.08)" : "#f0fdf4" }}>
            <div className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-white flex items-center justify-center font-black text-sm shadow-sm"
                  style={{ color: provider.color }}>G</div>
                <div>
                  <p className="text-sm font-bold" style={{ color: isDark ? D.text : "#14532d" }}>
                    Connect Gmail directly with Google
                  </p>
                  <p className="text-xs mt-0.5" style={{ color: isDark ? "#86efac" : "#166534" }}>
                    No app password needed. You approve read-only Gmail access on Google’s secure consent screen.
                  </p>
                </div>
              </div>
              <Button onClick={handleOAuthConnect} disabled={oauthLoading}
                className="h-10 rounded-xl text-sm font-bold text-white shrink-0"
                style={{ background: oauthLoading ? "#9CA3AF" : `linear-gradient(135deg, ${COLORS.emeraldGreen}, ${COLORS.lightGreen})` }}>
                {oauthLoading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Opening Google…</> : <><Shield className="w-4 h-4 mr-2" />Connect with Google</>}
              </Button>
            </div>
            <div className="px-4 pb-3 text-[11px]" style={{ color: isDark ? D.muted : "#64748b" }}>
              App Password is still available as a manual fallback if Google OAuth is not configured on the server.
            </div>
          </div>
        )}

        {provider.steps.length > 0 && (
          <div className="rounded-xl overflow-hidden border" style={{ borderColor: isDark ? D.border : "#e2e8f0" }}>
            <button onClick={() => setShowSteps(s => !s)}
              className="w-full flex items-center justify-between px-4 py-2.5 text-left text-xs font-semibold transition-colors"
              style={{ backgroundColor: isDark ? D.raised : "#f8fafc", color: isDark ? D.muted : "#64748b" }}>
              <span className="flex items-center gap-1.5"><Info className="w-3.5 h-3.5" />Setup instructions for {provider.label}</span>
              {showSteps ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            <AnimatePresence>
              {showSteps && (
                <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
                  <div className="p-4 space-y-2.5 border-t" style={{ borderColor: isDark ? D.border : "#e2e8f0" }}>
                    {provider.steps.map(step => (
                      <div key={step.num} className="flex items-start gap-2.5">
                        <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 text-white text-[10px] font-black"
                          style={{ backgroundColor: provider.color }}>{step.num}</div>
                        <p className="text-xs" style={{ color: isDark ? D.muted : "#374151" }}>
                          {step.text}
                          {step.link && (
                            <a href={step.link} target="_blank" rel="noopener noreferrer"
                              className="ml-1.5 font-semibold underline inline-flex items-center gap-1" style={{ color: provider.color }}>
                              {step.linkText}<ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </p>
                      </div>
                    ))}
                    {provider.note && (
                      <p className="text-[11px] font-semibold mt-1 pt-2 border-t"
                        style={{ borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? "#fbbf24" : "#92400e" }}>
                        {provider.note}
                      </p>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        )}
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: isDark ? D.muted : "#374151" }}>Email Address</label>
            <input ref={emailRef} type="email" value={emailVal} onChange={e => setEmailVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleConnect()} placeholder={`your@${provider.domain || "email.com"}`}
              className={inputCls} style={inputStyle} />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: isDark ? D.muted : "#374151" }}>
              {supportsOAuth ? "Manual App Password Fallback" : "App Password"} <span className="font-normal text-slate-400">(not your login password)</span>
            </label>
            <div className="relative">
              <input type={showPass ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleConnect()} placeholder={provider.placeholder}
                className={inputCls + " pr-10"} style={inputStyle} />
              <button onClick={() => setShowPass(s => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                style={{ color: isDark ? D.muted : "#9ca3af" }}>
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: isDark ? D.muted : "#374151" }}>
              Account Label <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input type="text" value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Work Gmail, CA Office"
              className={inputCls} style={inputStyle} />
          </div>

          {/* ── Linked Page ── */}
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: isDark ? D.muted : "#374151" }}>
              Link to Page <span className="font-normal text-slate-400">(events from this email appear in selected page)</span>
            </label>
            <div className="grid grid-cols-3 gap-2">
              {LINKED_PAGE_OPTIONS.map(opt => (
                <button key={opt.value} type="button"
                  onClick={() => setLinkedPage(opt.value)}
                  className="flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold transition-all"
                  style={{
                    backgroundColor: linkedPage === opt.value
                      ? (isDark ? "rgba(31,115,90,0.2)" : "#dcfce7")
                      : (isDark ? D.raised : "#f8fafc"),
                    borderColor: linkedPage === opt.value
                      ? COLORS.emeraldGreen
                      : (isDark ? D.border : "#e2e8f0"),
                    color: linkedPage === opt.value
                      ? COLORS.emeraldGreen
                      : (isDark ? D.muted : "#64748b"),
                  }}>
                  <span>{opt.icon}</span>
                  <span>{opt.label}</span>
                  {linkedPage === opt.value && <Check className="w-3 h-3 ml-auto" />}
                </button>
              ))}
            </div>
          </div>

          {/* ── Auto Sync ── */}
          <div className="flex items-center justify-between p-3 rounded-xl border"
            style={{
              backgroundColor: isDark ? D.raised : "#f8fafc",
              borderColor: isDark ? D.border : "#e2e8f0",
            }}>
            <div>
              <p className="text-xs font-semibold" style={{ color: isDark ? D.text : "#374151" }}>Auto Sync</p>
              <p className="text-[11px] mt-0.5" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
                Automatically sync new emails daily
              </p>
            </div>
            <button type="button" onClick={() => setAutoSync(v => !v)}
              className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${autoSync ? "bg-emerald-500" : (isDark ? "bg-slate-600" : "bg-slate-300")}`}>
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${autoSync ? "translate-x-5" : "translate-x-0"}`} />
            </button>
          </div>

          {provider.id === "other" && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: isDark ? D.muted : "#374151" }}>IMAP Host</label>
                <input type="text" value={host} onChange={e => setHost(e.target.value)} placeholder="imap.yourdomain.com" className={inputCls} style={inputStyle} />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: isDark ? D.muted : "#374151" }}>Port</label>
                <input type="number" value={port} onChange={e => setPort(e.target.value)} placeholder="993" className={inputCls} style={inputStyle} />
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onCancel} className="flex-1 h-10 rounded-xl text-sm font-semibold"
            style={{ borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.muted : "#374151", backgroundColor: "transparent" }}>Cancel</Button>
          <Button onClick={handleConnect} disabled={loading} className="flex-1 h-10 rounded-xl text-sm font-bold text-white"
            style={{ background: loading ? "#9CA3AF" : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
            {loading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Connecting…</> : <><Wifi className="w-4 h-4 mr-2" />Connect Account</>}
          </Button>
        </div>
        <div className="flex items-center gap-2 p-3 rounded-xl border"
          style={{ backgroundColor: isDark ? "rgba(31,175,90,0.08)" : "#f0fdf4", borderColor: isDark ? "#14532d" : "#bbf7d0" }}>
          <Shield className="w-4 h-4 text-emerald-500 flex-shrink-0" />
          <p className="text-xs text-emerald-600 dark:text-emerald-400">
            {supportsOAuth
              ? "Google OAuth uses read-only Gmail access. Manual app passwords are used only for IMAP scanning."
              : "Password is stored securely. We only read email subjects & bodies for event extraction — we never send or modify anything."}
          </p>
        </div>
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CONNECTED ACCOUNT CARD
// ─────────────────────────────────────────────────────────────────────────────
function ConnectedAccountCard({ conn, onDisconnect, onTest, onToggle, onSync, onSyncRetro, onUpdateSettings, isDark, currentUser }) {
  const isAdmin = currentUser?.role === 'admin';
  const ownerId = conn.owner_user_id || conn.user_id || null;
  const isOtherUser = !!(isAdmin && ownerId && currentUser?.id && String(ownerId) !== String(currentUser.id));
  const [adminPaused,   setAdminPaused]   = useState(!!conn.admin_paused);
  const [adminDisabled, setAdminDisabled] = useState(!!conn.admin_disabled);
  useEffect(() => { setAdminPaused(!!conn.admin_paused); }, [conn.admin_paused]);
  useEffect(() => { setAdminDisabled(!!conn.admin_disabled); }, [conn.admin_disabled]);
  const toggleAdminFlag = async (field, next) => {
    if (field === 'admin_paused') setAdminPaused(next); else setAdminDisabled(next);
    try {
      await api.patch(`/email/connections/${encodeURIComponent(conn.email_address)}`, { [field]: next });
      onUpdateSettings && onUpdateSettings(conn.email_address, { [field]: next });
      toast.success(next ? `Admin ${field === 'admin_paused' ? 'paused' : 'disabled'} ${conn.email_address}` : `Admin ${field === 'admin_paused' ? 'resumed' : 'enabled'} ${conn.email_address}`);
    } catch { toast.error('Admin action failed'); }
  };
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelVal,     setLabelVal]     = useState(conn.label || conn.email_address);
  const [testing,      setTesting]      = useState(false);
  const [syncing,      setSyncing]      = useState(false);
  const [retroSyncing, setRetroSyncing] = useState(false);
  const [showRetroMenu,setShowRetroMenu]= useState(false);
  const [retroMenuPos, setRetroMenuPos] = useState(null);

  // ── Per-account settings panel ────────────────────────────────────────────
  const [showSettings,    setShowSettings]    = useState(false);
  const [acctAutoSync,    setAcctAutoSync]    = useState(!!conn.auto_sync);
  const [acctLinkedPage,  setAcctLinkedPage]  = useState(conn.linked_page || "all");
  const [savingSettings,  setSavingSettings]  = useState(false);

  useEffect(() => { setAcctAutoSync(!!conn.auto_sync); },         [conn.auto_sync]);
  useEffect(() => { setAcctLinkedPage(conn.linked_page || "all"); }, [conn.linked_page]);

  const LINKED_PAGE_OPTIONS = [
    { value: "all",       label: "All Pages",  icon: "🌐" },
    { value: "leads",     label: "Leads",      icon: "🎯" },
    { value: "invoicing", label: "Invoicing",  icon: "📄" },
    { value: "tasks",     label: "Tasks",      icon: "✅" },
    { value: "reminders", label: "Reminders",  icon: "🔔" },
    { value: "visits",    label: "Visits",     icon: "📍" },
  ];

  const saveAccountSettings = async (patch) => {
    setSavingSettings(true);
    try {
      await api.patch(`/email/connections/${encodeURIComponent(conn.email_address)}`, patch);
      onUpdateSettings && onUpdateSettings(conn.email_address, patch);
      toast.success("Account settings saved");
    } catch {
      toast.error("Failed to save account settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const handleToggleAutoSync = async () => {
    const next = !acctAutoSync;
    setAcctAutoSync(next);
    await saveAccountSettings({ auto_sync: next });
  };

  const handleChangeLinkedPage = async (val) => {
    setAcctLinkedPage(val);
    await saveAccountSettings({ linked_page: val });
  };
  const retroBtnRef = useRef(null);

  // ── Keyword sync controls (per account) ──────────────────────────────────
  const [showKwPanel,   setShowKwPanel]  = useState(false);
  const [kwDraft,       setKwDraft]      = useState("");
  const [keywords,      setKeywords]     = useState(Array.isArray(conn.keywords) ? conn.keywords : []);
  const [matchMode,     setMatchMode]    = useState(conn.keyword_match_mode === "and" ? "and" : "or");
  const [caseSensitive, setCaseSensitive]= useState(!!conn.keyword_case_sensitive);
  // Default = auto-save matches. When false, matches must be confirmed in preview.
  const [autoSaveKw,    setAutoSaveKw]   = useState(conn.keyword_auto_save !== false);

  useEffect(() => { setKeywords(Array.isArray(conn.keywords) ? conn.keywords : []); }, [conn.keywords]);
  useEffect(() => { setMatchMode(conn.keyword_match_mode === "and" ? "and" : "or"); }, [conn.keyword_match_mode]);
  useEffect(() => { setCaseSensitive(!!conn.keyword_case_sensitive); }, [conn.keyword_case_sensitive]);
  useEffect(() => { setAutoSaveKw(conn.keyword_auto_save !== false); }, [conn.keyword_auto_save]);

  const persistKwSettings = async (patch) => {
    try {
      await api.patch(`/email/connections/${encodeURIComponent(conn.email_address)}`, patch);
      onUpdateSettings && onUpdateSettings(conn.email_address, patch);
    } catch {
      toast.error("Failed to update keyword settings");
    }
  };

  const addKeyword = async () => {
    const v = kwDraft.trim();
    if (!v) return;
    if (keywords.some(k => k.toLowerCase() === v.toLowerCase())) {
      setKwDraft(""); return;
    }
    const next = [...keywords, v];
    setKeywords(next); setKwDraft("");
    await persistKwSettings({ keywords: next });
  };

  const removeKeyword = async (kw) => {
    const next = keywords.filter(k => k !== kw);
    setKeywords(next);
    await persistKwSettings({ keywords: next });
  };

  const changeMode = async (m) => {
    setMatchMode(m);
    await persistKwSettings({ keyword_match_mode: m });
  };

  const toggleCase = async () => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    await persistKwSettings({ keyword_case_sensitive: next });
  };

  const toggleAutoSave = async () => {
    const next = !autoSaveKw;
    setAutoSaveKw(next);
    await persistKwSettings({ keyword_auto_save: next });
  };

  const RETRO_PRESETS = [
    { daysBack: 30,   label: "Last 30 days" },
    { daysBack: 90,   label: "Last 90 days" },
    { daysBack: 365,  label: "Last 1 year" },
    { daysBack: null, label: "All time" },
  ];

  const handleRetroSync = async (preset) => {
    setShowRetroMenu(false);
    setRetroSyncing(true);
    try { await onSyncRetro(conn.email_address, preset.daysBack, preset.label); }
    finally { setRetroSyncing(false); }
  };

  const toggleRetroMenu = () => {
    if (!showRetroMenu && retroBtnRef.current) {
      const r = retroBtnRef.current.getBoundingClientRect();
      setRetroMenuPos({ top: r.bottom + 6, left: r.right - 176 }); // 176px = w-44
    }
    setShowRetroMenu(v => !v);
  };

  useEffect(() => {
    if (!showRetroMenu) return;
    const close = () => setShowRetroMenu(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); };
  }, [showRetroMenu]);

  const color    = PROVIDER_COLORS[conn.provider] || PROVIDER_COLORS.other;
  const icon     = PROVIDER_ICONS[conn.provider]  || PROVIDER_ICONS.other;
  const hasError = !!conn.sync_error;

  const PAGE_LABELS = {
    all:      { label: "All Pages",  icon: "🌐" },
    leads:    { label: "Leads",      icon: "🎯" },
    invoicing:{ label: "Invoicing",  icon: "📄" },
    tasks:    { label: "Tasks",      icon: "✅" },
    reminders:{ label: "Reminders",  icon: "🔔" },
    visits:   { label: "Visits",     icon: "📍" },
  };
  const linkedPageInfo = PAGE_LABELS[conn.linked_page || "all"] || PAGE_LABELS.all;

  const handleSaveLabel = async () => {
    try { await api.patch(`/email/connections/${encodeURIComponent(conn.email_address)}`, { label: labelVal }); toast.success("Label updated"); setEditingLabel(false); }
    catch { toast.error("Failed to update label"); }
  };
  const handleTest  = async () => { setTesting(true); try { await onTest(conn.email_address); } finally { setTesting(false); } };
  const handleSync  = async () => { setSyncing(true); try { await onSync(conn.email_address, conn.last_synced); } finally { setSyncing(false); } };


  return (
    <motion.div variants={itemVariants} whileHover={{ y: -2, transition: springPhysics.lift }}>
      <SectionCard>
        <div className="px-4 py-3.5 flex items-center gap-3 border-b border-slate-100 dark:border-slate-700"
          style={{ backgroundColor: hasError ? (isDark ? "rgba(239,68,68,0.08)" : "#fef2f2") : undefined }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-black text-white flex-shrink-0"
            style={{ backgroundColor: conn.is_active ? color : "#9CA3AF" }}>{icon}</div>
          <div className="flex-1 min-w-0">
            {editingLabel ? (
              <div className="flex items-center gap-2">
                <input autoFocus value={labelVal} onChange={e => setLabelVal(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") handleSaveLabel(); if (e.key === "Escape") setEditingLabel(false); }}
                  className="flex-1 px-2 py-1 text-sm rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-400"
                  style={{ backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.text : "#1e293b" }} />
                <button onClick={handleSaveLabel} className="p-1 text-emerald-500 hover:text-emerald-400"><Check className="w-4 h-4" /></button>
                <button onClick={() => setEditingLabel(false)} className="p-1" style={{ color: isDark ? D.muted : "#9ca3af" }}><X className="w-4 h-4" /></button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <p className="font-semibold text-sm truncate" style={{ color: isDark ? D.text : "#1e293b" }}>{conn.label || conn.email_address}</p>
                <button onClick={() => setEditingLabel(true)} className="p-0.5 flex-shrink-0 transition-colors" style={{ color: isDark ? D.dimmer : "#cbd5e1" }}>
                  <Edit2 className="w-3 h-3" />
                </button>
              </div>
            )}
            <p className="text-xs truncate" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>{conn.email_address}</p>
            {isOtherUser && (
              <span className="inline-flex items-center gap-1 mt-1 px-2 py-0.5 rounded-md text-[10px] font-bold border" style={{ backgroundColor: isDark ? "rgba(139,92,246,0.12)" : "#f5f3ff", borderColor: isDark ? "rgba(139,92,246,0.35)" : "#ddd6fe", color: isDark ? "#c4b5fd" : "#6d28d9" }}>
                <Users className="w-3 h-3" /> {conn.owner_name || conn.owner_email || "Other user"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Linked page badge */}
            <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg border"
              style={{
                backgroundColor: isDark ? "rgba(99,102,241,0.12)" : "#eef2ff",
                borderColor: isDark ? "rgba(99,102,241,0.3)" : "#c7d2fe",
                color: isDark ? "#a5b4fc" : "#4f46e5",
              }}>
              {linkedPageInfo.icon} {linkedPageInfo.label}
            </span>
            {hasError ? (
              <span className="flex items-center gap-1 text-xs font-semibold text-red-500 px-2 py-1 rounded-full"
                style={{ backgroundColor: isDark ? "rgba(239,68,68,0.15)" : "#fee2e2" }}>
                <AlertCircle className="w-3 h-3" /> Error
              </span>
            ) : conn.is_active ? (
              <span className="flex items-center gap-1 text-xs font-semibold text-emerald-500 px-2 py-1 rounded-full"
                style={{ backgroundColor: isDark ? "rgba(31,175,90,0.15)" : "#dcfce7" }}>
                <CheckCircle2 className="w-3 h-3" /> Active
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full"
                style={{ color: isDark ? D.muted : "#64748b", backgroundColor: isDark ? D.raised : "#f1f5f9" }}>
                <WifiOff className="w-3 h-3" /> Paused
              </span>
            )}
          </div>
        </div>
        {hasError && (
          <div className="mx-4 mt-3 p-3 rounded-xl border text-xs"
            style={{ backgroundColor: isDark ? "rgba(239,68,68,0.08)" : "#fef2f2", borderColor: isDark ? "#7f1d1d" : "#fecaca", color: isDark ? "#fca5a5" : "#dc2626" }}>
            {conn.sync_error}
          </div>
        )}
        <div className="px-4 py-2.5 flex items-center gap-2 flex-wrap">
          {[
            { color: COLORS.purple,       border: "#DDD6FE", bg: isDark ? "rgba(139,92,246,0.12)" : "#F5F3FF", icon: CheckSquare, label: "Todos"     },
            { color: COLORS.deepBlue,     border: "#BFDBFE", bg: isDark ? "rgba(13,59,102,0.20)"  : "#EFF6FF", icon: Bell,        label: "Reminders" },
            { color: COLORS.emeraldGreen, border: "#BBF7D0", bg: isDark ? "rgba(31,175,90,0.12)"  : "#F0FDF4", icon: Calendar,    label: "Visits"    },
          ].map(item => (
            <div key={item.label} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border"
              style={{ backgroundColor: item.bg, borderColor: item.border, color: item.color }}>
              <item.icon className="w-3 h-3" /> {item.label}
            </div>
          ))}
          {conn.last_synced && (
            <span className="text-[10px] ml-auto font-mono" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
              Sync base: {format(parseISO(conn.last_synced), "dd MMM yy, h:mm a")}
            </span>
          )}
        </div>


        {isAdmin && isOtherUser && (
          <div className="mx-4 mb-3 p-3 rounded-xl border space-y-2"
            style={{ backgroundColor: isDark ? "rgba(139,92,246,0.06)" : "#faf5ff", borderColor: isDark ? "rgba(139,92,246,0.30)" : "#e9d5ff" }}>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest"
              style={{ color: isDark ? "#c4b5fd" : "#7c3aed" }}>
              <Shield className="w-3.5 h-3.5" /> Admin controls
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>Pause sync</p>
                <p className="text-[10px]" style={{ color: isDark ? D.dimmer : "#64748b" }}>Account stays connected; new mail will not be fetched until resumed.</p>
              </div>
              <button onClick={() => toggleAdminFlag("admin_paused", !adminPaused)} className="flex-shrink-0 active:scale-95 transition-all">
                {adminPaused ? <ToggleRight className="w-9 h-9" style={{ color: COLORS.amber }} /> : <ToggleLeft className="w-9 h-9" style={{ color: isDark ? D.dimmer : "#94a3b8" }} />}
              </button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[12px] font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>Disable integration</p>
                <p className="text-[10px]" style={{ color: isDark ? D.dimmer : "#64748b" }}>Hides the account from the owning user and blocks all scans until re-enabled.</p>
              </div>
              <button onClick={() => toggleAdminFlag("admin_disabled", !adminDisabled)} className="flex-shrink-0 active:scale-95 transition-all">
                {adminDisabled ? <ToggleRight className="w-9 h-9" style={{ color: COLORS.red }} /> : <ToggleLeft className="w-9 h-9" style={{ color: isDark ? D.dimmer : "#94a3b8" }} />}
              </button>
            </div>
            {(adminPaused || adminDisabled) && (
              <div className="flex items-center gap-1.5 text-[10px] font-semibold px-2 py-1 rounded-md"
                style={{ backgroundColor: isDark ? "rgba(245,158,11,0.10)" : "#fffbeb", color: isDark ? "#fcd34d" : "#92400e" }}>
                <AlertTriangle className="w-3 h-3" /> {adminDisabled ? "Integration disabled by admin" : "Sync paused by admin"}
              </div>
            )}
          </div>
        )}
        {/* ── Linked Users Panel ── */}
        <LinkedUsersPanel
          conn={conn}
          isDark={isDark}
          isAdmin={isAdmin}
          currentUserId={currentUser?.id ? String(currentUser.id) : ""}
        />

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-4 py-3 border-t border-slate-100 dark:border-slate-700"
          style={{ backgroundColor: isDark ? D.raised : "#f8fafc" }}>
          <p className="text-xs truncate" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
            {conn.last_synced
              ? `Synced ${format(parseISO(conn.last_synced), "MMM d, h:mm a")} · only new emails since this date are fetched`
              : conn.connected_at ? `Connected ${format(parseISO(conn.connected_at), "MMM d, yyyy")} · first full scan` : ""}
            {conn.imap_host && <><span className="mx-1.5">·</span><span className="font-medium">{conn.imap_host}</span></>}
          </p>
          <div className="flex items-center gap-1 flex-shrink-0">
            {(adminDisabled || adminPaused) && (
              <span className="flex items-center gap-1 text-[10px] font-semibold px-2 py-1 rounded-lg mr-1"
                style={{ backgroundColor: isDark ? "rgba(245,158,11,0.10)" : "#fffbeb", color: isDark ? "#fcd34d" : "#92400e" }}>
                <AlertTriangle className="w-3 h-3" />
                {adminDisabled ? "Disabled — enable to sync" : "Paused — resume to sync"}
              </span>
            )}
            <button onClick={handleSync} disabled={syncing || adminDisabled || adminPaused}
              title={adminDisabled ? "Integration is disabled by admin — enable it first" : adminPaused ? "Sync is paused by admin — resume it first" : undefined}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 hover:bg-slate-200 dark:hover:bg-slate-700 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ color: isDark ? D.muted : "#64748b" }}>
              {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Sync Now
            </button>
            <div className="relative">
              <button ref={retroBtnRef} onClick={toggleRetroMenu} disabled={retroSyncing || adminDisabled || adminPaused}
                title={adminDisabled ? "Integration is disabled by admin" : adminPaused ? "Sync is paused by admin" : "Re-scan older mail (e.g. last 90 days / 1 year / all time) — already-imported emails are skipped automatically"}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 hover:bg-slate-200 dark:hover:bg-slate-700 whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ color: isDark ? D.muted : "#64748b" }}>
                {retroSyncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Clock className="w-3.5 h-3.5" />}
                Sync Older Mail <ChevronDown className="w-3 h-3" />
              </button>
              {showRetroMenu && retroMenuPos && createPortal(
                <>
                  <div className="fixed inset-0 z-[9998]" onClick={() => setShowRetroMenu(false)} />
                  <div className="fixed z-[9999] w-44 rounded-xl border shadow-lg overflow-hidden"
                    style={{ top: retroMenuPos.top, left: retroMenuPos.left, backgroundColor: isDark ? D.card : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0" }}>
                    {RETRO_PRESETS.map(preset => (
                      <button key={preset.label} onClick={() => handleRetroSync(preset)}
                        className="w-full text-left px-3 py-2 text-xs font-medium transition-colors hover:bg-slate-100 dark:hover:bg-slate-700"
                        style={{ color: isDark ? D.text : "#1e293b" }}>
                        {preset.label}
                      </button>
                    ))}
                    <div className="px-3 py-1.5 text-[10px] border-t" style={{ color: isDark ? D.dimmer : "#94a3b8", borderColor: isDark ? D.border : "#f1f5f9" }}>
                      Duplicates skipped automatically
                    </div>
                  </div>
                </>,
                document.body
              )}
            </div>
            <button onClick={handleTest} disabled={testing}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 hover:bg-slate-200 dark:hover:bg-slate-700 whitespace-nowrap"
              style={{ color: isDark ? D.muted : "#64748b" }}>
              {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wifi className="w-3.5 h-3.5" />} Test
            </button>
            <button onClick={() => onToggle(conn.email_address, !conn.is_active)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all active:scale-95 hover:bg-slate-200 dark:hover:bg-slate-700 whitespace-nowrap"
              style={{ color: isDark ? D.muted : "#64748b" }}>
              {conn.is_active ? "Pause" : "Resume"}
            </button>
            <button
              onClick={() => setShowSettings(s => !s)}
              title="Account settings"
              className={`p-1.5 rounded-lg transition-all active:scale-90 ${showSettings ? "bg-blue-100 dark:bg-blue-900/40" : "hover:bg-slate-200 dark:hover:bg-slate-700"}`}
              style={{ color: showSettings ? COLORS.mediumBlue : (isDark ? D.muted : "#94a3b8") }}>
              <Settings2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onDisconnect(conn.email_address)} className="p-1.5 rounded-lg transition-all active:scale-90"
              style={{ color: isDark ? D.muted : "#94a3b8" }}
              onMouseEnter={e => { e.currentTarget.style.color = COLORS.red; e.currentTarget.style.backgroundColor = isDark ? "rgba(239,68,68,0.12)" : "#fef2f2"; }}
              onMouseLeave={e => { e.currentTarget.style.color = isDark ? D.muted : "#94a3b8"; e.currentTarget.style.backgroundColor = "transparent"; }}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Per-account Settings Panel ──────────────────────────────────── */}
        <AnimatePresence>
          {showSettings && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
              className="overflow-hidden">
              <div className="border-t border-slate-100 dark:border-slate-700 px-4 py-4 space-y-4"
                style={{ backgroundColor: isDark ? "rgba(30,41,59,0.6)" : "#f8fafc" }}>

                {/* Header */}
                <div className="flex items-center gap-2">
                  <Settings2 className="w-4 h-4" style={{ color: COLORS.mediumBlue }} />
                  <span className="text-xs font-bold uppercase tracking-widest" style={{ color: isDark ? "#93c5fd" : COLORS.mediumBlue }}>
                    Account Settings
                  </span>
                  {savingSettings && <Loader2 className="w-3.5 h-3.5 animate-spin ml-auto" style={{ color: COLORS.mediumBlue }} />}
                </div>

                {/* Auto Sync Toggle */}
                <div className="flex items-center justify-between gap-4 p-3 rounded-xl border"
                  style={{ backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0" }}>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <RefreshCw className="w-3.5 h-3.5" style={{ color: acctAutoSync ? COLORS.emeraldGreen : (isDark ? D.dimmer : "#94a3b8") }} />
                      <p className="text-sm font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>Auto Sync</p>
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${acctAutoSync ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400" : "bg-slate-100 dark:bg-slate-700 text-slate-400"}`}>
                        {acctAutoSync ? "ON" : "OFF"}
                      </span>
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: isDark ? D.dimmer : "#64748b" }}>
                      Automatically fetch new emails daily without manual sync
                    </p>
                  </div>
                  <button
                    onClick={handleToggleAutoSync}
                    disabled={savingSettings}
                    className="flex-shrink-0 active:scale-95 transition-all disabled:opacity-50">
                    <div className={`relative w-11 h-6 rounded-full transition-colors ${acctAutoSync ? "bg-emerald-500" : (isDark ? "bg-slate-600" : "bg-slate-300")}`}>
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${acctAutoSync ? "translate-x-5" : "translate-x-0"}`} />
                    </div>
                  </button>
                </div>

                {/* Linked Page Picker */}
                <div className="p-3 rounded-xl border space-y-2"
                  style={{ backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0" }}>
                  <div className="flex items-center gap-1.5 mb-2">
                    <Tag className="w-3.5 h-3.5" style={{ color: COLORS.deepBlue }} />
                    <p className="text-sm font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>Link to Page</p>
                    <span className="text-xs ml-1" style={{ color: isDark ? D.dimmer : "#64748b" }}>events from this email appear in the selected page</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {LINKED_PAGE_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => handleChangeLinkedPage(opt.value)}
                        disabled={savingSettings}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl border text-xs font-semibold transition-all active:scale-95 disabled:opacity-50"
                        style={{
                          backgroundColor: acctLinkedPage === opt.value
                            ? (isDark ? "rgba(31,111,178,0.20)" : "#eff6ff")
                            : (isDark ? D.card : "#f8fafc"),
                          borderColor: acctLinkedPage === opt.value
                            ? COLORS.mediumBlue
                            : (isDark ? D.border : "#e2e8f0"),
                          color: acctLinkedPage === opt.value
                            ? COLORS.mediumBlue
                            : (isDark ? D.muted : "#64748b"),
                        }}>
                        <span>{opt.icon}</span>
                        <span className="flex-1 text-left">{opt.label}</span>
                        {acctLinkedPage === opt.value && <Check className="w-3 h-3 ml-auto flex-shrink-0" />}
                      </button>
                    ))}
                  </div>
                </div>

              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </SectionCard>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN PREVIEW PANEL
// Shows all extracted events before anything is saved. User checks/unchecks.
// Past-dated events are greyed out + unchecked. Already-saved are disabled.
// ─────────────────────────────────────────────────────────────────────────────
function ScanPreviewPanel({ events, savedKeys, onSaved, onDismiss, isDark }) {
  // Enrich events with computed flags on first render / when events/savedKeys change
  const enriched = useMemo(() => events.map(ev => ({
    ...ev,
    _key:          eventKey(ev),
    _past:         isEventPast(ev),
    _alreadySaved: savedKeys.has(eventKey(ev)),
    _cat:          resolveCategory(ev),
  })), [events, savedKeys]);

  // Default checked state: true only if future & not already saved
  const [checked, setChecked] = useState(() => {
    const m = {};
    events.forEach(ev => {
      const k = eventKey(ev);
      m[k] = !isEventPast(ev) && !savedKeys.has(k);
    });
    return m;
  });

  // Per-event save-type overrides
  const [saveTypes, setSaveTypes] = useState(() => {
    const m = {};
    events.forEach(ev => { m[eventKey(ev)] = resolveCategory(ev); });
    return m;
  });

  const [saving,   setSaving]   = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  const futureSelectable = enriched.filter(e => !e._past && !e._alreadySaved);
  const selectedCount    = futureSelectable.filter(e => checked[e._key]).length;
  const pastCount        = enriched.filter(e => e._past).length;
  const dupCount         = enriched.filter(e => e._alreadySaved).length;
  const futureCount      = futureSelectable.length;

  const toggleAll = (val) => {
    const next = { ...checked };
    futureSelectable.forEach(e => { next[e._key] = val; });
    setChecked(next);
  };

  // Group by current save-type (which user may have changed via dropdown)
  const groupedByType = useMemo(() => {
    const g = { todo: [], reminder: [], visit: [] };
    enriched.forEach(ev => {
      const cat = saveTypes[ev._key] || ev._cat;
      if (g[cat]) g[cat].push(ev);
    });
    return g;
  }, [enriched, saveTypes]);

  const handleSaveSelected = async () => {
    const toSave = enriched.filter(e => !e._past && !e._alreadySaved && checked[e._key]);
    if (toSave.length === 0) { toast.error("No future events selected to save"); return; }
    setSaving(true);
    setProgress({ done: 0, total: toSave.length });

    const newlySavedKeys = new Set();
    let ok = 0, fail = 0;

    for (const ev of toSave) {
      const cat = saveTypes[ev._key] || ev._cat;
      try {
        if (cat === "todo") {
          const dateStr = ev.date || new Date().toISOString().slice(0, 10);
          await api.post("/email/save-as-todo", {
            event_id:    ev.id || ev.event_id || "",
            title:       ev.title,
            description: [ev.organizer && `From: ${ev.organizer}`, ev.description && `Notes: ${ev.description}`, ev.source_from && `Sender: ${ev.source_from}`].filter(Boolean).join("\n") || null,
            remind_at:   `${dateStr}T10:00:00`,
          });
        } else if (cat === "reminder") {
          const dateStr = ev.date || new Date().toISOString().slice(0, 10);
          const timeStr = ev.time || "10:00";
          let remindAt;
          try { remindAt = new Date(`${dateStr}T${timeStr}:00+05:30`).toISOString(); }
          catch { remindAt = new Date(Date.now() + 86400000).toISOString(); }
          await api.post("/email/save-as-reminder", {
            event_id:    ev.id || ev.event_id || "",
            title:       ev.title,
            description: [ev.organizer && `From: ${ev.organizer}`, ev.description && `Notes: ${ev.description}`, ev.source_subject && `Subject: ${ev.source_subject}`].filter(Boolean).join("\n") || null,
            remind_at:   remindAt,
          });
        } else {
          await api.post("/email/save-as-visit", {
            event_id:   ev.id || ev.event_id || "",
            title:      ev.title,
            visit_date: ev.date || new Date().toISOString().slice(0, 10),
            notes:      ev.description || ev.source_subject || "",
          });
        }
        newlySavedKeys.add(ev._key);
        ok++;
      } catch { fail++; }
      setProgress(p => ({ ...p, done: p.done + 1 }));
    }

    setSaving(false);
    onSaved(newlySavedKeys);   // bubble up so parent updates savedKeys state
    if (ok > 0)   toast.success(`✓ Saved ${ok} event${ok > 1 ? "s" : ""} successfully`);
    if (fail > 0) toast.error(`${fail} event${fail > 1 ? "s" : ""} failed to save`);
  };

  const catGroups = [
    { cat: "todo",     icon: CheckSquare, color: COLORS.purple,       label: "Todos — Action Required"           },
    { cat: "reminder", icon: Bell,        color: COLORS.deepBlue,     label: "Reminders — Hearings & Deadlines"  },
    { cat: "visit",    icon: Calendar,    color: COLORS.emeraldGreen, label: "Visits — Meetings & Consultations" },
  ];

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <SectionCard>
        {/* ── Panel Header ── */}
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-700"
          style={{ background: `linear-gradient(135deg,${COLORS.deepBlue}10,${COLORS.mediumBlue}06)` }}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-purple-50 dark:bg-purple-900/40">
                <Eye className="w-4 h-4 text-purple-500" />
              </div>
              <div>
                <h3 className="font-bold text-sm text-slate-800 dark:text-slate-100">
                  Preview Before Saving
                  <span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400">
                    {events.length} found
                  </span>
                </h3>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  Review which events to save — past dates and duplicates are pre-filtered out
                </p>
              </div>
            </div>
            <button onClick={onDismiss}
              className="p-1.5 rounded-lg transition-all hover:bg-slate-100 dark:hover:bg-slate-700"
              style={{ color: isDark ? D.muted : "#94a3b8" }}>
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Summary chips */}
          <div className="flex flex-wrap gap-2 mt-3">
            <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" /> {futureCount} future (saveable)
            </span>
            {pastCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-slate-100 dark:bg-slate-700 text-slate-500">
                <CalendarOff className="w-3 h-3" /> {pastCount} past (auto-skipped)
              </span>
            )}
            {dupCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400">
                <CheckCircle2 className="w-3 h-3" /> {dupCount} already saved
              </span>
            )}
          </div>

          {/* Select controls */}
          {futureCount > 0 && (
            <div className="flex items-center gap-2 mt-3 pt-2.5 border-t border-slate-100 dark:border-slate-700">
              <span className="text-xs font-semibold" style={{ color: isDark ? D.muted : "#64748b" }}>Select:</span>
              <button onClick={() => toggleAll(true)}
                className="text-xs font-bold px-2.5 py-1 rounded-lg transition-all active:scale-95 border"
                style={{ color: COLORS.mediumBlue, borderColor: COLORS.mediumBlue + "40", backgroundColor: isDark ? COLORS.mediumBlue + "15" : COLORS.mediumBlue + "08" }}>
                All Future ({futureCount})
              </button>
              <button onClick={() => toggleAll(false)}
                className="text-xs font-semibold px-2.5 py-1 rounded-lg transition-all active:scale-95 border"
                style={{ color: isDark ? D.muted : "#64748b", borderColor: isDark ? D.border : "#e2e8f0" }}>
                None
              </button>
              <span className="ml-auto text-xs font-bold" style={{ color: isDark ? D.text : "#1e293b" }}>
                {selectedCount} selected
              </span>
            </div>
          )}
        </div>

        {/* ── Event Groups ── */}
        <div className="p-4 space-y-5">
          {catGroups.map(({ cat, icon: Icon, color, label }) => {
            const group = groupedByType[cat];
            if (!group || group.length === 0) return null;
            return (
              <div key={cat} className="space-y-2">
                <p className="text-xs font-bold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
                  <Icon className="w-3.5 h-3.5" /> {label} ({group.length})
                </p>
                {group.map(ev => {
                  const cfg        = CATEGORY_CONFIG[ev._cat];
                  const isSelectable = !ev._past && !ev._alreadySaved;
                  const isChecked    = !!checked[ev._key];

                  return (
                    <div key={ev._key} className="rounded-xl border transition-all"
                      style={{
                        backgroundColor: ev._past || ev._alreadySaved
                          ? (isDark ? "rgba(255,255,255,0.02)" : "#f8fafc")
                          : isChecked ? (isDark ? cfg.darkBg : cfg.bg) : (isDark ? "rgba(255,255,255,0.03)" : "#fdfdfe"),
                        borderColor: ev._past || ev._alreadySaved
                          ? (isDark ? D.border : "#e2e8f0")
                          : isChecked ? cfg.border : (isDark ? D.border : "#e2e8f0"),
                        opacity: ev._past ? 0.5 : 1,
                      }}>
                      <div className="p-3 flex items-start gap-3">
                        {/* Checkbox */}
                        <button
                          disabled={!isSelectable}
                          onClick={() => isSelectable && setChecked(p => ({ ...p, [ev._key]: !p[ev._key] }))}
                          className={`flex-shrink-0 mt-0.5 transition-all ${isSelectable ? "cursor-pointer hover:opacity-80 active:scale-90" : "cursor-not-allowed opacity-40"}`}
                          style={{ color: isChecked && isSelectable ? cfg.color : (isDark ? D.dimmer : "#cbd5e1") }}>
                          {isChecked && isSelectable
                            ? <CheckSquare className="w-[18px] h-[18px]" />
                            : <Square      className="w-[18px] h-[18px]" />}
                        </button>

                        {/* Info */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
                            {ev.save_category && (
                              <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full text-white"
                                style={{ backgroundColor: CATEGORY_CONFIG[ev.save_category]?.color || "#6B7280" }}>
                                AI: {(CATEGORY_CONFIG[ev.save_category]?.label || "").toUpperCase()}
                              </span>
                            )}
                            {ev._past && (
                              <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-slate-400 text-white flex items-center gap-0.5">
                                <CalendarOff className="w-2.5 h-2.5" /> PAST DATE — SKIPPED
                              </span>
                            )}
                            {ev._alreadySaved && (
                              <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-blue-500 text-white flex items-center gap-0.5">
                                <CheckCircle2 className="w-2.5 h-2.5" /> ALREADY SAVED
                              </span>
                            )}
                          </div>
                          <p className="text-sm font-bold truncate"
                            style={{ color: (ev._past || ev._alreadySaved) ? (isDark ? D.dimmer : "#94a3b8") : (isDark ? D.text : "#1e293b") }}>
                            {ev.title}
                          </p>
                          <p className="text-xs font-mono mt-0.5" style={{ color: ev._past ? (isDark ? D.dimmer : "#94a3b8") : cfg.color }}>
                            {ev.date ? `📅 ${ev.date}${ev.time ? ` · ${ev.time}` : ""}` : "Date not found"}
                            {ev.email_account && <span className="ml-2" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>· {ev.email_account}</span>}
                          </p>
                          {ev.description && (
                            <p className="text-xs mt-0.5 truncate" style={{ color: isDark ? D.muted : "#64748b" }}>{ev.description}</p>
                          )}
                        </div>

                        {/* Save-type override (only for selectable) */}
                        {isSelectable && (
                          <select value={saveTypes[ev._key] || ev._cat}
                            onChange={e => setSaveTypes(p => ({ ...p, [ev._key]: e.target.value }))}
                            className="text-[11px] font-bold rounded-lg border px-2 py-1 focus:outline-none cursor-pointer flex-shrink-0"
                            style={{ borderColor: cfg.border, color: cfg.color, backgroundColor: isDark ? D.raised : cfg.bg }}>
                            <option value="todo">→ Todo</option>
                            <option value="reminder">→ Reminder</option>
                            <option value="visit">→ Visit</option>
                          </select>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}

          {futureCount === 0 && (
            <div className="py-8 text-center">
              <CalendarOff className="w-8 h-8 mx-auto mb-2" style={{ color: isDark ? D.dimmer : "#cbd5e1" }} />
              <p className="text-sm font-medium" style={{ color: isDark ? D.muted : "#64748b" }}>
                {events.length === 0
                  ? "No events found in scanned emails."
                  : "All events are past-dated or already saved — nothing new to add."}
              </p>
            </div>
          )}
        </div>

        {/* ── Footer / Save button ── */}
        {futureCount > 0 && (
          <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-700 flex items-center justify-between gap-3"
            style={{ backgroundColor: isDark ? D.raised : "#f8fafc" }}>
            <div className="text-xs" style={{ color: isDark ? D.muted : "#64748b" }}>
              {saving
                ? <span className="flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" />Saving {progress.done} / {progress.total}…</span>
                : <><span className="font-bold" style={{ color: isDark ? D.text : "#1e293b" }}>{selectedCount}</span> of {futureCount} future events selected</>
              }
            </div>
            <div className="flex gap-2">
              <button onClick={onDismiss} disabled={saving}
                className="px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all disabled:opacity-40"
                style={{ borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.muted : "#64748b" }}>
                Dismiss
              </button>
              <button onClick={handleSaveSelected} disabled={saving || selectedCount === 0}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold text-white transition-all active:scale-95 disabled:opacity-50"
                style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                {saving
                  ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Saving…</>
                  : <><Save className="w-3.5 h-3.5" />Save {selectedCount > 0 ? `${selectedCount} Selected` : "Selected"}</>}
              </button>
            </div>
          </div>
        )}
      </SectionCard>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SENDER WHITELIST MANAGER
// ─────────────────────────────────────────────────────────────────────────────
function SenderWhitelistManager({ isDark }) {
  const [senders,  setSenders]  = useState([]);
  const [expandedKw, setExpandedKw] = useState({}); // {email_address: bool}
  const [kwDrafts,   setKwDrafts]   = useState({}); // {email_address: "current draft"}
  const [loading,  setLoading]  = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [adding,   setAdding]   = useState(false);

  const inputStyle = { backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#d1d5db", color: isDark ? D.text : "#1e293b" };
  const inputCls = "px-3.5 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all";

  const fetchSenders = useCallback(async () => {
    try {
      const res = await api.get("/email/sender-whitelist");
      const list = (res.data?.senders || []).map(s => ({
        ...s,
        keywords: Array.isArray(s.keywords) ? s.keywords : [],
        keyword_match_mode: s.keyword_match_mode === "and" ? "and" : "or",
        keyword_case_sensitive: !!s.keyword_case_sensitive,
      }));
      setSenders(list);
    }
    catch { setSenders([]); } finally { setLoading(false); }
  }, []);
  useEffect(() => { fetchSenders(); }, [fetchSenders]);

  const handleAdd = async (emailAddr, label) => {
    const addr = (emailAddr || newEmail).trim().toLowerCase();
    const lbl  = label || newLabel;
    if (!addr) { toast.error("Enter an email or domain"); return; }
    if (senders.find(s => s.email_address === addr)) { toast.error("Already in whitelist"); return; }
    setAdding(true);
    try {
      const updated = [...senders, { email_address: addr, label: lbl || addr }];
      await api.put("/email/sender-whitelist", { senders: updated });
      setSenders(updated); setNewEmail(""); setNewLabel("");
      toast.success(`✓ ${addr} added to whitelist`);
    } catch { toast.error("Failed to add sender"); } finally { setAdding(false); }
  };

  const handleRemove = async (addr) => {
    const updated = senders.filter(s => s.email_address !== addr);
    try { await api.put("/email/sender-whitelist", { senders: updated }); setSenders(updated); toast.success(`${addr} removed`); }
    catch { toast.error("Failed to remove sender"); }
  };

  const persistSenders = async (next) => {
    setSenders(next);
    try { await api.put("/email/sender-whitelist", { senders: next }); }
    catch { toast.error("Failed to save keyword filter"); }
  };
  const addKeywordToSender = (addr) => {
    const draft = (kwDrafts[addr] || "").trim();
    if (!draft) return;
    const next = senders.map(s => {
      if (s.email_address !== addr) return s;
      const kws = Array.isArray(s.keywords) ? s.keywords : [];
      if (kws.some(k => k.toLowerCase() === draft.toLowerCase())) return s;
      return { ...s, keywords: [...kws, draft] };
    });
    setKwDrafts(d => ({ ...d, [addr]: "" }));
    persistSenders(next);
  };
  const removeKeywordFromSender = (addr, kw) => {
    const next = senders.map(s => s.email_address === addr
      ? { ...s, keywords: (s.keywords || []).filter(k => k !== kw) } : s);
    persistSenders(next);
  };
  const setSenderMode = (addr, mode) => {
    const next = senders.map(s => s.email_address === addr ? { ...s, keyword_match_mode: mode } : s);
    persistSenders(next);
  };
  const toggleSenderCase = (addr) => {
    const next = senders.map(s => s.email_address === addr ? { ...s, keyword_case_sensitive: !s.keyword_case_sensitive } : s);
    persistSenders(next);
  };

  return (
    <SectionCard>
      <CardHeaderRow
        iconBg={isDark ? "bg-emerald-900/40" : "bg-emerald-50"}
        icon={<Filter className="w-4 h-4 text-emerald-500" />}
        title="Sender Whitelist"
        subtitle="Only these senders will be scanned for events"
        badge={senders.length}
      />
      <div className="p-4 space-y-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest mb-2.5" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Quick Add — Recommended Senders</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_SENDERS.map(s => {
              const exists = senders.find(x => x.email_address === s.email_address);
              return (
                <button key={s.email_address} onClick={() => !exists && handleAdd(s.email_address, s.label)} disabled={!!exists}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all active:scale-95"
                  style={exists
                    ? { borderColor: isDark ? "#14532d" : "#bbf7d0", backgroundColor: isDark ? "rgba(31,175,90,0.12)" : "#f0fdf4", color: COLORS.emeraldGreen, cursor: "default" }
                    : { borderColor: isDark ? D.border : "#e2e8f0", backgroundColor: isDark ? D.raised : "#f8fafc", color: isDark ? D.muted : "#374151" }}
                  onMouseEnter={e => { if (!exists) { e.currentTarget.style.borderColor = COLORS.emeraldGreen + "60"; e.currentTarget.style.color = COLORS.emeraldGreen; } }}
                  onMouseLeave={e => { if (!exists) { e.currentTarget.style.borderColor = isDark ? D.border : "#e2e8f0"; e.currentTarget.style.color = isDark ? D.muted : "#374151"; } }}>
                  {exists ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}{s.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Add Custom Sender</p>
          <div className="flex gap-2">
            <input value={newEmail} onChange={e => setNewEmail(e.target.value)} placeholder="@domain.com or user@email.com"
              onKeyDown={e => e.key === "Enter" && handleAdd()} className={inputCls + " flex-1"} style={inputStyle} />
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="Label (optional)"
              onKeyDown={e => e.key === "Enter" && handleAdd()} className={inputCls + " w-36"} style={inputStyle} />
            <Button onClick={() => handleAdd()} disabled={adding} className="h-10 px-4 rounded-xl text-sm font-semibold text-white"
              style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>
        </div>
        {loading ? (
          <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>
        ) : senders.length === 0 ? (
          <div className="py-6 text-center">
            <Filter className="w-7 h-7 mx-auto mb-2 opacity-20" />
            <p className="text-xs" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
              No whitelist set — all senders are scanned.<br />Add senders above to restrict scanning.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Active Whitelist ({senders.length})</p>
            {senders.map(s => {
              const kws = Array.isArray(s.keywords) ? s.keywords : [];
              const isOpen = !!expandedKw[s.email_address];
              const mode = s.keyword_match_mode === "and" ? "and" : "or";
              return (
              <motion.div key={s.email_address} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="rounded-xl border overflow-hidden"
                style={{ backgroundColor: isDark ? "rgba(31,175,90,0.06)" : "#f0fdf4", borderColor: isDark ? "#14532d" : "#bbf7d0" }}>
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: isDark ? "rgba(31,175,90,0.20)" : "#dcfce7" }}>
                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold" style={{ color: isDark ? D.text : "#1e293b" }}>{s.label || s.email_address}</p>
                    {s.label && s.label !== s.email_address && (
                      <p className="text-[10px] font-mono" style={{ color: isDark ? D.muted : "#94a3b8" }}>{s.email_address}</p>
                    )}
                  </div>
                  <button onClick={() => setExpandedKw(e => ({ ...e, [s.email_address]: !e[s.email_address] }))}
                    className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-bold border transition-colors"
                    style={{
                      borderColor: kws.length ? (isDark ? "rgba(245,158,11,0.40)" : "#fde68a") : (isDark ? D.border : "#e2e8f0"),
                      backgroundColor: kws.length ? (isDark ? "rgba(245,158,11,0.12)" : "#fffbeb") : "transparent",
                      color: kws.length ? (isDark ? "#fcd34d" : "#b45309") : (isDark ? D.muted : "#475569"),
                    }}>
                    🔎 {kws.length ? `${kws.length} kw · ${mode.toUpperCase()}` : "Keywords"}
                    <ChevronDown className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`} />
                  </button>
                  <button onClick={() => handleRemove(s.email_address)} className="w-7 h-7 flex items-center justify-center rounded-lg transition-all active:scale-90"
                    style={{ color: isDark ? D.muted : "#94a3b8" }}
                    onMouseEnter={e => { e.currentTarget.style.color = COLORS.red; e.currentTarget.style.backgroundColor = isDark ? "rgba(239,68,68,0.12)" : "#fef2f2"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = isDark ? D.muted : "#94a3b8"; e.currentTarget.style.backgroundColor = "transparent"; }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                {isOpen && (
                  <div className="px-3 pb-3 pt-1 border-t space-y-2.5"
                    style={{ borderColor: isDark ? "rgba(31,175,90,0.20)" : "#bbf7d0", backgroundColor: isDark ? "rgba(15,23,42,0.30)" : "#ffffff" }}>
                    <p className="text-[10px] leading-relaxed" style={{ color: isDark ? D.dimmer : "#64748b" }}>
                      Only emails from <b>{s.email_address}</b> whose <b>Subject</b> matches these keywords are pulled. Leave empty to accept every email from this sender.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {kws.map(kw => (
                        <span key={kw} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border"
                          style={{ backgroundColor: isDark ? "rgba(99,102,241,0.12)" : "#eef2ff", borderColor: isDark ? "rgba(99,102,241,0.30)" : "#c7d2fe", color: isDark ? "#a5b4fc" : "#4338ca" }}>
                          {kw}
                          <button onClick={() => removeKeywordFromSender(s.email_address, kw)} className="opacity-70 hover:opacity-100">
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                      {kws.length === 0 && (
                        <span className="text-[11px] italic" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>No keywords — all subjects accepted</span>
                      )}
                    </div>
                    <div className="flex gap-2">
                      <input value={kwDrafts[s.email_address] || ""}
                        onChange={e => setKwDrafts(d => ({ ...d, [s.email_address]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addKeywordToSender(s.email_address); } }}
                        placeholder="Add a keyword (press Enter)"
                        className="flex-1 px-2.5 py-1.5 text-xs rounded-lg border focus:outline-none focus:ring-2 focus:ring-blue-400"
                        style={{ backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.text : "#1e293b" }} />
                      <button onClick={() => addKeywordToSender(s.email_address)}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white"
                        style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                        Add
                      </button>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="inline-flex rounded-lg border overflow-hidden text-[11px] font-semibold"
                        style={{ borderColor: isDark ? D.border : "#e2e8f0" }}>
                        {["or", "and"].map(m => (
                          <button key={m} onClick={() => setSenderMode(s.email_address, m)}
                            className="px-3 py-1.5 transition-colors"
                            style={{
                              backgroundColor: mode === m ? (isDark ? "rgba(99,102,241,0.20)" : "#eef2ff") : "transparent",
                              color: mode === m ? (isDark ? "#a5b4fc" : "#4338ca") : (isDark ? D.muted : "#64748b"),
                            }}>
                            {m.toUpperCase()}
                          </button>
                        ))}
                      </div>
                      <label className="flex items-center gap-2 text-[11px] font-semibold cursor-pointer"
                        style={{ color: isDark ? D.muted : "#475569" }}>
                        <input type="checkbox" checked={!!s.keyword_case_sensitive} onChange={() => toggleSenderCase(s.email_address)}
                          className="w-3.5 h-3.5 rounded accent-indigo-500" />
                        Case-sensitive
                      </label>
                    </div>
                  </div>
                )}
              </motion.div>
              );
            })}
            <button onClick={async () => {
              if (!window.confirm("Clear entire whitelist? Emails from ALL senders will be scanned again.")) return;
              try { await api.put("/email/sender-whitelist", { senders: [] }); setSenders([]); toast.success("Whitelist cleared"); }
              catch { toast.error("Failed to clear whitelist"); }
            }} className="text-xs font-semibold flex items-center gap-1 mt-1 active:scale-95 transition-all"
              style={{ color: isDark ? "#f87171" : COLORS.red }}>
              <Trash2 className="w-3 h-3" /> Clear entire whitelist
            </button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender Blacklist Manager
// ─────────────────────────────────────────────────────────────────────────────
// Validate "email" or "domain" entries for white/blacklist.
// Accepts: full email (a@b.co), bare domain (@b.co or b.co), prefix (noreply@)
function validateSenderEntry(raw) {
  const v = (raw || "").trim().toLowerCase();
  if (!v) return "Enter an email or domain";
  if (v.length > 254) return "Too long (max 254 chars)";
  if (/\s/.test(v)) return "No spaces allowed";
  // prefix pattern: "name@"
  if (/^[a-z0-9._%+-]+@$/.test(v)) return null;
  // bare or @-prefixed domain
  if (/^@?[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  // full email
  if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(v)) return null;
  return "Use an email, @domain.com, or noreply@";
}

function SenderBlacklistManager({ isDark }) {
  const [senders, setSenders]     = useState([]);
  const [input, setInput]         = useState("");
  const [label, setLabel]         = useState("");
  const [inputError, setInputError] = useState("");
  const [labelError, setLabelError] = useState("");
  const [adding, setAdding]       = useState(false);
  const [loading, setLoading]     = useState(true);
  const [removingAddr, setRemovingAddr] = useState(null);
  const [clearing, setClearing]   = useState(false);
  const [loadError, setLoadError] = useState("");

  const inputStyle = { backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#d1d5db", color: isDark ? D.text : "#1e293b" };
  const inputCls = "px-3.5 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-500 transition-all";
  const errorBorder = { borderColor: "#ef4444" };

  const loadBlacklist = () => {
    setLoading(true);
    setLoadError("");
    api.get("/email/sender-blacklist")
      .then(res => setSenders(res.data?.senders || []))
      .catch(err => {
        const msg = err?.response?.data?.detail || "Could not load blacklist";
        setLoadError(msg);
        toast.error(msg);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadBlacklist(); }, []);

  // live field validation
  const onInputChange = (val) => {
    setInput(val);
    if (inputError) setInputError(validateSenderEntry(val) || "");
  };
  const onLabelChange = (val) => {
    setLabel(val);
    if (val.length > 60) setLabelError("Label must be 60 characters or less");
    else setLabelError("");
  };

  const addSender = async () => {
    const addr = input.trim().toLowerCase();
    const err = validateSenderEntry(addr);
    if (err) { setInputError(err); toast.error(err); return; }
    if (label.length > 60) { setLabelError("Label must be 60 characters or less"); return; }
    if (senders.find(s => s.email_address === addr)) {
      setInputError("Already in blacklist");
      toast.error("Already in blacklist");
      return;
    }
    setInputError(""); setLabelError("");
    setAdding(true);
    try {
      const updated = [...senders, { email_address: addr, label: label.trim() || addr }];
      await api.put("/email/sender-blacklist", { senders: updated });
      setSenders(updated);
      setInput(""); setLabel("");
      toast.success(`✓ ${addr} blocked`);
    } catch (e) {
      const msg = e?.response?.data?.detail || "Failed to add sender";
      toast.error(msg);
    } finally { setAdding(false); }
  };

  const removeSender = async (addr) => {
    setRemovingAddr(addr);
    const updated = senders.filter(s => s.email_address !== addr);
    try {
      await api.put("/email/sender-blacklist", { senders: updated });
      setSenders(updated);
      toast.success(`${addr} unblocked`);
    } catch (e) {
      const msg = e?.response?.data?.detail || "Failed to remove sender";
      toast.error(msg);
    } finally { setRemovingAddr(null); }
  };

  const clearAll = async () => {
    if (!window.confirm("Clear entire blacklist? Previously blocked senders will be scanned again.")) return;
    setClearing(true);
    try {
      await api.put("/email/sender-blacklist", { senders: [] });
      setSenders([]);
      toast.success("Blacklist cleared");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to clear blacklist");
    } finally { setClearing(false); }
  };

  const SUGGESTED_BLOCKS = [
    { email_address: "@promotions.com",   label: "Promotions" },
    { email_address: "noreply@",          label: "No-reply" },
    { email_address: "@newsletter.com",   label: "Newsletters" },
    { email_address: "@offers.com",       label: "Offers" },
    { email_address: "marketing@",        label: "Marketing" },
  ];

  const canSubmit = !adding && input.trim() && !inputError && !labelError;

  return (
    <SectionCard>
      <CardHeaderRow
        iconBg={isDark ? "bg-red-900/30" : "bg-red-50"}
        icon={<Shield className="w-4 h-4 text-red-500" />}
        title="Sender Blacklist"
        subtitle="Emails from these senders are never scanned — even if they contain dates"
        badge={loading ? "…" : senders.length}
      />
      <div className="p-4 space-y-4">
        {loadError && !loading && (
          <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border text-xs"
            style={{ backgroundColor: isDark ? "rgba(239,68,68,0.10)" : "#fef2f2", borderColor: isDark ? "rgba(239,68,68,0.30)" : "#fecaca", color: COLORS.red }}>
            <span className="flex items-center gap-2"><AlertCircle className="w-3.5 h-3.5" />{loadError}</span>
            <button onClick={loadBlacklist} className="font-bold underline">Retry</button>
          </div>
        )}

        <div>
          <p className="text-[10px] font-bold uppercase tracking-widest mb-2.5" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Quick Block — Common Noise</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTED_BLOCKS.map(s => {
              const exists = senders.find(x => x.email_address === s.email_address);
              return (
                <button key={s.email_address}
                  onClick={() => { if (exists) return; setInput(s.email_address); setLabel(s.label); setInputError(""); setLabelError(""); }}
                  disabled={!!exists}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border-2 transition-all active:scale-95"
                  style={exists
                    ? { borderColor: isDark ? "#7f1d1d" : "#fecaca", backgroundColor: isDark ? "rgba(239,68,68,0.12)" : "#fef2f2", color: COLORS.red, cursor: "default" }
                    : { borderColor: isDark ? D.border : "#e2e8f0", backgroundColor: isDark ? D.raised : "#f8fafc", color: isDark ? D.muted : "#374151" }}>
                  {exists ? <Check className="w-3 h-3" /> : <Plus className="w-3 h-3" />}{s.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Block Custom Sender</p>
          <div className="flex gap-2">
            <div className="flex-1">
              <input value={input} onChange={e => onInputChange(e.target.value)}
                placeholder="@domain.com or noreply@bank.com"
                onBlur={() => setInputError(validateSenderEntry(input) || "")}
                onKeyDown={e => e.key === "Enter" && addSender()}
                aria-invalid={!!inputError}
                className={inputCls + " w-full"} style={{ ...inputStyle, ...(inputError ? errorBorder : {}) }} />
              {inputError && (
                <p className="text-[11px] mt-1 flex items-center gap-1 text-red-500"><AlertCircle className="w-3 h-3" />{inputError}</p>
              )}
            </div>
            <div className="w-36">
              <input value={label} onChange={e => onLabelChange(e.target.value)}
                placeholder="Label (optional)"
                onKeyDown={e => e.key === "Enter" && addSender()}
                maxLength={80}
                aria-invalid={!!labelError}
                className={inputCls + " w-full"} style={{ ...inputStyle, ...(labelError ? errorBorder : {}) }} />
              {labelError && (
                <p className="text-[11px] mt-1 flex items-center gap-1 text-red-500"><AlertCircle className="w-3 h-3" />{labelError}</p>
              )}
            </div>
            <Button onClick={addSender} disabled={!canSubmit}
              className="h-10 px-4 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: `linear-gradient(135deg, ${COLORS.red}, #b91c1c)` }}>
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shield className="w-4 h-4" />}
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-6 gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-red-400" />
            <p className="text-[11px]" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Loading blacklist…</p>
          </div>
        ) : senders.length === 0 ? (
          <div className="py-6 text-center">
            <Shield className="w-7 h-7 mx-auto mb-2 opacity-20" />
            <p className="text-xs" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
              No senders blocked — smart noise filter still applies automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>Blocked Senders ({senders.length})</p>
            {senders.map(s => {
              const isRemoving = removingAddr === s.email_address;
              return (
                <motion.div key={s.email_address} initial={{ opacity: 0 }} animate={{ opacity: isRemoving ? 0.5 : 1 }}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl border"
                  style={{ backgroundColor: isDark ? "rgba(239,68,68,0.08)" : "#fff1f2", borderColor: isDark ? "rgba(239,68,68,0.25)" : "#fecaca" }}>
                  <div className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                    style={{ backgroundColor: isDark ? "rgba(239,68,68,0.20)" : "#fee2e2" }}>
                    <Shield className="w-3.5 h-3.5 text-red-500" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-bold truncate" style={{ color: isDark ? D.text : "#1e293b" }}>{s.label || s.email_address}</p>
                    {s.label && s.label !== s.email_address && (
                      <p className="text-[10px] font-mono truncate" style={{ color: isDark ? D.muted : "#94a3b8" }}>{s.email_address}</p>
                    )}
                  </div>
                  <button onClick={() => removeSender(s.email_address)}
                    disabled={isRemoving || clearing}
                    aria-label={`Remove ${s.email_address}`}
                    className="w-7 h-7 flex items-center justify-center rounded-lg transition-all active:scale-90 disabled:opacity-50"
                    style={{ color: isDark ? "#f87171" : COLORS.red }}>
                    {isRemoving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </motion.div>
              );
            })}
            <button onClick={clearAll} disabled={clearing}
              className="text-xs font-semibold flex items-center gap-1 mt-1 active:scale-95 transition-all disabled:opacity-50"
              style={{ color: isDark ? "#f87171" : COLORS.red }}>
              {clearing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
              {clearing ? "Clearing…" : "Clear entire blacklist"}
            </button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL SCAN SETTINGS — central panel for all customisable behaviours
// ─────────────────────────────────────────────────────────────────────────────
const SCAN_SETTINGS_KEY = "tsk_email_scan_settings_v1";
const DEFAULT_SCAN_SETTINGS = {
  scanWindowDays:        30,
  maxEventsPerScan:      100,
  autoSelectFuture:      true,
  skipPastEvents:        true,
  smartNoiseFilter:      true,
  enforceWhitelist:      false,
  enforceBlacklist:      true,
  defaultCategory:       "reminder",
  defaultReminderLead:   1,
  syncIntervalMinutes:   15,
  autoSyncEnabled:       false,
  notifyOnNewEvents:     true,
  collapsePastInPreview: true,
  groupByAccount:        false,
  showAttachments:       true,
};

function loadScanSettingsLocal() {
  try {
    const raw = localStorage.getItem(SCAN_SETTINGS_KEY);
    if (!raw) return null;
    return { ...DEFAULT_SCAN_SETTINGS, ...JSON.parse(raw) };
  } catch { return null; }
}

// Per-field validation rules for scan settings. Returns map of {field: errorMsg}.
function validateScanSettings(s) {
  const errors = {};
  const intInRange = (v, min, max) => Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max;
  if (!intInRange(s.scanWindowDays, 1, 365))         errors.scanWindowDays      = "Must be 1–365";
  if (!intInRange(s.maxEventsPerScan, 10, 1000))     errors.maxEventsPerScan    = "Must be 10–1000";
  if (!intInRange(s.syncIntervalMinutes, 5, 240))    errors.syncIntervalMinutes = "Must be 5–240 min";
  if (!intInRange(s.defaultReminderLead, 0, 30))     errors.defaultReminderLead = "Must be 0–30 days";
  if (!["reminder", "todo", "visit"].includes(s.defaultCategory))
    errors.defaultCategory = "Pick a valid category";
  return errors;
}

function EmailScanSettings({ isDark }) {
  const [settings, setSettings] = useState(() => loadScanSettingsLocal() || { ...DEFAULT_SCAN_SETTINGS });
  const [loadingRemote, setLoadingRemote] = useState(true);
  const [saved, setSaved]       = useState(false);
  const [saving, setSaving]     = useState(false);
  const [resetting, setResetting] = useState(false);
  const [errors, setErrors]     = useState({});

  // On mount, load settings from server (server is source of truth; localStorage is optimistic cache)
  useEffect(() => {
    api.get("/email/scan-settings")
      .then(res => {
        const remote = { ...DEFAULT_SCAN_SETTINGS, ...(res.data || {}) };
        setSettings(remote);
        localStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(remote));
      })
      .catch(() => { /* use local/default silently */ })
      .finally(() => setLoadingRemote(false));
  }, []);

  const update = (patch) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      const nextErrors = validateScanSettings(next);
      setErrors(prevErr => {
        const out = { ...prevErr };
        Object.keys(patch).forEach(k => {
          if (nextErrors[k]) out[k] = nextErrors[k]; else delete out[k];
        });
        return out;
      });
      return next;
    });
  };

  const save = async () => {
    const v = validateScanSettings(settings);
    setErrors(v);
    if (Object.keys(v).length > 0) {
      toast.error(`Fix ${Object.keys(v).length} field${Object.keys(v).length > 1 ? "s" : ""} before saving`);
      return;
    }
    setSaving(true);
    try {
      localStorage.setItem(SCAN_SETTINGS_KEY, JSON.stringify(settings));
      await api.put("/email/scan-settings", settings);
      toast.success("✓ Settings saved");
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (apiErr) {
      const status  = apiErr?.response?.status;
      const detail  = apiErr?.response?.data?.detail;
      if (status === 422 && detail && typeof detail === "object") {
        // Server-side field validation errors
        setErrors(detail);
        toast.error("Fix field errors and try again");
      } else {
        const msg = detail || (status ? `Server error (${status})` : "Server unreachable — saved locally");
        toast.warning(msg);
        setSaved(true);
        setTimeout(() => setSaved(false), 1600);
      }
    } finally { setSaving(false); }
  };

  const reset = async () => {
    if (!window.confirm("Restore default scan settings?")) return;
    setResetting(true);
    try {
      setSettings({ ...DEFAULT_SCAN_SETTINGS });
      setErrors({});
      localStorage.removeItem(SCAN_SETTINGS_KEY);
      try { await api.put("/email/scan-settings", DEFAULT_SCAN_SETTINGS); } catch { /* non-fatal */ }
      toast.success("Defaults restored");
    } catch {
      toast.error("Could not restore defaults");
    } finally { setResetting(false); }
  };

  const Toggle = ({ label, hint, value, onChange, disabled, badge }) => (
    <div className="flex items-start justify-between gap-4 py-3.5 border-b last:border-b-0"
      style={{ borderColor: isDark ? D.border : "#f1f5f9" }}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>{label}</p>
          {badge && (
            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
              style={{ background: isDark ? "rgba(16,185,129,0.15)" : "#dcfce7", color: "#059669" }}>{badge}</span>
          )}
        </div>
        {hint && <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: isDark ? D.muted : "#64748b" }}>{hint}</p>}
      </div>
      <button onClick={() => !disabled && onChange(!value)}
        disabled={disabled}
        className="flex-shrink-0 transition-all active:scale-95 disabled:opacity-50 mt-0.5"
        aria-label={label}>
        {value
          ? <ToggleRight className="w-9 h-9" style={{ color: COLORS.emeraldGreen }} />
          : <ToggleLeft  className="w-9 h-9" style={{ color: isDark ? D.dimmer : "#94a3b8" }} />}
      </button>
    </div>
  );

  const NumberField = ({ label, hint, value, min, max, step = 1, suffix, onChange, error }) => (
    <div className="py-3.5 border-b last:border-b-0" style={{ borderColor: isDark ? D.border : "#f1f5f9" }}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>{label}</p>
          {hint && <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: isDark ? D.muted : "#64748b" }}>{hint}</p>}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button onClick={() => onChange(Math.max(min, (value || 0) - step))}
            className="w-7 h-7 flex items-center justify-center rounded-lg border text-base font-bold transition-all active:scale-95"
            style={{ backgroundColor: isDark ? D.raised : "#f8fafc", borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.muted : "#64748b" }}>
            −
          </button>
          <input type="number" value={value} min={min} max={max} step={step}
            onChange={e => { const raw = e.target.value; onChange(raw === "" ? NaN : Number(raw)); }}
            aria-invalid={!!error}
            className="w-20 px-2 py-1.5 border rounded-lg text-sm text-center font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            style={{ backgroundColor: isDark ? D.raised : "#fff", borderColor: error ? "#ef4444" : (isDark ? D.border : "#d1d5db"), color: isDark ? D.text : "#1e293b" }} />
          <button onClick={() => onChange(Math.min(max, (value || 0) + step))}
            className="w-7 h-7 flex items-center justify-center rounded-lg border text-base font-bold transition-all active:scale-95"
            style={{ backgroundColor: isDark ? D.raised : "#f8fafc", borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.muted : "#64748b" }}>
            +
          </button>
          {suffix && <span className="text-xs font-semibold w-10" style={{ color: isDark ? D.muted : "#64748b" }}>{suffix}</span>}
        </div>
      </div>
      {error && (
        <p className="text-[11px] mt-1.5 flex items-center gap-1 text-red-500"><AlertCircle className="w-3 h-3" />{error}</p>
      )}
    </div>
  );

  const SelectField = ({ label, hint, value, options, onChange, error }) => (
    <div className="py-3.5 border-b last:border-b-0" style={{ borderColor: isDark ? D.border : "#f1f5f9" }}>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" style={{ color: isDark ? D.text : "#1e293b" }}>{label}</p>
          {hint && <p className="text-[11px] mt-0.5 leading-relaxed" style={{ color: isDark ? D.muted : "#64748b" }}>{hint}</p>}
        </div>
        <select value={value} onChange={e => onChange(e.target.value)}
          aria-invalid={!!error}
          className="px-3 py-2 border rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 flex-shrink-0"
          style={{ backgroundColor: isDark ? D.raised : "#fff", borderColor: error ? "#ef4444" : (isDark ? D.border : "#d1d5db"), color: isDark ? D.text : "#1e293b" }}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {error && (
        <p className="text-[11px] mt-1.5 flex items-center gap-1 text-red-500"><AlertCircle className="w-3 h-3" />{error}</p>
      )}
    </div>
  );

  const errorCount = Object.keys(errors).length;

  if (loadingRemote) {
    return (
      <div className="flex items-center justify-center py-12 gap-3" style={{ color: isDark ? D.muted : "#94a3b8" }}>
        <Loader2 className="w-5 h-5 animate-spin" />
        <span className="text-sm">Loading settings…</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Scanning ── */}
      <SectionCard>
        <CardHeaderRow
          iconBg={isDark ? "bg-blue-900/30" : "bg-blue-50"}
          icon={<RefreshCw className="w-4 h-4 text-blue-500" />}
          title="Scanning"
          subtitle="Control how emails are fetched and how far back to look"
        />
        <div className="px-4">
          <NumberField label="Scan window"
            hint="Days of email history to scan when an account has no last-sync date"
            value={settings.scanWindowDays} min={1} max={365} suffix="days"
            error={errors.scanWindowDays}
            onChange={v => update({ scanWindowDays: v })} />
          <NumberField label="Max events per scan"
            hint="Hard cap to prevent runaway extractions on busy mailboxes"
            value={settings.maxEventsPerScan} min={10} max={1000} step={10} suffix="events"
            error={errors.maxEventsPerScan}
            onChange={v => update({ maxEventsPerScan: v })} />
          <NumberField label="Auto-sync interval"
            hint="When auto-sync is on, fetch new emails this often"
            value={settings.syncIntervalMinutes} min={5} max={240} step={5} suffix="min"
            error={errors.syncIntervalMinutes}
            onChange={v => update({ syncIntervalMinutes: v })} />
          <Toggle label="Enable background auto-sync"
            hint="Periodically pull new emails without clicking Sync"
            value={settings.autoSyncEnabled}
            onChange={v => update({ autoSyncEnabled: v })} />
        </div>
      </SectionCard>

      <SectionCard>
        <CardHeaderRow
          iconBg={isDark ? "bg-emerald-900/30" : "bg-emerald-50"}
          icon={<Filter className="w-4 h-4 text-emerald-500" />}
          title="Filtering"
          subtitle="What gets through and what gets dropped"
        />
        <div className="px-4">
          <Toggle label="Smart noise filter"
            hint="Auto-block OTPs, banking alerts, promotions, newsletters"
            value={settings.smartNoiseFilter}
            onChange={v => update({ smartNoiseFilter: v })} />
          <Toggle label="Enforce sender whitelist"
            hint="Only emails from whitelisted senders are scanned — others are skipped"
            value={settings.enforceWhitelist}
            onChange={v => update({ enforceWhitelist: v })} />
          <Toggle label="Enforce sender blacklist"
            hint="Blacklisted senders are dropped before extraction runs"
            value={settings.enforceBlacklist}
            onChange={v => update({ enforceBlacklist: v })} />
          <Toggle label="Skip past-dated events"
            hint="Past events stay greyed out in preview and cannot be saved"
            value={settings.skipPastEvents}
            onChange={v => update({ skipPastEvents: v })} />
        </div>
      </SectionCard>

      {/* ── Preview & Save Defaults — two column grid on wide screens ── */}
      <SectionCard>
        <CardHeaderRow
          iconBg={isDark ? "bg-purple-900/30" : "bg-purple-50"}
          icon={<Tag className="w-4 h-4 text-purple-500" />}
          title="Preview & Save Defaults"
          subtitle="Default category, reminder lead time, and preview panel behaviour"
        />
        <div className="px-4">
          <SelectField label="Default category for new events"
            hint="Used when AI cannot decide between Todo / Reminder / Visit"
            value={settings.defaultCategory}
            error={errors.defaultCategory}
            options={[
              { value: "reminder", label: "🔔 Reminder" },
              { value: "todo",     label: "✅ Todo" },
              { value: "visit",    label: "📍 Visit" },
            ]}
            onChange={v => update({ defaultCategory: v })} />
          <NumberField label="Default reminder lead time"
            hint="How many days before the due date to fire the reminder"
            value={settings.defaultReminderLead} min={0} max={30} suffix="days"
            error={errors.defaultReminderLead}
            onChange={v => update({ defaultReminderLead: v })} />
          <Toggle label="Auto-select future events"
            hint="Future-dated events are pre-checked when the preview panel opens"
            value={settings.autoSelectFuture}
            onChange={v => update({ autoSelectFuture: v })} />
          <Toggle label="Collapse past events in preview"
            hint="Hide past-dated rows by default to reduce clutter"
            value={settings.collapsePastInPreview}
            onChange={v => update({ collapsePastInPreview: v })} />
          <Toggle label="Group preview rows by account"
            hint="Show one section per email account in the preview panel"
            value={settings.groupByAccount}
            onChange={v => update({ groupByAccount: v })} />
          <Toggle label="Show attachments column"
            hint="Display the paperclip indicator for emails with attachments"
            value={settings.showAttachments}
            onChange={v => update({ showAttachments: v })} />
        </div>
      </SectionCard>

      {/* ── Notifications ── */}
      <SectionCard>
        <CardHeaderRow
          iconBg={isDark ? "bg-amber-900/30" : "bg-amber-50"}
          icon={<Bell className="w-4 h-4 text-amber-500" />}
          title="Notifications"
          subtitle="Toasts and alerts triggered by scan activity"
        />
        <div className="px-4">
          <Toggle label="Notify when new events are found"
            hint="Show a toast after each scan with the count of new extractions"
            value={settings.notifyOnNewEvents}
            badge="Recommended"
            onChange={v => update({ notifyOnNewEvents: v })} />
        </div>
      </SectionCard>

      {/* ── Error banner ── */}
      {errorCount > 0 && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-xl border text-xs"
          style={{ backgroundColor: isDark ? "rgba(239,68,68,0.10)" : "#fef2f2", borderColor: isDark ? "rgba(239,68,68,0.30)" : "#fecaca", color: COLORS.red }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span className="font-semibold">{errorCount} field{errorCount > 1 ? "s" : ""} need attention before saving.</span>
        </div>
      )}

      {/* ── Sticky footer actions ── */}
      <div className="flex items-center justify-between gap-3 sticky bottom-3 z-10 px-4 py-3 rounded-2xl border"
        style={{ backgroundColor: isDark ? D.card : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0", boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
        <p className="text-[11px]" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
          Settings synced to server &amp; device
        </p>
        <div className="flex items-center gap-2">
          <button onClick={reset} disabled={resetting || saving}
            className="px-4 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95 disabled:opacity-50 flex items-center gap-2"
            style={{ backgroundColor: isDark ? D.raised : "#f8fafc", borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.muted : "#64748b" }}>
            {resetting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {resetting ? "Restoring…" : "Restore defaults"}
          </button>
          <button onClick={save} disabled={saving || resetting || errorCount > 0}
            className="px-5 py-2 rounded-xl text-sm font-bold text-white flex items-center gap-2 transition-all active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              background: saved
                ? `linear-gradient(135deg, ${COLORS.emeraldGreen}, #16a34a)`
                : `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})`,
              boxShadow: "0 4px 14px rgba(13,59,102,0.30)",
            }}>
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saving ? "Saving…" : saved ? "Saved!" : "Save Settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

// =============================================================================
// EMAIL_VARS + VariablesBar
// =============================================================================
const EMAIL_VARS = [
  { token: '{name}',     desc: 'Company / Client name' },
  { token: '{email}',    desc: 'Email address' },
  { token: '{phone}',    desc: 'Phone number' },
  { token: '{gstin}',    desc: 'GSTIN' },
  { token: '{city}',     desc: 'City' },
  { token: '{services}', desc: 'Services (comma-list)' },
];
function VariablesBar({ onInsert }) {
  return (
    <div className="flex flex-wrap gap-1.5 mb-2 items-center">
      <span className="text-[10px] font-bold text-slate-400 shrink-0">Variables:</span>
      {EMAIL_VARS.map(v => (
        <button key={v.token} type="button" onClick={() => onInsert(v.token)} title={v.desc}
          className="px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold transition-colors"
          style={{ background: '#eef2ff', color: '#4338ca', border: '1px solid #c7d2fe' }}>
          {v.token}
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// EmailComposePanel
// =============================================================================
function EmailComposePanel({ isDark }) {
  const [companies,    setCompanies]   = React.useState([]);
  const [clients,      setClients]     = React.useState([]);
  const [clientsLoading, setClientsLoading] = React.useState(true);
  const [templates,    setTemplates]   = React.useState([]);
  const [selCompany,   setSelCompany]  = React.useState('');
  const [sendMethod,   setSendMethod]  = React.useState('auto');
  const [bulkSenderId, setBulkSenderId] = React.useState('');
  const [subject,      setSubject]     = React.useState('');
  const [body,         setBody]        = React.useState('');
  const [isHtml,       setIsHtml]      = React.useState(false);
  const [clientSearch, setClientSearch]= React.useState('');
  const [serviceFilter,setServiceFilter]= React.useState('all');
  const [selectedIds,  setSelectedIds] = React.useState(new Set());
  const [showPreview,  setShowPreview] = React.useState(false);
  const [sending,      setSending]     = React.useState(false);
  const [progress,     setProgress]    = React.useState(null);
  const [composeAttachName,   setComposeAttachName]   = React.useState('');
  const [composeAttachB64,    setComposeAttachB64]    = React.useState('');
  const composeAttachRef = React.useRef(null);
  const bodyRef = React.useRef(null);

  // Fetch ALL clients by paginating through all pages
  const fetchAllClients = React.useCallback(async () => {
    setClientsLoading(true);
    try {
      let all = [];
      let page = 1;
      const PAGE_SIZE = 200;
      while (true) {
        const r = await api.get('/clients', { params: { page, page_size: PAGE_SIZE } });
        const d = r.data;
        const batch = Array.isArray(d) ? d : (d?.clients || d?.data || []);
        all = all.concat(batch);
        // Stop if we got fewer than PAGE_SIZE (last page) or empty
        if (batch.length < PAGE_SIZE) break;
        page++;
        if (page > 50) break; // safety cap
      }
      setClients(all);
    } catch { setClients([]); }
    finally { setClientsLoading(false); }
  }, []);

  React.useEffect(() => {
    api.get('/companies').then(r => setCompanies(normalizeCompanies(r))).catch(() => {});
    fetchAllClients();
    api.get('/email/client-templates').then(r => setTemplates(r.data || [])).catch(() => {});
  }, [fetchAllClients]);

  // Derive unique services list for filter
  const allServices = React.useMemo(() => {
    const svcSet = new Set();
    clients.forEach(c => (c.services || []).forEach(s => { if (s) svcSet.add(s.trim()); }));
    return Array.from(svcSet).sort();
  }, [clients]);

  const personalize = (text, client) => (text||'')
    .replace(/{name}/gi, client.company_name || 'Valued Client')
    .replace(/{email}/gi, client.email || '')
    .replace(/{phone}/gi, client.phone || '')
    .replace(/{gstin}/gi, client.gstin || '')
    .replace(/{city}/gi, client.city || '')
    .replace(/{services}/gi, (client.services || []).join(', '));

  const filtered = React.useMemo(() => {
    let base = clients.filter(c => c.email);
    // Service filter
    if (serviceFilter !== 'all') {
      base = base.filter(c => (c.services || []).some(s => s === serviceFilter));
    }
    // Text search
    if (clientSearch.trim()) {
      const q = clientSearch.toLowerCase();
      base = base.filter(c =>
        (c.company_name||'').toLowerCase().includes(q) ||
        (c.email||'').toLowerCase().includes(q) ||
        (c.city||'').toLowerCase().includes(q)
      );
    }
    return base;
  }, [clients, clientSearch, serviceFilter]);

  const allWithEmail = React.useMemo(() => clients.filter(c => c.email), [clients]);
  const selectedClients = React.useMemo(() => clients.filter(c => selectedIds.has(c.id) && c.email), [clients, selectedIds]);

  // Toggle only filtered results
  const toggleFiltered = () => {
    const filteredIds = new Set(filtered.map(c => c.id));
    const allFilteredSelected = filtered.every(c => selectedIds.has(c.id));
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allFilteredSelected) { filteredIds.forEach(id => next.delete(id)); }
      else { filtered.forEach(c => next.add(c.id)); }
      return next;
    });
  };
  // Select/clear ALL clients across all filters
  const selectAllClients = () => setSelectedIds(new Set(allWithEmail.map(c => c.id)));
  const clearAll = () => setSelectedIds(new Set());
  const allFilteredSelected = filtered.length > 0 && filtered.every(c => selectedIds.has(c.id));

  const insertVar = (v) => {
    const el = bodyRef.current;
    if (el) {
      const s = el.selectionStart, e = el.selectionEnd;
      const nb = body.slice(0, s) + v + body.slice(e);
      setBody(nb);
      setTimeout(() => { el.focus(); el.setSelectionRange(s + v.length, s + v.length); }, 0);
    } else setBody(b => b + v);
  };

  const loadTpl = (tpl) => {
    setSubject(tpl.subject); setBody(tpl.body); setIsHtml(!!tpl.is_html);
    setComposeAttachName(tpl.attachment_name || '');
    setComposeAttachB64(tpl.attachment_base64 || '');
    toast.success(`Template "${tpl.name}" loaded${tpl.attachment_name ? ` · 📎 ${tpl.attachment_name}` : ''}`);
  };

  const handleComposeAttachFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error('Attachment must be under 5 MB'); e.target.value=''; return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const b64 = ev.target.result.split(',')[1];
      setComposeAttachB64(b64);
      setComposeAttachName(file.name);
    };
    reader.readAsDataURL(file);
  };

  const handleSend = async () => {
    if (!subject.trim()) { toast.error('Subject required'); return; }
    if (!body.trim())    { toast.error('Email body required'); return; }
    if (!selectedClients.length) { toast.error('Select at least one client with email'); return; }
    setSending(true); setProgress({ done: 0, total: selectedClients.length, failed: 0 });
    try {
      const recipients = selectedClients.map(c => ({
        email: c.email, name: c.company_name || '',
        variables: { name: c.company_name||'Valued Client', email: c.email||'', phone: c.phone||'', gstin: c.gstin||'', city: c.city||'', services: (c.services||[]).join(', ') },
      }));
      const r = await api.post('/email/send-bulk-clients', {
        recipients, subject, body_template: body, is_html: isHtml,
        company_id: selCompany||null, send_method: sendMethod, sender_id: bulkSenderId || null,
        attachment_base64: composeAttachB64 || null,
        attachment_name:   composeAttachName || null,
      });
      setProgress({ done: r.data.sent, total: selectedClients.length, failed: r.data.failed });
      toast.success(`✅ ${r.data.sent} email(s) sent`);
    } catch (err) { toast.error(err.response?.data?.detail || 'Send failed'); }
    finally { setSending(false); }
  };

  const selComp = companies.find(c => c.id === selCompany);

  return (
    <div className="space-y-4">
      {/* Sender identity */}
      <SectionCard>
        <CardHeaderRow iconBg="bg-blue-50 dark:bg-blue-900/30" icon={<Building2 className="w-4 h-4 text-blue-500" />}
          title="Sender Identity" subtitle="Company branding and sending method" />
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1.5">Company <span className="font-normal">(name &amp; branding)</span></label>
            <select value={selCompany} onChange={e => setSelCompany(e.target.value)}
              className="w-full border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
              style={{ borderColor: isDark ? '#334155' : '#e2e8f0' }}>
              <option value="">— Organisation default —</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {selComp && (
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                {selComp.email && <span>📧 {selComp.email}</span>}
                {selComp.phone && <span>📞 {selComp.phone}</span>}
              </div>
            )}
          </div>
          <div>
            {/* Sent from the organisation mailbox (Settings → Integrations → Email). */}
            <SendFromSelect value={bulkSenderId} onChange={setBulkSenderId} />
          </div>
        </div>
      </SectionCard>

      {/* Load template */}
      {templates.length > 0 && (
        <SectionCard>
          <CardHeaderRow iconBg="bg-purple-50 dark:bg-purple-900/30" icon={<FileText className="w-4 h-4 text-purple-500" />}
            title="Load a Saved Template" subtitle="Pre-fills subject and body instantly" />
          <div className="p-3 flex flex-wrap gap-2">
            {templates.map(t => (
              <button key={t.id} type="button" onClick={() => loadTpl(t)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all hover:shadow-sm active:scale-95"
                style={{ background: isDark?'#1e293b':'#f8fafc', borderColor: isDark?'#334155':'#e2e8f0', color: isDark?'#94a3b8':'#475569' }}>
                <FileText className="w-3 h-3" />{t.name}
              </button>
            ))}
          </div>
        </SectionCard>
      )}

      {/* Compose */}
      <SectionCard>
        <CardHeaderRow iconBg="bg-emerald-50 dark:bg-emerald-900/30" icon={<Send className="w-4 h-4 text-emerald-500" />}
          title="Compose Email" subtitle="Use {variable} tokens for personalisation"
          action={
            <button type="button" onClick={() => setIsHtml(h => !h)}
              className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold border transition-all"
              style={{ borderColor: isHtml?'#2563eb':'#e2e8f0', color: isHtml?'#2563eb':'#94a3b8', background: isHtml?'#eff6ff':'transparent' }}>
              {isHtml ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />} HTML
            </button>
          } />
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Subject</label>
            <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Important update for {name}"
              className="w-full border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
              style={{ borderColor: isDark?'#334155':'#e2e8f0' }} />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1">Message Body</label>
            <VariablesBar onInsert={insertVar} />
            <textarea ref={bodyRef} value={body} onChange={e => setBody(e.target.value)} rows={isHtml?14:10}
              placeholder={isHtml ? '<p>Dear {name},</p>\n<p>Your message here...</p>' : 'Dear {name},\n\nYour message here...\n\nRegards,\nThe Team'}
              className="w-full border rounded-xl px-3 py-2 text-sm font-mono resize-y bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
              style={{ borderColor: isDark?'#334155':'#e2e8f0' }} />
          </div>

          {/* ── Compose attachment ── */}
          <div>
            <label className="block text-xs font-semibold text-slate-400 mb-1.5">Attachment <span className="font-normal text-slate-300">(optional · max 5 MB)</span></label>
            {composeAttachName ? (
              <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl border"
                style={{ borderColor: isDark?'#334155':'#e2e8f0', background: isDark?'#1e293b':'#f8fafc' }}>
                <Paperclip className="w-4 h-4 text-blue-400 flex-shrink-0"/>
                <span className="text-xs font-medium flex-1 truncate" style={{ color: isDark?'#e2e8f0':'#1e293b' }}>{composeAttachName}</span>
                <button type="button" onClick={() => { setComposeAttachName(''); setComposeAttachB64(''); if(composeAttachRef.current) composeAttachRef.current.value=''; }}
                  className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 transition-colors flex-shrink-0">
                  <X className="w-3 h-3"/>
                </button>
              </div>
            ) : (
              <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed cursor-pointer transition-colors hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-900/10"
                style={{ borderColor: isDark?'#334155':'#cbd5e1' }}>
                <Paperclip className="w-4 h-4 text-slate-400"/>
                <span className="text-xs text-slate-400">Click to attach a file (PDF, DOCX, XLSX, image…)</span>
                <input ref={composeAttachRef} type="file" className="hidden"
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png,.gif"
                  onChange={handleComposeAttachFile}/>
              </label>
            )}
          </div>
        </div>
      </SectionCard>

      {/* Preview */}
      {body.trim() && selectedClients.length > 0 && (
        <SectionCard>
          <CardHeaderRow iconBg="bg-amber-50 dark:bg-amber-900/30" icon={<Eye className="w-4 h-4 text-amber-500" />}
            title={`Preview for ${selectedClients[0]?.company_name || 'first client'}`}
            subtitle={personalize(subject, selectedClients[0]||{})}
            action={<button type="button" onClick={() => setShowPreview(p=>!p)} className="text-xs font-semibold text-blue-500">{showPreview?'Hide':'Show'}</button>} />
          {showPreview && (
            <div className="p-4">
              {isHtml
                ? <div className="border rounded-xl overflow-hidden bg-white" style={{ borderColor: isDark?'#334155':'#e2e8f0' }}>
                    <iframe srcDoc={personalize(body, selectedClients[0]||{})} className="w-full" style={{ height:320, border:'none' }} sandbox="allow-same-origin" />
                  </div>
                : <pre className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-200 bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3 border" style={{ borderColor: isDark?'#334155':'#e2e8f0' }}>
                    {personalize(body, selectedClients[0]||{})}
                  </pre>
              }
            </div>
          )}
        </SectionCard>
      )}

      {/* Client picker */}
      <SectionCard>
        <CardHeaderRow iconBg="bg-slate-100 dark:bg-slate-700" icon={<Users className="w-4 h-4 text-slate-500" />}
          title="Select Recipients"
          subtitle={clientsLoading
            ? 'Loading all clients...'
            : `${selectedClients.length} selected · ${allWithEmail.length} total with email · ${filtered.length} shown`}
          action={
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={selectAllClients}
                className="text-[11px] font-bold px-2.5 py-1 rounded-lg transition-colors"
                style={{ background:'#dbeafe', color:'#1d4ed8' }}>
                All {allWithEmail.length}
              </button>
              <button type="button" onClick={toggleFiltered}
                className="text-[11px] font-bold px-2.5 py-1 rounded-lg transition-colors"
                style={{ background: allFilteredSelected?'#fee2e2':'#dcfce7', color: allFilteredSelected?'#dc2626':'#16a34a' }}>
                {allFilteredSelected ? 'Deselect shown' : `Select ${filtered.length}`}
              </button>
              <button type="button" onClick={clearAll}
                className="text-[11px] font-bold px-2.5 py-1 rounded-lg"
                style={{ background:'#f1f5f9', color:'#64748b' }}>
                Clear
              </button>
            </div>
          } />
        <div className="p-3 space-y-2">
          {/* Search + service filter row */}
          <div className="flex gap-2">
            <input value={clientSearch} onChange={e=>setClientSearch(e.target.value)}
              placeholder="Search by name, email or city..."
              className="flex-1 border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-400"
              style={{ borderColor: isDark?'#334155':'#e2e8f0' }} />
            <select value={serviceFilter} onChange={e => { setServiceFilter(e.target.value); }}
              className="border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-400 shrink-0"
              style={{ borderColor: isDark?'#334155':'#e2e8f0', minWidth: 130 }}>
              <option value="all">All Services</option>
              {allServices.map(s => <option key={s} value={s}>{s.length > 28 ? s.slice(0,28)+'…' : s}</option>)}
            </select>
          </div>
          {/* Count badges */}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="px-2 py-0.5 rounded-full font-bold" style={{ background:'#dbeafe', color:'#1d4ed8' }}>
              {selectedClients.length} selected
            </span>
            {serviceFilter !== 'all' && (
              <span className="px-2 py-0.5 rounded-full font-bold" style={{ background:'#f3e8ff', color:'#7c3aed' }}>
                Filter: {serviceFilter}
              </span>
            )}
            {clientsLoading && (
              <span className="flex items-center gap-1 text-slate-400">
                <Loader2 className="w-3 h-3 animate-spin" /> Loading...
              </span>
            )}
          </div>
          {/* List */}
          <div className="max-h-72 overflow-y-auto space-y-0.5 border rounded-xl" style={{ borderColor: isDark?'#334155':'#f1f5f9' }}>
            {filtered.length===0 && !clientsLoading && (
              <p className="text-center text-sm text-slate-400 py-8">No clients match</p>
            )}
            {filtered.map(client => (
              <label key={client.id}
                onClick={() => setSelectedIds(p => { const n=new Set(p); n.has(client.id)?n.delete(client.id):n.add(client.id); return n; })}
                className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors border-b last:border-b-0"
                style={{ borderColor: isDark?'#1e293b':'#f8fafc' }}>
                <div className="w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-all"
                  style={{ borderColor: selectedIds.has(client.id)?'#2563eb':'#cbd5e1', background: selectedIds.has(client.id)?'#2563eb':'transparent' }}>
                  {selectedIds.has(client.id) && <Check className="w-2.5 h-2.5 text-white" />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold truncate" style={{ color: isDark?'#e2e8f0':'#1e293b' }}>
                    {client.company_name||'—'}
                  </p>
                  <p className="text-[10px] text-slate-400 truncate">{client.email}</p>
                </div>
                <div className="flex flex-wrap gap-1 shrink-0 max-w-[120px] justify-end">
                  {(client.services||[]).slice(0,2).map((s,i) => (
                    <span key={i} className="text-[9px] px-1.5 py-0.5 rounded font-medium truncate max-w-[110px]"
                      style={{ background:'#f0fdf4', color:'#166534', border:'1px solid #bbf7d0' }}>
                      {s.slice(0,18)}
                    </span>
                  ))}
                  {client.city && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded"
                      style={{ background:'#f8fafc', color:'#94a3b8' }}>{client.city}</span>
                  )}
                </div>
              </label>
            ))}
          </div>
        </div>
      </SectionCard>

      {/* Progress */}
      {progress && (
        <div className="px-4 py-3 rounded-2xl border flex items-center gap-3"
          style={{ background: progress.failed>0?'#fff7ed':'#f0fdf4', borderColor: progress.failed>0?'#fed7aa':'#bbf7d0' }}>
          <CheckCircle2 className={`w-5 h-5 shrink-0 ${progress.failed>0?'text-amber-500':'text-emerald-500'}`} />
          <div className="flex-1">
            <p className="text-sm font-semibold" style={{ color: progress.failed>0?'#92400e':'#14532d' }}>
              {progress.done} sent{progress.failed>0 ? ` · ${progress.failed} failed` : ''}
            </p>
            <div className="mt-1.5 h-1.5 rounded-full bg-slate-200 overflow-hidden">
              <div className="h-full rounded-full bg-emerald-500 transition-all"
                style={{ width: `${Math.round((progress.done/(progress.total||1))*100)}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Send */}
      <button type="button" disabled={sending||!subject.trim()||!body.trim()||selectedClients.length===0}
        onClick={handleSend}
        className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl font-bold text-white text-sm transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        style={{ background:'linear-gradient(135deg,#0D3B66,#1F6FB2)', boxShadow:'0 4px 20px rgba(13,59,102,0.25)' }}>
        {sending
          ? <><Loader2 className="w-4 h-4 animate-spin" />Sending...</>
          : <><Send className="w-4 h-4" />Send to {selectedClients.length} Client{selectedClients.length!==1?'s':''}</>}
      </button>
    </div>
  );
}

// =============================================================================
// EmailTemplatesPanel
// =============================================================================
const TCAT_COLORS = { general:'#2563eb', follow_up:'#7c3aed', compliance:'#dc2626', greeting:'#16a34a', custom:'#d97706' };

function EmailTemplatesPanel({ isDark }) {
  const [templates, setTemplates] = React.useState([]);
  const [loading, setLoading]     = React.useState(true);
  const [editing, setEditing]     = React.useState(null);
  const [form, setForm]           = React.useState({ name:'', subject:'', body:'', is_html:false, category:'general', attachment_name:'', attachment_base64:'' });
  const attachInputRef = React.useRef(null);
  const [saving, setSaving]       = React.useState(false);
  const [deleting, setDeleting]   = React.useState(null);
  const bodyRef = React.useRef(null);

  const load = async () => {
    setLoading(true);
    try { const r = await api.get('/email/client-templates'); setTemplates(r.data||[]); }
    catch { toast.error('Failed to load templates'); }
    finally { setLoading(false); }
  };
  React.useEffect(() => { load(); }, []);

  const startEdit = t => { setForm({ name:t.name, subject:t.subject, body:t.body, is_html:!!t.is_html, category:t.category||'general', attachment_name:t.attachment_name||'', attachment_base64:t.attachment_base64||'' }); setEditing(t.id); };
  const startNew  = ()  => { setForm({ name:'', subject:'', body:'', is_html:false, category:'general', attachment_name:'', attachment_base64:'' }); setEditing('new'); };
  const cancel    = ()  => { setEditing(null); if(attachInputRef.current) attachInputRef.current.value=''; };

  const save = async () => {
    if (!form.name.trim()||!form.subject.trim()||!form.body.trim()) { toast.error('Name, subject and body required'); return; }
    setSaving(true);
    try {
      const payload = { ...form };
      if (editing==='new') { await api.post('/email/client-templates', payload); toast.success('Template created'); }
      else { await api.put(`/email/client-templates/${editing}`, payload); toast.success('Template updated'); }
      setEditing(null);
      if(attachInputRef.current) attachInputRef.current.value='';
      load();
    } catch (e) { toast.error(e.response?.data?.detail || `Save failed (${e.response?.status || 'network error'})`); }
    finally { setSaving(false); }
  };

  const handleAttachFile = e => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast.error('Attachment must be under 5 MB'); e.target.value=''; return; }
    const reader = new FileReader();
    reader.onload = ev => {
      const b64 = ev.target.result.split(',')[1];
      setForm(f => ({ ...f, attachment_name: file.name, attachment_base64: b64 }));
    };
    reader.readAsDataURL(file);
  };

  const removeAttachment = () => {
    setForm(f => ({ ...f, attachment_name: '', attachment_base64: '' }));
    if(attachInputRef.current) attachInputRef.current.value='';
  };

  const del = async id => {
    setDeleting(id);
    try { await api.delete(`/email/client-templates/${id}`); toast.success('Deleted'); load(); }
    catch { toast.error('Delete failed'); }
    finally { setDeleting(null); }
  };

  const copyTpl = t => navigator.clipboard?.writeText(`Subject: ${t.subject}\n\n${t.body}`)
    .then(()=>toast.success('Copied to clipboard'));

  const insertVar = v => {
    const el = bodyRef.current;
    if (el) {
      const s=el.selectionStart, e=el.selectionEnd;
      const nb = form.body.slice(0,s)+v+form.body.slice(e);
      setForm(f=>({...f,body:nb}));
      setTimeout(()=>{ el.focus(); el.setSelectionRange(s+v.length,s+v.length); },0);
    } else setForm(f=>({...f,body:f.body+v}));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-bold text-sm" style={{color:isDark?'#f1f5f9':'#1e293b'}}>Saved Email Templates</h3>
          <p className="text-xs mt-0.5" style={{color:isDark?'#64748b':'#94a3b8'}}>{templates.length} template{templates.length!==1?'s':''} · load into Compose tab</p>
        </div>
        <button type="button" onClick={startNew}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-bold text-white transition-all active:scale-95"
          style={{ background:'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
          <Plus className="w-4 h-4" /> New Template
        </button>
      </div>

      {editing!==null && (
        <SectionCard>
          <CardHeaderRow iconBg="bg-indigo-50 dark:bg-indigo-900/30" icon={<FileText className="w-4 h-4 text-indigo-500" />}
            title={editing==='new'?'New Template':'Edit Template'} subtitle="Use {variable} tokens for personalisation"
            action={<button type="button" onClick={cancel} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4"/></button>} />
          <div className="p-4 space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Template Name</label>
                <input value={form.name} onChange={e=>setForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Monthly Follow-Up"
                  className="w-full border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  style={{ borderColor: isDark?'#334155':'#e2e8f0' }} />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">Category</label>
                <select value={form.category} onChange={e=>setForm(f=>({...f,category:e.target.value}))}
                  className="w-full border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  style={{ borderColor: isDark?'#334155':'#e2e8f0' }}>
                  {['general','follow_up','compliance','greeting','custom'].map(c=><option key={c} value={c}>{c.replace('_',' ')}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1">Subject</label>
              <input value={form.subject} onChange={e=>setForm(f=>({...f,subject:e.target.value}))} placeholder="e.g. Update for {name}"
                className="w-full border rounded-xl px-3 py-2 text-sm bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                style={{ borderColor: isDark?'#334155':'#e2e8f0' }} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-slate-400">Message Body</label>
                <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-400 select-none">
                  <input type="checkbox" checked={form.is_html} onChange={e=>setForm(f=>({...f,is_html:e.target.checked}))} className="rounded" />
                  HTML mode
                </label>
              </div>
              <VariablesBar onInsert={insertVar} />
              <textarea ref={bodyRef} value={form.body} onChange={e=>setForm(f=>({...f,body:e.target.value}))}
                rows={form.is_html?16:12}
                placeholder={form.is_html?'<p>Dear {name},</p>':'Dear {name},\n\nYour message...\n\nRegards'}
                className="w-full border rounded-xl px-3 py-2 text-sm font-mono resize-y bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                style={{ borderColor: isDark?'#334155':'#e2e8f0' }} />
            </div>

            {/* ── Attachment ── */}
            <div>
              <label className="block text-xs font-semibold text-slate-400 mb-1.5">Attachment <span className="font-normal text-slate-300">(optional · max 5 MB · sent with every email using this template)</span></label>
              {form.attachment_name ? (
                <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl border"
                  style={{ borderColor: isDark?'#334155':'#e2e8f0', background: isDark?'#1e293b':'#f8fafc' }}>
                  <Paperclip className="w-4 h-4 text-indigo-400 flex-shrink-0"/>
                  <span className="text-xs font-medium flex-1 truncate" style={{ color: isDark?'#e2e8f0':'#1e293b' }}>{form.attachment_name}</span>
                  <button type="button" onClick={removeAttachment}
                    className="w-5 h-5 flex items-center justify-center rounded-full hover:bg-red-100 dark:hover:bg-red-900/30 text-slate-400 hover:text-red-500 transition-colors flex-shrink-0">
                    <X className="w-3 h-3"/>
                  </button>
                </div>
              ) : (
                <label className="flex items-center gap-2 px-3 py-2 rounded-xl border border-dashed cursor-pointer transition-colors hover:border-indigo-400 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/10"
                  style={{ borderColor: isDark?'#334155':'#cbd5e1' }}>
                  <Paperclip className="w-4 h-4 text-slate-400"/>
                  <span className="text-xs text-slate-400">Click to attach a file (PDF, DOCX, XLSX, image…)</span>
                  <input ref={attachInputRef} type="file" className="hidden"
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.jpg,.jpeg,.png,.gif"
                    onChange={handleAttachFile}/>
                </label>
              )}
            </div>

            <div className="flex gap-2 pt-1">
              <button type="button" onClick={save} disabled={saving}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold text-white transition-all active:scale-95 disabled:opacity-50"
                style={{ background:'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
                {saving?<Loader2 className="w-4 h-4 animate-spin"/>:<Save className="w-4 h-4"/>}
                {saving?'Saving...':(editing==='new'?'Create Template':'Save Changes')}
              </button>
              <button type="button" onClick={cancel}
                className="px-6 py-2.5 rounded-xl text-sm font-semibold border transition-all"
                style={{ borderColor: isDark?'#334155':'#e2e8f0', color: isDark?'#94a3b8':'#64748b' }}>Cancel</button>
            </div>
          </div>
        </SectionCard>
      )}

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
      ) : templates.length===0 && editing===null ? (
        <SectionCard>
          <div className="py-14 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto bg-slate-100 dark:bg-slate-700">
              <FileText className="w-8 h-8 text-slate-400" />
            </div>
            <p className="font-semibold" style={{color:isDark?'#f1f5f9':'#374151'}}>No templates yet</p>
            <p className="text-sm text-slate-400">Create reusable templates to save time</p>
            <button type="button" onClick={startNew}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white transition-all active:scale-95"
              style={{ background:'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
              <Plus className="w-4 h-4" /> Create First Template
            </button>
          </div>
        </SectionCard>
      ) : (
        <div className="space-y-3">
          {templates.map(tpl => (
            <SectionCard key={tpl.id}>
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-bold text-sm" style={{color:isDark?'#f1f5f9':'#1e293b'}}>{tpl.name}</span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold uppercase text-white"
                        style={{background:TCAT_COLORS[tpl.category]||'#64748b'}}>
                        {(tpl.category||'general').replace('_',' ')}
                      </span>
                      {tpl.is_html&&<span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-orange-100 text-orange-600">HTML</span>}
                      {tpl.attachment_name&&<span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-100 text-violet-600 flex items-center gap-1"><Paperclip className="w-2.5 h-2.5"/>{tpl.attachment_name.length>18?tpl.attachment_name.slice(0,18)+'…':tpl.attachment_name}</span>}
                    </div>
                    <p className="text-xs font-medium text-slate-500 truncate">📧 {tpl.subject}</p>
                    <p className="text-xs text-slate-400 mt-0.5 line-clamp-2">{(tpl.body||'').replace(/<[^>]*>/g,'').slice(0,140)}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {['name','email','phone','gstin','city','services'].filter(k=>tpl.body?.includes('{'+k+'}')||tpl.subject?.includes('{'+k+'}')).map(k=>(
                        <span key={k} className="px-1.5 py-0.5 rounded text-[10px] font-mono" style={{background:'#eef2ff',color:'#4338ca'}}>{'{'+k+'}'}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button type="button" onClick={()=>copyTpl(tpl)} title="Copy"
                      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-400">
                      <Copy className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={()=>startEdit(tpl)} title="Edit"
                      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-400">
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button type="button" onClick={()=>del(tpl.id)} disabled={deleting===tpl.id} title="Delete"
                      className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors hover:bg-red-50 dark:hover:bg-red-900/20 text-red-400 disabled:opacity-50">
                      {deleting===tpl.id?<Loader2 className="w-3.5 h-3.5 animate-spin"/>:<Trash2 className="w-3.5 h-3.5"/>}
                    </button>
                  </div>
                </div>
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}


// =============================================================================
// SenderSelectorPanel — switch active Brevo sender on the fly
// =============================================================================
function SenderSelectorPanel({ isDark }) {
  const [senders,       setSenders]       = useState([]);
  const [activeEmail,   setActiveEmail]   = useState("");
  const [activeName,    setActiveName]    = useState("");
  const [source,        setSource]        = useState("env");
  const [loading,       setLoading]       = useState(true);
  const [switching,     setSwitching]     = useState(false);
  const [adding,        setAdding]        = useState(false);
  const [newEmail,      setNewEmail]      = useState("");
  const [newName,       setNewName]       = useState("");
  const [showAdd,       setShowAdd]       = useState(false);

  const inputStyle = { backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#d1d5db", color: isDark ? D.text : "#1e293b" };
  const inputCls   = "px-3 py-2 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all";

  const fetchSenders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get("/email/senders/list");
      setSenders(res.data?.senders || []);
      const active = await api.get("/email/senders/active");
      setActiveEmail(active.data?.active_email || "");
      setActiveName(active.data?.active_name || "");
      setSource(active.data?.source || "env");
    } catch { setSenders([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchSenders(); }, [fetchSenders]);

  const handleSwitch = async (email, name) => {
    setSwitching(email);
    try {
      await api.post("/email/senders/set-active", { email, name });
      setActiveEmail(email);
      setActiveName(name);
      setSource("db");
      toast.success(`✓ Now sending from ${email}`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to switch sender");
    } finally { setSwitching(false); }
  };

  const handleAdd = async () => {
    const em = newEmail.trim().toLowerCase();
    const nm = newName.trim() || em;
    if (!em || !em.includes("@")) { toast.error("Enter a valid email address"); return; }
    setAdding(true);
    try {
      await api.post("/email/senders/add", { email: em, name: nm });
      toast.success(`${em} added to sender list`);
      setNewEmail(""); setNewName(""); setShowAdd(false);
      fetchSenders();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to add sender");
    } finally { setAdding(false); }
  };

  const handleRemove = async (email) => {
    if (!window.confirm(`Remove ${email} from sender list?`)) return;
    try {
      await api.delete(`/email/senders/${encodeURIComponent(email)}`);
      toast.success(`${email} removed`);
      fetchSenders();
    } catch { toast.error("Failed to remove"); }
  };

  return (
    <SectionCard>
      <CardHeaderRow
        iconBg={isDark ? "bg-blue-900/40" : "bg-blue-50"}
        icon={<Send className="w-4 h-4 text-blue-500" />}
        title="Active Sender Email"
        subtitle="Switch which Brevo-verified email sends all outgoing emails"
        action={
          <button onClick={() => setShowAdd(s => !s)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all"
            style={{ color: COLORS.mediumBlue, borderColor: COLORS.mediumBlue + "50", backgroundColor: isDark ? COLORS.mediumBlue + "15" : COLORS.mediumBlue + "0a" }}>
            <Plus className="w-3 h-3" /> Add Sender
          </button>
        }
      />

      {/* Current active banner */}
      <div className="mx-4 mt-4 p-3.5 rounded-xl border-2 flex items-center gap-3"
        style={{ borderColor: COLORS.emeraldGreen, backgroundColor: isDark ? "rgba(31,175,90,0.1)" : "#f0fdf4" }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: isDark ? "rgba(31,175,90,0.2)" : "#dcfce7" }}>
          <CheckCircle2 className="w-5 h-5 text-emerald-500" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-500 mb-0.5">Currently Active Sender</p>
          <p className="text-sm font-bold truncate" style={{ color: isDark ? D.text : "#1e293b" }}>
            {activeEmail || "Not configured"}
          </p>
          {activeName && <p className="text-xs" style={{ color: isDark ? D.muted : "#64748b" }}>{activeName}</p>}
        </div>
        <span className="text-[10px] font-bold px-2 py-1 rounded-full flex-shrink-0"
          style={{ backgroundColor: isDark ? "rgba(31,175,90,0.2)" : "#dcfce7", color: COLORS.emeraldGreen }}>
          {source === "db" ? "DB Setting" : "Env Var"}
        </span>
      </div>

      {/* Add new sender form */}
      <AnimatePresence>
        {showAdd && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden">
            <div className="mx-4 mt-3 p-4 rounded-xl border space-y-3"
              style={{ borderColor: isDark ? D.border : "#e2e8f0", backgroundColor: isDark ? D.raised : "#f8fafc" }}>
              <p className="text-xs font-bold" style={{ color: isDark ? D.text : "#374151" }}>
                Add a Brevo-verified email address
              </p>
              <div className="flex gap-2">
                <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
                  placeholder="info@yourdomain.com"
                  onKeyDown={e => e.key === "Enter" && handleAdd()}
                  className={inputCls + " flex-1"} style={inputStyle} />
                <input value={newName} onChange={e => setNewName(e.target.value)}
                  placeholder="Display Name"
                  onKeyDown={e => e.key === "Enter" && handleAdd()}
                  className={inputCls + " w-36"} style={inputStyle} />
                <Button onClick={handleAdd} disabled={adding}
                  className="h-10 px-4 rounded-xl text-sm font-semibold text-white flex-shrink-0"
                  style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                  {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                </Button>
              </div>
              <p className="text-[10px]" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
                ⚠️ The email must be verified in your Brevo account (Senders, domains &amp; IPs) before it can be used.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Sender list */}
      <div className="p-4 space-y-2">
        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-blue-400" /></div>
        ) : senders.length === 0 ? (
          <div className="py-6 text-center">
            <Mail className="w-7 h-7 mx-auto mb-2 opacity-20" />
            <p className="text-xs" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
              No saved senders yet. Add your Brevo-verified emails above.
            </p>
          </div>
        ) : (
          senders.map(s => {
            const isActive = s.email === activeEmail;
            return (
              <motion.div key={s.email} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="flex items-center gap-3 p-3 rounded-xl border transition-all"
                style={{
                  borderColor: isActive ? COLORS.emeraldGreen : (isDark ? D.border : "#e2e8f0"),
                  backgroundColor: isActive
                    ? (isDark ? "rgba(31,175,90,0.08)" : "#f0fdf4")
                    : (isDark ? D.raised : "#f8fafc"),
                }}>
                {/* Avatar */}
                <div className="w-9 h-9 rounded-xl flex items-center justify-center font-black text-white flex-shrink-0 text-sm"
                  style={{ backgroundColor: isActive ? COLORS.emeraldGreen : (isDark ? "#475569" : "#94a3b8") }}>
                  {s.name?.charAt(0)?.toUpperCase() || s.email?.charAt(0)?.toUpperCase() || "?"}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: isDark ? D.text : "#1e293b" }}>
                    {s.name || s.email}
                  </p>
                  <p className="text-xs truncate" style={{ color: isDark ? D.muted : "#64748b" }}>{s.email}</p>
                </div>

                {/* Status / Action */}
                {isActive ? (
                  <span className="flex items-center gap-1 text-xs font-bold px-2.5 py-1 rounded-full flex-shrink-0"
                    style={{ backgroundColor: isDark ? "rgba(31,175,90,0.2)" : "#dcfce7", color: COLORS.emeraldGreen }}>
                    <CheckCircle2 className="w-3 h-3" /> Active
                  </span>
                ) : (
                  <button
                    disabled={switching === s.email}
                    onClick={() => handleSwitch(s.email, s.name || s.email)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold border transition-all active:scale-95 flex-shrink-0"
                    style={{ color: COLORS.mediumBlue, borderColor: COLORS.mediumBlue + "50", backgroundColor: isDark ? COLORS.mediumBlue + "15" : COLORS.mediumBlue + "0a" }}>
                    {switching === s.email
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Zap className="w-3 h-3" />}
                    Use This
                  </button>
                )}

                {/* Remove */}
                {!isActive && s.source !== "env" && (
                  <button onClick={() => handleRemove(s.email)}
                    className="w-7 h-7 flex items-center justify-center rounded-lg transition-all flex-shrink-0"
                    style={{ color: isDark ? D.muted : "#94a3b8" }}
                    onMouseEnter={e => { e.currentTarget.style.color = COLORS.red; e.currentTarget.style.backgroundColor = isDark ? "rgba(239,68,68,0.12)" : "#fef2f2"; }}
                    onMouseLeave={e => { e.currentTarget.style.color = isDark ? D.muted : "#94a3b8"; e.currentTarget.style.backgroundColor = "transparent"; }}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </motion.div>
            );
          })
        )}
      </div>

      {/* Info note */}
      <div className="mx-4 mb-4 p-3 rounded-xl border flex items-start gap-2"
        style={{ backgroundColor: isDark ? "rgba(59,130,246,0.08)" : "#eff6ff", borderColor: isDark ? "#1d4ed8" : "#bfdbfe" }}>
        <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-[11px]" style={{ color: isDark ? "#93c5fd" : "#1e40af" }}>
          Switching sender takes effect immediately for all new emails — no server restart or redeployment needed.
          The display name shown to recipients can be different from the email address (e.g. "MDA Associates" using info.taskosphere@gmail.com).
        </p>
      </div>
    </SectionCard>
  );
}


// =============================================================================
// LinkedUsersPanel — Admin assigns users to an email connection.
// Each linked user sees this email's scraped events in their Action Center.
// Users can also set their own keywords for that connection.
// =============================================================================
function LinkedUsersPanel({ conn, isDark, isAdmin, currentUserId }) {
  const [open,        setOpen]       = useState(false);
  const [allUsers,    setAllUsers]   = useState([]);
  const [linkedUsers, setLinkedUsers]= useState(conn.linked_users || []);
  const [linkedIds,   setLinkedIds]  = useState((conn.linked_user_ids || []));
  const [loadingUsers,setLoadingUsers]=useState(false);
  const [saving,      setSaving]     = useState(false);
  const [search,      setSearch]     = useState("");

  // Per-linked-user keywords state (for current user if they are linked)
  const [myKwDraft,   setMyKwDraft]  = useState("");
  const [myKeywords,  setMyKeywords] = useState([]);
  const [savingKw,    setSavingKw]   = useState(false);

  const isLinkedToMe = linkedIds.includes(currentUserId) && conn.owner_user_id !== currentUserId;

  // Load my keywords from linked_users list
  useEffect(() => {
    const me = (conn.linked_users || []).find(u => u.id === currentUserId);
    setMyKeywords(me?.keywords || []);
  }, [conn.linked_users, currentUserId]);

  const fetchAllUsers = async () => {
    if (allUsers.length > 0) return;
    setLoadingUsers(true);
    try {
      const res = await api.get("/users");
      const users = Array.isArray(res.data) ? res.data : (res.data?.users || []);
      setAllUsers(users);
    } catch { toast.error("Failed to load users"); }
    finally { setLoadingUsers(false); }
  };

  const handleToggleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next && isAdmin) fetchAllUsers();
  };

  const handleToggleUser = async (userId, userName) => {
    if (!isAdmin) return;
    const isLinked = linkedIds.includes(userId);
    const nextIds = isLinked
      ? linkedIds.filter(id => id !== userId)
      : [...linkedIds, userId];
    setSaving(true);
    try {
      await api.put(`/email/connections/${encodeURIComponent(conn.email_address)}/linked-users`, {
        user_ids: nextIds,
      });
      setLinkedIds(nextIds);
      if (isLinked) {
        setLinkedUsers(prev => prev.filter(u => u.id !== userId));
        toast.success(`Unlinked ${userName}`);
      } else {
        const userObj = allUsers.find(u => String(u.id) === String(userId));
        setLinkedUsers(prev => [...prev, {
          id: userId,
          name: userObj?.full_name || userObj?.name || userName,
          email: userObj?.email || "",
          keywords: [],
        }]);
        toast.success(`${userName} will now see this email's events in their Action Center`);
      }
    } catch { toast.error("Failed to update linked users"); }
    finally { setSaving(false); }
  };

  const handleAddMyKeyword = async () => {
    const kw = myKwDraft.trim();
    if (!kw) return;
    if (myKeywords.includes(kw)) { setMyKwDraft(""); return; }
    const next = [...myKeywords, kw];
    setMyKeywords(next);
    setMyKwDraft("");
    setSavingKw(true);
    try {
      await api.patch(`/email/connections/${encodeURIComponent(conn.email_address)}/my-keywords`, { keywords: next });
      toast.success("Keyword saved");
    } catch { toast.error("Failed to save keyword"); }
    finally { setSavingKw(false); }
  };

  const handleRemoveMyKeyword = async (kw) => {
    const next = myKeywords.filter(k => k !== kw);
    setMyKeywords(next);
    setSavingKw(true);
    try {
      await api.patch(`/email/connections/${encodeURIComponent(conn.email_address)}/my-keywords`, { keywords: next });
    } catch { toast.error("Failed to remove keyword"); }
    finally { setSavingKw(false); }
  };

  const filteredUsers = allUsers.filter(u => {
    const q = search.toLowerCase();
    return !q || (u.full_name || u.name || "").toLowerCase().includes(q) || (u.email || "").toLowerCase().includes(q);
  });

  const inputCls = "px-3 py-1.5 border rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all";
  const inputStyle = { backgroundColor: isDark ? D.raised : "#ffffff", borderColor: isDark ? D.border : "#d1d5db", color: isDark ? D.text : "#1e293b" };

  return (
    <div className="mx-4 mb-3">
      {/* Trigger button */}
      <button
        onClick={handleToggleOpen}
        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all"
        style={{
          borderColor: open ? COLORS.mediumBlue + "60" : (isDark ? D.border : "#e2e8f0"),
          backgroundColor: open ? (isDark ? "rgba(31,111,178,0.10)" : "#eff6ff") : (isDark ? D.raised : "#f8fafc"),
        }}
      >
        <div className="flex items-center gap-2">
          <Users className="w-3.5 h-3.5" style={{ color: open ? COLORS.mediumBlue : (isDark ? D.muted : "#94a3b8") }} />
          <span className="text-xs font-semibold" style={{ color: open ? COLORS.mediumBlue : (isDark ? D.muted : "#64748b") }}>
            {isAdmin ? "Linked Users" : "My Keywords for this Email"}
            {linkedIds.length > 0 && isAdmin && (
              <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold text-white" style={{ backgroundColor: COLORS.mediumBlue }}>
                {linkedIds.length}
              </span>
            )}
          </span>
          {!isAdmin && isLinkedToMe && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-bold" style={{ backgroundColor: isDark ? "rgba(31,175,90,0.15)" : "#dcfce7", color: COLORS.emeraldGreen }}>
              Linked to you
            </span>
          )}
        </div>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} style={{ color: isDark ? D.muted : "#94a3b8" }} />
      </button>

      {open && (
        <div className="mt-2 rounded-xl border overflow-hidden" style={{ borderColor: isDark ? D.border : "#e2e8f0", backgroundColor: isDark ? D.card : "#ffffff" }}>

          {/* ── ADMIN SECTION: assign users ── */}
          {isAdmin && (
            <div className="p-3 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
                Assign users — they will see scraped events from this email in their Action Center
              </p>

              {/* Currently linked */}
              {linkedUsers.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold" style={{ color: isDark ? D.muted : "#64748b" }}>Currently linked ({linkedUsers.length})</p>
                  {linkedUsers.map(lu => (
                    <div key={lu.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border"
                      style={{ borderColor: isDark ? "rgba(31,175,90,0.25)" : "#bbf7d0", backgroundColor: isDark ? "rgba(31,175,90,0.07)" : "#f0fdf4" }}>
                      <div className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-black text-white flex-shrink-0"
                        style={{ backgroundColor: COLORS.emeraldGreen }}>
                        {(lu.name || lu.email || "?")[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold truncate" style={{ color: isDark ? D.text : "#1e293b" }}>{lu.name}</p>
                        <p className="text-[10px] truncate" style={{ color: isDark ? D.muted : "#94a3b8" }}>{lu.email}</p>
                        {lu.keywords?.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {lu.keywords.map(kw => (
                              <span key={kw} className="text-[9px] px-1.5 py-0.5 rounded font-mono"
                                style={{ backgroundColor: isDark ? "rgba(99,102,241,0.15)" : "#eef2ff", color: isDark ? "#a5b4fc" : "#4338ca" }}>
                                {kw}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        disabled={saving}
                        onClick={() => handleToggleUser(lu.id, lu.name)}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50"
                        style={{ color: COLORS.red, backgroundColor: isDark ? "rgba(239,68,68,0.10)" : "#fef2f2", border: `1px solid ${COLORS.red}30` }}>
                        <UserMinus className="w-3 h-3" /> Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Add users from full list */}
              <div className="space-y-2">
                <p className="text-[10px] font-semibold" style={{ color: isDark ? D.muted : "#64748b" }}>Add a user</p>
                <input
                  value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  className={inputCls + " w-full"}
                  style={inputStyle}
                />
                {loadingUsers ? (
                  <div className="flex justify-center py-3"><Loader2 className="w-4 h-4 animate-spin text-blue-400" /></div>
                ) : (
                  <div className="max-h-48 overflow-y-auto space-y-1 border rounded-lg" style={{ borderColor: isDark ? D.border : "#f1f5f9" }}>
                    {filteredUsers.filter(u => !linkedIds.includes(String(u.id))).slice(0, 20).map(u => (
                      <button key={u.id}
                        disabled={saving}
                        onClick={() => handleToggleUser(String(u.id), u.full_name || u.name || u.email)}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors disabled:opacity-50"
                      >
                        <div className="w-6 h-6 rounded-md flex items-center justify-center text-[10px] font-black text-white flex-shrink-0"
                          style={{ backgroundColor: COLORS.mediumBlue }}>
                          {((u.full_name || u.name || u.email || "?")[0]).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate" style={{ color: isDark ? D.text : "#1e293b" }}>{u.full_name || u.name || u.email}</p>
                          <p className="text-[10px] truncate" style={{ color: isDark ? D.muted : "#94a3b8" }}>{u.email} · {u.role}</p>
                        </div>
                        <UserPlus className="w-3.5 h-3.5 flex-shrink-0" style={{ color: COLORS.emeraldGreen }} />
                      </button>
                    ))}
                    {filteredUsers.filter(u => !linkedIds.includes(String(u.id))).length === 0 && (
                      <p className="text-xs text-center py-4" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>No more users to add</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── NON-ADMIN SECTION: keyword editing for linked users ── */}
          {!isAdmin && isLinkedToMe && (
            <div className="p-3 space-y-3">
              <div className="flex items-start gap-2 p-2.5 rounded-lg border"
                style={{ backgroundColor: isDark ? "rgba(59,130,246,0.08)" : "#eff6ff", borderColor: isDark ? "#1d4ed8" : "#bfdbfe" }}>
                <Key className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 mt-0.5" />
                <p className="text-[11px]" style={{ color: isDark ? "#93c5fd" : "#1e40af" }}>
                  This email has been linked to your account by an admin. Add keywords below — only emails whose subject matches these keywords will appear in <strong>your</strong> Action Center from this email.
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
                  My keywords for {conn.email_address}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {myKeywords.map(kw => (
                    <span key={kw} className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-semibold border"
                      style={{ backgroundColor: isDark ? "rgba(99,102,241,0.12)" : "#eef2ff", borderColor: isDark ? "rgba(99,102,241,0.30)" : "#c7d2fe", color: isDark ? "#a5b4fc" : "#4338ca" }}>
                      {kw}
                      <button onClick={() => handleRemoveMyKeyword(kw)} className="opacity-70 hover:opacity-100"><X className="w-3 h-3" /></button>
                    </span>
                  ))}
                  {myKeywords.length === 0 && (
                    <span className="text-[11px] italic" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>No keywords — all scraped emails from this account will appear</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    value={myKwDraft}
                    onChange={e => setMyKwDraft(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddMyKeyword(); } }}
                    placeholder="Add a keyword (press Enter)"
                    className={inputCls + " flex-1"}
                    style={inputStyle}
                  />
                  <button
                    onClick={handleAddMyKeyword}
                    disabled={savingKw || !myKwDraft.trim()}
                    className="px-3 py-1.5 rounded-xl text-xs font-bold text-white disabled:opacity-50 transition-all active:scale-95"
                    style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                    {savingKw ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}
                  </button>
                </div>
                {myKeywords.length > 0 && (
                  <p className="text-[10px]" style={{ color: isDark ? D.dimmer : "#94a3b8" }}>
                    ✓ Only emails matching these keywords will show in your Action Center. Leave empty to see all.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function EmailSettings() {
  const isDark = useDark();
  const { user, isPlatformOwner } = useAuth();

  const [connections,     setConnections]     = useState([]);
  const [loading,         setLoading]         = useState(true);
  const [activeForm,      setActiveForm]      = useState(null);
  const [showAddOptions,  setShowAddOptions]  = useState(false);
  const [extractedEvents, setExtractedEvents] = useState([]);
  const [scanning,        setScanning]        = useState(false);
  const [clearing,        setClearing]        = useState(false);
  const [activeTab,       setActiveTab]       = useState(() => {
    // ?tab=organisation (also legacy ?tab=sender) opens the Organisation Email tab,
    // e.g. after a Google/Microsoft sign-in or from a module's "Connect your email" link.
    const tab = new URLSearchParams(window.location.search).get("tab");
    return tab === "organisation" || tab === "sender" ? "organisation" : "accounts";
  });
  // Session-level set of saved event keys — prevents duplicates within the session
  const [savedKeys, setSavedKeys] = useState(() => new Set());

  const loadConnections = useCallback(async () => {
    try {
      const res = await api.get("/email/connections");
      setConnections(res.data?.connections || []);
    } catch { } finally { setLoading(false); }
  }, []);


  useEffect(() => { loadConnections(); }, [loadConnections]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const emailStatus = params.get("email");
    if (!emailStatus) return;

    if (emailStatus === "connected") {
      toast.success("Gmail connected successfully");
      loadConnections();
    } else if (emailStatus === "denied") {
      toast.error("Google connection was cancelled");
    } else if (emailStatus === "error") {
      toast.error("Google email connection failed. Check OAuth redirect URI and scopes.");
    }

    params.delete("email");
    params.delete("reason");
    const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState({}, "", clean);
  }, [loadConnections]);

  const handleDisconnect = async (emailAddress) => {
    if (!window.confirm(`Disconnect ${emailAddress}? Events already imported will remain.`)) return;
    try {
      await api.delete(`/email/connections/${encodeURIComponent(emailAddress)}`);
      setConnections(prev => prev.filter(c => c.email_address !== emailAddress));
      toast.success(`${emailAddress} disconnected`);
    } catch { toast.error("Failed to disconnect"); }
  };

  const handleTest = async (emailAddress) => {
    try {
      await api.post(`/email/connections/${encodeURIComponent(emailAddress)}/test`);
      toast.success(`✓ ${emailAddress} is working`);
      loadConnections();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Connection test failed");
      loadConnections();
    }
  };

  const handleToggle = async (emailAddress, isActive) => {
    try {
      await api.patch(`/email/connections/${encodeURIComponent(emailAddress)}`, { is_active: isActive });
      setConnections(prev => prev.map(c => c.email_address === emailAddress ? { ...c, is_active: isActive } : c));
      toast.success(isActive ? "Account resumed" : "Account paused");
    } catch { toast.error("Failed to update"); }
  };

  // handleSync — uses last_synced as the base date so only new emails since
  // last sync are fetched. Shows events in preview panel, no auto-save.
  const handleSync = useCallback(async (emailAddress, lastSynced) => {
    try {
      const sinceParam = lastSynced ? `&since_date=${encodeURIComponent(lastSynced)}` : "";
      const emailParam = `&email=${encodeURIComponent(emailAddress)}`;
      const res = await api.get(
        `/email/extract-events?force_refresh=true&limit=50${sinceParam}${emailParam}`,
        { timeout: 60000 }
      );
      const raw    = (res.data || []).filter(e => !e.email_account || e.email_account === emailAddress);
      const deduped = raw.filter(e => !savedKeys.has(eventKey(e)));

      if (deduped.length === 0) {
        toast.success("Sync complete — no new legal events found since last sync");
        loadConnections();
        return;
      }

      // Merge into panel, avoiding duplicate keys
      setExtractedEvents(prev => {
        const existingKeys = new Set(prev.map(eventKey));
        const newOnes      = deduped.filter(e => !existingKeys.has(eventKey(e)));
        return [...prev, ...newOnes];
      });

      const futureCount = deduped.filter(e => !isEventPast(e)).length;
      const pastCount   = deduped.filter(e => isEventPast(e)).length;
      toast.success(`✓ Synced — ${futureCount} new future event${futureCount !== 1 ? "s" : ""}${pastCount > 0 ? ` · ${pastCount} past (filtered)` : ""}`);
      loadConnections();
    } catch (err) { toast.error(err?.response?.data?.detail || "Sync failed"); }
  }, [savedKeys, loadConnections]);

  // handleSyncRetro — retrospective sync: re-scans further back than the
  // normal rolling window (e.g. last 90 days / 1 year / all time), ignoring
  // last_synced entirely. Safe to run repeatedly — the backend skips any
  // email it has already seen (matched by Message-ID) and every save action
  // is itself deduplicated, so nothing gets added twice.
  const handleSyncRetro = useCallback(async (emailAddress, daysBack, label) => {
    try {
      toast.info(`Scanning ${label || `last ${daysBack} days`} of mail for ${emailAddress}…`, { duration: 4000 });
      const sinceDate = daysBack
        ? new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10)
        : "1970-01-01"; // "All time"
      const res = await api.get(
        `/email/extract-events?force_refresh=true&limit=300&since_date=${sinceDate}&email=${encodeURIComponent(emailAddress)}`,
        { timeout: 120000 }
      );
      const raw     = (res.data || []).filter(e => !e.email_account || e.email_account === emailAddress);
      const deduped = raw.filter(e => !savedKeys.has(eventKey(e)));

      setExtractedEvents(prev => {
        const existingKeys = new Set(prev.map(eventKey));
        const newOnes      = deduped.filter(e => !existingKeys.has(eventKey(e)));
        return [...prev, ...newOnes];
      });

      toast.success(
        raw.length === 0
          ? `No legal events found in ${emailAddress}'s history for that range`
          : `✓ Retrospective sync complete — ${raw.length} event${raw.length !== 1 ? "s" : ""} found (duplicates auto-skipped)`
      );
      loadConnections();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Retrospective sync failed");
    }
  }, [savedKeys, loadConnections]);

  // handleScanAll — scans all accounts; each account's last_synced is the
  // natural base date on the backend. Shows everything in preview panel.
  const handleScanAll = async () => {
    if (connections.length === 0) { toast.error("No email accounts connected"); return; }
    setScanning(true);
    try {
      const res    = await api.get("/email/extract-events?force_refresh=true&limit=100", { timeout: 90000 });
      const raw    = res.data || [];
      const deduped = raw.filter(e => !savedKeys.has(eventKey(e)));

      if (raw.length === 0) {
        toast.success("All emails scanned — no legal events found");
        return;
      }

      // Merge avoiding duplicate keys
      setExtractedEvents(prev => {
        const existingKeys = new Set(prev.map(eventKey));
        const newOnes      = deduped.filter(e => !existingKeys.has(eventKey(e)));
        return [...prev, ...newOnes];
      });

      const futureCount = deduped.filter(e => !isEventPast(e)).length;
      const pastCount   = deduped.filter(e => isEventPast(e)).length;
      toast.success(
        `✓ ${raw.length} event${raw.length !== 1 ? "s" : ""} found · ${futureCount} future (review in preview)${pastCount > 0 ? ` · ${pastCount} past (filtered)` : ""}`
      );
    } catch (err) {
      if (err.code === "ECONNABORTED" || err.message?.includes("timeout"))
        toast.error("Scan taking too long. Try syncing accounts individually.");
      else
        toast.error(err?.response?.data?.detail || "Scan failed");
    } finally { setScanning(false); }
  };

  const handleClearAll = async () => {
    if (!window.confirm("Clear all extracted events cache? Forces a completely fresh scan.\nNote: Already-saved reminders, todos, and visits will NOT be deleted.")) return;
    setClearing(true);
    try {
      await api.delete("/email/events/clear-all");
      setExtractedEvents([]);
      setSavedKeys(new Set()); // also reset session keys when cache cleared
      toast.success("Cache cleared. Run a fresh scan anytime.");
    } catch { toast.error("Failed to clear cache"); }
    finally { setClearing(false); }
  };

  const handleConnectSuccess = () => {
    setActiveForm(null); setShowAddOptions(false); loadConnections();
  };

  const handleUpdateSettings = useCallback((emailAddress, updates) => {
    setConnections(prev => prev.map(c => c.email_address === emailAddress ? { ...c, ...updates } : c));
  }, []);

  // Called by ScanPreviewPanel after successful saves — add keys to session set
  const handleEventsSaved = useCallback((newKeys) => {
    setSavedKeys(prev => {
      const next = new Set(prev);
      newKeys.forEach(k => next.add(k));
      return next;
    });
  }, []);

  const activeProvider   = QUICK_PROVIDERS.find(p => p.id === activeForm);
  const futureEventCount = extractedEvents.filter(e => !isEventPast(e) && !savedKeys.has(eventKey(e))).length;

  const TAB_CONFIG = [
    { id: "accounts",  label: "Accounts",       icon: Mail      },
    { id: "whitelist", label: "Whitelist",      icon: Filter    },
    { id: "blacklist", label: "Blacklist",      icon: Shield    },
    { id: "rules",     label: "Smart Rules",    icon: Tag       },
    { id: "compose",   label: "Compose & Send", icon: Send      },
    { id: "templates", label: "Templates",      icon: FileText  },
    { id: "organisation", label: "Organisation Email", icon: Send },
    { id: "settings",  label: "Settings",       icon: Settings2 },
  ];

  return (
    <TooltipProvider>

      <motion.div className="min-h-screen p-5 md:p-6 lg:p-8 space-y-5"
        style={{ background: isDark ? D.bg : "#f8fafc" }}
        variants={containerVariants} initial="hidden" animate="visible">

        {/* ══ PAGE HEADER ══ */}
        <motion.div variants={itemVariants}>
          <div className="relative overflow-hidden rounded-2xl px-6 py-5"
            style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue} 0%, ${COLORS.mediumBlue} 100%)`, boxShadow: "0 8px 32px rgba(13,59,102,0.25)" }}>
            <div className="absolute right-0 top-0 w-64 h-64 rounded-full -mr-20 -mt-20 opacity-10"
              style={{ background: "radial-gradient(circle, white 0%, transparent 70%)" }} />
            <div className="relative flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div>
                <p className="text-white/60 text-xs font-medium uppercase tracking-widest mb-1">Integrations</p>
                <h1 className="text-2xl font-bold text-white tracking-tight">Email Integration</h1>
                <p className="text-white/60 text-sm mt-1">
                  Connect accounts · preview before saving · past dates filtered · no duplicates
                </p>
              </div>
              <div className="flex gap-2 flex-wrap items-center">
                {connections.length > 0 && (
                  <>
                    <button onClick={handleClearAll} disabled={clearing}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95"
                      style={{ backgroundColor: "rgba(255,255,255,0.12)", borderColor: "rgba(255,255,255,0.22)", color: "#ffffff" }}>
                      {clearing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eraser className="w-3.5 h-3.5" />} Reset Cache
                    </button>
                    <button onClick={handleScanAll} disabled={scanning}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold border transition-all active:scale-95"
                      style={{ backgroundColor: "rgba(255,255,255,0.15)", borderColor: "rgba(255,255,255,0.25)", color: "#ffffff" }}>
                      {scanning ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Scanning…</> : <><RefreshCw className="w-3.5 h-3.5" />Scan All</>}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </motion.div>

        {/* ══ STAT CARDS ══ */}
        <motion.div className="grid grid-cols-2 md:grid-cols-4 gap-3" variants={itemVariants}>
          <StatCard icon={Mail}     label="Connected"  value={connections.length}              unit="accounts"     color={COLORS.deepBlue}     trend={connections.length > 0 ? "IMAP active" : "Add an account"} />
          <StatCard icon={Eye}      label="In Preview" value={extractedEvents.length}          unit="events found" color={COLORS.purple}       trend={`${futureEventCount} future · ready to save`} />
          <StatCard icon={Filter}   label="Whitelist"  value={0}                               unit="senders"      color={COLORS.emeraldGreen} trend="Manage in Whitelist tab" />
          <StatCard icon={Shield}   label="Blacklist"  value={0}                               unit="blocked"      color={COLORS.red}          trend="Manage in Blacklist tab" />
        </motion.div>

        {/* ══ TAB BAR ══ */}
        <motion.div variants={itemVariants}>
          <div className="flex items-center gap-1 p-1 rounded-2xl border overflow-x-auto scrollbar-none"
            style={{ backgroundColor: isDark ? D.card : "#ffffff", borderColor: isDark ? D.border : "#e2e8f0" }}>
            {TAB_CONFIG.map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className="flex-1 min-w-fit whitespace-nowrap flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-sm font-semibold transition-all"
                style={activeTab === tab.id
                  ? { background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})`, color: "#ffffff", boxShadow: "0 4px 14px rgba(13,59,102,0.25)" }
                  : { color: isDark ? D.muted : "#64748b" }}>
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>
        </motion.div>

        {/* ══ ACCOUNTS TAB ══ */}
        {activeTab === "accounts" && (
          <div className="space-y-4">
            <motion.div variants={itemVariants}>
              <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
                style={{ backgroundColor: isDark ? "rgba(59,130,246,0.08)" : "#eff6ff", borderColor: isDark ? "#1d4ed8" : "#bfdbfe" }}>
                <Info className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
                <div className="text-xs" style={{ color: isDark ? "#93c5fd" : "#1e40af" }}>
                  <span className="font-bold">Preview-first workflow. </span>
                  After scanning, events appear in a <strong>preview panel</strong> where you choose which to save.
                  Only <strong>future-dated</strong> events are selectable. Past-dated and already-saved items are automatically filtered.
                  Each account's Sync button only fetches emails received <strong>after its last sync date</strong>.

                </div>
              </div>
            </motion.div>

            {loading ? (
              <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-blue-500" /></div>
            ) : connections.length === 0 && !showAddOptions && !activeForm ? (
              <motion.div variants={itemVariants}>
                <SectionCard>
                  <div className="py-14 text-center space-y-4">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto"
                      style={{ backgroundColor: isDark ? D.raised : "#f1f5f9" }}>
                      <Mail className="w-8 h-8" style={{ color: isDark ? D.muted : "#94a3b8" }} />
                    </div>
                    <div>
                      <p className="font-semibold" style={{ color: isDark ? D.text : "#374151" }}>No email accounts connected yet</p>
                      <p className="text-sm mt-1" style={{ color: isDark ? D.muted : "#94a3b8" }}>Connect Gmail, Outlook, Yahoo or any IMAP email</p>
                    </div>
                    <button onClick={() => setShowAddOptions(true)}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white active:scale-95 transition-all"
                      style={{ background: `linear-gradient(135deg, ${COLORS.deepBlue}, ${COLORS.mediumBlue})` }}>
                      <Plus className="w-4 h-4" /> Connect Your First Account
                    </button>
                  </div>
                </SectionCard>
              </motion.div>
            ) : (
              <AnimatePresence>
                {connections.map(conn => (
                  <ConnectedAccountCard key={conn.email_address} conn={conn} isDark={isDark}
                    onDisconnect={handleDisconnect} onTest={handleTest} onToggle={handleToggle}
                    onSync={handleSync} onSyncRetro={handleSyncRetro} onUpdateSettings={handleUpdateSettings}
                    currentUser={user} />
                ))}
              </AnimatePresence>
            )}

            {connections.length > 0 && !showAddOptions && !activeForm && (
              <motion.div variants={itemVariants}>
                <button onClick={() => { setShowAddOptions(true); setActiveForm(null); }}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl border-2 border-dashed text-sm font-semibold transition-all"
                  style={{ borderColor: isDark ? D.border : "#e2e8f0", color: isDark ? D.muted : "#64748b" }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = COLORS.mediumBlue; e.currentTarget.style.color = COLORS.mediumBlue; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = isDark ? D.border : "#e2e8f0"; e.currentTarget.style.color = isDark ? D.muted : "#64748b"; }}>
                  <Plus className="w-4 h-4" /> Add Another Account
                </button>
              </motion.div>
            )}

            <AnimatePresence>
              {(showAddOptions || connections.length === 0) && !activeForm && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <SectionCard>
                    <CardHeaderRow
                      iconBg={isDark ? "bg-blue-900/40" : "bg-blue-50"}
                      icon={<Mail className="w-4 h-4 text-blue-500" />}
                      title={connections.length === 0 ? "Choose your email provider" : "Add another account"}
                      subtitle="Select the provider that matches your email"
                      action={showAddOptions && connections.length > 0 && (
                        <button onClick={() => setShowAddOptions(false)}
                          className="w-7 h-7 flex items-center justify-center rounded-xl transition-all"
                          style={{ color: isDark ? D.muted : "#94a3b8" }}>
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    />
                    <div className="p-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-5">
                      {QUICK_PROVIDERS.map(prov => (
                        <button key={prov.id} onClick={() => { setActiveForm(prov.id); setShowAddOptions(false); }}
                          className="relative flex flex-col items-center gap-2.5 p-4 rounded-xl border-2 border-transparent transition-all active:scale-95"
                          style={{ backgroundColor: isDark ? prov.color + "15" : prov.color + "08" }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = prov.color + "60"}
                          onMouseLeave={e => e.currentTarget.style.borderColor = "transparent"}>
                          {prov.id === "gmail" && (
                            <span className="absolute top-2 right-2 text-[9px] font-black px-1.5 py-0.5 rounded-full"
                              style={{ backgroundColor: isDark ? "rgba(31,175,90,0.18)" : "#dcfce7", color: COLORS.emeraldGreen }}>
                              OAuth
                            </span>
                          )}
                          <div className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-black text-white"
                            style={{ backgroundColor: prov.color }}>{prov.icon}</div>
                          <span className="text-xs font-semibold text-center leading-tight"
                            style={{ color: isDark ? D.text : "#374151" }}>{prov.label}</span>
                        </button>
                      ))}
                    </div>
                  </SectionCard>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {activeForm && activeProvider && (
                <ConnectForm key={activeForm} provider={activeProvider} isDark={isDark}
                  onSuccess={handleConnectSuccess}
                  onCancel={() => { setActiveForm(null); if (connections.length === 0) setShowAddOptions(true); }} />
              )}
            </AnimatePresence>

            {/* ══ SCAN PREVIEW PANEL — shown after any Sync / Scan All ══ */}
            <AnimatePresence>
              {extractedEvents.length > 0 && (
                <ScanPreviewPanel
                  events={extractedEvents}
                  savedKeys={savedKeys}
                  onSaved={handleEventsSaved}
                  onDismiss={() => setExtractedEvents([])}
                  isDark={isDark}
                />
              )}
            </AnimatePresence>
          </div>
        )}

        {/* ══ WHITELIST TAB ══ */}
        {activeTab === "whitelist" && (
          <motion.div variants={itemVariants} className="space-y-4">
            {/* Smart filter info */}
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark ? "rgba(16,185,129,0.08)" : "#f0fdf4", borderColor: isDark ? "#065f46" : "#bbf7d0" }}>
              <Info className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: COLORS.emeraldGreen }} />
              <div className="text-xs" style={{ color: isDark ? "#6ee7b7" : "#065f46" }}>
                <p className="font-bold mb-0.5">Smart Noise Filter — Always Active</p>
                <p>OTPs, bank alerts, payment notifications, promotional offers, order confirmations, and newsletter digests are <strong>automatically blocked</strong> before they reach the Action Centre — no setup needed.</p>
              </div>
            </div>
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark ? "rgba(245,158,11,0.08)" : "#fffbeb", borderColor: isDark ? "#92400e" : "#fde68a" }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: COLORS.amber }} />
              <div className="text-xs" style={{ color: isDark ? "#fbbf24" : "#92400e" }}>
                <p className="font-bold mb-0.5">What is the Sender Whitelist?</p>
                <p>By default, all emails from all senders are scanned. Once you add any sender here, <strong>ONLY emails from those approved senders</strong> will be processed.</p>
                <p className="mt-1.5 font-semibold">Recommended for CA/CS firms: add IP India, GST Portal, Income Tax, MCA, and your client domains.</p>
              </div>
            </div>
            <SenderWhitelistManager isDark={isDark} />
          </motion.div>
        )}

        {/* ══ BLACKLIST TAB ══ */}
        {activeTab === "blacklist" && (
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark ? "rgba(239,68,68,0.08)" : "#fef2f2", borderColor: isDark ? "#7f1d1d" : "#fecaca" }}>
              <Shield className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: COLORS.red }} />
              <div className="text-xs" style={{ color: isDark ? "#fca5a5" : "#7f1d1d" }}>
                <p className="font-bold mb-0.5">Block noisy senders</p>
                <p>Emails from blacklisted addresses or domains are <strong>dropped before extraction</strong> — even if they contain dates. Use this for promotional senders, automated alerts, or specific email addresses you never want scanned.</p>
                <p className="mt-1.5 font-semibold">Tip: prefix with <code>@</code> to block an entire domain (e.g. <code>@promotions.com</code>).</p>
              </div>
            </div>
            <SenderBlacklistManager isDark={isDark} />
          </motion.div>
        )}

        {/* ══ SMART RULES TAB ══ */}
        {activeTab === "rules" && (
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark ? D.raised : "#f8fafc", borderColor: isDark ? D.border : "#e2e8f0" }}>
              <Info className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs" style={{ color: isDark ? D.muted : "#64748b" }}>
                <p className="font-bold mb-0.5" style={{ color: isDark ? D.text : "#374151" }}>How Smart Categorization Works</p>
                <p>When an email is scanned, Taskosphere uses AI + keyword rules to decide the category. A preview panel is shown before saving — you can override the category and select/deselect freely.</p>
              </div>
            </div>
            <CategoryRulesPanel isDark={isDark} />

          </motion.div>
        )}

        {/* ══ COMPOSE TAB ══ */}
        {activeTab === "compose" && (
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark?"rgba(79,70,229,0.08)":"#eef2ff", borderColor: isDark?"#4338ca":"#c7d2fe" }}>
              <Send className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
              <div className="text-xs" style={{ color: isDark?"#a5b4fc":"#3730a3" }}>
                <span className="font-bold">Send personalised emails directly to your clients.</span>
                {" "}Pick a company for branding (logo, SMTP/Gmail), compose with {'{variable}'} tokens, select recipients, and send.
                Use <strong>Compose &amp; Send</strong> tab for one-off emails, <strong>Templates</strong> tab to save reusable formats.
              </div>
            </div>
            <EmailComposePanel isDark={isDark} />
          </motion.div>
        )}

        {/* ══ TEMPLATES TAB ══ */}
        {activeTab === "templates" && (
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark?"rgba(16,185,129,0.08)":"#f0fdf4", borderColor: isDark?"#065f46":"#a7f3d0" }}>
              <FileText className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
              <div className="text-xs" style={{ color: isDark?"#6ee7b7":"#064e3b" }}>
                <span className="font-bold">Reusable email templates.</span>
                {" "}Create templates with {'{name}'}, {'{services}'}, {'{gstin}'} and other tokens — then load any template in the Compose tab to send instantly.
              </div>
            </div>
            <EmailTemplatesPanel isDark={isDark} />
          </motion.div>
        )}

        {/* ══ ORGANISATION EMAIL TAB ══ */}
        {activeTab === "organisation" && (
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark ? "rgba(59,130,246,0.08)" : "#eff6ff", borderColor: isDark ? "#1d4ed8" : "#bfdbfe" }}>
              <Send className="w-4 h-4 text-blue-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs" style={{ color: isDark ? "#93c5fd" : "#1e40af" }}>
                <span className="font-bold">The mailbox every module sends from.</span>
                {" "}Invoices, quotations, reminders, compliance emails, client portal codes and EngageX all send from it. The Accounts tab above is for reading inboxes.
              </div>
            </div>
            <OrganisationEmail isDark={isDark} returnPath="/settings/email?tab=organisation" />
            {isPlatformOwner && (
              <div className="space-y-2 pt-2">
                <p className="text-xs font-bold" style={{ color: isDark ? "#cbd5e1" : "#334155" }}>Platform fallback sender (Brevo) — Platform Owner only</p>
                <p className="text-[11px]" style={{ color: isDark ? "#94a3b8" : "#64748b" }}>Used only when an organisation has not connected a mailbox. Both addresses must be verified in Brevo.</p>
                <SenderSelectorPanel isDark={isDark} />
              </div>
            )}
          </motion.div>
        )}

        {/* ══ SETTINGS TAB ══ */}
        {activeTab === "settings" && (
          <motion.div variants={itemVariants} className="space-y-4">
            <div className="px-4 py-3.5 rounded-2xl border flex items-start gap-3"
              style={{ backgroundColor: isDark ? "rgba(13,59,102,0.18)" : "#eff6ff", borderColor: isDark ? "#1d4ed8" : "#bfdbfe" }}>
              <Settings2 className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: COLORS.mediumBlue }} />
              <div className="text-xs" style={{ color: isDark ? "#93c5fd" : "#1e40af" }}>
                <p className="font-bold mb-0.5">Customise every aspect of email scanning</p>
                <p>Tune scan windows, sync intervals, default categories, filtering rules, preview behaviour and notifications. Settings are saved instantly and apply to all future scans.</p>
              </div>
            </div>
            <EmailScanSettings isDark={isDark} />
          </motion.div>
        )}


        {/* ══ TIPS ══ */}
        <motion.div variants={itemVariants}>
          <SectionCard>
            <CardHeaderRow
              iconBg={isDark ? "bg-slate-700" : "bg-slate-100"}
              icon={<Info className="w-4 h-4 text-slate-400" />}
              title="Tips & Troubleshooting"
              subtitle="Common setup issues and fixes"
            />
            <div className="p-4">
              <ul className="space-y-2">
                {[
                  "Gmail requires: (1) IMAP enabled, (2) 2-Step Verification ON, (3) App Password generated — all 3 are mandatory",
                  "Scan & Sync results show a preview panel first — select which events to save; nothing is written until you click 'Save Selected'",
                  "Past-dated events are automatically greyed out and unchecked — they cannot be saved to prevent stale data",
                  "Each account's Sync button fetches only emails received after its last sync date — prevents rescanning old emails",
                  "Within a session, already-saved events show an 'Already Saved' badge and cannot be re-saved; duplicates are blocked",
                  "Add @ipindia.gov.in to whitelist to auto-import all trademark hearings and notices without filtering",
                  "Use 'Reset Cache' if you see wrong or stale results, then 'Scan All' for a completely fresh extraction",
                  "Visit the Action Center page to see all linked email due dates and events in one place",
                ].map((tip, i) => (
                  <li key={i} className="flex items-start gap-2.5 text-xs" style={{ color: isDark ? D.muted : "#64748b" }}>
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-0.5" />
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          </SectionCard>
        </motion.div>

      </motion.div>
    </TooltipProvider>
  );
}
