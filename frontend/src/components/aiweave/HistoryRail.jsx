import React, { useMemo } from "react";
import { Plus, Search, Settings, Trash2, X } from "lucide-react";
import { groupByRecency } from "./chatModel";

export default function HistoryRail({ conversations, activeId, search, onSearch, onOpen, onDelete, onNew, onSettings, onClose, stats, providerCount }) {
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groupByRecency((conversations || []).filter((c) => !q || String(c.title || "").toLowerCase().includes(q)));
  }, [conversations, search]);

  return (
    <div className="aw-surface flex h-full w-full flex-col border-r">
      <div className="flex items-center gap-2 p-3">
        <button
          type="button"
          onClick={onNew}
          className="flex h-9 flex-1 items-center justify-center gap-2 rounded-lg text-sm font-medium text-white"
          style={{ background: "var(--aw-user)" }}
        >
          <Plus size={16} />New chat
        </button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close history" className="flex h-9 w-9 items-center justify-center rounded-lg aw-muted hover:bg-black/5 dark:hover:bg-white/10">
            <X size={18} />
          </button>
        )}
      </div>
      <div className="px-3 pb-2">
        <label className="aw-line flex h-9 items-center gap-2 rounded-lg border px-2.5 text-sm focus-within:border-[var(--aw-thread)]">
          <Search size={14} className="aw-muted" />
          <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="w-full border-0 bg-transparent text-sm outline-none placeholder:text-slate-400" />
        </label>
      </div>

      <nav className="aw-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Chat history">
        {groups.map((g) => (
          <section key={g.label} className="mb-3">
            <h3 className="px-2 pb-1 pt-2 text-xs font-medium aw-muted">{g.label}</h3>
            {g.items.map((c) => {
              const id = c.id || c.conversation_id;
              const selected = id === activeId;
              return (
                <div key={id} className={`group relative flex items-center rounded-lg ${selected ? "bg-black/[0.06] dark:bg-white/10" : "hover:bg-black/[0.04] dark:hover:bg-white/5"}`}>
                  <button type="button" onClick={() => onOpen(id)} aria-current={selected ? "true" : undefined} className="min-w-0 flex-1 truncate rounded-lg px-3 py-2 text-left text-sm">
                    {c.title || "New conversation"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => onDelete(id, c.title, e)}
                    aria-label={`Delete ${c.title || "conversation"}`}
                    className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md aw-muted opacity-0 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </section>
        ))}
        {!groups.length && (
          <p className="px-3 py-10 text-center text-sm aw-muted">{search ? "No chats match that search." : "Your conversations will appear here."}</p>
        )}
      </nav>

      <div className="aw-line border-t p-3">
        <div className="mb-2 flex items-center justify-between text-xs aw-muted">
          <span>{providerCount} provider{providerCount === 1 ? "" : "s"} connected</span>
          <span className="inline-flex items-center gap-1.5">
            <i className="h-1.5 w-1.5 rounded-full" style={{ background: (stats?.healthyAccounts ?? 0) > 0 ? "var(--aw-ok)" : "var(--aw-fail)" }} aria-hidden="true" />
            {stats?.healthyAccounts ?? 0} healthy
          </span>
        </div>
        <button type="button" onClick={onSettings} className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-sm aw-muted hover:bg-black/5 dark:hover:bg-white/10">
          <Settings size={15} />Providers and history
        </button>
      </div>
    </div>
  );
}
