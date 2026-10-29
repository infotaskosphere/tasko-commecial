// Taskosphere Desktop Agent: the small Windows program that reads DSC tokens
// and reports desktop activity. It listens on 127.0.0.1:7432 on the user's PC.

export const AGENT_URL = (import.meta.env?.VITE_DSC_AGENT_URL || 'http://127.0.0.1:7432').replace(/\/+$/, '');

const REPO = 'infotaskosphere/tasko-commecial';
export const AGENT_DOWNLOAD_URL =
  import.meta.env?.VITE_AGENT_DOWNLOAD_URL ||
  `https://github.com/${REPO}/releases/latest/download/TaskosphereAgentSetup.exe`;

// Set once the user has installed/connected the agent on this browser. Only
// then does the app contact 127.0.0.1 automatically (at login): probing it for
// everyone would make Chrome ask every user for local-network permission.
const ENABLED_KEY = 'taskosphere_desktop_agent_enabled';

export function agentEnabledInThisBrowser() {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

export function setAgentEnabledInThisBrowser(enabled) {
  try {
    if (enabled) localStorage.setItem(ENABLED_KEY, '1');
    else localStorage.removeItem(ENABLED_KEY);
  } catch { /* storage unavailable */ }
}

/** Agent /health, or null when it is not running / not reachable. */
export async function getAgentHealth(timeoutMs = 2500) {
  try {
    const res = await fetch(`${AGENT_URL}/health`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.status === 'ok' ? data : null;
  } catch {
    return null;
  }
}

/** Give the agent this user's login so it can report to the backend. */
export async function connectAgent(token, userId) {
  const res = await fetch(`${AGENT_URL}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, user_id: userId }),
    signal: AbortSignal.timeout(5000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || `Agent answered ${res.status}`);
  setAgentEnabledInThisBrowser(true);
  return data;
}

/** Clear the agent's login (on logout). Never throws. */
export async function disconnectAgent() {
  try {
    await fetch(`${AGENT_URL}/api/logout`, { method: 'POST', signal: AbortSignal.timeout(2000) });
  } catch { /* agent not running */ }
}

/** Latest published agent version, e.g. "4.1.0", or null. */
export async function getLatestAgentVersion() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const tag = String(data.tag_name || '');
    return tag.startsWith('agent-v') ? tag.slice('agent-v'.length) : null;
  } catch {
    return null;
  }
}

export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
