import React from "react";
import { formatDuration, normaliseTrail } from "./chatModel";
import { pname } from "./shared";

function Row({ label, children }) {
  if (children == null || children === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="aw-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** Run details for the selected answer, plus how much AIWeave has done for this company. */
export default function Inspector({ message, stats }) {
  const meta = message?.meta || {};
  const trail = normaliseTrail(meta.fallbackTrail);
  return (
    <div className="aw-surface flex h-full flex-col border-l">
      <div className="aw-line border-b px-4 py-3.5">
        <h2 className="text-sm font-semibold">How this was answered</h2>
      </div>
      <div className="aw-scroll min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {message && message.status === "done" ? (
          <>
            <dl className="aw-line divide-y">
              <Row label="Provider">{meta.providerName}</Row>
              <Row label="Model">{meta.modelName}</Row>
              <Row label="Account">{meta.accountName}</Row>
              <Row label="Time">{meta.latencyMs ? formatDuration(meta.latencyMs) : ""}</Row>
              <Row label="Tokens">{meta.tokens ? Number(meta.tokens).toLocaleString() : ""}</Row>
            </dl>
            {trail.length > 0 && (
              <ol className="mt-4 space-y-2.5 text-xs">
                {trail.map((t, i) => (
                  <li key={i} className="aw-line border-l-2 pl-3" style={{ borderColor: "var(--aw-fail)" }}>
                    <div className="font-medium">{pname(t.provider)}{t.model ? ` · ${t.model}` : ""}</div>
                    <div className="aw-muted">{t.reason || t.status}{t.latencyMs ? ` (${formatDuration(t.latencyMs)})` : ""}</div>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-5 text-xs aw-muted">Select any answer in the conversation to see its details.</p>
          </>
        ) : (
          <p className="py-6 text-sm leading-6 aw-muted">Send a message to see which provider and model answered, how long it took, and whether AIWeave had to switch.</p>
        )}
      </div>
      {stats && (
        <dl className="aw-line border-t px-4 py-2">
          <Row label="Answers so far">{Number(stats.totalExecutionsCount || 0).toLocaleString()}</Row>
          <Row label="Switched provider">{Number(stats.fallbackExecutions || 0).toLocaleString()}</Row>
          <Row label="Healthy accounts">{stats.healthyAccounts ?? 0} of {stats.totalAccounts ?? 0}</Row>
        </dl>
      )}
    </div>
  );
}
