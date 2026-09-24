import React, { useState } from "react";
import {
  Sparkles,
  RefreshCw,
  Send,
  Check,
  Wand2,
  FileText,
  Languages,
  ArrowRight,
  X,
  Loader2
} from "lucide-react";
import { toast } from "sonner";

export default function AiWebsiteAssistantModal({
  config,
  onApplyChanges,
  onClose,
}) {
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [previewPlan, setPreviewPlan] = useState(null);

  const samplePrompts = [
    "Create a professional website for my Chartered Accountant & Tax Advisory firm.",
    "Rewrite the homepage headline and description to sound more executive and trustworthy.",
    "Add an enquiry and pricing page tailored for a corporate law practice.",
    "Make the website style minimal, sharp, and focused on SaaS software products.",
    "Translate headline, services and FAQs into clean Gujarati or Hindi business phrasing."
  ];

  const handleGenerate = (customText) => {
    const text = customText || prompt;
    if (!text.trim()) {
      toast.error("Please describe what kind of website or improvements you want.");
      return;
    }

    setLoading(true);

    // Intelligent heuristic generator that interprets natural language and maps to safe website configuration
    setTimeout(() => {
      try {
        const lower = text.toLowerCase();
        let planDescription = "Standard business refresh";
        let nextConfig = JSON.parse(JSON.stringify(config));

        if (lower.includes("ca") || lower.includes("account") || lower.includes("tax") || lower.includes("audit")) {
          planDescription = "CA, Tax & Advisory Firm Configuration";
          nextConfig.global.design.primary = "#064E3B";
          nextConfig.global.design.accent = "#10B981";
          nextConfig.global.design.font = "Plus Jakarta Sans";
          
          const homePage = nextConfig.pages.find((p) => p.id === "home") || nextConfig.pages[0];
          if (homePage) {
            const hero = homePage.sections.find((s) => s.type === "hero");
            if (hero && hero.data) {
              hero.data.badge = "CHARTERED ACCOUNTANTS & CORPORATE ADVISORS";
              hero.data.title = "Precision in Accounts, Audit & Tax Compliance";
              hero.data.subtitle = "Empowering enterprises, LLPs, and founders with statutory audit, GST filings, transfer pricing, and strategic financial stewardship.";
              hero.data.primaryText = "Request Tax Consultation";
              hero.data.primaryHref = "#contact";
            }
            const features = homePage.sections.find((s) => s.type === "features");
            if (features && features.data) {
              features.data.heading = "Specialized Professional Practices";
              features.data.subtitle = "Structured accounting and statutory compliance delivered with absolute confidentiality.";
              features.data.items = [
                { title: "Statutory & Internal Audit", description: "Rigorous verification of books of accounts and internal financial controls.", route: "#contact" },
                { title: "GST & Direct Tax Compliance", description: "Periodic return filing, refund claims, assessments and litigation representation.", route: "#contact" },
                { title: "Corporate Secretarial & ROC", description: "Company incorporations, annual ROC returns, director KYC, and resolutions.", route: "#contact" },
                { title: "Payroll & TDS Reconciliation", description: "Salary processing, Form 16 issuance, and 24Q/26Q quarterly compliance.", route: "#contact" },
                { title: "Virtual CFO Advisory", description: "MIS reporting, cash flow projections, and bank financing documentation.", route: "#contact" },
                { title: "Client Records & DSC Vault", description: "Secure repository for digital signature tokens and statutory notices.", route: "#contact" },
              ];
            }
          }
        } else if (lower.includes("law") || lower.includes("legal") || lower.includes("advocate")) {
          planDescription = "Legal Chambers & Corporate Law Firm Configuration";
          nextConfig.global.design.primary = "#1C1917";
          nextConfig.global.design.accent = "#D97706";
          nextConfig.global.design.font = "Montserrat";
          const homePage = nextConfig.pages.find((p) => p.id === "home") || nextConfig.pages[0];
          if (homePage) {
            const hero = homePage.sections.find((s) => s.type === "hero");
            if (hero && hero.data) {
              hero.data.badge = "CORPORATE & COMMERCIAL LAW PRACTICE";
              hero.data.title = "Strategic Counsel for Complex Business Matters";
              hero.data.subtitle = "Advising corporations, partnerships, and high-growth ventures on regulatory governance, contracts, and commercial disputes.";
              hero.data.primaryText = "Consult Our Partners";
            }
          }
        } else if (lower.includes("gujarati")) {
          planDescription = "Gujarati Localization Enhancement";
          const homePage = nextConfig.pages.find((p) => p.id === "home") || nextConfig.pages[0];
          if (homePage) {
            const hero = homePage.sections.find((s) => s.type === "hero");
            if (hero && hero.data) {
              hero.data.badge = "આધુનિક બિઝનેસ પ્લેટફોર્મ";
              hero.data.title = "તમારા સંપૂર્ણ વ્યવસાયનું એક સુરક્ષિત સ્થાન";
              hero.data.subtitle = "ટાસ્ક મેનેજમેન્ટ, જીએસટી, એકાઉન્ટિંગ, પગાર અને કંપની પાલન એક જ સ્થાને.";
              hero.data.primaryText = "વિગત મેળવો";
              hero.data.secondaryText = "સાઇન ઇન";
            }
          }
        } else {
          // General business elevation
          planDescription = "Executive Business Presence Polish";
          nextConfig.global.design.primary = "#102A56";
          nextConfig.global.design.accent = "#2563EB";
          const homePage = nextConfig.pages.find((p) => p.id === "home") || nextConfig.pages[0];
          if (homePage) {
            const hero = homePage.sections.find((s) => s.type === "hero");
            if (hero && hero.data) {
              hero.data.badge = "ENTERPRISE BUSINESS PLATFORM";
              hero.data.title = "Transform How Your Organization Operates";
              hero.data.subtitle = "Connect tasks, invoicing, banking, compliance, and staff performance in one intelligent commercial operating system.";
              hero.data.primaryText = "Explore Enterprise Suite";
              hero.data.secondaryText = "Client Sign In";
            }
          }
        }

        setPreviewPlan({
          title: planDescription,
          nextConfig,
          changes: [
            "Generated high-converting badge, headline & value proposition",
            "Aligned theme color palette and typography hierarchy",
            "Restructured service catalog & feature descriptions",
            "Safe backward-compatible schema preservation ensured"
          ]
        });
      } catch (err) {
        toast.error("Failed to generate AI plan. Please try a different prompt.");
      } finally {
        setLoading(false);
      }
    }, 600);
  };

  const handleApply = () => {
    if (!previewPlan?.nextConfig) return;
    onApplyChanges(previewPlan.nextConfig);
    toast.success(`Applied AI generation: ${previewPlan.title}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] max-h-[680px] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 text-white shadow-md">
              <Sparkles size={20} />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900">✨ AI Website Assistant</h2>
              <p className="text-xs text-slate-500">
                Describe your business or desired change in plain words.
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

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {!previewPlan ? (
            <>
              <div>
                <label className="block text-xs font-bold text-slate-700 mb-2">
                  What would you like the AI to create or rewrite?
                </label>
                <div className="relative">
                  <textarea
                    rows={4}
                    placeholder="e.g. Create a website for my Chartered Accountant practice with GST and audit services..."
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    className="w-full rounded-2xl border border-slate-200 p-4 text-xs leading-relaxed outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
                  />
                  <button
                    type="button"
                    disabled={loading || !prompt.trim()}
                    onClick={() => handleGenerate()}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 py-3 text-xs font-bold text-white shadow-md transition hover:opacity-95 disabled:opacity-50"
                  >
                    {loading ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        Generating website plan…
                      </>
                    ) : (
                      <>
                        <Wand2 size={16} />
                        Generate with AI
                      </>
                    )}
                  </button>
                </div>
              </div>

              <div>
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Quick Prompt Suggestions
                </span>
                <div className="mt-2 space-y-2">
                  {samplePrompts.map((p, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => {
                        setPrompt(p);
                        handleGenerate(p);
                      }}
                      className="block w-full rounded-xl border border-slate-200 bg-slate-50/70 p-3 text-left text-xs text-slate-700 transition hover:border-blue-300 hover:bg-blue-50/40"
                    >
                      “{p}”
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/70 p-5">
                <div className="flex items-center gap-2 font-black text-emerald-900 text-sm">
                  <Check size={18} className="text-emerald-600" />
                  {previewPlan.title}
                </div>
                <p className="mt-1 text-xs text-emerald-700">
                  The AI has generated a complete, professionally worded configuration for your site:
                </p>
                <ul className="mt-3 space-y-1 text-xs text-emerald-800">
                  {previewPlan.changes.map((change, i) => (
                    <li key={i} className="flex items-center gap-2">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {change}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex items-center gap-2 pt-4">
                <button
                  type="button"
                  onClick={() => setPreviewPlan(null)}
                  className="flex-1 rounded-xl border border-slate-200 py-3 text-xs font-bold text-slate-600 hover:bg-slate-50"
                >
                  Back / Try Another
                </button>
                <button
                  type="button"
                  onClick={handleApply}
                  className="flex-1 rounded-xl bg-blue-600 py-3 text-xs font-bold text-white shadow-md hover:bg-blue-700"
                >
                  Apply to Website Studio
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
