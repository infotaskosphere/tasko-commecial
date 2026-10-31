// frontend/src/components/PortalSyncModal.jsx
// ---------------------------------------------------------------------------
// REPLACES (or sits next to) AgentPortalSyncModal.jsx.
//
// Two tabs:
//   1. "Trademark Register"   – estatus portal: Email + Captcha -> OTP -> list
//   2. "Agent Login"          – efiling portal: User ID + Password + Captcha
//
// Both flows display the live captcha image fetched from the backend
// (data: URL returned by /api/trademark-sphere/portals/*/captcha) and POST
// the user's answer back. On success we collect the application numbers and
// hand them to /api/trademark-sphere/portals/import which reuses the existing
// per-TM scraper to populate trademark_sphere collection.
//
// Drop-in for TrademarkSphere.jsx:
//   import PortalSyncModal from '@/components/PortalSyncModal';
//   ...
//   <AnimatePresence>
//     {showPortalSync && (
//       <PortalSyncModal
//         onClose={() => setShowPortalSync(false)}
//         onDone={() => { setShowPortalSync(false); fetchTrademarks(); }}
//         isDark={isDark}
//       />
//     )}
//   </AnimatePresence>
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useCallback } from 'react';
import { motion } from 'framer-motion';
import {
  X, Mail, Key, User, RefreshCw, CheckCircle2,
  Loader2, Shield, ShieldCheck, KeyRound, AtSign, Image as ImageIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import api from '@/lib/api';

const cn = (...c) => c.filter(Boolean).join(' ');

const TABS = [
  { id: 'register', label: 'Trademark Register', sub: 'Email + Captcha + OTP', icon: AtSign },
  { id: 'agent',    label: 'Agent Login',        sub: 'User-ID + Password + Captcha', icon: KeyRound },
];

export default function PortalSyncModal({ onClose, onDone, isDark }) {
  const [tab, setTab] = useState('register');

  return (
    <motion.div
      className="fixed inset-0 z-[1100] flex items-center justify-center p-4"
      style={{ background: 'rgba(5, 10, 25, 0.80)', backdropFilter: 'blur(12px)' }}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, y: 30, opacity: 0 }}
        animate={{ scale: 1, y: 0, opacity: 1 }}
        exit={{ scale: 0.92, y: 30, opacity: 0 }}
        transition={{ type: 'spring', stiffness: 230, damping: 22 }}
        onClick={e => e.stopPropagation()}
        className={cn(
          'w-full max-w-lg rounded-3xl overflow-hidden shadow-2xl',
          isDark ? 'bg-slate-900 border border-slate-700/80' : 'bg-white border border-slate-200'
        )}
      >
        {/* Header */}
        <div className="px-6 py-5 relative overflow-hidden"
             style={{ background: 'linear-gradient(135deg, #0D3B66, #1F6FB2)' }}>
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-white/15 flex items-center justify-center">
                <Shield className="w-5 h-5 text-white" />
              </div>
              <div>
                <p className="text-white/55 text-[10px] font-bold uppercase tracking-widest">IP India Portals</p>
                <h2 className="text-[17px] font-bold text-white leading-tight">Sync trademarks</h2>
              </div>
            </div>
            <button onClick={onClose}
                    className="w-8 h-8 rounded-xl bg-white/15 hover:bg-white/25 flex items-center justify-center">
              <X className="w-4 h-4 text-white" />
            </button>
          </div>

          {/* Tabs */}
          <div className="relative mt-5 flex gap-2">
            {TABS.map(t => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  className={cn(
                    'flex-1 px-3 py-2 rounded-xl text-left transition-all border',
                    active ? 'bg-white text-violet-700 border-white shadow-lg'
                           : 'bg-white/10 text-white/80 border-white/15 hover:bg-white/20'
                  )}>
                  <div className="flex items-center gap-2 text-xs font-bold">
                    <Icon className="w-3.5 h-3.5" /> {t.label}
                  </div>
                  <div className={cn('text-[10px] mt-0.5', active ? 'text-violet-500' : 'text-white/60')}>{t.sub}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className={cn('p-6', isDark ? 'bg-slate-900 text-slate-100' : 'bg-white text-slate-800')}>
          {tab === 'register'
            ? <RegisterFlow onDone={onDone} isDark={isDark} />
            : <AgentFlow    onDone={onDone} isDark={isDark} />}
        </div>
      </motion.div>
    </motion.div>
  );
}


/* ───────────────────────── shared bits ───────────────────────── */

function CaptchaBox({ image, onReload, loading, isDark }) {
  return (
    <div className={cn(
      'flex items-center gap-3 p-3 rounded-xl border',
      isDark ? 'bg-slate-800 border-slate-700' : 'bg-slate-50 border-slate-200'
    )}>
      <div className="w-32 h-12 rounded-md bg-white flex items-center justify-center overflow-hidden border">
        {image
          ? <img src={image} alt="captcha" className="w-full h-full object-contain" />
          : <ImageIcon className="w-5 h-5 text-slate-400" />}
      </div>
      <button type="button" onClick={onReload} disabled={loading}
              className="flex items-center gap-1 px-3 py-2 text-xs font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50">
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
        Reload
      </button>
    </div>
  );
}

function Field({ label, icon: Icon, ...rest }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">{label}</span>
      <div className="relative">
        {Icon && <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />}
        <input
          {...rest}
          className={cn(
            'w-full py-2.5 rounded-xl border text-sm outline-none transition-all focus:ring-2',
            Icon ? 'pl-9 pr-3' : 'px-3',
            'bg-slate-50 border-slate-200 focus:border-violet-400 focus:ring-violet-100',
            'dark:bg-slate-800 dark:border-slate-600 dark:text-slate-100 dark:focus:border-violet-500',
          )}
        />
      </div>
    </label>
  );
}


/* ─────────────────────── Estatus flow ─────────────────────── */

function RegisterFlow({ onDone, isDark }) {
  const [stage, setStage]       = useState('email');   // email | otp | importing
  const [sessionId, setSession] = useState(null);
  const [captcha, setCaptchaImg]= useState(null);
  const [loading, setLoading]   = useState(false);
  const [form, setForm]         = useState({ email: '', captcha: '', otp: '' });
  const [numbers, setNumbers]   = useState([]);

  const loadCaptcha = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/trademark-sphere/portals/estatus/captcha');
      setSession(data.session_id);
      setCaptchaImg(data.captcha_image);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load captcha');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCaptcha(); }, [loadCaptcha]);

  const sendOtp = async () => {
    if (!form.email || !form.captcha) return toast.error('Enter email and captcha');
    setLoading(true);
    try {
      await api.post('/trademark-sphere/portals/estatus/send-otp', {
        session_id: sessionId, email: form.email.trim(), captcha: form.captcha.trim(),
      });
      toast.success('OTP sent to your email');
      setStage('otp');
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Send OTP failed');
      loadCaptcha();
    } finally { setLoading(false); }
  };

  const verify = async () => {
    if (!form.otp) return toast.error('Enter the OTP');
    setLoading(true);
    try {
      const { data } = await api.post('/trademark-sphere/portals/estatus/verify-otp', {
        session_id: sessionId, otp: form.otp.trim(),
      });
      setNumbers(data.application_numbers || []);
      toast.success(`Found ${data.application_numbers?.length || 0} trademark(s)`);
      await importAll(data.application_numbers || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'OTP verification failed');
    } finally { setLoading(false); }
  };

  const importAll = async (nums) => {
    if (!nums.length) return;
    setStage('importing');
    try {
      const { data } = await api.post('/trademark-sphere/portals/import', { application_numbers: nums });
      toast.success(`Imported ${data.added} new trademarks (${data.skipped} already tracked)`);
      onDone?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Import failed');
    }
  };

  return (
    <div className="space-y-4">
      <p className={cn('text-xs leading-relaxed p-3 rounded-xl',
                       isDark ? 'bg-slate-800/60 text-slate-400' : 'bg-violet-50 text-violet-800')}>
        Login at <strong>tmrsearch.ipindia.gov.in/estatus</strong> using your registered email.
        An OTP will be sent to your inbox — exactly like the IP India portal.
      </p>

      {stage === 'email' && (
        <>
          <Field label="IP India Registered Email" icon={Mail} type="email" placeholder="you@example.com"
                 value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          <CaptchaBox image={captcha} onReload={loadCaptcha} loading={loading} isDark={isDark} />
          <Field label="Enter captcha shown above" icon={Shield} placeholder="captcha text"
                 value={form.captcha} onChange={e => setForm({ ...form, captcha: e.target.value })} />
          <button onClick={sendOtp} disabled={loading}
                  className="w-full py-3 rounded-xl bg-violet-600 hover:bg-violet-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            Send OTP to Email
          </button>
        </>
      )}

      {stage === 'otp' && (
        <>
          <Field label="OTP from your email" icon={ShieldCheck} placeholder="6-digit code" inputMode="numeric"
                 value={form.otp} onChange={e => setForm({ ...form, otp: e.target.value })} />
          <button onClick={verify} disabled={loading}
                  className="w-full py-3 rounded-xl bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            Verify &amp; Fetch Trademarks
          </button>
        </>
      )}

      {stage === 'importing' && (
        <div className="text-center py-6">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-violet-500" />
          <p className="mt-3 text-sm font-semibold">Importing {numbers.length} trademark(s)…</p>
        </div>
      )}
    </div>
  );
}


/* ─────────────────────── Agent eFiling flow ─────────────────────── */

function AgentFlow({ onDone, isDark }) {
  const [sessionId, setSession] = useState(null);
  const [captcha, setCaptchaImg]= useState(null);
  const [loading, setLoading]   = useState(false);
  const [stage, setStage]       = useState('login');  // login | importing
  const [form, setForm]         = useState({ user_id: '', password: '', captcha: '' });

  const loadCaptcha = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.post('/trademark-sphere/portals/agent/captcha');
      setSession(data.session_id);
      setCaptchaImg(data.captcha_image);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Could not load captcha');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCaptcha(); }, [loadCaptcha]);

  const login = async () => {
    if (!form.user_id || !form.password || !form.captcha)
      return toast.error('Enter user-id, password and captcha');
    setLoading(true);
    try {
      const { data } = await api.post('/trademark-sphere/portals/agent/login', {
        session_id: sessionId,
        user_id:    form.user_id.trim(),
        password:   form.password,
        captcha:    form.captcha.trim(),
      });
      const totalFound = data.application_numbers?.length || 0;
      toast.success(`Logged in — found ${totalFound} TM application(s)`);
      setStage('importing');
      // Pass full_details (pre-fetched from IP India portal) to avoid double-scraping
      const r = await api.post('/trademark-sphere/portals/import', {
        application_numbers: data.application_numbers || [],
        full_details:        data.full_details        || [],
      });
      const msg = `Imported ${r.data.added} new trademark(s)` +
                  (r.data.skipped ? ` (${r.data.skipped} already tracked)` : '') +
                  (r.data.failed  ? ` — ${r.data.failed} could not be fetched` : '');
      toast.success(msg);
      onDone?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Login failed');
      loadCaptcha();
      setStage('login');
    } finally { setLoading(false); }
  };

  return (
    <div className="space-y-4">
      <p className={cn('text-xs leading-relaxed p-3 rounded-xl',
                       isDark ? 'bg-slate-800/60 text-slate-400' : 'bg-blue-50 text-blue-800')}>
        Login at <strong>ipindiaonline.gov.in/trademarkefiling</strong> with your agent user-id and password.
        We will fetch the list of TM application numbers visible on your dashboard.
      </p>

      {stage === 'login' && (
        <>
          <Field label="User ID" icon={User} placeholder="agent user id"
                 value={form.user_id} onChange={e => setForm({ ...form, user_id: e.target.value })} />
          <Field label="Password" icon={Key} type="password" placeholder="••••••••"
                 value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} />
          <CaptchaBox image={captcha} onReload={loadCaptcha} loading={loading} isDark={isDark} />
          <Field label="Captcha" icon={Shield} placeholder="text in image above"
                 value={form.captcha} onChange={e => setForm({ ...form, captcha: e.target.value })} />
          <button onClick={login} disabled={loading}
                  className="w-full py-3 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-bold flex items-center justify-center gap-2">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <KeyRound className="w-4 h-4" />}
            Login &amp; Fetch TM Numbers
          </button>
        </>
      )}

      {stage === 'importing' && (
        <div className="text-center py-6 space-y-3">
          <Loader2 className="w-10 h-10 animate-spin mx-auto text-blue-500" />
          <p className="text-sm font-semibold text-slate-700 dark:text-slate-200">
            Logging in &amp; fetching trademark details…
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Auto-browsing IP India portal. This may take 30–60 seconds.
          </p>
        </div>
      )}
    </div>
  );
}
