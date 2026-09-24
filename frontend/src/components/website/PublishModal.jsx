import React, { useState } from "react";
import {
  Globe2,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  ExternalLink,
  Copy,
  Check,
  Send,
  X,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { toast } from "sonner";

export default function PublishModal({
  config,
  identity,
  onPublish,
  onClose,
  isPublished = false,
}) {
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [success, setSuccess] = useState(isPublished);

  // Validation checks for beginner reassurance
  const pagesCount = config?.pages?.length || 0;
  const hasHero = config?.pages?.some((p) => p.sections?.some((s) => s.type === "hero"));
  const hasContactInfo = Boolean(
    config?.global?.footer?.email ||
    config?.global?.footer?.phone ||
    config?.pages?.some((p) => p.sections?.some((s) => s.type === "form"))
  );
  const hasSiteName = Boolean(identity?.site_name?.trim());

  const handleCopyLink = () => {
    const fullUrl = `${window.location.origin}/`;
    navigator.clipboard.writeText(fullUrl);
    setCopied(true);
    toast.success("Public website address copied to clipboard!");
    setTimeout(() => setCopied(false), 2500);
  };

  const handleExecutePublish = async () => {
    setPublishing(true);
    try {
      await onPublish();
      setSuccess(true);
      toast.success("🎉 Website published and live to the world!");
    } catch (err) {
      toast.error("Unable to publish website. Please check connection.");
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-600">
              <Globe2 size={20} />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900">
                {success ? "Website Is Live!" : "Ready to Publish Website"}
              </h2>
              <p className="text-xs text-slate-500">
                {success ? "Your visitors can now view your live website." : "Review pre-flight checklist and make your site public."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 p-2 text-slate-400 hover:bg-slate-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5">
          {!success ? (
            <>
              {/* Readiness Checklist */}
              <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4 space-y-3">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Pre-Publish Checklist
                </span>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center gap-2.5">
                    <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                    <span className="text-slate-700"><b>{pagesCount}</b> active page(s) configured</span>
                  </div>

                  <div className="flex items-center gap-2.5">
                    {hasSiteName ? (
                      <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                    ) : (
                      <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                    )}
                    <span className="text-slate-700">
                      Website Name: <b>{identity?.site_name || "Missing brand name"}</b>
                    </span>
                  </div>

                  <div className="flex items-center gap-2.5">
                    {hasHero ? (
                      <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                    ) : (
                      <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                    )}
                    <span className="text-slate-700">Opening hero section &amp; calls to action</span>
                  </div>

                  <div className="flex items-center gap-2.5">
                    {hasContactInfo ? (
                      <CheckCircle2 size={16} className="text-emerald-600 shrink-0" />
                    ) : (
                      <AlertTriangle size={16} className="text-amber-500 shrink-0" />
                    )}
                    <span className="text-slate-700">
                      {hasContactInfo ? "Contact or enquiry touchpoint present" : "Consider adding a phone or email touchpoint"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-blue-100 bg-blue-50/60 p-4 text-xs leading-5 text-blue-900">
                <b>What happens when you publish?</b>
                <p className="mt-1 text-blue-800/80">
                  Your website changes will be saved to the commercial database and immediately served on the public homepage. You can update or unpublish at any time.
                </p>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-xl border border-slate-200 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  Keep Editing
                </button>
                <button
                  type="button"
                  disabled={publishing}
                  onClick={handleExecutePublish}
                  className="flex-1 rounded-xl bg-emerald-600 py-3 text-xs font-black text-white shadow-lg transition hover:bg-emerald-700 disabled:opacity-50"
                >
                  {publishing ? "Publishing Now…" : "Publish Website Now"}
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                <Check size={32} />
              </div>

              <div>
                <h3 className="text-lg font-black text-slate-900">Your Website is Live!</h3>
                <p className="mt-1 text-xs text-slate-500">
                  Anyone can now visit your website and submit enquiries.
                </p>
              </div>

              <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 p-2">
                <input
                  type="text"
                  readOnly
                  value={`${window.location.origin}/`}
                  className="flex-1 bg-transparent px-2 text-xs font-semibold text-slate-800 outline-none"
                />
                <button
                  type="button"
                  onClick={handleCopyLink}
                  className="inline-flex items-center gap-1 rounded-xl bg-slate-900 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-slate-800"
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy Link"}
                </button>
              </div>

              <div className="flex items-center gap-3 pt-2">
                <a
                  href="/"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 py-3 text-xs font-bold text-white shadow-md hover:bg-blue-700"
                >
                  <ExternalLink size={14} /> Open Live Site
                </a>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex-1 rounded-xl border border-slate-200 py-3 text-xs font-bold text-slate-700 hover:bg-slate-50"
                >
                  Back to Studio
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
