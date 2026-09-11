// ─────────────────────────────────────────────────────────────────────────────
// Shared Tasks-page data cache + prefetcher.
//
// Both Dashboard.jsx and Tasks.jsx read/write the SAME sessionStorage entry, so
// warming it from the Dashboard (on idle, and again on hover/focus of the
// "+ New Task" button) means the Tasks page — and therefore the New Task form's
// assignee / client dropdowns — render fully populated on the very first paint
// instead of loading after the dialog is already on screen.
// ─────────────────────────────────────────────────────────────────────────────
import api from './api';

export const TASKS_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
export const TASKS_CACHE_KEY = 'tasks_cache_v1';

export const getTasksCache = () => {
  try {
    const raw = sessionStorage.getItem(TASKS_CACHE_KEY);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > TASKS_CACHE_TTL) {
      sessionStorage.removeItem(TASKS_CACHE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
};

export const setTasksCache = (data) => {
  try {
    sessionStorage.setItem(TASKS_CACHE_KEY, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    /* quota / private mode — caching is best-effort only */
  }
};

const fetchAllClients = async () => {
  const PAGE = 200;
  let page = 1;
  let all = [];
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const res = await api.get('/clients', { params: { page, page_size: PAGE } });
      const batch = Array.isArray(res.data) ? res.data : [];
      all = [...all, ...batch];
      if (batch.length < PAGE) break;
      page++;
    }
  } catch {
    return all;
  }
  return all;
};

const safeGet = async (endpoint) => {
  try {
    const res = await api.get(endpoint);
    return res.data;
  } catch {
    return null;
  }
};

// In-flight de-duplication: hovering the button, focusing it and the idle
// callback can all fire within the same second — only one network round-trip
// should ever happen.
let inFlight = null;

/**
 * Warm the Tasks-page cache (tasks, users, clients, performance rankings).
 * Resolves to the cached payload, or null if nothing usable came back.
 * Safe to call as often as you like: it no-ops while the cache is fresh.
 */
export const prefetchTasksData = ({ force = false } = {}) => {
  if (!force) {
    const cached = getTasksCache();
    if (cached) return Promise.resolve(cached);
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    const [tasksResult, usersResult, clientsResult, rankResult] = await Promise.allSettled([
      safeGet('/tasks'),
      safeGet('/users'),
      fetchAllClients(),
      safeGet('/reports/performance-rankings?period=monthly'),
    ]);

    const pick = (r) => (r.status === 'fulfilled' && Array.isArray(r.value) ? r.value : []);
    const tasks = pick(tasksResult);
    const users = pick(usersResult);
    const clients = pick(clientsResult);
    const rankData = pick(rankResult);

    const payload = { tasks, users, clients, rankings: rankData };
    // Only persist when we actually have the dropdown data the form needs —
    // an empty payload would otherwise mask a real load on the Tasks page.
    if (users.length || clients.length || tasks.length) setTasksCache(payload);
    return payload;
  })();

  try {
    return inFlight;
  } finally {
    inFlight.finally(() => {
      inFlight = null;
    });
  }
};

export default prefetchTasksData;
