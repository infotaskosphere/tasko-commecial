import React from "react";
import { Code2, FileSearch, PenLine, Scale } from "lucide-react";
import WeaveMark from "./WeaveMark";

const STARTERS = [
  { icon: FileSearch, text: "Summarise this notice and list every deadline it mentions", hint: "Attach the PDF first", mode: "document_analysis" },
  { icon: PenLine, text: "Draft a polite reminder asking a client for pending TDS documents", hint: "Writing", mode: "chat" },
  { icon: Scale, text: "Explain the difference between Section 16 and Section 17(5) input tax credit, with examples", hint: "Tax", mode: "reasoning" },
  { icon: Code2, text: "Write a Python script that merges monthly ledger Excel files into one sheet", hint: "Code", mode: "coding" },
];

export default function EmptyState({ ready, providerCount, onPick }) {
  return (
    // `my-auto` centres the block while there is room and lets it scroll from its top edge when there
    // is not (justify-center would push the heading above the scroll area on short windows).
    <div className="flex min-h-full flex-col">
      <div className="mx-auto my-auto w-full max-w-3xl px-1 py-5">
        <WeaveMark size={36} tile className="mb-3" />
        <h2 className="text-[26px] font-semibold leading-tight tracking-tight tablet:text-[28px]">What are you working on?</h2>
        <p className="mt-2 max-w-xl text-[15px] leading-6 aw-muted">
          {ready
            ? `Ask a question or attach documents. AIWeave picks from ${providerCount} connected provider${providerCount === 1 ? "" : "s"} and moves to another one if a model is busy.`
            : "No AI provider is connected yet. Ask your administrator to add provider keys on the server, then come back."}
        </p>

        <ul className="mt-5 grid grid-cols-1 gap-2.5 tablet:grid-cols-2">
          {STARTERS.map(({ icon: Icon, ...s }) => (
            <li key={s.text} className="flex">
              <button type="button" onClick={() => onPick(s)} className="aw-card">
                <span className="aw-card-icon"><Icon size={16} /></span>
                <span className="text-sm font-medium leading-5">{s.text}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
