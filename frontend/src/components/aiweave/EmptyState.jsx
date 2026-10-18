import React from "react";
import WeaveMark from "./WeaveMark";

const STARTERS = [
  { text: "Summarise this notice and list every deadline it mentions", hint: "Attach the PDF first", mode: "document_analysis" },
  { text: "Draft a polite reminder asking a client for pending TDS documents", hint: "Writing", mode: "chat" },
  { text: "Explain the difference between Section 16 and Section 17(5) input tax credit, with examples", hint: "Tax", mode: "reasoning" },
  { text: "Write a Python script that merges monthly ledger Excel files into one sheet", hint: "Code", mode: "coding" },
];

export default function EmptyState({ ready, providerCount, onPick }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-1 py-10">
      <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl" style={{ background: "var(--aw-thread)", color: "#fff" }}>
        <WeaveMark size={26} />
      </div>
      <h2 className="text-[28px] font-semibold leading-tight tracking-tight">What are you working on?</h2>
      <p className="mt-2 max-w-lg text-[15px] leading-6 aw-muted">
        {ready
          ? `Ask a question or attach documents. AIWeave picks from ${providerCount} connected provider${providerCount === 1 ? "" : "s"} and moves to another one if a model is busy.`
          : "No AI provider is connected yet. Ask your administrator to add provider keys on the server, then come back."}
      </p>

      <ul className="aw-line mt-8 divide-y border-y" style={{ borderColor: "var(--aw-line)" }}>
        {STARTERS.map((s) => (
          <li key={s.text}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="group flex w-full items-baseline justify-between gap-4 py-3.5 text-left"
            >
              <span className="text-[15px] leading-6 group-hover:underline group-hover:underline-offset-4">{s.text}</span>
              <span className="shrink-0 text-xs aw-muted">{s.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
