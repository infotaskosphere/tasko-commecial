import React from "react";
import { formatDuration, normaliseTrail } from "./chatModel";
import { pname } from "./shared";

function Node({ provider, state, title }) {
  const letter = (pname(provider) || "?").trim().charAt(0).toUpperCase();
  return <span className="aw-node" data-state={state} title={title}>{letter}</span>;
}

/**
 * Shows the path an answer took: each provider that was tried and failed, then the one that answered.
 * While the answer is still arriving the last node pulses.
 */
export default function RouteStrip({ trail, meta, provider, live = false }) {
  const failed = normaliseTrail(trail);
  const finalProvider = provider || meta?.provider || "";
  const name = meta?.providerName || (finalProvider ? pname(finalProvider) : "");
  if (!failed.length && !name) return null;

  const parts = [];
  if (meta?.modelName) parts.push(meta.modelName);
  else if (name) parts.push(name);
  if (!live && meta?.latencyMs) parts.push(formatDuration(meta.latencyMs));
  if (!live && meta?.tokens) parts.push(`${Number(meta.tokens).toLocaleString()} tokens`);

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs aw-muted" role="group" aria-label="How this answer was routed">
      <span className="inline-flex items-center">
        {failed.map((t, i) => (
          <React.Fragment key={i}>
            <Node provider={t.provider} state="failed" title={`${pname(t.provider)}${t.model ? ` · ${t.model}` : ""} did not answer: ${t.reason || t.status}`} />
            <span className="aw-route-line" data-failed="true" />
          </React.Fragment>
        ))}
        <span className={live ? "aw-thread-live" : ""}>
          <Node provider={finalProvider || name} state="final" title={name ? `Answered by ${name}` : "Answering"} />
        </span>
      </span>
      <span>
        {parts.join(" · ")}
        {failed.length > 0 && (
          <span className="ml-2" style={{ color: "var(--aw-fail)" }}>
            switched {failed.length === 1 ? "once" : `${failed.length} times`}
          </span>
        )}
      </span>
    </div>
  );
}
