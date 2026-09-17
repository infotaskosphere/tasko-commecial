import React from "react";
import { useDark } from "@/hooks/useDark";

/**
 * GifLoader — FULL-SCREEN loader.
 * Used ONLY for auth loading (before DashboardLayout mounts).
 * Do NOT use this as a Suspense fallback inside DashboardLayout —
 * use ContentLoader instead so the sidebar stays visible.
 */
export default function GifLoader() {
  const isDark = useDark();

  return (
    <div className={`taskosphere-loader taskosphere-loader--fullscreen ${isDark ? "is-dark" : ""}`}>
      <div className="taskosphere-loader__orb" aria-hidden="true" />
      <img className="taskosphere-loader__gif" src="/loader.gif" alt="Loading…" />
      <span className="taskosphere-loader__label">Preparing your workspace</span>
    </div>
  );
}

/**
 * ContentLoader — FULL-SCREEN route/page loader.
 * Used as the <Suspense> fallback during route transitions so the loader
 * is never trapped inside a page/card/container and shown as a half-page box.
 * The fullscreen class intentionally covers the entire viewport.
 */
export function ContentLoader() {
  const isDark = useDark();

  return (
    <div className={`taskosphere-loader taskosphere-loader--fullscreen ${isDark ? "is-dark" : ""}`}>
      <div className="taskosphere-loader__orb" aria-hidden="true" />
      <img className="taskosphere-loader__gif" src="/loader.gif" alt="Loading…" />
      <span className="taskosphere-loader__label">Loading page</span>
    </div>
  );
}

/**
 * MiniLoader — inline section loader.
 * Drop-in for small loading states inside a page section.
 */
export function MiniLoader({ height = 200 }) {
  return (
    <div className="taskosphere-loader taskosphere-loader--mini" style={{ height }}>
      <div className="taskosphere-loader__orb" aria-hidden="true" />
      <img className="taskosphere-loader__gif" src="/loader.gif" alt="" />
    </div>
  );
}
