import React from "react";
import { Link } from "react-router-dom";
import { ArrowRight, KeyRound, ShieldCheck, UserPlus } from "lucide-react";

/**
 * Accounts are never created by the public. A company's licence is issued by the
 * Platform Owner, the company administrator finishes setup with the licence key,
 * and every other user is added by that administrator (Users page), so seats,
 * company and module access always come from the licence.
 */
export default function Register() {
  return (
    <div className="min-h-screen overflow-hidden bg-[linear-gradient(135deg,#eaf8f3_0%,#e7f5ff_48%,#dff4ff_100%)]">
      <div className="mx-auto flex min-h-screen max-w-xl items-center px-4 py-10">
        <section className="w-full rounded-3xl border border-white/70 bg-white/90 p-8 shadow-xl backdrop-blur">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#123b69] text-white">
              <ShieldCheck size={22} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900">Create your account</h1>
              <p className="text-sm text-slate-500">Accounts are issued through your company licence.</p>
            </div>
          </div>

          <div className="space-y-3">
            <Link
              to="/login"
              className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4 transition hover:border-emerald-400 hover:bg-emerald-50/40"
            >
              <KeyRound className="mt-0.5 h-5 w-5 text-emerald-600" />
              <span className="flex-1">
                <span className="block text-sm font-bold text-slate-900">I am the company administrator</span>
                <span className="block text-xs text-slate-500">
                  On the sign-in page choose &ldquo;I have a license&rdquo; and enter your company name and licence number to set up your administrator login.
                </span>
              </span>
              <ArrowRight className="mt-1 h-4 w-4 text-slate-400" />
            </Link>

            <div className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4">
              <UserPlus className="mt-0.5 h-5 w-5 text-slate-500" />
              <span>
                <span className="block text-sm font-bold text-slate-900">I am a team member</span>
                <span className="block text-xs text-slate-500">
                  Ask your company administrator to add you under Users. You will get your login details from them.
                </span>
              </span>
            </div>
          </div>

          <div className="mt-7 border-t border-slate-100 pt-5 text-center text-sm">
            <span className="text-slate-500">Already have an account? </span>
            <Link to="/login" className="font-bold text-emerald-600 hover:underline">Sign in</Link>
          </div>
        </section>
      </div>
    </div>
  );
}
