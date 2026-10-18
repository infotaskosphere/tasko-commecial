import React from "react";

/**
 * The AIWeave logo mark. This is the product's own icon (the same file the app shell uses for
 * AIWeave in module-branding.js), never a redrawn version of it. It is a full-colour picture on a
 * white ground, so it is shown as a small white tile that reads the same in light and dark mode.
 */
export const AIWEAVE_ICON = "/aiweave-icon.png";

export default function WeaveMark({ size = 20, className = "", tile = false }) {
  const img = (
    <img
      src={AIWEAVE_ICON}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className="block select-none object-contain"
      style={{ width: size, height: size }}
    />
  );
  if (!tile) return <span className={`inline-flex shrink-0 ${className}`} aria-hidden="true">{img}</span>;
  const pad = Math.max(3, Math.round(size * 0.14));
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-black/10 ${className}`}
      style={{ padding: pad }}
      aria-hidden="true"
    >
      {img}
    </span>
  );
}
