import { useLayoutEffect } from "react";

/**
 * Makes the page fill the app's content area edge to edge.
 *
 * The app puts every page inside a scrolling <main> with padding and a fixed height. A workspace like
 * this one should touch the sidebar and the header instead of floating in that padding, so this reads the
 * real padding and height from that element (rather than assuming numbers that the app's style sheets can
 * change) and hands them to the page as CSS variables. Without such an element nothing is set and the
 * stylesheet's fallback applies.
 */
export default function useShellFit(ref) {
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement?.closest("main");
    if (!el || !host) return undefined;

    const apply = () => {
      const cs = getComputedStyle(host);
      const px = (v) => `${Math.max(0, parseFloat(v) || 0)}px`;
      el.style.setProperty("--aw-pt", px(cs.paddingTop));
      el.style.setProperty("--aw-pr", px(cs.paddingRight));
      el.style.setProperty("--aw-pb", px(cs.paddingBottom));
      el.style.setProperty("--aw-pl", px(cs.paddingLeft));
      // clientHeight includes the padding that the negative margins above cancel out
      el.style.setProperty("--aw-fit-h", `${host.clientHeight}px`);
    };
    apply();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(apply) : null;
    ro?.observe(host);
    window.addEventListener("resize", apply);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, [ref]);
}
