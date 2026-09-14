// content.js
// Injected by Chrome into the TaskoSphere frontend page.
// Stores login-session tokens directly in extension storage so the page-to-
// extension bridge does not depend on a runtime message channel.

(() => {
  const allowedOrigins = new Set([
    "https://tasko-commercial-frontend.vercel.app",
    "https://final-taskosphere-frontend.onrender.com",
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173"
  ]);

  if (!allowedOrigins.has(window.location.origin)) return;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin !== window.location.origin) return;

    const data = event.data;
    if (!data || typeof data.type !== "string") return;

    try {
      if (data.type === "SET_TOKEN") {
        if (typeof data.token !== "string" || !data.token) return;
        chrome.storage.local.set({ token: data.token });
        return;
      }

      if (data.type === "CLEAR_TOKEN") {
        chrome.storage.local.remove("token");
      }
    } catch (_err) {
      // Extension context/storage failures are intentionally ignored so they
      // cannot surface as uncaught page-console errors.
    }
  });
})();
