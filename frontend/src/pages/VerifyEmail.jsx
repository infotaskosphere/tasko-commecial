import React, { useState, useEffect } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { CheckCircle2, AlertTriangle, RefreshCw, Mail, ArrowRight, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import api from "@/lib/api";

export default function VerifyEmail() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token") || searchParams.get("t");
  const emailParam = searchParams.get("email") || "";

  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState(null);

  // Resend state
  const [resendEmail, setResendEmail] = useState(emailParam);
  const [resending, setResending] = useState(false);
  const [resendDone, setResendDone] = useState(false);

  useEffect(() => {
    if (token) {
      handleVerify(token);
    }
  }, [token]);

  async function handleVerify(tokenVal) {
    setVerifying(true);
    setError(null);
    try {
      const res = await api.post("/auth/verify-email", { token: tokenVal });
      setVerified(true);
      toast.success(res.data?.message || "Email verified successfully!");
    } catch (err) {
      setError(err.response?.data?.detail || "Invalid, expired, or already-used verification link.");
    } finally {
      setVerifying(false);
    }
  }

  async function handleResend(e) {
    e.preventDefault();
    if (!resendEmail || !resendEmail.includes("@")) {
      toast.error("Please enter a valid email address.");
      return;
    }
    setResending(true);
    try {
      const res = await api.post("/auth/send-verification", { email: resendEmail.trim() });
      setResendDone(true);
      toast.success(res.data?.message || "Verification email dispatched!");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Unable to send verification link. Please try again later.");
    } finally {
      setResending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6f9fc] p-4 text-slate-900">
      <div className="w-full max-w-md bg-white border border-slate-200/90 rounded-2xl shadow-xl overflow-hidden p-8 space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-blue-50 text-[#102f62] flex items-center justify-center mb-3">
            <Mail size={24} />
          </div>
          <h2 className="text-2xl font-black text-[#102f62] tracking-tight">Email Verification</h2>
          <p className="text-xs text-slate-500">
            Confirm your account email identity for platform security and workspace protection.
          </p>
        </div>

        {verifying && (
          <div className="py-8 text-center space-y-3">
            <RefreshCw className="w-8 h-8 text-[#102f62] animate-spin mx-auto" />
            <p className="text-xs font-semibold text-slate-600">Validating your verification token...</p>
          </div>
        )}

        {verified && (
          <div className="space-y-4 text-center">
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 space-y-2">
              <CheckCircle2 size={32} className="text-emerald-600 mx-auto" />
              <div className="text-sm font-bold">Email Verified Successfully!</div>
              <p className="text-slate-600 text-[11px] leading-relaxed">
                Your email address has been verified and registered. Your account now has full access to the workspace.
              </p>
            </div>
            <Link
              to="/login"
              className="w-full h-11 bg-[#102f62] hover:bg-[#0b2855] text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 shadow-sm"
            >
              Continue to Sign In <ArrowRight size={15} />
            </Link>
          </div>
        )}

        {!verifying && !verified && error && (
          <div className="space-y-4">
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-900 flex items-start gap-2.5">
              <AlertTriangle size={18} className="text-rose-600 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <div className="font-bold">Verification Link Expired or Invalid</div>
                <p className="text-[11px] text-rose-700 leading-relaxed">{error}</p>
              </div>
            </div>

            <div className="border border-slate-200 rounded-xl p-4 bg-slate-50 space-y-3">
              <span className="text-xs font-bold text-slate-800 block">Resend Verification Email</span>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                Enter your registered email address and we'll dispatch a fresh single-use verification link.
              </p>

              {resendDone ? (
                <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-[11px] text-emerald-800 flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-emerald-600" />
                  <span>A fresh verification link has been sent to your inbox.</span>
                </div>
              ) : (
                <form onSubmit={handleResend} className="space-y-3">
                  <input
                    type="email"
                    value={resendEmail}
                    onChange={(e) => setResendEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full h-10 px-3 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-[#102f62]"
                    required
                  />
                  <button
                    type="submit"
                    disabled={resending}
                    className="w-full h-9 bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold rounded-lg transition flex items-center justify-center gap-1.5 disabled:opacity-50"
                  >
                    {resending ? <RefreshCw size={13} className="animate-spin" /> : <Mail size={13} />}
                    Resend Verification Link
                  </button>
                </form>
              )}
            </div>

            <div className="text-center pt-2">
              <Link to="/login" className="text-xs font-bold text-[#102f62] hover:underline">
                Return to Sign In
              </Link>
            </div>
          </div>
        )}

        {!token && !verifying && !verified && !error && (
          <div className="space-y-4">
            <p className="text-xs text-slate-600 leading-relaxed">
              If you did not receive your verification email or need a new one, please enter your email below:
            </p>
            {resendDone ? (
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-xs text-emerald-800 flex items-center gap-2">
                <CheckCircle2 size={14} className="text-emerald-600" />
                <span>Verification email sent! Check your inbox and spam folders.</span>
              </div>
            ) : (
              <form onSubmit={handleResend} className="space-y-3">
                <input
                  type="email"
                  value={resendEmail}
                  onChange={(e) => setResendEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full h-10 px-3 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:border-[#102f62]"
                  required
                />
                <button
                  type="submit"
                  disabled={resending}
                  className="w-full h-10 bg-[#102f62] hover:bg-[#0b2855] text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 disabled:opacity-50 shadow-sm"
                >
                  {resending ? <RefreshCw size={14} className="animate-spin" /> : <Mail size={14} />}
                  Send Verification Email
                </button>
              </form>
            )}
            <div className="text-center pt-2">
              <Link to="/login" className="text-xs font-bold text-slate-500 hover:text-slate-800">
                Back to Sign In
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
