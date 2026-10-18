import { useLayoutEffect, useState } from "react";

/**
 * Width of an element, kept current as it changes. The AIWeave panels depend on the space the page
 * is actually given (the app sidebar can be open or collapsed) rather than on the window width, so
 * they are chosen from this, not from viewport breakpoints.
 */
export default function useElementWidth(ref) {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const read = () => setWidth(Math.round(el.getBoundingClientRect().width));
    read();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", read);
      return () => window.removeEventListener("resize", read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

/** Minimum page widths (px) at which each panel sits beside the conversation instead of over it. */
export const RAIL_DOCK_AT = 720;
export const INSPECTOR_DOCK_AT = 1180;
