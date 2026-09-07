import api from "./api";

export async function getPublicWebsiteConfig() {
  const response = await api.get("/website-config/public", { _silent: true, _skipReadyGate: true });
  return response.data;
}

export async function getAdminWebsiteConfig() {
  const response = await api.get("/website-config/admin");
  return response.data;
}

export async function saveWebsiteConfig(config) {
  const response = await api.put("/website-config", config);
  return response.data;
}

export async function resetWebsiteConfig() {
  const response = await api.post("/website-config/reset");
  return response.data;
}
