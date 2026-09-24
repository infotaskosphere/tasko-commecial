import React, { useState } from "react";
import {
  Sliders,
  Type,
  Layout,
  Maximize2,
  Minimize2,
  Trash2,
  Eye,
  EyeOff,
  MoveUp,
  MoveDown,
  Palette,
  Image as ImageIcon,
  Check,
  X,
  ChevronDown,
  ChevronUp
} from "lucide-react";

export default function SectionPropertiesDrawer({
  section,
  globalDesign,
  onPatchSectionData,
  onPatchSectionStyle,
  onOpenMediaLibrary,
  onOpenButtonEditor,
  onClose,
}) {
  const [activeTab, setActiveTab] = useState("content"); // 'content' | 'appearance' | 'spacing'
  const [showAdvanced, setShowAdvanced] = useState(false);

  if (!section) return null;
  const d = section.data || {};
  const s = section.style || {};

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600 font-bold uppercase text-[11px]">
            {section.type.slice(0, 2)}
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-900 capitalize">{section.title || section.type} Section</h3>
            <p className="text-[11px] text-slate-400">Content, style &amp; spacing</p>
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

      {/* Tabs */}
      <div className="flex border-b border-slate-100 bg-slate-50 px-5">
        {[
          { id: "content", label: "Content" },
          { id: "appearance", label: "Appearance" },
          { id: "spacing", label: "Spacing" },
        ].map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActiveTab(tab.id)}
            className={`border-b-2 py-3 px-3 text-xs font-bold transition ${
              activeTab === tab.id
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        {/* CONTENT TAB */}
        {activeTab === "content" && (
          <div className="space-y-4">
            {/* Badge */}
            {d.badge !== undefined && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Top Badge Label</label>
                <input
                  type="text"
                  value={d.badge || ""}
                  onChange={(e) => onPatchSectionData(section.id, { badge: e.target.value })}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Title / Heading */}
            {(d.title !== undefined || d.heading !== undefined) && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Main Heading</label>
                <textarea
                  rows={2}
                  value={d.title || d.heading || ""}
                  onChange={(e) =>
                    onPatchSectionData(section.id, {
                      [d.title !== undefined ? "title" : "heading"]: e.target.value,
                    })
                  }
                  className="mt-1 w-full rounded-2xl border border-slate-200 p-3 text-xs font-bold leading-relaxed outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Subtitle / Description / Body */}
            {(d.subtitle !== undefined || d.body !== undefined || d.text !== undefined) && (
              <div>
                <label className="block text-xs font-bold text-slate-700">Description / Text</label>
                <textarea
                  rows={4}
                  value={d.subtitle || d.body || d.text || ""}
                  onChange={(e) =>
                    onPatchSectionData(section.id, {
                      [d.subtitle !== undefined ? "subtitle" : d.body !== undefined ? "body" : "text"]: e.target.value,
                    })
                  }
                  className="mt-1 w-full rounded-2xl border border-slate-200 p-3 text-xs leading-relaxed outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Section Image */}
            {d.image !== undefined && (
              <div className="space-y-2">
                <label className="block text-xs font-bold text-slate-700">Section Image</label>
                <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
                  <div className="flex h-14 w-20 items-center justify-center rounded-xl bg-white overflow-hidden shadow-sm">
                    {d.image ? (
                      <img src={d.image} alt="" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <ImageIcon size={20} className="text-slate-300" />
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      onClick={() => onOpenMediaLibrary(section.id, "image")}
                      className="rounded-xl bg-blue-600 px-3 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-blue-700"
                    >
                      {d.image ? "Replace Image" : "Choose Image"}
                    </button>
                    {d.image && (
                      <button
                        type="button"
                        onClick={() => onPatchSectionData(section.id, { image: "" })}
                        className="text-[11px] font-semibold text-red-500 hover:text-red-700"
                      >
                        Remove image
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Buttons */}
            {(d.primaryText !== undefined || d.button !== undefined) && (
              <div className="space-y-3 pt-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                  Call to Action Buttons
                </span>
                <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-xs font-bold text-slate-800">
                        {d.primaryText || d.button || "Action Button"}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Link: {d.primaryHref || d.href || "#"}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenButtonEditor(section.id, d.primaryText ? "primary" : "button")}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-600 hover:bg-slate-100"
                    >
                      Edit Button
                    </button>
                  </div>
                </div>

                {d.secondaryText !== undefined && (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3.5 space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-slate-800">
                          {d.secondaryText || "Secondary Button"}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Link: {d.secondaryHref || "#"}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => onOpenButtonEditor(section.id, "secondary")}
                        className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-blue-600 hover:bg-slate-100"
                      >
                        Edit Button
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Text Alignment */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-1.5">Text Alignment</label>
              <div className="flex items-center gap-2">
                {[
                  { id: "left", label: "Left" },
                  { id: "center", label: "Center" },
                  { id: "right", label: "Right" },
                ].map((al) => (
                  <button
                    key={al.id}
                    type="button"
                    onClick={() => {
                      onPatchSectionData(section.id, { contentAlign: al.id });
                      onPatchSectionStyle(section.id, { textAlign: al.id });
                    }}
                    className={`flex-1 rounded-xl border py-2 text-xs font-bold ${
                      (d.contentAlign || s.textAlign || "left") === al.id
                        ? "border-blue-600 bg-blue-50 text-blue-600"
                        : "border-slate-200 text-slate-600"
                    }`}
                  >
                    {al.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* APPEARANCE TAB */}
        {activeTab === "appearance" && (
          <div className="space-y-5">
            {/* Background Style Preset */}
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2">Background Preset</label>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {[
                  { label: "White Clean", bg: "#FFFFFF", text: "#0F172A", theme: "light" },
                  { label: "Light Slate", bg: "#F8FAFC", text: "#0F172A", theme: "light" },
                  { label: "Executive Dark", bg: "linear-gradient(135deg, #102A56 0%, #102A43 58%, #061827 100%)", text: "#FFFFFF", theme: "executive" },
                  { label: "Deep Forest", bg: "#064E3B", text: "#FFFFFF", theme: "dark" },
                  { label: "Brand Accent", bg: globalDesign?.primary || "#102A56", text: "#FFFFFF", theme: "dark" },
                  { label: "Onyx Black", bg: "#090D16", text: "#FFFFFF", theme: "dark" },
                ].map((preset, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => {
                      onPatchSectionStyle(section.id, {
                        backgroundColor: preset.bg,
                        textColor: preset.text,
                      });
                      onPatchSectionData(section.id, {
                        theme: preset.theme,
                        backgroundColor: preset.bg,
                      });
                    }}
                    className="flex items-center gap-2 rounded-xl border border-slate-200 p-2.5 text-left hover:border-blue-400"
                  >
                    <span className="h-5 w-5 rounded-full border shadow-sm shrink-0" style={{ background: preset.bg }} />
                    <span className="font-semibold text-slate-700 truncate">{preset.label}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Custom Colors */}
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 space-y-3">
              <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
                Custom Colors
              </span>

              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Text Color</span>
                <input
                  type="color"
                  value={s.textColor || "#0F172A"}
                  onChange={(e) => onPatchSectionStyle(section.id, { textColor: e.target.value })}
                  className="h-8 w-12 cursor-pointer rounded-lg border border-slate-200"
                />
              </div>

              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-700">Background Color</span>
                <input
                  type="color"
                  value={s.backgroundColor || "#FFFFFF"}
                  onChange={(e) => onPatchSectionStyle(section.id, { backgroundColor: e.target.value })}
                  className="h-8 w-12 cursor-pointer rounded-lg border border-slate-200"
                />
              </div>
            </div>
          </div>
        )}

        {/* SPACING TAB */}
        {activeTab === "spacing" && (
          <div className="space-y-5">
            <div>
              <label className="block text-xs font-bold text-slate-700 mb-2">Section Height / Padding</label>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Compact", pad: 40 },
                  { label: "Standard", pad: 80 },
                  { label: "Generous", pad: 120 },
                ].map((sp) => (
                  <button
                    key={sp.label}
                    type="button"
                    onClick={() =>
                      onPatchSectionStyle(section.id, {
                        paddingTop: sp.pad,
                        paddingBottom: sp.pad,
                      })
                    }
                    className="rounded-xl border border-slate-200 py-3 text-center text-xs font-bold hover:border-blue-500 hover:bg-blue-50/50"
                  >
                    {sp.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Advanced toggle */}
            <div className="border-t border-slate-100 pt-4">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex w-full items-center justify-between text-xs font-bold text-slate-500 hover:text-slate-800"
              >
                <span>Advanced Spacing Controls</span>
                {showAdvanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>

              {showAdvanced && (
                <div className="mt-3 space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700">Top Padding: {s.paddingTop ?? 80}px</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={10}
                      value={s.paddingTop ?? 80}
                      onChange={(e) => onPatchSectionStyle(section.id, { paddingTop: Number(e.target.value) })}
                      className="mt-1 w-full"
                    />
                  </div>

                  <div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-slate-700">Bottom Padding: {s.paddingBottom ?? 80}px</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={200}
                      step={10}
                      value={s.paddingBottom ?? 80}
                      onChange={(e) => onPatchSectionStyle(section.id, { paddingBottom: Number(e.target.value) })}
                      className="mt-1 w-full"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
