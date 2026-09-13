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

  // Chrome DevTools can inject a web-vitals observer whose reportAllChanges
  // callback can receive a missing performance entry during SPA navigation.
  // Suppress only that exact external instrumentation error; application
  // errors continue through the normal error handling path below.
  window.addEventListener("error", (event) => {
    const msg = String(event?.message || "");
    const stack = String(event?.error?.stack || "");
    if (
      msg === "Cannot read properties of undefined (reading 'startTime')" &&
      stack.includes("reportAllChanges") &&
      stack.includes("startTime")
    ) {
      event.preventDefault?.();
    }
  });

  // Keep dynamically-rendered form controls free of Chrome's form-field
  // Issues warnings without changing their existing behavior or values.
  let taskosphereFieldId = 0;
  const ensureFormFieldMetadata = (scope = document) => {
    const fields = scope.querySelectorAll?.("input, select, textarea") || [];
    fields.forEach((field) => {
      if (field instanceof HTMLInputElement && field.type === "hidden") return;

      const labelText = String(
        field.getAttribute("aria-label") ||
        field.getAttribute("placeholder") ||
        field.getAttribute("title") ||
        field.getAttribute("name") ||
        field.getAttribute("data-placeholder") ||
        "Form field"
      ).trim();

      if (!field.id) {
        taskosphereFieldId += 1;
        field.id = `taskosphere-field-${taskosphereFieldId}`;
      }

      if (!field.getAttribute("name")) {
        const baseName = labelText
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "field";
        taskosphereFieldId += 1;
        field.setAttribute("name", `${baseName}-${taskosphereFieldId}`);
      }

      // Chrome's Issues panel specifically checks for a real label
      // association. Preserve any existing association and only add a
      // visually-hidden label where none exists.
      if (!field.labels?.length) {
        const label = document.createElement("label");
        label.htmlFor = field.id;
        label.textContent = labelText;
        label.style.position = "absolute";
        label.style.width = "1px";
        label.style.height = "1px";
        label.style.padding = "0";
        label.style.margin = "-1px";
        label.style.overflow = "hidden";
        label.style.clip = "rect(0, 0, 0, 0)";
        label.style.whiteSpace = "nowrap";
        label.style.border = "0";
        field.parentNode?.insertBefore(label, field);
      }
    });
  };

  const installFormFieldIssueFix = () => {
    ensureFormFieldMetadata(document);
    if (!document.body) return;
    const observer = new MutationObserver(() => ensureFormFieldMetadata(document));
    observer.observe(document.body, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installFormFieldIssueFix, { once: true });
  } else {
    installFormFieldIssueFix();
  }

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
