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
import { PopupHeader } from "@/components/ui/popup-header";

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
        <PopupHeader icon={Type} eyebrow="Website Studio" title="Direct Text Editor" subtitle={<>Editing field: {fieldKey}</>} onClose={onClose} />

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
