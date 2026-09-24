import React, { useState } from "react";
import {
  Menu,
  Plus,
  Trash2,
  MoveUp,
  MoveDown,
  Image as ImageIcon,
  Check,
  X
} from "lucide-react";

export default function HeaderEditorDrawer({
  builder,
  identity,
  onPatchHeader,
  onPatchIdentity,
  onOpenMediaLibrary,
  onClose,
}) {
  const h = builder.global?.header || {};
  const d = builder.global?.design || {};
  const pages = builder.pages || [];

  const [sticky, setSticky] = useState(h.sticky !== false);
  const [showLogin, setShowLogin] = useState(h.showLogin !== false);
  const [buttonText, setButtonText] = useState(h.buttonText || h.loginText || "Sign in");
  const [buttonHref, setButtonHref] = useState(h.buttonHref || "/login");
  const [menuItems, setMenuItems] = useState(() => {
    if (Array.isArray(h.items) && h.items.length > 0) return h.items;
    return pages.filter((p) => p.visible !== false).map((p) => ({
      label: p.name,
      destination: p.id === "home" ? "/" : `#${p.id}`,
    }));
  });

  const [siteName, setSiteName] = useState(identity?.site_name || "ONENEXA");
  const [tagline, setTagline] = useState(identity?.site_tagline || "One platform for modern business operations.");

  const handleAddMenuItem = () => {
    setMenuItems([...menuItems, { label: "New Link", destination: "/" }]);
  };

  const handleRemoveMenuItem = (index) => {
    setMenuItems(menuItems.filter((_, i) => i !== index));
  };

  const handleMoveMenuItem = (index, dir) => {
    const next = [...menuItems];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    const temp = next[index];
    next[index] = next[target];
    next[target] = temp;
    setMenuItems(next);
  };

  const handleSave = () => {
    onPatchHeader({
      sticky,
      showLogin,
      buttonText,
      buttonHref,
      items: menuItems,
    });
    onPatchIdentity({
      site_name: siteName,
      site_tagline: tagline,
    });
    onClose();
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
            <Menu size={16} />
          </div>
          <div>
            <h3 className="text-sm font-black text-slate-900">Website Header</h3>
            <p className="text-[11px] text-slate-400">Logo, title and navigation menu</p>
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

      {/* Settings Form */}
      <div className="flex-1 overflow-y-auto p-5 space-y-6">
        {/* Brand identity */}
        <div className="space-y-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Brand &amp; Logo
          </span>

          <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex h-12 w-20 items-center justify-center rounded-xl bg-white p-1 shadow-sm">
              <img
                src={identity?.logo_url || "/onenexa-logo.png"}
                alt=""
                className="max-h-9 max-w-full object-contain"
              />
            </div>
            <button
              type="button"
              onClick={() => onOpenMediaLibrary("header_logo")}
              className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-100"
            >
              Change Logo
            </button>
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700">Website Name</label>
            <input
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold outline-none focus:border-blue-500"
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-slate-700">Tagline (optional)</label>
            <input
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-xs outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Menu Items */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Navigation Menu Links
            </span>
            <button
              type="button"
              onClick={handleAddMenuItem}
              className="inline-flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700"
            >
              <Plus size={13} /> Add Menu Item
            </button>
          </div>

          <div className="space-y-2">
            {menuItems.map((item, idx) => (
              <div
                key={idx}
                className="rounded-xl border border-slate-200 bg-white p-3 space-y-2 shadow-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <input
                    type="text"
                    value={item.label}
                    onChange={(e) => {
                      const updated = [...menuItems];
                      updated[idx].label = e.target.value;
                      setMenuItems(updated);
                    }}
                    placeholder="Menu label"
                    className="flex-1 rounded-lg border border-slate-200 px-2 py-1 text-xs font-semibold outline-none"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => handleMoveMenuItem(idx, -1)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                    >
                      <MoveUp size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={idx === menuItems.length - 1}
                      onClick={() => handleMoveMenuItem(idx, 1)}
                      className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30"
                    >
                      <MoveDown size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRemoveMenuItem(idx)}
                      className="rounded p-1 text-red-500 hover:bg-red-50"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-slate-400 font-bold uppercase">Destination:</span>
                  <select
                    value={item.destination}
                    onChange={(e) => {
                      const updated = [...menuItems];
                      updated[idx].destination = e.target.value;
                      setMenuItems(updated);
                    }}
                    className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs outline-none"
                  >
                    {pages.map((p) => (
                      <option key={p.id} value={p.id === "home" ? "/" : `#${p.id}`}>
                        {p.name} Page
                      </option>
                    ))}
                    <option value="#features">Platform Features Section</option>
                    <option value="#pricing">Pricing Section</option>
                    <option value="#contact">Contact Form Section</option>
                    <option value="/login">Sign In Page</option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Action Button */}
        <div className="space-y-3">
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">
            Header Button
          </span>

          <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={showLogin}
              onChange={(e) => setShowLogin(e.target.checked)}
              className="rounded"
            />
            Show header action button
          </label>

          {showLogin && (
            <div className="space-y-2 pt-1">
              <div>
                <label className="block text-[11px] text-slate-500">Button Label</label>
                <input
                  type="text"
                  value={buttonText}
                  onChange={(e) => setButtonText(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-500">Button Link</label>
                <input
                  type="text"
                  value={buttonHref}
                  onChange={(e) => setButtonHref(e.target.value)}
                  className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-1.5 text-xs outline-none"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer action */}
      <div className="border-t border-slate-100 p-4">
        <button
          type="button"
          onClick={handleSave}
          className="w-full rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white shadow-md hover:bg-blue-700"
        >
          Save Header
        </button>
      </div>
    </div>
  );
}
