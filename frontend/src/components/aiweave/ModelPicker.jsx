import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import WeaveMark from "./WeaveMark";

export default function ModelPicker({ connected, models, provider, model, onChange }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!box.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);

  const activeModel = model === "auto" ? null : models.find((m) => m.id === model);
  const activeProvider = connected.find((p) => p.id === provider);
  const label = activeModel?.name || (provider !== "auto" ? activeProvider?.name || provider : "Auto");
  const pick = (p, m) => { onChange(p, m); setOpen(false); };
  const providerModels = provider === "auto" ? [] : models.filter((m) => m.provider === provider);

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="aw-surface inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium"
      >
        <WeaveMark size={15} className="text-[var(--aw-thread)]" />
        <span className="max-w-[160px] truncate">{label}</span>
        <ChevronDown size={14} className="aw-muted" />
      </button>
      {open && (
        <div className="aw-surface absolute right-0 z-40 mt-2 max-h-[65vh] w-[min(22rem,90vw)] overflow-y-auto rounded-xl border p-1.5 shadow-xl aw-scroll" role="listbox">
          <button type="button" onClick={() => pick("auto", "auto")} className="flex w-full items-start gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-black/5 dark:hover:bg-white/10" role="option" aria-selected={provider === "auto"}>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Auto</span>
              <span className="block text-xs aw-muted">Best available model, with automatic switching</span>
            </span>
            {provider === "auto" && <Check size={15} className="mt-0.5" />}
          </button>
          {connected.length > 0 && <div className="aw-line mx-2 my-1 border-t" />}
          {connected.map((p) => (
            <React.Fragment key={p.id}>
              <button type="button" onClick={() => pick(p.id, "auto")} className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/10" role="option" aria-selected={provider === p.id && model === "auto"}>
                <span>{p.name}</span>
                {provider === p.id && model === "auto" ? <Check size={15} /> : <span className="text-xs aw-muted">{p.connectedCount} account{p.connectedCount === 1 ? "" : "s"}</span>}
              </button>
              {provider === p.id && providerModels.map((m) => (
                <button key={m.id} type="button" onClick={() => pick(p.id, m.id)} className="flex w-full items-center justify-between rounded-lg py-1.5 pl-7 pr-3 text-left text-xs hover:bg-black/5 dark:hover:bg-white/10" role="option" aria-selected={model === m.id}>
                  <span className="truncate">{m.name}</span>
                  {model === m.id && <Check size={14} />}
                </button>
              ))}
            </React.Fragment>
          ))}
          {!connected.length && <p className="px-3 py-3 text-xs aw-muted">No providers are connected. Auto will report this when you send a message.</p>}
        </div>
      )}
    </div>
  );
}
