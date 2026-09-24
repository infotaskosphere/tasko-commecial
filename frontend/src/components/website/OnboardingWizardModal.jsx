import React, { useState } from "react";
import {
  Sparkles,
  Building2,
  Briefcase,
  Layers,
  ArrowRight,
  Check,
  Palette,
  Image as ImageIcon,
  CheckCircle2,
  X
} from "lucide-react";
import { THEME_PRESETS, PAGE_TEMPLATES, FULL_SITE_TEMPLATES } from "./studioTemplates";

export default function OnboardingWizardModal({
  onComplete,
  onClose,
}) {
  const [step, setStep] = useState(1);
  const [businessType, setBusinessType] = useState("Corporate");
  const [siteName, setSiteName] = useState("My Business");
  const [selectedTheme, setSelectedTheme] = useState(THEME_PRESETS[0]);
  const [selectedPages, setSelectedPages] = useState(["about", "services", "pricing", "contact"]);
  const [logoOption, setLogoOption] = useState("/onenexa-logo.png");

  const businessTypes = [
    { id: "Corporate", title: "Business & Corporate", desc: "Consultancies, agencies, and enterprise services" },
    { id: "Finance", title: "Chartered Accountant / CS / Tax", desc: "Audit, tax filing, corporate secretarial" },
    { id: "Legal", title: "Law Practice & Legal Chambers", desc: "Attorneys, advocates, and advisory councils" },
    { id: "Tech", title: "Software & Technology SaaS", desc: "Digital products, platforms, and SaaS tools" },
    { id: "Services", title: "Local & Professional Services", desc: "Logistics, consulting, agencies, clinics" },
  ];

  const togglePage = (id) => {
    if (selectedPages.includes(id)) {
      if (selectedPages.length === 1) return; // Keep at least one
      setSelectedPages(selectedPages.filter((x) => x !== id));
    } else {
      setSelectedPages([...selectedPages, id]);
    }
  };

  const handleFinish = () => {
    // Compile starter website
    const matchedPages = selectedPages
      .map((id) => PAGE_TEMPLATES.find((p) => p.id === id))
      .filter(Boolean);

    // Ensure Home page is first
    const homeTemplate = PAGE_TEMPLATES.find((p) => p.id === "blank") || {
      id: "home",
      name: "Home",
      sections: [],
    };

    const finalPages = [
      {
        id: "home",
        name: "Home",
        slug: "/",
        visible: true,
        sections: [
          {
            id: "hero",
            type: "hero",
            title: "Hero",
            visible: true,
            layout: "split",
            data: {
              badge: `${businessType.toUpperCase()} EXCELLENCE`,
              title: `Welcome to ${siteName}`,
              subtitle: "We combine domain mastery, client focus, and modern tools to achieve exceptional results.",
              primaryText: "Explore Services",
              primaryHref: "#features",
              secondaryText: "Get in touch",
              secondaryHref: "#contact",
              image: logoOption,
              theme: "executive",
            },
          },
          {
            id: "features",
            type: "features",
            title: "Our Capabilities",
            visible: true,
            data: {
              heading: "Specialized Services & Capabilities",
              subtitle: "Built around your high-priority operational requirements.",
              items: [
                { title: "Statutory & Tax Compliance", description: "Timely filings, reconciliations and representation.", route: "#contact" },
                { title: "Strategic Advisory", description: "Long-term planning, controls, and performance governance.", route: "#contact" },
                { title: "Process Automation", description: "Modern digital tools and streamlined workflows.", route: "#contact" },
              ],
            },
          },
          {
            id: "cta",
            type: "cta",
            title: "Call to Action",
            visible: true,
            data: {
              heading: `Ready to partner with ${siteName}?`,
              text: "Speak with our directors or schedule a confidential meeting.",
              button: "Schedule Consultation",
              href: "#contact",
            },
          },
        ],
      },
      ...matchedPages.map((tmpl) => ({
        id: tmpl.id,
        name: tmpl.name,
        slug: `/${tmpl.id}`,
        visible: true,
        sections: JSON.parse(JSON.stringify(tmpl.sections)),
      })),
    ];

    const initialConfig = {
      version: 6,
      activePageId: "home",
      pages: finalPages,
      global: {
        header: {
          sticky: true,
          showLogin: true,
          logo: true,
          buttonText: "Sign in",
          buttonHref: "/login",
          items: finalPages.map((p) => ({
            label: p.name,
            destination: p.id === "home" ? "/" : `#${p.id}`,
          })),
        },
        footer: {
          show: true,
          company: siteName,
          text: `Professional ${businessType} platform.`,
          copyright: `© ${new Date().getFullYear()} ${siteName}. All rights reserved.`,
          phone: "+91 98765 43210",
          email: `contact@${siteName.toLowerCase().replace(/[^a-z0-9]/g, "") || "company"}.com`,
          address: "Executive Towers, Financial District",
        },
        design: {
          primary: selectedTheme.primary,
          accent: selectedTheme.accent,
          background: selectedTheme.background,
          text: selectedTheme.text,
          font: selectedTheme.font,
          radius: selectedTheme.radius,
          width: "wide",
        },
      },
    };

    const initialIdentity = {
      site_name: siteName,
      site_tagline: `Modern ${businessType} operations`,
      logo_url: logoOption,
      favicon_url: logoOption,
      footer_company: siteName,
      footer_text: `Professional ${businessType} platform.`,
      footer_copyright: `© ${new Date().getFullYear()} ${siteName}. All rights reserved.`,
    };

    onComplete({ config: initialConfig, identity: initialIdentity });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm">
      <div className="flex h-[90vh] max-h-[640px] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* Progress Bar */}
        <div className="border-b border-slate-100 bg-slate-50/80 px-6 py-4">
          <div className="flex items-center justify-between text-xs font-bold text-slate-500">
            <span>Website Setup Wizard</span>
            <span>Step {step} of 5</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-blue-600 transition-all duration-300"
              style={{ width: `${(step / 5) * 100}%` }}
            />
          </div>
        </div>

        {/* Wizard Steps */}
        <div className="flex-1 overflow-y-auto p-6 sm:p-8">
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-xl font-black text-slate-900">What is your website about?</h2>
              <p className="text-xs text-slate-500">
                Select your industry so Website Studio can tailor colors and headings.
              </p>
              <div className="grid gap-3 sm:grid-cols-2 pt-2">
                {businessTypes.map((type) => (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => setBusinessType(type.id)}
                    className={`rounded-2xl border p-4 text-left transition ${
                      businessType === type.id
                        ? "border-2 border-blue-600 bg-blue-50/50 shadow-sm"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-sm text-slate-900">{type.title}</span>
                      {businessType === type.id && <CheckCircle2 size={16} className="text-blue-600" />}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">{type.desc}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-xl font-black text-slate-900">What is your website or firm name?</h2>
              <p className="text-xs text-slate-500">
                This will appear in your website header, footer, and page title.
              </p>
              <div className="pt-4">
                <input
                  type="text"
                  value={siteName}
                  onChange={(e) => setSiteName(e.target.value)}
                  placeholder="e.g. Apex Corporate Advisors"
                  className="w-full rounded-2xl border border-slate-200 p-4 text-base font-bold text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-100"
                  autoFocus
                />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-xl font-black text-slate-900">Choose a color style &amp; mood</h2>
              <p className="text-xs text-slate-500">
                You can easily customize these colors or swap themes at any time.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 pt-2">
                {THEME_PRESETS.slice(0, 6).map((thm) => (
                  <button
                    key={thm.id}
                    type="button"
                    onClick={() => setSelectedTheme(thm)}
                    className={`rounded-2xl border p-3 text-left transition ${
                      selectedTheme.id === thm.id
                        ? "border-2 border-blue-600 shadow-sm"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                  >
                    <div className="flex h-12 w-full rounded-xl overflow-hidden shadow-inner mb-2">
                      <div className="w-2/3 h-full" style={{ background: thm.primary }} />
                      <div className="w-1/3 h-full" style={{ background: thm.accent }} />
                    </div>
                    <div className="font-bold text-xs text-slate-800">{thm.name}</div>
                    <div className="text-[10px] text-slate-400">{thm.category}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-4">
              <h2 className="text-xl font-black text-slate-900">Select pages to include</h2>
              <p className="text-xs text-slate-500">
                Choose the starter pages you want on your website menu.
              </p>
              <div className="grid gap-2.5 sm:grid-cols-2 pt-2">
                {PAGE_TEMPLATES.map((tmpl) => {
                  const isChecked = selectedPages.includes(tmpl.id);
                  return (
                    <div
                      key={tmpl.id}
                      onClick={() => togglePage(tmpl.id)}
                      className={`flex cursor-pointer items-center justify-between rounded-xl border p-3 transition ${
                        isChecked ? "border-blue-600 bg-blue-50/30" : "border-slate-200"
                      }`}
                    >
                      <div>
                        <div className="text-xs font-bold text-slate-900">{tmpl.name}</div>
                        <div className="text-[11px] text-slate-500">{tmpl.description}</div>
                      </div>
                      <div
                        className={`flex h-5 w-5 items-center justify-center rounded-md border ${
                          isChecked ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300"
                        }`}
                      >
                        {isChecked && <Check size={12} />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h2 className="text-xl font-black text-slate-900">Choose a default logo</h2>
              <p className="text-xs text-slate-500">
                Pick a placeholder or upload your own corporate emblem later.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 pt-2">
                {[
                  { title: "ONENEXA", url: "/onenexa-logo.png" },
                  { title: "Taskosphere", url: "/logo-transparent.png" },
                  { title: "Finix Accounting", url: "/finix-logo.png" },
                ].map((item) => (
                  <button
                    key={item.url}
                    type="button"
                    onClick={() => setLogoOption(item.url)}
                    className={`rounded-2xl border p-4 text-center transition ${
                      logoOption === item.url ? "border-2 border-blue-600 shadow-sm" : "border-slate-200"
                    }`}
                  >
                    <div className="flex h-14 items-center justify-center bg-slate-50 rounded-xl p-2 mb-2">
                      <img src={item.url} alt="" className="max-h-10 object-contain" />
                    </div>
                    <span className="text-xs font-bold text-slate-700">{item.title}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50/80 px-6 py-4">
          {step > 1 ? (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100"
            >
              Back
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100"
            >
              Skip Wizard
            </button>
          )}

          {step < 5 ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-black text-white shadow-md hover:bg-blue-700"
            >
              Continue <ArrowRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleFinish}
              className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-6 py-2.5 text-xs font-black text-white shadow-lg hover:bg-emerald-700"
            >
              Create My Website Now <Sparkles size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
