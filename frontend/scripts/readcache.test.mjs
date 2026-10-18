// Run with: node --test frontend/scripts/readcache.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createReadCache } from "../src/lib/readCache.js";

function setup({ token = "tok-A", delay = 0 } = {}) {
  const calls = [];
  let clock = 1_000;
  let currentToken = token;
  let cleared = 0;
  const baseAdapter = async (config) => {
    calls.push(`${String(config.method || "get").toUpperCase()} ${config.url}`);
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return { status: config.fail ? 500 : 200, statusText: "OK", headers: {}, config, data: { n: calls.length, url: config.url } };
  };
  const cache = createReadCache({ baseAdapter, getToken: () => currentToken, now: () => clock, onClear: () => { cleared += 1; } });
  return { cache, calls, tick: (ms) => { clock += ms; }, setToken: (t) => { currentToken = t; }, cleared: () => cleared };
}
const get = (cache, url, params, extra = {}) => cache.adapter({ method: "get", baseURL: "/api", url, params, ...extra });

test("a repeated report is served from memory", async () => {
  const { cache, calls } = setup();
  const a = await get(cache, "/reports/profit-loss", { company_id: "c1" });
  const b = await get(cache, "/reports/profit-loss", { company_id: "c1" });
  assert.equal(calls.length, 1);
  assert.deepEqual(a.data, b.data);
});

test("params are compared regardless of key order, and different params are separate", async () => {
  const { cache, calls } = setup();
  await get(cache, "/reports/trial-balance", { a: 1, b: 2 });
  await get(cache, "/reports/trial-balance", { b: 2, a: 1 });
  await get(cache, "/reports/trial-balance", { a: 1, b: 3 });
  assert.equal(calls.length, 2);
});

test("callers cannot change what is stored", async () => {
  const { cache } = setup();
  const first = await get(cache, "/reports/profit-loss", {});
  first.data.n = "tampered";
  assert.notEqual((await get(cache, "/reports/profit-loss", {})).data.n, "tampered");
});

test("entries expire", async () => {
  const { cache, calls, tick } = setup();
  await get(cache, "/finix/ai/health-score", { company_id: "c1" });
  tick(119_000);
  await get(cache, "/finix/ai/health-score", { company_id: "c1" });
  assert.equal(calls.length, 1);
  tick(2_000);
  await get(cache, "/finix/ai/health-score", { company_id: "c1" });
  assert.equal(calls.length, 2);
});

test("a write empties the cache, background writes do not", async () => {
  const { cache, calls, cleared } = setup();
  await get(cache, "/reports/profit-loss", {});
  await cache.adapter({ method: "post", baseURL: "/api", url: "/activity/log" });
  await cache.adapter({ method: "post", baseURL: "/api", url: "/aiweave/chat" });
  await get(cache, "/reports/profit-loss", {});
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 1);
  assert.equal(cleared(), 0);
  await cache.adapter({ method: "post", baseURL: "/api", url: "/invoices" });
  await get(cache, "/reports/profit-loss", {});
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 2);
  assert.equal(cleared(), 1);
});

test("a read that was started before a write is not stored afterwards", async () => {
  const { cache, calls } = setup({ delay: 20 });
  const slowRead = get(cache, "/reports/profit-loss", {});
  await cache.adapter({ method: "put", baseURL: "/api", url: "/invoices/1" });
  await slowRead;
  await get(cache, "/reports/profit-loss", {});
  assert.equal(calls.filter((c) => c.startsWith("GET")).length, 2);
});

test("simultaneous identical requests share one call", async () => {
  const { cache, calls } = setup({ delay: 20 });
  const results = await Promise.all(Array.from({ length: 5 }, () => get(cache, "/finix/ai/anomalies", { company_id: "c1" })));
  assert.equal(calls.length, 1);
  assert.equal(new Set(results.map((r) => r.data.n)).size, 1);
});

test("another user never sees the answer cached for this one", async () => {
  const { cache, calls, setToken } = setup();
  await get(cache, "/reports/profit-loss", {});
  setToken("tok-B-different");
  await get(cache, "/reports/profit-loss", {});
  assert.equal(calls.length, 2);
});

test("cache: false, other paths, errors, aborts and downloads are never cached", async () => {
  const { cache, calls } = setup();
  await get(cache, "/reports/profit-loss", {}, { cache: false });
  await get(cache, "/reports/profit-loss", {}, { cache: false });
  await get(cache, "/tasks", {});
  await get(cache, "/tasks", {});
  await get(cache, "/finix/ai/ask", {});
  await get(cache, "/finix/ai/ask", {});
  await get(cache, "/reports/export", {}, { responseType: "blob" });
  await get(cache, "/reports/export", {}, { responseType: "blob" });
  await get(cache, "/reports/x", {}, { signal: {} });
  await get(cache, "/reports/x", {}, { signal: {} });
  assert.equal(calls.length, 10);
  await get(cache, "/reports/bad", {}, { fail: true });
  await get(cache, "/reports/bad", {}, { fail: true });
  assert.equal(calls.length, 12);
});

test("the cache stays bounded and can be cleared", async () => {
  const calls = [];
  const cache = createReadCache({
    baseAdapter: async (c) => { calls.push(c.url); return { status: 200, headers: {}, config: c, data: {} }; },
    maxEntries: 3,
  });
  for (let i = 0; i < 10; i++) await get(cache, `/reports/r${i}`, {});
  assert.equal(cache.size(), 3);
  cache.clear();
  assert.equal(cache.size(), 0);
});
