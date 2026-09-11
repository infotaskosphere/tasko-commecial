import { lazy } from "react";

/**
 * Drop-in replacement for React.lazy() that recovers automatically when a
 * chunk fails to load because the deployed build has changed since the page
 * was opened (stale index.html referencing a chunk hash that no longer
 * exists on the server).
 *
 * Behaviour:
 *  - On first failure for a given chunk in this browser session, it forces
 *    exactly one full page reload (which fetches the fresh index.html with
 *    correct hashes) and re-navigates to the same URL.
 *  - If it fails again after that reload (a real network/build problem,
 *    not a stale-cache problem), it gives up and rethrows so your existing
 *    error boundary / Suspense fallback can show an error instead of
 *    reload-looping forever.
 */
export function lazyWithRetry(componentImport, chunkName) {
  const name = chunkName || String(componentImport).replace(/[^a-zA-Z0-9_-]/g, '').slice(-32) || 'chunk';
  return lazy(async () => {
    const storageKey = `chunk-retry:${name}`;

    try {
      const module = await componentImport();
      // Successful load — clear any retry flag for this chunk.
      window.sessionStorage.removeItem(storageKey);
      return module;
    } catch (error) {
      const hasRetried = window.sessionStorage.getItem(storageKey);

      if (!hasRetried) {
        // Likely a stale chunk hash from an old deploy — reload once to
        // pick up the latest index.html and asset hashes.
        window.sessionStorage.setItem(storageKey, "1");
        window.location.reload();
        // Return a never-resolving promise; the reload will replace this
        // page before anything else needs to happen.
        return new Promise(() => {});
      }

      // Already retried once and it still failed — surface the real error.
      window.sessionStorage.removeItem(storageKey);
      throw error;
    }
  });
}
