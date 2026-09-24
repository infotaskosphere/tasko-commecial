import React, { useState } from "react";
import {
  Sparkles,
  Palette,
  ArrowRight,
  Check,
  CheckCircle2,
  Sliders,
  Type,
  Maximize2,
  X
} from "lucide-react";
import { THEME_PRESETS, SAFE_FONTS } from "./studioTemplates";

export default function ThemeCustomizerModal({
  currentTheme = {},
  onApplyTheme,
  onClose,
}) {
  const [activeTab, setActiveTab] = useState("presets"); // 'presets' | 'customize'
  const [selectedPreset, setSelectedPreset] = useState(THEME_PRESETS[0]);

  const [customPrimary, setCustomPrimary] = useState(currentTheme.primary || "#102A56");
  const [customAccent, setCustomAccent] = useState(currentTheme.accent || "#2563EB");
  const [customFont, setCustomFont] = useState(currentTheme.font || "Plus Jakarta Sans");
  const [customRadius, setCustomRadius] = useState(currentTheme.radius || "16");
  const [customWidth, setCustomWidth] = useState(currentTheme.width || "wide");

  const handleApplyPreset = (preset) => {
    setSelectedPreset(preset);
    setCustomPrimary(preset.primary);
    setCustomAccent(preset.accent);
    setCustomFont(preset.font);
    setCustomRadius(preset.radius);
    setCustomWidth(preset.width);
    onApplyTheme({
      primary: preset.primary,
      accent: preset.accent,
      background: preset.background,
      text: preset.text,
      font: preset.font,
      radius: preset.radius,
      width: preset.width,
    });
  };

  const handleApplyCustom = () => {
    onApplyTheme({
      primary: customPrimary,
      accent: customAccent,
      background: "#FFFFFF",
      text: "#0F172A",
      font: customFont,
      radius: customRadius,
      width: customWidth,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] max-h-[700px] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600">
              <Palette size={20} />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900">Website Theme &amp; Typography</h2>
              <p className="text-xs text-slate-500">Pick a professional color palette or customize individual brand tones.</p>
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

        {/* Tab switch */}
        <div className="flex border-b border-slate-100 bg-slate-50 px-6">
          <button
            type="button"
            onClick={() => setActiveTab("presets")}
            className={`border-b-2 py-3 px-4 text-xs font-bold transition ${
              activeTab === "presets"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            Curated Themes ({THEME_PRESETS.length})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("customize")}
            className={`border-b-2 py-3 px-4 text-xs font-bold transition ${
              activeTab === "customize"
                ? "border-indigo-600 text-indigo-600"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            Custom Brand Colors &amp; Font
          </button>
        </div>

        {/* Tab Contents */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "presets" ? (
            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              {THEME_PRESETS.map((preset) => {
                const isSelected = selectedPreset?.id === preset.id;
                return (
                  <div
                    key={preset.id}
                    onClick={() => handleApplyPreset(preset)}
                    className={`group cursor-pointer rounded-2xl border p-4 shadow-sm transition hover:border-indigo-500 hover:shadow-md ${
                      isSelected ? "border-2 border-indigo-600 bg-indigo-50/20 ring-2 ring-indigo-500/20" : "border-slate-200 bg-white"
                    }`}
                  >
                    {/* Visual Color Swatches */}
                    <div className="flex h-16 w-full overflow-hidden rounded-xl shadow-inner mb-3">
                      <div className="flex-1 flex flex-col justify-end p-2 text-[10px] font-bold text-white/90" style={{ background: preset.primary }}>
                        Primary
                      </div>
                      <div className="w-1/3 flex flex-col justify-end p-2 text-[10px] font-bold text-white/90" style={{ background: preset.accent }}>
                        Accent
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-extrabold text-slate-900">{preset.name}</h3>
                      {isSelected && <CheckCircle2 size={16} className="text-indigo-600" />}
                    </div>

                    <p className="mt-1 text-[11px] leading-4 text-slate-500 line-clamp-2">{preset.description}</p>

                    <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-[10px] text-slate-400 font-semibold">
                      <span>Font: {preset.font}</span>
                      <span>Corner: {preset.radius}px</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="max-w-xl mx-auto space-y-6">
              {/* Primary Color */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <label className="block text-xs font-bold text-slate-800">Brand Primary Color</label>
                <p className="mt-0.5 text-[11px] text-slate-500">Main header background, prominent buttons, and title highlights.</p>
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="color"
                    value={customPrimary}
                    onChange={(e) => setCustomPrimary(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded-xl border border-slate-300 p-1"
                  />
                  <input
                    type="text"
                    value={customPrimary}
                    onChange={(e) => setCustomPrimary(e.target.value)}
                    className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono font-bold uppercase"
                  />
                </div>
              </div>

              {/* Accent Color */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <label className="block text-xs font-bold text-slate-800">Brand Accent Color</label>
                <p className="mt-0.5 text-[11px] text-slate-500">Call to action buttons, badges, and focus rings.</p>
                <div className="mt-3 flex items-center gap-3">
                  <input
                    type="color"
                    value={customAccent}
                    onChange={(e) => setCustomAccent(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded-xl border border-slate-300 p-1"
                  />
                  <input
                    type="text"
                    value={customAccent}
                    onChange={(e) => setCustomAccent(e.target.value)}
                    className="w-32 rounded-xl border border-slate-200 px-3 py-2 text-xs font-mono font-bold uppercase"
                  />
                </div>
              </div>

              {/* Typography */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <label className="block text-xs font-bold text-slate-800">Website Typography (Safe Curated Fonts)</label>
                <p className="mt-0.5 text-[11px] text-slate-500">Clean, crisp, high-legibility fonts for headlines and paragraphs.</p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  {SAFE_FONTS.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      onClick={() => setCustomFont(f.name)}
                      className={`rounded-xl border p-3 text-left transition ${
                        customFont === f.name ? "border-2 border-indigo-600 bg-indigo-50/30" : "border-slate-200 hover:border-slate-300"
                      }`}
                      style={{ fontFamily: f.name }}
                    >
                      <div className="text-xs font-bold text-slate-900">{f.name}</div>
                      <div className="text-[10px] text-slate-400">{f.category}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Corner Rounding */}
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <label className="block text-xs font-bold text-slate-800">Card Corner Rounding</label>
                <div className="mt-3 flex items-center gap-3">
                  {["4", "8", "14", "20", "28"].map((rad) => (
                    <button
                      key={rad}
                      type="button"
                      onClick={() => setCustomRadius(rad)}
                      className={`flex-1 rounded-xl border py-2.5 text-xs font-bold transition ${
                        customRadius === rad ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-200 text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {rad}px
                    </button>
                  ))}
                </div>
              </div>

              <button
                type="button"
                onClick={handleApplyCustom}
                className="w-full rounded-2xl bg-indigo-600 py-3.5 text-xs font-bold text-white shadow-lg hover:bg-indigo-700"
              >
                Apply Custom Theme
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
