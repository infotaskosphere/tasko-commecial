import React from "react";
import { PROVIDERS } from "@/lib/aiweaveConstants";

export const pname = (id) =>
  PROVIDERS.find((p) => p.id === id)?.shortName || PROVIDERS.find((p) => p.id === id)?.name || id || "AI";

export const fmt = (v) => {
  try { return v ? new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : ""; } catch { return ""; }
};

export function Bubble({ children, tone = "" }) {
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-medium ${tone}`}>{children}</span>;
}

export const ACCEPTED = ".pdf,.xlsx,.xls,.xlsm,.csv,.jpg,.jpeg,.png,.webp,.gif";
export const MAX_DOCS = 25;
