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

// ── Central Email Configuration ──────────────────────────────────────────────
export async function getEmailConfig() {
  const res = await api.get("/commercial-console/email/config");
  return res.data;
}

export async function updateEmailConfig(payload) {
  const res = await api.put("/commercial-console/email/config", payload);
  return res.data;
}

export async function testEmailDispatch(recipient_email) {
  const res = await api.post("/commercial-console/email/test", { recipient_email });
  return res.data;
}

export async function getEmailStats() {
  const res = await api.get("/commercial-console/email/stats");
  return res.data;
}

// ── Email Templates ──────────────────────────────────────────────────────────
export async function getEmailTemplates() {
  const res = await api.get("/commercial-console/email/templates");
  return res.data;
}

export async function getEmailTemplate(code) {
  const res = await api.get(`/commercial-console/email/templates/${encodeURIComponent(code)}`);
  return res.data;
}

export async function updateEmailTemplate(code, payload) {
  const res = await api.put(`/commercial-console/email/templates/${encodeURIComponent(code)}`, payload);
  return res.data;
}

export async function previewEmailTemplate(code, context = {}) {
  const res = await api.post(`/commercial-console/email/templates/${encodeURIComponent(code)}/preview`, { context });
  return res.data;
}

export async function testSendEmailTemplate(code, recipient_email) {
  const res = await api.post(`/commercial-console/email/templates/${encodeURIComponent(code)}/test-send`, { recipient_email });
  return res.data;
}

export async function resetEmailTemplate(code) {
  const res = await api.post(`/commercial-console/email/templates/${encodeURIComponent(code)}/reset`);
  return res.data;
}

// ── Delivery Logs & Queue ────────────────────────────────────────────────────
export async function getEmailLogs(params = {}) {
  const res = await api.get("/commercial-console/email/logs", { params });
  return res.data;
}

export async function retryEmailLog(logId) {
  const res = await api.post(`/commercial-console/email/logs/${encodeURIComponent(logId)}/retry`);
  return res.data;
}

// ── Account Recovery & Authentication Settings ───────────────────────────────
export async function getRecoverySettings() {
  const res = await api.get("/commercial-console/recovery-settings");
  return res.data;
}

export async function updateRecoverySettings(payload) {
  const res = await api.put("/commercial-console/recovery-settings", payload);
  return res.data;
}

// ── Licensee Customer Email Settings ─────────────────────────────────────────
export async function getLicenseeEmailSettings(customerId) {
  const res = await api.get(`/commercial-console/licensees/${encodeURIComponent(customerId)}/email-settings`);
  return res.data;
}

export async function updateLicenseeEmailSettings(customerId, payload) {
  const res = await api.put(`/commercial-console/licensees/${encodeURIComponent(customerId)}/email-settings`, payload);
  return res.data;
}

// ── User Email Admin Actions ─────────────────────────────────────────────────
export async function manualVerifyUserEmail(userId) {
  const res = await api.post(`/commercial-console/users/${encodeURIComponent(userId)}/verify-email-manual`);
  return res.data;
}

export async function resendUserVerification(userId) {
  const res = await api.post(`/commercial-console/users/${encodeURIComponent(userId)}/resend-verification`);
  return res.data;
}

export async function triggerUserPasswordReset(userId) {
  const res = await api.post(`/commercial-console/users/${encodeURIComponent(userId)}/trigger-password-reset`);
  return res.data;
}

export async function triggerUserWelcomeEmail(userId) {
  const res = await api.post(`/commercial-console/users/${encodeURIComponent(userId)}/trigger-welcome-email`);
  return res.data;
}

