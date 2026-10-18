/**
 * Pure helpers for the AIWeave chat: shaping stored and streamed messages for the
 * screen, and deciding what history is sent back to the model.
 */
export const MAX_CONTEXT_MESSAGES = 30;
const MAX_CONTEXT_MESSAGE_CHARS = 24000;
const MAX_CONTEXT_TOTAL_CHARS = 300000;

export const SYSTEM_INSTRUCTION = [
  "You are AIWeave, the AI assistant inside Taskosphere, used by accounting, compliance and legal-practice teams in India.",
  "Answer directly and concisely, in Markdown: short paragraphs, lists for steps, tables for comparisons, fenced code blocks for code.",
  "Do not invent section numbers, dates, rates or amounts. If you are not sure, say what is uncertain and what to verify.",
  "When document text is provided, rely only on it for facts about the document and say when it does not contain the answer.",
].join(" ");

export function normaliseTrail(trail) {
  return (Array.isArray(trail) ? trail : []).map((t) => ({
    provider: t.provider || t.from_provider || "",
    model: t.model || t.from_model || "",
    status: t.status || "FAILED",
    reason: t.reason || "",
    latencyMs: t.latencyMs ?? t.latency_ms ?? null,
  }));
}

/** A message as stored by the backend -> a message as the chat screen holds it. */
export function fromStored(m, index = 0) {
  const role = m?.role === "assistant" ? "assistant" : m?.role === "error" ? "error" : "user";
  const base = {
    id: m?.id || `m-${index}`,
    role,
    content: String(m?.content ?? ""),
    created_at: m?.created_at,
    status: "done",
  };
  if (role === "user") return { ...base, attachments: Array.isArray(m?.attachments) ? m.attachments : [] };
  return {
    ...base,
    meta: {
      provider: m?.provider || "",
      providerName: m?.providerName || m?.provider_name || "",
      modelName: m?.modelName || m?.model_name || m?.model || "",
      accountName: m?.accountName || m?.account_name || "",
      fallbackTrail: normaliseTrail(m?.fallbackTrail || m?.fallback_trail),
      tokens: m?.tokens ?? null,
      latencyMs: m?.latencyMs ?? m?.latency_ms ?? null,
    },
  };
}

/** What to send as conversation history: finished turns only, newest 30, bounded in size. */
export function buildContext(messages) {
  const usable = (messages || []).filter(
    (m) => (m.role === "user" || (m.role === "assistant" && m.status !== "pending" && m.status !== "error")) && String(m.content || "").trim()
  );
  let picked = usable.slice(-MAX_CONTEXT_MESSAGES).map((m) => ({
    role: m.role,
    content: String(m.content).slice(0, MAX_CONTEXT_MESSAGE_CHARS),
  }));
  let total = picked.reduce((n, m) => n + m.content.length, 0);
  while (picked.length > 1 && total > MAX_CONTEXT_TOTAL_CHARS) {
    total -= picked[0].content.length;
    picked = picked.slice(1);
  }
  return picked;
}

export const titleFrom = (text) => String(text || "").replace(/\s+/g, " ").trim().slice(0, 80) || "New conversation";

/** Group conversations for the history rail by how recently they were used. */
export function groupByRecency(conversations, now = new Date()) {
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  const groups = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const c of conversations || []) {
    const t = Date.parse(c.updated_at || c.created_at || "");
    const bucket = Number.isNaN(t) ? 3 : t >= startOfDay ? 0 : t >= startOfDay - DAY ? 1 : t >= startOfDay - 7 * DAY ? 2 : 3;
    groups[bucket].items.push(c);
  }
  return groups.filter((g) => g.items.length);
}

export function formatDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return "";
  const n = Number(ms);
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
}

/** Reads the useful part of an HTTP/stream failure, with the retry hint when the limit was hit. */
export function describeFailure(err) {
  const status = err?.status ?? err?.response?.status;
  const detail = err?.response?.data?.detail || err?.detail || err?.message || "";
  if (status === 429) {
    const wait = err?.retryAfter ? ` Try again in ${err.retryAfter} s.` : "";
    return `${String(detail).replace(/\.$/, "") || "Usage limit reached"}.${wait}`;
  }
  if (status === 401) return "Your session has expired. Sign in again to continue.";
  if (status === 403) return "Your plan or role does not include AIWeave.";
  if (status === 503) return "No AI provider could answer just now. Try again in a minute, or ask your administrator to check provider keys.";
  return String(detail || "AIWeave could not complete this request.");
}
