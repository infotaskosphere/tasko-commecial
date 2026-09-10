import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./App.css";
import "./enterprise-design.css";
import "./general-settings-commercial.css";
import "./message-automation-commercial.css";
import "./master-data-ui.css";
import "./commercial-final-overrides.css";
// Explicit extensions for Vite
import App from "./App.jsx";
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
