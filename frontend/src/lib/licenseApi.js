import axios from "axios";

export const DEFAULT_PACKAGES = [
  { id: "essential", code: "TSO-ESSENTIAL", name: "Taskosphere Essential", description: "Task Management + Invoicing", modules: ["TASKS", "INVOICING"], max_users: 10, max_installations: 1, validity_days: 365, price: 0, active: true },
  { id: "professional", code: "TSO-PRO", name: "Taskosphere Professional", description: "Task Management + Invoicing + HRMS", modules: ["TASKS", "INVOICING", "HRMS"], max_users: 25, max_installations: 2, validity_days: 365, price: 0, active: true },
  { id: "enterprise", code: "TSO-ENTERPRISE", name: "Taskosphere Enterprise", description: "Task Management + Invoicing + Accounting + HRMS", modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"], max_users: 100, max_installations: 5, validity_days: 365, price: 0, active: true },
];

const hostname = typeof window !== "undefined" ? window.location.hostname : "";
const local = hostname === "localhost" || hostname === "127.0.0.1";
const LICENSE_API_URL = (import.meta.env.VITE_LICENSE_API_URL || (local ? "http://localhost:3100/api" : "/api")).replace(/\/$/, "");
const licensing = axios.create({ baseURL: LICENSE_API_URL, timeout: 30000, headers: { "Content-Type": "application/json" } });

licensing.interceptors.request.use((config) => {
  const token = localStorage.getItem("token") || sessionStorage.getItem("token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export const getLicenseState = async () => (await licensing.get("/licensing/state")).data;
export const createLicense = async (input) => (await licensing.post("/licensing/licenses", input)).data;
export const updateLicenseStatus = async (id, status) => (await licensing.patch(`/licensing/licenses/${id}/status`, { status })).data;
export const upgradeLicense = async (id, packageId) => (await licensing.patch(`/licensing/licenses/${id}/package`, { package_id: packageId })).data;
export const savePackage = async (pkg) => (await licensing.put(`/licensing/packages/${pkg.id}`, pkg)).data;
export const activateLicense = async (licenseKey, installationId, installationName) => (await licensing.post("/licensing/activate", { license_key: licenseKey, installation_id: installationId, installation_name: installationName })).data;
export const validateLicense = async (licenseKey) => (await licensing.post("/licensing/validate", { license_key: licenseKey })).data;
export const heartbeatLicense = async (licenseKey, installationId) => (await licensing.post("/licensing/heartbeat", { license_key: licenseKey, installation_id: installationId })).data;
export const revokeInstallation = async (licenseId, installationId) => (await licensing.post(`/licensing/licenses/${licenseId}/installations/${encodeURIComponent(installationId)}/revoke`)).data;

export const subscribeLicenseState = (callback) => {
  let cancelled = false;
  const refresh = async () => { try { const state = await getLicenseState(); if (!cancelled) callback(state); } catch {} };
  refresh();
  const timer = window.setInterval(refresh, 30000);
  return () => { cancelled = true; window.clearInterval(timer); };
};

export { LICENSE_API_URL };
