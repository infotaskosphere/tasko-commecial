import React, { Suspense } from "react";
import { Outlet } from "react-router-dom";
import { ContentLoader } from "@/components/ui/GifLoader.jsx";

/**
 * Shared route boundary for the commercial application.
 *
 * Page navigation must never depend on a motion wrapper reaching an animated
 * opacity state. The old Framer Motion route transition could leave lazy
 * pages visually transparent while their data requests were still in flight
 * or failed. Keep routing synchronous and let Suspense own the single
 * application loading experience.
 */
export function PageTransition({ children, standalone = false }) {
  return <div className={`taskosphere-page-transition${standalone ? " taskosphere-page-transition--standalone" : ""}`}>{children}</div>;
}

export function AnimatedOutlet() {
  return (
    <Suspense fallback={<ContentLoader />}>
      <Outlet />
    </Suspense>
  );
}
