import React, { useMemo } from "react";
import { Plus, Search, Settings, Trash2, X } from "lucide-react";
import { groupByRecency } from "./chatModel";

export default function HistoryRail({ conversations, activeId, search, onSearch, onOpen, onDelete, onNew, onSettings, onClose, stats, providerCount }) {
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return groupByRecency((conversations || []).filter((c) => !q || String(c.title || "").toLowerCase().includes(q)));
  }, [conversations, search]);
  const healthy = stats?.healthyAccounts ?? 0;

  return (
    <div className="aw-panel flex h-full w-full flex-col border-r aw-line">
      <div className="flex items-center gap-2 p-3">
        <button type="button" onClick={onNew} className="aw-btn-primary flex h-10 flex-1 items-center justify-center gap-2 text-sm font-medium">
          <Plus size={16} />New chat
        </button>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close history" className="aw-iconbtn h-10 w-10">
            <X size={18} />
          </button>
        )}
      </div>
      <div className="px-3 pb-3">
        <label className="aw-line flex h-9 items-center gap-2 border px-2.5 text-sm focus-within:border-[var(--aw-thread)]">
          <Search size={14} className="aw-muted shrink-0" />
          <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="w-full min-w-0 border-0 bg-transparent text-sm outline-none placeholder:text-slate-400" />
        </label>
      </div>

      <nav className="aw-scroll min-h-0 flex-1 overflow-y-auto pb-2" aria-label="Chat history">
        {groups.map((g) => (
          <section key={g.label} className="mb-2">
            <h3 className="px-4 pb-1 pt-2 text-xs font-medium aw-muted">{g.label}</h3>
            {g.items.map((c) => {
              const id = c.id || c.conversation_id;
              const selected = id === activeId;
              return (
                <div key={id} className="aw-row group" data-active={selected}>
                  <button type="button" onClick={() => onOpen(id)} aria-current={selected ? "true" : undefined} className="aw-row-title min-w-0 flex-1 truncate py-2 pl-4 pr-2 text-left text-sm">
                    {c.title || "New conversation"}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => onDelete(id, c.title, e)}
                    aria-label={`Delete ${c.title || "conversation"}`}
                    className="aw-iconbtn mr-1 h-7 w-7 shrink-0 opacity-0 hover:text-red-600 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </section>
        ))}
        {!groups.length && (
          <p className="px-4 py-10 text-center text-sm aw-muted">{search ? "No chats match that search." : "Your conversations will appear here."}</p>
        )}
      </nav>

      <div className="aw-line border-t px-4 py-3">
        <div className="mb-2 flex items-center justify-between text-xs aw-muted">
          <span>{providerCount} provider{providerCount === 1 ? "" : "s"} connected</span>
          <span className="inline-flex items-center gap-1.5">
            <i data-status-dot className="h-1.5 w-1.5 rounded-full" style={{ background: healthy > 0 ? "var(--aw-ok)" : "var(--aw-fail)" }} aria-hidden="true" />
            {healthy} healthy
          </span>
        </div>
        <button type="button" onClick={onSettings} className="-mx-2 flex h-9 w-[calc(100%+1rem)] items-center gap-2 px-2 text-sm aw-muted hover:bg-[var(--aw-hover)]">
          <Settings size={15} />Providers and history
        </button>
      </div>
    </div>
  );
}
