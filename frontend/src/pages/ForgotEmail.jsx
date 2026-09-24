import React, { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Mail, ShieldCheck, CheckCircle2, Search, Building2, Phone, KeyRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import api from "@/lib/api";

export default function ForgotEmail() {
  const [identifier, setIdentifier] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!identifier.trim()) {
      toast.error("Please enter your registered mobile, license key, or organization name.");
      return;
    }
    setLoading(true);
    setResult(null);
    try {
      const res = await api.post("/auth/forgot-email", { query: identifier.trim() });
      setResult(res.data);
      toast.success("Account lookup completed.");
    } catch (err) {
      // Return generic response to prevent account enumeration
      setResult({
        success: true,
        message: "If matching account credentials exist in the system, recovery details have been processed.",
        masked_email: null,
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#f6f9fc] p-4 text-slate-900">
      <div className="w-full max-w-md bg-white border border-slate-200/90 rounded-2xl shadow-xl overflow-hidden p-8 space-y-6">
        {/* Header */}
        <div className="space-y-2 text-center">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-blue-50 text-[#102f62] flex items-center justify-center mb-3">
            <Mail size={24} />
          </div>
          <h2 className="text-2xl font-black text-[#102f62] tracking-tight">Forgot Email ID / Username</h2>
          <p className="text-xs text-slate-500 leading-relaxed">
            Enter your registered mobile phone, license key, or organization name to securely locate your login credentials.
          </p>
        </div>

        {!result ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Account Identifier
              </label>
              <div className="relative">
                <Search size={16} className="absolute left-3.5 top-3.5 text-slate-400" />
                <Input
                  type="text"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  placeholder="e.g. +91 9876543210 or TSO-XXXX or Acme Inc"
                  className="h-11 pl-10 text-xs rounded-xl border-slate-200 bg-slate-50"
                  autoFocus
                  required
                />
              </div>
              <span className="text-[10px] text-slate-400 mt-1 block">
                For security and privacy, your full address is never exposed to unauthenticated parties.
              </span>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full h-11 bg-[#102f62] hover:bg-[#0b2855] text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-2 disabled:opacity-60 shadow-sm"
            >
              {loading ? "Searching securely..." : "Recover Login Email"}
            </button>
          </form>
        ) : (
          <div className="space-y-4 text-center">
            <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-900 space-y-2">
              <div className="flex items-center justify-center gap-1.5 font-bold">
                <CheckCircle2 size={16} className="text-emerald-600" />
                <span>Account Recovery Information</span>
              </div>
              <p className="text-slate-600 text-[11px] leading-relaxed">
                {result.message}
              </p>
              {result.masked_email && (
                <div className="mt-3 p-3 bg-white border border-emerald-200 rounded-lg text-left">
                  <span className="text-[10px] uppercase font-bold text-slate-400 block">Registered Login ID:</span>
                  <span className="font-mono text-sm font-bold text-[#102f62] block mt-0.5">
                    {result.masked_email}
                  </span>
                  <span className="text-[10px] text-slate-400 block mt-1">
                    Use this email address with your password to sign in.
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-2 pt-2">
              <Link
                to="/login"
                className="w-full h-11 bg-[#102f62] hover:bg-[#0b2855] text-white text-xs font-bold rounded-xl transition flex items-center justify-center gap-1.5 shadow-sm"
              >
                Proceed to Sign In
              </Link>
              <button
                type="button"
                onClick={() => { setResult(null); setIdentifier(""); }}
                className="text-xs font-semibold text-slate-500 hover:text-slate-800 py-1"
              >
                Try another identifier
              </button>
            </div>
          </div>
        )}

        <div className="border-t border-slate-100 pt-4 flex items-center justify-between text-xs">
          <Link to="/login" className="inline-flex items-center gap-1 font-semibold text-slate-500 hover:text-[#102f62]">
            <ArrowLeft size={14} /> Back to Sign In
          </Link>
          <Link to="/forgot-password" className="font-bold text-[#1769ff]">
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}
