import React from "react";

/** The AIWeave mark: three strands crossing once, drawn with the thread colour. */
export default function WeaveMark({ size = 20, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path d="M3 7c4.5 0 4.5 10 9 10s4.5-10 9-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M3 17c4.5 0 4.5-10 9-10s4.5 10 9 10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity=".45" />
    </svg>
  );
}
