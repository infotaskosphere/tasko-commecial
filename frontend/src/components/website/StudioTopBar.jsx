import React from "react";
import {
  Globe,
  Monitor,
  Tablet,
  Smartphone,
  Undo2,
  Redo2,
  Save,
  Send,
  Eye,
  Settings,
  Sparkles,
  CheckCircle2,
  Circle,
  Loader2,
  ChevronLeft,
  Share2
} from "lucide-react";
import { Link } from "react-router-dom";

export default function StudioTopBar({
  siteName = "My Website",
  activePageName = "Home",
  deviceMode = "desktop",
  onDeviceChange,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSave,
  onOpenPublish,
  onOpenAiAssistant,
  onOpenOnboarding,
  onOpenThemeCustomizer,
  onTogglePreviewMode,
  isPreviewMode = false,
  saveStatus = "saved", // 'saved' | 'unsaved' | 'saving' | 'published'
}) {
  return (
    <header className="sticky top-0 z-40 flex h-16 w-full items-center justify-between border-b border-slate-200 bg-white px-4 shadow-[0_1px_10px_rgba(15,23,42,.03)] select-none">
      {/* LEFT: Branding, Title & Page */}
      <div className="flex items-center gap-3 min-w-0">
        <Link
          to="/master-console"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 text-slate-500 transition hover:bg-slate-50 hover:text-slate-900"
          title="Return to Master Console"
        >
          <ChevronLeft size={18} />
        </Link>

        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-600 text-white font-black text-sm shadow-sm">
            WS
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-extrabold tracking-tight text-slate-900">
                {siteName}
              </span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">
                Website Studio
              </span>
            </div>
            <div className="truncate text-[11px] text-slate-400">
              Editing: <span className="font-semibold text-slate-600">{activePageName}</span>
            </div>
          </div>
        </div>
      </div>

      {/* CENTER: Responsive Device Modes & Live Preview */}
      <div className="hidden md:flex items-center gap-2">
        <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-1">
          <button
            type="button"
            onClick={() => onDeviceChange("desktop")}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold transition ${
              deviceMode === "desktop"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
            title="Desktop screen view"
          >
            <Monitor size={14} /> Desktop
          </button>
          <button
            type="button"
            onClick={() => onDeviceChange("tablet")}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold transition ${
              deviceMode === "tablet"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
            title="Tablet screen view"
          >
            <Tablet size={14} /> Tablet
          </button>
          <button
            type="button"
            onClick={() => onDeviceChange("mobile")}
            className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-bold transition ${
              deviceMode === "mobile"
                ? "bg-white text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-800"
            }`}
            title="Mobile screen view"
          >
            <Smartphone size={14} /> Mobile
          </button>
        </div>

        <button
          type="button"
          onClick={onTogglePreviewMode}
          className={`flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-bold transition ${
            isPreviewMode
              ? "border-blue-600 bg-blue-50 text-blue-700"
              : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
          }`}
          title="Toggle live full-screen preview"
        >
          <Eye size={14} />
          {isPreviewMode ? "Exit Preview" : "Preview"}
        </button>
      </div>

      {/* RIGHT: Actions, Undo/Redo, Status, AI, Save, Publish */}
      <div className="flex items-center gap-2">
        {/* Status Indicator */}
        <div className="hidden lg:flex items-center gap-1.5 px-2 text-xs font-semibold text-slate-500">
          {saveStatus === "saving" && (
            <>
              <Loader2 size={13} className="animate-spin text-blue-600" />
              <span>Saving…</span>
            </>
          )}
          {saveStatus === "unsaved" && (
            <>
              <span className="h-2 w-2 rounded-full bg-amber-400" />
              <span className="text-amber-700">Unsaved changes</span>
            </>
          )}
          {saveStatus === "saved" && (
            <>
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-slate-600">Saved</span>
            </>
          )}
          {saveStatus === "published" && (
            <>
              <CheckCircle2 size={13} className="text-emerald-600" />
              <span className="text-emerald-700 font-bold">Published</span>
            </>
          )}
        </div>

        {/* Undo / Redo */}
        <div className="flex items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5">
          <button
            type="button"
            onClick={onUndo}
            disabled={!canUndo}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-white disabled:opacity-30"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 size={15} />
          </button>
          <button
            type="button"
            onClick={onRedo}
            disabled={!canRedo}
            className="rounded-lg p-1.5 text-slate-600 hover:bg-white disabled:opacity-30"
            title="Redo (Ctrl+Y)"
          >
            <Redo2 size={15} />
          </button>
        </div>

        {/* AI Assistant */}
        <button
          type="button"
          onClick={onOpenAiAssistant}
          className="hidden sm:inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50/70 px-3 py-1.5 text-xs font-bold text-indigo-700 hover:bg-indigo-100 transition shadow-sm"
          title="Build or rewrite website with AI"
        >
          <Sparkles size={14} className="text-indigo-600" />
          <span>✨ Build with AI</span>
        </button>

        {/* Setup Wizard */}
        <button
          type="button"
          onClick={onOpenOnboarding}
          className="hidden xl:inline-flex items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          title="Launch beginner setup wizard"
        >
          Setup Wizard
        </button>

        {/* Save */}
        <button
          type="button"
          onClick={onSave}
          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50 shadow-sm"
        >
          <Save size={14} />
          <span className="hidden sm:inline">Save</span>
        </button>

        {/* Primary Action: Publish Website */}
        <button
          type="button"
          onClick={onOpenPublish}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-black text-white shadow-[0_4px_12px_rgba(5,150,105,.28)] transition hover:bg-emerald-700 hover:scale-[1.02]"
        >
          <Globe size={14} />
          <span>PUBLISH WEBSITE</span>
        </button>
      </div>
    </header>
  );
}
