import React, { useState } from "react";
import {
  Type,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Palette,
  Link,
  Check,
  X
} from "lucide-react";

export default function TextInlineModal({
  sectionId,
  fieldKey,
  initialText = "",
  onSave,
  onClose,
}) {
  const [text, setText] = useState(initialText || "");
  const [bold, setBold] = useState(false);
  const [italic, setItalic] = useState(false);
  const [align, setAlign] = useState("left");

  const handleApply = () => {
    onSave(sectionId, fieldKey, text);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-2xl overflow-hidden border border-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
              <Type size={16} />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900">Direct Text Editor</h3>
              <p className="text-[11px] text-slate-400 capitalize">Editing field: {fieldKey}</p>
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

        {/* Text Input area */}
        <div className="p-6 space-y-4">
          <div className="relative">
            <textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full rounded-2xl border border-slate-200 p-4 text-sm font-medium leading-relaxed text-slate-800 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              autoFocus
            />
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
              <Check size={14} /> Update Text
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
