import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./App.css";
import "./enterprise-design.css";
import "./general-settings-commercial.css";
import "./message-automation-commercial.css";
import "./master-data-ui.css";
import "./commercial-final-overrides.css";
import "./roles-page-visibility-fix.css";
// Explicit extensions for Vite
import App from "./App.jsx";

// Gracefully recover if Vite dynamic chunk fails due to a new deployment
if (typeof window !== "undefined") {
  window.addEventListener("vite:preloadError", (event) => {
    event?.preventDefault?.();
    const key = "taskosphere_vite_preload_retry";
    const last = sessionStorage.getItem(key);
    const now = Date.now();
    if (!last || now - Number(last) > 10000) {
      sessionStorage.setItem(key, String(now));
      window.location.reload();
    }
  });

  window.addEventListener("error", (event) => {
    const msg = String(event?.message || "");
    if (
      msg.includes("Failed to load module script") ||
      msg.includes("Expected a JavaScript-or-Wasm module script") ||
      msg.includes("error loading dynamically imported module") ||
      msg.includes("Importing a module script failed")
    ) {
      const key = "taskosphere_chunk_mime_retry";
      const last = sessionStorage.getItem(key);
      const now = Date.now();
      if (!last || now - Number(last) > 10000) {
        sessionStorage.setItem(key, String(now));
        window.location.reload();
      }
    }
  });
}

// Install permission-aware, commercial workflow, and compatibility request guards before the application mounts.
import "./lib/permissionRequestGuard.js";
import "./lib/commercialStaffGuard.js";
import "./lib/profileUpdateCompat.js";

/**
 * Taskosphere - Main Entry Point
 * Mounts the React application to the DOM.
 */

const rootElement = document.getElementById("root");

if (!rootElement) {
  console.error("Critical: Root element 'root' not found. Check your index.html.");
} else {
  const root = ReactDOM.createRoot(rootElement);

  root.render(
    <React.StrictMode>
      {/* AuthProvider is already inside App.jsx. */}
      <App />
    </React.StrictMode>
  );
}
