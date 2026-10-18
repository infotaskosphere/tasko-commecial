import React, { memo, useState } from "react";
import { AlertTriangle, ChevronRight, FileText, RefreshCw } from "lucide-react";
import Markdown, { CopyButton } from "./Markdown";
import RouteStrip from "./RouteStrip";
import WeaveMark from "./WeaveMark";

function Reasoning({ text, streaming }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="mb-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 aw-muted hover:underline"
        aria-expanded={open}
      >
        <ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} />
        {streaming ? "Thinking…" : "Reasoning"}
      </button>
      {open && (
        <div className="aw-line mt-2 whitespace-pre-wrap border-l-2 pl-3 text-[13px] leading-6 aw-muted">{text}</div>
      )}
    </div>
  );
}

function UserMessage({ m }) {
  return (
    <div className="aw-rise flex justify-end">
      <div className="max-w-[85%] min-w-0">
        {m.attachments?.length > 0 && (
          <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
            {m.attachments.map((f, i) => (
              <span key={i} className="aw-surface inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs aw-muted">
                <FileText size={12} />{f.name}
              </span>
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-7 text-white" style={{ background: "var(--aw-user)" }}>
          {m.content}
        </div>
      </div>
    </div>
  );
}

function AssistantMessage({ m, isLast, busy, selected, onSelect, onRegenerate }) {
  const streaming = m.status === "streaming" || m.status === "pending";
  const meta = m.meta || {};
  const label = meta.providerName || (streaming ? "Choosing a model" : "AIWeave");
  return (
    <div className="aw-rise flex gap-3" data-selected={selected} onClick={m.status === "done" ? onSelect : undefined}>
      <WeaveMark size={18} tile className="mt-0.5 self-start !rounded-lg" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2 text-xs aw-muted">
          <span className="font-medium" style={{ color: "var(--aw-ink)" }}>{label}</span>
          {meta.modelName && <span>{meta.modelName}</span>}
        </div>

        <Reasoning text={m.reasoning} streaming={streaming && !m.content} />

        {m.status === "pending" && !m.content ? (
          <div className="flex items-center gap-2 py-1 text-sm aw-muted" role="status">
            <span className="flex gap-1" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <i key={i} className="aw-thread-live h-1.5 w-1.5 rounded-full" style={{ background: "var(--aw-thread)", animationDelay: `${i * 0.2}s` }} />
              ))}
            </span>
            {m.note || "Finding the best available model…"}
          </div>
        ) : (
          <Markdown text={m.content} streaming={m.status === "streaming"} />
        )}

        {m.status === "error" && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm" style={{ borderColor: "var(--aw-fail)" }} role="alert">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: "var(--aw-fail)" }} />
            <span className="min-w-0 flex-1">{m.error}</span>
          </div>
        )}
        {m.status === "stopped" && <p className="mt-2 text-xs aw-muted">Stopped. This partial answer is not saved to your history.</p>}

        <RouteStrip trail={meta.fallbackTrail} meta={meta} provider={meta.provider} live={streaming} />

        {!streaming && (
          <div className="-ml-2 mt-2 flex flex-wrap items-center gap-0.5 text-xs aw-muted">
            {m.content && <CopyButton text={m.content} className="hover:bg-black/5 dark:hover:bg-white/10" />}
            {isLast && !busy && (
              <button type="button" onClick={onRegenerate} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-black/5 dark:hover:bg-white/10">
                <RefreshCw size={13} />{m.status === "error" ? "Try again" : "Regenerate"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MessageView({ m, ...rest }) {
  if (m.role === "user") return <UserMessage m={m} />;
  if (m.role === "error") {
    return (
      <div className="flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm" style={{ borderColor: "var(--aw-fail)" }} role="alert">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" style={{ color: "var(--aw-fail)" }} />{m.content}
      </div>
    );
  }
  return <AssistantMessage m={m} {...rest} />;
}

export default memo(MessageView);
