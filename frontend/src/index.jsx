import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./App.css";
// ✅ FIXED: Explicit extensions for Vite
import App from "./App.jsx";
// Install permission-aware request guards before the application mounts.
import "./lib/permissionRequestGuard.js";

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
      {/* NOTE: AuthProvider is already inside App.jsx. 
          Wrapping it here again will cause state conflicts.
      */}
      <App />
    </React.StrictMode>
  );
}
