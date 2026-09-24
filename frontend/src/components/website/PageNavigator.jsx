import React, { useState } from "react";
import {
  FileText,
  Plus,
  MoreVertical,
  Home,
  Eye,
  EyeOff,
  Copy,
  Trash2,
  Edit2,
  FolderTree,
  Check,
  ChevronRight,
  Sparkles
} from "lucide-react";
import { PAGE_TEMPLATES } from "./studioTemplates";

export default function PageNavigator({
  pages = [],
  activePageId,
  onSelectPage,
  onAddPage,
  onDuplicatePage,
  onDeletePage,
  onRenamePage,
  onToggleVisibility,
  onSetHomepage,
  onOpenSectionLibrary,
  onOpenThemeCustomizer,
  onOpenHeaderEditor,
  onOpenFooterEditor,
}) {
  const [showAddModal, setShowAddModal] = useState(false);
  const [pageMenuOpen, setPageMenuOpen] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");

  const handleStartRename = (page) => {
    setRenamingId(page.id);
    setRenameValue(page.name);
    setPageMenuOpen(null);
  };

  const handleSaveRename = (pageId) => {
    if (renameValue.trim()) {
      onRenamePage(pageId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleCreateFromTemplate = (template) => {
    const newPage = {
      id: `page_${Date.now()}`,
      name: template.name === "Blank Page" ? "New Page" : template.name,
      slug: `/${template.name.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
      visible: true,
      sections: JSON.parse(JSON.stringify(template.sections || [])),
    };
    onAddPage(newPage);
    setShowAddModal(false);
  };

  return (
    <aside className="flex h-full w-72 flex-col border-r border-slate-200 bg-white shadow-sm select-none">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <FolderTree size={16} />
          </div>
          <div>
            <span className="text-xs font-black uppercase tracking-wider text-slate-800">Pages &amp; Menu</span>
            <p className="text-[10px] text-slate-400">{pages.length} page(s) created</p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowAddModal(true)}
          className="inline-flex items-center gap-1 rounded-xl bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white shadow-sm transition hover:bg-blue-700"
          title="Create a new page"
        >
          <Plus size={13} /> Add
        </button>
      </div>

      {/* Pages List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {pages.map((page, index) => {
          const isActive = page.id === activePageId;
          const isHome = index === 0 || page.id === "home";
          const isRenaming = renamingId === page.id;

          return (
            <div
              key={page.id}
              className={`group relative flex items-center justify-between rounded-xl p-2.5 transition ${
                isActive ? "bg-blue-50/80 text-blue-900 font-bold shadow-sm" : "hover:bg-slate-50 text-slate-700"
              }`}
              onClick={() => onSelectPage(page.id)}
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1 cursor-pointer">
                {isHome ? (
                  <Home size={15} className={isActive ? "text-blue-600" : "text-slate-400"} />
                ) : (
                  <FileText size={15} className={isActive ? "text-blue-600" : "text-slate-400"} />
                )}

                {isRenaming ? (
                  <input
                    type="text"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => handleSaveRename(page.id)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveRename(page.id)}
                    className="w-full rounded border border-blue-400 px-1 py-0.5 text-xs font-bold outline-none"
                    autoFocus
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="truncate text-xs font-semibold">{page.name}</span>
                )}

                {page.visible === false && (
                  <span className="rounded bg-slate-100 px-1 py-0.5 text-[9px] text-slate-400 font-normal">
                    Hidden
                  </span>
                )}
              </div>

              {/* Page Context Menu Button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPageMenuOpen(pageMenuOpen === page.id ? null : page.id);
                  }}
                  className="rounded-lg p-1 text-slate-400 opacity-60 hover:opacity-100 hover:bg-slate-200"
                >
                  <MoreVertical size={14} />
                </button>

                {pageMenuOpen === page.id && (
                  <div
                    className="absolute right-0 top-6 z-50 w-44 rounded-2xl border border-slate-100 bg-white p-1.5 shadow-xl text-xs"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => handleStartRename(page)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Edit2 size={13} /> Rename Page
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        onDuplicatePage(page.id);
                        setPageMenuOpen(null);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Copy size={13} /> Duplicate Page
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        onToggleVisibility(page.id);
                        setPageMenuOpen(null);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      {page.visible === false ? <Eye size={13} /> : <EyeOff size={13} />}
                      {page.visible === false ? "Show in Menu" : "Hide from Menu"}
                    </button>

                    {!isHome && (
                      <button
                        type="button"
                        onClick={() => {
                          onSetHomepage(page.id);
                          setPageMenuOpen(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        <Home size={13} /> Set as Homepage
                      </button>
                    )}

                    {!isHome && (
                      <button
                        type="button"
                        onClick={() => {
                          onDeletePage(page.id);
                          setPageMenuOpen(null);
                        }}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 font-semibold text-red-600 hover:bg-red-50"
                      >
                        <Trash2 size={13} /> Delete Page
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Global Quick Action links */}
      <div className="border-t border-slate-100 p-3 space-y-1 text-xs">
        <button
          type="button"
          onClick={onOpenSectionLibrary}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2 font-bold text-blue-600 hover:bg-blue-50 transition"
        >
          <span className="flex items-center gap-2">
            <Plus size={14} /> + Add Section
          </span>
          <ChevronRight size={14} />
        </button>

        <button
          type="button"
          onClick={onOpenHeaderEditor}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100 transition font-semibold"
        >
          <span>Website Header &amp; Menu</span>
          <ChevronRight size={14} className="text-slate-400" />
        </button>

        <button
          type="button"
          onClick={onOpenFooterEditor}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100 transition font-semibold"
        >
          <span>Footer &amp; Social Links</span>
          <ChevronRight size={14} className="text-slate-400" />
        </button>

        <button
          type="button"
          onClick={onOpenThemeCustomizer}
          className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-slate-700 hover:bg-slate-100 transition font-semibold"
        >
          <span className="flex items-center gap-2">
            <Sparkles size={14} className="text-amber-500" /> Theme &amp; Typography
          </span>
          <ChevronRight size={14} className="text-slate-400" />
        </button>
      </div>

      {/* Friendly Template Selector for New Page */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
          <div className="flex h-[80vh] max-h-[600px] w-full max-w-2xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
              <div>
                <h3 className="text-base font-black text-slate-900">Create a New Page</h3>
                <p className="text-xs text-slate-500">Pick a pre-made template or start with a clean blank canvas.</p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="rounded-lg border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              <div className="grid gap-3 sm:grid-cols-2">
                {PAGE_TEMPLATES.map((tmpl) => (
                  <div
                    key={tmpl.id}
                    onClick={() => handleCreateFromTemplate(tmpl)}
                    className="group flex cursor-pointer flex-col justify-between rounded-2xl border border-slate-200 p-4 transition hover:-translate-y-0.5 hover:border-blue-500 hover:shadow-md"
                  >
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-xs font-black text-slate-900 group-hover:text-blue-600">
                          {tmpl.name}
                        </span>
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold text-slate-500">
                          {tmpl.sections.length} section(s)
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 leading-relaxed">{tmpl.description}</p>
                    </div>

                    <div className="mt-4 pt-2 border-t border-slate-100 flex items-center justify-between text-xs font-bold text-blue-600">
                      <span>Use Template</span>
                      <ChevronRight size={14} className="transition group-hover:translate-x-1" />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
