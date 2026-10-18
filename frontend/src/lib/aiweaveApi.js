/**
 * AIWeave API Client Layer
 * Uses the application's authenticated Axios client and the real backend.
 * Mutations never fall back to local browser state.
 */
import api, { BASE_URL, getToken } from "./api";
import { parseSSE, decodeEvent } from "./sse";

export const listProviders = async () => (await api.get("/aiweave/providers")).data;
export const listAccounts = async () => (await api.get("/aiweave/accounts")).data;
export const connectAccount = async (payload) => (await api.post("/aiweave/accounts/connect", payload)).data;
export const testAccount = async (accountId) => (await api.post(`/aiweave/accounts/${encodeURIComponent(accountId)}/test`)).data;
export const toggleAccount = async (accountId) => (await api.post(`/aiweave/accounts/${encodeURIComponent(accountId)}/toggle`)).data;
export const updateAccount = async (accountId, updates) => (await api.patch(`/aiweave/accounts/${encodeURIComponent(accountId)}`, updates)).data;
export const deleteAccount = async (accountId) => (await api.delete(`/aiweave/accounts/${encodeURIComponent(accountId)}`)).data;
export const getModels = async () => (await api.get("/aiweave/models")).data;
export const getRoutingConfig = async () => (await api.get("/aiweave/routing-config")).data;
export const updateRoutingConfig = async (payload) => (await api.put("/aiweave/routing-config", payload)).data;
export const getExecutionHistory = async () => (await api.get("/aiweave/executions")).data;
export const executeTask = async (payload, config = {}) => (await api.post("/aiweave/execute", payload, config)).data;
export const executeOmni = async (payload, config = {}) => (await api.post("/aiweave/omni", payload, config)).data;
/**
 * Streams an Omni answer. `onChunk` receives each event object as it arrives
 * (start, chunk, reasoning, fallback, done, error). Resolves when the stream
 * ends; rejects with an Error carrying `.status` (and `.retryAfter` for 429)
 * when the request is refused before any answer starts. Pass an AbortSignal to stop.
 */
export async function streamOmni(payload, { signal, onChunk } = {}) {
  const token = getToken();
  let response;
  try {
    response = await fetch(`${BASE_URL}/aiweave/omni`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...payload, stream: true }),
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    const err = new Error("Could not reach the server. Check your connection and try again.");
    err.status = 0;
    throw err;
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body?.detail === "string" ? body.detail : Array.isArray(body?.detail) ? body.detail.map((d) => d?.msg).filter(Boolean).join("; ") : "";
    } catch { /* body was not JSON */ }
    const err = new Error(detail || `Request failed (${response.status})`);
    err.status = response.status;
    err.detail = detail;
    const wait = parseInt(response.headers.get("Retry-After") || "", 10);
    if (wait > 0) err.retryAfter = wait;
    throw err;
  }

  if (!response.body) {
    // Very old browsers: no streaming body, read it whole.
    const { events } = parseSSE((await response.text()) + "\n\n");
    for (const data of events) { const c = decodeEvent(data); if (c) onChunk?.(c); }
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let rest = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const parsed = parseSSE(rest + decoder.decode(value, { stream: true }));
      rest = parsed.rest;
      for (const data of parsed.events) {
        const chunk = decodeEvent(data);
        if (chunk) onChunk?.(chunk);
      }
    }
    const tail = parseSSE(rest + decoder.decode() + "\n\n");
    for (const data of tail.events) { const c = decodeEvent(data); if (c) onChunk?.(c); }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export const getStats = async () => (await api.get("/aiweave/stats")).data;

export const listConversations = async () => (await api.get("/aiweave/conversations")).data;
export const createConversation = async (payload = {}) => (await api.post("/aiweave/conversations", payload)).data;
export const getConversation = async (conversationId) => (await api.get(`/aiweave/conversations/${encodeURIComponent(conversationId)}`)).data;
export const deleteConversation = async (conversationId) => (await api.delete(`/aiweave/conversations/${encodeURIComponent(conversationId)}`)).data;

export default {
  listProviders, listAccounts, connectAccount, testAccount, toggleAccount,
  updateAccount, deleteAccount, getModels, getRoutingConfig, updateRoutingConfig,
  getExecutionHistory, executeTask, executeOmni, streamOmni, getStats, listConversations, createConversation,
  getConversation, deleteConversation,
};

