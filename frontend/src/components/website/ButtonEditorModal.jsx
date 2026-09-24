import React, { useState } from "react";
import {
  Link as LinkIcon,
  Globe,
  FileText,
  Mail,
  Phone,
  MessageCircle,
  Hash,
  X,
  Check
} from "lucide-react";

export default function ButtonEditorModal({
  initialText = "",
  initialHref = "",
  pages = [],
  onSave,
  onClose,
}) {
  const [buttonText, setButtonText] = useState(initialText || "Get Started");
  const [actionType, setActionType] = useState(() => {
    if (!initialHref || initialHref === "#") return "page";
    if (initialHref.startsWith("mailto:")) return "email";
    if (initialHref.startsWith("tel:")) return "phone";
    if (initialHref.includes("wa.me") || initialHref.includes("whatsapp")) return "whatsapp";
    if (initialHref.startsWith("http")) return "url";
    if (initialHref.startsWith("#")) return "scroll";
    return "page";
  });

  const [targetPage, setTargetPage] = useState(() => {
    const matched = pages.find((p) => p.slug === initialHref || `#${p.id}` === initialHref);
    return matched?.id || pages[0]?.id || "home";
  });
  const [webUrl, setWebUrl] = useState(initialHref.startsWith("http") ? initialHref : "https://");
  const [email, setEmail] = useState(initialHref.replace("mailto:", ""));
  const [phone, setPhone] = useState(initialHref.replace("tel:", ""));
  const [whatsapp, setWhatsapp] = useState(initialHref.replace("https://wa.me/", ""));
  const [sectionTag, setSectionTag] = useState(initialHref.startsWith("#") ? initialHref.slice(1) : "features");

  const computeHref = () => {
    switch (actionType) {
      case "page": {
        const p = pages.find((pg) => pg.id === targetPage);
        return p?.id === "home" ? "/" : `#${p?.id || ""}`;
      }
      case "url":
        return webUrl.trim();
      case "email":
        return `mailto:${email.trim()}`;
      case "phone":
        return `tel:${phone.trim()}`;
      case "whatsapp":
        return `https://wa.me/${whatsapp.replace(/[^0-9]/g, "")}`;
      case "scroll":
        return `#${sectionTag.trim()}`;
      default:
        return "#";
    }
  };

  const handleApply = () => {
    const finalHref = computeHref();
    onSave(buttonText, finalHref);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-3xl bg-white shadow-2xl overflow-hidden border border-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <LinkIcon size={16} />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900">Button Settings</h3>
              <p className="text-[11px] text-slate-400">Configure button label and click action</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-bold text-slate-700">Button Text</label>
            <input
              type="text"
              value={buttonText}
              onChange={(e) => setButtonText(e.target.value)}
              className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-xs font-bold outline-none focus:border-blue-500"
              placeholder="e.g. Get Started"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700 mb-2">When Clicked, What Should Happen?</label>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { id: "page", label: "Open Another Page", icon: FileText },
                { id: "url", label: "Open Website Link", icon: Globe },
                { id: "scroll", label: "Scroll to Section", icon: Hash },
                { id: "whatsapp", label: "Open WhatsApp", icon: MessageCircle },
                { id: "email", label: "Send an Email", icon: Mail },
                { id: "phone", label: "Call Phone Number", icon: Phone },
              ].map((opt) => {
                const Icon = opt.icon;
                const isSelected = actionType === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setActionType(opt.id)}
                    className={`flex items-center gap-2 rounded-xl border p-2.5 text-left transition ${
                      isSelected ? "border-blue-600 bg-blue-50/50 text-blue-700 font-bold" : "border-slate-200 text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <Icon size={14} className={isSelected ? "text-blue-600" : "text-slate-400"} />
                    <span className="text-[11px] truncate">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Conditional Target Input */}
          <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
            {actionType === "page" && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Choose Website Page</label>
                <select
                  value={targetPage}
                  onChange={(e) => setTargetPage(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold outline-none"
                >
                  {pages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} {p.id === "home" ? "(Homepage)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {actionType === "url" && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Web Address (URL)</label>
                <input
                  type="url"
                  value={webUrl}
                  onChange={(e) => setWebUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
                />
              </div>
            )}

            {actionType === "scroll" && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Section Tag to Scroll To</label>
                <input
                  type="text"
                  value={sectionTag}
                  onChange={(e) => setSectionTag(e.target.value)}
                  placeholder="e.g. features, contact, pricing"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
                />
              </div>
            )}

            {actionType === "whatsapp" && (
              <div>
                <label className="block text-xs font-bold text-slate-700">WhatsApp Phone Number</label>
                <input
                  type="tel"
                  value={whatsapp}
                  onChange={(e) => setWhatsapp(e.target.value)}
                  placeholder="e.g. 919876543210 (with country code)"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
                />
              </div>
            )}

            {actionType === "email" && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Email Address</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="contact@yourbusiness.com"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
                />
              </div>
            )}

            {actionType === "phone" && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Telephone / Mobile Number</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs outline-none"
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-200 px-4 py-2.5 text-xs font-bold text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-5 py-2.5 text-xs font-black text-white shadow-md hover:bg-blue-700"
            >
              <Check size={14} /> Update Button
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
