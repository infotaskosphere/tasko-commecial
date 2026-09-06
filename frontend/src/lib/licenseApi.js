import axios from "axios";
import api, { getToken } from "@/lib/api";

export const DEFAULT_PACKAGES = [
  { id: "essential", code: "TSO-ESSENTIAL", name: "Taskosphere Essential", description: "Task Management + Invoicing", modules: ["TASKS", "INVOICING"], max_users: 10, max_installations: 1, validity_days: 365, price: 0, active: true },
  { id: "professional", code: "TSO-PRO", name: "Taskosphere Professional", description: "Task Management + Invoicing + HRMS", modules: ["TASKS", "INVOICING", "HRMS"], max_users: 25, max_installations: 2, validity_days: 365, price: 0, active: true },
  { id: "enterprise", code: "TSO-ENTERPRISE", name: "Taskosphere Enterprise", description: "Task Management + Invoicing + Accounting + HRMS", modules: ["TASKS", "INVOICING", "ACCOUNTING", "HRMS"], max_users: 100, max_installations: 5, validity_days: 365, price: 0, active: true },
];

const LICENSE_API_BASE = (import.meta.env.VITE_LICENSE_API_URL || "http://localhost:3100/api").replace(/\/+$/, "");

const licensingApi = axios.create({
  baseURL: LICENSE_API_BASE,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

licensingApi.interceptors.request.use((config) => {
  const token = getToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const getLicenseState = async () => {
  const response = await licensingApi.get("/licensing/state");
  return response.data;
};

export const createLicense = async (input) => {
  const response = await licensingApi.post("/licensing/licenses", input);
  return response.data;
};

export const updateLicenseStatus = async (id, status) => {
  const response = await licensingApi.patch(`/licensing/licenses/${id}/status`, { status });
  return response.data;
};

export const upgradeLicense = async (id, packageId) => {
  const response = await licensingApi.patch(`/licensing/licenses/${id}/package`, { package_id: packageId });
  return response.data;
};

export const savePackage = async (pkg) => {
  const response = await licensingApi.put(`/licensing/packages/${pkg.id}`, pkg);
  return response.data;
};

export const activateLicense = async (licenseKey, installationId, installationName) => {
  const response = await api.post("/licensing/installation-activate", {
    license_key: licenseKey,
    installation_id: installationId,
    installation_name: installationName,
  });
  return response.data;
};

export const validateLicense = async (licenseKey) => {
  const response = await licensingApi.post("/licensing/validate", { license_key: licenseKey });
  return response.data;
};

export const getLocalLicenseStatus = async () => {
  const response = await api.get("/licensing/status");
  return response.data;
};

export const heartbeatLicense = async (licenseKey, installationId) => {
  const response = await licensingApi.post("/licensing/heartbeat", { license_key: licenseKey, installation_id: installationId });
  return response.data;
};

export const revokeInstallation = async (licenseId, installationId) => {
  const response = await licensingApi.post(`/licensing/licenses/${licenseId}/installations/${encodeURIComponent(installationId)}/revoke`);
  return response.data;
};

export const subscribeLicenseState = (callback) => {
  let cancelled = false;
  const refresh = async () => {
    try {
      const state = await getLicenseState();
      if (!cancelled) callback(state);
    } catch {
      // The caller keeps its last known state when the licensing API is unavailable.
    }
  };
  refresh();
  const timer = window.setInterval(refresh, 30000);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
};
