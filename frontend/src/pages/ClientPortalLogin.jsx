import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { BASE_URL, BACKEND_BASE_URL } from "@/lib/api";

const API_BASE = BASE_URL;
const API = axios.create({ baseURL: API_BASE });

// Bare backend root (no /api) — used only for the wake-up health ping
const BACKEND_URL = BACKEND_BASE_URL;

function extractErrorMessage(err, fallback) {
  const detail = err?.response?.data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d.msg || JSON.stringify(d)).join(" | ");
  if (detail) return JSON.stringify(detail);
  if (!err?.response) return "Server is starting up — please wait ~30 seconds and try again.";
  if (err?.response?.status === 503) return "Server is temporarily unavailable. Please wait ~30 seconds and try again.";
  return fallback;
}

// ── Forgot Password panel ─────────────────────────────────────────────────
// Two steps: (1) enter username/email → request a 6-digit code by email,
// (2) enter the code + a new password → account is updated. Falls back to
// the login screen on success.
function ForgotPasswordPanel({ initialUsername, onBackToLogin, onResetSuccess }) {
  const [step, setStep] = useState("request"); // "request" | "verify"
  const [identifier, setIdentifier] = useState(initialUsername || "");
  const [otp, setOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const requestCode = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await API.post("/client-portal/forgot-password", { username: identifier.trim() });
      setInfo(res?.data?.message || "If that account exists, a verification code has been sent to the registered email.");
      setStep("verify");
    } catch (err) {
      setError(extractErrorMessage(err, "Could not send the verification code. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  const submitReset = async (e) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 6) {
      setError("New password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      await API.post("/client-portal/reset-password", {
        username: identifier.trim(),
        otp: otp.trim(),
        new_password: newPassword,
      });
      onResetSuccess(identifier.trim());
    } catch (err) {
      setError(extractErrorMessage(err, "Invalid or expired code. Please try again."));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-xl p-8">
      <h2 className="text-lg font-bold text-gray-900 mb-1">
        {step === "request" ? "Forgot Password" : "Enter Verification Code"}
      </h2>
      <p className="text-sm text-gray-500 mb-5">
        {step === "request"
          ? "Enter your portal username or email — we'll send a 6-digit code to the email linked to your account."
          : `We've sent a 6-digit code to the email linked to "${identifier}". Enter it below along with your new password.`}
      </p>

      {step === "request" ? (
        <form onSubmit={requestCode} className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Username or Email</label>
            <input
              type="text"
              required
              autoFocus
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter your username or email"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1F6FB2] focus:border-transparent transition"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !identifier.trim()}
            className="w-full bg-[#0D3B66] hover:bg-[#0a2e50] disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition text-sm shadow-sm"
          >
            {loading ? "Sending code…" : "Send Verification Code"}
          </button>

          <button
            type="button"
            onClick={onBackToLogin}
            className="w-full text-center text-sm text-[#1F6FB2] hover:text-[#0D3B66] font-medium"
          >
            ← Back to Sign In
          </button>
        </form>
      ) : (
        <form onSubmit={submitReset} className="space-y-5">
          {info && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg px-4 py-3">
              {info}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">6-Digit Code</label>
            <input
              type="text"
              required
              autoFocus
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm tracking-[0.3em] text-center font-semibold focus:outline-none focus:ring-2 focus:ring-[#1F6FB2] focus:border-transparent transition"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">New Password</label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1F6FB2] focus:border-transparent transition"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Confirm New Password</label>
            <input
              type="password"
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
              className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1F6FB2] focus:border-transparent transition"
            />
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || otp.length !== 6}
            className="w-full bg-[#0D3B66] hover:bg-[#0a2e50] disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition text-sm shadow-sm"
          >
            {loading ? "Updating password…" : "Reset Password"}
          </button>

          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              onClick={() => { setStep("request"); setError(""); setOtp(""); }}
              className="text-[#1F6FB2] hover:text-[#0D3B66] font-medium"
            >
              ← Use a different code
            </button>
            <button
              type="button"
              onClick={onBackToLogin}
              className="text-gray-400 hover:text-gray-600 font-medium"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function ClientPortalLogin() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: "", password: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [serverWaking, setServerWaking] = useState(false);
  const [view, setView] = useState("login"); // "login" | "forgot"
  const [successNotice, setSuccessNotice] = useState("");

  // ── Branding (custom logo / portal name set by the admin in Client
  // Portal Setting) — falls back to the default Taskosphere mark if none
  // has been uploaded. No-auth endpoint, safe to call before login.
  // `brandingLoaded` gates rendering of the logo so we never flash the
  // default Taskosphere mark before the client's own logo arrives.
  const [branding, setBranding] = useState({ portal_name: "Client Portal", logo_url: null });
  const [brandingLoaded, setBrandingLoaded] = useState(false);
  const [portalStatus, setPortalStatus] = useState(null);

  const refreshPortalStatus = async () => {
    try {
      const res = await API.get("/client-portal/public-settings", {
        params: { _ts: Date.now() },
      });
      const data = res?.data || {};
      const nextStatus = String(data.portal_status || "live").toLowerCase();
      setBranding((b) => ({ ...b, ...data }));
      setPortalStatus(
        ["live", "maintenance", "offline"].includes(nextStatus) ? nextStatus : "live"
      );
    } catch {
      // Keep the current known state on transient failures. On first load,
      // remain in the checking state until the next poll succeeds.
      setPortalStatus((current) => current ?? null);
    } finally {
      setBrandingLoaded(true);
    }
  };

  useEffect(() => {
    refreshPortalStatus();
    const timer = window.setInterval(refreshPortalStatus, 10000);
    return () => window.clearInterval(timer);
  }, []);

  // Retry login up to 3 times with increasing delay — handles Render cold starts
  const loginWithRetry = async (retries = 3, retryDelay = 3000) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await API.post("/client-portal/login", form);
      } catch (err) {
        // If it's a 401 / 403 (auth error) — no point retrying
        if (
          err?.response?.status === 401 ||
          err?.response?.status === 403 ||
          err?.response?.data?.detail?.code === "PORTAL_MAINTENANCE" ||
          err?.response?.data?.detail?.code === "PORTAL_OFFLINE"
        ) {
          throw err;
        }
        // Last attempt — throw so the caller handles the error
        if (i === retries - 1) throw err;
        // Wait before retrying (network error or 503 cold start)
        await new Promise((r) => setTimeout(r, retryDelay));
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    setServerWaking(false);

    // Ping the backend to help wake it up from Render's free-tier sleep
    fetch(`${BACKEND_URL}/health`).catch(() => {});

    // Show "server is waking up" hint after 3 seconds so users don't panic
    const wakingTimer = setTimeout(() => setServerWaking(true), 3000);

    try {
      const res = await loginWithRetry();

      clearTimeout(wakingTimer);
      setServerWaking(false);

      const data = res?.data;
      const access_token = data?.access_token;
      const user = data?.user;

      if (!access_token) {
        setError("Login failed: server did not return an access token. Please contact your account manager.");
        return;
      }

      sessionStorage.setItem("client_portal_token", access_token);
      sessionStorage.setItem(
        "client_portal_user",
        user && typeof user === "object" ? JSON.stringify(user) : "null"
      );
      navigate("/client-portal/dashboard");
    } catch (err) {
      clearTimeout(wakingTimer);
      setServerWaking(false);

      const detail = err?.response?.data?.detail;
      let msg = "Invalid credentials. Please try again.";
      if (typeof detail === "string") msg = detail;
      else if (Array.isArray(detail)) msg = detail.map((d) => d.msg || JSON.stringify(d)).join(" | ");
      else if (detail) msg = JSON.stringify(detail);
      else if (!err?.response) msg = "Server is starting up — please wait ~30 seconds and try again.";
      else if (err?.response?.status === 503) msg = "Server is temporarily unavailable. Please wait ~30 seconds and try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  if (portalStatus === null) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-gray-500">Checking Client Portal availability…</p>
        </div>
      </div>
    );
  }

  if (portalStatus !== "live") {
    const maintenance = portalStatus === "maintenance";
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-gray-200 p-8 text-center">
          {branding.logo_url ? (
            <img
              src={branding.logo_url}
              alt={branding.portal_name || "Client Portal"}
              className="w-16 h-16 mx-auto mb-5 rounded-xl object-contain"
            />
          ) : (
            <div className="w-16 h-16 mx-auto mb-5 rounded-xl bg-blue-600 text-white flex items-center justify-center text-2xl">
              {maintenance ? "🛠️" : "⛔"}
            </div>
          )}
          <h1 className="text-xl font-bold text-gray-900">
            {maintenance ? "Client Portal Under Maintenance" : "Client Portal Offline"}
          </h1>
          <p className="text-sm text-gray-500 mt-2 leading-6">
            {maintenance
              ? "We are performing maintenance on the Client Portal. Please try again shortly."
              : "The Client Portal is currently offline. Please try again later or contact your account manager."}
          </p>
          <button
            onClick={refreshPortalStatus}
            className="mt-6 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            Check Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center mb-4" style={{ minHeight: "64px" }}>
            {brandingLoaded && (
              <img
                src={branding.logo_url || "/logo-transparent.png"}
                alt={branding.portal_name || "TaskOsphere"}
                className="object-contain"
                // mix-blend-mode helps a logo that was exported with a white
                // (non-transparent) background blend into the page instead
                // of showing as a visible white box. For a fully clean
                // result, re-upload the logo as a transparent PNG in
                // Client Portal Setting — this is a visual fallback only.
                style={{ maxHeight: "64px", width: "auto", mixBlendMode: "multiply" }}
              />
            )}
          </div>
          <h1 className="text-2xl font-bold text-gray-900">{branding.portal_name || "Client Portal"}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {view === "login" ? "Sign in to access your documents & updates" : "Reset your portal password"}
          </p>
        </div>

        {view === "forgot" ? (
          <ForgotPasswordPanel
            initialUsername={form.username}
            onBackToLogin={() => { setView("login"); setSuccessNotice(""); }}
            onResetSuccess={(usedIdentifier) => {
              setForm((f) => ({ ...f, username: usedIdentifier, password: "" }));
              setSuccessNotice("Password updated successfully. Please sign in with your new password.");
              setView("login");
            }}
          />
        ) : (
          <div className="bg-white rounded-2xl shadow-xl p-8">
            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1.5">Username</label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={form.username}
                  onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="Enter your username"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1F6FB2] focus:border-transparent transition"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-sm font-medium text-gray-700">Password</label>
                  <button
                    type="button"
                    onClick={() => { setView("forgot"); setError(""); setSuccessNotice(""); }}
                    className="text-xs font-medium text-[#1F6FB2] hover:text-[#0D3B66]"
                  >
                    Forgot password?
                  </button>
                </div>
                <input
                  type="password"
                  required
                  value={form.password}
                  onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Enter your password"
                  className="w-full px-4 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#1F6FB2] focus:border-transparent transition"
                />
              </div>

              {successNotice && !error && (
                <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm rounded-lg px-4 py-3">
                  {successNotice}
                </div>
              )}

              {serverWaking && !error && (
                <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded-lg px-4 py-3 flex items-start gap-2">
                  <svg className="w-4 h-4 mt-0.5 shrink-0 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Server is waking up — this may take up to 30 seconds on first sign-in…</span>
                </div>
              )}

              {error && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-[#0D3B66] hover:bg-[#0a2e50] disabled:opacity-60 text-white font-semibold py-2.5 rounded-lg transition text-sm shadow-sm"
              >
                {loading ? "Signing in…" : "Sign In"}
              </button>
            </form>

            <p className="text-xs text-center text-gray-400 mt-6">
              Need access? Contact your account manager.
            </p>
          </div>
        )}

        <p className="text-center text-xs text-gray-400 mt-4 flex items-center justify-center gap-1.5">
          Powered by
          <img
            src="/logo-transparent.png"
            alt="Taskosphere"
            style={{ height: "14px", width: "auto" }}
            className="object-contain inline-block"
          />
        </p>
      </div>
    </div>
  );
}
