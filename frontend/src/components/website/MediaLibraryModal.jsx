import React, { useState } from "react";
import {
  Upload,
  Image as ImageIcon,
  Check,
  Trash2,
  Search,
  ExternalLink,
  Layers,
  X
} from "lucide-react";
import { toast } from "sonner";
import { STOCK_LIBRARY_MEDIA } from "./studioTemplates";

export default function MediaLibraryModal({
  currentValue = "",
  onSelectImage,
  onClose,
  customMedia = [],
  onAddCustomMedia,
  onDeleteCustomMedia,
}) {
  const [tab, setTab] = useState("library"); // 'library' | 'upload' | 'url'
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [directUrl, setDirectUrl] = useState(currentValue || "");

  // Combine default stock photos and logos with any uploaded items
  const allMedia = [...customMedia, ...STOCK_LIBRARY_MEDIA];

  const filteredMedia = allMedia.filter((item) => {
    if (category !== "All" && item.category !== category) return false;
    if (search.trim()) {
      return (item.title || "").toLowerCase().includes(search.toLowerCase().trim());
    }
    return true;
  });

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Please choose a valid image file (PNG, JPG, SVG, WebP).");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image file is too large (maximum 5MB).");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = String(reader.result);
      const newMedia = {
        id: `med_${Date.now()}`,
        title: file.name.replace(/\.[^/.]+$/, ""),
        category: "Uploads",
        url: dataUri,
      };
      if (onAddCustomMedia) {
        onAddCustomMedia(newMedia);
      }
      onSelectImage(dataUri);
      toast.success("Image uploaded and selected!");
      onClose();
    };
    reader.readAsDataURL(file);
  };

  const handleApplyUrl = () => {
    if (!directUrl.trim()) {
      toast.error("Please enter a valid image address");
      return;
    }
    onSelectImage(directUrl.trim());
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="flex h-[88vh] max-h-[700px] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
              <ImageIcon size={20} />
            </div>
            <div>
              <h2 className="text-base font-black text-slate-900">Choose or Upload an Image</h2>
              <p className="text-xs text-slate-500">Pick from brand logos, professional royalty-free photos, or upload your own.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 p-2 text-slate-400 hover:bg-slate-50"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab selection */}
        <div className="flex border-b border-slate-100 bg-slate-50 px-6">
          <button
            type="button"
            onClick={() => setTab("library")}
            className={`border-b-2 py-3 px-4 text-xs font-bold transition ${
              tab === "library"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            Media Library &amp; Logos
          </button>
          <button
            type="button"
            onClick={() => setTab("upload")}
            className={`border-b-2 py-3 px-4 text-xs font-bold transition ${
              tab === "upload"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            Upload From Device
          </button>
          <button
            type="button"
            onClick={() => setTab("url")}
            className={`border-b-2 py-3 px-4 text-xs font-bold transition ${
              tab === "url"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-slate-500 hover:text-slate-900"
            }`}
          >
            Paste Web Link
          </button>
        </div>

        {/* Tab contents */}
        {tab === "library" && (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex flex-col gap-3 border-b border-slate-100 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-1.5 overflow-x-auto">
                {["All", "Logos", "Images", "Uploads"].map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategory(cat)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
                      category === cat ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="relative w-full sm:w-64">
                <Search size={14} className="absolute left-3 top-2.5 text-slate-400" />
                <input
                  type="text"
                  placeholder="Search photos & logos…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
                {filteredMedia.map((item) => {
                  const isSelected = currentValue === item.url;
                  return (
                    <div
                      key={item.id || item.url}
                      onClick={() => {
                        onSelectImage(item.url);
                        onClose();
                      }}
                      className={`group relative flex cursor-pointer flex-col overflow-hidden rounded-2xl border bg-white p-2 shadow-sm transition hover:border-blue-500 hover:shadow-md ${
                        isSelected ? "border-2 border-blue-600 ring-2 ring-blue-500/20" : "border-slate-200"
                      }`}
                    >
                      <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-xl bg-slate-50 p-2">
                        <img
                          src={item.url}
                          alt={item.title}
                          className="h-full w-full object-contain transition group-hover:scale-105"
                          loading="lazy"
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-between px-1">
                        <span className="truncate text-xs font-bold text-slate-800">{item.title}</span>
                        {isSelected && <Check size={14} className="text-blue-600 shrink-0" />}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {tab === "upload" && (
          <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-blue-50 text-blue-600">
              <Upload size={28} />
            </div>
            <h3 className="mt-4 text-base font-bold text-slate-900">Upload an image file</h3>
            <p className="mt-1 max-w-sm text-xs text-slate-500">
              Supports PNG, JPG, JPEG, SVG or WebP formats up to 5MB.
            </p>
            <label className="mt-6 inline-flex cursor-pointer items-center gap-2 rounded-xl bg-blue-600 px-5 py-3 text-xs font-bold text-white shadow-md transition hover:bg-blue-700">
              <Upload size={15} />
              Browse From Computer / Phone
              <input type="file" accept="image/*" className="hidden" onChange={handleFileUpload} />
            </label>
          </div>
        )}

        {tab === "url" && (
          <div className="flex flex-1 flex-col items-center justify-center p-8">
            <div className="w-full max-w-md space-y-4">
              <label className="block text-left">
                <span className="text-xs font-bold text-slate-700">Image Web Address</span>
                <input
                  type="url"
                  placeholder="https://example.com/photo.jpg"
                  value={directUrl}
                  onChange={(e) => setDirectUrl(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-xs outline-none focus:border-blue-500"
                />
              </label>
              {directUrl && (
                <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50 p-2">
                  <img src={directUrl} alt="Preview" className="max-h-36 w-full object-contain" />
                </div>
              )}
              <button
                type="button"
                onClick={handleApplyUrl}
                className="w-full rounded-xl bg-blue-600 py-2.5 text-xs font-bold text-white shadow hover:bg-blue-700"
              >
                Use this image
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
