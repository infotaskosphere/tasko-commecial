/**
 * Read cache for slow, rarely-changing GET requests.
 *
 * Reports and AI summaries are recomputed on the server from the whole ledger, so asking for them
 * again a few seconds later (opening Finix after the Dashboard, switching tabs, going back to a
 * page) only repeats work. This sits underneath axios as an adapter wrapper, so no page has to
 * change:
 *   - only paths on the allow-list are cached, only successful JSON answers, never anything else
 *   - identical requests that are already in flight share one network call
 *   - any write (POST/PUT/PATCH/DELETE) empties the cache, except background noise such as
 *     activity logging, so a report is never older than the last change this browser made
 *   - the key includes the signed-in token, so a different user never sees someone else's answer
 *   - `{ cache: false }` on a request skips the cache (used by "Re-verify" and refresh buttons)
 * Changes made by other people are picked up when the entry expires.
 */

const SECOND = 1000;

/** [path prefix, lifetime in ms]. The first match wins. */
export const DEFAULT_RULES = [
  ["/finix/ai/ask", 0],
  ["/reports/", 120 * SECOND],
  ["/finix/ai/", 120 * SECOND],
  ["/gst-portal/", 120 * SECOND],
  ["/chart-of-accounts", 120 * SECOND],
  ["/companies", 60 * SECOND],
  ["/invoices/orphan-notes", 60 * SECOND],
];

/** Writes to these paths do not change any cached answer, so they must not empty the cache. */
export const DEFAULT_WRITE_IGNORE = [
  "/activity", "/auth", "/notifications", "/heartbeat", "/telemetry", "/aiweave", "/ai/",
  "/finix/ai/ask", "/presence", "/analytics",
];

const MAX_ENTRIES = 200;

function clone(value) {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (typeof structuredClone === "function") {
    try { return structuredClone(value); } catch { /* fall through */ }
  }
  return JSON.parse(JSON.stringify(value));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${k}:${stable(value[k])}`).join(",")}}`;
  }
  return String(value);
}

function pathOf(config) {
  const url = String(config.url || "");
  const noOrigin = url.replace(/^https?:\/\/[^/]+/i, "");
  const base = String(config.baseURL || "").replace(/^https?:\/\/[^/]+/i, "").replace(/\/+$/, "");
  const rel = base && noOrigin.startsWith(base) ? noOrigin.slice(base.length) : noOrigin;
  const path = rel.split("?")[0];
  return path.startsWith("/") ? path : `/${path}`;
}

export function createReadCache({
  baseAdapter,
  getToken = () => "",
  now = Date.now,
  rules = DEFAULT_RULES,
  writeIgnore = DEFAULT_WRITE_IGNORE,
  maxEntries = MAX_ENTRIES,
  onClear = () => {},
}) {
  const entries = new Map(); // key -> { at, ttl, response }
  const inflight = new Map(); // key -> Promise<response>
  let epoch = 0;

  const ttlFor = (path) => {
    for (const [prefix, ttl] of rules) if (path.startsWith(prefix)) return ttl;
    return 0;
  };

  const tokenTag = () => {
    const t = String(getToken() || "");
    return t ? t.slice(-24) : "anon";
  };

  function copyOf(response, config) {
    return { ...response, config, data: clone(response.data), headers: response.headers };
  }

  function clear() {
    epoch += 1;
    entries.clear();
    inflight.clear();
    try { onClear(); } catch { /* listeners must not break requests */ }
  }

  function store(key, ttl, response) {
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    entries.set(key, { at: now(), ttl, response: { ...response, data: clone(response.data) } });
  }

  function cacheable(config, method) {
    if (method !== "get" || config.cache === false) return null;
    if (config.signal || config.cancelToken || config.onDownloadProgress) return null;
    if (config.responseType && config.responseType !== "json") return null;
    const path = pathOf(config);
    const ttl = ttlFor(path);
    if (!ttl) return null;
    const url = String(config.url || "");
    const key = `${tokenTag()}|${url}|${stable(config.params || {})}`;
    return { key, ttl };
  }

  async function adapter(config) {
    const method = String(config.method || "get").toLowerCase();

    if (method !== "get") {
      const ignored = writeIgnore.some((p) => pathOf(config).startsWith(p));
      if (!ignored) epoch += 1; // answers still in flight were asked before this write
      try {
        return await baseAdapter(config);
      } finally {
        if (!ignored) clear();
      }
    }

    const plan = cacheable(config, method);
    if (!plan) return baseAdapter(config);
    const { key, ttl } = plan;

    const hit = entries.get(key);
    if (hit) {
      if (now() - hit.at < hit.ttl) return copyOf(hit.response, config);
      entries.delete(key);
    }

    if (inflight.has(key)) return inflight.get(key).then((r) => copyOf(r, config));

    const startedIn = epoch;
    const request = Promise.resolve(baseAdapter(config)).then((response) => {
      if (response && response.status === 200 && startedIn === epoch) store(key, ttl, response);
      return response;
    });
    inflight.set(key, request);
    const drop = () => { if (inflight.get(key) === request) inflight.delete(key); };
    request.then(drop, drop);
    return request.then((r) => copyOf(r, config));
  }

  return { adapter, clear, size: () => entries.size, _entries: entries };
}
