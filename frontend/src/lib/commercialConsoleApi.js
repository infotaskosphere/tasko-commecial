import api from "@/lib/api";

export async function getCommercialSystemHealth() {
  const res = await api.get("/commercial-console/system-health");
  return res.data;
}

export async function getCommercialAnalytics() {
  const res = await api.get("/commercial-console/analytics");
  return res.data;
}

export async function getCommercialActivity(limit = 50) {
  const res = await api.get("/commercial-console/activity", { params: { limit } });
  return res.data;
}

export async function getCommercialOmniSettings() {
  const res = await api.get("/commercial-console/omni-settings");
  return res.data;
}

export async function updateCommercialOmniSettings(settings) {
  const res = await api.put("/commercial-console/omni-settings", settings);
  return res.data;
}

export async function getCommercialDomains() {
  const res = await api.get("/commercial-console/domains");
  return res.data;
}

export async function createCommercialDomain(payload) {
  const res = await api.post("/commercial-console/domains", payload);
  return res.data;
}

export async function deleteCommercialDomain(domainId) {
  const res = await api.delete(`/commercial-console/domains/${encodeURIComponent(domainId)}`);
  return res.data;
}

export async function getCommercialPlans() {
  const res = await api.get("/commercial-console/plans");
  return res.data;
}

export async function createCommercialPlan(payload) {
  const res = await api.post("/commercial-console/plans", payload);
  return res.data;
}
