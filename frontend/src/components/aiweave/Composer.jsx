import React, { useEffect, useRef, useState } from "react";
import { ArrowUp, FileText, Paperclip, Square, X } from "lucide-react";
import { ACCEPTED } from "./shared";

const MODES = [
  ["chat", "Chat"],
  ["reasoning", "Reasoning"],
  ["coding", "Coding"],
  ["debugging", "Debugging"],
  ["document_analysis", "Documents"],
  ["vision", "Images"],
  ["structured_output", "Structured data"],
];
const MAX_LEN = 100000;
const MAX_FILES = 10;

export default function Composer({ value, onChange, onSend, onStop, running, files, onFiles, onRemoveFile, mode, onMode, status, inputRef }) {
  const fileRef = useRef(null);
  const localRef = useRef(null);
  const area = inputRef || localRef;
  const [drop, setDrop] = useState(false);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value, area]);

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!running) onSend();
    }
  };

  const canSend = value.trim().length > 0 && !running;

  return (
    <div
      className="aw-composer rounded-2xl p-2 shadow-sm"
      data-drop={drop}
      onDragOver={(e) => { e.preventDefault(); setDrop(true); }}
      onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files); }}
    >
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-2 pb-1 pt-1">
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border aw-line px-2.5 py-1 text-xs">
              <FileText size={12} className="shrink-0" /><span className="truncate">{f.name}</span>
              <button type="button" onClick={() => onRemoveFile(i)} aria-label={`Remove ${f.name}`} className="shrink-0 aw-muted hover:text-red-600"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={area}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        maxLength={MAX_LEN}
        aria-label="Message AIWeave"
        placeholder={files.length ? "Ask about the attached documents…" : "Ask anything, or drop documents here"}
        className="block max-h-[220px] min-h-[44px] w-full resize-none border-0 bg-transparent px-3 py-2.5 text-[15px] leading-6 outline-none placeholder:text-slate-400"
      />
      <div className="flex items-center justify-between gap-2 px-1 pb-0.5 pt-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <input ref={fileRef} type="file" multiple accept={ACCEPTED} className="hidden" onChange={(e) => { onFiles(e.target.files); e.target.value = ""; }} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={files.length >= MAX_FILES}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs aw-muted hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
          >
            <Paperclip size={15} />Attach
          </button>
          <label className="sr-only" htmlFor="aw-mode">Mode</label>
          <select
            id="aw-mode"
            value={mode}
            onChange={(e) => onMode(e.target.value)}
            className="h-8 w-[7.25rem] rounded-lg border-0 bg-transparent px-2 text-xs aw-muted hover:bg-black/5 dark:hover:bg-white/10"
          >
            {MODES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {value.length > 20000 && <span className="text-xs aw-muted">{value.length.toLocaleString()} / {MAX_LEN.toLocaleString()}</span>}
          {running ? (
            <button type="button" onClick={onStop} aria-label="Stop generating" className="flex h-9 w-9 items-center justify-center rounded-xl text-white" style={{ background: "var(--aw-ink)" }}>
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button type="button" onClick={onSend} disabled={!canSend} aria-label="Send message" className="flex h-9 w-9 items-center justify-center rounded-xl text-white transition-opacity disabled:opacity-30" style={{ background: "var(--aw-thread)" }}>
              <ArrowUp size={17} />
            </button>
          )}
        </div>
      </div>
      <div className="sr-only" aria-live="polite">{status}</div>
    </div>
  );
}
